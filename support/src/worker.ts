import { verifyWebhook } from './webhook.js';
import type { Env } from './env.js';
import { addressHash, chatToken, MissingSecret, newId, readChatToken } from './tokens.js';
import { readAttachmentLink, readCapped, serveAttachment } from './attachments.js';
import { MAX_IMAGE_BYTES } from './image.js';
import { daily } from './limits.js';
import { acceptIntake, acceptSupport, blockUnconfigured, holdAtEdge, intakeAddress, ledgered, sweep } from './ledger.js';
import { readiness } from './replay.js';
import { log, logError } from './log.js';
import { FAVICON_LINKS, favicon } from './favicon.js';
import { addresses, productName } from '../../api/src/brand.js';
export { SupportConversation } from './conversation.js';
export { SupportIntake, INTAKE, type Mailbox } from './intake.js';
export { SupportTriage } from './triage.js';

// The support Worker (support/README.md): chat starts and resumes, the conversation WebSocket, Nightmail's inbound webhook
// for support@nightmail.dev, its content-free wakes, and the page an old confirm link opens. Every conversation is one
// SupportConversation Durable Object, reached only by ID from this router, never through a client-named route.

const CONVERSATIONS_PER_DAY = 10;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
// The error code of each refusal, for the request line (read without parsing the body).
const failures = new WeakMap<Response, string>();
const fail = (status: number, code: string, message: string, headers: HeadersInit = {}, extra: Record<string, unknown> = {}) => {
  const response = json({ error: { code, message, ...extra } }, status, headers);
  failures.set(response, code);
  return response;
};
const CONVERSATION_ID = /^conv_[a-z2-7]{26}$/;

function allowedOrigin(env: Env, request: Request) {
  const origin = request.headers.get('origin');
  return origin && env.DASHBOARD_ORIGINS.split(',').map(o => o.trim()).includes(origin) ? origin : null;
}
function cors(env: Env, request: Request): Record<string, string> {
  const origin = allowedOrigin(env, request);
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-filename', 'access-control-max-age': '600', vary: 'origin' } : {};
}
const socketUrl = (env: Env, conversationId: string, token: string) => `${env.PUBLIC_URL.replace(/^http/, 'ws')}/c/${conversationId}?token=${encodeURIComponent(token)}`;
const conversation = (env: Env, id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));

const MAX_HANDOFF_BYTES = 8192, MAX_WEBHOOK_BYTES = 1_000_000, MAX_WAKE_BYTES = 1024;

/** Enforces Content-Length and a streaming byte limit before decoding text; returns null when oversized. */
async function readCappedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) { await request.body?.cancel().catch(() => {}); return null; }
  const bytes = await readCapped(request.body, limit);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

async function readHandoff(request: Request): Promise<{ handoff?: string; conversationId?: string; resume?: boolean; tooLarge?: true } | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const text = await readCappedText(request, MAX_HANDOFF_BYTES);
  if (text === null) return { tooLarge: true };
  try { const body = JSON.parse(text) as Record<string, unknown>; return { handoff: typeof body.handoff === 'string' ? body.handoff : undefined, conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined, resume: body.resume === true }; } catch { return null; }
}

async function startChat(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Open support from the ${productName} dashboard.`);
  const body = await readHandoff(request);
  if (body?.tooLarge) return fail(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.', headers);
  if (!body?.handoff) return fail(400, 'INVALID_REQUEST', 'Send { "handoff": "<token from /v1/contact-support>" }.', headers);
  const checked = await env.BANE.verifyHandoff(body.handoff);
  if (!checked.ok) return checked.code === 'SUPPORT_NOT_CONFIGURED' ? fail(503, 'SUPPORT_UNAVAILABLE', 'Support chat is not configured on this installation.', headers)
    : fail(401, 'HANDOFF_INVALID', 'That handoff is not valid or has expired. Get a fresh one and retry.', headers);
  const { handoff } = checked;
  if (handoff.usedAt) return fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers);
  // Continuous chat: when the panel asks to resume, rejoin this person and workspace's open chat instead of starting another.
  if (body.resume && !handoff.message) {
    const existing = await env.DB.prepare("SELECT id FROM conversations WHERE channel = 'chat' AND user_id = ? AND workspace_id = ? AND status <> 'closed' ORDER BY updated_at DESC, created_at DESC LIMIT 1")
      .bind(handoff.userId, handoff.workspace.id).first<{ id: string }>();
    if (existing) {
      const admitted = await conversation(env, existing.id).admits({ userId: handoff.userId });
      if (admitted.ok) {
        const claimed = await env.DB.prepare('INSERT INTO handoffs_used (jti, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING').bind(handoff.id, existing.id, Date.now()).run();
        if (!claimed.meta.changes) return fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers);
        const chat = await chatToken(env.SUPPORT_ROOT_SECRET, existing.id, handoff.userId);
        return json({ conversationId: existing.id, chatToken: chat.token, socketUrl: socketUrl(env, existing.id, chat.token), expiresAt: chat.expiresAt }, 200, headers);
      }
      if (admitted.code === 'UNAVAILABLE') return fail(503, 'SUPPORT_UNAVAILABLE', 'Support could not open your account just now. Try again in a minute.', headers);
    }
  }
  if (env.CHAT_START && !(await env.CHAT_START.limit({ key: `user:${handoff.userId}` })).success) return fail(429, 'RATE_LIMITED', 'Too many conversations started. Try again in a minute.', { ...headers, 'retry-after': '60' }, { retryAfter: 60 });
  const now = Date.now(), dayAgo = now - 86_400_000;
  const today = await env.DB.prepare('SELECT count(*) AS n FROM conversations WHERE user_id = ? AND created_at > ?').bind(handoff.userId, dayAgo).first<{ n: number }>();
  if ((today?.n ?? 0) >= CONVERSATIONS_PER_DAY) return fail(429, 'RATE_LIMITED', `You can start ${CONVERSATIONS_PER_DAY} support conversations a day. Continue an earlier one, or email ${addresses.support}.`, { ...headers, 'retry-after': '3600' }, { retryAfter: 3600 });
  const conversationId = newId('conv');
  // The handoff's jti opens one conversation; the unique key makes a concurrent replay lose.
  const claimed = await env.DB.batch([
    env.DB.prepare('INSERT INTO handoffs_used (jti, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING').bind(handoff.id, conversationId, now),
    env.DB.prepare(`INSERT INTO conversations (id, channel, user_id, email, workspace_id, workspace_name, created_at, updated_at)
      SELECT ?, 'chat', ?, ?, ?, ?, ?, ? WHERE (SELECT conversation_id FROM handoffs_used WHERE jti = ?) = ?`).bind(conversationId, handoff.userId, handoff.email, handoff.workspace.id, handoff.workspace.name, now, now, handoff.id, conversationId),
  ]);
  if (!claimed[1]?.meta.changes) return fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers);
  // Nightmail registers the conversation from this same signed handoff: it binds the person and workspace, once.
  const opened = await conversation(env, conversationId).openChat({ conversationId, handoff, token: body.handoff });
  if (!opened.ok) {
    await env.DB.prepare("UPDATE conversations SET status = 'closed', closed_at = ? WHERE id = ?").bind(Date.now(), conversationId).run();
    return opened.code === 'HANDOFF_USED' ? fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers)
      : opened.code === 'CONVERSATION_LIMIT' ? fail(429, 'RATE_LIMITED', `You have too many open support conversations. Continue an earlier one, or email ${addresses.support}.`, { ...headers, 'retry-after': '3600' }, { retryAfter: 3600 })
      : fail(503, 'SUPPORT_UNAVAILABLE', 'Support could not open your account just now. Try again in a minute.', headers);
  }
  const chat = await chatToken(env.SUPPORT_ROOT_SECRET, conversationId, handoff.userId);
  return json({ conversationId, chatToken: chat.token, socketUrl: socketUrl(env, conversationId, chat.token), expiresAt: chat.expiresAt }, 200, headers);
}

async function resumeChat(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Open support from the ${productName} dashboard.`);
  const body = await readHandoff(request);
  if (body?.tooLarge) return fail(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.', headers);
  if (!body?.handoff || !body.conversationId || !CONVERSATION_ID.test(body.conversationId)) return fail(400, 'INVALID_REQUEST', 'Send { "conversationId", "handoff" }.', headers);
  const checked = await env.BANE.verifyHandoff(body.handoff);
  if (!checked.ok) return fail(401, 'HANDOFF_INVALID', 'That handoff is not valid or has expired. Get a fresh one and retry.', headers);
  if (checked.handoff.usedAt) return fail(409, 'HANDOFF_USED', 'This handoff was already used. Get a fresh one.', headers);
  const row = await env.DB.prepare('SELECT channel, user_id, status FROM conversations WHERE id = ?').bind(body.conversationId).first<{ channel: string; user_id: string | null; status: string }>();
  if (!row || row.status === 'closed') return fail(404, 'CONVERSATION_NOT_FOUND', 'That conversation has ended. Start a new one.', headers);
  // An email conversation continues by email, never in the panel: the panel starts a conversation of its own instead.
  if (row.channel === 'email') return fail(409, 'EMAIL_CONVERSATION', 'This conversation continues by email. Start a new one here.', headers);
  if (!row.user_id || row.user_id !== checked.handoff.userId) return fail(403, 'NOT_YOUR_CONVERSATION', 'This conversation belongs to someone else.', headers);
  // Still open and theirs in the conversation itself, with no less access than it last ran with: checked before a token is minted.
  const admitted = await conversation(env, body.conversationId).admits({ userId: checked.handoff.userId });
  if (!admitted.ok) return admitted.code === 'UNAVAILABLE' ? fail(503, 'SUPPORT_UNAVAILABLE', 'Support could not open your account just now. Try again in a minute.', headers)
    : fail(404, 'CONVERSATION_NOT_FOUND', 'That conversation has ended. Start a new one.', headers);
  const claimed = await env.DB.prepare('INSERT INTO handoffs_used (jti, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING').bind(checked.handoff.id, body.conversationId, Date.now()).run();
  if (!claimed.meta.changes) return fail(409, 'HANDOFF_USED', 'This handoff was already used. Get a fresh one.', headers);
  // Only a new chat token: account access never expires mid-conversation (Nightmail reads it from the conversation on
  // every request), so there is nothing to renew.
  const chat = await chatToken(env.SUPPORT_ROOT_SECRET, body.conversationId, checked.handoff.userId);
  return json({ conversationId: body.conversationId, chatToken: chat.token, socketUrl: socketUrl(env, body.conversationId, chat.token), expiresAt: chat.expiresAt }, 200, headers);
}

async function socket(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
  if (!allowedOrigin(env, request)) return new Response(null, { status: 403 });
  const reader = await readChatToken(env.SUPPORT_ROOT_SECRET, new URL(request.url).searchParams.get('token'), conversationId);
  if (!reader) return new Response(null, { status: 401 });
  const row = await env.DB.prepare('SELECT user_id, status FROM conversations WHERE id = ?').bind(conversationId).first<{ user_id: string | null; status: string }>();
  if (!row || row.user_id !== reader.userId) return new Response(null, { status: 404 });
  // The DO trusts these headers only from this router: the Durable Object has no public route of its own.
  const forwarded = new Request(request.url, request);
  forwarded.headers.set('x-support-user', reader.userId);
  forwarded.headers.set('x-support-token-iat', String(reader.issuedAt));
  forwarded.headers.set('x-support-token-exp', String(reader.expiresAt));
  return conversation(env, conversationId).fetch(forwarded);
}

/** A screenshot from the panel: the chat token in Authorization, the raw image as the body (support/PROTOCOL.md §5.1). */
async function upload(request: Request, env: Env, conversationId: string): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Upload from the ${productName} dashboard.`);
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? null;
  const reader = await readChatToken(env.SUPPORT_ROOT_SECRET, token, conversationId);
  if (!reader) return fail(401, 'CHAT_TOKEN_INVALID', 'Renew the conversation through /chat/resume.', headers);
  const tooLarge = async () => {
    // Read and drop a modestly oversized body so the client sees the 413 instead of a reset connection; give up past 12 MB.
    const reader = request.body?.getReader();
    for (let seen = 0; reader && seen < 12 * 1024 * 1024;) { const { done, value } = await reader.read(); if (done) break; seen += value.length; }
    await reader?.cancel().catch(() => {});
    return fail(413, 'ATTACHMENT_TOO_LARGE', 'Images can be up to 5 MB.', headers);
  };
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return tooLarge();
  const bytes = await readCapped(request.body, MAX_IMAGE_BYTES);
  if (!bytes) return tooLarge();
  if (!bytes.length) return fail(400, 'INVALID_REQUEST', 'Send the image bytes as the request body.', headers);
  let name: string | null = null; try { name = decodeURIComponent(request.headers.get('x-filename') ?? '') || null; } catch { name = null; }
  const added = await conversation(env, conversationId).addAttachment({ userId: reader.userId, bytes, declared: request.headers.get('content-type'), name });
  return added.ok ? json({ attachment: added.attachment }, 201, headers) : fail(added.status, added.code, added.message, headers);
}

type Hook = { type?: string; data?: { messageId?: string; recipients?: string[]; message?: { id?: string; threadId?: string | null; direction?: string; from?: { address?: string }; to?: unknown; subject?: unknown; authentication?: { dmarc?: string | null } } } };

/** A verified, parsed Nightmail webhook delivery, deduplicated by webhook-id (after parsing, so a malformed one is retried). */
async function delivery(request: Request, env: Env, secret: string | undefined, name: string): Promise<{ event: Hook; deliveryId: string } | Response> {
  if (!secret) throw new MissingSecret(name);
  const body = await readCappedText(request, MAX_WEBHOOK_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  if (!(await verifyWebhook(body, request.headers, secret))) return new Response(null, { status: 401 });
  let event: Hook;
  try { event = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
  // A global brake before anything is recorded: Nightmail retries a 503 later (review M5).
  if (env.EMAIL_IN_GLOBAL && !(await env.EMAIL_IN_GLOBAL.limit({ key: 'global' })).success) return new Response(null, { status: 503, headers: { 'retry-after': '60' } });
  const deliveryId = request.headers.get('webhook-id')!;
  const fresh = await env.DB.prepare('INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(deliveryId, Date.now()).run();
  if (!fresh.meta.changes) return new Response(null, { status: 200 });
  return { event, deliveryId };
}

/** Runs a delivery's work; a failure forgets its webhook-id so Nightmail's retry is processed (the inboxes' primary keys
 * drop a message that was already stored). Success keeps the row, so a duplicate delivery is never processed twice. */
async function handled(env: Env, deliveryId: string, work: () => Promise<Response>): Promise<Response> {
  const forget = () => env.DB.prepare('DELETE FROM webhook_deliveries WHERE id = ?').bind(deliveryId).run()
    .catch(error => logError(error, { event: 'webhook', code: 'DELIVERY_FORGET_FAILED' }));
  let response: Response;
  try { response = await work(); }
  catch (error) { await forget(); throw error; }
  if (response.status >= 500) await forget();
  return response;
}

/** Nightmail's signed webhook for mail received at support@nightmail.dev (route → webhook:support-agent, bane format, include message). */
async function inbound(request: Request, env: Env): Promise<Response> {
  const got = await delivery(request, env, env.BANE_INBOUND_WEBHOOK_SECRET, 'BANE_INBOUND_WEBHOOK_SECRET');
  if (got instanceof Response) return got;
  const { event, deliveryId } = got;
  return handled(env, deliveryId, async () => {
    const message = event.data?.message, messageId = message?.id ?? event.data?.messageId;
    if (event.type !== 'message.received' || !messageId || message?.direction === 'outbound') return new Response(null, { status: 200 });
    const threadId = message?.threadId ?? messageId, sender = message?.from?.address?.toLowerCase() ?? 'unknown';
    if (await ledgered(env, 'support', messageId)) return new Response(null, { status: 200 });
    // The per-sender edge limit keeps a sender's DMARC-verified mail apart from mail that only claims its address, so
    // forged mail never limits the real sender; unverified mail is limited per address too, so one forger can't hold
    // every other unverified sender's mail (EMAIL_IN_GLOBAL bounds them all).
    const dmarcPass = String(message?.authentication?.dmarc ?? '').toUpperCase() === 'PASS';
    const rateKey = `${dmarcPass ? 'dmarc' : 'unauth'}:${await addressHash(sender)}`;
    if (env.EMAIL_IN && !(await env.EMAIL_IN.limit({ key: rateKey })).success) {
      await holdAtEdge(env, { messageId, threadId, sender, subject: typeof message?.subject === 'string' ? message.subject : null, reason: 'rate' });
      return new Response(null, { status: 200 });
    }
    // The Durable Object stores the message and arms its alarm, and the ledger row is written, before this answers 200:
    // from then on Nightmail's retry is never needed.
    return new Response(null, { status: await acceptSupport(env, { messageId, threadId, deliveryId, source: 'webhook' }) ? 200 : 503 });
  });
}

/**
 * Nightmail's wake after a staff reply (api/src/support-inbox.ts): `{ conversationId }` and a short-lived signature for that conversation. It only
 * makes that conversation pull its staff replies from Nightmail over the binding now instead of at the next sweep, so it
 * answers 202 whatever the ID (an unknown or closed conversation does nothing) and is rate-limited.
 */
async function wake(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const accepted = new Response(null, { status: 202 });
  const token = request.headers.get('authorization')?.match(/^Bearer (\S{1,4096})$/)?.[1];
  if (!token) return new Response(null, { status: 401 });
  const text = await readCappedText(request, MAX_WAKE_BYTES).catch(() => null);
  const body = text ? (() => { try { return JSON.parse(text) as { conversationId?: unknown }; } catch { return null; } })() : null;
  const id = typeof body?.conversationId === 'string' && CONVERSATION_ID.test(body.conversationId) ? body.conversationId : null;
  if (!id || !await env.BANE.verifyWake(token, id)) return new Response(null, { status: 401 });
  if (env.WAKE && !(await env.WAKE.limit({ key: 'wake' })).success) return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
  if (!(await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(id).first())) return accepted;
  ctx.waitUntil(conversation(env, id).wake().then(r => log('info', { event: 'inbox', code: 'SUPPORT_WOKEN', queued: r.queued }), error => logError(error, { event: 'inbox', code: 'SUPPORT_WAKE_FAILED' }, 'warn')));
  return accepted;
}

/** abuse@, privacy@, legal@ (route → webhook:support-intake): tickets only, never the agent (intake.ts). */
async function intake(request: Request, env: Env): Promise<Response> {
  const got = await delivery(request, env, env.BANE_INTAKE_WEBHOOK_SECRET, 'BANE_INTAKE_WEBHOOK_SECRET');
  if (got instanceof Response) return got;
  return handled(env, got.deliveryId, async () => {
    const { event } = got, message = event.data?.message, messageId = message?.id ?? event.data?.messageId;
    if (event.type !== 'message.received' || !messageId || message?.direction === 'outbound') return new Response(null, { status: 200 });
    // The envelope recipients Nightmail matched (so Bcc counts), else the To header.
    const recipients = (event.data?.recipients?.length ? event.data.recipients : [JSON.stringify(message?.to ?? '')]).join(' ').toLowerCase();
    const threadId = message?.threadId ?? messageId;
    if (await ledgered(env, 'intake', messageId)) return new Response(null, { status: 200 });
    // The intake address it was sent to: the acknowledgement names that one. Mail for an address the Worker doesn't list
    // is a configuration gap, not junk: kept, blocked, and accepted by the sweep once INTAKE_ADDRESSES lists it.
    const address = intakeAddress(env, recipients);
    if (!address) await blockUnconfigured(env, { messageId, threadId, recipients });
    else await acceptIntake(env, { messageId, threadId, address, source: 'webhook' });
    return new Response(null, { status: 200 });
  });
}

const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>${FAVICON_LINKS}
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#111}button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}p.muted{color:#666;font-size:.9rem}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * A confirm link from an earlier support reply. Email no longer unlocks anything, so the page changes nothing and shows
 * nothing from the email: it points to Help, where the person is signed in.
 */
function confirm(env: Env): Response {
  return page('Continue in Help', `<h1>Continue in Help</h1><p>To get help with your ${productName} account, sign in to <a href="${new URL(env.NIGHTMAIL_ORIGIN).origin}">${productName}</a> and press Help. There’s nothing to confirm here; you can close this page.</p>`);
}

/** Support chat lives in the dashboard's Help panel; direct visits to / or /chat (such as a handoff URL) land here instead of 404. */
function supportPage(env: Env): Response {
  const dashboard = new URL(env.NIGHTMAIL_ORIGIN).origin;
  return page(`${productName} Support`, `<h1>${productName} Support</h1><p>Support chat lives in the <a href="${dashboard}">${productName} dashboard</a>. Sign in and open Help, or email <a href="mailto:${addresses.support}">${addresses.support}</a> with your support reference.</p>`);
}

// Route templates for the request line, never the raw path: paths carry conversation and ticket IDs and confirm tokens,
// and queries carry chat tokens and attachment signatures.
async function route(request: Request, env: Env, url: URL, at: { route: string }, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname, name = (route: string) => { at.route = route; };
  if (path === '/health') {
    name('/health');
    // Liveness is `status` (the deploy reads it), whatever readiness says.
    const ready = await readiness(env).catch(error => { logError(error, { event: 'health', code: 'READINESS_UNAVAILABLE' }, 'warn'); return { ready: false }; });
    return json({ status: 'ok', service: 'bane-support', stage: env.STAGE, ...ready });
  }
  // (The brand's tab icon, for the tabs of this Worker's own pages.)
  const icon = request.method === 'GET' ? favicon(path) : null;
  if (icon) { name('/favicon'); return icon; }
  if (request.method === 'GET' && (path === '/' || path === '/chat')) { name(path); return supportPage(env); }
  if (request.method === 'OPTIONS' && (path.startsWith('/chat/') || /^\/c\/conv_[a-z2-7]{26}\/attachments$/.test(path))) {
    name(path.startsWith('/chat/') ? '/chat/*' : '/c/:conversationId/attachments');
    return new Response(null, { status: allowedOrigin(env, request) ? 204 : 403, headers: cors(env, request) });
  }
  if (request.method === 'POST' && path === '/chat/start') { name('/chat/start'); return startChat(request, env); }
  if (request.method === 'POST' && path === '/chat/resume') { name('/chat/resume'); return resumeChat(request, env); }
  const chat = path.match(/^\/c\/(conv_[a-z2-7]{26})$/);
  if (chat && request.method === 'GET') { name('/c/:conversationId'); return socket(request, env, chat[1]!); }
  const uploads = path.match(/^\/c\/(conv_[a-z2-7]{26})\/attachments$/);
  if (uploads && request.method === 'POST') { name('/c/:conversationId/attachments'); return upload(request, env, uploads[1]!); }
  const file = path.match(/^\/attachments\/(conv_[a-z2-7]{26})\/(att_[a-z2-7]{16})$/);
  if (file && request.method === 'GET') {
    name('/attachments/:conversationId/:attachmentId');
    // Staff open a screenshot from Nightmail's inbox with a short-lived token Nightmail signed for it, and Nightmail checks it.
    const staff = url.searchParams.get('staff');
    if (staff !== null) return staff && staff.length <= 4096 && await env.BANE.verifyFile(staff, file[1]!, file[2]!) ? serveAttachment(env, file[1]!, file[2]!) : new Response(null, { status: 404 });
    return await readAttachmentLink(env, file[1]!, file[2]!, url.searchParams.get('exp'), url.searchParams.get('sig')) ? serveAttachment(env, file[1]!, file[2]!) : new Response(null, { status: 403 });
  }
  if (request.method === 'POST' && path === '/hooks/bane-inbound') { name('/hooks/bane-inbound'); return inbound(request, env); }
  if (request.method === 'POST' && path === '/hooks/bane-intake') { name('/hooks/bane-intake'); return intake(request, env); }
  if (request.method === 'POST' && path === '/hooks/nightmail-wake') { name('/hooks/nightmail-wake'); return wake(request, env, ctx); }
  const link = path.match(/^\/confirm\/([A-Za-z0-9_.-]{20,400})$/);
  if (link && (request.method === 'GET' || request.method === 'POST')) { name('/confirm/:token'); return confirm(env); }
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now(), at = { route: 'unmatched' };
    let response: Response, failed: { error: unknown; code: string } | null = null;
    try { response = await route(request, env, new URL(request.url), at, ctx); }
    catch (error) {
      // Fail closed, loudly: a missing secret is a deploy mistake, never a reason to run without it.
      const missing = error instanceof MissingSecret ? error.secret : null;
      failed = { error, code: missing ? 'SECRET_MISSING' : 'UNHANDLED' };
      response = fail(503, 'SUPPORT_UNAVAILABLE', missing ? `Support is not fully configured (${missing} is missing).` : 'Support is unavailable right now. Try again in a minute.', cors(env, request));
    }
    // One line per request, like Nightmail's (api/src/app.ts): what answered, how, and how long it took; a crash adds its
    // error class, the missing secret's name and the stack to that same line.
    const status = response.status, line = { event: 'request', requestId: request.headers.get('cf-ray') ?? undefined, route: at.route, method: request.method, status, durationMs: Date.now() - started };
    if (failed) logError(failed.error, { ...line, code: failed.code });
    else log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', { ...line, code: failures.get(response) });
    return response;
  },
  /**
   * Daily at 00:10 UTC: the team's over-cap digest for yesterday, and the retention sweep. Every five minutes: the work
   * sweep (ledger.ts).
   */
  async scheduled(controller, env, ctx) {
    const started = Date.now(), job = controller.cron === '10 0 * * *' ? 'DAILY' : 'SWEEP';
    ctx.waitUntil((job === 'DAILY' ? daily(env, controller.scheduledTime) : sweep(env)).then(
      result => log('info', { event: 'scheduled', code: `SUPPORT_${job}`, durationMs: Date.now() - started, ...result }),
      error => logError(error, { event: 'scheduled', code: `SUPPORT_${job}_FAILED`, durationMs: Date.now() - started })));
  },
} satisfies ExportedHandler<Env>;
