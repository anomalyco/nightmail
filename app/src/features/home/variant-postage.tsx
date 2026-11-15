import { useId, useState, type CSSProperties } from 'react'
import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneMark, BaneWordmark } from '../../components/BaneLogo'
import type { HomeProps } from '.'
import { HomeFooter } from '.'
import './variant-postage.css'
import { productName } from '../../../../api/src/brand'

// Direction 4: postage. In 1840 the Uniform Penny Post made a letter one penny to anywhere in Britain, paid with a
// stamp; the Penny Black was printed in sheets with position letters (A A, A B…) in its lower corners and price notes in
// the margins. Here a pane of six stamps prints, its first stamp tears off along the perforation and a datestamp cancels
// it with the measured acceptance time. Every face value is a real figure: the price from api/src/billing/money.ts, the
// free allowance as announced (3,000 sent and 3,000 received a month), and medians measured against dev.bane.mx on
// 15 Nov 2026 (POST /v1/emails/send 202 in 99 ms, n = 90; delivered to the SES mailbox simulator in 0.60 s, n = 40;
// a reply in its thread in 2.6 s, n = 12).

type Stamp = { legend: string; value: string; unit?: string; foot: string; label: string }

const stamps: Stamp[] = [
  { legend: 'POSTAGE', value: '$0.20', foot: 'PER 1,000', label: '$0.20 per 1,000 emails, sent or received' },
  { legend: 'SENT', value: '3,000', foot: 'FREE A MONTH', label: '3,000 emails sent free every month' },
  { legend: 'RECEIVED', value: '3,000', foot: 'FREE A MONTH', label: '3,000 emails received free every month' },
  { legend: 'YOUR AWS', value: '$0', foot: 'PER 1,000', label: 'Bring your own AWS: $0' },
  { legend: 'DELIVERED', value: '<1', unit: 's', foot: 'MEDIAN', label: 'Delivered in under a second (median, to the SES mailbox simulator)' },
  { legend: 'REPLIES', value: '~3', unit: 's', foot: 'IN THREAD', label: 'Replies land in the thread in about 3 seconds (median)' },
]

// The pane, in sheet units: 3 × 2 stamps of 100 × 120 with the margins (selvedge) around them. Everything inside the
// sheet is placed in these units, so it scales as one piece and its height is known before anything loads.
const CELL = { w: 100, h: 120 }, COLS = 3, ROWS = 2
const MARGIN = { top: 40, side: 14, bottom: 26 }
const SHEET = { w: MARGIN.side * 2 + COLS * CELL.w, h: MARGIN.top + MARGIN.bottom + ROWS * CELL.h }
// Perforation: holes on every cut line at half-pitch offsets, so a stamp's corners stay whole, as in the logo mark.
const PITCH = 10, HOLE = 2.6
const ROW_LETTERS = 'AB', COL_LETTERS = 'ABC'

const pct = (value: number, of: number) => `${(value / of) * 100}%`
const box = (x: number, y: number, w: number, h: number) => ({ left: pct(x, SHEET.w), top: pct(y, SHEET.h), width: pct(w, SHEET.w), height: pct(h, SHEET.h) })

const holes = (() => {
  const list: [number, number][] = []
  // Each cut line runs the length of the pane and one hole into the margin at either end.
  const along = (start: number, length: number) => Array.from({ length: length / PITCH + 2 }, (_, i) => start + (i - .5) * PITCH)
  for (let c = 0; c <= COLS; c++) for (const y of along(MARGIN.top, ROWS * CELL.h)) list.push([MARGIN.side + c * CELL.w, y])
  for (let r = 0; r <= ROWS; r++) for (const x of along(MARGIN.side, COLS * CELL.w)) list.push([x, MARGIN.top + r * CELL.h])
  return list
})()

// A torn-off stamp's outline: its rectangle with half a hole bitten out at every perforation, drawn like the mark's.
const perforatedOutline = (() => {
  const r = HOLE, w = CELL.w, h = CELL.h
  const side = (length: number, point: (t: number) => string, notch: (t: number) => string) => {
    let d = ''
    for (let t = PITCH / 2; t < length; t += PITCH) d += `L${point(t - r)}A${r} ${r} 0 0 0 ${notch(t + r)}`
    return d
  }
  return `M0 0${side(w, t => `${t} 0`, t => `${t} 0`)}L${w} 0${side(h, t => `${w} ${t}`, t => `${w} ${t}`)}L${w} ${h}${side(w, t => `${w - t} ${h}`, t => `${w - t} ${h}`)}L0 ${h}${side(h, t => `0 ${h - t}`, t => `0 ${h - t}`)}Z`
})()

// One stamp's engraving in its own 100 × 120 units: a double frame, the legend between two marks (where the Penny Black
// has its stars), an engine-turned field behind the value's tablet, and the position letters in the lower corners.
function StampArt({ stamp, row, col }: { stamp: Stamp; row: number; col: number }) {
  const id = useId()
  const chars = stamp.value.length + (stamp.unit ? stamp.unit.length * .55 : 0)
  const valueSize = Math.min(24, 60 / (chars * .6))
  return <svg className="pst-art" viewBox={`0 0 ${CELL.w} ${CELL.h}`} aria-hidden="true">
    <defs>
      <pattern id={`${id}e`} width="8" height="3.2" patternUnits="userSpaceOnUse">
        <path className="pst-engine" d="M-2 1.6Q0 -.4 2 1.6T6 1.6T10 1.6M-2 1.6Q0 3.6 2 1.6T6 1.6T10 1.6" />
      </pattern>
    </defs>
    <rect className="pst-rule pst-rule--outer" x="7" y="7" width="86" height="106" />
    <rect className="pst-rule" x="9.5" y="9.5" width="81" height="101" />
    <g transform="translate(12.5 12.5)"><BaneMark size={9} /></g>
    <g transform="translate(78.5 12.5)"><BaneMark size={9} /></g>
    <text className="pst-legend" x="50" y="20.1">{stamp.legend}</text>
    <line className="pst-rule" x1="9.5" y1="24.5" x2="90.5" y2="24.5" />
    <rect x="9.5" y="24.5" width="81" height="71" fill={`url(#${id}e)`} />
    <rect className="pst-tablet" x="16" y="43" width="68" height="34" rx="3" />
    <rect className="pst-rule pst-rule--fine" x="18" y="45" width="64" height="30" rx="2" />
    <text className="pst-value" x="50" y="60" style={{ fontSize: valueSize }}>{stamp.value.startsWith('~') ? <><tspan className="pst-approx">~</tspan>{stamp.value.slice(1)}</> : stamp.value}{stamp.unit && <tspan className="pst-unit" dx="1.5">{stamp.unit}</tspan>}</text>
    <line className="pst-rule" x1="9.5" y1="95.5" x2="90.5" y2="95.5" />
    <line className="pst-rule" x1="21" y1="95.5" x2="21" y2="110.5" />
    <line className="pst-rule" x1="79" y1="95.5" x2="79" y2="110.5" />
    <text className="pst-letter" x="15.25" y="103.2">{ROW_LETTERS[row]}</text>
    <text className="pst-letter" x="84.75" y="103.2">{COL_LETTERS[col]}</text>
    <text className="pst-foot" x="50" y="103.2">{stamp.foot}</text>
  </svg>
}

// The circular datestamp and its wavy cancellation, in sheet units: struck over the torn stamp's top corner, the waves
// running along the top margin. It takes the visitor's own date and time, as a postmark would, and the median time the
// API takes to accept a send.
const MARK = { x: 99, y: 31, r: 30 }
const wave = (y: number) => {
  let d = `M${MARK.x + MARK.r + 4} ${y}`
  for (let x = MARK.x + MARK.r + 4; x < SHEET.w - 22; x += 11) d += 'q2.75 -2.4 5.5 0t5.5 0'
  return d
}
function Postmark() {
  const id = useId()
  const [struck] = useState(() => new Date())
  const two = (n: number) => String(n).padStart(2, '0')
  const date = `${two(struck.getDate())} ${struck.toLocaleString('en-GB', { month: 'short' }).slice(0, 3).toUpperCase()} ${String(struck.getFullYear()).slice(2)}`
  const { x, y, r } = MARK
  return <svg className="pst-postmark-art" viewBox={`0 0 ${SHEET.w} ${SHEET.h}`} aria-hidden="true">
    <defs>
      <path id={`${id}top`} d={`M${x - r + 7} ${y}A${r - 7} ${r - 7} 0 0 1 ${x + r - 7} ${y}`} />
      <path id={`${id}bottom`} d={`M${x - r + 4.5} ${y}A${r - 4.5} ${r - 4.5} 0 0 0 ${x + r - 4.5} ${y}`} />
    </defs>
    <circle className="pst-cancel" cx={x} cy={y} r={r} />
    <text className="pst-ring"><textPath href={`#${id}top`} startOffset="50%">ACCEPTED IN</textPath></text>
    <text className="pst-ring pst-ring--date"><textPath href={`#${id}bottom`} startOffset="50%">{date} · {two(struck.getHours())}:{two(struck.getMinutes())}</textPath></text>
    <line className="pst-cancel pst-bridge" x1={x - r + 3} y1={y - 8.5} x2={x + r - 3} y2={y - 8.5} />
    <line className="pst-cancel pst-bridge" x1={x - r + 3} y1={y + 8.5} x2={x + r - 3} y2={y + 8.5} />
    <text className="pst-mark-value" x={x} y={y}><tspan className="pst-approx">~</tspan>100<tspan className="pst-mark-unit" dx="1.5">MS</tspan></text>
    {[13, 20, 27].map(row => <path key={row} className="pst-cancel pst-wave" d={wave(row)} />)}
  </svg>
}

function Sheet() {
  return <figure className="pst-figure">
    <div className="pst-sheet" role="group" aria-label="Postage: a pane of six stamps, one of them torn off and postmarked">
      <svg className="pst-paper" viewBox={`0 0 ${SHEET.w} ${SHEET.h}`} aria-hidden="true">
        <rect className="pst-paper-fill" width={SHEET.w} height={SHEET.h} />
        <rect className="pst-hole" x={MARGIN.side} y={MARGIN.top} width={CELL.w} height={CELL.h} />
        {holes.map(([x, y]) => <circle key={`${x} ${y}`} className="pst-hole" cx={x} cy={y} r={HOLE} />)}
        <text className="pst-selvedge" x={MARGIN.side} y={SHEET.h - 13}>PRICE $0.0002 PER LABEL · $0.20 PER 1,000 · SENT OR RECEIVED ALIKE</text>
        <text className="pst-selvedge" x={MARGIN.side} y={SHEET.h - 6}>PLACE THE KEY IN THE AUTHORIZATION HEADER · REPLIES KEEP THEIR THREAD</text>
        <text className="pst-selvedge pst-selvedge--end" x={SHEET.w - MARGIN.side} y={SHEET.h - 6}>PLATE 1</text>
      </svg>
      <ul className="pst-pane">
        {stamps.map((stamp, index) => {
          const row = Math.floor(index / COLS), col = index % COLS
          const at = box(MARGIN.side + col * CELL.w, MARGIN.top + row * CELL.h, CELL.w, CELL.h)
          const print = { '--pst-print': `${160 + row * 300 + col * 80}ms` } as CSSProperties
          if (index === 0) return <li key={stamp.legend} className="pst-torn" style={{ ...at, ...print }} aria-label={stamp.label}>
            <div className="pst-torn-body">
              <svg className="pst-art" viewBox={`0 0 ${CELL.w} ${CELL.h}`} aria-hidden="true"><path className="pst-paper-fill" d={perforatedOutline} /></svg>
              <div className="pst-ink"><StampArt stamp={stamp} row={row} col={col} /></div>
            </div>
          </li>
          return <li key={stamp.legend} className="pst-stamp" style={at} aria-label={stamp.label}>
            <div className="pst-ink" style={print}><StampArt stamp={stamp} row={row} col={col} /></div>
          </li>
        })}
      </ul>
      <div className="pst-postmark" style={{ transformOrigin: `${pct(MARK.x, SHEET.w)} ${pct(MARK.y, SHEET.h)}` }} role="img" aria-label="Postmarked: accepted in about 100 ms"><Postmark /></div>
    </div>
    <figcaption className="pst-caption">After the Penny Black, 1840: one price to anywhere. Delivery timed to the SES mailbox simulator.</figcaption>
  </figure>
}

// Face values for the same month of mail, side by side: 997,000 billable emails at $0.20 per 1,000 against Resend's
// Scale plan (resend.com/pricing, 15 Nov 2026).
const compare = [
  { name: productName.toLowerCase(), stamp: { legend: 'NIGHTMAIL', value: '$199.40', foot: '1M EMAILS', label: `${productName}: $199.40 for a million emails` }, ours: true },
  { name: 'Resend, Scale', stamp: { legend: 'RESEND', value: '$650', foot: '1M EMAILS', label: 'Resend Scale plan: $650 for a million emails' }, ours: false },
]

function Comparison() {
  return <section className="pst-compare" aria-labelledby="pst-compare-title">
    <h2 id="pst-compare-title">A million emails a month</h2>
    <ul className="pst-compare-stamps">
      {compare.map(({ name, stamp, ours }) => <li key={name} className={ours ? 'pst-single' : 'pst-single pst-single--theirs'} aria-label={stamp.label}>
        <div className="pst-single-stamp" aria-hidden="true">
          <svg className="pst-art" viewBox={`0 0 ${CELL.w} ${CELL.h}`}><path className="pst-paper-fill" d={perforatedOutline} /></svg>
          <div className="pst-ink pst-ink--still"><StampArt stamp={stamp} row={0} col={ours ? 0 : 1} /></div>
        </div>
        <span className="pst-single-name" aria-hidden="true">{name}</span>
      </li>)}
    </ul>
    <p>About a third of Resend’s price. At 100,000 a month: $19.40 here, $35 there. List prices, 15 Nov 2026.</p>
  </section>
}

export function PostageHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  return <div className="pst-page">
    <header className="pst-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="pst-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>
    <main className="pst-main">
      <section className="pst-hero">
        <div className="pst-copy">
          <h1>The penny post, for email.</h1>
          <p>Send, receive and reply through one API at one flat rate: $0.20 per 1,000 emails, sent or received. No tiers, no monthly fee.</p>
          <Button variant="primary" className="pst-cta" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in</Button>
          <SignInConsent className="pst-consent" />
          {notice}
        </div>
        <Sheet />
        <Comparison />
      </section>
    </main>
    <HomeFooter />
  </div>
}
