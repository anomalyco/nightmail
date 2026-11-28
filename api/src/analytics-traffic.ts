import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AnalyticsRow } from './analytics.js';
import { analyticsId, viewportClass } from './analytics-events.js';
import { ApiError, logError, platformMessage } from './core/errors.js';
import type { Runtime, Storage } from './core/types.js';

export const ANALYTICS_ROOT = 'analytics/v1/';
export const analyticsStore = (runtime: Runtime): Storage => runtime.analyticsStorage ?? runtime.storage;
/** Keep platform detail and SQLSTATEs, never SQL parameters or JSON.parse snippets from an event. */
export function logAnalyticsFailure(error: unknown, code: string, fields: Record<string, unknown>) {
  const cause = error instanceof ApiError ? error.code : error instanceof SyntaxError ? 'Invalid analytics JSON' : platformMessage(error);
  logError(error, { code, ...fields, cause }, 'warn');
}
/** The public pages the public hook reports (the homepage, pricing, comparisons, legal and the docs), by their own path. */
export const PUBLIC_ROUTE = /^\/(?:(?:pricing|compare|legal|docs)(?:\/(?:api\/)?[A-Za-z][\w-]{0,63})?)?\/?$/;
const publicRoute = (x: unknown) => typeof x === 'string' && x.length <= 128 && PUBLIC_ROUTE.test(x) ? x.replace(/\/$/, '') || '/' : null;
const host = (x: unknown) => typeof x === 'string' && x.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,32}$/i.test(x) ? x.toLowerCase() : null;
const tag = (x: unknown) => typeof x === 'string' && /^[\w-]{1,48}$/.test(x) ? x : null;
export const attribution = (r: unknown, u: unknown) => {
  const tags = Array.isArray(u) ? u : [];
  return { referrer: host(r), source: tag(tags[0]), medium: tag(tags[1]), campaign: tag(tags[2]) };
};
const PublicEvent = z.object({ p: z.string().max(128), s: z.string().max(40), c: z.string().max(253).optional(), w: z.number().int().min(0).max(65535), r: z.unknown().optional(), u: z.unknown().optional() });
export function publicRows(body: unknown, now: number, eventId: string): AnalyticsRow[] {
  const parsed = PublicEvent.safeParse(body);
  if (!parsed.success) return [];
  const { p, s, c, w, r, u } = parsed.data, route = publicRoute(p), sid = analyticsId(s);
  if (!route || !sid) return [];
  const target = c === undefined ? null : publicRoute(c) ?? host(c) ?? (['sign-in','outbound','link'].includes(c) ? c : null);
  if (c !== undefined && !target) return [];
  const at = new Date(now).toISOString();
  return [{ v: 1, id: eventId, received: at, t: at, seq: 0, sid, ws: null, uid: null, app: null, vp: viewportClass(w),
    type: target ? 'click' : 'page_view', route, target, public: true, ...attribution(r,u), width: w,
    ref: null, name: null, role: null, label: null, field: null, reason: null, code: null, op: null, status: null, ms: null, step: null }];
}

const knownBot = /bot\b|crawler|spider|slurp|headlesschrome|lighthouse|bingpreview|facebookexternalhit|archive\.org_bot|curl\/|wget\//i;
const salts = new WeakMap<object, { day: string; salt: Uint8Array }>();
export const SALTS = ANALYTICS_ROOT + 'salts/';
async function dailySalt(runtime: Runtime, day: string) {
  const store = analyticsStore(runtime), scope = store.cacheScope ?? store, cached = salts.get(scope);
  if (cached?.day === day) return cached.salt;
  const key = SALTS + day;
  let object = await store.get(key);
  if (!object) {
    if (!store.createIfAbsent) throw new Error('Analytics storage needs conditional creation');
    await store.createIfAbsent(key, randomBytes(32), 'application/octet-stream');
    object = await store.get(key); // Even the first writer reads the winning key.
  }
  if (object?.body.length !== 32) throw new Error('Daily analytics salt unavailable');
  salts.set(scope, { day, salt: object.body });
  return object.body;
}
export async function expireSalts(runtime: Runtime, today: string) {
  const store = analyticsStore(runtime), scope = store.cacheScope ?? store;
  if ((salts.get(scope)?.day ?? today) < today) salts.delete(scope);
  let cursor: string | undefined;
  do {
    const page = await store.list!(SALTS, cursor);
    for (const { key } of page.objects) if (key.slice(SALTS.length) < today) await store.delete(key);
    cursor = page.cursor;
  } while (cursor);
}
export async function trafficRows(runtime: Runtime, rows: AnalyticsRow[], ua: string, ip: string, now: number) {
  // The bot counter retains only page/time, not the bot's other events, envelope or UA.
  if (runtime.analyticsPeer?.bot || knownBot.test(ua)) return rows.filter(r => r.type === 'page_view').map(r => ({
    v: 1 as const, id: r.id, received: r.received, type: 'bot_view' as const, route: r.route,
  }));
  const day = new Date(now).toISOString().slice(0,10);
  const salt = rows.some(row => row.public) ? await dailySalt(runtime, day) : undefined;
  const vid = salt && ip && ua ? createHmac('sha256', salt).update(JSON.stringify([day,ip,ua])).digest('hex').slice(0,32) : null;
  const country = runtime.analyticsPeer?.country;
  const device = /ipad|tablet|android(?!.*mobile)/i.test(ua) ? 'tablet' : /mobile|iphone|ipod/i.test(ua) ? 'phone' : ua ? 'desktop' : null;
  const where = { country: country && /^[A-Z]{2}$/.test(country) ? country : null, device };
  // Only public-hook rows get the daily code, and their page session is keyed by the same salt: a dashboard row carries
  // the account, and sign_in keeps the page's raw session ID, so neither can join a visitor code to an account or across days.
  return rows.map(row => row.public && salt ? { ...row, ...where, vid, sid: createHmac('sha256', salt).update('sid:' + row.sid).digest('hex').slice(0,32) } : { ...row, ...where });
}
