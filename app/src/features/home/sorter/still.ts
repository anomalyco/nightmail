// The machine before its engine has loaded: the cabinet's faces, the sorting frame and the price in it, drawn flat on a
// 2D canvas in the same places and tones the renderer will use. It is on the page from the first paint and the
// renderer's first frame covers it exactly.
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
import { tone, type Mat } from './tones'

export function drawStill(canvas: HTMLCanvasElement, p: Plan, over: number, dark: boolean) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), c = canvas.getContext('2d')!
  canvas.width = Math.round(p.W * dpr); canvas.height = Math.round((p.H + over) * dpr)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  const X = (x: number, z = 0) => p.ox + x + DX * z, Y = (y: number, z = 0) => p.oy + over - y - DY * z
  const fill = (mat: Mat, t: 0 | 1 | 2 | 3) => { c.fillStyle = tone(mat, t, dark) }
  const face = (points: [number, number, number][]) => { c.beginPath(); points.forEach(([x, y, z], i) => i ? c.lineTo(X(x, z), Y(y, z)) : c.moveTo(X(x, z), Y(y, z))); c.fill() }
  const front = (x0: number, y0: number, x1: number, y1: number) => c.fillRect(X(x0), Y(y1), x1 - x0, y1 - y0)
  const { Xc, Xw, D, U, V, yTop, yWall, yMan, ySlot, yCav, yFas } = p
  // The slab: its top, its lip.
  fill('slab', 0); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, 0, p.zBack], [-p.slabX, 0, p.zBack]])
  fill('slab', 1); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, -p.lip, p.zLip], [-p.slabX, -p.lip, p.zLip]])
  fill('body', 3); face([[-Xc, 0, 0], [-Xc, 0, D], [-Xc, yTop, D], [-Xc, yTop, 0]])
  fill('body', 0); face([[-Xc, yTop, 0], [Xc, yTop, 0], [Xc, yTop, D], [-Xc, yTop, D]])
  fill('body', 1); front(-Xc, yWall, Xc, yTop)
  fill('plinth', 1); front(-Xc, 0, Xc, yWall)
  fill('wall', 1); front(-Xw, yWall, Xw, yMan)
  fill('trim', 1); front(-Xc, yMan, Xc, ySlot)
  fill('dark', 1); front(-Xw, yCav, Xw, yFas)
  fill('slot', 1); front(p.cta.x, p.cta.y, p.cta.x + p.cta.w, p.cta.y + p.cta.h)
  fill('screen', 1); front(p.readout.x, p.readout.y, p.readout.x + p.readout.w, p.readout.y + p.readout.h)
  // The tubes' channels down the front, and the gauge's face.
  fill('dark', 1); for (const x of p.tubes) front(x - p.tubeR - U / 9, p.phone ? 1.5 * V : yWall + 1.7 * V, x + p.tubeR + U / 9, yMan)
  fill('trim', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r + 2.5 * U / 9, 0, Math.PI * 2); c.fill()
  fill('dial', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r, 0, Math.PI * 2); c.fill()
  const g = U * .085, rows = PRICE.length + p.over + p.under
  for (let r = 0; r < rows; r++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const lit = PRICE[r - p.over]?.[col - p.side] === '#'
    if (lit) fill('paper', 1); else fill((col * 7 + r * 13) % 5 === 0 ? 'cell2' : 'cell', 1)
    c.fillRect(X(-Xw + col * U + g), Y(yWall + (rows - r) * V - g), U - 2 * g, V - 2 * g)
  }
}
