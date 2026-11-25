import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors, isoTime, json, log, nextCursor, notFound, readCursor, response, type App, type Config, type Ctx, type DbExecutor } from './core.js';
import { auditInsert, operatorContext, operatorRequired } from './audit.js';
import { mutate, operatorActor, type OperatorIdentity } from './operator.js';
import type { OperatorRole } from './operator-identity.js';
import { supportPlatformOnly } from './support-conversations.js';
import { CONVERSATION_ID, signSupportToken, type InboxState, type OutboxReply } from './support-platform.js';

// The support inbox (api/README.md "Support integration"): every support conversation, its transcript and the staff
// replies to it. Internal, in two halves:
//
// - The support platform writes it through its service binding only (/v1/operator/support/…): it mirrors each
//   conversation's transcript and state, reads whether staff paused the agent, pulls the staff replies it delivers and
//   records their delivery.
// - Operators read it from their own dashboard session (/v1/operator/support-inbox/…, deliberately outside the
//   binding's /v1/operator/support/ prefix, so the support platform can never reach it). operator:read reads; only the
//   operator role replies, pauses and hands back, resolves a ticket or wakes the support platform.
//
// A staff reply is queued here, pauses the agent, and wakes the support platform with nothing but the conversation's ID
// (POST <support site>/hooks/nightmail-wake): it pulls the reply through the binding and delivers it. Staff can reply only
// while the support platform has pulled the outbox in the last 10 minutes, so no reply waits for a platform that is gone.
// Transcripts are deleted 90 days after their conversation closes (src/maintenance.ts).
//
// Needs you, the inbox's default view, is what only a person can move forward. A conversation needs staff when nobody
// marked it done since anything new happened (a message, a failed delivery, more blocked work, a ticket, a pause) and at
// least one of these holds:
// - ticket: its ticket is open (the agent escalated what it could not resolve);
// - blocked: the support platform has work for it that it could not finish;
// - failed: its latest answer or staff reply failed to send;
// - paused: the agent is paused (by staff, or after an emailed ticket), the conversation is open, and staff owe the
//   next message (someone other than staff wrote last).
// Most urgent first: a P1 ticket, then a customer nobody else will answer (they wrote last and the agent is paused or
// blocked, or the last answer failed), then a P2 ticket, then the rest; within each, the longest waiting first. Agent
// handling is every other open conversation whose agent is active. Each operator also keeps their own read marker.

const MESSAGE_ID = /^msg_[a-z2-7]{16}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newMessageId = () => `msg_${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => BASE32[b & 31]).join('')}`;
/** The ticket types the support platform files. */
const TICKET_TYPES = ['billing', 'bug', 'deliverability', 'account', 'abuse_report', 'privacy', 'legal', 'feature_request', 'other'] as const;
/** How recently the support platform must have pulled the outbox for staff to reply. */
const REPLY_WINDOW = sql`interval '10 minutes'`;
/** How long the operator who marked a conversation done can undo it. */
const UNDO_MINUTES = 10, UNDO_WINDOW = sql`${`${UNDO_MINUTES} minutes`}::interval`;
const WAKE_TIMEOUT_MS = 3000;
const TRANSCRIPT_LIMIT = 500;

const Author = z.enum(['customer', 'agent', 'staff', 'system']);
const Delivery = z.enum(['queued', 'sent', 'failed', 'held']);
const Tool = z.object({ label: z.string().trim().min(1).max(80), ok: z.boolean() }).strict();
const Ticket = z.object({ id: z.string(), type: z.string().nullable(), severity: z.string().nullable(), resolvedAt: z.string().nullable() });
const ConversationParam = z.object({ id: z.string().regex(CONVERSATION_ID) });
const DoneBody = z.object({ ticketId: z.string().max(100).nullable().optional().describe('The ticket on screen when Done was pressed (null for none). Omit to resolve whatever ticket is open.') }).strict();
const TRIAGE_REASONS = ['ticket', 'blocked', 'failed', 'paused'] as const;

const Message = z.object({
  id: z.string(), seq: z.number().int(), author: Author, kind: z.string().nullable(), text: z.string(),
  tools: z.array(z.object({ label: z.string(), ok: z.boolean() })).describe('The agent’s tool calls by label and outcome; never their content.'),
  attachments: z.array(z.string()).describe('Attachment IDs, held by the support platform.'),
  staff: z.object({ userId: z.string(), name: z.string().nullable() }).nullable().describe('Who wrote a staff reply.'),
  delivery: Delivery.nullable().describe('A staff reply: queued until the support platform delivers it, then sent (or failed). An agent answer: sent, or held (frozen before a staff reply, never sent).'),
  deliveredAt: z.string().nullable(), at: z.string(),
}).openapi('SupportInboxMessage');
const Item = z.object({
  id: z.string(), channel: z.enum(['chat', 'email']), mode: z.enum(['member', 'non_member', 'pending_signin', 'unverified']), verification: z.enum(['handoff', 'dmarc', 'signin', 'none']),
  status: z.enum(['open', 'ticketed', 'closed']), subject: z.string().nullable(),
  customer: z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable().describe('The person Nightmail bound the conversation to, or null.'),
  sender: z.string().nullable().describe('An email conversation’s sender address, whether or not it proved who it is.'),
  workspace: z.object({ id: z.string(), name: z.string() }).nullable().describe('The one workspace in scope (a chat’s, or the one an email narrowed to).'),
  ticket: Ticket.nullable(),
  agentState: z.enum(['active', 'paused']),
  pausedBy: z.object({ kind: z.enum(['staff', 'ticket']), userId: z.string().nullable(), name: z.string().nullable() }).nullable(), pausedAt: z.string().nullable(),
  lastAuthor: Author.nullable().describe('Who wrote last, leaving out the support platform’s own notices (system).'), needsReply: z.boolean().describe('Not closed, and the customer wrote last.'),
  messageCount: z.number().int(), queuedReplies: z.number().int(), turns: z.number().int(), costUsd: z.number(),
  blockedWork: z.number().int().describe('Work the support platform could not finish for this conversation.'),
  firstLine: z.string().nullable().describe('The first line of the customer’s first message: what a conversation without a subject is about.'),
  needsYou: z.object({
    reasons: z.array(z.enum(TRIAGE_REASONS)).min(1).describe('ticket: its ticket is open; blocked: the support platform could not finish work for it; failed: its latest answer or staff reply failed to send; paused: the agent is paused and staff owe the next message.'),
    urgent: z.boolean().describe('A P1 ticket, or a customer nobody else will answer.'),
    since: z.string().describe('When it started waiting on staff.'),
  }).nullable().describe('Why staff must handle it (the needs_you view), or null.'),
  done: z.object({ at: z.string(), userId: z.string(), name: z.string().nullable() }).nullable().describe('Staff marked it done and nothing new has happened since.'),
  unread: z.boolean().describe('It has messages the signed-in operator has not read.'),
  createdAt: z.string(), lastMessageAt: z.string().nullable(), closedAt: z.string().nullable(),
}).openapi('SupportInboxConversation');
const Detail = z.object({
  conversation: Item.extend({
    threadId: z.string().nullable(), page: z.string().nullable().describe('The dashboard page a chat was opened from.'), contentWorkspaceId: z.string().nullable(),
    evidence: z.object({ handoff: z.string().nullable(), message: z.string().nullable(), dmarc: z.string().nullable(), dkimAligned: z.boolean().nullable(), claimedAt: z.string().nullable() })
      .describe('What Nightmail checked to bind it: the handoff, or the support email and its DMARC verdict, and when the person claimed it signed in.'),
  }),
  messages: z.array(Message).describe(`The transcript, oldest first: its last ${TRANSCRIPT_LIMIT} entries.`), earlierMessages: z.number().int(),
  customer: z.object({
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), emailVerified: z.boolean(), createdAt: z.string() }).nullable(),
    workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), joinedAt: z.string(), createdAt: z.string(), members: z.number().int(),
      inScope: z.boolean(), contentShared: z.boolean(), sending: z.object({ kind: z.string(), region: z.string().nullable(), paused: z.boolean() }).nullable(), standing: z.string().nullable() })),
    conversations: z.array(z.object({ id: z.string(), channel: z.string(), mode: z.string(), verification: z.string(), status: z.string(), subject: z.string().nullable(), ticket: Ticket.nullable(),
      createdAt: z.string(), lastMessageAt: z.string().nullable() })).describe('Their other support conversations, newest first: the same person’s; for a conversation bound to nobody, the others from its address that are bound to nobody either.'),
    activity: z.array(z.object({ id: z.string(), at: z.string(), action: z.string(), workspaceId: z.string().nullable(), actorType: z.string(), via: z.string(), internal: z.boolean(),
      summary: z.record(z.string(), z.unknown()) })).describe('Their latest 20 audit entries, without support’s own per-request reads or staff opening the inbox.'),
    notes: z.array(z.object({ id: z.string(), text: z.string(), author: z.enum(['agent', 'staff']), workspaceId: z.string().nullable(), conversationId: z.string(), createdAt: z.string() }))
      .describe('Every live note support keeps about the person (src/support-notes.ts), whatever their memberships now, newest first.'),
  }),
  replyAvailable: z.boolean(),
}).openapi('SupportInboxDetail');
const State = z.object({
  id: z.string(), status: z.enum(['open', 'ticketed', 'closed']), agentState: z.enum(['active', 'paused']), pausedBy: z.enum(['staff', 'ticket']).nullable(), pausedAt: z.string().nullable(),
  ticket: Ticket.nullable(), queuedReplies: z.number().int(),
}).openapi('SupportInboxState');

// ---------- reading conversations ----------

type ItemRow = { id: string; channel: 'chat' | 'email'; mode: z.infer<typeof Item>['mode']; verification: z.infer<typeof Item>['verification']; status: z.infer<typeof Item>['status']; subject: string | null;
  pending_address: string | null; user_id: string | null; user_name: string | null; user_email: string | null; workspace_id: string | null; workspace_name: string | null;
  ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null; agent_state: 'active' | 'paused'; paused_by: string | null;
  paused_by_name: string | null; paused_at: string | null; messages: number; turns: number; cost_usd: number | string; blocked_work: number; created_at: string; last_message_at: string | null;
  closed_at: string | null; activity_at: string; last_author: z.infer<typeof Author> | null; queued: number; opening: string | null; done_at: string | null; done_by: string | null; done_by_name: string | null;
  unread: boolean; needs_you: boolean; urgency: number; since: string | null } & Record<`why_${(typeof TRIAGE_REASONS)[number]}`, boolean>;
const itemColumns = sql`c.id, c.channel, c.mode, c.verification, c.status, c.subject, c.pending_address, c.user_id, u.name AS user_name, u.email AS user_email,
  c.workspace_id, w.name AS workspace_name, c.ticket_id, c.ticket_type, c.ticket_severity, c.ticket_resolved_at::text AS ticket_resolved_at,
  c.agent_state, c.paused_by, p.name AS paused_by_name, c.paused_at::text AS paused_at, c.messages, c.turns, c.cost_usd, c.blocked_work,
  c.created_at::text AS created_at, c.last_message_at::text AS last_message_at, c.closed_at::text AS closed_at, coalesce(c.last_message_at, c.created_at)::text AS activity_at,
  last.author AS last_author, (SELECT count(*)::int FROM support_messages q WHERE q.conversation_id = c.id AND q.delivery = 'queued') AS queued,
  opening.text AS opening, c.done_at::text AS done_at, c.done_by, (SELECT name FROM nightmail_users WHERE id = c.done_by) AS done_by_name,
  c.messages > coalesce(rd.seq, 0) AS unread, triage.needs_you, triage.urgency, triage.since::text AS since,
  why.ticket AS why_ticket, why.blocked AS why_blocked, why.failed AS why_failed, why.paused AS why_paused`;
// One conversation as the inbox lists it to one operator (`me`: their read marker), with its triage (Needs you, above).
const itemFrom = (me: string) => sql`support_conversations c LEFT JOIN nightmail_users u ON u.id = c.user_id LEFT JOIN workspaces w ON w.id = c.workspace_id
  LEFT JOIN nightmail_users p ON p.id = c.paused_by
  LEFT JOIN support_inbox_reads rd ON rd.conversation_id = c.id AND rd.user_id = ${me}
  LEFT JOIN LATERAL (SELECT m.author FROM support_messages m WHERE m.conversation_id = c.id AND m.author <> 'system' ORDER BY m.seq DESC LIMIT 1) last ON true
  LEFT JOIN LATERAL (SELECT left(m.text, 400) AS text FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) opening ON true
  LEFT JOIN LATERAL (SELECT a.delivery = 'failed' AS failed, a.created_at FROM support_messages a
    WHERE a.conversation_id = c.id AND a.author IN ('agent','staff') AND a.delivery IN ('queued','sent','failed') ORDER BY a.seq DESC LIMIT 1) answer ON true
  LEFT JOIN LATERAL (SELECT min(m.created_at) AS at FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer'
    AND m.seq > coalesce((SELECT max(o.seq) FROM support_messages o WHERE o.conversation_id = c.id AND o.author NOT IN ('customer','system')), 0)) waiting ON true
  CROSS JOIN LATERAL (SELECT c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL AS ticket, c.blocked_work > 0 AS blocked, coalesce(answer.failed, false) AS failed,
    c.agent_state = 'paused' AND c.status <> 'closed' AND last.author IS DISTINCT FROM 'staff' AS paused) why
  CROSS JOIN LATERAL (SELECT c.done_at IS NULL AND (why.ticket OR why.blocked OR why.failed OR why.paused) AS needs_you,
    CASE WHEN why.ticket AND c.ticket_severity = 'P1' THEN 1 WHEN why.failed OR (last.author = 'customer' AND (why.paused OR why.blocked)) THEN 2
      WHEN why.ticket AND c.ticket_severity = 'P2' THEN 3 ELSE 4 END AS urgency,
    least(CASE WHEN why.ticket THEN coalesce(c.ticket_at, c.created_at) END, CASE WHEN why.paused THEN coalesce(waiting.at, c.paused_at) END,
      CASE WHEN why.failed THEN answer.created_at END, CASE WHEN why.blocked THEN coalesce(c.last_message_at, c.created_at) END) AS since) triage`;
/** The conversations Needs you and Agent handling can hold: open ones, and closed ones with an open ticket, blocked work or a transcript (failed deliveries). */
const triageCandidates = sql`(c.status <> 'closed' OR c.closed_at > now() - interval '90 days' OR c.blocked_work > 0 OR (c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL))`;
const handling = sql`c.status <> 'closed' AND c.agent_state = 'active' AND NOT triage.needs_you`;
const firstLine = (text: string | null) => text?.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? null;
const ticketOf = (r: { ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null }) =>
  r.ticket_id ? { id: r.ticket_id, type: r.ticket_type, severity: r.ticket_severity, resolvedAt: isoTime(r.ticket_resolved_at) } : null;
const item = (r: ItemRow): z.infer<typeof Item> => ({
  id: r.id, channel: r.channel, mode: r.mode, verification: r.verification, status: r.status, subject: r.subject,
  customer: r.user_id ? { userId: r.user_id, name: r.user_name, email: r.user_email } : null, sender: r.pending_address,
  workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? r.workspace_id } : null, ticket: ticketOf(r),
  agentState: r.agent_state, pausedAt: isoTime(r.paused_at),
  pausedBy: r.agent_state !== 'paused' ? null : r.paused_by === 'ticket' ? { kind: 'ticket', userId: null, name: null } : { kind: 'staff', userId: r.paused_by, name: r.paused_by_name },
  lastAuthor: r.last_author, needsReply: r.status !== 'closed' && r.last_author === 'customer',
  messageCount: r.messages, queuedReplies: r.queued, turns: r.turns, costUsd: Number(r.cost_usd), blockedWork: r.blocked_work, firstLine: firstLine(r.opening),
  needsYou: r.needs_you ? { reasons: TRIAGE_REASONS.filter(reason => r[`why_${reason}`]), urgent: r.urgency <= 2, since: isoTime(r.since)! } : null,
  done: r.done_at && r.done_by ? { at: isoTime(r.done_at)!, userId: r.done_by, name: r.done_by_name } : null, unread: r.unread,
  createdAt: isoTime(r.created_at)!, lastMessageAt: isoTime(r.last_message_at), closedAt: isoTime(r.closed_at),
});
async function one(db: DbExecutor, id: string, me: string) {
  const { rows: [row] } = await db.execute<ItemRow>(sql`SELECT ${itemColumns} FROM ${itemFrom(me)} WHERE c.id = ${id}`);
  return row ? item(row) : notFound('Support conversation');
}
const replyAvailable = sql`coalesce((SELECT polled_at > now() - ${REPLY_WINDOW} FROM support_outbox_polls WHERE id = 1), false)`;
/** One operator has read a conversation through `seq` (an expression over the conversation's row): an upsert that never moves their marker back. Returns the marker. */
const markRead = (me: string, id: string, seq: SQL) => sql`INSERT INTO support_inbox_reads(user_id, conversation_id, seq) SELECT ${me}, id, ${seq} FROM support_conversations WHERE id = ${id}
  ON CONFLICT (user_id, conversation_id) DO UPDATE SET seq = greatest(support_inbox_reads.seq, excluded.seq), read_at = now() RETURNING seq`;

type MessageRow = { id: string; seq: number; author: z.infer<typeof Author>; kind: string | null; text: string; tools: { label: string; ok: boolean }[]; attachments: string[];
  staff_user_id: string | null; staff_name: string | null; delivery: z.infer<typeof Delivery> | null; delivered_at: string | null; created_at: string };
const messageColumns = sql`id, seq, author, kind, text, tools, attachments, staff_user_id, (SELECT name FROM nightmail_users WHERE id = staff_user_id) AS staff_name, delivery,
  delivered_at::text AS delivered_at, created_at::text AS created_at`;
const message = (m: MessageRow): z.infer<typeof Message> => ({ id: m.id, seq: m.seq, author: m.author, kind: m.kind, text: m.text, tools: m.tools, attachments: m.attachments,
  staff: m.staff_user_id ? { userId: m.staff_user_id, name: m.staff_name } : null, delivery: m.delivery, deliveredAt: isoTime(m.delivered_at), at: isoTime(m.created_at)! });

async function stateOf(db: DbExecutor, id: string): Promise<InboxState> {
  const { rows: [r] } = await db.execute<{ id: string; status: InboxState['status']; agent_state: InboxState['agentState']; paused_by: string | null; paused_at: string | null; ticket_id: string | null;
    ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null; queued: number }>(sql`SELECT id, status, agent_state, paused_by, paused_at::text AS paused_at,
      ticket_id, ticket_type, ticket_severity, ticket_resolved_at::text AS ticket_resolved_at,
      (SELECT count(*)::int FROM support_messages m WHERE m.conversation_id = c.id AND m.delivery = 'queued') AS queued
    FROM support_conversations c WHERE id = ${id}`);
  if (!r) notFound('Support conversation');
  return { id: r!.id, status: r!.status, agentState: r!.agent_state, pausedBy: r!.agent_state === 'paused' ? (r!.paused_by === 'ticket' ? 'ticket' : 'staff') : null, pausedAt: isoTime(r!.paused_at),
    ticket: ticketOf(r!), queuedReplies: r!.queued };
}

/**
 * Wakes the support platform for one conversation: a POST to its site's /hooks/nightmail-wake carrying only the
 * conversation's ID, never content. It then pulls the outbox through its binding (its sweep catches anything missed).
 * Skipped without NIGHTMAIL_SUPPORT_URL. Never throws: a failed wake leaves the reply queued for that sweep.
 */
export async function wakeSupport(config: Pick<Config, 'support' | 'publicUrl'>, conversationId: string): Promise<boolean> {
  const site = config.support?.url, key = config.support?.signingKey;
  if (!site || !key) return false;
  let url: URL;
  try { url = new URL('/hooks/nightmail-wake', new URL(site).origin); } catch { return false; }
  try {
    const token = await signSupportToken(key, { iss: config.publicUrl, aud: 'nightmail-support-wake', conversationId, exp: Math.floor(Date.now()/1000) + 60 });
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ conversationId }), redirect: 'manual', signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) });
    await res.body?.cancel();
    if (!res.ok) log('warn', { code: 'SUPPORT_WAKE_FAILED', status: res.status });
    return res.ok;
  } catch {
    log('warn', { code: 'SUPPORT_WAKE_FAILED' });
    return false;
  }
}

/** The signed-in operator, from their own dashboard session: never the support platform, a key or a customer. */
async function staff(c: Ctx, level: OperatorRole) {
  if (c.env.platformCaller || c.get('actor')?.credential !== 'dashboard') throw operatorRequired();
  return operatorActor(c, level);
}
const staffContext = (c: Ctx, operator: OperatorIdentity) => operatorContext(c, { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId });
const closedConversation = () => new ApiError(409, 'SUPPORT_CONVERSATION_CLOSED', 'This conversation is closed.');

export function registerSupportInbox(app: App) {
  const operatorSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
  const sessionSecurity: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const tags = ['Operator'];

  // ---------- the support platform's binding: the mirror, the state and the outbox ----------

  const MirrorMessage = z.object({
    id: z.string().regex(MESSAGE_ID).describe('The support platform’s message ID: appending it again changes nothing.'),
    author: z.enum(['customer', 'agent', 'system']).describe('Staff replies come from the inbox, never from a mirror.'),
    kind: z.string().regex(/^[a-z_]{1,32}$/).nullable().optional(),
    text: z.string().max(16_000),
    tools: z.array(Tool).max(50).default([]).describe('The agent’s tool calls: labels and outcomes only.'),
    attachments: z.array(z.string().regex(/^att_[a-z2-7]{16}$/)).max(20).default([]),
    delivery: z.enum(['sent', 'failed', 'held']).optional().describe('An agent answer only: sent, failed, or held (frozen before a staff reply and never sent).'),
    at: z.iso.datetime({ offset: true }).optional().describe('When it was written; default now, at most 5 minutes ahead.'),
  }).strict();
  app.openapi(createRoute({ hide: true, tags, security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations/{id}/messages', operationId: 'operatorMirrorSupportMessages',
    description: 'The support platform mirrors transcript entries into the inbox, in order (the binding only). Each is numbered on arrival; an ID already in this conversation is left as it is.',
    request: { params: ConversationParam, body: json(z.object({ messages: z.array(MirrorMessage).min(1).max(50) }).strict()) },
    responses: { 200: response(z.object({ data: z.array(z.object({ id: z.string(), seq: z.number().int(), created: z.boolean() })) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const id = c.req.valid('param').id, { messages } = c.req.valid('json');
    messages.forEach((m, i) => {
      if (m.delivery && m.author !== 'agent') throw new ApiError(422, 'VALIDATION_FAILED', 'Only an agent answer has a delivery.', `messages.${i}.delivery`);
      if (m.at && Date.parse(m.at) > Date.now() + 5 * 60_000) throw new ApiError(422, 'VALIDATION_FAILED', 'A message cannot be written in the future.', `messages.${i}.at`);
      if (messages.findIndex(other => other.id === m.id) !== i) throw new ApiError(422, 'VALIDATION_FAILED', 'Each message appears once.', `messages.${i}.id`);
    });
    const conflict = () => new ApiError(409, 'SUPPORT_MESSAGE_CONFLICT', 'A message with that ID belongs to another conversation.', 'messages');
    const data = await c.env.db.transaction(async tx => {
      // The conversation's row lock numbers its messages: every append (and every staff reply) takes it first.
      const { rows: [conv] } = await tx.execute<{ messages: number }>(sql`SELECT messages FROM support_conversations WHERE id = ${id} FOR NO KEY UPDATE`);
      if (!conv) notFound('Support conversation');
      const { rows: existing } = await tx.execute<{ id: string; conversation_id: string; seq: number }>(sql`SELECT id, conversation_id, seq FROM support_messages WHERE id = ANY(${sql.param(messages.map(m => m.id))}::text[])`);
      if (existing.some(e => e.conversation_id !== id)) throw conflict();
      const known = new Map(existing.map(e => [e.id, e.seq]));
      const fresh = messages.filter(m => !known.has(m.id)).map((m, i) => ({ ...m, seq: conv!.messages + i + 1 }));
      if (fresh.length) {
        const { rows: inserted } = await tx.execute<{ id: string }>(sql`INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, tools, attachments, delivery, created_at)
          SELECT m.id, ${id}, m.seq, m.author, m.kind, m.text, m.tools, m.attachments, m.delivery, coalesce(m.at, now())
          FROM jsonb_to_recordset(${JSON.stringify(fresh)}::jsonb) AS m(id text, seq int, author text, kind text, text text, tools jsonb, attachments jsonb, delivery text, at timestamptz)
          ON CONFLICT (id) DO NOTHING RETURNING id`);
        if (inserted.length !== fresh.length) throw conflict();
        // Something new: a conversation staff marked done comes back to Needs you if it needs them.
        await tx.execute(sql`UPDATE support_conversations SET messages = messages + ${fresh.length},
            last_message_at = greatest(last_message_at, (SELECT max(created_at) FROM support_messages WHERE conversation_id = ${id} AND seq > ${conv!.messages})),
            done_at = NULL, done_by = NULL
          WHERE id = ${id}`);
      }
      const numbered = new Map(fresh.map(m => [m.id, m.seq]));
      return messages.map(m => ({ id: m.id, seq: known.get(m.id) ?? numbered.get(m.id)!, created: !known.has(m.id) }));
    });
    return c.json({ data }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: operatorSecurity, method: 'get', path: '/v1/operator/support/conversations/{id}/state', operationId: 'operatorGetSupportInboxState',
    description: 'A conversation’s inbox state for the support platform (the binding only): whether staff paused the agent. Check it before every turn and every send.',
    request: { params: ConversationParam }, responses: { 200: response(State), ...errors } }), async c => {
    await supportPlatformOnly(c);
    return c.json(await stateOf(c.env.db, c.req.valid('param').id), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations/{id}/state', operationId: 'operatorMirrorSupportState',
    description: 'The support platform mirrors a conversation’s subject, ticket, counters and blocked work (the binding only), and may pause the agent after an emailed ticket. It never resumes one: only staff hand back.',
    request: { params: ConversationParam, body: json(z.object({
      subject: z.string().trim().min(1).max(200).optional(),
      ticket: z.object({ id: z.string().regex(/^tkt_[a-z2-7]{16}$/), type: z.enum(TICKET_TYPES), severity: z.enum(['P1', 'P2', 'P3']) }).strict().optional().describe('The conversation’s one ticket.'),
      turns: z.number().int().min(0).max(1_000_000).optional(), costUsd: z.number().min(0).max(100_000).optional(),
      blockedWork: z.number().int().min(0).max(100_000).optional().describe('Work items for this conversation that are blocked now.'),
      pauseForTicket: z.literal(true).optional().describe('Pause the agent after an emailed ticket. A conversation already paused stays as it is.'),
    }).strict()) },
    responses: { 200: response(State), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const id = c.req.valid('param').id, body = c.req.valid('json'), ticket = body.ticket ?? null, pause = body.pauseForTicket === true;
    // A new ticket, more blocked work or a pause is something new: it undoes staff's Done.
    const reopen = sql`(ticket_id IS NULL AND ${ticket?.id ?? null}::text IS NOT NULL) OR coalesce(${body.blockedWork ?? null}::int, blocked_work) > blocked_work OR (${pause} AND agent_state = 'active')`;
    const { rows } = await c.env.db.execute(sql`UPDATE support_conversations SET
        subject = coalesce(${body.subject ?? null}, subject),
        ticket_at = CASE WHEN ticket_id IS NULL AND ${ticket?.id ?? null}::text IS NOT NULL THEN now() ELSE ticket_at END,
        done_at = CASE WHEN ${reopen} THEN NULL ELSE done_at END, done_by = CASE WHEN ${reopen} THEN NULL ELSE done_by END,
        ticket_id = coalesce(ticket_id, ${ticket?.id ?? null}),
        ticket_type = coalesce(${ticket?.type ?? null}, ticket_type), ticket_severity = coalesce(${ticket?.severity ?? null}, ticket_severity),
        status = CASE WHEN ${ticket?.id ?? null}::text IS NOT NULL AND status = 'open' THEN 'ticketed' ELSE status END,
        turns = greatest(turns, ${body.turns ?? 0}::int), cost_usd = greatest(cost_usd, ${body.costUsd ?? 0}::numeric), blocked_work = coalesce(${body.blockedWork ?? null}::int, blocked_work),
        agent_state = CASE WHEN ${pause} THEN 'paused' ELSE agent_state END,
        paused_by = CASE WHEN ${pause} AND agent_state = 'active' THEN 'ticket' ELSE paused_by END,
        paused_at = CASE WHEN ${pause} AND agent_state = 'active' THEN now() ELSE paused_at END
      WHERE id = ${id} AND (${ticket?.id ?? null}::text IS NULL OR ticket_id IS NULL OR ticket_id = ${ticket?.id ?? null}) RETURNING id`);
    if (!rows.length) {
      await stateOf(c.env.db, id);
      throw new ApiError(409, 'SUPPORT_TICKET_EXISTS', 'This conversation already has another ticket.', 'ticket.id');
    }
    return c.json(await stateOf(c.env.db, id), 200);
  });

  const Reply = z.object({ id: z.string(), conversationId: z.string(), channel: z.enum(['chat', 'email']), text: z.string(), staffName: z.string().nullable(), createdAt: z.string() });
  app.openapi(createRoute({ hide: true, tags, security: operatorSecurity, method: 'get', path: '/v1/operator/support/outbox', operationId: 'operatorSupportOutbox',
    description: 'The staff replies waiting for the support platform to deliver (the binding only), oldest first; one conversation’s after its wake. Staff can reply only while this is pulled.',
    request: { query: z.object({ conversationId: z.string().regex(CONVERSATION_ID).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(Reply) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const q = c.req.valid('query');
    const { rows } = await c.env.db.execute<OutboxReply>(sql`WITH polled AS (
        INSERT INTO support_outbox_polls(id, polled_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET polled_at = excluded.polled_at)
      SELECT m.id, m.conversation_id AS "conversationId", c.channel, m.text, u.name AS "staffName", m.created_at::text AS "createdAt"
      FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id LEFT JOIN nightmail_users u ON u.id = m.staff_user_id
      WHERE m.delivery = 'queued' ${q.conversationId ? sql`AND m.conversation_id = ${q.conversationId}` : sql``}
      ORDER BY m.created_at, m.seq LIMIT ${q.limit}`);
    return c.json({ data: rows.map(r => ({ ...r, createdAt: isoTime(r.createdAt)! })) }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations/{id}/messages/{messageId}/delivery', operationId: 'operatorSupportReplyDelivery',
    description: 'The support platform records a staff reply’s delivery (the binding only): sent, or failed for good. A sent reply stays sent.',
    request: { params: ConversationParam.extend({ messageId: z.string().regex(MESSAGE_ID) }), body: json(z.object({ status: z.enum(['sent', 'failed']) }).strict()) },
    responses: { 200: response(z.object({ id: z.string(), delivery: z.enum(['sent', 'failed']), deliveredAt: z.string().nullable() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { id, messageId } = c.req.valid('param'), status = c.req.valid('json').status;
    // A reply that failed brings the conversation back to Needs you.
    const { rows: [row] } = await c.env.db.execute<{ id: string; delivery: 'sent' | 'failed'; delivered_at: string | null; changed: boolean }>(sql`WITH changed AS (
        UPDATE support_messages SET delivery = ${status}, delivered_at = CASE WHEN ${status} = 'sent' THEN now() END
        WHERE id = ${messageId} AND conversation_id = ${id} AND author = 'staff' AND delivery IN ('queued','failed')
        RETURNING id, delivery, delivered_at), reopened AS (
        UPDATE support_conversations SET done_at = NULL, done_by = NULL WHERE id = ${id} AND ${status} = 'failed' AND done_at IS NOT NULL AND EXISTS (SELECT FROM changed))
      SELECT id, delivery, delivered_at::text AS delivered_at, true AS changed FROM changed
      UNION ALL SELECT id, delivery, delivered_at::text, false FROM support_messages WHERE id = ${messageId} AND conversation_id = ${id} AND author = 'staff' AND NOT EXISTS (SELECT FROM changed)`);
    if (!row) notFound('Staff reply');
    if (row!.delivery !== status) throw new ApiError(409, 'SUPPORT_REPLY_DELIVERED', 'This reply was already delivered.', 'status');
    return c.json({ id: row!.id, delivery: row!.delivery, deliveredAt: isoTime(row!.delivered_at) }, 200);
  });

  // ---------- operators: the inbox ----------

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox', operationId: 'operatorListSupportConversations',
    description: 'Every support conversation, most recent activity first (needs_you: most urgent and longest waiting first). replyAvailable: whether staff can reply now (the support platform pulled replies in the last 10 minutes). counts: how many conversations need you and how many the agent is handling.',
    request: { query: z.object({
      view: z.enum(['all', 'needs_you', 'agent', 'tickets', 'needs_reply', 'paused', 'attention']).default('all')
        .describe('needs_you: what staff must handle (see needsYou); agent: open conversations the agent is handling on its own; tickets: an unresolved ticket; needs_reply: not closed, the customer wrote last; paused: the agent is paused; attention: blocked work.'),
      channel: z.enum(['chat', 'email']).optional(), status: z.enum(['open', 'ticketed', 'closed']).optional(),
      q: z.string().trim().min(1).max(200).optional().describe('A conversation, ticket or user ID, or part of a name, address or subject.'),
      cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }) },
    responses: { 200: response(z.object({ data: z.array(Item), nextCursor: z.string().nullable(), replyAvailable: z.boolean(),
      counts: z.object({ needsYou: z.number().int(), agent: z.number().int() }).describe('The needs_you and agent views’ sizes, whatever this request’s filters.') })), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), me = operator.userId;
    const q = c.req.valid('query'), binding = `support-inbox:${q.view}:${q.channel ?? ''}:${q.status ?? ''}:${q.q ?? ''}`, after = readCursor(q.cursor, binding);
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null, triaged = q.view === 'needs_you';
    const filters: SQL[] = [{
      all: sql`true`, needs_you: sql`${triageCandidates} AND triage.needs_you`, agent: handling,
      tickets: sql`c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL`, needs_reply: sql`c.status <> 'closed' AND last.author = 'customer'`,
      paused: sql`c.agent_state = 'paused'`, attention: sql`c.blocked_work > 0`,
    }[q.view]];
    if (q.channel) filters.push(sql`c.channel = ${q.channel}`);
    if (q.status) filters.push(sql`c.status = ${q.status}`);
    if (q.q) filters.push(sql`(c.id = ${q.q} OR c.ticket_id = ${q.q} OR c.user_id = ${q.q} OR c.pending_address ILIKE ${pattern} OR u.email ILIKE ${pattern} OR u.name ILIKE ${pattern} OR c.subject ILIKE ${pattern}
      OR (c.subject IS NULL AND opening.text ILIKE ${pattern}))`);
    // Needs you pages by (urgency, waiting since, ID): the cursor carries the urgency with the ID.
    if (after && triaged) {
      const [, urgency, id] = /^([1-4]):(conv_[a-z2-7]{26})$/.exec(after.id) ?? [];
      if (!id) throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor');
      filters.push(sql`(triage.urgency, triage.since, c.id) > (${Number(urgency)}::int, ${after.at}::timestamptz, ${id})`);
    } else if (after) filters.push(sql`(coalesce(c.last_message_at, c.created_at), c.id) < (${after.at}::timestamptz, ${after.id})`);
    const order = triaged ? sql`triage.urgency, triage.since, c.id` : sql`coalesce(c.last_message_at, c.created_at) DESC, c.id DESC`;
    const [{ rows }, { rows: [counts] }] = await Promise.all([
      c.env.db.execute<ItemRow & { available: boolean }>(sql`SELECT ${itemColumns}, ${replyAvailable} AS available FROM ${itemFrom(me)}
        WHERE ${sql.join(filters, sql` AND `)} ORDER BY ${order} LIMIT ${q.limit + 1}`),
      c.env.db.execute<{ needs_you: number; agent: number; available: boolean }>(sql`SELECT count(*) FILTER (WHERE triage.needs_you)::int AS needs_you,
          count(*) FILTER (WHERE ${handling})::int AS agent, ${replyAvailable} AS available FROM ${itemFrom(me)} WHERE ${triageCandidates}`),
    ]);
    const next = nextCursor(rows.map(r => triaged ? { id: `${r.urgency}:${r.id}`, createdAt: r.since! } : { id: r.id, createdAt: r.activity_at }), q.limit, binding);
    return c.json({ data: rows.slice(0, q.limit).map(item), nextCursor: next, replyAvailable: counts!.available, counts: { needsYou: counts!.needs_you, agent: counts!.agent } }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}', operationId: 'operatorGetSupportConversation',
    description: 'One conversation in one read: its transcript, and who the customer is (verification, workspaces and roles, their other conversations and tickets, recent activity, notes). Each read is on the audit trail.',
    request: { params: ConversationParam }, responses: { 200: response(Detail), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), id = c.req.valid('param').id;
    type Json = Record<string, unknown>;
    const viewed = auditInsert(staffContext(c, operator), { action: 'support.inbox_view', workspaceId: null, userId: sql`coalesce(conv.user_id, ${operator.userId})`,
      target: { type: 'support_conversation', id }, ticketRef: id, internal: true }, { from: sql`conv` });
    const { rows: [row] } = await c.env.db.execute<{ item: ItemRow; evidence: Json; thread_id: string | null; content_workspace_id: string | null; page: string | null; messages: MessageRow[];
      user: Json | null; workspaces: Json[]; conversations: (Json & { ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null })[];
      activity: Json[]; notes: Json[]; available: boolean }>(sql`WITH conv AS (SELECT * FROM support_conversations WHERE id = ${id}), logged AS (${viewed})
      SELECT (SELECT row_to_json(i) FROM (SELECT ${itemColumns} FROM ${itemFrom(operator.userId)} WHERE c.id = conv.id) i) AS item,
        conv.evidence, conv.thread_id, conv.content_workspace_id, (SELECT page FROM support_handoffs WHERE conversation_id = conv.id) AS page,
        (SELECT coalesce(json_agg(m ORDER BY m.seq), '[]') FROM (SELECT m.id, m.seq, m.author, m.kind, m.text, m.tools, m.attachments, m.staff_user_id, su.name AS staff_name, m.delivery,
          m.delivered_at::text AS delivered_at, m.created_at::text AS created_at FROM support_messages m LEFT JOIN nightmail_users su ON su.id = m.staff_user_id
          WHERE m.conversation_id = conv.id ORDER BY m.seq DESC LIMIT ${TRANSCRIPT_LIMIT}) m) AS messages,
        (SELECT json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'emailVerified', u.email_verified, 'createdAt', u.created_at) FROM nightmail_users u WHERE u.id = conv.user_id) AS user,
        (SELECT coalesce(json_agg(x ORDER BY x.name, x.id), '[]') FROM (SELECT w.id, w.name, m.role, m.created_at AS "joinedAt", w.created_at AS "createdAt",
            (SELECT count(*)::int FROM workspace_members o WHERE o.workspace_id = w.id) AS members, w.id = conv.workspace_id AS "inScope", w.id IS NOT DISTINCT FROM conv.content_workspace_id AS "contentShared",
            (SELECT json_build_object('kind', pc.kind, 'region', pc.region, 'paused', pc.paused_at IS NOT NULL) FROM provider_connections pc WHERE pc.workspace_id = w.id LIMIT 1) AS sending,
            (SELECT s.step FROM sender_standing s WHERE s.workspace_id = w.id) AS standing
          FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = conv.user_id ORDER BY w.name, w.id LIMIT 50) x) AS workspaces,
        (SELECT coalesce(json_agg(x ORDER BY x.activity DESC, x.id DESC), '[]') FROM (SELECT o.id, o.channel, o.mode, o.verification, o.status, o.subject, o.ticket_id, o.ticket_type, o.ticket_severity,
            o.ticket_resolved_at, o.created_at AS "createdAt", o.last_message_at AS "lastMessageAt", coalesce(o.last_message_at, o.created_at) AS activity FROM support_conversations o
          WHERE o.id <> conv.id AND CASE WHEN conv.user_id IS NOT NULL THEN o.user_id = conv.user_id
            ELSE o.user_id IS NULL AND lower(o.pending_address) = lower(conv.pending_address) END
          ORDER BY coalesce(o.last_message_at, o.created_at) DESC, o.id DESC LIMIT 20) x) AS conversations,
        (SELECT coalesce(json_agg(x ORDER BY x.at DESC, x.n DESC), '[]') FROM (SELECT 'aud_' || e.id AS id, e.id AS n, e.at, e.action, e.workspace_id AS "workspaceId", e.actor_type AS "actorType", e.via,
            e.internal, e.summary FROM audit_events e WHERE e.user_id = conv.user_id AND e.action NOT IN ('support.read', 'support.inbox_view') ORDER BY e.at DESC, e.id DESC LIMIT 20) x) AS activity,
        (SELECT coalesce(json_agg(x ORDER BY x."createdAt" DESC, x.id DESC), '[]') FROM (SELECT n.id, n.text, n.author, n.workspace_id AS "workspaceId", n.conversation_id AS "conversationId",
            n.created_at AS "createdAt" FROM support_notes n WHERE n.user_id = conv.user_id AND n.deleted_at IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 50) x) AS notes,
        ${replyAvailable} AS available
      FROM conv`);
    if (!row?.item) notFound('Support conversation');
    const r = row!, evidence = r.evidence as { handoff?: string; message?: string; dmarc?: string | null; dkimAligned?: boolean; claimedAt?: string };
    const at = (value: unknown) => isoTime(value as string | null);
    return c.json({
      conversation: { ...item(r.item), threadId: r.thread_id, page: r.page, contentWorkspaceId: r.content_workspace_id,
        evidence: { handoff: evidence.handoff ?? null, message: evidence.message ?? null, dmarc: evidence.dmarc ?? null, dkimAligned: evidence.dkimAligned ?? null, claimedAt: at(evidence.claimedAt) } },
      messages: r.messages.map(message), earlierMessages: Math.max(0, r.item.messages - r.messages.length),
      customer: {
        user: r.user ? { ...(r.user as { id: string; name: string | null; email: string | null; emailVerified: boolean }), createdAt: at(r.user.createdAt)! } : null,
        workspaces: r.workspaces.map(w => ({ ...w, joinedAt: at(w.joinedAt)!, createdAt: at(w.createdAt)! })) as z.infer<typeof Detail>['customer']['workspaces'],
        conversations: r.conversations.map(o => ({ id: o.id as string, channel: o.channel as string, mode: o.mode as string, verification: o.verification as string, status: o.status as string,
          subject: o.subject as string | null, ticket: ticketOf(o), createdAt: at(o.createdAt)!, lastMessageAt: at(o.lastMessageAt) })),
        activity: r.activity.map(({ n: _n, ...e }) => ({ ...e, at: at(e.at)! })) as z.infer<typeof Detail>['customer']['activity'],
        notes: r.notes.map(n => ({ ...n, createdAt: at(n.createdAt)! })) as z.infer<typeof Detail>['customer']['notes'],
      },
      replyAvailable: r.available,
    }, 200);
  });

  // Every staff change is one transaction with its internal audit row, and repeats safely with an Idempotency-Key.
  type Locked = { status: string; user_id: string | null; agent_state: string; ticket_id: string | null; ticket_resolved_at: string | null; done_at: string | null; done_by: string | null; undoable: boolean };
  const changeHeaders = z.object({ 'idempotency-key': z.string().min(1).max(200).optional() });
  async function change<T>(c: Ctx, id: string, action: string, work: (tx: DbExecutor, operator: OperatorIdentity, conversation: Locked) => Promise<{ result: T; message?: string }>, body?: unknown) {
    const operator = await staff(c, 'operator');
    let subject: string | null = null, messageId: string | undefined;
    return mutate(c, operator, '', body, async tx => {
      const { rows: [conversation] } = await tx.execute<Locked>(sql`SELECT status, user_id, agent_state, ticket_id, ticket_resolved_at::text AS ticket_resolved_at, done_at::text AS done_at,
          done_by, done_at > now() - ${UNDO_WINDOW} AS undoable
        FROM support_conversations WHERE id = ${id} FOR NO KEY UPDATE`);
      if (!conversation) notFound('Support conversation');
      subject = conversation!.user_id;
      const done = await work(tx, operator, conversation!);
      messageId = done.message;
      return { result: done.result, audit: { action, reason: action, ticketRef: id } };
    }, (tx, audit) => tx.execute(auditInsert(staffContext(c, operator), { action: audit.action, workspaceId: null, userId: subject ?? operator.userId, target: { type: 'support_conversation', id },
      details: messageId ? { message: messageId } : undefined, ticketRef: id, internal: true })));
  }

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/replies', operationId: 'operatorReplySupportConversation',
    description: 'Reply to the customer as staff (the operator role). The reply is queued for the support platform to deliver, the agent is paused until someone hands back, and the support platform is woken. Needs an Idempotency-Key: repeating it queues nothing new. Refused while the support platform is not pulling replies.',
    request: { params: ConversationParam, headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }), body: json(z.object({ text: z.string().trim().min(1).max(8000) }).strict()) },
    responses: { 201: response(Message), ...errors } }), async c => {
    const id = c.req.valid('param').id, body = c.req.valid('json');
    const reply = await change(c, id, 'support.reply', async (tx, operator, conversation) => {
      if (conversation.status === 'closed') throw closedConversation();
      if (!(await tx.execute<{ available: boolean }>(sql`SELECT ${replyAvailable} AS available`)).rows[0]!.available)
        throw new ApiError(409, 'SUPPORT_REPLY_UNAVAILABLE', 'The support platform has not collected replies in the last 10 minutes, so this reply could not be delivered. Try again once it is back.');
      const messageId = newMessageId();
      // The reply is new (it undoes Done), and its author has read everything up to it.
      const { rows: [row] } = await tx.execute<MessageRow>(sql`WITH c AS (
          UPDATE support_conversations SET messages = messages + 1, last_message_at = now(), agent_state = 'paused', paused_by = ${operator.userId},
            paused_at = CASE WHEN agent_state = 'paused' AND paused_by = ${operator.userId} THEN paused_at ELSE now() END, done_at = NULL, done_by = NULL
          WHERE id = ${id} RETURNING messages), seen AS (${markRead(operator.userId, id, sql`(SELECT messages FROM c)`)})
        INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, staff_user_id, delivery) SELECT ${messageId}, ${id}, c.messages, 'staff', 'reply', ${body.text}, ${operator.userId}, 'queued' FROM c
        RETURNING ${messageColumns}`);
      return { result: message(row!), message: messageId };
    }, body);
    if (c.env.deferNudge) c.env.deferNudge(async () => { await wakeSupport(c.env.config, id); });
    else await wakeSupport(c.env.config, id);
    return c.json(reply, 201);
  });

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/pause', operationId: 'operatorPauseSupportAgent',
    description: 'Pause the agent (the operator role): the support platform records and mirrors the customer’s messages but answers none until someone hands back.',
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.pause', async (tx, operator, conversation) => {
      if (conversation.status === 'closed') throw closedConversation();
      if (conversation.agent_state === 'paused') throw new ApiError(409, 'ALREADY_PAUSED', 'The agent is already paused here.');
      await tx.execute(sql`UPDATE support_conversations SET agent_state = 'paused', paused_by = ${operator.userId}, paused_at = now(), done_at = NULL, done_by = NULL WHERE id = ${id}`);
      return { result: await one(tx, id, operator.userId) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/resume', operationId: 'operatorResumeSupportAgent',
    description: 'Hand the conversation back to the agent (the operator role): it answers the customer’s next message.',
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.resume', async (tx, operator, conversation) => {
      if (conversation.status === 'closed') throw closedConversation();
      if (conversation.agent_state !== 'paused') throw new ApiError(409, 'NOT_PAUSED', 'The agent is not paused here.');
      await tx.execute(sql`UPDATE support_conversations SET agent_state = 'active', paused_by = NULL, paused_at = NULL WHERE id = ${id}`);
      return { result: await one(tx, id, operator.userId) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/resolve', operationId: 'operatorResolveSupportTicket',
    description: 'Mark the conversation’s ticket resolved (the operator role).',
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.resolve', async (tx, operator, conversation) => {
      if (!conversation.ticket_id) throw new ApiError(409, 'SUPPORT_NO_TICKET', 'This conversation has no ticket.');
      if (conversation.ticket_resolved_at) throw new ApiError(409, 'ALREADY_RESOLVED', 'This ticket is already resolved.');
      await tx.execute(sql`UPDATE support_conversations SET ticket_resolved_at = now(), ticket_resolved_by = ${operator.userId} WHERE id = ${id}`);
      return { result: await one(tx, id, operator.userId) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/done', operationId: 'operatorMarkSupportConversationDone',
    description: 'Mark the conversation done (the operator role): it leaves Needs you, and its open ticket, if any, is resolved. Anything new (a message, a failed delivery, more blocked work, a ticket or a pause) brings it back. Send the ticket on screen as ticketId (null for none): a different open ticket answers 409 SUPPORT_TICKET_CHANGED and nothing changes.',
    request: { params: ConversationParam, headers: changeHeaders, body: { ...json(DoneBody), required: false } }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id, body: z.infer<typeof DoneBody> = c.req.valid('json') ?? {};
    return c.json(await change(c, id, 'support.done', async (tx, operator, conversation) => {
      if (conversation.done_at) throw new ApiError(409, 'ALREADY_DONE', 'This conversation is already marked done.');
      // The ticket the operator saw, never one filed since: Done resolves exactly what was on screen.
      const open = conversation.ticket_id && !conversation.ticket_resolved_at ? conversation.ticket_id : null;
      if (body.ticketId !== undefined && body.ticketId !== open)
        throw new ApiError(409, 'SUPPORT_TICKET_CHANGED', 'This conversation’s ticket changed since it was shown. Open it again before marking it done.');
      await tx.execute(sql`UPDATE support_conversations SET done_at = now(), done_by = ${operator.userId},
          done_ticket_id = CASE WHEN ticket_id IS NOT NULL AND ticket_resolved_at IS NULL THEN ticket_id END,
          ticket_resolved_by = CASE WHEN ticket_id IS NOT NULL AND ticket_resolved_at IS NULL THEN ${operator.userId} ELSE ticket_resolved_by END,
          ticket_resolved_at = CASE WHEN ticket_id IS NOT NULL AND ticket_resolved_at IS NULL THEN now() ELSE ticket_resolved_at END
        WHERE id = ${id}`);
      return { result: await one(tx, id, operator.userId) };
    }, body), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'delete', path: '/v1/operator/support-inbox/{id}/done', operationId: 'operatorUndoSupportConversationDone',
    description: `Undo Mark done (the operator role, the operator who marked it, within ${UNDO_MINUTES} minutes): the conversation is back where it was, and a ticket that Done resolved is open again.`,
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.undone', async (tx, operator, conversation) => {
      if (!conversation.done_at) throw new ApiError(409, 'NOT_DONE', 'This conversation isn’t marked done (something new may have brought it back).');
      if (conversation.done_by !== operator.userId || !conversation.undoable) throw new ApiError(409, 'UNDO_UNAVAILABLE', `Only the person who marked it done can undo it, within ${UNDO_MINUTES} minutes.`);
      // Only the ticket this Done resolved opens again; one resolved any other way stays resolved.
      await tx.execute(sql`UPDATE support_conversations SET done_at = NULL, done_by = NULL, done_ticket_id = NULL,
          ticket_resolved_by = CASE WHEN ticket_id = done_ticket_id THEN NULL ELSE ticket_resolved_by END,
          ticket_resolved_at = CASE WHEN ticket_id = done_ticket_id THEN NULL ELSE ticket_resolved_at END
        WHERE id = ${id}`);
      return { result: await one(tx, id, operator.userId) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'put', path: '/v1/operator/support-inbox/{id}/read', operationId: 'operatorMarkSupportConversationRead',
    description: 'Mark the conversation read (through its first seq messages; default all of them) or unread, for the signed-in operator alone (operator:read is enough). Reading never moves the marker back.',
    request: { params: ConversationParam, body: json(z.object({ read: z.boolean(), seq: z.number().int().min(0).max(1_000_000).optional().describe('The messages read: the transcript’s length when it was shown.') }).strict()) },
    responses: { 200: response(z.object({ id: z.string(), unread: z.boolean() })), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), id = c.req.valid('param').id, body = c.req.valid('json');
    const mark = body.read ? markRead(operator.userId, id, sql`least(coalesce(${body.seq ?? null}::int, messages), messages)`)
      : sql`INSERT INTO support_inbox_reads(user_id, conversation_id, seq) SELECT ${operator.userId}, id, 0 FROM support_conversations WHERE id = ${id}
          ON CONFLICT (user_id, conversation_id) DO UPDATE SET seq = 0, read_at = now() RETURNING seq`;
    const { rows: [row] } = await c.env.db.execute<{ messages: number; seq: number }>(sql`WITH mark AS (${mark})
      SELECT (SELECT messages FROM support_conversations WHERE id = ${id}) AS messages, mark.seq FROM mark`);
    if (!row) notFound('Support conversation');
    return c.json({ id, unread: row!.messages > row!.seq }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/wake', operationId: 'operatorWakeSupportConversation',
    description: 'Retry now (the operator role): wake the support platform for this conversation, with nothing but its ID. woken: false when no support site is configured or it did not answer.',
    request: { params: ConversationParam }, responses: { 200: response(z.object({ id: z.string(), woken: z.boolean() })), ...errors } }), async c => {
    await staff(c, 'operator');
    const id = c.req.valid('param').id;
    if (!(await c.env.db.execute(sql`SELECT FROM support_conversations WHERE id = ${id}`)).rowCount) notFound('Support conversation');
    return c.json({ id, woken: await wakeSupport(c.env.config, id) }, 200);
  });
}
