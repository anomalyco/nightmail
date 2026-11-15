import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import { ACCEPTED_MS, DELIVERED_MS, PAGE_MS, plan, play, turn, type Exposure, type Mode, type Pose } from './nmb-flight'
import './variant-nmb.css'
import { productName } from '../../../../api/src/brand'

// Direction 5: the page is one second wide. A letter is thrown across it and exposed twenty times a second, as on a
// chronophotographic plate: accepted a tenth of the way over, delivered at six tenths, and the rest of the second is
// empty but for Sign in. On a portrait screen the second runs down the page and the letter is dropped.
// Figures: api/src/billing/money.ts's rate and the speeds measured on 2026-11-15 (plans/homepage-nightmail/numbers.md).

const TALL = '(max-aspect-ratio: 5/6)'
const watchMode = (changed: () => void) => { const query = matchMedia(TALL); query.addEventListener('change', changed); return () => query.removeEventListener('change', changed) }
const readMode = (): Mode => matchMedia(TALL).matches ? 'tall' : 'wide'

// How long the first throw waits for the eye to arrive, how long a finished plate rests before the next, and how long
// a plate takes to clear.
const FIRST_HOLD_MS = 420, HOLD_MS = 260, REST_MS = 6400, CLEAR_MS = 420

// The Stamp mark (components/BaneLogo.tsx) in its 100 × 100 box: the stamp on the letter.
const MARK = 'M0 0L4.84 0A5.16 5.16 0 0 0 15.16 0L24.84 0A5.16 5.16 0 0 0 35.16 0L44.84 0A5.16 5.16 0 0 0 55.16 0L64.84 0A5.16 5.16 0 0 0 75.16 0L84.84 0A5.16 5.16 0 0 0 95.16 0L100 0L100 4.84A5.16 5.16 0 0 0 100 15.16L100 24.84A5.16 5.16 0 0 0 100 35.16L100 44.84A5.16 5.16 0 0 0 100 55.16L100 64.84A5.16 5.16 0 0 0 100 75.16L100 84.84A5.16 5.16 0 0 0 100 95.16L100 100L95.16 100A5.16 5.16 0 0 0 84.84 100L75.16 100A5.16 5.16 0 0 0 64.84 100L55.16 100A5.16 5.16 0 0 0 44.84 100L35.16 100A5.16 5.16 0 0 0 24.84 100L15.16 100A5.16 5.16 0 0 0 4.84 100L0 100L0 95.16A5.16 5.16 0 0 0 0 84.84L0 75.16A5.16 5.16 0 0 0 0 64.84L0 55.16A5.16 5.16 0 0 0 0 44.84L0 35.16A5.16 5.16 0 0 0 0 24.84L0 15.16A5.16 5.16 0 0 0 0 4.84L0 0ZM16.98 16.98L83.02 16.98L83.02 83.02L16.98 83.02ZM23.91 23.91L76.09 23.91L76.09 76.09L23.91 76.09ZM31.48 31.48L68.52 31.48L68.52 68.52L31.48 68.52ZM37.63 37.63L62.37 37.63L62.37 62.37L37.63 62.37Z'

// The letter's two sides in a 100 × 68 box: the address side with its stamp, and the flap side.
function Front() {
  return <svg viewBox="0 0 100 68" aria-hidden="true">
    <rect className="nmb-paper" width="100" height="68" rx="1.6" />
    <path className="nmb-ink" d="M11 38h33M11 46h25M11 54h29" />
    <path className="nmb-stamp" fillRule="evenodd" transform="translate(77.5 8.5) scale(.14)" d={MARK} />
  </svg>
}
function Back() {
  return <svg viewBox="0 0 100 68" aria-hidden="true">
    <rect className="nmb-paper" width="100" height="68" rx="1.6" />
    <path className="nmb-flap" d="M.8 .8H99.2L50 38Z" />
    <path className="nmb-ink" d="M.8 .8L50 38L99.2 .8M.8 67.2L39.5 30M99.2 67.2L60.5 30" />
  </svg>
}

// A pose on the plate: wide, time runs left to right and the letter's height is measured up from the scale; tall, time
// runs down and the letter sways about its column.
function place(pose: Pose, mode: Mode, face: 'front' | 'back' = 'front'): CSSProperties {
  const along = `${(pose.along * 100).toFixed(3)}%`, cross = pose.cross.toFixed(4)
  return mode === 'wide'
    ? { left: along, top: `calc(100% - ${cross} * var(--nmb-u))`, transform: turn(pose, face) }
    : { top: `calc(${along} - ${pose.lift.toFixed(4)} * var(--nmb-u))`, left: `calc(var(--nmb-column) + ${cross} * var(--nmb-u))`, transform: turn(pose, face) }
}

// One exposure: the side facing the lens, in a tone set by how late it was taken and how squarely it faces the lamp.
function Exposed({ pose, mode }: { pose: Exposure; mode: Mode }) {
  const accepted = Math.abs(pose.t - ACCEPTED_MS) < 25
  return <i className={`nmb-letter nmb-exposure${accepted ? ' nmb-accepted' : ''}${pose.steep ? ' nmb-steep' : ''}`} data-at={pose.t} style={{ ...place(pose, mode, pose.front ? 'front' : 'back'), '--nmb-light': `${Math.round(100 * pose.light)}%`, '--nmb-age': `${Math.round(100 * pose.t / DELIVERED_MS)}%` } as CSSProperties}>
    {pose.front ? <Front /> : <Back />}
  </i>
}

// The scale: a tick every 10 ms, longer at each 50 and 100.
const marks = Array.from({ length: 101 }, (_, i) => ({ at: i * 10, reach: i % 10 === 0 ? 13 : i % 5 === 0 ? 8 : 5 }))
function Scale({ mode }: { mode: Mode }) {
  return <svg viewBox={mode === 'wide' ? '0 0 1000 13' : '0 0 13 1000'} preserveAspectRatio="none">
    {marks.map(({ at, reach }) => mode === 'wide' ? <line key={at} className={reach === 13 ? 'nmb-tenth' : undefined} x1={at} x2={at} y1="0" y2={reach} /> : <line key={at} className={reach === 13 ? 'nmb-tenth' : undefined} y1={at} y2={at} x1="0" x2={reach} />)}
  </svg>
}

export function NmbHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const mode = useSyncExternalStore(watchMode, readMode)
  const [reduced] = useState(reducedMotion)
  const [run, setRun] = useState(0)
  const flight = useMemo(() => plan(run, mode), [run, mode])
  const page = useRef<HTMLDivElement>(null), signingIn = useRef(busy)
  signingIn.current = busy

  // Throw, rest, clear the plate, throw the next one. A press on the plate throws again without the wait.
  useEffect(() => {
    if (reduced) return
    const root = page.current!, stage = root.querySelector<HTMLElement>('.nmb-stage')!
    let animations: Animation[] = [], timer = 0, stopped = false, resting = false
    const clear = () => {
      resting = false
      window.clearTimeout(timer)
      for (const selector of ['.nmb-flight', '.nmb-sweep']) animations.push(root.querySelector(selector)!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLEAR_MS, fill: 'both', easing: 'ease-in' }))
      timer = window.setTimeout(() => setRun(count => count + 1), CLEAR_MS)
    }
    // The plate keeps resting while the tab is hidden or sign-in is starting.
    const next = () => { if (document.hidden || signingIn.current) timer = window.setTimeout(next, 1000); else clear() }
    const start = () => {
      if (stopped) return
      if (document.hidden) { document.addEventListener('visibilitychange', start, { once: true }); return }
      animations = play(root, flight, run === 0 ? FIRST_HOLD_MS : HOLD_MS)
      timer = window.setTimeout(() => { root.dataset.lit = ''; resting = true; timer = window.setTimeout(next, REST_MS) }, Number(root.dataset.origin) + PAGE_MS)
    }
    const again = () => { if (resting && !signingIn.current) clear() }
    stage.addEventListener('pointerdown', again)
    // The first throw waits for the page's type, so nothing else is still arriving when it starts.
    if (run === 0) void document.fonts.ready.then(start); else start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', start)
      stage.removeEventListener('pointerdown', again)
      for (const animation of animations) animation.cancel()
    }
  }, [flight, run, reduced])

  const words = `This page is one second ${mode === 'wide' ? 'wide' : 'tall'}.`
  return <div ref={page} className={`nmb-page nmb-page--${mode}`} data-motion={reduced ? undefined : ''}>
    <header className="nmb-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nmb-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nmb-main">
      <h1 className="nmb-title" aria-label={words}>{words.split(' ').map((word, index) => <span key={index} aria-hidden="true">{word}{' '}</span>)}</h1>

      <div className="nmb-stage" aria-hidden="true">
        <div className="nmb-flight" key={`${mode}-${run}`}>
          {flight.exposures.map(pose => <Exposed key={pose.t} pose={pose} mode={mode} />)}
          <i className="nmb-letter nmb-live" style={place(flight.rest, mode)}><b className="nmb-body"><b className="nmb-side"><Front /></b><b className="nmb-side nmb-side--back"><Back /></b></b></i>
        </div>
        <div className="nmb-scale">
          <Scale mode={mode} />
          <div className="nmb-sweep"><div className="nmb-lit"><Scale mode={mode} /></div></div>
          <i className="nmb-marker" />
        </div>
      </div>

      <div className="nmb-below">
        <dl className="nmb-captions">
          <div className="nmb-caption nmb-caption--accepted" data-lit-at={ACCEPTED_MS}><dt>~100 ms</dt><dd>accepted</dd></div>
          <div className="nmb-caption nmb-caption--delivered" data-lit-at={DELIVERED_MS}><dt>delivered</dt><dd>to the SES mailbox simulator</dd></div>
        </dl>
        <div className="nmb-act">
          {notice && <div className="nmb-notice">{notice}</div>}
          <button type="button" className="nmb-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
            <span className="nmb-cta-label">{busy && <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" />}Sign in</span>
          </button>
          <p className="nmb-price"><b>$0.20</b> <span>per 1,000 emails, sent or received</span></p>
          <SignInConsent className="nmb-fine" />
        </div>
      </div>
    </main>

    <div className="nmb-footer"><HomeFooter /></div>
  </div>
}
