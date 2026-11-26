import { useEffect } from 'react'
import { productName } from '../../../../../api/src/brand'
import type { HomeProps } from '..'
import { TvHome } from './tv'

// The homepage, signed in or out, with VITE_HOME=tv: one screen, a television playing what email costs (tv.tsx). The
// app's import of features/home resolves here then (home-tv.ts); without it, it is the factory's (../index.tsx).
export function HomePage(props: HomeProps) {
  const signedIn = props.start.signedIn
  useEffect(() => { document.title = `${productName.toLowerCase()} · Email for $0.20 per 1,000` }, [])
  // A visitor's first screen after signing in: fetch its code while they read, so it is already cached on return.
  // (Signed in, Overview's code and data load only when the button is about to be pressed.) When the browser is idle,
  // so it does not take the picture's bandwidth.
  useEffect(() => {
    if (signedIn) return
    const load = () => void import('../../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 4000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 2500)
    return () => clearTimeout(timer)
  }, [signedIn])
  return <TvHome {...props} />
}
