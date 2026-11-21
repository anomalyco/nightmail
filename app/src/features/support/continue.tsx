import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button, Dialog } from '../../components/ui'
import { useSession } from '../../data/context'
import { supportApi } from '../../data/support'
import { ApiError } from '../../data/types'
import { productName } from '../../../../api/src/brand'
import './continue.css'

// /support/continue/<conversation>: the link in the support reply to an email that didn't prove who sent it. The person
// continues it signed in: Nightmail binds the conversation to them when their verified address is the one that wrote
// (POST /v1/support-conversations/{id}/claim), and support answers the waiting email. Anyone else's account gets
// "another account". The page is public (data/context.tsx isPublicPath): someone signed in without a workspace has no
// dashboard but can claim, and someone signed out signs in from here.
//
// Every state keeps the same box, one title line, a text that fits its reserved lines and one button of one width, so
// the dialog never moves while it answers.

type State = 'ready' | 'claimed' | 'other' | 'limit' | 'signin' | 'google' | 'invalid' | 'failed'
const CONVERSATION = /^conv_[a-z2-7]{26}$/
const COPY: Record<State, { title: string; text: string; action: string }> = {
  ready: { title: 'Continue your support email', text: 'Support reads your account to answer it. The reply goes to the address you wrote from.', action: 'Continue' },
  claimed: { title: 'We’ll answer your email shortly', text: 'The reply goes to the address you wrote from.', action: 'Done' },
  other: { title: 'This link is for another account', text: 'Sign in with the account for the address you wrote from.', action: 'Done' },
  limit: { title: 'Too many open conversations', text: 'Try again once an earlier support conversation ends.', action: 'Done' },
  signin: { title: 'Sign in to continue', text: 'Use the account for the address you wrote from.', action: 'Sign in' },
  google: { title: 'Sign in with Google to continue', text: 'Use the Google account for the address you wrote from.', action: 'Sign in' },
  invalid: { title: 'This link doesn’t work', text: 'Open the link from the support email again.', action: 'Done' },
  failed: { title: 'Couldn’t continue your email', text: 'Try again in a moment.', action: 'Try again' },
}
const outcome = (error: unknown): State => !(error instanceof ApiError) ? 'failed'
  : error.status === 404 ? 'other' : error.status === 429 ? 'limit' : error.status === 401 ? 'signin' : error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? 'google' : error.status === 422 ? 'invalid' : 'failed'

export function SupportContinuePage() {
  const { id = '' } = useParams()
  const session = useSession(), navigate = useNavigate()
  const [state, setState] = useState<State>(() => CONVERSATION.test(id) ? 'ready' : 'invalid')
  const [working, setWorking] = useState(false)
  useEffect(() => { document.title = `Continue your support email · ${productName.toLowerCase()}` }, [])
  // Back to the dashboard, or the homepage for someone without one.
  const leave = () => navigate(session?.identity ? '/overview' : '/', { replace: true })
  async function act() {
    if (state === 'signin' || state === 'google') { session?.signIn(state === 'google' ? 'google' : undefined); return }
    if (state !== 'ready' && state !== 'failed') { leave(); return }
    setWorking(true)
    try { await supportApi.claim(id); setState('claimed') }
    catch (error) { setState(outcome(error)) }
    finally { setWorking(false) }
  }
  const copy = COPY[state]
  return <main className="support-continue">
    <Dialog open onOpenChange={open => { if (!open && !working) leave() }} analytics="support/continue" title={copy.title}
      description={<span className="support-continue__text">{copy.text}</span>}
      footer={<Button variant="primary" className="support-continue__action" loading={working} onClick={() => void act()}>{copy.action}</Button>}>
      {null}
    </Dialog>
  </main>
}
