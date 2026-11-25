import { lazy, Suspense, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { productName } from '../../../../api/src/brand'
import { FactoryHome } from './factory-home'
import { afterFirstPicture, shown, UPRIGHT } from './first-picture'
import { landingVariant } from './landing/variant'

/** What the page's button does: signs a visitor in (Get started), or opens the dashboard for someone signed in. */
export type HomeStart = { signedIn: true } | { signedIn: false; onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean }
export type HomeProps = { start: HomeStart; notice?: ReactNode }

// Which homepage a window gets (first-picture.ts: by its shape), decided before the first paint and again as the window
// changes.
const watch = (changed: () => void) => {
  const query = matchMedia(UPRIGHT)
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}

// The new homepage's options (landing/variant.ts): only where a review build asks for one; any other build has none.
const Landing = import.meta.env.DEV || import.meta.env.VITE_DESIGN_SHEET === '1' ? lazy(() => import('./landing')) : null

// The homepage, signed in or out.
export function HomePage(props: HomeProps) {
  const signedIn = props.start.signedIn
  const home = useSyncExternalStore(watch, shown)
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email infrastructure` }, [])
  // A visitor's first screen after signing in: fetch its code while they read, so it is already cached on return.
  // (Signed in, Overview's code and data load only when the button is about to be pressed.) Not before the hero's
  // picture is in: on a slow connection it would take the picture's bandwidth.
  useEffect(() => {
    if (signedIn) return
    const load = () => void import('../onboarding').catch(() => {})
    let cancel = () => {}
    const wait = afterFirstPicture(() => {
      if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 3000 }); cancel = () => cancelIdleCallback(idle) }
      else { const timer = setTimeout(load, 1500); cancel = () => clearTimeout(timer) }
    })
    return () => { wait(); cancel() }
  }, [signedIn])
  const variant = Landing && landingVariant()
  if (Landing && variant) return <Suspense fallback={null}><Landing variant={variant} {...props} /></Suspense>
  return <FactoryHome key={home} format={home} {...props} />
}
