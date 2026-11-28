import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { DASHBOARD_CACHE_NOTE, dashboardRead } from './dashboard-cache.js';
import { probationReason, type ProbationReason } from './hosted-sending.js';
import { productName } from './brand.js';
import { actor, ApiError, dashboardSession, requiredOf, restrictedArea, unrestrictedRequired, errors, json, response, security, type App, type Runtime } from './core.js';
import { burstFor, EVALUATION, evaluateLadder, FACTOR_KEYS, FREEZE_FLOOR, GOOD_STANDING, GROWTH, GRADE_BANDS, GRADES, gradeOf, marketingHourFor, nextBand, quality, reserveFor, round, stepRank, STEPS, type DayEvidence, type DomainAuth, type Factor, type Reason, type Step } from './standing-model.js';

// GET /v1/sender-score reads what the ten-minute standing job stored (src/standing.ts): the score, its factors, the
// daily limit it sets (none in good standing) and the ladder step. A workspace without a Hosted connection (self-hosted, BYO) has no standing;
// its score is computed from its last 30 days of mail on read and only displayed. docs/sending-limits.md has the tables.

const FactorSchema = z.object({
  key: z.enum(FACTOR_KEYS).describe('complaints, content (the spam screen), bounces (to known recipients), hygiene (list quality: campaign first sends and their suppression hits; neutral without campaign mail), auth, engagement.'),
  label: z.string(), weight: z.number().int().describe('Share of the score, out of 100, when every factor is measured.'),
  value: z.number().nullable().describe('The measured rate or ratio, decayed with a 30-day half-life; null when neutral.'),
  score: z.number().nullable().describe('0–100 for this factor; null when neutral.'),
  points: z.number().nullable().describe('weight × score ÷ 100; null when neutral.'),
  source: z.enum(['measured', 'neutral']).describe('Neutral factors are left out and the measured ones re-weighted.'),
  basis: z.string(),
}).openapi('SenderScoreFactor');
const ReasonSchema = z.object({
  code: z.string(), metric: z.enum(['complaints', 'bounces', 'marketing_bounces', 'transactional_bounces', 'screen', 'external']),
  value: z.number().describe('The measured rate.'), count: z.number().int(), threshold: z.number().describe('The rate the line starts at.'), minimum: z.number().int().describe('The count the line also needs.'),
  window: z.enum(['24h', '7d']).nullable(), step: z.enum(STEPS), message: z.string(),
}).openapi('StandingReason');
export const StandingSchema = z.object({
  step: z.enum(STEPS).describe(`ok; notice (dashboard only); warn (limit frozen: no rises, and a workspace without one is limited to what SES accepted from it in the last 24 hours, at least ${FREEZE_FLOOR.toLocaleString('en-US')}; owners emailed); restrict (marketing held, transactional flows, limit frozen); pause (all sending stopped).`),
  reasons: z.array(ReasonSchema), since: z.iso.datetime(),
  pauseKind: z.enum(['bounce', 'full']).nullable().describe('bounce: only transactional bounces paused it, and an owner may resume it once in 30 days. full: complaints, the spam screen, abuse or an AWS tenant pause; an operator reviews it.'),
  marketingHeld: z.boolean(), marketingRelease: z.object({ percent: z.number().int(), until: z.iso.datetime() }).nullable().describe('An owner released a restrict: marketing is at this share of its allowance until then.'),
  strikes: z.number().int().describe('Pauses in the last 90 days. A second caps the limit at 50% for 7 days after the resume; a third needs an operator for any resume.'),
  selfService: z.object({ available: z.boolean(), action: z.enum(['release_marketing', 'resume_sending']).nullable(), reason: z.string().nullable(), availableAt: z.iso.datetime().nullable() })
    .describe('Whether an owner or admin can release this step from the dashboard (POST /v1/sender-score/release), and if not, why.'),
  version: z.number().int().describe('Changes with every change of standing; account.standing.changed carries it.'), sequence: z.number().int(),
  probation: z.enum(['evaluation', 'growth', 'standing']).nullable().describe(`Why ${productName} still checks this workspace as a new sender; null in good standing, which it reaches by itself. evaluation: its first ${EVALUATION.recipients} real recipients; growth: the growth pace after them; standing: a daily limit set by the score, a freeze or a strike, or a step from warn up. Until then a campaign over ${EVALUATION.recipients} recipients sends a list probe first, and mail is delivered as the copy the content screen read (style sheets inlined, @media and dark-mode rules left out) with the attachment allowlist, except from domains ${productName} placed on its trusted tier. The image-to-text rule applies in good standing too.`),
}).openapi('SenderStanding');
const LimitSchema = z.object({
  daily: z.number().int().nullable().describe(`Recipients per rolling 24 hours that admission enforces now. Null when there is no daily limit (unlimited): a workspace in good standing (score ${GOOD_STANDING} and up, no warning) or an exempt one.`),
  unlimited: z.boolean().describe('True when no daily limit applies (daily is null): only the per-minute pace bounds sending.'),
  source: z.enum(['calibrating', 'score', 'override', 'exempt']).describe(`calibrating: the evaluation (the first ${EVALUATION.recipients} real recipients); score: set by the score and the ladder, none in good standing; override: set by ${productName}; exempt: none.`),
  band: z.number().int().describe('The daily limit the score earns, before a resume or strike reduction. Without one: what the per-minute pace allows in 24 hours (perMinute × 1,440).'),
  next: z.object({ limit: z.number().int().describe('The next band\'s daily limit; when unlimited, what the pace allows in 24 hours.'), atScore: z.number(), unlimited: z.boolean().describe('The next band has no daily limit.') })
    .nullable().describe('The next band up and the score it starts at. Null without a daily limit, or when an operator set it.'),
  override: z.object({ daily: z.number().int(), expiresAt: z.iso.datetime().nullable() }).nullable(),
  restore: z.object({ daily: z.number().int(), until: z.iso.datetime() }).nullable().describe('After a resume: the limit is at most this many recipients a day until then (half the limit before the resume, unless an operator restored all of it).'),
  strikeCapUntil: z.iso.datetime().nullable(),
  growth: z.object({ hourly: z.number().int().describe('Recipients the sponsor\'s growing workspaces may send in a rolling hour now.'), used: z.number().int().describe('Recipients sent in the rolling hour.'),
    until: z.iso.datetime().describe(`When the growth pace ends, after ${GROWTH.hours} clean hours.`) }).nullable()
    .describe(`For ${GROWTH.hours} clean hours after the evaluation, while it limits more than the per-minute pace: sending grows from ${GROWTH.start.toLocaleString('en-US')} recipients an hour (shared by the account's workspaces, every stream) to twice the distinct recipients of the last completed hour whose results are in and clean. Null otherwise. Mail over it waits in the queue.`),
  perMinute: z.number().int().describe('Recipients a minute the workspace may send (pacing that protects the shared pool, not a daily limit): clamp(daily ÷ 20, 50, 500), or without a daily limit a quarter of the pool\'s SES rate, at least 500. Half of it per sending domain.'),
  marketingPerHour: z.number().int().describe('Marketing recipients an hour: max(25, daily ÷ 4); without a daily limit, what the per-minute pace allows (perMinute × 60).'),
  transactionalReserve: z.number().int().describe('Recipients of the daily limit marketing may not use, kept for transactional mail: max(100, 10%). 0 without a daily limit and during the evaluation, whose recipients may all be marketing.'),
}).openapi('SenderLimit');
const SenderScoreSchema = z.object({
  state: z.enum(['warmup', 'graded']).describe(`warmup during the evaluation: until ${EVALUATION.recipients} real recipients were accepted and their delivery results are in (${EVALUATION.resolved * 100}% of them, or an hour after the ${EVALUATION.recipients}th) (Hosted), or the first ${EVALUATION.recipients} emails (self-hosted).`),
  emails: z.object({ firstEmails: z.number().int().describe(`Real recipients accepted, counted up to ${EVALUATION.recipients}.`), last30Days: z.number().int() }),
  needed: z.number().int().describe(`Accepted recipients before the first score (${EVALUATION.recipients}).`),
  calibratedAt: z.iso.datetime().nullable().describe(`When the ${EVALUATION.recipients}th recipient was counted; the score starts once their delivery results are in, at most an hour later plus the ten-minute job run (gradedBy).`),
  gradedBy: z.iso.datetime().nullable().describe(`Hosted, during the evaluation once the ${EVALUATION.recipients}th recipient was counted: the latest the first grade comes (an hour after it, plus the ten-minute job run), sooner once ${EVALUATION.resolved * 100}% of them have a delivery result. Null otherwise.`),
  score: z.number().nullable().describe(`0–100, one decimal; null while warming up. The quality of the last 30 days of mail, recounted hourly: ${GOOD_STANDING} and up has no daily limit.`),
  grade: z.enum(GRADES).nullable(),
  target: z.number().describe('The score the evidence supports now; the score follows it on every run (the same as raw).'),
  raw: z.number().describe('Quality: the weighted factor result.'),
  band: z.object({ min: z.number(), max: z.number() }).nullable().describe('The current grade band.'),
  next: z.object({ grade: z.enum(GRADES), at: z.number() }).nullable().describe('The next grade up and the score it starts at.'),
  factors: z.array(FactorSchema),
  history: z.array(z.object({ date: z.string().describe('UTC day, YYYY-MM-DD.'), score: z.number() })).describe('The published daily score, oldest first, up to 14 days.'),
  limit: LimitSchema.nullable().describe('Hosted only: the daily limit the score sets (none in good standing), the pace and what changes them.'),
  standing: StandingSchema.nullable().describe('Hosted only: the enforcement step and why.'),
  computedAt: z.iso.datetime(),
}).openapi('SenderScore');
export type SenderScore = z.infer<typeof SenderScoreSchema>;

type Stored = { workspace_id: string; phase: 'seed' | 'calibrating' | 'graded'; first_recipients: number; calibrated_at: string | null; score: string | null; target: string; quality: string;
  factors: Factor[]; band_limit: number | null; daily_limit: number | null; step: Step; reasons: Reason[]; since: string; pause_kind: 'bounce' | 'full' | null; marketing_hold: boolean; release_until: string | null;
  release_percent: number | null; last_release_at: string | null; last_self_resume_at: string | null; strikes: unknown[]; strike_until: string | null; version: number; sequence: number; computed_at: string | null };
type Row = { standing: Stored | null; history: { date: string; score: number }[]; last30: number; override: number | null; override_expires_at: string | null; exempt: boolean; minute_cap: number | null; pool_pace: number | null;
  growth: { cap: number; used: number; until: string } | null; probation: ProbationReason | null;
  restore_until: string | null; restore_cap: number | null; paused_at: string | null; days: DayEvidence[] | null; domains: DomainAuth[] | null; screened: boolean; display?: SenderScore | null };
const iso = (v: string | null | undefined) => v ? new Date(v).toISOString() : null;
/** The standing job runs every ten minutes (standingTick), so an evaluation's wait ends at most this much later. */
const JOB_MINUTES = 10;

/** What an owner may release now, from the stored standing (the POST re-checks the live 24-hour figures). */
export function selfService(s: Pick<Stored, 'step' | 'since' | 'pause_kind' | 'last_release_at' | 'last_self_resume_at' | 'strikes' | 'release_until' | 'release_percent'>, now = Date.now()) {
  const later = (from: string | null, days: number) => from && Date.parse(from) + days * 86_400_000 > now ? new Date(Date.parse(from) + days * 86_400_000).toISOString() : null;
  if (s.step === 'restrict') {
    if (s.release_until && Date.parse(s.release_until) > now && s.release_percent) return { available: false, action: null, reason: 'Marketing is already released at a reduced allowance.', availableAt: null };
    const wait = later(s.since, 1) ?? later(s.last_release_at, 14);
    return wait ? { available: false, action: 'release_marketing' as const, reason: later(s.since, 1) ? 'A restrict can be released 24 hours after it started.' : 'A restrict can be released once every 14 days; a second one needs a review.', availableAt: wait }
      : { available: true, action: 'release_marketing' as const, reason: null, availableAt: null };
  }
  if (s.step === 'pause') {
    if (s.pause_kind !== 'bounce') return { available: false, action: null, reason: 'This pause needs a review: ask for one from the dashboard.', availableAt: null };
    if (s.strikes.length >= 3) return { available: false, action: null, reason: 'A third pause in 90 days needs a review.', availableAt: null };
    const wait = later(s.last_self_resume_at, 30);
    return wait ? { available: false, action: 'resume_sending' as const, reason: 'Sending can be resumed by an owner once every 30 days; this one needs a review.', availableAt: wait } : { available: true, action: 'resume_sending' as const, reason: null, availableAt: null };
  }
  return { available: false, action: null, reason: null, availableAt: null };
}

export const DISPLAY_SCORE_JOB = 'maintenance.senderDisplayScore';
export const DISPLAY_SCORE_ID_PREFIX = 'sender-display:';
export const displayScoreId = (wid: string) => DISPLAY_SCORE_ID_PREFIX + wid;
const publishedDisplay = (wid: string) => sql`(SELECT payload->'view' FROM jobs WHERE id=${displayScoreId(wid)}
  AND workspace_id=${wid} AND type=${DISPLAY_SCORE_JOB} AND status IN ('pending','running','failed') AND payload->>'version'='1')`;

// Common aggregation for the exact live advisory and the background's bounded pages.
export const displayEvidenceColumns = sql`count(*)::int AS emails,
  count(*) FILTER (WHERE status<>'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR event_outcomes & 1 <> 0))::int AS accepted,
  count(*) FILTER (WHERE status='delivered' OR event_outcomes & 2 <> 0)::int AS delivered,count(*) FILTER (WHERE status='bounced' OR event_outcomes & 4 <> 0)::int AS bounced,
  count(*) FILTER (WHERE campaign_id IS NOT NULL AND status<>'suppressed' AND (provider_id IS NOT NULL OR event_outcomes & 1 <> 0))::int AS first_sends,
  count(*) FILTER (WHERE campaign_id IS NOT NULL AND (status='bounced' OR event_outcomes & 4 <> 0))::int AS first_bounced,
  count(*) FILTER (WHERE status='complained' OR event_outcomes & 8 <> 0)::int AS complained,
  count(*) FILTER (WHERE error_code='CONTENT_REJECTED_SPAM' OR (status<>'suppressed' AND (provider_id IS NOT NULL OR event_outcomes & 1 <> 0)))::int AS screened,
  count(*) FILTER (WHERE error_code='CONTENT_REJECTED_SPAM')::int AS rejected,count(*) FILTER (WHERE campaign_id IS NOT NULL AND status='suppressed')::int AS suppressed,
  count(*) FILTER (WHERE (kind='marketing' OR campaign_id IS NOT NULL) AND (status='delivered' OR event_outcomes & 2 <> 0))::int AS marketing_delivered,0 AS unsubscribed,
  count(*) FILTER (WHERE (kind='marketing' OR campaign_id IS NOT NULL) AND event_outcomes & 32 <> 0)::int AS clicked`;

// Advisories still ask for exact live evidence. Public and staff score displays never select its mail CTE.
export async function loadStanding(runtime: Runtime, wid: string, storedOnly = false): Promise<Row> {
  const screened = Boolean(runtime.config.screen && runtime.config.hostedScreen);
  const { rows: [row] } = await runtime.db.execute<Row>(sql`WITH s AS (SELECT * FROM sender_standing WHERE workspace_id=${wid}),
    pc AS (SELECT * FROM provider_connections WHERE workspace_id=${wid} AND kind='shared')${storedOnly ? sql`` : sql`,
    mail AS MATERIALIZED (SELECT (e.created_at AT TIME ZONE 'UTC')::date AS day,e.status,e.error_code,e.event_outcomes,e.provider_id,e.campaign_id,e.snapshot->>'kind' AS kind,
        lower(substring(e.from_address from '@([A-Za-z0-9.-]+)')) AS domain
      FROM sending_emails e WHERE e.workspace_id=${wid} AND NOT e.simulated AND hosted_real_cost(e.to_addresses||e.cc_addresses||e.bcc_addresses)>0
        AND NOT EXISTS (SELECT FROM s) AND e.created_at>=date_trunc('day',now(),'UTC')-interval '29 days')`}
    SELECT (SELECT to_jsonb(s) FROM s) AS standing,
      coalesce((SELECT json_agg(json_build_object('date',to_char(d.day,'YYYY-MM-DD'),'score',round(d.score,1)) ORDER BY d.day) FROM sender_score_daily d
        WHERE d.workspace_id=${wid} AND d.score IS NOT NULL AND d.day>(now() AT TIME ZONE 'UTC')::date-14 ${storedOnly ? sql`AND EXISTS (SELECT FROM s)` : sql``}),'[]') AS history,
      coalesce((SELECT sum(d.accepted) FROM sender_score_daily d WHERE d.workspace_id=${wid} AND d.day>(now() AT TIME ZONE 'UTC')::date-30 ${storedOnly ? sql`AND EXISTS (SELECT FROM s)` : sql``}),0)::int AS last30,
      (SELECT send_cap_override FROM workspaces WHERE id=${wid}) AS override,(SELECT send_cap_override_expires_at FROM workspaces WHERE id=${wid}) AS override_expires_at,
      coalesce((SELECT exempt_hosted_quotas FROM workspaces WHERE id=${wid}),false) AS exempt,(SELECT hosted_minute_cap(${wid}) FROM s) AS minute_cap,(SELECT hosted_pool_pace(${wid}) FROM s) AS pool_pace,
      (SELECT json_build_object('cap',g.cap,'used',g.used,'until',(SELECT growth_until FROM s)) FROM hosted_growth(${wid}) g) AS growth,${probationReason(sql`${wid}::text`)} AS probation,
      (SELECT restore_until FROM pc) AS restore_until,(SELECT restore_cap FROM pc) AS restore_cap,(SELECT CASE WHEN resume_pending_at IS NULL THEN paused_at END FROM pc) AS paused_at,${screened} AND EXISTS (SELECT FROM pc) AS screened,
      ${storedOnly ? sql`NULL::json AS days,NULL::json AS domains,
        CASE WHEN NOT EXISTS (SELECT FROM s) THEN ${publishedDisplay(wid)} END AS display` : sql`
      (SELECT json_agg(x) FROM (SELECT to_char(day,'YYYY-MM-DD') AS day,${displayEvidenceColumns} FROM mail GROUP BY day) x) AS days,
      (SELECT json_agg(json_build_object('name',dc.name,'dkim',dc.identity #>> '{ses,DkimAttributes,Status}'='SUCCESS' AND dc.identity #>> '{ses,DkimAttributes,SigningEnabled}'='true',
        'mailFrom',dc.identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS','dmarc',dc.identity #>> '{dmarc,status}',
        'emails',(SELECT count(*) FROM mail m WHERE m.domain=dc.name OR m.domain LIKE '%.'||dc.name)))
        FROM domain_claims dc WHERE dc.workspace_id=${wid} AND dc.sending_state='verified' AND NOT EXISTS (SELECT FROM s)) AS domains`}`);
  return row!;
}

export function loadDisplayedStanding(runtime: Runtime, wid: string) { return loadStanding(runtime, wid, true); }

export function displayScoreView(days: DayEvidence[], domains: DomainAuth[], now: Date): SenderScore {
  // Display only: no stored standing, so no movement limit; the score is the target once the evaluation's emails were counted.
  const q = quality(days, domains, false, now.toISOString().slice(0, 10)), emails = days.reduce((n, d) => n + d.emails, 0);
  const graded = emails >= EVALUATION.recipients, score = graded ? round(q.target) : null;
  return { state: graded ? 'graded' : 'warmup', emails: { firstEmails: Math.min(emails, EVALUATION.recipients), last30Days: emails }, needed: EVALUATION.recipients, calibratedAt: null, gradedBy: null,
    score, grade: score === null ? null : gradeOf(score), target: round(q.target), raw: round(q.quality), ...grades(score), factors: q.factors, history: [], limit: null, standing: null, computedAt: now.toISOString() };
}

const EMPTY_DISPLAY = displayScoreView([], [], new Date(0));

export function scoreView(row: Row, now = new Date()): SenderScore {
  const s = row.standing;
  if (!s) return row.display ?? (row.days || row.domains
    ? displayScoreView(row.days ?? [], row.domains ?? [], now) // exact legacy advisory, not the stored request path
    : { ...EMPTY_DISPLAY, computedAt: now.toISOString() });
  const score = s.phase === 'graded' && s.score !== null ? round(Number(s.score)) : null;
  const overrideActive = row.override !== null && (!row.override_expires_at || Date.parse(row.override_expires_at) > now.getTime());
  // As admission computes it (hosted_allowance_read): the base is the override or the score's limit (none in good
  // standing); a resume caps it, with or without a base, unless the workspace is exempt.
  const base = row.exempt && !overrideActive ? null : overrideActive ? row.override! : s.daily_limit;
  const restore = (base !== null || !row.exempt) && row.restore_until && Date.parse(row.restore_until) > now.getTime() && row.restore_cap && (base === null || row.restore_cap < base) ? { daily: row.restore_cap, until: iso(row.restore_until)! } : null;
  const daily = restore ? restore.daily : base;
  // The pace admission applies (hosted_minute_cap), and what it allows in an hour and a day without a daily limit.
  const perMinute = row.minute_cap ?? burstFor(daily);
  const up = score === null || overrideActive || row.exempt ? null : nextBand(score);
  const next = up && { limit: up.limit ?? (row.pool_pace ?? burstFor(null)) * 1440, atScore: up.min, unlimited: up.limit === null };
  // The growth pace, while it is tighter than the per-minute pace's hour.
  const growth = row.growth && row.growth.cap < perMinute * 60 ? { hourly: row.growth.cap, used: Math.min(row.growth.used, row.growth.cap), until: iso(row.growth.until)! } : null;
  const release = s.release_until && Date.parse(s.release_until) > now.getTime() && s.release_percent ? { percent: s.release_percent, until: iso(s.release_until)! } : null;
  return {
    state: score === null ? 'warmup' : 'graded', emails: { firstEmails: Math.min(s.first_recipients, EVALUATION.recipients), last30Days: row.last30 }, needed: EVALUATION.recipients, calibratedAt: iso(s.calibrated_at),
    gradedBy: s.phase === 'calibrating' && s.calibrated_at ? new Date(Date.parse(s.calibrated_at) + (EVALUATION.waitMinutes + JOB_MINUTES) * 60_000).toISOString() : null,
    score, grade: score === null ? null : gradeOf(score), target: round(Number(s.target)), raw: round(Number(s.quality)), ...grades(score), factors: s.factors, history: row.history.map(h => ({ date: h.date, score: Number(h.score) })),
    limit: { daily, unlimited: daily === null, source: overrideActive ? 'override' : row.exempt ? 'exempt' : score === null ? 'calibrating' : 'score', band: s.band_limit ?? perMinute * 1440, next,
      override: overrideActive ? { daily: row.override!, expiresAt: iso(row.override_expires_at) } : null, restore,
      strikeCapUntil: s.strike_until && Date.parse(s.strike_until) > now.getTime() ? iso(s.strike_until) : null, growth,
      perMinute, marketingPerHour: daily === null ? perMinute * 60 : marketingHourFor(daily), transactionalReserve: daily === null ? 0 : overrideActive ? Math.ceil(daily * 0.1) : reserveFor(daily, s.phase !== 'graded') },
    standing: { step: s.step, reasons: s.reasons, since: iso(s.since)!, pauseKind: s.step === 'pause' ? s.pause_kind : null,
      marketingHeld: (stepRank(s.step) >= stepRank('restrict') && !release) || s.marketing_hold, marketingRelease: release, strikes: s.strikes.length,
      selfService: selfService(s, now.getTime()), version: s.version, sequence: Number(s.sequence), probation: row.probation },
    computedAt: iso(s.computed_at) ?? now.toISOString(),
  };
}
function grades(score: number | null) {
  if (score === null) return { band: null, next: null };
  const index = GRADE_BANDS.findIndex(b => score >= b.min), above = index > 0 ? GRADE_BANDS[index - 1]! : null;
  return { band: { min: GRADE_BANDS[index]!.min, max: above?.min ?? 100 }, next: above ? { grade: above.grade, at: above.min } : null };
}

/** IMAP/SMTP compose caps follow the same limit as API sending (merge principle): the cap admission uses for a stored
 * standing (an active override, none when exempt or in good standing, else the daily limit; a resume's restore cap
 * lowers it, with or without one), or the evaluation's limit before the standing job has seen it. */
export async function protocolScoreCap(runtime: Runtime, w: string) {
  const { firstWeek } = runtime.config.hostedSendCaps;
  const { rows: [row] } = await runtime.db.execute<{ cap: number | null }>(sql`WITH b AS (SELECT hosted_base_cap(${w},${firstWeek},NULL,NULL) AS base,
      (SELECT exempt_hosted_quotas FROM workspaces WHERE id=${w}) AS exempt FROM sender_standing WHERE workspace_id=${w})
    SELECT CASE WHEN (b.base IS NOT NULL OR NOT b.exempt) AND pc.restore_cap IS NOT NULL AND pc.restore_until>now() THEN least(b.base,pc.restore_cap) ELSE b.base END AS cap
    FROM b LEFT JOIN LATERAL (SELECT restore_cap,restore_until FROM provider_connections WHERE workspace_id=${w} AND kind='shared' LIMIT 1) pc ON true`);
  if (!row) return EVALUATION.limit;
  return row.cap ?? Infinity;
}

const dashboardSecurity = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
export function registerSenderScore(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/sender-score', operationId: 'getSenderScore', tags: ['Metrics'], security,
    description: `The workspace sender score, the daily limit it sets and the enforcement step (Hosted). In good standing (a score of ${GOOD_STANDING} or more, no warning) there is no daily limit: limit.unlimited is true, limit.daily null, and only the per-minute pace (limit.perMinute) applies. A new workspace's first ${EVALUATION.recipients} real recipients are its evaluation, at ${EVALUATION.limit} a day until their delivery results are in (gradedBy says by when); for ${GROWTH.hours} clean hours after it, sending grows from ${GROWTH.start.toLocaleString('en-US')} recipients an hour, doubling with each clean hour (limit.growth). Under ${GOOD_STANDING} the limit is 500 (70–74), 200 (65–69) or 100, and a warning freezes it. The score (0–100) is the quality of what the workspace sends (complaints, the spam screen, bounces, list quality, authentication and engagement), decayed with a 30-day half-life and recounted hourly. Self-hosted and BYO get the score for display only. ${DASHBOARD_CACHE_NOTE} A change of standing or limit shows at once. Workspace-wide: keys restricted to domains get 403.`,
    responses: { 200: response(SenderScoreSchema), ...errors } }), async c => {
    const a = actor(c, 'read');
    if (a.domains.length) throw unrestrictedRequired(a, restrictedArea(c.req.path), requiredOf(c));
    const compute = async () => scoreView(await loadDisplayedStanding(c.env, a.workspaceId));
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    // Keyed by the standing's version and sequence too: a release, resume or operator action (or a limit change) shows at
    // once, on every isolate, instead of after the minute. One indexed read.
    const { rows: [standing] } = await c.env.db.execute<{ v: string | null; display: SenderScore | null }>(sql`WITH s AS (
      SELECT version||'.'||sequence AS v FROM sender_standing WHERE workspace_id=${a.workspaceId}
    ) SELECT (SELECT v FROM s) AS v, CASE WHEN NOT EXISTS (SELECT FROM s) THEN ${publishedDisplay(a.workspaceId)} END AS display`);
    // Already-published data needs neither a recomputation nor another round trip. Real standing retains its existing cache policy.
    if (!standing?.v) {
      c.header('x-nightmail-sender-score-cache', standing?.display ? 'hit' : 'miss');
      return c.json(standing?.display ?? { ...EMPTY_DISPLAY, computedAt: new Date().toISOString() }, 200);
    }
    const body = await dashboardRead(c, ['sender-score', a.workspaceId, standing.v, Math.floor(Date.now() / 60_000)].join('|'), compute);
    c.header('x-nightmail-sender-score-cache', body.cache);
    return c.json(body.value, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/sender-score/release', operationId: 'releaseSenderStanding', tags: ['Metrics'], security: dashboardSecurity,
    description: 'Owner self-service on the dashboard, after the fix checklist. A restrict (marketing held) can be released 24 hours after it started, once every 14 days, when the last 24 hours are back under the warn line: marketing resumes at 50% of its allowance for 48 hours. A pause caused only by transactional bounces can be resumed once every 30 days: the limit is 50% for 48 hours and marketing stays held for 24 hours. Anything else needs a review. Owners and admins only.',
    request: { body: json(z.object({ checklist: z.object({ bouncedRemoved: z.literal(true).describe('Contacts that bounced or complained are removed.'), listSourceConfirmed: z.literal(true).describe('Every contact opted in; no bought or old lists.') }).strict() }).strict().openapi('SenderStandingRelease')) },
    responses: { 200: response(SenderScoreSchema), ...errors } }), async c => {
    const session = dashboardSession(c, true);
    const { applyChange, liveLadder } = await import('./standing.js');
    const stored = (await c.env.db.execute<Stored>(sql`SELECT * FROM sender_standing WHERE workspace_id=${session.workspaceId}`)).rows[0];
    if (!stored) throw new ApiError(404, 'NOT_FOUND', 'This workspace has no Hosted sending standing.');
    const offer = selfService(stored);
    if (!offer.available) throw new ApiError(409, 'STANDING_REVIEW_REQUIRED', offer.reason ?? 'Nothing to release: sending is not held.', undefined, false, offer.availableAt ?? undefined);
    if (offer.action === 'release_marketing') {
      const live = await liveLadder(c.env, session.workspaceId);
      if (live && stepRank(evaluateLadder(live).level) >= stepRank('warn')) throw new ApiError(409, 'STANDING_STILL_ABOVE_LINE', 'The last 24 hours are still over the warn line. Remove the contacts that bounced or complained, then try again once the rate is under it.');
    }
    await c.env.db.transaction(tx => applyChange(tx, { workspaceId: session.workspaceId, actor: { kind: 'owner', id: session.userId, via: 'dashboard' }, kind: 'release', expectVersion: stored.version, step: 'warn',
      reasons: stored.reasons, ...(offer.action === 'release_marketing' ? { release: { percent: 50, hours: 48 }, touch: { lastRelease: true } } : { resume: { percent: 50, marketingHours: 24, caps: c.env.config.hostedSendCaps }, touch: { lastSelfResume: true } }),
      details: { checklist: ['bouncedRemoved', 'listSourceConfirmed'], action: offer.action } }));
    return c.json(scoreView(await loadDisplayedStanding(c.env, session.workspaceId)), 200);
  });
}
