// PREVIEW ONLY (?logo=): a brand outline as geometry, for the placements that build the wordmark into the machine's own
// renderer or stand it up as a solid. The outline's proportions are never changed: these only turn its path into
// points (y up, the baseline at 0), triangles for a flat face, and the edges a solid's sides are raised from.
export type Pt = [number, number]

const area = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const signed = (poly: Pt[]) => poly.reduce((sum, a, i) => { const b = poly[(i + 1) % poly.length]; return sum + a[0] * b[1] - b[0] * a[1] }, 0) / 2
const inside = (p: Pt, poly: Pt[]) => { let hit = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit } return hit }

/** The path's contours as closed rings of points, each corner's curve in `steps` chords. The brand files use only
 * absolute M, H, V, L, C and Z. `h` is the outline's height: y is turned to run up from the baseline. */
export function contours(d: string, h: number, steps = 3): Pt[][] {
  const out: Pt[][] = []
  let ring: Pt[] = [], x = 0, y = 0
  for (const [, op, rest] of d.matchAll(/([MHVLCZ])([^MHVLCZ]*)/g)) {
    const n = rest.trim() ? rest.trim().split(/[\s,]+/).map(Number) : []
    if (op === 'M') { ring = [[x = n[0], y = n[1]]]; out.push(ring) }
    else if (op === 'H') ring.push([x = n[0], y])
    else if (op === 'V') ring.push([x, y = n[0]])
    else if (op === 'L') ring.push([x = n[0], y = n[1]])
    else if (op === 'C') { for (let k = 1; k <= steps; k++) { const t = k / steps, s = 1 - t; ring.push([s * s * s * x + 3 * s * s * t * n[0] + 3 * s * t * t * n[2] + t * t * t * n[4], s * s * s * y + 3 * s * s * t * n[1] + 3 * s * t * t * n[3] + t * t * t * n[5]]) } x = n[4]; y = n[5] }
    else if (ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]) ring.pop()
  }
  return out.map(points => points.map(([px, py]): Pt => [px, h - py]))
}

/** Each solid shape of the outline: its outer ring counter-clockwise, and the rings of its holes clockwise. So the
 * material is always on an edge's left, and (dy, -dx) is the edge's normal out of it. */
export function shapes(rings: Pt[][]) {
  const holes = rings.filter(ring => rings.some(other => other !== ring && inside(ring[0], other)))
  return rings.filter(ring => !holes.includes(ring)).map(outer => ({
    outer: signed(outer) < 0 ? outer.slice().reverse() : outer,
    holes: holes.filter(hole => inside(hole[0], outer)).map(hole => signed(hole) > 0 ? hole.slice().reverse() : hole),
  }))
}

/** A shape's face as triangles (x, y of three corners each): its holes are joined to its outer ring by a cut, and
 * the ring is then clipped an ear at a time. */
export function triangles(rings: Pt[][]): number[] {
  const out: number[] = []
  for (const { outer, holes } of shapes(rings)) {
    let poly = outer
    for (const hole of holes.slice().sort((a, b) => Math.max(...b.map(p => p[0])) - Math.max(...a.map(p => p[0])))) {
      // From the hole's rightmost point to the nearest point of the ring that the cut reaches without crossing an edge.
      const h = hole.reduce((best, p, i) => p[0] > hole[best][0] ? i : best, 0), from = hole[h]
      const crosses = (a: Pt, b: Pt, c: Pt, e: Pt) => area(a, b, c) * area(a, b, e) < 0 && area(c, e, a) * area(c, e, b) < 0
      const clear = (to: Pt) => [poly, hole].every(ring => ring.every((a, i) => !crosses(from, to, a, ring[(i + 1) % ring.length])))
      const o = poly.map((p, i) => [Math.hypot(p[0] - from[0], p[1] - from[1]), i]).sort((a, b) => a[0] - b[0]).find(([, i]) => clear(poly[i]))?.[1] ?? 0
      poly = [...poly.slice(0, o + 1), ...hole.slice(h), ...hole.slice(0, h + 1), ...poly.slice(o)]
    }
    const left = poly.map((_, i) => i), same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1]
    for (let guard = 0; left.length > 3 && guard < 20000; guard++) {
      let cut = false
      for (let i = 0; i < left.length && !cut; i++) {
        const a = poly[left[(i + left.length - 1) % left.length]], b = poly[left[i]], c = poly[left[(i + 1) % left.length]], turn = area(a, b, c)
        if (turn < 0) continue
        if (turn > 0) { if (left.some(j => { const p = poly[j]; return !same(p, a) && !same(p, b) && !same(p, c) && area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0 })) continue; out.push(a[0], a[1], b[0], b[1], c[0], c[1]) }
        left.splice(i, 1); cut = true
      }
      if (!cut) break
    }
    if (left.length === 3) out.push(...left.flatMap(i => poly[i]))
  }
  return out
}

/** Every edge of every ring with the normal out of the material: what a solid's sides are raised from. */
export function edges(rings: Pt[][]): { a: Pt; b: Pt; n: Pt }[] {
  return shapes(rings).flatMap(({ outer, holes }) => [outer, ...holes]).flatMap(ring => ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return { a, b, n: [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] as Pt }
  }))
}
