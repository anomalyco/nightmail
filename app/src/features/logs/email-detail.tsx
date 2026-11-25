import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { useApi, useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { pendingEmailStatuses as pendingStatuses, type Email, type EmailEvent } from '../../data/types'
import { Alert, Button, CopyButton, elapsed, ErrorState, Icon, Identifier, PageHeader, Sheet, Tooltip, Waterfall, type Fact, type Tone } from '../../components/ui'
import { useEmailDocument } from '../../components/EmailPreview'
import { mentionsRemoteImage } from '../../lib/html-scan'
import { Checks, ChecksChip, ChecksToggle, EmailViews, useSendability, type InsightSource } from '../../components/EmailInsight'
import { AddressList, Sender } from '../../components/PrivateAddress'
import { AddressText } from '../../components/AddressText'
import { date, label, shortDateTime, time } from '../../lib/format'
import { EmailBar, EmailDetailSkeleton, EmailFactsStrip } from './skeletons'
import { useDetailLayout } from './detail-layout'
import { ThreadChip, ThreadRows, ThreadTimeline, threaded, threadItems, useThreadPrefetch } from './thread'
import { reasonOf, type Reason } from './reason'
import { productName } from '../../../../api/src/brand'
import { errorText } from '../../data/types'

// A sent email, in the order people come for: did it arrive (the status and its delivery, and why when it didn't), what it looked like (the
// preview: as sent and in each client, side by side where there is room), and how to do better (Checks: at most three
// things to fix), and the conversation it is part of. The window decides where each sits (detail-layout.ts). On a
// desktop it is a console: a 44px bar (back, the kind, the subject, its status and ID), one 36px bar of facts, then the
// preview beside a 320px inspector with the delivery and the checks.

// A scheduled email reads queued, with scheduled true, until it goes; the page calls it scheduled.
const statusOf = (email: Email) => email.scheduled ? 'scheduled' : email.status
export function EmailDetailPage() {
  const { id = '' } = useParams()
  // Moving to another message of its thread keeps this one up until that one arrives (thread.tsx reads it ahead).
  const query = useApiDef(queries.email(id), { interval: email => email && pendingStatuses.includes(email.status) ? 30_000 : false, keepPrevious: true })
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Email detail" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return query.data ? <EmailDetail key={query.data.id} email={query.data} focus={id} /> : null
}


// focus: the email the URL names, which the thread marks at once while it loads.
function EmailDetail({ email, focus }: { email: Email; focus: string }) {
  const { mode } = useDetailLayout()
  const [panel, setPanel] = useState(false)
  // A phone or tablet opens the delivery and the facts, the checks, and the thread in sheets; each returns focus to its opener.
  const [sheet, setSheet] = useState<'details' | 'checks' | 'thread' | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openSheet = (which: 'details' | 'checks' | 'thread') => (from: HTMLElement) => { opener.current = from; setSheet(which) }
  const thread = threaded(email.thread) ? email.thread : null
  const items = threadItems(thread, focus)
  const open = { warm: useThreadPrefetch(items), onNavigate: () => setSheet(null) }
  const panelId = useId(), deliveryId = useId()
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { if (panel) panelRef.current?.focus() }, [panel])
  const hasHtml = email.html.trim().length > 0
  const text = email.text ?? ''
  const source = useMemo<InsightSource>(() => ({ kind: 'email', id: email.id, html: hasHtml }), [email.id, hasHtml])
  const check = useSendability(source)
  // The email as its recipients saw it: its own fonts, styles and image sizes. Its remote images (tracking pixels removed)
  // wait for Load images, as received mail's do (ReceivedEmailPreview): a reply or forward can quote an outside
  // sender's images, and loading them would tell that sender when, and from which address, it was opened.
  const [imagesFor, setImagesFor] = useState<string | null>(null)
  const remote = useMemo(() => mentionsRemoteImage(email.html), [email.html]), loadImages = imagesFor === email.html
  const original = useEmailDocument({ html: email.html, attachmentIds: email.attachments, remoteImages: loadImages, respectStyles: true, asSent: true, dark: true })
  const images = remote && !loadImages && <Tooltip content="Remote images are hidden so whoever wrote them can’t tell when this email is opened.">
    <Button variant="ghost" size="sm" onClick={() => setImagesFor(email.html)}>Load images</Button>
  </Tooltip>
  // A poll that brings new events starts the line over from them.
  // A phone says why under its status line; its Details sheet then adds only the receiving server's reply.
  const compact = mode === 'stack'
  const delivery = <Delivery key={email.events.map(event => event.id).join()} email={email} vertical={mode !== 'panel'} why={compact ? 'said' : 'full'} />
  const why = compact ? reasonOf(email, email.events) : null
  const checks = <Checks check={check} />
  const close = () => { setPanel(false); document.querySelector<HTMLElement>(`[aria-controls="${panelId}"]`)?.focus() }
  const subject = email.subject || '(no subject)'
  return <div className="email-detail" data-mode={mode}>
    {compact ? <PageHeader title={<Subject text={subject} />} backTo="/logs" subtitle={<><StatusLine email={email} chip={<>{thread && <ThreadChip count={thread.count} onOpen={openSheet('thread')} />}<ChecksChip check={check} onOpen={openSheet('checks')} /></>} onOpen={openSheet('details')} />{why && <p className="email-why">{why.text}</p>}</>} />
      : <><EmailBar title={subject} end={<><StatusCue email={email} /><Identifier value={email.id} copyLabel="Copy email ID" /></>} /><EmailFacts email={email} /></>}
    {mode === 'panel' && delivery}
    <div className="email-detail__body">
      <section className="email-detail__preview" aria-label="Preview">
        {thread && mode === 'panel' && <ThreadRows items={items} part="before" open={open} />}
        <EmailViews source={source} previewSource={hasHtml ? { emailId: email.id } : null} check={check} original={{ doc: original.complete ? original.doc : null, dark: original.darkDoc === undefined ? undefined : original.complete ? original.darkDoc : null, error: original.error, html: email.html, text }}
          fill={!compact} wide={!compact} compact={compact}
          toolbarEnd={<>{images}{mode === 'panel' && <ChecksToggle check={check} open={panel} onToggle={() => setPanel(!panel)} controls={panelId} />}</>} />
        {thread && mode === 'panel' && <ThreadRows items={items} part="after" open={open} />}
      </section>
      {mode === 'column' && <aside className="email-detail__side ui-scroll-fade" aria-label="Delivery and checks">
        {thread && <ThreadTimeline thread={thread} items={items} open={open} />}
        <section className="email-detail__delivery" aria-labelledby={deliveryId}><h2 id={deliveryId} className="ss__title">Delivery</h2>{delivery}</section>
        {checks}
      </aside>}
      {/* Its toggle, on the toolbar's row, heads it: the panel starts at the preview's top. */}
      {mode === 'panel' && <aside ref={panelRef} id={panelId} className="email-detail__side ui-scroll-fade" aria-label="Checks" tabIndex={-1} hidden={!panel} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>{checks}</aside>}
    </div>
    {compact && <>
      <Sheet open={sheet === 'details'} onOpenChange={open => setSheet(open ? 'details' : null)} title="Details" className="email-detail-sheet" returnFocus={opener}>
        <section className="email-detail-sheet__delivery" aria-label="Delivery">{delivery}</section>
        <FactList email={email} />
      </Sheet>
      <Sheet open={sheet === 'checks'} onOpenChange={open => setSheet(open ? 'checks' : null)} title="Checks" className="email-detail-sheet" returnFocus={opener}>
        <Checks check={check} titled={false} />
      </Sheet>
      {thread && <Sheet open={sheet === 'thread'} onOpenChange={open => setSheet(open ? 'thread' : null)} title={`Thread · ${thread.count}`} className="email-detail-sheet" returnFocus={opener}>
        <ThreadTimeline thread={thread} items={items} open={open} titled={false} />
      </Sheet>}
    </>}
  </div>
}

// Text its class holds to a line or two: where that cuts it, it opens in place on a click, a tap, Enter or Space, and
// closes the same way. Text that fits is plain text. `text`: what it shows, to measure again when it changes.
function Clamped({ className, text, children }: { className: string; text: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  const [open, setOpen] = useState(false)
  // Open, it is whole, which says nothing of whether it is cut when closed: it is measured only while closed.
  const opened = useRef(open)
  opened.current = open
  useLayoutEffect(() => {
    const element = ref.current!
    const read = () => { if (!opened.current) setCut(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1) }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  const toggle = cut || open
  return <span ref={ref} className={className} data-open={open || undefined} role={toggle ? 'button' : undefined} tabIndex={toggle ? 0 : undefined} aria-expanded={toggle ? open : undefined}
    onClick={toggle ? () => setOpen(!open) : undefined} onKeyDown={toggle ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } } : undefined}>{children}</span>
}
// A phone's subject: two lines at most; a longer one opens in place.
const Subject = ({ text }: { text: string }) => <Clamped className="email-subject" text={text}>{text}</Clamped>

// Where it stands now, as a dot and a word: the cue beside the ID.
function StatusCue({ email }: { email: Email }) {
  return <span className="email-bar__status"><span className={`delivery__dot ui-tone--${toneOf(eventKey(email.status))}`} aria-hidden="true" />{label(statusOf(email))}</span>
}

// A phone's one line under the subject: the status as of its last step (a scheduled email: when it goes), with when and
// (on a tablet) the stream, opening the delivery and the facts; and the checks' chip. The Details sheet names the stream.
function StatusLine({ email, chip, onOpen }: { email: Email; chip: ReactNode; onOpen: (opener: HTMLElement) => void }) {
  const key = eventKey(email.status), steps = stepsOf(email.events, email), sendsAt = sendTime(email)
  const at = sendsAt ?? [...steps].reverse().find(step => step.key === key)?.at ?? steps[steps.length - 1]?.at ?? email.sentAt
  // Today, the time; before that, the day (the Details sheet has both).
  const when = sameDay(at, new Date().toISOString()) ? date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
    : date(at, { month: 'short', day: 'numeric', ...(at.slice(0, 4) === new Date().toISOString().slice(0, 4) ? {} : { year: 'numeric' }), timeZone: 'UTC' })
  return <div className="email-status">
    <button type="button" className="email-status__facts" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
      <span className={`delivery__dot ui-tone--${toneOf(key)}`} aria-hidden="true" />
      <span className="email-status__text"><span className="sr-only">Details: </span>{label(statusOf(email))}{sendsAt && ' for'} <time dateTime={at}>{when}</time><span className="email-status__stream"> · {label(email.stream)}</span></span>
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

// A desktop's facts under the bar, in one 36px row: from whom, to whom (opening its contact when there is one), then over
// the details column the stream, when and the region (the ID is in the bar); EmailDetailSkeleton draws the same strip.
function EmailFacts({ email }: { email: Email }) {
  const { multiTenant } = useWorkspaceAccess()
  const to = email.to.split(', ').filter(Boolean)
  const facts: Record<string, Omit<Fact, 'label'>> = {
    From: { value: <Sender name={email.fromName} address={email.from} /> },
    To: { value: email.contact ? <Link className="email-facts__contact" to={`/audience/contacts/${encodeURIComponent(email.contact.id)}`} aria-label="Open contact"><AddressList values={to} /><Icon icon={ArrowUpRight} size="xs" /></Link> : <AddressList values={to} /> },
    Stream: { value: <>{label(email.stream)}{email.simulated && <>{' · '}<Tooltip content="Simulated: never sent to SES."><span className="email-facts__note" tabIndex={0}>Simulated</span></Tooltip></>}</> },
    Sent: { value: <time dateTime={email.sentAt}>{shortDateTime(email.sentAt)} UTC</time>, mono: true },
    Region: { value: email.regionId, mono: true },
  }
  return <EmailFactsStrip multiTenant={multiTenant} label="Email details" fact={name => facts[name]} />
}

// ── Delivery: every event, oldest first, with what each means on hover ──

// One short name and one line of meaning per event; the raw event type is in the meaning for support and logs.
const eventCopy: Record<string, [name: string, meaning: string]> = {
  scheduled: ['Scheduled', 'Waiting for its send time. Until then you can cancel or reschedule it from Logs.'],
  rescheduled: ['Rescheduled', 'Its send time moved.'],
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
  rendering_failure: ['Rendering failed', 'A template value couldn’t be filled in.'],
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
// The data palette's hue for an event, where it has one (tokens.css); the rest take their tone.
const seriesOf: Record<string, string> = { dispatch_attempt: 'sent', delivery: 'delivered', open: 'opened', click: 'clicked', bounce: 'bounced', non_permanent_bounce: 'bounced', complaint: 'complained' }
const toneOf = (key: string): Tone => ['delivery', 'open', 'click'].includes(key) ? 'success'
  : ['complaint', 'reject', 'rendering_failure'].includes(key) ? 'danger'
  : ['bounce', 'non_permanent_bounce', 'validation_suppressed', 'delivery_delay', 'provider_throttled', 'dispatch_deferred', 'acceptance_unknown', 'suppressed'].includes(key) ? 'warning' : 'neutral'

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
// When a scheduled email goes, while it waits.
const sendTime = (email: Email) => email.scheduled && email.scheduledAt ? email.scheduledAt : null
const scheduledFor = (at: string) => `Scheduled for ${date(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
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
  // When: the exact UTC time of a single event (the column shows the time since the first), every time for repeats.
  if (step.events.length > 1) lines.push(step.events.map(event => stamp(event.at, day)).join(', '))
  else if (step.at) lines.push(`${date(step.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`)
  return <span className="delivery-tip">{lines.map((line, index) => <span key={index}>{line}</span>)}</span>
}

// Why it ended this way and what happens next, then the receiving server's own reply (`said`: only the reply). A reply
// too long for its line or two opens in place.
function Why({ reason, said }: { reason: Reason | null; said?: boolean }) {
  if (!reason || (said && !reason.said)) return null
  return <p className="delivery__why">{!said && reason.text}{reason.said && <Clamped className="delivery__said" text={reason.said}><AddressText text={reason.said} /></Clamped>}</p>
}

/** On one line under the header, or `vertical`: a column of steps, each with its time, in the details column or on a phone.
 *  Under the steps, why it ended this way (`why`: 'said' where the page already says it, for the server's reply alone). */
function Delivery({ email, vertical, why }: { email: Email; vertical: boolean; why: 'full' | 'said' }) {
  const api = useApi()
  const [events, setEvents] = useState(email.events)
  const [cursor, setCursor] = useState(email.eventsNextCursor)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // A scheduled email hasn't gone yet; its queued step says when it will.
  const sendsAt = sendTime(email)
  const steps = stepsOf(events, email).map(step => sendsAt && step.key === 'queued' ? { ...step, key: 'scheduled' } : step)
  const sends = (step: Step) => Boolean(sendsAt) && step.key === 'scheduled'
  const nameOf = (step: Step) => sends(step) ? scheduledFor(sendsAt!) : (eventCopy[step.key] ?? [label(step.key)])[0]
  const day = email.sentAt
  const reason = <Why reason={reasonOf(email, events)} said={why === 'said'} />
  // A time shows where it moves on from the step before; the last one shown says the zone.
  let previous = '', lastShown = -1
  const times = steps.map((step, index) => { const at = step.at && !sends(step) ? stamp(step.at, day) : ''; if (!at || at === previous) return ''; previous = at; lastShown = index; return at })
  const more = async () => {
    setBusy(true); setError('')
    try { const next = await api.emailEvents(email.id, cursor!); setEvents(previous => [...previous, ...next.items]); setCursor(next.nextCursor) }
    catch (cause) { setError(errorText(cause, 'Couldn’t load events.')) } finally { setBusy(false) }
  }
  // In a column (or a phone's sheet): a waterfall, every event on one time axis with the time since the first.
  if (vertical) {
    const start = Date.parse(steps.find(step => step.at)?.at ?? day)
    const rows = steps.map((step, index) => {
      const name = nameOf(step)
      return { key: step.key, tone: toneOf(step.key), series: seriesOf[step.key],
        label: <Tooltip content={<StepTip step={step} day={day} />}><span className="delivery__fact" tabIndex={0}><span className="delivery__name">{name}{step.events.length > 1 && <span className="delivery__count"> {step.events.length}×</span>}</span></span></Tooltip>,
        // A step with no time of its own (a status without its event) leaves the column empty rather than a bare dash.
        delta: !step.at || sends(step) ? '' : index === 0 ? <time dateTime={step.at}>{time(step.at)}</time> : `+${elapsed(Date.parse(step.at) - start)}` }
    })
    return <div className="delivery" data-vertical>
      <Waterfall label="Delivery" rows={rows} />
      {reason}
      {cursor && <Button variant="ghost" size="sm" loading={busy} onClick={() => void more()}>More events</Button>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  }
  return <div className="delivery">
    <ol className="delivery__steps ui-scroll-fade" aria-label="Delivery">
      {steps.map((step, index) => {
        const name = nameOf(step)
        const at = times[index]
        return <li key={step.key} className="delivery__step">
          <Tooltip content={<StepTip step={step} day={day} />}>
            <span className="delivery__fact" tabIndex={0}>
              <span className={`delivery__dot ui-tone--${toneOf(step.key)}`} aria-hidden="true" />
              <span className="delivery__name">{name}{step.events.length > 1 && <span className="delivery__count"> {step.events.length}×</span>}</span>
              {at && <time className="delivery__time" dateTime={step.at}>{at}{index === lastShown && <span className="delivery__zone"> UTC</span>}</time>}
            </span>
          </Tooltip>
        </li>
      })}
    </ol>
    {reason}
    {cursor && <Button variant="ghost" size="sm" loading={busy} onClick={() => void more()}>More events</Button>}
    {error && <Alert tone="danger">{error}</Alert>}
  </div>
}
