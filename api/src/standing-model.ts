import { productName } from './brand.js'
// Sender standing: the pure model behind the ten-minute standing job (standing.ts), GET /v1/sender-score and the
// published thresholds (docs/sending-limits.md). No I/O here, so the job, the route and the tests share it.
//
//   factor score  s = 100 × clamp((bad − x) ÷ (bad − good), 0, 1), x a rate decayed with a 30-day half-life
//   quality       Q = Σ weight·s ÷ Σ weight over measured factors (neutral ones drop out, the rest re-weigh)
//   evaluation    a new workspace's first EVALUATION.recipients real recipients, at most that many in 24 hours, until
//                 they were accepted and their delivery results are in (90% of them, or an hour after the last), then
//                 the score is their quality alone
//   score         Q, recomputed from all the evidence (counted hourly; no prior, no daily movement limit): complaints
//                 that arrive days after the evaluation move it as soon as they are counted
//   growth        for GROWTH.hours clean hours after a new sender's evaluation, a sponsor's growing workspaces may send at
//                 most 1,000 recipients in a rolling hour, then twice the distinct recipients of its last mature, clean hour; a
//                 workspace with a clean track record from before the pace existed, or an operator override, skips it
//   limit         none at 75 and up (good standing); under it the bands below, dropping only 2 points under a band
//   ladder        notice → warn → restrict (marketing held) → pause (all sending), each line a count and a rate; a
//                 step from warn up, a pause or a resume freezes the limit (none becomes what SES accepted in 24 hours,
//                 at least 10,000), and it stays frozen until the step and any strike reduction are over

export const GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_BANDS: { grade: Grade; min: number }[] = [{ grade: 'A+', min: 95 }, { grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'F', min: 0 }];
export const gradeOf = (score: number): Grade => GRADE_BANDS.find(b => score >= b.min)!.grade;

/** Score → daily limit (rolling 24 hours, recipients); null is no daily limit: good standing. Published. */
export const GOOD_STANDING = 75;
export const LIMIT_BANDS: readonly { min: number; limit: number | null }[] = [
  { min: GOOD_STANDING, limit: null }, { min: 70, limit: 500 }, { min: 65, limit: 200 }, { min: -Infinity, limit: 100 },
];
/** The bottom band's limit: a second strike halves a limit no lower than this. */
const LOWEST_BAND = LIMIT_BANDS[LIMIT_BANDS.length - 1]!.limit!;
/**
 * The evaluation: a new workspace's first 500 real recipients go at the normal pace and it can send no more until their
 * delivery results are in (90% of them delivered or bounced, or an hour after the last was accepted). Hard bounces and
 * the spam screen, the signs of a bad list, arrive within minutes, so this is the smallest wait that has them. 500 lets a
 * launch to a few hundred users through without a stop; the ladder's bounce and complaint lines apply to them as to any
 * mail. The one definition: config's hostedSendCaps, the job and the API's and dashboard's copy read it from here.
 */
export const EVALUATION = { recipients: 500, limit: 500, resolved: 0.9, waitMinutes: 60 } as const;
/** prior: the score with nothing measured at all (no real mail in 180 days). */
export const SCORE = { prior: 60, halfLifeDays: 30, hysteresis: 2, historyDays: 180 };
/**
 * From warn up the limit is frozen: a workspace without one gets what SES accepted from it in the last 24 hours
 * (hosted_accepted_day: never queued or unsent mail), at least this.
 */
export const FREEZE_FLOOR = 10_000;
/**
 * Growth after the evaluation, so a clean evaluation cannot be followed by a full-pace blast before any feedback exists.
 * For 24 clean hours (a ladder step from warn up starts them again) a sponsor's growing workspaces share one rolling-hour
 * allowance, enforced in the dispatch claim for every stream (hosted_burst_ok): 1,000 recipients, and after each
 * completed hour that is feedback-mature (90% of its accepted recipients delivered or bounced) and clean (hard bounces
 * under 2%, no complaints, quality no more than 2 points below the last growth), twice that hour's distinct real
 * recipients if that is more. Stale feedback, a notice or worse, or worsening quality stop the growth; nothing lowers
 * it. An operator can lift it for a workspace. A good sender doubles every hour: about a million an hour after ten.
 */
export const GROWTH = { start: 1_000, factor: 2, hours: 24, resolved: 0.9, bounceRate: 0.02, qualityDrop: 2 } as const;
/**
 * The growth pace is for new senders only. A workspace skips it (and leaves it, if it is on it) with an active operator
 * daily-limit override, or with a clean track record from before the pace existed: SES acceptances before its baseline
 * (the pace's rollout, for workspaces that existed then; none for later ones) and before its evaluation, in the 30
 * completed UTC days before that, leaving out its evaluation's recipients (its seeds). The record needs mail on 3 days, 300
 * distinct real recipients at more than one domain, 90% of them resolved, hard bounces under 2% and no complaints, and the
 * workspace in good standing at ok. Mail accepted later, or without an acceptance event, never counts.
 */
export const ESTABLISHED = { days: 3, recipients: 300, domains: 2, windowDays: 30, resolved: 0.9, bounceRate: 0.02 } as const;
/** Pre-baseline history per recipient: `accepted` recipient rows, how many resolved, bounced or complained. */
export type TrackRecord = { days: number; recipients: number; domains: number; accepted: number; resolved: number; bounces: number; complaints: number };
export function establishedBy(o: { override: boolean; history: TrackRecord | null; score: number | null; step: Step }): 'OPERATOR_OVERRIDE' | 'TRACK_RECORD' | null {
  if (o.override) return 'OPERATOR_OVERRIDE';
  const h = o.history;
  if (!h || o.score === null || o.score < GOOD_STANDING || o.step !== 'ok') return null;
  const clean = h.days >= ESTABLISHED.days && h.recipients >= ESTABLISHED.recipients && h.domains >= ESTABLISHED.domains
    && h.resolved >= ESTABLISHED.resolved * h.accepted && h.bounces < ESTABLISHED.bounceRate * h.accepted && h.complaints === 0;
  return clean ? 'TRACK_RECORD' : null;
}
/**
 * Pacing protects the shared pool; it is not a customer limit. With a daily limit: clamp(limit ÷ 20, 50, 500) a minute.
 * In good standing past growth: the full pool SES rate for marketing (at least 500 a minute; a quarter while in growth),
 * half per sending domain (at least 50). There, transactional has its own minute/domain buckets at a quarter of the pool
 * rate, so marketing never consumes it; every other workspace has one minute cap shared by both streams.
 * The dispatcher shares marketing round-robin across active workspaces and puts transactional first (migration 457).
 */
export const PACE = { floor: 50, ceiling: 500, perDay: 20, uncappedFloor: 500, poolShare: 1 } as const;
export const bandFor = (score: number) => LIMIT_BANDS.find(b => score >= b.min)!;
export const nextBand = (score: number) => [...LIMIT_BANDS].reverse().find(b => b.min > score) ?? null;
/**
 * Per minute for a daily limit (null: the uncapped floor; the API reports the pool-based figure); marketing per hour
 * max(25, limit ÷ 4); the transactional reserve max(100, 10%), none during the evaluation: it lifts within about an hour
 * of its last recipient, and a sender of newsletters alone must be able to finish it (hosted_allowance_read, migration 400).
 */
export const burstFor = (limit: number | null) => limit === null ? PACE.uncappedFloor : Math.min(PACE.ceiling, Math.max(PACE.floor, Math.floor(limit / PACE.perDay)));
export const marketingHourFor = (limit: number) => Math.max(25, Math.floor(limit / 4));
export const reserveFor = (limit: number, evaluating = false) => evaluating ? 0 : Math.max(Math.min(100, limit), Math.ceil(limit * 0.1));

// No daily limit ranks above every number.
const rank = (limit: number | null) => limit ?? Infinity;
const looser = (a: number | null, b: number | null) => rank(a) >= rank(b) ? a : b;
const tighter = (a: number | null, b: number | null) => rank(a) <= rank(b) ? a : b;
/** The band a score holds: rises at the band floor, drops only `hysteresis` points under it. null: no daily limit. */
export function bandLimit(score: number, current: number | null) {
  const up = bandFor(score).limit;
  if (rank(up) >= rank(current)) return up;
  return looser(up, tighter(current, bandFor(score + SCORE.hysteresis).limit));
}

export const FACTOR_KEYS = ['complaints', 'content', 'bounces', 'hygiene', 'auth', 'engagement'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];
export const FACTORS: Record<FactorKey, { label: string; weight: number; good: number; bad: number; basis: string }> = {
  complaints: { label: 'Complaints', weight: 30, good: 0.0001, bad: 0.003, basis: 'Spam complaints ÷ delivered emails. 0.3% is the line mailbox providers enforce.' },
  content: { label: 'Spam screen', weight: 20, good: 0.001, bad: 0.03, basis: 'Emails the content screen rejected as spam ÷ emails it screened. Neutral when the workspace is not screened.' },
  bounces: { label: 'Bounces', weight: 15, good: 0.005, bad: 0.05, basis: 'Hard bounces to known recipients ÷ accepted emails to them. Mail sent through the API counts as known.' },
  hygiene: { label: 'List quality', weight: 15, good: 0.02, bad: 0.10, basis: 'Campaign mail only: hard bounces of first sends plus campaign emails to suppressed addresses ÷ those emails. First sends are expected to bounce more. Neutral without campaign mail.' },
  auth: { label: 'Authentication', weight: 10, good: 1, bad: 0, basis: 'By sending volume: DKIM signing 40%, a verified custom MAIL FROM (aligned SPF) 30%, DMARC enforcing 30% (p=none 15%). Neutral without verified domains.' },
  engagement: { label: 'Engagement', weight: 10, good: 0.002, bad: 0.02, basis: 'Marketing unsubscribes ÷ delivered marketing email, lifted up to 10 points by tracked clicks. Opens are ignored. Neutral without marketing mail.' },
};

/** One UTC day of a workspace's real mail. first_sends, first_bounced and suppressed count campaign mail only (list quality). */
export type DayEvidence = { day: string; emails: number; accepted: number; delivered: number; bounced: number; first_sends: number; first_bounced: number;
  complained: number; screened: number; rejected: number; suppressed: number; marketing_delivered: number; unsubscribed: number; clicked: number };
export type DomainAuth = { name: string; dkim: boolean; mailFrom: boolean; dmarc: string | null; emails: number };
export type Factor = { key: FactorKey; label: string; weight: number; value: number | null; score: number | null; points: number | null; source: 'measured' | 'neutral'; basis: string };
export type Quality = { quality: number; volume: number; target: number; factors: Factor[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const DAY_MS = 86_400_000;
const subscore = (key: FactorKey, x: number) => { const { good, bad } = FACTORS[key]; return 100 * clamp((bad - x) / (bad - good), 0, 1); };
// DKIM 40 + aligned SPF 30 + DMARC 30 (p=none half), weighted by each domain's mail, or evenly when there is none.
export function authShare(domains: DomainAuth[]): number | null {
  if (!domains.length) return null;
  const share = (d: DomainAuth) => (d.dkim ? 0.4 : 0) + (d.mailFrom ? 0.3 : 0) + (d.dmarc === 'quarantine' || d.dmarc === 'reject' ? 0.3 : d.dmarc === 'none' ? 0.15 : 0);
  const volume = domains.reduce((sum, d) => sum + d.emails, 0);
  return volume ? domains.reduce((sum, d) => sum + share(d) * d.emails, 0) / volume : domains.reduce((sum, d) => sum + share(d), 0) / domains.length;
}

/** Quality, decayed volume and target (the quality itself) from daily evidence (30-day half-life) and the domains' authentication. */
export function quality(days: DayEvidence[], domains: DomainAuth[], screened: boolean, today: string): Quality {
  const end = Date.parse(today + 'T00:00:00Z'), t = { accepted: 0, delivered: 0, bounced: 0, known: 0, campaign: 0, firstSends: 0, firstBad: 0, complained: 0, screened: 0, rejected: 0, mDelivered: 0, unsub: 0, clicked: 0 };
  for (const d of days) {
    const age = Math.max(0, (end - Date.parse(d.day + 'T00:00:00Z')) / DAY_MS);
    if (age > SCORE.historyDays) continue;
    const w = 2 ** (-age / SCORE.halfLifeDays);
    t.accepted += w * d.accepted; t.delivered += w * d.delivered; t.complained += w * d.complained;
    t.known += w * (d.accepted - d.first_sends); t.bounced += w * (d.bounced - d.first_bounced);
    t.campaign += w * d.first_sends; t.firstSends += w * (d.first_sends + d.suppressed); t.firstBad += w * (d.first_bounced + d.suppressed);
    t.screened += w * d.screened; t.rejected += w * d.rejected;
    t.mDelivered += w * d.marketing_delivered; t.unsub += w * d.unsubscribed; t.clicked += w * d.clicked;
  }
  const values: Record<FactorKey, number | null> = {
    complaints: t.delivered >= 1 ? t.complained / t.delivered : null,
    content: screened && t.screened >= 1 ? t.rejected / t.screened : null,
    bounces: t.known >= 1 ? t.bounced / t.known : null,
    // A list is campaign mail: without a campaign email sent there is no list to judge, whatever was suppressed.
    hygiene: t.campaign > 0 && t.firstSends >= 1 ? t.firstBad / t.firstSends : null,
    auth: authShare(domains),
    engagement: t.mDelivered >= 1 ? t.unsub / t.mDelivered : null,
  };
  const factors: Factor[] = FACTOR_KEYS.map(key => {
    const spec = FACTORS[key], value = values[key];
    if (value === null) return { key, label: spec.label, weight: spec.weight, value: null, score: null, points: null, source: 'neutral', basis: spec.basis };
    let score = subscore(key, value);
    if (key === 'engagement') score = Math.min(100, score + Math.min(10, 500 * (t.clicked / t.mDelivered)));
    return { key, label: spec.label, weight: spec.weight, value: round(value, 6), score: round(score), points: round(spec.weight * score / 100, 2), source: 'measured', basis: spec.basis };
  });
  const measured = factors.filter(f => f.source === 'measured'), weight = measured.reduce((s, f) => s + f.weight, 0);
  const q = weight ? measured.reduce((s, f) => s + f.weight * f.score! / 100, 0) / weight * 100 : SCORE.prior;
  // No volume prior: the evaluation's recipients establish the score on their own, and later mail moves it as it comes.
  return { quality: round(q, 2), volume: round(t.accepted, 2), target: round(q, 2), factors };
}

export type ScoreState = { phase: 'seed' | 'calibrating' | 'graded'; firstRecipients: number; calibratedAt: string | null; score: number | null; dayScore: number | null; scoreDay: string | null };
/** Real mail counted so far: accepted emails, and how many of them have a delivery result (delivered or bounced). */
export type Evaluated = { accepted: number; resolved: number };
/** Days of evidence as the evaluation reads them. */
export const evaluated = (days: Pick<DayEvidence, 'accepted' | 'delivered' | 'bounced'>[]): Evaluated =>
  days.reduce((n, d) => ({ accepted: n.accepted + Number(d.accepted), resolved: n.resolved + Math.min(Number(d.accepted), Number(d.delivered) + Number(d.bounced)) }), { accepted: 0, resolved: 0 });
/** Moves the published score: the evaluation, then the target itself on every run. */
export function moveScore(prev: ScoreState, target: number, mail: Evaluated, now: Date): ScoreState {
  const today = now.toISOString().slice(0, 10), recipients = Math.min(EVALUATION.recipients, Math.max(prev.firstRecipients, mail.accepted)), score = round(target, 2);
  if (prev.phase === 'seed') {
    // Existing senders already have evidence: graded at once.
    if (recipients < EVALUATION.recipients) return { phase: 'calibrating', firstRecipients: recipients, calibratedAt: null, score: null, dayScore: null, scoreDay: null };
    return { phase: 'graded', firstRecipients: recipients, calibratedAt: prev.calibratedAt ?? now.toISOString(), score, dayScore: score, scoreDay: today };
  }
  if (prev.phase === 'calibrating') {
    // calibratedAt: when the job first counted the evaluation's last accepted recipient.
    const calibratedAt = prev.calibratedAt ?? (recipients >= EVALUATION.recipients ? now.toISOString() : null);
    const resultsIn = mail.accepted > 0 && mail.resolved >= EVALUATION.resolved * mail.accepted;
    if (!calibratedAt || (!resultsIn && now.getTime() - Date.parse(calibratedAt) < EVALUATION.waitMinutes * 60_000)) return { ...prev, firstRecipients: recipients, calibratedAt };
    return { phase: 'graded', firstRecipients: recipients, calibratedAt, score, dayScore: score, scoreDay: today };
  }
  return { ...prev, firstRecipients: recipients, score, dayScore: score, scoreDay: today };
}

// ---------- the ladder ----------
export const STEPS = ['ok', 'notice', 'warn', 'restrict', 'pause'] as const;
export type Step = (typeof STEPS)[number];
export const stepRank = (s: Step) => STEPS.indexOf(s);
export type Window = { accepted: number; bounces: number; complaints: number; marketingAccepted: number; marketingBounces: number; marketingComplaints: number };
export type LadderInput = { day: Window; week: Window; screened: number; rejected: number };
export type Reason = { code: string; metric: 'complaints' | 'bounces' | 'marketing_bounces' | 'transactional_bounces' | 'screen' | 'external'; value: number; count: number; threshold: number; minimum: number; window: '24h' | '7d' | null; step: Step; message: string };
type LadderLine = { rate: number; count: number; window: '24h' | '7d' };
// Published account-standing lines. Both the event floor and the unrounded rate are inclusive.
// Feedback uses accepted mail of the same stream, with an extra day for late feedback (24h/48h or 7d/8d).
// Screening uses rejections / screened mail in 24h. Zero volume cannot establish a rate.
// SES references: complaints 0.1%/0.5%, bounces 5%/10%. The warn, restrict and pause lines below are Nightmail's.
export const LADDER = {
  complaints: {
    notice: [{ rate: 0.0001, count: 2, window: '24h' }],
    warn: [{ rate: 0.0005, count: 2, window: '24h' }, { rate: 0.0005, count: 3, window: '7d' }],
    restrict: [{ rate: 0.001, count: 3, window: '24h' }],
    pause: [{ rate: 0.003, count: 5, window: '24h' }, { rate: 0.0015, count: 10, window: '7d' }],
  },
  bounces: {
    notice: [{ rate: 0.01, count: 3, window: '24h' }],
    warn: [{ rate: 0.02, count: 10, window: '24h' }, { rate: 0.015, count: 10, window: '7d' }],
    // Pool emergency across all mail. Bounces stop transactional mail only on its own pause line below.
    restrict: [{ rate: 0.08, count: 50, window: '24h' }],
  },
  marketingBounces: { restrict: [{ rate: 0.04, count: 25, window: '24h' }] },
  transactionalBounces: { pause: [{ rate: 0.05, count: 50, window: '24h' }] },
  screen: {
    warn: [{ rate: 0.02, count: 3, window: '24h' }],
    restrict: [{ rate: 0.05, count: 10, window: '24h' }],
    pause: [{ rate: 0.10, count: 25, window: '24h' }],
  },
} as const satisfies Record<string, Partial<Record<Exclude<Step, 'ok'>, readonly LadderLine[]>>>;
const percentage = new Intl.NumberFormat('en-US', { style: 'percent', maximumSignificantDigits: 4 });
export const pct = (rate: number) => percentage.format(rate);
const reaches = (count: number, volume: number, line: LadderLine, fraction = 1) =>
  volume > 0 && count >= line.count * fraction && count / volume >= line.rate * fraction;

/** A measured notice, or a quiet explanation for the standing card. An OK explanation never raises a step. */
export function noticeReasons(day: Pick<Window, 'accepted' | 'complaints' | 'bounces'>, step: 'notice' | 'ok'): Reason[] {
  if (day.accepted <= 0) return [];
  const reasons: Reason[] = [];
  for (const metric of ['complaints', 'bounces'] as const) {
    const count = day[metric], line = LADDER[metric].notice[0];
    if (!count || reaches(count, day.accepted, line) !== (step === 'notice')) continue;
    const noun = metric === 'complaints' ? 'complaint' : 'hard bounce', code = metric === 'complaints' ? 'COMPLAINT' : 'BOUNCE';
    const rate = count / day.accepted, measured = pct(rate), threshold = pct(line.rate);
    const shown = rate < line.rate && measured === threshold ? `<${threshold}` : measured;
    const why = rate < line.rate ? `, under the notice line of ${threshold}`
      : `; the ${threshold} notice line ${step === 'ok' ? 'also ' : ''}needs at least ${line.count} ${noun}s`;
    reasons.push({ code: `${code}_${step === 'ok' ? 'BELOW_NOTICE' : 'NOTICE'}`, metric, step, window: line.window, count, value: rate, threshold: line.rate, minimum: line.count,
      message: `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'} in 24 hours (${shown})${why}.` });
  }
  return reasons;
}

/** The highest crossed step, with the highest applicable reason per metric. No below-line evidence enforces a step. */
export function evaluateLadder(input: LadderInput): { level: Step; reasons: Reason[]; pauseKind: 'bounce' | 'full' | null } {
  const reasons: Reason[] = [];
  const check = (metric: Reason['metric'], step: Step, lines: readonly LadderLine[], count: (w: '24h' | '7d') => number, total: (w: '24h' | '7d') => number, what: string) => {
    for (const line of lines) {
      const w = line.window, n = count(w), d = total(w);
      if (reaches(n, d, line)) {
        const rate = n / d;
        reasons.push({ code: `${metric.toUpperCase()}_${step.toUpperCase()}`, metric, value: round(rate, 6), count: n, threshold: line.rate, minimum: line.count, window: w, step,
          message: `${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')} ${what} in ${w === '24h' ? '24 hours' : '7 days'} (${pct(rate)}; the ${step} line is ${pct(line.rate)} and ${line.count}).` });
        return;
      }
    }
  };
  const win = (w: '24h' | '7d') => w === '24h' ? input.day : input.week;
  for (const step of ['pause', 'restrict', 'warn'] as const) {
    check('complaints', step, LADDER.complaints[step], w => win(w).complaints, w => win(w).accepted, 'accepted emails were marked as spam');
    const screen = LADDER.screen[step];
    check('screen', step, screen, () => input.rejected, () => input.screened, 'screened emails were rejected as spam');
  }
  check('transactional_bounces', 'pause', LADDER.transactionalBounces.pause, w => win(w).bounces - win(w).marketingBounces, w => win(w).accepted - win(w).marketingAccepted, 'transactional emails hard-bounced');
  check('marketing_bounces', 'restrict', LADDER.marketingBounces.restrict, w => win(w).marketingBounces, w => win(w).marketingAccepted, 'marketing emails hard-bounced');
  check('bounces', 'restrict', LADDER.bounces.restrict, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  check('bounces', 'warn', LADDER.bounces.warn, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  const top = reasons.reduce<Step>((s, r) => stepRank(r.step) > stepRank(s) ? r.step : s, 'ok');
  // Keep only the highest line per metric.
  const kept = reasons.filter(r => !reasons.some(o => o !== r && o.metric === r.metric && stepRank(o.step) > stepRank(r.step)));
  if (top === 'ok') {
    const notices = noticeReasons(input.day, 'notice');
    return { level: notices.length ? 'notice' : 'ok', reasons: notices, pauseKind: null };
  }
  const pauseKind = top !== 'pause' ? null : kept.some(r => r.step === 'pause' && r.metric !== 'transactional_bounces') ? 'full' : 'bounce';
  return { level: top, reasons: kept, pauseKind };
}

export type StandingState = { step: Step; reasons: Reason[]; since: string; clearSince: string | null; pauseKind: 'bounce' | 'full' | null };
/**
 * The next step. Steps rise as soon as a line is crossed. A warn clears by itself once every metric stayed under 80%
 * of its warn line for 24 hours; a notice clears as soon as nothing triggers it. A restrict or pause never clears by
 * itself: an owner releases it (bounce-only) or an operator does. A pause is applied by the caller (it stops mail).
 */
export function nextStanding(prev: StandingState, input: LadderInput, now: Date): StandingState {
  const at = now.toISOString(), evaluation = evaluateLadder(input);
  if (stepRank(evaluation.level) > stepRank(prev.step) && stepRank(evaluation.level) >= stepRank('warn'))
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: evaluation.pauseKind };
  if (prev.step === 'pause' || prev.step === 'restrict') {
    // A transactional bounce problem during a restrict still escalates (handled above); otherwise keep the reasons.
    return { ...prev, reasons: stepRank(evaluation.level) >= stepRank(prev.step) ? evaluation.reasons : prev.reasons };
  }
  if (prev.step === 'warn') {
    const under = belowClearLine(input);
    if (stepRank(evaluation.level) >= stepRank('warn') || !under) return { ...prev, reasons: stepRank(evaluation.level) >= stepRank('warn') ? evaluation.reasons : prev.reasons, clearSince: null };
    const clearSince = prev.clearSince ?? at;
    if (now.getTime() - Date.parse(clearSince) < 24 * 3600_000) return { ...prev, clearSince };
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  }
  if (evaluation.level !== prev.step) return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  return { ...prev, reasons: evaluation.reasons };
}
/** No metric still meets both 80% floors of a warn line. */
export function belowClearLine(input: LadderInput) {
  const f = 0.8, d = input.day, w = input.week;
  const under = (n: number, total: number, line: LadderLine) => !reaches(n, total, line, f);
  return under(d.complaints, d.accepted, LADDER.complaints.warn[0]) && under(w.complaints, w.accepted, LADDER.complaints.warn[1])
    && under(d.bounces, d.accepted, LADDER.bounces.warn[0]) && under(w.bounces, w.accepted, LADDER.bounces.warn[1])
    && under(input.rejected, input.screened, LADDER.screen.warn[0]);
}

// ---------- asking for more ----------
/**
 * Whether "a higher limit" means anything now. A workspace in good standing has no daily limit, and one capped by its
 * score (or frozen by a ladder step) has that cap lifted by the job as soon as it recovers, so nothing is approved
 * automatically any more (the old rule, a score of 90 for 14 days, only ever matched workspaces that are now uncapped).
 * A person can still review a capped workspace and set an operator override.
 */
export type LimitRequest = { eligibleForAutoApproval: false; reasons: { code: string; message: string }[]; maxAuto: 0 };
export function limitRequest(o: { phase: ScoreState['phase'] | null; step: Step | null; daily: number | null }): LimitRequest {
  const reason = o.phase === null ? { code: 'NO_STANDING', message: `This workspace has no sender standing (${productName} Hosted sending only), so a limit request goes to a person.` }
    : o.phase !== 'graded' ? { code: 'EVALUATING', message: `The evaluation lifts the limit by itself once the first ${EVALUATION.recipients} real recipients' delivery results are in.` }
    : o.daily === null ? { code: 'NO_DAILY_LIMIT', message: 'This workspace has no daily limit: there is nothing to raise. Only the per-minute pace applies.' }
    : o.step !== null && stepRank(o.step) >= stepRank('warn') ? { code: 'LADDER_STEP', message: `The limit is frozen while the workspace is at ${o.step}. It lifts once the step clears and the score is ${GOOD_STANDING} or more; a person can review it sooner.` }
    : { code: 'SCORE_CAP', message: `The score sets this limit. It lifts by itself at ${GOOD_STANDING} or more; a person can review it sooner.` };
  return { eligibleForAutoApproval: false, reasons: [reason], maxAuto: 0 };
}

/**
 * The limit admission enforces from the standing (before an operator override or a resume's restore); null is none.
 * `band` is the stored band, `acceptedDay` what SES accepted in the last 24 hours (what a freeze keeps).
 */
export function dailyLimit(o: { phase: ScoreState['phase']; score: number | null; band: number | null; step: Step; strikeCapped: boolean; acceptedDay: number }) {
  if (o.phase !== 'graded' || o.score === null) return { band: EVALUATION.limit as number | null, limit: EVALUATION.limit as number | null };
  let band = bandLimit(o.score, o.band);
  // From warn up, and for as long as a strike halves it, the limit is frozen: no rises, and no limit becomes the last
  // 24 hours' accepted volume. The stored band is the reference, so the halving cannot drift between runs.
  if (stepRank(o.step) >= stepRank('warn') || o.strikeCapped) band = tighter(band, o.band ?? Math.max(FREEZE_FLOOR, o.acceptedDay));
  const limit = o.strikeCapped && band !== null ? Math.max(LOWEST_BAND, Math.floor(band / 2)) : band;
  return { band, limit };
}

/** One completed hour of a sponsor's growing workspaces: real recipients SES accepted, distinct ones, and their results. */
export type GrowthHour = { accepted: number; distinct: number; resolved: number; bounces: number; complaints: number };
export type Growth = { until: string | null; cap: number | null; hour: string | null; quality: number | null };
export const NO_GROWTH: Growth = { until: null, cap: null, hour: null, quality: null };
/**
 * The next growth state. `graduated`: the evaluation ended in this run. `hour` is the last completed hour (its start)
 * and `evidence` its figures, when the caller counted them (null: not counted, nothing to learn from it).
 */
export function nextGrowth(prev: Growth, o: { graduated: boolean; established?: boolean; step: Step; quality: number; hour: string; evidence: GrowthHour | null; now: Date }): Growth {
  if (o.established) return NO_GROWTH;
  const later = new Date(o.now.getTime() + GROWTH.hours * 3600_000).toISOString();
  if (o.graduated) return { until: later, cap: GROWTH.start, hour: o.hour, quality: o.quality };
  if (!prev.until || Date.parse(prev.until) <= o.now.getTime() || prev.cap === null) return NO_GROWTH;
  // A ladder step from warn up starts the clean hours again; nothing grows meanwhile.
  if (stepRank(o.step) >= stepRank('warn')) return { ...prev, until: Date.parse(prev.until) < Date.parse(later) ? later : prev.until };
  const e = o.evidence;
  if (o.step !== 'ok' || !e || (prev.hour !== null && Date.parse(o.hour) <= Date.parse(prev.hour))) return prev;
  if (!e.accepted) return { ...prev, hour: o.hour };
  // Stale feedback: wait for the hour's results (the next run counts it again).
  if (e.resolved < GROWTH.resolved * e.accepted) return prev;
  const clean = e.bounces < GROWTH.bounceRate * e.accepted && e.complaints === 0 && o.quality >= (prev.quality ?? 0) - GROWTH.qualityDrop;
  if (!clean) return { ...prev, hour: o.hour };
  return { ...prev, hour: o.hour, quality: o.quality, cap: Math.max(prev.cap, GROWTH.factor * e.distinct) };
}

// ---------- the campaign ramp and send readiness ----------
/**
 * The campaign ramp and send readiness: one table. A Hosted sender's first large campaigns go out in hourly steps that
 * grow, as an SES or ESP warm-up schedule grows a new sender's volume, compressed from days to hours because Hosted mail
 * leaves shared IPs that are already warm: what is new is the sender's domain, its links and its list. The release loop
 * enforces it per campaign (src/sending.ts releaseStep), for marketing only and for every Hosted workspace, exempt and
 * first-party ones included (exemptions waive billing and limits, never bounce and complaint monitoring). Transactional
 * mail never waits for it.
 *  - steps: the hourly ceiling of each step, in order. Each step lasts at least an hour from its first release.
 *  - advance: a step is proven by a clean hour that released at least this share of its ceiling. When a step's hour is
 *    over and its batch's feedback is mature (check), a bad batch pauses the campaign; a clean one moves to the next step
 *    if it proved this one, or starts another hour on it. Past the last step only the campaign's other limits apply.
 *  - historyDays: where a sender starts. Its largest clean, mature hour of real marketing mail in this many days proves
 *    every step it would have (the same advance rule), and it starts at the first step not proven: with no history at the
 *    first, and with a clean hour of half the last ceiling or more it skips the ramp (an established sender).
 *  - check: a step's batch is mature once none of it is queued and `resolved` of what SES accepted has a delivery result
 *    (the growth pace's line), or `maxWaitMinutes` after its hour ended; release looks again every `retryMinutes`. Then
 *    more than `bounceRate` hard bounces of at least `bounceMinimum` accepted (the list probe's line and size), or more
 *    than `complaintRate` complaints counting at least `complaints` (the automatic pause's rate, the probe's count, so 1
 *    complaint in 300 is not enough) pause the campaign. The same lines judge a sender's history clean.
 *  - readiness: the review's verdict on a marketing campaign (src/sending.ts sendReadiness). Over `required.recipients`, a
 *    From domain first seen less than `newDomainDays` ago or a send over `required.jump` times the workspace's largest
 *    in `lookbackDays` (0 without one) needs the plan, a daily cap no larger than its first day, or a confirmed consent
 *    source (Hosted live sends; elsewhere it is a recommendation). Over `recommended.recipients`, a new domain, a send over
 *    `recommended.jump` times the largest, no previous send of `establishedSend`, risky or never-mailed shares over
 *    theirs, no DMARC record, or the last `windowDays` days' bounces or complaints over theirs recommend the plan.
 *  - plan: one batch a day, the first the larger of `firstBatch` and `cleanFactor` times the largest clean previous send,
 *    each next `growth` times the last, at most `maxBatches`, the last taking the rest. Contacts who opened or clicked in
 *    `engagedDays` go first, then those mailed before, never-mailed last (src/audience.ts snapshotCampaignAudience).
 *  - consent: the length of a confirmed consent source.
 * A sender with no history reaches the last step in nine clean hours, having released at most about 600,000 recipients.
 */
export const RAMP = {
  steps: [
    { ceilingPerHour: 1_000 },
    { ceilingPerHour: 2_500 },
    { ceilingPerHour: 5_000 },
    { ceilingPerHour: 10_000 },
    { ceilingPerHour: 20_000 },
    { ceilingPerHour: 40_000 },
    { ceilingPerHour: 75_000 },
    { ceilingPerHour: 150_000 },
    { ceilingPerHour: 300_000 },
  ],
  advance: 0.5,
  historyDays: 30,
  check: { resolved: 0.9, maxWaitMinutes: 60, retryMinutes: 1, bounceRate: 0.03, bounceMinimum: 100, complaintRate: 0.0008, complaints: 2 },
  readiness: {
    lookbackDays: 90, windowDays: 30, newDomainDays: 30,
    required: { recipients: 50_000, jump: 100 },
    recommended: { recipients: 5_000, jump: 10, establishedSend: 1_000, riskyShare: 0.02, neverMailedShare: 0.5, bounceRate: 0.02, complaintRate: 0.0005 },
  },
  plan: { firstBatch: 10_000, cleanFactor: 2, growth: 4, maxBatches: 5, engagedDays: 90 },
  consent: { minLength: 10, maxLength: 500 },
} as const;
export const RAMP_HOUR_MS = 3_600_000;
/** The step (an index into RAMP.steps) a sender whose largest clean marketing hour is `cleanHour` starts at; RAMP.steps.length skips the ramp. */
export function rampStart(cleanHour: number) {
  const step = RAMP.steps.findIndex(s => cleanHour < s.ceilingPerHour * RAMP.advance);
  return step < 0 ? RAMP.steps.length : step;
}
/** Where a campaign is on the ramp: `step` indexes RAMP.steps; the step's hour started at `startedAt` (ms, null before its first release) and released `released` since. */
export type RampAt = { step: number; startedAt: number | null; released: number };
/**
 * When a campaign releases its last recipient (ms), or null when it cannot be told (no known send rate, or over 100,000
 * windows away). It releases at `ratePerSecond` × `rateShare` from `start`, at most `perDay` in each 24-hour window (a
 * plan: its batches, one a window, the last repeating; the current window opened at `day.startedAt` as the plan's
 * `day.index`th, with `day.released` already out) and at most the ramp step's ceiling in each of its hours, moving on as
 * RAMP.advance says. An estimate: it assumes clean, immediate feedback and leaves out the list probe's wait, quota holds
 * and other mail sharing the rate.
 */
export function estimateFinish(o: { recipients: number; start: number; ratePerSecond: number; rateShare?: number | null; perDay?: number | readonly number[] | null; day?: { startedAt: number | null; released: number; index?: number } | null; ramp?: RampAt | null }): number | null {
  const perMs = o.ratePerSecond * (o.rateShare ?? 1) / 1000, perDay = o.perDay ?? null, DAY = 86_400_000;
  if (!(perMs > 0) || !Number.isFinite(o.recipients)) return null;
  const cap = (index: number) => perDay === null ? Infinity : typeof perDay === 'number' ? perDay : perDay[Math.min(index, perDay.length - 1)] ?? Infinity;
  let left = Math.max(0, o.recipients), t = o.start;
  let step = o.ramp ? o.ramp.step : RAMP.steps.length, hourStart = o.ramp?.startedAt ?? null, hourUsed = o.ramp?.released ?? 0;
  let dayStart = o.day?.startedAt ?? null, dayUsed = o.day?.released ?? 0, dayIndex = o.day?.index ?? 0;
  for (let i = 0; i < 100_000 && left > 1e-6; i++) {
    const ramping = step < RAMP.steps.length;
    if (ramping && hourStart !== null && t >= hourStart + RAMP_HOUR_MS) {
      if (hourUsed >= RAMP.steps[step]!.ceilingPerHour * RAMP.advance) step++;
      hourStart = null; hourUsed = 0;
      continue;
    }
    if (ramping && hourStart === null) hourStart = t;
    if (perDay !== null && (dayStart === null || t >= dayStart + DAY)) { if (dayStart !== null) dayIndex++; dayStart = t; dayUsed = 0; }
    const hourLeft = ramping ? RAMP.steps[step]!.ceilingPerHour - hourUsed : Infinity, dayLeft = cap(dayIndex) - dayUsed;
    if (hourLeft <= 0 || dayLeft <= 0) { t = Math.max(hourLeft <= 0 ? hourStart! + RAMP_HOUR_MS : t, dayLeft <= 0 ? dayStart! + DAY : t); continue; }
    const n = Math.min(left, hourLeft, dayLeft);
    const end = Math.min(t + n / perMs, ramping ? hourStart! + RAMP_HOUR_MS : Infinity, perDay !== null ? dayStart! + DAY : Infinity);
    const sent = Math.min(n, (end - t) * perMs);
    left -= sent; hourUsed += sent; dayUsed += sent; t = end;
  }
  return left > 1e-6 ? null : Math.round(t);
}

/** What the review judges a marketing campaign by (src/sending.ts sendReadiness gathers it). */
export type ReadinessFacts = {
  recipients: number; matched: number | null; risky: number; neverMailed: number | null;
  /** Days since this workspace added the From domain (or the domain it is under). */
  domainAgeDays: number | null; dmarc: boolean | null;
  /** Days since the From domain's registrable domain was registered, from public registry data (RDAP); null when unknown. */
  registeredDays: number | null;
  /** The same for the registrable domain its links go on; null when unknown or the same as the From domain's. */
  linkRegisteredDays: number | null;
  largestSend: number; largestCleanSend: number;
  /** The workspace's usual day: the median of its daily accepted mail over its active days of the last two weeks. */
  usualDay: number;
  /** A send of this workspace from this From domain or on this link domain drew replies naming a blocklist, and no send has finished cleanly since. */
  blocklisted?: boolean;
  /** Whether the blocklist replies of a recent send aren't counted yet (the delivery history hasn't reached it). */
  blocklistUncounted?: boolean;
  accepted: number; bounced: number; complained: number;
  /** Whether a ramp can be required (Hosted live sending); elsewhere the most it says is a recommendation. */
  enforced: boolean;
  lines?: RampLines;
};
/**
 * How the review sizes a ramp. The defaults are RAMP's; the private NIGHTMAIL_RAMP setting (src/ramp-lines.ts) overrides
 * them per installation.
 *  - newRegistrationDays: a domain registered more recently than this is new to the internet (NEW_REGISTRATION).
 *  - usualJump: a send more than this many times the usual day, and larger than any clean send before, is a jump (USUAL_JUMP).
 *  - young: the plan of a newly registered domain; established: everyone else's. Each: the first day (at least),
 *    cleanFactor times the larger of the largest clean send and the usual day (at least), growth per day, at most
 *    maxBatches days. minimumSplit: a send the review recommends a ramp for is split into two days or more when larger than this.
 *  - firstBatch: a ramp's first day starts with this many, then waits waitMinutes for their bounces and rejections before
 *    the rest of the day's batch.
 */
export type RampLines = {
  newRegistrationDays: number; usualJump: number; minimumSplit: number;
  young: { first: number; cleanFactor: number; growth: number; maxBatches: number };
  established: { first: number; cleanFactor: number; growth: number; maxBatches: number };
  firstBatch: { size: number; waitMinutes: number };
};
export const RAMP_LINES: RampLines = {
  newRegistrationDays: RAMP.readiness.newDomainDays, usualJump: RAMP.readiness.recommended.jump, minimumSplit: 2_000,
  young: { first: RAMP.plan.firstBatch, cleanFactor: RAMP.plan.cleanFactor, growth: RAMP.plan.growth, maxBatches: RAMP.plan.maxBatches },
  established: { first: RAMP.plan.firstBatch, cleanFactor: RAMP.plan.cleanFactor, growth: RAMP.plan.growth, maxBatches: RAMP.plan.maxBatches },
  firstBatch: { size: 2_000, waitMinutes: 60 },
};
/** RAMP_LINES with an override's values. */
export function rampLines(override: { [K in keyof RampLines]?: RampLines[K] extends object ? Partial<RampLines[K]> : RampLines[K] } | null | undefined): RampLines {
  if (!override) return RAMP_LINES;
  return { ...RAMP_LINES, ...override, young: { ...RAMP_LINES.young, ...override.young }, established: { ...RAMP_LINES.established, ...override.established }, firstBatch: { ...RAMP_LINES.firstBatch, ...override.firstBatch } } as RampLines;
}
export const READINESS_REASONS = ['NEW_DOMAIN', 'SIZE_JUMP', 'NO_HISTORY', 'RISKY_LIST', 'NEVER_MAILED', 'NO_DMARC', 'BOUNCES', 'COMPLAINTS', 'NEW_REGISTRATION', 'NEW_HERE', 'USUAL_JUMP', 'NEW_LINK_DOMAIN', 'BLOCKLISTED_BEFORE', 'BLOCKLIST_UNCOUNTED'] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];
export type Verdict = 'ready' | 'ramp_recommended' | 'ramp_required';
export type RequiredBy = 'NEW_REGISTRATION' | 'BLOCKLISTED' | 'NEW_DOMAIN' | 'SIZE_JUMP';
/**
 * The verdict, its reasons, what requires the ramp, and the plan (RAMP.readiness, RampLines). How old the domain is on
 * the internet and how long it has sent here are told apart: a domain registered recently gets the young plan, and the
 * ramp can be required for it; an established domain new here, or a send far above its usual day and anything it sent
 * cleanly before, gets a plan sized from that history. A domain whose registration is unknown is judged as before, by when
 * it was added here: unknown is never taken for old. A send after one that drew blocklist replies, until a send finishes
 * without any, must ramp (BLOCKLISTED; a consent confirmation doesn't waive it). A plan recommended or required is never a
 * single day, and its first day starts with a small batch and a wait (firstBatch).
 */
export function judgeReadiness(f: ReadinessFacts): { verdict: Verdict; reasons: ReadinessReason[]; requiredBy: RequiredBy | null; jump: number | null; usualJump: number | null; plan: number[]; firstBatch: RampLines['firstBatch'] | null } {
  const r = RAMP.readiness, rec = r.recommended, n = f.recipients, lines = f.lines ?? RAMP_LINES;
  const jump = f.largestSend > 0 ? n / f.largestSend : null, usualJump = f.usualDay > 0 ? n / f.usualDay : null;
  const young = f.registeredDays !== null && f.registeredDays < lines.newRegistrationDays;
  const newHere = f.domainAgeDays !== null && f.domainAgeDays < r.newDomainDays;
  // A blocklist first: it outranks everything else the review says.
  const reasons: ReadinessReason[] = [];
  if (f.blocklisted) reasons.push('BLOCKLISTED_BEFORE');
  else if (f.blocklistUncounted) reasons.push('BLOCKLIST_UNCOUNTED');
  if (young) reasons.push('NEW_REGISTRATION');
  else if (newHere) reasons.push(f.registeredDays === null ? 'NEW_DOMAIN' : 'NEW_HERE');
  if (f.linkRegisteredDays !== null && f.linkRegisteredDays < lines.newRegistrationDays) reasons.push('NEW_LINK_DOMAIN');
  if (jump !== null && jump > rec.jump) reasons.push('SIZE_JUMP');
  if (usualJump !== null && usualJump > lines.usualJump && n > f.largestCleanSend && !reasons.includes('SIZE_JUMP')) reasons.push('USUAL_JUMP');
  if (f.largestSend < rec.establishedSend) reasons.push('NO_HISTORY');
  if (f.matched && f.risky > rec.riskyShare * f.matched) reasons.push('RISKY_LIST');
  if (f.neverMailed !== null && n > 0 && f.neverMailed > rec.neverMailedShare * n) reasons.push('NEVER_MAILED');
  if (f.dmarc === false) reasons.push('NO_DMARC');
  if (f.accepted > 0 && f.bounced > rec.bounceRate * f.accepted) reasons.push('BOUNCES');
  if (f.accepted > 0 && f.complained > rec.complaintRate * f.accepted) reasons.push('COMPLAINTS');
  const base = Math.max(f.largestCleanSend, f.usualDay);
  let plan = rampPlan(n, base, { young, lines });
  // A domain whose clean sends here already cover this send in the plan's first day has no plan to require: it stays a
  // reason (ramp_recommended) rather than a requirement whose daily limit is the whole list.
  const planned = plan.length > 1;
  const requiredBy: RequiredBy | null = f.enforced && f.blocklisted && n >= rec.recipients ? 'BLOCKLISTED' : !f.enforced || n < r.required.recipients ? null : young && planned ? 'NEW_REGISTRATION'
    : f.registeredDays === null && newHere && planned ? 'NEW_DOMAIN' : n > r.required.jump * f.largestSend ? 'SIZE_JUMP' : null;
  const verdict: Verdict = requiredBy ? 'ramp_required' : n >= rec.recipients && reasons.length ? 'ramp_recommended' : 'ready';
  if (verdict !== 'ready' && plan.length === 1 && n > lines.minimumSplit) plan = rampPlan(n, base, { young, lines, split: true });
  const firstBatch = verdict !== 'ready' && plan.length > 1 && plan[0]! > lines.firstBatch.size ? lines.firstBatch : null;
  return { verdict, reasons, requiredBy, jump, usualJump, plan, firstBatch };
}
/**
 * The plan's daily batches for `recipients`: the first day the larger of the plan's first batch and cleanFactor times
 * `base` (the largest clean send or the usual day), each next `growth` times the last, at most maxBatches days, the last
 * taking the rest; one batch when they fit in the first. `split`: at least two days, the first the size that with the
 * growth covers the rest in two.
 */
export function rampPlan(recipients: number, base: number, o: { young?: boolean; split?: boolean; lines?: RampLines } = {}): number[] {
  const lines = o.lines ?? RAMP_LINES, p = o.young ? lines.young : lines.established, batches: number[] = [];
  let left = Math.max(0, Math.floor(recipients)), size = Math.max(p.first, p.cleanFactor * base);
  if (o.split && size >= left) size = Math.max(1, Math.ceil(left / (1 + p.growth)));
  while (left > 0) { const n = batches.length === p.maxBatches - 1 ? left : Math.min(left, size); batches.push(n); left -= n; size *= p.growth; }
  return batches;
}
