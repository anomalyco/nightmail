import { useMemo } from 'react'
import { useSession } from '../../../data/context'
import type { HomeStart } from '../../home'
import { StartButton } from '../../home/start'
import type { Start } from '../board'
import type { Comparison } from '../prices'
import { comparisonDoc } from './comparison'
import { hubDoc } from './hub'
import { PricePageView } from './page'
import type { PageDoc } from './shape'
import { Television } from './set'
import '../../home/tv/tv.css'
import './page.css'

// The public price pages drawn by page.tsx, as the app shows them (pricing.tsx: taking over from the page's painted HTML,
// app/price-pages.ts, or reached from another of the app's pages), with their styles: page.css, and the television's
// (home/tv/tv.css) for the airmail label and the set. The way in is every price page's (board-page.tsx's, the pricing
// pages' doc-page.tsx's): the homepage's Get started, which signs in with the page's focus and opens Overview, says Join
// the waitlist when no place is open, and is Open dashboard for someone signed in.

function useStart(focus: PageDoc['focus']): Start {
  const session = useSession()
  const start: HomeStart = session?.identity ? { signedIn: true }
    : { signedIn: false, onSignIn: () => session?.signIn(focus), onSignInIntent: event => session?.signInIntent(event, focus), busy: session?.signingIn ?? false, waitUntil: session?.signInWaitUntil ?? null }
  return { signedIn: start.signedIn, button: className => <StartButton start={start} className={className} /> }
}

export function ComparisonView({ comparison }: { comparison: Comparison }) {
  const doc = useMemo(() => comparisonDoc(comparison), [comparison]), start = useStart(doc.focus)
  return <PricePageView doc={doc} start={start} />
}
/** A vendor's pricing page (/pricing/<vendor>: docs/), drawn from its data as the comparisons are. */
export function DocView({ doc }: { doc: PageDoc }) {
  return <PricePageView doc={doc} start={useStart(doc.focus)} />
}
/** /compare: with the television over it (set), or without. */
export function HubView({ set }: { set?: boolean }) {
  const doc = useMemo(hubDoc, []), start = useStart(doc.focus)
  return <PricePageView doc={doc} start={start} set={set ? <Television doc={doc} /> : undefined} />
}
