// A pricing page's own module (index.tsx loads it for /pricing/<vendor>): the page (page.tsx) and the stylesheets it
// needs, with the way in a visitor gets on every price page (board-page.tsx's): the homepage's Get started, which signs in
// with the page's focus and opens Overview, says Join the waitlist when no place is open (home/signups-open.ts), and is
// Open dashboard for someone signed in.
import { useSession } from '../../../data/context'
import type { HomeStart } from '../../home'
import { StartButton } from '../../home/start'
import { useSignupsFull } from '../../home/signups-open'
import type { Start } from '../board'
import type { Doc } from './doc'
import { DocScene } from './page'
import '../../home/machines.css'
import '../board.css'
import './docs.css'
export { DocEnd } from './page'

export function DocPageScene({ doc }: { doc: Doc }) {
  const session = useSession()
  const start: HomeStart = session?.identity ? { signedIn: true }
    : { signedIn: false, onSignIn: () => session?.signIn(doc.focus), onSignInIntent: event => session?.signInIntent(event, doc.focus), busy: session?.signingIn ?? false }
  const full = useSignupsFull(!start.signedIn)
  const way: Start = { signedIn: start.signedIn, full, button: className => <StartButton start={start} className={className} /> }
  return <DocScene doc={doc} start={way} />
}
