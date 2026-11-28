import type { GetMetricDataCommandInput, MetricDataResult } from '@aws-sdk/client-cloudwatch';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool as PgPool, PoolClient, QueryResultRow } from 'pg';
import { sql, type SQL, type Assume } from 'drizzle-orm';
import { assertSharedAccount } from './core/ses.js';
import { databaseCodeOf } from './core/errors.js';
import { log } from './log.js';
import type { Runtime, Database, DbExecutor } from './core/types.js';
import { WRITE_LIMITS } from './health-counters.js';
import type { Finding } from './health.js';
import { regionLabels } from './region-labels.js';
import { placesRow, withOpen, type Places } from './signups.js';

const counts = {
  Tenant: { kind: 'ses-tenants', label: 'tenants', ask: 'SES tenant count', warn: .70, critical: .85 },
  EmailIdentity: { kind: 'ses-identities', label: 'identities', ask: 'SES email identity count', warn: .60, critical: .80 },
  ConfigurationSet: { kind: 'ses-configuration-sets', label: 'configuration sets', ask: 'SES configuration set count', warn: .70, critical: .85 },
} as const;
type Resource = keyof typeof counts;
const resources = Object.keys(counts) as Resource[];
const MIN = 60_000, repoLimit = 10_000, metricAge = 90 * MIN;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
type Pool = { region: string; account: string };
// Both the sampler row and the last rollup are JSON persisted by other versions.
const at = z.number().min(0).max(8.64e15), count = z.int().nonnegative();
const point = z.object({ at: at.refine(t => t <= Date.now()), used: count, limit: z.int().positive(), source: z.enum(['AWS','repository']) });
const pointsSchema = z.object({ Tenant: point.optional(), EmailIdentity: point.optional(), ConfigurationSet: point.optional() });
type Points = z.infer<typeof pointsSchema>;
// Read only the resources and fields this version understands; one bad point costs only its own reading.
function readPoints(raw: Points | null | undefined, previous?: Points): Points {
  const valid = { ...previous };
  for (const resource of resources) {
    const parsed = point.safeParse(raw?.[resource]);
    if (parsed.success && !superseded(parsed.data.at, parsed.data.used, valid[resource])) valid[resource] = parsed.data;
  }
  return valid;
}
function superseded(at: number, used: number, last: z.infer<typeof point> | undefined) {
  return last && (at < last.at || (at === last.at && used < last.used));
}
type Reader = (pool: Pool, query: GetMetricDataCommandInput, signal: AbortSignal) => Promise<MetricDataResult[]>;
type HealthRuntime = Pick<Runtime, 'config' | 'db'>;
const pools = sql`SELECT region,aws_account_id AS account FROM provider_pool_regions WHERE sending_state='ready' ORDER BY region`;
const healthBudgetMs = 1500;
class HealthDeadline extends Error {}
function remaining(deadline: number) {
  const ms = Math.floor(deadline - performance.now());
  if (ms < 1) throw new HealthDeadline();
  return ms;
}
// The sampler elects, releases the transaction for the network call, then persists its result.
function probes(db: Database) {
  async function run<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T | null> {
    try {
      return await db.transaction(async tx => { await tx.execute(WRITE_LIMITS); return work(tx); });
    } catch { return null; }
  }
  return { run, first: <T extends Record<string, unknown>>(query: SQL) => run(async tx => (await tx.execute<T>(query)).rows[0] ?? null) };
}

function metricQuery(now: number, withQuota: boolean): GetMetricDataCommandInput {
  return { StartTime: new Date(now - metricAge), EndTime: new Date(now), ScanBy: 'TimestampDescending',
    MetricDataQueries: resources.flatMap(resource => {
      const id = resource.toLowerCase();
      return [{ Id: id, MetricStat: { Metric: { Namespace: 'AWS/Usage', MetricName: 'ResourceCount',
        Dimensions: Object.entries({ Service: 'SES', Type: 'Resource', Class: 'None', Resource: resource }).map(([Name, Value]) => ({ Name, Value })) },
        Stat: 'Maximum', Period: 300 } }, ...(withQuota ? [{ Id: id + 'quota', Expression: `SERVICE_QUOTA(${id})` }] : [])];
    }) };
}
function latest(rows: MetricDataResult[], id: string, now: number, min: number) {
  const series = rows.find(row => row.Id === id);
  if (series?.StatusCode !== 'Complete') return;
  for (const [i, stamp] of (series.Timestamps ?? []).entries()) {
    const at = stamp.getTime(), value = series.Values?.[i];
    if (at <= now && at >= now - metricAge && value !== undefined && Number.isSafeInteger(value) && value >= min) return { at, value };
  }
}
function cloudwatch(runtime: Runtime): Reader {
  return async (pool, query, signal) => {
    assertSharedAccount(runtime, { kind: 'shared', aws_account_id: pool.account });
    if (!runtime.config.aws) throw new Error('No platform credentials');
    const [{ CloudWatchClient, GetMetricDataCommand }, { FetchHttpHandler }] = await Promise.all([import('@aws-sdk/client-cloudwatch'), import('@smithy/fetch-http-handler')]);
    const client = new CloudWatchClient({ region: pool.region, credentials: runtime.config.aws, maxAttempts: 1,
      ignoreConfiguredEndpointUrls: true, requestHandler: new FetchHttpHandler({ requestTimeout: 4000 }) });
    try { return (await client.send(new GetMetricDataCommand(query), { abortSignal: signal })).MetricDataResults ?? []; }
    finally { client.destroy(); }
  };
}
// Never log exception messages, response bodies or AWS-supplied diagnostic text.
function awsFailure(error: unknown, timedOut: boolean) {
  const e = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } } | null;
  const name = [e?.Code, e?.code, e?.name].find(n => typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(n));
  const status = e?.$metadata?.httpStatusCode;
  return { cause: timedOut || name === 'TimeoutError' || name === 'AbortError' ? 'Timeout' : name ?? 'UnknownError',
    httpStatus: Number.isInteger(status) ? status : null };
}
function seriesProblem(row?: MetricDataResult) {
  if (!row) return 'Missing';
  if (row.StatusCode !== 'Complete') return ['PartialData','InternalError','Forbidden'].includes(row.StatusCode ?? '') ? row.StatusCode! : 'UnknownStatus';
  return row.Values?.length ? 'Complete:no-usable-point' : 'Complete:empty';
}
/** The election bounds both calls and diagnostic lines to two per region per 15 minutes.
 * Neither attempt holds a transaction; the two attempts share the five-second network allowance. */
export async function sampleSesCounts(runtime: Runtime, read = cloudwatch(runtime), timeoutMs = 5000) {
  if (!runtime.config.multiTenant || !runtime.config.liveEnabled) return;
  const db = probes(runtime.db);
  const active = await db.run(async tx => (await tx.execute<Pool>(pools)).rows);
  for (const pool of active ?? []) {
    const { account, region } = pool;
    const claim = await db.first<{ fence: string; last_good: Points }>(sql`INSERT INTO ses_quota_samples AS s(account,region,attempted_at)
      VALUES (${account},${region},clock_timestamp()) ON CONFLICT(account,region) DO UPDATE SET attempted_at=excluded.attempted_at
      WHERE s.attempted_at<=now()-interval '15 minutes' RETURNING attempted_at::text AS fence,last_good`);
    if (!claim) continue;
    const points: Points = {}, lastGood = readPoints(claim.last_good);
    for (const withQuota of [true,false]) {
      const batch = withQuota ? 'usage+quota' : 'usage';
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs/2)));
      const fields = { code: 'SES_QUOTA_READ_FAILED', region, batch };
      try {
        const rows = await Promise.race([read(pool, metricQuery(Date.now(), withQuota), signal),
          new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
        const now = Date.now(), series: Record<string,string> = {};
        for (const resource of resources) {
          const id = resource.toLowerCase(), usage = latest(rows, id, now, 0), quota = withQuota && latest(rows, id+'quota', now, 1);
          if (withQuota && !quota) series[id+'quota'] = seriesProblem(rows.find(r => r.Id===id+'quota'));
          if (!usage) series[id] = seriesProblem(rows.find(r => r.Id===id));
          else if (superseded(usage.at, usage.value, lastGood[resource])) series[id] = 'Complete:older-than-last-good';
          else points[resource] = { used: usage.value, at: usage.at, limit: quota ? quota.value : repoLimit, source: quota ? 'AWS' : 'repository' };
        }
        if (Object.entries(series).some(([id, status]) => !id.endsWith('quota') || status !== 'Missing')) log('warn', { ...fields, cause: 'UnreadableSeries', series });
        // Some expression errors are returned as failed series in an HTTP 200.
        if (Object.keys(points).length || !rows.some(r => r.StatusCode==='InternalError' || r.StatusCode==='Forbidden')) break;
      } catch (error) {
        log('warn', { ...fields, ...awsFailure(error, signal.aborted) });
      }
    }
    await db.run(tx => tx.execute(sql`UPDATE ses_quota_samples SET finished_at=attempted_at,
      latest=${JSON.stringify(points)}::jsonb,last_good=(CASE WHEN jsonb_typeof(last_good)='object' THEN last_good ELSE '{}'::jsonb END) || ${JSON.stringify(points)}::jsonb
      WHERE account=${account} AND region=${region} AND attempted_at=${claim.fence}::timestamptz`));
  }
}

const quotaSchema = z.object({ at, daily: z.number().nullable(), used: z.number().nullable(), rate: z.number().nullable() });
type Quota = z.infer<typeof quotaSchema>;
// 'waiting' in an older rollup counted any deferral. Never use it as evidence of a long wait.
const minuteSchema = z.object({ at, recipients: count, limit: z.number().positive(), throttled: count, longWaits: count.optional() });
type Minute = z.infer<typeof minuteSchema>;
const setupSchema = z.object({ n: count, age: z.number().nullable(), throttled: z.boolean().nullable() });
type Setup = z.infer<typeof setupSchema>;
const regionMemory = z.object({ good: pointsSchema, cache: quotaSchema.optional(), minutes: z.array(minuteSchema).max(10),
  lastRate: minuteSchema.optional(), setup: z.object({ at, reading: setupSchema }).optional(), places: z.object({ at, open: count }).optional() });
type RegionMemory = z.infer<typeof regionMemory>;
export type SesMemory = Record<string, RegionMemory>;
type Result = { findings: Finding[]; blind: Set<string>; memory: SesMemory; registryUnknown: boolean; failure?: string };
const enabled = (rt: HealthRuntime) => rt.config.multiTenant && rt.config.liveEnabled;
const when = (at: number) => new Date(at).toISOString();

function dbCount(pool: Pool, resource: Resource): SQL {
  const { region, account } = pool;
  switch (resource) {
    case 'Tenant': return sql`SELECT count(*)::int AS n FROM hosted_tenant_ownership WHERE region=${region} AND split_part(arn,':',5)=${account}`;
    case 'EmailIdentity': return sql`SELECT count(*)::int AS n FROM (
      SELECT d.name FROM domain_claims d JOIN domain_sending_bindings b USING(workspace_id,name)
        JOIN provider_connections c ON c.id=b.connection_id WHERE c.kind='shared' AND c.aws_account_id=${account}
        AND b.region=${region} AND d.identity IS NOT NULL AND NOT d.identity ? 'builtin'
      UNION SELECT name FROM builtin_parent WHERE ${region}='us-east-2' AND ses IS NOT NULL
      UNION SELECT name FROM hosted_adoptions WHERE split_part(arn,':',4)=${region} AND split_part(arn,':',5)=${account}) identities`;
    case 'ConfigurationSet': return sql`SELECT greatest(CASE WHEN sending_state='ready' THEN 2 ELSE 0 END,
      (SELECT count(DISTINCT j->>'resource') FROM jsonb_array_elements(ownership_journal) j WHERE j->>'kind'='set' AND j->>'state'='created'))::int AS n
      FROM provider_pool_regions WHERE region=${region} AND aws_account_id=${account}`;
  }
}
// Use the topic pinned at dispatch, not the workspace's current connection. Count one completed minute,
// once per elected Health tick, rather than repeatedly scanning ten minutes of mail or diffing rolling totals.
function throughput(pool: Pool, at: number) {
  return sql`SELECT coalesce(sum(jsonb_array_length(e.to_addresses||e.cc_addresses||e.bcc_addresses)) FILTER (WHERE v.type='accepted'),0)::int AS recipients,
    count(*) FILTER (WHERE v.type='provider_throttled' AND v.data->>'code'='SES_THROTTLED')::int AS throttled,
    count(*) FILTER (WHERE v.type='dispatch_deferred' AND v.data->>'code'='PACING_WAIT' AND e.campaign_id IS NULL AND e.snapshot->>'kind'='transactional'
      AND EXISTS (SELECT FROM sending_email_events start WHERE start.workspace_id=v.workspace_id AND start.email_id=v.email_id
        AND start.type='dispatch_attempt' AND start.external_id=replace(v.external_id,'attempt-result:','attempt-start:')
        AND start.created_at < v.created_at-interval '5 seconds'))::int AS "longWaits"
    FROM sending_email_events v JOIN sending_emails e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    WHERE v.created_at>=${when(at)}::timestamptz AND v.created_at<${when(at+MIN)}::timestamptz AND NOT v.simulated
      AND v.type IN ('accepted','provider_throttled','dispatch_deferred') AND e.region=${pool.region}
      AND e.feedback_topic_arn IN (SELECT topic_arn FROM provider_feedback_history WHERE kind='shared' AND region=${pool.region} AND aws_account_id=${pool.account})`;
}
function setup(pool: Pool) {
  return sql`WITH due AS (SELECT j.workspace_id,j.last_error,CASE WHEN j.status='running' THEN j.lease_until ELSE j.available_at END AS due
    FROM jobs j JOIN provider_connections c ON c.workspace_id=j.workspace_id AND c.kind='shared' AND c.aws_account_id=${pool.account}
    WHERE (j.status='pending' AND j.available_at<=now() OR j.status='running' AND j.lease_until<=now())
      AND (j.type='tenant.provision' AND c.id=j.payload->>'connectionId' AND c.region=${pool.region} AND c.tenant_state<>'ready'
        OR j.type='domain.builtin' AND ${pool.region}='us-east-2' AND EXISTS (SELECT FROM builtin_domains b LEFT JOIN domain_claims d ON d.name=b.name
          WHERE b.workspace_id=j.workspace_id AND b.revoked_at IS NULL AND d.sending_state IS DISTINCT FROM 'verified')))
    SELECT count(DISTINCT workspace_id)::int AS n,extract(epoch FROM now()-min(due))::int AS age,
    bool_or(last_error ~* 'throttl|too.?many.?requests') AS throttled FROM due`;
}

// Resolve optional relations before composing the batched SELECT. A missing table must cost only
// the sources that need it; referring to it even in an untaken CASE would abort the transaction.
const tables = {
  stored: ['ses_quota_samples'], cache: ['provider_account_limits'],
  traffic: ['sending_email_events','sending_emails','provider_feedback_history'],
  jobs: ['jobs','provider_connections','builtin_domains','domain_claims'],
  places: ['nightmail_signup_limit','nightmail_signups','nightmail_waitlist'],
  Tenant: ['hosted_tenant_ownership'], EmailIdentity: ['domain_claims','domain_sending_bindings','provider_connections','builtin_parent','hosted_adoptions'],
  ConfigurationSet: ['provider_pool_regions'],
};
type Query = <T extends Record<string, unknown>>(statement: SQL) => Promise<Assume<T, QueryResultRow>[]>;
type Readings = Pool & {
  stored: { fresh: boolean; logDue: boolean; latest: Points; last_good: Points } | null;
  cache: Quota | null; traffic: Pick<Minute,'recipients'|'throttled'|'longWaits'> | null;
  jobs: Setup | null; places: Omit<Places,'open'> | null;
};
type SourceLog = Pool & { sources: Record<string,string> };

export async function sesHealth(rt: HealthRuntime, previous: SesMemory = {}): Promise<Result & { ms: number; statements: number }> {
  const empty: Result = { findings: [], blind: new Set(), memory: {}, registryUnknown: false };
  if (!enabled(rt)) return { ...empty, ms: 0, statements: 0 };
  previous = { ...previous }; // Keep any regional resets even if a later probe exhausts the deadline.
  const start = performance.now(), deadline = start + healthBudgetMs;
  const elapsed = () => Math.round(performance.now() - start);
  const pool = (rt.db as Database & { $client?: PgPool }).$client;
  let client: PoolClient | undefined, expired = false, statements = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const logs: SourceLog[] = [];
  const checkTime = () => {
    if (expired) throw new HealthDeadline();
    return remaining(deadline);
  };
  const executor = (tx: DbExecutor): Query => async <T extends Record<string, unknown>>(statement: SQL) => {
    checkTime();
    statements++;
    const { rows } = await tx.execute<T>(statement);
    checkTime();
    return rows;
  };
  const work = async (query: Query) => {
    const ms = String(Math.max(1, remaining(deadline) - 100));
    await query(sql`SELECT set_config('lock_timeout','400',true),set_config('statement_timeout',${ms},true),
      CASE WHEN ${!!client} AND current_setting('transaction_timeout',true) IS NOT NULL
        THEN set_config('transaction_timeout',${ms},true) END`);
    return collect(query, previous, logs);
  };
  // Health has a single pooled connection in the Worker. Bound checkout, SQL and COMMIT,
  // and destroy a failed or overdue transaction instead of queuing a rollback on a stalled socket.
  let committed = false;
  let disconnected!: (error: Error) => void;
  const transaction = async () => {
    if (!pool || !('totalCount' in pool)) { // Caller already owns a connection/transaction.
      statements += 2;
      return rt.db.transaction(tx => work(executor(tx)));
    }
    const acquired = await pool.connect();
    if (expired) { acquired.release(); throw new HealthDeadline(); }
    client = acquired;
    client.on('error', disconnected);
    const query = executor(drizzle(client));
    await query(sql`BEGIN`);
    const result = await work(query);
    await query(sql`COMMIT`);
    committed = true;
    return result;
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      disconnected = reject;
      timer = setTimeout(() => { expired = true; reject(new HealthDeadline()); }, healthBudgetMs);
    });
    const result = await Promise.race([transaction(), timeout]);
    remaining(deadline);
    const ms = elapsed();
    for (const { region, sources } of logs) log('info', { code: 'SES_QUOTA_SOURCES', region, sources, ms, statements });
    return { ...result, ms, statements };
  } catch (error) {
    const code = databaseCodeOf(error);
    const timedOut = error instanceof HealthDeadline || code==='55P03' || code==='57014' || code==='25P04';
    return { ...empty, memory: previous, registryUnknown: true, ms: elapsed(), statements,
      failure: timedOut ? 'Deadline' : error instanceof z.ZodError ? 'InvalidData' : 'ReadError',
      findings: [{ key: 'ses-unread:section', kind: 'ses-unread', severity: 'warning', value: 1,
        words: 'SES capacity could not be read. Previous SES findings are being kept.', remindMinutes: 60 }] };
  } finally {
    expired = true;
    clearTimeout(timer);
    client?.removeListener('error', disconnected);
    client?.release(!committed);
  }
}
async function collect(query: Query, previous: SesMemory, logs: SourceLog[]): Promise<Result> {
  const result: Result = { findings: [], blind: new Set(), memory: {}, registryUnknown: false };
  const relations = [...new Set(Object.values(tables).flat())];
  const active = await query<Pool & {missing: string[]}>(sql`SELECT p.*,
    ARRAY(SELECT name FROM unnest(${sql.param(relations)}::text[]) name WHERE to_regclass(name) IS NULL) AS missing FROM (${pools}) p`);
  if (!active.length) return result;
  const missing = new Set(active[0]!.missing);
  const available = (source: keyof typeof tables) => tables[source].every(table => !missing.has(table));
  const row = (source: keyof typeof tables, statement: SQL) =>
    available(source) ? sql`(SELECT row_to_json(r) FROM (${statement}) r)` : sql`NULL::json`;
  const now = Date.now(), minute = Math.floor(now/MIN)*MIN-MIN;
  const reads = active.map(pool => {
    const { region, account } = pool, key = account + ':' + region;
    const parsed = regionMemory.optional().safeParse(previous[key]);
    if (!parsed.success) {
      delete previous[key];
      log('warn', { code: 'SES_HEALTH_MEMORY_RESET', region });
    } else if (parsed.data) previous[key] = parsed.data;
    return sql`SELECT ${region}::text AS region, ${account}::text AS account,
      ${row('stored',sql`SELECT finished_at>=now()-interval '17 minutes' AND (finished_at=attempted_at OR attempted_at>now()-interval '8 seconds') AS fresh,
        logged_day IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date AND finished_at=attempted_at AS "logDue", latest,last_good
        FROM ses_quota_samples WHERE account=${account} AND region=${region}`)} AS stored,
      ${row('cache',sql`SELECT extract(epoch FROM checked_at)::float8*1000 AS at,max_24_hour_send AS daily,sent_last_24_hours AS used,max_send_rate AS rate
        FROM provider_account_limits WHERE aws_account_id=${account} AND region=${region} AND isfinite(checked_at)`)} AS cache,
      ${row('traffic',throughput(pool,minute))} AS traffic, ${row('jobs',setup(pool))} AS jobs,
      ${region==='us-east-2' ? row('places',placesRow) : sql`NULL::json`} AS places`;
  });
  const readings = await query<Readings>(sql.join(reads,sql` UNION ALL `));
  const due: SourceLog[] = [];
  for (const pool of readings) {
    const { region, account, stored, cache, traffic, jobs } = pool, place = regionLabels[region] ?? region, key = account + ':' + region;
    // Empty memory is not recovery: a blind resource keeps its open critical; a fresh high AWS point reports it again.
    const prior = previous[key], places = pool.places && withOpen(pool.places);
    const add = (kind: Finding['kind'], severity: Finding['severity'], value: number, words: string, subject = region) =>
      result.findings.push({ key: kind + ':' + subject, kind, severity, value, words,
        remindMinutes: kind==='ses-signup-places' || resources.some(r=>counts[r].kind===kind) ? 1440 : 60 });
    const unknown = (kind: Finding['kind'], words: string) => {
      result.blind.add(kind + ':' + region);
      add('ses-unread', 'warning', 1, words, region + ':' + kind);
    };
    const latest = readPoints(stored?.latest), good = readPoints(stored?.last_good, prior?.good);
    const unread = resources.filter(resource => {
      const point = latest[resource];
      return !stored?.fresh || !point || point.at>now || now-point.at > metricAge || superseded(point.at, point.used, good[resource]);
    });
    // No inventory-table scans on the normal AWS path. Batch only the estimates actually needed.
    const estimates = unread.filter(available).map(resource => sql`SELECT ${resource}::text AS resource, n FROM (${dbCount(pool,resource)}) e`);
    const estimated = new Map(estimates.length ? (await query<{resource: Resource; n: number}>(sql.join(estimates,sql` UNION ALL `))).map(e => [e.resource,e.n]) : []);
    if (cache) quotaSchema.parse(cache);
    const mem: RegionMemory = { good, cache: cache ?? prior?.cache,
      lastRate: prior?.lastRate, setup: jobs ? { at: now, reading: jobs } : prior?.setup,
      places: places ? { at: now, open: places.open } : prior?.places, minutes: (prior?.minutes ?? []).filter(m => m.at > minute-10*MIN && m.at < minute) };
    result.memory[key] = mem;
    const sources: Record<string,string> = {};
    let tenantsLeft: number | undefined;
    for (const resource of resources) {
      const { kind, label, ask, warn, critical } = counts[resource], point = latest[resource];
      if (!point || unread.includes(resource)) {
        const last = mem.good[resource], estimate = estimated.get(resource);
        const limit = last?.limit ?? repoLimit;
        unknown(kind, `${place}'s SES ${label} could not be read.${last ? ` Last AWS count: ${fmt(last.used)} at ${when(last.at)}.` : ''} ${estimate !== undefined ? `Nightmail's own count: ${fmt(estimate)}${resource === 'ConfigurationSet' ? ' (sets expected or journaled for the pool)' : ''}.` : "Nightmail's own count could not be read."}`);
        if (estimate === undefined) result.blind.add(kind + ':' + region + ':estimate');
        else if (estimate/limit >= warn) add(kind, 'warning', estimate/limit,
          `Nightmail's own count in ${place} is ${fmt(estimate)} SES ${label} (${fmt(100*estimate/limit)}% of the ${fmt(limit)} ${last?.source === 'AWS' ? 'last AWS' : 'repository'} limit); an estimated ${fmt(Math.max(0,limit-estimate))} remain. AWS usage could not be read. Check the regional ${ask} before raising it.`, region + ':estimate');
        sources[resource] = estimate !== undefined ? 'database estimate; AWS unreadable' : 'unreadable';
        continue;
      }
      good[resource] = point;
      sources[resource] = 'CloudWatch usage / ' + point.source + ' limit';
      const share = point.used/point.limit, left = Math.max(0, point.limit-point.used);
      if (resource === 'Tenant') tenantsLeft = left;
      if (share >= warn) add(kind, share >= critical ? 'critical' : 'warning', share,
        `${place} has ${fmt(point.used)} of ${fmt(point.limit)} SES ${label} (${fmt(100*share)}%); ${fmt(left)} remain. Request a higher ${ask} in ${place}.${point.source === 'repository' ? ' The limit is from the repository.' : ''}`);
    }
    if (region === 'us-east-2') {
      if (!places || tenantsLeft === undefined) result.blind.add('ses-signup-places:' + region);
      if (!places) unknown('ses-signup-places', `Ohio’s open sign-up places could not be read.${mem.places ? ` Last count: ${fmt(mem.places.open)} at ${when(mem.places.at)}.` : ''}`);
      if (places && tenantsLeft !== undefined && places.open+places.held > tenantsLeft) add('ses-signup-places', 'warning', places.open+places.held-tenantsLeft,
        `${fmt(places.open)} sign-up places are open${places.held ? ` and ${fmt(places.held)} ${places.held===1?'is':'are'} held` : ''} but Ohio has room for ${fmt(tenantsLeft)} more SES tenants. Raise the SES tenant count before these places fill, or lower the sign-up limit.`);
    }
    const current = cache && cache.at<=now && now-cache.at<=10*MIN ? cache : null;
    sources.daily = 'dispatcher quota cache';
    sources.rateLimit = current?.rate && Number.isFinite(current.rate) && current.rate > 0 ? 'dispatcher quota cache' : 'unreadable';
    const last = mem.cache, stamp = last ? ` (last observed ${when(last.at)})` : '';
    if (!current || current.used === null || !Number.isFinite(current.used) || current.used < 0 || current.daily === null || !Number.isFinite(current.daily) || !(current.daily === -1 || current.daily > 0)) {
      sources.daily = 'unreadable';
      unknown('ses-daily', `${place}'s SES daily allowance could not be read${stamp}.`);
    } else if (current.daily > 0 && current.used/current.daily >= .70) {
      const share = current.used/current.daily;
      add('ses-daily', share >= .85 ? 'critical' : 'warning', share, `SES accepted ${fmt(current.used)} of ${fmt(current.daily)} recipients in the last 24 hours in ${place} (${fmt(100*share)}%); ${fmt(Math.max(0,current.daily-current.used))} remain. Pace large campaigns or request a higher SES 24-hour sending quota.`);
    }
    sources.rate = traffic ? 'Nightmail dispatch events' : 'unreadable';
    if (!traffic || !current?.rate || !Number.isFinite(current.rate) || current.rate<=0) {
      const last = mem.lastRate;
      unknown('ses-rate', `${place}'s SES sending rate could not be read.${last ? ` Last completed minute: ${fmt(last.recipients/60)} recipients/s at ${when(last.at)}.` : ''}`);
    }
    else {
      mem.lastRate = { at: minute, limit: current.rate, ...traffic };
      mem.minutes.push(mem.lastRate);
      const share = Math.min(...mem.minutes.map(m => m.recipients/60/m.limit));
      if (new Set(mem.minutes.map(m=>m.at)).size===10 && mem.minutes.every(m=>m.at%MIN===0) && share>=.8) {
        const impacted = mem.minutes.filter(m => m.throttled>0 || (m.longWaits ?? 0)>0).length;
        const critical = share>=.95 && impacted>=5, rate = traffic.recipients/60;
        add('ses-rate', critical ? 'critical' : 'warning', share, `Nightmail used at least ${fmt(100*share)}% of ${place}'s SES sending rate for 10 minutes. Last minute: ${fmt(rate)} of ${fmt(current.rate)} recipients/s; ${fmt(Math.max(0,current.rate-rate))}/s remain.${critical ? ` In ${impacted} of 10 minutes SES throttled sends or eligible transactional mail waited more than 5 seconds for pacing.` : ''} Request a higher SES sending rate if this continues.`);
      } else if (share>=.8 && mem.minutes.length<10) result.blind.add('ses-rate:' + region);
    }
    sources.setup = jobs ? 'runnable setup jobs' : 'unreadable';
    if (!jobs) unknown('ses-setup', `${place}'s SES setup wait could not be read.${mem.setup ? ` Last count: ${fmt(mem.setup.reading.n)} waiting at ${when(mem.setup.at)}.` : ''}`);
    else if (jobs.age !== null && jobs.age>=120 && (jobs.n>1 || jobs.throttled)) add('ses-setup', jobs.age>=300 ? 'critical' : 'warning',jobs.age,
      `A workspace has waited ${fmt(Math.floor(jobs.age/60))} minutes for SES setup in ${place}; ${fmt(jobs.n)} ${jobs.n===1?'workspace is':'workspaces are'} waiting. Check setup retries and slow the sign-up release if the queue keeps growing.`);
    if (region === 'us-east-2') sources.signup = places && tenantsLeft !== undefined ? 'sign-up gate and tenant reading' : 'unreadable';
    if (stored?.logDue) due.push({ region, account, sources });
  }
  // Claim all due regions in one write. Emit their lines only after the whole transaction commits.
  if (due.length) {
    const claimed = await query<Pool>(sql`UPDATE ses_quota_samples SET logged_day=(now() AT TIME ZONE 'UTC')::date
      WHERE (account,region) IN (${sql.join(due.map(p => sql`(${p.account},${p.region})`),sql`,`)})
      AND logged_day IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date AND finished_at=attempted_at RETURNING account,region`);
    logs.push(...due.filter(p => claimed.some(c => c.region===p.region && c.account===p.account)));
  }
  return result;
}
