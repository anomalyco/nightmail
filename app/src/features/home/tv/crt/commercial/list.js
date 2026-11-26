// A display list of SDF instances and beans, rebuilt every frame and uploaded in one write.
import { BF, F, FL, T } from "./gpu.js"

const W = [1, 1, 1, 1]

export class List {
  static missing = new Set() // sprite names asked for that the atlas doesn't have (see ?debug)

  constructor(cap = 24000, beanCap = 160) {
    this.data = new Float32Array(cap * F)
    this.beans = new Float32Array(beanCap * BF)
    this.cap = cap
    this.beanCap = beanCap
    this.n = 0
    this.nb = 0
    this.atlas = null
    this.flags = 0 // OR-ed into every instance (e.g. CLIP)
    this.cam = null // { s, ox, oy } maps local space to target px
  }
  reset() {
    this.n = 0
    this.nb = 0
    this.flags = 0
    this.cam = null
  }
  // local → target
  X(x) {
    return this.cam ? x * this.cam.s + this.cam.ox : x
  }
  Y(y) {
    return this.cam ? y * this.cam.s + this.cam.oy : y
  }
  S(v) {
    return this.cam ? v * this.cam.s : v
  }
  push(x, y, hw, hh, rot, type, pad, flags, c, d, col, col2) {
    if (this.n >= this.cap) return
    const o = this.n++ * F
    const a = this.data
    a[o] = this.X(x)
    a[o + 1] = this.Y(y)
    a[o + 2] = this.S(hw)
    a[o + 3] = this.S(hh)
    a[o + 4] = rot
    a[o + 5] = type
    a[o + 6] = this.S(pad)
    a[o + 7] = flags | this.flags
    a[o + 8] = c[0]
    a[o + 9] = c[1]
    a[o + 10] = c[2]
    a[o + 11] = c[3]
    a[o + 12] = d[0]
    a[o + 13] = d[1]
    a[o + 14] = d[2]
    a[o + 15] = d[3]
    a[o + 16] = col[0]
    a[o + 17] = col[1]
    a[o + 18] = col[2]
    a[o + 19] = col[3]
    a[o + 20] = col2[0]
    a[o + 21] = col2[1]
    a[o + 22] = col2[2]
    a[o + 23] = col2[3]
  }
  // ── shapes. o: { col, rim, ink, lit, add, stroke, rot, soft, r } ──
  shape(type, x, y, hw, hh, o = {}, c = [0, 0, 0, 0]) {
    let f = 0
    if (o.lit) f |= FL.LIT
    if (o.ink) f |= FL.INK
    if (o.add) f |= FL.ADD
    if (o.stroke) {
      f |= FL.STROKE
      c[3] = this.S(o.stroke)
    }
    if (o.soft) c[2] = this.S(o.soft)
    const pad = o.pad ?? (o.ink ? 14 : (o.soft || 0) + 2)
    this.push(x, y, hw, hh, o.rot || 0, type, pad, f, c, [0, 0, 0, 0], o.col || W, o.rim || (o.ink ? [0.9, 0.92, 0.96, 1] : [0, 0, 0, 0]))
  }
  ellipse(x, y, rx, ry, o) {
    this.shape(T.ELLIPSE, x, y, rx, ry, o)
  }
  rbox(x, y, hw, hh, r, o = {}) {
    this.shape(T.RBOX, x, y, hw, hh, o, [this.S(r), 0, 0, 0])
  }
  seg(x1, y1, x2, y2, r, o = {}) {
    const dx = x2 - x1
    const dy = y2 - y1
    this.shape(T.SEG, (x1 + x2) / 2, (y1 + y2) / 2, Math.hypot(dx, dy) / 2, r, { ...o, rot: Math.atan2(dy, dx) })
  }
  // polyline of capsules (an arm)
  limb(pts, r, o) {
    for (let i = 0; i < pts.length - 1; i++) this.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, o)
  }
  ring(x, y, r, th, a0 = 0, a1 = 0, o = {}) {
    this.shape(T.RING, x, y, r, th, { ...o, pad: (o.pad ?? 2) + th }, [a0, a1, 0, 0])
  }
  star(x, y, r, points, inner, o = {}) {
    this.shape(T.STAR, x, y, r, r, o, [points, inner, 0, 0])
  }
  tri(x, y, hw, hh, apex, o = {}) {
    this.shape(T.TRI, x, y, hw, hh, o, [apex, 0, 0, 0])
  }
  glow(x, y, rx, ry, col, add = true) {
    this.push(x, y, rx, ry, 0, T.GLOW, 0, add ? FL.ADD : 0, [0, 0, 0, 0], [0, 0, 0, 0], col, [0, 0, 0, 0])
  }
  rays(x, y, hw, hh, cx, cy, n, angle, col, col2) {
    this.push(x, y, hw, hh, 0, T.RAYS, 0, 0, [this.S(cx), this.S(cy), n, angle], [0, 0, 0, 0], col, col2)
  }
  snow(x, y, hw, hh, density, wind, speed, col = [1, 1, 1, 0.9]) {
    this.push(x, y, hw, hh, 0, T.SNOW, 0, 0, [density, wind, speed, 0], [0, 0, 0, 0], col, [0, 0, 0, 0])
  }
  grid(x, y, hw, hh, speed, col, col2) {
    this.push(x, y, hw, hh, 0, T.GRID, 0, 0, [speed, 0, 0, 0], [0, 0, 0, 0], col, col2)
  }
  // atlas sprite centred at x,y; scale multiplies its logical size
  sprite(name, x, y, scale = 1, rot = 0, col = W) {
    const it = this.atlas.items.get(name)
    if (!it) {
      List.missing.add(name)
      return
    }
    this.push(x, y, (it.w * scale) / 2, (it.h * scale) / 2, rot, T.SPRITE, 0, 0, [0, 0, 0, 0], [it.u0, it.v0, it.u1, it.v1], col, [0, 0, 0, 0])
  }
  // a sprite squashed or stretched: sx and sy scale its width and height separately
  spriteXY(name, x, y, sx, sy, rot = 0, col = W) {
    const it = this.atlas.items.get(name)
    if (!it) return
    this.push(x, y, (it.w * sx) / 2, (it.h * sy) / 2, rot, T.SPRITE, 0, 0, [0, 0, 0, 0], [it.u0, it.v0, it.u1, it.v1], col, [0, 0, 0, 0])
  }
  size(name) {
    const it = this.atlas.items.get(name)
    return it ? [it.w, it.h] : [0, 0]
  }
  measure(set, str, scale = 1) {
    const g = this.atlas.glyphs[set]
    let w = 0
    for (const ch of str) w += (g.set[ch]?.adv ?? g.size * 0.3) * scale
    return w
  }
  // a run of glyph sprites; align: 0 left, 0.5 centre, 1 right
  text(set, str, x, y, scale = 1, align = 0.5, col = W, rot = 0) {
    const g = this.atlas.glyphs[set]
    if (!g) return 0
    let w = 0
    for (const ch of str) w += (g.set[ch]?.adv ?? g.size * 0.3) * scale
    let cx = x - w * align
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    for (const ch of str) {
      const gl = g.set[ch]
      const adv = (gl?.adv ?? g.size * 0.3) * scale
      if (gl) {
        const [gw] = this.size(gl.name)
        const off = cx + (gw * scale) / 2 - x
        this.sprite(gl.name, x + off * c, y + off * s, scale, rot, col)
      }
      cx += adv
    }
    return w
  }
  // bean: p = { x, y, R, rot, sx, sy, kind, alpha, gx, gy, lid, blink, brow, worry, smile, mouth, fx, fy, wide, squint, rim:[r,g,b,i], light:[r,g,b,i], ldir:[x,y], tired, twitch, mw, shine }
  // kind: 0 bun, 1 bowler hat (the pitchman), 2 plain (Doug), 3 robot, 6 the bowler on its own
  // the pitchman's: askew (his hat, radians), dent (in the hat), dents (in him, 0..1), daze (0..1
  // spiral eyes, 2 an X). Once the hat has come off he is kind 2.
  bean(p) {
    if (this.nb >= this.beanCap) return
    const i = this.nb++
    const o = i * BF
    const b = this.beans
    const R = this.S(p.R)
    b.set(
      [
        this.X(p.x), this.Y(p.y), R, p.rot || 0,
        p.sx ?? 1, p.sy ?? 1, p.kind || 0, p.alpha ?? 1,
        p.gx || 0, p.gy || 0, p.lid ?? 0.1, p.blink || 0,
        p.brow || 0, p.worry || 0, p.smile ?? 0.3, p.mouth || 0,
        p.fx || 0, p.fy || 0, p.wide ?? 1, p.squint || 0,
        ...(p.rim || [0.92, 0.94, 0.98, 1]),
        ...(p.light || [0, 0, 0, 0]),
        ...(p.ldir || [0, 1]), p.tired || 0, p.dent || 0,
        p.shine || 0, p.twitch || 0, p.mw ?? 1, p.dents || 0,
        ...(p.light2 || [0, 0, 0, 0]),
        ...(p.ldir2 || [0, 1]), p.askew || 0, p.daze || 0, // daze: 0..1 spiral eyes, 2 an X
      ],
      o,
    )
    this.push(p.x, p.y, 1, 1, 0, T.BEAN, 0, 0, [i, 0, 0, 0], [0, 0, 0, 0], W, W)
  }
}
