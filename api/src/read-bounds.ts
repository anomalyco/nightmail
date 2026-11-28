import { ApiError } from './core/errors.js';
import { log } from './log.js';
import type { Ctx } from './core/types.js';
import { MEMORY_LIMITS, type MemoryLease } from './isolate-memory.js';

/** Default response byte budget per paginated read (always keeping at least one row so cursors progress). */
export const PAGE_MAX_BYTES = 512 * 1024;
/** Global concurrent bounded reads per isolate (isolated from attachment/import memory pool). */
export const READ_MAX_ACTIVE = 8;
/** Maximum concurrent bounded reads admitted at once for a single workspace. */
export const READ_MAX_ACTIVE_PER_WORKSPACE = 2;
/** Maximum queued bounded reads per workspace before answering retryable 429 for that workspace only. */
export const READ_MAX_WAITING_PER_WORKSPACE = 4;
/** Maximum total queued bounded reads across all workspaces before answering retryable 503. */
export const READ_MAX_WAITERS = 32;
/** Backwards-compatible alias for the estimated working memory of one 512 KiB bounded read. */
export const READ_RESERVATION_BYTES = 2 * 1024 * 1024;

/** Tunable read-pool deadlines (exported for tests). */
export const READ_POOL_LIMITS = {
  defaultIdleMs: 15_000,
  defaultMaxMs: 60_000,
  confirmMs: 1_000,
  maxWaitMs: 30_000,
};

const utf8Encoder = new TextEncoder();
export const utf8Bytes = (value: string) => utf8Encoder.encode(value).byteLength;

/**
 * Serializes a cursor page within maxBytes, always returning at least one row so keyset pagination never stalls.
 * Callers should also cap cumulative row bytes in SQL so Postgres never sends unbounded payloads to the isolate.
 */
export function buildBoundedPageJson<T extends { id: string }>(
  items: T[],
  hasMoreFromQuery: boolean,
  maxBytes = PAGE_MAX_BYTES,
): { json: string; nextCursor: string | null; count: number } {
  const parts: string[] = [];
  let bytes = 32; // {"data":[],"nextCursor":null}
  let trimmed = false;
  for (let i = 0; i < items.length; i++) {
    const serialized = JSON.stringify(items[i]!);
    const size = utf8Bytes(serialized) + (i > 0 ? 1 : 0);
    if (i > 0 && bytes + size + 64 > maxBytes) { trimmed = true; break; }
    parts.push(serialized);
    bytes += size;
  }
  const hasMore = hasMoreFromQuery || trimmed;
  const nextCursor = hasMore && parts.length > 0 ? items[parts.length - 1]!.id : null;
  return { json: `{"data":[${parts.join(',')}],"nextCursor":${JSON.stringify(nextCursor)}}`, nextCursor, count: parts.length };
}

/** Belt-and-braces waitUntil registration so a Worker request context can outlive a client disconnect when permitted. */
export function keepAlive(c: Ctx, promise: Promise<unknown>) {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise.catch(() => {}));
  } catch {
    // Hono throws when executionCtx is absent (Node runtime / direct app.fetch tests).
  }
}

export type PoolHold = {
  /** Record forward progress, extending the idle deadline up to hardDeadlineAt. */
  touch(): void;
  /** Update idle/hard deadlines (e.g. when entering response streaming). */
  setDeadlines(idleMs: number, maxMs?: number): void;
  /** Register a best-effort cleanup callback run if the pool reclaims this hold by deadline. */
  onReclaim(fn: () => void): void;
  /** Idempotent release; a late release after timeout reclaim is a safe no-op. */
  release(): void;
  /** True once released or reclaimed. */
  readonly released: boolean;
};

export type FairPoolAcquireOptions = {
  route?: string;
  maxPerWs?: number;
  maxWaitingPerWs?: number;
  idleMs?: number;
  maxMs?: number;
  maxWaitMs?: number;
  onReclaim?: () => void;
  busyCode: string;
  busyMessage: string;
  wsBusyCode: string;
  wsBusyMessage: string;
  retryAfter?: string;
};

type ActivePoolHold = {
  workspaceId: string;
  route: string;
  acquiredAt: number;
  lastProgressAt: number;
  idleMs: number;
  idleDeadlineAt: number;
  hardDeadlineAt: number;
  confirmed: boolean;
  confirmDeadlineAt: number;
  onReclaimFn: (() => void) | undefined;
  released: boolean;
};

type PoolWaiter = {
  workspaceId: string;
  maxPerWorkspace: number;
  route: string;
  idleMs: number;
  maxMs: number;
  onReclaimFn: (() => void) | undefined;
  signal: AbortSignal | undefined;
  waitDeadlineAt: number;
  busyCode: string;
  busyMessage: string;
  settled: boolean;
  resolve: (hold: ActivePoolHold) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
};

/**
 * Per-isolate fair concurrency pool with per-workspace active & waiting caps and self-reclaiming deadlines.
 * Active holds and promoted waiters are reclaimed by the pool itself on expiry, without relying on dead workerd
 * request contexts running finally/cancel/timers.
 */
export class FairPool {
  active = 0;
  reclaimedTotal = 0;
  readonly activeByWs = new Map<string, number>();
  readonly waitingByWs = new Map<string, number>();
  readonly activeHolds = new Set<ActivePoolHold>();
  readonly queue: PoolWaiter[] = [];

  constructor(
    readonly name: string,
    readonly maxActive: number,
    readonly defaultMaxPerWs: number,
    readonly defaultMaxWaitingPerWs: number,
    readonly maxWaitingTotal: number,
  ) {}

  private inc(map: Map<string, number>, key: string, delta: number) {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key); else map.set(key, next);
  }

  private earliestHoldDeadline(): number {
    let earliest = Infinity;
    for (const h of this.activeHolds) {
      const d = !h.confirmed ? Math.min(h.confirmDeadlineAt, h.idleDeadlineAt, h.hardDeadlineAt) : Math.min(h.idleDeadlineAt, h.hardDeadlineAt);
      if (d < earliest) earliest = d;
    }
    return earliest;
  }

  private releaseHold(hold: ActivePoolHold, reclaimed: boolean) {
    if (hold.released) return;
    hold.released = true;
    this.activeHolds.delete(hold);
    this.active = Math.max(0, this.active - 1);
    this.inc(this.activeByWs, hold.workspaceId, -1);
    if (reclaimed) {
      this.reclaimedTotal++;
      const fn = hold.onReclaimFn;
      hold.onReclaimFn = undefined;
      if (fn) { try { fn(); } catch { /* best-effort cleanup */ } }
    } else {
      hold.onReclaimFn = undefined;
    }
  }

  reclaimExpired(now = Date.now()): number {
    const byRoute = new Map<string, { count: number; maxAgeMs: number; reason: string }>();
    let reclaimed = 0;
    for (const h of [...this.activeHolds]) {
      let reason: string | null = null;
      if (!h.confirmed && now >= h.confirmDeadlineAt) reason = 'unconfirmed';
      else if (now >= h.hardDeadlineAt) reason = 'hard_deadline';
      else if (now >= h.idleDeadlineAt) reason = 'idle_deadline';
      if (!reason) continue;
      const ageMs = Math.max(0, now - h.acquiredAt);
      this.releaseHold(h, true);
      reclaimed++;
      const agg = byRoute.get(h.route) ?? { count: 0, maxAgeMs: 0, reason };
      agg.count++;
      agg.maxAgeMs = Math.max(agg.maxAgeMs, ageMs);
      byRoute.set(h.route, agg);
    }
    for (const [route, stats] of byRoute) {
      log('warn', {
        code: 'READ_POOL_HOLD_RECLAIMED',
        pool: this.name,
        route,
        count: stats.count,
        ageMs: stats.maxAgeMs,
        reason: stats.reason,
      });
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i]!;
      if (w.settled) { this.queue.splice(i, 1); continue; }
      if (w.signal?.aborted) {
        this.queue.splice(i, 1);
        w.settled = true;
        this.inc(this.waitingByWs, w.workspaceId, -1);
        w.cleanup();
        w.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      if (now >= w.waitDeadlineAt) {
        this.queue.splice(i, 1);
        w.settled = true;
        this.inc(this.waitingByWs, w.workspaceId, -1);
        w.cleanup();
        w.reject(new ApiError(503, w.busyCode, w.busyMessage, undefined, true));
      }
    }
    return reclaimed;
  }

  private makeHold(workspaceId: string, route: string, idleMs: number, maxMs: number, onReclaimFn: (() => void) | undefined, confirmed: boolean, now: number): ActivePoolHold {
    const safeMax = Math.max(1, maxMs);
    const safeIdle = Math.max(1, Math.min(idleMs, safeMax));
    const hold: ActivePoolHold = {
      workspaceId,
      route,
      acquiredAt: now,
      lastProgressAt: now,
      idleMs: safeIdle,
      idleDeadlineAt: now + safeIdle,
      hardDeadlineAt: now + safeMax,
      confirmed,
      confirmDeadlineAt: now + READ_POOL_LIMITS.confirmMs,
      onReclaimFn,
      released: false,
    };
    this.activeHolds.add(hold);
    this.active++;
    this.inc(this.activeByWs, workspaceId, 1);
    return hold;
  }

  private admit(now = Date.now()) {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const idx = this.queue.findIndex(w => !w.settled && (this.activeByWs.get(w.workspaceId) ?? 0) < w.maxPerWorkspace);
      if (idx < 0) break;
      const next = this.queue.splice(idx, 1)[0]!;
      next.settled = true;
      this.inc(this.waitingByWs, next.workspaceId, -1);
      next.cleanup();
      const hold = this.makeHold(next.workspaceId, next.route, next.idleMs, next.maxMs, next.onReclaimFn, false, now);
      next.resolve(hold);
    }
  }

  private wrapHold(hold: ActivePoolHold): PoolHold {
    return {
      get released() { return hold.released; },
      touch() {
        if (hold.released) return;
        const now = Date.now();
        hold.confirmed = true;
        hold.lastProgressAt = now;
        hold.idleDeadlineAt = Math.min(hold.hardDeadlineAt, now + hold.idleMs);
      },
      setDeadlines(idleMs: number, maxMs?: number) {
        if (hold.released) return;
        const now = Date.now();
        hold.confirmed = true;
        if (maxMs !== undefined) hold.hardDeadlineAt = Math.min(hold.hardDeadlineAt, now + Math.max(1, maxMs));
        hold.idleMs = Math.max(1, idleMs);
        hold.lastProgressAt = now;
        hold.idleDeadlineAt = Math.min(hold.hardDeadlineAt, now + hold.idleMs);
      },
      onReclaim(fn: () => void) {
        if (hold.released) return;
        hold.onReclaimFn = fn;
      },
      release: () => {
        if (hold.released) return;
        this.releaseHold(hold, false);
        const now = Date.now();
        this.reclaimExpired(now);
        this.admit(now);
      },
    };
  }

  async acquire(workspaceId: string, signal: AbortSignal | undefined, opts: FairPoolAcquireOptions): Promise<PoolHold> {
    const maxPerWs = opts.maxPerWs ?? this.defaultMaxPerWs;
    const maxWaitingPerWs = opts.maxWaitingPerWs ?? this.defaultMaxWaitingPerWs;
    const route = opts.route ?? this.name;
    const idleMs = opts.idleMs ?? READ_POOL_LIMITS.defaultIdleMs;
    const maxMs = opts.maxMs ?? READ_POOL_LIMITS.defaultMaxMs;
    const maxWaitMs = opts.maxWaitMs ?? READ_POOL_LIMITS.maxWaitMs;
    const now = Date.now();

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.reclaimExpired(now);
    this.admit(now);

    if (this.active < this.maxActive && (this.activeByWs.get(workspaceId) ?? 0) < maxPerWs) {
      return this.wrapHold(this.makeHold(workspaceId, route, idleMs, maxMs, opts.onReclaim, true, now));
    }
    if ((this.waitingByWs.get(workspaceId) ?? 0) >= maxWaitingPerWs) {
      throw new ApiError(429, opts.wsBusyCode, opts.wsBusyMessage, undefined, true);
    }
    if (this.queue.length >= this.maxWaitingTotal) {
      throw new ApiError(503, opts.busyCode, opts.busyMessage, undefined, true);
    }

    const hold = await new Promise<ActivePoolHold>((resolve, reject) => {
      let wakeTimer: ReturnType<typeof setTimeout> | undefined;
      const clearWake = () => { if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; } };
      const onAbort = () => {
        if (entry.settled) return;
        entry.settled = true;
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.inc(this.waitingByWs, entry.workspaceId, -1);
        entry.cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        const t = Date.now();
        this.reclaimExpired(t);
        this.admit(t);
      };
      const entry: PoolWaiter = {
        workspaceId,
        maxPerWorkspace: maxPerWs,
        route,
        idleMs,
        maxMs,
        onReclaimFn: opts.onReclaim,
        signal,
        waitDeadlineAt: now + maxWaitMs,
        busyCode: opts.busyCode,
        busyMessage: opts.busyMessage,
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          clearWake();
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const armWake = () => {
        clearWake();
        if (entry.settled) return;
        const t = Date.now();
        const target = Math.min(entry.waitDeadlineAt, this.earliestHoldDeadline());
        const delay = Math.max(25, Math.min(5_000, Number.isFinite(target) ? target - t + 20 : 1_000));
        wakeTimer = setTimeout(() => {
          wakeTimer = undefined;
          const tickNow = Date.now();
          this.reclaimExpired(tickNow);
          this.admit(tickNow);
          if (!entry.settled) armWake();
        }, delay);
        (wakeTimer as unknown as { unref?: () => void }).unref?.();
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.inc(this.waitingByWs, workspaceId, 1);
      this.queue.push(entry);
      this.admit(now);
      if (!entry.settled) armWake();
    });

    if (hold.released) {
      throw new ApiError(503, opts.busyCode, opts.busyMessage, undefined, true);
    }
    const resumeNow = Date.now();
    hold.confirmed = true;
    hold.acquiredAt = resumeNow;
    hold.lastProgressAt = resumeNow;
    hold.idleDeadlineAt = resumeNow + hold.idleMs;
    hold.hardDeadlineAt = resumeNow + Math.max(1, maxMs);
    return this.wrapHold(hold);
  }

  stats() {
    this.reclaimExpired();
    return { active: this.active, waiting: this.queue.length, reclaimedTotal: this.reclaimedTotal };
  }
}

export function createFairPool(config: { name: string; maxActive: number; maxPerWorkspace: number; maxWaitingPerWorkspace: number; maxWaitingTotal: number }) {
  return new FairPool(config.name, config.maxActive, config.maxPerWorkspace, config.maxWaitingPerWorkspace, config.maxWaitingTotal);
}

/** Shared bounded-read pool across audience, inbound, and sending list/query endpoints. */
export const readPool = new FairPool('read', READ_MAX_ACTIVE, READ_MAX_ACTIVE_PER_WORKSPACE, READ_MAX_WAITING_PER_WORKSPACE, READ_MAX_WAITERS);
export const boundedReadsActive = () => readPool.stats().active;

/**
 * Resolves the authenticated workspace ID across all credential types (API keys, dashboard, agent tokens,
 * inbox/address keys via mailboxAccess, support grants, MCP principals). Never falls back to a shared bucket:
 * refuses with 401 AUTH_REQUIRED when no workspace ID can be determined.
 */
export function resolveReadWorkspaceId(c: Ctx, explicitWorkspaceId?: string): string {
  const candidates = [
    explicitWorkspaceId,
    c.get('actor')?.workspaceId,
    c.get('mailboxAccess')?.workspaceId,
    c.get('support')?.contentWorkspaceId ?? undefined,
    c.get('support')?.conversation.workspaceId ?? undefined,
    c.get('principal')?.workspace,
  ];
  for (const id of candidates) {
    if (typeof id === 'string' && id.trim().length > 0) return id;
  }
  throw new ApiError(401, 'AUTH_REQUIRED', 'An authenticated workspace is required for this read.');
}

/**
 * Runs a bounded read inside the isolate's fair per-workspace read pool (isolated from attachment/import memory).
 * Sets Retry-After on 429/503 and returns 499 if the client disconnects while queued.
 */
export async function withBoundedRead<T>(
  c: Ctx,
  work: (hold: PoolHold) => Promise<T>,
  opts: { route?: string; workspaceId?: string; idleMs?: number; maxMs?: number; maxWaitMs?: number } = {},
): Promise<T | Response> {
  const workspaceId = resolveReadWorkspaceId(c, opts.workspaceId);
  let hold: PoolHold;
  try {
    hold = await readPool.acquire(workspaceId, c.req.raw.signal, {
      route: opts.route ?? 'bounded.read',
      idleMs: opts.idleMs,
      maxMs: opts.maxMs,
      maxWaitMs: opts.maxWaitMs,
      busyCode: 'READ_CONCURRENCY_LIMIT',
      busyMessage: 'Too many concurrent reads are running; retry in a moment.',
      wsBusyCode: 'READ_CONCURRENCY_LIMIT',
      wsBusyMessage: 'Too many concurrent reads are in flight for this workspace; retry in a moment.',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return new Response(null, { status: 499 });
    if (err instanceof ApiError && (err.status === 429 || err.status === 503)) c.header('Retry-After', '1');
    throw err;
  }
  try {
    if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 });
    return await work(hold);
  } finally {
    hold.release();
  }
}

type LeasedStreamOptions = { idleMs?: number; maxMs?: number; timeoutError?: () => Error };

/**
 * A response body that holds `lease` until it is read, canceled or aborted, or goes past its idle or hard deadline: a
 * deadline errors the stream, from its own timers or from the budget's reclaim (for a request workerd cancelled), and
 * drops `chunks` (and the bytes they come from). Null when the request is already aborted. A lease the budget already
 * reclaimed (its holder waited past the default deadline) fails as busy rather than serving uncounted bytes.
 */
function leasedBody(c: Ctx, lease: MemoryLease, chunks: Iterator<Uint8Array>, opts: LeasedStreamOptions): ReadableStream<Uint8Array> | null {
  if (lease.released) {
    c.header('Retry-After', '1');
    throw new ApiError(503, 'ISOLATE_MEMORY_BUSY', 'The server is busy; retry in a moment.', undefined, true);
  }
  const maxMs = opts.maxMs ?? MEMORY_LIMITS.streamMaxMs;
  const idleMs = Math.min(opts.idleMs ?? MEMORY_LIMITS.streamIdleMs, maxMs);
  lease.setDeadlines(idleMs, maxMs);
  let source: Iterator<Uint8Array> | null = chunks;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  keepAlive(c, new Promise<void>(r => { resolveDone = r; }));

  const signal = c.req.raw.signal;
  const finish = (timedOut: boolean) => {
    if (!source) return;
    source = null;
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (hardTimer !== undefined) { clearTimeout(hardTimer); hardTimer = undefined; }
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) {
      const err = opts.timeoutError ? opts.timeoutError() : new ApiError(504, 'DOWNLOAD_TIMEOUT', 'The response was not read in time.');
      try { controllerRef?.error(err); } catch { /* already closed */ }
    }
    lease.release();
    resolveDone();
  };
  const onAbort = () => finish(false);
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (!source || idleMs >= maxMs) return;
    idleTimer = setTimeout(() => finish(true), idleMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  };

  lease.onReclaim(() => finish(true));
  if (signal?.aborted) { finish(false); return null; }
  signal?.addEventListener('abort', onAbort, { once: true });
  hardTimer = setTimeout(() => finish(true), maxMs);
  (hardTimer as unknown as { unref?: () => void }).unref?.();

  return new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; armIdle(); },
    pull(controller) {
      if (!source) return;
      const next = source.next();
      if (next.done) { controller.close(); finish(false); return; }
      controller.enqueue(next.value);
      lease.touch();
      armIdle();
    },
    cancel() { finish(false); },
  });
}

/**
 * Streams a binary payload as canonical base64 inside a JSON envelope (`metaJsonWithEmptyContent` ending in `""}`)
 * while holding a self-reclaiming MemoryLease (leasedBody).
 */
export function streamBase64JsonResponse(c: Ctx, lease: MemoryLease, metaJsonWithEmptyContent: string, bytes: Uint8Array, opts: LeasedStreamOptions = {}): Response {
  const encoder = new TextEncoder(), step = 3 * 64 * 1024;
  const body = leasedBody(c, lease, (function* () {
    yield encoder.encode(metaJsonWithEmptyContent.slice(0, -2));
    for (let at = 0; at < bytes.length; at += step) yield encoder.encode(Buffer.from(bytes.buffer, bytes.byteOffset + at, Math.min(step, bytes.length - at)).toString('base64'));
    yield encoder.encode(metaJsonWithEmptyContent.slice(-2));
  })(), opts);
  if (!body) return new Response(null, { status: 499 });
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(body, 200, { 'content-type': 'application/json' }) as unknown as Response;
}

/** Streams `bytes` as they are in 64 KiB chunks with `headers`, holding a self-reclaiming MemoryLease (leasedBody). */
export function streamBytesResponse(c: Ctx, lease: MemoryLease, bytes: Uint8Array, headers: Record<string, string>, opts: LeasedStreamOptions = {}): Response {
  const step = 64 * 1024;
  const body = leasedBody(c, lease, (function* () { for (let at = 0; at < bytes.length; at += step) yield bytes.subarray(at, at + step); })(), opts);
  return body ? new Response(body, { headers }) : new Response(null, { status: 499 });
}

/**
 * Streams pre-serialized JSON text segments in 64 KiB chunks while holding a self-reclaiming MemoryLease (and optional
 * PoolHold). Releases on completion, cancel, abort signal, idle progress timeout, or hard absolute deadline.
 */
export function streamTextPartsResponse(
  c: Ctx,
  parts: string[],
  status: 200 | 201,
  opts: { lease?: MemoryLease; hold?: PoolHold; idleMs?: number; maxMs?: number } = {},
): Response {
  const maxMs = opts.maxMs ?? MEMORY_LIMITS.streamMaxMs;
  const idleMs = Math.min(opts.idleMs ?? MEMORY_LIMITS.streamIdleMs, maxMs);
  opts.lease?.setDeadlines(idleMs, maxMs);
  opts.hold?.setDeadlines(idleMs, maxMs);
  const encoder = new TextEncoder();
  let partIndex = 0, offset = 0, closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const donePromise = new Promise<void>(r => { resolveDone = r; });
  keepAlive(c, donePromise);

  const signal = c.req.raw.signal;
  const clearTimers = () => {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (hardTimer !== undefined) { clearTimeout(hardTimer); hardTimer = undefined; }
  };
  const finish = (timedOut: boolean) => {
    if (closed) return;
    closed = true;
    clearTimers();
    parts.length = 0;
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) {
      try { controllerRef?.error(new Error('Stream response read timed out.')); } catch { /* already closed */ }
    }
    opts.lease?.release();
    opts.hold?.release();
    resolveDone();
  };
  const onAbort = () => finish(false);
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (closed || idleMs >= maxMs) return;
    idleTimer = setTimeout(() => finish(true), idleMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  };

  opts.lease?.onReclaim(() => finish(true));
  opts.hold?.onReclaim(() => finish(true));
  if (signal?.aborted) {
    finish(false);
    return new Response(null, { status: 499 });
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  hardTimer = setTimeout(() => finish(true), maxMs);
  (hardTimer as unknown as { unref?: () => void }).unref?.();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      armIdle();
    },
    pull(controller) {
      if (closed) return;
      while (partIndex < parts.length) {
        const part = parts[partIndex]!;
        if (offset < part.length) {
          const next = Math.min(part.length, offset + 65536);
          controller.enqueue(encoder.encode(part.slice(offset, next)));
          offset = next;
          opts.lease?.touch();
          opts.hold?.touch();
          armIdle();
          return;
        }
        parts[partIndex] = '';
        partIndex++;
        offset = 0;
      }
      finish(false);
      controller.close();
    },
    cancel() { finish(false); },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
}
