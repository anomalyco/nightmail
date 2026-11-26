import { sql } from 'drizzle-orm';
import { ApiError, id, isSimulatedSes, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { enqueue, JobDeferred, retryDatabaseFailures } from './jobs.js';
import { deliverNotice, evaluationFinished, noticeRecipients } from './account-notices.js';
import { customerNotice, type NoticeInput } from './notices.js';
import { queueTenantStatus, resumeHostedConnection, tenantStatusDrift, terminalColumns, terminalEvents, type HostedCaps } from './states.js';
import { dailyLimit, ESTABLISHED, GOOD_STANDING, establishedBy, EVALUATION, evaluated, FREEZE_FLOOR, GROWTH, moveScore, nextGrowth, nextStanding, noticeReasons, quality, stepRank, type DayEvidence, type GrowthHour, type DomainAuth, type Factor, type LadderInput, type Reason, type ScoreState, type Step, type TrackRecord, type Window } from './standing-model.js';
import { DISPLAY_SCORE_ID_PREFIX, DISPLAY_SCORE_JOB } from './sender-score.js';
import { productName } from './brand.js';
import { checkSignInMail, standingAlert } from './operator-alerts.js';

// The standing job: every ten minutes it counts each Hosted workspace's mail, moves its score, sets the daily limit
// admission reads (none in good standing), and walks the ladder (notice → warn → restrict → pause). Every change of standing, by the job, an
// owner or an operator, goes through applyChange: one transaction writes the row, its event, the webhook, the owner
// email and, for a pause or resume, the connection hold and the SES tenant switch.

export type StandingActor = { kind: 'system' | 'owner' | 'operator'; id?: string | null; via?: 'job' | 'dashboard' | 'console' | 'script' | 'ses' };
export type StandingRow = {
  workspace_id: string; phase: ScoreState['phase']; first_recipients: number; calibrated_at: string | null; score: string | null; day_score: string | null; score_day: string | null;
  target: string; quality: string; volume: number; factors: Factor[]; band_limit: number | null; daily_limit: number | null; step: Step; reasons: Reason[]; since: string; clear_since: string | null;
  pause_kind: 'bounce' | 'full' | null; marketing_hold: boolean; release_until: string | null; release_percent: number | null; last_release_at: string | null; last_self_resume_at: string | null;
  strikes: { at: string; reason: string; kind: string }[]; strike_until: string | null; watch: boolean; notified: Record<string, string>; evidence_at: string | null; computed_at: string | null; version: number; sequence: number;
  growth_until: string | null; growth_cap: number | null; growth_hour: string | null; growth_quality: string | null; history_before: string | null;
};
export type Change = {
  workspaceId: string; actor: StandingActor; kind: 'step' | 'limit' | 'quarantine' | 'release' | 'tenant' | 'operator';
  expectVersion?: number; step?: Step; reasons?: Reason[]; pauseKind?: 'bounce' | 'full' | null;
  /** Stop all sending (connection hold, SES tenants disabled). The message is the 409 HOSTED_SENDING_PAUSED text. */
  pause?: { message: string };
  /**
   * Lift the connection hold: min(current limit, percent of the limit before it) for 48 hours (src/states.ts,
   * resumeConnection); optionally hold marketing for a while. `caps` are the installation's limit tiers.
   */
  resume?: { percent: 50 | 100; marketingHours?: number; caps: HostedCaps };
  marketingHold?: boolean; release?: { percent: number; hours: number }; watch?: boolean;
  touch?: { lastRelease?: boolean; lastSelfResume?: boolean };
  details?: Record<string, unknown>; requestId?: string;
};
export const STANDING_EVENT = 'account.standing.changed';
const STRIKE_DAYS = 90;
// Only an actual birth retires a display. The same transaction fences a stale publisher without ever writing
// display evidence to real standing. The worker also hides/completes a private job if it sees real standing.
const retireDisplayAtBirth = sql`DELETE FROM jobs j USING created c
  WHERE j.id=${DISPLAY_SCORE_ID_PREFIX}||c.workspace_id AND j.workspace_id=c.workspace_id AND j.type=${DISPLAY_SCORE_JOB}`;

/** One transaction: lock the standing, check If-Match, write the change, its event and every side effect. */
export async function applyChange(db: DbExecutor, change: Change): Promise<{ eventId: string; version: number; sequence: number; step: Step; previousStep: Step } | null> {
  const wid = change.workspaceId;
  await db.execute(sql`WITH created AS (INSERT INTO sender_standing(workspace_id,daily_limit,band_limit) SELECT workspace_id,${EVALUATION.limit}::int,${EVALUATION.limit}::int FROM provider_connections WHERE workspace_id=${wid} AND kind='shared' ON CONFLICT DO NOTHING RETURNING workspace_id) ${retireDisplayAtBirth}`);
  // A pause that is resuming (waiting for its SES tenants to be enabled again) counts as lifted: a new pause re-arms it.
  const [row] = (await db.execute<StandingRow & { paused_at: string | null; held: boolean; exempt: boolean; connection_id: string }>(sql`SELECT s.*,CASE WHEN pc.resume_pending_at IS NULL THEN pc.paused_at END AS paused_at,
    pc.marketing_held_at IS NOT NULL AS held,w.exempt_hosted_quotas AS exempt,pc.id AS connection_id FROM sender_standing s
    JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared' JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=${wid} FOR UPDATE OF s,pc`)).rows;
  if (!row) return null;
  if (change.expectVersion !== undefined && change.expectVersion !== row.version) throw new ApiError(412, 'STANDING_VERSION_CHANGED', `The standing changed since version ${change.expectVersion} (now ${row.version}). Reload and try again.`);
  const now = new Date(), at = now.toISOString(), previousStep = row.step;
  const step = change.step ?? (change.pause ? 'pause' : row.step);
  const strikes = row.strikes.filter(s => Date.parse(s.at) > now.getTime() - STRIKE_DAYS * 86_400_000);
  if (change.pause && !row.paused_at) strikes.push({ at, reason: change.reasons?.[0]?.code ?? 'PAUSED', kind: change.pauseKind ?? 'full' });
  // The second strike in 90 days caps the limit at half for 7 days after the resume.
  const strikeUntil = change.resume && strikes.length >= 2 ? new Date(now.getTime() + 7 * 86_400_000).toISOString() : row.strike_until;
  // A new rise ends an owner's marketing release: the restrict (or pause) holds marketing again.
  const escalated = stepRank(step) > stepRank(previousStep) && stepRank(step) >= stepRank('restrict');
  const releaseUntil = change.release ? new Date(now.getTime() + change.release.hours * 3600_000).toISOString() : change.resume?.marketingHours || escalated ? null : step === 'ok' || step === 'notice' ? null : row.release_until;
  const marketingHold = change.marketingHold ?? (change.resume?.marketingHours ? true : row.marketing_hold);
  const reasons = change.reasons ?? (step === row.step ? row.reasons : []);
  const sequence = Number(row.sequence) + 1, version = row.version + 1, eventId = id('stev');
  await db.execute(sql`UPDATE sender_standing SET step=${step},reasons=${JSON.stringify(reasons)}::jsonb,since=${step !== row.step ? at : row.since}::timestamptz,
    clear_since=${step !== row.step ? null : row.clear_since}::timestamptz,pause_kind=${step === 'pause' ? change.pauseKind ?? row.pause_kind ?? 'full' : null},
    marketing_hold=${marketingHold},release_until=${releaseUntil}::timestamptz,release_percent=${change.release?.percent ?? (releaseUntil ? row.release_percent : null)}::smallint,
    last_release_at=${change.touch?.lastRelease ? at : row.last_release_at}::timestamptz,last_self_resume_at=${change.touch?.lastSelfResume ? at : row.last_self_resume_at}::timestamptz,
    strikes=${JSON.stringify(strikes)}::jsonb,strike_until=${strikeUntil}::timestamptz,watch=${change.watch ?? row.watch},
    version=${version},sequence=${sequence} WHERE workspace_id=${wid}`);
  // A workspace without a daily limit gets a concrete one as it enters a step from warn up, a pause or a resume
  // (hosted_freeze: what SES accepted in 24 hours, at least the floor), so the resume's 50% below and a strike's half
  // always have a number and admission reads it at once.
  if (!row.exempt && (stepRank(step) >= stepRank('warn') || change.pause || change.resume)) await db.execute(sql`SELECT hosted_freeze(${wid},${FREEZE_FLOOR})`);
  // A pause bumps the tenant generation, so the SES tenant job disables the tenants even if a resume was in flight.
  if (change.pause && !row.paused_at) {
    await db.execute(sql`UPDATE provider_connections SET paused_at=clock_timestamp(),pause_reason=${change.pause.message},resume_pending_at=NULL,tenant_generation=tenant_generation+1 WHERE id=${row.connection_id}`);
    await db.execute(queueTenantStatus(sql`SELECT ${wid}::text AS workspace_id`));
  }
  let resumed: { pending: boolean; base: number | null; restore_cap: number | null } | undefined;
  if (change.resume && row.paused_at) {
    [resumed] = (await db.execute<{ pending: boolean; base: number | null; restore_cap: number | null }>(resumeHostedConnection(wid, change.resume.percent, change.resume.caps))).rows;
    // A marketing hold after a self-resume ends by itself: the job releases it once release_until passes.
    if (change.resume.marketingHours) await db.execute(sql`UPDATE sender_standing SET release_until=clock_timestamp()+make_interval(hours=>${change.resume.marketingHours}),release_percent=NULL WHERE workspace_id=${wid}`);
  }
  // A marketing hold placed by the hourly check before the standing shipped ends here: a restrict or pause now holds
  // marketing instead, and a release or resume lifts it with the step.
  if (row.held && (row.exempt || stepRank(step) >= stepRank('restrict') || change.release || change.resume)) await db.execute(sql`UPDATE provider_connections SET marketing_held_at=NULL,marketing_hold_reason=NULL WHERE id=${row.connection_id}`);
  const actor = { kind: change.actor.kind, ...(change.actor.id ? { id: change.actor.id } : {}), via: change.actor.via ?? (change.actor.kind === 'system' ? 'job' : 'dashboard') };
  const details = { ...change.details, ...(change.pause ? { paused: true } : {}),
    ...(change.resume ? { resumed: { percent: change.resume.percent, marketingHours: change.resume.marketingHours, limitBefore: resumed?.base ?? null, restoreCap: resumed?.restore_cap ?? null, waitsForTenants: resumed?.pending ?? false } } : {}),
    ...(change.release ? { release: change.release } : {}),
    ...(change.marketingHold !== undefined ? { marketingHold: change.marketingHold } : {}), strikes: strikes.length };
  await db.execute(sql`INSERT INTO standing_events(id,workspace_id,sequence,at,kind,from_step,to_step,reasons,actor,details)
    VALUES(${eventId},${wid},${sequence},${at}::timestamptz,${change.kind},${previousStep},${step},${JSON.stringify(reasons)}::jsonb,${JSON.stringify(actor)}::jsonb,${JSON.stringify(details)}::jsonb)`);
  // Operators hear in Slack about a rise to a marketing hold or a pause, Amazon's included (src/operator-alerts.ts).
  if (stepRank(step) > stepRank(previousStep)) await standingAlert(db, wid, step, reasons, change.details);
  // Customers see every change of step, a campaign quarantine and an owner's or operator's release on their own webhooks.
  if (step !== previousStep || change.kind === 'quarantine' || change.kind === 'release') {
    const data = { step, previousStep, reasons: reasons.map(({ code, metric, value, count, threshold, minimum, window, message }) => ({ code, metric, value, count, threshold, minimum, window, message })),
      since: step !== previousStep ? at : row.since, version, sequence, actor: { kind: actor.kind }, change: change.kind, marketingHeld: (stepRank(step) >= stepRank('restrict') && !change.release) || marketingHold };
    await enqueue(db, { type: 'operation.publish', workspaceId: wid, payload: { event: { id: `evt_standing_${eventId.slice(5)}`, type: STANDING_EVENT, createdAt: at, workspaceId: wid, region: null, data } } });
  }
  // Owners and admins hear about a rise to warn or above, at most once per step per 24 hours. A warning and a campaign's
  // pause wait NOTICE_WAIT_MINUTES before they are sent, so the job can see what else the same problem did and send
  // only the most serious email (notifyJob).
  const last = row.notified[step], later = new Date(now.getTime() + NOTICE_WAIT_MINUTES * 60_000).toISOString();
  if (stepRank(step) > stepRank(previousStep) && stepRank(step) >= stepRank('warn') && (!last || now.getTime() - Date.parse(last) >= 86_400_000)) {
    await db.execute(sql`UPDATE sender_standing SET notified=notified||jsonb_build_object(${step}::text,${at}::text) WHERE workspace_id=${wid}`);
    await enqueue(db, { type: 'standing.notify', workspaceId: wid, payload: { eventId }, ...(step === 'warn' ? { availableAt: later } : {}) });
  }
  // The end of a pause is told once, and only when its start was (a pause inside the 24 hours above started silently).
  const told = row.notified.pause, ended = row.notified.resumed;
  if (previousStep === 'pause' && step !== 'pause' && told && !(ended && ended > told)) {
    await db.execute(sql`UPDATE sender_standing SET notified=notified||jsonb_build_object('resumed',${at}::text) WHERE workspace_id=${wid}`);
    await enqueue(db, { type: 'standing.notify', workspaceId: wid, payload: { eventId, notice: 'resumed' } });
  }
  if (change.kind === 'quarantine') await enqueue(db, { type: 'standing.notify', workspaceId: wid, payload: { eventId }, availableAt: later });
  return { eventId, version, sequence, step, previousStep };
}

// ---------- the job ----------
type Candidate = StandingRow & { connection_id: string; paused_at: string | null; pause_reason: string | null; marketing_hold_reason: string | null; legacy_hold: boolean; exempt: boolean; screened_workspace: boolean; accepted_total: number; accepted_day: number;
  sponsor_key: string; pace: number | null; override: boolean;
  days: DayEvidence[] | null; domains: DomainAuth[] | null; win: { day: Window; week: Window } | null; screen: { screened: number; rejected: number } | null };
const MAIL_ACCEPTED = sql`e.status<>'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR e.event_outcomes & 1 <> 0)`;
// Only real Hosted mail is evidence: never simulated runs, mail only to the SES mailbox simulator, or mail the workspace
// sent through its own (BYO) account before (the unit is one email, in numerator and denominator alike).
const MAIL_REAL = sql`NOT e.simulated AND hosted_real_cost(e.to_addresses||e.cc_addresses||e.bcc_addresses)>0
  AND (e.feedback_topic_arn IS NULL OR EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn=e.feedback_topic_arn AND h.kind='shared'))`;
/**
 * Counts each due workspace's mail per UTC day: 30 days the first time, then the last 8 (late feedback). Hourly, or every
 * five minutes during the evaluation, so its recipients are graded soon after their results are in.
 */
async function refreshEvidence(db: DbExecutor, limit: number) {
  const { rows: [r] } = await db.execute<{ n: number }>(sql`WITH due AS (
      SELECT workspace_id,evidence_at FROM sender_standing WHERE evidence_at IS NULL OR evidence_at<now()-CASE WHEN phase='calibrating' THEN interval '5 minutes' ELSE interval '1 hour' END
      ORDER BY evidence_at NULLS FIRST LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), mail AS (
      SELECT d.workspace_id,(e.created_at AT TIME ZONE 'UTC')::date AS day,${MAIL_ACCEPTED} AS accepted,
        (e.status='delivered' OR e.event_outcomes & 2 <> 0) AS delivered,(e.status='bounced' OR e.event_outcomes & 4 <> 0) AS bounced,
        (e.status='complained' OR e.event_outcomes & 8 <> 0) AS complained,e.status='suppressed' AS suppressed,
        e.campaign_id IS NOT NULL AS first_send,coalesce(e.snapshot->>'kind'='marketing' OR e.campaign_id IS NOT NULL OR e.snapshot ? 'bulk',false) AS marketing,e.event_outcomes & 32 <> 0 AS clicked
      FROM due d JOIN sending_emails e ON e.workspace_id=d.workspace_id AND ${MAIL_REAL}
        AND e.created_at>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END
    ), days AS (
      SELECT workspace_id,day,count(*)::int AS emails,count(*) FILTER (WHERE accepted)::int AS accepted,count(*) FILTER (WHERE delivered)::int AS delivered,
        count(*) FILTER (WHERE bounced)::int AS bounced,count(*) FILTER (WHERE accepted AND first_send)::int AS first_sends,count(*) FILTER (WHERE bounced AND first_send)::int AS first_bounced,
        count(*) FILTER (WHERE complained)::int AS complained,count(*) FILTER (WHERE suppressed AND first_send)::int AS suppressed,
        count(*) FILTER (WHERE delivered AND marketing)::int AS marketing_delivered,count(*) FILTER (WHERE clicked AND marketing)::int AS clicked
      FROM mail GROUP BY 1,2
    ), screen AS (
      -- What the screen judged, by the day it judged it (src/dispatcher.ts): mail it never saw does not dilute the rate.
      SELECT d.workspace_id,(v.hour AT TIME ZONE 'UTC')::date AS day,sum(v.screened)::int AS screened,sum(v.rejected)::int AS rejected FROM due d JOIN hosted_screen_hourly v ON v.workspace_id=d.workspace_id
        AND v.hour>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END GROUP BY 1,2
    ), unsub AS (
      -- People, not decisions: one who leaves two topics and then everything (src/topics.ts) is one unsubscribe that day.
      -- Read index-only (migration 545 carries the contact) and made distinct by hash, not by sorting each day's rows.
      SELECT workspace_id,day,count(*)::int AS n FROM (SELECT DISTINCT a.workspace_id,(a.occurred_at AT TIME ZONE 'UTC')::date AS day,a.contact_id FROM due d JOIN audience_consent_audit a ON a.workspace_id=d.workspace_id AND a.status='unsubscribed'
        AND a.source IN ('footer-confirm','rfc8058-post','ses-subscription','preferences') AND a.occurred_at>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END) people
      GROUP BY 1,2
    ), parts AS (
      SELECT workspace_id,day,emails,accepted,delivered,bounced,first_sends,first_bounced,complained,0 AS screened,0 AS rejected,suppressed,marketing_delivered,0 AS unsubscribed,clicked FROM days
      UNION ALL SELECT workspace_id,day,0,0,0,0,0,0,0,screened,rejected,0,0,0,0 FROM screen
      UNION ALL SELECT workspace_id,day,0,0,0,0,0,0,0,0,0,0,0,n,0 FROM unsub
    ), upserted AS (
      INSERT INTO sender_score_daily AS s(workspace_id,day,emails,accepted,delivered,bounced,first_sends,first_bounced,complained,screened,rejected,suppressed,marketing_delivered,unsubscribed,clicked)
      SELECT workspace_id,day,sum(emails)::int,sum(accepted)::int,sum(delivered)::int,sum(bounced)::int,sum(first_sends)::int,sum(first_bounced)::int,sum(complained)::int,sum(screened)::int,
        sum(rejected)::int,sum(suppressed)::int,sum(marketing_delivered)::int,sum(unsubscribed)::int,sum(clicked)::int
      FROM parts GROUP BY 1,2 ORDER BY 1,2
      ON CONFLICT(workspace_id,day) DO UPDATE SET (emails,accepted,delivered,bounced,first_sends,first_bounced,complained,screened,rejected,suppressed,marketing_delivered,unsubscribed,clicked)=
        (excluded.emails,excluded.accepted,excluded.delivered,excluded.bounced,excluded.first_sends,excluded.first_bounced,excluded.complained,excluded.screened,excluded.rejected,excluded.suppressed,excluded.marketing_delivered,excluded.unsubscribed,excluded.clicked)
    ), marked AS (UPDATE sender_standing s SET evidence_at=now() FROM due d WHERE s.workspace_id=d.workspace_id)
    SELECT count(*)::int AS n FROM due`);
  return r?.n ?? 0;
}

/**
 * One completed hour of a sponsor's growing workspaces (the growth pace's evidence): real recipients of the mail SES
 * accepted in it (by its acceptance events), how many distinct ones (repeating a recipient grows nothing), and how many
 * of them have a delivery result, bounced or complained. Bounded by the allowance it can raise (src/standing-model.ts GROWTH).
 */
async function growthHour(runtime: Runtime, key: string, hour: string): Promise<GrowthHour> {
  const { rows: [r] } = await runtime.db.execute<GrowthHour>(sql`WITH members AS (
      SELECT w.id FROM workspaces w JOIN sender_standing s ON s.workspace_id=w.id AND s.growth_until>now() WHERE coalesce(w.quota_sponsor,w.id)=${key}
    ), accepted AS (
      SELECT DISTINCT v.workspace_id,v.email_id FROM members m JOIN sending_email_events v ON v.workspace_id=m.id AND v.created_at>=${hour}::timestamptz
        AND v.created_at<${hour}::timestamptz+interval '1 hour' AND v.type IN ('accepted','send') AND NOT v.simulated
    ), recipients AS (
      SELECT lower(x) AS address,(e.status='delivered' OR e.event_outcomes & 2 <> 0) AS delivered,(e.status='bounced' OR e.event_outcomes & 4 <> 0) AS bounced,
        (e.status='complained' OR e.event_outcomes & 8 <> 0) AS complained
      FROM accepted a JOIN sending_emails e ON e.workspace_id=a.workspace_id AND e.id=a.email_id AND NOT e.simulated
      CROSS JOIN LATERAL jsonb_array_elements_text(e.to_addresses||e.cc_addresses||e.bcc_addresses) x WHERE lower(x) NOT LIKE '%@simulator.amazonses.com'
    ) SELECT count(*)::int AS accepted,count(DISTINCT address)::int AS "distinct",count(*) FILTER (WHERE delivered OR bounced)::int AS resolved,
      count(*) FILTER (WHERE bounced)::int AS bounces,count(*) FILTER (WHERE complained)::int AS complaints FROM recipients`);
  return { accepted: r?.accepted ?? 0, distinct: r?.distinct ?? 0, resolved: r?.resolved ?? 0, bounces: r?.bounces ?? 0, complaints: r?.complaints ?? 0 };
}

/**
 * A workspace's track record before `cutoff` (src/standing-model.ts ESTABLISHED): real mail by its SES acceptance
 * events (never its admission time), in the 30 completed UTC days before the cutoff, leaving out its first
 * EVALUATION.recipients acceptances (the evaluation's seeds), per real recipient.
 */
async function trackRecord(runtime: Runtime, wid: string, cutoff: string): Promise<TrackRecord> {
  const { rows: [r] } = await runtime.db.execute<TrackRecord>(sql`WITH accepted AS (
      SELECT v.email_id,min(v.created_at) AS at FROM sending_email_events v WHERE v.workspace_id=${wid} AND v.created_at<${cutoff}::timestamptz
        AND v.type IN ('accepted','send') AND NOT v.simulated GROUP BY v.email_id
    ), real AS (
      SELECT a.at,e.* FROM accepted a JOIN sending_emails e ON e.workspace_id=${wid} AND e.id=a.email_id AND ${MAIL_REAL}
    ), counted AS (
      SELECT * FROM real ORDER BY at,id OFFSET ${EVALUATION.recipients}
    ), recipients AS (
      SELECT (c.at AT TIME ZONE 'UTC')::date AS day,lower(x) AS address,(c.status='delivered' OR c.event_outcomes & 2 <> 0) AS delivered,(c.status='bounced' OR c.event_outcomes & 4 <> 0) AS bounced,
        (c.status='complained' OR c.event_outcomes & 8 <> 0) AS complained
      FROM counted c CROSS JOIN LATERAL jsonb_array_elements_text(c.to_addresses||c.cc_addresses||c.bcc_addresses) x
      WHERE c.at>=date_trunc('day',${cutoff}::timestamptz,'UTC')-make_interval(days=>${ESTABLISHED.windowDays}) AND c.at<date_trunc('day',${cutoff}::timestamptz,'UTC')
        AND lower(x) NOT LIKE '%@simulator.amazonses.com'
    ) SELECT count(DISTINCT day)::int AS days,count(DISTINCT address)::int AS recipients,count(DISTINCT split_part(address,'@',2))::int AS domains,count(*)::int AS accepted,
      count(*) FILTER (WHERE delivered OR bounced)::int AS resolved,count(*) FILTER (WHERE bounced)::int AS bounces,count(*) FILTER (WHERE complained)::int AS complaints FROM recipients`);
  return { days: r?.days ?? 0, recipients: r?.recipients ?? 0, domains: r?.domains ?? 0, accepted: r?.accepted ?? 0, resolved: r?.resolved ?? 0, bounces: r?.bounces ?? 0, complaints: r?.complaints ?? 0 };
}

const PAUSE_LEAD: Record<Reason['metric'], string> = { complaints: 'high spam-complaint rate', screen: 'the content screen rejected a high share of mail',
  transactional_bounces: 'high hard-bounce rate on transactional mail', bounces: 'high hard-bounce rate', marketing_bounces: 'high hard-bounce rate on marketing mail', external: 'paused' };
const zero: Window = { accepted: 0, bounces: 0, complaints: 0, marketingAccepted: 0, marketingBounces: 0, marketingComplaints: 0 };
/** Workspaces worth a look: recent mail or feedback, a step, a moving score, calibration, or six hours since the last run. */
async function candidates(runtime: Runtime, limit: number, only?: string) {
  const screened = Boolean(runtime.config.screen && runtime.config.hostedScreen);
  return (await runtime.db.execute<Candidate>(sql`WITH c AS (
      SELECT s.* FROM sender_standing s WHERE ${only ? sql`s.workspace_id=${only}` : sql`(s.computed_at IS NULL OR s.computed_at<now()-interval '6 hours' OR s.step<>'ok' OR s.reasons<>'[]'::jsonb OR s.phase='seed' OR (s.phase='calibrating' AND s.calibrated_at IS NOT NULL)
        OR s.score IS DISTINCT FROM s.target OR s.evidence_at>s.computed_at OR s.release_until IS NOT NULL OR s.strike_until IS NOT NULL
        OR EXISTS (SELECT FROM hosted_usage_hourly u WHERE u.workspace_id=s.workspace_id AND u.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours')
        OR EXISTS (SELECT FROM hosted_health_hourly h WHERE h.workspace_id=s.workspace_id AND h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours')
        OR EXISTS (SELECT FROM hosted_screen_hourly v WHERE v.workspace_id=s.workspace_id AND v.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours')
        OR EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id=s.workspace_id AND pc.kind='shared' AND (pc.marketing_held_at IS NOT NULL OR pc.paused_at IS NOT NULL)))`}
      ORDER BY s.computed_at NULLS FIRST LIMIT ${limit})
    SELECT c.*,pc.id AS connection_id,CASE WHEN pc.resume_pending_at IS NULL THEN pc.paused_at END AS paused_at,pc.pause_reason,
      pc.marketing_held_at IS NOT NULL AS legacy_hold,pc.marketing_hold_reason,(SELECT exempt_hosted_quotas FROM workspaces WHERE id=c.workspace_id) AS exempt,${screened} AND pc.kind='shared' AS screened_workspace,
      (SELECT coalesce(sum(accepted),0)::int FROM sender_score_daily d WHERE d.workspace_id=c.workspace_id) AS accepted_total,
      -- What SES accepted in the rolling 24 hours: what a ladder step freezes a workspace without a limit at.
      hosted_accepted_day(c.workspace_id) AS accepted_day,(SELECT coalesce(quota_sponsor,id) FROM workspaces WHERE id=c.workspace_id) AS sponsor_key,hosted_minute_cap(c.workspace_id) AS pace,
      EXISTS (SELECT FROM workspaces WHERE id=c.workspace_id AND send_cap_override IS NOT NULL AND (send_cap_override_expires_at IS NULL OR send_cap_override_expires_at>now())) AS override,
      (SELECT json_agg(d ORDER BY d.day) FROM sender_score_daily d WHERE d.workspace_id=c.workspace_id AND d.day>=(now() AT TIME ZONE 'UTC')::date-180) AS days,
      (SELECT json_agg(json_build_object('name',name,'dkim',identity #>> '{ses,DkimAttributes,Status}'='SUCCESS' AND identity #>> '{ses,DkimAttributes,SigningEnabled}'='true',
        'mailFrom',identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS','dmarc',identity #>> '{dmarc,status}','emails',0))
        FROM domain_claims WHERE workspace_id=c.workspace_id AND sending_state='verified') AS domains,
      (SELECT json_build_object(
        'day',json_build_object('accepted',coalesce(sum(h.accepted) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours'),0),
          'bounces',coalesce(sum(h.bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'complaints',coalesce(sum(h.complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'marketingAccepted',coalesce(sum(h.marketing_accepted) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours'),0),
          'marketingBounces',coalesce(sum(h.marketing_bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'marketingComplaints',coalesce(sum(h.marketing_complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0)),
        'week',json_build_object('accepted',coalesce(sum(h.accepted),0),
          'bounces',coalesce(sum(h.bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'complaints',coalesce(sum(h.complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'marketingAccepted',coalesce(sum(h.marketing_accepted),0),
          'marketingBounces',coalesce(sum(h.marketing_bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'marketingComplaints',coalesce(sum(h.marketing_complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0)))
        FROM hosted_health_hourly h WHERE h.workspace_id=c.workspace_id AND h.epoch=coalesce(pc.resumed_at,'-infinity') AND h.hour>=date_trunc('hour',now(),'UTC')-interval '191 hours') AS win,
      -- Screen verdicts in the current epoch, counted when the dispatcher's screen judged the mail (src/dispatcher.ts).
      (SELECT json_build_object('screened',coalesce(sum(v.screened),0),'rejected',coalesce(sum(v.rejected),0)) FROM hosted_screen_hourly v
        WHERE v.workspace_id=c.workspace_id AND v.epoch=coalesce(pc.resumed_at,'-infinity') AND v.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours') AS screen
    FROM c JOIN provider_connections pc ON pc.workspace_id=c.workspace_id AND pc.kind='shared'`)).rows;
}

function ladderInput(row: Pick<Candidate, 'win' | 'screen'>): LadderInput {
  const n = (w: Window | undefined) => Object.fromEntries(Object.entries(w ?? zero).map(([k, v]) => [k, Number(v)])) as Window;
  return { day: n(row.win?.day), week: n(row.win?.week), screened: Number(row.screen?.screened ?? 0), rejected: Number(row.screen?.rejected ?? 0) };
}
/** The live 24-hour and 7-day figures for one workspace (an owner's release re-checks them). */
export async function liveLadder(runtime: Runtime, wid: string) {
  const [row] = await candidates(runtime, 1, wid);
  return row ? ladderInput(row) : null;
}
/**
 * One run: count due workspaces' mail, then move each candidate's score, limit and step. A step change (or a pause the
 * connection already has) goes through applyChange; everything else is one batched update. Returns what changed.
 */
export async function refreshStanding(runtime: Runtime, options: { now?: Date; only?: string; limit?: number } = {}) {
  if (!runtime.config.multiTenant) return { evaluated: 0, changed: 0 };
  const now = options.now ?? new Date(), limit = options.limit ?? 500;
  // A new workspace starts in its evaluation, at its limit (not the column's default, 100, which predates it).
  await runtime.db.execute(sql`WITH created AS (INSERT INTO sender_standing(workspace_id,daily_limit,band_limit) SELECT workspace_id,${EVALUATION.limit}::int,${EVALUATION.limit}::int FROM provider_connections WHERE kind='shared' ${options.only ? sql`AND workspace_id=${options.only}` : sql``} ON CONFLICT DO NOTHING RETURNING workspace_id) ${retireDisplayAtBirth}`);
  await refreshEvidence(runtime.db, options.only ? 1 : 200);
  const rows = await candidates(runtime, limit, options.only);
  const today = now.toISOString().slice(0, 10), routine: Record<string, unknown>[] = [];
  const lastHour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000 - 3600_000).toISOString();
  const finished: { workspaceId: string; limited: boolean }[] = [];
  let changed = 0;
  for (const row of rows) {
    const q = quality(row.days ?? [], row.domains ?? [], row.screened_workspace, today);
    // Mail older than the 180 days of evidence counts as resolved: it has had its results.
    const counted = evaluated(row.days ?? []), mail = { accepted: row.accepted_total, resolved: counted.resolved + Math.max(0, row.accepted_total - counted.accepted) };
    const moved = moveScore({ phase: row.phase, firstRecipients: row.first_recipients, calibratedAt: row.calibrated_at, score: row.score === null ? null : Number(row.score), dayScore: row.day_score === null ? null : Number(row.day_score), scoreDay: row.score_day }, q.target, mail, now);
    const input = ladderInput(row);
    const prev = { step: row.step, reasons: row.reasons, since: row.since, clearSince: row.clear_since, pauseKind: row.pause_kind };
    let next = nextStanding(prev, input, now);
    // The connection hold is the truth for a pause: one set outside the ladder (operator script, AWS) is a pause here,
    // and a pause lifted outside it (an operator resume) leaves the workspace at warn, with its limit frozen.
    if (row.paused_at && next.step !== 'pause') next = { step: 'pause', reasons: [{ code: 'ACCOUNT_PAUSED', metric: 'external', value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause', message: row.pause_reason ?? 'Sending is paused.' }], since: row.paused_at, clearSince: null, pauseKind: 'full' };
    else if (!row.paused_at && prev.step === 'pause' && next.step === 'pause') next = { step: 'warn', reasons: prev.reasons, since: now.toISOString(), clearSince: null, pauseKind: null };
    // A bounce-only marketing hold from before the standing shipped becomes a restrict, so the ladder releases it.
    if (row.legacy_hold && !row.exempt && stepRank(next.step) < stepRank('restrict')) next = { step: 'restrict', reasons: [...next.reasons.filter(r => r.step !== 'restrict'), { code: 'MARKETING_HELD', metric: 'bounces', value: 0, count: 0, threshold: 0, minimum: 0, window: '24h', step: 'restrict',
      message: row.marketing_hold_reason ?? 'Marketing was held after a high hard-bounce rate.' }], since: now.toISOString(), clearSince: null, pauseKind: null };
    // An exempt (first-party) workspace is never held or paused by the ladder: its standing stops at warn (owners are
    // emailed, account.standing.changed is published) and the operators are alerted; only an operator pauses it.
    if (row.exempt && !row.paused_at && stepRank(next.step) > stepRank('warn')) {
      await alertExempt(runtime, row.workspace_id, next, input);
      next = { ...next, step: 'warn', pauseKind: null, ...(prev.step === 'warn' ? { since: prev.since } : {}) };
    }
    const strikeCapped = !!row.strike_until && Date.parse(row.strike_until) > now.getTime();
    const limits = dailyLimit({ phase: moved.phase, score: moved.score, band: row.band_limit, step: next.step, strikeCapped, acceptedDay: Number(row.accepted_day) });
    // The growth pace, for new senders only: a workspace graded now or on the pace with a track record from before its
    // evaluation, or an operator override, skips or leaves it (ESTABLISHED). The last completed hour is counted only
    // while it can still raise an allowance that limits.
    const was = { until: row.growth_until, cap: row.growth_cap, hour: row.growth_hour && new Date(row.growth_hour).toISOString(), quality: row.growth_quality === null ? null : Number(row.growth_quality) };
    const graduated = row.phase === 'calibrating' && moved.phase === 'graded', pacing = !!was.until && Date.parse(was.until) > now.getTime() && was.cap !== null;
    // The track record ends at the baseline, or earlier when the evaluation's last recipient was counted before it.
    const cutoff = row.history_before && new Date(Math.min(Date.parse(row.history_before), moved.calibratedAt ? Date.parse(moved.calibratedAt) : Infinity)).toISOString();
    const history = (graduated || pacing) && !row.override && cutoff && moved.score !== null && moved.score >= GOOD_STANDING && next.step === 'ok' ? await trackRecord(runtime, row.workspace_id, cutoff) : null;
    const exempt = graduated || pacing ? establishedBy({ override: row.override, history, score: moved.score, step: next.step }) : null, established = exempt !== null;
    const counts = !established && pacing && next.step === 'ok' && (row.pace === null || was.cap! < 60 * row.pace) && (!was.hour || Date.parse(lastHour) > Date.parse(was.hour));
    const growth = nextGrowth(was, { graduated, established, step: next.step, quality: q.quality, hour: lastHour, evidence: counts ? await growthHour(runtime, row.sponsor_key, lastHour) : null, now });
    // The evaluation's end (the first grade) is emailed once, with what the sender score is: not to a first-party
    // workspace (no limit applies to it), not to one that skips the growth pace (its track record or an operator's limit
    // says more than this email), and not when it ends in a warning, a hold or a pause, which has its own email.
    if (graduated && !row.exempt && !established && !row.paused_at && stepRank(next.step) < stepRank('warn')) finished.push({ workspaceId: row.workspace_id, limited: limits.limit !== null });
    // An owner's marketing release and an operator's hold after a self-resume both end on their own.
    const releaseExpired = !!row.release_until && Date.parse(row.release_until) <= now.getTime();
    if (next.step !== prev.step || releaseExpired || row.legacy_hold) {
      const pause = next.step === 'pause' && !row.paused_at;
      const why = next.reasons.find(r => r.step === 'pause');
      const message = pause ? `Hosted sending paused: ${why ? `${PAUSE_LEAD[why.metric]}. ${why.message}` : 'the reputation ladder reached pause.'}` : '';
      try {
        const done = await runtime.db.transaction(tx => applyChange(tx, { workspaceId: row.workspace_id, actor: { kind: 'system', via: 'job' }, kind: 'step', expectVersion: row.version,
          step: next.step, reasons: next.reasons, pauseKind: next.pauseKind, ...(pause ? { pause: { message } } : {}),
          ...(releaseExpired && row.release_percent === null && row.marketing_hold ? { marketingHold: false } : {}),
          details: { day: input.day, week: input.week, screen: { screened: input.screened, rejected: input.rejected }, ...(releaseExpired ? { releaseEnded: true } : {}) } }));
        if (done) { changed++; row.version = done.version; }
        if (done && next.step !== prev.step) log(stepRank(next.step) >= stepRank('restrict') ? 'warn' : 'info', { code: 'STANDING_CHANGED', workspaceId: row.workspace_id, from: prev.step, to: next.step, reasons: next.reasons.map(r => r.code) });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'STANDING_VERSION_CHANGED') continue; // An owner or operator acted meanwhile; next run.
        throw error;
      }
      if (releaseExpired) await runtime.db.execute(sql`UPDATE sender_standing SET release_until=NULL,release_percent=NULL WHERE workspace_id=${row.workspace_id} AND release_until<=now()`);
    }
    // Skipping or leaving the growth pace is on the timeline and in the operator audit, once: a pace is cleared only while
    // it is active and the standing is at the version read (else the next run decides), and a graduation skips it once.
    if (exempt) {
      const details = { growth: { change: pacing ? 'cleared' : 'skipped', reason: exempt, before: pacing ? { until: was.until, cap: was.cap } : null, cutoff: exempt === 'TRACK_RECORD' ? cutoff : null, history: exempt === 'TRACK_RECORD' ? history : null } };
      try {
        const done = await runtime.db.transaction(async tx => {
          if (pacing ? !(await tx.execute(sql`UPDATE sender_standing SET growth_until=NULL,growth_cap=NULL,growth_hour=NULL,growth_quality=NULL
              WHERE workspace_id=${row.workspace_id} AND growth_until>now() RETURNING 1`)).rows.length
            : (await tx.execute(sql`SELECT FROM standing_events WHERE workspace_id=${row.workspace_id} AND details->'growth'->>'change'='skipped' LIMIT 1`)).rows.length) return null;
          const change = await applyChange(tx, { workspaceId: row.workspace_id, actor: { kind: 'system', via: 'job' }, kind: 'limit', expectVersion: row.version, details });
          await tx.execute(sql`INSERT INTO hosted_operator_audit(workspace_id,action,details,via,reason,before,after) VALUES (${row.workspace_id},${pacing ? 'growth-cleared' : 'growth-skipped'},${JSON.stringify(details)}::jsonb,'job',
            ${exempt === 'OPERATOR_OVERRIDE' ? 'An operator daily-limit override exempts the workspace from the growth pace.' : 'A clean track record from before the growth pace existed.'},${details.growth.before && JSON.stringify(details.growth.before)}::jsonb,'{"until":null,"cap":null}'::jsonb)`);
          return change;
        });
        if (done) { row.version = done.version; log('info', { code: pacing ? 'GROWTH_CLEARED' : 'GROWTH_SKIPPED', workspaceId: row.workspace_id, reason: exempt }); }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'STANDING_VERSION_CHANGED') continue;
        throw error;
      }
    }
    // A band change is on the timeline (one statement: the sequence row lock orders it with applyChange).
    if (limits.limit !== row.daily_limit) await runtime.db.execute(sql`WITH s AS (UPDATE sender_standing SET sequence=sequence+1 WHERE workspace_id=${row.workspace_id} RETURNING workspace_id,sequence,step)
      INSERT INTO standing_events(id,workspace_id,sequence,kind,from_step,to_step,actor,details)
      SELECT ${id('stev')},workspace_id,sequence,'limit',step,step,'{"kind":"system","via":"job"}'::jsonb,${JSON.stringify({ from: row.daily_limit, to: limits.limit, score: moved.score })}::jsonb FROM s`);
    // Keep the OK/Notice card current even when its step doesn't move. A below-line observation is
    // display evidence, not a standing change or an alert; never replace a concurrent operator decision.
    routine.push({ workspace_id: row.workspace_id, version: row.version, reasons: next.step === 'ok' ? noticeReasons(input.day, 'ok') : next.reasons,
      phase: moved.phase, first_recipients: moved.firstRecipients, calibrated_at: moved.calibratedAt, score: moved.score, day_score: moved.dayScore, score_day: moved.scoreDay,
      target: q.target, quality: q.quality, volume: q.volume, factors: q.factors, band_limit: limits.band, daily_limit: limits.limit, clear_since: next.step === prev.step ? next.clearSince : null,
      strike_until: strikeCapped ? row.strike_until : null, step: next.step, growth_until: growth.until, growth_cap: growth.cap, growth_hour: growth.hour, growth_quality: growth.quality });
  }
  if (routine.length) await runtime.db.execute(sql`WITH r AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(routine)}::jsonb) AS r(workspace_id text,version int,reasons jsonb,phase text,first_recipients int,calibrated_at timestamptz,
      score numeric,day_score numeric,score_day date,target numeric,quality numeric,volume double precision,factors jsonb,band_limit int,daily_limit int,clear_since timestamptz,strike_until timestamptz,step text,
      growth_until timestamptz,growth_cap int,growth_hour timestamptz,growth_quality numeric)),
    updated AS (UPDATE sender_standing s SET phase=r.phase,first_recipients=r.first_recipients,calibrated_at=r.calibrated_at,score=r.score,day_score=r.day_score,score_day=r.score_day,target=r.target,
      quality=r.quality,volume=r.volume,factors=r.factors,band_limit=r.band_limit,daily_limit=r.daily_limit,clear_since=CASE WHEN s.step=r.step THEN r.clear_since ELSE s.clear_since END,
      reasons=CASE WHEN s.version=r.version AND s.step=r.step AND r.step IN ('ok','notice') THEN r.reasons ELSE s.reasons END,
      strike_until=r.strike_until,growth_until=r.growth_until,growth_cap=r.growth_cap,growth_hour=r.growth_hour,growth_quality=r.growth_quality,computed_at=now() FROM r WHERE s.workspace_id=r.workspace_id RETURNING s.*)
    INSERT INTO sender_score_daily(workspace_id,day,score,quality,target,daily_limit,step) SELECT workspace_id,(now() AT TIME ZONE 'UTC')::date,score,quality,target,daily_limit,step FROM updated
    ON CONFLICT(workspace_id,day) DO UPDATE SET score=excluded.score,quality=excluded.quality,target=excluded.target,daily_limit=excluded.daily_limit,step=excluded.step`);
  for (const f of finished) await evaluationFinished(runtime.db, f.workspaceId, f.limited);
  await settlePaused(runtime);
  await runtime.db.execute(sql`DELETE FROM hosted_growth_minutes WHERE minute<now()-interval '2 hours'`);
  // Any workspace whose SES tenants differ from what Nightmail wants (a missed job, a tenant ready after the pause) is queued.
  if (!options.only) await runtime.db.execute(queueTenantStatus(tenantStatusDrift()));
  return { evaluated: rows.length, changed };
}

const LINE: Record<Reason['metric'], string> = { complaints: 'complaints', screen: 'screen', bounces: 'bounces', marketing_bounces: 'bounces', transactional_bounces: 'bounces', external: 'external' };
/** An exempt workspace crossed a restrict or pause line: one operator alert per line per UTC day (reputation.alert). */
async function alertExempt(runtime: Runtime, wid: string, next: { step: Step; reasons: Reason[] }, input: LadderInput) {
  const top = [...next.reasons].sort((a, b) => stepRank(b.step) - stepRank(a.step))[0];
  const line = top ? LINE[top.metric] : 'reputation', scope = next.step === 'pause' ? 'all' : 'marketing';
  const { rows } = await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('exempt-over-line:'||${wid}::text||':'||${line}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${wid},
    ${JSON.stringify({ code: 'HOSTED_EXEMPT_OVER_LINE', line, scope, step: next.step, reasons: next.reasons.map(r => r.code), sends: input.day.accepted, bounces: input.day.bounces, complaints: input.day.complaints, rejected: input.rejected, screened: input.screened })}::jsonb)
    ON CONFLICT(id) DO NOTHING RETURNING id`);
  if (rows.length) log('error', { code: 'HOSTED_EXEMPT_OVER_LINE', workspaceId: wid, line, step: next.step, held: false });
}

/** Queued mail of a workspace paused for 72 hours is canceled (ACCOUNT_PAUSED); expired operator overrides end. */
async function settlePaused(runtime: Runtime) {
  await runtime.db.execute(sql`WITH due AS MATERIALIZED (
      SELECT e.id FROM provider_connections pc JOIN sending_emails e ON e.workspace_id=pc.workspace_id AND e.status='queued'
      WHERE pc.kind='shared' AND pc.paused_at<now()-interval '72 hours' AND pc.resume_pending_at IS NULL AND (e.campaign_id IS NULL OR EXISTS (
        SELECT 1 FROM sending_campaigns p WHERE p.workspace_id=e.workspace_id AND p.id=e.campaign_id FOR NO KEY UPDATE OF p SKIP LOCKED))
      ORDER BY e.id LIMIT 1000 FOR UPDATE OF e SKIP LOCKED
    ), canceled AS (UPDATE sending_emails e SET status='canceled',error_code='ACCOUNT_PAUSED',lease_until=NULL,updated_at=clock_timestamp()
      WHERE e.id IN (SELECT id FROM due) AND e.status='queued' RETURNING ${terminalColumns}
    ), ${terminalEvents(sql`SELECT * FROM canceled`)} SELECT count(*)::int AS n FROM canceled`);
  await runtime.db.execute(sql`WITH expired AS (UPDATE workspaces w SET send_cap_override=NULL,send_cap_override_expires_at=NULL
      WHERE send_cap_override_expires_at<=now() RETURNING w.id)
    INSERT INTO hosted_operator_audit(workspace_id,action,details,via,reason) SELECT id,'limit-override-expired','{}'::jsonb,'job','The operator limit override reached its expiry.' FROM expired`);
}

/** Every ten minutes, one runner at a time (a durable election, like the daily depth reconcile). Best effort. */
export async function standingTick(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  try {
    const { rows } = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at) VALUES ('maintenance:standing',now()+interval '10 minutes')
      ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
    if (!rows.length) return;
    try {
      const result = await refreshStanding(runtime);
      log('info', { code: 'STANDING_REFRESHED', ...result });
    } finally {
      // Slow sign-in mail, after the run so it never delays it (src/operator-alerts.ts). Time-limited; it never throws.
      await checkSignInMail(runtime);
    }
  } catch (error) { log('warn', { code: 'STANDING_REFRESH_FAILED', message: error instanceof ApiError ? error.code : 'The next run retries.' }); }
}

// ---------- AWS tenant status (EventBridge → the pool's feedback SNS topic) ----------
/** An SES "Sending Status Enabled/Disabled" EventBridge event for a tenant, as delivered through SNS. */
export function tenantStatusEvent(message: Record<string, unknown>) {
  const m = message as { source?: unknown; 'detail-type'?: unknown; account?: unknown; region?: unknown; resources?: unknown; detail?: { data?: { origin?: unknown; record?: { status?: unknown; cause?: unknown } } } };
  if (m.source !== 'aws.ses' || (m['detail-type'] !== 'Sending Status Disabled' && m['detail-type'] !== 'Sending Status Enabled')) return null;
  const arn = Array.isArray(m.resources) ? m.resources[0] : null, origin = m.detail?.data?.origin, status = m.detail?.data?.record?.status;
  if (typeof arn !== 'string' || !/^arn:aws:ses:[a-z0-9-]+:\d{12}:tenant\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9-]+$/.test(arn) || (origin !== 'AWS_SES' && origin !== 'CUSTOMER_MANAGED')
    || (status !== 'ENABLED' && status !== 'DISABLED' && status !== 'REINSTATED') || typeof m.account !== 'string') return null;
  return { arn, account: m.account, region: typeof m.region === 'string' ? m.region : null, tenant: arn.split('/')[1]!, origin, status, cause: typeof m.detail?.data?.record?.cause === 'string' ? m.detail.data.record.cause.slice(0, 300) : null } as const;
}
/**
 * Mirrors AWS's own tenant pauses. A DISABLED from AWS (or from the strict reputation policy, which sets the
 * customer-managed status with its own cause) pauses the workspace (SES_TENANT_PAUSED): only an operator resumes it,
 * after AWS reinstates the tenant. Nightmail's own switch ("Status manually updated.") and every enable are timeline only.
 *
 * A valid SNS signature proves which topic published the bytes, not that SES wrote them: a BYO account controls what
 * its own topic publishes. So an event counts only when it arrived on a Nightmail-owned shared topic (topicKind, set by the
 * ingress from the topic's registration), its account, the tenant ARN's account and the topic's account agree, the
 * ARN's region is the topic's region, and the ARN is a tenant Nightmail recorded as owned (hosted_tenant_ownership) by a
 * shared connection whose pool or regional topic is that topic. A name never authorizes a target. Returns the refusal
 * code, or null when accepted.
 */
export async function ingestTenantStatus(runtime: Runtime, event: NonNullable<ReturnType<typeof tenantStatusEvent>>, source: { topicArn: string; region: string; topicKind?: 'byo' | 'shared' }) {
  const [, , , topicRegion, topicAccount] = source.topicArn.split(':'), [, , , arnRegion, arnAccount] = event.arn.split(':');
  const refuse = (code: string) => { log('warn', { code: 'SES_TENANT_STATUS_REFUSED', reason: code, tenant: event.arn, topic: source.topicArn, status: event.status }); return code; };
  if (source.topicKind !== 'shared') return refuse('SNS_TOPIC_NOT_ALLOWED');
  if (event.account !== topicAccount || arnAccount !== topicAccount) return refuse('SES_ACCOUNT_MISMATCH');
  if (arnRegion !== topicRegion || source.region !== topicRegion || (event.region !== null && event.region !== topicRegion)) return refuse('SES_TENANT_NOT_OWNED');
  const { rows: [owner] } = await runtime.db.execute<{ workspace_id: string }>(sql`SELECT c.workspace_id FROM hosted_tenant_ownership o
    JOIN provider_connections c ON c.workspace_id=o.workspace_id AND c.kind='shared'
    WHERE o.arn=${event.arn} AND o.region=${arnRegion} AND (
      EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=${source.topicArn} AND p.region=${arnRegion} AND p.aws_account_id=${arnAccount})
      OR EXISTS (SELECT FROM provider_connection_regions r WHERE r.connection_id=c.id AND r.region=${arnRegion} AND r.feedback_topic_arn=${source.topicArn} AND c.aws_account_id=${arnAccount}))`);
  if (!owner) return refuse('SES_TENANT_NOT_OWNED');
  const verified = await (await import('./ses-setup.js')).readTenantStatus(runtime, arnRegion!, event.arn, event.origin);
  // An out-of-order hint is acknowledged without an audit entry, alert, pause or resume.
  if (verified.status !== event.status || (verified.status === 'DISABLED' && verified.aggregate !== 'DISABLED')) return null;
  event = { ...event, cause: verified.cause }; // Only SES can supply a reason, including the manual-switch exception.
  const ours = event.origin === 'CUSTOMER_MANAGED' && event.cause === 'Status manually updated.';
  const pause = verified.status === 'DISABLED' && !ours;
  await runtime.db.transaction(tx => applyChange(tx, { workspaceId: owner.workspace_id, actor: { kind: 'system', via: 'ses' }, kind: 'tenant',
    ...(pause ? { step: 'pause', pauseKind: 'full', pause: { message: `Hosted sending paused: AWS paused this workspace’s SES tenant. ${productName} reviews it with AWS before sending resumes.` },
      reasons: [{ code: 'SES_TENANT_PAUSED', metric: 'external', value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause', message: event.cause ?? 'AWS paused the SES tenant.' }] } : {}),
    details: { tenant: event.arn, origin: event.origin, status: event.status, cause: event.cause } }));
  log(pause ? 'error' : 'info', { code: 'SES_TENANT_STATUS', workspaceId: owner.workspace_id, origin: event.origin, status: event.status, paused: pause });
  // AWS's pause applies to every workspace, exempt (first-party) ones included: alert the operators loudly, once per tenant a day.
  if (pause) await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'tenant-paused:'||${event.arn}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${owner.workspace_id},
    jsonb_build_object('code','SES_TENANT_PAUSED','tenant',${event.arn}::text,'cause',${event.cause}::text,'exempt',w.exempt_hosted_quotas) FROM workspaces w WHERE w.id=${owner.workspace_id} ON CONFLICT(id) DO NOTHING`);
  return null;
}

// ---------- owner emails ----------
/**
 * A warning's and a campaign pause's email wait this long. One problem (a bad list) can pause a campaign, warn the
 * workspace and then hold or pause it within a standing run or two: the job sends what is most serious by then.
 */
export const NOTICE_WAIT_MINUTES = 15;
type NoticeEvent = { kind: string; to_step: Step; age: number; details: Record<string, unknown>; name: string; exempt: boolean; recipients: string[]; outranked: boolean; repeated: boolean; paused: boolean | null; pending: boolean | null; marketing_held: boolean };
/**
 * Emails the workspace's owners and admins about a standing change (src/notices.ts writes it; account-notices.ts sends
 * it from the platform workspace's own sender). Without that sender the dashboard and webhook still carry the change.
 * One event, one email: a pause or a marketing hold is always sent; a campaign's pause is not when the workspace was
 * held or paused around it (or the campaign already had its email in the last 24 hours), and a warning is not when a
 * campaign's pause, a hold or a pause tells the same story. A resume (payload.notice) waits for sending to be on.
 */
export const notifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const eventId = String(payload.eventId), resumed = payload.notice === 'resumed';
  const rose = sql`((r.to_step='pause' AND r.from_step<>'pause') OR (r.to_step='restrict' AND r.from_step IN ('ok','notice','warn')))`;
  const [event] = (await runtime.db.execute<NoticeEvent>(sql`SELECT e.kind,e.to_step,extract(epoch FROM now()-e.at)::int AS age,e.details,w.name,w.exempt_hosted_quotas AS exempt,${noticeRecipients(sql`e.workspace_id`)} AS recipients,
      CASE WHEN e.kind='quarantine' THEN EXISTS (SELECT FROM standing_events r WHERE r.workspace_id=e.workspace_id AND ${rose} AND r.at>=e.at-make_interval(mins=>${NOTICE_WAIT_MINUTES}))
        WHEN e.to_step='warn' THEN EXISTS (SELECT FROM standing_events r WHERE r.workspace_id=e.workspace_id AND ((r.kind='quarantine' AND r.at>=e.at-make_interval(mins=>${2 * NOTICE_WAIT_MINUTES})) OR (${rose} AND r.at>e.at)))
        ELSE false END AS outranked,
      e.kind='quarantine' AND EXISTS (SELECT FROM standing_events q WHERE q.workspace_id=e.workspace_id AND q.kind='quarantine' AND q.id<>e.id AND q.details->>'campaignId'=e.details->>'campaignId'
        AND q.at<=e.at AND q.at>e.at-interval '24 hours') AS repeated,
      pc.paused_at IS NOT NULL AS paused,pc.resume_pending_at IS NOT NULL AS pending,
      coalesce(pc.marketing_held_at IS NOT NULL OR (SELECT s.marketing_hold OR s.step='restrict' FROM sender_standing s WHERE s.workspace_id=e.workspace_id),false) AS marketing_held
    FROM standing_events e JOIN workspaces w ON w.id=e.workspace_id LEFT JOIN provider_connections pc ON pc.workspace_id=e.workspace_id AND pc.kind='shared'
    WHERE e.id=${eventId} AND e.workspace_id=${job.workspaceId}`)).rows;
  if (!event || !event.recipients.length) return;
  const skip = (reason: string) => log('info', { code: 'STANDING_NOTIFY_SKIPPED', workspaceId: job.workspaceId, step: event.to_step, reason });
  if (resumed && event.paused) {
    // Its SES tenants are still being enabled: sending is not on yet. Otherwise it was paused again, and has that email.
    if (event.pending && event.age < 6 * 3600) throw new JobDeferred(new Date(Date.now() + 120_000).toISOString());
    return skip('The workspace is paused.');
  }
  if (!resumed && event.kind !== 'quarantine' && stepRank(event.to_step) < stepRank('warn')) return;
  if (!resumed && (event.outranked || event.repeated)) return skip(event.repeated ? 'This campaign had its email in the last 24 hours.' : 'A more serious email covers this event.');
  const workspace = event.name;
  const input: NoticeInput = resumed ? { kind: 'resumed', workspace, limit: !event.exempt, marketingHeld: event.marketing_held }
    : event.kind === 'quarantine' ? { kind: 'campaign_paused', workspace, campaign: { id: String(event.details.campaignId ?? ''), name: String(event.details.campaignName ?? '') } }
    : { kind: event.to_step === 'pause' ? 'paused' : event.to_step === 'restrict' ? 'restricted' : 'warned', workspace };
  if (await deliverNotice(runtime, event.recipients, customerNotice(runtime.config.publicUrl, input), { standingEvent: eventId }) === 'unconfigured') return skip('NIGHTMAIL_NOTIFY_FROM or the platform workspace is not configured');
  log('info', { code: 'STANDING_NOTIFIED', workspaceId: job.workspaceId, notice: input.kind, recipients: event.recipients.length, simulated: isSimulatedSes(runtime) });
});
export const standingJobs: Record<string, JobHandler> = { 'standing.notify': notifyJob };
