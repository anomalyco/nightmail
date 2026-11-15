// The letterbox scene behind the "letters" homepage: a letter plate on the wall, envelopes pushed through it one at a
// time and then in a flood (with a few down the chimney and under the door), piling up on the floor; the 1,001st jams in
// the slot. Canvas 2D at a fixed 120 Hz step from a seeded random source, so every load and the reduced-motion end state
// build the same pile. An envelope that has settled is drawn once into an offscreen pile, so a frame draws only the
// plate, that pile and the envelopes still moving (at most a few hundred sprites).

export const TOTAL = 1000
const STEP = 1 / 120
const FIRST = 0.25, FIRST_GAP = 0.34, GAP_RATIO = 0.8, MIN_GAP = 1 / 520
const SETTLE = 0.13
// The 1,001st is a size larger than the rest: the one that doesn't fit.
const JAMMED = 1.55
const COL = 2

// The Stamp mark (components/BaneLogo.tsx) in its 100 × 100 box: the stamp on every envelope.
const MARK = 'M0 0L4.84 0A5.16 5.16 0 0 0 15.16 0L24.84 0A5.16 5.16 0 0 0 35.16 0L44.84 0A5.16 5.16 0 0 0 55.16 0L64.84 0A5.16 5.16 0 0 0 75.16 0L84.84 0A5.16 5.16 0 0 0 95.16 0L100 0L100 4.84A5.16 5.16 0 0 0 100 15.16L100 24.84A5.16 5.16 0 0 0 100 35.16L100 44.84A5.16 5.16 0 0 0 100 55.16L100 64.84A5.16 5.16 0 0 0 100 75.16L100 84.84A5.16 5.16 0 0 0 100 95.16L100 100L95.16 100A5.16 5.16 0 0 0 84.84 100L75.16 100A5.16 5.16 0 0 0 64.84 100L55.16 100A5.16 5.16 0 0 0 44.84 100L35.16 100A5.16 5.16 0 0 0 24.84 100L15.16 100A5.16 5.16 0 0 0 4.84 100L0 100L0 95.16A5.16 5.16 0 0 0 0 84.84L0 75.16A5.16 5.16 0 0 0 0 64.84L0 55.16A5.16 5.16 0 0 0 0 44.84L0 35.16A5.16 5.16 0 0 0 0 24.84L0 15.16A5.16 5.16 0 0 0 0 4.84L0 0ZM16.98 16.98L83.02 16.98L83.02 83.02L16.98 83.02ZM23.91 23.91L76.09 23.91L76.09 76.09L23.91 76.09ZM31.48 31.48L68.52 31.48L68.52 68.52L31.48 68.52ZM37.63 37.63L62.37 37.63L62.37 62.37L37.63 62.37Z'
// Addressed, then blurred: the dashboard masks addresses the same way.
const ADDRESSES = [['ada lovelace', 'ada@northwind.example'], ['orders', 'receipts@lumen.example'], ['m. curie', 'marie@harbor.example'], ['support', 'help@driftwood.example']]

type Mode = 'wide' | 'stacked'
type Geometry = {
  w: number; h: number; mode: Mode; floor: number; k: number
  slot: { cx: number; cy: number; plateW: number; plateH: number; openW: number; openH: number; openY: number }
  env: { w: number; h: number }
  area: number; slope: number; spread: number; bias: number; chimney: [number, number] | null
}
type Colors = { paper: string; line: string; ink: string; stamp: string; plate: string; plateLine: string; opening: string; flap: string; engraving: string; note: string; faint: string; floor: string }
type Pose = { x: number; y: number; r: number; sy: number; s: number; front: number; back: number }
type Letter = Pose & {
  vx: number; vy: number; vr: number; f: number; vf: number; sway: number; swayAt: number
  source: 'slot' | 'chimney' | 'door'; state: 'flying' | 'settling'; clip: boolean
  t0: number; from: { x: number; y: number; r: number; sy: number }; to: { x: number; y: number; r: number; sy: number }
}

function random(seed: number) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// When each of the thousand arrives: a gap that shrinks by a fifth each time, from a third of a second to 1/520 s.
const schedule = (() => {
  const times: number[] = [], gaps: number[] = []
  for (let t = FIRST, gap = FIRST_GAP; times.length < TOTAL; t += gap, gap = Math.max(MIN_GAP, gap * GAP_RATIO)) { times.push(t); gaps.push(gap) }
  return { times, intensity: gaps.map(gap => Math.min(1, Math.max(0, Math.log(FIRST_GAP / gap) / Math.log(FIRST_GAP / MIN_GAP)))) }
})()
export const introSeconds = schedule.times[TOTAL - 1] + 1

function geometry(w: number, h: number, mode: Mode): Geometry {
  if (mode === 'wide') {
    const env = w >= 1200 ? { w: 46, h: 30 } : { w: 40, h: 26 }, k = env.w / 46
    const content = Math.min(w, 1232) - 64, left = (w - Math.min(w, 1232)) / 2 + 32
    const cx = left + content * 0.7, plateW = 340 * k, plateH = 96 * k, cy = Math.max(110, h * 0.21)
    const peak = Math.min(240, h * 0.31), slope = 0.68
    return { w, h, mode, floor: h - 1, k, env, slope, area: peak * peak / slope / TOTAL, spread: 430 * k, bias: 0, chimney: [cx - 300 * k, Math.min(w - 20, cx + 320 * k)],
      slot: { cx, cy, plateW, plateH, openW: 268 * k, openH: 20 * k, openY: cy + 2 * k } }
  }
  const env = w < 480 ? { w: 30, h: 20 } : { w: 38, h: 25 }, k = env.w / 46
  const plateW = Math.min(300 * k + 4, w * 0.56), plateH = 84 * k + 4, cy = plateH / 2 + 10
  const peak = Math.min(150, h * 0.44), slope = 0.72
  return { w, h, mode, floor: h - 1, k, env, slope, area: peak * peak / slope / TOTAL, spread: 300 * k, bias: 0, chimney: null,
    slot: { cx: w / 2, cy, plateW, plateH, openW: plateW * 0.78, openH: 18 * k + 2, openY: cy - 2 * k } }
}

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement), v = (name: string) => css.getPropertyValue(name).trim()
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    paper: v('--color-surface'), line: dark ? 'rgb(255 255 255 / 30%)' : 'rgb(0 0 0 / 26%)', ink: v('--color-muted'), stamp: v('--color-brand'),
    plate: dark ? v('--color-layer-1') : v('--color-surface'), plateLine: v('--color-border-strong'), opening: dark ? '#000000' : v('--color-contrast'),
    flap: v('--color-layer-2'), engraving: v('--color-faint'), note: v('--color-muted'), faint: v('--color-faint'), floor: v('--color-border-strong'),
  }
}

const mark = typeof Path2D === 'function' ? new Path2D(MARK) : null

// Envelope faces drawn once per theme and size: four fronts (a blurred address and the stamp) and two backs.
function sprites(env: Geometry['env'], scale: number, colors: Colors) {
  const pad = 2, make = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil((env.w + pad * 2) * scale); canvas.height = Math.ceil((env.h + pad * 2) * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale); ctx.translate(pad, pad)
    ctx.fillStyle = colors.paper; ctx.fillRect(0, 0, env.w, env.h)
    draw(ctx)
    ctx.strokeStyle = colors.line; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, env.w - 1, env.h - 1)
    return canvas
  }
  const fronts = ADDRESSES.map(([name, address], index) => make(ctx => {
    const stamp = env.h * 0.3, margin = env.h * 0.12
    if (mark) { ctx.save(); ctx.translate(env.w - stamp - margin, margin); ctx.scale(stamp / 100, stamp / 100); ctx.fillStyle = colors.stamp; ctx.fill(mark, 'evenodd'); ctx.restore() }
    // Drawn small and scaled up: a blur that costs nothing per frame and works in every browser.
    const shrink = 4, blur = document.createElement('canvas'), bw = Math.ceil(env.w * scale / shrink), bh = Math.ceil(env.h * scale / shrink)
    blur.width = bw; blur.height = bh
    const b = blur.getContext('2d')!
    b.scale(scale / shrink, scale / shrink)
    b.fillStyle = colors.ink; b.font = `${env.h * 0.17}px sans-serif`; b.textBaseline = 'middle'
    const x = env.w * (0.26 + 0.04 * (index % 2))
    b.fillText(name, x, env.h * 0.56); b.fillText(address, x, env.h * 0.76)
    ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.85; ctx.drawImage(blur, 0, 0, env.w, env.h * bh * shrink / scale / env.h); ctx.globalAlpha = 1
  }))
  const backs = [0.52, 0.58].map(apex => make(ctx => {
    ctx.strokeStyle = colors.line; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0.5, 0.5); ctx.lineTo(env.w / 2, env.h * apex); ctx.lineTo(env.w - 0.5, 0.5)
    ctx.moveTo(0.5, env.h - 0.5); ctx.lineTo(env.w * 0.42, env.h * (apex - 0.04)); ctx.moveTo(env.w - 0.5, env.h - 0.5); ctx.lineTo(env.w * 0.58, env.h * (apex - 0.04)); ctx.stroke()
    ctx.fillStyle = colors.stamp; ctx.beginPath(); ctx.arc(env.w / 2, env.h * apex, env.h * 0.075, 0, Math.PI * 2); ctx.fill()
  }))
  return { fronts, backs, pad }
}

type Options = { reduced: boolean; onCount: (count: number) => void; onDone: () => void }

export function mountLetters(canvas: HTMLCanvasElement, { reduced, onCount, onDone }: Options) {
  const ctx = canvas.getContext('2d')!
  const pile = document.createElement('canvas'), pileCtx = pile.getContext('2d')!
  let g: Geometry, colors = readColors(), art: ReturnType<typeof sprites>, dpr = 1
  let heights = new Float32Array(1), settled: Pose[] = [], letters: Letter[] = []
  let rand = random(1), time = 0, next = 0, count = 0, shown = -1, flap = 0, finished = false, notified = false
  let stuck: { at: number; x: number; y: number; r: number } | null = null
  let frame = 0, last = 0, wiggleAt = 0, wiggleTimer = 0, fontsReady = false, disposed = false

  const column = (x: number) => Math.max(0, Math.min(heights.length - 1, Math.round(x / COL)))
  const surface = (x: number) => g.floor - heights[column(x)]
  const extentY = (r: number, sy: number, s: number) => (Math.abs(Math.sin(r)) * g.env.w / 2 + Math.abs(Math.cos(r)) * g.env.h / 2 * Math.abs(sy)) * s
  const extentX = (r: number, sy: number, s: number) => (Math.abs(Math.cos(r)) * g.env.w / 2 + Math.abs(Math.sin(r)) * g.env.h / 2 * Math.abs(sy)) * s

  function reset() {
    heights = new Float32Array(Math.ceil(g.w / COL) + 1)
    settled = []; letters = []; rand = random(1001); time = 0; next = 0; count = 0; flap = 0; finished = false; stuck = null
    pileCtx.setTransform(1, 0, 0, 1, 0, 0); pileCtx.clearRect(0, 0, pile.width, pile.height)
  }

  function layout() {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    dpr = Math.min(2, window.devicePixelRatio || 1)
    const mode: Mode = matchMedia('(max-width: 859px)').matches ? 'stacked' : 'wide'
    g = geometry(rect.width, rect.height, mode)
    canvas.width = pile.width = Math.round(rect.width * dpr); canvas.height = pile.height = Math.round(rect.height * dpr)
    art = sprites(g.env, dpr * 1.25, colors)
    return true
  }

  // Sand-pile rule: no step between neighbouring columns steeper than the pile's slope.
  function deposit(x: number, half: number) {
    const i0 = column(x - half), i1 = column(x + half), n = i1 - i0 + 1, peak = g.area / (COL * n * 0.5)
    for (let i = i0; i <= i1; i++) heights[i] += peak * (0.5 + 0.5 * Math.cos(Math.PI * ((i - i0) / Math.max(1, n - 1) * 2 - 1)))
    const step = g.slope * COL, queue: number[] = []
    for (let i = i0; i <= i1; i++) queue.push(i)
    for (let guard = 0; queue.length && guard < 40_000; guard++) {
      const i = queue.pop()!
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= heights.length) { if (heights[i] > step) heights[i] = Math.max(step, heights[i] - (heights[i] - step) / 2); continue }
        const excess = heights[i] - heights[j] - step
        if (excess > 0.01) { heights[i] -= excess / 2; heights[j] += excess / 2; queue.push(i, j) }
      }
    }
  }

  function spawn(index: number) {
    const intensity = schedule.intensity[index], k = g.k, s = 0.86 + rand() * 0.28
    const base = { s, front: Math.floor(rand() * 4), back: Math.floor(rand() * 2), sway: (rand() - 0.5) * 2, swayAt: rand() * 6, state: 'flying' as const, t0: 0, from: { x: 0, y: 0, r: 0, sy: 1 }, to: { x: 0, y: 0, r: 0, sy: 1 } }
    const roll = rand()
    if (intensity > 0.6 && g.chimney && roll < 0.1) {
      const [a, b] = g.chimney
      letters.push({ ...base, source: 'chimney', clip: false, x: a + rand() * (b - a), y: -g.env.h, vx: (rand() - 0.5) * 140 * k, vy: (260 + rand() * 300) * k, r: rand() * Math.PI, vr: (rand() - 0.5) * 8, f: rand() * Math.PI * 2, vf: (rand() - 0.5) * 12, sy: 1 })
    } else if (intensity > 0.6 && roll > 0.93) {
      const lying = 0.22 + rand() * 0.12
      letters.push({ ...base, source: 'door', clip: false, x: g.w + g.env.w, y: g.floor - g.env.h / 2 * lying * s, vx: -(620 + rand() * 520) * k, vy: 0, r: (rand() - 0.5) * 0.12, vr: 0, f: Math.acos(lying), vf: 0, sy: lying })
    } else {
      const { cx, openW, openY, openH } = g.slot, push = 0.25 + 0.75 * intensity
      letters.push({ ...base, source: 'slot', clip: true, x: cx + (rand() - 0.5) * openW * 0.72, y: openY + openH / 2, r: (rand() - 0.5) * 0.2 * (1 + intensity), sy: 1, f: 0,
        vx: ((rand() - 0.5) * 2 * g.spread * push + g.bias * intensity) * (intensity < 0.05 ? 0.12 : 1), vy: (110 + rand() * 70 - rand() * 620 * intensity) * k,
        vr: (rand() - 0.5) * (1.4 + 9 * intensity), vf: (rand() - 0.5) * (2 + 15 * intensity) })
    }
    count++
  }

  function land(letter: Letter) {
    const x = Math.max(0, Math.min(g.w, letter.x)), i = column(x), span = 4
    const rise = (heights[Math.min(heights.length - 1, i + span)] - heights[Math.max(0, i - span)]) / (span * 2 * COL)
    const face = Math.cos(letter.f) < 0 ? -1 : 1
    const sy = letter.source === 'door' ? letter.sy : face * (0.34 + rand() * 0.66)
    let r = -Math.atan(rise) * 0.9 + (rand() - 0.5) * 0.7
    r += Math.round((letter.r - r) / Math.PI) * Math.PI
    const ground = heights[i]
    deposit(x, Math.max(g.env.w * 0.3, extentX(r, sy, letter.s)))
    const y = g.floor - ground - extentY(r, sy, letter.s) * 0.55
    letter.state = 'settling'; letter.t0 = time; letter.clip = false
    letter.from = { x: letter.x, y: letter.y, r: letter.r, sy: letter.sy }; letter.to = { x, y, r, sy }
  }

  function bake(pose: Pose) {
    settled.push(pose)
    pileCtx.save(); pileCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    pileCtx.beginPath(); pileCtx.rect(0, 0, g.w, g.floor); pileCtx.clip()
    drawLetter(pileCtx, pose); pileCtx.restore()
  }

  function step() {
    time += STEP
    while (next < TOTAL && schedule.times[next] <= time) spawn(next++)
    if (next === TOTAL && !stuck && time > schedule.times[TOTAL - 1] + 0.12) stuck = { at: time, x: g.slot.cx + g.slot.openW * 0.1, y: 0, r: 0.06 }
    const gravity = 2400 * g.k, dragY = 2.5, dragX = 1.5
    let pushing = 0
    for (const letter of letters) {
      if (letter.state === 'settling') {
        const p = Math.min(1, (time - letter.t0) / SETTLE), e = 1 - (1 - p) ** 3
        letter.x = letter.from.x + (letter.to.x - letter.from.x) * e; letter.y = letter.from.y + (letter.to.y - letter.from.y) * e
        letter.r = letter.from.r + (letter.to.r - letter.from.r) * e; letter.sy = letter.from.sy + (letter.to.sy - letter.from.sy) * e
        continue
      }
      if (letter.source === 'door') {
        letter.x += letter.vx * STEP; letter.vx = Math.min(0, letter.vx + 700 * g.k * STEP)
        if (letter.vx > -40 * g.k || heights[column(letter.x - g.env.w * 0.4)] > g.env.h * 0.18) land(letter)
        continue
      }
      letter.vy += (gravity - letter.vy * dragY) * STEP
      letter.vx += (Math.sin((time + letter.swayAt) * 5) * letter.sway * 180 * g.k - letter.vx * dragX) * STEP
      letter.x += letter.vx * STEP; letter.y += letter.vy * STEP; letter.r += letter.vr * STEP; letter.f += letter.vf * STEP
      letter.sy = Math.cos(letter.f)
      const ey = extentY(letter.r, letter.sy, letter.s)
      if (letter.clip) { if (letter.y - ey > g.slot.openY + g.slot.openH) letter.clip = false; else pushing++ }
      if (letter.y + ey >= surface(letter.x) && letter.vy > 0) land(letter)
    }
    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i]
      if (letter.state === 'settling' && time - letter.t0 >= SETTLE) { bake(letter); letters[i] = letters[letters.length - 1]; letters.pop(); i-- }
    }
    const intensity = next ? schedule.intensity[next - 1] : 0
    const target = stuck ? 0.55 : pushing ? Math.min(1, 0.55 + pushing * 0.15) : 0
    flap += (target - flap) * Math.min(1, STEP * (target > flap ? 40 : 9))
    if (pushing && intensity > 0.5 && !stuck) flap = Math.min(1, flap + Math.sin(time * 90) * 0.05)
    if (stuck && !letters.length && time - stuck.at > 0.45) finished = true
  }

  function drawLetter(target: CanvasRenderingContext2D, pose: Pose, dx = 0, dy = 0) {
    const sprite = pose.sy < 0 ? art.backs[pose.back] : art.fronts[pose.front]
    const sy = Math.max(0.04, Math.abs(pose.sy)), cos = Math.cos(pose.r), sin = Math.sin(pose.r), s = pose.s * dpr
    target.setTransform(cos * s, sin * s, -sin * sy * s, cos * sy * s, (pose.x + dx) * dpr, (pose.y + dy) * dpr)
    const w = g.env.w + art.pad * 2, h = g.env.h + art.pad * 2
    target.drawImage(sprite, -w / 2, -h / 2, w, h)
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
  }

  // The stuck letter: pushed in over 0.3 s, then a shove from outside now and again (wiggle).
  function stuckPose(now: number) {
    if (!stuck) return null
    const { openY, openH } = g.slot, tall = g.env.h * JAMMED, rest = openY + openH + tall * 0.26
    const p = Math.min(1, (time - stuck.at) / 0.3), e = 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2
    let y = openY - tall / 2 + (rest - (openY - tall / 2)) * Math.min(1.04, e), r = stuck.r
    const since = (now - wiggleAt) / 1000
    if (wiggleAt && since < 0.9) { const shove = since < 0.08 ? since / 0.08 : Math.exp(-(since - 0.08) * 7) * Math.cos((since - 0.08) * 26); y += 3.2 * g.k * shove; r += 0.025 * shove }
    return { x: stuck.x, y, r, sy: 1, s: JAMMED, front: 1, back: 0 }
  }

  function draw(now: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { cx, cy, plateW, plateH, openW, openH, openY } = g.slot, k = g.k
    ctx.lineWidth = 1
    roundRect(cx - plateW / 2 + 0.5, cy - plateH / 2 + 0.5, plateW - 1, plateH - 1, 8 * k); ctx.fillStyle = colors.plate; ctx.fill(); ctx.strokeStyle = colors.plateLine; ctx.stroke()
    ctx.fillStyle = colors.plateLine
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + side * (plateW / 2 - 16 * k), openY + openH / 2, 2.6 * k, 0, Math.PI * 2); ctx.fill() }
    if (fontsReady) {
      const size = Math.max(9, 11 * k), advance = size * 0.6 + size * 0.5, word = 'LETTERS'
      ctx.font = `700 ${size}px "OpenTUI Mono", monospace`; ctx.fillStyle = colors.engraving; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center'
      for (let i = 0; i < word.length; i++) ctx.fillText(word[i], cx + (i - (word.length - 1) / 2) * advance, openY - 9 * k)
    }
    roundRect(cx - openW / 2, openY, openW, openH, 2); ctx.fillStyle = colors.opening; ctx.fill()

    const jammed = stuckPose(now)
    const clipped = letters.filter(letter => letter.clip)
    if (clipped.length || jammed) {
      ctx.save(); ctx.beginPath(); ctx.rect(cx - openW / 2, openY, openW, openH); ctx.rect(0, openY + openH, g.w, g.h); ctx.clip()
      for (const letter of clipped) drawLetter(ctx, letter)
      if (jammed) drawLetter(ctx, jammed)
      ctx.restore(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    let open = flap
    if (jammed && wiggleAt) { const since = (now - wiggleAt) / 1000; if (since < 0.9) open = Math.min(1, flap + Math.exp(-since * 6) * 0.25 * Math.abs(Math.sin(since * 40))) }
    const fh = (openH + 6 * k) * (1 - 0.86 * open)
    ctx.fillStyle = colors.flap; ctx.fillRect(cx - openW / 2 - 4 * k, openY - 3 * k, openW + 8 * k, fh)
    ctx.strokeStyle = colors.plateLine; ctx.strokeRect(cx - openW / 2 - 4 * k + 0.5, openY - 3 * k + 0.5, openW + 8 * k - 1, Math.max(1, fh - 1))

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(pile, 0, 0)
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.beginPath(); ctx.rect(0, -g.env.h * 2, g.w, g.floor + g.env.h * 2); ctx.clip()
    for (const letter of letters) if (!letter.clip) drawLetter(ctx, letter)
    ctx.restore()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = colors.floor; ctx.fillRect(0, g.floor, g.w, 1)

    if (jammed && fontsReady) {
      const alpha = Math.min(1, Math.max(0, (time - stuck!.at - 0.5) / 0.35))
      if (alpha > 0) {
        const size = Math.max(10, 12 * k), x0 = jammed.x + g.env.w * JAMMED / 2 + 8 * k, y0 = openY + openH + g.env.h * 0.42, x1 = cx + plateW / 2 + 12 * k
        ctx.globalAlpha = alpha; ctx.strokeStyle = colors.faint
        ctx.beginPath(); ctx.moveTo(x0, y0 + 0.5); ctx.lineTo(x1 - 4, y0 + 0.5); ctx.stroke()
        ctx.font = `${size}px "OpenTUI Mono", monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillStyle = colors.note; ctx.fillText('1,001st', x1, y0)
        ctx.fillStyle = colors.faint; ctx.fillText('+$0.0002', x1, y0 + size * 1.5)
        ctx.globalAlpha = 1
      }
    }
  }

  function report() {
    if (count !== shown) { shown = count; onCount(count) }
    if (finished && !notified) { notified = true; onDone(); scheduleWiggle() }
  }

  function tick(now: number) {
    frame = 0
    if (disposed) return
    if (!finished) {
      const elapsed = last ? Math.min(0.05, (now - last) / 1000) : STEP
      for (let t = 0; t < elapsed - 1e-6 && !finished; t += STEP) step()
    }
    last = now
    draw(now); report()
    if (!finished || (wiggleAt && now - wiggleAt < 900)) frame = requestAnimationFrame(tick)
  }

  function scheduleWiggle() {
    if (reduced || disposed) return
    window.clearTimeout(wiggleTimer)
    wiggleTimer = window.setTimeout(() => {
      if (disposed) return
      if (!document.hidden) { wiggleAt = performance.now(); if (!frame) frame = requestAnimationFrame(tick) }
      scheduleWiggle()
    }, wiggleAt ? 5200 : 1600)
  }

  function finishNow() {
    reset()
    for (let guard = 0; !finished && guard < 120 * 30; guard++) step()
    stuck && (stuck.at = time - 1)
    draw(performance.now()); report()
  }

  function start() {
    if (!layout()) return
    reset()
    if (reduced) { finishNow(); return }
    last = 0; frame = requestAnimationFrame(tick)
  }

  function rebuild() {
    colors = readColors()
    if (!g) return
    art = sprites(g.env, dpr * 1.25, colors)
    pileCtx.setTransform(1, 0, 0, 1, 0, 0); pileCtx.clearRect(0, 0, pile.width, pile.height)
    const poses = settled; settled = []
    for (const pose of poses) bake(pose)
    if (!frame) draw(performance.now())
  }

  let size = ''
  const resized = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect(), key = `${Math.round(rect.width)}x${Math.round(rect.height)}x${window.devicePixelRatio}`
    if (key === size || !rect.width) return
    const first = !size
    size = key
    if (first) { start(); return }
    cancelAnimationFrame(frame); frame = 0
    if (layout()) finishNow()
  })
  const themed = new MutationObserver(rebuild)
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  // The engraving and the note use OpenTUI Mono: start once it has loaded (it is usually cached), or after 400 ms.
  const fonts = document.fonts ? Promise.race([document.fonts.load('700 11px "OpenTUI Mono"').then(() => document.fonts.load('11px "OpenTUI Mono"')), new Promise(done => setTimeout(done, 400))]) : Promise.resolve()
  fonts.catch(() => {}).finally(() => { if (disposed) return; fontsReady = true; resized.observe(canvas) })

  return () => {
    disposed = true
    cancelAnimationFrame(frame); window.clearTimeout(wiggleTimer)
    resized.disconnect(); themed.disconnect()
  }
}
