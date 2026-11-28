import type { Config } from './core.js';
import type { AgentAnswer, Brief, ConversationEvidence, FeedbackReport, FiledConversation, GeneralAnswerDue, Handoff, HandoffCheck, HandoffClaims, InboxState, MirroredMessage, MirroredState, OutboxReply, PlatformReply, RegisteredConversation, StaffEmail, StaffReply, StaffReplyIgnored, SupportPlatformRpc, TriageNoteInput } from './support-contract.js';
export type { AgentAnswer, Brief, ConversationEvidence, FeedbackReport, FiledConversation, GeneralAnswerDue, Handoff, HandoffCheck, HandoffClaims, InboxState, MirroredMessage, MirroredState, OutboxReply, PlatformReply, RegisteredConversation, StaffEmail, StaffReply, StaffReplyIgnored, SupportPlatformRpc, TriageNoteInput };

// The support platform's door into Nightmail (api/README.md "Support integration"): a Cloudflare service binding to the
// `SupportPlatform` entrypoint (src/worker.ts), not a token. Only a Worker in the same account that declares a binding
// to that entrypoint can call it, so the credential is the deploy configuration itself: it cannot leak, needs no
// rotation, and is revoked by removing the binding or the entrypoint.
//
// It answers exactly what the support Worker needs and nothing else (PR #137 review L2): verify a handoff, register and
// close a support conversation, the /v1/support/* requests stamped with a conversation (request), the inbox: mirror
// a conversation's transcript and state, and pull and acknowledge the staff replies it delivers; and the feedback triage
// agent's reads and its one note (src/feedback-triage.ts), each keyed by the report's own conversation. Each call runs through
// the normal routes, so validation, audit rows and budgets are the same as for an operator. Operator paths act as
// `service:bane-support`; /v1/support/* needs a registered conversation that only request() can name: it rides on the
// runtime, never in a header, query parameter or body.

/** What the entrypoint passes to the app as `Runtime.platformCaller`. HTTP requests can never set it. */
export const SUPPORT_PLATFORM_CALLER = 'bane-support';
/** The audience of a staff link to one screenshot the support platform holds (src/support-inbox.ts, verifyFile). */
export const FILE_AUDIENCE = 'nightmail-support-file';
/** The support Worker's conversation IDs (conv_ and 26 base32 characters). */
export const CONVERSATION_ID = /^conv_[a-z2-7]{26}$/;
/** The runtime fields a binding call runs with: the caller, and for request() its conversation. */
export const platformRuntime = (conversation?: string) => ({ platformCaller: SUPPORT_PLATFORM_CALLER, ...(conversation ? { supportConversation: conversation } : {}) }) as { platformCaller: typeof SUPPORT_PLATFORM_CALLER; supportConversation?: string };

/** The IDs an operator support path carries: each segment's whole shape, so a route matches nothing else. */
const PATH_TOKENS = { handoffId: 'sho_[0-9a-f]{32}', conversationId: 'conv_[a-z2-7]{26}', messageId: 'msg_[a-z2-7]{16}', staffKey: 'staff-[0-9a-f]{24}-[0-9]{1,6}', requestId: 'req_[0-9a-f]{32}' } as const;
type PathToken = keyof typeof PATH_TOKENS;
type PathParams<T extends string> = T extends `${string}{${infer P extends PathToken}}${infer Rest}` ? { [K in P]: string } & PathParams<Rest> : unknown;
/** The `{name}`s in a template that PATH_TOKENS doesn't know: a template naming one doesn't typecheck. */
type UnknownTokens<T extends string> = T extends `${string}{${infer P}}${infer Rest}` ? (P extends PathToken ? UnknownTokens<Rest> : P) : never;
type Query = Record<string, string | undefined>;
/** An operator support route: `at` gives its method and its path for these IDs (encoded) and query parameters (unset ones left out). */
type SupportRoute<P> = { at: (params: P, query?: Query) => [method: 'GET' | 'POST', path: string] };
const OPERATOR_ROUTES: [method: string, path: RegExp][] = [];
/**
 * Declares one route the binding may call without a conversation: the allowlist entry (supportPlatformAllows) and the
 * path the client below builds come from the same template, so they can't drift apart.
 */
function defineSupportRoute<const T extends string>(method: 'GET' | 'POST', template: T & ([UnknownTokens<T>] extends [never] ? unknown : never)): SupportRoute<PathParams<T>> {
  OPERATOR_ROUTES.push([method, new RegExp(`^${template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(PATH_TOKENS, name)) throw new Error(`Unknown path token {${name}} in ${template}`);
    return PATH_TOKENS[name as PathToken];
  })}$`)]);
  return {
    at: (params, query) => {
      const path = template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String((params as Record<string, unknown>)[name])));
      const search = Object.entries(query ?? {}).flatMap(([key, value]) => value === undefined ? [] : [`${key}=${encodeURIComponent(String(value))}`]).join('&');
      return [method, search ? `${path}?${search}` : path];
    },
  };
}
const conversation = '/v1/operator/support/conversations/{conversationId}', staffMail = '/v1/operator/support/staff-mail', feedback = '/v1/operator/support/feedback/{conversationId}';
const ROUTES = {
  handoff: defineSupportRoute('GET', '/v1/operator/support/handoffs/{handoffId}'),
  register: defineSupportRoute('POST', '/v1/operator/support/conversations'),
  close: defineSupportRoute('POST', `${conversation}/close`),
  // The inbox (src/support-inbox.ts): the transcript and state it mirrors, and the staff replies it delivers.
  messages: defineSupportRoute('POST', `${conversation}/messages`),
  inboxState: defineSupportRoute('GET', `${conversation}/state`),
  mirrorState: defineSupportRoute('POST', `${conversation}/state`),
  outbox: defineSupportRoute('GET', '/v1/operator/support/outbox'),
  // A chat as Nightmail holds it, with the messages the dashboard filed while the chat couldn't take them (support-conversations.ts fileChatTicket).
  filed: defineSupportRoute('GET', `${conversation}/filed`),
  // Emails whose sender asked to be answered by email instead (support-conversations.ts releaseGeneralAnswer).
  generalAnswers: defineSupportRoute('GET', '/v1/operator/support/general-answers'),
  delivery: defineSupportRoute('POST', `${conversation}/messages/{messageId}/delivery`),
  // One path to a human (src/support-staff-mail.ts): the staff emails due, each one sent, one that failed to send, and a
  // reply to one (a note on its conversation, or nothing).
  staffMail: defineSupportRoute('POST', staffMail),
  staffMailSent: defineSupportRoute('POST', `${staffMail}/{staffKey}/sent`),
  staffMailFailed: defineSupportRoute('POST', `${staffMail}/{staffKey}/failed`),
  staffMailReply: defineSupportRoute('POST', `${staffMail}/replies`),
  // The feedback triage agent (src/feedback-triage.ts): the reports due, and for one report its request trace, the
  // reports beside it, its one note and what reading it cost. Nothing else: no route that sends, replies, resolves or
  // changes an account.
  feedbackDue: defineSupportRoute('POST', '/v1/operator/support/feedback/due'),
  feedbackRequest: defineSupportRoute('GET', `${feedback}/requests/{requestId}`),
  feedbackRelated: defineSupportRoute('GET', `${feedback}/related`),
  feedbackTriage: defineSupportRoute('POST', `${feedback}/triage`),
  feedbackUsage: defineSupportRoute('POST', `${feedback}/usage`),
  // Agent reports that ask something (src/feedback-triage.ts): their email conversations, claimed for the support agent.
  agentAnswersDue: defineSupportRoute('POST', '/v1/operator/support/agent-answers/due'),
};
const SUPPORT_READ = /^\/v1\/support\/[A-Za-z0-9_./-]{1,200}$/;
/** The writes a conversation makes: narrowing its scope to one workspace, and keeping a note about its person. */
const STAMPED_WRITES: [method: string, path: RegExp][] = [
  ['POST', /^\/v1\/support\/scope$/],
  ['POST', /^\/v1\/support\/notes$/],
];

/**
 * The writes about the person's account (src/support-actions.ts): proposing a change they confirm signed in, the safe
 * actions (re-checking a domain's or a receiving host's DNS, resending a forward confirmation), and proposing a risky
 * change to staff, which only an operator's approval runs.
 */
const ACTION_WRITES: [method: string, path: RegExp][] = [['POST', /^\/v1\/support\/actions$/], ['POST', /^\/v1\/support\/domains\/[A-Za-z0-9_-]{1,120}\/verify$/],
  ['POST', /^\/v1\/support\/receiving\/hosts\/[A-Za-z0-9_-]{1,120}\/recheck$/], ['POST', /^\/v1\/support\/receiving\/forwards\/[A-Za-z0-9_-]{1,120}\/resend$/], ['POST', /^\/v1\/support\/approvals$/]];

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
  /**
   * A token this installation signed for `audience`, naming exactly `expected`, and expiring within `lifetime` seconds
   * from now (a token minted for longer is refused).
   */
  async function verifySignedClaim(token: string, audience: string, lifetime: number, expected: Record<string, string>) {
    const { support, publicUrl } = config();
    if (!support?.signingKey) return false;
    const claims = await signedClaims(support.signingKey, token), now = Math.floor(Date.now() / 1000);
    return !!claims && claims.aud === audience && claims.iss === publicUrl && Object.entries(expected).every(([key, value]) => claims[key] === value)
      && typeof claims.exp === 'number' && claims.exp > now && claims.exp <= now + lifetime;
  }
  async function call<T>(method: string, path: string, body?: unknown): Promise<PlatformReply<T>> {
    const url = new URL(path, 'https://internal.invalid');
    if (!supportPlatformAllows(method, url.pathname)) return refuse(404, 'NOT_FOUND', 'The support platform cannot call this route.');
    return send<T>(method, url, body);
  }
  return {
    /** A wake for this conversation, issued by this installation in the last minute. */
    verifyWake: async (token: string, conversationId: string) => CONVERSATION_ID.test(conversationId) && verifySignedClaim(token, 'nightmail-support-wake', 65, { conversationId }),
    /** A staff link to one screenshot of this conversation (GET /v1/operator/support-inbox/{id}/files/{attachmentId}), issued by this installation in the last five minutes. */
    verifyFile: async (token: string, conversationId: string, attachmentId: string) =>
      CONVERSATION_ID.test(conversationId) && /^att_[a-z2-7]{16}$/.test(attachmentId) && verifySignedClaim(token, FILE_AUDIENCE, 305, { conversationId, attachmentId }),
    /** A handoff JWS from the dashboard: its signed claims plus the stored row (used or not, the person's message). */
    async verifyHandoff(token: string): Promise<HandoffCheck> {
      const checked = await verifyHandoffToken(config(), token);
      if (!checked.ok) return checked;
      const stored = await call<{ userId: string; workspaceId: string; usedAt: string | null; message: string | null; shareContent: boolean }>(...ROUTES.handoff.at({ handoffId: checked.claims.id }));
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
    registerConversation: (body: { conversationId: string; evidence: ConversationEvidence }) => call<RegisteredConversation>(...ROUTES.register.at({}), body),
    /** End a conversation: every later request for it is refused. Repeating it is harmless. */
    closeConversation: (conversationId: string) => call<{ id: string; status: 'closed'; closedAt: string }>(...ROUTES.close.at({ conversationId }), {}),
    /** Mirror transcript entries into the inbox, in order. Appending an entry again (same ID) changes nothing. */
    mirrorMessages: (conversationId: string, messages: MirroredMessage[]) =>
      call<{ data: { id: string; seq: number; created: boolean }[] }>(...ROUTES.messages.at({ conversationId }), { messages }),
    /** Mirror a conversation's subject, ticket, counters and blocked work; answers its inbox state. */
    mirrorState: (conversationId: string, state: MirroredState) => call<InboxState>(...ROUTES.mirrorState.at({ conversationId }), state),
    /** A conversation's inbox state: whether staff paused the agent, before every turn and every send. */
    inboxState: (conversationId: string) => call<InboxState>(...ROUTES.inboxState.at({ conversationId })),
    /** The staff replies waiting for delivery (one conversation's, after its wake), oldest first. Staff can reply only while this is polled. */
    pullOutbox: (conversationId?: string) => call<{ data: OutboxReply[] }>(...ROUTES.outbox.at({}, { conversationId })),
    /**
     * The conversations whose sender asked, from the sign-in link, to be answered by email instead (one conversation's,
     * after its wake), oldest first: answer each in general, once, with no account access.
     */
    generalAnswers: (conversationId?: string) => call<{ data: GeneralAnswerDue[] }>(...ROUTES.generalAnswers.at({}, { conversationId })),
    /**
     * A chat as Nightmail holds it, with the customer's messages the dashboard filed as a ticket while the chat couldn't
     * take them: adopt one Nightmail opened (filed) as this person's chat in this workspace, and take each filed message
     * into the transcript under its own ID, as already with staff.
     */
    filedConversation: (conversationId: string) => call<FiledConversation>(...ROUTES.filed.at({ conversationId })),
    /** Record a staff reply's delivery: sent, or failed for good. */
    markDelivery: (conversationId: string, messageId: string, status: 'sent' | 'failed') =>
      call<{ id: string; delivery: 'sent' | 'failed'; deliveredAt: string | null }>(...ROUTES.delivery.at({ conversationId, messageId }), { status }),
    /**
     * The staff emails due (src/support-staff-mail.ts writes them now, then answers every one not yet sent, oldest first):
     * send each from the support address to the team, starting its thread or replying in it, then report it sent.
     */
    staffMail: () => call<{ data: StaffEmail[] }>(...ROUTES.staffMail.at({}), {}),
    /** A staff email went out: its thread and message, so the next one in the thread replies to it. */
    staffMailSent: (key: string, sent: { threadId: string; messageId: string }) =>
      call<{ key: string; sentAt: string }>(...ROUTES.staffMailSent.at({ staffKey: key }), sent),
    /** A staff email failed to send this time (its error's code): after three tries it shows on Glass until it goes. */
    staffMailFailed: (key: string, failed: { code: string }) =>
      call<{ key: string; attempts: number; failed: boolean; sent: boolean }>(...ROUTES.staffMailFailed.at({ staffKey: key }), failed),
    /**
     * Before an email to a support address is a customer's: whether it replies to a staff email (reply false: it doesn't,
     * handle it as any support email), and if so the note it became on its conversation, or why none (ignored).
     */
    staffMailReply: (messageId: string, team: string | null) =>
      call<StaffReply>(...ROUTES.staffMailReply.at({}), { messageId, team }),
    /** Claims the agent feedback reports still to read (at most `limit`, at most 5), oldest first: each is handed out at most twice. */
    feedbackDue: (limit: number) => call<{ data: FeedbackReport[] }>(...ROUTES.feedbackDue.at({}), { limit }),
    /** Claims the agent reports to answer by email (at most `limit`, at most 5), oldest first: each is handed out at most three times. */
    agentAnswersDue: (limit: number) => call<{ data: AgentAnswer[] }>(...ROUTES.agentAnswersDue.at({}), { limit }),
    /** One request's trace, in the report's own workspace only: any other request ID is 404. */
    feedbackRequest: (conversationId: string, requestId: string) =>
      call(...ROUTES.feedbackRequest.at({ conversationId, requestId })),
    /** The earlier reports from the report's own workspace, and counts of the same operation elsewhere. */
    feedbackRelated: (conversationId: string) => call(...ROUTES.feedbackRelated.at({ conversationId })),
    /** The triage agent's one note on a report: 201 once, 409 after. */
    feedbackTriage: (conversationId: string, note: TriageNoteInput) =>
      call<{ conversationId: string; ticketId: string | null; messageId: string; classification: string; createdAt: string }>(...ROUTES.feedbackTriage.at({ conversationId }), note),
    /** What one reading of a report cost: its model turns and US dollars, added to the support AI's spend. */
    feedbackUsage: (conversationId: string, usage: { turns: number; costUsd: number }) =>
      call<{ conversationId: string; turns: number; costUsd: number }>(...ROUTES.feedbackUsage.at({ conversationId }), usage),
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
type AssertExact<T extends true> = T;
export type _SupportPlatformRpcLockstep = AssertExact<[Omit<SupportPlatformApi, 'call'>] extends [SupportPlatformRpc] ? ([SupportPlatformRpc] extends [Omit<SupportPlatformApi, 'call'>] ? true : never) : never>;