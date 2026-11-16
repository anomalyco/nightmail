import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { PrivateAddress } from '../../components/PrivateAddress'
import { BaneWordmark } from '../../components/BaneLogo'
import { useTheme } from '../../lib/theme'
import { productName } from '../../../../api/src/brand'
import { reducedMotion, type HomeProps } from '.'
import { DX, DY, onFront, plan, type Plan, type Rect } from './sorter/plan'
import { drawStill } from './sorter/still'
import { toneVars } from './sorter/tones'
import { COLS } from './sorter/price'
import { Stations } from './sorter-stations'
import type { Hooks, Letter, Phase, Sorter } from './sorter/engine'
import './variant-sorter.css'

// Direction "the sorter": the page is a mail-sorting machine. Letters fall into its hopper, are read, and leave by the
// tube for wherever they are routed; the price of a thousand of them is spelt by the thousand letters filed in its
// sorting frame. It runs faster and faster until it bursts, and the letters settle where they fall. Below it the tubes
// run on down the page to each place mail can go. The price is api/src/billing/money.ts's rate, the response time the
// acceptance time measured on 2026-11-15 (plans/homepage-nightmail/numbers.md).
const SEEN = 'sorter.seen', HEADER = { desktop: 64, phone: 56 }
/** The lanes of the works, left to right, by the names the product uses; a scam's route is the laser. */
export const LANE_NAMES = ['Threads', 'Endpoints', 'Agents', 'Inbox', 'IMAP', 'Rituals', 'Campaigns'] as const
/** Where each of the eight tubes leads, in the tubes' own order (sorter/plan.ts). */
/** The same on a phone, where a lane is forty pixels wide. */
const LANE_CODES = ['Thr', 'End', 'Agt', 'Inb', 'IMAP', 'Rit', 'Cmp'] as const
const TUBE_NAMES = ['Inbox', 'Agents', 'Endpoints', 'Threads', 'IMAP', 'Rituals', 'Campaigns', 'Logs'] as const
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']

export function SorterHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const dark = useTheme().theme === 'dark'
  const scene = useRef<HTMLElement>(null), still = useRef<HTMLCanvasElement>(null), gl = useRef<HTMLCanvasElement>(null), sorter = useRef<Sorter | null>(null)
  const readout = useRef<HTMLDivElement>(null), cardBox = useRef<HTMLDivElement>(null), counts = useRef([0, 0]), shown = useRef<Letter | null>(null)
  const [p, setP] = useState<Plan | null>(null)
  const [reduced] = useState(reducedMotion)
  // Whoever has watched it burst once gets there sooner the next time.
  const [quick] = useState(() => { try { return localStorage.getItem(SEEN) === '1' } catch { return false } })
  const [phase, setPhase] = useState<Phase>('boot'), [live, setLive] = useState(false), [card, setCard] = useState<Letter | null>(null)
  const over = p?.phone ? HEADER.phone : HEADER.desktop

  // What the machine tells the page: the letter under the scanner, the tally, where it is in its day, the letter under the pointer.
  const [hooks] = useState<Hooks>(() => ({
    scan(letter, verdict) {
      const box = readout.current
      if (!box) return
      const [from, subject, route] = box.children as unknown as HTMLElement[]
      box.dataset.verdict = verdict
      if (letter) { from.textContent = letter.from; subject.textContent = letter.subject; route.textContent = letter.scam ? 'Scam' : LANE_NAMES[letter.route] }
      else if (verdict === 'jam') { from.textContent = `${counts.current[0]} sorted, ${counts.current[1]} burnt`; subject.textContent = 'Jammed. Press the gauge.'; route.textContent = '' }
      else { from.textContent = `${productName.toLowerCase()} sorter`; subject.textContent = 'Waiting for mail'; route.textContent = '' }
    },
    count(sorted, burnt) { counts.current = [sorted, burnt] },
    phase(next) { setPhase(next); if (next === 'boom') try { localStorage.setItem(SEEN, '1') } catch { /* private mode: the long version again next time */ } },
    hover(letter, x, y) {
      if (letter !== shown.current) { shown.current = letter; setCard(letter) }
      // The card stays on the page: clear of both edges, and of the top.
      const width = scene.current?.clientWidth ?? 0, half = (width < 900 ? 232 : 264) / 2 + 8
      // (And under the letter where there is no room over it.)
      if (letter && cardBox.current) { cardBox.current.style.translate = `${Math.round(Math.min(width - half, Math.max(half, x)))}px ${Math.round(Math.max(24, y))}px`; cardBox.current.toggleAttribute('data-under', y < 176) }
    },
  }))

  // Before the first paint: measure the page and place the machine, so nothing moves afterwards.
  useLayoutEffect(() => {
    const measure = () => { const box = scene.current!, next = plan(box.clientWidth, box.clientHeight); setP(now => now && now.W === next.W && now.H === next.H ? now : next) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene.current!)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { if (p) drawStill(still.current!, p, over, dark) }, [p, over, dark])

  // After the first paint: fetch the engine and start it; then the letters.
  useEffect(() => {
    if (!p) return
    if (sorter.current) { sorter.current.setPlan(p, over); return }
    let cancelled = false
    const start = async () => {
      const [{ mountSorter }, { STARTERS, loadLetters }] = await Promise.all([import('./sorter/engine'), import('./sorter/letters')])
      if (cancelled || sorter.current) return
      const mounted = mountSorter(gl.current!, { plan: p, over, dark: document.documentElement.dataset.theme === 'dark', reduced, quick, letters: STARTERS, hooks })
      if (!mounted) return
      sorter.current = mounted; setLive(true)
      loadLetters().then(letters => sorter.current?.setLetters(letters)).catch(() => { /* the machine keeps its first dozen */ })
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => void start()))
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [p, over, reduced, quick, hooks])
  useEffect(() => () => { sorter.current?.destroy(); sorter.current = null }, [])
  useEffect(() => { sorter.current?.setTheme(dark) }, [dark])
  // Off screen the machine stands still.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => sorter.current?.setVisible(entry.isIntersecting), { threshold: .02 })
    observer.observe(scene.current!)
    return () => observer.disconnect()
  }, [])
  // The old code brings the flood.
  useEffect(() => {
    let at = 0
    const onKey = (event: KeyboardEvent) => {
      at = event.key === KONAMI[at] ? at + 1 : event.key === KONAMI[0] ? 1 : 0
      // Two ups in, the arrows belong to the code: the page doesn't scroll under it (nor rubber-band at its top).
      if (event.key.startsWith('Arrow') && (at > 2 || (event.key === 'ArrowUp' && window.scrollY <= 0))) event.preventDefault()
      if (at === KONAMI.length) { at = 0; sorter.current?.rain() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const at = (r: Rect): CSSProperties => p ? onFront(p, r) : { display: 'none' }
  const price = p ? { x: -COLS / 2 * p.U, w: COLS * p.U } : { x: 0, w: 0 }
  return <div className="srt-page" data-phase={phase} data-live={live || undefined} data-phone={p?.phone || undefined} style={{ ...toneVars(dark), ...p && { '--srt-u': `${p.U}px`, '--srt-v': `${p.V}px`, '--srt-price': `${price.w}px`, '--srt-below': `${p.floor - p.front - p.lip}px`, '--srt-ext': `${p.ext}px` } } as CSSProperties}>
    <header className="srt-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="srt-nav" aria-label="Site">
        <a href="/docs">API docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main>
      <section className="srt-hero" ref={scene} aria-label="Pricing">
        <canvas ref={still} className="srt-canvas" aria-hidden="true" />
        <canvas ref={gl} className="srt-canvas srt-gl" aria-hidden="true" />
        {p && <div className="srt-on">
          {/* On the fascia: what the scanner is reading, and the gauge (press it and see). */}
          <div className="srt-readout" ref={readout} style={at(p.readout)} data-verdict="idle" aria-hidden="true">
            <span className="srt-readout-from">{productName.toLowerCase()} sorter</span><span className="srt-readout-subject">Waiting for mail</span><span className="srt-readout-route" />
          </div>
          <button type="button" className="srt-gauge" style={at({ x: p.gauge.x - p.gauge.r - 5, y: p.gauge.y - p.gauge.r - 5, w: 2 * p.gauge.r + 10, h: 2 * p.gauge.r + 10 })} aria-label={phase === 'rest' ? 'Put the sorter back together' : 'Pressure gauge'} title={phase === 'rest' ? 'Put it back together' : 'Pressure'} onClick={() => sorter.current?.gauge()} />
          <ol className="srt-lanes" aria-hidden="true">{p.lanes.map((x, i) => <li key={i} style={at({ x: x - .46 * p.P, y: p.ySlot + .14 * p.slot, w: .92 * p.P, h: .72 * p.slot })}>{p.phone ? LANE_CODES[i] : LANE_NAMES[i]}</li>)}</ol>
          {/* The send cannon: press it and it fires one. */}
          <button type="button" className="srt-cannon" style={(() => { const c = p.cannon, sx = DX * c.z, sy = DY * c.z, ce = Math.cos(c.el), se = Math.sin(c.el), x0 = c.x - c.back * ce - 2.4 * c.cs, x1 = c.x + c.fore * ce + c.r, top = c.y + c.pivot + c.fore * se + c.r
            return { left: p.ox + x0 + sx - 4, top: p.oy - top - sy - 4, width: x1 - x0 + 8, height: top - c.y + 8 } })()} aria-label="Send cannon: fire a letter" title="Send one" onClick={() => sorter.current?.send()} />
          {!p.phone && <ol className="srt-lanes srt-mouths" aria-hidden="true">{p.drops.map((x, t) => <li key={t} data-side={t < 4 ? 'l' : 'r'} style={{ top: p.oy + p.front, height: p.lip, ...(t < 4 ? { left: x + p.tubeR + 7 } : { right: p.W - x + p.tubeR + 9 }) }}>{TUBE_NAMES[t]}</li>)}</ol>}
          {/* Under the price, as wide as the price: what it buys. */}
          <h1 className="srt-band" style={at({ x: price.x, y: p.yBand, w: price.w, h: p.band })} aria-label="$0.20 per 1,000 emails, sent or received via API.">
            <span className="srt-line" aria-hidden="true">
              <span className="srt-row"><span>per</span><span>1,000</span><span>emails,</span></span>
              <span className="srt-row srt-row-wide"><span>sent</span><span>or</span><span>received</span><span>via</span><span className="srt-last">API<span className="srt-stop">.</span></span></span>
            </span>
          </h1>
          <div className="srt-base" style={p.phone ? at({ x: price.x, y: p.cta.y + p.cta.h, w: price.w, h: p.base - p.cta.y - p.cta.h }) : at({ x: -p.Xc + 2.4 * p.U, y: p.cta.y, w: 2 * p.Xc - 4.8 * p.U, h: p.cta.h })}>
            <p className="srt-fact"><span className="srt-fact-label">Responds in</span><span className="srt-fact-value"><i>~</i>100<i> ms</i></span></p>
            <p className="srt-fact" data-tight={p.tight || undefined}><span className="srt-fact-label">Free every month</span><span className="srt-fact-value"><span>3,000<i> sent</i></span><i className="srt-fact-dot"> · </i><span>3,000<i> received</i></span></span></p>
          </div>
          <button type="button" className="srt-cta" style={at(p.cta)} disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
            <span className="srt-cta-label">Get started{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
          </button>
        </div>}
        {p && <>
          <SignInConsent className="srt-consent" />
          {/* The letter under the pointer, opened. */}
          <div className="srt-card" ref={cardBox} data-open={card ? '' : undefined} aria-hidden="true">
            {card && <div className="srt-card-body" data-scam={card.scam || undefined}>
              <span className="srt-card-from"><span>{card.from}</span><PrivateAddress value={card.addr} /></span>
              <b>{card.subject}</b>
              <span>{card.snippet}</span>
              <span className="srt-card-route">{card.scam ? 'A scam. Click to burn it.' : `Routed to ${LANE_NAMES[card.route]}`}</span>
            </div>}
          </div>
        </>}
        {notice && <div className="srt-notice">{notice}</div>}
      </section>
      <Stations plan={p} onSignIn={onSignIn} onSignInIntent={onSignInIntent} busy={busy} />
    </main>
  </div>
}
