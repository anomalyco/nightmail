import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { bounded, utc, type Hosted } from './abuse.js';
import { accessed, BANDS, REASON_CODES, type Band, type ClusterChange, type Reason } from './abuse-clusters.js';
import { operatorContext, recordAudit } from './audit.js';
import { ApiError, errors, json, log, notFound, response, security, type App, type JobHandler } from './core.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { operatorActor } from './operator.js';
import { postSlack, SlackRefused } from './reputation-alerts.js';
import { mentionFor, sendMentioned } from './operator-mention.js';

// Abuse monitoring, part 3: the alert outbox and its review. When a cluster first reaches a level a person should look
// at (review or high), climbs a level or gains a member there, one alert is stored with its Slack message, and one job
// (abuse.alert, keyed by the alert) posts it, both levels: to ABUSE_SLACK_WEBHOOK_URL, else to the operator alerts'
// webhook (config.ts), through the operator notices' Slack path and job queue, so it never waits on the hourly job's
// time. Not more than ALERTS_AN_HOUR posts of each level in any hour, each level counted on its own: a review alert
// never takes a high one's place, and what waits posts when a place frees, while it still needs a look.
// One that no longer needs a look (its cluster is gone or below its level, someone reviewed it, a day went by) is marked
// stale, with why, and never posted late; an alert that never reached anyone (stale or failed) covers nothing, so the
// cluster is raised again. A post Slack doesn't answer in time is tried once more, never a third time (Slack may
// have taken it): at most two posts for one alert. A cluster made only of staff's own accounts raises none (ownAccounts).
// What should have gone out and has not (late, failed, expired unposted, or posted unconfirmed) is a Health warning,
// critical while a high alert waits (health.ts).
// Operators read every alert in the Operator area, and review one from its cluster's page: Watch
// (reviewed, keep tracking: raised again only at a higher level) or Dismiss (not abuse: raised again only with a member
// or a reason it did not have). Pause is there too, on each workspace.
//
// A message holds no personal data and no evidence: a risk level, reasons in fixed words, counts, workspace IDs and a
// link into the Operator area (a staff sign-in). Never a workspace's name (it can be a person's), an address, a domain,
// a signal's value or anything a customer wrote. The payload and the webhook URL are never logged. A high alert, as it
// is posted, mentions the operator production's configuration names (src/operator-mention.ts); a review one never does.

const rank = (band: Band) => BANDS.indexOf(band);
export type AlertKind = 'new' | 'raised' | 'grew';
/** Whether a change to a cluster is worth an alert: it first reached review or high, climbed a level, or gained a member there. */
export function alertFor(change: ClusterChange): AlertKind | null {
  if (rank(change.band) < rank('review')) return null;
  if (!change.previous || rank(change.previous.band) < rank('review')) return 'new';
  if (rank(change.band) > rank(change.previous.band)) return 'raised';
  return change.members > change.previous.members ? 'grew' : null;
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/, CODES: readonly string[] = REASON_CODES, WORKSPACES_SHOWN = 3, REASONS_SHOWN = 3;
const bandName = { review: 'Review', high: 'High' } as const, kindName: Record<AlertKind, string> = { new: 'New', raised: 'Risk raised', grew: 'New member' };
// A high alert can't be taken for a review one at a glance: its own mark before the line, and a red button.
const bandMark = { review: ':mag:', high: ':rotating_light:' } as const;
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;
// Each reason in plain words, with its count where the count is something a person can picture. MULTI_ACCOUNT is the
// message's first line.
const WHY: Record<string, (count: number) => string> = {
  FREE_TIER_MULTIPLIED: n => `free allowance shared across ${plural(n, 'workspace')}`,
  THROWAWAY_SIGNUP: () => 'throwaway or look-alike sign-up addresses',
  SIGNUP_BURST: n => `${plural(n, 'sign-up')} from one network within a day`,
  SHARED_CARD: () => 'the same payment card',
  PAYMENT_RISK: () => 'disputed or failing payments',
  SIMILAR_CONTENT: () => 'near-identical mail',
  SHARED_LINKS: () => 'mail linking to the same sites',
  SENDER_STANDING: () => 'a sending warning, hold or pause',
  FAST_FIRST_SEND: () => 'API sends within 10 minutes of sign-up',
  WAITLIST_REPEAT: n => plural(n, 'repeated sign-in refusal'),
};
/** What the cluster's workspaces sent in the last seven days: accepted emails, and of them the bounces and complaints. */
export type Sent = { emails: number; bounced: number; complained: number };
const share = (part: number, whole: number, digits: number) => `${(part / whole * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
/**
 * The Slack message for one alert: one line (level, score, accounts) and three bullets (who, why, what they sent), with
 * a button to its cluster in the Operator area. Built only from a level, numbers, reason codes on the fixed list and IDs
 * of a safe shape; anything else is left out. No unfurls, and no mention in the stored message: a high alert mentions
 * the operator only as it is posted (deliver, src/operator-mention.ts).
 */
export function slackCard(publicUrl: string, alert: { cluster: string; band: 'review' | 'high'; score: number; kind: AlertKind; accounts: number; reasons: Reason[]; workspaces: string[]; sent: Sent }) {
  const origin = publicUrl.replace(/\/$/, ''), ids = alert.workspaces.filter(id => SAFE_ID.test(id)), more = ids.length - WORKSPACES_SHOWN, { emails, bounced, complained } = alert.sent;
  const head = `${bandName[alert.band]} risk ${alert.score}: ${plural(alert.accounts, 'related account')}${alert.kind === 'new' ? '' : ` (${kindName[alert.kind].toLowerCase()})`}`;
  const who = ids.length ? `${plural(ids.length, 'workspace')}: ${ids.slice(0, WORKSPACES_SHOWN).map(id => `\`${id}\``).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'sign-ins only, no workspace';
  const why = alert.reasons.filter(reason => CODES.includes(reason.code) && WHY[reason.code] && Number.isInteger(reason.points)).sort((a, b) => b.points - a.points).slice(0, REASONS_SHOWN)
    .map(reason => WHY[reason.code]!(Number.isInteger(reason.count) ? reason.count! : 0));
  const sent = emails > 0 ? `${plural(emails, 'email')}, ${share(bounced, emails, 1)} bounced, ${share(complained, emails, 2)} complaints` : 'nothing';
  return {
    text: head, unfurl_links: false, unfurl_media: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: [`${bandMark[alert.band]} *${head}*`, `• *Who:* ${who}`, `• *Why:* ${why.join('; ') || 'shared sign-in signals'}`, `• *Sent in 7 days:* ${sent}`].join('\n') } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'review', style: alert.band === 'high' ? 'danger' : 'primary', text: { type: 'plain_text', text: 'Review in Operator', emoji: false }, url: `${origin}/operator/abuse/${encodeURIComponent(alert.cluster)}` }] },
    ],
  };
}
/**
 * A workspace that is staff's own: the platform's workspace, one with staff's first-party exemption (exempt_hosted_quotas,
 * set only from the staff script), or one an operator owns. A customer an operator made free (billing mode exempt) is
 * still a customer: not this.
 */
const ownWorkspace = (id: SQL, platform: string | undefined) => sql`EXISTS (SELECT FROM workspaces w WHERE w.id=${id} AND (w.exempt_hosted_quotas
  OR w.id=${platform ?? null}::text OR EXISTS (SELECT FROM workspace_members m JOIN platform_operators o ON o.user_id=m.user_id WHERE m.workspace_id=w.id AND m.role='owner')))`;
/**
 * Whether every member of a cluster is staff's own: each workspace one of its own (ownWorkspace), each account an
 * operator or a member only of its own workspaces. Any other member (a customer's account or workspace, a sign-in that
 * was never admitted) makes it a cluster to raise, whatever else is in it. Nothing about the score changes.
 */
const ownAccounts = (keys: SQL, platform: string | undefined) => sql`(SELECT count(*)>0 AND bool_and(CASE split_part(k.key,':',1)
    WHEN 'workspace' THEN ${ownWorkspace(sql`substr(k.key,11)`, platform)}
    WHEN 'user' THEN EXISTS (SELECT FROM platform_operators o WHERE o.user_id=substr(k.key,6)) OR (EXISTS (SELECT FROM workspace_members m WHERE m.user_id=substr(k.key,6))
      AND NOT EXISTS (SELECT FROM workspace_members m WHERE m.user_id=substr(k.key,6) AND NOT ${ownWorkspace(sql`m.workspace_id`, platform)}))
    ELSE false END) FROM unnest(${keys}::text[]) AS k(key))`;
const JOB = 'abuse.alert', PLATFORM = 'platform';
/** The one job that posts an alert: its ID names the alert, so an alert is queued once however often it is swept. */
const jobId = (alert: SQL) => sql`'abuse-alert:'||${alert}`;
/**
 * Stores an alert for a cluster's change, with what its workspaces sent this week, and queues the job that posts it, in
 * one statement, unless the cluster is only staff's own accounts (ownAccounts: logged with its ID, never stored) or one
 * already covers it. Only an alert that went out (sent, or posted unconfirmed) or may still go out (stored and still
 * needing a look) covers anything; a stale or failed one reached nobody:
 * - an alert for the cluster at this level in the last seven days;
 * - alerts at this level or above in the last seven days that named every one of its workspaces;
 * - a Watch on the cluster, or on an alert that named all its members, at this level or above;
 * - a Dismiss on an alert that named all its members and all its reasons. A dismissed alert covers nothing else.
 * Returns its ID, or null.
 */
export async function noteAlert(runtime: Hosted, change: ClusterChange) {
  const kind = alertFor(change), band = change.band;
  if (!kind || (band !== 'review' && band !== 'high')) return null;
  const id = `aal_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, keys = sql.param(change.keys), codes = sql.param(change.reasons.map(reason => reason.code));
  const workspaces = sql.param(change.workspaces.map(workspace => `workspace:${workspace}`)), atLeast = sql`(a.band=${band}::text OR a.band='high')`;
  const covering = sql`(a.status IN ('sent','unconfirmed') OR (a.status='stored' AND (SELECT ${staleReason} FROM (VALUES (1)) one(x) LEFT JOIN abuse_clusters c ON c.id=a.cluster_id) IS NULL))`;
  const recent = sql`a.created_at>now()-interval '7 days' AND a.review IS DISTINCT FROM 'dismiss' AND ${covering}`;
  return bounded(runtime, async tx => {
    const { rows: [own] } = await tx.execute<{ own: boolean }>(sql`SELECT ${ownAccounts(sql`${keys}`, runtime.config.platformDomainWorkspace)} AS own`);
    if (own?.own) { log('info', { code: 'ABUSE_ALERT_OWN_ACCOUNTS', cluster: change.id, band, members: change.keys.length }); return null; }
    const { rows: [sent] } = await tx.execute<{ emails: string; bounced: string; complained: string }>(sql`SELECT coalesce(sum(accepted),0)::text AS emails,coalesce(sum(bounced),0)::text AS bounced,coalesce(sum(complained),0)::text AS complained
      FROM sending_metrics_hourly WHERE workspace_id=ANY(${sql.param(change.workspaces)}::text[]) AND hour>now()-interval '7 days'`);
    const payload = slackCard(runtime.config.publicUrl, { cluster: change.id, band, score: change.score, kind, accounts: change.accounts, reasons: change.reasons, workspaces: change.workspaces,
      sent: { emails: Number(sent?.emails ?? 0), bounced: Number(sent?.bounced ?? 0), complained: Number(sent?.complained ?? 0) } });
    const { rows } = await tx.execute(sql`WITH alert AS (INSERT INTO abuse_alerts(id,cluster_id,band,score,kind,workspaces,payload,members,reasons)
      SELECT ${id},${change.id},${band},${change.score},${kind},${change.workspaces.length},${JSON.stringify(payload)}::jsonb,${keys}::text[],${codes}::text[]
      WHERE NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.cluster_id=${change.id} AND a.band=${band}::text AND ${recent})
        AND (cardinality(${workspaces}::text[])=0 OR EXISTS (SELECT FROM unnest(${workspaces}::text[]) w(key) WHERE NOT EXISTS (
          SELECT FROM abuse_alerts a WHERE ${recent} AND ${atLeast} AND w.key=ANY(a.members))))
        AND NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.review='watch' AND (a.cluster_id=${change.id} OR a.members @> ${keys}::text[]) AND ${atLeast})
        AND NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.review='dismiss' AND a.members @> ${keys}::text[] AND a.reasons @> ${codes}::text[])
      RETURNING id)
      INSERT INTO jobs(id,type,workspace_id,payload) SELECT ${jobId(sql`alert.id`)},${JOB},${PLATFORM},jsonb_build_object('alertId',alert.id) FROM alert
      ON CONFLICT (id) DO NOTHING RETURNING id`);
    return rows.length ? id : null;
  });
}
/** Posts in any hour, each level counted on its own: a burst of review alerts never holds up a high one. */
export const ALERTS_AN_HOUR = { review: 3, high: 10 } as const;
/** A post's answer may take this long; past it, whether Slack took the post is unknown. */
const POST_TIMEOUT_MS = 10_000;
/** After an unanswered post, the one more try waits this long (Slack is slow now). There is never a third. */
const AFTER_TIMEOUT_MS = 5 * 60_000;
/**
 * A 429 (Slack, or anything in front of it, limiting us) spends none of the alert's tries: it is not refused, only told
 * to wait. The wait is never under RATE_LIMIT_FLOOR_S, doubles with each 429 in a row up to RATE_LIMIT_CAP_S, is longer
 * when Retry-After asks for more, and never runs past the alert's day (FRESH), when it would be stale anyway. Slack's
 * incoming webhooks take about a message a second with short bursts, so a 429 that 30 seconds doesn't clear is the
 * webhook or something in front of it in trouble, not our pace; and a job told "now" (Retry-After: 0, or none) starts at
 * most twice a minute, then less often, down to four times an hour at the cap. From ABUSE.rateLimitedMost 429s in a row
 * (about half an hour) the alert keeps waiting at the cap but counts as not delivered in Health (health.ts). It never
 * turns into tries: a webhook that limits us is alive, so the alert can still go out while it matters, and spending
 * tries would fail it within the hour for good. A 429 posts nothing, so the at-most-two-posts rule is untouched.
 */
const RATE_LIMIT_FLOOR_S = 30, RATE_LIMIT_CAP_S = 15 * 60;
/** How long a 429 makes an alert wait: limited is its 429s in a row (this one included), left the seconds to its day's end. */
export const rateLimitWait = (retryAfter: number | undefined, limited: number, left: number) =>
  Math.max(1, Math.min(Math.max(retryAfter ?? 0, Math.min(RATE_LIMIT_FLOOR_S * 2 ** Math.max(0, limited - 1), RATE_LIMIT_CAP_S)), left));
/**
 * How many times the sweep gives an alert a new job after its job failed for good (a run of database failures before
 * the post, or a lease exhausted). At most once an hour, inside the alert's day: then it is failed, never forgotten.
 */
export const REQUEUES_MOST = 3;
/** An alert's job is live while it is waiting or running; any other (failed, completed, or none) holds nothing. */
const liveJob = (alert: SQL) => sql`EXISTS (SELECT FROM jobs j WHERE j.id=${jobId(alert)} AND j.status IN ('pending','running'))`;
/** How long an alert may wait to be posted: past it, it is stale ('expired'), never posted late. */
const FRESH = sql`interval '1 day'`;
export const STALE_REASONS = ['cluster_gone', 'band_dropped', 'reviewed', 'expired'] as const;
/** Why a stored alert no longer needs posting, or null: from the alert (a) and its cluster as it is now (c). */
const staleReason = sql`CASE WHEN c.id IS NULL THEN 'cluster_gone' WHEN NOT (c.band='high' OR (c.band='review' AND a.band='review')) THEN 'band_dropped'
  WHEN a.review IS NOT NULL THEN 'reviewed' WHEN a.created_at<=now()-${FRESH} THEN 'expired' END`;
/**
 * The alerts ahead of one in line for a place at its level: still stored, unclaimed, never refused (a refused one steps
 * out of line until its retry, so one bad post holds nobody up), with a live job (one whose job failed for good holds
 * no place until the sweep gives it a new one), still needing a look, and stored before it, the ID breaking a tie. One hourly run stores all its alerts at the same instant, so ties are the ordinary case: without the
 * ID, which of them posts now and which waits an hour would depend on the order their jobs happen to run in. Each level
 * has its own line and its own places, so a high alert never waits on a review one.
 */
const inLine = (band: 'review' | 'high', id: string) => sql`abuse_alerts a LEFT JOIN abuse_clusters c ON c.id=a.cluster_id
  WHERE a.band=${band} AND a.status='stored' AND a.claimed_at IS NULL AND a.attempts=0 AND a.id<>${id} AND ${liveJob(sql`a.id`)}
    AND (a.created_at,a.id)<(SELECT created_at,id FROM abuse_alerts WHERE id=${id}) AND (${staleReason}) IS NULL`;
/**
 * The hourly job's first stage, a few statements whatever the load: every stored alert that no longer needs a look is
 * marked stale with why, and every one that does has a live job: one is queued for an alert that has none (stored
 * before jobs posted them, or whose job could not be queued with it), and one whose job failed for good gets it back
 * (REQUEUES_MOST times; after that it is failed, error JOB:<the job's last error>, which Health counts). Returns how
 * many it marked stale, queued, queued again and failed.
 */
export async function sweepAlerts(runtime: Hosted) {
  return bounded(runtime, async tx => {
    const { rows: stale } = await tx.execute<{ id: string }>(sql`UPDATE abuse_alerts u SET status='stale',stale_reason=s.reason
      FROM (SELECT a.id,${staleReason} AS reason FROM abuse_alerts a LEFT JOIN abuse_clusters c ON c.id=a.cluster_id WHERE a.status='stored') s
      WHERE u.id=s.id AND s.reason IS NOT NULL RETURNING u.id`);
    const { rows: queued } = await tx.execute<{ id: string }>(sql`INSERT INTO jobs(id,type,workspace_id,payload)
      SELECT ${jobId(sql`a.id`)},${JOB},${PLATFORM},jsonb_build_object('alertId',a.id) FROM abuse_alerts a WHERE a.status='stored' ON CONFLICT (id) DO NOTHING RETURNING id`);
    // A job that failed for good (or finished without settling it) leaves its alert waiting with nothing to post it.
    const { rows: [again] } = await tx.execute<{ requeued: number; failed: number }>(sql`WITH orphan AS (
        SELECT a.id,a.requeues,j.last_error FROM abuse_alerts a JOIN jobs j ON j.id=${jobId(sql`a.id`)} WHERE a.status='stored' AND j.status NOT IN ('pending','running') FOR UPDATE OF a),
      given_up AS (UPDATE abuse_alerts u SET status='failed',posting=false,error=left('JOB:'||coalesce(o.last_error,'FAILED'),40) FROM orphan o WHERE u.id=o.id AND o.requeues>=${REQUEUES_MOST} RETURNING u.id),
      counted AS (UPDATE abuse_alerts u SET requeues=u.requeues+1 FROM orphan o WHERE u.id=o.id AND o.requeues<${REQUEUES_MOST} RETURNING u.id),
      requeued AS (UPDATE jobs j SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL FROM counted c
        WHERE j.id=${jobId(sql`c.id`)} AND j.status NOT IN ('pending','running') RETURNING j.id)
      SELECT (SELECT count(*)::int FROM requeued) AS requeued,(SELECT count(*)::int FROM given_up) AS failed`);
    if (again?.failed) log('warn', { code: 'ABUSE_ALERT_FAILED', reason: 'JOB_FAILED', alerts: again.failed });
    return { stale: stale.length, queued: queued.length, requeued: again?.requeued ?? 0, failed: again?.failed ?? 0 };
  });
}
/**
 * The abuse.alert job: posts one alert, once.
 * - In one transaction under one lock (every job of this type takes it, so two can never count the same free place):
 *   an alert already sent, stale or failed is left as it is; one that no longer needs a look is marked stale; without a
 *   webhook it is marked failed (NO_WEBHOOK); one whose post is in flight (claimed under 2 minutes ago, a post times out
 *   in POST_TIMEOUT_MS) waits for it; at its level's hourly limit the job waits (JobDeferred) until the oldest post of that
 *   level is an hour old; with alerts ahead of it in line (inLine) for the places left, it waits for them to take theirs.
 *   Otherwise it takes a place (claimed_at) and the post goes out after the commit. So which alerts go out in an hour
 *   and which wait is the same however their jobs are ordered: the oldest first, the ID breaking a tie.
 * - Accepted (2xx): marked sent. Refused (Slack answered 4xx or 5xx) or unreachable (no connection): its place is given
 *   back and the job retries (jobs.ts: 15 s, 1, 4, 16 minutes, then hourly), MAX_ATTEMPTS tries in all, the last
 *   marking it failed; a 429 waits instead (RATE_LIMIT_*), holding no worker and spending no try.
 * - Unanswered (no answer in POST_TIMEOUT_MS): Slack may have taken it, so it is never treated as refused. It keeps its
 *   place and is tried once more after AFTER_TIMEOUT_MS; a second unanswered post marks it unconfirmed (posted, perhaps
 *   twice, never again; Health counts it so someone looks at the channel). A missed alert is worse than a doubled one.
 * - A post whose answer was never recorded (its worker stopped after sending: a crash, a lease exhausted) counts as
 *   unanswered when the alert is next taken up, so it is the same rule: at most two posts, ever, whatever retries,
 *   overlapping runs or re-queued jobs follow (Slack's incoming webhooks take no idempotency key). A retry finds a sent
 *   alert and posts nothing.
 */
const deliver: JobHandler = async (runtime, payload, job) => {
  const id = typeof payload.alertId === 'string' && /^aal_[0-9a-f]{24}$/.test(payload.alertId) ? payload.alertId : null;
  if (!id) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid abuse alert job.');
  const url = runtime.config.abuseSlackWebhookUrl;
  type Decision = { post: unknown; band: 'review' | 'high'; cluster: string } | { wait: string } | null;
  const decision = await runtime.db.transaction(async (tx): Promise<Decision> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('abuse.alert', 0))`);
    // until: when its last post settles, if not yet (in flight: answer not recorded, under 2 minutes; unanswered: the
    // pause before its one more try).
    const { rows: [a] } = await tx.execute<{ status: string; band: 'review' | 'high'; cluster: string; payload: unknown; reason: string | null; until: string | null; posting: boolean; timeouts: number }>(sql`SELECT a.status,a.band,a.cluster_id AS cluster,a.payload,a.posting,a.timeouts,${staleReason} AS reason,
      CASE WHEN a.posting AND a.claimed_at>now()-interval '2 minutes' THEN ${utc(sql`(a.claimed_at+interval '2 minutes')`)}
        WHEN NOT a.posting AND a.timeouts>0 AND a.claimed_at>now()-make_interval(secs=>${AFTER_TIMEOUT_MS / 1000}) THEN ${utc(sql`(a.claimed_at+make_interval(secs=>${AFTER_TIMEOUT_MS / 1000}))`)} END AS until
      FROM abuse_alerts a LEFT JOIN abuse_clusters c ON c.id=a.cluster_id WHERE a.id=${id} FOR UPDATE OF a`);
    if (!a || a.status !== 'stored') return null;
    if (a.reason) { await tx.execute(sql`UPDATE abuse_alerts SET status='stale',stale_reason=${a.reason} WHERE id=${id}`); return null; }
    if (!url) { await tx.execute(sql`UPDATE abuse_alerts SET status='failed',error='NO_WEBHOOK' WHERE id=${id}`); log('warn', { code: 'ABUSE_ALERT_FAILED', reason: 'NO_WEBHOOK' }); return null; }
    // Its post is in flight (a run whose lease lapsed while it posted), or just went unanswered: wait, never post beside it.
    if (a.until) return { wait: a.until };
    // A post whose answer was never recorded (its worker stopped after sending) counts as unanswered: the second such
    // post is the last, so no crash, retry or re-queued job ever makes a third.
    const unanswered = a.timeouts + (a.posting ? 1 : 0);
    if (unanswered >= 2) {
      await tx.execute(sql`UPDATE abuse_alerts SET status='unconfirmed',timeouts=${unanswered},posting=false,error='TIMEOUT',sent_at=now() WHERE id=${id}`);
      log('warn', { code: 'ABUSE_ALERT_UNCONFIRMED' }); return null;
    }
    // The places taken at its level this hour, and the alerts ahead of it in line for one (inLine), whatever order their jobs run in.
    const { rows: [line] } = await tx.execute<{ taken: number; oldest: string | null; ahead: number }>(sql`SELECT count(*)::int AS taken,${utc(sql`min(claimed_at)`)} AS oldest,
      (SELECT count(*)::int FROM ${inLine(a.band, id)}) AS ahead FROM abuse_alerts WHERE band=${a.band} AND claimed_at>now()-interval '1 hour' AND id<>${id}`);
    const free = ALERTS_AN_HOUR[a.band] - (line?.taken ?? 0);
    if (free <= 0) return { wait: new Date(Date.parse(line!.oldest!) + 3_600_000 + 1000).toISOString() };
    // Its turn comes after theirs: they take the places left, and it waits for the next one.
    if ((line?.ahead ?? 0) >= free) return { wait: new Date(Date.now() + 30_000).toISOString() };
    await tx.execute(sql`UPDATE abuse_alerts SET claimed_at=now(),posting=true,timeouts=${unanswered} WHERE id=${id}`);
    return { post: a.payload, band: a.band, cluster: a.cluster };
  });
  if (!decision) return;
  // Waiting is not a try: the attempts its refused posts used are kept.
  if ('wait' in decision) { log('info', { code: 'ABUSE_ALERT_WAITING', until: decision.wait }); throw new JobDeferred(decision.wait, undefined, true); }
  // A high alert mentions the operator, decided once for the alert, so its one more try posts it the same way; one Slack
  // refuses with the mention goes again at once without it, and that post is the one judged below (operator-mention.ts).
  const mention = decision.band === 'high' ? await mentionFor(runtime, { id, kind: 'abuse_high', subject: decision.cluster }) : null;
  try { await sendMentioned(runtime, message => postSlack(url!, message, 'ABUSE_ALERT_FAILED', POST_TIMEOUT_MS), decision.post as Record<string, unknown> & { text: string }, mention, id); }
  catch (error) {
    if (!(error instanceof ApiError) && error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      // Unanswered: it keeps its place, and gets one more try after a pause; the second unanswered post is the last.
      const { rows: [after] } = await runtime.db.execute<{ status: string }>(sql`UPDATE abuse_alerts SET timeouts=timeouts+1,attempts=attempts+1,error='TIMEOUT',posting=false,limited=0,
        status=CASE WHEN timeouts+1>=2 THEN 'unconfirmed' ELSE status END,sent_at=CASE WHEN timeouts+1>=2 THEN now() ELSE sent_at END
        WHERE id=${id} AND status='stored' RETURNING status`);
      log('warn', { code: after?.status === 'unconfirmed' ? 'ABUSE_ALERT_UNCONFIRMED' : 'ABUSE_ALERT_TIMEOUT' });
      if (after?.status === 'stored') throw new JobDeferred(new Date(Date.now() + AFTER_TIMEOUT_MS).toISOString(), undefined, true);
      return;
    }
    const refused = error instanceof SlackRefused ? error : null;
    if (refused?.status === 429) {
      // Limited: the place goes back (a 429 posted nothing, so the hour's caps count it nowhere) and the job waits,
      // holding no worker and spending no try (RATE_LIMIT_*). Missing, zero, negative, unreadable or past Retry-After
      // all read as no ask (postSlack), so the floor and the doubling decide.
      const { rows: [row] } = await runtime.db.execute<{ limited: number; left: number }>(sql`UPDATE abuse_alerts SET claimed_at=NULL,posting=false,attempts=attempts+1,error='HTTP_429',limited=limited+1
        WHERE id=${id} AND status='stored' RETURNING limited,extract(epoch FROM created_at+${FRESH}-now())::float8 AS left`);
      if (!row) return;
      const wait = rateLimitWait(refused.retryAfterSeconds, row.limited, row.left);
      log('warn', { code: 'ABUSE_ALERT_LIMITED', limited: row.limited, wait: Math.round(wait) });
      throw new JobDeferred(new Date(Date.now() + wait * 1000).toISOString(), undefined, true);
    }
    // Refused or unreachable: the place goes back; the last try marks the alert failed (its job fails too).
    const last = job.attempts >= MAX_ATTEMPTS, code = refused ? `HTTP_${refused.status}` : error instanceof ApiError ? error.code : 'UNREACHABLE';
    await runtime.db.execute(sql`UPDATE abuse_alerts SET claimed_at=NULL,posting=false,limited=0,attempts=attempts+1,error=${code.slice(0, 40)},status=CASE WHEN ${last} THEN 'failed' ELSE status END WHERE id=${id} AND status='stored'`);
    log('warn', { code: 'ABUSE_ALERT_FAILED', reason: code, last });
    throw error instanceof ApiError ? error : new ApiError(503, 'ABUSE_ALERT_FAILED', 'The alert could not be posted; it will be retried.', undefined, true);
  }
  await runtime.db.execute(sql`UPDATE abuse_alerts SET status='sent',sent_at=now(),posting=false,attempts=attempts+1,error=NULL WHERE id=${id} AND status='stored'`);
};
export const abuseAlertJobs: Record<string, JobHandler> = { [JOB]: retryDatabaseFailures(deliver) };

const Review = z.object({ action: z.enum(['watch', 'dismiss']), at: z.string(), by: z.string().nullable().describe("The operator's sign-in address, while their account exists.") });
const Alert = z.object({ id: z.string(), clusterId: z.string(), band: z.enum(['review', 'high']), score: z.number().int(), kind: z.enum(['new', 'raised', 'grew']), workspaces: z.number().int(),
  status: z.enum(['stored', 'sent', 'failed', 'stale', 'unconfirmed']).describe('stale: no longer needed a look before it was posted (staleReason), so it never was. unconfirmed: Slack did not answer its post in time, twice; it may be in the channel, once or twice, and is not posted again.'), staleReason: z.enum(STALE_REASONS).nullable(), attempts: z.number().int(), createdAt: z.string(), sentAt: z.string().nullable(), payload: z.unknown().describe('The Slack message as it is, or would be, posted.'),
  review: Review.nullable().describe('watch: reviewed, raised again only at a higher level. dismiss: not abuse, raised again only with a member or a reason it did not have.') }).openapi('OperatorAbuseAlert');
const alertColumns = sql`a.id,a.cluster_id AS "clusterId",a.band,a.score,a.kind,a.workspaces,a.status,a.stale_reason AS "staleReason",a.attempts,${utc(sql`a.created_at`)} AS "createdAt",
  CASE WHEN a.sent_at IS NOT NULL THEN ${utc(sql`a.sent_at`)} END AS "sentAt",a.payload,
  CASE WHEN a.review IS NOT NULL THEN jsonb_build_object('action',a.review,'at',${utc(sql`a.reviewed_at`)},'by',u.email) END AS review`;
const alertFrom = sql`abuse_alerts a LEFT JOIN nightmail_users u ON u.id=a.reviewed_by`;
export function registerAbuseAlerts(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/abuse/alerts', operationId: 'operatorListAbuseAlerts',
    request: { query: z.object({ cluster: z.string().regex(/^acl_[0-9a-f]{24}$/).optional().describe("Only this cluster's alerts."),
      cursor: z.string().max(100).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|aal_[0-9a-f]{24}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(Alert), nextCursor: z.string().nullable(), delivery: z.enum(['slack', 'off']).describe('off: no Slack webhook is configured, so no alert can be posted (each is marked failed, NO_WEBHOOK).') })), ...errors } }), async c => {
    // Newest first; among alerts stored together (one hourly run stores its alerts at one instant) high ones first, then
    // by ID. The cursor is the last row's exact time (to the microsecond) and ID; its band is read from that row, so a
    // page never skips or repeats one of a run's alerts.
    const operator = await operatorActor(c, 'operator:read'), q = c.req.valid('query'), [after, afterId] = q.cursor?.split('|') ?? [];
    await accessed(c, operator, 'abuse.alerts', q.cluster);
    const { rows } = await c.env.db.execute<z.infer<typeof Alert>>(sql`SELECT ${alertColumns} FROM ${alertFrom} WHERE true ${q.cluster ? sql`AND a.cluster_id=${q.cluster}` : sql``}
      ${after ? sql`AND (a.created_at,a.band='high',a.id)<(${after}::timestamptz,coalesce((SELECT band='high' FROM abuse_alerts WHERE id=${afterId}),false),${afterId})` : sql``}
      ORDER BY a.created_at DESC,a.band='high' DESC,a.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.createdAt}|${last.id}` : null, delivery: c.env.config.abuseSlackWebhookUrl ? 'slack' as const : 'off' as const }, 200);
  });
  // Watch or Dismiss, by an operator: recorded on the alert (who, when) and in the staff audit. A queued alert so reviewed
  // is not posted. Deciding again replaces the decision.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/abuse/alerts/{id}/review', operationId: 'operatorReviewAbuseAlert',
    request: { params: z.object({ id: z.string().regex(/^aal_[0-9a-f]{24}$/) }), body: json(z.object({ action: z.enum(['watch', 'dismiss']) }).strict()) },
    responses: { 200: response(Alert), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator'), id = c.req.valid('param').id, { action } = c.req.valid('json');
    const alert = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<{ cluster_id: string; previous: string | null }>(sql`UPDATE abuse_alerts a SET review=${action},reviewed_by=${operator.userId},reviewed_at=now()
        FROM (SELECT id,review FROM abuse_alerts WHERE id=${id} FOR UPDATE) old WHERE a.id=old.id RETURNING a.cluster_id,old.review AS previous`);
      if (!row) notFound('Alert');
      await recordAudit(tx, operatorContext(c, { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId }),
        { action: `abuse.alert_${action}`, workspaceId: null, target: { type: 'abuse_alert', id }, details: { cluster: row!.cluster_id, previous: row!.previous }, internal: true });
      return (await tx.execute<z.infer<typeof Alert>>(sql`SELECT ${alertColumns} FROM ${alertFrom} WHERE a.id=${id}`)).rows[0]!;
    });
    return c.json(alert, 200);
  });
}
