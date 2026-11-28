import { useEffect, useRef, type CSSProperties } from 'react'
import { Button, Dialog, Disclosure, ErrorState, Meter, MetricRow, SkeletonText, type Tone } from '../../components/ui'
import type { SenderScore, SenderScoreFactor } from '../../data/types'
import { closeScoreAbout, useScoreAbout } from '../../lib/score-about'
import { number } from '../../lib/format'
import { GOOD_STANDING, GRADE_BANDS } from '../../../../api/src/standing-model'
import { useSession } from '../../data/context'
import { sendsFromBuiltin } from '../settings/builtin-domain'
import { limitStory } from './limits'

const percent = (digits: number) => (value: number) => `${Number((value * 100).toFixed(digits))}%`
// Engagement is the marketing unsubscribe rate.
export const factorFormats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), content: percent(1), bounces: percent(1), hygiene: percent(1), auth: value => `${Math.round(value * 100)}%`, engagement: percent(2) }
// A part's score as a state: 90 and up good, under 50 failing, under 75 worth a look.
const partTone = (score: number): Tone => score >= 90 ? 'success' : score < 50 ? 'danger' : score < 75 ? 'warning' : 'neutral'
const grades = `${GRADE_BANDS.map((band, i) => band.min ? `${band.grade} from ${band.min}` : `${band.grade} below ${GRADE_BANDS[i - 1].min}`).join(', ')}.`
// A time in the viewer's own time zone, with the day when it isn't today.
function clock(value: string) {
  const at = new Date(value), today = new Date().toDateString() === at.toDateString()
  return new Intl.DateTimeFormat('en-US', { ...(today ? {} : { month: 'short', day: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}
/**
 * Before the first grade, one plain sentence: it comes after the evaluation's emails (the API's `needed`, never a number
 * of our own), how many are left, and once they are sent, when their delivery results will have set it.
 */
export function untilGraded(report: SenderScore, now = Date.now()) {
  const left = report.needed - report.emails.firstEmails
  if (left > 0) return `Your grade appears after ${number(report.needed)} emails. ${number(left)} to go.`
  if (!report.gradedBy || Date.parse(report.gradedBy) <= now) return 'Your grade appears within minutes, once results are in.'
  return `Your grade appears by ${clock(report.gradedBy)}, once results are in.`
}

/** The score's move over its history (up to 14 days), as "+3 in 14 days"; null before a grade or its first day. */
export function scoreMove(report: SenderScore) {
  if (report.state !== 'graded' || !report.history.length) return null
  const moved = Math.round(report.score! - report.history[0].score)
  return `${moved > 0 ? '+' : moved < 0 ? '−' : '±'}${Math.abs(moved)} in 14 days`
}

// What the sender score is and where each part stands: one dialog for the whole app, opened from the score card
// (lib/score-about.ts). The status, the 14-day trend and (Hosted) the limit the score sets come first, then the six
// parts, one line each: its score as a meter, what was measured and its score out of 100. Then how it is graded, with what each part measures.
export function ScoreAbout({ report, error, onRetry }: { report: SenderScore | undefined; error: unknown; onRetry: () => void }) {
  const { open, focus } = useScoreAbout()
  const list = useRef<HTMLUListElement>(null)
  // Opened for one part: that part is in view and marked.
  useEffect(() => { if (open && focus) requestAnimationFrame(() => list.current?.querySelector(`[data-key="${focus}"]`)?.scrollIntoView({ block: 'nearest' })) }, [open, focus])
  const graded = report?.state === 'graded'
  const days = graded ? report.history.slice(-14) : [], offset = 14 - days.length
  const low = days.length ? Math.min(...days.map(day => day.score)) - 4 : 0, high = days.length ? Math.max(...days.map(day => day.score)) : 1
  const move = report && scoreMove(report)
  // Hosted: the limit now and what raises it, in the daily limit dialog's words (./limits.tsx). Sending from the built-in
  // domain, its cap is the one that applies (it is lower than the evaluation's).
  const builtin = useSession()?.identity?.connection?.builtinDomain
  const story = report?.limit ? limitStory(report, sendsFromBuiltin(builtin) ? builtin : null) : null
  const limitLine = story && [story.now, story.next?.kind === 'raise' ? story.next.text : null].filter(Boolean).join(' ')
  return <Dialog open={open} onOpenChange={next => { if (!next) closeScoreAbout() }} className="score-about" title="Sender score"
    footer={<Button variant="primary" onClick={closeScoreAbout}>Done</Button>}>
    {!report ? error ? <ErrorState error={error} onRetry={onRetry} /> : <div className="score-about__status"><SkeletonText width="60%" /></div> : <>
      <div className="score-about__status">
        <b>{graded ? Math.round(report.score!) : '—'}</b>
        <div className="score-about__status-text">
          <span>{graded ? <>Grade <strong className="score-about__grade">{report.grade}</strong> · {report.next ? `${Math.ceil(report.next.at - report.score!)} points to ${report.next.grade}` : 'Top grade'}</> : 'Not graded yet'}</span>
          <span className="muted">{graded ? `From ${number(report.emails.last30Days)} real emails in 30 days${move ? ` · ${move}` : ''}` : untilGraded(report)}</span>
        </div>
        {graded && <div className="score-about__history" role="img" aria-label={days.length ? `Daily score over ${days.length} days, from ${Math.round(days[0].score)} to ${Math.round(report.score!)}.` : 'No history yet.'}>
          {Array.from({ length: 14 }, (_, i) => { const day = days[i - offset]; return <span key={i} data-last={i === 13 || undefined} style={{ transform: `scaleY(${day ? Math.max(.1, (day.score - low) / Math.max(1, high - low)) : .1})` }} /> })}
        </div>}
        {!graded && <span className="score-about__progress" role="meter" aria-label="Real emails before the first grade" aria-valuemin={0} aria-valuemax={report.needed} aria-valuenow={report.emails.firstEmails} style={{ '--share': `${Math.min(100, report.emails.firstEmails / Math.max(1, report.needed) * 100)}%` } as CSSProperties}><i /></span>}
        {limitLine && <span className="score-about__limit muted">{limitLine}</span>}
      </div>
      <ul ref={list} className="score-about__factors" aria-label="The six parts">{report.factors.map(factor => { const measured = graded && factor.source === 'measured'; return <li key={factor.key} data-key={factor.key} data-focus={focus === factor.key || undefined}>
        <MetricRow label={factor.label}
          spark={measured ? <Meter value={factor.score!} max={100} label={`${factor.label}: ${Math.round(factor.score!)} of 100`} /> : <Meter value={0} />}
          value={measured ? factorFormats[factor.key](factor.value!) : <span className="muted">{graded ? 'No data' : '—'}</span>}
          unit={measured ? <span className={`score-about__part-score ui-tone--${partTone(factor.score!)}`}>{Math.round(factor.score!)}<span className="score-about__out-of">/100</span></span> : undefined} />
      </li> })}</ul>
      <Disclosure className="score-about__section" title="How it’s graded">
        <dl className="score-about__bases">{report.factors.map(factor => <div key={factor.key}><dt>{factor.label}</dt><dd>{factor.basis}</dd></div>)}</dl>
        <ul>
          <li>Parts with no data are left out and the rest count more.</li>
          <li>Recent days count most (30-day half-life). It updates hourly.</li>
          <li>Your first {number(report.needed)} real emails set it once their results are in.{report.limit ? ` ${GOOD_STANDING} and up has no daily limit.` : ''}</li>
          <li>Counts every email you send except simulated sends. Mail only to <code>…@simulator.amazonses.com</code> uses your daily limit but not the score.</li>
          <li>{grades}</li>
        </ul>
      </Disclosure>
    </>}
  </Dialog>
}
