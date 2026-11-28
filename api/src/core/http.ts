import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { log } from '../log.js';
import { SECURITY_HEADERS } from '../security-headers.js';
import type { Runtime, DbExecutor, Ctx } from './types.js';
import { ApiError } from './errors.js';

/**
 * How long each statement of a read may run (budgetedRead), and the refusal past it. A dashboard read that needs longer
 * holds one of the database's few connections for up to the proxy's 60 seconds, beside sending: past its limit it is
 * refused instead, and the caller narrows it.
 */
export type ReadBudget = { seconds: number; refusal: () => ApiError };
/** A list or aggregate the caller can narrow (Logs, listEmails, metrics, campaign counts, inbound lists). */
export const readLimit = (seconds: number): ReadBudget => ({ seconds,
  refusal: () => new ApiError(422, 'READ_TOO_LARGE', `This request is too broad to answer within ${seconds} seconds. Narrow the dates or filters.`) });
/** The OpenAPI description of that refusal, for the routes that take a budget. */
export const readLimitNote = (seconds: number) => `Each statement stops after ${seconds} seconds: a request that needs longer is refused with 422 READ_TOO_LARGE. Narrow the dates or filters.`;
/**
 * One read-only transaction whose every statement stops after the budget's seconds (SET LOCAL statement_timeout), so a
 * slow read is refused (SQLSTATE 57014 becomes the budget's refusal) instead of holding its connection. Costs BEGIN,
 * SET and COMMIT: three round trips on the read's own connection.
 */
export async function budgetedRead<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>, budget: ReadBudget, isolationLevel?: 'repeatable read'): Promise<T> {
  if (!Number.isInteger(budget.seconds) || budget.seconds < 1) throw new Error('A read budget is a whole number of seconds.');
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${budget.seconds}s'`));
      return work(tx);
    }, { accessMode: 'read only', ...(isolationLevel && { isolationLevel }) });
  } catch (error) {
    if (statementTimedOut(error)) throw budget.refusal();
    throw error;
  }
}
/** A statement ended by statement_timeout (SQLSTATE 57014), as the driver reports it or wraps it. */
export const statementTimedOut = (error: unknown) => [error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014');
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
export function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
export const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const AudienceSpec = z.object({ listId: z.string().min(1).max(120), segmentId: z.string().min(1).max(120).optional(), excludeListIds: z.array(z.string().min(1).max(120)).max(20).optional(), excludeSegmentIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  priority: z.object({ property: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), values: z.array(z.string().max(200)).min(1).max(20) }).strict().optional().describe('Send order: contacts whose property equals an earlier value are reviewed and released first; everyone else follows. Useful with paced sending, e.g. { property: "plan", values: ["active", "former"] }.') }).strict();
export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } }, required: true });
export const response = <T extends z.ZodType>(schema: T, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
export const page = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
/** A random ID: the prefix, `_` and 32 hex characters (a UUIDv4, 122 random bits). Anything that must be unguessable uses this. */
export function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
/**
 * A time-ordered ID for high-volume rows (emails, events, webhook and inbound webhook deliveries, jobs, threads), in
 * id()'s format: a UUIDv7 (RFC 9562), 48 bits of Unix milliseconds then 74 random bits, so a new row lands at the end
 * of its indexes instead of on a random page. row_id() builds the same in SQL (migration 392). It shows when the row was
 * made, so it is never a secret or a capability; and IDs from the same millisecond, or from machines whose clocks
 * differ, come in no particular order.
 */
export function rowId(prefix: string) { return `${prefix}_${Date.now().toString(16).padStart(12, '0')}7${crypto.randomUUID().replaceAll('-', '').slice(13)}`; }
/** A timestamp as the API returns it (ISO 8601, UTC), from Postgres text ("2026-11-13 10:00:00.123+00") or ISO. */
export const isoTime = (value: string | null | undefined) => value ? new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString() : null;
/** A (created_at, id) page cursor, bound to its resource and filters; microseconds survive the round trip. */
export function readCursor(value: string | undefined, binding: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    // ISO 8601 allows offsets up to ±23:59; Postgres refuses past ±15:59 (22009), so an edited cursor would be a 500.
    const tuple = z.tuple([z.string().datetime({ offset: true }).regex(/(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/), z.string().min(1).max(120), z.literal(binding)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: tuple[0], id: tuple[1] };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}
export function encodeCursor(last: { id: string; createdAt: string }, binding: string) {
  return Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url');
}
export function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? encodeCursor(last, binding) : null;
}
export function applySecurityHeaders(headers: Headers): Headers {
  // Route-specific policies (notably OAuth form redirects) take precedence.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return headers;
}
export function secureResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: applySecurityHeaders(new Headers(response.headers)) });
}
// HTTPS installations name auth cookies `__Host-nightmail.*`; plain-HTTP local development uses `nightmail.*`. A browser may
// still hold the pre-rename `bane.*` ones (account-login.ts reads and migrates them; remove after rename cleanup).
export function hasSessionCookie(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return Boolean(cookie && /(?:^|;\s*)(?:__Host-)?(?:nightmail|bane)\.session_token(?:\.\d+)?=[^;\s]/.test(cookie));
}
/** The routes Amazon SNS posts signed notifications to: SES feedback and connected accounts' stack requests. */
export const snsIngress = (path: string) => path === '/v1/events/ses' || path === '/v1/events/cloudformation';
export function publicFailureBucket(path: string, status: number, headers?: Headers): 'auth' | 'unsubscribe' | null {
  // SNS callers share egress addresses; reject untrusted topics/signatures without charging that pool.
  if (status < 400 || status >= 500 || snsIngress(path)) return null;
  if (/^\/unsubscribe(?:\/|$)/.test(path) || /^\/v1\/forwarding\//.test(path)) return 'unsubscribe';
  if (status !== 401 || !/^\/v1(?:\/|$)/.test(path)) return null;
  return headers && !headers.has('authorization') && !hasSessionCookie(headers) ? null : 'auth';
}
export function admissionPeer(address: string): string {
  if (!address.includes(':')) return address;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
    if (mapped) return mapped.slice(1).flatMap(v => [parseInt(v,16) >>> 8, parseInt(v,16) & 255]).join('.');
    const [left, right] = canonical.split('::');
    const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
    return [...a, ...Array(8-a.length-b.length).fill('0'), ...b].slice(0,4).join(':') + '::';
  } catch { return 'unknown'; }
}
// Cloudflare gives every cross-zone Worker subrequest the same client address and names the calling
// zone in CF-Worker, so callers on Workers (OpenCode Console among them) would otherwise share one
// admission bucket and one failure budget with every other Worker on the Internet. Only that egress
// address may choose a bucket this way; any other client keeps its own address.
const WORKER_EGRESS = admissionPeer('2a06:98c0:3600::103');
export function admissionKey(address: string, worker: string | null) {
  const zone = worker?.trim().toLowerCase();
  return address === WORKER_EGRESS && zone && /^[a-z0-9.-]{1,253}$/.test(zone) ? `worker:${zone}` : address;
}

// Identity entry has a request budget; authenticated API routes have a failure
// budget. Check completed failures before dispatch, never charge concurrency.
const failureCounts = new Map<string, number>();
let failureMinute = 0;
export function allowMalformedSns(peer: string) {
  const minute=Math.floor(Date.now()/60000);
  if(minute!==failureMinute){failureCounts.clear(); failureMinute=minute;}
  const key=`malformed-sns:${peer}`, count=failureCounts.get(key)??0;
  if(count>=40 || (!count && failureCounts.size>=4096)) return false;
  failureCounts.set(key,count+1); return true;
}
export async function guardPublicRequest(path: string, headers: Headers, peer: string, work: () => Promise<Response>) {
  const entry = /^\/(?:api\/auth|\.well-known)(?:\/|$)/.test(path) || path==='/mcp/login' || path==='/mcp/consent';
  const lane = entry ? 'identity-entry' : publicFailureBucket(path, 401, headers);
  if (!lane) return work();
  const minute = Math.floor(Date.now()/60000);
  if (minute !== failureMinute) { failureCounts.clear(); failureMinute = minute; }
  const key = `${lane}:${peer}`;
  // At capacity, rely on edge admission for unknown peers. Never share either
  // a penalty or an in-flight reservation between unrelated credentials.
  if (!failureCounts.has(key) && failureCounts.size >= 4096) return entry ? publicFailureDenied() : work();
  const count = failureCounts.get(key) ?? 0;
  if (count >= 40) return publicFailureDenied();
  if(entry) failureCounts.set(key,count+1);
  const response=await work();
  if(!entry && minute===failureMinute && publicFailureBucket(path,response.status,headers) && (failureCounts.has(key) || failureCounts.size<4096)) {
    failureCounts.set(key,Math.min(40,(failureCounts.get(key)??0)+1));
  }
  return response;
}
/**
 * One atomic per-minute counter in api_request_budgets, named by `key` within a workspace: true while this minute's
 * charges, this one included, stay within `limit`. A window stored in the future (an operator's or a test's hold) stays.
 */
/** Read-only check for whether a workspace's per-minute budget is already spent (does not increment usage). */
export async function budgetExhausted(runtime: Pick<Runtime, 'db'>, workspaceId: string, key: string, limit: number) {
  const { rows: [row] } = await runtime.db.execute<{ exhausted: boolean }>(sql`SELECT (window_start >= date_trunc('minute', now()) AND used >= ${limit}) AS exhausted FROM api_request_budgets WHERE workspace_id = ${workspaceId} AND key_id = ${key}`);
  return row?.exhausted === true;
}
export async function chargeBudget(runtime: Pick<Runtime, 'db'>, workspaceId: string, key: string, limit: number) {
  const { rows: [row] } = await runtime.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${workspaceId}, ${key}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN excluded.window_start > api_request_budgets.window_start THEN 1 ELSE least(api_request_budgets.used + 1, ${limit + 1}) END,
      window_start = greatest(api_request_budgets.window_start, excluded.window_start) RETURNING used`);
  return row!.used <= limit;
}
// All credentials and image-producing routes share one atomic workspace counter.
export async function chargeRenderBudget(c: Ctx, workspaceId: string) {
  const limit = 30;
  if (!await chargeBudget(c.env, workspaceId, 'render:images', limit)) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'RENDER_RATE_LIMITED', `This workspace allows ${limit} image previews and imports per minute. Retry after the window resets.`, undefined, true);
  }
}
export async function timed<T>(c: Ctx, name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { c.get('serverTimings').push({ name, durationMs: performance.now() - start }); }
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
export function admissionDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'ADMISSION_RATE_LIMITED', operation: 'admission' });
  return secureResponse(Response.json({ error: { code: 'ADMISSION_RATE_LIMITED', message: 'Too many requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
export function publicFailureDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'PUBLIC_RATE_LIMITED', operation: 'public-failure' });
  return secureResponse(Response.json({ error: { code: 'PUBLIC_RATE_LIMITED', message: 'Too many failed public requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
