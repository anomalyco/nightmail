import { z } from '@hono/zod-openapi';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApiError, isoTime, redactCapabilityText, type DbExecutor, type MailboxAccess } from './core.js';
import { mailboxMessages as links, mailMessages as messages, retainedMail } from './db/mailbox.js';
import type { EmailSnapshot } from './db/sending.js';
import { normalizeMessageId, snippetOf } from './mailbox-store.js';
import { addressedToDomains, oneOf } from './domain-mail.js';

// Which stored messages a reader sees, and an email's whole conversation: the thread block of getEmailDetail and
// getInboundMessage (includeThread=true), and the thread and its size on each listLogs row. Nothing heavier than the
// schemas, so the sending routes read it without loading the mailbox modules.
//
// A conversation is an inbox thread (mail_threads): its stored messages, received ones and the copy every mailbox send
// writes (mail_messages.sending_email_id), and the emails sent with sendEmail that joined it by answering one of its
// messages. A header names a Message-ID; it is no authorization. An email joins only when its sender could read the
// message its In-Reply-To names, checked when it is sent (joinReplies), and the thread it joined is in its snapshot.
//
// A reader sees a conversation only through the stored messages it can read one by one (accessibleMessages:
// administrators retained mail, members mail on live addresses, address and inbox keys their own addresses). With none,
// there is no thread for it: no thread ID, count or block, even for an email it can read. The emails that joined by
// replying are ordinary sends: a workspace credential with mail access reads them; a key limited to addresses or an
// inbox reads no ordinary send, so it never sees them.

export type Filter = { addressId?: string; threadId?: string; messageId?: string };
export const liveBox = (bid: SQLWrapper) => sql`NOT EXISTS(SELECT FROM mailboxes ended WHERE ended.id=${bid} AND ended.delete_after<=statement_timestamp())`;
export function visibleLinks(value: MailboxAccess, filter: Filter) {
  if (filter.addressId && value.mailboxIds && !value.mailboxIds.includes(filter.addressId)) throw new ApiError(404, 'NOT_FOUND', 'Address was not found.');
  return and(liveBox(links.mailboxId), sql`${links.heldReason} IS NULL`, eq(links.workspaceId, value.workspaceId),
    filter.addressId ? eq(links.mailboxId, filter.addressId) : value.mailboxIds ? oneOf(links.mailboxId, value.mailboxIds) : undefined,
    filter.threadId ? eq(links.threadId, filter.threadId) : undefined, filter.messageId ? eq(links.messageId, filter.messageId) : undefined,
    value.domains ? addressedToDomains(value.domains, links.messageId) : undefined);
}
// Which stored messages a reader can see. Shared with the message reads and the unified logs (logs.ts), so every list
// applies the same rule. It names mail_messages and mailbox_messages unaliased: mail_messages is the row being read.
export const accessibleMessages = (v: MailboxAccess, f: Filter, retentionProbe?: Parameters<typeof retainedMail>[0]) => and(eq(messages.workspaceId, v.workspaceId),
  v.admin && !f.addressId ? retainedMail(retentionProbe) : sql`EXISTS (SELECT 1 FROM ${links} WHERE ${visibleLinks(v, f)} AND ${links.messageId}=${messages.id})`);

// Mail sent from a receiving address or inbox is conversation mail: a reply can quote the message it answers and a
// forward carries it whole. The sending log lists and reads it only for credentials the receiving API lets read
// mailboxes (actorMailAccess). Rows queued before snapshots recorded their origin are known by their mailbox message.
// Names sending_emails unaliased.
export const mailboxMail = sql`(sending_emails.snapshot @> '{"mailbox":true}'::jsonb OR EXISTS (SELECT FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id))`;
// NOT mailboxMail, spelled so its NOT EXISTS plans as an anti-join on mail_messages_sending, not a hash of every message.
const ordinaryMail = sql`NOT sending_emails.snapshot @> '{"mailbox":true}'::jsonb AND NOT EXISTS (SELECT FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id)`;

/**
 * Before an ordinary send is admitted (admitEmails): each email whose In-Reply-To names a stored message its sender can
 * read joins that message's thread (snapshot.threadId). Its sender's access is the one its key or session has now.
 */
export async function joinReplies(db: DbExecutor, access: MailboxAccess | null, snapshots: EmailSnapshot[]) {
  const asked = snapshots.flatMap(snapshot => {
    const header = snapshot.headers.find(h => h.Name.toLowerCase() === 'in-reply-to'), id = header && normalizeMessageId(header.Value);
    return id ? [{ snapshot, id }] : [];
  });
  if (!access || !asked.length) return;
  const { rows } = await db.execute<{ message_id: string; thread_id: string }>(sql`SELECT i.message_id, mail_messages.thread_id FROM mail_message_ids i
    JOIN mail_messages ON mail_messages.id=i.mail_message_id AND mail_messages.workspace_id=i.workspace_id
    WHERE i.workspace_id=${access.workspaceId} AND i.message_id=ANY(${sql.param(asked.map(a => a.id))}::text[]) AND ${accessibleMessages(access, {})}`);
  const threads = new Map(rows.map(row => [row.message_id, row.thread_id]));
  for (const { snapshot, id } of asked) { const thread = threads.get(id); if (thread) snapshot.threadId = thread; }
}

// The emails that joined a thread by replying, without a mailbox copy: exactly the partial index
// sending_emails_reply_thread (migration 350). Names sending_emails unaliased.
const replies = (workspaceId: string, thread: SQL) => sql`sending_emails.workspace_id=${workspaceId} AND sending_emails.snapshot ? 'threadId' AND sending_emails.snapshot->>'threadId'=${thread} AND ${ordinaryMail}`;
/** The thread of the sending_emails row being read (unaliased): its mailbox copy's, or the one it joined by replying. */
export const sentThreadId = sql<string | null>`coalesce(
  (SELECT m.thread_id FROM mail_messages m WHERE m.workspace_id=sending_emails.workspace_id AND m.sending_email_id=sending_emails.id),
  sending_emails.snapshot->>'threadId')`;

/** How many messages of a thread (a column) the reader sees, counted as threadBlock counts them; null when it reads none of its stored messages. */
export const threadSize = (access: MailboxAccess, sends: boolean, thread: SQL) => sql<number | null>`(SELECT CASE WHEN s.n > 0 THEN s.n ${sends ? sql`+ (SELECT count(*) FROM sending_emails WHERE ${replies(access.workspaceId, thread)})` : sql``} END
  FROM (SELECT count(*) AS n FROM mail_messages WHERE mail_messages.thread_id=${thread} AND ${accessibleMessages(access, {})}) s)::int`;

const WINDOW = 50;
/**
 * The conversation of the row being read, as one jsonb value of the statement that reads it (threadView shapes it), or
 * null when the reader sees none of its stored messages. thread and focus are that row's thread and its message or email
 * ID, read before the subquery opens its own mail_messages and sending_emails. sends: also the emails that joined it
 * by replying (a workspace credential with mail access, without an address filter).
 */
export function threadBlock(access: MailboxAccess, input: { thread: SQL; focus: SQL; addressId?: string; sends: boolean }) {
  const stored = sql`SELECT mail_messages.id, mail_messages.sending_email_id AS email_id, true AS stored, mail_messages.received_at AS at, jsonb_build_object('id', mail_messages.id, 'emailId', mail_messages.sending_email_id,
      'direction', mail_messages.direction, 'fromName', mail_messages.from_name, 'fromAddress', mail_messages.from_address, 'snippet', mail_messages.snippet, 'at', mail_messages.received_at,
      'status', mail_messages.status, 'attachmentCount', mail_messages.attachment_count) AS m
    FROM mail_messages WHERE mail_messages.thread_id=ctx.thread_id AND ${accessibleMessages(access, { addressId: input.addressId })}`;
  // What was sent stands in for a stored snippet, redacted as getEmailContent redacts it (threadView).
  const sent = sql`SELECT sending_emails.id, sending_emails.id AS email_id, false AS stored, sending_emails.created_at AS at, jsonb_build_object('id', sending_emails.id, 'emailId', sending_emails.id,
      'direction', 'outbound', 'fromName', sending_emails.snapshot->>'fromName', 'fromAddress', sending_emails.from_address, 'at', sending_emails.created_at, 'status', sending_emails.status,
      'attachmentCount', coalesce(jsonb_array_length(sending_emails.snapshot->'attachments'), 0), 'reply', true, 'sealed', coalesce((sending_emails.snapshot->>'sealed')::boolean, false),
      'text', left(sending_emails.snapshot->>'text', 4096), 'html', CASE WHEN sending_emails.snapshot->>'text' IS NULL THEN left(sending_emails.snapshot->>'html', 16384) END) AS m
    FROM sending_emails WHERE ${replies(access.workspaceId, sql`ctx.thread_id`)}`;
  // A long conversation keeps the messages around this one: up to half the window before it, and the rest after.
  return sql<RawThread | null>`(SELECT CASE WHEN max(w.stored) > 0 THEN jsonb_build_object('id', max(w.thread_id), 'count', max(w.total),
      'messages', coalesce(jsonb_agg(w.m ORDER BY w.n) FILTER (WHERE w.n > w.start AND w.n <= w.start + ${WINDOW}), '[]'::jsonb)) END
    FROM (SELECT f.*, greatest(0, least(coalesce(f.here, f.total) - ${WINDOW / 2}, f.total - ${WINDOW})) AS start
      FROM (SELECT o.*, max(CASE WHEN o.focused THEN o.n END) OVER () AS here
        FROM (SELECT ctx.thread_id, v.m, v.id = ctx.focus OR v.email_id = ctx.focus AS focused, row_number() OVER (ORDER BY v.at, v.id) AS n,
            count(*) OVER () AS total, count(*) FILTER (WHERE v.stored) OVER () AS stored
          FROM (SELECT ${input.thread} AS thread_id, ${input.focus} AS focus) ctx
          CROSS JOIN LATERAL (${stored}${input.sends ? sql` UNION ALL ${sent}` : sql``}) v) o) f) w)`;
}

const Address = z.object({ name: z.string().nullable(), address: z.string() });
export const ThreadMessage = z.object({
  id: z.string().describe('The stored message (getInboundMessage). An email sent with sendEmail that joined the conversation by answering one of its messages has no stored copy: its email ID.'),
  emailId: z.string().nullable().describe('The sent email (getEmailDetail) of an outbound message; null for received mail.'),
  direction: z.enum(['inbound', 'outbound']),
  from: Address,
  snippet: z.string(),
  at: z.string().describe('When it was received or sent.'),
  status: z.string().describe('Received mail: received. Sent mail: the email status (scheduled while it waits for its time).'),
  attachmentCount: z.number().int(),
}).openapi('ThreadMessage');
export const EmailThread = z.object({
  id: z.string().describe('The conversation (getInboundThread).'),
  count: z.number().int().describe('Messages in it that the caller can read.'),
  messages: z.array(ThreadMessage).describe(`Up to ${WINDOW} of them around this email, oldest first.`),
}).openapi('EmailThread');

type RawMessage = { id: string; emailId: string | null; direction: 'inbound' | 'outbound'; fromName: string | null; fromAddress: string; snippet?: string; at: string; status: string; attachmentCount: number;
  reply?: true; sealed?: boolean; text?: string | null; html?: string | null };
export type RawThread = { id: string; count: number; messages: RawMessage[] };
/** threadBlock's value as the API returns it. manage: snippets keep unsubscribe capabilities, as getEmailContent shows them. */
export function threadView(raw: RawThread | null, manage: boolean): z.infer<typeof EmailThread> | null {
  if (!raw) return null;
  return { id: raw.id, count: raw.count, messages: raw.messages.map(m => {
    const snippet = m.reply ? m.sealed ? '' : snippetOf(m.text, m.html) : m.snippet ?? '';
    return { id: m.id, emailId: m.emailId, direction: m.direction, from: { name: m.fromName, address: m.fromAddress }, snippet: m.reply && !manage ? redactCapabilityText(snippet) : snippet,
      at: isoTime(m.at)!, status: m.status, attachmentCount: m.attachmentCount };
  }) };
}
