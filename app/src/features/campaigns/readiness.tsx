import { Checkbox, Field, Tabs, Textarea } from '../../components/ui'
import { date, number, percent } from '../../lib/format'
import type { CampaignReadiness } from '../../data/types'

// Review's send readiness (the API's CampaignReadiness, api/src/standing-model.ts RAMP.readiness): the verdict and why,
// the recommended daily batches with their dates and finish, what it was judged by, and, where a ramp is required and the
// sender sends another way, the consent source they confirm. One column, so it reads the same on a phone.
const DAY_MS = 86_400_000
const utc = (at: number, options: Intl.DateTimeFormatOptions) => date(new Date(at).toISOString(), { ...options, timeZone: 'UTC' })
const dayLabel = (at: number) => utc(at, { weekday: 'short', month: 'short', day: 'numeric' })
export const finishLabel = (at: number) => `${utc(at, { month: 'short', day: 'numeric' })}, ${utc(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UTC`
const titles = { ready: 'Ready to send', ramp_recommended: 'We recommend sending in batches', ramp_required: 'This send goes out in batches' } as const
const tones = { ready: 'success', ramp_recommended: 'warning', ramp_required: 'warning' } as const
const dmarcLabels = { reject: 'DMARC p=reject', quarantine: 'DMARC p=quarantine', none: 'DMARC p=none', missing: 'no DMARC record', invalid: 'DMARC record invalid' } as const
const mailFromLabels = { verified: 'MAIL FROM verified', pending: 'MAIL FROM pending', failed: 'MAIL FROM failed', not_configured: 'no custom MAIL FROM' } as const
const hostOf = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
// Where the links go, plainly: a domain's own link host that isn't active yet means they go somewhere else meanwhile.
function linksLine(domain: CampaignReadiness['domain']) {
  if (!domain.linkOrigin) return 'none: this campaign can’t launch right now'
  const host = hostOf(domain.linkOrigin)
  const own = domain.ownLinkHost
  return own?.active ? `${host}, this domain’s own` : own ? `${host}, until ${own.hostname} is set up` : host
}
const rate = (value: number | null) => value === null ? null : percent(value, value < 0.01 ? 2 : 1)
// When the registrable domain was registered (public registry data); nothing when not known yet.
const registered = (at: string | null | undefined) => at ? `registered ${new Date(`${at}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}` : null
const added = (days: number | null) => days === null ? 'not added to this workspace' : days === 0 ? 'added today' : days === 1 ? 'added yesterday' : `added ${number(days)} days ago`
function history(h: CampaignReadiness['history']['domain']) {
  if (!h.sent && !h.largestSend) return 'nothing in the last 30 days'
  return [h.largestSend ? `largest campaign ${number(h.largestSend)}` : null, `${number(h.sent)} sent in 30 days`,
    rate(h.bounceRate) && `${rate(h.bounceRate)} bounced`, rate(h.complaintRate) && `${rate(h.complaintRate)} complaints`].filter(Boolean).join(' · ')
}
export type PlanChoice = 'plan' | 'manual'
export type Consent = { confirmed: boolean; source: string }

export function ReadinessPanel({ readiness, start, choice, onChoice, consent, onConsent, needsConsent, disabled }: { readiness: CampaignReadiness; start: number; choice: PlanChoice; onChoice: (choice: PlanChoice) => void;
  consent: Consent; onConsent: (consent: Consent) => void; needsConsent: boolean; disabled: boolean }) {
  const { verdict, plan, list, domain } = readiness
  const share = (part: number | null) => part === null || !list.recipients ? null : percent(part / list.recipients, 0)
  const listLine = [`${number(list.recipients)} ${list.recipients === 1 ? 'recipient' : 'recipients'}`, list.risky ? `${number(list.risky)} risky skipped` : null,
    share(list.neverMailed) && `${share(list.neverMailed)} never mailed`, list.lastImport && `last import ${dayLabel(Date.parse(list.lastImport.at))} (${number(list.lastImport.contacts)})`].filter(Boolean).join(' · ')
  return <section className="send-readiness" aria-label="Send readiness">
    <p className="campaign-note" data-tone={tones[verdict]}><strong>{titles[verdict]}</strong></p>
    {readiness.summary && <p className="send-readiness__summary">{readiness.summary}</p>}
    {plan && <>
      <Tabs label="How to send" value={choice} disabled={disabled} onValueChange={value => onChoice(value as PlanChoice)} items={[{ value: 'plan', label: 'Recommended plan' }, { value: 'manual', label: 'Your own pace' }]} />
      {choice === 'plan' && <>
        <ol className="send-plan" aria-label="Daily batches">
          {plan.batches.map((batch, day) => <li key={day}><span>{day === 0 && start <= Date.now() + 60_000 ? `Today, ${dayLabel(start)}` : dayLabel(start + day * DAY_MS)}</span><span>{number(batch)}</span></li>)}
        </ol>
        {plan.seconds !== null && <p className="review-detail">Estimated finish {finishLabel(start + plan.seconds * 1000)}. The most engaged recipients go first, people never mailed before last, and sending pauses by itself if bounces or complaints climb.</p>}
      </>}
    </>}
    {needsConsent && <div className="send-consent">
      <Checkbox label="Everyone on this list agreed to get this email." checked={consent.confirmed} disabled={disabled} onCheckedChange={confirmed => onConsent({ ...consent, confirmed })} />
      <Field label="Where their consent comes from" htmlFor="campaign-consent-source" hint="For example: signed up at checkout on our site since 2023.">
        <Textarea id="campaign-consent-source" rows={2} maxLength={500} value={consent.source} disabled={disabled} onChange={event => onConsent({ ...consent, source: event.target.value })} />
      </Field>
    </div>}
    <dl className="review-facts">
      <dt>Domain</dt><dd>{[domain.name, registered(domain.registeredAt), added(domain.ageDays), domain.dmarc ? dmarcLabels[domain.dmarc] : 'DMARC not checked yet', mailFromLabels[domain.mailFrom]].filter(Boolean).join(' · ')}</dd>
      <dt>Links</dt><dd>{linksLine(domain)}{domain.sharedLinkPacing && ' · If the shared link domain reaches its daily limit, the remaining recipients will get this campaign on later days.'}</dd>
      <dt>This domain</dt><dd>{history(readiness.history.domain)}</dd>
      <dt>Workspace</dt><dd>{history(readiness.history.workspace)}</dd>
      <dt>List</dt><dd>{listLine}</dd>
      {readiness.sizeJump !== null && readiness.sizeJump > 1 && <><dt>Size</dt><dd>{number(Math.round(readiness.sizeJump))}× this domain’s largest campaign</dd></>}
    </dl>
    {domain.ownLinkHost && !domain.ownLinkHost.active && domain.linkOrigin && <p className="campaign-note" data-tone="warning"><span>Links in this campaign go on {hostOf(domain.linkOrigin)}, not {domain.ownLinkHost.hostname}: that link host isn’t set up yet. Copies made once it is go there.</span></p>}
    {(readiness.findings ?? readiness.reasons).length > 0 && <ul className="campaign-notes" aria-label="What the review found">{(readiness.findings ?? readiness.reasons).map(reason => <li key={reason.code} className="campaign-note"><span>{reason.message}</span></li>)}</ul>}
  </section>
}
