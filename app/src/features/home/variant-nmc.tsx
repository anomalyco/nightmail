import { useEffect, useRef, useState } from 'react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { COIN_ASPECT, mountCoin, type Coin } from './nmc-coin'
import './variant-nmc.css'
import { productName } from '../../../../api/src/brand'

// Direction "nmc": the price as an object. One cent, cut into fifty slices with an envelope on each: a slice is one
// email at $0.0002 (RATES.emailUc, api/src/billing/money.ts). The page is one line: the headline, the coin, the slice
// that has left it, Sign in. The speed is the API's acceptance time, measured 2026-11-15 (p50 99 ms over 90 sends).
// What the product is: beside the logo on a wide page, under the headline on a narrow one.
const what = 'One API to send, receive, reply and thread.'

export function NmcHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const canvas = useRef<HTMLCanvasElement>(null), slot = useRef<HTMLDivElement>(null), coin = useRef<Coin | null>(null)
  const [reduced] = useState(reducedMotion)
  useEffect(() => {
    const mounted = mountCoin(canvas.current!, slot.current!, { reduced })
    coin.current = mounted
    return () => { coin.current = null; mounted.destroy() }
  }, [reduced])
  // While sign-in starts, a ripple runs round the coin.
  useEffect(() => { coin.current?.setBusy(busy) }, [busy])

  return <div className="nmc-page">
    <canvas ref={canvas} className="nmc-canvas" aria-hidden="true" />
    <header className="nmc-bar nmc-header">
      <div className="nmc-brand">
        <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
        <p className="nmc-what">{what}</p>
      </div>
      <nav className="nmc-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nmc-main">
      {notice && <div className="nmc-notice">{notice}</div>}
      <div className="nmc-row">
        <div className="nmc-say">
          <h1 className="nmc-title"><span>Fifty </span><span>emails </span><span>a penny.</span></h1>
          <p className="nmc-lede"><span className="nmc-what">{what} </span><span>Accepted in <b>~100&nbsp;ms</b>.</span></p>
        </div>
        <div ref={slot} className="nmc-coin" style={{ aspectRatio: `1 / ${COIN_ASPECT}` }} role="img" aria-label="A one-cent coin cut into fifty slices with an envelope on each. One slice has slid out of it." />
        <div className="nmc-act">
          <button type="button" className="nmc-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in</button>
          <div className="nmc-fine">
            <p><b>3,000</b> sent and <b>3,000</b> received, free every month.</p>
            <SignInConsent />
          </div>
        </div>
      </div>
    </main>

    <div className="nmc-bar nmc-footer"><HomeFooter /></div>
  </div>
}
