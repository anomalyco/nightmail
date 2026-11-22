import { DurableObject } from 'cloudflare:workers';
import type { Pool } from 'pg';
import type { GateState } from './dispatcher.js';
import type { Runtime } from './core.js';

function initDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'), import('./dispatcher.js'),
    import('./core.js'), import('./adapters/feedback-queue.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { loadConfig }, { r2Storage }, { initialGate, runDispatcher, dispatchWakeKey,shardLeaseSize }, { ApiError, log, logError, setLogContext }, { feedbackSink, workWake }]) => ({
    Pool, drizzle, sql, loadConfig, r2Storage, initialGate, runDispatcher, dispatchWakeKey,shardLeaseSize, ApiError, log, logError, setLogContext, feedbackSink, workWake,
  }));
}
let depsPromise: ReturnType<typeof initDeps> | undefined;
function loadDeps() {
  return depsPromise ??= initDeps().catch(async error => {
    depsPromise = undefined;
    const core = await import('./core.js').catch(() => null);
    throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
  });
}

// One Durable Object per account/region/shard hosts the dispatcher loop. The object
// keeps its database pool and pacing state across alarms, so a busy region never pays the
// per-invocation setup the queue consumer did, and an evicted object resumes from storage
// without bursting past its quota share. PostgreSQL rows remain the only queue.
//
// A run always starts in the alarm, never inside a wake request. Cloudflare labels a request's outbound calls with the
// visitor who started the chain (a browser, the caller's Worker, our API Worker, this shard), and the content classifier's
// edge refuses requests labelled with some countries (HTTP 451). The alarm invocation has no visitor. So a wake only arms
// the alarm for now and returns; the platform runs one alarm() at a time, so runs never overlap.
//
// Which request labels a call is the "current" one: the newest request delivered to the object that hasn't completed, and
// on a Durable Object a request whose handler has returned stays current while the object has any pending timer, as a run
// always does (workerd io-context.c++). So a request that lands during an alarm is current until the next alarm() begins,
// however fast it returns. From then the run makes no classifier call: `landed` (set first thing in fetch) stops it before
// each one (Runtime.screenHandover), the run gives that mail back to the queue and ends, and the follow-up alarm, a newer
// request with no visitor, screens it. A wake on an idle shard is safe: the alarm it arms is delivered after it.

type Identity = { region: string; accountId?: string; shard: { index: number; count: number } };
const RUN_MS = 45000;      // Re-arm well inside the alarm wall-clock and default CPU budgets.
const RETRY_MS = 15000;    // Dependency failure (database, quota) backoff.
const OVERDUE_MS = 3000;   // An alarm this far past due with no run in progress is waiting out a platform retry: arm it again.

export function dispatcherName(identity: Identity) { return `dispatcher:${identity.accountId ? `${identity.accountId}:` : ''}${identity.region}:${identity.shard.index}/${identity.shard.count}`; }
export function shardCount(value: unknown) { const n = Number(value); return Number.isInteger(n) && n >= 1 ? Math.min(n, 256) : 1; }

export class DispatcherShard extends DurableObject<Env> {
  private pool?: Pool;
  private running = false;
  private priorityWake = new EventTarget();
  private gate?: GateState;
  private identity?: Identity;
  private placementLogged = false;
  // The first wake that found no run in progress since the last run started: DISPATCH_RUN's wakeMs, the cost of the hop.
  private wokenAt?: number;
  // An alarm() is in progress, and a request (any request) has been delivered since it began.
  private alarmActive = false;
  private landed = false;

  // Once per persisted shard, after its first dispatch: where it runs and the cost of one DB round trip.
  // The location hint is only honored at creation, so this is the record of where the object actually landed.
  private async logPlacement(identity: Identity, runtime: Runtime) {
    try {
      if (await this.ctx.storage.get('placementLogged')) return;
      const { sql, log } = await loadDeps();
      const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })).text();
      const colo = trace.match(/^colo=(\w+)/m)?.[1] ?? 'unknown';
      const timed = async (work: () => Promise<unknown>) => { const at = Date.now(); await work(); return Date.now() - at; };
      const dbPingMs = await timed(() => runtime.db.execute(sql`SELECT 1`));
      const dbPingAgainMs = await timed(() => runtime.db.execute(sql`SELECT 1`));
      // The dispatcher's statements carry ~20 KB JSON parameters; measure that shape separately from a bare round trip.
      const payload = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: `probe_${i}`, snapshot: 'x'.repeat(3000) })));
      const dbPayloadMs = await timed(() => runtime.db.execute(sql`SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text, snapshot text)`));
      const dbPayloadAgainMs = await timed(() => runtime.db.execute(sql`SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text, snapshot text)`));
      log('info', { code: 'DISPATCHER_PLACEMENT', shard: dispatcherName(identity), colo, dbPingMs, dbPingAgainMs, dbPayloadMs, dbPayloadAgainMs, payloadBytes: payload.length });
      await this.ctx.storage.put('placementLogged', true);
    } catch { /* diagnostics only */ }
  }

  async fetch(request: Request): Promise<Response> {
    // First, before anything can await: this request is now the current one (see the top of this file).
    if (this.alarmActive) this.landed = true;
    const url = new URL(request.url);
    if (url.pathname !== '/wake' || url.searchParams.has('environment')) return new Response('Not found', { status: 404 });
    const identity: Identity = {
      region: url.searchParams.get('region') ?? '',
      accountId: url.searchParams.get('account') ?? undefined,
      shard: { index: Number(url.searchParams.get('shard') ?? 0), count: Math.max(1, Number(url.searchParams.get('count') ?? 1)) },
    };
    if (!identity.region) return new Response('region required', { status: 400 });
    if (!this.identity || dispatcherName(this.identity) !== dispatcherName(identity)) {
      await this.ctx.storage.put('identity', identity);
      this.identity = identity;
    }
    // A priority wake reaches a run in progress at once, as before; the run keeps serving them until it ends.
    if (this.running && url.searchParams.get('priority') === '1') {
      const { dispatchWakeKey } = await loadDeps();
      this.priorityWake.dispatchEvent(new Event(dispatchWakeKey(identity.region, identity.accountId)));
    }
    if (!this.running) this.wokenAt ??= Date.now();
    // Idle, the alarm starts a run now. Mid-run, the running loop may already have taken its last lease, so the alarm
    // set now fires as soon as this run's alarm() returns: a durable follow-up.
    await this.armNow();
    return Response.json({ ok: true, running: this.running });
  }

  /** Sets the alarm for now unless one is already due. A later time it replaces (a quota, pace or failure retry) is kept as
   *  displacedAlarm, and every run until one starts at or after it re-arms it (rearm), so a wake never loses an armed retry.
   *  An alarm overdue by OVERDUE_MS with no run in progress is set again: after alarm() throws, the platform waits 2 to 64 s
   *  before retrying and getAlarm keeps the past time, and a new setAlarm ends that wait. */
  private async armNow() {
    const now = Date.now(), alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null && alarm <= now && (this.running || now - alarm < OVERDUE_MS)) return;
    if (alarm !== null && alarm > now) {
      const kept = await this.ctx.storage.get<number>('displacedAlarm');
      if (kept === undefined || alarm < kept) await this.ctx.storage.put('displacedAlarm', alarm);
    }
    await this.ctx.storage.setAlarm(now);
  }

  /** After a run: arms the earliest of `soon` (a follow-up), `next` (the run's own retry) and a retry kept as displacedAlarm,
   *  unless an earlier alarm is set (a wake during the run). When something earlier is armed, the run's own retry is kept as
   *  displacedAlarm (the earliest such retry), so whichever run comes first arms it again. Inside alarm(), getAlarm is null
   *  unless something set one since it began. */
  private async rearm(next: number | undefined, soon?: number) {
    const kept = await this.ctx.storage.get<number>('displacedAlarm');
    const at = Math.min(soon ?? Infinity, next ?? Infinity, kept ?? Infinity);
    if (at === Infinity) return;
    const alarm = await this.ctx.storage.getAlarm();
    if ((alarm ?? Infinity) > at) await this.ctx.storage.setAlarm(at);
    if (next !== undefined && next > Math.min(alarm ?? Infinity, at) && (kept === undefined || next < kept)) await this.ctx.storage.put('displacedAlarm', next);
  }

  async alarm(): Promise<void> {
    // This invocation is now the current request: nothing delivered before it labels what it sends. Only the outermost call
    // resets the flags (the platform never overlaps alarm(); a direct call could).
    const outer = !this.alarmActive;
    if (outer) { this.alarmActive = true; this.landed = false; }
    try { await this.dispatch(); } finally { if (outer) this.alarmActive = false; }
  }

  private async dispatch(): Promise<void> {
    const identity = this.identity ??= await this.ctx.storage.get<Identity>('identity');
    if (!identity || 'environment' in identity) return; // Retire alarms from the old shard names.
    // The platform never runs two alarm() at once and nothing else calls it, so this guards only a direct call.
    if (this.running) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    // A retry a wake displaced that is due by now is this run's to serve. Read before `running` is set, so a storage call
    // that rejects here only fails this alarm (the platform retries it) and can't leave the shard marked as running.
    const displaced = await this.ctx.storage.get<number>('displacedAlarm');
    if (displaced !== undefined && displaced <= Date.now()) await this.ctx.storage.delete('displacedAlarm');
    this.running = true;
    const started = Date.now(), wakeMs = this.wokenAt === undefined ? undefined : started - this.wokenAt;
    this.wokenAt = undefined;
    let deps: Awaited<ReturnType<typeof loadDeps>> | undefined, next: number | undefined;
    try {
      deps = await loadDeps();
      deps.setLogContext({ service: 'worker', deploy: (this.env as unknown as Record<string, unknown>).DEPLOY_SHA });
      const { initialGate, runDispatcher } = deps;
      this.gate ??= (await this.ctx.storage.get<GateState>('gate')) ?? initialGate();
      // Once a request lands, no classifier call in this run (screenHandover), no more leases (stop), and a follow-up below.
      const runtime: Runtime = { ...await this.runtime(), screenHandover: () => this.landed };
      // An alarm persisted by an older MX deployment must not drain an unpartitioned region.
      if (runtime.config.multiTenant && !identity.accountId) return;
      const report = await runDispatcher(runtime, {
        ...identity, gate: this.gate, priorityWake: this.priorityWake, stop: () => this.landed,
        until: started + RUN_MS, lanes: 2, batchSize: deps.shardLeaseSize(this.gate.quota?.maxSendRate,identity.shard.count), sendConcurrency: 6, wakeMs,
        // Unconfirmed: a confirmed write holds the object's outgoing calls (SES, the classifier) until it is confirmed, about
        // 25 ms after each batch. If the write fails the object is reset and the alarm runs again.
        onGate: async state => { await this.ctx.storage.put('gate', state, { allowUnconfirmed: true }); },
      });
      if (!this.placementLogged) { this.placementLogged = true; this.ctx.waitUntil(this.logPlacement(identity, runtime)); }
      // Work remained when the run budget ended: continue immediately. Otherwise sleep until the next wake (an API nudge or
      // the scheduler's minute ping) or the run's own retry. A wake only arms this alarm, so every run, and all queued mail,
      // now depends on the alarm firing; armNow re-arms one left overdue by a platform retry wait.
      const retry = Math.min(report.quotaRetryAt ?? Infinity, report.paceRetryAt ?? Infinity);
      next = !report.idle ? Date.now() : retry === Infinity ? undefined : retry;
    } catch (error) {
      // Module loading itself can fail; still log, close and retry so the shard never wedges.
      if (!deps) console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), service: 'worker', code: 'DISPATCHER_DEPS_FAILED' }));
      else {
      deps.logError(error, { code: error instanceof deps.ApiError ? error.code : 'DISPATCHER_RUN_FAILED', shard: dispatcherName(identity) }); }
      await this.closePool();
      next = Date.now() + RETRY_MS;
    } finally {
      this.running = false;
    }
    // A request landed during the run: the follow-up alarm (a newer request, with no visitor) screens what this run gave back,
    // and the run's own retry is kept for after it.
    await this.rearm(next, this.landed ? Date.now() : undefined);
  }

  private async runtime(): Promise<Runtime> {
    const { Pool, drizzle, loadConfig, r2Storage, feedbackSink, workWake } = await loadDeps();
    const config = loadConfig({ ...this.env });
    // A small persistent pool: claims are sequential per lane and provider calls do not hold connections.
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: 2, idleTimeoutMillis: 30000 });
      this.pool.on('error', () => { /* Idle client errors surface on the next query; the run loop then recreates the pool. */ });
    }
    return { db: drizzle(this.pool), storage: r2Storage(this.env.ATTACHMENTS), config, feedback: feedbackSink(this.env.FEEDBACK_QUEUE, config.authSecret), wake: (count,kind)=>workWake(kind==='webhook' && this.env.WEBHOOK_QUEUE ? this.env.WEBHOOK_QUEUE : this.env.WAKE_QUEUE,6)(count) };
  }

  private async closePool() {
    const pool = this.pool; this.pool = undefined;
    try { await pool?.end(); } catch { /* already closed */ }
  }
}
