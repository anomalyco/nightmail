import { useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useApiMutation, useWorkspaceAccess } from '../../data/context'
import { campaignResumable, errorText, type Campaign, type CampaignPacingInput } from '../../data/types'
import { Button, Checkbox, Input } from '../../components/ui'
import { approxRelativeTime, date, localTime, number, relativeTime, time } from '../../lib/format'
import { isDuplicateSubmission } from '../../lib/single-flight'
import { estimateFinish } from '../../../../api/src/standing-model'

export const liveInterval = 3000
export const heldInterval = 60_000
export const minPerDay = 100
export const maxPerDay = 10_000_000
export const perDayError = (value: number) => Number.isInteger(value) && value >= minPerDay && value <= maxPerDay ? '' : `Enter a whole number from ${number(minPerDay)} to ${number(maxPerDay)}.`
// Rate share is edited as a whole percent of the SES per-second send rate; the API takes a 0.05–1 fraction.
export const minRatePercent = 5
export const maxRatePercent = 100
export const ratePercentError = (value: number) => Number.isInteger(value) && value >= minRatePercent && value <= maxRatePercent ? '' : `Enter a whole percent from ${minRatePercent} to ${maxRatePercent}.`
const ratePercent = (share?: number) => Math.round((share ?? 1) * 100)
type Progress = Pick<Campaign, 'status' | 'delivery'>
// Recipients are still being validated or released into the queue.
const releasing = (campaign: Progress) => ['preparing', 'sending'].includes(campaign.status) && (campaign.delivery?.expanded ?? 0) < (campaign.delivery?.total ?? 0)
// Paused or waiting for a pacing window / SES quota: nothing new is released for a while.
export const sendingHeld = (campaign: Progress) => campaign.status === 'paused' || (releasing(campaign) && Boolean(campaign.delivery?.waiting))
const waitingLabel = { pacing_window: 'Waiting for the next daily slice', ses_daily_quota: 'Holding for the SES daily quota', hosted_daily_quota: 'Waiting for Hosted sending capacity', list_probe: 'Waiting for test batch feedback', balance: 'Waiting for account credit', feedback_lag: 'Waiting for delivery reports to catch up', ramp: 'Ramping up', link_record: 'Waiting to resume' } as const
const atUtc = (value: string) => `${date(value)} · ${time(value)} UTC`
/** The ramp step a new sender's campaign is on (API sendEstimate.ramp), as the status line says it. */
const rampLine = (ramp: NonNullable<NonNullable<Campaign['sendEstimate']>['ramp']>) => `Ramping up: step ${ramp.step} of ${ramp.steps}, up to ${number(ramp.ceilingPerHour)} an hour.`
/** What people see as the state: a launch still checking messages for a future send is already "scheduled" to them. */
export const campaignDisplayStatus = (campaign: Pick<Campaign, 'status' | 'scheduledAt' | 'archivedAt'>) => campaign.archivedAt ? 'archived' : campaign.status === 'preparing' && campaign.scheduledAt && Date.parse(campaign.scheduledAt) > Date.now() ? 'scheduled' : campaign.status

/** A sent or sending campaign's mail in Logs, all of it or one status's, over the 30 days Logs keeps (never its default range). */
export const campaignLogs = (id: string, status?: string) => `/logs?campaign=${encodeURIComponent(id)}${status ? `&status=${status}` : ''}&range=30d`
/** A metric row: the label, then its figure. With `to`, the row opens that campaign mail in Logs. */
export function SummaryLine({ label, figure, to }: { label: ReactNode; figure: ReactNode; to?: string }) {
  return to ? <Link className="campaign-summary-line campaign-summary-link" to={to}><span>{label}</span><span>{figure}</span></Link>
    : <div className="campaign-summary-line"><span>{label}</span><span>{figure}</span></div>
}

// Poll only while a send can still change; a future schedule waits until it is due.
// While paused or waiting for the next window, poll slowly unless queued mail is still draining.
export function campaignPollInterval(campaign?: Pick<Campaign, 'status' | 'scheduledAt' | 'delivery' | 'counts'> | null): number | false {
  if (!campaign) return false
  if (campaign.status === 'scheduled') {
    const due = Date.parse(campaign.scheduledAt ?? '') - Date.now()
    return due > liveInterval ? Math.min(due, 2_147_483_647) : liveInterval
  }
  if (sendingHeld(campaign)) {
    const byStatus = campaign.counts?.byStatus
    if ((byStatus?.queued ?? 0) + (byStatus?.attempting ?? 0) > 0) return liveInterval
    const until = campaign.status === 'paused' ? NaN : Date.parse(campaign.delivery?.waiting?.until ?? '') - Date.now()
    return until > 0 && until < heldInterval ? Math.max(liveInterval, until + 1000) : heldInterval
  }
  return ['preparing', 'sending'].includes(campaign.status) ? liveInterval : false
}

export function CampaignProgress({ campaign }: { campaign: Campaign }) {
  if (!campaign.counts) return null
  const { total: materialized, byStatus } = campaign.counts
  const total = Math.max(materialized, campaign.delivery?.total ?? 0)
  const canceledBeforeQueue = campaign.delivery?.canceled ?? 0
  const awaitingQueue = Math.max(0, total - materialized - canceledBeforeQueue)
  const queued = byStatus.queued ?? 0
  const processing = byStatus.attempting ?? 0
  const processed = Math.min(total, Math.max(0, materialized - queued - processing + canceledBeforeQueue))
  // Each outcome opens its emails in Logs. Canceled doesn't: recipients canceled before they were queued have no email.
  const outcomes = [
    ['Delivered', byStatus.delivered, 'delivered'], ['Bounced', byStatus.bounced, 'bounced'],
    ['Complaints', byStatus.complained, 'complained'], ['Rejected', byStatus.rejected, 'rejected'],
    ['Rendering failed', byStatus.rendering_failed, 'rendering_failed'], ['Suppressed', byStatus.suppressed, 'suppressed'],
    ['Canceled', (byStatus.canceled ?? 0) + canceledBeforeQueue, undefined], ['Acceptance unknown', byStatus.acceptance_unknown, 'acceptance_unknown'],
    ['Simulated', byStatus.simulated, 'simulated'],
  ] as const
  const preparing = campaign.status === 'preparing'
  const prepared = campaign.delivery?.prepared ?? 0
  const expanded = campaign.delivery?.expanded ?? 0
  const activeStatus = ['preparing', 'sending', 'paused'].includes(campaign.status)
  const wait = releasing(campaign) ? campaign.delivery?.waiting : null
  const lag = campaign.delivery?.feedbackLag ?? null
  const ramp = campaign.sendEstimate?.ramp ?? null
  // The API estimates as of the campaign's last change; one already past says nothing more.
  const finishAt = activeStatus && Date.parse(campaign.sendEstimate?.finishAt ?? '') > Date.now() ? campaign.sendEstimate!.finishAt : null
  const statusTitle = wait ? atUtc(wait.until) : undefined
  const statusText = wait
    ? wait.reason === 'feedback_lag'
      ? 'Waiting for delivery reports to catch up.'
      // No host for its unsubscribe link right now (the workspace's sending is paused): it continues by itself.
      : wait.linkHold === 'daily_budget' ? 'The shared link domain reached its daily limit, so the remaining recipients will get this campaign on later days.'
      : wait.linkHold === 'blocklist' ? 'Sending will continue once an operator clears this link domain for marketing.'
      : wait.reason === 'link_record'
        ? 'It continues by itself once this workspace’s sending resumes.'
      : wait.reason === 'list_probe'
        ? `Test batch${expanded > 0 ? ` of ${number(expanded)}` : ''} sent. Rest release at ${localTime(wait.until)} if bounces stay low.`
        : wait.reason === 'ramp' && ramp
          ? `${rampLine(ramp)} More goes out ${approxRelativeTime(wait.until)}.`
          : `${waitingLabel[wait.reason] ?? 'Waiting to release more recipients'} · ${approxRelativeTime(wait.until)}`
    : lag
      ? `Delivery stats are about ${Math.max(1, Math.round(lag.oldestMs / 60_000))} min behind.`
      : ramp && releasing(campaign) ? rampLine(ramp) : ''
  return <div className="campaign-audience-summary">
    {preparing ? <>
      <div className="campaign-summary-line"><strong>Preparing</strong><span>{total > 0 ? `Checking ${number(total)} ${total === 1 ? 'recipient' : 'recipients'} · ${number(prepared)} done` : 'Preparing recipient list…'}</span></div>
      <progress className="campaign-progress-bar" aria-label="Campaign preparation progress" aria-valuetext={total > 0 ? `${number(prepared)} of ${number(total)} recipients checked` : 'Preparing recipient list'} value={total > 0 ? prepared : 0} max={total > 0 ? total : 1} />
    </> : <>
      <div className="campaign-summary-line"><strong>Send progress</strong><span>{number(processed)} / {number(total)} processed</span></div>
      {total > 0 ? <progress className="campaign-progress-bar" aria-label="Campaign send progress" aria-valuetext={`${number(processed)} of ${number(total)} emails processed`} value={processed} max={total} /> : <p className="muted">No email records available.</p>}
    </>}
    {activeStatus && <p className="campaign-status-line muted" role="status" title={statusTitle}>{statusText}</p>}
    {finishAt && <SummaryLine label="Estimated finish" figure={<span title={atUtc(finishAt)}>{approxRelativeTime(finishAt)}</span>} />}
    {!preparing && awaitingQueue > 0 && <div className="campaign-summary-line"><span>Awaiting queue</span><span>{number(awaitingQueue)}</span></div>}
    {queued > 0 && <div className="campaign-summary-line"><span>Queued</span><span>{number(queued)}</span></div>}
    {processing > 0 && <div className="campaign-summary-line"><span>Processing</span><span>{number(processing)}</span></div>}
    {outcomes.filter(([, count]) => count && count > 0).map(([label, count, status]) => <SummaryLine key={label} label={label} figure={number(count)} to={status && campaignLogs(campaign.id, status)} />)}
  </div>
}

/**
 * Review's estimate of how long sending takes with the pacing being chosen: the API's send estimate (the region's rate and
 * where the sender starts on the ramp) through the model the API estimates with. One line, its height held while the
 * audience is still being counted.
 */
export function SendEstimateLine({ campaign, recipients, start, perDay, rateShare }: { campaign: Campaign; recipients: number | null; start: number; perDay: number | null; rateShare: number }) {
  const estimate = campaign.sendEstimate, left = recipients ?? estimate?.recipients ?? null
  // The ramp only says something when it holds this send back: more recipients than its first step's hour.
  const ramp = estimate?.ramp && left !== null && left > estimate.ramp.ceilingPerHour ? estimate.ramp : null
  const finish = estimate?.ratePerSecond && left ? estimateFinish({ recipients: left, start, ratePerSecond: estimate.ratePerSecond, rateShare, perDay, ramp: ramp && { step: ramp.step - 1, startedAt: null, released: 0 } }) : null
  const span = finish === null ? '' : relativeTime(new Date(finish).toISOString(), start)
  const takes = !span ? '' : span === 'in under a minute' ? 'Takes under a minute' : `Takes ${span.replace(/^in /, 'about ')}`
  const ramping = ramp ? `ramps up from ${number(ramp.ceilingPerHour)} an hour, as a new sender's large campaigns do` : ''
  const text = takes ? `${takes}${ramping ? `: it ${ramping}` : ''}.` : ramping ? `It ${ramping}.` : ''
  return <p className="review-detail campaign-send-estimate" title={finish === null ? undefined : `Last recipients go out about ${atUtc(new Date(finish).toISOString())}`}>{text}</p>
}

// Pause, resume, and daily-limit controls for a send that is still releasing recipients.
export function CampaignPacing({ campaign }: { campaign: Campaign }) {
  const cache = useQueryClient()
  // Pausing, resuming and pacing are delivery controls: owners and admins only.
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const expansion = campaign.delivery
  const pacing = expansion?.pacing
  // A campaign that failed after releasing recipients resumes from its cursor on the same snapshot, like a paused one.
  const paused = campaignResumable(campaign)
  const active = releasing(campaign)
  const [limit, setLimit] = useState(() => pacing?.perDay ? String(pacing.perDay) : '')
  const [autoPause, setAutoPause] = useState(pacing?.autoPause ?? true)
  const [share, setShare] = useState(() => String(ratePercent(pacing?.rateShare)))
  const [error, setError] = useState('')
  // Each action returns the full campaign; write it into the cache instead of refetching everything.
  const campaignKey = ['nightmail', 'campaign', campaign.id]
  function accept(next: Campaign) {
    cache.setQueryData(campaignKey, next)
    void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' })
  }
  const pause = useApiMutation((api, id: string) => api.campaigns.pause(id), 'Sending paused', false, false)
  const resume = useApiMutation((api, id: string) => api.campaigns.resume(id), 'Sending resumed', false, false)
  const update = useApiMutation((api, input: CampaignPacingInput) => api.campaigns.setPacing(campaign.id, input), 'Pacing updated', false, false, campaign.id)
  const busy = pause.isPending || resume.isPending || update.isPending
  async function run(action: () => Promise<Campaign>) {
    setError('')
    try { accept(await action()) }
    catch (cause) {
      if (isDuplicateSubmission(cause)) return
      setError(errorText(cause))
      // A conflict means the send moved on (finished, paused elsewhere); show its real state.
      void cache.invalidateQueries({ queryKey: campaignKey })
    }
  }
  const trimmed = limit.trim()
  const nextPerDay = trimmed ? Number(trimmed.replaceAll(',', '')) : null
  const limitError = nextPerDay === null ? '' : perDayError(nextPerDay)
  const nextPercent = Number(share.trim())
  const shareError = ratePercentError(nextPercent)
  // Compare in whole percents so an unrounded API value is not resent unless edited.
  const shareChanged = nextPercent !== ratePercent(pacing?.rateShare)
  const changed = nextPerDay !== (pacing?.perDay ?? null) || autoPause !== (pacing?.autoPause ?? true) || shareChanged
  function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !changed) return
    if (limitError) { setError(`Daily limit: ${limitError}`); return }
    if (shareError) { setError(`Send rate: ${shareError}`); return }
    void run(() => update.mutateAsync({ perDay: nextPerDay, autoPause, ...(shareChanged ? { rateShare: nextPercent / 100 } : {}) }))
  }
  if (!expansion || (!paused && !active && !pacing?.perDay)) return null
  const perDay = pacing?.perDay ?? null
  const released = `${number(expansion.expanded)} of ${number(expansion.total)} released`
  const nextSlice = perDay && pacing?.nextWindowAt && (active || paused) ? ` · next slice ${relativeTime(pacing.nextWindowAt)}` : ''
  const rateShare = pacing?.rateShare != null && pacing.rateShare < 1 ? ` · up to ${ratePercent(pacing.rateShare)}% of send rate` : ''
  return <div className="campaign-pacing">
    {paused && <div className="campaign-scheduled" data-tone={campaign.status === 'failed' ? 'danger' : 'warning'} role="status">
      <div className="campaign-pacing-banner">{campaign.status === 'failed' ? <><strong>Sending failed</strong>
        <span>No new recipients are being released. Resume to continue where it stopped, or cancel.{expansion.pausedAt && <span className="muted" title={atUtc(expansion.pausedAt)}> Paused {relativeTime(expansion.pausedAt)}.</span>}</span></>
        // An automatic pause says why first.
        : <span>{expansion.pauseReason && `${expansion.pauseReason.message} `}{expansion.pausedAt && <><span title={atUtc(expansion.pausedAt)}>Paused {relativeTime(expansion.pausedAt)}.</span> </>}Queued emails still send.</span>}
        {canAdminister && <Button variant="primary" size="sm" loading={resume.isPending} disabled={busy} onClick={() => void run(() => resume.mutateAsync(campaign.id))}>Resume</Button>}
      </div>
    </div>}
    <div className="campaign-summary-line">
      <span>{perDay ? <>{released} · {number(perDay)}/day{nextSlice && <span title={atUtc(pacing!.nextWindowAt!)}>{nextSlice}</span>}</> : released}{rateShare}</span>
      {active && canAdminister && <Button variant="secondary" size="sm" loading={pause.isPending} disabled={busy} onClick={() => void run(() => pause.mutateAsync(campaign.id))}>Pause</Button>}
    </div>
    {perDay && (active || paused) && <div className="campaign-summary-line muted"><span>Released in this 24-hour slice</span><span>{number(pacing?.windowExpanded ?? 0)} / {number(perDay)}</span></div>}
    {(active || paused) && canAdminister && <form className="campaign-pacing-form" onSubmit={save}>
      <div className="campaign-pacing-limit">
        <label htmlFor="campaign-pacing-limit" className="muted">Daily limit</label>
        <Input id="campaign-pacing-limit" type="number" inputMode="numeric" min={minPerDay} max={maxPerDay} step={1} placeholder="No limit" value={limit} aria-invalid={Boolean(limitError) || undefined} onChange={event => { setLimit(event.target.value); setError('') }} disabled={busy} />
        <label htmlFor="campaign-pacing-share" className="muted">Max send rate %</label>
        <Input id="campaign-pacing-share" className="campaign-pacing-share" type="number" inputMode="numeric" min={minRatePercent} max={maxRatePercent} step={1} value={share} aria-invalid={Boolean(shareError) || undefined} onChange={event => { setShare(event.target.value); setError('') }} disabled={busy} />
        <Button type="submit" size="sm" loading={update.isPending} disabled={busy || !changed}>Save</Button>
      </div>
      {/* Hosted always pauses on high bounces or complaints. */}
      {!multiTenant && <Checkbox label="Auto-pause on high bounces or complaints" checked={autoPause} onCheckedChange={value => { setAutoPause(value); setError('') }} disabled={busy} />}
    </form>}
    {error && <p className="campaign-note" data-tone="danger" role="alert">{error}</p>}
  </div>
}
