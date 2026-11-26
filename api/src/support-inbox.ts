import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors, isoTime, json, log, nextCursor, notFound, readCursor, response, type App, type Config, type Ctx, type DbExecutor } from './core.js';
import { auditInsert, operatorContext, operatorRequired } from './audit.js';
import { signedUrl } from './inbound-threads.js';
import { htmlToPlain, replyText } from './mailbox-store.js';
import { boundedHtmlFragment } from './bounded-html.js';
import { plainText } from './plain-text.js';
import { mutate, operatorActor, type OperatorIdentity } from './operator.js';
import type { OperatorRole } from './operator-identity.js';
import { supportPlatformOnly } from './support-conversations.js';
import { CONVERSATION_ID, FILE_AUDIENCE, signSupportToken, type InboxState, type OutboxReply } from './support-platform.js';
import { EXPIRES_MS, isKind, KINDS, validToken } from './support-approvals.js';

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
// The conversation page is one timeline: every message (the customer's, each with the stored email it came from when it
// was mailed; the agent's, sent or held and why; staff replies and staff notes) and what happened besides
// (support_events: a ticket filed, its priority, the agent paused and handed back, resolved, done), with the agent's
// ticket brief above it. A note (kind 'note': a staff member's, or the feedback triage agent's on an agent feedback report,
// author agent, src/feedback-triage.ts) is never delivered and changes no triage.
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
// handling (agent) is every other open conversation whose agent is active and owes the next message; Waiting on customer
// is one answered by the agent or staff; Done is one marked done (with nothing new since) or closed. Each operator also
// keeps their own read marker.

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
/** How much of each customer email the conversation page carries: the rest loads from the email itself. */
const EMAIL_TEXT_LIMIT = 20_000;
const MAIL_MESSAGE_ID = /^msg_[0-9a-f]{32}$/, ATTACHMENT_ID = /^att_[a-z2-7]{16}$/;
const HELD_REASONS = ['paused', 'gate', 'access', 'closed', 'earlier'] as const;
const EVENT_KINDS = ['opened', 'ticket', 'priority', 'paused', 'resumed', 'resolved', 'done', 'undone', 'closed', 'approved', 'declined', 'action', 'proposed'] as const;

const Author = z.enum(['customer', 'agent', 'staff', 'system']);
const Delivery = z.enum(['queued', 'sent', 'failed', 'held']);
const Tool = z.object({ label: z.string().trim().min(1).max(80), ok: z.boolean() }).strict();
const File = z.object({ id: z.string().regex(ATTACHMENT_ID), name: z.string().max(200), type: z.string().max(100), size: z.number().int().min(0).max(1_000_000_000) }).strict();
const Brief = z.object({ title: z.string().max(200), summary: z.string().max(1200), ask: z.string().max(600), recommendation: z.string().max(800),
  tried: z.array(z.object({ tool: z.string().max(60), finding: z.string().max(400) }).strict()).max(12).optional().describe('What the agent checked, tool by tool, and what it found.') }).strict();
const MailAddress = z.object({ name: z.string().nullable(), address: z.string() });
const EmailSource = z.object({
  id: z.string(), subject: z.string(), from: MailAddress, to: z.array(MailAddress), cc: z.array(MailAddress), receivedAt: z.string(),
  text: z.string().describe(`The email's text, quoted history included (the first ${EMAIL_TEXT_LIMIT} characters).`), replyText: z.string().describe('The text without its quoted history.'),
  textTruncated: z.boolean().describe('More text than this, or part of the email was too large to store: read the email itself.'), hasHtml: z.boolean(),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), inline: z.boolean(), available: z.boolean().describe('Scanned clean, so it can be opened.') })),
}).describe('A customer email: the message as it arrived at the support address.');
const Ticket = z.object({ id: z.string(), type: z.string().nullable(), severity: z.string().nullable(), resolvedAt: z.string().nullable() });
const ConversationParam = z.object({ id: z.string().regex(CONVERSATION_ID) });
const DoneBody = z.object({ ticketId: z.string().max(100).nullable().optional().describe('The ticket on screen when Done was pressed (null for none). Omit to resolve whatever ticket is open.') }).strict();
export const TRIAGE_REASONS = ['ticket', 'blocked', 'failed', 'paused', 'no_reply'] as const;

const Message = z.object({
  id: z.string(), seq: z.number().int(), author: Author, kind: z.string().nullable(), text: z.string(),
  tools: z.array(z.object({ label: z.string(), ok: z.boolean() })).describe('The agent’s tool calls by label and outcome; never their content.'),
  attachments: z.array(z.string()).describe('Attachment IDs, held by the support platform.'),
  staff: z.object({ userId: z.string(), name: z.string().nullable() }).nullable().describe('Who wrote a staff reply or note.'),
  delivery: Delivery.nullable().describe('A staff reply: queued until the support platform delivers it, then sent (or failed). An agent answer: sent, or held (frozen before a staff reply, never sent). A note: null.'),
  heldReason: z.enum(HELD_REASONS).nullable().describe('A held agent answer: paused (staff took over after it was written), gate (the output check held it), access (the customer’s access shrank), closed (the conversation ended first), earlier (written by an earlier build).'),
  files: z.array(z.object({ id: z.string(), name: z.string().nullable(), type: z.string().nullable(), size: z.number().int().nullable() })).describe('The attachments (screenshots held by the support platform), with their names when it sent them.'),
  email: EmailSource.nullable(),
  draft: z.object({ outcome: z.enum(['sent', 'edited', 'replaced', 'discarded']), by: z.object({ userId: z.string(), name: z.string().nullable() }), at: z.string(), replyId: z.string().nullable() }).nullable()
    .describe('A held agent answer staff decided: sent as it was, edited and sent, replaced by a fresh reply (replyId: the staff reply), or discarded.'),
  deliveredAt: z.string().nullable(), at: z.string(),
}).openapi('SupportInboxMessage');
const Event = z.object({ id: z.string(), kind: z.enum(EVENT_KINDS), by: z.object({ userId: z.string(), name: z.string().nullable() }).nullable().describe('The staff member, or null for the support platform or the customer.'),
  details: z.record(z.string(), z.unknown()), at: z.string() }).openapi('SupportInboxEvent');
const Item = z.object({
  id: z.string(), channel: z.enum(['chat', 'email', 'agent_feedback']).describe('agent_feedback: a report an agent filed with sendFeedback (src/feedback.ts), bound to its credential\u2019s workspace; nobody to reply to.'),
  mode: z.enum(['member', 'non_member', 'pending_signin', 'unverified']), verification: z.enum(['handoff', 'dmarc', 'signin', 'none', 'credential']),
  status: z.enum(['open', 'ticketed', 'closed']), subject: z.string().nullable(),
  customer: z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable().describe('The person Nightmail bound the conversation to, or null.'),
  sender: z.string().nullable().describe('An email conversation’s sender address, whether or not it proved who it is.'),
  workspace: z.object({ id: z.string(), name: z.string() }).nullable().describe('The one workspace in scope (a chat’s, or the one an email narrowed to; agent feedback’s, the credential’s).'),
  filedBy: z.string().nullable().describe('Agent feedback: the key, sign-in or token that filed it, in the words of the conversation’s Filed by (src/feedback.ts); null otherwise.'),
  ticket: Ticket.nullable(),
  agentState: z.enum(['active', 'paused']),
  pausedBy: z.object({ kind: z.enum(['staff', 'ticket']), userId: z.string().nullable(), name: z.string().nullable() }).nullable(), pausedAt: z.string().nullable(),
  lastAuthor: Author.nullable().describe('Who wrote last, leaving out the support platform’s own notices (system) and staff notes.'), needsReply: z.boolean().describe('Not closed, and the customer wrote last.'),
  preview: z.object({ author: Author, text: z.string(), held: z.boolean() }).nullable().describe('The last message itself (not a summary), its first 200 characters on one line: the same message lastAuthor names.'),
  messageCount: z.number().int(), queuedReplies: z.number().int(), turns: z.number().int(), costUsd: z.number(),
  blockedWork: z.number().int().describe('Work the support platform could not finish for this conversation.'),
  firstLine: z.string().nullable().describe('The first line of the customer’s first message: what a conversation without a subject is about.'),
  needsYou: z.object({
    reasons: z.array(z.enum(TRIAGE_REASONS)).min(1).describe('ticket: its ticket is open; blocked: the support platform could not finish work for it; failed: its latest answer or staff reply failed to send; paused: the agent is paused and staff owe the next message; no_reply: the customer wrote and nothing was sent back for 10 minutes (a held draft or a failed reply reaches nobody).'),
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
    evidence: z.object({ handoff: z.string().nullable(), message: z.string().nullable(), dmarc: z.string().nullable(), dkimAligned: z.boolean().nullable(), claimedAt: z.string().nullable(),
      filedBy: z.string().nullable().describe('Agent feedback: the key, sign-in or token that filed it, and the agent behind it (src/feedback.ts).'), credentialId: z.string().nullable().describe('Agent feedback: that credential\u2019s ID.') })
      .describe('What Nightmail checked to bind it: the handoff, or the support email and its DMARC verdict, and when the person claimed it signed in.'),
  }),
  messages: z.array(Message).describe(`The transcript, oldest first: its last ${TRANSCRIPT_LIMIT} entries.`), earlierMessages: z.number().int(),
  events: z.array(Event).describe('What happened besides the messages, oldest first: opened, a ticket filed and its priority, the agent paused and handed back, resolved, done and undone, closed.'),
  brief: Brief.nullable().describe('The ticket as the agent filed it: its own summary of the conversation, never a replacement for it.'),
  replyTarget: z.object({ address: z.string().nullable(), verified: z.boolean() }).describe('Where a staff reply goes: an email conversation’s sender (verified: their mail passed DMARC or they signed in; otherwise the reply cannot be sent), or a chat’s account address when the chat is closed.'),
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

export type ItemRow = { id: string; channel: z.infer<typeof Item>['channel']; mode: z.infer<typeof Item>['mode']; verification: z.infer<typeof Item>['verification']; status: z.infer<typeof Item>['status']; subject: string | null;
  pending_address: string | null; user_id: string | null; user_name: string | null; user_email: string | null; workspace_id: string | null; workspace_name: string | null;
  ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null; agent_state: 'active' | 'paused'; paused_by: string | null;
  paused_by_name: string | null; paused_at: string | null; messages: number; turns: number; cost_usd: number | string; blocked_work: number; created_at: string; last_message_at: string | null;
  closed_at: string | null; activity_at: string; last_author: z.infer<typeof Author> | null; last_text: string | null; last_held: boolean | null; queued: number; opening: string | null; done_at: string | null; done_by: string | null; done_by_name: string | null;
  unread: boolean; needs_you: boolean; urgency: number; since: string | null; filed_by: string | null } & Record<`why_${(typeof TRIAGE_REASONS)[number]}`, boolean>;
export const itemColumns = sql`c.id, c.channel, CASE WHEN c.channel = 'agent_feedback' THEN left(c.evidence->>'filedBy', 300) END AS filed_by, c.mode, c.verification, c.status, c.subject, c.pending_address, c.user_id, u.name AS user_name, u.email AS user_email,
  c.workspace_id, w.name AS workspace_name, c.ticket_id, c.ticket_type, c.ticket_severity, c.ticket_resolved_at::text AS ticket_resolved_at,
  c.agent_state, c.paused_by, p.name AS paused_by_name, c.paused_at::text AS paused_at, c.messages, c.turns, c.cost_usd, c.blocked_work,
  c.created_at::text AS created_at, c.last_message_at::text AS last_message_at, c.closed_at::text AS closed_at, coalesce(c.last_message_at, c.created_at)::text AS activity_at,
  last.author AS last_author, last.text AS last_text, last.held AS last_held, (SELECT count(*)::int FROM support_messages q WHERE q.conversation_id = c.id AND q.delivery = 'queued') AS queued,
  opening.text AS opening, c.done_at::text AS done_at, c.done_by, (SELECT name FROM nightmail_users WHERE id = c.done_by) AS done_by_name,
  c.messages > coalesce(rd.seq, 0) AS unread, triage.needs_you, triage.urgency, triage.since::text AS since,
  why.ticket AS why_ticket, why.blocked AS why_blocked, why.failed AS why_failed, why.paused AS why_paused, why.no_reply AS why_no_reply`;
// One conversation as the inbox lists it to one operator (`me`: their read marker), with its triage (Needs you, above).
export const itemFrom = (me: string) => sql`support_conversations c LEFT JOIN nightmail_users u ON u.id = c.user_id LEFT JOIN workspaces w ON w.id = c.workspace_id
  LEFT JOIN nightmail_users p ON p.id = c.paused_by
  LEFT JOIN support_inbox_reads rd ON rd.conversation_id = c.id AND rd.user_id = ${me}
  LEFT JOIN LATERAL (SELECT m.author, left(m.text, 600) AS text, m.delivery = 'held' AS held FROM support_messages m
    WHERE m.conversation_id = c.id AND m.author <> 'system' AND m.kind IS DISTINCT FROM 'note' ORDER BY m.seq DESC LIMIT 1) last ON true
  LEFT JOIN LATERAL (SELECT left(m.text, 400) AS text FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) opening ON true
  LEFT JOIN LATERAL (SELECT a.delivery = 'failed' AS failed, a.created_at FROM support_messages a
    WHERE a.conversation_id = c.id AND a.author IN ('agent','staff') AND a.delivery IN ('queued','sent','failed') ORDER BY a.seq DESC LIMIT 1) answer ON true
  LEFT JOIN LATERAL (SELECT min(m.created_at) AS at FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer'
    AND m.seq > coalesce((SELECT max(o.seq) FROM support_messages o WHERE o.conversation_id = c.id AND o.author NOT IN ('customer','system') AND o.kind IS DISTINCT FROM 'note'), 0)) waiting ON true
  CROSS JOIN LATERAL (SELECT ${unansweredSince} AS at) unanswered
  CROSS JOIN LATERAL (SELECT c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL AS ticket, c.blocked_work > 0 AS blocked, coalesce(answer.failed, false) AS failed,
    c.agent_state = 'paused' AND c.status <> 'closed' AND last.author IS DISTINCT FROM 'staff' AS paused, ${noReply(sql`unanswered.at`)} AS no_reply) why
  CROSS JOIN LATERAL (SELECT c.done_at IS NULL AND (why.ticket OR why.blocked OR why.failed OR why.paused OR why.no_reply) AS needs_you,
    CASE WHEN why.ticket AND c.ticket_severity = 'P1' THEN 1 WHEN why.failed OR why.no_reply OR (last.author = 'customer' AND (why.paused OR why.blocked)) THEN 2
      WHEN why.ticket AND c.ticket_severity = 'P2' THEN 3 ELSE 4 END AS urgency,
    least(CASE WHEN why.ticket THEN coalesce(c.ticket_at, c.created_at) END, CASE WHEN why.paused THEN coalesce(waiting.at, c.paused_at) END,
      CASE WHEN why.failed THEN answer.created_at END, CASE WHEN why.blocked THEN coalesce(c.last_message_at, c.created_at) END, CASE WHEN why.no_reply THEN unanswered.at END) AS since) triage`;
/**
 * No reply sent: since the customer's first message after the last thing that reached them (an answer or notice the
 * support platform sent, or a staff reply, queued or sent; a held draft or a failed reply reaches nobody). Over
 * NO_REPLY_AFTER, a conversation (not agent feedback, which has nobody to reply to) needs you for it, and Glass counts it.
 */
const reached = sql`(o.kind IS DISTINCT FROM 'note' AND (o.author = 'system'
  OR (o.author = 'agent' AND o.kind IS DISTINCT FROM 'held' AND o.delivery IS DISTINCT FROM 'held' AND o.delivery IS DISTINCT FROM 'failed') OR (o.author = 'staff' AND o.delivery IN ('queued','sent'))))`;
const unansweredSince = sql`(SELECT min(m.created_at) FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer'
  AND m.seq > coalesce((SELECT max(o.seq) FROM support_messages o WHERE o.conversation_id = c.id AND ${reached}), 0))`;
const NO_REPLY_AFTER = sql`interval '10 minutes'`;
const noReply = (since: SQL) => sql`(c.channel <> 'agent_feedback' AND coalesce(${since} < now() - ${NO_REPLY_AFTER}, false))`;
/** The conversations Needs you and Agent handling can hold: open ones, and closed ones with an open ticket, blocked work or a transcript (failed deliveries). */
export const triageCandidates = sql`(c.status <> 'closed' OR c.closed_at > now() - interval '90 days' OR c.blocked_work > 0 OR (c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL))`;
/** Answered: the last message is the agent's (sent) or staff's, so the customer has the next word. */
const answered = sql`(last.author IN ('agent','staff') AND last.held IS NOT TRUE)`;
// Agent feedback has no agent behind it, and nobody to reply to: it needs you or it is done.
const handling = sql`c.status <> 'closed' AND c.channel <> 'agent_feedback' AND c.agent_state = 'active' AND NOT triage.needs_you AND c.done_at IS NULL AND NOT ${answered}`;
const waitingOnCustomer = sql`c.status <> 'closed' AND c.channel <> 'agent_feedback' AND NOT triage.needs_you AND c.done_at IS NULL AND ${answered}`;
/** Glass's count of conversations that need you because no reply was sent (the same rule as Needs you). */
export const noReplyCount = sql`(SELECT count(*) FROM support_conversations c WHERE c.done_at IS NULL AND ${triageCandidates} AND ${noReply(unansweredSince)})`;
/** The ticket types a person handles by design, so the support AI's week counts them apart. */
export const TICKETS_APART = ['bug', 'billing', 'abuse_report', 'privacy', 'legal'] as const;
/**
 * The support AI's week, for Glass: the conversations that started in the last 7 days (the newest `cap`, through
 * support_conversations_created; agent feedback left out, nobody answers it), as
 * - apart: those with a ticket a person handles by design (TICKETS_APART);
 * - answerable: the rest;
 * - without_human: of the answerable, those that ended (closed, marked done, or quiet for 24 hours after a sent agent
 *   answer) with no staff reply, no ticket for a person (one the agent filed, other than a feature request it logged,
 *   or one Nightmail opened for staff: type staff, now or on the timeline), no held answer, no failed send and never
 *   "no reply sent" (a customer message nothing reached within NO_REPLY_AFTER).
 * Nothing here says an answer was right: only that no person had to step in.
 */
export const supportWeek = (cap: number) => sql`(SELECT json_build_object('answerable',count(*) FILTER (WHERE x.n <= ${cap} AND NOT x.apart),
    'without_human',count(*) FILTER (WHERE x.n <= ${cap} AND NOT x.apart AND x.ended AND NOT x.human),'apart',count(*) FILTER (WHERE x.n <= ${cap} AND x.apart),'capped',count(*) > ${cap})
  FROM (SELECT row_number() OVER (ORDER BY c.created_at DESC) AS n, coalesce(c.ticket_type = ANY(${sql.param([...TICKETS_APART])}::text[]), false) AS apart,
      c.status = 'closed' OR c.done_at IS NOT NULL OR coalesce(last.author = 'agent' AND last.kind IS DISTINCT FROM 'held' AND last.delivery IS DISTINCT FROM 'held'
        AND last.delivery IS DISTINCT FROM 'failed' AND last.created_at <= now() - interval '24 hours', false) AS ended,
      (c.ticket_id IS NOT NULL AND c.ticket_type IS DISTINCT FROM 'feature_request')
        OR EXISTS (SELECT FROM support_events e WHERE e.conversation_id = c.id AND e.kind = 'ticket' AND e.details->>'type' = 'staff')
        OR EXISTS (SELECT FROM support_messages m WHERE m.conversation_id = c.id AND ((m.author = 'staff' AND m.kind IS DISTINCT FROM 'note')
          OR (m.author = 'agent' AND (m.kind = 'held' OR m.delivery = 'held')) OR m.delivery = 'failed'))
        OR EXISTS (SELECT FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer' AND m.created_at < now() - ${NO_REPLY_AFTER}
          AND NOT EXISTS (SELECT FROM support_messages o WHERE o.conversation_id = c.id AND o.seq > m.seq AND o.created_at <= m.created_at + ${NO_REPLY_AFTER} AND ${reached})) AS human
    FROM (SELECT * FROM support_conversations c WHERE c.created_at >= now() - interval '7 days' AND c.channel <> 'agent_feedback' ORDER BY c.created_at DESC LIMIT ${cap + 1}) c
    LEFT JOIN LATERAL (SELECT m.author, m.kind, m.delivery, m.created_at FROM support_messages m
      WHERE m.conversation_id = c.id AND m.author <> 'system' AND m.kind IS DISTINCT FROM 'note' ORDER BY m.seq DESC LIMIT 1) last ON true) x)`;
const finished = sql`NOT triage.needs_you AND (c.done_at IS NOT NULL OR c.status = 'closed' OR (c.channel = 'agent_feedback' AND c.ticket_resolved_at IS NOT NULL))`;
const firstLine = (text: string | null) => text?.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? null;
/** A message as one line for the list: its own words, white space folded, the first 200 characters. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
const ticketOf = (r: { ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null }) =>
  r.ticket_id ? { id: r.ticket_id, type: r.ticket_type, severity: r.ticket_severity, resolvedAt: isoTime(r.ticket_resolved_at) } : null;
const item = (r: ItemRow): z.infer<typeof Item> => ({
  id: r.id, channel: r.channel, mode: r.mode, verification: r.verification, status: r.status, subject: r.subject,
  customer: r.user_id ? { userId: r.user_id, name: r.user_name, email: r.user_email } : null, sender: r.pending_address,
  workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? r.workspace_id } : null, filedBy: r.filed_by ?? null, ticket: ticketOf(r),
  agentState: r.agent_state, pausedAt: isoTime(r.paused_at),
  pausedBy: r.agent_state !== 'paused' ? null : r.paused_by === 'ticket' ? { kind: 'ticket', userId: null, name: null } : { kind: 'staff', userId: r.paused_by, name: r.paused_by_name },
  lastAuthor: r.last_author, needsReply: r.status !== 'closed' && r.channel !== 'agent_feedback' && r.last_author === 'customer',
  preview: r.last_author && r.last_text !== null ? { author: r.last_author, text: oneLine(r.last_text), held: r.last_held === true } : null,
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

type StoredFile = { id: string; name: string; type: string; size: number };
/** A customer email as the conversation page reads it (mail_messages at the support address), its text capped. */
type EmailRow = { id: string; subject: string; from_address: string; from_name: string | null; to: { name: string | null; address: string }[]; cc: { name: string | null; address: string }[];
  received_at: string; text: string | null; html_text: string | null; text_length: number; body_truncated: boolean; has_html: boolean;
  attachments: { id: string; filename: string; contentType: string; size: number; disposition: string; contentId: string | null }[]; clean: boolean };
type MessageRow = { id: string; seq: number; author: z.infer<typeof Author>; kind: string | null; text: string; tools: { label: string; ok: boolean }[]; attachments: string[];
  staff_user_id: string | null; staff_name: string | null; delivery: z.infer<typeof Delivery> | null; held_reason: z.infer<typeof Message>['heldReason']; files: StoredFile[] | null;
  email?: EmailRow | null; draft_outcome: 'sent' | 'edited' | 'replaced' | 'discarded' | null; draft_by: string | null; draft_by_name: string | null; draft_at: string | null; draft_reply: string | null;
  delivered_at: string | null; created_at: string };
const messageColumns = sql`id, seq, author, kind, text, tools, attachments, staff_user_id, (SELECT name FROM nightmail_users WHERE id = staff_user_id) AS staff_name, delivery,
  held_reason, files, draft_outcome, draft_by, (SELECT name FROM nightmail_users WHERE id = draft_by) AS draft_by_name, draft_at::text AS draft_at, draft_reply,
  delivered_at::text AS delivered_at, created_at::text AS created_at`;
/** The stored email behind a customer message (`m`), for the conversation page: its text up to EMAIL_TEXT_LIMIT and its attachments' metadata. */
const emailOf = sql`(SELECT json_build_object('id', mm.id, 'subject', mm.subject, 'from_address', mm.from_address, 'from_name', mm.from_name,
    'to', (SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT x FROM jsonb_array_elements(mm."to") x LIMIT 10) t(x)), 'cc', (SELECT coalesce(jsonb_agg(x), '[]') FROM (SELECT x FROM jsonb_array_elements(mm.cc) x LIMIT 10) t(x)),
    'received_at', mm.received_at::text, 'text', left(mm.text, ${EMAIL_TEXT_LIMIT}), 'html_text', CASE WHEN mm.text IS NULL THEN left(mm.html, 200000) END,
    'text_length', coalesce(length(mm.text), 0), 'body_truncated', mm.body_truncated, 'has_html', mm.html IS NOT NULL, 'clean', coalesce(mm.verdicts->>'virus' = 'PASS', false),
    'attachments', (SELECT coalesce(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'contentType', a.content_type, 'size', a.size_bytes, 'disposition', a.disposition, 'contentId', a.content_id) ORDER BY a.id), '[]')
      FROM mail_attachments a WHERE a.message_id = mm.id))
  FROM mail_messages mm WHERE mm.id = m.source_message_id AND mm.direction = 'inbound')`;
function email(row: EmailRow): z.infer<typeof EmailSource> {
  const text = row.text ?? (row.html_text ? htmlToPlain(row.html_text) : '');
  return { id: row.id, subject: row.subject, from: { name: row.from_name, address: row.from_address }, to: row.to.map(a => ({ name: a.name ?? null, address: a.address })),
    cc: row.cc.map(a => ({ name: a.name ?? null, address: a.address })), receivedAt: isoTime(row.received_at)!, text: text.slice(0, EMAIL_TEXT_LIMIT), replyText: replyText(text).slice(0, EMAIL_TEXT_LIMIT),
    textTruncated: row.body_truncated || row.text_length > EMAIL_TEXT_LIMIT || text.length > EMAIL_TEXT_LIMIT, hasHtml: row.has_html,
    attachments: row.attachments.map(a => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size, inline: a.disposition === 'inline' && a.contentId !== null, available: row.clean })) };
}
const message = (m: MessageRow): z.infer<typeof Message> => {
  const named = new Map((m.files ?? []).map(f => [f.id, f]));
  return { id: m.id, seq: m.seq, author: m.author, kind: m.kind, text: m.text, tools: m.tools, attachments: m.attachments,
    staff: m.staff_user_id ? { userId: m.staff_user_id, name: m.staff_name } : null, delivery: m.delivery, heldReason: m.held_reason ?? null,
    files: m.attachments.map(id => { const f = named.get(id); return { id, name: f?.name ?? null, type: f?.type ?? null, size: f?.size ?? null }; }),
    email: m.email ? email(m.email) : null, deliveredAt: isoTime(m.delivered_at), at: isoTime(m.created_at)!,
    draft: m.draft_outcome && m.draft_by ? { outcome: m.draft_outcome, by: { userId: m.draft_by, name: m.draft_by_name }, at: isoTime(m.draft_at)!, replyId: m.draft_reply } : null };
};
/** Records what happened to a conversation (support_events), in the caller's statement or transaction. */
export const event = (id: string, kind: (typeof EVENT_KINDS)[number], userId: string | null, details: Record<string, unknown> = {}) =>
  sql`INSERT INTO support_events(conversation_id, kind, user_id, details) VALUES (${id}, ${kind}, ${userId}, ${JSON.stringify(details)}::jsonb)`;

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
/** Agent feedback (src/feedback.ts) has no support platform or agent behind it: nobody to reply to, pause or wake. */
const noAgent = () => new ApiError(409, 'SUPPORT_AGENT_FEEDBACK', 'This is agent feedback: there is no customer to reply to and no support agent to pause, hand back or wake. Resolve its ticket or mark it done.');

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
    attachments: z.array(z.string().regex(ATTACHMENT_ID)).max(20).default([]),
    files: z.array(File).max(20).optional().describe('The attachments’ names, types and sizes, beside their IDs.'),
    source: z.string().max(100).optional().describe('A customer email only: the message it came from at a support address. Kept only when it is one; anything else is dropped, never refused, so the mirror never stalls on it.'),
    delivery: z.enum(['sent', 'failed', 'held']).optional().describe('An agent answer only: sent, failed, or held (frozen before a staff reply and never sent).'),
    reason: z.enum(HELD_REASONS).optional().describe('A held agent answer only: why it was not sent.'),
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
      if (m.reason && m.delivery !== 'held') throw new ApiError(422, 'VALIDATION_FAILED', 'Only a held answer has a reason.', `messages.${i}.reason`);
      if (m.source && m.author !== 'customer') throw new ApiError(422, 'VALIDATION_FAILED', 'Only a customer message comes from an email.', `messages.${i}.source`);
      if (m.kind === 'note') throw new ApiError(422, 'VALIDATION_FAILED', 'A note comes from staff or the feedback triage agent, never from a mirror.', `messages.${i}.kind`);
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
        // A source is kept only when it is a message received at a support address: the inbox shows that email in full.
        const supportAddresses = c.env.config.support?.addressIds ?? [];
        const { rows: inserted } = await tx.execute<{ id: string }>(sql`INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, tools, attachments, files, source_message_id, delivery, held_reason, created_at)
          SELECT m.id, ${id}, m.seq, m.author, m.kind, m.text, m.tools, m.attachments, m.files,
            CASE WHEN m.source ~ '^msg_[0-9a-f]{32}$' AND EXISTS (SELECT FROM mailbox_messages mb WHERE mb.message_id = m.source AND mb.direction = 'inbound' AND mb.mailbox_id = ANY(${sql.param(supportAddresses)}::text[])) THEN m.source END,
            m.delivery, m.reason, coalesce(m.at, now())
          FROM jsonb_to_recordset(${JSON.stringify(fresh)}::jsonb) AS m(id text, seq int, author text, kind text, text text, tools jsonb, attachments jsonb, files jsonb, source text, delivery text, reason text, at timestamptz)
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
      ticket: z.object({ id: z.string().regex(/^tkt_[a-z2-7]{16}$/), type: z.enum(TICKET_TYPES), severity: z.enum(['P1', 'P2', 'P3']), brief: Brief.optional().describe('The ticket as the agent filed it.') }).strict().optional().describe('The conversation’s one ticket.'),
      turns: z.number().int().min(0).max(1_000_000).optional(), costUsd: z.number().min(0).max(100_000).optional(),
      blockedWork: z.number().int().min(0).max(100_000).optional().describe('Work items for this conversation that are blocked now.'),
      pauseForTicket: z.literal(true).optional().describe('Pause the agent after an emailed ticket. A conversation already paused stays as it is.'),
    }).strict()) },
    responses: { 200: response(State), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const id = c.req.valid('param').id, body = c.req.valid('json'), ticket = body.ticket ?? null, pause = body.pauseForTicket === true;
    // A new ticket, more blocked work or a pause is something new: it undoes staff's Done.
    const reopen = sql`((ticket_id IS NULL OR ticket_type = 'staff') AND ${ticket?.id ?? null}::text IS NOT NULL AND ticket_id IS DISTINCT FROM ${ticket?.id ?? null}) OR coalesce(${body.blockedWork ?? null}::int, blocked_work) > blocked_work OR (${pause} AND agent_state = 'active')`;
    // The timeline's events, from the row as it was (locked first): the ticket filed, its priority changed, the agent paused for it.
    type Row = { id: string; ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; agent_state: string };
    const rows = await c.env.db.transaction(async tx => {
      const { rows: [before] } = await tx.execute<Row>(sql`SELECT id, ticket_id, ticket_type, ticket_severity, agent_state FROM support_conversations WHERE id = ${id} FOR NO KEY UPDATE`);
      if (!before) return [];
      const { rows: [after] } = await tx.execute<Row>(sql`UPDATE support_conversations SET
        subject = coalesce(${body.subject ?? null}, subject),
        ticket_at = CASE WHEN ticket_id IS NULL AND ${ticket?.id ?? null}::text IS NOT NULL THEN now() ELSE ticket_at END,
        done_at = CASE WHEN ${reopen} THEN NULL ELSE done_at END, done_by = CASE WHEN ${reopen} THEN NULL ELSE done_by END,
        ticket_id = CASE WHEN ticket_type = 'staff' THEN coalesce(${ticket?.id ?? null}, ticket_id) ELSE coalesce(ticket_id, ${ticket?.id ?? null}) END,
        ticket_resolved_at = CASE WHEN ticket_type = 'staff' AND ${ticket?.id ?? null}::text IS NOT NULL THEN NULL ELSE ticket_resolved_at END,
        ticket_type = coalesce(${ticket?.type ?? null}, ticket_type), ticket_severity = coalesce(${ticket?.severity ?? null}, ticket_severity),
        status = CASE WHEN ${ticket?.id ?? null}::text IS NOT NULL AND status = 'open' THEN 'ticketed' ELSE status END,
        turns = greatest(turns, ${body.turns ?? 0}::int), cost_usd = greatest(cost_usd, ${body.costUsd ?? 0}::numeric), blocked_work = coalesce(${body.blockedWork ?? null}::int, blocked_work),
        agent_state = CASE WHEN ${pause} THEN 'paused' ELSE agent_state END,
        paused_by = CASE WHEN ${pause} AND agent_state = 'active' THEN 'ticket' ELSE paused_by END,
        paused_at = CASE WHEN ${pause} AND agent_state = 'active' THEN now() ELSE paused_at END,
        ticket_brief = coalesce(${ticket?.brief ? JSON.stringify(ticket.brief) : null}::jsonb, ticket_brief)
      WHERE id = ${id} AND (${ticket?.id ?? null}::text IS NULL OR ticket_id IS NULL OR ticket_id = ${ticket?.id ?? null} OR ticket_type = 'staff') RETURNING id, ticket_id, ticket_type, ticket_severity, agent_state`);
      if (!after) return [];
      // A ticket Nightmail opened because the conversation needed a person (support-staff-mail.ts) gives way to the agent's.
      if (before.ticket_id !== after.ticket_id && after.ticket_id) await tx.execute(event(id, 'ticket', null, { ticketId: after.ticket_id, type: after.ticket_type, severity: after.ticket_severity }));
      else if (before.ticket_id && after.ticket_severity !== before.ticket_severity) await tx.execute(event(id, 'priority', null, { from: before.ticket_severity, to: after.ticket_severity }));
      if (before.agent_state === 'active' && after.agent_state === 'paused') await tx.execute(event(id, 'paused', null, { by: 'ticket' }));
      return [after];
    });
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
    description: 'Every support conversation, most recent activity first (needs_you: most urgent and longest waiting first). replyAvailable: whether staff can reply now (the support platform pulled replies in the last 10 minutes). counts: how many conversations need you, how many the agent is handling and how many wait on the customer.',
    request: { query: z.object({
      view: z.enum(['all', 'needs_you', 'agent', 'waiting', 'done', 'tickets', 'needs_reply', 'paused', 'attention']).default('all')
        .describe('needs_you: what staff must handle (see needsYou); agent: open conversations the agent is handling and owes the next message in; waiting: answered by the agent or staff, waiting on the customer; done: marked done with nothing new since, or closed (agent feedback: once its ticket is resolved); tickets: an unresolved ticket; needs_reply: not closed, the customer wrote last; paused: the agent is paused; attention: blocked work.'),
      channel: z.enum(['chat', 'email', 'agent_feedback']).optional(), status: z.enum(['open', 'ticketed', 'closed']).optional(),
      q: z.string().trim().min(1).max(200).optional().describe('A conversation, ticket or user ID, or part of a name, address or subject.'),
      cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }) },
    responses: { 200: response(z.object({ data: z.array(Item), nextCursor: z.string().nullable(), replyAvailable: z.boolean(),
      counts: z.object({ needsYou: z.number().int(), agent: z.number().int(), waiting: z.number().int() }).describe('The needs_you, agent and waiting views’ sizes, whatever this request’s filters.') })), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), me = operator.userId;
    const q = c.req.valid('query'), binding = `support-inbox:${q.view}:${q.channel ?? ''}:${q.status ?? ''}:${q.q ?? ''}`, after = readCursor(q.cursor, binding);
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null, triaged = q.view === 'needs_you';
    const filters: SQL[] = [{
      all: sql`true`, needs_you: sql`${triageCandidates} AND triage.needs_you`, agent: handling, waiting: waitingOnCustomer, done: finished,
      tickets: sql`c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL`, needs_reply: sql`c.status <> 'closed' AND c.channel <> 'agent_feedback' AND last.author = 'customer'`,
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
      c.env.db.execute<{ needs_you: number; agent: number; waiting: number; available: boolean }>(sql`SELECT count(*) FILTER (WHERE triage.needs_you)::int AS needs_you,
          count(*) FILTER (WHERE ${handling})::int AS agent, count(*) FILTER (WHERE ${waitingOnCustomer})::int AS waiting, ${replyAvailable} AS available FROM ${itemFrom(me)} WHERE ${triageCandidates}`),
    ]);
    const next = nextCursor(rows.map(r => triaged ? { id: `${r.urgency}:${r.id}`, createdAt: r.since! } : { id: r.id, createdAt: r.activity_at }), q.limit, binding);
    return c.json({ data: rows.slice(0, q.limit).map(item), nextCursor: next, replyAvailable: counts!.available, counts: { needsYou: counts!.needs_you, agent: counts!.agent, waiting: counts!.waiting } }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}', operationId: 'operatorGetSupportConversation',
    description: 'One conversation in one read: its timeline (every message, each customer email as it arrived, and what happened besides), the agent’s ticket brief, and who the customer is (verification, workspaces and roles, their other conversations and tickets, recent activity, notes). Each read is on the audit trail.',
    request: { params: ConversationParam }, responses: { 200: response(Detail), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), id = c.req.valid('param').id;
    type Json = Record<string, unknown>;
    const viewed = auditInsert(staffContext(c, operator), { action: 'support.inbox_view', workspaceId: null, userId: sql`coalesce(conv.user_id, ${operator.userId})`,
      target: { type: 'support_conversation', id }, ticketRef: id, internal: true }, { from: sql`conv` });
    const { rows: [row] } = await c.env.db.execute<{ item: ItemRow; evidence: Json; thread_id: string | null; content_workspace_id: string | null; page: string | null; messages: MessageRow[];
      user: Json | null; workspaces: Json[]; conversations: (Json & { ticket_id: string | null; ticket_type: string | null; ticket_severity: string | null; ticket_resolved_at: string | null })[];
      activity: Json[]; notes: Json[]; available: boolean; events: { id: string; kind: z.infer<typeof Event>['kind']; user_id: string | null; name: string | null; details: Json; at: string }[]; brief: z.infer<typeof Brief> | null;
      reply_address: string | null; reply_verified: boolean }>(sql`WITH conv AS (SELECT * FROM support_conversations WHERE id = ${id}), logged AS (${viewed})
      SELECT (SELECT row_to_json(i) FROM (SELECT ${itemColumns} FROM ${itemFrom(operator.userId)} WHERE c.id = conv.id) i) AS item,
        conv.evidence, conv.thread_id, conv.content_workspace_id, (SELECT page FROM support_handoffs WHERE conversation_id = conv.id) AS page,
        (SELECT coalesce(json_agg(m ORDER BY m.seq), '[]') FROM (SELECT m.id, m.seq, m.author, m.kind, m.text, m.tools, m.attachments, m.staff_user_id, su.name AS staff_name, m.delivery,
          m.held_reason, m.files, CASE WHEN m.source_message_id IS NOT NULL THEN ${emailOf} END AS email,
          m.draft_outcome, m.draft_by, (SELECT name FROM nightmail_users WHERE id = m.draft_by) AS draft_by_name, m.draft_at::text AS draft_at, m.draft_reply,
          m.delivered_at::text AS delivered_at, m.created_at::text AS created_at FROM support_messages m LEFT JOIN nightmail_users su ON su.id = m.staff_user_id
          WHERE m.conversation_id = conv.id ORDER BY m.seq DESC LIMIT ${TRANSCRIPT_LIMIT}) m) AS messages,
        (SELECT coalesce(json_agg(e ORDER BY e.at, e.n), '[]') FROM (
          SELECT 'opened' AS id, 0 AS n, 'opened' AS kind, NULL AS user_id, NULL AS name, json_build_object('channel', conv.channel) AS details, conv.created_at AS at
          UNION ALL SELECT 'sev_' || e.id, e.id, e.kind, e.user_id, u.name, e.details::json, e.created_at FROM support_events e LEFT JOIN nightmail_users u ON u.id = e.user_id WHERE e.conversation_id = conv.id
          UNION ALL SELECT 'closed', 9223372036854775807, 'closed', NULL, NULL, '{}'::json, conv.closed_at WHERE conv.closed_at IS NOT NULL) e) AS events,
        conv.ticket_brief AS brief,
        CASE WHEN conv.channel = 'email' THEN conv.pending_address ELSE (SELECT email FROM nightmail_users WHERE id = conv.user_id) END AS reply_address,
        conv.channel = 'chat' OR conv.verification <> 'none' OR coalesce(conv.evidence->>'dmarc' = 'PASS', false) AS reply_verified,
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
    const r = row!, evidence = r.evidence as { handoff?: string; message?: string; dmarc?: string | null; dkimAligned?: boolean; claimedAt?: string; filedBy?: string; credentialId?: string };
    const at = (value: unknown) => isoTime(value as string | null);
    return c.json({
      conversation: { ...item(r.item), threadId: r.thread_id, page: r.page, contentWorkspaceId: r.content_workspace_id,
        evidence: { handoff: evidence.handoff ?? null, message: evidence.message ?? null, dmarc: evidence.dmarc ?? null, dkimAligned: evidence.dkimAligned ?? null, claimedAt: at(evidence.claimedAt),
          filedBy: r.item.channel === 'agent_feedback' ? evidence.filedBy ?? null : null, credentialId: r.item.channel === 'agent_feedback' ? evidence.credentialId ?? null : null } },
      messages: r.messages.map(message), earlierMessages: Math.max(0, r.item.messages - r.messages.length),
      events: r.events.map(e => ({ id: e.id, kind: e.kind, by: e.user_id ? { userId: e.user_id, name: e.name } : null, details: e.details, at: at(e.at)! })),
      brief: r.brief, replyTarget: { address: r.reply_address, verified: r.reply_verified },
      customer: {
        user: r.user ? { ...(r.user as { id: string; name: string | null; email: string | null; emailVerified: boolean }), createdAt: at(r.user.createdAt)! } : null,
        workspaces: r.workspaces.map(w => ({ ...w, joinedAt: at(w.joinedAt)!, createdAt: at(w.createdAt)! })) as z.infer<typeof Detail>['customer']['workspaces'],
        conversations: r.conversations.map(o => ({ id: o.id as string, channel: o.channel as string, mode: o.mode as string, verification: o.verification as string, status: o.status as string,
          subject: o.subject as string | null, ticket: ticketOf(o), createdAt: at(o.createdAt)!, lastMessageAt: at(o.lastMessageAt) })),
        activity: r.activity.map(({ n: _n, ...e }) => ({ ...e, at: at(e.at)! })) as z.infer<typeof Detail>['customer']['activity'],
        notes: r.notes.map(n => ({ ...n, createdAt: at(n.createdAt)! })) as z.infer<typeof Detail>['customer']['notes'],
      },
      replyAvailable: r.available && r.item.channel !== 'agent_feedback',
    }, 200);
  });

  // Every staff change is one transaction with its internal audit row, and repeats safely with an Idempotency-Key.
  type Locked = { status: string; channel: string; user_id: string | null; agent_state: string; ticket_id: string | null; ticket_resolved_at: string | null; done_at: string | null; done_by: string | null; undoable: boolean };
  const changeHeaders = z.object({ 'idempotency-key': z.string().min(1).max(200).optional() });
  async function change<T>(c: Ctx, id: string, action: string, work: (tx: DbExecutor, operator: OperatorIdentity, conversation: Locked) => Promise<{ result: T; message?: string }>, body?: unknown) {
    const operator = await staff(c, 'operator');
    let subject: string | null = null, messageId: string | undefined;
    return mutate(c, operator, '', body, async tx => {
      const { rows: [conversation] } = await tx.execute<Locked>(sql`SELECT status, channel, user_id, agent_state, ticket_id, ticket_resolved_at::text AS ticket_resolved_at, done_at::text AS done_at,
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

  /**
   * Queues a staff reply in the caller's change: refused on a closed conversation or while the support platform is not
   * pulling replies; it pauses the agent as this staff member, undoes Done, and its author has read everything up to it.
   */
  async function queueReply(tx: DbExecutor, operator: OperatorIdentity, conversation: Locked, id: string, text: string) {
    if (conversation.status === 'closed') throw closedConversation();
    if (conversation.channel === 'agent_feedback') throw noAgent();
    if (!(await tx.execute<{ available: boolean }>(sql`SELECT ${replyAvailable} AS available`)).rows[0]!.available)
      throw new ApiError(409, 'SUPPORT_REPLY_UNAVAILABLE', 'The support platform has not collected replies in the last 10 minutes, so this reply could not be delivered. Try again once it is back.');
    const messageId = newMessageId();
    if (conversation.agent_state === 'active') await tx.execute(event(id, 'paused', operator.userId, { by: 'staff', reply: true }));
    const { rows: [row] } = await tx.execute<MessageRow>(sql`WITH c AS (
        UPDATE support_conversations SET messages = messages + 1, last_message_at = now(), agent_state = 'paused', paused_by = ${operator.userId},
          paused_at = CASE WHEN agent_state = 'paused' AND paused_by = ${operator.userId} THEN paused_at ELSE now() END, done_at = NULL, done_by = NULL
        WHERE id = ${id} RETURNING messages), seen AS (${markRead(operator.userId, id, sql`(SELECT messages FROM c)`)})
      INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, staff_user_id, delivery) SELECT ${messageId}, ${id}, c.messages, 'staff', 'reply', ${text}, ${operator.userId}, 'queued' FROM c
      RETURNING ${messageColumns}`);
    return message(row!);
  }
  const wakeAfter = (c: Ctx, id: string) => c.env.deferNudge ? c.env.deferNudge(async () => { await wakeSupport(c.env.config, id); }) : wakeSupport(c.env.config, id);

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/replies', operationId: 'operatorReplySupportConversation',
    description: 'Reply to the customer as staff (the operator role). The reply is queued for the support platform to deliver, the agent is paused until someone hands back, and the support platform is woken. Needs an Idempotency-Key: repeating it queues nothing new. Refused while the support platform is not pulling replies.',
    request: { params: ConversationParam, headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }), body: json(z.object({ text: z.string().trim().min(1).max(8000) }).strict()) },
    responses: { 201: response(Message), ...errors } }), async c => {
    const id = c.req.valid('param').id, body = c.req.valid('json');
    const reply = await change(c, id, 'support.reply', async (tx, operator, conversation) => {
      const queued = await queueReply(tx, operator, conversation, id, body.text);
      return { result: queued, message: queued.id };
    }, body);
    await wakeAfter(c, id);
    return c.json(reply, 201);
  });

  // A held agent answer: staff send it (as the agent wrote it, or edited) as their own reply, or discard it. Either is
  // decided once; what goes out is a staff reply, delivered like any other. Sent as written, it reads as the agent's own
  // answers do on that channel: plain text by email (the support platform sends the agent's email answers so), Markdown
  // in the chat panel. One held because the person's access shrank, or written by an earlier build, may hold account
  // details they can no longer see: it is never sent, as written or edited. Staff write a fresh reply, which replaces it.
  const DraftParams = ConversationParam.extend({ messageId: z.string().regex(MESSAGE_ID) });
  const FRESH_REPLY: Record<string, string> = { access: 'This person’s access changed after the agent wrote this answer', earlier: 'An earlier version of the agent wrote this answer' };
  async function heldDraft(tx: DbExecutor, id: string, messageId: string, lock = true) {
    // answered: a reply written after it reached the customer (a staff reply, or an agent answer not held or failed).
    const { rows: [draft] } = await tx.execute<{ text: string; held: boolean; outcome: string | null; reason: string | null; answered: boolean }>(sql`SELECT m.text, m.author = 'agent' AND m.delivery = 'held' AS held,
        m.draft_outcome AS outcome, m.held_reason AS reason, EXISTS (SELECT 1 FROM support_messages o WHERE o.conversation_id = m.conversation_id AND o.seq > m.seq AND o.kind IS DISTINCT FROM 'note'
          AND ((o.author = 'staff' AND o.delivery IN ('queued','sent')) OR (o.author = 'agent' AND o.kind IS DISTINCT FROM 'held' AND o.delivery IS DISTINCT FROM 'held' AND o.delivery IS DISTINCT FROM 'failed'))) AS answered
      FROM support_messages m WHERE m.id = ${messageId} AND m.conversation_id = ${id} ${lock ? sql`FOR UPDATE OF m` : sql``}`);
    if (!draft?.held) notFound('Held answer');
    if (draft!.outcome) throw new ApiError(409, 'SUPPORT_DRAFT_DECIDED', 'This held answer was already sent or discarded.');
    return draft!;
  }
  /**
   * Sends a held answer as a staff reply: as the agent wrote it (text omitted; by email as plain text) or edited. As
   * written, it is refused when it needs a fresh reply (the person's access shrank, or an earlier build wrote it) or when
   * a newer reply already reached the customer. The draft records what became of it. The dashboard's Send and an
   * approved "Send the held answer" (support-approvals.ts) both send through here.
   */
  async function sendDraft(tx: DbExecutor, operator: OperatorIdentity, conversation: Locked, id: string, messageId: string, edited?: string) {
    const draft = await heldDraft(tx, id, messageId), written = draft.text.trim(), asWritten = conversation.channel === 'email' ? plainText(written) : written;
    const unchanged = edited === undefined || edited === written || edited === asWritten, fresh = draft.reason ? FRESH_REPLY[draft.reason] : undefined;
    if (fresh && unchanged) throw new ApiError(409, 'SUPPORT_DRAFT_FRESH_REPLY', `${fresh}, so it can’t be sent. Write a fresh reply.`, 'text');
    // As written, it would answer an earlier moment than a reply the customer already has: staff edit it, or discard it.
    if (draft.answered && unchanged) throw new ApiError(409, 'SUPPORT_DRAFT_STALE', 'A newer reply already reached the customer, so this held answer can’t be sent as written. Edit it, or discard it.', 'text');
    const text = edited ?? asWritten;
    if (text.length > 8000) throw new ApiError(422, 'VALIDATION_FAILED', 'This answer is longer than a reply can be: edit it before sending.', 'text');
    const queued = await queueReply(tx, operator, conversation, id, text);
    await tx.execute(sql`UPDATE support_messages SET draft_outcome = ${fresh ? 'replaced' : unchanged ? 'sent' : 'edited'}, draft_by = ${operator.userId}, draft_at = now(), draft_reply = ${queued.id} WHERE id = ${messageId}`);
    return queued;
  }
  /** What sending a held answer as written would send, and why it can't be sent, if it can't: read only, for a confirm step. */
  async function draftPreview(db: DbExecutor, id: string, messageId: string, channel: string) {
    try {
      const draft = await heldDraft(db, id, messageId, false), written = draft.text.trim(), fresh = draft.reason ? FRESH_REPLY[draft.reason] : undefined;
      return { text: channel === 'email' ? plainText(written) : written, blocked: fresh ? `${fresh}, so it can’t be sent. Write a fresh reply.`
        : draft.answered ? 'A newer reply already reached the customer, so this held answer can’t be sent as written.' : null };
    } catch (error) {
      if (error instanceof ApiError) return { text: null, blocked: error.code === 'SUPPORT_DRAFT_DECIDED' ? error.message : 'This held answer is gone.' };
      throw error;
    }
  }
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/drafts/{messageId}/send', operationId: 'operatorSendSupportDraft',
    description: 'Send a held agent answer to the customer as a staff reply (the operator role): as the agent wrote it (by email as plain text, as the agent’s email answers are; in chat as written), or with text (edited). One held because the person’s access shrank, or written by an earlier build, is never sent: send a fresh reply as text (not its text), which replaces it; anything else is 409 SUPPORT_DRAFT_FRESH_REPLY. It is queued, pauses the agent and wakes the support platform like any staff reply, and the held answer records who sent or replaced it. Needs an Idempotency-Key. Refused once decided, on a closed conversation, or while the support platform is not pulling replies.',
    request: { params: DraftParams, headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }), body: { ...json(z.object({ text: z.string().trim().min(1).max(8000).optional().describe('The edited text, or the fresh reply; omit to send it as the agent wrote it.') }).strict()), required: false } },
    responses: { 201: response(Message), ...errors } }), async c => {
    const { id, messageId } = c.req.valid('param'), body: { text?: string } = c.req.valid('json') ?? {};
    const reply = await change(c, id, 'support.draft_send', async (tx, operator, conversation) => {
      const queued = await sendDraft(tx, operator, conversation, id, messageId, body.text);
      return { result: queued, message: queued.id };
    }, body);
    await wakeAfter(c, id);
    return c.json(reply, 201);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/drafts/{messageId}/discard', operationId: 'operatorDiscardSupportDraft',
    description: 'Discard a held agent answer (the operator role): it is never sent, and records who discarded it. Repeats safely with an Idempotency-Key.',
    request: { params: DraftParams, headers: changeHeaders }, responses: { 200: response(Message), ...errors } }), async c => {
    const { id, messageId } = c.req.valid('param');
    return c.json(await change(c, id, 'support.draft_discard', async (tx, operator) => {
      await heldDraft(tx, id, messageId);
      const { rows: [row] } = await tx.execute<MessageRow>(sql`UPDATE support_messages SET draft_outcome = 'discarded', draft_by = ${operator.userId}, draft_at = now() WHERE id = ${messageId} RETURNING ${messageColumns}`);
      return { result: message(row!), message: messageId };
    }), 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/pause', operationId: 'operatorPauseSupportAgent',
    description: 'Pause the agent (the operator role): the support platform records and mirrors the customer’s messages but answers none until someone hands back.',
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.pause', async (tx, operator, conversation) => {
      if (conversation.status === 'closed') throw closedConversation();
      if (conversation.channel === 'agent_feedback') throw noAgent();
      if (conversation.agent_state === 'paused') throw new ApiError(409, 'ALREADY_PAUSED', 'The agent is already paused here.');
      await tx.execute(sql`UPDATE support_conversations SET agent_state = 'paused', paused_by = ${operator.userId}, paused_at = now(), done_at = NULL, done_by = NULL WHERE id = ${id}`);
      await tx.execute(event(id, 'paused', operator.userId, { by: 'staff' }));
      return { result: await one(tx, id, operator.userId) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/resume', operationId: 'operatorResumeSupportAgent',
    description: 'Hand the conversation back to the agent (the operator role): it answers the customer’s next message.',
    request: { params: ConversationParam, headers: changeHeaders }, responses: { 200: response(Item), ...errors } }), async c => {
    const id = c.req.valid('param').id;
    return c.json(await change(c, id, 'support.resume', async (tx, operator, conversation) => {
      if (conversation.status === 'closed') throw closedConversation();
      if (conversation.channel === 'agent_feedback') throw noAgent();
      if (conversation.agent_state !== 'paused') throw new ApiError(409, 'NOT_PAUSED', 'The agent is not paused here.');
      await tx.execute(sql`UPDATE support_conversations SET agent_state = 'active', paused_by = NULL, paused_at = NULL WHERE id = ${id}`);
      await tx.execute(event(id, 'resumed', operator.userId));
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
      await tx.execute(event(id, 'resolved', operator.userId, { ticketId: conversation.ticket_id }));
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
      await tx.execute(event(id, 'done', operator.userId, open ? { ticketId: open } : {}));
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
      await tx.execute(event(id, 'undone', operator.userId));
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
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/notes', operationId: 'operatorNoteSupportConversation',
    description: 'Add an internal note to the conversation (the operator role): staff see it in the timeline; the customer and the agent never do, and it changes nothing about who owes the next message. Repeats safely with an Idempotency-Key.',
    request: { params: ConversationParam, headers: changeHeaders, body: json(z.object({ text: z.string().trim().min(1).max(8000) }).strict()) },
    responses: { 201: response(Message), ...errors } }), async c => {
    const id = c.req.valid('param').id, body = c.req.valid('json');
    const note = await change(c, id, 'support.note', async (tx, operator) => {
      const messageId = newMessageId();
      const { rows: [row] } = await tx.execute<MessageRow>(sql`WITH c AS (UPDATE support_conversations SET messages = messages + 1 WHERE id = ${id} RETURNING messages),
          seen AS (${markRead(operator.userId, id, sql`(SELECT messages FROM c)`)})
        INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, staff_user_id) SELECT ${messageId}, ${id}, c.messages, 'staff', 'note', ${body.text}, ${operator.userId} FROM c
        RETURNING ${messageColumns}`);
      return { result: message(row!), message: messageId };
    }, body);
    return c.json(note, 201);
  });

  // A customer email in full, and its attachments: only an email a message of this conversation came from.
  type Source = { id: string; workspace_id: string; region: string | null; text: string | null; html: string | null; body_truncated: boolean };
  async function sourceOf(c: Ctx, conversationId: string, messageId: string) {
    const { rows: [row] } = await c.env.db.execute<Source>(sql`SELECT mm.id, mm.workspace_id, mm.region, mm.text, mm.html, mm.body_truncated FROM support_messages m
      JOIN mail_messages mm ON mm.id = m.source_message_id AND mm.direction = 'inbound' WHERE m.conversation_id = ${conversationId} AND m.source_message_id = ${messageId} LIMIT 1`);
    return row ?? notFound('Email');
  }
  const EmailParams = ConversationParam.extend({ messageId: z.string().regex(MAIL_MESSAGE_ID) });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}/emails/{messageId}', operationId: 'operatorGetSupportEmail',
    description: 'A customer email of this conversation in full: all of its stored text, and its HTML as stored (render it sandboxed, with remote images off until asked). htmlTooComplex: past the parsing budget; prefer the text.',
    request: { params: EmailParams }, responses: { 200: response(z.object({ id: z.string(), text: z.string(), replyText: z.string(), html: z.string().nullable(), htmlTooComplex: z.boolean(), bodyTruncated: z.boolean() })), ...errors } }), async c => {
    await staff(c, 'operator:read');
    const { id, messageId } = c.req.valid('param'), row = await sourceOf(c, id, messageId), text = row.text ?? (row.html ? htmlToPlain(row.html) : '');
    return c.json({ id: row.id, text, replyText: replyText(text), html: row.html, htmlTooComplex: row.html ? !boundedHtmlFragment(row.html, 'document') : false, bodyTruncated: row.body_truncated }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}/emails/{messageId}/attachments/{attachmentId}', operationId: 'operatorGetSupportEmailAttachment',
    description: 'A download link for one attachment of a customer email of this conversation, for five minutes. Only an attachment scanned clean. On the audit trail.',
    request: { params: EmailParams.extend({ attachmentId: z.string().min(1).max(100) }) }, responses: { 200: response(z.object({ url: z.string(), expiresAt: z.string() })), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), { id, messageId, attachmentId } = c.req.valid('param');
    const { rows: [file] } = await c.env.db.execute<{ workspace_id: string; region: string | null; bucket: string; storage_key: string; filename: string; source_id: string | null }>(sql`SELECT mm.workspace_id, mm.region, a.bucket, a.storage_key, a.filename, a.source_attachment_id AS source_id
      FROM support_messages m JOIN mail_messages mm ON mm.id = m.source_message_id AND mm.direction = 'inbound' JOIN mail_attachments a ON a.message_id = mm.id AND a.id = ${attachmentId}
      WHERE m.conversation_id = ${id} AND m.source_message_id = ${messageId} AND mm.verdicts->>'virus' = 'PASS' LIMIT 1`);
    if (!file?.region) notFound('Attachment');
    await c.env.db.execute(auditInsert(staffContext(c, operator), { action: 'support.inbox_file', workspaceId: null, userId: sql`(SELECT coalesce(user_id, ${operator.userId}) FROM support_conversations WHERE id = ${id})`,
      target: { type: 'support_conversation', id }, details: { message: messageId, attachment: attachmentId }, ticketRef: id, internal: true }));
    return c.json(await signedUrl(c.env, file!.workspace_id, 'att', file!.region!, file!.bucket, file!.storage_key, file!.filename, file!.source_id ? messageId : undefined), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}/files/{attachmentId}', operationId: 'operatorGetSupportFile',
    description: 'A link to one screenshot of this conversation, held by the support platform, for five minutes: the support site serves it after checking the link with Nightmail. On the audit trail.',
    request: { params: ConversationParam.extend({ attachmentId: z.string().regex(ATTACHMENT_ID) }) }, responses: { 200: response(z.object({ url: z.string(), expiresAt: z.string() })), ...errors } }), async c => {
    const operator = await staff(c, 'operator:read'), { id, attachmentId } = c.req.valid('param');
    const site = c.env.config.support?.url, key = c.env.config.support?.signingKey;
    if (!(await c.env.db.execute(sql`SELECT FROM support_messages WHERE conversation_id = ${id} AND attachments @> jsonb_build_array(${attachmentId}::text)`)).rowCount) notFound('Attachment');
    if (!site || !key) throw new ApiError(503, 'SUPPORT_NOT_CONFIGURED', 'The support service isn’t configured here.');
    const exp = Math.floor(Date.now() / 1000) + 300, token = await signSupportToken(key, { iss: c.env.config.publicUrl, aud: FILE_AUDIENCE, conversationId: id, attachmentId, exp });
    await c.env.db.execute(auditInsert(staffContext(c, operator), { action: 'support.inbox_file', workspaceId: null, userId: sql`(SELECT coalesce(user_id, ${operator.userId}) FROM support_conversations WHERE id = ${id})`,
      target: { type: 'support_conversation', id }, details: { attachment: attachmentId }, ticketRef: id, internal: true }));
    const url = new URL(`/attachments/${id}/${attachmentId}`, new URL(site).origin);
    url.searchParams.set('staff', token);
    return c.json({ url: url.toString(), expiresAt: new Date(exp * 1000).toISOString() }, 200);
  });
  // ---------- approvals (src/support-approvals.ts): an emailed link lands here, and only a signed-in operator decides ----------

  const ApprovalParams = z.object({ id: z.string().regex(CONVERSATION_ID), approvalId: z.string().regex(/^apr_[a-z2-7]{26}$/) });
  const Approval = z.object({
    id: z.string(), conversationId: z.string(), kind: z.string(), label: z.string().describe('What approving does, in a few words.'), effect: z.string().describe('What happens, in one sentence.'),
    risky: z.boolean(), summary: z.string().nullable().describe('The exact target in Nightmail\u2019s words (an agent\u2019s risky proposal): what it acts on, with its numbers.'),
    reason: z.string().describe('Why it was proposed: the proposer\u2019s words (the agent\u2019s, for a risky one).'), proposedBy: z.enum(['nightmail', 'agent']),
    state: z.enum(['proposed', 'approved', 'declined', 'failed', 'expired']), createdAt: z.string(), expiresAt: z.string(), decidedAt: z.string().nullable(),
    decidedBy: z.object({ userId: z.string(), name: z.string().nullable() }).nullable(), result: z.record(z.string(), z.unknown()).nullable(),
    change: z.object({ now: z.string(), after: z.string() }).nullable().describe('A limit or balance it changes: its value now, read when this is opened, and after approving.'),
    preview: z.object({ text: z.string().nullable().describe('Exactly what would be sent.'), blocked: z.string().nullable().describe('Why it can\u2019t be, now.') }).nullable()
      .describe('Send the held answer: the answer as it would go, and why it can\u2019t go, when it can\u2019t (it needs a fresh reply, a newer reply reached them, or it was decided).'),
  }).openapi('SupportApproval');
  type ApprovalRow = { id: string; conversation_id: string; kind: string; payload: Record<string, unknown>; proposed_by: 'nightmail' | 'agent'; reason: string; state: 'proposed' | 'approved' | 'declined' | 'failed';
    created_at: string; expires_at: string; expires_ms: number; expired: boolean; decided_at: string | null; decided_by: string | null; decided_by_name: string | null; result: Record<string, unknown> | null };
  /** The approval, only through its link's token: a wrong or missing token is the same 404 as no approval at all. */
  async function approvalOf(db: DbExecutor, secret: string, p: z.infer<typeof ApprovalParams>, token: string, lock = false) {
    const { rows: [r] } = await db.execute<ApprovalRow>(sql`SELECT a.id, a.conversation_id, a.kind, a.payload, a.proposed_by, a.reason, a.state, a.created_at::text AS created_at, a.expires_at::text AS expires_at, ${EXPIRES_MS},
        a.expires_at <= now() AS expired, a.decided_at::text AS decided_at, a.decided_by, (SELECT name FROM nightmail_users WHERE id = a.decided_by) AS decided_by_name, a.result
      FROM support_approvals a WHERE a.id = ${p.approvalId} AND a.conversation_id = ${p.id} ${lock ? sql`FOR UPDATE` : sql``}`);
    if (!r || !isKind(r.kind) || !validToken(secret, { id: r.id, conversationId: r.conversation_id, expiresAt: new Date(Number(r.expires_ms)) }, token)) notFound('Approval');
    return r!;
  }
  const approvalView = (r: ApprovalRow, preview: z.infer<typeof Approval>['preview'] = null, change: z.infer<typeof Approval>['change'] = null): z.infer<typeof Approval> => {
    const kind = KINDS[r.kind as keyof typeof KINDS];
    return { preview, change, id: r.id, conversationId: r.conversation_id, kind: r.kind, label: kind.label, effect: kind.effect, risky: kind.risky, summary: kind.summary?.(r.payload) ?? null, reason: r.reason, proposedBy: r.proposed_by,
      state: r.state === 'proposed' && r.expired ? 'expired' : r.state, createdAt: isoTime(r.created_at)!, expiresAt: isoTime(r.expires_at)!, decidedAt: isoTime(r.decided_at),
      decidedBy: r.decided_by ? { userId: r.decided_by, name: r.decided_by_name } : null, result: r.result };
  };
  /** A held answer's approval shows what would go, and why it can't, while it waits. */
  async function previewOf(db: DbExecutor, a: ApprovalRow) {
    if (a.kind !== 'send_held_answer' || a.state !== 'proposed') return null;
    const { rows: [conversation] } = await db.execute<{ channel: string }>(sql`SELECT channel FROM support_conversations WHERE id = ${a.conversation_id}`);
    return draftPreview(db, a.conversation_id, String(a.payload.messageId ?? ''), conversation?.channel ?? 'email');
  }
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'get', path: '/v1/operator/support-inbox/{id}/approvals/{approvalId}', operationId: 'operatorGetSupportApproval',
    description: 'An approval an email linked to (operator:read): what it does and where it stands. token is the link\u2019s; without the right one it is 404. Reading it changes nothing.',
    request: { params: ApprovalParams, query: z.object({ token: z.string().min(1).max(100) }) }, responses: { 200: response(Approval), ...errors } }), async c => {
    await staff(c, 'operator:read');
    const params = c.req.valid('param'), a = await approvalOf(c.env.db, c.env.config.authSecret, params, c.req.valid('query').token);
    const change = a.state === 'proposed' && !a.expired ? await KINDS[a.kind as keyof typeof KINDS].change?.(c.env.db, a.payload) ?? null : null;
    return c.json(approvalView(a, await previewOf(c.env.db, a), change), 200);
  });
  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/approvals/{approvalId}', operationId: 'operatorDecideSupportApproval',
    description: 'Approve or decline it (the operator role), once, before it expires: approving runs it as the dashboard\u2019s own button for it would. On the audit trail and the conversation\u2019s timeline.',
    request: { params: ApprovalParams, headers: changeHeaders, body: json(z.object({ token: z.string().min(1).max(100), decision: z.enum(['approve', 'decline']) }).strict()) },
    responses: { 200: response(Approval), ...errors } }), async c => {
    const params = c.req.valid('param'), body = c.req.valid('json');
    let sent = false;
    const view = await change(c, params.id, `support.approval.${body.decision}`, async (tx, operator, conversation) => {
      const a = await approvalOf(tx, c.env.config.authSecret, params, body.token, true);
      if (a.state !== 'proposed') throw new ApiError(409, 'SUPPORT_APPROVAL_DECIDED', 'This was already decided.');
      if (a.expired) throw new ApiError(409, 'SUPPORT_APPROVAL_EXPIRED', 'This proposal expired. Open the conversation to act on it.');
      let state: 'approved' | 'declined' | 'failed' = 'declined', result: Record<string, unknown> | null = null;
      if (body.decision === 'approve') {
        // A refused run gives back whatever it wrote before its refusal, and the decision records the refusal.
        await tx.execute(sql`SAVEPOINT support_approval`);
        try {
          result = await KINDS[a.kind as keyof typeof KINDS].run({ wake: id => wakeSupport(c.env.config, id), sendDraft: messageId => sendDraft(tx, operator, conversation, params.id, messageId),
            tx, c, operator, userId: conversation.user_id, approvalId: a.id }, a.conversation_id, a.payload);
          state = 'approved'; sent = a.kind === 'send_held_answer';
          await tx.execute(sql`RELEASE SAVEPOINT support_approval`);
        } catch (error) {
          // Refused as the dashboard's own button would be (a stale draft, one that needs a fresh reply, a closed conversation,
          // a workspace already paused): said, not thrown.
          if (!(error instanceof ApiError)) throw error;
          await tx.execute(sql`ROLLBACK TO SAVEPOINT support_approval`);
          state = 'failed'; result = { error: error.code, message: error.message };
        }
      }
      const { rows: [decided] } = await tx.execute<ApprovalRow>(sql`UPDATE support_approvals SET state = ${state}, decided_by = ${operator.userId}, decided_at = now(), result = ${result ? JSON.stringify(result) : null}::jsonb
        WHERE id = ${a.id} RETURNING id, conversation_id, kind, payload, proposed_by, reason, state, created_at::text AS created_at, expires_at::text AS expires_at, ${EXPIRES_MS}, false AS expired,
          decided_at::text AS decided_at, decided_by, (SELECT name FROM nightmail_users WHERE id = ${operator.userId}) AS decided_by_name, result`);
      await tx.execute(event(params.id, body.decision === 'approve' ? 'approved' : 'declined', operator.userId, { approval: a.id, kind: a.kind, label: KINDS[a.kind as keyof typeof KINDS].label, ...state === 'failed' ? { failed: true } : {} }));
      return { result: approvalView(decided!) };
    }, body);
    if (sent) await wakeAfter(c, params.id);
    return c.json(view, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security: sessionSecurity, method: 'post', path: '/v1/operator/support-inbox/{id}/wake', operationId: 'operatorWakeSupportConversation',
    description: 'Retry now (the operator role): wake the support platform for this conversation, with nothing but its ID. woken: false when no support site is configured or it did not answer.',
    request: { params: ConversationParam }, responses: { 200: response(z.object({ id: z.string(), woken: z.boolean() })), ...errors } }), async c => {
    await staff(c, 'operator');
    const id = c.req.valid('param').id;
    const { rows: [found] } = await c.env.db.execute<{ channel: string }>(sql`SELECT channel FROM support_conversations WHERE id = ${id}`);
    if (!found) notFound('Support conversation');
    if (found!.channel === 'agent_feedback') throw noAgent();
    return c.json({ id, woken: await wakeSupport(c.env.config, id) }, 200);
  });
}
