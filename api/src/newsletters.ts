import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { actor } from './core/access.js';
import { ApiError, errors, notFound } from './core/errors.js';
import { budgetedRead, digest, id, IdParams, isoTime, json, nextCursor, page, PageQuery, readCursor, readLimit, readLimitNote, response, security } from './core/http.js';
import type { Actor, App, DbExecutor, JobHandler, Runtime } from './core/types.js';
import { lists, type StoredNewsletterReaders } from './db/audience.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { mailAddress, senderDisplayName } from './outbound-content.js';

/**
 * A newsletter is a contact list with a sender (audience_lists.newsletter_from, migration 394): its ID and name are the
 * list's, and its issues are the campaigns sent to that list (sending_campaigns.list_id; listCampaigns with listId).
 * There is nothing else to keep in sync: deleting the list deletes the newsletter, and deleting the newsletter leaves
 * the list, its contacts and its campaigns.
 *
 * Readers are the list's members whose contact is not deleted, not suppressed and subscribed, the rule campaign
 * audiences use. A list of at most `exactUpTo` members is counted when read, in one statement; a probe that reads at
 * most `exactUpTo` + 1 entries of the members' primary key decides which. A larger list is read from the count its
 * background job stored (readersJob): one page of `page` members per step, each its own short statement, the sums
 * carried in the job's payload, `runMs` of steps per run and then `pace` times that much idle time (at least
 * `pauseMs`), so a pass uses about 3% of one connection's database time however large the list. A read queues a pass
 * when the stored count is missing or `refreshMs` old. Exported for the tests, which lower them.
 */
export const NEWSLETTER_READERS = { exactUpTo: 10_000, page: 5_000, runMs: 250, pace: 32, pauseMs: 1_000, refreshMs: 3_600_000, days: 182 };
// Each statement of a newsletter read (the probe and the exact count of a small list) stops after this many seconds.
const READ_SECONDS = 3;
const NEWSLETTER_NOTE = 'A newsletter is a contact list with a sender: its ID and name are the list\u2019s, and renaming either renames both. Its issues are ordinary campaigns to that list: create one with createCampaign and audience.listId set to the newsletter\u2019s ID, and list them with listCampaigns listId. There are no separate issue operations.';
const READERS_NOTE = `Readers are the list\u2019s members who are not deleted, not suppressed and subscribed to marketing, as campaign audiences count them. A list of up to ${NEWSLETTER_READERS.exactUpTo.toLocaleString('en-US')} members is counted exactly when read. A larger list is counted in the background, a few minutes per pass, and read from its last count, which is refreshed when read more than an hour after it was taken; readers is null until the first count of a large list.`;

const Name = z.string().trim().min(1).max(200);
const From = mailAddress().describe('The From address of its issues. Its domain need not be verified yet: the sender is checked when an issue is tested or sent.');
const FromName = senderDisplayName();
const ListId = z.string().min(1).max(120);
export const Newsletter = z.object({
  id: z.string().describe('The list\u2019s ID.'), name: z.string().describe('The list\u2019s name.'), from: z.string(), fromName: z.string().nullable(),
  url: z.string().url().describe('Dashboard URL for opening this newsletter.'), createdAt: z.string().describe('When the list was created.'),
}).openapi('Newsletter');
const Readers = z.object({
  count: z.number().int().describe('Readers now (at countedAt).'),
  daily: z.array(z.number().int()).describe(`One number per UTC day for the ${NEWSLETTER_READERS.days} days ending on the day of countedAt, oldest first: how many of these readers joined the list that day.`),
  since: z.string().describe('The first of those days, YYYY-MM-DD.'), countedAt: z.string().describe('When the count was taken; it includes every change made before then.'),
}).openapi('NewsletterReaders');
const NewsletterRead = Newsletter.extend({ readers: Readers.nullable().describe(READERS_NOTE) }).openapi('NewsletterRead');
const CreateInput = z.union([
  z.object({ name: Name.describe('Creates a new list with this name that is a newsletter.'), from: From, fromName: FromName.optional() }).strict(),
  z.object({ listId: ListId.describe('Makes this existing list a newsletter; 409 NEWSLETTER_EXISTS if it already is one.'), from: From, fromName: FromName.optional() }).strict(),
]).openapi('CreateNewsletterInput', { description: 'Exactly one of name (a new list) or listId (an existing list).' }, { unionPreferredType: 'oneOf' });
const UpdateInput = z.object({ name: Name.optional().describe('Renames the list.'), from: From.optional(), fromName: FromName.nullable().optional().describe('null removes it.') }).strict().openapi('UpdateNewsletterInput');
const Deleted = z.object({ id: z.string(), deleted: z.literal(true), listId: z.string().describe('The list, which stays, with its contacts and its campaigns. Delete it with deleteContactList.') })
  .describe('The list is no longer a newsletter. The list, its contacts and its campaigns are unchanged.').openapi('NewsletterDeleted');

const columns = { id: lists.id, name: lists.name, from: lists.newsletterFrom, fromName: lists.newsletterFromName, createdAt: lists.createdAt };
type Row = { id: string; name: string; from: string | null; fromName: string | null; createdAt: string };
const scope = (a: Pick<Actor, 'workspaceId'>, listId?: string) => and(eq(lists.workspaceId, a.workspaceId), listId === undefined ? undefined : eq(lists.id, listId));
function view(runtime: Runtime, row: Row): z.infer<typeof Newsletter> {
  return { id: row.id, name: row.name, from: row.from!, fromName: row.fromName, url: new URL(`/newsletters/${encodeURIComponent(row.id)}`, runtime.config.publicUrl).href, createdAt: isoTime(row.createdAt)! };
}
const binding = async (a: Pick<Actor, 'workspaceId'>) => (await digest(`newsletters:${a.workspaceId}`)).slice(0, 24);

type Pass = { since: string; countedAt: string; cursor: string; members: number; count: number; daily: number[] };
const reader = sql`c.deleted_at IS NULL AND NOT c.suppressed AND c.marketing_consent = 'subscribed'`;
/**
 * The readers among the list's next `limit` members after `cursor` in primary-key order, grouped by the UTC day each
 * joined counted from `since` (-1: before it; the last day also takes anyone who joined after it began), with the last
 * member read, for the next page. Each member's contact is one lookup of its primary key (walkingTheKey says why it is
 * LATERAL), checked against the workspace after.
 */
async function readersPage(db: DbExecutor, workspaceId: string, listId: string, since: string, cursor: string, limit: number) {
  const { rows: [row] } = await db.execute<{ last: string | null; members: number; days: [number, number][] }>(sql`WITH page AS MATERIALIZED (
      SELECT m.contact_id, m.created_at FROM audience_list_members m
      WHERE m.workspace_id = ${workspaceId} AND m.list_id = ${listId} AND m.contact_id > ${cursor} ORDER BY m.contact_id LIMIT ${limit})
    SELECT (SELECT max(contact_id) FROM page) AS last, (SELECT count(*)::int FROM page) AS members,
      coalesce((SELECT jsonb_agg(jsonb_build_array(day, n)) FROM (
        SELECT least(${NEWSLETTER_READERS.days - 1}::int, greatest(-1, (p.created_at AT TIME ZONE 'UTC')::date - ${since}::date)) AS day, count(*)::int AS n
        FROM page p CROSS JOIN LATERAL (SELECT c.workspace_id, c.deleted_at, c.suppressed, c.marketing_consent FROM audience_contacts c WHERE c.id = p.contact_id LIMIT 1) c
        WHERE c.workspace_id = ${workspaceId} AND ${reader} GROUP BY 1) d), '[]'::jsonb) AS days`);
  return row!;
}
/**
 * The probe and the page walk the members' primary key in order, which reads the same number of entries whatever the
 * list's size. With statistics taken while a list was small (an import that outran autovacuum's analyze), the planner
 * expects a few thousand members and prefers a bitmap scan of every one of them and a sort instead: 0.5 s and all
 * 2,000,000 members read for one probe at PostgreSQL's default random_page_cost, and a background page that rereads the
 * rest of the list each time (measured; the plan flipped at estimates of 191 to 14,617 rows). With bitmap and sequential
 * scans off, the primary key is the plan left. Contact statistics taken while the workspace had few contacts flip the
 * join the same way: to a merge or hash join that reads the workspace's contacts instead of looking up each member's
 * (0.8 s and 1,000,000 contacts read for an exact count of 10,000, half of them for a page in the middle of the list), or,
 * with those joins off, to a nested loop driven from the contacts that compares each with every member of the page
 * (0.5 s for 12,000; measured). Hash and merge joins are off here too, but what makes the join certain is readersPage's
 * LATERAL lookup, whose LIMIT keeps it from being flattened into a join the planner could turn around: each member's
 * contact is one lookup of the contacts' primary key, as fast as the join with current statistics (measured). Only
 * `work` runs with these settings: they are local to the caller's transaction and go back to their defaults after it.
 */
async function walkingTheKey<T>(db: DbExecutor, work: () => Promise<T>) {
  await db.execute(sql`SELECT set_config('enable_bitmapscan', 'off', true), set_config('enable_seqscan', 'off', true), set_config('enable_hashjoin', 'off', true), set_config('enable_mergejoin', 'off', true)`);
  const result = await work();
  await db.execute(sql`SELECT set_config(name, reset_val, true) FROM pg_settings WHERE name IN ('enable_bitmapscan', 'enable_seqscan', 'enable_hashjoin', 'enable_mergejoin')`);
  return result;
}
function addPage(pass: Pass, page: Awaited<ReturnType<typeof readersPage>>): Pass {
  const daily = [...pass.daily];
  let count = pass.count;
  for (const [day, n] of page.days) { count += n; if (day >= 0) daily[day]! += n; }
  return { ...pass, cursor: page.last ?? pass.cursor, members: pass.members + page.members, count, daily };
}
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const readersView = (r: Pick<Pass, 'count' | 'daily' | 'since' | 'countedAt'>) => ({ count: r.count, daily: r.daily, since: r.since, countedAt: r.countedAt });
const readersJobId = (listId: string) => `newsletter-readers:${listId}`;
/** Starts the list's background count now, unless one is already waiting or running (one job row per list). */
const queueReaders = (workspaceId: string, listId: string, eligible?: SQL) => {
  const values = sql`${readersJobId(listId)},'audience.newsletterReaders',${workspaceId},${JSON.stringify({ listId })}::jsonb,now()`;
  return sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at)
    ${eligible ? sql`SELECT ${values} WHERE ${eligible}` : sql`VALUES (${values})`}
    ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL
    WHERE jobs.status IN ('completed','failed')`;
};
const readersDue = (stored: StoredNewsletterReaders | null) => !stored || Date.now() - Date.parse(stored.countedAt) >= NEWSLETTER_READERS.refreshMs;

/**
 * A large newsletter's background count: pages of its members by primary key, each its own short read-only transaction
 * (for walkingTheKey's settings), the running sums in the job's payload between runs, stored on the list when the pass
 * ends. A count is taken over minutes, so members who join or leave while it runs may or may not be in it.
 */
const readersJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (typeof payload.listId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A newsletter count needs its list.');
  const listId = payload.listId, workspaceId = job.workspaceId, started = Date.now();
  const [list] = await runtime.db.select({ from: lists.newsletterFrom }).from(lists).where(scope({ workspaceId }, listId)).limit(1);
  // Deleted, or no longer a newsletter: nothing to count.
  if (!list?.from) return;
  let pass = payload.pass as Pass | undefined;
  if (!pass) {
    // The database's clock, as countedAt and the day the count's days end on.
    const { rows: [clock] } = await runtime.db.execute<{ at: string; since: string }>(sql`SELECT to_json(clock_timestamp())#>>'{}' AS at, ((clock_timestamp() AT TIME ZONE 'UTC')::date - ${NEWSLETTER_READERS.days - 1}::int)::text AS since`);
    pass = { since: clock!.since, countedAt: new Date(clock!.at).toISOString(), cursor: '', members: 0, count: 0, daily: Array<number>(NEWSLETTER_READERS.days).fill(0) };
  }
  let done = false;
  for (;;) {
    const { since, cursor } = pass;
    const page = await runtime.db.transaction(tx => walkingTheKey(tx, () => readersPage(tx, workspaceId, listId, since, cursor, NEWSLETTER_READERS.page)), { accessMode: 'read only' });
    pass = addPage(pass, page);
    if (page.members < NEWSLETTER_READERS.page) { done = true; break; }
    if (Date.now() - started >= NEWSLETTER_READERS.runMs) break;
  }
  // This run's database time, paid back as idle time before the next run.
  if (!done) throw new JobDeferred(new Date(Date.now() + Math.max(NEWSLETTER_READERS.pauseMs, NEWSLETTER_READERS.pace * (Date.now() - started))).toISOString(), { listId, pass });
  const stored: StoredNewsletterReaders = { count: pass.count, since: pass.since, daily: pass.daily, countedAt: pass.countedAt, members: pass.members };
  await runtime.db.execute(sql`UPDATE audience_lists SET newsletter_readers = ${JSON.stringify(stored)}::jsonb WHERE workspace_id = ${workspaceId} AND id = ${listId} AND newsletter_from IS NOT NULL`);
});
export const newsletterJobs: Record<string, JobHandler> = { 'audience.newsletterReaders': readersJob };

export function registerNewsletters(app: App) {
  const tags = ['Newsletters'];
  app.openapi(createRoute({ method: 'get', path: '/v1/newsletters', operationId: 'listNewsletters', tags, security, description: `The workspace's newsletters, oldest first, without reader counts (getNewsletter has them). ${NEWSLETTER_NOTE}`, request: { query: PageQuery }, responses: { 200: response(page(Newsletter)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), bound = await binding(a), cursor = readCursor(q.cursor, bound);
    const rows = await c.env.db.select(columns).from(lists).where(and(scope(a), isNotNull(lists.newsletterFrom),
      cursor ? sql`(${lists.createdAt}, ${lists.id}) > (${cursor.at}::timestamptz, ${cursor.id})` : undefined)).orderBy(asc(lists.createdAt), asc(lists.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(row => view(c.env, row)), nextCursor: nextCursor(rows, q.limit, bound) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/newsletters', operationId: 'createNewsletter', tags, security, description: `Creates a new list that is a newsletter (name), or makes an existing list one (listId). ${NEWSLETTER_NOTE}`, request: { body: json(CreateInput) }, responses: { 201: response(Newsletter), ...errors } }), async c => {
    const a = actor(c, 'manage'), input = c.req.valid('json'), fromName = input.fromName ?? null;
    if ('name' in input) {
      const [row] = await c.env.db.insert(lists).values({ id: id('lst'), workspaceId: a.workspaceId, name: input.name, newsletterFrom: input.from, newsletterFromName: fromName }).returning(columns);
      return c.json(view(c.env, row!), 201);
    }
    const db = c.env.db, target = scope(a, input.listId);
    // Start the reader count only if this request converted the list, and commit both writes together.
    const { rows: [row] } = await db.execute<Row>(sql`WITH converted AS (
      UPDATE ${lists} SET newsletter_from = ${input.from}, newsletter_from_name = ${fromName}, updated_at = ${new Date().toISOString()}
      WHERE ${and(target, isNull(lists.newsletterFrom))}
      RETURNING id, name, newsletter_from AS "from", newsletter_from_name AS "fromName", created_at::text AS "createdAt"
    ), queued AS (${queueReaders(a.workspaceId, input.listId, sql`EXISTS (SELECT 1 FROM converted)`)})
    SELECT * FROM converted`);
    if (!row) {
      const [list] = await db.select({ id: lists.id }).from(lists).where(target).limit(1);
      if (list) throw new ApiError(409, 'NEWSLETTER_EXISTS', 'This list is already a newsletter. Change its sender with updateNewsletter.', 'listId');
      notFound('List');
    }
    return c.json(view(c.env, row), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/newsletters/{id}', operationId: 'getNewsletter', tags, security, description: `The newsletter with its readers. ${READERS_NOTE} ${readLimitNote(READ_SECONDS)}`, request: { params: IdParams }, responses: { 200: response(NewsletterRead), ...errors } }), async c => {
    const a = actor(c), listId = c.req.valid('param').id;
    const { row, readers, due } = await budgetedRead(c.env.db, async db => {
      const [row] = await db.select({ ...columns, stored: lists.newsletterReaders }).from(lists).where(and(scope(a, listId), isNotNull(lists.newsletterFrom))).limit(1);
      if (!row) return notFound('Newsletter');
      return walkingTheKey(db, async () => {
        // At most exactUpTo + 1 entries of the members' primary key, whatever the list's size. The ORDER BY keeps it on
        // that index: without it, a list that is most of the table plans as a sequential scan of the members' heap.
        const large = !!(await db.execute(sql`SELECT 1 FROM audience_list_members WHERE workspace_id = ${a.workspaceId} AND list_id = ${listId} ORDER BY contact_id OFFSET ${NEWSLETTER_READERS.exactUpTo} LIMIT 1`)).rows.length;
        if (large) return { row, readers: row.stored, due: readersDue(row.stored) };
        const now = Date.now(), since = utcDay(now - (NEWSLETTER_READERS.days - 1) * 86_400_000);
        const readers = addPage({ since, countedAt: new Date(now).toISOString(), cursor: '', members: 0, count: 0, daily: Array<number>(NEWSLETTER_READERS.days).fill(0) },
          await readersPage(db, a.workspaceId, listId, since, '', NEWSLETTER_READERS.exactUpTo + 1));
        return { row, readers, due: false };
      });
    }, readLimit(READ_SECONDS));
    // Outside the read: a large list's count is refreshed in the background, and this read answers from the last one.
    if (due) await c.env.db.execute(queueReaders(a.workspaceId, listId));
    return c.json({ ...view(c.env, row), readers: readers ? readersView(readers) : null }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/newsletters/{id}', operationId: 'updateNewsletter', tags, security, description: `Changes the newsletter's name (the list's name), its From address or sender name. ${NEWSLETTER_NOTE}`, request: { params: IdParams, body: json(UpdateInput) }, responses: { 200: response(Newsletter), ...errors } }), async c => {
    const a = actor(c, 'manage'), input = c.req.valid('json');
    const [row] = await c.env.db.update(lists).set({ ...(input.name === undefined ? {} : { name: input.name }), ...(input.from === undefined ? {} : { newsletterFrom: input.from }),
      ...(input.fromName === undefined ? {} : { newsletterFromName: input.fromName }), updatedAt: new Date().toISOString() })
      .where(and(scope(a, c.req.valid('param').id), isNotNull(lists.newsletterFrom))).returning(columns);
    return c.json(view(c.env, row ?? notFound('Newsletter')), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/newsletters/{id}', operationId: 'deleteNewsletter', tags, security, description: 'The list stops being a newsletter. The list, its contacts and its campaigns stay as they are: this deletes nothing else. To delete the list itself, use deleteContactList.', request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const a = actor(c, 'manage'), listId = c.req.valid('param').id;
    const [row] = await c.env.db.update(lists).set({ newsletterFrom: null, newsletterFromName: null, newsletterReaders: null, updatedAt: new Date().toISOString() })
      .where(and(scope(a, listId), isNotNull(lists.newsletterFrom))).returning({ id: lists.id });
    if (!row) notFound('Newsletter');
    return c.json({ id: listId, deleted: true as const, listId }, 200);
  });
}