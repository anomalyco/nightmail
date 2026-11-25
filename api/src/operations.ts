import { DASHBOARD_CACHE_NOTE, dashboardRead } from './dashboard-cache.js';
import { talliesEnabled } from './sending-tallies.js';
import { registerSenderScore } from './sender-score.js';
import { auditContext, auditInsert, recordAudit } from './audit.js';
import { registerUsage } from './usage.js';
import { approvalField, approvalTie, tieAllows, tiedNextStep } from './approval-ties.js';
import { matchesAdoption } from './adopted-identity.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { X509Certificate, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { actor, ApiError, assertSesConfigured, chargeBudget, denied, requiredOf, unrestrictedRequired, assertSharedAccount, isSimulatedSes, digest, errors, getSes, id, rowId, IdParams, json, lazyModule, log, logError, ModuleLoadError, notFound, PageQuery, preloadSesTransport, randomSecret, redactCapabilityData, region, response, security, senderDomainAllowed, simulatedTopic, taggedEmailId, wrapModuleLoad, type App, type Actor, type Ctx, type Config, type Database, type DbExecutor, type JobHandler, type Permission, type Runtime } from './core.js';
import { chargeManualDelivery, claimedWithWebhooks, enqueue, JobDeferred, WEBHOOK_ATTEMPTS, retryDatabaseFailures, webhookClaimCtes } from './jobs.js';
import { applyClaim, connectionReady, domainHosts, receivingSetup, type ReceivingSetup, hostGraceStart, identityOnly, LOST_GRACE_MS, poolReceives, poolSends, transitionClaim, type ClaimEvidence, type ClaimState, type HostEvidence, type HostStatus, type HostWrite, type IdentityFacts, type TenantState, PROOF_LABELS, proofRecordName, type ProofLabel } from './states.js';
import { jobs } from './db/core.js';
import { contacts, mergeSuppression } from './db/audience.js';
import { lasting, RECEIVING_HOST_CHANGE, EmailEventData, withoutVerdict, WEBHOOK_CHANGE, webhookUrlHint, WebhookUrlHint, readCursor, nextCursor, budgetedRead, readLimit, readLimitNote } from './core.js';
import { emails } from './db/sending.js';
import { sesRegions } from './db/ses-regions.js';
import { getRegionSettings, resolveRegionRuntime, withRegionSettings } from './ses-region-state.js';
import { claimName, domainName, domainQuota, platformDomainOwner, platformHosts, releaseConnectionClaims, releasedClaimCleanup, reserveClaim, reservedPlatformName } from './domain-claims.js';
import { loadRegistries } from './domain-registry.js';
import { discover, groupIds, pendingGroups, signedApply, verifyReturn } from './domain-connect.js';
import { dmarcView, localDmarc, observeDmarc, type DmarcObservation } from './dmarc.js';
import { forDelivery, workspaceConnection, type ReadyConnection } from './provider-credentials.js';
import { byoEnabled } from './byo-pilot.js';
import { awsError, byoFeedbackUrl, claimTenantName, feedbackUrl, mxOwnerTag, POOL_INSTALLATION } from './ses-setup.js';
import type { RoutineIngress } from './sending.js';
import type { SetupCheck } from './record-check.js';
import type { FeedbackItem } from './core.js';
import { realDestination } from './hosted-sending.js';
import { webhookSecretBinding as mailboxSecretBinding } from './mailbox-events.js';
import { mailboxDomains, endpoints, type MxReport } from './db/mailbox.js';
import { checkMx,expectedMx } from './mailbox-dns.js';
import { baneRecordIssue, baneRecordUse, defaultReceivingHost, establishedHost, hostOwners, inspectReceivingHost, observeReceiving, refusedCodes, takenIssue, type DomainObservation, type ReceivingHostRow, type ReceivingIssue } from './receiving-host.js';
import { deliveryAttempts, deliveries, domainClaims, domains, events, eventTypes, snsReceipts, unsubscribeTokens, webhooks, webhookSecretAudit, type PublishedEvent, type EventType } from './db/operations.js';
import { clientIpHeader, productName, requestHeaderNames, webhookTestHeaders, webhookUserAgent } from './brand.js';
import { hasTags, tagKey, TAG_PREFIX } from './resource-tags.js';
import { PostalAddress, postalAddressText, unsubscribePageLink } from './outbound-content.js';
export type { PublishedEvent } from './db/operations.js';

const RegionalAccepted = z.object({ operationId: z.string(), regions: z.array(z.string()) });
type Sesv2Mod = typeof import('@aws-sdk/client-sesv2');
const loadOperationsSesv2 = lazyModule((): Promise<Sesv2Mod> => import('@aws-sdk/client-sesv2'));
const loadSendingOps = lazyModule(() => import('./sending.js'));

const now = () => new Date().toISOString();
const scoped = (table: { workspaceId: AnyPgColumn }, a: Pick<Actor, 'workspaceId'>) => eq(table.workspaceId, a.workspaceId);
const eventSchema = z.object({ id: z.string(), type: z.enum(eventTypes), createdAt: z.string(), workspaceId: z.string(), region: z.string().nullable(), data: EmailEventData }).openapi('Event');
const reservedHeader = /^(?:host|content-length|content-type|content-encoding|transfer-encoding|connection|keep-alive|te|trailer|upgrade|http2-settings|expect|cookie|user-agent|webhook-id|webhook-timestamp|webhook-signature|nightmail-test|bane-test|opensend-test)$|^proxy-/i;
export const WebhookHeaders = z.array(z.object({
  name: z.string().min(1).max(64).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(name => !reservedHeader.test(name), 'Reserved webhook header.'),
  value: z.string().max(2048).regex(/^[\t\x20-\x7e\x80-\xff]*$/, 'Use single-line HTTP field bytes.'),
}).strict()).max(10).superRefine((headers, ctx) => {
  const names = new Set(headers.map(h => h.name.toLowerCase()));
  if (names.size !== headers.length) ctx.addIssue({ code: 'custom', message: 'Header names must be unique regardless of case.' });
  if (headers.reduce((size, h) => size + h.name.length + Buffer.byteLength(h.value), 0) > 8192) ctx.addIssue({ code: 'custom', message: 'Header names and values exceed 8 KiB.' });
}).describe(`Write-only custom HTTP request headers, e.g. Authorization. Up to 10 unique names (case-insensitive) and 8192 UTF-8 bytes of names and values. Omit on update to keep, supply the complete list to replace, or [] to clear. Transport, Cookie and ${productName} delivery headers are reserved.`);
export const WebhookHeaderViews = z.array(z.object({ name: z.string(), hint: z.string().optional(), updatedAt: z.string().datetime().optional() })).describe('Configured names only for readers. Managers also see a masked hint and the time the header list was last replaced.');
const webhookSchema = z.object({ id: z.string(), url: WebhookUrlHint, description: z.string(), eventTypes: z.array(z.enum(eventTypes)), regions: z.array(z.string()).nullable(), paused: z.boolean(), headers: WebhookHeaderViews, createdAt: z.string(), updatedAt: z.string(), approval: approvalField }).openapi('Webhook');
const webhookInput = z.object({ url: z.string().url().max(2048), description: z.string().max(500).default(''), eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).default(['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed']), regions: z.array(z.string()).min(1).max(40).nullable().optional(), paused: z.boolean().default(false), headers: WebhookHeaders.optional() }).openapi('CreateWebhook');
const webhookPatch = webhookInput.partial().extend({ description: z.string().max(500).optional(), eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).optional(), paused: z.boolean().optional() }).openapi('UpdateWebhook');
const secretSchema = z.object({ secret: z.string() }).openapi('WebhookSecret');
const deliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), payload: eventSchema, synthetic: z.boolean(), status: z.enum(['pending', 'delivered', 'failed', 'paused']), attemptCount: z.number(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('WebhookDelivery');
const attemptSchema = z.object({ id: z.string(), deliveryId: z.string(), statusCode: z.number().nullable(), error: z.string().nullable(), durationMs: z.number(), createdAt: z.string() }).openapi('WebhookAttempt');
const dnsState = z.enum(['pending','verified']);
const publicDns = z.object({ state:z.enum(['found','missing','wrong_value']).describe('found: public DNS has this record as listed (it may still take SES a few minutes to verify). missing: nothing of this type at the name. wrong_value: the name has a record of this type with another value.'), values:z.array(z.string()).describe('wrong_value only: what public DNS has at the name instead (at most 5). Empty otherwise.'), checkedAt:z.string() })
  .nullable().optional().describe('For pending sending and MAIL FROM records: what public DNS (Cloudflare 1.1.1.1) shows for this record. verifyDomain looks it up now (answers cached up to 30 seconds). Other reads show the last background check, which runs every 15 to 60 minutes for a Hosted domain still pending an hour after it was added. Null when DNS did not answer in time; absent before any check and on other records.');
const dnsRecord = z.object({ name:z.string(), type:z.enum(['CNAME','TXT','MX']), value:z.string(), priority:z.number().optional(), purpose:z.enum(['sending','receiving','mail_from','dmarc']), status:dnsState, note:z.string().optional(), publicDns });
const dmarcSchema=z.object({status:z.enum(['missing','invalid','none','quarantine','reject']),record:z.string().nullable(),source:z.string().nullable().describe('Domain publishing the effective TXT record; may be the organizational domain.'),adkim:z.enum(['r','s']),aspf:z.enum(['r','s']),alignment:z.object({dkim:z.boolean(),spf:z.boolean()})}).nullable().describe('Last DNS and SES observation for this From domain. Null when unchecked, unavailable or stale. Alignment describes configured identifiers, not a delivery verdict.');
export const receivingIssueSchema = z.object({
  code: z.enum(['cname','foreign_mx','split','wildcard','bane_record','host_taken','claimed','delegated','mx_missing','wrong_region','null_mx','proof_stale','identity_stale']).describe(`cname: the host is a CNAME, so it cannot have an MX (RFC 1034). foreign_mx: another provider receives its mail. split: other MX records share its mail. wildcard: a *.domain CNAME or MX answers for it. bane_record: it is one of ${productName}\u2019s own names (custom MAIL FROM, ownership TXT, DKIM). host_taken: another claim, possibly in another workspace, receives on it. claimed: another workspace claimed it, or a name between it and this domain, in any scope. delegated: it is a delegated zone with its own NS records. claimed and delegated hosts never receive here. mx_missing: its MX disappeared after setup. wrong_region and null_mx: its MX points elsewhere in SES or refuses mail. proof_stale / identity_stale: the ownership TXT proof or the SES verification is out of date.`),
  host: z.string(), blocking: z.boolean().describe('True when receiving there cannot work until DNS or the choice changes.'), message: z.string(),
  provider: z.string().nullable().optional(), target: z.string().nullable().optional().describe('The existing CNAME target.'), suggestion: z.string().nullable().optional().describe('A free subdomain to use instead.'),
}).openapi('ReceivingIssue');
const domainSchema = z.object({ id: z.string(), name: z.string(), region: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), dmarc:dmarcSchema, ready: z.boolean(), sending:dnsState, receiving:dnsState, mailFromDomain: z.string().nullable(), mailFromStatus: z.string().nullable(), dnsStatus: z.enum(['available', 'unavailable']), dnsUnavailableReason: z.string().nullable(), dns: z.array(dnsRecord),
  dnsHost: z.object({ name: z.string().describe('The provider, e.g. Cloudflare, Vercel, Route 53, GoDaddy or Namecheap.'), zone: z.string().describe('The zone it hosts, which record names are relative to there.'), url: z.string().nullable().describe('The provider\'s DNS page for the zone, when it has a known address.') })
    .nullable().optional().describe(`Where this domain\u2019s DNS is hosted, from its zone\u2019s NS records, alongside publicDns: null when the provider is not one ${productName} recognizes.`),
  releasesAt: z.string().nullable().optional().describe('Hosted only: when this domain is released if its records are still unproven (72 hours after it was added). Null once ownership has been proven.'),
  receivingIssue: receivingIssueSchema.nullable().optional().describe('Hosted only: receiving needs attention. Set by the DNS checks that run when a receiving host is suggested or chosen, on Check now and in the hourly recheck. Null when the receiving record is clear.') }).openapi('DomainReadiness');
const accountSchema = z.object({ region: z.string(), productionAccess: z.boolean(), sendingEnabled: z.boolean(), enforcementStatus: z.string(), quota: z.object({ max24HourSend: z.number(), maxSendRate: z.number(), sentLast24Hours: z.number() }) }).openapi('SesAccount');
const settingsSchema = z.object({ name: z.string(), postalAddress: z.string().nullable().describe('The postal address every campaign footer and marketing send shows under Unsubscribe; null until one is set. Campaigns can\'t be sent or scheduled without it.'),
  requiredNotices: z.boolean().describe('Whether campaigns in this workspace may be required notices (requiredNotice), which also reach people who unsubscribed from marketing. Only an operator turns this on.') }).openapi('WorkspaceSettings');
const requiredNoticesOf = (workspaceId: string) => sql<boolean>`coalesce((SELECT required_notices FROM workspaces WHERE id=${workspaceId}),false)`;
const queuedSchema = z.object({ id: z.string(), status: z.literal('pending') }).openapi('QueuedWebhookDelivery');
const deletedSchema = z.object({ deleted: z.boolean() }).openapi('WebhookDeleted');
const regionQuery = z.object({ region: z.string().optional() }).openapi('RegionQuery');
const listSchema = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
export const DomainPage = z.object({ data: z.array(domainSchema), nextCursor: z.string().nullable(),
  quota: z.object({ used: z.number().int().describe('Domains in the workspace, across every region and page.'), limit: z.number().int().describe(`How many domains the workspace may have: 100 unless ${productName} set another limit on request.`) }).optional()
    .describe('Hosted only, and only for credentials without domain restrictions. Absent when the workspace sends through its own AWS account, which has no domain total. Adding a domain past the limit fails with DOMAIN_LIMIT_REACHED; at most 10 of them may be unproven at once.') }).openapi('DomainPage');
export function workspaceActor(c: Ctx, permission: Permission = 'read') { const a = actor(c, permission); if (a.domains.length) throw unrestrictedRequired('Workspace-wide operations require a key without domain restrictions.', requiredOf(c, permission)); return a; }
// Like API keys, webhooks are set up, changed and removed by lasting credentials: a temporary agent token reads them and
// their deliveries, and can test or retry a delivery, but does not create, change or delete them or read their signing
// secrets.
function webhookManager(c: Ctx) {
  const a = workspaceActor(c, 'manage');
  lasting(c, WEBHOOK_CHANGE);
  return a;
}
// A webhook that an approval sets up, changes or rotates the signing secret of is tied to the approval, like the keys it
// creates: it is posted to only while the approval is active (webhookJob) and is held when the approval is removed
// (migration 198). The approval is read again here, inside the write's transaction, and held (shared lock) until the
// write commits: a removal under way finishes first and the write is refused; one that starts later waits for the
// write and then holds the webhook. It is taken before the webhook row, the order a removal takes the two in.
async function ownWebhook(c: Ctx, tx: DbExecutor, a: Actor, webhookId: string) {
  if (!a.grantId) return;
  const { getMcpGrantActor, approvalUse } = await wrapModuleLoad(() => import('./mcp-auth.js'));
  const grant = await getMcpGrantActor(c.env, 'mcp_' + a.grantId, a.workspaceId, tx, approvalUse(a));
  if (grant?.workspaceId !== a.workspaceId || !grant.permissions.includes('manage')) throw new ApiError(401, 'AUTH_INVALID', 'The MCP approval behind this request was revoked while it ran. Nothing was changed.');
  await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${a.grantId},${a.workspaceId},'webhook',${webhookId}) ON CONFLICT DO NOTHING`);
}
// A held webhook is marked (reconfirm). Its URL is write-only, so nothing is posted to it, a test included, until
// the URL is sent again. Sending the URL takes the webhook over: the mark goes, and so does the signing secret the
// approval was given (on create or rotate).
const webhookNeedsUrl = () => new ApiError(409, 'WEBHOOK_URL_REQUIRED', 'Deliveries were held when the approval that set up or changed this webhook was removed, and its URL is write-only. Send the URL again to resume; the webhook then gets a new signing secret.', 'url');
// The refusal names the domain only when the caller sent its name (`named`): a domain loaded by ID stays unnamed to a key
// whose scope doesn't cover it.
function allowedDomain(a: Actor, name: string, named = false) { if (!senderDomainAllowed(a.domains, name)) throw denied('DOMAIN_NOT_ALLOWED', 'The API key is not authorized for this domain or its parent domain.', { permission: 'configuration', ...(named ? { scope: `domain:${name}` as const } : {}) }); }
async function sesCall<T>(operation: (sesv2: Sesv2Mod) => Promise<T>,creatingIdentity=false): Promise<T> {
  const sesv2 = await loadOperationsSesv2();
  try { return await operation(sesv2); } catch (error) {
    if (error instanceof ModuleLoadError || error instanceof ApiError) throw error;
    const provider = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const name = provider?.name ?? '', status = provider?.$metadata?.httpStatusCode;
    if (creatingIdentity && name==='LimitExceededException') {
      log('error',{code:'SES_IDENTITY_QUOTA_EXHAUSTED',operation:'CreateEmailIdentity',message:'Request additional regional SES identity capacity.'});
      throw new ApiError(409,'SES_IDENTITY_QUOTA_EXHAUSTED','The regional SES identity quota is full. An account operator must request a quota increase before adding another domain.');
    }
    if (status === 403 || /AccessDenied|Unauthorized|InvalidClientTokenId|UnrecognizedClient|ExpiredToken/.test(name)) throw new ApiError(403, 'SES_ACCESS_DENIED', 'AWS denied the SES operation. Check deployment credentials and IAM permissions.');
    if (status === 429 || /TooManyRequests|Throttl|LimitExceeded/.test(name)) throw new ApiError(429, 'SES_RATE_LIMITED', 'The SES control-plane quota was exceeded. Retry after a short delay.', undefined, true);
    if (status === 404 || name === 'NotFoundException') throw new ApiError(404, 'SES_IDENTITY_NOT_FOUND', 'The requested identity does not exist in this SES region.');
    if (status === 409 || name === 'AlreadyExistsException') throw new ApiError(409, 'SES_IDENTITY_EXISTS', 'The identity already exists in this SES region.');
    if (status === 400 || name === 'BadRequestException') throw new ApiError(422, 'SES_INVALID_REQUEST', 'SES rejected the operation. Check the identity, region, and account configuration.');
    throw new ApiError(503, 'SES_UNAVAILABLE', 'SES could not complete the operation. Check service availability and deployment connectivity.', undefined, true);
  }
}
const REVEALS_PER_MINUTE = 10;
/** One row in webhook_secret_audit (migration 220) for each hand-out of a signing secret. */
const recordSecret = (db: Pick<Database, 'insert'>, a: Actor, webhookId: string, action: 'created' | 'revealed' | 'rotated') =>
  db.insert(webhookSecretAudit).values({ workspaceId: a.workspaceId, id: id('wsa'), webhookId, action, actorKeyId: a.keyId, credential: a.credential ?? 'apiKey', actorEmail: a.email ?? null });
async function metadata(runtime: Runtime, row: typeof webhooks.$inferSelect, a: Actor) {
  const { encryptedSecret: _, encryptedHeaders, workspaceId: _w, reconfirm: _r, ...value } = row;
  return { ...value, url: webhookUrlHint(value.url), headers: await webhookHeaderViews(runtime, encryptedHeaders, secretBinding(row, row.id), a.permissions.includes('manage')),
    approval: await approvalTie(runtime, row.workspaceId, ['webhook'], row.id) };
}

// The single endpoint rule for sending and inbound webhooks: public HTTPS DNS names only, never
// credentials, IP literals, internal TLDs or this installation itself.
export function webhookUrl(runtime: Pick<Runtime, 'config'>, value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'A public HTTPS webhook URL is required.', 'url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal|invalid|test|home|lan|arpa)$/.test(host) || host.endsWith('.')) throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'Webhook endpoints must use public HTTPS DNS names without credentials or fragments.', 'url');
  const own = [runtime.config.publicUrl, ...(runtime.config.previousOrigins ?? []), runtime.config.sesFeedbackUrl].flatMap(value => value ? [new URL(value).hostname.toLowerCase().replace(/\.$/, '')] : []);
  if (own.includes(host)) throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'Webhook endpoints cannot point back at this installation.', 'url');
  return url.toString();
}
const hookTimeouts=new Map<string,{count:number;until:number}>();
/** The one outbound transport for sending and inbound webhooks: no redirects, five-second budget, response bodies discarded. */
export async function postWebhook(runtime: Runtime, url: string, headers: Record<string, string>, body: string, encryptedHeaders: string | null, binding: string, timeoutSeconds=5) {
  const key=await digest(binding+'\n'+url),prior=hookTimeouts.get(key);
  // Nothing leaves while the breaker is open: return only this claim's attempt. Resetting the count let every delivery to an
  // endpoint that always times out retry forever (three real tries per window, the rest deferred back to attempt 0).
  if(prior && prior.count>=3 && prior.until>Date.now())throw new JobDeferred(new Date(prior.until).toISOString(),undefined,true);
  const custom = await readWebhookHeaders(runtime, encryptedHeaders, binding);
  const merged = new Headers();
  for (const { name, value } of custom.headers) if (!reservedHeader.test(name)) merged.set(name, value);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set('Content-Type', 'application/json');
  const init = { method: 'POST' as const, headers: Object.fromEntries(merged), body, signal: AbortSignal.timeout(timeoutSeconds*1000) };
  try {
    const result=runtime.webhookFetch?await runtime.webhookFetch(url,init):await fetch(url,{...init,redirect:'manual'});
    if(result instanceof Response) await result.body?.cancel();
    hookTimeouts.delete(key);return {status:result.status,retryAfter:result instanceof Response?result.headers.get('retry-after'):result.retryAfter};
  }catch(error){
    if(init.signal.aborted || error instanceof Error && error.name==='TimeoutError'){
      const last=hookTimeouts.get(key), count=1+(last && last.until>Date.now()?last.count:0);
      if(!last && hookTimeouts.size>=1024)hookTimeouts.delete(hookTimeouts.keys().next().value!);
      hookTimeouts.set(key,{count,until:Date.now()+30000+timeoutSeconds*1000});
    }
    throw error;
  }
}
async function encryptionKey(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'A 32-byte hexadecimal encryption key is required.');
  const bytes = unhex(value);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 16), key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], h => parseInt(h, 16));
export async function encrypt(runtime: Pick<Runtime, 'config'>, secret: string, binding: string) {
  const current = await encryptionKey(runtime.config.encryptionKey), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, current.key, new TextEncoder().encode(secret));
  return `v1.${current.id}.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
export async function decrypt(runtime: {config: Pick<Config, 'encryptionKey' | 'previousEncryptionKey'>}, ciphertext: string, binding: string) {
  const parts = ciphertext.split('.'), versioned = parts.length === 4 && parts[0] === 'v1';
  const [iv, value] = versioned ? parts.slice(2) : parts;
  const rotationRequired = () => new ApiError(503, 'KEY_ROTATION_REQUIRED', 'The webhook secret cannot be decrypted with configured keys. Restore its encryption key or rotate the webhook secret.');
  if ((!versioned && parts.length !== 2) || !/^[a-f0-9]{24}$/i.test(iv ?? '') || !/^(?:[a-f0-9]{2}){16,}$/i.test(value ?? '')) throw rotationRequired();
  const keys = [await encryptionKey(runtime.config.encryptionKey)];
  if (runtime.config.previousEncryptionKey) keys.push(await encryptionKey(runtime.config.previousEncryptionKey));
  for (const candidate of keys) {
    if (versioned && candidate.id !== parts[1]) continue;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv!), additionalData: new TextEncoder().encode(binding) }, candidate.key, unhex(value!))); } catch { /* Legacy envelopes may belong to the previous key. */ }
  }
  throw rotationRequired();
}
export function webhookSecret() { return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`; }
type HeaderList = z.infer<typeof WebhookHeaders>;
export async function encryptWebhookHeaders(runtime: Runtime, headers: HeaderList | undefined, binding: string) {
  if (headers === undefined) return undefined; // PATCH omission leaves the column untouched.
  return headers.length ? encrypt(runtime, JSON.stringify({ headers, updatedAt: now() }), `${binding}:headers`) : null;
}
async function readWebhookHeaders(runtime: Runtime, ciphertext: string | null, binding: string): Promise<{ headers: HeaderList; updatedAt: string }> {
  return ciphertext === null ? { headers: [], updatedAt: '' } : JSON.parse(await decrypt(runtime, ciphertext, `${binding}:headers`));
}
export async function webhookHeaderViews(runtime: Runtime, ciphertext: string | null, binding: string, manage: boolean) {
  const { headers, updatedAt } = await readWebhookHeaders(runtime, ciphertext, binding);
  return headers.map(({ name, value }) => manage ? { name, hint: '••••' + (value.length > 8 ? value.slice(-4) : ''), updatedAt } : { name });
}
export async function hmac(secret: string, value: string) { const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64'); if (!secret.startsWith('whsec_') || bytes.length !== 32) throw new ApiError(503, 'WEBHOOK_SECRET_ROTATION_REQUIRED', 'Rotate this endpoint secret to enable Standard Webhooks signatures.'); const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))).toString('base64'); }
const secretBinding = (a: Pick<Actor, 'workspaceId'>, webhookId: string) => `${a.workspaceId}:live:${webhookId}`;

// Installer-only, resumable rewrapping; no webhook signing secret is rotated or returned.
// Decryption failure aborts, leaving earlier successful updates safe to skip on rerun.
export async function reencryptWebhookSecrets(db: Database, config: Config): Promise<{ scanned: number; reencrypted: number; skipped: number; conflicted: number }> {
  const runtime = { config }, current = await encryptionKey(config.encryptionKey);
  const counts = { scanned: 0, reencrypted: 0, skipped: 0, conflicted: 0 };
  const currentEnvelope = new RegExp(`^v1\\.${current.id}\\.[a-f0-9]{24}\\.(?:[a-f0-9]{2}){16,}$`, 'i');
  const rewrap = async (ciphertext: string | null, aad: string) => ciphertext !== null && !currentEnvelope.test(ciphertext) ? encrypt(runtime, await decrypt(runtime, ciphertext, aad), aad) : undefined;
  const same = (column: AnyPgColumn, value: string | null) => value === null ? isNull(column) : eq(column, value);
  for (const table of [webhooks, endpoints]) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.select({ id: table.id, workspaceId: table.workspaceId, encryptedSecret: table.encryptedSecret, encryptedHeaders: table.encryptedHeaders, encryptedTarget: table === endpoints ? endpoints.encryptedTarget : sql<null>`NULL` }).from(table).where(cursor ? lt(table.id, cursor) : undefined).orderBy(desc(table.id)).limit(100);
      for (const row of rows) {
        counts.scanned++;
        const binding = table === webhooks ? secretBinding(row, row.id) : mailboxSecretBinding(row.workspaceId, row.id);
        // An endpoint's Slack or Discord URL or forward address (encrypted_target) is rewrapped with its secret and headers.
        const encryptedSecret = await rewrap(row.encryptedSecret, binding), encryptedHeaders = await rewrap(row.encryptedHeaders, `${binding}:headers`), encryptedTarget = await rewrap(row.encryptedTarget, `${row.workspaceId}:endpoint:${row.id}`);
        if (!encryptedSecret && !encryptedHeaders && !encryptedTarget) { counts.skipped++; continue; }
        // Neither a concurrent secret rotation nor a header or URL replacement may be overwritten.
        const updated = table === webhooks
          ? await db.update(webhooks).set({ encryptedSecret, encryptedHeaders, updatedAt: now() }).where(and(eq(webhooks.id, row.id), scoped(webhooks, row), same(webhooks.encryptedSecret, row.encryptedSecret), same(webhooks.encryptedHeaders, row.encryptedHeaders))).returning({ id: webhooks.id })
          : await db.update(endpoints).set({ encryptedSecret, encryptedHeaders, encryptedTarget, updatedAt: now() }).where(and(eq(endpoints.id, row.id), scoped(endpoints, row), same(endpoints.encryptedSecret, row.encryptedSecret), same(endpoints.encryptedHeaders, row.encryptedHeaders), same(endpoints.encryptedTarget, row.encryptedTarget))).returning({ id: endpoints.id });
        if (updated.length) counts.reencrypted++; else counts.conflicted++;
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  return counts;
}

// A webhook payload stored before the published event was built without the content screen's verdict (states.ts
// terminalEvents) may hold it: what a caller reads of the delivery log, and what is posted or posted again, never does.
const outwardEvent = <T extends { data: Record<string, unknown> }>(event: T): T => ({ ...event, data: withoutVerdict(event.data) });
function visibleDelivery(row: typeof deliveries.$inferSelect, a: Actor) {
  return deliverySchema.parse({ ...row, payload: outwardEvent(a.permissions.includes('manage') ? row.payload : { ...row.payload, data: redactCapabilityData(row.payload.data) }) });
}

export async function publishEvent(runtime: Runtime, event: PublishedEvent, wake = true): Promise<void> {
  if (!eventTypes.includes(event.type)) throw new ApiError(422, 'INVALID_EVENT_TYPE', 'Unknown webhook event type.');
  const readyJobs = await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(event).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return 0;
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, event), eq(webhooks.paused, false)));
    let count = 0;
    for (const endpoint of endpoints) {
      if (!endpoint.eventTypes.includes(event.type) || (endpoint.regions && event.region !== null && !endpoint.regions.includes(event.region))) continue;
      const deliveryId = rowId('whd');
      await tx.insert(deliveries).values({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event });
      await enqueue(tx, { type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } });
      count++;
    }
    return count;
  });
  if (wake && readyJobs > 0) try { await runtime.wake?.(readyJobs,'webhook'); } catch { log('warn', { eventId: event.id, code: 'QUEUE_WAKE_FAILED', message: 'The event is committed; the scheduler will recover pending deliveries.' }); }
}

export async function createUnsubscribeLink(runtime: Runtime, workspaceId: string, email: string) {
  const token = randomSecret('u_');
  return { url: `${runtime.config.publicUrl.replace(/\/$/, '')}/unsubscribe/${token}`, record: { tokenHash: await digest(token), workspaceId, email: email.trim().toLowerCase() } };
}
export async function unsubscribeUrl(runtime: Runtime, workspaceId: string, email: string, db: DbExecutor = runtime.db): Promise<string> {
  const link = await createUnsubscribeLink(runtime, workspaceId, email);
  await db.insert(unsubscribeTokens).values(link.record);
  return link.url;
}
const claimTag = tagKey('domain-claim');
type Readiness = z.infer<typeof domainSchema>;
type DomainRef = Pick<Readiness,'id'|'name'|'region'>;
type ProofTimes={receiving_proved_at?:Date|string|null;receiving_identity_at?:Date|string|null;receiving_proof_missed_at?:Date|string|null};
export type HostedDomain = DomainRef & ClaimState & ProofTimes & { setup_check: SetupCheck | null; connection: ReadyConnection & { tenant_state: TenantState;legacy?:boolean }; token: string; proof_label: ProofLabel; identity: IdentityFacts | null; claim_scope:'account'|'exclusive'|'txt'; pool_receiving:boolean; receiving_setup:ReceivingSetup|null; expired:boolean; check_txt:boolean; created_at:string; ever_proven:boolean; dns_first:boolean; hosts: ReceivingHostRow[] };
/** The domain's receiving hosts, its own row first: what every hosted read of a claim carries. `d` is operation_domains. */
const unavailableDomain = () => new ApiError(409, 'DOMAIN_UNAVAILABLE', 'This SES identity is unavailable for this domain claim.');
const ownsIdentity = (identity: GetEmailIdentityCommandOutput, token: string) => hasTags(identity.Tags, [{ Key: claimTag, Value: token }]);
function hostedDomainSelect(wid:string, domainId:string, lock:SQL=sql``) {
  return sql`SELECT d.id,d.name,d.region,to_jsonb(pc) AS connection,dc.token,dc.proof_label,dc.claim_scope,dc.sending_state,dc.receiving_state,dc.receiving_host,dc.lost_since,dc.receiving_lost_since,dc.identity,
    dc.receiving_proved_at,dc.receiving_identity_at,dc.receiving_proof_missed_at,dc.created_at,dc.ever_proven,dc.dns_first,dc.setup_check,domain_claim_expired(dc) AS expired,dc.created_at <= now()-interval '1 hour' AS check_txt,${domainHosts()} AS hosts,${receivingSetup()} AS receiving_setup,
    EXISTS(SELECT 1 FROM provider_pool_regions p WHERE p.region=pc.region AND p.aws_account_id=pc.aws_account_id AND ${poolReceives()}) AS pool_receiving
    FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
    JOIN domain_sending_bindings b ON b.domain_id=d.id AND b.connection_id=dc.connection_id AND b.region=d.region
    JOIN regional_connections pc ON pc.id=b.connection_id AND pc.workspace_id=dc.workspace_id AND pc.region=b.region AND ${connectionReady()}
    WHERE d.workspace_id=${wid} AND d.id=${domainId} ${lock}`;
}
export async function hostedDomain(db: DbExecutor, wid: string, domainId: string, lock=false, recheck?: { domains:readonly string[]; mode:'manual'|'dashboard'; platformAccount?:string }) {
  const target=hostedDomainSelect(wid,domainId,lock ? sql`FOR UPDATE OF dc` : recheck ? sql`FOR SHARE OF dc` : sql``);
  // Authorize the write inside the statement; a restricted key may see a 403 but must never schedule work.
  const allowed = recheck?.domains.length ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(recheck.domains)}::jsonb) p(parent)
    WHERE right('.'||name,length(parent)+1)='.'||lower(parent))` : sql`true`;
  const accountFence=recheck?.platformAccount ? sql`AND (connection->>'kind'<>'shared' OR connection->>'aws_account_id' IS NULL OR connection->>'aws_account_id'=${recheck.platformAccount})` : sql``;
  const query = recheck ? sql`WITH target AS (${target}), queued AS (${recheckJob(wid, sql`SELECT id,token FROM target WHERE NOT expired AND ${allowed} ${accountFence} ${recheck.mode==='dashboard' ? sql`AND sending_state='pending'` : sql``}`,recheck.mode)})
    SELECT target.*,EXISTS(SELECT 1 FROM queued) AS queued FROM target` : target;
  return (await db.execute<HostedDomain & {queued?:boolean}>(query)).rows[0];
}
export const dnsUnavailable = () => new ApiError(503,'DOMAIN_DNS_UNAVAILABLE','DNS did not return a definitive answer. Verification will retry.',undefined,true);
async function identityQuotaAlert(runtime:Runtime,region:string,account:string,error:unknown){
  if(!(error instanceof ApiError) || error.code!=='SES_IDENTITY_QUOTA_EXHAUSTED')return;
  await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('identity-quota:'||${account}::text||':'||${region}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${runtime.config.workspaceId},jsonb_build_object('code','SES_IDENTITY_QUOTA_EXHAUSTED','region',${region}::text)) ON CONFLICT DO NOTHING`);
}
async function txtProof(name: string, token: string) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000), redirect: 'manual' }); // Workers reject 'error'; a 3xx fails !r.ok below.
    if (!r.ok) { await r.body?.cancel();throw dnsUnavailable(); }
    const answer = await r.json() as { Status: number; TC?: boolean; Answer?: { name: string; type: number; data: string }[] };
    if (answer.TC || (answer.Status!==0 && answer.Status!==3)) throw dnsUnavailable();
    return answer.Status === 0 && !!answer.Answer?.some(rr => rr.type === 16 && rr.name.toLowerCase().replace(/\.$/, '') === name && (rr.data === `"${token}"` || rr.data === token));
  } catch { throw dnsUnavailable(); }
}
// Any published label proves the same stored token. A resolver error is not proof of loss.
async function ownershipTxt(domain: string, token: string) {
  let failed = false;
  for (const label of PROOF_LABELS) {
    try { if (await txtProof(proofRecordName(label, domain), token)) return true; }
    catch { failed = true; }
  }
  if (failed) throw dnsUnavailable();
  return false;
}
const state = (verified:boolean) => verified ? 'verified' as const : 'pending' as const;
function readiness(row: DomainRef, value: Partial<GetEmailIdentityCommandOutput>, hosted?: { token:string; label:ProofLabel; shared:boolean; regional?:boolean; proven:boolean; imported?:boolean; txtOwned?:boolean }, mx?:MxReport|null, note?:string|null, observation?:DmarcObservation|null): Readiness {
  const dkim = value.DkimAttributes, suffix = dkim?.SigningHostedZone;
  const signed = dkim?.Status === 'SUCCESS' && dkim.SigningEnabled === true;
  const dns: z.infer<typeof domainSchema>['dns'] = [];
  let dnsUnavailableReason: string | null = null;
  if (dkim?.SigningAttributesOrigin === 'EXTERNAL') dnsUnavailableReason = 'Bring-your-own DKIM records must be obtained from the identity owner.';
  else if (!suffix || !/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\.?$/.test(suffix) || !dkim?.Tokens?.length) dnsUnavailableReason = 'SES did not return an authoritative DKIM signing zone and tokens; DNS records are unavailable.';
  else dns.push(...dkim.Tokens.map(token => ({ name: `${token}._domainkey.${row.name}`, type: 'CNAME' as const, value: `${token}.${suffix}`, purpose:'sending' as const,status:state(signed) })));
  const mailFrom = value.MailFromAttributes;
  if (mailFrom?.MailFromDomain) {
    if (/^(?:us-(?:east|west)|af-south|ap-(?:east|south|northeast|southeast)|ca-(?:central|west)|eu-(?:central|north|south|west)|il-central|me-(?:south|central)|mx-central|sa-east)-\d+$/.test(row.region)) {
      const purpose={purpose:'mail_from' as const,status:state(mailFrom.MailFromDomainStatus==='SUCCESS')};
      dns.push({ name: mailFrom.MailFromDomain, type: 'MX', value: `feedback-smtp.${row.region}.amazonses.com`, priority: 10, ...purpose });
      dns.push({ name: mailFrom.MailFromDomain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ...purpose });
    } else dnsUnavailableReason = 'MAIL FROM DNS instructions are supported only for commercial AWS regions.';
  }
  let verified = value.VerifiedForSendingStatus === true, verificationStatus = value.VerificationStatus ?? 'NOT_STARTED';
  if (hosted) {
    if (hosted.shared) dns.push({ name:proofRecordName(hosted.label,row.name),type:'TXT',value:hosted.token,purpose:'sending',status:state(hosted.proven) });
    if (hosted.imported) dns.push({name:proofRecordName(hosted.label,row.name),type:'TXT',value:hosted.token,purpose:'sending',status:state(hosted.txtOwned===true),note:'Optional for sending. Publish this record and verify the domain to claim exclusive ownership.'});
    verified = verified && hosted.proven && signed && (hosted.imported || (new Set(dkim?.Tokens).size===3 && (!dkim?.SigningAttributesOrigin || dkim.SigningAttributesOrigin==='AWS_SES')));
    if (!verified && verificationStatus === 'SUCCESS') verificationStatus = 'PENDING';
  }
  const ready = verified && signed;
  dns.push({...(mx?.expected ?? expectedMx(row.name,hosted?.shared && hosted.regional ? 'us-east-2' : row.region)),purpose:'receiving',status:state(mx?.state==='active'),...(note ? {note} : {})});
  const dmarc=dmarcView(observation,value);
  if(dmarc?.status==='missing' && observation?.recommend) dns.push({name:`_dmarc.${row.name}`,type:'TXT',value:'v=DMARC1; p=none',purpose:'dmarc',status:'pending',note:`Recommended only if no policy exists. ${productName} does not collect aggregate reports.`});
  return { id: row.id, name: row.name, region: row.region, verificationStatus, verified, dkimStatus: dkim?.Status ?? 'NOT_STARTED', dmarc, ready, sending:state(ready),receiving:state(mx?.state==='active' && value.VerificationStatus==='SUCCESS' && (hosted?.proven ?? true)), mailFromDomain: mailFrom?.MailFromDomain ?? null, mailFromStatus: mailFrom?.MailFromDomainStatus ?? null, dnsStatus: dnsUnavailableReason ? 'unavailable' as const : 'available' as const, dnsUnavailableReason, dns };
}
async function domainReadiness(runtime: Runtime, row: DomainRef, identity?: GetEmailIdentityCommandOutput, mode:'create'|'read'|'verify'='read') {
  const [stored]=await runtime.db.select({mx:mailboxDomains.mx,status:mailboxDomains.status}).from(mailboxDomains).where(and(eq(mailboxDomains.domainId,row.id),isNull(mailboxDomains.parentId)));
  identity??=await sesCall(async ({ GetEmailIdentityCommand }) => (await getSes(runtime,row.region)).send(new GetEmailIdentityCommand({ EmailIdentity:row.name })));
  const report=readiness(row,identity,undefined,stored?.mx,undefined,mode==='create' ? null : await localDmarc(row.name,identity.MailFromAttributes?.MailFromDomain,mode==='verify'));
  if (stored?.status!=='active') report.receiving='pending';
  return report;
}
// The operator-adopted platform domain (scripts/adopt-platform-domain.ts) receives on its Ohio connection while its
// workspace stays configured. Every other adoption is send-only.
const platformClaim = (config:Config,wid:string,row:{name:string;identity:IdentityFacts|null;connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean}}) =>
  !!row.identity?.adopted && row.connection.kind==='shared' && row.connection.legacy!==false && platformDomainOwner(config,wid) && platformHosts(config).includes(row.name);
const claimProof = (row: {connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean};token:string;proof_label:ProofLabel;identity?:IdentityFacts|null;claim_scope?:string}, proven=false) => ({ token:row.token,label:row.proof_label,shared:row.connection.kind==='shared',regional:row.connection.legacy===false,proven,imported:row.connection.kind==='byo' && row.identity?.imported===true,txtOwned:row.claim_scope==='txt' });
type ClaimRow = DomainRef & ClaimState & ProofTimes & { setup_check?:SetupCheck|null; token:string; proof_label:ProofLabel; identity:IdentityFacts|null; connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean}; created_at?:string|Date; ever_proven?:boolean; dns_first?:boolean; hosts?:ReceivingHostRow[] };
const hour=3600_000;
const proofTime=(at:Date|string|null|undefined)=>at?new Date(at).getTime():0;
const proofUntil=(row:ProofTimes)=>Math.min(proofTime(row.receiving_proved_at)+72*hour,row.receiving_proof_missed_at?proofTime(row.receiving_proof_missed_at)+48*hour:Infinity);
const observeProof=(positive:boolean)=>sql`receiving_proved_at=CASE WHEN ${positive} THEN now() ELSE receiving_proved_at END,receiving_proof_missed_at=CASE WHEN NOT ${positive} THEN coalesce(receiving_proof_missed_at,now()) END`;
const sends = (row: Pick<ClaimState,'sending_state'>) => row.sending_state==='verified' || row.sending_state==='lost';
/**
 * A Hosted domain's re-check on request (POST /v1/domains/{id}/verify, and support's DNS re-check): queues a background
 * verification unless one is already due, and returns the stored status.
 */
export async function verifyHostedDomain(runtime: Runtime, a: Actor, domainId: string) {
  const row=await hostedDomain(runtime.db,a.workspaceId,domainId,false,{domains:a.domains,mode:'manual',platformAccount:runtime.config.platformAccount}) ?? notFound('Domain'); allowedDomain(a,row.name);
  assertSharedAccount(runtime,row.connection);
  if (row.queued) a.wakeJobs=1;
  return derivedReadiness(row);
}
/** The readiness document is derived: SES/DNS facts give the records, the explicit states give every boolean. */
export function derivedReadiness(row: ClaimRow): Readiness {
  const facts=row.identity, held=sends(row);
  const report=readiness(row,facts?.ses ?? {VerificationStatus:'PENDING'},claimProof(row,(facts?.proven ?? false) || held),facts?.mx,facts?.note,facts?.dmarc);
  if(row.dns_first && !row.ever_proven){
    if(!report.dns.some(record=>record.name===proofRecordName(row.proof_label,row.name))) report.dns.unshift({name:proofRecordName(row.proof_label,row.name),type:'TXT',value:row.token,purpose:'sending',status:'pending'});
    report.dnsUnavailableReason='Publish the ownership TXT record first. DKIM records follow after DNS proof.';
  }
  report.verified=held; report.ready=held; report.sending=state(held);
  if (row.sending_state==='failed') report.verificationStatus='FAILED';
  else if (!held && report.verificationStatus==='SUCCESS') report.verificationStatus='PENDING';
  report.receiving=state(row.receiving_state==='active' || row.receiving_state==='lost');
  // Receiving: one MX record per host, the domain's own row first. That row's host floats with the suggestion until it
  // routes: never the root unless it already routes here or the owner chose it (an MX pasted at the root would take the
  // domain's existing mail), and never one of Nightmail's own names. DNS checks refine this to a free host. Every other
  // host is exactly where it was added, and a host the owner removed has no record.
  const ses=facts?.ses, chosen=facts?.receivingChoice ?? null, hosts=row.hosts ?? [], own=hosts.find(h=>h.own), established=establishedHost(row);
  const others=hosts.filter(h=>!h.own && h.status!=='disabled' && h.status!=='disabling');
  const rootActive=established===row.name || chosen===row.name || (facts?.mx?.expected.name===row.name && facts.mx.state==='active');
  const receivingName=(name:string)=>established ?? (chosen && !baneRecordUse(chosen,row.name,ses) ? chosen : (name===row.name && !rootActive) || baneRecordUse(name,row.name,ses) ? defaultReceivingHost(row.name,ses) : name);
  const template=report.dns.find(r=>r.purpose==='receiving');
  report.dns=report.dns.flatMap(r=>r.purpose!=='receiving' ? [r] : own?.status==='disabled' ? [] : [{...r,name:receivingName(r.name),status:state(established!==null)}]);
  if (template) report.dns.push(...others.map(h=>({name:h.host,type:'MX' as const,value:template.value,priority:template.priority,purpose:'receiving' as const,status:state(h.status==='active' || h.status==='provisioning')})));
  const shown=own?.status==='disabled' ? null : report.dns.find(r=>r.purpose==='receiving')?.name;
  report.receivingIssue=(established ? baneRecordIssue(established,row.name,ses,row.region,null) : null) ?? (shown && facts?.issue && facts.issue.host===shown ? facts.issue : null) ?? others.find(h=>h.issue)?.issue ?? null;
  if(row.receiving_host && report.receiving==='verified'){
    const deadline=Math.min(proofUntil(row),proofTime(row.receiving_identity_at)+96*hour),blocking=deadline<=Date.now();
    const stale=!!row.receiving_proof_missed_at || proofTime(row.receiving_proved_at)<Date.now()-24*hour;
    if(stale || proofTime(row.receiving_identity_at)<Date.now()-48*hour){
      report.receivingIssue={code:stale?'proof_stale':'identity_stale',host:row.receiving_host,blocking,message:`${stale?'Recheck the ownership TXT record':'Recheck the SES domain identity'}. ${blocking?'New mail is held until verification succeeds.':`New mail will be held after ${new Date(deadline).toISOString()} if verification does not succeed.`}`};
      if(blocking)report.receiving='pending';
    }
  }
  // No DNS setup is authorized by a send-only operator attestation. The adopted platform domain also receives: it
  // shows only its receiving MX, since its DKIM records predate the claim and the attestation replaces the TXT.
  if (facts?.adopted) report.dns=facts.receivingChoice || row.receiving_state!=='off' ? report.dns.filter(r=>r.purpose==='receiving') : [];
  // The last background DNS check of a domain still pending (domain-setup.ts): each pending record's state, and its DNS host.
  const check=row.setup_check;
  if (check && !held) {
    for (const r of report.dns) if (r.status==='pending' && (r.purpose==='sending' || r.purpose==='mail_from')) {
      const seen=check.records.find(c=>c.type===r.type && c.name===r.name && c.value===r.value);
      if (seen) r.publicDns=seen.publicDns;
    }
    report.dnsHost=check.host;
  }
  if (row.created_at!==undefined && row.ever_proven===false && !held) report.releasesAt=new Date(new Date(row.created_at).getTime()+72*3600_000).toISOString();
  else if (row.ever_proven!==undefined) report.releasesAt=null;
  return report;
}
const identityBinding = (row:Pick<HostedDomain,'name'|'region'|'connection'>,wid:string) => ({TenantName:claimTenantName(row.connection,wid), ResourceArn:`arn:aws:ses:${row.region}:${row.connection.aws_account_id}:identity/${row.name}`});

// The caller holds the claim lock. Only a full identity check can change eligibility; an MX-only
// observation may change routing but can never grant ownership or qualify an unverified SES identity.
async function saveObservation(db:DbExecutor,row:HostedDomain,wid:string,ses:IdentityFacts['ses'],observation:DomainObservation|undefined,evidence:Pick<ClaimEvidence,'sending'|'sendingRevoked'|'identityVerified'|'proven'|'unavailable'|'definitive'>,dmarc=row.identity?.dmarc) {
  const byo=row.connection.kind==='byo', established=establishedHost(row), seen=observation?.own;
  const ownRow=row.hosts.find(h=>h.own), others=row.hosts.filter(h=>!h.own);
  // Nightmail's MX is live at a host when it answers there, alone or beside another provider's (a backup MX while mail
  // moves over): such a host takes whatever mail reaches it, and its issue says how the mail is split.
  const live=(mx:MxReport)=>mx.state==='active' || mx.state==='mixed';
  let observed=seen ? (live(seen.mx) ? seen.mx.expected.name : null) : undefined;
  let note=seen ? seen.note ?? null : row.identity?.note ?? null;
  let issue=seen ? seen.issue : row.identity?.issue ?? null;
  // Never route mail on a name Nightmail publishes for another purpose (custom MAIL FROM, ownership TXT, DKIM).
  const reserved=observed && observed!==established ? baneRecordIssue(observed,row.name,ses,row.region,null) : null;
  if (reserved) { issue=reserved; observed=null; }
  if (observed && observed!==established) {
    // A workspace may claim both example.com and reply.example.com, and another workspace may hold the host too. Never
    // route one address twice (mailbox_domains_routing_host enforces it).
    const owner=(await hostOwners(db,[observed],wid,row.name)).taken.get(observed);
    if (owner) { issue=takenIssue(observed,owner,null); note=issue.message; observed=null; }
  }
  // A host another workspace has claimed (in any scope) or delegated to its own name servers is never routed here.
  if (observed && issue?.host===observed && (issue.code==='claimed' || issue.code==='delegated')) observed=null;
  // The domain's own row: where it routes, or where its MX should go until it does. The primary host's MX grace is the
  // claim's (every Worker keeps it, so one that doesn't know lost_since can't leave a stale one behind); the others' their rows'.
  const ownHost=established ?? seen?.mx.expected.name ?? ownRow?.host ?? row.identity?.mx?.expected.name ?? defaultReceivingHost(row.name,ses);
  const seed=(h:ReceivingHostRow)=>h.status==='active' ? hostGraceStart(row,h) : null;
  const hostIssues=new Map<string,ReceivingIssue|null>();
  // An MX-only observation never routes a new host without fresh ownership proof.
  const allow=(h:{status:string},on:boolean|undefined)=>on===undefined ? undefined : on && (evidence.proven || h.status==='active');
  const own:HostEvidence|null=ownRow?.status==='disabled' ? {host:ownRow.host,status:'disabled',lost_since:null,live:undefined}
    : {host:ownHost,status:ownRow ? hostStatus(ownRow.status) : 'waiting_for_mx',lost_since:ownRow ? seed(ownRow) : null,live:allow(ownRow ?? {status:'waiting_for_mx'},observed===undefined ? undefined : observed!==null)};
  const evidenceFor=(h:ReceivingHostRow):HostEvidence=>{
    const seenThere=observation?.hosts.get(h.host);
    if (seenThere) hostIssues.set(h.host,seenThere.issue);
    return {host:h.host,status:hostStatus(h.status),lost_since:seed(h),live:allow(h,seenThere ? live(seenThere.mx) && !(seenThere.issue && refusedCodes.has(seenThere.issue.code)) : undefined)};
  };
  let input=[own,...others.map(evidenceFor)];
  const regionReceives=row.claim_scope!=='account' && (byo || row.pool_receiving);
  const transition=()=>{
    const n=transitionClaim(row,{...evidence,regionReceives,byo},input);
    // The ownership grace preserves hosts still bound to their MX only. It cannot activate another host, revive a
    // disconnected claim, or overrule a negative SES observation.
    if(!evidence.proven && evidence.identityVerified && !evidence.definitive && !evidence.unavailable && regionReceives && ['active','lost'].includes(row.receiving_state) && proofUntil(row)>Date.now()
      && input.some(h=>h.status==='active' && h.live)) return transitionClaim(row,{...evidence,proven:true,regionReceives,byo},input.map(h=>({...h,live:h.status==='provisioning' ? false : h.live===undefined ? undefined : h.live && h.status==='active'})));
    return n;
  };
  let next=transition();
  const ref={name:row.name,token:row.token,connectionId:row.connection.id,workspaceId:wid,domainId:row.id,region:row.region};
  const apply=async()=>{
    // Managed sending identities confer no receiving rights (including Virginia). Only a
    // separately reviewed receiving binding may change that projection in phase 2.
    if (row.connection.legacy===false) return applyClaim(db,ref,next.claim,{ses,dmarc,proven:evidence.proven,mx:row.identity?.mx??null,note,imported:row.identity?.imported,adopted:row.identity?.adopted},null);
    const mx=next.claim.receiving_state==='lost' ? row.identity?.mx ?? null : seen?.mx ?? row.identity?.mx ?? null;
    const writes:HostWrite[]=input.map((h,i)=>{
      const at=i===0 ? ownRow : others[i-1];
      // The domain's own row keeps the report the claim keeps, as every Worker writes it.
      return {...next.hosts[i]!,id:at?.id ?? null,host:h.host,...(i===0 ? {mx,issue:h.status==='disabled' ? null : issue} : {mx:observation?.hosts.get(h.host)?.mx ?? null,issue:hostIssues.has(h.host) ? hostIssues.get(h.host)! : at?.issue ?? null})};
    });
    await applyClaim(db,ref,next.claim,{ses,dmarc,proven:evidence.proven,mx,note,issue,receivingChoice:row.identity?.receivingChoice ?? null,imported:row.identity?.imported,adopted:row.identity?.adopted},writes);
  };
  const routes=(s:string)=>s==='active' || s==='provisioning';
  const newlyRouting=()=>input.filter((h,i)=>routes(next.hosts[i]!.status) && !routes(h.status)).map(h=>h.host);
  if (newlyRouting().length) {
    // Two domains can both read a host as free above and then race to route it; the unique indexes decide. The loser
    // reports host_taken on that host instead of failing the job (the savepoint keeps the transaction usable).
    await db.execute(sql`SAVEPOINT receiving_host_claim`);
    try { await apply(); await db.execute(sql`RELEASE SAVEPOINT receiving_host_claim`); }
    catch (e) {
      if (!receivingHostConflict(e)) throw e;
      await db.execute(sql`ROLLBACK TO SAVEPOINT receiving_host_claim`);
      const owners=(await hostOwners(db,newlyRouting(),wid,row.name)).taken, lost=newlyRouting().filter(host=>owners.has(host));
      for (const host of lost.length ? lost : newlyRouting()) {
        const taken=takenIssue(host,owners.get(host) ?? {own:false,name:''},null);
        if (host===input[0]!.host) { issue=taken; note=taken.message; } else hostIssues.set(host,taken);
        input=input.map(h=>h.host===host ? {...h,live:false} : h);
      }
      next=transition();
      await apply();
    }
  } else await apply();
  // The grace after its DNS records went missing has run out: mail from the domain is refused from here on, and its
  // owners are told once (an identity that SES revoked or lost is another story, and has no email).
  if (row.sending_state==='lost' && next.claim.sending_state==='pending' && !evidence.definitive && !evidence.unavailable && !evidence.sendingRevoked)
    await (await wrapModuleLoad(() => import('./account-notices.js'))).domainUnverified(db,wid,{id:row.id,name:row.name,lostSince:row.lost_since ? String(row.lost_since) : null});
  if (row.connection.legacy===false) return next.claim;
  if (byo && (next.claim.receiving_host!==row.receiving_host || next.hosts.some((s,i)=>s.status==='provisioning' || routes(s.status)!==routes(input[i]!.status)))) await (await wrapModuleLoad(() => import('./mailbox-setup.js'))).queueReconcile(db,wid,row.region);
  return next.claim;
}
/** Hosted rows only ever take the four host states; anything else (a self-hosted leftover) reads as waiting for its MX. */
const hostStatus=(status:string):HostStatus=>status==='active' || status==='provisioning' || status==='disabled' ? status : 'waiting_for_mx';
const receivingHostConflict=(error:unknown)=>{
  const e=((error as {cause?:unknown})?.cause ?? error) as {code?:string;constraint?:string};
  return e?.code==='23505' && ['domain_claims_receiving_host','domain_claims_routing','mailbox_domains_routing_host'].includes(e.constraint ?? '');
};
// Same DNS checks for "Check MX now" (domain.verify), the hourly sweep (domain.mx) and an explicit choice; see receiving-host.ts.
const receivingMx=(db:DbExecutor,row:HostedDomain,wid:string):Promise<DomainObservation>=>observeReceiving(db,row,wid,dnsUnavailable);
const sesFacts = (identity: Partial<GetEmailIdentityCommandOutput>): IdentityFacts['ses'] => ({ VerificationStatus: identity.VerificationStatus, VerifiedForSendingStatus: identity.VerifiedForSendingStatus, DkimAttributes: identity.DkimAttributes, MailFromAttributes: identity.MailFromAttributes });
// Creates this claim's tagged identity, or adopts the one an earlier lost response left behind. Never adopts by name.
async function ensureIdentity(client: Awaited<ReturnType<typeof getSes>>, name: string, token: string,installation?:string,regionalByo=false) {
  try {
    return await sesCall(({ CreateEmailIdentityCommand })=>client.send(new CreateEmailIdentityCommand({EmailIdentity:name,DkimSigningAttributes:{NextSigningKeyLength:'RSA_2048_BIT'},Tags:[{Key:claimTag,Value:token},...(installation?[mxOwnerTag,{Key:tagKey('installation-id'),Value:installation}]:[]),...(regionalByo?[{Key:tagKey('purpose'),Value:'domain-identity'}]:[])]})),true);
  } catch(e) {
    if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') throw e;
    const existing=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:name})));
    // A connected account's identity Nightmail didn't create is never changed: it can only be imported, as it is.
    if (regionalByo && !ownsIdentity(existing,token)) throw new ApiError(409,'DOMAIN_EXISTS_IN_ACCOUNT',`${name} already exists in this AWS account's SES, set up outside ${productName}. Import it from the domains found in your account, and ${productName} uses it as it is, or remove it in SES first.`);
    // A connected account's identity Nightmail didn't create is never changed: it can only be imported, as it is.
    if (regionalByo && !ownsIdentity(existing,token)) throw new ApiError(409,'DOMAIN_EXISTS_IN_ACCOUNT',`${name} already exists in this AWS account's SES, set up outside ${productName}. Import it from the domains found in your account, and ${productName} uses it as it is, or remove it in SES first.`);
    if (!ownsIdentity(existing,token) || regionalByo && !hasTags(existing.Tags,[mxOwnerTag,{Key:tagKey('installation-id'),Value:installation!},{Key:tagKey('purpose'),Value:'domain-identity'}])) throw unavailableDomain();
    return existing;
  }
}
// A retried/reconnected creation or a verifier can recover an old claim right at its deadline.
// Recheck and hold the row across Create so recovery cannot recreate the identity after expiry cleanup.
const identityJournalEntry=(row:Pick<HostedDomain,'connection'|'region'|'name'|'token'>)=>({kind:'identity',resource:`arn:aws:ses:${row.region}:${row.connection.aws_account_id}:identity/${row.name}`,claim:row.token});
function recoverIdentity(runtime:Runtime,wid:string,domainId:string,token:string,client:Awaited<ReturnType<typeof getSes>>) {
  return runtime.db.transaction(async db=>{
    const current=await hostedDomain(db,wid,domainId,true);
    if (current && current.token===token && !current.expired && !current.identity?.adopted) {
      assertSharedAccount(runtime,current.connection);
      if (current.dns_first && !current.ever_proven) return null;
      const regionalByo=current.connection.kind==='byo' && current.connection.legacy===false;
      const pooled=current.connection.kind==='shared' && runtime.config.trustedPool;
      const identity=await ensureIdentity(client,current.name,token,pooled?POOL_INSTALLATION:current.connection.legacy===false || (runtime.config.regionalSending && current.connection.kind==='shared')?current.connection.id:undefined,regionalByo || pooled);
      // A configuration-set SNS destination already receives feedback. Do this only after create or a
      // tag-checked recovery, never on a customer import or an operator-adopted identity.
      if (!('FeedbackForwardingStatus' in identity) || identity.FeedbackForwardingStatus !== false) {
        try { await sesCall(({PutEmailIdentityFeedbackAttributesCommand}) => client.send(new PutEmailIdentityFeedbackAttributesCommand({EmailIdentity:current.name,EmailForwardingEnabled:false}))); }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          log('warn',{code:'SES_FEEDBACK_FORWARDING_NOT_DISABLED',workspaceId:wid,domain:current.name,region:current.region,reason:error.code});
        }
      }
      if (regionalByo) {
        const entry=JSON.stringify([identityJournalEntry(current)]);
        await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=ownership_journal||${entry}::jsonb WHERE connection_id=${current.connection.id} AND region=${current.region} AND NOT ownership_journal @> ${entry}::jsonb`);
      }
      return identity;
    }
  });
}
// Removes only this claim's tagged identity (and, in the shared pool, its tenant association). Used by
// domain deletion and by disconnecting a shared connection, so a later reconnect never meets its own ghost.
async function deleteClaimIdentity(runtime:Runtime,wid:string,row:Pick<HostedDomain,'name'|'region'|'token'|'connection'>) {
  const client=await getSes({...runtime,config:{...runtime.config,regions:[row.region]}},row.region,{...row.connection,identitySession:{name:row.name,purpose:'delete'}});
  const ignoreMissing=async <T>(fn:(sesv2: Sesv2Mod)=>Promise<T>)=>{ try {return await sesCall(fn);} catch(e){if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND') throw e;} };
  const identity=await ignoreMissing(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
  if (!identity || !ownsIdentity(identity,row.token)) return;
  // Read actual SES membership, not readiness: DNS can regress, or the association acknowledgement can be lost.
  // The caller holds the claim lock through deletion so a concurrent release/re-claim cannot delete a new owner's identity.
  if (row.connection.kind==='shared' && row.connection.aws_account_id) {
    const binding=identityBinding(row,wid); let next: string | undefined;
    do {
      const page=await sesCall(({ ListResourceTenantsCommand })=>client.send(new ListResourceTenantsCommand({ResourceArn:binding.ResourceArn,NextToken:next})));
      if (page.ResourceTenants?.some(t=>t.TenantName===binding.TenantName)) {
        await ignoreMissing(({ DeleteTenantResourceAssociationCommand })=>client.send(new DeleteTenantResourceAssociationCommand(binding))); break;
      }
      next=page.NextToken;
    } while (next);
  }
  await ignoreMissing(({ DeleteEmailIdentityCommand })=>client.send(new DeleteEmailIdentityCommand({EmailIdentity:row.name})));
}
/** Disconnect: shared identities are deleted, BYO identities stay in AWS, and only exclusive claims are retained. */
export async function releaseConnectionDomains(runtime:Runtime,db:DbExecutor,wid:string,connection:HostedDomain['connection'] & {region:string}) {
  if (connection.kind==='shared') {
    const claims=(await db.execute<{name:string;token:string;region:string;managed_tenant:boolean;pool_tenant_name:string|null}>(sql`SELECT dc.name,dc.token,b.region,r.managed_tenant,r.pool_tenant_name FROM domain_claims dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) JOIN regional_connections r ON r.id=b.connection_id AND r.region=b.region WHERE dc.workspace_id=${wid} AND dc.connection_id=${connection.id} AND NOT coalesce(dc.identity ? 'adopted',false) FOR UPDATE OF dc`)).rows;
    for (const claim of claims) await deleteClaimIdentity(runtime,wid,{...claim,connection:{...connection,managed_tenant:claim.managed_tenant,pool_tenant_name:claim.pool_tenant_name}});
  }
  await db.execute(sql`WITH ${releaseConnectionClaims(wid,sql`SELECT ${connection.id}::text AS id`)} SELECT 1`);
}
async function releaseClaim(db:DbExecutor,wid:string,row:{token:string}) {
  await db.execute(sql`WITH released AS (DELETE FROM domain_claims WHERE workspace_id=${wid} AND token=${row.token} RETURNING name,token), ${releasedClaimCleanup(wid)}
    DELETE FROM operation_domains WHERE workspace_id=${wid} AND name IN (SELECT name FROM released)`);
}
/** Each release holds one lock through the tag check, SES deletion and database cleanup. On SES
 * failure retain the claim for the next sweep, without letting it block other expired names. */
export async function expireDomainClaims(runtime:Runtime,deadline:number) {
  let cursor:{created:string;token:string}|undefined, released=0;
  while (Date.now()<deadline) {
    const after=cursor ? sql`AND (dc.created_at,dc.token)>(${cursor.created}::timestamptz,${cursor.token}::uuid)` : sql``;
    let selected=false;
    try {
      const found=await runtime.db.transaction(async db=>{
        const row=(await db.execute<{workspace_id:string;name:string;token:string;created:string;connection:(HostedDomain['connection'] & {region:string})|null}>(sql`
          SELECT dc.workspace_id,dc.name,dc.token,dc.created_at::text AS created,to_jsonb(pc) AS connection FROM domain_claims dc
          LEFT JOIN domain_sending_bindings b ON b.workspace_id=dc.workspace_id AND b.name=dc.name AND b.connection_id=dc.connection_id
          LEFT JOIN regional_connections pc ON pc.id=b.connection_id AND pc.region=b.region
          WHERE domain_claim_expired(dc) ${after} ORDER BY dc.created_at,dc.token LIMIT 1 FOR UPDATE OF dc SKIP LOCKED`)).rows[0];
        if (!row) return false;
        cursor=row; selected=true;
        if (row.connection?.kind==='shared') await deleteClaimIdentity(runtime,row.workspace_id,{...row,region:row.connection.region,connection:row.connection});
        await releaseClaim(db,row.workspace_id,row); return true;
      });
      if (!found) break;
      released++;
    } catch (e) {
      if (e instanceof ModuleLoadError || !selected || !(e instanceof ApiError)) throw e;
      log('warn',{code:'DOMAIN_EXPIRY_RETRY',reason:e.code});
    }
  }
  return released;
}
function dnsSetupActor(c:Ctx) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a=actor(c,'manage');
  if (a.credential!=='dashboard' || (a.role!=='owner' && a.role!=='admin')) throw denied('PERMISSION_DENIED','Use an owner or admin dashboard session to set up DNS.',{ permission: 'configuration', level: 'write', credential: 'dashboard', person: 'admin' });
  return a;
}
export function recheckJob(wid: string, source: SQL, mode:'manual'|'dashboard'|'supersede'='manual') {
  // A recovered creation or MAIL FROM change supersedes even a running poll based on an older SES read.
  // Dashboard reads only advance the due time. Preserve the background poll count and use the job's
  // existing enqueue timestamp as an atomic per-claim cooldown, shared by every tab and isolate.
  return sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.verify:'||r.token,'domain.verify',${wid},
    jsonb_build_object('domainId',r.id,'token',r.token${mode==='dashboard' ? sql`,'dashboard',true` : sql``}) FROM (${source}) r ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),lease_until=NULL,last_error=NULL,
    payload=${mode==='dashboard' ? sql`CASE WHEN jobs.status='pending' AND jobs.available_at<=now() THEN jobs.payload ELSE jobs.payload||'{"dashboard":true}'::jsonb END` : sql`excluded.payload`},created_at=clock_timestamp() ${mode==='supersede' ? sql`` : sql`WHERE jobs.status<>'running'`}
    ${mode==='dashboard' ? sql`AND jobs.created_at<=clock_timestamp()-interval '20 seconds'` : sql``} RETURNING id`;
}
const domainVerify: JobHandler = async (runtime,payload,job) => {
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  // A cutover job can arrive at the old consumer. Keep it pending, without consuming a retry or touching SES.
  if (payload.platformAccount && payload.platformAccount!==runtime.config.platformAccount) throw new JobDeferred(new Date(Date.now()+60_000).toISOString(),payload);
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row || row.token!==payload.token || row.expired) return; // Deleted, reclaimed, disconnected or awaiting expiry cleanup.
  assertSharedAccount(runtime,row.connection);
  // Only previously proven claims keep polling beyond 72 hours (including recovery after lost proof).
  const poll=Number(payload.poll ?? 0);
  const {dashboard,...background}=payload, nextPoll=dashboard===true && !row.ever_proven ? poll : poll+1;
  const backoff=(n:number)=>n<5 ? [15000,30000,120000,600000,1800000][n]! : n<72 ? 3600_000 : n<84 ? 6*3600_000 : 24*3600_000;
  const defer=(ms:number,next?:number) => {
    const now=Date.now();
    if (!row.ever_proven) {
      const remaining=new Date(row.created_at).getTime()+72*3600_000-now;
      ms=Math.min(ms,3600_000);
      if (remaining>60_000 && ms>=remaining) ms=remaining-30_000;
    }
    // Lane contention isn't an observation. Consume the dashboard nudge only after an actual check.
    throw new JobDeferred(new Date(now+ms).toISOString(),next===undefined ? payload : {...background,poll:next});
  };
  const scoped={...runtime,config:{...runtime.config,workspaceId:job.workspaceId,regions:[row.region]}};
  try {
    if(row.dns_first && !row.ever_proven) {
      if(!await ownershipTxt(row.name,row.token)) defer(backoff(poll),nextPoll);
      await runtime.db.transaction(async db=>{
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(substring(${row.name} FROM '[^.]+\\.[^.]+$'),84912))`);
        const elected=await db.execute(sql`UPDATE domain_claims dc SET ever_proven=true WHERE token=${row.token} AND connection_id=${row.connection.id} AND NOT domain_claim_expired(dc) RETURNING token`);
        if (!elected.rowCount) return;
        // Only remove a superseded, tag-matching *platform* identity in the
        // same account and region. Never adopt by name or delete BYO resources.
        const losers=await db.execute<{workspace_id:string;token:string;connection:HostedDomain['connection']}>(sql`SELECT dc.workspace_id,dc.token,to_jsonb(pc) AS connection FROM domain_claims dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) JOIN regional_connections pc ON pc.id=b.connection_id AND pc.region=b.region WHERE dc.superseded AND NOT dc.dns_first AND dc.name=${row.name} AND pc.kind='shared' AND pc.region=${row.region} AND pc.aws_account_id=${row.connection.aws_account_id} FOR UPDATE OF dc`);
        for(const loser of losers.rows){await deleteClaimIdentity(runtime,loser.workspace_id,{...row,...loser});await releaseClaim(db,loser.workspace_id,loser);}
      });
      defer(1000,nextPoll); // reload the winning token/binding before creating SES resources
    }
    if (row.connection.kind==='byo' && row.connection.legacy===false && !await byoEnabled(runtime,job.workspaceId)) defer(300_000);
    await Promise.all([
      preloadSesTransport(runtime.config.multiTenant),
      loadOperationsSesv2(),
      loadRegistries(),
      ...(row.connection.kind==='byo' ? [wrapModuleLoad(() => import('./mailbox-setup.js'))] : []),
    ]);
    // Reserve the next GetEmailIdentity across workers, not per workspace or per invocation.
    const lane='domain.verify:'+(row.connection.kind==='shared'?'platform':row.connection.aws_account_id);
    if (!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES (${lane},clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id)
      DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount) {
      defer(1000+Math.random()*1000);
    }
    const client=await getSes(scoped,row.region,{...row.connection,identitySession:{name:row.name,purpose:row.identity?.imported?'read':'verify'}});
    let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name}))); }
    catch (e) {
      const ses=row.identity?.ses,reset=row.connection.kind==='shared' && !row.identity?.adopted && !row.identity?.imported && !ses?.VerifiedForSendingStatus &&
        (!ses?.VerificationStatus || ['PENDING','NOT_STARTED'].includes(ses.VerificationStatus)) && (!ses?.DkimAttributes?.Status || ses.DkimAttributes.Status==='NOT_STARTED');
      if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND' || row.identity && !reset) throw e;
    }
    // Recover an interrupted create, including a lost create acknowledgement before feedback forwarding was disabled.
    if (!identity || (!row.identity && identity.FeedbackForwardingStatus === true && ownsIdentity(identity,row.token))) {
      const recovered=await recoverIdentity(runtime,job.workspaceId,row.id,row.token,client);
      if (!recovered) return;
      identity??={...recovered,VerificationStatus:'PENDING',$metadata:{}};
    }
    else if (row.identity?.adopted) {
      // Runtime IAM intentionally denies membership reads/writes on these ARNs. An SES send
      // requires the pinned tenant; only the migration operator can attest membership anew.
      const verified=matchesAdoption(identity,row.identity.adopted.fingerprint);
      if (!platformClaim(runtime.config,job.workspaceId,row)) {
        if (!verified) await runtime.db.execute(sql`UPDATE domain_claims SET sending_state='pending',lost_since=NULL WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
        return;
      }
      // The platform domain also receives. The operator's attestation, which SES keeps current by checking the
      // platform's own DKIM records, stands in for the claim tag and the ownership TXT; the MX checks are the ordinary
      // ones. A drifted identity stops sending and receiving at once (no grace) until the operator attests it again,
      // and a claim whose adoption never completed (sending still pending) never receives.
      const ses=sesFacts(identity);
      const [dmarc,observation]=await Promise.all([observeDmarc(row.name,identity.MailFromAttributes?.MailFromDomain).catch(e=>{if(e instanceof ModuleLoadError)throw e;return null;}),receivingMx(runtime.db,row,job.workspaceId)]);
      await runtime.db.transaction(async db=>{
        const current=await hostedDomain(db,job.workspaceId,row.id,true);
        if (!current?.identity?.adopted || current.token!==row.token || current.expired) return;
        // A newer MX observation, or an operator re-attestation made while SES was read, wins over this read.
        if (current.receiving_host!==row.receiving_host || current.identity.adopted.fingerprint!==row.identity!.adopted!.fingerprint) defer(5000);
        const attested=verified && sends(current);
        await db.execute(sql`UPDATE domain_claims SET ${observeProof(attested)},receiving_identity_at=CASE WHEN ${verified} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${current.connection.id}`);
        await saveObservation(db,current,job.workspaceId,ses,observation,{sending:attested,sendingRevoked:!verified,identityVerified:verified,proven:attested},dmarc);
      });
      return;
    }
    else if (!(row.connection.kind==='byo' && row.identity?.imported) && !ownsIdentity(identity,row.token)) throw unavailableDomain();
    const shared=row.connection.kind==='shared';
    const identityVerified=identity.VerificationStatus==='SUCCESS';
    const scopedImport=row.claim_scope==='account';
    // Don't seed the resolver's negative cache before the user has published DNS. Once ownership
    // is established, keep checking it even if DKIM regresses: receive-only routing has its own grace.
    const dkimSuccess=identity.DkimAttributes?.Status==='SUCCESS';
    const checkHostedTxt=row.check_txt || dkimSuccess || row.identity?.proven || sends(row) || row.receiving_host!==null;
    const [positive,dmarc,observation,upgrade]=await Promise.all([shared ? (checkHostedTxt ? ownershipTxt(row.name,row.token) : false) : identityVerified,observeDmarc(row.name,identity.MailFromAttributes?.MailFromDomain).catch(e=>{if(e instanceof ModuleLoadError)throw e;return null;}),
      scopedImport || row.connection.legacy===false ? undefined : receivingMx(runtime.db,row,job.workspaceId),scopedImport ? ownershipTxt(row.name,row.token).catch(()=>false) : false]); // Optional ownership lookup never blocks applying SES's sending evidence.
    const report=readiness(row,identity,claimProof(row,positive));
    // The identity binds to the workspace tenant, which the tenant job owns; a verified domain waits for it here.
    if (shared && report.ready && row.connection.tenant_state!=='ready') {
      // Platform setup delay is not a failure to prove ownership.
      await runtime.db.execute(sql`UPDATE domain_claims dc SET ever_proven=true WHERE dc.token=${row.token} AND dc.connection_id=${row.connection.id} AND NOT dc.ever_proven AND NOT domain_claim_expired(dc)
        ${runtime.config.platformAccount ? sql`AND EXISTS(SELECT FROM provider_connections c WHERE c.id=dc.connection_id AND (c.aws_account_id IS NULL OR c.aws_account_id=${runtime.config.platformAccount}))` : sql``}`);
      log('info',{code:'TENANT_NOT_READY',workspaceId:job.workspaceId,domain:row.name}); defer(backoff(poll),nextPoll);
    }
    const outcome=await runtime.db.transaction(async db=>{
      if (upgrade) await db.execute(sql`SELECT promote_imported_claim(${job.workspaceId},${row.name},${row.token},${row.connection.id})`);
      // Serialize the association with deletion: a stale verifier cannot bind a replacement identity.
      const current=await hostedDomain(db,job.workspaceId,row.id,true);
      if (!current || current.token!==row.token || current.expired) return null;
      assertSharedAccount(runtime,current.connection); // The account may have changed during the AWS/DNS read.
      const mailFrom=(facts:IdentityFacts|null)=>facts?.ses.MailFromAttributes?.MailFromDomain ?? null, mailFromStatus=(facts:IdentityFacts|null)=>facts?.ses.MailFromAttributes?.MailFromDomainStatus ?? null;
      if (current.receiving_host!==row.receiving_host || mailFrom(current.identity)!==mailFrom(row.identity) || (mailFromStatus(current.identity)==='PENDING' &&
        (mailFromStatus(row.identity)!=='PENDING' || mailFrom(current.identity)!==report.mailFromDomain))) {
        defer(5000); // The newer configuration has its own poll; never replace it with a stale observation.
      }
      if (shared && report.ready && !sends(current)) {
        const binding=identityBinding(current,job.workspaceId);
        const exclusive=async()=>{
          const page=await sesCall(({ ListResourceTenantsCommand })=>client.send(new ListResourceTenantsCommand({ResourceArn:binding.ResourceArn,PageSize:2})));
          if (!page.ResourceTenants || page.NextToken || page.ResourceTenants.length>1 || page.ResourceTenants.some(t=>t.ResourceArn!==binding.ResourceArn || t.TenantName!==binding.TenantName)) throw unavailableDomain();
          return page.ResourceTenants.length===1;
        };
        const trusted=!!current.connection.pool_tenant_name && current.region==='us-east-1';
        if (!trusted || !await exclusive()) {
          try { await sesCall(({ CreateTenantResourceAssociationCommand })=>client.send(new CreateTenantResourceAssociationCommand(binding))); }
          catch (e) { if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') throw e; }
          if (trusted && !await exclusive()) defer(5000);
        }
      }
      await db.execute(sql`UPDATE domain_claims SET ${observeProof(positive)}, receiving_identity_at=CASE WHEN ${current.connection.legacy===false} THEN receiving_identity_at WHEN ${identityVerified} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${current.connection.id}`);
      return saveObservation(db,current,job.workspaceId,sesFacts(identity),observation,{sending:report.ready,sendingRevoked:current.identity?.imported && !report.ready,identityVerified,proven:positive},dmarc);
    });
    if (!outcome || (outcome.sending_state==='verified' && report.mailFromStatus!=='PENDING' && outcome.receiving_state!=='lost')) return; // MX-only upkeep owns receiving changes after sending verifies.
    // DKIM just propagated. Give a lagging TXT its own short retry sequence instead of inheriting
    // the hours-long DKIM backoff. A domain abandoned at this step still backs off normally.
    if (shared && dkimSuccess && row.identity?.ses.DkimAttributes?.Status!=='SUCCESS' && !positive) defer(backoff(0),1);
    // A grace period must be observed again before it can expire.
    if (outcome.sending_state==='lost' || outcome.receiving_state==='lost') defer(Math.min(backoff(poll),LOST_GRACE_MS),nextPoll);
  } catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    if (e instanceof ApiError && ['SES_IDENTITY_NOT_FOUND','DOMAIN_UNAVAILABLE'].includes(e.code)) {
      await runtime.db.transaction(async db=>{
        const current=await hostedDomain(db,job.workspaceId,row.id,true);
        if (current?.token!==row.token) return;
        assertSharedAccount(runtime,current.connection);
        const ses=current.identity?.ses ?? {VerificationStatus:'PENDING'};
        const reset:IdentityFacts['ses']={...ses,VerificationStatus:'PENDING',VerifiedForSendingStatus:false,DkimAttributes:ses.DkimAttributes && {...ses.DkimAttributes,Status:'NOT_STARTED',SigningEnabled:false},MailFromAttributes:undefined};
        await saveObservation(db,current,job.workspaceId,reset,undefined,{sending:false,identityVerified:false,proven:false,unavailable:e.code==='DOMAIN_UNAVAILABLE',definitive:true});
      });
      if (e.code==='DOMAIN_UNAVAILABLE') return;
    } else if (e instanceof ApiError && e.code==='DOMAIN_DNS_UNAVAILABLE') {
      // Transport failures never count as evidence against a working domain.
      defer(Math.min(3_600_000,30_000*2**Math.min(poll,7)),nextPoll);
    } else if (!(e instanceof ApiError) || !e.retryable) {await identityQuotaAlert(runtime,row.region,row.connection.aws_account_id,e);throw e;}
  }
  defer(backoff(poll),nextPoll);
};
const domainMx:JobHandler=async(runtime,payload,job)=>{
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row?.identity || row.token!==payload.token) return;
  assertSharedAccount(runtime,row.connection);
  const checkReceiving=row.connection.legacy!==false && row.receiving_state!=='off';
  // undefined preserves the locked row's last observation and its original expiry.
  // A definitive missing/invalid/ambiguous answer must still replace it.
  // An adopted claim never publishes an ownership TXT: its proof is the operator's attestation, renewed by domain.verify.
  const [observation,dmarc,proof]=await Promise.all([checkReceiving ? receivingMx(runtime.db,row,job.workspaceId) : undefined,observeDmarc(row.name,row.identity.ses.MailFromAttributes?.MailFromDomain).catch(e=>{if(e instanceof ModuleLoadError)throw e;return undefined;}), row.connection.kind==='shared' && !row.identity.adopted && (checkReceiving || row.receiving_host) ? ownershipTxt(row.name,row.token) : undefined]);
  if(!observation && dmarc===undefined) throw dnsUnavailable();
  // A sending promotion to Virginia doesn't move the existing Ohio ingress. Re-attest the
  // original account/host in Ohio; a successful Virginia SES read is not evidence for it.
  let retainedIdentity:boolean|undefined;
  if(row.connection.kind==='shared' && row.connection.legacy===false && row.receiving_host && row.region!=='us-east-2'){
    const due=await runtime.db.execute(sql`SELECT FROM domain_claims dc JOIN mailbox_domains m ON m.workspace_id=dc.workspace_id AND m.domain_id=${row.id} AND m.region='us-east-2' AND m.status='active' AND m.receiving_host=dc.receiving_host WHERE dc.workspace_id=${job.workspaceId} AND dc.token=${row.token} AND coalesce(dc.receiving_identity_at,'-infinity')<now()-interval '24 hours'`);
    if(due.rowCount){
      if(!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES('domain.verify:platform',clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id) DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount)throw new JobDeferred(new Date(Date.now()+1500).toISOString());
      const client=await getSes({...runtime,config:{...runtime.config,regions:['us-east-2']}},'us-east-2',{...row.connection,identitySession:{name:row.name,purpose:'verify'}});
      try{const identity=await sesCall(({GetEmailIdentityCommand})=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));retainedIdentity=identity.VerificationStatus==='SUCCESS' && !!ownsIdentity(identity,row.token);}
      catch(e){if(!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND')throw e;retainedIdentity=false;}
    }
  }
  await runtime.db.transaction(async db=>{
    const current=await hostedDomain(db,job.workspaceId,row.id,true);
    if (!current?.identity || current.token!==row.token || current.receiving_host!==row.receiving_host) return;
    assertSharedAccount(runtime,current.connection);
    if(proof!==undefined) await db.execute(sql`UPDATE domain_claims SET ${observeProof(proof)} WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
    if(retainedIdentity!==undefined)await db.execute(sql`UPDATE domain_claims SET receiving_identity_at=CASE WHEN ${retainedIdentity} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
    // Never grant receiving rights (notably to a Virginia sending binding) from a DMARC check.
    if(!observation) { await db.execute(sql`UPDATE domain_claims SET identity=jsonb_set(identity,'{dmarc}',${JSON.stringify(dmarc)}::jsonb) WHERE workspace_id=${job.workspaceId} AND name=${current.name} AND token=${current.token}`); return; }
    // Without NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE nothing renews the platform attestation: receiving ends with the usual proof grace.
    const attested=!current.identity.adopted || platformClaim(runtime.config,job.workspaceId,current);
    await saveObservation(db,current,job.workspaceId,current.identity.ses,observation,{sending:undefined,identityVerified:current.identity.ses.VerificationStatus==='SUCCESS',proven:proof??(current.identity.proven && attested)},dmarc);
  });
  if(dmarc===undefined) throw dnsUnavailable(); // Retry after committing any independent MX change.
};

async function account(runtime: Runtime, wid: string, requested?: string) {
  assertSesConfigured(runtime);
  const connection=runtime.config.multiTenant ? await workspaceConnection({...runtime,config:{...runtime.config,workspaceId:wid}},requested) : undefined;
  if (connection?.kind==='shared') throw new ApiError(403,'SHARED_ACCOUNT_PRIVATE','Account-wide SES settings are not available on hosted mail.');
  const selectedRegion=connection?.template_version==='v5' && !requested ? (await getRegionSettings(runtime.db,wid)).defaultRegion : connection?.region ?? requested ?? runtime.config.regions[0]!;
  if (connection) runtime={...runtime,config:{...runtime.config,workspaceId:wid,regions:[selectedRegion]}};
  const a = await sesCall(async ({ GetAccountCommand }) => (await getSes(runtime, selectedRegion,forDelivery(connection,{purpose:'quota'}))).send(new GetAccountCommand({}))); return { region: selectedRegion, productionAccess: a.ProductionAccessEnabled === true, sendingEnabled: a.SendingEnabled === true, enforcementStatus: a.EnforcementStatus ?? 'UNKNOWN', quota: { max24HourSend: a.SendQuota?.Max24HourSend ?? 0, maxSendRate: a.SendQuota?.MaxSendRate ?? 0, sentLast24Hours: a.SendQuota?.SentLast24Hours ?? 0 } }; }
async function getWebhook(runtime: Runtime, a: Actor, webhookId: string, db: DbExecutor = runtime.db) { const [row] = await db.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))); return row ?? notFound('Webhook'); }
/**
 * Testing a sending webhook (POST /v1/webhooks/{id}/test, and a support action the customer confirmed signed in): one
 * synthetic email.delivered delivery, charged as one manual post, in the caller's transaction.
 */
export async function testSendingWebhook(runtime: Runtime, tx: DbExecutor, a: Actor, webhookId: string) {
  const endpoint = await getWebhook(runtime, a, webhookId, tx); webhookUrl(runtime, endpoint.url);
  if (endpoint.reconfirm) throw webhookNeedsUrl();
  const deliveryId = rowId('whd'), event: PublishedEvent = { id: id('evt_test'), type: 'email.delivered', createdAt: now(), workspaceId: a.workspaceId, region: null, data: { synthetic: true, test: true, message: 'Explicit webhook endpoint test. No email was sent.' } };
  await chargeManualDelivery(tx, a.workspaceId, 1); await tx.insert(deliveries).values({ id: deliveryId, workspaceId: a.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event, synthetic: true }); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId, generation: 0 } });
  return { id: deliveryId, status: 'pending' as const };
}
/** Retrying a sending-webhook delivery (POST /v1/webhooks/{id}/deliveries/{deliveryId}/retry, and a confirmed support action), in the caller's transaction. */
export async function retrySendingDelivery(runtime: Runtime, tx: DbExecutor, a: Actor, webhookId: string, deliveryId: string) {
  await getWebhook(runtime, a, webhookId, tx);
  const [row] = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, webhookId), eq(deliveries.id, deliveryId))).for('update'); if (!row) return notFound('Delivery');
  if (row.status === 'pending') throw new ApiError(409, 'DELIVERY_PENDING', 'This delivery already has a pending attempt.');
  const generation = row.generation + 1; await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(eq(deliveries.id, row.id)); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId: row.id, generation } });
  await chargeManualDelivery(tx, a.workspaceId, 1);
  return { id: deliveryId, status: 'pending' as const };
}

/** listDomains' own checks (the notMember path guard runs first): read permission and, self-hosted, a configured region with live SES. */
export function domainReader(c: Ctx, requested?: string) {
  const a = actor(c);
  if (!c.env.config.multiTenant) { region(c.env, requested ?? c.env.config.regions[0]!); assertSesConfigured(c.env); }
  return a;
}
type DomainQuery = { limit: number; region?: string; refresh: 'true' | 'false'; cursor?: string; /** The caller counts the quota in a statement of its own (getOverviewSetup). */ countedElsewhere?: boolean };
/** One page of domains as listDomains returns it. Hosted: one statement. Self-hosted: two with refresh=false, otherwise one plus an SES read per domain. */
export async function domainPage(c: Ctx, a: Actor, q: DomainQuery): Promise<z.infer<typeof DomainPage>> {
  const allowed = a.domains.length ? or(...a.domains.map(parent => or(eq(domains.name, parent), like(domains.name, `%.${parent}`)))) : undefined;
  const where = and(scoped(domains, a), allowed, q.region ? eq(domains.region, region(c.env, q.region)) : c.env.config.multiTenant ? undefined : inArray(domains.region, c.env.config.regions), q.cursor ? lt(domains.id, q.cursor) : undefined);
  if (c.env.config.multiTenant) {
    const [rows,quota]=await Promise.all([c.env.db.select({row:domains,hosts:sql<ReceivingHostRow[]>`${domainHosts(sql`${domains}`)}`,token:domainClaims.token,proof_label:domainClaims.proofLabel,claim_scope:domainClaims.claimScope,sending_state:domainClaims.sendingState,receiving_state:domainClaims.receivingState,receiving_host:domainClaims.receivingHost,receiving_proved_at:sql<string>`domain_claims.receiving_proved_at`,receiving_identity_at:sql<string>`domain_claims.receiving_identity_at`,receiving_proof_missed_at:sql<string>`domain_claims.receiving_proof_missed_at`,lost_since:domainClaims.lostSince,receiving_lost_since:domainClaims.receivingLostSince,identity:domainClaims.identity,created_at:domainClaims.createdAt,ever_proven:domainClaims.everProven,setup_check:sql<SetupCheck|null>`domain_claims.setup_check`,kind:sql<'shared'|'byo'>`pc.kind`,legacy:sql<boolean>`pc.legacy`}).from(domains)
      .innerJoin(domainClaims,and(eq(domainClaims.name,domains.name),eq(domainClaims.workspaceId,domains.workspaceId)))
      .innerJoin(sql`regional_connections pc`,sql`pc.id=${domainClaims.connectionId} AND pc.workspace_id=${domains.workspaceId} AND pc.region=${domains.region} AND ${connectionReady()}`)
      .where(where).orderBy(desc(domains.id)).limit(q.limit+1),a.domains.length || q.countedElsewhere ? undefined : domainQuota(c.env.db,a.workspaceId)]);
    return {data:rows.slice(0,q.limit).map(r=>derivedReadiness({...r,...r.row,connection:{kind:r.kind,legacy:r.legacy}})),nextCursor:rows.length>q.limit?rows[q.limit-1]!.row.id:null,...quota && quota.limit !== null ? {quota:{used:quota.used,limit:quota.limit}} : {}};
  }
  const rows = await c.env.db.select({row:domains,mx:mailboxDomains.mx,status:mailboxDomains.status}).from(domains).leftJoin(mailboxDomains,and(eq(mailboxDomains.workspaceId,domains.workspaceId),eq(mailboxDomains.domainId,domains.id),isNull(mailboxDomains.parentId))).where(where).orderBy(desc(domains.id)).limit(q.limit + 1);
  if (q.refresh === 'false') {
    const reports = await c.env.db.select({ region: sesRegions.region, report: sesRegions.report }).from(sesRegions).where(eq(sesRegions.workspaceId, a.workspaceId));
    const data = rows.slice(0, q.limit).map(({row,mx,status}) => {
      const cached = reports.find(report => report.region === row.region)?.report?.domains.find(domain => domain.name === row.name);
      const ready = cached?.verificationStatus === 'SUCCESS' && cached.sendingEnabled === true, verified = cached?.sendingEnabled === true;
      return { ...readiness(row,{},undefined,mx),verificationStatus: cached?.verificationStatus ?? 'NOT_STARTED', verified, dkimStatus: ready ? 'SUCCESS' : 'NOT_STARTED', ready,sending:state(ready),receiving:state(status==='active' && mx?.state==='active' && verified),dnsUnavailableReason: 'Open the domain to refresh DNS details.' };
    });
    return { data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null };
  }
  const data: z.infer<typeof domainSchema>[] = [];
  for (const {row,mx,status} of rows.slice(0, q.limit)) {
    if (data.length) await new Promise(resolve => setTimeout(resolve, 1000));
    const identity=await sesCall(async ({ GetEmailIdentityCommand })=>(await getSes(c.env,row.region)).send(new GetEmailIdentityCommand({ EmailIdentity:row.name })));
    const report=readiness(row,identity,undefined,mx,undefined,await localDmarc(row.name,identity.MailFromAttributes?.MailFromDomain));if(status!=='active')report.receiving='pending';data.push(report);
  }
  return { data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null };
}

export function registerOperations(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/workspace', operationId: 'getWorkspaceSettings', tags: ['Settings'], security, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c); const { rows: [row] } = await c.env.db.execute<{ name: string | null; postal_address: string | null; required_notices: boolean }>(c.env.config.multiTenant
      ? sql`SELECT name,postal_address,${requiredNoticesOf(a.workspaceId)} AS required_notices FROM workspaces WHERE id=${a.workspaceId}`
      : sql`SELECT s.name,s.postal_address,${requiredNoticesOf(a.workspaceId)} AS required_notices FROM (SELECT) one LEFT JOIN operation_settings s ON s.workspace_id=${a.workspaceId}`);
    return c.json({ name: row?.name ?? productName, postalAddress: row?.postal_address ?? null, requiredNotices: row?.required_notices ?? false }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/settings/workspace', operationId: 'updateWorkspaceSettings', description: 'Change the workspace\'s name, its postal address, or both; omitted fields keep their value. The postal address appears under the Unsubscribe link of every campaign email and marketing send, as US law (CAN-SPAM) requires: campaigns can\'t be sent or scheduled without one (422 POSTAL_ADDRESS_REQUIRED). null removes it. Owners and admins only.', tags: ['Settings'], security,
    request: { body: json(z.object({ name: z.string().trim().min(1).max(120).optional(), postalAddress: PostalAddress.nullable().optional() }).refine(body => body.name !== undefined || body.postalAddress !== undefined, 'Send name, postalAddress or both.')
      .openapi('UpdateWorkspaceSettings', { example: { postalAddress: 'Example Inc.\n1 Main Street\nSpringfield, IL 62701' } })) }, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), input = c.req.valid('json');
    // Each line trimmed, empty ones dropped, so the footer shows exactly what was meant.
    const name = input.name ?? null, address = input.postalAddress === undefined ? undefined : input.postalAddress === null ? null : postalAddressText(input.postalAddress);
    const fields = [...input.name !== undefined ? ['name'] : [], ...address !== undefined ? ['postalAddress'] : []];
    const setAddress = address !== undefined;
    const audit = auditInsert(auditContext(c), { action: 'settings.update', workspaceId: a.workspaceId, target: { type: 'workspace', id: a.workspaceId },
      before: sql`(SELECT jsonb_strip_nulls(jsonb_build_object('name',CASE WHEN ${name}::text IS NOT NULL THEN name END,'postalAddress',CASE WHEN ${setAddress}::boolean THEN coalesce(postal_address,'') END)) FROM old)`,
      after: { ...input.name !== undefined ? { name: input.name } : {}, ...setAddress ? { postalAddress: address ?? '' } : {} }, details: { fields } }, { from: sql`changed` });
    const { rows: [row] } = await c.env.db.execute<{ name: string; postal_address: string | null; required_notices: boolean }>(c.env.config.multiTenant
      ? sql`WITH old AS (SELECT name,postal_address FROM workspaces WHERE id=${a.workspaceId}), changed AS (UPDATE workspaces SET name=coalesce(${name}::text,name),
        postal_address=CASE WHEN ${setAddress}::boolean THEN ${address ?? null}::text ELSE postal_address END WHERE id=${a.workspaceId} RETURNING name,postal_address,required_notices), audit AS (${audit}) SELECT * FROM changed`
      : sql`WITH old AS (SELECT name,postal_address FROM operation_settings WHERE workspace_id=${a.workspaceId}), changed AS (INSERT INTO operation_settings(workspace_id,name,postal_address)
        VALUES (${a.workspaceId},coalesce(${name}::text,${productName}),${address ?? null}::text) ON CONFLICT ON CONSTRAINT operation_settings_pkey DO UPDATE SET name=coalesce(${name}::text,operation_settings.name),
        postal_address=CASE WHEN ${setAddress}::boolean THEN excluded.postal_address ELSE operation_settings.postal_address END,updated_at=now() RETURNING name,postal_address), audit AS (${audit}) SELECT *,${requiredNoticesOf(a.workspaceId)} AS required_notices FROM changed`);
    return c.json({ name: row?.name ?? input.name ?? productName, postalAddress: row?.postal_address ?? null, requiredNotices: row?.required_notices ?? false }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/ses', operationId: 'getSesSettings', tags: ['Settings'], security, request: { query: regionQuery }, responses: { 200: response(accountSchema), ...errors } }), async c => { const a = workspaceActor(c); return c.json(await account(c.env,a.workspaceId,c.req.valid('query').region), 200); });
  app.openapi(createRoute({ method: 'get', path: '/v1/domains', operationId: 'listDomains', description: 'MX returns persisted DNS records and background verification status without AWS calls. Self-hosted installations refresh up to ten identities unless refresh=false.', tags: ['Domains'], security, request: { query: PageQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(5), region: z.string().optional(), refresh: z.enum(['true', 'false']).default('true') }).openapi('ListDomainsQuery') }, responses: { 200: response(DomainPage), ...errors } }), async c => {
    const q = c.req.valid('query');
    return c.json(await domainPage(c, domainReader(c, q.region), q), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains', operationId: 'createDomain', tags: ['Domains'], security, request: { body: json(z.object({ name: claimName, region: z.string().optional().describe('Regional BYO defaults to the first enabled region, otherwise Ohio.') }).openapi('CreateDomain')) }, responses: { 201: response(domainSchema),202:response(RegionalAccepted), ...errors } }), async c => {
    const a = actor(c, 'manage'); const input = c.req.valid('json'); allowedDomain(a, input.name, true);
    if (c.env.config.multiTenant) {
      const pending=await (await wrapModuleLoad(() => import('./byo-regional.js'))).newRegionalDomain(c.env,a.workspaceId,input.name,a.credential==='dashboard' && (a.role==='owner' || a.role==='admin'),input.region,c.req.header('Idempotency-Key'));
      if (pending) {a.wakeJobs=1;return c.json(pending,202);}
      await Promise.all([preloadSesTransport(true), loadOperationsSesv2(), loadRegistries()]);
      // A new claim and its audit row are one statement; a retried or reconnected claim writes none.
      const claim=await reserveClaim(c.env,a.workspaceId,input.name,input.region,reserved=>auditInsert(auditContext(c),{action:'domain.create',workspaceId:a.workspaceId,target:{type:'domain',id:sql`${reserved}.id`},
        after:sql`jsonb_build_object('name',${input.name}::text,'region',${reserved}.connection->>'region')`},{from:reserved,where:sql`${reserved}.fresh AND ${reserved}.id IS NOT NULL AND ${reserved}.error_code IS NULL`})),
        row={name:input.name,region:claim.connection.region,id:claim.id};
      if (claim.claim.identity) return c.json(derivedReadiness({...row,...claim.claim,token:claim.token,connection:claim.connection}),201);
      a.wakeJobs=1;
      const runtime={...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}};
      // The reservation already queued the verify job, which creates the identity itself if this request dies here.
      let identity: Partial<GetEmailIdentityCommandOutput>|null|undefined;
      try {
        const client=await getSes(runtime,row.region,claim.connection);
        identity=await recoverIdentity(runtime,a.workspaceId,row.id,claim.token,client);
      }
      catch(e) {
        if (e instanceof ModuleLoadError) throw e;
        await identityQuotaAlert(runtime,row.region,claim.connection.aws_account_id,e);
        if (e instanceof ApiError && (e.code==='DOMAIN_UNAVAILABLE' || (claim.fresh && !e.retryable && e.status<500))) await releaseClaim(c.env.db,a.workspaceId,claim);
        throw e;
      }
      if (identity===null) return c.json(derivedReadiness({...row,...claim.claim,token:claim.token,connection:claim.connection,dns_first:true}),201);
      if (!identity) throw new ApiError(409,'DOMAIN_CLAIM_EXPIRED','The domain claim is no longer active.');
      const facts=identityOnly(sesFacts({...identity,VerificationStatus:'PENDING'}));
      // Never overwrite a verifier that already recovered a lost/slow Create response.
      const saved=sql`UPDATE domain_claims SET identity=${JSON.stringify(facts)}::jsonb WHERE token=${claim.token} AND name=${row.name} AND identity IS NULL ${claim.connection.kind==='shared' && runtime.config.platformAccount ? sql`AND EXISTS(SELECT FROM provider_connections c WHERE c.id=connection_id AND (c.aws_account_id IS NULL OR c.aws_account_id=${runtime.config.platformAccount}))` : sql``} RETURNING ${row.id}::text AS id,token`;
      await c.env.db.execute(claim.fresh ? saved : sql`WITH recovered AS (${saved}) ${recheckJob(a.workspaceId,sql`SELECT id,token FROM recovered`,'supersede')}`);
      return c.json(derivedReadiness({...row,...claim.claim,identity:facts,token:claim.token,connection:claim.connection}),201);
    }
    assertSesConfigured(c.env);
    const body = { name: input.name, region: input.region ?? c.env.config.regions[0]! };
    const client = await getSes(c.env, body.region); let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity = await sesCall(({ GetEmailIdentityCommand }) => client.send(new GetEmailIdentityCommand({ EmailIdentity: body.name }))); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SES_IDENTITY_NOT_FOUND') throw error;
    }
    if (!identity) {
      try { await sesCall(({ CreateEmailIdentityCommand }) => client.send(new CreateEmailIdentityCommand({ EmailIdentity: body.name, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } }))); }
      catch (createError) { if (!(createError instanceof ApiError) || createError.code !== 'SES_IDENTITY_EXISTS') throw createError; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const { rows: [row] } = await c.env.db.execute<DomainRef>(sql`WITH saved AS (INSERT INTO operation_domains(id,workspace_id,name,region)
      VALUES (${id('dom')},${a.workspaceId},${body.name},${body.region}) ON CONFLICT ON CONSTRAINT operation_domain_scope
      DO UPDATE SET updated_at=now() RETURNING id,name,region,xmax=0 AS created),
      audit AS (${auditInsert(auditContext(c),{action:'domain.create',workspaceId:a.workspaceId,target:{type:'domain',id:sql`saved.id`},after:body},{from:sql`saved`,where:sql`saved.created`})})
      SELECT id,name,region FROM saved`);
    return c.json(await domainReadiness(c.env, row!, identity,'create'), 201);
  });
  // Sets (mailFromDomain) or removes (null) a domain's custom MAIL FROM. Removing it calls SES without a MailFromDomain, which
  // returns the identity to the default amazonses.com MAIL FROM, and drops its MX and SPF records and SPF alignment. Removing
  // a MAIL FROM that isn't set changes nothing.
  async function putMailFrom(c: Ctx, domainId: string, mailFromDomain: string | null) {
    const a = actor(c, 'manage'); const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, domainId)));
    if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    if (mailFromDomain !== null && (mailFromDomain === row.name || !mailFromDomain.endsWith(`.${row.name}`))) throw new ApiError(422, 'MAIL_FROM_DOMAIN_INVALID', `Use a subdomain of ${row.name}.`, 'mailFromDomain');
    const mailFromAudit = { action: mailFromDomain ? 'domain.mail_from' : 'domain.mail_from_remove', workspaceId: a.workspaceId, target: { type: 'domain', id: row.id }, after: { name: row.name, mailFromDomain } };
    const put = (client: Awaited<ReturnType<typeof getSes>>) => sesCall(({ PutEmailIdentityMailFromAttributesCommand }) => client.send(new PutEmailIdentityMailFromAttributesCommand(mailFromDomain ? { EmailIdentity: row.name, MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' } : { EmailIdentity: row.name })));
    if (c.env.config.multiTenant) {
      const report=await c.env.db.transaction(async db=>{
        const current=await hostedDomain(db,a.workspaceId,row.id,true) ?? notFound('Domain');
        // The receiving host's MX points to inbound-smtp; a MAIL FROM subdomain needs its own MX to feedback-smtp. One name can't hold both.
        const receivingHosts=new Set([...derivedReadiness(current).dns.filter(r=>r.purpose==='receiving').map(r=>r.name),...current.hosts.filter(h=>h.status!=='disabled').map(h=>h.host)]);
        if (mailFromDomain && receivingHosts.has(mailFromDomain)) throw new ApiError(409,'MAIL_FROM_RECEIVING_CONFLICT',`${mailFromDomain} is one of ${row.name}’s receiving hosts, so its MX points to inbound-smtp.${row.region}.amazonaws.com. A custom MAIL FROM subdomain needs its own MX to feedback-smtp.${row.region}.amazonses.com. Use another subdomain, such as email.${row.name}.`);
        const client=await getSes({...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}},row.region,{...current.connection,identitySession:{name:row.name,purpose:'mailFrom'}});
        if (current.identity?.imported) throw new ApiError(409,'IMPORTED_IDENTITY_READ_ONLY','Manage this imported identity’s MAIL FROM settings in AWS.');
        const identity=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
        if (!ownsIdentity(identity,current.token)) throw unavailableDomain();
        const known=current.identity ?? identityOnly(sesFacts(identity)), ses={...(current.identity?.ses ?? sesFacts(identity))};
        if (!mailFromDomain && !identity.MailFromAttributes?.MailFromDomain && !ses.MailFromAttributes?.MailFromDomain) return derivedReadiness(current);
        await put(client);
        // Changing MAIL FROM is a new fact, not a state change: ownership, sending and routing stay as they are.
        if (mailFromDomain) ses.MailFromAttributes={MailFromDomain:mailFromDomain,MailFromDomainStatus:'PENDING',BehaviorOnMxFailure:'USE_DEFAULT_VALUE'};
        else delete ses.MailFromAttributes;
        const facts:IdentityFacts={...known,ses,...(!mailFromDomain && known.dmarc ? {dmarc:{...known.dmarc,alignedMailFrom:null}} : {})};
        await db.execute(sql`WITH saved AS (UPDATE domain_claims SET identity=${JSON.stringify(facts)}::jsonb WHERE token=${current.token} AND connection_id=${current.connection.id} RETURNING ${current.id}::text AS id,token)
          ${recheckJob(a.workspaceId,sql`SELECT id,token FROM saved`,'supersede')}`);
        await recordAudit(db,c,mailFromAudit);
        return derivedReadiness({...current,identity:facts});
      }); a.wakeJobs=1; return report;
    }
    const client = await getSes(c.env, row.region);
    if (!mailFromDomain) {
      const identity = await sesCall(({ GetEmailIdentityCommand }) => client.send(new GetEmailIdentityCommand({ EmailIdentity: row.name })));
      if (!identity.MailFromAttributes?.MailFromDomain) return domainReadiness(c.env, row, identity);
    }
    // The change is in SES, not in a database row. Fail closed: the audit row is written first and committed only once SES
    // accepted the change, so a change without its row needs a lost commit (the client then sees 500 and retries).
    await c.env.db.transaction(async tx => {
      await recordAudit(tx, c, mailFromAudit);
      await put(client);
    });
    return domainReadiness(c.env, row);
  }
  app.openapi(createRoute({ method: 'post', path: '/v1/domains/{id}/mail-from', operationId: 'configureDomainMailFrom', tags: ['Domains'], security, description: 'Configure a custom SES MAIL FROM subdomain with fallback to the default amazonses.com MAIL FROM value while DNS is unavailable.', request: { params: IdParams, body: json(z.object({ mailFromDomain: domainName }).strict().openapi('ConfigureDomainMailFrom')) }, responses: { 200: response(domainSchema), ...errors } }), async c =>
    c.json(await putMailFrom(c, c.req.valid('param').id, c.req.valid('json').mailFromDomain), 200));
  app.openapi(createRoute({ method: 'delete', path: '/v1/domains/{id}/mail-from', operationId: 'removeDomainMailFrom', tags: ['Domains'], security, description: 'Remove the custom MAIL FROM subdomain. Mail goes back to the default amazonses.com MAIL FROM, and the MAIL FROM MX and SPF records are no longer needed. Removing a MAIL FROM that isn\'t set changes nothing and returns the domain.', request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c =>
    c.json(await putMailFrom(c, c.req.valid('param').id, null), 200));
  app.openapi(createRoute({method:'post',path:'/v1/domains/{id}/receiving-host',operationId:'chooseReceivingHost',tags:['Domains'],security,
    description:`Hosted only. Choose a host for this domain to receive on, its root or one of its subdomains. Until the domain receives anywhere, the choice replaces the automatic suggestion (the first of reply., inbound., mail. and so on with no MX and no CNAME), and null returns to it. Once it receives, the chosen host is added beside the hosts it already receives on, as POST /v1/inbound/domains/{id}/hosts does: nothing that receives is moved or stopped. Public DNS is checked first. A CNAME (RFC 1034), one of ${productName}’s own names (custom MAIL FROM, ownership TXT, DKIM), a host another domain receives on (in any workspace), a name another workspace has claimed (send-only included) or a delegated zone (its own NS records) is refused with a free subdomain to use instead. A host whose mail another provider receives, or whose MX is split, needs confirm: true, because publishing ${productName}’s MX moves that mail. A wildcard (*.domain) answer only flags receivingIssue. Nothing changes in DNS or SES.`,
    request:{params:IdParams,body:json(z.object({host:domainName.nullable(),confirm:z.boolean().default(false)}).strict().openapi('ChooseReceivingHost'))},
    responses:{200:response(domainSchema),...errors}}),async c=>{
    const a=actor(c,'manage'); lasting(c,RECEIVING_HOST_CHANGE); if (!c.env.config.multiTenant) return notFound('Endpoint');
    const {host,confirm}=c.req.valid('json'), domainId=c.req.valid('param').id;
    // DNS is read before the row lock; the locked write is fenced on the claim token.
    const row=await hostedDomain(c.env.db,a.workspaceId,domainId) ?? notFound('Domain'); allowedDomain(a,row.name);
    if (host!==null && host!==row.name && !host.endsWith(`.${row.name}`)) throw new ApiError(422,'RECEIVING_HOST_INVALID',`Use ${row.name} or one of its subdomains.`,'host');
    if (host!==null && reservedPlatformName(host,c.env.config)) throw new ApiError(409,'RECEIVING_HOST_RESERVED',`${host} is one of ${productName}’s own hosts, so it can’t receive mail for ${row.name}.`,'host');
    // Once the domain receives somewhere (or the owner removed its own host), a chosen host goes beside the others.
    const established=establishedHost(row), own=row.hosts.find(h=>h.own);
    if (established || own?.status==='disabled' || (host!==null && row.hosts.some(h=>h.host===host && h.status!=='disabled'))) {
      if (host!==null && host!==established) await (await wrapModuleLoad(() => import('./receiving-hosts.js'))).addChosenHost(c,a.workspaceId,row,host,confirm).catch((e:unknown)=>{
        if (e instanceof ApiError && e.field==='name') throw new ApiError(e.status,e.code,e.message,'host',e.retryable);
        throw e;
      });
      return c.json(derivedReadiness(await hostedDomain(c.env.db,a.workspaceId,domainId) ?? notFound('Domain')),200);
    }
    let facts:Partial<IdentityFacts>={receivingChoice:null,issue:null};
    if (host!==null) {
      const {mx,issue}=await inspectReceivingHost(c.env.db,row,a.workspaceId,host,dnsUnavailable);
      if (issue?.code==='cname') throw new ApiError(409,'RECEIVING_HOST_CNAME',issue.message,'host');
      if (issue?.code==='bane_record') throw new ApiError(409,'RECEIVING_HOST_RESERVED',issue.message,'host');
      if (issue?.code==='host_taken') throw new ApiError(409,'RECEIVING_HOST_TAKEN',issue.message,'host');
      if (issue?.code==='claimed') throw new ApiError(409,'RECEIVING_HOST_CLAIMED',issue.message,'host');
      if (issue?.code==='delegated') throw new ApiError(409,'RECEIVING_HOST_DELEGATED',issue.message,'host');
      if (issue && ['foreign_mx','split','wrong_region','null_mx'].includes(issue.code) && !confirm)
        throw new ApiError(409,'RECEIVING_HOST_IN_USE',`Move mail for ${host}? ${issue.message} Send confirm: true to choose it anyway.`,'host');
      facts={receivingChoice:host,mx,issue};
    }
    const saved=await c.env.db.transaction(async db=>{
      const current=await hostedDomain(db,a.workspaceId,domainId,true);
      if (!current || current.token!==row.token || establishedHost(current)!==null) throw new ApiError(409,'DOMAIN_CHANGED','The domain changed while its DNS was checked. Try again.',undefined,true);
      const identity:IdentityFacts={...(current.identity ?? identityOnly({VerificationStatus:'PENDING'})),...facts,...(host===null ? {mx:null} : {})};
      await db.execute(sql`UPDATE domain_claims SET identity=${JSON.stringify(identity)}::jsonb WHERE workspace_id=${a.workspaceId} AND name=${current.name} AND token=${current.token}`);
      await recordAudit(db,c,{action:'domain.receiving_host',workspaceId:a.workspaceId,target:{type:'domain',id:domainId},before:{receivingChoice:current.identity?.receivingChoice ?? null},after:{name:current.name,receivingChoice:host}});
      return derivedReadiness({...current,identity});
    });
    return c.json(saved,200);
  });
  const dashboardSecurity=[{dashboardSession:[]},{secureDashboardSession:[]}] as Record<string,string[]>[];
  // The guarantee is the server's, not the dashboard's: no recipient or content is accepted, only the domain.
  app.openapi(createRoute({method:'post',path:'/v1/domains/{id}/test-send',operationId:'sendDomainTestEmail',tags:['Domains'],security:dashboardSecurity,
    description:'Dashboard only. Sends a fixed test email from hello@<domain> to the signed-in user’s own address; it takes no recipient, subject or body. Needs send permission and a verified domain, and counts like any other send. Use an Idempotency-Key to make a retry safe.',
    request:{params:IdParams},responses:{202:response(z.object({id:z.string(),status:z.literal('queued'),simulated:z.boolean()}).openapi('TestEmailQueued')),...errors}}),async c=>{
    const a=actor(c,'send');
    if (a.credential!=='dashboard' || !a.email) throw denied('DASHBOARD_SESSION_REQUIRED','Sign in to the dashboard to send a test email to yourself.',{ permission: 'sendEmail', level: 'on', credential: 'dashboard' });
    const [row]=await c.env.db.select({name:domains.name}).from(domains).where(and(scoped(domains,a),eq(domains.id,c.req.valid('param').id)));
    if (!row) return notFound('Domain');
    allowedDomain(a,row.name);
    const { admitTestEmail }=await wrapModuleLoad(() => import('./sending.js'));
    return c.json(await admitTestEmail(c,a,row.name,a.email),202);
  });
  const dnsSetup='/v1/domains/{id}/dns-setup';
  const dnsGroup=`(${groupIds.join('|')})`;
  app.openapi(createRoute({method:'get',path:dnsSetup,operationId:'getDomainDnsSetup',tags:['Domains'],security:dashboardSecurity,
    description:'MX owner/admin dashboard only. Returns a signed provider consent URL for eligible pending records, never changes DNS itself. Inline discovery has a three-second budget; unsupported providers and discovery failures fall back to manual DNS. Receiving is offered only after DNS checks find the target empty.',
    request:{params:IdParams,query:z.object({groups:z.string().max(64).regex(new RegExp(`^${dnsGroup}(,${dnsGroup})*$`)).optional().describe('Optional comma-separated subset of pending groups. Only one receiving target is eligible: receiving (@) or receivingReply (reply). mailfrom is available only for email.<domain>; other MAIL FROM names use manual DNS.')})},
    responses:{200:response(z.object({provider:z.object({id:z.string(),name:z.string()}).nullable(),applyUrl:z.url().nullable(),groups:z.array(z.enum(groupIds))}).openapi('DomainDnsSetup')),...errors}}),async c=>{
    const a=dnsSetupActor(c), wid=a.workspaceId, id=c.req.valid('param').id;
    const row=await hostedDomain(c.env.db,wid,id) ?? notFound('Domain');
    const found=await discover(row.name);
    const selection=pendingGroups(derivedReadiness(row),row.connection.kind==='shared',row.claim_scope!=='account' && (row.connection.kind==='byo' || row.pool_receiving) && row.identity?.mx?.state==='missing',row.sending_state==='failed' ? [] : c.req.valid('query').groups?.split(','));
    const provider=found && {id:found.id,name:found.name}, applyUrl=found && signedApply(c.env.config,found,row,selection,wid,a.keyId.slice(5));
    return c.json({provider,groups:selection.groups,applyUrl},200);
  });
  app.openapi(createRoute({method:'get',path:`${dnsSetup}/return/{token}`,operationId:'completeDomainDnsSetup',tags:['Domains'],security:dashboardSecurity,
    description:'Browser return from Domain Connect. Validates the ten-minute signed token and the initiating user’s current owner/admin membership in the workspace owning the domain, restores that workspace and returns to the domain page. An invalid or expired token returns to the domain page without changing anything. Success queues normal DNS/SES verification; a replay cannot create a second job. Provider approval is not proof.',
    request:{params:IdParams.extend({token:z.string().max(1600)}),query:z.object({state:z.string().max(1600).optional(),error:z.string().max(128).optional()})},
    responses:{303:{description:'Return to the domain in its original workspace.'},...errors}}),async c=>{
    if(!c.env.config.multiTenant) return notFound('Endpoint');
    const {id,token}=c.req.valid('param'), {state,error}=c.req.valid('query');
    // An expired or foreign token changes nothing but still lands on the domain page: the provider has
    // already applied the records by now, and the page's own polling picks up verification.
    const claim=verifyReturn(c.env.config.authSecret,token);
    // The page reopens in the workspace of the setup and, when this browser has a live session for the account that
    // started it (a browser can hold several), as that account. Nothing else names an account in the URL.
    const back=(account?:string)=>c.redirect(`${c.env.config.publicUrl}/domains/${encodeURIComponent(id)}${account?`?account=${encodeURIComponent(account)}`:''}`,303);
    if(!claim || claim.domainId!==id || (state!==undefined && state!==token)) return back();
    // A session that ended while the user was at the provider also goes back; the dashboard asks them to sign in.
    // The return is a navigation without the tab's X-Nightmail-Account: act as the initiating account's own session.
    const { verifiedDashboardUser } = await wrapModuleLoad(() => import('./dashboard-auth.js'));
    const headers=new Headers(c.req.raw.headers); headers.set(requestHeaderNames('account')[0]!,claim.userId);
    const user=await verifiedDashboardUser(c.env,headers).catch((e:unknown)=>{ if(e instanceof ApiError && (e.status===401 || e.status===403)) return null; throw e; });
    if(!user || claim.userId!==user.userId) return back();
    const {userId}=user;
    const wid=claim.workspaceId;
    const result=await c.env.db.execute(sql`WITH target AS (SELECT d.id,d.token FROM (${hostedDomainSelect(wid,id,sql`FOR SHARE OF dc`)}) d
      JOIN workspace_members m ON m.user_id=${userId} AND m.workspace_id=${wid} AND m.role IN ('owner','admin') FOR SHARE OF m),
      selected AS (UPDATE nightmail_users SET selected_workspace_id=${wid} WHERE id=${userId} AND selected_workspace_id IS DISTINCT FROM ${wid} AND EXISTS(SELECT 1 FROM target)),
      queued AS (${recheckJob(wid,sql`SELECT id,token FROM target WHERE ${error===undefined}`)}) SELECT 1 FROM target`);
    if(!result.rowCount) throw denied('PERMISSION_DENIED','Domain setup requires owner or admin access to the original workspace and domain.',{ permission: 'configuration', level: 'write', person: 'admin' });
    return back(userId);
  });
  for (const verifyRoute of [false, true]) app.openapi(createRoute({ method: verifyRoute ? 'post' : 'get', path: verifyRoute ? '/v1/domains/{id}/verify' : '/v1/domains/{id}', operationId: verifyRoute ? 'verifyDomain' : 'getDomain', description: verifyRoute ? 'On MX, request a background verification and return the current stored status, with what public DNS shows now for each pending sending and MAIL FROM record (dns[].publicDns), so a missing or mistyped record can be named, and where the domain\'s DNS is hosted (dnsHost). Read the domain again for updates.' : 'On MX, read the stored DNS records and verification status without an AWS call.', tags: ['Domains'], security, request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, verifyRoute ? 'manage' : 'read');
    // Check now: what public DNS shows now for each pending record, and where the zone is hosted. A Hosted domain the
    // background check already follows (a stored check, domain-setup.ts) keeps this answer, so its banner moves with it.
    const checked = async (report: Readiness) => {
      const stored = c.env.config.multiTenant && report.sending === 'pending' && report.dnsHost !== undefined;
      const check = await (await wrapModuleLoad(() => import('./record-check.js'))).checkSetup(report);
      if (check.records.length) report.dnsHost = check.host;
      if (stored) await c.env.db.execute(sql`UPDATE domain_claims SET setup_check=${JSON.stringify(check)}::jsonb WHERE workspace_id=${a.workspaceId} AND name=${report.name} AND sending_state='pending' AND setup_check IS NOT NULL`);
      return report;
    };
    if (c.env.config.multiTenant) {
      if (verifyRoute) return c.json(await checked(await verifyHostedDomain(c.env,a,c.req.valid('param').id)),200);
      const mode=a.credential==='dashboard' && c.req.method==='GET' ? 'dashboard' : undefined;
      const row=await hostedDomain(c.env.db,a.workspaceId,c.req.valid('param').id,false,mode ? {domains:a.domains,mode,platformAccount:c.env.config.platformAccount} : undefined) ?? notFound('Domain'); allowedDomain(a,row.name);
      // A stale dashboard may read persisted facts; its opportunistic recheck was fenced in SQL.
      if (row.queued) a.wakeJobs=1;
      return c.json(derivedReadiness(row),200);
    }
    const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id))); if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    const report = await domainReadiness(c.env,row,undefined,verifyRoute?'verify':'read');
    return c.json(verifyRoute ? await checked(report) : report, 200);
  });
  app.openapi(createRoute({method:'delete',path:'/v1/domains/{id}',operationId:'deleteDomain',tags:['Domains'],security,description:'MX only. Delete this claim’s tagged SES identity and release the domain. Does not remove DNS records.',request:{params:IdParams},responses:{200:response(z.object({deleted:z.literal(true)})),...errors}}),async c=>{
    const a=actor(c,'manage'); if (!c.env.config.multiTenant) return notFound('Endpoint');
    await c.env.db.transaction(async db=>{
      const row=await hostedDomain(db,a.workspaceId,c.req.valid('param').id,true);
      if (!row) {
        // A claim whose connection is gone has no SES identity to own; releasing it only frees the name.
        const detached=(await db.execute<{id:string;name:string;token:string}>(sql`SELECT d.id,d.name,dc.token FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
          WHERE d.workspace_id=${a.workspaceId} AND d.id=${c.req.valid('param').id} AND dc.connection_id IS NULL FOR UPDATE OF dc`)).rows[0] ?? notFound('Domain');
        allowedDomain(a,detached.name); await releaseClaim(db,a.workspaceId,detached);
        return recordAudit(db,c,{action:'domain.delete',workspaceId:a.workspaceId,target:{type:'domain',id:detached.id},before:{name:detached.name}});
      }
      allowedDomain(a,row.name);
      if (!row.identity?.imported) {
        await deleteClaimIdentity(c.env,a.workspaceId,row);
        if (row.connection.kind==='byo' && row.connection.legacy===false) await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=(
          SELECT coalesce(jsonb_agg(e ORDER BY n),'[]') FROM jsonb_array_elements(ownership_journal) WITH ORDINALITY entries(e,n) WHERE NOT e @> ${JSON.stringify(identityJournalEntry(row))}::jsonb)
          WHERE connection_id=${row.connection.id} AND region=${row.region} AND NOT legacy`);
      }
      await releaseClaim(db,a.workspaceId,row);
      if (row.connection.kind==='byo' && row.receiving_host) await (await wrapModuleLoad(() => import('./mailbox-setup.js'))).queueReconcile(db,a.workspaceId,row.region);
      await recordAudit(db,c,{action:'domain.delete',workspaceId:a.workspaceId,target:{type:'domain',id:row.id},before:{name:row.name,region:row.region,receivingHost:row.receiving_host}});
    }); return c.json({deleted:true as const},200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks', operationId: 'listWebhooks', tags: ['Webhooks'], security, request: { query: PageQuery }, responses: { 200: response(listSchema(webhookSchema, 'WebhookPage')), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'); const rows = await c.env.db.select().from(webhooks).where(and(scoped(webhooks, a), q.cursor ? lt(webhooks.id, q.cursor) : undefined)).orderBy(desc(webhooks.id)).limit(q.limit + 1);
    return c.json({ data: await Promise.all(rows.slice(0, q.limit).map(row => metadata(c.env, row, a))), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  // The signing secret comes back once with the new endpoint, like an API key, so a first delivery can be verified
  // without a rotation; revealWebhookSecret reads it again later and rotateWebhookSecret replaces it.
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks', operationId: 'createWebhook', tags: ['Webhooks'], security, description: 'Create an endpoint for email events. The response includes the signing secret (whsec_…) used for the Webhook-Signature header; store it on your server. Deliveries follow Standard Webhooks: Webhook-Signature is v1,<base64 HMAC-SHA256 of "{Webhook-Id}.{Webhook-Timestamp}.{raw body}"> keyed with the base64 bytes after whsec_. Set up over MCP, or with a key that was, it is tied to that approval: approval and nextStep in the result say until when.', request: { body: json(webhookInput) }, responses: { 201: response(webhookSchema.extend({ secret: z.string().describe('The signing secret, whsec_ followed by 32 base64 bytes. Read it again with revealWebhookSecret.'), nextStep: z.string().optional().describe('Only for a webhook tied to an MCP approval: what it depends on and how to make a lasting one.') }).openapi('CreatedWebhook')), ...errors } }), async c => {
    const a = webhookManager(c), { headers, ...body } = c.req.valid('json'), webhookId = id('wh'); const url = webhookUrl(c.env, body.url), binding = secretBinding(a, webhookId), secret = webhookSecret();
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const values = { ...body, id: webhookId, workspaceId: a.workspaceId, url, regions: body.regions ?? null, encryptedSecret: await encrypt(c.env, secret, binding), encryptedHeaders: await encryptWebhookHeaders(c.env, headers, binding) };
    const [row] = await c.env.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(140913,hashtext(${a.workspaceId}))`);
      if ((await tx.execute(sql`SELECT 1 FROM operation_webhooks WHERE workspace_id=${a.workspaceId} OFFSET 9 LIMIT 1`)).rowCount) throw new ApiError(409,'WEBHOOK_LIMIT_REACHED','A workspace can have at most 10 operation webhook endpoints (including paused endpoints).');
      await ownWebhook(c, tx, a, webhookId);
      const created = await tx.insert(webhooks).values(values).returning();
      await recordSecret(tx, a, webhookId, 'created');
      await recordAudit(tx, c, { action: 'webhook.create', workspaceId: a.workspaceId, target: { type: 'webhook', id: webhookId }, after: { url: webhookUrlHint(url), eventTypes: body.eventTypes, regions: body.regions ?? null, paused: body.paused, headerNames: headers?.map(h => h.name) } });
      return created;
    });
    c.header('Cache-Control', 'no-store');
    const view = await metadata(c.env, row!, a);
    return c.json({ ...view, ...view.approval ? { nextStep: tiedNextStep('webhook', view.approval) } : {}, secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}', operationId: 'getWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c); return c.json(await metadata(c.env, await getWebhook(c.env, a, c.req.valid('param').id), a), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/webhooks/{id}', operationId: 'updateWebhook', tags: ['Webhooks'], security, request: { params: IdParams, body: json(webhookPatch) }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = webhookManager(c), current = await getWebhook(c.env, a, c.req.valid('param').id), { headers, ...body } = c.req.valid('json'); if (body.url) body.url = webhookUrl(c.env, body.url);
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const row = await c.env.db.transaction(async tx => {
      await ownWebhook(c, tx, a, current.id);
      const [locked] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).for('update'); if (!locked) return notFound('Webhook');
      if (locked.reconfirm && body.paused === false && !body.url) throw webhookNeedsUrl();
      const takeover = locked.reconfirm && body.url ? { reconfirm: false, encryptedSecret: await encrypt(c.env, webhookSecret(), secretBinding(a, current.id)) } : {};
      const [updated] = await tx.update(webhooks).set({ ...body, ...takeover, encryptedHeaders: await encryptWebhookHeaders(c.env, headers ?? (body.url && body.url !== locked.url ? [] : undefined), secretBinding(a, current.id)), updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).returning();
      // The first page resumes with the unpause; a full page hands the rest to a resume job (resumeDeliveries).
      if (locked.paused && body.paused === false && await resumeParked(tx, a.workspaceId, current.id) === RESUME_PAGE)
        await enqueue(tx, { type: 'operation.resumeDeliveries', workspaceId: a.workspaceId, payload: { webhookId: current.id } });
      // Changed field names and non-secret values: a URL hint, never header values.
      await recordAudit(tx, c, { action: 'webhook.update', workspaceId: a.workspaceId, target: { type: 'webhook', id: current.id }, details: { fields: [...Object.keys(body), ...(headers ? ['headers'] : [])] },
        before: { url: body.url ? webhookUrlHint(locked.url) : undefined, eventTypes: body.eventTypes ? locked.eventTypes : undefined, regions: body.regions !== undefined ? locked.regions : undefined, paused: body.paused !== undefined ? locked.paused : undefined },
        after: { url: body.url ? webhookUrlHint(body.url) : undefined, eventTypes: body.eventTypes, regions: body.regions, paused: body.paused, headerNames: headers?.map(h => h.name) } });
      return updated!;
    }); return c.json(await metadata(c.env, row, a), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/webhooks/{id}', operationId: 'deleteWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(deletedSchema), ...errors } }), async c => {
    const a = webhookManager(c), row = await getWebhook(c.env, a, c.req.valid('param').id);
    await c.env.db.execute(sql`WITH deleted AS (DELETE FROM operation_webhooks WHERE workspace_id=${a.workspaceId} AND id=${row.id} RETURNING id),
      audit AS (${auditInsert(auditContext(c), { action: 'webhook.delete', workspaceId: a.workspaceId, target: { type: 'webhook', id: sql`deleted.id` }, before: { url: webhookUrlHint(row.url), eventTypes: row.eventTypes, paused: row.paused } }, { from: sql`deleted` })}) SELECT 1`);
    return c.json({ deleted: true }, 200);
  });
  // Reveal hands out a durable capability: whoever holds the secret can sign requests the receiver trusts, with no trace in
  // Nightmail. So only a person's own credentials read it back (a dashboard session, or an API key not made through an MCP
  // approval), at most REVEALS_PER_MINUTE times a minute per workspace, and every hand-out is recorded. Rotation stays open
  // to every manage credential: it breaks the receiver until it is updated, so it can't go unnoticed.
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/secret', operationId: 'revealWebhookSecret', tags: ['Webhooks'], security, description: `Read the endpoint's signing secret back. Only a dashboard session or an API key you created can: MCP approvals, the API keys they create and temporary agent tokens get 403 CREDENTIAL_DELEGATION_FORBIDDEN (they can rotate it instead). At most ${REVEALS_PER_MINUTE} reads a minute per workspace (429 REVEAL_RATE_LIMITED); each read is recorded with the credential and time.`, request: { params: IdParams }, responses: { 200: response(secretSchema), ...errors } }), async c => {
    const a = webhookManager(c);
    if (a.credential === 'mcp' || a.credential === 'agentToken' || a.grantId) throw denied('CREDENTIAL_DELEGATION_FORBIDDEN', 'Read a signing secret back from the dashboard or with an API key you created. MCP approvals and agent tokens can rotate it instead.', { permission: 'configuration', level: 'write', credential: 'notDelegated' });
    const row = await getWebhook(c.env, a, c.req.valid('param').id); c.header('Cache-Control', 'no-store');
    if (!await chargeBudget(c.env, a.workspaceId, 'webhook-secret:reveal', REVEALS_PER_MINUTE)) {
      c.header('Retry-After', '60');
      throw new ApiError(429, 'REVEAL_RATE_LIMITED', `This workspace read signing secrets back ${REVEALS_PER_MINUTE} times in the last minute. Retry after the window resets.`, undefined, true);
    }
    const secret = await decrypt(c.env, row.encryptedSecret, secretBinding(a, row.id));
    // Both records commit before the secret is returned: the secret hand-out log and the account's audit trail.
    await c.env.db.transaction(async tx => {
      await recordSecret(tx, a, row.id, 'revealed');
      await recordAudit(tx, c, { action: 'webhook.secret_reveal', workspaceId: a.workspaceId, target: { type: 'webhook', id: row.id }, details: { url: webhookUrlHint(row.url) } });
    });
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/rotate-secret', operationId: 'rotateWebhookSecret', tags: ['Webhooks'], security, description: 'Replace the endpoint\'s signing secret and return the new one. Deliveries are signed with it from now on, so update your receiver. Each rotation is recorded with the credential and time.', request: { params: IdParams }, responses: { 200: response(secretSchema), ...errors } }), async c => {
    const a = webhookManager(c), webhookId = c.req.valid('param').id, binding = secretBinding(a, webhookId); c.header('Cache-Control', 'no-store');
    // The approval is held and the webhook row locked from the read to the end: the secret written is the one the row
    // holds when this commits, and a removal that lands later holds the webhook, whose URL then takes it over.
    const secret = await c.env.db.transaction(async tx => {
      await ownWebhook(c, tx, a, webhookId);
      const [row] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))).for('update'); if (!row) return notFound('Webhook');
      const secret = webhookSecret();
      await tx.update(webhooks).set({ encryptedSecret: await encrypt(c.env, secret, binding), updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId)));
      await recordSecret(tx, a, webhookId, 'rotated');
      await recordAudit(tx, c, { action: 'webhook.secret_rotate', workspaceId: a.workspaceId, target: { type: 'webhook', id: row.id }, details: { url: webhookUrlHint(row.url) } });
      return secret;
    });
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/test', operationId: 'testWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), webhookId = c.req.valid('param').id;
    return c.json(await c.env.db.transaction(tx => testSendingWebhook(c.env, tx, a, webhookId)), 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tags: ['Webhooks'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(listSchema(deliverySchema, 'WebhookDeliveryPage')), ...errors } }), async c => {
    // Newest first by creation time: delivery IDs are random, so ordering by ID showed an arbitrary sample, not the latest.
    const a = workspaceActor(c), endpoint = await getWebhook(c.env, a, c.req.valid('param').id), q = c.req.valid('query'), binding = `webhook-deliveries:${endpoint.id}`, cursor = readCursor(q.cursor, binding);
    const rows = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, endpoint.id), cursor ? sql`(${deliveries.createdAt},${deliveries.id})<(${cursor.at}::timestamptz,${cursor.id})` : undefined)).orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(row => visibleDelivery(row, a)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  const deliveryParams = z.object({ id: z.string(), deliveryId: z.string() }).openapi('WebhookDeliveryParams');
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries/{deliveryId}', operationId: 'getWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 200: response(deliverySchema.extend({ attempts: z.array(attemptSchema) }).openapi('WebhookDeliveryDetail')), ...errors } }), async c => {
    const a = workspaceActor(c), p = c.req.valid('param'); const [row] = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))); if (!row) return notFound('Delivery'); const attempts = await c.env.db.select().from(deliveryAttempts).where(and(scoped(deliveryAttempts, a), eq(deliveryAttempts.deliveryId, row.id))).orderBy(asc(deliveryAttempts.createdAt)); return c.json({ ...visibleDelivery(row, a), attempts: attempts.map(row => attemptSchema.parse(row)) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', operationId: 'retryWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), p = c.req.valid('param');
    return c.json(await c.env.db.transaction(tx => retrySendingDelivery(c.env, tx, a, p.id, p.deliveryId)), 202);
  });
  registerPublicEvents(app);
  registerMetrics(app);
  registerSenderScore(app);
  registerUsage(app);
}

const snsSchema = z.object({ Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']), MessageId: z.string().min(1).max(200), TopicArn: z.string().min(1).max(300), Message: z.string().max(262144), Timestamp: z.string().datetime(), SignatureVersion: z.enum(['1', '2']), Signature: z.string().min(1).max(4096), SigningCertURL: z.string().url().max(2048), Subject: z.string().max(1000).optional(), SubscribeURL: z.string().url().max(4096).optional(), Token: z.string().max(4096).optional() }).openapi('SnsSignedEnvelope');
type SnsEnvelope = z.infer<typeof snsSchema>;
const SnsAccepted = z.object({ accepted: z.boolean() }).openapi('SnsAccepted');
function snsHost(envelope: SnsEnvelope) {
  const match = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:[A-Za-z0-9_-]+$/.exec(envelope.TopicArn);
  if (!match) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'Only registered standard AWS regional SNS topics are supported.');
  return { host: `sns.${match[1]}.amazonaws.com`, region: match[1]! };
}
function trustedSnsUrl(value: string, host: string, certificate: boolean) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash || (certificate ? !/^\/SimpleNotificationService-[0-9a-fA-F]{32}\.pem$/.test(url.pathname) || value !== `https://${host}${url.pathname}` : url.pathname !== '/')) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS certificate or subscription URL is not trusted.');
  return url;
}
// Node has no edge rate-limit binding. Reserve a miss synchronously, before I/O;
// at capacity refuse new miss buckets rather than evicting a live peer's budget.
function allowLocalCertMiss(certMissPeers: SnsCertificateState['peers'], peer: string) {
  const now = Date.now();
  for (const [key, bucket] of certMissPeers) {
    if (bucket.until > now) break;
    certMissPeers.delete(key);
  }
  const bucket = certMissPeers.get(peer);
  if (bucket) {
    if (bucket.count >= 60) return false;
    bucket.count++;
    return true;
  }
  if (certMissPeers.size >= 4096) return false;
  certMissPeers.set(peer, { count: 1, until: now + 60_000 });
  return true;
}
// Public certificates rotate infrequently. Reserve synchronously after the
// prefix check and before fetch; never queue waiters or share request I/O.
const certMissLimited = () => new ApiError(429, 'SNS_CERTIFICATE_RATE_LIMITED', 'Too many SNS certificate lookups. Retry after one minute.', undefined, true);
export class SnsCertMissBudget {
  private starts: number[] = [];
  private active = 0;
  constructor(private readonly clock = () => performance.now()) {}
  async run<T>(lookup: () => Promise<T>) {
    const now=this.clock();
    while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
    if (this.active >= 4 || this.starts.length >= 96) throw certMissLimited();
    this.active++; this.starts.push(now);
    try { return await lookup(); } finally { this.active--; }
  }
}
export class SnsCertificateState {
  // Share completed, public certificates, never an in-flight fetch. Only a
  // verified signature pins its signer independently of candidates and 404s.
  readonly candidates = new Map<string, { cert: X509Certificate; expiresAt: number }>();
  readonly verifiedSigners = new Map<string, X509Certificate>();
  readonly missingCertificates = new Map<string, number>();
  readonly peers = new Map<string, { count: number; until: number }>();
  readonly budget = new SnsCertMissBudget();
}
const isolateCertState = new SnsCertificateState();
async function fetchSnsCert(url: URL, certificateTimeout: number, missingCertificates: Map<string,number>) {
    // Certificate bytes come only from the allowlisted AWS HTTPS origin, protected by TLS PKI.
    // Workers require manual redirects; every non-2xx response below fails closed.
    let res: Response;
    try { res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(certificateTimeout) }); } catch (error) { logError(error, { code: 'SNS_CERTIFICATE_FETCH_FAILED' }, 'warn'); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true); }
    if (!res.ok) {
      await res.body?.cancel();
      if(res.status===404 || res.status===410){
        if(missingCertificates.size>=256)missingCertificates.delete(missingCertificates.keys().next().value!);
        missingCertificates.set(url.href,Date.now()+60000);throw new ApiError(403,'SNS_INVALID_CERTIFICATE','The SNS signing certificate does not exist.');
      }
      log('warn', { code: 'SNS_CERTIFICATE_FETCH_FAILED', status: res.status }); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true);
    }
    const pem = await res.text(); if (pem.length > 16384) throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.');
    try { return new X509Certificate(pem); } catch { throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.'); }
}
async function verifySns(envelope: SnsEnvelope, runtime: Runtime, peer: string) {
  const certificateTimeout = envelope.Type === 'SubscriptionConfirmation' ? 3000 : 10000;
  const trusted = snsHost(envelope);
  const url = trustedSnsUrl(envelope.SigningCertURL, trusted.host, true);
  const signature = Buffer.from(envelope.Signature, 'base64');
  if (signature.length < 256 || signature.length > 1024 || signature.toString('base64') !== envelope.Signature) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature encoding or length is invalid.');
  const fields = envelope.Type === 'Notification' ? ['Message', 'MessageId', ...(envelope.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const values = envelope as Record<string, unknown>;
  if (fields.some(field => typeof values[field] !== 'string')) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Required signed SNS fields are missing.');
  const {candidates:snsCertificates, verifiedSigners, missingCertificates, peers, budget} = runtime.snsCertificateState ?? isolateCertState;
  const cached = snsCertificates.get(url.href);
  const pinned = verifiedSigners.get(url.href);
  let cert = pinned && Date.parse(pinned.validTo)>Date.now() ? pinned : cached && cached.expiresAt > Date.now() ? cached.cert : undefined;
  if (!cert) {
    if((missingCertificates.get(url.href)??0)>Date.now()) throw new ApiError(403,'SNS_INVALID_CERTIFICATE','The SNS signing certificate does not exist.');
    if (!(runtime.allowSnsCertMiss ? await runtime.allowSnsCertMiss(peer) : allowLocalCertMiss(peers,peer))) throw certMissLimited();
    cert=await budget.run(() => fetchSnsCert(url,certificateTimeout,missingCertificates));
  }
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo) || cert.publicKey.asymmetricKeyType !== 'rsa') throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is expired or invalid.');
  if (cert !== pinned && (!cached || cached.expiresAt <= Date.now())) {
    if (snsCertificates.size >= 8) snsCertificates.delete(snsCertificates.keys().next().value!);
    snsCertificates.set(url.href, { cert, expiresAt: Math.min(Date.now() + 300000, Date.parse(cert.validTo)) });
  }
  const canonical = fields.map(field => `${field}\n${values[field]}\n`).join('');
  if (!verify(envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1', Buffer.from(canonical), cert.publicKey, signature)) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature verification failed.');
  if (cert !== pinned) {
    for(const [key,value] of verifiedSigners) if(Date.parse(value.validTo)<=Date.now()) verifiedSigners.delete(key);
    verifiedSigners.set(url.href,cert);
  }
  return trusted;
}
function verifySesAccount(runtime: Runtime, message: unknown, topicArn: string) {
  const accountId = (message as { mail?: { sendingAccountId?: unknown } } | null)?.mail?.sendingAccountId;
  // SNS topics can receive cross-account SES events; only an explicit SES account binding is authoritative.
  const expected = runtime.config.multiTenant ? topicArn.split(':')[4] : runtime.config.awsAccountId;
  if ((runtime.config.multiTenant && !/^\d{12}$/.test(expected ?? '')) || (expected && accountId !== expected)) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'The SES sending account is missing or does not match this topic.');
}
function registerPublicEvents(app: App) {
  type TopicBinding = { region: string; aws_account_id: string; kind: 'byo' | 'shared'; ready: boolean; inbound:boolean; managed_id:string|null;generation:number|null };
  const sendingTopics = new Map<string, { binding: TopicBinding; expires: number }>();
  async function sendingTopic(runtime: Runtime, arn: string, confirming: boolean) {
    const cached = sendingTopics.get(arn);
    if (!confirming && cached && cached.expires > Date.now()) return cached.binding;
    // Only a confirmation matches a journaled, not-yet-ready subscription. Without a public endpoint there is none to match.
    let subscription:string|null=null,byoSubscription:string|null=null;
    if (confirming) try { subscription=JSON.stringify([{kind:'subscription',resource:arn,target:feedbackUrl(runtime.config)}]); } catch {}
    // A connected account's topics subscribe to BYO_EVENTS_ORIGIN when it's set (byoFeedbackUrl).
    if (confirming) try { byoSubscription=JSON.stringify([{kind:'subscription',resource:arn,target:byoFeedbackUrl(runtime.config)}]); } catch {}
    const binding = (await runtime.db.execute<TopicBinding>(sql`
      SELECT r.region,c.aws_account_id,c.kind,r.sending_state='ready' AS ready,false AS inbound,CASE WHEN NOT r.legacy THEN c.id END AS managed_id,r.generation
        FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id WHERE c.kind='byo' AND r.feedback_topic_arn=${arn} AND (r.legacy OR r.sending_state='ready' OR
          (r.sending_state='provisioning' AND r.ownership_journal @> ${byoSubscription}::jsonb))
      UNION ALL SELECT region, aws_account_id, 'shared', ${poolSends()},false,CASE WHEN NOT legacy_names THEN 'pool' END,generation FROM provider_pool_regions p WHERE feedback_topic_arn=${arn} AND (legacy_names OR ${poolSends()} OR
        (${!!runtime.config.trustedPool} AND p.region='us-east-1' AND pool_tier='trusted' AND ownership_journal @> ${subscription}::jsonb))
      UNION ALL SELECT region,aws_account_id,'shared',${poolReceives()},true,NULL,NULL FROM provider_pool_regions p WHERE inbound_topic_arn=${arn}
      ${!confirming && TAG_PREFIX==='nightmail' ? sql`UNION ALL SELECT region,aws_account_id,'shared',true,true,NULL,NULL FROM provider_pool_regions p
        WHERE region='us-east-2' AND aws_account_id=${runtime.config.platformAccount??''} AND ${poolReceives()} AND inbound_topic_arn='arn:aws:sns:us-east-2:'||aws_account_id||':nightmail-inbound'
        AND ${arn}='arn:aws:sns:us-east-2:'||aws_account_id||':bane-inbound'` : sql``}
      UNION ALL SELECT r.region,r.account_id,'byo',${connectionReady(sql`c`)},true,NULL,NULL FROM mailbox_regions r JOIN provider_connections c ON c.workspace_id=r.workspace_id AND c.aws_account_id=r.account_id AND c.region=r.region AND c.kind='byo' AND c.template_version<>'v5' WHERE r.topic_arn=${arn}
      ${!confirming ? sql`UNION ALL SELECT region,aws_account_id,kind,true,false,NULL,NULL FROM provider_feedback_history WHERE topic_arn=${arn}` : sql``} ORDER BY ready DESC LIMIT 1`)).rows[0];
    if (!binding || !arn.startsWith(`arn:aws:sns:${binding.region}:${binding.aws_account_id}:`)) return;
    // A pending topic may confirm its subscription but must never prime trust for notifications.
    if (!binding.ready) return confirming ? binding : undefined;
    if (binding.inbound && binding.kind==='byo') return binding; // A reconnect must not inherit cached receipt trust.
    if (sendingTopics.size >= 1024) sendingTopics.delete(sendingTopics.keys().next().value!);
    sendingTopics.set(arn, { binding, expires: Date.now() + 60_000 });
    return binding;
  }
  const snsText: Parameters<App['use']>[1] = async (c, next) => {
    // SNS sends JSON envelopes as text/plain. Normalize only the media type before
    // OpenAPI's required JSON validator; preserve the signed envelope bytes.
    if (c.req.method === 'POST' && c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain') {
      const headers = new Headers(c.req.raw.headers);
      headers.set('content-type', 'application/json');
      c.req.raw = new Request(c.req.raw, { headers });
    }
    await next();
  };
  app.use('/v1/events/ses', snsText);
  app.use('/v1/events/cloudformation', snsText);
  // Connected AWS accounts' stacks (api/byo-templates/) report through the platform's setup topic.
  app.openapi(createRoute({ method: 'post', path: '/v1/events/cloudformation', operationId: 'receiveCloudFormationSnsEvent', tags: ['Events'], security: [], description: 'CloudFormation requests from connected AWS accounts\' role stacks, delivered by SNS from the platform\'s setup topic. AWS-signed ingress only.', request: { body: { required: true, content: { 'application/json': { schema: snsSchema }, 'text/plain': { schema: z.string().openapi('SnsPlainTextEnvelope') } } } }, responses: { 202: response(SnsAccepted), ...errors } }), async c => {
    let raw: unknown; try { raw = JSON.parse(await c.req.text()); } catch { throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected an SNS JSON envelope.'); }
    const parsed = snsSchema.safeParse(raw); if (!parsed.success) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected a complete signed SNS envelope.');
    const envelope = parsed.data, trusted = await verifySns(envelope, c.env, c.req.header(clientIpHeader) ?? 'unknown'), account = c.env.config.platformAccount;
    if (!c.env.config.multiTenant || !account || envelope.TopicArn !== `arn:aws:sns:us-east-2:${account}:nightmail-byo-setup`) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'Only the platform\'s stack topic is accepted here.');
    if (envelope.Type === 'SubscriptionConfirmation') {
      const url = trustedSnsUrl(envelope.SubscribeURL!, trusted.host, false);
      if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== envelope.TopicArn || url.searchParams.get('Token') !== envelope.Token || url.searchParams.size !== 3) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS confirmation fields differ.');
      const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); await result.body?.cancel();
      if (!result.ok) throw new ApiError(503, 'SNS_CONFIRMATION_FAILED', 'SNS did not confirm the subscription.', undefined, true);
      return c.json({ accepted: true }, 202);
    }
    if (envelope.Type !== 'Notification') return c.json({ accepted: false }, 202);
    if (await (await wrapModuleLoad(() => import('./byo-regional.js'))).stackNotification(c.env, envelope.Message)) try { await c.env.wake?.(1); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED' }); }
    return c.json({ accepted: true }, 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/events/ses', operationId: 'receiveSesSnsEvent', tags: ['Events'], security: [], request: { body: { required: true, content: { 'application/json': { schema: snsSchema }, 'text/plain': { schema: z.string().openapi('SnsPlainTextEnvelope') } } } }, responses: { 202: response(SnsAccepted), ...errors } }), async c => {
    let raw: unknown; try { raw = JSON.parse(await c.req.text()); } catch { throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected an SNS JSON envelope.'); }
    const parsed = snsSchema.safeParse(raw); if (!parsed.success) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected a complete signed SNS envelope.');
    const envelope = parsed.data;
    // Prove AWS signed this exact topic before looking up its tenant. A valid
    // signature is NOT topic authorization: all binding checks below still apply.
    // Both entry points overwrite this header with the socket/edge peer (IPv6 /64).
    const trusted = await verifySns(envelope, c.env, c.req.header(clientIpHeader) ?? 'unknown');
    // Region settings may come from a 30 s cache: a topic or account provisioned since then is re-checked fresh.
    let stack: Awaited<ReturnType<typeof import('./provider-connections.js').byoStackTopic>>;
    let binding:TopicBinding|undefined;
    if (c.env.config.multiTenant && envelope.Type==='SubscriptionConfirmation' && c.env.config.platformAccount) {
      const account=c.env.config.platformAccount, region=trusted.region;
      const names=region==='us-east-2'?['nightmail-inbound','nightmail-feedback']:region==='us-east-1'?['nightmail-trusted-feedback']:[];
      if(names.some(n=>envelope.TopicArn===`arn:aws:sns:${region}:${account}:${n}`)) {
        const url=trustedSnsUrl(envelope.SubscribeURL!,trusted.host,false);
        if(url.searchParams.get('Action')!=='ConfirmSubscription'||url.searchParams.get('TopicArn')!==envelope.TopicArn||url.searchParams.get('Token')!==envelope.Token||url.searchParams.size!==3) throw new ApiError(403,'SNS_UNTRUSTED_URL','SNS confirmation fields differ.');
        const matched=await c.env.db.transaction(async tx=>{
          const fence=sql`topic_arn=${envelope.TopicArn} AND account_id=${account} AND region=${region} AND endpoint=${feedbackUrl(c.env.config)} AND expires_at>now()`;
          const row=(await tx.execute<{confirmation_id:string|null}>(sql`SELECT confirmation_id FROM hosted_topic_cutover WHERE ${fence} FOR UPDATE`)).rows[0];
          if(!row)return false;
          if(row.confirmation_id===envelope.MessageId)return true;
          const result=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});await result.body?.cancel();
          if(!result.ok)throw new ApiError(503,'SNS_CONFIRMATION_FAILED','SNS did not confirm the prepared subscription.',undefined,true);
          await tx.execute(sql`UPDATE hosted_topic_cutover SET confirmed_at=clock_timestamp(),confirmation_id=${envelope.MessageId} WHERE ${fence}`);return true;
        });
        if(matched)return c.json({accepted:true},202);
      }
    }
    if (c.env.config.multiTenant) {
      if (envelope.Type==='SubscriptionConfirmation') stack=await (await wrapModuleLoad(() => import('./provider-connections.js'))).byoStackTopic(c.env,envelope.TopicArn);
      binding=stack ? undefined : await sendingTopic(c.env,envelope.TopicArn,envelope.Type==='SubscriptionConfirmation');
      if (!stack && !binding) throw new ApiError(403,'SNS_TOPIC_NOT_ALLOWED','This SNS topic is not registered for the account and region.');
      c.env={...c.env,config:{...c.env.config,snsTopicArns:[envelope.TopicArn],inboundTopicArns:binding?.inbound?[envelope.TopicArn]:[]}};
    } else {
      c.env = await resolveRegionRuntime(c.env, { cacheMs: 30_000 });
      if (!c.env.config.snsTopicArns.includes(envelope.TopicArn)) c.env = await resolveRegionRuntime(c.env);
      if (!c.env.config.snsTopicArns.includes(envelope.TopicArn)) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'The SNS topic is not configured for this deployment.');
    }
    if (envelope.Type !== 'Notification') {
      if (envelope.Type === 'SubscriptionConfirmation') {
        const url = trustedSnsUrl(envelope.SubscribeURL!, trusted.host, false);
        if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== envelope.TopicArn || url.searchParams.get('Token') !== envelope.Token || url.searchParams.size!==3) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS confirmation URL fields do not match the signed envelope.');
        const confirm = async () => {
          const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(stack ? 4000 : 10000) }); await res.body?.cancel(); if (!res.ok) throw new ApiError(503, 'SNS_CONFIRMATION_FAILED', 'SNS subscription confirmation failed.', undefined, true);
        };
        if (stack) {
          try { await stack({messageId:envelope.MessageId,confirm}); }
          catch (e) {
            if (e instanceof ModuleLoadError) throw e;
            const error=awsError(e);
            // IAM propagation and racing callbacks can precede a usable role; SNS retries 5xx, not 409/403.
            if (error.retryable || error.code==='AWS_ACCESS_DENIED') throw new ApiError(503,error.code,error.message,undefined,true);
            throw error;
          }
        } else if (binding?.kind==='shared' && binding.managed_id==='pool') {
          if (!c.env.config.trustedPool || binding.ready) throw new ApiError(403,'SNS_TOPIC_NOT_ALLOWED','No pending trusted subscription.');
          const fence=sql`region=${binding.region} AND aws_account_id=${binding.aws_account_id} AND NOT legacy_names AND pool_tier='trusted' AND generation=${binding.generation} AND feedback_topic_arn=${envelope.TopicArn} AND sending_state='pending'`;
          await c.env.db.transaction(async db=>{
            if (!(await db.execute(sql`SELECT FROM provider_pool_regions WHERE ${fence} FOR UPDATE`)).rowCount) throw new ApiError(503,'PROVISION_LEASE_LOST','Pool confirmation raced setup; retry.',undefined,true);
            await confirm();await db.execute(sql`UPDATE provider_pool_regions SET confirmed_generation=generation WHERE ${fence}`);
          });
        } else if (binding?.managed_id && !binding.ready) {
          const fence=sql`connection_id=${binding.managed_id} AND region=${binding.region} AND generation=${binding.generation} AND feedback_topic_arn=${envelope.TopicArn} AND sending_state='provisioning'`;
          // Lock only this topic generation across the bounded confirmation GET. If
          // it changed during signature verification, retry BEFORE consuming the token.
          await c.env.db.transaction(async db=>{
            if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE ${fence} FOR UPDATE`)).rowCount) throw new ApiError(503,'PROVISION_LEASE_LOST','The confirmation raced a new regional setup generation. Retry the signed callback.',undefined,true);
            await confirm();await db.execute(sql`UPDATE provider_connection_regions SET confirmed_topic_arn=feedback_topic_arn,confirmed_generation=generation WHERE ${fence}`);
          });
        } else await confirm();
      }
      // An authenticated UnsubscribeConfirmation is acknowledged, never automatically resubscribed.
      return c.json({ accepted: true }, 202);
    }
    let message: unknown; try { message = JSON.parse(envelope.Message); } catch { throw new ApiError(400, 'SES_INVALID_EVENT', 'SNS Message must contain a SES JSON event.'); }
    // Mailbox receipt notifications arrive on a separate Nightmail-owned topic and carry no sending account.
    if (c.env.config.inboundTopicArns?.includes(envelope.TopicArn)) {
      const runnable = await (await wrapModuleLoad(() => import('./mailbox-receipts.js'))).acceptInboundNotification(c.env, { topicArn: envelope.TopicArn, region: trusted.region, message });
      if (runnable > 0) try { await c.env.wake?.(runnable,'ingest'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox ingestion remains durable.' }); }
      return c.json({ accepted: true }, 202);
    }
    // An SES tenant status event (EventBridge) has no mail object: it is judged by its topic, account, region and an
    // owned tenant ARN (src/standing.ts), before the mail checks below; both ingress paths use the same check.
    const tenantEvent = c.env.config.multiTenant && (message as { source?: unknown } | null)?.source === 'aws.ses' ? (await import('./standing.js')).tenantStatusEvent(message as Record<string, unknown>) : null;
    if (tenantEvent) {
      if (binding?.kind !== 'shared') throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', `SES tenant status events are accepted only from a ${productName}-owned shared feedback topic.`);
      const tenantItem = { message: message as Record<string, unknown>, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region, topicKind: 'shared' as const };
      if (c.env.feedback) { await c.env.feedback.enqueue([tenantItem]); return c.json({ accepted: true }, 202); }
      const refused = await (await import('./standing.js')).ingestTenantStatus(c.env, tenantEvent, tenantItem);
      if (refused) throw new ApiError(403, refused, `This SES tenant status event does not match a tenant ${productName} owns on this topic.`);
      return c.json({ accepted: true }, 202);
    }
    verifySesAccount(c.env, message, envelope.TopicArn);
    if (binding?.kind==='byo' && c.env.allowFeedbackTopic && !await c.env.allowFeedbackTopic(envelope.TopicArn))
      throw new ApiError(503,'FEEDBACK_TOPIC_BUSY','Feedback for this topic is temporarily rate limited; retry.',undefined,true);
    const payload = { message, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region };
    const item = { ...payload, topicKind:binding?.kind, message: message as Record<string, unknown> };
    // With a feedback sink (Cloudflare), the verified callback leaves the request path immediately and is
    // ingested in batches by the feedback consumer; nothing here touches the database or the jobs table.
    if (c.env.feedback) {
      sesFeedbackIdentity(item.message);
      await c.env.feedback.enqueue([item]);
      return c.json({ accepted: true }, 202);
    }
    const { ingestRoutineSesEvent } = await loadSendingOps();
    const { error, runnable } = await ingestRoutineSesEvent(c.env, routineInput(item, true));
    if (error === 'SES_ACCOUNT_MISMATCH') throw new ApiError(403, error, 'The SES sending account is missing or does not match this deployment.');
    // SNS retries 5xx, not 4xx. Without a verified owner we cannot store a tenant-scoped recovery job yet.
    if (error) throw new ApiError(503, error, 'The feedback owner is not yet available; retry this notification.', undefined, true);
    if (runnable > 0) try { await c.env.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Feedback recovery and webhook jobs remain durable.' }); }
    return c.json({ accepted: true }, 202);
  });
  const TOKEN = /^u_[a-f0-9]{64}$/;
  // A person who opens a link that is cut short, mistyped or no longer known gets a page that says so; an API client
  // (no text/html in Accept) and a mailbox's one-click POST still get the JSON error.
  const browser = (c: Ctx) => c.req.method === 'GET' && /\btext\/html\b/i.test(c.req.header('accept') ?? '');
  const invalidLink = (c: Ctx) => {
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    c.set('failure', { code: 'NOT_FOUND' });
    return c.html(unsubscribePage('This unsubscribe link isn’t valid', '<p>It may be incomplete or out of date. To stop these emails, use the unsubscribe link in a more recent email from the sender, or ask the sender to remove you.</p>'), 404);
  };
  // Hono matches HEAD as GET; intercept the original method before the mutating GET route.
  app.use('/unsubscribe/:token', async (c, next) => {
    if (c.req.method === 'HEAD') { c.header('Allow', 'GET, POST'); c.header('Cache-Control', 'no-store'); throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST to unsubscribe.'); }
    if (browser(c) && !TOKEN.test(c.req.param('token') ?? '')) return invalidLink(c);
    await next();
  });
  const tokenParams = z.object({ token: z.string().regex(TOKEN) }).openapi('UnsubscribeToken');
  const invalidPage = { 404: { ...errors[404], description: 'The link is malformed or unknown: an HTML page saying so to a browser (Accept: text/html), the JSON error otherwise.', content: { ...errors[404]!.content, 'text/html': { schema: z.string() } } } };
  const pageRedirect = { 303: { description: 'The confirmation form of a campaign with its own unsubscribe page: the opt-out is recorded, then the browser continues to that page with unsubscribe_token. A one-click POST is never redirected (RFC 8058 section 3.1).', headers: { Location: { schema: { type: 'string' as const } } } } };
  for (const method of ['get', 'post'] as const) app.openapi(createRoute({ method, path: '/unsubscribe/{token}', operationId: method === 'get' ? 'unsubscribeByLink' : 'unsubscribeOneClick', tags: ['Consent'], security: [], request: { params: tokenParams }, responses: { 200: { description: method === 'get' ? 'Confirmation page; GET never changes consent (link scanners prefetch footer links).' : 'Marketing consent is now unsubscribed (RFC 8058 one-click or the confirmation form).', content: { 'text/html': { schema: z.string().openapi('UnsubscribeConfirmationHtml') } } }, ...(method === 'post' ? pageRedirect : {}), ...errors, ...(method === 'get' ? invalidPage : {}) } }), async c => {
    const raw = c.req.valid('param').token;
    const [token] = await c.env.db.select().from(unsubscribeTokens).where(eq(unsubscribeTokens.tokenHash, await digest(raw)));
    // The confirmation form may continue to the campaign's own page: browsers apply form-action to that redirect too.
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'${token?.pageUrl ? ` ${new URL(token.pageUrl).origin}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
    if (!token) return browser(c) ? invalidLink(c) : notFound('Unsubscribe link');
    // Link scanners and mail security gateways fetch every link in a message, so a footer GET only asks for
    // confirmation. Mailbox one-click (RFC 8058, List-Unsubscribe-Post) and the confirmation form are POSTs.
    if (method === 'get') return c.html(unsubscribePage('Unsubscribe from marketing emails?', '<p>You will no longer receive marketing emails from this workspace.</p><form method="post"><input type="hidden" name="confirm" value="footer"><button type="submit" style="font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer">Unsubscribe</button></form>'), 200);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    // The audience helper commits consent, audit, and the subscription event outbox atomically.
    await (await wrapModuleLoad(() => import('./audience.js'))).recordUnsubscribe(c.env, token.workspaceId, token.email, form.confirm === 'footer' ? 'footer-confirm' : 'rfc8058-post');
    // Only a person confirming in a browser continues to the campaign's own page; RFC 8058 forbids redirecting one-click.
    if (form.confirm === 'footer' && token.pageUrl) return c.redirect(unsubscribePageLink(token.pageUrl, raw), 303);
    return c.html(unsubscribePage('You’re unsubscribed', '<p>You will no longer receive marketing emails from this workspace.</p>'), 200);
  });
}

function unsubscribePage(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>@font-face{font-family:Inter;src:url("/fonts/inter-variable.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}body,body *{letter-spacing:-0.01em}</style><body style="font-family:Inter,Arial,sans-serif;letter-spacing:-0.01em;margin:48px;line-height:1.5"><main><h1 style="font-size:24px">${title}</h1>${body}</main></body></html>`;
}
function registerMetrics(app: App) {
  // The window's aggregate is one statement that reads every email in it (a 30-day Overview reads all retained mail):
  // it stops after 5 seconds with READ_TOO_LARGE rather than hold a connection.
  const METRICS_READ = 5;
  const query = z.object({ region: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), stream: z.enum(['transactional', 'marketing']).optional(), granularity: z.enum(['day', 'hour']).default('day'), include: z.string().regex(/^(?:previous|streams)(?:,(?:previous|streams))*$/).optional().describe('Comma-separated extras computed in the same statement: previous (totals for the window of equal length ending at from) and streams (totals per stream for the window, ignoring the stream filter).') }).openapi('MetricsQuery');
  const bucket = z.object({ date: z.string(), count: z.number(), sent: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number() });
  const totalsSchema = z.object({ emails: z.number(), accepted: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number(), opened: z.number(), clicked: z.number(), failed: z.number(), deliveryDelayed: z.number(), simulated: z.number() });
  const schema = z.object({ basis: z.literal('created-cohort'), from: z.string(), to: z.string(), region: z.string().nullable(), stream: z.string().nullable(), totals: totalsSchema, daily: z.array(bucket), hourly: z.array(bucket).optional(), previous: z.object({ from: z.string(), to: z.string(), totals: totalsSchema }).optional().describe('Present with include=previous.'), streams: z.object({ transactional: totalsSchema, marketing: totalsSchema }).optional().describe('Present with include=streams.') }).openapi('Metrics');
  app.openapi(createRoute({ method: 'get', path: '/v1/metrics', operationId: 'getMetrics', description: 'Operational created-cohort metrics, not invoicing or provider reputation. ' + DASHBOARD_CACHE_NOTE + ' Selects emails created in [from,to), scoped by email region and stream. Outcomes use current email state and all recorded events, including events after to; this is not a historical state snapshot. Each outcome counts distinct emails, so replays do not inflate counts and outcomes may overlap. Accepted (bucket sent) means evidence of provider acceptance, not merely queued/created. Daily UTC creation buckets contain count=created emails. Granularity defaults to day; granularity=hour additionally returns hourly UTC creation buckets with canonical ISO dates such as 2026-09-12T01:00:00.000Z, while preserving daily buckets and totals. Absent buckets mean zero created emails and zero outcomes; no moving averages are applied. Engagement is observed, not verified human activity. ' + readLimitNote(METRICS_READ), tags: ['Metrics'], security, request: { query }, responses: { 200: response(schema), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'), end = q.to ?? now(), start = q.from ?? new Date(Date.parse(end) - 30 * 86400000).toISOString(); if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new ApiError(422, 'INVALID_DATE_RANGE', 'Metrics require an increasing range of at most 366 days.');
    const compute = async () => {
    if (q.region) region(await withRegionSettings(c.env,a.workspaceId),q.region);
    const extras = new Set((q.include ?? '').split(',').filter(Boolean));
    const date = q.granularity === 'hour' ? sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"')` : sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    // Outcomes come from the per-email flags kept by the operation_events trigger (migration 031): the same
    // union of public events the old per-query event aggregation produced, without re-reading the events.
    type Row = { date: string; emails: number; accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number; simulated: number };
    const counts = (cols: { status: SQL; simulated: SQL; providerId: SQL; outcomes: SQL }) => {
      const has = (bit: number) => sql`(${cols.outcomes} & ${bit}) <> 0`;
      return sql`count(*)::int AS "emails",
        count(*) FILTER (WHERE NOT ${cols.simulated} AND ${cols.status} <> 'suppressed' AND (${cols.providerId} IS NOT NULL OR ${cols.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${has(OUTCOME.accepted)}))::int AS "accepted",
        count(*) FILTER (WHERE ${cols.status} = 'delivered' OR ${has(OUTCOME.delivered)})::int AS "delivered",
        count(*) FILTER (WHERE ${cols.status} = 'bounced' OR ${has(OUTCOME.bounced)})::int AS "bounced",
        count(*) FILTER (WHERE ${cols.status} = 'complained' OR ${has(OUTCOME.complained)})::int AS "complained",
        count(*) FILTER (WHERE ${has(OUTCOME.opened)})::int AS "opened", count(*) FILTER (WHERE ${has(OUTCOME.clicked)})::int AS "clicked",
        count(*) FILTER (WHERE ${cols.status} IN ('rejected', 'rendering_failed') OR ${has(OUTCOME.failed)})::int AS "failed",
        count(*) FILTER (WHERE ${cols.status} = 'delayed' OR ${has(OUTCOME.delayed)})::int AS "deliveryDelayed",
        count(*) FILTER (WHERE ${cols.simulated})::int AS "simulated"`;
    };
    const total = (row?: Partial<Row>) => ({ emails: row?.emails ?? 0, accepted: row?.accepted ?? 0, delivered: row?.delivered ?? 0, bounced: row?.bounced ?? 0, complained: row?.complained ?? 0, opened: row?.opened ?? 0, clicked: row?.clicked ?? 0, failed: row?.failed ?? 0, deliveryDelayed: row?.deliveryDelayed ?? 0, simulated: row?.simulated ?? 0 });
    type Totals = ReturnType<typeof total>;
    type KindHourRow = Totals & { hour: string; kind: string };
    const addTotals = (acc: Totals, item: Partial<Totals>) => {
      for (const key of Object.keys(acc) as Array<keyof Totals>) acc[key] += Number(item[key] ?? 0);
      return acc;
    };
    let rows: Row[], previous: { from: string; to: string; totals: Totals } | undefined, streams: { transactional: Totals; marketing: Totals } | undefined;
    const HOUR_MS = 3_600_000;
    const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
    const ceilHour = (ms: number) => (ms % HOUR_MS === 0 ? ms : floorHour(ms) + HOUR_MS);
    const startMs = Date.parse(start), endMs = Date.parse(end);
    const previousFromMs = startMs - (endMs - startMs), previousFrom = new Date(previousFromMs).toISOString();
    const scanFromMs = extras.has('previous') ? previousFromMs : startMs;

    if (await talliesEnabled(c.env.db)) {
      // Exact at read time: reads sending_metrics_hourly (folded + unfolded deltas) for all whole UTC hours and only
      // touches raw sending_emails for non-empty partial edge hours (zero raw rows for Overview's right edge to=now()).
      const result = await budgetedRead(c.env.db, async db => {
        const minHour = new Date(floorHour(scanFromMs)).toISOString();
        const maxHour = new Date(floorHour(endMs - 1) + HOUR_MS).toISOString();
        const hourlyRows = (await db.execute<KindHourRow>(sql`SELECT
          to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"') AS hour, kind,
          sum(emails)::int AS emails, sum(accepted)::int AS accepted, sum(delivered)::int AS delivered,
          sum(bounced)::int AS bounced, sum(complained)::int AS complained, sum(opened)::int AS opened,
          sum(clicked)::int AS clicked, sum(failed)::int AS failed,
          sum(delivery_delayed)::int AS "deliveryDelayed", sum(simulated)::int AS simulated
          FROM sending_metrics_hourly
          WHERE workspace_id = ${a.workspaceId} AND hour >= ${minHour}::timestamptz AND hour < ${maxHour}::timestamptz
            ${q.region ? sql`AND region = ${q.region}` : sql``}
            ${q.stream && !extras.has('streams') ? sql`AND kind = ${q.stream}` : sql``}
          GROUP BY 1, 2 HAVING sum(emails) <> 0`)).rows;
        const byHour = new Map<number, KindHourRow[]>();
        for (const r of hourlyRows) {
          const ms = Date.parse(r.hour);
          const list = byHour.get(ms);
          if (list) list.push(r); else byHour.set(ms, [r]);
        }
        const scanEdge = async (fromMs: number, toMs: number): Promise<KindHourRow[]> => {
          const hMs = floorHour(fromMs);
          if (!byHour.has(hMs)) return [];
          const hourIso = new Date(hMs).toISOString();
          const filter = and(scoped(emails, a), gte(emails.createdAt, new Date(fromMs).toISOString()), lt(emails.createdAt, new Date(toMs).toISOString()),
            q.region ? eq(emails.region, q.region) : undefined, q.stream && !extras.has('streams') ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
          const { rows: edgeRows } = await db.execute<Totals & { kind: string }>(sql`SELECT
            coalesce(${emails.snapshot}->>'kind', '') AS kind,
            ${counts({ status: sql`${emails.status}`, simulated: sql`${emails.simulated}`, providerId: sql`${emails.providerId}`, outcomes: sql`${emails.eventOutcomes}` })}
            FROM ${emails} WHERE ${filter} GROUP BY 1`);
          return edgeRows.map(r => ({ ...r, hour: hourIso }));
        };
        const collect = async (fromMs: number, toMs: number): Promise<KindHourRow[]> => {
          const out: KindHourRow[] = [];
          const wStart = ceilHour(fromMs);
          let wEnd = floorHour(toMs);
          // If the right edge falls mid-hour (always true for to=now()) and no email exists after toMs in that hour,
          // the whole hour belongs to this window and comes directly from sending_metrics_hourly with zero raw scan.
          if (toMs > wEnd && fromMs <= wEnd) {
            if (!byHour.has(wEnd)) {
              wEnd += HOUR_MS;
            } else {
              const nextHour = new Date(wEnd + HOUR_MS).toISOString();
              const { rows: [after] } = await db.execute<{ any: boolean }>(sql`SELECT EXISTS (
                SELECT 1 FROM sending_emails WHERE workspace_id = ${a.workspaceId}
                  AND created_at >= ${new Date(toMs).toISOString()}::timestamptz AND created_at < ${nextHour}::timestamptz
              ) AS any`);
              if (!after?.any) wEnd += HOUR_MS;
            }
          }
          if (wStart > wEnd) {
            out.push(...await scanEdge(fromMs, toMs));
            return out;
          }
          for (const [hMs, list] of byHour) if (hMs >= wStart && hMs < wEnd) out.push(...list);
          if (fromMs < wStart) out.push(...await scanEdge(fromMs, wStart));
          if (wEnd < toMs) out.push(...await scanEdge(wEnd, toMs));
          return out;
        };
        const currentItems = await collect(startMs, endMs);
        const previousItems = extras.has('previous') ? await collect(previousFromMs, startMs) : [];
        return { currentItems, previousItems };
      }, readLimit(METRICS_READ));

      const matchShown = (item: KindHourRow) => !q.stream || item.kind === q.stream;
      const byBucket = new Map<string, Totals>();
      for (const item of result.currentItems) {
        if (!matchShown(item)) continue;
        const key = q.granularity === 'hour' ? item.hour : item.hour.slice(0, 10);
        const acc = byBucket.get(key) ?? total();
        addTotals(acc, item);
        byBucket.set(key, acc);
      }
      rows = [...byBucket].map(([dateKey, acc]) => ({ ...acc, date: dateKey })).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      if (extras.has('previous')) {
        const prevTotals = total();
        for (const item of result.previousItems) if (matchShown(item)) addTotals(prevTotals, item);
        previous = { from: previousFrom, to: start, totals: prevTotals };
      }
      if (extras.has('streams')) {
        const ownKind: 'transactional' | 'marketing' = q.stream ?? 'marketing';
        const all = total(), own = total();
        for (const item of result.currentItems) {
          addTotals(all, item);
          if (item.kind === ownKind) addTotals(own, item);
        }
        const rest = Object.fromEntries(Object.keys(all).map(key => [key, all[key as keyof Totals] - own[key as keyof Totals]])) as Totals;
        streams = ownKind === 'marketing' ? { transactional: rest, marketing: own } : { transactional: own, marketing: rest };
      }
    } else if (!extras.size) {
      const filter = and(scoped(emails, a), gte(emails.createdAt, start), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined, q.stream ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
      rows = (await budgetedRead(c.env.db, db => db.execute<Row>(sql`
      SELECT ${date} AS "date", ${counts({ status: sql`${emails.status}`, simulated: sql`${emails.simulated}`, providerId: sql`${emails.providerId}`, outcomes: sql`${emails.eventOutcomes}` })}
      FROM ${emails}
      WHERE ${filter}
      GROUP BY 1 ORDER BY 1`), readLimit(METRICS_READ))).rows;
    } else {
      // One statement that never reads snapshot except through sending_emails_kind_created (workspace, snapshot->>'kind',
      // created_at); snapshot is TOASTed and detoasting it per row costs seconds. Every email is created as exactly one of
      // the two kinds, so counts are additive across kinds and the second stream is the total minus the first:
      //  - an "all" arm groups the window (and the previous window when asked) directly, with no kind predicate;
      //  - one "kind" arm (the stream filter, or marketing when only the per-stream totals are asked for) uses the index.
      // Each arm groups by (in the window, creation bucket); rows before the window have no bucket (previous period).
      const previousFrom = new Date(Date.parse(start) - (Date.parse(end) - Date.parse(start))).toISOString();
      const scanFrom = extras.has('previous') ? previousFrom : start;
      const kind: 'transactional' | 'marketing' = q.stream ?? 'marketing';
      const needAll = !q.stream || extras.has('streams'), needKind = !!q.stream || extras.has('streams');
      const inWindow = sql`${emails.createdAt} >= ${start}::timestamptz`;
      const bucketOf = sql`CASE WHEN ${inWindow} THEN ${date} END`;
      const measures = counts({ status: sql`${emails.status}`, simulated: sql`${emails.simulated}`, providerId: sql`${emails.providerId}`, outcomes: sql`${emails.eventOutcomes}` });
      const within = (from: string) => and(scoped(emails, a), gte(emails.createdAt, from), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined);
      const arm = (part: 'all' | 'kind', from: string) => sql`SELECT ${part}::text AS part, ${inWindow} AS cur, ${bucketOf} AS "date", ${measures}
        FROM ${emails} WHERE ${and(within(from), part === 'kind' ? sql`(${emails.snapshot}->>'kind') = ${kind === 'marketing' ? sql`'marketing'::text` : sql`'transactional'::text`}` : undefined)} GROUP BY 2, 3`;
      const arms = [...(needAll ? [arm('all', q.stream ? start : scanFrom)] : []), ...(needKind ? [arm('kind', q.stream ? scanFrom : start)] : [])];
      const parts = (await budgetedRead(c.env.db, db => db.execute<Row & { part: 'all' | 'kind'; cur: boolean }>(arms.length > 1 ? sql`${arms[0]} UNION ALL ${arms[1]}` : arms[0]!), readLimit(METRICS_READ))).rows;
      const sum = (list: Row[]) => list.reduce((acc, row) => { for (const key of Object.keys(acc) as Array<keyof typeof acc>) acc[key] += row[key]; return acc; }, total());
      const shown = parts.filter(row => row.part === (q.stream ? 'kind' : 'all'));
      const byDate = new Map<string, Row[]>();
      for (const row of shown) if (row.cur) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
      rows = [...byDate].map(([day, list]) => ({ ...sum(list), date: day })).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      if (extras.has('previous')) previous = { from: previousFrom, to: start, totals: sum(shown.filter(row => !row.cur)) };
      if (extras.has('streams')) {
        const all = sum(parts.filter(row => row.part === 'all' && row.cur)), own = sum(parts.filter(row => row.part === 'kind' && row.cur));
        const rest = Object.fromEntries(Object.keys(all).map(key => [key, all[key as keyof typeof all] - own[key as keyof typeof own]])) as typeof all;
        streams = kind === 'marketing' ? { transactional: rest, marketing: own } : { transactional: own, marketing: rest };
      }
    }
    // Every email belongs to exactly one creation bucket, so totals are the sum of the buckets (no ROLLUP sort).
    const totals = { emails: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0, simulated: 0 };
    for (const row of rows) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row[key];
    const buckets = rows.map(row => ({ date: row.date!, count: row.emails, sent: row.accepted, delivered: row.delivered, bounced: row.bounced, complained: row.complained }));
    let daily = buckets;
    if (q.granularity === 'hour') {
      const days = new Map<string, z.infer<typeof bucket>>();
      // Every email belongs to one creation hour, so its outcome counts remain additive by day.
      for (const row of buckets) {
        const date = row.date.slice(0, 10), day = days.get(date);
        if (day) for (const key of ['count', 'sent', 'delivered', 'bounced', 'complained'] as const) day[key] += row[key];
        else days.set(date, { ...row, date });
      }
      daily = [...days.values()];
    }
    return { basis: 'created-cohort' as const, from: start, to: end, region: q.region ?? null, stream: q.stream ?? null, totals, daily, ...(q.granularity === 'hour' ? { hourly: buckets } : {}), ...(previous ? { previous } : {}), ...(streams ? { streams } : {}) };
    };
    // Dashboards poll this aggregate (older builds every 3 s, in every open tab). Dashboard sessions share a
    // 60-second cache per workspace/filters/window; API keys, MCP and agent tokens stay exact.
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    const startMs = Date.parse(start), endMs = Date.parse(end), nowMs = Date.now();
    // "Last N days/hours as of now" windows move every request; bucket them by minute and window length.
    // The Overview's "previous period" ends one window-length ago, so it is relative too: key it by how far back it
    // ends as well, or it never hits the cache.
    const length = endMs - startMs, back = nowMs - endMs;
    const window = Math.abs(back) <= 120_000 || Math.abs(back - length) <= 120_000 ? `rel:${Math.floor(nowMs / 60_000)}:${Math.round(back / 60_000)}:${Math.round(length / 60_000)}` : `abs:${start}:${end}`;
    // Cached until the workspace's next email or email event, so a send or delivery shows on the next read, the same
    // moment Logs lists it, instead of up to a minute later.
    const body = await dashboardRead(c, ['metrics', a.workspaceId, q.region ?? '', q.stream ?? '', q.granularity, [...new Set((q.include ?? '').split(',').filter(Boolean))].sort().join(','), window].join('|'), compute);
    c.header('x-nightmail-metrics-cache', body.cache);
    return c.json(body.value, 200);
  });
}

// Bits of sending_emails.event_outcomes, set by the operation_events trigger in migration 031.
const OUTCOME = { accepted: 1, delivered: 2, bounced: 4, complained: 8, opened: 16, clicked: 32, failed: 64, delayed: 128 } as const;
// Resumes one page of an unpaused endpoint's parked deliveries and returns the page's size; a full page means more
// may remain. A resumed delivery keeps the attempts it already made: a pause holds the remaining retries, it does not
// refill them. One that already used its attempts fails instead of starting another round. An endpoint paused again
// resumes nothing: its next unpause starts over.
const RESUME_PAGE = 100;
async function resumeParked(db: DbExecutor, workspaceId: string, webhookId: string) {
  const { rows } = await db.execute<{ n: number }>(sql`WITH hook AS MATERIALIZED (
      SELECT id FROM operation_webhooks WHERE workspace_id=${workspaceId} AND id=${webhookId} AND NOT paused FOR SHARE
    ), parked AS (
      SELECT d.id, d.attempt_count FROM operation_deliveries d JOIN hook ON hook.id=d.webhook_id WHERE d.workspace_id=${workspaceId} AND d.status='paused' ORDER BY d.id LIMIT ${RESUME_PAGE} FOR UPDATE OF d
    ), exhausted AS (
      UPDATE operation_deliveries d SET status='failed', last_error='WEBHOOK_RETRIES_EXHAUSTED', updated_at=now() FROM parked p WHERE d.id=p.id AND p.attempt_count>=${WEBHOOK_ATTEMPTS}
    ), resumed AS (
      UPDATE operation_deliveries d SET status='pending', generation=d.generation+1, updated_at=now() FROM parked p WHERE d.id=p.id AND p.attempt_count<${WEBHOOK_ATTEMPTS} RETURNING d.id, d.generation, d.attempt_count
    ), queued AS (
      INSERT INTO jobs(id, workspace_id, type, payload, attempts)
      SELECT public.row_id('job'), ${workspaceId}, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', generation), attempt_count FROM resumed
    ) SELECT count(*)::int AS n FROM parked`);
  return Number(rows[0]?.n ?? 0);
}
// Each page commits on its own; after a few seconds the job yields and is picked up again.
const resumeDeliveries: JobHandler = async (runtime, payload, job) => {
  for (const until = Date.now() + 5_000; Date.now() < until;)
    if (await resumeParked(runtime.db, job.workspaceId, String(payload.webhookId)) < RESUME_PAGE) return;
  throw new JobDeferred(now());
};
const webhookJob: JobHandler = async (runtime, payload, job) => {
  const delivery = job.webhook !== undefined ? job.webhook : (await runtime.db.execute<{webhook: import('./core.js').ClaimedWebhook | null}>(sql`WITH claimed AS (
    SELECT ${job.id}::text id,${job.workspaceId}::text workspace_id,${JSON.stringify(payload)}::jsonb payload,'operation.webhook'::text type
  ), ${webhookClaimCtes} ${claimedWithWebhooks}`)).rows[0]?.webhook;
  if (!delivery) return;
  const start = Date.now(); let statusCode: number | null = null, error: string | null = null, retryable = true;
  // A webhook tied to an approval is posted to only while that approval is active, like a request from a key the
  // approval created. Otherwise the delivery fails here, unsent; it can be retried by hand once the approval is active.
  // Every approval that owns it must be active: the rule getWebhook reports as approval.active (approval-ties.ts).
  const inactive = !!delivery.owned && !(await runtime.db.execute<{ allowed: boolean }>(sql`SELECT ${tieAllows(runtime.config, job.workspaceId, delivery.webhook_id, 'webhook')} AS allowed`)).rows[0]!.allowed;
  if (inactive) { error = 'APPROVAL_INACTIVE'; retryable = false; }
  else try {
    const url = webhookUrl(runtime, delivery.url), binding = secretBinding(job, delivery.webhook_id), secret = await decrypt(runtime, delivery.encrypted_secret, binding);
    const body = JSON.stringify(outwardEvent(eventSchema.parse(delivery.payload))), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmac(secret, `${delivery.event_id}.${timestamp}.${body}`);
    const result = await postWebhook(runtime, url, { 'Webhook-Id': delivery.event_id, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': webhookUserAgent, ...(delivery.synthetic ? Object.fromEntries(webhookTestHeaders.map(name => [name, 'true'])) : {}) }, body, delivery.encrypted_headers, binding);
    statusCode = result.status; if (statusCode < 200 || statusCode >= 300) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { if(e instanceof JobDeferred)throw e; error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < WEBHOOK_ATTEMPTS;
  const records = sql`attempt AS (INSERT INTO operation_delivery_attempts(id,workspace_id,delivery_id,status_code,error,duration_ms)
    SELECT ${id('wha')},${job.workspaceId},${delivery.delivery_id},${statusCode}::int,${error}::text,${Date.now()-start}::int FROM settled),
    recorded AS (UPDATE operation_deliveries SET attempt_count=attempt_count+1,status=${!error ? 'delivered' : retry ? 'pending' : 'failed'},
      last_status_code=${statusCode}::int,last_error=${error}::text,updated_at=now() FROM settled
      WHERE workspace_id=${job.workspaceId} AND operation_deliveries.id=${delivery.delivery_id} AND generation=${delivery.generation})`;
  if (job.recordWithSettlement) job.recordWithSettlement(records);
  else await runtime.db.execute(sql`WITH settled AS (SELECT 1), ${records} SELECT 1`);
  if (error && !inactive) throw new ApiError(503, error, 'Webhook delivery failed; inspect the stored delivery attempts.', undefined, retry);
};

const sesEvents: Record<string, { type: EventType; rawType: string }> = { Send: { type: 'email.sent', rawType: 'send' }, Delivery: { type: 'email.delivered', rawType: 'delivery' }, Bounce: { type: 'email.bounced', rawType: 'bounce' }, Complaint: { type: 'email.complained', rawType: 'complaint' }, DeliveryDelay: { type: 'email.delivery_delayed', rawType: 'delivery_delay' }, Reject: { type: 'email.rejected', rawType: 'reject' }, RenderingFailure: { type: 'email.rendering_failed', rawType: 'rendering_failure' }, Open: { type: 'email.opened', rawType: 'open' }, Click: { type: 'email.clicked', rawType: 'click' } };
function sesFeedbackIdentity(data: Record<string, any>) {
  const providerId = data?.mail?.messageId;
  if (typeof providerId !== 'string' || !providerId) throw new ApiError(422, 'SES_INVALID_EVENT', 'SES event lacks a mail.messageId.');
  const eventType = data.eventType ?? data.notificationType, kind = eventType === 'Rendering Failure' ? 'RenderingFailure' : eventType;
  if (typeof kind !== 'string' || (kind !== 'Subscription' && !Object.hasOwn(sesEvents,kind))) throw new ApiError(422, 'SES_UNSUPPORTED_EVENT', 'Unsupported SES event type.');
  return { providerId, kind };
}
// ISPs can omit feedback type on an actual complaint. An explicit non-abuse report
// (notably not-spam) is an observation, not permission to suppress the recipient.
function feedbackClass(kind: string, detail: Record<string, any>) {
  if (kind === 'Complaint') return typeof detail.complaintFeedbackType === 'string' && detail.complaintFeedbackType.trim().toLowerCase()==='not-spam' ? 'complaint_feedback' : 'complaint';
  if (kind === 'Bounce') return detail.bounceType !== 'Permanent' ? 'non_permanent_bounce' : detail.bounceSubType === 'EmailValidationSuppressed' ? 'validation_suppressed' : 'bounce';
  return sesEvents[kind]?.rawType;
}
// What a bounce or a delay keeps of SES's report, in its email event (EmailEventData): the receiving server's reply, of
// the first recipient that has one, as one bounded line; and a delay's kind and deadline. The reply is a stranger's
// text: bidi overrides, isolates and zero-width marks go (the set the dashboard takes from sender names,
// app/src/lib/private-address.ts), then control characters, surrogates and white space become single spaces. A bounce
// SES wrote itself keeps none: its text is about the sending account at Amazon, which a hosted sender cannot act on.
const DIAGNOSTIC_CHARS = 500, SES_BOUNCES = ['Suppressed', 'OnAccountSuppressionList', 'EmailValidationSuppressed'];
function feedbackReason(kind: string, detail: Record<string, any>) {
  if (kind !== 'Bounce' && kind !== 'DeliveryDelay') return {};
  const recipients: unknown = kind === 'Bounce' ? detail.bouncedRecipients : detail.delayedRecipients;
  const reply = kind === 'Bounce' && SES_BOUNCES.includes(detail.bounceSubType) ? undefined
    : (Array.isArray(recipients) ? recipients : []).map(r => typeof r?.diagnosticCode === 'string' ? r.diagnosticCode.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\s]+/g, ' ').trim() : '').find(Boolean);
  const expires = kind === 'DeliveryDelay' && typeof detail.expirationTime === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(detail.expirationTime) ? Date.parse(detail.expirationTime) : NaN;
  return { ...(reply ? { diagnosticCode: reply.slice(0, DIAGNOSTIC_CHARS) } : {}),
    ...(kind === 'DeliveryDelay' && typeof detail.delayType === 'string' && /^[A-Za-z]{1,64}$/.test(detail.delayType) ? { delayType: detail.delayType } : {}),
    ...(Number.isFinite(expires) ? { expirationTime: new Date(expires).toISOString() } : {}) };
}
function routineInput(item: FeedbackItem, enqueueOther = false): RoutineIngress {
  const data = item.message as Record<string, any>;
  const { kind, providerId } = sesFeedbackIdentity(data);
  const type = kind === 'Send' ? 'send' : kind === 'Delivery' ? 'delivery' : 'receipt';
  const simulated = simulatedTopic(item.topicArn, item.region);
  if (type === 'receipt' && simulated) throw new ApiError(422, 'SIMULATED_FEEDBACK_UNSUPPORTED', 'The simulator emits Send and Delivery callbacks only.');
  // HTTP without a queue still defers these to its durable job. The queue can apply the
  // same facts to a whole batch; subscription changes keep their distinct consent workflow.
  const detail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const extended = type === 'receipt' && !enqueueOther && kind !== 'Subscription';
  const timestamp = detail.timestamp;
  const createdAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : now();
  const payload = { message: item.message, topicArn: item.topicArn, messageId: item.messageId, region: item.region };
  const classification = feedbackClass(kind, detail), validation = classification === 'validation_suppressed';
  const engagement = kind === 'Open' || kind === 'Click';
  const reported = kind === 'Bounce' ? detail.bouncedRecipients : kind === 'Complaint' ? detail.complainedRecipients : undefined;
  return { type: extended ? classification! : type, providerId, taggedEmailId: taggedEmailId(item.message), createdAt, externalId: `${item.topicArn}:${item.messageId}`,
    data: { providerId, ...(validation ? {suppressionReason:'email_validation'} : {}), ...(engagement ? { isBotEvent: detail.isBotEvent ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof detail.link === 'string' ? { link: detail.link } : {}),
      ...(kind === 'Bounce' ? { bounceType: detail.bounceType ?? 'Unknown', bounceSubType: detail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Complaint' && detail.complaintFeedbackType != null ? {complaintFeedbackType:detail.complaintFeedbackType} : {}), ...feedbackReason(kind, detail) },
    ...(extended ? { effects: { reported: Array.isArray(reported) && reported.length ? reported.map(r => typeof r?.emailAddress === 'string' ? r.emailAddress.toLowerCase() : null) : null,
      suppress: classification === 'complaint' ? 'complaint' : validation ? 'email_validation' : classification === 'bounce' ? 'hard_bounce' : null,
      observe: engagement && detail.isBotEvent !== true && detail.isBotEvent !== 'Likely' ? kind.toLowerCase() : null,
      receiptTime: !(typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) } } : {}),
    ingress: { topicArn: item.topicArn, messageId: item.messageId, region: item.region, payload, recoveryType: type === 'receipt' && !enqueueOther && !extended ? undefined : simulated ? 'operation.simulatedFeedbackRecovery' : 'operation.ses' } };
}
/**
 * Batch feedback ingestion for the feedback queue consumer. Mail status, reputation, engagement
 * and delivery jobs commit in one statement per batch; subscription changes use the consent
 * workflow after opening a receipt. Returns one outcome per input so the caller
 * can acknowledge or retry messages individually. Live items are trusted only after the SNS
 * signature check at ingress; simulated items must carry the simulator's synthetic identity.
 */
export async function ingestFeedbackBatch(runtime: Runtime, items: FeedbackItem[]): Promise<{ ok: boolean; error?: string }[]> {
  const { ingestRoutineSesEvents } = await loadSendingOps();
  const outcomes: { ok: boolean; error?: string }[] = items.map(() => ({ ok: false }));
  const group: { index: number; input: RoutineIngress }[] = [];
  const other: { index: number; item: FeedbackItem; workspaceId: string }[] = [];
  for (const [index, item] of items.entries()) {
    // An SES tenant status change from EventBridge, published to the pool's own feedback topic (src/standing.ts).
    // A database failure propagates, so the queue redelivers it.
    const standing = runtime.config.multiTenant && !simulatedTopic(item.topicArn) && item.message?.source === 'aws.ses' ? await import('./standing.js') : null;
    const tenantEvent = standing?.tenantStatusEvent(item.message);
    if (standing && tenantEvent) {
      const refused = await standing.ingestTenantStatus(runtime, tenantEvent, item);
      outcomes[index] = refused ? { ok: false, error: refused } : { ok: true }; continue;
    }
    try {
      if (simulatedTopic(item.topicArn)) assertSimulatedFeedback(runtime, item);
      else verifySesAccount(runtime, item.message, item.topicArn);
      group.push({ index, input: routineInput(item) });
    } catch (error) { outcomes[index] = { ok: false, error: error instanceof ApiError ? error.code : 'FEEDBACK_INVALID' }; }
  }
  const persist = async (batch: typeof group, retry = true): Promise<void> => {
    if (!batch.length) return;
    let results: Awaited<ReturnType<typeof ingestRoutineSesEvents>>;
    try {
      results = await ingestRoutineSesEvents(runtime, batch.map(entry => entry.input));
    } catch (error) {
      if (error instanceof ModuleLoadError) throw error;
      const failure=feedbackFailure(error);
      if (failure!=='retry' && (batch.length>1 || retry)) {
        if (failure==='conflict') await feedbackBackoff();
        if (batch.length===1) return persist(batch,false);
        const mid=Math.ceil(batch.length/2);
        await persist(batch.slice(0,mid)); await persist(batch.slice(mid)); return;
      }
      for (const {index} of batch) outcomes[index]=failure==='data' ? await quarantineFeedback(runtime,items[index]!) : {ok:false,error:'FEEDBACK_PERSIST_FAILED'};
      return;
    }
    for (const [position, entry] of batch.entries()) {
      const result = results[position]!;
      if (result.error || !result.workspaceId) {
        const error = result.error ?? 'SES_EMAIL_NOT_FOUND';
        outcomes[entry.index] = { ok: false, error: !result.workspaceId && error === 'SES_EMAIL_NOT_FOUND' ? 'SES_FEEDBACK_UNMATCHED' : error };
        continue;
      }
      if (entry.input.type === 'receipt') { other.push({ index: entry.index, item: items[entry.index]!, workspaceId: result.workspaceId }); continue; }
      outcomes[entry.index] = { ok: true };
    }
    try {
      if(results.some(r=>r.recovery)) await runtime.wake?.(1);
      if(results[0]?.hooks) await runtime.wake?.(results[0].hooks,'webhook');
    }catch{log('warn',{code:'QUEUE_WAKE_FAILED',message:'Feedback recovery and webhook jobs remain durable.'});}
  };
  await persist(group);
  // Subscription changes include separate consent audit records; preserve their input order.
  for (const { index, item, workspaceId } of other.sort((a,b)=>a.index-b.index)) {
    for (let attempt=1; attempt<=2; attempt++) try {
      await processSesReceipt(runtime, item, { id: `feedback:${item.topicArn}:${item.messageId}`, attempts: attempt, workspaceId });
      outcomes[index] = { ok: true }; break;
    } catch (error) {
      if (error instanceof ModuleLoadError) throw error;
      if (error instanceof ApiError && (error.code === 'SES_EMAIL_NOT_FOUND' || error.code === 'SES_ENVIRONMENT_MISMATCH')) {
        outcomes[index] = {ok:false,error:error.code}; break;
      }
      const failure=feedbackFailure(error);
      if (failure==='retry' || attempt===2) {
        outcomes[index]=failure==='data' ? await quarantineFeedback(runtime,item,workspaceId) : {ok:false,error:'FEEDBACK_PROCESS_FAILED'}; break;
      }
      if (failure==='conflict') await feedbackBackoff();
    }
  }
  return outcomes;
}

function feedbackFailure(error: unknown) {
  if (error instanceof ApiError) return error.retryable ? 'retry' : 'data';
  const pg=error as {cause?:{code?:string};code?:string}|null, code=pg?.cause?.code ?? pg?.code ?? '';
  if (code==='40P01' || code==='40001') return 'conflict';
  return /^(22|23|54)[0-9A-Z]{3}$/.test(code) ? 'data' : 'retry';
}
const feedbackBackoff=()=>new Promise(resolve=>setTimeout(resolve,10+Math.random()*20));
async function quarantineFeedback(runtime: Runtime, item: FeedbackItem, workspaceId?:string) {
  try {
    // Keep the verified input as escaped JSON text, not JSONB: a diagnostic may contain NUL.
    const key = await digest(JSON.stringify([item.topicArn,item.messageId]));
    const provider=(item.message.mail as {messageId?:unknown})?.messageId, tag=taggedEmailId(item.message);
    const simulated=simulatedTopic(item.topicArn, item.region);
    // Never take a workspace ID from a payload. Prefer the receipt; a rolled-back first
    // receipt can still be attributed if its pinned topic/region/provider match is unique.
    await runtime.db.execute(sql`INSERT INTO operation_feedback_failures(id,payload,topic_arn,workspace_id) VALUES (${key},${JSON.stringify(item)},${item.topicArn},
      coalesce(${workspaceId??null}::text,(SELECT workspace_id FROM operation_sns_receipts WHERE topic_arn=${item.topicArn} AND message_id=${item.messageId}),
        (SELECT min(workspace_id) FROM sending_emails WHERE region=${item.region} AND simulated=${simulated} AND provider_id=${typeof provider==='string' && /^[!-~]+$/.test(provider)?provider:null}
          ${tag?sql`AND id=${tag}`:sql``} ${!simulated && runtime.config.multiTenant?sql`AND feedback_topic_arn=${item.topicArn}`:sql``} HAVING count(*)=1))) ON CONFLICT DO NOTHING`);
    log('error',{code:'SES_FEEDBACK_QUARANTINED',id:key});
    return {ok:false,error:'SES_FEEDBACK_QUARANTINED'};
  } catch { return {ok:false,error:'FEEDBACK_PERSIST_FAILED'}; }
}

const UNTAGGED_PAYLOAD_CAP = 65536, RECOVERY_PREFIX = 'feedback-recovery/v1/';
type QueueRecoveryReason = 'FEEDBACK_UNTAGGED' | 'FEEDBACK_LEGACY_RECOVERY' | 'FEEDBACK_QUEUE_RECOVERY';
function recoverableJson(body: unknown): string | undefined {
  const seen = new Set<object>();
  const valid = (value: unknown): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    seen.add(value);
    const entries = Object.entries(value);
    const ok = (!Array.isArray(value) || entries.length === value.length && entries.every(([key], index) => key === String(index))) && entries.every(([, v]) => valid(v));
    seen.delete(value); return ok;
  };
  try { return valid(body) ? JSON.stringify(body) : undefined; } catch { return undefined; }
}
async function retainQueueFeedback(runtime: Runtime, lane: string, body: unknown, reason: QueueRecoveryReason): Promise<string | undefined> {
  // JSON is the provider-feedback format. Never replace an unrepresentable body with a preview and ack it.
  const text = recoverableJson(body); if (text === undefined) return;
  const prefix = reason === 'FEEDBACK_UNTAGGED' ? 'untagged' : reason === 'FEEDBACK_LEGACY_RECOVERY' ? 'legacy' : 'queue';
  const key = `${prefix}:${await digest(`${lane}\n${text}`)}`;
  const topic = (body as { topicArn?: unknown; body?: { topicArn?: unknown } } | null)?.topicArn ?? (body as { body?: { topicArn?: unknown } } | null)?.body?.topicArn;
  const chunks: string[] = [];
  if (text.length > UNTAGGED_PAYLOAD_CAP) {
    // Split on Unicode code points: passing a lone surrogate to PostgreSQL would destroy that byte sequence.
    const points = Array.from(text);
    for (let i = 0; i < points.length; i += 16384) chunks.push(points.slice(i, i + 16384).join(''));
  }
  return runtime.db.transaction(async tx => {
    const result = await tx.execute(sql`INSERT INTO operation_feedback_failures(id,payload,topic_arn,reason,payload_chunk_count)
      VALUES (${key},${chunks.length ? '' : text},${typeof topic === 'string' && topic.length <= 512 ? topic : null},${reason},${chunks.length})
      ON CONFLICT (id) DO UPDATE SET reason=EXCLUDED.reason RETURNING id`);
    if (result.rowCount !== 1) return;
    if (chunks.length) await tx.execute(sql`INSERT INTO operation_feedback_failure_chunks(failure_id,ordinal,payload)
      SELECT ${key},ordinality-1,payload FROM unnest(${sql.param(chunks)}::text[]) WITH ORDINALITY AS c(payload,ordinality) ON CONFLICT DO NOTHING`);
    return key;
  });
}
/**
 * Keeps an untagged item from the legacy feedback queue for operator review. The body is untrusted:
 * it is stored as complete text/chunks under a content digest and never attributed from its body.
 */
export async function quarantineUntaggedFeedback(runtime: Runtime, lane: string, body: unknown): Promise<boolean> {
  return !!await retainQueueFeedback(runtime, lane, body, 'FEEDBACK_UNTAGGED');
}
async function retainOrSpillFeedback(runtime: Runtime, body: import('./adapters/feedback-queue.js').LegacyFeedbackRecovery | import('./adapters/feedback-archive.js').FeedbackArchive, reason: QueueRecoveryReason): Promise<'database' | 'storage'> {
  try {
    if (!await retainQueueFeedback(runtime, body.source.queue, body, reason)) throw new Error('Feedback recovery could not be encoded');
    return 'database';
  } catch {
    // Independent of PostgreSQL and queue-message size. The complete, authenticated object is
    // reconciled into the quarantine table by the minute cron before this key is removed.
    const text = JSON.stringify(body), key = `${RECOVERY_PREFIX}${await digest(text)}.json`;
    await runtime.storage.put(key, Buffer.from(text), 'application/json');
    log('warn', { code: 'FEEDBACK_RECOVERY_SPILLED', sourceQueue: body.source.queue, sourceId: body.source.id });
    return 'storage';
  }
}
export async function retainLegacyFeedback(runtime: Runtime, body: import('./adapters/feedback-queue.js').LegacyFeedbackRecovery): Promise<'database' | 'storage'> {
  const { authenticLegacyRecovery } = await import('./adapters/feedback-queue.js');
  if (!authenticLegacyRecovery(runtime.config, body)) throw new Error('Unauthenticated legacy recovery');
  return retainOrSpillFeedback(runtime, body, 'FEEDBACK_LEGACY_RECOVERY');
}
export async function archiveQueueFeedback(runtime: Runtime, source: import('./adapters/feedback-archive.js').FeedbackSource, body: unknown, error: string): Promise<void> {
  const { feedbackArchive } = await import('./adapters/feedback-archive.js');
  const archive = await feedbackArchive(runtime.config.authSecret, source, body, error);
  await retainOrSpillFeedback(runtime, archive, 'FEEDBACK_QUEUE_RECOVERY');
}
/** Drain the private object-store spill buffer into PostgreSQL; never ingest from storage directly. */
export async function drainFeedbackRecovery(runtime: Runtime): Promise<number> {
  if (!runtime.storage.list) return 0;
  const [{ authenticLegacyRecovery }, { authenticFeedbackArchive }] = await Promise.all([import('./adapters/feedback-queue.js'),import('./adapters/feedback-archive.js')]);
  let stored = 0, after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await runtime.storage.list(RECOVERY_PREFIX, after);
    for (const entry of listed.objects) {
      const object = await runtime.storage.get(entry.key); if (!object) continue;
      const text = Buffer.from(object.body).toString('utf8');
      if (entry.key !== `${RECOVERY_PREFIX}${await digest(text)}.json`) { log('error',{code:'FEEDBACK_RECOVERY_CORRUPT'}); continue; }
      let value: unknown; try { value = JSON.parse(text); } catch { log('error',{code:'FEEDBACK_RECOVERY_CORRUPT'}); continue; }
      const reason = authenticLegacyRecovery(runtime.config,value) ? 'FEEDBACK_LEGACY_RECOVERY' : authenticFeedbackArchive(runtime.config,value) ? 'FEEDBACK_QUEUE_RECOVERY' : undefined;
      if (!reason) { log('error',{code:'FEEDBACK_RECOVERY_UNAUTHENTICATED'}); continue; }
      const source = (value as {source:{queue:string}}).source;
      if (!await retainQueueFeedback(runtime,source.queue,value,reason)) throw new Error('Feedback recovery could not be restored');
      await runtime.storage.delete(entry.key); stored++;
    }
    after = listed.cursor; if (!after) break;
  }
  return stored;
}
export async function completeLegacyFeedback(runtime: Runtime, body: import('./adapters/feedback-queue.js').LegacyFeedbackRecovery): Promise<void> {
  const id = `legacy:${await digest(`${body.source.queue}\n${JSON.stringify(body)}`)}`;
  await runtime.db.execute(sql`DELETE FROM operation_feedback_failures WHERE id=${id} AND reason='FEEDBACK_LEGACY_RECOVERY'`);
}
export async function readFeedbackQuarantine(runtime: Runtime, ids?: string[], after?: string) {
  const rows = (await runtime.db.execute<{ id: string; reason: string; payload: string; topic_arn: string | null; created_at: string; payload_chunk_count: number; actual_chunks: number }>(sql`
    SELECT f.id,f.reason,CASE WHEN f.payload_chunk_count=0 THEN f.payload ELSE c.payload END AS payload,
      f.topic_arn,f.created_at::text,f.payload_chunk_count,coalesce(c.n,0)::int AS actual_chunks
    FROM operation_feedback_failures f LEFT JOIN LATERAL
      (SELECT string_agg(payload,'' ORDER BY ordinal) AS payload,count(*) AS n FROM operation_feedback_failure_chunks WHERE failure_id=f.id) c ON true
    WHERE f.reason IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY') ${ids ? sql`AND f.id = ANY(${sql.param(ids)}::text[])` : sql``}
      ${after ? sql`AND (f.created_at,f.id) > (SELECT created_at,id FROM operation_feedback_failures WHERE id=${after})` : sql``}
    ORDER BY f.created_at,f.id LIMIT 500`)).rows;
  for (const row of rows) if (row.payload_chunk_count !== row.actual_chunks) throw new Error(`Incomplete feedback recovery ${row.id}`);
  return rows;
}
/** Replays only authenticated quarantine rows. An operator's selection is not provider provenance. */
export async function replayQuarantinedFeedback(runtime: Runtime, ids: string[]): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (!ids.length) return [];
  const { authenticatedFeedbackItem } = await import('./adapters/feedback-queue.js');
  const { authenticFeedbackArchive, feedbackArchiveBody } = await import('./adapters/feedback-archive.js');
  const rows = await readFeedbackQuarantine(runtime, ids);
  const items: { id: string; item?: FeedbackItem; error?: string }[] = rows.map(row => {
    try {
      const stored = JSON.parse(row.payload), raw = authenticFeedbackArchive(runtime.config,stored) ? feedbackArchiveBody(stored) : stored;
      const authenticated = authenticatedFeedbackItem(runtime.config, raw);
      const value = authenticated ?? raw as Partial<FeedbackItem> | null;
      if (!value || typeof value !== 'object' || typeof value.region !== 'string' || typeof value.topicArn !== 'string' || typeof value.messageId !== 'string' || !value.message || typeof value.message !== 'object') return { id: row.id, error: 'FEEDBACK_INVALID' };
      if (!authenticated) return { id: row.id, error: 'FEEDBACK_UNAUTHENTICATED' };
      return { id: row.id, item: authenticated };
    } catch { return { id: row.id, error: 'FEEDBACK_INVALID' }; }
  });
  const outcomes = await ingestFeedbackBatch(runtime, items.flatMap(entry => entry.item ? [entry.item] : []));
  const results = items.map(entry => entry.item ? { id: entry.id, ...outcomes.shift()! } : { id: entry.id, ok: false, error: entry.error });
  const done = results.filter(r => r.ok).map(r => r.id);
  if (done.length) await runtime.db.execute(sql`DELETE FROM operation_feedback_failures WHERE reason IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY') AND id = ANY(${sql.param(done)}::text[])`);
  return results;
}

const processSesReceipt: JobHandler = async (runtime, payload, job) => {
  const receiptWhere = and(scoped(snsReceipts, job), eq(snsReceipts.topicArn, String(payload.topicArn)), eq(snsReceipts.messageId, String(payload.messageId)));
  const data = payload.message as Record<string, any>;
  const { recordEmailEvent } = await loadSendingOps();
  const { kind, providerId } = sesFeedbackIdentity(data);
  const tagged = taggedEmailId(data);
  const [input] = await runtime.db.select({ receipt: snsReceipts, hostedFeedback: runtime.config.multiTenant && (kind==='Bounce' || kind==='Complaint')
    ? sql<boolean>`EXISTS (SELECT 1 FROM provider_feedback_history WHERE topic_arn=${String(payload.topicArn)} AND kind='shared')` : sql<boolean>`false`, email: {
    id: emails.id, region: emails.region, to: emails.to, cc: emails.cc, bcc: emails.bcc, simulated: emails.simulated,
  } }).from(snsReceipts).leftJoin(emails, and(scoped(emails, job), eq(emails.region, String(payload.region)),runtime.config.multiTenant && !simulatedTopic(payload.topicArn) ? sql`"sending_emails".feedback_topic_arn=${String(payload.topicArn)}` : undefined, tagged
    // Fallback for a lost provider response: see ingestRoutineSesEvents.
    ? and(eq(emails.id, tagged), or(eq(emails.providerId, providerId), and(isNull(emails.providerId), eq(emails.status, 'acceptance_unknown'))))
    : eq(emails.providerId, providerId))).where(receiptWhere);
  if (!input || input.receipt.processedAt) return;
  const { receipt, email } = input;
  if (!email) throw new ApiError(409, 'SES_EMAIL_NOT_FOUND', 'The SES message is not yet associated with a local email.', undefined, true);
  if (email.simulated !== simulatedTopic(payload.topicArn, String(payload.region))) throw new ApiError(403, 'SES_ENVIRONMENT_MISMATCH', 'Feedback and email simulation modes must match.');
  if (kind === 'Subscription') {
    const preferences = data.subscription?.newTopicPreferences;
    // SES topic defaults are not evidence of app-wide opt-in; never reverse local opt-outs from them.
    if (preferences?.unsubscribeAll === true && email.to.length === 1 && !email.cc.length && !email.bcc.length) {
      await (await wrapModuleLoad(() => import('./audience.js'))).recordUnsubscribe(runtime, job.workspaceId, email.to[0]!, 'ses-subscription');
    } else {
      await publishEvent(runtime, { id: `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`, type: 'contact.subscription_changed', createdAt: receipt.createdAt, workspaceId: job.workspaceId, region: email.region, data: { emailId: email.id, source: 'ses', preferences: preferences ?? null, appliedToWorkspaceConsent: false } });
    }
    await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere); return;
  }
  const mapped = sesEvents[kind]!;
  const eventDetail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const eventTime = typeof eventDetail.timestamp === 'string' && Number.isFinite(Date.parse(eventDetail.timestamp)) ? new Date(eventDetail.timestamp).toISOString() : receipt.createdAt;
  const eventId = `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`;
  const normalized: PublishedEvent = { id: eventId, workspaceId: job.workspaceId, region: email.region, type: mapped.type, createdAt: eventTime, data: { emailId: email.id, providerId, ...(kind === 'Open' || kind === 'Click' ? { isBotEvent: eventDetail.isBotEvent ?? 'Unknown' } : {}), ...((kind === 'Bounce') ? { bounceType: eventDetail.bounceType ?? 'Unknown', bounceSubType: eventDetail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof eventDetail.link === 'string' ? { link: eventDetail.link } : {}), ...feedbackReason(kind, eventDetail) } };
  // Routine send/delivery events have no later consent or engagement writes.
  // Mark their receipt in the same commit as status, event and webhook fan-out.
  const routine = kind === 'Send' || kind === 'Delivery';
  // SES Auto Validation drops risky recipients before sending and reports each as a Permanent bounce with this subtype.
  // It never left SES, so record it as suppressed (not bounced); the contact is still suppressed below.
  const classification = feedbackClass(kind,eventDetail)!, validationSuppressed = classification === 'validation_suppressed';
  if (kind === 'Complaint' && eventDetail.complaintFeedbackType != null) normalized.data.complaintFeedbackType=eventDetail.complaintFeedbackType;
  if (validationSuppressed) normalized.data.suppressionReason='email_validation';
  const candidates: unknown[] = kind === 'Bounce' ? (data.bounce?.bouncedRecipients ?? []).map((r: any) => r.emailAddress) : kind === 'Complaint' ? (data.complaint?.complainedRecipients ?? []).map((r: any) => r.emailAddress) : (email.to.length === 1 && !email.cc.length && !email.bcc.length ? email.to : []);
  const envelope = new Set([...email.to,...email.cc,...email.bcc].map(v => v.toLowerCase()));
  const recipients = [...new Set(candidates.filter((v): v is string => typeof v === 'string').map(v => v.toLowerCase()).filter(v => envelope.has(v)))];
  // One SNS notification can identify up to 50 recipients. Scope hashes to this message so they
  // deduplicate overlapping reports without linking recipients across mail. [] means no real matched recipient;
  // absent recipient evidence counts as one, just like legacy feedback rows.
  const recipientHashes = input.hostedFeedback && !email.simulated && (classification === 'bounce' || classification === 'complaint') && candidates.length
    ? await Promise.all(recipients.filter(realDestination).map(v => digest(`${email.id}\0${v}`))) : undefined;
  await recordEmailEvent(runtime, { workspaceId: job.workspaceId, emailId: email.id, providerId, type: classification,
    ...(validationSuppressed ? { errorCode: 'EMAIL_VALIDATION_SUPPRESSED' } : {}), externalId: `${payload.topicArn}:${payload.messageId}`, data: normalized.data, createdAt: eventTime, recipientHashes,
    ...(routine ? { receipt: { topicArn: String(payload.topicArn), messageId: String(payload.messageId) } } : {}),
  });
  if (routine) return;
  const suppress = classification === 'complaint' || classification === 'bounce' || validationSuppressed;
  const observeEngagement = (kind === 'Open' || kind === 'Click') && normalized.data.isBotEvent !== true && normalized.data.isBotEvent !== 'Likely';
  if (recipients.length && (suppress || observeEngagement)) await runtime.db.transaction(async tx => {
    // Several contacts are locked in email order, as the database sorts it, wherever several are (imports, the feedback
    // batch, lockContacts in audience.ts): a bounce for two people and someone adding both to a list wait for each
    // other instead of deadlocking. SES lists the recipients in its own order.
    const ordered = recipients.length > 1 ? (await tx.execute<{ address: string }>(sql`SELECT address FROM unnest(${sql.param(recipients)}::text[]) address ORDER BY address`)).rows.map(row => row.address) : recipients;
    for (const address of ordered) {
      const contactWhere = and(scoped(contacts, job), eq(contacts.email, address));
      if (suppress) {
        const suppressionReason = kind === 'Complaint' ? 'complaint' : validationSuppressed ? 'email_validation' : 'hard_bounce';
        await tx.execute(sql`INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,suppressed_at)
          VALUES (${id('con')},${job.workspaceId},${address},true,${suppressionReason},${eventTime}) ON CONFLICT ON CONSTRAINT audience_contacts_email_scope
          DO UPDATE SET ${mergeSuppression},updated_at=now()`);
      } else if (observeEngagement) {
        const column = kind === 'Open' ? contacts.lastOpenAt : contacts.lastClickAt;
        const observed = kind === 'Open' ? contacts.openObservedSince : contacts.clickObservedSince;
        await tx.update(contacts).set({ [kind === 'Open' ? 'lastOpenAt' : 'lastClickAt']: sql`greatest(${column}, ${eventTime}::timestamptz)`, [kind === 'Open' ? 'openObservedSince' : 'clickObservedSince']: sql`least(coalesce(${observed}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, observedSince: sql`least(coalesce(${contacts.observedSince}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, updatedAt: now() }).where(contactWhere);
      }
    }
  });
  await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere);
};
const sesJob: JobHandler = async (runtime, payload, job) => {
  if (simulatedTopic(payload.topicArn)) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'Synthetic callbacks are not SNS events.');
  verifySesAccount(runtime, payload.message, String(payload.topicArn));
  await processSesReceipt(runtime, payload, job);
};
function assertSimulatedFeedback(runtime: Runtime, payload: Record<string, unknown>) {
  const message = payload.message as { mail?: { messageId?: unknown } } | undefined;
  if (!isSimulatedSes(runtime) ||
    !simulatedTopic(payload.topicArn, String(payload.region)) ||
    typeof message?.mail?.messageId !== 'string' || !message.mail.messageId.startsWith('sim_')) {
    throw new ApiError(403, 'SIMULATED_FEEDBACK_FORBIDDEN', 'Synthetic feedback requires a simulated deployment and a synthetic provider identity.');
  }
}
const simulatedFeedbackJob: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  const { ingestRoutineSesEvent } = await loadSendingOps();
  const input = routineInput({ topicArn: String(payload.topicArn), messageId: String(payload.messageId), region: String(payload.region), message: payload.message as Record<string, unknown> });
  await ingestRoutineSesEvent(runtime, { ...input, workspaceId: job.workspaceId });
};
const simulatedFeedbackRecovery: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  await processSesReceipt(runtime, payload, job);
};
const publishJob: JobHandler = async (runtime, payload, job) => {
  const parsed = eventSchema.safeParse(payload.event);
  if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'The queued event is invalid or has mismatched scope.');
  await publishEvent(runtime, parsed.data);
};
const publishBatchJob: JobHandler = async (runtime, payload, job) => {
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) throw new ApiError(422, 'INVALID_EVENT_BATCH', 'Event batches must contain between one and 100 events.');
  const batch: PublishedEvent[] = [];
  for (const value of payload.events) {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'A queued batch event is invalid or has mismatched scope.');
    batch.push(parsed.data);
  }
  const unique = batch.filter((event, index) => batch.findIndex(candidate => candidate.id === event.id) === index);
  await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(unique).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return;
    const accepted = new Set(inserted.map(row => row.id));
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, unique[0]!), eq(webhooks.paused, false)));
    const queued = unique.filter(event => accepted.has(event.id)).flatMap(event => endpoints.filter(endpoint =>
      endpoint.eventTypes.includes(event.type) && (!endpoint.regions || event.region === null || endpoint.regions.includes(event.region))
    ).map(endpoint => ({ event, endpoint, deliveryId: rowId('whd') })));
    if (!queued.length) return;
    for (let offset = 0; offset < queued.length; offset += 1000) {
      const group = queued.slice(offset, offset + 1000);
      await tx.insert(deliveries).values(group.map(({ event, endpoint, deliveryId }) => ({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event })));
      await tx.insert(jobs).values(group.map(({ event, deliveryId }) => ({ id: rowId('job'), type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } })));
    }
  });
};
export const operationJobs: Record<string, JobHandler> = { 'domain.placement': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('./placement.js'))).shadowPlacement(...args); }), 'domain.verify': retryDatabaseFailures(domainVerify), 'domain.setupCheck': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('./domain-setup.js'))).domainSetupCheckJob(...args); }), 'domain.mx': retryDatabaseFailures(domainMx), 'operation.webhook': retryDatabaseFailures(webhookJob), 'operation.resumeDeliveries': retryDatabaseFailures(resumeDeliveries), 'operation.ses': retryDatabaseFailures(sesJob), 'operation.simulatedFeedback': retryDatabaseFailures(simulatedFeedbackJob), 'operation.simulatedFeedbackRecovery': retryDatabaseFailures(simulatedFeedbackRecovery), 'operation.publish': retryDatabaseFailures(publishJob), 'operation.publishBatch': retryDatabaseFailures(publishBatchJob) };
