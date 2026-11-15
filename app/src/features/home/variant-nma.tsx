import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { reducedMotion, type HomeProps } from '.'
import { LETTERS, mountScene, type Scene } from './nma-scene'
import './variant-nma.css'
import { BaneWordmark } from '../../components/BaneLogo'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { productName } from '../../../../api/src/brand'

// Direction "night": the page is one building at night. A thousand letters fly in and lodge in its windows until the
// lit ones spell what a thousand emails cost; the only other light is the door, which signs you in. The price is
// api/src/billing/money.ts's rate, the speed the acceptance time measured on 2026-11-15 (plans/homepage-nightmail/numbers.md).
const SEEN = 'nma.seen'
export function NightHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLElement>(null), base = useRef<HTMLCanvasElement>(null), air = useRef<HTMLCanvasElement>(null), door = useRef<HTMLButtonElement>(null)
  const scene = useRef<Scene | null>(null), tally = useRef<HTMLSpanElement>(null)
  const [reduced] = useState(reducedMotion)
  // Whoever has watched the thousand letters arrive once gets the short version from then on.
  const [quick] = useState(() => { try { return localStorage.getItem(SEEN) === '1' } catch { return false } })

  // Before the first paint: the scene measures the page and places the building, so nothing moves afterwards.
  useLayoutEffect(() => {
    const mounted = mountScene({ root: root.current!, scene: stage.current!, base: base.current!, air: air.current!, door: door.current!, reduced, quick,
      onCount: letters => {
        // The counter is an odometer: four figures and their comma, the leading ones unlit until the count reaches them.
        const figures = String(Math.min(letters, LETTERS - 1)).padStart(4, '0'), cells = tally.current!.children
        for (let i = 0; i < 4; i++) { const cell = cells[i < 1 ? 0 : i + 1]; cell.textContent = figures[i]; cell.classList.toggle('nma-off', letters < 10 ** (3 - i)) }
        if (letters >= LETTERS) try { localStorage.setItem(SEEN, '1') } catch { /* private mode: the long version again next time */ }
      } })
    scene.current = mounted
    return () => { mounted.destroy(); scene.current = null }
  }, [reduced, quick])
  useEffect(() => { scene.current?.welcome(busy) }, [busy])

  return <div className="nma-page" ref={root} data-nma={reduced ? 'settled' : 'dark'}>
    <header className="nma-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nma-nav" aria-label="Site">
        <a href="/docs">API docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nma-scene" ref={stage}>
      <canvas ref={base} className="nma-canvas" aria-hidden="true" />
      <canvas ref={air} className="nma-canvas nma-air" aria-hidden="true" />
      {/* The sentence cut into the frieze under the price, as wide as the price (its full stop hangs past the edge; on a
          phone it takes two lines and the second is the price's width). It is there from the first paint, a step dim,
          its number an odometer at 0,000 that counts the letters as they land; with the thousandth it all lights. */}
      <h1 className="nma-band" aria-label="$0.20 per 1,000 emails, sent or received via API.">
        <span className="nma-line" aria-hidden="true">
          <span className="nma-row">
            <span className="nma-copy">per</span>
            <span><span className="nma-count"><span className="nma-tally"><span className="nma-odo" ref={tally}><span className="nma-digit nma-off">0</span><span className="nma-off">,</span><span className="nma-digit nma-off">0</span><span className="nma-digit nma-off">0</span><span className="nma-digit nma-off">0</span></span><span className="nma-final">1,000</span></span> emails</span><span className="nma-copy">,</span></span>
          </span>
          <span className="nma-row nma-row-wide">
            <span className="nma-copy">sent</span>
            <span className="nma-copy">or</span>
            <span className="nma-copy">received</span>
            <span className="nma-copy">via</span>
            <span className="nma-copy nma-last">API<span className="nma-stop">.</span></span>
          </span>
        </span>
      </h1>
      <div className="nma-ground">
        <p className="nma-fact"><span className="nma-fact-label">Responds in</span> <span className="nma-fact-value">~<b className="nma-copy">100</b> ms</span></p>
        <button ref={door} type="button" className="nma-door" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}
          onPointerEnter={event => { if (event.pointerType === 'mouse') scene.current?.hover(true) }} onPointerLeave={() => scene.current?.hover(false)} onFocus={() => scene.current?.hover(true)} onBlur={() => scene.current?.hover(false)}>
          <span className="nma-door-label">Sign in{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="nma-door-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
        </button>
        <p className="nma-fact"><span className="nma-fact-label">Free every month</span> <span className="nma-fact-value"><b className="nma-copy">3,000</b> each way</span></p>
      </div>
      {/* On the pavement: what signing in agrees to, under the door, and whose building this is. */}
      <div className="nma-street">
        <a className="nma-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a>
        <SignInConsent className="nma-consent" />
      </div>
      {notice && <div className="nma-notice">{notice}</div>}
    </main>
  </div>
}
