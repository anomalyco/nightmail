import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { mountLetters, TOTAL } from './letters-scene'
import './variant-letters.css'
import { BaneWordmark } from '../../components/BaneLogo'
import { productName } from '../../../../api/src/brand'

// Direction 4: the letters keep coming. Envelopes come through a letterbox a few at a time, then in a flood, and pile
// up on the floor; the headline counts the pile and what it cost at $0.0002 an email, and stops at 1,000 for $0.20.
// The figures are api/src/billing/money.ts's rate and the speeds measured on 2026-11-15 (plans/homepage-nightmail/numbers.md).
const RATE_TEN_THOUSANDTHS = 2

// $0.0002 an email, in whole ten-thousandths of a dollar so no float rounding shows. The last two digits are split off:
// they fade once the pile is done, leaving $0.20.
function price(count: number) {
  const units = count * RATE_TEN_THOUSANDTHS, digits = String(units % 10_000).padStart(4, '0')
  return [`$${Math.floor(units / 10_000)}.${digits.slice(0, 2)}`, digits.slice(2)] as const
}

const specs = [
  ['~100 ms', 'accepted by the API'],
  ['< 1 s', 'delivered'],
  ['$199.40', 'a million emails (Resend: $650)'],
] as const

export function LettersHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const canvas = useRef<HTMLCanvasElement>(null), countRef = useRef<HTMLSpanElement>(null), plural = useRef<HTMLSpanElement>(null)
  const priceRef = useRef<HTMLSpanElement>(null), tailRef = useRef<HTMLSpanElement>(null), titleRef = useRef<HTMLHeadingElement>(null)
  const [reduced] = useState(reducedMotion)
  const [start, startTail] = price(reduced ? TOTAL : 0)

  useEffect(() => mountLetters(canvas.current!, {
    reduced,
    onCount: count => {
      const [head, tail] = price(count)
      countRef.current!.textContent = count.toLocaleString('en-US')
      plural.current!.style.visibility = count === 1 ? 'hidden' : ''
      priceRef.current!.textContent = head; tailRef.current!.textContent = tail
    },
    onDone: () => titleRef.current!.dataset.done = '',
  }), [reduced])

  return <div className="lt-page">
    <header className="lt-bar lt-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="lt-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="lt-hero">
      <canvas ref={canvas} className="lt-canvas" aria-hidden="true" />
      <div className="lt-copy">
        <h1 ref={titleRef} className="lt-title" data-done={reduced ? '' : undefined}>
          <span className="sr-only">1,000 emails for $0.20</span>
          <span className="lt-count" aria-hidden="true" ref={countRef}>{reduced ? '1,000' : '0'}</span>
          <span className="lt-unit" aria-hidden="true">email<span ref={plural}>s</span> for <span className="lt-price"><span ref={priceRef}>{start}</span><span className="lt-tail" ref={tailRef}>{startTail}</span></span></span>
        </h1>
        <p className="lt-lede">Send, receive, reply and thread email through one API. One flat price, sent or received: no tiers, no monthly fee.</p>
        <dl className="lt-specs">
          {specs.map(([figure, label]) => <div key={label}><dt>{figure}</dt><dd>{label}</dd></div>)}
        </dl>
        <div className="lt-act">
          <button type="button" className="lt-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
            <svg className="lt-cta-flap" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 L50 40 L100 0" /></svg>
            <span className="lt-cta-label">{busy && <LoaderCircle className="ui-spinner" size={15} aria-hidden="true" />}Sign in</span>
          </button>
          <p className="lt-fine">3,000 sent and 3,000 received free every month.</p>
          <SignInConsent className="lt-fine" />
          {notice}
        </div>
      </div>
    </main>

    <div className="lt-bar lt-footer"><HomeFooter /></div>
  </div>
}

