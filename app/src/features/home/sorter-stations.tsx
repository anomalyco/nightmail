import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { SignInConsent } from '../../components/LegalLinks'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { reducedMotion, type HomeProps } from '.'
import { DX, DY, type Plan } from './sorter/plan'

// Under the slab the machine stands on, its eight tubes run on down the page and one by one bend in to an appliance:
// the places mail can go. Capsules run down every tube all the time, round the bends and into the appliances (each
// one's lamp winks as one arrives); and one more tube, the outbound main, runs back up the page from the plate the
// last button is on, past the appliances that send (they tee into it), to the slab, where the machine's cannon fires
// what it carries off the page. One mail system from the hopper to the footer. As the page scrolls, the letter in
// each appliance arrives the way it does in the product: a pigeonhole fills and a row appears in the Inbox, a mail
// app on a monitor gets the message, a teleprinter prints an agent's turn, a ritual's lamps come on line by line, a
// switchboard posts a webhook, a press runs a campaign off, a thread grows, a ledger tape prints the logs. That is
// driven by how far the page has scrolled (--q on each unit, 0 to 1), with transforms, opacity and clipping only, so
// nothing shifts; the capsules are transform animations the compositor runs, stopped while the section is off screen;
// with reduced motion every unit shows its finished state and nothing travels. The letters are from the sorter's own
// set.
type Kind = 'inbox' | 'imap' | 'agent' | 'ritual' | 'endpoint' | 'campaign' | 'thread' | 'logs'
type Station = { kind: Kind; tube: number; name: string; line: string; plate: string; w: number; h: number; up: number; down: number; port: number }
// `up` and `down` are what stands over or hangs under the appliance's box (paper, a stand); `port` is how far down its
// side the tube comes in.
const STATIONS: Station[] = [
  { kind: 'inbox', tube: 0, name: 'Inbox', line: 'Every address keeps its own threads.', plate: 'Inbox', w: 430, h: 296, up: 0, down: 0, port: .18 },
  { kind: 'imap', tube: 4, name: 'IMAP and SMTP', line: 'Or open the same inbox in a mail app.', plate: 'IMAP', w: 408, h: 240, up: 0, down: 40, port: .5 },
  { kind: 'agent', tube: 1, name: 'Agent inboxes', line: 'Addresses your agents read and answer over MCP.', plate: 'Agents', w: 420, h: 96, up: 168, down: 0, port: .5 },
  { kind: 'ritual', tube: 5, name: 'Rituals', line: 'Short scripts that run on mail as it arrives.', plate: 'Rituals', w: 446, h: 226, up: 0, down: 0, port: .5 },
  { kind: 'endpoint', tube: 2, name: 'Endpoints', line: 'Slack, Discord, a webhook or a forward.', plate: 'Endpoints', w: 446, h: 262, up: 0, down: 0, port: .5 },
  { kind: 'campaign', tube: 6, name: 'Campaigns', line: 'One send to a whole audience, at the same price.', plate: 'Campaigns', w: 430, h: 246, up: 34, down: 0, port: .5 },
  { kind: 'thread', tube: 3, name: 'Threads', line: 'Reply from the address the mail came to.', plate: 'Threads', w: 384, h: 262, up: 64, down: 0, port: .5 },
  { kind: 'logs', tube: 7, name: 'Logs', line: 'And every message, sent or received, is on record.', plate: 'Logs', w: 420, h: 88, up: 0, down: 186, port: .5 },
]

/** A window of a unit's progress: the element's own --t runs 0 to 1 while --v goes from `from` to `to`. */
const step = (from: number, to: number, extra?: CSSProperties) => ({ '--from': from, '--to': to, ...extra }) as CSSProperties

export function Stations({ plan: p, onSignIn, onSignInIntent, busy }: { plan: Plan | null } & Pick<HomeProps, 'onSignIn' | 'onSignInIntent' | 'busy'>) {
  const root = useRef<HTMLElement>(null), traffic = useRef<HTMLDivElement>(null), flows = useRef<Flow[]>([])
  // One pass per frame while scrolling: how far each unit has come up the page.
  useEffect(() => {
    const units = [...root.current!.querySelectorAll<HTMLElement>('.srt-unit')]
    if (reducedMotion()) { for (const unit of units) unit.style.setProperty('--q', '1'); return }
    let frame = 0
    const last = units.map(() => -1)
    const measure = () => {
      frame = 0
      const view = window.innerHeight
      units.forEach((unit, i) => {
        const box = unit.getBoundingClientRect()
        // 0 as the unit comes in at the bottom of the window, 1 once its top stands at about 40% of the window's height.
        const q = Math.round(Math.min(1, Math.max(0, (view * 1.04 - box.top) / (view * .62))) * 500) / 500
        if (q !== last[i]) { last[i] = q; unit.style.setProperty('--q', String(q)) }
      })
    }
    const queue = () => { frame ||= requestAnimationFrame(measure) }
    measure()
    window.addEventListener('scroll', queue, { passive: true }); window.addEventListener('resize', queue)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', queue); window.removeEventListener('resize', queue) }
  }, [p])

  // The capsules: each a transform animation along its tube's line, several to a long tube, and the lamp of the
  // appliance it ends at winking as it gets there. All of it stops while the section is off screen.
  useEffect(() => {
    const host = traffic.current
    if (!host || reducedMotion() || !host.animate) return
    const running: Animation[] = []
    flows.current.forEach((flow, f) => {
      const frames = along(flow.points, flow.bend), total = frames.at(-1)!.s, duration = total / flow.speed * 1000, count = Math.max(1, Math.min(4, Math.round(total / 1150)))
      const keyframes = frames.map(at => ({ offset: at.s / total, transform: `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -50%) rotate(${at.a.toFixed(3)}rad)` }))
      const edge = Math.min(.2, 26 / total), lamp = flow.unit === undefined ? null : root.current!.querySelectorAll<HTMLElement>('.srt-lamp i')[flow.unit]
      for (let k = 0; k < count; k++) {
        const capsule = document.createElement('span'), delay = -((k + (f * .37) % 1) / count) * duration
        capsule.className = flow.wide ? 'srt-cap srt-cap-wide' : 'srt-cap'
        host.append(capsule)
        running.push(capsule.animate(keyframes, { duration, delay, iterations: Infinity }), capsule.animate([{ opacity: 0 }, { opacity: 1, offset: edge }, { opacity: 1, offset: 1 - edge }, { opacity: 0 }], { duration, delay, iterations: Infinity }))
      }
      if (lamp) { const period = duration / count, wink = Math.min(.5, 260 / period); running.push(lamp.animate([{ opacity: 0 }, { opacity: 0, offset: 1 - wink }, { opacity: 1, offset: 1 - wink * .6 }, { opacity: 0 }], { duration: period, delay: -(((f * .37) % 1) / count) * duration, iterations: Infinity })) }
    })
    const observer = new IntersectionObserver(([entry]) => { for (const animation of running) entry.isIntersecting ? animation.play() : animation.pause() })
    observer.observe(root.current!)
    return () => { observer.disconnect(); for (const animation of running) animation.cancel(); host.replaceChildren() }
  }, [p])

  if (!p) return <section className="srt-stations" ref={root} aria-label="Where mail goes" />
  const phone = p.phone, r = p.tubeR, wide = r * 2, depth = phone ? 40 : 60, dx = -DX * depth, dy = DY * depth
  // Each appliance stands between the two fours of tubes, a little towards the side its own tube comes from: those on
  // the left share one left edge, those on the right another, so their names stand in two columns down the page.
  const inner = Math.min(...p.drops.slice(4)) - Math.max(...p.drops.slice(0, 4)), room = inner - 2 * (phone ? 20 : 74), widest = Math.min(446, room), lean = phone ? 0 : Math.min(46, Math.max(0, (room - widest) / 2))
  const captionH = phone ? 58 : 66, gap = phone ? 96 : 128
  let top = phone ? 96 : 110
  // (On a phone the printed paper is narrower, so longer: nothing printed is cut short.)
  const units = STATIONS.map(spec => {
    const station = phone ? { ...spec, h: spec.kind === 'inbox' ? 339 : spec.kind === 'thread' ? 288 : spec.h, up: spec.up && spec.kind === 'agent' ? 236 : spec.up, down: spec.kind === 'logs' ? 264 : spec.down } : spec
    const w = Math.min(station.w, room), left = station.tube < 4
    const boxLeft = Math.round(p.ox - widest / 2 + (left ? -lean : lean) + dx / 2), boxTop = top + captionH + dy + 18 + station.up
    const unit = { station, w, left, top, boxLeft, boxTop: boxTop - top, port: boxTop + Math.round(station.h * station.port), end: left ? boxLeft - dx * .5 : boxLeft + w - 4, sends: boxTop + Math.round(station.h * .74) }
    top = boxTop + station.h + station.down + gap
    return unit
  })
  // Under the last appliance, the plate the last button is on; the outbound main comes out of its top.
  const plate = { w: phone ? widest : Math.min(540, room + 60), h: phone ? 164 : 138, top: top + dy + 8 }, plateLeft = Math.round(p.ox - plate.w / 2 + dx / 2), mainX = p.ox + p.out
  const height = plate.top + plate.h + (phone ? 150 : 132)
  // The tubes. A wide page: each side's four start where they left the slab's lip; after each appliance on that side
  // the tubes that are left step in one place towards the column (the inner ones first, so none crosses another),
  // and the innermost then bends in to the next appliance: into a flange on its side wall, at half its depth (an
  // appliance on the right shows no such wall: its tube goes in behind its front). A phone has no room for four a
  // side: under the lip each four go into a collector, and one tube twice as wide comes out of it and runs down the
  // page's edge, with a tee off it to each appliance on its side and a bend into the last.
  const pw = phone ? 10 : wide, bend = pw * 1.5
  const runs: { key: string; points: Pt[]; wide: number; rings: Ring[] }[] = [], ways: Pt[][] = [], sleeve = (x: number): Ring => ({ at: [x, 12], across: false, tall: 30 })
  const collectors: { x0: number; x1: number; out: number }[] = []
  if (!phone) units.forEach(({ station, left, port, end }, k) => {
    const side = left ? 0 : 4, n = station.tube - side, slot = (j: number) => p.drops[side + j], points: Pt[] = [[slot(n), 0]]
    for (let m = 0; m < n; m++) { const y = units.find(u => u.station.tube === side + m)!.port + 78 + (n - m - 1) * (wide + 16); points.push([slot(n - m), y], [slot(n - m - 1), y]) }
    points.push([points.at(-1)![0], port], [end, port])
    runs.push({ key: `t${station.tube}`, points, wide, rings: [sleeve(points[0][0]), ...rings(points, bend, left ? dx / 2 + 5 : 17, !left).slice(1)] }); ways[k] = points
  })
  else for (const side of [0, 4]) {
    const mine = units.filter(u => u.left === (side === 0)), last = mine.at(-1)!, x = Math.round((p.drops[side] + p.drops[side + 3]) / 2), out = 24, towards = side ? -1 : 1
    collectors.push({ x0: Math.min(p.drops[side], p.drops[side + 3]) - r - 3, x1: Math.max(p.drops[side], p.drops[side + 3]) + r + 3, out })
    for (let k = 0; k < 4; k++) runs.push({ key: `in${side + k}`, points: [[p.drops[side + k], 0], [p.drops[side + k], 9]], wide, rings: [{ at: [p.drops[side + k], 5.5], across: false, tall: 3 }] })
    const trunk: Pt[] = [[x, out], [x, last.port], [last.end, last.port]], collars = rings(trunk, bend, side ? 17 : dx / 2 + 5, !!side)
    for (const unit of mine) {
      ways[units.indexOf(unit)] = [[x, out], [x, unit.port], [unit.end, unit.port]]
      if (unit === last) continue
      // A tee: the branch, a collar on it, and one on the trunk either side of where it leaves.
      runs.push({ key: `tee${unit.station.tube}`, points: [[x + towards * (pw / 2 - 1), unit.port], [unit.end, unit.port]], wide: pw, rings: [{ at: [x + towards * (pw / 2 + 3.5), unit.port], across: true }, ...(side ? [{ at: [unit.end + 3, unit.port] as Pt, across: true }] : [])] })
      collars.push({ at: [x, unit.port - pw / 2 - 4.5], across: false }, { at: [x, unit.port + pw / 2 + 4.5], across: false })
    }
    runs.push({ key: `trunk${side}`, points: trunk, wide: pw, rings: collars.filter((ring, i) => collars.every((other, j) => j >= i || Math.abs(other.at[0] - ring.at[0]) > 1 || Math.abs(other.at[1] - ring.at[1]) > 12)) })
  }
  // The outbound main: from the plate's top straight up the page to the slab (behind the appliances that lean right,
  // beside those that lean left). On a wide page the appliances on the left that send tee into it from their right
  // side; the others it passes behind.
  const main: Pt[] = [[mainX, 0], [mainX, plate.top - dy * .5]], senders = units.filter(u => ['agent', 'campaign', 'thread'].includes(u.station.kind)), mainRings: Ring[] = [sleeve(mainX)]
  for (let y = 300; y < main[1][1] - 120; y += 380) if (units.every(u => !(!u.left || phone) || y < u.top + u.boxTop - dy - 30 || y > u.top + u.boxTop + u.station.h + 40)) mainRings.push({ at: [mainX, y], across: false })
  const outWays: Pt[][] = [[[mainX, plate.top - dy * .5 + 14], [mainX, 16]]]
  for (const unit of senders) {
    if (phone || !unit.left) { outWays.push([[mainX, unit.top + unit.boxTop + unit.station.h * .5], [mainX, 16]]); continue }
    const from = unit.boxLeft + unit.w - 4
    runs.push({ key: `send${unit.station.tube}`, points: [[from, unit.sends], [mainX - (wide / 2 - 1), unit.sends]], wide, rings: [{ at: [from + 9, unit.sends], across: true }, { at: [mainX - wide / 2 - 3.5, unit.sends], across: true }] })
    mainRings.push({ at: [mainX, unit.sends - wide / 2 - 4.5], across: false }, { at: [mainX, unit.sends + wide / 2 + 4.5], across: false })
    outWays.push([[from + 4, unit.sends], [mainX, unit.sends], [mainX, 16]])
  }
  runs.push({ key: 'main', points: main, wide, rings: mainRings })
  // Every capsule's way: down each tube from under its sleeve into its appliance; up the main from each that sends.
  flows.current = [...ways.map((points, k) => ({ points: [[points[0][0], phone ? points[0][1] + 4 : 16] as Pt, ...points.slice(1, -1), [units[k].left ? units[k].end - dx / 2 - 2 : units[k].end - 2, points.at(-1)![1]] as Pt], bend, speed: phone ? 150 : 230, unit: k, wide: phone })), ...outWays.map(points => ({ points, bend: wide * 1.5, speed: phone ? 130 : 200, unit: undefined, wide: false }))]
  const vars = { '--srt-r': `${pw / 2}px`, '--srt-pipe': `${pw}px`, '--srt-dx': `${dx}px`, '--srt-dy': `${dy}px`, '--srt-slope': dy / dx, '--srt-over': phone ? '4px' : '7px', height } as CSSProperties
  return <section className="srt-stations" ref={root} style={vars} data-phone={phone || undefined} aria-label="Where mail goes">
    {/* The tubes' far walls; over them the capsules; over those (further down) the tubes' near walls and their collars. */}
    <svg className="srt-pipes" aria-hidden="true">
      {/* What each tube throws on the wall behind it, down and to the left as the machine's light falls. */}
      <g className="srt-tube-shadows" transform="translate(-4 5)">{runs.map(run => <path key={run.key} d={line(run.points, bend)} strokeWidth={run.wide} />)}</g>
      {runs.map(run => <Tube key={run.key} layer="back" points={run.points} wide={run.wide} bend={bend} rings={run.rings} />)}
    </svg>
    <div className="srt-traffic" ref={traffic} aria-hidden="true" />
    {units.map(({ station, w, left, top, boxLeft, boxTop }, k) => <div key={station.kind} className="srt-unit" data-kind={station.kind} data-side={left ? 'l' : 'r'} style={{ top, '--srt-w': `${w}px`, '--srt-h': `${station.h}px` } as CSSProperties}>
      <span className="srt-shadow" style={{ left: boxLeft, top: boxTop }} aria-hidden="true" />
      <div className="srt-caption" style={{ left: boxLeft - dx, width: w + dx }}>
        <h2>{station.name}</h2>
        <p>{station.line}</p>
      </div>
      <div className="srt-box" style={{ left: boxLeft, top: boxTop }}>
        {APPLIANCES[station.kind]}
        <span className="srt-plate" aria-hidden="true">{station.plate}</span>
        <span className="srt-lamp" aria-hidden="true"><i /></span>
        <span className="srt-ledge" aria-hidden="true"><i /></span>
      </div>
    </div>)}
    <svg className="srt-pipes srt-glass" aria-hidden="true">
      {/* A phone's collectors: a box each in the machine's projection (its top, the side that is seen, its front). */}
      {collectors.map(({ x0, x1 }, i) => <g key={i}><polygon className="srt-ring-lit" points={`${x0},9 ${x1},9 ${x1 - 3},4 ${x0 - 3},4`} /><polygon className="srt-flange" points={`${x0},9 ${x0 - 3},4 ${x0 - 3},16 ${x0},21`} /></g>)}
      {runs.map(run => <Tube key={run.key} layer="front" points={run.points} wide={run.wide} bend={bend} rings={run.rings} />)}
      {collectors.map(({ x0, x1 }, i) => <rect key={i} className="srt-ring" x={x0} y={9} width={x1 - x0} height={12} />)}
    </svg>
    {/* Where a tube meets the side wall of an appliance on the left: a flange on the wall, the tube's last length, a collar. */}
    <svg className="srt-pipes srt-ports" aria-hidden="true">
      {units.filter(unit => unit.left).map(({ station, end: x, port: y }) => {
        const e = phone ? 3.5 : 5, h = pw / 2 + (phone ? 4 : 5), m = dy / dx, stub: Pt[] = [[x - dx / 2 - 3, y], [x, y]]
        return <g key={station.tube}>
          <polygon className="srt-flange" points={`${x - e},${y - h - m * e} ${x + e},${y - h + m * e} ${x + e},${y + h + m * e} ${x - e},${y + h - m * e}`} />
          <polygon className="srt-flange-edge" points={`${x - e},${y - h - m * e} ${x + e},${y - h + m * e} ${x + e},${y - h + m * e + 1.5} ${x - e},${y - h - m * e + 1.5}`} />
          <Tube layer="back" points={stub} wide={pw} bend={bend} rings={[]} />
          <Tube layer="front" points={stub} wide={pw} bend={bend} rings={[{ at: [x - 3, y], across: true }]} />
        </g>
      })}
    </svg>
    {/* The last plate, in the machine's make: the price and the button on it, the outbound main coming out of its top. */}
    <span className="srt-shadow" style={{ left: plateLeft, top: plate.top, '--srt-w': `${plate.w}px`, '--srt-h': `${plate.h}px` } as CSSProperties} aria-hidden="true" />
    <div className="srt-box srt-end-plate" style={{ left: plateLeft, top: plate.top, '--srt-w': `${plate.w}px`, '--srt-h': `${plate.h}px` } as CSSProperties}>
      <p className="srt-end-price"><b>$0.20</b> per 1,000 emails, sent or received.</p>
      <span className="srt-end-bay">
        <button type="button" className="srt-cta srt-end-cta" disabled={busy} aria-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
          <span className="srt-cta-label">Get started{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
        </button>
      </span>
      {[0, 1, 2, 3].map(k => <i key={k} className="srt-screw" style={{ [k % 2 ? 'right' : 'left']: 10, [k < 2 ? 'top' : 'bottom']: 10 }} aria-hidden="true" />)}
    </div>
    <svg className="srt-pipes srt-ports" aria-hidden="true">
      <Tube layer="back" points={[[mainX, plate.top - dy - 6], [mainX, plate.top - dy * .5]]} wide={wide} bend={bend} rings={[]} />
      <Tube layer="front" points={[[mainX, plate.top - dy - 6], [mainX, plate.top - dy * .5]]} wide={wide} bend={bend} rings={[{ at: [mainX, plate.top - dy * .5 - 2.5], across: false }]} />
    </svg>
    <footer className="srt-end">
      <SignInConsent className="srt-end-consent" />
      <nav aria-label="Site links"><a className="srt-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a><a href="/docs">API docs</a><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link></nav>
    </footer>
  </section>
}

type Pt = [number, number]
const corners = (points: Pt[], bend: number) => points.map((v, i) => i === 0 || i === points.length - 1 ? 0 : Math.min(bend, Math.hypot(v[0] - points[i - 1][0], v[1] - points[i - 1][1]) / 2, Math.hypot(points[i + 1][0] - v[0], points[i + 1][1] - v[1]) / 2))

type Ring = { at: Pt; across: boolean; tall?: number }
type Flow = { points: Pt[]; bend: number; speed: number; unit: number | undefined; wide: boolean }
/** Where a tube's line turns: for each corner the centre of its quarter circle, its radius, and the points it begins and ends at. */
function turns(points: Pt[], bend: number) {
  const R = corners(points, bend)
  return points.map((v, i) => {
    if (!R[i]) return null
    const a = points[i - 1], b = points[i + 1], la = Math.hypot(v[0] - a[0], v[1] - a[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1])
    const din: Pt = [(v[0] - a[0]) / la, (v[1] - a[1]) / la], dout: Pt = [(b[0] - v[0]) / lb, (b[1] - v[1]) / lb]
    return { r: R[i], din, dout, from: [v[0] - din[0] * R[i], v[1] - din[1] * R[i]] as Pt, to: [v[0] + dout[0] * R[i], v[1] + dout[1] * R[i]] as Pt, sweep: din[0] * dout[1] - din[1] * dout[0] > 0 ? 1 : 0 }
  })
}
/** A tube's centre line as a path: straight runs joined by quarter circles, all of one radius. `top` is taken off every y. */
function line(points: Pt[], bend: number, top = 0) {
  const T = turns(points, bend)
  let d = `M ${points[0][0]} ${points[0][1] - top}`
  points.forEach((v, i) => { if (!i) return; const t = T[i]; d += t ? ` L ${t.from[0]} ${t.from[1] - top} A ${t.r} ${t.r} 0 0 ${t.sweep} ${t.to[0]} ${t.to[1] - top}` : ` L ${v[0]} ${v[1] - top}` })
  return d
}
/** Collars: where a tube comes under the slab, either end of each change of direction (a step sideways is one
 * fitting, collared at its ends), one a little short of where it ends, and along a long straight run every so often. */
function rings(points: Pt[], bend: number, short: number, mount = false) {
  const T = turns(points, bend), out: Ring[] = [{ at: points[0], across: false }], last = points.length - 1
  T.forEach((t, i) => {
    if (!t) return
    const before = T[i - 1], after = T[i + 1]
    if (!before || Math.hypot(t.from[0] - before.to[0], t.from[1] - before.to[1]) > 140) out.push({ at: t.from, across: t.din[1] === 0 })
    if (i < last - 1 && (!after || Math.hypot(after.from[0] - t.to[0], after.from[1] - t.to[1]) > 140)) out.push({ at: t.to, across: t.dout[1] === 0 })
  })
  const end = points[last], back = Math.sign(points[last - 1][0] - end[0])
  if (Math.abs(points[last - 1][0] - end[0]) > bend + short + 14) out.push({ at: [end[0] + back * short, end[1]], across: true })
  if (mount) out.push({ at: [end[0] + back * 7, end[1]], across: true })
  for (let i = 1; i <= last; i++) {
    const a = points[i - 1], b = points[i]
    if (a[0] === b[0]) for (let y = 300; y < b[1]; y += 380) if (y > a[1] && out.every(ring => Math.abs(ring.at[0] - a[0]) > 1 || Math.abs(ring.at[1] - y) > 70) && Math.abs(y - b[1]) > 70 && Math.abs(y - a[1]) > 70) out.push({ at: [a[0], y], across: false })
  }
  return out
}
/** A glass tube as the machine draws one, lit from above and the right as the machine is: its wall in the tone of a
 * tube seen from the front; down the side away from the light a band in shade with a darker edge; and where it runs
 * across the page its lit top. Through a corner the lit top comes in gradually and the shade goes round with the
 * light (crossing the tube where the corner turns away from it). Steel collars lie across it. */
function Tube({ points, wide, bend, rings, layer }: { points: Pt[]; wide: number; bend: number; rings: Ring[]; layer: 'back' | 'front' }) {
  if (layer === 'back') return <path className="srt-tube-back" d={line(points, bend)} strokeWidth={wide} />
  const T = turns(points, bend), half = wide / 2
  // Along the line: the point, the normal to its left hand, which side of that the light is on (1 or -1, or between
  // while it crosses), how level the tube lies (0 down the page, 1 across), and which side is up.
  const along: { p: Pt; n: Pt; lit: number; level: number; up: number }[] = []
  const side = (d: Pt) => { const n: Pt = [d[1], -d[0]]; return { n, lit: Math.sign(n[0] - n[1]), level: Math.abs(d[0]), up: -Math.sign(n[1]) } }
  const put = (p: Pt, d: Pt) => along.push({ p, ...side(d) })
  points.forEach((v, i) => {
    const t = T[i]
    if (!t) { const o = i ? points[i - 1] : points[1], l = Math.hypot(v[0] - o[0], v[1] - o[1]) * (i ? 1 : -1); put(v, [(v[0] - o[0]) / l, (v[1] - o[1]) / l]); return }
    const a = side(t.din), b = side(t.dout), cx = t.from[0] + t.dout[0] * t.r, cy = t.from[1] + t.dout[1] * t.r, a0 = Math.atan2(t.from[1] - cy, t.from[0] - cx), turn = (t.sweep ? 1 : -1) * Math.PI / 2
    for (let k = 0; k <= 10; k++) {
      const u = k / 10, e = u * u * (3 - 2 * u), angle = a0 + turn * u, d: Pt = [-Math.sin(angle) * (t.sweep ? 1 : -1), Math.cos(angle) * (t.sweep ? 1 : -1)]
      along.push({ p: [cx + Math.cos(angle) * t.r, cy + Math.sin(angle) * t.r], n: [d[1], -d[0]], lit: a.lit + (b.lit - a.lit) * e, level: a.level + (b.level - a.level) * e, up: a.level ? a.up : b.up })
    }
  })
  const beside = (offset: (s: typeof along[0]) => number) => along.map(s => { const o = offset(s); return `${(s.p[0] + s.n[0] * o).toFixed(2)} ${(s.p[1] + s.n[1] * o).toFixed(2)}` })
  const top = beside(s => s.up * half), under = beside(s => s.up * (half - wide * .65 * s.level)).reverse()
  // The near wall, in three strips side by side across the tube (its edge in shade, the band beside it, the rest),
  // each a veil over what is inside.
  return <g>
    <path className="srt-tube-wall" d={`M ${beside(s => s.lit * wide * .15).join(' L ')}`} strokeWidth={wide * .7} />
    <path className="srt-tube-lit" d={`M ${top.join(' L ')} L ${under.join(' L ')} Z`} />
    <path className="srt-tube-shade" d={`M ${beside(s => -s.lit * (half - wide * .205)).join(' L ')}`} strokeWidth={wide * .19} />
    <path className="srt-tube-edge" d={`M ${beside(s => -s.lit * (half - wide * .055)).join(' L ')}`} strokeWidth={wide * .11} />
    {rings.map(({ at, across, tall }, i) => across
      ? <g key={i}><rect className="srt-ring" x={at[0] - 2.5} y={at[1] - half - 2.5} width={5} height={wide + 5} rx={1} /><rect className="srt-ring-lit" x={at[0] - 2.5} y={at[1] - half - 2.5} width={5} height={2} rx={1} /></g>
      : <g key={i}><rect className="srt-ring" x={at[0] - half - 2.5} y={at[1] - (tall ?? 5) / 2} width={wide + 5} height={tall ?? 5} rx={1} /><rect className="srt-ring-lit" x={at[0] - half - 2.5} y={at[1] - (tall ?? 5) / 2} width={wide + 5} height={2} rx={1} /></g>)}
  </g>
}

/** A capsule's way along a tube's line, as points to animate through: where it is, which way it heads, how far it has come. */
function along(points: Pt[], bend: number) {
  const T = turns(points, bend), out: { x: number; y: number; a: number; s: number }[] = []
  let s = 0, heading = 0
  const put = (x: number, y: number, a: number) => {
    // (The heading never jumps a turn: it goes on from the last the short way round.)
    if (out.length) { const last = out.at(-1)!; s += Math.hypot(x - last.x, y - last.y); a = heading + Math.atan2(Math.sin(a - heading), Math.cos(a - heading)) }
    heading = a; out.push({ x, y, a, s })
  }
  points.forEach((v, i) => {
    const t = T[i]
    if (!t) { const o = i ? points[i - 1] : points[1], sign = i ? 1 : -1; put(v[0], v[1], Math.atan2((v[1] - o[1]) * sign, (v[0] - o[0]) * sign)); return }
    const cx = t.from[0] + t.dout[0] * t.r, cy = t.from[1] + t.dout[1] * t.r, a0 = Math.atan2(t.from[1] - cy, t.from[0] - cx), turn = (t.sweep ? 1 : -1) * Math.PI / 2, into = Math.atan2(t.din[1], t.din[0])
    for (let k = 0; k <= 6; k++) put(cx + Math.cos(a0 + turn * k / 6) * t.r, cy + Math.sin(a0 + turn * k / 6) * t.r, into + turn * k / 6)
  })
  return out
}

const Row = ({ from, subject, when, fresh, style }: { from: string; subject: string; when: string; fresh?: boolean; style?: CSSProperties }) =>
  <div className={fresh ? 'srt-row-mail srt-step srt-fresh' : 'srt-row-mail'} style={style}><i className="srt-dot" /><b>{from}</b><span>{subject}</span><time>{when}</time></div>
const LOGS: [string, string, number][] = [['Received', 'Turn a one-star canteen review into notes', 0], ['Received', 'Your webhook is answering in Latin', .15], ['Delivered', 'We label the sausages by mood now', .3], ['Received', 'Re: can you send me the file again', .45], ['Sent', 'Sending version six. It is the last one.', .6], ['Received', 'Your pager wants to be friends', .75]]

// Each appliance: what stands in, on or under its box. All of it is aria-hidden; the unit's name and line say what it is.
const APPLIANCES: Record<Kind, ReactNode> = {
  // A rack of pigeonholes over a screen: the letter is filed, and its row heads the Inbox.
  inbox: <div className="srt-a" aria-hidden="true">
    <div className="srt-holes">{Array.from({ length: 16 }, (_, i) => <i key={i} className={i === 10 ? 'srt-step srt-filed' : [0, 2, 3, 6, 9, 12, 13, 15].includes(i) ? 'srt-full' : undefined} style={i === 10 ? step(0, .14) : undefined} />)}</div>
    <div className="srt-screen">
      <div className="srt-v-head"><b>Inbox</b><span className="srt-step srt-count" style={step(.2, .4)}><i>2</i><i>3</i></span></div>
      <div className="srt-list">
        <Row fresh from="On-Call Pager" subject="Your pager wants to be friends" when="now" style={step(.16, .5)} />
        <div className="srt-step srt-shift" style={step(.16, .5)}>
          <Row from="Handle Concern" subject="Order confirmed: 6 mugs, 7 handles" when="02:14" />
          <Row from="Dougal Renner" subject="Your hot desk is now cold" when="01:40" />
          <Row from="nightly-sync" subject="Cron job requests a day off" when="00:03" />
        </div>
      </div>
    </div>
  </div>,
  // A monitor on its stand: the same inbox in a mail app, the count on the folder, the message in the list.
  imap: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-imap">
      <div className="srt-app-side"><i /><i /><i /><span className="srt-folder">Inbox<b className="srt-step srt-pop" style={step(.3, .5)}>1</b></span><span>Sent</span><span>Junk</span><span>Archive</span></div>
      <div className="srt-app-list">
        <div className="srt-app-mail srt-step srt-fresh" style={step(.1, .5)}><b>Pantry Assistant</b><span>Your fridge has written a short essay</span><em>Title: On Being Opened. Twelve pages.</em></div>
        <div className="srt-step srt-shift" style={step(.1, .5)}>
          <div className="srt-app-mail"><b>Mill Row Bakes</b><span>The ovens are taking a vacation</span><em>Three days off. They earned it.</em></div>
          <div className="srt-app-mail"><b>Seed Library</b><span>New hours for the seed library</span><em>Open Tuesdays. Closed when gardening.</em></div>
        </div>
      </div>
    </div>
    <span className="srt-neck" /><span className="srt-foot" />
  </div>,
  // A teleprinter: the agent's turn comes up out of it on paper, line by line.
  agent: <div className="srt-a" aria-hidden="true">
    <div className="srt-feed"><div className="srt-paper srt-step" style={step(0, .92)}>
      <p><i>agent</i> inboxes.wait()</p>
      <p><i>mail</i> Bertram Quaife: Turn a one-star canteen review into notes</p>
      <p className="srt-quote">Extract the actionable part from 'the soup was a warning'.</p>
      <p><i>agent</i> messages.reply("1. Label the soup.")</p>
      <p><i>mail</i> Reply sent from the inbox's address</p>
    </div></div>
    <div className="srt-keys">{Array.from({ length: 22 }, (_, i) => <i key={i} />)}</div>
  </div>,
  // A console: the ritual on its screen, and a lamp for each thing it does, lit as the line runs.
  ritual: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-ritual">
      <pre><span>export default function route(email) {'{'}</span>
        <span className="srt-step srt-run" style={step(.1, .3)}>  if (email.subject.includes("pager")) {'{'}</span>
        <span className="srt-step srt-run" style={step(.4, .56)}>    label("on-call")</span>
        <span className="srt-step srt-run" style={step(.62, .8)}>    endpoints.pager({'{'} text: email.subject {'}'})</span>
        <span>  {'}'}</span>
        <span>{'}'}</span></pre>
    </div>
    <div className="srt-panel">
      <span className="srt-step srt-led" style={step(.24, .34)}>true</span>
      <span className="srt-step srt-led" style={step(.5, .6)}>label</span>
      <span className="srt-step srt-led" style={step(.74, .84)}>endpoint</span>
    </div>
  </div>,
  // A switchboard: the payload, and the line it goes out on.
  endpoint: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-endpoint">
      <p className="srt-step srt-type" style={step(.02, .22)}><b>POST</b> hooks.acme.example/mail</p>
      <pre className="srt-step srt-unfold" style={step(.22, .66)}>{'{\n  "type": "message.received",\n  "from": "Delivery Service",\n  "subject": "Your webhook is\n    answering in Latin"\n}'}</pre>
      <p className="srt-step srt-in srt-ok" style={step(.8, .94)}><b>200</b> OK</p>
    </div>
    <div className="srt-panel srt-jacks">
      <span>Slack</span><span>Discord</span><span className="srt-step srt-led" style={step(.68, .8)}>Webhook</span><span>Forward</span>
    </div>
  </div>,
  // A press: one letter in, a thousand out, and what that costs.
  campaign: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-campaign">
      <div className="srt-v-head"><b>We label the sausages by mood now</b></div>
      <p className="srt-sub"><span>Counter Six Butcher </span><span>to <b>Regulars</b>, 1,000 contacts</span></p>
      <div className="srt-grid">{Array.from({ length: 100 }, (_, i) => <i key={i} className="srt-step" style={step(.08 + (i % 20) * .028 + Math.floor(i / 20) * .012, .14 + (i % 20) * .028 + Math.floor(i / 20) * .012)} />)}</div>
      <div className="srt-meter"><span className="srt-step srt-fill" style={step(.08, .72)} /></div>
      <p className="srt-total"><span className="srt-step srt-in" style={step(.74, .86)}>1,000 sent</span><b className="srt-step srt-in" style={step(.84, .96)}>$0.20</b></p>
    </div>
    <span className="srt-roller" /><span className="srt-shelf" />
    <div className="srt-out">{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <i key={i} className="srt-step" style={step(.14 + i * .075, .2 + i * .075)} />)}</div>
  </div>,
  // A thread: the message that came, and the reply from the same address.
  thread: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-thread">
      <div className="srt-v-head"><b>Re: can you send me the file again</b></div>
      <p className="srt-bubble">Here it is. Again.</p>
      <p className="srt-bubble srt-theirs srt-step srt-in" style={step(.08, .3)}><b>Zahir Bhatt</b>This is the fifth time. Each version is a different version.</p>
      <p className="srt-bubble srt-step srt-type" style={step(.42, .74)}>Sending version six. It is the last one.</p>
      <p className="srt-sent srt-step srt-in" style={step(.8, .94)}>Sent from the address it came to</p>
    </div>
    <span className="srt-reel-shade" /><span className="srt-reel-shade" /><span className="srt-tape" /><span className="srt-reel" /><span className="srt-reel srt-reel-b" />
  </div>,
  // A ledger printer: every message that went through, on tape, the newest at the head.
  logs: <div className="srt-a" aria-hidden="true">
    <div className="srt-feed srt-feed-down"><div className="srt-paper srt-step" style={step(0, .94)}>
      {LOGS.slice().reverse().map(([status, subject], i) => <p key={i} className="srt-log"><span data-status={status}>{status}</span><b>{subject}</b></p>)}
    </div></div>
    <div className="srt-keys srt-counter"><b>Logs</b><span>Sent and received</span></div>
  </div>,
}
