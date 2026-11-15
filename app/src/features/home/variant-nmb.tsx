import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { reducedMotion, type HomeProps } from '.'
import { DELIVERED_MS, ENTER_MS, LAUNCH_MS, LOOP_MS, RESET_MS, STILL_MS, TABLET, TALL, WIDE, buildBench, poseAt, stylesOf, tracksOf, type Bench, type Part, type Piece } from './nmb-bench'
import './variant-nmb.css'
import { productName, sdkPackage } from '../../../../api/src/brand'

// Direction 5, round 3: a timing bench. The page is one instrument: a rail a second long, a letter in a sled, a gate
// where the API accepts it and a gate where it is delivered, and a stopwatch. It runs in real time at the speeds
// measured on 2026-11-15 (plans/homepage-nightmail/numbers.md), then draws the sled back and runs again.
// The bench itself, its model and its motion are in nmb-bench.ts; this file lays the page out around it.

// Which drawing of the bench a screen gets: across the page on a wide one, under the headline on a tall one, and on a
// phone a shorter, plainer cut of that.
const TALL_SCREEN = '(max-width: 960px), (max-aspect-ratio: 11/10)', SMALL_SCREEN = '(max-width: 600px)'
const watchScreen = (changed: () => void) => {
  const queries = [matchMedia(TALL_SCREEN), matchMedia(SMALL_SCREEN)]
  for (const query of queries) query.addEventListener('change', changed)
  return () => { for (const query of queries) query.removeEventListener('change', changed) }
}
const readScreen = () => !matchMedia(TALL_SCREEN).matches ? WIDE : matchMedia(SMALL_SCREEN).matches ? TALL : TABLET

const REQUEST = 'POST /v1/emails/send'
const LABEL = `A timing bench. A letter stands in a sled on a rail one second long. A sprung starter marked “${REQUEST}” throws it down the rail: it passes a gate marked “accepted” a tenth of the way along and is caught at a gate marked “delivered”, six tenths of the way along, where a stopwatch stops.`

const pct = (share: number) => `${Math.round(share * 1e5) / 1e3}%`

// The bench at one moment of its loop. The moving parts keep these styles until the loop's animations take them over;
// a visitor who asked for no motion keeps them for good.
const BenchView = memo(function BenchView({ bench, at }: { bench: Bench; at: number }) {
  const { width, height } = bench, styles = stylesOf(poseAt(at, bench), bench)
  const sheet = (markup: string) => <svg className="nb-sheet" viewBox={`0 0 ${width} ${height}`} dangerouslySetInnerHTML={{ __html: markup }} />
  const piece = ({ markup, box }: Piece, part?: Part, pivot?: readonly [number, number]) => <svg
    className="nb-piece" data-part={part} viewBox={box.join(' ')}
    style={{ left: pct(box[0] / width), top: pct(box[1] / height), width: pct(box[2] / width), height: pct(box[3] / height), transformOrigin: pivot && `${pct((pivot[0] - box[0]) / box[2])} ${pct((pivot[1] - box[1]) / box[3])}`, ...(part && styles[part]) }}
    dangerouslySetInnerHTML={{ __html: markup }} />
  const hold = (part: Part, children: ReactNode) => <div className="nb-hold" data-part={part} style={styles[part]}>{children}</div>
  // A gate's ping: a ring lying flat on its lamp, so twice as wide as it is tall.
  const reach = 22 * Math.hypot(...bench.along) / width
  const ping = (part: 'pingA' | 'pingB', [x, y]: readonly [number, number]) => <i className="nb-ping" data-part={part} style={{ left: pct(x / width), top: pct(y / height), width: pct(reach), marginLeft: pct(-reach / 2), marginTop: pct(-reach / 4), ...styles[part] }} />
  return <div className="nmb-bench" role="img" aria-label={LABEL} style={{ aspectRatio: `${width} / ${height}` }}>
    {sheet(bench.back)}
    {piece(bench.arc, 'arc')}
    {piece(bench.needle, 'needle', bench.needle.pivot)}
    {hold('crown', piece(bench.crown))}
    {hold('buffer', piece(bench.buffer))}
    {hold('sled', piece(bench.sled))}
    {hold('letterAt', piece(bench.letter, 'letter', bench.letter.pivot))}
    {hold('grip', piece(bench.grip))}
    {hold('plunger', piece(bench.plunger))}
    {bench.coils.map((coil, index) => <div key={index} className="nb-hold" data-part={`coil${index}`} style={styles[`coil${index}`]}>{piece(coil)}</div>).reverse()}
    {sheet(bench.front)}
    {piece(bench.key, 'key', bench.key.pivot)}
    {piece(bench.lampA, 'lampA')}
    {piece(bench.lampB, 'lampB')}
    {bench.said.map((name, index) => <div key={index} className="nb-hold" data-part={`said${index}`} style={styles[`said${index}` as Part]}>{piece(name)}</div>)}
    {ping('pingA', bench.pings[0])}
    {ping('pingB', bench.pings[1])}
  </div>
})

// The page arrives in order: each .nmb-enter rises into place, a beat after the one before. Type fades up as it
// rises; Sign in is solid from its second frame, because a button at half strength reads as one that is switched off.
const ARRIVE: Keyframe[] = [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }]
const ARRIVE_SOLID: Keyframe[] = [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, offset: .12 }, { opacity: 1, transform: 'translateY(0)' }]
const ARRIVE_MS = 820, BEAT_MS = 75, EASE = 'cubic-bezier(.16, 1, .3, 1)'

export function NmbHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const spec = useSyncExternalStore(watchScreen, readScreen)
  const bench = useMemo(() => buildBench(spec), [spec])
  const [reduced] = useState(reducedMotion)
  const page = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (reduced) return
    const root = page.current!
    const loops: Animation[] = [], arrivals: Animation[] = []
    let stopped = false
    const start = () => {
      if (stopped) return
      root.querySelectorAll<HTMLElement>('.nmb-enter').forEach(element => {
        arrivals.push(element.animate(element.classList.contains('nmb-act') ? ARRIVE_SOLID : ARRIVE, { id: 'nmb-enter', duration: ARRIVE_MS, delay: BEAT_MS * Number(element.dataset.beat ?? 0), easing: EASE, fill: 'both' }))
      })
      const tracks = tracksOf(bench)
      for (const part of Object.keys(tracks) as Part[]) {
        const animation = root.querySelector(`.nmb-bench [data-part="${part}"]`)!.animate(tracks[part], { id: 'nmb-loop', duration: LOOP_MS, iterations: Infinity })
        animation.currentTime = ENTER_MS
        loops.push(animation)
      }
      root.dataset.live = ''
    }
    // Nothing moves until the type is in, so no line re-wraps under a running animation. A font that never arrives
    // doesn't hold the page.
    const patience = window.setTimeout(start, 1200)
    void document.fonts.ready.then(() => { window.clearTimeout(patience); start() })

    // The bench rests while the tab is hidden, and a press on it sends the next letter without the wait.
    const rest = () => { for (const animation of loops) if (document.hidden) animation.pause(); else animation.play() }
    const again = () => {
      const now = Number(loops[0]?.currentTime ?? 0), within = now % LOOP_MS
      if (within > LAUNCH_MS + DELIVERED_MS + 500 && within < RESET_MS) for (const animation of loops) animation.currentTime = now - within + RESET_MS
    }
    const stage = root.querySelector('.nmb-bench')!
    document.addEventListener('visibilitychange', rest)
    stage.addEventListener('pointerdown', again)
    return () => {
      stopped = true
      window.clearTimeout(patience)
      document.removeEventListener('visibilitychange', rest)
      stage.removeEventListener('pointerdown', again)
      for (const animation of [...loops, ...arrivals]) animation.cancel()
      delete root.dataset.live
    }
  }, [bench, reduced])

  // What the layout needs from the drawing: its proportions, the part of it that spans the page, and where the gate
  // the pitch hangs from stands.
  const drawn = { '--nb-aspect': bench.width / bench.height, '--nb-from': bench.window[0], '--nb-to': bench.window[1], '--nb-post': bench.post } as CSSProperties
  return <div ref={page} className={`nmb-page nmb-page--${spec.name}${spec.fine ? '' : ' nmb-page--small'}`} data-motion={reduced ? undefined : ''}>
    <header className="nmb-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nmb-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>

    <main className="nmb-main" style={drawn}>
      {notice && <div className="nmb-notice">{notice}</div>}
      <h1 className="nmb-title"><span className="nmb-enter" data-beat="0">Email, delivered</span> <span className="nmb-enter" data-beat="1">in under a second.</span></h1>
      <div className="nmb-pitch">
        <p className="nmb-sub nmb-enter" data-beat="3"><span>Accepted by the API in <b>~100&nbsp;ms</b>.</span> <span><b>$0.20</b> per 1,000 emails, sent or received.</span></p>
        <div className="nmb-act nmb-enter" data-beat="4">
          <button type="button" className="nmb-cta" disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
            Sign in
            <span className="nmb-cta-mark" aria-hidden="true">{busy ? <LoaderCircle className="ui-spinner" size={16} /> : <ArrowRight size={16} />}</span>
          </button>
          <SignInConsent className="nmb-consent" />
        </div>
      </div>
      <div className="nmb-figure">
        <div className="nmb-stage nmb-enter" data-beat="2"><BenchView bench={bench} at={reduced ? STILL_MS : ENTER_MS} /></div>
        {/* Where the drawing is too small to carry the request's name, a caption under it does. */}
        {!spec.fine && <p className="nmb-caption nmb-enter" data-beat="3">{REQUEST}</p>}
      </div>
    </main>

    <footer className="nmb-footer">
      <a className="nmb-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a>
      <nav aria-label="Site links"><a href="/openapi.json">OpenAPI</a><a href={`https://www.npmjs.com/package/${sdkPackage}`}>SDK</a><Link to="/legal">Legal</Link></nav>
    </footer>
  </div>
}
