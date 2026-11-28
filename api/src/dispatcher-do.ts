import { DurableObject } from 'cloudflare:workers';
import type { Pool } from 'pg';
import { shardsForRate, TARGET_SHARD_RATE, type GateState } from './dispatcher.js';
export { shardsForRate, TARGET_SHARD_RATE };
import type { Runtime } from './core/types.js';
import { InboxWaiters, serveInboxWake } from './inbox-wake.js';

function initDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'), import('./dispatcher.js'),
    import('./core/errors.js'), import('./log.js'), import('./adapters/feedback-queue.js'), import('./health-counters.js'), import('./screen-shadow.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { loadConfig }, { r2Storage }, { initialGate, runDispatcher, dispatchWakeKey,shardLeaseSize }, { ApiError, logError, platformMessage }, { log, setLogContext }, { feedbackSink, workWake }, { countersDue, flushCounters }, { enqueueShadow }]) => ({
    Pool, drizzle, sql, loadConfig, r2Storage, initialGate, runDispatcher, dispatchWakeKey,shardLeaseSize, ApiError, log, logError, platformMessage, setLogContext, feedbackSink, workWake, countersDue, flushCounters, enqueueShadow,
  }));
}
let depsPromise: ReturnType<typeof initDeps> | undefined;
function loadDeps() {
  return depsPromise ??= initDeps().catch(async error => {
    depsPromise = undefined;
    const core = await import('./core/errors.js').catch(() => null);
    throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
  });
}

// One Durable Object per account/region/shard hosts the dispatcher loop. The object
// keeps its database pool and pacing state across alarms, so a busy region never pays the
// per-invocation setup the queue consumer did, and an evicted object resumes from storage
// without bursting past its quota share. PostgreSQL rows remain the only queue.
//
// Content screening runs at API accept time (src/sending/front-door.ts) before anything enters the sending queue, so the mail room
// never calls a classifier and visitor wakes never interrupt running alarms. A wake arms the alarm when idle and nudges
// priorityWake when running; the platform runs one alarm() at a time, so runs never overlap.

type Identity = { region: string; accountId?: string; shard: { index: number; count: number }; autoScale?: boolean };
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
  // An inbox-wake:<workspace> object (inbox-wake.ts) only holds its inbox long polls' waits and wakes them; it never
  // dispatches, as no /wake reaches it.
  private inboxWaiters?: InboxWaiters;


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
    const url = new URL(request.url);
    if (url.pathname.startsWith('/inbox/')) return serveInboxWake(this.inboxWaiters ??= new InboxWaiters(), request);
    if (url.pathname !== '/wake' || url.searchParams.has('environment')) return new Response('Not found', { status: 404 });
    const identity: Identity = {
      region: url.searchParams.get('region') ?? '',
      accountId: url.searchParams.get('account') ?? undefined,
      shard: { index: Number(url.searchParams.get('shard') ?? 0), count: Math.max(1, Number(url.searchParams.get('count') ?? 1)) },
      ...(url.searchParams.get('auto') === '1' ? { autoScale: true } : {}),
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

  /** After a run: the alarm at `next` (the run's own retry), or at a retry a wake displaced, whichever is first, unless an
   *  earlier one is set (a wake during the run). Inside alarm(), getAlarm is null unless something set one since it began. */
  private async rearm(next: number | undefined) {
    const at = Math.min(next ?? Infinity, await this.ctx.storage.get<number>('displacedAlarm') ?? Infinity);
    if (at !== Infinity && (await this.ctx.storage.getAlarm() ?? Infinity) > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    await this.dispatch();
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
      const runtime = await this.runtime();
      // An alarm persisted by an older MX deployment must not drain an unpartitioned region.
      if (runtime.config.multiTenant && !identity.accountId) return;
      // Throttle and guard gate persistence: a transient DO storage error must never crash a healthy run into a 15 s retry.
      const GATE_PERSIST_MS = 2000;
      let lastPersistAt = 0, lastPersistKey = '';
      const gateKey = (s: GateState) => `${s.quota?.checkedAt ?? 0}:${s.brakeUntil ?? 0}:${s.marketingBrakeUntil ?? 0}:${s.outageUntil ?? 0}:${s.accountPauseAt ?? 0}:${s.dailyBlockedUntil ?? 0}:${s.storageUntil ?? 0}`;
      const persistGate = async (state: GateState, force = false) => {
        const now = Date.now(), key = gateKey(state);
        if (!force && key === lastPersistKey && now - lastPersistAt < GATE_PERSIST_MS) return;
        lastPersistAt = now; lastPersistKey = key;
        try { await this.ctx.storage.put('gate', state, { allowUnconfirmed: true }); }
        catch (error) { deps?.log('warn', { code: 'DISPATCHER_GATE_PERSIST_FAILED', shard: dispatcherName(identity), cause: deps.platformMessage(error) }); }
      };
      // If AWS changed MaxSendRate (e.g. 200/s -> 1,000/s) on an auto-scaled shard, hand off to the new shard count and
      // retire this old count's alarm, so the two generations never send together (up to twice the account's rate). A
      // fresh sample that already asks for another count skips the run; one that changes during it stops leasing.
      const gate = this.gate;
      const desired = () => (identity.autoScale || Boolean(this.env?.DISPATCHER)) && gate.quota?.maxSendRate && Date.now() < (gate.refreshAt ?? 0)
        ? shardsForRate(gate.quota.maxSendRate, identity.shard.count) : identity.shard.count;
      const resized = desired() !== identity.shard.count;
      const report = resized ? undefined : await runDispatcher(runtime, {
        ...identity, gate, priorityWake: this.priorityWake,
        until: started + RUN_MS, lanes: 2, batchSize: deps.shardLeaseSize(gate.quota?.maxSendRate,identity.shard.count), sendConcurrency: 6, wakeMs,
        onGate: state => persistGate(state), stop: () => desired() !== identity.shard.count,
      });
      await persistGate(gate, true);
      // Error lines from a run that succeeded (SES paused or refusing credentials, acceptance unknown) reach the health
      // tick too, not only a failed run's (src/health-counters.ts). Counts flush at most every 20 s, on the run's pool, and
      // after every idle run: the object may be evicted before the next one. With nothing counted the flush is no query.
      if (report?.idle !== false || deps.countersDue()) this.ctx.waitUntil(deps.flushCounters(runtime.db));
      if (!this.placementLogged) { this.placementLogged = true; this.ctx.waitUntil(this.logPlacement(identity, runtime)); }
      const count = desired();
      if (count !== identity.shard.count) {
        // This shard is retired: a retry a wake displaced must not bring it back.
        await this.ctx.storage.delete('displacedAlarm');
        // Mail is waiting: shard 0 wakes the whole new generation, any other shard only the one that takes its share, so
        // a wake that reached just this shard is not lost and a resize is not a fan-out from every old shard.
        if (!report?.idle && this.env?.DISPATCHER) {
          const targets = identity.shard.index === 0 ? Array.from({ length: count }, (_, i) => i) : [identity.shard.index % count];
          this.ctx.waitUntil(Promise.allSettled(targets.map(i => {
            const target: Identity = { accountId: identity.accountId, region: identity.region, shard: { index: i, count }, autoScale: true };
            const stub = this.env.DISPATCHER.get(this.env.DISPATCHER.idFromName(dispatcherName(target)), { locationHint: 'enam' });
            return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(identity.region)}&shard=${i}&count=${count}${identity.accountId ? `&account=${encodeURIComponent(identity.accountId)}` : ''}&auto=1`);
          })));
        }
        next = undefined;
      } else if (report) {
        // Work remained when the run budget ended: continue immediately. Otherwise sleep until the next wake (an API nudge or
        // the scheduler's minute ping) or the run's own retry. A wake only arms this alarm, so every run, and all queued mail,
        // now depends on the alarm firing; armNow re-arms one left overdue by a platform retry wait.
        const retry = Math.min(report.quotaRetryAt ?? Infinity, report.paceRetryAt ?? Infinity);
        next = !report.idle ? Date.now() : retry === Infinity ? undefined : retry;
      }
    } catch (error) {
      // Module loading itself can fail; still log, close and retry so the shard never wedges.
      if (!deps) console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), service: 'worker', code: 'DISPATCHER_DEPS_FAILED' }));
      else {
        // `cause` says why (core/errors.ts platformMessage): the platform's own words for a Durable Object storage or binding
        // failure, never a database error's text. The line is also counted (src/health-counters.ts), so a shard that
        // keeps failing becomes the dispatcher-failing alert (src/health.ts). The count is written after this run, on a
        // connection of its own that recovery never waits for.
        deps.logError(error, { code: error instanceof deps.ApiError ? error.code : 'DISPATCHER_RUN_FAILED', shard: dispatcherName(identity), cause: deps.platformMessage(error) });
        this.ctx.waitUntil(this.flushCounts(deps));
      }
      await this.closePool();
      next = Date.now() + RETRY_MS;
    } finally {
      this.running = false;
    }
    await this.rearm(next);
  }

  private async runtime(): Promise<Runtime> {
    const { Pool, drizzle, loadConfig, r2Storage, feedbackSink, workWake, enqueueShadow } = await loadDeps();
    const config = loadConfig({ ...this.env });
    // Shadow comparisons go to their own queue. Only failover gate calls share the object's SES connections (at most two).
    const shadowQueue = this.env.JEVF_QUEUE;
    if (!shadowQueue) config.shadow = undefined;
    // A small persistent pool: claims are sequential per lane and provider calls do not hold connections.
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: 2, idleTimeoutMillis: 30000 });
      this.pool.on('error', () => { /* Idle client errors surface on the next query; the run loop then recreates the pool. */ });
    }
    return { db: drizzle(this.pool), shadow: shadowQueue && (items => { this.ctx.waitUntil(enqueueShadow(shadowQueue, items)); }), storage: r2Storage(this.env.ATTACHMENTS), config, feedback: feedbackSink(this.env.FEEDBACK_QUEUE, config.authSecret, this.env.FEEDBACK_PRIORITY_QUEUE), wake: (count,kind)=>workWake(kind==='webhook' && this.env.WEBHOOK_QUEUE ? this.env.WEBHOOK_QUEUE : this.env.WAKE_QUEUE,6)(count) };
  }

  // One short-lived connection, bounded by flushCounters' own timeouts. It never throws or rejects, whatever is missing.
  private async flushCounts(deps: Awaited<ReturnType<typeof loadDeps>>) {
    let pool: InstanceType<typeof deps.Pool> | undefined;
    try {
      pool = new deps.Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 5000, max: 1 });
      pool.on('error', () => { /* Dropped with the sample. */ });
      await deps.flushCounters(deps.drizzle(pool));
    } catch { /* Counted again with the next failure. */ } finally { await pool?.end().catch(() => {}); }
  }

  private async closePool() {
    const pool = this.pool; this.pool = undefined;
    try { await pool?.end(); } catch { /* already closed */ }
  }
}
