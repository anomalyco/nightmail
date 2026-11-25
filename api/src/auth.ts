import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, agentTokenMintRefusal, denied, digest, requiredOf, errors, hasSessionCookie, id, IdParams, isoTime, json, keyAdminRefusal, PageQuery, page, randomSecret, response, security, senderDomainAllowed, timed, withOuterRequest, wrapModuleLoad } from './core.js';
import type { Actor, App, AppEnv, Ctx, DbExecutor, MailboxAccess, RequestOrigin, Runtime } from './core.js';
import { agentTokens, apiKeys } from './db/core.js';
import { mailboxKeys } from './db/mailbox.js';
import { AuditEntry, auditContext, auditInsert, keyTrail, LastChange, lastChanges, recordAudit } from './audit.js';
import { secretPrefixes, shownPrefix } from './brand.js';
import { idempotencyGate, idempotent, IdempotencyHeaders, idempotentRequest, validIdempotencyKey } from './idempotency.js';
import { approvalField, approvalTie, approvalTies, tiedNextStep } from './approval-ties.js';

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
  if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw denied('PERMISSION_DENIED', 'Invalid delegated API principal.', { credential: 'signIn' });
  const delegatedRuntime: DelegatedRuntime = { ...withOuterRequest(runtime, origin), [delegatedActor]: identity };
  return await app.fetch(request, delegatedRuntime);
}

// `credential` returns at most one authorized row. Charge the originating principal
// (the grant for agent tokens), but touch only the credential actually presented.
// `charge` is evaluated before the budget row is locked: false leaves the request uncharged, with no budget row.
export function credentialCtes(table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL, charge?: SQL) {
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
      WHERE id = ${a.keyId} AND workspace_id = ${a.workspaceId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`);
    if (!now) throw new ApiError(401, 'AUTH_INVALID', 'The API key was revoked or has expired.');
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
  if (a?.grantId && !a.receivingConsent) throw denied('ADMIN_REQUIRED','Receiving configuration requires an owner or admin of this workspace.', { ...requiredOf(c), person: 'admin' });
  await next();
};

// bane_/os_: remove after rename cleanup.
const AGENT_TOKEN = /^(?:nm|bane|os)_agent_/;
export const API_KEY = /^(?:nm_|bane_|os_(?:live_)?)[0-9a-f]{64}$/i;
/** A workspace API key or agent token (not an inbox key, not an account-service token): what bearerActor takes. */
export const workspaceBearer = (token: string) => /^(?:nm|bane|os)_(?!mbx_)/.test(token);
/** The key a secret names, if it works now. `ended`: an expired key too, flagged, so its refusal can say when it ended
 *  (charge it with NOT credential.ended, so the refused request is never charged). */
const apiKeyRow = (c: Ctx, hash: string, ended = false) => sql`
  SELECT k.id, k.workspace_id, k.id AS key_id, k.permissions, k.domains, g.grant_id, k.agent_setup_id IS NOT NULL AS agent_setup,
    ${ended ? sql`k.expires_at::text AS expires_at, coalesce(k.expires_at <= now(), false) AS ended,` : sql``} ${c.env.config.apiRateLimitPerMinute}::int AS max_requests
  FROM api_keys k LEFT JOIN mail_grant_objects g ON g.workspace_id=k.workspace_id AND g.kind='api_key' AND g.resource=k.id
  WHERE k.hash = ${hash} AND k.revoked_at IS NULL ${ended ? sql`` : sql`AND (k.expires_at IS NULL OR k.expires_at > now())`}`;
/** A key past its expiry is refused like a revoked one, saying when it ended: a later expiry brings it back, same secret. */
export const keyExpired = (at: string, inbox = false) => new ApiError(401, 'AUTH_INVALID', inbox
  ? `This API key ended at ${new Date(at).toISOString()}: its inbox ended or its expiry passed. While the inbox is active, a later expiry (API keys → Edit, or updateApiKey) brings it back with the same secret.`
  : `This API key expired at ${new Date(at).toISOString()}. A later expiry or none (API keys → Edit, or updateApiKey with expiresAt) brings it back with the same secret.`);

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
    const grant = temporary && await getMcpGrantActor(c.env, temporary.grant, { agentTokenId: temporary.id });
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
  const gate = idem!==undefined && validIdempotencyKey(idem) ? idempotencyGate(c.req.path,idem) : undefined;
  const key = await timed(c, 'budget-db', () => chargeCredential<Pick<Actor, 'permissions' | 'domains'> & { id: string; workspace_id: string; grant_id:string|null; agent_setup: boolean; expires_at: string | null; ended: boolean }>(c, apiKeys, apiKeyRow(c, hash, true), sql`NOT credential.ended${gate ? sql` AND ${gate}` : sql``}`));
  if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
  if (key.ended) throw keyExpired(key.expires_at!);
  let grant:Actor|null=null;
  if (key.grant_id) {
    const {getMcpGrantActor}=await wrapModuleLoad(()=>import('./mcp-auth.js'));
    grant=await getMcpGrantActor(c.env,'mcp_'+key.grant_id,key.workspace_id,undefined,'lasting');
    if (grant?.workspaceId!==key.workspace_id || !grant.permissions.includes('manage')) throw new ApiError(401,'AUTH_INVALID','The originating management approval is no longer active.');
  } else rememberFingerprint(hash);
  return { grantId:grant?.grantId, receivingConsent:grant?.receivingConsent, userId:grant?.userId, keyId: key.id, workspaceId: key.workspace_id, permissions: key.permissions, domains: key.domains, credential: 'apiKey', ...(key.agent_setup ? { agentSetup: true } : {}) };
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
    // A background continuation for a private Logs view must not choose a workspace on the user's behalf.
    // It uses the same session, expiry, membership and role resolver without the preference write.
    const facetRefresh=c.req.method==='GET' && c.req.path==='/v1/logs/facets' && c.req.query('mode')==='refresh';
    const dashboard = await timed(c,'session-db',async()=>facetRefresh
      ? (await wrapModuleLoad(()=>import('./account-login.js'))).accountSessionActorOnFacetRetry(c.env,c.req.raw.headers,c.env.db)
      : getDashboardActor(c.env,c.req.raw.headers));
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
  access: KeyAccess, expiresAt: z.string().nullable().describe('When the key stops working: the expiry set on it, or for an inbox key its inbox\'s end if that is sooner. Null: it never expires. updateApiKey changes it on the same secret.'),
  approval: approvalField,
  lastChange: LastChange.nullable().describe('The newest entry in its history (listApiKeyChanges): when it was created, changed or revoked, and by whom. Null when none is kept (after a year).'),
}).openapi('ApiKey');
export const AgentTokenRecord = z.object({ id: z.string(), grantId: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string(), expiresAt: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('AgentTokenRecord');
const KeyAccessInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('addresses'), addressIds: z.array(z.string().min(1).max(120)).max(500).optional().describe('Receiving address IDs. Omit for every address, including ones added later. [] with create: only the inboxes the key creates.'),
    mail: z.array(MailPermission).min(1).max(4).default(['read']) }).strict(),
  z.object({ type: z.literal('inbox'), inboxId: z.string().min(1).max(120).describe('An active agent inbox. The key stops working when the inbox is deleted, and when an expiring inbox ends.'),
    mail: z.array(MailPermission).min(1).max(4).default(['read']).describe('read, send and modify, as for addresses; with create it also reaches the inboxes it creates, until its own inbox ends.') }).strict(),
]).openapi('CreateApiKeyAccess');
const KeyExpiry = z.iso.datetime().nullable().describe('When the key stops working, a time to come (UTC). Null: it never expires; an inbox key then ends with its inbox. Requests with an expired key get 401 AUTH_INVALID saying when it ended, and a later expiry brings it back with the same secret.');
const KeyName = z.string().trim().min(1).max(100), KeyPermissions = z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3);
const SenderDomains = z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50);
const KeyInput = z.object({ name: KeyName,
  permissions: KeyPermissions.optional().describe('Workspace keys: read, send and manage. Defaults to send.'),
  domains: SenderDomains.optional().describe('Workspace keys: sender domains it is limited to, including their subdomains. Defaults to all.'),
  access: KeyAccessInput.optional().describe('What the key is limited to. Defaults to the workspace. A key for addresses or an inbox takes its permissions in access.mail and can never send from other addresses, read other mail or manage the workspace.'),
  expiresAt: KeyExpiry.optional().describe('When the key stops working. Omit or null for a key that never expires; an inbox key also ends with its inbox, and its expiry is at most that end.'),
}).strict().openapi('CreateApiKey');
const AddressIds = z.array(z.string().min(1).max(120)).max(500);
const KeyUpdate = z.object({ name: KeyName.optional(),
  permissions: KeyPermissions.optional().describe('Workspace keys: replaces its permissions.'),
  domains: SenderDomains.optional().describe('Workspace keys: replaces the sender domains it is limited to. [] for all domains.'),
  addDomains: SenderDomains.min(1).optional().describe('Workspace keys: adds these sender domains and keeps the others. A key for all domains already has them.'),
  removeDomains: SenderDomains.min(1).optional().describe('Workspace keys: removes these sender domains. Removing the last one is refused, since [] means all domains: set domains instead.'),
  expiresAt: KeyExpiry.optional().describe('Any key: sets when it stops working, or null so it never expires (an inbox key then ends with its inbox). An expired key can be given a later expiry: it works again with the same secret. Over MCP, an agent moves an expiry later only up to its own approval\'s end, and never removes one; a key an approval created is exempt, as it ends with that approval anyway.'),
  access: z.object({
    type: z.enum(['addresses', 'inbox']).optional().describe('A key for addresses or an inbox: makes it the other one, on the same secret. inbox takes inboxId; addresses keeps the inbox as its address unless addressIds says otherwise.'),
    inboxId: z.string().min(1).max(120).optional().describe('An inbox key: the active agent inbox it belongs to now. It ends with that inbox, and its expiry is at most that inbox\'s end.'),
    addressIds: AddressIds.nullable().optional().describe('A key for addresses: replaces its addresses. null for every address, including ones added later.'),
    addAddressIds: AddressIds.min(1).optional().describe('A key for addresses: adds these and keeps the others. An address it already has is left as it is, so a retry changes nothing.'),
    removeAddressIds: AddressIds.min(1).optional().describe('A key for addresses: removes these. Requests with the key lose them at once, and replies it queued from them are not sent. An inbox the key created stays reachable while it has create, so removing one is refused (409 CREATED_INBOX_REACHABLE) unless mail drops create too.'),
    mail: z.array(MailPermission).min(1).max(4).optional().describe('A key for addresses or an inbox: replaces what it may do with that mail: read, send, modify, and create (agent inboxes, which it then reaches as well).'),
  }).strict().optional().describe('A key limited to addresses or an inbox: what it reaches. A workspace key stays a workspace key, and a key for addresses or an inbox stays one of those two.'),
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
  createdAt: isoTime(key.createdAt)!, lastUsedAt: isoTime(key.lastUsedAt), revokedAt: isoTime(key.revokedAt), access: workspaceAccess, expiresAt: isoTime(key.expiresAt) });
/** expiresAt as asked: unchanged (undefined), never (null), or a time to come. Ending a key now is revoking it. */
export function askedExpiry(value: string | null | undefined, field = 'expiresAt') {
  if (value == null) return value;
  if (Date.parse(value) <= Date.now()) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a time to come, or null so the key never expires. To end a key now, revoke it.', field);
  return new Date(value).toISOString();
}
/**
 * An agent's change to when a key ends. Over MCP (a person's sign-in, or a key an approval made) an end only moves later
 * up to that approval's end, and is never removed: only a person in the dashboard makes a key permanent or extends it
 * further, so an agent can't hand a lasting key more time than it has itself. Adding or shortening an end only narrows.
 * A key an approval created is exempt: it ends with that approval anyway (approval-ties.ts).
 */
export async function agentExpiryRefusal(tx: DbExecutor, a: Actor, kind: 'api_key' | 'key', keyId: string, before: string | null, after: string | null) {
  if (!a.grantId || before === null || after !== null && Date.parse(after) <= Date.parse(before)) return;
  const { rows: [tie] } = await tx.execute(sql`SELECT 1 FROM mail_grant_objects WHERE workspace_id = ${a.workspaceId} AND kind = ${kind} AND resource = ${keyId}`);
  if (tie) return;
  const { rows: [grant] } = await tx.execute<{ ends: string }>(sql`SELECT nightmail_approval_ends(g)::text AS ends FROM nightmail_resource_grants g WHERE g.grant_key = ${a.grantId}`);
  if (after !== null && grant && Date.parse(after) <= Date.parse(grant.ends)) return;
  throw denied('PERMISSION_DENIED', after === null
    ? 'An agent can\'t make a key that ends never expire. A person makes that change in the dashboard (API keys → Edit).'
    : `An agent moves a key's expiry only up to its own approval's end${grant ? ` (${new Date(grant.ends).toISOString()})` : ''}. A person extends it further in the dashboard (API keys → Edit).`,
  { permission: 'configuration', level: 'write', credential: 'notDelegated' }, 'expiresAt');
}
// Keys limited to addresses or an inbox live in mailbox_keys (address-keys.ts); loaded only when a request names one.
const addressKeys = () => wrapModuleLoad(() => import('./address-keys.js'));
export const inactiveKey = () => new ApiError(409, 'KEY_INACTIVE', 'This key was revoked or has ended, so it can\'t be changed. Create a new key instead.');
/**
 * updateApiKey's rule for an API key an MCP approval created, editing as the caller: it changes only keys that same
 * approval created. A person's own MCP sign-in has no such limit: an agent signed in as a person changes any key that
 * person could change in the dashboard, with their role there (checked again as the change is written, holdKeyAdmin).
 * An edit never moves a key's tie either way: a key an approval created still ends with that approval, and a key the
 * editing approval didn't create doesn't become tied to it.
 */
export async function approvalMadeKey(tx: DbExecutor, a: Actor, kind: 'api_key' | 'key', keyId: string) {
  if (!a.grantId || a.credential !== 'apiKey') return;
  const { rows } = await tx.execute(sql`SELECT 1 FROM mail_grant_objects WHERE grant_id = ${a.grantId} AND workspace_id = ${a.workspaceId} AND kind = ${kind} AND resource = ${keyId}`);
  if (!rows.length) throw denied('PERMISSION_DENIED', 'A key an MCP approval created changes only the keys that approval created. Change this key in the dashboard, over MCP as yourself, or with a key that has manage permission.', { permission: 'configuration', level: 'write', credential: 'notDelegated' });
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
    const { getMcpGrantActor, approvalUse } = await wrapModuleLoad(() => import('./mcp-auth.js'));
    const grant = await getMcpGrantActor(c.env, 'mcp_' + a.grantId, a.workspaceId, tx, approvalUse(a));
    if (grant?.workspaceId !== a.workspaceId || !grant.permissions.includes('manage') || receiving && !grant.receivingConsent) throw changed('The MCP approval behind this request');
  } else if (a.credential === 'dashboard') {
    const { rows: [member] } = await tx.execute<{ role: string }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${a.workspaceId} AND user_id = ${a.keyId.slice('user_'.length)} FOR SHARE`);
    if (member?.role !== 'owner' && member?.role !== 'admin') throw denied('PERMISSION_DENIED', 'Key administration requires a workspace owner or admin.', { permission: 'configuration', level: 'write', person: 'admin' });
  }
  const caller = a.credential === 'apiKey' ? a.keyId : null;
  let row: T | undefined;
  for (const id of [caller, target?.id].filter((x): x is string => !!x).sort()) {
    if (id !== caller) { row = await target!.lock(); continue; }
    const { rows: [now] } = await tx.execute<Pick<Actor, 'permissions' | 'domains'>>(sql`SELECT permissions, domains FROM api_keys
      WHERE id = ${id} AND workspace_id = ${a.workspaceId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR SHARE`);
    if (!now) throw changed('The API key behind this request');
    const refusal = keyAdminRefusal({ ...a, ...now });
    if (refusal) throw refusal;
  }
  return row;
}
const keySummary = (k: Pick<typeof apiKeys.$inferSelect, 'name' | 'permissions' | 'domains' | 'expiresAt'>) => ({ name: k.name, permissions: k.permissions, domains: k.domains, expiresAt: isoTime(k.expiresAt) });
/** The sender domains an update leaves a workspace key: replaced, or some added and removed. [] is every domain, so
 *  removing a key's last domain, or any from a key for every domain, is refused rather than widening it to all. */
function nextDomains(current: string[], input: Pick<z.infer<typeof KeyUpdate>, 'domains' | 'addDomains' | 'removeDomains'>) {
  const add = input.addDomains ?? [], remove = input.removeDomains ?? [];
  if (input.domains && (add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'Replace the domains with domains, or add and remove some; not both.', 'domains');
  if (add.some(d => remove.includes(d))) throw new ApiError(422, 'VALIDATION_FAILED', 'A domain can\'t be both added and removed.', 'removeDomains');
  if (input.domains) return [...new Set(input.domains)];
  if (!current.length) {
    if (remove.length) throw new ApiError(422, 'DOMAIN_SCOPE_REQUIRED', 'This key sends from every domain. Set domains to the ones it keeps.', 'removeDomains');
    return current;
  }
  const next = [...new Set([...current, ...add])].filter(d => !remove.includes(d));
  if (!next.length) throw new ApiError(422, 'DOMAIN_SCOPE_REQUIRED', 'Removing its last domain would let this key send from every domain. Keep one, or set domains: [] for all of them.', 'removeDomains');
  if (next.length > 50) throw new ApiError(422, 'VALIDATION_FAILED', 'A key is limited to at most 50 domains. Use a key for all domains instead.', 'addDomains');
  return next;
}
/** A workspace key's name, permissions, sender domains and expiry, in place. Requests and queued mail use the new ones at
 *  once: both read the key's row when they authenticate and when the mail is dispatched. An expired key can be given a
 *  later expiry; a revoked one can't change. */
async function updateWorkspaceKey(tx: DbExecutor, c: Ctx, a: Actor, keyId: string, input: z.infer<typeof KeyUpdate>) {
  if (input.access) throw new ApiError(422, 'VALIDATION_FAILED', 'A workspace key takes permissions, domains and expiresAt; access is for a key limited to addresses or an inbox, and a workspace key stays one.', 'access');
  const row = await holdKeyAdmin(tx, c, false, { id: keyId, lock: async () => (await tx.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, a.workspaceId), eq(apiKeys.id, keyId))).for('update'))[0] });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
  if (row.revokedAt) throw inactiveKey();
  await approvalMadeKey(tx, a, 'api_key', row.id);
  const asked = askedExpiry(input.expiresAt), expiresAt = asked === undefined ? isoTime(row.expiresAt) : asked;
  const next = { name: input.name ?? row.name, permissions: input.permissions ? [...new Set(input.permissions)] : row.permissions, domains: nextDomains(row.domains, input), expiresAt };
  if (JSON.stringify(keySummary(next)) === JSON.stringify(keySummary(row))) return row;
  await agentExpiryRefusal(tx, a, 'api_key', row.id, isoTime(row.expiresAt), expiresAt);
  const [updated] = await tx.update(apiKeys).set(next).where(eq(apiKeys.id, row.id)).returning();
  await recordAudit(tx, c, { action: 'api_key.update', workspaceId: a.workspaceId, target: { type: 'api_key', id: row.id }, before: keySummary(row), after: keySummary(next) });
  return updated!;
}
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'A short-lived, nonrefreshable token for temporary scripts. Requires an MCP approval and never exceeds it. A manage token makes no change that outlasts it: no API keys, webhooks, endpoints, routes, rules, mail client passwords or inbox connections.', request: { body: json(z.object({
    permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).refine(value => value[0] === 'read' && new Set(value).size === value.length, 'Start with read and do not repeat permissions.'),
    expiresInSeconds: z.number().int().min(30).max(86400), domains: SenderDomains.default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.includes('manage') ? 'manage' : input.permissions.includes('send') ? 'send' : 'read');
    const refusal = agentTokenMintRefusal(identity);
    if (refusal) throw refusal;
    const missing = input.permissions.find(permission => !identity.permissions.includes('manage') && !identity.permissions.includes(permission));
    if (missing) throw denied('PERMISSION_DENIED', 'The MCP approval does not include every requested permission.', requiredOf(c, missing));
    const outside = input.domains.find(domain => !senderDomainAllowed(identity.domains, domain));
    if (identity.domains.length && (!input.domains.length || outside)) throw denied('SENDER_DOMAIN_FORBIDDEN', 'The temporary token must remain restricted to the approved sender domains or their subdomains.', { permission: 'sendEmail', level: 'on', scope: outside ? `domain:${outside}` : 'workspace' }, 'domains');
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
    description: 'One key type with permissions. By default a workspace key (permissions, optional sender domains). With access, a key limited to receiving addresses or to one agent inbox (bearer nm_mbx_…): it reads and, with send, replies only there, and never reaches the rest of the workspace. expiresAt ends it at a chosen time. The secret is returned once; everything else about the key changes later on the same secret (updateApiKey). A key created over MCP, or with a key that was, is tied to that approval: approval and nextStep in the result say until when.',
    request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string(), nextStep: z.string().optional().describe('Only for a key tied to an MCP approval: what it depends on and how to make a lasting one.') })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json'), access = input.access ?? { type: 'workspace' as const };
    // Read after the key's transaction commits: the tie it recorded, with the approval's current end.
    const tied = async (keyId: string) => {
      const approval = auth.grantId ? await approvalTie(c.env, auth.workspaceId, ['api_key', 'key'], keyId) : null;
      return approval ? { approval, nextStep: tiedNextStep('key', approval) } : { approval };
    };
    if (access.type !== 'workspace') {
      if (input.permissions || input.domains?.length) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', input.permissions ? 'permissions' : 'domains');
      const { createLimitedKey, limitedKeyView } = await addressKeys();
      const { row, secret } = await createLimitedKey(c, auth.workspaceId, input.name, access, { addresses: 'access.addressIds', inbox: 'access.inboxId', mail: 'access.mail' }, askedExpiry(input.expiresAt));
      return c.json({ ...limitedKeyView(row), ...await tied(row.id), lastChange: await lastChange(c, auth.workspaceId, row.id), secret }, 201);
    }
    const permissions = input.permissions ?? ['send'], domains = input.domains ?? [], expiresAt = askedExpiry(input.expiresAt) ?? null;
    const secret = randomSecret(secretPrefixes.apiKey);
    const [key] = await c.env.db.transaction(async tx => {
      await holdKeyAdmin(tx, c, false);
      const rows = await tx.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, name: input.name, permissions, domains, expiresAt, hash: await digest(secret), prefix: shownPrefix(secret) }).returning();
      // A key created by an MCP agent lives only as long as the approval that created it.
      if (auth.grantId) await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${auth.grantId},${auth.workspaceId},'api_key',${rows[0]!.id})`);
      await recordAudit(tx, c, { action: 'api_key.create', workspaceId: auth.workspaceId, target: { type: 'api_key', id: rows[0]!.id },
        after: { name: input.name, permissions, domains, expiresAt: expiresAt ?? undefined, prefix: rows[0]!.prefix.slice(0, 9), mcpGrant: auth.grantId ?? undefined } });
      return rows;
    });
    return c.json({ ...keyView(key!), ...await tied(key!.id), lastChange: await lastChange(c, auth.workspaceId, key!.id), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, description: 'Every API key in the workspace, ordered by ID: workspace keys and keys limited to addresses or an inbox, each with its latest change (lastChange). includeRevoked=false also leaves out expired keys, and keys whose inbox was deleted or whose lease ended.',
    request: { query: PageQuery.extend({ includeRevoked: z.enum(['true', 'false']).default('true') }) }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query'), w = auth.workspaceId, active = q.includeRevoked === 'false', after = q.cursor ? sql`AND id > ${q.cursor}` : sql``;
    // One cursor over both tables. A limited key has no workspace permissions or domains: its access says what it may do.
    const { rows } = await c.env.db.execute<{ id: string; name: string; prefix: string; permissions: ('read' | 'send' | 'manage')[]; domains: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null;
      expires_at: string | null; address_ids: string[] | null; inbox_id: string | null; mail: ('read' | 'send' | 'modify' | 'create')[]; created_inbox_ids: string[]; limited: boolean }>(sql`
      SELECT * FROM (SELECT id, name, prefix, permissions, domains, created_at::text, last_used_at::text, revoked_at::text, expires_at::text, NULL::jsonb AS address_ids, NULL::text AS inbox_id, '[]'::jsonb AS mail, '[]'::jsonb AS created_inbox_ids, false AS limited
          FROM api_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` : sql``} ${after}
        UNION ALL SELECT id, name, prefix, '[]'::jsonb, '[]'::jsonb, created_at::text, last_used_at::text, revoked_at::text, expires_at::text, mailbox_ids, inbox_id, permissions,
            CASE WHEN permissions ? 'create' THEN ${createdInboxes(sql`mailbox_keys.workspace_id`, sql`mailbox_keys.id`)} ELSE '[]'::jsonb END, true
          FROM mailbox_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` : sql``} ${after}) k
      ORDER BY id LIMIT ${q.limit + 1}`);
    const shown = rows.slice(0, q.limit), ids = shown.map(r => r.id), [ties, changes] = await Promise.all([approvalTies(c.env, w, ['api_key', 'key'], ids), lastChanges(c.env.db, w, ids)]);
    const data = shown.map(r => ({ id: r.id, name: r.name, permissions: r.permissions, domains: r.domains, prefix: r.prefix,
      createdAt: isoTime(r.created_at)!, lastUsedAt: isoTime(r.last_used_at), revokedAt: isoTime(r.revoked_at), expiresAt: isoTime(r.expires_at),
      access: r.limited ? { type: r.inbox_id ? 'inbox' as const : 'addresses' as const, addressIds: r.address_ids, inboxId: r.inbox_id, mail: r.mail, createdInboxIds: r.created_inbox_ids } : workspaceAccess,
      approval: ties.get(r.id) ?? null, lastChange: changes.get(r.id) ?? null }));
    return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys/{id}/changes', operationId: 'listApiKeyChanges', tags: ['ApiKeys'], security,
    description: 'One API key\'s history, newest first: when it was created, each change with who made it and what it was before and after (name, permissions, domains, addresses, mail, expiry), and its revocation. Secrets are never recorded. Kept for a year; the workspace\'s Activity lists the same entries.',
    request: { params: IdParams, query: z.object({ cursor: z.string().max(200).optional().describe('nextCursor from the previous page.'), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(AuditEntry), nextCursor: z.string().nullable().describe('Pass as cursor for older entries; null at the end.') }).openapi('ApiKeyChangePage')), ...errors } }), async c => {
    const auth = manageKeys(c), keyId = c.req.valid('param').id, q = c.req.valid('query');
    const { rows: [key] } = await c.env.db.execute(keyId.startsWith('mbk_') ? sql`SELECT FROM mailbox_keys WHERE workspace_id = ${auth.workspaceId} AND id = ${keyId}` : sql`SELECT FROM api_keys WHERE workspace_id = ${auth.workspaceId} AND id = ${keyId}`);
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json(await keyTrail(c.env.db, auth.workspaceId, keyId, q), 200);
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
    description: 'Changes anything about a key and keeps its secret, so nothing has to be redeployed: name and expiresAt on any key; a workspace key\'s permissions and sender domains (replace them with domains, or addDomains and removeDomains); a key for addresses or an inbox\'s access: its addresses (addressIds, addAddressIds, removeAddressIds), its mail (create included), its inbox (inboxId), or access.type to make an inbox key a key for addresses or back. A workspace key stays a workspace key. Takes effect from the next request: requests already waiting lose what was removed, and mail the key queued is sent only within its new access. Each change is recorded with who made it, before and after (lastChange, listApiKeyChanges, Activity). Needs the access createApiKey needs, checked again as the change is written, and no key changes itself. An agent signed in over MCP as a person changes any key that person could change in the dashboard; a key an MCP approval created changes only keys that approval created; temporary agent tokens change none. Revoked keys and keys whose inbox ended can\'t be changed; an expired key can be given a later expiry.',
    request: { params: IdParams, headers: IdempotencyHeaders, body: json(KeyUpdate) }, responses: { 200: response(KeySchema), ...errors } }), async c => {
    const auth = manageKeys(c), keyId = c.req.valid('param').id, input = c.req.valid('json');
    if (input.name === undefined && !input.permissions && !input.domains && !input.addDomains && !input.removeDomains && input.expiresAt === undefined && !input.access) throw new ApiError(422, 'VALIDATION_FAILED', 'Change at least one of name, expiresAt, permissions, domains, addDomains, removeDomains or access.');
    // What a key may do is another administrator's decision, never its own.
    if (auth.keyId === keyId) throw denied('PERMISSION_DENIED', 'A key can\'t change itself. Change it in the dashboard or with another key that has manage permission.', { permission: 'configuration', level: 'write', person: 'admin' });
    const limited = keyId.startsWith('mbk_') ? await addressKeys() : null;
    const view = await idempotent(c.env.db, { ...idempotentRequest(c), workspaceId: auth.workspaceId, actorKeyId: auth.keyId }, input,
      async tx => limited ? limited.updateLimitedKey(tx, c, auth, keyId, input) : keyView(await updateWorkspaceKey(tx, c, auth, keyId, input)));
    return c.json({ ...view, approval: await approvalTie(c.env, auth.workspaceId, ['api_key', 'key'], keyId), lastChange: await lastChange(c, auth.workspaceId, keyId) }, 200);
  });
}
const lastChange = async (c: Ctx, w: string, keyId: string) => (await lastChanges(c.env.db, w, [keyId])).get(keyId) ?? null;
