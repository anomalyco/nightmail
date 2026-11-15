// The coin of the "nmc" homepage study: a one-cent piece lying on a table, cut into fifty slices, on one canvas.
// A slice is the price of one email: RATES.emailUc (api/src/billing/money.ts) is $0.0002, a fiftieth of a cent.
// The coin spins down the way a dropped coin does, a cut travels round it, and one slice slides out and turns to lie
// in front of Sign in. Every few seconds that slice leaves and the next takes its place; a slice still in the coin
// lifts under the pointer and leaves when it is pressed. Fifty slices later the next cent lands. Pressing Sign in
// sends the waiting slice off through the button.

const TAU = Math.PI * 2
const SLICES = 50
const STEP = TAU / SLICES
// The camera looks down at the table from 34° off vertical. A cent is 1.52 mm thick and 19.05 mm across.
const TILT = 34 * Math.PI / 180, COS = Math.cos(TILT), SIN = Math.sin(TILT)
const THICK = 0.16
/** Height of the coin's box over its width: the top face's ellipse and the edge that shows below it. */
export const COIN_ASPECT = COS + THICK * SIN / 2

// Lengths below are in coin radii unless they say px or ms.
const CUT = 0.003       // width of a cut
const SEAM_PX = 0.45    // uncut slices overlap by this much, so no hairline shows between them
const PHASE = STEP / 4  // the slices are turned a quarter step, so no cut lies on the coin's vertical or horizontal
const LIFT = 0.085      // how far a slice under the pointer slides out
const ARC = 4           // segments in a slice's rim

// Timeline of the intro, in ms.
const SPIN = 1250, HOLD = 110, WAVE_STEP = 13, BUMP = 210, CUT_MS = 90, WAVE_AMP = 0.052
const FIRST_SEND = 3600, SEND_EVERY = 6400, DART = 360, NEXT_AFTER = 200, REMINT_AFTER = 900
const BUSY_PERIOD = 1100, BUSY_WIDTH = 0.2, BUSY_AMP = 0.06
// The spin-down of a coin on a table (Euler's disk): the tilt falls as (t0 − t)^(1/3) while the rim's contact point
// circles faster as (t0 − t)^(−1/6), then everything stops at once (Moffatt, Nature 404, 2000).
const TILT_RIGHT = 40 * Math.PI / 180, TILT_DOWN = 16 * Math.PI / 180, WOBBLE_HZ = 2.3

// The face: a rim line, fifty envelopes and the denomination, in a unit circle with y down.
const RIM_R = 0.953, RIM_W = 0.011
const ENV_R = 0.842, ENV_W = 0.074, ENV_H = 0.05, ENV_LINE = 0.0085, ENV_FLAP = 0.6
// "1" and "¢" from OpenTUI Mono Bold (app/public/fonts, SIL OFL), 1000 units to the em with a 690-unit cap height,
// so the denomination is on the coin's first frame whether or not the web font has arrived.
const GLYPH_ONE = 'M271 0V568L169 474L103 535L271 690H389V0Z'
const GLYPH_CENT = 'M248 0V80Q226 83 205.0 88.5Q184 94 164.5 103.5Q145 113 128.0 127.0Q111 141 99.0 159.5Q87 178 82.0 199.0Q77 220 77 242V448Q77 470 82.0 491.0Q87 512 99.0 530.5Q111 549 128.0 563.0Q145 577 164.5 586.5Q184 596 205.0 601.5Q226 607 248 610V690H352V610Q396 604 437.0 589.5Q478 575 515 551V416H411V489Q394 497 375.5 502.0Q357 507 338 510V180Q357 183 375.5 188.0Q394 193 411 201V274H515V139Q478 115 437.0 100.5Q396 86 352 80V0ZM262 181V509Q250 507 238.5 502.5Q227 498 217.0 490.5Q207 483 201.5 471.5Q196 460 196 448V242Q196 230 201.5 218.5Q207 207 217.0 199.5Q227 192 238.5 187.5Q250 183 262 181Z'
const CAP_UNITS = 690, ONE_LEFT = 103, ONE_WIDTH = 286, CENT_LEFT = 77, CENT_WIDTH = 438, GLYPH_GAP = 92
const CAP = 0.7

type RGB = [number, number, number]
type Palette = { top: RGB; rim: RGB; edge: RGB; wall: RGB; ink: RGB; hot: RGB; hotInk: RGB }
// out: 0 in the coin, 1 lying in front of Sign in. lift: slid out a little under the pointer. fly: when it left, or 0.
type Slice = { out: number; outVel: number; lift: number; liftVel: number; cut: number; gone: boolean; fly: number; from: number }

const css = ([r, g, b]: RGB) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t) }
// Out fast, back slowly: the push a slice gets as the cut passes it.
const bump = (x: number) => x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x ** 0.55)

export type Coin = { setBusy: (busy: boolean) => void; destroy: () => void }

export function mountCoin(canvas: HTMLCanvasElement, slot: HTMLElement, { reduced }: { reduced: boolean }): Coin {
  const ctx = canvas.getContext('2d')!
  const one = new Path2D(GLYPH_ONE), cent = new Path2D(GLYPH_CENT)
  const probe = document.createElement('span')
  probe.style.display = 'none'
  slot.appendChild(probe)

  let dpr = 1, width = 0, height = 0, R = 0, cx = 0, cy = 0, aim = 0, pull = 1
  let palette!: Palette, cold!: HTMLCanvasElement, hot!: HTMLCanvasElement
  let raf = 0, timer = 0, next = 0, dead = false, start = performance.now(), last = start
  // tray: the slice lying in front of Sign in, or on its way there.
  let cutDone = reduced, tray = reduced ? 0 : -1, hover = -1, busyAt = 0
  const slices: Slice[] = Array.from({ length: SLICES }, (_, index) => ({ out: reduced && index === 0 ? 1 : 0, outVel: 0, lift: 0, liftVel: 0, cut: reduced ? 1 : 0, gone: false, fly: 0, from: 0 }))
  // Slices leave from the one nearest Sign in outwards, a side at a time: the opening stays aimed at the button.
  const order = Array.from({ length: SLICES }, (_, n) => n === 0 ? 0 : n % 2 ? SLICES - (n + 1) / 2 : n / 2)
  // How many slices a slice is from the far side of the coin, where the cut starts.
  const rank = (index: number) => SLICES / 2 - Math.min(index, SLICES - index)
  // A slice's direction from the coin's centre, and how far that is round from the direction of Sign in.
  const turn = (index: number) => PHASE + (index <= SLICES / 2 ? index : index - SLICES) * STEP
  const angle = (index: number) => aim + turn(index)
  const nextFree = () => order.find(index => !slices[index].gone && !slices[index].fly) ?? -1

  // A colour token as numbers. The tokens used are plain sRGB colours, which every browser computes to rgb(r, g, b).
  function color(name: string): RGB {
    probe.style.color = `var(${name})`
    const [r = 0, g = 0, b = 0] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
    return [r, g, b]
  }

  // numeral is how strongly the denomination shows: the slice that has left the coin is plain but for its envelope.
  function paintFace(c: CanvasRenderingContext2D, top: string, rim: string, ink: string, numeral = 1) {
    c.fillStyle = rim
    c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill()
    c.fillStyle = top
    c.beginPath(); c.arc(0, 0, RIM_R, 0, TAU); c.fill()
    c.strokeStyle = ink; c.lineWidth = RIM_W
    c.beginPath(); c.arc(0, 0, RIM_R, 0, TAU); c.stroke()
    c.fillStyle = ink; c.strokeStyle = top; c.lineWidth = ENV_LINE; c.lineJoin = 'miter'
    for (let index = 0; index < SLICES; index++) {
      const a = angle(index), x = Math.cos(a) * ENV_R - ENV_W / 2, y = Math.sin(a) * ENV_R - ENV_H / 2
      c.fillRect(x, y, ENV_W, ENV_H)
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + ENV_W / 2, y + ENV_H * ENV_FLAP); c.lineTo(x + ENV_W, y); c.stroke()
    }
    if (numeral <= 0) return
    const scale = CAP / CAP_UNITS, span = ONE_WIDTH + GLYPH_GAP + CENT_WIDTH
    c.save()
    c.globalAlpha *= numeral
    c.translate(-span / 2 * scale, CAP / 2)
    c.scale(scale, -scale)
    c.fillStyle = ink
    c.translate(-ONE_LEFT, 0); c.fill(one)
    c.translate(ONE_LEFT + ONE_WIDTH + GLYPH_GAP - CENT_LEFT, 0); c.fill(cent, 'evenodd')
    c.restore()
  }

  // The flat coin's face as the camera sees it, at device resolution: slices still in the coin are cut out of it.
  function face(top: RGB, rim: RGB, ink: RGB) {
    const sheet = document.createElement('canvas')
    sheet.width = Math.ceil((2 * R + 2) * dpr); sheet.height = Math.ceil((2 * R * COS + 2) * dpr)
    const c = sheet.getContext('2d')!
    c.setTransform(R * dpr, 0, 0, R * COS * dpr, (R + 1) * dpr, (R * COS + 1) * dpr)
    paintFace(c, css(top), css(rim), css(ink))
    return sheet
  }

  function layout() {
    const page = canvas.getBoundingClientRect(), box = slot.getBoundingClientRect(), style = getComputedStyle(slot)
    dpr = Math.min(window.devicePixelRatio || 1, 3)
    width = page.width; height = page.height
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    R = box.width / 2
    const snap = (value: number) => Math.round(value * dpr) / dpr
    cx = snap(box.left - page.left + R); cy = snap(box.top - page.top + R * COS)
    aim = style.getPropertyValue('--nmc-aim').trim() === 'down' ? Math.PI / 2 : 0
    pull = Number(style.getPropertyValue('--nmc-pull')) || 1
    // The coin is one metal in both themes: a lighter raised rim, a darker edge, darker cut walls and engraving. The
    // top of a slice that has left takes Sign in's colours.
    const metal = color('--nmc-coin'), white: RGB = [255, 255, 255], black: RGB = [0, 0, 0]
    palette = { top: metal, rim: mix(metal, white, 0.16), edge: mix(metal, black, 0.38), wall: mix(metal, black, 0.6), ink: mix(metal, black, 0.78), hot: color('--nmc-hot'), hotInk: color('--nmc-hot-ink') }
    if (R > 0) { cold = face(palette.top, palette.rim, palette.ink); hot = face(palette.hot, palette.hot, palette.hotInk) }
  }

  const quad = (x0: number, y0: number, x1: number, y1: number, drop: number) => {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 + drop); ctx.lineTo(x0, y0 + drop); ctx.closePath(); ctx.fill()
  }

  // The whole coin, tilted by alpha towards azimuth phi and turned by psi about its own axis, with its lowest rim point on the table.
  function drawSolid(alpha: number, phi: number, psi: number) {
    const T = THICK * R, sa = Math.sin(alpha), ca = Math.cos(alpha), sp = Math.sin(phi), cp = Math.cos(phi)
    // Rz(phi) · Ry(alpha) · Rz(−phi) · Rz(psi): e1 and e2 span the face, n is its normal.
    const spin = (x: number, y: number): [number, number, number] => {
      const x1 = x * Math.cos(psi - phi) - y * Math.sin(psi - phi), y1 = x * Math.sin(psi - phi) + y * Math.cos(psi - phi)
      const x2 = x1 * ca, z2 = -x1 * sa
      return [x2 * cp - y1 * sp, x2 * sp + y1 * cp, z2]
    }
    const e1 = spin(1, 0), e2 = spin(0, 1), n: [number, number, number] = [sa * cp, sa * sp, ca]
    const project = (x: number, y: number, z: number): [number, number] => [x, y * COS - z * SIN]
    const [ox, oy] = project(T * n[0], T * n[1], R * sa + T * n[2])
    const originX = cx + ox, originY = cy + T * SIN + oy
    const [ax, ay] = project(e1[0] * R, e1[1] * R, e1[2] * R), [bx, by] = project(e2[0] * R, e2[1] * R, e2[2] * R)
    const [tx, ty] = project(-T * n[0], -T * n[1], -T * n[2])
    ctx.fillStyle = ctx.strokeStyle = css(palette.edge); ctx.lineWidth = 0.5
    const steps = 120
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps * TAU, t1 = (k + 1) / steps * TAU, tm = (t0 + t1) / 2
      const my = Math.cos(tm) * e1[1] + Math.sin(tm) * e2[1], mz = Math.cos(tm) * e1[2] + Math.sin(tm) * e2[2]
      if (my * SIN + mz * COS <= 0) continue
      const x0 = originX + Math.cos(t0) * ax + Math.sin(t0) * bx, y0 = originY + Math.cos(t0) * ay + Math.sin(t0) * by
      const x1 = originX + Math.cos(t1) * ax + Math.sin(t1) * bx, y1 = originY + Math.cos(t1) * ay + Math.sin(t1) * by
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 + tx, y1 + ty); ctx.lineTo(x0 + tx, y0 + ty); ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    ctx.save()
    ctx.transform(ax, ay, bx, by, originX, originY)
    paintFace(ctx, css(palette.top), css(palette.rim), css(palette.ink))
    ctx.restore()
  }

  // A slice's whole wedge of the coin, cuts included: its top and the edge below it.
  function footprint(index: number) {
    const a0 = angle(index) - STEP / 2, a1 = a0 + STEP, drop = THICK * R * SIN
    ctx.beginPath(); ctx.moveTo(cx, cy)
    for (let k = 0; k <= ARC; k++) { const t = a0 + STEP * k / ARC; ctx.lineTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R * COS) }
    ctx.closePath(); ctx.fill()
    if (Math.sin(a0) > 0 || Math.sin(a1) > 0) quad(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R * COS, cx + Math.cos(a1) * R, cy + Math.sin(a1) * R * COS, drop)
  }

  // One slice, slid off along its own direction and turned by rot about the coin's centre. heat is how far it has
  // taken the colour of Sign in.
  function drawSlice(index: number, off: number, rot: number, heat: number, numeral: number) {
    const slice = slices[index], a = angle(index) + rot
    const snap = (value: number) => Math.round(value * dpr) / dpr
    const dx = snap(Math.cos(a) * off * R), dy = snap(Math.sin(a) * off * R * COS)
    const inset = CUT * R / 2 * slice.cut - SEAM_PX * (1 - slice.cut)
    const half = STEP / 2, tip = Math.max(0, inset / Math.sin(half)), lean = Math.asin(clamp(inset / R, -1))
    const a0 = a - half + lean, a1 = a + half - lean, drop = THICK * R * SIN
    const px = (x: number) => cx + dx + x, py = (y: number) => cy + dy + y * COS
    const tipX = px(Math.cos(a) * tip), tipY = py(Math.sin(a) * tip)
    const rim: [number, number, number][] = []
    for (let k = 0; k <= ARC; k++) { const t = a0 + (a1 - a0) * k / ARC; rim.push([px(Math.cos(t) * R), py(Math.sin(t) * R), t]) }
    // Walls that face the camera: the cut on the slice's south side, then its piece of the coin's edge. Only the top
    // of a slice changes colour; its sides stay the coin's metal.
    ctx.fillStyle = css(palette.wall)
    if (-Math.cos(a - half) > 0.001) quad(tipX, tipY, rim[0][0], rim[0][1], drop)
    if (Math.cos(a + half) > 0.001) quad(rim[ARC][0], rim[ARC][1], tipX, tipY, drop)
    ctx.fillStyle = css(palette.edge)
    for (let k = 0; k < ARC; k++) if (Math.sin((rim[k][2] + rim[k + 1][2]) / 2) > 0) quad(rim[k][0], rim[k][1], rim[k + 1][0], rim[k + 1][1], drop)
    ctx.save()
    ctx.beginPath(); ctx.moveTo(tipX, tipY)
    for (const [x, y] of rim) ctx.lineTo(x, y)
    ctx.closePath(); ctx.clip()
    if (rot || numeral < 1) {
      // A slice on its way out is painted afresh: turned, it stays sharp, and its piece of the denomination fades.
      ctx.transform(R * Math.cos(rot), R * COS * Math.sin(rot), -R * Math.sin(rot), R * COS * Math.cos(rot), cx + dx, cy + dy)
      paintFace(ctx, css(mix(palette.top, palette.hot, heat)), css(mix(palette.rim, palette.hot, heat)), css(mix(palette.ink, palette.hotInk, heat)), numeral)
    } else {
      const left = cx + dx - R - 1, top = cy + dy - R * COS - 1, w = cold.width / dpr, h = cold.height / dpr
      if (heat < 1) ctx.drawImage(cold, left, top, w, h)
      if (heat > 0) { ctx.globalAlpha = heat; ctx.drawImage(hot, left, top, w, h) }
    }
    ctx.restore()
  }

  function frame(now: number) {
    raf = 0
    const dt = Math.min(48, now - last), t = now - start
    last = now
    let moving = false
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!R) return
    if (!reduced && t < SPIN) {
      const left = 1 - t / SPIN, tilt0 = aim ? TILT_DOWN : TILT_RIGHT
      const alpha = tilt0 * Math.cbrt(left)
      const phi = -Math.PI / 2 + TAU * WOBBLE_HZ * SPIN / 1000 * 1.2 * (1 - left ** (5 / 6))
      // Rolling without slipping turns the face slowly against the wobble; it ends upright.
      const psi = -TAU * WOBBLE_HZ * SPIN / 1000 * (1 - Math.cos(tilt0)) * 0.55 * left ** 1.5
      drawSolid(alpha, phi, psi)
      raf = requestAnimationFrame(frame)
      return
    }
    const wave = t - SPIN - HOLD
    if (!cutDone) {
      moving = true
      for (let index = 0; index < SLICES; index++) slices[index].cut = clamp((wave - rank(index) * WAVE_STEP) / CUT_MS)
      if (tray < 0 && wave >= SLICES / 2 * WAVE_STEP) tray = 0
      if (wave >= SLICES / 2 * WAVE_STEP + BUMP + CUT_MS) { cutDone = true; schedule(FIRST_SEND) }
    }
    const pose = slices.map(() => ({ off: 0, rot: 0, heat: 0, numeral: 1 }))
    for (let index = 0; index < SLICES; index++) {
      const slice = slices[index], at = pose[index]
      if (slice.gone) continue
      // Springs, stepped in 4 ms slices so a long frame can't throw them: out has no overshoot to speak of, lift a little.
      // A slice that has left keeps the pose it left in.
      const outTo = index === tray ? 1 : 0, liftTo = index === hover && index !== tray ? LIFT : 0
      for (let step = slice.fly ? 0 : dt; step > 0; step -= 4) {
        const h = Math.min(4, step) / 1000
        slice.outVel += (150 * (outTo - slice.out) - 21 * slice.outVel) * h; slice.out += slice.outVel * h
        slice.liftVel += (520 * (liftTo - slice.lift) - 30 * slice.liftVel) * h; slice.lift += slice.liftVel * h
      }
      if (!slice.fly) {
        if (Math.abs(outTo - slice.out) < 0.0005 && Math.abs(slice.outVel) < 0.005) { slice.out = outTo; slice.outVel = 0 } else moving = true
        if (Math.abs(liftTo - slice.lift) < 0.0004 && Math.abs(slice.liftVel) < 0.004) { slice.lift = liftTo; slice.liftVel = 0 } else moving = true
      }
      // It slides clear of the coin first, then swings round to lie on the line from the coin to Sign in.
      at.off = pull * slice.out + slice.lift
      at.rot = -turn(index) * smooth((slice.out - 0.5) / 0.45)
      at.heat = clamp(slice.out * 1.7) + slice.lift / LIFT * 0.55
      at.numeral = 1 - smooth(slice.out * 2.2)
      if (!cutDone && index !== 0) { const push = bump((wave - rank(index) * WAVE_STEP) / BUMP); at.off += WAVE_AMP * push; at.heat += push * 0.4 }
      if (busyAt) {
        const along = (((now - busyAt) / BUSY_PERIOD - index / SLICES) % 1 + 1) % 1
        if (along < BUSY_WIDTH && slice.out < 0.5) { const push = Math.sin(Math.PI * along / BUSY_WIDTH); at.off += BUSY_AMP * push; at.heat += push * 0.5 }
        moving = true
      }
      if (slice.fly) {
        const k = (now - slice.fly) / DART
        if (k >= 1) { Object.assign(slice, { gone: true, fly: 0, out: 0, outVel: 0, lift: 0, liftVel: 0 }); continue }
        // A short draw back, then away until it is off the page.
        at.off = slice.from - 0.05 * Math.sin(Math.PI * clamp(k / 0.3)) + (reach(angle(index) + at.rot) - slice.from) * clamp((k - 0.22) / 0.78) ** 2.4
        at.heat = 1
        moving = true
      }
      at.heat = clamp(at.heat)
    }
    // Under the slices that are in place, their footprint in the colour of a cut's wall: a closed cut is too narrow
    // and too deep to see the table through, so it shows as that colour and never as the page's.
    ctx.fillStyle = css(palette.wall)
    for (let index = 0; index < SLICES; index++) if (!slices[index].gone && !pose[index].off && !pose[index].rot) footprint(index)
    // Far slices first: a slice's south wall hangs over the one in front of it, which is drawn after.
    const depth = (index: number) => Math.sin(angle(index) + pose[index].rot) * (2 / 3 + pose[index].off)
    for (const index of slices.map((_, index) => index).filter(index => !slices[index].gone).sort((a, b) => depth(a) - depth(b))) drawSlice(index, pose[index].off, pose[index].rot, pose[index].heat, pose[index].numeral)
    if (cutDone && slices.every(slice => slice.gone) && !timer) timer = window.setTimeout(remint, REMINT_AFTER)
    if (moving) raf = requestAnimationFrame(frame)
  }

  // How far, in radii, a slice travels in a direction before all of it has left the canvas.
  function reach(a: number) {
    const ux = Math.cos(a), uy = Math.sin(a) * COS
    const toX = ux > 0 ? (width - cx) / ux : ux < 0 ? -cx / ux : Infinity, toY = uy > 0 ? (height - cy) / uy : uy < 0 ? -cy / uy : Infinity
    return Math.min(toX, toY) / R + 0.2
  }

  const kick = () => { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(frame) } }

  function send(index: number) {
    const slice = slices[index]
    if (!cutDone || !slice || slice.gone || slice.fly) return
    slice.fly = performance.now(); slice.from = pull * slice.out + slice.lift
    if (tray === index) {
      tray = -1
      window.clearTimeout(next)
      next = window.setTimeout(() => { if (tray < 0) { tray = nextFree(); kick() } }, NEXT_AFTER)
    }
    if (hover === index) hover = -1
    kick()
  }

  function schedule(delay: number) {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = 0
      if (document.hidden || hover >= 0 || busyAt) { schedule(SEND_EVERY); return }
      if (tray >= 0) send(tray)
      if (slices.some(slice => !slice.gone && !slice.fly)) schedule(SEND_EVERY)
    }, delay)
  }

  // Fifty slices later the cent is spent: the next one lands.
  function remint() {
    timer = 0
    for (const slice of slices) Object.assign(slice, { out: 0, outVel: 0, lift: 0, liftVel: 0, cut: 0, gone: false, fly: 0, from: 0 })
    cutDone = false; tray = -1; hover = -1
    start = performance.now()
    kick()
  }

  // The slice under a pointer, or −1: first the one lying in front of Sign in, then those still in the coin.
  function sliceAt(event: PointerEvent) {
    const page = canvas.getBoundingClientRect()
    const x = event.clientX - page.left - cx, y = (event.clientY - page.top - cy) / COS
    const radius = Math.hypot(x, y) / R, around = Math.atan2(y, x) - aim
    if (tray >= 0 && slices[tray].out > 0.9 && !slices[tray].fly) {
      const along = radius * Math.cos(around) - pull, across = Math.abs(radius * Math.sin(around))
      if (along > 0 && along < 1.02 && across < along * Math.tan(STEP / 2) + 0.012) return tray
    }
    if (radius < 0.08 || radius > 1.02) return -1
    const index = ((Math.round((around - PHASE) / STEP) % SLICES) + SLICES) % SLICES
    return slices[index].gone || slices[index].fly || index === tray ? -1 : index
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || !cutDone) return
    const index = sliceAt(event)
    if (index !== hover) { hover = index; kick() }
  }
  const onLeave = () => { if (hover >= 0) { hover = -1; kick() } }
  const onDown = (event: PointerEvent) => { if (event.button === 0) send(sliceAt(event)) }

  const redraw = () => { layout(); kick() }
  const resize = new ResizeObserver(redraw)
  resize.observe(canvas); resize.observe(slot)
  // The theme toggle swaps the page's colours: the coin is repainted in them.
  const theme = new MutationObserver(redraw)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const stage = canvas.parentElement!
  if (!reduced) {
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerleave', onLeave)
    stage.addEventListener('pointerdown', onDown)
  }
  layout()
  kick()

  return {
    // Sign-in has started: the slice lying in front of the button leaves through it, and a ripple runs round the coin
    // until the page goes.
    setBusy(busy) {
      if (reduced || !!busyAt === busy) return
      busyAt = busy ? performance.now() : 0
      if (busy && tray >= 0 && slices[tray].out > 0.9) send(tray)
      kick()
    },
    destroy() {
      dead = true
      cancelAnimationFrame(raf); window.clearTimeout(timer); window.clearTimeout(next)
      resize.disconnect(); theme.disconnect()
      stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerleave', onLeave); stage.removeEventListener('pointerdown', onDown)
      probe.remove()
    },
  }
}
