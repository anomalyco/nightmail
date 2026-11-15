// Solids for the sorter's machine: boxes, cylinders, prisms and tubes, written as triangles of position, normal and
// material into one buffer, grouped into parts. A part is drawn with its own matrix, so it can turn, swing or be
// blown off; part 0 is everything that never moves.
import type { Part } from './gl'

export type V3 = [number, number, number]
export type PartDef = Part & { name: string; pivot: V3; lo: V3; hi: V3 }

/** Which faces of a box to build: front (towards the viewer), top, left, right, back (k), bottom (b). What never moves shows only the first three. */
export const SEEN = 'ftl', ALL = 'ftlrkb'

export class Builder {
  data: number[] = []
  parts: PartDef[] = []
  private current!: PartDef
  constructor() { this.part('static') }

  part(name: string, pivot: V3 = [0, 0, 0], glass = false) {
    if (this.current) this.current.count = this.data.length / 7 - this.current.start
    this.current = { name, pivot, glass, start: this.data.length / 7, count: 0, on: true, fade: 1, m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }
    this.parts.push(this.current)
    return this.parts.length - 1
  }
  finish() { this.current.count = this.data.length / 7 - this.current.start; return new Float32Array(this.data) }

  private v(p: V3, n: V3, mat: number) {
    this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], mat)
    const { lo, hi } = this.current
    for (let i = 0; i < 3; i++) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i] }
  }
  tri(a: V3, b: V3, c: V3, n: V3, mat: number) { this.v(a, n, mat); this.v(b, n, mat); this.v(c, n, mat) }
  /** A flat four-sided face; its normal is given, or taken from the corners. */
  quad(a: V3, b: V3, c: V3, d: V3, mat: number, n?: V3) {
    if (!n) { const u = sub(b, a), w = sub(d, a); n = unit([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]) }
    this.tri(a, b, c, n, mat); this.tri(a, c, d, n, mat)
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number, faces = SEEN, top = mat) {
    if (faces.includes('f')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], mat, [0, 0, -1])
    if (faces.includes('t')) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], top, [0, 1, 0])
    if (faces.includes('l')) this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], mat, [-1, 0, 0])
    if (faces.includes('r')) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], mat, [1, 0, 0])
    if (faces.includes('k')) this.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], mat, [0, 0, 1])
    if (faces.includes('b')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], mat, [0, -1, 0])
  }
  /** A flat mark on a front face, a hair in front of it. */
  mark(x0: number, y0: number, x1: number, y1: number, z: number, mat: number) { this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], mat, [0, 0, -1]) }
  /** A cylinder round `axis` (0 x, 1 y, 2 z) from `a` to `b` along it, centred on the other two coordinates of `c`. Its wall is shaded round. */
  cyl(c: V3, axis: 0 | 1 | 2, a: number, b: number, r: number, mat: number, seg = 14, caps = 3, capMat = mat, r2 = r) {
    const u = (axis + 1) % 3, w = (axis + 2) % 3
    const at = (t: number, k: number, radius: number): V3 => { const p: V3 = [0, 0, 0]; p[axis] = t; p[u] = c[u] + Math.cos(k) * radius; p[w] = c[w] + Math.sin(k) * radius; return p }
    const normal = (k: number): V3 => { const n: V3 = [0, 0, 0]; n[u] = Math.cos(k); n[w] = Math.sin(k); return n }
    const centre = (t: number): V3 => { const p: V3 = [c[0], c[1], c[2]]; p[axis] = t; return p }
    const lo: V3 = [0, 0, 0], hi: V3 = [0, 0, 0]; lo[axis] = -1; hi[axis] = 1
    for (let i = 0; i < seg; i++) {
      const k0 = i / seg * Math.PI * 2, k1 = (i + 1) / seg * Math.PI * 2, n0 = normal(k0), n1 = normal(k1)
      const p00 = at(a, k0, r), p01 = at(a, k1, r), p10 = at(b, k0, r2), p11 = at(b, k1, r2)
      this.v(p00, n0, mat); this.v(p01, n1, mat); this.v(p11, n1, mat); this.v(p00, n0, mat); this.v(p11, n1, mat); this.v(p10, n0, mat)
      if (caps & 1) this.tri(centre(a), p01, p00, lo, capMat)
      if (caps & 2) this.tri(centre(b), p10, p11, hi, capMat)
    }
  }
  /** A convex outline in the front plane, counter-clockwise, given depth. */
  prism(points: [number, number][], z0: number, z1: number, mat: number, faces = 'fs', sideMat = mat) {
    const n = points.length
    if (faces.includes('f')) for (let i = 1; i < n - 1; i++) this.tri([points[0][0], points[0][1], z0], [points[i][0], points[i][1], z0], [points[i + 1][0], points[i + 1][1], z0], [0, 0, -1], mat)
    if (faces.includes('k')) for (let i = 1; i < n - 1; i++) this.tri([points[0][0], points[0][1], z1], [points[i + 1][0], points[i + 1][1], z1], [points[i][0], points[i][1], z1], [0, 0, 1], mat)
    if (faces.includes('s')) for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n], nx = b[1] - a[1], ny = a[0] - b[0], l = Math.hypot(nx, ny) || 1
      this.quad([a[0], a[1], z0], [a[0], a[1], z1], [b[0], b[1], z1], [b[0], b[1], z0], sideMat, [nx / l, ny / l, 0])
    }
  }
  /** A round pipe along a path, its corners swept. `from` and `to` (0 to 1) keep part of the way round: the half that is seen. */
  tube(path: V3[], r: number, mat: number, seg = 10, bend = r * 2.4) {
    // The centre line: straight runs joined by arcs.
    const line: V3[] = [path[0]]
    for (let i = 1; i < path.length - 1; i++) {
      const p = path[i], a = unit(sub(path[i - 1], p)), b = unit(sub(path[i + 1], p))
      const d = Math.min(bend, len(sub(path[i - 1], p)) / 2, len(sub(path[i + 1], p)) / 2)
      for (let k = 0; k <= 6; k++) { const t = k / 6, s = 1 - t; line.push([p[0] + a[0] * d * s * s + b[0] * d * t * t, p[1] + a[1] * d * s * s + b[1] * d * t * t, p[2] + a[2] * d * s * s + b[2] * d * t * t]) }
    }
    line.push(path[path.length - 1])
    // A frame carried along it without twisting.
    let side: V3 = Math.abs(unit(sub(line[1], line[0]))[1]) > .9 ? [1, 0, 0] : [0, 1, 0]
    const rings: { p: V3; u: V3; w: V3 }[] = []
    for (let i = 0; i < line.length; i++) {
      const t = unit(sub(line[Math.min(i + 1, line.length - 1)], line[Math.max(i - 1, 0)]))
      const w = unit(cross(t, side)), u = cross(w, t); side = u
      rings.push({ p: line[i], u, w })
    }
    const at = (ring: { p: V3; u: V3; w: V3 }, k: number): [V3, V3] => { const c = Math.cos(k), s = Math.sin(k), n: V3 = [ring.u[0] * c + ring.w[0] * s, ring.u[1] * c + ring.w[1] * s, ring.u[2] * c + ring.w[2] * s]; return [[ring.p[0] + n[0] * r, ring.p[1] + n[1] * r, ring.p[2] + n[2] * r], n] }
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < seg; j++) {
      const k0 = j / seg * Math.PI * 2, k1 = (j + 1) / seg * Math.PI * 2
      const [a, na] = at(rings[i], k0), [b, nb] = at(rings[i], k1), [c, nc] = at(rings[i + 1], k1), [d, nd] = at(rings[i + 1], k0)
      this.v(a, na, mat); this.v(b, nb, mat); this.v(c, nc, mat); this.v(a, na, mat); this.v(c, nc, mat); this.v(d, nd, mat)
    }
    return line
  }
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** A part's matrix: turned by the quaternion about its pivot, the pivot then at `at`. */
export function pose(m: Float32Array, pivot: V3, at: ArrayLike<number>, q: ArrayLike<number>, scale = 1, o = 0, qo = 0) {
  const x = q[qo], y = q[qo + 1], z = q[qo + 2], w = q[qo + 3]
  m[0] = (1 - 2 * (y * y + z * z)) * scale; m[1] = 2 * (x * y + z * w) * scale; m[2] = 2 * (x * z - y * w) * scale
  m[4] = 2 * (x * y - z * w) * scale; m[5] = (1 - 2 * (x * x + z * z)) * scale; m[6] = 2 * (y * z + x * w) * scale
  m[8] = 2 * (x * z + y * w) * scale; m[9] = 2 * (y * z - x * w) * scale; m[10] = (1 - 2 * (x * x + y * y)) * scale
  m[12] = at[o] - (m[0] * pivot[0] + m[4] * pivot[1] + m[8] * pivot[2]); m[13] = at[o + 1] - (m[1] * pivot[0] + m[5] * pivot[1] + m[9] * pivot[2]); m[14] = at[o + 2] - (m[2] * pivot[0] + m[6] * pivot[1] + m[10] * pivot[2])
}
/** A turn of `angle` about z (the page's own plane), as a quaternion. */
export const aboutZ = (angle: number): [number, number, number, number] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]
