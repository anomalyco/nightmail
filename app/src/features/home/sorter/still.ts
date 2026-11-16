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
  fill('slot', 1); front(p.cta.x, p.cta.y, p.cta.x + p.cta.w, p.cta.y + p.cta.h)
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
  const px = U / 9, r = p.tubeR, zt = p.zt, lower = p.phone ? 0 : 1.7 * V, yLow = lower ? yWall + lower : r + px, zBlock = zt - r - 2 * px, pitch = Math.abs(p.tubes[1] - p.tubes[0])
  // On the roof: two chimneys, the hopper's back and front plates.
  for (const [x, z] of [[-Xw * .84, D * .7], [Xw * .88, D * .66]]) { box(x - 4.5 * px, yTop, z, x + 4.5 * px, yTop + 11 * px, z + .1, 'steel'); box(x - 6 * px, yTop + 11 * px, z - 4 * px, x + 6 * px, yTop + 13 * px, z + 4 * px, 'trim') }
  const hh = p.hopper * .82, ht = p.lw * 1.3, hb = p.lw * .62, hd = p.lw * .36
  fill('steel', 1); face([[-hb, yTop, p.zL + hd], [hb, yTop, p.zL + hd], [ht, yTop + hh, p.zL + hd], [-ht, yTop + hh, p.zL + hd]])
  fill('steel', 1); face([[-hb, yTop, p.zL - hd], [hb, yTop, p.zL - hd], [hb + (ht - hb) * .62, yTop + hh * .62, p.zL - hd], [-hb - (ht - hb) * .62, yTop + hh * .62, p.zL - hd]])
  // In the bay: its floor and the roller line. On the fascia: the vent's place is left to the renderer; three lamps.
  const yR = yCav + p.cavity * .4, rr = p.P / 8 * .4
  c.save(); c.beginPath(); c.rect(X(-Xw), Y(yFas), 2 * Xw, yFas - yCav); c.clip()
  fill('bay', 0); face([[-Xw, yCav, 0], [Xw, yCav, 0], [Xw, yCav, p.cavD], [-Xw, yCav, p.cavD]])
  fill('bay', 3); face([[Xw, yCav, 0], [Xw, yCav, p.cavD], [Xw, yFas, p.cavD], [Xw, yFas, 0]])
  fill('steel', 3); face([[-Xw, yR - rr, p.zL - 12 * px], [Xw, yR - rr, p.zL - 12 * px], [Xw, yR + rr, p.zL - 12 * px], [-Xw, yR + rr, p.zL - 12 * px]])
  fill('steel', 1); face([[-Xw, yR + rr * .2, p.zL - 12 * px], [Xw, yR + rr * .2, p.zL - 12 * px], [Xw, yR + rr, p.zL + 12 * px], [-Xw, yR + rr, p.zL + 12 * px]])
  c.restore()
  fill('lampOff', 1); for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(X(p.gauge.x - p.gauge.r - (2 + 1.7 * i) * U), Y(p.gauge.y), Math.min(4 * px, p.fascia * .1), 0, Math.PI * 2); c.fill() }
  fill('plinth', 1); for (const x of p.lanes) front(x - .46 * p.P, ySlot + .14 * p.slot, x + .46 * p.P, ySlot + .86 * p.slot)
  // The tubes between their manifolds, the blocks they go into, the brackets across them.
  for (const [y0, y1] of [[yMan, ySlot], ...(lower ? [[yWall - .3 * V, yWall + lower]] : [])]) {
    box(-Xc - px, y0, -5 * px, Xc + px, y1, 0, 'trim')
    for (const s of [-1, 1]) { const a = s * (Xw + .12 * U), e = s * (Xc - p.post - .1 * U); if (y0 === yMan) box(Math.min(a, e), y0, zBlock, Math.max(a, e), y1, 0, 'trim') }
  }
  for (const x of p.tubes) { c.fillStyle = glass(1, dark); c.fillRect(X(x - r, zt), Y(yMan, zt), 2 * r, yMan - yLow); c.fillStyle = glass(2, dark); c.fillRect(X(x - r, zt), Y(yMan, zt), r * .4, yMan - yLow) }
  if (lower) {
    for (const first of [0, 4]) { const a = Math.min(p.tubes[first], p.tubes[first + 3]) - pitch / 2, e = Math.max(p.tubes[first], p.tubes[first + 3]) + pitch / 2; for (let i = 1; i <= 3; i++) { const y = yLow + (yMan - yLow) * i / 4; box(a, y - 1.5 * px, zt - r - 1.2 * px, e, y + 1.5 * px, 0, 'trim') } }
    for (const s of [-1, 1]) { const a = s * (Xw + .12 * U), e = s * (Xc - p.post - .1 * U); box(Math.min(a, e), yWall - .3 * V, zBlock, Math.max(a, e), yWall + lower, 0, 'trim') }
  }
  // On the slab: the headers, and each tube forward from its outlet, over the lip and down.
  const yc = r + 2 * px
  for (const head of p.heads) box(head.x0, 0, head.z0, head.x1, head.h, head.z1, 'trim')
  c.fillStyle = glass(1, dark)
  p.fan.forEach(leg => { face([[leg.x - r, yc, p.heads[0].z0], [leg.x + r, yc, p.heads[0].z0], [leg.x + r, yc, p.zOver], [leg.x - r, yc, p.zOver]]); c.fillRect(X(leg.x - r, p.zOver), Y(yc, p.zOver), 2 * r, p.floor + over) })
  const g = U * .085, rows = PRICE.length + p.over + p.under
  for (let r = 0; r < rows; r++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const lit = PRICE[r - p.over]?.[col - p.side] === '#'
    if (lit) fill('paper', 1); else fill((col * 7 + r * 13) % 5 === 0 ? 'cell2' : 'cell', 1)
    c.fillRect(X(-Xw + col * U + g), Y(yWall + (rows - r) * V - g), U - 2 * g, V - 2 * g)
  }
}
