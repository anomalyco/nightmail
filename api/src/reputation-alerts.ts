import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError, lazyModule } from './core/errors.js';
import { log } from './log.js';
import type { JobHandler, Runtime } from './core/types.js';
import { jobs } from './db/core.js';
import { sesSettings } from './db/ses-regions.js';
import { enqueue, retryDatabaseFailures } from './jobs.js';
import { productName } from './brand.js';

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
 * queues one Slack alert per change. The alert jobs are the dedupe ledger; completed jobs expire
 * after 30 days, so a sustained elevated level re-alerts at most monthly. A per-metric advisory
 * lock keeps overlapping checks from queueing the same alert twice.
 */
const loadReputationDeps = lazyModule(() => Promise.all([import('@aws-sdk/client-cloudwatch'), import('@smithy/fetch-http-handler'), import('./ses-setup.js')]));
export async function checkReputationAlerts(runtime: Runtime): Promise<number> {
  if (!runtime.config.reputationAlertUrl || !runtime.config.aws || !runtime.config.liveEnabled) return 0;
  // CloudWatch rates still describe one provider account. Read each region once, but keep alert ledgers per workspace.
  const settings = await runtime.db.select({ workspaceId: sesSettings.workspaceId, regions: sesSettings.enabledRegions }).from(sesSettings);
  const regions = new Set(settings.flatMap(row => row.regions));
  if (!regions.size) return 0;
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
        for (const owner of settings) if (owner.regions.includes(region) && await queueIfChanged(runtime, owner.workspaceId, region, metric, value)) queued++;
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

async function queueIfChanged(runtime: Runtime, workspaceId: string, region: string, metric: Metric, value: number) {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${JOB}:${workspaceId}:${region}:${metric}`}))`);
    // An alert whose delivery failed was never seen: leaving it out lets the next hourly check raise the level again.
    const recent = await tx.select({ payload: jobs.payload, createdAt: jobs.createdAt }).from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, JOB), sql`${jobs.payload}->>'region' = ${region}`, sql`${jobs.payload}->>'metric' = ${metric}`, sql`${jobs.status} <> 'failed'`))
      .orderBy(desc(jobs.createdAt)).limit(24);
    const history = recent.map(row => ({ level: (LEVELS as readonly string[]).includes(String(row.payload.level)) ? row.payload.level as Level : 'ok' as Level, at: Date.parse(row.createdAt) }));
    const decision = decideAlert(metric, value, history, Date.now());
    if (!decision) return false;
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

const deliver: JobHandler = async (runtime, payload, job) => {
  const url = runtime.config.reputationAlertUrl;
  if (!url) return;
  if (payload.code === 'SES_IDENTITY_QUOTA_EXHAUSTED') return postSlack(url, { text: `SES identity quota exhausted in ${payload.region}. Request regional identity capacity before onboarding more domains.` });
  if (payload.code === 'HOSTED_EXEMPT_OVER_LINE') return postSlack(url, { text: exemptAlertText({ ...payload, workspaceId: job.workspaceId }, runtime.config.publicUrl) });
  if (payload.code === 'SES_TENANT_PAUSED') return postSlack(url, { text: tenantPausedText({ ...payload, workspaceId: job.workspaceId }, runtime.config.publicUrl) });
  if (payload.code === 'BUILTIN_PARENT_TRIPPED') return postSlack(url, { text: builtinTrippedText(payload) });
  if (payload.code === 'BUILTIN_WORKSPACE_OVER_LINE') return postSlack(url, { text: builtinWorkspaceText(payload, job.workspaceId, runtime.config.publicUrl) });
  const { region, metric, level, previous, value } = payload;
  if (typeof region !== 'string' || !(metric === 'bounceRate' || metric === 'complaintRate') || !LEVELS.includes(level as Level) || !LEVELS.includes(previous as Level) || typeof value !== 'number') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid reputation alert job.');
  await postSlack(url, { text: reputationAlertText({ region, metric, level: level as Level, previous: previous as Level, value, publicUrl: runtime.config.publicUrl }) });
};
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
