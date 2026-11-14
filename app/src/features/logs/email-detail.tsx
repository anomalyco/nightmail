import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { useApi, useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Email, EmailEvent, EmailEventDetail } from '../../data/types'
import { Alert, Button, CopyButton, ErrorState, PageHeader, Sheet, StatusBadge, Tooltip, type Tone } from '../../components/ui'
import { htmlToText, useEmailDocument } from '../../components/EmailPreview'
import { EmailViews, SendabilityChip, SendabilityDetails, SendabilityTitle, SendabilityToggle, useSendability, type InsightSource } from '../../components/EmailInsight'
import { AddressList, NameText, PrivateAddress } from '../../components/PrivateAddress'
import { AddressText } from '../../components/AddressText'
import { nameParts } from '../../lib/private-address'
import { date, label, shortDateTime, time } from '../../lib/format'
import { EmailDetailSkeleton } from './skeletons'
import { useDetailLayout } from './detail-layout'
import { productName } from '../../../../api/src/brand'

// A sent email, in the order people come for: did it arrive (the status and its delivery), what it looked like (the
// preview: as sent and in each client, side by side where there is room), and how to do better (the score, the fixes to
// make first and every finding). The window decides where each sits (detail-layout.ts).

// Statuses that can still change without user action; terminal emails are not polled.
const pendingStatuses = ['queued', 'attempting', 'accepted', 'sent', 'deferred', 'delayed']
export function EmailDetailPage() {
  const { id = '' } = useParams()
  const query = useApiDef(queries.email(id), { interval: email => email && pendingStatuses.includes(email.status) ? 30_000 : false })
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Email detail" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return query.data ? <EmailDetail email={query.data} /> : null
}

// "Name <address>": the name wraps as one piece and the address, with its brackets, stays together on the next line when it doesn't fit.
export function Sender({ name, address }: { name?: string | null; address: string }) {
  const parts = nameParts(name, address)
  return parts ? <span className="email-sender"><span><NameText parts={parts} /></span><span className="email-sender__address">&lt;<PrivateAddress value={address} />&gt;</span></span> : <PrivateAddress value={address} />
}

function EmailDetail({ email }: { email: Email }) {
  const api = useApi()
  const { mode, roomy } = useDetailLayout()
  const [panel, setPanel] = useState(false)
  // A phone or tablet opens the delivery and the facts, and the score, in sheets; each returns focus to its opener.
  const [sheet, setSheet] = useState<'details' | 'sendability' | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openSheet = (which: 'details' | 'sendability') => (from: HTMLElement) => { opener.current = from; setSheet(which) }
  const panelId = useId(), deliveryId = useId()
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { if (panel) panelRef.current?.focus() }, [panel])
  const hasHtml = email.html.trim().length > 0
  const text = email.text ?? (api.mode === 'demo' && hasHtml ? htmlToText(email.html) : '')
  const source = useMemo<InsightSource>(() => ({ kind: 'email', id: email.id, html: hasHtml }), [email.id, hasHtml])
  const check = useSendability(source)
  // The email as its recipients saw it: its own fonts, styles and image sizes, and its remote images (tracking pixels removed).
  const original = useEmailDocument({ html: email.html, attachmentIds: email.attachments, remoteImages: true, respectStyles: true, asSent: true })
  // A poll that brings new events starts the line over from them.
  const delivery = <Delivery key={email.events.map(event => event.id).join()} email={email} vertical={mode !== 'panel'} />
  const sendability = <SendabilityDetails check={check} expanded={roomy} />
  const close = () => { setPanel(false); document.querySelector<HTMLElement>(`[aria-controls="${panelId}"]`)?.focus() }
  const compact = mode === 'stack'
  const subject = email.subject || '(no subject)'
  return <div className="email-detail" data-mode={mode}>
    {compact ? <PageHeader title={<Subject text={subject} />} backTo="/logs" subtitle={<StatusLine email={email} chip={<SendabilityChip check={check} onOpen={openSheet('sendability')} />} onOpen={openSheet('details')} />} />
      : <PageHeader title={subject} backTo="/logs" subtitle={<EmailFacts email={email} />} actions={<StatusBadge status={email.status} />} />}
    {mode === 'panel' && delivery}
    <div className="email-detail__body">
      <section className="email-detail__preview" aria-label="Preview">
        <EmailViews source={source} previewSource={hasHtml ? { emailId: email.id } : null} check={check} original={{ doc: original.complete ? original.doc : null, error: original.error, html: email.html, text }}
          fill={!compact} wide={!compact} compact={compact}
          toolbarEnd={mode === 'panel' && <SendabilityToggle check={check} open={panel} onToggle={() => setPanel(!panel)} controls={panelId} />} />
      </section>
      {mode === 'column' && <aside className="email-detail__side ui-scroll-fade" aria-label="Details">
        <section className="email-detail__delivery" aria-labelledby={deliveryId}><h2 id={deliveryId} className="ss__title">Delivery</h2>{delivery}</section>
        {sendability}
      </aside>}
      {/* Its toggle, on the toolbar's row, heads it: the panel starts at the preview's top. */}
      {mode === 'panel' && <aside ref={panelRef} id={panelId} className="email-detail__side ui-scroll-fade" aria-label="Sendability" tabIndex={-1} hidden={!panel} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>{sendability}</aside>}
    </div>
    {compact && <>
      <Sheet open={sheet === 'details'} onOpenChange={open => setSheet(open ? 'details' : null)} title="Details" className="email-detail-sheet" returnFocus={opener}>
        <section className="email-detail-sheet__delivery" aria-label="Delivery">{delivery}</section>
        <FactList email={email} />
      </Sheet>
      <Sheet open={sheet === 'sendability'} onOpenChange={open => setSheet(open ? 'sendability' : null)} title={<SendabilityTitle check={check} />} className="email-detail-sheet email-detail-sheet--tall" returnFocus={opener}>
        <SendabilityDetails check={check} expanded titled={false} />
      </Sheet>
    </>}
  </div>
}

// A phone's subject: two lines at most; a longer one opens in place on a tap.
function Subject({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current!
    const read = () => setCut(element.scrollHeight > element.clientHeight + 1)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  const toggle = cut || open
  return <span ref={ref} className="email-subject" data-open={open || undefined} role={toggle ? 'button' : undefined} tabIndex={toggle ? 0 : undefined} aria-expanded={toggle ? open : undefined}
    onClick={toggle ? () => setOpen(!open) : undefined} onKeyDown={toggle ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } } : undefined}>{text}</span>
}

// A phone's one line under the subject: the status as of its last step, with when and the stream, opening the delivery
// and the facts; and the score's chip.
function StatusLine({ email, chip, onOpen }: { email: Email; chip: ReactNode; onOpen: (opener: HTMLElement) => void }) {
  const key = eventKey(email.status), steps = stepsOf(email.events, email)
  const at = [...steps].reverse().find(step => step.key === key)?.at ?? steps[steps.length - 1]?.at ?? email.sentAt
  // Today, the time; before that, the day (the Details sheet has both).
  const when = sameDay(at, new Date().toISOString()) ? date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
    : date(at, { month: 'short', day: 'numeric', ...(at.slice(0, 4) === new Date().toISOString().slice(0, 4) ? {} : { year: 'numeric' }), timeZone: 'UTC' })
  return <div className="email-status">
    <button type="button" className="email-status__facts" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
      <span className={`delivery__dot ui-tone--${toneOf(key)}`} aria-hidden="true" />
      <span className="email-status__text"><span className="sr-only">Details: </span>{label(email.status)} <time dateTime={at}>{when}</time> · {label(email.stream)}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
    {chip}
  </div>
}

// A phone's facts, in the Details sheet under the delivery: who, from whom, the stream, when and the ID.
function FactList({ email }: { email: Email }) {
  const { multiTenant } = useWorkspaceAccess()
  const to = email.to.split(', ').filter(Boolean)
  return <dl className="email-fact-list">
    <div><dt>To</dt><dd>{email.contact ? <Link className="email-facts__contact" to={`/audience/contacts/${encodeURIComponent(email.contact.id)}`} aria-label="Open contact"><AddressList values={to} /><ArrowUpRight size={12} aria-hidden="true" /></Link> : <AddressList values={to} />}</dd></div>
    <div><dt>From</dt><dd><Sender name={email.fromName} address={email.from} /></dd></div>
    <div><dt>Stream</dt><dd>{label(email.stream)}</dd></div>
    <div><dt>Sent</dt><dd><time dateTime={email.sentAt}>{shortDateTime(email.sentAt)} UTC</time></dd></div>
    {!multiTenant && <div><dt>Region</dt><dd>{email.regionId}</dd></div>}
    {email.simulated && <div><dt>Simulated</dt><dd>Never sent to SES.</dd></div>}
    <div><dt>ID</dt><dd className="email-fact-list__id"><code className="identifier">{email.id}</code><CopyButton value={email.id} label="Copy email ID" /></dd></div>
  </dl>
}

// To · From · stream · date · ID, on one line under the subject. The recipient opens its contact when there is one.
function EmailFacts({ email }: { email: Email }) {
  const { multiTenant } = useWorkspaceAccess()
  const to = email.to.split(', ').filter(Boolean)
  return <div className="email-facts">
    <span className="email-facts__item"><span className="email-facts__label">To</span>{email.contact ? <Link className="email-facts__contact" to={`/audience/contacts/${encodeURIComponent(email.contact.id)}`} aria-label="Open contact"><AddressList values={to} /><ArrowUpRight size={12} aria-hidden="true" /></Link> : <AddressList values={to} />}</span>
    <span className="email-facts__item email-facts__from"><span className="email-facts__label">From</span><Sender name={email.fromName} address={email.from} /></span>
    <span className="email-facts__item">{label(email.stream)}</span>
    <span className="email-facts__item"><time dateTime={email.sentAt}>{date(email.sentAt)}</time></span>
    {!multiTenant && <span className="email-facts__item">{email.regionId}</span>}
    {email.simulated && <Tooltip content="Simulated: never sent to SES."><span className="email-facts__item" tabIndex={0}>Simulated</span></Tooltip>}
    <span className="email-facts__item email-facts__id"><code className="identifier">{email.id}</code><CopyButton value={email.id} label="Copy email ID" /></span>
  </div>
}

// ── Delivery: every event, oldest first, with what each means on hover ──

// One short name and one line of meaning per event; the raw event type is in the meaning for support and logs.
const eventCopy: Record<string, [name: string, meaning: string]> = {
  queued: ['Queued', `${productName} took the email and queued it for sending.`],
  dispatch_attempt: ['Sent', `${productName} handed the email to Amazon SES.`],
  accepted: ['Accepted', 'SES took the email and gave it a message ID.'],
  dispatch_deferred: ['Waiting', `${productName} is holding the email until there is sending capacity.`],
  provider_throttled: ['Slowed', `SES asked ${productName} to slow down; the email is retried automatically.`],
  acceptance_unknown: ['Unconfirmed', `SES didn’t confirm whether it took the email, so ${productName} won’t resend it.`],
  send: ['Relayed', 'SES is delivering it to the recipient’s mail server.'],
  delivery: ['Delivered', 'The recipient’s mail server accepted it.'],
  bounce: ['Bounced', 'The recipient’s server refused it.'],
  non_permanent_bounce: ['Soft bounce', 'The recipient’s server refused it for now. A later email may get through.'],
  validation_suppressed: ['Not sent', 'SES skipped an address its checks found undeliverable.'],
  complaint: ['Marked as spam', 'The recipient reported it as spam.'],
  complaint_feedback: ['Not spam', 'The recipient’s provider reported it as not spam.'],
  reject: ['Rejected', 'SES refused to send it, for example because it contained a virus.'],
  rendering_failure: ['Rendering failed', 'A template value couldn’t be filled in, so nothing was sent.'],
  delivery_delay: ['Delayed', 'The recipient’s server put it off; SES keeps retrying.'],
  open: ['Opened', 'The recipient opened it with images on.'],
  click: ['Clicked', 'The recipient clicked a link in it.'],
  suppressed: ['Suppressed', 'Not sent: the address is suppressed after an earlier bounce or complaint.'],
  canceled: ['Canceled', 'The email was canceled before it was sent.'],
  subscription: ['Subscription', 'The recipient changed their subscription from this email.'],
}
// Webhook names for the same events, and statuses for an email without any.
const synonyms: Record<string, string> = { sent: 'send', delivered: 'delivery', bounced: 'bounce', complained: 'complaint', rejected: 'reject', rendering_failed: 'rendering_failure', delivery_delayed: 'delivery_delay', opened: 'open', clicked: 'click', delayed: 'delivery_delay', deferred: 'delivery_delay' }
const eventKey = (type: string) => { const key = type.replace(/^email\./, ''); return synonyms[key] ?? key }
const lifecycle = Object.keys(eventCopy)
const toneOf = (key: string): Tone => ['delivery', 'open', 'click'].includes(key) ? 'success'
  : ['complaint', 'reject', 'rendering_failure'].includes(key) ? 'danger'
  : ['bounce', 'non_permanent_bounce', 'validation_suppressed', 'delivery_delay', 'provider_throttled', 'dispatch_deferred', 'acceptance_unknown', 'suppressed'].includes(key) ? 'warning' : 'neutral'
const bounceReasons: Record<string, string> = { NoEmail: 'No such address', MailboxFull: 'Mailbox full', MessageTooLarge: 'Too large', ContentRejected: 'Content refused', AttachmentRejected: 'Attachment refused', Suppressed: 'On the SES suppression list', OnAccountSuppressionList: 'On your suppression list', EmailValidationSuppressed: 'Failed address checks' }
const bounceReason = (detail?: EmailEventDetail) => (detail?.bounceSubType && bounceReasons[detail.bounceSubType]) || (detail?.bounceType === 'Permanent' ? 'Permanent' : detail?.bounceType === 'Transient' ? 'Temporary' : undefined)

type Step = { key: string; events: EmailEvent[]; at?: string }
// Oldest first; events in the same second keep the order mail moves through them (Sent, Accepted, Delivered). Repeats
// of an event (opens, clicks, retries) are one step with a count.
function stepsOf(events: EmailEvent[], email: Email): Step[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at.slice(0, 19)) - Date.parse(b.at.slice(0, 19)) || lifecycle.indexOf(eventKey(a.type)) - lifecycle.indexOf(eventKey(b.type)))
  const steps: Step[] = []
  for (const event of sorted) {
    const key = eventKey(event.type), step = steps.find(item => item.key === key)
    if (step) step.events.push(event); else steps.push({ key, events: [event], at: event.at })
  }
  if (steps.length) return steps
  // No events recorded: when it was created, and where it stands now.
  const status = eventKey(email.status)
  return [{ key: 'queued', events: [], at: email.sentAt }, ...!['queued', 'attempting'].includes(email.status) ? [{ key: status, events: [] }] : []]
}
const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10)
const stamp = (at: string, day: string) => sameDay(at, day) ? time(at) : date(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const linkText = (link: string) => link.replace(/^https?:\/\//, '').slice(0, 64) + (link.replace(/^https?:\/\//, '').length > 64 ? '…' : '')

function StepTip({ step, day }: { step: Step; day: string }) {
  const [name, meaning] = eventCopy[step.key] ?? [label(step.key), '']
  const detail = step.events[0]?.detail, links = [...new Set(step.events.flatMap(event => event.detail?.link ? [event.detail.link] : []))]
  const bots = step.events.filter(event => event.detail?.bot).length
  const lines: ReactNode[] = [meaning || name]
  if (detail?.bounceType) lines.push(`SES: ${detail.bounceType}${detail.bounceSubType ? `, ${detail.bounceSubType}` : ''}.`)
  if (detail?.feedbackType) lines.push(`Feedback type: ${detail.feedbackType}.`)
  for (const event of step.events) if (event.diagnostic) lines.push(<code key={event.id}><AddressText text={event.diagnostic} /></code>)
  if (links.length) lines.push(<AddressText text={links.map(linkText).join(', ')} />)
  if (bots) lines.push(`${bots} likely from a bot or link scanner.`)
  if (step.events.length > 1) lines.push(step.events.map(event => stamp(event.at, day)).join(', '))
  return <span className="delivery-tip">{lines.map((line, index) => <span key={index}>{line}</span>)}</span>
}

/** On one line under the header, or `vertical`: a column of steps, each with its time, in the details column or on a phone. */
function Delivery({ email, vertical }: { email: Email; vertical: boolean }) {
  const api = useApi()
  const [events, setEvents] = useState(email.events)
  const [cursor, setCursor] = useState(email.eventsNextCursor)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const steps = stepsOf(events, email)
  const day = email.sentAt
  const contact = email.contact
  const suppressed = Boolean(contact?.suppressed) && ['bounced', 'complained', 'complaint'].includes(email.status)
  // A time shows where it moves on from the step before; the last one shown says the zone.
  let previous = '', lastShown = -1
  const times = steps.map((step, index) => { const at = step.at ? stamp(step.at, day) : ''; if (!at || at === previous) return ''; previous = at; lastShown = index; return at })
  const more = async () => {
    setBusy(true); setError('')
    try { const next = await api.emailEvents!(email.id, cursor!); setEvents(previous => [...previous, ...next.items]); setCursor(next.nextCursor) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t load events.') } finally { setBusy(false) }
  }
  return <div className="delivery" data-vertical={vertical || undefined}>
    <ol className="delivery__steps ui-scroll-fade" aria-label="Delivery">
      {steps.map((step, index) => {
        const [name] = eventCopy[step.key] ?? [label(step.key)]
        const at = times[index]
        const reason = step.key === 'bounce' || step.key === 'non_permanent_bounce' ? bounceReason(step.events[0]?.detail) : undefined
        return <li key={step.key} className="delivery__step">
          <Tooltip content={<StepTip step={step} day={day} />}>
            <span className="delivery__fact" tabIndex={0}>
              <span className={`delivery__dot ui-tone--${toneOf(step.key)}`} aria-hidden="true" />
              <span className="delivery__name">{name}{step.events.length > 1 && <span className="delivery__count"> {step.events.length}×</span>}</span>
              {at && <time className="delivery__time" dateTime={step.at}>{at}{index === lastShown && <span className="delivery__zone"> UTC</span>}</time>}
              {reason && <span className="delivery__note">{reason}</span>}
            </span>
          </Tooltip>
        </li>
      })}
      {suppressed && <li className="delivery__step"><Tooltip content={`${productName} skips this address from now on. Open the contact to change that.`}>
        <Link className="delivery__fact delivery__contact" to={`/audience/contacts/${encodeURIComponent(contact!.id)}`}><span className="delivery__dot ui-tone--danger" aria-hidden="true" /><span className="delivery__name">Suppressed</span><ArrowUpRight size={12} aria-hidden="true" /></Link>
      </Tooltip></li>}
    </ol>
    {cursor && api.emailEvents && <Button variant="ghost" size="sm" loading={busy} onClick={() => void more()}>More events</Button>}
    {error && <Alert tone="danger">{error}</Alert>}
  </div>
}
