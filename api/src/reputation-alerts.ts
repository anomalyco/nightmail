import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError, lazyModule, log, type JobHandler, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { sesSettings } from './db/ses-regions.js';
import { enqueue, JobDeferred, retryDatabaseFailures } from './jobs.js';
import { productName } from './brand.js';
import { mentionFor, sendMentioned } from './operator-mention.js';

// SES console thresholds. "Near" alerts fire at 80% of a threshold.
const THRESHOLDS = { bounceRate: { warning: 0.05, risk: 0.1 }, complaintRate: { warning: 0.001, risk: 0.005 } } as const;
const NEAR = 0.8;
const LEVELS = ['ok', 'near_warning', 'warning', 'near_risk', 'at_risk'] as const;
type Metric = keyof typeof THRESHOLDS;
type Level = typeof LEVELS[number];
const JOB = 'reputation.alert';

// Boundaries for each level above ok, lowest first.
function boundaries(metric: Metric) {
  const { warning, risk } = THRESHOLDS[metric];
  return [warning * NEAR, warning, risk * NEAR, risk];
}
function levelFor(metric: Metric, value: number): Level {
  return LEVELS[boundaries(metric).filter(boundary => value >= boundary).length]!;
}
// Anti-flapping: dropping a level requires falling 10% below that level's boundary.
const HYSTERESIS = 0.9;
function nextLevel(metric: Metric, value: number, previous: Level): Level {
  const raw = levelFor(metric, value), from = LEVELS.indexOf(previous);
  if (LEVELS.indexOf(raw) >= from) return raw;
  const bounds = boundaries(metric);
  let index = from;
  while (index > 0 && value < bounds[index - 1]! * HYSTERESIS) index--;
  return LEVELS[index]!;
}
// Escalations past the highest level alerted in the last 24 hours send immediately. Anything
// else waits 6 hours after the previous message and never repeats a level sent in the last day.
const COOLDOWN_MS = 6 * 3600_000;
const DAY_MS = 24 * 3600_000;

/**
 * Hourly: compares each region's latest SES reputation rates with the last alerted level and
 * queues one Slack alert per change; a region's first reading records its level and posts only at FIRST_SIGHT_POSTS or
 * above. The alert jobs are the dedupe ledger (a level recorded without a card is a completed job); completed jobs expire
 * after 30 days, so a sustained elevated level re-alerts at most monthly. A per-metric advisory
 * lock keeps overlapping checks from queueing the same alert twice.
 */
const loadReputationDeps = lazyModule(() => Promise.all([import('@aws-sdk/client-cloudwatch'), import('@smithy/fetch-http-handler'), import('./ses-setup.js')]));
export async function checkReputationAlerts(runtime: Runtime): Promise<number> {
  if (!runtime.config.reputationAlertUrl || !runtime.config.aws || !runtime.config.liveEnabled) return 0;
  // CloudWatch rates still describe one provider account. Read each region once, but keep alert ledgers per workspace.
  // Hosted, that account is the platform's, the same for every workspace (each has a settings row), so each region has
  // one ledger, the installation's: one per workspace would post the same card once for each of them.
  const settings = await runtime.db.select({ workspaceId: sesSettings.workspaceId, regions: sesSettings.enabledRegions }).from(sesSettings);
  const regions = new Set(settings.flatMap(row => row.regions));
  if (!regions.size) return 0;
  const owners = runtime.config.multiTenant ? [{ workspaceId: runtime.config.workspaceId, regions: [...regions] }] : settings;
  const [{ CloudWatchClient }, { FetchHttpHandler }, { readReputation }] = await loadReputationDeps();
  let queued = 0;
  for (const region of regions) {
    const cw = new CloudWatchClient({ region, credentials: runtime.config.aws, maxAttempts: 1, requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }) });
    try {
      const reputation = await readReputation(cw, AbortSignal.timeout(20000));
      if (!reputation.available) { log('warn', { code: 'REPUTATION_ALERT_SKIPPED', region, message: reputation.reason }); continue; }
      for (const metric of Object.keys(THRESHOLDS) as Metric[]) {
        const value = reputation[metric];
        if (value == null) continue;
        for (const owner of owners) if (owner.regions.includes(region) && await queueIfChanged(runtime, owner.workspaceId, region, metric, value)) queued++;
      }
    } finally { cw.destroy(); }
  }
  return queued;
}

/** Pure alert decision. `history` is newest first. Returns null when no message should be sent. */
export function decideAlert(metric: Metric, value: number, history: { level: Level; at: number }[], now: number): { level: Level; previous: Level } | null {
  const previous = history[0]?.level ?? 'ok';
  const next = nextLevel(metric, value, previous);
  if (next === previous) return null;
  const lastDay = history.filter(entry => now - entry.at < DAY_MS)
  // Escalating past anything alerted in the last day always sends.
  if (LEVELS.indexOf(next) > Math.max(-1, ...lastDay.map(entry => LEVELS.indexOf(entry.level)))) return { level: next, previous };
  // Otherwise wait out the cooldown, and never repeat a level already sent in the last day.
  if (history[0] && now - history[0].at < COOLDOWN_MS) return null;
  if (lastDay.some(entry => entry.level === next)) return null;
  return { level: next, previous };
}

/**
 * The first sight of a region's rate (nothing recorded for it: the day this shipped, or 30 days on with no card) records
 * its level without a card, unless the level is FIRST_SIGHT_POSTS or above: Amazon's own warning line (5% bounces, 0.1%
 * complaints), where it puts the account under review. A person must know that whenever it is first seen; a rate merely
 * near a line on the first day is not news, and its next change posts as any change does.
 */
export const FIRST_SIGHT_POSTS: Level = 'warning';
async function queueIfChanged(runtime: Runtime, workspaceId: string, region: string, metric: Metric, value: number) {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${JOB}:${workspaceId}:${region}:${metric}`}))`);
    // An alert whose delivery failed was never seen: leaving it out lets the next hourly check raise the level again.
    const recent = await tx.select({ payload: jobs.payload, createdAt: jobs.createdAt }).from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, JOB), sql`${jobs.payload}->>'region' = ${region}`, sql`${jobs.payload}->>'metric' = ${metric}`, sql`${jobs.status} <> 'failed'`))
      .orderBy(desc(jobs.createdAt)).limit(24);
    const history = recent.map(row => ({ level: (LEVELS as readonly string[]).includes(String(row.payload.level)) ? row.payload.level as Level : 'ok' as Level, at: Date.parse(row.createdAt), silent: row.payload.silent === true }));
    // A level recorded without a card: a completed job that is never posted, kept in the same ledger.
    const record = (level: Level, previous: Level) => tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload,status)
      VALUES (public.row_id('job'),${JOB},${workspaceId},${JSON.stringify({ region, metric, level, previous, value, silent: true })}::jsonb,'completed')`);
    if (!history.length) {
      const level = levelFor(metric, value);
      if (LEVELS.indexOf(level) < LEVELS.indexOf(FIRST_SIGHT_POSTS)) { await record(level, 'ok'); return false; }
      await enqueue(tx, { type: JOB, workspaceId, payload: { region, metric, level, previous: 'ok', value } });
      return true;
    }
    const decision = decideAlert(metric, value, history, Date.now());
    if (!decision) return false;
    // A fall from a level only recorded is recorded too: "back to normal" from a level nobody was told of says nothing.
    if (history[0]!.silent && LEVELS.indexOf(decision.level) < LEVELS.indexOf(decision.previous)) { await record(decision.level, decision.previous); return false; }
    await enqueue(tx, { type: JOB, workspaceId, payload: { region, metric, ...decision, value } });
    return true;
  });
}

const names: Record<Metric, string> = { bounceRate: 'Bounce rate', complaintRate: 'Complaint rate' };
const risingText: Record<Level, string> = { ok: 'back to normal', near_warning: 'nearing warning', warning: 'at warning', near_risk: 'nearing at-risk', at_risk: 'at risk' };
const fallingText: Record<Level, string> = { ok: 'back to normal', near_warning: 'below warning, still close', warning: 'below at-risk, still at warning', near_risk: 'below at-risk, still close', at_risk: 'at risk' };
const emoji: Record<Level, string> = { ok: ':white_check_mark:', near_warning: ':large_yellow_circle:', warning: ':warning:', near_risk: ':red_circle:', at_risk: ':rotating_light:' };
const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;

export function reputationAlertText(input: { region: string; metric: Metric; level: Level; previous: Level; value: number; publicUrl: string }) {
  const { warning, risk } = THRESHOLDS[input.metric];
  const rising = LEVELS.indexOf(input.level) > LEVELS.indexOf(input.previous);
  const title = `${emoji[input.level]} *${names[input.metric]} ${(rising ? risingText : fallingText)[input.level]}* · ${input.region}`;
  return `${title}\n${percent(input.value)} now  ·  warning ${percent(warning)}  ·  at risk ${percent(risk)}\n<${input.publicUrl}/settings?region=${encodeURIComponent(input.region)}|View in ${productName}>`;
}

/** The Slack message for one job, as it has always looked: plain text with its own emoji and link. */
function reputationMessage(runtime: Runtime, payload: Record<string, unknown>, workspaceId: string): { text: string } {
  if (payload.code === 'SES_IDENTITY_QUOTA_EXHAUSTED') return { text: `SES identity quota exhausted in ${payload.region}. Request regional identity capacity before onboarding more domains.` };
  if (payload.code === 'HOSTED_EXEMPT_OVER_LINE') return { text: exemptAlertText({ ...payload, workspaceId }, runtime.config.publicUrl) };
  if (payload.code === 'SES_TENANT_PAUSED') return { text: tenantPausedText({ ...payload, workspaceId }, runtime.config.publicUrl) };
  if (payload.code === 'BUILTIN_PARENT_TRIPPED') return { text: builtinTrippedText(payload) };
  if (payload.code === 'BUILTIN_WORKSPACE_OVER_LINE') return { text: builtinWorkspaceText(payload, workspaceId, runtime.config.publicUrl) };
  const { region, metric, level, previous, value } = payload;
  if (typeof region !== 'string' || !(metric === 'bounceRate' || metric === 'complaintRate') || !LEVELS.includes(level as Level) || !LEVELS.includes(previous as Level) || typeof value !== 'number') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid reputation alert job.');
  return { text: reputationAlertText({ region, metric, level: level as Level, previous: previous as Level, value, publicUrl: runtime.config.publicUrl }) };
}

/**
 * Posts one card. To its own webhook (REPUTATION_ALERT_SLACK_URL), as it always has: a refused or unanswered post throws
 * and the job retries. Falling back to the operator channel (config.ts, hosted), deliverToOperators: "AWS paused an SES
 * tenant" is left out there, since "Amazon paused" (operator-alerts.ts) already says it in that channel.
 */
const deliver: JobHandler = async (runtime, payload, job) => {
  const url = runtime.config.reputationAlertUrl;
  if (!url) return;
  const operators = url === runtime.config.operatorSlackWebhookUrl;
  if (operators && payload.code === 'SES_TENANT_PAUSED') return;
  const message = reputationMessage(runtime, payload, job.workspaceId);
  if (!operators) return postSlack(url, message);
  await deliverToOperators(runtime, url, payload, job, message);
};

/**
 * A card's lane in the operator channel. Each lane posts at most one card in any rolling hour (OPERATORS_LANE_MS), so the
 * channel gets at most two level cards a region (bounces, complaints), one each of built-in domains stopping and of one
 * workspace over the built-in line, one first-party workspace over a line and one identity quota card: 2 a region + 4.
 */
export const operatorLane = (payload: Record<string, unknown>) => payload.code === 'BUILTIN_PARENT_TRIPPED' ? `builtin-stopped:${payload.parent}`
  : payload.code === 'BUILTIN_WORKSPACE_OVER_LINE' ? `builtin-workspace:${payload.parent}` : payload.code === 'HOSTED_EXEMPT_OVER_LINE' ? 'first-party'
  : payload.code === 'SES_IDENTITY_QUOTA_EXHAUSTED' ? 'identity-quota' : typeof payload.code === 'string' ? payload.code : `level:${payload.region}:${payload.metric}`;
const OPERATORS_LANE_MS = 3_600_000;
/** An unanswered post is tried once more after this; there is never a third (abuse-alerts.ts, the same rule). */
const AFTER_TIMEOUT_MS = 5 * 60_000;
/** How long a card may wait for Slack's 429s to clear (rateLimitWait's left), from when it was queued. */
const FRESH_S = 86_400;
/** Where a card's delivery to the operator channel stands, kept in its job's payload. */
type Delivery = { lane: string; postedAt?: string | null; posting?: boolean; unanswered?: number; limited?: number; unconfirmed?: boolean };
/**
 * Posts a card to the operator channel with the abuse alerts' delivery guarantees (abuse-alerts.ts deliver):
 * - its lane's place first (operatorLane): with a card of the same lane posted in the last hour it waits for an hour
 *   after that one (JobDeferred, no try spent), never dropped;
 * - a 429 gives the place back and waits (rateLimitWait, no try spent);
 * - unanswered (no answer in postSlack's 10 seconds; Slack may have taken it): it keeps its place and is tried once more
 *   after AFTER_TIMEOUT_MS, and a second unanswered post is the last (unconfirmed). A post whose answer was never
 *   recorded (its worker stopped after sending) counts as unanswered, so it is posted at most twice, ever;
 * - refused or unreachable: the place goes back and the job retries as any job (jobs.ts), its last try failing it,
 *   which Health counts;
 * - "Built-in domains stopped sending" mentions the operator (operator-mention.ts builtin_tripped, inside the six an hour),
 *   once for the trip, its job.
 */
async function deliverToOperators(runtime: Runtime, url: string, payload: Record<string, unknown>, job: { id: string }, message: { text: string }) {
  const lane = operatorLane(payload);
  const save = async (db: Pick<Runtime['db'], 'execute'>, delivery: Delivery) => {
    payload.delivery = delivery;
    await db.execute(sql`UPDATE jobs SET payload=jsonb_set(payload,'{delivery}',${JSON.stringify(delivery)}::jsonb) WHERE id=${job.id}`);
  };
  type Turn = { post: Delivery & { unanswered: number }; left: number } | { wait: string } | null;
  const turn = await runtime.db.transaction(async (tx): Promise<Turn> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('reputation.operators',0))`);
    const { rows: [row] } = await tx.execute<{ delivery: Delivery | null; left: number; now: string }>(sql`SELECT payload->'delivery' AS delivery,
      extract(epoch FROM created_at+make_interval(secs=>${FRESH_S})-now())::float8 AS left,now()::text AS now FROM jobs WHERE id=${job.id} FOR UPDATE`);
    const was: Delivery = row?.delivery ?? { lane };
    const unanswered = (was.unanswered ?? 0) + (was.posting ? 1 : 0);
    if (unanswered >= 2) {
      await save(tx, { ...was, lane, posting: false, unanswered, unconfirmed: true });
      log('warn', { code: 'REPUTATION_ALERT_UNCONFIRMED', lane }); return null;
    }
    const { rows: [taken] } = await tx.execute<{ wait: number | null }>(sql`SELECT extract(epoch FROM min((payload->'delivery'->>'postedAt')::timestamptz)+make_interval(secs=>${OPERATORS_LANE_MS / 1000})-now())::float8 AS wait FROM jobs
      WHERE type=${JOB} AND id<>${job.id} AND created_at>now()-interval '2 days' AND payload->'delivery'->>'lane'=${lane}
        AND (payload->'delivery'->>'postedAt')::timestamptz>now()-make_interval(secs=>${OPERATORS_LANE_MS / 1000})`);
    if (taken?.wait != null) return { wait: new Date(Date.now() + Math.max(0, taken.wait) * 1000 + 1000).toISOString() };
    const post = { ...was, lane, posting: true, unanswered, postedAt: row?.now ?? new Date().toISOString() };
    await save(tx, post);
    return { post, left: row?.left ?? FRESH_S };
  });
  if (!turn) return;
  if ('wait' in turn) { log('info', { code: 'REPUTATION_ALERT_WAITING', lane, until: turn.wait }); throw new JobDeferred(turn.wait, undefined, true); }
  const mention = payload.code === 'BUILTIN_PARENT_TRIPPED' ? await mentionFor(runtime, { id: job.id, kind: 'builtin_tripped', subject: String(payload.parent ?? '') }) : null;
  try { await sendMentioned(runtime, card => postSlack(url, card, 'REPUTATION_ALERT_FAILED'), message, mention, job.id); }
  catch (error) {
    if (!(error instanceof ApiError) && error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      const unanswered = turn.post.unanswered + 1, last = unanswered >= 2;
      await save(runtime.db, { ...turn.post, posting: false, unanswered, limited: 0, ...(last ? { unconfirmed: true } : {}) });
      log('warn', { code: last ? 'REPUTATION_ALERT_UNCONFIRMED' : 'REPUTATION_ALERT_TIMEOUT', lane });
      if (!last) throw new JobDeferred(new Date(Date.now() + AFTER_TIMEOUT_MS).toISOString(), undefined, true);
      return;
    }
    const refused = error instanceof SlackRefused ? error : null;
    if (refused?.status === 429) {
      const limited = (turn.post.limited ?? 0) + 1, wait = rateLimitWait(refused.retryAfterSeconds, limited, turn.left);
      await save(runtime.db, { ...turn.post, posting: false, postedAt: null, limited });
      log('warn', { code: 'REPUTATION_ALERT_LIMITED', lane, limited, wait: Math.round(wait) });
      throw new JobDeferred(new Date(Date.now() + wait * 1000).toISOString(), undefined, true);
    }
    await save(runtime.db, { ...turn.post, posting: false, postedAt: null, limited: 0 });
    throw error instanceof ApiError ? error : new ApiError(503, 'REPUTATION_ALERT_FAILED', 'The alert could not be posted; it will be retried.', undefined, true);
  }
  await save(runtime.db, { ...turn.post, posting: false, limited: 0 });
}
/**
 * Posts one message to a Slack incoming webhook (these alerts, src/operator-alerts.ts and src/health.ts). It never follows a redirect,
 * so the message goes to the configured webhook only; a refusal throws a retryable error, and so does a timeout
 * (retryDatabaseFailures), so the job that posts it runs again. Neither the URL nor the message is logged.
 */
/** Slack answered a post, but not with a 2xx: its status, and for a 429 how many seconds it asked us to wait (retryAfterSeconds, from Retry-After). */
export class SlackRefused extends ApiError {
  constructor(code: string, readonly status: number, retryAfter: number | null) {
    super(503, code, `Slack rejected the alert with HTTP ${status}.`, undefined, true);
    if (retryAfter !== null) this.retryAfterSeconds = retryAfter;
  }
}
/** Retry-After as seconds from now: a number of seconds or an HTTP date (IMF-fixdate); null when absent or anything else. */
const retryAfter = (header: string | null) => {
  const value = header?.trim() ?? '';
  const seconds = /^\d+$/.test(value) ? Number(value) : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? (Date.parse(value) - Date.now()) / 1000 : NaN;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : null;
};
/**
 * How long a 429 makes a card wait (abuse-alerts.ts explains the rule, #1014): limited is its 429s in a row (this one
 * included), left the seconds until it would be stale. Never under RATE_LIMIT_FLOOR_S, doubling up to RATE_LIMIT_CAP_S,
 * longer when Retry-After asks for more, never past left.
 */
const RATE_LIMIT_FLOOR_S = 30, RATE_LIMIT_CAP_S = 15 * 60;
export const rateLimitWait = (retryAfter: number | undefined, limited: number, left: number) =>
  Math.max(1, Math.min(Math.max(retryAfter ?? 0, Math.min(RATE_LIMIT_FLOOR_S * 2 ** Math.max(0, limited - 1), RATE_LIMIT_CAP_S)), left));
/** Posts a message to a Slack webhook. No answer within timeoutMs rejects with fetch's TimeoutError: Slack may have taken it. */
export async function postSlack(url: string, message: Record<string, unknown>, code = 'REPUTATION_ALERT_FAILED', timeoutMs = 10000) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  await response.body?.cancel();
  if (!response.ok) throw new SlackRefused(code, response.status, response.status === 429 ? retryAfter(response.headers.get('retry-after')) : null);
}
const lineText: Record<string, string> = { complaints: 'spam complaints', screen: 'content-screen rejections', bounces: 'hard bounces' };
/** A first-party (exempt) workspace crossed a pause line: Nightmail did not hold it, so a person has to look. */
export function exemptAlertText(p: Record<string, unknown>, publicUrl: string) {
  const n = (v: unknown) => Number(v ?? 0).toLocaleString('en-US');
  return `:rotating_light: *First-party workspace over the ${lineText[String(p.line)] ?? 'reputation'} line* · ${String(p.workspaceId ?? '')}\n`
    + `${n(p.bounces)} hard bounces and ${n(p.complaints)} complaints on ${n(p.sends)} sends; ${n(p.rejected)} of ${n(p.screened)} screened rejected. `
    + `${productName} did not ${p.scope === 'all' ? 'pause its sending' : 'hold its marketing'}: the workspace is exempt. Review it now; only an operator pauses it.\n<${operatorPage(publicUrl, p.workspaceId)}|Open it in ${productName}>`;
}
const operatorPage = (publicUrl: string, wid: unknown) => `${publicUrl.replace(/\/$/, '')}/operator/workspaces/${encodeURIComponent(String(wid ?? ''))}`;
/** AWS paused a workspace's SES tenant: sending stops whatever Nightmail decides, so a person has to look now. */
export function tenantPausedText(p: Record<string, unknown>, publicUrl: string) {
  return `:rotating_light: *AWS paused an SES tenant*${p.exempt ? ' of a first-party (exempt) workspace' : ''} · ${String(p.workspaceId ?? '')}\n`
    + `${String(p.tenant ?? '')}: ${String(p.cause ?? 'no cause given')}. ${productName} paused the workspace to match; only an operator resumes it, after AWS reinstates the tenant.\n<${operatorPage(publicUrl, p.workspaceId)}|Open it in ${productName}>`;
}
const builtinCount = (v: unknown) => Number(v ?? 0).toLocaleString('en-US');
const builtinShare = (part: unknown, whole: unknown) => `${percent(Number(part ?? 0) / Math.max(1, Number(whole ?? 0)))} (${builtinCount(part)} of ${builtinCount(whole)})`;
const builtinLine = (line: unknown) => line === 'complaints' ? 'spam complaints' : 'permanent bounces';
/** The built-in domains' circuit breaker tripped (builtin-domain.ts builtinBreaker): every one stopped sending until a person resets it. */
export function builtinTrippedText(p: Record<string, unknown>) {
  return `:rotating_light: *Built-in domains stopped sending: too many ${builtinLine(p.line)}* · ${String(p.parent ?? '')}\n`
    + `Permanent bounces ${builtinShare(p.bounces, p.recipients)}, complaints ${builtinShare(p.complaints, p.recipients)} over the last ${builtinCount(p.windowHours)} hours, still over the line without the workspace with the most (${String(p.worst ?? '')}); SES warns at 5% and 0.1%. `
    + `Sending is paused for ${builtinCount(p.paused)} built-in ${Number(p.paused) === 1 ? 'domain' : 'domains'} and their queued mail is canceled; receiving continues. It stays paused until an operator finds the cause (revoke the senders behind it) and runs `
    + '`node --import tsx scripts/builtin-domain.ts reset-breaker --apply --reason "…"`.';
}
/** One workspace's built-in mail alone puts all built-in mail over a line: the breaker didn't trip, a person decides about it. */
export function builtinWorkspaceText(p: Record<string, unknown>, workspaceId: string, publicUrl: string) {
  const w = (p.workspace ?? {}) as Record<string, unknown>, line = p.line === 'complaints' ? 'complaints' : 'bounces';
  return `:warning: *One workspace puts built-in mail over the line: too many ${builtinLine(p.line)}* · ${workspaceId}\n`
    + `It has ${builtinCount(w[line])} of the ${builtinCount(p[line])} ${builtinLine(p.line)} on ${builtinCount(w.recipients)} of ${builtinCount(p.recipients)} recipients of all built-in mail in the last ${builtinCount(p.windowHours)} hours. `
    + `Without it, built-in mail is under SES's 5% and 0.1%, so built-in domains keep sending. If it's abuse, revoke its built-in domain: `
    + `\`node --import tsx scripts/builtin-domain.ts revoke ${workspaceId} --apply --reason "…"\`\n<${operatorPage(publicUrl, workspaceId)}|Open it in ${productName}>`;
}
// A storage hiccup or a timed-out post retries like other background work instead of losing the alert on its first failure.
export const reputationAlertJobs = { [JOB]: retryDatabaseFailures(deliver) };
