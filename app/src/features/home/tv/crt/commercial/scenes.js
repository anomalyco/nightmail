// The footage of Doug. Every shot is drawn in a 640×480 space, in greys (the footage is black and
// white; only red survives: the badge, the gnome's hat, an ON AIR sign), with very few things in
// it: Doug, big, his phone, the gnome, and one prop or setting made of a shape or two.
//
// A shot is (list, show, cam): `cam.S` is its own scratch state (reset on every cut) and `show.D`
// is Doug's pose. Doug lives in the right half of the frame: the top left is where his
// notifications land, and the top right corner is the mail app and its badge.
import { clamp, lerp, rng } from "./tween.js"

const g = (v, a = 1) => [v, v, v, a]
const RED = [1, 0.1, 0.05, 1]
const E_out = (k) => 1 - (1 - k) ** 3

export const count = (n) => (n >= 99999 ? "99,999+" : Math.floor(n).toLocaleString("en-US"))

// a plain caption burnt into the corner of a shot ("3:00 AM")
export function caption(list, cam, vis) {
  if (!cam.caption) return
  const k = (vis.x1 - vis.x0) / 640
  const x = vis.x0 + 20 * k
  const y = vis.y1 - 26 * k
  list.text("mono", cam.caption, x + 2 * k, y + 2 * k, 1.05 * k, 0, [0, 0, 0, 0.8])
  list.text("mono", cam.caption, x, y, 1.05 * k, 0, [1, 1, 1, 1])
}

// what his phone is doing right now: lit and shaking when something arrives, and how many unread
const ph = (show, S) => ({ lit: Math.max(S.lit ?? 0, show.buzz * 0.8), shake: Math.max(S.shake ?? 0, show.buzz), t: show.t, n: show.badge.n, heat: show.heat })

// Doug's phone, standing up and facing us. o: { lit, shake, t, n, heat, rot, s, down, flat }
// down: flipped on its face (0..1). flat: lying on a table, seen edge-on.
export function phone(list, x, y, o = {}) {
  const s = o.s ?? 1
  const lit = o.lit ?? 0
  const t = o.t ?? 0
  const lying = o.flat ? 1 : (o.down ?? 0)
  const sx = x + Math.sin(t * 71) * 2.2 * (o.shake || 0)
  const sy = y + lying * 19 * s - Math.abs(Math.sin(t * 40)) * 3 * (o.shake || 0) * lying
  const rot = (o.rot || 0) + Math.sin(t * 83) * 0.08 * (o.shake || 0) + (lying * Math.PI) / 2
  if (lit > 0.02) list.glow(sx, sy - lying * 14 * s, 95 * s * lit, (95 - 55 * lying) * s * lit, [1, 1, 1, 0.34 * lit])
  list.rbox(sx, sy, 14 * s, (25 - 19 * lying) * s, 4.5 * s, { col: g(0.03), rot })
  list.rbox(sx, sy, 14 * s, (25 - 19 * lying) * s, 4.5 * s, { col: g(0.62), rot, stroke: 0.9 * s })
  if (lying < 0.5) list.rbox(sx, sy, 11 * s, 21 * s, 2.5 * s, { col: g(lerp(0.09, 1, lit)), rot })
  // the mail it can't hold any more
  const n = Math.floor((o.heat || 0) * 16)
  for (let k = 0; k < n; k++) {
    const u = (t * (1.1 + 0.13 * k) + k * 0.37) % 1
    const dx = ((k * 53) % 100) / 50 - 1
    list.sprite("mini", sx + dx * 100 * u * s, sy - 22 * s - Math.sin(u * Math.PI) * (52 + (k % 4) * 18) * s + u * 44 * s, 0.62 * s, u * 5 + k, g(0.92, 1 - u * u))
  }
  // the badge
  if (o.n >= 1 && !(o.down > 0.5)) {
    const str = count(o.n)
    const ts = 0.7 * s
    const tw = list.measure("badge", str, ts)
    const bx = sx + 9 * s + tw / 2
    const by = sy - (25 - 15 * lying) * s
    list.rbox(bx, by, tw / 2 + 5.5 * s, 8.5 * s, 8.5 * s, { col: RED })
    list.text("badge", str, bx, by, ts, 0.5, [1, 1, 1, 1])
  }
}

// one garden gnome. y is where he stands
export function gnome(list, x, y, s = 1, tilt = 0) {
  list.ellipse(x, y - 13 * s, 13 * s, 14 * s, { col: g(0.46) })
  list.ellipse(x + tilt * 8 * s, y - 23 * s, 11 * s, 12 * s, { col: g(0.97) })
  list.ellipse(x + tilt * 12 * s, y - 31 * s, 4 * s, 3.4 * s, { col: g(0.72) })
  list.tri(x + tilt * 30 * s, y - 47 * s, 12.5 * s, 17 * s, 0, { col: RED, rot: tilt })
}

// an AI agent: a bean with an antenna and a screen for a face. Far away, just the idea of one.
// j: its own phase, so a crowd of them doesn't hop in step
function robot(list, x, y, R, t, j, o = {}) {
  const yy = y - Math.abs(Math.sin(t * 9 + j * 40)) * R * (o.hop ?? 0)
  if (R >= 13) {
    list.bean({ x, y: yy, R, kind: 3, lid: 0, rot: o.rot ?? 0, gx: o.gx ?? 0, gy: o.gy ?? 0, rim: [0.9, 0.95, 1, 1.2] })
    return
  }
  list.ellipse(x, yy, R * 0.8, R, { col: g(0.62) })
  list.rbox(x, yy - R * 0.15, R * 0.5, R * 0.16, R * 0.1, { col: g(0.05) })
  list.seg(x, yy - R, x, yy - R * 1.4, 0.8, { col: g(0.5) })
  if (Math.sin(t * 7 + j * 40) > -0.3) list.sprite("dot", x, yy - R * 1.5, Math.max(0.16, R * 0.03), 0, RED)
}
// the email each of them is sending, on its way to (tx, ty)
function sending(list, x, y, tx, ty, t, j, s = 0.7) {
  const u = (t * 1.5 + j * 5.3) % 1
  list.sprite("mini", lerp(x, tx, u), lerp(y, ty, u) - Math.sin(u * Math.PI) * (40 + j * 50), s, u * 6 + j * 9, g(0.92, Math.min(1, u * 5) * (1 - u * u * u)))
}

// ── the couch: Doug buys a gnome ────────────────────────────────────────────────
// (also what the set's monitor shows before anyone tunes in)
export function couch(list, show, cam) {
  const D = show.D
  const S = cam.S
  list.rbox(320, 200, 330, 215, 0, { col: g(0.34) })
  list.glow(200, 140, 330, 290, [1, 1, 1, 0.09])
  list.rbox(320, 452, 330, 42, 0, { col: g(0.2) })
  list.seg(-10, 410, 650, 410, 1.6, { col: g(0.12) })
  list.rbox(436, 300, 212, 96, 36, { col: g(0.5) }) // the back
  show.dougBean(list, 426 + D.x, 288 + D.y, 108)
  list.rbox(436, 396, 196, 30, 14, { col: g(0.64) }) // the seat
  for (const x of [236, 632]) list.rbox(x, 364, 30, 62, 22, { col: g(0.57) }) // the arms
  phone(list, 568, 330, { ...ph(show, S), s: 1.45, down: S.down ?? 0 })
  if ((S.gnome ?? 0) > 0.01) gnome(list, 150, 456 + (1 - S.gnome) * 130, 1.7)
}

// ── the bedroom, 3:00 AM ────────────────────────────────────────────────────────
export function bedroom(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  const p = ph(show, S)
  const lit = p.lit
  const up = S.up ?? 0 // 0 lying down, 1 sitting up
  // close on the head of the bed: headboard, one pillow, Doug, the blanket with its edge turned
  // down under his chin. The gnome is tucked in next to him. The phone is on the blanket.
  list.rbox(320, 240, 330, 250, 0, { col: g(0.13) })
  list.rbox(592, 262, 14, 142, 10, { col: g(0.42) }) // headboard
  list.rbox(310, 426, 306, 10, 3, { col: g(0.3) }) // frame
  for (const lx of [30, 590]) list.rbox(lx, 452, 8, 22, 2, { col: g(0.3) })
  list.rbox(310, 394, 300, 24, 10, { col: g(0.66) }) // mattress
  list.rbox(540, 274, 30, 88, 26, { col: g(0.92), rot: 0.12 }) // the pillow
  if (lit > 0.02) list.glow(300, 300, 430 * lit, 340 * lit, [1, 1, 1, 0.22 * lit])
  gnome(list, 352, 338, 1.3, 0.22)
  // Doug: propped on the pillow, or bolt upright
  const dx = lerp(462, 448, up) + D.x
  const dy = lerp(278, 234, up) + D.y
  show.dougBean(list, dx, dy, 100, { rot: lerp(0.3, 0, up) + (S.roll ?? 0) + D.rot, rim: [0.9, 0.95, 0.9, 0.55 + lit * 0.45], light: [1, 1, 1, lit * 0.9], ldir: [-1, 0.2] })
  // the blanket: a long low hill from his chin to the foot of the bed
  const bl = g(0.4)
  list.ellipse(270, 358, 222, 36, { col: bl })
  list.rbox(200, 378, 242, 26, 18, { col: bl })
  list.rbox(lerp(452, 440, up), 356, 10, 30, 9, { col: g(0.8), rot: 0.2 }) // its edge, turned down
  phone(list, 268, 318, { ...p, s: 1.3 })
  const z = S.zzz ?? 0
  if (z > 0.01) {
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.3 + i / 3) % 1
      list.text("mono", "Z", dx + 40 + k * 70 + Math.sin(k * 7 + i) * 8, dy - 104 - k * 70, 0.9 + k * 1.1, 0.5, [1, 1, 1, (1 - k) * 0.9 * z])
    }
  }
}

// ── the bathroom: Doug in the tub, with a duck ──────────────────────────────────
function duck(list, x, y, face, t, s = 1) {
  // face: -1 looks left, 1 looks right, 0 looks out at us
  const yy = y + Math.sin(t * 1.7) * 2
  list.ellipse(x, yy, 17 * s, 12 * s, { col: g(0.86) })
  list.tri(x - face * 14 * s, yy - 7 * s, 6 * s, 6 * s, 0, { col: g(0.86), rot: -face * 0.5 })
  const hx = x + face * 9 * s
  const hy = yy - 14 * s
  list.ellipse(hx, hy, 9.5 * s, 9 * s, { col: g(0.9) })
  if (Math.abs(face) > 0.5) {
    list.tri(hx + face * 12 * s, hy + 1.5 * s, 4 * s, 5.5 * s, 0, { col: g(0.45), rot: (face * Math.PI) / 2 })
    list.ellipse(hx + face * 3.5 * s, hy - 2 * s, 1.7 * s, 1.7 * s, { col: g(0.02) })
  } else {
    list.ellipse(hx, hy + 3.5 * s, 5 * s, 2.6 * s, { col: g(0.45) })
    list.ellipse(hx - 3.6 * s, hy - 2 * s, 1.7 * s, 1.7 * s, { col: g(0.02) })
    list.ellipse(hx + 3.6 * s, hy - 2 * s, 1.7 * s, 1.7 * s, { col: g(0.02) })
  }
}

export function bath(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  list.rbox(320, 190, 330, 200, 0, { col: g(0.44) })
  for (let i = 0; i < 5; i++) list.seg(-10, 70 + i * 58, 650, 70 + i * 58, 0.7, { col: g(0.39) })
  for (let i = 0; i < 9; i++) list.seg(40 + i * 70, 0, 40 + i * 70, 370, 0.7, { col: g(0.39) })
  list.rbox(320, 462, 330, 30, 0, { col: g(0.24) })
  // Doug (D.sink: 0 chin-deep, 1 only his eyes), then the tub in front of him
  const dx = 432 + D.x
  show.dougBean(list, dx, lerp(246, 280, D.sink) + D.y + Math.sin(t * 1.1) * 1.5, 96)
  list.rbox(350, 374, 272, 80, 44, { col: g(0.88) })
  list.rbox(350, 374, 272, 80, 44, { col: g(0.6), stroke: 1.2 })
  list.rbox(350, 304, 282, 10, 8, { col: g(0.95) })
  for (let i = 0; i < 16; i++) {
    const r = 18 + ((i * 7) % 5) * 2.6
    list.ellipse(94 + i * 34, 298 + Math.sin(t * 1.3 + i * 1.7) * 1.8, r, r * 0.72, { col: g(0.985) })
  }
  gnome(list, 110, 298, 1.25)
  duck(list, lerp(236, 276, S.duckIn ?? 0), 280, S.duck ?? 1, t, 1.5)
  phone(list, 578, 262, { ...ph(show, S), s: 1.25, rot: 0.12 })
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.07 + i / 3) % 1
    list.glow(200 + i * 110 + Math.sin(k * 5 + i) * 20, 250 - k * 190, 90, 60, [1, 1, 1, 0.07 * Math.sin(k * Math.PI)])
  }
  // what the sender can see, stamped on
  ;(S.stamps || []).forEach((s, i) => {
    const k = clamp((t - s.t0) / 0.12, 0, 1)
    const sc = 0.86 * (1.6 - 0.6 * k)
    const w = list.measure("mono", "✓ " + s.text, 0.86) + 22
    const y = 352 + i * 34
    list.rbox(112 + w / 2, y, w / 2, 15, 0, { col: [0.02, 0.02, 0.02, 0.86 * k], rot: -0.03 })
    list.text("mono", "✓ " + s.text, 123, y, sc, 0, [1, 1, 1, k], -0.03)
  })
}

// ── a restaurant: Doug on a first date ──────────────────────────────────────────
export function date(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  const d = S.date || { x: 0, gx: 0.8, gy: 0, smile: 0.6, mouth: 0, lid: 0.1, brow: 0.2, talk: 0 }
  list.rbox(320, 240, 330, 250, 0, { col: g(0.3) })
  list.glow(340, 330, 330, 230, [1, 1, 1, 0.2])
  // she has a bun; she is being very patient
  list.bean({
    x: 214 + d.x, y: 318, R: 80, kind: 0,
    gx: d.gx, gy: d.gy, lid: d.lid, blink: (t + 1.3) % 4.1 < 0.1 ? 1 : 0, brow: d.brow, smile: d.smile,
    mouth: d.talk > 0.5 ? 0.12 + 0.3 * Math.abs(Math.sin(t * 9) * Math.sin(t * 3.1)) : d.mouth,
    fx: d.gx * 0.1, rot: d.talk > 0.5 ? Math.sin(t * 2.4) * 0.05 : 0,
    light: [1, 1, 1, 0.5], ldir: [1, 0.5],
  })
  show.dougBean(list, 458 + D.x, 316 + D.y, 86, { light: [1, 1, 1, 0.5], ldir: [-1, 0.5] })
  // the table, a candle, his phone
  list.rbox(334, 470, 196, 50, 4, { col: g(0.5) })
  list.ellipse(334, 420, 218, 22, { col: g(0.74) })
  const fl = 0.8 + 0.2 * Math.sin(t * 11) * Math.sin(t * 6.1)
  list.rbox(296, 394, 5, 17, 2, { col: g(0.9) })
  list.glow(296, 368, 76 * fl, 76 * fl, [1, 1, 1, 0.34])
  list.ellipse(296, 371, 3.8, 8 * fl, { col: g(1) })
  phone(list, 362 - (S.px ?? 0), 378, { ...ph(show, S), s: 1.15, rot: -0.06 })
}

// ── Gnome Depot's office: six people his reply was posted to ────────────────────
export const STAFF = [
  { R: 92, smile: 0.9, brow: 0.3 },
  { R: 84, smile: 0.1, brow: 0.8 },
  { R: 78, smile: 1, brow: 0.6, wide: 1.15 },
  { R: 88, smile: 0, lid: 0.4 },
  { R: 94, smile: 0.7, brow: 0.5 },
  { R: 82, smile: -0.4, brow: -0.2, worry: -0.7 },
]
export function staff(list, show, cam) {
  const t = show.t
  const S = cam.S
  const i = S.who ?? 0
  const p = STAFF[i]
  const typing = S.typed != null && t - S.typed < 0.3
  const done = S.typed != null && !typing
  list.rbox(320, 240, 330, 250, 0, { col: g((i + Math.floor(i / 2)) % 2 ? 0.46 : 0.38) })
  list.glow(320, 470, 330, 260, [1, 1, 1, typing ? 0.5 : 0.25])
  const y = 262 + (typing ? Math.sin(t * 50) * 3 : 0)
  list.bean({
    x: 320, y, R: p.R, kind: 2,
    gx: done ? 0 : Math.sin(t * 2.6 + i * 2) * 0.55, gy: done ? 0.1 : 0.8, lid: p.lid ?? 0.1,
    blink: (t + i * 0.9) % 3.9 < 0.1 ? 1 : 0, brow: p.brow ?? 0, worry: p.worry ?? 0, wide: p.wide ?? 1, smile: p.smile,
    light: [1, 1, 1, 0.9], ldir: [0, 1],
  })
  // company uniform
  list.tri(320, y - p.R * 1.36, p.R * 0.5, p.R * 0.56, 0.2, { col: RED, rot: 0.06 })
}

// ── a chapel: Doug at a funeral ─────────────────────────────────────────────────
const MOURN = [
  { x: 92, R: 46 },
  { x: 200, R: 42 },
]
const PEW = 340
// the agents arrive: two up from behind the casket, one in the pew right next to him, then two
// rows of them at the back
const CHAPEL_BOTS = (() => {
  const a = [
    { x: 150, R: 46, casket: true },
    { x: 494, R: 46, casket: true },
    { x: 506, R: 30, pew: true },
  ]
  for (let i = 0; i < 15; i++) a.push({ x: 18 + i * 43, R: 25, y: 252 })
  for (let i = 0; i < 14; i++) a.push({ x: 40 + i * 43, R: 18, y: 222 })
  return a.map((b, i) => ({ ...b, j: (i * 0.618) % 1 }))
})()
function tag(list, x, y, w, h, label, red, a, t) {
  const c = red ? [1, 0.1, 0.05, a] : [1, 1, 1, a]
  const e = 13
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    list.seg(x + (sx * w) / 2, y + (sy * h) / 2, x + (sx * w) / 2 - sx * e, y + (sy * h) / 2, 1.3, { col: c })
    list.seg(x + (sx * w) / 2, y + (sy * h) / 2, x + (sx * w) / 2, y + (sy * h) / 2 - sy * e, 1.3, { col: c })
  }
  const s = red ? 0.8 : 0.5
  const tw = list.measure("mono", label, s) + 10
  const hh = red ? 13 : 10
  const blink = red ? 0.75 + 0.25 * Math.sin(t * 14) : 1
  list.rbox(x - w / 2 + tw / 2, y - h / 2 - hh - 2, tw / 2, hh, 0, { col: red ? [1, 0.1, 0.05, a * blink] : [0, 0, 0, 0.65 * a] })
  list.text("mono", label, x - w / 2 + 5, y - h / 2 - hh - 2, s, 0, red ? [1, 1, 1, a] : c)
}

export function chapel(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  const DX = 416
  list.rbox(320, 240, 330, 250, 0, { col: g(0.3) })
  // one tall window, behind him
  list.glow(DX, 150, 250, 250, [1, 1, 1, 0.16])
  list.rbox(DX, 112, 50, 96, 50, { col: g(0.7) })
  list.seg(DX, 18, DX, 206, 1.6, { col: g(0.36) })
  list.seg(DX - 48, 118, DX + 48, 118, 1.6, { col: g(0.36) })
  // the pew behind them, and who comes up from behind it
  const bots = S.bots ?? 0
  const up = (i) => E_out(clamp(bots - i, 0, 1))
  for (let i = CHAPEL_BOTS.length - 1; i >= 3; i--) {
    const b = CHAPEL_BOTS[i] // (the far row first)
    if (bots > i) robot(list, b.x, b.y + (1 - up(i)) * b.R * 2.4, b.R, t, b.j, { gx: Math.sign(DX - b.x) * 0.8, gy: 0.4 })
  }
  list.rbox(320, 310, 330, 40, 6, { col: g(0.17) })
  CHAPEL_BOTS.forEach((b, i) => {
    if (b.pew && bots > i) robot(list, b.x, PEW - b.R * 0.75 + (1 - up(i)) * b.R * 2, b.R, t, b.j, { gx: -1, gy: 0.2 })
  })
  const m = S.m || []
  MOURN.forEach((p, i) => {
    const look = m[i]?.look ?? 0
    const dir = Math.sign(DX - p.x)
    list.bean({
      x: p.x + look * dir * 5, y: PEW - p.R * 0.78, R: p.R, kind: 0, rot: look * dir * 0.1,
      gx: look * dir, gy: lerp(0.65, 0.05, look), lid: lerp(0.45, 0.08, look), blink: (t + i * 1.7) % 4.6 < 0.1 ? 1 : 0,
      brow: lerp(0.2, -0.4, look), worry: lerp(-0.7, 0.45, look), smile: lerp(-0.3, -0.45, look), fx: look * dir * 0.12,
    })
  })
  // he brought the gnome
  gnome(list, 548, PEW + 18, 1.6)
  const dy = PEW - 86 * 0.72 + D.sink * 70 + D.y
  show.dougBean(list, DX + D.x, dy, 86)
  if ((S.sweat ?? 0) > 0.01) {
    const k = (t * 0.7) % 1
    list.ellipse(DX + D.x + 60, dy - 44 + k * 50, 4.4, 7, { col: [1, 1, 1, S.sweat * (1 - k)] })
  }
  // the pew in front, and the phone on its ledge, under a hymn book
  list.rbox(320, 446, 330, 62, 0, { col: g(0.23) })
  list.rbox(320, 368, 330, 30, 5, { col: g(0.1) })
  list.seg(-10, PEW, 650, PEW, 2.2, { col: g(0.24) })
  const px = 296
  const book = S.book ?? 0 // 0: on top of the phone. 1: gone
  const p = ph(show, S)
  if (book < 0.5) {
    // muffled: the book hops
    const j = (S.muffled ?? 0) * Math.abs(Math.sin(t * 46)) * 2.5
    list.rbox(px, PEW - 5, 20, 4.5, 2, { col: g(0.03) })
    list.rbox(px + Math.sin(t * 60) * (S.muffled ?? 0), PEW - 17 - j, 40, 9, 2.5, { col: g(0.78), rot: Math.sin(t * 38) * 0.03 * (S.muffled ?? 0) })
    list.rbox(px - 24, PEW - 17 - j, 3, 9, 1, { col: g(0.35) })
    for (let k = 0; k < 3; k++) {
      const u = (t * 2.2 + k / 3) % 1
      list.ring(px, PEW - 12, 26 + u * 46, 1, -2.6, -0.5, { col: g(1, (1 - u) * 0.5 * (S.muffled ?? 0)) })
    }
  } else phone(list, px, PEW - 29, { ...p, s: 1.15 })
  if (book > 0.001 && book < 1) {
    list.rbox(px - book * 250, PEW - 17 - Math.sin(book * Math.PI) * 130, 40, 9, 2.5, { col: g(0.78), rot: -book * 7 })
  }
  // every one of them is sending him something
  CHAPEL_BOTS.forEach((b, i) => {
    if (bots > i + 0.6) sending(list, b.x, (b.casket ? 400 : b.pew ? PEW - b.R : b.y) - b.R, px, PEW - 40, t, b.j, b.y ? 0.6 : 0.9)
  })
  CHAPEL_BOTS.forEach((b, i) => {
    if (b.casket && bots > i) robot(list, b.x, 426 - b.R * 0.62 + (1 - up(i)) * b.R * 2, b.R, t, b.j, { gx: Math.sign(DX - b.x) * 0.7, gy: -0.6 })
  })
  // the casket, with flowers on it
  list.ellipse(320, 476, 236, 12, { col: [0, 0, 0, 0.35] })
  list.rbox(320, 446, 212, 27, 10, { col: g(0.5) })
  list.rbox(320, 426, 218, 8, 6, { col: g(0.68) })
  for (const hx of [170, 320, 470]) list.rbox(hx, 452, 16, 3, 2, { col: g(0.8) })
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4
    const r = i === 0 ? 0 : 9 + (i % 3) * 5
    list.ellipse(320 + Math.cos(a) * r * 1.9, 414 + Math.sin(a) * r * 0.45, 7.5, 6.5, { col: g(i % 2 ? 0.97 : 0.86) })
  }
  // what the AI makes of everybody
  if (S.scan != null) {
    const k = (t - S.scan) / 0.7
    if (k < 1) {
      const sx = lerp(20, 620, k)
      list.rbox(sx - 26, 240, 26, 250, 0, { col: [1, 1, 1, 0.07] })
      list.seg(sx, 0, sx, 480, 1, { col: [1, 1, 1, 0.8] })
    }
  }
  for (const b of S.ai || []) {
    const a = clamp((t - b.t0) / 0.1, 0, 1)
    if (a <= 0) continue
    if (b.i === "doug") tag(list, DX + D.x, dy - 4, 176, 206, b.label, !!b.red, a, t)
    else if (b.i === "gnome") tag(list, 550, PEW - 36, 60, 110, b.label, false, a, t)
    else tag(list, MOURN[b.i].x, PEW - MOURN[b.i].R * 0.78 - 8, MOURN[b.i].R * 2, MOURN[b.i].R * 2.5, b.label, false, a, t)
  }
}

// ── the car: Doug drives to Nightmail Studios ───────────────────────────────────
const RADIO = [250, 318] // the radio, on the dash
const SHIELD = (() => {
  const r = rng(9)
  const a = []
  while (a.length < 84) {
    const x = r() * 700 - 30
    const y = 186 + r() * 280 // below the signs: he still has to read those
    if (((x - 392) / 112) ** 2 + ((y - 272) / 40) ** 2 < 1) continue // the gap he drives through
    if (Math.abs(x - RADIO[0]) < 110 && Math.abs(y - RADIO[1] + 24) < 80) continue // and none land in front of the radio
    a.push({ x, y, rot: (r() - 0.5) * 2.4, s: 1.4 + r() * 1.3, j: r() })
  }
  return a
})()
// the ones running after the car, seen through the back window
const CHASE = (() => {
  const r = rng(17)
  const a = []
  for (let i = 0; i < 46; i++) {
    const d = r()
    a.push({ x: 50 + r() * 560, y: 176 + d * 84, R: 6 + d * 9, j: r() })
  }
  return a.sort((p, q) => p.y - q.y)
})()
// and the ones that arrive behind it
const HORDE = (() => {
  const r = rng(23)
  const a = []
  for (let i = 0; i < 170; i++) {
    const d = r()
    a.push({ off: r() ** 0.8 * 560, d, R: 21 - d * 14, j: r() })
  }
  return a.sort((p, q) => q.d - p.d)
})()
export function drive(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  const bump = Math.sin(t * 31) * 1.4
  list.rbox(320, 240, 330, 250, 0, { col: g(0.4) })
  // the road going by
  for (let i = 0; i < 8; i++) {
    const k = (t * (1.7 + (i % 3) * 0.5) + i * 0.37) % 1
    list.seg(720 - k * 960, 66 + i * 40, 820 - k * 960 + i * 10, 66 + i * 40, 1.6, { col: g(0.66, 0.5) })
  }
  // they are behind him, all of them, and gaining
  const bots = S.bots ?? 0
  for (let i = 0; i < CHASE.length * bots; i++) {
    const b = CHASE[i]
    robot(list, b.x + Math.sin(t * 2 + b.j * 9) * 8, b.y, b.R, t, b.j, { hop: 0.9 })
  }
  // the signs
  for (const sg of S.signs || []) {
    const k = (t - sg.t0) / sg.dur
    if (k < 0 || k > 1) continue
    const x = k < 0.28 ? lerp(840, 452, 1 - (1 - k / 0.28) ** 3) : k < 0.76 ? lerp(452, 420, (k - 0.28) / 0.48) : lerp(420, -260, ((k - 0.76) / 0.24) ** 2)
    const y = 112
    list.seg(x, y + 40, x, 300, 4, { col: g(0.2) })
    list.rbox(x, y, 118, 46, 6, { col: sg.red ? RED : g(0.96) })
    list.rbox(x, y, 112, 40, 4, { col: sg.red ? [1, 1, 1, 1] : g(0.1), stroke: 1.4 })
    const ink = sg.red ? [1, 1, 1, 1] : g(0.06)
    list.text("mono", "NIGHTMAIL STUDIOS", x, y - 17, 0.56, 0.5, ink)
    list.text("mono", sg.text, x, y + 13, 1.25, 0.5, ink)
  }
  // the car around him: pillars, his seat
  list.rbox(30, 240, 24, 260, 0, { col: g(0.05), rot: 0.07 })
  list.rbox(612, 240, 24, 260, 0, { col: g(0.05), rot: -0.07 })
  list.rbox(320, 16, 330, 30, 0, { col: g(0.05) })
  // two of them are in the back seat
  const seat = (i, x) => {
    const k = E_out(clamp(bots * 5 - i, 0, 1))
    if (k > 0) robot(list, x, 296 + (1 - k) * 150 + bump, 50, t, i * 0.37, { gx: Math.sign(392 - x), gy: 0.2 })
  }
  seat(0, 236)
  seat(1, 556)
  list.rbox(392, 362 + bump, 142, 196, 48, { col: g(0.2) })
  show.dougBean(list, 392 + D.x, 290 + D.y + bump, 112)
  // and one is on the roof
  const roof = E_out(clamp(bots * 5 - 2.5, 0, 1))
  if (roof > 0) robot(list, 250, 26 + roof * 52, 42, t, 0.7, { rot: Math.PI, gx: -0.6, gy: -0.4 })
  // the wheel, the dash, and the phone on it
  list.ring(392, 484 + bump, 100, 8, 0, 0, { col: g(0.3) })
  list.rbox(320, 460, 330, 46, 0, { col: g(0.07) })
  list.seg(-10, 414, 650, 414, 1.2, { col: g(0.2) })
  phone(list, 532, 380 + bump, { ...ph(show, S), s: 1.4 })
  // The radio on the dash, and the commercial is on it. S.radio: 1 on, 0 he has turned it off
  // (with his head: it has the dent), 2 it is back, and louder.
  if (S.radio != null) {
    const loud = S.radio === 2
    const rx = RADIO[0] + (loud ? Math.sin(t * 53) * 3 : 0)
    const ry = RADIO[1] + bump + (loud ? Math.cos(t * 47) * 2.5 : 0)
    const hurt = S.dent != null
    const [ax, ay] = hurt ? [rx + 112, ry - 60] : [rx + 76, ry - 106]
    list.seg(rx + 52, ry - 32, ax, ay, 1.8, { col: g(0.85) })
    list.ellipse(ax, ay, 4.5, 4.5, { col: g(0.95) })
    list.rbox(rx + 3, ry + 4, 76, 37, 9, { col: g(0, 0.5) })
    list.rbox(rx, ry, 76, 37, 9, { col: g(0.7), rim: g(1) })
    if (hurt) list.ellipse(rx - 10, ry - 36, 34, 11, { col: g(0.3) })
    list.rbox(rx - 18, ry - 10, 45, 15, 3, { col: S.radio ? g(loud ? 1 : 0.92) : g(0.06) })
    list.rbox(rx - 18, ry - 10, 45, 15, 3, { col: g(0.1), stroke: 1.6 })
    list.ellipse(rx + 50, ry - 10, 13, 13, { col: g(0.2), rim: g(0.9) })
    list.seg(rx + 50, ry - 10, rx + 50 + (loud ? 9 : -7), ry - 18, 1.8, { col: g(0.95) })
    for (let i = 0; i < 9; i++) list.seg(rx - 60 + i * 14.5, ry + 18, rx - 53 + i * 14.5, ry + 18, 2.2, { col: g(0.2) })
    if (S.radio) {
      // what is coming out of it
      const n = loud ? 4 : 2
      for (let i = 0; i < n; i++) {
        const k = (t * (loud ? 2.6 : 1.8) + i / n) % 1
        list.ring(rx - 10, ry - 28, 44 + k * (loud ? 170 : 70), loud ? 3.6 : 2, -2.75, -0.4, { col: g(1, (1 - k) * (loud ? 1 : 0.8)) })
      }
      list.text("mono", loud ? "VOL 11" : "AM 1070", rx - 18, ry - 10, 0.55, 0.5, g(0.05))
    }
  }
  // what the robots send piles up on the windshield
  const n = Math.floor((S.pile ?? 0) * SHIELD.length)
  for (let i = 0; i < n; i++) {
    const c = SHIELD[i]
    const k = clamp(((S.pile ?? 0) * SHIELD.length - i) / 5, 0, 1)
    const [fx, fy] = [[236, 250], [556, 250], [250, 110]][i % 3] // each one comes off a robot
    list.sprite("mini", lerp(fx, c.x, k), lerp(fy, c.y, k), c.s * (0.4 + 0.6 * k), c.rot + (1 - k) * 4, g(0.8 + c.j * 0.2))
  }
}

// ── outside Nightmail Studios ───────────────────────────────────────────────────
export function exterior(list, show, cam) {
  const t = show.t
  const D = show.D
  const S = cam.S
  // (everything sits high in the frame: the bottom of this shot is under the commercial's type)
  const ground = 344
  list.rbox(320, 170, 330, 180, 0, { col: g(0.16) })
  list.rbox(320, 420, 330, 76, 0, { col: g(0.08) })
  // the building, its name, a door, and a red sign
  list.rbox(500, 217, 190, 127, 2, { col: g(0.32) })
  list.rbox(500, 88, 196, 5, 1, { col: g(0.5) })
  list.text("mono", "NIGHTMAIL STUDIOS", 478, 132, 0.74, 0.5, g(0.95))
  const on = 0.75 + 0.25 * Math.sin(t * 9)
  list.glow(540, 204, 110, 60, [1, 0.1, 0.05, 0.5 * on])
  list.rbox(540, 204, 62, 19, 4, { col: [1, 0.1, 0.05, on] })
  list.text("mono", "ON AIR", 540, 204, 0.8, 0.5, [1, 1, 1, 1])
  list.rbox(540, 286, 38, 58, 3, { col: g(0.03) })
  if ((S.lit ?? 0) > 0.01) list.rbox(540, 286, 34, 54, 2, { col: g(1, S.lit) })
  // hundreds of robots, right behind him
  const front = lerp(-60, 500, S.horde ?? 0)
  const tx = S.out ? (S.dx ?? 0) + D.x : (S.carx ?? 0)
  HORDE.forEach((b, i) => {
    const x = front - b.off
    if (x < -30) return
    const y = ground - b.R * 0.8 - b.d * 44
    robot(list, x, y, b.R, t, b.j, { hop: 0.8, gx: 1 })
    if (i % 4 === 0) sending(list, x, y - b.R, tx, ground - 70, t, b.j, 0.55)
  })
  // Doug, out of the car and through the door
  if (S.out) show.dougBean(list, (S.dx ?? 0) + D.x, ground - 54 + D.y, 60)
  // the car
  const cx = S.carx ?? -260
  const dive = S.dive ?? 0
  for (let i = 0; i < 4; i++) {
    const k = clamp((t - (S.skid ?? 1e9)) / 0.9 - i * 0.12, 0, 1)
    if (k > 0 && k < 1) list.glow(cx - 110 - i * 34 - k * 40, ground - 8 - k * 30, 30 + k * 40, 22 + k * 26, [1, 1, 1, 0.3 * (1 - k)])
  }
  if (S.skid != null) list.seg(Math.max(cx - 300, -20), ground + 6, cx - 60, ground + 6, 1.6, { col: g(0.02) })
  list.rbox(cx, ground - 34, 112, 24, 14, { col: g(0.66), rot: dive })
  list.rbox(cx - 12, ground - 66 + dive * 30, 60, 22, 16, { col: g(0.54), rot: dive })
  list.rbox(cx - 12, ground - 66 + dive * 30, 50, 14, 10, { col: g(0.08), rot: dive })
  for (const wx of [-66, 68]) {
    list.ellipse(cx + wx, ground - 10, 19, 19, { col: g(0.03) })
    list.ellipse(cx + wx, ground - 10, 8, 8, { col: g(0.5) })
  }
  // its door, leaving
  if (S.door != null) {
    const u = (t - S.door) / 0.9
    if (u < 1) list.rbox(lerp(cx + 4, cx - 150, u), ground - 44 - Math.sin(u * Math.PI) * 190, 26, 20, 5, { col: g(0.66), rot: -u * 9 })
  }
}

export const SCENES = { couch, bedroom, bath, date, staff, chapel, drive, exterior }
