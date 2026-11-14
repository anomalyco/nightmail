import { type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Domain, SenderScore } from '../../data/types'
import { number, shortDateTime } from '../../lib/format'
import { openScoreAbout } from '../../lib/score-about'
import { standingTitle, standingTone, stepAtLeast, type RaisedStep } from '../../lib/standing'
import { useTween } from '../../components/motion'
import { Dial } from './gauge'
import { ScoreAbout } from './about'
import { productName } from '../../../../api/src/brand'
export { factorFormats } from './about'
import './score.css'
export { StandingCard } from './standing'

// The sender score, from GET /v1/sender-score: one 56px card on every page (the sidebar's; Overview shows it too where
// the sidebar isn't on screen), which keeps one height in every state, so nothing shifts when it loads. It opens the
// explainer (./about.tsx): the breakdown, the trend, the limit the score sets and how it is graded.
export function useSenderScore() { return useApiDef(queries.senderScore(), { interval: 60_000 }) }
const whole = (value: number) => Math.round(value)
// Before the first grade there is no score to show: a dash and "not graded", never a 0 that reads as a bad grade.
const progressLabel = (report: SenderScore) => `${number(report.emails.firstEmails)} of ${number(report.needed)} real emails`

export function SidebarScore() {
  const { data: report, isError } = useSenderScore()
  const shown = useTween(!report ? undefined : report.state === 'graded' ? report.score ?? 0 : 0)
  // A failed read keeps the card's frame and says so, instead of an empty box.
  if (!report && isError) return <button type="button" onClick={() => openScoreAbout()} className="gauge-card gauge-card--compact" aria-label="Sender score unavailable. About the sender score"><Texture /><span className="gauge-stack"><span className="gauge-eyebrow">Sender score</span><span className="gauge-readout"><b>—</b><small>&nbsp;unavailable</small></span></span></button>
  if (!report) return <div className="gauge-card gauge-card--compact" aria-hidden="true"><span className="gauge-skeleton" /></div>
  const graded = report.state === 'graded'
  // A dot from Warn up, and the card then goes to Overview's standing card; otherwise it opens the explainer.
  const raised = stepAtLeast(report.standing?.step, 'warn') ? report.standing!.step as RaisedStep : null
  const label = (graded ? `Sender score ${whole(report.score!)}, grade ${report.grade}` : `Sender score not graded yet: ${progressLabel(report)}`) + (raised ? `. ${standingTitle[raised]}` : '. About the sender score')
  const inner = <>
    <Texture />
    {raised && <span className={`gauge-alert ui-tone--${standingTone(raised)}`} aria-hidden="true" />}
    <Dial report={report} />
    <span className="gauge-stack">
      <span className="gauge-eyebrow">Sender score</span>
      <span className="gauge-readout">{graded ? <><b>{whole(shown)}</b><span className="gauge-grade">{report.grade}</span></> : <><b>—</b><small className="gauge-readout__pending">not graded</small></>}</span>
    </span>
  </>
  return raised ? <Link to="/#standing" className="gauge-card gauge-card--compact" aria-label={label}>{inner}</Link>
    : <button type="button" onClick={() => openScoreAbout()} className="gauge-card gauge-card--compact" aria-label={label} title={graded ? undefined : `Not graded yet: ${progressLabel(report)}`}>{inner}</button>
}
/** The explainer, mounted once by the shell: the same cached score as every other view of it. */
export function ScoreAboutHost() {
  const score = useSenderScore()
  return <ScoreAbout report={score.data} error={score.error} onRetry={() => void score.refetch()} />
}
// Faint film grain and a tick ruler: texture, never content.
function Texture({ ruler = true }: { ruler?: boolean }) { return <><span className="gauge-grain" aria-hidden="true" />{ruler && <span className="gauge-ruler" aria-hidden="true" />}</> }

// Overview's notes under the daily limit, each only while it applies: an adjustment of the limit itself, and a
// standing below Warn worth knowing (a notice, a marketing release). From Warn up the standing card says it.
export function limitNotes(report: SenderScore | undefined): { text: string; tone?: 'warning' }[] {
  const limit = report?.limit, standing = report?.standing
  const notes: { text: string; tone?: 'warning' }[] = []
  if (limit?.override) notes.push({ text: limit.override.expiresAt ? `Override until ${shortDateTime(limit.override.expiresAt)} UTC` : 'Override with no expiry' })
  if (limit?.restore) notes.push({ text: `${number(limit.restore.daily)} a day after a resume, until ${shortDateTime(limit.restore.until)} UTC` })
  if (limit?.strikeCapUntil) notes.push({ text: `Capped at 50% until ${shortDateTime(limit.strikeCapUntil)} UTC` })
  if (standing && !stepAtLeast(standing.step, 'warn')) {
    if (standing.step === 'notice') notes.push({ text: standing.reasons[0]?.message ?? `${productName} noticed a first problem.`, tone: 'warning' })
    if (standing.marketingRelease) notes.push({ text: `Marketing at ${standing.marketingRelease.percent}% until ${shortDateTime(standing.marketingRelease.until)} UTC` })
  }
  return notes
}

// The step worth most points, as a place to go: a measured factor's lost points in the re-weighted raw score.
function bestStep(report: SenderScore | undefined, domains: Domain[]) {
  if (report?.state !== 'graded') return null
  const measured = report.factors.filter(f => f.source === 'measured'), weight = measured.reduce((sum, f) => sum + f.weight, 0)
  const worst = [...measured].sort((a, b) => (b.weight - b.points!) - (a.weight - a.points!))[0]
  if (!worst || !weight) return null
  const gain = (worst.weight - worst.points!) / weight * 100
  if (gain < 1) return null
  const weak = domains.find(d => d.status === 'verified' && !(d.dmarc && ['quarantine', 'reject'].includes(d.dmarc.status))) ?? domains[0]
  const target = worst.key === 'auth' && weak ? { text: `Add DMARC to ${weak.name}`, to: `/domains/${weak.id}` }
    : worst.key === 'auth' ? { text: 'Authenticate your domains', to: '/domains' }
    : worst.key === 'content' ? { text: 'Review rejected messages', to: '/logs' }
    : worst.key === 'hygiene' ? { text: 'Clean suppressed addresses from lists', to: '/audience' }
    : { text: `Review ${worst.label.toLowerCase()} in Logs`, to: '/logs' }
  return { key: 'score', ...target, meta: `+${whole(gain)} pts` }
}
export type NextItem = { key: string; text: string; meta?: string; to: string }
// Domains, webhooks and invitations come from Overview's one setup read, shared with the setup steps.
export function useNextSteps(report: SenderScore | undefined): { items: NextItem[]; ready: boolean } {
  const { canAdminister } = useWorkspaceAccess()
  const setup = useApiDef(queries.overviewSetup(), { enabled: canAdminister })
  if (!canAdminister) return { items: [], ready: true }
  const ready = !setup.isPending
  const list = setup.data?.domains ?? [], items: NextItem[] = []
  const step = bestStep(report, list); if (step) items.push(step)
  const candidate = list.find(d => d.status === 'verified')
  if (candidate && !list.some(d => d.receiving === 'verified')) items.push({ key: 'receive', text: `Receive replies on ${candidate.name}`, to: `/domains/${candidate.id}` })
  items.push({ key: 'agent', text: 'Connect an AI agent over MCP', to: '/api-keys?connect=1' })
  if (setup.data?.webhooks?.total === 0) items.push({ key: 'webhook', text: 'Get bounce events by webhook', to: '/settings/webhooks/new' })
  const pending = setup.data?.invitations?.pending ?? 0
  if (pending) items.push({ key: 'invite', text: pending === 1 ? 'Share your pending invitation link' : `Share ${number(pending)} pending invitation links`, to: '/settings#members' })
  return { items: items.slice(0, 3), ready }
}
export function NextSteps({ items }: { items: NextItem[] }) {
  if (!items.length) return null
  return <nav className="next-steps" aria-label="Next"><h2 className="next-steps__title">Next</h2><ul>{items.map((item, i) => <li key={item.key} style={{ '--i': i } as CSSProperties}><Link to={item.to}><span>{item.text}</span>{item.meta && <span className="muted">{item.meta}</span>}<ArrowUpRight size={14} aria-hidden="true" /></Link></li>)}</ul></nav>
}
