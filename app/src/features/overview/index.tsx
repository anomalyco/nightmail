import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiDef, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import { accountStatus, ratePercent, rateStatus } from '../../lib/reputation'
import { campaignEditable, type ChartPoint, type LogEntry, type Overview, type SesDiscovery, type TimeRange } from '../../data/types'
import { DataTable, EmptyState, ErrorState, Meter, MetricRow, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { Crossfade, useMorph, useTween } from '../../components/motion'
import { date, label, number, percent } from '../../lib/format'
import { NextSteps, SidebarScore, StandingCard, useNextSteps, useSenderScore } from '../score'
// `logColumns` here are Overview's compact set of Logs' columns (skeletons.tsx).
import { AsideSkeleton, ChartSkeleton, factTitles, FactsSkeleton, latestColumns as logColumns, RegionStatus } from './skeletons'
import { useLatestRowCount } from './latest'
import { logHref, logRowLabel, useLogRowIntent } from '../logs/rows'
import { usePrefetchQueries } from '../../data/prefetch'
import { composer } from '../campaigns/composer-chunk'
import { DailyLimit, SetupRail, useSendingLimitPending, useSetupSteps } from './setup'
import { BOUNCE_LINE, ChartA, ChartC, COMPLAINT_LINE, FactsA, FactsC, LanesB, NO_EMAILS, useChartVariant } from './pitch'
import { useCompactShell, useMediaQuery } from '../../lib/media'

// Overview: four facts with their own series, the activity chart and the latest emails (down to the card's bottom) on
// the left; a detail column on the right with the standing card (Warn and up), setup (until the first email), the
// daily limit, up to three next steps and the recent campaigns. The sender score is the sidebar's card.
// Every async block reserves its final size, and refetches keep the previous data on screen. A new range or stream keeps
// the old figures up (dimmed if the new ones take over 100 ms), then numbers tween and charts morph or crossfade.
export function OverviewPage() {
  const { regionId } = useRegion()
  const [range, setRange] = useState<TimeRange>('24h')
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('stream')
  const stream = requested === 'transactional' || requested === 'marketing' ? requested : 'all'
  // Each refresh runs one created-cohort aggregation; a minute is fresh enough, and a hidden tab stays quiet.
  const variant = useChartVariant()
  const query = useApiDef(queries.overview(regionId, range, stream, variant === 'c'), { interval: 60_000, keepPrevious: previous => previous[1] === regionId })
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !multiTenant })
  const current = regions.data?.data.find(region => region.region === regionId)
  const discovery = useRegionDiscovery(multiTenant ? undefined : current)
  const controls = <div className="cluster ov-controls">
    {!multiTenant && <><ReputationSummary report={discovery.data} regionId={regionId} />{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus current={current} /></>}
    <Tabs value={range} onValueChange={value => setRange(value as TimeRange)} items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" />
    <Select aria-label="Email stream" value={stream} onValueChange={value => setSearchParams(previous => { const next = new URLSearchParams(previous); if (value === 'all') next.delete('stream'); else next.set('stream', value); return next })} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} />
  </div>
  const data = query.data
  // Where the detail column stacks under the main one (overview.css, 960px), the setup steps lead the page, above the figures. Whether they show is only known once the setup read
  // lands, so until then the main column holds its skeletons and swaps in whole (new nodes, nothing moves).
  const stacked = useMediaQuery('(max-width: 960px)')
  const setup = useSetupSteps()
  const held = stacked && setup.loading
  // The range the figures on screen are for: while a new range loads, the chart keeps labelling the old one.
  const [shownRange, setShownRange] = useState(range)
  if (data && !query.isPlaceholderData && shownRange !== range) setShownRange(range)
  // Latest emails and the figures above it must agree: when a new email (or a new outcome for one) shows in the list,
  // the figures are read again. The API keys its dashboard cache on the same mail activity, so that read is current.
  const count = useLatestRowCount()
  // A stream picked in the header scopes Latest emails too: its sent mail (received mail has no stream).
  const latestParams = stream === 'all' ? { regionId, direction: 'all' as const, page: 1, pageSize: count } : { regionId, direction: 'sent' as const, stream, page: 1, pageSize: count }
  const latest = useApiDef(queries.logs(latestParams), { interval: 60_000, keepPrevious: sameRegion(regionId) })
  const head = latest.data?.items.slice(0, 7).map(row => `${row.id}:${row.status}`).join(',')
  const seen = useRef<string | undefined>(undefined)
  const refetch = query.refetch
  useEffect(() => { if (head === undefined) return; if (seen.current !== undefined && seen.current !== head) void refetch(); seen.current = head }, [head, refetch])
  return <>
    <PageHeader title="Overview" actions={controls} />
    <div className="ov-split">
      <div className="ov-split__main">
        {stacked && setup.steps && <SetupRail steps={setup.steps} current={setup.current} open={setup.open} />}
        {stacked && setup.error ? <ErrorState error={setup.error} onRetry={setup.retry} /> : null}
        <Fragment key={held ? 'held' : 'ready'}>
          {query.isError && !data ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
            {data && !held ? variant === 'a' ? <FactsA data={data} stale={query.isPlaceholderData} /> : variant === 'b' ? <LanesB data={data} range={shownRange} stale={query.isPlaceholderData} /> : variant === 'c' ? <FactsC data={data} stale={query.isPlaceholderData} /> : <Facts data={data} stale={query.isPlaceholderData} /> : <FactsSkeleton />}
            {variant === 'b' ? null : data && !held ? variant === 'a' ? <ChartA data={data} range={shownRange} stale={query.isPlaceholderData} /> : variant === 'c' ? <ChartC data={data} range={shownRange} stale={query.isPlaceholderData} /> : <Chart data={data} range={shownRange} stale={query.isPlaceholderData} /> : <ChartSkeleton />}
          </>}
          <LatestEmails params={latestParams} held={held} />
        </Fragment>
      </div>
      <Aside setup={setup} showSetup={!stacked} campaigns={data?.recentCampaigns} />
    </div>
  </>
}

// The detail column renders in one go once setup, the score and the next steps are known, so nothing in it moves.
// The standing card (Warn and up) leads it; the banner's fix link and the sidebar score scroll here by hash. Recent
// campaigns come with the overview's figures and close the column, so arriving later moves nothing above them.
function Aside({ setup, showSetup, campaigns }: { setup: ReturnType<typeof useSetupSteps>; showSetup: boolean; campaigns?: Overview['recentCampaigns'] }) {
  const score = useSenderScore()
  // One score per screen: the sidebar's card, or this column's copy of it where the sidebar isn't on screen (the
  // phone shell keeps it in More) or doesn't carry it (self-hosted).
  const { multiTenant } = useWorkspaceAccess()
  const showScore = useCompactShell() || !multiTenant
  const next = useNextSteps(score.data)
  const limitPending = useSendingLimitPending()
  const ready = Boolean((score.data || score.isError) && !setup.loading && next.ready && !limitPending)
  const { hash, key } = useLocation()
  useEffect(() => {
    if (!ready || hash !== '#standing') return
    const frame = requestAnimationFrame(() => document.getElementById('standing')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [ready, hash, key])
  return <aside className="ov-split__aside" aria-label="Status">{!ready ? <AsideSkeleton /> : <>
    {score.data && <StandingCard report={score.data} />}
    {showSetup && setup.steps && <SetupRail steps={setup.steps} current={setup.current} open={setup.open} />}
    {showSetup && setup.error ? <ErrorState error={setup.error} onRetry={setup.retry} /> : null}
    {score.isError && !score.data ? <ErrorState error={score.error} onRetry={() => score.refetch()} /> : showScore && <SidebarScore />}
    <DailyLimit report={score.data} />
    {/* Next steps follow setup: never in its place while setup is unknown. */}
    {!setup.steps && !setup.error && <NextSteps items={next.items} />}
    {campaigns && campaigns.length > 0 && <Campaigns rows={campaigns.slice(0, 3)} />}
  </>}</aside>
}

// The buckets a series covers: series over the same buckets morph into each other, any others crossfade.
const buckets = (points: ChartPoint[]) => `${points.length}:${points[0]?.at ?? ''}:${points.at(-1)?.at ?? ''}`
const swap = 200

// Four metric rows (label · series · mono value), two by two. A rate's rule is its meter against its warning line (5%
// bounces, 0.1% complaints, with a tick there), coloured only once the rate reaches that line: a healthy week is grey.
// Every number tweens (tabular figures, laid out from the right, so nothing beside it moves) and every series morphs or crossfades.
// An hour is marked only with enough mail for its rate to mean something: one bounce in four emails is not a trend.
const BAND_VOLUME = 20
function Facts({ data, stale }: { data: Overview; stale: boolean }) {
  const sent = useTween(data.sent, swap), delivered = useTween(data.sent ? data.delivered / data.sent : 0, swap), bounced = useTween(data.sent ? data.bounced / data.sent : 0, swap), complaints = useTween(data.sent ? data.complaints / data.sent : 0, swap)
  const deliveredCount = useTween(data.delivered, swap), bouncedCount = useTween(data.bounced, swap), complaintCount = useTween(data.complaints, swap)
  const change = useTween(data.previousSent ? (data.sent - data.previousSent) / data.previousSent : undefined, swap)
  const bounceWarn = data.sent > 0 && data.bounced / data.sent >= BOUNCE_LINE, complaintWarn = data.sent > 0 && data.complaints / data.sent >= COMPLAINT_LINE
  const facts = [
    { title: factTitles[0], value: number(Math.round(sent)), aside: data.previousSent ? `${change >= 0 ? '+' : ''}${percent(change, 0)}` : '', series: data.points.map(p => p.sent), tone: 'sent' },
    { title: factTitles[1], value: data.sent ? percent(delivered) : '—', aside: number(Math.round(deliveredCount)), series: data.points.map(p => p.delivered), tone: 'delivered' },
    { title: factTitles[2], value: data.sent ? percent(bounced) : '—', aside: number(Math.round(bouncedCount)), series: data.points.map(p => p.bounced), tone: 'bounces', warn: bounceWarn, meter: <Meter value={data.sent ? bounced : 0} max={BOUNCE_LINE * 2} mark={data.sent ? BOUNCE_LINE : undefined} tone={bounceWarn ? 'warning' : 'neutral'} label="Bounce rate" title={`Warning at ${percent(BOUNCE_LINE, 0)}`} /> },
    { title: factTitles[3], value: data.sent ? percent(complaints) : '—', aside: number(Math.round(complaintCount)), series: data.points.map(p => p.complaints), tone: 'complaints', warn: complaintWarn, meter: <Meter value={data.sent ? complaints : 0} max={COMPLAINT_LINE * 2} mark={data.sent ? COMPLAINT_LINE : undefined} tone={complaintWarn ? 'danger' : 'neutral'} label="Complaint rate" title={`Warning at ${percent(COMPLAINT_LINE, 1)}`} /> },
  ]
  return <div className="ov-facts" role="group" aria-label="Figures" data-stale={stale || undefined}>{facts.map(fact => <MetricRow key={fact.title} label={fact.title} hint={fact.aside}
    spark={<Crossfade id={buckets(data.points)} className="ov-spark-stack"><Spark values={fact.series} tone={fact.tone} /></Crossfade>}
    value={fact.value} tone={fact.warn ? 'warning' : undefined} meter={fact.meter} />)}</div>
}
function Spark({ values: target, tone }: { values: number[]; tone: string }) {
  const values = useMorph(target, swap)
  const max = Math.max(1, ...values), slot = 100 / Math.max(1, values.length)
  return <svg className={`ov-spark ov-spark--${tone}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    {values.map((value, i) => { const h = Math.max(value ? 2 : 1, value / max * 24); return <rect key={i} className={value ? undefined : 'ov-spark__zero'} x={i * slot + slot * .18} width={slot * .64} y={24 - h} height={h} /> })}
  </svg>
}

function Chart({ data, range, stale }: { data: Overview; range: TimeRange; stale: boolean }) {
  return <section className="ov-chart" aria-label="Sending activity" data-stale={stale || undefined}>
    <div className="ov-chart__head"><h2 className="ui-label ui-label--rule">Activity</h2></div>
    <Crossfade id={data.sent ? buckets(data.points) : 'empty'} className="ov-chart__plot">{data.sent ? <ActivityChart points={data.points} range={range} /> : <EmptyState title={NO_EMAILS} />}</Crossfade>
  </section>
}

// Latest emails are the selected region's, like the figures and Logs; another region's rows never stand in while it loads.
const sameRegion = (regionId: string) => (previous: readonly unknown[]) => (previous[1] as { regionId?: string } | undefined)?.regionId === regionId
// The latest mail is the top of Logs: the same rows, columns and masking (features/logs/rows.tsx), compact. `count`
// rows fill the column (latest.ts) and are always reserved, so loading, short and full lists are the same height; a new
// count after a resize keeps the old rows up until the new page arrives. A new email or outcome crossfades the rows.
function LatestEmails({ params, held }: { params: { regionId: string; direction: 'all' | 'sent'; stream?: string; page: number; pageSize: number }; held: boolean }) {
  const { regionId, pageSize: count, stream } = params
  const logs = useApiDef(queries.logs(params), { interval: 60_000, keepPrevious: sameRegion(regionId) }) // warmed with the page (data/prefetch.ts)
  const rowIntent = useLogRowIntent()
  const rows = (logs.data?.items ?? []).slice(0, count)
  return <section className="ov-latest"><SectionHeader title="Latest emails" actions={<Link className="ui-button ui-button--ghost ui-button--sm" to={stream ? `/logs?view=sent&stream=${stream}` : '/logs'}>Logs <ArrowUpRight size={16} /></Link>} />
    {logs.isError && !logs.data ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : <Crossfade id={logs.data && rows.map(row => `${row.direction}:${row.id}:${row.status}`).join(',')}><DataTable<LogEntry> className="logs-table ov-table" loading={logs.isPending || held} skeletonRows={count} minRows={count} rows={rows} rowKey={row => `${row.direction}:${row.id}`} rowHref={logHref} rowLabel={logRowLabel} onRowIntent={rowIntent} empty={<EmptyState title="No emails yet" />} columns={logColumns} /></Crossfade>}
  </section>
}
// Up to three, in the detail column's list style: the name, then how it went (or its status while not sent).
function Campaigns({ rows }: { rows: Overview['recentCampaigns'] }) {
  const warm = usePrefetchQueries()
  return <nav className="next-steps ov-campaigns" aria-label="Recent campaigns">
    <div className="ov-campaigns__head"><h2 className="next-steps__title">Campaigns</h2><Link className="ui-button ui-button--ghost ui-button--sm" to="/campaigns">All <ArrowUpRight size={16} /></Link></div>
    <ul>{rows.map((row, i) => { const sent = ['sent', 'done'].includes(row.status), intent = () => { void warm([queries.campaign(row.id)]); if (campaignEditable(row)) void composer.preload().catch(() => {}) }
      return <li key={row.id} style={{ '--i': i } as CSSProperties}><Link to={`/campaigns/${row.id}/${campaignEditable(row) ? 'edit' : 'review'}`} title={row.name} onPointerEnter={intent} onFocus={intent}>
        <span>{row.name}</span><span className="muted">{sent ? `${date(row.updatedAt, { month: 'short', day: 'numeric' })} · ${percent(row.recipients ? row.delivered / row.recipients : 0, 0)} delivered` : label(row.status)}</span><ArrowUpRight size={14} aria-hidden="true" />
      </Link></li> })}</ul>
  </nav>
}

const severity = { neutral: 0, info: 0, success: 1, warning: 2, danger: 3 } as const
// Self-hosted only: the SES account's own reputation, from the region's discovery report.
function ReputationSummary({ report, regionId }: { report: SesDiscovery | undefined; regionId: string }) {
  const reputation = report?.reputation
  if (!report?.account || !reputation?.available) return null
  const worst = [accountStatus(report.account.enforcementStatus), rateStatus('bounceRate', reputation.bounceRate), rateStatus('complaintRate', reputation.complaintRate)].filter(status => status.label !== 'No data' && status.label !== 'Unknown').sort((a, b) => severity[b.tone] - severity[a.tone])[0]
  return <Link className="overview-reputation" to={`/settings?region=${encodeURIComponent(regionId)}`} title={`SES account reputation: ${ratePercent(reputation.bounceRate)} bounce · ${ratePercent(reputation.complaintRate)} complaint`}>
    <span className="muted">SES</span>{worst && <StatusBadge status={worst.label} tone={worst.tone} />}<span className="muted">{ratePercent(reputation.bounceRate)} bounce · {ratePercent(reputation.complaintRate)} complaint</span>
  </Link>
}

// Three whole-number steps so every gridline label is a distinct integer.
function niceMax(value: number) { const raw = Math.max(1, value) / 3, base = 10 ** Math.floor(Math.log10(raw)), step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * base).find(m => m >= raw && Number.isInteger(m)) ?? Math.ceil(raw); return step * 3 }
// New counts over the same buckets morph the bars, the lines and their scales (200 ms); the scale labels crossfade.
function ActivityChart({ points: target, range }: { points: ChartPoint[]; range: TimeRange }) {
  const [active, setActive] = useState<number | null>(null)
  // The hours are one tab stop (the last one focused, else the newest); the arrow keys, Home and End step between them.
  const [stop, setStop] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1080, height: 196 })
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = ({ width, height }: DOMRectReadOnly) => setSize({ width: Math.max(1, width), height: Math.max(1, height) })
    measure(element.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect))
    observer.observe(element)
    return () => observer.disconnect()
  }, [target.length])
  const count = target.length
  const hasOutcomes = target.every(point => Number.isFinite(point.bounced) && Number.isFinite(point.complaints))
  const maxSent = niceMax(Math.max(...target.map(p => p.sent)))
  // The outcomes' scale reaches at least a tenth of the busiest hour (twice the bounce line), so a peak on it means a high
  // rate, not one bounce: a lone bounce stays a small bump instead of a spike to the top.
  const maxException = niceMax(Math.max(...target.map(p => Math.max(p.bounced ?? 0, p.complaints ?? 0)), Math.max(...target.map(p => p.sent)) * BOUNCE_LINE * 2))
  const shown = useMorph([...target.map(p => p.sent), ...target.map(p => p.bounced ?? NaN), ...target.map(p => p.complaints ?? NaN), maxSent, maxException], 200)
  if (!count) return <EmptyState title="No activity" />
  const points = target.map((p, i) => ({ ...p, sent: shown[i], bounced: shown[count + i], complaints: shown[2 * count + i] }))
  const sentScale = shown[3 * count], exceptionScale = shown[3 * count + 1]
  const { width, height } = size
  const left = 52, right = width - 64, top = 30, bottom = height - 42
  const selectedPoint = active === null ? undefined : target[active]
  const slot = (right - left) / points.length
  const x = (i: number) => left + (i + 0.5) * slot
  const barWidth = Math.max(1, Math.min(8, slot * 0.4))
  const y = (value: number, max: number) => bottom - value / max * (bottom - top)
  const line = (key: 'bounced' | 'complaints', max: number) => {
    const values = points.map(p => y(p[key], max)), raw = target.map(p => p[key] ?? 0)
    const slopes = values.slice(1).map((value, i) => value - values[i])
    // Monotone cubic interpolation passes through every count without overshooting
    // a peak or dipping below zero; opposite/flat slopes keep extrema horizontal.
    const tangents = values.map((_, i) => {
      if (i === 0) return slopes[0] ?? 0
      if (i === values.length - 1) return slopes[i - 1]
      const before = slopes[i - 1], after = slopes[i]
      return before * after <= 0 ? 0 : 2 * before * after / (before + after)
    })
    // Only the stretches with something to show: an outcome's line rises from the baseline and returns to it, and never
    // runs along it in red between them.
    let path = '', open = false
    for (let i = 1; i < values.length; i++) {
      if (!raw[i - 1] && !raw[i]) { open = false; continue }
      if (!open) { path += `M ${x(i - 1)} ${values[i - 1]} `; open = true }
      path += `C ${x(i - 2 / 3)} ${values[i - 1] + tangents[i - 1] / 3} ${x(i - 1 / 3)} ${values[i] - tangents[i] / 3} ${x(i)} ${values[i]} `
    }
    return path
  }
  const hourly = range !== '30d'
  const pointLabel = (at: string) => `${date(at, { month: 'short', day: 'numeric', ...(hourly ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}), timeZone: 'UTC' })} UTC`
  // Up to six ticks after the first, fewer when the plot is too narrow for their labels.
  const tickSteps = Math.max(1, Math.min(6, Math.floor((right - left) / 72)))
  const tickIndices = [...new Set([0, ...Array.from({ length: tickSteps }, (_, i) => Math.round((i + 1) * (points.length - 1) / tickSteps))])]
  // The legend is the scales' titles: Emails over the left scale, bounces and complaints over the right one.
  return <div ref={container} className="activity-chart" onMouseLeave={() => setActive(null)}>
    <div className="activity-chart__keys"><span className="chart-legend"><span><i className="legend-sent" />Emails</span></span>{hasOutcomes && <span className="chart-legend"><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span></span>}</div>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Emails created per ${hourly ? 'hour' : 'day'} on the left scale; outcomes for those emails on the right scale.`}>
    {/* Hours with real volume whose bounces or complaints crossed their warning line, as bands behind everything else. */}
    {hasOutcomes && target.map((p, i) => p.sent >= BAND_VOLUME && ((p.bounced ?? 0) / p.sent >= BOUNCE_LINE || (p.complaints ?? 0) / p.sent >= COMPLAINT_LINE) && <g key={`anomaly-${p.at}`}><rect x={left + i * slot} y={top} width={slot} height={bottom - top} className="chart-anomaly" /><rect x={left + i * slot} y={bottom + 2} width={slot} height={2} className="chart-anomaly-mark" /></g>)}
    {[0, 1, 2, 3].map(i => <line key={i} x1={left} x2={right} y1={top + i * (bottom - top) / 3} y2={top + i * (bottom - top) / 3} className={i === 3 ? 'chart-grid chart-grid--base' : 'chart-grid'} />)}
    <Crossfade as="g" id={`${maxSent}:${hasOutcomes ? maxException : ''}`}>{[0, 1, 2, 3].map(i => <g key={i}><text x={0} y={top + i * (bottom - top) / 3 + 4} className="chart-label">{number(Math.round(maxSent * (1 - i / 3)))}</text>{hasOutcomes && <text x={width - 2} y={top + i * (bottom - top) / 3 + 4} textAnchor="end" className="chart-label">{number(Math.round(maxException * (1 - i / 3)))}</text>}</g>)}</Crossfade>
    {points.map((p, i) => p.sent > 0 && <rect key={p.at} x={x(i) - barWidth / 2} y={y(p.sent, sentScale)} width={barWidth} height={bottom - y(p.sent, sentScale)} rx={0} className={`chart-bar${active === i ? ' chart-bar--active' : ''}`} />)}{/* An outcome with nothing to show draws no line: a red rule along the baseline reads as trouble. */}
    {hasOutcomes && target.some(p => p.bounced) && <path d={line('bounced', exceptionScale)} className="chart-line chart-line--bounces" />}{hasOutcomes && target.some(p => p.complaints) && <path d={line('complaints', exceptionScale)} className="chart-line chart-line--complaints" />}
    {/* 24 h: the hour, and the date under the first tick and wherever the day changes, so 12:00 yesterday and 12:00
        today never read as the same tick. 7 d: the date, then the hour. */}
    {tickIndices.map((i, n) => { const day = date(points[i].at, { month: 'short', day: 'numeric', timeZone: 'UTC' }), dated = range === '24h' && (n === 0 || day !== date(points[tickIndices[n - 1]].at, { month: 'short', day: 'numeric', timeZone: 'UTC' }))
      return <text key={i} x={x(i)} y={height - (range === '30d' ? 13 : 22)} textAnchor="middle" className="chart-label">{range === '24h' ? date(points[i].at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) : day}{range === '7d' ? <tspan x={x(i)} dy={15}>{date(points[i].at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })}</tspan> : dated ? <tspan x={x(i)} dy={15} className="chart-label--date">{day}</tspan> : null}</text> })}
    {target.map((p, i) => {
      const start = left + i * slot, end = start + slot
      return <rect key={p.at} x={start} y={top} width={Math.max(0, end - start)} height={bottom - top} fill="transparent" data-point={i} tabIndex={i === Math.min(stop ?? count - 1, count - 1) ? 0 : -1} role="button" aria-label={`${pointLabel(p.at)}: ${number(p.sent)} created${hasOutcomes ? `, ${p.bounced} bounces, ${p.complaints} complaints` : ''}`} onMouseEnter={() => setActive(i)} onFocus={() => { setActive(i); setStop(i) }} onBlur={() => setActive(null)} onKeyDown={event => { const next = event.key === 'ArrowRight' ? Math.min(count - 1, i + 1) : event.key === 'ArrowLeft' ? Math.max(0, i - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null; if (next === null) return; event.preventDefault(); event.currentTarget.parentElement?.querySelector<SVGElement>(`[data-point="${next}"]`)?.focus() }} />
    })}
    {selectedPoint && active !== null && <line x1={x(active)} x2={x(active)} y1={top} y2={bottom} className="chart-crosshair" />}
  </svg>{selectedPoint && <div className="chart-tooltip" role="status"><strong>{pointLabel(selectedPoint.at)}</strong><span>Emails <b>{number(selectedPoint.sent)}</b></span>{hasOutcomes && <><span>Bounces <b>{number(selectedPoint.bounced)}</b></span><span>Complaints <b>{number(selectedPoint.complaints)}</b></span></>}</div>}</div>
}
