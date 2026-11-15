// Where everything on the sorter is, in CSS pixels, from the size of the page. The machine is drawn in one oblique
// projection: its front is a true rectangle (so the page's own text sits on it), and depth runs up the page and a
// little to the left. World x is right of the machine's middle, y is up from the floor, z is back from its front.
// The page's boxes (variant-sorter.css) read these as --srt-* lengths; the engine builds the machine from them.
import { COLS, ROWS } from './price'

/** Depth on screen per unit of world depth. */
export const DX = -0.26, DY = 0.42

export type Rect = { x: number; y: number; w: number; h: number }
export type Plan = ReturnType<typeof plan>

export function plan(W: number, H: number) {
  const phone = W < 640
  // In cells: the unlit columns and rows round the price, the strip the tubes run down, and each floor of the machine.
  const side = phone ? 1 : 2, over = 2, under = phone ? 1 : 2, strip = phone ? 4.6 : 7
  const rows = phone ? { base: 34, band: 13.5, manifold: 2, slot: 3.6, cavity: 20, fascia: 10 } : { base: 16, band: 7.5, manifold: 2, slot: 3.2, cavity: 15, fascia: 7.5 }
  const depth = phone ? 11 : 13, hopperU = phone ? 5.5 : 4.6, floorU = phone ? 9 : 8, skyU = phone ? 3 : 2.5
  const wallRows = ROWS + over + under, tall = (rows.base + rows.band + wallRows + rows.manifold + rows.slot + rows.cavity + rows.fascia) * 13 / 18 + depth * DY + hopperU + floorU + skyU
  const wide = 2 * (COLS / 2 + side + strip) + depth * -DX + (phone ? 1.4 : 9)
  // A cell is 18 wide for every 13 high, the shape of an envelope; as large as the page allows.
  const step = phone ? .05 : .25, U = Math.max(4, Math.min(12, Math.floor(Math.min(H / tall, W / wide) / step) * step)), V = U * 13 / 18
  const Xw = (COLS / 2 + side) * U, Xc = Xw + strip * U, D = depth * U
  const base = rows.base * V, band = rows.band * V, wall = wallRows * V, manifold = rows.manifold * V, slot = rows.slot * V, cavity = rows.cavity * V, fascia = rows.fascia * V
  const yBand = base, yWall = yBand + band, yMan = yWall + wall, ySlot = yMan + manifold, yCav = ySlot + slot, yFas = yCav + cavity, yTop = yFas + fascia
  // Seven lanes across the works; a letter is half a lane wide.
  const P = 2 * Xw / 7, lanes = Array.from({ length: 7 }, (_, i) => (i - 3) * P), lw = P * .5, lh = lw * .7
  const cavD = (phone ? 5.2 : 6.2) * U, zL = cavD / 2
  // Eight tubes down the front, four each side of the price: inbox, agent inbox, endpoint, thread; mailbox, ritual, campaign, logs.
  const tubeR = (phone ? .4 : .6) * U, pitch = (phone ? 1.02 : 1.56) * U, first = (phone ? .78 : 1.16) * U
  const tubes = [3, 2, 1, 0].map(k => -(Xw + first + k * pitch)).concat([0, 1, 2, 3].map(k => Xw + first + k * pitch))
  const floor = floorU * U, ox = Math.round(W / 2), oy = Math.round(H - floor)
  const cta: Rect = phone ? { x: -Xw + 2 * U, y: 8 * V, w: 2 * Xw - 4 * U, h: 50 } : { x: -8.5 * U, y: 5.4 * V, w: 17 * U, h: 7.6 * V }
  const readout: Rect = phone ? { x: -Xw + U, y: yFas + (fascia - 34) / 2, w: Xw * 1.3, h: 34 } : { x: -Xw + 1.5 * U, y: yFas + (fascia - 5.2 * V) / 2, w: 23 * U, h: 5.2 * V }
  const gauge = { x: Xw - (phone ? 4.4 : 5) * U, y: yFas + fascia / 2, r: Math.min(fascia * .36, phone ? 15 : 22) }
  return { phone, W, H, ox, oy, U, V, side, over, under, Xw, Xc, D, base, band, wall, manifold, slot, cavity, fascia, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, cavD, zL, tubeR, tubes, floor, hopper: hopperU * U, cta, readout, gauge }
}

/** A box on the machine's front, as the page places it: left and top in the scene, width and height. */
export const onFront = (p: Plan, r: Rect) => ({ left: p.ox + r.x, top: p.oy - r.y - r.h, width: r.w, height: r.h })
