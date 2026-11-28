import { sql } from 'drizzle-orm';
import { logError, type Config, type Runtime } from './core.js';
import { log } from './log.js';

// A second classifier in the shadow of the content screen. Each primary request not routed to the failover gate (src/screen.ts
// evaluate: a cache miss, one request per window) is repeated to it afterwards with the same state and questions, and
// both answers are kept as one screen_comparisons row (migration 452), for operators to compare
// (GET /v1/operator/screen-comparison). A comparison decides nothing: the screen's verdict, cache, budget and thresholds never
// read anything here, and a request the screen did not make (a cached verdict, a handover, no screen) is not repeated.
//
// What is awaited where:
// - src/screen.ts evaluate keeps the request it just made (keepShadow): assignments into a buffer in memory, nothing awaited.
// - When a dispatch run or a job drain has ended (src/dispatcher.ts runDispatcher, src/jobs.ts processJobs), flushShadow
//   hands the buffer over and returns at once. Nothing in a run or a drain ever waits for the second classifier.
// - On Node the hand-over is to a ShadowRunner in this process, which calls the second classifier in the background.
//   On Cloudflare it is messages on a queue of its own (the JEVF_QUEUE binding, enqueueShadow), one per request, and
//   the queue's consumer (src/worker.ts queue, consumeShadow) runs the same ShadowRunner over each batch: an invocation
//   waits on at most six connections at once, so a call that takes seconds must not share one with SES sends or the
//   screen's own 500 ms requests. With no queue bound there is nowhere to make the calls, and the feature is off.
// The runner has its own deadline per call, a cap on calls in flight, a pause for as long as a 429 or 503 says
// (Retry-After), and a breaker: after FAILURES_TO_OPEN failures in a row it stops calling for OPEN_MS (doubling to
// MAX_OPEN_MS while a single probe keeps failing). A request that isn't repeated still gets its row, with the screen's
// side and why (skipped_breaker, skipped_rate_limited, skipped_backlog). The second classifier is never asked twice
// for one request: a queue message that is delivered again is not called again, its row says lost unless the first
// delivery wrote it, and a pair is written once (pair_id). Rows hold IDs, digests, scores, codes and milliseconds:
// the request's text exists only in memory and, on Cloudflare, in its queue message until that is consumed. Unset
// JEVF_API_KEY and none of this runs.

export type ShadowSettings = NonNullable<Config['shadow']>;
/** One request the screen made, to be repeated. */
export type ShadowItem = {
  /** The pair's own ID: a row is written once per ID. */
  id: string;
  /** When the screen's request started. */
  at: number;
  workspaceId?: string; kind: 'email' | 'campaign_test' | 'campaign_copy'; emailId?: string; campaignId?: string;
  /** The verdict cache key of a message (src/screen.ts screenSnapshot) or a campaign copy's key (copyKey). */
  digest: string; window: number; windows: number;
  /** The cutoffs in effect when Jev was asked. Older queue messages used one cutoff for both. */
  threshold: number;
  jevfThreshold?: number;
  jev: { outcome?: string; httpStatus?: number; ms?: number; score?: number; model?: string; inputTokens?: number };
  /** What the screen sent, sent again as it is. Absent when the buffer had no room for it: the row says skipped_backlog. */
  request?: { state: unknown; questions: unknown };
};
export type ComparisonRow = Record<string, string | number | boolean | null>;
type Row = ComparisonRow;
type Result = { outcome: string; httpStatus?: number; ms?: number; score?: number; model?: string; inputTokens?: number; requestId?: string; retryAfterMs?: number };

const MAX_ITEMS = 2000, MAX_BYTES = 2_000_000;
const buffers = new WeakMap<object, { items: ShadowItem[]; bytes: number; dropped: number }>();

/** Keeps a request for `db`'s next flushShadow. Past MAX_BYTES of requests it is kept without its text (its row will say
 *  skipped_backlog); past MAX_ITEMS it is dropped and counted. Never throws, never waits. */
export function keepShadow(db: object | undefined, item: ShadowItem, bytes: number | undefined) {
  try {
    if (!db) return;
    let buffer = buffers.get(db);
    if (!buffer) buffers.set(db, buffer = { items: [], bytes: 0, dropped: 0 });
    if (buffer.items.length >= MAX_ITEMS) { buffer.dropped++; return; }
    const size = typeof bytes === 'number' && bytes > 0 ? bytes : 8192;
    if (buffer.bytes + size > MAX_BYTES) delete item.request; else buffer.bytes += size;
    buffer.items.push(item);
  } catch { /* A record never changes the request's outcome. */ }
}

const runners = new WeakMap<object, ShadowRunner>();
/** Hands the requests kept for this runtime's database client over and returns at once: to Runtime.shadow where the
 *  platform has one (Cloudflare's queue), else to a runner in this process. Never throws. */
export function flushShadow(runtime: Runtime): void {
  try {
    const buffer = buffers.get(runtime.db);
    if (!buffer || (!buffer.items.length && !buffer.dropped)) return;
    const items = buffer.items.splice(0), dropped = buffer.dropped;
    buffer.bytes = 0; buffer.dropped = 0;
    if (dropped) log('warn', { code: 'SCREEN_SHADOW_DROPPED', dropped, kept: items.length });
    const settings = runtime.config.shadow;
    if (!settings || !items.length) return;
    if (runtime.shadow) { runtime.shadow(items); return; }
    let runner = runners.get(runtime.db);
    if (!runner) runners.set(runtime.db, runner = new ShadowRunner(settings, rows => writeComparisons(runtime.db, rows)));
    runner.accept(items);
  } catch (error) { logError(error, { code: 'SCREEN_SHADOW_HANDOFF_FAILED' }, 'warn'); }
}
/** Resolves once this process's runner for `db` has nothing in flight and nothing left to write. For tests and a clean shutdown. */
export function shadowSettled(db: object): Promise<void> { return runners.get(db)?.settled() ?? Promise.resolve(); }

type ShadowQueue = { sendBatch(messages: { body: string; contentType: 'text' }[]): Promise<unknown> };
// A queue takes 100 messages and 256 KB a call, and 128 KB a message.
const SEND_MESSAGES = 100, SEND_BYTES = 240_000, MESSAGE_BYTES = 120_000;
/** Cloudflare's hand-over: each request as one message on the second classifier's queue, as many a call as a call takes,
 *  one call after another. A request too large for a message goes without its text (its row will say skipped_backlog).
 *  A send that fails loses what was not sent yet, with one log line. Never rejects. */
export async function enqueueShadow(queue: ShadowQueue, items: ShadowItem[]): Promise<void> {
  let sent = 0;
  try {
    let batch: { body: string; contentType: 'text' }[] = [], bytes = 0;
    const send = async () => { if (!batch.length) return; const messages = batch; batch = []; bytes = 0; await queue.sendBatch(messages); sent += messages.length; };
    for (const item of items) {
      let body = JSON.stringify(item), size = Buffer.byteLength(body);
      if (size > MESSAGE_BYTES) { const { request: _text, ...rest } = item; body = JSON.stringify(rest); size = Buffer.byteLength(body); }
      if (batch.length >= SEND_MESSAGES || bytes + size > SEND_BYTES) await send();
      batch.push({ body, contentType: 'text' }); bytes += size;
    }
    await send();
  } catch (error) { logError(error, { code: 'SCREEN_SHADOW_HANDOFF_FAILED', items: items.length, sent }, 'warn'); }
}

// An invocation waits on six connections: its calls and the one database connection.
const CONSUMER_CALLS = 5;
/**
 * One batch of the second classifier's queue: asks it for each message delivered for the first time (at most
 * CONSUMER_CALLS at once, under this isolate's pause and breaker) and writes every pair's row in one INSERT. A message
 * delivered again is never asked again: its row says lost, unless its first delivery wrote one. Returns whether the
 * batch is done (acknowledge it); false when the rows could not be written (let the queue deliver it again, up to its
 * max_retries, after which it is gone). Never throws.
 */
export async function consumeShadow(settings: ShadowSettings, store: { write(rows: ComparisonRow[]): Promise<void>; written(ids: string[]): Promise<Set<string>> }, messages: { body: unknown; attempts: number }[]): Promise<boolean> {
  const rows: Row[] = [];
  try {
    const first: ShadowItem[] = [], again: ShadowItem[] = [];
    for (const message of messages) {
      let item: ShadowItem | undefined;
      try { item = typeof message.body === 'string' ? JSON.parse(message.body) : message.body as ShadowItem; } catch { /* Not one of ours: dropped. */ }
      if (item && typeof item === 'object' && typeof item.id === 'string' && item.jev && typeof item.jev === 'object') (message.attempts > 1 ? again : first).push(item);
    }
    if (again.length) {
      const have = await store.written(again.map(item => item.id));
      for (const item of again) if (!have.has(item.id)) { const row = rowOf(item, { outcome: 'lost' }); if (row) rows.push(row); }
    }
    if (first.length) {
      const runner = new ShadowRunner(settings, async batch => { rows.push(...batch); }, { limit: CONSUMER_CALLS, gate: gateFor(settings) });
      runner.accept(first); await runner.settled();
    }
    await store.write(rows);
    return true;
  } catch (error) { logError(error, { code: 'SCREEN_COMPARISONS_UNWRITTEN', rows: rows.length, redelivery: true }, 'warn'); return false; }
}

const FAILURES_TO_OPEN = 5, OPEN_MS = 30_000, MAX_OPEN_MS = 600_000, MAX_AGE_MS = 300_000, MAX_QUEUE = 2000, MAX_ROWS = 5000, WRITE_ROWS = 500;
const DEFAULT_PAUSE_MS = 5000, MIN_PAUSE_MS = 1000, MAX_PAUSE_MS = 600_000, LOG_EVERY_MS = 60_000, MAX_RESPONSE = 32768;
// What an over-long request is refused with: 413, or a 400/422 whose body says so. Recorded as an answer of its own, not a failure.
const TOO_LARGE = /too (large|long|many)|context (length|window|size)|max(imum)?[ _-]?(input[ _-]?)?tokens|token limit|exceeds/i;
const text = (value: unknown, max = 100) => typeof value === 'string' && value ? value.slice(0, max) : null;
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : null;
const score = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const INT = 2_147_483_647, SMALL = 32_767;

/** Retry-After as milliseconds from now: seconds or an HTTP date, kept between one second and ten minutes. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const ms = /^\s*\d{1,9}(\.\d+)?\s*$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(MIN_PAUSE_MS, Math.min(MAX_PAUSE_MS, Math.round(ms))) : undefined;
}

export type CircuitState =
  | { state: 'closed'; failures: number }
  | { state: 'open'; retryAt: number }
  | { state: 'probing'; leaseUntil: number };

export type CircuitClaim = { probe: boolean; token: CircuitState };

/**
 * Explicit three-state circuit breaker: closed (counting consecutive failures), open (cooling down until retryAt),
 * and probing (one half-open probe in flight until leaseUntil, so a vanished Worker never wedges the breaker).
 */
export class CircuitBreaker {
  current: CircuitState = { state: 'closed', failures: 0 };

  get isOpen(): boolean { return this.current.state !== 'closed'; }

  /** Admits a call when closed, or claims the single half-open probe once open/probing has expired. Returns null while cooling down or a probe is already in flight. */
  tryAcquire(now: number, probeLeaseMs: number): CircuitClaim | null {
    const s = this.current;
    if (s.state === 'closed') return { probe: false, token: s };
    if (s.state === 'open' ? now < s.retryAt : now < s.leaseUntil) return null;
    const probing: CircuitState = { state: 'probing', leaseUntil: now + probeLeaseMs };
    this.current = probing;
    return { probe: true, token: probing };
  }

  /** Closes the breaker (or resets closed failures). Ignores stale claims from before an open/re-probe transition. */
  recordSuccess(claim: CircuitClaim): boolean {
    if (!this.owns(claim)) return false;
    const wasProbing = claim.probe;
    this.current = { state: 'closed', failures: 0 };
    return wasProbing;
  }

  /** Records a breaker-tripping failure. Opens when a closed breaker hits `failuresToOpen` or when a probe fails. */
  recordFailure(claim: CircuitClaim, now: number, failuresToOpen: number, cooldownMs: number): { opened: boolean; again: boolean; failures: number } {
    if (!this.owns(claim)) return { opened: false, again: false, failures: 0 };
    if (claim.probe) {
      this.current = { state: 'open', retryAt: now + cooldownMs };
      return { opened: true, again: true, failures: failuresToOpen };
    }
    const failures = (this.current as Extract<CircuitState, { state: 'closed' }>).failures + 1;
    if (failures >= failuresToOpen) {
      this.current = { state: 'open', retryAt: now + cooldownMs };
      return { opened: true, again: false, failures };
    }
    this.current = { state: 'closed', failures };
    return { opened: false, again: false, failures };
  }

  /** Releases an inconclusive probe (e.g. rate-limited or region-specific 451) so the next request can probe immediately. */
  releaseProbe(claim: CircuitClaim, now: number): void {
    if (claim.probe && this.current === claim.token) this.current = { state: 'open', retryAt: now };
  }

  private owns(claim: CircuitClaim): boolean {
    return claim.probe ? this.current === claim.token : this.current.state === 'closed';
  }
}

/** The pause and the breaker, and when each failure class was last logged: one per endpoint and model in a process or
 *  an isolate (gateFor), shared by every runner there. Plain state: nothing in it belongs to one invocation. */
export type ShadowGate = { breaker: CircuitBreaker; openMs: number; openedAt: number; pausedUntil: number; logged: Map<string, { at: number; count: number }> };
const newGate = (): ShadowGate => ({ breaker: new CircuitBreaker(), openMs: 0, openedAt: 0, pausedUntil: 0, logged: new Map() });
const gates = new Map<string, ShadowGate>();
function gateFor(settings: ShadowSettings): ShadowGate {
  const key = `${settings.endpoint}\n${settings.model}`;
  let gate = gates.get(key);
  if (!gate) gates.set(key, gate = newGate());
  return gate;
}

/** A pair's row: the screen's side as it was kept, the second classifier's as `result` says. Every value bounded. */
function rowOf(item: ShadowItem, result: Result): Row | undefined {
  try {
    const threshold = score(item.threshold), jevfThreshold = score(item.jevfThreshold ?? item.threshold), jev = score(item.jev.score), jevf = score(result.score);
    return { pair_id: item.id.slice(0, 64), at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : Date.now(), workspace_id: text(item.workspaceId),
      kind: text(item.kind, 20) ?? 'email', email_id: text(item.emailId), campaign_id: text(item.campaignId), digest: text(item.digest, 128) ?? '',
      window_index: integer(item.window, SMALL) ?? 0, windows: integer(item.windows, SMALL) ?? 1, threshold,
      jev_outcome: text(item.jev.outcome, 40) ?? 'unknown', jev_http_status: integer(item.jev.httpStatus, SMALL), jev_ms: integer(item.jev.ms, INT), jev_score: jev,
      jev_model: text(item.jev.model), jev_input_tokens: integer(item.jev.inputTokens, INT), jev_flagged: jev === null || threshold === null ? null : jev >= threshold,
      jevf_outcome: text(result.outcome, 40) ?? 'unknown', jevf_http_status: integer(result.httpStatus, SMALL), jevf_ms: integer(result.ms, INT), jevf_score: jevf,
      jevf_model: text(result.model), jevf_input_tokens: integer(result.inputTokens, INT), jevf_request_id: text(result.requestId, 80),
      jevf_flagged: jevf === null || jevfThreshold === null ? null : jevf >= jevfThreshold };
  } catch { return undefined; /* A record never changes what happens next. */ }
}

/**
 * Repeats requests to the second classifier and writes each pair's row. accept() queues and starts what may start, at
 * most `limit` at once. write() gets rows in batches, one write at a time; a batch that fails is dropped with one
 * log line. The pause and the breaker are its gate's: its own, or the one it is given to share.
 */
export class ShadowRunner {
  private queue: ShadowItem[] = []; private active = 0; private rows: Row[] = []; private writing = false; private unwritten = 0;
  private waiters: (() => void)[] = []; private gate: ShadowGate;
  private limit: number; private firstOpenMs: number; private failuresToOpen: number;
  constructor(private settings: ShadowSettings, private write: (rows: Row[]) => Promise<void>, options: { limit?: number; gate?: ShadowGate; openMs?: number; failuresToOpen?: number } = {}) {
    this.limit = Math.max(1, Math.min(settings.maxConcurrency, options.limit ?? settings.maxConcurrency));
    this.gate = options.gate ?? newGate(); this.firstOpenMs = options.openMs ?? OPEN_MS; this.failuresToOpen = options.failuresToOpen ?? FAILURES_TO_OPEN;
  }
  /** Requests waiting for a call. */
  get waiting() { return this.queue.length; }
  /** Whether the breaker is open (or half-open, waiting on its probe). */
  get open() { return this.gate.breaker.isOpen; }

  accept(items: ShadowItem[]) {
    try {
      for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.jev || typeof item.jev !== 'object') continue;
        if (this.queue.length >= MAX_QUEUE) this.record(item, { outcome: 'skipped_backlog' }); else this.queue.push(item);
      }
      this.pump();
    } catch (error) { logError(error, { code: 'SCREEN_SHADOW_FAILED' }, 'warn'); }
  }

  /** Starts what may start now. A request too old, without its text, inside a pause or behind the open breaker is recorded as skipped. */
  pump() {
    try {
      const gate = this.gate;
      while (this.queue.length && this.active < this.limit) {
        const item = this.queue.shift()!, now = Date.now();
        const skip = !item.request || now - item.at > MAX_AGE_MS ? 'skipped_backlog' : now < gate.pausedUntil ? 'skipped_rate_limited' : undefined;
        if (skip) { this.record(item, { outcome: skip }); continue; }
        // Half-open probe lease lapses a little after its deadline, in case it never reports.
        const claim = gate.breaker.tryAcquire(now, this.settings.deadlineMs + 1000);
        if (!claim) { this.record(item, { outcome: 'skipped_breaker' }); continue; }
        this.active++;
        void this.call(item).then(result => { this.active--; this.learn(result, claim); this.record(item, result); this.pump(); });
      }
      this.flush();
    } catch (error) { logError(error, { code: 'SCREEN_SHADOW_FAILED' }, 'warn'); }
  }

  /** Resolves when nothing is in flight or waiting and nothing is left to write. */
  settled(): Promise<void> {
    return this.idle() ? Promise.resolve() : new Promise(resolve => { this.waiters.push(resolve); });
  }
  private idle() { return !this.active && !this.writing && !this.rows.length && !this.queue.length; }
  private check() { if (this.waiters.length && this.idle()) for (const resolve of this.waiters.splice(0)) resolve(); }

  // One request, under one deadline that includes reading the answer. Never rejects: how it ended is the result.
  private async call(item: ShadowItem): Promise<Result> {
    const started = Date.now(), result: Result = { outcome: 'network' };
    try {
      const response = await fetch(this.settings.endpoint, {
        // As the screen's own request (src/screen.ts jevQuestions): the key and the text go only to the configured endpoint.
        method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${this.settings.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.settings.model, state: item.request!.state, questions: item.request!.questions }), signal: AbortSignal.timeout(this.settings.deadlineMs),
      });
      result.httpStatus = response.status;
      result.requestId = response.headers.get('x-request-id')?.slice(0, 80) ?? undefined;
      if (response.status === 429 || response.status === 503) result.retryAfterMs = retryAfter(response.headers.get('retry-after'), Date.now());
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0, whole = true;
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if ((bytes += value.length) > MAX_RESPONSE) { whole = false; await reader.cancel().catch(() => undefined); break; }
        chunks.push(value);
      }
      const answer = Buffer.concat(chunks).toString();
      if (response.status === 429) result.outcome = 'rate_limited';
      else if (response.status === 413 || ((response.status === 400 || response.status === 422) && TOO_LARGE.test(answer))) result.outcome = 'refused_too_large';
      else if (!response.ok) result.outcome = `http_${response.status}`;
      else {
        let parsed: { model?: unknown; answers?: { harm?: { noul?: unknown } }; usage?: { input_tokens?: unknown } } | null = null;
        try { parsed = whole ? JSON.parse(answer) : null; } catch { /* Not JSON: invalid. */ }
        const harm = score(parsed?.answers?.harm?.noul);
        if (harm === null) result.outcome = 'invalid';
        else { result.outcome = 'ok'; result.score = harm; result.model = typeof parsed?.model === 'string' ? parsed.model : this.settings.model; result.inputTokens = integer(parsed?.usage?.input_tokens, INT) ?? undefined; }
      }
    } catch (error) {
      let name: unknown;
      try { name = (error as { name?: unknown }).name; } catch { /* A proxy. */ }
      result.outcome = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
    }
    result.ms = Date.now() - started;
    return result;
  }

  // The pause and the breaker. An answer (a score, or a refusal of an over-long request) is a success; a 429 only pauses;
  // anything else is a failure.
  private learn(result: Result, claim: CircuitClaim) {
    try {
      const now = Date.now(), outcome = result.outcome, gate = this.gate;
      if (outcome === 'rate_limited' || result.retryAfterMs) {
        const pause = result.retryAfterMs ?? DEFAULT_PAUSE_MS;
        gate.pausedUntil = Math.max(gate.pausedUntil, now + pause);
        if (outcome === 'rate_limited') this.note('SCREEN_SHADOW_RATE_LIMITED', { retryAfterMs: pause });
      }
      if (outcome === 'ok' || outcome === 'refused_too_large') {
        if (gate.breaker.recordSuccess(claim)) {
          log('info', { code: 'SCREEN_SHADOW_BREAKER', state: 'closed', openMs: now - gate.openedAt });
          gate.openMs = 0;
        }
        if (outcome !== 'ok') this.note('SCREEN_SHADOW_ERROR', { outcome, httpStatus: result.httpStatus });
        return;
      }
      if (outcome === 'rate_limited') { gate.breaker.releaseProbe(claim, now); return; } // Not a failure: the next request after the pause is the probe.
      if (outcome === 'timeout') this.note('SCREEN_SHADOW_TIMEOUT', { deadlineMs: this.settings.deadlineMs });
      else this.note('SCREEN_SHADOW_ERROR', { outcome, httpStatus: result.httpStatus });
      const nextOpenMs = claim.probe ? Math.min((gate.openMs || this.firstOpenMs) * 2, MAX_OPEN_MS) : this.firstOpenMs;
      const transition = gate.breaker.recordFailure(claim, now, this.failuresToOpen, nextOpenMs);
      if (transition.opened) {
        gate.openMs = nextOpenMs;
        if (transition.again) log('warn', { code: 'SCREEN_SHADOW_BREAKER', state: 'opened', again: true, outcome, pauseMs: gate.openMs });
        else { gate.openedAt = now; log('warn', { code: 'SCREEN_SHADOW_BREAKER', state: 'opened', failures: transition.failures, outcome, pauseMs: gate.openMs }); }
      }
    } catch { /* A record never changes what happens next. */ }
  }
  // One line per failure class a minute, saying how many it stands for. Never the request, its answer or the key.
  private note(code: string, fields: Record<string, unknown>) {
    const now = Date.now(), last = this.gate.logged.get(code);
    if (last && now - last.at < LOG_EVERY_MS) { last.count++; return; }
    log('warn', { code, ...fields, count: (last?.count ?? 0) + 1, model: this.settings.model });
    this.gate.logged.set(code, { at: now, count: 0 });
  }

  private record(item: ShadowItem, result: Result) {
    if (this.rows.length >= MAX_ROWS) { this.unwritten++; return; }
    const row = rowOf(item, result);
    if (row) this.rows.push(row);
  }
  private flush() {
    if (this.writing || !this.rows.length) { this.check(); return; }
    const rows = this.rows.splice(0, WRITE_ROWS), unwritten = this.unwritten;
    this.unwritten = 0; this.writing = true;
    if (unwritten) log('warn', { code: 'SCREEN_COMPARISONS_UNWRITTEN', reason: 'backlog', rows: unwritten });
    let written: Promise<void>;
    try { written = this.write(rows); } catch (error) { written = Promise.reject(error); }
    void written.catch((error: unknown) => { logError(error, { code: 'SCREEN_COMPARISONS_UNWRITTEN', rows: rows.length }, 'warn'); }).then(() => { this.writing = false; this.flush(); });
  }
}

const WRITE_MS = 5000, LOCK_MS = 2000;
/** One INSERT for a batch of pairs, in its own transaction under a statement and a lock timeout, so a slow or blocked
 *  write is cancelled by the database and its connection comes back; a pair already written (its pair_id) is left as it
 *  is. Inside a caller's transaction it is a savepoint, and the INSERT puts the caller's limits back (as src/screen-calls.ts does). */
export async function writeComparisons(db: Runtime['db'], rows: Row[]): Promise<void> {
  if (!rows.length) return;
  await db.transaction(async tx => {
    const { rows: [before] } = await tx.execute<{ statement: string; lock: string }>(sql`WITH before AS MATERIALIZED (SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock) SELECT before.*,set_config('statement_timeout',${String(WRITE_MS)},true),set_config('lock_timeout',${String(LOCK_MS)},true) FROM before`);
    await tx.execute(sql`WITH written AS (INSERT INTO screen_comparisons(created_at,pair_id,workspace_id,kind,email_id,campaign_id,digest,window_index,windows,threshold,
        jev_outcome,jev_http_status,jev_ms,jev_score,jev_model,jev_input_tokens,jev_flagged,
        jevf_outcome,jevf_http_status,jevf_ms,jevf_score,jevf_model,jevf_input_tokens,jevf_request_id,jevf_flagged)
      SELECT to_timestamp(x.at/1000.0),x.pair_id,x.workspace_id,x.kind,x.email_id,x.campaign_id,x.digest,x.window_index,x.windows,x.threshold,
        x.jev_outcome,x.jev_http_status,x.jev_ms,x.jev_score,x.jev_model,x.jev_input_tokens,x.jev_flagged,
        x.jevf_outcome,x.jevf_http_status,x.jevf_ms,x.jevf_score,x.jevf_model,x.jevf_input_tokens,x.jevf_request_id,x.jevf_flagged
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(at float8,pair_id text,workspace_id text,kind text,email_id text,campaign_id text,digest text,window_index smallint,
        windows smallint,threshold float8,jev_outcome text,jev_http_status smallint,jev_ms int,jev_score float8,jev_model text,jev_input_tokens int,jev_flagged boolean,
        jevf_outcome text,jevf_http_status smallint,jevf_ms int,jevf_score float8,jevf_model text,jevf_input_tokens int,jevf_request_id text,jevf_flagged boolean)
      ON CONFLICT (pair_id) DO NOTHING RETURNING 1)
      SELECT set_config('statement_timeout',${before!.statement},true),set_config('lock_timeout',${before!.lock},true) FROM (SELECT count(*) FROM written) n`);
  });
}
/** Which of these pairs have a row. */
export async function writtenComparisons(db: Runtime['db'], ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await db.execute<{ pair_id: string }>(sql`SELECT pair_id FROM screen_comparisons WHERE pair_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
  return new Set(rows.map(row => row.pair_id));
}
