import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import { digest } from './core/http.js';
import { log } from './log.js';
import type { Runtime } from './core/types.js';
import { analyticsStore, ANALYTICS_ROOT } from './analytics-traffic.js';
import type { AnalyticsRow } from './analytics.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
export const partition = (ms: number) => 'dt=' + iso(ms).slice(0,10) + '/h=' + iso(ms).slice(11,13);
const milestones = new Set(['signed_up','domain_verified','first_send']);
// Anyone can post, and most dimensions are free-form (referrer host, UTM tags, path slugs, click targets): bound an hour's
// rows, visitor codes and memory. Past a metric's group limit the rest of its events fold into one overflow group.
export const ROLLUP_LIMITS = { events: 250_000, groups: 1_000, visitors: 50_000 } as const;
const OVERFLOW: Dimensions = { overflow: 'true' };
type Dimensions = Record<string, string | null>;
type Group = { metric: string; dimensions: Dimensions; events: number; ids: Set<string> };

/** Reread every compacted part for this hour: interrupted deletes and late batches may produce overlapping parts. */
export async function rollupHour(runtime: Runtime, ms: number) {
  const hour = iso(ms), prefix = ANALYTICS_ROOT + 'events/' + partition(ms) + '/', store = analyticsStore(runtime);
  // Optimistic compare-and-swap: no Postgres connection is held while we read object storage.
  const previous = (await runtime.db.execute<{ snapshot: string }>(sql`SELECT snapshot FROM analytics_hours WHERE hour=${hour}`)).rows[0]?.snapshot;
  const keys: string[] = [];
  let cursor: string | undefined;
  do { const page = await store.list!(prefix,cursor); keys.push(...page.objects.map(o => o.key)); cursor = page.cursor; } while (cursor);
  const snapshot = await digest(keys.join('\n'));
  if (snapshot === previous) return;
  const groups = new Map<string,Group>(), seen = new Set<string>(), first = new Map<string,{workspace:string; step:string}>(), perMetric = new Map<string,number>();
  function count(metric: string, dimensions: Dimensions, vid?: string | null) {
    let key = JSON.stringify([metric, dimensions]), group = groups.get(key);
    if (!group) {
      const n = perMetric.get(metric) ?? 0;
      if (n >= ROLLUP_LIMITS.groups) { dimensions = OVERFLOW; key = JSON.stringify([metric, dimensions]); group = groups.get(key); }
      else perMetric.set(metric, n + 1);
    }
    group ??= { metric, dimensions, events: 0, ids: new Set<string>() };
    groups.set(key, group); group.events++;
    if (vid && group.ids.size < ROLLUP_LIMITS.visitors) group.ids.add(vid);
  }
  let truncated = false;
  for (const key of keys) {
    if (truncated) break;
    const object = await store.get(key);
    if (!object) throw new Error('Compacted analytics object missing');
    const body = await new Response(new Blob([object.body as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    for (const line of body.trimEnd().split('\n')) {
      const row = JSON.parse(line) as AnalyticsRow;
      if (seen.has(row.id)) continue;
      if (seen.size >= ROLLUP_LIMITS.events) { truncated = true; break; }
      seen.add(row.id);
      if (row.type === 'bot_view') count('bot_view', { path: row.route });
      if (row.type === 'page_view') {
        count('page_view', { path: row.route, referrer: row.referrer ?? null, source: row.source ?? null, medium: row.medium ?? null,
          campaign: row.campaign ?? null, country: row.country ?? null, device: row.device ?? null, viewport: row.vp }, row.vid);
        count('visit', {}, row.vid);
      }
      if (row.type === 'click' && (row.public || row.name) && row.target) count('cta', { path: row.route, target: row.target }, row.vid);
      if (row.type === 'track' && row.ws && row.step && milestones.has(row.step)) first.set(row.ws + ':' + row.step,{ workspace:row.ws, step:row.step });
      if (row.type === 'track' && row.step === 'focus_chosen' && row.name) count('focus', { focus: row.name }, row.vid);
      if (row.type === 'track' && row.step === 'onboarding' && row.name) count('onboarding', { step: row.name }, row.vid);
    }
  }
  if (truncated) log('warn', { code: 'ANALYTICS_ROLLUP_TRUNCATED', hour, events: seen.size });
  const values = Array.from(groups.values(),g => ({ metric:g.metric, dimensions:g.dimensions, events:g.events, ids:[...g.ids].sort() }));
  await runtime.db.transaction(async tx => {
    // Serialize just the small SQL commit of milestone moves across hours; simultaneous folds cannot miss a correction.
    if (first.size) await tx.execute(sql`SELECT pg_advisory_xact_lock(420364,1)`);
    const due = runtime.config.analyticsPush ? sql`'-infinity'::timestamptz` : sql`NULL::timestamptz`;
    const write = await tx.execute(sql`INSERT INTO analytics_hours(hour,snapshot,push_after) VALUES(${hour},${snapshot},${due})
      ON CONFLICT (hour) DO UPDATE SET snapshot=excluded.snapshot, revision=analytics_hours.revision+1, attempts=0, push_after=excluded.push_after
      WHERE analytics_hours.snapshot=${previous ?? null}`);
    if (!write.rowCount) throw new Error('Concurrent analytics rollup; retry');
    await tx.execute(sql`DELETE FROM analytics_hourly WHERE hour=${hour}`);
    if (values.length) await tx.execute(sql`INSERT INTO analytics_hourly(hour,metric,dimensions,events,visitor_ids)
      SELECT ${hour}, metric, dimensions, events, ids FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS r(metric text,dimensions jsonb,events int,ids text[])`);
    if (first.size) {
      // Moving a first observation earlier corrects both hours, including an already delivered hour. Only workspaces that
      // exist: a forged batch can name any well-formed ID.
      const data = JSON.stringify([...first.values()]);
      const real = sql`SELECT n.* FROM jsonb_to_recordset(${data}::jsonb) AS n(workspace text,step text) WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id=n.workspace)`;
      await tx.execute(sql`UPDATE analytics_hours SET revision=revision+1,push_after=${due},attempts=0 WHERE hour IN
        (SELECT f.hour FROM analytics_funnel_first f JOIN (${real}) n USING(workspace,step) WHERE f.hour>${hour})`);
      await tx.execute(sql`INSERT INTO analytics_funnel_first(workspace,step,hour)
        SELECT workspace,step,${hour} FROM (${real}) n ORDER BY workspace,step
        ON CONFLICT(workspace,step) DO UPDATE SET hour=excluded.hour WHERE excluded.hour<analytics_funnel_first.hour`);
    }
  });
}

export function exportRange(from: string | undefined, to: string | undefined, grain = 'hour') {
  const parse = (s?: string) => s && /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z)?$/.test(s) ? Date.parse(s) : NaN;
  const a = parse(from), b = parse(to), unit = grain === 'day' ? DAY : HOUR;
  if (!['hour','day'].includes(grain) || !Number.isFinite(a+b) || a%unit || b%unit || b<=a || b-a>31*DAY)
    throw new ApiError(422,'VALIDATION_FAILED','Use UTC grain-aligned from and to bounds, at most 31 days apart, and grain hour or day.');
  return { from:iso(a), to:iso(b), grain };
}
export async function exportRollups(runtime: Runtime, range: ReturnType<typeof exportRange>) {
  const { from,to,grain } = range;
  // Count events before unnesting IDs: hourly uniques aren't additive across a day.
  const { rows } = await runtime.db.execute<{ bucket:Date; metric:string; dimensions:Dimensions; events:number; visitors:number|null }>(sql`
    WITH base AS (SELECT date_trunc(${grain},hour,'UTC') AS bucket,metric,dimensions,events,visitor_ids FROM analytics_hourly WHERE hour>=${from} AND hour<${to}),
    counts AS (SELECT bucket,metric,dimensions,sum(events)::int AS events FROM base GROUP BY 1,2,3),
    uniques AS (SELECT bucket,metric,dimensions,count(DISTINCT id)::int AS visitors FROM base,LATERAL unnest(visitor_ids) AS id GROUP BY 1,2,3)
    SELECT c.*, CASE WHEN metric='bot_view' THEN NULL ELSE coalesce(visitors,0) END AS visitors FROM counts c LEFT JOIN uniques USING(bucket,metric,dimensions)
    UNION ALL SELECT date_trunc(${grain},hour,'UTC'), step, '{}'::jsonb,count(*)::int,NULL::int FROM analytics_funnel_first
      WHERE hour>=${from} AND hour<${to} GROUP BY 1,2 ORDER BY 1,2,3`);
  return { v:1, ...range, rows:rows.map(r => ({ ...r, bucket:new Date(r.bucket).toISOString() })) };
}
export async function pushDue(runtime: Runtime, now: number) {
  const push = runtime.config.analyticsPush;
  if (!push) return;
  for (let i=0;i<24;i++) {
    const { rows:[job] } = await runtime.db.execute<{hour:Date;revision:number;attempts:number}>(sql`UPDATE analytics_hours SET attempts=attempts+1,push_after=${iso(now+300_000)}
      WHERE hour=(SELECT hour FROM analytics_hours WHERE push_after<=${iso(now)} ORDER BY push_after,hour LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING hour,revision,attempts`);
    if (!job) break;
    const ms = new Date(job.hour).getTime(), hour=iso(ms);
    let ok = false;
    try {
      const data = await exportRollups(runtime,{grain:'hour',from:hour,to:iso(ms+HOUR)});
      const body = JSON.stringify({ ...data, revision:job.revision }), timestamp=String(Math.floor(Date.now()/1000));
      const signature = createHmac('sha256',push.secret).update(timestamp+'.'+body).digest('hex');
      // Workers refuse redirect:'error'; 'manual' never follows, and a 3xx is not ok, so it retries.
      const response = await fetch(push.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
        headers:{'content-type':'application/json','x-nightmail-timestamp':timestamp,'x-nightmail-signature':'sha256='+signature},body});
      ok=response.ok; await response.body?.cancel();
    } catch { /* Retry the hour from the durable queue. Never log the destination, body or secret. */ }
    const next = ok ? null : iso(now+Math.min(24,2**Math.min(job.attempts-1,5))*HOUR);
    await runtime.db.execute(sql`UPDATE analytics_hours SET push_after=${next} WHERE hour=${hour} AND revision=${job.revision} AND attempts=${job.attempts}`);
    if (!ok) log('warn',{code:'ANALYTICS_PUSH_RETRY',hour,attempt:job.attempts});
  }
}
