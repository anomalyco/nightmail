import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { SignInConsent } from '../../components/LegalLinks'
import { useTheme } from '../../lib/theme'
import type { HomeProps } from '.'
import { StartButton } from './start'
import { plan, type Plan } from './plan'
import { toneVars } from './tones'
import { Machines } from './machines'
import { MANIFESTS, published, type Format, type Manifest } from './factory/manifest'
import { frameOf, pct } from './frame'
import { alphaFormat, mountPlayer, type Player } from './factory/player'
import { afterFirstPicture, POSTER_SIZES, POSTERS, STILL_BOARDS, STILL_SPRITES } from './first-picture'
import deskBoard0 from './factory/boards/board0.webp'
import deskBoard1 from './factory/boards/board1.webp'
import deskBoard2 from './factory/boards/board2.webp'
import './factory-home.css'
import './page.css'

// The homepage: the factory, in a wide frame on a desktop and a tall one on a phone (index.tsx picks), from the very top
// of the window: there is no header (the machine carries the name). A rendered hall with the sorting machine standing in it, the price on the
// machine's front, and billboards with the free tier on them behind it: sliding slowly along a rail on a desktop
// (factory/player.ts), hung in the middle in turn on a phone.
// The page writes the button, on the blank plate the machine's front has for it, and a tag over each pipe's label on
// the plinth (the render's stencils are too small and too grey to read). The first picture is the poster,
// laid out by CSS alone before anything loads (factory-home.css), so nothing moves when the videos take over from it;
// with reduced motion, when saving data or on 3G or slower, without the renders' host (VITE_FACTORY_MEDIA), or where
// alpha video cannot play, the poster is what is seen. The hall's pipes go down out of the picture, into its floor;
// under it the factory goes on down the page, a storey and a machine for each thing it does (machines.tsx).
// On a hosted installation the first screen is painted before any of this code, from home.html (home-shell.ts); the
// page takes its place once its own picture is up.

/** Where the render sets are published (their current.json and versions), ending in a slash: a build without it shows the poster alone. */
const MEDIA = (import.meta.env.VITE_FACTORY_MEDIA as string | undefined)?.replace(/\/*$/, '/') || null
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const connection = () => (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
const saveData = () => connection()?.saveData === true
/** Saving data, or on a connection no faster than 3G (as far as the browser says: Safari does not). */
const slow = () => saveData() || ['slow-2g', '2g', '3g'].includes(connection()?.effectiveType ?? '')
/** The desktop's billboards, for the rail: bundled, so what they say changes with the page, not the renders' host. */
const RAIL_BOARDS = [deskBoard0, deskBoard1, deskBoard2]


// The pipes' labels: a tag over each stencil some crop shows whole (the manifest's `labelBox`; none where `visible` is
// false), placed in the frame's pixels like the button and sized by factory-home.css: as large as the stencil, and
// never smaller than readable type, so it can be larger. The frame's crop depends on the window's shape, so before
// each paint (and as the stage's size changes) a tag whose stencil the stage cuts is left off, and one that would run
// past the stage's edge is moved in along it, still over its stencil; one that would then cover the tag before it (on
// the narrowest phones there is no room for both) is left off too.
const tagsOf = (m: Manifest) => (m.pipes ?? []).flatMap(pipe => pipe.labelBox && pipe.visible !== false ? [{ label: pipe.label, box: pipe.labelBox }] : [])
const TAGS = { desktop: tagsOf(MANIFESTS.desktop), phone: tagsOf(MANIFESTS.phone) }
const FRAMES = { desktop: frameOf(MANIFESTS.desktop, 'desktop'), phone: frameOf(MANIFESTS.phone, 'phone') }

// A phone's frame has room for one billboard at a time, and too little for one sliding along the rail to be read: at
// 390 px a board is whole in the frame about a quarter of the time, and the first one is cut off at the edge. So on a
// phone the free tier and the response time are said by the three boards hung in turn from the rail in the middle of
// the frame, a new one every four seconds, over the hall (the poster has the first one hung already), whether or not
// the videos play. Nothing moves: one is put in the other's place (a short fade, or a cut where motion is reduced),
// and they dim with the hall. None of them is needed for the first picture, so they load after it.
function StillBoards({ m }: { m: Manifest }) {
  const [shown, setShown] = useState(0)
  useEffect(() => { const timer = setInterval(() => setShown(i => (i + 1) % STILL_BOARDS.length), 4000); return () => clearInterval(timer) }, [])
  return <div className="fac-layer fac-still" aria-hidden="true">{STILL_BOARDS.map((k, i) => {
    const w = m.boards.w?.[k] ?? 0
    return <img key={k} src={STILL_SPRITES[k]} alt="" decoding="async" fetchPriority="low" data-on={i === shown || undefined} style={{ left: pct((m.width - w) / 2, m.width), top: pct(m.boards.y[k], m.height), width: pct(w, m.width) }} />
  })}</div>
}

export function FactoryHome({ start, notice, format }: HomeProps & { format: Format }) {
  const m = MANIFESTS[format], { vars: frameVars, button: buttonBox } = FRAMES[format]
  const still = format === 'phone'
  const visitor = start.signedIn ? null : start
  // The notice slot: what a sign-in has to say. With no place open the button says Join the waitlist itself.
  const shown = notice
  const dark = useTheme().theme === 'dark'
  const scene = useRef<HTMLElement>(null), probe = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null)
  const bg = useRef<HTMLDivElement>(null), boards = useRef<HTMLDivElement>(null), fg = useRef<HTMLDivElement>(null), tags = useRef<HTMLDivElement>(null)
  const poster = useRef<HTMLImageElement>(null), cta = useRef<HTMLElement>(null)
  // The page's foot (machines.tsx, end-band.tsx) is measured for this window (plan.ts).
  const [p, setP] = useState<Plan | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const fold = probe.current!, safe = getComputedStyle(fold), next = plan(scene.current!.clientWidth, fold.offsetHeight, { left: parseFloat(safe.paddingLeft) || 0, right: parseFloat(safe.paddingRight) || 0, bottom: parseFloat(safe.paddingBottom) || 0 }, !start.signedIn)
      setP(now => now && now.W === next.W && now.H === next.H && now.fold === next.fold && now.ox === next.ox ? now : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene.current!); observer.observe(probe.current!)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const layer = tags.current!, area = stage.current!
    const place = () => {
      const s = area.getBoundingClientRect(), f = frame.current!.getBoundingClientRect(), k = f.width / m.width
      let edge = -Infinity
      TAGS[format].forEach(({ box }, i) => {
        const tag = layer.children[i] as HTMLElement
        tag.style.removeProperty('--fac-tag-dx'); tag.style.removeProperty('--fac-tag-dy')
        // (The stencil is the box less the 3 frame px it has to spare all round.)
        const whole = f.left + (box.x + 3) * k >= s.left - .5 && f.left + (box.x + box.w - 3) * k <= s.right + .5 && f.top + (box.y + 3) * k >= s.top - .5 && f.top + (box.y + box.h - 3) * k <= s.bottom + .5
        const t = tag.getBoundingClientRect(), dx = Math.max(0, s.left - t.left) + Math.min(0, s.right - t.right), dy = Math.max(0, s.top - t.top) + Math.min(0, s.bottom - t.bottom)
        const off = !whole || t.left + dx < edge + 2
        tag.toggleAttribute('data-off', off)
        if (off) return
        edge = t.right + dx
        if (dx) tag.style.setProperty('--fac-tag-dx', `${dx}px`)
        if (dy) tag.style.setProperty('--fac-tag-dy', `${dy}px`)
      })
    }
    place()
    // (Each tag is watched too: its width changes when the mono web font takes over from its fallback.)
    const observer = new ResizeObserver(place)
    observer.observe(area); for (const tag of layer.children) observer.observe(tag)
    return () => observer.disconnect()
  }, [])

  // home.html's first screen (home-shell.ts), over this page until now: it goes once this page's picture is up (the
  // same file, so at once), handing on the button's focus, and a press made on it while this code loaded is acted on.
  useEffect(() => {
    const shell = document.getElementById('home-shell')
    if (!shell) return
    shell.inert = true; shell.setAttribute('aria-hidden', 'true')
    let done = false
    const swap = () => {
      if (done) return
      done = true
      const focused = shell.contains(document.activeElement)
      shell.remove()
      if (focused) cta.current?.focus()
    }
    const img = poster.current!, decoded = () => void img.decode().then(swap, swap)
    if (img.complete) decoded()
    else { img.addEventListener('load', decoded, { once: true }); img.addEventListener('error', swap, { once: true }) }
    const pressed = window as Window & { __nightmailHomeStart?: boolean }
    if (pressed.__nightmailHomeStart && !start.signedIn) { delete pressed.__nightmailHomeStart; start.onSignIn() }
    return () => { done = true }
  }, [])

  // Once the first picture is in and the page is idle: the set published on the renders' host, and its videos where
  // they can play, and not when saving data or on 3G or slower (the poster stands). (720p where the frame is shown no
  // wider than that has pixels for.)
  useEffect(() => {
    const codec = alphaFormat()
    if (!MEDIA || !codec || reducedMotion() || slow()) return
    let player: Player | null = null, seen = true, gone = false, idle = 0
    // Off screen, or in a hidden tab, it stands still.
    const update = () => player?.setShown(seen && document.visibilityState === 'visible')
    const observer = new IntersectionObserver(([entry]) => { seen = entry.isIntersecting; update() }, { threshold: .02 })
    const begin = () => void published(MEDIA, format).then(set => {
      if (gone || !set) return
      // (A desktop takes the smaller files, 1280 wide, where the frame is shown no wider than that has pixels for; a
      // phone the 1080 × 1920 ones.)
      const height = format === 'phone' || frame.current!.getBoundingClientRect().width * devicePixelRatio > 1280 ? 1080 : 720
      player = mountPlayer({ stage: stage.current!, bg: bg.current!, boards: boards.current!, fg: fg.current!, tags: tags.current! }, { ...set, format: codec, height, rail: !still, boardSprites: RAIL_BOARDS })
      observer.observe(stage.current!)
      document.addEventListener('visibilitychange', update)
    })
    const wait = afterFirstPicture(() => { idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(begin, { timeout: 2000 }) : window.setTimeout(begin, 500) })
    return () => { gone = true; wait(); if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle); else clearTimeout(idle); observer.disconnect(); document.removeEventListener('visibilitychange', update); player?.destroy() }
  }, [])

  return <div className="srt-page fac-page" data-format={format} data-visitor={visitor ? '' : undefined} style={toneVars(dark) as CSSProperties}>
    <main>
      <section className="fac-hero" ref={scene} aria-label="Pricing">
        <div className="srt-fold" ref={probe} aria-hidden="true" />
        {/* What the machine and its boards say, for whoever cannot see them. */}
        <h1 className="sr-only">$0.20 per 1,000 emails, sent or received via API.</h1>
        <p className="sr-only">Free every month: 5,000 emails sent and 20,000 received. Responds in about 100 ms.</p>
        <div className="fac-stage" ref={stage} style={frameVars}>
          <div className="fac-frame" ref={frame}>
            <picture>
              <source type="image/avif" srcSet={POSTERS[format].avif} sizes={POSTER_SIZES} />
              <img className="fac-poster" ref={poster} src={POSTERS[format].src} srcSet={POSTERS[format].jpeg} sizes={POSTER_SIZES} alt="" width={m.width} height={m.height} fetchPriority="high" decoding="async" />
            </picture>
            <div className="fac-layer" ref={bg} />
            {still ? <div className="fac-layer" ref={boards}><StillBoards m={m} /></div> : <div className="fac-layer fac-boards" ref={boards} />}
            <div className="fac-layer" ref={fg} />
            <div className="fac-layer" ref={tags} aria-hidden="true">{TAGS[format].map(({ label, box }) =>
              <span key={label} className="fac-tag" style={{ left: pct(box.x, m.width), top: pct(box.y + box.h / 2, m.height), '--fac-tag-w': box.w, '--fac-tag-h': box.h } as CSSProperties}><span>{label}</span></span>)}</div>
            <StartButton start={start} className="fac-cta" style={buttonBox} ref={cta} />
          </div>
        </div>
        {/* Under the button, off the frame (on a phone directly under it): what signing in agrees to, and the way to
            the API docs beside it (where the header had it). */}
        {visitor && <div className="fac-under"><SignInConsent className="fac-consent" after={<><span aria-hidden="true"> · </span><a href="/docs">API docs</a></>} /></div>}
        {shown && <div className="srt-notice">{shown}</div>}
      </section>
      <Machines plan={p} start={start} />
    </main>
  </div>
}
