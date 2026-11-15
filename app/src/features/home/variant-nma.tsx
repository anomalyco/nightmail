import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { mountScene, type Scene } from './nma-scene'
import './variant-nma.css'
import { BaneWordmark } from '../../components/BaneLogo'
import { productName } from '../../../../api/src/brand'

// Direction "night": the page is one building at night. A thousand letters fly in and lodge in its windows until the
// lit ones spell what a thousand emails cost; the only other light is the door, which signs you in. The price is
// api/src/billing/money.ts's rate, the speed the acceptance time measured on 2026-11-15 (plans/homepage-nightmail/numbers.md).
export function NightHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLElement>(null), base = useRef<HTMLCanvasElement>(null), air = useRef<HTMLCanvasElement>(null), door = useRef<HTMLButtonElement>(null)
  const scene = useRef<Scene | null>(null), line = useRef<HTMLSpanElement>(null), count = useRef<HTMLSpanElement>(null), tally = useRef<HTMLSpanElement>(null), plural = useRef<HTMLSpanElement>(null)
  const [reduced] = useState(reducedMotion)

  // Before the first paint: the scene measures the page and places the building, so nothing moves afterwards.
  useLayoutEffect(() => {
    const mounted = mountScene({ root: root.current!, scene: stage.current!, base: base.current!, air: air.current!, door: door.current!, reduced,
      onCount: letters => {
        const text = letters.toLocaleString('en-US'), grew = text.length !== tally.current!.textContent!.length
        tally.current!.textContent = text; plural.current!.style.visibility = letters === 1 ? 'hidden' : ''
        // The number keeps the room its last value needs; until it fills it, the count is nudged back onto the centre line.
        if (grew) root.current!.style.setProperty('--nma-count-nudge', `${(tally.current!.parentElement!.offsetWidth - tally.current!.offsetWidth) / 2}px`)
      } })
    scene.current = mounted
    // While it counts, the number stands in the middle of the wall; it steps aside as the rest of its sentence arrives.
    const centre = () => {
      const whole = line.current!.getBoundingClientRect(), part = count.current!.getBoundingClientRect(), moved = parseFloat(getComputedStyle(count.current!).translate) || 0
      root.current!.style.setProperty('--nma-count-shift', `${whole.left + whole.width / 2 - (part.left - moved + part.width / 2)}px`)
      root.current!.style.setProperty('--nma-count-nudge', `${(tally.current!.parentElement!.offsetWidth - tally.current!.offsetWidth) / 2}px`)
    }
    centre()
    void document.fonts.ready.then(() => { if (scene.current === mounted) centre() })
    return () => { mounted.destroy(); scene.current = null }
  }, [reduced])
  useEffect(() => { scene.current?.welcome(busy) }, [busy])

  return <div className="nma-page" ref={root} data-nma={reduced ? 'settled' : 'dark'}>
    <header className="nma-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nma-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nma-scene" ref={stage}>
      <canvas ref={base} className="nma-canvas" aria-hidden="true" />
      <canvas ref={air} className="nma-canvas nma-air" aria-hidden="true" />
      {/* The sentence under the price. Its number counts the letters as they land; the words either side arrive with the last one. */}
      <h1 className="nma-band" aria-label="$0.20 per 1,000 emails, sent or received.">
        <span aria-hidden="true" ref={line}>
          <span className="nma-copy">per </span>
          <span className="nma-count" ref={count}><span className="nma-tally"><span className="nma-tally-room">1,000</span><span className="nma-tally-value" ref={tally}>{reduced ? '1,000' : '0'}</span></span> email<span ref={plural}>s</span></span>
          <span className="nma-copy">, sent or received.</span>
        </span>
      </h1>
      <div className="nma-ground">
        <p className="nma-plaque nma-copy">Accepted in <br /><b>~100 ms</b></p>
        <button ref={door} type="button" className="nma-door" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}
          onPointerEnter={event => { if (event.pointerType === 'mouse') scene.current?.hover(true) }} onPointerLeave={() => scene.current?.hover(false)} onFocus={() => scene.current?.hover(true)} onBlur={() => scene.current?.hover(false)}>
          <span className="nma-door-label">{busy && <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" />}Sign in</span>
        </button>
        <p className="nma-plaque nma-copy"><b>3,000</b> each way, <br />free every month</p>
      </div>
      <div className="nma-street">
        <SignInConsent className="nma-consent" />
        <HomeFooter />
      </div>
      {notice && <div className="nma-notice">{notice}</div>}
    </main>
  </div>
}
