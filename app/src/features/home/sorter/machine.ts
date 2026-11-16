// The sorting machine, built once from the plan as solids. It stands on a slab with a lip along its front. Its cabinet's
// front is, from the floor up: the base (the page's button stands in it), the band with the sentence, the sorting frame
// whose thousand filled pigeonholes spell the price between two manifolds and eight glass tubes, the label rail, the
// works behind glass (a line of rollers with a drop gate and a chute for each lane, a scanner over the middle) and a
// fascia with the readout and the pressure gauge. On the roof: the hopper letters fall into, a laser on a pedestal,
// the slot scams are thrown out of, two chimneys, a hatch and a beacon. The tubes leave the cabinet at the floor,
// cross the slab and go over its lip. Everything that moves or can be blown off is a part.
import { ALL, Builder, type V3 } from './mesh'
import { MAT as M } from './tones'
import { COLS, PRICE } from './price'
import { DX, type Plan } from './plan'
import { LETTER_FLOATS } from './gl'

export type Machine = ReturnType<typeof buildMachine>

const ccw = (points: [number, number][]) => { let area = 0; points.forEach((a, i) => { const b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1] }); return area < 0 ? points.slice().reverse() : points }

export function buildMachine(p: Plan) {
  const b = new Builder()
  const { U, V, Xw, Xc, D, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, zL, cavD, tubeR, zt } = p
  const px = U / 9, wallRows = PRICE.length + p.over + p.under, r = tubeR

  // The slab: its top, its lip, the end that is seen.
  b.box(-p.slabX, -p.lip, p.zLip, p.slabX, 0, p.zBack, M.slab)
  b.box(-p.slabX, -1.2 * px, p.zLip - .1, p.slabX, 0, p.zLip, M.trim, 'f')

  // The cabinet: its roof and side, then its front floor by floor; a lit edge down its near corner.
  b.box(-Xc, 0, 0, Xc, yTop, D, M.body, 'tl')
  b.box(-Xc - 2 * px, 0, -3 * px, Xc + 2 * px, 1.5 * V, D + 2 * px, M.plinth)
  b.mark(-Xc, 1.5 * V, Xc, yWall, 0, M.plinth)
  b.box(-Xc, yBand - px, -1.5 * px, Xc, yBand + px, 0, M.trim)
  b.mark(-Xc, 1.5 * V, -Xc + 1.2 * px, yTop, -.12, M.trim); b.mark(Xc - 1.2 * px, 1.5 * V, Xc, yTop, -.12, M.line)
  // The button's bay in the base: a frame proud of the wall, dark inside until the page's button paints over it.
  const c = p.cta, f = 2.5 * px
  b.mark(c.x, c.y, c.x + c.w, c.y + c.h, -.3, M.slot)
  b.box(c.x - f, c.y + c.h, -2 * px, c.x + c.w + f, c.y + c.h + f, 0, M.trim); b.box(c.x - f, c.y - f, -2 * px, c.x + c.w + f, c.y, 0, M.trim)
  b.box(c.x - f, c.y, -2 * px, c.x, c.y + c.h, 0, M.trim); b.box(c.x + c.w, c.y, -2 * px, c.x + c.w + f, c.y + c.h, 0, M.trim)

  // The sorting frame: every pigeonhole, the empty ones a step off the wall; the thousand full ones are letters.
  b.mark(-Xw, yWall, Xw, yMan, 0, M.wall); b.mark(-Xc, yWall, -Xw, yMan, 0, M.body); b.mark(Xw, yWall, Xc, yMan, 0, M.body)
  const wall = new Float32Array(1000 * LETTER_FLOATS), g = U * .085
  let lit = 0
  for (let row = 0; row < wallRows; row++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const x = -Xw + col * U, y = yWall + (wallRows - 1 - row) * V
    if (PRICE[row - p.over]?.[col - p.side] === '#') wall.set([x + U / 2, y + V / 2, -.5, 0, 0, 0, 1, U - 2 * g, V - 2 * g, .4, (lit * .6180339887) % 1, 0, 2, 0], lit++ * LETTER_FLOATS)
    else b.mark(x + g, y + g, x + U - g, y + V - g, -.2, (col * 7 + row * 13) % 5 === 0 ? M.cell2 : M.cell)
  }

  // Two manifolds, bolted on, with the tubes between them; the label rail; the fascia.
  const lower = phone(p) ? 0 : 1.7 * V
  for (const [y0, y1] of [[yMan, yMan + p.manifold], ...(lower ? [[yWall - .3 * V, yWall + lower]] : [])]) {
    b.box(-Xc - px, y0, -5 * px, Xc + px, y1, 0, M.trim)
    for (let x = -Xc + 1.5 * U; x < Xc; x += 3 * U) b.cyl([x, (y0 + y1) / 2, 0], 2, -6.2 * px, -5 * px, 1.25 * px, M.steel, 8, 1)
  }
  if (!lower) b.box(-Xc - px, yWall - 1.5 * px, -3 * px, Xc + px, yWall + 1.5 * px, 0, M.trim)
  b.mark(-Xc, ySlot, Xc, yCav, 0, M.body)
  for (const x of lanes) b.mark(x - .46 * P, ySlot + .14 * p.slot, x + .46 * P, ySlot + .86 * p.slot, -.2, M.plinth)
  b.mark(-Xc, yCav, -Xw, yFas, 0, M.body); b.mark(Xw, yCav, Xc, yFas, 0, M.body); b.mark(-Xc, yFas, Xc, yTop, 0, M.body)
  // The works' bay: back wall, floor and the one side wall that is seen, with a frame round the opening.
  b.quad([-Xw, yCav, cavD], [Xw, yCav, cavD], [Xw, yFas, cavD], [-Xw, yFas, cavD], M.dark, [0, 0, -1])
  b.quad([-Xw, yCav, 0], [Xw, yCav, 0], [Xw, yCav, cavD], [-Xw, yCav, cavD], M.dark, [0, 1, 0])
  b.quad([Xw, yCav, 0], [Xw, yCav, cavD], [Xw, yFas, cavD], [Xw, yFas, 0], M.dark, [-1, 0, 0])
  b.box(-Xw - 2 * px, yFas, -2 * px, Xw + 2 * px, yFas + 2 * px, 0, M.trim); b.box(-Xw - 2 * px, yCav - 2 * px, -2 * px, Xw + 2 * px, yCav, 0, M.trim)
  b.box(-Xw - 2 * px, yCav, -2 * px, -Xw, yFas, 0, M.trim); b.box(Xw, yCav, -2 * px, Xw + 2 * px, yFas, 0, M.trim)
  // A cable tray along the back of the bay, on brackets.
  b.box(-Xw, yFas - 5 * px, cavD - 4 * px, Xw, yFas - 3 * px, cavD, M.rubber)
  for (let x = -Xw + P / 2; x < Xw; x += P) b.box(x - px, yFas - 3 * px, cavD - 3 * px, x + px, yFas, cavD, M.plinth)

  // The readout, set back in its bezel; the gauge with its ticks and red zone; three lamps; a vent; the fascia's screws.
  const ro = p.readout, ga = p.gauge
  b.mark(ro.x, ro.y, ro.x + ro.w, ro.y + ro.h, -.2, M.screen)
  b.mark(ro.x, ro.y + ro.h - 2 * px, ro.x + ro.w, ro.y + ro.h, -.25, M.slot); b.mark(ro.x, ro.y, ro.x + 1.5 * px, ro.y + ro.h, -.25, M.slot)
  b.box(ro.x - 2 * px, ro.y + ro.h, -1.6 * px, ro.x + ro.w + 2 * px, ro.y + ro.h + 2 * px, 0, M.trim); b.box(ro.x - 2 * px, ro.y - 2 * px, -1.6 * px, ro.x + ro.w + 2 * px, ro.y, 0, M.trim)
  b.box(ro.x - 2 * px, ro.y, -1.6 * px, ro.x, ro.y + ro.h, 0, M.trim); b.box(ro.x + ro.w, ro.y, -1.6 * px, ro.x + ro.w + 2 * px, ro.y + ro.h, 0, M.trim)
  b.cyl([ga.x, ga.y, 0], 2, -3.5 * px, 0, ga.r + 2.5 * px, M.trim, 28, 1)
  b.cyl([ga.x, ga.y, 0], 2, -3.9 * px, -3.6 * px, ga.r, M.dial, 28, 1)
  const radial = (angle: number, r0: number, r1: number, half: number, mat: number) => {
    const cos = Math.cos(angle), sin = Math.sin(angle), z = -4.1 * px
    b.quad([ga.x + cos * r0 + sin * half, ga.y + sin * r0 - cos * half, z], [ga.x + cos * r1 + sin * half, ga.y + sin * r1 - cos * half, z], [ga.x + cos * r1 - sin * half, ga.y + sin * r1 + cos * half, z], [ga.x + cos * r0 - sin * half, ga.y + sin * r0 + cos * half, z], mat, [0, 0, -1])
  }
  for (let i = 0; i <= 10; i++) radial((225 - 27 * i) * Math.PI / 180, ga.r * (i % 5 ? .78 : .68), ga.r * .9, (i % 5 ? .45 : .7) * px, i >= 8 ? M.redzone : M.ink)
  for (let i = 0; i < 12; i++) radial((225 - 27 * 8 - 4.5 * i - 2.25) * Math.PI / 180, ga.r * .9, ga.r * .99, ga.r * .045, M.redzone)
  const lampX = [0, 1, 2].map(i => ga.x - ga.r - (2 + 1.7 * i) * U), lampR = Math.min(4 * px, p.fascia * .1)
  for (const x of lampX) { b.cyl([x, ga.y, 0], 2, -2 * px, 0, lampR + 1.2 * px, M.trim, 14, 1); b.cyl([x, ga.y, 0], 2, -2.4 * px, -2.1 * px, lampR, M.lampOff, 14, 1) }
  const ventX = (ro.x + ro.w + lampX[2]) / 2, ventW = Math.min(4 * U, (lampX[2] - ro.x - ro.w) * .5 - 1.4 * U), ventH = Math.min(2.6 * V, p.fascia * .3)
  if (ventW > 1.2 * U) {
    b.mark(ventX - ventW, ga.y - ventH, ventX + ventW, ga.y + ventH, -.2, M.slot)
    for (let i = 0; i < 5; i++) b.box(ventX - ventW, ga.y - ventH + i * ventH * .4 + ventH * .08, -1.6 * px, ventX + ventW, ga.y - ventH + i * ventH * .4 + ventH * .29, 0, M.trim)
  }
  for (const [x, y] of [[-Xc + U, yFas + V], [Xc - U, yFas + V], [-Xc + U, yTop - V], [Xc - U, yTop - V], [-Xc + U, ySlot + p.slot / 2], [Xc - U, ySlot + p.slot / 2], [-Xc + U, yBand + p.band / 2], [Xc - U, yBand + p.band / 2]]) b.cyl([x, y, 0], 2, -1.2 * px, 0, 1.3 * px, M.steel, 8, 1)

  // The roof: a kerb round it, seams, the laser's pedestal, the slot scams leave by, a beacon, a cable to the hatch.
  b.box(-Xc, yTop, 0, Xc, yTop + 2 * px, 2.5 * px, M.trim); b.box(-Xc, yTop, D - 2.5 * px, Xc, yTop + 2 * px, D, M.trim)
  b.box(-Xc, yTop, 2.5 * px, -Xc + 2.5 * px, yTop + 2 * px, D - 2.5 * px, M.trim); b.box(Xc - 2.5 * px, yTop, 2.5 * px, Xc, yTop + 2 * px, D - 2.5 * px, M.trim)
  for (const x of [-Xw, Xw]) b.quad([x - .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, D - 2.5 * px], [x - .5 * px, yTop + .1, D - 2.5 * px], M.line, [0, 1, 0])
  b.quad([-Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 + .5 * px], [-Xw, yTop + .1, D * .5 + .5 * px], M.line, [0, 1, 0])
  const vents: V3[] = [[-Xw * .84, yTop + 13 * px, D * .7], [Xw * .88, yTop + 13 * px, D * .66]]
  const turret: V3 = [-Xw * .6, yTop + 16 * px, zL], eject: V3 = [Xw * .6, yTop + 5 * px, zL]
  b.cyl([turret[0], 0, zL], 1, yTop, yTop + 3 * px, 8.5 * px, M.trim, 16, 2); b.cyl([turret[0], 0, zL], 1, yTop + 3 * px, yTop + 16 * px, 3.6 * px, M.steel, 12, 2)
  b.box(eject[0] - .62 * lw, yTop, zL - 6 * px, eject[0] + .62 * lw, yTop + 5 * px, zL + 6 * px, M.steel)
  b.quad([eject[0] - .54 * lw, yTop + 5 * px + .1, zL - 2 * px], [eject[0] + .54 * lw, yTop + 5 * px + .1, zL - 2 * px], [eject[0] + .54 * lw, yTop + 5 * px + .1, zL + 2 * px], [eject[0] - .54 * lw, yTop + 5 * px + .1, zL + 2 * px], M.slot, [0, 1, 0])
  const beacon: V3 = [Xc - 3 * U, yTop + 12 * px, D * .82]
  b.cyl([beacon[0], 0, beacon[2]], 1, yTop, yTop + 8 * px, 1.2 * px, M.steel, 8, 0); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 8 * px, yTop + 9.5 * px, 3.6 * px, M.trim, 12, 2); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14 * px, 2.8 * px, M.lampOff, 12, 2)
  b.tube([[turret[0] - 5 * px, yTop + 1.4 * px, zL + 4 * px], [turret[0] - 5 * px, yTop + 1.4 * px, D * .6], [-Xw * .3, yTop + 1.4 * px, D * .6], [-Xw * .3, yTop + 1.4 * px, D * .68]], 1.3 * px, M.rubber, 6, 5 * px)
  // What the hopper and the chimneys stand over: holes, seen once they are gone.
  b.quad([-lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL + lw * .26], [-lw * .5, yTop + .15, zL + lw * .26], M.slot, [0, 1, 0])
  for (const v of vents) b.cyl([v[0], 0, v[2]], 1, yTop + .1, yTop + .2, 3.6 * px, M.slot, 12, 2)

  // The roller line and, under it, a chute for each lane: two plates that lean together.
  const rr = P / 8 * .4, yR = yCav + p.cavity * .4, z0 = zL - 12 * px, z1 = zL + 12 * px, rideY = yR + rr + lh / 2, scanY = Math.min(yFas - lh / 2 - 8 * px, rideY + lh * .92)
  for (const x of lanes) for (const s of [-1, 1]) b.prism(ccw([[x + s * .48 * P, yR - rr - 3 * px], [x + s * .48 * P - s * 1.6 * px, yR - rr - 3 * px], [x + s * .4 * P - s * 1.6 * px, yCav], [x + s * .4 * P, yCav]]), z0, z1, M.trim, 'fs')
  for (let i = 0; i <= 7; i++) { const x = (i - 3.5) * P; b.box(x - .16 * P, yR - rr - 4.5 * px, z0 - 1.5 * px, x + .16 * P, yR - rr * .2, z0, M.plinth); b.box(x - .16 * P, yR - rr - 4.5 * px, z1, x + .16 * P, yR - rr * .2, z1 + 1.5 * px, M.plinth) }
  // The scanner hangs from the bay's ceiling over the middle lane.
  b.box(-lw * .6, yFas - 6 * px, zL - 7 * px, lw * .6, yFas, zL + 7 * px, M.steel); b.mark(-lw * .5, yFas - 6 * px - .1, lw * .5, yFas - 4.5 * px, zL - 7 * px - .1, M.red)

  // The tubes' fittings: sockets in both manifolds, a dark channel behind each run, collars; where they cross the
  // slab, a port in the cabinet's wall and saddles that hold them down.
  const yLow = lower ? yWall + lower : r + px
  for (const x of p.tubes) {
    b.mark(x - r - px, lower ? yLow : yWall + 1.5 * px, x + r + px, yMan, -.15, M.dark)
    if (!lower) b.mark(x - r - px, 1.5 * V, x + r + px, yWall - 1.5 * px, -.15, M.slot)
    b.cyl([x, 0, zt], 1, yMan - 3 * px, yMan, r + 1.6 * px, M.steel, 12, 1)
    if (lower) b.cyl([x, 0, zt], 1, yLow, yLow + 3 * px, r + 1.6 * px, M.steel, 12, 2)
    for (let y = yMan - 9 * V; y > yLow + 4 * V; y -= 9.4 * V) b.cyl([x, 0, zt], 1, y - 1.2 * px, y + 1.2 * px, r + 1.2 * px, M.steel, 12, 3)
  }
  const saddle = (x: number, z: number, along: 'x' | 'z') => along === 'x' ? b.box(x - 1.8 * px, 0, z - r - 2.4 * px, x + 1.8 * px, 2 * r + 2.6 * px, z + r + 2.4 * px, M.steel) : b.box(x - r - 2.4 * px, 0, z - 1.8 * px, x + r + 2.4 * px, 2 * r + 2.6 * px, z + 1.8 * px, M.steel)
  p.fan.forEach((leg, t) => {
    const s = t < 4 ? -1 : 1, wallX = s * Xc
    if (s < 0) b.cyl([0, r + 2 * px, leg.z], 0, wallX - 3 * px, wallX, r + 2 * px, M.steel, 12, 1)
    for (let x = wallX + s * 30 * px; Math.abs(x) < Math.abs(leg.x) - 2.6 * r; x += s * 9 * U) saddle(x, leg.z, 'x')
    saddle(leg.x + DX * (leg.z - p.zLip * .45), p.zLip * .45, 'z')
  })
  if (!p.fan.length) for (const first of [0, 4]) { const a = Math.min(p.tubes[first], p.tubes[first + 3]), e = Math.max(p.tubes[first], p.tubes[first + 3]), z = (zt + p.zLip) / 2, shift = DX * (zt - z); b.box(a + shift - r - 2 * px, 0, z - 1.6 * px, e + shift + r + 2 * px, 2 * r + 2.4 * px, z + 1.6 * px, M.steel) }

  // ── Parts ──
  const idx = { glass: 0, tubes: 0, soot: 0, shards: 0, hole: 0, bent: 0, needle: 0, turret: 0, scan: 0, hopper: 0, hatch: 0, beaconOn: 0, vents: [] as number[], panes: [] as number[], cracks: [] as number[], lamps: [] as number[], flaps: [] as number[], rollers: [] as number[], caps: [] as number[], bolts: [] as number[] }

  idx.needle = b.part('needle', [ga.x, ga.y, 0])
  b.prism(ccw([[ga.x - 1.1 * px, ga.y - ga.r * .22], [ga.x + 1.1 * px, ga.y - ga.r * .22], [ga.x + .4 * px, ga.y + ga.r * .8], [ga.x - .4 * px, ga.y + ga.r * .8]]), -4.8 * px, -4.4 * px, M.ink, 'f')
  b.cyl([ga.x, ga.y, 0], 2, -5.6 * px, -4.4 * px, 2.2 * px, M.steel, 12, 1)

  lampX.forEach((x, i) => { idx.lamps.push(b.part(`lamp${i}`)); b.cyl([x, ga.y, 0], 2, -2.7 * px, -2.5 * px, lampR, i === 0 ? M.red : M.lampOn, 14, 1) })
  idx.beaconOn = b.part('beacon'); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14.2 * px, 3 * px, M.red, 12, 2)

  // The laser: a barrel on a yoke, a red lens, fins.
  idx.turret = b.part('turret', turret)
  b.box(turret[0] - 8 * px, turret[1] - 4.6 * px, zL - 5 * px, turret[0] + 17 * px, turret[1] + 4.6 * px, zL + 5 * px, M.plinth, ALL)
  b.cyl([0, turret[1], zL], 0, turret[0] + 17 * px, turret[0] + 22 * px, 3.4 * px, M.steel, 12, 2, M.red)
  b.cyl([0, turret[1], zL], 0, turret[0] - 10.5 * px, turret[0] - 8 * px, 3.6 * px, M.trim, 12, 1)
  for (let i = 0; i < 4; i++) b.box(turret[0] - 5 * px + i * 4.4 * px, turret[1] + 4.6 * px, zL - 4 * px, turret[0] - 3.2 * px + i * 4.4 * px, turret[1] + 7.4 * px, zL + 4 * px, M.trim, ALL)
  b.cyl([turret[0], turret[1], 0], 2, zL - 6.6 * px, zL + 6.6 * px, 3 * px, M.steel, 10, 3)

  idx.scan = b.part('scan', [0, scanY, zL]); b.mark(-lw * .56, scanY - .7 * px, lw * .56, scanY + .7 * px, zL - 2.5 * px, M.red)

  // The hopper: a funnel of four plates on a collar, its front lower than its back so the letters are seen going in.
  const hh = p.hopper * .82, ht = lw * 1.3, hb = lw * .62, hd = lw * .36, t = 1.3 * px
  idx.hopper = b.part('hopper', [0, yTop + hh / 2, zL])
  b.prism(ccw([[-hb, yTop], [hb, yTop], [ht, yTop + hh], [-ht, yTop + hh]]), zL + hd, zL + hd + t, M.trim, 'fks', M.steel)
  for (const s of [-1, 1]) b.prism(ccw([[s * hb, yTop], [s * (hb + t), yTop], [s * (ht + t), yTop + hh], [s * ht, yTop + hh]]), zL - hd, zL + hd, M.trim, 'fks', M.steel)
  b.prism(ccw([[-hb, yTop], [hb, yTop], [hb + (ht - hb) * .62, yTop + hh * .62], [-hb - (ht - hb) * .62, yTop + hh * .62]]), zL - hd - t, zL - hd, M.steel, 'fks', M.trim)
  b.box(-hb - 3 * px, yTop, zL - hd - 3 * px, hb + 3 * px, yTop + 2.4 * px, zL + hd + 3 * px, M.plinth, ALL)

  // The chimneys and the hatch: on the roof until the burst.
  vents.forEach((v, i) => { idx.vents.push(b.part(`vent${i}`, [v[0], yTop + 6 * px, v[2]])); b.cyl([v[0], 0, v[2]], 1, yTop, yTop + 11 * px, 4.5 * px, M.steel, 14, 1); b.cyl([v[0], 0, v[2]], 1, yTop + 11 * px, yTop + 13 * px, 6 * px, M.trim, 14, 3, M.slot) })
  idx.hatch = b.part('hatch', [-Xw * .3, yTop + px, D * .76])
  b.box(-Xw * .46, yTop, D * .64, -Xw * .14, yTop + 1.8 * px, D * .88, M.trim, ALL); b.box(-Xw * .32, yTop + 1.8 * px, D * .74, -Xw * .28, yTop + 3.4 * px, D * .78, M.steel, ALL)

  // Rollers: eight to a lane, the middle four on that lane's drop gate. Each has a mark on its end so its turning shows.
  const rollerLane: number[] = [], rollerHome: V3[] = []
  for (let j = 0; j < 56; j++) {
    const x = lanes[0] - P / 2 + (j + .5) * P / 8
    idx.rollers.push(b.part(`roller${j}`, [x, yR, zL])); rollerLane.push(Math.floor(j / 8)); rollerHome.push([x, yR, zL])
    b.cyl([x, yR, 0], 2, z0, z1, rr, M.steel, 12, 3, M.trim)
    b.cyl([x + rr * .5, yR, 0], 2, z0 - .3, z0 - .1, rr * .28, M.ink, 6, 1)
  }
  // The gates: a frame under four rollers, hinged at its upstream end (the middle lane's at its left).
  const hinge: V3[] = [], swing: number[] = []
  lanes.forEach((x, i) => {
    const dir = i < 3 ? -1 : 1, hx = x - dir * P / 4
    hinge.push([hx, yR, zL]); swing.push(dir)
    idx.flaps.push(b.part(`flap${i}`, [hx, yR, zL]))
    for (const z of [z0 - 1.5 * px, z1]) b.box(x - P / 4, yR - rr - 2.5 * px, z, x + P / 4, yR - rr * .2, z + 1.5 * px, M.steel, ALL)
    b.cyl([hx, yR - rr - 1.2 * px, 0], 2, z0 - 2.4 * px, z0 - 1.5 * px, 1.6 * px, M.trim, 8, 1)
  })

  // Capsules for the tubes, and bolts that can pop.
  const capH = r * 1.5, capR = r * .68
  for (let i = 0; i < 28; i++) { idx.caps.push(b.part(`cap${i}`)); b.cyl([0, 0, 0], 1, -capH, capH, capR, M.paper, 8, 0); b.cyl([0, 0, 0], 1, capH, capH + capR * .7, capR, M.brand, 8, 2); b.cyl([0, 0, 0], 1, -capH - capR * .7, -capH, capR, M.brand, 8, 1) }
  for (const [x, y] of [[-Xw - px, yFas + px], [Xw + px, yFas + px], [-Xw - px, yCav - px], [Xw + px, yCav - px], [0, yFas + px], [-Xw / 2, yCav - px], [Xw / 2, yCav - px], [-Xw / 2, yFas + px], [Xw / 2, yFas + px]] as [number, number][]) {
    idx.bolts.push(b.part(`bolt${idx.bolts.length}`, [x, y, -2.6 * px])); b.cyl([x, y, 0], 2, -3.2 * px, -2 * px, 1.5 * px, M.steel, 8, 3)
  }

  // What the burst leaves: soot and a torn hole in the roof where the hopper stood, splinters of glass in the frame.
  const ch = p.cavity
  idx.soot = b.part('soot', [0, 0, 0], true)
  b.quad([-hb * 2.6, yTop + .2, zL - hd * 1.6], [hb * 2.9, yTop + .2, zL - hd * 1.2], [hb * 2.4, yTop + .2, zL + hd * 4.4], [-hb * 2.1, yTop + .2, zL + hd * 3.8], M.scorch, [0, 1, 0])
  idx.hole = b.part('hole')
  b.quad([-hb * 1.25, yTop + .3, zL - hd * .9], [hb * 1.1, yTop + .3, zL - hd * 1.05], [hb * 1.3, yTop + .3, zL + hd * 1.5], [-hb * .95, yTop + .3, zL + hd * 1.7], M.slot, [0, 1, 0])
  for (const [x, w, h, lean] of [[-hb * 1.3, hb * .5, 9, -.5], [-hb * .5, hb * .45, 12, -.15], [hb * .3, hb * .5, 8, .2], [hb * 1.05, hb * .42, 11, .55]] as number[][]) b.prism(ccw([[x - w / 2, yTop], [x + w / 2, yTop], [x + lean * h * px, yTop + h * px]]), zL + hd * 1.5, zL + hd * 1.5 + 1.2 * px, M.trim, 'fks', M.steel)
  for (const [x, w, h, lean] of [[-hb * 1.1, hb * .46, 6, -.3], [hb * .15, hb * .5, 8, .1], [hb * .95, hb * .4, 5, .4]] as number[][]) b.prism(ccw([[x - w / 2, yTop], [x + w / 2, yTop], [x + lean * h * px, yTop + h * px]]), zL - hd, zL - hd + 1.2 * px, M.steel, 'fks', M.trim)
  idx.shards = b.part('shards', [0, 0, 0], true)
  const shard = (points: [number, number][]) => { b.prism(ccw(points), -1.3 * px, -1.2 * px, M.sheen, 'f'); b.prism(ccw(points), -1.25 * px, -1.2 * px, M.glass, 'f') }
  shard([[-Xw, yFas], [-Xw + Xw * .2, yFas], [-Xw + Xw * .08, yFas - ch * .3], [-Xw, yFas - ch * .46]]); shard([[-Xw, yCav], [-Xw + Xw * .26, yCav], [-Xw + Xw * .1, yCav + ch * .16], [-Xw, yCav + ch * .3]])
  shard([[Xw, yFas], [Xw - Xw * .14, yFas], [Xw - Xw * .18, yFas - ch * .18], [Xw, yFas - ch * .38]]); shard([[Xw, yCav], [Xw - Xw * .3, yCav], [Xw - Xw * .09, yCav + ch * .24], [Xw, yCav + ch * .2]])
  shard([[-Xw * .3, yFas], [-Xw * .1, yFas], [-Xw * .17, yFas - ch * .22]]); shard([[Xw * .2, yCav], [Xw * .4, yCav], [Xw * .33, yCav + ch * .14]]); shard([[Xw * .34, yFas], [Xw * .5, yFas], [Xw * .46, yFas - ch * .13]])
  // The panes the glass breaks into: thrown by the burst.
  for (let i = 0; i < 8; i++) {
    const cx = (i - 3.5) * Xw * .24 + ((i * 37) % 9 - 4) * px, cy = yCav + ch * (.3 + ((i * 53) % 5) * .1), w = Xw * (.09 + ((i * 29) % 4) * .02), h = ch * (.22 + ((i * 17) % 3) * .08)
    idx.panes.push(b.part(`pane${i}`, [cx, cy, -1.2 * px], true))
    const points = ccw([[cx - w, cy - h * .6], [cx + w * .7, cy - h], [cx + w, cy + h * .4], [cx - w * .3, cy + h]])
    b.prism(points, -1.6 * px, -.8 * px, M.pane, 'fk')
  }
  // Before it goes, the glass cracks: twice, each a star of hairlines from where it gave.
  const hair = (x0: number, y0: number, x1: number, y1: number) => { const l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l * .45 * px, ny = (x1 - x0) / l * .45 * px; b.quad([x0 - nx, y0 - ny, -1.5 * px], [x1 - nx, y1 - ny, -1.5 * px], [x1 + nx, y1 + ny, -1.5 * px], [x0 + nx, y0 + ny, -1.5 * px], M.crack, [0, 0, -1]) }
  const crackAt: [number, number][] = [[-Xw * .34, yCav + ch * .62], [Xw * .46, yCav + ch * .4]]
  crackAt.forEach(([cx, cy], n) => {
    idx.cracks.push(b.part(`crack${n}`, [0, 0, 0], true))
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + n * .5 + ((i * 7) % 5) * .09, l1 = (.16 + ((i * 13 + n * 5) % 7) * .035) * Xw, a2 = a + (((i * 11) % 5) - 2) * .16, l2 = l1 * (.5 + ((i * 3) % 4) * .16)
      const clampY = (y: number) => Math.min(yFas - px, Math.max(yCav + px, y)), clampX = (x: number) => Math.min(Xw - px, Math.max(-Xw + px, x))
      const mx = clampX(cx + Math.cos(a) * l1), my = clampY(cy + Math.sin(a) * l1 * .7), ex = clampX(mx + Math.cos(a2) * l2), ey = clampY(my + Math.sin(a2) * l2 * .7)
      hair(cx, cy, mx, my); hair(mx, my, ex, ey)
      if (i % 3 === 0) hair(mx, my, clampX(mx + Math.cos(a2 + 1.1) * l2 * .6), clampY(my + Math.sin(a2 + 1.1) * l2 * .5))
    }
  })
  idx.glass = b.part('glass', [0, (yCav + yFas) / 2, -1.2 * px], true)
  b.mark(-Xw, yCav, Xw, yFas, -1.2 * px, M.glass)

  // The tubes themselves. Each is one or two runs: down the front between the manifolds, and (where they fan out)
  // out of the cabinet's wall, across the slab, over the lip and down. One of the front runs is its own part: the
  // burst bends it out of its socket.
  const lines: V3[][][] = [], drop = -(p.floor + 80), bentTube = 5, bentY = yLow + (yMan - yLow) * .42
  idx.tubes = b.part('tubes', [0, 0, 0], true)
  p.tubes.forEach((x, t) => {
    if (p.fan.length) {
      const leg = p.fan[t], s = t < 4 ? -1 : 1
      const frontRun = t === bentTube ? [[x, yMan, zt], [x, yLow, zt]] as V3[] : b.tube([[x, yMan, zt], [x, yLow, zt]], r, M.tube, 10)
      if (t === bentTube) b.tube([[x, bentY, zt], [x, yLow, zt]], r, M.tube, 10)
      lines.push([frontRun, b.tube([[s * (Xc - 4 * px), r + 2 * px, leg.z], [leg.x, r + 2 * px, leg.z], [leg.out, r + 2 * px, p.zOver], [leg.out, drop, p.zOver]], r, M.tube, 10, r * 3.2)])
    } else lines.push([b.tube([[x, yMan, zt], [x, r + px, zt], [x + DX * (zt - p.zOver), r + px, p.zOver], [x + DX * (zt - p.zOver), drop, p.zOver]], r, M.tube, 10, r * 3)])
  })
  idx.bent = b.part('bent', [p.tubes[bentTube], p.fan.length ? bentY : yWall, zt], true)
  if (p.fan.length) {
    b.tube([[p.tubes[bentTube], yMan - 3 * px, zt], [p.tubes[bentTube], bentY, zt]], r, M.tube, 10)
    for (const y of [yMan - 4 * px, bentY + 1.2 * px, (yMan + bentY) / 2]) b.cyl([p.tubes[bentTube], 0, zt], 1, y - 1.2 * px, y + 1.2 * px, r + 1.2 * px, M.steel, 12, 3)
  }

  const data = b.finish()
  return { data, parts: b.parts, idx, wall, lines, rollerLane, rollerHome, hinge, swing, rr, yR, rideY, scanY, z0, z1, turret, eject, beacon, vents, crackAt, ventFront: [ventX, ga.y, -3 * px] as V3, hopperTop: yTop + hh, hopperWide: ht, px }
}
const phone = (p: Plan) => p.phone
