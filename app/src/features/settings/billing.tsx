import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Check, ChevronDown, ChevronRight, CreditCard, MoreHorizontal } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ControlSkeleton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, IconButton, Input, Meter, Pagination, SectionHeader, Skeleton, StatusBadge, Switch, Tabs, useToast, type Column } from '../../components/ui'
import { useApiDef, useApiQuery, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import { ApiError, errorText, type Identity } from '../../data/types'
import type { Usage } from '../../data/usage'
import { billingApi, billingStatus, cardBrand, centsUsd, declineText, fullDay, monthDay, parseDollars, priceUc, total, usd, type AutoRechargeInput, type BillingSummary, type LedgerEntry, type Payment } from '../../data/billing'
import { useCursorPagination } from '../../lib/pagination'
import { date, number } from '../../lib/format'
import './billing.css'
import { productName } from '../../../../api/src/brand'
import { GOOD_STANDING } from '../../../../api/src/standing-model'
import { RATES } from '../../../../api/src/billing/rates'
import { resourceOf } from '../../data/invalidation'

type RowProps = { title: ReactNode; error?: ReactNode; children: ReactNode }
const cardLabel = (card: { brand: string; last4: string }) => `${cardBrand(card.brand)}\u00a0••••\u00a0${card.last4}`
const final = (payment: Payment | undefined) => !!payment && !['created', 'pending', 'requires_action'].includes(payment.status)
const gigabytes = (bytes: number) => `${(bytes / 1e9).toLocaleString('en-US', { maximumFractionDigits: bytes > 0 && bytes < 1e8 ? 2 : 1 })} GB`
/** The UTC calendar month usage counts in, as "Nov 1 – Nov 30". */
function period() {
  const now = new Date(), year = now.getUTCFullYear(), month = now.getUTCMonth()
  return `${monthDay(new Date(Date.UTC(year, month, 1)).toISOString())} – ${monthDay(new Date(Date.UTC(year, month + 1, 0)).toISOString())}`
}
/** Emails beyond a free allowance at the published price, in µ¢ (billing/rates.ts is the price list). */
const emailsCost = (count: number, free: number) => BigInt(Math.max(0, count - free)) * RATES.emailUc
const PRICE = `${usd(RATES.emailUc * 1000n)} per 1,000`

/** Every billing read refreshes together after money moves, and the session's banner state with them. */
function useBillingRefresh() {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey).startsWith('billing') })
    void client.invalidateQueries({ queryKey: ['identity'] })
  }
}

// Settings → Billing, the one page about money, read top down: a summary (the plan, what this month costs or why it
// isn't charged, the balance and the card, with Add credit), auto-recharge, this month's usage against each free
// allowance with what it costs, then the history. Every member can open it: a member reads the plan and the sent mail's
// usage (no balance, card, received mail or history, which the API keeps for owners and admins). Which blocks there are
// is known from the session on the first frame, and every value has a fixed box with a skeleton of its own, so nothing
// moves as the two reads land. The page keeps to a reading width.
export function BillingSection({ row: Row }: { row: (props: RowProps) => ReactNode }) {
  const { canAdminister } = useWorkspaceAccess()
  const query = useApiDef(queries.billing(), { interval: 60_000 })
  const reading = useApiDef(queries.usage(), { interval: 60_000 })
  // The state comes with the session (GET /v1/me) on the first frame: the plan, its badge and which alerts show are
  // decided from it, so the summary arriving fills reserved space instead of inserting lines.
  const identity = useSession()?.identity, state = identity?.billing
  const [adding, setAdding] = useState(false)
  const [about, setAbout] = useState(false)
  const b = query.data, usage = reading.data
  useCheckoutReturn()
  if (query.isError && !b) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  // A member's page is its usage; an owner's still has the balance, the card and the history without it.
  if (reading.isError && !usage && !canAdminister) return <ErrorState error={reading.error} onRetry={() => void reading.refetch()} />
  const free = state?.free === true
  // A daily sending limit is a row only while there is one (a new workspace's evaluation, or one its score set).
  const limited = usage ? usage.daily?.cap != null : identity?.connection?.sendingLimit?.cap != null
  return <div className="billing">
    {canAdminister && !free && state && <BillingAlerts state={state} summary={b} />}
    <Summary summary={b} usage={usage} state={state} admin={canAdminister} onAdd={() => setAdding(true)} onBalance={() => setAbout(true)} />
    {canAdminister && !free && <div className="settings-rows billing-rows"><AutoRecharge summary={b} Row={Row} /></div>}
    <UsageSection summary={b} usage={usage} failed={reading.isError} admin={canAdminister} charged={!free && state?.enforcement === 'enforce'} />
    {limited && <div className="settings-rows billing-rows"><DailyLimit usage={usage} /></div>}
    {canAdminister && <History />}
    {canAdminister && b && <AddCredit open={adding} onOpenChange={setAdding} summary={b} />}
    {canAdminister && b?.balance && <BalanceDetails open={about} onOpenChange={setAbout} balance={b.balance} />}
  </div>
}

type Fact = { label: string; value: ReactNode; note?: ReactNode; money?: boolean }
// The summary: the plan and where it stands, one sentence on how this workspace is charged, and three facts: what this
// month costs (or that it isn't charged, and what it would cost), the balance, and the card or when a free plan ends.
// It is the page's one surface; its only filled control is Add credit.
function Summary({ summary: b, usage, state, admin, onAdd, onBalance }: { summary: BillingSummary | undefined; usage: Usage | undefined; state: Identity['billing']; admin: boolean; onAdd: () => void; onBalance: () => void }) {
  const free = state?.free === true, enforced = state?.enforcement === 'enforce'
  const badge = billingStatus(state, b)
  const lead = free ? 'This workspace is on a free plan: its usage is measured but never charged.'
    : !enforced ? 'Billing hasn’t started: usage is measured, and nothing is taken from the balance yet.'
    : 'Usage beyond the free allowances is taken from the balance every hour.'
  const slot = (ready: unknown, render: () => ReactNode, width = 96) => ready ? render() : <Skeleton width={width} height={20} />
  // What this month's usage costs at the published prices: the API's figure for owners, and the sent mail's from the
  // counts for a member, who isn't shown amounts or received mail.
  const listed = admin ? slot(b?.monthToDate, () => usd(b!.monthToDate!.cost)) : slot(usage, () => usd(emailsCost(usage!.month.billedSent, RATES.freeSentEmails)))
  const when = admin ? period() : `Sent mail · ${period()}`
  const card = b?.paymentMethod
  const facts: (Fact | false)[] = free || !enforced ? [
    { label: 'This month', value: '$0.00', note: free ? 'Not charged' : 'Not charged yet', money: true },
    { label: 'At list price', value: listed, note: when, money: true },
    free ? { label: 'Free plan ends', value: slot(b, () => b!.freePlan?.until ? fullDay(b!.freePlan.until) : 'No end date', 120) }
      : admin && { label: 'Balance', value: <BalanceFigure summary={b} onOpen={onBalance} />, money: true },
  ] : [
    { label: 'This month so far', value: listed, note: when, money: true },
    admin && { label: 'Balance', value: <BalanceFigure summary={b} onOpen={onBalance} />, money: true },
    admin && { label: 'Payment method', value: <CardControl summary={b} />, note: b && card ? `Expires ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : null },
  ]
  return <section className="billing-summary" aria-labelledby="billing-plan">
    <div className="billing-summary__head">
      <h2 id="billing-plan" className="billing-summary__plan"><span>{free ? 'Free plan' : 'Pay as you go'}</span><span className="billing-summary__state">{badge && <StatusBadge status={badge.label} tone={badge.tone} />}</span></h2>
      {admin && !free && <Button variant="primary" disabled={!b?.balance} onClick={onAdd}>Add credit</Button>}
    </div>
    <p className="billing-summary__lead">{lead}</p>
    <dl className="billing-summary__facts">{facts.filter((fact): fact is Fact => !!fact).map(fact => <div key={fact.label}>
      <dt>{fact.label}</dt>
      <dd className="billing-summary__value" data-money={fact.money || undefined}>{fact.value}</dd>
      <dd className="billing-summary__note">{fact.note}</dd>
    </div>)}</dl>
  </section>
}
// The balance, which opens its parts.
function BalanceFigure({ summary: b, onOpen }: { summary: BillingSummary | undefined; onOpen: () => void }) {
  if (!b?.balance) return <Skeleton width={96} height={20} />
  return <button type="button" className="billing-summary__balance" aria-haspopup="dialog" aria-label={`Balance ${usd(total(b.balance))}: details`} onClick={onOpen}>{usd(total(b.balance))}<ChevronRight size={16} aria-hidden="true" /></button>
}

// The balance's three parts, opened from the balance.
function BalanceDetails({ open, onOpenChange, balance }: { open: boolean; onOpenChange: (open: boolean) => void; balance: NonNullable<BillingSummary['balance']> }) {
  const paid = BigInt(balance.paid)
  const parts: [string, string][] = [paid < 0n ? ['Unpaid usage', usd(-paid)] : ['Paid credit', usd(paid)], ['Promotional credit', usd(balance.promo)], ['Usage not yet settled', usd(balance.unsettled)]]
  return <Dialog open={open} onOpenChange={onOpenChange} title={`Balance ${usd(total(balance))}`} className="billing-about">
    <dl className="billing-facts">{parts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </Dialog>
}

// This month's usage: each meter against its free allowance, with the price after it and what the rest costs, then the
// total. The counts are the ones billing prices (each sent recipient, each received message, mail kept past 90 days),
// so the costs add up to the summary's figure. A bar is the allowance until it is used up; past it, the bar is the whole
// month with a tick where the free part ends. Without charging (a free plan, or before billing starts) the costs are
// what the usage would cost, in a muted ink.
function UsageSection({ summary: b, usage, failed, admin, charged }: { summary: BillingSummary | undefined; usage: Usage | undefined; failed: boolean; admin: boolean; charged: boolean }) {
  const counts = usage?.month
  const sentCost = counts ? emailsCost(counts.billedSent, RATES.freeSentEmails) : null
  const receivedCost = counts?.billedReceived != null ? emailsCost(counts.billedReceived, RATES.freeReceivedEmails) : null
  const aged = b ? Number(BigInt(b.free.storage.agedBytes)) : null, freeBytes = Number(RATES.freeStorageBytes)
  const total = admin ? (b?.monthToDate ? BigInt(b.monthToDate.cost) : null) : sentCost
  // Stored mail is priced by the day, so its share is what the month's total leaves after the emails.
  const storageCost = aged === null ? null : aged <= freeBytes ? 0n : total !== null && sentCost !== null && receivedCost !== null && total - sentCost - receivedCost > 0n ? total - sentCost - receivedCost : null
  const unavailable = failed && !usage
  return <section className="billing-section" aria-labelledby="billing-usage-title">
    <SectionHeader title={<span id="billing-usage-title">Usage this month</span>} actions={<Link to="/legal/terms#prices" className="billing-link" title="Pricing">Pricing<ArrowUpRight size={12} aria-hidden="true" /></Link>} />
    <div className="billing-usage" data-charged={charged || undefined}>
      <UsageMeter label="Sent" terms={`${PRICE} beyond free`} used={counts?.billedSent} free={RATES.freeSentEmails} unit="sent" cost={sentCost} unavailable={unavailable} />
      {admin && <UsageMeter label="Received" terms={`${PRICE} beyond free`} used={counts?.billedReceived ?? undefined} free={RATES.freeReceivedEmails} unit="received" cost={receivedCost} unavailable={unavailable} />}
      <UsageMeter label="Stored past 90 days" terms={`${usd(RATES.storageUcPerGbMonth)} per GB a month beyond free`} used={aged ?? undefined} free={freeBytes} format={gigabytes} cost={storageCost} />
      <div className="billing-usage__total">
        <span>{charged ? 'Total this month' : 'Total at list price'}</span>
        <span className="billing-usage__cost">{total !== null ? usd(total) : unavailable && !admin ? '—' : <Skeleton width={64} height={16} />}</span>
      </div>
    </div>
  </section>
}
function UsageMeter({ label, terms, used, free, unit, format = number, cost, unavailable }: { label: string; terms: string; used: number | undefined; free: number; unit?: string; format?: (value: number) => string; cost: bigint | null; unavailable?: boolean }) {
  const over = used !== undefined && used > free
  const detail = used === undefined ? null : over ? `${format(used - free)} beyond the ${format(free)} free` : `${format(free - used)} of ${format(free)} free left`
  return <div className="billing-meter" role="group" aria-label={label}>
    <span className="billing-meter__label">{label}</span>
    <span className="billing-meter__terms">{terms}</span>
    <span className="billing-meter__figures">{used !== undefined ? <><span><b>{format(used)}</b>{unit && <span className="muted"> {unit}</span>}</span><span className="muted">{detail}</span></>
      : unavailable ? <span className="muted">Couldn’t load</span> : <Skeleton width={180} height={14} />}</span>
    <Meter className="billing-meter__bar" value={used ?? 0} max={Math.max(used ?? 0, free)} mark={over ? free : undefined} label={`${label}: ${used === undefined ? 'loading' : `${format(used)}, ${format(free)} free`}`} title={over ? `The first ${format(free)} are free` : undefined} />
    <span className="billing-meter__cost">{cost !== null ? usd(cost) : used !== undefined || unavailable ? '—' : <Skeleton width={56} height={16} />}</span>
  </div>
}

// The daily sending limit while there is one: where it is now, and the steps it grows through open from it. The
// evaluation is once, not a day: its meter counts toward the first recipients, whose results take about an hour.
function DailyLimit({ usage }: { usage: Usage | undefined }) {
  const daily = usage?.daily
  // The API's steps (the evaluation) reserve their space while loading; good standing, with no limit, follows them.
  const steps = usage ? usage.steps : [null]
  // Where the workspace is: a step, or on a limit no step has (set by its score, a warning or the team), which the badge names.
  const at = daily?.step ?? null, custom = daily?.cap != null && daily.step === null
  const share = daily?.cap != null ? Math.min(1, daily.used / Math.max(1, daily.cap)) : 0, evaluating = daily?.step === 0
  return <details className="usage-limit">
    <summary className="settings-row">
      <span className="settings-row__label"><span className="usage-limit__title">Daily limit<ChevronDown size={14} aria-hidden="true" />{custom && <StatusBadge status="Limited" tone="neutral" />}</span></span>
      <span className="settings-row__control">{daily?.cap != null ? <span className="usage-meter" title={evaluating ? `Evaluation: the first ${number(daily.cap)} recipients, once. Their results take about an hour.` : daily.resetAt ? `Capacity frees up from ${date(daily.resetAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC` : undefined}>
        <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label={evaluating ? 'Evaluation recipients sent' : 'Recipients used in the last 24 hours'} aria-valuemin={0} aria-valuemax={daily.cap} aria-valuenow={daily.used}><i style={{ transform: `scaleX(${share})` }} /></span>
        <span className="usage-meter__count">{number(daily.used)} / {number(daily.cap)}</span>
      </span> : <Skeleton width={160} height={20} />}</span>
    </summary>
    <div className="usage-steps-section">
      <ol className="usage-steps">{steps.map((step, index) => {
        const current = at === index, done = at != null && index < at
        return <li key={index} data-current={current || undefined} data-done={done || undefined} style={{ '--i': index } as CSSProperties}>
          <span className="usage-steps__mark" aria-hidden="true">{done ? <Check size={12} strokeWidth={2.75} /> : index + 1}</span>
          {step ? <span className="usage-steps__body"><span><b>Evaluation</b> · first {number(step.cap)} recipients, once{current && <span className="usage-steps__badge">You’re here</span>}</span><span className="muted">{step.requires}</span></span> : <span className="usage-steps__body"><Skeleton width={160} height={20} /><Skeleton width={280} height={16} /><Skeleton width={200} height={16} /></span>}
        </li>
      })}
        <li style={{ '--i': steps.length } as CSSProperties}>
          <span className="usage-steps__mark" aria-hidden="true">{steps.length + 1}</span>
          <span className="usage-steps__body"><span><b>No daily limit</b></span><span className="muted">{`Good standing: a sender score of ${GOOD_STANDING} or more, with no warning. Sending is paced per minute.`}</span></span>
        </li>
      </ol>
    </div>
  </details>
}

/** What the banner doesn't say, where the fix is: the date received mail starts being held, and why auto-recharge
 *  turned off (the banner leaves that to this page). Held mail and paused sending are the banner's, on every page. Which
 *  alert shows comes from the session's state; the date fills a fixed-width slot when the summary arrives. */
function BillingAlerts({ state, summary: b }: { state: NonNullable<ReturnType<typeof useBillingState>>; summary: BillingSummary | undefined }) {
  if (state.enforcement !== 'enforce') return null
  // The date ends its line, so the text replacing the skeleton moves nothing.
  const slot = (ready: string | null | undefined, width: number) => ready ? <span>{ready}</span> : <span className="billing-slot"><Skeleton width={width} height={14} /></span>
  return <>
    {state.receiving === 'grace' && <Alert tone="warning" title={<>Received mail is accepted until {slot(b?.grace.receiveHoldAt ? monthDay(b.grace.receiveHoldAt) : null, 44)}</>}>Then it’s held until you add credit.</Alert>}
    {state.autoRecharge === 'failed' && <Alert tone="warning" title="Auto-recharge is off">{['dispute', 'early_fraud_warning'].includes(b?.autoRecharge?.disabledReason ?? '') ? `Your card was blocked after a ${b?.autoRecharge?.disabledReason === 'dispute' ? 'dispute' : 'fraud warning'}. Add a different card, then turn auto-recharge back on.` : `${productName} couldn’t charge your card. Update the card, then turn auto-recharge back on.`}</Alert>}
  </>
}
const useBillingState = () => useSession()?.identity?.billing

// The summary's card: its brand and last four with Replace and Remove in a menu, or Add a card, which opens Stripe.
function CardControl({ summary: b }: { summary: BillingSummary | undefined }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!b) return <Skeleton width={120} height={20} />
  async function setup() {
    setBusy(true)
    try { window.location.assign((await billingApi.setupCard()).checkoutUrl) } catch (error) { toast(errorText(error), 'error'); setBusy(false) }
  }
  const card = b.paymentMethod
  if (!card) return <Button variant="ghost" size="sm" className="billing-summary__add-card" loading={busy} onClick={() => void setup()}><CreditCard size={14} aria-hidden="true" />Add a card</Button>
  return <span className="billing-summary__card">
    <span>{cardLabel(card)}</span>
    <DropdownMenu label="Card actions" title={cardLabel(card)} trigger={<IconButton size="sm" label="Card actions"><MoreHorizontal size={16} aria-hidden="true" /></IconButton>} items={[{ label: 'Replace card', onSelect: () => void setup() }, { label: 'Remove card', destructive: true, onSelect: () => setRemoving(true) }]} />
    <ConfirmDialog open={removing} onOpenChange={setRemoving} danger title="Remove this card?" description={`${cardLabel(card)} is removed from Stripe and auto-recharge turns off.`} confirmLabel="Remove card"
      onConfirm={async () => { try { await billingApi.removeCard() } catch (cause) { throw new Error(errorText(cause)) } refresh(); toast('Card removed. Auto-recharge is off.', 'success') }} />
  </span>
}

// Every way credit is added names the terms it is sold under: refunds and the 12-month expiry (Terms §5.7).
const TERMS = <>By adding credit you agree to the <Link to="/legal/terms#refunds-and-credit-expiry">refund and expiry terms</Link>.</>
const added = (cents: number) => `${centsUsd(cents)} added to your balance`
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

// Auto-recharge: one row with its setting as the value ("$25 below $10", or where it stands) and its switch. The amounts,
// how it works and the terms open from Edit, and from turning it on, which asks before the card is charged; turning it
// off is one click. Without a card the switch is off: the card row above it has Add a card.
function AutoRecharge({ summary: b, Row }: { summary: BillingSummary | undefined; Row: (props: RowProps) => ReactNode }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const [editing, setEditing] = useState<'edit' | 'enable' | null>(null)
  const [pending, setPending] = useState(false)
  const settings = b?.autoRecharge
  if (!b || !settings) return <Row title="Auto-recharge"><Skeleton width={96} height={20} /><ControlSkeleton width={104} /></Row>
  const hasCard = !!b.paymentMethod
  const status = b.state.autoRecharge === 'capped' ? <StatusBadge status="Limit reached" tone="warning" /> : settings.pending ? <StatusBadge status="Adding credit" tone="info" />
    : <span className="billing-recharge__amounts">{dollars(settings.amountCents)} below {dollars(settings.thresholdCents)}</span>
  async function turnOff() {
    setPending(true)
    try { await billingApi.autoRecharge({ enabled: false, thresholdCents: settings!.thresholdCents, amountCents: settings!.amountCents, monthlyCapCents: settings!.monthlyCapCents }); refresh(); toast('Auto-recharge is off', 'success') }
    catch (cause) { toast(errorText(cause), 'error') } finally { setPending(false) }
  }
  return <Row title="Auto-recharge">
    <span className="cluster settings-inline billing-recharge">
      {status}
      <Button size="sm" onClick={() => setEditing('edit')}>Edit</Button>
      <Switch label={<span className="sr-only">Auto-recharge</span>} checked={settings.enabled} disabled={pending || !hasCard} onCheckedChange={on => { if (on) setEditing('enable'); else void turnOff() }} />
    </span>
    {editing && <RechargeDialog key={JSON.stringify(settings)} settings={settings} hasCard={hasCard} enable={editing === 'enable'} capped={b.state.autoRecharge === 'capped'} Row={Row} onClose={() => setEditing(null)} />}
  </Row>
}
function RechargeDialog({ settings, hasCard, enable, capped, Row, onClose }: { settings: NonNullable<BillingSummary['autoRecharge']>; hasCard: boolean; enable: boolean; capped: boolean; Row: (props: RowProps) => ReactNode; onClose: () => void }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const initial = { threshold: (settings.thresholdCents / 100).toString(), amount: (settings.amountCents / 100).toString(), cap: (settings.monthlyCapCents / 100).toString() }
  const [form, setForm] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const cents = { threshold: parseDollars(form.threshold), amount: parseDollars(form.amount), cap: parseDollars(form.cap) }
  const invalid = { threshold: cents.threshold === null || cents.threshold < 500 || cents.threshold > 100_000, amount: cents.amount === null || cents.amount < 2000 || cents.amount > 1_000_000,
    cap: cents.cap === null || cents.cap < (cents.amount ?? 0) || cents.cap > 25_000_000 }
  const valid = !invalid.threshold && !invalid.amount && !invalid.cap
  const changed = form.threshold !== initial.threshold || form.amount !== initial.amount || form.cap !== initial.cap
  // Each amount's range shows once the value is outside it.
  const rows = [['threshold', 'When balance falls below', '$5 to $1,000'], ['amount', 'Add', '$20 to $10,000 each time'], ['cap', 'Monthly limit', '$20 to $250,000, at least the Add amount']] as const
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || !hasCard || (!enable && !changed)) return
    const input: AutoRechargeInput = { enabled: enable || settings.enabled, thresholdCents: cents.threshold!, amountCents: cents.amount!, monthlyCapCents: cents.cap! }
    setPending(true); setError(null)
    try { await billingApi.autoRecharge(input); refresh(); toast(enable ? 'Auto-recharge is on' : 'Auto-recharge saved', 'success'); onClose() }
    catch (cause) { setError(cause) } finally { setPending(false) }
  }
  return <Dialog open onOpenChange={next => { if (!next && !pending) onClose() }} title={enable ? 'Turn on auto-recharge' : 'Auto-recharge'} className="billing-recharge-dialog"
    footer={<><Button disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="billing-recharge" loading={pending} disabled={!valid || !hasCard || (!enable && !changed)}>{enable ? 'Turn on' : 'Save'}</Button></>}>
    <form id="billing-recharge" className="settings-rows billing-rows" onSubmit={submit} noValidate>
      {rows.map(([key, title, range]) => <Row key={key} title={title} error={invalid[key] ? range : undefined}>
        <span className="billing-dollars"><span aria-hidden="true">$</span><Input aria-label={`${title}, in dollars`} aria-invalid={invalid[key] || undefined} inputMode="decimal" value={form[key]} disabled={pending || !hasCard} onChange={event => setForm({ ...form, [key]: event.target.value })} /></span>
      </Row>)}
    </form>
    <dl className="billing-facts"><div><dt>Added this month</dt><dd>{centsUsd(settings.monthTotalCents)}{capped ? ' · limit reached' : settings.pending ? ' · adding credit now' : ''}</dd></div></dl>
    <p className="muted billing-add__terms">{hasCard ? 'A failed charge turns it off.' : 'Add a card to turn it on.'} {TERMS}</p>
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
  </Dialog>
}

// History: the balance's changes and the card payments, a page at a time. Both are cursor lists with card slots on phones.
// The ledger has one usage entry an hour; the page shows one line a day (UTC), its mail and its cost added up from
// those entries, so a month reads as its days. Everything else on the ledger (credit, refunds, adjustments) keeps its own line.
type Line = { key: string; day: string; text: string; /** A top-up's credit expires on this day. */ expires: string | null; amount: bigint; /** False: usage measured but not charged (a free plan, or before billing starts). */ charged: boolean; invoiceUrl: string | null }
type LedgerPage = { data: LedgerEntry[]; nextCursor: string | null }
type Meters = Record<string, { quantity?: number | string } | undefined>
/** The UTC day of the last hour an hourly usage entry settled; null for anything that isn't an hour's usage (a repricing),
 *  which stays a line of its own in the API's words. Each hourly run settles the hour that just closed, and its window
 *  also reaches back to any earlier hour a late change (a canceled send's refund) went into, so a run after midnight can
 *  read "Nov 23, 23:00 – Nov 24, 03:00": it is still the 02:00 hour's usage, not a running total, and counts on Nov 24. */
function usageDay(entry: LedgerEntry) {
  if (entry.kind !== 'usage' || typeof entry.detail.to !== 'string') return null
  const to = Date.parse(entry.detail.to)
  return Number.isNaN(to) ? null : new Date(to - 1).toISOString().slice(0, 10)
}
/** A day's usage, as "4,919 sent · 289 received": sent and received mail, stored mail, and mail on a connected AWS account. */
function usageText(sum: Record<string, number>) {
  const own = (sum.byo_send ?? 0) + (sum.byo_receive ?? 0)
  const parts = [sum.send ? `${number(sum.send)} sent` : '', sum.receive ? `${number(sum.receive)} received` : '', sum.storage ? 'Stored mail' : '', own ? `${number(own)} on your AWS` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Usage'
}
/** Ledger entries, newest first, as history lines: each day's usage entries become one line where the day's newest entry is. */
function historyLines(entries: LedgerEntry[]): Line[] {
  const lines: Line[] = [], days = new Map<string, { line: Line; sum: Record<string, number> }>()
  for (const entry of entries) {
    const day = usageDay(entry)
    if (!day) {
      const charged = entry.detail.charged !== false
      lines.push({ key: `entry-${entry.id}`, day: entry.at.slice(0, 10), text: charged ? entry.description : entry.description.replace(/ \(not charged\)$/, ''), expires: entry.kind === 'topup' && entry.expiresAt ? fullDay(entry.expiresAt) : null, amount: BigInt(entry.amount), charged, invoiceUrl: entry.invoiceUrl })
      continue
    }
    let group = days.get(day)
    if (!group) { group = { line: { key: `day-${day}`, day, text: '', expires: null, amount: 0n, charged: false, invoiceUrl: null }, sum: {} }; days.set(day, group); lines.push(group.line) }
    const meters = (typeof entry.detail.meters === 'object' && entry.detail.meters ? entry.detail.meters : entry.detail) as Meters
    for (const meter of ['send', 'receive', 'storage', 'byo_send', 'byo_receive']) group.sum[meter] = (group.sum[meter] ?? 0) + Number(meters[meter]?.quantity ?? 0)
    if (entry.detail.charged !== false) group.line.charged = true
    group.line.amount += BigInt(entry.amount)
    group.line.text = usageText(group.sum)
  }
  return lines
}
/** How many of these entries (newest first) end on a whole day: the oldest day among them may continue on the next
 *  ledger page, so it and anything among its entries waits for that page. */
function wholeDays(entries: LedgerEntry[]) {
  let last: string | null = null, cut = entries.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const day = usageDay(entries[index])
    if (!day) continue
    if (last === null) last = day
    if (day !== last) break
    cut = index
  }
  return last === null ? entries.length : cut
}
const LEDGER_READ = 100, HISTORY_LINES = 10, LEDGER_READS = 8
/** One page of history: ledger pages are read until they hold ten whole lines (three reads for a workspace that sends
 *  every hour), and the page ends where a day ends, so no day is split over two pages. */
async function historyPage(cursor: string | undefined, signal: AbortSignal): Promise<{ data: Line[]; nextCursor: string | null }> {
  const entries: LedgerEntry[] = []
  let next = cursor
  for (let read = 1; ; read++) {
    const page = await request<LedgerPage>(`/v1/billing/ledger?limit=${LEDGER_READ}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, { signal })
    entries.push(...page.data)
    if (!page.nextCursor) return { data: historyLines(entries), nextCursor: null }
    next = page.nextCursor
    // A day longer than every read (it never is, at an entry an hour) is shown as far as it was read.
    const cut = wholeDays(entries) || (read >= LEDGER_READS ? entries.length : 0)
    const lines = historyLines(entries.slice(0, cut))
    if (lines.length >= HISTORY_LINES || (cut && read >= LEDGER_READS)) return { data: lines, nextCursor: entries[cut - 1].id }
  }
}
const lineDescription = (line: Line) => <span className="billing-desc" title={`${line.text}${line.expires ? ` · Expires ${line.expires}` : ''}`}>{line.text}{line.expires && <span className="muted"> · Expires {line.expires}</span>}</span>
const lineColumns: Column<Line>[] = [
  { key: 'description', label: 'Description', render: line => <span className="billing-cell">{lineDescription(line)}{line.invoiceUrl && <InvoiceLink href={line.invoiceUrl} label="Invoice" />}</span>, cardRender: line => <span className="billing-desc">{line.text}</span>, card: 'title' },
  { key: 'day', label: 'Date', width: 124, render: line => monthDay(line.day), cardRender: line => <>{monthDay(line.day)}{!line.charged && ' · Not charged'}{line.expires && <> · Expires {line.expires}</>}{line.invoiceUrl && <> · <InvoiceLink href={line.invoiceUrl} label="Invoice" /></>}</>, card: 'line' },
  { key: 'amount', label: 'Amount', width: 104, align: 'right', render: line => line.charged ? <span className="billing-amount" data-sign={line.amount > 0n ? 'in' : undefined}>{usd(line.amount, { sign: true })}</span> : <span className="muted">Not charged</span>, cardRender: line => line.charged ? <span className="billing-amount" data-sign={line.amount > 0n ? 'in' : undefined}>{usd(line.amount, { sign: true })}</span> : null, card: 'aside' },
]
function InvoiceLink({ href, label }: { href: string; label: string }) {
  return <a className="billing-link" href={href} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} aria-hidden="true" /></a>
}
const PaymentLinks = ({ payment: p }: { payment: Payment }) => <>{p.invoiceUrl && <InvoiceLink href={p.invoiceUrl} label="Invoice" />}{p.receiptUrl && <InvoiceLink href={p.receiptUrl} label="Receipt" />}</>
const PaymentStatusBadge = ({ payment: p }: { payment: Payment }) => <StatusBadge status={p.status === 'succeeded' ? 'Paid' : p.status === 'requires_action' ? 'Needs action' : p.status}
  tone={p.status === 'succeeded' ? 'success' : p.status === 'failed' ? 'danger' : ['canceled', 'expired'].includes(p.status) ? 'neutral' : 'warning'} />
const KIND: Record<Payment['kind'], string> = { checkout: 'Top-up · Checkout', saved_card: 'Top-up · saved card', recharge: 'Auto-recharge', setup: 'Card saved' }
const paymentNote = (p: Payment) => p.status === 'failed' && p.failure ? declineText(p.failure.code) : p.card ? cardLabel(p.card) : null
const paymentColumns: Column<Payment>[] = [
  { key: 'kind', label: 'Payment', render: p => <span className="billing-stack"><span>{KIND[p.kind]}</span>{paymentNote(p) && <span className="muted billing-stack__note">{paymentNote(p)}</span>}</span>, cardRender: p => KIND[p.kind], card: 'title' },
  { key: 'at', label: 'Date', width: 124, render: p => date(p.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }), card: 'line' },
  { key: 'amount', label: 'Amount', width: 104, align: 'right', render: p => p.kind === 'setup' ? '—' : centsUsd(p.totalCents ?? p.amountCents), card: 'aside' },
  { key: 'status', label: 'Status', width: 248, render: p => <span className="cluster billing-links"><PaymentStatusBadge payment={p} /><PaymentLinks payment={p} /></span>, card: 'line' },
]
function History() {
  const [view, setView] = useState<'ledger' | 'payments'>('ledger')
  return <section className="billing-section" aria-labelledby="billing-history-title">
    <SectionHeader title={<span id="billing-history-title">History</span>} />
    <Tabs label="History" value={view} onValueChange={value => setView(value as typeof view)} items={[{ value: 'ledger', label: 'Usage and credit' }, { value: 'payments', label: 'Payments' }]} />
    {view === 'ledger' ? <LedgerTable /> : <PaymentsTable />}
  </section>
}
// Line keys are prefixed, so no row shares a React key with a skeleton row (keyed 0–4) and takes over its element, which
// the browser then counts as that row moving.
function LedgerTable() {
  const pagination = useCursorPagination(), cursor = pagination.cursorForPage(pagination.page)
  const query = useApiQuery(['billing-history', cursor ?? null], (_api, signal) => historyPage(cursor, signal), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={lineColumns} rowKey={line => line.key} empty={<EmptyState title="No balance changes yet" />} />
}
function PaymentsTable() {
  const pagination = useCursorPagination(), query = useApiDef(queries.billingPayments(pagination.cursorForPage(pagination.page)), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={paymentColumns} rowKey={p => p.id} empty={<EmptyState title="No payments yet" />} />
}
type PageQuery<T> = { data?: { data: T[]; nextCursor: string | null }; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }
function HistoryList<T>({ query, pagination, columns, rowKey, empty }: { query: PageQuery<T>; pagination: ReturnType<typeof useCursorPagination>; columns: Column<T>[]; rowKey: (row: T) => string; empty: ReactNode }) {
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>
    <DataTable className="billing-table" columns={columns} rows={query.data?.data ?? []} rowKey={rowKey} loading={query.isPending} skeletonRows={5} minRows={5} empty={empty} />
    {query.data && <Pagination page={pagination.page} pageSize={20} count={query.data.data.length} nextCursor={query.data.nextCursor} onPageChange={next => pagination.onPageChange(next, query.data?.nextCursor)} />}
  </>
}

// Add credit: an amount, then how to pay. The saved card is charged now; otherwise Stripe Checkout opens. Above $200
// a second step confirms the amount.
const PRESETS = [2000, 5000, 10_000, 25_000]
/** A radiogroup's keyboard model: one tab stop, and arrows, Home and End select and focus the next choice. */
function radioKeys<T>(values: T[], current: T, select: (value: T) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const index = values.indexOf(current), last = values.length - 1
    const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index >= last ? 0 : index + 1) : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index <= 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    select(values[next])
    event.currentTarget.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus()
  }
}
function AddCredit({ open, onOpenChange, summary: b }: { open: boolean; onOpenChange: (open: boolean) => void; summary: BillingSummary }) {
  const card = b.paymentMethod, toast = useToast(), refresh = useBillingRefresh()
  const [preset, setPreset] = useState<number | 'custom'>(5000)
  const [custom, setCustom] = useState('')
  const [method, setMethod] = useState<'saved_card' | 'checkout'>(card ? 'saved_card' : 'checkout')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [charging, setCharging] = useState<string | null>(null)
  useEffect(() => { if (open) { setConfirming(false); setError(null); setMethod(card ? 'saved_card' : 'checkout') } }, [open, card])
  const amount = preset === 'custom' ? parseDollars(custom) : preset
  const invalid = amount === null || amount < 2000 || amount > 1_000_000
  const charge = usePaymentPoll(charging, payment => {
    setCharging(null); setBusy(false); refresh()
    if (payment?.status === 'succeeded') { toast(added(payment.amountCents), 'success'); onOpenChange(false) }
    else setError(new Error(payment?.failure ? `${declineText(payment.failure.code)}.` : 'The charge didn’t finish. Check Payments in a minute.'))
  })
  async function pay() {
    if (invalid) return
    if (amount! > 20_000 && !confirming) { setConfirming(true); return }
    setBusy(true); setError(null)
    try {
      const result = await billingApi.topUp({ amountCents: amount!, method })
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return }
      if (result.status === 'succeeded' || result.status === 'failed') { setCharging(null); setBusy(false); refresh(); if (result.status === 'succeeded') { toast(added(amount!), 'success'); onOpenChange(false) } else setError(new Error('The card was declined.')); return }
      setCharging(result.attemptId)
    } catch (cause) { setError(cause); setBusy(false) }
  }
  const working = busy || charge.waiting
  return <Dialog open={open} onOpenChange={next => { if (!working) onOpenChange(next) }} title="Add credit" className="billing-add"
    description={`Pays for email at ${usd(priceUc(b.prices.emailPerThousand))} per 1,000 sent or received, plus any tax.`}
    footer={<><Button disabled={working} onClick={() => confirming ? setConfirming(false) : onOpenChange(false)}>{confirming ? 'Back' : 'Cancel'}</Button>
      <Button variant="primary" loading={working} disabled={invalid} onClick={() => void pay()}>{confirming ? `Add ${centsUsd(amount ?? 0)}` : method === 'checkout' ? 'Continue to Stripe' : `Charge ${amount !== null && !invalid ? centsUsd(amount) : ''}`.trim()}</Button></>}>
    {confirming ? <p className="billing-add__confirm">Add <b>{centsUsd(amount ?? 0)}</b> to this workspace’s balance? {method === 'saved_card' && card ? `${cardLabel(card)} is charged now.` : 'You pay in Stripe Checkout, where any tax is added.'}</p> : <>
      <div className="billing-choice" role="radiogroup" aria-label="Amount" onKeyDown={working ? undefined : radioKeys<number | 'custom'>([...PRESETS, 'custom'], preset, setPreset)}>
        {[...PRESETS, 'custom' as const].map(value => <button key={value} type="button" role="radio" aria-checked={preset === value} tabIndex={preset === value ? 0 : -1} className="billing-choice__item" disabled={working} onClick={() => setPreset(value)}>{value === 'custom' ? 'Custom' : centsUsd(value).replace('.00', '')}</button>)}
      </div>
      {preset === 'custom' && <span className="billing-dollars billing-add__custom"><span aria-hidden="true">$</span><Input autoFocus aria-label="Amount in dollars, $20 to $10,000" inputMode="decimal" placeholder="75" value={custom} disabled={working} onChange={event => setCustom(event.target.value)} /></span>}
      {preset === 'custom' && custom && invalid && <p className="ui-field__error" role="alert">Add $20 to $10,000 at a time.</p>}
      <div className="billing-methods" role="radiogroup" aria-label="Pay with" onKeyDown={working ? undefined : radioKeys<typeof method>(card ? ['saved_card', 'checkout'] : ['checkout'], method, setMethod)}>
        {card && <button type="button" role="radio" aria-checked={method === 'saved_card'} tabIndex={method === 'saved_card' ? 0 : -1} className="billing-method" disabled={working} onClick={() => setMethod('saved_card')}><CreditCard size={16} aria-hidden="true" /><span>Charge {cardLabel(card)}</span></button>}
        <button type="button" role="radio" aria-checked={method === 'checkout'} tabIndex={method === 'checkout' ? 0 : -1} className="billing-method" disabled={working} onClick={() => setMethod('checkout')}><ArrowUpRight size={16} aria-hidden="true" /><span>Pay with Stripe Checkout</span></button>
      </div>
    </>}
    <p className="muted billing-add__terms">{TERMS}</p>
    {charge.waiting && <p className="muted" role="status">Charging {card ? cardLabel(card) : 'your card'}…</p>}
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
  </Dialog>
}

/** Polls a payment every 2 seconds for up to a minute, then calls done once with its final state (or undefined). */
function usePaymentPoll(id: string | null, done: (payment: Payment | undefined) => void) {
  const started = useRef(0), finished = useRef<string | null>(null)
  const [expired, setExpired] = useState(false)
  useEffect(() => { started.current = Date.now(); finished.current = null; setExpired(false) }, [id])
  const query = useApiQuery(['billing-payment', id], (_api, signal) => billingApi.payment(id!, signal), { enabled: !!id && !expired, interval: data => final(data) ? false : 2000 })
  useEffect(() => {
    if (!id || finished.current === id) return
    const timedOut = Date.now() - started.current > 60_000
    if (final(query.data) || timedOut || (query.isError && query.error instanceof ApiError && query.error.status === 404)) {
      finished.current = id
      if (timedOut) setExpired(true)
      done(final(query.data) ? query.data : undefined)
    }
  })
  return { waiting: !!id && finished.current !== id, payment: query.data }
}

// Back from Stripe Checkout (?billing=success&attempt=… or ?billing=canceled): say so, wait for the payment to settle,
// then refresh. The query string is cleared so a reload doesn't repeat it.
function useCheckoutReturn() {
  const { search } = useLocation(), navigate = useNavigate(), toast = useToast(), refresh = useBillingRefresh()
  const params = new URLSearchParams(search), outcome = params.get('billing'), attempt = params.get('attempt')
  const [watching, setWatching] = useState<string | null>(null)
  useEffect(() => {
    if (!outcome) return
    if (outcome === 'success' && attempt && /^[\w-]{1,100}$/.test(attempt)) { toast('Payment received.', 'info'); setWatching(attempt) }
    else if (outcome === 'canceled') toast('Checkout canceled.', 'info')
    navigate({ pathname: '/settings', search: '', hash: '#billing' }, { replace: true })
  }, [outcome, attempt, navigate, toast])
  usePaymentPoll(watching, payment => {
    setWatching(null); refresh()
    if (payment?.status === 'succeeded') toast(payment.kind === 'setup' ? 'Card saved.' : added(payment.amountCents), 'success')
    else if (payment) toast(payment.failure ? `${declineText(payment.failure.code)}.` : 'The payment didn’t go through.', 'error')
  })
}
