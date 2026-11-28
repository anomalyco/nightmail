import { sql } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import { chargeBudget, digest } from './core/http.js';
import type { Ctx, Runtime } from './core/types.js';
import { headerPrefix, requestHeader } from './brand.js';
import { talliesEnabled } from './sending-tallies.js';

const TTL_SECONDS = 60;
/** Expensive Overview reads (Metrics, Sender score, Usage) one dashboard session may compute in a minute. */
export const DASHBOARD_RECOMPUTES_PER_MINUTE = 30;
/** Above this many emails in the current UTC hour, Overview cache keys quantize to DASHBOARD_ACTIVE_BUCKET_SECONDS instead of invalidating on every email. */
export const DASHBOARD_ACTIVE_SEND_HOUR_THRESHOLD = 500;
export const DASHBOARD_ACTIVE_BUCKET_SECONDS = 10;
/** How the three cached Overview reads behave for dashboard sessions, in their OpenAPI descriptions. */
export const DASHBOARD_CACHE_NOTE = `Dashboard sessions may receive a cached result until the workspace creates an email or records an email event (quantized to ${DASHBOARD_ACTIVE_BUCKET_SECONDS}-second buckets during high-volume sending), or for up to 60 seconds, and compute at most ${DASHBOARD_RECOMPUTES_PER_MINUTE} such Overview reads a minute: past that they get their last result (cache header stale) or 429 DASHBOARD_RATE_LIMITED. API keys, MCP and agent tokens always get fresh results.`;

// The newest email and the newest email event in a workspace, as one revision: used by background counts and
// interactive Overview reads. Only email events count (data ? 'emailId', the partial index operation_events_email_metrics):
// contact, consent and other workspace events change none of these figures. One statement, two index probes.
export async function mailRevision(runtime: Pick<Runtime, 'db'>, workspaceId: string): Promise<string> {
  const { rows: [row] } = await runtime.db.execute<{ emails: string | null; events: string | null }>(sql`SELECT
    (SELECT max(created_at) FROM sending_emails WHERE workspace_id = ${workspaceId})::text AS emails,
    (SELECT max(created_at) FROM operation_events WHERE workspace_id = ${workspaceId} AND data ? 'emailId')::text AS events`);
  return `${row?.emails ?? ''}/${row?.events ?? ''}`;
}

/**
 * Revision for dashboard Overview reads (Metrics, Sender score, Usage; never Pause, Cancel or campaign state).
 * Interactive senders (< 500 emails in the current UTC hour) keep exact per-email invalidation so a test email shows
 * on the next read; active high-volume sends quantize to 10-second buckets so polling never busts the cache every second
 * or exhausts DASHBOARD_RECOMPUTES_PER_MINUTE.
 */
export async function dashboardRevision(runtime: Pick<Runtime, 'db'>, workspaceId: string): Promise<string> {
  if (await talliesEnabled(runtime.db)) {
    const { rows: [row] } = await runtime.db.execute<{ hour_emails: string; emails: string | null; events: string | null }>(sql`SELECT
      coalesce((SELECT sum(emails) FROM sending_metrics_hourly WHERE workspace_id = ${workspaceId} AND hour = date_trunc('hour', now(), 'UTC')), 0)::text AS hour_emails,
      (SELECT max(created_at) FROM sending_emails WHERE workspace_id = ${workspaceId})::text AS emails,
      (SELECT max(created_at) FROM operation_events WHERE workspace_id = ${workspaceId} AND data ? 'emailId')::text AS events`);
    if (Number(row?.hour_emails ?? 0) >= DASHBOARD_ACTIVE_SEND_HOUR_THRESHOLD) {
      return `bucket:${Math.floor(Date.now() / (DASHBOARD_ACTIVE_BUCKET_SECONDS * 1000))}`;
    }
    return `${row?.emails ?? ''}/${row?.events ?? ''}`;
  }
  return mailRevision(runtime, workspaceId);
}

/**
 * A dashboard session's Overview read: cached per scope until the workspace's mail changes (or every 10 seconds during
 * high-volume sending), or for 60 seconds. Each session computes at most DASHBOARD_RECOMPUTES_PER_MINUTE of them a
 * minute; past that it gets the last result for the scope, marked stale, or a 429 when there is none, so neither fresh
 * mail nor new scopes turn reads into repeated scans. The scope must name everything the result depends on.
 */
export async function dashboardRead<T>(c: Ctx, scope: string, compute: () => Promise<T>): Promise<{ value: T; cache: 'hit' | 'miss' | 'stale' }> {
  const a = c.get('actor');
  const result = await cachedDashboardRead(new URL(c.req.url).origin, scope, compute, TTL_SECONDS, {
    revision: await dashboardRevision(c.env, a.workspaceId),
    admit: () => chargeBudget(c.env, a.workspaceId, `dashboard-reads:${a.keyId}`, DASHBOARD_RECOMPUTES_PER_MINUTE),
    refuse: () => {
      c.header('Retry-After', '60');
      return new ApiError(429, 'DASHBOARD_RATE_LIMITED', `This session computed ${DASHBOARD_RECOMPUTES_PER_MINUTE} Overview figures in the last minute. Retry after the window resets.`, undefined, true);
    },
  });
  return { value: result.value, cache: result.stale ? 'stale' : result.hit ? 'hit' : 'miss' };
}

type Entry = { expires: number; revision: string; value: unknown };
type Options = {
  /** What the cached value was computed from; a value from another revision is only served stale. */
  revision?: string;
  /** Asked before computing; false serves the unexpired value of another revision, or throws refuse(). */
  admit?: () => Promise<boolean>;
  refuse?: () => Error;
};
const memoryCache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
// Per-isolate memory first, then the colo-wide Workers Cache API when present (absent on Node).
// On Node, concurrent identical requests share one query. Workers can't await another request's
// I/O ("Cannot perform I/O on behalf of a different request"), so there each request computes its own.
export async function cachedDashboardRead<T>(origin: string, scope: string, compute: () => Promise<T>, ttlSeconds = TTL_SECONDS, options: Options = {}): Promise<{ value: T; hit: boolean; stale?: boolean }> {
  const key = JSON.stringify([origin, scope]), revision = options.revision ?? '';
  const live = (entry: Entry | undefined) => entry && entry.expires > Date.now() ? entry : undefined;
  let held = live(memoryCache.get(key));
  if (held?.revision === revision) return { value: held.value as T, hit: true };
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const flight = JSON.stringify([key, revision]), pending = cache ? undefined : inflight.get(flight);
  if (pending) return { value: await pending as T, hit: true };
  const request = new Request(`${origin}/__cache/dashboard/${await digest(key)}`);
  const remember = (entry: Entry) => {
    if (!memoryCache.has(key) && memoryCache.size >= 500) memoryCache.delete(memoryCache.keys().next().value!);
    memoryCache.set(key, entry);
  };
  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    const stored = hit && live({ expires: Number(requestHeader(hit.headers, 'expires')), revision: requestHeader(hit.headers, 'revision') ?? '', value: undefined });
    if (hit && stored && (stored.revision === revision || !held)) {
      held = { ...stored, value: await hit.json() }; remember(held);
      if (held.revision === revision) return { value: held.value as T, hit: true };
    }
  }
  if (options.admit && !await options.admit()) {
    if (held) return { value: held.value as T, hit: true, stale: true };
    throw options.refuse?.() ?? new ApiError(429, 'REQUEST_RATE_LIMITED', 'Too many reads were computed this minute. Retry after the window resets.', undefined, true);
  }
  const work = compute();
  if (!cache) inflight.set(flight, work);
  try {
    const value = await work;
    const expires = Date.now() + ttlSeconds * 1000;
    remember({ expires, revision, value });
    if (cache) await cache.put(request, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSeconds}`, [`${headerPrefix}Expires`]: String(expires), [`${headerPrefix}Revision`]: revision } })).catch(() => undefined);
    return { value, hit: false };
  } finally { if (!cache) inflight.delete(flight); }
}
