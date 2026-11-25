import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import type { HomeProps } from '..'
import { StartButton } from '../start'
import { useSignupsFull } from '../signups-open'
import { shown } from '../first-picture'
import { LandingPage } from './page'
import type { LandingVariant } from './variant'
import './landing.css'

// The new homepage in the app (page.tsx draws it). Where the build painted it into the page's own file
// (landing-pages.ts, #landing-shell), it takes that copy's place as it is first drawn, in the same frame and at the same
// place, so nothing moves; a Get started pressed while this code loaded (home/shell/boot.js holds it) is pressed here.
// "See the machine" opens the factory (factory-home.tsx) in its place, its own entry in the history, so Back returns.
const Factory = lazy(() => import('../factory-home').then(m => ({ default: m.FactoryHome })))

export default function Landing({ variant, start, notice }: HomeProps & { variant: LandingVariant }) {
  const visitor = !start.signedIn
  const full = useSignupsFull(visitor)
  const [machine, setMachine] = useState(() => new URLSearchParams(location.search).has('machine'))
  useEffect(() => {
    const back = () => setMachine(new URLSearchParams(location.search).has('machine'))
    addEventListener('popstate', back)
    return () => removeEventListener('popstate', back)
  }, [])
  useLayoutEffect(() => {
    const shell = document.getElementById('landing-shell')
    if (!shell) return
    // (The same button by its place among the page's buttons: the painted copy and this page have the same ones.)
    const held = window as Window & { __nightmailShellPress?: Element }, nth = held.__nightmailShellPress ? [...shell.querySelectorAll('button')].indexOf(held.__nightmailShellPress as HTMLButtonElement) : -1
    delete held.__nightmailShellPress
    shell.remove()
    document.querySelector('style[data-shell-css]')?.remove()
    if (nth >= 0) document.querySelectorAll<HTMLElement>('#root .landing button')[nth]?.click()
  }, [])
  const openMachine = () => {
    const url = new URL(location.href); url.searchParams.set('machine', '')
    history.pushState(history.state, '', url); setMachine(true); scrollTo(0, 0)
  }
  if (machine) return <Suspense fallback={null}><Factory format={shown()} start={start} notice={notice} /></Suspense>
  return <LandingPage variant={variant} visitor={visitor} full={full} notice={notice} onMachine={openMachine} cta={className => <StartButton start={start} className={className} />} />
}
