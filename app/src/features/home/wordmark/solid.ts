// PREVIEW ONLY (?logo=b|d): the wordmark built into the machine, so the machine's own light, shadows and whatever
// passes in front of it treat it as one more of its parts. Its face is the outline itself, flat, in the plane the plan
// names; where it stands off the wall behind (`depth`), the sides that are seen are raised in a second material, so
// the face keeps the outline's exact shape.
import type { Builder, V3 } from '../sorter/mesh'
import { DX, DY, type Plan } from '../sorter/plan'
import { WORDMARK } from './marks'
import { contours, edges, triangles } from './outline'

export function nameOn(b: Builder, at: NonNullable<Plan['name']>, face: number, side: number) {
  const k = at.cap / WORDMARK.h, rings = contours(WORDMARK.d, WORDMARK.h, at.cap > 30 ? 4 : 3), flat = triangles(rings)
  const P = (x: number, y: number, z: number): V3 => [at.x + x * k, at.y + y * k, z]
  for (let i = 0; i < flat.length; i += 6) b.tri(P(flat[i], flat[i + 1], at.z), P(flat[i + 2], flat[i + 3], at.z), P(flat[i + 4], flat[i + 5], at.z), [0, 0, -1], face)
  if (at.depth) for (const { a, b: e, n } of edges(rings)) if (n[0] * DX + n[1] * DY > 0) b.quad(P(a[0], a[1], at.z), P(e[0], e[1], at.z), P(e[0], e[1], at.z + at.depth), P(a[0], a[1], at.z + at.depth), side, [n[0], n[1], 0])
}
