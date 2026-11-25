import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { Attachment, SESv2Client, SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { ApiError, databaseConflict, getSes, isSimulatedSes, rowId, lazyModule, log, logError, ModuleLoadError, preloadSesTransport, transientDatabaseError, wrapModuleLoad, type Actor, type DbExecutor, type Runtime } from './core.js';
import { attachments, emails, type EmailSnapshot, type EmailStatus, type CampaignDraft, type ReviewedRecipient } from './db/sending.js';
import { approvedOriginUser, checkedDispatchAttachments, customerCredits, formattedSender, inlineMessage, LINK_RECORD_RECHECK_MS, materializeCampaignEmail, originAllowed, publicEventType, QUOTA_REFRESH_MS, queueSimulatedFeedback, rank, sesDailyReserve, sizeCheck, statusForEvent, terminalColumns, terminalEvents, verifiedAttachment } from './sending.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { tieAllows } from './approval-ties.js';
import { principal } from './mail-gateway.js';
import { regionalSender, sendingConnections, verifiedClaim } from './domain-claims.js';
import { claimsOnly } from './send-scope.js';
import { heldStream, probationReason } from './hosted-sending.js';
import { finishCampaigns, pauseCampaign, reopenQueuedCampaigns, type TenantState } from './states.js';
import { credentialFingerprint, discoveryTarget } from './ses-region-state.js';
import { mxResourceName, POOL_INSTALLATION, setupResources } from './ses-setup.js';
import { forDelivery, type ReadyConnection } from './provider-credentials.js';
import { wakeWebhooks } from './jobs.js';
import { shareFullAlert } from './operator-alerts.js';
import type { CampaignScreen } from './screen.js';
import { outbound } from './screen-calls.js';
import { SEND_LIMITS } from './send-limits.js';
import { SesBodyError } from './ses-body.js';
import { sendReservation, withMemory } from './isolate-memory.js';
import { linkInlineImages } from './linked-images.js';
import { servedDomains } from './brand.js';

const loadSesv2 = lazyModule(() => import('@aws-sdk/client-sesv2'));
const loadSimulatedSes = lazyModule(() => import('./adapters/simulated-ses.js'));

// The dispatcher is a long-lived loop, hosted by a Durable Object on Cloudflare and by the
// runner process on Node. PostgreSQL remains the only source of truth: a row is sent at most
// once because the batched claim flips it queued → attempting under its dispatch_version.
// Provider pacing lives in process memory (one shard owns one share of the regional quota),
// so the hot path costs three database statements per batch rather than ten per email.

export type DispatchTransport = {
  GetAccountCommand: typeof import('@aws-sdk/client-sesv2').GetAccountCommand;
  SendEmailCommand: typeof import('@aws-sdk/client-sesv2').SendEmailCommand;
  clientFor: (runtime: Runtime, region: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>) => SESv2Client;
};
export function loadDispatchTransport(runtime: Runtime): Promise<DispatchTransport> {
  return wrapModuleLoad(async () => {
    if (isSimulatedSes(runtime)) {
      const [{ GetAccountCommand, SendEmailCommand }, { simulatedSes }] = await Promise.all([loadSesv2(), loadSimulatedSes()]);
      return { GetAccountCommand, SendEmailCommand, clientFor: (rt, reg) => simulatedSes(rt, reg) };
    }
    const { sesv2: { GetAccountCommand, SendEmailCommand }, getSesSync } = await preloadSesTransport(runtime.config.multiTenant);
    return { GetAccountCommand, SendEmailCommand, clientFor: getSesSync };
  });
}

export type Mail = typeof emails.$inferSelect;
type Review = { version:number; draft: CampaignDraft; rendered: { html?: string; text?: string }; assets:AttachmentRow[]; contentHash: string | null; recipient: ReviewedRecipient; screen?: CampaignScreen | null; reviewHash?: string };
// `probation`: a Hosted sender still in its evaluation, growth pace or below good standing (src/hosted-sending.ts probationReason).
// `customer`: an outside workspace on the shared account (Hosted, live, not exempt), whose marketing waits for the customer share.
type Owner = { runtime: Runtime; a: Actor; ses: SESv2Client; transport: DispatchTransport; sendClient?:(domainId:string)=>SESv2Client; trusted?:boolean; probation?:boolean; customer?: boolean; tenantName?: string; feedbackTopic?: string };
type LeaseQuota = { rate: number; max: number; sent: number; customer: number; checked: string; age_ms: number };
/** Where one email's time goes in a run, filled in stage by stage for its DISPATCH_EMAIL line (logEmail). */
type Trace = { leasedAt: number; shard?: number; paceMs?: number; sesMs?: number };
type Leased = { mail: Mail; contentBytes: number; review: Review | null; owner: Owner | null; rateRetries: number; quota?: LeaseQuota; trace: Trace };
type Prepared = Leased & { owner: Owner; snapshot: EmailSnapshot; content: SendEmailCommandInput['Content']; unsubscribe?: { tokenHash: string; email: string; page?: string }; stored?: Partial<EmailSnapshot> };
type Outcome = { mail: Mail; type: 'accepted' | 'reject' | 'acceptance_unknown' | 'provider_throttled' | 'dispatch_deferred'; providerId?: string; errorCode?: string; data: Record<string, unknown>; requeueAt?: string; trace?: Trace };
const requeued = (o: Outcome) => o.type === 'provider_throttled' || o.type === 'dispatch_deferred';

// customerSent: what outside workspaces on a shared account used of its daily limit (migration 401), read with the sample.
export interface QuotaSnapshot { maxSendRate: number; max24HourSend: number; sentLast24Hours: number; customerSent?: number; checkedAt: number }
// Serializable pacing state so a Durable Object survives eviction without bursting.
export interface GateState { nextAllowedAt: number; txAllowedAt?: number; marketingAllowedAt?: number; quota: QuotaSnapshot | null; refreshAt?: number; sentSinceRefresh: number; brakeUntil?: number; marketingBrakeUntil?: number; recentTxUntil?: number; accountPauseAt?:number; outageUntil?: number; outageStreak?: number; dailyBlockedUntil?: number; ownerCursor?: string }
export const initialGate = (): GateState => ({ nextAllowedAt: 0, quota: null, sentSinceRefresh: 0 });
/** Target per-shard SES send rate (emails/sec). A Durable Object holds 6 simultaneous outbound connections (~35/s ceiling
 *  at 170 ms SES RTT), so 25/s per shard gives 8 shards at 200/s and scales smoothly to 40 shards at 1,000/s. */
export const TARGET_SHARD_RATE = 25;
/** Derives the number of mail-room shards from the SES account's MaxSendRate, falling back to `fallback` before the first quota sample. */
export function shardsForRate(rate: number | null | undefined, fallback = 1, max = 256, targetRate = TARGET_SHARD_RATE): number {
  const cap = Math.min(256, Math.max(1, Math.floor(max) || 256));
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
    const target = Number.isFinite(targetRate) && targetRate > 0 ? targetRate : TARGET_SHARD_RATE;
    return Math.min(cap, Math.max(1, Math.ceil(rate / target)));
  }
  return Math.min(cap, Math.max(1, Math.floor(fallback) || 1));
}
// Round up to a multiple of sendConcurrency (6) so a batch never ends in a 1-row tail claim.
export const shardLeaseSize=(rate:number|undefined,count:number)=>rate!==undefined && count>1 ? Math.min(24,Math.max(6,Math.ceil(rate/count/6)*6)) : 24;
export type Pacing = { rateFactor: number; txReservePercent?: number; targetRate?: number; live: boolean };
const RECENT_TX_MS = 2000;
const txReadyAt = (gate: GateState, now: number) => Math.max(gate.txAllowedAt ?? 0, (gate.brakeUntil ?? 0) > now ? gate.nextAllowedAt : 0);
const mktReadyAt = (gate: GateState) => Math.max(gate.nextAllowedAt, gate.marketingAllowedAt ?? 0);
const BRAKE_MS = 10000;
// SES gave no usable answer (transport error, timeout, 5xx, or no MessageId): an ambiguous call is never replayed, so stop starting new
// calls instead of turning every queued email into acceptance_unknown. Doubles while SES stays silent.
const OUTAGE_MS = 15000, OUTAGE_MAX_MS = 300000;
// Far below interrupted-attempt recovery (3 min) and the queue lease (2 min). Ordinary groups
// can share a claim, but an unsent item never waits behind a long envelope or priority flood.
const MAX_PRE_SEND_MS = 5000;

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

// Timestamps are cast to text so raw rows match Drizzle's string-mode timestamp columns.
// The lease carries routing/claim metadata, not a batch of multi-MiB bodies. Use the
// logical size: pg_column_size can report the much smaller compressed TOAST value.
const INLINE_SNAPSHOT_BYTES = 64 * 1024;
const contentFields = sql`ARRAY['text','html','raw','mime','template']`;
const mailColumns = Object.entries(getTableColumns(emails)).map(([key, column]) => key === 'snapshot'
  ? sql`CASE WHEN measured.bytes > ${INLINE_SNAPSHOT_BYTES} THEN leased.snapshot - ${contentFields} ELSE leased.snapshot END AS snapshot`
  : sql`leased.${sql.identifier(column.name)}${column.columnType.startsWith('PgTimestamp') ? sql`::text` : sql``} AS ${sql.identifier(key)}`);
let rankJsonCache: string | undefined;
const rankJson = () => rankJsonCache ??= JSON.stringify(rank);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function providerClient(runtime: Runtime, region: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): Promise<SESv2Client> {
  return isSimulatedSes(runtime) ? (await loadSimulatedSes()).simulatedSes(runtime, region) : getSes(runtime, region, connection, runClients);
}
async function fetchQuota(transport: DispatchTransport, ses: SESv2Client, gate: GateState): Promise<QuotaSnapshot> {
  const account = await ses.send(new transport.GetAccountCommand({})), quota = account.SendQuota;
  if (account.SendingEnabled) delete gate.accountPauseAt;
  if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.MaxSendRate <= 0 || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
  return { maxSendRate: quota.MaxSendRate, max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours, checkedAt: Date.now() };
}
// checkedAt identifies the sample on the database clock; refreshAt is a deadline on this host.
// Re-reading the same snapshot (including after restoring an old gate) cannot mint more capacity.
function observeQuota(gate: GateState, sample: QuotaSnapshot, refreshMs: number, ageMs = 0) {
  if (!gate.quota || sample.checkedAt > gate.quota.checkedAt) {
    gate.quota = sample; gate.sentSinceRefresh = 0;
    // A sibling's successful GetAccount is evidence too, but not a sample predating the pause.
    if (gate.accountPauseAt!==undefined && Date.now()-ageMs>gate.accountPauseAt) delete gate.accountPauseAt;
    delete gate.dailyBlockedUntil;
  }
  gate.refreshAt = Date.now() + Math.max(Math.min(1000, refreshMs), refreshMs - Math.max(0, ageMs));
  if (gate.dailyBlockedUntil) gate.refreshAt = gate.dailyBlockedUntil = Math.max(gate.refreshAt, gate.dailyBlockedUntil);
  return true;
}
// Elect the refresher BEFORE GetAccount, across all DOs/lanes for this account. A failed or
// interrupted fetch keeps its fence until the next cache period; no DB lock is held over AWS I/O.
async function ensureQuota(owner: Pick<Owner, 'runtime'|'ses'|'transport'> & { a: Pick<Actor, 'workspaceId'> }, account: string | undefined, region: string, gate: GateState, refreshMs: number) {
  const { runtime, ses, a, transport } = owner;
  const table = sql.identifier(account ? 'provider_account_limits' : 'sending_region_limits');
  const subject = sql.identifier(account ? 'aws_account_id' : 'workspace_id'), fence = sql.identifier(account ? 'refresh_after' : 'next_allowed_at');
  const key = sql`${subject}=${account ?? a.workspaceId} AND region=${region}`;
  if (account) refreshMs = Math.max(1000, refreshMs);
  const period = sql`(${refreshMs}::int * interval '1 millisecond')`;
  type Row = { fence: string | null; checked: string; rate: number; max: number; sent: number; customer: number; age_ms: number };
  const customer = account ? sql`customer_sent_24_hours` : sql`0::float8`;
  const cached = sql`SELECT NULL::text AS fence, checked_at::text AS checked, max_send_rate AS rate, max_24_hour_send AS max, sent_last_24_hours AS sent, ${customer} AS customer, extract(epoch FROM clock_timestamp()-checked_at)::float8*1000 AS age_ms
    FROM ${table} WHERE ${key} AND max_send_rate > 0 AND checked_at > clock_timestamp()-${period}`;
  const result = await runtime.db.execute<Row>(sql`WITH elected AS (
    INSERT INTO ${table}(${subject},region,${fence}) VALUES (${account ?? a.workspaceId},${region},clock_timestamp()+${period})
    ON CONFLICT (${subject},region) DO UPDATE SET ${fence}=clock_timestamp()+${period}
      WHERE (${table}.${fence} IS NULL OR ${table}.${fence} <= clock_timestamp()) AND (${table}.checked_at IS NULL OR ${table}.max_send_rate <= 0 OR ${table}.checked_at <= clock_timestamp()-${period})
    RETURNING ${fence}::text AS fence)
    SELECT fence,NULL::text AS checked,NULL::float8 AS rate,NULL::float8 AS max,NULL::float8 AS sent,NULL::float8 AS customer,NULL::float8 AS age_ms FROM elected UNION ALL ${cached} LIMIT 1`);
  let row = result.rows[0];
  if (row?.fence) {
    const q = await fetchQuota(transport, ses, gate);
    // The customer share's sum is taken here, by the one elected refresher, from the sample it is a share of. The
    // previous sample comes back too (a subquery reads the row as it was before this statement).
    const saved = await runtime.db.execute<{ checked: string; customer: number; was: { max: number | null; customer: number } | null }>(sql`UPDATE ${table} SET checked_at=clock_timestamp(), ${fence}=${account ? sql`clock_timestamp()+${period}` : sql`NULL`},
      max_send_rate=${q.maxSendRate},max_24_hour_send=${q.max24HourSend},sent_last_24_hours=${q.sentLast24Hours}${account ? sql`,customer_sent_24_hours=hosted_customer_day(${account},${region},${q.sentLast24Hours})` : sql``}
      WHERE ${key} AND ${fence}=${row.fence}::timestamptz RETURNING checked_at::text AS checked, ${customer} AS customer,
      ${account ? sql`(SELECT json_build_object('max',p.max_24_hour_send,'customer',p.customer_sent_24_hours) FROM ${table} p WHERE p.aws_account_id=${account} AND p.region=${region})` : sql`NULL`} AS was`);
    if (!saved.rowCount) return false;
    const customerSent = Number(saved.rows[0]!.customer), percent = runtime.config.dispatch.customerSharePercent, was = saved.rows[0]!.was;
    const full = (max: number, used: number) => used > 0 && customerCredits(max, used, percent) === 0;
    if (full(q.max24HourSend, customerSent)) {
      const share = Math.floor(q.max24HourSend * percent / 100);
      log('error', { code: 'HOSTED_CUSTOMER_SHARE_FULL', accountId: account, region, used: customerSent, share, percent });
      // The operators' Slack hears once, when the share fills (src/operator-alerts.ts); it never fails this refresh.
      if (!was || !full(Number(was.max ?? 0), Number(was.customer))) await shareFullAlert(runtime, customerSent, share);
    }
    return observeQuota(gate, { ...q, customerSent, checkedAt: Date.parse(saved.rows[0]!.checked) }, refreshMs);
  } else {
    // A concurrent shard won a cold refresh. Give its single control-plane request time to publish.
    for (const delay of [100, 400, 1000]) {
      if (row) break;
      await sleep(delay); row = (await runtime.db.execute<Row>(cached)).rows[0];
    }
    if (!row) return false;
    return observeQuota(gate, { maxSendRate: row.rate, max24HourSend: account ? row.max : row.max || -1, sentLast24Hours: row.sent, customerSent: Number(row.customer), checkedAt: Date.parse(row.checked) }, refreshMs, row.age_ms);
  }
}

/** A pool region whose quota sample is older than this gets a new one from the minute tick (refreshPoolQuotas). */
export const POOL_QUOTA_STALE_MS = 5 * 60_000;
/**
 * The shared pool's SES quota in every region it sends from. The dispatcher samples a region only while it sends mail
 * there (ensureQuota), so a region nothing had gone through yet had no sample at all, and Glass couldn't show it. The
 * minute tick (worker.ts, runner.ts) fills that in for a region whose sample is missing or older
 * than POOL_QUOTA_STALE_MS, through the same election as the dispatcher (one GetAccount per account and region at a
 * time), with the platform's own credentials. A region that sends keeps its fresh sample and costs nothing here. Never
 * throws: a region that can't be read is logged and tried again the next minute.
 */
/** The platform's own SES client for a shared pool region: shared credentials, so the account must be the platform's
 *  (core.ts assertSharedAccount), and a runtime scoped to the region (core.ts region()). Quota and deliverability reads. */
export function poolSes(runtime: Runtime, transport: DispatchTransport, region: string, account: string) {
  const scoped = { ...runtime, config: { ...runtime.config, regions: [region] } };
  const pool: ReadyConnection = { id: `pool:${region}`, kind: 'shared', aws_account_id: account, role_arn: '', external_id: '' };
  return { scoped, ses: transport.clientFor(scoped, region, forDelivery(pool, { purpose: 'quota' })) };
}
export async function refreshPoolQuotas(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  try {
    const { rows } = await runtime.db.execute<{ region: string; account: string }>(sql`SELECT p.region,p.aws_account_id AS account FROM provider_pool_regions p
      LEFT JOIN provider_account_limits l ON l.aws_account_id=p.aws_account_id AND l.region=p.region
      WHERE p.sending_state='ready' AND (l.checked_at IS NULL OR l.checked_at<clock_timestamp()-${POOL_QUOTA_STALE_MS}::int*interval '1 millisecond') ORDER BY p.region`);
    if (!rows.length) return;
    const transport = await loadDispatchTransport(runtime);
    for (const { region, account } of rows) {
      try {
        const { scoped, ses } = poolSes(runtime, transport, region, account);
        await ensureQuota({ runtime: scoped, a: { workspaceId: runtime.config.workspaceId }, transport, ses }, account, region, initialGate(), QUOTA_REFRESH_MS);
      } catch (error) { logError(error, { code: 'POOL_QUOTA_REFRESH_FAILED', region }, 'warn'); }
    }
  } catch (error) { logError(error, { code: 'POOL_QUOTA_REFRESH_FAILED' }, 'warn'); }
}

// A held campaign can outlive its last queued email. Refresh the same fenced provider cache
// without manufacturing a queued message just to wake a dispatcher.
export async function campaignQuota(runtime: Runtime, a: Actor, region: string, account?: string) {
  const transport = await loadDispatchTransport(runtime);
  const connection = runtime.config.multiTenant ? (await runtime.db.execute<ReadyConnection>(sql`SELECT * FROM ${sendingConnections(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region} AND aws_account_id=${account ?? ''} AND paused_at IS NULL`)).rows[0] : undefined;
  if (runtime.config.multiTenant && !connection) return null;
  const gate = initialGate();
  return await ensureQuota({ runtime, a, transport, ses: transport.clientFor({...runtime,config:{...runtime.config,workspaceId:a.workspaceId}}, region, forDelivery(connection,{purpose:'quota'})) }, account, region, gate, QUOTA_REFRESH_MS) ? gate.quota : null;
}

/**
 * Target recipients per second for this shard. The provider quota is the base; DISPATCH_RATE_FACTOR
 * (or an absolute live DISPATCH_TARGET_RATE) aims above or below it, and a recent throttled response
 * brakes back to the raw quota so an aggressive target cannot spiral into retries.
 */
export function shardRate(gate: GateState, shard?: { index: number; count: number }, pacing?: Pacing) {
  const quota = gate.quota?.maxSendRate ?? 0;
  const braked = (gate.brakeUntil ?? 0) > Date.now();
  let target = quota;
  if (pacing && !braked) target = pacing.live && pacing.targetRate ? pacing.targetRate : quota * pacing.rateFactor;
  return shard && shard.count > 1 ? Math.max(0.01, target / shard.count) : target;
}
/** Effective marketing rate for this shard: lends the unused transactional reserve when unbraked, and drops to
 *  (1 - txReservePercent) of the raw shard quota when braked so transactional keeps its reserved headroom. */
export function marketingShardRate(gate: GateState, shard?: { index: number; count: number }, pacing?: Pacing) {
  const now = Date.now(), quota = gate.quota?.maxSendRate ?? 0;
  const mktBraked = (gate.marketingBrakeUntil ?? 0) > now || (gate.brakeUntil ?? 0) > now;
  if (!mktBraked) return shardRate(gate, shard, pacing);
  const reserveFrac = Math.min(0.9, Math.max(0, (pacing?.txReservePercent ?? 15) / 100));
  const target = quota * (1 - reserveFrac);
  return shard && shard.count > 1 ? Math.max(0.01, target / shard.count) : Math.max(0.01, target);
}
/** Reserves `recipients` slots and returns how long the caller must wait before sending them. Slots are spaced evenly at
 *  the target rate. Transactional mail never waits on marketing's brake, and advances marketing's clock so total rate stays bounded. */
export function reserve(gate: GateState, recipients: number, shard?: { index: number; count: number }, pacing?: Pacing, kind?: EmailSnapshot['kind']): number {
  const now = Date.now();
  const rate = kind === 'marketing' ? marketingShardRate(gate, shard, pacing) : shardRate(gate, shard, pacing);
  if (rate <= 0) return 1000;
  const spacing = 1000 * recipients / rate;
  const jitter = Math.min(2, spacing / 2);
  if (kind === 'transactional') {
    const txStart = Math.max(now, txReadyAt(gate, now));
    gate.txAllowedAt = Math.max(gate.txAllowedAt || now, now - jitter) + spacing;
    gate.nextAllowedAt = Math.max(gate.nextAllowedAt || now, now - jitter) + spacing;
    gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, gate.nextAllowedAt);
    gate.recentTxUntil = Math.max(gate.recentTxUntil ?? 0, now + RECENT_TX_MS);
    gate.sentSinceRefresh += recipients;
    return Math.max(0, txStart - Date.now());
  }
  const start = Math.max(now, gate.nextAllowedAt, kind === 'marketing' ? gate.marketingAllowedAt ?? 0 : 0);
  const base = Math.max(gate.nextAllowedAt || now, kind === 'marketing' ? gate.marketingAllowedAt || now : 0, now - jitter);
  gate.nextAllowedAt = base + spacing;
  if (kind === 'marketing') gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, gate.nextAllowedAt);
  gate.sentSinceRefresh += recipients;
  return Math.max(0, start - Date.now());
}
/** A throttled provider response. A marketing 429 brakes only marketing (yielding 1 s and dropping marketing to
 *  (1 - txReservePercent) of raw quota) so transactional keeps its reserved slice; a transactional 429 brakes both
 *  streams while giving transactional a short 250 ms retry and yielding 2 s of marketing. Omitting kind brakes both. */
export function brake(gate: GateState, kind?: EmailSnapshot['kind']) {
  const now = Date.now();
  if (kind === 'marketing') {
    gate.marketingBrakeUntil = now + BRAKE_MS;
    gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, now + 1000);
    return;
  }
  gate.brakeUntil = now + BRAKE_MS;
  gate.marketingBrakeUntil = now + BRAKE_MS;
  if (kind === 'transactional') {
    gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now + 250);
    gate.txAllowedAt = Math.max(gate.txAllowedAt ?? 0, now + 250);
    gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, now + 1000);
    return;
  }
  gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now + 1000);
  gate.txAllowedAt = Math.max(gate.txAllowedAt ?? 0, now + 1000);
  gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, now + 1000);
}
// `share`: an outside workspace's marketing also fits in what is left of the customer share (src/sending.ts customerCredits).
const marketingCredits = (q: QuotaSnapshot, percent: number, share?: number) => Math.max(0, Math.min(q.max24HourSend - q.sentLast24Hours - sesDailyReserve(q.max24HourSend, percent),
  share === undefined ? Infinity : customerCredits(q.max24HourSend, q.customerSent ?? 0, share)));
function dailyRemaining(gate: GateState, headroomPercent?: number, shard?: DispatcherOptions['shard'], share?: number) {
  if (gate.dailyBlockedUntil) return 0; // A fresh account snapshot, not a slot timer, releases a provider daily denial.
  const quota = gate.quota;
  if (!quota || quota.max24HourSend < 0) return Number.POSITIVE_INFINITY;
  // A transactional envelope can have up to 50 recipients: it need not fit into one shard's
  // marketing allowance. The provider still enforces the account-wide hard ceiling.
  if (headroomPercent === undefined) return quota.max24HourSend - quota.sentLast24Hours - gate.sentSinceRefresh;
  // The provider snapshot is account-wide; each shard can spend only its share until the next
  // refresh. Otherwise four shards could each spend the *entire* remaining marketing allowance.
  // The shares add up to the remainder exactly: the last credits belong to the first shards. Against the customer share
  // every send since the sample counts, ours and transactional too: until the next sample, a minute, it errs toward ours.
  const remaining = marketingCredits(quota, headroomPercent, share);
  const count = shard?.count ?? 1, index = shard?.index ?? 0;
  return Math.floor(remaining / count) + (index < remaining % count ? 1 : 0) - gate.sentSinceRefresh;
}

// One statement leases the oldest due mail for this region and returns it with its frozen review inputs.
type DeferredStream = { workspace_id: string; stream: EmailSnapshot['kind']; until?: number };
// Recipients an envelope may still have to be affordable, per stream (at most 50 per envelope); `customer` is an outside
// workspace's marketing, under the customer share as well.
type Allowance = { transactional: number; marketing: number; customer: number };
const MAX_ENVELOPE = 50;
async function leaseDue(runtime: Runtime, transport: DispatchTransport, region: string, limit: number, gate:GateState, deferred: DeferredStream[], runClients: Map<string, SESv2Client>, accountId?: string, priorityOnly = false, readQuota = false, allowance?: Allowance): Promise<Leased[]> {
  const queued = sql`region = ${region} AND status = 'queued' AND screened`;
  const available = sql`(lease_until IS NULL OR lease_until < statement_timestamp())`;
  const transactional = sql`(e.snapshot->>'kind' = 'transactional')`;
  const priority = sql`ORDER BY ${transactional} DESC, created_at, id`;
  const mx=runtime.config.multiTenant, liveMx=mx && !isSimulatedSes(runtime);
  const cost=sql`jsonb_array_length(e.to_addresses||e.cc_addresses||e.bcc_addresses)`;
  const domain=sql`lower(split_part(e.from_address,'@',2))`;
  const tick=sql`date_trunc('minute',statement_timestamp())`;
  // A marketing hold leaves the held stream queued (heldStream); transactional mail keeps flowing.
  const dueForOwner = sql`FROM sending_emails e WHERE ${queued} AND e.workspace_id = o.workspace_id AND ${available} AND (NOT o.marketing_held OR NOT ${heldStream(sql`e`)})
    -- A boolean range is an index condition on 061's expression. Equality to true is
    -- simplified to a text comparison and can scan the kind index over delivered mail.
    ${priorityOnly ? sql`AND ${transactional} > false` : sql``}
    ${allowance && Object.values(allowance).some(n => n < MAX_ENVELOPE) ? sql`AND ${cost} <= CASE WHEN ${transactional} THEN ${allowance.transactional}::int WHEN o.customer THEN ${allowance.customer}::int ELSE ${allowance.marketing}::int END` : sql``}
    ${deferred.length ? sql`AND ${transactional} BETWEEN (o.workspace_id=ANY(${sql.param(deferred.filter(d=>d.stream==='marketing').map(d=>d.workspace_id))}::text[])) AND NOT (o.workspace_id=ANY(${sql.param(deferred.filter(d=>d.stream==='transactional').map(d=>d.workspace_id))}::text[]))` : sql``}`;
  // Look up each due stream separately: the immediate ordered index contains no future mail,
  // and the scheduled index can stop at this statement's cutoff. Merge only bounded pages.
  const page = (size: SQL, lock = false, exclude = sql``) => {
    const arm = (schedule: SQL) => sql`SELECT * FROM (SELECT e.id,${transactional} AS transactional,e.created_at ${dueForOwner}
      AND ${schedule} ${exclude} ${priority} LIMIT ${size} ${lock ? sql`FOR UPDATE SKIP LOCKED` : sql``}) arm`;
    return sql`SELECT * FROM (${arm(sql`scheduled_at IS NULL`)} UNION ALL ${arm(sql`scheduled_at <= statement_timestamp()`)}) streams
      ORDER BY transactional DESC,created_at,id LIMIT ${size}`;
  };
  // Always discover transactional owners first via the partial transactional index (sending_emails_tx_due) so a
  // password reset is never hidden behind ownerCursor or many active marketing campaigns. Marketing owners still rotate
  // via ownerCursor, and candidates rank transactional strictly ahead of marketing (round-robin within each stream).
  const deferredTx = deferred.filter(d => d.stream === 'transactional').map(d => d.workspace_id);
  const txOwners = sql`SELECT DISTINCT workspace_id FROM (
    SELECT workspace_id FROM sending_emails WHERE ${queued} AND (snapshot->>'kind') = 'transactional'
      AND (scheduled_at IS NULL OR scheduled_at <= statement_timestamp()) AND ${available}
      ${deferredTx.length ? sql`AND NOT (workspace_id = ANY(${sql.param(deferredTx)}::text[]))` : sql``}
    ORDER BY created_at, id LIMIT ${limit}
  ) t`;
  const seek=(after:SQL)=>sql`SELECT workspace_id FROM (
    (SELECT workspace_id FROM sending_emails WHERE ${queued} AND scheduled_at IS NULL AND workspace_id>${after} ORDER BY workspace_id LIMIT 1) UNION ALL
    (SELECT workspace_id FROM sending_emails WHERE ${queued} AND scheduled_at<=statement_timestamp() AND workspace_id>${after} ORDER BY workspace_id LIMIT 1)
    ) heads ORDER BY workspace_id LIMIT 1`;
  const queuedOwners = priorityOnly ? sql`SELECT NULL::text AS workspace_id, 0 AS step WHERE false` : sql`SELECT n.workspace_id,1 FROM (${seek(sql`${gate.ownerCursor??''}`)}) n
      UNION ALL SELECT n.workspace_id,o.step+1 FROM queued_owners o CROSS JOIN LATERAL (${seek(sql`o.workspace_id`)}) n WHERE o.step<${limit}`;
  const allOwners = sql`SELECT workspace_id FROM tx_owners ${priorityOnly ? sql`` : sql`UNION SELECT workspace_id FROM queued_owners`}`;
  const txUnheld = sql`(NOT ${heldStream(sql`e`)})`;
  // Transactional has buckets of its own only where marketing paces at the full pool rate (owners.split_tx, migration 457).
  const split = sql`(o.split_tx AND ${txUnheld})`;
  const ownersSql = mx ? sql`SELECT q.workspace_id,hosted_marketing_held(q.workspace_id) AS marketing_held,${liveMx?sql`(pc.kind='shared' AND NOT w.exempt_hosted_quotas)`:sql`false`} AS customer ${liveMx?sql`,p.cap,p.tx_cap,coalesce(p.pool_paced AND g.key IS NULL,false) AS split_tx,p.cap-coalesce(bm.used,0) AS mkt_remaining,p.tx_cap-coalesce(bt.used,0) AS tx_remaining,g.cap-g.used AS growth_left,pc.kind='shared' AS required_screen,
    (${!!runtime.config.trustedPool} AND pc.pool_tier='trusted' AND NOT pc.legacy_names) AS trusted`:sql``}
    FROM all_owners q JOIN ${sendingConnections(runtime)} pc USING(workspace_id)
    ${liveMx?sql`LEFT JOIN workspaces w ON w.id=q.workspace_id
      LEFT JOIN hosted_burst_windows bm ON bm.workspace_id=q.workspace_id AND bm.scope='' AND bm.minute=${tick}
      LEFT JOIN hosted_burst_windows bt ON bt.workspace_id=q.workspace_id AND bt.scope='#tx' AND bt.minute=${tick}
      CROSS JOIN LATERAL (SELECT CASE WHEN pc.kind='shared' AND NOT w.exempt_hosted_quotas THEN hosted_minute_cap(q.workspace_id) END AS cap,
        CASE WHEN pc.kind='shared' AND NOT w.exempt_hosted_quotas THEN hosted_tx_minute_cap(q.workspace_id) END AS tx_cap,
        coalesce(pc.kind='shared' AND NOT w.exempt_hosted_quotas AND hosted_pool_paced(q.workspace_id),false) AS pool_paced) p
      -- A new sender's growth pace (sponsor-wide rolling hour): an owner it has used up is not leased, so nothing is prepared or screened for it.
      LEFT JOIN LATERAL hosted_growth(q.workspace_id) g ON pc.kind='shared'`:sql``}
    WHERE pc.region=${region} AND pc.aws_account_id=${accountId} AND pc.paused_at IS NULL AND hosted_sponsor_hold(q.workspace_id) IS DISTINCT FROM 'pause'
      ${liveMx?sql`AND (p.cap IS NULL OR p.cap-coalesce(bm.used,0)>0 OR (p.pool_paced AND g.key IS NULL AND p.tx_cap-coalesce(bt.used,0)>0)) AND (g.key IS NULL OR g.cap-g.used>0)`:sql``}` : sql`SELECT workspace_id,false AS marketing_held,false AS customer FROM all_owners`;
  const result = await runtime.db.execute<Record<string, unknown>>(sql`WITH RECURSIVE queued_owners(workspace_id,step) AS (${queuedOwners}), tx_owners AS (${txOwners}), all_owners AS (${allOwners}), owners AS MATERIALIZED (${ownersSql}), candidates AS (
      SELECT o.workspace_id, row_number() OVER (ORDER BY q.transactional DESC, q.turn, q.created_at, q.id) AS place FROM owners o CROSS JOIN LATERAL (
        SELECT p.*,row_number() OVER (ORDER BY transactional DESC,created_at,id) AS turn FROM (${page(sql`${limit}`)}) p
      ) q
    ), shares AS MATERIALIZED (
      SELECT workspace_id, count(*) AS candidates, count(*) FILTER (WHERE place <= ${limit}) AS slots, min(place) AS first_place
      FROM candidates GROUP BY workspace_id ORDER BY min(place)
    ), allocated AS MATERIALIZED (
      -- Allocate slots in priority order (transactional owners first, then round-robin marketing).
      -- Lock the next available rows in index order; later owners can fill slots skipped under contention.
      SELECT o.workspace_id, e.id FROM (SELECT o.*, sh.slots FROM owners o JOIN shares sh USING(workspace_id) WHERE sh.slots > 0 ORDER BY sh.first_place) o CROSS JOIN LATERAL (
        ${page(sql`o.slots`,true)}
      ) e LIMIT ${limit}
    ), picks AS (
      -- Consume the fair allocation first. A full lease skips the fallback; a short one only
      -- revisits owners with candidates beyond their share. Our own locks are not SKIPped.
      SELECT workspace_id, id FROM allocated UNION ALL
      SELECT o.workspace_id, e.id FROM (SELECT o.* FROM owners o JOIN shares sh USING(workspace_id) WHERE sh.candidates > sh.slots ORDER BY sh.first_place) o CROSS JOIN LATERAL (
        ${page(sql`${limit}`,true,sql`AND e.id NOT IN (SELECT id FROM allocated)`)}
      ) e LIMIT ${limit}
    ) ${liveMx ? sql`, fit AS MATERIALIZED (
      SELECT p.*,e.snapshot->>'kind' AS stream,${txUnheld} AS tx_unheld,
        CASE WHEN ${split} THEN o.tx_cap ELSE o.cap END AS eff_cap,
        CASE WHEN ${split} THEN o.tx_remaining ELSE o.mkt_remaining END AS eff_remaining,
        o.growth_left,d.used,c.n,
        sum(c.n) OVER (PARTITION BY p.workspace_id,${split} ORDER BY ${transactional} DESC,e.created_at,p.id) AS total,
        sum(c.n) OVER (PARTITION BY p.workspace_id,${split},${domain} ORDER BY ${transactional} DESC,e.created_at,p.id) AS subtotal,
        sum(c.n) OVER (PARTITION BY p.workspace_id ORDER BY ${transactional} DESC,e.created_at,p.id) AS growth_total
      FROM picks p JOIN owners o USING(workspace_id) JOIN sending_emails e USING(workspace_id,id)
      CROSS JOIN LATERAL (SELECT ${cost} AS n) c LEFT JOIN hosted_burst_windows d ON d.workspace_id=p.workspace_id AND d.scope=CASE WHEN ${split} THEN '#tx:'||${domain} ELSE ${domain} END AND d.minute=${tick}
      )`:sql``}, due AS MATERIALIZED (${liveMx ? sql`SELECT workspace_id,id FROM fit WHERE (growth_left IS NULL OR growth_total<=growth_left) AND (eff_cap IS NULL OR n=0 OR (total<=eff_remaining AND subtotal<=greatest(50,eff_cap/2)-coalesce(used,0)))` : sql`SELECT * FROM picks`}
    ), selected AS MATERIALIZED (
      UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes' FROM due WHERE e.workspace_id = due.workspace_id AND e.id = due.id RETURNING e.*
    ), settings AS MATERIALIZED (
      SELECT p.*, s.installation_id, s.default_region, s.enabled_regions, ${mx ? sql`to_jsonb(pc)` : sql`NULL`} AS connection,
        ${liveMx ? sql`${probationReason(sql`p.workspace_id`)} IS NOT NULL` : sql`false`} AS probation,
        (SELECT o.customer FROM owners o WHERE o.workspace_id=p.workspace_id) AS customer,
        ${readQuota ? sql`(SELECT jsonb_build_object('rate',max_send_rate,'max',max_24_hour_send,'sent',sent_last_24_hours,'customer',${accountId ? sql`customer_sent_24_hours` : sql`0`},'checked',checked_at::text,
          'age_ms',extract(epoch FROM clock_timestamp()-checked_at)*1000)
          FROM ${accountId ? sql`provider_account_limits WHERE aws_account_id=${accountId}` : sql`sending_region_limits WHERE workspace_id=p.workspace_id`}
          AND region=${region} AND max_send_rate>0 AND isfinite(checked_at))` : sql`NULL`} AS quota_sample,
        ${mx || isSimulatedSes(runtime) ? sql`true` : sql`(
        d.report->'provisioned' = 'true'::jsonb AND d.report #> '{account,sendingEnabled}' = 'true'::jsonb
        AND d.credentials_fingerprint = ${await credentialFingerprint(runtime.config)} AND d.public_url = ${discoveryTarget(runtime.config)}
        AND d.trusted_account_id = d.report #>> '{account,id}' AND d.trusted_topic_arn = d.report #>> '{resources,topic,arn}'
        AND d.report->'resources'->p.stream->'sendingEnabled' = 'true'::jsonb)`} AS ready
      FROM (SELECT DISTINCT workspace_id, snapshot->>'kind' AS stream FROM selected) p
      LEFT JOIN ses_installation_settings s USING (workspace_id)
      ${mx ? sql`JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id=p.workspace_id AND pc.region=${region} AND pc.aws_account_id=${accountId}` : !isSimulatedSes(runtime) ? sql`LEFT JOIN ses_region_discovery d ON d.workspace_id = p.workspace_id AND d.region = ${region}` : sql``}
    ), reviews AS (
      SELECT carrier, r.renderer_version, r.draft, r.rendered, r.screen, r.content_hash,
        (SELECT jsonb_agg(jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'filename',a.filename,'contentType',a.content_type,'size',a.size,
          'disposition',a.disposition,'contentId',a.content_id,'storageKey',a.storage_key,'checksum',a.checksum,'sourceTemplateAssetId',a.source_template_asset_id,'createdAt',a.created_at) ORDER BY a.id)
         FROM sending_attachments a WHERE a.workspace_id=r.workspace_id AND a.id IN (SELECT jsonb_array_elements_text(r.draft->'attachments'))) AS assets FROM (
        SELECT workspace_id, campaign_id, review_id, min(id) AS carrier FROM selected WHERE review_id IS NOT NULL GROUP BY 1,2,3
      ) refs JOIN sending_campaign_reviews r ON r.workspace_id=refs.workspace_id AND r.campaign_id=refs.campaign_id AND r.id=refs.review_id
    )
    SELECT meta.cursor,${liveMx?sql`(SELECT jsonb_agg(to_jsonb(blocked)) FROM (SELECT DISTINCT workspace_id,stream FROM fit WHERE eff_cap IS NOT NULL AND n>0 AND (coalesce(used,0)+n>greatest(50,eff_cap/2) OR eff_remaining<n OR (growth_left IS NOT NULL AND growth_left<n))) blocked)`:sql`NULL`} AS blocked_streams,${sql.join(mailColumns, sql`, `)}, measured.bytes AS snapshot_bytes, s.installation_id, s.default_region, s.enabled_regions, s.ready, s.connection,s.quota_sample,s.probation AS on_probation,s.customer AS outside,
      CASE WHEN leased.dispatch_version > 0 THEN (SELECT count(*)::int FROM sending_email_events v
        WHERE v.workspace_id=leased.workspace_id AND v.email_id=leased.id AND v.type='provider_throttled' AND v.data->>'code'='SES_THROTTLED') ELSE 0 END AS rate_retries,
      r.renderer_version AS review_version, r.draft AS review_draft, r.rendered AS review_rendered,r.assets AS review_assets, r.screen AS review_screen, r.content_hash AS review_hash,
      -- A campaign copy's recipient, looked up only for campaign mail: a join here let the planner scan the whole
      -- table's index for every leased row when its statistics said it was empty.
      CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.content_hash FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_content_hash,
      CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.recipient FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_recipient
    FROM selected leased
    CROSS JOIN LATERAL (SELECT octet_length(leased.snapshot::text) AS bytes OFFSET 0) measured
    JOIN settings s ON s.workspace_id = leased.workspace_id AND s.stream = leased.snapshot->>'kind'
    LEFT JOIN reviews r ON r.carrier = leased.id
    -- Keep the cursor only if an owner has queued mail after it: otherwise the next lease starts
    -- from the first owner instead of finding nothing past the last one.
    RIGHT JOIN (${priorityOnly ? sql`SELECT ${gate.ownerCursor ?? null}::text AS cursor` : sql`SELECT CASE WHEN EXISTS (${seek(sql`m.cursor`)}) THEN m.cursor END AS cursor
      FROM (SELECT max(workspace_id) FILTER(WHERE step=${limit}) AS cursor FROM queued_owners) m`}) meta ON true
    ORDER BY (leased.snapshot->>'kind' = 'transactional') DESC, leased.created_at, leased.id`);
  gate.ownerCursor=result.rows[0]?.cursor as string || undefined;
  for(const d of (result.rows[0]?.blocked_streams??[]) as DeferredStream[]) deferBurst(deferred,d.workspace_id,d.stream);
  if (!result.rows[0]?.id) return [];
  const owners = new Map<string, Owner>();
  const reviews = new Map<string, Pick<Review, 'version' | 'draft' | 'rendered' | 'assets' | 'screen' | 'reviewHash'>>();
  const reviewKey = (row: Record<string, unknown>) => JSON.stringify([row.workspaceId, row.campaignId, row.reviewId]);
  for (const row of result.rows) if (row.review_draft && row.review_rendered) {
    reviews.set(reviewKey(row), { version:Number(row.review_version), draft: row.review_draft as CampaignDraft, rendered: row.review_rendered as Review['rendered'],assets:(row.review_assets??[]) as AttachmentRow[], screen: row.review_screen as CampaignScreen | null, reviewHash: row.review_hash as string });
  }
  return result.rows.map(row => {
    const { review_version, review_draft, review_rendered, review_content_hash, review_recipient, review_screen, review_hash, installation_id, default_region, enabled_regions, ready:regionReady, connection, rate_retries, quota_sample, on_probation, outside, ...fields } = row;
    void review_version; void review_screen; void review_hash;
    // Admission refuses hosted sends until the tenant is ready; mail admitted earlier waits here, never provisions.
    const pc0 = connection as (ReadyConnection & { tenant_state?: TenantState; paused_at?: string | null }) | null;
    const ready = regionReady && !pc0?.paused_at && !(mx && !isSimulatedSes(runtime) && pc0?.kind === 'shared' && pc0.tenant_state !== 'ready');
    const mail = fields as Mail, { workspaceId } = mail;
    if (installation_id == null) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
    let owner = owners.get(workspaceId);
    if (!ready) {
      const stream = mail.snapshot.kind;
      if (!deferred.some(d => d.workspace_id === workspaceId && d.stream === stream)) {
        deferred.push({ workspace_id: workspaceId, stream });
        log('warn', { code: 'SES_SETUP_REQUIRED', workspaceId, region, stream });
      }
    } else if (!owner) {
      const pc = connection as (ReadyConnection & { feedback_topic_arn: string }) | undefined;
      const namespace=pc?.legacy_names===false ? pc.kind==='shared' ? pc.pool_tier : 'byo' : undefined;
      const { transactional, marketing } = setupResources(pc?.kind === 'shared' ? POOL_INSTALLATION : pc?.id ?? installation_id as string,namespace);
      const scoped = { ...runtime, config: { ...runtime.config, workspaceId, regions: [default_region as string, ...(enabled_regions as string[]).filter(r => r !== default_region),...(pc?[region]:[])], configurationSets: { transactional, marketing } } };
      owner = { runtime: scoped, trusted:runtime.config.trustedPool && pc?.pool_tier==='trusted' && pc.legacy_names===false, probation:on_probation===true, customer:outside===true, a: { workspaceId, keyId: 'worker', domains: [], permissions: ['manage'] }, transport, ses: transport.clientFor(scoped, region, forDelivery(pc,{purpose:'quota'}), runClients),
        sendClient:pc?.template_version==='v5'?domainId=>transport.clientFor(scoped,region,forDelivery(pc,{purpose:'send',domainId}),runClients):undefined,
        tenantName: pc?.kind === 'shared' ? pc.pool_tenant_name ?? (pc.managed_tenant ? mxResourceName(workspaceId) : `bane-${workspaceId}`) : undefined, feedbackTopic: pc?.feedback_topic_arn };
      owners.set(workspaceId, owner);
    }
    const shared = mail.reviewId && reviews.get(reviewKey(row));
    if(mail.snapshot.deferredCampaign) mail.snapshot={...mail.snapshot,from:mail.from,to:mail.to,cc:mail.cc,bcc:mail.bcc,region:mail.region,subject:mail.subject,attachments:shared?shared.draft.attachments:mail.snapshot.attachments??[],binding:shared?shared.draft.binding:mail.snapshot.binding};
    return { mail, contentBytes: Number(row.snapshot_bytes) > INLINE_SNAPSHOT_BYTES ? Number(row.snapshot_bytes) : 0, owner: ready ? owner! : null, rateRetries: Number(rate_retries), quota: quota_sample as LeaseQuota | undefined, review: shared && review_recipient ? { ...shared, contentHash: review_content_hash as string | null, recipient: review_recipient as ReviewedRecipient } : null, trace: { leasedAt: Date.now() } };
  });
}



type AttachmentRow = typeof attachments.$inferSelect;
function simpleContent(s: EmailSnapshot, parts: Attachment[]): SendEmailCommandInput['Content'] {
  return { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } };
}
function batchAttachments(runtime: Runtime, batch: Leased[]) {
  // Campaign metadata travels once per review in the lease (on its carrier row),
  // not once per envelope or in a second query per page. Bodies stay in storage.
  const reviewed=new Map(batch.filter(x=>x.review).map(x=>[x.mail.reviewId!,x.review!.assets]));
  const wanted = batch.filter(x=>!x.review).flatMap(({ mail }) => mail.snapshot.attachments.map(id => ({ workspace_id: mail.workspaceId, id })));
  let rows: Promise<AttachmentRow[]> | undefined;
  return async (mail: Mail) => {
    if (!mail.snapshot.attachments.length) return [];
    if(mail.reviewId && reviewed.has(mail.reviewId))return reviewed.get(mail.reviewId)!;
    rows ??= runtime.db.select().from(attachments).where(sql`(${attachments.workspaceId}, ${attachments.id}) IN (SELECT workspace_id, id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS x(workspace_id text, id text))`).orderBy(attachments.id).execute();
    return (await rows).filter(row => row.workspaceId === mail.workspaceId && mail.snapshot.attachments.includes(row.id));
  };
}
class HeldForScreen extends Error { constructor() { super('Queued without a screen verdict.'); this.name = 'HeldForScreen'; } }
async function prepareMail(leased: Leased & { owner: Owner }, loadAttachments: (mail: Mail) => Promise<AttachmentRow[]>): Promise<Prepared> {
  const { runtime, a } = leased.owner;
  let mail = leased.mail;
  if (mail.simulated && !isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'This message was queued for simulated delivery. Submit it again to send through SES.');
  const hosted=Boolean(leased.owner.tenantName && runtime.config.hostedScreen);
  // Mail queued before screen-at-accept (migration 459), or by an older isolate during the rollout, has no verdict. It never
  // goes out unscreened: it leaves the mail room's queue (screened = false) for the screen sweep.
  if (!isSimulatedSes(runtime) && (hosted || (mail.snapshot.screen && mail.snapshot.kind==='transactional')) && !mail.snapshot.screenVerdict) throw new HeldForScreen();
  let rows: AttachmentRow[] | undefined;
  let unsubscribe: Prepared['unsubscribe'];
  let stored: Prepared['stored'];
  if (mail.snapshot.deferredCampaign) {
    const materialized = await materializeCampaignEmail(runtime, a, mail, leased.review, await loadAttachments(mail));
    mail = materialized.mail; rows = materialized.rows; unsubscribe = materialized.unsubscribe; stored = materialized.stored;
  }
  let s = mail.snapshot;
  if(leased.owner.tenantName && s.raw) throw new ApiError(422,'SHARED_RAW_UNSUPPORTED','Hosted sending requires structured SES content.');
  // A mail app's signed or encrypted message goes out as written (protocol-submit.ts sealedPassthrough): on Hosted only
  // from a sender past its evaluation, since a probation sender's mail goes out as the copy the screen read.
  if(leased.owner.tenantName && s.mime && !leased.owner.trusted) throw new ApiError(422,'SEALED_MAIL_UNAVAILABLE','Signed and encrypted mail goes out as written, which a sender can do once its first messages are evaluated.');
  // Content screening runs at accept time / campaign prepare (src/sending.ts) before rows enter sending_emails; the mail
  // room never calls an external classifier. Deferred campaigns and any pre-deploy rows still apply local in-memory
  // hostedCopy / attachment checks here.
  const rules=isSimulatedSes(runtime) || !hosted || leased.owner.trusted ? null : leased.owner.probation ? 'probation' : 'standard';
  const delivery=rules ? await import('./screened-html.js') : undefined;
  if (delivery && (mail.snapshot.deferredCampaign || s.screenVerdict?.rules !== rules)) s = delivery.hostedCopy(s, rules==='probation');
  let parts: Attachment[] = [];
  rows ??= checkedDispatchAttachments(s.attachments, await loadAttachments(mail));
  const files: { row: AttachmentRow; bytes: Uint8Array }[] = [];
  for (const row of rows) {
    const body = await verifiedAttachment(runtime, row);
    files.push({ row, bytes: body });
    // A probation attachment goes out under a name a client shows as is, as a type its extension and bytes agree with;
    // any other sender's is checked only for pictures (no SVG, inline parts as raster images).
    if (rules==='standard') delivery!.shownAttachment(row.filename, row.contentType, body, row.disposition === 'inline');
    const { filename, contentType } = rules==='probation' ? delivery!.screenedAttachment(row.filename, row.contentType, body, row.disposition === 'inline') : row;
    parts.push({ FileName: filename, RawContent: body, ContentType: contentType, ContentDisposition: row.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(row.contentId ? { ContentId: row.contentId } : {}) });
  }
  // A campaign's mail, and its test, links its inline pictures from the host of its links (s.linkOrigin: the link domain on
  // Hosted, PUBLIC_URL without link hosts) rather than carrying them, after the checks above (src/linked-images.ts). Never
  // from Hosted's own domain (src/link-domains.ts never gives it one); without an origin they stay attached. An email sent
  // through the API keeps the parts its caller attached.
  const imageOrigin = s.linkOrigin && !(runtime.config.multiTenant && servedDomains.includes(new URL(s.linkOrigin).hostname)) ? s.linkOrigin : undefined;
  if (runtime.config.linkedImages && imageOrigin && s.html && !s.mime && !s.raw && (mail.campaignId || s.testCampaignId) && rows.some(row => row.disposition === 'inline')) {
    const { html, linked } = linkInlineImages(imageOrigin, s.html, files);
    if (linked.size) {
      // A test's pictures on the link domain: its use lets the link domain serve them (a campaign's release records its own).
      const host = new URL(imageOrigin).hostname;
      if (s.testCampaignId && host === runtime.config.linkHost) await (await import('./link-domains.js')).recordLinkUse(runtime.db, a.workspaceId, host, 0);
      s = { ...s, html };
      parts = parts.filter((_, i) => !linked.has(files[i]!.row.id));
      rows = rows.filter(row => !linked.has(row.id));
    }
  }
  sizeCheck(s, rows);
  const content: SendEmailCommandInput['Content'] = s.mime || s.raw
    ? { Raw: { Data: new TextEncoder().encode(s.mime ?? s.raw) } }
    // Inline images are built as multipart/related raw MIME (Simple places them beside the body). Raw MIME is
    // base64-encoded again inside SES's JSON body, about 3.2 times the files at once, so a message with more than the
    // lane budget of files goes as Simple content, as Hosted mail always does.
    : !leased.owner.tenantName && s.html && parts.some(part => part.ContentDisposition === 'INLINE') && rows.reduce((n, row) => n + row.size, 0) <= SEND_LIMITS.laneBytes
      ? { Raw: { Data: inlineMessage(s, parts) } }
      : simpleContent(s, parts);
  return { ...leased, mail, snapshot: s, content, unsubscribe, stored };
}

// Preflight failures (storage, rendering, hash mismatch) cannot have sent email: reject the row.
async function rejectPreflight(runtime: Runtime, mail: Mail, error: unknown): Promise<'deferred' | 'rejected'> {
  const code = error instanceof ApiError ? error.code : 'DISPATCH_PREFLIGHT_FAILED';
  const retryable = error instanceof ApiError ? error.retryable : true;
  if (retryable) {
    // Transient dependency failure (or unknown future content-hash format on rollback): keep the recipient queued
    // instead of rejecting/burning it. On CAMPAIGN_HASH_FORMAT_UNSUPPORTED, pause the parent campaign loudly too.
    const missing = code === 'ATTACHMENT_STORAGE_UNAVAILABLE';
    const unsupportedHash = code === 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED';
    const backoffSecs = unsupportedHash ? 60 : 15;
    const retry = await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = NULL, attachment_failures=attachment_failures+${missing?1:0}::smallint, scheduled_at = greatest(coalesce(scheduled_at, clock_timestamp()), clock_timestamp() + make_interval(secs => ${backoffSecs}::int)), error_code = ${code}, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} ${missing?sql`AND attachment_failures<4`:sql``}`);
    if (unsupportedHash && mail.campaignId) {
      const msg = error instanceof ApiError ? error.message : 'Paused: this campaign uses a newer content hash format that this release cannot verify.';
      await runtime.db.execute(pauseCampaign({ workspaceId: mail.workspaceId, id: mail.campaignId }, { code, message: msg })).catch(() => {});
    }
    if (!missing || retry.rowCount) { log('warn', { code, emailId: mail.id, message: 'Dispatch preflight failed; retrying after a short delay.' }); return 'deferred'; }
  }
  const rejected=await runtime.db.execute<{n:number}>(sql`WITH rejected AS (
      UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} RETURNING ${terminalColumns},to_addresses||cc_addresses||bcc_addresses AS recipients
    ), ${terminalEvents(sql`SELECT * FROM rejected`,sql`${JSON.stringify({providerCalled:false})}::jsonb`)} SELECT count(*)::int AS n FROM webhook_jobs`);
  await wakeWebhooks(runtime,rejected.rows[0]!.n);
  logError(error, { code, emailId: mail.id });
  if (mail.campaignId) await finishSettledCampaigns(runtime, [{ workspace_id: mail.workspaceId, campaign_id: mail.campaignId }]);
  return 'rejected';
}

type CampaignRef = { workspace_id: string; campaign_id: string };
// One statement moves every listed campaign whose last row has left the queue to done. It takes only the campaign
// rows (never email locks), after the statement that moved the rows, so it cannot deadlock with cancel or the run job.
async function finishSettledCampaigns(runtime: Runtime, refs: CampaignRef[]) {
  if (!refs.length) return;
  await runtime.db.execute(finishCampaigns(sql`SELECT workspace_id, campaign_id FROM jsonb_to_recordset(${JSON.stringify(refs)}::jsonb) AS r(workspace_id text, campaign_id text)`));
}

// OAuth grant decoding, original scopes and client/resource policy stay in the MCP verifier.
// All other origins are checked under the claim's locks, including permission/domain changes.
const mcpOrigin = (item: Prepared) => `${item.mail.workspaceId}\u0000${item.mail.actorKeyId}\u0000${!!item.mail.campaignId}\u0000${item.snapshot.from.split('@')[1]!.toLowerCase()}`;
async function originDecisions(prepared: Prepared[], db: DbExecutor) {
  const grants = new Map<string, boolean>();
  for (const item of prepared) if (item.mail.actorKeyId.startsWith('mcp_') && !grants.has(mcpOrigin(item))) {
    const runtime = item.owner.runtime;
    grants.set(mcpOrigin(item), await originAllowed(runtime, db, { ...item.mail, snapshot: item.snapshot }));
  }
  return grants;
}

// One statement elects every row in the group: key revocation under FOR SHARE, consent locks, campaign
// cancellation, unsubscribe tokens and attempt events. Rows flip queued → attempting here, so the group
// is kept to the provider in-flight width: a platform reset can only strand what was actually mid-call.
// Campaign rows are shared-locked before their email rows (cancel and the run job take the campaign row
// first too); the campaign itself is never written here, so concurrent shards never serialize on it.
async function claimGroup(runtime: Runtime, prepared: Prepared[], origins: Map<string, boolean>, db: DbExecutor) {
  const input = prepared.map(item => ({
    id: item.mail.id, workspace_id: item.mail.workspaceId, dispatch_version: item.mail.dispatchVersion, status: 'queued', campaign_id: item.mail.campaignId,
    actor_key_id: item.mail.actorKeyId, sender: item.snapshot.from.toLowerCase(), mcp_allowed: item.mail.actorKeyId.startsWith('mcp_') && origins.get(mcpOrigin(item)) === true,
    feedback_topic: item.owner.feedbackTopic, binding:item.review?.draft.binding ?? item.mail.snapshot.binding, destinations: [...item.snapshot.to, ...item.snapshot.cc, ...item.snapshot.bcc].map(email => email.toLowerCase()),
    hosted:!!item.owner.tenantName,marketing: item.snapshot.kind === 'marketing', notice: item.review?.draft.requiredNotice === true, held_stream: item.snapshot.kind !== 'transactional' || !!item.mail.campaignId || !!item.snapshot.bulk, reply_authors: item.snapshot.replyAuthors, snapshot: item.stored ?? null,
    token_hash: item.unsubscribe?.tokenHash ?? null, token_email: item.unsubscribe?.email ?? null, token_page: item.unsubscribe?.page ?? null,
    event_id: rowId('event'), external_id: `attempt-start:${item.mail.id}:${item.mail.dispatchVersion}`, attempt: item.mail.dispatchVersion + 1,
  }));
  const rows = sql`SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(id text, workspace_id text, dispatch_version int, status text, campaign_id text, actor_key_id text, sender text, mcp_allowed boolean, hosted boolean, feedback_topic text, binding jsonb, destinations jsonb, marketing boolean, notice boolean, held_stream boolean, reply_authors jsonb, snapshot jsonb, token_hash text, token_email text, token_page text, event_id text, external_id text, attempt int)`;
  const claimed = await db.execute<{ id: string; status: EmailStatus; webhooks:number }>(sql`WITH ${claimCtes(runtime, prepared[0]!.mail.region, rows)} SELECT id,status,(SELECT count(*)::int FROM webhook_jobs) AS webhooks FROM claimed`);
  return {statuses:new Map(claimed.rows.map(row => [row.id, row.status])),webhooks:claimed.rows[0]?.webhooks??0};
}
/**
 * A forward's email is sent only while its endpoint is still a confirmed, unpaused forward and every approval behind it
 * is active. It share-locks the forward-once row, then the endpoint row, so a decline or an edit committing now is either
 * seen or waits for this decision. `x` has id, workspace_id and actor_key_id.
 */
export function forwardStillAllowed(runtime: Pick<Runtime, 'config'>, x: SQL) {
  return sql`EXISTS (
    SELECT FROM mail_forward_once f JOIN mailbox_webhooks h ON h.workspace_id=f.workspace_id AND h.id=f.endpoint
    WHERE f.email_id=${x}.id AND f.workspace_id=${x}.workspace_id AND ${x}.actor_key_id='forward:'||f.endpoint AND h.type='forward'
    AND h.verified AND h.declined_at IS NULL AND NOT h.paused AND NOT EXISTS(SELECT FROM jsonb_array_elements_text(f.grants) gid WHERE NOT mail_receiving_grant(f.workspace_id,gid,${receivingPolicy(runtime.config)}::jsonb))
    FOR SHARE OF f, h)`;
}
function claimCtes(runtime: Runtime, region: string, input: SQL) {
  return sql`input AS MATERIALIZED (${input}
    ), key_state AS MATERIALIZED (
      SELECT id, workspace_id, permissions, domains FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        AND (workspace_id, id) IN (SELECT workspace_id, actor_key_id FROM input)
        AND ${tieAllows(runtime.config, sql`workspace_id`, sql`id`, 'api_key')} FOR SHARE
    ), campaign_state AS MATERIALIZED (
      SELECT id, workspace_id, state FROM sending_campaigns WHERE (workspace_id, id) IN (SELECT workspace_id, campaign_id FROM input WHERE campaign_id IS NOT NULL) FOR SHARE
    ), dest AS (
      SELECT x.id AS email_id, x.workspace_id, d.value AS email, d.n FROM input x, jsonb_array_elements_text(x.destinations) WITH ORDINALITY d(value,n)
    ), consent AS MATERIALIZED (
      SELECT workspace_id, email, suppressed, suppression_reason, deleted_at, marketing_consent FROM audience_contacts
      WHERE (workspace_id, email) IN (SELECT workspace_id, email FROM dest)
      ORDER BY workspace_id,email FOR UPDATE
    ), ${runtime.config.multiTenant ? sql`sponsor_state AS MATERIALIZED (
      -- A sponsor's full pause holds every stream of its other workspaces (migration 231 hosted_sponsor_hold): share-lock
      -- the sibling connections, in id order and before the election's own connection row, so a pause committing now is
      -- seen; a restrict reaches dispatch through hosted_marketing_held. Exempt workspaces neither inherit nor pass it on.
      SELECT me.id AS workspace_id,sp.paused_at IS NOT NULL AND sp.resume_pending_at IS NULL AS paused
      FROM workspaces me JOIN workspaces o ON o.quota_sponsor=me.quota_sponsor AND o.id<>me.id AND NOT o.exempt_hosted_quotas
      JOIN provider_connections sp ON sp.workspace_id=o.id AND sp.kind='shared'
      WHERE me.id IN (SELECT workspace_id FROM input) AND me.quota_sponsor IS NOT NULL AND NOT me.exempt_hosted_quotas ORDER BY sp.id FOR SHARE OF sp
    ), ` : sql``}pinned_routes AS MATERIALIZED (
      ${runtime.config.multiTenant ? sql`SELECT keys.*,r.* FROM (SELECT DISTINCT workspace_id,split_part(sender,'@',2) AS host FROM input WHERE binding IS NOT NULL) keys
        CROSS JOIN LATERAL ${regionalSender(runtime,claimsOnly,sql`keys.workspace_id`,sql`keys.host`)} r` : sql`SELECT 1`}
    ), eligibility AS MATERIALIZED (
      SELECT x.id,
        CASE WHEN starts_with(x.actor_key_id, 'mcp_') THEN x.mcp_allowed
          WHEN starts_with(x.actor_key_id,'forward:') THEN ${forwardStillAllowed(runtime, sql`x`)}
          -- An owner notice (sendSystemEmail): only from the configured platform workspace, about a committed standing event.
          WHEN starts_with(x.actor_key_id, 'standing:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM standing_events s WHERE s.id=substr(x.actor_key_id,10))
          -- A billing owner notice (billing/notify.ts): the same, about a committed billing_notices row.
          WHEN starts_with(x.actor_key_id, 'billing:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM billing_notices n WHERE n.id=substr(x.actor_key_id,9))
          -- An account notice (account-notices.ts): the same, about a committed account_notices row.
          WHEN starts_with(x.actor_key_id, 'notice:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM account_notices n WHERE n.id=substr(x.actor_key_id,8))
          WHEN starts_with(x.actor_key_id, 'user_') THEN EXISTS (${approvedOriginUser(runtime, sql`x.workspace_id`, sql`substr(x.actor_key_id, 6)`, sql`x.campaign_id IS NULL`)})
          WHEN starts_with(x.actor_key_id, 'app_') THEN EXISTS (
            SELECT FROM (${principal(runtime, 'smtp', sql`p.id=x.actor_key_id AND b.workspace_id=x.workspace_id`)} FOR SHARE OF p,b) a
            JOIN mailbox_addresses addr ON addr.workspace_id=a.w AND addr.mailbox_id=a.b AND addr.address=x.sender FOR SHARE OF addr)
          WHEN starts_with(x.actor_key_id, 'mbk_') THEN EXISTS (
            SELECT 1 FROM mailbox_keys k JOIN mailbox_addresses b ON b.workspace_id = k.workspace_id AND b.address = x.sender
            WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND k.permissions ? 'send'
              AND mail_key_grant_allows(k.workspace_id,k.id,'key',${receivingPolicy(runtime.config)}::jsonb)
              AND (k.mailbox_ids IS NULL OR k.mailbox_ids ? b.mailbox_id) FOR SHARE OF k, b)
          ELSE EXISTS (SELECT 1 FROM key_state k WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id
            AND (k.permissions ? 'manage' OR k.permissions ? 'send') AND (k.domains = '[]'::jsonb OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(k.domains) d WHERE split_part(x.sender, '@', 2) = lower(d.value)
                OR right(split_part(x.sender, '@', 2), length(d.value) + 1) = '.' || lower(d.value)))) END
          AS origin_ok,
        ${runtime.config.multiTenant ? sql`CASE WHEN x.binding IS NULL THEN ${verifiedClaim(sql`x.workspace_id`, sql`${region}`, sql`split_part(x.sender, '@', 2)`)} ELSE EXISTS (
          SELECT 1 FROM pinned_routes r WHERE r.workspace_id=x.workspace_id AND r.host=split_part(x.sender,'@',2) AND r.region=${region} AND r.verified AND r.binding=x.binding
            AND r.connection IS NOT NULL AND r.connection->>'paused_at' IS NULL AND (r.connection->>'kind'='byo' OR ${isSimulatedSes(runtime)} OR r.connection->>'tenant_state'='ready')
            AND r.connection->>'feedback_topic_arn' IS NOT DISTINCT FROM x.feedback_topic) END` : sql`true`} AS binding_ok,
        (x.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_state c WHERE c.workspace_id = x.workspace_id AND c.id = x.campaign_id AND c.state <> 'canceled')) AS campaign_allowed,
         -- A required notice (src/sending.ts requiredNotice) skips only the marketing consent checks: it still never goes
         -- to a suppressed address or a deleted contact.
         (SELECT cause.reason FROM dest d LEFT JOIN consent c USING (workspace_id,email)
          CROSS JOIN LATERAL (SELECT CASE
            WHEN x.marketing AND NOT x.notice AND c.marketing_consent='unsubscribed' THEN 'unsubscribed'
            WHEN c.suppressed AND NOT coalesce(NOT x.marketing AND c.suppression_reason='email_validation'
              AND c.marketing_consent<>'unsubscribed' AND x.reply_authors ? d.email,false) THEN coalesce(c.suppression_reason,'suppressed')
            WHEN x.marketing AND (c.deleted_at IS NOT NULL OR (x.notice AND c.email IS NULL)) THEN 'contact_deleted'
            WHEN x.marketing AND NOT x.notice AND c.marketing_consent IS DISTINCT FROM 'subscribed' THEN 'consent_missing' END AS reason) cause
          WHERE d.email_id=x.id AND cause.reason IS NOT NULL ORDER BY d.n LIMIT 1) AS suppression_reason
      FROM input x
    ), budget AS MATERIALIZED (SELECT x.id,${runtime.config.multiTenant && !isSimulatedSes(runtime) ? sql`CASE WHEN x.hosted AND el.origin_ok AND el.binding_ok AND el.campaign_allowed AND el.suppression_reason IS NULL
        THEN hosted_burst_ok(x.workspace_id,split_part(x.sender,'@',2),jsonb_array_length(x.destinations),NOT x.held_stream) ELSE true END` : sql`true`} AS allowed
      FROM input x JOIN eligibility el USING(id) ORDER BY x.workspace_id,x.sender,x.id), claimed AS (
      UPDATE sending_emails e SET simulated = ${isSimulatedSes(runtime)},
        status = CASE WHEN NOT b.allowed THEN 'queued' WHEN NOT el.origin_ok OR NOT el.binding_ok OR NOT el.campaign_allowed THEN 'canceled' WHEN el.suppression_reason IS NULL THEN 'attempting' ELSE 'suppressed' END,
        scheduled_at=CASE WHEN NOT b.allowed THEN date_trunc('minute',statement_timestamp())+interval '1 minute' ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN b.allowed AND el.origin_ok AND el.binding_ok AND el.campaign_allowed AND el.suppression_reason IS NULL THEN clock_timestamp() ELSE e.attempt_started_at END,
        error_code = CASE WHEN NOT b.allowed THEN 'HOSTED_BURST_LIMIT' WHEN NOT el.binding_ok AND x.binding IS NOT NULL THEN 'SENDER_BINDING_CHANGED' WHEN NOT el.origin_ok OR NOT el.binding_ok THEN 'ORIGIN_KEY_REVOKED' WHEN NOT el.campaign_allowed THEN 'CAMPAIGN_CANCELED' WHEN el.suppression_reason IS NULL THEN nullif(e.error_code,'HOSTED_BURST_LIMIT') ELSE 'RECIPIENT_INELIGIBLE' END,
        suppression_reason = CASE WHEN el.origin_ok AND el.binding_ok AND el.campaign_allowed THEN el.suppression_reason END,
        ${runtime.config.multiTenant && !isSimulatedSes(runtime) ? sql`feedback_topic_arn=x.feedback_topic,` : sql``} snapshot = CASE WHEN b.allowed THEN coalesce(x.snapshot, e.snapshot) ELSE e.snapshot END, lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN eligibility el ON el.id = x.id JOIN budget b ON b.id=x.id
      -- e.status is compared with x.status ('queued' in every input row), never a literal, so sending_emails has no condition
      -- of its own: the planner reaches it only by primary key from each input row, since any other way reads the whole
      -- table. With a literal it could scan a queued-only partial index instead, and when the statistics were taken while
      -- nothing was queued it did: every queued row for each batch, the hold check for each pair (20,000 rows, 5 seconds).
      WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.status = x.status AND e.dispatch_version = x.dispatch_version
        ${runtime.config.multiTenant ? sql`AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.workspace_id=x.workspace_id AND pc.paused_at IS NULL
          AND NOT (x.held_stream AND hosted_marketing_held(x.workspace_id)) FOR SHARE)
          AND NOT EXISTS (SELECT 1 FROM sponsor_state ss WHERE ss.workspace_id=x.workspace_id AND ss.paused)` : sql``}
      RETURNING e.id,e.workspace_id,e.status,e.region,e.simulated,e.error_code,e.suppression_reason,e.dispatch_version
    ), token AS (
      INSERT INTO operation_unsubscribe_tokens(token_hash, workspace_id, email, page_url)
      SELECT x.token_hash, c.workspace_id, x.token_email, x.token_page FROM claimed c JOIN input x ON x.id = c.id WHERE x.token_hash IS NOT NULL AND c.status = 'attempting'
      ON CONFLICT DO NOTHING
    ), attempt AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, external_id, simulated, data, created_at)
      SELECT x.event_id, c.workspace_id, c.id, 'dispatch_attempt', x.external_id, ${isSimulatedSes(runtime)}::boolean,
        jsonb_build_object('attempt', x.attempt, 'providerCallPlanned', true, 'providerCallSimulated', ${isSimulatedSes(runtime)}::boolean), clock_timestamp()
      FROM claimed c JOIN input x ON x.id = c.id WHERE c.status = 'attempting' ON CONFLICT DO NOTHING
    ), ${terminalEvents(sql`SELECT * FROM claimed WHERE status IN ('suppressed','canceled')`)}`;
}

function redactDenial(runtime: Runtime, failure: { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } }) {
  const denial = failure.name === 'AccessDeniedException' && typeof failure.message === 'string' ? failure.message.slice(0, 8192) : '';
  const deniedAction = denial.match(/not authorized to perform(?::\s*|\s+['"])([a-z0-9-]+:[A-Za-z0-9]+)\b/)?.[1];
  const deniedResource = denial.match(/on resource:\s*(arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9_+=,.@/*:-]{1,512}|\*)(?=\s|$)/)?.[1]?.replace(/[A-Za-z0-9_+=,.%-]+@/g, '[redacted]@');
  const awsRequestId = typeof failure.$metadata?.requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(failure.$metadata.requestId) ? failure.$metadata.requestId : undefined;
  const denialMessage = [runtime.config.aws?.accessKeyId, runtime.config.aws?.secretAccessKey, runtime.config.aws?.sessionToken]
    .reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted credential]') : text, denial)
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g, '[redacted email]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted access key]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|secret|password|credential|signature|authorization)\s*[:=]\s*\S+)/gi, '[redacted credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
  return { denial, diagnostics: { ...(awsRequestId ? { awsRequestId } : {}), ...(deniedAction ? { deniedAction } : {}), ...(deniedResource ? { deniedResource } : {}), ...(denialMessage ? { denialMessage } : {}) } };
}

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
    if (status === 429 && providerRetries < 5) {
      return { mail, type: 'provider_throttled', errorCode: 'SES_THROTTLED', data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 }, requeueAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** providerRetries)).toISOString() };
    }
    return definitive
      ? { mail, type: 'reject', errorCode: failure.name ?? 'SES_REJECTED', data: { code: failure.name ?? 'SES_REJECTED', retryable: false, ...diagnostics } }
      : { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_ACCEPTANCE_UNKNOWN', retryable: false, ...diagnostics } };
  }
}

// One statement records every provider outcome in the batch: attempt-result events, monotonic
// status, public events, webhook deliveries, throttled requeues and (test) simulated feedback.
async function recordOutcomes(runtime: Runtime, outcomes: Outcome[]) {
  if (!outcomes.length) return;
  const simulated = isSimulatedSes(runtime);
  const input = outcomes.map(o => ({
    email_id: o.mail.id, workspace_id: o.mail.workspaceId, dispatch_version: o.mail.dispatchVersion, type: o.type, provider_id: o.providerId ?? null,
    event_id: rowId('event'), external_id: `attempt-result:${o.mail.id}:${o.mail.dispatchVersion}`, data: o.type === 'acceptance_unknown' ? {...o.data,status:o.type} : o.data, error_code: o.errorCode ?? null,
    next_status: requeued(o) ? 'queued' : statusForEvent[o.type] ?? null,
    next_rank: requeued(o) ? 0 : rank[statusForEvent[o.type]!], public_type: publicEventType[o.type] ?? null,
    outcome_bit: o.type === 'accepted' ? 1 : o.type === 'reject' ? 64 : 0,
    wait_ms: o.requeueAt ? Math.max(0, Date.parse(o.requeueAt) - Date.now()) : null,
  }));
  const statement = sql`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(email_id text, workspace_id text, dispatch_version int, type text, provider_id text, event_id text, external_id text, data jsonb, error_code text, next_status text, next_rank int, public_type text, outcome_bit int, wait_ms float8)
    ), mail AS MATERIALIZED (
      SELECT e.id, e.workspace_id, e.status, e.error_code, e.region, e.dispatch_version FROM sending_emails e JOIN input x ON e.workspace_id = x.workspace_id AND e.id = x.email_id
      ORDER BY e.id FOR UPDATE
    ), inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at)
      SELECT x.event_id, m.workspace_id, m.id, x.type, x.provider_id, x.external_id, x.data, ${simulated}::boolean, clock_timestamp()
      FROM input x JOIN mail m ON m.id = x.email_id ORDER BY m.workspace_id,m.id ON CONFLICT DO NOTHING RETURNING *
    ), updated AS (
      UPDATE sending_emails e SET
        status = x.next_status, provider_id = coalesce(x.provider_id, e.provider_id),
        event_outcomes = e.event_outcomes | x.outcome_bit::smallint,
        error_code = CASE WHEN x.next_status='queued' THEN x.error_code WHEN x.type = 'accepted' AND e.error_code IN ('SES_DAILY_QUOTA_EXHAUSTED','SES_ACCOUNT_SENDING_PAUSED','SES_CREDENTIALS_INVALID','INTERRUPTED_PROVIDER_ATTEMPT') THEN NULL ELSE coalesce(x.error_code, e.error_code) END,
        account_pause_started_at = CASE WHEN x.error_code='SES_ACCOUNT_SENDING_PAUSED' THEN coalesce(e.account_pause_started_at,clock_timestamp()) END,
        dispatch_version = CASE WHEN x.next_status = 'queued' THEN e.dispatch_version + 1 ELSE e.dispatch_version END,
        scheduled_at = CASE WHEN x.next_status = 'queued' THEN clock_timestamp() + x.wait_ms * interval '1 millisecond' ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN x.next_status = 'queued' THEN NULL ELSE e.attempt_started_at END,
        lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN inserted i ON i.email_id = x.email_id JOIN mail m ON m.id = x.email_id
      WHERE e.workspace_id = x.workspace_id AND e.id = x.email_id AND e.dispatch_version = x.dispatch_version
        AND ((x.next_status = 'queued' AND (m.status IN ('queued','attempting') OR (m.status='acceptance_unknown' AND m.error_code='INTERRUPTED_PROVIDER_ATTEMPT')))
          OR (x.next_status <> 'queued' AND x.next_rank >= (${rankJson()}::jsonb ->> m.status)::int))
      RETURNING e.id, e.workspace_id, e.campaign_id, (m.status='acceptance_unknown' AND e.status='queued') AS recovered
    ), reopened AS (${reopenQueuedCampaigns(sql`SELECT workspace_id,campaign_id FROM updated WHERE recovered AND campaign_id IS NOT NULL`)}), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT i.id, i.workspace_id, x.public_type, m.region, i.created_at,
        x.data || jsonb_build_object('emailId', m.id, 'simulated', ${simulated}::boolean) || CASE WHEN x.provider_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('providerId', x.provider_id) END
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), deliveries AS (
      INSERT INTO operation_deliveries(id, workspace_id, webhook_id, event_id, payload)
      SELECT public.row_id('whd'), p.workspace_id, w.id, p.id,
        jsonb_build_object('id', p.id, 'workspaceId', p.workspace_id, 'type', p.type, 'region', p.region, 'createdAt', p.created_at, 'data', p.data)
      FROM published p JOIN operation_webhooks w ON w.workspace_id = p.workspace_id
      WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
      ON CONFLICT DO NOTHING RETURNING id, workspace_id
    ), webhook_jobs AS (
      INSERT INTO jobs(id, workspace_id, type, payload)
      SELECT public.row_id('job'), workspace_id, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
    ), simulated_callbacks AS (
      SELECT 'urn:bane:simulated-ses:' || m.region AS topic_arn, m.id || ':' || kind AS message_id, i.workspace_id, m.region, x.provider_id,
        i.created_at + CASE WHEN kind = 'Delivery' THEN ${runtime.config.simulatedSes.deliveryDelayMs}::int ELSE 0 END * interval '1 millisecond' AS created_at, kind
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id, unnest(ARRAY['Send','Delivery']) kind
      WHERE ${simulated && !runtime.feedback}::boolean AND x.type = 'accepted' AND x.provider_id LIKE 'sim\\_%'
    ), simulated_jobs AS (
      INSERT INTO jobs(id, workspace_id, type, available_at, payload)
      SELECT public.row_id('job'), r.workspace_id, 'operation.simulatedFeedback', r.created_at,
        jsonb_build_object('topicArn', r.topic_arn, 'messageId', r.message_id, 'region', r.region,
          'message', jsonb_build_object('eventType', r.kind, 'mail', jsonb_build_object('messageId', r.provider_id), lower(r.kind), jsonb_build_object('timestamp', r.created_at)))
      FROM simulated_callbacks r RETURNING id
    ) SELECT (SELECT count(*) FROM inserted)::int AS events, (SELECT count(*) FROM updated)::int AS updated, (SELECT count(*) FROM webhook_jobs)::int AS webhooks, (SELECT count(*) FROM simulated_jobs)::int AS simulated`;
  // Retry only the fenced, external-id-deduplicated write. Never reacquire a send slot or call SES again.
  let readyJobs: number;
  for (let attempt=0; ; attempt++) {
    try { readyJobs = (await runtime.db.execute<{webhooks:number}>(statement)).rows[0]!.webhooks; break; }
    catch (error) {
      const conflict = databaseConflict(error), transient = !conflict && transientDatabaseError(error);
      if (!conflict && !transient) throw error;
      if (attempt>=3) {
        if (!conflict || outcomes.length===1) throw error;
        // A repeatedly contended mixed write must not strand its neighbors. Keep one
        // writer per run, and attempt the second half even if the first cannot settle.
        const mid=Math.ceil(outcomes.length/2);
        try { await recordOutcomes(runtime,outcomes.slice(0,mid)); }
        finally { await recordOutcomes(runtime,outcomes.slice(mid)); }
        return;
      }
      const baseMs = transient ? 100 : 10;
      await sleep((baseMs + Math.random() * baseMs) * 2 ** attempt);
    }
  }
  if (readyJobs > 0) try { await runtime.wake?.(readyJobs, 'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  // With a feedback sink, simulated Send/Delivery callbacks travel the same queue live SNS feedback does.
  if (simulated && runtime.feedback) {
    const recorded = new Date().toISOString();
    await queueSimulatedFeedback(runtime, outcomes.filter(o => o.type === 'accepted' && o.providerId?.startsWith('sim_')).map(o => ({ emailId: o.mail.id, region: o.mail.region, providerId: o.providerId!, createdAt: recorded })));
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
      if (!await lane.refresh) { for (const item of ready) logEmail(lane, item.mail, item.trace, 'deferred', 'SES_QUOTA_UNKNOWN'); await releaseLeases(base, ready.map(item => item.mail)); return { processed: 0, blocked: true }; }
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
  const loadAttachments = batchAttachments(base, ready);
  const unscreened: Mail[] = [], linkWaiting: Mail[] = [];
  const prepare = async (item: typeof ready[number]) => {
    try {
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
  return { processed: ready.length, blocked: false };
}
const logLost = (count:number) => log('warn', { code:'DISPATCH_CLAIM_LOST', count, message:'Rows changed between lease and claim; they will be reconsidered on the next pass.' });
function deferBurst(deferred:DeferredStream[],workspace_id:string,stream:DeferredStream['stream']) {
  if(!deferred.some(d=>d.workspace_id===workspace_id && d.stream===stream)) deferred.push({workspace_id,stream,until:(Math.floor(Date.now()/60000)+1)*60000});
}
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
/** Reorders a batch so transactional rows always stay ahead of marketing, and within each stream owners alternate
 *  round-robin (preserving each owner's FIFO order). When a mid-batch stop or pacing cutoff returns later chunks of
 *  `sendConcurrency`, both sent and returned chunks stay balanced across concurrent campaigns. */
export function interleaveByOwner<T>(items: readonly T[], kindOf: (item: T) => EmailSnapshot['kind'], ownerOf: (item: T) => string, offset = 0): T[] {
  if (items.length <= 1) return items.slice();
  const roundRobin = (stream: T[]) => {
    if (stream.length <= 1) return stream;
    const byOwner = new Map<string, T[]>();
    for (const item of stream) {
      const id = ownerOf(item);
      let list = byOwner.get(id);
      if (!list) { list = []; byOwner.set(id, list); }
      list.push(item);
    }
    if (byOwner.size <= 1) return stream;
    const queues = [...byOwner.values()];
    const shift = ((offset % queues.length) + queues.length) % queues.length;
    if (shift) queues.push(...queues.splice(0, shift));
    const out: T[] = [];
    for (let i = 0; out.length < stream.length; i++) {
      for (const q of queues) if (i < q.length) out.push(q[i]!);
    }
    return out;
  };
  const tx: T[] = [], mkt: T[] = [];
  for (const item of items) (kindOf(item) === 'transactional' ? tx : mkt).push(item);
  return [...roundRobin(tx), ...roundRobin(mkt)];
}
async function dispatchPrepared(base: Runtime, lane: Lane, prepared: Prepared[]) {
  if (!prepared.length) return;
  const {gate, options, counters, phase} = lane;
  const pendingRecords: Promise<void>[] = [];
  const delayed: Mail[] = [], unpaced: Mail[] = [];
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
    let webhooks=0;
    const claim = async (items: Prepared[], db: DbExecutor) => {
      const result=await claimGroup(base,items,checkMcp ? await originDecisions(items,db) : new Map(),db); webhooks=result.webhooks; return result.statuses;
    };
    const statuses = await phase('claim', () => checkMcp ? base.db.transaction(tx => claim(group, tx)) : claim(group, base.db));
    lane.advanced += group.length;
    if (webhooks) pendingRecords.push(wakeWebhooks(base,webhooks));
    for(const item of group) if(statuses.get(item.mail.id)==='queued') { deferBurst(lane.deferred,item.mail.workspaceId,item.snapshot.kind); logEmail(lane, item.mail, item.trace, 'deferred', 'HOSTED_BURST_LIMIT'); }
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
  if (paceUntil >= Date.now() + MAX_PRE_SEND_MS) { counters.paceRetryAt = Math.ceil(paceUntil); counters.idle = true; }
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
