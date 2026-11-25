import desktopPoster from './factory/poster.jpg'
import desktopPoster1280 from './factory/poster-1280.jpg'
import desktop960 from './factory/poster-960.avif'
import desktop1280 from './factory/poster-1280.avif'
import desktop1920 from './factory/poster-1920.avif'
import phonePoster from './factory/phone/poster.jpg'
import phonePoster828 from './factory/phone/poster-828.jpg'
import phone640 from './factory/phone/poster-640.avif'
import phone828 from './factory/phone/poster-828.avif'
import phone1080 from './factory/phone/poster-1080.avif'
import phoneBoard0 from './factory/phone/board0.webp'
import phoneBoard1 from './factory/phone/board1.webp'
import phoneBoard2 from './factory/phone/board2.webp'
import type { Format } from './factory/manifest'
import { UPRIGHT } from './frame'
import { landingVariant } from './landing/variant'

// The homepage's first picture, apart from the page's code so the app can start loading it before that code arrives
// (App.tsx, beside the session check): which frame a window gets, and its poster. home.html paints the same pictures
// before any of the app's code (home-shell.ts), so the page's own takes them from the cache.

// Which homepage a window gets (frame.ts: by its shape). `?home=` shows one anywhere: `phone` or `desktop`.
export { UPRIGHT }
const forced = () => { const home = new URLSearchParams(location.search).get('home'); return home === 'phone' || home === 'desktop' ? home : null }
export const shown = (): Format => forced() ?? (matchMedia(UPRIGHT).matches ? 'phone' : 'desktop')

// Each poster in AVIF at three sizes, and in JPEG at two for a browser without AVIF, the smallest each window has pixels
// for: the frame is about the window's width (`sizes`), a little wider where it covers a squarer one. A phone's has
// its first board hung (scripts/home-assets.mjs makes them all).
export const POSTERS: Record<Format, { src: string; jpeg: string; avif: string }> = {
  desktop: { src: desktopPoster, jpeg: `${desktopPoster1280} 1280w, ${desktopPoster} 1920w`, avif: `${desktop960} 960w, ${desktop1280} 1280w, ${desktop1920} 1920w` },
  phone: { src: phonePoster, jpeg: `${phonePoster828} 828w, ${phonePoster} 1080w`, avif: `${phone640} 640w, ${phone828} 828w, ${phone1080} 1080w` },
}
export const POSTER_SIZES = '100vw'
/** A phone's boards, hung in turn (factory-home.tsx): the first is in the poster too. */
export const STILL_SPRITES = [phoneBoard0, phoneBoard1, phoneBoard2], STILL_BOARDS = [1, 2, 0]

/** Starts loading the first picture this window is shown, ahead of the page that shows it (in AVIF: a browser without
 *  it finds its JPEG when the page renders). */
export function preloadFirstPicture() {
  const format = shown()
  if (document.getElementById('home-shell') || landingVariant()) return
  const link = document.createElement('link')
  link.rel = 'preload'; link.as = 'image'; link.type = 'image/avif'; link.href = POSTERS[format].src; link.fetchPriority = 'high'
  link.setAttribute('imagesrcset', POSTERS[format].avif); link.setAttribute('imagesizes', POSTER_SIZES)
  document.head.append(link)
}

/** Runs `then` once the hero's poster has loaded (or failed), so what is fetched for later does not slow it down; the
 *  returned function calls it off. */
export function afterFirstPicture(then: () => void) {
  const poster = document.querySelector<HTMLImageElement>('#root .fac-poster')
  if (!poster || poster.complete) { then(); return () => {} }
  const stop = new AbortController()
  for (const event of ['load', 'error']) poster.addEventListener(event, () => { stop.abort(); then() }, { signal: stop.signal })
  return () => stop.abort()
}
