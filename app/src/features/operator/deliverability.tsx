import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { ErrorState, StatusBadge, type Tone } from '../../components/ui'
import { operatorApi, type Deliverability, type DeliverabilityCounts, type MailProvider, type VdmCounts } from '../../data/operator'
import { date, number, percent } from '../../lib/format'
import { DELIVERABILITY_WINDOWS, DeliverabilityBoard, DeliverabilityControls, deliverabilitySettings, GLASS_REGION_SLOTS, type DeliverabilityFill, type DeliverabilityRow, type DeliverabilityStream, type GlassFill, type GlassTileFill } from './skeletons'
import { delta, points, rateText, since, Tick, type Periods } from './glass'

// Glass's Deliverability board (/glass?view=deliverability): is the platform's mail getting into mailboxes, opened and
// clicked, by mailbox provider, for a period beside the one before. One read a period (api/src/glass-deliverability.ts),
// again every minute; the page filters it by stream and region itself, so a filter answers at once and moves nothing.
const REFRESH_MS = 60_000
const providers: MailProvider[] = ['gmail', 'microsoft', 'yahoo', 'apple', 'proton', 'gmx', 'other']
const providerNames: Record<MailProvider | 'all', string> = { all: 'All ISPs', gmail: 'Gmail', microsoft: 'Microsoft', yahoo: 'Yahoo · AOL', apple: 'Apple iCloud', proton: 'Proton', gmx: 'GMX · Web.de', other: 'Other' }
const grades = ['A+', 'A', 'B', 'C', 'D', 'F'] as const
// The lines deliverability.ts THRESHOLDS publishes: hard bounces 2% and 5%, complaints 0.1% (Gmail) and 0.3% (enforced).
const HARD = [0.02, 0.05] as const, COMPLAINT = [0.001, 0.003] as const
const zero = (): DeliverabilityCounts => ({ accepted: 0, delivered: 0, hardBounced: 0, softBounced: 0, deferred: 0, complained: 0, opened: 0, humanOpened: 0, clicked: 0 })
const add = (into: DeliverabilityCounts, from: DeliverabilityCounts) => { for (const k of Object.keys(into) as (keyof DeliverabilityCounts)[]) into[k] += from[k]; return into }
const ratio = (part: number, whole: number) => whole > 0 ? part / whole : null
const pct = (value: number | null) => value === null ? '—' : rateText(value)
const zone = (value: number | null, [warn, bad]: readonly [number, number]): Tone | undefined => value === null ? undefined : value >= bad ? 'danger' : value >= warn ? 'warning' : undefined
const empty = (shown: boolean, text: string): GlassFill => ({ label: shown ? text : '', value: '', empty: true })

function fill(d: Deliverability, stream: DeliverabilityStream, region: string): DeliverabilityFill {
  const window = DELIVERABILITY_WINDOWS.find(w => w.value === d.window)!, periods: Periods = [`in the last ${window.label}`, window.before]
  const picked = (kind: string, r: string) => (stream === 'all' || kind === stream) && (region === 'all' || r === region)
  const rows = d.cube.filter(c => picked(c.kind, c.region))
  const now = rows.reduce((t, c) => add(t, c.current), zero()), before = rows.reduce((t, c) => add(t, c.previous), zero())
  // Every bucket of the period, oldest first, so a quiet hour is a zero and not a gap.
  const step = d.unit === 'hour' ? 3_600_000 : 86_400_000, first = d.unit === 'hour' ? Date.parse(d.since) : Date.parse(d.since.slice(0, 10)), buckets: DeliverabilityCounts[] = []
  for (let at = first; at < Date.parse(d.until); at += step) buckets.push(zero())
  for (const s of d.series) if (picked(s.kind, s.region)) { const i = Math.floor((Date.parse(s.at) - first) / step); if (buckets[i]) add(buckets[i], s) }
  const series = (part: (c: DeliverabilityCounts) => number, whole: (c: DeliverabilityCounts) => number) => buckets.map(c => ratio(part(c), whole(c)) ?? 0)
  const had = now.accepted > 0 && before.accepted > 0, engaged = now.delivered > 0 && before.delivered > 0
  const rate = (n: DeliverabilityCounts, key: keyof DeliverabilityCounts, of: keyof DeliverabilityCounts = 'accepted') => ratio(n[key], n[of])
  const tile = (key: keyof DeliverabilityCounts, good: 'up' | 'down', what: string, of: keyof DeliverabilityCounts = 'accepted', lines?: readonly [number, number]): GlassTileFill => {
    const value = rate(now, key, of)
    return { value: value === null ? '—' : <Tick value={value} format={rateText} />, tone: lines ? zone(value, lines) : undefined, spark: series(c => c[key], c => c[of]),
      hint: `${number(now[key])} of ${number(now[of])} ${of}`, delta: points(value ?? 0, rate(before, key, of) ?? 0, good, what, of === 'accepted' ? had : engaged, periods) }
  }
  const spam = d.postmaster.map(p => p.spamRatio.current).filter((n): n is number => n !== null), gmailSpam = spam.length ? spam.reduce((a, b) => a + b, 0) / spam.length : null
  const tiles: Record<string, GlassTileFill> = {
    accepted: { value: <Tick value={now.accepted} />, hint: `${number(before.accepted)} ${window.before}`, spark: buckets.map(c => c.accepted), delta: delta(now.accepted, before.accepted, null, 'Accepted', periods) },
    delivered: tile('delivered', 'up', 'Delivered'),
    hard: tile('hardBounced', 'down', 'Hard bounces', 'accepted', HARD),
    soft: tile('softBounced', 'down', 'Soft bounces'),
    deferred: tile('deferred', 'down', 'Deferred'),
    // Gmail sends no complaints back; Postmaster's spam rate (when connected) stands in for them.
    complained: { ...tile('complained', 'down', 'Complaints', 'accepted', COMPLAINT), hint: gmailSpam === null ? `${number(now.complained)} · Gmail reports none here` : `${number(now.complained)} · Gmail ${rateText(gmailSpam)} (Postmaster)` },
    human: tile('humanOpened', 'up', 'Opened by people', 'delivered'),
    clicked: tile('clicked', 'up', 'Clicked', 'delivered'),
  }

  // Providers, worst first: the lowest delivered share of what was accepted, then the most complaints; none at the end.
  const by = new Map(providers.map(p => [p, { now: zero(), before: zero() }]))
  for (const c of rows) { const e = by.get(c.provider)!; add(e.now, c.current); add(e.before, c.previous) }
  const order = [...by].sort(([a, x], [b, y]) => (x.now.accepted ? 0 : 1) - (y.now.accepted ? 0 : 1)
    || (rate(x.now, 'delivered') ?? 1) - (rate(y.now, 'delivered') ?? 1) || (rate(y.now, 'complained') ?? 0) - (rate(x.now, 'complained') ?? 0) || providers.indexOf(a) - providers.indexOf(b))
  const providerRows: DeliverabilityRow[] = order.map(([p, { now: n, before: b }]) => {
    const delivered = rate(n, 'delivered'), was = rate(b, 'delivered'), change = delivered !== null && was !== null ? (delivered - was) * 100 : null
    const hard = rate(n, 'hardBounced'), complained = rate(n, 'complained')
    return { empty: !n.accepted, cells: [providerNames[p], number(n.accepted), pct(delivered), change === null ? '—' : `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(Math.abs(change) < 1 ? 2 : 1)} pt`,
      pct(hard), pct(rate(n, 'softBounced')), pct(rate(n, 'deferred')), pct(complained), pct(rate(n, 'humanOpened', 'delivered')),
      pct(n.delivered ? (n.opened - n.humanOpened) / n.delivered : null), pct(rate(n, 'clicked', 'delivered'))],
      tones: [undefined, undefined, undefined, change === null || Math.abs(change) < 0.005 ? undefined : change > 0 ? 'success' : 'danger', zone(hard, HARD), undefined, undefined, zone(complained, COMPLAINT)] }
  })

  const regions = d.regions.filter(r => region === 'all' || r.region === region)
  const health: Record<string, [string, Tone]> = { HEALTHY: ['Healthy', 'success'], PROBATION: ['Probation', 'warning'], SHUTDOWN: ['Shutdown', 'danger'] }
  const pool = d.regions.slice(0, GLASS_REGION_SLOTS)
  const groupRows: Record<string, Record<string, GlassFill>> = {
    engagement: {
      opened: { hint: 'all opens', spark: series(c => c.opened, c => c.delivered), value: pct(rate(now, 'opened', 'delivered')) },
      human: { hint: 'not flagged as a bot or proxy', spark: series(c => c.humanOpened, c => c.delivered), value: pct(rate(now, 'humanOpened', 'delivered')) },
      machine: { hint: 'Apple MPP, scanners', value: pct(now.delivered ? (now.opened - now.humanOpened) / now.delivered : null) },
      clicked: { spark: series(c => c.clicked, c => c.delivered), value: pct(rate(now, 'clicked', 'delivered')) },
      cto: { hint: 'of people who opened', value: pct(rate(now, 'clicked', 'humanOpened')) },
    },
    ses: Object.fromEntries(Array.from({ length: GLASS_REGION_SLOTS }, (_, i) => {
      const r = pool[i]
      if (!r) return [`region:${i}`, empty(i === 0, 'No pool region')]
      const [words, tone] = r.ses.status === 'error' ? ['Unreadable', 'danger' as Tone] : health[r.ses.enforcement ?? ''] ?? ['Not checked', 'neutral' as Tone]
      const parts = [r.place, r.ses.status === 'error' ? r.ses.error : [r.ses.sendingEnabled === false ? 'sending off' : null, r.ses.vdm ? 'VDM on' : r.ses.vdm === false ? 'VDM off' : null].filter(Boolean).join(' · '), r.ses.checkedAt && `checked ${since(r.ses.checkedAt)}`]
      return [`region:${i}`, { label: r.region, hint: parts.filter(Boolean).join(' · '), value: <StatusBadge status={words} tone={tone} /> }]
    })),
    domains: {
      ...Object.fromEntries([0, 1].map(i => { const b = d.blocklist[i]; return [`dbl:${i}`, b ? { label: b.domain, hint: `Spamhaus DBL${b.checkedAt ? ` · checked ${since(b.checkedAt)}` : ''}`,
        value: b.status === 'listed' ? <StatusBadge status="Listed" tone="danger" /> : b.status === 'clear' ? <StatusBadge status="Clear" tone="success" /> : b.status === 'unconfigured' ? 'No DQS key' : b.status === 'unknown' ? 'Unknown' : '—',
        tone: b.status === 'unconfigured' || b.status === 'unknown' ? 'warning' : undefined } : empty(false, '')] })),
      // Gmail Postmaster Tools: Google's reputation for the domain and its users' spam reports (Gmail's complaints).
      ...Object.fromEntries([0, 1].map(i => {
        const p = d.postmaster[i], key = `postmaster:${i}`
        if (!p) return [key, empty(false, '')]
        const open = <a className="glass-link" href={p.url} target="_blank" rel="noreferrer">Open <ArrowUpRight size={14} aria-hidden="true" /></a>
        // Postmaster v2 has no reputation: Gmail's spam rate for the period is the figure, DMARC's pass rate beside it.
        if (p.latest) { const spam = p.spamRatio.current ?? p.latest.spamRatio
          return [key, { label: p.domain, hint: `Gmail spam rate${p.latest.dmarc === null ? '' : ` · DMARC ${pct(p.latest.dmarc)}`} · ${date(p.latest.day, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`,
            value: pct(spam), tone: zone(spam, COMPLAINT) }] }
        return [key, { label: p.domain, hint: p.status === 'error' ? `Gmail Postmaster · ${p.error}` : p.status === 'ok' ? 'Gmail Postmaster · no day with enough mail yet' : 'Gmail Postmaster · not connected', value: open }]
      })),
    },
    standing: {
      grades: { value: null, cells: [...grades.map(g => number(d.standing.grades[g])), number(d.standing.calibrating)] },
      steps: { value: null, cells: [d.standing.steps.ok, d.standing.steps.notice, d.standing.steps.warn, d.standing.steps.restrict, d.standing.steps.pause].map(number) },
    },
    complaints: Object.fromEntries(Array.from({ length: 10 }, (_, i) => { const w = d.top.complaints[i]; return [`ws:${i}`, w ? { label: <Link className="glass-ws" to={`/operator/workspaces/${w.workspaceId}`}>{w.workspaceId}</Link>,
      hint: `${pct(ratio(w.complained, w.accepted))} of ${number(w.accepted)}`, value: number(w.complained), tone: zone(ratio(w.complained, w.accepted), COMPLAINT) } : empty(i === 0, 'No complaints')] })),
    bounces: Object.fromEntries(Array.from({ length: 10 }, (_, i) => { const w = d.top.bounces[i]; return [`ws:${i}`, w ? { label: <Link className="glass-ws" to={`/operator/workspaces/${w.workspaceId}`}>{w.workspaceId}</Link>,
      hint: `${pct(ratio(w.bounced, w.accepted))} of ${number(w.accepted)}`, value: number(w.bounced), tone: zone(ratio(w.bounced, w.accepted), HARD) } : empty(i === 0, 'No bounces')] })),
  }

  // VDM: Amazon's figures for the regions picked, summed; Gmail runs no feedback loop, so its complaints are a dash.
  const vdm = new Map<MailProvider | 'all', VdmCounts>()
  for (const r of regions) for (const p of r.vdm.providers) {
    const into = vdm.get(p.provider) ?? { send: 0, delivery: 0, permanentBounce: 0, transientBounce: 0, complaint: 0, deliveryComplaint: 0, open: 0, deliveryOpen: 0, click: 0, deliveryClick: 0 }
    for (const k of Object.keys(into) as (keyof VdmCounts)[]) into[k] += p.current[k]
    vdm.set(p.provider, into)
  }
  const vdmRows: DeliverabilityRow[] = (['all', 'gmail', 'microsoft', 'yahoo', 'apple', 'other'] as const).map(p => {
    const v = vdm.get(p)
    if (!v) return { empty: true, cells: [providerNames[p], '—', '—', '—', '—', '—', '—', '—'] }
    return { cells: [providerNames[p], number(Math.round(v.send)), pct(ratio(v.delivery, v.send)), pct(ratio(v.permanentBounce, v.send)), pct(ratio(v.transientBounce, v.send)),
      p === 'gmail' ? '—' : pct(ratio(v.complaint, v.deliveryComplaint)), pct(ratio(v.open, v.deliveryOpen)), pct(ratio(v.click, v.deliveryClick))],
      tones: [undefined, undefined, undefined, zone(ratio(v.permanentBounce, v.send), HARD), undefined, p === 'gmail' ? undefined : zone(ratio(v.complaint, v.deliveryComplaint), COMPLAINT)] }
  })
  const vdmWords = (r: Deliverability['regions'][number]) => r.vdm.status === 'ok' ? `${r.region} read ${since(r.vdm.checkedAt) ?? ''}`
    : r.vdm.status === 'disabled' ? `${r.region}: VDM is off` : r.vdm.status === 'error' ? `${r.region}: not readable (${r.vdm.error}); the runtime's IAM user needs ses:BatchGetMetricData` : `${r.region}: not read yet`
  const days = regions[0]?.vdm
  const status = regions.length ? `Amazon's estimates from Virtual Deliverability Manager, single-recipient mail only${days ? `, ${date(days.since, { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${date(days.until, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : ''}. ${regions.map(vdmWords).join(' · ')}` : 'No pool region.'
  return { tile: key => tiles[key] ?? { value: '—' }, providers: providerRows, vdm: { status, rows: vdmRows }, row: (group, row) => groupRows[group]?.[row] ?? { value: '—' } }
}

/** The board's read for the period in the address; the page header shows when it is from. */
export function useDeliverability(enabled = true) {
  const { window } = deliverabilitySettings(useLocation().search)
  return useQuery({ queryKey: ['operator', 'glass', 'deliverability', window], queryFn: ({ signal }) => operatorApi.glassDeliverability(window, signal), enabled,
    staleTime: REFRESH_MS / 2, refetchInterval: REFRESH_MS, refetchIntervalInBackground: false, placeholderData: keepPreviousData })
}
export function DeliverabilityView() {
  const { search } = useLocation(), navigate = useNavigate(), { window, stream, region } = deliverabilitySettings(search)
  const query = useDeliverability(), data = query.data
  const change = (key: 'window' | 'stream' | 'region', value: string) => {
    const params = new URLSearchParams(search)
    if (value === { window: '7d', stream: 'all', region: 'all' }[key]) params.delete(key); else params.set(key, value)
    navigate({ search: `?${params}` }, { replace: true })
  }
  const partial = data?.coverageFrom && data.coverageFrom > data.previousSince
  const before = DELIVERABILITY_WINDOWS.find(w => w.value === window)!.before
  const note = data && (partial ? `Against ${before}, partly: figures start ${date(data.coverageFrom!, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : `Against ${before}`)
  const controls = <DeliverabilityControls window={window} stream={stream} region={region} note={note} onChange={change}
    regions={(data?.regions ?? []).map(r => ({ value: r.region, label: `${r.region} · ${r.place}` }))} />
  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  // A new period keeps the last one's figures, dimmed, until its own arrive.
  return <DeliverabilityBoard controls={controls} fill={data && fill(data, stream, region)} stale={!!data && data.window !== window} />
}
