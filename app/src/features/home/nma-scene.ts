// The night scene behind the nma homepage (variant-nma.tsx): a tower among darker buildings, its windows just big
// enough for a letter. A thousand letters fly in and lodge in the windows that spell the price of a thousand emails.
// Everything is flat fills on two canvases: the city with the lodged letters (nma-city.ts draws it once, then this
// file changes it window by window), and the air above it (letters in flight, the beacon, the light from the door),
// cleared every frame.
import { CROWN, drawCity, mast, setBack, setIn, INKS, type Ink, type Site, type Tier } from './nma-city'

/** "$0.20" in windows, drawn for this grid (a window is wider than it is tall): stems three windows wide and bars four
 * floors high, which is the same weight; every outer corner rounded over three windows and three floors; the "$" with
 * a bar two windows wide through an S that stands two floors short at each end; the "2" on a diagonal as heavy as the
 * stems. Every # is one window; there are exactly 1,000. */
const PRICE = [
  '.....##..........###...........###........###...',
  '.....##.........#####.........#####......#####..',
  '...######......#######.......#######....#######.',
  '..########....#########.....#########..#########',
  '.##########...###...###.....###...###..###...###',
  '############..###...###.....###...###..###...###',
  '###..##..###..###...###.....###...###..###...###',
  '###..##..###..###...###.....###...###..###...###',
  '###..##..###..###...###.....###...###..###...###',
  '###..##..###..###...###.....###...###..###...###',
  '###..##..###..###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '###..##.......###...###...........###..###...###',
  '##########....###...###...........###..###...###',
  '.#########....###...###..........####..###...###',
  '..#########...###...###..........###...###...###',
  '..##########..###...###..........###...###...###',
  '.....##..###..###...###.........####...###...###',
  '.....##..###..###...###.........###....###...###',
  '.....##..###..###...###.........###....###...###',
  '.....##..###..###...###........####....###...###',
  '.....##..###..###...###........###.....###...###',
  '.....##..###..###...###........###.....###...###',
  '.....##..###..###...###.......####.....###...###',
  '.....##..###..###...###.......###......###...###',
  '.....##..###..###...###.......###......###...###',
  '###..##..###..###...###......####......###...###',
  '###..##..###..###...###......###.......###...###',
  '###..##..###..###...###......###.......###...###',
  '###..##..###..###...###.....####.......###...###',
  '###..##..###..###...###.....###........###...###',
  '############..###...###.....###........###...###',
  '.##########...###...###.....###........###...###',
  '..########....#########.###.#########..#########',
  '...######......#######..###.#########...#######.',
  '.....##.........#####...###.#########....#####..',
  '.....##..........###....###.#########.....###...',
] as const
export const LETTERS = 1000

// A window is 18 wide for every 13 tall: the shape of an envelope.
const CELL = 18 / 13
const ART_COLS = PRICE[0].length, ART_ROWS = PRICE.length
// The middle of the decimal point: the last window to get its letter.
const POINT = { col: 25, row: ART_ROWS - 2 }

/** Where everything is. Lengths are device pixels of the base canvas (the page's own boxes read them as CSS lengths in --nma-* custom properties), except `street`. */
export type Plan = {
  phone: boolean; dpr: number; side: number; cols: number; upper: number; floors: number; depth: number; tiers: Tier[]
  cw: number; ch: number; zu: number; L: number; T: number; B: number; band: number; ground: number; step: number; walk: number; street: number
}

// The tower from the top: the crown, the wall whose windows spell the price, a frieze with the sentence, the ground
// floor with the door.
export function plan(W: number, H: number, dpr: number): Plan {
  // The pavement runs to the bottom of the page: deep enough for the door's light and the line under it.
  const phone = W < 640, street = phone ? 100 : 88
  const side = phone ? 3 : 4, cols = ART_COLS + 2 * side, depth = phone ? 8 : 16
  // On a phone the frieze takes the sentence in two lines and the ground floor is roomier.
  const bandRows = phone ? 17 : 8, groundRows = phone ? 30 : 11
  const sky = phone ? 72 : 106, margin = phone ? 6 : 40, room = (H - sky - street) * dpr
  const shape = (cw: number) => ({ ch: Math.max(3, Math.round(cw / CELL)), zu: Math.max(4, Math.round(cw / 4) * 4) })
  // The price stands in the middle of its wall: as many dark floors over it (under the crown) as under it, about as
  // deep as the wall left at its sides. Nothing above the crown is wall for its own sake.
  let clear = phone ? 4 : 5, steps = CROWN.length
  const crowned = () => CROWN.slice(CROWN.length - steps).reduce((n, tier) => n + tier.floors, 0)
  // The front stands in the middle of the page; its side wall, on the left, has to clear the margin.
  const fits = (cw: number) => { const { ch, zu } = shape(cw); return cols * cw / 2 + depth * zu / 2 + margin * dpr <= W * dpr / 2 && (crowned() + 2 * clear + ART_ROWS + bandRows + groundRows) * ch <= room }
  // As large as the page allows. On a short page the crown loses its steps, then the wall its spare floors, before
  // the windows get any smaller than they can be read at.
  let cw = Math.floor((phone ? 7 : 17) * dpr)
  const least = Math.floor((phone ? 5 : 9) * dpr)
  while (cw > least && !fits(cw)) cw--
  while (steps > 0 && !fits(cw)) steps--
  while (clear > 2 && !fits(cw)) clear--
  while (cw > 4 && !fits(cw)) cw--
  const { ch, zu } = shape(cw), upper = crowned() + clear, floors = upper + ART_ROWS + clear
  const band = bandRows * ch, ground = groundRows * ch, B = Math.round((H - street) * dpr), L = Math.round((W * dpr - cols * cw) / 2)
  const tiers: Tier[] = CROWN.slice(CROWN.length - steps).map(tier => ({ ...tier, back: tier.back * depth / 16 }))
  return { phone, dpr, side, cols, upper, floors, depth, tiers, cw, ch, zu, L, T: B - band - ground - floors * ch, B, band, ground, step: Math.max(2, Math.round(ch * .34)), walk: Math.round(street * dpr), street }
}

const random = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

// Tonight's moon: 0 new, 0.5 full, from the mean length of a lunation since the new moon of 6 January 2000.
function moonPhase(now: number) { const lunation = 29.530588853, days = (now - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000; return ((days % lunation) + lunation) % lunation / lunation }

// A letter in the air. `cross` comes in on one arc, large enough to be followed, and shrinks into its window; `fall`
// drops from the top of the page under its own weight; `leave` goes back out; `stray` is the one that ends up on the mast.
type Flight = { index: number; t0: number; dur: number; kind: 'cross' | 'fall' | 'leave' | 'stray'; fx: number; fy: number; bend: number; spin: number; flip: number; scale: number }

// When each window gets its letter, in milliseconds from the start. The price is on the wall from the first paint as
// empty windows a step lighter than the rest, so it can be read before anything moves. Three letters come in from the
// left at the price's own height, a tenth of a second apart, each a third of a second on its arc and five windows
// wide when it appears, and land one on another at the foot of the "$"'s first column; the sweep grows straight out
// of the third: the price is filled the way it is read, left to right, slowing as it nears the end, each column from
// the bottom up, each window one step dimmer for its first two frames; the count stands at 999 for a moment; then the
// thousandth letter falls, alone and the size of an envelope, down the gap between the 0 and the 2 into the point,
// and the whole price is a step brighter for two frames. A visitor who has seen that before gets the sweep and the
// last letter.
const FIRST = [340, 440, 540], FLIGHT = 340, FULL = { sweepAt: 540, sweep: 720, hold: 140, fall: 400, strayAt: 2600 }, QUICK = { sweepAt: 80, sweep: 560, hold: 90, fall: 320, strayAt: 1500 }
const AMBIENT_AFTER = 4400, BETWEEN = 34, FLASH = 34

export type Scene = { destroy: () => void; hover: (on: boolean) => void; welcome: (on: boolean) => void }

export function mountScene({ root, scene, base, air, door, reduced, quick, onCount }: { root: HTMLElement; scene: HTMLElement; base: HTMLCanvasElement; air: HTMLCanvasElement; door: HTMLElement; reduced: boolean; quick: boolean; onCount: (letters: number) => void }): Scene {
  const bctx = base.getContext('2d')!, actx = air.getContext('2d')!, times = quick ? QUICK : FULL, singles = quick ? 0 : FIRST.length
  // The canvases start at the top of the page, `over` pixels above the scene, so letters cross the header's band too.
  let p: Plan, site: Site, ink = {} as Ink, W = 0, H = 0, over = 0, airDpr = 1
  // The windows of the price in landing order, as columns and rows of the drawing; `carried` marks the ones whose
  // letter is seen arriving (the rest are simply lit on time).
  let cells: { col: number; row: number }[] = []
  const lodged = new Uint8Array(LETTERS), carried = new Uint8Array(LETTERS), landAt = new Float64Array(LETTERS), durations = new Float64Array(LETTERS), spawnOrder: number[] = []
  let flights: Flight[] = [], spawned = 0, lit = 0, counted = 0
  let strayLanded = false, hovering = false, spill = 0, welcomeAt = -1, welcomeRows = 0
  const lastAt = times.sweepAt + times.sweep + times.hold + times.fall
  let nextSwap = lastAt + AMBIENT_AFTER, swapping = -1, doneAt = Infinity, raf = 0, doorBox = { x: 0, y: 0, w: 0, h: 0 }, twinkles: { x: number; y: number; period: number; phase: number }[] = []
  const start = performance.now(), rand = random(20261115)

  function readInks() { const style = getComputedStyle(root); for (const name of INKS) ink[name] = style.getPropertyValue(`--nma-${name}`).trim() }

  // The landing order: column by column from the price's left edge to its right, each column from the bottom up; the
  // last window of all is the middle of the point.
  function order() {
    const all: { col: number; row: number }[] = []
    PRICE.forEach((line, row) => { for (let col = 0; col < line.length; col++) if (line[col] === '#') all.push({ col, row }) })
    let point = 0, nearest = Infinity
    all.forEach((cell, at) => { const d = Math.hypot((cell.col - POINT.col) * CELL, cell.row - POINT.row); if (d < nearest) { nearest = d; point = at } })
    const [last] = all.splice(point, 1)
    cells = [...all.sort((one, other) => one.col - other.col || other.row - one.row), last]
  }

  function schedule() {
    for (let i = 0; i < LETTERS; i++) {
      if (i < singles) { landAt[i] = FIRST[i]; durations[i] = FLIGHT; carried[i] = 1 }
      // The sweep slows into its last column: its place along the price is an ease-out of time.
      else if (i < LETTERS - 1) landAt[i] = times.sweepAt + times.sweep * (1 - (1 - (i - singles + 1) / (LETTERS - singles - 1)) ** (1 / 1.7))
      else { landAt[i] = lastAt; durations[i] = times.fall; carried[i] = 1 }
    }
    spawnOrder.length = 0
    for (let i = 0; i < LETTERS; i++) if (carried[i]) spawnOrder.push(i)
    spawnOrder.sort((one, other) => (landAt[one] - durations[one]) - (landAt[other] - durations[other]))
  }

  function measure() {
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    W = scene.clientWidth; H = scene.clientHeight; over = scene.offsetTop
    p = plan(W, H, dpr)
    airDpr = Math.min(2, dpr)
    for (const [canvas, context, scale] of [[base, bctx, dpr], [air, actx, airDpr]] as const) { canvas.width = Math.round(W * scale); canvas.height = Math.round((H + over) * scale); context.setTransform(1, 0, 0, 1, 0, Math.round(over * scale)) }
    const set = (name: string, device: number) => root.style.setProperty(name, `${device / dpr}px`)
    root.style.setProperty('--nma-over', `${over}px`); root.style.setProperty('--nma-street-h', `${p.street}px`); root.style.setProperty('--nma-side', String(p.side)); root.style.setProperty('--nma-cols', String(p.cols))
    set('--nma-left', p.L); set('--nma-width', p.cols * p.cw); set('--nma-band-top', p.B - p.ground - p.band); set('--nma-band-h', p.band); set('--nma-ground-top', p.B - p.ground); set('--nma-ground-h', p.ground)
    set('--nma-u', p.cw); set('--nma-v', p.ch); set('--nma-step', p.step); set('--nma-art', ART_COLS * p.cw); set('--nma-centre', p.L + p.cols * p.cw / 2)
    if (!cells.length) order()
    const sceneBox = scene.getBoundingClientRect(), box = door.getBoundingClientRect()
    doorBox = { x: box.left - sceneBox.left, y: box.top - sceneBox.top, w: box.width, h: box.height }
    site = { c: bctx, ink, dpr, W, H, over, L: p.L, base: p.B, cw: p.cw, ch: p.ch, zu: p.zu, cols: p.cols, floors: p.floors, tiers: p.tiers, band: p.band, ground: p.ground, walk: p.walk, depth: p.depth, phone: p.phone, moon: moonPhase(Date.now()), door: { x: Math.round(doorBox.x * dpr), w: Math.round(doorBox.w * dpr) } }
    // A few stars in the open sky above the roofs change brightness, slowly, each in its own time.
    const place = random(97), topSky = p.T / dpr - 30, clear = (p.L - p.depth * p.zu / 2) / dpr - 24, tip = mast(site)
    twinkles = []
    for (let i = 0; i < 60 && twinkles.length < (p.phone ? 5 : 9); i++) {
      const x = Math.round(place() * W), y = Math.round(-over + 10 + place() * (topSky + over - 10)), period = 2600 + place() * 4200, phase = place() * 6.28
      if (x > clear && x < (p.L + p.cols * p.cw) / dpr + 24 && y > tip.y - 30) continue
      twinkles.push({ x, y, period, phase })
    }
  }

  // Device pixels of a window on the base canvas; the floors of the crown stand back with their walls.
  function windowBox(col: number, row: number) {
    const gx = Math.max(1, Math.round(p.cw * .1)), gy = Math.max(1, Math.round(p.ch * .13)), back = setBack(row, p.tiers)
    return { x: p.L + col * p.cw + gx - back * p.zu / 2, y: p.T + row * p.ch + gy - back * p.zu / 4, w: p.cw - 2 * gx, h: p.ch - 2 * gy }
  }
  // An empty window: glass, in two tones so close that the wall is a quiet field behind the price (one window in
  // five has its blinds down).
  function pane(col: number, row: number) {
    let h = Math.imul(col + 1, 374761393) ^ Math.imul(row + 1, 668265263); h = Math.imul(h ^ h >>> 13, 1274126177)
    const box = windowBox(col, row)
    bctx.fillStyle = ink[((h ^ h >>> 16) >>> 0) % 5 ? 't-glass' : 't-glass-lo']; bctx.fillRect(box.x, box.y, box.w, box.h)
  }
  // A letter is one flat tone, so the price reads as clean type. Where there are the pixels for it (a letter in
  // flight, or any window on a dense screen) it also shows its flap, and one in twelve lies face up with a stamp and
  // an address. By day a letter in the air needs an edge to be seen against the sky.
  const faceUp = (index: number) => (index * 2654435761 >>> 0) % 12 === 0
  function letter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, up: boolean, detail: boolean, edged = false) {
    ctx.fillStyle = ink.paper; ctx.fillRect(x, y, w, h)
    const line = Math.max(1, Math.round(w / 24))
    if (edged && ink.edge !== 'transparent') { ctx.strokeStyle = ink.edge; ctx.lineWidth = line; ctx.strokeRect(x + line / 2, y + line / 2, w - line, h - line) }
    if (!detail) return
    if (up) {
      const stamp = Math.max(2, Math.round(h * .36)), pad = Math.max(1, Math.round(h * .16))
      ctx.fillStyle = ink.brand; ctx.fillRect(x + w - pad - stamp, y + pad, stamp, stamp)
      ctx.fillStyle = ink.crease
      ctx.fillRect(x + Math.round(w * .18), y + Math.round(h * .5), Math.round(w * .36), line); ctx.fillRect(x + Math.round(w * .18), y + Math.round(h * .5) + 2 * line, Math.round(w * .25), line)
    } else {
      ctx.strokeStyle = ink.crease; ctx.lineWidth = line; ctx.beginPath()
      ctx.moveTo(x + line / 2, y + line / 2); ctx.lineTo(x + w / 2, y + h * .58); ctx.lineTo(x + w - line / 2, y + line / 2); ctx.stroke()
    }
  }
  // The window a letter of the price belongs in: the drawing sits `side` windows in and `upper` floors down.
  const priceWindow = (index: number) => windowBox(cells[index].col + p.side, cells[index].row + p.upper)
  // A window of the price: its letter, or, until that lands, glass a clear step lighter than the wall's other
  // windows, so the price is there to be read from the first paint.
  function drawWindow(index: number) {
    const box = priceWindow(index)
    if (lodged[index]) letter(bctx, box.x, box.y, box.w, box.h, faceUp(index), p.dpr >= 1.5 && box.w >= 12)
    else { bctx.fillStyle = ink['t-ghost']; bctx.fillRect(box.x, box.y, box.w, box.h) }
  }

  function drawBase() {
    const c = bctx, dpr = p.dpr, one = Math.max(1, Math.round(dpr / 2))
    c.clearRect(0, -Math.round(over * dpr), base.width, base.height)
    drawCity(site)
    for (let row = 0; row < p.floors; row++) for (let col = setIn(row, p.tiers); col < p.cols - setIn(row, p.tiers); col++) pane(col, row)
    for (let i = 0; i < LETTERS; i++) drawWindow(i)
    if (welcomeRows) drawWelcome(0, welcomeRows)
    // The doorway: a reveal round the door, a lintel over it, and a threshold a little wider than the frame.
    const x = Math.round(doorBox.x * dpr), y = Math.round(doorBox.y * dpr), w = Math.round(doorBox.w * dpr), r = Math.max(2 * one, Math.round(p.cw * .5)), lip = Math.max(2 * one, Math.round(p.ch * .34))
    c.fillStyle = ink['t-reveal']; c.fillRect(x - r, y - r, w + 2 * r, p.B - y + r)
    c.fillStyle = ink['p-line']; c.fillRect(x - r - one, y - r - one, w + 2 * r + 2 * one, one); c.fillRect(x - r - one, y - r, one, p.B - y + r); c.fillRect(x + w + r, y - r, one, p.B - y + r)
    c.fillStyle = ink['t-joint']; c.fillRect(x - r - p.cw, y - r - one - lip, w + 2 * r + 2 * p.cw, lip); c.fillStyle = ink['p-line']; c.fillRect(x - r - p.cw, y - r - one - lip, w + 2 * r + 2 * p.cw, one)
    c.fillStyle = ink['t-top']; c.fillRect(x - r - Math.round(p.cw * .5), p.B - p.step, w + 2 * r + p.cw, p.step)
  }

  const tip = () => mast(site)
  // The letter that had no window left: it catches on the mast and stays there, a flag.
  function strayRest(t = 0) { const w = Math.max(14, p.cw / p.dpr * 2), h = w / CELL, m = tip(), rot = reduced ? -.05 : -.05 + .06 * Math.sin(t / 1300); return { x: m.x + 1 + w / 2, y: m.y + (p.phone ? 9 : 12) + h / 2, w, h, rot } }
  function drawStray(t: number) {
    const rest = strayRest(t), s = airDpr, m = tip()
    actx.save(); actx.translate((m.x + 1) * s, rest.y * s); actx.rotate(rest.rot); letter(actx, 0, -rest.h * s / 2, rest.w * s, rest.h * s, true, true, true); actx.restore()
  }

  function drawWelcome(from: number, to: number) {
    // Floor by floor from the street up, the dark windows come on low: someone is coming in.
    const rows = p.floors, taken = new Set<number>()
    for (let i = 0; i < LETTERS; i++) if (lodged[i]) taken.add((cells[i].row + p.upper) * p.cols + cells[i].col + p.side)
    for (let k = from; k < to && k < rows; k++) { const row = rows - 1 - k; for (let col = setIn(row, p.tiers); col < p.cols - setIn(row, p.tiers); col++) if (!taken.has(row * p.cols + col)) { const box = windowBox(col, row); bctx.fillStyle = ink.wake; bctx.fillRect(box.x, box.y, box.w, box.h) } }
  }

  // A letter on its way in, on one clear arc: from just beyond the left edge at the price's own height, or on a phone,
  // where the sky is overhead, from just above the page. It is five windows wide when it appears, so it is an
  // envelope all the way.
  function crossing(index: number, t0: number, dur: number, nth: number, of: number): Flight { const k = of > 1 ? nth / (of - 1) : .5; return { index, t0, dur, kind: 'cross', fx: p.phone ? .32 + k * .14 : -1, fy: p.phone ? -1 : .5 + k * .05, bend: p.phone ? .05 + k * .02 : -.13 + k * .03, spin: .8 - k * 1.2, flip: Math.PI * .8, scale: 6 } }
  // The thousandth falls straight down the dark gap between the 0 and the 2, into the point at its foot.
  function falling(index: number, t0: number, dur: number): Flight { return { index, t0, dur, kind: 'fall', fx: 0, fy: 0, bend: 0, spin: 0, flip: 0, scale: 2.8 } }

  // Where a letter in the air is at `u` of its way: centre, size, turn and tumble.
  function pose(f: Flight, t: number, u: number) {
    // Arriving letters slow into their window; leaving ones gather speed.
    const leaving = f.kind === 'leave', stray = f.kind === 'stray', e = leaving ? 1 - u ** 2.4 : 1 - (1 - u) ** 2.6
    let tx: number, ty: number, w: number, h: number
    if (stray) { const rest = strayRest(t); tx = rest.x; ty = rest.y; w = rest.w; h = rest.h }
    else { const box = priceWindow(f.index); w = box.w / p.dpr; h = box.h / p.dpr; tx = box.x / p.dpr + w / 2; ty = box.y / p.dpr + h / 2 }
    // A falling letter gathers speed all the way down, upright and the size of an envelope until the last of the drop.
    if (f.kind === 'fall') { const grow = 1 + (f.scale - 1) * Math.min(1, (1 - u) / .22), from = -over - h * f.scale; return { x: tx, y: from + (ty - from) * u * u, w: w * grow, h: h * grow, rot: 0, tumble: 1 } }
    const reach = Math.max(w, h) * f.scale
    const sx = leaving ? W + reach : f.fx < 0 && f.fy >= 0 ? -reach : W * f.fx, sy = leaving ? H * (Math.abs(f.fy) * .4 - .1) : f.fy < 0 ? -over - reach : H * f.fy
    const dx = tx - sx, dy = ty - sy, arc = Math.sin(Math.PI * e) * f.bend
    // It keeps its size for most of the way and only comes down to a window's as it arrives.
    const grow = stray ? 1 + (1 - e) * .4 : 1 + (f.scale - 1) * (leaving ? u : 1 - u) ** .8
    return { x: sx + dx * e - dy * arc, y: sy + dy * e + dx * arc, w: w * grow, h: h * grow, rot: (stray ? strayRest(t).rot : 0) + f.spin * (1 - e) ** 1.3, tumble: Math.max(.5, Math.abs(Math.cos(f.flip * (1 - e)))) }
  }
  function drawFlight(f: Flight, t: number) {
    const u = Math.min(1, (t - f.t0) / f.dur), s = airDpr, g = pose(f, t, u)
    actx.save(); actx.translate(g.x * s, g.y * s); actx.rotate(g.rot); actx.scale(1, g.tumble)
    letter(actx, -g.w * s / 2, -g.h * s / 2, g.w * s, g.h * s, f.kind === 'stray' || faceUp(Math.max(0, f.index)), g.w * s >= 12, true); actx.restore()
  }

  function drawAir(t: number) {
    const s = airDpr, c = actx, k = s / p.dpr
    c.clearRect(0, -Math.round(over * s), air.width, air.height)
    const fill = (tone: string, ...points: number[][]) => { c.fillStyle = tone; c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x * k, y * k) : c.moveTo(x * k, y * k)); c.fill() }
    // The stars that change: off, dim or bright, never in between.
    for (const star of twinkles) {
      const level = reduced ? 1 : Math.sin(t / star.period * 6.28 + star.phase)
      if (level < -.4) continue
      c.fillStyle = level > .5 ? ink['star-3'] : ink['star-2']; c.fillRect(Math.round(star.x * s), Math.round(star.y * s), Math.max(1, Math.round(s / 2)), Math.max(1, Math.round(s / 2)))
    }
    // Light from the door on the pavement: as wide as the door at the threshold and fanning out from there, in flat
    // steps of the door's own colour, each dimmer than the one before. With the pointer on the door every step moves
    // out and a brighter one appears at the threshold.
    const dx = doorBox.x * p.dpr, dw = doorBox.w * p.dpr, on = spill > .5, reach = (p.phone ? .62 : 1) * p.dpr
    const fan = (depth: number, tone: string) => fill(tone, [dx, p.B], [dx + dw, p.B], [dx + dw + depth * 2.1, p.B + depth], [dx - depth * .9, p.B + depth])
    fan((33 + 7 * spill) * reach, ink['spill-3']); fan((20 + 7 * spill) * reach, ink['spill-2']); fan((9 + 7 * spill) * reach, ink['spill-1'])
    if (on) fan(7 * reach, ink['spill-0'])
    // The mast's beacon: on for a second, off for a second.
    if (reduced || Math.floor(t / 1100) % 2 === 0) { const m = tip(), r = Math.max(2, 2.5 * s); c.fillStyle = ink.brand; c.fillRect(Math.round(m.x * s - r / 2), Math.round(m.y * s - r), Math.round(r), Math.round(r)) }
    if (strayLanded) drawStray(t)
    // The thousandth is in: the whole price is one flat step brighter for two frames.
    if (t >= doneAt && t - doneAt < FLASH) { c.fillStyle = ink.flash; for (let i = 0; i < LETTERS; i++) { const box = priceWindow(i); c.fillRect(box.x * k, box.y * k, box.w * k, box.h * k) } }
    // The sweep's leading edge: a window is one flat step dimmer for its first two frames.
    c.fillStyle = ink.between
    if (!reduced) for (let i = lit - 1; i >= singles && landAt[i] > t - BETWEEN; i--) if (!carried[i]) { const box = priceWindow(i); c.fillRect(box.x * k, box.y * k, box.w * k, box.h * k) }
    for (const f of flights) if (t >= f.t0) drawFlight(f, t)
  }

  // A window gets its letter: it is lit, and counted.
  function lodge(index: number) {
    lodged[index] = 1; drawWindow(index)
    if (index === swapping) swapping = -1
    else counted++
  }

  function frame(now: number) {
    const t = now - start
    while (spawned < spawnOrder.length && landAt[spawnOrder[spawned]] - durations[spawnOrder[spawned]] <= t) {
      const index = spawnOrder[spawned++], t0 = landAt[index] - durations[index]
      flights.push(index < singles ? crossing(index, t0, durations[index], index, singles) : falling(index, t0, durations[index]))
    }
    const before = counted
    // The windows whose letters are not followed are lit on time, in order.
    while (lit < LETTERS && (carried[lit] || landAt[lit] <= t)) { if (!carried[lit]) lodge(lit); lit++ }
    if (!strayLanded && t >= times.strayAt && !flights.some(f => f.kind === 'stray')) flights.push({ index: -1, kind: 'stray', t0: times.strayAt, dur: 1200, fx: -1, fy: .3, bend: -.2, spin: 2.6, flip: Math.PI * 2, scale: 1.4 })
    // Afterwards, mail keeps moving: now and then a letter leaves its window and another takes its place.
    if (t >= nextSwap && swapping < 0 && welcomeAt < 0) {
      swapping = Math.floor(rand() * LETTERS); nextSwap = t + 3400 + rand() * 2000
      lodged[swapping] = 0; drawWindow(swapping)
      // These two are alone in the sky, so they are smaller and turn less.
      const gone: Flight = { ...crossing(swapping, t, 760, rand(), 2), kind: 'leave', fy: rand() * .5 }, come = crossing(swapping, t + 620, 820, rand(), 2)
      for (const flight of [gone, come]) { flight.spin *= .5; flight.flip *= .4; flight.scale = 3.2; flights.push(flight) }
    }
    if (welcomeAt >= 0) { const all = p.floors, rows = Math.min(all, Math.ceil((now - welcomeAt) / 520 * all)); if (rows > welcomeRows) { drawWelcome(welcomeRows, rows); welcomeRows = rows } }
    spill += ((hovering ? 1 : 0) - spill) * .18
    flights = flights.filter(f => { if (t < f.t0 + f.dur) return true; if (f.kind === 'stray') strayLanded = true; else if (f.kind !== 'leave') lodge(f.index); return false })
    // The page counts the letters as they land, and says the rest once all thousand are in.
    if (counted !== before) { onCount(counted); root.dataset.nma = counted >= LETTERS ? 'settled' : 'counting'; if (counted >= LETTERS && doneAt === Infinity) doneAt = t }
    drawAir(t)
    raf = requestAnimationFrame(frame)
  }

  function still() { spill = hovering ? 1 : 0; drawAir(0) }

  readInks(); measure(); schedule()
  if (reduced) { lodged.fill(1); counted = lit = LETTERS; spawned = spawnOrder.length; strayLanded = true; root.dataset.nma = 'settled'; drawBase(); still() }
  else { root.dataset.nma = 'dark'; drawBase(); drawAir(0); raf = requestAnimationFrame(frame) }

  const resize = new ResizeObserver(() => { if (scene.clientWidth === W && scene.clientHeight === H) return; measure(); drawBase(); if (reduced) still() })
  resize.observe(scene)
  const theme = new MutationObserver(() => { readInks(); drawBase(); if (reduced) still() })
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  return {
    destroy() { cancelAnimationFrame(raf); resize.disconnect(); theme.disconnect() },
    hover(on) { hovering = on; if (reduced) still() },
    welcome(on) {
      if (on && welcomeAt < 0) { welcomeAt = performance.now(); if (reduced) { welcomeRows = p.floors; drawBase() } }
      else if (!on && welcomeAt >= 0) { welcomeAt = -1; welcomeRows = 0; drawBase() }
    },
  }
}
