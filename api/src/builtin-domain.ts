import { labelSkeleton } from './label-skeleton.js';
import { sql } from 'drizzle-orm';
import type { GetEmailIdentityCommandOutput, SESv2Client } from '@aws-sdk/client-sesv2';
import { ApiError, assertSharedAccount, getSes, id, isSimulatedSes, log, logError, ModuleLoadError, type Config, type Ctx, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { JobDeferred } from './jobs.js';
import { SEND_LIMITS } from './send-limits.js';
import { ADD_OWN_DOMAIN, BUILTIN_APEX_LOCALS, builtinApex, BUILTIN_UNSUPPORTED, BUILTIN_UNSUPPORTED_WORDS, builtinLimitsText, type BuiltinUnsupported } from './builtin-limits.js';
import { productName } from './brand.js';
import { claimTenantName } from './ses-setup.js';
import { tagKey, hasTags } from './resource-tags.js';
import { builtinSettingUp, platformHosts, releasedClaimCleanup } from './domain-claims.js';
import type { IdentityFacts } from './states.js';
import type { ReadyConnection } from './provider-credentials.js';

/**
 * Built-in domains. Every Hosted workspace gets a subdomain of NIGHTMAIL_BUILTIN_DOMAIN (nightmail.email in production),
 * <label>.<parent> such as acme-k7.nightmail.email, that sends and receives before it verifies a domain of its own.
 *
 * - Name: its workspace name as DNS letters (builtinBase) plus 2 to 4 random characters, allocated when the workspace is
 *   created (workspaces.ts) or by the backfill sweep (builtinDomainTick), unique and never reissued (migration 495).
 * - Domain: an ordinary claim of the workspace, marked identity.builtin, bound to its own shared connection in us-east-2
 *   (create_builtin_claim). It needs no DNS of its own: it sends with the workspace's own SES tenant under the parent
 *   identity (DKIM d=<parent>), which the domain.builtin job associates with that tenant, and it receives on its own name
 *   through the pool's catch-all receipt rule (the parent's wildcard MX). Its proof is the parent identity's, checked by the
 *   sweep; the per-domain DNS jobs skip it. It can't be deleted and doesn't count toward the domain limits.
 * - Receiving: every address at it goes to one default inbox (hello@) through a catch-all route, until the workspace gives
 *   an address its own inbox or route. Spam and viruses to it are dropped before they are counted (mailbox-receipts.ts).
 * - Sending (send_admission, migration 495): transactional mail sent now, without attachments or campaigns, to the
 *   recipients NIGHTMAIL_BUILTIN_SEND_SCOPE allows (anyone, or the members' own verified addresses) within the scope's caps
 *   (SEND_LIMITS.builtin), screened with a new sender's rules, and only until the workspace verifies a domain of its own.
 * - Revoked by an operator (scripts/builtin-domain.ts): it stops sending and receiving at once and its label stays taken.
 * - The parent's circuit breaker (builtinBreaker): when all built-in domains' mail together bounces or draws complaints
 *   past SES's warning lines, every built-in domain stops sending until an operator resets it (reset-breaker).
 */
export type BuiltinScope = keyof typeof SEND_LIMITS.builtin;
/** The parent identity's region: built-in domains send and receive in Ohio only. */
export const BUILTIN_REGION = 'us-east-2';
/** The default inbox every address at the built-in domain goes to, and the address its first email comes from. */
export const BUILTIN_INBOX_LOCAL = 'hello';
/** While the parent isn't ready (a new parent's MAIL FROM or DKIM still verifying), each domain.builtin job looks again every
 * 5 minutes, 12 times, then hourly. The count is in the job's payload and starts over each time the job is queued again. */
export const BUILTIN_PARENT_RETRY = { everyMs: 300_000, times: 12, thenMs: 3600_000 } as const;

// Labels nobody is given: mail, DNS and service names, words that would pass for Nightmail itself or for an account
// notice, and the platform's own labels (domain-claims.ts platformLabel).
const RESERVED = new Set(`www www1 www2 mail mails email emails smtp imap pop pop3 mx mta bounce bounces feedback return dmarc dkim spf autodiscover autoconfig
  admin administrator root hostmaster postmaster webmaster abuse security noc support help helpdesk billing invoice invoices payment payments
  test tests testing dev staging stage prod production e2e demo api app apps dashboard console status docs doc ns ns1 ns2 ns3 ns4
  in inbound out outbound reply replies inbox incoming domainconnect tracker track click links link go cdn static assets img images files
  nightmail bane opensend anomaly opencode system noreply no-reply donotreply do-not-reply notifications notification alerts alert info team
  official verify verification account accounts login signin sign-in password passwords secure auth oauth sso mfa wallet`.split(/\s+/).filter(Boolean));
// Brands and words a look-alike subdomain would mostly serve to impersonate: a workspace name with one of them as a word
// gets the neutral base instead.
const PROTECTED = new Set(`paypal apple icloud google gmail microsoft outlook office365 hotmail live amazon aws facebook meta instagram whatsapp
  netflix linkedin twitter tiktok yahoo chase wellsfargo bankofamerica citi citibank hsbc barclays santander coinbase binance kraken metamask
  stripe venmo cashapp zelle irs hmrc usps ups fedex dhl docusign dropbox adobe github gitlab slack zoom bank banking`.split(/\s+/).filter(Boolean));
// Words that would pass a label off as the platform itself or as one of its notices, wherever they appear in the name:
// "Nightmail Support" or "Security Team" must not become nightmail-support-k7.<parent> or security-k7.<parent>.
const IMPERSONATING = new Set(`nightmail bane opensend anomaly opencode security secure verify verification login signin password postmaster
  noreply donotreply admin administrator abuse hostmaster webmaster`.split(/\s+/).filter(Boolean));
// Short or common words that also occur inside ordinary ones (groups, first, olive, purchase, laws, badminton, designing):
// these count only as a whole word, or one spelled across words or digits ("U P S", "Up5", "Ch4se"). Every other word
// counts anywhere in the squashed name ("PaypalBilling", "MyGoogleDesk", "NightmailSupport").
const WHOLE_WORDS = new Set(`ups irs aws live meta citi bank banking bane chase apple zelle slack zoom stripe secure signin login admin`.split(/\s+/));
const protectedParts = [...PROTECTED, ...IMPERSONATING].filter(word => !WHOLE_WORDS.has(word)).map(labelSkeleton);
const compact = (name: string) => labelSkeleton(name.replace(/[^\p{L}\p{N}]/gu, ''));
/** A name's words: split at anything but letters and digits, at case changes ("MyGmailDesk", "UPSDelivery") and between letters and digits. */
const tokens = (name: string) => name.normalize('NFKC').match(/\p{Lu}+(?!\p{Ll})|\p{Lu}\p{Ll}*|\p{Ll}+|\p{N}+|[\p{Lo}\p{Lt}\p{Lm}]+/gu) ?? [];
/** Whether some run of adjacent words, folded like a label, is one of the whole words. */
const wholeWord = (words: string[]) => words.some((_, i) => {
  for (let j = i, run = ''; j < words.length && run.length < 8; j++) if (WHOLE_WORDS.has(labelSkeleton(run += words[j]))) return true;
  return false;
});
const FILLER = /^(?:workspace|workspaces|team|org|inc|llc|ltd|co)$/;
/** The base a workspace name falls back to. */
export const BUILTIN_FALLBACK = 'mail';
export const reservedBuiltinLabel = (label: string) => RESERVED.has(label);

/** The first part of a workspace's label: its name in ASCII DNS letters, words joined by hyphens, at most 20 characters
 * cut at a word, without filler words after the first ("Ryan's workspace" becomes ryans). A name that leaves nothing
 * usable, is reserved, or names a protected brand gets the fallback. */
export function builtinBase(name: string) {
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((word, i) => i === 0 || !FILLER.test(word));
  const original = compact(name.normalize('NFKC')), label = compact(kept.join(''));
  if (protectedParts.some(part => original.includes(part) || label.includes(part)) || wholeWord(tokens(name)) || wholeWord(kept)) return BUILTIN_FALLBACK;
  let base = '';
  for (const word of kept) {
    const next = base ? `${base}-${word}` : word;
    if (next.length > 20) { if (!base) base = word.slice(0, 20); break; }
    base = next;
  }
  return base.length < 2 || RESERVED.has(base) || /^xn-/.test(base) || /^[0-9-]+$/.test(base) ? BUILTIN_FALLBACK : base;
}

/** Whether a sender host is under the configured parent: only built-in domains are, every other claim there is refused. */
export const isBuiltinHost = (config: Pick<Config, 'builtinDomain'>, host: string) => !!config.builtinDomain && host.toLowerCase().endsWith(`.${config.builtinDomain}`);
/** send_admission's req.builtin: the scope and its caps, or null when built-in domains are off (their mail is refused). */
export function builtinPolicy(config: Pick<Config, 'multiTenant' | 'builtinDomain' | 'builtinScope'>) {
  if (!config.multiTenant || !config.builtinDomain) return null;
  return { scope: config.builtinScope, ...SEND_LIMITS.builtin[config.builtinScope] };
}
const reservedJson = () => JSON.stringify([...RESERVED]);

/** The workspace's label, allocated in the caller's transaction if it has none. Null when built-in domains are off. */
export async function allocateBuiltinDomain(db: DbExecutor, config: Pick<Config, 'multiTenant' | 'builtinDomain'>, workspaceId: string, workspaceName: string) {
  if (!config.multiTenant || !config.builtinDomain) return null;
  const { rows: [row] } = await db.execute<{ name: string }>(sql`SELECT allocate_builtin_domain(${workspaceId},${builtinBase(workspaceName)},${config.builtinDomain},${reservedJson()}::jsonb) AS name`);
  return row!.name;
}

// The parent identity as SES reports it, and whether built-in domains may send under it: a verified Easy DKIM domain with
// signing on and its MAIL FROM verified, tagged for built-in domains and never as a claim's own identity, with no
// sending authorization policy, no default configuration set and no feedback forwarding.
export const PARENT_PURPOSE = 'builtin-domains';
const parentFacts = (s: Partial<GetEmailIdentityCommandOutput>): IdentityFacts['ses'] => ({ VerificationStatus: s.VerificationStatus, VerifiedForSendingStatus: s.VerifiedForSendingStatus, DkimAttributes: s.DkimAttributes, MailFromAttributes: s.MailFromAttributes });
export function parentProblem(s: Partial<GetEmailIdentityCommandOutput>): string | null {
  if (s.IdentityType !== 'DOMAIN' || s.VerificationStatus !== 'SUCCESS' || s.VerifiedForSendingStatus !== true) return 'not_verified';
  if (s.DkimAttributes?.SigningAttributesOrigin !== 'AWS_SES' || s.DkimAttributes.SigningEnabled !== true || s.DkimAttributes.Status !== 'SUCCESS') return 'dkim';
  if (s.MailFromAttributes?.MailFromDomain && s.MailFromAttributes.MailFromDomainStatus !== 'SUCCESS') return 'mail_from';
  if (!hasTags(s.Tags, [{ Key: tagKey('purpose'), Value: PARENT_PURPOSE }]) || s.Tags?.some(t => t.Key?.endsWith(':domain-claim'))) return 'tags';
  if (Object.keys(s.Policies ?? {}).length) return 'policies';
  if (s.ConfigurationSetName || s.FeedbackForwardingStatus === true) return 'settings';
  return null;
}
const SIMULATED_PARENT: IdentityFacts['ses'] = { VerificationStatus: 'SUCCESS', VerifiedForSendingStatus: true, DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS', SigningAttributesOrigin: 'AWS_SES' } };
type ParentRow = { ok: boolean; ses: IdentityFacts['ses'] | null; problem: string | null; checked_at: string };
async function storedParent(db: DbExecutor, parent: string) {
  return (await db.execute<ParentRow>(sql`SELECT ok,ses,problem,checked_at FROM builtin_parent WHERE name=${parent}`)).rows[0] ?? null;
}
const parentArn = (account: string, parent: string) => `arn:aws:ses:${BUILTIN_REGION}:${account}:identity/${parent}`;
type SharedConnection = ReadyConnection & { tenant_state: string; pool_tenant_name: string | null; managed_tenant: boolean; created_at: string };
async function client(runtime: Runtime, connection: SharedConnection) {
  return getSes({ ...runtime, config: { ...runtime.config, regions: [BUILTIN_REGION] } }, BUILTIN_REGION, connection);
}
const awsName = (e: unknown) => (e as { name?: string } | null)?.name ?? '';
/** Reads the parent identity and records what was found. A failed check stops built-in sending at once. */
async function checkParent(runtime: Runtime, ses: SESv2Client, parent: string) {
  const { GetEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
  let found: GetEmailIdentityCommandOutput | null = null;
  try { found = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: parent })); }
  catch (e) { if (!['NotFoundException', 'NotFound'].includes(awsName(e))) throw e; }
  const checked = found ? parentProblem(found) : 'missing';
  // A tripped breaker (builtinBreaker) keeps the parent down whatever the identity's check finds, until an operator resets it.
  const { rows: [row] } = await runtime.db.execute<{ was: boolean | null; ok: boolean; problem: string | null }>(sql`WITH previous AS (SELECT ok FROM builtin_parent WHERE name=${parent})
    INSERT INTO builtin_parent(name,ok,ses,problem,checked_at) VALUES(${parent},${checked === null},${found ? JSON.stringify(parentFacts(found)) : null}::jsonb,${checked},now())
    ON CONFLICT(name) DO UPDATE SET ok=excluded.ok AND builtin_parent.tripped_at IS NULL,ses=excluded.ses,
      problem=coalesce(excluded.problem,CASE WHEN builtin_parent.tripped_at IS NOT NULL THEN 'reputation' END),checked_at=excluded.checked_at
    RETURNING (SELECT ok FROM previous) AS was,ok,problem`);
  const { ok, problem } = row!;
  if (!ok) {
    // Built-in sending stops at once; receiving lapses on the claims' 72-hour proof window if the identity stays down.
    const paused = await pauseBuiltinClaims(runtime.db);
    log(row!.was === false ? 'warn' : 'error', { code: 'BUILTIN_PARENT_UNAVAILABLE', parent, problem, paused });
  } else if (row!.was !== true) log('info', { code: 'BUILTIN_PARENT_READY', parent });
  return { ok, ses: found ? parentFacts(found) : null, problem };
}
/** Every built-in domain back to pending: their sending stops at once (send admission wants a verified claim). */
async function pauseBuiltinClaims(db: DbExecutor) {
  return (await db.execute(sql`UPDATE domain_claims dc SET sending_state='pending' FROM builtin_domains b
    WHERE dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin' AND dc.sending_state='verified'`)).rowCount ?? 0;
}

/**
 * The circuit breaker's lines: SES's own warning levels for an account, 5% permanent bounces or 0.1% complaints, over the
 * real recipients of built-in mail sent in the last 48 hours (complaints often come a day late) and since the last reset.
 * It judges nothing under 1,000 recipients, and never trips on fewer than 3 complaints, so one or two can't stop every
 * workspace. One workspace alone never trips it either (breakerDecision).
 */
export const BUILTIN_BREAKER = { windowHours: 48, minRecipients: 1000, bounceRate: 0.05, complaintRate: 0.001, minComplaints: 3, everyMinutes: 60 } as const;
export type BuiltinReputation = { recipients: number; bounces: number; complaints: number };
export type BuiltinLine = 'bounces' | 'complaints';
const LINES = ['bounces', 'complaints'] as const;
const crossed = (m: BuiltinReputation, line: BuiltinLine) => m.recipients >= BUILTIN_BREAKER.minRecipients && (line === 'bounces'
  ? m.bounces / m.recipients >= BUILTIN_BREAKER.bounceRate
  : m.complaints >= BUILTIN_BREAKER.minComplaints && m.complaints / m.recipients >= BUILTIN_BREAKER.complaintRate);
/** The line the built-in domains' mail crossed, if any. */
export const breakerVerdict = (m: BuiltinReputation): BuiltinLine | null => LINES.find(line => crossed(m, line)) ?? null;
/** One workspace's share of the built-in mail in the breaker's window. */
export type WorkspaceReputation = BuiltinReputation & { workspaceId: string; revoked: boolean };
const sum = (rows: BuiltinReputation[]): BuiltinReputation => rows.reduce((a, r) => ({ recipients: a.recipients + r.recipients, bounces: a.bounces + r.bounces, complaints: a.complaints + r.complaints }), { recipients: 0, bounces: 0, complaints: 0 });
/**
 * What the breaker does with the window's mail. It trips only when a line is still crossed without the workspace that
 * contributes most to it, so one workspace (at its cap, while built-in volume is small) can't stop everyone: when that
 * one workspace is what crosses the line, the operator is alerted about it, to revoke it, instead.
 */
export function breakerDecision(rows: WorkspaceReputation[]) {
  const counted = sum(rows), lines = LINES.filter(line => crossed(counted, line));
  if (!lines.length) return null;
  const worstFor = (line: BuiltinLine, among = rows) => among.reduce((w, r) => r[line] > w[line] || (r[line] === w[line] && r.workspaceId < w.workspaceId) ? r : w);
  for (const line of lines) {
    const worst = worstFor(line);
    if (crossed(sum(rows.filter(r => r !== worst)), line)) return { action: 'trip', line, counted, worst: worst.workspaceId } as const;
  }
  // The card names the worst workspace that can still send: once the worst is revoked, the next one (a partner it split its
  // mail with) is named, rather than nothing until the revoked one's mail leaves the window.
  const line = lines[0]!, sending = rows.filter(r => !r.revoked && r[line] > 0);
  return { action: 'alert', line, counted, worst: sending.length ? worstFor(line, sending) : null } as const;
}
/**
 * Each workspace's built-in mail in the breaker's window, revoked domains included (their mail signed as the parent too),
 * by real recipient: SES accepted it, not simulated, never the SES mailbox simulator. Each domain is read through its
 * workspace's sender-domain index, so a workspace's own domains' mail is never scanned.
 * - Bounces: the recipients SES bounced permanently, from the bounce events, each once, as hosted_health_projection counts
 *   them (an event that names none counts one); a transient bounce or the rest of a bounced email's recipients don't count.
 * - Complaints: a complaint is one person reporting one email, so it counts once per email, not once per recipient: one
 *   report on a 50-recipient email is one complaint.
 */
async function builtinReputation(db: DbExecutor, parent: string): Promise<WorkspaceReputation[]> {
  return (await db.execute<WorkspaceReputation>(sql`WITH p AS (
      SELECT greatest(now()-make_interval(hours=>${BUILTIN_BREAKER.windowHours}),coalesce(reset_at,'-infinity')) AS since FROM builtin_parent WHERE name=${parent}
    ), mail AS MATERIALIZED (
      SELECT b.workspace_id,b.revoked_at IS NOT NULL AS revoked,e.id,e.recipients,e.complained
      FROM p CROSS JOIN builtin_domains b CROSS JOIN LATERAL (SELECT e.id,(e.status='complained' OR e.event_outcomes & 8 <> 0) AS complained,
          (SELECT count(*) FROM jsonb_array_elements_text(e.to_addresses||e.cc_addresses||e.bcc_addresses) x WHERE lower(x) NOT LIKE '%@simulator.amazonses.com')::int AS recipients
        FROM sending_emails e WHERE e.workspace_id=b.workspace_id AND ((reverse(lower(split_part(e.from_address,'@',2)))||'.') COLLATE "C")=((reverse(b.name)||'.') COLLATE "C")
          AND e.created_at>p.since AND NOT e.simulated AND (e.provider_id IS NOT NULL OR e.event_outcomes & 1 <> 0)) e
      WHERE e.recipients>0
    ), bounced AS (
      SELECT m.workspace_id,m.id,least(m.recipients,greatest(count(DISTINCT h.hash),max(CASE WHEN v.recipient_hashes IS NULL THEN 1 ELSE 0 END)))::int AS n
      FROM mail m JOIN sending_email_events v ON v.workspace_id=m.workspace_id AND v.email_id=m.id LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON true
      WHERE v.type='bounce' AND v.data->>'bounceType'='Permanent' AND NOT v.simulated AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes)>0)
      GROUP BY m.workspace_id,m.id,m.recipients
    ) SELECT m.workspace_id AS "workspaceId",bool_or(m.revoked) AS revoked,sum(m.recipients)::int AS recipients,coalesce(sum(bo.n),0)::int AS bounces,
      count(*) FILTER (WHERE m.complained)::int AS complaints
    FROM mail m LEFT JOIN bounced bo ON bo.workspace_id=m.workspace_id AND bo.id=m.id GROUP BY m.workspace_id ORDER BY m.workspace_id`)).rows;
}
/**
 * The parent's circuit breaker, hourly from builtinDomainTick. All built-in domains sign as one parent, so their combined
 * bounces and complaints are its reputation, which per-workspace pauses never see. Over a line without its worst
 * workspace (breakerDecision) it trips: built-in sending stops everywhere, as when the parent fails its check (every
 * built-in claim back to pending, so mail still queued from them is canceled at dispatch), receiving continues, and the
 * reputation alert channel is told. It stays tripped until an operator resets it (resetBuiltinBreaker). When one
 * workspace alone crosses a line, it only alerts about that workspace, at most once a day. Returns whether it tripped now.
 */
export async function builtinBreaker(runtime: Runtime) {
  const parent = runtime.config.builtinDomain;
  if (!runtime.config.multiTenant || !parent) return false;
  // One count an hour across workers, elected by the parent's own row; none while tripped.
  const due = await runtime.db.execute(sql`UPDATE builtin_parent SET rates_checked_at=now() WHERE name=${parent} AND tripped_at IS NULL
    AND (rates_checked_at IS NULL OR rates_checked_at<=now()-make_interval(mins=>${BUILTIN_BREAKER.everyMinutes - 5})) RETURNING 1`);
  if (!due.rowCount) return false;
  const decision = breakerDecision(await builtinReputation(runtime.db, parent));
  if (!decision) return false;
  const windowHours = BUILTIN_BREAKER.windowHours;
  if (decision.action === 'alert') {
    const { worst, line, counted } = decision;
    // Only revoked workspaces left behind the line: nothing more to do; their mail still counts toward the parent's.
    if (!worst) return false;
    const payload = { code: 'BUILTIN_WORKSPACE_OVER_LINE', parent, line, ...counted, windowHours, workspace: { recipients: worst.recipients, bounces: worst.bounces, complaints: worst.complaints } };
    const { rowCount } = await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload)
      VALUES('builtin-breaker-worst:'||${parent}::text||':'||${worst.workspaceId}::text||':'||${line}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${worst.workspaceId},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT(id) DO NOTHING`);
    if (rowCount) log('error', { code: 'BUILTIN_WORKSPACE_OVER_LINE', parent, workspaceId: worst.workspaceId, line, ...counted });
    return false;
  }
  const trip = { line: decision.line, ...decision.counted, windowHours, worst: decision.worst };
  const paused = await runtime.db.transaction(async tx => {
    const { rows: [row] } = await tx.execute<{ at: string }>(sql`UPDATE builtin_parent SET ok=false,problem=coalesce(problem,'reputation'),tripped_at=now(),trip=${JSON.stringify(trip)}::jsonb
      WHERE name=${parent} AND tripped_at IS NULL RETURNING tripped_at::text AS at`);
    if (!row) return null;
    const n = await pauseBuiltinClaims(tx);
    await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES(${`builtin-breaker:${parent}:${row.at}`},'reputation.alert',${runtime.config.workspaceId},
      ${JSON.stringify({ code: 'BUILTIN_PARENT_TRIPPED', parent, ...trip, paused: n })}::jsonb) ON CONFLICT(id) DO NOTHING`);
    return n;
  });
  if (paused === null) return false;
  log('error', { code: 'BUILTIN_PARENT_TRIPPED', parent, ...trip, paused });
  return true;
}
/**
 * Operator only (scripts/builtin-domain.ts reset-breaker): turns built-in sending back on after the breaker tripped. Each
 * paused domain's domain.builtin job runs again at once: the first checks the parent identity again, and each marks its
 * domain verified. The breaker then counts only mail sent from now on. Audited. Returns the trip it cleared, or null
 * when it wasn't tripped.
 */
export async function resetBuiltinBreaker(db: DbExecutor, parent: string, reason: string, operator: string) {
  const { rows: [row] } = await db.execute<{ trip: Record<string, unknown> }>(sql`WITH old AS (SELECT name,trip,tripped_at FROM builtin_parent WHERE name=${parent} AND tripped_at IS NOT NULL FOR UPDATE),
    reset AS (UPDATE builtin_parent p SET tripped_at=NULL,trip=NULL,reset_at=now(),rates_checked_at=NULL,checked_at=now()-interval '1 day',
        problem=CASE WHEN p.problem='reputation' THEN NULL ELSE p.problem END FROM old WHERE p.name=old.name RETURNING old.trip,old.tripped_at),
    audited AS (INSERT INTO hosted_operator_audit(workspace_id,action,details) SELECT 'platform','builtin-parent-reset',
      jsonb_build_object('operator',${operator}::text,'reason',${reason}::text,'parent',${parent}::text,'trippedAt',tripped_at,'trip',trip) FROM reset),
    queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.builtin:'||b.workspace_id,'domain.builtin',b.workspace_id,'{}'::jsonb
      FROM reset CROSS JOIN builtin_domains b JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin'
      WHERE b.revoked_at IS NULL AND dc.sending_state='pending'
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),created_at=now(),lease_until=NULL,last_error=NULL,payload='{}'::jsonb WHERE jobs.status IN ('completed','failed'))
    SELECT trip FROM reset`);
  return row?.trip ?? null;
}

/** The routing write that sets up the catch-all is audited as the built-in domain, not as a person. */
const systemCtx = (runtime: Runtime, wid: string) => ({ env: runtime, get: (key: string) => key === 'actor'
  ? { workspaceId: wid, keyId: 'builtin-domain', credential: 'system', permissions: ['manage'], domains: [] } : key === 'requestId' ? null : undefined }) as unknown as Ctx;

/** The default inbox and the catch-all route that sends every other address at the domain to it. Idempotent. */
async function ensureCatchAll(runtime: Runtime, wid: string, name: string) {
  const [{ inboxStoreReady }, routing] = await Promise.all([import('./mail-objects.js'), import('./routing.js')]);
  // Without the hosted inbox store, mail to the domain is kept, unrouted, as any domain's catch-all keeps it.
  if (!inboxStoreReady(runtime)) return;
  const address = `${BUILTIN_INBOX_LOCAL}@${name}`;
  const input = { type: 'persistent', ttlSeconds: 86400, graceHours: 24, domain: name, localPart: BUILTIN_INBOX_LOCAL, name: 'Inbox', metadata: {}, clientId: `builtin:${name}`, send: { enabled: true, perDay: 20 } };
  const made = (await runtime.db.execute<{ r: { inbox?: { id: string }; error?: string } }>(sql`SELECT create_managed_inbox(${JSON.stringify({ wid, actor: 'builtin-domain', admin: true, manageAddress: true, hosted: true, id: id('mbx'), input, locals: [BUILTIN_INBOX_LOCAL] })}::jsonb) AS r`)).rows[0]!.r;
  // The workspace may already have given hello@ an inbox of its own: the catch-all then goes there.
  const inbox = made.inbox?.id ?? (await runtime.db.execute<{ id: string }>(sql`SELECT a.mailbox_id AS id FROM mailbox_addresses a JOIN mailboxes b ON b.id=a.mailbox_id AND b.workspace_id=a.workspace_id
    WHERE a.workspace_id=${wid} AND a.address=${address} AND b.kind='inbox' AND b.expires_at IS NULL`)).rows[0]?.id;
  if (!inbox) { log('warn', { code: 'BUILTIN_INBOX_UNAVAILABLE', workspaceId: wid, error: made.error ?? 'unknown' }); return; }
  const match = `*@${name}`;
  await runtime.db.transaction(async tx => {
    // This workspace's routing state row first, as every routing write takes it, so the version read below holds.
    await tx.execute(sql`INSERT INTO mail_routing_state(workspace_id) VALUES(${wid}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`SELECT FROM mail_routing_state WHERE workspace_id=${wid} FOR UPDATE`);
    const before = await routing.listRoutes(tx, wid);
    if (before.some(r => r.match === match)) return;
    const route = routing.makeRoute({ match, to: [inbox], note: `Built-in domain: every address at ${name} without an inbox or route of its own.` } as Parameters<typeof routing.makeRoute>[0]);
    await routing.save(tx, systemCtx(runtime, wid), wid, await routing.currentVersion(tx, wid), before, [...before, route], { note: 'Built-in domain catch-all' });
  });
}

/**
 * The workspace's built-in domain as a domain of its own, once it has a ready shared connection in Ohio: its claim,
 * receiving host, default inbox and catch-all route. Simulated, it sends at once; otherwise setUpBuiltinDomain verifies it,
 * in the request that starts Hosted mail (startHostedMail) or the domain.builtin job queued here, which waits
 * `jobAfterSeconds` while that request does it. Null while there is nothing to create it on (no label yet, revoked, or no
 * ready connection).
 */
export async function ensureBuiltinDomain(runtime: Runtime, wid: string, jobAfterSeconds = 0) {
  const config = runtime.config;
  if (!config.multiTenant || !config.builtinDomain) return null;
  const simulated = isSimulatedSes(runtime), parent = simulated ? null : await storedParent(runtime.db, config.builtinDomain);
  const facts: IdentityFacts = { builtin: true, proven: true, mx: null, note: null, ses: simulated ? SIMULATED_PARENT : parent?.ok && parent.ses ? parent.ses : { VerificationStatus: 'PENDING' } };
  const { rows: [row] } = await runtime.db.execute<{ domain_id: string; host_id: string; name: string; fresh: boolean }>(sql`SELECT * FROM create_builtin_claim(${wid},${id('dom')},${id('mdom')},${simulated ? 'verified' : 'pending'},${JSON.stringify(facts)}::jsonb)`);
  if (!row) return null;
  if (row.fresh) {
    try { await ensureCatchAll(runtime, wid, row.name); }
    catch (e) { if (e instanceof ModuleLoadError) throw e; logError(e, { code: 'BUILTIN_CATCH_ALL_FAILED', workspaceId: wid }); }
    if (!simulated) await runtime.db.execute(queueBuiltinJob(wid, jobAfterSeconds));
  }
  return row;
}
/** The workspace's domain.builtin job: verifies its domain (or, revoked, removes the parent from its tenant). Queued by the
 * request that sets the domain up itself (startHostedMail), it waits `afterSeconds` and is marked `inline`: the domain
 * counts as ready meanwhile (builtinSettingUp). */
export const queueBuiltinJob = (wid: string, afterSeconds = 0) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES('domain.builtin:'||${wid}::text,'domain.builtin',${wid},
    ${afterSeconds > 0 ? '{"inline":true}' : '{}'}::jsonb,now()+make_interval(secs=>${afterSeconds}))
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL WHERE jobs.status IN ('completed','failed')`;

/** How long a send from a built-in domain still being set up waits for it, at most: well past the longest setup of a new
 *  workspace's domain measured in production (8.4 s from sign-up, 5.6 s at the 90th percentile, Nov 2026). */
export const SETUP_WAIT_MS = 20_000;
/** How recently a built-in domain's job must have been queued for a send to wait for it: a new workspace's setup, never a
 *  domain whose setup stalled long ago. */
const SETUP_JOB_RECENT_MINUTES = 10;
/**
 * A send from the workspace's built-in domain while it is still being set up, by the request that made the workspace
 * (builtinSettingUp) or by its domain.builtin job (queued in the last ten minutes, pending or running, its parent healthy):
 * the send waits for the setup here, then admission decides as for any send (its checks and limits are unchanged), so the
 * first send of a new workspace, a dashboard test email or an agent's, is accepted as soon as the domain is ready instead
 * of being refused for the setup's own seconds. The job is woken once, in case it is the one doing the work. Past
 * SETUP_WAIT_MS it is 503 BUILTIN_DOMAIN_SETTING_UP (retryable); one whose setup stopped while the parent is healthy (its job
 * failed or stalled) is 409 BUILTIN_DOMAIN_UNAVAILABLE at once. Returns at once for a domain that sends, and leaves an
 * unhealthy parent (a tripped breaker, a parent still verifying) to admission, as before.
 */
export async function awaitBuiltinSetup(runtime: Runtime, wid: string, waitMs = SETUP_WAIT_MS) {
  const parent = runtime.config.builtinDomain;
  if (!runtime.config.multiTenant || !parent) return;
  // Checked after 200 ms, then less often, at most once a second: a held send reads the database about 20 times in its
  // 20 s, not 100, however many are held at once.
  let woken = false, host = '', pause = 200;
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pause, deadline - Date.now())))), pause = Math.min(1000, pause * 2)) {
    const { rows: [row] } = await runtime.db.execute<{ name: string; pending: boolean; waiting: boolean; parent_ok: boolean }>(sql`SELECT b.name,dc.sending_state='pending' AS pending,
      EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND p.ok) AS parent_ok,
      (${builtinSettingUp(sql`dc`, parent)} OR (dc.sending_state='pending' AND EXISTS (SELECT FROM jobs j WHERE j.id='domain.builtin:'||dc.workspace_id AND j.status IN ('pending','running')
        AND j.created_at>now()-make_interval(mins=>${SETUP_JOB_RECENT_MINUTES})) AND EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND p.ok))) AS waiting
      FROM builtin_domains b JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin' WHERE b.workspace_id=${wid} AND b.revoked_at IS NULL`);
    if (!row?.pending) return;
    host = row.name;
    if (!row.waiting) {
      if (row.parent_ok) throw new ApiError(409, 'BUILTIN_DOMAIN_UNAVAILABLE', `${host} isn’t set up: ${productName} couldn’t finish setting it up. Try again in a minute, or verify a domain of your own to send.`, 'from', true);
      return;
    }
    if (!woken) { woken = true; await runtime.wake?.(1)?.catch(() => {}); }
  }
  const error = new ApiError(503, 'BUILTIN_DOMAIN_SETTING_UP', `${host} is still being set up. Try again in a few seconds: the send is accepted once it is ready.`, 'from', true);
  error.retryAfterSeconds = 5;
  throw error;
}
/** domain.builtin: setUpBuiltinDomain for the job's workspace. */
export const builtinDomainJob: JobHandler = (runtime, payload, job) => setUpBuiltinDomain(runtime, job.workspaceId, payload);
/**
 * Makes sure the workspace's built-in domain exists, then associates the parent identity with the workspace's SES tenant
 * and marks the domain verified. A revoked domain's association is removed instead. The domain.builtin job runs it, and so
 * does the request that starts Hosted mail (startHostedMail), so both keep every check below: the kill switch, the
 * revoke race and the breaker. Throws JobDeferred to wait (without using attempts) for the tenant, the control-plane pace
 * or the parent identity while it isn't verified (counted in the job's `payload`, BUILTIN_PARENT_RETRY).
 */
export async function setUpBuiltinDomain(runtime: Runtime, wid: string, payload: Record<string, unknown> = {}) {
  const config = runtime.config, parent = config.builtinDomain;
  if (!config.multiTenant || !parent) return;
  const wait = (ms: number): never => { throw new JobDeferred(new Date(Date.now() + ms).toISOString()); };
  const { rows: [state] } = await runtime.db.execute<{ name: string; revoked: boolean; connection: SharedConnection | null; sending: string | null }>(sql`SELECT b.name,b.revoked_at IS NOT NULL AS revoked,
    (SELECT to_jsonb(c) FROM provider_connections c WHERE c.workspace_id=b.workspace_id AND c.kind='shared' AND c.state='ready') AS connection,
    (SELECT dc.sending_state FROM domain_claims dc WHERE dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin') AS sending
    FROM builtin_domains b WHERE b.workspace_id=${wid}`);
  if (!state?.connection) return;
  const simulated = isSimulatedSes(runtime), connection = state.connection;
  if (!state.revoked && !state.sending && !await ensureBuiltinDomain(runtime, wid)) return;
  if (simulated || !connection.aws_account_id) return;
  assertSharedAccount(runtime, connection);
  if (!state.revoked && state.sending === 'verified') return;
  // A new connection's tenant is made within seconds, so it is looked at again in 5 s (production waited 5 minutes for a
  // tenant that was ready 4 s later); an older one that still isn't ready, in 5 minutes.
  if (connection.tenant_state !== 'ready') wait(Date.parse(connection.created_at) > Date.now() - 600_000 ? 5_000 : 300_000);
  // One SES control-plane call at a time across workers, as domain verification paces them.
  if (!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES ('domain.verify:platform',clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id)
    DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount) wait(1000 + Math.random() * 1000);
  const ses = await client(runtime, connection), binding = { TenantName: claimTenantName(connection, wid), ResourceArn: parentArn(connection.aws_account_id, parent) };
  const { CreateTenantResourceAssociationCommand, DeleteTenantResourceAssociationCommand } = await import('@aws-sdk/client-sesv2');
  try {
    if (state.revoked) {
      try { await ses.send(new DeleteTenantResourceAssociationCommand(binding)); }
      catch (e) { if (!['NotFoundException', 'NotFound'].includes(awsName(e))) throw e; }
      return;
    }
    const stored = await storedParent(runtime.db, parent);
    const facts = stored?.ok && Date.parse(stored.checked_at) > Date.now() - 2 * 3600_000 ? stored : await checkParent(runtime, ses, parent);
    if (!facts.ok) {
      const waits = Number(payload.parentWaits) || 0;
      throw new JobDeferred(new Date(Date.now() + (waits < BUILTIN_PARENT_RETRY.times ? BUILTIN_PARENT_RETRY.everyMs : BUILTIN_PARENT_RETRY.thenMs)).toISOString(), { ...payload, parentWaits: waits + 1 });
    }
    try { await ses.send(new CreateTenantResourceAssociationCommand(binding)); }
    catch (e) { if (!['AlreadyExistsException', 'AlreadyExists'].includes(awsName(e))) throw e; }
    const { rowCount } = await runtime.db.execute(sql`UPDATE domain_claims dc SET sending_state='verified',identity=dc.identity||jsonb_build_object('ses',${JSON.stringify(facts.ses)}::jsonb)
      FROM builtin_domains b WHERE b.workspace_id=${wid} AND b.revoked_at IS NULL AND dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin'
        AND dc.connection_id=${connection.id} AND dc.sending_state<>'verified' AND EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND p.ok)`);
    // Revoked while this run was associating (the revoke's own job request found this one running): take the parent back out.
    if (!rowCount && (await runtime.db.execute<{ revoked: boolean }>(sql`SELECT revoked_at IS NOT NULL AS revoked FROM builtin_domains WHERE workspace_id=${wid}`)).rows[0]?.revoked) {
      try { await ses.send(new DeleteTenantResourceAssociationCommand(binding)); }
      catch (e) { if (!['NotFoundException', 'NotFound'].includes(awsName(e))) throw e; }
    }
  } catch (e) {
    if (e instanceof JobDeferred || e instanceof ApiError || e instanceof ModuleLoadError) throw e;
    if (/Throttl|TooManyRequests/.test(awsName(e))) wait(5000 + Math.random() * 5000);
    logError(e, { code: 'BUILTIN_DOMAIN_SES_FAILED', workspaceId: wid });
    throw new ApiError(503, 'BUILTIN_DOMAIN_SES_FAILED', 'The built-in domain could not be set up in SES; it will be retried.', undefined, true);
  }
}

/**
 * Every five minutes (from domainSetupTick, which is elected): the parent identity's check (hourly), labels for
 * workspaces that have none (the backfill), domain.builtin jobs for workspaces whose ready connection has no built-in
 * domain yet (or whose domain waits for the parent), and the built-in domains' receiving proof while the parent is
 * verified. Each step is bounded. Returns how many jobs it queued.
 */
export async function builtinDomainTick(runtime: Runtime) {
  const config = runtime.config, parent = config.builtinDomain;
  if (!config.multiTenant || !parent) return 0;
  const simulated = isSimulatedSes(runtime), stored = await storedParent(runtime.db, parent);
  if (simulated && !stored?.ok) await runtime.db.execute(sql`INSERT INTO builtin_parent(name,ok,ses,checked_at) VALUES(${parent},true,${JSON.stringify(SIMULATED_PARENT)}::jsonb,now())
    ON CONFLICT(name) DO UPDATE SET ok=builtin_parent.tripped_at IS NULL,ses=excluded.ses,problem=CASE WHEN builtin_parent.tripped_at IS NOT NULL THEN 'reputation' END,checked_at=now()`);
  else if (!simulated && (!stored || Date.parse(stored.checked_at) <= Date.now() - 3600_000)) {
    const { rows: [conn] } = await runtime.db.execute<{ c: SharedConnection }>(sql`SELECT to_jsonb(c) AS c FROM provider_connections c WHERE c.kind='shared' AND c.state='ready' AND c.region=${BUILTIN_REGION}
      AND c.aws_account_id IS NOT NULL ORDER BY c.id LIMIT 1`);
    if (conn) try { await checkParent(runtime, await client(runtime, conn.c), parent); }
    catch (e) { if (e instanceof ModuleLoadError) throw e; logError(e, { code: 'BUILTIN_PARENT_CHECK_FAILED', parent }); }
  }
  let tripped = false;
  try { tripped = await builtinBreaker(runtime); }
  catch (e) { if (e instanceof ModuleLoadError) throw e; logError(e, { code: 'BUILTIN_BREAKER_FAILED', parent }); }
  // The backfill: labels for workspaces created before built-in domains, or while they were off.
  const { rows: unlabeled } = await runtime.db.execute<{ id: string; name: string }>(sql`SELECT w.id,w.name FROM workspaces w WHERE NOT EXISTS (SELECT FROM builtin_domains b WHERE b.workspace_id=w.id)
    ORDER BY w.created_at,w.id LIMIT 200`);
  for (const w of unlabeled) await allocateBuiltinDomain(runtime.db, config, w.id, w.name);
  // Domains for workspaces whose connection is ready, and the parent's association once it verifies.
  const { rows: queued } = await runtime.db.execute(sql`WITH due AS (SELECT b.workspace_id FROM builtin_domains b
      JOIN provider_connections c ON c.workspace_id=b.workspace_id AND c.kind='shared' AND c.state='ready'
      JOIN provider_connection_regions r ON r.connection_id=c.id AND r.region=${BUILTIN_REGION} AND r.sending_state='ready'
      LEFT JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.connection_id=c.id
      LEFT JOIN jobs j ON j.id='domain.builtin:'||b.workspace_id
      WHERE b.revoked_at IS NULL AND (dc.name IS NULL OR (dc.sending_state='pending' AND ${!simulated} AND EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND p.ok)))
        AND (j.id IS NULL OR (j.status IN ('completed','failed') AND j.created_at<=now()-interval '1 hour'))
      ORDER BY b.created_at LIMIT 200)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.builtin:'||workspace_id,'domain.builtin',workspace_id,'{}'::jsonb FROM due
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),created_at=now(),lease_until=NULL,last_error=NULL,payload='{}'::jsonb WHERE jobs.status IN ('completed','failed') RETURNING 1`);
  // The parent is the built-in domains' receiving proof: while it verifies, each stays fresh (route() wants 72 hours). A
  // tripped breaker stops their sending, not their receiving: the identity still verifies.
  await runtime.db.execute(sql`UPDATE domain_claims dc SET receiving_proved_at=now(),receiving_identity_at=now(),receiving_proof_missed_at=NULL FROM builtin_domains b
    WHERE dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin' AND b.revoked_at IS NULL AND dc.receiving_state='active'
      AND dc.receiving_proved_at<now()-interval '12 hours' AND EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND (p.ok OR p.problem='reputation'))`);
  return queued.length + Number(tripped);
}

/**
 * Operator only (scripts/builtin-domain.ts apex): the built-in parent's role addresses (BUILTIN_APEX_LOCALS:
 * abuse@, postmaster@, dmarc@, tls-reports@ <parent>) for the platform workspace. Its own built-in domain gets a receiving
 * host for the parent's name, so the parent's role addresses reach it (mailbox-receipts.ts route), and each role address
 * given gets an exact route to the destinations given (that workspace's inboxes or webhooks), written by the routing
 * API's own save() and audited. The parent itself is never claimed (its claim would overlap every built-in domain's)
 * and never sends. Idempotent: a role address routed before has its destinations replaced. Returns the host's ID.
 */
export async function ensureBuiltinApex(runtime: Pick<Runtime, 'db' | 'config'>, routes: Partial<Record<(typeof BUILTIN_APEX_LOCALS)[number], string[]>>, operator: string, reason: string) {
  const { parent, workspace: wid } = builtinApex(runtime.config);
  if (!parent || !wid) throw new ApiError(409, 'BUILTIN_APEX_UNAVAILABLE', 'Set NIGHTMAIL_BUILTIN_DOMAIN and NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE first.');
  const unknown = Object.keys(routes).filter(local => !(BUILTIN_APEX_LOCALS as readonly string[]).includes(local));
  if (unknown.length) throw new ApiError(422, 'BUILTIN_APEX_ADDRESS', `Only ${BUILTIN_APEX_LOCALS.join(', ')} receive at ${parent}, not ${unknown.join(', ')}.`);
  const routing = await import('./routing.js'), hostId = id('mdom');
  return runtime.db.transaction(async tx => {
    const { rows: [host] } = await tx.execute<{ id: string }>(sql`WITH own AS (SELECT m.id,m.domain_id FROM builtin_domains b
        JOIN mailbox_domains m ON m.workspace_id=b.workspace_id AND m.name=b.name AND m.parent_id IS NULL AND m.status='active' WHERE b.workspace_id=${wid} AND b.revoked_at IS NULL),
      existing AS (SELECT m.id FROM mailbox_domains m WHERE m.workspace_id=${wid} AND m.receiving_host=${parent} FOR UPDATE),
      revived AS (UPDATE mailbox_domains m SET status='active',lost_since=NULL,issue=NULL,parent_id=own.id,domain_id=own.domain_id,updated_at=now() FROM own
        WHERE m.workspace_id=${wid} AND m.id IN (SELECT id FROM existing) RETURNING m.id),
      made AS (INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,receiving_host,status,enabled_at,parent_id)
        SELECT ${hostId},${wid},own.domain_id,${hostId},${BUILTIN_REGION},${parent},'active',now(),own.id FROM own WHERE NOT EXISTS (SELECT FROM existing) RETURNING id)
      SELECT id FROM revived UNION ALL SELECT id FROM made`);
    if (!host) throw new ApiError(409, 'BUILTIN_APEX_UNAVAILABLE', 'The platform workspace has no built-in domain that receives yet: its role addresses at the parent arrive through it.');
    // This workspace's routing state row first, as every routing write takes it, so the version read below holds.
    await tx.execute(sql`INSERT INTO mail_routing_state(workspace_id) VALUES(${wid}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`SELECT FROM mail_routing_state WHERE workspace_id=${wid} FOR UPDATE`);
    const before = await routing.listRoutes(tx, wid), wanted = new Map(Object.entries(routes).map(([local, to]) => [`${local}@${parent}`, to!]));
    const after = [...before.filter(r => !wanted.has(r.match)), ...[...wanted].map(([match, to]) =>
      routing.makeRoute({ match, to, note: `${productName}'s built-in domains' ${match.split('@')[0]} address.` } as Parameters<typeof routing.makeRoute>[0], before.find(r => r.match === match)))];
    await routing.save(tx, systemCtx(runtime as Runtime, wid), wid, await routing.currentVersion(tx, wid), before, after, { note: 'Built-in parent role addresses' });
    await tx.execute(sql`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES(${wid},'builtin-apex',
      jsonb_build_object('operator',${operator}::text,'reason',${reason}::text,'parent',${parent}::text,'host',${host.id}::text,'routes',${JSON.stringify(routes)}::jsonb))`);
    return host.id;
  });
}

/** Operator only (scripts/builtin-domain.ts): stops the workspace's built-in domain sending and receiving at once, keeps
 * its label from ever being given out again, and queues the removal of the parent from its tenant. Audited. */
export async function revokeBuiltinDomain(db: DbExecutor, wid: string, reason: string, operator: string) {
  const { rows: [row] } = await db.execute<{ name: string }>(sql`WITH b AS (UPDATE builtin_domains SET revoked_at=now(),revoked_reason=${reason} WHERE workspace_id=${wid} AND revoked_at IS NULL RETURNING name),
    released AS (DELETE FROM domain_claims dc USING b WHERE dc.workspace_id=${wid} AND dc.name=b.name RETURNING dc.name,dc.token),
    ${releasedClaimCleanup(wid)}, dropped AS (DELETE FROM operation_domains d USING b WHERE d.workspace_id=${wid} AND d.name=b.name),
    audited AS (INSERT INTO hosted_operator_audit(workspace_id,action,details) SELECT ${wid},'builtin-domain-revoked',jsonb_build_object('operator',${operator}::text,'reason',${reason}::text,'domain',b.name) FROM b),
    queued AS (${queueBuiltinJob(wid)})
    SELECT name FROM b`);
  return row?.name ?? null;
}

const count = (n: number) => n.toLocaleString('en-US');
/** send_admission's built-in refusals as the API's errors. */
export function builtinRefusal(config: Pick<Config, 'builtinScope'>, d: { code: string; field?: string; unsupported?: string[]; host?: string; builtin?: string; notMembers?: string[]; window?: string; resetAt?: string }) {
  const host = d.host ?? 'This workspace’s built-in domain', limits = SEND_LIMITS.builtin[config.builtinScope];
  switch (d.code) {
    case 'BUILTIN_DOMAIN_RECIPIENT': {
      // assertBuiltinRecipients names the recipients; send_admission's backstop can't. An agent replying to mail its built-in
      // address received retried this three times: the answer says it's a standing limit, the step that lifts it, and (in
      // details) the same as fields: who it sends to and the operation to call next.
      const others = d.notMembers ?? [], shown = others.length > 3 ? [...others.slice(0, 3), `${others.length - 3} more`] : others;
      const who = !others.length ? '' : `, so it can’t send to ${and(shown)}`;
      const error = new ApiError(422, d.code, `${host} is a built-in domain: for now it sends only to members of this workspace, at their own sign-in addresses${who}. To send or reply to anyone else, ${ADD_OWN_DOMAIN}. Trying again won’t change this.`, 'to');
      error.details = [{ ...(others.length ? { notMembers: others } : {}), ...BUILTIN_RECIPIENT_HINT }];
      return error;
    }
    case 'BUILTIN_DOMAIN_LIMIT': {
      const at = d.resetAt ? new Date(d.resetAt).toISOString() : undefined;
      return new ApiError(429, d.code, `${host} sends to at most ${count(limits.perMinute)} recipients a minute and ${count(limits.perDay)} in 24 hours; this ${d.window === 'minute' ? 'minute’s' : 'day’s'} are used.${at ? ` Try again after ${at}, or` : ''} verify a domain of your own to send more.`, undefined, true, at);
    }
    // send_admission's backstop; assertBuiltinStillSends refuses first, with the exact address to use.
    case 'OWN_DOMAIN_VERIFIED': {
      const error = new ApiError(409, d.code, `Send from your own domain now: ${d.host} is verified, so ${d.builtin ?? 'the built-in domain'} no longer sends; it still receives. Use an address at ${d.host} as From.`, 'from');
      if (d.host) error.details = [{ verifiedDomains: [d.host] }];
      return error;
    }
    case 'BUILTIN_DOMAIN_UNSUPPORTED': {
      // Every field the send used that the built-in domain can't send, at once (assertBuiltinInput), so an agent doesn't
      // find them one retry at a time; send_admission's own checks name one.
      const unsupported = BUILTIN_UNSUPPORTED.filter(f => (d.unsupported ?? [d.field]).includes(f)), words = unsupported.map(f => BUILTIN_UNSUPPORTED_WORDS[f]);
      const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? 'something it can’t send';
      const error = new ApiError(422, d.code, `${host} can’t send this email: it uses ${list}. ${builtinLimitsText(config.builtinScope)}`, unsupported[0] === 'campaign' ? 'from' : unsupported[0]);
      error.details = [{ unsupported }];
      return error;
    }
    case 'BUILTIN_DOMAIN_REVOKED': return new ApiError(403, d.code, `${host} was turned off by ${productName}. Verify a domain of your own to send.`, 'from');
    default: return new ApiError(409, 'BUILTIN_DOMAIN_UNAVAILABLE', `Sending from ${host} is unavailable right now. Verify a domain of your own to send.`, 'from', true);
  }
}
/** BUILTIN_DOMAIN_RECIPIENT's fields beside notMembers: who a built-in domain sends to, and what to call to email anyone. */
export const BUILTIN_RECIPIENT_HINT = { sendsTo: 'workspaceMembers', nextStep: { operationId: 'createDomain', method: 'POST', path: '/v1/domains' } } as const;
const and = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
/**
 * A send from the built-in domain once a domain of the workspace's own is verified (or verified before and lost): refused
 * before admission, which refuses it too as the backstop, with the exact address to use instead (the same local part at
 * the workspace's own domain, a verified one first), so an agent whose configuration still names the built-in address
 * can switch without asking. 409 OWN_DOMAIN_VERIFIED, error.details one entry per such email: from, suggestedFrom and
 * verifiedDomains (a batch: and its index). A subdomain of the built-in domain is left to assertBuiltinInput, as in SQL.
 */
export async function assertBuiltinStillSends(runtime: Runtime, db: DbExecutor, workspaceId: string, froms: string[], batch = false) {
  const hostOf = (from: string) => from.split('@')[1]!.toLowerCase(), hosts = [...new Set(froms.map(hostOf).filter(h => isBuiltinHost(runtime.config, h)))];
  if (!hosts.length) return;
  const { rows: [row] } = await db.execute<{ builtin: string | null; own: string[] }>(sql`SELECT
      (SELECT b.name FROM builtin_domains b WHERE b.workspace_id=${workspaceId} AND b.revoked_at IS NULL AND b.name=ANY(${sql.param(hosts)}::text[])) AS builtin,
      ARRAY(SELECT dc.name FROM domain_claims dc WHERE dc.workspace_id=${workspaceId} AND dc.sending_state IN ('verified','lost') AND NOT coalesce(dc.identity ? 'builtin',false)
        ORDER BY dc.sending_state<>'verified',dc.name) AS own`);
  if (!row?.builtin || !row.own.length) return;
  const builtin = row.builtin, own = row.own, suggest = (from: string) => `${from.slice(0, from.lastIndexOf('@'))}@${own[0]}`;
  const found = froms.map((from, index) => ({ index, from })).filter(x => hostOf(x.from) === builtin);
  if (!found.length) return;
  const first = found[0]!;
  const error = new ApiError(409, 'OWN_DOMAIN_VERIFIED', `Send from your own domain now: use ${suggest(first.from)} instead of ${first.from}. ${own.length === 1 ? `${own[0]} is verified` : `Your verified domains are ${and(own)}`}, so ${builtin} no longer sends; it still receives. Change the From address where your code or agent keeps it.`,
    batch ? `emails.${first.index}.from` : 'from');
  error.details = found.map(x => ({ ...(batch ? { index: x.index } : {}), from: x.from, suggestedFrom: suggest(x.from), verifiedDomains: own }));
  throw error;
}
/**
 * A send from the built-in domain while it sends to members only (NIGHTMAIL_BUILTIN_SEND_SCOPE=members): refused before
 * admission (send_admission refuses it too, as the backstop) when any recipient isn't one of the workspace members' own
 * verified sign-in addresses, naming each such recipient (error.details[].notMembers; a batch: with its index) and the next
 * step. Nothing is read for a send from any other domain, or while the built-in domain sends to anyone.
 */
export async function assertBuiltinRecipients(runtime: Runtime, db: DbExecutor, workspaceId: string, mails: { from: string; recipients: string[] }[], batch = false, reply?: BuiltinReply): Promise<{ replyGranted: boolean }> {
  const none = { replyGranted: false };
  if (runtime.config.builtinScope !== 'members') return none;
  const sent = mails.map((m, index) => ({ index, host: m.from.split('@')[1]!.toLowerCase(), recipients: m.recipients })).filter(m => isBuiltinHost(runtime.config, m.host));
  if (!sent.length) return none;
  const all = [...new Set(sent.flatMap(m => m.recipients.map(r => r.toLowerCase())))];
  const { rows: [row] } = await db.execute<{ members: string[] }>(sql`SELECT ARRAY(SELECT DISTINCT lower(u.email) FROM workspace_members wm JOIN nightmail_users u ON u.id=wm.user_id
    WHERE wm.workspace_id=${workspaceId} AND u.email_verified AND lower(u.email)=ANY(${sql.param(all)}::text[])) AS members`);
  const members = new Set(row?.members ?? []);
  const found = sent.map(m => ({ index: m.index, host: m.host, notMembers: [...new Set(m.recipients.filter(r => !members.has(r.toLowerCase())))] })).filter(m => m.notMembers.length);
  if (!found.length) return none;
  // The one exception (off unless NIGHTMAIL_BUILTIN_REPLIES): a thread reply to the sender of the message it answers.
  const refused = reply && runtime.config.builtinReplies && !batch && mails.length === 1 ? await builtinReplyException(runtime, db, workspaceId, mails[0]!.recipients, reply, sent[0]!.host) : null;
  if (refused === true) return { replyGranted: true };
  const first = found[0]!, error = builtinRefusal(runtime.config, { code: 'BUILTIN_DOMAIN_RECIPIENT', host: first.host, notMembers: first.notMembers });
  if (batch) error.field = `emails.${first.index}.to`;
  error.details = found.map(m => ({ ...(batch ? { index: m.index } : {}), notMembers: m.notMembers, ...BUILTIN_RECIPIENT_HINT, ...(refused ? { reply: refused.text } : {}) }));
  // A thread reply's refusal names the failed condition in the request log too, as a code (the detail's text never goes there).
  if (reply) error.logReason = (refused ? refused.reason : 'replies_off') satisfies BuiltinReplyRefusal;
  throw error;
}
/** The received message a thread reply answers, for builtinReplyException: set only by replyToInboundThread. */
export type BuiltinReply = { messageId: string; mailboxId: string };
/** Which condition refused a thread reply from a built-in domain: the request log's `reason` (no text, address or content). */
export type BuiltinReplyRefusal = 'replies_off' | 'extra_recipient' | 'not_received' | 'not_sender' | 'reply_to_elsewhere' | 'own_address' | 'automated' | 'unverified'
  | 'not_addressed' | 'suppressed' | 'already_answered' | 'daily_cap' | 'recipient_cap' | 'support_cap';
/**
 * A reply from a built-in domain, while it sends to members only, may go to someone outside the workspace once: to the
 * address that sent the received message it answers, and only when that sender passed authentication as inbound records
 * it (reply_author_verified: DMARC, or an aligned SPF or DKIM pass), so a forged From can't make it mail a victim. Never
 * to anyone else, a Reply-To at another domain, cc or bcc; never to automated mail, junk, mail from a built-in or platform
 * address (but our support's: NIGHTMAIL_SUPPORT_ADDRESS_IDS, at a platform domain, while NIGHTMAIL_BUILTIN_SUPPORT_REPLIES
 * is set), or a suppressed address; only to a message that was sent to this built-in domain (in its To or Cc: a signed
 * message the sender wrote to someone else, replayed here, can't make it mail them); at most one reply per received
 * message, and NIGHTMAIL_BUILTIN_REPLIES's daily counts: per workspace, and per recipient across every workspace (sign-ups
 * are cheap: many workspaces must not each get their own allowance to the same person), for support its own count across
 * every workspace instead. Everything else a send meets (screening, standing, limits, suppression) still applies. Runs
 * under the workspace's send locks and, for anyone but support, a lock for the recipient, so the counts can't race
 * (support's count is approximate: see below). True when allowed (and recorded in builtin_replies, in the send's
 * transaction), else the condition that failed: a code for the log and plain words for the caller, never the numbers.
 */
export async function builtinReplyException(runtime: Runtime, db: DbExecutor, workspaceId: string, recipients: string[], reply: BuiltinReply, host: string): Promise<true | { reason: BuiltinReplyRefusal; text: string }> {
  const caps = runtime.config.builtinReplies!, refuse = (reason: BuiltinReplyRefusal, text: string) => ({ reason, text });
  if (recipients.length !== 1) return refuse('extra_recipient', 'A reply to someone outside the workspace may go only to the sender of the message it answers, alone: no other recipients, cc or bcc.');
  const to = recipients[0]!.toLowerCase();
  // Support's addresses (none while its count is off): the mailboxes of NIGHTMAIL_SUPPORT_ADDRESS_IDS, and their aliases.
  const supportIds = caps.supportPerDay > 0 ? runtime.config.support?.addressIds ?? [] : [];
  const supportAddresses = sql`(SELECT lower(b.address) FROM mailboxes b WHERE b.id=ANY(${sql.param(supportIds)}::text[])
    UNION ALL SELECT lower(a.address) FROM mailbox_addresses a WHERE a.mailbox_id=ANY(${sql.param(supportIds)}::text[]))`;
  const ours = (domain: string) => platformHosts(runtime.config).some(h => domain === h || domain.endsWith(`.${h}`));
  // Replies to one person from every workspace take turns, so the count across workspaces holds (the send locks are per
  // workspace). Not replies to support: its count takes no lock (below).
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${to}, 57501)) ${ours(to.split('@')[1] ?? '') ? sql`WHERE ${to}::text NOT IN ${supportAddresses}` : sql``}`);
  const { rows: [m] } = await db.execute<{ from_address: string; automated: boolean; spam: boolean; verified: boolean; unverified: boolean; reply_to: { address: string }[];
    answered: boolean; addressed: boolean; today: number; recipient_today: number; suppressed: boolean; support: boolean }>(sql`SELECT lower(m.from_address) AS from_address, m.automated, m.spam,
      l.reply_author_verified AS verified, 'unverified'=ANY(l.labels) AS unverified, m.reply_to,
      EXISTS(SELECT FROM builtin_replies r WHERE r.workspace_id=${workspaceId} AND r.message_id=m.id) AS answered,
      (SELECT count(*)::int FROM builtin_replies r WHERE r.workspace_id=${workspaceId} AND r.created_at>now()-interval '1 day') AS today,
      EXISTS(SELECT FROM jsonb_array_elements(coalesce(m."to",'[]'::jsonb)||coalesce(m.cc,'[]'::jsonb)) a WHERE lower(split_part(coalesce(a->>'address',a#>>'{}'),'@',2))=${host}) AS addressed,
      (SELECT count(*)::int FROM builtin_replies r WHERE r.recipient=lower(m.from_address) AND r.created_at>now()-interval '1 day') AS recipient_today,
      EXISTS(SELECT FROM audience_contacts c WHERE c.workspace_id=${workspaceId} AND lower(c.email)=lower(m.from_address) AND c.suppressed AND c.deleted_at IS NULL) AS suppressed,
      lower(m.from_address) IN ${supportAddresses} AS support
    FROM mail_messages m JOIN mailbox_messages l ON l.message_id=m.id AND l.workspace_id=m.workspace_id AND l.mailbox_id=${reply.mailboxId}
    WHERE m.workspace_id=${workspaceId} AND m.id=${reply.messageId} AND m.direction='inbound' LIMIT 1`);
  if (!m) return refuse('not_received', 'Only a reply to a message this address received can go to someone outside the workspace.');
  if (to !== m.from_address) return refuse('not_sender', 'It may go only to the address that sent the message you are answering.');
  const domain = m.from_address.split('@')[1] ?? '';
  if ((m.reply_to ?? []).some(r => r.address.toLowerCase().split('@')[1] !== domain)) return refuse('reply_to_elsewhere', 'The message asks for replies at another domain (Reply-To), so it can’t be answered from the built-in domain.');
  // Of our own addresses only support's (an address of NIGHTMAIL_SUPPORT_ADDRESS_IDS at a platform domain, while its count is
  // on): an agent that wrote to support may answer what support wrote back. Notices, no-reply senders, every other mailbox
  // at our domains and other built-in domains stay refused.
  const support = ours(domain) && m.support;
  if (isBuiltinHost(runtime.config, domain) || (ours(domain) && !support))
    return refuse('own_address', `It came from another built-in domain or one of ${productName}’s own addresses, so the built-in domain can’t answer it. The one ${productName} address it answers is support, replying to what support sent.`);
  const { NO_REPLY } = await import('./mailbox-send.js');
  if (m.automated || m.spam || NO_REPLY.test(m.from_address)) return refuse('automated', 'The message is automated (an auto-reply, bounce or list mail) or junk, so it can’t be answered from the built-in domain.');
  if (!m.verified || m.unverified) return refuse('unverified', 'Its sender didn’t pass authentication (DMARC, or an aligned SPF or DKIM pass), so the built-in domain can’t answer it: the From address may not be the real sender.');
  if (!m.addressed) return refuse('not_addressed', 'The message wasn’t sent to this domain (it isn’t in its To or Cc), so the built-in domain can’t answer it.');
  if (m.suppressed) return refuse('suppressed', 'That address is suppressed (it bounced or complained earlier), so it is never mailed.');
  if (m.answered) return refuse('already_answered', 'This message was already answered once from the built-in domain.');
  const used = 'The built-in domain’s daily allowance for replies outside the workspace is used (for the workspace or for this address). Try again tomorrow, or add a domain of your own.';
  if (m.today >= caps.perDay) return refuse('daily_cap', used);
  if (!support && m.recipient_today >= caps.perRecipientPerDay) return refuse('recipient_cap', used);
  // Support has a count of its own instead of the per-recipient one: that count keeps cheap sign-ups from adding up their
  // allowances against one outside person, but support is our own address, which every customer may answer on the same
  // day. Its own count (NIGHTMAIL_BUILTIN_SUPPORT_REPLIES, every workspace together, support's addresses and aliases) is
  // deliberately approximate: read without a lock just before the grant is written, so replies in other workspaces at the
  // same moment may each pass at the last place, going over by at most the replies in flight. A lock shared by every
  // workspace would make each reply to support wait for another's content screening while holding its own workspace's
  // send lock. A few over 300 stays well inside the daily intake support shares with abuse@, privacy@ and legal@
  // (support/src/limits.ts mailPerDay).
  if (support && (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM builtin_replies r WHERE r.recipient IN ${supportAddresses} AND r.created_at>now()-interval '1 day'`)).rows[0]!.n >= caps.supportPerDay)
    return refuse('support_cap', used);
  await db.execute(sql`INSERT INTO builtin_replies(workspace_id,message_id,recipient) VALUES(${workspaceId},${reply.messageId},${to})`);
  return true;
}
/** The send_admission policy for a granted reply: the members-only caps, without its member check (the TypeScript check
 *  above admitted this one recipient). Never used for anything but a reply builtinReplyException allowed. */
export function builtinReplyPolicy(config: Pick<Config, 'multiTenant' | 'builtinDomain' | 'builtinScope'>) {
  const policy = builtinPolicy(config);
  return policy && { ...policy, scope: 'anyone' as const };
}
/** What a send from a built-in domain uses that it can't send, by request field: every one, not only the first. */
export function builtinUnsupported(config: Pick<Config, 'builtinDomain'>, m: { from: string; replyTo?: string[]; headers?: unknown[]; template?: unknown; attachments?: unknown[]; kind?: string; scheduledAt?: unknown }): BuiltinUnsupported[] {
  const host = m.from.split('@')[1]!.toLowerCase();
  if (!isBuiltinHost(config, host)) return [];
  const used: Record<BuiltinUnsupported, boolean> = { from: host.slice(0, -(config.builtinDomain!.length + 1)).includes('.'), replyTo: !!m.replyTo?.some(r => r.split('@')[1]?.toLowerCase() !== host),
    headers: !!m.headers?.length, attachments: !!m.attachments?.length, template: !!m.template, scheduledAt: !!m.scheduledAt, kind: m.kind === 'marketing', campaign: false };
  return BUILTIN_UNSUPPORTED.filter(f => used[f]);
}
/** TypeScript's checks of a send from the built-in domain, before anything is looked up: one refusal naming every field it
 * can't send (a batch: each email's, in details, the first one's in field). send_admission repeats them as a backstop. */
export function assertBuiltinInput(config: Pick<Config, 'builtinDomain' | 'builtinScope'>, mails: Parameters<typeof builtinUnsupported>[1][], batch = false) {
  const found = mails.map((m, index) => ({ index, unsupported: builtinUnsupported(config, m) })).filter(x => x.unsupported.length);
  if (!found.length) return;
  const first = found[0]!, error = builtinRefusal(config, { code: 'BUILTIN_DOMAIN_UNSUPPORTED', unsupported: first.unsupported, host: mails[first.index]!.from.split('@')[1]!.toLowerCase() });
  if (batch) { error.field = `emails.${first.index}.${error.field}`; error.details = found; }
  throw error;
}
/** The API reference's words, on sendEmail and sendEmailBatch. */
export const BUILTIN_NOTE = `Built-in domain (Hosted): every workspace has a subdomain of ${productName}'s own domain (connection.builtinDomain in GET /v1/me) that sends until the workspace verifies a domain of its own: plain transactional email sent now, without attachments, custom headers, a stored template or a Reply-To elsewhere (422 BUILTIN_DOMAIN_UNSUPPORTED, once, listing every such field in error.details[].unsupported), to the recipients the installation allows (on hosted ${productName}, for now, only the verified sign-in addresses of the workspace's members: 422 BUILTIN_DOMAIN_RECIPIENT names any other recipient in error.details[0].notMembers; add a domain of your own to email anyone; where connection.builtinDomain.repliesToSenders is true, a thread reply (replyToInboundThread) may also go once to the authenticated sender of the message it answers, never to another built-in domain or to ${productName}'s own addresses but its support), within a per-minute and a daily recipient cap (429 BUILTIN_DOMAIN_LIMIT), screened like a new sender's mail. Once a domain of its own verifies it stops sending and answers 409 OWN_DOMAIN_VERIFIED, with the same address at that domain to use instead in error.details[0].suggestedFrom (and every verified domain in verifiedDomains).`;
