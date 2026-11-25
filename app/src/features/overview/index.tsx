import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiDef, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import { accountStatus, ratePercent, rateStatus } from '../../lib/reputation'
import { campaignEditable, type Campaign, type ChartPoint, type LogEntry, type Overview, type SesDiscovery, type TimeRange } from '../../data/types'
import { DataTable, EmptyState, ErrorState, Icon, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { Crossfade, useMorph, useTween } from '../../components/motion'
import { date, label, number, percent } from '../../lib/format'
import { NextSteps, SidebarScore, StandingCard, useNextSteps, useSenderScore } from '../score'
// `logColumns` here are Overview's compact set of Logs' columns (skeletons.tsx).
import { AsideSkeleton, ChartSkeleton, factTitles, FactTilesSkeleton, latestColumns as logColumns, PanelToggle, RegionStatus, ScoreTileSkeleton } from './skeletons'
import { latestRequest, useLatestRowCount } from './latest'
import { logHref, logRowLabel, useLogRowIntent } from '../logs/rows'
import { routeChunks, usePrefetchQueries } from '../../data/prefetch'
import { composer } from '../campaigns/composer-chunk'
import { DailyLimit, SetupRail, useSendingLimitPending, useSetupSteps } from './setup'
import { useCompactShell, useMediaQuery } from '../../lib/media'
import { setPanelHidden } from './panel'
import { DomainSetupAlert } from '../settings/domain-setup-alert'
import { NO_DOMAIN_SPACE, NoDomainCard, useNoDomainCard } from './no-domain'

// Overview: is sending healthy? An edge-to-edge console: a 44px control strip (the title, then the range, stream and
// panel toggle), one hairline-divided strip of four figures across the page, each a link to that mail in Logs; then
// the activity band over the latest emails (failures first, dense rows down to the window's bottom) beside a 296px
// inspector rail with the standing (Warn and up), setup (until the first email), the daily limit, next steps and the
// recent campaigns. The sender score is the sidebar's readout; where there is no sidebar (the compact shell) it is a
// row under the figures, so health comes before everything else.
// In one column (960px and under) the rail follows the chart and the list closes the page.
// Every async block reserves its final size, and refetches keep the previous data on screen. A new range or stream keeps
// the old figures up (dimmed if the new ones take over 100 ms), then numbers tween and charts morph or crossfade.
export function OverviewPage() {
  const { regionId } = useRegion()
  const [range, setRange] = useState<TimeRange>('24h')
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('stream')
  const stream = requested === 'transactional' || requested === 'marketing' ? requested : 'all'
  // Each refresh runs one created-cohort aggregation; a minute is fresh enough, and a hidden tab stays quiet.
  const query = useApiDef(queries.overview(regionId, range, stream), { interval: 60_000, keepPrevious: previous => previous[1] === regionId })
  // Read separately from /metrics so a slow or over-budget metrics query never hides Recent campaigns.
  const recent = useApiDef(queries.recentCampaigns(regionId), { keepPrevious: true })
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !multiTenant })
  const current = regions.data?.data.find(region => region.region === regionId)
  const discovery = useRegionDiscovery(multiTenant ? undefined : current)
  // Self-hosted, the region's status rides along: too wide for the main column, so the header keeps the page's width.
  const controls = <div className="cluster ov-controls" data-wide={!multiTenant || undefined}>
    {!multiTenant && <><ReputationSummary report={discovery.data} regionId={regionId} />{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus current={current} /></>}
    <Tabs value={range} onValueChange={value => setRange(value as TimeRange)} items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" />
    <Select aria-label="Email stream" value={stream} onValueChange={value => setSearchParams(previous => { const next = new URLSearchParams(previous); if (value === 'all') next.delete('stream'); else next.set('stream', value); return next })} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} />
  </div>
  const data = query.data
  // Where the detail column stacks under the main one (overview.css, 960px), the setup steps lead the page, above the figures. Whether they show is only known once the setup read
  // lands, so until then the main column holds its skeletons and swaps in whole (new nodes, nothing moves).
  const stacked = useMediaQuery('(max-width: 960px)'), compact = useCompactShell()
  const setup = useSetupSteps()
  const detail = useDetail(setup, Boolean(recent.data || recent.isError))
  const held = stacked && setup.loading
  const noDomain = useNoDomainCard(setup.hasDomain)
  // The card leads with Add domain, so the setup steps' own domain step doesn't offer it again beside it.
  const rail = noDomain ? withoutDomainAction(setup) : setup
  // Latest emails and the figures above it must agree: when a new email (or a new outcome for one) shows in the list,
  // the figures are read again (unless metrics already failed, so we never hammer an over-budget query).
  const count = useLatestRowCount(noDomain ? NO_DOMAIN_SPACE : 0)
  // A stream picked in the header scopes Latest emails too: its sent mail (received mail has no stream).
  const latestParams = latestRequest(regionId, stream)
  const latest = useApiDef(queries.logs(latestParams), { interval: 60_000, keepPrevious: sameRegion(regionId) })
  const head = latest.data?.items.slice(0, 7).map(row => `${row.id}:${row.status}`).join(',')
  const seen = useRef<string | undefined>(undefined)
  const refetch = query.refetch
  const metricsFailed = query.isError
  useEffect(() => { if (head === undefined) return; if (seen.current !== undefined && seen.current !== head && !metricsFailed) void refetch(); seen.current = head }, [head, refetch, metricsFailed])
  const latestEmails = <LatestEmails params={latestParams} count={count} reserve={!stacked} held={held} range={range} figures={data} figuresFailed={query.isError} />
  const failed = query.isError && !data
  return <div className="ov-page">
    <PageHeader className="ov-strip" title="Overview" actions={<>{controls}<PanelToggle /></>} />
    {noDomain && <div className="ov-lead"><NoDomainCard /></div>}
    {stacked && setup.stuck && <div className="ov-lead"><DomainSetupAlert domain={setup.stuck.domain} gap={setup.stuck.gap} /></div>}
    {stacked && rail.steps && <div className="ov-lead"><SetupRail steps={rail.steps} current={rail.current} open={rail.open} /></div>}
    {stacked && setup.error ? <div className="ov-lead"><ErrorState error={setup.error} onRetry={setup.retry} /></div> : null}
    <Fragment key={held ? 'held' : 'ready'}>
      {/* The score has its own read: it neither waits for the figures nor dims with them. */}
      {failed ? <div className="ov-lead"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>
        : <div className="ov-kpis" role="group" aria-label="Figures" data-stale={query.isPlaceholderData || undefined}>{data && !held ? <Facts data={data} range={range} stream={stream} /> : <FactTilesSkeleton />}{compact && (held ? <ScoreTileSkeleton /> : <SidebarScore />)}</div>}
    </Fragment>
    <div key={held ? 'split-held' : 'split-ready'} className="ov-split">
      <div className="ov-split__main">
        <Fragment key={held ? 'held' : 'ready'}>
          {failed ? null : data && !held ? <Chart data={data} stale={query.isPlaceholderData} /> : <ChartSkeleton />}
          {!stacked && latestEmails}
        </Fragment>
      </div>
      <Aside setup={rail} detail={detail} showSetup={!stacked} placeholder={!stacked} campaigns={recent.data?.items} range={range} />
      {/* Under the rail, once that rail has its final height (its own reads and the figures' campaigns). */}
      {stacked && detail.ready && (data || query.isError) ? latestEmails : null}
    </div>
  </div>
}

function withoutDomainAction(setup: ReturnType<typeof useSetupSteps>) {
  if (!setup.steps) return setup
  const same = new Map(setup.steps.map(step => [step, step.key === 'domain' ? { ...step, action: undefined } : step]))
  return { ...setup, steps: setup.steps.map(step => same.get(step)!), current: setup.current && same.get(setup.current), open: setup.open?.map(step => same.get(step)!) }
}

// What the detail column shows, and whether all of it is known (the page also waits on this to place the list under it).
function useDetail(setup: ReturnType<typeof useSetupSteps>, recentReady: boolean) {
  const score = useSenderScore()
  const next = useNextSteps(score.data)
  const limitPending = useSendingLimitPending()
  return { score, next, ready: Boolean((score.data || score.isError) && !setup.loading && next.ready && !limitPending && recentReady) }
}
// The detail column renders in one go once setup, the score and the next steps are known, so nothing in it moves.
// The standing card (Warn and up) leads it; the banner's fix link and the sidebar score scroll here by hash. Recent
// campaigns come with the overview's figures and close the column, so arriving later moves nothing above them.
// In one column it has no placeholder while it loads: it sits under the chart there, in view, and may turn out empty
// (a new workspace's setup leads the page instead), so it takes up room only once it has something to show.
function Aside({ setup, detail: { score, next, ready }, showSetup, placeholder, campaigns, range }: { setup: ReturnType<typeof useSetupSteps>; detail: ReturnType<typeof useDetail>; showSetup: boolean; placeholder: boolean; campaigns?: Overview['recentCampaigns']; range: TimeRange }) {
  // One score per screen: the sidebar's card; under the tiles where the sidebar isn't on screen (the compact shell);
  // or this column's copy where the sidebar doesn't carry it (self-hosted).
  const { multiTenant } = useWorkspaceAccess()
  const compact = useCompactShell()
  const { hash, key } = useLocation()
  // The banner's fix link leads to the standing card, so it brings back a hidden column.
  useEffect(() => { if (hash === '#standing' && placeholder) setPanelHidden(false) }, [hash, key, placeholder])
  useEffect(() => {
    if (!ready || hash !== '#standing') return
    const frame = requestAnimationFrame(() => document.getElementById('standing')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [ready, hash, key])
  return <aside id="overview-panel" className="ov-split__aside" aria-label="Status">{!ready ? placeholder && <AsideSkeleton /> : <>
    {score.data && <StandingCard report={score.data} />}
    {showSetup && setup.stuck && <section aria-label="Domain setup"><DomainSetupAlert domain={setup.stuck.domain} gap={setup.stuck.gap} /></section>}
    {showSetup && setup.steps && <SetupRail steps={setup.steps} current={setup.current} open={setup.open} />}
    {showSetup && setup.error ? <ErrorState error={setup.error} onRetry={setup.retry} /> : null}
    {compact ? null : score.isError && !score.data ? <ErrorState error={score.error} onRetry={() => score.refetch()} /> : !multiTenant && <SidebarScore />}
    <DailyLimit report={score.data} />
    {/* Next steps follow setup: never in its place while setup is unknown. */}
    {!setup.steps && !setup.error && next.items.length > 0 && <section className="ov-rail-section" aria-labelledby="overview-next"><h2 id="overview-next" className="ov-label">Next steps</h2><NextSteps items={next.items.map(item => ({ ...item, to: logsHref(item.to, range) }))} /></section>}
    {campaigns && campaigns.length > 0 && <Campaigns rows={campaigns.slice(0, 3)} />}
  </>}</aside>
}

// The buckets a series covers: series over the same buckets morph into each other, any others crossfade.
const buckets = (points: ChartPoint[]) => `${points.length}:${points[0]?.at ?? ''}:${points.at(-1)?.at ?? ''}`
const swap = 200

// Four figures in one ruled strip, each a link to the mail it counts: Logs' sent mail with that status, over the same
// range and stream. Emails and Delivered carry their buckets as inline sparkbars; a rate names its limit beside the
// figure and carries a 20-cell gauge that ends there (5% bounces, 0.1% complaints; each cell a twentieth of it): the
// data blue below half the limit, amber from half, red at it. Every number tweens (tabular figures; a hint is laid out
// from its right edge, so a new value moves nothing) and the bars morph or crossfade.
export const BOUNCE_LINE = 0.05, COMPLAINT_LINE = 0.001
// An hour's rate counts only with enough mail for it to mean something: one bounce in four emails is not a trend.
const BAND_VOLUME = 20
type Zone = 'ok' | 'near' | 'over'
const zone = (rate: number, limit: number): Zone => rate >= limit ? 'over' : rate >= limit / 2 ? 'near' : 'ok'
const hourRate = (part: number, sent: number) => sent >= BAND_VOLUME ? part / sent : 0
// A rate too small for two decimals keeps a third, so one complaint never reads as 0.00%.
const rateText = (rate: number) => rate > 0 && rate < 0.0001 ? percent(rate, 3) : percent(rate)
const limitText = (limit: number) => percent(limit, limit < 0.01 ? 1 : 0)
function Facts({ data, range, stream }: { data: Overview; range: TimeRange; stream: 'all' | 'transactional' | 'marketing' }) {
  const sent = useTween(data.sent, swap), delivered = useTween(data.sent ? data.delivered / data.sent : 0, swap), bounced = useTween(data.sent ? data.bounced / data.sent : 0, swap), complaints = useTween(data.sent ? data.complaints / data.sent : 0, swap)
  const deliveredCount = useTween(data.delivered, swap), bouncedCount = useTween(data.bounced, swap), complaintCount = useTween(data.complaints, swap)
  const change = useTween(data.previousSent ? (data.sent - data.previousSent) / data.previousSent : undefined, swap)
  const to = (status?: string) => logsHref(`/logs?view=sent${status ? `&status=${status}` : ''}${stream === 'all' ? '' : `&stream=${stream}`}`, range)
  const warm = () => void routeChunks['/logs']?.().catch(() => {})
  const tiles = [
    { title: factTitles[0], to: to(), hint: data.previousSent ? `${change >= 0 ? '+' : ''}${percent(change, 0)}` : '', value: number(Math.round(sent)), columns: data.points.map(p => p.sent), tone: 'sent' as const },
    { title: factTitles[1], to: to('delivered'), hint: number(Math.round(deliveredCount)), value: data.sent ? percent(delivered) : '—', columns: data.points.map(p => p.delivered), tone: 'delivered' as const },
    { title: factTitles[2], to: to('bounced'), hint: number(Math.round(bouncedCount)), value: data.sent ? rateText(bounced) : '—', rate: data.sent ? data.bounced / data.sent : 0, limit: BOUNCE_LINE },
    { title: factTitles[3], to: to('complained'), hint: number(Math.round(complaintCount)), value: data.sent ? rateText(complaints) : '—', rate: data.sent ? data.complaints / data.sent : 0, limit: COMPLAINT_LINE },
  ]
  return <>{tiles.map(tile => <Link key={tile.title} to={tile.to} className="ov-kpi" data-zone={tile.limit === undefined ? undefined : zone(tile.rate, tile.limit)} onPointerEnter={warm} onFocus={warm}>
    <div className="ov-kpi__head"><span>{tile.title}</span><span className="ov-kpi__hint"><span>{tile.hint}</span></span></div>
    <div className="ov-kpi__value"><span className="ov-kpi__figure">{tile.value}</span>{tile.limit !== undefined && <span className="ov-kpi__limit">· {limitText(tile.limit)} max</span>}</div>
    {tile.limit === undefined ? <Crossfade id={buckets(data.points)} className="ov-kpi__spark"><Columns values={tile.columns} tone={tile.tone} /></Crossfade> : <div className="ov-kpi__spark ov-kpi__spark--gauge"><Gauge rate={tile.rate} limit={tile.limit} label={`${tile.title} rate`} /></div>}
  </Link>)}</>
}
function Gauge({ rate, limit, label }: { rate: number; limit: number; label: string }) {
  const lit = rate > 0 ? Math.min(20, Math.max(1, Math.ceil(rate / limit * 20))) : 0
  return <span className="ov-gauge" data-zone={zone(rate, limit)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={rate} aria-valuetext={`${rateText(rate)} of a ${limitText(limit)} limit`}>{Array.from({ length: 20 }, (_, i) => <i key={i} data-on={i < lit || undefined} />)}</span>
}
// SVG, so a range with another count of buckets redraws the columns instead of moving boxes.
function Columns({ values: target, tone }: { values: number[]; tone: 'sent' | 'delivered' }) {
  const values = useMorph(target, swap)
  const max = Math.max(1, ...values), slot = 100 / Math.max(1, values.length)
  return <svg className={`ov-columns ov-columns--${tone}`} viewBox="0 0 100 26" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
    {values.map((value, i) => { const h = value > 0 ? Math.max(5, value / max * 26) : 0; return h > 0 && <rect key={i} x={i * slot} width={slot * .78} y={26 - h} height={h} /> })}
  </svg>
}

function Chart({ data, stale }: { data: Overview; stale: boolean }) {
  return <section className="ov-chart" aria-label="Sending activity" data-stale={stale || undefined}>
    <div className="ov-chart__head"><span className="ov-label">Activity</span><span className="ov-legend" aria-hidden="true"><span><i className="ov-key--sent" />Emails</span><span><i className="ov-key--bounces" />Bounced</span><span><i className="ov-key--complaints" />Complaints</span></span></div>
    <Crossfade id={data.sent ? buckets(data.points) : 'empty'} className="ov-chart__plot">{data.sent ? <ActivityChart data={data} /> : <EmptyState title="No emails in this period" />}</Crossfade>
  </section>
}

// Logs opens on the range Overview shows; 30d is its default.
const logsHref = (to: string, range: TimeRange) => range === '30d' || !(to === '/logs' || to.startsWith('/logs?')) ? to : `${to}${to.includes('?') ? '&' : '?'}range=${range}`
// Latest emails are the selected region's, like the figures and Logs; another region's rows never stand in while it loads.
const sameRegion = (regionId: string) => (previous: readonly unknown[]) => (previous[1] as { regionId?: string } | undefined)?.regionId === regionId
// Sent mail that didn't arrive or was held back, as Logs' statuses name it.
const failed = new Set(['bounced', 'complained', 'rejected', 'rendering_failed', 'suppressed', 'delayed'])
// The latest mail is the top of Logs: the same rows, columns and masking (features/logs/rows.tsx), compact, with the
// failures first: the ones among the newest hundred emails that were sent in the figures' period, so the list and the
// tiles above it speak of the same mail. Beside the detail column `count` rows fill the main one (latest.ts) and are
// always reserved, so loading, short and full lists are the same height; closing the page in one column, it is as tall
// as its rows. It waits for the figures, so it settles once. A new email or outcome crossfades the rows.
function LatestEmails({ params, count, reserve, held, range, figures, figuresFailed }: { params: ReturnType<typeof latestRequest>; count: number; reserve: boolean; held: boolean; range: TimeRange; figures: Overview | undefined; figuresFailed: boolean }) {
  const { regionId } = params, stream = 'stream' in params ? params.stream : undefined
  const logs = useApiDef(queries.logs(params), { interval: 60_000, keepPrevious: sameRegion(regionId) }) // warmed with the page (data/prefetch.ts)
  const rowIntent = useLogRowIntent()
  const items = logs.data?.items ?? [], settled = Boolean(figures || figuresFailed)
  const since = figures ? Date.parse(figures.periodStart) : NaN
  const failures = items.filter(row => row.direction === 'sent' && failed.has(row.status) && Date.parse(row.at) >= since)
  const rows = [...failures, ...items.filter(row => !failures.includes(row))].slice(0, count)
  return <section className="ov-latest"><SectionHeader title="Latest emails" actions={<Link className="ui-button ui-button--ghost ui-button--sm" to={logsHref(stream ? `/logs?view=sent&stream=${stream}` : '/logs', range)}>Logs <Icon icon={ArrowUpRight} size="sm" /></Link>} />
    {logs.isError && !logs.data ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : <Crossfade id={logs.data && settled ? rows.map(row => `${row.direction}:${row.id}:${row.status}`).join(',') : undefined}><DataTable<LogEntry> className="logs-table ov-table" loading={logs.isPending || held || !settled} skeletonRows={count} minRows={reserve ? count : 0} rows={rows} rowKey={row => `${row.direction}:${row.id}`} rowHref={logHref} rowLabel={logRowLabel} onRowIntent={rowIntent} empty={<EmptyState title="No emails yet" />} columns={logColumns} /></Crossfade>}
  </section>
}
// Up to three, in the detail column's list style: the name, then how it went (or its status while not sent).
function Campaigns({ rows }: { rows: Campaign[] }) {
  const warm = usePrefetchQueries()
  return <nav className="next-steps ov-campaigns" aria-label="Recent campaigns">
    <div className="ov-campaigns__head"><h2 className="ov-label">Campaigns</h2><Link className="ui-button ui-button--ghost ui-button--sm" to="/campaigns">All <Icon icon={ArrowUpRight} size="sm" /></Link></div>
    <ul>{rows.map((row, i) => { const sent = ['sent', 'done'].includes(row.status), intent = () => { void warm([queries.campaign(row.id)]); if (campaignEditable(row)) void composer.preload().catch(() => {}) }
      return <li key={row.id} style={{ '--i': i } as CSSProperties}><Link to={`/campaigns/${row.id}/${campaignEditable(row) ? 'edit' : 'review'}`} title={row.name} onPointerEnter={intent} onFocus={intent}>
        <span>{row.name}</span><span className="muted">{sent ? `${date(row.updatedAt, { month: 'short', day: 'numeric' })} · ${percent(row.recipients ? row.delivered / row.recipients : 0, 0)} delivered` : label(row.status)}</span><Icon icon={ArrowUpRight} size="sm" />
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
const HOUR = 3_600_000, DAY = 86_400_000
const bucketOf = (points: ChartPoint[]) => points.length > 1 ? Date.parse(points[1].at) - Date.parse(points[0].at) : HOUR
const clock = (at: string) => date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const day = (at: string) => date(at, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const bucketLabel = (points: ChartPoint[], i: number) => bucketOf(points) >= DAY ? day(points[i].at) : `${day(points[i].at)}, ${clock(points[i].at)} UTC`
// Time ticks on whole steps (3 h, 6 h, a day…) at least minGap apart; midnight is labelled with its date.
function ticks(points: ChartPoint[], plotWidth: number, minGap: number) {
  if (points.length < 2) return points.length ? [0] : []
  const bucket = bucketOf(points), slot = plotWidth / points.length
  const steps = bucket >= DAY ? [1, 2, 3, 5, 7, 10, 15].map(d => d * DAY) : [1, 2, 3, 4, 6, 12, 24, 48].map(h => h * HOUR)
  const step = steps.find(s => s / bucket * slot >= minGap) ?? steps[steps.length - 1]
  return points.flatMap((point, i) => Date.parse(point.at) % step === 0 ? [i] : [])
}
const tickLabel = (points: ChartPoint[], i: number) => bucketOf(points) >= DAY || Date.parse(points[i].at) % DAY === 0 ? day(points[i].at) : clock(points[i].at)
// Monotone cubic segments through the points (one "C" command per gap): the curve passes through every value without
// overshooting a peak or dipping under zero, and a flat run stays flat.
function monotone(xs: number[], ys: number[]) {
  const slopes = ys.slice(1).map((y, i) => (y - ys[i]) / (xs[i + 1] - xs[i]))
  const tangents = ys.map((_, i) => i === 0 ? slopes[0] ?? 0 : i === ys.length - 1 ? slopes[i - 1] : slopes[i - 1] * slopes[i] <= 0 ? 0 : 2 * slopes[i - 1] * slopes[i] / (slopes[i - 1] + slopes[i]))
  return slopes.map((_, i) => { const third = (xs[i + 1] - xs[i]) / 3; return `C ${xs[i] + third} ${ys[i] + tangents[i] * third} ${xs[i + 1] - third} ${ys[i + 1] - tangents[i + 1] * third} ${xs[i + 1]} ${ys[i + 1]}` })
}
// keep(i) drops the segment from point i to i + 1: the complaints line only rises where there is one, and never runs
// along the baseline in red between them.
function Line({ xs, ys, tone, keep = () => true }: { xs: number[]; ys: number[]; tone: 'sent' | 'bounces' | 'complaints'; keep?: (i: number) => boolean }) {
  let path = '', end = -1
  monotone(xs, ys).forEach((segment, i) => { if (!keep(i)) return; if (end !== i) path += `M ${xs[i]} ${ys[i]} `; path += segment + ' '; end = i + 1 })
  return path ? <path d={path} className={`ov-line ov-line--${tone}`} /> : null
}
// The activity chart: emails as a navy line over a flat wash on the left scale; bounces and complaints as counts on a
// small scale of their own in the lower half of the plot, so a handful of bounces still has a shape. Their latest values
// label the lines' ends; while a bucket is hovered (or tapped and dragged on a phone) that scale shows as a short right
// axis instead, and one readout follows the crosshair. An hour over the bounce limit, or with any complaint, has a dot
// on its line. The window's first and last buckets are only partly counted (it starts and ends mid-hour), so the lines
// leave them out rather than dip; they stay in the figures and the readout. New counts over the same buckets morph.
function ActivityChart({ data }: { data: Overview }) {
  const target = data.points
  const [active, setActive] = useState<number | null>(null)
  // The buckets are one tab stop (the last one focused, else the newest); the arrow keys, Home and End step between them.
  const [stop, setStop] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(790)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    setWidth(Math.max(1, element.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const n = target.length
  const shown = useMorph([...target.map(p => p.sent), ...target.map(p => p.bounced), ...target.map(p => p.complaints), niceMax(Math.max(...target.map(p => p.sent))), niceMax(Math.max(3, ...target.map(p => Math.max(p.bounced, p.complaints))))], swap)
  if (!n) return <EmptyState title="No activity" />
  const sent = shown.slice(0, n), bounced = shown.slice(n, 2 * n), complaints = shown.slice(2 * n, 3 * n), max = shown[3 * n], outcomeMax = shown[3 * n + 1]
  const compact = width < 520, height = 135, top = 10, bottom = height - 22, left = compact ? 36 : 44, right = width - (compact ? 30 : 44)
  const slot = (right - left) / n, xs = target.map((_, i) => left + (i + 0.5) * slot)
  const ey = (value: number) => bottom - value / max * (bottom - top)
  const band = (bottom - top) * .55, oy = (value: number) => bottom - value / outcomeMax * band
  const firstPartial = n > 3 && Date.parse(data.periodStart) > Date.parse(target[0].at)
  const lastPartial = n > 3 && Date.parse(data.periodEnd) < Date.parse(target[n - 1].at) + bucketOf(target)
  const from = firstPartial ? 1 : 0, to = lastPartial ? n - 2 : n - 1, drawn = (i: number) => i >= from && i <= to
  const span = (values: readonly number[]) => values.slice(from, to + 1)
  const emailsY = sent.map(ey), bounceY = bounced.map(oy), complaintY = complaints.map(oy)
  const marked = target.map((p, i) => ({ bounces: drawn(i) && hourRate(p.bounced, p.sent) >= BOUNCE_LINE, complaints: drawn(i) && p.complaints > 0 }))
  // The end labels, kept 12px apart (thousands as 2.8k where a phone's gutter is narrow).
  const endText = (value: number) => compact && value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : number(value)
  const ends = ([['sent', emailsY[to], target[to].sent], ['bounces', bounceY[to], target[to].bounced], ['complaints', complaintY[to], target[to].complaints]] as const)
    .map(([tone, y, value]) => ({ tone, y, text: endText(value) })).sort((a, b) => a.y - b.y)
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 12)
  // A phone scrubs with a finger: tap or drag sideways (touch-action keeps vertical scrolling for the page).
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    const box = event.currentTarget.getBoundingClientRect()
    setActive(Math.max(0, Math.min(n - 1, Math.floor((event.clientX - box.left - left) / slot))))
  }
  const dot = (x: number, y: number, tone: string, key: string) => <circle key={key} cx={x} cy={y} r={3.5} className={`ov-dot ov-dot--${tone}`} />
  const point = active === null ? undefined : target[active]
  return <div ref={container} className="ov-activity" onMouseLeave={() => setActive(null)} onPointerDown={scrub} onPointerMove={scrub}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Emails per bucket on the left scale; bounces and complaints on their own scale">
      {[0, 1, 2, 3].map(i => { const y = top + i * (bottom - top) / 3; return <g key={i}><line x1={left} x2={right} y1={y} y2={y} className={i === 3 ? 'chart-grid chart-grid--base' : 'chart-grid'} /><text x={left - 8} y={y + 3.5} textAnchor="end" className="chart-label">{number(Math.round(max * (1 - i / 3)))}</text></g> })}
      <path d={`M ${xs[from]} ${bottom} L ${xs[from]} ${emailsY[from]} ${monotone(span(xs), span(emailsY)).join(' ')} L ${xs[to]} ${bottom} Z`} className="ov-wash" />
      <Line xs={span(xs)} ys={span(emailsY)} tone="sent" />
      <Line xs={span(xs)} ys={span(bounceY)} tone="bounces" />
      <Line xs={span(xs)} ys={span(complaintY)} tone="complaints" keep={i => target[from + i].complaints > 0 || target[from + i + 1].complaints > 0} />
      {marked.map((mark, i) => <g key={target[i].at}>{mark.bounces && dot(xs[i], bounceY[i], 'bounces', 'b')}{mark.complaints && dot(xs[i], complaintY[i], 'complaints', 'c')}</g>)}
      {active === null
        ? ends.map(end => <text key={end.tone} x={right + 8} y={end.y + 3.5} className={`chart-label ov-end ov-end--${end.tone}`}>{end.text}</text>)
        : [0, 1, 2, 3].map(i => <text key={i} x={right + 8} y={oy(outcomeMax * (1 - i / 3)) + 3.5} className="chart-label ov-end ov-end--bounces">{number(Math.round(outcomeMax * (1 - i / 3)))}</text>)}
      {active !== null && <g>
        <line x1={xs[active]} x2={xs[active]} y1={top} y2={bottom} className="ov-crosshair" />
        {drawn(active) && <>{dot(xs[active], emailsY[active], 'sent', 'e')}{dot(xs[active], bounceY[active], 'bounces', 'b')}{target[active].complaints > 0 && dot(xs[active], complaintY[active], 'complaints', 'c')}</>}
      </g>}
      {ticks(target, right - left, compact ? 60 : 72).map(i => <text key={i} x={xs[i]} y={height - 6} textAnchor="middle" className="chart-label">{tickLabel(target, i)}</text>)}
      {target.map((p, i) => <rect key={p.at} x={left + i * slot} y={0} width={slot} height={bottom} fill="transparent" data-point={i} tabIndex={i === Math.min(stop ?? n - 1, n - 1) ? 0 : -1} role="button"
        aria-label={`${bucketLabel(target, i)}: ${number(p.sent)} emails, ${p.sent ? percent(p.delivered / p.sent, 1) : '—'} delivered, ${p.bounced} bounced, ${p.complaints} complaints`}
        onMouseEnter={() => setActive(i)} onFocus={() => { setActive(i); setStop(i) }} onBlur={() => setActive(null)}
        onKeyDown={event => { const next = event.key === 'ArrowRight' ? Math.min(n - 1, i + 1) : event.key === 'ArrowLeft' ? Math.max(0, i - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : null; if (next === null) return; event.preventDefault(); event.currentTarget.parentElement?.querySelector<SVGElement>(`[data-point="${next}"]`)?.focus() }} />)}
    </svg>
    {point && active !== null && <Readout point={point} label={bucketLabel(target, active)} style={readoutAt(xs[active], width, compact ? 164 : 204)} />}
  </div>
}
// One readout beside the crosshair, on the side with room for it and never past the plot's edges.
function readoutAt(x: number, width: number, readout: number): CSSProperties {
  const after = x + 12
  return { left: Math.max(0, Math.min(width - readout, after + readout <= width ? after : x - 12 - readout)), width: readout }
}
function Readout({ point: p, label, style }: { point: ChartPoint; label: string; style: CSSProperties }) {
  const bounceRate = p.sent ? p.bounced / p.sent : 0
  return <div className="ov-readout" role="status" style={style}><strong>{label}</strong>
    <span><i className="ov-key--sent" />Emails<b>{number(p.sent)}</b></span>
    <span><i className="ov-key--delivered" />Delivered<b>{p.sent ? percent(p.delivered / p.sent, 1) : '—'}</b></span>
    <span><i className="ov-key--bounces" />Bounced<b>{number(p.bounced)}<em data-zone={zone(hourRate(p.bounced, p.sent), BOUNCE_LINE)}>{p.sent ? percent(bounceRate, 1) : '—'}</em></b></span>
    <span><i className="ov-key--complaints" />Complaints<b>{number(p.complaints)}</b></span>
  </div>
}
