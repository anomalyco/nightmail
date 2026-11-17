import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { actorMailAccess, mailboxRoute, receivingConsentRoute, workspaceMailAccess, ApiError, RECEIVING_HOST_CHANGE, digest, errors, getSes, id, isoTime, json, KEY_CHANGE, lasting, lazyModule, log, ModuleLoadError, response, SuppressionEventData, type Actor, type App, type Ctx, type DbExecutor, type MailboxAccess, type Runtime } from './core.js';
import { authenticate, chargeCredential, createdInboxes, delegatedInbox, longPoll, requireReceivingConsent, reservePolls } from './auth.js';
import { boundRequestBody } from './request-body.js';
import { auditContext, auditInsert, recordAudit } from './audit.js';
import { domains } from './db/operations.js';
import { claimReceivable, claimReceives, claimSends, connectionReady, receivingSetup, setupError, type ReceivingSetup } from './states.js';
import { mailboxAddresses, mailboxDomains, mailboxes, mailboxKeys, mailboxThreads, mailMessages, mailUnrouted, type MailboxPermission } from './db/mailbox.js';
import { expectedMx, checkMx, mxBlocksEnable } from './mailbox-dns.js';
import { eventView, inboundEventTypes, latestCursor, readEvents, recordEvents } from './mailbox-events.js';
import { queueReconcile,saveMailboxMx } from './mailbox-setup.js';
import { attachToMailboxes, checkRuleCapacity, checkTemporaryMailboxRouting, createMailbox, htmlToPlain, lockMailboxLane, ruleMatches, validateRule, ADDRESS, type Scope } from './mailbox-store.js';
import { detachDestination, registerRouting, RoutingKey } from './routing.js';
import { registerRituals } from './rituals.js';
import { Ok, registerInboundWebhooks } from './endpoints.js';
import { AttachmentContentId, AttachmentContentType, AttachmentDisposition, AttachmentFilename, MAX_ATTACHMENT_BASE64 } from './outbound-content.js';
import { CustomHeaders, splitThreadingHeaders } from './custom-headers.js';
import { assertRegisteredSender, assertReplyable, DEFAULT_SEND_LIMITS, safeForwardHtml, replyParentId, replyRecipients, replyReferences, replySubject, resolveAttachments, sendLimitsFor } from './mailbox-send.js';
import { withRegionSettings } from './ses-region-state.js';
import { mailboxCreates } from './idempotency.js';
import { registerLogs } from './logs.js';
import { registerInboundOverview } from './inbound-overview.js';
import { AddressState, assertInboundRecipients, createInboundThreadRoute, InboundAddressId, inboundReplyTarget, queueInboundThreadMessage, registerInboundThreadReads, replyToInboundThreadRoute, visibleThreadAddresses } from './inbound-threads.js';
import { legacyAddressOperations, productName } from './brand.js';
import { receivingIssueSchema } from './operations.js';
import { addHost, enableHosted, listHosts, removeHost, updateHost } from './receiving-hosts.js';

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
const loadMailboxSesv2 = lazyModule(() => import('@aws-sdk/client-sesv2'));

// ---------- access ----------
function access(c: Ctx, permission?: MailboxPermission): MailboxAccess {
  const value = c.get('mailboxAccess');
  if (!value) throw new ApiError(401, 'AUTH_REQUIRED', `Supply an inbound key or a ${productName} API key.`);
  if (permission && !value.admin && !value.permissions.includes(permission)) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
function admin(c: Ctx) { const value = access(c); if (!value.admin) throw new ApiError(403, 'ADMIN_REQUIRED', `This operation requires an unrestricted live ${productName} key with manage permission.`); return value; }
/** A change to receiving hosts outlives the credential making it: an administrator, never a temporary agent token (lastingRoute). */
function hostAdmin(c: Ctx) { const value = admin(c); lasting(c, RECEIVING_HOST_CHANGE); return value; }
const scopeOf = (value: MailboxAccess): Scope => ({ workspaceId: value.workspaceId });
async function mailboxFor(c: Ctx, mailboxId: string, permission: MailboxPermission = 'read', db: DbExecutor = c.env.db) {
  const value = access(c, permission);
  if (value.mailboxIds && !value.mailboxIds.includes(mailboxId)) throw new ApiError(404, 'NOT_FOUND', 'Receiving address was not found.');
  const [row] = await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), eq(mailboxes.id, mailboxId)));
  if (!row || row.deleteAfter && Date.parse(row.deleteAfter)<=Date.now() || delegatedInbox(c.env) && row.kind!=='inbox') throw new ApiError(404, 'NOT_FOUND', 'Receiving address was not found.');
  return { access: value, mailbox: row, scope: scopeOf(value) };
}

export async function authorizeInboxKey(c:Ctx,token:string):Promise<MailboxAccess>{
  const key=await chargeCredential<{id:string;workspace_id:string;grant_id:string|null;mailbox_ids:string[]|null;scope_ids:string[]|null;permissions:MailboxPermission[]}>(c, mailboxKeys,sql`
    SELECT k.id,k.workspace_id,k.id AS key_id,g.grant_id,k.mailbox_ids AS scope_ids,CASE WHEN k.permissions ? 'create' THEN coalesce(k.mailbox_ids,'[]'::jsonb)||${createdInboxes(sql`k.workspace_id`, sql`k.id`)} ELSE k.mailbox_ids END AS mailbox_ids,k.permissions,${c.env.config.apiRateLimitPerMinute}::int AS max_requests FROM mailbox_keys k LEFT JOIN mail_grant_objects g ON g.workspace_id=k.workspace_id AND g.kind='key' AND g.resource=k.id WHERE hash=${await digest(token)} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`);
  if(!key)throw new ApiError(401,'AUTH_INVALID','The inbox key is invalid or expired.');
  if(key.grant_id){
    const grant=await (await import('./mcp-auth.js')).getMcpGrantActor(c.env,'mcp_'+key.grant_id,key.workspace_id);
    if(grant?.workspaceId!==key.workspace_id||!grant.receivingConsent||!grant.permissions.includes('manage'))throw new ApiError(401,'AUTH_INVALID','The originating receiving approval is no longer active.');
  }
  return {keyId:key.id,grantId:key.grant_id??undefined,workspaceId:key.workspace_id,admin:false,mailboxIds:key.mailbox_ids,scopeIds:key.scope_ids,permissions:key.permissions};
}
async function mailboxAuth(c: Ctx, next: () => Promise<void>) {
  const delegated=delegatedInbox(c.env);if(delegated){c.set('mailboxAccess',delegated);return next();}
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (token && /^(?:nm|bane|os)_mbx_/.test(token)) { // bane_/os_: remove after rename cleanup
    if (!/^(?:nm|bane|os)_mbx_[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The mailbox key is invalid or has been revoked.');
    c.set('mailboxAccess', await authorizeInboxKey(c,token));
    return next();
  }
  return authenticate(c, async () => {
    const value = workspaceMailAccess(c.get('actor'), c.req.method, c.req.path);
    if (value === 'UNRESTRICTED_KEY_REQUIRED') throw new ApiError(403, value, 'Use an address-scoped inbound key or an unrestricted live manage credential.');
    if (value === 'ADMIN_REQUIRED') throw new ApiError(403, value, 'Inbound requires an address-scoped key or an unrestricted live manage credential.');
    c.set('mailboxAccess', value);
    await next();
  });
}

// ---------- helpers ----------
const iso = isoTime;
const labelName = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9][a-z0-9 _.:/-]*$/, 'Labels use letters, numbers, spaces and _ . : / -');

// ---------- schemas ----------
const MxRecord = z.object({ type: z.literal('MX'), name: z.string(), value: z.string(), priority: z.number() });
const MxReportSchema = z.object({ state: z.enum(['active', 'missing', 'conflict', 'mixed', 'wrong_region', 'null_mx', 'cname', 'error']), expected: MxRecord, records: z.array(z.object({ priority: z.number(), host: z.string(), provider: z.string().nullable() })), providers: z.array(z.string()), message: z.string(), checkedAt: z.string(), target: z.string().optional().describe('The existing CNAME target when state is cname.'), split: z.boolean().optional().describe('Mail for the name may be split across several MX hosts.') }).openapi('InboundMxReport');
const InboundCatchAll = z.enum(['create_address', 'store']);
const InboundDomainStatus = z.enum(['off', 'provisioning', 'waiting_for_mx', 'active', 'disabling', 'disabled', 'failed']);
const InboundDomainSchema = z.object({
  id: z.string().describe(`${productName} domain ID.`), name: z.string(), region: z.string(),
  status: InboundDomainStatus,
  catchAll: InboundCatchAll.describe('For an unknown recipient, create_address creates a receiving address; store keeps the message as unrouted.'),
  dns: z.array(MxRecord).describe('Records to publish for receiving.'), mx: MxReportSchema.nullable(), lastError: z.string().nullable(),
  enabledAt: z.string().nullable(), checkedAt: z.string().nullable(), addressCount: z.number().int(),
  subdomains: z.object({ enabled: z.boolean().describe('Whether the receipt rule also matches every subdomain.'), count: z.number().int().describe('Receiving subdomains.'), dns: z.array(MxRecord).describe('The wildcard MX record subdomains need, published once.') }),
}).openapi('InboundDomain');
const InboundSubdomainSchema = z.object({
  id: z.string().describe('Subdomain ID (mdom_…).'), name: z.string().describe('Full host, e.g. acme.example.com.'), parentDomainId: z.string().describe(`${productName} domain ID of the parent.`), parentName: z.string(),
  status: z.enum(['active', 'disabled']), catchAll: InboundCatchAll, metadata: z.record(z.string(), z.unknown()),
  dns: z.array(MxRecord).describe('The parent’s wildcard MX record, which receives this subdomain.'), mx: MxReportSchema.nullable(), addressCount: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
}).openapi('InboundSubdomain');
const InboundHostSchema = z.object({
  id: z.string().describe('Host ID (mdom_…).'), domainId: z.string().describe(`${productName} domain ID.`), name: z.string().describe('The host: the domain itself or one of its subdomains.'),
  status: z.enum(['pending', 'active', 'mixed', 'lost', 'failed', 'removed']).describe(`pending: its MX record isn\u2019t seen yet. active: it receives. mixed: it receives, and another provider\u2019s MX record shares its mail (a backup MX, or one with a better priority while mail moves over). lost: its MX record disappeared; it keeps receiving for two hours. failed: receiving setup failed. removed: it no longer receives; its addresses and mail are kept, and adding it again restores it.`),
  catchAll: InboundCatchAll, dns: z.array(MxRecord).describe('The MX record to publish on this host.'), mx: MxReportSchema.nullable(), issue: receivingIssueSchema.nullable().describe('Hosted: what needs attention on this host, from its last DNS check.'),
  addressCount: z.number().int(), metadata: z.record(z.string(), z.unknown()), createdAt: z.string(), updatedAt: z.string(),
}).openapi('InboundHost');
const InboundAddressSchema = z.object({
  id: z.string(), key:RoutingKey.nullable(), address: z.string(), displayName: z.string().nullable(), domain: z.string(), aliases: z.array(z.string()), rules: z.array(z.string()),
  publicAddress: z.string().nullable().describe('Send-only address used as the default From. Null to send from the receiving address.'),
  metadata: z.record(z.string(), z.unknown()), origin: z.enum(['api', 'auto']), createdAt: z.string(), updatedAt: z.string(),
  expiresAt: z.string().datetime().nullable().describe('UTC lease expiry, or null for a permanent address. After expiry, new delivery and sending stop. History stays readable and the address remains reserved until an admin deletes it.'),
  stats: z.object({ threads: z.number().int(), unreadThreads: z.number().int(), lastMessageAt: z.string().nullable() }),
  sendLimits: z.object({ perHour: z.number().int(), perDay: z.number().int(), perRecipientPerHour: z.number().int(), perThreadPer10Minutes: z.number().int() }).describe('Outbound limits that guard against runaway agents and reply loops.'),
  requireDmarc: z.boolean().describe('When true, received mail without a DMARC pass for its From domain is stored with the unverified label and does not emit message.received.'),
  kind: z.enum(['address', 'inbox']).describe('inbox: an agent inbox; manage it with /v1/inboxes.'),
}).openapi('InboundAddress');
const InboundEventSchema = z.object({ id: z.string(), cursor: z.string(), type: z.enum(inboundEventTypes), createdAt: z.string(), threadId: z.string().nullable(), messageId: z.string().nullable(), data: SuppressionEventData,
  addressId: z.string().nullable().describe('Receiving address ID at the time of the event; null for workspace events.') }).openapi('InboundEvent');
const KeySchema = z.object({ id: z.string(), name: z.string(), prefix: z.string(), addressIds: z.array(z.string()).nullable(), permissions: z.array(z.enum(['read', 'send', 'modify','create'])), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('InboundKey');
const pageOf = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const IdParam = z.object({ id: z.string().min(1).max(120) });

// ---------- views ----------
/** The host a domain-level view shows: hosted, the domain's own row unless the owner removed it, then the first other
 * host still receiving; self-hosted, the domain's own row (its other hosts are subdomains below it). */
function primaryHost(multiTenant: boolean, rows: (typeof mailboxDomains.$inferSelect)[]) {
  const own = rows.find(row => row.parentId === null), live = (row: typeof mailboxDomains.$inferSelect) => !['disabled', 'disabling'].includes(row.status);
  return multiTenant ? (own && live(own) ? own : rows.find(live) ?? own) : own;
}
async function domainViews(c: Ctx, rows: (typeof domains.$inferSelect)[]) {
  if (!rows.length) return [];
  const all = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, access(c).workspaceId), inArray(mailboxDomains.domainId, rows.map(row => row.id)))).orderBy(sql`${mailboxDomains.parentId} IS NOT NULL`, asc(mailboxDomains.createdAt), asc(mailboxDomains.id));
  const shown = new Map(rows.map(row => [row.id, primaryHost(c.env.config.multiTenant, all.filter(item => item.domainId === row.id))]));
  const ids = [...shown.values()].flatMap(state => state ? [state.id] : []);
  const counts = ids.length ? await c.env.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, ids)).groupBy(mailboxes.domainId) : [];
  const shared=c.env.config.regionalSending && rows.some(row=>row.region!=='us-east-2') && (await c.env.db.execute(sql`SELECT FROM provider_connections WHERE workspace_id=${access(c).workspaceId} AND kind='shared'`)).rowCount;
  // Hosted: the setup enableInboundDomain asked for, shown until the domain routes.
  const setups = c.env.config.multiTenant ? new Map((await c.env.db.execute<{ id: string; setup: ReceivingSetup | null }>(sql`SELECT d.id,${receivingSetup()} AS setup FROM operation_domains d
    JOIN domain_claims dc ON dc.workspace_id=d.workspace_id AND dc.name=d.name WHERE d.workspace_id=${access(c).workspaceId} AND d.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(rows.map(row => row.id))}::jsonb))`)).rows.map(r => [r.id, r.setup])) : null;
  return rows.map(row => {
    const primary = shown.get(row.id), own = all.find(item => item.domainId === row.id && item.parentId === null);
    // Until its own host routes (or waits for a BYO receipt rule), a domain whose setup was asked for shows that setup.
    const setup = !primary || (primary.parentId === null && primary.status === 'waiting_for_mx') ? setups?.get(row.id) : null;
    const state = primary && setup ? { ...primary, status: setup.status, lastError: setup.status === 'failed' ? setupError(setup) : null } : primary;
    const host=state?.receivingHost ?? state?.name ?? row.name;
    const region=state?.region ?? (shared?'us-east-2':row.region);
    // The domain's other hosts: subdomains self-hosted, any host hosted.
    const others = all.filter(item => item.domainId === row.id && item.id !== state?.id && (c.env.config.multiTenant || item.parentId === own?.id) && !['disabled', 'disabling'].includes(item.status)).length;
    return { id: row.id, name: host, region, status: state?.status ?? setup?.status ?? 'off' as const, dns: [expectedMx(host, region)], mx: state?.mx ?? null, lastError: state?.lastError ?? (setup?.status === 'failed' ? setupError(setup) : null),
      enabledAt: iso(state?.enabledAt), checkedAt: iso(state?.checkedAt), catchAll: state?.catchAll ?? 'store' as const, addressCount: counts.find(item => item.domainId === state?.id)?.count ?? 0,
      subdomains: { enabled: own?.acceptSubdomains ?? false, count: others, dns: [expectedMx(`*.${row.name}`, region)] } };
  });
}
async function operationDomain(c: Ctx, domainId: string) {
  const [row] = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, access(c).workspaceId), eq(domains.id, domainId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Domain was not found.');
  return row;
}
/** A host below the domain's own row, as the subdomain operations show it: active until it is removed. */
async function subdomainViews(runtime: Runtime, domain: typeof domains.$inferSelect, parent: typeof mailboxDomains.$inferSelect, rows: (typeof mailboxDomains.$inferSelect)[]) {
  const counts = rows.length ? await runtime.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, rows.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  return rows.map(row => ({ id: row.id, name: row.receivingHost ?? row.name, parentDomainId: domain.id, parentName: domain.name, status: ['disabled', 'disabling'].includes(row.status) ? 'disabled' as const : 'active' as const, metadata: row.metadata,
    dns: [expectedMx(row.receivingHost ?? row.name, parent.region)], mx: row.mx ?? null, catchAll: row.catchAll, addressCount: counts.find(item => item.domainId === row.id)?.count ?? 0, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! }));
}
/** A Nightmail domain and its own receiving row, which its other hosts hang off. Self-hosted, that row must be receiving. */
async function receivingParent(c: Ctx, domainId: string) {
  const domain = await operationDomain(c, domainId);
  const [parent] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, domain.workspaceId), eq(mailboxDomains.domainId, domain.id), isNull(mailboxDomains.parentId)));
  if (!parent || (!c.env.config.multiTenant && !['provisioning', 'waiting_for_mx', 'active'].includes(parent.status))) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Enable receiving for ${domain.name} before adding subdomains.`);
  return { domain, parent };
}
async function subdomainRow(c: Ctx, parent: typeof mailboxDomains.$inferSelect, subdomainId: string) {
  const [row] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), eq(mailboxDomains.id, subdomainId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Subdomain was not found.');
  return row;
}
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const Metadata = z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 4096, 'Metadata must be at most 4 KB.');
type MailboxRow = typeof mailboxes.$inferSelect;
type MailboxStat = { threads: number; unread: number; last: string | null };
/** One address as the API shows it, from its row, its address rows (aliases, public) and its thread stats. No I/O. */
export function mailboxView(row: MailboxRow, addresses: { address: string; kind: string }[], stat?: MailboxStat) {
  return { id: row.id,key:row.key, address: row.address, displayName: row.displayName, domain: row.address.split('@')[1]!,
    publicAddress: addresses.find(item => item.kind === 'public')?.address ?? null,
    aliases: addresses.filter(item => item.kind === 'alias').map(item => item.address).sort(), rules: row.rules, metadata: row.metadata, origin: row.origin,
    createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!, expiresAt: iso(row.expiresAt), stats: { threads: stat?.threads ?? 0, unreadThreads: stat?.unread ?? 0, lastMessageAt: iso(stat?.last) }, sendLimits: sendLimitsFor(row), requireDmarc: row.requireDmarc, kind: row.kind };
}
async function mailboxViews(runtime: Runtime, rows: MailboxRow[]) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const [addresses, stats] = await Promise.all([
    runtime.db.select().from(mailboxAddresses).where(inArray(mailboxAddresses.mailboxId, ids)),
    runtime.db.select({ mailboxId: mailboxThreads.mailboxId, threads: sql<number>`count(*)::int`, unread: sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)::int`, last: sql<string | null>`max(${mailboxThreads.lastMessageAt})::text` })
      .from(mailboxThreads).where(and(inArray(mailboxThreads.mailboxId, ids), isNull(mailboxThreads.trashedAt))).groupBy(mailboxThreads.mailboxId),
  ]);
  return rows.map(row => mailboxView(row, addresses.filter(item => item.mailboxId === row.id), stats.find(item => item.mailboxId === row.id)));
}
type MessageRow = typeof mailMessages.$inferSelect;
const keyView = (row: typeof mailboxKeys.$inferSelect) => ({ id: row.id, name: row.name, prefix: row.prefix, addressIds: row.mailboxIds, permissions: row.permissions, createdAt: iso(row.createdAt)!, lastUsedAt: iso(row.lastUsedAt), revokedAt: iso(row.revokedAt) });

const UpdateInboundThread = z.object({
  addressId: InboundAddressId.optional(),
  read: z.boolean().optional(), archived: z.boolean().optional(), starred: z.boolean().optional(), trashed: z.boolean().optional(), spam: z.boolean().optional(),
  addLabels: z.array(labelName).max(20).optional(), removeLabels: z.array(labelName).max(20).optional(),
}).strict().refine(v => Object.entries(v).some(([key,value]) => key !== 'addressId' && value !== undefined), 'Change at least one state field.').openapi('UpdateInboundThread');
type ThreadPatchInput = Omit<z.infer<typeof UpdateInboundThread>, 'addressId'>;
async function patchThread(c: Ctx, mailboxId: string, threadId: string, patch: ThreadPatchInput) {
  const { scope } = await mailboxFor(c, mailboxId, 'modify');
  // Every address is an inbox: one writer keeps its folders, flags and thread summary in step.
  const runnable = await c.env.db.transaction(async tx => {
    if(!((await tx.execute<{ok:boolean}>(sql`SELECT inbox_patch_thread(${scope.workspaceId},${mailboxId},${threadId},${JSON.stringify(patch)}::jsonb) ok`)).rows[0]?.ok))throw new ApiError(404,'NOT_FOUND','Thread was not found in this inbox.');
    return recordEvents(tx,scope.workspaceId,[{type:'thread.updated',mailboxId,threadId,data:{changes:patch}}]);
  });
  if (runnable) try { await c.env.wake?.(runnable,'webhook'); } catch { /* Webhook jobs are durable. */ }
  const [updated] = await c.env.db.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, threadId)));
  return AddressState.parse({...updated,addressId:mailboxId,trashed:!!updated?.trashedAt});
}

/** Links earlier stored mail for newly claimed addresses and rules to a mailbox. */
async function claimUnrouted(tx: Parameters<Parameters<Runtime['db']['transaction']>[0]>[0], scope: Scope, mailbox: typeof mailboxes.$inferSelect, addresses: string[], rules: string[]) {
  if (mailbox.expiresAt !== null) return 0; // A new lease starts with an empty mailbox, including on address reuse.
  const domain = mailbox.address.split('@')[1]!;
  // Neither a retained lease nor a send-only address (including plus-tags) grants historical delivery.
  const outsideReservation = sql`NOT EXISTS (SELECT 1 FROM mailbox_addresses a JOIN mailboxes m ON m.id = a.mailbox_id
    WHERE a.workspace_id = ${mailUnrouted.workspaceId} AND (m.expires_at IS NOT NULL OR a.kind = 'public')
    AND a.address IN (${mailUnrouted.address}, regexp_replace(${mailUnrouted.address}, '[+][^@]*@', '@')))`;
  const rows = await tx.select().from(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), outsideReservation, or(inArray(mailUnrouted.address, addresses), rules.length ? sql`${mailUnrouted.address} LIKE ${`%@${domain}`} OR ${mailUnrouted.address} LIKE ${`%.${domain}`}` : sql`false`))).limit(2000);
  const claimed = rows.filter(row => addresses.includes(row.address) || rules.some(rule => ruleMatches(rule, row.address)) || addresses.some(address => { const [local, host] = row.address.split('@'); return local?.includes('+') && `${local.split('+')[0]}@${host}` === address; }));
  if (!claimed.length) return 0;
  const messageIds = [...new Set(claimed.map(row => row.messageId))];
  const messages = await tx.select().from(mailMessages).where(inArray(mailMessages.id, messageIds)).orderBy(asc(mailMessages.receivedAt));
  for (const message of messages) await attachToMailboxes(tx, scope, message, [mailbox.id]);
  for (const row of claimed) await tx.delete(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), eq(mailUnrouted.address, row.address), eq(mailUnrouted.messageId, row.messageId)));
  return messages.length;
}

function registerReceivingDomains(app: App) {
  const base = '/v1/inbound/domains';
  const meta = { security, tags: ['Inbound domains'] };
  // ---------- domains ----------
  app.openapi(createRoute({ ...meta, method: 'get', path: base, operationId: 'listInboundDomains', summary: 'List domains and their receiving status', responses: { 200: response(z.object({ data: z.array(InboundDomainSchema) }).openapi('InboundDomainList')), ...errors } }), async c => {
    const value = admin(c);
    c.env = await withRegionSettings(c.env, value.workspaceId);
    const rows = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, value.workspaceId), inArray(domains.region, c.env.config.regions))).orderBy(asc(domains.name));
    return c.json({ data: await domainViews(c, rows) }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${base}/{id}`, operationId: 'getInboundDomain', request: { params: IdParam }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    return c.json((await domainViews(c, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/check`, operationId: 'checkInboundDomain', summary: 'Check MX records now', description: 'Reads public DNS and reports who currently receives mail for the domain. Updates the receiving status when inbound is enabled. Never changes DNS or AWS.', request: { params: IdParam }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    if (c.env.config.multiTenant) { const [view]=await domainViews(c,[row]);return c.json({...view!,mx:await checkMx(view!.name,view!.region)},200); }
    const mx = await checkMx(row.name, row.region);
    await saveMailboxMx(c.env.db,row.workspaceId,row.id,mx);
    const [view] = await domainViews(c, [row]);
    return c.json({ ...view!, mx }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/enable`, operationId: 'enableInboundDomain', summary: 'Enable receiving for a verified domain',
    description: `Checks that the domain is verified in SES and that its MX records will not take mail from another provider, then queues setup: a ${productName} S3 bucket, SNS topic and a catch-all SES receipt rule for the domain. Publish the returned MX record to start receiving. Use force=true to take over a domain whose mail another provider receives today. Hosted, receiving follows verified DNS: this queues the domain\u2019s check now, and the domain reads provisioning until that check routes it (active), finds no MX yet (waiting_for_mx) or fails (failed, with lastError).`,
    request: { params: IdParam, body: json(z.object({ catchAll: InboundCatchAll.optional(), force: z.boolean().default(false) }).strict().openapi('EnableInboundDomain')) }, responses: { 202: response(InboundDomainSchema), ...errors } }), async c => {
    const value = hostAdmin(c); const row = await operationDomain(c, c.req.valid('param').id); const input = c.req.valid('json');
    c.env = await withRegionSettings(c.env, value.workspaceId);
    if (c.env.config.multiTenant) { await enableHosted(c, row); return c.json((await domainViews(c,[row]))[0]!,202); }
    if (!c.env.config.regions.includes(row.region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'Enable the domain’s SES region first.');
    const { GetEmailIdentityCommand } = await loadMailboxSesv2();
    const identity = await (await getSes(c.env, row.region)).send(new GetEmailIdentityCommand({ EmailIdentity: row.name })).catch((error: unknown) => {
      if (error instanceof ModuleLoadError) throw error;
      throw new ApiError(503, 'SES_UNAVAILABLE', 'Could not read the domain’s SES verification status.', undefined, true);
    });
    if (identity.VerificationStatus !== 'SUCCESS') throw new ApiError(409, 'DOMAIN_NOT_VERIFIED', 'Verify the domain in SES before enabling mailboxes.');
    const mx = await checkMx(row.name, row.region);
    if (mx.state === 'error' && !input.force) throw new ApiError(503, 'MX_LOOKUP_FAILED', 'Could not verify the current MX records. Retry before enabling receiving.', undefined, true);
    if (mxBlocksEnable(mx) && !input.force) throw new ApiError(409, 'MX_CONFLICT', `${mx.message} Retry with force=true to continue anyway.`);
    await c.env.db.transaction(async tx => {
      const [current] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId))).for('update');
      const now = new Date().toISOString();
      if (!current) await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: value.workspaceId, domainId: row.id, name: row.name, region: row.region, status: 'provisioning', catchAll: input.catchAll, mx, checkedAt: mx.checkedAt });
      else await tx.update(mailboxDomains).set({ ...(['disabled', 'disabling', 'failed'].includes(current.status) ? { status: 'provisioning' as const, lastError: null } : {}), catchAll: input.catchAll, mx, checkedAt: mx.checkedAt, updatedAt: now }).where(eq(mailboxDomains.id, current.id));
      await queueReconcile(tx, value.workspaceId, row.region);
      await recordAudit(tx, c, { action: 'inbound_domain.enable', workspaceId: value.workspaceId, target: { type: 'domain', id: row.id }, before: current ? { status: current.status } : undefined, after: { name: row.name, catchAll: input.catchAll, force: input.force, mx: mx.state } });
    });
    log('info', { code: 'MAILBOX_DOMAIN_ENABLE_QUEUED', region: row.region, mx: mx.state });
    return c.json((await domainViews(c, [row]))[0]!, 202);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/disable`, operationId: 'disableInboundDomain', summary: 'Stop receiving for a domain', description: `Removes the domain from the ${productName} receipt rule. Receiving addresses and stored messages are kept.`, request: { params: IdParam }, responses: { 202: response(InboundDomainSchema), ...errors } }), async c => {
    const value = hostAdmin(c); const row = await operationDomain(c, c.req.valid('param').id);
    if (c.env.config.multiTenant) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Receiving follows verified DNS. Remove the MX record to stop delivery.');
    await c.env.db.transaction(async tx => {
      const updated = await tx.update(mailboxDomains).set({ status: 'disabling', updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['provisioning', 'waiting_for_mx', 'active', 'failed']))).returning({ id: mailboxDomains.id });
      if (updated.length) {
        await queueReconcile(tx, value.workspaceId, row.region);
        await recordAudit(tx, c, { action: 'inbound_domain.disable', workspaceId: value.workspaceId, target: { type: 'domain', id: row.id }, before: { name: row.name } });
      }
    });
    return c.json((await domainViews(c, [row]))[0]!, 202);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${base}/{id}`, operationId: 'updateInboundDomain',
    request: { params: IdParam, body: json(z.object({ catchAll: InboundCatchAll.optional(), acceptSubdomains: z.boolean().optional().describe('Whether the receipt rule also matches every subdomain (.example.com). Turned on by the first subdomain and kept on after that.') }).strict().refine(value => value.catchAll !== undefined || value.acceptSubdomains !== undefined, 'Set catchAll or acceptSubdomains.').openapi('UpdateInboundDomain')) }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    const value = hostAdmin(c); const row = await operationDomain(c, c.req.valid('param').id); const input = c.req.valid('json');
    if (c.env.config.multiTenant && input.acceptSubdomains!==undefined) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Receiving follows the exact verified MX hostname.');
    const updated = await c.env.db.transaction(async tx => {
      // The host the domain's view shows (its own row unless that host was removed).
      const before = primaryHost(c.env.config.multiTenant, await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id)))
        .orderBy(sql`${mailboxDomains.parentId} IS NOT NULL`, asc(mailboxDomains.createdAt), asc(mailboxDomains.id)).for('update'));
      if (!before) return [];
      const saved = await tx.update(mailboxDomains).set({ catchAll: input.catchAll, ...(input.acceptSubdomains !== undefined ? { acceptSubdomains: input.acceptSubdomains } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, before.id)).returning({ id: mailboxDomains.id });
      if (input.acceptSubdomains !== undefined && input.acceptSubdomains !== before.acceptSubdomains) await queueReconcile(tx, value.workspaceId, before.region);
      await recordAudit(tx, c, { action: 'inbound_domain.update', workspaceId: value.workspaceId, target: { type: 'domain', id: row.id }, details: { fields: Object.keys(input) },
        before: { catchAll: input.catchAll !== undefined ? before.catchAll : undefined, acceptSubdomains: input.acceptSubdomains !== undefined ? before.acceptSubdomains : undefined }, after: input });
      return saved;
    });
    if (!updated.length) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', 'Enable receiving for this domain first.');
    return c.json((await domainViews(c, [row]))[0]!, 200);
  });

  // ---------- hosts ----------
  // One model: a domain receives on a set of hosts (receiving-hosts.ts). The subdomain operations below are the hosts
  // other than the domain's own row.
  const hosts = `${base}/{id}/hosts`;
  const HostParams = z.object({ id: z.string().min(1).max(120), hostId: z.string().min(1).max(120) });
  const HostInput = z.object({ catchAll: InboundCatchAll.optional().describe('For an unknown recipient, store keeps the message as unrouted (default); create_address creates a receiving address.'), metadata: Metadata.optional() });
  app.openapi(createRoute({ ...meta, method: 'get', path: hosts, operationId: 'listReceivingHosts', summary: 'List receiving hosts',
    description: 'Every host the domain receives on: the domain itself and any of its subdomains, at once, the domain’s own host first. Each has its own status, MX record, catch-all and addresses. Removed hosts are listed with status removed.',
    request: { params: IdParam }, responses: { 200: response(z.object({ data: z.array(InboundHostSchema) }).openapi('InboundHostList')), ...errors } }), async c => {
    admin(c); return c.json({ data: await listHosts(c, await operationDomain(c, c.req.valid('param').id)) }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: hosts, operationId: 'addReceivingHost', summary: 'Add a receiving host',
    description: `Receives mail on another host of the domain, beside every host it already receives on: the domain itself or any of its subdomains. Publish the returned MX record on it; the host receives as soon as the record is seen, also while another provider\u2019s MX stays published beside it. Hosted: public DNS is checked first. A CNAME, one of ${productName}\u2019s own names (custom MAIL FROM, ownership TXT, DKIM), a host another domain receives on (in any workspace), a name another workspace has claimed or a delegated zone is refused; a host whose mail another provider receives needs confirm: true, because publishing ${productName}\u2019s MX there moves that mail. Self-hosted: a subdomain shares the domain\u2019s receipt rule. Adding a removed host again restores it with its addresses; adding a host the domain already receives on returns it.`,
    request: { params: IdParam, body: json(HostInput.extend({ name: z.string().trim().toLowerCase().min(1).max(253).describe('The host: the domain itself, a label (acme) or a subdomain (acme.example.com).'), confirm: z.boolean().default(false) }).strict().openapi('AddReceivingHost')) },
    responses: { 200: response(InboundHostSchema), 201: response(InboundHostSchema), ...errors } }), async c => {
    hostAdmin(c); const input = c.req.valid('json');
    const { view, created } = await addHost(c, await operationDomain(c, c.req.valid('param').id), input);
    return created ? c.json(view, 201) : c.json(view, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${hosts}/{hostId}`, operationId: 'updateReceivingHost', summary: 'Change a receiving host',
    request: { params: HostParams, body: json(HostInput.strict().refine(value => value.catchAll !== undefined || value.metadata !== undefined, 'Set catchAll or metadata.').openapi('UpdateReceivingHost')) }, responses: { 200: response(InboundHostSchema), ...errors } }), async c => {
    hostAdmin(c); const params = c.req.valid('param');
    return c.json(await updateHost(c, await operationDomain(c, params.id), params.hostId, c.req.valid('json')), 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: `${hosts}/{hostId}`, operationId: 'removeReceivingHost', summary: 'Stop receiving on a host',
    description: 'Mail to the host is no longer accepted; every other host keeps receiving. Its addresses and stored messages are kept, and adding the host again restores it. Remove its MX record when you no longer need it. Self-hosted, removing the domain\u2019s own host turns receiving off for the domain, as disableInboundDomain does.',
    request: { params: HostParams }, responses: { 200: response(InboundHostSchema), ...errors } }), async c => {
    hostAdmin(c); const params = c.req.valid('param');
    return c.json(await removeHost(c, await operationDomain(c, params.id), params.hostId), 200);
  });

  // ---------- subdomains ----------
  const SubParams = z.object({ id: z.string().min(1).max(120), subdomainId: z.string().min(1).max(120) });
  const subdomains = `${base}/{id}/subdomains`;
  const removedStatus = sql`${mailboxDomains.status} IN ('disabled','disabling')`;
  app.openapi(createRoute({ ...meta, method: 'get', path: subdomains, operationId: 'listInboundSubdomains', summary: 'List receiving subdomains',
    description: `The domain\u2019s receiving hosts other than its own (GET ${hosts} lists them all).`,
    request: { params: IdParam, query: z.object({ status: z.enum(['active', 'disabled', 'all']).default('active'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(InboundSubdomainSchema, 'InboundSubdomainPage')), ...errors } }), async c => {
    admin(c); const { domain, parent } = await receivingParent(c, c.req.valid('param').id); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), q.status === 'all' ? undefined : q.status === 'active' ? sql`NOT ${removedStatus}` : removedStatus, q.cursor ? sql`${mailboxDomains.name} > ${q.cursor}` : undefined)).orderBy(asc(mailboxDomains.name)).limit(q.limit + 1);
    return c.json({ data: await subdomainViews(c.env, domain, parent, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.name : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: subdomains, operationId: 'createInboundSubdomain', summary: 'Add a receiving subdomain',
    description: `Adds name.example.com as a receiving host beside the domain\u2019s others (POST ${hosts} with a label does the same). Publish the returned MX record on it. Hosted, the same DNS checks as for any host apply. Self-hosted, it needs no SES verification of its own: the first subdomain adds the wildcard recipient (.example.com) to the receipt rule, which takes up to a minute, and later ones are live immediately; a *.example.com MX record (the domain\u2019s subdomains.dns) also works instead of one record per subdomain. Receiving addresses can then be created on the subdomain. Re-adding a removed subdomain restores it.`,
    request: { params: IdParam, body: json(z.object({ name: z.string().trim().toLowerCase().max(253).describe('A label (acme) or the full host (acme.example.com).'), catchAll: InboundCatchAll.default('store').describe('For an unknown recipient, store keeps the message as unrouted (default); create_address creates a receiving address.'), metadata: Metadata.default({}), confirm: z.boolean().default(false).describe('Hosted: choose the host even though another provider receives its mail today.') }).strict().openapi('CreateInboundSubdomain')) },
    responses: { 201: response(InboundSubdomainSchema), ...errors } }), async c => {
    hostAdmin(c); const { domain, parent } = await receivingParent(c, c.req.valid('param').id); const input = c.req.valid('json');
    const label = input.name.endsWith(`.${domain.name}`) ? input.name.slice(0, -(domain.name.length + 1)) : input.name;
    if (!LABEL.test(label)) throw new ApiError(422, 'INVALID_SUBDOMAIN', `Use one DNS label of letters, digits and hyphens, e.g. acme for acme.${domain.name}.`, 'name');
    const { view, created } = await addHost(c, domain, { name: `${label}.${domain.name}`, catchAll: input.catchAll, metadata: input.metadata, confirm: input.confirm, beside: true });
    if (!created) throw new ApiError(409, 'SUBDOMAIN_EXISTS', `${view.name} already receives mail.`, 'name');
    log('info', { code: 'MAILBOX_SUBDOMAIN_ADDED', region: parent.region, mx: view.mx?.state ?? 'unknown' });
    return c.json((await subdomainViews(c.env, domain, parent, [await subdomainRow(c, parent, view.id)]))[0]!, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${subdomains}/{subdomainId}`, operationId: 'getInboundSubdomain', request: { params: SubParams }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const { domain, parent } = await receivingParent(c, params.id);
    return c.json((await subdomainViews(c.env, domain, parent, [await subdomainRow(c, parent, params.subdomainId)]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${subdomains}/{subdomainId}`, operationId: 'updateInboundSubdomain',
    request: { params: SubParams, body: json(z.object({ catchAll: InboundCatchAll.optional(), metadata: Metadata.optional() }).strict().openapi('UpdateInboundSubdomain')) }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    hostAdmin(c); const params = c.req.valid('param'); const { domain, parent } = await receivingParent(c, params.id); const input = c.req.valid('json');
    const current = await subdomainRow(c, parent, params.subdomainId);
    await updateHost(c, domain, current.id, input);
    return c.json((await subdomainViews(c.env, domain, parent, [await subdomainRow(c, parent, current.id)]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: `${subdomains}/{subdomainId}`, operationId: 'removeInboundSubdomain', summary: 'Stop receiving for a subdomain',
    description: `The same as DELETE ${hosts}/{hostId}: mail to the subdomain is no longer accepted, its receiving addresses and stored messages are kept, and adding the subdomain again restores it. Self-hosted, the domain keeps its wildcard recipient, so adding subdomains later is instant; turn it off with PATCH ${base}/{id} acceptSubdomains=false.`, request: { params: SubParams }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    hostAdmin(c); const params = c.req.valid('param'); const { domain, parent } = await receivingParent(c, params.id);
    const current = await subdomainRow(c, parent, params.subdomainId);
    await removeHost(c, domain, current.id);
    return c.json((await subdomainViews(c.env, domain, parent, [await subdomainRow(c, parent, current.id)]))[0]!, 200);
  });
}

const EmailAddressInput = z.string().trim().toLowerCase().max(254).regex(ADDRESS, 'Use a valid email address.');
/** An address route: a deprecated alias over the inbox model, kept until the domain cutover (brand.ts). */
const addressAlias = (operationId: typeof legacyAddressOperations[number]) => ({ operationId, deprecated: true });
function registerAddresses(app: App) {
  const collection = '/v1/inbound/addresses', detail = `${collection}/{addressId}`;
  const params = z.object({ addressId: InboundAddressId });
  const meta = { tags: ['Inbound addresses'], security };
  const MailboxInput = z.object({
    key:RoutingKey.nullable().optional(),address: EmailAddressInput, displayName: z.string().trim().max(200).nullable().optional(),
    publicAddress: EmailAddressInput.optional().describe('Permanent addresses only: immutable default From with the same local part on a strict ancestor domain verified for sending with DKIM in the receiving region. Does not change routing or MX.'),
    ttlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional().describe('Lease duration in seconds, 60–2592000 (30 days). Omit for a permanent address. Temporary addresses accept plus-tags, not aliases, wildcard rules or historical backfill. Expiry is fixed at creation.'),
    aliases: z.array(z.string().trim().toLowerCase().max(254).regex(ADDRESS)).max(50).default([]), rules: z.array(z.string().max(254)).max(20).default([]).describe('Wildcard address patterns, e.g. support+*@acme.com or *@help.acme.com.'),
    metadata: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, 'Metadata must be at most 16 KB.').default({}),
    sendLimits: z.object({ perHour: z.number().int().min(0).max(10000), perDay: z.number().int().min(0).max(100000), perRecipientPerHour: z.number().int().min(0).max(1000), perThreadPer10Minutes: z.number().int().min(0).max(1000) }).partial().strict().optional()
      .describe(`Override outbound limits. Defaults: ${Object.entries(DEFAULT_SEND_LIMITS).map(([key, value]) => `${key} ${value}`).join(', ')}. 0 blocks sending.`),
    requireDmarc: z.boolean().default(false).describe('Hold received mail without a DMARC pass for its From domain: it is stored with the unverified label and does not emit message.received.'),
  }).strict().openapi('CreateInboundAddress');
  app.openapi(createRoute({ ...meta, method: 'get', path: collection, ...addressAlias('listInboundAddresses'), summary: 'List receivable addresses', description: 'An address key sees only addresses it can access.',
    request: { query: z.object({ domain: z.string().max(253).optional(), origin: z.enum(['api', 'auto']).optional(), kind: z.enum(['address', 'inbox']).optional().describe('address: receiving addresses only; inbox: agent inboxes only. Default: both.'), q: z.string().max(200).optional(), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(InboundAddressSchema, 'InboundAddressPage')), ...errors } }), async c => {
    const value = access(c, 'read'); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), value.mailboxIds ? inArray(mailboxes.id, value.mailboxIds.length ? value.mailboxIds : ['']) : undefined,
      q.domain ? sql`split_part(${mailboxes.address}, '@', 2) = ${q.domain.toLowerCase()}` : undefined, q.origin ? eq(mailboxes.origin, q.origin) : undefined, q.kind ? eq(mailboxes.kind, q.kind) : undefined,
      q.q ? or(sql`${mailboxes.address} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`, sql`${mailboxes.displayName} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`) : undefined,
      q.cursor ? lt(mailboxes.id, q.cursor) : undefined)).orderBy(desc(mailboxes.id)).limit(q.limit + 1);
    return c.json({ data: await mailboxViews(c.env, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: collection, ...addressAlias('createInboundAddress'), summary: 'Create a receivable address', description: 'Admin only. The domain must be verified for this workspace; mail arrives once its receiving MX record is active. Permanent addresses claim earlier unrouted mail for their address or rules; temporary addresses start empty. Expiry stops new delivery and sending without deleting history.', request: { body: json(MailboxInput) }, responses: { 201: response(InboundAddressSchema), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json'); const scope = scopeOf(value);
    const host = input.address.split('@')[1]!;
    // On MX, proven ownership of the claim is enough: routing follows the MX observation later.
    // A domain may receive on several hosts: the address goes to the row of its own host. A removed host takes no new addresses.
    const [domain] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(c.env.config.multiTenant?mailboxDomains.receivingHost:mailboxDomains.name,host), c.env.config.multiTenant ? sql`EXISTS (SELECT 1 FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND ${connectionReady()} JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name WHERE d.id=${mailboxDomains.domainId} AND dc.workspace_id=${value.workspaceId} AND (${claimSends()} OR ${claimReceivable()}) AND (d.region=pc.region OR (pc.kind='shared' AND ${mailboxDomains.region}='us-east-2' AND ${mailboxDomains.status}='active' AND ${claimReceives()})))` : undefined)).orderBy(sql`${mailboxDomains.status} IN ('disabled','disabling')`).limit(1);
    if (!domain) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Verify ${host}'s domain in this workspace before creating addresses on it.`, 'address');
    if (['disabled', 'disabling'].includes(domain.status)) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', c.env.config.multiTenant ? `${host} no longer receives mail. Add it back as a receiving host before creating addresses on it.` : `Verify ${host}'s domain in this workspace before creating addresses on it.`, 'address');
    const publicAddress = input.publicAddress;
    if (publicAddress) {
      if (input.ttlSeconds !== undefined) throw new ApiError(422, 'TEMPORARY_MAILBOX_ROUTING', 'Temporary mailboxes cannot have a public sender address.', 'publicAddress');
      const [local, publicHost] = publicAddress.split('@') as [string, string];
      if (local !== input.address.split('@')[0] || !host.endsWith(`.${publicHost}`)) throw new ApiError(422, 'PUBLIC_ADDRESS_MISMATCH', 'Use the same local part on a parent domain of the receiving address.', 'publicAddress');
      if (!c.env.config.multiTenant) {
      c.env = await withRegionSettings(c.env, value.workspaceId);
      const { GetEmailIdentityCommand } = await loadMailboxSesv2();
      const identity = await (await getSes(c.env, domain.region)).send(new GetEmailIdentityCommand({ EmailIdentity: publicHost })).catch((error: unknown) => {
        if (error instanceof ModuleLoadError) throw error;
        if (error instanceof Error && error.name === 'NotFoundException') throw new ApiError(409, 'PUBLIC_DOMAIN_NOT_VERIFIED', `Verify the exact SES domain identity ${publicHost} in ${domain.region}.`, 'publicAddress');
        throw new ApiError(503, 'SES_UNAVAILABLE', `Could not read the SES identity for ${publicHost} in ${domain.region}. Check GetEmailIdentity access.`, 'publicAddress', true);
      });
      if (identity.VerifiedForSendingStatus !== true) throw new ApiError(409, 'PUBLIC_DOMAIN_NOT_VERIFIED', `${publicHost} is not verified for sending in ${domain.region}.`, 'publicAddress');
      if (identity.DkimAttributes?.SigningEnabled !== true || identity.DkimAttributes.Status !== 'SUCCESS') throw new ApiError(409, 'PUBLIC_DOMAIN_DKIM_NOT_READY', `Enable and verify DKIM signing for ${publicHost} in ${domain.region}.`, 'publicAddress');
      }
    }
    const { row, runnable } = await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx,scope.workspaceId, 'address');
      if (publicAddress && c.env.config.multiTenant) {
        const host=publicAddress.split('@')[1]!;
        if (!(await tx.execute(sql`SELECT 1 FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
          WHERE dc.workspace_id=${scope.workspaceId} AND dc.name=${host} AND ${claimSends()} AND pc.region=${domain.region} AND ${connectionReady()} FOR SHARE OF dc,pc`)).rowCount) throw new ApiError(409,'PUBLIC_DOMAIN_NOT_VERIFIED','The public sender domain must be verified and ready in this workspace and region.','publicAddress');
      }
      const created = await createMailbox(tx, scope, { domainId: domain.id, domainName: host,key:input.key, address: input.address, displayName: input.displayName ?? null, aliases: input.aliases, rules: input.rules, metadata: input.metadata, origin: 'api', sendLimits: input.sendLimits, requireDmarc: input.requireDmarc, ttlSeconds: input.ttlSeconds });
      if (publicAddress) {
        const [claimed] = await tx.insert(mailboxAddresses).values({ ...scope, address: publicAddress, mailboxId: created.id, kind: 'public' }).onConflictDoNothing().returning({ address: mailboxAddresses.address });
        if (!claimed) throw new ApiError(409, 'ADDRESS_TAKEN', `${publicAddress} already belongs to a mailbox.`, 'publicAddress');
      }
      await claimUnrouted(tx, scope, created, [created.address, ...input.aliases], created.rules);
      // Temporary addresses are agent working state, created at a high rate: only permanent ones are audited.
      if (input.ttlSeconds === undefined) await recordAudit(tx, c, { action: 'address.create', workspaceId: scope.workspaceId, target: { type: 'address', id: created.id }, after: { address: created.address, key: input.key ?? null, publicAddress: publicAddress ?? null, aliases: input.aliases.length, rules: created.rules.length } });
      return { row: created, runnable: await recordEvents(tx, scope.workspaceId, [{ type: 'address.created', mailboxId: created.id, data: { origin: 'api', address: created.address } }]) };
    });
    if (runnable) try { await c.env.wake?.(runnable,'webhook'); } catch { /* durable */ }
    return c.json((await mailboxViews(c.env, [row]))[0]!, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: detail, ...addressAlias('getInboundAddress'), summary: 'Read a receivable address', request: { params }, responses: { 200: response(InboundAddressSchema), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').addressId);
    return c.json((await mailboxViews(c.env, [mailbox]))[0]!, 200);
  });
  const fields = MailboxInput.shape;
  const patch = z.object({key:fields.key, displayName: fields.displayName, aliases: fields.aliases.removeDefault().optional(), rules: fields.rules.removeDefault().optional(), metadata: fields.metadata.removeDefault().optional(), sendLimits: fields.sendLimits, requireDmarc: fields.requireDmarc.removeDefault().optional() }).strict().openapi('UpdateInboundAddress');
  app.openapi(createRoute({ ...meta, method: 'patch', path: detail, ...addressAlias('updateInboundAddress'), description: 'Admin only. Only supplied fields change. The address, public sender and expiry are immutable.',
    request: { params, body: json(patch) }, responses: { 200: response(InboundAddressSchema), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').addressId); const input = c.req.valid('json');
    if(mailbox.kind==='inbox')throw new ApiError(409,'MANAGED_INBOX','Use the inbox endpoint to edit a managed inbox.');
    if (mailbox.expiresAt !== null) checkTemporaryMailboxRouting(input);
    const domain = mailbox.address.split('@')[1]!;
    await c.env.db.transaction(async tx => {
      const rules = input.rules ? [...new Set(input.rules.map(rule => validateRule(rule, domain)))] : undefined;
      if(rules || input.aliases)await lockMailboxLane(tx,scope.workspaceId,'address');
      if(rules?.length)await checkRuleCapacity(tx,scope.workspaceId,mailbox.domainId,mailbox.id);
      const [updated] = await tx.update(mailboxes).set({key:input.key, ...(input.displayName !== undefined ? { displayName: input.displayName } : {}), ...(rules ? { rules } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.sendLimits ? { sendLimits: { ...mailbox.sendLimits, ...input.sendLimits } } : {}), ...(input.requireDmarc !== undefined ? { requireDmarc: input.requireDmarc } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxes.id, mailbox.id)).returning();
      let added: string[] = [];
      if (input.aliases) {
        const aliases = [...new Set(input.aliases)].filter(alias => alias !== mailbox.address);
        for (const alias of aliases) if (!alias.endsWith(`@${domain}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Aliases must end in @${domain}.`, 'aliases');
        const current = await tx.select().from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), eq(mailboxAddresses.kind, 'alias')));
        const removed = current.filter(row => !aliases.includes(row.address)).map(row => row.address);
        added = aliases.filter(alias => !current.some(row => row.address === alias));
        if (removed.length) await tx.delete(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), inArray(mailboxAddresses.address, removed)));
        if (added.length) {
          if((await tx.execute(sql`SELECT FROM mail_retired_addresses WHERE workspace_id=${scope.workspaceId} AND address=ANY(${sql.param(added)}::text[]) AND until>now() LIMIT 1`)).rowCount)throw new ApiError(409,'ADDRESS_RETIRED','Release the retired address before assigning it as an alias.');
          const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), inArray(mailboxAddresses.address, added)));
          if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'aliases');
          await tx.insert(mailboxAddresses).values(added.map(address => ({ ...scope, address, mailboxId: mailbox.id, kind: 'alias' as const })));
        }
      }
      if (added.length || rules?.length) await claimUnrouted(tx, scope, updated!, added, rules ?? []);
      if (mailbox.expiresAt === null) await recordAudit(tx, c, { action: 'address.update', workspaceId: scope.workspaceId, target: { type: 'address', id: mailbox.id }, details: { fields: Object.keys(input) }, after: { address: mailbox.address, key: input.key, requireDmarc: input.requireDmarc } });
    });
    const [row] = await c.env.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    return c.json((await mailboxViews(c.env, [row!]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: detail, ...addressAlias('deleteInboundAddress'), description: 'Admin only. Releases this address and removes its per-address state. Stored messages are kept; future mail follows normal routing. If a route delivers to this inbox, pass detach=true to remove it from those routes in the same change.', request: { params, query: z.object({ detach: z.enum(['true', 'false']).optional().describe('Also remove this inbox from every route that delivers to it, as one routing version.') }) }, responses: { 200: response(Ok), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').addressId);
    if(mailbox.kind==='inbox'){await endInbox(c.env.db,sql`b.workspace_id=${scope.workspaceId} AND b.id=${mailbox.id}`,auditContext(c));return c.json({ok:true as const},200);}
    const runnable = await c.env.db.transaction(async tx => {
      // inbox_end releases it (one delete path and lock order for every inbox). Lanes are taken ingest first, then address.
      await lockMailboxLane(tx, scope.workspaceId, 'ingest');
      await detachDestination(tx,c,scope.workspaceId,mailbox.id);
      await tx.execute(sql`SELECT inbox_end(${scope.workspaceId},${mailbox.id})`);
      if (mailbox.expiresAt === null) await recordAudit(tx, c, { action: 'address.delete', workspaceId: scope.workspaceId, target: { type: 'address', id: mailbox.id }, before: { address: mailbox.address, key: mailbox.key } });
      return recordEvents(tx, scope.workspaceId, [{ type: 'address.deleted', mailboxId: mailbox.id, data: { address: mailbox.address } }]);
    });
    if (runnable) try { await c.env.wake?.(runnable,'webhook'); } catch { /* durable */ }
    return c.json({ ok: true as const }, 200);
  });
}

import { endInbox, registerInboxes } from './inboxes.js';
import { registerMailObjects } from './mail-object-route.js';
import {registerMailGateway} from './mail-gateway.js';
export function registerMailbox(app: App) {
  registerRouting(app);
  registerRituals(app);
  // Agent inboxes use the same credentials and body bound as /v1/inbound; downloads are token-signed.
  // mailboxRoute and receivingConsentRoute (core.ts) are the rules the MCP listing applies too.
  app.use('/v1/*', (c, next) => mailboxRoute(c.req.path) ? mailboxAuth(c, next) : next());
  app.use('/v1/*', (c, next) => mailboxRoute(c.req.path) && receivingConsentRoute(c.req.path) ? requireReceivingConsent(c, next) : next());
  app.use('/v1/inbound/*', async (c, next) => { await boundRequestBody(c); await next(); });
  app.use('/v1/inboxes/*', async (c, next) => { await boundRequestBody(c); await next(); });
  app.use('/v1/inbound/*', mailboxCreates);
  app.use('/v1/inboxes/*', mailboxCreates);
  registerInboxes(app, access);
  registerMailObjects(app);
  registerMailGateway(app);
  app.openapi(createRoute({method:'delete',path:'/v1/inbound/retired/{address}',operationId:'releaseRetiredAddress',tags:['Inbound addresses'],security,summary:'Release a retired address for reuse (workspace admin)',request:{params:z.object({address:z.email().max(254)})},responses:{200:response(Ok),...errors}}),async c=>{
    const v=admin(c);await c.env.db.execute(sql`WITH released AS (DELETE FROM mail_retired_addresses WHERE workspace_id=${v.workspaceId} AND address=${c.req.valid('param').address.toLowerCase()} RETURNING address),
      audit AS (${auditInsert(auditContext(c),{action:'address.release',workspaceId:v.workspaceId,target:{type:'address',id:sql`released.address`},before:sql`jsonb_build_object('address',released.address)`},{from:sql`released`})}) SELECT 1`);return c.json({ok:true as const},200);
  });
  const policy=z.object({spam:z.enum(['store','quarantine'])}).strict().openapi('InboundScanPolicy');
  app.openapi(createRoute({method:'get',path:'/v1/inbound/policy',operationId:'getInboundScanPolicy',tags:['Inbound domains'],security,responses:{200:response(policy),...errors}}),async c=>{const {workspaceId}=admin(c);const {rows}=await c.env.db.execute<{spam:'store'|'quarantine'}>(sql`SELECT spam_policy AS spam FROM mail_receive_limits WHERE workspace_id=${workspaceId}`);return c.json({spam:rows[0]?.spam??'store'},200);});
  app.openapi(createRoute({method:'patch',path:'/v1/inbound/policy',operationId:'updateInboundScanPolicy',tags:['Inbound domains'],security,description:'Non-PASS virus scans are always quarantined. Store non-PASS spam scans without normal receipt notifications, or quarantine them privately.',request:{body:json(policy)},responses:{200:response(policy),...errors}}),async c=>{const {workspaceId}=admin(c),{spam}=c.req.valid('json');await c.env.db.execute(sql`WITH old AS (SELECT spam_policy FROM mail_receive_limits WHERE workspace_id=${workspaceId}),
    changed AS (INSERT INTO mail_receive_limits(workspace_id,spam_policy) VALUES(${workspaceId},${spam}) ON CONFLICT(workspace_id) DO UPDATE SET spam_policy=excluded.spam_policy RETURNING workspace_id),
    audit AS (${auditInsert(auditContext(c),{action:'settings.inbound_policy',workspaceId,target:{type:'workspace',id:workspaceId},before:sql`jsonb_build_object('spam',(SELECT spam_policy FROM old))`,after:{spam}},{from:sql`changed`})}) SELECT 1`);return c.json({spam},200);});
  // These routes call the same region-checked send admission as /v1/emails/send.
  app.on('POST', ['/v1/inbound/threads', '/v1/inbound/threads/:threadId/reply'], async (c, next) => {
    c.env = await withRegionSettings(c.env, access(c).workspaceId);
    await next();
  });
  registerReceivingDomains(app);
  registerAddresses(app);
  const Address = EmailAddressInput;

  // ---------- sending ----------
  const Recipients = z.array(Address).max(50);
  const AttachmentItem = z.union([
    z.object({ filename: AttachmentFilename, content: z.string().min(4).max(MAX_ATTACHMENT_BASE64).describe('Base64; line breaks are accepted.'), contentType: AttachmentContentType.optional(), disposition: AttachmentDisposition.optional(), contentId: AttachmentContentId.optional() }).strict(),
    z.object({ id: z.string().min(1).max(120).describe(`A received attachment in this mailbox (matt_…) or a ${productName} attachment upload (attachment_…).`) }).strict(),
  ]).openapi('InboundAttachmentInput');
  const Compose = {
    from: Address.optional().describe(`Defaults to the public address if configured, otherwise the primary receiving address. Address keys may use only addresses owned by this mailbox. Administrators may use any address on a domain registered in ${productName} for the receiving region; replies still return to whatever address the recipient answers.`),
    text: z.string().min(1).max(524288).optional(), html: z.string().min(1).max(524288).optional(),
    attachments: z.array(AttachmentItem).max(20).default([]).describe('Up to 20 files, 8 MiB combined. Any type Amazon SES delivers (executables and scripts are refused).'),
    replyTo: Recipients.max(10).default([]),
    headers: CustomHeaders.default([]),
    autoSubmitted: z.enum(['auto-generated', 'auto-replied']).optional().describe('Adds an RFC 3834 Auto-Submitted header so other automated systems do not reply to this message.'),
  };
  const needsBody = (value: { text?: string; html?: string }) => !!value.text || !!value.html;
  const CreateInbound = z.object({ ...Compose, addressId: InboundAddressId, to: Recipients.min(1), cc: Recipients.default([]), bcc: Recipients.default([]), subject: z.string().trim().min(1).max(998).refine(value => !/[\r\n]/.test(value), 'Subject cannot contain line breaks.') })
    .strict().refine(needsBody, 'Provide text or html.').openapi('CreateInboundThread');
  const ReplyInbound = z.object({ ...Compose, addressId: InboundAddressId.optional(),
    replyToMessageId: z.string().min(1).max(120).optional().describe(`${productName} message ID (msg_…) of a visible message in this thread.`),
    expectedRecipients: z.object({ to: Recipients, cc: Recipients, bcc: Recipients }).strict().optional().describe('Check the final To, Cc and Bcc against these reviewed address sets; never overrides recipients. A mismatch returns 409 INBOUND_RECIPIENTS_CHANGED.'),
    replyAll: z.boolean().default(false).describe('Also copy everyone else on the original message.'),
    to: Recipients.optional().describe('Override the computed recipients.'), cc: Recipients.optional(), bcc: Recipients.default([]),
    subject: z.string().trim().min(1).max(998).optional().describe('Defaults to "Re: <original subject>".'),
    quote: z.boolean().default(false).describe('Append the original message as quoted text.'),
    allowAutomated: z.boolean().default(false).describe('Reply even when the original is automated or the recipient is a no-reply address.'),
  }).strict().refine(needsBody, 'Provide text or html.').openapi('ReplyToInboundThread');
  function sendActor(c: Ctx, access: MailboxAccess): Actor {
    const actor = c.get('actor');
    if (access.keyId.startsWith('mbk_') || !actor) return { keyId: access.keyId, workspaceId: access.workspaceId, permissions: ['send'], domains: [], credential: 'apiKey' };
    return actor;
  }
  async function senderAddress(c: Ctx, mailbox: typeof mailboxes.$inferSelect, from?: string, db: DbExecutor = c.env.db) {
    if (from === mailbox.address) return from;
    const [owned] = await db.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), from ? eq(mailboxAddresses.address, from) : eq(mailboxAddresses.kind, 'public')));
    if (from && !owned) {
      // Scoped keys may only speak as their own addresses; an administrator may use any registered sender.
      if (!access(c).admin) throw new ApiError(403, 'FROM_NOT_ALLOWED', 'Inbound keys can send only from their own addresses. Use administrator access for another sender.', 'from');
      if (!c.env.config.multiTenant) {
        const [domain] = await db.select({ region: mailboxDomains.region }).from(mailboxDomains).where(eq(mailboxDomains.id, mailbox.domainId));
        await assertRegisteredSender(db, scopeOf(access(c)), domain!.region, from);
      }
      return from;
    }
    return owned?.address ?? mailbox.address;
  }
  const quoted = (original: MessageRow) => {
    const who = original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress;
    const intro = `On ${new Date(original.sentAt ?? original.receivedAt).toUTCString()}, ${who} wrote:`;
    const text = original.text ?? (original.html ? htmlToPlain(original.html) : '');
    // Over the quote bounds (N6), the HTML part quotes the escaped plain text instead.
    const rich = original.html ? safeForwardHtml(original.html) : null;
    return { text: `\n\n${intro}\n${text.split('\n').map(line => `> ${line}`).join('\n')}`, html: `<br><br><div>${intro.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${rich ?? `<pre>${text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</pre>`}</blockquote>` };
  };
  async function prepareSend(c: Ctx, db: DbExecutor, mailbox: typeof mailboxes.$inferSelect, body: z.infer<typeof CreateInbound>) {
    if(mailbox.kind==='inbox')throw new ApiError(422,'EPHEMERAL_REPLY_ONLY','An ephemeral inbox cannot start a thread.');
    const from=await senderAddress(c,mailbox,body.from,db);
    const { inReplyTo, references, rest } = splitThreadingHeaders(body.headers);
    return { from, to: body.to, cc: body.cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject, text: body.text, html: body.html,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments,from), inReplyTo, references, autoSubmitted: body.autoSubmitted, headers: rest };
  }
  async function prepareReply(c: Ctx, db: DbExecutor, mailbox: typeof mailboxes.$inferSelect, original: MessageRow, body: z.infer<typeof ReplyInbound>) {
    if(mailbox.kind==='inbox' && !mailbox.sendLimits.perDay)throw new ApiError(403,'EPHEMERAL_SEND_DISABLED','Sending is not enabled for this inbox.');
    const from = await senderAddress(c, mailbox, body.from, db);
    // The chosen sender is ours too: never copy it back on a reply-all.
    const own = [...(await db.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(eq(mailboxAddresses.mailboxId, mailbox.id))).map(row => row.address), from];
    const computed = replyRecipients(original, own, body.replyAll);
    const to = body.to ?? computed.to, cc = body.cc ?? computed.cc;
    if (body.expectedRecipients) assertInboundRecipients(body.expectedRecipients, { to, cc, bcc: body.bcc });
    assertReplyable(original, to, body.allowAutomated);
    const parentId = await replyParentId(db, original);
    const quote = body.quote ? quoted(original) : null;
    return {
      from, to, cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject ?? replySubject(original.subject),
      text: body.text ? body.text + (quote?.text ?? '') : undefined, html: body.html ? body.html + (quote?.html ?? '') : undefined,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments,from), threadId: original.threadId,
      inReplyTo: parentId, references: replyReferences(original, parentId), autoSubmitted: body.autoSubmitted, headers: body.headers,
    };
  }
  registerInboundThreadReads(app, access);
  registerLogs(app, actorMailAccess);
  registerInboundOverview(app, { access, mailboxView, InboundAddressSchema, InboundDomainStatus, InboundCatchAll, security });
  app.openapi(createRoute({method:'patch',path:'/v1/inbound/threads/{threadId}',operationId:'updateInboundThread',tags:['Inbound threads'],security,summary:'Mark a conversation read, star, archive or label it for one address',request:{params:z.object({threadId:z.string().min(1).max(120)}),body:json(UpdateInboundThread)},responses:{200:response(AddressState),...errors}}),async c=>{
    const v=access(c,'modify'),{threadId}=c.req.valid('param'),{addressId,...changes}=c.req.valid('json');
    const options=await c.env.db.select({id:mailboxThreads.mailboxId}).from(mailboxThreads).where(visibleThreadAddresses(v,threadId,addressId)).limit(2);
    if (!options.length) throw new ApiError(404,'NOT_FOUND','Thread was not found.');
    if (options.length!==1) throw new ApiError(409,'ADDRESS_REQUIRED','Choose an address before changing its conversation state.','addressId');
    return c.json(await patchThread(c,options[0]!.id,threadId,changes),200);
  });
  app.openapi(createInboundThreadRoute(CreateInbound), async c => {
    const body = c.req.valid('json'), value = access(c, 'send');
    return c.json(await queueInboundThreadMessage(c, sendActor(c, value), async db => {
      const { mailbox, scope } = await mailboxFor(c, body.addressId, 'send', db);
      return { mailbox, scope, ...await prepareSend(c, db, mailbox, body) };
    }), 202);
  });
  app.openapi(replyToInboundThreadRoute(ReplyInbound), async c => {
    const body = c.req.valid('json'), value = access(c, 'send');
    if (splitThreadingHeaders(body.headers).present) throw new ApiError(422, 'THREADING_HEADER_NOT_ALLOWED', 'Replies set In-Reply-To and References from the original message. Remove them from headers.', 'headers');
    return c.json(await queueInboundThreadMessage(c, sendActor(c, value), async db => {
      const { original, addressId } = await inboundReplyTarget(db, value, { addressId: body.addressId, threadId: c.req.valid('param').threadId, messageId: body.replyToMessageId });
      const { mailbox, scope } = await mailboxFor(c, addressId, 'send', db);
      return { mailbox, scope, ...await prepareReply(c, db, mailbox, original, body) };
    }), 202);
  });
  // ---------- events ----------
  const EventQuery = z.object({ after: z.string().regex(/^\d{1,19}$/).optional().describe('Cursor from a previous response. Omit to start at the current end of the log.'), wait: z.coerce.number().int().min(0).max(30).default(0).describe('Seconds to wait for new events when none are ready (long-poll).'), types: z.string().max(400).optional().describe('Comma-separated event types.'), limit: Limit });
  const parseEventIds = (filter?: string) => filter?.split(',').map(item => item.trim()).filter(Boolean) ?? null;
  async function poll(c: Ctx, requested: string[] | null, q: z.infer<typeof EventQuery>) {
    const value = access(c, 'read');
    const mailboxIds = value.mailboxIds === null ? requested : requested === null ? value.mailboxIds : requested.filter(item => value.mailboxIds!.includes(item));
    const types = q.types?.split(',').map(type => type.trim()).filter(Boolean);
    if (types?.some(type => !inboundEventTypes.some(allowed => allowed === type))) throw new ApiError(422, 'INVALID_EVENT_TYPE', `Event types: ${inboundEventTypes.join(', ')}.`, 'types');
    const scope = { mailboxIds, includeStored: value.admin && types?.includes('message.stored') === true };
    // Reserve the extra polls before the first query. Parallel long polls use
    // the same minute counter as ordinary requests, not a separate allowance.
    if (q.wait) await reservePolls(c, value.workspaceId, value.keyId, q.wait);
    // Up to 19 digits passes the schema, but past 2^53 Number() rounds and past the bigint range the query failed with a 500.
    if (q.after !== undefined && !Number.isSafeInteger(Number(q.after))) throw new ApiError(422, 'INVALID_CURSOR', 'Use the cursor a previous response returned.', 'after');
    const after = q.after !== undefined ? Number(q.after) : await latestCursor(c.env.db, value.workspaceId, scope);
    const rows = await longPoll(c, q.wait, () => readEvents(c.env.db, value.workspaceId, { ...scope, after, types, limit: q.limit }), rows => rows.length > 0);
    return rows.length ? { data: rows.map(eventView), cursor: String(rows.at(-1)!.seq) } : { data: [], cursor: String(after) };
  }
  const InboundEventQuery = EventQuery.extend({ addressId: z.string().min(1).max(120).optional().describe('Include only this receiving address.'), addressIds: z.string().max(4000).optional().describe('Comma-separated receiving address IDs. Use instead of addressId.') }).strict().refine(q => q.addressId === undefined || q.addressIds === undefined, { path: ['addressIds'], message: 'Supply addressId or addressIds, not both.' });
  app.openapi(createRoute({ method: 'get', path: '/v1/inbound/events', operationId: 'listInboundEvents', security, tags: ['Inbound events'], summary: 'Poll events for the receiving addresses this key can read', description: 'Use the returned cursor as after to continue polling. Workspace-wide message.stored events require admin access, no address filter, and an explicit message.stored type filter.', request: { query: InboundEventQuery }, responses: { 200: response(z.object({ data: z.array(InboundEventSchema), cursor: z.string().describe('Pass as after on the next call.') }).openapi('InboundEventPage')), ...errors } }), async c => {
    const q = c.req.valid('query');
    return c.json(await poll(c, q.addressId ? [q.addressId] : parseEventIds(q.addressIds), q), 200);
  });

  registerInboundKeys(app);
  registerInboundWebhooks(app, { access, admin });
}

// Deprecated aliases: an inbound key is an API key limited to receiving addresses (POST /v1/api-keys with access).
// Same rules and rows as createApiKey; these keep their original request and response shapes.
function registerInboundKeys(app: App) {
  const base = '/v1/inbound/keys', tags = ['Inbound keys'], deprecated = true;
  const keyFields = { name: z.string().trim().min(1).max(100), permissions: z.array(z.enum(['read', 'send', 'modify','create'])).min(1).max(4).default(['read', 'send', 'modify']) };
  const ids = z.array(z.string().min(1).max(120)).max(500).optional();
  const body = z.object({ ...keyFields, addressIds: ids }).strict().openapi('CreateInboundKey');
  app.openapi(createRoute({ method: 'post', path: base, operationId: 'createInboundKey', tags, security, deprecated, summary: 'Create a key for an agent (deprecated: createApiKey with access)', description: 'Deprecated: use createApiKey with access {type: "addresses"} or {type: "inbox"}. Scopes a key to specific receiving addresses; omit the filter for every address, including future ones. The secret is returned once.',
    request: { body: json(body) }, responses: { 201: response(KeySchema.extend({ secret: z.string() }).openapi('InboundKeySecret')), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json');
    // An MCP agent may create one only with explicit receiving consent; the key is then revoked with that approval.
    lasting(c, KEY_CHANGE);
    const { createLimitedKey } = await import('./address-keys.js');
    const { row, secret } = await createLimitedKey(c, value.workspaceId, input.name, { type: 'addresses', addressIds: input.addressIds ?? null, mail: input.permissions }, { addresses: 'addressIds', inbox: 'addressIds', mail: 'permissions' });
    return c.json({ ...keyView(row), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: base, operationId: 'listInboundKeys', tags, security, deprecated, description: 'Deprecated: listApiKeys lists these with every other API key.', request: { query: z.object({ includeRevoked: z.enum(['true', 'false']).default('false'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(KeySchema, 'InboundKeyPage')), ...errors } }), async c => {
    const value = admin(c); lasting(c, KEY_CHANGE); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxKeys).where(and(eq(mailboxKeys.workspaceId, value.workspaceId), q.includeRevoked === 'false' ? isNull(mailboxKeys.revokedAt) : undefined, q.cursor ? lt(mailboxKeys.id, q.cursor) : undefined)).orderBy(desc(mailboxKeys.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: `${base}/{id}/revoke`, operationId: 'revokeInboundKey', tags, security, deprecated, description: 'Deprecated: revokeApiKey revokes any API key.', request: { params: IdParam }, responses: { 200: response(KeySchema), ...errors } }), async c => {
    const value = admin(c); lasting(c, KEY_CHANGE);
    const revoked = await (await import('./address-keys.js')).revokeLimitedKey(c, value.workspaceId, c.req.valid('param').id);
    if (!revoked?.fresh) throw new ApiError(404, 'NOT_FOUND', 'Key was not found or is already revoked.');
    return c.json(keyView(revoked.row), 200);
  });
}
