import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { nodeLogFacetLane, nodeRuntime, postgresConnection } from './adapters/node.js';
import { drain,drainJobs } from './dispatch.js';
import { refreshPoolQuotas, type GateState } from './dispatcher.js';
import { refreshDeliverabilitySources } from './glass-deliverability.js';
import { jobConcurrency } from './jobs.js';
import { hourlyUpkeep, retentionTick } from './maintenance.js';
import { reconcileSharedConnections } from './provider-connections.js';
import { publicStatsTick } from './public-stats.js';
import { auditSendingOutcomePage, foldSendingTallies } from './sending-tallies.js';
import { healthTick } from './health.js';
import { flushCounters } from './health-counters.js';
import { standingTick } from './standing.js';
import { ensureSenderDisplayDiscovery } from './sender-display-score.js';
import { signupsTick } from './signups.js';
import { dueLogFacetSlots, LOG_FACET_TICK_MS } from './log-facet-fold.js';
import { bootstrapLogFacet, LOG_FACET_BOOTSTRAP_TICK_MS } from './log-facet-bootstrap.js';
import { syncOutboundMessages } from './mailbox-send.js';
import { scheduleHoldRelease } from './mailbox-staging.js';
import { queueStartupDiscovery } from './ses-regions.js';
import { ApiError, log, logError, setLogContext } from './core.js';
setLogContext({ service: 'runner', deploy: process.env.DEPLOY_SHA });
try {
  const { runtime, close } = nodeRuntime(process.env);
  const concurrency = jobConcurrency(process.env.JOB_CONCURRENCY);
  let stopped = false; let lastCleanup = 0; let lastOutboundSync = 0; let lastRecovery = 0;
  let sharedSetup: Promise<void> | undefined, lastSharedSetup = 0;
  let publicStats: Promise<void> | undefined, lastPublicStats = 0;
  let display: Promise<void> | undefined, lastDisplay = 0;
  let health: Promise<unknown> | undefined, lastHealth = 0;
  let hourly: Promise<unknown> | undefined, sentRetention: Promise<unknown> | undefined, lastSentRetention = 0;
  // In-process pacing state per account/region. Run one runner per installation (or split
  // the quota explicitly): separate processes do not share this gate.
  const gates = new Map<string, GateState>();
  // LISTEN requires a session connection, not a checked-out query/transaction connection. Losing
  // this best-effort nudge only costs latency: ordinary leases still discover every due row.
  const priorityWake = new EventTarget();
  let listener: Client | undefined, lastListen = 0;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; });
  log('info', { code: 'RUNNER_READY', liveSesEnabled: runtime.config.liveEnabled });
  // A dedicated cadence and pool: up to four source folds plus one control connection, never a
  // checkout from the mail runner's pool. Bootstrap yields to the ordinary viewer tickets.
  const facetLane=nodeLogFacetLane(runtime,process.env.DATABASE_URL), facetRuntime=facetLane.get();
  const startFacet=facetLane.nudge;
  runtime.startLogFacetFold=startFacet;
  runtime.startLogFacetAggregate=facetLane.aggregate;
  const facets = (async () => {
    let bootstrap: Promise<void> | undefined, lastBootstrap = 0;
    while (!stopped) {
      try { for (const slot of await dueLogFacetSlots(facetRuntime.db)) startFacet(slot); }
      catch { log('warn', { code: 'LOG_FACET_TICK_FAILED' }); }
      if(!bootstrap){
        const upkeep=Date.now()-lastBootstrap>=LOG_FACET_BOOTSTRAP_TICK_MS;
        if(upkeep)lastBootstrap=Date.now();
        bootstrap=(async()=>{
          const {maintainFacetAggregates}=await import('./log-facet-aggregate-worker.js');
          const active=await maintainFacetAggregates(facetRuntime.db,350,upkeep);
          if(!active&&upkeep&&runtime.config.multiTenant){
            const ticket=await bootstrapLogFacet(facetRuntime);if(ticket)startFacet(ticket.slot);
          }
        })().catch(()=>log('warn',{code:'LOG_FACET_BOOTSTRAP_FAILED'})).finally(()=>{bootstrap=undefined;});
      }
      await setTimeout(LOG_FACET_TICK_MS);
    }
    await bootstrap;
    await facetLane.close();
  })();
  const hooks=(async()=>{while(!stopped){try{if(await drainJobs(runtime,20,2,5000,'webhooks'))continue;}catch{log('warn',{code:'WEBHOOK_DRAIN_FAILED'});}await setTimeout(1000);}})();
  try {
    await queueStartupDiscovery(runtime);
    while (!stopped) {
      try {
        if (!listener && Date.now() - lastListen >= 15000) {
          lastListen = Date.now();
          const client = new Client(postgresConnection(process.env.DATABASE_URL));
          client.on('notification', msg => { if (msg.payload) priorityWake.dispatchEvent(new Event(msg.payload)); });
          client.on('error', () => log('warn', { code: 'DISPATCH_LISTENER_FAILED', message: 'Priority wakes disconnected; ordinary leases continue.' }));
          client.on('end', () => { if (listener === client) listener = undefined; });
          try { await client.connect(); await client.query('LISTEN bane_priority'); listener = client; }
          catch { await client.end(); }
        }
        // Don't stall mail dispatch while waiting for a platform pool to come online.
        if (runtime.config.multiTenant && !sharedSetup && Date.now() - lastSharedSetup >= 60_000) {
          lastSharedSetup = Date.now();
          sharedSetup = reconcileSharedConnections(runtime).catch(() => log('warn', { code: 'SHARED_SETUP_FAILED' })).then(() => refreshPoolQuotas(runtime)).then(() => refreshDeliverabilitySources(runtime)).finally(() => { sharedSetup = undefined; });
        }
        // Health (src/health.ts): what is falling behind, once a minute, in the background. There are no Cloudflare
        // queues here: the jobs table is the queue. This process's own counts (its jobs' database errors) go first.
        if (!health && Date.now() - lastHealth >= 60_000) {
          lastHealth = Date.now();
          health = flushCounters(runtime.db).then(() => healthTick(runtime)).finally(() => { health = undefined; });
        }
        // GET /v1/public/stats serves only what this writes. In the background, so dispatch never waits on it.
        if (!publicStats && Date.now() - lastPublicStats >= 60_000) {
          lastPublicStats = Date.now();
          publicStats = foldSendingTallies(runtime).catch(() => log('warn', { code: 'SENDING_TALLIES_FOLD_FAILED' })).then(() => publicStatsTick(runtime)).then(() => standingTick(runtime)).then(() => signupsTick(runtime)).then(async () => { await auditSendingOutcomePage(runtime); }).finally(() => { publicStats = undefined; });
        }
        // Keep the display scanner scheduled without reserving a dispatch lane or using a request to seed it.
        if (!display && Date.now() - lastDisplay >= 60_000) {
          lastDisplay = Date.now();
          display = ensureSenderDisplayDiscovery(runtime.db).catch(() => log('warn', { code: 'DISPLAY_SCORE_DISCOVERY_FAILED' })).finally(() => { display = undefined; });
        }
        // In the background, like shared setup: retention can take minutes, and a step that keeps failing used to throw
        // here before drain() on every pass, so no job ran and no mail was dispatched until it succeeded.
        if (!hourly && Date.now() - lastCleanup > 3600000) {
          lastCleanup = Date.now();
          hourly = hourlyUpkeep(runtime).finally(() => { hourly = undefined; });
        }
        // The sent-side tables every 15 minutes (elected in the database), in the background too.
        if (!sentRetention && Date.now() - lastSentRetention >= 60_000) {
          lastSentRetention = Date.now();
          sentRetention = retentionTick(runtime).catch(error => log('warn', { code: error instanceof ApiError ? error.code : 'RETENTION_TICK_FAILED' })).finally(() => { sentRetention = undefined; });
        }
        if (Date.now() - lastOutboundSync > 15000) {
          lastOutboundSync = Date.now();
          try { await syncOutboundMessages(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
        }
        const recover = Date.now() - lastRecovery >= 60_000;
        if (recover) try { await (await import('./sending.js')).screenHeldMail(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'HELD_SCREEN_SWEEP_FAILED' }); }
        if (recover) try { await scheduleHoldRelease(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'MAILBOX_HOLD_RELEASE_FAILED' }); }
        if (recover && runtime.config.multiTenant) try { await (await import('./billing/stripe-jobs.js')).billingMinute(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'BILLING_MINUTE_FAILED' }); }
        if (recover && runtime.config.multiTenant) try { await (await import('./domain-setup.js')).domainSetupTick(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'DOMAIN_SETUP_TICK_FAILED' }); }
        const count = await drain(runtime, concurrency * 10, concurrency, 5000, gates, recover, priorityWake,'work');
        if (recover) lastRecovery = Date.now();
        if (!count) await setTimeout(1000);
      } catch (error) {
        logError(error, { code: error instanceof ApiError ? error.code : 'RUNNER_FAILED' }); // Job polling failed: check database connectivity and migrations.
        await setTimeout(5000);
      }
    }
  } finally { stopped=true;await facets;await hooks;await sharedSetup;await publicStats;await display;await health;await hourly;await sentRetention; await listener?.end(); await close(); }
} catch (error) {
  logError(error, { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED' });
  process.exitCode = 1;
}
