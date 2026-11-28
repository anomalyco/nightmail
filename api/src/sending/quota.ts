import { sql, getTableColumns } from 'drizzle-orm';
import type { SESv2Client, SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { lazyModule, wrapModuleLoad, ApiError, logError } from '../core/errors.js';
import { isSimulatedSes, preloadSesTransport } from '../core/ses.js';
import { log } from '../log.js';
import type { Runtime, Actor } from '../core/types.js';
import { emails, type CampaignDraft, type ReviewedRecipient, type EmailSnapshot } from '../db/sending.js';
import { rank } from './events.js';
import { customerCredits, QUOTA_REFRESH_MS, sesDailyReserve } from './schemas.js';
import { sendingConnections } from '../domain-claims.js';
import { type ReadyConnection, forDelivery } from '../provider-credentials.js';
import { shareFullAlert } from '../operator-alerts.js';
import type { CampaignScreen } from '../screen.js';
import type { DispatcherOptions } from './dispatcher.js';
import type { AttachmentRow } from './claim.js';

const loadSesv2 = lazyModule(() => import('@aws-sdk/client-sesv2'));
const loadSimulatedSes = lazyModule(() => import('../adapters/simulated-ses.js'));

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
export type Review = { version:number; draft: CampaignDraft; rendered: { html?: string; text?: string }; assets:AttachmentRow[]; contentHash: string | null; recipient: ReviewedRecipient; screen?: CampaignScreen | null; reviewHash?: string };
// `probation`: a Hosted sender still in its evaluation, growth pace or below good standing (src/hosted-sending.ts probationReason).
// `customer`: an outside workspace on the shared account (Hosted, live, not exempt), whose marketing waits for the customer share.
export type Owner = { runtime: Runtime; a: Actor; ses: SESv2Client; transport: DispatchTransport; sendClient?:(domainId:string)=>SESv2Client; poolTier?: string | null; legacyNames?: boolean | null; probation?:boolean; customer?: boolean; tenantName?: string; feedbackTopic?: string };
export type LeaseQuota = { rate: number; max: number; sent: number; customer: number; checked: string; age_ms: number };
/** Where one email's time goes in a run, filled in stage by stage for its DISPATCH_EMAIL line (logEmail). */
export type Trace = { leasedAt: number; shard?: number; paceMs?: number; sesMs?: number };
export type Leased = { mail: Mail; contentBytes: number; review: Review | null; owner: Owner | null; rateRetries: number; quota?: LeaseQuota; trace: Trace };
export type Prepared = Leased & { owner: Owner; snapshot: EmailSnapshot; content: SendEmailCommandInput['Content']; unsubscribe?: { tokenHash: string; email: string; page?: string }; stored?: Partial<EmailSnapshot> };
export type Outcome = { mail: Mail; type: 'accepted' | 'reject' | 'acceptance_unknown' | 'provider_throttled' | 'dispatch_deferred'; providerId?: string; errorCode?: string; data: Record<string, unknown>; requeueAt?: string; trace?: Trace };
export const requeued = (o: Outcome) => o.type === 'provider_throttled' || o.type === 'dispatch_deferred';

// customerSent: what outside workspaces on a shared account used of its daily limit (migration 401), read with the sample.
export interface QuotaSnapshot { maxSendRate: number; max24HourSend: number; sentLast24Hours: number; customerSent?: number; checkedAt: number }
// Serializable pacing state so a Durable Object survives eviction without bursting.
export interface GateState { nextAllowedAt: number; txAllowedAt?: number; marketingAllowedAt?: number; quota: QuotaSnapshot | null; refreshAt?: number; sentSinceRefresh: number; brakeUntil?: number; marketingBrakeUntil?: number; recentTxUntil?: number; accountPauseAt?:number; outageUntil?: number; outageStreak?: number; storageUntil?: number; storageStreak?: number; dailyBlockedUntil?: number; ownerCursor?: string }
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
export const txReadyAt = (gate: GateState, now: number) => Math.max(gate.txAllowedAt ?? 0, (gate.brakeUntil ?? 0) > now ? gate.nextAllowedAt : 0);
export const mktReadyAt = (gate: GateState) => Math.max(gate.nextAllowedAt, gate.marketingAllowedAt ?? 0);
const BRAKE_MS = 10000;
// SES gave no usable answer (transport error, timeout, 5xx, or no MessageId): an ambiguous call is never replayed, so stop starting new
// calls instead of turning every queued email into acceptance_unknown. Doubles while SES stays silent.
export const OUTAGE_MS = 15000, OUTAGE_MAX_MS = 300000;
// Object storage threw on a read (R2 or S3 down, not a missing object): the shard's attachment mail waits together, from
// 15 s doubling to 5 min, jittered, instead of every row retrying alone every 15 s.
export const STORAGE_MS = 15000, STORAGE_MAX_MS = 300000;
// SES per-second throttling: from 2 s doubling to 5 min, jittered. It never rejects accepted mail: the account is busy, not refusing it.
export const THROTTLE_MS = 2000, THROTTLE_MAX_MS = 300000;
/** ±25% of ms, never past capMs, so work that failed together does not come back together. At the cap the waits spread
 *  over its last quarter instead of piling on it (as retryDelay does, src/ritual-retry.ts). */
export const jittered = (ms: number, capMs: number) => {
  const lo = Math.min(0.75 * ms, 0.75 * capMs), hi = Math.min(1.25 * ms, capMs);
  return Math.round(lo + (hi - lo) * Math.random());
};
// The quota refresher's election fence: long enough for one GetAccount, short enough that a failed one only delays the
// next try. A sample that publishes extends it to the refresh period.
const QUOTA_ELECTION_MS = 10000;
// A refresh that fails keeps pacing on the previous sample while it is this young, and tries again this soon.
export const QUOTA_STALE_MS = 5 * 60000, QUOTA_RETRY_MS = 5000;
// A claim waits at most this long for a row another transaction holds (lock_timeout), then gives its group back to the queue.
export const CLAIM_LOCK_MS = 1000, CLAIM_BUSY_MS = 5000;
// Far below interrupted-attempt recovery (3 min) and the queue lease (2 min). Ordinary groups
// can share a claim, but an unsent item never waits behind a long envelope or priority flood.
export const MAX_PRE_SEND_MS = 5000;

// Timestamps are cast to text so raw rows match Drizzle's string-mode timestamp columns.
// The lease carries routing/claim metadata, not a batch of multi-MiB bodies. Use the
// logical size: pg_column_size can report the much smaller compressed TOAST value.
export const INLINE_SNAPSHOT_BYTES = 64 * 1024;
const contentFields = sql`ARRAY['text','html','raw','mime','template']`;
export const mailColumns = Object.entries(getTableColumns(emails)).map(([key, column]) => key === 'snapshot'
  ? sql`CASE WHEN measured.bytes > ${INLINE_SNAPSHOT_BYTES} THEN leased.snapshot - ${contentFields} ELSE leased.snapshot END AS snapshot`
  : sql`leased.${sql.identifier(column.name)}${column.columnType.startsWith('PgTimestamp') ? sql`::text` : sql``} AS ${sql.identifier(key)}`);
let rankJsonCache: string | undefined;
export const rankJson = () => rankJsonCache ??= JSON.stringify(rank);

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function fetchQuota(transport: DispatchTransport, ses: SESv2Client, gate: GateState): Promise<QuotaSnapshot> {
  const account = await ses.send(new transport.GetAccountCommand({})), quota = account.SendQuota;
  if (account.SendingEnabled) delete gate.accountPauseAt;
  if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.MaxSendRate <= 0 || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
  return { maxSendRate: quota.MaxSendRate, max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours, checkedAt: Date.now() };
}
// checkedAt identifies the sample on the database clock; refreshAt is a deadline on this host.
// Re-reading the same snapshot (including after restoring an old gate) cannot mint more capacity.
export function observeQuota(gate: GateState, sample: QuotaSnapshot, refreshMs: number, ageMs = 0) {
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
// Elect the refresher BEFORE GetAccount, across all DOs/lanes for this account. The election holds a short fence
// (QUOTA_ELECTION_MS): a failed or interrupted fetch delays the next try by that much, not by a whole cache period. A
// published sample extends it to the period. No DB lock is held over AWS I/O.
export async function ensureQuota(owner: Pick<Owner, 'runtime'|'ses'|'transport'> & { a: Pick<Actor, 'workspaceId'> }, account: string | undefined, region: string, gate: GateState, refreshMs: number) {
  const { runtime, ses, a, transport } = owner;
  const table = sql.identifier(account ? 'provider_account_limits' : 'sending_region_limits');
  const subject = sql.identifier(account ? 'aws_account_id' : 'workspace_id'), fence = sql.identifier(account ? 'refresh_after' : 'next_allowed_at');
  const key = sql`${subject}=${account ?? a.workspaceId} AND region=${region}`;
  if (account) refreshMs = Math.max(1000, refreshMs);
  const period = sql`(${refreshMs}::int * interval '1 millisecond')`, election = sql`(${Math.min(refreshMs, QUOTA_ELECTION_MS)}::int * interval '1 millisecond')`;
  type Row = { fence: string | null; checked: string; rate: number; max: number; sent: number; customer: number; age_ms: number };
  const customer = account ? sql`customer_sent_24_hours` : sql`0::float8`;
  const cached = sql`SELECT NULL::text AS fence, checked_at::text AS checked, max_send_rate AS rate, max_24_hour_send AS max, sent_last_24_hours AS sent, ${customer} AS customer, extract(epoch FROM clock_timestamp()-checked_at)::float8*1000 AS age_ms
    FROM ${table} WHERE ${key} AND max_send_rate > 0 AND checked_at > clock_timestamp()-${period}`;
  const result = await runtime.db.execute<Row>(sql`WITH elected AS (
    INSERT INTO ${table}(${subject},region,${fence}) VALUES (${account ?? a.workspaceId},${region},clock_timestamp()+${election})
    ON CONFLICT (${subject},region) DO UPDATE SET ${fence}=clock_timestamp()+${election}
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
 *  (core/ses.ts assertSharedAccount), and a runtime scoped to the region (core/ses.ts region()). Quota and deliverability reads. */
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
    gate.marketingBrakeUntil = Math.max(gate.marketingBrakeUntil ?? 0, now + BRAKE_MS);
    gate.marketingAllowedAt = Math.max(gate.marketingAllowedAt ?? 0, now + 1000);
    return;
  }
  gate.brakeUntil = Math.max(gate.brakeUntil ?? 0, now + BRAKE_MS);
  gate.marketingBrakeUntil = Math.max(gate.marketingBrakeUntil ?? 0, now + BRAKE_MS);
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
// `share`: an outside workspace's marketing also fits in what is left of the customer share (src/sending/schemas.ts customerCredits).
const marketingCredits = (q: QuotaSnapshot, percent: number, share?: number) => Math.max(0, Math.min(q.max24HourSend - q.sentLast24Hours - sesDailyReserve(q.max24HourSend, percent),
  share === undefined ? Infinity : customerCredits(q.max24HourSend, q.customerSent ?? 0, share)));
export function dailyRemaining(gate: GateState, headroomPercent?: number, shard?: DispatcherOptions['shard'], share?: number) {
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
