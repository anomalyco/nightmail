import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { ChartPoint, Overview, TimeRange } from '../../data/types'
import { date, number, percent } from '../../lib/format'
import { EmptyState, Skeleton } from '../../components/ui'

// Pitch (?chart=a|b|c): three takes on Overview's figures and activity chart as one block. A: solid blocks (tiles with
// segmented limit gauges, thick stacked columns with flags). B: lanes (the figures become lane headers over one time axis:
// volume as a step area, the bounce rate against its limit, complaint pins). C: pulse (cards of hourly limit cells, a
// dense 15-minute histogram with a readout row).
export const BOUNCE_LINE = 0.05, COMPLAINT_LINE = 0.001
export const NO_EMAILS = 'No emails in this period'
// An hour's rate is only read with enough mail for it to mean something: one bounce in four emails is not a trend.
const BAND_VOLUME = 20
const HOUR = 3_600_000, DAY = 86_400_000

// a2 and a3 keep A's tiles and fat bars, but the bars carry volume only: a2 puts problems in a strip of hourly cells
// under the axis, a3 tags the hours with problems above their bars.
// l1 and l2 keep A's tiles and draw the activity as lines: l1 puts bounces and complaints on their own small count
// scale in the same plot, l2 puts the rates, as a share of their limits, in a slim panel under the emails line.
const variants = ['a', 'a2', 'a3', 'l1', 'l2', 'b', 'c'] as const
export type ChartVariant = typeof variants[number]
export const chartVariant = (value: string | null): ChartVariant | null => variants.find(variant => variant === value) ?? null
export type BlocksMode = 'stack' | 'strip' | 'pins' | 'l1' | 'l2'
const blocksModes: Partial<Record<ChartVariant, BlocksMode>> = { a: 'stack', a2: 'strip', a3: 'pins', l1: 'l1', l2: 'l2' }
export const blocksMode = (variant: ChartVariant | null) => variant ? blocksModes[variant] : undefined
export const blocksVariant = (variant: ChartVariant | null) => blocksMode(variant) !== undefined
export function useChartVariant() { const [params] = useSearchParams(); return chartVariant(params.get('chart')) }
// The block's height above Latest emails (latest.ts): facts, the 20px gap and the chart, or B's single block.
export const blockHeight = (variant: ChartVariant | null) => blocksVariant(variant) ? 104 + 20 + 220 : variant === 'b' ? 278 : variant === 'c' ? 84 + 20 + 220 : 81 + 20 + 220

const share = (part: number, whole: number) => whole ? part / whole : 0
const rateText = (rate: number) => rate > 0 && rate < 0.0001 ? percent(rate, 3) : percent(rate, 2)
const limitText = (limit: number) => percent(limit, limit < 0.01 ? 1 : 0)
type Zone = 'ok' | 'near' | 'over'
const zone = (rate: number, limit: number): Zone => rate >= limit ? 'over' : rate >= limit / 2 ? 'near' : 'ok'
const hourRate = (part: number, sent: number) => sent >= BAND_VOLUME ? part / sent : 0
function niceMax(value: number) { const raw = Math.max(1, value) / 3, base = 10 ** Math.floor(Math.log10(raw)), step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * base).find(m => m >= raw && Number.isInteger(m)) ?? Math.ceil(raw); return step * 3 }
const bucketOf = (points: ChartPoint[]) => points.length > 1 ? Date.parse(points[1].at) - Date.parse(points[0].at) : HOUR
const clock = (at: string) => date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const day = (at: string) => date(at, { month: 'short', day: 'numeric', timeZone: 'UTC' })
function bucketLabel(points: ChartPoint[], i: number) {
  const at = points[i].at, bucket = bucketOf(points)
  if (bucket >= DAY) return day(at)
  return bucket < HOUR ? `${day(at)}, ${clock(at)}–${clock(new Date(Date.parse(at) + bucket).toISOString())} UTC` : `${day(at)}, ${clock(at)} UTC`
}
// Time ticks on whole steps (3 h, 6 h, a day…) at least minGap apart; midnight is labelled with its date.
function ticks(points: ChartPoint[], plotWidth: number, minGap: number) {
  if (points.length < 2) return points.length ? [0] : []
  const bucket = bucketOf(points), slot = plotWidth / points.length
  const steps = bucket >= DAY ? [1, 2, 3, 5, 7, 10, 15].map(d => d * DAY) : [1, 2, 3, 4, 6, 12, 24, 48].map(h => h * HOUR)
  const step = steps.find(s => s / bucket * slot >= minGap) ?? steps[steps.length - 1]
  return points.flatMap((point, i) => Date.parse(point.at) % step === 0 ? [i] : [])
}
const tickLabel = (points: ChartPoint[], i: number) => bucketOf(points) >= DAY || Date.parse(points[i].at) % DAY === 0 ? day(points[i].at) : clock(points[i].at)

function useWidth<T extends Element>(initial: number) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initial)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(Math.max(1, element.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

// The buckets as one tab stop (the last focused, else the newest); arrows, Home and End step between them.
function Hits({ points, x, width, top, height, onActive }: { points: ChartPoint[]; x: (i: number) => number; width: number; top: number; height: number; onActive: (i: number | null) => void }) {
  const [stop, setStop] = useState<number | null>(null)
  const count = points.length
  return <g>{points.map((p, i) => <rect key={p.at} x={x(i)} y={top} width={Math.max(0, width)} height={Math.max(0, height)} fill="transparent" data-point={i} data-at={p.at} tabIndex={i === Math.min(stop ?? count - 1, count - 1) ? 0 : -1} role="button"
    aria-label={`${bucketLabel(points, i)}: ${number(p.sent)} emails, ${p.bounced} bounced, ${p.complaints} complaints`}
    onMouseEnter={() => onActive(i)} onClick={() => onActive(i)} onFocus={() => { onActive(i); setStop(i) }} onBlur={() => onActive(null)}
    onKeyDown={event => { const next = event.key === 'ArrowRight' ? Math.min(count - 1, i + 1) : event.key === 'ArrowLeft' ? Math.max(0, i - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null; if (next === null) return; event.preventDefault(); event.currentTarget.parentElement?.querySelector<SVGElement>(`[data-point="${next}"]`)?.focus() }} />)}</g>
}

type FigureKey = 'sent' | 'delivered' | 'bounces' | 'complaints'
type Figure = { key: FigureKey; title: string; value: string; hint: string; series: number[]; rate?: number; limit?: number; rates?: number[] }
function figures(data: Overview): Figure[] {
  const change = data.previousSent ? (data.sent - data.previousSent) / data.previousSent : undefined
  const points = data.points, bounced = share(data.bounced, data.sent), complained = share(data.complaints, data.sent)
  return [
    { key: 'sent', title: 'Emails', value: number(data.sent), hint: change === undefined ? '' : `${change >= 0 ? '+' : ''}${percent(change, 0)}`, series: points.map(p => p.sent) },
    { key: 'delivered', title: 'Delivered', value: data.sent ? percent(share(data.delivered, data.sent)) : '—', hint: number(data.delivered), series: points.map(p => p.delivered) },
    { key: 'bounces', title: 'Bounced', value: data.sent ? rateText(bounced) : '—', hint: number(data.bounced), series: points.map(p => p.bounced), rate: bounced, limit: BOUNCE_LINE, rates: points.map(p => hourRate(p.bounced, p.sent)) },
    { key: 'complaints', title: 'Complaints', value: data.sent ? rateText(complained) : '—', hint: number(data.complaints), series: points.map(p => p.complaints), rate: complained, limit: COMPLAINT_LINE, rates: points.map(p => p.complaints && p.sent ? Math.max(hourRate(p.complaints, p.sent), COMPLAINT_LINE) : 0) },
  ]
}
const ofLimit = (rate: number, limit: number) => `${Math.max(rate > 0 ? 1 : 0, Math.round(rate / limit * 100))}% of limit`

// Right-aligned text whose width changes (a count, a readout): laid out from its cell's right edge and pulled back by
// its own width (a transform), so a new value never moves its box.
function Right({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `pitch-right ${className}` : 'pitch-right'}><span>{children}</span></span>
}
function Legend({ items, lines = false }: { items: Array<[FigureKey, string]>; lines?: boolean }) {
  return <span className={lines ? 'pitch-legend pitch-legend--lines' : 'pitch-legend'} aria-hidden="true">{items.map(([key, text]) => <span key={key}><i className={`pitch-key pitch-key--${key}`} />{text}</span>)}</span>
}
function Tip({ points, i, side, deliveredShare = false }: { points: ChartPoint[]; i: number; side: CSSProperties; deliveredShare?: boolean }) {
  const p = points[i]
  return <div className="pitch-tip" role="status" style={side}><strong>{bucketLabel(points, i)}</strong>
    <span><i className="pitch-key pitch-key--sent" />Emails<b>{number(p.sent)}</b></span>
    <span><i className="pitch-key pitch-key--delivered" />Delivered<b>{deliveredShare ? p.sent ? percent(share(p.delivered, p.sent), 1) : '—' : number(p.delivered)}</b></span>
    <span><i className="pitch-key pitch-key--bounces" />Bounced<b>{number(p.bounced)}<em data-zone={zone(hourRate(p.bounced, p.sent), BOUNCE_LINE)}>{p.sent ? percent(share(p.bounced, p.sent), 1) : '—'}</em></b></span>
    <span><i className="pitch-key pitch-key--complaints" />Complaints<b>{number(p.complaints)}</b></span>
  </div>
}

// ── A · Blocks ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Four tiles; a rate's tile is a 20-cell gauge that ends at its limit (each cell a twentieth of it), navy below half
// the limit, amber from half, red at the limit. Volume tiles are the same blocks as the chart's columns.
export function FactsA({ data, stale }: { data: Overview; stale: boolean }) {
  return <div className="pa-tiles" role="group" aria-label="Figures" data-stale={stale || undefined}>{figures(data).map(fact => {
    const z = fact.limit !== undefined ? zone(fact.rate ?? 0, fact.limit) : undefined
    return <div key={fact.key} className="pa-tile" data-zone={z}>
      <div className="pa-tile__head"><span>{fact.title}</span><Right className="pa-tile__hint">{fact.hint}</Right></div>
      <div className="pa-tile__value">{fact.value}</div>
      <div className="pa-tile__viz">{fact.limit !== undefined ? <Gauge rate={fact.rate ?? 0} limit={fact.limit} label={`${fact.title} rate`} /> : <Columns values={fact.series} kind={fact.key} />}</div>
    </div>
  })}</div>
}
function Gauge({ rate, limit, label }: { rate: number; limit: number; label: string }) {
  const lit = rate > 0 ? Math.min(20, Math.max(1, Math.ceil(rate / limit * 20))) : 0
  return <><span className="pa-gauge" data-zone={zone(rate, limit)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={rate}>{Array.from({ length: 20 }, (_, i) => <i key={i} data-on={i < lit || undefined} />)}</span>
    <span className="pa-gauge__caption"><span>{ofLimit(rate, limit)}</span><span>{limitText(limit)} limit</span></span></>
}
// Cells drawn in SVG, so a new range (another count of buckets) redraws them instead of moving boxes.
function Cells({ fills, zones, track = false, ratio, className }: { fills: number[]; zones?: Array<string | undefined>; track?: boolean; ratio: number; className: string }) {
  const slot = 100 / Math.max(1, fills.length), width = slot * ratio
  return <svg className={className} viewBox="0 0 100 20" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">{fills.map((fill, i) => <g key={i}>
    {track && <rect x={i * slot} width={width} y={0} height={20} className="pitch-cell-track" />}
    {fill > 0 && <rect x={i * slot} width={width} y={20 - Math.max(1.5, Math.min(1, fill) * 20)} height={Math.max(1.5, Math.min(1, fill) * 20)} className="pitch-cell" data-zone={zones?.[i]} />}
  </g>)}</svg>
}
function Columns({ values, kind }: { values: number[]; kind: FigureKey }) {
  const max = Math.max(1, ...values)
  return <Cells className={`pa-columns pa-columns--${kind}`} fills={values.map(value => Math.max(value ? 0.2 : 0, value / max))} ratio={0.78} />
}
export function FactsSkeletonA() {
  return <div className="pa-tiles" aria-hidden="true">{['Emails', 'Delivered', 'Bounced', 'Complaints'].map(title => <div key={title} className="pa-tile">
    <div className="pa-tile__head"><span>{title}</span></div><div className="pa-tile__value"><Skeleton width={88} height={20} /></div><div className="pa-tile__viz"><span className="pa-skeleton" /></div>
  </div>)}</div>
}

export function ChartA({ data, range, stale, mode = 'stack' }: { data: Overview; range: TimeRange; stale: boolean; mode?: BlocksMode }) {
  const lines = mode === 'l1' || mode === 'l2'
  return <section className="ov-chart pa-chart" aria-label="Sending activity" data-stale={stale || undefined} data-range={range}>
    <div className="ov-chart__head"><h2 className="ui-label ui-label--rule">Activity</h2><Legend lines={lines} items={[['sent', mode === 'stack' ? 'Delivered' : 'Emails'], ['bounces', 'Bounced'], ['complaints', 'Complaints']]} /></div>
    <div className="ov-chart__plot">{!data.sent ? <EmptyState title={NO_EMAILS} /> : mode === 'stack' ? <StackPlot points={data.points} /> : lines ? <LinePlot data={data} mode={mode} /> : <VolumePlot points={data.points} mode={mode} />}</div>
  </section>
}

// Monotone cubic segments through the points (one "C" command per gap): the curve passes through every value without
// overshooting a peak or dipping under zero, and a flat run stays flat.
function monotone(xs: number[], ys: number[]) {
  const slopes = ys.slice(1).map((y, i) => (y - ys[i]) / (xs[i + 1] - xs[i]))
  const tangents = ys.map((_, i) => i === 0 ? slopes[0] ?? 0 : i === ys.length - 1 ? slopes[i - 1] : slopes[i - 1] * slopes[i] <= 0 ? 0 : 2 * slopes[i - 1] * slopes[i] / (slopes[i - 1] + slopes[i]))
  return slopes.map((_, i) => { const third = (xs[i + 1] - xs[i]) / 3; return `C ${xs[i] + third} ${ys[i] + tangents[i] * third} ${xs[i + 1] - third} ${ys[i + 1] - tangents[i + 1] * third} ${xs[i + 1]} ${ys[i + 1]}` })
}
// A line through the drawn buckets; keep(i) drops the segment from bucket i to i + 1 (an outcome's line only rises
// where it has something, and never runs along the baseline between).
function Line({ xs, ys, kind, keep = () => true }: { xs: number[]; ys: number[]; kind: FigureKey; keep?: (i: number) => boolean }) {
  let path = '', end = -1
  monotone(xs, ys).forEach((segment, i) => { if (!keep(i)) return; if (end !== i) path += `M ${xs[i]} ${ys[i]} `; path += segment + ' '; end = i + 1 })
  return path ? <path d={path} className={`pl-line pl-line--${kind}`} /> : null
}
// l1 and l2. Emails are a navy line over a flat navy wash. The window's first and last buckets are still partly counted
// (the window starts and ends mid-hour), so the lines leave them out rather than dip; they stay in the figures and the
// readout. l1 draws bounces and complaints as counts on their own small scale in the lower half of the plot: their
// latest values label the lines' ends, and while a bucket is hovered that scale shows as a short right axis instead. l2 gives the emails line most of the height and puts the bounce and complaint
// rates under it as a share of their limits, so both limits are the one dashed line. Every hour over a limit has a dot
// on its line. Hover (or tap and drag on a phone) moves a crosshair with one readout.
function LinePlot({ data, mode }: { data: Overview; mode: 'l1' | 'l2' }) {
  const points = data.points
  const [ref, width] = useWidth<HTMLDivElement>(790)
  const [active, setActive] = useState<number | null>(null)
  const compact = width < 520, split = mode === 'l2'
  const height = 196, axis = 24, left = compact ? 36 : 44, right = width - (split ? 0 : compact ? 30 : 44), top = 12
  const mainBottom = split ? height - axis - (compact ? 60 : 64) : height - axis
  const rateTop = mainBottom + 16, rateBottom = height - axis
  const n = points.length, slot = (right - left) / Math.max(1, n)
  const xs = points.map((_, i) => left + (i + 0.5) * slot)
  const max = niceMax(Math.max(...points.map(p => p.sent)))
  const ey = (value: number) => mainBottom - value / max * (mainBottom - top)
  const bucket = bucketOf(points)
  const firstPartial = n > 3 && Date.parse(data.periodStart) > Date.parse(points[0].at)
  const lastPartial = n > 3 && Date.parse(data.periodEnd) < Date.parse(points[n - 1].at) + bucket
  const from = firstPartial ? 1 : 0, to = lastPartial ? n - 2 : n - 1, drawn = (i: number) => i >= from && i <= to
  const span = <T,>(values: T[]) => values.slice(from, to + 1)
  const bounced = points.map(p => p.bounced), complaints = points.map(p => p.complaints)
  const bounceRatio = points.map(p => hourRate(p.bounced, p.sent) / BOUNCE_LINE), complaintRatio = points.map(p => hourRate(p.complaints, p.sent) / COMPLAINT_LINE)
  // l1: the outcomes' own count scale; l2: share of the limit, at least 150% so the dashed line sits two thirds up.
  const outcomeMax = niceMax(Math.max(3, ...bounced, ...complaints))
  const band = (mainBottom - top) * 0.55
  const oy = (value: number) => mainBottom - value / outcomeMax * band
  const ratioMax = Math.max(1.5, Math.min(3, Math.max(...bounceRatio, ...complaintRatio) * 1.1))
  const ry = (ratio: number) => rateBottom - Math.min(ratio, ratioMax) / ratioMax * (rateBottom - rateTop)
  const bounceY = split ? bounceRatio.map(ry) : bounced.map(oy), complaintY = split ? complaintRatio.map(ry) : complaints.map(oy)
  const hasComplaint = (i: number) => complaints[from + i] > 0 || complaints[from + i + 1] > 0
  // Dots: an hour over the bounce limit, and any hour with a complaint (one is worth seeing at any rate).
  const marked = { bounces: bounceRatio.map((r, i) => drawn(i) && r >= 1), complaints: complaints.map((c, i) => drawn(i) && c > 0) }
  const emailsY = points.map(p => ey(p.sent))
  const lastFull = to
  // l1's end labels, kept 12px apart (thousands as 2.8k where a phone's gutter is narrow).
  const endText = (value: number) => compact && value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : number(value)
  const ends = ([['sent', emailsY[lastFull], endText(points[lastFull]?.sent ?? 0)], ['bounces', bounceY[lastFull], endText(bounced[lastFull])], ['complaints', complaintY[lastFull], endText(complaints[lastFull])]] as const)
    .map(([kind, y, text]) => ({ kind, y, text })).sort((a, b) => a.y - b.y)
  for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - 12)
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    const box = event.currentTarget.getBoundingClientRect()
    setActive(Math.max(0, Math.min(n - 1, Math.floor((event.clientX - box.left - left) / slot))))
  }
  const dot = (cx: number, cy: number, kind: FigureKey, key: string) => <circle key={key} cx={cx} cy={cy} r={3.5} className={`pl-dot pl-dot--${kind}`} />
  return <div ref={ref} className="pitch-plot pl-plot" data-active={active !== null || undefined} onMouseLeave={() => setActive(null)} onPointerDown={scrub} onPointerMove={scrub}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={split ? 'Emails per bucket; bounce and complaint rates as a share of their limits' : 'Emails, bounces and complaints per bucket'}>
      {(split ? [0, 1, 2] : [0, 1, 2, 3]).map((i, _, all) => { const steps = all.length - 1, gy = top + i * (mainBottom - top) / steps; return <g key={i}><line x1={left} x2={right} y1={gy} y2={gy} className={i === steps ? 'chart-grid chart-grid--base' : 'chart-grid'} /><text x={left - 8} y={gy + 3.5} textAnchor="end" className="chart-label">{number(Math.round(max * (1 - i / steps)))}</text></g> })}
      {split && <g>
        <line x1={left} x2={right} y1={ry(1)} y2={ry(1)} className="pl-limit" /><text x={left - 8} y={ry(1) + 3.5} textAnchor="end" className="chart-label pl-limit-label">Limit</text>
        <line x1={left} x2={right} y1={rateBottom} y2={rateBottom} className="chart-grid chart-grid--base" /><text x={left - 8} y={rateBottom + 3.5} textAnchor="end" className="chart-label">0</text>
      </g>}
      <path d={`M ${xs[from]} ${mainBottom} L ${xs[from]} ${emailsY[from]} ${monotone(span(xs), span(emailsY)).join(' ')} L ${xs[to]} ${mainBottom} Z`} className="pl-wash" />
      <Line xs={span(xs)} ys={span(emailsY)} kind="sent" />
      <Line xs={span(xs)} ys={span(bounceY)} kind="bounces" />
      <Line xs={span(xs)} ys={span(complaintY)} kind="complaints" keep={hasComplaint} />
      {points.map((p, i) => <g key={p.at}>{marked.bounces[i] && dot(xs[i], bounceY[i], 'bounces', 'b')}{marked.complaints[i] && dot(xs[i], complaintY[i], 'complaints', 'c')}</g>)}
      {!split && (active === null
        ? ends.map(end => <text key={end.kind} x={right + 8} y={end.y + 3.5} className={`chart-label pl-end pl-end--${end.kind}`}>{end.text}</text>)
        : [0, 1, 2, 3].map(i => <text key={i} x={right + 8} y={oy(outcomeMax * (1 - i / 3)) + 3.5} className="chart-label pl-end pl-end--bounces">{number(Math.round(outcomeMax * (1 - i / 3)))}</text>))}
      {active !== null && <g className="pl-cursor">
        <line x1={xs[active]} x2={xs[active]} y1={top} y2={split ? rateBottom : mainBottom} className="pl-crosshair" />
        {drawn(active) && <>{dot(xs[active], emailsY[active], 'sent', 'e')}{dot(xs[active], bounceY[active], 'bounces', 'b')}{complaints[active] > 0 && dot(xs[active], complaintY[active], 'complaints', 'c')}</>}
      </g>}
      {ticks(points, right - left, compact ? 60 : 72).map(i => <text key={i} x={xs[i]} y={height - 6} textAnchor="middle" className="chart-label">{tickLabel(points, i)}</text>)}
      <Hits points={points} x={i => left + i * slot} width={slot} top={0} height={height - axis} onActive={setActive} />
    </svg>
    {active !== null && <Tip points={points} i={active} deliveredShare side={tipSide(xs[active], width, compact ? 164 : 204)} />}
  </div>
}
// The readout beside the crosshair, on the side with room for it, never past the plot's edges.
function tipSide(x: number, width: number, tip: number): CSSProperties {
  const after = x + 12, before = x - 12 - tip
  return { left: Math.max(0, Math.min(width - tip, after + tip <= width ? after : before)) }
}
// An hour's problems, judged the same way everywhere below: bounces from a fifth of their limit (1%) are worth a look
// and at the limit are over it; any complaint counts.
const bounceState = (p: ChartPoint) => { const rate = hourRate(p.bounced, p.sent); return rate >= BOUNCE_LINE ? 'over' : rate >= BOUNCE_LINE / 5 ? 'warn' : undefined }
// a2 and a3: the bars are volume only, in one colour. a2 lines two rows of hourly cells up under the axis (bounces,
// then complaints), lit and labelled with the rate or count where an hour has a problem. a3 tags each such hour above
// its bar with a chip on a short stem (a square for bounces, a dot for complaints where a phone has no room for text).
function VolumePlot({ points, mode }: { points: ChartPoint[]; mode: 'strip' | 'pins' }) {
  const [ref, width] = useWidth<HTMLDivElement>(790)
  const [active, setActive] = useState<number | null>(null)
  const compact = width < 520, strip = mode === 'strip'
  const row = compact ? 10 : 15, rowGap = 3, stripTop = 6
  const height = 196, left = strip ? (compact ? 44 : 76) : compact ? 36 : 44, right = width, top = strip ? 14 : compact ? 30 : 40
  const bottom = height - 24 - (strip ? stripTop + row * 2 + rowGap : 0)
  const n = points.length, slot = (right - left) / Math.max(1, n), gap = slot >= 20 ? 3 : slot >= 8 ? 2 : 1, bar = Math.max(1, slot - gap)
  const max = niceMax(Math.max(...points.map(p => p.sent)))
  const h = (value: number) => value / max * (bottom - top)
  const x = (i: number) => left + i * slot + gap / 2
  const fits = (text: string) => !compact && text.length * 5.75 <= bar - 1
  const rows = [bottom + stripTop, bottom + stripTop + row + rowGap]
  return <div ref={ref} className={`pitch-plot pa-plot pa-plot--${mode}`} data-active={active !== null || undefined} onMouseLeave={() => setActive(null)}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Emails per bucket; bounces and complaints marked by hour">
      {[0, 1, 2, 3].map(i => { const gy = top + i * (bottom - top) / 3; return <g key={i}><line x1={left} x2={right} y1={gy} y2={gy} className={i === 3 ? 'chart-grid chart-grid--base' : 'chart-grid'} /><text x={left - 8} y={gy + 3.5} textAnchor="end" className="chart-label">{number(Math.round(max * (1 - i / 3)))}</text></g> })}
      {strip && (compact ? ['Bounce', 'Spam'] : ['Bounced', 'Complaints']).map((name, r) => <text key={name} x={left - 8} y={rows[r] + row / 2 + 3.2} textAnchor="end" className="chart-label pa-row-label">{name}</text>)}
      {points.map((p, i) => {
        const b = bounceState(p), rate = hourRate(p.bounced, p.sent), cx = x(i) + bar / 2, barTop = bottom - h(p.sent)
        const rateLabel = percent(rate, 1), spam = p.complaints === 1 ? '1 spam' : `${p.complaints} spam`
        const marks: ReactNode[] = []
        if (strip) {
          marks.push(<g key="b"><rect x={x(i)} width={bar} y={rows[0]} height={row} className="pa-cell" data-zone={b} />{b && fits(rateLabel) && <text x={cx} y={rows[0] + row / 2 + 3.5} textAnchor="middle" className="pa-cell-text" data-zone={b}>{rateLabel}</text>}</g>)
          marks.push(<g key="c"><rect x={x(i)} width={bar} y={rows[1]} height={row} className="pa-cell" data-zone={p.complaints ? 'over' : undefined} />{p.complaints > 0 && fits(String(p.complaints)) && <text x={cx} y={rows[1] + row / 2 + 3.5} textAnchor="middle" className="pa-cell-text" data-zone="over">{p.complaints}</text>}</g>)
        } else if (b || p.complaints) {
          // Chips stack upward from a stem that clears the neighbouring bars (a chip is wider than its bar): bounces
          // first, then complaints.
          const near = [i - 1, i + 1].filter(j => j >= 0 && j < n).map(j => bottom - h(points[j].sent))
          let at = Math.min(barTop, ...(compact ? [] : near)) - 6
          const tags = [...(b ? [{ key: 'b', zone: b, text: rateLabel, dot: false }] : []), ...(p.complaints ? [{ key: 'c', zone: 'over', text: spam, dot: true }] : [])]
          marks.push(<line key="stem" x1={cx} x2={cx} y1={barTop - 1} y2={at} className="pa-stem" />)
          for (const tag of tags) {
            if (compact) { marks.push(tag.dot ? <circle key={tag.key} cx={cx} cy={at - 4} r={4} className="pa-chip" data-zone={tag.zone} /> : <rect key={tag.key} x={cx - 4} y={at - 8} width={8} height={8} className="pa-chip" data-zone={tag.zone} />); at -= 11; continue }
            const w = tag.text.length * 6 + 10
            marks.push(<g key={tag.key}><rect x={cx - w / 2} y={at - 16} width={w} height={16} rx={2} className="pa-chip" data-zone={tag.zone} /><text x={cx} y={at - 4.5} textAnchor="middle" className="pa-cell-text" data-zone={tag.zone}>{tag.text}</text></g>)
            at -= 19
          }
        }
        return <g key={p.at} className="pa-col" data-active={active === i || undefined}>{p.sent > 0 && <rect x={x(i)} width={bar} y={barTop} height={h(p.sent)} className="pa-seg pa-seg--sent" />}{marks}</g>
      })}
      {ticks(points, right - left, compact ? 60 : 72).map(i => <text key={i} x={x(i) + bar / 2} y={height - 6} textAnchor="middle" className="chart-label">{tickLabel(points, i)}</text>)}
      <Hits points={points} x={i => left + i * slot} width={slot} top={0} height={height - 24} onActive={setActive} />
    </svg>
    {active !== null && <Tip points={points} i={active} side={x(active) + bar / 2 > (left + right) / 2 ? { right: right - x(active) + 8 } : { left: x(active) + bar + 8 }} />}
  </div>
}
function StackPlot({ points }: { points: ChartPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(790)
  const [active, setActive] = useState<number | null>(null)
  const height = 196, left = 44, right = width, top = 30, bottom = height - 24
  const n = points.length, slot = (right - left) / Math.max(1, n), gap = slot >= 20 ? 3 : slot >= 8 ? 2 : 1, bar = Math.max(1, slot - gap)
  const max = niceMax(Math.max(...points.map(p => p.sent)))
  const h = (value: number) => value / max * (bottom - top)
  const x = (i: number) => left + i * slot + gap / 2
  const texts = slot >= 26
  return <div ref={ref} className="pitch-plot pa-plot" data-active={active !== null || undefined} onMouseLeave={() => setActive(null)}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Emails per bucket, stacked by outcome">
      {[0, 1, 2, 3].map(i => { const gy = top + i * (bottom - top) / 3; return <g key={i}><line x1={left} x2={right} y1={gy} y2={gy} className={i === 3 ? 'chart-grid chart-grid--base' : 'chart-grid'} /><text x={left - 8} y={gy + 3.5} textAnchor="end" className="chart-label">{number(Math.round(max * (1 - i / 3)))}</text></g> })}
      {points.map((p, i) => {
        if (!p.sent) return null
        const complaints = p.complaints ? Math.max(3, h(p.complaints)) : 0, bounced = h(p.bounced), base = Math.max(0, h(p.sent) - bounced - (p.complaints ? h(p.complaints) : 0))
        const rate = hourRate(p.bounced, p.sent), flagged = rate >= BOUNCE_LINE / 5
        let at = bottom
        const segments = [['sent', base], ['bounces', bounced], ['complaints', complaints]] as const
        const flags: ReactNode[] = []
        let fy = bottom - base - bounced - complaints - 6
        if (flagged) { flags.push(texts ? <text key="b" x={x(i) + bar / 2} y={fy} textAnchor="middle" className="pa-flag" data-zone={zone(rate, BOUNCE_LINE)}>{percent(rate, 1)}</text> : <rect key="b" x={x(i) + bar / 2 - 3} y={fy - 6} width={6} height={6} className="pa-flag-mark" />); fy -= texts ? 13 : 9 }
        if (p.complaints) flags.push(texts ? <text key="c" x={x(i) + bar / 2} y={fy} textAnchor="middle" className="pa-flag pa-flag--complaints">{p.complaints === 1 ? 'spam' : `${p.complaints} spam`}</text> : <rect key="c" x={x(i) + bar / 2 - 3} y={fy - 6} width={6} height={6} className="pa-flag-mark pa-flag-mark--complaints" />)
        return <g key={p.at} className="pa-col" data-active={active === i || undefined}>{segments.map(([kind, size]) => size > 0 && <rect key={kind} x={x(i)} width={bar} y={(at -= size)} height={size} className={`pa-seg pa-seg--${kind}`} />)}{flags}</g>
      })}
      {ticks(points, right - left, texts ? 72 : 60).map(i => <text key={i} x={x(i) + bar / 2} y={height - 6} textAnchor="middle" className="chart-label">{tickLabel(points, i)}</text>)}
      <Hits points={points} x={i => left + i * slot} width={slot} top={0} height={bottom} onActive={setActive} />
    </svg>
    {active !== null && <Tip points={points} i={active} side={x(active) + bar / 2 > (left + right) / 2 ? { right: right - x(active) + 8 } : { left: x(active) + bar + 8 }} />}
  </div>
}

// ── B · Lanes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// One instrument: each figure heads its own lane, every lane shares the time axis. Emails are a step area (no gaps),
// the bounce rate sits against its dashed 5% limit (the period's rate is the shaded level under it; what crosses the
// line turns red), complaints are pins. Hovering any lane moves one cursor through all of them and the headers read
// that bucket instead of the period.
export function LanesB({ data, range, stale }: { data: Overview; range: TimeRange; stale: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>(600)
  const [active, setActive] = useState<number | null>(null)
  const points = data.points, n = Math.max(1, points.length), slot = width / n
  const x = (i: number) => i * slot
  const p = active === null ? undefined : points[active]
  const sent = p ? p.sent : data.sent, bounced = p ? p.bounced : data.bounced, complaints = p ? p.complaints : data.complaints
  const change = data.previousSent ? (data.sent - data.previousSent) / data.previousSent : undefined
  const bounceRate = share(bounced, sent), complaintRate = share(complaints, sent)
  const cursor = active === null ? null : <rect x={x(active)} width={slot} y={0} height="100%" className="pb-cursor" />
  const max = niceMax(Math.max(...points.map(q => q.sent)))
  const ey = (value: number, height: number) => height - value / max * (height - 16)
  const step = (values: number[], yOf: (v: number) => number, floor: number) => values.length ? `M 0 ${floor} ` + values.map((v, i) => `L ${x(i)} ${yOf(v)} L ${x(i) + slot} ${yOf(v)}`).join(' ') + ` L ${width} ${floor} Z` : ''
  const edge = (values: number[], yOf: (v: number) => number) => values.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${yOf(v)} L ${x(i) + slot} ${yOf(v)}`).join(' ')
  const rates = points.map(q => hourRate(q.bounced, q.sent)), rateMax = Math.max(BOUNCE_LINE * 1.4, ...rates.map(r => r * 1.08))
  const empty = !data.sent
  return <section className="pb" aria-label="Sending activity" data-stale={stale || undefined} data-range={range} onMouseLeave={() => setActive(null)}>
    <div className="ov-chart__head pitch-head"><h2 className="ui-label">Activity</h2><Right className="pb-readout">{p && active !== null ? bucketLabel(points, active) : range === '24h' ? 'Last 24 hours' : range === '7d' ? 'Last 7 days' : 'Last 30 days'}</Right></div>
    <div className="pb-lanes" data-active={active !== null || undefined}>
      <div className="pb-gutter"><span className="pb-label">Emails<Right>{!p && change !== undefined ? `${change >= 0 ? '+' : ''}${percent(change, 0)}` : ''}</Right></span><span className="pb-value">{number(sent)}</span><span className="pb-sub">{sent ? percent(share(p ? p.delivered : data.delivered, sent)) : '—'} delivered</span></div>
      <div className="pb-plot" ref={ref}>{empty ? <EmptyState title={NO_EMAILS} /> : <Lane height={104}>{h => <>
        {[0.5, 1].map(f => <g key={f}><line x1={0} x2={width} y1={ey(max * f, h)} y2={ey(max * f, h)} className="chart-grid" />{f === 1 && <text x={width - 2} y={ey(max, h) - 4} textAnchor="end" className="chart-label">{number(max)}</text>}</g>)}
        {cursor}
        <path d={step(points.map(q => q.sent), v => ey(v, h), h)} className="pb-area pb-area--sent" />
        <path d={edge(points.map(q => q.sent), v => ey(v, h))} className="pb-edge pb-edge--sent" />
      </>}</Lane>}</div>
      <div className="pb-gutter" data-zone={zone(bounceRate, BOUNCE_LINE)}><span className="pb-label">Bounced</span><span className="pb-value">{sent ? rateText(bounceRate) : '—'}</span><span className="pb-sub"><span className="pb-count">{number(bounced)} · </span>{ofLimit(bounceRate, BOUNCE_LINE)}</span></div>
      <div className="pb-plot">{!empty && <Lane height={64}>{h => { const ry = (v: number) => h - Math.min(v, rateMax) / rateMax * (h - 4), line = ry(BOUNCE_LINE), avg = ry(share(data.bounced, data.sent)); return <>
        <defs><clipPath id="pb-under"><rect x={0} y={line} width={width} height={h - line} /></clipPath><clipPath id="pb-over"><rect x={0} y={-4} width={width} height={line + 4} /></clipPath></defs>
        {cursor}
        <path d={step(rates, ry, h)} className="pb-area pb-area--bounces" clipPath="url(#pb-under)" /><path d={step(rates, ry, h)} className="pb-area pb-area--over" clipPath="url(#pb-over)" />
        <line x1={0} x2={width} y1={avg} y2={avg} className="pb-level" /><text x={4} y={avg - 4} className="chart-label pb-level-label">AVG {rateText(share(data.bounced, data.sent))}</text>
        <line x1={0} x2={width} y1={line} y2={line} className="pb-limit" /><text x={width - 2} y={line - 4} textAnchor="end" className="chart-label pb-limit-label">{limitText(BOUNCE_LINE)} LIMIT</text>
      </> }}</Lane>}</div>
      <div className="pb-gutter" data-zone={zone(complaintRate, COMPLAINT_LINE)}><span className="pb-label">Complaints<Right>{limitText(COMPLAINT_LINE)} limit</Right></span><span className="pb-value">{sent ? rateText(complaintRate) : '—'}</span><span className="pb-sub"><span className="pb-count">{number(complaints)} · </span>{ofLimit(complaintRate, COMPLAINT_LINE)}</span></div>
      <div className="pb-plot">{!empty && <Lane height={64}>{h => <>
        {cursor}
        <line x1={0} x2={width} y1={h - 8} y2={h - 8} className="chart-grid chart-grid--base" />
        {points.map((q, i) => q.complaints > 0 && <g key={q.at} className="pb-pin"><rect x={x(i) + slot / 2 - 1} y={h - 30} width={2} height={22} /><rect x={x(i) + slot / 2 - 5} y={h - 38} width={10} height={10} />{q.complaints > 1 && <text x={x(i) + slot / 2 + 9} y={h - 29} className="chart-label">{q.complaints}</text>}</g>)}
      </>}</Lane>}</div>
      <div className="pb-axis-gap" /><div className="pb-axis">{!empty && <svg viewBox={`0 0 ${width} 22`} aria-hidden="true">{ticks(points, width, 64).map(i => <g key={i}><line x1={x(i)} x2={x(i)} y1={0} y2={4} className="chart-grid chart-grid--base" /><text x={x(i)} y={17} textAnchor={x(i) < 24 ? 'start' : 'middle'} className="chart-label">{tickLabel(points, i)}</text></g>)}</svg>}</div>
      {!empty && <svg className="pb-hits" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none"><Hits points={points} x={x} width={slot} top={0} height={100} onActive={setActive} /></svg>}
    </div>
  </section>
}
function Lane({ height, children }: { height: number; children: (height: number) => ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>(600)
  return <div ref={ref} className="pb-lane"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">{children(height)}</svg></div>
}
export function LanesSkeletonB() {
  return <section className="pb" aria-hidden="true"><div className="ov-chart__head pitch-head"><h2 className="ui-label">Activity</h2></div>
    <div className="pb-lanes">{['Emails', 'Bounced', 'Complaints'].flatMap(title => [<div key={title} className="pb-gutter"><span className="pb-label">{title}</span><span className="pb-value"><Skeleton width={72} height={16} /></span></div>, <div key={title + '-plot'} className="pb-plot"><span className="pa-skeleton" /></div>])}<div className="pb-axis-gap" /><div className="pb-axis" /></div>
  </section>
}

// ── C · Pulse ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Cards of hourly cells: a rate's cell fills toward its limit (a full red cell is an hour at or over it), volume cells
// fill toward the busiest hour. The chart is a dense 15-minute histogram (hours past 24 h); a bucket over the bounce
// limit turns amber whole. A readout row above the plot names the bucket under the pointer instead of a tooltip.
function cellGroups(values: number[], weights: number[], size: number) {
  if (size <= 1) return values
  const out: number[] = []
  for (let i = 0; i < values.length; i += size) { const ws = weights.slice(i, i + size), total = ws.reduce((a, b) => a + b, 0); out.push(total ? values.slice(i, i + size).reduce((a, v, j) => a + v * ws[j], 0) / total : 0) }
  return out
}
export function FactsC({ data, stale }: { data: Overview; stale: boolean }) {
  const size = Math.ceil(data.points.length / 42), sent = data.points.map(p => p.sent)
  return <div className="pc-cards" role="group" aria-label="Figures" data-stale={stale || undefined}>{figures(data).map(fact => {
    const z = fact.limit !== undefined ? zone(fact.rate ?? 0, fact.limit) : undefined
    const values = fact.rates ? cellGroups(fact.rates, sent, size) : cellGroups(fact.series, fact.series.map(() => 1), size)
    const max = fact.limit ?? Math.max(1, ...cellGroups(sent, sent.map(() => 1), size))
    return <div key={fact.key} className="pc-card" data-zone={z}>
      <div className="pc-card__head"><span>{fact.title}</span><Right className="pc-card__hint">{fact.limit !== undefined ? `${limitText(fact.limit)} limit` : fact.hint}</Right></div>
      <div className="pc-card__value">{fact.value}{fact.limit !== undefined && <Right className="pc-card__of">{ofLimit(fact.rate ?? 0, fact.limit)}</Right>}</div>
      <Cells className={`pc-cells pc-cells--${fact.key}`} fills={values.map(value => value / max)} zones={values.map(value => fact.limit !== undefined && value > 0 ? zone(value, fact.limit) : undefined)} track ratio={0.74} />
    </div>
  })}</div>
}
export function FactsSkeletonC() {
  return <div className="pc-cards" aria-hidden="true">{['Emails', 'Delivered', 'Bounced', 'Complaints'].map(title => <div key={title} className="pc-card">
    <div className="pc-card__head"><span>{title}</span></div><div className="pc-card__value"><Skeleton width={80} height={18} /></div><span className="pa-skeleton pc-cells-skeleton" />
  </div>)}</div>
}
export function ChartC({ data, range, stale }: { data: Overview; range: TimeRange; stale: boolean }) {
  const points = data.finePoints ?? data.points
  const [active, setActive] = useState<number | null>(null)
  const p = active === null ? undefined : points[active]
  const bucket = bucketOf(points)
  return <section className="ov-chart pc-chart" aria-label="Sending activity" data-stale={stale || undefined} data-range={range} onMouseLeave={() => setActive(null)}>
    <div className="ov-chart__head pitch-head"><h2 className="ui-label">Activity</h2>
      <Right className="pc-readout">{p && active !== null ? <><time><span className="pc-readout__day">{day(p.at)}, </span>{bucketLabel(points, active).replace(/^.*?, /, '').replace(/ UTC$/, '')}<span className="pc-utc"> UTC</span></time><span><i className="pitch-key pitch-key--sent" />{number(p.sent)}</span><span data-zone={zone(hourRate(p.bounced, p.sent), BOUNCE_LINE)}><i className="pitch-key pitch-key--bounces" />{number(p.bounced)}<em>{p.sent ? percent(share(p.bounced, p.sent), 1) : ''}</em></span><span><i className="pitch-key pitch-key--complaints" />{number(p.complaints)}</span></>
        : <span className="pc-readout__idle">{bucket < HOUR ? '15-minute' : bucket < DAY ? 'Hourly' : 'Daily'} buckets</span>}</Right></div>
    <div className="ov-chart__plot">{data.sent ? <DensePlot points={points} active={active} onActive={setActive} /> : <EmptyState title={NO_EMAILS} />}</div>
  </section>
}
function DensePlot({ points, active, onActive }: { points: ChartPoint[]; active: number | null; onActive: (i: number | null) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>(790)
  const height = 196, left = 40, right = width, top = 8, bottom = height - 24
  const n = points.length, slot = (right - left) / Math.max(1, n), gap = slot >= 4 ? 1 : 0.5, bar = Math.max(0.5, slot - gap)
  const max = niceMax(Math.max(...points.map(p => p.sent)))
  const h = (value: number) => value / max * (bottom - top)
  const x = (i: number) => left + i * slot
  return <div ref={ref} className="pitch-plot pc-plot" data-active={active !== null || undefined}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Emails per bucket, stacked by outcome">
      {active !== null && <rect x={x(active) - 2} width={bar + 4} y={top} height={bottom - top} className="pc-cursor" />}
      {[0, 1, 2].map(i => { const gy = top + i * (bottom - top) / 2; return <g key={i}><line x1={left} x2={right} y1={gy} y2={gy} className="chart-grid pc-grid" /><text x={left - 8} y={gy + 3.5} textAnchor="end" className="chart-label">{number(Math.round(max * (1 - i / 2)))}</text></g> })}
      {points.map((p, i) => {
        if (!p.sent) return null
        const over = hourRate(p.bounced, p.sent) >= BOUNCE_LINE
        const complaints = p.complaints ? Math.max(3, h(p.complaints)) : 0, bounced = h(p.bounced), base = Math.max(0, h(p.sent) - bounced - (p.complaints ? h(p.complaints) : 0))
        let at = bottom
        const segments = [['sent', base], ['bounces', bounced], ['complaints', complaints]] as const
        return <g key={p.at} className="pc-col" data-active={active === i || undefined} data-over={over || undefined}>{segments.map(([kind, size]) => size > 0 && <rect key={kind} x={x(i)} width={bar} y={(at -= size)} height={size} className={`pc-seg pc-seg--${kind}`} />)}</g>
      })}
      <line x1={left} x2={right} y1={bottom + 0.5} y2={bottom + 0.5} className="chart-grid chart-grid--base" />
      {ticks(points, right - left, 64).map(i => <g key={i}><line x1={x(i)} x2={x(i)} y1={bottom} y2={bottom + 4} className="chart-grid chart-grid--base" /><text x={x(i)} y={height - 4} textAnchor="middle" className="chart-label">{tickLabel(points, i)}</text></g>)}
      <Hits points={points} x={x} width={slot} top={0} height={bottom} onActive={onActive} />
    </svg>
  </div>
}
