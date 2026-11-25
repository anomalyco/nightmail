import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router'
import { BadgeCheck, CirclePause, Globe, Link2, Megaphone, Send, ShieldAlert, ShieldCheck, TriangleAlert, UserPlus, ZapOff, type LucideIcon } from 'lucide-react'
import { ErrorState, PageHeader, StatusBadge, Tooltip, type Tone } from '../../components/ui'
import { useTween } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { usd } from '../../data/billing'
import { operatorApi, type Glass, type GlassCount, type GlassEvent, type GlassGrade, type GlassRegion } from '../../data/operator'
import { ago, number, percent, time } from '../../lib/format'
import { DeliverabilityView, useDeliverability } from './deliverability'
import { GLASS_EVENT_HEIGHT, GlassAsOf, GlassBoard, GlassTabs, glassView, StaffOnly, type GlassBoardFill, type GlassFill, type GlassRegionFill, type GlassTileFill } from './skeletons'

// Glass (/glass): a live board of everything going on in Nightmail, for operators only (anyone else gets the app's "Page
// not found", and the API the refusal of an operator path that doesn't exist). The figures are one read
// (api/src/glass.ts) and the activity feed another, each asked for every 5 seconds while the page is visible; the server
// computes each at most once in 5 seconds however many operators watch. The layout is fixed in ./skeletons, so a refresh
// replaces figures in place, and a figure that changes counts to its new value.
const POLL_MS = 5_000
const grades: GlassGrade[] = ['A+', 'A', 'B', 'C', 'D', 'F']
// The lines the Overview's gauges end at (features/overview): 5% bounces, 0.1% complaints.
const BOUNCE_LINE = 0.05, COMPLAINT_LINE = 0.001
// A count that stopped at its cap reads "more than": the + says so on hover or focus.
const count = (c: GlassCount, why: string) => c.atLeast ? <Tooltip content={`More than ${number(c.n)}: ${why}`}><span className="glass-more" tabIndex={0}>{number(c.n)}+</span></Tooltip> : number(c.n)
const share = (part: number, whole: number) => whole > 0 ? part / whole : 0
export const rateText = (rate: number) => rate > 0 && rate < 0.0001 ? percent(rate, 3) : percent(rate)
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
export const since = (at: string | null) => { const text = ago(at); return text === null ? null : text === '0m' ? 'just now' : `${text} ago` }
const zone = (rate: number, line: number): Tone | undefined => rate >= line ? 'danger' : rate >= line / 2 ? 'warning' : undefined
const health: Record<Glass['system']['status'], [string, Tone]> = { ok: ['OK', 'success'], warning: ['Warning', 'warning'], critical: ['Critical', 'danger'], stale: ['Not measured', 'danger'] }
const empty = (shown: boolean, text: string): GlassFill => ({ label: shown ? text : '', value: '', empty: true })
const sum = (values: readonly number[]) => values.reduce((total, n) => total + n, 0)
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`

/** A figure that counts from its last value to its new one; the box is the tile's, so its width never moves anything. */
export function Tick({ value, format = n => number(Math.round(n)) }: { value: number; format?: (n: number) => ReactNode }) {
  return <>{format(useTween(value, 600))}</>
}
/** The change from the 24 hours before: + or − and a percentage (a rate: percentage points), in the colour of how it went. */
/** The words a change's title puts after its two figures. */
export type Periods = readonly [current: string, previous: string]
const DAY: Periods = ['in the last 24 hours', 'in the 24 before']
export function delta(last: number, previous: number, good: 'up' | 'down' | null, what: string, periods: Periods = DAY): GlassTileFill['delta'] {
  if (!last && !previous) return undefined
  const title = `${number(last)} ${periods[0]}, ${number(previous)} ${periods[1]}`
  if (!previous) return { text: 'new', tone: good === 'up' ? 'success' : good === 'down' ? 'danger' : 'neutral', title: `${what}: ${title}` }
  const change = (last - previous) / previous, flat = Math.abs(change) < 0.005
  return { text: flat ? '±0%' : `${change > 0 ? '+' : '−'}${percent(Math.abs(change), Math.abs(change) < 0.1 ? 1 : 0)}`, title: `${what}: ${title}`,
    tone: flat || !good ? 'neutral' : (change > 0) === (good === 'up') ? 'success' : 'danger' }
}
export function points(last: number, previous: number, good: 'up' | 'down', what: string, hadMail: boolean, periods: Periods = DAY): GlassTileFill['delta'] {
  if (!hadMail) return undefined
  const change = (last - previous) * 100, flat = Math.abs(change) < 0.005
  return { text: flat ? '±0 pt' : `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(Math.abs(change) < 1 ? 2 : 1)} pt`, title: `${what}: ${rateText(last)} ${periods[0]}, ${rateText(previous)} ${periods[1]}`,
    tone: flat ? 'neutral' : (change > 0) === (good === 'up') ? 'success' : 'danger' }
}

function tiles(g: Glass): (key: string) => GlassTileFill {
  const { signups, sending: s, delivery, receiving, builtin, support, screening, api, system, visitors } = g
  const day = s.hourly.reduce((t, h) => ({ accepted: t.accepted + h.accepted, delivered: t.delivered + h.delivered, bounced: t.bounced + h.bounced, complained: t.complained + h.complained }), { accepted: 0, delivered: 0, bounced: 0, complained: 0 })
  const before = s.previous, rate = (part: number, whole: number) => share(part, whole)
  const delivered = rate(day.delivered, day.accepted), bounced = rate(day.bounced, day.accepted), complained = rate(day.complained, day.accepted)
  const requests = sum(api.hourly.map(h => h.requests)), refused = sum(api.hourly.map(h => h.errors4xx)), failed = sum(api.hourly.map(h => h.errors5xx))
  const failedRate = rate(failed, requests), alerts = system.alerts.critical + system.alerts.warning, tripped = builtin.parent?.trippedAt && (!builtin.parent.resetAt || builtin.parent.resetAt < builtin.parent.trippedAt)
  const steps = delivery.steps, places = signups.places, ms = (n: number | null) => n === null ? '—' : `≤ ${number(n)} ms`
  const pct = (digits: number) => (n: number) => percent(n, digits)
  const rows: Record<string, GlassTileFill> = {
    sent: { value: <Tick value={day.accepted} />, hint: `${percent(share(sum(s.hourly.map(h => h.marketing)), day.accepted), 0)} marketing · ${compact(s.today.transactional + s.today.marketing)} today`, spark: s.hourly.map(h => h.accepted), delta: delta(day.accepted, before.accepted, null, 'Accepted') },
    minute: { value: <Tick value={s.perMinute} />, hint: `≈ ${(s.perMinute / 60).toFixed(s.perMinute < 600 ? 1 : 0)}/s · hour’s peak ${number(Math.max(0, ...s.minutes))}`, spark: s.minutes },
    delivered: { value: day.accepted ? <Tick value={delivered} format={pct(1)} /> : '—', hint: `${number(day.delivered)} delivered`, spark: s.hourly.map(h => h.delivered),
      delta: points(delivered, rate(before.delivered, before.accepted), 'up', 'Delivered', day.accepted > 0 && before.accepted > 0) },
    bounced: { value: day.accepted ? <Tick value={bounced} format={rateText} /> : '—', tone: zone(bounced, BOUNCE_LINE), hint: `${number(day.bounced)} · line at ${percent(BOUNCE_LINE, 0)}`, spark: s.hourly.map(h => h.bounced),
      delta: points(bounced, rate(before.bounced, before.accepted), 'down', 'Bounced', day.accepted > 0 && before.accepted > 0) },
    complained: { value: day.accepted ? <Tick value={complained} format={rateText} /> : '—', tone: zone(complained, COMPLAINT_LINE), hint: `${number(day.complained)} · line at ${percent(COMPLAINT_LINE, 1)}`, spark: s.hourly.map(h => h.complained),
      delta: points(complained, rate(before.complained, before.accepted), 'down', 'Complained', day.accepted > 0 && before.accepted > 0) },
    signups: { value: <Tick value={signups.day.last} />, hint: `${number(signups.today.open + signups.today.waitlist)} today · ${number(signups.week.open + signups.week.waitlist)} in 7 d`, spark: signups.hourly, delta: delta(signups.day.last, signups.day.previous, 'up', 'Sign-ups') },
    places: { value: <Tick value={places.open} />, hint: `of ${number(places.limit)} · ${number(places.waiting)} waiting${places.held ? ` · ${number(places.held)} held` : ''}`,
      meter: { value: places.signedUp, max: Math.max(1, places.limit), tone: places.open ? 'neutral' : 'warning', label: `${number(places.signedUp)} of ${number(places.limit)} places taken` } },
    received: { value: receiving.atLeast ? count({ n: receiving.day.last, atLeast: true }, 'counting stops at 10,000 a workspace') : <Tick value={receiving.day.last} />, hint: `${plural(receiving.spam, 'spam-flagged', 'spam-flagged')} today`, spark: receiving.hourly, delta: delta(receiving.day.last, receiving.day.previous, null, 'Received') },
    queued: { value: s.queued.atLeast ? count(s.queued, 'counting stops there') : <Tick value={s.queued.n} />, hint: s.held.n ? `${number(s.held.n)}${s.held.atLeast ? '+' : ''} held for screening` : 'none held for screening' },
    ramp: { value: <Tick value={delivery.ramping} />, hint: delivery.rampWaiting ? `${number(delivery.rampWaiting)} waiting for a step` : 'campaigns sent in steps' },
    standing: { value: <Tick value={delivery.paused} />, tone: delivery.paused ? 'danger' : undefined, hint: `${number(steps.notice + steps.warn + steps.restrict)} on notice · ${number(delivery.held)} held`,
      parts: [{ value: steps.ok, tone: 'success', label: 'OK' }, { value: steps.notice, tone: 'info', label: 'Notice' }, { value: steps.warn, tone: 'warning', label: 'Warn' }, { value: steps.restrict, tone: 'warning', label: 'Restrict' }, { value: steps.pause, tone: 'danger', label: 'Pause' }] },
    builtin: { value: <Tick value={builtin.ready} />, tone: tripped || builtin.parent?.ok === false ? 'danger' : undefined,
      hint: tripped ? `breaker tripped ${since(builtin.parent!.trippedAt)}` : builtin.parent && !builtin.parent.ok ? `parent down: ${builtin.parent.problem ?? 'unknown'}` : `of ${number(builtin.active)} · breaker closed`,
      meter: { value: builtin.ready, max: Math.max(1, builtin.active), tone: tripped ? 'danger' : 'neutral', label: `${number(builtin.ready)} of ${number(builtin.active)} built-in domains ready` } },
    visitors: { value: visitors.visitors.atLeast ? count(visitors.visitors, 'told apart among the first 50,000 visitor codes') : <Tick value={visitors.visitors.n} />, hint: `${number(visitors.views)} page views today`, spark: visitors.hourly, delta: delta(visitors.day.last, visitors.day.previous, 'up', 'Page views') },
    // A support channel that isn't set up is said here (its registrations answer 404 SUPPORT_NOT_CONFIGURED).
    support: { value: <Tick value={support.open} />, tone: support.configured.chat && support.configured.email ? undefined : 'warning',
      hint: !support.configured.chat && !support.configured.email ? 'Support not configured' : !support.configured.email ? `${number(support.day.last)} new · email not configured`
        : !support.configured.chat ? `${number(support.day.last)} new · chat not configured` : `${number(support.day.last)} new · ${number(support.ticketed)} ticketed`, spark: support.hourly, delta: delta(support.day.last, support.day.previous, null, 'New conversations') },
    screened: { value: <Tick value={screening.screened} />, hint: `${number(screening.rejected)} rejected`, spark: screening.hourly },
    classifiers: { value: screening.agree === null ? '—' : <Tick value={screening.agree} format={pct(1)} />, hint: `flagged: Jev ${number(screening.jevFlagged)} · JevF ${number(screening.jevfFlagged)}`,
      meter: { value: screening.agree ?? 0, max: 1, tone: screening.agree !== null && screening.agree < 0.95 ? 'warning' : 'neutral', label: 'Verdicts both classifiers agree on' } },
    api: { value: <Tick value={requests} />, hint: `${requests ? percent(share(refused, requests), 1) : '0%'} refused (4xx)`, spark: api.hourly.map(h => h.requests), delta: delta(requests, api.previous.requests, null, 'Requests') },
    errors: { value: requests ? <Tick value={failedRate} format={rateText} /> : '—', tone: failedRate >= 0.01 ? 'danger' : failed ? 'warning' : undefined, hint: `${number(failed)} failed (5xx)`, spark: api.hourly.map(h => h.errors5xx),
      delta: points(failedRate, share(api.previous.errors5xx, api.previous.requests), 'down', 'Failed', requests > 0 && api.previous.requests > 0) },
    latency: { value: ms(api.p50Ms), hint: `p50 · p95 ${ms(api.p95Ms)} · 15 min`, tone: api.p95Ms !== null && api.p95Ms > 2_500 ? 'warning' : undefined },
    health: { value: health[system.status][0], tone: health[system.status][1], hint: alerts ? plural(alerts, 'open alert') : system.measuredAt ? `measured ${since(system.measuredAt)}` : 'never measured' },
  }
  return key => rows[key] ?? { value: '—' }
}

const regionFill = (r: GlassRegion): GlassRegionFill => {
  const used = r.max24HourSend ? share(r.sentLast24Hours ?? 0, r.max24HourSend) : 0
  return { region: r.region, place: r.place === r.region ? '' : r.place,
    sending: <span className={`glass-state ui-tone--${r.sending ? 'success' : 'neutral'}`}>{r.sending ? 'Sending' : 'Off'}</span>,
    receiving: <span className={`glass-state ui-tone--${r.receiving ? 'success' : 'neutral'}`}>{r.receiving ? 'Receiving' : 'Off'}</span>,
    rate: r.maxSendRate === null ? '—' : `${number(r.maxSendRate)}/s`,
    quota: r.max24HourSend === null ? 'Not sampled yet' : `${compact(r.sentLast24Hours ?? 0)} of ${compact(r.max24HourSend)}`, share: r.max24HourSend === null ? '' : percent(used, used && used < 0.01 ? 2 : 0),
    meter: { value: r.sentLast24Hours ?? 0, max: Math.max(1, r.max24HourSend ?? 1), tone: used >= 0.8 ? 'danger' : used >= 0.5 ? 'warning' : 'neutral', label: `${r.region}: sent in 24 hours of its quota` },
    checked: r.checkedAt ? since(r.checkedAt) : 'never' }
}

function board(g: Glass): GlassBoardFill {
  const { signups, sending: s, delivery, builtin, money, screening, system, visitors } = g
  const f = signups.funnel, ses = system.ses, used = share(ses.total.sentLast24Hours, ses.total.max24HourSend)
  const rows: Record<string, Record<string, GlassFill>> = {
    sending: {
      transactional: { hint: 'today', spark: s.hourly.map(h => h.accepted - h.marketing), value: number(s.today.transactional) },
      marketing: { hint: 'today', spark: s.hourly.map(h => h.marketing), value: number(s.today.marketing) },
      held: { value: count(s.held, 'counting stops there'), tone: s.held.n ? 'warning' : undefined },
      api: s.sendApi ? { hint: `p95 ≤ ${number(s.sendApi.p95Ms)}`, value: `≤ ${number(s.sendApi.p50Ms)}`, unit: 'ms' } : { hint: 'idle', value: '—' },
      ...Object.fromEntries([0, 1].map(i => { const c = s.campaigns[i]; return [`campaign:${i}`, c ? { label: c.name, hint: c.workspace, value: percent(share(c.released, c.total), 0),
        meter: { value: c.released, max: Math.max(1, c.total), label: `${c.name}: ${number(c.released)} of ${number(c.total)} released` } } : empty(i === 0, 'No campaign sending')] })),
    },
    standing: {
      grades: { value: null, cells: [...grades.map(grade => number(delivery.grades[grade])), number(delivery.calibrating)] },
      steps: { value: null, cells: [delivery.steps.ok, delivery.steps.notice, delivery.steps.warn, delivery.steps.restrict, delivery.steps.pause].map(number) },
      paused: { value: number(delivery.paused), tone: delivery.paused ? 'danger' : undefined },
      held: { value: number(delivery.held), tone: delivery.held ? 'warning' : undefined },
      revoked: { value: number(builtin.revoked) },
      parent: builtin.parent ? { hint: builtin.parent.name, value: <StatusBadge status={builtin.parent.ok ? 'OK' : 'Down'} tone={builtin.parent.ok ? 'success' : 'danger'} /> } : { hint: 'none', value: '—' },
    },
    system: {
      health: { hint: system.measuredAt ? `measured ${since(system.measuredAt)}` : 'never measured', value: <StatusBadge status={health[system.status][0]} tone={health[system.status][1]} /> },
      ...Object.fromEntries([0, 1, 2].map(i => { const a = system.alerts.top[i]; return [`alert:${i}`, a ? { label: a.label, hint: a.words, value: ago(a.since), tone: a.severity === 'critical' ? 'danger' : 'warning' } : empty(i === 0, 'No open alerts')] })),
      deploy: { hint: system.deploy.at ? since(system.deploy.at) : undefined, value: system.deploy.sha?.slice(0, 7) ?? '—' },
      classifiers: { hint: `Jev · JevF, of ${number(screening.compared.n)}${screening.compared.atLeast ? '+' : ''} in 24 h`, value: `${number(screening.jevFailed)} · ${number(screening.jevfFailed)}`, tone: screening.jevFailed + screening.jevfFailed ? 'warning' : undefined },
    },
    money: {
      creditToday: { value: usd(money.creditToday) },
      creditMonth: { spark: money.creditDaily, value: usd(money.creditMonth) },
      owed: { hint: money.owing ? plural(money.owing, 'workspace') : undefined, value: usd(money.owed), tone: BigInt(money.owed) > 0n ? 'warning' : undefined },
      usage: { value: usd(money.usageMonth) },
    },
    visitors: {
      views: { hint: visitors.through ? `through ${time(visitors.through).slice(0, 5)} UTC` : undefined, spark: visitors.hourly, value: number(visitors.views) },
      ...Object.fromEntries([0, 1, 2].map(i => { const r = visitors.referrers[i]; return [`referrer:${i}`, r ? { label: r.host, value: number(r.views) } : empty(i === 0, 'No referrers yet')] })),
    },
  }
  return {
    tile: tiles(g),
    funnel: key => { const n = f[key as keyof typeof f]; return { value: <Tick value={n} />, share: key === 'signedUp' || !f.signedUp ? undefined : percent(share(n, f.signedUp), 0), meter: { value: n, max: Math.max(1, f.signedUp) } } },
    regions: ses.regions.map(regionFill),
    total: { region: 'Total', place: plural(ses.regions.filter(r => r.sending).length, 'sending region'), sending: '', receiving: '', rate: `${number(ses.total.maxSendRate)}/s`,
      quota: `${compact(ses.total.sentLast24Hours)} of ${compact(ses.total.max24HourSend)}`, share: ses.total.max24HourSend ? percent(used, used && used < 0.01 ? 2 : 0) : '',
      meter: { value: ses.total.sentLast24Hours, max: Math.max(1, ses.total.max24HourSend), tone: used >= 0.8 ? 'danger' : used >= 0.5 ? 'warning' : 'neutral', label: 'All regions: sent in 24 hours of the quota' }, checked: '' },
    row: (group, row) => rows[group]?.[row] ?? { value: '—' },
  }
}

// The activity feed. Each event once, by its ID, newest first; a row is placed by a transform, so a new event slides the
// others down (and the last off the end) without a layout shift. Events that arrive after the first read fade in.
const FEED = 50
const methods: Record<string, string> = { google: 'Google', github: 'GitHub', email: 'Email link', password: 'Password' }
const icons: Record<GlassEvent['kind'], LucideIcon> = { signup: UserPlus, first_send: Send, domain_verified: BadgeCheck, builtin_ready: Globe, campaign_launched: Megaphone, campaign_paused: CirclePause,
  standing: ShieldAlert, breaker: ZapOff, alert: TriangleAlert, link_fallback: Link2 }
const stepNames: Record<string, string> = { ok: 'back to OK', notice: 'on notice', warn: 'warned', restrict: 'restricted', pause: 'paused' }
function eventText(e: GlassEvent): [ReactNode, ReactNode] {
  const who = <b>{e.workspace?.name ?? 'A new account'}</b>
  switch (e.kind) {
    // Before it has a workspace, a sign-up is its address (blurred with the dashboard's toggle).
    case 'signup': { const how = [methods[e.detail ?? ''], e.place === 'waitlist' ? 'from the waitlist' : 'open place'].filter(Boolean).join(' · ')
      return e.workspace || !e.email ? [<>{who} signed up</>, <>{how}{e.email && <> · <PrivateAddress value={e.email} /></>}</>] : [<><b><PrivateAddress value={e.email} /></b> signed up</>, how] }
    case 'first_send': return [<>{who} sent its first email</>, 'First send']
    case 'domain_verified': return [<>{who} verified a domain</>, e.subject]
    case 'builtin_ready': return [<>{who}’s built-in domain is ready</>, e.subject]
    case 'campaign_launched': return [<>{who} launched a campaign</>, [e.subject, e.detail && plural(Number(e.detail), 'recipient')].filter(Boolean).join(' · ')]
    case 'campaign_paused': return [<>{who}’s campaign paused</>, [e.subject, e.detail].filter(Boolean).join(' · ')]
    case 'standing': { const [from, to] = (e.detail ?? '').split('>'); return [<>{who} {stepNames[to ?? ''] ?? to}</>, [`was ${from === 'ok' ? 'OK' : stepNames[from ?? '']?.replace('back to ', '') ?? from}`, e.subject].filter(Boolean).join(' · ')] }
    case 'breaker': return [<><b>Built-in domains</b> stopped</>, `${e.subject} breaker tripped`]
    case 'alert': return [<b>{e.subject}</b>, e.detail]
    case 'link_fallback': return [<>{who} linked on the link domain</>, [e.subject, e.detail && `${plural(Number(e.detail), 'recipient')} today`].filter(Boolean).join(' · ')]
  }
}
const order = (a: GlassEvent, b: GlassEvent) => a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0
function useActivity(enabled: boolean) {
  const [state, setState] = useState<{ events: GlassEvent[]; fresh: Set<string> }>()
  const newest = useRef<string>(undefined)
  const query = useQuery({ queryKey: ['operator', 'glass', 'activity'], queryFn: ({ signal }) => operatorApi.glassActivity(newest.current, signal), staleTime: 0, gcTime: 0, enabled,
    refetchInterval: current => refused(current.state.error) ? false : POLL_MS, refetchIntervalInBackground: false })
  useEffect(() => {
    if (!query.data) return
    setState(previous => {
      const known = new Map((previous?.events ?? []).map(e => [e.id, e]))
      const added = query.data.events.filter(e => !known.has(e.id))
      if (previous && !added.length) return previous
      const events = [...added, ...(previous?.events ?? [])].sort(order).slice(0, FEED)
      newest.current = events[0]?.at ?? newest.current
      return { events, fresh: previous ? new Set(added.map(e => e.id)) : new Set() }
    })
  }, [query.data])
  return { events: state?.events, fresh: state?.fresh ?? new Set<string>(), error: query.error }
}
function Feed({ events, fresh }: { events: GlassEvent[]; fresh: Set<string> }) {
  if (!events.length) return <p className="glass-feed__empty">Nothing has happened yet.</p>
  return <ol className="glass-feed__rows" style={{ height: events.length * GLASS_EVENT_HEIGHT }}>{events.map((e, i) => {
    const Icon = e.kind === 'standing' && e.tone === 'success' ? ShieldCheck : icons[e.kind], [title, detail] = eventText(e), when = ago(e.at)
    const body = <><span className={`glass-event__icon ui-tone--${e.tone}`}><Icon size={14} aria-hidden="true" /></span>
      <span className="glass-event__text"><span className="glass-event__title">{title}</span><span className="glass-event__detail">{detail}</span></span>
      <time className="glass-event__time" dateTime={e.at} title={`${time(e.at)} UTC`}>{when === '0m' ? 'now' : when}</time></>
    return <li key={e.id} className="glass-event" data-fresh={fresh.has(e.id) || undefined} style={{ transform: `translateY(${i * GLASS_EVENT_HEIGHT}px)` }}>
      {e.workspace ? <Link className="glass-event__link" to={`/operator/workspaces/${e.workspace.id}`}>{body}</Link> : <span className="glass-event__link">{body}</span>}</li>
  })}</ol>
}

const refused = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403)
export function GlassPage() {
  const operator = useSession()?.identity?.operator
  return operator ? <GlassView /> : <StaffOnly />
}
function GlassView() {
  const { search } = useLocation(), navigate = useNavigate(), view = glassView(search)
  // A failed refresh (the app retries nothing) keeps the last figures and tries again in 5 s; only a refusal stops it.
  // The live reads run while the live board is shown; the Deliverability board has its own (./deliverability).
  const query = useQuery({ queryKey: ['operator', 'glass'], queryFn: ({ signal }) => operatorApi.glass(signal), staleTime: POLL_MS - 1_000, enabled: view === 'live',
    refetchInterval: current => refused(current.state.error) ? false : POLL_MS, refetchIntervalInBackground: false })
  const activity = useActivity(view === 'live'), glass = query.data
  const deliverability = useDeliverability(view === 'deliverability'), dlv = deliverability.data
  const stalled = query.isError || Boolean(activity.error)
  const asOf = view === 'live' ? <GlassAsOf at={glass && <span title={stalled ? 'The last refresh failed: trying again' : 'Refreshed every 5 seconds'}>{time(glass.generatedAt)} UTC</span>} state={stalled ? 'stalled' : 'live'} />
    : <GlassAsOf at={dlv && <span title="Refreshed every minute">{time(dlv.generatedAt)} UTC</span>} state={deliverability.isError ? 'stalled' : 'live'} />
  return <>
    <PageHeader title="Glass" actions={asOf} />
    <GlassTabs value={view} onValueChange={next => navigate(next === 'live' ? '/glass' : '/glass?view=deliverability')} />
    {view === 'deliverability' ? <DeliverabilityView />
      : query.isError && !glass ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      : <GlassBoard fill={glass && board(glass)} feed={activity.events && <Feed events={activity.events} fresh={activity.fresh} />} />}
  </>
}
