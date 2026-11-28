import { createHmac, timingSafeEqual } from 'node:crypto';
import { authenticate } from './auth.js';
import { ANALYTICS_ROOT, analyticsStore, attribution, expireSalts, logAnalyticsFailure, publicRows, trafficRows } from './analytics-traffic.js';
import { exportRange, exportRollups, partition, pushDue, rollupHour } from './analytics-rollups.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from './core/errors.js';
import { digest } from './core/http.js';
import { log } from './log.js';
import type { App, Runtime } from './core/types.js';
import { clientIpHeader } from './brand.js';
import { ANALYTICS_EVENT_TYPES, ANALYTICS_LIMITS, ANALYTICS_PATH, FUNNEL_STEPS, VALIDITY_REASONS, VIEWPORTS, analyticsId, analyticsName, fieldName, operationTemplate, routeTemplate, scrubLabel } from './analytics-events.js';

// One bucket-backed ingest for both clients. Only settled-hour upkeep writes analytics to Postgres.
export { ANALYTICS_ROOT, analyticsStore } from './analytics-traffic.js';
/** Compacted days older than this are deleted by the hourly upkeep (hosted buckets also have a lifecycle backstop). */
export const ANALYTICS_RETENTION_DAYS = 400;
/** Batches a minute from one client address: a tab flushes at most every five seconds, plus once when it hides. */
export const ANALYTICS_BATCHES_PER_MINUTE = 60;
// A batch is written before its 204, so an hour is complete a few minutes after it ends.
const SETTLE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const Envelope = z.object({
  v: z.literal(1),
  sid: id,
  ws: z.string().max(64).nullish(), uid: z.string().max(64).nullish(),
  app: z.string().max(40).nullish(), vp: z.enum(VIEWPORTS),
  r: z.unknown().optional(), u: z.unknown().optional(),
  events: z.array(z.unknown()).min(1).max(ANALYTICS_LIMITS.events),
});
const text = (max: number) => z.string().max(max).nullish();
const Event = z.object({
  id, seq: z.number().int().min(0).max(10_000_000), t: z.number().int().min(0), type: z.enum(ANALYTICS_EVENT_TYPES),
  route: z.string().max(300), ref: text(300),
  name: text(80), role: text(24), label: text(200), field: text(120), reason: z.enum(VALIDITY_REASONS).nullish(),
  code: text(64), op: text(300), status: z.number().int().min(100).max(599).nullish(),
  ms: z.number().int().min(0).max(7 * DAY_MS).nullish(), step: z.enum(FUNNEL_STEPS).nullish(),
});
export type AnalyticsRow = {
  v: 1; id: string; received: string; t: string; seq: number; sid: string; ws: string | null; uid: string | null; app: string | null; vp: typeof VIEWPORTS[number] | null;
  vid?: string | null; public?: boolean; width?: number; referrer?: string | null; source?: string | null; medium?: string | null; campaign?: string | null; country?: string | null; device?: string | null;
  type: typeof ANALYTICS_EVENT_TYPES[number]; route: string; ref: string | null; target: string | null; name: string | null; role: string | null; label: string | null;
  field: string | null; reason: string | null; code: string | null; op: string | null; status: number | null; ms: number | null; step: string | null;
};
const ELEMENT_EVENTS = new Set(['click', 'dialog_open', 'dialog_close', 'form_submit', 'form_invalid']);

/**
 * The stored rows of one batch: every value is checked again here, whatever the dashboard did. Unknown fields are
 * stripped, an event that fails its schema is dropped (a newer or older dashboard keeps the rest of its batch), labels are
 * scrubbed, paths become route templates, and IDs that aren't Nightmail's own shapes become null.
 */
export function analyticsRows(body: unknown, now: number): { rows: AnalyticsRow[]; dropped: number } {
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) throw new ApiError(422, 'VALIDATION_FAILED', 'The analytics batch is invalid.');
  const { sid, ws, uid, app, vp, events } = envelope.data, received = new Date(now).toISOString();
  const base = { v: 1 as const, received, sid, vp, ws: workspaceId(ws), uid: userId(uid), app: app && /^[0-9a-z]{1,40}$/.test(app) ? app : null };
  const rows: AnalyticsRow[] = [];
  for (const raw of events) {
    const parsed = Event.safeParse(raw), event = parsed.success ? parsed.data : null;
    const route = event && routeTemplate(event.route);
    if (!event || !route || (event.type === 'sign_in' || event.type === 'bot_view') || (event.type === 'track' && !event.step) || (event.type === 'api_error' && !event.code)) continue;
    const name = analyticsName(event.name), role = typeof event.role === 'string' && /^[a-z]{1,16}$/.test(event.role) ? event.role : null;
    const label = name ? null : scrubLabel(event.label);
    rows.push({ ...base, ...(event.type === 'page_view' ? attribution(envelope.data.r, envelope.data.u) : {}), id: event.id, t: new Date(Math.abs(event.t - now) > DAY_MS ? now : event.t).toISOString(), seq: event.seq, type: event.type, route,
      ref: routeTemplate(event.ref), target: name ?? (ELEMENT_EVENTS.has(event.type) && (role || label) ? (role ?? 'element') + ':' + (label ?? '') : null), name, role, label,
      field: fieldName(event.field), reason: event.reason ?? null, code: event.code && /^(?:[A-Z][A-Z0-9_]{0,63}|[a-z][a-z_]{0,31})$/.test(event.code) ? event.code : null,
      op: operationTemplate(event.op), status: event.status ?? null, ms: event.ms ?? null, step: event.step ?? null });
  }
  return { rows, dropped: events.length - rows.length };
}

const workspaceId = (value: unknown) => typeof value === 'string' && /^(?:ws_[0-9a-f]{32}|default)$/.test(value) ? value : null;
const userId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;

const encoder = new TextEncoder(), decoder = new TextDecoder();
type StoredRow = AnalyticsRow | Pick<AnalyticsRow, 'v' | 'id' | 'received' | 'type' | 'route'>;
const nonce = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
// Only failed live requests pay for a receipt. Never store a digest of the original (unrekeyed) public session.
const retryMac = (secret: string, ticket: string, json: string) => createHmac('sha256', secret)
  .update('nightmail:analytics-retry:v1\0').update(ticket).update('\0').update(json).digest().subarray(0,16);
async function writeBatch(runtime: Runtime, rows: StoredRow[], now: number, suffix = nonce()) {
  const key = ANALYTICS_ROOT + 'raw/' + partition(now) + '/' + now + '-' + suffix + '.ndjson';
  await analyticsStore(runtime).put(key, encoder.encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), 'application/x-ndjson');
}

/**
 * The one event that links a signed-out page's session (its events carry no account) to the account that signed in
 * from it: written by the sign-in callback, which knows both, with the session ID the page put in its return URL.
 * Best-effort: a failure here never fails the sign-in.
 */
export async function recordSignIn(runtime: Runtime, session: unknown, user: string, route: string) {
  const sid = analyticsId(session), uid = userId(user);
  if (!runtime.config.dashboardAnalytics || !sid || !uid) return;
  const now = Date.now(), at = new Date(now).toISOString();
  try {
    await writeBatch(runtime, [{ v: 1, id: crypto.randomUUID().replaceAll('-', ''), received: at, t: at, seq: 0, sid, ws: null, uid, app: null, vp: null, type: 'sign_in',
      route: routeTemplate(route) ?? '/', ref: null, target: null, name: null, role: null, label: null, field: null, reason: null, code: null, op: null, status: null, ms: null, step: null }], now);
  } catch { log('warn', { code: 'ANALYTICS_SIGN_IN_UNRECORDED' }); }
}

// A per-process cap in front of the Workers rate-limit binding (runtime.allowAnalytics), which Node doesn't have.
const counts = new Map<string, number>();
let countMinute = 0;
async function allowBatch(runtime: Runtime, peer: string) {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== countMinute) { counts.clear(); countMinute = minute; }
  const count = (counts.get(peer) ?? 0) + 1;
  if (counts.size < 4096 || counts.has(peer)) counts.set(peer, count);
  if (count > ANALYTICS_BATCHES_PER_MINUTE) return false;
  return runtime.allowAnalytics ? runtime.allowAnalytics(peer) : true;
}

export function registerAnalytics(app: App) {
  // Internal: not in the OpenAPI document, the SDK or MCP. Anyone can post, so it answers only the dashboard's own
  // origin, counts batches per client address before reading a byte, and stores nothing it hasn't checked.
  app.get(ANALYTICS_PATH + '/export', authenticate, async c => {
    const { operatorActor } = await import('./operator.js');
    await operatorActor(c, 'operator:read');
    const range = exportRange(c.req.query('from'), c.req.query('to'), c.req.query('grain'));
    return c.json(await exportRollups(c.env, range));
  });
  app.post(ANALYTICS_PATH, async c => {
    const runtime = c.env, { config } = runtime;
    // Off (DASHBOARD_ANALYTICS): the dashboard sends nothing, and anything that arrives anyway is discarded unread.
    if (!config.dashboardAnalytics) return c.body(null, 204);
    const origin = c.req.header('origin'), site = c.req.header('sec-fetch-site'), host = new URL(c.req.url).host;
    const approved = [config.publicUrl, ...config.previousOrigins ?? []];
    // WebKit redacts Origin under no-referrer, even on same-origin POSTs. Require explicit browser Fetch Metadata
    // for that case and an approved destination host. Node may see HTTP behind a TLS-terminating proxy.
    const allowed = origin === 'null'
      ? site === 'same-origin' && approved.some(url => new URL(url).host === host)
      : !!origin && approved.includes(origin) && new URL(origin).host === host && (site === undefined || site === 'same-origin');
    if (!allowed) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Analytics are accepted only from this installation’s dashboard.');
    // Do Not Track and Global Privacy Control: the dashboard sends nothing then, and a batch that says so is dropped.
    if (c.req.header('dnt') === '1' || c.req.header('sec-gpc') === '1') return c.body(null, 204);
    if (!(await allowBatch(runtime, await digest(c.req.header(clientIpHeader) ?? 'unknown')))) throw new ApiError(429, 'ANALYTICS_RATE_LIMITED', 'Too many analytics batches from this connection. Retry after one minute.', undefined, true);
    if (Number(c.req.header('content-length')) > ANALYTICS_LIMITS.bodyBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 32 KiB limit.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > ANALYTICS_LIMITS.bodyBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 32 KiB limit.');
    const json = decoder.decode(bytes);
    let body: unknown;
    try { body = JSON.parse(json); } catch { throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
    // A put can land despite a failed acknowledgement. Both retries address the same object and event IDs, even
    // across midnight. Sign the ticket for the exact body; a caller cannot pick a key or reopen a settled hour.
    const received = Date.now(), retry = c.req.query('r'), match = retry?.match(/^(\d{13})-([a-f0-9]{16})\.([a-f0-9]{32})$/);
    const now = match ? Number(match[1]) : received, batchId = match?.[2] ?? nonce(), ticket = now + '-' + batchId;
    if (retry !== undefined && (!match || now > received || received - now > 60_000 ||
      ![config.authSecret, config.previousAuthSecret].some(secret => secret && timingSafeEqual(retryMac(secret,ticket,json),Buffer.from(match[3]!,'hex')))))
      throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid or expired analytics retry.');
    const { rows, dropped } = body && typeof body === 'object' && 'p' in body
      ? { rows: publicRows(body, now, 'p:' + ticket), dropped: 0 } : analyticsRows(body, now);
    if (dropped) log('warn', { requestId: c.get('requestId'), code: 'ANALYTICS_EVENTS_DROPPED', dropped, accepted: rows.length });
    let enriched: StoredRow[] | undefined;
    for (let attempt = 1; rows.length && attempt <= 2; attempt++) {
      try {
        enriched ??= await trafficRows(runtime, rows, c.req.header('user-agent') ?? '', runtime.analyticsPeer?.ip ?? c.req.header(clientIpHeader) ?? '', now);
        if (enriched.length) await writeBatch(runtime, enriched, now, batchId);
        break;
      } catch (error) {
        logAnalyticsFailure(error, attempt === 1 ? 'ANALYTICS_INGEST_RETRY' : 'ANALYTICS_INGEST_FAILED',
          { requestId: c.get('requestId'), stage: enriched ? 'raw_put' : 'enrich', attempt });
        if (attempt === 2) {
          if (retry === undefined) c.header('NM-R', '?r=' + ticket + '.' + Buffer.from(retryMac(config.authSecret,ticket,json)).toString('hex'));
          throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Analytics storage is unavailable.', undefined, true);
        }
      }
    }
    return c.body(null, 204);
  });
}

async function eachLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]!); } }));
  return results;
}
async function gzip(bytes: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/**
 * Hourly: each settled hour's raw batches become one gzip NDJSON object under events/ (per 64 batches), then the
 * batches are deleted; compacted days past the retention go too. The object's name is a digest of the batches in it, so
 * two runs at once write the same object. A batch whose delete failed is compacted again later; readers deduplicate
 * by event ID (docs/analytics.md).
 */
export async function compactAnalytics(runtime: Runtime, now = Date.now()) {
  const store = analyticsStore(runtime), result = { hours: 0, batches: 0, expired: 0 };
  if (!runtime.config.dashboardAnalytics || !store.list) return result;
  const raw = ANALYTICS_ROOT + 'raw/', settled = partition(now - SETTLE_MS), hours = new Map<string, string[]>();
  await expireSalts(runtime, new Date(now).toISOString().slice(0,10));
  let after: string | undefined;
  do {
    const page = await store.list(raw, after);
    for (const { key } of page.objects) {
      const hour = key.slice(raw.length).split('/', 2).join('/');
      if (/^dt=\d{4}-\d{2}-\d{2}\/h=\d{2}$/.test(hour) && hour < settled) { const keys = hours.get(hour); if (keys) keys.push(key); else hours.set(hour, [key]); }
    }
    // Never publish a partial hour because its keys crossed a listing page.
    const last = page.objects.at(-1)?.key;
    after = last && last < raw + settled ? page.cursor : undefined;
  } while (after);
  for (const [hour, keys] of hours) {
    for (let start = 0; start < keys.length; start += 64) {
      const part = keys.slice(start, start + 64);
      const bodies = await eachLimit(part, 8, key => store.get(key));
      // If another run already removed a raw object, don't overwrite its complete part with a partial body.
      const present = part.filter((_key,index) => bodies[index]);
      const lines = bodies.map(object => object ? decoder.decode(object.body) : '').filter(Boolean).map(body => body.endsWith('\n') ? body : body + '\n').join('');
      if (lines) await store.put(ANALYTICS_ROOT + 'events/' + hour + '/' + (await digest(present.join('\n'))).slice(0,16) + '.ndjson.gz', await gzip(encoder.encode(lines)), 'application/gzip');
    }
    const ms = Date.parse(hour.slice(3,13)+'T'+hour.slice(-2)+':00:00Z');
    await rollupHour(runtime, ms); // Commit before deleting raw: a crash at any point leaves a retry trigger.
    await eachLimit(keys, 8, key => store.delete(key));
    result.batches += keys.length; result.hours++;
  }
  // The days just past the retention, a week of them, so a few missed runs still catch up.
  for (let back = 0; back < 7; back++) {
    const day = new Date(now - (ANALYTICS_RETENTION_DAYS + back) * DAY_MS).toISOString().slice(0, 10);
    let cursor: string | undefined;
    do {
      const page = await store.list(ANALYTICS_ROOT + 'events/dt=' + day + '/', cursor);
      await eachLimit(page.objects, 8, object => store.delete(object.key));
      result.expired += page.objects.length; cursor = page.cursor;
    } while (cursor);
  }
  const cutoff = new Date(now - ANALYTICS_RETENTION_DAYS*DAY_MS).toISOString().slice(0,10)+'T00:00:00Z';
  await runtime.db.execute(sql`DELETE FROM analytics_hours WHERE hour < ${cutoff}`);
  await runtime.db.execute(sql`DELETE FROM analytics_funnel_first WHERE hour < ${cutoff}`);
  if (runtime.config.analyticsPush) {
    const latest = (Math.floor((now-SETTLE_MS)/3_600_000)-1)*3_600_000;
    if (!hours.has(partition(latest))) await rollupHour(runtime,latest);
    await pushDue(runtime,now);
  }
  if (result.hours || result.expired) log('info', { code: 'ANALYTICS_COMPACTED', ...result });
  return result;
}
