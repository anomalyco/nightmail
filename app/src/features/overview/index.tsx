import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useApi, useApiDef, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import { accountStatus, ratePercent, rateStatus } from '../../lib/reputation'
import { campaignEditable, pendingEmailStatuses, type Campaign, type ChartPoint, type LogEntry, type Overview, type SesDiscovery, type TimeRange } from '../../data/types'
import { DataTable, EmptyState, ErrorState, Icon, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { Crossfade, useMorph, useTween } from '../../components/motion'
import { date, label, number, percent } from '../../lib/format'
import { NextSteps, SidebarScore, StandingCard, useNextSteps, useSenderScore } from '../score'
// `logColumns` here are Overview's compact set of Logs' columns (skeletons.tsx).
import { AsideSkeleton, ChartSkeleton, factTitles, FactTilesSkeleton, latestColumns as logColumns, PanelToggle, RegionStatus, ScoreTileSkeleton } from './skeletons'
import { latestRequest, useLatestRowCount } from './latest'
import { logHref, logRowLabel, useLogRowIntent } from '../logs/rows'
import { routeChunks, usePrefetchQueries } from '../../data/prefetch'
import { warmCampaignEditor } from '../campaigns/composer-content'
import { DailyLimit, useSendingLimitPending, useSetupRead, type SetupRead } from './setup'
import { useCompactShell, useMediaQuery } from '../../lib/media'
import { setPanelHidden } from './panel'
import { DomainSetupAlert } from '../settings/domain-setup-alert'
import { FirstRunStrip, stripSpace, useFirstRun, useStripExit } from './first-run'
import { useSettlingEmail } from '../docs/first-send'

// Overview: is sending healthy? An edge-to-edge console: a 44px control strip (the title, then the range, stream and
// panel toggle), a new workspace's get-started strip (first-run.tsx), one strip of four figures across the page, each a
// link to that mail in Logs; then the activity band over the latest emails (failures first, dense rows down to the
// window's bottom) beside a 296px inspector rail with the standing (Warn and up), the daily limit and why, next steps
// (not while the get-started strip leads) and the recent campaigns. Empty, each panel says so quietly in its own space:
// the figures as one well, the chart a bare baseline, the list a sentence. The sender score is the sidebar's readout;
// where there is no sidebar (the compact shell) it is a row under the figures, so health comes before everything else.
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
  // Where the detail column stacks under the main one (overview.css, 960px), the domain banner leads the page, above the
  // figures. Whether the get-started strip shows (and its steps) is only known once the setup read and the score land:
  // until then the main column holds its skeletons and swaps in whole (new nodes, nothing moves).
  const stacked = useMediaQuery('(max-width: 960px)'), compact = useCompactShell()
  const setup = useSetupRead()
  const detail = useDetail(setup, Boolean(recent.data || recent.isError))
  const [sentHere, setSentHere] = useState(false)
  const firstRun = useFirstRun(setup, detail.score, sentHere)
  const exit = useStripExit(firstRun.workspaceId), stripRow = useRef<HTMLDivElement>(null)
  const strip = firstRun.show && !exit.gone
  // Next steps stay out for this visit once the strip has led it, so the rail never grows under a leaving strip.
  const led = useRef(false)
  if (firstRun.show) led.current = true
  const held = (stacked && setup.loading) || firstRun.pending
  // Latest emails and the figures above it must agree: when a new email (or a new outcome for one) shows in the list,
  // the figures are read again (unless metrics already failed, so we never hammer an over-budget query).
  const count = useLatestRowCount(strip ? stripSpace() : 0)
  // A stream picked in the header scopes Latest emails too: its sent mail (received mail has no stream).
  const latestParams = latestRequest(regionId, stream)
  const latest = useApiDef(queries.logs(latestParams), { interval: 60_000, keepPrevious: sameRegion(regionId) })
  const head = latest.data?.items.slice(0, 7).map(row => `${row.id}:${row.status}`).join(',')
  const seen = useRef<string | undefined>(undefined)
  const refetch = query.refetch
  const metricsFailed = query.isError
  useEffect(() => { if (head === undefined) return; if (seen.current !== undefined && seen.current !== head && !metricsFailed) void refetch(); seen.current = head }, [head, refetch, metricsFailed])
  // An email sent moments ago and still on its way (onboarding's test, say) is read alone until it settles, so Delivered
  // shows in seconds, not at the next minute's read; the list (and with it the figures) then reads again.
  const settling = latest.data?.items.find(row => row.direction === 'sent' && pendingEmailStatuses.includes(row.status) && Date.now() - Date.parse(row.at) < 120_000)
  useSettlingEmail(settling?.id, () => void latest.refetch())
  const latestEmails = <LatestEmails params={latestParams} count={count} reserve={!stacked} held={held} range={range} figures={data} figuresFailed={query.isError} />
  const failed = query.isError && !data
  return <div className="ov-page">
    <PageHeader className="ov-strip" title="Overview" actions={<>{controls}<PanelToggle /></>} />
    {strip && <div ref={stripRow} className="ov-lead"><FirstRunStrip setup={setup} done={firstRun.done} onSent={() => setSentHere(true)} onLeave={how => { if (stripRow.current) exit.leave(stripRow.current, how) }} /></div>}
    {/* With the main column, never before it: the strip (if any) is known first and goes above them. */}
    {stacked && !held && setup.stuck && <div className="ov-lead"><DomainSetupAlert domain={setup.stuck.domain} gap={setup.stuck.gap} /></div>}
    {stacked && !held && setup.error ? <div className="ov-lead"><ErrorState error={setup.error} onRetry={setup.retry} /></div> : null}
    <Fragment key={held ? 'held' : 'ready'}>
      {/* The score has its own read: it neither waits for the figures nor dims with them. */}
      {failed ? <div className="ov-lead"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>
        : <div className="ov-kpis" role="group" aria-label="Figures" data-stale={query.isPlaceholderData || undefined}>{data && !held ? <Facts data={data} range={range} stream={stream} fresh={firstRun.empty && firstRun.show} /> : <FactTilesSkeleton />}{compact && (held ? <ScoreTileSkeleton /> : <SidebarScore />)}</div>}
    </Fragment>
    <div key={held ? 'split-held' : 'split-ready'} className="ov-split">
      <div className="ov-split__main">
        <Fragment key={held ? 'held' : 'ready'}>
          {failed ? null : data && !held ? <Chart data={data} stale={query.isPlaceholderData} /> : <ChartSkeleton />}
          {!stacked && latestEmails}
        </Fragment>
      </div>
      <Aside setup={setup} detail={detail} showSetup={!stacked} showNext={!led.current} placeholder={!stacked} campaigns={recent.data?.items} range={range} />
      {/* Under the rail, once that rail has its final height (its own reads and the figures' campaigns). */}
      {stacked && detail.ready && (data || query.isError) ? latestEmails : null}
    </div>
  </div>
}

// What the detail column shows, and whether all of it is known (the page also waits on this to place the list under it).
function useDetail(setup: SetupRead, recentReady: boolean) {
  const score = useSenderScore()
  const next = useNextSteps(score.data)
  const limitPending = useSendingLimitPending()
  return { score, next, ready: Boolean((score.data || score.isError) && !setup.loading && next.ready && !limitPending && recentReady) }
}
// The detail column renders in one go once setup, the score and the next steps are known, so nothing in it moves.
// The standing card (Warn and up) leads it; the banner's fix link and the sidebar score scroll here by hash. Recent
// campaigns come with the overview's figures and close the column, so arriving later moves nothing above them.
// In one column it has no placeholder while it loads: it sits under the chart there, in view, and may turn out empty
// (a new workspace's strip leads the page instead), so it takes up room only once it has something to show.
function Aside({ setup, detail: { score, next, ready }, showSetup, showNext, placeholder, campaigns, range }: { setup: SetupRead; detail: ReturnType<typeof useDetail>; showSetup: boolean; showNext: boolean; placeholder: boolean; campaigns?: Overview['recentCampaigns']; range: TimeRange }) {
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
    {showSetup && setup.error ? <ErrorState error={setup.error} onRetry={setup.retry} /> : null}
    {compact ? null : score.isError && !score.data ? <ErrorState error={score.error} onRetry={() => score.refetch()} /> : !multiTenant && <SidebarScore />}
    <DailyLimit report={score.data} />
    {/* Next steps follow setup: never while it is unknown, nor while the get-started strip leads the page. */}
    {showNext && !setup.error && next.items.length > 0 && <section className="ov-rail-section" aria-labelledby="overview-next"><h2 id="overview-next" className="ov-label">Next steps</h2><NextSteps items={next.items.map(item => ({ ...item, to: logsHref(item.to, range) }))} /></section>}
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
// No mail in the period: the four wells are one quiet well that says so in their place (a new workspace's: none yet).
const periods: Record<TimeRange, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' }
function Facts({ data, range, stream, fresh }: { data: Overview; range: TimeRange; stream: 'all' | 'transactional' | 'marketing'; fresh: boolean }) {
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
  if (!data.sent) return <div className="ov-kpi ov-kpi--empty" role="status"><div className="ov-kpi__head"><span>{factTitles[0]}</span></div><p>{fresh ? 'No emails yet.' : `No ${stream === 'all' ? '' : `${stream} `}emails in ${periods[range]}.`}</p></div>
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
// Group granular buckets (144–180 points) into up to 24 crisp bars for the KPI mini-sparkbars.
function downsample(values: number[], bars = 24) {
  if (values.length <= bars) return values
  const out = new Array<number>(bars).fill(0)
  for (let i = 0; i < values.length; i++) out[Math.min(bars - 1, Math.floor(i * bars / values.length))] += values[i]
  return out
}
// SVG, so a range with another count of buckets redraws the columns instead of moving boxes.
function Columns({ values: raw, tone }: { values: number[]; tone: 'sent' | 'delivered' }) {
  const values = useMorph(downsample(raw), swap)
  const max = Math.max(1, ...values), slot = 100 / Math.max(1, values.length)
  return <svg className={`ov-columns ov-columns--${tone}`} viewBox="0 0 100 26" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
    {values.map((value, i) => { const h = value > 0 ? Math.max(5, value / max * 26) : 0; return h > 0 && <rect key={i} x={i * slot} width={slot * .78} y={26 - h} height={h} /> })}
  </svg>
}

function Chart({ data, stale }: { data: Overview; stale: boolean }) {
  return <section className="ov-chart" aria-label="Sending activity" data-stale={stale || undefined}>
    <div className="ov-chart__head"><span className="ov-label">Activity</span><span className="ov-legend" aria-hidden="true" data-hidden={!data.sent || undefined}><span><i className="ov-key--sent" />Emails</span><span><i className="ov-key--bounces" />Bounced</span><span><i className="ov-key--complaints" />Complaints</span></span></div>
    {/* Nothing to draw: the period's time axis alone, since the figures above already say there was no mail. */}
    <Crossfade id={data.sent ? buckets(data.points) : 'empty'} className="ov-chart__plot"><ActivityChart data={data} empty={!data.sent} /></Crossfade>
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
    {logs.isError && !logs.data ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : <Crossfade id={logs.data && settled ? rows.map(row => `${row.direction}:${row.id}:${row.status}`).join(',') : undefined}><DataTable<LogEntry> className="logs-table ov-table" loading={logs.isPending || held || !settled} skeletonRows={count} minRows={reserve ? count : 0} rows={rows} rowKey={row => `${row.direction}:${row.id}`} rowHref={logHref} rowLabel={logRowLabel} onRowIntent={rowIntent} empty={<p className="ov-latest__empty">Emails you send and receive show here.</p>} columns={logColumns} /></Crossfade>}
  </section>
}
// Up to three, in the detail column's list style: the name, then how it went (or its status while not sent).
function Campaigns({ rows }: { rows: Campaign[] }) {
  const api = useApi()
  const cache = useQueryClient()
  const warm = usePrefetchQueries()
  return <nav className="next-steps ov-campaigns" aria-label="Recent campaigns">
    <div className="ov-campaigns__head"><h2 className="ov-label">Campaigns</h2><Link className="ui-button ui-button--ghost ui-button--sm" to="/campaigns">All <Icon icon={ArrowUpRight} size="sm" /></Link></div>
    <ul>{rows.map((row, i) => { const sent = ['sent', 'done'].includes(row.status), intent = () => { if (!row.archivedAt && campaignEditable(row)) void warmCampaignEditor(cache, api, row.id); else void warm([queries.campaign(row.id)]) }
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
  return <Link className="overview-reputation" to={`/settings?region=${encodeURIComponent(regionId)}`} title="SES account reputation">
    <span className="muted">SES</span>{worst && <StatusBadge status={worst.label} tone={worst.tone} />}<span className="muted">{ratePercent(reputation.bounceRate)} bounce · {ratePercent(reputation.complaintRate)} complaint</span>
  </Link>
}

// Three whole-number steps with ~10% headroom so peaks breathe cleanly below the top gridline.
// Light 3-bucket centered smoothing [0.25, 0.5, 0.25] for display only (tooltip always reads raw bucket counts).
function smoothSeries(values: number[]) {
  if (values.length < 4) return values
  return values.map((v, i) => i === 0 ? 0.75 * v + 0.25 * values[1] : i === values.length - 1 ? 0.25 * values[i - 1] + 0.75 * v : 0.25 * values[i - 1] + 0.5 * v + 0.25 * values[i + 1])
}
function niceMax(value: number) {
  const padded = Math.max(1, value) * 1.1
  const raw = padded / 3, base = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => Math.round(m * base * 1e6) / 1e6).find(m => m >= raw && Number.isInteger(m)) ?? Math.ceil(raw)
  return step * 3
}
const axisNumber = (value: number, compact: boolean) => {
  const v = Math.round(value)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= (compact ? 1_000 : 10_000)) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`
  return number(v)
}
const HOUR = 3_600_000, DAY = 86_400_000
const bucketOf = (points: ChartPoint[]) => points.length > 1 ? Math.max(60_000, Date.parse(points[1].at) - Date.parse(points[0].at)) : HOUR
const clock = (at: string | number) => date(typeof at === 'number' ? new Date(at).toISOString() : at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const day = (at: string | number) => date(typeof at === 'number' ? new Date(at).toISOString() : at, { month: 'short', day: 'numeric', timeZone: 'UTC' })
function bucketLabel(points: ChartPoint[], i: number, domainStart: number, domainEnd: number) {
  const step = bucketOf(points), start = Math.max(domainStart, Date.parse(points[i].at)), end = Math.min(domainEnd, Date.parse(points[i].at) + step)
  if (step >= DAY) return day(start)
  return `${day(start)}, ${clock(start)}–${clock(end)} UTC`
}
// Time ticks on round UTC boundaries across the exact [domainStart, domainEnd] domain, plus "Now" at the right edge
// when the final round tick leaves room.
function domainTicks(domainStart: number, domainEnd: number, left: number, right: number, minGap: number) {
  const span = Math.max(1, domainEnd - domainStart), plotWidth = Math.max(1, right - left)
  const steps = span <= 2 * DAY ? [1, 2, 3, 4, 6, 12].map(h => h * HOUR)
    : span <= 10 * DAY ? [12 * HOUR, DAY, 2 * DAY, 3 * DAY]
    : [2, 3, 5, 7, 10].map(d => d * DAY)
  const step = steps.find(s => (s / span) * plotWidth >= minGap) ?? steps[steps.length - 1]
  const xOf = (ms: number) => left + ((ms - domainStart) / span) * plotWidth
  const out: { key: string; x: number; text: string; anchor: 'start' | 'middle' | 'end' }[] = []
  const first = Math.ceil(domainStart / step) * step
  for (let ms = first; ms <= domainEnd; ms += step) {
    const x = xOf(ms)
    const text = step >= DAY || ms % DAY === 0 ? day(ms) : clock(ms)
    const anchor = x - left < 24 ? 'start' : right - x < 24 ? 'end' : 'middle'
    out.push({ key: String(ms), x, text, anchor })
  }
  const firstTick = out[0]
  if (!firstTick || firstTick.x - left >= 52) {
    out.unshift({ key: 'start', x: left, text: span <= 2 * DAY ? clock(domainStart) : day(domainStart), anchor: 'start' })
  }
  const last = out.at(-1)
  if (!last || right - last.x >= 44) out.push({ key: 'now', x: right, text: 'Now', anchor: 'end' })
  return out
}
// Fritsch–Carlson monotone cubic interpolation: clamping (alpha, beta) to alpha^2 + beta^2 <= 9 guarantees the curve
// passes through every point with zero overshoot above peaks and zero dip below the baseline.
function monotone(xs: number[], ys: number[], minY: number, maxY: number) {
  const m = ys.length - 1
  if (m <= 0) return []
  const dx = Array.from({ length: m }, (_, i) => Math.max(1e-6, xs[i + 1] - xs[i]))
  const slopes = Array.from({ length: m }, (_, i) => (ys[i + 1] - ys[i]) / dx[i])
  const tangents = ys.map((_, i) => i === 0 ? slopes[0] : i === m ? slopes[m - 1]
    : slopes[i - 1] * slopes[i] <= 0 ? 0 : 2 * slopes[i - 1] * slopes[i] / (slopes[i - 1] + slopes[i]))
  for (let i = 0; i < m; i++) {
    const s = slopes[i]
    if (s === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue }
    const a = tangents[i] / s, b = tangents[i + 1] / s, mag = Math.hypot(a, b)
    if (mag > 3) { const k = 3 / mag; tangents[i] = k * a * s; tangents[i + 1] = k * b * s }
  }
  const clamp = (y: number) => Math.max(minY, Math.min(maxY, y))
  return slopes.map((_, i) => {
    const third = dx[i] / 3
    return `C ${(xs[i] + third).toFixed(2)} ${clamp(ys[i] + tangents[i] * third).toFixed(2)} ${(xs[i + 1] - third).toFixed(2)} ${clamp(ys[i + 1] - tangents[i + 1] * third).toFixed(2)} ${xs[i + 1].toFixed(2)} ${ys[i + 1].toFixed(2)}`
  })
}
// keep(i) drops the segment from point i to i + 1: the complaints line only rises where there is one, and never runs
// along the baseline in red between them.
function Line({ xs, ys, minY, maxY, tone, keep = () => true }: { xs: number[]; ys: number[]; minY: number; maxY: number; tone: 'sent' | 'bounces' | 'complaints'; keep?: (i: number) => boolean }) {
  let path = '', end = -1
  monotone(xs, ys, minY, maxY).forEach((segment, i) => { if (!keep(i)) return; if (end !== i) path += `M ${xs[i].toFixed(2)} ${ys[i].toFixed(2)} `; path += segment + ' '; end = i + 1 })
  return path ? <path d={path} className={`ov-line ov-line--${tone}`} /> : null
}
// The activity chart: spans the exact [periodStart, periodEnd] window end to end (left edge to right edge "Now"), with
// missing buckets zero-filled so there are no gaps or cutoffs. Emails draw as a smooth monotone line with a subtle wash
// scaled strictly to visible data; bounces and complaints appear as count-scaled baseline markers only in buckets where
// they are > 0, and a hover crosshair + readout inspect exact raw bucket counts. New counts over the same buckets morph.
function ActivityChart({ data, empty = false }: { data: Overview; empty?: boolean }) {
  const target = data.points
  const washId = useId()
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
  const step = bucketOf(target)
  const rawSent = target.map(p => p.sent)
  // Smooth 10-minute buckets (24h) lightly for display only; keep 1h/4h spikes exact and tooltip always raw.
  const plotSent = step < HOUR ? smoothSeries(rawSent) : rawSent
  const visibleSentMax = Math.max(0, ...plotSent)
  const shown = useMorph([...plotSent, niceMax(visibleSentMax)], swap)
  if (!n && !empty) return <EmptyState title="No activity" />
  const sent = shown.slice(0, n), max = Math.max(1, shown[n])
  const compact = width < 520, height = 135, top = 10, bottom = height - 22, left = compact ? 38 : 48, right = width - (compact ? 26 : 36)
  const domainStart = Date.parse(data.periodStart), domainEnd = Math.max(domainStart + 1, Date.parse(data.periodEnd))
  const spanMs = domainEnd - domainStart, plotWidth = Math.max(1, right - left)
  const xOf = (ms: number) => left + ((ms - domainStart) / spanMs) * plotWidth
  // Anchor first bucket to left edge (periodStart) and latest bucket to right edge (now); interior buckets sit at their
  // exact proportional bucket center so round clock ticks align mathematically with the series.
  const xs = n === 1 ? [right] : target.map((p, i) => i === 0 ? left : i === n - 1 ? right : Math.max(left + 0.01, Math.min(right - 0.01, xOf(Date.parse(p.at) + step / 2))))
  const ey = (value: number) => bottom - Math.max(0, Math.min(1, value / max)) * (bottom - top)
  const emailsY = sent.map(ey)
  const pipRadius = (count: number, base: number, cap: number) => Math.min(cap, base + Math.log2(Math.max(1, count)) * 0.65)
  const lastIdx = n - 1
  const nearest = (clientX: number, boxLeft: number) => {
    const x = clientX - boxLeft
    let best = 0, dist = Math.abs(xs[0] - x)
    for (let i = 1; i < n; i++) { const d = Math.abs(xs[i] - x); if (d < dist) { dist = d; best = i } }
    return best
  }
  // A phone scrubs with a finger: tap or drag sideways (touch-action keeps vertical scrolling for the page).
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    const box = event.currentTarget.getBoundingClientRect()
    setActive(nearest(event.clientX, box.left))
  }
  const dot = (x: number, y: number, tone: string, key: string, r = 2.75) => <circle key={key} cx={x} cy={y} r={r} className={`ov-dot ov-dot--${tone}`} />
  const point = active === null ? undefined : target[active]
  if (empty) return <div ref={container} className="ov-activity">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="No emails in this period">
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="chart-grid chart-grid--base" />
      {domainTicks(domainStart, domainEnd, left, right, compact ? 64 : 84).map(t => <text key={t.key} x={t.x} y={height - 6} textAnchor={t.anchor} className="chart-label">{t.text}</text>)}
    </svg>
  </div>
  const washPath = n > 1 ? `M ${xs[0].toFixed(2)} ${bottom} L ${xs[0].toFixed(2)} ${emailsY[0].toFixed(2)} ${monotone(xs, emailsY, top, bottom).join(' ')} L ${xs[lastIdx].toFixed(2)} ${bottom} Z` : ''
  return <div ref={container} className="ov-activity" onMouseLeave={() => setActive(null)} onPointerDown={scrub} onPointerMove={scrub}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Emails per bucket; bounces and complaints marked on the baseline where present">
      <defs>
        <linearGradient id={washId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="ov-wash-stop ov-wash-stop--top" />
          <stop offset="100%" className="ov-wash-stop ov-wash-stop--bot" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map(i => { const y = top + i * (bottom - top) / 3; return <g key={i}><line x1={left} x2={right} y1={y} y2={y} className={i === 3 ? 'chart-grid chart-grid--base' : 'chart-grid'} /><text x={left - 8} y={y + 3.5} textAnchor="end" className="chart-label">{axisNumber(max * (1 - i / 3), compact)}</text></g> })}
      {washPath && <path d={washPath} fill={`url(#${washId})`} className="ov-wash" />}
      <Line xs={xs} ys={emailsY} minY={top} maxY={bottom} tone="sent" />
      {target.map((p, i) => <g key={p.at}>
        {p.bounced > 0 && dot(xs[i], bottom - 3.5, 'bounces', 'b', pipRadius(p.bounced, 2.3, 4.4))}
        {p.complaints > 0 && dot(xs[i], p.bounced > 0 ? bottom - 11 : bottom - 3.5, 'complaints', 'c', pipRadius(p.complaints, 2.8, 4.8))}
      </g>)}
      {active === null && <text x={right + 8} y={emailsY[lastIdx] + 3.5} className="chart-label ov-end ov-end--sent">{axisNumber(target[lastIdx].sent, compact)}</text>}
      {active !== null && <g>
        <line x1={xs[active]} x2={xs[active]} y1={top} y2={bottom} className="ov-crosshair" />
        {dot(xs[active], emailsY[active], 'sent', 'e', 3.25)}
        {target[active].bounced > 0 && dot(xs[active], bottom - 3.5, 'bounces', 'b', Math.max(3.4, pipRadius(target[active].bounced, 2.3, 4.4)))}
        {target[active].complaints > 0 && dot(xs[active], target[active].bounced > 0 ? bottom - 11 : bottom - 3.5, 'complaints', 'c', Math.max(3.6, pipRadius(target[active].complaints, 2.8, 4.8)))}
      </g>}
      {domainTicks(domainStart, domainEnd, left, right, compact ? 64 : 84).map(t => <text key={t.key} x={t.x} y={height - 6} textAnchor={t.anchor} className="chart-label">{t.text}</text>)}
      {target.map((p, i) => {
        const x0 = i === 0 ? left : (xs[i - 1] + xs[i]) / 2, x1 = i === lastIdx ? right : (xs[i] + xs[i + 1]) / 2
        return <rect key={p.at} x={x0} y={0} width={Math.max(1, x1 - x0)} height={bottom} fill="transparent" data-point={i} tabIndex={i === Math.min(stop ?? lastIdx, lastIdx) ? 0 : -1} role="button"
          aria-label={`${bucketLabel(target, i, domainStart, domainEnd)}: ${number(p.sent)} emails, ${p.sent ? percent(p.delivered / p.sent, 1) : '—'} delivered, ${p.bounced} bounced, ${p.complaints} complaints`}
          onMouseEnter={() => setActive(i)} onFocus={() => { setActive(i); setStop(i) }} onBlur={() => setActive(null)}
          onKeyDown={event => { const next = event.key === 'ArrowRight' ? Math.min(lastIdx, i + 1) : event.key === 'ArrowLeft' ? Math.max(0, i - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? lastIdx : null; if (next === null) return; event.preventDefault(); event.currentTarget.parentElement?.querySelector<SVGElement>(`[data-point="${next}"]`)?.focus() }} />
      })}
    </svg>
    {point && active !== null && <Readout point={point} label={bucketLabel(target, active, domainStart, domainEnd)} style={readoutAt(xs[active], width, compact ? 176 : 220)} />}
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