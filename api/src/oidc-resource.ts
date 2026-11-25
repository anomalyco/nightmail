import * as oauth from 'oauth4webapi';
import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import { digest, log, type Actor, type Runtime, type DbExecutor, type Permission } from './core.js';
import { oauthScopePrefixes, productName, requestedScopes } from './brand.js';
import { acceptedMethods } from './account-policy.js';

const permissions: Permission[] = ['read', 'send', 'manage'];
const descriptions: Record<Permission, string> = { read: 'Read workspace data.', send: 'Send email from the workspace.', manage: 'Manage workspace mail and resources.' };
/**
 * The /mcp resource a request reached: PUBLIC_URL's, or an earlier origin's this installation still serves
 * (PREVIOUS_PUBLIC_URLS). A token stays tied to the resource it was minted for, so a grant made on the earlier origin
 * keeps refreshing there; it is never checked against the new one. Remove after rename cleanup.
 */
const audience = (runtime: Runtime, url?: string) => {
  const origin = url === undefined ? null : new URL(url).origin;
  return new URL('/mcp', origin && runtime.config.previousOrigins?.includes(origin) ? origin : runtime.config.publicUrl).href;
};
export function protectedResourceMetadata(runtime: Runtime, url?: string) {
  // Only the scopes this installation asks for (OAUTH_SCOPE_PREFIX): MCP clients request every listed scope (Claude Code's
  // `mcp login` does), and the consent screen showed each permission twice while bane:* was listed too. Tokens with either
  // prefix still work (authorizeResource). An earlier origin keeps both sets: its grants were made with bane:*, and the
  // account service checks a grant's scopes against this list whenever it refreshes. bane: remove after rename cleanup.
  const resource = audience(runtime, url), scopes = requestedScopes(runtime.config);
  const published = resource === audience(runtime) ? scopes
    : [...scopes, ...oauthScopePrefixes.filter(prefix => !scopes[0]!.startsWith(`${prefix}:`)).flatMap(prefix => permissions.map(p => `${prefix}:${p}`))];
  return { resource, resource_name:productName, authorization_servers: [runtime.config.accountIssuer],
    scopes_supported: published, bearer_methods_supported: ['header'],
    // Provisional extension name until the issuer publishes its metadata contract.
    scope_descriptions:Object.fromEntries(published.map(scope => [scope, descriptions[scope.split(':')[1] as Permission]])) };
}

// Cache only completed public metadata and last-known-good JWKS. Each Worker request owns its fetches.
const AUTHORITY_TTL_MS = 300_000;
const AUTHORITY_STALE_TTL_MS = 24 * 3600_000;
const AUTHORITY_RETRY_MS = 30_000;
class IssuerUnavailableError extends Error {
  constructor() { super('OIDC issuer is temporarily unavailable.'); this.name = 'IssuerUnavailableError'; }
}
type CachedAuthority = {
  metadata: oauth.AuthorizationServer;
  expires: number;
  fetchedAt: number;
  lastFallbackLog?: number;
  jwks?: { body: string; contentType: string; fetchedAt: number };
};
const authorities = new Map<string, CachedAuthority>();
const isTransientHttp = (status: number) => status === 429 || status >= 500;
async function authority(issuer: string): Promise<CachedAuthority> {
  const now = Date.now();
  const cached = authorities.get(issuer);
  if (cached && cached.expires > now) return cached;
  const url = new URL(issuer);
  let transient = false;
  try {
    const response = await oauth.discoveryRequest(url, { signal: AbortSignal.timeout(5000) });
    if (isTransientHttp(response.status)) { await response.body?.cancel().catch(() => {}); transient = true; throw new IssuerUnavailableError(); }
    const metadata = await oauth.processDiscoveryResponse(url, response);
    if (!metadata.jwks_uri || new URL(metadata.jwks_uri).protocol !== 'https:') throw Error('Issuer has no HTTPS JWKS');
    if (authorities.size >= 16 && !authorities.has(issuer)) authorities.clear();
    const entry: CachedAuthority = { metadata, expires: now + AUTHORITY_TTL_MS, fetchedAt: now, jwks: cached?.metadata.jwks_uri === metadata.jwks_uri ? cached.jwks : undefined };
    authorities.set(issuer, entry);
    return entry;
  } catch (error) {
    const unavailable = transient || error instanceof IssuerUnavailableError || !(error instanceof oauth.OperationProcessingError || error instanceof oauth.ResponseBodyError);
    if (unavailable && cached && now - cached.fetchedAt < AUTHORITY_STALE_TTL_MS) {
      cached.expires = now + AUTHORITY_RETRY_MS;
      if (!cached.lastFallbackLog || now - cached.lastFallbackLog >= 60_000) {
        cached.lastFallbackLog = now;
        log('warn', { code: 'OIDC_DISCOVERY_STALE_FALLBACK', ageSeconds: Math.round((now - cached.fetchedAt) / 1000) });
      }
      return cached;
    }
    if (unavailable) throw new IssuerUnavailableError();
    throw error;
  }
}

// At most 40 characters of letters, digits, spaces and . _ - ( ), trimmed; anything else (or nothing left) is no label.
export function profileLabel(value: string | null) {
  const label = value?.normalize('NFKC').replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(label ?? '').slice(0, 40).join('').trim() || null;
}

// What a role may do: owners and admins everything, members read and send. A call acts with the approval's scopes
// intersected with this, in the workspace it names.
const rolePermissions = (role: string): Permission[] => role === 'owner' || role === 'admin' ? permissions : ['read', 'send'];

/**
 * What an approval is checked for. `request`: a request its access token carries, a call by its agent token, or a write
 * that holds it; the newest access token must not have expired. `lasting`: something it made (a key, a webhook, an
 * endpoint, a route, a rule, queued mail) being used; the approval itself must be active (nightmail_approval_active,
 * migration 341), however long ago its agent last connected.
 */
export type ApprovalUse = 'request' | 'lasting';
/** A request made with a key the approval created uses what it made; one carried by its sign-in or agent token does not. */
export const approvalUse = (a: Pick<Actor, 'credential'>): ApprovalUse => a.credential === 'apiKey' ? 'lasting' : 'request';

/**
 * An MCP approval (one per account and client, as the account service's tokens name them) acting in one workspace,
 * or null. The approval is not revoked and, by `use`, its token unexpired or the approval active; the person who made it
 * still belongs to the workspace (and, self-hosted, is an allowlisted owner or admin); it acts with its scopes
 * intersected with their role there. Receiving tools need an owner or admin (receivingConsent), and changing them the
 * manage scope as well, as every write does. Checked on every MCP tool call, and whenever a credential or object the
 * approval created is used in that workspace.
 */
export async function externalMcpGrant(runtime: Runtime, keyId: string, workspace: string | { agentTokenId: string }, db: DbExecutor = runtime.db, use: ApprovalUse = 'request'): Promise<Actor | null> {
  const workspaceId = typeof workspace === 'string' ? sql`${workspace}`
    : sql`(SELECT workspace_id FROM agent_tokens WHERE id = ${workspace.agentTokenId} AND grant_id = ${keyId})`;
  // Expiry is judged on the locked row against the wall clock (clock_timestamp()), after the lock: now() is the start of
  // the caller's transaction, so a write that waited inside it would still accept an approval that expired meanwhile.
  const { rows: [grant] } = await db.execute<{role: string; permissions: Permission[]; user_id: string; workspace_id: string}>(sql`
    WITH locked AS MATERIALIZED (SELECT m.workspace_id, m.role, g.permissions, i.user_id, g.expires_at, nightmail_approval_active(g) AS active FROM nightmail_resource_grants g
    JOIN nightmail_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN nightmail_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.workspace_id = ${workspaceId} AND m.user_id = i.user_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND NOT g.revoked
      AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject)) FOR SHARE OF g, i, m, u)
    SELECT workspace_id, role, permissions, user_id FROM locked WHERE ${use === 'lasting' ? sql`active` : sql`expires_at > clock_timestamp()`}`);
  if (!grant) return null;
  const allowed = grant.permissions.filter(p => rolePermissions(grant.role).includes(p));
  return allowed.length ? { keyId, grantId: keyId.slice(4), userId: grant.user_id, receivingConsent: grant.role !== 'member', workspaceId: grant.workspace_id, role: grant.role, permissions: allowed, domains: [], credential: 'mcp' } : null;
}

export type McpWorkspace = { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member'; permissions: Permission[] };
/** An authenticated MCP connection: its approval and the workspaces it can act in. Each tool call picks one. */
export type McpConnection = {
  keyId: string; userId: string; permissions: Permission[]; workspaces: McpWorkspace[];
  /** The workspace a call without `workspace` acts in, and why: set on this connection, the only one, or the dashboard's last. */
  defaultWorkspace: { id: string; source: 'set' | 'only' | 'last-used' } | null;
  /** Everything the connection could do in some workspace: what its listing shows. Each call is checked again. */
  listing: Actor;
  /** When the access token this request presented expires (epoch ms): nothing the request starts outlives it. */
  tokenExpiresAt?: number;
};
export class WorkspaceChoice extends Error {
  constructor(readonly code: 'WORKSPACE_REQUIRED' | 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_AMBIGUOUS' | 'WORKSPACE_ACCESS_DENIED', message: string) { super(message); }
}
/** The workspace a tool call names (ID, slug or name, as the workspaces tool lists them), else the connection's default. */
export function chooseWorkspace(connection: McpConnection, value: string | undefined) {
  const choices = () => connection.workspaces.map(w => `${w.name} (${w.id})`).join(', ');
  if (value === undefined) {
    if (connection.defaultWorkspace) return connection.defaultWorkspace.id;
    throw new WorkspaceChoice('WORKSPACE_REQUIRED', `Pass workspace (an ID or name) or set a default with setDefaultWorkspace. Your workspaces: ${choices()}.`);
  }
  const exact = connection.workspaces.find(w => w.id === value) ?? connection.workspaces.find(w => w.slug === value);
  if (exact) return exact.id;
  const named = connection.workspaces.filter(w => w.name.toLowerCase() === value.trim().toLowerCase());
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new WorkspaceChoice('WORKSPACE_AMBIGUOUS', `Several of your workspaces are named ${value.slice(0, 120)}: pass its ID. ${choices()}.`);
  // Never says whether a workspace exists that this account doesn't belong to.
  throw new WorkspaceChoice('WORKSPACE_ACCESS_DENIED', `You don't belong to a workspace ${value.slice(0, 120)}. Your workspaces: ${choices()}.`);
}

/** The workspaces an approval's person belongs to, with what this approval (narrowed to the presented token's scopes)
 * may do in each, and its default. */
export async function mcpConnection(runtime: Runtime, keyId: string, scopes: Permission[] = permissions): Promise<McpConnection | null> {
  const { rows } = await runtime.db.execute<{ user_id: string; permissions: Permission[]; chosen: string | null; last_used: string | null; id: string | null; name: string | null; slug: string | null; role: McpWorkspace['role'] | null }>(sql`
    SELECT g.user_id, g.permissions, g.workspace_id AS chosen, u.selected_workspace_id AS last_used, w.id, w.name, w.slug, m.role
    FROM nightmail_resource_grants g JOIN nightmail_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN nightmail_users u ON u.id = i.user_id
    LEFT JOIN workspace_members m ON m.user_id = i.user_id AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject))
    LEFT JOIN workspaces w ON w.id = m.workspace_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND NOT g.revoked AND g.expires_at > now()
    ORDER BY w.name, w.id`);
  const first = rows[0];
  if (!first) return null;
  const granted = first.permissions.filter(p => scopes.includes(p));
  const workspaces = rows.flatMap(r => r.id && r.role ? [{ id: r.id, name: r.name!, slug: r.slug!, role: r.role, permissions: granted.filter(p => rolePermissions(r.role!).includes(p)) }] : [])
    .filter(w => w.permissions.length);
  const member = (id: string | null) => !!id && workspaces.some(w => w.id === id);
  const defaultWorkspace = member(first.chosen) ? { id: first.chosen!, source: 'set' as const } : workspaces.length === 1 ? { id: workspaces[0]!.id, source: 'only' as const }
    : member(first.last_used) ? { id: first.last_used!, source: 'last-used' as const } : null;
  const best = workspaces.find(w => w.role !== 'member') ?? workspaces[0];
  const listingPermissions = [...new Set(workspaces.flatMap(w => w.permissions))];
  const listing: Actor = { keyId, grantId: keyId.slice(4), workspaceId: defaultWorkspace?.id ?? best?.id ?? '', role: best?.role ?? 'member', permissions: permissions.filter(p => listingPermissions.includes(p)),
    receivingConsent: workspaces.some(w => w.role !== 'member'), domains: [], credential: 'mcp' };
  return { keyId, userId: first.user_id, permissions: granted, workspaces, defaultWorkspace, listing };
}

/** Sets the workspace a connection's calls use when they name none. Only one of the person's own. */
export async function setDefaultWorkspace(runtime: Runtime, keyId: string, workspaceId: string) {
  await runtime.db.execute(sql`UPDATE nightmail_resource_grants SET workspace_id=${workspaceId}, updated_at=now() WHERE id=${keyId} AND NOT revoked`);
}

/** The JWT's audience when it names this resource: /mcp on this origin, with any query (OpenCode sends the URL it was
 * configured with, such as /mcp?codemode=true, as the resource). The signature and the rest are checked as usual. */
function expectedAudience(resource: string, token: string) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { aud?: unknown };
    const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
    if (typeof aud !== 'string' || aud.includes('#')) return resource;
    const url = new URL(aud);
    return `${url.origin}${url.pathname}` === resource && !url.username && !url.password ? aud : resource;
  } catch { return resource; }
}

export async function authorizeResource(runtime: Runtime, request: Request, handler: (connection: McpConnection) => Promise<Response>) {
  const resource = audience(runtime, request.url);
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', resource).href;
  // MCP clients expect a JSON-RPC envelope; the challenge itself lives in WWW-Authenticate (RFC 6750, RFC 9470). The
  // scope is every Nightmail scope: clients ask for what the challenge names, and the person narrows it when approving.
  // `detail` replaces only the JSON-RPC message; the challenge header keeps its fixed description.
  function denied(status: 401 | 403, error = status === 401 ? 'invalid_token' : 'insufficient_scope', extra = '', detail?: string) {
    const scheme = /^dpop /i.test(request.headers.get('authorization') ?? '') ? 'DPoP' : 'Bearer';
    const methods = acceptedMethods(runtime.config.accountRequiredAcr);
    const message = error === 'insufficient_user_authentication' ? methods ? `${productName} requires ${methods} sign-in. Reconnect this MCP client and choose ${methods} at Anomaly account.` : 'Reconnect this MCP client using the sign-in method this installation requires.'
      : status === 401 ? 'Reconnect and authorize this MCP client at the account service.' : `This client has no active ${productName} approval for the requested access.`;
    return Response.json({jsonrpc:'2.0', error:{code:-32000, message:detail ?? message}, id:null}, {status, headers: { 'cache-control':'no-store', 'www-authenticate':`${scheme} error="${error}", error_description="${detail ?? message}", resource_metadata="${metadata}", scope="${requestedScopes(runtime.config).join(' ')}"${extra}` }});
  }
  const auth = request.headers.get('authorization');
  if (!auth || auth.length > 16384 || (request.headers.get('dpop')?.length ?? 0) > 8192) return denied(401);
  let claims: oauth.JWTAccessTokenClaims;
  let issuerUnavailable = false;
  try {
    const entry = await authority(runtime.config.accountIssuer!);
    const jwksFetch: typeof fetch = async (input, init) => {
      const now = Date.now();
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const isJwks = target === entry.metadata.jwks_uri;
      const fallback = () => {
        if (isJwks && entry.jwks && now - entry.jwks.fetchedAt < AUTHORITY_STALE_TTL_MS) {
          if (!entry.lastFallbackLog || now - entry.lastFallbackLog >= 60_000) {
            entry.lastFallbackLog = now;
            log('warn', { code: 'OIDC_JWKS_STALE_FALLBACK', ageSeconds: Math.round((now - entry.jwks.fetchedAt) / 1000) });
          }
          return new Response(entry.jwks.body, { status: 200, headers: { 'content-type': entry.jwks.contentType } });
        }
        return null;
      };
      let response: Response;
      try { response = await fetch(input, init); }
      catch (error) {
        const stale = fallback();
        if (stale) return stale;
        issuerUnavailable = true;
        throw error;
      }
      if (isTransientHttp(response.status)) {
        await response.body?.cancel().catch(() => {});
        const stale = fallback();
        if (stale) return stale;
        issuerUnavailable = true;
        throw new IssuerUnavailableError();
      }
      if (isJwks && response.ok) {
        const body = await response.text();
        const contentType = response.headers.get('content-type') ?? 'application/jwk-set+json';
        entry.jwks = { body, contentType, fetchedAt: now };
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    };
    // The audience is this resource; htm and htu must match the actual HTTP request.
    claims = await oauth.validateJwtAccessToken(entry.metadata, request, expectedAudience(resource, auth.replace(/^(?:Bearer|DPoP)\s+/i, '')),
      { signingAlgorithms: ['ES256','RS256'], [oauth.clockTolerance]: 0, signal: AbortSignal.timeout(5000), [oauth.customFetch]: jwksFetch });
  } catch (error) {
    if (issuerUnavailable || error instanceof IssuerUnavailableError) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Authentication service is temporarily unavailable. Retry shortly.' }, id: null },
        { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '30' } },
      );
    }
    return denied(401);
  }
  // A token minted in the future would also block every later token from updating the approval.
  if (typeof claims.iat !== 'number' || claims.iat > Date.now() / 1000 + 30) return denied(401);
  // The dashboard's sign-in requirement applies to every access token, refreshed ones included:
  // the issuer copies the authentication context of the original sign-in into each token it mints.
  const requiredAcr = runtime.config.accountRequiredAcr;
  if (requiredAcr && (typeof claims.acr !== 'string' || !requiredAcr.includes(claims.acr))) {
    log('warn', { code: 'MCP_ACR_REFUSED', client: String(claims.client_id).slice(0, 200), acr: typeof claims.acr === 'string' ? claims.acr.slice(0, 100) : null });
    return denied(401, 'insufficient_user_authentication', `, acr_values="${requiredAcr.join(' ')}"`);
  }
  const scopes = new Set(typeof claims.scope === 'string' ? claims.scope.split(' ') : []);
  const allowed = permissions.filter(p => oauthScopePrefixes.some(prefix => scopes.has(`${prefix}:${p}`)));
  if (!allowed.length) return denied(403);
  const proof = request.headers.get('dpop');
  if (proof) {
    const {jti} = JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as {jti:string};
    const replay = await digest(JSON.stringify([claims.iss, claims.cnf, jti]));
    const inserted = await runtime.db.execute(sql`INSERT INTO nightmail_dpop_proofs(id, expires_at) VALUES (${replay}, now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING id`);
    if (!inserted.rowCount) return denied(401);
  }
  const identity = await runtime.db.execute<{user_id:string}>(sql`SELECT user_id FROM nightmail_oidc_identities WHERE issuer=${claims.iss} AND subject=${claims.sub}`);
  const userId=identity.rows[0]?.user_id;
  if (!userId) return denied(403);
  // One approval per account and client: the same client used by two accounts (a personal and a work entry) gets two.
  // The account service's consent behind this token: its access tokens' jti is <consent>.<random>.
  const consent = typeof claims.jti === 'string' ? /^([A-Za-z0-9_-]{8,200})\.[A-Za-z0-9_-]{8,200}$/.exec(claims.jti)?.[1] ?? null : null;
  // Account copies the original sign-in's auth_time into every token of the family. It is a lower bound on
  // when consent was given; access-token iat advances on refresh and cannot establish that.
  const authTime = consent && typeof claims.auth_time === 'number' && Number.isSafeInteger(claims.auth_time)
    && claims.auth_time > 0 && claims.auth_time <= Math.min(claims.iat, Date.now()/1000) ? claims.auth_time : 0;
  // A revoked row's updated_at is the cutoff. Carry it in the revocation history on reconnect, before later
  // activity can overwrite updated_at. '@' cannot start an issuer grant ID. For rows already reconnected by an
  // older build, created_at is the time of that reconnect: a conservative cutoff when the revoke time is lost.
  // A row an older build already reconnected keeps working with the consent it reconnected with (issuer_grant): that
  // build accepted it after the revocation, and refusing it would sign out every such connection at deploy. Any other
  // consent needs a sign-in after the reconnect.
  const eligible = sql`NOT coalesce(${consent}::text=ANY(g.revoked_issuer_grants), false) AND (${authTime}::bigint > CASE
    WHEN g.revoked THEN floor(extract(epoch FROM g.updated_at))
    WHEN starts_with(g.revoked_issuer_grants[1], '@') THEN substr(g.revoked_issuer_grants[1], 2)::bigint
    WHEN cardinality(g.revoked_issuer_grants)>0 THEN floor(extract(epoch FROM g.created_at)) ELSE -1 END
    OR (NOT g.revoked AND cardinality(g.revoked_issuer_grants)>0 AND NOT starts_with(g.revoked_issuer_grants[1], '@') AND ${consent}::text=g.issuer_grant))`;
  // `?profile=` on the MCP URL is only a label for that entry, shown in Nightmail; it never selects or authorizes anything.
  const profile = profileLabel(new URL(request.url).searchParams.get('profile'));
  // Revoked in Nightmail, an approval refuses the tokens of the consents it had. A token of a new consent (the person
  // connected the client again at the account service) starts it again under a new key, so nothing tied to the revoked
  // one comes back: its credentials, objects, rule parts and scheduled mail stay ended. (Clients with a fixed
  // client_id, such as OpenCode's metadata document, could otherwise never reconnect that account.)
  if (authTime) await runtime.db.execute(sql`UPDATE nightmail_resource_grants AS g SET id=${'mcp_at_' + await digest(JSON.stringify([userId, claims.client_id, consent]))},
      revoked=false, issuer_grant=${consent}, issuer_grant_seen_at=now(), permissions=${sql.param(allowed)}::text[], expires_at=to_timestamp(${claims.exp}), issued_at=${claims.iat},
      revoked_issuer_grants=array_prepend('@' || floor(extract(epoch FROM updated_at))::bigint::text,
        CASE WHEN starts_with(revoked_issuer_grants[1], '@') THEN revoked_issuer_grants[2:] ELSE revoked_issuer_grants END),
      profile=coalesce(${profile}, profile), created_at=now(), updated_at=now(), issuer=${claims.iss}, subject=${claims.sub}
    WHERE user_id=${userId} AND client_id=${claims.client_id} AND revoked AND ${eligible}`);
  // The approval follows the newest token: its scopes, expiry and consent. It names no workspace: every tool call names
  // one (or uses the connection's default, workspace_id) and is checked against the person's membership and role there.
  // A consent it has not seen before starts its 90 days (issuer_grant_seen_at, nightmail_approval_ends).
  const { rows: [upserted] } = await runtime.db.execute<{created:boolean}>(sql`INSERT INTO nightmail_resource_grants AS g(id,issuer,subject,user_id,client_id,permissions,expires_at,issued_at,profile,issuer_grant)
    VALUES (${'mcp_at_' + await digest(JSON.stringify([userId, claims.client_id]))},${claims.iss},${claims.sub},${userId},${claims.client_id},${sql.param(allowed)}::text[],to_timestamp(${claims.exp}),${claims.iat},${profile},${consent})
    ON CONFLICT(user_id,client_id) DO UPDATE SET permissions=excluded.permissions,expires_at=excluded.expires_at,profile=coalesce(excluded.profile,g.profile),
      issued_at=excluded.issued_at,updated_at=now(),issuer=excluded.issuer,subject=excluded.subject,issuer_grant=coalesce(excluded.issuer_grant,g.issuer_grant),
      issuer_grant_seen_at=CASE WHEN excluded.issuer_grant IS DISTINCT FROM g.issuer_grant AND excluded.issuer_grant IS NOT NULL THEN now() ELSE g.issuer_grant_seen_at END
    WHERE NOT g.revoked AND ${eligible}
      AND (excluded.issued_at>g.issued_at OR (excluded.issued_at=g.issued_at AND
        excluded.permissions=g.permissions AND excluded.expires_at>g.expires_at))
    RETURNING (xmax=0) AS created`);
  if (upserted?.created) log('info', { code: 'MCP_APPROVAL_CREATED', userId, client: String(claims.client_id).slice(0, 200) });
  // The same statement notes when the agent was last used (the API keys page shows it), at most once a minute and
  // never waiting: a row another transaction holds (a revoke, a receiving write) is skipped this time.
  const { rows: [approval] } = await runtime.db.execute<{ id: string; blocked: boolean }>(sql`WITH used AS (UPDATE nightmail_resource_grants SET last_used_at=now()
      WHERE id IN (SELECT id FROM nightmail_resource_grants g WHERE user_id=${userId} AND client_id=${claims.client_id} AND NOT revoked AND ${eligible}
        AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute') FOR NO KEY UPDATE SKIP LOCKED))
    SELECT id, revoked OR NOT (${eligible}) AS blocked
    FROM nightmail_resource_grants g WHERE user_id=${userId} AND client_id=${claims.client_id}`);
  // Revoked in Nightmail: only a sign-in after the revocation reconnects (auth_time). The account service reuses an
  // existing session for a new consent, so its older sign-in stays refused: the message (header too) says what to do.
  if (!approval || approval.blocked) return denied(403, undefined, '', `This connection was revoked in ${productName}. Sign out of Anomaly account (or sign in again there), then reconnect this MCP client.`);
  const keyId = approval.id;
  // The presented token's own scopes: a token older than the approval's newest may carry fewer.
  const connection = await mcpConnection(runtime, keyId, allowed);
  if (!connection) return denied(403);
  if (!connection.workspaces.length) return denied(403, undefined, '', `This account belongs to no ${productName} workspace these scopes can act in. Join or create one in ${productName}, then reconnect.`);
  if (typeof claims.exp === 'number') connection.tokenExpiresAt = claims.exp * 1000;
  return handler(connection);
}
