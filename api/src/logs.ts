import { createRoute, z } from '@hono/zod-openapi';
import { and, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { literalSearch, actor, ApiError, budgetedRead, denied, errors, PageQuery, readLimit, readLimitNote, statementTimedOut, unrestrictedRequired, region, response, security, type Actor, type App, type Ctx, type DbExecutor, type MailboxAccess } from './core.js';
import { createFairPool, PAGE_MAX_BYTES, READ_MAX_WAITERS, READ_MAX_WAITING_PER_WORKSPACE, withBoundedRead } from './read-bounds.js';
import { fitPageByBytes, INBOUND_ADDRESS_PAGE_LIMIT, messageFieldCount, sliceAddressStrings, sliceJsonbArray } from './inbound-bounds.js';
import { emails } from './db/sending.js';
import { enroll24hPoll, enrollLogFacet, logFacetPeriod, LOG_FACET_WAIT_MS, readPublishedLogFacet, readRecent24hFacet, readTicketCut, releaseLogFacetTicket, type FacetTicket } from './log-facet-fold.js';
import { LOG_FACET_MAX_SOURCE_ROWS, logFacetSourceRows, type LogFacetCut, type LogFacetPeriod } from './log-facet-source.js';
import type { AggregateTicket } from './log-facet-aggregate-view.js';
import { mailMessages as messages } from './db/mailbox.js';
import { readsDelivery, visibleAddresses } from './inbound-threads.js';
import { accessibleMessages, sentThreadId, threadSize } from './thread-view.js';
import { EmailStatusFilter, listedSubject, mailWhere, pageBinding, sentUntrustedContent, SubstringSearch } from './sending.js';

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
  to: z.array(z.string()).describe('Sent: the To recipients (at most 20). Received: the addresses in the To header (at most 20).'),
  toCount: z.number().int().describe('Total To recipients (may exceed to.length when shortened).'),
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
  envelopeTo: z.array(z.string()).nullable().describe('Received mail, administrators only: the SMTP envelope recipients (at most 20).'),
  envelopeToCount: z.number().int().nullable().describe('Received mail, administrators only: total SMTP envelope recipients.'),
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
  search: SubstringSearch.optional().describe('At least 3 characters: a shorter term is refused with 422 VALIDATION_FAILED. Sent mail: a literal, case-insensitive substring of the sender, recipients, subject or IDs. Received mail: a full-text match on sender, recipients, subject and body.'),
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

type Row = { direction: 'sent' | 'received'; untrusted: boolean; id: string; at: string; status: string; from_address: string; from_name: string | null; to: unknown[]; to_count: number; subject: string; stream: 'transactional' | 'marketing' | null; campaign_id: string | null; scheduled_at: string | null; simulated: boolean; attachment_count: number | null; thread_id: string | null; thread_count: number | null; addresses: { id: string; address: string }[] | null; region: string | null; envelope_to: string[] | null; envelope_to_count: number | null; candidate_count: number };

type Filters = z.output<typeof LogQuery>;
type SentFacet = { kind: 'transactional' | 'marketing'; status: string; n: number };
type ReceivedFacet = { spam: number; total: number };
type Facets = z.infer<typeof LogCounts>;
const FACET_REPROBE_MS = 150;
// Parked viewers don't occupy the DB pool or a list/read slot. They still have a finite per-workspace and per-isolate budget.
const parkedFacets = createFairPool({ name: 'log-facet-wait', maxActive: READ_MAX_WAITERS,
  maxPerWorkspace: READ_MAX_WAITING_PER_WORKSPACE, maxWaitingPerWorkspace: 0, maxWaitingTotal: 0 });

function waitForFacetProbe(c: Ctx, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const start = Date.now();
    const done = (elapsed: boolean) => {
      clearTimeout(timer); signal.removeEventListener('abort', canceled);
      // This dashboard request is asleep only between probes, not while authorizing or reading a cut.
      c.set('pollWaitMs', (c.get('pollWaitMs') ?? 0) + Math.max(0, Date.now() - start));
      resolve(elapsed);
    };
    const canceled = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', canceled, { once: true });
  });
}

// Both reads use the same live actor and filter guard. A presentation read never chooses a visibility band from the client.
function logAccess(c: Ctx, q: Filters, mailAccess: (a: Actor) => MailboxAccess | null) {
  const a = actor(c);
  if (q.region) region(c.env, q.region);
  const access = mailAccess(a), onlyReceived = receivedStatus(q.status);
  if ((q.direction === 'received' || onlyReceived) && !access) throw a.domains.length ? unrestrictedRequired(a, 'Received mail needs', { permission: 'receivedMail', level: 'read' }) : denied('ADMIN_REQUIRED', 'Received mail requires a dashboard session or a manage credential.', { permission: 'receivedMail', level: 'read' });
  return { a, access, onlyReceived, delivery: !!access && readsDelivery(a, access) };
}

function facetCounts(q: Filters, sentRows: SentFacet[], receivedRow: ReceivedFacet | undefined, delivery: boolean): Facets {
  const onlyReceived = receivedStatus(q.status);
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
}

type LogScope = ReturnType<typeof logAccess>;
const facetVisibility = (scope:LogScope) => scope.access?.admin && scope.delivery ? 'admin' as const : 'member' as const;
function projectCut(q:Filters,scope:LogScope,cut:LogFacetCut) {
  const received=q.direction==='sent' || q.kind || q.campaignId || !scope.access ? undefined
    : scope.access.admin ? cut.admin : {total:cut.member.total,spam:0};
  return facetCounts(q,q.direction==='received'?[]:cut.sent,received,scope.delivery);
}
async function currentFacetScope(c:Ctx, db:DbExecutor, q:Filters, original:LogScope, mailAccess:(a:Actor)=>MailboxAccess|null) {
  const {accountSessionActorOnFacetRetry}=await import('./account-login.js');
  const fresh=await accountSessionActorOnFacetRetry(c.env,c.req.raw.headers,db);
  if(!fresh || fresh.keyId!==original.a.keyId)throw new ApiError(401,'AUTH_REQUIRED','Sign in or supply a bearer API key.');
  if(fresh.workspaceId!==original.a.workspaceId)throw new ApiError(403,'WORKSPACE_ACCESS_DENIED','This workspace is not available to your session.');
  c.set('actor',fresh);
  const scope=logAccess(c,q,mailAccess);
  if(scope.a.credential!=='dashboard'||scope.a.domains.length||scope.access?.mailboxIds!==null)
    throw denied('DASHBOARD_AUTH_REQUIRED','Use an unrestricted signed-in dashboard session.',{credential:'dashboard'});
  return scope;
}

// The unchanged public exact count and the private fallback for uncommon filters and narrowed credentials.
async function countLiveFacets(db: DbExecutor, q: Filters, scope: ReturnType<typeof logAccess>): Promise<Facets> {
  const { a, access, delivery } = scope;
  const sentSide = q.direction !== 'received', receivedSide = q.direction !== 'sent' && !!access && !q.kind && !q.campaignId;
  const dated = (column: AnyPgColumn) => and(q.from ? sql`${column} >= ${q.from}::timestamptz` : undefined, q.to ? sql`${column} < ${q.to}::timestamptz` : undefined);
  const byKind = (kind: 'transactional' | 'marketing') => sql`SELECT ${kind}::text AS kind, ${emails.status} AS status, count(*)::int AS n FROM ${emails}
    WHERE ${and(mailWhere(a), sql`${emails.snapshot}->>'kind' = ${kind}`, q.campaignId ? sql`${emails.campaignId} = ${q.campaignId}` : undefined, q.region ? sql`${emails.region} = ${q.region}` : undefined, dated(emails.createdAt),
      q.search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${literalSearch(q.search)}` : undefined)}
    GROUP BY ${emails.status}`;
  // One after another on the read's one connection.
  const sentRows = sentSide ? (await db.execute<{ kind: 'transactional' | 'marketing'; status: string; n: number }>(sql`${byKind('transactional')} UNION ALL ${byKind('marketing')}`)).rows : [];
  const receivedRow = receivedSide && access ? (await db.execute<{ spam: number; total: number }>(sql`SELECT count(*) FILTER (WHERE ${messages.spam})::int AS spam, count(*)::int AS total
      FROM ${messages} WHERE ${and(accessibleMessages(access, {}), sql`${messages.direction} = 'inbound'`, q.region ? sql`${messages.region} = ${q.region}` : undefined, dated(messages.receivedAt), q.search ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.search})` : undefined)}`)).rows[0] : undefined;
  return facetCounts(q, sentRows, receivedRow, delivery);
}

function foldableFacet(q: Filters, scope: LogScope) {
  const fromMs = q.from ? Date.parse(q.from) : NaN, age = Date.now() - fromMs;
  // Date.parse discards sub-millisecond digits: a 00.000001Z start is not a whole minute.
  return !scope.a.domains.length && scope.access?.mailboxIds === null && !q.search && !q.campaignId && !q.to &&
    !!q.from && /:00(?:\.0+)?(?:Z|[+-]\d\d:\d\d)$/.test(q.from) && fromMs % 60_000 === 0 && age >= 0 && age <= 31 * 86_400_000;
}
const facetBusy = (error: unknown): error is ApiError => error instanceof ApiError && (error.status === 429 || error.status === 503) &&
  ['READ_CONCURRENCY_LIMIT', 'FACET_FOLD_CAPACITY', 'FACET_CATCHUP_UNAVAILABLE'].includes(error.code);

// Reauthorize and project in the same snapshot. While overloaded, try the indexed publication
// once without joining a wait queue; never scan mail or substitute the viewer's absolute from.
function readLastFacet(c: Ctx, q: Filters, scope: LogScope, mailAccess: (a: Actor) => MailboxAccess | null, period: LogFacetPeriod, busy = false) {
  return withBoundedRead(c, () => budgetedRead(c.env.db, async db => {
    const fresh = await currentFacetScope(c, db, q, scope, mailAccess);
    let p = await readPublishedLogFacet(db, fresh.a.workspaceId, q.region ?? null, period);
    if (c.env.startLogFacetAggregate) {
      const model = await import('./log-facet-aggregate-view.js');
      if (await model.hasFacetRegistry(db)) {
        const archived = await model.readArchivedBucketFacet(db, fresh.a.workspaceId, q.region ?? null, period);
        if (archived && (!p || archived.cut.asOf > p.cut.asOf)) p = archived;
        if (!p && !busy) p = await model.readCertifiedRollingFacet(db, fresh.a.workspaceId, q.region ?? null, period);
      }
    }
    const visibility = facetVisibility(fresh);
    return p ? { counts: projectCut(q, fresh, p.cut), asOf: p.cut.asOf, from: p.from, visibility }
      : { counts: null, asOf: null, from: null, visibility };
  }, busy ? { seconds: 1, refusal: () => new ApiError(503, 'FACET_CATCHUP_UNAVAILABLE', 'Logs facets are busy.') } : readLimit(COUNTS_READ),
  'repeatable read'), { workspaceId: scope.a.workspaceId, route: busy ? 'logs.facets.pending' : 'logs.facets', ...(busy && { maxWaitMs: 0 }) });
}

async function readDashboardFacets(c:Ctx,q:Filters,scope:LogScope,mailAccess:(a:Actor)=>MailboxAccess|null) {
    const opts = { route: 'logs.facets', workspaceId: scope.a.workspaceId }, signal = c.req.raw.signal;
    const mode=c.req.query('mode'), askedPeriod=c.req.query('range'), period=logFacetPeriod(askedPeriod);
    if ((mode !== undefined && mode !== 'last' && mode !== 'refresh') || (askedPeriod !== undefined && !period))
      throw new ApiError(422,'VALIDATION_FAILED','Choose a supported Logs facet view and time range.');
    const prefer=c.req.query('prefer'), poll24h=mode==='refresh' && period==='24h' && prefer==='recent';
    if (prefer!==undefined && !poll24h) throw new ApiError(422,'VALIDATION_FAILED','Only a 24h refresh can prefer a recent cut.');
    if (mode==='last') {
      // This is a relative range *as of the saved source statement*, not an older answer
      // mislabeled with a new absolute from. Private custom searches/dates never use this matrix.
      if(!period||q.from||q.to||q.search||q.campaignId||q.cursor)
        throw new ApiError(422,'VALIDATION_FAILED','A last-folded read requires a rolling range without custom dates, search or campaign.');
      const last = await readLastFacet(c, q, scope, mailAccess, period);
      if(last instanceof Response)return last;
      return c.json(last,200);
    }
    if(mode==='refresh'&&(!q.from||!period))throw new ApiError(422,'VALIDATION_FAILED','A refresh requires the visible date range and its start.');
    const fromMs = q.from ? Date.parse(q.from) : NaN;
    if (!foldableFacet(q,scope)) {
      const counts = await withBoundedRead(c, () => budgetedRead(c.env.db, db => countLiveFacets(db, q, scope), readLimit(COUNTS_READ)), opts);
      if (counts instanceof Response) return counts;
      return c.json({ counts, ...(mode==='refresh' && { visibility:facetVisibility(scope),from:q.from }) }, 200);
    }
    // A fold reads every email in its window (no index-only path). Refuse a window too large to fold, as the live count
    // refuses one, before anything is parked or enrolled: it would read gigabytes for 12 seconds, fail and be retried.
    const fromIso = new Date(fromMs).toISOString();
    // The dashboard's automatic 24h poll accepts an already completed absolute cut for one minute.
    // Authorize and project it in the same read snapshot, before sizing mail or occupying a worker.
    const recent = () => withBoundedRead(c,()=>budgetedRead(c.env.db,async db=>{
      const current=await currentFacetScope(c,db,q,scope,mailAccess);
      let cut=await readRecent24hFacet(db,current.a.workspaceId,q.region??null,fromIso);
      if(!cut && c.env.startLogFacetAggregate){
        const a=await import('./log-facet-aggregate-view.js');
        if(await a.hasFacetRegistry(db))cut=await a.readRecentAggregateDay(db,current.a.workspaceId,q.region??null,fromIso);
      }
      return cut ? {counts:projectCut(q,current,cut),asOf:cut.asOf,from:fromIso,visibility:facetVisibility(current)} : null;
    },readLimit(COUNTS_READ),'repeatable read'),opts);
    if (poll24h) {
      const found=await recent();
      if (found instanceof Response) return found;
      if (found) return c.json(found,200);
    }
    let aggregate=false,seeding=false;
    if(mode==='refresh' && period && c.env.startLogFacetAggregate){
      const {facetAggregateState}=await import('./log-facet-aggregate-view.js');
      const state=await withBoundedRead(c,()=>budgetedRead(c.env.db,db=>facetAggregateState(db,scope.a.workspaceId),readLimit(COUNTS_READ)),opts);
      if(state instanceof Response)return state;
      aggregate=state==='seeded';seeding=state==='seeding';
    }
    if(!aggregate){
      const rolling = period ? Math.floor(Date.now() / 60_000) * 60_000 - { '24h': 1, '7d': 7, '30d': 30 }[period] * 86_400_000 : fromMs;
      const sized = await withBoundedRead(c, () => budgetedRead(c.env.db,
        db => logFacetSourceRows(db, scope.a.workspaceId, new Date(Math.min(fromMs, rolling)).toISOString(), q.region ?? null), readLimit(COUNTS_READ)), opts);
      if (sized instanceof Response) return sized;
      // Until this workspace's buckets are seeded (after install, or a new generation after a gap or a
      // source rewrite), the source fold keeps serving a window it can size. Only a larger one waits.
      if (seeding && sized <= LOG_FACET_MAX_SOURCE_ROWS) {
        await (await import('./log-facet-aggregate-view.js')).wakeFacetAggregate(c.env.db,scope.a.workspaceId);
        c.env.startLogFacetAggregate?.(scope.a.workspaceId);
      } else if (seeding) aggregate=true;
      else if (sized > LOG_FACET_MAX_SOURCE_ROWS) throw readLimit(COUNTS_READ).refusal();
    }
    const end = performance.now() + LOG_FACET_WAIT_MS;
    if (signal.aborted) return new Response(null, { status: 499 });
    let hold;
    try {
      hold = await parkedFacets.acquire(opts.workspaceId, signal, { route: 'logs.facets.catchup',
        idleMs: LOG_FACET_WAIT_MS, maxMs: LOG_FACET_WAIT_MS, wsBusyCode: 'READ_CONCURRENCY_LIMIT', busyCode: 'READ_CONCURRENCY_LIMIT',
        wsBusyMessage: 'Too many reads are waiting for this workspace.', busyMessage: 'Too many reads are waiting.' });
    } catch (error) {
      if (signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    const unavailable = () => {
      c.header('Retry-After', '1');
      return new ApiError(503, 'FACET_CATCHUP_UNAVAILABLE', 'Exact Logs counts are temporarily unavailable.', undefined, true);
    };
    let ticket:FacetTicket|null=null;
    try {
      let aggregateTicket:AggregateTicket|undefined;
      const model=aggregate?await import('./log-facet-aggregate-view.js'):undefined;
      if(model && period){
        aggregateTicket=await model.enrollAggregateFacet(c.env.db,scope.a.workspaceId,q.region??null,period,fromIso);
        c.env.startLogFacetAggregate?.(scope.a.workspaceId);
      } else if (poll24h) {
        ticket=await enroll24hPoll(c.env,scope.a.workspaceId,fromIso,q.region??null);
        if (!ticket) {
          const found=await recent();
          if (found instanceof Response) return found;
          if (found) return c.json(found,200);
        }
      }
      if(!aggregateTicket)ticket??=await enrollLogFacet(c.env,scope.a.workspaceId,fromIso,q.region??null,period);
      const admitted=ticket;
      if (ticket?.wake) c.env.startLogFacetFold?.(ticket.slot);
      let probes = 0,nextNudge=performance.now()+1000;
      while (performance.now() < end) {
        // A small healthy cut can already be published at the first probe. Park only between probes.
        if (probes && !await waitForFacetProbe(c, Math.min(probes === 1 ? 25 : FACET_REPROBE_MS, end - performance.now()), signal)) return new Response(null, { status: 499 });
        probes++;
        if (performance.now() >= end) break;
        const next = await withBoundedRead(c, () => budgetedRead(c.env.db, async db => {
          if (performance.now() >= end) throw unavailable();
          // Every probe resolves the real session and role against the same snapshot that reads the published cut.
          const current=await currentFacetScope(c,db,q,scope,mailAccess);
          const cut=model && aggregateTicket ? await model.readAggregateTicket(db,aggregateTicket) : await readTicketCut(db,admitted!);
          if(!cut)return null;
          return {counts:projectCut(q,current,cut),asOf:cut.asOf,
            ...(mode==='refresh' && {from:new Date(fromMs).toISOString(),visibility:facetVisibility(current)})};
        }, { seconds:COUNTS_READ, refusal:unavailable }, 'repeatable read'), { ...opts, maxWaitMs: Math.max(1, Math.ceil(end - performance.now())) });
        if (next instanceof Response) return next;
        if (signal.aborted) return new Response(null, { status: 499 });
        if (next) return c.json(next, 200);
        if(aggregateTicket && performance.now()>=nextNudge){
          c.env.startLogFacetAggregate?.(scope.a.workspaceId);nextNudge=performance.now()+1000;
        }
      }
      // A platform/worker failure is not a successful numerical bound; never substitute the previous generation.
      throw unavailable();
    } finally {
      hold.release();
      if (ticket) await releaseLogFacetTicket(c.env.db,ticket);
    }
}

export function registerLogs(app: App, mailAccess: (a: Actor) => MailboxAccess | null) {
  app.get('/v1/logs/facets', async c => {
    const parsed = LogQuery.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid Logs filters.');
    const q = parsed.data, scope = logAccess(c, q, mailAccess);
    if (scope.a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    c.header('Cache-Control', 'private, no-store');
    try { return await readDashboardFacets(c, q, scope, mailAccess); }
    catch (error) {
      if (!facetBusy(error)) throw error;
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      const mode = c.req.query('mode'), period = logFacetPeriod(c.req.query('range'));
      const retryAfterSeconds = error.code === 'FACET_CATCHUP_UNAVAILABLE' ? 30 : 5;
      let last = null;
      if (error.code !== 'READ_CONCURRENCY_LIMIT' && period && (mode === 'last' || mode === 'refresh' && foldableFacet(q, scope))) {
        try {
          const stored = await readLastFacet(c, q, scope, mailAccess, period, true);
          if (stored instanceof Response) return stored;
          if (stored.counts !== null) last = stored;
        } catch (fallbackError) { if (!facetBusy(fallbackError)) throw fallbackError; }
      }
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({ state: 'pending', last, retryAfterSeconds }, 200);
    }
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/logs', operationId: 'listLogs', tags: ['Emails'], security, summary: 'List sent and received mail together',
    description: 'Sent and received mail in one list, newest first, with an opaque cursor bound to the filters. Sent mail is what listEmails returns (keys restricted to domains see their own domains); received mail is what listInboundMessages returns for the same credential: administrators see every received message, including unrouted mail, with delivery details; dashboard members see mail on receiving addresses; other credentials get sent mail only. kind, campaignId and a sent-mail status filter sent mail and leave received mail out; status=received or status=spam filter received mail and leave sent mail out. ' + readLimitNote(LOGS_READ),
    request: { query: LogQuery }, responses: { 200: response(LogPage), ...errors } }), async c => {
    const q = c.req.valid('query'), scope = logAccess(c, q, mailAccess);
    const { a, access, onlyReceived, delivery } = scope;
    // counts changes what the page carries, not which rows it lists: a cursor works with or without it.
    const { counts: withCounts, ...filters } = q;
    const binding = await pageBinding(a, 'logs', filters), after = readCursor(q.cursor, binding), n = q.limit + 1;
    const sent = q.direction !== 'received' && !onlyReceived, received = q.direction !== 'sent' && !!access && !(q.kind || q.campaignId) && (!q.status || onlyReceived);
    // The dates bound both sides, by when sent mail was created and received mail arrived: the page and its counts alike.
    const dated = (column: AnyPgColumn) => and(q.from ? sql`${column} >= ${q.from}::timestamptz` : undefined, q.to ? sql`${column} < ${q.to}::timestamptz` : undefined);

    const addrCap = INBOUND_ADDRESS_PAGE_LIMIT;
    const sentPage = sent ? sql`(SELECT 'sent'::text AS direction, ${sentUntrustedContent} AS untrusted, ${emails.id} AS id, ${emails.createdAt} AS sort_at, ${precise(emails.createdAt)} AS at, ${emails.status} AS status,
        ${emails.from} AS from_address, ${emails.snapshot}->>'fromName' AS from_name, ${sliceJsonbArray(emails.to, addrCap)} AS "to", jsonb_array_length(${emails.to})::int AS to_count, ${emails.subject} AS subject, ${emails.snapshot}->>'kind' AS stream,
        ${emails.campaignId} AS campaign_id, CASE WHEN ${emails.status}='scheduled' THEN ${precise(emails.scheduledAt)} END AS scheduled_at, ${emails.simulated} AS simulated, NULL::int AS attachment_count, ${access ? sentThreadId : sql`NULL::text`} AS thread_id, NULL::jsonb AS addresses, ${emails.region} AS region, NULL::jsonb AS envelope_to, NULL::int AS envelope_to_count
      FROM ${emails} WHERE ${and(mailWhere(a),
        after ? after.direction === 'sent' ? sql`(${emails.createdAt}, ${emails.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${emails.createdAt} < ${after.at}::timestamptz` : undefined,
        q.campaignId ? sql`${emails.campaignId} = ${q.campaignId}` : undefined, q.status && !onlyReceived ? sql`${emails.status} = ${q.status}` : undefined,
        q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined, q.region ? sql`${emails.region} = ${q.region}` : undefined, dated(emails.createdAt),
        q.search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${literalSearch(q.search)}` : undefined)}
      ORDER BY ${emails.createdAt} DESC, ${emails.id} DESC LIMIT ${n})` : null;

    // Which messages: every retained one for administrators. Delivery details: only where getInboundMessage gives them.
    const receivedPage = received && access ? sql`(SELECT 'received'::text AS direction, true AS untrusted, ${messages.id} AS id, ${messages.receivedAt} AS sort_at, ${precise(messages.receivedAt)} AS at,
        ${delivery ? sql`CASE WHEN ${messages.spam} THEN 'spam' ELSE ${messages.status} END` : messages.status} AS status,
        ${messages.fromAddress} AS from_address, ${messages.fromName} AS from_name, ${sliceAddressStrings(messages.to, addrCap)} AS "to", ${messageFieldCount(messages.to, messages.verdicts, 'toCount')} AS to_count,
        ${messages.subject} AS subject, NULL::text AS stream, NULL::text AS campaign_id, NULL::text AS scheduled_at, false AS simulated, ${messages.attachmentCount} AS attachment_count, ${messages.threadId} AS thread_id,
        ${visibleAddresses(access)} AS addresses, ${delivery ? messages.region : sql`NULL::text`} AS region, ${delivery ? sliceJsonbArray(messages.envelopeTo, addrCap) : sql`NULL::jsonb`} AS envelope_to, ${delivery ? sql`jsonb_array_length(${messages.envelopeTo})::int` : sql`NULL::int`} AS envelope_to_count
      FROM ${messages} WHERE ${and(accessibleMessages(access, {}, 'perMessage'), sql`${messages.direction} = 'inbound'`,
        after ? after.direction === 'received' ? sql`(${messages.receivedAt}, ${messages.id}) < (${after.at}::timestamptz, ${after.id})` : sql`${messages.receivedAt} <= ${after.at}::timestamptz` : undefined,
        q.region ? sql`${messages.region} = ${q.region}` : undefined, dated(messages.receivedAt), q.search ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.search})` : undefined,
        // Only administrators see the spam flag, so for anyone else nothing is spam and everything is received.
        q.status === 'spam' ? delivery ? sql`${messages.spam}` : sql`false` : q.status === 'received' && delivery ? sql`NOT ${messages.spam}` : undefined)}
      ORDER BY ${messages.receivedAt} DESC, ${messages.id} DESC LIMIT ${n})` : null;

    const pages = [sentPage, receivedPage].filter((part): part is SQL => part !== null);
    const merged = pages.length === 1 ? pages[0]! : sql`SELECT * FROM (${pages[0]} UNION ALL ${pages[1]}) log ORDER BY sort_at DESC, direction DESC, id DESC LIMIT ${n}`;

    // After the page, on its connection, the counts get a shorter limit of their own: past it they are refused, and the
    // dashboard, which reads them apart from its list, shows its filters without numbers.
    const countWithin = async (db: DbExecutor) => {
      await db.execute(sql.raw(`SET LOCAL statement_timeout = '${COUNTS_READ}s'`));
      try {
        return await countLiveFacets(db, q, scope);
      } catch (error) { throw statementTimedOut(error) ? readLimit(COUNTS_READ).refusal() : error; }
    };
    // The page (byte-bounded in SQL), then its counts, on one connection, each statement within its limit.
    const boundedSql = sql`WITH candidate AS MATERIALIZED (${merged}),
      sized AS (
        SELECT *,
          row_number() OVER (ORDER BY sort_at DESC, direction DESC, id DESC) AS rn,
          sum(octet_length("to"::text) + coalesce(octet_length(envelope_to::text), 0) + coalesce(octet_length(addresses::text), 0) + octet_length(subject) + octet_length(from_address) + coalesce(octet_length(from_name), 0) + 384)
            OVER (ORDER BY sort_at DESC, direction DESC, id DESC ROWS UNBOUNDED PRECEDING) AS cum_bytes
        FROM candidate
      ),
      page AS MATERIALIZED (
        SELECT *, (SELECT count(*)::int FROM candidate) AS candidate_count
        FROM sized WHERE rn = 1 OR cum_bytes <= ${PAGE_MAX_BYTES}
      )${access ? sql`,
      sizes AS (SELECT t.thread_id, ${threadSize(access, true, sql`t.thread_id`)} AS thread_count FROM (SELECT DISTINCT thread_id FROM page WHERE thread_id IS NOT NULL) t)
      SELECT page.*, sizes.thread_count FROM page LEFT JOIN sizes USING (thread_id) ORDER BY page.rn` : sql`
      SELECT page.*, NULL::int AS thread_count FROM page ORDER BY page.rn`}`;
    return await withBoundedRead(c, async () => {
      const { rows, counts } = await budgetedRead(c.env.db, async db => ({
        rows: (await db.execute<Row>(boundedSql)).rows,
        counts: withCounts === 'true' ? await countWithin(db) : undefined,
      }), readLimit(LOGS_READ));
      const candidateCount = rows[0]?.candidate_count ?? 0;
      const mapped = rows.slice(0, q.limit).map(row => ({
        raw: row,
        entry: {
          id: row.id, direction: row.direction, untrustedContent: row.untrusted, at: new Date(row.at).toISOString(), status: row.status, from: { name: row.from_name, address: row.from_address },
          to: (row.to ?? []).map(String), toCount: Math.max((row.to ?? []).length, row.to_count ?? 0), subject: listedSubject(a, row).subject, stream: row.stream, campaignId: row.campaign_id, scheduledAt: row.scheduled_at && new Date(row.scheduled_at).toISOString(), simulated: row.simulated, attachmentCount: row.attachment_count,
          threadId: row.thread_count == null ? null : row.thread_id, threadCount: row.thread_count ?? null, addresses: row.addresses, region: row.region, envelopeTo: row.envelope_to, envelopeToCount: row.envelope_to === null ? null : Math.max(row.envelope_to.length, row.envelope_to_count ?? 0),
        },
      }));
      const fitted = fitPageByBytes(mapped, candidateCount > mapped.length, PAGE_MAX_BYTES, 512);
      const last = fitted.hasMore ? fitted.items[fitted.items.length - 1]?.raw : undefined;
      return c.json({
        data: fitted.items.map(x => x.entry),
        nextCursor: last ? Buffer.from(JSON.stringify([last.at, last.direction, last.id, binding])).toString('base64url') : null,
        received,
        ...counts && { counts },
      }, 200);
    }, { route: 'logs.list', workspaceId: a.workspaceId }) as never;
  });
}
