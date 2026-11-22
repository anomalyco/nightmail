import { createRoute, z } from '@hono/zod-openapi';
import { and, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actor, ApiError, budgetedRead, denied, errors, PageQuery, readLimit, readLimitNote, statementTimedOut, unrestrictedRequired, region, response, security, type Actor, type App, type DbExecutor, type MailboxAccess } from './core.js';
import { emails } from './db/sending.js';
import { mailMessages as messages } from './db/mailbox.js';
import { readsDelivery, visibleAddresses } from './inbound-threads.js';
import { accessibleMessages, sentThreadId, threadSize } from './thread-view.js';
import { EmailStatusFilter, listedSubject, mailWhere, pageBinding, sentSearch, sentUntrustedContent, SubstringSearch } from './sending.js';

// Logs: sent and received mail in one list, newest first, from one SQL statement. Each side keeps its own index
// (sending_emails_created_page, mail_messages_tenant_page) and limit; the outer query merges the two pages. The cursor
// carries the direction, so equal timestamps across the two tables still page exactly once: at one instant sent rows
// come before received rows.
//
// Each row names its conversation (thread-view.ts): received mail its thread, sent mail its mailbox copy's or the one it
// joined by replying, and how many of its messages the caller reads, counted once per thread on the page after the
// merge. Only for credentials that read received mail, and only where they read one of its stored messages.
//
// Received mail follows listInboundMessages: manage credentials read every retained message, including unrouted mail;
// dashboard members read mail on live addresses; credentials that can't read inbound mail (domain-restricted or
// read-only keys) get sent mail only. Delivery details (envelope recipients, region, spam) follow readsDelivery: owner
// and admin dashboard sessions and manage API keys, never MCP grants or agent tokens.

const Address = z.object({ name: z.string().nullable(), address: z.string() });
const LogEntry = z.object({
  id: z.string().describe('Email ID for sent mail (getEmail); message ID for received mail (getInboundMessage).'),
  direction: z.enum(['sent', 'received']),
  untrustedContent: z.boolean().describe('Received mail and sent mailbox replies can contain external sender content.'),
  at: z.string().describe('When the email was created (sent) or received.'),
  status: z.string().describe('Sent: the email status, or scheduled for a send waiting for its time (getEmail reads it as queued with scheduled true). Received: received, or spam when flagged (spam is shown to administrators only).'),
  from: Address,
  to: z.array(z.string()).describe('Sent: the To recipients. Received: the addresses in the To header.'),
  subject: z.string(),
  stream: z.enum(['transactional', 'marketing']).nullable().describe('Sent mail only.'),
  campaignId: z.string().nullable(),
  scheduledAt: z.string().nullable().describe('Sent mail that is scheduled: when it goes (UTC). Null for received mail.'),
  simulated: z.boolean().describe('Sent through the SES mailbox simulator. Always false for received mail.'),
  attachmentCount: z.number().int().nullable().describe('Received mail only.'),
  threadId: z.string().nullable().describe('The conversation (getInboundThread): every received email\'s, and a sent email\'s when it is a reply from a receiving address or inbox, or its In-Reply-To named a stored message its sender could read. Null when the caller can read none of the conversation\'s received or stored messages, and for credentials that cannot read received mail.'),
  threadCount: z.number().int().nullable().describe('Messages in that conversation the caller can read, this one included; null without threadId.'),
  addresses: z.array(z.object({ id: z.string(), address: z.string() })).nullable().describe('Received mail only: the receiving addresses it was delivered to that the caller can read. Empty for unrouted mail.'),
  region: z.string().nullable().describe('Null for received mail unless the caller is an administrator.'),
  envelopeTo: z.array(z.string()).nullable().describe('Received mail, administrators only: the SMTP envelope recipients.'),
}).openapi('LogEntry');
// counts=true: how many emails match each filter value, the way a list's facets count, over the same dates as the list
// (from and to). They are exact: the dates bound what they read, so a narrower range costs less.
// Each statement of a Logs read stops after 5 seconds, and the counts after 2 of their own: READ_TOO_LARGE.
const LOGS_READ = 5, COUNTS_READ = 2;
const LogCounts = z.object({
  status: z.record(z.string(), z.number().int()).describe('Emails per status (sent statuses, received and spam) between from and to, with every filter but status. A status with none is left out.'),
  kind: z.object({ transactional: z.number().int(), marketing: z.number().int() }).describe('Sent emails per kind between from and to, with every filter but kind.'),
  capped: z.object({ sent: z.boolean(), received: z.boolean() }).describe('Always false: the counts are exact. Kept for compatibility from when each direction counted at most its 50,000 newest emails.'),
}).openapi('LogCounts');
const LogPage = z.object({
  data: z.array(LogEntry), nextCursor: z.string().nullable(),
  received: z.boolean().describe('Whether received mail is included: false for direction=sent, with a sent-only filter, or when the credential cannot read inbound mail.'),
  counts: LogCounts.optional().describe('With counts=true only.'),
}).openapi('LogPage');
// received and spam filter received mail; every other status filters sent mail.
const receivedStatuses = ['received', 'spam'] as const;
const LogStatus = z.enum([...EmailStatusFilter.options, ...receivedStatuses]);
const receivedStatus = (status: string | undefined): status is (typeof receivedStatuses)[number] => (receivedStatuses as readonly string[]).includes(status ?? '');
const LogQuery = PageQuery.extend({
  direction: z.enum(['all', 'sent', 'received']).default('all'),
  search: SubstringSearch.optional().describe('At least 3 characters: a shorter term is refused with 422 VALIDATION_FAILED. Sent mail: a literal, case-insensitive substring of the sender, recipients, subject or IDs; a campaign email matches only its exact recipient address (any case) or its email ID, and campaignId lists a campaign\'s emails. Received mail: a full-text match on sender, recipients, subject and body.'),
  status: LogStatus.optional().describe('A sent-mail status lists sent mail only. received lists received mail that is not flagged as spam; spam lists received mail flagged as spam (spam is visible to administrators only, so dashboard members get none). Either leaves sent mail out, and is refused (403) to credentials that cannot read received mail, like direction=received.'),
  kind: z.enum(['transactional', 'marketing']).optional().describe('Sent mail only; received mail is left out when set.'),
  campaignId: z.string().max(120).optional().describe('Sent mail only; received mail is left out when set.'),
  region: z.string().min(1).max(40).optional(),
  from: z.string().datetime({ offset: true }).optional().describe('Mail created (sent) or received at or after this instant.'),
  to: z.string().datetime({ offset: true }).optional().describe('Mail created (sent) or received before this instant.'),
  counts: z.enum(['true', 'false']).optional().describe(`true adds counts: how many emails match each status and kind for these filters between from and to (all retained mail without them), whatever the cursor and limit. Counts that take longer than ${COUNTS_READ} seconds are refused with 422 READ_TOO_LARGE: narrow from and to.`),
}).refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'from must precede to.')
  .refine(q => q.direction !== 'received' || !((q.status && !receivedStatus(q.status)) || q.kind || q.campaignId), 'A sent-mail status, kind and campaignId filter sent mail and cannot be used with direction=received.')
  .refine(q => !receivedStatus(q.status) || (q.direction !== 'sent' && !q.kind && !q.campaignId), 'status=received and status=spam filter received mail and cannot be used with direction=sent, kind or campaignId.')
  .openapi('ListLogsQuery');

// Postgres keeps microseconds; the cursor keeps them too so a page boundary never skips a row.
const precise = (column: AnyPgColumn) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const Cursor = z.tuple([z.iso.datetime(), z.enum(['sent', 'received']), z.string().min(1).max(120), z.string()]);
function readCursor(value: string | undefined, binding: string) {
  if (!value) return null;
  try {
    const [at, direction, id, bound] = Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (bound !== binding) throw new Error();
    return { at, direction, id };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}

type Row = { direction: 'sent' | 'received'; untrusted: boolean; id: string; at: string; status: string; from_address: string; from_name: string | null; to: unknown[]; subject: string; stream: 'transactional' | 'marketing' | null; campaign_id: string | null; scheduled_at: string | null; simulated: boolean; attachment_count: number | null; thread_id: string | null; thread_count: number | null; addresses: { id: string; address: string }[] | null; region: string | null; envelope_to: string[] | null };

export function registerLogs(app: App, mailAccess: (a: Actor) => MailboxAccess | null) {
  app.openapi(createRoute({ method: 'get', path: '/v1/logs', operationId: 'listLogs', tags: ['Emails'], security, summary: 'List sent and received mail together',
    description: 'Sent and received mail in one list, newest first, with an opaque cursor bound to the filters. Sent mail is what listEmails returns (keys restricted to domains see their own domains); received mail is what listInboundMessages returns for the same credential: administrators see every received message, including unrouted mail, with delivery details; dashboard members see mail on receiving addresses; other credentials get sent mail only. kind, campaignId and a sent-mail status filter sent mail and leave received mail out; status=received or status=spam filter received mail and leave sent mail out. ' + readLimitNote(LOGS_READ),
    request: { query: LogQuery }, responses: { 200: response(LogPage), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query');
    if (q.region) region(c.env, q.region);
    const access = mailAccess(a), onlyReceived = receivedStatus(q.status);
    // direction=received and the Received/Spam filters ask for received mail alone: refuse them to a credential that can't
    // read it, rather than answer with sent mail it didn't ask for or with nothing to query.
    if ((q.direction === 'received' || onlyReceived) && !access) throw a.domains.length ? unrestrictedRequired('Received mail requires a credential without domain restrictions.', { permission: 'receivedMail', level: 'read' }) : denied('ADMIN_REQUIRED', 'Received mail requires a dashboard session or a manage credential.', { permission: 'receivedMail', level: 'read' });
    // counts changes what the page carries, not which rows it lists: a cursor works with or without it.
    const { counts: withCounts, ...filters } = q;
    const binding = await pageBinding(a, 'logs', filters), after = readCursor(q.cursor, binding), n = q.limit + 1;
    const sent = q.direction !== 'received' && !onlyReceived, received = q.direction !== 'sent' && !!access && !(q.kind || q.campaignId) && (!q.status || onlyReceived);
    // The dates bound both sides, by when sent mail was created and received mail arrived: the page and its counts alike.
    const dated = (column: AnyPgColumn) => and(q.from ? sql`${column} >= ${q.from}::timestamptz` : undefined, q.to ? sql`${column} < ${q.to}::timestamptz` : undefined);

    const sentPage = sent ? sql`(SELECT 'sent'::text AS direction, ${sentUntrustedContent} AS untrusted, ${emails.id} AS id, ${emails.createdAt} AS sort_at, ${precise(emails.createdAt)} AS at, ${emails.status} AS status,
        ${emails.from} AS from_address, ${emails.snapshot}->>'fromName' AS from_name, ${emails.to} AS "to", ${emails.subject} AS subject, ${emails.snapshot}->>'kind' AS stream,
        ${emails.campaignId} AS campaign_id, CASE WHEN ${emails.status}='scheduled' THEN ${precise(emails.scheduledAt)} END AS scheduled_at, ${emails.simulated} AS simulated, NULL::int AS attachment_count, ${access ? sentThreadId : sql`NULL::text`} AS thread_id, NULL::jsonb AS addresses, ${emails.region} AS region, NULL::jsonb AS envelope_to
      FROM ${emails} WHERE ${and(mailWhere(a),
        after ? after.direction === 'sent' ? sql`(${emails.createdAt}, ${emails.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${emails.createdAt} < ${after.at}::timestamptz` : undefined,
        q.campaignId ? sql`${emails.campaignId} = ${q.campaignId}` : undefined, q.status && !onlyReceived ? sql`${emails.status} = ${q.status}` : undefined,
        q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined, q.region ? sql`${emails.region} = ${q.region}` : undefined, dated(emails.createdAt),
        q.search ? sentSearch(q.search) : undefined)}
      ORDER BY ${emails.createdAt} DESC, ${emails.id} DESC LIMIT ${n})` : null;

    // Which messages: every retained one for administrators. Delivery details: only where getInboundMessage gives them.
    const delivery = !!access && readsDelivery(a, access);
    const receivedPage = received && access ? sql`(SELECT 'received'::text AS direction, true AS untrusted, ${messages.id} AS id, ${messages.receivedAt} AS sort_at, ${precise(messages.receivedAt)} AS at,
        ${delivery ? sql`CASE WHEN ${messages.spam} THEN 'spam' ELSE ${messages.status} END` : messages.status} AS status,
        ${messages.fromAddress} AS from_address, ${messages.fromName} AS from_name, coalesce((SELECT jsonb_agg(t->>'address') FROM jsonb_array_elements(${messages.to}) t), '[]'::jsonb) AS "to",
        ${messages.subject} AS subject, NULL::text AS stream, NULL::text AS campaign_id, NULL::text AS scheduled_at, false AS simulated, ${messages.attachmentCount} AS attachment_count, ${messages.threadId} AS thread_id,
        ${visibleAddresses(access)} AS addresses, ${delivery ? messages.region : sql`NULL::text`} AS region, ${delivery ? messages.envelopeTo : sql`NULL::jsonb`} AS envelope_to
      FROM ${messages} WHERE ${and(accessibleMessages(access, {}), sql`${messages.direction} = 'inbound'`,
        after ? after.direction === 'received' ? sql`(${messages.receivedAt}, ${messages.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${messages.receivedAt} <= ${after.at}::timestamptz` : undefined,
        q.region ? sql`${messages.region} = ${q.region}` : undefined, dated(messages.receivedAt), q.search ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.search})` : undefined,
        // Only administrators see the spam flag, so for anyone else nothing is spam and everything is received.
        q.status === 'spam' ? delivery ? sql`${messages.spam}` : sql`false` : q.status === 'received' && delivery ? sql`NOT ${messages.spam}` : undefined)}
      ORDER BY ${messages.receivedAt} DESC, ${messages.id} DESC LIMIT ${n})` : null;

    const pages = [sentPage, receivedPage].filter((part): part is SQL => part !== null);
    const merged = pages.length === 1 ? pages[0]! : sql`SELECT * FROM (${pages[0]} UNION ALL ${pages[1]}) log ORDER BY sort_at DESC, direction DESC, id DESC LIMIT ${n}`;

    // Facet counts: each facet's values under every other filter, so a count says what choosing that value would list.
    // Status counts take both sides (received mail only without kind or campaignId); kind counts take sent mail under the status.
    // Sent mail is read once, a kind at a time: each kind's dates in sending_emails_kind_created, with one heap fetch per
    // email for its status. The same rows give the status counts (under the chosen kind) and the kind counts (under the
    // chosen status). Every email has a kind. The kind is only compared, which the index answers, never selected, so the
    // counts don't load each email's body.
    const countLogs = async (db: DbExecutor) => {
      const sentSide = q.direction !== 'received', receivedSide = q.direction !== 'sent' && !!access && !q.kind && !q.campaignId;
      const byKind = (kind: 'transactional' | 'marketing') => sql`SELECT ${kind}::text AS kind, ${emails.status} AS status, count(*)::int AS n FROM ${emails}
        WHERE ${and(mailWhere(a), sql`${emails.snapshot}->>'kind' = ${kind}`, q.campaignId ? sql`${emails.campaignId} = ${q.campaignId}` : undefined, q.region ? sql`${emails.region} = ${q.region}` : undefined, dated(emails.createdAt),
          q.search ? sentSearch(q.search) : undefined)}
        GROUP BY ${emails.status}`;
      // One after another on the read's one connection.
      const sentRows = sentSide ? (await db.execute<{ kind: 'transactional' | 'marketing'; status: string; n: number }>(sql`${byKind('transactional')} UNION ALL ${byKind('marketing')}`)).rows : [];
      const receivedRow = receivedSide && access ? (await db.execute<{ spam: number; total: number }>(sql`SELECT count(*) FILTER (WHERE ${messages.spam})::int AS spam, count(*)::int AS total
          FROM ${messages} WHERE ${and(accessibleMessages(access, {}), sql`${messages.direction} = 'inbound'`, q.region ? sql`${messages.region} = ${q.region}` : undefined, dated(messages.receivedAt), q.search ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.search})` : undefined)}`)).rows[0] : undefined;
      const status: Record<string, number> = {}, kind = { transactional: 0, marketing: 0 };
      for (const row of sentRows) {
        if (!q.kind || row.kind === q.kind) status[row.status] = (status[row.status] ?? 0) + row.n;
        if (!onlyReceived && (!q.status || row.status === q.status)) kind[row.kind] += row.n;
      }
      // Only administrators see the spam verdict (as in the list): for anyone else every message they read is received.
      const spam = receivedRow && delivery ? receivedRow.spam : 0, clean = (receivedRow?.total ?? 0) - spam;
      if (clean) status.received = clean;
      if (spam) status.spam = spam;
      return { status, kind, capped: { sent: false, received: false } };
    };
    // After the page, on its connection, the counts get a shorter limit of their own: past it they are refused, and the
    // dashboard, which reads them apart from its list, shows its filters without numbers.
    const countWithin = async (db: DbExecutor) => {
      await db.execute(sql.raw(`SET LOCAL statement_timeout = '${COUNTS_READ}s'`));
      try { return await countLogs(db); } catch (error) { throw statementTimedOut(error) ? readLimit(COUNTS_READ).refusal() : error; }
    };
    // The page, then its counts, on one connection, each statement within its limit.
    const { rows, counts } = await budgetedRead(c.env.db, async db => ({ rows: (await db.execute<Row>(access ? sql`WITH page AS MATERIALIZED (${merged}),
        sizes AS (SELECT t.thread_id, ${threadSize(access, true, sql`t.thread_id`)} AS thread_count FROM (SELECT DISTINCT thread_id FROM page WHERE thread_id IS NOT NULL) t)
      SELECT page.*, sizes.thread_count FROM page LEFT JOIN sizes USING (thread_id) ORDER BY page.sort_at DESC, page.direction DESC, page.id DESC` : merged)).rows,
      counts: withCounts === 'true' ? await countWithin(db) : undefined }), readLimit(LOGS_READ));
    const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
    return c.json({
      data: rows.slice(0, q.limit).map(row => ({
        id: row.id, direction: row.direction, untrustedContent: row.untrusted, at: new Date(row.at).toISOString(), status: row.status, from: { name: row.from_name, address: row.from_address },
        to: (row.to ?? []).map(String), subject: listedSubject(a, row).subject, stream: row.stream, campaignId: row.campaign_id, scheduledAt: row.scheduled_at && new Date(row.scheduled_at).toISOString(), simulated: row.simulated, attachmentCount: row.attachment_count,
        threadId: row.thread_count == null ? null : row.thread_id, threadCount: row.thread_count ?? null, addresses: row.addresses, region: row.region, envelopeTo: row.envelope_to,
      })),
      nextCursor: last ? Buffer.from(JSON.stringify([last.at, last.direction, last.id, binding])).toString('base64url') : null,
      received,
      ...counts && { counts },
    }, 200);
  });
}
