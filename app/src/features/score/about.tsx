import { useEffect, useRef, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, ErrorState, SkeletonText } from '../../components/ui'
import type { SenderScore, SenderScoreFactor } from '../../data/types'
import { closeScoreAbout, useScoreAbout } from '../../lib/score-about'
import { number } from '../../lib/format'
import { gradeKey } from './gauge'

const percent = (digits: number) => (value: number) => `${(value * 100).toFixed(digits)}%`
// Engagement is the marketing unsubscribe rate.
export const factorFormats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), content: percent(1), bounces: percent(1), hygiene: percent(1), auth: value => `${Math.round(value * 100)}%`, engagement: percent(2) }
const grades = 'A+ from 95, A from 90, B from 80, C from 70, D from 60, F below 60.'

// What the sender score is and where each part stands: one dialog for the whole app, opened from the score card
// (lib/score-about.ts). The status, the 14-day trend and (Hosted) the limit the score sets come first, then the six
// parts with the one that would help most, then how it is graded.
export function ScoreAbout({ report, error, onRetry }: { report: SenderScore | undefined; error: unknown; onRetry: () => void }) {
  const { open, focus } = useScoreAbout()
  const list = useRef<HTMLUListElement>(null)
  // Opened for one part: that part is in view and marked.
  useEffect(() => { if (open && focus) requestAnimationFrame(() => list.current?.querySelector(`[data-key="${focus}"]`)?.scrollIntoView({ block: 'nearest' })) }, [open, focus])
  const graded = report?.state === 'graded'
  const days = graded ? report.history.slice(-14) : [], offset = 14 - days.length
  const low = days.length ? Math.min(...days.map(day => day.score)) - 4 : 0, high = days.length ? Math.max(...days.map(day => day.score)) : 1
  const moved = graded && report.history.length ? Math.round(report.score! - report.history[0].score) : 0
  const weakest = graded ? report.factors.filter(f => f.source === 'measured' && f.score !== null && f.score < 100).sort((a, b) => a.score! - b.score!)[0]?.key : undefined
  const limit = report?.limit
  const limitLine = !limit ? null : [limit.daily === null ? 'No daily limit' : `Daily limit ${number(limit.daily)}${limit.source === 'override' ? ' (override)' : ''}`,
    graded && limit.next ? `next ${number(limit.next.limit)} at ${limit.next.atScore}` : null, `${number(limit.perMinute)} a minute`, `${number(limit.transactionalReserve)} kept for receipts`].filter(Boolean).join(' · ')
  return <Dialog open={open} onOpenChange={next => { if (!next) closeScoreAbout() }} className="score-about" title="Sender score"
    description="Your sending’s health, 0–100: higher reaches more inboxes and raises your Hosted daily limit."
    footer={<><Link className="ui-button ui-button--ghost ui-button--md" to="/docs/api/getSenderScore" onClick={closeScoreAbout}>API reference</Link><Button variant="primary" onClick={closeScoreAbout}>Done</Button></>}>
    {!report ? error ? <ErrorState error={error} onRetry={onRetry} /> : <div className="score-about__status"><SkeletonText width="60%" /></div> : <>
      <div className="score-about__status" data-grade={graded && report.grade ? gradeKey(report.grade) : undefined}>
        <b>{graded ? Math.round(report.score!) : '—'}</b>
        <div className="score-about__status-text">
          <span>{graded ? <>Grade <strong className="score-about__grade">{report.grade}</strong> · {report.next ? `${Math.ceil(report.next.at - report.score!)} points to ${report.next.grade}` : 'Top grade'}</> : 'Not graded yet'}</span>
          <span className="muted">{graded ? `From ${number(report.emails.last30Days)} real emails in 30 days${report.history.length ? ` · ${moved > 0 ? '+' : moved < 0 ? '−' : '±'}${Math.abs(moved)} in 14 days` : ''}` : `${number(report.emails.firstEmails)} of ${number(report.needed)} real emails. Your first grade comes after ${number(report.needed)}${report.limit ? ', plus a day' : ''}.`}</span>
        </div>
        {graded && <div className="score-about__history" role="img" aria-label={days.length ? `Daily score over ${days.length} days, from ${Math.round(days[0].score)} to ${Math.round(report.score!)}.` : 'No history yet.'}>
          {Array.from({ length: 14 }, (_, i) => { const day = days[i - offset]; return <span key={i} data-last={i === 13 || undefined} style={{ transform: `scaleY(${day ? Math.max(.1, (day.score - low) / Math.max(1, high - low)) : .1})` }} /> })}
        </div>}
        {!graded && <span className="score-about__progress" role="meter" aria-label="Real emails before the first grade" aria-valuemin={0} aria-valuemax={report.needed} aria-valuenow={report.emails.firstEmails} style={{ '--share': `${Math.min(100, report.emails.firstEmails / Math.max(1, report.needed) * 100)}%` } as CSSProperties}><i /></span>}
        {limitLine && <span className="score-about__limit muted">{limitLine}</span>}
      </div>
      <ul ref={list} className="score-about__factors" aria-label="The six parts">{report.factors.map(factor => <li key={factor.key} data-key={factor.key} data-focus={focus === factor.key || undefined}>
        <div className="score-about__factor-name"><span>{factor.label}</span><span className="muted">{factor.weight}%</span>{factor.key === weakest && <span className="score-about__helps">Helps most</span>}</div>
        <span className="score-about__factor-now">{graded && factor.source === 'measured' ? <>{factorFormats[factor.key](factor.value!)}<span className="muted"> · {Math.round(factor.score!)}/100</span></> : <span className="muted">{graded ? 'No data, left out' : '—'}</span>}</span>
        <p className="muted">{factor.basis}</p>
      </li>)}</ul>
      <section className="score-about__section" aria-labelledby="score-about-graded">
        <h3 id="score-about-graded">How it’s graded</h3>
        <ul>
          <li>Each part scores 0–100. Parts with no data are left out and the rest count more.</li>
          <li>Recent days count most (30-day half-life). With little mail it stays near 60.</li>
          <li>Starts at 65, or lower if your mail scores lower. Moves at most 5 points up or 10 down a day.</li>
          <li>Counts every email you send except simulated sends. Mail only to <code>…@simulator.amazonses.com</code> uses your daily limit but not the score.</li>
          <li>{grades}</li>
        </ul>
      </section>
    </>}
  </Dialog>
}
