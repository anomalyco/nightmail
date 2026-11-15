// The still part of the nma homepage's scene (nma-scene.ts draws the windows and the letters over it): the sky, the
// streets and every building, drawn once per layout on the base canvas.
//
// One oblique projection throughout: every front is a true rectangle, so the price and the page's own copy sit on the
// tower's face undistorted, and depth runs up and to the left at a slope of 1 in 2, at half scale. We look from above
// and from the left, so things are painted from the back forwards and from right to left.
//
// The picture is built in layers, each one flat step from the last: the sky, a skyline far off, the row across the
// next street, the buildings on ours, the tower's side, the tower's front. Within a building the roof is lightest,
// then the front, then the side (the light is over our right shoulder). The tower is the one thing drawn in detail:
// the buildings round it have a roofline of their own and large windows a small step off their walls, at half the
// tower's density, a few runs of them lit. Edges are single hairlines; nothing is a gradient. Lengths are device
// pixels unless a name says otherwise.

/** The scene's tones, read from the page's --nma-* custom properties (variant-nma.css) so both themes share the code. */
export const INKS = ['sky', 'star-1', 'star-2', 'star-3', 'moon', 'sun', 'skyline', 'ground',
  'far-top', 'far-side', 'far-front', 'far-lit',
  'n-top', 'n-side', 'n-front', 'n-base', 'n-line', 'n-roof', 'n-shade', 'n-glass', 'late',
  't-top', 't-side', 't-front', 't-plinth', 't-plinth-side', 't-glass', 't-glass-lo', 't-ghost', 't-side-glass', 't-reveal', 't-line', 'p-line', 't-roof', 't-joint',
  'walk', 'metal', 'metal-lit',
  'paper', 'between', 'flash', 'crease', 'edge', 'wake', 'brand', 'brand-deep', 'brand-lit', 'brand-dark', 'spill-0', 'spill-1', 'spill-2', 'spill-3'] as const
export type Ink = Record<typeof INKS[number], string>

/** One step of the tower's crown: how many windows it is set in from each side, how many floors high it is, and how many cells of depth its face stands back from the tower's front. */
export type Tier = { inset: number; floors: number; back: number }
/** The crown from the top down: two deep steps. */
export const CROWN: Tier[] = [{ inset: 8, floors: 4, back: 4 }, { inset: 4, floors: 4, back: 2 }]
/** The step of the crown a floor belongs to, if any (floors count from the top of the tower). */
const tierOf = (row: number, tiers: Tier[]) => { for (const tier of tiers) { if (row < tier.floors) return tier; row -= tier.floors } }
/** How many windows a floor is set in from each side of the tower, and how far its face stands back. */
export const setIn = (row: number, tiers: Tier[]) => tierOf(row, tiers)?.inset ?? 0
export const setBack = (row: number, tiers: Tier[]) => tierOf(row, tiers)?.back ?? 0

export type Site = {
  c: CanvasRenderingContext2D; ink: Ink; dpr: number
  W: number; H: number; over: number      // the scene in CSS pixels, and how far the canvas reaches above it
  L: number; base: number                 // the tower's front left corner on the street
  cw: number; ch: number; zu: number      // a window cell, and one cell of depth (a multiple of 4, so half and quarter are whole)
  cols: number; floors: number; tiers: Tier[]   // windows across, floors in all, and the steps of the crown from the top down
  band: number; ground: number; walk: number    // under the windows: the frieze the sentence is cut into, and the ground floor; the pavement's depth on the page
  depth: number; phone: boolean; moon: number   // the tower's depth in cells; tonight's phase (0 new, .5 full)
  door: { x: number; w: number }                // the door's left edge and width
}

const random = (seed: number) => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

/** The one thing a building's roof is known by. */
type Roof = 'plant' | 'setback' | 'cornice' | 'stack' | 'spire'
/** How a building's windows are set out, all of them larger than the tower's: square panes, tall ones between piers, or wide ones. Pitch and pane in window cells and floors. */
const PANES = { square: { px: 2, py: 2, w: 1.3, h: 1.1 }, tall: { px: 2, py: 3, w: 1.1, h: 2 }, wide: { px: 3, py: 2, w: 2.3, h: 1 } } as const
/** A building on the street: left edge and width in window cells from the tower's left (or, on its right, from its right), height in floors, depth in cells; `shade` is how many steps darker than its neighbours it is built. */
type Block = { x: number; w: number; h: number; d: number; roof: Roof; panes: keyof typeof PANES; shade?: number }
// The street from the tower outwards: a paved lane eleven windows wide on the tower's left, an alley three wide on its
// right. No two neighbours share a roofline, and none has the window of the one beside it.
export const LANE = 11
const LEFT: Block[] = [
  { x: -29, w: 18, h: 31, d: 12, roof: 'plant', panes: 'square' },
  { x: -45, w: 16, h: 24, d: 11, roof: 'setback', panes: 'tall', shade: 1 },
  { x: -67, w: 22, h: 36, d: 13, roof: 'cornice', panes: 'wide' },
  { x: -83, w: 16, h: 22, d: 10, roof: 'stack', panes: 'square', shade: 2 },
  { x: -105, w: 22, h: 30, d: 13, roof: 'spire', panes: 'tall', shade: 1 },
  { x: -125, w: 20, h: 25, d: 12, roof: 'plant', panes: 'wide' },
  { x: -149, w: 24, h: 34, d: 13, roof: 'setback', panes: 'square', shade: 2 },
  { x: -169, w: 20, h: 23, d: 11, roof: 'cornice', panes: 'tall', shade: 1 },
  { x: -193, w: 24, h: 31, d: 12, roof: 'stack', panes: 'wide' },
  { x: -215, w: 22, h: 26, d: 12, roof: 'spire', panes: 'square', shade: 2 },
]
const RIGHT: Block[] = [
  { x: 3, w: 16, h: 25, d: 11, roof: 'cornice', panes: 'tall', shade: 1 },
  { x: 19, w: 22, h: 37, d: 13, roof: 'spire', panes: 'square' },
  { x: 41, w: 16, h: 23, d: 10, roof: 'stack', panes: 'wide', shade: 2 },
  { x: 57, w: 20, h: 31, d: 12, roof: 'plant', panes: 'tall', shade: 1 },
  { x: 77, w: 24, h: 26, d: 12, roof: 'setback', panes: 'square' },
  { x: 101, w: 20, h: 34, d: 13, roof: 'cornice', panes: 'wide', shade: 2 },
  { x: 121, w: 22, h: 24, d: 11, roof: 'plant', panes: 'tall', shade: 1 },
  { x: 143, w: 24, h: 32, d: 12, roof: 'spire', panes: 'square' },
  { x: 167, w: 22, h: 27, d: 12, roof: 'stack', panes: 'wide', shade: 2 },
]
// The row across the next street: [left edge, width, floors, depth], right to left.
const BACK = 30
const FAR = [[232, 22, 30, 10], [206, 26, 35, 12], [176, 26, 27, 10], [148, 24, 36, 12], [118, 26, 29, 10], [92, 22, 34, 11], [62, 26, 28, 12], [36, 22, 36, 10], [8, 24, 30, 12], [-18, 22, 34, 11],
  [-46, 24, 27, 10], [-70, 20, 36, 11], [-98, 24, 30, 12], [-122, 20, 26, 10], [-150, 24, 35, 11], [-178, 24, 28, 12], [-204, 22, 33, 10], [-230, 22, 29, 11]] as const
// The skyline beyond: [left edge, width, height above the street in floors, top: 0 flat, 1 stepped, 2 with a mast].
const SKYLINE = [[-236, 20, 50, 1], [-214, 16, 44, 0], [-196, 22, 54, 2], [-172, 18, 47, 0], [-152, 24, 52, 1], [-126, 16, 45, 0], [-108, 20, 56, 2], [-86, 18, 48, 1], [-66, 22, 53, 0], [-42, 16, 46, 2],
  [-24, 24, 51, 1], [2, 18, 44, 0], [22, 22, 49, 0], [46, 18, 45, 1], [66, 20, 54, 2], [88, 22, 48, 0], [112, 16, 52, 1], [130, 22, 46, 0], [154, 20, 55, 2], [176, 18, 49, 1], [196, 24, 52, 0], [222, 18, 46, 2], [242, 22, 50, 1]] as const

export function drawCity(s: Site) {
  const { c, ink, cw, ch, zu, L, base, walk } = s
  const px = (css: number) => Math.round(css * s.dpr), one = Math.max(1, Math.round(s.dpr / 2))
  // A point `z` cells back: half as far left and a quarter as far up.
  const X = (x: number, z: number) => x - z * zu / 2, Y = (y: number, z: number) => y - z * zu / 4
  const fill = (tone: string, ...points: number[][]) => { c.fillStyle = tone; c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.fill() }
  const rect = (tone: string, x: number, y: number, w: number, h: number) => { c.fillStyle = tone; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)) }
  const stroke = (tone: string, width: number, ...points: number[][]) => { c.strokeStyle = tone; c.lineWidth = width; c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke() }
  // A box standing on height `y` (its bottom), `z` cells back: side, roof, front. Tones: [roof, side, front].
  const box = (x: number, y: number, w: number, h: number, z: number, d: number, tones: readonly string[]) => {
    const x0 = X(x, z), y0 = Y(y - h, z), x1 = X(x, z + d), y1 = Y(y - h, z + d)
    fill(tones[1], [x0, y0], [x1, y1], [x1, y1 + h], [x0, y0 + h])
    fill(tones[0], [x0, y0], [x0 + w, y0], [x1 + w, y1], [x1, y1])
    rect(tones[2], x0, y0, w, h)
  }
  // A flat roof inside its parapet: the rim keeps the roof's light tone, the deck sits a step darker.
  const deck = (x: number, y: number, w: number, z: number, d: number, tone: string, rim = .5) => {
    const a = rim * zu / 2, x0 = X(x + a, z + rim), y0 = Y(y, z + rim), x1 = X(x + a, z + d - rim), y1 = Y(y, z + d - rim), ww = w - 2 * a
    if (ww > 0 && d > 2 * rim) fill(tone, [x0, y0], [x0 + ww, y0], [x1 + ww, y1], [x1, y1])
  }
  // Panes on a side wall whose front edge is at x: `n` across its depth from `z0`, `rows` down from y.
  const sidePanes = (tone: string, x: number, y: number, z0: number, n: number, pz: number, rows: number, ph: number, gy: number) => {
    c.fillStyle = tone
    for (let r = 0; r < rows; r++) for (let q = 0; q < n; q++) {
      const za = z0 + (q + .26) * pz, zb = z0 + (q + .74) * pz, top = y + r * ph + gy, bottom = y + (r + 1) * ph - gy
      c.beginPath(); c.moveTo(X(x, za), Y(top, za)); c.lineTo(X(x, zb), Y(top, zb)); c.lineTo(X(x, zb), Y(bottom, zb)); c.lineTo(X(x, za), Y(bottom, za)); c.fill()
    }
  }
  // A circle lying flat at height y, as points.
  const circle = (cx: number, cz: number, r: number, y: number, from: number, to: number, n = 18) => Array.from({ length: n + 1 }, (_, i) => { const t = from + (to - from) * i / n, z = cz + r * Math.sin(t) / zu; return [X(cx + r * Math.cos(t), z), Y(y, z)] })
  const sky = -px(s.over), W = px(s.W), H = px(s.H)
  const width = s.cols * cw, plinth = s.band + s.ground, top = base - plinth - s.floors * ch, town = !s.phone

  // The sky. By night: stars in three tones, thinning out towards the street, a few of them sharp enough to show a
  // cross, and the moon as a clean crescent at tonight's phase (never thinner than a sliver, never past half, so it is
  // always a crescent). By day: the sun, flat, where the moon would be.
  const tip = mast(s), R = px(s.phone ? 12 : 17), mx = Math.round(s.phone ? Math.min(W - px(54), tip.x * s.dpr + W * .24) : Math.min(W - px(120), L + width + (W - L - width) * .52)), my = Math.round(s.phone ? Math.max(sky + px(96), tip.y * s.dpr - px(18)) : Math.max(px(84), H * .14))
  {
    const r = random(41), horizon = base - 26 * ch
    for (let i = 0; i < (s.phone ? 80 : 190); i++) {
      const x = Math.round(r() * W), y = Math.round(sky + r() ** 1.5 * (horizon - sky)), kind = r()
      if (Math.hypot(x - mx, y - my) < R * 1.6) continue
      if (kind > .965) { rect(ink['star-3'], x, y, one, one); c.fillStyle = ink['star-1']; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) c.fillRect(x + dx * one, y + dy * one, one, one) }
      else rect(kind > .82 ? ink['star-3'] : kind > .45 ? ink['star-2'] : ink['star-1'], x, y, one, one)
    }
    c.fillStyle = ink.sun; c.beginPath(); c.arc(mx, my, R * 1.25, 0, 2 * Math.PI); c.fill()
    let phase = s.moon; if (phase < .08 || phase > .92) phase = .08; if (phase > .38 && phase < .62) phase = .38
    const k = Math.cos(2 * Math.PI * phase)
    c.save(); c.translate(mx, my); if (phase > .5) c.scale(-1, 1); c.rotate(-.38)
    c.fillStyle = ink.moon; c.beginPath(); c.arc(0, 0, R, -Math.PI / 2, Math.PI / 2); c.ellipse(0, 0, Math.abs(k) * R, R, 0, Math.PI / 2, -Math.PI / 2, k > 0); c.fill()
    c.restore()
  }

  // How much of a building standing between x0 and x1 the page would show.
  const shows = (x0: number, x1: number) => Math.min(W, x1) - Math.max(0, x0)
  // The skyline far off: flat shapes one step off the sky, some stepped at the top, some under a mast.
  if (town) for (const [bx, bw, bh, kind] of SKYLINE) {
    const x = Math.round(L + bx * cw), w = bw * cw, y = base - bh * ch
    if (x > W || x + w < 0) continue
    rect(ink.skyline, x, y, w, base - y)
    if (kind === 1) rect(ink.skyline, x + Math.round(w * .22), y - 3 * ch, Math.round(w * .56), 3 * ch)
    if (kind === 2) { rect(ink.skyline, x + Math.round(w * .3), y - 2 * ch, Math.round(w * .4), 2 * ch); rect(ink.skyline, x + Math.round(w * .5), y - 9 * ch, one, 7 * ch) }
  }
  // The ground the city stands on. On a phone the tower fills the page and stands alone: there the ground only has to
  // reach round its back.
  rect(ink.ground, 0, Y(base, town ? BACK + 14 : s.depth + 1), W, base - Y(base, town ? BACK + 14 : s.depth + 1))

  // The row across the next street: plain volumes, one step nearer than the skyline, a room lit here and there, but
  // only where nothing nearer stands in front of any of it (half a window showing past a roof is a blemish).
  const gx = Math.max(1, Math.round(cw * .1)), gy = Math.max(1, Math.round(ch * .13))
  const nearer = [[X(L, s.depth), top - 14 * ch, L + width, base], ...[...LEFT.map(b => [b, L + b.x * cw] as const), ...RIGHT.map(b => [b, L + (s.cols + b.x) * cw] as const)].map(([b, x]) => [X(x, b.d) - cw, Y(base - b.h * ch, b.d) - 12 * ch, x + b.w * cw + cw, base])]
  if (town) for (const [bx, bw, bh, bd] of FAR) {
    const x = L + bx * cw, w = bw * cw, h = bh * ch
    if (shows(X(x, BACK + bd), X(x, BACK) + w) < px(40)) continue
    box(x, base, w, h, BACK, bd, [ink['far-top'], ink['far-side'], ink['far-front']])
    const r = random(bx * 7 + bh)
    for (let i = 0, n = 1 + Math.floor(r() * 2.4); i < n; i++) {
      const rx = X(x, BACK) + (1 + Math.floor(r() * (bw - 2))) * cw + gx, ry = Y(base - h, BACK) + (1 + Math.floor(r() * Math.min(bh - 3, 12))) * ch + gy
      if (rx > 0 && rx + cw < W && nearer.every(([x0, y0, x1, y1]) => rx + cw < x0 || rx > x1 || ry + ch < y0 || ry > y1)) rect(ink['far-lit'], rx, ry, cw - 2 * gx, ch - 2 * gy)
    }
  }

  // The lane on the tower's left, paved like the pavement it opens onto.
  const lane = L - LANE * cw
  if (town) fill(ink.walk, [lane, base], [L, base], [X(L, BACK), Y(base, BACK)], [X(lane, BACK), Y(base, BACK)])

  // A neighbour: its walls, large windows a small step off them (a few runs lit, each on a floor of its own), a darker
  // ground floor, and the roof it is known by. `right` buildings are placed from the tower's right-hand wall.
  const neighbour = (b: Block, right = false) => {
    const x = L + (right ? s.cols + b.x : b.x) * cw, w = b.w * cw, h = b.h * ch, roof = base - h
    if (shows(X(x, b.d), x + w) < px(40)) return
    const tones = [ink['n-top'], ink['n-side'], ink['n-front']], line = ink['n-line'], r = random(b.x * 31 + b.h)
    box(x, base, w, h, 0, b.d, tones)
    deck(x, roof, w, 0, b.d, ink['n-roof'])
    const ground = 3 * ch, pane = PANES[b.panes], pw = Math.round(pane.w * cw), ph = Math.round(pane.h * ch)
    const across = Math.floor((b.w - 2 - pane.w) / pane.px) + 1, down = Math.floor((b.h - 6 - pane.h) / pane.py) + 1
    const x0 = Math.round(x + (w - ((across - 1) * pane.px * cw + pw)) / 2), y0 = roof + Math.round(1.5 * ch)
    const at = (i: number, j: number) => [x0 + Math.round(i * pane.px * cw), y0 + Math.round(j * pane.py * ch)]
    c.fillStyle = ink['n-glass']
    for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) { const [wx, wy] = at(i, j); c.fillRect(wx, wy, pw, ph) }
    // Not every building is the same stone: some are a step or two darker.
    for (let i = 0; i < (b.shade ?? 0); i++) { rect(ink['n-shade'], x, roof, w, h); fill(ink['n-shade'], [x, roof], [X(x, b.d), Y(roof, b.d)], [X(x, b.d), Y(base, b.d)], [x, base]) }
    // Late rooms: two or three runs of neighbouring windows and a single one or two, never on neighbouring floors.
    const free = Array.from({ length: down }, (_, j) => j)
    c.fillStyle = ink.late
    for (let k = 0, runs = 2 + Math.floor(r() * 2), n = runs + 1 + Math.floor(r() * 2); k < n && free.length; k++) {
      const [j] = free.splice(Math.floor(r() * free.length), 1), near = free.indexOf(j + 1); if (near >= 0) free.splice(near, 1)
      const below = free.indexOf(j - 1); if (below >= 0) free.splice(below, 1)
      const long = k < runs ? Math.min(across, 2 + Math.floor(r() * (b.panes === 'square' ? 2.6 : 1.6))) : 1, from = Math.floor(r() * (across - long + 1))
      for (let i = from; i < from + long; i++) { const [wx, wy] = at(i, j); c.fillRect(wx, wy, pw, ph) }
    }
    rect(ink['n-base'], x, base - ground, w, ground); fill(ink['n-base'], [x, base - ground], [X(x, b.d), Y(base - ground, b.d)], [X(x, b.d), Y(base, b.d)], [x, base])
    rect(line, x, roof, w, one); rect(line, x, roof, one, h)
    // A plant room on most roofs, towards the back.
    const room = (rx: number, rw: number, high: number, z: number, deep: number) => { box(rx, roof, rw, high, z, deep, tones); rect(line, X(rx, z), Y(roof - high, z), rw, one) }
    // A long plant room and, beside it, the taller head of the lift shaft.
    if (b.roof === 'plant') { room(x + 1.5 * cw, 7 * cw, 2.2 * ch, b.d - 6, 4); room(x + w - 6.5 * cw, 3.5 * cw, 4.4 * ch, b.d * .5, 3) }
    if (b.roof === 'setback') {
      // The top floors again, three windows in from each side and three cells back.
      const inset = 3 * cw, high = 5 * ch, z = 3, d = b.d - 6, sx = x + inset, sw = w - 2 * inset, up = roof - high
      box(sx, roof, sw, high, z, d, tones); deck(sx, up, sw, z, d, ink['n-roof'])
      rect(line, X(sx, z), Y(up, z), sw, one); rect(line, X(sx, z), Y(up, z), one, high)
    }
    if (b.roof === 'cornice') {
      // The roof's slab a little proud of the walls all round, over a line of shadow.
      const proud = .5 * cw, thick = Math.round(ch * .9)
      room(x + 3 * cw, w - 9 * cw, 2.2 * ch, 3, b.d - 7)
      fill(tones[1], [x - proud, roof - thick], [X(x - proud, b.d), Y(roof - thick, b.d)], [X(x - proud, b.d), Y(roof, b.d)], [x - proud, roof])
      rect(tones[0], x - proud, roof - thick, w + 2 * proud, thick); rect(line, x - proud, roof - thick, w + 2 * proud, one); rect(ink['n-base'], x, roof, w, Math.max(one, Math.round(ch * .3)))
    }
    if (b.roof === 'stack') {
      // A chimney stack with its cap, beside the boiler house.
      const sw = 2.4 * cw, sh = 7 * ch, z = b.d * .5, sx = x + w - 5.5 * cw
      room(x + 1.5 * cw, 7 * cw, 2.6 * ch, b.d - 6.5, 4.5)
      box(sx, roof, sw, sh, z, 2.2, tones); rect(line, X(sx, z), Y(roof - sh, z), sw, one); rect(ink['n-base'], X(sx, z) - one, Y(roof - sh, z) + Math.round(ch * .8), sw + 2 * one, Math.max(one, Math.round(ch * .35)))
    }
    if (b.roof === 'spire') {
      // A lantern of three floors under an aerial with its yards.
      const inset = Math.round(b.w * .3) * cw, high = 3 * ch, z = b.d * .32, d = b.d * .36, sx = x + inset, sw = w - 2 * inset, up = roof - high
      box(sx, roof, sw, high, z, d, tones); rect(line, X(sx, z), Y(up, z), sw, one)
      const ax = Math.round(X(sx + sw / 2, z + d / 2)), ay = Y(up, z + d / 2), tall = 10 * ch
      rect(ink['metal-lit'], ax, ay - tall, one, tall); for (const [f, half] of [[.5, 1.3], [.68, 1], [.84, .7]]) rect(ink['metal-lit'], ax - Math.round(half * cw), ay - Math.round(tall * f), Math.round(2 * half * cw) + one, one)
    }
  }
  if (town) RIGHT.slice().reverse().forEach(b => neighbour(b, true))

  // The tower: its body, then each step of the crown on the roof of the one below it.
  const tones = [ink['t-top'], ink['t-side'], ink['t-front']], line = ink['t-line'], crown = s.tiers.reduce((n, tier) => n + tier.floors, 0)
  const storey = (inset: number, back: number, y0: number, y1: number) => {
    const x = L + inset * cw, w = width - 2 * inset * cw, depth = s.depth - 2 * back
    box(x, y1, w, y1 - y0, back, depth, tones)
    deck(x, y0, w, back, depth, ink['t-roof'], Math.min(.7, depth * .2))
    // Windows down the side, floor for floor with the front, and a lit edge where roof meets wall.
    sidePanes(ink['t-side-glass'], x, y0, back + .5, Math.floor((depth - 1) / 1.25), 1.25, Math.round((Math.min(y1, base - plinth) - y0) / ch), ch, Math.max(one, Math.round(ch * .2)))
    rect(line, X(x, back), Y(y0, back), w, one); rect(line, X(x, back), Y(y0, back), one, y1 - y0)
  }
  storey(0, 0, top + crown * ch, base)
  for (let i = s.tiers.length - 1, y = top + crown * ch; i >= 0; i--) { const tier = s.tiers[i]; storey(tier.inset, tier.back, y - tier.floors * ch, y); y -= tier.floors * ch }
  // Under the windows the wall is stone: a frieze, then the ground floor, each under a line cut one step into it that
  // runs round the corner.
  {
    const side = (y: number, h: number, tone: string) => fill(tone, [L, y], [X(L, s.depth), Y(y, s.depth)], [X(L, s.depth), Y(y + h, s.depth)], [L, y + h])
    const course = Math.max(2 * one, Math.round(ch * .5)), foot = Math.max(3 * one, Math.round(ch * .7))
    side(base - plinth, plinth, ink['t-plinth-side']); rect(ink['t-plinth'], L, base - plinth, width, plinth)
    for (const y of [base - plinth, base - s.ground]) {
      rect(ink['t-reveal'], L, y, width, course); side(y, course, ink['t-reveal'])
      rect(ink['p-line'], L, y, width, one); stroke(ink['p-line'], one, [L, y + one / 2], [X(L, s.depth), Y(y, s.depth) + one / 2])
    }
    rect(ink['t-joint'], L, base - foot, width, one); stroke(ink['t-joint'], one, [L, base - foot + one / 2], [X(L, s.depth), Y(base - foot, s.depth) + one / 2])
    rect(ink['p-line'], L, base - plinth, one, plinth)
  }
  {
    // On the top roof: a plant room with its door and louvres, three cooling units, and the mast with its stays; on a
    // narrow roof the units go.
    const inset = s.tiers[0]?.inset ?? 0, back = s.tiers[0]?.back ?? 0, x = L + inset * cw, w = width - 2 * inset * cw, depth = s.depth - 2 * back, across = s.cols - 2 * inset
    if (depth >= 4) {
      const room = { x: x + 2 * cw, z: back + depth * .45, w: Math.min(8, across * .24) * cw, h: Math.round(2.6 * ch), d: depth * .4 }
      box(room.x, top, room.w, room.h, room.z, room.d, tones); rect(line, X(room.x, room.z), Y(top - room.h, room.z), room.w, one)
      rect(ink['t-reveal'], X(room.x, room.z) + Math.round(room.w * .64), Y(top, room.z) - Math.round(room.h * .68), Math.round(cw * 1.3), Math.round(room.h * .68))
      for (let i = 1; i <= 3; i++) rect(ink['t-reveal'], X(room.x, room.z) + Math.round(cw * .8), Y(top, room.z) - Math.round(room.h * (.22 + i * .15)), Math.round(room.w * .36), one)
      if (across >= 34) for (let i = 0; i < 3; i++) { const ux = x + 13.5 * cw + i * 3.3 * cw, z = back + 1.5; box(ux, top, 2.5 * cw, ch, z, 2.2, tones); stroke(line, one, ...circle(ux + 1.25 * cw, z + 1.1, cw * .75, top - ch, 0, 2 * Math.PI, 14)) }
    }
    const tx = Math.round(tip.x * s.dpr), tall = Math.round(tip.y * s.dpr), foot = Math.round(Y(top, back + depth / 2))
    for (const [sx, sz] of [[x + 1.5 * cw, back + depth * .12], [x + w - 1.5 * cw, back + depth * .12], [x + w * .5, back + depth * .9]]) stroke(ink.metal, one, [tx, foot - (foot - tall) * .6], [X(sx, sz), Y(top, sz)])
    rect(ink['metal-lit'], tx - one, tall, 2 * one, foot - tall)
    for (const [f, half] of [[.26, .9], [.44, .6]]) rect(ink['metal-lit'], tx - Math.round(cw * half), tall + Math.round((foot - tall) * f), Math.round(2 * cw * half), one)
  }

  // The rest of the street, from the tower outwards: each building stands in front of the last one's side wall.
  if (town) LEFT.forEach(b => neighbour(b))

  // The pavement: one tone to the bottom of the page. The door's light is the only light on it.
  rect(ink.walk, 0, base, W, H - base)
  // A pillar box: a domed cap over a collar, the slot, the plate with the collection times, a darker side, its plinth.
  const pillar = (x: number, y: number) => {
    const w = Math.max(8 * one, Math.round(cw * 1.7)), h = Math.round(ch * 4), collar = Math.max(2 * one, Math.round(h * .09)), foot = Math.max(2 * one, Math.round(h * .08)), side = Math.max(2 * one, Math.round(w * .24))
    c.fillStyle = ink['brand-lit']; c.beginPath(); c.ellipse(x + w / 2, y - h, w / 2 + one, Math.round(w * .34), 0, Math.PI, 2 * Math.PI); c.fill()
    rect(ink.brand, x, y - h, w, h); rect(ink['brand-deep'], x, y - h, side, h)
    rect(ink['brand-lit'], x - one, y - h, w + 2 * one, collar); rect(ink['brand-dark'], x + side + one, y - h + collar + Math.round(h * .12), w - side - 3 * one, Math.max(one, Math.round(h * .06)))
    rect(ink.paper, x + side + one, y - h + collar + Math.round(h * .3), Math.round((w - side) * .5), Math.round(h * .16)); rect(ink['brand-dark'], x - one, y - foot, w + 2 * one, foot)
  }
  // It stands where the lane meets the pavement; on a phone, on the pavement left of the door.
  pillar(Math.round(town ? L - 4 * cw : s.door.x - 5.5 * cw), base + Math.round(walk * .2))
}

/** The tip of the mast in CSS pixels of the scene: where the beacon blinks and the stray letter hangs. */
export function mast(s: Pick<Site, 'L' | 'base' | 'band' | 'ground' | 'floors' | 'cols' | 'cw' | 'ch' | 'zu' | 'tiers' | 'depth' | 'dpr' | 'phone'>) {
  const back = s.tiers[0]?.back ?? 0, z = back + (s.depth - 2 * back) / 2, top = s.base - s.band - s.ground - s.floors * s.ch
  return { x: (s.L + s.cols * s.cw / 2 - z * s.zu / 2) / s.dpr, y: (top - z * s.zu / 4) / s.dpr - (s.phone ? 50 : 46) }
}
