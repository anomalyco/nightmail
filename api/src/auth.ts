import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, agentTokenMintRefusal, digest, errors, hasSessionCookie, id, IdParams, isoTime, json, keyAdminRefusal, PageQuery, page, randomSecret, response, security, senderDomainAllowed, timed, withOuterRequest, wrapModuleLoad } from './core.js';
import type { Actor, App, AppEnv, Ctx, DbExecutor, MailboxAccess, RequestOrigin, Runtime } from './core.js';
import { agentTokens, apiKeys } from './db/core.js';
import { mailboxKeys } from './db/mailbox.js';
import { auditContext, auditInsert, recordAudit } from './audit.js';
import { secretPrefixes, shownPrefix } from './brand.js';
import { idempotencyGate, idempotent, IdempotencyHeaders, idempotentRequest, validIdempotencyKey } from './idempotency.js';

// A private symbol carries server-authorized identity through request-cloning middleware.
// HTTP headers/cookies cannot supply it, and every internal dispatch gets a fresh runtime.
const delegatedActor = Symbol('mcpActor');
// A recent DB-verified fingerprint can spend CPU preparing a large body. This
// hint never authorizes anything: even a hit authenticates inside admission SQL.
const verifiedFingerprints=new Map<string,number>();
function rememberFingerprint(hash:string) {
  verifiedFingerprints.delete(hash);verifiedFingerprints.set(hash,Date.now()+60_000);
  if(verifiedFingerprints.size>1024)verifiedFingerprints.delete(verifiedFingerprints.keys().next().value!);
}
const delegatedMailbox=Symbol('mcpInbox');
export const delegatedInbox=(runtime:Runtime)=>(runtime as Runtime & {[delegatedMailbox]?:MailboxAccess})[delegatedMailbox];
// Both dispatches run inside `origin`'s request: the inner call keeps its request ID, client network and user agent.
export function dispatchAsMailboxAccess(app:Pick<App,'fetch'>,request:Request,runtime:Runtime,access:MailboxAccess,origin:RequestOrigin){
  const delegated={...withOuterRequest(runtime,origin),[delegatedMailbox]:access}; return app.fetch(request,delegated);
}
type DelegatedRuntime = Runtime & { [delegatedActor]?: Actor };
export async function dispatchAsActor(app: Pick<App, 'fetch'>, request: Request, runtime: Runtime, identity: Actor, origin: RequestOrigin): Promise<Response> {
  if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'PERMISSION_DENIED', 'Invalid delegated API principal.');
  const delegatedRuntime: DelegatedRuntime = { ...withOuterRequest(runtime, origin), [delegatedActor]: identity };
  return await app.fetch(request, delegatedRuntime);
}

// `credential` returns at most one authorized row. Charge the originating principal
// (the grant for agent tokens), but touch only the credential actually presented.
// `charge` is evaluated before the budget row is locked: false leaves the request uncharged, with no budget row.
function credentialCtes(table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL, charge?: SQL) {
  return sql`credential AS MATERIALIZED (${credential}), budget AS (
      INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
      SELECT workspace_id, key_id, date_trunc('minute', now()), 1 FROM credential ${charge ? sql`WHERE ${charge}` : sql``}
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET
        used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, (SELECT max_requests + 1 FROM credential)) ELSE 1 END,
        window_start = excluded.window_start RETURNING used
    ), touched AS (
      UPDATE ${table} k SET last_used_at = ${new Date().toISOString()}::timestamptz FROM credential, budget WHERE k.id = credential.id
        AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
        ${table === mailboxKeys ? sql`AND budget.used <= credential.max_requests` : sql``}
    )`;
}
// With `charge`, a request it refuses authenticates uncharged (used is null); its own handler answers it.
export async function chargeCredential<T extends Record<string, unknown>>(c: Ctx, table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL, charge?: SQL) {
  const result = await c.env.db.execute<T & { used: number | null; max_requests: number }>(sql`WITH ${credentialCtes(table,credential,charge)} SELECT credential.*,budget.used FROM credential ${charge ? sql`LEFT JOIN budget ON true` : sql`,budget`}`);
  const row = result.rows[0];
  if (row && row.used !== null) checkBudget(c, row.used, row.max_requests);
  return row;
}
export function checkBudget(c: Ctx, used: number, maxRequests: number) {
  if (used <= maxRequests) return;
  c.header('Retry-After', '60');
  throw new ApiError(429, 'REQUEST_RATE_LIMITED', `This key exceeded its ${maxRequests}-request minute budget. Retry after the window resets.`, undefined, true);
}
/** A long poll charges every read it may take against the key's minute budget before the first, like ordinary requests. */
export async function reservePolls(c: Ctx, workspaceId: string, keyId: string, polls: number) {
  const max = c.env.config.apiRateLimitPerMinute;
  const { rows: [debit] } = await c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used)
    VALUES(${workspaceId},${keyId},date_trunc('minute',now()),${polls}) ON CONFLICT(workspace_id,key_id) DO UPDATE SET
    used=least(${max + 1},excluded.used+CASE WHEN b.window_start=excluded.window_start THEN b.used ELSE 0 END),window_start=excluded.window_start RETURNING used`);
  checkBudget(c, debit!.used, max);
}
/**
 * Reads, then once a second, until done, `seconds` (reserved with reservePolls) run out or the client goes away. An API
 * key is read again before each later read, since what it may do can change while it waits (updateApiKey): revoked or
 * ended, the poll fails as a new request with it would; with other addresses, mail, permissions or domains, the poll
 * ends with what it has, so a removed address is never read again and the next request polls with the new access.
 */
export async function longPoll<T>(c: Ctx, seconds: number, read: () => Promise<T>, done: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + seconds * 1000, unchanged = keyUnchanged(c);
  for (let left = seconds; ; left--) {
    const result = await read();
    if (done(result) || !left || Date.now() >= deadline || c.req.raw.signal.aborted) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
    if (unchanged && !await unchanged()) return result;
  }
}
/** For a request made with an API key: whether the key still has exactly the access the request authenticated with. */
function keyUnchanged(c: Ctx) {
  const box = c.get('mailboxAccess'), a = c.get('actor'), same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (box?.keyId.startsWith('mbk_')) return async () => {
    const { rows: [now] } = await c.env.db.execute<{ mailbox_ids: string[] | null; permissions: string[] }>(sql`SELECT mailbox_ids, permissions FROM mailbox_keys
      WHERE id = ${box.keyId} AND workspace_id = ${box.workspaceId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`);
    if (!now) throw new ApiError(401, 'AUTH_INVALID', 'The inbox key is invalid or expired.');
    return same(now.mailbox_ids, box.scopeIds ?? null) && same(now.permissions, box.permissions);
  };
  if (a?.credential === 'apiKey') return async () => {
    const { rows: [now] } = await c.env.db.execute<{ permissions: string[]; domains: string[] }>(sql`SELECT permissions, domains FROM api_keys
      WHERE id = ${a.keyId} AND workspace_id = ${a.workspaceId} AND revoked_at IS NULL`);
    if (!now) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
    return same(now.permissions, a.permissions) && same(now.domains, a.domains);
  };
  return null;
}

export async function chargeGrantBudget(runtime:Runtime,w:string,id:string){
  const max=runtime.config.apiRateLimitPerMinute;
  return (await runtime.db.execute<{used:number}>(sql`INSERT INTO api_request_budgets(workspace_id,key_id,window_start,used) VALUES(${w},${id},date_trunc('minute',now()),1)
    ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN api_request_budgets.window_start=excluded.window_start THEN least(api_request_budgets.used+1,${max+1}) ELSE 1 END,window_start=excluded.window_start RETURNING used`)).rows[0]!.used;
}
// Run after authentication and before idempotent replay or any configuration handler.
export const requireReceivingConsent: MiddlewareHandler<AppEnv> = async (c,next) => {
  const a=c.get('actor');
  if (a?.grantId && !a.receivingConsent) throw new ApiError(403,'ADMIN_REQUIRED','Reconnect with explicit receiving consent to access receiving configuration.');
  await next();
};

// bane_/os_: remove after rename cleanup.
const AGENT_TOKEN = /^(?:nm|bane|os)_agent_/;
const API_KEY = /^(?:nm_|bane_|os_(?:live_)?)[0-9a-f]{64}$/i;
/** A workspace API key or agent token (not an inbox key, not an account-service token): what bearerActor takes. */
export const workspaceBearer = (token: string) => /^(?:nm|bane|os)_(?!mbx_)/.test(token);
const apiKeyRow = (c: Ctx, hash: string) => sql`
  SELECT k.id, k.workspace_id, k.id AS key_id, k.permissions, k.domains, g.grant_id,
    ${c.env.config.apiRateLimitPerMinute}::int AS max_requests
  FROM api_keys k LEFT JOIN mail_grant_objects g ON g.workspace_id=k.workspace_id AND g.kind='api_key' AND g.resource=k.id
  WHERE k.hash = ${hash} AND k.revoked_at IS NULL`;

/**
 * The actor a workspace API key or agent token acts as, checked now: revoked, expired and over-budget credentials and
 * ones whose originating MCP approval ended are refused. Each call counts against the credential's minute budget. REST
 * authenticates every bearer request with this, and /mcp its key and agent-token connections, so both see one actor.
 */
export async function bearerActor(c: Ctx, token: string): Promise<Actor> {
  if (token.length > 16 * 1024) throw new ApiError(401, 'AUTH_INVALID', 'The API token is invalid or has been revoked.');
  if (AGENT_TOKEN.test(token)) {
    const [{ verifyAgentToken }, { getMcpGrantActor }] = await wrapModuleLoad(() => Promise.all([import('./agent-token.js'), import('./mcp-auth.js')]));
    const temporary = await verifyAgentToken(c.env.config, token);
    // The approval acts in the workspace the token was minted in (a call names it; the token keeps it).
    const minted = temporary && (await c.env.db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM agent_tokens WHERE id = ${temporary.id} AND grant_id = ${temporary.grant}`)).rows[0];
    const grant = temporary && minted && await getMcpGrantActor(c.env, temporary.grant, minted.workspace_id);
    const invalid = () => new ApiError(401, 'AUTH_INVALID', 'The temporary API token is invalid, expired, or its originating approval was revoked.');
    if (!temporary || !grant || temporary.permissions.some(permission => !grant.permissions.includes('manage') && !grant.permissions.includes(permission))) throw invalid();
    const limit = c.env.config.apiRateLimitPerMinute;
    const tracked = await timed(c, 'budget-db', () => chargeCredential(c, agentTokens, sql`
      SELECT id, workspace_id, grant_id AS key_id, ${limit}::int AS max_requests FROM agent_tokens
      WHERE id = ${temporary.id} AND revoked_at IS NULL AND workspace_id = ${grant.workspaceId} AND grant_id = ${temporary.grant}
        AND date_trunc('milliseconds', expires_at) = ${new Date(temporary.exp).toISOString()}::timestamptz
        AND permissions = ${JSON.stringify(temporary.permissions)}::jsonb AND domains = ${JSON.stringify(temporary.domains)}::jsonb`));
    if (!tracked) throw invalid();
    return { ...grant, permissions: temporary.permissions, domains: temporary.domains, credential: 'agentToken', tokenId: temporary.id };
  }
  if (!API_KEY.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
  const hash = await digest(token);
  // A send's duplicate that reaches another isolate (a cold fingerprint) must not wait on the budget row either.
  const idem = c.req.method==='POST' && ['/v1/emails/send','/v1/emails/batch'].includes(c.req.path) ? c.req.header('Idempotency-Key') : undefined;
  const key = await timed(c, 'budget-db', () => chargeCredential<Pick<Actor, 'permissions' | 'domains'> & { id: string; workspace_id: string; grant_id:string|null }>(c, apiKeys, apiKeyRow(c, hash), idem!==undefined && validIdempotencyKey(idem) ? idempotencyGate(c.req.path,idem) : undefined));
  if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
  let grant:Actor|null=null;
  if (key.grant_id) {
    const {getMcpGrantActor}=await wrapModuleLoad(()=>import('./mcp-auth.js'));
    grant=await getMcpGrantActor(c.env,'mcp_'+key.grant_id,key.workspace_id);
    if (grant?.workspaceId!==key.workspace_id || !grant.permissions.includes('manage')) throw new ApiError(401,'AUTH_INVALID','The originating management approval is no longer active.');
  } else rememberFingerprint(hash);
  return { grantId:grant?.grantId, receivingConsent:grant?.receivingConsent, userId:grant?.userId, keyId: key.id, workspaceId: key.workspace_id, permissions: key.permissions, domains: key.domains, credential: 'apiKey' };
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const delegated = (c.env as DelegatedRuntime)[delegatedActor];
  const authorization = c.req.header('authorization');
  if (delegated) {
    c.set('actor', delegated);
    const maxRequests = c.env.config.apiRateLimitPerMinute;
    checkBudget(c,await timed(c,'budget-db',()=>chargeGrantBudget(c.env,delegated.workspaceId,delegated.keyId)),maxRequests);
  } else if (authorization !== undefined) {
    const token = authorization.match(/^Bearer (.+)$/i)?.[1];
    if (!token || token.length > 16 * 1024) throw new ApiError(401, 'AUTH_INVALID', 'The API token is invalid or has been revoked.');
    // A send with a key this isolate verified a minute ago admits the request in one statement (sending.ts).
    if (API_KEY.test(token) && c.env.config.multiTenant && c.req.method==='POST' && ['/v1/emails/send','/v1/emails/batch'].includes(c.req.path)) {
      const hash = await digest(token);
      if((verifiedFingerprints.get(hash)??0)>Date.now()) {
        const {tryAtomicKeyAdmission}=await wrapModuleLoad(()=>import('./sending.js'));
        const response=await tryAtomicKeyAdmission(c,charge=>credentialCtes(apiKeys,sql`${apiKeyRow(c, hash)} AND g.grant_id IS NULL`,charge));
        if(response){rememberFingerprint(hash);return response;}
      }
    }
    c.set('actor', await bearerActor(c, token));
  } else {
    if (!c.env.config.accountClient) {
      throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Dashboard sign-in is not configured for this deployment.');
    }
    if (!hasSessionCookie(c.req.raw.headers)) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in or supply a bearer API key.');
    const { getDashboardActor, migrateLegacyCookies, requireDashboardOrigin, settleDefaultAccount } = await wrapModuleLoad(() => import('./dashboard-auth.js'));
    const dashboard = await timed(c,'session-db',()=>getDashboardActor(c.env,c.req.raw.headers));
    if (!dashboard) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in or supply a bearer API key.');
    migrateLegacyCookies(c); settleDefaultAccount(c, dashboard.keyId.slice('user_'.length));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireDashboardOrigin(c.env, c.req.raw);
    c.set('actor', dashboard);
  }
  await next();
};
const MailPermission = z.enum(['read', 'send', 'modify', 'create']);
const KeyAccess = z.object({
  type: z.enum(['workspace', 'addresses', 'inbox']).describe('workspace: the whole workspace, with permissions and domains. addresses: only mail at receiving addresses. inbox: only one agent inbox; the key stops working when the inbox is deleted.'),
  addressIds: z.array(z.string()).nullable().describe('addresses: the receiving addresses it may use, or null for every address including ones added later. inbox: the inbox. Null for workspace keys.'),
  inboxId: z.string().nullable().describe('inbox: the agent inbox the key belongs to.'),
  mail: z.array(MailPermission).describe('addresses and inbox: read (mail, events, attachments), send (reply and start conversations from those addresses only), modify (mark read, archive, star, label, delete an inbox), create (create agent inboxes and use the ones it created). Empty for workspace keys.'),
  createdInboxIds: z.array(z.string()).describe('With create: the live agent inboxes the key created, which it reaches as well as addressIds (up to 1,000, by ID). Empty otherwise.'),
}).openapi('ApiKeyAccess');
const KeySchema = z.object({ id: z.string(), name: z.string(),
  permissions: z.array(z.enum(['read', 'send', 'manage'])).describe('Workspace permissions. Empty for a key limited to addresses or an inbox: see access.'),
  domains: z.array(z.string()), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(),
  access: KeyAccess, expiresAt: z.string().nullable().describe('When a key limited to an expiring inbox stops working (the inbox\'s deletion time). Null otherwise.'),
}).openapi('ApiKey');
export const AgentTokenRecord = z.object({ id: z.string(), grantId: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string(), expiresAt: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('AgentTokenRecord');
const KeyAccessInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('addresses'), addressIds: z.array(z.string().min(1).max(120)).max(500).optional().describe('Receiving address IDs. Omit for every address, including ones added later. [] with create: only the inboxes the key creates.'),
    mail: z.array(MailPermission).min(1).max(4).default(['read']) }).strict(),
  z.object({ type: z.literal('inbox'), inboxId: z.string().min(1).max(120).describe('An active agent inbox. The key stops working when the inbox is deleted, and when an expiring inbox ends.'),
    mail: z.array(z.enum(['read', 'send', 'modify'])).min(1).max(3).default(['read']) }).strict(),
]).openapi('CreateApiKeyAccess');
const KeyName = z.string().trim().min(1).max(100), KeyPermissions = z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3);
const SenderDomains = z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50);
const KeyInput = z.object({ name: KeyName,
  permissions: KeyPermissions.optional().describe('Workspace keys: read, send and manage. Defaults to send.'),
  domains: SenderDomains.optional().describe('Workspace keys: sender domains it is limited to, including their subdomains. Defaults to all.'),
  access: KeyAccessInput.optional().describe('What the key is limited to. Defaults to the workspace. A key for addresses or an inbox takes its permissions in access.mail and can never send from other addresses, read other mail or manage the workspace.'),
}).strict().openapi('CreateApiKey');
const AddressIds = z.array(z.string().min(1).max(120)).max(500);
const KeyUpdate = z.object({ name: KeyName.optional(),
  permissions: KeyPermissions.optional().describe('Workspace keys: replaces its permissions.'),
  domains: SenderDomains.optional().describe('Workspace keys: replaces the sender domains it is limited to. [] for all domains.'),
  access: z.object({
    addressIds: AddressIds.nullable().optional().describe('A key for addresses: replaces its addresses. null for every address, including ones added later.'),
    addAddressIds: AddressIds.min(1).optional().describe('A key for addresses: adds these and keeps the others. An address it already has is left as it is, so a retry changes nothing.'),
    removeAddressIds: AddressIds.min(1).optional().describe('A key for addresses: removes these. Requests with the key lose them at once, and replies it queued from them are not sent. An inbox the key created stays reachable while it has create, so removing one is refused (409 CREATED_INBOX_REACHABLE) unless mail drops create too.'),
    mail: z.array(MailPermission).min(1).max(4).optional().describe('A key for addresses or an inbox: replaces what it may do with that mail. An inbox key takes read, send and modify.'),
  }).strict().optional().describe('A key limited to addresses or an inbox. Its type never changes, nor does an inbox key\'s inbox.'),
}).strict().openapi('UpdateApiKey');
/** Key administration's actor (core.ts keyAdminRefusal). */
export function manageKeys(c: Parameters<typeof actor>[0]) {
  const value = actor(c, 'manage'), refusal = keyAdminRefusal(value);
  if (refusal) throw refusal;
  return value;
}
const workspaceAccess = { type: 'workspace' as const, addressIds: null, inboxId: null, mail: [], createdInboxIds: [] };
/** The creator grant: a key with create also reaches the live agent inboxes it created, the first 1,000 by ID. Read here
 *  by authentication (mailbox.ts authorizeInboxKey), the key list and updateApiKey, so all three report one access. */
export const createdInboxes = (workspaceId: SQL, keyId: SQL) => sql`to_jsonb(ARRAY(SELECT b.id FROM mailboxes b WHERE b.workspace_id=${workspaceId} AND b.created_by=${keyId}
  AND b.kind='inbox' AND b.delete_after>now() ORDER BY b.id LIMIT 1000))`;
const keyView = (key: typeof apiKeys.$inferSelect) => ({ id: key.id, name: key.name, permissions: key.permissions, domains: key.domains, prefix: key.prefix,
  createdAt: isoTime(key.createdAt)!, lastUsedAt: isoTime(key.lastUsedAt), revokedAt: isoTime(key.revokedAt), access: workspaceAccess, expiresAt: null });
// Keys limited to addresses or an inbox live in mailbox_keys (address-keys.ts); loaded only when a request names one.
const addressKeys = () => wrapModuleLoad(() => import('./address-keys.js'));
export const inactiveKey = () => new ApiError(409, 'KEY_INACTIVE', 'This key was revoked or has ended, so it can\'t be changed. Create a new key instead.');
/**
 * updateApiKey's rule for an MCP approval, and for a key it created: it changes only the keys that approval created.
 * createApiKey gives an approval only keys that end with it, and any other key outlives it. Taking an existing key over
 * isn't the answer either: removing the approval would then revoke a key someone else made.
 */
export async function approvalMadeKey(tx: DbExecutor, a: Actor, kind: 'api_key' | 'key', keyId: string) {
  if (!a.grantId) return;
  const { rows } = await tx.execute(sql`SELECT 1 FROM mail_grant_objects WHERE grant_id = ${a.grantId} AND workspace_id = ${a.workspaceId} AND kind = ${kind} AND resource = ${keyId}`);
  if (!rows.length) throw new ApiError(403, 'PERMISSION_DENIED', 'An MCP approval changes only the keys it created. Change this key in the dashboard or with a key that has manage permission.');
}
/**
 * Key administration, checked again inside the transaction that writes a key: manageKeys judged the caller as the request
 * authenticated, and that authority can be narrowed or revoked while the request waits (updateApiKey, revokeApiKey, an
 * approval's or a member's removal). This reads it as it is now and holds it until commit, so the write happens either
 * before the narrowing, or after it and is refused. One lock order for every key write:
 *   1. who is behind the request: the MCP approval (a sign-in, or the approval that made the calling key) or the signed-in
 *      member's membership, shared, as their removal takes them first;
 *   2. the key rows: the calling API key (shared) and the key being changed (for update), in ascending ID order. Two keys
 *      editing each other then take their rows in the same order: one waits for the other, and reads its new access.
 * `receiving`: the write is a key limited to addresses or an inbox, which an approval needs receiving consent for.
 * Returns the locked target row.
 */
export async function holdKeyAdmin<T>(tx: DbExecutor, c: Ctx, receiving: boolean, target?: { id: string; lock: () => Promise<T | undefined> }): Promise<T | undefined> {
  const a = c.get('actor'), changed = (who: string) => new ApiError(401, 'AUTH_INVALID', `${who} was revoked or changed while this request ran. Nothing was changed.`);
  if (a.grantId) {
    const grant = await (await wrapModuleLoad(() => import('./mcp-auth.js'))).getMcpGrantActor(c.env, 'mcp_' + a.grantId, a.workspaceId, tx);
    if (grant?.workspaceId !== a.workspaceId || !grant.permissions.includes('manage') || receiving && !grant.receivingConsent) throw changed('The MCP approval behind this request');
  } else if (a.credential === 'dashboard') {
    const { rows: [member] } = await tx.execute<{ role: string }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${a.workspaceId} AND user_id = ${a.keyId.slice('user_'.length)} FOR SHARE`);
    if (member?.role !== 'owner' && member?.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', 'Key administration requires a workspace owner or admin.');
  }
  const caller = a.credential === 'apiKey' ? a.keyId : null;
  let row: T | undefined;
  for (const id of [caller, target?.id].filter((x): x is string => !!x).sort()) {
    if (id !== caller) { row = await target!.lock(); continue; }
    const { rows: [now] } = await tx.execute<Pick<Actor, 'permissions' | 'domains'>>(sql`SELECT permissions, domains FROM api_keys
      WHERE id = ${id} AND workspace_id = ${a.workspaceId} AND revoked_at IS NULL FOR SHARE`);
    if (!now) throw changed('The API key behind this request');
    const refusal = keyAdminRefusal({ ...a, ...now });
    if (refusal) throw refusal;
  }
  return row;
}
const keySummary = (k: Pick<typeof apiKeys.$inferSelect, 'name' | 'permissions' | 'domains'>) => ({ name: k.name, permissions: k.permissions, domains: k.domains });
/** A workspace key's name, permissions and sender domains, in place. Requests and queued mail use the new ones at once:
 *  both read the key's row when they authenticate and when the mail is dispatched. */
async function updateWorkspaceKey(tx: DbExecutor, c: Ctx, a: Actor, keyId: string, input: z.infer<typeof KeyUpdate>) {
  if (input.access) throw new ApiError(422, 'VALIDATION_FAILED', 'A workspace key takes permissions and domains; access is for a key limited to addresses or an inbox, and a key\'s type never changes.', 'access');
  const row = await holdKeyAdmin(tx, c, false, { id: keyId, lock: async () => (await tx.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, a.workspaceId), eq(apiKeys.id, keyId))).for('update'))[0] });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
  if (row.revokedAt) throw inactiveKey();
  await approvalMadeKey(tx, a, 'api_key', row.id);
  const next = { name: input.name ?? row.name, permissions: input.permissions ? [...new Set(input.permissions)] : row.permissions, domains: input.domains ? [...new Set(input.domains)] : row.domains };
  if (JSON.stringify(keySummary(next)) === JSON.stringify(keySummary(row))) return row;
  const [updated] = await tx.update(apiKeys).set(next).where(eq(apiKeys.id, row.id)).returning();
  await recordAudit(tx, c, { action: 'api_key.update', workspaceId: a.workspaceId, target: { type: 'api_key', id: row.id }, before: keySummary(row), after: keySummary(next) });
  return updated!;
}
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'A short-lived, nonrefreshable token for temporary scripts. Requires an MCP approval and never exceeds it. A manage token makes no change that outlasts it: no API keys, webhooks, endpoints, routes, rituals, mail client passwords or inbox connections.', request: { body: json(z.object({
    permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).refine(value => value[0] === 'read' && new Set(value).size === value.length, 'Start with read and do not repeat permissions.'),
    expiresInSeconds: z.number().int().min(30).max(86400), domains: SenderDomains.default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.includes('manage') ? 'manage' : input.permissions.includes('send') ? 'send' : 'read');
    const refusal = agentTokenMintRefusal(identity);
    if (refusal) throw refusal;
    if (input.permissions.some(permission => !identity.permissions.includes('manage') && !identity.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP approval does not include every requested permission.');
    if (identity.domains.length && (!input.domains.length || input.domains.some(domain => !senderDomainAllowed(identity.domains, domain)))) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'The temporary token must remain restricted to the approved sender domains or their subdomains.', 'domains');
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
    const tokenId = id('agt');
    const { createAgentToken } = await wrapModuleLoad(() => import('./agent-token.js'));
    const token = await createAgentToken(c.env.config, { id: tokenId, grant: identity.keyId, permissions: input.permissions, domains: input.domains, expiresAt });
    // The token and its audit row in one statement.
    await c.env.db.execute(sql`WITH t AS (INSERT INTO agent_tokens(id, workspace_id, grant_id, permissions, domains, purpose, expires_at)
      VALUES (${tokenId}, ${identity.workspaceId}, ${identity.keyId}, ${JSON.stringify(input.permissions)}::jsonb, ${JSON.stringify(input.domains)}::jsonb, ${input.purpose}, ${expiresAt}::timestamptz) RETURNING id)
      ${auditInsert(auditContext(c), { action: 'agent_token.create', workspaceId: identity.workspaceId, target: { type: 'agent_token', id: tokenId },
        after: { permissions: input.permissions, domains: input.domains, purpose: input.purpose, expiresAt } }, { from: sql`t` })}`);
    return c.json({ id: tokenId, token, expiresAt, permissions: input.permissions, domains: input.domains, purpose: input.purpose }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent-tokens', operationId: 'listAgentTokens', tags: ['Auth'], security, request: { query: PageQuery.extend({ includeInactive: z.enum(['true', 'false']).default('false') }) }, responses: { 200: response(page(AgentTokenRecord)), ...errors } }), async c => {
    const identity = manageKeys(c); const query = c.req.valid('query');
    const rows = await c.env.db.select().from(agentTokens).where(and(eq(agentTokens.workspaceId, identity.workspaceId), query.includeInactive === 'false' ? and(isNull(agentTokens.revokedAt), gt(agentTokens.expiresAt, new Date().toISOString())) : undefined, query.cursor ? gt(agentTokens.id, query.cursor) : undefined)).orderBy(agentTokens.id).limit(query.limit + 1);
    const data = rows.slice(0, query.limit).map(({ workspaceId: _workspace, ...row }) => row);
    return c.json({ data, nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens/{id}/revoke', operationId: 'revokeAgentToken', tags: ['Auth'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const identity = manageKeys(c), tokenId = c.req.valid('param').id;
    const { rows: [row] } = await c.env.db.execute<{ id: string }>(sql`WITH t AS (UPDATE agent_tokens SET revoked_at = now() WHERE workspace_id = ${identity.workspaceId} AND id = ${tokenId} AND revoked_at IS NULL
        RETURNING id, purpose), a AS (${auditInsert(auditContext(c), { action: 'agent_token.revoke', workspaceId: identity.workspaceId, target: { type: 'agent_token', id: sql`t.id` },
        before: sql`jsonb_build_object('purpose', left(t.purpose, 200))` }, { from: sql`t` })}) SELECT id FROM t`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agent token was not found or is already revoked.');
    return c.json({ id: row.id, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['ApiKeys'], security,
    description: 'One key type with permissions. By default a workspace key (permissions, optional sender domains). With access, a key limited to receiving addresses or to one agent inbox (bearer nm_mbx_…): it reads and, with send, replies only there, and never reaches the rest of the workspace. The secret is returned once.',
    request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string() })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json'), access = input.access ?? { type: 'workspace' as const };
    if (access.type !== 'workspace') {
      if (input.permissions || input.domains?.length) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', input.permissions ? 'permissions' : 'domains');
      const { createLimitedKey, limitedKeyView } = await addressKeys();
      const { row, secret } = await createLimitedKey(c, auth.workspaceId, input.name, access, { addresses: 'access.addressIds', inbox: 'access.inboxId', mail: 'access.mail' });
      return c.json({ ...limitedKeyView(row), secret }, 201);
    }
    const permissions = input.permissions ?? ['send'], domains = input.domains ?? [];
    const secret = randomSecret(secretPrefixes.apiKey);
    const [key] = await c.env.db.transaction(async tx => {
      await holdKeyAdmin(tx, c, false);
      const rows = await tx.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, name: input.name, permissions, domains, hash: await digest(secret), prefix: shownPrefix(secret) }).returning();
      // A key created by an MCP agent lives only as long as the approval that created it.
      if (auth.grantId) await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${auth.grantId},${auth.workspaceId},'api_key',${rows[0]!.id})`);
      await recordAudit(tx, c, { action: 'api_key.create', workspaceId: auth.workspaceId, target: { type: 'api_key', id: rows[0]!.id },
        after: { name: input.name, permissions, domains, prefix: rows[0]!.prefix.slice(0, 9), mcpGrant: auth.grantId ?? undefined } });
      return rows;
    });
    return c.json({ ...keyView(key!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, description: 'Every API key in the workspace, ordered by ID: workspace keys and keys limited to addresses or an inbox. includeRevoked=false also leaves out keys whose inbox was deleted or whose lease ended.',
    request: { query: PageQuery.extend({ includeRevoked: z.enum(['true', 'false']).default('true') }) }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query'), w = auth.workspaceId, active = q.includeRevoked === 'false', after = q.cursor ? sql`AND id > ${q.cursor}` : sql``;
    // One cursor over both tables. A limited key has no workspace permissions or domains: its access says what it may do.
    const { rows } = await c.env.db.execute<{ id: string; name: string; prefix: string; permissions: ('read' | 'send' | 'manage')[]; domains: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null;
      expires_at: string | null; address_ids: string[] | null; inbox_id: string | null; mail: ('read' | 'send' | 'modify' | 'create')[]; created_inbox_ids: string[]; limited: boolean }>(sql`
      SELECT * FROM (SELECT id, name, prefix, permissions, domains, created_at::text, last_used_at::text, revoked_at::text, NULL::text AS expires_at, NULL::jsonb AS address_ids, NULL::text AS inbox_id, '[]'::jsonb AS mail, '[]'::jsonb AS created_inbox_ids, false AS limited
          FROM api_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL` : sql``} ${after}
        UNION ALL SELECT id, name, prefix, '[]'::jsonb, '[]'::jsonb, created_at::text, last_used_at::text, revoked_at::text, expires_at::text, mailbox_ids, inbox_id, permissions,
            CASE WHEN permissions ? 'create' THEN ${createdInboxes(sql`mailbox_keys.workspace_id`, sql`mailbox_keys.id`)} ELSE '[]'::jsonb END, true
          FROM mailbox_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` : sql``} ${after}) k
      ORDER BY id LIMIT ${q.limit + 1}`);
    const data = rows.slice(0, q.limit).map(r => ({ id: r.id, name: r.name, permissions: r.permissions, domains: r.domains, prefix: r.prefix,
      createdAt: isoTime(r.created_at)!, lastUsedAt: isoTime(r.last_used_at), revokedAt: isoTime(r.revoked_at), expiresAt: isoTime(r.expires_at),
      access: r.limited ? { type: r.inbox_id ? 'inbox' as const : 'addresses' as const, addressIds: r.address_ids, inboxId: r.inbox_id, mail: r.mail, createdInboxIds: r.created_inbox_ids } : workspaceAccess }));
    return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys/{id}/revoke', operationId: 'revokeApiKey', tags: ['ApiKeys'], security, description: 'Revokes any API key, including one limited to addresses or an inbox. Requests with it fail at once, and mail it queued is not sent.',
    request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const auth = manageKeys(c); const keyId = c.req.valid('param').id;
    if (keyId.startsWith('mbk_')) {
      const revoked = await (await addressKeys()).revokeLimitedKey(c, auth.workspaceId, keyId);
      if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
      return c.json({ id: revoked.row.id, revoked: true as const }, 200);
    }
    // A repeated revoke keeps the first revocation time and writes no second audit row.
    const { rows: [key] } = await c.env.db.execute<{ id: string }>(sql`WITH k AS (UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${keyId} AND workspace_id = ${auth.workspaceId}
        RETURNING id, name, left(prefix, 9) AS prefix, revoked_at = now() AS fresh),
      a AS (${auditInsert(auditContext(c), { action: 'api_key.revoke', workspaceId: auth.workspaceId, target: { type: 'api_key', id: sql`k.id` },
        before: sql`jsonb_build_object('name', k.name, 'prefix', k.prefix)` }, { from: sql`k`, where: sql`k.fresh` })}) SELECT id FROM k`);
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json({ id: key.id, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/api-keys/{id}', operationId: 'updateApiKey', tags: ['ApiKeys'], security,
    description: 'Changes what a key can reach and keeps its secret, so nothing has to be redeployed. A workspace key takes name, permissions and domains. A key for addresses takes name and access: add or remove addresses (addAddressIds, removeAddressIds), replace them (addressIds) or change access.mail. An inbox key takes name and access.mail. A key\'s type and secret never change. Takes effect at once: requests already waiting lose a removed address, and mail the key queued is sent only within its new access. Needs the access createApiKey needs, checked again as the change is written, and no key changes itself; over MCP, only keys that approval created. Revoked and ended keys can\'t be changed.',
    request: { params: IdParams, headers: IdempotencyHeaders, body: json(KeyUpdate) }, responses: { 200: response(KeySchema), ...errors } }), async c => {
    const auth = manageKeys(c), keyId = c.req.valid('param').id, input = c.req.valid('json');
    if (input.name === undefined && !input.permissions && !input.domains && !input.access) throw new ApiError(422, 'VALIDATION_FAILED', 'Change at least one of name, permissions, domains or access.');
    // What a key may do is another administrator's decision, never its own.
    if (auth.keyId === keyId) throw new ApiError(403, 'PERMISSION_DENIED', 'A key can\'t change itself. Change it in the dashboard or with another key that has manage permission.');
    const limited = keyId.startsWith('mbk_') ? await addressKeys() : null;
    const view = await idempotent(c.env.db, { ...idempotentRequest(c), workspaceId: auth.workspaceId, actorKeyId: auth.keyId }, input,
      async tx => limited ? limited.updateLimitedKey(tx, c, auth, keyId, input) : keyView(await updateWorkspaceKey(tx, c, auth, keyId, input)));
    return c.json(view, 200);
  });
}
