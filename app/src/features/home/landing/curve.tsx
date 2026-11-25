import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { formatCount, ours, PROVIDERS, sourceLine, theirs } from './data'

// Option C: the cost curve, wider than the text column. A month's bill against the emails sent, both on log scales:
// Nightmail's line is exact at every volume (its price per email), each provider's line is its own checked price at each
// volume its page prices (a provider priced only at the sizes read on its page is a dot at each), so the lines stop where
// a provider names no price. Pointing at the chart (or dragging on a phone) reads every price at that volume.
// Laid out in percentages: the lines are an SVG stretched to the box, with strokes that don't stretch, and the labels and
// dots are HTML over it, so the chart is drawn the same from the first paint at any width.
const FROM = 10_000, TO = 2_500_000, LOW = 1, HIGH = 2_000
const lx = (emails: number) => (Math.log10(emails) - Math.log10(FROM)) / (Math.log10(TO) - Math.log10(FROM))
const ly = (usd: number) => 1 - (Math.log10(Math.max(usd, LOW)) - Math.log10(LOW)) / (Math.log10(HIGH) - Math.log10(LOW))
const X = (emails: number) => +(lx(emails) * 1000).toFixed(2), Y = (usd: number) => +(ly(usd) * 1000).toFixed(2)
/** The volumes the lines are drawn through: 241 steps on the log scale, each a whole thousand. */
const GRID = [...new Set(Array.from({ length: 241 }, (_, i) => Math.round(10 ** (Math.log10(FROM) + i / 240 * (Math.log10(TO) - Math.log10(FROM))) / 1000) * 1000))]
const path = (points: [number, number][]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x)} ${Y(y)}`).join('')
const LINE = path(GRID.map(v => [v, ours(v).usd]))
/** Each provider: a line through every grid volume it prices ('complete' ladders), or a dot at each size read ('points'). */
const OTHERS = PROVIDERS.map(c => {
  if (c.offer.ladder === 'complete') {
    // (A gap in its prices ends one line and starts another.)
    const runs: [number, number][][] = [[]]
    for (const v of GRID) { const q = theirs(c, v); if (q) runs.at(-1)!.push([v, q.usd]); else if (runs.at(-1)!.length) runs.push([]) }
    return { c, d: runs.filter(run => run.length > 1).map(path).join(''), dots: [] as [number, number][] }
  }
  return { c, d: '', dots: c.steps.flatMap(v => { const q = v >= FROM && v <= TO ? theirs(c, v) : null; return q ? [[v, q.usd] as [number, number]] : [] }) }
})
const X_TICKS = [10_000, 100_000, 1_000_000, TO], X_MINOR = [50_000, 500_000]
const Y_TICKS = [1, 10, 100, 1000]
const START = 100_000
const snap = (emails: number) => GRID.reduce((a, b) => Math.abs(Math.log(b / emails)) < Math.abs(Math.log(a / emails)) ? b : a)

export function Curve() {
  const [emails, setEmails] = useState(START)
  const box = useRef<HTMLDivElement>(null)
  const read = (event: PointerEvent) => {
    const rect = box.current!.getBoundingClientRect(), t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setEmails(snap(10 ** (Math.log10(FROM) + t * (Math.log10(TO) - Math.log10(FROM)))))
  }
  const us = ours(emails)
  const at = PROVIDERS.flatMap(c => { const q = theirs(c, emails); return q && (c.offer.ladder === 'complete' || c.steps.includes(emails)) ? [{ c, q }] : [] }).sort((a, b) => a.q.usd - b.q.usd)
  const next = at[0], top = at.at(-1)
  return <figure className="lc-figure lc-curve" aria-labelledby="lc-curve-title">
    <p id="lc-curve-title" className="lc-figure-title">Nightmail’s line runs under every other email API’s price, at every volume.</p>
    <div className="lc-curve-read" aria-live="polite">
      <span className="lc-read-at">{formatCount(emails)} emails</span>
      <span className="lc-read-us">Nightmail <b>{us.text}</b></span>
      {next && <span>Next cheapest <b>{next.q.text}</b> <span className="lc-read-who">{next.c.offer.vendor}</span></span>}
      {top && top !== next && <span className="lc-read-top">Most <b>{top.q.text}</b> <span className="lc-read-who">{top.c.offer.vendor}</span></span>}
    </div>
    <div className="lc-curve-plot" ref={box} onPointerMove={read} onPointerDown={read} onPointerLeave={event => { if (event.pointerType === 'mouse') setEmails(START) }}
      role="img" aria-label={`A month's bill against emails sent, ${formatCount(FROM)} to ${formatCount(TO)}: Nightmail is below every other provider at every volume.`}>
      {Y_TICKS.map(usd => <span key={usd} className="lc-grid lc-grid-y" style={{ top: `${ly(usd) * 100}%` }}><span>${formatCount(usd)}</span></span>)}
      {[...X_TICKS, ...X_MINOR].map(v => <span key={v} className="lc-grid lc-grid-x" data-minor={X_MINOR.includes(v) || undefined} data-edge={v === FROM ? 'start' : v === TO ? 'end' : undefined} style={{ left: `${lx(v) * 100}%` }}><span>{formatCount(v)}</span></span>)}
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        {OTHERS.map(({ c, d }) => d && <path key={c.slug} className="lc-other" d={d} />)}
        <path className="lc-ours" d={LINE} />
      </svg>
      {OTHERS.flatMap(({ c, dots }) => dots.map(([v, usd]) => <span key={`${c.slug}-${v}`} className="lc-dot" style={{ left: `${lx(v) * 100}%`, top: `${ly(usd) * 100}%` }} aria-hidden="true" />))}
      <span className="lc-guide" style={{ left: `${lx(emails) * 100}%` } as CSSProperties} aria-hidden="true">
        {at.map(({ c, q }) => <span key={c.slug} className="lc-mark-other" style={{ top: `${ly(q.usd) * 100}%` }} />)}
        <span className="lc-mark-us" style={{ top: `${ly(us.usd) * 100}%` }} />
      </span>
      <span className="lc-label-us" style={{ top: `${ly(ours(TO).usd) * 100}%` }} aria-hidden="true">Nightmail</span>
      <span className="lc-label-others" aria-hidden="true">{PROVIDERS.length} other email APIs</span>
    </div>
    <p className="lc-note">{sourceLine()} Each grey line or dot is one provider.</p>
  </figure>
}
