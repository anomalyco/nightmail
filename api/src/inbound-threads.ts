import type {Verdicts} from './db/mailbox.js';
import { mailObjectUrl } from './mail-object-route.js';
import { boundMailBucket, isS3Bucket } from './mail-objects.js';
import type { S3Client } from '@aws-sdk/client-s3';
import { readableMailboxKey, mailboxS3 } from './mailbox-setup.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { actorMailAccess, ApiError, budgetedRead, denied, errors, isoTime, json, lazyModule, page, readLimit, readLimitNote, response, security, statementTimedOut, type Actor, type App, type Ctx, type DbExecutor, type MailboxAccess, type Runtime } from './core.js';
import { PAGE_MAX_BYTES, withBoundedRead } from './read-bounds.js';
import { fitPageByBytes, INBOUND_ADDRESS_PAGE_LIMIT, INBOUND_ADDRESS_STORE_LIMIT, messageFieldCount, sliceJsonbArray } from './inbound-bounds.js';
import { productName } from './brand.js';

const loadS3Presign = lazyModule(() => Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]));
import { mailboxMessages as links, mailboxThreads, mailAttachments, mailMessages as messages } from './db/mailbox.js';
import { oneOf } from './domain-mail.js';
import { accessibleMessages, EmailThread, liveBox, threadBlock, threadView, visibleLinks, type Filter, type RawThread } from './thread-view.js';
import { htmlToPlain, replyText } from './mailbox-store.js';
import { boundedHtmlFragment } from './bounded-html.js';
import { archiveMailboxFiles, sendFromMailbox, finishMailboxArchive, type OutgoingMessage } from './mailbox-send.js';
import { idempotent, idempotentRequest, SendIdempotencyHeaders } from './idempotency.js';
import { SuppressionReason } from './core.js';

const base = '/v1/inbound/threads';
const tags = ['Inbound threads'];
const Id = z.string().min(1).max(120);
export const InboundAddressId = Id.describe('Opaque inbound address ID (mbx_…).');
const ThreadParams = z.object({ threadId: Id });
const Address = z.object({ name: z.string().nullable(), address: z.string() });
export const AddressState = z.object({addressId:Id, unreadCount:z.number().int(), archived:z.boolean(), starred:z.boolean(), trashed:z.boolean(), spam:z.boolean(), labels:z.array(z.string())}).openapi('InboundThreadAddressState');
const Thread = z.object({
  id: z.string(), subject: z.string(), snippet: z.string(), lastMessageAt: z.string(),
  from: Address.describe('Sender of the newest visible message (the subject and snippet are from it). For a sent reply this is your own address.'),
  addressIds: z.array(z.string()), messageCount: z.number().int().describe('Distinct messages visible within the requested address scope.'),
}).openapi('InboundThread');
const Message = z.object({
  simulated:z.boolean().optional(),
  id: z.string(), threadId: z.string(), addressIds: z.array(z.string()), direction: z.enum(['inbound', 'outbound']), status: z.string(),
  from: Address, to: z.array(Address).describe('Addresses in the To header (at most 20 on conversation pages, up to 100 on getInboundMessage).'),
  toCount: z.number().int().describe('Total addresses in the To header (may exceed to.length when shortened).'),
  cc: z.array(Address).describe('Addresses in the Cc header (at most 20 on conversation pages, up to 100 on getInboundMessage).'),
  ccCount: z.number().int().describe('Total addresses in the Cc header (may exceed cc.length when shortened).'),
  replyTo: z.array(Address).describe('Addresses in the Reply-To header (at most 20 on conversation pages, up to 100 on getInboundMessage).'),
  replyToCount: z.number().int().describe('Total addresses in the Reply-To header (may exceed replyTo.length when shortened).'),
  subject: z.string(), snippet: z.string(),
  text: z.string(), replyText: z.string(), receivedAt: z.string(), bodyTruncated: z.boolean(), attachmentCount: z.number().int(), read:z.boolean(), errorCode:z.string().nullable(), suppressionReason:SuppressionReason.nullable().optional(),
  emailId: z.string().nullable(), messageId: z.string().nullable().describe(`RFC Message-ID, not the ${productName} message ID (id).`),
  inReplyTo: z.string().nullable(), references: z.array(z.string()).describe('Message-IDs in the References header (at most 20 on conversation pages, up to 100 on getInboundMessage).'),
  referencesCount: z.number().int().describe('Total Message-IDs in the References header (may exceed references.length when shortened).'),
}).openapi('InboundMessage');
const Cursor = z.string().min(1).max(300).optional().describe('Opaque cursor from the preceding page, with the same filters.');
const AddressFilter = z.object({ addressId: InboundAddressId.optional() }).strict();
const PageQuery = AddressFilter.extend({ cursor: Cursor, limit: z.coerce.number().int().min(1).max(100).default(25) });
const View = z.enum(['all', 'inbox', 'archive', 'starred', 'trash', 'spam']);
const ListQuery = PageQuery.extend({ view: View.default('all'), q: z.string().trim().min(1).max(200).optional() });

// Preserve Postgres microseconds in the cursor even though the public timestamps use milliseconds.
const preciseTime = (column: SQLWrapper) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const timestamp = (value: string) => isoTime(value)!;
const cursorPair = z.tuple([z.iso.datetime(), Id]);
function decodeCursor(value?: string) {
  if (!value) return null;
  try { return cursorPair.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the cursor returned by the previous page.', 'cursor'); }
}
const encodeCursor = (time: string, id: string) => Buffer.from(JSON.stringify([time, id])).toString('base64url');

// Delivery details (SMTP envelope, region, spam verdict, headers, raw message) go to owner and admin dashboard sessions and
// unrestricted manage API keys only; MCP grants, agent tokens and the API keys a grant created read mail without them.
// Shared with logs.ts.
export const readsDelivery = (actor: Actor | undefined, v: MailboxAccess) => (actor?.credential==='dashboard' && actor.role!=='member') || (actor?.credential==='apiKey' && !actor.grantId && v.admin);
// The receiving addresses each stored message was delivered to that a reader can see (which messages: thread-view.ts).
// Shared with the unified logs (logs.ts).
export const visibleAddresses = (v:MailboxAccess,q:Filter={}) => sql<{id:string;address:string}[]>`coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'address',a.address) ORDER BY a.id)
    FROM mailbox_messages JOIN mailboxes a ON a.id=mailbox_messages.mailbox_id
    WHERE ${visibleLinks(v,q)} AND mailbox_messages.message_id=mail_messages.id), '[]'::jsonb)`;

export function visibleThreadAddresses(value: MailboxAccess, threadId: string, addressId?: string) {
  if (addressId && value.mailboxIds && !value.mailboxIds.includes(addressId)) throw new ApiError(404,'NOT_FOUND','Address was not found.');
  return and(liveBox(mailboxThreads.mailboxId),eq(mailboxThreads.threadId,threadId),eq(mailboxThreads.workspaceId,value.workspaceId),
    addressId ? eq(mailboxThreads.mailboxId,addressId) : value.mailboxIds ? oneOf(mailboxThreads.mailboxId,value.mailboxIds) : undefined,
    // A key limited to sender domains: only the addresses where it reads a message of this thread.
    value.domains ? sql`EXISTS (SELECT FROM ${links} WHERE ${visibleLinks(value, { threadId })} AND ${links.mailboxId} = ${mailboxThreads.mailboxId})` : undefined);
}
/** A thread state's unread count, for a key limited to sender domains counted over the messages it reads. */
const unreadOf = (value: MailboxAccess, threadId: string) => value.domains
  ? sql<number>`(SELECT count(*)::int FROM ${links} WHERE ${visibleLinks(value, { threadId })} AND ${links.mailboxId} = ${mailboxThreads.mailboxId} AND NOT ${links.read})`
  : sql<number>`${mailboxThreads.unreadCount}`;

async function threadPage(db: DbExecutor, value: MailboxAccess, filter: Filter, options: { view?: z.infer<typeof View>; q?: string; cursor?: string; limit: number }) {
  const after = decodeCursor(options.cursor), view = options.view;
  const t = mailboxThreads;
  const viewMatch = (alias: string) => {
    const a = sql.raw(alias);
    if (view === 'trash') return sql`${a}.trashed_at IS NOT NULL`;
    if (!view || view === 'all') return null;
    if (view === 'inbox') return sql`${a}.trashed_at IS NULL AND NOT ${a}.archived AND NOT ${a}.spam`;
    if (view === 'archive') return sql`${a}.trashed_at IS NULL AND ${a}.archived`;
    if (view === 'spam') return sql`${a}.trashed_at IS NULL AND ${a}.spam`;
    return sql`${a}.trashed_at IS NULL AND ${a}.starred`;
  };
  // Match search/view at the thread level. An older matching message (or one matching address)
  // must not replace the newest visible snippet, narrow the address list, or reduce the count.
  const visibility = visibleLinks(value, filter); // Also validates an explicit address filter against the grant.
  type PageRow = { id: string; subject: string; snippet: string; from_name: string | null; from_address: string; at: string; address_ids: string[]; message_count: number };
  const singleAddress = !filter.threadId && !options.q
    ? (filter.addressId ?? (value.mailboxIds?.length === 1 ? value.mailboxIds[0] : undefined))
    : undefined;
  const latest = (boxFilter: SQL) => sql`CROSS JOIN LATERAL (
      SELECT mm.message_id AS latest_id FROM mailbox_messages mm
      WHERE mm.workspace_id=${value.workspaceId} AND mm.held_reason IS NULL AND mm.thread_id=threads.id AND ${boxFilter}
      ORDER BY mm.received_at DESC, mm.message_id DESC LIMIT 1
    ) detail`;
  const countExpr = sql`CASE WHEN cardinality(threads.address_ids)=1 THEN threads.single_count
      ELSE (SELECT count(DISTINCT mm.message_id)::int FROM mailbox_messages mm
            WHERE mm.workspace_id=${value.workspaceId} AND mm.held_reason IS NULL AND mm.thread_id=threads.id AND mm.mailbox_id=ANY(threads.address_ids)) END`;
  let rows: { rows: PageRow[] } | undefined;
  if (value.domains) {
    // A key limited to sender domains reads only some messages of a mailbox's thread (addressedToDomains), so its threads,
    // their counts, newest message and time come from those messages, never from mailbox_threads' summaries of them all.
    const state = viewMatch('s');
    rows = await db.execute<PageRow>(sql`
      WITH visible AS MATERIALIZED (
        SELECT ${links.threadId} AS thread_id, ${links.mailboxId} AS mailbox_id, ${links.messageId} AS message_id, ${links.receivedAt} AS received_at
        FROM ${links} WHERE ${visibility}
      ), threads AS MATERIALIZED (
        SELECT v.thread_id AS id, max(v.received_at) AS last_at, array_agg(DISTINCT v.mailbox_id ORDER BY v.mailbox_id) AS address_ids, count(DISTINCT v.message_id)::int AS message_count
        FROM visible v GROUP BY v.thread_id
      ), page AS MATERIALIZED (
        SELECT * FROM threads WHERE true
          ${after ? sql`AND (threads.last_at, threads.id) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
          ${state ? sql`AND EXISTS (SELECT FROM mailbox_threads s WHERE s.workspace_id=${value.workspaceId} AND s.thread_id=threads.id AND s.mailbox_id=ANY(threads.address_ids) AND ${state})` : sql``}
          ${options.q ? sql`AND EXISTS (SELECT FROM visible v JOIN mail_messages searched ON searched.id=v.message_id WHERE v.thread_id=threads.id AND searched.search @@ websearch_to_tsquery('simple', ${options.q}))` : sql``}
        ORDER BY threads.last_at DESC, threads.id DESC LIMIT ${options.limit + 1}
      ) SELECT page.id, m.subject, m.snippet, m.from_name, m.from_address, ${preciseTime(sql`page.last_at`)} AS at, page.address_ids, page.message_count
        FROM page CROSS JOIN LATERAL (SELECT v.message_id AS latest_id FROM visible v WHERE v.thread_id=page.id ORDER BY v.received_at DESC, v.message_id DESC LIMIT 1) detail
        JOIN mail_messages m ON m.id=detail.latest_id ORDER BY page.last_at DESC, page.id DESC`);
  } else if (singleAddress) {
    // One address has at most one mailbox_threads row per thread: walk the index directly without GROUP BY.
    // Check liveBox once as a constant InitPlan so the planner keeps the index scan instead of misestimating an anti-join.
    const state = viewMatch('t');
    rows = await db.execute<PageRow>(sql`
      WITH threads AS MATERIALIZED (
        SELECT t.thread_id AS id, t.last_message_at AS last_at, ARRAY[t.mailbox_id] AS address_ids, t.message_count
        FROM mailbox_threads t
        WHERE t.workspace_id=${value.workspaceId} AND t.mailbox_id=${singleAddress}
          AND NOT EXISTS(SELECT FROM mailboxes ended WHERE ended.id=${singleAddress} AND ended.delete_after<=statement_timestamp())
          ${after ? sql`AND (t.last_message_at, t.thread_id) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
          ${state ? sql`AND ${state}` : sql``}
        ORDER BY t.last_message_at DESC, t.thread_id DESC LIMIT ${options.limit + 1}
      ) SELECT threads.id, m.subject, m.snippet, m.from_name, m.from_address, ${preciseTime(sql`threads.last_at`)} AS at, threads.address_ids, threads.message_count
        FROM threads ${latest(sql`mm.mailbox_id=${singleAddress}`)}
        JOIN mail_messages m ON m.id=detail.latest_id ORDER BY threads.last_at DESC, threads.id DESC`);
  } else if (!filter.threadId && !options.q && (!view || view === 'all' || view === 'inbox')) {
    // REVIEW CANDIDATE (round 2). Read a bounded batch of the newest rows, keep the first row of each conversation in it,
    // and check each such conversation ONCE for a better row outside the batch. Whatever index the planner picks for that
    // check, a conversation on N addresses costs N once, not N per row. If the batch cannot fill the page (one very wide
    // conversation, or a nearly empty Inbox), try a batch ten times larger, then fall back to the grouped statement below.
    const scopeList = value.mailboxIds ? sql.param(value.mailboxIds) : null;
    const scoped = (alias: string) => scopeList ? sql`AND ${sql.raw(alias)}.mailbox_id=ANY(${scopeList}::text[])` : sql``;
    const state = viewMatch('s');
    const want = options.limit + 1;
    for (const batch of [want * 8, want * 80]) {
      const res = await db.execute<PageRow & { scanned: number; found: number }>(sql`
        WITH head AS MATERIALIZED (
          SELECT t.thread_id, t.last_message_at, t.mailbox_id, t.message_count
          FROM mailbox_threads t
          WHERE t.workspace_id=${value.workspaceId} ${scoped('t')}
            AND ${liveBox(sql`t.mailbox_id`)}
            ${after ? sql`AND (t.last_message_at, t.thread_id) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
          ORDER BY t.last_message_at DESC, t.thread_id DESC LIMIT ${batch}
        ), firsts AS MATERIALIZED (
          SELECT DISTINCT ON (h.thread_id) h.thread_id AS id, h.last_message_at AS last_at, h.mailbox_id, h.message_count AS single_count
          FROM head h ORDER BY h.thread_id, h.last_message_at DESC, h.mailbox_id
        ), winners AS MATERIALIZED (
          SELECT f.id, f.last_at, f.single_count FROM firsts f
          WHERE NOT EXISTS (
            SELECT FROM mailbox_threads n
            WHERE n.workspace_id=${value.workspaceId} AND n.thread_id=f.id ${scoped('n')}
              AND ${liveBox(sql`n.mailbox_id`)}
              AND (n.last_message_at > f.last_at OR (n.last_message_at = f.last_at AND n.mailbox_id < f.mailbox_id))
          )
          ${state ? sql`AND EXISTS (
            SELECT FROM mailbox_threads s
            WHERE s.workspace_id=${value.workspaceId} AND s.thread_id=f.id ${scoped('s')}
              AND ${liveBox(sql`s.mailbox_id`)} AND ${state}
          )` : sql``}
          ORDER BY f.last_at DESC, f.id DESC LIMIT ${want}
        ), threads AS MATERIALIZED (
          SELECT w.id, w.last_at, w.single_count,
                 ARRAY(SELECT s.mailbox_id FROM mailbox_threads s
                       WHERE s.workspace_id=${value.workspaceId} AND s.thread_id=w.id ${scoped('s')} AND ${liveBox(sql`s.mailbox_id`)}
                       ORDER BY s.mailbox_id) AS address_ids
          FROM winners w
        ), page AS (
          SELECT threads.id, m.subject, m.snippet, m.from_name, m.from_address, ${preciseTime(sql`threads.last_at`)} AS at, threads.address_ids, ${countExpr} AS message_count, threads.last_at
          FROM threads ${latest(sql`mm.mailbox_id=ANY(threads.address_ids)`)}
          JOIN mail_messages m ON m.id=detail.latest_id
        ) SELECT page.id, page.subject, page.snippet, page.from_name, page.from_address, page.at, page.address_ids, page.message_count, meta.scanned, meta.found
          FROM (SELECT (SELECT count(*)::int FROM head) AS scanned, (SELECT count(*)::int FROM winners) AS found) meta
          LEFT JOIN page ON true ORDER BY page.last_at DESC NULLS LAST, page.id DESC`);
      const meta = res.rows[0]!;
      if (meta.found >= want || meta.scanned < batch) { rows = { rows: res.rows.filter(r => r.id !== null) }; break; }
    }
  }
  if (!rows) {
    // Single-thread lookup or full-text search: drive from mailbox_threads_workspace or mail_messages_search GIN.
    const state = view === 'trash' ? sql`${t.trashedAt} IS NOT NULL` : view && view !== 'all' ? sql`${t.trashedAt} IS NULL AND ${
      view === 'inbox' ? sql`NOT ${t.archived} AND NOT ${t.spam}` : view === 'archive' ? t.archived : view === 'spam' ? t.spam : t.starred}` : null;
    rows = await db.execute<PageRow>(sql`
      WITH threads AS MATERIALIZED (
        SELECT ${t.threadId} AS id, max(${t.lastMessageAt}) AS last_at, array_agg(${t.mailboxId} ORDER BY ${t.mailboxId}) AS address_ids, max(${t.messageCount}) AS single_count
        FROM ${t} WHERE ${liveBox(t.mailboxId)} AND ${and(eq(t.workspaceId,value.workspaceId),filter.threadId ? eq(t.threadId,filter.threadId) : undefined,
          filter.addressId ? eq(t.mailboxId,filter.addressId) : value.mailboxIds ? inArray(t.mailboxId,value.mailboxIds) : undefined)}
          ${options.q ? sql`AND ${t.threadId} IN (SELECT ${links.threadId} FROM ${links} JOIN ${messages} ON ${messages.id} = ${links.messageId} WHERE ${visibility} AND mail_messages.search @@ websearch_to_tsquery('simple', ${options.q}))` : sql``}
        GROUP BY ${t.threadId} HAVING true ${after ? sql`AND (max(${t.lastMessageAt}), ${t.threadId}) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
          ${state ? sql`AND bool_or(${state})` : sql``}
        ORDER BY last_at DESC, id DESC LIMIT ${options.limit + 1}
      ) SELECT threads.id, m.subject, m.snippet, m.from_name, m.from_address, ${preciseTime(sql`threads.last_at`)} AS at, threads.address_ids, ${countExpr} AS message_count
        FROM threads ${latest(sql`mm.mailbox_id=ANY(threads.address_ids)`)}
        JOIN mail_messages m ON m.id=detail.latest_id ORDER BY threads.last_at DESC, threads.id DESC`);
  }
  const last = rows.rows[options.limit - 1];
  return { data: rows.rows.slice(0, options.limit).map(row => ({ id: row.id, subject: row.subject, snippet: row.snippet, from: { name: row.from_name, address: row.from_address }, lastMessageAt: timestamp(row.at), addressIds: row.address_ids, messageCount: row.message_count })),
    nextCursor: rows.rows.length > options.limit && last ? encodeCursor(last.at, last.id) : null };
}

// Group *before* LIMIT: overlapping delivery links are one message, including at page boundaries.
function messageWindow(db: DbExecutor, value: MailboxAccess, filter: Filter, limit: number, cursor?: string) {
  const after = decodeCursor(cursor);
  return db.select({ id: links.messageId, at: links.receivedAt, read: sql<boolean>`bool_and(${links.read})`.as('is_read'), addressIds: sql<string[]>`array_agg(${links.mailboxId} ORDER BY ${links.mailboxId})`.as('address_ids') })
    .from(links).where(and(visibleLinks(value, filter), after ? sql`(${links.receivedAt}, ${links.messageId}) < (${after[0]}::timestamptz, ${after[1]})` : undefined))
    .groupBy(links.receivedAt, links.messageId).orderBy(desc(links.receivedAt), desc(links.messageId)).limit(limit).as('visible');
}
const metadataFields = { simulated:sql<boolean>`coalesce((${messages.verdicts}->>'simulated')::boolean,false)`, id: messages.id, threadId: messages.threadId, direction: messages.direction, status: messages.status, suppressionReason: messages.suppressionReason,
  subject: messages.subject, snippet: messages.snippet, receivedAt: messages.receivedAt, attachmentCount: messages.attachmentCount };
const messageFields = { ...metadataFields, errorCode: messages.errorCode, fromName: messages.fromName, fromAddress: messages.fromAddress,
  to: messages.to, cc: messages.cc, replyTo: messages.replyTo, text: messages.text, html: messages.html, bodyTruncated: messages.bodyTruncated,
  sendingEmailId: messages.sendingEmailId, messageId: messages.messageId, inReplyTo: messages.inReplyTo, references: messages.references };
type MessageCounts = { toCount?: number; ccCount?: number; replyToCount?: number; referencesCount?: number };
function publicVerdicts(verdicts: Verdicts): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(verdicts)) if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  return out;
}
function messageView(row: Pick<typeof messages.$inferSelect, Exclude<keyof typeof messageFields,'simulated'>> & {simulated?:boolean;verdicts?:Verdicts} & MessageCounts, addressIds: string[], read = true) {
  const text = row.text ?? (row.html ? htmlToPlain(row.html) : '');
  const toCount = Math.max(row.to.length, row.toCount ?? row.verdicts?.toCount ?? 0);
  const ccCount = Math.max(row.cc.length, row.ccCount ?? row.verdicts?.ccCount ?? 0);
  const replyToCount = Math.max(row.replyTo.length, row.replyToCount ?? row.verdicts?.replyToCount ?? 0);
  const referencesCount = Math.max(row.references.length, row.referencesCount ?? row.verdicts?.referencesCount ?? 0);
  return { simulated:row.simulated??row.verdicts?.simulated??false,id: row.id, threadId: row.threadId, addressIds, direction: row.direction, status: row.status, read, errorCode:row.errorCode, suppressionReason:row.suppressionReason,
    from: { name: row.fromName, address: row.fromAddress }, to: row.to, toCount, cc: row.cc, ccCount, replyTo: row.replyTo, replyToCount, subject: row.subject, snippet: row.snippet,
    text, replyText: replyText(text), receivedAt: timestamp(row.receivedAt), bodyTruncated: row.bodyTruncated, attachmentCount: row.attachmentCount,
    emailId: row.sendingEmailId, messageId: row.messageId, inReplyTo: row.inReplyTo, references: row.references, referencesCount };
}
type PageMsgRow = {
  simulated: boolean; id: string; thread_id: string; direction: 'inbound' | 'outbound'; status: string; suppression_reason: typeof messages.$inferSelect.suppressionReason;
  error_code: string | null; from_name: string | null; from_address: string;
  to: typeof messages.$inferSelect.to; cc: typeof messages.$inferSelect.cc; reply_to: typeof messages.$inferSelect.replyTo;
  to_count: number; cc_count: number; reply_to_count: number; references_count: number;
  subject: string; snippet: string; text: string | null; html: string | null; body_truncated: boolean; received_at: string; attachment_count: number;
  sending_email_id: string | null; message_id: string | null; in_reply_to: string | null; references: string[];
  address_ids: string[]; is_read: boolean; at: string; candidate_count: number;
};
async function messagePage(db: DbExecutor, value: MailboxAccess, filter: Filter, limit: number, cursor?: string) {
  const after = decodeCursor(cursor);
  // The dedicated message read returns the full stored body and up to 100 addresses. Bound each body and address list on timeline pages,
  // and stop the page once cumulative bytes hit PAGE_MAX_BYTES (always returning at least one message).
  const cap = 8192, addrCap = INBOUND_ADDRESS_PAGE_LIMIT;
  const { rows } = await db.execute<PageMsgRow>(sql`
    WITH visible AS (
      SELECT ${links.messageId} AS id, ${links.receivedAt} AS sort_at, bool_and(${links.read}) AS is_read,
        array_agg(${links.mailboxId} ORDER BY ${links.mailboxId}) AS address_ids
      FROM ${links}
      WHERE ${and(visibleLinks(value, filter), after ? sql`(${links.receivedAt}, ${links.messageId}) < (${after[0]}::timestamptz, ${after[1]})` : undefined)}
      GROUP BY ${links.receivedAt}, ${links.messageId}
      ORDER BY ${links.receivedAt} DESC, ${links.messageId} DESC
      LIMIT ${limit + 1}
    ), candidate AS (
      SELECT coalesce((m.verdicts->>'simulated')::boolean, false) AS simulated,
        m.id, m.thread_id, m.direction, m.status, m.suppression_reason, m.error_code, m.from_name, m.from_address,
        ${sliceJsonbArray(sql`m."to"`, addrCap)} AS "to", ${messageFieldCount(sql`m."to"`, sql`m.verdicts`, 'toCount')} AS to_count,
        ${sliceJsonbArray(sql`m.cc`, addrCap)} AS cc, ${messageFieldCount(sql`m.cc`, sql`m.verdicts`, 'ccCount')} AS cc_count,
        ${sliceJsonbArray(sql`m.reply_to`, addrCap)} AS reply_to, ${messageFieldCount(sql`m.reply_to`, sql`m.verdicts`, 'replyToCount')} AS reply_to_count,
        ${sliceJsonbArray(sql`m."references"`, addrCap)} AS "references", ${messageFieldCount(sql`m."references"`, sql`m.verdicts`, 'referencesCount')} AS references_count,
        m.subject, m.snippet,
        left(m.text, ${cap}) AS text,
        CASE WHEN m.text IS NULL THEN left(m.html, ${cap}) END AS html,
        (m.body_truncated OR coalesce(length(coalesce(m.text, m.html)) > ${cap}, false)) AS body_truncated,
        m.received_at::text AS received_at, m.attachment_count, m.sending_email_id, m.message_id, m.in_reply_to,
        w.address_ids, w.is_read, w.sort_at, ${preciseTime(sql`w.sort_at`)} AS at
      FROM visible w JOIN mail_messages m ON m.id = w.id
    ), sized AS (
      SELECT *,
        row_number() OVER (ORDER BY sort_at DESC, id DESC) AS rn,
        sum(
          coalesce(octet_length(text), 0) + coalesce(octet_length(html), 0) + octet_length("to"::text) + octet_length(cc::text) +
          octet_length(reply_to::text) + octet_length("references"::text) + octet_length(subject) + octet_length(snippet) + 512
        ) OVER (ORDER BY sort_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS cum_bytes
      FROM candidate
    )
    SELECT simulated, id, thread_id, direction, status, suppression_reason, error_code, from_name, from_address,
      "to", to_count, cc, cc_count, reply_to, reply_to_count, "references", references_count,
      subject, snippet, text, html, body_truncated, received_at, attachment_count, sending_email_id, message_id, in_reply_to,
      address_ids, is_read, at, (SELECT count(*)::int FROM candidate) AS candidate_count
    FROM sized WHERE rn = 1 OR cum_bytes <= ${PAGE_MAX_BYTES}
    ORDER BY rn`);
  const candidateCount = rows[0]?.candidate_count ?? 0;
  const pageRows = rows.slice(0, limit);
  const views = pageRows.map(r => ({
    at: r.at,
    id: r.id,
    view: messageView({
      simulated: r.simulated, id: r.id, threadId: r.thread_id, direction: r.direction, status: r.status, suppressionReason: r.suppression_reason,
      errorCode: r.error_code, fromName: r.from_name, fromAddress: r.from_address, to: r.to, cc: r.cc, replyTo: r.reply_to,
      toCount: r.to_count, ccCount: r.cc_count, replyToCount: r.reply_to_count, referencesCount: r.references_count,
      subject: r.subject, snippet: r.snippet, text: r.text, html: r.html, bodyTruncated: r.body_truncated, receivedAt: r.received_at,
      attachmentCount: r.attachment_count, sendingEmailId: r.sending_email_id, messageId: r.message_id, inReplyTo: r.in_reply_to, references: r.references,
    }, r.address_ids, r.is_read),
  }));
  const fitted = fitPageByBytes(views, candidateCount > pageRows.length, PAGE_MAX_BYTES, 1024);
  const last = fitted.items[fitted.items.length - 1];
  return {
    messages: fitted.items.map(item => item.view).reverse(),
    nextCursor: fitted.hasMore && last ? encodeCursor(last.at, last.id) : null,
  };
}

export async function signedUrl(runtime: Runtime,wid:string, kind:'raw'|'att', region: string, bucket: string, key: string, filename?: string,pendingArchive?:string,client?:S3Client,inbox?:string) {
  if(!isS3Bucket(bucket)){
    // Nightmail-signed links stream from the R2 binding; sandbox objects in local storage have none.
    if(bucket!==boundMailBucket(runtime))throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','The mail object was not found.');
    if(pendingArchive)await archiveMailboxFiles(runtime,wid,pendingArchive);
    return mailObjectUrl(runtime,wid,key,filename??'attachment',kind==='raw'?'message/rfc822':'application/octet-stream',inbox);
  }
  const [[{ GetObjectCommand }, { getSignedUrl }], s3] = await Promise.all([loadS3Presign(), client ? Promise.resolve(client) : mailboxS3(runtime,wid,region,bucket)]);
  try {
    if(pendingArchive)await archiveMailboxFiles(runtime,wid,pendingArchive,s3);
    key=await readableMailboxKey(runtime,wid,region,bucket,key,kind,runtime.db,s3);
    const disposition = filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined;
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: 300 }), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  } finally { if(!client)s3.destroy(); }
}
type AttachmentMetadata = Pick<typeof mailAttachments.$inferSelect, 'id' | 'filename' | 'contentType' | 'sizeBytes' | 'disposition' | 'contentId'>;
type DeliveryAttachment = AttachmentMetadata & Pick<typeof mailAttachments.$inferSelect, 'bucket' | 'storageKey' | 'sourceId'>;
// Read only the selected, visible message's attachments, in its snapshot and existing ID order.
const attachmentRows = (storage = sql``) => sql`coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id', ${mailAttachments.id}, 'filename', ${mailAttachments.filename}, 'contentType', ${mailAttachments.contentType},
    'sizeBytes', ${mailAttachments.sizeBytes}, 'disposition', ${mailAttachments.disposition}, 'contentId', ${mailAttachments.contentId}${storage}
  ) ORDER BY ${mailAttachments.id}) FROM ${mailAttachments} WHERE ${mailAttachments.messageId}=${messages.id}), '[]'::jsonb)`;
const attachmentView = (f: AttachmentMetadata) => ({id:f.id,filename:f.filename,contentType:f.contentType,size:f.sizeBytes,disposition:f.disposition,contentId:f.contentId});
type DeliveryMessage = Pick<typeof messages.$inferSelect, 'id' | 'workspaceId' | 'direction' | 'verdicts' | 'region' | 'rawBucket' | 'rawKey' | 'lifecycle' | 'createdAt' | 'receivedAt'>;
async function deliveryLinks(runtime: Runtime, row: DeliveryMessage, files: DeliveryAttachment[]) {
  const rawExpiresAt=row.rawKey&&row.lifecycle!=='kept'?new Date(Math.min(Date.parse(row.createdAt),Date.parse(row.receivedAt))+90*86400000).toISOString():null;
  const bucket = row.rawBucket ?? files[0]?.bucket, region = row.region;
  if (files.some(f => f.bucket !== bucket)) throw new ApiError(404, 'MAILBOX_OBJECT_NOT_FOUND', 'Message objects must use the same workspace storage connection.');
  // Only outbound copies have no SES receiving scan by design.
  if (!region || !bucket || (row.verdicts.virus ?? (row.direction==='outbound'?'PASS':null))!=='PASS') return { rawUrl: null,rawExpiresAt, urls: files.map(() => null) };
  const client = isS3Bucket(bucket) ? await mailboxS3(runtime, row.workspaceId, region, bucket) : undefined;
  try {
    if (files.some(f => f.sourceId)) await archiveMailboxFiles(runtime, row.workspaceId, row.id, client);
    const link = async (kind:'att'|'raw', key:string, filename:string) => (await signedUrl(runtime, row.workspaceId, kind, region, bucket, key, filename, undefined, client)).url;
    return {rawExpiresAt, rawUrl: row.rawKey && (!rawExpiresAt || Date.parse(rawExpiresAt)>Date.now()) ? await link('raw', row.rawKey, `${row.id}.eml`) : null, urls: await Promise.all(files.map(f => link('att', f.storageKey, f.filename))) };
  } finally { client?.destroy(); }
}

// The conversation and message lists page one workspace's mail, polled by open inbox views: each statement stops after
// 3 seconds with READ_TOO_LARGE (a rare search over a large workspace) rather than hold a connection.
const INBOUND_READ = 3;
export function registerInboundThreadReads(app: App, access: (c: Ctx, permission: 'read') => MailboxAccess) {
  app.openapi(createRoute({ method: 'get', path: base, operationId: 'listInboundThreads', tags, security, summary: 'List visible conversations',
    description: 'Newest visible activity first, then descending thread ID. addressId narrows all projected messages and IDs. q searches visible messages; view matches state on any visible address. all (default) includes trash. Pass nextCursor to continue. ' + readLimitNote(INBOUND_READ),
    request: { query: ListQuery }, responses: { 200: response(page(Thread).openapi('InboundThreadPage')), ...errors } }), async c => {
    const q = c.req.valid('query'), value = access(c, 'read'); return c.json(await budgetedRead(c.env.db, db => threadPage(db, value, q, q), readLimit(INBOUND_READ)), 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/{threadId}`, operationId: 'getInboundThread', tags, security, summary: 'Read a visible conversation',
    description: 'Returns the most recent visible messages (default 25, maximum 100), oldest first within the page. Ties use message ID. Pages are also bounded by response size and may return fewer than limit messages; pass nextCursor as cursor for the older page. Body previews are capped at 8192 characters and address/reference lists at 20 items (with total counts in toCount, ccCount, replyToCount and referencesCount); getInboundMessage retrieves stored text, up to 100 addresses and attachment metadata. State and counts are scoped to visible addresses. ' + readLimitNote(INBOUND_READ),
    request: { params: ThreadParams, query: PageQuery }, responses: { 200: response(Thread.extend({ messages: z.array(Message), addressStates:z.array(AddressState), nextCursor: z.string().nullable() }).openapi('InboundThreadDetail')), ...errors } }), async c => {
    const value = access(c, 'read'), q = c.req.valid('query'), filter = { threadId: c.req.valid('param').threadId, addressId: q.addressId };
    return await withBoundedRead(c, async () => {
      let result;
      try {
        result = await c.env.db.transaction(async db => {
          await db.execute(sql.raw(`SET LOCAL statement_timeout = '${INBOUND_READ}s'`));
          const [thread] = (await threadPage(db, value, filter, { limit: 1 })).data;
          if (!thread) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found.');
          const t=mailboxThreads;
          const addressStates=await db.select({addressId:t.mailboxId, unreadCount:unreadOf(value,filter.threadId), archived:t.archived,starred:t.starred,trashed:sql<boolean>`${t.trashedAt} IS NOT NULL`,spam:t.spam,labels:t.labels}).from(t).where(visibleThreadAddresses(value,filter.threadId,filter.addressId)).orderBy(asc(t.mailboxId));
          return { ...thread, ...await messagePage(db, value, filter, q.limit, q.cursor), addressStates };
        }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
      } catch (error) {
        if (statementTimedOut(error)) throw readLimit(INBOUND_READ).refusal();
        throw error;
      }
      return c.json(result, 200);
    }, { route: 'inbound.getThread', workspaceId: value.workspaceId }) as never;
  });
  const addressLinks = (v: MailboxAccess, f: Filter) => sql<string[]>`ARRAY(SELECT ${links.mailboxId} FROM ${links} WHERE ${visibleLinks(v, f)} AND mailbox_messages.message_id=mail_messages.id ORDER BY ${links.mailboxId})`;
  const accessible = accessibleMessages;
  // Received Logs can inspect the entire workspace, including SMTP envelopes and unassigned mail.
  // Never grant this projection to an address key, even a key that can read every address.
  const includeDelivery = z.enum(['true','false']).optional().describe('Include delivery details for workspace logs (owner or admin sessions, and API keys with manage permission on all domains, only).');
  function messageScope(c: Ctx, delivery?: string) {
    const v=access(c,'read');
    if (delivery!=='true') return v;
    // A dashboard member reads only addressed mail, like a non-admin key (L1).
    if (!readsDelivery(c.get('actor'),v)) throw denied('ADMIN_REQUIRED','Delivery details require a workspace owner or admin session, or an API key with manage permission on all domains that wasn’t created over MCP.',{ permission: 'receivedMail', level: 'read', scope: 'allAddresses', credential: 'notDelegated', ...(c.get('actor')?.role === 'member' ? { person: 'admin' } : {}) });
    return {...v,admin:true};
  }
  // The sender's SPF, DKIM and DMARC results and the automated-mail flag describe the message itself, not the workspace's
  // delivery, so any reader of the message gets them; an inbox key uses them to decide whether, and how, to answer.
  const includeAuthentication = z.enum(['true','false']).default('false').describe('Include the sender authentication results (SPF, DKIM, DMARC) and whether the message is automated (auto-replies, bounces, bulk and list mail). Available to any reader of the message.');
  const includeThread = z.enum(['true','false']).default('false').describe('Include the conversation it belongs to (thread): up to 50 messages around it that you can read, oldest first, and their count. A key limited to addresses or an inbox reads only the messages on its addresses.');
  const Authentication = z.object({spf:z.string().nullable(),dkim:z.string().nullable(),dmarc:z.string().nullable().describe('PASS when the From domain is aligned with a passing SPF or DKIM result.')}).openapi('InboundMessageAuthentication');
  const authenticationView = (row:{verdicts:Verdicts|null;automated:boolean}) => ({authentication:{spf:row.verdicts?.spf??null,dkim:row.verdicts?.dkim??null,dmarc:row.verdicts?.dmarc??null},automated:row.automated});
  const deliverySchema = z.object({addresses:z.array(z.object({id:Id,address:z.string()})),envelopeTo:z.array(z.string()).describe('SMTP envelope recipients (at most 20 on list pages, up to 100 on getInboundMessage).'),envelopeToCount:z.number().int().describe('Total SMTP envelope recipients (may exceed envelopeTo.length when shortened).'),region:z.string().nullable(),spam:z.boolean(),to:z.array(Address).describe('Addresses in the To header (at most 20 on list pages).'),toCount:z.number().int().describe('Total addresses in the To header (may exceed to.length when shortened).')});
  const deliveryAddresses = visibleAddresses;
  const MessageListItem = Message.pick({ id:true, threadId:true, addressIds:true, direction:true, status:true, suppressionReason:true, subject:true, snippet:true, receivedAt:true, attachmentCount:true, from:true }).extend(deliverySchema.partial().shape);
  app.openapi(createRoute({ method:'get', path:'/v1/inbound/messages', operationId:'listInboundMessages', tags, security, summary:'Search received and sent messages', description:'Newest first; default inbound. Unassigned stored mail is visible only to a workspace administrator without an address filter. Pages are also bounded by response size and may return fewer than limit messages; pass nextCursor as cursor to continue. With includeDelivery=true, to and envelopeTo return at most 20 items with total counts in toCount and envelopeToCount. '+readLimitNote(INBOUND_READ),
    request:{query:PageQuery.extend({ includeDelivery,region:z.string().max(40).optional(),threadId:Id.optional(),direction:z.enum(['inbound','outbound']).default('inbound'),q:z.string().trim().min(1).max(200).optional() })},responses:{200:response(page(MessageListItem).openapi('InboundMessagePage')),...errors} }), async c=>{
    const q=c.req.valid('query'),v=messageScope(c,q.includeDelivery),after=decodeCursor(q.cursor);
    const withDel = q.includeDelivery === 'true', addrCap = INBOUND_ADDRESS_PAGE_LIMIT;
    type ListMsgRow = {
      simulated: boolean; id: string; thread_id: string; direction: 'inbound' | 'outbound'; status: string; suppression_reason: typeof messages.$inferSelect.suppressionReason;
      subject: string; snippet: string; attachment_count: number; from_address: string; from_name: string | null; address_ids: string[]; at: string;
      region?: string | null; spam?: boolean; to?: typeof messages.$inferSelect.to; to_count?: number; envelope_to?: string[]; envelope_to_count?: number;
      addresses?: { id: string; address: string }[]; candidate_count: number;
    };
    return await withBoundedRead(c, async () => {
      const where = and(accessible(v,q,'perMessage'),eq(messages.direction,q.direction),q.region?eq(messages.region,q.region):undefined,q.threadId?eq(messages.threadId,q.threadId):undefined,
        q.q?sql`mail_messages.search @@ websearch_to_tsquery('simple',${q.q})`:undefined,after?sql`(${messages.receivedAt}, ${messages.id}) < (${after[0]}::timestamptz,${after[1]})`:undefined);
      const rows = await budgetedRead(c.env.db, async db => (await db.execute<ListMsgRow>(sql`
        WITH candidate AS (
          SELECT coalesce((${messages.verdicts}->>'simulated')::boolean, false) AS simulated,
            ${messages.id} AS id, ${messages.threadId} AS thread_id, ${messages.direction} AS direction, ${messages.status} AS status,
            ${messages.suppressionReason} AS suppression_reason, ${messages.subject} AS subject, ${messages.snippet} AS snippet,
            ${messages.receivedAt} AS sort_at, ${preciseTime(messages.receivedAt)} AS at, ${messages.attachmentCount} AS attachment_count,
            ${messages.fromAddress} AS from_address, ${messages.fromName} AS from_name, ${addressLinks(v, q)} AS address_ids
            ${withDel ? sql`, ${messages.region} AS region, ${messages.spam} AS spam,
              ${sliceJsonbArray(messages.to, addrCap)} AS "to", ${messageFieldCount(messages.to, messages.verdicts, 'toCount')} AS to_count,
              ${sliceJsonbArray(messages.envelopeTo, addrCap)} AS envelope_to, jsonb_array_length(${messages.envelopeTo})::int AS envelope_to_count,
              ${deliveryAddresses(v, q)} AS addresses` : sql``}
          FROM ${messages}
          WHERE ${where}
          ORDER BY ${messages.receivedAt} DESC, ${messages.id} DESC
          LIMIT ${q.limit + 1}
        ), sized AS (
          SELECT *,
            row_number() OVER (ORDER BY sort_at DESC, id DESC) AS rn,
            sum(
              octet_length(subject) + octet_length(snippet) + octet_length(from_address) + coalesce(octet_length(from_name), 0) +
              ${withDel ? sql`octet_length("to"::text) + octet_length(envelope_to::text) + octet_length(addresses::text) +` : sql``} 384
            ) OVER (ORDER BY sort_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS cum_bytes
          FROM candidate
        )
        SELECT simulated, id, thread_id, direction, status, suppression_reason, subject, snippet, at, attachment_count, from_address, from_name, address_ids
          ${withDel ? sql`, region, spam, "to", to_count, envelope_to, envelope_to_count, addresses` : sql``}
          , (SELECT count(*)::int FROM candidate) AS candidate_count
        FROM sized WHERE rn = 1 OR cum_bytes <= ${PAGE_MAX_BYTES}
        ORDER BY rn`)).rows, readLimit(INBOUND_READ));
      const candidateCount = rows[0]?.candidate_count ?? 0;
      const mapped = rows.slice(0, q.limit).map(r => ({
        at: r.at,
        item: {
          simulated: r.simulated, id: r.id, threadId: r.thread_id, direction: r.direction, status: r.status, suppressionReason: r.suppression_reason,
          subject: r.subject, snippet: r.snippet, receivedAt: timestamp(r.at), attachmentCount: r.attachment_count,
          from: { name: r.from_name, address: r.from_address }, addressIds: r.address_ids,
          ...(withDel ? { region: r.region ?? null, spam: r.spam ?? false, to: r.to ?? [], toCount: r.to_count ?? 0, envelopeTo: r.envelope_to ?? [], envelopeToCount: r.envelope_to_count ?? 0, addresses: r.addresses ?? [] } : {}),
        },
      }));
      const fitted = fitPageByBytes(mapped, candidateCount > mapped.length, PAGE_MAX_BYTES, 256);
      const last = fitted.items[fitted.items.length - 1];
      return c.json({ data: fitted.items.map(x => x.item), nextCursor: fitted.hasMore && last ? encodeCursor(last.at, last.item.id) : null }, 200);
    }, { route: 'inbound.listMessages', workspaceId: v.workspaceId }) as never;
  });
  const Attachment = z.object({id:Id,filename:z.string(),contentType:z.string(),size:z.number().int(),disposition:z.string(),contentId:z.string().nullable(),url:z.string().nullable().optional()});
  const DeliveryDetail = deliverySchema.omit({to:true,toCount:true}).extend({rawUrl:z.string().nullable(),rawExpiresAt:z.string().nullable(),sentAt:z.string().nullable(),sizeBytes:z.number().int().nullable(),headers:z.array(z.object({name:z.string(),value:z.string()})),verdicts:z.record(z.string(),z.union([z.string(),z.boolean()]))}).partial();
  app.openapi(createRoute({ method: 'get', path: '/v1/inbound/messages/{messageId}', operationId: 'getInboundMessage', tags, security, summary: 'Read a visible message',
    description: 'Returns stored text, attachment metadata, and up to 100 stored addresses per field with exact header counts in toCount, ccCount, replyToCount and referencesCount. ' + readLimitNote(INBOUND_READ),
    request: { params: z.object({ messageId: Id }), query: AddressFilter.extend({includeDelivery,includeAuthentication,includeHtml:z.enum(['true','false']).default('false'),includeThread}) }, responses: { 200: response(Message.extend({...DeliveryDetail.shape,thread:EmailThread.nullable().optional().describe('With includeThread=true: its conversation, as getEmailDetail shows it.'),authentication:Authentication.optional().describe('With includeAuthentication=true.'),automated:z.boolean().optional().describe('With includeAuthentication=true: an auto-reply, bounce, delivery report, or bulk or list mail. Never answer it automatically.'),html:z.string().nullable(),htmlTooComplex:z.boolean().describe(`With includeHtml=true: the HTML has more elements or deeper nesting than ${productName} parses (20,000 nodes, 256 levels deep). It is returned as stored; prefer text to rendering it.`),attachments:z.array(Attachment)}).openapi('InboundMessageDetail')), ...errors } }), async c => {
    const q=c.req.valid('query'),v=messageScope(c,q.includeDelivery),id=c.req.valid('param').messageId;
    // The same bounded parse every other reader of stored HTML uses; the body itself is returned as stored.
    const body=(html:string|null)=>q.includeHtml==='true'&&html?{html,htmlTooComplex:!boundedHtmlFragment(html,'document')}:{html:null,htmlTooComplex:false};
    const auth=(row:{verdicts:Verdicts|null;automated:boolean})=>q.includeAuthentication==='true'?authenticationView(row):{};
    // Its conversation, in the same statement. The emails that joined it by replying are ordinary sends: a workspace
    // credential reads them, an address or inbox key doesn't.
    const a=c.get('actor') as Actor|undefined;
    const thread=q.includeThread==='true'?threadBlock(v,{thread:sql`mail_messages.thread_id`,focus:sql`mail_messages.id`,addressId:q.addressId,sends:!!a&&!!actorMailAccess(a)&&!q.addressId}):sql<RawThread|null>`NULL`;
    const conversation=(raw:RawThread|null)=>q.includeThread==='true'?{thread:threadView(raw,!!a?.permissions.includes('manage'))}:{};
    const storeCap = INBOUND_ADDRESS_STORE_LIMIT;
    const detailFields = {
      ...metadataFields, errorCode: messages.errorCode, fromName: messages.fromName, fromAddress: messages.fromAddress,
      to: sql<typeof messages.$inferSelect.to>`${sliceJsonbArray(messages.to, storeCap)}`, toCount: messageFieldCount(messages.to, messages.verdicts, 'toCount'),
      cc: sql<typeof messages.$inferSelect.cc>`${sliceJsonbArray(messages.cc, storeCap)}`, ccCount: messageFieldCount(messages.cc, messages.verdicts, 'ccCount'),
      replyTo: sql<typeof messages.$inferSelect.replyTo>`${sliceJsonbArray(messages.replyTo, storeCap)}`, replyToCount: messageFieldCount(messages.replyTo, messages.verdicts, 'replyToCount'),
      references: sql<string[]>`${sliceJsonbArray(messages.references, storeCap)}`, referencesCount: messageFieldCount(messages.references, messages.verdicts, 'referencesCount'),
      text: messages.text,
      html: q.includeHtml === 'true' ? messages.html : sql<string | null>`CASE WHEN ${messages.text} IS NULL THEN ${messages.html} END`,
      bodyTruncated: messages.bodyTruncated, sendingEmailId: messages.sendingEmailId, messageId: messages.messageId, inReplyTo: messages.inReplyTo,
    };
    return await withBoundedRead(c, async () => {
      if (q.includeDelivery==='true') {
        const result = await budgetedRead(c.env.db, async db => {
          const [result]=await db.select({
            ...detailFields, workspaceId: messages.workspaceId, region: messages.region, spam: messages.spam, automated: messages.automated,
            headers: messages.headers, verdicts: messages.verdicts, sentAt: messages.sentAt, sizeBytes: messages.sizeBytes,
            rawBucket: messages.rawBucket, rawKey: messages.rawKey, lifecycle: messages.lifecycle, createdAt: messages.createdAt,
            envelopeTo: sql<string[]>`${sliceJsonbArray(messages.envelopeTo, storeCap)}`, envelopeToCount: sql<number>`jsonb_array_length(${messages.envelopeTo})::int`,
            thread, addresses: deliveryAddresses(v,q), addressIds: addressLinks(v,q),
            files: sql<DeliveryAttachment[]>`${attachmentRows(sql`, 'bucket', ${mailAttachments.bucket}, 'storageKey', ${mailAttachments.storageKey}, 'sourceId', ${mailAttachments.sourceId}`)}`,
            isRead: sql<boolean>`coalesce((SELECT bool_and(${links.read}) FROM ${links} WHERE ${visibleLinks(v,q)} AND mailbox_messages.message_id=mail_messages.id),false)`,
          }).from(messages).where(and(eq(messages.id,id),accessible(v,q)));
          if (!result) throw new ApiError(404,'NOT_FOUND','Message was not found.');
          return result;
        }, readLimit(INBOUND_READ));
        const {rawUrl,rawExpiresAt,urls}=await deliveryLinks(c.env,result,result.files);
        return c.json({...messageView(result,result.addressIds,result.isRead),addresses:result.addresses,envelopeTo:result.envelopeTo,envelopeToCount:result.envelopeToCount,region:result.region,spam:result.spam,headers:result.headers,verdicts:publicVerdicts(result.verdicts),sentAt:result.sentAt?timestamp(result.sentAt):null,sizeBytes:result.sizeBytes,rawUrl,...body(result.html),...auth(result),...conversation(result.thread),
          rawExpiresAt,attachments:result.files.map((f,i)=>({...attachmentView(f),url:urls[i]!}))},200);
      }
      const row = await budgetedRead(c.env.db, async db => {
        const [row] = await db.select({...detailFields,thread,verdicts:messages.verdicts,automated:messages.automated,addressIds:addressLinks(v,q),isRead:sql<boolean>`coalesce((SELECT bool_and(${links.read}) FROM ${links} WHERE ${visibleLinks(v,q)} AND mailbox_messages.message_id=mail_messages.id),false)`,files:sql<AttachmentMetadata[]>`${attachmentRows()}`}).from(messages).where(and(eq(messages.id,id),accessible(v,q)));
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Message was not found.');
        return row;
      }, readLimit(INBOUND_READ));
      return c.json({...messageView(row,row.addressIds,row.isRead),...body(row.html),...auth(row),...conversation(row.thread),attachments:row.files.map(attachmentView)},200);
    }, { route: 'inbound.getMessage', workspaceId: v.workspaceId }) as never;
  });
  // rawUrl in webhook payloads is the delivery record (it names every recipient): only delivery-detail readers follow it.
  app.get('/v1/inbound/messages/:messageId/raw',async c=>{
    const v=messageScope(c,'true'),mid=c.req.param('messageId');const [m]=await c.env.db.select({region:messages.region,bucket:messages.rawBucket,key:messages.rawKey}).from(messages).where(and(accessible(v,{}),eq(messages.id,mid),sql`${messages.verdicts}->>'virus'='PASS' AND (${messages.lifecycle}='kept' OR least(${messages.createdAt},${messages.receivedAt})>now()-interval '90 days')`));
    if(!m?.region||!m.bucket||!m.key)throw new ApiError(404,'NOT_FOUND','Raw message not found.');return c.redirect((await signedUrl(c.env,v.workspaceId,'raw',m.region,m.bucket,m.key,mid+'.eml')).url,307);
  });
  // Attachments follow their message: any credential that may read the message opens its files, through either route.
  const AttachmentParams=z.object({messageId:Id,attachmentId:Id}), AttachmentDownload=z.object({url:z.string(),expiresAt:z.string()}).openapi('InboundAttachmentDownload');
  async function attachmentLink(c:Ctx,p:z.infer<typeof AttachmentParams>,q:z.infer<typeof AddressFilter>) {
    const v=access(c,'read');
    const [file]=await c.env.db.select({region:messages.region,bucket:mailAttachments.bucket,key:mailAttachments.storageKey,filename:mailAttachments.filename,sourceId:mailAttachments.sourceId}).from(messages).innerJoin(mailAttachments,eq(mailAttachments.messageId,messages.id)).where(and(eq(messages.id,p.messageId),eq(mailAttachments.id,p.attachmentId),sql`coalesce(${messages.verdicts}->>'virus',CASE WHEN ${messages.direction}='outbound' THEN 'PASS' END)='PASS'`,accessible(v,q)));
    if (!file?.region) throw new ApiError(404,'NOT_FOUND','Attachment was not found.');
    return signedUrl(c.env,v.workspaceId,'att',file.region,file.bucket,file.key,file.filename,file.sourceId?p.messageId:undefined);
  }
  app.openapi(createRoute({method:'get',path:'/v1/inbound/messages/{messageId}/attachments/{attachmentId}',operationId:'getInboundAttachment',tags,security,summary:'Download an attachment from a visible message',
    request:{params:AttachmentParams,query:AddressFilter},responses:{200:response(AttachmentDownload),...errors}}),async c=>c.json(await attachmentLink(c,c.req.valid('param'),c.req.valid('query')),200));
  // The persistent link in webhook payloads (downloadUrl, or url in a message's attachments).
  app.openapi(createRoute({method:'get',path:'/v1/inbound/messages/{messageId}/parts/{attachmentId}',operationId:'downloadInboundAttachment',tags,security,summary:'Follow an attachment link from a webhook',
    description:'The downloadUrl (inbound format) or url (message attachments) in webhook payloads. Answers 307 to a download link that works for five minutes, also returned as url in the body. Any credential that can read the message can follow it, exactly as with getInboundAttachment: an inbound key for the address it reached, a member, an agent token.',
    request:{params:AttachmentParams,query:AddressFilter},responses:{307:{description:'Follow Location within five minutes.',headers:z.object({Location:z.string()}),content:{'application/json':{schema:AttachmentDownload}}},...errors}}),async c=>{
    const link=await attachmentLink(c,c.req.valid('param'),c.req.valid('query'));
    c.header('Location',link.url);
    return c.json(link,307);
  });
}

export function createInboundThreadRoute<T extends z.ZodType>(input: T) {
  return createRoute({ method: 'post', path: base, operationId: 'createInboundThread', tags, security, summary: 'Start a conversation from an inbound address',
    request: { headers: SendIdempotencyHeaders, body: json(input) }, responses: { 202: response(Message, 'Queued, not yet delivered.'), ...errors } });
}
export function replyToInboundThreadRoute<T extends z.ZodType>(input: T) {
  return createRoute({ method: 'post', path: `${base}/{threadId}/reply`, operationId: 'replyToInboundThread', tags, security, summary: 'Reply in a visible conversation',
    description: 'Replies to the newest visible message in either direction, breaking time ties by descending message ID. addressId restricts the target and sending address; provide it when the target is linked to more than one visible address. Set replyToMessageId to select an older visible message in this thread. For reviewed replies, pin both IDs and expectedRecipients. A recipient mismatch or a pending outbound parent without a provider Message-ID returns 409.',
    request: { params: ThreadParams, headers: SendIdempotencyHeaders, body: json(input) }, responses: { 202: response(Message, 'Queued, not yet delivered.'), ...errors } });
}
export async function inboundReplyTarget(db: DbExecutor, value: MailboxAccess, filter: Filter & { threadId: string }) {
  const w = messageWindow(db, value, filter, 1);
  const [parent] = await db.select({ row: messages, addressIds: w.addressIds }).from(w).innerJoin(messages, eq(messages.id, w.id));
  if (!parent) throw new ApiError(404, 'NOT_FOUND', 'There is no visible reply target in this conversation.');
  if (parent.addressIds.length !== 1) throw new ApiError(409, 'ADDRESS_REQUIRED', 'This message is linked to multiple addresses. Choose the sending address with addressId.', 'addressId');
  return { original: parent.row, addressId: parent.addressIds[0]! };
}

type Recipients = Pick<OutgoingMessage, 'to' | 'cc' | 'bcc'>;
export function assertInboundRecipients(expected: Recipients, resolved: Recipients) {
  const normalized = (list: string[]) => new Set(list.map(address => address.trim().toLowerCase()));
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const reviewed = normalized(expected[field]), actual = normalized(resolved[field]);
    if (reviewed.size !== actual.size || [...actual].some(address => !reviewed.has(address))) {
      throw new ApiError(409, 'INBOUND_RECIPIENTS_CHANGED', 'The reply recipients differ from those reviewed. Review To, Cc and Bcc before sending.', 'expectedRecipients');
    }
  }
}

export async function wakeMailboxSend(c: Ctx, actor: Actor, runnable: number) {
  for (const [region, { count, priority }] of actor.dispatchTargets ?? []) { try { await c.env.dispatch?.(region, actor.dispatchAccount?.aws_account_id, count, actor.dispatchAccount?.kind, priority); } catch { /* The dispatcher polls queued mail. */ } }
  actor.dispatchTargets?.clear();
  if (runnable) try { await c.env.wake?.(runnable,'webhook'); } catch { /* durable */ }
}
export async function queueInboundThreadMessage(c: Ctx, actor: Actor, prepare: (db: DbExecutor) => Promise<Omit<OutgoingMessage, 'actor'>>) {
  let runnable = 0,fileSent=false,prepared:Omit<OutgoingMessage,'actor'>|undefined;
  const body=await c.req.json<{attachments?:unknown[]}>();
  // Never resolve the parent, recipients, or attachments on replay. The path already binds the thread.
  const result = await idempotent(c.env.db, { ...idempotentRequest(c), workspaceId: actor.workspaceId, actorKeyId: actor.keyId }, body, async db => {
    const outgoing = prepared ?? await prepare(db);
    fileSent=outgoing.mailbox.kind==='inbox';
    const queued = await sendFromMailbox(c.env, db, { ...outgoing, actor });
    runnable = queued.runnable;
    return messageView(queued.message, [outgoing.mailbox.id]);
  },{prepare:body.attachments?.length ? async()=>{prepared=await prepare(c.env.db);} : undefined});
  if(fileSent||result.attachmentCount) await finishMailboxArchive(c.env,actor.workspaceId,result.id);
  await wakeMailboxSend(c, actor, runnable);
  return result;
}
