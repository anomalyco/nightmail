import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from './core/errors.js';
import { log } from './log.js';
import { SEND_LIMITS } from './send-limits.js';

// One byte budget for every path that holds large payloads in memory: raw uploads, attachment downloads, template asset
// downloads, linked campaign images, visual previews, contact imports, dispatcher pages with attachments or large bodies,
// and inbox mail copies / Sent archives.
// A Worker isolate has 128 MB for all requests at once and the loaded app holds ~25 MB, so these paths share at most
// SEND_LIMITS.isolateWorkingBytes (64 MiB).
//
// Self-reclaiming invariant: under workerd, when a client disconnects mid-response or the runtime cancels a request,
// request-owned finally blocks, ReadableStream.cancel() callbacks, and request-owned timers may never run. Every active
// hold and queued waiter therefore carries explicit deadlines tracked inside this budget itself. On every reserve(),
// shrink(), release(), and live-waiter timer tick, reclaimExpired() sweeps expired active holds and unconfirmed
// promoted waiters without relying on the dead request's code, logs once per route class, and makes any late release()
// a safe no-op.
const budget = SEND_LIMITS.isolateWorkingBytes;


/** Tunable isolate memory budget deadlines and fairness bounds (exported for tests). */
export const MEMORY_LIMITS = {
  /** Default idle deadline (ms) after last touch() for non-streaming holds. */
  defaultIdleMs: 30_000,
  /** Default absolute hard cap (ms) from acquisition for non-streaming holds. */
  defaultMaxMs: 120_000,
  /** Default idle deadline (ms) after last accepted stream chunk for streamed responses. */
  streamIdleMs: 6_000,
  /** Default absolute hard cap (ms) for streamed responses regardless of progress. */
  streamMaxMs: 60_000,
  /** Time (ms) a promoted waiter has to resume its microtask before being reclaimed as dead. */
  confirmMs: 1_000,
  /** Maximum time (ms) a queued waiter may wait before timing out / being swept. */
  maxWaitMs: 30_000,
  /** Per-workspace byte share cap (leaves headroom for other workspaces' small requests even while full). */
  maxWorkspaceBytes: 60 * 1024 * 1024,
  /** Maximum queued waiters per workspace before answering retryable 429. */
  maxWaitingPerWorkspace: 8,
  /** Maximum total queued waiters across all workspaces before answering retryable 503. */
  maxWaitingTotal: 32,
};

export type MemoryLeaseOptions = {
  /** Route class label recorded in reclaim logs (e.g. 'attachment.download', 'template.asset', 'import.read'). */
  route?: string;
  /** Optional workspace ID for per-workspace byte share and wait caps. */
  workspaceId?: string;
  /** Optional request AbortSignal to cancel waiting immediately and release best-effort on abort. */
  signal?: AbortSignal;
  /** Idle deadline (ms) after last touch() before the budget reclaims this hold. */
  idleMs?: number;
  /** Hard absolute cap (ms) from acquisition before the budget reclaims this hold regardless of touch(). */
  maxMs?: number;
  /** Maximum time (ms) to wait in queue before rejecting with retryable 503. */
  maxWaitMs?: number;
  /** Override per-workspace byte cap for this hold (always at least the requested byte size). */
  maxWorkspaceBytes?: number;
  /** Optional best-effort cleanup invoked if the budget reclaims this hold by deadline. */
  onReclaim?: () => void;
  /** Error code when this workspace exceeds its queued waiter cap. */
  wsBusyCode?: string;
  /** Error code when the isolate's global memory queue is full or wait deadline expires. */
  busyCode?: string;
};

export type MemoryLease = {
  /** Record forward progress (e.g. stream chunk accepted by the runtime), extending the idle deadline up to hard cap. */
  touch(): void;
  /** Shrink the reservation (e.g. from parse peak down to unread stream bytes) and wake queued waiters. */
  shrink(newBytes: number): void;
  /** Resize without queuing, counting as progress; false (unchanged) once released or when growing would pass the isolate, workspace or route cap. */
  tryResize(newBytes: number): boolean;
  /** Update idle/hard deadlines (e.g. when handing a lease to a response stream). */
  setDeadlines(idleMs: number, maxMs?: number): void;
  /** Register a best-effort cleanup callback run if the budget reclaims this hold by deadline. */
  onReclaim(fn: () => void): void;
  /** Idempotent release; a late call after timeout reclaim is a no-op and never double-subtracts bytes. */
  release(): void;
  /** True once released or reclaimed. */
  readonly released: boolean;
};

type ActiveHold = {
  bytes: number;
  workspaceId: string | undefined;
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
  /** Most bytes all holds of this route may hold at once (tryReserveMemory's routeCap). */
  routeCap?: number;
};

type Waiter = {
  bytes: number;
  workspaceId: string | undefined;
  wsCap: number;
  route: string;
  idleMs: number;
  maxMs: number;
  onReclaimFn: (() => void) | undefined;
  signal: AbortSignal | undefined;
  waitDeadlineAt: number;
  busyCode: string;

  settled: boolean;
  resolve: (hold: ActiveHold) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
};

let used = 0;
let reclaimedTotal = 0;
const usedByWs = new Map<string, number>();
const waitingByWs = new Map<string, number>();
const activeHolds = new Set<ActiveHold>();
const waiting: Waiter[] = [];

/**
 * Idle buffers kept for reuse (verified attachments, src/sending.ts verifiedAttachment). They are memory the isolate
 * holds just as a hold is, so the budget counts them: whenever holds, caches and a new reservation together would pass
 * it, the oldest cached bytes are dropped first. `evict(bytes)` drops at least that many, or everything it holds.
 */
export type MemoryCache = { bytes(): number; evict(bytes: number): void };
const caches: MemoryCache[] = [];
export function registerMemoryCache(cache: MemoryCache) { caches.push(cache); }
const cachedBytes = () => caches.reduce((n, cache) => n + cache.bytes(), 0);
/** Drops cached bytes until holds, caches and `needed` more fit the budget (as far as the caches can give). */
export function fitMemoryCaches(needed = 0) {
  for (const cache of caches) {
    const over = used + cachedBytes() + needed - budget;
    if (over <= 0) return;
    cache.evict(over);
  }
}

// Tracks the outer lease scope so nested withMemory()/reserveMemory() calls up to that size don't deadlock on themselves.
const holding = new AsyncLocalStorage<{ bytes: number; touch: () => void }>();

function adjustMap(map: Map<string, number>, key: string | undefined, delta: number) {
  if (!key) return;
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

// Fits when the holds leave room; cached bytes are then dropped as far as the reservation needs theirs.
function canFit(bytes: number, workspaceId: string | undefined, wsCap: number): boolean {
  if (used + bytes > budget) return false;
  if (workspaceId !== undefined && (usedByWs.get(workspaceId) ?? 0) + bytes > wsCap) return false;
  fitMemoryCaches(bytes);
  return true;
}

function heldByRoute(route: string) {
  let bytes = 0;
  for (const h of activeHolds) if (h.route === route) bytes += h.bytes;
  return bytes;
}

function earliestHoldDeadline(): number {
  let earliest = Infinity;
  for (const h of activeHolds) {
    const d = !h.confirmed ? Math.min(h.confirmDeadlineAt, h.idleDeadlineAt, h.hardDeadlineAt) : Math.min(h.idleDeadlineAt, h.hardDeadlineAt);
    if (d < earliest) earliest = d;
  }
  return earliest;
}

function releaseHold(hold: ActiveHold, reclaimed: boolean) {
  if (hold.released) return;
  hold.released = true;
  activeHolds.delete(hold);
  used = Math.max(0, used - hold.bytes);
  adjustMap(usedByWs, hold.workspaceId, -hold.bytes);
  hold.bytes = 0;
  if (reclaimed) {
    reclaimedTotal++;
    const fn = hold.onReclaimFn;
    hold.onReclaimFn = undefined;
    if (fn) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  } else {
    hold.onReclaimFn = undefined;
  }
}

/**
 * Sweeps any active holds past their confirm/idle/hard deadlines and any queued waiters past their wait deadline or
 * aborted signal. Runs synchronously inside whichever live request enters or waits on the budget, so dead workerd
 * request contexts can never wedge the isolate.
 */
export function reclaimExpiredMemory(now = Date.now()): number {
  const byRoute = new Map<string, { count: number; bytes: number; maxAgeMs: number; reason: string }>();
  let reclaimed = 0;
  for (const h of [...activeHolds]) {
    let reason: string | null = null;
    if (!h.confirmed && now >= h.confirmDeadlineAt) reason = 'unconfirmed';
    else if (now >= h.hardDeadlineAt) reason = 'hard_deadline';
    else if (now >= h.idleDeadlineAt) reason = 'idle_deadline';
    if (!reason) continue;
    const heldBytes = h.bytes;
    const ageMs = Math.max(0, now - h.acquiredAt);
    releaseHold(h, true);
    reclaimed++;
    const agg = byRoute.get(h.route) ?? { count: 0, bytes: 0, maxAgeMs: 0, reason };
    agg.count++;
    agg.bytes += heldBytes;
    agg.maxAgeMs = Math.max(agg.maxAgeMs, ageMs);
    byRoute.set(h.route, agg);
  }
  for (const [route, stats] of byRoute) {
    log('warn', {
      code: 'ISOLATE_MEMORY_HOLD_RECLAIMED',
      route,
      count: stats.count,
      bytes: stats.bytes,
      ageMs: stats.maxAgeMs,
      reason: stats.reason,
    });
  }
  for (let i = waiting.length - 1; i >= 0; i--) {
    const w = waiting[i]!;
    if (w.settled) { waiting.splice(i, 1); continue; }
    if (w.signal?.aborted) {
      waiting.splice(i, 1);
      w.settled = true;
      adjustMap(waitingByWs, w.workspaceId, -1);
      w.cleanup();
      w.reject(new DOMException('Aborted', 'AbortError'));
      continue;
    }
    if (now >= w.waitDeadlineAt) {
      waiting.splice(i, 1);
      w.settled = true;
      adjustMap(waitingByWs, w.workspaceId, -1);
      w.cleanup();
      w.reject(new ApiError(503, w.busyCode, 'The server is busy; retry in a moment.', undefined, true));
    }
  }
  return reclaimed;
}

function makeHold(
  bytes: number,
  workspaceId: string | undefined,
  route: string,
  idleMs: number,
  maxMs: number,
  onReclaimFn: (() => void) | undefined,
  confirmed: boolean,
  now: number,
): ActiveHold {
  const safeMax = Math.max(1, maxMs);
  const safeIdle = Math.max(1, Math.min(idleMs, safeMax));
  const hold: ActiveHold = {
    bytes,
    workspaceId,
    route,
    acquiredAt: now,
    lastProgressAt: now,
    idleMs: safeIdle,
    idleDeadlineAt: now + safeIdle,
    hardDeadlineAt: now + safeMax,
    confirmed,
    confirmDeadlineAt: now + MEMORY_LIMITS.confirmMs,
    onReclaimFn,
    released: false,
  };
  activeHolds.add(hold);
  used += bytes;
  adjustMap(usedByWs, workspaceId, bytes);
  return hold;
}

function admit(now = Date.now()) {
  for (;;) {
    if (!waiting.length) return;
    const head = waiting[0]!;
    if (head.settled) { waiting.shift(); continue; }
    if (canFit(head.bytes, head.workspaceId, head.wsCap)) {
      waiting.shift();
      head.settled = true;
      adjustMap(waitingByWs, head.workspaceId, -1);
      head.cleanup();
      const hold = makeHold(head.bytes, head.workspaceId, head.route, head.idleMs, head.maxMs, head.onReclaimFn, false, now);
      head.resolve(hold);
      continue;
    }
    // Preserve arrival order globally; only bypass a head waiter blocked solely by its own workspace share so
    // one workspace sitting at its share cap cannot block other workspaces.
    const headBlockedByOwnWs = head.workspaceId !== undefined && (usedByWs.get(head.workspaceId) ?? 0) + head.bytes > head.wsCap;
    if (!headBlockedByOwnWs) return;
    const idx = waiting.findIndex((w, i) => i > 0 && !w.settled && canFit(w.bytes, w.workspaceId, w.wsCap));
    if (idx < 0) return;
    const [other] = waiting.splice(idx, 1);
    other!.settled = true;
    adjustMap(waitingByWs, other!.workspaceId, -1);
    other!.cleanup();
    const hold = makeHold(other!.bytes, other!.workspaceId, other!.route, other!.idleMs, other!.maxMs, other!.onReclaimFn, false, now);
    other!.resolve(hold);
  }
}

function wrapHold(hold: ActiveHold): MemoryLease {
  const lease: MemoryLease = {
    get released() { return hold.released; },
    touch() {
      if (hold.released) return;
      const now = Date.now();
      hold.confirmed = true;
      hold.lastProgressAt = now;
      hold.idleDeadlineAt = Math.min(hold.hardDeadlineAt, now + hold.idleMs);
    },
    shrink(newBytes: number) {
      if (hold.released) return;
      const next = Math.max(1, Math.min(hold.bytes, Math.ceil(newBytes)));
      if (next < hold.bytes) {
        const delta = hold.bytes - next;
        hold.bytes = next;
        used = Math.max(0, used - delta);
        adjustMap(usedByWs, hold.workspaceId, -delta);
        const now = Date.now();
        reclaimExpiredMemory(now);
        admit(now);
      }
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
    tryResize(newBytes: number) {
      reclaimExpiredMemory();
      if (hold.released) return false;
      const next = Math.max(1, Math.ceil(newBytes)), delta = next - hold.bytes;
      if (delta > 0) {
        if (heldByRoute(hold.route) + delta > (hold.routeCap ?? budget) || !canFit(delta, hold.workspaceId, MEMORY_LIMITS.maxWorkspaceBytes)) return false;
        hold.bytes = next;
        used += delta;
        adjustMap(usedByWs, hold.workspaceId, delta);
      } else lease.shrink(next);
      lease.touch();
      return true;
    },
    onReclaim(fn: () => void) {
      if (hold.released) return;
      hold.onReclaimFn = fn;
    },
    release() {
      if (hold.released) return;
      releaseHold(hold, false);
      const now = Date.now();
      reclaimExpiredMemory(now);
      admit(now);
    },
  };
  return lease;
}

/**
 * Reserves `bytes` (at most the whole isolate budget) and resolves once they are free.
 * Every hold is self-reclaiming by deadline even if the calling request's runtime context is cancelled.
 * Release is idempotent: a late release after timeout reclaim is a safe no-op.
 */
export async function reserveMemory(bytes: number, opts: MemoryLeaseOptions = {}): Promise<MemoryLease> {
  const n = Math.max(1, Math.min(budget, Math.ceil(bytes)));
  const route = opts.route ?? 'general';
  const idleMs = opts.idleMs ?? MEMORY_LIMITS.defaultIdleMs;
  const maxMs = opts.maxMs ?? MEMORY_LIMITS.defaultMaxMs;
  const now = Date.now();

  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  reclaimExpiredMemory(now);
  admit(now);

  const outer = holding.getStore();
  if (outer) {
    if (n <= outer.bytes) {
      let done = false;
      return {
        get released() { return done; },
        touch() { if (!done) outer.touch(); },
        shrink() {},
        tryResize: next => !done && next <= outer.bytes,
        setDeadlines() {},
        onReclaim() {},
        release() { done = true; },
      };
    }
    log('warn', { code: 'ISOLATE_MEMORY_NESTED_GROWTH', heldBytes: outer.bytes, neededBytes: n, route });
    fitMemoryCaches(n - outer.bytes);
    const delta = makeHold(n - outer.bytes, opts.workspaceId, route, idleMs, maxMs, opts.onReclaim, true, now);
    return wrapHold(delta);
  }

  const wsCap = Math.max(n, opts.maxWorkspaceBytes ?? MEMORY_LIMITS.maxWorkspaceBytes);
  if (waiting.length === 0 && canFit(n, opts.workspaceId, wsCap)) {
    const hold = makeHold(n, opts.workspaceId, route, idleMs, maxMs, opts.onReclaim, true, now);
    return wrapHold(hold);
  }
  // If other workspaces are queued behind a workspace at its cap, still try fast-path if head allows bypass via admit().
  if (opts.workspaceId !== undefined && (waitingByWs.get(opts.workspaceId) ?? 0) >= MEMORY_LIMITS.maxWaitingPerWorkspace) {
    throw new ApiError(429, opts.wsBusyCode ?? 'MEMORY_CONCURRENCY_LIMIT', 'Too many concurrent large requests in this workspace; retry shortly.', undefined, true);
  }
  if (waiting.length >= MEMORY_LIMITS.maxWaitingTotal) {
    throw new ApiError(503, opts.busyCode ?? 'ISOLATE_MEMORY_BUSY', 'The server is busy; retry in a moment.', undefined, true);
  }

  const maxWaitMs = opts.maxWaitMs ?? MEMORY_LIMITS.maxWaitMs;
  const hold = await new Promise<ActiveHold>((resolve, reject) => {
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const clearWake = () => { if (wakeTimer !== undefined) { clearTimeout(wakeTimer); wakeTimer = undefined; } };
    const onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      const idx = waiting.indexOf(entry);
      if (idx >= 0) waiting.splice(idx, 1);
      adjustMap(waitingByWs, entry.workspaceId, -1);
      entry.cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
      const t = Date.now();
      reclaimExpiredMemory(t);
      admit(t);
    };
    const entry: Waiter = {
      bytes: n,
      workspaceId: opts.workspaceId,
      wsCap,
      route,
      idleMs,
      maxMs,
      onReclaimFn: opts.onReclaim,
      signal: opts.signal,
      waitDeadlineAt: now + maxWaitMs,
      busyCode: opts.busyCode ?? 'ISOLATE_MEMORY_BUSY',

      settled: false,
      resolve,
      reject,
      cleanup: () => {
        clearWake();
        opts.signal?.removeEventListener('abort', onAbort);
      },
    };
    // Schedule a wakeup timer inside THIS live waiting request's IoContext so dead active holds are reclaimed on time
    // even when every previous holder's IoContext was cancelled by workerd.
    const armWake = () => {
      clearWake();
      if (entry.settled) return;
      const t = Date.now();
      const target = Math.min(entry.waitDeadlineAt, earliestHoldDeadline());
      const delay = Math.max(25, Math.min(5_000, Number.isFinite(target) ? target - t + 20 : 1_000));
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        const tickNow = Date.now();
        reclaimExpiredMemory(tickNow);
        admit(tickNow);
        if (!entry.settled) armWake();
      }, delay);
      (wakeTimer as unknown as { unref?: () => void }).unref?.();
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    adjustMap(waitingByWs, entry.workspaceId, 1);
    waiting.push(entry);
    admit(now);
    if (!entry.settled) armWake();
  });

  // Immediately confirm on the very next microtask so admit() knows this waiter's IoContext is still alive.
  if (hold.released) {
    // Reclaimed before this microtask ran (extreme delay): fail cleanly instead of running uncounted.
    throw new ApiError(503, opts.busyCode ?? 'ISOLATE_MEMORY_BUSY', 'The server is busy; retry in a moment.', undefined, true);
  }
  const resumeNow = Date.now();
  hold.confirmed = true;
  hold.acquiredAt = resumeNow;
  hold.lastProgressAt = resumeNow;
  hold.idleDeadlineAt = resumeNow + hold.idleMs;
  hold.hardDeadlineAt = resumeNow + Math.max(1, maxMs);
  return wrapHold(hold);
}

/**
 * Reserves `bytes` at once or returns null, never queuing: for work that answers "busy, retry" instead of waiting.
 * Fits only when nobody is queued and the bytes fit the isolate budget, the workspace share and `routeCap` (the most all
 * holds of `route` may hold together). Self-reclaiming by deadline like reserveMemory.
 */
export function tryReserveMemory(bytes: number, opts: Pick<MemoryLeaseOptions, 'route' | 'workspaceId' | 'idleMs' | 'maxMs'> & { routeCap?: number } = {}): MemoryLease | null {
  const n = Math.max(1, Math.ceil(bytes)), route = opts.route ?? 'general', routeCap = opts.routeCap ?? budget, now = Date.now();
  reclaimExpiredMemory(now);
  admit(now);
  if (waiting.length || heldByRoute(route) + n > routeCap || !canFit(n, opts.workspaceId, Math.max(n, MEMORY_LIMITS.maxWorkspaceBytes))) return null;
  const hold = makeHold(n, opts.workspaceId, route, opts.idleMs ?? MEMORY_LIMITS.defaultIdleMs, opts.maxMs ?? MEMORY_LIMITS.defaultMaxMs, undefined, true, now);
  hold.routeCap = routeCap;
  return wrapHold(hold);
}

/** Runs `work` inside an existing lease's memory scope so nested `withMemory` calls up to `heldBytes` do not double-charge. */
export function runInMemoryScope<T>(heldBytes: number, work: () => Promise<T>, touch?: () => void): Promise<T> {
  const outer = holding.getStore();
  const scopeTouch = () => { touch?.(); outer?.touch(); };
  return holding.run({ bytes: Math.max(outer?.bytes ?? 0, Math.min(budget, Math.ceil(heldBytes))), touch: scopeTouch }, work);
}

/** Runs `work` holding `bytes` of the isolate's budget, releasing on return or throw (and reclaiming by deadline if cancelled). */
export async function withMemory<T>(bytes: number, work: () => Promise<T>, opts: MemoryLeaseOptions = {}): Promise<T> {
  const held = await reserveMemory(bytes, opts);
  try {
    return await runInMemoryScope(bytes, work, () => held.touch());
  } finally {
    held.release();
  }
}

/** What the budget has handed out now (sweeps expired holds first so callers see accurate live usage). */
export const memoryInUse = () => {
  reclaimExpiredMemory();
  return used;
};

/** Diagnostic snapshot of active holds, waiters, and reclaimed holds (for tests and metrics). */
export const memoryStats = () => {
  reclaimExpiredMemory();
  return { usedBytes: used, cachedBytes: cachedBytes(), activeHolds: activeHolds.size, waitingCount: waiting.length, reclaimedTotal };
};

/** A dispatcher page's peak: per byte of files, the files and the SES JSON body with their base64 (4/3), and for raw
 * MIME (inline images, at most the lane budget of files) also the message (1.37) and its base64 again (1.83); per byte
 * of body text, the snapshot, its rendered copy and the JSON body. */
export const sendReservation = (files: number, content: number) => files * (files <= SEND_LIMITS.laneBytes ? 4.25 : 2.5) + content * 3;
// Trusted per-request response byte budget set by internal callers (such as MCP tools/call) so large single-object
// handlers fail before loading multi-megabyte payloads and paginated list handlers size pages to fit.
const responseLimits = new WeakMap<Request, number>();
export const setResponseByteLimit = (request: Request, bytes: number) => { responseLimits.set(request, bytes); };
export const responseByteLimit = (request: Request): number | undefined => responseLimits.get(request);
export function assertResponseWithinLimit(request: Request, estimatedBytes: number) {
  const limit = responseLimits.get(request);
  if (limit !== undefined && estimatedBytes > limit) {
    throw new ApiError(413, 'RESPONSE_TOO_LARGE', 'Response exceeds the caller byte limit; fetch via REST or request a smaller page.');
  }
}
