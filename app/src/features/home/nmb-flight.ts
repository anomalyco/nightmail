// The flight on the "nmb" homepage: the page is a photographic plate one second across, and a letter thrown through
// it is exposed twenty times a second, as on a fixed-plate chronophotograph. Position along the page is time, so the
// throw runs at the measured medians (plans/homepage-nightmail/numbers.md, 2026-11-15): the API accepts it at 99 ms, a
// tenth of the way across, and it is delivered at 602 ms, six tenths of the way across.

export type Mode = 'wide' | 'tall'
export const PAGE_MS = 1000, ACCEPTED_MS = 99, DELIVERED_MS = 602, EXPOSURE_MS = 50
// The letter comes in from beyond the edge of the plate, so it is already moving as the request starts; once down, it
// takes a moment to drop flat.
const LEAD_MS = 70, SETTLE_MS = 260
// An envelope 100 wide is 68 tall.
const ASPECT = 0.68

// Where the letter is at t ms: `along` the time axis (a fraction of the plate), `cross` it in letter widths (height above
// the scale when wide, offset from its column when tall), raised `lift` letter widths, turned `flip` degrees about an
// axis lying in the letter at `axis` degrees from its long edge, and rolled `roll` degrees on the plate.
export type Pose = { t: number; along: number; cross: number; lift: number; flip: number; roll: number; axis: number }
export type Exposure = Pose & { front: boolean; light: number; steep: boolean }
// One throw. `enter` and `arc` (letter widths) shape its path. It comes in flap side out, `flip` degrees from square and
// rolled `roll`, turns over steadily, and touches down address side out on one corner, rolled `dive`.
type Throw = { enter: number; arc: number; sway: number; axis: number; flip: number; roll: number; dive: number }
export type Flight = { mode: Mode; shot: Throw; exposures: Exposure[]; rest: Pose }

const throws: Record<Mode, Throw[]> = {
  wide: [
    { enter: 1.25, arc: 5.6, sway: 0, axis: 0, flip: -196, roll: -26, dive: 15 },
    { enter: 1.55, arc: 4.8, sway: 0, axis: 90, flip: 164, roll: -30, dive: 11 },
    { enter: 1.0, arc: 6.2, sway: 0, axis: 0, flip: 196, roll: 20, dive: 17 },
  ],
  tall: [
    { enter: 0.06, arc: 0, sway: 0.2, axis: 0, flip: -196, roll: -14, dive: -9 },
    { enter: -0.06, arc: 0, sway: -0.18, axis: 90, flip: 164, roll: 12, dive: 8 },
    { enter: 0.04, arc: 0, sway: 0.24, axis: 0, flip: 196, roll: -10, dive: -11 },
  ],
}

const rad = (degrees: number) => degrees * Math.PI / 180
// How high the centre of a letter rolled `roll` degrees sits when its lowest corner is on the ground (letter widths).
const standing = (roll: number) => 0.5 * Math.abs(Math.sin(rad(roll))) + (ASPECT / 2) * Math.cos(rad(roll))

// In flight (t up to DELIVERED_MS, where a corner touches down).
function flying(t: number, mode: Mode, shot: Throw): Pose {
  const p = t / DELIVERED_MS, left = 1 - p, wide = mode === 'wide'
  const cross = wide
    // A thrown letter: steady across, a parabola up and down.
    ? shot.enter * left + standing(shot.dive) * p + shot.arc * p * left
    // A dropped one: steady down, swaying less each time.
    : shot.enter * left + shot.sway * Math.sin(Math.PI * 2.5 * p) * left
  const lean = wide ? 0 : -60 * shot.sway * Math.cos(Math.PI * 2.5 * p) * left
  // Nose up on the way in, nose down on the way out.
  const roll = shot.roll * Math.sign(left) * Math.abs(left) ** 1.2 + shot.dive * Math.max(0, p) ** 1.6 + lean
  return { t, along: t / PAGE_MS, cross, lift: wide ? 0 : (standing(shot.dive) - ASPECT / 2) * Math.max(0, p) ** 3, flip: shot.flip * left, roll, axis: shot.axis }
}

// Down: it pivots on the corner it landed on, rocks once past flat and lies still.
function settling(t: number, mode: Mode, shot: Throw): Pose {
  const s = Math.min(1, (t - DELIVERED_MS) / SETTLE_MS), wide = mode === 'wide'
  const roll = s >= 1 ? 0 : shot.dive * Math.exp(-5 * s) * Math.cos(2.2 * Math.PI * s)
  const height = standing(roll)
  return { t, along: DELIVERED_MS / PAGE_MS, cross: wide ? height : 0, lift: wide ? 0 : height - ASPECT / 2, flip: 0, roll, axis: shot.axis }
}

const poseAt = (t: number, mode: Mode, shot: Throw) => t <= DELIVERED_MS ? flying(t, mode, shot) : settling(t, mode, shot)

// The plate's lamp: above, to the left, in front.
const LAMP = (() => { const v = [-0.42, -0.5, 0.76], n = Math.hypot(...v); return v.map(x => x / n) })()

// Which side of the letter faces the lens, and how squarely that side faces the lamp (0 to 1).
function lit(pose: Pose) {
  const about = rad(pose.roll + pose.axis), sin = Math.sin(rad(pose.flip)), cos = Math.cos(rad(pose.flip))
  const normal = [sin * Math.sin(about), -sin * Math.cos(about), cos], front = cos >= 0, sign = front ? 1 : -1
  // Seen nearly edge-on, a side is a sliver too thin for its markings.
  return { front, light: Math.max(0, sign * (normal[0] * LAMP[0] + normal[1] * LAMP[1] + normal[2] * LAMP[2])), steep: Math.abs(cos) < 0.3 }
}

export function plan(run: number, mode: Mode): Flight {
  const shot = throws[mode][run % throws[mode].length], exposures: Exposure[] = []
  for (let t = 0; t < DELIVERED_MS - EXPOSURE_MS / 2; t += EXPOSURE_MS) { const pose = poseAt(t, mode, shot); exposures.push({ ...pose, ...lit(pose) }) }
  return { mode, shot, exposures, rest: poseAt(DELIVERED_MS + SETTLE_MS, mode, shot) }
}

// The flap side is the address side seen from behind: turned a further half turn about the letter's upright axis.
export const turn = (pose: Pose, face: 'front' | 'back' = 'front') => `perspective(var(--nmb-lens)) rotateZ(${(pose.roll + pose.axis).toFixed(2)}deg) rotateX(${pose.flip.toFixed(2)}deg) rotateZ(${(-pose.axis).toFixed(2)}deg)${face === 'back' ? ' rotateY(180deg)' : ''}`

// Plays one throw, `hold` ms from now. Every element is animated on the one timeline with its own delay, so the whole
// plate can be paused and sought as one (the request starts at `origin` ms on that timeline). Cancel the returned
// animations to clear the plate.
export function play(page: HTMLElement, flight: Flight, hold: number) {
  const stage = page.querySelector<HTMLElement>('.nmb-stage')!, live = stage.querySelector<HTMLElement>('.nmb-live')!, body = live.querySelector<HTMLElement>('.nmb-body')!
  const box = stage.getBoundingClientRect(), unit = live.offsetWidth, wide = flight.mode === 'wide', span = wide ? box.width : box.height
  const animations: Animation[] = [], origin = hold + LEAD_MS
  // Shown at its moment: a 1 ms fade, not a step (a step's end lands on either side of a rounding error and can stay off).
  const show = (element: Element, ms: number, from = 0) => animations.push(element.animate([{ opacity: from }, { opacity: 1 }], { duration: 1, delay: origin + ms, fill: 'both' }))

  // The letter itself, as an offset from where it comes to rest. Its two sides are turned in their own 3D space
  // (.nmb-body), so showing the letter (an opacity on .nmb-live) does not flatten them.
  const frames: Keyframe[] = [], step = 10, total = LEAD_MS + DELIVERED_MS + SETTLE_MS, count = Math.ceil(total / step)
  for (let i = 0; i <= count; i++) {
    const elapsed = Math.min(total, i * step), pose = poseAt(elapsed - LEAD_MS, flight.mode, flight.shot)
    const along = (pose.along - flight.rest.along) * span, cross = (pose.cross - flight.rest.cross) * unit, lift = (pose.lift - flight.rest.lift) * unit
    const [x, y] = wide ? [along, -cross] : [cross, along - lift]
    frames.push({ offset: elapsed / total, transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) ${turn(pose)}` })
  }
  animations.push(body.animate(frames, { duration: total, delay: hold, fill: 'both', easing: 'linear' }))
  show(live, -LEAD_MS)

  stage.querySelectorAll<HTMLElement>('[data-at]').forEach(element => show(element, Number(element.dataset.at)))
  // The captions under the scale light as their moment passes (the first throw only; they stay lit).
  page.querySelectorAll<HTMLElement>('[data-lit-at]').forEach(element => show(element, Number(element.dataset.litAt), Number(getComputedStyle(element).opacity)))

  // The scale is the stopwatch. It lights from the start of the page as far as the delivery, in step with the letter, and
  // the marker at its lit edge carries on alone to the end of the second. (A clipping box slides in while its content
  // slides back, so only transforms are animated.)
  const sweep = stage.querySelector<HTMLElement>('.nmb-sweep')!, lit = sweep.firstElementChild!, marker = stage.querySelector<HTMLElement>('.nmb-marker')!
  const axis = wide ? 'X' : 'Y', dark = 100 * (1 - DELIVERED_MS / PAGE_MS), taken = { duration: DELIVERED_MS, delay: origin, fill: 'both', easing: 'linear' } as const
  animations.push(sweep.animate([{ transform: `translate${axis}(-100%)` }, { transform: `translate${axis}(-${dark}%)` }], taken))
  animations.push(lit.animate([{ transform: `translate${axis}(100%)` }, { transform: `translate${axis}(${dark}%)` }], taken))
  animations.push(marker.animate([{ transform: `translate${axis}(0)` }, { transform: `translate${axis}(${span}px)` }], { duration: PAGE_MS, delay: origin, fill: 'both', easing: 'linear' }))
  animations.push(marker.animate([{ opacity: 0 }, { opacity: 1, offset: 0.001 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: PAGE_MS + 2, delay: origin - 1, fill: 'both' }))
  show(sweep, 0)
  page.dataset.origin = String(origin)
  return animations
}
