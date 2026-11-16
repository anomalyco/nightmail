// Where everything on the sorter is, in CSS pixels, from the size of the page. The machine is drawn in one oblique
// projection: its front is a true rectangle (so the page's own text sits on it), and depth runs up the page and a
// little to the left. World x is right of the machine's middle, y is up from the floor, z is back from its front.
// The machine stands on a slab with a lip along its front; the tubes cross the slab, go over the lip and on down the
// page. The page's boxes (variant-sorter.css) are placed from these numbers; the engine builds the machine from them.
import { COLS, ROWS } from './price'

/** Depth on screen per unit of world depth. */
export const DX = -0.26, DY = 0.42

export type Rect = { x: number; y: number; w: number; h: number }
export type Plan = ReturnType<typeof plan>

export function plan(W: number, H: number) {
  // Below 900 px there is no room beside the machine for the headers and their tubes: the page is composed as a phone's is.
  const phone = W < 900
  // In cells: the unlit columns and rows round the price, the strip the tubes run down, and each floor of the machine.
  const side = phone ? 1 : 2, over = 2, under = phone ? 1 : 2, strip = phone ? 4.6 : 9.8
  const rows = phone ? { base: 30, band: 16.5, manifold: 2, slot: 3.6, cavity: 22, fascia: 12.6 } : { base: 14, band: 7.5, manifold: 2, slot: 3.4, cavity: 19, fascia: 11 }
  // The slab in front of the machine, its lip, and the page under the lip.
  const depth = phone ? 11 : 20, hopperU = phone ? 5 : 4.2, skyU = phone ? 2 : 1.5, frontU = phone ? 4.6 : 5.75, lipU = phone ? 1.6 : 2, belowU = phone ? 6.4 : 7.6
  const wallRows = ROWS + over + under, wide = 2 * (COLS / 2 + side + strip) + depth * -DX + (phone ? 1.4 : 9)
  // What holds the page's own words keeps a height they fit in, however small a cell gets.
  const sized = (U: number) => {
    // (On a narrow phone the longer fact takes two lines over the button, and the base is taller for it.)
    const V = U * 13 / 18, base = Math.max(rows.base * V, phone ? (COLS * U < 292 ? 150 : 128) : 64), fascia = Math.max(rows.fascia * V, phone ? 56 : 0), below = Math.max(belowU * U, phone ? 46 : 40)
    return { V, base, fascia, below, tall: base + fascia + (rows.band + wallRows + rows.manifold + rows.slot + rows.cavity) * V + (depth * DY + hopperU + skyU + frontU + lipU) * U + below }
  }
  // A cell is 18 wide for every 13 high, the shape of an envelope; as large as the page allows. Where the tubes fan
  // out they need room beside the cabinet too: on a narrow page the machine gives it up.
  const step = phone ? .05 : .25
  let U = Math.max(4, Math.min(12, Math.floor(W / wide / step) * step))
  while (U > 4 && (sized(U).tall > H || (!phone && W / 2 - (COLS / 2 + side + strip) * U - 26 < 4.05 * 32))) U = Math.round((U - step) / step) * step
  const { V, base, fascia, below } = sized(U)
  const Xw = (COLS / 2 + side) * U, Xc = Xw + strip * U, D = depth * U
  const band = rows.band * V, wall = wallRows * V, manifold = rows.manifold * V, slot = rows.slot * V, cavity = rows.cavity * V
  const yBand = base, yWall = yBand + band, yMan = yWall + wall, ySlot = yMan + manifold, yCav = ySlot + slot, yFas = yCav + cavity, yTop = yFas + fascia
  // Seven lanes across the works; a letter is most of a lane wide.
  const P = 2 * Xw / 7, lanes = Array.from({ length: 7 }, (_, i) => (i - 3) * P), lw = P * .7, lh = lw * .7
  const cavD = (phone ? 5.2 : 6.6) * U, zL = cavD / 2
  // Eight tubes, four each side of the price, the nearest the price first: inbox, agent inbox, endpoint, thread;
  // mailbox, ritual, campaign, logs. They run down the front between two manifolds, into a block at each end of the
  // lower one. On a wide page that block goes on round the cabinet's corner, a riser comes down from it to a header on
  // the slab beside the cabinet (`heads`: a trunk with an outlet for each tube in its front), and the tubes run
  // straight forward from the header side by side (`fan`: where each lies, and where on the page it goes over the
  // lip) and over the lip; on a phone they keep to the front, down to the floor and straight over the lip.
  // What stands out in front of the wall is seen a little to the right of where it is (depth leans): a tube's place
  // here is where it is seen.
  // (Each four stands centred in its strip, between the frame and the cabinet's corner post; a phone's cabinet has no posts.)
  const post = phone ? 0 : U, tubeR = (phone ? .42 : .85) * U, pitch = (phone ? 1.06 : 2.14) * U, first = (strip * U - post - 3 * pitch) / 2
  const front = frontU * U, lip = lipU * U, floor = front + lip + below, ox = Math.round(W / 2), oy = Math.round(H - floor)
  const zLip = -front / DY, zOver = zLip - tubeR - 3 * U / 9, zBack = D * (phone ? 1.4 : 1.5), zt = -(tubeR + 1.5 * U / 9), zProud = zt - tubeR - 4 * U / 9
  const tubes = [0, 1, 2, 3].map(k => -(Xw + first + k * pitch)).concat([0, 1, 2, 3].map(k => Xw + first + k * pitch)).map(x => x - DX * zt)
  const spread = Math.max(24, Math.min(13.5 * U, (W / 2 - Xc - 26) / 4.05))
  // A tube that runs straight forward leans across the page as depth does: the right-hand four must still come out
  // clear of the riser at the cabinet's corner, so the nearest stands at least that far out (and its twin on the left
  // the same). The header's front, the riser's and the blocks' are one plane.
  const riser = 2.4 * U, headD = 4.4 * U, headH = 2 * tubeR + 1.6 * U, clear = Math.max(.6 * spread, DX * zOver + riser + tubeR + 1.2 * U)
  const fan = phone ? [] : [0, 1, 2, 3, 4, 5, 6, 7].map(t => { const at = (t < 4 ? -1 : 1) * (Xc + clear + (t % 4) * spread); return { at, x: at - DX * zOver } })
  const heads = phone ? [] : [{ x0: fan[3].x - 2.2 * U, x1: -Xc }, { x0: Xc, x1: fan[7].x + 2.2 * U }].map(head => ({ ...head, z0: zProud, z1: zProud + headD, h: headH }))
  /** Where each tube goes over the lip, across the page from its left edge. */
  const drops = tubes.map((x, t) => ox + (phone ? x + DX * zt : fan[t].at))
  const slabX = phone ? W : Xc + clear + 4.3 * spread
  // The send cannon: the sending half. On a wide page it stands on the slab to the right of the cabinet, behind the
  // header; on a phone, on the roof at the back. `x, y, z` is where its base stands, `pivot` how high its barrel
  // turns, `el` its elevation, `cs` its unit; the letter it fires is four fifths of a sorted one. What is sent comes
  // back up the page in one more tube (`out`: where across the page, from its middle), into the slab under the
  // machine, and up a ramp out of the floor (or the roof) into the breech.
  const cs = phone ? .85 * U : 1.3 * U, el = .54, shot = { w: lw * .8, h: lh * .8 }, bore = shot.h / 2 + .2 * cs, cr = bore + .22 * cs, long = (phone ? 2.6 : 2.9) * shot.w, back = .31 * long
  const cz = phone ? D * .74 : 15 * U, pivot = back * Math.sin(el) + cr * Math.cos(el) + 1.5 * cs
  // (On a wide page it stands clear of the riser as it is seen.)
  const cannon = { x: phone ? .7 * Xw : Xc + .2 * U + riser + 12 + 5.4 * cs - DX * cz, y: phone ? yTop : 0, z: cz, pivot, el, cs, shot, bore, r: cr, back, fore: long - back }
  // (The outbound tube runs up the page behind the appliances that lean right and beside those that lean left;
  // sorter-stations.tsx places them from the same numbers.)
  const inner = 2 * (phone ? Math.min(...tubes.slice(4)) + DX * zt : Xc + clear), room = inner - 2 * (phone ? 20 : 74), widest = Math.min(446, room), lean = phone ? 0 : Math.min(46, Math.max(0, (room - widest) / 2)), boxDx = -DX * (phone ? 40 : 60)
  let out = -widest / 2 + lean + boxDx / 2 + Math.min(408, room) - (phone ? 10 : 26)
  if (!phone) for (const w of [446, 430, 420, 384]) { const edge = -widest / 2 - lean + boxDx / 2 + Math.min(w, room); if (Math.abs(out - edge) < 18) out = edge - 18 }
  // The renderer's canvas runs on this far below the hero, under the top of the next section: what the burst throws
  // past the slab falls on down the page and dwindles there, and is never cut off at the hero's edge.
  const ext = phone ? 300 : 400
  // The button, and beside it (over it, on a phone) the two facts. `tight`: too little room beside the button for the
  // longer fact on one line.
  const ctaW = Math.max(15.2 * U, 128), ctaH = Math.max(44, 7.4 * V)
  const cta: Rect = phone ? { x: -Xw + 2 * U, y: 24, w: 2 * Xw - 4 * U, h: 50 } : { x: -ctaW / 2, y: (base - ctaH) / 2, w: ctaW, h: ctaH }
  const tight = phone ? COLS * U < 292 : (2 * Xc - 4.8 * U - ctaW) / 2 < 206
  // The button's faceplate (`plate`: how far it stands round the button), and the two facts as instruments in the
  // base: a display each, as tall as the faceplate, the one to the left of the button and the other to its right. On
  // a phone they are two small windows side by side over the button, their legends over them.
  const plate = phone ? 6 : 1.1 * U, fw = Math.min(-ctaW / 2 - plate - 1.5 * U + Xc - 2.4 * U, 20 * U), narrow = Math.max(70, Math.round(cta.w * .27))
  const facts: Rect[] = phone ? [{ x: cta.x, y: cta.y + cta.h + plate + 6, w: narrow, h: 28 }, { x: cta.x + narrow + 8, y: cta.y + cta.h + plate + 6, w: cta.w - narrow - 8, h: 28 }]
    : [{ x: -Xc + 2.4 * U, y: cta.y - plate, w: fw, h: cta.h + 2 * plate }, { x: Xc - 2.4 * U - fw, y: cta.y - plate, w: fw, h: cta.h + 2 * plate }]
  // The tally: a counter in the right header's front, beside the last outlet (Logs): everything sorted is on record.
  const tally = phone ? null : { x: fan[7].x - tubeR - 2 * U - 38, y: (headH - 14) / 2 + 1, w: 38, h: 14, z: zProud }
  const readout: Rect = phone ? { x: -Xw + U, y: yFas + (fascia - Math.min(48, fascia - 8)) / 2, w: Xw * 1.36, h: Math.min(48, fascia - 8) } : { x: -Xw + 2.2 * U, y: yFas + (fascia - 8.4 * V) / 2, w: 27.5 * U, h: 8.4 * V }
  const gauge = { x: Xw - (phone ? 4.4 : 4.2) * U, y: yFas + fascia / 2, r: Math.min(fascia * .36, phone ? 16 : 24) }
  return { phone, tight, W, H, ext, cannon, out: Math.round(out), room, widest, lean, ox, oy, U, V, side, over, under, Xw, Xc, D, base, band, wall, manifold, slot, cavity, fascia, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, cavD, zL, tubeR, tubes, post, zt, zProud, riser, fan, heads, drops, front, lip, floor, zLip, zOver, zBack, slabX, hopper: hopperU * U, cta, plate, facts, tally, readout, gauge }
}

/** A box on the machine's front, as the page places it: left and top in the scene, width and height. */
export const onFront = (p: Plan, r: Rect) => ({ left: p.ox + r.x, top: p.oy - r.y - r.h, width: r.w, height: r.h })
