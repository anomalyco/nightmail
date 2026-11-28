import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors } from './core/errors.js';
import { log } from './log.js';
import { response } from './core/http.js';
import type { App, DbExecutor, Runtime } from './core/types.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { poolSends } from './states.js';
import { emailAccepted, emailBounced, emailDelivered } from './email-outcomes.js';

const PublicStats = z.object({
  generatedAt: z.string().describe('The end of the last whole UTC hour the figures cover. They change at most once an hour; responses are cached for up to 60 seconds.'),
  available: z.boolean().describe('False until at least 10 workspaces have sent mail in the last 30 days. Every figure is then null and regions is empty, so the figures never describe a single customer.'),
  acceptedLast30Days: z.number().int().nullable().describe('Emails Amazon SES accepted in the last 30 whole days of hours, rounded to two significant figures (to the nearest 10 below 100). Simulated, suppressed and rejected mail is excluded. Email history is kept for 30 days, so there is no all-time total.'),
  acceptedLastHour: z.number().int().nullable().describe('Emails Amazon SES accepted in the last whole UTC hour, rounded the same way. The last entry of acceptedHourly.'),
  acceptedHourly: z.array(z.number().int().nullable()).describe('Accepted emails per whole UTC hour over the last 24 hours, oldest first, rounded. Null for an hour in which fewer than 3 workspaces sent.'),
  deliveryRate: z.number().nullable().describe('delivered ÷ (delivered + bounced) for emails created in the last 30 days, each email counted once, to three decimals. Null without outcomes.'),
  medianSendLatencyMs: z.number().int().nullable().describe('Median time from API acceptance to Amazon SES acceptance for the most recent 5,000 direct, unscheduled sends in the last 24 whole hours, to the nearest 10 ms. Null without samples from at least 3 workspaces.'),
  regions: z.array(z.string()).describe('AWS regions that accepted mail in the last 30 days. Hosted installations list only their shared sending regions.'),
}).openapi('PublicStats');
export type PublicStats = z.infer<typeof PublicStats>;

/** Each refresh recomputes the minutes created this recently; anything that settles later is caught a day on. */
const TRAILING_MINUTES = 15;
const DAY_MINUTES = 1440, MONTH_MINUTES = 30 * DAY_MINUTES;
/**
 * Privacy floor: nothing is published until this many workspaces sent in the 30-day window, and a figure covering
 * less (one hour, the latency sample) needs `hourWorkspaces` of them. Buckets keep at most `workspaces` IDs per
 * minute, which is enough to tell whether a window reached either threshold.
 */
export const PUBLIC_STATS_PRIVACY = { workspaces: 10, hourWorkspaces: 3, round: true };
type Privacy = typeof PUBLIC_STATS_PRIVACY;

/** Two significant figures, and the nearest 10 below 100: coarse enough that one send never shows. */
const coarse = (n: number) => n < 100 ? Math.round(n / 10) * 10 : (() => { const step = 10 ** (Math.floor(Math.log10(n)) - 1); return Math.round(n / step) * step; })();

// Scheduled, queued and attempting mail has no outcome yet; leaving it out still matches the partial index sending_emails_retire (created_at).
const settled = sql`NOT e.simulated AND e.status NOT IN ('scheduled','queued','attempting')`;
// The same "accepted" evidence as GET /v1/metrics: a provider ID, an accepted-or-later status, or the accepted outcome bit.
const accepted = emailAccepted();
// A hosted installation counts only mail sent through its shared pool, never a BYO tenant's own account (as hosted_real_envelopes).
const hostedMail = (multiTenant: boolean) => multiTenant ? sql`((e.feedback_topic_arn IS NULL AND EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id = e.workspace_id AND pc.kind = 'shared'))
  OR EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn = e.feedback_topic_arn AND h.kind = 'shared'))` : sql`true`;

/**
 * Public figures are materialized, never computed for a request: the minute cron (publicStatsTick) keeps one bucket
 * per creation minute in public_stats_minutes and writes the response to public_stats, which the route reads. A
 * failed refresh leaves the last good row in place. The figures come from public_stats_hours, which triggers keep equal
 * to the hour's minute buckets (migration 382), so a refresh reads 720 hours rather than 43,200 minutes. Each refresh
 * reads only bounded ranges of sending_emails:
 *  - the last 15 minutes, every refresh (mail settles within seconds to minutes);
 *  - a minute once more when it is a day old (scheduled sends, backlogs and late outcomes), then never again;
 *  - minutes with no bucket yet (first run, or the cron was down), newest first, sized to the time budget.
 * The published figures cover whole UTC hours, are rounded, and follow PUBLIC_STATS_PRIVACY. No statement returns a
 * workspace, address, subject or per-workspace figure. `asOf` lets acceptance tests evaluate fixture data at a fixed
 * instant; the cron always uses now().
 */
export async function refreshPublicStats(db: Pick<DbExecutor, 'execute'>, multiTenant: boolean, options: { asOf?: string; budgetMs?: number; privacy?: Privacy } = {}): Promise<PublicStats> {
  const deadline = Date.now() + (options.budgetMs ?? 10_000), privacy = options.privacy ?? PUBLIC_STATS_PRIVACY;
  const at = options.asOf ? sql`${options.asOf}::timestamptz` : sql`now()`, ref = sql`date_trunc('minute', ${at}, 'UTC')`, hour = sql`date_trunc('hour', ${at}, 'UTC')`;
  const minutes = (n: number) => sql`(${ref} - ${`${n} minutes`}::interval)`, oldest = sql`(${hour} - interval '30 days')`;
  // Recomputes whole minutes in [from, to): absent minutes get zero buckets, so "no bucket" always means "not computed".
  const compute = (from: SQL, to: SQL) => db.execute(sql`
    INSERT INTO public_stats_minutes AS b (minute, accepted, delivered, bounced, regions, workspaces, computed_at)
    SELECT m.minute, coalesce(c.accepted, 0), coalesce(c.delivered, 0), coalesce(c.bounced, 0), coalesce(c.regions, '{}'), coalesce(c.workspaces, '{}'), ${at}
    FROM generate_series(${from}, ${to} - interval '1 minute', interval '1 minute') AS m(minute)
    LEFT JOIN (
      SELECT date_trunc('minute', e.created_at, 'UTC') AS minute, count(*) FILTER (WHERE ${accepted})::int AS accepted,
        count(*) FILTER (WHERE ${emailDelivered()})::int AS delivered,
        count(*) FILTER (WHERE ${emailBounced()})::int AS bounced,
        array_agg(DISTINCT e.region) FILTER (WHERE ${accepted}) AS regions,
        (array_agg(DISTINCT e.workspace_id) FILTER (WHERE ${accepted}))[1:${privacy.workspaces}] AS workspaces
      FROM sending_emails e
      WHERE e.created_at >= ${from} AND e.created_at < ${to} AND e.created_at <= ${at} AND ${settled} AND ${hostedMail(multiTenant)}
      GROUP BY 1
    ) c ON c.minute = m.minute
    ON CONFLICT (minute) DO UPDATE SET accepted = excluded.accepted, delivered = excluded.delivered, bounced = excluded.bounced,
      regions = excluded.regions, workspaces = excluded.workspaces, computed_at = excluded.computed_at`);
  await db.execute(sql`DELETE FROM public_stats_minutes WHERE minute < ${oldest}`);
  await compute(minutes(TRAILING_MINUTES), sql`${ref} + interval '1 minute'`);
  // A minute is final once computed a day after it ended. Each refresh finalizes the minutes that have become old enough
  // since the last one, an hour at a time (normally just one minute). A recompute now makes them final, so this ends.
  // The condition is public_stats_minutes_due's predicate, written the same way so the search reads that index.
  const dayOld = minutes(DAY_MINUTES + 1);
  while (Date.now() < deadline) {
    const [due] = (await db.execute<{ start: string | null }>(sql`SELECT min(minute)::text AS start FROM public_stats_minutes
      WHERE minute >= ${oldest} AND minute <= ${dayOld} AND computed_at - minute < interval '1 day 1 minute'`)).rows;
    if (!due?.start) break;
    await compute(sql`${due.start}::timestamptz`, sql`least(${due.start}::timestamptz + interval '1 hour', ${dayOld} + interval '1 minute')`);
  }
  // Missing minutes, newest first. The span doubles while chunks are quick and halves when one is slow, so a quiet
  // installation fills 30 days in a few statements and a busy one in time-bounded steps over several minutes.
  // Normally nothing is missing: the whole hours' bucket counts and the buckets since say so without probing each minute.
  const upTo = minutes(TRAILING_MINUTES + 1), upToHour = sql`date_trunc('hour', ${upTo}, 'UTC')`;
  const complete = async () => (await db.execute<{ complete: boolean }>(sql`SELECT
      (SELECT coalesce(sum(minutes), 0) FROM public_stats_hours WHERE hour >= ${oldest} AND hour < ${upToHour})
      + (SELECT count(*) FROM public_stats_minutes WHERE minute >= ${upToHour} AND minute <= ${upTo})
      > extract(epoch FROM ${upTo} - ${oldest})::int / 60 AS complete`)).rows[0]?.complete;
  for (let span = 60; Date.now() < deadline && !(await complete());) {
    const [gap] = (await db.execute<{ newest: string | null }>(sql`SELECT max(m)::text AS newest
      FROM generate_series(${oldest}, ${upTo}, interval '1 minute') AS m
      WHERE NOT EXISTS (SELECT FROM public_stats_minutes b WHERE b.minute = m)`)).rows;
    if (!gap?.newest) break;
    const started = Date.now();
    await compute(sql`greatest(${gap.newest}::timestamptz - ${`${span - 1} minutes`}::interval, ${oldest})`, sql`${gap.newest}::timestamptz + interval '1 minute'`);
    const elapsed = Date.now() - started;
    span = elapsed < 1000 ? Math.min(span * 2, MONTH_MINUTES) : elapsed > 4000 ? Math.max(span / 2, TRAILING_MINUTES) : span;
  }
  const regional = multiTenant ? sql`r IN (SELECT p.region FROM provider_pool_regions p WHERE ${poolSends()})` : sql`true`;
  // Whole hours back from the last complete one: 0 is the hour that just ended. An hour's workspaces are distinct.
  const ago = sql`(extract(epoch FROM ${hour} - hour) / 3600)::int - 1`;
  type Hour = { n: number; w: number };
  const [row] = (await db.execute<{ accepted: string; delivered: string; bounced: string; workspaces: number; hourly: Record<string, Hour>; regions: string[]; through: string }>(sql`
    WITH b AS (SELECT * FROM public_stats_hours WHERE hour >= ${oldest} AND hour < ${hour})
    SELECT coalesce(sum(accepted), 0)::bigint AS accepted, coalesce(sum(delivered), 0)::bigint AS delivered, coalesce(sum(bounced), 0)::bigint AS bounced,
      (SELECT count(DISTINCT w)::int FROM b, unnest(b.workspaces) AS w) AS workspaces,
      (SELECT coalesce(jsonb_object_agg(${ago}, jsonb_build_object('n', accepted, 'w', cardinality(workspaces))), '{}'::jsonb) FROM b WHERE hour >= ${hour} - interval '24 hours') AS hourly,
      (SELECT coalesce(jsonb_agg(DISTINCT r ORDER BY r), '[]'::jsonb) FROM b, unnest(b.regions) AS r WHERE ${regional}) AS regions,
      to_char(${hour} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS through
    FROM b`)).rows;
  const r = row!, round = (n: number) => privacy.round ? coarse(n) : n;
  const available = r.workspaces >= privacy.workspaces;
  // Admission (sending_emails.created_at) to the dispatcher's 'accepted' event (sending_email_events.created_at, written
  // when SES returns a MessageId). Campaign mail is paced and scheduled mail waits on purpose, so both are left out.
  // The sample reads mail, so it is taken only when the figures are published.
  const [latency] = available ? (await db.execute<{ ms: number | null; workspaces: number }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.accepted_at - d.created_at) * 1000) AS ms, count(DISTINCT d.workspace_id)::int AS workspaces
    FROM (SELECT e.workspace_id, e.id, e.created_at FROM sending_emails e
      WHERE e.created_at >= ${hour} - interval '24 hours' AND e.created_at < ${hour} AND ${settled} AND ${hostedMail(multiTenant)}
        AND e.campaign_id IS NULL AND (e.scheduled_at IS NULL OR e.dispatch_version > 0)
      ORDER BY e.created_at DESC LIMIT 5000) d
    CROSS JOIN LATERAL (SELECT min(v.created_at) AS accepted_at FROM sending_email_events v
      WHERE v.workspace_id = d.workspace_id AND v.email_id = d.id AND v.type = 'accepted') a
    WHERE a.accepted_at >= d.created_at`)).rows : [];
  const hourly = Array.from({ length: 24 }, (_, index) => r.hourly[String(23 - index)] ?? { n: 0, w: 0 });
  const acceptedHourly = hourly.map(h => available && (h.n === 0 || h.w >= privacy.hourWorkspaces) ? round(h.n) : null);
  const delivered = Number(r.delivered), outcomes = delivered + Number(r.bounced);
  const stats: PublicStats = available ? {
    generatedAt: r.through, available,
    acceptedLast30Days: round(Number(r.accepted)),
    acceptedLastHour: acceptedHourly[23]!,
    acceptedHourly,
    deliveryRate: outcomes > 0 ? (privacy.round ? Math.round(delivered / outcomes * 1000) / 1000 : delivered / outcomes) : null,
    medianSendLatencyMs: latency?.ms == null || latency.workspaces < privacy.hourWorkspaces ? null : privacy.round ? Math.round(Number(latency.ms) / 10) * 10 : Math.round(Number(latency.ms)),
    regions: r.regions,
  } : { generatedAt: r.through, available, acceptedLast30Days: null, acceptedLastHour: null, acceptedHourly: Array(24).fill(null), deliveryRate: null, medianSendLatencyMs: null, regions: [] };
  await db.execute(sql`INSERT INTO public_stats (singleton, stats, generated_at) VALUES (true, ${JSON.stringify(stats)}::jsonb, ${at})
    ON CONFLICT (singleton) DO UPDATE SET stats = excluded.stats, generated_at = excluded.generated_at`);
  return stats;
}

/** The minute cron's refresh. One at a time: a second runner or an overlapping cron skips instead of repeating the work. */
export async function publicStatsTick(runtime: Pick<Runtime, 'db' | 'config'>, budgetMs = 10_000) {
  try {
    await runtime.db.transaction(async tx => {
      if (!(await tx.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275813, 1)`)).rowCount) return;
      await refreshPublicStats(tx, runtime.config.multiTenant, { budgetMs });
    });
  } catch { log('warn', { code: 'PUBLIC_STATS_REFRESH_FAILED', message: 'The last published figures stay in place; the next minute retries.' }); }
}

export function registerPublicStats(app: App) {
  // Whether a new person can sign up now (src/signups.ts): with no place open, the homepage's and the price pages' Get
  // started says Join the waitlist. Only yes or no, never the counts. A self-hosted installation has no limit.
  app.openapi(createRoute({ hide: true, method: 'get', path: '/v1/public/signups', operationId: 'getPublicSignups', tags: ['Metrics'], security: [],
    description: 'Whether a new account can sign up on its own now. Cached for up to 60 seconds.',
    responses: { 200: response(z.object({ open: z.boolean().describe('False while every place under the sign-up limit is taken: a new sign-in joins the waitlist.') })), 429: errors[429]!, 500: errors[500]! } }), async c => {
    const { db, config } = c.env;
    const { value } = config.multiTenant ? await cachedDashboardRead(new URL(config.publicUrl).origin, 'public-signups', async () => {
      const { readPlaces } = await import('./signups.js');
      return { open: (await readPlaces(db)).open > 0 };
    }) : { value: { open: true } };
    c.header('cache-control', 'public, max-age=60');
    return c.json(value, 200);
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/public/stats', operationId: 'getPublicStats', tags: ['Metrics'], security: [],
    description: 'Public, unauthenticated sending figures for the installation. A minute job computes them from stored mail; this route only reads the result, so a request never scans mail. Aggregates over whole UTC hours, rounded, and only once at least 10 workspaces have sent (available); a hosted installation counts only mail sent through its shared pool. No workspace, address or per-workspace figure is returned. Responses are cached for up to 60 seconds. 503 until the figures are first computed.',
    responses: { 200: response(PublicStats), 429: errors[429]!, 500: errors[500]!, 503: errors[503]! } }), async c => {
    const { db, config } = c.env;
    // One cache entry per installation (keyed on its public URL, not the request's host). A miss reads one row.
    const { value, hit } = await cachedDashboardRead(new URL(config.publicUrl).origin, 'public-stats', async () => {
      const [row] = (await db.execute<{ stats: PublicStats }>(sql`SELECT stats FROM public_stats WHERE singleton`)).rows;
      if (!row) throw new ApiError(503, 'PUBLIC_STATS_PENDING', 'Public figures are computed every minute. Try again shortly.', undefined, true);
      return row.stats;
    });
    c.header('x-nightmail-stats-cache', hit ? 'hit' : 'miss');
    return c.json(value, 200);
  });
}
