import { useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowUpRight, Check, Info } from 'lucide-react'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import type { Identity, SenderScore, SendingLimit } from '../../data/types'
import { date, number } from '../../lib/format'
import { SelfTest, TestSend, useTestSender } from '../docs/first-send'
import { Dialog } from '../../components/ui'
import { limitNotes } from '../score'
import { SendingLimitsGuide } from '../score/limits'
import './setup.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { resourceOf } from '../../data/invalidation'
import { setupGap, type SetupGap } from '../settings/domain-setup-alert'
import type { Domain } from '../../data/types'

// The hosted limit as GET /v1/me reports it, refreshed with the overview so usage stays current.
export function useSendingLimit() { return useSendingLimitRead().limit }
// Whether the limit is still being read, so Overview's detail column can wait for it instead of growing a row.
export function useSendingLimitPending() { return useSendingLimitRead().pending }
function useSendingLimitRead() {
  const identity = useSession()?.identity
  const hosted = identity?.multiTenant === true && identity.connection?.kind === 'shared'
  // Seeded with the session's own /v1/me, so opening Overview doesn't ask again; it refreshes each minute.
  // An identity without the limit (the connection cache keeps only a summary) is not a seed: the limit is read.
  const live = useQuery({ queryKey: ['nightmail', 'sending-limit', identity?.workspaceId], enabled: hosted, refetchInterval: query => query.state.status === 'error' ? false : 60_000, refetchIntervalInBackground: false,
    initialData: identity?.connection?.sendingLimit !== undefined ? identity ?? undefined : undefined, staleTime: 60_000, queryFn: ({ signal }) => request<Identity>('/v1/me', { signal }) })
  return { limit: hosted ? (live.data ?? identity)?.connection?.sendingLimit ?? null : null, pending: hosted && live.isPending }
}

// The limit is the evaluation, once rather than a day: no score yet and no override, or no standing stored before the first send.
export const inEvaluation = (report: SenderScore | undefined) => report?.state === 'warmup' && (report.limit?.source ?? 'calibrating') === 'calibrating'

export function limitSummary(limit: SendingLimit, evaluating = false) {
  if (limit.cap === null) return 'No daily limit: only the per-minute pace applies.'
  if (evaluating) return `Evaluation: ${number(limit.used)} of the first ${number(limit.cap)} recipients sent, once. Their results take about an hour.`
  return `${number(limit.used)} of ${number(limit.cap)} recipients in the last 24 hours.${limit.nextCap && limit.nextCapAt ? ` Rises to ${number(limit.nextCap)} on ${date(limit.nextCapAt, { month: 'short', day: 'numeric' })}.` : ''}`
}

// Hosted: the daily limit as one line, what's left of it and a meter (or nothing, in good standing), then a note only
// while one applies (an adjustment, a notice). What's left, not what's used: the used count is close to the Emails figure beside it and
// would say the same fact twice. The row opens how sending limits work; the next band and the per-minute rate are in
// the sender score's explainer.
export function DailyLimit({ report }: { report: SenderScore | undefined }) {
  const limit = useSendingLimit()
  const [explaining, setExplaining] = useState(false)
  if (!limit) return null
  const cap = limit.cap, share = cap === null ? 0 : Math.min(1, limit.used / Math.max(1, cap)), left = cap === null ? 0 : Math.max(0, cap - limit.used)
  // No daily limit, but a new sender's growth pace: say what it allows this hour.
  const growth = cap === null ? report?.limit?.growth ?? null : null
  const notes = limitNotes(report)
  if (cap === null && !growth && !notes.length) return null
  // The evaluation is its first recipients, once, not a day; the label stays while the score that says so loads.
  const evaluating = cap !== null && inEvaluation(report)
  const limitText = cap === null ? '' : evaluating ? `Evaluation: ${number(left)} of the first ${number(cap)} left` : `${number(left)} of ${number(cap)} left`
  return <section className="daily-limit" aria-label="Daily limit">
    {(cap !== null || growth) && <button type="button" className="limit-row" onClick={() => setExplaining(true)} title={cap === null ? limitSummary(limit) : `${limitSummary(limit, evaluating)} Includes simulator addresses.`} aria-label={cap === null ? `No daily limit${growth ? `, growing: up to ${number(growth.hourly)} this hour` : ''}. How limits work` : `Daily limit: ${limitText}. How limits work`}>
      <span className="limit-row__text"><span className="limit-row__label">Daily limit<Info size={12} aria-hidden="true" /></span><span className="muted">{growth ? `Growing: up to ${number(growth.hourly)} this hour` : limitText}</span></span>
      {cap !== null && <span className="limit-row__track" data-full={share >= 0.9 || undefined}><i style={{ width: `${share * 100}%` }} /></span>}
    </button>}
    {notes.map(note => <p key={note.text} className="limit-row__note" data-tone={note.tone}>{note.tone && <span aria-hidden="true" />}{note.text}</p>)}
    <Dialog open={explaining} onOpenChange={setExplaining} title="How limits work" className="limits-dialog">
      <SendingLimitsGuide limit={report?.limit} compact />
      <Link className="limits-dialog__docs" to="/docs#sending-limits">Open in the docs</Link>
    </Dialog>
  </section>
}

// A step is its title and, while open, its action; `note` is only the test email's confirmation.
export type SetupStep = { key: string; done: boolean; title: string; action?: ReactNode; note?: ReactNode }

// Hosted admins until the first email is sent: each step read from server state, not from this browser. Receiving is
// not a step: once these are done, the next steps offer it (score/index.tsx).
// `loading` is true until the setup read (shared with the next steps) settles, so the page can hold its layout until it knows.
// A failed read is `error` (with `retry`): the steps' place says so, rather than looking like finished setup.
// `stuck`: the newest domain whose records public DNS still lacks an hour after it was added, for the banner above the steps
// (shown also once the steps are done, while another domain waits).
export function useSetupSteps(): { loading: boolean; steps: SetupStep[] | null; current?: SetupStep; open?: SetupStep[]; error?: unknown; retry?: () => void; stuck?: { domain: Domain; gap: SetupGap } | null; hasDomain?: boolean } {
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const identity = useSession()?.identity
  const client = useQueryClient()
  const enabled = multiTenant && canAdminister && identity?.connection?.state === 'ready'
  const setup = useApiDef(queries.overviewSetup(), { enabled })
  const testSender = useTestSender()
  // A test sent from the steps keeps them up, with its result, until the next visit.
  const [testId, setTestId] = useState<string | null>(null)
  // The new email shows in Latest emails, the facts and the next steps without a reload.
  const sentTest = (id: string) => {
    setTestId(id)
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) }).catch(() => {})
  }
  if (!enabled) return { loading: false, steps: null }
  if (setup.isPending) return { loading: true, steps: null }
  if (setup.error) return { loading: false, steps: null, error: setup.error, retry: () => void setup.refetch() }
  if (!setup.data.domains || !setup.data.apiKeys) return { loading: false, steps: null }
  const items = setup.data.domains, keyed = setup.data.apiKeys.active > 0
  const hasDomain = items.length > 0
  const stuck = items.flatMap(domain => { const gap = setupGap(domain); return gap ? [{ domain, gap }] : [] })[0] ?? null
  const verified = items.find(domain => domain.status === 'verified')
  // The setup read carries the ten newest domains; an older verified one still counts (the session's domain summary).
  const domainDone = !!verified || (identity?.connection?.domains?.verified ?? 0) > 0
  const pending = items.find(domain => domain.status !== 'verified')
  const sent = setup.data.emails.any || !!testId
  if (domainDone && keyed && sent && !testId) return { loading: false, steps: null, stuck, hasDomain }
  const steps: SetupStep[] = [
    // Until a domain verifies, Hosted mail can send a test to the user's own address from the shared test sender; the
    // first email's step then confirms it, as it does a test from the domain.
    { key: 'domain', done: domainDone, title: 'Verify a domain',
      action: !domainDone && <div className="setup-rail__choice"><Link className="ui-button ui-button--primary ui-button--md" to={pending ? `/domains/${pending.id}` : '/domains'}>{pending ? 'View records' : 'Add domain'}</Link>
        {testSender && identity?.connection?.kind === 'shared' && !sent && <SelfTest onSent={sentTest} />}</div> },
    { key: 'key', done: keyed, title: 'Create an API key',
      action: !keyed && <Link className={`ui-button ui-button--${domainDone ? 'primary' : 'secondary'} ui-button--md`} to={verified ? `/api-keys?create=send&domain=${encodeURIComponent(verified.name)}` : '/api-keys?create=send'}>Create key</Link> },
    // The test send names its from and to addresses itself; with no verified domain in this read to test from, the code examples.
    { key: 'send', done: sent, title: 'Send your first email',
      note: testId ? <>Test email queued to {identity?.email && <PrivateAddress value={identity.email} />}. <Link to={`/logs/${encodeURIComponent(testId)}`}>View in Logs</Link></> : undefined,
      action: !sent && (verified ? <TestSend domain={verified} onSent={sentTest} primary={keyed} /> : <Link className="ui-button ui-button--secondary ui-button--md" to="/docs#quickstart">Code examples</Link>) },
  ]
  // Sending a test needs only a verified domain (it uses this session, not a key), so its step opens beside the key step.
  const current = steps.find(step => !step.done)
  // The first email's step stays open once sent, so its confirmation and the link to Logs are seen.
  const open = steps.filter(step => step === current || (step.key === 'send' && (!!testId || (!step.done && domainDone))))
  return { loading: false, steps, current, open, stuck, hasDomain }
}

// Numbered steps in Overview's detail column; only the current step is open, with its action. A finished step's number
// turns into a check, so the marks are the progress. Docs, for the code examples, sits on the title row.
export function SetupRail({ steps, current, open: opened = current ? [current] : [] }: { steps: SetupStep[]; current?: SetupStep; open?: SetupStep[] }) {
  return <section className="setup-rail" aria-label="Get started">
    <div className="setup-rail__head"><h2>Get started</h2><Link className="ui-button ui-button--ghost ui-button--sm" to="/docs#quickstart">Docs <ArrowUpRight size={16} /></Link></div>
    <ol>{steps.map((step, index) => {
      const open = opened.includes(step)
      return <li key={step.key} data-done={step.done || undefined} data-open={open || undefined} style={{ '--i': index } as CSSProperties}>
        <span className="setup-rail__mark" aria-hidden="true"><span>{index + 1}</span><Check size={12} strokeWidth={2.75} /></span>
        <div className="setup-rail__body"><span>{step.title}{step.done && <span className="sr-only"> (done)</span>}</span>
          {open && <>{step.note && <span className="muted">{step.note}</span>}{step.action && <div className="setup-rail__action">{step.action}</div>}</>}
        </div>
      </li>
    })}</ol>
  </section>
}
