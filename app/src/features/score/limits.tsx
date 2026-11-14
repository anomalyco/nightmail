import { number } from '../../lib/format'
import './limits.css'

// How sending limits work: the published score → limit table, the warning lines as one table (a rate and a count for
// each step) with what each step does, and the campaign list probe. The public docs (/docs#sending-limits) and
// Overview's explainer render this one copy. Detection internals stay out.
const perMinute = (limit: number) => Math.min(500, Math.max(50, Math.floor(limit / 20)))
const bands: [score: string, grade: string, limit: number | string][] = [
  ['Calibrating, first 100 sent', '–', 100], ['Under 65', 'D, F under 60', 100], ['65–69', 'D', 200], ['70–74', 'C', 500], ['75–79', 'C', 1_000],
  ['80–84', 'B', 2_000], ['85–89', 'B', 5_000], ['90 and up', 'A, A+ from 95', 10_000], ['On request', '–', '25,000 · 50,000 · 100,000'],
]
// Each cell is the rate and the count that must both be reached; a dash where the step has no line for it.
const lines: [what: string, warn: string, restrict: string, pause: string][] = [
  ['Complaints', '0.05% and 2 in 24 h, or 3 in 7 days', '0.1% and 3 in 24 h', '0.3% and 5 in 24 h, or 0.15% and 10 in 7 days'],
  ['Hard bounces', '2% and 10 in 24 h, or 1.5% and 10 in 7 days', 'Marketing 4% and 25; any mail 8% and 50', 'Transactional 5% and 50'],
  ['Spam-screen rejections', '2% and 3 in 24 h', '5% and 10', '10% and 25'],
  ['Other', '–', '–', 'AWS paused sending, or confirmed abuse'],
]
// What each step does, then how it ends.
const ladder: { step: string; mark: string; tone: string; does: string; recovery: string }[] = [
  { step: 'Notice', mark: '·', tone: 'neutral', does: 'A first complaint or a few bounces adds a dashboard note.', recovery: 'It clears by itself.' },
  { step: 'Warn', mark: '1', tone: 'warning', does: 'The limit stops rising and owners and admins get an email; mail still sends.', recovery: 'Clears after 24 hours under 80% of the line.' },
  { step: 'Restrict', mark: '2', tone: 'warning', does: 'Marketing is held, not receipts or resets.', recovery: 'Owners and admins can release it from Overview after 24 hours, once per 14 days: 50% for 48 hours.' },
  { step: 'Pause', mark: '3', tone: 'danger', does: 'Sending stops; receiving, inboxes and the dashboard work. Queued mail is canceled after 72 hours.', recovery: 'Owners can resume a pause from transactional bounces alone once per 30 days, at 50% for 48 hours; others need a review.' },
]

export function SendingLimitsGuide({ headings = 'h3' }: { headings?: 'h2' | 'h3' }) {
  const H = headings
  return <div className="limits-guide">
    <section aria-label="Score and daily limit">
      <H>Score and daily limit</H>
      <p>Hosted only: recipients per rolling 24 hours, set by the sender score.</p>
      <div className="limits-table-scroll"><table className="limits-table">
        <thead><tr><th scope="col">Score</th><th scope="col">Grade</th><th scope="col">Daily limit</th><th scope="col">Per minute</th></tr></thead>
        <tbody>{bands.map(([score, grade, limit]) => <tr key={score}><td>{score}</td><td>{grade}</td><td>{typeof limit === 'number' ? number(limit) : limit.split(' · ').map((part, i, all) => <span key={part} className="limits-table__part">{part}{i < all.length - 1 && ' ·'} </span>)}</td><td>{typeof limit === 'number' ? number(perMinute(limit)) : number(500)}</td></tr>)}</tbody>
      </table></div>
      <ul className="limits-notes">
        <li>Per minute: the limit ÷ 20, from 50 to 500.</li>
        <li>Marketing can use all but 100 or 10% (whichever is more), kept for receipts and resets.</li>
        <li>The score moves at most 5 up or 10 down a day. A band drops only 2 points under its floor.</li>
      </ul>
    </section>
    <section aria-label="Warnings and holds">
      <H>Warnings and holds</H>
      <p>Checked every 10 minutes. A line needs its rate and its count; any one line is enough.</p>
      <div className="limits-table-scroll"><table className="limits-table limits-table--lines">
        <thead><tr><th scope="col"><span className="sr-only">Signal</span></th><th scope="col">Warn</th><th scope="col">Restrict</th><th scope="col">Pause</th></tr></thead>
        <tbody>{lines.map(([what, ...steps]) => <tr key={what}><th scope="row">{what}</th>{steps.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table></div>
      <ol className="limits-ladder">{ladder.map(step => <li key={step.step} className={`ui-tone--${step.tone}`}>
        <div className="limits-ladder__head"><span className="limits-ladder__mark" aria-hidden="true">{step.mark}</span><strong>{step.step}</strong></div>
        <p>{step.does} <span className="muted">{step.recovery}</span></p>
      </li>)}</ol>
    </section>
    <section aria-label="Campaign list probe">
      <H>Campaign list probe</H>
      <ul className="limits-notes limits-notes--plain">
        <li>Campaigns to over 100 recipients go to 10% first (100 to 500).</li>
        <li>Over 3% hard bounces or 2 complaints pause it and suppress the bounces.</li>
        <li>Clean the list and resume; a second quarantine needs a review.</li>
      </ul>
    </section>
  </div>
}
