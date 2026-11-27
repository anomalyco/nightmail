import type { BuiltinDomain, SenderScore, StandingStep } from '../../data/types'
import { number, shortDateTime } from '../../lib/format'
import { productName } from '../../../../api/src/brand'
import { EVALUATION, FREEZE_FLOOR, GOOD_STANDING, GRADE_BANDS, GROWTH, LADDER, LIMIT_BANDS, PACE, SCORE, burstFor, pct } from '../../../../api/src/standing-model'
import './limits.css'

// A workspace's own limit in three short lines: what it is now, why, and what raises it (or keeps it off), then the
// pace. Overview's daily limit dialog shows them all, and the score explainer the limit and what raises it. The cases
// follow the order admission applies them (api/src/sender-score.ts scoreView): the built-in domain's cap, a resume's
// lower limit, an operator's override, a freeze from a warning or a second pause, the evaluation, then the score's band.
// `next` is what raises the limit (a sentence that stands alone, as the explainer shows it), what keeps it off, or what
// follows a limit that ends on its own.
export type LimitStory = { now: string; why: string; next: { kind: 'raise' | 'keep' | 'after'; text: string } | null; pace: string | null }
const nextLabel = { raise: 'What raises it', keep: 'What keeps it', after: 'After that' } as const
const perDay = (daily: number, until?: string | null) => `${number(daily)} recipients a day${until ? `, until ${shortDateTime(until)} UTC` : ''}.`
const holds: Partial<Record<StandingStep, [why: string, ends: string]>> = { warn: ['A warning about your recent mail froze it.', 'the warning clears'],
  restrict: ['Marketing is on hold, which froze it.', 'the hold ends'], pause: ['Sending is paused, which froze it.', 'the pause ends'] }
export function limitStory(report: SenderScore | undefined, builtin?: BuiltinDomain | null): LimitStory | null {
  if (builtin) return { now: `${number(builtin.perDay)} recipients a day, ${number(builtin.perMinute)} a minute.`, why: `You send from ${builtin.name}, the built-in domain.`,
    next: { kind: 'raise', text: 'Add your own domain: once it verifies, your sender score sets the limit instead.' }, pace: null }
  // Before the standing job first sees a new Hosted workspace the report has no limit yet: it is the evaluation's.
  // Graded with none is self-hosted, which has no limits.
  if (!report || (!report.limit && report.state === 'graded')) return null
  const limit = report.limit, hold = holds[report.standing?.step ?? 'ok']
  const pace = limit && `Sending is paced at up to ${number(limit.perMinute)} a minute; more waits its turn.`
  const raise = (text: string) => ({ kind: 'raise' as const, text }), later = { kind: 'after' as const, text: 'Your sender score sets it again.' }
  if (limit?.restore && limit.daily === limit.restore.daily) return { now: perDay(limit.restore.daily, limit.restore.until), why: 'Sending was resumed after a pause, so the limit is lower for a while.', next: later, pace }
  if (limit?.source === 'exempt') return { now: 'No daily limit.', why: 'This workspace is exempt from daily limits.', next: null, pace }
  if (limit?.override && limit.daily === limit.override.daily) return { now: perDay(limit.override.daily, limit.override.expiresAt), why: `${productName} set it for this workspace.`, next: raise('Ask support to change it.'), pace }
  if (limit && hold && limit.daily !== null) return { now: perDay(limit.daily), why: hold[0], next: raise(`It lifts once ${hold[1]} and your score is ${GOOD_STANDING} or more.`), pace }
  if (limit?.strikeCapUntil && limit.daily !== null) return { now: perDay(limit.daily, limit.strikeCapUntil), why: 'A second pause within 90 days halved it.', next: later, pace }
  if (!limit || limit.source === 'calibrating') return { now: `Your first ${number(report.needed)} recipients, once.`, why: 'They are your evaluation: their delivery results set your first sender score.',
    next: raise(`When their results are in, about an hour after the last, a score of ${GOOD_STANDING} or more removes the daily limit.`), pace }
  const score = Math.round(report.score ?? 0)
  if (limit.daily === null) return { now: limit.growth ? `No daily limit. For your first day sending grows: up to ${number(limit.growth.hourly)} this hour.` : 'No daily limit.',
    why: `Your sender score is ${score}. At ${GOOD_STANDING} or more there is no daily limit.`,
    next: limit.growth ? raise('Each clean hour doubles the hourly amount, for the first day.') : { kind: 'keep', text: `A score of ${GOOD_STANDING} or more and no warnings. Few bounces and complaints keep it that way.` }, pace }
  return { now: perDay(limit.daily), why: `Your sender score is ${score}${report.grade ? ` (grade ${report.grade})` : ''}.`,
    next: limit.next && raise(`${limit.next.unlimited ? `At a score of ${limit.next.atScore} it goes away.` : `At a score of ${limit.next.atScore} it rises to ${number(limit.next.limit)}, and at ${GOOD_STANDING} it goes away.`} Fewer bounces and complaints raise your score.`), pace }
}
/** The story as a list, a quiet label over each line, then the pace. */
export function LimitStoryList({ story }: { story: LimitStory }) {
  return <div className="limit-story">
    <dl>
      <div><dt>Now</dt><dd>{story.now}</dd></div>
      <div><dt>Why</dt><dd>{story.why}</dd></div>
      {story.next && <div><dt>{nextLabel[story.next.kind]}</dt><dd>{story.next.text}</dd></div>}
    </dl>
    {story.pace && <p className="muted">{story.pace}</p>}
  </div>
}

// How sending limits work, for the docs (/docs#sending-limits): the published score → limit table, the warning lines as
// one table (a rate and a count for each step) with what each step does, and the campaign list probe. Detection
// internals stay out. The published numbers (api/src/standing-model.ts) behind each table, so the copy follows the API.
// The score and its grade in one cell.
const scoreBands = [...LIMIT_BANDS].reverse().map((band, i, all) => ({ limit: band.limit, from: band.min, to: i + 1 < all.length ? all[i + 1].min - 1 : Infinity }))
// The grades a score range spans: the one at its closed end, then the others with where they start or stop.
function gradeSpan(from: number, to: number) {
  const spans = GRADE_BANDS.map((band, i) => ({ grade: band.grade, from: band.min, to: i ? GRADE_BANDS[i - 1].min - 1 : Infinity })).filter(band => band.from <= to && band.to >= from)
  if (from === -Infinity) return [spans[0].grade, ...spans.slice(1).map(band => `${band.grade} under ${band.to + 1}`)].join(', ')
  const [first, ...rest] = spans.reverse()
  return [first.grade, ...rest.map(band => `${band.grade} from ${band.from}`)].join(', ')
}
const scoreRange = (from: number, to: number) => from === -Infinity ? `Under ${to + 1}` : to === Infinity ? `${from} and up` : `${from}–${to}`
// null is no daily limit: good standing, paced by the pool (at least PACE.uncappedFloor a minute). `cell` replaces the
// limit's figure: the evaluation is the first recipients once, not a daily limit.
const bands: [score: string, limit: number | null, cell?: string][] = [
  ['Evaluation', EVALUATION.limit, `First ${EVALUATION.recipients}, once`],
  ...scoreBands.map(({ limit, from, to }): (typeof bands)[number] => [`${scoreRange(from, to)} · ${gradeSpan(from, to)}`, limit]),
]
// Each cell is the rate and the count that must both be reached; a dash where the step has no line for it. A line
// with the rate of the one before it gives only its count. `window` adds the period a line counts over.
type Line = { rate: number; count: number; window?: string }
const at = (lines: readonly Line[], window = true) => lines.map((line, i) => `${i && line.rate === lines[i - 1].rate ? '' : `${pct(line.rate)} and `}${line.count}${window ? ` in ${line.window === '7d' ? '7 days' : '24 h'}` : ''}`).join(', or ')
const lines: [what: string, warn: string, restrict: string, pause: string][] = [
  ['Complaints', at(LADDER.complaints.warn), at(LADDER.complaints.restrict), at(LADDER.complaints.pause)],
  ['Hard bounces', at(LADDER.bounces.warn), `Marketing ${at(LADDER.marketingBounces.restrict, false)}; any mail ${at(LADDER.bounces.restrict, false)}`, `Transactional ${at(LADDER.transactionalBounces.pause, false)}`],
  ['Spam-screen rejections', at(LADDER.screen.warn), at(LADDER.screen.restrict, false), at(LADDER.screen.pause, false)],
  ['Other', '–', '–', 'AWS paused sending, or confirmed abuse'],
]
// What each step does, then how it ends.
const ladder: { step: string; mark: string; tone: string; does: string; recovery: string }[] = [
  { step: 'Notice', mark: '·', tone: 'neutral', does: `A dashboard note for complaints (${at(LADDER.complaints.notice)}) or hard bounces (${at(LADDER.bounces.notice)}).`, recovery: 'It clears by itself.' },
  { step: 'Warn', mark: '1', tone: 'warning', does: `The limit is frozen (without one, at the last 24 hours’ accepted mail, at least ${FREEZE_FLOOR.toLocaleString('en-US')}). Owners and admins get an email.`, recovery: 'Clears after 24 hours under 80% of the line.' },
  { step: 'Restrict', mark: '2', tone: 'warning', does: 'Marketing is held; receipts and resets still send.', recovery: 'After 24 hours owners and admins can release it from Overview: 50% for 48 hours, once per 14 days.' },
  { step: 'Pause', mark: '3', tone: 'danger', does: 'Sending stops. Queued mail is canceled after 72 hours.', recovery: 'A pause from transactional bounces alone: owners can resume it at 50% for 48 hours, once per 30 days. Others need a review.' },
]

export function SendingLimitsGuide({ headings: H = 'h3' }: { headings?: 'h2' | 'h3' }) {
  return <div className="limits-guide">
    <section aria-label="Score and daily limit">
      <H>Score and daily limit</H>
      <p>Hosted only: recipients per rolling 24 hours, set by the sender score. Good standing has none.</p>
      <div className="limits-table-scroll"><table className="limits-table">
        <thead><tr><th scope="col">Score</th><th scope="col">Daily limit</th><th scope="col">Per minute</th></tr></thead>
        <tbody>{bands.map(([score, cap, cell]) => <tr key={score}><td>{score}</td><td>{cell ?? (cap === null ? 'None' : number(cap))}</td><td>{cap === null ? `${number(PACE.uncappedFloor)}+` : number(burstFor(cap))}</td></tr>)}</tbody>
      </table></div>
      <ul className="limits-notes">
        <li>The first {EVALUATION.recipients} wait for their results, about an hour. Then sending grows from {number(GROWTH.start)} an hour for {GROWTH.hours} hours.</li>
        <li>After the evaluation, a limit keeps 100 or 10% for receipts. A band drops {SCORE.hysteresis} points under its floor.</li>
      </ul>
    </section>
    <section aria-label="Warnings and holds">
      <H>Warnings and holds</H>
      <p>Checked every 10 minutes. A line needs its rate and its count; any one line is enough. Lines use 24 hours unless marked 7 days.</p>
      <div className="limits-table-scroll"><table className="limits-table limits-table--lines">
        <thead><tr><th scope="col"><span className="sr-only">Signal</span></th><th scope="col">Warn</th><th scope="col">Restrict</th><th scope="col">Pause</th></tr></thead>
        <tbody>{lines.map(([what, ...steps]) => <tr key={what}><th scope="row">{what}</th>{steps.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table></div>
      <ol className="limits-ladder">{ladder.map(step => <li key={step.step} className={`ui-tone--${step.tone}`}>
        <div className="limits-ladder__head"><span className="limits-ladder__mark" aria-hidden="true">{step.mark}</span><strong>{step.step}</strong></div>
        <p>{step.does}</p><p className="muted">{step.recovery}</p>
      </li>)}</ol>
    </section>
    <section aria-label="Campaign list probe">
      <H>Campaign list probe</H>
      <ul className="limits-notes limits-notes--plain">
        <li>Campaigns to over 100 recipients go to 10% first (100 to 500). In good standing, lists you mailed cleanly skip it.</li>
        <li>Over 3% hard bounces or 2 complaints pause it and suppress the bounces.</li>
        <li>Clean the list and resume; a second quarantine needs a review.</li>
      </ul>
    </section>
  </div>
}
