import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { COIN_ASPECT, mountCoin, type Coin } from './nmc-coin'
import './variant-nmc.css'
import { productName } from '../../../../api/src/brand'

// Direction "nmc": the price as an object. One cent, its ring cut into fifty slices with an envelope on each: fifty
// emails to the cent, which is $0.0002 each (RATES.emailUc, api/src/billing/money.ts). The coin has the page; under
// it, one line says what it costs and the slice that has slid out points at Sign in. The speed is the API's
// acceptance time, measured 2026-11-15 (p50 99 ms over 90 sends).
export function NmcHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const canvas = useRef<HTMLCanvasElement>(null), slot = useRef<HTMLDivElement>(null), action = useRef<HTMLButtonElement>(null), coin = useRef<Coin | null>(null)
  const [reduced] = useState(reducedMotion)
  useEffect(() => {
    const mounted = mountCoin(canvas.current!, slot.current!, action.current!, { reduced })
    coin.current = mounted
    return () => { coin.current = null; mounted.destroy() }
  }, [reduced])
  // While sign-in starts, the waiting slice goes into the button and a ripple runs round the coin.
  useEffect(() => { coin.current?.setBusy(busy) }, [busy])

  return <div className="nmc-page" style={{ '--nmc-aspect': COIN_ASPECT } as CSSProperties}>
    <canvas ref={canvas} className="nmc-canvas" aria-hidden="true" />
    <header className="nmc-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nmc-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nmc-main">
      {notice && <div className="nmc-notice">{notice}</div>}
      <div className="nmc-stage">
        <div ref={slot} className="nmc-coin" role="img" aria-label="A one-cent coin. Its outer ring is cut into fifty slices with an envelope on each, and one slice has slid out towards Sign in." />
      </div>
      <div className="nmc-caption">
        <h1 className="nmc-title">Fifty emails <br />a penny.</h1>
        <div className="nmc-what">
          <p className="nmc-lede">One API to send, receive, reply and thread.</p>
          <ul className="nmc-facts">
            <li>Accepted in <b>~100&nbsp;ms</b></li>
            <li><b>3,000</b> sent and <b>3,000</b> received, free every month</li>
          </ul>
        </div>
        <button ref={action} type="button" className="nmc-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent} onPointerEnter={() => coin.current?.setEager(true)} onPointerLeave={() => coin.current?.setEager(false)} onFocus={event => coin.current?.setEager(event.currentTarget.matches(':focus-visible'))} onBlur={() => coin.current?.setEager(false)}>
          Sign in
          <span className="nmc-cta-mark" aria-hidden="true">
            <ArrowRight size={18} strokeWidth={2} />
            <svg className="nmc-cta-wait" viewBox="0 0 18 18" width="18" height="18"><circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="27 41" /></svg>
          </span>
        </button>
        <SignInConsent className="nmc-consent" />
      </div>
    </main>

    <div className="nmc-footer"><HomeFooter /></div>
  </div>
}
