// The price pages' own module (index.tsx loads it for /pricing and /compare/*): the scene and the stylesheets it needs
// (its own, and the homepage's machines' and end band's), so no other page loads them. Here, not in
// board.tsx, the page gets its way in: the homepage's own button (home/start.tsx), Get started for a visitor, which
// signs in as the homepage's does and opens Overview (with the comparison's focus: ?focus=agents and so on), or Open
// dashboard for someone signed in. (board.tsx stays free of
// the session and the dashboard's prefetching, so the pre-merge check can render it.)
import { useSession } from '../../data/context'
import type { HomeStart } from '../home'
import { StartButton } from '../home/start'
import type { Start } from './board'
import { Scene } from './scene'
import type { Comparison } from './prices'
import '../home/machines.css'
import './board.css'
export { BoardEnd } from './scene'

export function PriceScene({ comparison, frame }: { comparison?: Comparison | null; frame?: string | null }) {
  const session = useSession()
  const start: HomeStart = session?.identity ? { signedIn: true }
    : { signedIn: false, onSignIn: () => session?.signIn(comparison?.focus), onSignInIntent: event => session?.signInIntent(event, comparison?.focus), busy: session?.signingIn ?? false, waitUntil: session?.signInWaitUntil ?? null }
  const way: Start = { signedIn: start.signedIn, button: className => <StartButton start={start} className={className} /> }
  return <Scene comparison={comparison} start={way} frame={frame} />
}
