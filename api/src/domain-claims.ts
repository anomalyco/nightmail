import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, assertSesConfigured, id, isSimulatedSes, type Runtime, type DbExecutor } from './core.js';
import type { ReadyConnection } from './provider-credentials.js';
import { placementRoot } from './domain-registry.js';
import { connectionReady, detachedClaim, PROOF_LABELS, verifyImportedClaims, type ClaimState, type IdentityFacts, type ProofLabel, type TenantState } from './states.js';
import { addresses, productName } from './brand.js';
import type { ClaimsOnly, SendScope } from './send-scope.js';

export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
// Separate from the PSL: these platform-controlled trees also prohibit child claims.
// nightmail.email is the hosted built-in domains' parent (builtin-domain.ts): reserved even while NIGHTMAIL_BUILTIN_DOMAIN is unset.
const reservedRoots = `opensend.mx nightmail.email amazonses.com amazonaws.com github.io gitlab.io pages.dev workers.dev vercel.app netlify.app herokuapp.com onmicrosoft.com cloudfront.net
  azurewebsites.net web.app firebaseapp.com appspot.com blogspot.com fly.dev onrender.com ngrok.io`.split(/\s+/);
const notAllowed = () => new ApiError(422,'DOMAIN_NOT_ALLOWED','A public suffix or reserved domain cannot be claimed.','name');
// Report the same policy error for a bare TLD, before the ordinary DNS syntax validator rejects it.
export const claimName = z.preprocess(value=>{
  if (typeof value==='string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value.trim())) throw notAllowed();
  return value;
},domainName);
/** The installation's own domain: PUBLIC_URL's host (bane.mx in production). */
export const platformHost = (publicUrl:string) => new URL(publicUrl).hostname.toLowerCase().replace(/\.$/,'');
type PlatformOrigins = { publicUrl:string; previousOrigins?:readonly string[]; builtinDomain?:string };
/** Every domain the installation owns: PUBLIC_URL's host, then the hosts it served before (PREVIOUS_PUBLIC_URLS). After
 * a domain switch the earlier domain stays the platform's: its adopted claim keeps receiving (support@) and its names
 * stay unclaimable. Sender policy (platformPolicy) follows PUBLIC_URL's host only. */
export const platformHosts = (config:PlatformOrigins) => [...new Set([config.publicUrl,...(config.previousOrigins ?? [])].map(platformHost))];
const platformRoot = (name:string,hosts:readonly string[]) => hosts.find(host=>name===host || name.endsWith('.'+host));
// Operator hosts under the platform domain that not even its owning workspace may claim, receive on or send from,
// with everything below them: another installation's zone (dev.), release fixtures (e2e., e2e-va., e2e-trusted.),
// the shared inbound zone (in.), the Domain Connect key (domainconnect.) and service hosts (imap., smtp., tracker.). Add
// new platform hosts here before they go live. A release fixture holding its own e2e* claim keeps sending.
const fixtureLabel=/^e2e(?:-[a-z0-9-]+)?$/;
const platformLabel=/^(?:dev|e2e(?:-[a-z0-9-]+)?|in|domainconnect|imap|smtp|tracker)$/;
export function reservedPlatformName(name:string,config:PlatformOrigins) {
  return platformHosts(config).some(host=>name.endsWith('.'+host) && platformLabel.test(name.slice(0,-host.length-1).split('.').at(-1)!));
}
/** The mailboxes a certificate authority may use to validate the platform domain (CA/B BR 3.2.2.4.4, and root@).
 * Nightmail never creates them automatically: only an inbox someone creates on purpose receives that mail. */
export function platformValidationMailbox(address:string,hosts:string|readonly string[]|null) {
  const [local='',domain='']=address.toLowerCase().split('@');
  return !!platformRoot(domain,hosts===null ? [] : typeof hosts==='string' ? [hosts] : hosts) && /^(?:admin|administrator|hostmaster|postmaster|webmaster|root)$/.test(local.replace(/\+.*$/,''));
}
type PlatformConfig = Pick<Runtime['config'],'multiTenant'|'regionalSending'|'platformDomainWorkspace'|'publicUrl'>;
/** Only the operator-configured workspace owns the platform domain; every other workspace is always refused. Its
 * sending policy lives in regional_sender, so it needs regional sending. */
export const platformDomainOwner = (config:Omit<PlatformConfig,'publicUrl'>,workspace:string) =>
  config.multiTenant && config.regionalSending===true && !!config.platformDomainWorkspace && config.platformDomainWorkspace===workspace;
/** The sender policy every regional_sender call applies (migration 107): read from the running configuration, so
 * changing or removing NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE takes effect on the next send and the next dispatch. */
export const platformPolicy = (config:PlatformConfig) => config.multiTenant ? JSON.stringify({host:platformHost(config.publicUrl),
  owner:config.regionalSending===true ? config.platformDomainWorkspace ?? null : null,reserved:platformLabel.source,fixtures:fixtureLabel.source}) : null;
export async function claimNameAllowed(name:string,config:PlatformOrigins,platformOwner=false) {
  const hosts=platformHosts(config), platform=!!platformRoot(name,hosts);
  // The built-in domains' parent and every name under it are claimed only as built-in domains (builtin-domain.ts).
  const builtin=config.builtinDomain, underBuiltin=!!builtin && (name===builtin || name.endsWith('.'+builtin) || builtin.endsWith('.'+name));
  return name.includes('.') && !underBuiltin && (platform ? platformOwner && !reservedPlatformName(name,config) : !hosts.some(host=>host.endsWith('.'+name)))
    && !reservedRoots.some(root=>name===root || name.endsWith('.'+root)) && (await placementRoot(name)).root!==null;
}
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
// A hosted workspace has exactly one connection, so the region may be omitted and defaults to it.
/** `audit` builds the domain.create audit row from the reservation (`reserved`), written in the same statement for a new claim only. */
export async function reserveClaim(runtime: Runtime, workspace: string, name: string, region?: string, audit?: (reserved: SQL) => SQL) {
  const owner=platformDomainOwner(runtime.config,workspace), root=platformRoot(name,platformHosts(runtime.config));
  if (!await claimNameAllowed(name,runtime.config,owner)) throw notAllowed();
  // The platform domain's SES identity predates every claim and carries no claim tag: only the operator's adoption
  // (scripts/adopt-platform-domain.ts) creates the root's claim, and nothing under it is claimed before that.
  // Re-adding the root afterwards is idempotent.
  if (owner && root && !(await runtime.db.execute(sql`SELECT FROM domain_claims WHERE workspace_id=${workspace} AND name=${root} AND identity ? 'adopted'`)).rowCount)
    throw new ApiError(409,'OPERATOR_ADOPTION_REQUIRED','An operator must adopt the platform domain’s existing SES identity first.','name');
  assertSesConfigured(runtime);
  // The statement's snapshot predates the function's own insert, so a brand-new claim joins to nothing: that is
  // exactly its start state. A retried or reconnected claim existed before and joins to its current states.
  const reserve = regionalSending(runtime) ? sql`${sql.identifier(runtime.config.trustedPool?'reserve_placed_claim':'reserve_regional_claim')}(${workspace},${name},${region ?? null},${id('dom')})` : sql`reserve_domain_claim(${workspace},${name},coalesce(${region ?? null}::text,(SELECT region FROM provider_connections pc WHERE workspace_id=${workspace} AND ${connectionReady()})),${id('dom')})`;
  // One reservation, one statement. The profiler never gates or runs inside the create route.
  const shadow = runtime.config.multiTenant && runtime.config.placementShadow, materialized = shadow || !!audit;
  const row = (await runtime.db.execute<{connection: (ReadyConnection & { region: string; tenant_state: TenantState }) | null; token: string | null; id: string; claim: (ClaimState & { identity: IdentityFacts | null; proof_label: ProofLabel; created_at?: string; ever_proven?: boolean }) | null; fresh: boolean; recovering: boolean; error_code: string | null; reserved_at: string}>(
    sql`${materialized ? sql`WITH reserved AS MATERIALIZED (SELECT * FROM ${reserve})` : sql``}${shadow ? sql`, queued AS (
      INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.placement:'||id,'domain.placement',${workspace},jsonb_build_object('domainId',id)
      FROM reserved WHERE fresh AND id IS NOT NULL AND error_code IS NULL AND connection->>'kind'='shared' ON CONFLICT DO NOTHING)` : sql``}${audit ? sql`, audited AS (${audit(sql`reserved`)})` : sql``}
      SELECT r.connection,r.token,r.id,r.fresh,r.error_code,NOT r.fresh OR dc.token IS NOT NULL AS recovering,CASE WHEN dc.connection_id=r.connection->>'id' THEN to_jsonb(dc) END AS claim,now() AS reserved_at
      FROM ${materialized ? sql`reserved` : reserve} r
      LEFT JOIN domain_claims dc ON dc.token=r.token`)).rows[0]!;
  if (!row.connection) throw new ApiError(409,'CONNECTION_REQUIRED','Set up a sending connection for this workspace and region.');
  if (row.error_code==='OPERATOR_ADOPTION_REQUIRED') throw new ApiError(409,row.error_code,'An operator must reattest this retained sending identity.');
  if (row.error_code==='DOMAIN_REGION_CONFLICT') throw new ApiError(409,row.error_code,'The domain already has a different sending binding.','region');
  if (row.error_code==='POOL_PLACEMENT_MANAGED') throw new ApiError(422,row.error_code,`Hosted sending placement is managed by ${productName}.`,'region');
  if (row.error_code==='DOMAIN_LIMIT_REACHED') throw await domainLimitReached(runtime.db,workspace);
  if (row.error_code==='DOMAIN_CLAIM_EXPIRED') throw new ApiError(409,row.error_code,'The 72-hour ownership window expired. Remove the domain and add it again.');
  if (!row.token || !row.id) throw domainClaimed();
  return { ...row, connection: row.connection, token: row.token, claim: row.claim ?? { sending_state: 'pending', receiving_state: 'off', receiving_host: null, lost_since: null, receiving_lost_since: null, identity: null, proof_label: PROOF_LABELS[0], created_at: row.reserved_at, ever_proven: false } }; // A new claim's created_at is this transaction's now(), its proof_label the column default.
}

/**
 * Another workspace has proven this name, or one above or below it. What the domain's owner can do about it: an exclusive
 * claim is released once its ownership records have been gone for 30 days (operations.ts expireDomainClaims).
 */
export const domainClaimed = () => new ApiError(409, 'DOMAIN_CLAIMED', `Another workspace has verified this domain, or one above or below it. If the domain is yours, remove that workspace's records from your DNS: its ownership TXT record (_${PROOF_LABELS[0]}.<domain>, or ${PROOF_LABELS.slice(1).map(label => '_' + label).join(' or ')} on older setups) and its DKIM CNAME records under _domainkey. The claim is released about 30 days after both are gone. To release it sooner, write to ${addresses.support}.`);
/** Whether the workspace sends through its own AWS account: its identities live in that account's SES, so no domain total applies (migration 355). */
export const byoWorkspace = (workspace: string) => sql`EXISTS (SELECT FROM provider_connections WHERE workspace_id=${workspace} AND kind='byo')`;
/** Domains the workspace holds and how many it may hold: 100 unless an operator set another limit, and no total (null) with its own AWS account. */
export const domainQuota = async (db: DbExecutor, workspace: string) => (await db.execute<{ used: number; limit: number | null; unproven: number }>(sql`SELECT count(*)::int AS used,
  count(*) FILTER (WHERE NOT ever_proven)::int AS unproven,CASE WHEN ${byoWorkspace(workspace)} THEN NULL ELSE workspace_domain_limit(${workspace}) END AS "limit" FROM domain_claims WHERE workspace_id=${workspace} AND NOT ${builtinClaim()}`)).rows[0]!;
/** A workspace's built-in domain (builtin-domain.ts), which no domain total or unproven limit counts. */
export const builtinClaim = (dc: SQL = sql`domain_claims`) => sql`coalesce(${dc}.identity ? 'builtin',false)`;
/** How long a new workspace's built-in domain counts as ready while the request that made the workspace still sets it up. */
export const BUILTIN_SETUP_GRACE_SECONDS = 60;
/**
 * Whether the built-in claim `dc` is still being set up by the request that made its workspace (startHostedMail, about
 * 5 s): pending, its fallback job marked by that request and under BUILTIN_SETUP_GRACE_SECONDS old, its parent healthy.
 * Meanwhile GET /v1/me says it sends, and a send from it waits for it (awaitBuiltinSetup) instead of being refused.
 */
export const builtinSettingUp = (dc: SQL, parent: string) => sql`(${dc}.sending_state='pending' AND EXISTS (SELECT FROM jobs j WHERE j.id='domain.builtin:'||${dc}.workspace_id
  AND j.status IN ('pending','running') AND j.payload ? 'inline' AND j.created_at>now()-make_interval(secs=>${BUILTIN_SETUP_GRACE_SECONDS}))
  AND EXISTS (SELECT FROM builtin_parent p WHERE p.name=${parent} AND p.ok))`;
/** The refusal names whichever limit was reached: the workspace's total (its own, which an operator can change) or the 10 unproven domains. */
export const domainLimitError = (used: number, limit: number | null) => new ApiError(409, 'DOMAIN_LIMIT_REACHED', limit !== null && used >= limit
  ? `This workspace has ${used.toLocaleString('en-US')} of its ${limit.toLocaleString('en-US')} domains. Remove a domain first, or ask ${productName} support for a higher limit.`
  : 'A workspace can have at most 10 domains whose ownership is not yet proven. Verify or remove one first.');
const domainLimitReached = async (db: DbExecutor, workspace: string) => { const q = await domainQuota(db, workspace); return domainLimitError(q.used, q.limit); };

export async function importByoClaims(db: DbExecutor, connection: { id: string; workspace_id: string; region: string }, domains: { name: string; ses: IdentityFacts['ses'] }[]) {
  if (!domains.length) return;
  // Two statements in the caller's transaction: the update can see the function's new claims.
  // These reservations are account-scoped and never displace or block another workspace's domain.
  await db.execute(sql`SELECT r.token FROM jsonb_to_recordset(${JSON.stringify(domains.map(d => ({ name: d.name, id: id('dom') })).sort((a,b) => a.name.localeCompare(b.name)))}::jsonb) d(name text,id text)
    CROSS JOIN LATERAL reserve_domain_claim(${connection.workspace_id},d.name,${connection.region},d.id,${connection.id}) r`);
  await db.execute(verifyImportedClaims(connection.id, domains));
}

// Shared tail for every claim release (single domain delete, workspace disconnect): the caller's
// `released` CTE yields (name, token); receiving stops and the claim's polls (verify, MX, the setup DNS check) are canceled.
// Every receiving host of the domain stops: its own row (found by name, as a domain added again finds it) and the hosts
// beside it (found by domain; the statement's snapshot still has the operation_domains row it deletes).
export const releasedClaimCleanup = (wid: string) => sql`retired AS (UPDATE mailbox_domains m SET status='disabled',lost_since=NULL,updated_at=now() FROM released r WHERE m.workspace_id=${wid} AND m.status<>'disabled'
    AND (m.name=r.name OR m.domain_id IN (SELECT d.id FROM operation_domains d WHERE d.workspace_id=${wid} AND d.name=r.name))),
  canceled AS (DELETE FROM jobs USING released r WHERE jobs.workspace_id=${wid} AND jobs.id IN ('domain.verify:'||r.token,'domain.mx:'||r.token,'domain.setupCheck:'||r.token,'domain.linkCheck:'||r.token) AND jobs.type IN ('domain.verify','domain.mx','domain.setupCheck','domain.linkCheck') AND jobs.status IN ('pending','running'))`;
// Keep independently owned exclusive claims. Send-only imports/adoptions have no TXT proof;
// their authority cannot survive disconnect. The operator's retained ARN journal does survive.
export const releaseConnectionClaims = (wid: string, target: SQL) => sql`target AS (${target}), detached AS (UPDATE domain_claims dc SET ${detachedClaim}
    FROM target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND dc.claim_scope<>'account' AND NOT coalesce(dc.identity ?| array['adopted','builtin'],false) RETURNING dc.name,dc.token),
  forgotten AS (DELETE FROM domain_claims dc USING target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND (dc.claim_scope='account' OR dc.identity ?| array['adopted','builtin']) RETURNING dc.name,dc.token),
  released AS (SELECT * FROM detached UNION ALL SELECT * FROM forgotten),
  dropped AS (DELETE FROM operation_domains d USING released r WHERE d.workspace_id=${wid} AND d.name=r.name), ${releasedClaimCleanup(wid)}`;
// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region. Hosted sender proof is required even when SES is simulated.
export const regionalSending = (runtime: Pick<Runtime,'config'>) => runtime.config.multiTenant && runtime.config.regionalSending === true;
// Dispatch/recovery readers always understand a persisted binding, including on flag rollback.
export const sendingConnections = (runtime: Runtime) => sql.identifier(`regional_${isSimulatedSes(runtime) ? 'simulated' : 'sending'}_connections`);
export type SendingBinding = { domain: string; connection: string; generation: number; account:string; topic:string|null };
export type SenderRoute = { region: string; verified: boolean; binding: SendingBinding; connection: (ReadyConnection & { region:string; tenant_state:TenantState; pause_reason:string|null }) | null; platform_refused?: boolean };
/** Every sender check (admission, campaigns, mailbox replies, dispatch) reads its closest claim through this call,
 * which also applies the running platform-domain policy; a refused route is never verified. It locks that claim, so a
 * send transaction reads it only under its send locks (send_admission takes the settings row before it, migration 323). */
export const regionalSender = (runtime:Runtime,_locks:SendScope|ClaimsOnly,wid:SQL|string,host:SQL|string) => sql`regional_sender(${wid},${host},${isSimulatedSes(runtime)},${platformPolicy(runtime.config)}::jsonb)`;
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL) =>
  sql`EXISTS (SELECT FROM verified_sending_domains v WHERE v.workspace_id=${workspace} AND v.region=${region} AND ${within(host,sql`v.name`)})`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'The from address must use a domain verified in this workspace and region, or a subdomain of one. Add the domain with POST /v1/domains, publish its DNS records, and send once GET /v1/domains/{id} reports sending: "verified".', 'from');
