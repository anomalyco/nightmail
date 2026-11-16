// The machine before its engine has loaded: its cabinet, the sorting frame and the price in it, the works' bay and its
// roller line, the hopper and chimneys, the manifolds, tubes and headers, drawn flat on a 2D canvas in the same places
// and tones the renderer will use (machine.ts is the measure of every number here). It is on the page from the first
// paint; the renderer's first frame is laid over it and comes up through it.
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
import { glass, tone, type Mat } from './tones'

export function drawStill(canvas: HTMLCanvasElement, p: Plan, over: number, dark: boolean) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), c = canvas.getContext('2d')!
  canvas.width = Math.round(p.W * dpr); canvas.height = Math.round((p.H + over) * dpr)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  const X = (x: number, z = 0) => p.ox + x + DX * z, Y = (y: number, z = 0) => p.oy + over - y - DY * z
  const fill = (mat: Mat, t: 0 | 1 | 2 | 3) => { c.fillStyle = tone(mat, t, dark) }
  const face = (points: [number, number, number][]) => { c.beginPath(); points.forEach(([x, y, z], i) => i ? c.lineTo(X(x, z), Y(y, z)) : c.moveTo(X(x, z), Y(y, z))); c.fill() }
  const front = (x0: number, y0: number, x1: number, y1: number) => c.fillRect(X(x0), Y(y1), x1 - x0, y1 - y0)
  const { Xc, Xw, D, U, V, yTop, yWall, yMan, ySlot, yCav, yFas } = p
  // The slab: its top, its lip.
  fill('slab', 0); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, 0, p.zBack], [-p.slabX, 0, p.zBack]])
  fill('slab', 1); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, -p.lip, p.zLip], [-p.slabX, -p.lip, p.zLip]])
  fill('body', 3); face([[-Xc, 0, 0], [-Xc, 0, D], [-Xc, yTop, D], [-Xc, yTop, 0]])
  fill('body', 0); face([[-Xc, yTop, 0], [Xc, yTop, 0], [Xc, yTop, D], [-Xc, yTop, D]])
  fill('body', 1); front(-Xc, yWall, Xc, yTop)
  fill('plinth', 1); front(-Xc, 0, Xc, yWall)
  fill('wall', 1); front(-Xw, yWall, Xw, yMan)
  fill('trim', 1); front(-Xc, yMan, Xc, ySlot)
  fill('dark', 1); front(-Xw, yCav, Xw, yFas)
  fill('body', 1); front(p.cta.x - p.plate, p.cta.y - p.plate, p.cta.x + p.cta.w + p.plate, p.cta.y + p.cta.h + p.plate)
  fill('slot', 1); front(p.cta.x, p.cta.y, p.cta.x + p.cta.w, p.cta.y + p.cta.h)
  fill('screen', 1); for (const w of p.facts) front(w.x, w.y, w.x + w.w, w.y + w.h)
  fill('screen', 1); front(p.readout.x, p.readout.y, p.readout.x + p.readout.w, p.readout.y + p.readout.h)
  // The tubes' channels down the front, and the gauge's face.
  fill('dark', 1); for (const x of p.tubes) front(x - p.tubeR - U / 9, p.phone ? 1.5 * V : yWall + 1.7 * V, x + p.tubeR + U / 9, yMan)
  fill('trim', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r + 2.5 * U / 9, 0, Math.PI * 2); c.fill()
  fill('dial', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r, 0, Math.PI * 2); c.fill()
  // A box as the page sees one: its left side, its top, its front.
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Mat) => {
    fill(mat, 3); face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]])
    fill(mat, 0); face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]])
    fill(mat, 1); face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]])
  }
  const px = U / 9, r = p.tubeR, zt = p.zt, lower = p.phone ? 0 : 1.7 * V, yLow = lower ? yWall + lower : r + px, zBlock = p.zProud, lean = DX * zBlock, zL = p.zL
  // On the roof: two chimneys, a laser's pedestal and barrel at each end, a slot each side of the hopper, the
  // hopper's back and front plates.
  for (const [x, z] of [[-Xw * .84, D * .7], [Xw * .88, D * .66]]) { box(x - 4.5 * px, yTop, z, x + 4.5 * px, yTop + 11 * px, z + .1, 'steel'); box(x - 6 * px, yTop + 11 * px, z - 4 * px, x + 6 * px, yTop + 13 * px, z + 4 * px, 'trim') }
  for (const s of [-1, 1]) {
    const tx = s * (p.phone ? Xc - 2.4 * U : Xc + 1.15 * U), tz = -5 * px, up = .5, a = s > 0 ? up : Math.PI - up, in0 = s * (p.phone ? Xc - 4.2 * U : Xc - 1.6 * U), out0 = tx + s * 1.05 * U
    box(Math.min(in0, out0), yTop + 2 * px, tz - 6 * px, Math.max(in0, out0), yTop + 4.4 * px, 7 * px, 'trim')
    box(tx - 3.2 * px, yTop + 4.4 * px, tz, tx + 3.2 * px, yTop + 16 * px, tz + .1, 'steel')
    c.save(); c.translate(X(tx, tz), Y(yTop + 16 * px, tz)); c.rotate(-a); fill('plinth', 1); c.fillRect(-8 * px, -4.4 * px, 25 * px, 8.8 * px); fill('trim', 1); for (let i = 0; i < 4; i++) c.fillRect((-5 + i * 4.4) * px, -6.2 * px, 1.8 * px, 12.4 * px); c.restore()
    box(s * Xw * .6 - .62 * p.lw, yTop, zL - 6 * px, s * Xw * .6 + .62 * p.lw, yTop + 5 * px, zL + 6 * px, 'steel')
  }
  const hh = p.hopper * .82, ht = p.lw * 1.3, hb = p.lw * .62, hd = p.lw * .36
  fill('trim', 3); face([[-hb, yTop, zL + hd], [hb, yTop, zL + hd], [ht, yTop + hh, zL + hd], [-ht, yTop + hh, zL + hd]])
  fill('steel', 1); face([[-hb, yTop, zL - hd], [hb, yTop, zL - hd], [hb + (ht - hb) * .62, yTop + hh * .62, zL - hd], [-hb - (ht - hb) * .62, yTop + hh * .62, zL - hd]])
  // In the bay: its floor, each lane's chute, the roller line (fifty-six rollers, seen end on and from above).
  const yR = yCav + p.cavity * .4, rr = p.P / 8 * .4, z0 = zL - 12 * px, z1 = zL + 12 * px
  c.save(); c.beginPath(); c.rect(X(-Xw), Y(yFas), 2 * Xw, yFas - yCav); c.clip()
  fill('bay', 0); face([[-Xw, yCav, 0], [Xw, yCav, 0], [Xw, yCav, p.cavD], [-Xw, yCav, p.cavD]])
  fill('bay', 3); face([[Xw, yCav, 0], [Xw, yCav, p.cavD], [Xw, yFas, p.cavD], [Xw, yFas, 0]])
  fill('trim', 1); for (const x of p.lanes) for (const s of [-1, 1]) face([[x + s * .48 * p.P, yR - rr - 3 * px, z0], [x + s * .48 * p.P - s * 1.6 * px, yR - rr - 3 * px, z0], [x + s * .4 * p.P - s * 1.6 * px, yCav, z0], [x + s * .4 * p.P, yCav, z0]])
  for (let j = 0; j < 56; j++) { const x = p.lanes[0] - p.P / 2 + (j + .5) * p.P / 8; fill('steel', 0); face([[x - rr, yR + rr * .3, z0], [x + rr, yR + rr * .3, z0], [x + rr, yR + rr * .3, z1], [x - rr, yR + rr * .3, z1]]); fill('steel', 1); c.beginPath(); c.arc(X(x, z0), Y(yR, z0), rr, 0, Math.PI * 2); c.fill() }
  c.restore()
  // On the fascia: three lamps, the gauge's ticks, red zone and needle. Under the bay: the lanes' plates.
  fill('lampOff', 1); for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(X(p.gauge.x - p.gauge.r - (2 + 1.7 * i) * U), Y(p.gauge.y), Math.min(4 * px, p.fascia * .1), 0, Math.PI * 2); c.fill() }
  const gx = X(p.gauge.x), gy = Y(p.gauge.y), gr = p.gauge.r
  for (let i = 0; i <= 10; i++) { const a = (225 - 27 * i) * Math.PI / 180; c.strokeStyle = tone(i >= 8 ? 'redzone' : 'ink', 1, dark); c.lineWidth = (i % 5 ? .9 : 1.4) * px; c.beginPath(); c.moveTo(gx + Math.cos(a) * gr * (i % 5 ? .78 : .68), gy - Math.sin(a) * gr * (i % 5 ? .78 : .68)); c.lineTo(gx + Math.cos(a) * gr * .9, gy - Math.sin(a) * gr * .9); c.stroke() }
  c.strokeStyle = tone('redzone', 1, dark); c.lineWidth = gr * .09; c.beginPath(); c.arc(gx, gy, gr * .945, -(225 - 216) * Math.PI / 180, -(225 - 270) * Math.PI / 180); c.stroke()
  c.strokeStyle = tone('ink', 1, dark); c.lineWidth = 1.6 * px; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + Math.cos(135 * Math.PI / 180) * gr * .8, gy - Math.sin(135 * Math.PI / 180) * gr * .8); c.stroke()
  fill('steel', 1); c.beginPath(); c.arc(gx, gy, 2.2 * px, 0, Math.PI * 2); c.fill()
  fill('plinth', 1); for (const x of p.lanes) front(x - .46 * p.P, ySlot + .14 * p.slot, x + .46 * p.P, ySlot + .86 * p.slot)
  // The relief valves on the columns beside the bay.
  const vs = p.phone ? .58 * U : U, colX = (Xw + 2 * px + Xc - p.post) / 2, valveY = yCav + p.cavity * .62
  for (const s of [-1, 1]) { fill('steel', 1); front(s * colX - .3 * vs, ySlot, s * colX + .3 * vs, valveY + 1.9 * vs); fill('trim', 1); c.beginPath(); c.arc(X(s * colX), Y(valveY), 1.15 * vs, 0, Math.PI * 2); c.fill(); fill('steel', 1); c.beginPath(); c.arc(X(s * colX, -3 * px), Y(valveY, -3 * px), .8 * vs, 0, Math.PI * 2); c.fill() }
  // The tubes between their manifolds, the blocks they go into, the brackets across them; on a wide page the lower
  // block goes on round the corner, and a riser comes down from it to the header on the slab.
  const ends = (s: number, round: boolean) => [s < 0 ? (round ? -Xc - p.riser - .2 * U : -Xc + p.post + .1 * U) : Xw + .12 * U, s < 0 ? -Xw - .12 * U - lean : round ? Xc + p.riser + .2 * U : Xc - p.post - .1 * U - lean]
  const yc = r + 3.5 * px
  for (const head of p.heads) box(head.x0, 0, head.z0, head.x1, head.h, head.z1, 'trim')
  for (const s of p.heads.length ? [-1, 1] : []) { const x0 = s < 0 ? -Xc - p.riser - .2 * U : Xc + .2 * U; box(x0, p.heads[0].h, zBlock, x0 + p.riser, yWall + lower, zBlock + 3 * U, 'trim') }
  box(-Xc - px, yMan, -5 * px, Xc + px, ySlot, 0, 'trim')
  if (lower) box(-Xc - px, yWall - .3 * V, -5 * px, Xc + px, yWall + lower, 0, 'trim')
  for (const s of [-1, 1]) { const [a, e] = ends(s, false); box(a, yMan, zBlock, e, ySlot, 0, 'trim') }
  for (const x of p.tubes) { c.fillStyle = glass(1, dark); c.fillRect(X(x - r, zt), Y(yMan, zt), 2 * r, yMan - yLow); c.fillStyle = glass(2, dark); c.fillRect(X(x - r, zt), Y(yMan, zt), r * .5, yMan - yLow) }
  if (lower) {
    const reach = r + 1.5 * px, zB = zt - r - 1.2 * px, ahead = DX * (zB - zt)
    for (const first of [0, 4]) { const a = Math.min(p.tubes[first], p.tubes[first + 3]) - reach - ahead, e = Math.max(p.tubes[first], p.tubes[first + 3]) + reach - ahead; for (let i = 1; i <= 3; i++) { const y = yLow + (yMan - yLow) * i / 4; box(a, y - 1.5 * px, zB, e, y + 1.5 * px, 0, 'trim') } }
    for (const s of [-1, 1]) { const [a, e] = ends(s, true); box(a, yWall - .3 * V, zBlock, e, yWall + lower, 0, 'trim') }
  }
  // On the slab: each tube forward from its outlet in the header, over the lip and down.
  // (A tube's line as it is seen: forward along the slab, round over the lip, and down.)
  const leg = (x: number, zFrom: number) => { c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r; c.lineCap = 'butt'; c.beginPath(); c.moveTo(X(x, zFrom), Y(yc, zFrom)); c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, p.zOver), Y(yc, p.zOver) + 200, r * 2.6); c.lineTo(X(x, p.zOver), Y(-p.floor - over, 0)); c.stroke() }
  // The sleeper under each four, each tube's flange in the trunk, and the collar where it turns down over the lip.
  const sleeperZ = p.fan.length ? (p.heads[0].z0 + p.zLip) / 2 - .6 * U : (zt + p.zLip) / 2
  p.heads.forEach((_, side) => { const xs = [0, 1, 2, 3].map(k => p.fan[side * 4 + k].x); box(Math.min(...xs) - 1.9 * U, 0, sleeperZ - .8 * U, Math.max(...xs) + 1.9 * U, yc - r, sleeperZ + .8 * U, 'plinth') })
  const lipCollar = (x: number) => { const w = r + 1.2 * px; fill('steel', 1); c.fillRect(X(x - w, p.zOver), Y(-p.lip * .5 + 1.4 * px, p.zOver), 2 * w, 2.8 * px); fill('steel', 0); c.beginPath(); c.ellipse(X(x, p.zOver), Y(-p.lip * .5 + 1.4 * px, p.zOver), w, w * .42, 0, 0, Math.PI * 2); c.fill() }
  p.fan.forEach(at => { leg(at.x, zBlock); fill('steel', 1); c.beginPath(); c.arc(X(at.x, zBlock), Y(yc, zBlock), r + 2 * px, 0, Math.PI * 2); c.fill(); lipCollar(at.x) })
  // The outbound tube: up over the lip, along the cabinet's front and into the plate at the riser's foot (a phone:
  // into the plate in the base). The tally by the last outlet.
  { const x = p.out - DX * p.zOver, trunk = p.heads[1], w = r + 3.4 * px, zJ = p.zLip * .46, portX = Xc + .2 * U + p.riser / 2, into = trunk ? trunk.z0 : -3 * px, px0 = trunk ? portX : x
    fill('steel', 1); c.fillRect(X(px0 - w, into), Y(yc + w, into), 2 * w, yc + w)
    c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r; c.beginPath(); c.moveTo(X(x, p.zOver), Y(-p.floor - over, 0))
    if (trunk) { c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, zJ), Y(yc, zJ), r * 2.4); c.arcTo(X(x, zJ), Y(yc, zJ), X(portX, zJ), Y(yc, zJ), r * 2.2); c.arcTo(X(portX, zJ), Y(yc, zJ), X(portX, into), Y(yc, into), r * 2.2) } else c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, into), Y(yc, into), r * 2.6)
    c.lineTo(X(px0, into), Y(yc, into)); c.stroke(); lipCollar(x) }
  if (p.tally) { fill('screen', 1); c.fillRect(X(p.tally.x, p.tally.z), Y(p.tally.y + p.tally.h, p.tally.z), p.tally.w, p.tally.h) }
  // The send cannon: the tube from the trunk into its chest, the chest, the glass feed up into the breech, its barrel
  // at its elevation, the cheek in front of it.
  { const C = p.cannon, cu = C.cs, cheek = C.r + 2.2 * px, ce = Math.cos(C.el), se = Math.sin(C.el), kx = C.x - (C.back + 1.6 * cu) * ce, ky = C.y + C.pivot - (C.back + 1.6 * cu) * se, top = C.y + C.chest, chestZ = C.z - cheek - 1.1 * cu, zc = C.z - cheek - 2.4 * px, trunk = p.heads[1]
    c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r
    if (trunk) { const from = trunk.z1 + (trunk.h - yc - r) / DY; c.beginPath(); c.moveTo(X(kx, from), Y(yc, from)); c.lineTo(X(kx, chestZ), Y(yc, chestZ)); c.stroke() }
    box(kx - 1.7 * cu, C.y, chestZ, C.x + 3.4 * cu, top, C.z + cheek + 1.1 * cu, 'plinth')
    if (trunk) { fill('steel', 1); c.beginPath(); c.arc(X(kx, chestZ), Y(yc, chestZ), r + 2 * px, 0, Math.PI * 2); c.fill() }
    c.beginPath(); c.moveTo(X(kx, C.z), Y(top, C.z)); c.arcTo(X(kx, C.z), Y(ky, C.z), X(C.x - C.back * ce, C.z), Y(C.y + C.pivot - C.back * se, C.z), r * 1.5); c.lineTo(X(C.x - C.back * ce, C.z), Y(C.y + C.pivot - C.back * se, C.z)); c.stroke()
    c.save(); c.translate(X(C.x, C.z), Y(C.y + C.pivot, C.z)); c.rotate(-C.el)
    fill('trim', 1); c.fillRect(-C.back, -C.r, C.back + C.fore, 2 * C.r); fill('trim', 0); c.fillRect(-C.back, -C.r, C.back + C.fore, C.r * .5); fill('trim', 3); c.fillRect(-C.back, C.r * .5, C.back + C.fore, C.r * .5)
    fill('steel', 1); c.fillRect(C.fore - 4.4 * px, -C.r - 2.4 * px, 4.4 * px, 2 * C.r + 4.8 * px); c.fillRect(-C.back - 1.6 * px, -C.r - 3 * px, 3 * px, 2 * C.r + 6 * px); fill('plinth', 1); c.fillRect(-.75 * cu, -C.r - 3.4 * px, 1.5 * cu, 2 * C.r + 6.8 * px); fill('steel', 1); c.fillRect(-.24 * cu, -C.r - 4.4 * px, .48 * cu, 2 * C.r + 8.8 * px)
    c.restore()
    fill('trim', 1); face([[C.x - 2.5 * cu, top, zc], [C.x + 2.9 * cu, top, zc], [C.x + .95 * cu, C.y + C.pivot + .95 * cu, zc], [C.x - .95 * cu, C.y + C.pivot + .95 * cu, zc]]) }
  const g = U * .085, rows = PRICE.length + p.over + p.under
  for (let r = 0; r < rows; r++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const lit = PRICE[r - p.over]?.[col - p.side] === '#'
    if (lit) fill('paper', 1); else fill((col * 7 + r * 13) % 5 === 0 ? 'cell2' : 'cell', 1)
    c.fillRect(X(-Xw + col * U + g), Y(yWall + (rows - r) * V - g), U - 2 * g, V - 2 * g)
  }
}
