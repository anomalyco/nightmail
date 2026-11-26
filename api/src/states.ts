import { sql, type SQL } from 'drizzle-orm';
import { FREEZE_FLOOR } from './standing-model.js';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { id, withoutVerdictSql, type DbExecutor } from './core.js';
import type { MxReport } from './db/mailbox.js';
import { legacySlugs, productName, productSlug } from './brand.js';

// Every MX entity has one explicit state column, and this module is the only writer of those columns.
// Readers use the predicates below instead of spelling out state names; transitions are pure
// functions applied by the statements at the bottom, so a state can never be half-written.

export const SENDING_STATES = ['pending', 'verified', 'lost', 'failed'] as const;
export const RECEIVING_STATES = ['off', 'pending', 'active', 'lost'] as const;
export const CONNECTION_STATES = ['awaiting_role', 'scanning', 'ready_to_import', 'provisioning', 'ready', 'failed','disconnecting'] as const;
export const TENANT_STATES = ['pending', 'ready', 'failed'] as const;
export const POOL_STATES = ['pending', 'ready'] as const;
export type SendingState = typeof SENDING_STATES[number];
export type ReceivingState = typeof RECEIVING_STATES[number];
export type ConnectionState = typeof CONNECTION_STATES[number];
export type TenantState = typeof TENANT_STATES[number];
export type PoolState = typeof POOL_STATES[number];

// Publish local terminal transitions from UPDATE ... RETURNING, never by scanning mail
// after commit. The event, subscribed deliveries and jobs either all exist or none do.
/**
 * Content-screen verdicts for reputation, counted when the screen judged the mail, in the epoch current then (so a
 * verdict on mail queued before a resume still counts after it). Only Hosted mail with a real recipient; `verdicts`
 * yields (workspace_id, rejected 0|1) per judged email. Runs inside the caller's statement.
 */
export const countScreened = (verdicts: SQL) => sql`INSERT INTO hosted_screen_hourly AS s(workspace_id,epoch,hour,screened,rejected)
  SELECT v.workspace_id,coalesce(pc.resumed_at,'-infinity'),date_trunc('hour',clock_timestamp(),'UTC'),count(*),sum(v.rejected) FROM (${verdicts}) v
  JOIN provider_connections pc ON pc.workspace_id=v.workspace_id AND pc.kind='shared' GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT(workspace_id,epoch,hour) DO UPDATE SET screened=s.screened+excluded.screened,rejected=s.rejected+excluded.rejected`;
export const terminalColumns = sql`id,workspace_id,status,region,simulated,error_code,suppression_reason,dispatch_version`;
/** The stored event keeps all of its data: for a content-screen refusal that includes the verdict (data.screen: score,
 *  model, threshold), Nightmail's own record. The published event is built from the stored one without it, and each
 *  webhook payload from the published event, so neither ever holds it. */
export function terminalEvents(rows: SQL, extra = sql`'{}'::jsonb`) {
  return sql`terminal AS (${rows}), emitted AS (
    INSERT INTO sending_email_events(id,workspace_id,email_id,type,external_id,simulated,data)
    SELECT public.row_id('event'),workspace_id,id,CASE WHEN status='rejected' THEN 'reject' ELSE status END,
      CASE status WHEN 'acceptance_unknown' THEN 'interrupted:'||id||':'||dispatch_version WHEN 'rejected' THEN 'preflight-failed:'||id ELSE status||':'||id END,simulated,
      jsonb_strip_nulls(jsonb_build_object('status',status,'code',error_code,'suppressionReason',suppression_reason)) || ${extra}
    FROM terminal ON CONFLICT DO NOTHING RETURNING *
  ), published AS (
    INSERT INTO operation_events(id,workspace_id,type,region,created_at,data)
    SELECT v.id,v.workspace_id,'email.rejected',t.region,v.created_at,${withoutVerdictSql(sql`v.data`)}||jsonb_build_object('emailId',t.id,'simulated',t.simulated)
    FROM emitted v JOIN terminal t ON t.id=v.email_id ON CONFLICT DO NOTHING RETURNING *
  ), deliveries AS (
    INSERT INTO operation_deliveries(id,workspace_id,webhook_id,event_id,payload)
    SELECT public.row_id('whd'),p.workspace_id,w.id,p.id,
      jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'type',p.type,'region',p.region,'createdAt',p.created_at,'data',p.data)
    FROM published p JOIN operation_webhooks w ON w.workspace_id=p.workspace_id AND NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR w.regions ? p.region)
    ON CONFLICT DO NOTHING RETURNING id,workspace_id
  ), webhook_jobs AS (
    INSERT INTO jobs(id,workspace_id,type,payload) SELECT public.row_id('job'),workspace_id,'operation.webhook',jsonb_build_object('deliveryId',id,'generation',0) FROM deliveries RETURNING 1
  )`;
}

/**
 * A scheduled single send whose release job ended without releasing it (its last attempt failed, or its last lease ran
 * out): rejected with SCHEDULE_RELEASE_FAILED, a reject event and email.rejected, in the statement that ends the job, so
 * it never waits forever unseen. `rows` yields (workspace_id, id) of emails the statement has locked; one that was
 * released, canceled or moved meanwhile keeps its state. Nothing is charged: a scheduled email never was.
 */
export const failScheduledRelease = (rows: SQL) => sql`release_failed AS (UPDATE sending_emails e SET status='rejected',error_code='SCHEDULE_RELEASE_FAILED',updated_at=clock_timestamp()
    FROM (${rows}) r WHERE e.workspace_id=r.workspace_id AND e.id=r.id AND e.status='scheduled'
    RETURNING e.id,e.workspace_id,e.status,e.region,e.simulated,e.error_code,e.suppression_reason,e.dispatch_version
  ), ${terminalEvents(sql`SELECT * FROM release_failed`, sql`'{"providerCalled":false}'::jsonb`)}`;

/** `lost` is a grace period: proof went missing, the claim keeps working, and a later check either restores it or expires it. */
export const LOST_GRACE_MS = 2 * 3_600_000;

/** Facts from the last SES read and DNS observation. Never a state: every boolean the API shows is derived from the state columns. */
export type IdentityFacts = {
  dmarc?: import('./dmarc.js').DmarcObservation|null;
  ses: Pick<GetEmailIdentityCommandOutput, 'VerificationStatus' | 'VerifiedForSendingStatus' | 'DkimAttributes' | 'MailFromAttributes'>;
  proven: boolean; mx: MxReport | null; note: string | null;
  /** The last receiving DNS check's conflict (CNAME, foreign or split MX, wildcard, Nightmail's own records, another claim), or null. */
  issue?: import('./receiving-host.js').ReceivingIssue | null;
  /** A receiving host the owner chose explicitly (POST /v1/domains/{id}/receiving-host), instead of the automatic suggestion. */
  receivingChoice?: string | null;
  /** Verified by the exclusive BYO account, not an identity managed by the claim's ownership tag. */
  imported?: true;
  /** Immutable operator-attested SES fingerprint. Only the operator can restore a revoked adoption. */
  adopted?: {arn:string;fingerprint:string};
  /** The workspace's built-in domain (builtin-domain.ts): sent under its parent's identity, proven by it, never DNS-checked itself. */
  builtin?: true;
  /** Hosted: when receiving was enabled (enableInboundDomain) and the check it queued hasn't observed the domain yet.
   * Every check that observes the domain writes its facts afresh, without it. */
  receivingRequested?: string;
};
/** Hosted receiving set up on request: `provisioning` while the domain's queued check waits or runs, `failed` (with that
 * job's error) once it gave up, null otherwise. `dc` is the claim, as in the predicates below. */
export type ReceivingSetup = { status: 'provisioning' } | { status: 'failed'; error: string | null };
export const receivingSetup = (dc: SQL = sql`dc`) => sql`(SELECT CASE WHEN j.status IN ('pending','running') THEN jsonb_build_object('status','provisioning')
  WHEN j.status='failed' THEN jsonb_build_object('status','failed','error',j.last_error) END
  FROM jobs j WHERE ${dc}.identity->>'receivingRequested' IS NOT NULL AND j.id='domain.verify:'||${dc}.token::text)`;
export const setupError = (setup: Extract<ReceivingSetup, { status: 'failed' }>) => `Receiving setup failed${setup.error ? ` (${setup.error})` : ''}. Enable receiving again to retry.`;
/** Labels of the ownership TXT record (`_<label>.<domain>`), current first. A claim shows the one it was made with
 * (domain_claims.proof_label: claims from before the rename keep `_bane`), and any of them proves any claim. */
export const PROOF_LABELS = [productSlug, ...legacySlugs] as const; // legacySlugs: remove after rename cleanup (pre-rename claims then republish as _nightmail)
export type ProofLabel = typeof PROOF_LABELS[number];
export const proofRecordName = (label: ProofLabel, domain: string) => `_${label}.${domain}`;
export const isProofRecord = (name: string, domain: string) => PROOF_LABELS.some(label => name === proofRecordName(label, domain));
export type ClaimState = { sending_state: SendingState; receiving_state: ReceivingState; receiving_host: string | null; lost_since: string | null; receiving_lost_since: string | null };
export type ClaimEvidence = {
  /** DKIM signed, ownership proven and SES verified for sending; undefined when SES was not read (MX-only upkeep). */
  sending: boolean | undefined;
  /** SES directly revoked an imported domain's sending/DKIM capability (no ownership grace on that evidence). */
  sendingRevoked?: boolean;
  /** The SES identity exists but is not this claim's: terminal until the domain is added again. */
  unavailable?: boolean;
  /** The SES identity itself is gone: no grace, nothing to hold on to. */
  definitive?: boolean;
  /** SES VerificationStatus SUCCESS (receiving needs the identity, not DKIM). */
  identityVerified: boolean;
  /** The ownership TXT proof (or, for BYO, the identity verification) was observed. */
  proven: boolean;
  /** The region can receive at all: the pool's catch-all is ready, or the connection is BYO. */
  regionReceives: boolean;
  byo: boolean;
};
/**
 * One receiving host of a domain, on its own mailbox_domains row: waiting for its MX (`waiting_for_mx`), waiting for a
 * BYO receipt rule (`provisioning`), routing (`active`; within its two-hour grace once `lost_since` is set) or removed by
 * the owner (`disabled`, kept with its addresses so adding it again restores it).
 */
export type HostStatus = 'waiting_for_mx' | 'provisioning' | 'active' | 'disabled';
export type HostState = { status: HostStatus; lost_since: string | null };
/** What one check saw at a host: `live` when Nightmail's MX answers there (alone, or beside another provider's) and
 * nothing refuses the host; undefined when its MX was not checked this time. */
export type HostEvidence = HostState & { host: string; live: boolean | undefined };

// Predicates. `dc`/`pc`/`p` are the aliases used by the surrounding statement.
export const claimSends = (dc: SQL = sql`dc`) => sql`${dc}.sending_state IN ('verified','lost')`;
export const claimReceives = (dc: SQL = sql`dc`) => sql`${dc}.receiving_state IN ('active','lost')`;
export const claimReceivable = (dc: SQL = sql`dc`) => sql`${dc}.receiving_state<>'off'`;
export const connectionReady = (pc: SQL = sql`pc`) => sql`${pc}.state='ready'`;
/** Hosted sends (and anything that queues one) stop here until the SES tenant exists; BYO connections are always ready. */
export const poolSends = (p: SQL = sql`p`) => sql`${p}.sending_state='ready'`;
export const poolReceives = (p: SQL = sql`p`) => sql`${p}.receiving_state='ready'`;

/**
 * Pure transition for one domain claim and its receiving hosts. The caller holds the claim row lock and supplies what it
 * observed. The claim decides whether the domain may receive at all (SES identity, ownership proof and its grace, the
 * region); each host then routes on its own MX, with its own two-hour grace when that MX goes missing. Hosts are given
 * domain row first, and the claim's receiving_host is the first that routes (else the first waiting for a BYO rule):
 * kept for readers that know one host, it decides nothing.
 */
export function transitionClaim(current: ClaimState, e: ClaimEvidence, hosts: HostEvidence[] = [], now = Date.now()): { claim: ClaimState; hosts: HostState[] } {
  const expired = (since: string | null) => since !== null && now - new Date(since).getTime() >= LOST_GRACE_MS;
  const wasHeld = current.sending_state === 'verified' || current.sending_state === 'lost';
  let sending: SendingState;
  if (e.unavailable) sending = 'failed';
  else if (e.sending) sending = 'verified';
  else if (e.sending === undefined) sending = current.sending_state === 'lost' && expired(current.lost_since) ? 'pending' : current.sending_state;
  else if (e.definitive || e.sendingRevoked || !wasHeld) sending = 'pending';
  else if (current.sending_state === 'verified') sending = 'lost';
  else sending = expired(current.lost_since) ? 'pending' : 'lost';
  // Ownership counts while it is observed or while sending still holds it through its grace.
  const owned = e.proven || sending === 'lost';
  const routing = current.receiving_state === 'active' || current.receiving_state === 'lost';
  const receivingHeld = routing && !expired(current.receiving_lost_since);
  // A receive-only claim (identity verified, DKIM pending) gets the same grace when its TXT proof goes missing; a claim
  // whose sending grace just expired has already had it. During that grace every host keeps the state it had.
  const mode = sending === 'failed' || e.definitive || !e.identityVerified || !e.regionReceives ? 'off'
    : owned ? 'observe' : receivingHeld && !(current.sending_state === 'lost' && sending === 'pending') ? 'grace' : 'off';
  const stamp = new Date(now).toISOString();
  const next = hosts.map((h): HostState => {
    if (h.status === 'disabled') return { status: 'disabled', lost_since: null };
    if (mode === 'off') return { status: 'waiting_for_mx', lost_since: null };
    // An ownership grace keeps what routes and authorizes nothing new: a host waiting for its BYO rule waits for its MX
    // again. So a host is `provisioning` only while the claim's last check observed ownership (activateReceiving).
    if (mode === 'grace') return h.status === 'provisioning' ? { status: 'waiting_for_mx', lost_since: null } : { status: h.status, lost_since: h.lost_since };
    if (h.live === undefined) return { status: h.status, lost_since: h.lost_since };
    // BYO activates only after its receipt rule lists the host; the shared catch-all already covers it.
    if (h.live) return { status: h.status === 'active' || !e.byo ? 'active' : 'provisioning', lost_since: null };
    if (h.status === 'active' && !expired(h.lost_since)) return { status: 'active', lost_since: h.lost_since ?? stamp };
    return { status: 'waiting_for_mx', lost_since: null };
  });
  const since = (next: boolean, was: boolean, before: string | null) => next ? (was ? before : stamp) : null;
  let receiving: Pick<ClaimState, 'receiving_state' | 'receiving_host' | 'receiving_lost_since'> = fromHosts(hosts.map((h, i) => ({ host: h.host, ...next[i]! })));
  if (mode === 'off') receiving = { receiving_state: 'off', receiving_host: null, receiving_lost_since: null };
  else if (mode === 'grace') receiving = receiving.receiving_state === 'active' || receiving.receiving_state === 'lost'
    ? { ...receiving, receiving_state: 'lost', receiving_lost_since: since(true, current.receiving_state === 'lost', current.receiving_lost_since) } : { receiving_state: 'off', receiving_host: null, receiving_lost_since: null };
  return { claim: { sending_state: sending, ...receiving, lost_since: since(sending === 'lost', current.sending_state === 'lost', current.lost_since) }, hosts: next };
}
type Projected = { host: string; status: string; lost_since?: string | null };
/**
 * The claim's one receiving host: the first host routing outside its MX grace, else the first within it, else the first
 * waiting for a BYO rule. The claim mirrors it exactly as a claim with one host always read (`lost` while its MX grace
 * runs, since when), so a Worker that knows one host per domain reads and writes the same thing, and that host's grace is
 * the claim's receiving_lost_since, which every Worker keeps.
 */
export const projectedHost = <T extends Projected>(hosts: T[]) => hosts.find(h => h.status === 'active' && !h.lost_since) ?? hosts.find(h => h.status === 'active') ?? hosts.find(h => h.status === 'provisioning');
/** The claim's receiving fields as its hosts make them (each with its effective MX grace), while the claim may receive: its primary host, mirrored. */
const fromHosts = (hosts: Projected[]): Pick<ClaimState, 'receiving_state' | 'receiving_host' | 'receiving_lost_since'> => {
  const primary = projectedHost(hosts);
  return primary?.status === 'active' ? { receiving_state: primary.lost_since ? 'lost' : 'active', receiving_host: primary.host, receiving_lost_since: primary.lost_since ?? null }
    : { receiving_state: 'pending', receiving_host: primary?.host ?? null, receiving_lost_since: null };
};
/** A host's MX grace started here, or null. The domain's primary host (the claim's receiving_host) keeps it on the claim; every other host on its row. */
export const hostGraceStart = (claim: Pick<ClaimState, 'receiving_state' | 'receiving_host' | 'receiving_lost_since'>, host: { host: string; lost_since: string | null }) =>
  host.host === claim.receiving_host ? (claim.receiving_state === 'lost' ? claim.receiving_lost_since : null) : host.lost_since;
type ClaimReceiving = Pick<ClaimState, 'receiving_state' | 'receiving_host' | 'receiving_lost_since'>;
/** The claim's receiving fields from a domain's host rows (own row first), each host's MX grace where it is kept. */
const hostsProjection = (claim: ClaimReceiving, hosts: Projected[]) =>
  fromHosts(hosts.map(h => ({ ...h, lost_since: h.status === 'active' ? hostGraceStart(claim, { host: h.host, lost_since: h.lost_since ?? null }) : null })));
/**
 * The claim's receiving fields after hosts were added or removed outside a check. Eligibility doesn't change: a claim
 * that may not receive stays off, and an ownership grace (`lost` while a host routes outside any MX grace) holds until
 * the next check, which decides it.
 */
export function claimProjection(claim: ClaimReceiving, hosts: Projected[]): ClaimReceiving {
  if (claim.receiving_state === 'off') return { receiving_state: 'off', receiving_host: null, receiving_lost_since: null };
  const next = hostsProjection(claim, hosts);
  return claim.receiving_state === 'lost' && next.receiving_state === 'active' ? { ...next, receiving_state: 'lost', receiving_lost_since: claim.receiving_lost_since } : next;
}

type ClaimRef = { name: string; token: string; connectionId: string; workspaceId: string; domainId: string; region: string };
/** A host's next state and the facts it was derived from. The domain's own row comes first (id null: created on the first check). */
export type HostWrite = HostState & { id: string | null; host: string; mx?: MxReport | null; issue?: import('./receiving-host.js').ReceivingIssue | null };
/**
 * Applies a transition and the facts it was derived from in one statement, fenced on the token and connection
 * so a stale verifier never overwrites a reclaimed or disconnected row. `hosts` are the domain's receiving hosts, its
 * own row first: that row's host is where the MX should be published until the domain receives somewhere (the record
 * shown to the user), and addresses can be created on any host before it routes. Null leaves receiving alone.
 */
export async function applyClaim(db: DbExecutor, claim: ClaimRef, next: ClaimState, facts: IdentityFacts, hosts: HostWrite[] | null) {
  if (!hosts) {
    await db.execute(sql`UPDATE domain_claims SET sending_state=${next.sending_state},lost_since=${next.lost_since}::timestamptz,identity=${JSON.stringify(facts)}::jsonb
      WHERE workspace_id=${claim.workspaceId} AND name=${claim.name} AND token=${claim.token} AND connection_id=${claim.connectionId}`);
    return;
  }
  const [own, ...others] = hosts as [HostWrite, ...HostWrite[]];
  const json = (value: unknown) => value == null ? null : JSON.stringify(value);
  const routes = (s: HostStatus) => s === 'active' || s === 'provisioning';
  // A new domain row, including the operator-adopted platform domain's, takes the column default catch_all='store'
  // (migration 120): mail for unknown recipients stays unrouted, so only inboxes created on purpose (abuse@,
  // postmaster@ …) receive. Later changes are kept. A domain added again finds its old row by name and takes it back.
  await db.execute(sql`WITH claim AS (UPDATE domain_claims SET sending_state=${next.sending_state},receiving_state=${next.receiving_state},receiving_host=${next.receiving_host},
      lost_since=${next.lost_since}::timestamptz,receiving_lost_since=${next.receiving_lost_since}::timestamptz,identity=${JSON.stringify(facts)}::jsonb
      WHERE name=${claim.name} AND token=${claim.token} AND connection_id=${claim.connectionId} RETURNING workspace_id,claim_scope),
    own AS (UPDATE mailbox_domains m SET receiving_host=${own.host},status=${own.status},lost_since=${own.lost_since}::timestamptz,issue=${json(own.issue)}::jsonb,last_error=NULL,
        enabled_at=CASE WHEN NOT ${routes(own.status)} THEN NULL WHEN m.status IN ('active','provisioning') THEN coalesce(m.enabled_at,now()) ELSE now() END,
        mx=coalesce(${json(own.mx)}::jsonb,m.mx),checked_at=coalesce(${own.mx?.checkedAt ?? null}::timestamptz,m.checked_at),updated_at=now()
      FROM claim WHERE claim.claim_scope<>'account' AND m.workspace_id=claim.workspace_id AND m.domain_id=${claim.domainId} AND m.parent_id IS NULL RETURNING m.id),
    created AS (INSERT INTO mailbox_domains AS m(id,workspace_id,domain_id,name,region,receiving_host,status,enabled_at,mx,checked_at,lost_since,issue)
      SELECT ${id('mdom')},workspace_id,${claim.domainId},${claim.name},${claim.region},${own.host},${own.status},CASE WHEN ${routes(own.status)} THEN now() END,${json(own.mx)}::jsonb,${own.mx?.checkedAt ?? null}::timestamptz,${own.lost_since}::timestamptz,${json(own.issue)}::jsonb
        FROM claim WHERE claim_scope<>'account' AND NOT EXISTS (SELECT FROM own)
      ON CONFLICT ON CONSTRAINT mailbox_domains_name DO UPDATE SET domain_id=excluded.domain_id,parent_id=NULL,region=excluded.region,receiving_host=excluded.receiving_host,status=excluded.status,last_error=NULL,
        enabled_at=excluded.enabled_at,mx=coalesce(excluded.mx,m.mx),checked_at=coalesce(excluded.checked_at,m.checked_at),lost_since=excluded.lost_since,issue=excluded.issue,updated_at=now() RETURNING m.id)
    UPDATE mailbox_domains m SET status=h.status,lost_since=h.lost_since,issue=h.issue,last_error=NULL,mx=coalesce(h.mx,m.mx),checked_at=coalesce((h.mx->>'checkedAt')::timestamptz,m.checked_at),
      enabled_at=CASE WHEN h.status NOT IN ('active','provisioning') THEN NULL WHEN m.status IN ('active','provisioning') THEN coalesce(m.enabled_at,now()) ELSE now() END,updated_at=now()
    FROM claim,jsonb_to_recordset(${JSON.stringify(others.map(h => ({ id: h.id, status: h.status, lost_since: h.lost_since, mx: h.mx ?? null, issue: h.issue ?? null })))}::jsonb) h(id text,status text,lost_since timestamptz,mx jsonb,issue jsonb)
    WHERE claim.claim_scope<>'account' AND m.workspace_id=claim.workspace_id AND m.id=h.id AND m.domain_id=${claim.domainId} AND m.parent_id IS NOT NULL`);
}
/** Records SES facts without touching state: the creating request and MAIL FROM changes. */
export const identityOnly = (ses: IdentityFacts['ses']): IdentityFacts => ({ ses, proven: false, mx: null, note: null });
/** The importer only passes domains just verified by GetEmailIdentity. Leave receiving off: importing sending
 * identities is not permission to provision receipt rules for the account's existing domains. */
export const verifyImportedClaims = (connection: string, domains: {name: string; ses: IdentityFacts['ses']}[]) => sql`UPDATE domain_claims dc SET sending_state=CASE WHEN d.ses->'DkimAttributes' @> '{"SigningEnabled":true,"Status":"SUCCESS"}' THEN 'verified' ELSE 'pending' END,
  identity=jsonb_build_object('ses',d.ses,'proven',true,'imported',true,'mx',NULL,'note',NULL)
  FROM jsonb_to_recordset(${JSON.stringify(domains)}::jsonb) d(name text,ses jsonb) WHERE dc.connection_id=${connection} AND dc.name=d.name`;
/**
 * BYO only: the receipt rule now lists these hosts, so hosts waiting on it start routing, each on its own. A host waits
 * in `provisioning` only while its claim's last check observed ownership (transitionClaim), so it activates whatever MX
 * grace the domain's other hosts are in; a claim that lost its proof or identity has no such host, and one that may not
 * receive (`off`) is never touched. Each claim is then what its hosts make it, as the next check would write it.
 */
export async function activateReceiving(db: Pick<import('./core.js').Database, 'transaction'>, workspaceId: string, connectionId: string, region: string, hosts: string[]) {
  // Claims first, then their hosts: the order every receiving write takes.
  await db.transaction(async tx => { await tx.execute(sql`SELECT FROM domain_claims dc WHERE dc.workspace_id=${workspaceId} AND dc.connection_id=${connectionId} AND dc.receiving_state<>'off' ORDER BY dc.name FOR UPDATE`);
    const activated = (await tx.execute<{ name: string }>(sql`UPDATE mailbox_domains m SET status='active',last_error=NULL,enabled_at=now(),updated_at=now()
      FROM operation_domains d JOIN domain_claims dc ON dc.workspace_id=d.workspace_id AND dc.name=d.name
      WHERE m.workspace_id=${workspaceId} AND m.region=${region} AND m.status='provisioning' AND m.receiving_host IN (SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb))
        AND d.id=m.domain_id AND d.workspace_id=m.workspace_id AND d.region=${region} AND dc.connection_id=${connectionId} AND dc.receiving_state<>'off'
      RETURNING dc.name`)).rows;
    if (!activated.length) return;
    const claims = (await tx.execute<ClaimReceiving & { name: string; hosts: Projected[] }>(sql`SELECT dc.name,dc.receiving_state,dc.receiving_host,dc.receiving_lost_since,${domainHosts()} AS hosts
      FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name
      WHERE dc.workspace_id=${workspaceId} AND dc.connection_id=${connectionId} AND dc.name IN (SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(activated.map(a => a.name))])}::jsonb))`)).rows;
    await tx.execute(sql`UPDATE domain_claims dc SET receiving_state=c.receiving_state,receiving_host=c.receiving_host,receiving_lost_since=c.receiving_lost_since
      FROM jsonb_to_recordset(${JSON.stringify(claims.map(c => ({ name: c.name, ...hostsProjection(c, c.hosts) })))}::jsonb) c(name text,receiving_state text,receiving_host text,receiving_lost_since timestamptz)
      WHERE dc.workspace_id=${workspaceId} AND dc.connection_id=${connectionId} AND dc.name=c.name`); });
}
/** A domain's receiving hosts as JSON, its own row first, then in the order they were added: the order every projection reads. */
export const domainHosts = (d: SQL = sql`d`) => sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'host',coalesce(m.receiving_host,m.name),'own',m.parent_id IS NULL,'status',m.status,
    'lost_since',m.lost_since,'mx',m.mx,'issue',m.issue,'catch_all',m.catch_all) ORDER BY m.parent_id IS NOT NULL,m.created_at,m.id),'[]'::jsonb)
  FROM mailbox_domains m WHERE m.workspace_id=${d}.workspace_id AND m.domain_id=${d}.id)`;
/** Disconnecting keeps the claim (other workspaces still cannot take the name) but every state returns to its start. */
export const detachedClaim = sql`connection_id=NULL,sending_state='pending',receiving_state='off',receiving_host=NULL,lost_since=NULL,receiving_lost_since=NULL,identity=NULL`;
/** MX: a failed BYO reconcile is recorded on the projection without inventing a receiving state (the claim stays pending and the job retries). */
export const noteReconcileFailure = (workspaceId: string, region: string, message: string) => sql`UPDATE mailbox_domains SET last_error=${message},updated_at=now() WHERE workspace_id=${workspaceId} AND region=${region} AND status='provisioning'`;

// Provider connections: `state` is the connection state; the tenant has its own.
// provisioning -> provisioning is a retry taking over an expired lease; startProvisioning enforces the lease.
export const connectionTransitions: Record<ConnectionState, ConnectionState[]> = { awaiting_role: ['provisioning','scanning','disconnecting'], scanning:['ready_to_import','ready','failed','disconnecting'],ready_to_import:['scanning','ready','disconnecting'], provisioning: ['provisioning', 'ready', 'failed', 'awaiting_role','disconnecting'], failed: ['provisioning','scanning','disconnecting'], ready: ['disconnecting'],disconnecting:[] };
// Managed regions only. Legacy singleton rows remain a projection; a scan never changes
// sending readiness. Replacing an expired lease or disabling a binding invalidates its generation.
type RegionRef = { connectionId:string; region:string };
const managedRegion = (ref:RegionRef) => sql`connection_id=${ref.connectionId} AND region=${ref.region} AND NOT legacy`;
export const startRegionScan = (ref:RegionRef) => sql`UPDATE provider_connection_regions SET scan_state='scanning',scan_revision=scan_revision+1
  WHERE ${managedRegion(ref)} RETURNING scan_revision`;
export const finishRegionScan = (ref:RegionRef, revision:number, completed:boolean) => sql`UPDATE provider_connection_regions SET scan_state=${completed?'ready_to_import':'failed'}
  WHERE ${managedRegion(ref)} AND scan_revision=${revision} AND scan_state='scanning' RETURNING region`;
export const acquireRegionProvisioning = (ref:RegionRef,guard:SQL=sql`true`,accepted:SQL=sql`false`) => sql`UPDATE provider_connection_regions SET sending_state='provisioning',generation=generation+1,lease_until=clock_timestamp()+interval '4 minutes',
  confirmed_generation=CASE WHEN confirmed_generation=generation AND confirmed_topic_arn=feedback_topic_arn THEN generation+1 END
  WHERE ${managedRegion(ref)} AND ${guard} AND (scan_state='ready_to_import' OR ${accepted} OR EXISTS (SELECT FROM provider_connections c WHERE c.id=connection_id AND c.kind='shared'))
    AND (sending_state IN ('unprovisioned','failed') OR (sending_state='provisioning' AND lease_until<=clock_timestamp())) RETURNING generation`;
export const finishRegionProvisioning = (ref:RegionRef,generation:number,confirmedTopic:string|null) => sql`WITH finished AS (
  UPDATE provider_connection_regions SET sending_state=${confirmedTopic?'ready':'failed'},lease_until=NULL
  WHERE ${managedRegion(ref)} AND sending_state='provisioning' AND generation=${generation} AND lease_until>clock_timestamp()
    AND (${confirmedTopic}::text IS NULL OR (feedback_topic_arn=${confirmedTopic} AND confirmed_generation=generation AND confirmed_topic_arn=feedback_topic_arn)) RETURNING connection_id,region,sending_state),
  parent AS (UPDATE provider_connections c SET state='ready' FROM finished r WHERE c.id=r.connection_id AND c.state<>'ready' AND r.sending_state='ready'),
  settings AS (UPDATE ses_installation_settings s SET enabled_regions=s.enabled_regions||jsonb_build_array(r.region) FROM finished r JOIN provider_connections c ON c.id=r.connection_id
    WHERE s.workspace_id=c.workspace_id AND r.sending_state='ready' AND NOT s.enabled_regions ? r.region) SELECT * FROM finished`;
export const toggleRegionSending = (ref:RegionRef,enable:boolean,generation:number) => sql`UPDATE provider_connection_regions SET sending_state=${enable?'ready':'disabled'},generation=generation+1
  WHERE ${managedRegion(ref)} AND sending_state=${enable?'disabled':'ready'} AND generation=${generation} RETURNING generation`;
// After the provisioner has verified the tenant and its resource associations. The pool,
// not each tenant, owns the shared topic. Never copy a pool ARN into a BYO registration.
export const finishHostedRegion = (ref:RegionRef,generation:number) => sql`WITH finished AS (UPDATE provider_connection_regions r SET sending_state='ready',tenant_state='ready',lease_until=NULL
  FROM provider_connections c JOIN provider_pool_regions p ON p.aws_account_id=c.aws_account_id WHERE c.kind='shared' AND c.state='ready' AND p.sending_state='ready'
    AND p.feedback_topic_arn LIKE 'arn:aws:sns:'||p.region||':'||p.aws_account_id||':%' AND p.region=r.region AND c.id=r.connection_id
    AND r.connection_id=${ref.connectionId} AND r.region=${ref.region} AND NOT r.legacy AND r.sending_state='provisioning' AND r.generation=${generation} AND r.lease_until>clock_timestamp() RETURNING c.workspace_id,r.region),
  settings AS (UPDATE ses_installation_settings s SET enabled_regions=s.enabled_regions||jsonb_build_array(f.region) FROM finished f
    WHERE s.workspace_id=f.workspace_id AND NOT s.enabled_regions ? f.region) SELECT region FROM finished`;
const receiveNext = {off:'review',review:'provisioning',provisioning:'active',active:'disabling',disabling:'off'} as const;
export const transitionRegionReceiving = (ref:RegionRef,from:keyof typeof receiveNext,generation:number) => sql`UPDATE provider_connection_regions SET receiving_state=${receiveNext[from]},receiving_generation=receiving_generation+1
  WHERE ${managedRegion(ref)} AND receiving_state=${from} AND receiving_generation=${generation} AND EXISTS(SELECT FROM provider_connections c WHERE c.id=connection_id AND c.kind='byo') RETURNING receiving_generation`;
export function assertConnectionTransition(from: ConnectionState, to: ConnectionState) {
  if (!connectionTransitions[from].includes(to)) throw new Error(`Invalid connection transition ${from} -> ${to}`);
}
/** BYO: start provisioning with a fenced lease; the fence lets a crashed attempt be retried after the lease. */
export const startProvisioning = (id: string, account: string, roleArn: string, lease: string) => sql`UPDATE provider_connections SET state='provisioning',lease_until=${lease},aws_account_id=${account},role_arn=${roleArn}
  WHERE id=${id} AND ((state IN ('awaiting_role','failed')) OR (state='provisioning' AND coalesce(lease_until,'-infinity')<=now())) AND (aws_account_id IS NULL OR aws_account_id=${account})`;
export const finishProvisioning = (fence: SQL, to: 'ready' | 'failed' | 'awaiting_role') => sql`UPDATE provider_connections SET state=${to},lease_until=NULL WHERE state='provisioning' AND ${fence}`;
export const notProvisioning = (pc: SQL = sql`pc`) => sql`NOT (${pc}.state='provisioning' AND coalesce(${pc}.lease_until,'-infinity')>now())`;
/** Queues the one tenant job (retry-safe by id). Hosted is instant: the request that creates a connection may make its
 * tenant itself (startHostedMail), and then the job, due `afterSeconds` later, is the fallback. */
export const queueTenantJob = (source: SQL, afterSeconds = 0) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) SELECT 'tenant.provision:'||id,'tenant.provision',workspace_id,jsonb_build_object('connectionId',id),now()+make_interval(secs=>${afterSeconds}) FROM (${source}) c
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=excluded.available_at,lease_until=NULL,last_error=NULL WHERE jobs.status<>'running'`;
export const setTenantState = (id: string, to: TenantState, account?: string) => sql`UPDATE provider_connections SET tenant_state=${to}${account && to==='ready' ? sql`,aws_account_id=${account}` : sql``} WHERE id=${id} AND tenant_state<>'ready'
  ${account ? sql`AND (aws_account_id IS NULL OR aws_account_id=${account})` : sql``}`;
export const setPoolState = (fence: SQL, column: 'sending_state' | 'receiving_state', extra: SQL = sql``) => sql`UPDATE provider_pool_regions SET ${sql.identifier(column)}='ready'${extra} WHERE ${fence}`;

// Two reputation holds, neither a provisioning failure (claims and inbound routing keep working). `unhealthy` supplies
// the shared connection id, its evidence epoch, counts, a reason and a scope from the hourly snapshot:
// - scope 'all' pauses every stream (complaints, the spam screen). It bumps the tenant generation and queues the SES
//   tenant job, which disables the workspace's tenants as a backstop.
// - scope 'marketing' (bounces only) holds marketing: admission refuses it with 409 MARKETING_HELD and campaigns pause,
//   while transactional mail keeps flowing. The SES tenants are left enabled.
export const pauseHostedSending = (unhealthy: SQL) => sql`WITH h AS MATERIALIZED (${unhealthy}), paused AS (
    UPDATE provider_connections pc SET paused_at=clock_timestamp(),pause_reason=h.reason,resume_pending_at=NULL,tenant_generation=pc.tenant_generation+1
    FROM h WHERE pc.id=h.id AND pc.kind='shared' AND pc.paused_at IS NULL AND pc.resumed_at IS NOT DISTINCT FROM h.resumed_at AND h.reason IS NOT NULL AND h.scope='all'
    RETURNING pc.workspace_id,pc.pause_reason,'all'::text AS scope,h.sends,h.bounces,h.complaints,h.rejected,h.screened
  ), held AS (
    UPDATE provider_connections pc SET marketing_held_at=clock_timestamp(),marketing_hold_reason=h.reason
    FROM h WHERE pc.id=h.id AND pc.kind='shared' AND pc.paused_at IS NULL AND pc.marketing_held_at IS NULL AND pc.resumed_at IS NOT DISTINCT FROM h.resumed_at AND h.reason IS NOT NULL AND h.scope='marketing'
    RETURNING pc.workspace_id,pc.marketing_hold_reason AS pause_reason,'marketing'::text AS scope,h.sends,h.bounces,h.complaints,h.rejected,h.screened
  ), queued AS (${queueTenantStatus(sql`SELECT workspace_id FROM paused`)})
  SELECT * FROM paused UNION ALL SELECT * FROM held`;
/** Queues the job that sets the workspace's SES tenants to match its pause (retry-safe by id; the job reads the current state). */
export const queueTenantStatus = (workspaces: SQL) => sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'hosted.tenantStatus:'||workspace_id,'hosted.tenantStatus',workspace_id,'{}'::jsonb FROM (${workspaces}) w
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status<>'running'`;
/** What Nightmail wants the SES tenants to be: disabled while paused (and not resuming), enabled otherwise. */
export const desiredTenantStatus = (pc: SQL = sql`pc`) => sql`CASE WHEN ${pc}.paused_at IS NOT NULL AND ${pc}.resume_pending_at IS NULL THEN 'DISABLED' ELSE 'ENABLED' END`;
/**
 * Workspaces whose tenants differ from what Nightmail wants: a pause not yet applied to every ready regional tenant at the
 * current generation, a disabled tenant on a workspace that is not paused, or an unfinished resume. The periodic
 * reconcile queues these, so any interleaving of transitions and job runs converges.
 */
export const tenantStatusDrift = () => sql`SELECT pc.workspace_id FROM provider_connections pc WHERE pc.kind='shared' AND (pc.resume_pending_at IS NOT NULL
  OR (pc.paused_at IS NOT NULL AND EXISTS (SELECT FROM provider_connection_regions r WHERE r.connection_id=pc.id AND r.tenant_state='ready'
    AND NOT EXISTS (SELECT FROM hosted_tenant_status t WHERE t.connection_id=pc.id AND t.region=r.region AND t.applied='DISABLED' AND t.generation=pc.tenant_generation)))
  OR (pc.paused_at IS NULL AND EXISTS (SELECT FROM hosted_tenant_status t WHERE t.connection_id=pc.id AND t.applied<>'ENABLED')))`;
/**
 * An operator's pause after a review, in one statement with its audit row: the only way to pause an exempt (first-party)
 * workspace. Re-arms a resume that is waiting for its tenants; bumps the generation so the SES tenants are disabled.
 */
export const pauseHostedByOperator = (wid: string, reason: string, via: 'script' | 'console' = 'script') => sql`WITH paused AS (
    UPDATE provider_connections pc SET paused_at=clock_timestamp(),pause_reason=${`Hosted sending paused by ${productName} after a review.`}::text,resume_pending_at=NULL,tenant_generation=pc.tenant_generation+1
    WHERE pc.workspace_id=${wid} AND pc.kind='shared' AND (pc.paused_at IS NULL OR pc.resume_pending_at IS NOT NULL) RETURNING pc.workspace_id
  ), audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details) SELECT workspace_id,'pause-hosted-sending',jsonb_build_object('reason',${reason}::text,'via',${via}::text) FROM paused),
  queued AS (${queueTenantStatus(sql`SELECT workspace_id FROM paused`)})
  SELECT workspace_id FROM paused`;
export type HostedCaps = { firstWeek: number };
export type HostedResume = { reason: string; percent?: 50 | 100; via?: 'script' | 'console'; operator?: string | null; caps: HostedCaps };
/**
 * The connection side of a resume, as CTEs ending in `resumed` (workspace_id, pending, ...). It lifts a pause or a
 * marketing hold and starts a new evidence epoch for the pause check; the limit's history is kept whole. With
 * percent < 100 the limit is min(current limit, percent of the limit before the resume) for 48 hours, an absolute cap
 * that a second resume cannot raise. A pause whose SES tenants were disabled stays held (pause_reason says it is
 * resuming) until the tenant job has enabled them again; otherwise sending restarts at once. Used by the operator
 * script below and by the standing's applyChange (src/standing.ts), which writes its own audit.
 */
const resumeConnection = (wid: string, percent: number, caps: HostedCaps) => sql`previous AS MATERIALIZED (
    SELECT pc.id,pc.paused_at,pc.pause_reason,pc.marketing_held_at,pc.marketing_hold_reason,CASE WHEN pc.restore_until>now() THEN pc.restore_cap END AS active_cap,
      -- A workspace without a daily limit gets its frozen one here at the latest (hosted_freeze), so the 50% has a base.
      coalesce(hosted_base_cap(${wid},${caps.firstWeek},NULL,NULL),hosted_freeze(${wid},${FREEZE_FLOOR})) AS base,
      pc.paused_at IS NOT NULL AND (EXISTS (SELECT FROM hosted_tenant_status t WHERE t.connection_id=pc.id AND t.applied<>'ENABLED')
        OR EXISTS (SELECT FROM jobs j WHERE j.id='hosted.tenantStatus:'||pc.workspace_id AND j.status='running')) AS enable_first
    FROM provider_connections pc WHERE pc.workspace_id=${wid} AND pc.kind='shared' AND (pc.paused_at IS NOT NULL OR pc.marketing_held_at IS NOT NULL) FOR UPDATE
  ), resumed AS (UPDATE provider_connections pc SET
      paused_at=CASE WHEN p.enable_first THEN pc.paused_at END,
      pause_reason=CASE WHEN p.enable_first THEN 'Hosted sending is resuming after a review: it restarts once the SES tenants are enabled again.' END,
      resume_pending_at=CASE WHEN p.enable_first THEN clock_timestamp() END,
      marketing_held_at=NULL,marketing_hold_reason=NULL,resumed_at=clock_timestamp(),
      tenant_generation=pc.tenant_generation+CASE WHEN p.paused_at IS NOT NULL THEN 1 ELSE 0 END,
      restore_cap=${percent < 100 ? sql`CASE WHEN p.base IS NOT NULL THEN least(p.active_cap,greatest(1,p.base*${percent}/100)) END` : sql`NULL`},
      restore_until=${percent < 100 ? sql`CASE WHEN p.base IS NOT NULL THEN clock_timestamp()+interval '48 hours' END` : sql`NULL`}
    FROM previous p WHERE pc.id=p.id RETURNING pc.workspace_id,p.pause_reason,p.marketing_hold_reason,p.paused_at IS NOT NULL AS was_paused,p.base,pc.restore_cap,pc.restore_until,
      pc.resume_pending_at,pc.resume_pending_at IS NOT NULL AS pending),
  queued AS (${queueTenantStatus(sql`SELECT workspace_id FROM resumed WHERE was_paused`)})`;
/** resumeConnection alone, for a caller that audits the resume itself (the standing's applyChange). */
export const resumeHostedConnection = (wid: string, percent: 50 | 100, caps: HostedCaps) => sql`WITH ${resumeConnection(wid, percent, caps)}
  SELECT workspace_id,pending,base,restore_cap FROM resumed`;
/** An operator script resume, in one statement with its audit row (see resumeConnection). */
export const resumeHostedSending = (wid: string, { reason, percent = 50, via = 'script', operator = null, caps }: HostedResume) => sql`WITH ${resumeConnection(wid, percent, caps)},
  audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details,via,reason,operator_id) SELECT workspace_id,'resume-hosted-sending',
    jsonb_build_object('reason',${reason}::text,'via',${via}::text,'operator',${operator}::text,'pauseReason',pause_reason,'marketingHoldReason',marketing_hold_reason,
      'restorePercent',${percent}::int,'limitBefore',base,'restoreCap',restore_cap,'restoreUntil',restore_until,'waitsForTenants',pending),${via}::text,${reason}::text,${operator}::text FROM resumed)
  SELECT workspace_id,pending FROM resumed`;

// Campaigns: one state for the draft, its frozen snapshot (sending_campaign_reviews, no status of its own) and its
// delivery. `total`, `prepared` and `expanded` are cursors into the frozen recipient list, `canceled` counts
// recipients released from the reservation; none of them is a second status. A launch snapshots the audience and
// moves draft/failed -> preparing; the one `campaign.run` job validates recipients (preparing), waits for the
// schedule (scheduled), releases rows into the dispatch queue (sending) and the dispatcher marks the campaign done
// inline when its last row leaves queued/attempting. paused is entered by the user or the health check and leaves
// to wherever the cursors say (runningState). failed keeps its error: with nothing released yet it can be edited (-> draft)
// or launched again from a fresh snapshot; once recipients were released it can only resume from `expanded` on the same
// snapshot (never a second snapshot, which would send to the released recipients again) or be canceled.
export const CAMPAIGN_STATES = ['draft', 'preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled'] as const;
export type CampaignState = typeof CAMPAIGN_STATES[number];
export type RunningState = 'preparing' | 'scheduled' | 'sending';
export const campaignTransitions: Record<CampaignState, CampaignState[]> = {
  draft: ['preparing'], failed: ['preparing', 'draft', 'scheduled', 'sending', 'canceled'],
  preparing: ['scheduled', 'sending', 'paused', 'failed', 'canceled', 'draft'], scheduled: ['sending', 'paused', 'failed', 'canceled', 'draft'],
  sending: ['paused', 'done', 'failed', 'canceled'], paused: ['preparing', 'scheduled', 'sending', 'canceled', 'draft'], done: [], canceled: [],
};
export function assertCampaignTransition(from: CampaignState, to: CampaignState) {
  if (!campaignTransitions[from].includes(to)) throw new Error(`Invalid campaign transition ${from} -> ${to}`);
}
/** States with an outstanding recipient reservation (and a run job that may still act). */
export const CAMPAIGN_ACTIVE = ['preparing', 'scheduled', 'sending', 'paused'] as const satisfies readonly CampaignState[];
/** States the run job acts in; paused and the terminal states make it a no-op. */
export const CAMPAIGN_RUNNING = ['preparing', 'scheduled', 'sending'] as const satisfies readonly RunningState[];
/** Editable, deletable and launchable from scratch: a draft, or a failed launch that released nothing. */
export const campaignEditable = (row: { state: CampaignState; expanded: number }) => row.state === 'draft' || (row.state === 'failed' && row.expanded === 0);
/** A failed launch that already released recipients can only continue from its cursor or be canceled. */
export const campaignResumable = (row: { state: CampaignState; expanded: number }) => row.state === 'paused' || (row.state === 'failed' && row.expanded > 0);
export const campaignActive = (c: SQL = sql`c`) => sql`${c}.state IN ('preparing','scheduled','sending','paused')`;
/** Holds a recipient reservation: active, or failed after releasing some recipients (resumable, so still counted). */
export const campaignReserved = (c: SQL = sql`c`) => sql`(${campaignActive(c)} OR (${c}.state='failed' AND ${c}.expanded>0 AND (${c}.error->>'code') IS DISTINCT FROM 'JOB_LEASE_EXHAUSTED'))`;
const editableRow = sql`(state='draft' OR (state='failed' AND expanded=0))`;
/** Where a launched campaign continues from its cursors: preparing until every recipient is validated, then its schedule, then sending. */
export function runningState(row: { prepared: number; total: number; scheduledAt: string | null }, now = Date.now()): RunningState {
  if (row.total <= 0 || row.prepared < row.total) return 'preparing';
  return row.scheduledAt && Date.parse(row.scheduledAt) > now ? 'scheduled' : 'sending';
}
type CampaignRef = { workspaceId: string; id: string };
const campaignRow = (ref: CampaignRef) => sql`workspace_id=${ref.workspaceId} AND id=${ref.id}`;
const states = (list: readonly CampaignState[]) => sql.join(list.map(state => sql`${state}`), sql`,`);
/** One fenced statement: the row moves to `to` only from one of `from`, with `set` as the only other change. Returns the row's id when it moved. */
export function moveCampaign(ref: CampaignRef | SQL, from: readonly CampaignState[], to: CampaignState, set: SQL = sql``, guard: SQL = sql`true`) {
  for (const state of from) assertCampaignTransition(state, to);
  return sql`UPDATE sending_campaigns SET state=${to},updated_at=now()${set} WHERE ${'workspaceId' in ref ? campaignRow(ref) : ref} AND state IN (${states(from)}) AND ${guard} RETURNING id`;
}
/** Cursor or setting changes that keep the state; fenced on it so a paused or canceled campaign is never advanced. */
export const progressCampaign = (ref: CampaignRef, state: CampaignState, set: SQL) => sql`UPDATE sending_campaigns SET updated_at=now()${set} WHERE ${campaignRow(ref)} AND state=${state} RETURNING id`;
export type CampaignLaunch = { reviewId: string; resolvedRegion?:string; actorKeyId: string; simulated: boolean; total: number; requestId: string | null; scheduledAt: string | null; pacePerDay: number | null; autoPause: boolean; rateShare: number | null;
  pacePlan?: number[] | null; firstBatch?: { size: number; waitMinutes: number } | null; rampRequiredCap?: number | null; consent?: { source: string; confirmedBy: string | null; confirmedAt: string } | null };
/** draft, or failed with nothing released -> preparing with a fresh snapshot: every cursor and setting starts over; the error of a failed launch is cleared. */
export const launchCampaign = (ref: CampaignRef, l: CampaignLaunch) => moveCampaign(ref, ['draft', 'failed'], 'preparing', sql`,review_id=${l.reviewId}${l.resolvedRegion ? sql`,draft=jsonb_set(draft,'{region}',to_jsonb(${l.resolvedRegion}::text))` : sql``},actor_key_id=${l.actorKeyId},simulated=${l.simulated},total=${l.total},prepared=0,expanded=0,canceled=0,error=NULL,request_id=${l.requestId},
  scheduled_at=${l.scheduledAt}::timestamptz,pace_per_day=${l.pacePerDay},auto_pause=${l.autoPause},rate_share=${l.rateShare},window_started_at=NULL,window_expanded=0,paused_at=NULL,pause_reason=NULL,health_checked_at=NULL,waiting_reason=NULL,waiting_until=NULL,probe_wait_until=NULL,probe_cleared_at=NULL,probe_skipped_at=NULL,quarantines=0,ramp_step=NULL,ramp_window_started_at=NULL,ramp_from=0,
  pace_plan=${l.pacePlan?.length ? sql`${sql.param(l.pacePlan)}::int[]` : sql`NULL`},window_index=0,pace_first_batch=${l.pacePlan?.length && l.firstBatch ? l.firstBatch.size : null}::int,pace_first_wait_minutes=${l.pacePlan?.length && l.firstBatch ? l.firstBatch.waitMinutes : null}::int,ramp_required_cap=${l.rampRequiredCap ?? null}::int,consent=${l.consent ? JSON.stringify(l.consent) : null}::jsonb`, editableRow);
/** A new revision: draft, or failed with nothing released -> draft with no snapshot; a failed launch's counters and error go with it. */
export const reviseCampaign = (ref: CampaignRef, set: SQL) => sql`UPDATE sending_campaigns SET state='draft',updated_at=now(),review_id=NULL,error=NULL,total=0,prepared=0,expanded=0,canceled=0,scheduled_at=NULL${set} WHERE ${campaignRow(ref)} AND ${editableRow} RETURNING *`;
type PauseReason = { code: string; message: string };
const pausedFields = (reason: PauseReason) => sql`,paused_at=now(),pause_reason=${JSON.stringify(reason)}::jsonb,health_checked_at=now()`;
export const pauseCampaign = (ref: CampaignRef, reason: PauseReason) => moveCampaign(ref, CAMPAIGN_RUNNING, 'paused', sql`${pausedFields(reason)},waiting_reason=NULL,waiting_until=NULL`);
/** A list-quality pause (a probe or the campaign's own bounce/complaint lines): counted, so a second one needs an operator. */
export const quarantineCampaign = (ref: CampaignRef, reason: PauseReason) => moveCampaign(ref, CAMPAIGN_RUNNING, 'paused', sql`${pausedFields(reason)},waiting_reason=NULL,waiting_until=NULL,quarantines=quarantines+1`);
/** The list probe went out clean (or an owner or operator released its quarantine): release the rest. */
export const clearProbe = (ref: CampaignRef) => sql`UPDATE sending_campaigns SET probe_cleared_at=now(),probe_wait_until=NULL,updated_at=now() WHERE ${campaignRow(ref)} RETURNING id`;
/** A sender in good standing skips the probe for recipients an earlier campaign delivered to (src/sending.ts listMailedCleanly). */
export const skipProbe = (ref: CampaignRef) => sql`UPDATE sending_campaigns SET probe_skipped_at=now(),updated_at=now() WHERE ${campaignRow(ref)} AND probe_cleared_at IS NULL AND probe_skipped_at IS NULL RETURNING id`;
export const waitProbe = (ref: CampaignRef, until: string) => sql`UPDATE sending_campaigns SET probe_wait_until=${until}::timestamptz,waiting_reason='list_probe',waiting_until=${until}::timestamptz,updated_at=now() WHERE ${campaignRow(ref)} AND state='sending' AND probe_wait_until IS NULL RETURNING id`;
/** paused, or failed after releasing some recipients, continues from its cursors on the same snapshot; the failure is cleared. */
export const resumeCampaign = (ref: CampaignRef, to: RunningState) => moveCampaign(ref, ['paused', 'failed'], to, sql`,paused_at=NULL,pause_reason=NULL,error=NULL,health_checked_at=now()`, sql`(state='paused' OR expanded>0)`);
/** A schedule that released nothing yet (preparing, scheduled, or paused before its send time) -> draft: the frozen
 *  snapshot is dropped (maintenance prunes it), the reservation ends and every cursor starts over at the next launch. */
const unreleasedSchedule = sql`expanded=0 AND scheduled_at IS NOT NULL`;
export const unscheduleCampaign = (ref: CampaignRef) => moveCampaign(ref, ['preparing', 'scheduled', 'paused'], 'draft', sql`,review_id=NULL,error=NULL,total=0,prepared=0,expanded=0,canceled=0,scheduled_at=NULL,paused_at=NULL,pause_reason=NULL,health_checked_at=NULL,waiting_reason=NULL,waiting_until=NULL,window_started_at=NULL,window_expanded=0`, unreleasedSchedule);
/** Moves the send time of the same unreleased schedule; the frozen audience and content stay. The run job rereads it. */
export const rescheduleCampaign = (ref: CampaignRef, scheduledAt: string) => sql`UPDATE sending_campaigns SET updated_at=now(),scheduled_at=${scheduledAt}::timestamptz WHERE ${campaignRow(ref)} AND state IN ('preparing','scheduled','paused') AND ${unreleasedSchedule} RETURNING id`;
export const cancelCampaign = (ref: CampaignRef, error: { code: string; message: string } | null) => moveCampaign(ref, [...CAMPAIGN_ACTIVE, 'failed'], 'canceled', sql`,canceled=canceled+(total-expanded),paused_at=NULL,pause_reason=NULL,waiting_reason=NULL,waiting_until=NULL${error ? sql`,error=${JSON.stringify(error)}::jsonb` : sql``}`);
export const failCampaign = (ref: CampaignRef | SQL, error: { code: string; message: string }) => moveCampaign(ref, CAMPAIGN_RUNNING, 'failed', sql`,error=${JSON.stringify(error)}::jsonb,scheduled_at=NULL,waiting_reason=NULL,waiting_until=NULL`);
/** Preparation advanced to `prepared`; when the whole list is validated the campaign moves to its schedule or straight to sending. */
export const recordPrepared = (ref: CampaignRef, prepared: number, next: RunningState) => next === 'preparing' ? progressCampaign(ref, 'preparing', sql`,prepared=${prepared}`) : moveCampaign(ref, ['preparing'], next, sql`,prepared=${prepared}`);
/** scheduled -> sending only for the schedule and snapshot the run found due: a reschedule (or a new launch) that landed
 *  after the run read the row leaves it scheduled, and the run reads it again. */
export const startSending = (ref: CampaignRef, due: { scheduledAt: string | null; reviewId: string | null }) =>
  moveCampaign(ref, ['scheduled'], 'sending', sql``, sql`scheduled_at IS NOT DISTINCT FROM ${due.scheduledAt}::timestamptz AND review_id IS NOT DISTINCT FROM ${due.reviewId}`);
/** `skipped`: recipients passed over by a delivered-only release; they count as canceled. */
export function recordExpanded(ref: CampaignRef, expanded: number, windowStartedAt: string | null, windowExpanded: number, hostedUntil: string | null, skipped = 0, reason: 'hosted_daily_quota' | 'balance' = 'hosted_daily_quota', windowIndex?: number) {
  return progressCampaign(ref, 'sending', sql`,expanded=${expanded},canceled=canceled+${skipped},window_started_at=${windowStartedAt}::timestamptz,window_expanded=${windowExpanded},${windowIndex === undefined ? sql`` : sql`window_index=${windowIndex},`}waiting_reason=${hostedUntil ? reason : null},waiting_until=${hostedUntil}::timestamptz`);
}
/** An owner resumed a failed list probe: release the rest only to contacts delivered before, and check health at once. */
export const restrictToDelivered = (ref: CampaignRef) => sql`UPDATE sending_campaigns SET delivered_only=true,health_checked_at=NULL,updated_at=now() WHERE ${campaignRow(ref)} RETURNING id`;
export const holdCampaign = (ref: CampaignRef, reason: 'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota' | 'list_probe' | 'balance' | 'feedback_lag' | 'ramp' | 'link_record' | 'link_budget' | 'link_listing', until: string) => progressCampaign(ref, 'sending', sql`,waiting_reason=${reason},waiting_until=${until}::timestamptz`);
/** The campaign's place on the ramp (src/standing-model.ts RAMP): its step, and when that step's hour started at review ordinal `from` (null: past the last step). */
export const setRamp = (ref: CampaignRef, step: number, startedAt: string | null, from: number) => progressCampaign(ref, 'sending', sql`,ramp_step=${step},ramp_window_started_at=${startedAt}::timestamptz,ramp_from=${from}`);
/** A ramp step's batch paused the campaign: the next release, after a resume, starts a new hour on the same step. */
export const restartRampWindow = (ref: CampaignRef) => sql`UPDATE sending_campaigns SET ramp_window_started_at=NULL,ramp_from=expanded,updated_at=now() WHERE ${campaignRow(ref)} AND state='paused' AND ramp_step IS NOT NULL RETURNING id`;
export const noteHealthChecked = (ref: CampaignRef) => progressCampaign(ref, 'sending', sql`,health_checked_at=now()`);
/** `keepPlan`: a launch plan's daily batches stay (only autoPause or rateShare changed); a daily cap replaces them. */
export const setCampaignPacing = (ref: CampaignRef, pacing: { pacePerDay: number | null; autoPause: boolean; rateShare: number | null; keepPlan?: boolean }) => sql`UPDATE sending_campaigns SET updated_at=now(),${pacing.keepPlan ? sql`` : sql`pace_plan=NULL,pace_first_batch=NULL,pace_first_wait_minutes=NULL,`}pace_per_day=${pacing.pacePerDay},auto_pause=${pacing.autoPause},rate_share=${pacing.rateShare},waiting_reason=NULL,waiting_until=NULL WHERE ${campaignRow(ref)} AND ${campaignActive(sql`sending_campaigns`)} RETURNING id`;
/**
 * sending -> done once every recipient is released and no row is queued or attempting. The dispatcher runs it once
 * per draining batch over the campaigns it moved rows for (locking only campaign rows, after the row statements, so it
 * never serializes concurrent shards nor deadlocks with cancel or the run job); the campaign run runs it when it finds
 * every recipient released, since a release that queued nothing leaves no row whose leaving would finish the campaign;
 * the interrupted-attempt sweep appends it over every sending campaign so a missed edge can never leave one sending with
 * nothing queued. `refs` yields
 * (workspace_id, campaign_id); `leaving` the ids the same statement is finishing, which its own subqueries cannot see yet.
 */
export const finishCampaigns = (refs: SQL, leaving: SQL = sql`SELECT NULL::text AS id WHERE false`) => sql`UPDATE sending_campaigns c SET state='done',updated_at=clock_timestamp()
  FROM (${refs}) x WHERE c.workspace_id=x.workspace_id AND c.id=x.campaign_id AND c.state='sending' AND c.expanded=c.total
    AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.campaign_id=c.id AND e.status IN ('queued','attempting') AND NOT EXISTS (SELECT 1 FROM (${leaving}) l WHERE l.id=e.id))`;
// A late definitive refusal can disprove an interrupted attempt after recovery settled its
// campaign. Reopen only an actually requeued member's done campaign, in that same statement.
export const reopenQueuedCampaigns = (refs: SQL) => sql`UPDATE sending_campaigns c SET state='sending',updated_at=clock_timestamp()
  FROM (${refs}) x WHERE c.workspace_id=x.workspace_id AND c.id=x.campaign_id AND c.state='done'`;
/**
 * The campaign's one job: keyed by campaign so launch, resume and pacing changes requeue the same row instead of adding
 * one per step. Every (re)queue carries a fresh `run` token in the payload and the job runner fences its completion on it,
 * so a worker still holding the retired run of a pause -> resume cannot complete or requeue the new run's row.
 */
export const campaignRunJobId = (campaignId: string) => `campaign.run:${campaignId}`;
export const queueCampaignRun = (ref: CampaignRef, payload: Record<string, unknown>, availableAt: string | null = null) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES (${campaignRunJobId(ref.id)},'campaign.run',${ref.workspaceId},${JSON.stringify({ campaignId: ref.id, ...payload, run: id('run') })}::jsonb,coalesce(${availableAt}::timestamptz,now()))
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL`;
/** Pause and cancel retire a waiting run; a run in flight sees the new state at its next fenced statement and stops by itself. */
export const retireCampaignRun = (ref: CampaignRef, reason: string) => sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=${reason} WHERE id=${campaignRunJobId(ref.id)} AND status='pending'`;
export const wakeCampaignRun = (ref: CampaignRef) => sql`UPDATE jobs SET available_at=now() WHERE id=${campaignRunJobId(ref.id)} AND status='pending'`;
