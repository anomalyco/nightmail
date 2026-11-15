// The timing bench on the "nmb" homepage: a rail one second long, drawn as a real instrument in one isometric
// projection. A letter stands in a sled; a sprung starter throws it down the rail at a steady speed, so a position on
// the rail is a time. It breaks the beam of the first gate as the API accepts it and reaches the second as it is
// delivered, where a buffer catches it; a stopwatch on the far end runs while it travels. The times are the medians
// measured on 2026-11-15 (plans/homepage-nightmail/numbers.md): accepted at 99 ms, delivered at 602 ms.
//
// buildBench() draws the bench for one camera and returns it in layers (far to near) with the moving parts cut out as
// their own pieces; poseAt() is the model every moving part reads, and tracksOf() samples it into keyframes.

import * as k from './nmb-iso'
import type { Flat, Plan, Plane, Point3, Projection, SolidPaths } from './nmb-iso'

export const ACCEPTED_MS = 99, DELIVERED_MS = 602

// One camera on the bench. `second` is the rail's length for one second in world units (about a millimetre each).
// `width` is how many CSS pixels the base takes from end to end at its design size, so line weights and dots are in
// pixels. A `fine` drawing has every mark and the request's name engraved on it; a plain one is for a phone.
export interface Spec { name: 'wide' | 'tall'; second: number; azimuth: number; width: number; pad: number; fine: boolean }
export const WIDE: Spec = { name: 'wide', second: 330, azimuth: 112, width: 1280, pad: 8, fine: true }
/** A phone: a shorter second, seen a little more from the end. */
export const TALL: Spec = { name: 'tall', second: 170, azimuth: 118, width: 350, pad: 6, fine: false }
/** A tall screen wide enough for the bench's fine detail: a tablet held upright. */
export const TABLET: Spec = { name: 'tall', second: 230, azimuth: 123, width: 760, pad: 8, fine: true }

type Tone = 'lit' | 'hi' | 'mid' | 'lo' | 'faint' | 'ink' | 'accent'
type Material = 'body' | 'plate' | 'steel' | 'dark' | 'paper' | 'lamp'
interface Look { m?: Material; edge?: Tone; crease?: Tone | 'none'; inner?: string; flat?: boolean }

const n = (value: number) => String(Math.round(value * 10) / 10)
const line = (d: string | undefined, tone: Tone = 'lo', also = '') => d ? `<path class="nb-l nb-${tone}${also && ` ${also}`}" d="${d}"/>` : ''
const solid = (p: SolidPaths, { m = 'body', edge = 'mid', crease = 'faint', inner = '', flat = false }: Look = {}) =>
  `<g class="nb-${m}"><path class="nb-f" d="${p.fill}"/>${flat ? '' : `${p.shades.map((d, shade) => d ? `<path class="nb-h${shade}" d="${d}"/>` : '').join('')}<path class="nb-t" d="${p.top}"/>`}${crease === 'none' ? '' : line(p.crease, crease) + line(p.bevel, crease)}${inner}${line(p.outline, edge)}</g>`
const dots = (points: Flat[], r: number, tone: Tone = 'mid') => `<g class="nb-d nb-${tone}">${points.map(([x, y]) => `<circle cx="${n(x)}" cy="${n(y)}" r="${r}"/>`).join('')}</g>`

// A cut-out piece of the drawing: its markup and the box it occupies, in the drawing's own coordinates.
export interface Piece { markup: string; box: [number, number, number, number] }
function pieceOf(markup: string, extra: Flat[] = [], pad = 3): Piece {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  const take = (x: number, y: number, r = 0) => { left = Math.min(left, x - r); top = Math.min(top, y - r); right = Math.max(right, x + r); bottom = Math.max(bottom, y + r) }
  for (const [, d] of markup.matchAll(/ d="([^"]*)"/g)) for (const [, x, y] of d!.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) take(Number(x), Number(y))
  for (const [, x, y, r] of markup.matchAll(/cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)"/g)) take(Number(x), Number(y), Number(r))
  for (const [x, y] of extra) take(x, y)
  left = Math.floor(left - pad); top = Math.floor(top - pad)
  return { markup, box: [left, top, Math.ceil(right + pad) - left, Math.ceil(bottom + pad) - top] }
}

// The Stamp mark (components/BaneLogo.tsx) as outlines in a unit square: a perforated edge and four nested squares,
// filled even-odd.
function stampOutlines(): Plane[][] {
  const edge: Plane[] = []
  const side = (at: (t: number, out: number) => Plane) => {
    for (const centre of [10, 30, 50, 70, 90]) {
      edge.push(at(centre - 5.16, 0))
      for (let step = 1; step < 6; step++) { const a = Math.PI * step / 6; edge.push(at(centre - 5.16 * Math.cos(a), 5.16 * Math.sin(a))) }
      edge.push(at(centre + 5.16, 0))
    }
  }
  side((t, out) => [t, out]); side((t, out) => [100 - out, t]); side((t, out) => [100 - t, 100 - out]); side((t, out) => [out, 100 - t])
  const square = (inset: number): Plane[] => [[inset, inset], [100 - inset, inset], [100 - inset, 100 - inset], [inset, 100 - inset]]
  return [edge, square(16.98), square(23.91), square(31.48), square(37.63)].map(ring => ring.map(([x, y]) => [x / 100, y / 100] as Plane))
}

export interface Bench {
  spec: Spec
  width: number
  height: number
  /** Screen pixels per world unit along the rail, across it (towards the viewer) and upwards. */
  along: Flat
  across: Flat
  up: Flat
  /** Where the base's two ends fall, as fractions of the drawing's width: the page sets them on its margins. */
  window: [number, number]
  /** Where the gates stand along the rail, in world units, and where the sled comes to rest. */
  accepted: number
  delivered: number
  rest: number
  back: string
  front: string
  buffer: Piece
  /** The sled in three layers: its plate and far jaw, the letter standing in it, and the near jaw in front of the letter. */
  sled: Piece
  letter: Piece & { pivot: Flat }
  grip: Piece
  plunger: Piece
  /** The turns of the starter's spring, from the housing outwards. */
  coils: Piece[]
  needle: Piece & { pivot: Flat }
  crown: Piece
  key: Piece & { pivot: Flat }
  /** What lights: each gate's lamp, and the names engraved on the base (the request, then each gate). */
  lampA: Piece
  lampB: Piece
  said: [Piece, Piece, Piece]
  /** The trace the stopwatch's hand leaves on the dial's rim, and how much of its length is drawn at each fortieth of the run. */
  arc: Piece
  swept: number[]
  /** Where each gate's lamp sits, for the ring that pings off it. */
  pings: [Flat, Flat]
  /** Where the second gate's near post stands, as a fraction of the drawing's width: the page hangs its pitch from it. */
  post: number
}

/** How far past the second gate's light the letter comes to rest; how far the starter is drawn back and how far its plunger follows; the turns of its spring. */
export const REST = 1, DRAW = 16, STROKE = 12, COILS = 6

export function buildBench(spec: Spec): Bench {
  const SEC = spec.second, fine = spec.fine
  const XA = SEC * ACCEPTED_MS / 1000, XB = SEC * DELIVERED_MS / 1000, XR = XB + REST

  // World layout. x runs along the rail (0 is where the letter's leading edge starts), y towards the viewer, z up.
  const TRACK = -1
  // The letter, the sled under it (its leading edge is the letter's), and the starter behind that.
  // The starter's housing is long enough to hide its rod at both ends of its travel, and the spring between housing
  // and plunger has room to close to a block when drawn back.
  const LETTER = { length: 50, height: 34, z: 16.5 }, SLED_L = 48, HEAD = 3, SPRING = DRAW + COILS + 2
  const LAUNCHER: Plan = { x: -SLED_L - HEAD - SPRING - (DRAW + STROKE + 2), y: TRACK - 9.5, w: DRAW + STROKE + 2, d: 19, r: 2.5 }
  const BASE: Plan = { x: LAUNCHER.x - (fine ? 15 : 9), y: -40, w: SEC - LAUNCHER.x + (fine ? 15 + 28 : 9 + 34), d: 81, r: 5 }
  const BASE_H = 15, FOOT_H = 5, FRONT = BASE.y + BASE.d
  // The rail is a wide ground beam on a bed: the sled runs along its back two thirds (centred on TRACK) and the scale
  // is cut into the front third.
  const RAIL_X = LAUNCHER.x + LAUNCHER.w
  const BED: Plan = { x: RAIL_X - 2, y: -11.5, w: SEC - RAIL_X + 14, d: 29, r: 1.6 }
  const RAIL: Plan = { x: RAIL_X, y: -9, w: SEC - RAIL_X + 9, d: 24, r: 1 }
  const RAIL_Z = 3.5, RAIL_TOP = 11, SCALE_Y = 7.6, RAIL_FRONT = RAIL.y + RAIL.d
  // The gates' near posts stand well forward of the rail and their beams well above the letter, so a letter at rest
  // in the second gate has clear air round it; each lamp is over its near post.
  const GATE_H = 63, BEAM_H = 5.5, GATE_BACK = -14.5, GATE_FRONT = 34, LAMP_Y = GATE_FRONT, RAY_Z = 34
  // Seen more from the end, the stopwatch stands further along so the second gate's post doesn't cross its face.
  const TIMER: Plan = { x: spec.name === 'wide' ? Math.min(SEC - 62, XR + 62) : SEC - (fine ? 44 : 30), y: -36.5, w: 54, d: 19, r: 3 }
  const TIMER_H = 60, DIAL: Point3 = [TIMER.x + TIMER.w / 2, TIMER.y + TIMER.d, 33], DIAL_R = 21.5

  // The camera: scaled so the part that spans the page is `width` pixels across; the drawing's own size follows.
  const unit: Projection = { origin: [0, 0], scale: 1, azimuth: spec.azimuth }
  const reach: Point3[] = [
    ...k.boxCorners(BASE, -BASE_H - FOOT_H, 0),
    ...[XA, XB].flatMap(x => k.boxCorners({ x: x - 4, y: GATE_BACK - 4, w: 8, d: GATE_FRONT - GATE_BACK + 8, r: 0 }, 0, GATE_H + BEAM_H + 6)),
    ...k.boxCorners(TIMER, 0, TIMER_H + 6),
  ]
  const span: Point3[] = k.ringOf(BASE, 8).map(([x, y]) => [x, y, 0] as Point3)
  const flat = reach.map(point => k.iso(point, unit)), across0 = span.map(point => k.iso(point, unit)[0])
  const xs = flat.map(point => point[0]), ys = flat.map(point => point[1])
  const scale = spec.width / (Math.max(...across0) - Math.min(...across0))
  const P: Projection = { origin: [spec.pad - Math.min(...xs) * scale, spec.pad - Math.min(...ys) * scale], scale, azimuth: spec.azimuth }
  const width = Math.ceil((Math.max(...xs) - Math.min(...xs)) * scale + spec.pad * 2), height = Math.ceil((Math.max(...ys) - Math.min(...ys)) * scale + spec.pad * 2)
  const window: [number, number] = [(P.origin[0] + Math.min(...across0) * scale) / width, (P.origin[0] + Math.max(...across0) * scale) / width]
  const at = (point: Point3) => k.iso(point, P)
  const along = k.axisVector(P, [1, 0, 0]), across = k.axisVector(P, [0, 1, 0]), up = k.axisVector(P, [0, 0, 1])

  const slab = (plan: Plan, z: number, h: number, steps = 4, bevel = 0) => k.slabOf(plan, z, h, P, steps, bevel)
  const tube = (cx: number, cy: number, r: number, z: number, h: number, steps = 28) => k.cylinder(cx, cy, r, z, h, P, steps)
  const seg = (a: Point3, b: Point3) => k.segment(a, b, P)
  const top = (points: Plane[], z: number, closed = false) => k.onTop(points, z, P, closed)
  const byDepth = <T,>(items: T[], where: (item: T) => Point3) => [...items].sort((a, b) => k.depthOf(where(a), P) - k.depthOf(where(b), P))
  // A circle on a face that looks at the viewer (the x–z plane at depth y), and a point on it `turn` of the way round
  // from the top, clockwise.
  const faceRing = (c: Point3, r: number, steps = 40) => k.sideRing(c, r, 'y', P, steps)
  const onFace = (c: Point3, r: number, turn: number): Point3 => [c[0] + r * Math.sin(turn * Math.PI * 2), c[1], c[2] + r * Math.cos(turn * Math.PI * 2)]
  // Dots are in pixels: smaller where the whole drawing is.
  const px = (size: number) => fine ? size : Math.max(.34, size * .62)
  // A part's shadow on the surface it stands on: its footprint, slid away from the lamp. Flat, like everything else.
  const cast = (plan: Plan, z: number, reach = 1) => `<path class="nb-cast" d="${k.planOutline({ ...plan, x: plan.x + 3.4 * reach, y: plan.y + 2.9 * reach }, z, P, 4)}"/>`
  const knob = (cx: number, cy: number, r: number, z: number, h: number, ribs: number) =>
    solid(tube(cx, cy, r, z, h, 24), { edge: 'mid' }) + line(k.knurl(cx, cy, r, z, z + h, ribs, P), 'lo')

  // ——— Back layer: everything the sled passes in front of. ———
  const back: string[] = []

  const feet: Plane[] = [BASE.x + 20, BASE.x + BASE.w / 2, BASE.x + BASE.w - 20].flatMap(x => [BASE.y + 13, FRONT - 13].map(y => [x, y] as Plane))
  for (const [x, y] of byDepth(feet, ([x, y]) => [x, y, 0])) {
    back.push(solid(tube(x, y, 7.4, -BASE_H - FOOT_H, 1.6), { m: 'dark', edge: 'lo' }))
    back.push(solid(tube(x, y, 5.6, -BASE_H - FOOT_H + 1.6, FOOT_H - 1.6), { m: 'dark', edge: 'lo' }))
  }

  // The base: a long plate with a trim seam round its foot, and what happens above each place engraved on its front:
  // the request under the starter (where the drawing is large enough to read it) and the name of each gate.
  // The type is a monospace: each letter is .6 of its size wide, plus the tracking the page's styles give it.
  const TYPE = fine ? 5 : 9.2, REQUEST = 'POST /v1/emails/send', REQUEST_X = (LAUNCHER.x + LAUNCHER.w) / 2 - 1
  const label = (text: string, x: number, also = '') => `<text class="nb-label${also && ` ${also}`}" transform="${k.sideMatrix([x, FRONT], -4.1, P, 'left')}" font-size="${TYPE}" text-anchor="middle" dominant-baseline="hanging">${text}</text>`
  const labelBox = (x: number, half: number) => [at([x - half, FRONT, -3]), at([x + half, FRONT, -11])]
  back.push(solid(slab(BASE, -BASE_H, BASE_H, 8, 1.6), { m: 'plate', edge: 'mid', inner: line(k.sideSeam(BASE, -BASE_H + 2.6, P, 8), 'faint') }))
  back.push(fine ? label(REQUEST, REQUEST_X, 'nb-code') : '', label('ACCEPTED', XA), label('DELIVERED', XB))
  back.push(line(k.planOutline(k.insetPlan(BASE, 4.5), 0, P), 'faint'))
  const corners = k.corners(BASE, 10)
  back.push(line(k.joinPaths(corners.map(([x, y]) => k.ring(x, y, 2.3, 0, P, 16))), 'lo'), dots(corners.map(([x, y]) => at([x, y, 0])), px(.6)))

  back.push(cast(k.insetPlan(TIMER, -2), 0, 1.5), cast(BED, 0, 1.2), cast(LAUNCHER, 0, 1.3))
  for (const x of [XA, XB]) for (const y of [GATE_BACK, GATE_FRONT]) back.push(cast({ x: x - 6.5, y: y - 5.2, w: 13, d: 10.4, r: 1.6 }, 0, .6))

  // The gates' cables run behind the rail to the stopwatch, each under its clips.
  const CABLES: [number, number][] = [[XA, -29], [XB, -25]]
  for (const [from, y] of CABLES) back.push(line(top([[from, GATE_BACK - 2], [from, y], [TIMER.x - 2, y]], .2), 'mid', 'nb-cable'))
  const clips: Plane[] = []
  for (let x = XA + 20; x < TIMER.x - 12; x += fine ? 44 : 58) clips.push([x, x > XB ? -27 : -29])
  for (const [x, y] of byDepth(clips, ([x, y]) => [x, y, 0])) back.push(solid(slab({ x: x - 1.6, y: y - (x > XB ? 4.6 : 2.6), w: 3.2, d: x > XB ? 9.2 : 5.2, r: .8 }, 0, 1.3, 2), { edge: 'lo', crease: 'none' }))

  // The stopwatch: a cabinet with a dial on its face that turns once a second, a crown on top, two sockets at its foot.
  back.push(solid(slab(k.insetPlan(TIMER, -2), 0, 2, 4), { edge: 'lo' }))
  for (const [, y] of CABLES) back.push(solid(slab({ x: TIMER.x - 4.6, y: y - 1.9, w: 4.6, d: 3.8, r: .8 }, 0, 3.4, 2), { m: 'dark', edge: 'lo' }))
  back.push(solid(slab(TIMER, 2, TIMER_H - 2, 5, 1.2), { edge: 'mid', inner: line(k.sideSeam(TIMER, 6.5, P, 5), 'faint') }))
  back.push(line([0, 1, 2, 3, 4].map(index => k.planOutline({ x: TIMER.x + 26 + index * 5, y: TIMER.y + 3.6, w: 2.4, d: TIMER.d - 7.2, r: 1.2 }, TIMER_H, P, 4)).join(''), 'lo'))
  back.push(solid(tube(TIMER.x + 12, TIMER.y + TIMER.d / 2, 5.4, TIMER_H, 1.1), { edge: 'lo' }))
  back.push(`<path class="nb-dial" d="${faceRing(DIAL, DIAL_R, 64)}"/>`, line(faceRing(DIAL, DIAL_R, 64), 'mid'), line(faceRing(DIAL, DIAL_R - 1.7, 64), 'faint'))
  const dial: [string[], string[]] = [[], []]
  const divisions = fine ? 50 : 20
  for (let index = 0; index < divisions; index++) {
    const big = index % (divisions / 10) === 0
    dial[big ? 1 : 0].push(seg(onFace(DIAL, DIAL_R - 2.6, index / divisions), onFace(DIAL, DIAL_R - (big ? 6.4 : 4.4), index / divisions)))
  }
  back.push(line(dial[0].join(''), 'mid', 'nb-tick'), line(dial[1].join(''), 'lit', 'nb-tick'), line(faceRing(DIAL, 2.2, 16), 'mid'))
  back.push(dots([[3.2, 5], [TIMER.w - 3.2, 5], [3.2, TIMER_H - 3.6], [TIMER.w - 3.2, TIMER_H - 3.6]].map(([dx, z]) => at([TIMER.x + dx!, TIMER.y + TIMER.d, z!])), px(.55)))

  // Each gate is an arch over the rail: two posts, a head that throws a beam of light across, and a lamp on top. The
  // far post and the far half of the light go behind the sled.
  const post = (x: number, y: number) => {
    const plan: Plan = { x: x - 2.6, y: y - 2.6, w: 5.2, d: 5.2, r: 1.1 }
    return [
      solid(slab({ x: x - 6.5, y: y - 5.2, w: 13, d: 10.4, r: 1.6 }, 0, 1.5, 3), { edge: 'lo', crease: 'none' }),
      dots([at([x - 4.4, y + 3.5, 1.5]), at([x + 4.4, y + 3.5, 1.5])], px(.5)),
      solid(slab(plan, 1.5, GATE_H - 1.5, 3), { edge: 'mid', inner: line(k.sideSeam(plan, 6, P, 3), 'faint') }),
    ].join('')
  }
  const gateBack = (x: number) => [
    post(x, GATE_BACK),
    solid(slab({ x: x - 2.3, y: GATE_BACK + 2.6, w: 4.6, d: 3, r: .7 }, RAY_Z - 2.6, 5.2, 2), { m: 'dark', edge: 'mid' }),
    line(faceRing([x, GATE_BACK + 5.6, RAY_Z], 1.15, 12), 'lo'),
    line(seg([x, GATE_BACK + 5.6, RAY_Z], [x, TRACK, RAY_Z]), 'accent', 'nb-ray'),
  ].join('')
  back.push(gateBack(XB), gateBack(XA))

  // The rail on its bed, with a stop where the second ends. Two slots guide the sled; the front third carries the
  // scale: a mark every 10 ms, longer at each 50 and 100.
  back.push(solid(slab(BED, 0, RAIL_Z, 3, .5), { m: 'dark', edge: 'lo' }))
  const bolts: Flat[] = []
  for (let x = BED.x + 8; x < BED.x + BED.w - 4; x += fine ? 33 : 47.2) bolts.push(at([x, BED.y + BED.d - 1.25, RAIL_Z]))
  back.push(dots(bolts, px(.45), 'lo'))
  back.push(solid(slab(RAIL, RAIL_Z, RAIL_TOP - RAIL_Z, 3, .7), { m: 'steel', edge: 'hi' }))
  const STOP: Plan = { x: SEC, y: TRACK - 7.5, w: 8.5, d: 15, r: 1.6 }
  const BLOCK: Plan = { x: XR + 28, y: TRACK - 7.75, w: 10.5, d: 15.5, r: 1.6 }
  back.push(cast(BLOCK, RAIL_TOP, .8))
  back.push(line(k.joinPaths([TRACK - 4.2, TRACK + 4.2].map(y => k.lineOnTop([RAIL.x, y], [SEC, y], RAIL_TOP, P))), 'faint'), line(k.lineOnTop([RAIL.x, SCALE_Y], [RAIL.x + RAIL.w, SCALE_Y], RAIL_TOP, P), 'lo'))
  // The marks the letter never reaches are a tone down: the part of the second it didn't need.
  const marks: Record<'used' | 'spare', [string[], string[], string[]]> = { used: [[], [], []], spare: [[], [], []] }
  const every = fine ? 100 : 50
  for (let index = 0; index <= every; index++) {
    const x = SEC * index / every, rank = index % (every / 10) === 0 ? 2 : index % (every / 20) === 0 ? 1 : 0
    marks[x <= XR + 1 ? 'used' : 'spare'][rank].push(k.lineOnTop([x, RAIL_FRONT], [x, RAIL_FRONT - [2.2, 3.5, 5.2][rank]!], RAIL_TOP, P))
  }
  back.push(line(marks.used[0].join(''), 'mid', 'nb-tick'), line(marks.used[1].join(''), 'hi', 'nb-tick'), line(marks.used[2].join(''), 'lit', 'nb-tick'))
  back.push(line(marks.spare[0].join(''), 'lo', 'nb-tick'), line(marks.spare[1].join(''), 'mid', 'nb-tick'), line(marks.spare[2].join(''), 'hi', 'nb-tick'))
  back.push(solid(slab(STOP, RAIL_TOP, 9, 3, .6), { edge: 'mid' }), dots([at([SEC + 4.25, TRACK - 4.4, RAIL_TOP + 9]), at([SEC + 4.25, TRACK + 4.4, RAIL_TOP + 9])], px(.5)))

  // The buffer's fixed half: a block clamped to the rail with a knob, and the rod its bumper slides on.
  const KNOB: Plane = [BLOCK.x + BLOCK.w / 2, TRACK]
  back.push(solid(slab(BLOCK, RAIL_TOP, 10, 3, .6), { edge: 'mid' }), knob(KNOB[0], KNOB[1], 3.5, RAIL_TOP + 10, 3.8, 22))
  back.push(line(k.lineOnTop([KNOB[0] - 2.4, KNOB[1]], [KNOB[0] + 2.4, KNOB[1]], RAIL_TOP + 13.8, P), 'hi'))
  back.push(solid(slab({ x: XR + 3.4, y: TRACK - 1.25, w: BLOCK.x - XR - 3.4, d: 2.5, r: 1.1 }, 12.3, 2.5, 3), { m: 'steel', edge: 'mid', crease: 'none' }))

  // ——— The moving pieces, each drawn where it stands at the start of a run. ———
  const buffer = pieceOf([
    solid(slab({ x: XR + 2.3, y: TRACK - 2.4, w: 6.2, d: 4.8, r: 1.2 }, 11.5, 4, 3), { m: 'steel', edge: 'mid', crease: 'none' }),
    solid(slab({ x: XR, y: TRACK - 3.8, w: 2.5, d: 7.6, r: 1 }, 11.1, 5.4, 3), { m: 'dark', edge: 'mid' }),
  ].join(''))

  // The sled: a plate on the rail's track with a pair of jaws along its middle.
  const DECK = RAIL_TOP + 4, JAW = 4.2
  const SLED: Plan = { x: -SLED_L, y: TRACK - 8, w: SLED_L, d: 16, r: 2 }, JAW_X = -SLED_L + 3, JAW_L = SLED_L - 6
  const sled = pieceOf([
    cast(SLED, RAIL_TOP, .7),
    solid(slab(SLED, RAIL_TOP, DECK - RAIL_TOP, 4, .6), { edge: 'hi' }),
    line(k.planOutline(k.insetPlan(SLED, 2.2), DECK, P, 4), 'faint'),
    solid(slab({ x: JAW_X, y: TRACK - 2.7, w: JAW_L, d: 2.2, r: .6 }, DECK, JAW, 2), { edge: 'mid', crease: 'none' }),
  ].join(''))

  // The letter: a thin card standing in the jaws, address side to the viewer, stamp in the leading corner.
  const LX = -LETTER.length, LZ = LETTER.z + LETTER.height, HALF = .5
  const onLetter = (u: number, v: number): Flat => at([LX + u, TRACK + HALF, LZ - v])
  const facePath = (points: Plane[], closed = false) => k.pathOf(points.map(([u, v]) => onLetter(u, v)), closed)
  const STAMP = { u: LETTER.length - 13.2, v: 3.8, size: 9.4 }
  const stamp = stampOutlines().map(ring => facePath(ring.map(([x, y]) => [STAMP.u + x * STAMP.size, STAMP.v + y * STAMP.size] as Plane), true)).join('')
  const POSTMARK = { u: STAMP.u - 3.6, v: STAMP.v + STAMP.size * .56 }
  const postmark = [4.7, 3.5].map(r => facePath(Array.from({ length: 28 }, (_, step) => [POSTMARK.u + r * Math.cos(step / 28 * Math.PI * 2), POSTMARK.v + r * Math.sin(step / 28 * Math.PI * 2)] as Plane), true)).join('')
    + [-2.2, 0, 2.2].map(dv => facePath([[POSTMARK.u - 13, POSTMARK.v + dv], [POSTMARK.u - 5.6, POSTMARK.v + dv]])).join('')
  const address = [0, 1, 2].map(row => facePath([[6, 17.4 + row * 3.9], [6 + [20, 13.5, 16.5][row]!, 17.4 + row * 3.9]])).join('')
  const letter = {
    ...pieceOf(solid(slab({ x: LX, y: TRACK - HALF, w: LETTER.length, d: HALF * 2, r: 0 }, LETTER.z, LETTER.height, 1), {
      m: 'paper', edge: 'ink', crease: 'none', inner: `<path class="nb-stamp" fill-rule="evenodd" d="${stamp}"/>${line(postmark, 'ink', 'nb-postmark')}${line(address, 'ink', 'nb-address')}`,
    }), [], 12),
    pivot: at([-LETTER.length / 2, TRACK, DECK + JAW / 2]),
  }

  // In front of the letter: the near jaw with its two thumbscrews, and the index that reads the scale.
  const grip = pieceOf([
    solid(slab({ x: JAW_X, y: TRACK + .5, w: JAW_L, d: 2.2, r: .6 }, DECK, JAW, 2), { edge: 'mid', crease: 'none' }),
    dots([at([JAW_X + 3.4, TRACK + 1.6, DECK + JAW]), at([JAW_X + JAW_L - 3.4, TRACK + 1.6, DECK + JAW])], px(.42)),
    ...[-8, -SLED_L + 8].map(x => knob(x, TRACK + 5.4, 2.2, DECK, 4.4, 14)),
    solid(slab({ x: -2.4, y: SLED.y + SLED.d, w: 2.4, d: 4.6, r: .5 }, RAIL_TOP, 1.1, 1), { m: 'steel', edge: 'hi', crease: 'none' }),
    line(k.lineOnTop([0, SLED.y + SLED.d], [0, SLED.y + SLED.d + 4.6], RAIL_TOP + 1.1, P), 'lit', 'nb-index'),
  ].join(''))

  // The starter's plunger, cocked: a rod out of the housing with a bumper on its end, and round the rod the turns of
  // the spring, which close up as it is wound and open as it is let go.
  const HEAD_X = -SLED_L - HEAD, MOUTH = LAUNCHER.x + LAUNCHER.w
  const plunger = pieceOf([
    solid(slab({ x: HEAD_X, y: TRACK - 3.8, w: HEAD, d: 7.6, r: 1 }, 11.1, 5.4, 3), { m: 'dark', edge: 'mid' }),
    solid(slab({ x: LAUNCHER.x + DRAW + 1, y: TRACK - 1.4, w: HEAD_X - LAUNCHER.x - DRAW - 1, d: 2.8, r: 1.2 }, 12.4, 2.8, 3), { m: 'steel', edge: 'mid', crease: 'none' }),
  ].join(''))
  const coils = Array.from({ length: COILS }, (_, index) => pieceOf(solid(slab({ x: MOUTH + SPRING * (index + 1) / (COILS + 1) - .5, y: TRACK - 2.9, w: 1, d: 5.8, r: .5 }, 11.4, 4.8, 2), { m: 'steel', edge: 'mid', crease: 'none' })))

  // ——— Front layer: everything the sled passes behind. ———
  const front: string[] = []
  // The starter: a housing with a release on top.
  const LC: Plane = [LAUNCHER.x + LAUNCHER.w / 2, TRACK]
  front.push(solid(slab(LAUNCHER, 0, 25, 4, 1), { edge: 'mid', inner: line(k.sideSeam(LAUNCHER, 4.5, P, 4), 'faint') }))
  front.push(solid(tube(LC[0], LC[1], 5.2, 25, 1.2), { edge: 'lo' }), knob(LC[0], LC[1], 4.1, 26.2, 3.8, 26))
  // The key on top of it: a flat bar that turns a quarter as the spring is wound and flies back as it is let go.
  const KEY_Z = 30, BAR: Plan = { x: LC[0] - 6.6, y: LC[1] - 1.7, w: 13.2, d: 3.4, r: 1.7 }
  const key = {
    ...pieceOf(`<path class="nb-key" d="${k.planOutline(BAR, KEY_Z, P, 6)}"/>` + line(k.planOutline(BAR, KEY_Z, P, 6), 'hi') + line(k.lineOnTop([LC[0] - 4.6, LC[1]], [LC[0] + 4.6, LC[1]], KEY_Z, P), 'lit', 'nb-index') + dots([at([LC[0], LC[1], KEY_Z])], px(.9), 'lit'), [], 16),
    pivot: at([LC[0], LC[1], KEY_Z]),
  }
  front.push(dots([[3, 3], [LAUNCHER.w - 3, 3], [3, LAUNCHER.d - 3], [LAUNCHER.w - 3, LAUNCHER.d - 3]].map(([dx, dy]) => at([LAUNCHER.x + dx!, LAUNCHER.y + dy!, 25])), px(.5)))

  const LENS_Z = GATE_H + BEAM_H + 1
  const lens = (x: number, lit: boolean) => solid(tube(x, LAMP_Y, 3, LENS_Z, 3.4, 24), { m: lit ? 'lamp' : 'dark', edge: lit ? 'lit' : 'mid', crease: lit ? 'none' : 'faint' }) + (lit ? '' : line(k.ring(x, LAMP_Y, 1.7, LENS_Z + 3.4, P, 16), 'lo'))
  const gateFront = (x: number) => [
    line(seg([x, TRACK, RAY_Z], [x, GATE_FRONT - 2.6, RAY_Z]), 'accent', 'nb-ray'),
    post(x, GATE_FRONT),
    solid(slab({ x: x - 3.3, y: GATE_BACK - 3.6, w: 6.6, d: GATE_FRONT - GATE_BACK + 7.2, r: 1.6 }, GATE_H, BEAM_H, 4, .7), { edge: 'mid' }),
    dots([at([x, GATE_BACK, GATE_H + BEAM_H])], px(.5)),
    solid(tube(x, LAMP_Y, 3.9, GATE_H + BEAM_H, 1), { edge: 'lo' }),
    lens(x, false),
  ].join('')
  front.push(gateFront(XB), gateFront(XA))

  // What changes when a gate fires: its lamp, then its name on the base. The request's name lights the same way as
  // the letter is thrown.
  const lamp = (x: number) => pieceOf(lens(x, true))
  const saying = (text: string, x: number, also = '') => pieceOf(label(text, x, `nb-label--lit${also && ` ${also}`}`), labelBox(x, TYPE * text.length * .45))
  const said: [Piece, Piece, Piece] = [fine ? saying(REQUEST, REQUEST_X, 'nb-code') : pieceOf('', labelBox(REQUEST_X, 4)), saying('ACCEPTED', XA), saying('DELIVERED', XB)]

  // The stopwatch's hand (pointing up, with a counterweight) and its crown (out).
  const needle = {
    ...pieceOf(line(seg(onFace(DIAL, -6.4, 0), onFace(DIAL, -2.4, 0)), 'lit', 'nb-weight') + line(seg(onFace(DIAL, -2.4, 0), onFace(DIAL, DIAL_R - 4.2, 0)), 'lit', 'nb-hand') + dots([at(DIAL)], px(2.1), 'lit'), [.25, .5, .75].map(turn => at(onFace(DIAL, DIAL_R, turn))), 4),
    pivot: at(DIAL),
  }
  // The trace the hand leaves: a band round the dial's rim, drawn out behind the hand from twelve as it goes (six
  // tenths of the way round when it stops; the rest of the lap as it flies home). It is one stroke, so `swept` gives
  // the share of its length behind the hand at each step of a turn.
  const STEPS = 64, BAND = 1.75
  const trace = Array.from({ length: STEPS + 1 }, (_, step) => at(onFace(DIAL, DIAL_R - .5 - BAND / 2, step / STEPS)))
  const lengths = trace.map((point, index) => index ? Math.hypot(point[0] - trace[index - 1]![0], point[1] - trace[index - 1]![1]) : 0)
  let drawn = 0
  const swept = lengths.map(length => (drawn += length)).map(length => length / drawn)
  const arc = pieceOf(`<path class="nb-arc" data-part="trace" pathLength="1" stroke-width="${n(BAND * Math.hypot(...up))}" d="${k.pathOf(trace)}"/>`, [], 6)
  const CROWN: Plane = [TIMER.x + 12, TIMER.y + TIMER.d / 2]
  const crown = pieceOf(knob(CROWN[0], CROWN[1], 4.2, TIMER_H + 1.1, 5, 26) + line(k.ring(CROWN[0], CROWN[1], 2.4, TIMER_H + 6.1, P, 16), 'lo'))

  return {
    spec, width, height, along, across, up, window, accepted: XA, delivered: XB, rest: XR,
    back: back.join(''), front: front.join(''), buffer, sled, letter, grip, plunger, coils, needle, crown, key,
    lampA: lamp(XA), lampB: lamp(XB), said, arc, swept,
    pings: [at([XA, LAMP_Y, LENS_Z + 3.4]), at([XB, LAMP_Y, LENS_Z + 3.4])],
    post: at([XB - 2.6, GATE_FRONT - 2.6, 0])[0] / width,
  }
}

// ——— The model. One loop: a letter drops into the sled, the starter is wound and let go, the letter runs, is caught
// and rests; then the stopwatch is reset, the letter is lifted away and the empty sled is drawn back for the next
// one. A delivered letter is never sent back. Every moving part reads its place from poseAt(). ———

/** A loop, when in it the letter crosses the zero mark (where the stopwatch starts), and when the reset begins. */
export const LOOP_MS = 7000, LAUNCH_MS = 660, RESET_MS = 5300
/** Where in the loop a page starts: the empty sled is on the last of its way back, about to be loaded and cocked. */
export const ENTER_MS = 6440
const RETURN_FROM = RESET_MS + 300, RETURN_MS = 1200, CLICK_MS = 200
// Before a throw the key is wound a quarter turn while the sled is drawn back DRAW units against the spring, and held.
const WIND_MS = 420, HOLD_MS = 80
// A gate's ping, and how long after its lamp its name lights.
const PING_MS = 520, SAY_MS = 40
// The reset, in ms after the crown is pressed: the hand flies home, the trace clears as it gets there, the names and
// lamps go out one by one (last lit, first out), and the letter is lifted out of the sled.
const FLY_MS = 80, CLEAR_MS = 250, OUT_MS = [340, 290, 240, 190, 140], LIFT_FROM = 200, LIFT_MS = 480, LIFT = 46
// The next letter drops into the jaws as the sled comes home.
const DROP_FROM = RETURN_FROM + RETURN_MS - 190, DROP_MS = 260, DROP = 30

export interface Pose {
  /** The sled's leading edge along the rail, in world units from the zero mark. */
  nose: number
  /** The letter: where it is along the rail, how far above the sled's jaws, how visible, and its lean in degrees (forwards positive). */
  letter: number
  lift: number
  shown: number
  lean: number
  /** How far out the starter's plunger is (0 cocked, STROKE released), and how far in the buffer's bumper is pushed. */
  plunger: number
  buffer: number
  /** The stopwatch's hand in turns, how far its crown is pressed (0 to 1), and the starter's key in quarter turns. */
  turn: number
  crown: number
  key: number
  /** What is lit: each gate's lamp, the three names on the base (the request, then each gate), and the hand's trace (0 to 1). */
  accepted: boolean
  delivered: boolean
  said: [boolean, boolean, boolean]
  traced: number
  /** Each gate's ping: 0 as it fires, 1 when it has faded; null otherwise. */
  pings: [number | null, number | null]
}

const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10)
const inOut = (u: number) => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
const out = (u: number) => 1 - Math.pow(1 - u, 3)
const clamp = (u: number) => Math.min(1, Math.max(0, u))
// A struck spring: zero at the blow, one swing of `amplitude` (in its own units), ringing at `hz` and dying by `damping`.
const ring = (seconds: number, amplitude: number, hz: number, damping: number) => {
  if (seconds <= 0) return 0
  const w = Math.PI * 2 * hz
  return amplitude * Math.exp(-damping * w * seconds) * Math.sin(w * Math.sqrt(1 - damping * damping) * seconds)
}
// A sprung part let go one unit from its rest: how far it still is from it, overshooting by a fraction set by `damping`.
const settle = (seconds: number, hz: number, damping: number) => {
  if (seconds <= 0) return 1
  const w = Math.PI * 2 * hz, wd = w * Math.sqrt(1 - damping * damping)
  return Math.exp(-damping * w * seconds) * (Math.cos(wd * seconds) + damping * w / wd * Math.sin(wd * seconds))
}

export function poseAt(time: number, bench: Pick<Bench, 'spec' | 'rest'>): Pose {
  const t = ((time % LOOP_MS) + LOOP_MS) % LOOP_MS
  const speed = bench.spec.second / 1000, rest = bench.rest
  const run = t - LAUNCH_MS, since = t - RESET_MS
  // The spring takes the sled from DRAW behind the mark to full speed exactly at the mark: `push` ms of even
  // acceleration. `freed` counts from the moment it is let go, `winding` from the moment the key starts to turn.
  const push = 2 * DRAW / speed, freed = run + push, winding = freed + HOLD_MS + WIND_MS
  // The catch: the sled meets the bumper at `rest` still at full speed, pushes it in about four units and settles.
  const caught = run - rest / speed, give = bench.spec.second * .13
  let nose = 0, plunger = 0, lean = 0, turn = 0, crown = 0, key = 0
  if (t < RETURN_FROM) {
    if (winding < 0) nose = 0
    else if (freed < 0) nose = -DRAW * inOut(clamp(winding / WIND_MS))
    else if (run < 0) nose = -DRAW * (1 - (freed / push) ** 2)
    else if (caught <= 0) nose = speed * run
    else nose = rest + ring(caught / 1000, bench.spec.second / give / Math.sqrt(.75), give / (Math.PI * 2), .5)
    // The plunger pushes the sled for its stroke, then rattles on its stop.
    const stopped = run - STROKE / speed
    plunger = stopped <= 0 ? nose : STROKE - Math.abs(ring(stopped / 1000, 2.6, 9, .15))
    // The key winds, then flies back past its mark and comes to rest.
    key = winding < 0 ? 0 : freed < 0 ? inOut(clamp(winding / WIND_MS)) : freed < 700 ? settle(freed / 1000, 7, .32) : 0
    // The letter is left behind as it is thrown and pitches forward as it is caught.
    lean = ring(freed / 1000, -5.2, 6.2, .2) + ring(caught / 1000, 6.6, 6.2, .2)
    turn = clamp(run / DELIVERED_MS) * DELIVERED_MS / 1000
  } else {
    const home = t - RETURN_FROM - RETURN_MS
    // Drawn back, pushing the plunger in over the last of the way; then the catch clicks.
    nose = home < 0 ? rest * (1 - smoother(clamp((t - RETURN_FROM) / RETURN_MS))) : -.9 * Math.sin(Math.PI * clamp(home / CLICK_MS)) * (1 - clamp(home / CLICK_MS))
    plunger = Math.min(STROKE, nose)
  }
  // The letter rides the sled from the moment it drops in until it is lifted away, where the sled was when it stopped.
  let letter = nose, lift = 0, shown = 1
  if (since >= LIFT_FROM && t < DROP_FROM) {
    const up = clamp((since - LIFT_FROM) / LIFT_MS)
    letter = up < 1 ? rest : nose
    lift = LIFT * up * up
    shown = 1 - clamp((up - .3) / .55)
  } else if (t >= DROP_FROM) {
    const fall = (t - DROP_FROM) / DROP_MS
    // It falls, lands in the jaws and settles with one small rebound.
    lift = fall < 1 ? DROP * (1 - fall * fall) : Math.abs(ring((t - DROP_FROM - DROP_MS) / 1000, 2.2, 8, .3))
    shown = clamp(fall / .4)
    lean = ring((t - DROP_FROM - DROP_MS) / 1000, 1.4, 7, .3)
  }
  let traced = run >= 0 ? 1 : 0
  if (since >= 0) {
    crown = since < 90 ? out(since / 90) : since < 170 ? 1 : 1 - out(clamp((since - 170) / 190))
    // The hand flies on round to twelve, as a stopwatch's does, and stops a hair past it before it settles.
    turn = 1 - (1 - DELIVERED_MS / 1000) * settle((since - FLY_MS) / 1000, 6.4, .8)
    traced = 1 - clamp((since - CLEAR_MS) / 90)
  }
  const lit = (index: number) => since < OUT_MS[index]!
  const ping = (at: number) => run >= at && run < at + PING_MS ? (run - at) / PING_MS : null
  return {
    nose, letter, lift, shown, lean, plunger, buffer: Math.max(0, nose - rest), turn, crown, key,
    accepted: run >= ACCEPTED_MS && lit(1), delivered: run >= DELIVERED_MS && lit(3),
    said: [freed >= 0 && lit(0), run >= ACCEPTED_MS + SAY_MS && lit(2), run >= DELIVERED_MS + SAY_MS && lit(4)],
    traced,
    pings: [ping(ACCEPTED_MS), ping(DELIVERED_MS)],
  }
}

/** The loop time a still page shows: delivered, settled. */
export const STILL_MS = LAUNCH_MS + DELIVERED_MS + 1600

export type Part = 'sled' | 'letterAt' | 'letter' | 'grip' | 'plunger' | `coil${number}` | 'buffer' | 'needle' | 'crown' | 'key' | 'lampA' | 'lampB' | 'said0' | 'said1' | 'said2' | 'arc' | 'trace' | 'pingA' | 'pingB'
export interface Style { transform?: string; opacity?: number; strokeDashoffset?: number }

// A pose as styles. Whole pieces slide in fractions of the drawing (their holders are its size); the letter and the
// hand turn about their own pivots in the plane the rail and the vertical span, the key in the plane of the base.
export function stylesOf(pose: Pose, bench: Bench): Record<Part, Style> {
  const { along, across, up, width, height } = bench
  const f = (value: number) => String(Math.round(value * 1000) / 1000)
  const slide = (x: number, z = 0) => `translate(${f((x * along[0] + z * up[0]) / width * 100)}%, ${f((x * along[1] + z * up[1]) / height * 100)}%)`
  // A turn in the plane spanned by the screen vectors u and v: into the plane, turn, back out.
  const turnIn = (u: readonly [number, number], v: readonly [number, number]) => {
    const det = u[0] * v[1] - v[0] * u[1]
    const plane = `matrix(${f(u[0])}, ${f(u[1])}, ${f(v[0])}, ${f(v[1])}, 0, 0)`, flat = `matrix(${v[1] / det}, ${-u[1] / det}, ${-v[0] / det}, ${u[0] / det}, 0, 0)`
    return (degrees: number) => `${plane} rotate(${f(-degrees)}deg) ${flat}`
  }
  const upright = turnIn(along, up), level = turnIn(along, across)
  const ping = (at: number | null): Style => at === null ? { transform: 'scale(.35)', opacity: 0 } : { transform: `scale(${f(.35 + .65 * out(at))})`, opacity: Math.round((1 - at) * (1 - at) * 100) / 100 }
  // How much of the trace is still to draw: the share of its length ahead of the hand.
  const share = clamp(pose.turn) * (bench.swept.length - 1), step = Math.min(bench.swept.length - 2, Math.floor(share))
  const behind = bench.swept[step]! + (bench.swept[step + 1]! - bench.swept[step]!) * (share - step)
  const styles: Record<Part, Style> = {
    sled: { transform: slide(pose.nose) },
    letterAt: { transform: slide(pose.letter, pose.lift), opacity: Math.round(pose.shown * 100) / 100 },
    letter: { transform: upright(pose.lean) },
    grip: { transform: slide(pose.nose) },
    plunger: { transform: slide(pose.plunger) },
    buffer: { transform: slide(pose.buffer) },
    needle: { transform: upright(pose.turn * 360) },
    crown: { transform: slide(0, -3 * pose.crown) },
    key: { transform: level(pose.key * 90) },
    lampA: { opacity: pose.accepted ? 1 : 0 },
    lampB: { opacity: pose.delivered ? 1 : 0 },
    said0: { opacity: pose.said[0] ? 1 : 0 },
    said1: { opacity: pose.said[1] ? 1 : 0 },
    said2: { opacity: pose.said[2] ? 1 : 0 },
    arc: { opacity: Math.round(pose.traced * 100) / 100 },
    trace: { strokeDashoffset: Math.round((1 - behind) * 1e4) / 1e4 },
    pingA: ping(pose.pings[0]),
    pingB: ping(pose.pings[1]),
  }
  // Each turn of the spring goes its share of the plunger's way.
  for (let index = 0; index < COILS; index++) styles[`coil${index}`] = { transform: slide(pose.plunger * (index + 1) / (COILS + 1)) }
  return styles
}

// The loop as keyframes for each part: the model sampled 120 times a second and at each instant something starts,
// with the stretches where a part holds still left as two frames.
export function tracksOf(bench: Bench): Record<Part, Keyframe[]> {
  const speed = bench.spec.second / 1000, push = 2 * DRAW / speed
  const times = new Set<number>()
  for (let t = 0; t <= LOOP_MS; t += 1000 / 120) times.add(Math.round(t * 100) / 100)
  for (const at of [
    LAUNCH_MS - push - HOLD_MS - WIND_MS, LAUNCH_MS - push - HOLD_MS, LAUNCH_MS - push, LAUNCH_MS, LAUNCH_MS + ACCEPTED_MS, LAUNCH_MS + ACCEPTED_MS + SAY_MS, LAUNCH_MS + DELIVERED_MS, LAUNCH_MS + DELIVERED_MS + SAY_MS,
    LAUNCH_MS + bench.rest / speed, LAUNCH_MS + STROKE / speed, LAUNCH_MS + ACCEPTED_MS + PING_MS, LAUNCH_MS + DELIVERED_MS + PING_MS,
    RESET_MS, RESET_MS + FLY_MS, RESET_MS + CLEAR_MS, ...OUT_MS.map(ms => RESET_MS + ms), RESET_MS + LIFT_FROM, RESET_MS + LIFT_FROM + LIFT_MS, RETURN_FROM, DROP_FROM, DROP_FROM + DROP_MS, RETURN_FROM + RETURN_MS, LOOP_MS,
  ]) {
    times.add(at); times.add(at - .5)
  }
  const tracks = {} as Record<Part, Keyframe[]>
  for (const time of [...times].sort((a, b) => a - b)) {
    if (time < 0 || time > LOOP_MS) continue
    // The last frame is the loop's end, not its start: the hand is at twelve either way, a turn apart.
    const styles = stylesOf(poseAt(Math.min(time, LOOP_MS - .01), bench), bench)
    for (const part of Object.keys(styles) as Part[]) (tracks[part] ??= []).push({ offset: time / LOOP_MS, ...styles[part] })
  }
  const parts = Object.keys(tracks) as Part[]
  const same = (a: Keyframe, b: Keyframe) => a.transform === b.transform && a.opacity === b.opacity && a.strokeDashoffset === b.strokeDashoffset
  for (const part of parts) tracks[part] = tracks[part].filter((frame, index, all) => index === 0 || index === all.length - 1 || !same(frame, all[index - 1]!) || !same(frame, all[index + 1]!))
  return tracks
}
