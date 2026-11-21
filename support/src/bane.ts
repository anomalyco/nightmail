import type { Env } from './env.js';
import { readCapped } from './attachments.js';
import { MissingSecret } from './tokens.js';
import { productName } from '../../api/src/brand.js';

// Nightmail, from the support Worker's side. Two bindings to the same Nightmail Worker in the same account:
//
// - `BANE` → the `SupportPlatform` entrypoint (api/src/support-platform.ts, its source of truth): verify a handoff,
//   register and close a conversation, its stamped /v1/support/* requests (Nightmail derives the person from the
//   conversation's row), and the staff inbox: mirror each conversation's transcript and state, read whether staff paused
//   the agent, and pull and acknowledge staff replies. No token: the binding is the credential. The grant methods stay
//   declared for conversations opened before the stamp, until their grants lapse.
// - `BANE_API` → the default entrypoint, Nightmail's public API, as a customer of Nightmail would use it: the support@nightmail.dev
//   inbound address's own API key (BANE_SUPPORT_INBOX_KEY, limited to that address) reads support mail and sends replies and ticket emails.

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };
export type Handoff = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
  usedAt: string | null; grantId: string | null; message: string | null;
};
export type HandoffCheck = { ok: true; handoff: Handoff } | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };
export type Evidence = { kind: 'dmarc'; result: 'pass'; aligned: true; messageId: string } | { kind: 'magic_link'; confirmedAt: string };
export type Grant = { id: string; token: string; userId: string; workspaceIds: string[]; ticketRef: string; contentShared: boolean; contentWorkspaceId: string | null; expiresAt: string };
/** A transcript entry mirrored into the staff inbox. Staff replies come from the inbox, never from here. */
export type MirroredMessage = { id: string; author: 'customer' | 'agent' | 'system'; kind?: string | null; text: string; tools?: { label: string; ok: boolean }[]; attachments?: string[];
  delivery?: 'sent' | 'failed' | 'held'; at?: string };
export type MirroredState = { subject?: string; ticket?: { id: string; type: string; severity: 'P1' | 'P2' | 'P3' }; turns?: number; costUsd?: number; blockedWork?: number; pauseForTicket?: true };
/** Whether staff paused the agent: checked before every turn and every send. */
export type InboxState = { id: string; status: 'open' | 'ticketed' | 'closed'; agentState: 'active' | 'paused'; pausedBy: 'staff' | 'ticket' | null; pausedAt: string | null; queuedReplies: number };
/** A staff reply waiting for this Worker to deliver it. */
export type OutboxReply = { id: string; conversationId: string; channel: 'chat' | 'email'; text: string; staffName: string | null; createdAt: string };
/** How Nightmail knows who a conversation is for: its own signed handoff, or a message it received at a support address. */
export type ConversationEvidence = { kind: 'handoff'; token: string } | { kind: 'email'; messageId: string };
export type Mode = 'member' | 'non_member' | 'pending_signin' | 'unverified';
export type Verification = 'handoff' | 'dmarc' | 'signin' | 'none';
/** A registration's answer (POST /v1/operator/support/conversations): Nightmail's decision about the conversation. */
export type RegisteredConversation = { id: string; channel: 'chat' | 'email'; mode: Mode; verification: Verification; status: 'open' | 'ticketed' | 'closed'; workspaceId: string | null; contentShared: boolean; created: boolean };
export type ScopeWorkspace = { id: string; name: string; role: 'owner' | 'admin' | 'member' };
/** GET /v1/support/scope: who the conversation is for and what it can read now, read at the start of every turn. */
export type Scope = {
  /** signedInAt: when the person last signed in to continue it (a claim), also when it was already bound to them. */
  conversation: { id: string; channel: 'chat' | 'email'; mode: Mode; verification: Verification; signedInAt?: string | null };
  user: { name: string | null; email: string | null };
  workspace: ScopeWorkspace | null; workspaces: ScopeWorkspace[]; contentWorkspaceId: string | null; page: string | null;
  /** The person lost a workspace this conversation read: end it without restating anything. */
  shrunk: boolean;
};

/** The methods of Nightmail's SupportPlatform entrypoint, as this Worker calls them over RPC. */
export interface SupportPlatform {
  verifyHandoff(token: string): Promise<HandoffCheck>;
  verifyEmail(body: { email: string; evidence: Evidence; ticketRef?: string }): Promise<PlatformReply<{ verified: boolean; user: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[] }>>;
  mintGrant(body: { userId: string; ticketRef: string; reason: string; verification: 'handoff' | 'dmarc' | 'magic_link'; handoffId?: string; workspaceIds?: string[]; ttlMinutes?: number }): Promise<PlatformReply<Grant>>;
  revokeGrant(grantId: string): Promise<PlatformReply<{ id: string; revoked: true }>>;
  read<T = unknown>(path: string, grant: string): Promise<PlatformReply<T>>;
  /** Nightmail checks the evidence itself and decides who the conversation is for (201 new, 200 repeated). */
  registerConversation(body: { conversationId: string; evidence: ConversationEvidence }): Promise<PlatformReply<RegisteredConversation>>;
  /** Every later request for the conversation is refused. Repeating it is harmless. */
  closeConversation(conversationId: string): Promise<PlatformReply<{ id: string; status: 'closed'; closedAt: string }>>;
  /** A /v1/support GET, or POST /v1/support/scope or notes, for one registered conversation: Nightmail stamps the person. */
  request<T = unknown>(conversationId: string, method: string, path: string, body?: unknown): Promise<PlatformReply<T>>;
  /** A staff sign-in token from Nightmail's operator check: still an active operator? (staff.ts) */
  verifyStaff(token: string): Promise<{ ok: true; staff: { userId: string; email: string; role: string }; jti: string; expiresAt: string } | { ok: false; code: 'STAFF_INVALID' | 'STAFF_EXPIRED' | 'NOT_OPERATOR' }>;
  // The staff inbox (api/src/support-inbox.ts). A conversation Nightmail doesn't know (not registered) answers 404.
  mirrorMessages(conversationId: string, messages: MirroredMessage[]): Promise<PlatformReply<{ data: { id: string; seq: number; created: boolean }[] }>>;
  mirrorState(conversationId: string, state: MirroredState): Promise<PlatformReply<InboxState>>;
  inboxState(conversationId: string): Promise<PlatformReply<InboxState>>;
  pullOutbox(conversationId?: string): Promise<PlatformReply<{ data: OutboxReply[] }>>;
  markDelivery(conversationId: string, messageId: string, status: 'sent' | 'failed'): Promise<PlatformReply<{ id: string; delivery: 'sent' | 'failed'; deliveredAt: string | null }>>;
}
/** A platform reply's body, or (any other status than `ok`) a BaneError the work queue can classify. */
export function platformBody<T>(reply: PlatformReply<T>, ok = [200, 201]): T {
  if (ok.includes(reply.status)) return reply.body;
  const code = (reply.body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP_${reply.status}`;
  throw new BaneError(reply.status, code, `Nightmail answered ${reply.status} (${code})`, reply.requestId, reply.retryAfter);
}

export class BaneError extends Error {
  readonly retryAt: number | null;
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null = null, retryAfter: string | null = null) {
    super(message);
    const now = Date.now(), value = retryAfter?.trim() ?? '';
    const at = /^\d+$/.test(value) ? now + Number(value) * 1000 : /^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN;
    this.retryAt = at > now ? Math.min(at, now + 86_400_000) : null;
  }
}

/**
 * Nightmail's public API over the BANE_API binding, with the support address's API key, or (`intake`) the key for the
 * abuse@, privacy@ and legal@ addresses.
 */
export function baneApi(env: Env, which: 'support' | 'intake' = 'support') {
  const key = which === 'intake' ? env.BANE_INTAKE_INBOX_KEY : env.BANE_SUPPORT_INBOX_KEY, secret = which === 'intake' ? 'BANE_INTAKE_INBOX_KEY' : 'BANE_SUPPORT_INBOX_KEY';
  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!key) throw new MissingSecret(secret);
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'bane-support' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await env.BANE_API.fetch(`${env.BANE_ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
      throw new BaneError(response.status, error?.code ?? 'BANE_ERROR', error?.message ?? `${productName} answered ${response.status}`, error?.requestId ?? response.headers.get('x-request-id'), response.headers.get('retry-after'));
    }
    return parsed as T;
  }
  return {
    /**
     * A received message with the sender's authentication results (SPF, DKIM, DMARC) and Nightmail's automated-mail flag, for
     * sender checks. Address-limited API keys can't read the delivery projection (envelopes, headers), and don't need it.
     */
    message: (messageId: string) => call<InboundMessage>('GET', `/v1/inbound/messages/${encodeURIComponent(messageId)}?includeAuthentication=true`),
    /** One attachment's bytes (≤ limit, else null), through the short-lived signed link Nightmail returns for it. */
    async part(messageId: string, partId: string, limit: number): Promise<Uint8Array | null> {
      const { url } = await call<{ url: string }>('GET', `/v1/inbound/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`);
      // Mail stored in R2 is served by Nightmail itself: stay on the binding for Nightmail's origin, and fetch other storage directly.
      // Workers have no redirect: 'error'; a redirect is not followed, and fails the ok check below.
      const response = new URL(url).origin === new URL(env.BANE_ORIGIN).origin ? await env.BANE_API.fetch(url, { redirect: 'manual' }) : await fetch(url, { redirect: 'manual' });
      if (!response.ok) throw new BaneError(response.status, 'ATTACHMENT_UNAVAILABLE', `Storage answered ${response.status} for an attachment`, null, response.headers.get('retry-after'));
      if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); return null; }
      return readCapped(response.body, limit);
    },
    /** A new conversation from the support address, or from `addressId` when the caller pinned one (ticket emails, the chat follow-up thread). */
    startThread: (input: { to: string[]; subject: string; text: string; replyTo?: string[]; addressId?: string }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', '/v1/inbound/threads', { addressId: env.SUPPORT_ADDRESS_ID, ...input }, idempotencyKey),
    /**
     * A reply in an email conversation, only to the reviewed recipients (Nightmail refuses a reply whose recipients changed),
     * from the address and under the key chosen once when the reply was queued (conversation.ts `route`). addressId null:
     * the address the message came in on. A retry sends the same request, so Nightmail replays it instead of sending twice.
     */
    reply: (threadId: string, input: { replyToMessageId: string; text: string; to: string; subject?: string; addressId: string | null }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', `/v1/inbound/threads/${encodeURIComponent(threadId)}/reply`, {
        ...(input.addressId === null ? {} : { addressId: input.addressId }), replyToMessageId: input.replyToMessageId, text: input.text, to: [input.to], cc: [], expectedRecipients: { to: [input.to], cc: [], bcc: [] },
        ...(input.subject ? { subject: input.subject } : {}),
      }, idempotencyKey),
  };
}
export type BaneApi = ReturnType<typeof baneApi>;

export type InboundMessage = {
  id: string; threadId: string | null; direction: 'inbound' | 'outbound'; subject: string | null;
  from: { name: string | null; address: string } | string | null; fromAddress?: string;
  to?: unknown; cc?: unknown; replyTo?: unknown; text?: string | null;
  replyText?: string | null; messageId?: string | null; inReplyTo?: string | null; references?: unknown;
  attachments?: { id: string; filename: string | null; contentType: string; size: number; disposition?: string }[];
  /** With includeAuthentication=true. dmarc is PASS when the From domain aligns with a passing SPF or DKIM result. */
  authentication?: { spf: string | null; dkim: string | null; dmarc: string | null };
  /** Nightmail's flag for auto-replies, bounces, delivery reports, and bulk or list mail. */
  automated?: boolean;
};

/** The sender address of a received message, whichever shape the API returns. */
export function senderOf(message: Pick<InboundMessage, 'from' | 'fromAddress'>): string | null {
  const from = message.from;
  const value = typeof from === 'string' ? from : from?.address ?? message.fromAddress ?? null;
  return value ? value.trim().toLowerCase() : null;
}
