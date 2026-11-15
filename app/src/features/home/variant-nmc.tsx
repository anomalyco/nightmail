import { useEffect, useRef, useState } from 'react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { mountCoin, type Coin } from './nmc-coin'
import './variant-nmc.css'
import { productName } from '../../../../api/src/brand'

// Direction "nmc": the price as an object. One cent, cut into fifty slices with an envelope on each: a slice is one
// email at $0.0002 (RATES.emailUc, api/src/billing/money.ts). The slice that has slid out points at Sign in.
// The speed is the API's measured acceptance time (plans/homepage-nightmail/numbers.md, 2026-11-15).
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
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
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
          <p className="nmc-lede"><span>One API to send, receive, </span><span>reply and thread. </span><span>Accepted in <b>~100&nbsp;ms</b>.</span></p>
        </div>
        <div ref={slot} className="nmc-coin" role="img" aria-label="A one-cent coin cut into fifty slices with an envelope on each. One slice has slid out of it." />
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
