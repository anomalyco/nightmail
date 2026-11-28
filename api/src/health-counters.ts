import { sql } from 'drizzle-orm';
import { log, onErrorLine } from './log.js';
import { REQUESTS } from './health-thresholds.js';
import type { Database } from './core/types.js';

// Request counters for the health tick (src/health.ts): every request adds to a map in this process, and every
// FLUSH_MS the map is written to health_minutes in one statement, after a response (Workers) or on a timer (Node). So
// a request costs no query, a p95 by route exists without a log search, and what a process had not flushed when it was
// recycled (20 seconds of counts at most) is lost, which a rollup can afford.
//
// Kinds: 'route' (method and route template, with a latency histogram), 'read' (a workspace's GET and HEAD requests,
// to tell one client's storm), 'code' (the error code of a 5xx), 'status' (requests except operator board polls by status class,
// with a latency histogram: Glass's API figures), 'sqlstate' (database errors, from requests and jobs) and 'error'
// (error-level log lines by code, outside request lines: src/log.ts onErrorLine). Keys are route
// templates, workspace IDs and codes: never a path, an address or anything a request carried.

/** Upper bounds of the latency buckets in ms; the last bucket is everything slower. */
export const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, REQUESTS.verySlowMs] as const;
const FLUSH_MS = 20_000, KEYS = 500;
const OPERATOR_POLLS = new Set(['/v1/operator/glass', '/v1/operator/glass/activity', '/v1/operator/health']);
/** What every health write runs under, transaction-local: a second for a lock, three for the statement. Then it is dropped. */
export const WRITE_LIMITS = sql`SELECT set_config('lock_timeout','1000',true),set_config('statement_timeout','3000',true)`;
type Counter = { n: number; errors: number; ms: number; slowest: number; hist?: number[] };
let pending = new Map<string, Counter>(), flushAfter = Date.now() + FLUSH_MS, flushing = false;

function add(kind: string, key: string, errors = 0, ms?: number) {
  // A process counts at most KEYS things between flushes; the rest share one row per kind, so a flood of distinct
  // keys can neither grow the map nor the table.
  const id = pending.size < KEYS || pending.has(`${kind}\n${key}`) ? `${kind}\n${key}` : `${kind}\nother`;
  let counter = pending.get(id);
  if (!counter) pending.set(id, counter = { n: 0, errors: 0, ms: 0, slowest: 0, ...(ms === undefined ? {} : { hist: Array<number>(LATENCY_BUCKETS.length + 1).fill(0) }) });
  counter.n++; counter.errors += errors;
  if (ms === undefined || !counter.hist) return;
  const whole = Math.max(0, Math.round(ms)), bucket = LATENCY_BUCKETS.findIndex(bound => whole <= bound);
  counter.ms += whole; counter.slowest = Math.max(counter.slowest, whole);
  counter.hist[bucket < 0 ? LATENCY_BUCKETS.length : bucket]!++;
}
/** One request, as its request line describes it (app.ts logRequest). */
export function countRequest(r: { route: string; method: string; status: number; durationMs: number; workspace?: string; code?: string; databaseCode?: string }) {
  const failed = r.status >= 500 ? 1 : 0;
  add('route', `${r.method} ${r.route}`, failed, r.durationMs);
  if (!OPERATOR_POLLS.has(r.route)) add('status', `${Math.min(5, Math.max(1, Math.floor(r.status / 100)))}xx`, failed, r.durationMs);
  if (r.workspace && (r.method === 'GET' || r.method === 'HEAD')) add('read', r.workspace);
  if (failed) add('code', r.code ?? 'UNKNOWN_ERROR');
  if (r.databaseCode) add('sqlstate', r.databaseCode);
}
onErrorLine(code => add('error', code));
/** A database error outside a request: a job's, or the health tick's own. */
export const countDatabaseError = (sqlstate: string | undefined) => { if (sqlstate) add('sqlstate', sqlstate); };
/** Whether there is something to write and the last write is FLUSH_MS old. */
export const countersDue = () => pending.size > 0 && !flushing && Date.now() >= flushAfter;

/**
 * Writes this process's counters and starts over. One statement in a transaction of its own that waits at most a
 * second for a lock and runs at most three (WRITE_LIMITS); rows are written in key order, so two processes flushing
 * the same minute never deadlock. It never throws and never retries: a flush that is refused, locked out or too slow is
 * dropped, and the next one waits a minute, so a database in trouble is not asked more often because it is in trouble.
 * Nothing on a request, a queue batch, the cron's own steps or a dispatcher awaits it (worker.ts, dispatcher-do.ts).
 */
export async function flushCounters(db: Pick<Database, 'transaction'>) {
  if (flushing || !pending.size) return 0;
  const batch = pending;
  pending = new Map(); flushing = true; flushAfter = Date.now() + FLUSH_MS;
  // A client that asked less than once a second in this window is not a storm: it is not written.
  const rows = [...batch].map(([id, c]) => { const [kind, key] = id.split('\n') as [string, string]; return { kind, key, ...c }; })
    .filter(row => row.kind !== 'read' || row.n >= REQUESTS.clientFlush);
  try {
    if (rows.length) await db.transaction(async tx => { await tx.execute(WRITE_LIMITS); await tx.execute(sql`INSERT INTO health_minutes AS m (minute,kind,key,n,errors,ms,slowest,hist)
      SELECT date_trunc('minute',now()),r.kind,r.key,r.n,r.errors,r.ms,r.slowest,CASE WHEN r.hist IS NOT NULL THEN ARRAY(SELECT jsonb_array_elements_text(r.hist)::int) END
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r(kind text,key text,n int,errors int,ms bigint,slowest int,hist jsonb) ORDER BY r.kind,r.key
      ON CONFLICT (minute,kind,key) DO UPDATE SET n=m.n+excluded.n,errors=m.errors+excluded.errors,ms=m.ms+excluded.ms,slowest=greatest(m.slowest,excluded.slowest),
        hist=CASE WHEN m.hist IS NULL THEN excluded.hist WHEN excluded.hist IS NULL THEN m.hist ELSE ARRAY(SELECT a+b FROM unnest(m.hist,excluded.hist) WITH ORDINALITY u(a,b,i) ORDER BY i) END`); });
    return rows.length;
  } catch {
    flushAfter = Date.now() + 60_000;
    log('warn', { code: 'HEALTH_COUNTERS_DROPPED', rows: rows.length });
    return 0;
  } finally { flushing = false; }
}
/** For tests: forget what was counted. */
export const resetCounters = () => { pending = new Map(); flushAfter = Date.now() + FLUSH_MS; };
