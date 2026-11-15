// The night scene behind the nma homepage (variant-nma.tsx): a tower among darker buildings, its windows just big
// enough for a letter. A thousand letters fly in and lodge in the windows that spell the price of a thousand emails.
// Everything is flat fills on two canvases: the buildings with the lodged letters (drawn once, then letter by letter),
// and the air above them (letters in flight, the beacon and the light from the door), cleared every frame.

/** "$0.20" in windows. Every # is one window; there are exactly 1,000. */
const PRICE = [
  '.....#.........#####.........#####......#####..',
  '.....#........#######.......#######....#######.',
  '.....#.......#########.....#########..#########',
  '..#######....#########.....#########..#########',
  '.#########...###...###.....###...###..###...###',
  '###########..###...###.....###...###..###...###',
  '###########..###...###.....###...###..###...###',
  '###..#..###..###...###.....###...###..###...###',
  '###..#..###..###...###.....###...###..###...###',
  '###..#..###..###...###...........###..###...###',
  '###..#..###..###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '###..#.......###...###...........###..###...###',
  '#########....###...###.......#######..###...###',
  '##########...###...###......########..###...###',
  '.##########..###...###.....########...###...###',
  '..#########..###...###.....#######....###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '.....#..###..###...###.....###........###...###',
  '###..#..###..###...###.....###........###...###',
  '###..#..###..###...###.....###........###...###',
  '###..#..###..###...###.....###........###...###',
  '###..#..###..###...###.....###........###...###',
  '###########..###...###.....###........###...###',
  '###########..###...###.....###........###...###',
  '.#########...###...###.....###........###...###',
  '..#######....#########.###.#########..#########',
  '.....#.......#########.###.#########..#########',
  '.....#........#######..###.#########...#######.',
  '.....#.........#####...###.#########....#####..',
] as const
export const LETTERS = 1000

// A window is 18 wide for every 13 tall: the shape of an envelope.
const CELL = 18 / 13
const BELOW = 2, ART_COLS = PRICE[0].length, ART_ROWS = PRICE.length

/** Where everything is, in CSS pixels inside the scene. The page's own boxes (band, ground floor, street) read the same numbers as custom properties. */
export type Plan = {
  phone: boolean; dpr: number; scale: number; side: number; cols: number; upper: number; floors: number
  cw: number; ch: number; cwDev: number; chDev: number
  left: number; top: number; bottom: number; width: number; depth: number
  bandTop: number; bandH: number; groundTop: number; groundH: number; streetH: number
}

// The tower from the top: dark floors, the floors that spell the price, then a plinth with the sentence and the door.
export function plan(W: number, H: number, dpr: number): Plan {
  const phone = W < 640
  // On a tall wide screen the tower grows, and the plinth, its type and the door grow with it (up to 1.4 times).
  const scale = W < 1100 ? 1 : Math.max(1, Math.min(1.4, H / 836))
  const bandH = phone ? 46 : Math.round(64 * scale), groundH = phone ? 128 : Math.round(92 * scale), streetH = W < 1100 ? 92 : 68
  const sky = phone ? 56 : 66, margin = phone ? 30 : 48, depth = phone ? 8 : 22, side = phone ? 3 : 4
  const upperMin = 3, upperWant = phone ? 30 : 16, upperMax = phone ? 36 : 20
  const cols = ART_COLS + 2 * side, room = H - sky - bandH - groundH - streetH
  // As large as the width allows, but leaving the tower dark floors above the price when the height allows it.
  const widest = (W - 2 * margin - depth) / cols, tallest = room / (upperMin + ART_ROWS + BELOW) * CELL, ideal = room / (upperWant + ART_ROWS + BELOW) * CELL
  const cwDev = Math.max(4, Math.floor(Math.min(widest, tallest, Math.max(ideal, phone ? 6 : 9), 20) * dpr))
  const chDev = Math.max(3, Math.round(cwDev / CELL)), cw = cwDev / dpr, ch = chDev / dpr
  const upper = Math.max(upperMin, Math.min(upperMax, Math.floor(room / ch) - ART_ROWS - BELOW)), floors = upper + ART_ROWS + BELOW
  const width = cols * cw, height = floors * ch + bandH + groundH
  const snap = (value: number) => Math.round(value * dpr) / dpr
  // On a wide screen the tower stands right of centre, leaving the sky on its left to the moon and the letters.
  const left = snap(Math.max(margin, Math.min(W - margin - depth - width, (W - width - depth) / 2 + (phone ? 0 : Math.min(W * .085, (W - width) * .22))))), bottom = snap(H - streetH), top = bottom - height
  return { phone, dpr, scale, side, cols, upper, floors, cw, ch, cwDev, chDev, left, top, bottom, width, depth, bandTop: top + floors * ch, bandH, groundTop: bottom - groundH, groundH, streetH }
}

// The tower steps in twice near the top: how many windows a floor is set in from each edge.
const CROWN = 4
export const setback = (row: number, upper: number) => upper < 2 * CROWN + 2 ? 0 : row < CROWN ? 8 : row < 2 * CROWN ? 4 : 0

const random = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

// Tonight's moon: 0 new, 0.5 full, from the mean length of a lunation since the new moon of 6 January 2000.
function moonPhase(now: number) { const lunation = 29.530588853, days = (now - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000; return ((days % lunation) + lunation) % lunation / lunation }

// The buildings either side of the tower, nearest first: width and height as fractions of the tower's, a wall tone, and
// what stands on the roof (0 nothing, 1 a plant room, 2 an aerial).
const LEFT = [[.44, .5, 1, 0], [.3, .3, 2, 0], [.48, .41, 0, 1], [.26, .23, 1, 0], [.52, .34, 2, 2], [.34, .2, 0, 0]] as const
const RIGHT = [[.36, .35, 2, 0], [.5, .58, 0, 2], [.24, .26, 1, 0], [.46, .43, 2, 1], [.3, .21, 0, 0], [.52, .33, 1, 0]] as const

type Flight = { index: number; t0: number; dur: number; fx: number; fy: number; bend: number; spin: number; flip: number; scale: number; leaving: boolean; stray?: boolean }
type Colors = { wall: string; side: string; hole: string; wake: string; lit: string; crease: string; brand: string; moon: string; spill: string; street: string; far: string[]; farHole: string }

// When each letter lands, in milliseconds from the start: five you can follow, then the storm, then six stragglers.
const FIRST = [400, 680, 880, 1010, 1100], LAST = [45, 65, 90, 125, 170, 230], STORM = 1250
const STRAY_AT = 3300, AMBIENT_AT = 6000

export type Scene = { destroy: () => void; hover: (on: boolean) => void; welcome: (on: boolean) => void }

export function mountScene({ root, scene, base, air, door, reduced, onCount }: { root: HTMLElement; scene: HTMLElement; base: HTMLCanvasElement; air: HTMLCanvasElement; door: HTMLElement; reduced: boolean; onCount: (letters: number) => void }): Scene {
  const bctx = base.getContext('2d')!, actx = air.getContext('2d')!
  // The canvases start at the top of the page, `over` pixels above the scene, so letters cross the header's band too.
  let p: Plan, colors: Colors, W = 0, H = 0, over = 0, airDpr = 1
  // The windows of the price in landing order, as columns and rows of the drawing.
  let cells: { col: number; row: number }[] = []
  const lodged = new Uint8Array(LETTERS), landAt = new Float64Array(LETTERS), durations = new Float64Array(LETTERS), spawnOrder: number[] = []
  let flights: Flight[] = [], spawned = 0, counted = 0
  let strayLanded = false, hovering = false, spill = 0, welcomeAt = -1, welcomeRows = 0
  let nextSwap = AMBIENT_AT, swapping = -1, raf = 0, doorBox = { x: 0, y: 0, w: 0, h: 0 }
  const start = performance.now(), rand = random(20261115)

  function readColors() {
    const style = getComputedStyle(root), get = (name: string) => style.getPropertyValue(name).trim()
    colors = { wall: get('--nma-wall'), side: get('--nma-side'), hole: get('--nma-hole'), wake: get('--nma-wake'), lit: get('--nma-lit'), crease: get('--nma-crease'), brand: get('--nma-brand'), moon: get('--nma-moon'), spill: get('--nma-spill'), street: get('--nma-street'),
      far: [get('--nma-far-1'), get('--nma-far-2'), get('--nma-far-3')], farHole: get('--nma-far-hole') }
  }

  // The landing order: random, except that the stragglers are one obvious gap per numeral and the last is the point.
  function order() {
    const all: { col: number; row: number }[] = []
    PRICE.forEach((line, row) => { for (let col = 0; col < line.length; col++) if (line[col] === '#') all.push({ col, row }) })
    const shuffle = random(7)
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(shuffle() * (i + 1)); [all[i], all[j]] = [all[j], all[i]] }
    const last: { col: number; row: number }[] = []
    for (const [fx, fy] of [[.9, .5], [.02, .3], [.74, .06], [.36, .62], [.98, .8], [.52, .97]]) {
      const x = fx * (ART_COLS - 1), y = fy * (ART_ROWS - 1)
      let bestAt = -1, bestDistance = Infinity
      all.forEach((cell, at) => { const d = Math.hypot((cell.col - x) * CELL, cell.row - y); if (d < bestDistance) { bestDistance = d; bestAt = at } })
      last.push(all.splice(bestAt, 1)[0])
    }
    cells = [...all, ...last]
  }

  function schedule() {
    const jitter = random(11)
    for (let i = 0; i < LETTERS; i++) {
      if (i < FIRST.length) { landAt[i] = FIRST[i]; durations[i] = 430 }
      else if (i < LETTERS - LAST.length) { landAt[i] = FIRST[FIRST.length - 1] + STORM * ((i - FIRST.length + 1) / (LETTERS - FIRST.length - LAST.length)) ** .62; durations[i] = 230 + jitter() * 90 }
      else { const k = i - (LETTERS - LAST.length); landAt[i] = landAt[i - 1] + LAST[k]; durations[i] = 300 + k * 32 }
    }
    spawnOrder.length = 0
    for (let i = 0; i < LETTERS; i++) spawnOrder.push(i)
    spawnOrder.sort((a, b) => (landAt[a] - durations[a]) - (landAt[b] - durations[b]))
  }

  function measure() {
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    W = scene.clientWidth; H = scene.clientHeight; over = scene.offsetTop
    p = plan(W, H, dpr)
    airDpr = Math.min(2, dpr)
    for (const [canvas, context, scale] of [[base, bctx, dpr], [air, actx, airDpr]] as const) { canvas.width = Math.round(W * scale); canvas.height = Math.round((H + over) * scale); context.setTransform(1, 0, 0, 1, 0, Math.round(over * scale)) }
    const set = (name: string, value: number) => root.style.setProperty(name, `${value}px`)
    set('--nma-over', over); root.style.setProperty('--nma-scale', String(p.scale))
    set('--nma-left', p.left); set('--nma-width', p.width); set('--nma-band-top', p.bandTop); set('--nma-band-h', p.bandH)
    set('--nma-ground-top', p.groundTop); set('--nma-ground-h', p.groundH); set('--nma-street-h', p.streetH); set('--nma-centre', p.left + p.width / 2)
    if (!cells.length) order()
    const sceneBox = scene.getBoundingClientRect(), box = door.getBoundingClientRect()
    doorBox = { x: box.left - sceneBox.left, y: box.top - sceneBox.top, w: box.width, h: box.height }
  }

  // Device pixels of a window on the base canvas.
  function windowBox(col: number, row: number) {
    const dpr = p.dpr, gx = Math.max(1, Math.round(p.cwDev * .11)), gy = Math.max(1, Math.round(p.chDev * .15))
    return { x: Math.round(p.left * dpr) + col * p.cwDev + gx, y: Math.round(p.top * dpr) + row * p.chDev + gy, w: p.cwDev - 2 * gx, h: p.chDev - 2 * gy }
  }
  // A letter face-down shows its flap; one in nine landed face-up and shows a stamp and an address.
  const faceUp = (index: number) => (index * 2654435761 >>> 0) % 9 === 0
  function letter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, up: boolean) {
    ctx.fillStyle = colors.lit; ctx.fillRect(x, y, w, h)
    if (w < 9) return
    const line = Math.max(1, Math.round(w / 26))
    if (up) {
      const stamp = Math.max(2, Math.round(h * .34)), pad = Math.max(1, Math.round(h * .16))
      ctx.fillStyle = colors.brand; ctx.fillRect(x + w - pad - stamp, y + pad, stamp, stamp)
      ctx.fillStyle = colors.crease
      ctx.fillRect(x + Math.round(w * .2), y + Math.round(h * .52), Math.round(w * .34), line); ctx.fillRect(x + Math.round(w * .2), y + Math.round(h * .52) + 2 * line, Math.round(w * .24), line)
    } else {
      ctx.strokeStyle = colors.crease; ctx.lineWidth = line; ctx.beginPath()
      ctx.moveTo(x + line / 2, y + line / 2); ctx.lineTo(x + w / 2, y + h * .6); ctx.lineTo(x + w - line / 2, y + line / 2); ctx.stroke()
    }
  }
  // The window a letter of the price belongs in: the drawing sits `side` windows in and `upper` floors down.
  const priceWindow = (index: number) => windowBox(cells[index].col + p.side, cells[index].row + p.upper)
  function drawWindow(index: number) {
    const box = priceWindow(index)
    if (lodged[index]) letter(bctx, box.x, box.y, box.w, box.h, faceUp(index))
    else { bctx.fillStyle = colors.hole; bctx.fillRect(box.x, box.y, box.w, box.h) }
  }

  const mastTop = () => ({ x: p.left + p.width / 2, y: p.top - (p.phone ? 34 : 52 * p.scale) })

  function drawBase() {
    const dpr = p.dpr, c = bctx, px = (value: number) => Math.round(value * dpr)
    c.clearRect(0, -px(over), base.width, base.height)
    const L = px(p.left), T = px(p.top), R = L + p.cols * p.cwDev, B = px(p.bottom), D = px(p.depth), height = B - T, width = R - L
    // The moon, at tonight's phase (never thinner than a sliver, so there is always one).
    {
      const r = px(p.phone ? 12 : 21 * p.scale), cx = px(p.phone ? W * .17 : Math.max(60, p.left * .46)), cy = px(p.phone ? p.top * .5 : Math.max(40, H * .17))
      let phase = moonPhase(Date.now()); if (phase < .07 || phase > .93) phase = .07
      const k = Math.cos(2 * Math.PI * phase)
      c.save(); c.translate(cx, cy); if (phase > .5) c.scale(-1, 1); c.rotate(-.42)
      c.fillStyle = colors.moon; c.beginPath(); c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2); c.ellipse(0, 0, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k > 0); c.fill(); c.restore()
    }
    // The neighbours: darker walls with their own rhythm of windows, all asleep.
    for (const [list, direction] of [[LEFT, -1], [RIGHT, 1]] as const) {
      let edge = direction < 0 ? L + Math.round(width * .1) : R + D - Math.round(width * .1)
      for (let i = 0; direction < 0 ? edge > 0 : edge < base.width; i++) {
        const [fw, fh, tone, roof] = list[i % list.length], w = Math.round(width * fw), h = Math.round(height * fh), x = direction < 0 ? edge - w : edge, top = B - h
        c.fillStyle = colors.far[tone]; c.fillRect(x, top, w, h)
        if (roof === 1) c.fillRect(x + Math.round(w * .2), top - px(9), Math.round(w * .34), px(9))
        if (roof === 2) c.fillRect(x + Math.round(w * .7), top - px(p.phone ? 20 : 34), Math.max(1, px(1.5)), px(p.phone ? 20 : 34))
        // Its windows: the tower's proportions at a slightly different pitch, so the street reads as one material.
        const pw = Math.round(p.cwDev * (1.2 + (i % 3) * .15)), ph = Math.round(p.chDev * (1.3 + (i % 2) * .3)), inset = Math.round(pw * .7)
        c.fillStyle = colors.farHole
        for (let y = top + inset; y + ph < B - px(12); y += ph) for (let wx = x + inset; wx + pw <= x + w - inset * .5; wx += pw) c.fillRect(wx, y, Math.round(pw * .68), Math.round(ph * .52))
        edge += direction * w
      }
    }
    // The tower: its side, the mast, then the front, stepping in twice at the top.
    const body = setback(0, p.upper) ? 2 * CROWN * p.chDev : 0
    c.fillStyle = colors.side; c.beginPath(); c.moveTo(R, T + body); c.lineTo(R + D, T + body + Math.round(D * .62)); c.lineTo(R + D, B); c.lineTo(R, B); c.fill()
    c.fillStyle = colors.wall
    const mast = mastTop()
    c.fillRect(px(mast.x) - Math.max(1, px(1)), px(mast.y), Math.max(2, px(2)), T - px(mast.y))
    for (const [from, to] of [[0, CROWN], [CROWN, 2 * CROWN]]) { const inset = setback(from, p.upper) * p.cwDev; c.fillRect(L + inset, T + from * p.chDev, width - 2 * inset, (to - from) * p.chDev) }
    c.fillRect(L, T + body, width, height - body)
    c.fillStyle = colors.hole
    for (let row = 0; row < p.floors; row++) for (let col = setback(row, p.upper); col < p.cols - setback(row, p.upper); col++) { const box = windowBox(col, row); c.fillRect(box.x, box.y, box.w, box.h) }
    for (let i = 0; i < LETTERS; i++) if (lodged[i]) drawWindow(i)
    if (welcomeRows) drawWelcome(0, welcomeRows)
    c.fillStyle = colors.street; c.fillRect(0, B, base.width, Math.max(1, px(1)))
  }

  // The letter that had no window left: it catches on the mast and stays there, a flag.
  function strayRest(t = 0) { const w = Math.max(15, p.cw * 2.1), h = w / CELL, mast = mastTop(), rot = reduced ? -.05 : -.05 + .06 * Math.sin(t / 1300); return { x: mast.x + 1 + w / 2, y: mast.y + (p.phone ? 9 : 13 * p.scale) + h / 2, w, h, rot } }
  function drawStray(t: number) {
    const rest = strayRest(t), s = airDpr, mast = mastTop()
    actx.save(); actx.translate((mast.x + 1) * s, rest.y * s); actx.rotate(rest.rot); letter(actx, 0, -rest.h * s / 2, rest.w * s, rest.h * s, true); actx.restore()
  }

  function drawWelcome(from: number, to: number) {
    // Floor by floor from the street up, the dark windows come on low: someone is coming in.
    const rows = p.floors, taken = new Set<number>()
    for (let i = 0; i < LETTERS; i++) if (lodged[i]) taken.add((cells[i].row + p.upper) * p.cols + cells[i].col + p.side)
    bctx.fillStyle = colors.wake
    for (let k = from; k < to && k < rows; k++) { const row = rows - 1 - k; for (let col = setback(row, p.upper); col < p.cols - setback(row, p.upper); col++) if (!taken.has(row * p.cols + col)) { const box = windowBox(col, row); bctx.fillRect(box.x, box.y, box.w, box.h) } }
  }

  function makeFlight(index: number, t0: number, dur: number, leaving = false): Flight {
    // fx or fy below zero means "from beyond that edge": most letters come in from the left, the rest over the top
    // (to the right of the logo, which they would otherwise cover).
    const fromTop = rand() < (p.phone ? .5 : .22)
    return { index, t0, dur, leaving, fx: fromTop ? (p.phone ? .32 : .12) + rand() * (p.phone ? .5 : .4) : -1, fy: fromTop ? -1 : -.05 + rand() * .75, bend: (rand() - .5) * .22, spin: (rand() - .5) * 4.2, flip: (.7 + rand() * .9) * Math.PI, scale: (p.phone ? 4.2 : 3.2) + rand() * 1.8 }
  }
  // The first letters take one clear path, so the eye can follow a letter into a window before the storm.
  function firstFlight(index: number): Flight { const k = index / (FIRST.length - 1); return { index, t0: landAt[index] - durations[index], dur: durations[index], leaving: false, fx: -1, fy: .08 + k * .3, bend: -.16 + k * .08, spin: 1.6 - k * 2.4, flip: Math.PI * 1.1, scale: p.phone ? 5.6 : 4.4 } }

  function drawFlight(f: Flight, t: number) {
    if (t < f.t0) return
    const u = Math.min(1, (t - f.t0) / f.dur), s = airDpr
    // Arriving letters slow into their window; leaving ones gather speed.
    const e = f.leaving ? 1 - u ** 2.4 : 1 - (1 - u) ** 2.4
    let tx: number, ty: number, w: number, h: number
    if (f.stray) { const rest = strayRest(t); tx = rest.x; ty = rest.y; w = rest.w; h = rest.h }
    else { const box = priceWindow(f.index); w = box.w / p.dpr; h = box.h / p.dpr; tx = box.x / p.dpr + w / 2; ty = box.y / p.dpr + h / 2 }
    const reach = Math.max(w, h) * f.scale
    const sx = f.leaving ? W + reach : f.fx < 0 && f.fy >= 0 ? -reach : W * f.fx, sy = f.leaving ? H * (Math.abs(f.fy) * .4 - .1) : f.fy < 0 ? -over - reach : H * f.fy
    const dx = tx - sx, dy = ty - sy, arc = Math.sin(Math.PI * e) * f.bend
    const x = sx + dx * e - dy * arc, y = sy + dy * e + dx * arc
    const grow = f.stray ? 1 + (1 - e) * .4 : 1 + (f.scale - 1) * (1 - e) ** 1.15
    const rot = (f.stray ? strayRest(t).rot : 0) + f.spin * (1 - e) ** 1.3, flipY = Math.max(.38, Math.abs(Math.cos(f.flip * (1 - e))))
    actx.save(); actx.translate(x * s, y * s); actx.rotate(rot); actx.scale(1, flipY)
    letter(actx, -w * grow * s / 2, -h * grow * s / 2, w * grow * s, h * grow * s, f.stray ? true : faceUp(f.index)); actx.restore()
  }

  function drawAir(t: number) {
    const s = airDpr, c = actx
    c.clearRect(0, -Math.round(over * s), air.width, air.height)
    // Light from the door on the pavement: a flat patch, longer when the pointer is on the door.
    const reach = (p.phone ? 14 : 18) + 8 * spill, spread = reach * .7
    c.fillStyle = colors.spill; c.beginPath()
    c.moveTo(doorBox.x * s, (p.bottom + 1) * s); c.lineTo((doorBox.x + doorBox.w) * s, (p.bottom + 1) * s); c.lineTo((doorBox.x + doorBox.w + spread) * s, (p.bottom + reach) * s); c.lineTo((doorBox.x - spread) * s, (p.bottom + reach) * s); c.fill()
    // The mast's beacon: on for a second, off for a second.
    if (reduced || Math.floor(t / 1100) % 2 === 0) { const mast = mastTop(), r = Math.max(2, (p.phone ? 2 : 2.5) * s); c.fillStyle = colors.brand; c.fillRect(Math.round(mast.x * s - r), Math.round(mast.y * s - r), Math.round(2 * r), Math.round(2 * r)) }
    if (strayLanded) drawStray(t)
    for (const f of flights) drawFlight(f, t)
  }

  function land(f: Flight) {
    if (f.stray) { strayLanded = true; return }
    if (f.leaving) return
    lodged[f.index] = 1; drawWindow(f.index)
    if (f.index === swapping) swapping = -1
    else counted++
  }

  function frame(now: number) {
    const t = now - start
    while (spawned < LETTERS && landAt[spawnOrder[spawned]] - durations[spawnOrder[spawned]] <= t) {
      const index = spawnOrder[spawned++]
      flights.push(index < FIRST.length ? firstFlight(index) : makeFlight(index, landAt[index] - durations[index], durations[index]))
    }
    if (!strayLanded && t >= STRAY_AT && !flights.some(f => f.stray)) flights.push({ index: -1, stray: true, t0: STRAY_AT, dur: 1250, leaving: false, fx: -1, fy: .3, bend: -.2, spin: 2.6, flip: Math.PI * 2, scale: 1.4 })
    // Afterwards, mail keeps moving: now and then a letter leaves its window and another takes its place.
    if (t >= nextSwap && swapping < 0 && welcomeAt < 0) {
      swapping = Math.floor(rand() * LETTERS); nextSwap = t + 2800 + rand() * 1600
      lodged[swapping] = 0; drawWindow(swapping)
      // These two are alone in the sky, so they turn less and stay readable as letters.
      for (const flight of [makeFlight(swapping, t, 640, true), makeFlight(swapping, t + 540, 720)]) { flight.spin *= .35; flight.flip *= .3; flights.push(flight) }
    }
    if (welcomeAt >= 0) { const all = p.floors, rows = Math.min(all, Math.ceil((now - welcomeAt) / 520 * all)); if (rows > welcomeRows) { drawWelcome(welcomeRows, rows); welcomeRows = rows } }
    spill += ((hovering ? 1 : 0) - spill) * .2
    const before = counted
    flights = flights.filter(f => { if (t < f.t0 + f.dur) return true; land(f); return false })
    // The page counts the letters as they land, and says the rest once all thousand are in.
    if (counted !== before) { onCount(counted); root.dataset.nma = counted >= LETTERS ? 'settled' : 'counting' }
    drawAir(t)
    raf = requestAnimationFrame(frame)
  }

  function still() { spill = hovering ? 1 : 0; drawAir(0) }

  readColors(); measure(); schedule()
  if (reduced) { lodged.fill(1); counted = spawned = LETTERS; strayLanded = true; root.dataset.nma = 'settled'; drawBase(); still() }
  else { root.dataset.nma = 'dark'; drawBase(); drawAir(0); raf = requestAnimationFrame(frame) }

  const resize = new ResizeObserver(() => { if (scene.clientWidth === W && scene.clientHeight === H) return; measure(); drawBase(); if (reduced) still() })
  resize.observe(scene)
  const theme = new MutationObserver(() => { readColors(); drawBase(); if (reduced) still() })
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
