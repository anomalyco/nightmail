import { sql } from 'drizzle-orm';
import type { SESv2Client, SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { ModuleLoadError, ApiError, logError, databaseCodeOf } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import type { Runtime, Actor, DbExecutor } from '../core/types.js';
import type { EmailSnapshot, EmailStatus } from '../db/sending.js';
import { QUOTA_REFRESH_MS } from './schemas.js';
import { formattedSender, attachmentReads, storageUnavailable } from './mime.js';
import { LINK_RECORD_RECHECK_MS } from '../campaigns/run.js';
import { wakeWebhooks } from '../jobs.js';
import { outbound } from '../screen-calls.js';
import { SEND_LIMITS } from '../send-limits.js';
import { SesBodyError } from '../ses-body.js';
import { withMemory, sendReservation } from '../isolate-memory.js';
import { type GateState, type Prepared, type Outcome, jittered, THROTTLE_MS, THROTTLE_MAX_MS, type Pacing, type Mail, type Trace, txReadyAt, mktReadyAt, reserve, brake, OUTAGE_MAX_MS, OUTAGE_MS, type Leased, type Owner, observeQuota, ensureQuota, QUOTA_STALE_MS, QUOTA_RETRY_MS, dailyRemaining, STORAGE_MS, STORAGE_MAX_MS, requeued, CLAIM_BUSY_MS, MAX_PRE_SEND_MS, shardRate, marketingShardRate, loadDispatchTransport, initialGate } from './quota.js';
import { redactDenial, type DeferredStream, type CampaignRef, batchAttachments, prepareMail, HeldForScreen, rejectPreflight, recordOutcomes, interleaveByOwner, claimGroup, originDecisions, deferBurst, finishSettledCampaigns, type Allowance, MAX_ENVELOPE, leaseDue } from './claim.js';

// The dispatcher is a long-lived loop, hosted by a Durable Object on Cloudflare and by the
// runner process on Node. PostgreSQL remains the only source of truth: a row is sent at most
// once because the batched claim flips it queued → attempting under its dispatch_version.
// Provider pacing lives in process memory (one shard owns one share of the regional quota),
// so the hot path costs three database statements per batch rather than ten per email.

export interface DispatcherOptions {
  region: string; accountId?: string;
  /** Emails claimed per database round trip. */
  batchSize?: number;
  /** Provider requests in flight per loop; Workers allow six connections awaiting headers. */
  sendConcurrency?: number;
  /** Clock for flushing a partially returned SES claim. A complete claim never waits on a timer. */
  schedulePartialFlush?: (flush: () => void) => () => void;
  /** Independent claim→send→record pipelines sharing the gate; keeps the provider busy while a batch is being recorded. */
  lanes?: number;
  /** This shard's share of the regional quota: 1/count. */
  shard?: { index: number; count: number };
  gate?: GateState;
  /** Best-effort admission hints. Leases remain the durable source of truth. */
  priorityWake?: EventTarget;
  onGate?: (state: GateState) => void | Promise<void>;
  /** Stop claiming new batches after this epoch millisecond; in-flight batches always finish. */
  until?: number;
  /** Refresh quota from the provider at most this often. */
  quotaRefreshMs?: number;
  /** For the DISPATCH_RUN line: how long after the wake that started it this run began (src/dispatcher-do.ts). */
  wakeMs?: number;
  /** Once true, the run leases nothing more and ends after the batches it holds (src/dispatcher-do.ts: a request landed on
   *  the shard, so its classifier calls go to a follow-up run). */
  stop?: () => boolean;
}
export interface DispatcherReport { claimed: number; sent: number; deferred: number; skipped: number; batches: number; idle: boolean; durationMs: number; timings: Record<string, number>; statements: number; quotaRetryAt?: number; paceRetryAt?: number }

async function sendOne(runtime: Runtime, a: Actor, ses: SESv2Client, item: Prepared): Promise<Outcome> {
  const s = item.snapshot, mail = item.mail;
  const expires=mail.errorCode==='SES_ACCOUNT_SENDING_PAUSED' && mail.accountPauseStartedAt ? Date.parse(mail.accountPauseStartedAt)+86400000 : Infinity;
  const expired=(providerCalled:boolean):Outcome=>({mail,type:'reject',errorCode:'SES_ACCOUNT_PAUSE_EXPIRED',data:{code:'SES_ACCOUNT_PAUSE_EXPIRED',providerCalled,retryable:false}});
  if (Date.now()>=expires) return expired(false);
  const request: SendEmailCommandInput = { FromEmailAddress: formattedSender(s.from, s.fromName), Destination: { ToAddresses: s.to, CcAddresses: s.cc, BccAddresses: s.bcc }, ReplyToAddresses: s.replyTo,
    ConfigurationSetName: runtime.config.configurationSets[s.kind], EmailTags: [{ Name: 'bane_email_id', Value: mail.id }, { Name: 'bane_workspace_id', Value: a.workspaceId }, { Name: 'bane_priority', Value: s.kind }],
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED', ClickTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED' } },
    ...(item.owner.tenantName ? { TenantName: item.owner.tenantName } : {}), Content: item.content,
  };
  const command = new item.owner.transport.SendEmailCommand(request);
  const client = item.owner.sendClient?.((item.review?.draft.binding ?? mail.snapshot.binding)?.domain ?? '') ?? ses;
  try {
    const result = await client.send(command);
    if (!result.MessageId) return { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_MESSAGE_ID_MISSING' } };
    return { mail, type: 'accepted', providerId: result.MessageId, data: {} };
  } catch (error) {
    if (error instanceof ModuleLoadError) throw error;
    // The request body could not be written: thrown before the request handler, so SES never saw this message.
    if (error instanceof SesBodyError) return { mail, type: 'reject', errorCode: 'SES_REQUEST_UNBUILT', data: { code: 'SES_REQUEST_UNBUILT', providerCalled: false, retryable: false } };
    const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    const status = failure.$metadata?.httpStatusCode;
    const { denial, diagnostics } = redactDenial(runtime, failure);
    // The log keeps the denied action and AWS request ID; the resource and AWS's message stay in the email's own event.
    if (denial) log('error', { code: 'SES_ACCESS_DENIED', emailId: mail.id, region: s.region, deniedAction: diagnostics.deniedAction, awsRequestId: diagnostics.awsRequestId });
    const providerRetries = item.rateRetries;
    const definitive = status !== undefined && status >= 400 && status < 500;
    // Only a definitive provider refusal proves non-acceptance. A transport error,
    // 5xx or missing message ID remains ambiguous and must not be auto-replayed.
    if (definitive && (['InvalidClientTokenId','SignatureDoesNotMatch','UnrecognizedClientException','ExpiredToken','ExpiredTokenException'].includes(failure.name ?? '') ||
      (status === 403 && /security token included in the request is (?:invalid|expired)|request signature we calculated does not match|access key id you provided does not exist/i.test(failure.message ?? '')))) {
      const backoff = Math.min(300_000, 5000 * 2 ** Math.min(6,mail.dispatchVersion));
      return {mail,type:'provider_throttled',errorCode:'SES_CREDENTIALS_INVALID',data:{code:'SES_CREDENTIALS_INVALID',retryable:true},requeueAt:new Date(Date.now()+backoff).toISOString()};
    }
    const pause = /\b(?:paused|disabled|suspended)\b/i;
    if (definitive && item.owner.tenantName && /\btenant\b/i.test(failure.message ?? '') && (failure.name === 'SendingPausedException' || pause.test(failure.message ?? ''))) {
      return { mail, type: 'reject', errorCode: 'SES_TENANT_SENDING_PAUSED', data: { code: 'SES_TENANT_SENDING_PAUSED', retryable: false } };
    }
    if (definitive && (failure.name==='SendingPausedException' || failure.name==='AccountSuspendedException' ||
      (/\baccount\b/i.test(failure.message??'') && /\bsend(?:ing)?\b/i.test(failure.message??'') && pause.test(failure.message??'')))) {
      if (Date.now()>=expires) return expired(true);
      return {mail,type:'provider_throttled',errorCode:'SES_ACCOUNT_SENDING_PAUSED',data:{code:'SES_ACCOUNT_SENDING_PAUSED',retryable:true},requeueAt:new Date(Math.min(expires,Date.now()+300000)).toISOString()};
    }
    // SES distinguishes its rolling daily ceiling from ordinary per-second throttling by message.
    // Daily exhaustion is not a failed delivery and must never burn the five rate-retry attempts.
    if ((status === 429 || status === 400) && /daily (?:message |sending )?quota exceeded/i.test(failure.message ?? '')) {
      return { mail, type: 'provider_throttled', errorCode: 'SES_DAILY_QUOTA_EXHAUSTED', data: { code: 'SES_DAILY_QUOTA_EXHAUSTED', retryable: true } };
    }
    // Per-second throttling: every 429, and a 400 SES names as throttling ("Maximum sending rate exceeded"). The account
    // is busy, not refusing this message, so it waits longer each time and is never rejected for it.
    // Whole words only: a refusal that names an address like throttle@example.com is a refusal.
    if (status === 429 || (status === 400 && (/^(?:Throttl|TooManyRequests|RequestThrottled)/i.test(failure.name ?? '') || /maximum sending rate exceeded|\brate exceeded\b|\bthrottl(?:ed|ing)\b/i.test(failure.message ?? '')))) {
      const wait = jittered(THROTTLE_MS * 2 ** Math.min(providerRetries, 10), THROTTLE_MAX_MS);
      return { mail, type: 'provider_throttled', errorCode: 'SES_THROTTLED', data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 }, requeueAt: new Date(Date.now() + wait).toISOString() };
    }
    return definitive
      ? { mail, type: 'reject', errorCode: failure.name ?? 'SES_REJECTED', data: { code: failure.name ?? 'SES_REJECTED', retryable: false, ...diagnostics } }
      : { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_ACCEPTANCE_UNKNOWN', retryable: false, ...diagnostics } };
  }
}

// `finishing` collects campaigns whose rows this run moved out of the queue; they are checked for completion in one
// statement once the queue is draining (a short batch, the time budget or the end of the run), never per group.
type Lane = { attachmentBytes:number; advanced: number; bytesReleased?:Promise<void>; notifyBytes?:()=>void; deferred: DeferredStream[]; gate: GateState; refresh?: Promise<boolean>; held: { recipients: number }; pacing: Pacing; shadowOn: boolean; options: Required<Pick<DispatcherOptions, 'batchSize' | 'sendConcurrency' | 'quotaRefreshMs'>> & DispatcherOptions; finishing: Map<string, CampaignRef>; send: (item: Prepared, deadline: number) => Promise<Outcome>; record: (outcomes: Outcome[]) => Promise<void>; counters: DispatcherReport; phase: <T>(name: string, work: () => Promise<T>) => Promise<T> };
function chunk<T>(items: T[], size: number): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }
const cost = (item: Prepared) => item.snapshot.to.length + item.snapshot.cc.length + item.snapshot.bcc.length;
const quotaRetry = (gate: GateState, refreshMs: number) => Math.ceil(Math.max(Date.now() + Math.min(1000, refreshMs), gate.refreshAt ?? 0, gate.dailyBlockedUntil ?? 0));

// One DISPATCH_EMAIL line per email a run sends or defers: how long it waited in the queue before this lease (queueMs, from
// when it was due; ageMs from admission), in the screen, for a send slot and in the SES call, how long the run held it
// (totalMs), and why it was deferred (reason). IDs, codes and milliseconds only. Flow control (a send, a pacing wait, the
// daily allowance, the burst limit) is info; anything else is warn. A campaign's flow-control lines are kept 1 in 10, since a
// campaign can send 50 a second and an invocation keeps 256 KB of log lines; each kept one says sampleRate. Failures and
// every other deferral are always kept.
const FLOW = new Set(['PACING_WAIT', 'DAILY_ALLOWANCE', 'HOSTED_BURST_LIMIT']);
function logEmail(lane: Lane, mail: Mail, trace: Trace | undefined, outcome: string, reason?: string) {
  try {
    const routine = outcome === 'accepted' || FLOW.has(reason ?? ''), rate = routine && mail.snapshot.kind === 'marketing' ? 0.1 : 1;
    if (rate < 1 && Math.random() >= rate) return;
    const now = Date.now(), leasedAt = trace?.leasedAt ?? now, created = Date.parse(mail.createdAt), due = mail.scheduledAt ? Math.max(created, Date.parse(mail.scheduledAt)) : created;
    log(routine ? 'info' : 'warn', { code: 'DISPATCH_EMAIL', outcome, reason, emailId: mail.id, workspaceId: mail.workspaceId, campaignId: mail.campaignId ?? undefined,
      region: lane.options.region, shard: lane.options.shard?.index ?? 0, kind: mail.snapshot.kind, attempt: mail.dispatchVersion, queueMs: leasedAt - due, ageMs: leasedAt - created,
      ...(lane.shadowOn && mail.snapshot.screenVerdict?.digest ? { screenDigest: mail.snapshot.screenVerdict.digest.slice(0, 32) } : {}),
      paceMs: trace?.paceMs, sesMs: trace?.sesMs, totalMs: now - leasedAt, ...(rate < 1 ? { sampleRate: rate } : {}) });
  } catch { /* A record never changes what happens to the email. */ }
}

// There is only one slot timer and one in-flight limit for every stream and lane. Choose who owns
// the slot when it opens, not when an earlier batch was claimed. In-flight calls are never canceled.
function pacedSender(gate: GateState, options: DispatcherOptions, pacing: Pacing, counters: DispatcherReport, held: Lane['held']) {
  type Waiting = { deadline: number; start(): void; defer(): void };
  const queues: Record<EmailSnapshot['kind'], Waiting[]> = { transactional: [], marketing: [] };
  let active = 0, timer: ReturnType<typeof setTimeout> | undefined;
  function pump() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const now = Date.now(); let earliest = Infinity;
    // Transactional mail never waits behind marketing's clock or marketing's brake, and always dequeues first.
    // When transactional was active recently, marketing leaves one in-flight slot free; otherwise it uses all slots.
    const txAt = txReadyAt(gate, now);
    const mktAt = mktReadyAt(gate);
    for (const queue of [queues.transactional, queues.marketing]) for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i]!;
      if (gate.dailyBlockedUntil || entry.deadline <= Math.max(now, queue === queues.transactional ? txAt : mktAt)) { queue.splice(i, 1); entry.defer(); }
      else earliest = Math.min(earliest, entry.deadline);
    }
    if (earliest === Infinity) return;
    // After SES stopped answering, probe with one call until it accepts again.
    const maxConc = gate.outageStreak ? 1 : options.sendConcurrency ?? 6;
    const txRecent = (gate.recentTxUntil ?? 0) > now;
    const mktConc = txRecent && maxConc > 1 ? maxConc - 1 : maxConc;
    let wakeAt = earliest;
    if (queues.transactional.length) {
      if (active < maxConc) wakeAt = Math.min(earliest, txAt);
    } else if (queues.marketing.length) {
      if (active < mktConc) wakeAt = Math.min(earliest, mktAt);
      else if (active < maxConc && txRecent) wakeAt = Math.min(earliest, gate.recentTxUntil!);
    }
    if (wakeAt > now) { timer = setTimeout(pump, Math.ceil(wakeAt - now)); return; }
    if (queues.transactional.length && active < maxConc && txAt <= now) { queues.transactional.shift()!.start(); pump(); return; }
    if (!queues.transactional.length && queues.marketing.length && active < mktConc && mktAt <= now) { queues.marketing.shift()!.start(); pump(); }
  }
  return (item: Prepared, deadline: number) => new Promise<Outcome>((resolve, reject) => {
    const queuedAt = Date.now(), s = item.snapshot;
    queues[s.kind].push({ deadline, defer() {
      held.recipients -= cost(item);
      item.trace.paceMs = Date.now() - queuedAt;
      const accountUntil=(gate.accountPauseAt??0)+300000,outage=(gate.outageUntil??0)>Date.now();
      const until=accountUntil>Date.now()?accountUntil:outage?gate.outageUntil:gate.dailyBlockedUntil;
      const code=accountUntil>Date.now()?'SES_ACCOUNT_SENDING_PAUSED':outage?'SES_UNAVAILABLE':gate.dailyBlockedUntil?'SES_DAILY_QUOTA_EXHAUSTED':undefined;
      if (!until) counters.idle = false; // Work is still due, possibly on a different shard.
      resolve({ mail: item.mail, type: 'dispatch_deferred', errorCode:code, data:{code:code??'PACING_WAIT',providerCalled:false}, requeueAt:new Date(until??Date.now()).toISOString(), trace: item.trace });
    }, start() {
      held.recipients -= cost(item);
      active++;
      counters.timings.pace = (counters.timings.pace ?? 0) + Date.now() - queuedAt;
      reserve(gate, cost(item), options.shard, pacing, s.kind);
      const sendAt = Date.now();
      item.trace.paceMs = sendAt - queuedAt; outbound.ses++;
      sendOne(item.owner.runtime, item.owner.a, item.owner.ses, item).then(outcome => {
        item.trace.sesMs = Date.now() - sendAt;
        outcome.trace = item.trace;
        if (outcome.type === 'provider_throttled' && outcome.errorCode !== 'SES_DAILY_QUOTA_EXHAUSTED') brake(gate, s.kind);
        if (outcome.type === 'accepted') delete gate.outageStreak;
        // Every ambiguous answer (no response, 5xx, or success without a MessageId) opens it; the specific code stays in the
        // event data. Calls already in flight when SES went quiet share one window; only a failed probe doubles the next.
        if (outcome.type === 'acceptance_unknown' && (gate.outageUntil ?? 0) <= Date.now()) {
          gate.outageUntil = Date.now() + Math.min(OUTAGE_MAX_MS, OUTAGE_MS * 2 ** (gate.outageStreak ?? 0));
          gate.outageStreak = (gate.outageStreak ?? 0) + 1;
          gate.brakeUntil = gate.nextAllowedAt = Math.max(gate.nextAllowedAt, gate.outageUntil);
          counters.paceRetryAt = gate.nextAllowedAt;
        }
        if (outcome.errorCode==='SES_ACCOUNT_SENDING_PAUSED' || (outcome.errorCode==='SES_ACCOUNT_PAUSE_EXPIRED' && outcome.data.providerCalled)) {
          gate.accountPauseAt=Date.now();gate.brakeUntil=gate.nextAllowedAt=Math.max(gate.nextAllowedAt,gate.accountPauseAt+300000);
          counters.paceRetryAt=gate.nextAllowedAt;
        } else if (outcome.data.providerCalled!==false) delete gate.accountPauseAt;
        if (outcome.errorCode === 'SES_DAILY_QUOTA_EXHAUSTED') {
          const period = Math.max(options.accountId ? 1000 : 0, options.quotaRefreshMs ?? QUOTA_REFRESH_MS);
          gate.refreshAt = gate.dailyBlockedUntil = Math.ceil(Math.max(Date.now() + period, gate.refreshAt ?? 0, gate.dailyBlockedUntil ?? 0));
          outcome.requeueAt = new Date(gate.dailyBlockedUntil).toISOString(); counters.quotaRetryAt = gate.dailyBlockedUntil;
        }
        resolve(outcome);
      }, reject).finally(() => { active--; outbound.ses--; pump(); });
    } });
    pump();
  });
}

// Quota exhausted for the day: give the leases back untouched and stop this run.
// The status comes with each input row, not as a literal, to keep this on the primary key (see the claim in claimCtes).
async function releaseLeases(runtime: Runtime, mails: Mail[], until?: number) {
  await runtime.db.execute(sql`UPDATE sending_emails e SET lease_until = clock_timestamp() + ${until ? Math.max(0, until - Date.now()) : null}::float8 * interval '1 millisecond' FROM jsonb_to_recordset(${JSON.stringify(mails.map(m => ({ workspace_id: m.workspaceId, id: m.id, version: m.dispatchVersion, status: 'queued' })))}::jsonb) x(workspace_id text, id text, version int, status text)
    WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.dispatch_version = x.version AND e.status = x.status`);
}

// One batch: lease up to batchSize rows and prepare them (CPU), then for each group of sendConcurrency
// rows: one claim statement, paced provider calls, one record statement. Recording overlaps the next
// group's claim and sends; failures surface at the end of the batch.
async function dispatchBatch(base: Runtime, lane: Lane, leased: Leased[]): Promise<{ processed: number; blocked: boolean }> {
  const { gate, options, counters, phase } = lane;
  if (!leased.length) return { processed: 0, blocked: false };

  const ready = leased.filter((item): item is Leased & { owner: Owner } => item.owner !== null);
  for (const item of leased) { item.trace.shard = options.shard?.index ?? 0; if (!item.owner) logEmail(lane, item.mail, item.trace, 'deferred', 'SES_SETUP_REQUIRED'); }
  counters.claimed += leased.length;
  counters.deferred += leased.length - ready.length;
  // Only unready owner/stream pairs keep their leases as backoff. The gate still paces the region.
  if (!ready.length) return { processed: leased.length, blocked: false };
  const first = ready[0]!.owner;
  // An absolute rate override is an operator setting for their account, not a BYO customer's quota.
  if (options.accountId && !first.tenantName) lane.pacing.targetRate = undefined;
  // Read the shared sample the first lease returned, or refresh it before claiming. Its age is measured on
  // Postgres, not by subtracting unrelated clocks. Never give a shard fresh capacity for the same sample.
  if (!gate.quota || Date.now() >= (gate.refreshAt ?? 0)) {
    const q = ready[0]!.quota, period = options.accountId ? Math.max(1000, options.quotaRefreshMs) : options.quotaRefreshMs;
    if (q && q.age_ms < period) observeQuota(gate, { maxSendRate:q.rate, max24HourSend:options.accountId ? q.max : q.max || -1, sentLast24Hours:q.sent, customerSent:Number(q.customer ?? 0), checkedAt:Date.parse(q.checked) }, period, q.age_ms);
    if (!gate.quota || Date.now() >= (gate.refreshAt ?? 0)) {
      // Lanes of one shard share one refresh; shards share one GetAccount through ensureQuota's election.
      lane.refresh ??= phase('quota', () => ensureQuota(first, options.accountId, options.region, gate, options.quotaRefreshMs)).finally(() => { lane.refresh = undefined; });
      // A refresh that fails (GetAccount throttled or down, or a sibling's refresh that never published) keeps pacing on
      // the previous sample while it is recent, and tries again in QUOTA_RETRY_MS. A provider refusal (an ApiError: SES
      // sending disabled) and a cold shard with no recent sample still stop; the run always says when to try again.
      const recent = !!gate.quota && Date.now() - gate.quota.checkedAt < QUOTA_STALE_MS;
      let failure: { error: unknown } | undefined;
      const refreshed = await lane.refresh.catch(error => {
        if (!recent || error instanceof ApiError || error instanceof ModuleLoadError) failure = { error };
        else logError(error, { code: 'SES_QUOTA_REFRESH_FAILED', accountId: options.accountId, region: options.region }, 'warn');
        return false;
      });
      if (!refreshed) {
        if (!failure && recent) gate.refreshAt = Date.now() + QUOTA_RETRY_MS;
        else {
          for (const item of ready) logEmail(lane, item.mail, item.trace, 'deferred', 'SES_QUOTA_UNKNOWN');
          await releaseLeases(base, ready.map(item => item.mail));
          if (failure) throw failure.error;
          counters.quotaRetryAt = Math.min(counters.quotaRetryAt ?? Infinity, Date.now() + QUOTA_RETRY_MS);
          return { processed: 0, blocked: true };
        }
      }
      await options.onGate?.(gate);
    }
  }
  const result = await dispatchReady(base,lane,ready);
  return { processed: result.blocked ? 0 : leased.length, blocked: result.blocked };
}

async function dispatchReady(base: Runtime, lane: Lane, ready: (Leased & { owner: Owner })[]) {
  const {gate, options, counters, phase} = lane;
  if (dailyRemaining(gate) <= 0) {
    counters.quotaRetryAt = quotaRetry(gate, options.quotaRefreshMs);
    for (const item of ready) logEmail(lane, item.mail, item.trace, 'deferred', 'SES_DAILY_QUOTA_EXHAUSTED');
    await releaseLeases(base, ready.map(item => item.mail));
    counters.claimed -= ready.length;
    counters.deferred += ready.length;
    log('warn', { code: 'SES_DAILY_QUOTA_EXHAUSTED', region: options.region });
    return { processed: 0, blocked: true };
  }
  const loadAttachments = batchAttachments(base, ready), readsBefore = attachmentReads();
  const unscreened: Mail[] = [], linkWaiting: Mail[] = [], storageWaiting: Mail[] = [];
  const prepare = async (item: typeof ready[number]) => {
    try {
      // While storage is down, attachment mail waits without asking it again.
      if ((gate.storageUntil ?? 0) > Date.now() && item.mail.snapshot.attachments.length) throw storageUnavailable();
      if (item.contentBytes) {
        // Read only after reserving the page. Do not attach the body to the lease:
        // that array outlives this send, even when its byte reservation is released.
        const m=item.mail;
        const {rows:[body]}=await base.db.execute<{text:string|null;html:string|null;raw:string|null;mime:string|null;template:EmailSnapshot['template']|null}>(sql`
          SELECT snapshot->>'text' AS text,snapshot->>'html' AS html,snapshot->>'raw' AS raw,snapshot->>'mime' AS mime,snapshot->'template' AS template
          FROM sending_emails WHERE workspace_id=${m.workspaceId} AND id=${m.id} AND dispatch_version=${m.dispatchVersion} AND status='queued'`);
        if (!body) { counters.skipped++;return; }
        const snapshot={...m.snapshot,text:body.text??undefined,html:body.html??undefined,raw:body.raw??undefined,mime:body.mime??undefined,template:body.template??undefined};
        return await prepareMail({...item,mail:{...m,snapshot}}, loadAttachments);
      }
      return await prepareMail(item, loadAttachments);
    }
    catch (error) {
      if (error instanceof ModuleLoadError) { await releaseLeases(base, [item.mail]); throw error; }
      if (error instanceof HeldForScreen) { unscreened.push(item.mail); counters.deferred++; lane.advanced++; logEmail(lane, item.mail, item.trace, 'deferred', 'SCREEN_REQUIRED'); return; }
      // A campaign launched before link hosts whose sending domain has none active yet (src/link-domains.ts): the email
      // stays queued, as its campaign waits, and is tried again in 15 minutes instead of failing.
      if (error instanceof ApiError && error.code === 'LINK_RECORD_REQUIRED') { linkWaiting.push(item.mail); counters.deferred++; lane.advanced++; logEmail(lane, item.mail, item.trace, 'deferred', 'LINK_RECORD_REQUIRED'); return; }
      // Object storage is down (src/adapters/storage.ts): the email waits out the shard's storage backoff below.
      if (error instanceof ApiError && error.code === 'STORAGE_TEMPORARILY_UNAVAILABLE') { storageWaiting.push(item.mail); counters.deferred++; lane.advanced++; logEmail(lane, item.mail, item.trace, 'deferred', error.code); return; }
      counters.skipped++; lane.advanced++;
      logEmail(lane, item.mail, item.trace, await rejectPreflight(item.owner.runtime, item.mail, error), error instanceof ApiError ? error.code : 'DISPATCH_PREFLIGHT_FAILED');
    }
  };
  const streamPage=async(items:typeof ready,coalesce=false)=>{
    const available:Prepared[]=[]; let notify:(()=>void)|undefined,finished=false,next=0;
    const workers=Promise.allSettled(Array.from({length:Math.min(items.length,options.sendConcurrency)},async()=>{
      while(next<items.length){ const p=await prepare(items[next++]!); if(p){available.push(p);notify?.();} }
    })).then(results=>{finished=true;notify?.();return results;});
    try {
      while(!finished || available.length){
        if(available.length){
          // Give fast sibling object reads a short collection window. A slow
          // object never holds the page, and ordinary campaign pages share the
          // claim and result writer instead of issuing one claim per object.
          if(coalesce && !finished) await Promise.race([workers,new Promise(resolve=>setTimeout(resolve,10))]);
          await dispatchPrepared(base,lane,available.splice(0));
        }
        else await new Promise<void>(resolve=>{notify=resolve;});
      }
    } finally {for(const r of await workers) if(r.status==='rejected') throw r.reason;}
  };
  if(ready.some(item=>item.contentBytes || item.mail.snapshot.attachments.length)) {
    // Reserve bytes, not a whole lane. Small pages overlap and share the result
    // writer; disjoint large bodies still cannot accumulate across sibling lanes.
    const limit=SEND_LIMITS.laneBytes;let page:typeof ready=[],bytes=0,files=0,content=0;
    const flush=async()=>{
      while(lane.attachmentBytes+bytes>limit) await (lane.bytesReleased??=new Promise(resolve=>{lane.notifyBytes=resolve;}));
      lane.attachmentBytes+=bytes;
      // The page's files and bodies, and every buffer built from them, count against the isolate's budget, which every
      // lane, dispatcher and HTTP request in the isolate shares (isolate-memory.ts). A message above the lane budget
      // fills its page alone.
      try { await withMemory(sendReservation(files,content),async()=>{
        // A single immutable review shares all object reads. With no external
        // classifier, prepare one full claim at a time; CPU speed is not a
        // reason to split it. Unrelated objects/probes still stream below.
        const review=page[0]!.mail.reviewId;
        if (review && page.every(({mail,owner}) => mail.reviewId===review && (isSimulatedSes(owner.runtime) || !owner.tenantName || !owner.runtime.config.hostedScreen))) {
          const prepared:Prepared[]=[];
          for (const group of chunk(page,options.sendConcurrency)) {
            for(const p of await Promise.all(group.map(prepare))) if(p) prepared.push(p);
          }
          await dispatchPrepared(base,lane,prepared);
        } else await streamPage(page,true);
      });}finally{lane.attachmentBytes-=bytes;lane.bytesReleased=undefined;lane.notifyBytes?.();lane.notifyBytes=undefined;}
      page=[];bytes=0;files=0;content=0;
    };
    for(const item of ready){
      // Invalid oversize metadata is rejected in prepare before reading the object.
      const attached=(await loadAttachments(item.mail)).reduce((s,r)=>s+r.size,0),n=Math.min(limit,attached+item.contentBytes);
      if(page.length && bytes+n>limit)await flush();page.push(item);bytes+=n;files+=attached;content+=item.contentBytes;
    }
    if(page.length)await flush();
  } else {
    const prepared = await phase('prepare', () => Promise.all(ready.map(prepare)));
    await dispatchPrepared(base, lane, prepared.filter((item): item is Prepared => item !== undefined));
  }
  if (unscreened.length) await base.db.execute(sql`UPDATE sending_emails e SET screened = false, lease_until = NULL
    FROM jsonb_to_recordset(${JSON.stringify(unscreened.map(m => ({ workspace_id: m.workspaceId, id: m.id, version: m.dispatchVersion, status: 'queued' })))}::jsonb) x(workspace_id text, id text, version int, status text)
    WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.dispatch_version = x.version AND e.status = x.status`);
  if (linkWaiting.length) await releaseLeases(base, linkWaiting, Date.now() + LINK_RECORD_RECHECK_MS);
  // One window for the shard while storage stays down, doubling each time it opens again, and the run wakes when it
  // ends. Only a batch that read storage itself closes it: one whose attachment mail all waited or came from the cache
  // proves nothing. The waiting rows keep their leases until it ends: one statement, no per-row retry.
  if (storageWaiting.length) {
    let until = gate.storageUntil ?? 0;
    if (until <= Date.now()) {
      gate.storageUntil = until = Date.now() + jittered(STORAGE_MS * 2 ** Math.min(gate.storageStreak ?? 0, 10), STORAGE_MAX_MS);
      gate.storageStreak = (gate.storageStreak ?? 0) + 1;
    }
    log('warn', { code: 'STORAGE_TEMPORARILY_UNAVAILABLE', region: options.region, count: storageWaiting.length, retryInMs: until - Date.now() });
    counters.paceRetryAt = Math.min(counters.paceRetryAt ?? Infinity, until);
    await releaseLeases(base, storageWaiting, until);
  } else if (attachmentReads() > readsBefore) { delete gate.storageUntil; delete gate.storageStreak; }
  return { processed: ready.length, blocked: false };
}
const logLost = (count:number) => log('warn', { code:'DISPATCH_CLAIM_LOST', count, message:'Rows changed between lease and claim; they will be reconsidered on the next pass.' });
async function recordBatch(base: Runtime,lane: Lane,outcomes: Outcome[]) {
  await lane.phase('record', () => recordOutcomes(base,outcomes));
  for (const outcome of outcomes) {
    logEmail(lane, outcome.mail, outcome.trace, outcome.type === 'dispatch_deferred' ? 'deferred' : outcome.type, outcome.errorCode ?? (typeof outcome.data.code === 'string' ? outcome.data.code : undefined));
    if(outcome.type==='acceptance_unknown' || outcome.type==='provider_throttled' || outcome.errorCode==='SES_TENANT_SENDING_PAUSED') log(outcome.type==='acceptance_unknown' || outcome.errorCode==='SES_ACCOUNT_SENDING_PAUSED' || outcome.errorCode==='SES_CREDENTIALS_INVALID' ? 'error' : 'warn',{code:outcome.errorCode,region:outcome.mail.region,stream:outcome.mail.snapshot.kind});
    if (outcome.type === 'accepted') lane.counters.sent++; else if (requeued(outcome)) lane.counters.deferred++; else lane.counters.skipped++;
    if (outcome.mail.campaignId && !requeued(outcome)) lane.finishing.set(outcome.mail.campaignId, { workspace_id: outcome.mail.workspaceId, campaign_id: outcome.mail.campaignId });
  }
}
// One writer per run. Concurrent lanes can share the next statement without
// fanning out DB connections. The caller decides when a claim is ready to write.
function outcomeRecorder(write: (ready: Outcome[]) => Promise<void>) {
  const ready: Outcome[] = [];
  let writing: Promise<void> | undefined;
  async function flush() {
    let failure: { reason: unknown } | undefined;
    try {
      while (ready.length) {
        try { await write(ready.splice(0)); } catch (reason) { failure ??= { reason }; }
      }
      if (failure) throw failure.reason;
    }
    finally { writing = undefined; }
  }
  return (outcomes: Outcome[]) => { ready.push(...outcomes); return writing ??= flush(); };
}
function schedulePartialFlush(flush: () => void) {
  const timer = setTimeout(flush, 300);
  return () => clearTimeout(timer);
}
async function dispatchPrepared(base: Runtime, lane: Lane, prepared: Prepared[]) {
  if (!prepared.length) return;
  const {gate, options, counters, phase} = lane;
  const pendingRecords: Promise<void>[] = [];
  const delayed: Mail[] = [], unpaced: Mail[] = [], busy: Mail[] = [];
  // When mail a busy claim gave back is due again, and the run's wake with it: the run ends idle, not polling for it.
  let busyUntil: number | undefined;
  const busyWake = () => { busyUntil ??= Date.now() + CLAIM_BUSY_MS; counters.paceRetryAt = Math.min(counters.paceRetryAt ?? Infinity, busyUntil); };
  const ordered = interleaveByOwner(prepared, item => item.snapshot.kind, item => item.mail.workspaceId, counters.batches + (options.shard?.index ?? 0));
  for (const candidates of chunk(ordered, options.sendConcurrency)) {
    if (options.stop?.()) { for (const item of candidates) { unpaced.push(item.mail); counters.claimed--; counters.deferred++; } continue; }
    // Hold daily capacity synchronously across lanes before the durable attempt. A canceled/lost
    // claim returns it; a provider start moves it from held to sent. Rate slots are never held here.
    const now = Date.now(), claimDeadline = now + MAX_PRE_SEND_MS;
    const txRate = shardRate(gate, options.shard, lane.pacing), mktRate = marketingShardRate(gate, options.shard, lane.pacing);
    let expectedTxSlot = Math.max(gate.txAllowedAt ?? 0, (gate.brakeUntil ?? 0) > now ? gate.nextAllowedAt : 0, now);
    let expectedMktSlot = Math.max(gate.nextAllowedAt, gate.marketingAllowedAt ?? 0, now);
    const group = candidates.filter(item => {
      // Don't enter attempting in the first place for a predictably distant slot. The actual
      // sender also enforces this deadline if priority arrivals or a concurrent lane change it.
      const isTx = item.snapshot.kind === 'transactional';
      const slot = isTx ? expectedTxSlot : expectedMktSlot;
      if (slot >= claimDeadline) { unpaced.push(item.mail); counters.claimed--; counters.deferred++; logEmail(lane, item.mail, item.trace, 'deferred', 'PACING_WAIT'); return false; }
      const percent = item.snapshot.kind === 'marketing' ? base.config.dispatch.dailyHeadroomPercent : undefined;
      const left = dailyRemaining(gate, percent, options.shard, percent !== undefined && item.owner.customer ? base.config.dispatch.customerSharePercent : undefined);
      if (cost(item) <= left - lane.held.recipients) {
        lane.held.recipients += cost(item);
        if (isTx) { expectedTxSlot += cost(item) * 1000 / txRate; expectedMktSlot = Math.max(expectedMktSlot, expectedTxSlot); }
        else expectedMktSlot += cost(item) * 1000 / mktRate;
        return true;
      }
      const until = counters.quotaRetryAt = quotaRetry(gate, options.quotaRefreshMs);
      if (left <= 0 && !lane.deferred.some(d => d.workspace_id === item.mail.workspaceId && d.stream === item.snapshot.kind)) {
        lane.deferred.push({ workspace_id: item.mail.workspaceId, stream: item.snapshot.kind, until });
      }
      delayed.push(item.mail); counters.deferred++; counters.claimed--; logEmail(lane, item.mail, item.trace, 'deferred', 'DAILY_ALLOWANCE'); return false;
    });
    if (!group.length) continue;
    // Read MCP grants in the claim's transaction and hold their SHARE locks through the durable attempt, never during
    // SES I/O, so a grant revoked during an earlier group's sends stops this group. Other origins need just the claim.
    const checkMcp = group.some(item => item.mail.actorKeyId.startsWith('mcp_'));
    let webhooks=0, contended=new Set<string>();
    const claim = async (items: Prepared[], db: DbExecutor) => {
      const result=await claimGroup(base,items,checkMcp ? await originDecisions(items,db) : new Map(),db); webhooks=result.webhooks; contended=result.busy; return result.statuses;
    };
    let statuses: Map<string, EmailStatus>;
    try { statuses = await phase('claim', () => checkMcp ? base.db.transaction(tx => claim(group, tx)) : claim(group, base.db)); }
    catch (error) {
      // Another transaction held a row the claim needed past CLAIM_LOCK_MS (or the statement was cancelled): the claim
      // changed nothing. Its group goes back to the queue for CLAIM_BUSY_MS and the next group goes on.
      if (!['55P03', '57014'].includes(databaseCodeOf(error) ?? '')) throw error;
      log('warn', { code: 'DISPATCH_CLAIM_BUSY', region: options.region, count: group.length, sqlstate: databaseCodeOf(error) });
      for (const item of group) { lane.held.recipients -= cost(item); busy.push(item.mail); counters.claimed--; counters.deferred++; logEmail(lane, item.mail, item.trace, 'deferred', 'DISPATCH_CLAIM_BUSY'); }
      busyWake();
      continue;
    }
    lane.advanced += group.length;
    if (webhooks) pendingRecords.push(wakeWebhooks(base,webhooks));
    for(const item of group) if(statuses.get(item.mail.id)==='queued') {
      // The claim set its scheduled_at CLAIM_BUSY_MS ahead on the database's clock, before this one reads its own.
      if (contended.has(item.mail.id)) { busyWake(); logEmail(lane, item.mail, item.trace, 'deferred', 'RECIPIENT_BUSY'); continue; }
      deferBurst(lane.deferred,item.mail.workspaceId,item.snapshot.kind); logEmail(lane, item.mail, item.trace, 'deferred', 'HOSTED_BURST_LIMIT');
    }
    const attempting = group.filter(item => statuses.get(item.mail.id) === 'attempting');
    for (const item of group) if (statuses.get(item.mail.id) !== 'attempting') lane.held.recipients -= cost(item);
    const lost = group.filter(item => !statuses.has(item.mail.id));
    counters.skipped += group.length - attempting.length;
    if (lost.length) logLost(lost.length);
    // A campaign row settled by the claim itself (canceled or suppressed) may have been the campaign's last; check now.
    const settled = group.filter(item => item.mail.campaignId && ['canceled', 'suppressed'].includes(statuses.get(item.mail.id) ?? ''));
    if (settled.length) pendingRecords.push(phase('finish', () => finishSettledCampaigns(base, [...new Map(settled.map(item => [item.mail.campaignId!, { workspace_id: item.mail.workspaceId, campaign_id: item.mail.campaignId! }])).values()])));
    if (!attempting.length) continue;
    // Each message takes its own evenly spaced slot, so the provider sees a steady stream at the target
    // rate rather than one burst per group; a throttled response brakes every lane on this shard.
    // Record the complete claim together, even on a fast database. Start a
    // bounded flush at the first result so a stuck provider cannot hold its
    // siblings' IDs. Singleton claims and the last response flush immediately.
    const ready: Outcome[] = [];
    let received = 0;
    let cancel: (() => void) | undefined;
    const flush = () => {
      cancel?.(); cancel = undefined;
      if (!ready.length) return;
      const write = lane.record(ready.splice(0));
      void write.catch(() => {}); // Observe immediately; propagate the write error when the batch joins.
      pendingRecords.push(write);
    };
    const sends = await phase('send', () => Promise.allSettled(attempting.map(async item => {
      ready.push(await lane.send(item, claimDeadline));
      if (++received < attempting.length) cancel ??= (options.schedulePartialFlush ?? schedulePartialFlush)(flush);
    })));
    flush();
    for (const send of sends) if (send.status === 'rejected') { await Promise.all(pendingRecords); throw send.reason; }
  }
  // Local marketing allowance is not a regional hold: a sibling may still have capacity. Do not
  // hide the tail of its queue for a minute. Oversize transactional envelopes still get backoff.
  const marketing = delayed.filter(m => m.snapshot.kind === 'marketing'), direct = delayed.filter(m => m.snapshot.kind !== 'marketing');
  if (unpaced.length) counters.idle = false;
  if (marketing.length || unpaced.length) await releaseLeases(base, [...marketing, ...unpaced]);
  if (direct.length) await releaseLeases(base, direct, counters.quotaRetryAt);
  if (busy.length) await releaseLeases(base, busy, busyUntil);
  await Promise.all(pendingRecords);
}
async function flushFinishing(runtime: Runtime, lane: Lane) {
  if (!lane.finishing.size) return;
  const refs = [...lane.finishing.values()]; lane.finishing.clear();
  await lane.phase('finish', () => finishSettledCampaigns(runtime, refs));
}

/**
 * Drains due mail for one account/region until the queue is empty or `until` passes.
 * Safe to run concurrently in several processes/shards: leases and claims are row-level.
 */
export async function runDispatcher(runtime: Runtime, options: DispatcherOptions): Promise<DispatcherReport> {
  if (runtime.config.multiTenant && !/^\d{12}$/.test(options.accountId ?? '')) throw new ApiError(500, 'DISPATCH_ACCOUNT_REQUIRED', 'An MX dispatcher must be scoped to an AWS account.');
  // Resolve every transport module before leasing or transitioning any row to attempting.
  const transport = await loadDispatchTransport(runtime);
  const started = Date.now();
  const gate = options.gate ?? initialGate();
  const counters: DispatcherReport = { claimed: 0, sent: 0, deferred: 0, skipped: 0, batches: 0, idle: true, durationMs: 0, timings: {}, statements: 0 };
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try { return await work(); } finally { counters.timings[name] = (counters.timings[name] ?? 0) + Date.now() - startedAt; if (name !== 'send' && name !== 'pace' && name !== 'prepare') counters.statements++; }
  };
  const pacing: Pacing = { rateFactor: runtime.config.dispatch.rateFactor, txReservePercent: runtime.config.dispatch.txReservePercent ?? 15, targetRate: runtime.config.dispatch.targetRate, live: !isSimulatedSes(runtime) };
  const held = { recipients: 0 };
  const runClients = new Map<string, SESv2Client>();
  const lane: Lane = { attachmentBytes:0,advanced:0,deferred: [], gate, pacing, shadowOn: !!runtime.config.shadow, held, finishing: new Map(), send: pacedSender(gate, options, pacing, counters, held), record: outcomeRecorder(ready => recordBatch(runtime, lane, ready)), counters, phase, options: { ...options, batchSize: options.batchSize ?? 24, sendConcurrency: options.sendConcurrency ?? 6, quotaRefreshMs: options.quotaRefreshMs ?? QUOTA_REFRESH_MS } };
  // The owner cursor rotates where each lease starts, so every owner gets a turn, but a lease
  // never wraps past the last owner. One that started after the cursor and reached the end
  // empty-handed has not looked at the owners before it: with exactly a lease's worth of owners
  // (or a cursor left by the previous run) the run used to stop and report idle with mail due.
  // Look there at once, but only if the pass since the last wrap advanced durable work (a claim,
  // a preflight rejection or deferral). Leasing alone is not progress: rows the local allowance
  // cannot afford are released unchanged, and leasing them again would spin until the run's
  // budget. Without progress the run ends; its quotaRetryAt holds it until the sample changes.
  // The first pass of a run may wrap once, for a cursor the previous run left behind.
  let passStart = -1, passAllowance: Allowance | undefined;
  // What the gate's current sample still affords, per stream, net of envelopes held in claim
  // groups; unknown until the run has a fresh sample. A lease skips the envelopes it cannot
  // afford, one by one: an owner's oversized head never hides the affordable mail behind it.
  const { dailyHeadroomPercent: headroom, customerSharePercent: share } = runtime.config.dispatch;
  const afford = (left: number) => Math.floor(Math.min(MAX_ENVELOPE, Math.max(0, left - held.recipients)));
  const allowance = (): Allowance | undefined => gate.quota && Date.now() < (gate.refreshAt ?? 0) ? {
    transactional: afford(dailyRemaining(gate)), marketing: afford(dailyRemaining(gate, headroom, options.shard)), customer: afford(dailyRemaining(gate, headroom, options.shard, share)),
  } : undefined;
  // The allowance became known or smaller: rows a lease returned unaffordable are now skipped.
  const tighter = (now: Allowance | undefined, before: Allowance | undefined) => !!now && (!before || now.marketing < before.marketing || now.transactional < before.transactional || now.customer < before.customer);
  const leaseAllowance = new WeakMap<Leased[], Allowance | undefined>();
  const lease = async (priorityOnly = false, first = false) => {
    if (options.stop?.()) return [];
    const now = Date.now();
    const txAt = txReadyAt(gate, now);
    const mktAt = mktReadyAt(gate);
    if (txAt >= now + MAX_PRE_SEND_MS) { counters.paceRetryAt = Math.ceil(txAt); return []; }
    if (mktAt >= now + MAX_PRE_SEND_MS) { counters.paceRetryAt = Math.ceil(mktAt); priorityOnly = true; }
    for (let i = lane.deferred.length - 1; i >= 0; i--) if ((lane.deferred[i]!.until ?? Infinity) <= now) lane.deferred.splice(i, 1);
    if (gate.quota && now < (gate.refreshAt ?? 0) && dailyRemaining(gate, runtime.config.dispatch.dailyHeadroomPercent, options.shard) <= held.recipients) {
      counters.quotaRetryAt = quotaRetry(gate, lane.options.quotaRefreshMs);
      if (dailyRemaining(gate) <= 0) return [];
      priorityOnly = true; // Seek past the entire marketing queue, including owners this run hasn't seen.
    }
    const caps = allowance();
    // Mail the allowance skips waits for a new sample: an idle run still wakes when it can change.
    if (caps && Object.values(caps).some(n => n < MAX_ENVELOPE)) counters.quotaRetryAt ??= quotaRetry(gate, lane.options.quotaRefreshMs);
    const leaseOnce = (size = lane.options.batchSize) => phase('lease', () => leaseDue(runtime, transport, options.region, size, gate,lane.deferred, runClients, options.accountId, priorityOnly, first && (!gate.quota || now >= (gate.refreshAt ?? 0)), caps));
    const deferredBefore = lane.deferred.length;
    const fromCursor = gate.ownerCursor !== undefined;
    if (!fromCursor) { passStart = lane.advanced; passAllowance = caps; }
    let rows = await leaseOnce();
    if (fromCursor && !rows.length && gate.ownerCursor === undefined && (passStart < 0 || lane.advanced > passStart || tighter(caps, passAllowance))) { passStart = lane.advanced; passAllowance = caps; rows = await leaseOnce(); }
    // Slots that went to a stream the burst check just deferred (a full burst window: fit/due dropped its rows) leave the
    // lease short with other mail due, and transactional rows rank first: look again past the deferred streams at once.
    for (let seen = deferredBefore; rows.length < lane.options.batchSize && lane.deferred.length > seen;) {
      seen = lane.deferred.length;
      rows = rows.concat(await leaseOnce(lane.options.batchSize - rows.length));
    }
    leaseAllowance.set(rows, caps);
    return rows;
  };
  let blocked = false;
  const drainLane = async (batch: Leased[]) => {
    for (;;) {
      const advanced = lane.advanced, caps = leaseAllowance.get(batch);
      const { processed, blocked: exhausted } = await dispatchBatch(runtime, lane, batch);
      counters.batches++;
      if (exhausted) blocked = true;
      if (processed || gate.ownerCursor) await options.onGate?.(gate);
      // A batch that advanced nothing (every row released unchanged) would come back from the
      // next lease as it was, unless the owner cursor moves on to other owners or the allowance
      // now skips what it could not afford. Whatever the batch size or owner count, end there.
      const stalled = batch.length > 0 && lane.advanced === advanced && !gate.ownerCursor && !tighter(allowance(), caps);
      // A short batch means the queue is draining: settle completed campaigns before this lane stops.
      if (blocked || stalled || batch.length < lane.options.batchSize && (!gate.ownerCursor || gate.nextAllowedAt>=Date.now()+MAX_PRE_SEND_MS || dailyRemaining(gate)<=0)) { await flushFinishing(runtime, lane); return; }
      if (options.until !== undefined && Date.now() >= options.until || options.stop?.()) { counters.idle = false; await flushFinishing(runtime, lane); return; }
      batch = await lease();
    }
  };
  // The host wakes this run after a transactional admission commits. Coalesce hints arriving
  // during a probe; no database polling, spare send capacity or campaign-sized reservation.
  const key = dispatchWakeKey(options.region, options.accountId);
  let done = false, dirty = false, resume: (() => void) | undefined;
  const wake = () => { dirty = true; resume?.(); };
  options.priorityWake?.addEventListener(key, wake);
  const priority = async () => {
    if (!options.priorityWake) return;
    while (!done && !blocked && !options.stop?.()) { // Keep serving priority wakes while the last normal batch drains past the lease budget.
      if (!dirty) await new Promise<void>(resolve => { resume = resolve; });
      if (done || blocked) return;
      resume = undefined; dirty = false;
      const batch = await lease(true);
      const result = await dispatchBatch(runtime, lane, batch);
      if (result.blocked) blocked = true;
      if (result.processed) { counters.batches++; await options.onGate?.(gate); }
      if (batch.length === lane.options.batchSize) dirty = true;
    }
  };
  let first: Leased[];
  try { first = await lease(false,true); } catch(error) { options.priorityWake?.removeEventListener(key,wake); throw error; }
  const normal = async () => {
    try {
      const lanes = first.length === lane.options.batchSize ? Math.max(1, options.lanes ?? 2) : 1;
      const results = await Promise.allSettled(Array.from({ length: lanes }, async (_, i) => drainLane(i === 0 ? first : await lease())));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally { done = true; options.priorityWake?.removeEventListener(key, wake); resume?.(); }
  };
  const results = await Promise.allSettled([normal(), priority()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  await flushFinishing(runtime, lane);
  if (blocked) counters.idle = true;
  const paceUntil = Math.max(gate.nextAllowedAt, gate.marketingAllowedAt ?? 0);
  // Paced far ahead: the run sleeps until the pace ends, or until an earlier retry (storage back, a busy claim's mail due)
  // if transactional mail could go by then.
  if (paceUntil >= Date.now() + MAX_PRE_SEND_MS) {
    counters.paceRetryAt = Math.ceil(Math.min(paceUntil, Math.max(counters.paceRetryAt ?? Infinity, txReadyAt(gate, Date.now()))));
    counters.idle = true;
  }
  counters.durationMs = Date.now() - started;
  // Idle polls are silent; runs that moved mail (or hit the budget) are the throughput record.
  if (counters.claimed || !counters.idle) log('info', { code: 'DISPATCH_RUN', accountId: options.accountId, region: options.region, shard: options.shard?.index ?? 0, ...counters, quota: gate.quota?.maxSendRate ?? null, rate: shardRate(gate, options.shard, pacing), braked: (gate.brakeUntil ?? 0) > Date.now(), wakeMs: options.wakeMs });

  return counters;
}

export const dispatchWakeKey = (region: string, account?: string) => `${account ?? ''}:${region}`;

/** Test/runner helper: drain everything due for one account/region with no time limit. */
export async function dispatchDue(runtime: Runtime, region: string, overrides: Partial<DispatcherOptions> = {}) {
  return runDispatcher(runtime, { region, lanes: 1, ...overrides });
}
