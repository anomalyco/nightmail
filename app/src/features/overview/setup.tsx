import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Info } from 'lucide-react'
import { useApiDef, useRequestScope, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import type { BuiltinDomain, Identity, SenderScore, SendingLimit } from '../../data/types'
import { date, number } from '../../lib/format'
import { Dialog, SkeletonText } from '../../components/ui'
import { limitNotes } from '../score'
import { LimitStoryList, limitStory } from '../score/limits'
import './setup.css'
import { GROWTH } from '../../../../api/src/standing-model'
import { setupGap, type SetupGap } from '../settings/domain-setup-alert'
import { sendsFromBuiltin } from '../settings/builtin-domain'
import type { Domain } from '../../data/types'

// The hosted limit as GET /v1/me reports it, refreshed with the overview so usage stays current.
export function useSendingLimit() { return useSendingLimitRead().limit }
// The built-in domain, from the same read, while the workspace sends from it: its daily cap is then the one that applies.
export function useBuiltinSending() { return useSendingLimitRead().builtin }
// Whether the limit is still being read, so Overview's detail column can wait for it instead of growing a row.
export function useSendingLimitPending() { return useSendingLimitRead().pending }
function useSendingLimitRead() {
  const scope = useRequestScope()
  const identity = useSession()?.identity
  const hosted = identity?.multiTenant === true && identity.connection?.kind === 'shared'
  // Seeded with the session's own /v1/me, so opening Overview doesn't ask again; it refreshes each minute.
  // An identity without the limit (the connection cache keeps only a summary) is not a seed: the limit is read.
  const live = useQuery({ queryKey: ['nightmail', 'sending-limit', identity?.workspaceId], enabled: hosted, refetchInterval: query => query.state.status === 'error' ? false : 60_000, refetchIntervalInBackground: false,
    initialData: identity?.connection?.sendingLimit !== undefined ? identity ?? undefined : undefined, staleTime: 60_000, queryFn: ({ signal }) => request<Identity>('/v1/me', { signal, scope }) })
  const connection = hosted ? (live.data ?? identity)?.connection : null, builtin = connection?.builtinDomain
  return { limit: connection?.sendingLimit ?? null, pending: hosted && live.isPending, builtin: sendsFromBuiltin(builtin) ? builtin : null }
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
// would say the same fact twice. The row opens what the limit is now, why and what raises it (score/limits.tsx); every
// rule is in the docs it links to.
export function DailyLimit({ report }: { report: SenderScore | undefined }) {
  const limit = useSendingLimit(), builtin = useBuiltinSending()
  const domains = useSession()?.identity?.connection?.domains, ownPending = !!domains && domains.total > 0 && domains.verified === 0
  const [explaining, setExplaining] = useState(false)
  const notes = limitNotes(report)
  const story = limitStory(report, builtin)
  const guide = <Dialog open={explaining} onOpenChange={setExplaining} title="Daily limit" className="limits-dialog">
    {story ? <LimitStoryList story={story} /> : <SkeletonText width="80%" />}
    <Link className="limits-dialog__docs" to="/docs#sending-limits">All the limits, in the docs</Link>
  </Dialog>
  // Sending from the built-in domain: its own cap, which is lower than any other until a domain of the workspace's own verifies.
  if (builtin) {
    const used = builtin.used ?? 0, left = Math.max(0, builtin.perDay - used), text = `${number(left)} of ${number(builtin.perDay)} left`
    return <section className="daily-limit" aria-label="Daily limit">
      <button type="button" className="limit-row" onClick={() => setExplaining(true)} title={`${number(used)} of ${number(builtin.perDay)} recipients from ${builtin.name} in the last 24 hours.`} aria-label={`Daily limit: ${text}, from your built-in domain. How limits work`}>
        <span className="limit-row__text"><span className="limit-row__label">Daily limit<Info size={12} aria-hidden="true" /></span><span className="muted">{text}</span></span>
        <span className="limit-row__track" data-full={used / Math.max(1, builtin.perDay) >= 0.9 || undefined}><i style={{ width: `${Math.min(1, used / Math.max(1, builtin.perDay)) * 100}%` }} /></span>
      </button>
      <p className="limit-row__why">{builtinWhy(builtin, ownPending)}</p>
      {notes.map(note => <p key={note.text} className="limit-row__note" data-tone={note.tone}>{note.tone && <span aria-hidden="true" />}{note.text}</p>)}
      {guide}
    </section>
  }
  if (!limit) return null
  const cap = limit.cap, share = cap === null ? 0 : Math.min(1, limit.used / Math.max(1, cap)), left = cap === null ? 0 : Math.max(0, cap - limit.used)
  // No daily limit, but a new sender's growth pace: say what it allows this hour.
  const growth = cap === null ? report?.limit?.growth ?? null : null
  if (cap === null && !growth && !notes.length) return null
  // The evaluation is its first recipients, once, not a day; the label stays while the score that says so loads.
  const evaluating = cap !== null && inEvaluation(report)
  const limitText = cap === null ? '' : evaluating ? `Evaluation: ${number(left)} of the first ${number(cap)} left` : `${number(left)} of ${number(cap)} left`
  const why = limitWhy(cap, evaluating, growth, report)
  return <section className="daily-limit" aria-label="Daily limit">
    {(cap !== null || growth) && <button type="button" className="limit-row" onClick={() => setExplaining(true)} title={cap === null ? limitSummary(limit) : `${limitSummary(limit, evaluating)} Includes simulator addresses.`} aria-label={cap === null ? `No daily limit${growth ? `, growing: up to ${number(growth.hourly)} this hour` : ''}. How limits work` : `Daily limit: ${limitText}. How limits work`}>
      <span className="limit-row__text"><span className="limit-row__label">Daily limit<Info size={12} aria-hidden="true" /></span><span className="muted">{growth ? `Growing: up to ${number(growth.hourly)} this hour` : limitText}</span></span>
      {cap !== null && <span className="limit-row__track" data-full={share >= 0.9 || undefined}><i style={{ width: `${share * 100}%` }} /></span>}
    </button>}
    {why && <p className="limit-row__why">{why}</p>}
    {notes.map(note => <p key={note.text} className="limit-row__note" data-tone={note.tone}>{note.tone && <span aria-hidden="true" />}{note.text}</p>)}
    {guide}
  </section>
}

// Why the limit is what it is, in one plain line under it: the built-in domain's cap (and what lifts it), the evaluation,
// the growth pace or the sender score. None for an override or an exemption: the notes or nothing say those.
function builtinWhy(builtin: BuiltinDomain, ownPending: boolean): ReactNode {
  const allows = `The built-in domain allows ${number(builtin.perDay)} a day${builtin.scope === 'members' ? ', to your team only' : ''}`
  if (ownPending) return <>{allows}, until your domain is verified. <Link to="/domains">Open Domains</Link></>
  return <>{allows}. <Link to="/domains?add">Add your domain</Link> {builtin.scope === 'members' ? 'to email anyone.' : 'to lift it.'}</>
}
function limitWhy(cap: number | null, evaluating: boolean, growth: { hourly: number } | null, report: SenderScore | undefined) {
  if (evaluating && cap !== null) return `Your first ${number(cap)} recipients set your sender score; the limit grows with it after that.`
  if (growth) return `After the evaluation, sending grows for ${GROWTH.hours} hours.`
  if (cap !== null && report?.limit?.source === 'score') return 'Your sender score sets it; a better score raises it.'
  return null
}

export type SetupRead = { loading: boolean; error?: unknown; retry?: () => void; stuck?: { domain: Domain; gap: SetupGap } | null; sent?: boolean; agent?: boolean; ownVerified?: Domain; pendingDomain?: Domain; sendFrom?: Domain }

// What Overview's get-started strip and banner read for a hosted owner or admin, from GET /v1/overview/setup: server
// state, never this browser's clicks. `loading` is true until the read settles, so the page can hold its layout until it
// knows; a failed read is `error` (with `retry`). `stuck`: the newest domain whose records public DNS still lacks an hour
// after it was added, for the banner. `ownVerified`: a domain of the workspace's own that sends; `pendingDomain`: one still
// verifying; `sendFrom`: what a test email goes from (the own domain, else the built-in one).
export function useSetupRead(): SetupRead {
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const identity = useSession()?.identity
  const enabled = multiTenant && canAdminister && identity?.connection?.state === 'ready'
  const setup = useApiDef(queries.overviewSetup(), { enabled })
  if (!enabled) return { loading: false }
  if (setup.isPending) return { loading: true }
  if (setup.error) return { loading: false, error: setup.error, retry: () => void setup.refetch() }
  // The built-in domain (no DNS of its own) has no records to wait on or a stuck banner.
  const all = setup.data.domains ?? [], items = all.filter(domain => !domain.builtIn)
  const stuck = items.flatMap(domain => { const gap = setupGap(domain); return gap ? [{ domain, gap }] : [] })[0] ?? null
  // The ten newest domains: an older verified one is in the session's domain summary, which the strip counts too.
  const ownVerified = items.find(domain => domain.status === 'verified')
  const builtin = all.find(domain => domain.builtIn && domain.status === 'verified')
  return { loading: false, stuck, sent: setup.data.emails.any, agent: setup.data.progress?.agent, ownVerified, pendingDomain: items.find(domain => domain.status !== 'verified'),
    sendFrom: ownVerified ?? builtin }
}
