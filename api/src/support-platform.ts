import type { Config } from './core.js';

// The support platform's door into Nightmail (api/README.md "Support integration"): a Cloudflare service binding to the
// `SupportPlatform` entrypoint (src/worker.ts), not a token. Only a Worker in the same account that declares a binding
// to that entrypoint can call it, so the credential is the deploy configuration itself: it cannot leak, needs no
// rotation, and is revoked by removing the binding or the entrypoint.
//
// It answers exactly what the support Worker needs and nothing else (PR #137 review L2): verify a handoff, register and
// close a support conversation, the /v1/support/* requests stamped with a conversation (request), and the inbox: mirror
// a conversation's transcript and state, and pull and acknowledge the staff replies it delivers. Each call runs through
// the normal routes, so validation, audit rows and budgets are the same as for an operator. Operator paths act as
// `service:bane-support`; /v1/support/* needs a registered conversation that only request() can name: it rides on the
// runtime, never in a header, query parameter or body.

/** What the entrypoint passes to the app as `Runtime.platformCaller`. HTTP requests can never set it. */
export const SUPPORT_PLATFORM_CALLER = 'bane-support';
/** The support Worker's conversation IDs (conv_ and 26 base32 characters). */
export const CONVERSATION_ID = /^conv_[a-z2-7]{26}$/;
/** The runtime fields a binding call runs with: the caller, and for request() its conversation. */
export const platformRuntime = (conversation?: string) => ({ platformCaller: SUPPORT_PLATFORM_CALLER, ...(conversation ? { supportConversation: conversation } : {}) }) as { platformCaller: typeof SUPPORT_PLATFORM_CALLER; supportConversation?: string };

const OPERATOR_ROUTES: [method: string, path: RegExp][] = [
  ['GET', /^\/v1\/operator\/support\/handoffs\/sho_[0-9a-f]{32}$/],
  ['POST', /^\/v1\/operator\/support\/conversations$/],
  ['POST', /^\/v1\/operator\/support\/conversations\/conv_[a-z2-7]{26}\/close$/],
  // The inbox (src/support-inbox.ts): the transcript and state it mirrors, and the staff replies it delivers.
  ['POST', /^\/v1\/operator\/support\/conversations\/conv_[a-z2-7]{26}\/messages$/],
  ['GET', /^\/v1\/operator\/support\/conversations\/conv_[a-z2-7]{26}\/state$/],
  ['POST', /^\/v1\/operator\/support\/conversations\/conv_[a-z2-7]{26}\/state$/],
  ['GET', /^\/v1\/operator\/support\/outbox$/],
  ['POST', /^\/v1\/operator\/support\/conversations\/conv_[a-z2-7]{26}\/messages\/msg_[a-z2-7]{16}\/delivery$/],
];
const SUPPORT_READ = /^\/v1\/support\/[A-Za-z0-9_./-]{1,200}$/;
/** The writes a conversation makes: narrowing its scope to one workspace, and keeping a note about its person. */
const STAMPED_WRITES: [method: string, path: RegExp][] = [
  ['POST', /^\/v1\/support\/scope$/],
  ['POST', /^\/v1\/support\/notes$/],
];

/** The writes about the person's account (src/support-actions.ts): proposing a change they confirm signed in, and re-checking a domain's DNS. */
const ACTION_WRITES: [method: string, path: RegExp][] = [['POST', /^\/v1\/support\/actions$/], ['POST', /^\/v1\/support\/domains\/[A-Za-z0-9_-]{1,120}\/verify$/]];

/** Whether the binding may make this call without a conversation: the operator support routes. */
export function supportPlatformAllows(method: string, path: string) {
  if (path.includes('..') || path.includes('//')) return false;
  return OPERATOR_ROUTES.some(([m, p]) => m === method && p.test(path));
}
/** Whether request() may make this call for a conversation: a GET under /v1/support, or one of its writes. */
export function stampedAllows(method: string, path: string) {
  if (path.includes('..') || path.includes('//')) return false;
  if (ACTION_WRITES.some(([m, p]) => m === method && p.test(path))) return true;
  return (method === 'GET' && SUPPORT_READ.test(path)) || STAMPED_WRITES.some(([m, p]) => m === method && p.test(path));
}

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };
export type HandoffClaims = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
};
export type HandoffCheck =
  | { ok: true; handoff: HandoffClaims & { usedAt: string | null; message: string | null } }
  | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };

/** How the support platform knows who a conversation is for: Nightmail checks each itself. */
export type ConversationEvidence = { kind: 'handoff'; token: string } | { kind: 'email'; messageId: string };
export type RegisteredConversation = { id: string; channel: 'chat' | 'email'; mode: 'member' | 'non_member' | 'pending_signin' | 'unverified'; verification: 'handoff' | 'dmarc' | 'signin' | 'none';
  status: 'open' | 'ticketed' | 'closed'; workspaceId: string | null; contentShared: boolean; created: boolean };

/** A transcript entry the support platform mirrors into the inbox (src/support-inbox.ts). Staff replies come from the inbox. */
export type MirroredMessage = { id: string; author: 'customer' | 'agent' | 'system'; kind?: string | null; text: string; tools?: { label: string; ok: boolean }[]; attachments?: string[];
  delivery?: 'sent' | 'failed' | 'held'; at?: string };
/** What the support platform mirrors about a conversation; each field is optional. */
export type MirroredState = { subject?: string; ticket?: { id: string; type: string; severity: 'P1' | 'P2' | 'P3' }; turns?: number; costUsd?: number; blockedWork?: number; pauseForTicket?: true };
/** A conversation's inbox state as the support platform needs it: check agentState before every turn and every send. */
export type InboxState = { id: string; status: 'open' | 'ticketed' | 'closed'; agentState: 'active' | 'paused'; pausedBy: 'staff' | 'ticket' | null; pausedAt: string | null;
  ticket: { id: string; type: string | null; severity: string | null; resolvedAt: string | null } | null; queuedReplies: number };
/** A staff reply waiting for delivery. */
export type OutboxReply = { id: string; conversationId: string; channel: 'chat' | 'email'; text: string; staffName: string | null; createdAt: string };

// ---------- the handoffs Nightmail signs (aud bane-support) ----------

type SigningKey = NonNullable<NonNullable<Config['support']>['signingKey']>;
const b64 = (value: string) => Buffer.from(value, 'base64url');
const b64url = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');
/** The key ID of the support signing key, in each token's header and in GET /v1/public/support-keys. */
export async function keyId(x: string) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))).slice(0, 16); }
/** A compact JWS (EdDSA) with the support signing key; the support platform verifies it with GET /v1/public/support-keys. */
export async function signSupportToken(key: SigningKey, claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: await keyId(key.x) })), payload = b64url(JSON.stringify(claims));
  const signer = await crypto.subtle.importKey('jwk', { ...key, ext: false }, { name: 'Ed25519' }, false, ['sign']);
  return `${header}.${payload}.${b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, new TextEncoder().encode(`${header}.${payload}`))))}`;
}
/** The claims of a JWS this installation signed (its structure, algorithm, key ID and signature), or null. */
async function signedClaims(key: SigningKey, token: unknown): Promise<Record<string, unknown> | null> {
  const parts = typeof token === 'string' && token.length <= 4096 ? token.split('.') : [];
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let head: { alg?: unknown; kid?: unknown }, claims: unknown;
  try { head = JSON.parse(b64(header).toString()); claims = JSON.parse(b64(payload).toString()); } catch { return null; }
  if (!head || head.alg !== 'EdDSA' || head.kid !== await keyId(key.x) || typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const verifier = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
  return await crypto.subtle.verify({ name: 'Ed25519' }, verifier, b64(signature), new TextEncoder().encode(`${header}.${payload}`)) ? claims as Record<string, unknown> : null;
}

/**
 * Checks a handoff JWS that this installation signed (POST /v1/contact-support): the signature against its own key, the
 * audience, the issuer and the 10-minute expiry. The signature only proves Nightmail issued it; whether it was already used is
 * the handoff row's business, which registration checks atomically.
 */
export async function verifyHandoffToken(config: Pick<Config, 'support' | 'publicUrl'>, token: string, now = Date.now()): Promise<{ ok: true; claims: HandoffClaims } | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'SUPPORT_NOT_CONFIGURED' }> {
  const key = config.support?.signingKey;
  if (!key) return { ok: false, code: 'SUPPORT_NOT_CONFIGURED' };
  const claims = await signedClaims(key, token);
  if (!claims) return { ok: false, code: 'HANDOFF_INVALID' };
  const user = claims.user as { id?: unknown; email?: unknown; role?: unknown } | undefined, workspace = claims.workspace as { id?: unknown; name?: unknown } | undefined;
  if (claims.aud !== 'bane-support' || claims.iss !== config.publicUrl || typeof claims.jti !== 'string' || !/^sho_[0-9a-f]{32}$/.test(claims.jti)
    || typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || typeof user?.id !== 'string' || typeof workspace?.id !== 'string') return { ok: false, code: 'HANDOFF_INVALID' };
  if (claims.exp * 1000 <= now) return { ok: false, code: 'HANDOFF_EXPIRED' };
  return { ok: true, claims: {
    id: claims.jti, kind: typeof claims.kind === 'string' ? claims.kind : 'support', userId: user.id, email: typeof user.email === 'string' ? user.email : '',
    role: typeof user.role === 'string' ? user.role : 'member', workspace: { id: workspace.id, name: typeof workspace.name === 'string' ? workspace.name : workspace.id },
    page: typeof claims.page === 'string' ? claims.page : null, requestIds: Array.isArray(claims.requestIds) ? claims.requestIds.filter((r): r is string => typeof r === 'string').slice(0, 5) : [],
    shareContent: claims.shareContent === true, issuedAt: new Date(claims.iat * 1000).toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(),
  } };
}

/**
 * The binding's methods, over a dispatcher that runs one request through the app as the support platform. Kept free of
 * `cloudflare:workers` so the acceptance suite drives exactly this on Node; src/worker.ts wraps it in the entrypoint.
 */
export function supportPlatform(dispatch: (request: Request, conversation?: string) => Promise<Response>, config: () => Pick<Config, 'support' | 'publicUrl'>) {
  const origin = () => config().publicUrl.replace(/\/$/, '');
  const refuse = <T>(status: number, code: string, message: string): PlatformReply<T> => {
    const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
    return { status, body: { error: { code, message, requestId, retryable: false } } as T, requestId, retryAfter: null };
  };
  async function send<T>(method: string, url: URL, body: unknown, conversation?: string): Promise<PlatformReply<T>> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'nightmail-support (service binding)' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await dispatch(new Request(origin() + url.pathname + url.search, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), conversation);
    const text = await response.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 200) } }; }
    return { status: response.status, body: parsed as T, requestId: response.headers.get('x-request-id'), retryAfter: response.headers.get('retry-after') };
  }
  async function call<T>(method: string, path: string, body?: unknown): Promise<PlatformReply<T>> {
    const url = new URL(path, 'https://internal.invalid');
    if (!supportPlatformAllows(method, url.pathname)) return refuse(404, 'NOT_FOUND', 'The support platform cannot call this route.');
    return send<T>(method, url, body);
  }
  return {
    /** A wake for this conversation, issued by this installation in the last minute. */
    async verifyWake(token: string, conversationId: string) {
      const {support, publicUrl} = config();
      if (!support?.signingKey || !CONVERSATION_ID.test(conversationId)) return false;
      const claims = await signedClaims(support.signingKey, token), now = Math.floor(Date.now()/1000);
      return !!claims && claims.aud === 'nightmail-support-wake' && claims.iss === publicUrl &&
        claims.conversationId === conversationId && typeof claims.exp === 'number' && claims.exp > now && claims.exp <= now + 65;
    },
    /** A handoff JWS from the dashboard: its signed claims plus the stored row (used or not, the person's message). */
    async verifyHandoff(token: string): Promise<HandoffCheck> {
      const checked = await verifyHandoffToken(config(), token);
      if (!checked.ok) return checked;
      const stored = await call<{ userId: string; workspaceId: string; usedAt: string | null; message: string | null; shareContent: boolean }>('GET', `/v1/operator/support/handoffs/${checked.claims.id}`);
      if (stored.status === 404) return { ok: false, code: 'HANDOFF_NOT_FOUND' };
      if (stored.status !== 200) throw new Error(`Handoff lookup failed with ${stored.status}`);
      const row = stored.body;
      if (row.userId !== checked.claims.userId || row.workspaceId !== checked.claims.workspace.id) return { ok: false, code: 'HANDOFF_INVALID' };
      return { ok: true, handoff: { ...checked.claims, shareContent: row.shareContent, usedAt: row.usedAt, message: row.message } };
    },
    /**
     * Register a conversation, or another email in it: Nightmail checks the evidence itself (its own signed handoff, or a
     * message it received at a support address) and decides who the conversation is for. Once per handoff; repeating a
     * registration answers its current state.
     */
    registerConversation: (body: { conversationId: string; evidence: ConversationEvidence }) => call<RegisteredConversation>('POST', '/v1/operator/support/conversations', body),
    /** End a conversation: every later request for it is refused. Repeating it is harmless. */
    closeConversation: (conversationId: string) => call<{ id: string; status: 'closed'; closedAt: string }>('POST', `/v1/operator/support/conversations/${encodeURIComponent(String(conversationId))}/close`, {}),
    /** Mirror transcript entries into the inbox, in order. Appending an entry again (same ID) changes nothing. */
    mirrorMessages: (conversationId: string, messages: MirroredMessage[]) =>
      call<{ data: { id: string; seq: number; created: boolean }[] }>('POST', `/v1/operator/support/conversations/${encodeURIComponent(String(conversationId))}/messages`, { messages }),
    /** Mirror a conversation's subject, ticket, counters and blocked work; answers its inbox state. */
    mirrorState: (conversationId: string, state: MirroredState) => call<InboxState>('POST', `/v1/operator/support/conversations/${encodeURIComponent(String(conversationId))}/state`, state),
    /** A conversation's inbox state: whether staff paused the agent, before every turn and every send. */
    inboxState: (conversationId: string) => call<InboxState>('GET', `/v1/operator/support/conversations/${encodeURIComponent(String(conversationId))}/state`),
    /** The staff replies waiting for delivery (one conversation's, after its wake), oldest first. Staff can reply only while this is polled. */
    pullOutbox: (conversationId?: string) => call<{ data: OutboxReply[] }>('GET', `/v1/operator/support/outbox${conversationId === undefined ? '' : `?conversationId=${encodeURIComponent(String(conversationId))}`}`),
    /** Record a staff reply's delivery: sent, or failed for good. */
    markDelivery: (conversationId: string, messageId: string, status: 'sent' | 'failed') =>
      call<{ id: string; delivery: 'sent' | 'failed'; deliveredAt: string | null }>('POST', `/v1/operator/support/conversations/${encodeURIComponent(String(conversationId))}/messages/${encodeURIComponent(String(messageId))}/delivery`, { status }),
    /**
     * A /v1/support request for one registered conversation: a GET, or a write (POST /v1/support/scope or notes). The
     * conversation rides on the runtime, never in the request; Nightmail derives the customer from its row and answers
     * for their live memberships, within its scope, while it is open.
     */
    async request<T = unknown>(conversationId: string, method: string, path: string, body?: unknown): Promise<PlatformReply<T>> {
      if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) return refuse<T>(403, 'SUPPORT_GRANT_REQUIRED', 'Name a registered support conversation.');
      const url = new URL(String(path), 'https://internal.invalid'), verb = String(method).toUpperCase();
      if (!stampedAllows(verb, url.pathname) || (verb === 'GET' && body !== undefined)) return refuse<T>(404, 'NOT_FOUND', 'The support platform cannot call this route for a conversation.');
      return send<T>(verb, url, body, conversationId);
    },
    call,
  };
}
export type SupportPlatformApi = ReturnType<typeof supportPlatform>;
