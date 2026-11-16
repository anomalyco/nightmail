// PREVIEW ONLY. Four places the new wordmark could go on the sorter homepage, picked with ?logo=a|b|c|d so they can be
// looked at side by side. Without the parameter (and with any other value) the page is exactly as it ships. Everything
// here, the `logo` argument of sorter/plan.ts and the lines marked "?logo" in the home files go once one is chosen.
//   a  the lockup in the top bar
//   b  the wordmark sign-painted on the back wall of the works; the monogram in the top bar
//   c  the wordmark as a row of solids across the end of the page, cut off by its edge; the lockup in the top bar
//   d  the wordmark in lights at the head of the sorting frame, as wide as the price; the monogram in the top bar
import { DX, DY } from '../sorter/plan'
import { LOCKUP, MONOGRAM, WORDMARK } from './marks'
import { contours, edges } from './outline'
import './ideas.css'

// Towards the machine's light, across and up the page (sorter/gl.ts LIGHT; not imported: that is the renderer's chunk).
const LIGHT = [.24, .8]

export type LogoIdea = 'a' | 'b' | 'c' | 'd'
export function logoIdea(): LogoIdea | null {
  const value = new URLSearchParams(location.search).get('logo')
  return value === 'a' || value === 'b' || value === 'c' || value === 'd' ? value : null
}

/** The top bar's mark: the lockup (a, c), or the monogram alone where the wordmark is somewhere on the page (b, d). */
export function HeaderMark({ idea, label }: { idea: LogoIdea; label: string }) {
  const lockup = idea === 'a' || idea === 'c'
  return <a className={lockup ? 'srt-mark srt-mark-lockup' : 'srt-mark srt-mark-tile'} href="/" aria-label={label}>
    <svg viewBox={`0 0 ${lockup ? LOCKUP.w : MONOGRAM.w} 1000`} aria-hidden="true">
      <path d={MONOGRAM.d} />
      {lockup && <path d={WORDMARK.d} transform={`translate(${MONOGRAM.w + LOCKUP.gap} 0)`} />}
    </svg>
  </a>
}

/** How the end band (c) is cut: the page's margin, how much of the cap height stands over the page's edge, how deep
 * the solids are, and the room over them for what lies on top. */
export function endBand(W: number, phone: boolean) {
  const margin = phone ? 16 : 32, cap = (W - 2 * margin) / (WORDMARK.w / WORDMARK.h), depth = (phone ? .46 : .36) * cap, over = phone ? 12 : 22
  return { margin, cap, depth, top: over + DY * depth, h: Math.round(over + DY * depth + .86 * cap) }
}

// A letter lying on the solids: where along the wordmark (in its own units) and how far back, its turn, which side is up.
const LYING: { x: number; z: number; turn: number; face: 'flap' | 'address' }[] = [
  { x: 5020, z: .5, turn: -9, face: 'flap' }, { x: 5560, z: .42, turn: 14, face: 'address' }, { x: 2330, z: .56, turn: 6, face: 'address' },
  { x: 2840, z: .4, turn: -17, face: 'flap' }, { x: 300, z: .46, turn: 8, face: 'flap' }, { x: 6250, z: .52, turn: -6, face: 'address' }, { x: 10230, z: .5, turn: 4, face: 'flap' },
]

/** c: the wordmark across the end of the page, cut off by its edge: nine solids in the machine's make, standing where
 * the page stops. Each is the wordmark's own outline given depth (the face is the outline, unchanged, in the brand's
 * ink or paper); on a wide page a few letters have come to rest on top (a phone's solids are too small to hold them).
 * Where the screen keeps a strip for itself along its bottom (the home indicator), the solids stand behind a sill as
 * high as that strip instead of being cut by the screen's edge under it. */
export function EndBand({ W, phone }: { W: number; phone: boolean }) {
  const { margin, cap, depth, top, h } = endBand(W, phone), k = cap / WORDMARK.h, sx = DX * depth, sy = -DY * depth
  // The sides that are seen (the tops, and what faces left), each in the tone its facing takes from the machine's light.
  const tones = ['', '', '', '']
  for (const { a, b, n } of edges(contours(WORDMARK.d, WORDMARK.h, 5))) {
    if (n[0] * DX + n[1] * DY <= 0) continue
    const nl = n[0] * LIGHT[0] + n[1] * LIGHT[1], tone = nl > .62 ? 0 : nl > .3 ? 1 : nl > .04 ? 2 : 3
    const ax = margin + a[0] * k, ay = top + cap - a[1] * k, bx = margin + b[0] * k, by = top + cap - b[1] * k
    tones[tone] += `M${ax.toFixed(2)} ${ay.toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}L${(bx + sx).toFixed(2)} ${(by + sy).toFixed(2)}L${(ax + sx).toFixed(2)} ${(ay + sy).toFixed(2)}Z`
  }
  const lw = Math.min(46, .36 * cap), lh = lw * .7
  return <><svg className="srt-poster" width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label="Nightmail">
    {[3, 2, 1, 0].map(tone => <path key={tone} className={`srt-poster-side srt-poster-side-${tone}`} d={tones[tone]} />)}
    <path className="srt-poster-face" d={WORDMARK.d} transform={`translate(${margin} ${top}) scale(${k})`} />
    {!phone && LYING.map(({ x, z, turn, face }, i) => {
      // Drawn lying flat (across the page, and back from the solid's front edge), then seen as the machine's roof is seen.
      const at = `matrix(1 0 ${DX} ${-DY} ${(margin + x * k).toFixed(2)} ${top.toFixed(2)}) translate(0 ${(Math.min(depth - lh * .62, Math.max(lh * .62, z * depth))).toFixed(2)}) rotate(${turn})`
      return <g key={i} transform={at} className="srt-poster-letter">
        <rect className="srt-poster-shade" x={-lw / 2 - 2.5} y={-lh / 2 - 1.5} width={lw} height={lh} />
        <rect x={-lw / 2} y={-lh / 2} width={lw} height={lh} />
        {face === 'flap' ? <path d={`M${-lw / 2} ${lh / 2}L0 ${-lh * .08}L${lw / 2} ${lh / 2}`} />
          : <><rect className="srt-poster-stamp" x={lw * .24} y={lh * .1} width={lh * .3} height={lh * .3} /><path d={`M${-lw * .36} ${-lh * .02}H${lw * .02}M${-lw * .36} ${-lh * .16}H${-lw * .06}M${-lw * .36} ${-lh * .3}H${-lw * .12}`} /></>}
      </g>
    })}
  </svg><span className="srt-poster-sill" aria-hidden="true" /></>
}
