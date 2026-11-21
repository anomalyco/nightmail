import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button, Dialog, SkeletonText } from '../../components/ui'
import { useSession } from '../../data/context'
import { supportApi, type SupportPendingEmail } from '../../data/support'
import { ApiError } from '../../data/types'
import { date } from '../../lib/format'
import { productName } from '../../../../api/src/brand'
import './continue.css'

// /support/continue/<conversation>/<message>: the link in the support reply to one email that didn't prove who sent it.
// The page first shows which email it is (its subject and when it arrived, never its content: GET
// /v1/support-conversations/{id}/claim), with the same checks as confirming it. The person then confirms that email,
// signed in (POST …/claim): Nightmail answers it when their verified address, a mailbox they proved, is the one that
// wrote, and support answers that one email, once. Anyone else's account gets "another account". The page is public
// (data/context.tsx isPublicPath): someone signed in without a workspace has no dashboard but can confirm, and someone
// signed out signs in from here.
//
// Every state keeps the same box: one title line, a text that fits its reserved lines, the email's two lines (reserved
// while it loads, and kept empty where there is none) and one button of one width, so the dialog never moves.

type State = 'loading' | 'ready' | 'claimed' | 'other' | 'limit' | 'signin' | 'google' | 'invalid' | 'failed'
const CONVERSATION = /^conv_[a-z2-7]{26}$/, MESSAGE = /^msg_[0-9a-f]{32}$/
const READY = { title: 'Continue your support email', text: 'Confirm you wrote this email. Support then reads your account to answer it, by email.', action: 'Continue' }
const COPY: Record<State, { title: string; text: string; action: string }> = {
  loading: READY,
  ready: READY,
  claimed: { title: 'Your email will be answered', text: 'The reply goes to your account’s email address.', action: 'Done' },
  other: { title: 'This link is for another account', text: 'Sign in with the account for the address you wrote from.', action: 'Done' },
  limit: { title: 'Too many open conversations', text: 'Try again once an earlier support conversation ends.', action: 'Done' },
  signin: { title: 'Sign in to continue', text: 'Use the account for the address you wrote from.', action: 'Sign in' },
  google: { title: 'Sign in with Google to continue', text: 'Use the Google account for the address you wrote from.', action: 'Sign in' },
  invalid: { title: 'This link doesn’t work', text: 'Open the link from the support email again.', action: 'Done' },
  failed: { title: 'Couldn’t continue your email', text: 'Try again in a moment.', action: 'Try again' },
}
const outcome = (error: unknown): State => !(error instanceof ApiError) ? 'failed'
  : error.status === 404 ? 'other' : error.status === 429 ? 'limit' : error.status === 401 ? 'signin' : error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? 'google' : error.status === 422 ? 'invalid' : 'failed'
/** "Nov 21, 2026 at 14:33 UTC", as the support email names it. */
const received = (at: string) => `${date(at)} at ${date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`

export function SupportContinuePage() {
  const { id = '', message: messageId = '' } = useParams()
  const session = useSession(), navigate = useNavigate()
  const valid = CONVERSATION.test(id) && MESSAGE.test(messageId)
  const [state, setState] = useState<State>(valid ? 'loading' : 'invalid')
  const [email, setEmail] = useState<SupportPendingEmail | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => { document.title = `Continue your support email · ${productName.toLowerCase()}` }, [])
  async function load(tries = 3): Promise<void> {
    setState('loading')
    try { setEmail(await supportApi.pending(id, messageId)); setState('ready') }
    catch (error) {
      // The session chose its account while this was in flight (data/live.ts drops that answer): ask again as that account.
      if (error instanceof DOMException && error.name === 'AbortError' && tries > 1) return load(tries - 1)
      setState(outcome(error))
    }
  }
  useEffect(() => { if (valid) void load() }, [id, messageId])
  // Back to the dashboard, or the homepage for someone without one.
  const leave = () => navigate(session?.identity ? '/overview' : '/', { replace: true })
  async function act() {
    if (state === 'signin' || state === 'google') { session?.signIn(state === 'google' ? 'google' : undefined); return }
    if (state === 'failed' && !email) { await load(); return }
    if (state !== 'ready' && state !== 'failed') { leave(); return }
    setWorking(true)
    try { await supportApi.claim(id, messageId); setState('claimed') }
    catch (error) { setState(outcome(error)) }
    finally { setWorking(false) }
  }
  const copy = COPY[state], shown = email && (state === 'ready' || state === 'claimed' || state === 'failed')
  return <main className="support-continue">
    <Dialog open onOpenChange={open => { if (!open && !working) leave() }} analytics="support/continue" title={copy.title}
      description={<span className="support-continue__text">{copy.text}</span>}
      footer={<Button variant="primary" className="support-continue__action" loading={working || state === 'loading'} onClick={() => void act()}>{copy.action}</Button>}>
      <div className="support-continue__email" data-empty={!shown && state !== 'loading' ? '' : undefined}>
        {state === 'loading' ? <><SkeletonText width="80%" /><SkeletonText width="50%" /></>
          : shown ? <><span className="support-continue__subject">{email.subject?.trim() || '(no subject)'}</span><span className="support-continue__received">{email.receivedAt ? `Received ${received(email.receivedAt)}` : 'Received recently'}</span></>
          : null}
      </div>
    </Dialog>
  </main>
}
