// The sorting machine, built once from the plan as solids. It stands on a slab with a lip along its front. Its cabinet's
// front is, from the floor up: the base (the page's button stands in it), the band with the sentence, the sorting frame
// whose thousand filled pigeonholes spell the price between two manifolds and eight glass tubes, the label rail, the
// works behind glass (a line of rollers with a drop gate and a chute for each lane, a scanner over the middle) and a
// fascia with the readout and the pressure gauge. On the roof: the hopper letters fall into; either side of it a slot
// scams are thrown out of, and at each end a laser on a pedestal to burn them; two chimneys, a hatch and a beacon. The tubes leave the cabinet at the floor,
// cross the slab and go over its lip. Everything that moves or can be blown off is a part.
import { ALL, Builder, unit, type V3 } from './mesh'
import { MAT as M } from './tones'
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
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
  b.box(-Xc - 2 * px, 0, -3 * px, Xc + 2 * px, 1.5 * V, 0, M.plinth)
  b.mark(-Xc, 1.5 * V, Xc, yWall, 0, M.plinth)
  b.box(-Xc, yBand - px, -1.5 * px, Xc, yBand + px, 0, M.trim)
  // Relief: a post proud of the front at each corner, a cornice under the roof, a rail over the base.
  if (p.post) { for (const x of [-Xc, Xc - p.post]) b.box(x, 1.5 * V, -2.5 * px, x + p.post, yTop, 0, M.body); b.mark(-Xc, 1.5 * V, -Xc + 1.2 * px, yTop, -2.5 * px - .1, M.trim) }
  b.box(-Xc - px, yTop - 2.2 * px, -3.5 * px, Xc + px, yTop, 0, M.trim)
  // The button's bay in the base: a faceplate screwed to the wall, on it a frame, dark inside until the page's button
  // paints over it. Either side of it (over it, on a phone) the two instruments: a window each, in a thin bezel.
  const c = p.cta, f = 2.5 * px, pl = p.plate
  b.box(c.x - pl, c.y - pl, -1.2 * px, c.x + c.w + pl, c.y + c.h + pl, 0, M.body)
  for (const x of [c.x - pl * .5 - f * .5, c.x + c.w + pl * .5 + f * .5]) for (const y of [c.y - pl * .5 - f * .5, c.y + c.h + pl * .5 + f * .5]) b.cyl([x, y, 0], 2, -2.2 * px, -1.2 * px, 1.2 * px, M.steel, 8, 1)
  for (const w of p.facts) {
    const e = 1.5 * px
    b.mark(w.x, w.y, w.x + w.w, w.y + w.h, -.3, M.screen)
    b.box(w.x - e, w.y + w.h, -1.4 * px, w.x + w.w + e, w.y + w.h + e, 0, M.trim); b.box(w.x - e, w.y - e, -1.4 * px, w.x + w.w + e, w.y, 0, M.trim)
    b.box(w.x - e, w.y, -1.4 * px, w.x, w.y + w.h, 0, M.trim); b.box(w.x + w.w, w.y, -1.4 * px, w.x + w.w + e, w.y + w.h, 0, M.trim)
  }
  b.mark(c.x, c.y, c.x + c.w, c.y + c.h, -1.2 * px - .3, M.slot)
  if (p.tally) { const t = p.tally, e = 1.2 * px; b.box(t.x - e, t.y - e, t.z - px, t.x + t.w + e, t.y + t.h + e, t.z, M.steel); b.mark(t.x, t.y, t.x + t.w, t.y + t.h, t.z - px - .1, M.screen) }
  b.box(c.x - f, c.y + c.h, -3.2 * px, c.x + c.w + f, c.y + c.h + f, 0, M.trim); b.box(c.x - f, c.y - f, -3.2 * px, c.x + c.w + f, c.y, 0, M.trim)
  b.box(c.x - f, c.y, -3.2 * px, c.x, c.y + c.h, 0, M.trim); b.box(c.x + c.w, c.y, -3.2 * px, c.x + c.w + f, c.y + c.h, 0, M.trim)

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
  const lower = phone(p) ? 0 : 1.7 * V, zBlock = p.zProud, lean = DX * zBlock
  for (const [y0, y1] of [[yMan, yMan + p.manifold], ...(lower ? [[yWall - .3 * V, yWall + lower]] : [])]) {
    b.box(-Xc - px, y0, -5 * px, Xc + px, y1, 0, M.trim)
    for (let x = -Xw + 1.5 * U; x < Xw; x += 3 * U) b.cyl([x, (y0 + y1) / 2, 0], 2, -6.2 * px, -5 * px, 1.25 * px, M.steel, 8, 1)
    // At each end it stands out past the tubes, which go into it: a block the width of the four, bolted at its corners.
    // (Its front is seen `lean` to the right of where it stands: it is kept clear of the frame on the left and the
    // post on the right. The lower one goes on past the cabinet's corner to the riser.)
    for (const s of [-1, 1]) {
      const round = lower && y0 !== yMan
      const x0 = s < 0 ? (round ? -Xc - p.riser - .2 * U : -Xc + p.post + .1 * U) : Xw + .12 * U, x1 = s < 0 ? -Xw - .12 * U - lean : round ? Xc + p.riser + .2 * U : Xc - p.post - .1 * U - lean
      b.box(x0, y0, zBlock, x1, y1, 0, M.trim)
      if (!phone(p)) for (const x of [x0 + .7 * U, x1 - .7 * U]) b.cyl([x, (y0 + y1) / 2, 0], 2, zBlock - 1.1 * px, zBlock, 1.25 * px, M.steel, 8, 1)
    }
  }
  if (!lower) b.box(-Xc - px, yWall - 1.5 * px, -3 * px, Xc + px, yWall + 1.5 * px, 0, M.trim)
  b.mark(-Xc, ySlot, Xc, yCav, 0, M.body)
  for (const x of lanes) b.mark(x - .46 * P, ySlot + .14 * p.slot, x + .46 * P, ySlot + .86 * p.slot, -.2, M.plinth)
  b.mark(-Xc, yCav, -Xw, yFas, 0, M.body); b.mark(Xw, yCav, Xc, yFas, 0, M.body); b.mark(-Xc, yFas, Xc, yTop, 0, M.body)
  // The works' bay: back wall, floor and the one side wall that is seen, with a frame round the opening.
  b.quad([-Xw, yCav, cavD], [Xw, yCav, cavD], [Xw, yFas, cavD], [-Xw, yFas, cavD], M.dark, [0, 0, -1])
  b.quad([-Xw, yCav, 0], [Xw, yCav, 0], [Xw, yCav, cavD], [-Xw, yCav, cavD], M.bay, [0, 1, 0])
  b.quad([Xw, yCav, 0], [Xw, yCav, cavD], [Xw, yFas, cavD], [Xw, yFas, 0], M.bay, [-1, 0, 0])
  // Ribs up the bay's back wall, a lane apart, and a skirting where it meets the floor.
  for (let i = 1; i < 7; i++) b.box((i - 3.5) * P - px, yCav, cavD - 2 * px, (i - 3.5) * P + px, yFas - 5 * px, cavD, M.bay)
  b.box(-Xw, yCav, cavD - 3 * px, Xw, yCav + 3 * px, cavD, M.bay)
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
  const screwX = Xc - (p.post ? p.post / 2 : .65 * U)
  for (const y of [yFas + V, yTop - 1.4 * V, ...(p.post ? [yMan - 2 * V, yWall + 3 * V, yBand + p.band / 2] : [])]) for (const x of [-screwX, screwX]) b.cyl([x, y, 0], 2, -3.7 * px, -2.5 * px, 1.3 * px, M.steel, 8, 1)

  // The roof: a kerb round it, seams, a laser's pedestal at each end, a slot scams leave by each side of the hopper, a beacon.
  b.box(-Xc, yTop, 0, Xc, yTop + 2 * px, 2.5 * px, M.trim); b.box(-Xc, yTop, D - 2.5 * px, Xc, yTop + 2 * px, D, M.trim)
  b.box(-Xc, yTop, 2.5 * px, -Xc + 2.5 * px, yTop + 2 * px, D - 2.5 * px, M.trim); b.box(Xc - 2.5 * px, yTop, 2.5 * px, Xc, yTop + 2 * px, D - 2.5 * px, M.trim)
  for (const x of [-Xw, Xw]) b.quad([x - .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, D - 2.5 * px], [x - .5 * px, yTop + .1, D - 2.5 * px], M.line, [0, 1, 0])
  b.quad([-Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 + .5 * px], [-Xw, yTop + .1, D * .5 + .5 * px], M.line, [0, 1, 0])
  const vents: V3[] = [[-Xw * .84, yTop + 13 * px, D * .7], [Xw * .88, yTop + 13 * px, D * .66]]
  // The lasers stand on brackets at the roof's front corners, ahead of the front and (where the page is wide) out
  // past the side: whatever they fire at, in front of the machine, beside it or over it, the beam is clear of it.
  const tz = -5 * px, turrets: V3[] = [-1, 1].map(s => [s * (p.phone ? Xc - 2.4 * U : Xc + 1.15 * U), yTop + 16 * px, tz]), ejects: V3[] = [-1, 1].map(s => [s * Xw * .6, yTop + 5 * px, zL])
  turrets.forEach((t, k) => {
    const s = k ? 1 : -1, in0 = s * (p.phone ? Xc - 4.2 * U : Xc - 1.6 * U), out0 = t[0] + s * 1.05 * U, a = Math.min(in0, out0), e = Math.max(in0, out0)
    b.box(a, yTop + 2 * px, tz - 6 * px, e, yTop + 4.4 * px, 7 * px, M.trim, ALL)
    for (const x of [in0 + s * .6 * U, in0 + s * 1.5 * U]) b.cyl([x, 0, 3.4 * px], 1, yTop + 4.4 * px, yTop + 5.4 * px, 1.2 * px, M.steel, 8, 2)
    // (Under what overhangs the side, a gusset against the wall.)
    if (!p.phone) b.prism(ccw([[s * Xc, yTop + 2 * px], [out0, yTop + 2 * px], [s * Xc, yTop - 1.9 * U]]), -1.4 * px, 0, M.trim, 'fks', M.steel)
    b.cyl([t[0], 0, tz], 1, yTop + 4.4 * px, yTop + 6.4 * px, 5.6 * px, M.trim, 16, 2); b.cyl([t[0], 0, tz], 1, yTop + 6.4 * px, yTop + 16 * px, 3.2 * px, M.steel, 12, 2)
  })
  for (const e of ejects) {
    b.box(e[0] - .62 * lw, yTop, zL - 6 * px, e[0] + .62 * lw, yTop + 5 * px, zL + 6 * px, M.steel)
    b.quad([e[0] - .54 * lw, yTop + 5 * px + .1, zL - 2 * px], [e[0] + .54 * lw, yTop + 5 * px + .1, zL - 2 * px], [e[0] + .54 * lw, yTop + 5 * px + .1, zL + 2 * px], [e[0] - .54 * lw, yTop + 5 * px + .1, zL + 2 * px], M.slot, [0, 1, 0])
  }
  const beacon: V3 = [Xc - 3 * U, yTop + 12 * px, D * .82]
  b.cyl([beacon[0], 0, beacon[2]], 1, yTop, yTop + 8 * px, 1.2 * px, M.steel, 8, 0); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 8 * px, yTop + 9.5 * px, 3.6 * px, M.trim, 12, 2); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14 * px, 2.8 * px, M.lampOff, 12, 2)
  // Each laser's cable runs back to a junction box by the kerb.
  turrets.forEach((t, k) => { const s = k ? 1 : -1, x = s * (Xc - (p.phone ? 3 : 2.6) * U); b.tube([[x, yTop + 1.4 * px, 7 * px], [x, yTop + 1.4 * px, D * .52], [x - s * 2.2 * U, yTop + 1.4 * px, D * .52]], 1.3 * px, M.rubber, 6, 5 * px); b.box(x - s * 2.2 * U - 4 * px, yTop, D * .52 - 4 * px, x - s * 2.2 * U + 4 * px, yTop + 4 * px, D * .52 + 4 * px, M.plinth) })
  // What the hopper and the chimneys stand over: holes, seen once they are gone.
  b.quad([-lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL + lw * .26], [-lw * .5, yTop + .15, zL + lw * .26], M.slot, [0, 1, 0])
  for (const v of vents) b.cyl([v[0], 0, v[2]], 1, yTop + .1, yTop + .2, 3.6 * px, M.slot, 12, 2)

  // The roller line and, under it, a chute for each lane: two plates that lean together.
  const rr = P / 8 * .4, yR = yCav + p.cavity * .4, z0 = zL - 12 * px, z1 = zL + 12 * px, rideY = yR + rr + lh / 2, scanY = Math.min(yFas - lh / 2 - 8 * px, rideY + lh * .92)
  for (const x of lanes) for (const s of [-1, 1]) b.prism(ccw([[x + s * .48 * P, yR - rr - 3 * px], [x + s * .48 * P - s * 1.6 * px, yR - rr - 3 * px], [x + s * .4 * P - s * 1.6 * px, yCav], [x + s * .4 * P, yCav]]), z0, z1, M.trim, 'fs')
  for (let i = 0; i <= 7; i++) { const x = (i - 3.5) * P; b.box(x - .16 * P, yR - rr - 4.5 * px, z0 - 1.5 * px, x + .16 * P, yR - rr * .2, z0, M.plinth); b.box(x - .16 * P, yR - rr - 4.5 * px, z1, x + .16 * P, yR - rr * .2, z1 + 1.5 * px, M.plinth) }
  // The scanner hangs from the bay's ceiling over the middle lane.
  b.box(-lw * .6, yFas - 6 * px, zL - 7 * px, lw * .6, yFas, zL + 7 * px, M.steel); b.mark(-lw * .5, yFas - 6 * px - .1, lw * .5, yFas - 4.5 * px, zL - 7 * px - .1, M.red)

  // The tubes' fittings on the front: a socket in each manifold, a dark channel behind each run, and brackets that
  // hold each four to the wall (a bar across them, bolted between). One length of bracket, round the tube the burst
  // will tear out, is that tube's own.
  const yLow = lower ? yWall + lower : r + px, bentTube = 5, bentY = yLow + (yMan - yLow) * .42
  const sockets: number[] = []
  for (const x of p.tubes) {
    b.mark(x - r - px, lower ? yLow : yWall + 1.5 * px, x + r + px, yMan, -.15, M.dark)
    if (!lower) b.mark(x - r - px, 1.5 * V, x + r + px, yWall - 1.5 * px, -.15, M.slot)
    b.cyl([x, 0, zt], 1, yMan - 2.8 * px, yMan, r + 1.4 * px, M.steel, 14, 0)
    if (lower) sockets.push(x)
  }
  const pitch = Math.abs(p.tubes[1] - p.tubes[0]), bracketH = phone(p) ? 1.2 * px : 1.5 * px, zB = zt - r - 1.2 * px, reach = r + 1.5 * px, ahead = DX * (zB - zt)
  const bracketY: number[] = []
  if (lower) { const n = 3; for (let i = 1; i <= n; i++) bracketY.push(yLow + (yMan - yLow) * i / (n + 1)) }
  else { for (let y = yMan - 8 * V; y > yWall + 4 * V; y -= 10 * V) bracketY.push(y); bracketY.push(yBand + p.band * .5, p.base * .5) }
  // (A bracket's face is seen a little to the right of the tubes it holds: it is set back by as much, and ends at the
  // tubes.)
  const bracket = (x0: number, x1: number, y: number) => b.box(x0 - ahead, y - bracketH, zB, x1 - ahead, y + bracketH, 0, M.trim)
  for (const y of bracketY) for (const first of [0, 4]) {
    const a = Math.min(p.tubes[first], p.tubes[first + 3]) - reach, e = Math.max(p.tubes[first], p.tubes[first + 3]) + reach
    if (first === 4 && lower && y > bentY) { bracket(a, p.tubes[bentTube] - pitch / 2, y); bracket(p.tubes[bentTube] + pitch / 2, e, y) } else bracket(a, e, y)
    if (!phone(p)) for (let k = 0; k < 3; k++) b.cyl([p.tubes[first] + (first ? 1 : -1) * (k + .5) * pitch - ahead, y, 0], 2, zB - .8 * px, zB, .9 * px, M.steel, 6, 1)
  }

  // Where the tubes cross the slab. A wide page: the lower manifold's block goes on round each corner of the cabinet;
  // a riser comes down from it to a header on the slab, a trunk with a flanged outlet for each tube in its front
  // (block, riser and header are one face); each tube runs straight forward from its outlet over a sleeper, held to
  // it by a U-bolt, and over the lip. A phone: the tubes come down the front and cross the slab over one sleeper.
  // Where a tube turns down over the lip it wears a collar.
  const yc = r + 3.5 * px, seat = yc - r
  const strap = (x: number, z: number) => { const w = r + 1.3 * px, path: V3[] = [[x - w, 0, z], [x - w, yc, z]]; for (let i = 1; i < 8; i++) { const a = Math.PI - i / 8 * Math.PI; path.push([x + Math.cos(a) * w, yc + Math.sin(a) * w, z]) } path.push([x + w, yc, z], [x + w, 0, z]); b.tube(path, 1.1 * px, M.steel, 6, .5 * px) }
  const shade = (x: number, z0: number, z1: number) => b.quad([x - r - .3 * (yc + r), .12, z0 + .69 * yc], [x + r - .3 * yc, .12, z0 + .69 * yc], [x + r - .3 * yc, .12, z1], [x - r - .3 * (yc + r), .12, z1], M.slab, [0, -1, 0])
  const sleeperZ = p.fan.length ? (p.heads[0].z0 + p.zLip) / 2 - .6 * U : (zt + p.zLip) / 2
  p.heads.forEach((head, side) => {
    const s = side ? 1 : -1
    b.box(head.x0, 0, head.z0, head.x1, head.h, head.z1, M.trim)
    b.box(head.x0 - px, 0, head.z0 - px, head.x1 + px, 1.8 * px, head.z1, M.plinth)
    b.box(head.x0 + 2 * px, head.h, head.z0 + 2 * px, head.x1 - 2 * px, head.h + 1.2 * px, head.z1 - 2 * px, M.body)
    // The riser, from the header up to the block that came round the corner.
    const rx0 = s < 0 ? -Xc - p.riser - .2 * U : Xc + .2 * U
    b.box(rx0, head.h, zBlock, rx0 + p.riser, yWall + lower, zBlock + 3 * U, M.trim)
    for (const y of [head.h + 1.2 * U, yWall - 1.4 * U]) b.cyl([rx0 + p.riser / 2, y, 0], 2, zBlock - 1.1 * px, zBlock, 1.25 * px, M.steel, 8, 1)
    const xs = [0, 1, 2, 3].map(k => p.fan[side * 4 + k].x), a = Math.min(...xs), e = Math.max(...xs)
    for (const x of xs) { b.cyl([x, yc, 0], 2, head.z0 - 2.6 * px, head.z0, r + 2 * px, M.steel, 16, 1); b.cyl([x, yc, 0], 2, head.z0 - 4.8 * px, head.z0 - 2.6 * px, r + 1 * px, M.steel, 14, 0) }
    for (let x = head.x0 + 1.6 * U; x < head.x1 - U; x += 3.2 * U) if (xs.every(at => Math.abs(at - x) > r + 4 * px) && (x < rx0 - U || x > rx0 + p.riser + U)) b.cyl([x, head.h - .9 * U, 0], 2, head.z0 - 1.1 * px, head.z0, 1.2 * px, M.steel, 8, 1)
    b.box(a - 1.9 * U, 0, sleeperZ - .8 * U, e + 1.9 * U, seat, sleeperZ + .8 * U, M.plinth); for (const x of xs) strap(x, sleeperZ)
    for (const x of xs) b.cyl([x, 0, p.zOver], 1, -p.lip * .5 - 1.4 * px, -p.lip * .5 + 1.4 * px, r + 1.2 * px, M.steel, 14, 3)
    // (Glass throws no shadow in the renderer's map; what each tube throws on the slab is laid there: a strip in the
    // slab's shade, to the left of the tube and behind it, as the light falls.)
    for (const x of xs) shade(x, p.zLip + 1, head.z0)
  })
  if (!p.fan.length) for (const first of [0, 4]) {
    const shift = DX * (zt - sleeperZ), xs = [0, 1, 2, 3].map(k => p.tubes[first + k] + shift), a = Math.min(...xs), e = Math.max(...xs)
    b.box(a - 1.2 * U, 0, sleeperZ - .7 * U, e + 1.2 * U, seat, sleeperZ + .7 * U, M.plinth)
    // (Four tubes this close share one strap: a flat bar over them, bolted to the sleeper at each end and between.)
    b.box(a - 1.1 * U, yc + r, sleeperZ - .45 * U, e + 1.1 * U, yc + r + 1.1 * px, sleeperZ + .45 * U, M.steel, ALL)
    for (const x of [a - 1.1 * U, e + .75 * U]) b.box(x, seat, sleeperZ - .45 * U, x + .35 * U, yc + r, sleeperZ + .45 * U, M.steel)
    for (const x of [a - .75 * U, a + (e - a) / 3, a + (e - a) * 2 / 3, e + .75 * U]) b.cyl([x, 0, sleeperZ], 1, yc + r + 1.1 * px, yc + r + 2 * px, .9 * px, M.trim, 6, 2)
    for (let k = 0; k < 4; k++) b.cyl([p.tubes[first + k] + DX * (zt - p.zOver), 0, p.zOver], 1, -p.lip * .5 - 1.2 * px, -p.lip * .5 + 1.2 * px, r + 1 * px, M.steel, 12, 3)
  }

  // The send cannon, the sending half of the machine: a pneumatic gun. What is to be sent comes up the page in the
  // outbound tube and over the slab's lip as the eight lanes go down over it. On a wide page it then turns along
  // the front of the cabinet and goes into the trunk at the foot of the right riser; out of the trunk's back a tube
  // runs across the slab into the chest the gun stands on, and a glass feed goes up from the chest into the breech.
  // On a phone the tube goes into the cabinet's base, and the feed comes up through the roof under the gun. The gun
  // fires what reaches it off the page as a letter. A chest (or a plate) bolted down, two cheeks, and between them
  // a cradle the barrel slides back through as it fires. The barrel and the cradle are parts of their own, built
  // lying level and turned to the gun's elevation by their pose.
  const C = p.cannon, cu = C.cs, cz = C.z, pivot: V3 = [C.x, C.y + C.pivot, cz], ce = Math.cos(C.el), se = Math.sin(C.el), cr = C.r, cheek = cr + 2.2 * px
  const along = (a: number, c = 0): V3 => [pivot[0] + a * ce - c * se, pivot[1] + a * se + c * ce, cz]
  const kink = along(-C.back - 1.6 * cu), baseTop = C.y + C.chest, x0 = kink[0] - 1.7 * cu, x1 = C.x + 3.4 * cu, chestZ = cz - cheek - 1.1 * cu
  b.box(x0, C.y, chestZ, x1, baseTop, cz + cheek + 1.1 * cu, M.plinth)
  if (!p.phone) { b.box(x0 - px, C.y, chestZ - px, x1 + px, C.y + 1.8 * px, cz + cheek + 1.1 * cu, M.trim); b.box(x0 - px, baseTop - 1.6 * px, chestZ - px, x1 + px, baseTop, cz + cheek + 1.1 * cu, M.trim) }
  for (const x of [x0 + .6 * cu, x1 - .6 * cu]) for (const z of [cz - cheek - .55 * cu, cz + cheek + .55 * cu]) b.cyl([x, 0, z], 1, baseTop, baseTop + 1.1 * px, 1.4 * px, M.steel, 8, 2)
  // (The cheeks stand a little over the barrel's middle, so the far one's top edge is seen behind it.)
  for (const z of [cz - cheek - 2.4 * px, cz + cheek]) b.prism(ccw([[C.x - 2.5 * cu, baseTop], [C.x + 2.9 * cu, baseTop], [C.x + .95 * cu, pivot[1] + .95 * cu], [C.x - .95 * cu, pivot[1] + .95 * cu]]), z, z + 2.4 * px, M.trim, 'fks', M.steel)
  // A ring round a tube where it goes through something: a low steel wall and, on top, a flat ring the tube passes
  // through (not a disc over it).
  const collar = (x: number, y: number, z: number, h: number, out = r + 1.8 * px) => {
    b.cyl([x, 0, z], 1, y, y + h, out, M.steel, 16, 0)
    for (let i = 0; i < 16; i++) { const a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2; b.quad([x + Math.cos(a0) * r, y + h, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y + h, z + Math.sin(a1) * r], [x + Math.cos(a1) * out, y + h, z + Math.sin(a1) * out], [x + Math.cos(a0) * out, y + h, z + Math.sin(a0) * out], M.steel, [0, 1, 0]) }
  }
  // The feed tube: out of the chest through a collar, and round into the breech.
  collar(kink[0], baseTop, cz, 2.2 * px)
  // The outbound tube's fittings: its collar at the lip, as the others wear; then (wide) two saddles under its run
  // along the cabinet's front, its flange in the trunk, and behind the trunk the tube to the chest: a strap over it,
  // a flange where it goes in; or (a phone) its flange in the cabinet's base.
  const outX = p.out - DX * p.zOver, zJ = p.zLip * .46, trunk = p.heads[1], portX = Xc + .2 * U + p.riser / 2
  const flange = (x: number, z: number) => { b.cyl([x, yc, 0], 2, z - 2.6 * px, z, r + 2 * px, M.steel, 16, 1); b.cyl([x, yc, 0], 2, z - 4.8 * px, z - 2.6 * px, r + 1 * px, M.steel, 14, 0) }
  b.cyl([outX, 0, p.zOver], 1, -p.lip * .5 - 1.4 * px, -p.lip * .5 + 1.4 * px, r + 1.2 * px, M.steel, 14, 3)
  // (Where the outbound tube goes in it wears a square plate, bolted at its corners: in is not out.)
  const inlet = (x: number, z: number) => { const w = r + 3.4 * px, top = yc + w; b.box(x - w, .4, z - 1.8 * px, x + w, top, z, M.steel); for (const bx of [x - w + 1.5 * px, x + w - 1.5 * px]) for (const by of [1.9 * px, top - 1.5 * px]) b.cyl([bx, by, 0], 2, z - 2.8 * px, z - 1.8 * px, .9 * px, M.trim, 6, 1); b.cyl([x, yc, 0], 2, z - 3.6 * px, z - 1.8 * px, r + 1 * px, M.trim, 14, 0) }
  if (trunk) {
    inlet(portX, trunk.z0)
    for (const f of [.3, .72]) { const x = outX + (portX - outX) * f; b.box(x - .8 * U, 0, zJ - r - 1.5 * px, x + .8 * U, seat, zJ + r + 1.5 * px, M.plinth); b.box(x - .25 * U, seat, zJ - r - 1.5 * px, x + .25 * U, yc + r + 1.2 * px, zJ - r - .2 * px, M.steel); b.box(x - .25 * U, seat, zJ + r + .2 * px, x + .25 * U, yc + r + 1.2 * px, zJ + r + 1.5 * px, M.steel); b.box(x - .25 * U, yc + r, zJ - r - 1.5 * px, x + .25 * U, yc + r + 1.2 * px, zJ + r + 1.5 * px, M.steel, ALL) }
    shade(outX, p.zLip + 1, zJ - r); shade(portX, zJ + r, trunk.z0)
    b.quad([outX - .3 * yc, .12, zJ - r + .69 * yc], [portX - .3 * yc, .12, zJ - r + .69 * yc], [portX - .3 * yc, .12, zJ + r + .69 * yc], [outX - .3 * yc, .12, zJ + r + .69 * yc], M.slab, [0, -1, 0])
    flange(kink[0], chestZ - px); strap(kink[0], (trunk.z1 + chestZ) / 2 + 1.2 * U); shade(kink[0], trunk.z1, chestZ - px)
  } else inlet(outX, -3 * px)
  for (const x of sockets) collar(x, yLow, zt, 2.6 * px, r + 1.4 * px)

  // Two relief valves on the columns beside the works, of the kind a boiler has: a body on a flange, fed from the
  // manifold below, a nozzle up, and a weighted lever that the pressure lifts. Under the right one, the recess a
  // service panel covers.
  const vs = p.phone ? .58 * U : U, colX = (Xw + 2 * px + Xc - p.post) / 2, valveY = yCav + p.cavity * .62, vz = -3.4 * px
  const valves = [-1, 1].map(side => ({ side, x: side * colX, y: valveY, nozzle: [side * colX, valveY + 2.2 * vs, vz] as V3 }))
  for (const v of valves) {
    b.cyl([v.x, 0, vz], 1, ySlot, v.y, .3 * vs, M.steel, 10, 0)
    b.cyl([v.x, 0, vz], 1, ySlot, ySlot + .5 * vs, .5 * vs, M.trim, 10, 2)
    b.cyl([v.x, v.y, 0], 2, -1.6 * px, 0, 1.15 * vs, M.trim, 18, 1)
    b.cyl([v.x, v.y, 0], 2, vz - .78 * vs * .4, -1.6 * px, .8 * vs, M.steel, 16, 1)
    b.cyl([v.x, 0, vz], 1, v.y + .6 * vs, v.y + 1.9 * vs, .4 * vs, M.steel, 10, 0)
    b.cyl([v.x, 0, vz], 1, v.y + 1.9 * vs, v.y + 2.2 * vs, .56 * vs, M.trim, 12, 2, M.slot)
  }
  const panel = { x0: Xw + (p.phone ? .5 : .7) * U, x1: colX - (p.phone ? .55 : 1.6) * vs, y0: yCav + p.cavity * .1, y1: yCav + p.cavity * .4 }, panelX = (panel.x0 + panel.x1) / 2
  b.mark(panel.x0 + px, panel.y0 + px, panel.x1 - px, panel.y1 - px, -.15, M.slot)
  b.mark(panel.x0 + px, panel.y0 + px, panel.x1 - px, panel.y0 + 2.2 * px, -.2, M.bay)

  // ── Parts ──
  const idx = { glass: 0, tubes: 0, soot: 0, shards: 0, hole: 0, bent: 0, bentHeld: 0, barrel: 0, cradle: 0, needle: 0, turrets: [] as number[], scan: 0, hopper: 0, hatch: 0, panel: 0, beaconOn: 0, levers: [] as number[], vents: [] as number[], panes: [] as number[], cracks: [] as number[], lamps: [] as number[], flaps: [] as number[], rollers: [] as number[], caps: [] as number[], bolts: [] as number[] }

  idx.needle = b.part('needle', [ga.x, ga.y, 0])
  b.prism(ccw([[ga.x - 1.1 * px, ga.y - ga.r * .22], [ga.x + 1.1 * px, ga.y - ga.r * .22], [ga.x + .4 * px, ga.y + ga.r * .8], [ga.x - .4 * px, ga.y + ga.r * .8]]), -4.8 * px, -4.4 * px, M.ink, 'f')
  b.cyl([ga.x, ga.y, 0], 2, -5.6 * px, -4.4 * px, 2.2 * px, M.steel, 12, 1)

  lampX.forEach((x, i) => { idx.lamps.push(b.part(`lamp${i}`)); b.cyl([x, ga.y, 0], 2, -2.7 * px, -2.5 * px, lampR, i === 0 ? M.red : M.lampOn, 14, 1) })
  idx.beaconOn = b.part('beacon'); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14.2 * px, 3 * px, M.red, 12, 2)

  // The lasers: a barrel in a yoke, cooling rings round it, a red lens. Round, so it looks right aimed any way.
  turrets.forEach((t, k) => {
    idx.turrets.push(b.part(`turret${k}`, t))
    b.cyl([0, t[1], t[2]], 0, t[0] - 8 * px, t[0] + 17 * px, 4.4 * px, M.plinth, 14, 1)
    b.cyl([0, t[1], t[2]], 0, t[0] + 17 * px, t[0] + 22 * px, 3.4 * px, M.steel, 12, 2, M.red)
    b.cyl([0, t[1], t[2]], 0, t[0] - 10.5 * px, t[0] - 8 * px, 3.4 * px, M.trim, 12, 1)
    for (let i = 0; i < 4; i++) b.cyl([0, t[1], t[2]], 0, t[0] - 5 * px + i * 4.4 * px, t[0] - 3.2 * px + i * 4.4 * px, 6.2 * px, M.trim, 14, 3)
    b.cyl([t[0], t[1], 0], 2, t[2] - 6.4 * px, t[2] + 6.4 * px, 2.6 * px, M.steel, 10, 3)
  })

  idx.scan = b.part('scan', [0, scanY, zL]); b.mark(-lw * .56, scanY - .7 * px, lw * .56, scanY + .7 * px, zL - 2.5 * px, M.red)

  // The hopper: a funnel of four plates on a collar, its front lower than its back so the letters are seen going in.
  const hh = p.hopper * .82, ht = lw * 1.3, hb = lw * .62, hd = lw * .36, t = 1.3 * px
  idx.hopper = b.part('hopper', [0, yTop + hh / 2, zL])
  b.prism(ccw([[-hb, yTop], [hb, yTop], [ht, yTop + hh], [-ht, yTop + hh]]), zL + hd, zL + hd + t, M.trim, 'fks', M.steel)
  for (const s of [-1, 1]) b.prism(ccw([[s * hb, yTop], [s * (hb + t), yTop], [s * (ht + t), yTop + hh], [s * ht, yTop + hh]]), zL - hd, zL + hd, M.trim, 'fks', M.steel)
  b.prism(ccw([[-hb, yTop], [hb, yTop], [hb + (ht - hb) * .62, yTop + hh * .62], [-hb - (ht - hb) * .62, yTop + hh * .62]]), zL - hd - t, zL - hd, M.steel, 'fks', M.trim)
  b.box(-hb - 3 * px, yTop, zL - hd - 3 * px, hb + 3 * px, yTop + 2.4 * px, zL + hd + 3 * px, M.plinth, ALL)

  // The chimneys and the hatch: on the roof until the burst. (The hatch's hinge: two knuckles on the roof at its back edge.)
  b.part('static2')
  for (const x of [-Xw * .41, -Xw * .19]) b.cyl([0, yTop + 2.6 * px, D * .89], 0, x - 3.4 * px, x + 3.4 * px, 3.1 * px, M.steel, 10, 3)
  vents.forEach((v, i) => { idx.vents.push(b.part(`vent${i}`, [v[0], yTop + 6 * px, v[2]])); b.cyl([v[0], 0, v[2]], 1, yTop, yTop + 11 * px, 4.5 * px, M.steel, 14, 1); b.cyl([v[0], 0, v[2]], 1, yTop + 11 * px, yTop + 13 * px, 6 * px, M.trim, 14, 3, M.slot) })
  idx.hatch = b.part('hatch', [-Xw * .3, yTop + px, D * .76])
  b.box(-Xw * .46, yTop, D * .64, -Xw * .14, yTop + 4.4 * px, D * .88, M.steel, ALL, M.body); b.box(-Xw * .33, yTop + 4.4 * px, D * .73, -Xw * .27, yTop + 6.2 * px, D * .79, M.steel, ALL)
  // (Its underside, seen once it is thrown back: the cabinet's steel, sooted at its middle, two ribs across it.)
  b.quad([-Xw * .46, yTop - .05, D * .64], [-Xw * .14, yTop - .05, D * .64], [-Xw * .14, yTop - .05, D * .88], [-Xw * .46, yTop - .05, D * .88], M.trim, [0, -1, 0])
  b.quad([-Xw * .4, yTop - .12, D * .69], [-Xw * .2, yTop - .12, D * .69], [-Xw * .2, yTop - .12, D * .83], [-Xw * .4, yTop - .12, D * .83], M.plinth, [0, -1, 0])
  for (const z of [D * .7, D * .82]) b.box(-Xw * .45, yTop - 1.4 * px, z - .7 * px, -Xw * .15, yTop - .1, z + .7 * px, M.steel, ALL)

  // The cannon's barrel: a reinforced breech with the feed tube's coupling behind it, a chase that tapers a little, two
  // bands and a muzzle swell. And its cradle: a sleeve round the barrel, on the trunnions the cheeks carry.
  idx.barrel = b.part('barrel', pivot)
  { const [x, y] = pivot, ring = (a0: number, a1: number, r0: number, mat: number, r1 = r0, caps = 3) => b.cyl([0, y, cz], 0, x + a0, x + a1, r0, mat, 16, caps, mat, r1)
    ring(-C.back, -C.back + .3 * (C.back + C.fore), cr + 1.5 * px, M.trim); ring(-C.back + .3 * (C.back + C.fore), C.fore, cr + .6 * px, M.trim, cr - .3 * px)
    ring(-C.back - 1.6 * px, -C.back + 1.4 * px, cr + 3 * px, M.steel); ring(-C.back - 4.2 * px, -C.back - 1.6 * px, r + 2.4 * px, M.steel)
    for (const a of [-C.back + .3 * (C.back + C.fore), C.fore * .56]) ring(a - 1.1 * px, a + 1.1 * px, cr + 2.6 * px, M.steel)
    ring(C.fore - 4.4 * px, C.fore, cr + 2.4 * px, M.steel); b.cyl([0, y, cz], 0, x + C.fore, x + C.fore + .7, C.bore - .6 * px, M.slot, 16, 2, M.slot); ring(C.fore - 6 * px, C.fore - 4.4 * px, cr + 1.2 * px, M.steel, cr + 2.4 * px, 0) }
  idx.cradle = b.part('cradle', pivot)
  b.cyl([0, pivot[1], cz], 0, pivot[0] - .75 * cu, pivot[0] + .75 * cu, cr + 3.4 * px, M.plinth, 16, 3, M.plinth)
  b.cyl([0, pivot[1], cz], 0, pivot[0] - .24 * cu, pivot[0] + .24 * cu, cr + 4.4 * px, M.steel, 16, 3)
  b.cyl([pivot[0], pivot[1], 0], 2, cz - cheek - 4.6 * px, cz + cheek + 4.6 * px, .36 * cu, M.steel, 12, 3)

  // The valves' levers, hinged on the body's centre, and the service panel on its four screws.
  for (const v of valves) {
    idx.levers.push(b.part(`lever${idx.levers.length}`, [v.x, v.y, vz]))
    const z0 = vz - .78 * vs * .4 - 1.4 * px, z1 = z0 + 1.2 * px, tip = v.x + v.side * 2.3 * vs
    b.box(Math.min(v.x - v.side * .3 * vs, tip), v.y - .15 * vs, z0, Math.max(v.x - v.side * .3 * vs, tip), v.y + .15 * vs, z1, M.trim, ALL)
    b.box(Math.min(tip - v.side * .75 * vs, tip), v.y - .78 * vs, z0 - .6 * px, Math.max(tip - v.side * .75 * vs, tip), v.y - .15 * vs, z1 + .6 * px, M.steel, ALL)
    b.cyl([v.x, v.y, 0], 2, z0 - 1.2 * px, z0, .34 * vs, M.steel, 10, 1)
  }
  idx.panel = b.part('panel', [panelX, (panel.y0 + panel.y1) / 2, -.7 * px])
  b.box(panel.x0, panel.y0, -1.4 * px, panel.x1, panel.y1, 0, M.plinth, ALL)
  for (const x of [panel.x0 + 2.2 * px, panel.x1 - 2.2 * px]) for (const y of [panel.y0 + 2.2 * px, panel.y1 - 2.2 * px]) b.cyl([x, y, 0], 2, -2.2 * px, -1.4 * px, .9 * px, M.steel, 8, 1)
  b.box(panelX - .9 * px, (panel.y0 + panel.y1) / 2 - .9 * vs, -2.6 * px, panelX + .9 * px, (panel.y0 + panel.y1) / 2 + .9 * vs, -1.4 * px, M.trim, ALL)

  // Rollers: eight to a lane, the middle four on that lane's drop gate. Each has a mark on its end so its turning shows.
  const rollerLane: number[] = [], rollerHome: V3[] = []
  for (let j = 0; j < 56; j++) {
    const x = lanes[0] - P / 2 + (j + .5) * P / 8
    idx.rollers.push(b.part(`roller${j}`, [x, yR, zL])); rollerLane.push(Math.floor(j / 8)); rollerHome.push([x, yR, zL])
    b.parts[b.parts.length - 1].plain = true
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
  for (let i = 0; i < 28; i++) { idx.caps.push(b.part(`cap${i}`)); b.cyl([0, 0, 0], 1, -capH, capH, capR, M.paper, 8, 0); b.cyl([0, 0, 0], 1, capH, capH + capR * .7, capR, M.brand, 8, 2); b.cyl([0, 0, 0], 1, -capH - capR * .7, -capH, capR, M.paper, 8, 1) }
  for (const [x, y] of [[-Xw - px, yFas + px], [Xw + px, yFas + px], [-Xw - px, yCav - px], [Xw + px, yCav - px], [0, yFas + px], [-Xw / 2, yCav - px], [Xw / 2, yCav - px], [-Xw / 2, yFas + px], [Xw / 2, yFas + px]] as [number, number][]) {
    idx.bolts.push(b.part(`bolt${idx.bolts.length}`, [x, y, -2.6 * px])); b.cyl([x, y, 0], 2, -3.2 * px, -2 * px, 1.5 * px, M.steel, 8, 3)
  }

  // What the burst leaves: soot and a torn hole in the roof where the hopper stood, splinters of glass in the frame.
  const ch = p.cavity
  // (Where the hopper stood the roof is torn open: an uneven hole, the sheet round it bent up and out in flaps, their
  // undersides to the hole; soot on the roof all round. Seen from the front, the far flaps show their dark undersides
  // and the near ones their backs.)
  const rim: [number, number][] = [[-1.2, -.95], [-.2, -1.1], [.95, -.9], [1.35, .1], [1.05, 1.45], [-.1, 1.7], [-1.1, 1.4], [-1.45, .2]].map(([x, z]) => [x * hb, zL + z * hd])
  const fan = (points: [number, number][], y: number, mat: number, grow = 1) => { for (let i = 0; i < points.length; i++) { const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length]; b.tri([0, y, zL + .3 * hd], [ax * grow, y, zL + .3 * hd + (az - zL - .3 * hd) * grow], [bx * grow, y, zL + .3 * hd + (bz - zL - .3 * hd) * grow], [0, 1, 0], mat) } }
  idx.soot = b.part('soot', [0, 0, 0], true)
  fan(rim, yTop + .2, M.scorch, 1.75)
  idx.hole = b.part('hole')
  fan(rim, yTop + .3, M.slot)
  rim.forEach(([ax, az], i) => {
    const [bx, bz] = rim[(i + 1) % rim.length], mx = (ax + bx) / 2, mz = (az + bz) / 2, ox = mx, oz = mz - zL - .3 * hd, l = Math.hypot(ox, oz) || 1, nx = ox / l, nz = oz / l
    // Each a torn four-sided piece standing on the hole's rim and leaning out over the roof; every other one short.
    const h = (i % 2 ? 8 : 12.5) * px, outBy = (i % 2 ? 5 : 7.5) * px, skew = (i % 3 - 1) * 2.6 * px, grow = 1.12
    const a: V3 = [ax * grow, yTop + .3, zL + .3 * hd + (az - zL - .3 * hd) * grow], c: V3 = [bx * grow, yTop + .3, zL + .3 * hd + (bz - zL - .3 * hd) * grow]
    const tip: V3 = [mx * grow + nx * outBy - nz * skew, yTop + h, zL + .3 * hd + (mz - zL - .3 * hd) * grow + nz * outBy + nx * skew], tip2: V3 = [tip[0] + (bx - ax) * .3, tip[1] - 2.6 * px, tip[2] + (bz - az) * .3]
    // Its back (the roof's own face, turned outwards and lit), its underside (to the hole, dark), and the sheet's
    // torn edge along its top, bright.
    b.quad(a, c, tip2, tip, M.body, unit([nx, .9, nz]))
    b.quad([a[0] - nx * .5, a[1], a[2] - nz * .5], [c[0] - nx * .5, c[1], c[2] - nz * .5], [tip2[0] - nx * .5, tip2[1], tip2[2] - nz * .5], [tip[0] - nx * .5, tip[1], tip[2] - nz * .5], M.plinth, [0, -1, 0])
    b.tube([tip, tip2], .55 * px, M.steel, 4)
  })
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

  // The tubes themselves. Each is one or two runs: down the front between the manifolds, and (on a wide page) from
  // its outlet in the header forward across the slab, over the lip and down. One of the front runs is its own part:
  // the burst bends it out of its socket.
  const lines: V3[][][] = [], drop = -(p.floor + 20) - DY * p.zOver
  idx.tubes = b.part('tubes', [0, 0, 0], true)
  p.tubes.forEach((x, t) => {
    if (p.fan.length) {
      const leg = p.fan[t]
      // (A capsule's way begins a capsule's length inside the block or the header it comes out of, and ends as far
      // inside the block it goes into.)
      if (t !== bentTube) b.tube([[x, yMan, zt], [x, yLow, zt]], r, M.tube, 12)
      else b.tube([[x, bentY, zt], [x, yLow, zt]], r, M.tube, 12)
      lines.push([[[x, yMan + 2 * r, zt], [x, yLow - 2 * r, zt]], [[leg.x, yc, p.heads[0].z0 + 2 * r + 2], ...b.tube([[leg.x, yc, p.heads[0].z0 - 4 * px], [leg.x, yc, p.zOver], [leg.x, drop, p.zOver]], r, M.tube, 12, r * 3)]])
    } else lines.push([[[x, yMan + 2 * r, zt], ...b.tube([[x, yMan, zt], [x, yc, zt], [x + DX * (zt - p.zOver), yc, p.zOver], [x + DX * (zt - p.zOver), drop, p.zOver]], r, M.tube, 10, r * 3)]])
  })
  // The outbound tube, a ninth, and its capsules' way up it: over the lip, along the cabinet's front and into the
  // trunk; out of the trunk's back and into the chest; up the feed and into the breech. (A phone: over the lip and
  // into the base; up the feed.)
  const feed = b.tube([[kink[0], baseTop, cz], kink, along(-C.back + 2 * px)], r, M.tube, 12, r * 1.5), feedRun: V3[] = [[kink[0], baseTop - 2 * r, cz], ...feed, along(-C.back + 3 * r)]
  if (trunk) {
    const up = b.tube([[outX, drop, p.zOver], [outX, yc, p.zOver], [outX, yc, zJ], [portX, yc, zJ], [portX, yc, trunk.z0 - 4 * px]], r, M.tube, 12, r * 2.4)
    const link = b.tube([[kink[0], yc, trunk.z1 - 2 * px], [kink[0], yc, chestZ - 4 * px]], r, M.tube, 12)
    lines.push([[...up, [portX, yc, trunk.z0 + 2 * r]], [[kink[0], yc, trunk.z1 - 2 * r], ...link, [kink[0], yc, chestZ + 2 * r]], feedRun])
  } else {
    const up = b.tube([[outX, drop, p.zOver], [outX, yc, p.zOver], [outX, yc, -6 * px]], r, M.tube, 12, r * 3)
    lines.push([[...up, [outX, yc, 2 * r]], feedRun])
  }
  idx.bent = b.part('bent', [p.tubes[bentTube], p.fan.length ? bentY : yWall, zt], true)
  if (p.fan.length) b.tube([[p.tubes[bentTube], yMan - 3 * px, zt], [p.tubes[bentTube], bentY, zt]], r, M.tube, 12)
  // The lengths of bracket that go with it.
  idx.bentHeld = b.part('bentHeld', [p.tubes[bentTube], p.fan.length ? bentY : yWall, zt])
  if (p.fan.length) for (const y of bracketY) if (y > bentY) bracket(p.tubes[bentTube] - pitch / 2, p.tubes[bentTube] + pitch / 2, y)

  const data = b.finish()
  return { data, parts: b.parts, idx, wall, lines, rollerLane, rollerHome, hinge, swing, rr, yR, rideY, scanY, z0, z1, turrets, ejects, beacon, vents, valves, panel, cannon: { pivot, ce, se }, hole: { x: 0, z: zL + .3 * hd, r: 1.5 * Math.max(hb, hd) + 7 * px }, hatchHinge: [-Xw * .3, yTop, D * .88] as V3, crackAt, ventFront: [ventX, ga.y, -3 * px] as V3, hopperTop: yTop + hh, hopperWide: ht, px }
}
const phone = (p: Plan) => p.phone
