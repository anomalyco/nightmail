// The sorting machine, built once from the plan as solids: a cabinet whose front is, from the floor up, the base (the
// page's button stands in it), the band with the sentence, the sorting frame whose thousand filled pigeonholes spell the
// price, a manifold the tubes hang from, the label rail, the works behind glass (a line of rollers with a drop gate
// and a chute for each lane, a scanner over the middle) and a fascia with the readout and the pressure gauge. On the
// roof: the hopper letters fall into, a laser on a pedestal, the slot scams are thrown out of, vents and a beacon.
// Eight glass tubes run down the front and away across the floor. Everything that moves or can be blown off is a part.
import { ALL, Builder, type V3 } from './mesh'
import { MAT as M } from './tones'
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
import { LETTER_FLOATS } from './gl'

export type Machine = ReturnType<typeof buildMachine>

const ccw = (points: [number, number][]) => { let area = 0; points.forEach((a, i) => { const b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1] }); return area < 0 ? points.slice().reverse() : points }

export function buildMachine(p: Plan) {
  const b = new Builder()
  const { U, V, Xw, Xc, D, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, zL, cavD, tubeR } = p
  const px = U / 9, wallRows = PRICE.length + p.over + p.under

  b.quad([-4000, 0, -1900], [4000, 0, -1900], [4000, 0, 3900], [-4000, 0, 3900], M.floor, [0, 1, 0])

  // The cabinet: its roof and side, then its front floor by floor.
  b.box(-Xc, 0, 0, Xc, yTop, D, M.body, 'tl')
  b.box(-Xc - 2 * px, 0, -3 * px, Xc + 2 * px, 1.5 * V, D + 2 * px, M.plinth)
  b.mark(-Xc, 1.5 * V, Xc, yWall, 0, M.plinth)
  b.box(-Xc, yBand - px, -1.5 * px, Xc, yBand + px, 0, M.trim)
  b.box(-Xc - px, yWall - 1.5 * px, -3 * px, Xc + px, yWall + 1.5 * px, 0, M.trim)
  // The button's bay in the base: a frame proud of the wall, dark inside until the page's button paints over it.
  const c = p.cta, f = 2.5 * px
  b.mark(c.x, c.y, c.x + c.w, c.y + c.h, -.3, M.slot)
  b.box(c.x - f, c.y + c.h, -2 * px, c.x + c.w + f, c.y + c.h + f, 0, M.trim); b.box(c.x - f, c.y - f, -2 * px, c.x + c.w + f, c.y, 0, M.trim)
  b.box(c.x - f, c.y, -2 * px, c.x, c.y + c.h, 0, M.trim); b.box(c.x + c.w, c.y, -2 * px, c.x + c.w + f, c.y + c.h, 0, M.trim)

  // The sorting frame: every pigeonhole, the empty ones a step off the wall; the thousand full ones are letters.
  b.mark(-Xw, yWall, Xw, yMan, 0, M.wall); b.mark(-Xc, yWall, -Xw, yMan, 0, M.body); b.mark(Xw, yWall, Xc, yMan, 0, M.body)
  const wall = new Float32Array(1000 * LETTER_FLOATS), g = U * .085
  let lit = 0
  for (let r = 0; r < wallRows; r++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const x = -Xw + col * U, y = yWall + (wallRows - 1 - r) * V
    if (PRICE[r - p.over]?.[col - p.side] === '#') wall.set([x + U / 2, y + V / 2, -.5, 0, 0, 0, 1, U - 2 * g, V - 2 * g, .4, (lit * .6180339887) % 1, 0, 2, 0], lit++ * LETTER_FLOATS)
    else b.mark(x + g, y + g, x + U - g, y + V - g, -.2, (col * 7 + r * 13) % 5 === 0 ? M.cell2 : M.cell)
  }

  // The manifold, bolted on; the label rail; the fascia.
  b.box(-Xc - px, yMan, -5 * px, Xc + px, yMan + p.manifold, 0, M.trim)
  for (let x = -Xc + 1.5 * U; x < Xc; x += 3 * U) b.cyl([x, yMan + p.manifold / 2, 0], 2, -6.2 * px, -5 * px, 1.25 * px, M.steel, 8, 1)
  b.mark(-Xc, ySlot, Xc, yCav, 0, M.body)
  for (const x of lanes) b.mark(x - .42 * P, ySlot + .16 * p.slot, x + .42 * P, ySlot + .84 * p.slot, -.2, M.plinth)
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

  // The readout, the gauge with its ticks and red zone, three lamps, a vent and the fascia's screws.
  const ro = p.readout, ga = p.gauge
  b.mark(ro.x, ro.y, ro.x + ro.w, ro.y + ro.h, -.2, M.screen)
  b.box(ro.x - 1.5 * px, ro.y + ro.h, -1.2 * px, ro.x + ro.w + 1.5 * px, ro.y + ro.h + 1.5 * px, 0, M.trim); b.box(ro.x - 1.5 * px, ro.y - 1.5 * px, -1.2 * px, ro.x + ro.w + 1.5 * px, ro.y, 0, M.trim)
  b.box(ro.x - 1.5 * px, ro.y, -1.2 * px, ro.x, ro.y + ro.h, 0, M.trim); b.box(ro.x + ro.w, ro.y, -1.2 * px, ro.x + ro.w + 1.5 * px, ro.y + ro.h, 0, M.trim)
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
  const ventX = (ro.x + ro.w + lampX[2]) / 2, ventW = Math.min(4.5 * U, (lampX[2] - ro.x - ro.w) * .5 - U)
  if (ventW > 1.4 * U) {
    b.mark(ventX - ventW, ga.y - 2.6 * V, ventX + ventW, ga.y + 2.6 * V, -.2, M.slot)
    for (let i = 0; i < 5; i++) b.box(ventX - ventW, ga.y - 2.6 * V + i * 1.04 * V + .2 * V, -1.6 * px, ventX + ventW, ga.y - 2.6 * V + i * 1.04 * V + .75 * V, 0, M.trim)
  }
  for (const [x, y] of [[-Xc + U, yFas + V], [Xc - U, yFas + V], [-Xc + U, yTop - V], [Xc - U, yTop - V], [-Xc + U, ySlot + p.slot / 2], [Xc - U, ySlot + p.slot / 2]]) b.cyl([x, y, 0], 2, -1.2 * px, 0, 1.3 * px, M.steel, 8, 1)

  // The roof: a kerb round it, seams, a hatch, two vents, the laser's pedestal, the slot scams leave by, a beacon.
  b.box(-Xc, yTop, 0, Xc, yTop + 2 * px, 2.5 * px, M.trim); b.box(-Xc, yTop, D - 2.5 * px, Xc, yTop + 2 * px, D, M.trim)
  b.box(-Xc, yTop, 2.5 * px, -Xc + 2.5 * px, yTop + 2 * px, D - 2.5 * px, M.trim); b.box(Xc - 2.5 * px, yTop, 2.5 * px, Xc, yTop + 2 * px, D - 2.5 * px, M.trim)
  for (const x of [-Xw, Xw]) b.quad([x - .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, D - 2.5 * px], [x - .5 * px, yTop + .1, D - 2.5 * px], M.line, [0, 1, 0])
  b.box(-Xw * .42, yTop, D * .58, -Xw * .14, yTop + 1.6 * px, D * .86, M.trim); b.box(-Xw * .3, yTop + 1.6 * px, D * .7, -Xw * .26, yTop + 3 * px, D * .74, M.steel)
  const vents: V3[] = [[-Xw * .86, yTop + 11 * px, D * .72], [Xw * .9, yTop + 11 * px, D * .72]]
  for (const v of vents) { b.cyl([v[0], 0, v[2]], 1, yTop, yTop + 9 * px, 4.5 * px, M.steel, 14, 0); b.cyl([v[0], 0, v[2]], 1, yTop + 9 * px, yTop + 11 * px, 6 * px, M.trim, 14, 2, M.slot) }
  const turret: V3 = [-Xw * .6, yTop + 16 * px, zL], eject: V3 = [Xw * .6, yTop + 5 * px, zL]
  b.cyl([turret[0], 0, zL], 1, yTop, yTop + 3 * px, 8.5 * px, M.trim, 16, 2); b.cyl([turret[0], 0, zL], 1, yTop + 3 * px, yTop + 16 * px, 3.6 * px, M.steel, 12, 2)
  b.box(eject[0] - .8 * lw, yTop, zL - 6 * px, eject[0] + .8 * lw, yTop + 5 * px, zL + 6 * px, M.steel)
  b.quad([eject[0] - .64 * lw, yTop + 5 * px + .1, zL - 2 * px], [eject[0] + .64 * lw, yTop + 5 * px + .1, zL - 2 * px], [eject[0] + .64 * lw, yTop + 5 * px + .1, zL + 2 * px], [eject[0] - .64 * lw, yTop + 5 * px + .1, zL + 2 * px], M.slot, [0, 1, 0])
  const beacon: V3 = [Xc - 3 * U, yTop + 12 * px, D * .7]
  b.cyl([beacon[0], 0, beacon[2]], 1, yTop, yTop + 8 * px, 1.2 * px, M.steel, 8, 0); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 8 * px, yTop + 9.5 * px, 3.6 * px, M.trim, 12, 2); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14 * px, 2.8 * px, M.lampOff, 12, 2)
  // A cable from the laser's pedestal across the roof to the hatch.
  b.tube([[turret[0] - 5 * px, yTop + 1.4 * px, zL + 4 * px], [turret[0] - 5 * px, yTop + 1.4 * px, D * .64], [-Xw * .36, yTop + 1.4 * px, D * .64], [-Xw * .36, yTop + 1.4 * px, D * .7]], 1.3 * px, M.rubber, 6, 5 * px)

  b.quad([-lw * .62, yTop + .15, zL - lw * .3], [lw * .62, yTop + .15, zL - lw * .3], [lw * .62, yTop + .15, zL + lw * .3], [-lw * .62, yTop + .15, zL + lw * .3], M.slot, [0, 1, 0])
  // The roller line and, under it, a chute for each lane: two plates that lean together.
  const rr = P / 8 * .4, yR = yCav + p.cavity * .46, z0 = zL - 12 * px, z1 = zL + 12 * px, rideY = yR + rr + lh / 2, scanY = Math.min(yFas - lh / 2 - 7 * px, rideY + lh * .95)
  for (const x of lanes) for (const s of [-1, 1]) b.prism(ccw([[x + s * .47 * P, yR - rr - 3 * px], [x + s * .47 * P - s * 1.6 * px, yR - rr - 3 * px], [x + s * .3 * P - s * 1.6 * px, yCav], [x + s * .3 * P, yCav]]), z0, z1, M.trim, 'fs')
  for (let i = 0; i <= 7; i++) { const x = (i - 3.5) * P; b.box(x - .16 * P, yR - rr - 4.5 * px, z0 - 1.5 * px, x + .16 * P, yR - rr * .2, z0, M.plinth); b.box(x - .16 * P, yR - rr - 4.5 * px, z1, x + .16 * P, yR - rr * .2, z1 + 1.5 * px, M.plinth) }
  // The scanner hangs from the bay's ceiling over the middle lane.
  b.box(-lw * .62, yFas - 6 * px, zL - 7 * px, lw * .62, yFas, zL + 7 * px, M.steel); b.mark(-lw * .5, yFas - 6 * px - .1, lw * .5, yFas - 4.5 * px, zL - 7 * px - .1, M.red)

  // The tubes: sockets under the manifold, a dark channel behind each, collars down the run and on the floor.
  const zt = -(tubeR + 1.5 * px), zEnd = -(p.floor + 60) / DY, tubeLines: V3[][] = []
  for (const x of p.tubes) {
    b.mark(x - tubeR - px, yWall + 1.5 * px, x + tubeR + px, yMan, -.15, M.dark); b.mark(x - tubeR - px, 1.5 * V, x + tubeR + px, yWall - 1.5 * px, -.15, M.slot)
    b.cyl([x, 0, zt], 1, yMan - 3 * px, yMan, tubeR + 1.6 * px, M.steel, 12, 1)
    for (let y = yMan - 9 * V; y > 3 * V; y -= 9.4 * V) b.cyl([x, 0, zt], 1, y - 1.2 * px, y + 1.2 * px, tubeR + 1.2 * px, M.steel, 12, 3)
    for (let z = zt - 5 * tubeR; z > zEnd; z -= 9 * U) b.cyl([x + DX * (zt - z), tubeR + px, 0], 2, z - 1.2 * px, z + 1.2 * px, tubeR + 1.2 * px, M.steel, 12, 1)
  }

  // ── Parts ──
  const idx = { glass: 0, tubes: 0, soot: 0, shards: 0, needle: 0, turret: 0, scan: 0, hopper: 0, beaconOn: 0, lamps: [] as number[], flaps: [] as number[], rollers: [] as number[], caps: [] as number[], bolts: [] as number[], chutes: [] as number[] }

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
  const hh = p.hopper * .82, ht = lw * 1.55, hb = lw * .7, hd = lw * .42, t = 1.3 * px
  idx.hopper = b.part('hopper', [0, yTop + hh / 2, zL])
  b.prism(ccw([[-hb, yTop], [hb, yTop], [ht, yTop + hh], [-ht, yTop + hh]]), zL + hd, zL + hd + t, M.trim, 'fks', M.steel)
  for (const s of [-1, 1]) b.prism(ccw([[s * hb, yTop], [s * (hb + t), yTop], [s * (ht + t), yTop + hh], [s * ht, yTop + hh]]), zL - hd, zL + hd, M.trim, 'fks', M.steel)
  b.prism(ccw([[-hb, yTop], [hb, yTop], [hb + (ht - hb) * .62, yTop + hh * .62], [-hb - (ht - hb) * .62, yTop + hh * .62]]), zL - hd - t, zL - hd, M.steel, 'fks', M.trim)
  b.box(-hb - 3 * px, yTop, zL - hd - 3 * px, hb + 3 * px, yTop + 2.4 * px, zL + hd + 3 * px, M.plinth, ALL)

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

  // Capsules for the tubes, bolts that can pop, the glass in front of the works, the tubes themselves.
  const capH = tubeR * 1.5, capR = tubeR * .68
  for (let i = 0; i < 18; i++) { idx.caps.push(b.part(`cap${i}`)); b.cyl([0, 0, 0], 1, -capH, capH, capR, M.paper, 8, 0); b.cyl([0, 0, 0], 1, capH, capH + capR * .7, capR, M.brand, 8, 2); b.cyl([0, 0, 0], 1, -capH - capR * .7, -capH, capR, M.brand, 8, 1) }
  for (const [x, y] of [[-Xw - px, yFas + px], [Xw + px, yFas + px], [-Xw - px, yCav - px], [Xw + px, yCav - px], [0, yFas + px], [-Xw / 2, yCav - px], [Xw / 2, yCav - px], [-Xw / 2, yFas + px], [Xw / 2, yFas + px]] as [number, number][]) {
    idx.bolts.push(b.part(`bolt${idx.bolts.length}`, [x, y, -2.6 * px])); b.cyl([x, y, 0], 2, -3.2 * px, -2 * px, 1.5 * px, M.steel, 8, 3)
  }
  // What the burst leaves: soot on the roof round where the hopper stood, and splinters of the glass still in its frame.
  idx.soot = b.part('soot', [0, 0, 0], true)
  b.quad([-hb * 2.2, yTop + .2, zL - hd * 2], [hb * 2.4, yTop + .2, zL - hd * 1.6], [hb * 2, yTop + .2, zL + hd * 2.6], [-hb * 1.8, yTop + .2, zL + hd * 2.2], M.scorch, [0, 1, 0])
  idx.shards = b.part('shards', [0, 0, 0], true)
  const shard = (points: [number, number][]) => { b.prism(ccw(points), -1.3 * px, -1.2 * px, M.sheen, 'f'); b.prism(ccw(points), -1.25 * px, -1.2 * px, M.glass, 'f') }
  const ch = p.cavity
  shard([[-Xw, yFas], [-Xw + Xw * .22, yFas], [-Xw + Xw * .09, yFas - ch * .34], [-Xw, yFas - ch * .5]]); shard([[-Xw, yCav], [-Xw + Xw * .3, yCav], [-Xw + Xw * .12, yCav + ch * .2], [-Xw, yCav + ch * .36]])
  shard([[Xw, yFas], [Xw - Xw * .16, yFas], [Xw - Xw * .2, yFas - ch * .2], [Xw, yFas - ch * .42]]); shard([[Xw, yCav], [Xw - Xw * .34, yCav], [Xw - Xw * .1, yCav + ch * .3], [Xw, yCav + ch * .24]])
  shard([[-Xw * .3, yFas], [-Xw * .08, yFas], [-Xw * .16, yFas - ch * .26]]); shard([[Xw * .2, yCav], [Xw * .42, yCav], [Xw * .34, yCav + ch * .18]]); shard([[Xw * .34, yFas], [Xw * .52, yFas], [Xw * .47, yFas - ch * .15]])
  idx.glass = b.part('glass', [0, (yCav + yFas) / 2, -1.2 * px], true)
  b.mark(-Xw, yCav, Xw, yFas, -1.2 * px, M.glass)
  const slant = p.cavity * .55
  for (const [x, w] of [[-Xw * .62, Xw * .1], [-Xw * .47, Xw * .03], [Xw * .5, Xw * .05]]) b.quad([x, yCav, -1.4 * px], [x + w, yCav, -1.4 * px], [x + w + slant, yFas, -1.4 * px], [x + slant, yFas, -1.4 * px], M.sheen, [0, 0, -1])
  idx.tubes = b.part('tubes', [0, 0, 0], true)
  for (const x of p.tubes) tubeLines.push(b.tube([[x, yMan, zt], [x, tubeR + px, zt], [x + DX * (zt - zEnd), tubeR + px, zEnd]], tubeR, M.tube, 10, tubeR * 3))

  const data = b.finish()
  return { data, parts: b.parts, idx, wall, tubeLines, rollerLane, rollerHome, hinge, swing, rr, yR, rideY, scanY, z0, z1, turret, eject, beacon, vents, ventFront: [ventX, ga.y, -3 * px] as V3, hopperTop: yTop + hh, px }
}
