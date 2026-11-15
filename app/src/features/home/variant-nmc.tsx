import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { reducedMotion, type HomeProps } from '.'
import { COIN_ASPECT, mountCoin, type Coin } from './nmc-coin'
import './variant-nmc.css'
import { productName, sdkPackage } from '../../../../api/src/brand'

// Direction "nmc": the price as an object. One cent, its ring cut into fifty slices, one of them an email that has
// left it: fifty emails to the cent, which is $0.0002 each (RATES.emailUc, api/src/billing/money.ts). The coin has
// the page; its caption says what it costs, and the slice that has left points at Sign in. The speed is the API's
// acceptance time, measured 2026-11-15 (p50 99 ms over 90 sends).
export function NmcHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const canvas = useRef<HTMLCanvasElement>(null), slot = useRef<HTMLDivElement>(null), action = useRef<HTMLButtonElement>(null), coin = useRef<Coin | null>(null)
  const [reduced] = useState(reducedMotion)
  // As the slice the coin throws comes down, Sign in's arrow moves once.
  const [landed, setLanded] = useState(false)
  // Before the first paint, so that the coin is on it.
  useLayoutEffect(() => {
    const mounted = mountCoin(canvas.current!, slot.current!, action.current!, { reduced, onLand: () => setLanded(true) })
    coin.current = mounted
    return () => { coin.current = null; mounted.destroy() }
  }, [reduced])
  // While sign-in starts, a light keeps going round the coin.
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
        <div ref={slot} className="nmc-coin" role="img" aria-label="A one-cent coin. Its outer ring is cut into fifty slices, and one of them, with an envelope on it, has been thrown out towards Sign in." />
      </div>
      <div className="nmc-caption">
        <h1 className="nmc-title">Fifty emails <br />a penny.</h1>
        {/* Three claims: two lines on a wide page, a line each on a phone. */}
        <div className="nmc-lede">
          <p>One API to send, receive, reply and thread.</p>{' '}
          <p>Accepted in <b>~100&nbsp;ms</b>.</p>{' '}
          <p>Free every month: <b>3,000</b>&nbsp;sent&nbsp;and&nbsp;<b>3,000</b>&nbsp;received.</p>
        </div>
        <button ref={action} type="button" className="nmc-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} data-landed={landed || undefined} onClick={onSignIn} onPointerDown={onSignInIntent} onPointerEnter={() => coin.current?.setEager(true)} onPointerLeave={() => coin.current?.setEager(false)} onFocus={event => coin.current?.setEager(event.currentTarget.matches(':focus-visible'))} onBlur={() => coin.current?.setEager(false)}>
          Sign in
          {/* The arrow, drawn at the weight of the label's strokes, and the spinner that takes its place: a faint
              ring with an arc going round it. */}
          <svg className="nmc-cta-mark" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path className="nmc-cta-go" d="M3 9h12M10 4l5 5-5 5" />
            <g className="nmc-cta-wait"><circle cx="9" cy="9" r="6.5" opacity=".22" /><circle className="nmc-cta-turn" cx="9" cy="9" r="6.5" strokeDasharray="13 41" /></g>
          </svg>
        </button>
        <SignInConsent className="nmc-consent" />
      </div>
    </main>

    {/* The page's own footer: Docs is in the header and the Terms and Privacy Policy are beside Sign in. */}
    <footer className="nmc-footer">
      <a className="home-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={20} /></a>
      <nav aria-label="Site links"><a href="/openapi.json">OpenAPI</a><a href={`https://www.npmjs.com/package/${sdkPackage}`}>SDK</a></nav>
    </footer>
  </div>
}
