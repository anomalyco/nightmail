import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import { SignInConsent } from '../../components/LegalLinks'
import { BaneWordmark } from '../../components/BaneLogo'
import { HomeFooter, reducedMotion, type HomeProps } from '.'
import './variant-train.css'
import { productName } from '../../../../api/src/brand'

// Direction 4: Night Mail (GPO Film Unit, 1936). The Travelling Post Office sorted letters overnight on its way north
// and never stopped for them: a net on the carriage side snatched pouches off lineside standards at speed, and lineside
// nets caught the pouches it threw off. Here the down train collects a send at your app and drops it at the inbox, and
// the up train brings the reply back into the thread. The stations are the timetable's columns, and each time is written
// in as the mail passes. Reduced motion shows the finished timetable with both pouches delivered.

type Station = 'app' | 'nightmail' | 'ses' | 'inbox'
const stations: { id: Station; name: string; short?: string }[] = [
  { id: 'app', name: 'Your app' },
  { id: 'nightmail', name: productName.toLowerCase() },
  { id: 'ses', name: 'Amazon SES', short: 'SES' },
  { id: 'inbox', name: 'Inbox' },
]
// Medians and 95th percentiles measured on dev, 15 Nov 2026 (plans/homepage-nightmail/numbers.md §3, rounded as its
// "Homepage-ready" list allows): 202 accepted p50 99 ms; SES accepted p95 0.48 s; delivered to the SES mailbox simulator
// p95 0.72 s; a reply in the recipient's thread p50 2.6 s.
type Call = { kind: 'dep' | 'arr' | 'pass'; time?: string; note?: string }
type Run = { id: string; name: string; direction: 'down' | 'up'; from: Station; to: Station; calls: Partial<Record<Station, Call>> }
const runs: Run[] = [
  { id: 'send', name: 'Send', direction: 'down', from: 'app', to: 'inbox', calls: { app: { kind: 'dep', time: '0 s' }, nightmail: { kind: 'arr', time: '~0.1 s' }, ses: { kind: 'arr', time: '<0.5 s' }, inbox: { kind: 'arr', time: '<1 s', note: '*' } } },
  { id: 'reply', name: 'Reply', direction: 'up', from: 'inbox', to: 'nightmail', calls: { inbox: { kind: 'dep', time: '0 s' }, ses: { kind: 'pass' }, nightmail: { kind: 'arr', time: '~3 s' } } },
]
const column = (station: Station) => stations.findIndex(({ id }) => id === station)

function Pouch() {
  return <svg className="nm-pouch" viewBox="0 0 12 18" aria-hidden="true"><path d="M2 2.5Q2 1 3.5 1h5Q10 1 10 2.5V7l1 2-1 2v4.5q0 1.5-1.5 1.5h-5Q2 17 2 15.5V11L1 9l1-2Z" /><path className="nm-strap" d="M1.4 8.3h9.2v1.4H1.4Z" /></svg>
}

function Locomotive() {
  return <span className="nm-car nm-car--loco">
    <svg viewBox="0 0 156 46" aria-hidden="true">
      <rect className="nm-body" x="0" y="2" width="38" height="4" rx="2" />
      <rect className="nm-body" x="2" y="4" width="34" height="30" rx="2" />
      <rect className="nm-lamp" x="11" y="10" width="13" height="9" rx="1" />
      <rect className="nm-body" x="36" y="12" width="106" height="20" rx="4" />
      <rect className="nm-body" x="88" y="8" width="13" height="6" rx="3" />
      <rect className="nm-body" x="125" y="4" width="9" height="10" rx="1" />
      <rect className="nm-body" x="0" y="32" width="150" height="3" />
      <rect className="nm-body" x="106" y="29" width="16" height="9" rx="1.5" />
      <rect className="nm-body" x="145" y="29" width="9" height="7" />
      {[50, 73, 96].map(cx => <circle key={cx} className="nm-wheel" cx={cx} cy="37.5" r="8.5" />)}
      {[124, 139].map(cx => <circle key={cx} className="nm-wheel" cx={cx} cy="41.5" r="4.5" />)}
    </svg>
    <i className="nm-rod" />
  </span>
}

function Tender() {
  return <span className="nm-car nm-car--tender">
    <svg viewBox="0 0 58 46" aria-hidden="true">
      <rect className="nm-body" x="6" y="8" width="42" height="5" rx="2.5" />
      <rect className="nm-body" x="2" y="11" width="54" height="23" rx="2" />
      <rect className="nm-body" x="0" y="32" width="58" height="3" />
      {[14, 29, 44].map(cx => <circle key={cx} className="nm-wheel" cx={cx} cy="40.5" r="5" />)}
    </svg>
  </span>
}

// A sorting carriage, lit for the night's work. The catcher carries the net, open to the front, that takes the pouch.
function Van({ catcher }: { catcher?: boolean }) {
  const windows = catcher ? [14, 29, 44, 59, 74, 89] : [14, 29, 44, 59, 74, 89, 104, 119]
  return <span className={`nm-car nm-car--van${catcher ? ' nm-car--catcher' : ''}`}>
    <svg viewBox="0 0 150 46" aria-hidden="true">
      <rect className="nm-body" x="4" y="3" width="142" height="5" rx="2.5" />
      <rect className="nm-body" x="1" y="6" width="148" height="27" rx="3" />
      <rect className="nm-body" x="8" y="32" width="134" height="3" />
      {windows.map(x => <rect key={x} className="nm-lamp" x={x} y="12" width="9" height="7" rx="1" />)}
      {catcher && <path className="nm-net" d="M146 6.5 112 13.5V28.5L146 35.5M121 11.6V30.4M130 9.8V32.2M138 8.1V33.9M112 21H146" />}
      {[16, 30, 120, 134].map(cx => <circle key={cx} className="nm-wheel" cx={cx} cy="41.5" r="4.5" />)}
    </svg>
    {catcher && <span className="nm-carried"><span className="nm-carried-swing"><Pouch /></span></span>}
  </span>
}

function Line({ run }: { run: Run }) {
  const place = (station: Station) => ({ '--nm-at': column(station) } as CSSProperties)
  return <div className={`nm-line nm-line--${run.direction}`} data-line={run.id}>
    <i className="nm-rail" />
    <div className="nm-train">
      <div className="nm-train-face"><Van /><Van catcher /><Tender /><Locomotive /></div>
    </div>
    {/* The lineside standard: the pouch hangs from its arm at the height of the passing net. */}
    <span className="nm-standard" style={place(run.from)}>
      <span className="nm-post"><i className="nm-pole" /><i className="nm-arm" /></span>
      <span className="nm-hanging"><i className="nm-cord" /><Pouch /></span>
    </span>
    {/* The lineside net the train throws the pouch into, open towards it. */}
    <span className="nm-catch" style={place(run.to)}>
      <svg viewBox="0 0 44 34" aria-hidden="true"><path d="M2 33.5H42M6 33.5V17M38 33.5V5M6 17 38 5M6 17Q20 32 38 21M14 14.2V27.5M22 11.2V29M30 8.2V27.5" /></svg>
      <span className="nm-landed"><Pouch /></span>
    </span>
  </div>
}

const pause = 380 // ms of stillness after the first paint, so the eye finds the pouch before the train arrives

// Both trains run on the Web Animations API (transform and opacity only), timed from where things are on this screen:
// each pouch changes hands exactly as the net reaches it, and each time is written in as the mail passes its column.
function useNightRun() {
  const scene = useRef<HTMLElement>(null)
  const [done, setDone] = useState(reducedMotion)
  useLayoutEffect(() => {
    const root = scene.current
    if (done || !root) return
    const animations: Animation[] = []
    let finish = 0, cancelled = false, timer = 0
    const add = (element: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      if (!element) return
      animations.push(element.animate(keyframes, { fill: 'both', ...options }))
      finish = Math.max(finish, Number(options.delay ?? 0) + Number(options.duration ?? 0) * Number(options.iterations ?? 1))
    }
    const box = root.querySelector('.nm-scene')!.getBoundingClientRect()
    const x = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.left + rect.width / 2 - box.left }
    const narrow = box.width < 640
    for (const [index, run] of runs.entries()) {
      const line = root.querySelector(`[data-line="${run.id}"]`)!
      const train = line.querySelector('.nm-train')!, trainBox = train.getBoundingClientRect()
      const length = trainBox.width
      const carried = x(line.querySelector('.nm-carried')!) - (trainBox.left - box.left)
      const hanging = x(line.querySelector('.nm-hanging')!), landed = x(line.querySelector('.nm-landed')!)
      const down = run.direction === 'down'
      // The train's left edge runs from just off one side of the page to just off the other at a constant speed:
      // the mail train never stops.
      const from = down ? -length : box.width, to = down ? box.width : -length
      const speed = (narrow ? 230 : 640) / 1000 // px per ms
      const start = pause + index * (narrow ? 900 : 760)
      const at = (position: number) => start + Math.abs(position - carried - from) / speed
      const snatch = at(hanging), drop = at(landed)
      add(train, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration: Math.abs(to - from) / speed, delay: start, easing: 'linear' })
      add(line.querySelector('.nm-rod'), [{ transform: 'translate(3px,0)' }, { transform: 'translate(0,3px)' }, { transform: 'translate(-3px,0)' }, { transform: 'translate(0,-3px)' }, { transform: 'translate(3px,0)' }], { duration: 240, iterations: Math.ceil(Math.abs(to - from) / speed / 240), delay: start, easing: 'linear', fill: 'none' })
      // The pouch leaves the arm for the net and swings back into it; the emptied arm drops and the post shudders.
      // (Up-line apparatus is mirrored in CSS, so these keyframes read the same on both lines.)
      add(line.querySelector('.nm-hanging'), [{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: snatch })
      add(line.querySelector('.nm-carried'), [{ opacity: 0 }, { opacity: 1, offset: 0.001 }, { opacity: 1, offset: 0.999 }, { opacity: 0 }], { duration: drop - snatch, delay: snatch })
      add(line.querySelector('.nm-carried-swing'), [
        { transform: 'translateX(0) rotate(0deg)' },
        { transform: 'translateX(-8px) rotate(-40deg)', offset: 0.3 },
        { transform: 'translateX(-7px) rotate(12deg)', offset: 0.65 },
        { transform: 'translateX(-7px) rotate(0deg)' },
      ], { duration: 560, delay: snatch, easing: 'cubic-bezier(.2,.8,.2,1)' })
      add(line.querySelector('.nm-arm'), [
        { transform: 'rotate(0deg)' }, { transform: 'rotate(-34deg)', offset: 0.16 }, { transform: 'rotate(12deg)', offset: 0.42 }, { transform: 'rotate(-5deg)', offset: 0.68 }, { transform: 'rotate(1.5deg)', offset: 0.86 }, { transform: 'rotate(0deg)' },
      ], { duration: 820, delay: snatch, easing: 'ease-out' })
      add(line.querySelector('.nm-post'), [
        { transform: 'rotate(0deg)' }, { transform: 'rotate(5deg)', offset: 0.18 }, { transform: 'rotate(-2.5deg)', offset: 0.48 }, { transform: 'rotate(1deg)', offset: 0.76 }, { transform: 'rotate(0deg)' },
      ], { duration: 720, delay: snatch, easing: 'ease-out' })
      // The drop: thrown off at the train's speed, the pouch skids into the lineside net, which gives under it.
      add(line.querySelector('.nm-landed'), [
        { opacity: 0, transform: 'translate(-24px,-10px) rotate(-20deg)' },
        { opacity: 1, transform: 'translate(-24px,-10px) rotate(-20deg)', offset: 0.001 },
        { opacity: 1, transform: 'translate(3px,1px) rotate(86deg)', offset: 0.6 },
        { opacity: 1, transform: 'translate(0,0) rotate(78deg)' },
      ], { duration: 480, delay: drop, easing: 'cubic-bezier(.15,.8,.25,1)' })
      add(line.querySelector('.nm-catch svg'), [
        { transform: 'scale(1,1)' }, { transform: 'scale(1.1,.88)', offset: 0.3 }, { transform: 'scale(.97,1.03)', offset: 0.65 }, { transform: 'scale(1,1)' },
      ], { duration: 540, delay: drop, easing: 'ease-out' })
      // Each time is written in as the mail passes its column.
      for (const station of stations) {
        if (!run.calls[station.id]) continue
        const cell = root.querySelector(`[data-call="${run.id}-${station.id}"]`)
        const when = station.id === run.from ? snatch : station.id === run.to ? drop : at(x(root.querySelector(`[data-column="${station.id}"]`)!))
        add(cell?.querySelector('.nm-time'), [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, delay: when, easing: 'cubic-bezier(.2,.8,.2,1)' })
        add(cell?.querySelector('.nm-leader'), [{ opacity: 1 }, { opacity: 0 }], { duration: 120, delay: when })
      }
    }
    timer = window.setTimeout(() => { if (!cancelled) setDone(true) }, finish + 50)
    return () => { cancelled = true; window.clearTimeout(timer); for (const animation of animations) animation.cancel() }
  }, [done])
  return { scene, done }
}

function Time({ call }: { call: Call | undefined }) {
  if (!call) return null
  return <>
    <span className="nm-leader" aria-hidden="true" />
    <span className="nm-time"><span className="nm-kind">{call.kind}</span>{call.time && <span className="nm-figure">{call.time.split(' ')[0]}<span className="nm-unit">{call.time.split(' ')[1]}</span>{call.note && <sup>{call.note}</sup>}</span>}</span>
  </>
}

export function TrainHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const { scene, done } = useNightRun()
  return <div className="nm-page">
    <header className="nm-header">
      <a className="wordmark" href="/" aria-label={`${productName.toLowerCase()} home`}><BaneWordmark /></a>
      <nav className="nm-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
        <button type="button" className="nm-link" disabled={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in</button>
      </nav>
    </header>

    <main className="nm-main">
      <div className="nm-intro">
        <h1>This is the night mail, <span>bringing the receipt and the password reset.</span></h1>
        <p>Send, receive, reply to and thread email with one API, on Amazon SES.</p>
        <div className="nm-actions">
          <Button variant="primary" className="nm-cta" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Start free</Button>
          <a className="nm-docs" href="/docs">Read the docs</a>
        </div>
        <SignInConsent className="nm-consent" />
        {notice}
      </div>

      <section className="nm-fare" aria-label="Price">
        <p className="nm-fare-figure">$0.20</p>
        <p className="nm-fare-unit">per 1,000 emails, sent or received.</p>
        <dl className="nm-fares">
          <div><dt>3,000 sent + 3,000 received a month</dt><dd>free</dd></div>
          <div><dt>A million a month</dt><dd>$199.40</dd></div>
          <div className="nm-fares-other"><dt>The same on Resend</dt><dd>$650</dd></div>
          <div><dt>On your own AWS account</dt><dd>$0</dd></div>
        </dl>
      </section>

      <figure className="nm-route" ref={scene} data-state={done ? 'done' : 'run'}>
        <div className="nm-scene" aria-hidden="true">
          <div className="nm-rules">{stations.map(({ id }, index) => <i key={id} data-column={id} style={{ '--nm-at': index } as CSSProperties} />)}</div>
          {runs.map(run => <Line key={run.id} run={run} />)}
        </div>
        <table className="nm-timetable">
          <caption className="sr-only">Journey times</caption>
          <thead><tr><td />{stations.map(({ id, name, short }) => <th key={id} scope="col">{short ? <><span className="nm-long">{name}</span><span className="nm-short">{short}</span></> : name}</th>)}</tr></thead>
          <tbody>
            {runs.map(run => <tr key={run.id}>
              <th scope="row">{run.name}</th>
              {stations.map(station => <td key={station.id} data-call={`${run.id}-${station.id}`}><Time call={run.calls[station.id]} /></td>)}
            </tr>)}
          </tbody>
        </table>
        <figcaption><sup>*</sup>To the Amazon SES mailbox simulator. Typical times, measured 15 Nov 2026.</figcaption>
      </figure>
    </main>

    <HomeFooter />
  </div>
}
