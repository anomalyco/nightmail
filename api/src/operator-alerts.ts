import { SQL, sql } from 'drizzle-orm';
import { ApiError, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { retryDatabaseFailures } from './jobs.js';
import { hostedAllowance } from './hosted-sending.js';
import { postSlack } from './reputation-alerts.js';
import { mentionFor, sendMentioned } from './operator-mention.js';

// Operator alerts (hosted): one Slack card when a customer may be in trouble, posted to OPERATOR_SLACK_WEBHOOK_URL.
// Each moment queues an operator.alert job in one statement that never fails what it reports; the job posts through
// the reputation alerts' Slack path (postSlack) and retries like them. Unset, nothing is posted: the hooks that read
// the configuration queue nothing, and the standing's (applyChange has none to read) queues a job that posts nothing.
//
// A new sign-up posts every time, and so do sign-ups nearly full and full: once each time places reach the level
// (signups.ts placesAlert keeps which was told). Every other card posts at most once in 24 hours per workspace ('platform' for the
// installation-wide two), kept by the job's own ID: it names the UTC day, and yesterday's counts while it is under 24
// hours old. Each is queued when its state begins (a rise of the standing, a refusal, a sample that became full, a
// window that became slow), never while it simply continues.
//
// A card carries the workspace's name and plain words: never an address, a domain's contents, a score or a threshold.
// Support AI cost is the installation's own spend (the health tick finds it past its daily line): once each UTC day, the
// day being its episode, and its words name that line, which is in the repository (health-thresholds.ts SUPPORT_AI).
//
// The database disk card is the exception to the queue: it must post while the database refuses writes, so it never
// touches it (src/disk-alert.ts).
//
// Amazon account is the installation's view of Amazon's own account status for each region (GetAccount, read every 10
// minutes for Glass: glass-deliverability.ts): one card each time a region's state changes, healthy being HEALTHY with
// sending enabled. A failed read changes nothing; a region's first reading posts only if it isn't healthy.
//
// Paused, Amazon paused and Amazon account getting worse mention the operator (src/operator-mention.ts), when production's
// configuration names one; every other card, and every card without it, posts as it always has.

const JOB = 'operator.alert', PLATFORM = 'platform';
const CARDS = {
  signup: { emoji: ':wave:', label: 'New sign-up' },
  paused: { emoji: ':double_vertical_bar:', label: 'Paused' },
  marketing_held: { emoji: ':mega:', label: 'Marketing on hold' },
  amazon_paused: { emoji: ':cloud:', label: 'Amazon paused' },
  daily_limit: { emoji: ':no_entry_sign:', label: 'Daily limit' },
  share_full: { emoji: ':bucket:', label: 'Customer share full' },
  signin_slow: { emoji: ':snail:', label: 'Sign-in mail slow' },
  signups_low: { emoji: ':hourglass_flowing_sand:', label: 'Sign-ups nearly full' },
  signups_full: { emoji: ':no_entry:', label: 'Sign-ups are full' },
  blocklisted: { emoji: ':rotating_light:', label: 'Blocklist replies' },
  support_ai_cost: { emoji: ':money_with_wings:', label: 'Support AI cost' },
  amazon_account: { emoji: ':cloud:', label: 'Amazon account' },
} as const;
// The installation's own cards, about no one workspace: queued under 'platform' and opening the Operator area.
const PLATFORM_KINDS = new Set<string>(['share_full', 'signin_slow', 'signups_low', 'signups_full', 'support_ai_cost', 'amazon_account']);
const RAISE = 'Raise the limit in Operator → Sign-ups.';
type Kind = keyof typeof CARDS;
const REASONS = { bounces: 'too many bounces', complaints: 'too many spam complaints', screen: 'too much mail flagged as spam', review: 'after a review' } as const;
/**
 * Sign-in mail is slow when, of at least `minimum` transactional emails in `minutes` that were free to go, `share` or
 * more waited over `seconds` for their first attempt: at least two, so one email can never raise it. The check reads
 * `lookback` minutes of each workspace's mail to know when its own pace was behind, and stops after `timeoutMs`.
 */
export const SLOW_SIGN_IN = { minutes: 15, seconds: 10, share: 1 / 20, minimum: 40, lookback: 45, timeoutMs: 5000 } as const;

// Slack mrkdwn has no escape for its emphasis characters, so a name shows look-alikes instead of turning bold or code.
const LOOKALIKE: Record<string, string> = { '*': '\u2217', '_': '\u02cd', '~': '\u223c', '`': '\u02cb' };
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** A workspace's name as card text: one line, an address cut to its local part, at most 80 whole characters, no markup. */
export function cardName(name: string) {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/([^\s@]+)@[A-Za-z0-9.-]+/g, '$1').replace(/\s+/g, ' ').trim();
  // Cut on whole characters (an emoji with its joiners and modifiers is one), never inside one: half a character can
  // make Slack refuse the message.
  const plain = Array.from(graphemes.segment(line), s => s.segment).slice(0, 80).join('') || 'A workspace';
  return plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_~`]/g, c => LOOKALIKE[c]!);
}
const count = (n: unknown) => Number(n).toLocaleString('en-US');
/** "1 in 20", or "Most" or "All" past one in two. */
const share = (slow: number, mail: number) => mail / slow >= 2 ? `1 in ${Math.round(mail / slow)}` : slow >= mail ? 'All' : 'Most';
const whole = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cents = (n: number) => `$${(n / 100).toFixed(2)}`;
/** Amazon's account status for a region in words: "on probation", "shut down, sending disabled", "healthy again". */
const accountWords = (p: Record<string, unknown>) => p.healthy === true ? 'healthy again'
  : [p.enforcement === 'PROBATION' ? 'on probation' : p.enforcement === 'SHUTDOWN' ? 'shut down' : null, p.sending === false ? 'sending disabled' : null].filter(Boolean).join(', ');

/** One card: an emoji, a bold label and a few words, an Open button, and the same words as the plain-text fallback. */
export const slackCard = (card: { emoji: string; label: string } | null, words: string, url: string) => ({
  text: card ? `${card.label}: ${words}` : words, unfurl_links: false, unfurl_media: false,
  blocks: [{ type: 'section', text: card ? { type: 'mrkdwn', text: `${card.emoji} *${card.label}* ${words}`, verbatim: true } : { type: 'plain_text', text: words, emoji: false },
    accessory: { type: 'button', action_id: 'open', text: { type: 'plain_text', text: 'Open', emoji: false }, url } }],
});

/** The Slack message for one alert (slackCard), its button opening the Operator area. Null for a payload that is not one of CARDS. */
export function operatorCard(publicUrl: string, p: Record<string, unknown>, workspace: { id: string; name: string | null }) {
  const kind = p.kind as Kind, name = cardName(workspace.name ?? '');
  if (typeof kind !== 'string' || !Object.hasOwn(CARDS, kind)) return null;
  const card = CARDS[kind];
  const words = kind === 'signup' && whole(p.signedUp) && whole(p.limit) ? `${name}. ${count(p.signedUp)} of ${count(p.limit)}.`
    : kind === 'paused' ? `${name}${typeof p.reason === 'string' && Object.hasOwn(REASONS, p.reason) ? `, ${REASONS[p.reason as keyof typeof REASONS]}` : ''}.`
    : kind === 'marketing_held' ? `${name}.`
    : kind === 'amazon_paused' ? `${name}${typeof p.region === 'string' && p.region ? `, ${p.region}` : ''}.`
    : kind === 'daily_limit' && whole(p.used) && whole(p.limit) ? `${name}, ${count(p.used)} of ${count(p.limit)}.`
    : kind === 'share_full' && whole(p.used) && whole(p.share) ? `${count(p.used)} of ${count(p.share)}.`
    : kind === 'signin_slow' && whole(p.slow) && whole(p.mail) && Number(p.slow) > 0 ? `${share(Number(p.slow), Number(p.mail))} over ${SLOW_SIGN_IN.seconds} seconds.`
    : kind === 'signups_low' && whole(p.open) && whole(p.limit) ? `${count(p.open)} of ${count(p.limit)} places left. ${RAISE}`
    : kind === 'signups_full' && whole(p.limit) ? `All ${count(p.limit)} places are taken. ${RAISE}`
    : kind === 'blocklisted' ? `${name}: a campaign paused because receiving servers named a blocklist.`
    : kind === 'support_ai_cost' && whole(p.cents) && whole(p.lineCents) ? `${cents(Number(p.cents))} since midnight UTC, past the ${cents(Number(p.lineCents))} daily line. Nothing stops: the turn caps still apply.`
    : kind === 'amazon_account' && typeof p.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(p.region) ? `${typeof p.place === 'string' && p.place ? `${p.place} (${p.region})` : p.region}: ${accountWords(p)}.`
    : null;
  if (!words) return null;
  const origin = publicUrl.replace(/\/$/, '');
  const url = kind === 'signups_low' || kind === 'signups_full' ? `${origin}/operator?view=signups` : kind === 'support_ai_cost' ? `${origin}/glass` : kind === 'amazon_account' ? `${origin}/glass?view=deliverability` : PLATFORM_KINDS.has(kind) ? `${origin}/operator` : `${origin}/operator/workspaces/${encodeURIComponent(workspace.id)}`;
  return slackCard(card, words, url);
}

/**
 * Queues one card, in one statement that never fails its caller: a card that can't be queued is logged. Inside a
 * transaction pass `savepoint`, so a failed insert leaves the transaction usable. `daily`: at most one in 24 hours.
 */
async function queue(db: DbExecutor, workspace: string | SQL, kind: Kind, data: Record<string, unknown> | SQL, options: { daily: boolean; savepoint?: boolean; episode?: string }) {
  const workspaceId = typeof workspace === 'string' ? workspace : undefined;
  const key = sql`${`operator-alert:${kind}:`}||w.id${options.episode ? sql`||${`:${options.episode}`}` : sql``}`, day = (ago: string) => sql`${key}||':'||to_char((now() AT TIME ZONE 'UTC')-${ago}::interval,'YYYYMMDD')`;
  const payload = data instanceof SQL ? data : sql`${JSON.stringify(data)}::jsonb`;
  try {
    if (options.savepoint) await db.execute(sql`SAVEPOINT operator_alert`);
    const { rows } = await db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT ${options.daily ? day('0') : key},${JOB},w.id,jsonb_build_object('kind',${kind}::text)||${payload}
      FROM (SELECT ${typeof workspace === 'string' ? sql`${workspace}::text` : workspace} AS id) w WHERE w.id IS NOT NULL
      ${options.daily ? sql`AND NOT EXISTS (SELECT FROM jobs WHERE id=${day('0')}) AND NOT EXISTS (SELECT FROM jobs WHERE id=${day('1 day')} AND created_at>now()-interval '24 hours')` : sql``}
      ON CONFLICT (id) DO NOTHING RETURNING id`);
    if (options.savepoint) await db.execute(sql`RELEASE SAVEPOINT operator_alert`);
    return rows.length > 0;
  } catch {
    if (options.savepoint) await db.execute(sql`ROLLBACK TO SAVEPOINT operator_alert`).catch(() => {});
    log('warn', { code: 'OPERATOR_ALERT_NOT_QUEUED', workspaceId, kind });
    return false;
  }
}

/**
 * New sign-up: "Driftwood. 91 of 100", for the workspace the new account owns. Called by account-login.ts
 * finishAccountLogin after the sign-up committed, with the sign-up limit's places (signups.ts readPlaces), so it can't
 * block or fail it. One statement; never throws.
 */
export async function alertNewSignup(runtime: Runtime, db: DbExecutor, userId: string, places: { signedUp: number; limit: number }) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  const owned = sql`(SELECT workspace_id FROM workspace_members WHERE user_id=${userId} AND role='owner' ORDER BY created_at,id LIMIT 1)`;
  return queue(db, owned, 'signup', { signedUp: places.signedUp, limit: places.limit }, { daily: false });
}

/**
 * Sign-ups nearly full ("8 of 200 places left") and Sign-ups are full, each once as places reach it (signups.ts
 * placesAlert). Called after a sign-up or a change of the limit commits, so it can't block or fail it. The level and its
 * card are written in one transaction: a card that can't be queued leaves the level untold, for the next check. Never throws.
 */
export async function signupPlacesAlert(runtime: Runtime) {
  if (!runtime.config.operatorSlackWebhookUrl || !runtime.config.multiTenant) return false;
  try {
    const { placesAlert } = await import('./signups.js');
    return await runtime.db.transaction(async tx => {
      const reached = await placesAlert(tx);
      if (!reached) return false;
      const { open, limit } = reached.places;
      if (await queue(tx, PLATFORM, reached.level === 'full' ? 'signups_full' : 'signups_low', { open, limit }, { daily: false, savepoint: true, episode: String(Date.now()) })) return true;
      throw new Error('not queued');
    });
  } catch {
    log('warn', { code: 'OPERATOR_ALERT_NOT_QUEUED', kind: 'signups' });
    return false;
  }
}

const PAUSE_WHY: Record<string, keyof typeof REASONS> = { bounces: 'bounces', marketing_bounces: 'bounces', transactional_bounces: 'bounces', complaints: 'complaints', screen: 'screen' };
/**
 * A rise of the standing (src/standing.ts applyChange, in its transaction): a pause is Paused, or Amazon paused when
 * AWS paused the workspace's SES tenant; a restrict is Marketing on hold. Anything else posts nothing.
 */
export async function standingAlert(db: DbExecutor, workspaceId: string, step: string, reasons: { code: string; metric: string; step: string }[], details?: Record<string, unknown>) {
  if (step === 'restrict') return queue(db, workspaceId, 'marketing_held', {}, { daily: true, savepoint: true });
  if (step !== 'pause') return false;
  const why = reasons.find(r => r.step === 'pause') ?? reasons[0];
  if (why?.code === 'SES_TENANT_PAUSED') {
    const region = typeof details?.tenant === 'string' ? details.tenant.split(':')[3] ?? null : null;
    return queue(db, workspaceId, 'amazon_paused', { region }, { daily: true, savepoint: true });
  }
  return queue(db, workspaceId, 'paused', { reason: why?.code === 'OPERATOR_PAUSE' ? 'review' : why ? PAUSE_WHY[why.metric] ?? null : null }, { daily: true, savepoint: true });
}

/** Daily limit: a send refused at the workspace's daily limit (app.ts onError), with what admission counted against it. */
export async function dailyLimitAlert(runtime: Runtime, workspaceId: string) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  // One incoming recipient: with none, the function leaves the hours (and what was used) out.
  const allowance = hostedAllowance(runtime.config, workspaceId, 1, 0, true);
  return queue(runtime.db, workspaceId, 'daily_limit', sql`(SELECT jsonb_build_object('used',(a->>'used')::bigint,'limit',(a->>'cap')::bigint) FROM (SELECT ${allowance} AS a) x)`, { daily: true });
}

/**
 * Support AI cost: the health tick found today's model cost past the daily line (health-thresholds.ts SUPPORT_AI). One
 * card each UTC day, kept by the job's ID (the day is its episode), however many ticks call this. Never throws.
 */
export function supportCostAlert(db: DbExecutor, costUsd: number, lineUsd: number) {
  const day = new Date().toISOString().slice(0, 10);
  return queue(db, PLATFORM, 'support_ai_cost', { cents: Math.round(costUsd * 100), lineCents: Math.round(lineUsd * 100) }, { daily: false, episode: day });
}

/** Customer share full: the dispatcher's quota sample that found the share used up when the previous one had not. */
export async function shareFullAlert(runtime: Runtime, used: number, full: number) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  return queue(runtime.db, PLATFORM, 'share_full', { used: Math.round(used), share: Math.round(full) }, { daily: true });
}

/**
 * Sign-in mail slow: after the standing job's ten-minute run, the last 15 minutes of Hosted transactional mail (no
 * campaigns, no simulated mail) against the 15 minutes before them. An email waited from when it was due (its creation,
 * or a later scheduled time), as the dispatcher's DISPATCH_EMAIL queueMs measures it, until its first attempt; one still
 * queued counts once it has waited the full 10 seconds. Mail that was not free to go is left out: mail of a paused
 * workspace or sponsor, mail admitted before its workspace's last resume, and mail waiting for its own workspace's
 * pace. That is a minute in which the workspace's mail so far was more than its minute cap could carry since its queue
 * was last empty, or in which a new sender's growth allowance was used up: the dispatcher leases nothing of it then.
 * Posts when the last window is slow and the one before was not. Stops after SLOW_SIGN_IN.timeoutMs; never throws.
 */
export async function checkSignInMail(runtime: Runtime) {
  if (!runtime.config.operatorSlackWebhookUrl) return false;
  try {
    const { minutes, seconds, lookback, timeoutMs } = SLOW_SIGN_IN;
    const span = sql`generate_series(date_trunc('minute',now())-make_interval(mins=>${lookback}),date_trunc('minute',now()),interval '1 minute')`;
    const rows = await runtime.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true)`);
      return (await tx.execute<{ current: boolean; mail: number; slow: number }>(sql`WITH hosted AS MATERIALIZED (
          SELECT pc.workspace_id,pc.resumed_at,CASE WHEN NOT w.exempt_hosted_quotas THEN hosted_minute_cap(pc.workspace_id) END AS cap,
            CASE WHEN NOT w.exempt_hosted_quotas AND s.growth_until>now() THEN s.growth_cap END AS growth_cap,coalesce(w.quota_sponsor,w.id) AS growth_key
          FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id LEFT JOIN sender_standing s ON s.workspace_id=pc.workspace_id
          WHERE pc.kind='shared' AND pc.paused_at IS NULL AND hosted_sponsor_hold(pc.workspace_id) IS DISTINCT FROM 'pause'
            AND EXISTS (SELECT FROM sending_emails e WHERE e.workspace_id=pc.workspace_id AND e.snapshot->>'kind'='transactional' AND e.created_at>=now()-make_interval(mins=>${2 * minutes}))
        ), excess AS (
          -- Each minute, the workspace's recipients so far less what its minute cap carries, every stream counted.
          SELECT h.workspace_id,m.minute,sum(coalesce(d.n,0)-h.cap) OVER (PARTITION BY h.workspace_id ORDER BY m.minute) AS excess
          FROM hosted h CROSS JOIN ${span} m(minute) CROSS JOIN LATERAL (SELECT sum(jsonb_array_length(e.to_addresses)+jsonb_array_length(e.cc_addresses)+jsonb_array_length(e.bcc_addresses)) AS n
            FROM sending_emails e WHERE e.workspace_id=h.workspace_id AND e.created_at>=m.minute AND e.created_at<m.minute+interval '1 minute' AND NOT e.simulated) d
          WHERE h.cap IS NOT NULL
        ), paced AS (
          -- Behind its pace: the excess is above its lowest point before (the last time the queue was empty).
          SELECT workspace_id,minute FROM (SELECT workspace_id,minute,excess,min(excess) OVER (PARTITION BY workspace_id ORDER BY minute ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS low FROM excess) x
          WHERE excess>least(0,low)
          UNION
          -- Its growth allowance used up: what its sponsor sent in the rolling hour reached it.
          SELECT h.workspace_id,m.minute FROM hosted h CROSS JOIN ${span} m(minute) WHERE h.growth_cap IS NOT NULL
            AND (SELECT coalesce(sum(u.used),0) FROM hosted_growth_minutes u WHERE u.growth_key=h.growth_key AND u.minute>m.minute-interval '60 minutes' AND u.minute<=m.minute)>=h.growth_cap
        ), mail AS (
          SELECT e.workspace_id,e.created_at>=now()-make_interval(mins=>${minutes}) AS current,e.status,
            CASE WHEN e.dispatch_version=0 THEN e.attempt_started_at ELSE (SELECT min(v.created_at) FROM sending_email_events v WHERE v.workspace_id=e.workspace_id AND v.email_id=e.id AND v.type='dispatch_attempt') END AS first,
            CASE WHEN e.dispatch_version=0 THEN greatest(e.created_at,e.scheduled_at) ELSE e.created_at END AS due
          FROM hosted h JOIN sending_emails e ON e.workspace_id=h.workspace_id AND e.snapshot->>'kind'='transactional'
            AND e.created_at>=now()-make_interval(mins=>${2 * minutes}) AND e.created_at>coalesce(h.resumed_at,'-infinity') AND e.campaign_id IS NULL AND NOT e.simulated
        ), waited AS (
          SELECT current,first IS NOT NULL AS attempted,coalesce(first,CASE WHEN status='queued' THEN clock_timestamp() END)-due>make_interval(secs=>${seconds}) AS slow FROM mail m
          WHERE NOT EXISTS (SELECT FROM paced p WHERE p.workspace_id=m.workspace_id AND p.minute BETWEEN date_trunc('minute',m.due) AND date_trunc('minute',coalesce(m.first,clock_timestamp())))
        )
        SELECT current,count(*) FILTER (WHERE attempted OR slow)::int AS mail,count(*) FILTER (WHERE slow)::int AS slow FROM waited GROUP BY current`)).rows;
    });
    const slowIn = (current: boolean) => rows.find(r => r.current === current && r.mail >= SLOW_SIGN_IN.minimum && r.slow >= r.mail * SLOW_SIGN_IN.share);
    const now = slowIn(true);
    if (!now || slowIn(false)) return false;
    return await queue(runtime.db, PLATFORM, 'signin_slow', { slow: now.slow, mail: now.mail }, { daily: true });
  } catch {
    log('warn', { code: 'SIGN_IN_MAIL_CHECK_FAILED', message: 'The next standing run checks again.' });
    return false;
  }
}

/** Posts one card. Without the webhook it does nothing; a refused or timed-out post throws, and the job retries. */
const deliver: JobHandler = async (runtime, payload, job) => {
  const url = runtime.config.operatorSlackWebhookUrl;
  if (!url) return;
  let name: string | null = null;
  if (typeof payload.kind !== 'string' || !PLATFORM_KINDS.has(payload.kind)) {
    const [workspace] = (await runtime.db.execute<{ name: string }>(sql`SELECT name FROM workspaces WHERE id=${job.workspaceId}`)).rows;
    if (!workspace) return; // The workspace was deleted meanwhile.
    name = workspace.name;
  }
  // AWS's region code, shown by its place name (us-east-2: Ohio).
  const region = payload.kind === 'amazon_paused' && typeof payload.region === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(payload.region)
    ? (await import('./byo-regional.js')).regionLabels[payload.region] ?? payload.region : null;
  const place = payload.kind === 'amazon_account' && typeof payload.region === 'string' ? (await import('./region-labels.js')).regionLabels[payload.region] ?? null : null;
  const card = operatorCard(runtime.config.publicUrl, { ...payload, ...(payload.kind === 'amazon_paused' ? { region } : {}), ...(place ? { place } : {}) }, { id: job.workspaceId, name });
  if (!card) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid operator alert job.');
  // Mentioned or not, decided once for this job (src/operator-mention.ts). Amazon account mentions only when it got worse.
  const account = payload.kind === 'amazon_account';
  const mention = !account || payload.worse === true ? await mentionFor(runtime, { id: job.id, kind: String(payload.kind), subject: account ? String(payload.region) : job.workspaceId }) : null;
  await sendMentioned(runtime, message => postSlack(url, message, 'OPERATOR_ALERT_FAILED'), card, mention, job.id);
};
export const operatorAlertJobs: Record<string, JobHandler> = { [JOB]: retryDatabaseFailures(deliver) };

/**
 * A campaign paused because replies named a blocklist (src/send-guards.ts): "Driftwood: a campaign paused because receiving
 * servers named a blocklist." Once per campaign (its episode), however often it pauses again. Never names the domain or link.
 */
export async function blocklistAlert(db: DbExecutor, workspaceId: string, campaignId: string) {
  return queue(db, workspaceId, 'blocklisted', {}, { daily: false, episode: campaignId });
}

/** The enforcement statuses GetAccount reports. A read with none of them is no reading. */
const ENFORCEMENT = new Set(['HEALTHY', 'PROBATION', 'SHUTDOWN']);
/** A region's state: healthy, or the enforcement status and whether sending is disabled ("PROBATION", "SHUTDOWN+sending_disabled"). */
const accountState = (enforcement: string, sending: boolean) => enforcement === 'HEALTHY' && sending ? 'healthy' : `${enforcement}${sending ? '' : '+sending_disabled'}`;
/** How bad a state is: healthy; not healthy but sending; or sending stopped (shut down or disabled). */
const accountRank = (state: string) => state === 'healthy' ? 0 : /^SHUTDOWN|\+sending_disabled$/.test(state) ? 2 : 1;
/**
 * Amazon account: the 10-minute GetAccount read for a region (glass-deliverability.ts refreshDeliverabilitySources), only
 * a read that succeeded. Queues a card when the region's state differs from the last one told (deliverability_checks.told),
 * in the transaction that records it, so a card that can't be queued leaves it untold for the next read. The first
 * reading is told without a card when healthy. A worse state than the last told one mentions the operator. A read without
 * a recognised enforcement status (ENFORCEMENT) is no reading: no card, nothing told. Never throws.
 */
export async function amazonAccountAlert(runtime: Runtime, region: string, detail: Record<string, unknown>) {
  const enforcement = typeof detail.enforcement === 'string' && ENFORCEMENT.has(detail.enforcement) ? detail.enforcement : null;
  if (!enforcement) return false;
  const sending = detail.sendingEnabled !== false, state = accountState(enforcement, sending);
  try {
    return await runtime.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<{ told: string | null }>(sql`SELECT told FROM deliverability_checks WHERE kind='ses' AND subject=${region} FOR UPDATE`);
      if (!row || row.told === state) return false;
      await tx.execute(sql`UPDATE deliverability_checks SET told=${state} WHERE kind='ses' AND subject=${region}`);
      if ((row.told === null && state === 'healthy') || !runtime.config.operatorSlackWebhookUrl) return false;
      const worse = accountRank(state) > accountRank(row.told ?? 'healthy');
      if (await queue(tx, PLATFORM, 'amazon_account', { region, enforcement, sending, healthy: state === 'healthy', worse }, { daily: false, savepoint: true, episode: `${region}:${Date.now()}` })) return true;
      throw new Error('not queued');
    });
  } catch {
    log('warn', { code: 'OPERATOR_ALERT_NOT_QUEUED', kind: 'amazon_account' });
    return false;
  }
}
