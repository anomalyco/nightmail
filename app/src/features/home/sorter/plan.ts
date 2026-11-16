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
  const phone = W < 640
  // In cells: the unlit columns and rows round the price, the strip the tubes run down, and each floor of the machine.
  const side = phone ? 1 : 2, over = 2, under = phone ? 1 : 2, strip = phone ? 4.6 : 9.8
  const rows = phone ? { base: 30, band: 16.5, manifold: 2, slot: 3.6, cavity: 22, fascia: 12.6 } : { base: 14, band: 7.5, manifold: 2, slot: 3.4, cavity: 19, fascia: 11 }
  // The slab in front of the machine, its lip, and the page under the lip.
  const depth = phone ? 11 : 20, hopperU = phone ? 5 : 4.2, skyU = phone ? 2 : 1.5, frontU = phone ? 4.6 : 5.75, lipU = phone ? 1.6 : 2, belowU = phone ? 6.4 : 7.6
  const wallRows = ROWS + over + under, tall = (rows.base + rows.band + wallRows + rows.manifold + rows.slot + rows.cavity + rows.fascia) * 13 / 18 + depth * DY + hopperU + skyU + frontU + lipU + belowU
  const wide = 2 * (COLS / 2 + side + strip) + depth * -DX + (phone ? 1.4 : 9)
  // A cell is 18 wide for every 13 high, the shape of an envelope; as large as the page allows.
  const step = phone ? .05 : .25
  let U = Math.max(4, Math.min(12, Math.floor(Math.min(H / tall, W / wide) / step) * step))
  // Where the tubes fan out they need room beside the cabinet: on a narrow page the machine gives it up.
  while (!phone && U > 5 && W / 2 - (COLS / 2 + side + strip) * U - 26 < 4.05 * 32) U -= step
  const V = U * 13 / 18
  const Xw = (COLS / 2 + side) * U, Xc = Xw + strip * U, D = depth * U
  const base = rows.base * V, band = rows.band * V, wall = wallRows * V, manifold = rows.manifold * V, slot = rows.slot * V, cavity = rows.cavity * V, fascia = rows.fascia * V
  const yBand = base, yWall = yBand + band, yMan = yWall + wall, ySlot = yMan + manifold, yCav = ySlot + slot, yFas = yCav + cavity, yTop = yFas + fascia
  // Seven lanes across the works; a letter is most of a lane wide.
  const P = 2 * Xw / 7, lanes = Array.from({ length: 7 }, (_, i) => (i - 3) * P), lw = P * .7, lh = lw * .7
  const cavD = (phone ? 5.2 : 6.6) * U, zL = cavD / 2
  // Eight tubes, four each side of the price, the nearest the price first: inbox, agent inbox, endpoint, thread;
  // mailbox, ritual, campaign, logs. They run down the front between two manifolds. On a wide page they then leave the
  // cabinet's sides at the floor, fan out across the slab (`fan`: how deep each leaves, and where it turns towards
  // the lip), and go over the lip; on a phone they keep to the front, down to the floor and straight over the lip.
  const tubeR = (phone ? .4 : .9) * U, pitch = (phone ? 1.02 : 2.3) * U, first = (phone ? .78 : 1.5) * U
  const tubes = [0, 1, 2, 3].map(k => -(Xw + first + k * pitch)).concat([0, 1, 2, 3].map(k => Xw + first + k * pitch))
  const front = frontU * U, lip = lipU * U, floor = front + lip + belowU * U, ox = Math.round(W / 2), oy = Math.round(H - floor)
  const zLip = -front / DY, zOver = zLip - tubeR - 3 * U / 9, zBack = D * (phone ? 1.4 : 1.5), zt = -(tubeR + 1.5 * U / 9)
  const spread = Math.max(24, Math.min(13.5 * U, (W / 2 - Xc - 26) / 4.05))
  const fan = phone ? [] : [0, 1, 2, 3, 4, 5, 6, 7].map(t => { const k = t % 4, z = D * (.1 + .26 * k), x = (t < 4 ? -1 : 1) * (Xc + (.6 + k) * spread); return { z, x, out: x + DX * (z - zOver) } })
  /** Where each tube goes over the lip, across the page from its left edge. */
  const drops = tubes.map((x, t) => ox + (phone ? x + DX * zt : fan[t].x + DX * fan[t].z))
  const slabX = phone ? W : Xc + 4.9 * spread
  const cta: Rect = phone ? { x: -Xw + 2 * U, y: 7.8 * V, w: 2 * Xw - 4 * U, h: 50 } : { x: -7.6 * U, y: (base - Math.max(44, 7.4 * V)) / 2, w: 15.2 * U, h: Math.max(44, 7.4 * V) }
  const readout: Rect = phone ? { x: -Xw + U, y: yFas + (fascia - 48) / 2, w: Xw * 1.36, h: 48 } : { x: -Xw + 2.2 * U, y: yFas + (fascia - 8.4 * V) / 2, w: 27.5 * U, h: 8.4 * V }
  const gauge = { x: Xw - (phone ? 4.4 : 4.2) * U, y: yFas + fascia / 2, r: Math.min(fascia * .36, phone ? 16 : 24) }
  return { phone, W, H, ox, oy, U, V, side, over, under, Xw, Xc, D, base, band, wall, manifold, slot, cavity, fascia, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, cavD, zL, tubeR, tubes, zt, fan, drops, front, lip, floor, zLip, zOver, zBack, slabX, hopper: hopperU * U, cta, readout, gauge }
}

/** A box on the machine's front, as the page places it: left and top in the scene, width and height. */
export const onFront = (p: Plan, r: Rect) => ({ left: p.ox + r.x, top: p.oy - r.y - r.h, width: r.w, height: r.h })
