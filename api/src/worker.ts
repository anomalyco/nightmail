import {gatewayLane} from './protocol-admission.js';
import { getPath } from 'hono/utils/url';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Config, FeedbackItem, Runtime } from './core.js';
import { DispatcherShard, dispatcherName, shardCount, shardsForRate } from './dispatcher-do.js';
import { CampaignRoom } from './campaign-room.js';
import { durableInboxWake } from './inbox-wake.js';
import { ROOM_PEER_HEADER } from './campaign-room-protocol.js';
import type { SupportPlatformApi } from './support-platform.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { clientIpHeader, clientNetworkHeader, healthService, legacyClientIpHeaders, requestHeaderNames, setting } from './brand.js';
import { oldDashboardReference } from './dashboard-reference.js';
import { isMissingComparePage, isMissingDocsPage, isMissingLegalPage, isPublicPage, movedPage, SITE_INDEX, withSiteIndex } from './site-index.js';
import { linkHostRequest, sharedLinkPage } from './link-hosts.js';
export { DispatcherShard, CampaignRoom };

// Keep top-level evaluation empty so cold-started isolates answer /health without
// loading OpenAPI/Zod schemas, Better Auth, MCP, Drizzle, pg or AWS SDK clients.
function fastSecure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// A page this Worker answers from the static assets (the homepage, a dashboard route's shell, a page not found), as
// Workers Assets sent it but never transformed on the way, and compressed here, which no-transform stops Cloudflare
// doing: a Content-Encoding the client accepts has the runtime encode the body (brotli, else gzip). (no-transform kept
// Cloudflare's analytics beacon off these pages; Web Analytics is now off for the zone. The pages served before the
// Worker, the price, docs and legal pages, are compressed by Cloudflare.)
function untransformed(response: Response, request: Request, status = response.status): Response {
  const headers = new Headers(response.headers), cache = headers.get('cache-control') ?? 'public, max-age=0, must-revalidate';
  if (!/\bno-transform\b/.test(cache)) headers.set('cache-control', `${cache}, no-transform`);
  if ((response.status === 200 || response.status === 304) && !headers.has('content-encoding')) {
    const encoding = clientEncoding(request), etag = headers.get('etag');
    headers.append('vary', 'accept-encoding');
    // The encoded body is another representation of the file: its validator is weak (on the 304 too), as Cloudflare makes
    // it when it compresses. Workers Assets matches If-None-Match either way.
    if (encoding && etag?.startsWith('"')) headers.set('etag', `W/${etag}`);
    if (encoding && response.status === 200) { headers.set('content-encoding', encoding); headers.delete('content-length'); }
  }
  return fastSecure(new Response(response.body, { status, statusText: status === response.status ? response.statusText : '', headers }));
}

// What the client accepts. Cloudflare tells every Worker "br, gzip" and keeps the client's own header in
// cf.clientAcceptEncoding; with no-transform nothing on the way decodes a body for a client that can't, so the choice
// is made from the client's header (q=0 refuses a coding).
function clientEncoding(request: Request): 'br' | 'gzip' | null {
  const header = request.cf ? (typeof request.cf.clientAcceptEncoding === 'string' ? request.cf.clientAcceptEncoding : '') : request.headers.get('accept-encoding') ?? '';
  const accepted = new Set(header.toLowerCase().split(',').map(part => part.split(';'))
    .filter(([, ...params]) => !params.some(param => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param))).map(([coding]) => coding!.trim()));
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}

// /llms.txt: the API's, with the website's own pages under its title when the dashboard build lists them (site-index.ts).
async function withSitePages(response: Response, assets: Fetcher, url: URL): Promise<Response> {
  const site = await assets.fetch(new Request(new URL(SITE_INDEX, url))).catch(() => null);
  if (!site?.ok || !site.headers.get('content-type')?.startsWith('text/plain')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(withSiteIndex(await response.text(), await site.text()), { status: response.status, statusText: response.statusText, headers });
}

function initRuntimeDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'),
    import('./jobs.js'), import('./core.js'),
    import('./adapters/browser-rendering.js'), import('./adapters/public-image.js'), import('./adapters/feedback-queue.js'), import('./screen-shadow.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { CONFIG_KEYS, loadConfig }, { r2Storage }, { followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY }, core, { browserImageRenderer }, { publicImageImporter }, { feedbackSink, settleFeedbackBatch, legacyFeedbackCutover, workWake, batchFirstDeliveryLag, metricsEffectiveLagMs }, { enqueueShadow, consumeShadow, writeComparisons, writtenComparisons }]) => ({
    Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, settleFeedbackBatch, legacyFeedbackCutover, workWake, batchFirstDeliveryLag, metricsEffectiveLagMs, enqueueShadow, consumeShadow, writeComparisons, writtenComparisons,
  }));
}
async function toModuleLoadError(error: unknown): Promise<never> {
  const core = await import('./core.js').catch(() => null);
  throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
}
let runtimeDepsPromise: ReturnType<typeof initRuntimeDeps> | undefined;
function loadRuntimeDeps() {
  return runtimeDepsPromise ??= initRuntimeDeps().catch(error => { runtimeDepsPromise = undefined; return toModuleLoadError(error); });
}
let appPromise: Promise<typeof import('./app.js')> | undefined;
function loadApp() {
  return appPromise ??= import('./app.js').catch(error => { appPromise = undefined; return toModuleLoadError(error); });
}
function loadHttpDeps() {
  return Promise.all([loadRuntimeDeps(), loadApp()]).then(([runtimeDeps, { app }]) => ({ ...runtimeDeps, app }));
}

// Derive mail-room shard count from the SES account's MaxSendRate (TARGET_SHARD_RATE = 25/s per shard), cached 60 s per isolate.
let nextShard: number | undefined;
let lastPriorityLagWrite = 0, lastPriorityLagHigh = false;
const rateCache = new Map<string, { rate: number; until: number }>();
const RATE_CACHE_MS = 60_000;
async function wakeDispatchers(env: Env, region: string, accountId?: string, emails?: number, kind?: 'shared' | 'byo', priority = false, maxSendRate?: number, lookupRate?: (region: string, accountId?: string) => Promise<number | undefined>) {
  const cacheKey = `${accountId ?? ''}:${region}`, now = Date.now();
  let rate = typeof maxSendRate === 'number' && Number.isFinite(maxSendRate) && maxSendRate > 0 ? maxSendRate : undefined;
  if (rate !== undefined) {
    if (rateCache.size > 256) rateCache.clear();
    rateCache.set(cacheKey, { rate, until: now + RATE_CACHE_MS });
  } else {
    const cached = rateCache.get(cacheKey);
    if (cached && cached.until > now) rate = cached.rate;
    else if (lookupRate) {
      const fetched = await lookupRate(region, accountId).catch(() => undefined);
      if (typeof fetched === 'number' && Number.isFinite(fetched) && fetched > 0) {
        rate = fetched;
        if (rateCache.size > 256) rateCache.clear();
        rateCache.set(cacheKey, { rate, until: now + RATE_CACHE_MS });
      }
    }
  }
  const fallback = kind === 'byo' ? 1 : shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  const count = shardsForRate(rate, fallback);
  nextShard ??= Math.floor(Math.random() * 0x100000000);
  const indexes = emails !== undefined && emails <= 6 ? [nextShard++ % count] : Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(index => {
    const identity = { accountId, region, shard: { index, count }, autoScale: true };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(region)}&shard=${index}&count=${count}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}${priority ? '&priority=1' : ''}&auto=1`);
  }));
}

// An agent's read or save, told to the campaign's room (src/campaign-room.ts) beside the request, never in its way. A
// room that says nobody is in it isn't asked again from this isolate for half a minute, so an agent polling a draft
// nobody has open wakes it at most twice a minute here and costs no query or storage. Names are kept for ten minutes,
// so a room with people in it takes one call; the first needs one lookup on a connection of its own. An agent the room
// heard from lately isn't reported again from here for a quarter of a minute (it stays on screen for two), unless it saved:
// a save (saved, its revision) always reaches a room with people in it, who read it at once.
const quietRooms = new Map<string, number>(), agentNames = new Map<string, { name: string; until: number }>(), reported = new Map<string, number>();
const QUIET_MS = 30_000, NAME_MS = 600_000, REPORTED_MS = 15_000;
async function roomVisit(env: Env, rooms: NonNullable<Env['CAMPAIGN_ROOMS']>, room: string, credential: string, lookup: (runtime: Runtime) => Promise<string | null>, saved?: number) {
  const now = Date.now(), visit = `${room}|${credential}`;
  if ((quietRooms.get(room) ?? 0) > now || (saved === undefined && (reported.get(visit) ?? 0) > now)) return;
  try {
    const stub = rooms.getByName(room);
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${room}:${credential}`))), n => n.toString(16).padStart(2, '0')).join('').slice(0, 16);
    let known = agentNames.get(credential);
    if (!known || known.until <= now) {
      if (!await stub.visit({ id })) { quiet(room, now); return; }
      known = { name: await withRuntime(env, lookup).catch(() => null) ?? 'An agent', until: now + NAME_MS };
      if (agentNames.size > 1000) agentNames.clear();
      agentNames.set(credential, known);
    }
    if (!await stub.visit({ id, name: known.name }, saved)) { quiet(room, now); return; }
    if (reported.size > 1000) reported.clear();
    reported.set(visit, now + REPORTED_MS);
  } catch { /* Presence is best-effort: the request it follows has already answered. */ }
}
function quiet(room: string, now: number) { if (quietRooms.size > 1000) quietRooms.clear(); quietRooms.set(room, now + QUIET_MS); }

// Every line names the Worker and the commit it runs (DEPLOY_SHA, set by .github/scripts/deploy-worker.sh).
function stampLogs(env: Env, core: typeof import('./core.js')) {
  core.setLogContext({ service: 'worker', deploy: (env as unknown as Record<string, unknown>).DEPLOY_SHA });
}

let cachedConfig: { key: string; config: Config } | undefined;
function configFor(env: Env, keys: readonly string[], loadConfig: (input: Record<string, unknown>) => Config): Config {
  const input: Record<string, unknown> = {};
  const record = env as unknown as Record<string, unknown>;
  for (const name of keys) if (name in record) input[name] = record[name];
  const key = JSON.stringify(input);
  if (cachedConfig?.key === key) return { ...cachedConfig.config };
  const config = loadConfig(input);
  cachedConfig = { key, config };
  return { ...config };
}

const queueName = (env: Env, key: 'FEEDBACK_QUEUE_NAME' | 'FEEDBACK_PRIORITY_QUEUE_NAME' | 'LEGACY_FEEDBACK_QUEUE_NAME' | 'FEEDBACK_DLQ_NAME' | 'LEGACY_FEEDBACK_DLQ_NAME' | 'WORK_QUEUE_NAME', fallback: string) => {
  const value: unknown = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : fallback;
};
/** `shadowWaitUntil`: the invocation's waitUntil, for the sends to the second classifier's queue alone, from a handler that
 *  gives no `ctx` here (queue, scheduled: their database connection is closed before they return, as before). */
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, max = 1, ctx?: ExecutionContext, shadowWaitUntil?: (sent: Promise<unknown>) => void): Promise<T> {
  const { Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, workWake, enqueueShadow } = await loadRuntimeDeps();
  // Optional Worker variable, default two active jobs; six matches the platform's
  // simultaneous outbound-connection ceiling while the shared SES gate limits rate.
  const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
  const config = configFor(env, CONFIG_KEYS, loadConfig);
  // Shadow comparisons go to the queue consumer when the drain ends. With no queue bound only comparisons are off.
  // Nothing here waits for those sends: the invocation's waitUntil keeps them alive after it has answered or
  // acknowledged. Only a caller with no waitUntil at all (none makes a classifier request) would wait for them at its end.
  const shadowQueue = env.JEVF_QUEUE, handovers: Promise<void>[] = [];
  const keepShadow = shadowWaitUntil ?? (ctx ? (sent: Promise<unknown>) => ctx.waitUntil(sent) : undefined);
  if (!shadowQueue) config.shadow = undefined;
  // Defer Hyperdrive/Pool creation until a handler actually touches db: missing-auth,
  // validation and cached responses never allocate a pool or touch Hyperdrive.
  let client: InstanceType<typeof Pool> | undefined;
  let instance: Runtime['db'] | undefined;
  const getDb = () => {
    if (!instance) {
      client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max });
      client.on('error', () => { /* An idle reset surfaces on the next query; teardown ignores it. */ });
      instance = drizzle(client);
    }
    return instance;
  };
  const db = new Proxy({} as Runtime['db'], {
    get(_target, prop) {
      const target = getDb();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const nudges: ((runtime: Runtime) => Promise<void>)[] = [];
  const rooms = env.CAMPAIGN_ROOMS;
  try {
    const notify = workWake(env.WAKE_QUEUE, concurrency);
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, shadow: shadowQueue && (items => { const sent = enqueueShadow(shadowQueue, items); if (keepShadow) keepShadow(sent); else handovers.push(sent); }), mailR2: env.MAIL && { bucket:env.MAIL,name:setting(env,'MAIL_BUCKET')!,write:setting(env,'MAIL_STORE')==='r2' }, jwksCacheScope: env.HYPERDRIVE,
      allowSnsCertMiss: async peer => (await env.SNS_CERT_MISSES.limit({key: `bane:sns-miss:${await core.digest(peer)}`})).success,
      allowMalformedSns: async peer => (await env.ADMISSION.limit({key:`bane:sns-malformed:${await core.digest(peer)}`})).success,
      // Weighted so a peer's 20 failed SNS verifications a minute spend the limiter's 6,000 (operations.ts SnsFailureBudget).
      allowSnsFailure: async peer => (await env.ADMISSION.limit({key:`bane:sns-invalid:${await core.digest(peer)}`,delta:300} as RateLimitOptions)).success,
      // 6,000 units of 16 KiB a minute per workspace in each location: about 94 MiB of preview memory, eight previews at the limit.
      // The per-isolate budget is the memory bound, so a limiter that rejects the weight fails open.
      allowPreview:(workspaceId,bytes)=>env.ADMISSION.limit({key:`bane:preview:${workspaceId}`,delta:Math.max(1,Math.ceil(bytes/16384))} as RateLimitOptions).then(r=>r.success,()=>{core.log('warn',{code:'PREVIEW_RATE_LIMIT_UNAVAILABLE'});return true;}),
      allowFeedbackTopic:async arn=>(await env.ADMISSION.limit({key:`feedback:${arn}`})).success,
      // Dashboard analytics (src/analytics.ts): their own bucket and limiter where the config binds them. A limiter that
      // fails lets the batch through; the per-process cap still applies.
      analyticsStorage: env.ANALYTICS ? r2Storage(env.ANALYTICS) : undefined,
      allowAnalytics: env.ANALYTICS_INGEST ? peer => env.ANALYTICS_INGEST!.limit({ key: `analytics:${peer}` }).then(r => r.success, () => true) : undefined,
      // The database disk alert (src/disk-alert.ts): one card a minute per threshold. A limiter that fails lets the card through.
      allowDiskAlert: env.DISK_ALERT ? key => env.DISK_ALERT!.limit({ key: `disk-alert:${key}` }).then(r => r.success, () => true) : undefined,
      // Campaign rooms (src/campaign-room.ts). A room answers the upgrade itself; the person rides in a header only this builds.
      campaignRooms: rooms && {
        connect: (name, person) => { quietRooms.delete(name); return rooms.getByName(name).fetch('https://room/connect', { headers: { upgrade: 'websocket', [ROOM_PEER_HEADER]: encodeURIComponent(JSON.stringify(person)) } }); },
        visit: (name, credential, lookup, saved) => { const visit = roomVisit(env, rooms, name, credential, lookup, saved); if (ctx) ctx.waitUntil(visit); },
      },
      startLogFacetFold: ctx ? slot => afterwards(env,ctx,async independent => { await (await import('./log-facet-fold.js')).foldLogFacetSlot(independent,slot); }) : undefined,
      startLogFacetAggregate: ctx ? workspace => afterwards(env,ctx,async independent => {
        try { await (await import('./log-facet-aggregate-worker.js')).runFacetAggregateTurn(independent.db,workspace); }
        catch { core.log('warn',{code:'LOG_FACET_AGGREGATE_FAILED',workspaceId:workspace}); }
      }) : undefined,
      placementEdge:{probesPerJob:Math.min(3,Math.floor(6/concurrency))}, deferNudge: ctx ? pending => { nudges.push(pending); } : undefined,
      // Inbox long polls wait on their workspace's object in the dispatcher namespace and end as mail is stored.
      inboxWake: durableInboxWake(env.DISPATCHER),
      deprecatedCallScope: env.HYPERDRIVE,
      detach: ctx ? detached => { const run = withRuntime(env, detached, 1, ctx); ctx.waitUntil(run.catch(() => {})); return run; } : undefined, wake: async (readyJobs = 1, immediate) => {
      if (immediate === 'webhook' && env.WEBHOOK_QUEUE) return workWake(env.WEBHOOK_QUEUE,concurrency)(readyJobs);
      if (immediate || readyJobs > concurrency) return notify(readyJobs);
      // Only orchestration singletons coalesce. Delay past the window so the signal cannot
      // be consumed before a later coalesced commit; callback delivery never waits here.
      const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
        VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + interval '1 second')
        ON CONFLICT (workspace_id) DO UPDATE SET wake_not_before = clock_timestamp() + interval '1 second'
        WHERE job_schedule.wake_not_before IS NULL OR job_schedule.wake_not_before <= clock_timestamp()
        RETURNING wake_not_before::text`);
      const fence = reserved.rows[0]?.wake_not_before;
      if (!fence) { core.log('info', { code: 'QUEUE_WAKE_COALESCED', readyJobs }); return; }
      try { await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds: 1 }); }
      catch (error) {
        try { await db.execute(sql`UPDATE job_schedule SET wake_not_before = NULL WHERE workspace_id = ${WAKE_SCHEDULE_KEY} AND wake_not_before = ${fence}::timestamptz`); }
        catch { /* Preserve the send error; this reservation also expires on its own. */ }
        throw error;
      }
      core.log('info', { code: 'QUEUE_WAKE', readyJobs, messages: 1 });
    }, dispatch: (region, accountId, emails, kind, priority, maxSendRate) => wakeDispatchers(env, region, accountId, emails, kind, priority, maxSendRate, async (r, a) => {
      const { rows: [lim] } = await db.execute<{ rate: number | null }>(a
        ? sql`SELECT max_send_rate AS rate FROM provider_account_limits WHERE aws_account_id=${a} AND region=${r} AND max_send_rate>0`
        : sql`SELECT max(max_send_rate) AS rate FROM sending_region_limits WHERE region=${r} AND max_send_rate>0`);
      return typeof lim?.rate === 'number' && lim.rate > 0 ? lim.rate : undefined;
    }), feedback: feedbackSink(env.FEEDBACK_QUEUE, config.authSecret, env.FEEDBACK_PRIORITY_QUEUE), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally {
    if (client) {
      if (ctx) ctx.waitUntil(client.end().catch(() => {}));
      else await client.end();
    }
    // Sends to the second classifier's queue from a caller that gave no waitUntil: without this they would be cut off.
    if (handovers.length) await Promise.all(handovers);
    // Dispatch and immediate webhook nudges open no database connection.
    if (ctx && nudges.length) ctx.waitUntil(withRuntime(env, async runtime => { for (const nudge of nudges) await nudge(runtime); }));
  }
}
// Optional background work gets a separate connection and never delays its caller. Health samples
// may be lost; durable Logs tickets have their own recovery cadence. Each task sets its own limits.
function afterwards(env: Env, ctx: ExecutionContext | undefined, work: (runtime: Runtime) => Promise<unknown>) {
  try { if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(withRuntime(env, async runtime => { await work(runtime); }).catch(() => { /* Background failures do not fail the served request or queue event. */ })); }
  catch { /* Background failures do not fail the served request or queue event. */ }
}
// What this isolate counted (its jobs' database errors, its error lines), at most every 20 seconds.
async function flushDueCounters(env: Env, ctx: ExecutionContext | undefined) {
  try { const { countersDue, flushCounters } = await import('./health-counters.js'); if (countersDue()) afterwards(env, ctx, runtime => flushCounters(runtime.db)); } catch { /* Counted again with the next batch. */ }
}
/** A handler's waitUntil as withRuntime's shadowWaitUntil. (A test may call a handler with no context.) */
const waitUntilOf = (ctx: ExecutionContext | undefined) => typeof ctx?.waitUntil === 'function' ? (sent: Promise<unknown>) => ctx.waitUntil(sent) : undefined;
/**
 * The support platform's service-binding entrypoint (api/README.md "Support integration"): the bane-support Worker in
 * the same account binds `{ service: "bane-production" | "bane-dev", entrypoint: "SupportPlatform" }` and calls these
 * methods over RPC. There is no token: only a Worker whose deployed config declares this binding can reach it. Every call
 * runs through the normal routes (validation, audit, budgets) as `service:bane-support`, on its own admission lane.
 */
/** Connections per support platform call: support reads (the context summary, a request's trace) run their queries in
 *  parallel. Within the six simultaneous outbound connections a Worker invocation may open (a trace also asks Workers Logs). */
const SUPPORT_POOL = 4;
export class SupportPlatform extends WorkerEntrypoint<Env> {
  private async platform(): Promise<SupportPlatformApi> {
    const [{ app, core }, { supportPlatform, platformRuntime }, { CONFIG_KEYS, loadConfig }] = await Promise.all([loadHttpDeps(), import('./support-platform.js'), import('./config.js')]);
    stampLogs(this.env, core);
    const config = () => configFor(this.env, CONFIG_KEYS, loadConfig);
    // The conversation of a request() call rides on the runtime, like the caller: no HTTP request can set either.
    return supportPlatform(async (request, conversation) => {
      if (!(await this.env.ADMISSION.limit({ key: 'bane:support-platform' })).success) return core.admissionDenied();
      return withRuntime(this.env, async runtime => app.fetch(request, { ...runtime, ...platformRuntime(conversation) }), SUPPORT_POOL, this.ctx);
    }, config);
  }
  async verifyWake(token: string, conversationId: string) { return (await this.platform()).verifyWake(token, conversationId); }
  async verifyFile(token: string, conversationId: string, attachmentId: string) { return (await this.platform()).verifyFile(token, conversationId, attachmentId); }
  async verifyHandoff(token: string) { return (await this.platform()).verifyHandoff(token); }
  async registerConversation(body: Parameters<SupportPlatformApi['registerConversation']>[0]) { return (await this.platform()).registerConversation(body); }
  async closeConversation(conversationId: string) { return (await this.platform()).closeConversation(conversationId); }
  async request(conversationId: string, method: string, path: string, body?: unknown) { return (await this.platform()).request(conversationId, method, path, body); }
  async mirrorMessages(conversationId: string, messages: Parameters<SupportPlatformApi['mirrorMessages']>[1]) { return (await this.platform()).mirrorMessages(conversationId, messages); }
  async mirrorState(conversationId: string, state: Parameters<SupportPlatformApi['mirrorState']>[1]) { return (await this.platform()).mirrorState(conversationId, state); }
  async inboxState(conversationId: string) { return (await this.platform()).inboxState(conversationId); }
  async pullOutbox(conversationId?: string) { return (await this.platform()).pullOutbox(conversationId); }
  async generalAnswers(conversationId?: string) { return (await this.platform()).generalAnswers(conversationId); }
  async filedConversation(conversationId: string) { return (await this.platform()).filedConversation(conversationId); }
  async markDelivery(conversationId: string, messageId: string, status: 'sent' | 'failed') { return (await this.platform()).markDelivery(conversationId, messageId, status); }
  async staffMail() { return (await this.platform()).staffMail(); }
  async staffMailSent(key: string, sent: { threadId: string; messageId: string }) { return (await this.platform()).staffMailSent(key, sent); }
  async staffMailFailed(key: string, failed: { code: string }) { return (await this.platform()).staffMailFailed(key, failed); }
  async staffMailReply(messageId: string, team: string | null) { return (await this.platform()).staffMailReply(messageId, team); }
  async feedbackDue(limit: number) { return (await this.platform()).feedbackDue(limit); }
  async feedbackRequest(conversationId: string, requestId: string) { return (await this.platform()).feedbackRequest(conversationId, requestId); }
  async feedbackRelated(conversationId: string) { return (await this.platform()).feedbackRelated(conversationId); }
  async feedbackTriage(conversationId: string, note: Parameters<SupportPlatformApi['feedbackTriage']>[1]) { return (await this.platform()).feedbackTriage(conversationId, note); }
  async feedbackUsage(conversationId: string, usage: Parameters<SupportPlatformApi['feedbackUsage']>[1]) { return (await this.platform()).feedbackUsage(conversationId, usage); }
  async agentAnswersDue(limit: number) { return (await this.platform()).agentAnswersDue(limit); }
  // A plain fetch to the entrypoint answers nothing: the methods above are the whole surface.
  override async fetch() { return new Response(null, { status: 404 }); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.method === 'GET' || request.method === 'HEAD') { url.protocol = 'https:'; return fastSecure(Response.redirect(url.toString(), 301)); }
      return fastSecure(Response.json({ error: { code: 'HTTPS_REQUIRED', message: 'Use HTTPS.', retryable: false } }, { status: 403, headers: { 'cache-control': 'no-store' } }));
    }
    const pathname = getPath(request);
    // The events host (BYO_EVENTS_ORIGIN) takes AWS's signed notifications and nothing else.
    let eventsHost: string | undefined; try { eventsHost = new URL(String((env as { BYO_EVENTS_ORIGIN?: unknown }).BYO_EVENTS_ORIGIN)).host; } catch { eventsHost = undefined; }
    if (eventsHost && url.host === eventsHost && pathname !== '/health' && !(request.method === 'POST' && (pathname === '/v1/events/ses' || pathname === '/v1/events/cloudformation'))) return fastSecure(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }));
    // The link domain and customers' own link hosts (src/link-hosts.ts) answer the links in customer mail and nothing else.
    // With either on, every host that is none of this installation's own came through the link zone's route.
    const own = [String((env as { PUBLIC_URL?: unknown }).PUBLIC_URL), ...String((env as { PREVIOUS_PUBLIC_URLS?: unknown }).PREVIOUS_PUBLIC_URLS ?? '').split(',')]
      .flatMap(origin => { try { return [new URL(origin.trim()).hostname]; } catch { return []; } }).concat(eventsHost ? [eventsHost.replace(/:\d+$/, '')] : []);
    const info = own.includes(url.hostname) ? null : sharedLinkPage(request, setting(env, 'LINK_HOST'));
    if (info) return fastSecure(info);
    const linkAnswer = linkHostRequest(!!setting(env, 'LINK_HOST') || !!setting(env, 'LINK_SAAS_ZONE_ID') && !!setting(env, 'LINK_SAAS_TOKEN'), url.hostname, pathname, own);
    if (linkAnswer === 'missing') return fastSecure(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }));
    // A name of the zone that isn't this Worker's (dev, support, media): the zone-wide route runs before its custom domain
    // or bucket, so it goes on to them unchanged (a subrequest to the same zone skips the route).
    if (linkAnswer === 'pass') return fetch(request);
    const linkHost = linkAnswer === 'link';
    if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD') && !requestHeaderNames('environment').some(name => request.headers.has(name))) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const multiTenant = ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true', analytics = (env as unknown as { DASHBOARD_ANALYTICS?: unknown }).DASHBOARD_ANALYTICS === 'on';
      // The installation's canonical origin (PUBLIC_URL), never the request's Host; omitted if PUBLIC_URL isn't a URL.
      let origin: string | undefined; try { origin = new URL(String((env as { PUBLIC_URL?: unknown }).PUBLIC_URL)).origin; if (origin === 'null') origin = undefined; } catch { origin = undefined; }
      return fastSecure(new Response(request.method==='HEAD'?null:JSON.stringify({status:'ok',service:healthService,multiTenant,...(origin ? { origin } : {}),analytics}), { headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'x-request-id': requestId } }));
    }
    if (!linkHost && pathname.startsWith('/docs/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const old = oldDashboardReference(pathname, request.method);
      if (old) return fastSecure(old);
    }
    const staticDoc = (request.method === 'GET' || request.method === 'HEAD') && (['/openapi.json', '/docs.md', '/llms.txt'].includes(pathname) || pathname.startsWith('/docs/operations/') || pathname.startsWith('/docs/tags/'));
    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    if (assets && (request.method === 'GET' || request.method === 'HEAD') && !staticDoc && !linkHost && !/^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|internal|i)(?:\/|$)/.test(pathname)) {
      // Existing files are served asset-first. Only dashboard routes get the shell on a miss. "/" on a hosted
      // installation is the homepage: home.html, the dashboard's shell with the homepage's first screen painted in it
      // (app/home-shell.ts); Workers Assets answers /home with it.
      // A hashed build file or a link-preview card (og/<name>-<hash>.png: app/link-card.ts) that isn't there is not found.
      if (pathname.startsWith('/assets/') || pathname.startsWith('/og/')) return fastSecure(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }));
      const home = pathname === '/' && ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true';
      if (home) { const page = await assets.fetch(new Request(new URL('/home', url), request)); if (page.ok || page.status === 304) return untransformed(page, request); }
      // The price, comparison, docs and legal pages are files, served before this Worker (wrangler configs: not in
      // run_worker_first); one reaches it only when there is no such file: not found below, or moved.
      const shell = await assets.fetch(new Request(new URL('/', url), request));
      // An operation's reference page under its old name moves to the new one (site-index.ts, RENAMED_OPERATIONS), and
      // /alternatives to /compare (movedPage).
      const renamed = movedPage(pathname);
      if (renamed) return fastSecure(new Response(null, { status: 301, headers: { location: renamed + url.search, 'cache-control': 'public, max-age=3600' } }));
      // A comparison the build has no page for (app/price-pages.ts writes one per entry, served before the Worker): not
      // found, so search engines drop it rather than index the dashboard's shell under its address (a soft 404). The
      // shell still says so to a person: its price pages show "Page not found" for an unknown comparison. So is an operation
      // or a legal document with no page (app/site-pages.ts).
      if (isMissingComparePage(pathname) || isMissingDocsPage(pathname) || isMissingLegalPage(pathname)) return untransformed(shell, request, 404);
      // A signed-in screen (site-index.ts): a crawler sees the sign-in under its address, so it stays out of search.
      const page = untransformed(shell, request);
      if (!isPublicPage(pathname)) page.headers.set('x-robots-tag', 'noindex');
      return page;
    }
    // A linked campaign image (src/linked-images.ts) is the same bytes for every reader: once answered, this colo keeps it
    // and answers it again before admission, the database or storage.
    const images = request.method === 'GET' && pathname.startsWith('/i/') && typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : undefined;
    const imageKey = images && new Request(url.origin + pathname);
    if (images && imageKey) { const kept = await images.match(imageKey).catch(() => undefined); if (kept) return kept; }
    let deps: Awaited<ReturnType<typeof loadHttpDeps>> | undefined;
    try {
      deps = await loadHttpDeps();
      const { app, core } = deps;
      stampLogs(env, core);
      const admissionStarted = performance.now();
      const address = core.admissionPeer(request.headers.get('CF-Connecting-IP') ?? '127.0.0.1');
      const peer = await core.digest(core.admissionKey(address, request.headers.get('CF-Worker')));
      // SNS shares egress IPs across subscriptions. This byte-bounded route
      // verifies the signature before looking up a topic or queuing feedback.
      const feedbackIngress = core.snsIngress(pathname) && request.method === 'POST';
      const lane = gatewayLane(request.method,pathname,request.headers,'MAILGW_API_TOKEN' in env ? env.MAILGW_API_TOKEN : undefined);
      if (!feedbackIngress && !(await env.ADMISSION.limit({ key: lane ?? `bane:default:${peer}` })).success) return core.admissionDenied();
      const admissionMs = performance.now() - admissionStarted;
      const headers = new Headers(request.headers);
      for (const name of legacyClientIpHeaders) headers.delete(name);
      headers.set(clientIpHeader, address);
      // The network Cloudflare resolved the client to, never a value the request carried.
      headers.delete(clientNetworkHeader);
      // A browser's WebSocket can't send headers: the campaign room's upgrade names its account and workspace in the query,
      // which stand in for the headers the dashboard sends with every other request (sending.ts, the room route).
      if (/^\/v1\/campaigns\/[^/]+\/room$/.test(pathname) && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        for (const name of ['account', 'workspace']) { const value = url.searchParams.get(name); if (value && !requestHeaderNames(name).some(header => headers.has(header))) headers.set(requestHeaderNames(name)[0]!, value); }
      }
      const cf = (request as Request & { cf?: { asn?: unknown; country?: string; botManagement?: { verifiedBot?: boolean; score?: number } } }).cf;
      if (typeof cf?.asn === 'number' || typeof cf?.country === 'string') headers.set(clientNetworkHeader, `${typeof cf.asn === 'number' ? `AS${cf.asn}` : ''};${typeof cf.country === 'string' ? cf.country : ''}`);
      const runtimeStarted = performance.now();
      let response = staticDoc
        ? await app.fetch(new Request(request, { headers }), {} as Runtime)
        : await core.guardPublicRequest(pathname, headers, peer, () => withRuntime(env, async runtime =>
          app.fetch(new Request(request, { headers }), pathname === '/internal/v1/analytics' ? { ...runtime, analyticsPeer: {
            ip: request.headers.get('CF-Connecting-IP') ?? '', country: cf?.country,
            bot: cf?.botManagement?.verifiedBot === true || (cf?.botManagement?.score ?? 100) === 1,
          } } : runtime), 1, ctx));
      if (pathname === '/llms.txt' && request.method === 'GET' && response.ok && assets) response = await withSitePages(response, assets, url);
      const runtimeMs = performance.now() - runtimeStarted;
      // What this isolate counted (app.ts logRequest), written after the response, at most every 20 seconds. Without a
      // context (a handler called directly) nothing is written, and nothing here can throw into the request.
      if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(flushDueCounters(env, ctx));
      // The campaign room's accepted upgrade goes back as it is: a copy would drop its socket.
      if (response.webSocket) return response;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      if(innerTiming) responseHeaders.set('server-timing', [innerTiming, `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      if (!(feedbackIngress && [400,429].includes(response.status))) core.log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      const answer = core.secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders }));
      if (images && imageKey && answer.status === 200) {
        const kept = new Response(answer.clone().body, answer);
        kept.headers.delete('x-request-id'); kept.headers.delete('server-timing');
        // Kept here an hour, not the year browsers may: a deleted picture or one taken down stops being served from this colo
        // within the hour (a Cloudflare purge of its URL ends it at once). A score card (src/score-card.ts) is never taken
        // down and its address is its design's version: kept 30 days, so each colo draws each card about once a month.
        kept.headers.set('cache-control', pathname.startsWith('/i/score-card/') ? 'public, max-age=2592000' : 'public, max-age=3600');
        ctx.waitUntil(images.put(imageKey, kept).catch(() => {}));
      }
      return answer;
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const known = deps && error instanceof deps.core.ApiError ? error : null;
      const code = known ? known.code : 'RUNTIME_UNAVAILABLE';
      if (deps) { stampLogs(env, deps.core); deps.core.logError(known ?? error, { event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code }); }
      else console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), service: 'worker', event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code, message: 'Unable to load the Worker runtime modules.' }));
      return fastSecure(Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }));
    }
  },
  // Queue/scheduled continuations preserve worker chains and retry due times.
  async queue(batch, env, ctx) {
    const { jobConcurrency, followDueJobs, core, settleFeedbackBatch, legacyFeedbackCutover, batchFirstDeliveryLag } = await loadRuntimeDeps();
    stampLogs(env, core);
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    // Queue names differ per installation (wrangler config); an unrecognized queue is retried, never acknowledged as a wake.
    const feedbackLane = batch.queue === queueName(env, 'FEEDBACK_QUEUE_NAME', 'bane-feedback') ? 'tagged'
      : (queueName(env, 'FEEDBACK_PRIORITY_QUEUE_NAME', '') && batch.queue === queueName(env, 'FEEDBACK_PRIORITY_QUEUE_NAME', '')) ? 'priority'
      : batch.queue === queueName(env, 'LEGACY_FEEDBACK_QUEUE_NAME', '') ? 'legacy'
      : batch.queue === queueName(env, 'FEEDBACK_DLQ_NAME', '') ? 'tagged-dlq'
      : batch.queue === queueName(env, 'LEGACY_FEEDBACK_DLQ_NAME', '') ? 'legacy-dlq' : undefined;
    if (feedbackLane) {
      const { ingestFeedbackBatch, archiveQueueFeedback, retainLegacyFeedback, completeLegacyFeedback } = await core.wrapModuleLoad(() => import('./operations.js'));
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries. Only items this installation tagged at
      // /v1/events/ses are ingested. Only platform-dated, pre-cutover legacy items may drain unsigned;
      // newer ones are quarantined for review. Every replay is evaluated again.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const settled = await settleFeedbackBatch({ secrets: runtime.config, lane: feedbackLane, sourceQueue: batch.queue, messages,
          legacyCutover: legacyFeedbackCutover('LEGACY_FEEDBACK_CUTOVER' in env ? env.LEGACY_FEEDBACK_CUTOVER : undefined),
          ingest: items => ingestFeedbackBatch(runtime, items),
          promoteLegacy: async item => {
            if (await retainLegacyFeedback(runtime, item) === 'storage') return;
            try { await env.FEEDBACK_QUEUE.send(item); }
            catch { core.log('warn', { code: 'FEEDBACK_LEGACY_RECOVERY_PENDING', sourceQueue: item.source.queue, sourceId: item.source.id }); }
          }, completeLegacy: item => completeLegacyFeedback(runtime, item),
          archive: (source,body,error) => archiveQueueFeedback(runtime,source,body,error) });
        const { outcomes: _, ...counts } = settled, nowMs = Date.now();
        const oldestMs = Math.max(0, ...messages.map(m => nowMs - m.timestamp.getTime()));
        // Measure priority lane lag from first deliveries only (attempts === 1): Cloudflare preserves the original
        // enqueue timestamp on retried messages, so one poison/unmatchable retry must never hold every campaign.
        const fresh = batchFirstDeliveryLag(messages, nowMs);
        core.log(counts.failed || counts.untagged || counts.unauthenticated || counts.held || oldestMs>60000?'warn':'info', { code: 'FEEDBACK_BATCH', lane: feedbackLane, size: messages.length, ...counts, oldestMs, ...(fresh !== null && fresh.oldestMs !== oldestMs ? { freshOldestMs: fresh.oldestMs } : {}) });
        // Keep priority safety-lane lag fresh within ~15 s during spikes or recovery so releaseStep reacts quickly.
        if (feedbackLane === 'priority' && fresh !== null && (fresh.oldestMs >= 60_000 || lastPriorityLagHigh)) {
          if (nowMs - lastPriorityLagWrite >= 15_000) {
            lastPriorityLagWrite = nowMs;
            lastPriorityLagHigh = fresh.oldestMs >= 60_000;
            try {
              const { recordFeedbackLag } = await import('./sending.js');
              await recordFeedbackLag(runtime.db, 'priority', fresh.count, fresh.oldestMs);
            } catch { /* Minute cron refreshes lag independently. */ }
          }
        }
      });
      await flushDueCounters(env, ctx);
      return;
    }
    // The second classifier's queue (src/screen-shadow.ts): each message is one request the content screen made. Its
    // consumer makes the comparisons: wrangler gives it at most
    // max_batch_size 4 messages an invocation (four calls and the database's connection, of an invocation's six) and
    // max_concurrency 2 invocations, eight calls in all. A batch whose rows are written is acknowledged; one whose rows
    // could not be written is delivered again (max_retries, no dead-letter queue), and then only recorded as lost.
    if (env.JEVF_QUEUE_NAME && batch.queue === env.JEVF_QUEUE_NAME) {
      const { consumeShadow, writeComparisons, writtenComparisons } = await loadRuntimeDeps();
      await withRuntime(env, async runtime => {
        const settings = runtime.config.shadow;
        if (!settings) { batch.ackAll(); return; } // Turned off since they were queued: the messages are dropped.
        const done = await consumeShadow(settings, { write: rows => writeComparisons(runtime.db, rows), written: ids => writtenComparisons(runtime.db, ids) },
          batch.messages.map(message => ({ body: message.body, attempts: message.attempts })));
        if (done) batch.ackAll(); else batch.retryAll();
      });
      return;
    }
    const hooks = batch.queue === env.WEBHOOK_QUEUE_NAME;
    const sample = !hooks && batch.messages.some(m => (m.body as { kind?: string } | null)?.kind === 'abuse-sample');
    const pool = hooks ? 'webhooks' : sample ? 'abuseSample' : 'work';
    if (!hooks && batch.queue !== queueName(env, 'WORK_QUEUE_NAME', 'bane-work')) {
      core.log('error', { code: 'UNKNOWN_QUEUE', queue: batch.queue });
      batch.retryAll();
      return;
    }
    const { drainJobs } = await core.wrapModuleLoad(() => import('./dispatch.js'));
    await withRuntime(env, async runtime => {
      // Orchestration only (mail is dispatched by Durable Objects): a longer budget lets a campaign's
      // prepare → expand → finish chain run inside one invocation instead of one queue hop per step.
      // Wait in place up to 45 s for a job due soon (paced campaign releases), and schedule at most one follow-up.
      const outcome = await followDueJobs(runtime, () => sample ? drainJobs(runtime,1,1,1000,pool) : drainJobs(runtime,100,concurrency,10000,pool), delaySeconds => (hooks?env.WEBHOOK_QUEUE:env.WAKE_QUEUE).send({ kind: sample ? 'abuse-sample' : 'wake' }, { delaySeconds }), sample ? 0 : 45000,pool);
      core.log('info', { code: 'QUEUE_FOLLOW', outcome });
      // A campaign's copies are screened in these drains: their repeats go to the second classifier's queue under
      // waitUntil, so the acknowledgement below never waits for that queue.
    }, concurrency + 2, undefined, waitUntilOf(ctx));
    batch.ackAll();
    await flushDueCounters(env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const { jobConcurrency, followDueJobs, core, metricsEffectiveLagMs } = await loadRuntimeDeps();
    stampLogs(env, core);
    const [{ dispatchPartitions, drainJobs }, { reconcileSharedConnections }, { syncOutboundMessages }, { publicStatsTick }] = await core.wrapModuleLoad(() => Promise.all([
      import('./dispatch.js'), import('./provider-connections.js'), import('./mailbox-send.js'), import('./public-stats.js'),
    ]));
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') {
        const [{ hourlyUpkeep }, { resolveRegionRuntime }] = await core.wrapModuleLoad(() => Promise.all([import('./maintenance.js'), import('./ses-region-state.js')]));
        // Each step is best-effort: a failing cleanup no longer skips upload reconciliation and receipt recovery.
        await hourlyUpkeep(runtime, () => resolveRegionRuntime(runtime));
      }
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      // Mailbox outbound status and Message-IDs follow the sending pipeline; best-effort.
      if (controller.cron !== '* * * * *') return;
      // Backup for a missed or interrupted facet nudge: check only the four reserved job PKs.
      afterwards(env,ctx,async background => {
        const {dueLogFacetSlots,foldLogFacetSlot}=await import('./log-facet-fold.js');
        for (const slot of await dueLogFacetSlots(background.db)) afterwards(env,ctx,separate => foldLogFacetSlot(separate,slot));
      });
      afterwards(env, ctx, async background => {
        try {
          const {maintainFacetAggregates}=await import('./log-facet-aggregate-worker.js');
          if(await maintainFacetAggregates(background.db,12_000,true)||!background.config.multiTenant)return;
          const [{ bootstrapLogFacet }, { foldLogFacetSlot }] = await Promise.all([
            import('./log-facet-bootstrap.js'), import('./log-facet-fold.js'),
          ]);
          const ticket = await bootstrapLogFacet(background);
          if (ticket) await foldLogFacetSlot(background, ticket.slot);
        } catch { core.log('warn', { code: 'LOG_FACET_BOOTSTRAP_FAILED' }); }
      });
      // Independent of PostgreSQL: even a total DB outage must not hide DLQ growth.
      // A queue added here is on the Health page at once; its "falling behind" line is in src/health-thresholds.ts (QUEUES).
      const queues: import('./health.js').QueueSample[] = [];
      const lagSamples: { lane: 'routine' | 'priority'; depth: number; oldestMessageTimestamp?: Date }[] = [];
      await Promise.all([['feedback',env.FEEDBACK_QUEUE],...(env.FEEDBACK_PRIORITY_QUEUE?[['feedback-priority',env.FEEDBACK_PRIORITY_QUEUE]]:[]),['feedback-dlq',env.FEEDBACK_DLQ],['legacy-feedback-dlq',env.LEGACY_FEEDBACK_DLQ],['work',env.WAKE_QUEUE],['webhooks',env.WEBHOOK_QUEUE]].map(async pair=>{
        const [name,q]=pair as [string,Queue]; if(!q?.metrics)return;
        try{const m=await q.metrics(),oldestMs=m.oldestMessageTimestamp?Math.max(0,Date.now()-m.oldestMessageTimestamp.getTime()):0;
          const alarm=(name.endsWith('feedback-dlq') && m.backlogCount>0) || oldestMs>60000;
          core.log(alarm?'error':'info',{code:alarm?'QUEUE_BACKLOG_ALERT':'QUEUE_BACKLOG',queue:name,depth:m.backlogCount,oldestMs});
          queues.push({name,depth:m.backlogCount,oldestMs});
          if (name === 'feedback') lagSamples.push({ lane: 'routine', depth: m.backlogCount, oldestMessageTimestamp: m.oldestMessageTimestamp });
          if (name === 'feedback-priority') lagSamples.push({ lane: 'priority', depth: m.backlogCount, oldestMessageTimestamp: m.oldestMessageTimestamp });
        }catch{core.log('warn',{code:'QUEUE_METRICS_UNAVAILABLE',queue:name});}
      }));
      try {
      if (lagSamples.length) {
        try {
          const { recordFeedbackLag, FEEDBACK_LAG_MIN_DEPTH } = await import('./sending.js');
          // Apply a depth floor on queue-level metrics(): a few poison/unmatchable messages sitting in Cloudflare retry
          // backoff carry their original enqueue timestamp but do not represent a stalled consumer backlog.
          for (const sample of lagSamples) {
            const effectiveOldestMs = metricsEffectiveLagMs(sample.depth, sample.oldestMessageTimestamp, FEEDBACK_LAG_MIN_DEPTH);
            await recordFeedbackLag(runtime.db, sample.lane, sample.depth, effectiveOldestMs);
          }
        } catch { core.log('warn', { code: 'FEEDBACK_LAG_RECORD_FAILED' }); }
      }
      try { const { drainFeedbackRecovery } = await import('./operations.js'); await drainFeedbackRecovery(runtime); }
      catch { core.log('error',{code:'FEEDBACK_RECOVERY_DRAIN_FAILED'}); }
      await reconcileSharedConnections(runtime); // Installation work must not depend on a workspace or a successful queue drain.
      // A pool region nothing has sent through yet still gets its SES quota sampled (Glass, the customer share); never throws.
      await (await core.wrapModuleLoad(() => import('./dispatcher.js'))).refreshPoolQuotas(runtime);
      // Glass's deliverability sources (SES health, VDM, Spamhaus DBL), each due at its own time; never throws.
      await (await core.wrapModuleLoad(() => import('./glass-deliverability.js'))).refreshDeliverabilitySources(runtime);
      try { await syncOutboundMessages(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
      // Screen any pre-deploy or rollout-window rows held with screened=false outside the mail room before waking shards.
      try { await (await core.wrapModuleLoad(() => import('./sending.js'))).screenHeldMail(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'HELD_SCREEN_SWEEP_FAILED' }); }
      // Received mail queued for the refilling budget comes due within minutes; the drain below runs its release.
      try { await (await core.wrapModuleLoad(() => import('./mailbox-staging.js'))).scheduleHoldRelease(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_HOLD_RELEASE_FAILED' }); }
      await Promise.allSettled((await dispatchPartitions(runtime, true)).map(({ region, accountId, kind, maxSendRate }) => wakeDispatchers(env, region, accountId, undefined, kind, false, maxSendRate)));
      } finally {
        // Health (src/health.ts), once dispatch recovery has run or failed: what is falling behind, on the Health page and as
        // Slack cards, including a database that refuses the tick's own write. Started here and awaited by nothing: it runs
        // beside the steps below on a connection of its own, so neither can delay or skip the other.
        if (runtime.config.multiTenant && runtime.config.liveEnabled)
          afterwards(env, ctx, async rt => { await (await import('./ses-quota-health.js')).sampleSesCounts(rt); });
        afterwards(env, ctx, async health => {
          const [{ healthTick }, { flushCounters }] = await Promise.all([import('./health.js'), import('./health-counters.js')]);
          await flushCounters(health.db); await healthTick(health, { queues: queues.sort((a,b)=>a.name<b.name?-1:1) });
        });
      }
      if (runtime.config.abuseMonitoring) try { await (await import('./abuse.js')).seedAbuseStages(runtime); }
      catch { core.log('warn',{code:'ABUSE_STAGE_SEED_FAILED'}); }
      // Minute cron: recover orchestration jobs whose wake was lost.
      await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000,'work'), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }),0,'work');
      if (runtime.config.abuseMonitoring) await followDueJobs(runtime, async()=>{}, delaySeconds=>env.WAKE_QUEUE.send({kind:'abuse-sample'},{delaySeconds}),0,'abuseSample');
      if (env.WEBHOOK_QUEUE) await followDueJobs(runtime, async()=>{}, delaySeconds=>env.WEBHOOK_QUEUE.send({kind:'wake'},{delaySeconds}),0,'webhooks');
      // Fold sending_campaign_tallies and sending_metrics_hourly delta rows in bounded chunks every minute.
      try { await (await core.wrapModuleLoad(() => import('./sending-tallies.js'))).foldSendingTallies(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'SENDING_TALLIES_FOLD_FAILED' }); }
      // The raw-event audit is independent of dispatch, folding, and the hourly whole-workspace tally repairs.
      afterwards(env, ctx, async rt => { await (await import('./sending-tallies.js')).auditSendingOutcomePage(rt); });
      // Last, after recovery: GET /v1/public/stats serves only what this writes. Best-effort and time-bounded.
      await publicStatsTick(runtime);
      // Sender standing: every ten minutes (elected), the score, limit and ladder of each Hosted workspace.
      if (runtime.config.multiTenant) await (await core.wrapModuleLoad(() => import('./standing.js'))).standingTick(runtime);
      // All installation modes need the scanner. Schedule independently of dispatch and ordinary queue recovery.
      afterwards(env, ctx, async score => {
        try { await (await import('./sender-display-score.js')).ensureSenderDisplayDiscovery(score.db); }
        catch { core.log('warn', { code: 'DISPLAY_SCORE_DISCOVERY_FAILED' }); }
      });
      // The sign-ups list: a sync run while any waitlist row or sign-up is due (src/signups.ts). It never throws.
      if (runtime.config.multiTenant) await (await core.wrapModuleLoad(() => import('./signups.js'))).signupsTick(runtime);
      // Billing: the auto-recharge sweep and Stripe reconciliation (elected every 5 minutes).
      if (runtime.config.multiTenant) try { await (await core.wrapModuleLoad(() => import('./billing/stripe-jobs.js'))).billingMinute(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'BILLING_MINUTE_FAILED' }); }
      // New domains whose records are still missing an hour on: a DNS check each (elected every 5 minutes, src/domain-setup.ts).
      if (runtime.config.multiTenant) try { await (await core.wrapModuleLoad(() => import('./domain-setup.js'))).domainSetupTick(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'DOMAIN_SETUP_TICK_FAILED' }); }
      // Last, as it can take minutes: retention of the sent-side tables (elected every 15 minutes).
      try { await (await core.wrapModuleLoad(() => import('./maintenance.js'))).retentionTick(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'RETENTION_TICK_FAILED' }); }
    }, concurrency + 2, undefined, waitUntilOf(ctx)); // The minute cron drains jobs too: as in queue(), nothing waits for the second classifier's queue.
  },
} satisfies ExportedHandler<Env>;
