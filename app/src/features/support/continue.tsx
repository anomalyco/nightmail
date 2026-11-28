import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button, Dialog, SkeletonText } from '../../components/ui'
import { useSession } from '../../data/context'
import { supportApi, type SupportPendingEmail } from '../../data/support'
import { ApiError } from '../../data/types'
import { countdown, useSecondsLeft } from '../../lib/countdown'
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
// A sign-in that proves no mailbox (GitHub, say) gets 403 MAILBOX_SIGN_IN_REQUIRED, which names the address the email came
// from (masked) and the way through: one press emails a sign-in link there (POST …/sign-in-link), never anywhere else,
// and only when an account has that address. The answer never says which, so the page says only what happens if there is
// one. The link opens this page again with ?link=…, which signs in at once, the account service showing its chooser; the
// sign-in proves the mailbox when its account's address is the one the link went to (api/src/account-login.ts), and the
// page, back in this tab, confirms the email without another press. Another account signed in here stays signed in.
//
// Whoever opens this page holds the link support emailed to the conversation's address, so they read that mailbox: signed
// out, signed in as anyone, they may instead ask to be answered by email (POST …/answer-by-email), a general answer with no
// account access, sent to that address in the same thread, once. Never on opening the page: mail scanners open links.
//
// Every state keeps the same box: one title line, a text that fits its reserved lines, the email's two lines (reserved
// while it loads, and kept empty where there is none, or saying what the two choices do), one button of one width and the
// second choice's place beside it (or under it, on a phone; kept empty where it isn't offered), so the dialog never moves.

type State = 'loading' | 'ready' | 'claimed' | 'other' | 'limit' | 'signin' | 'mailbox' | 'sent' | 'links' | 'link' | 'answered' | 'went' | 'already' | 'busy' | 'invalid' | 'failed'
const CONVERSATION = /^conv_[a-z2-7]{26}$/, MESSAGE = /^msg_[0-9a-f]{32}$/, LINK = /^[\w-]{24}\.[\w-]{43}$/
/** more: in the email's place, what the two choices do. instead: the second choice, Answer me by email instead, is offered. */
type Copy = { title: string; text: string | ((address: string) => string); more?: string; action: string; instead?: true }
const CHOICES = 'With a sign-in, support can look at your account to answer. By email, you get a general answer that looks at no account.'
const READY: Copy = { title: 'Continue your support email', text: 'Confirm you wrote this email. Support then reads your account to answer it, by email.', action: 'Continue' }
const COPY: Record<State, Copy> = {
  loading: READY,
  ready: READY,
  claimed: { title: 'Your email will be answered', text: 'The reply goes to your account’s email address.', action: 'Done' },
  other: { title: 'This link is for another account', text: 'Sign in with the account for the address you wrote from.', more: CHOICES, action: 'Done', instead: true },
  limit: { title: 'Too many open conversations', text: 'Try again once an earlier support conversation ends.', action: 'Done' },
  signin: { title: 'Choose how to continue', text: 'Sign in with the account for the address you wrote from.', more: CHOICES, action: 'Sign in', instead: true },
  mailbox: { title: 'Choose how to continue', text: address => `This sign-in doesn’t confirm you can read mail at ${address}, the address this conversation was started from.`, more: CHOICES, action: 'Email me a sign-in link', instead: true },
  sent: { title: 'Check your inbox', text: address => `If ${address} has a ${productName} account, we’ve sent it a sign-in link. It works once, for 30 minutes.`, action: 'Done' },
  links: { title: 'Too many sign-in links', text: 'Use a link already in your inbox, or try again later.', action: 'Done' },
  link: { title: 'Sign in to continue', text: 'Choose the account for the address you wrote from. The link works once.', action: 'Sign in' },
  answered: { title: 'You’ll be answered by email', text: address => `We’ll answer by email at ${address}.`, action: 'Done' },
  went: { title: 'Answered by email', text: address => `We’ve answered by email at ${address}.`, action: 'Done' },
  already: { title: 'Already answered', text: address => `We’ve already answered by email at ${address}.`, action: 'Done' },
  busy: { title: 'Too many requests', text: 'Try again in a few minutes.', action: 'Done' },
  invalid: { title: 'This link doesn’t work', text: 'Open the link from the support email again.', action: 'Done' },
  failed: { title: 'Couldn’t continue your email', text: 'Try again in a moment.', action: 'Try again' },
}
/** The address a 403 MAILBOX_SIGN_IN_REQUIRED names, with its way through (error.details[0]); null without one. */
const mailboxAddress = (error: unknown) => { const address = error instanceof ApiError && error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? error.details?.[0]?.address : null; return typeof address === 'string' ? address : null }
const outcome = (error: unknown): State => !(error instanceof ApiError) ? 'failed'
  : error.status === 404 ? 'other' : error.status === 429 ? 'limit' : error.status === 401 ? 'signin' : error.code === 'MAILBOX_SIGN_IN_REQUIRED' ? mailboxAddress(error) ? 'mailbox' : 'other' : error.status === 422 ? 'invalid' : 'failed'
/** "Nov 21, 2026 at 14:33 UTC", as the support email names it. */
const received = (at: string) => `${date(at)} at ${date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
// The email this tab is signing in to confirm, set when its emailed link starts the sign-in, read once back here.
const CLAIM_KEY = 'nightmail.support-continue'

export function SupportContinuePage() {
  const { id = '', message: messageId = '' } = useParams()
  const session = useSession(), navigate = useNavigate()
  const valid = CONVERSATION.test(id) && MESSAGE.test(messageId)
  const [linked] = useState(() => valid && LINK.test(new URLSearchParams(window.location.search).get('link') ?? ''))
  const [state, setState] = useState<State>(!valid ? 'invalid' : linked ? 'link' : 'loading')
  const [email, setEmail] = useState<SupportPendingEmail | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [working, setWorking] = useState(false), [answering, setAnswering] = useState(false)
  // Back from the sign-in this page's emailed link started, in this tab: the email is confirmed once it shows.
  const [returned] = useState(() => { try { return !linked && sessionStorage.getItem(CLAIM_KEY) === `${id}/${messageId}` } catch { return false } })
  const confirmOnce = useRef(returned)
  useEffect(() => {
    document.title = `Continue your support email · ${productName.toLowerCase()}`
    if (!linked) try { sessionStorage.removeItem(CLAIM_KEY) } catch { /* Nothing was kept. */ }
  }, [])
  function failed(error: unknown) { setAddress(mailboxAddress(error)); setState(outcome(error)) }
  async function load(tries = 3): Promise<void> {
    setState('loading')
    try { setEmail(await supportApi('unscoped').pending(id, messageId)); setState('ready') }
    catch (error) {
      // The session chose its account while this was in flight (data/live.ts drops that answer): ask again as that account.
      if (error instanceof DOMException && error.name === 'AbortError' && tries > 1) return load(tries - 1)
      failed(error)
    }
  }
  // The emailed link: sign in with the account for its address, back to this page (the link rides in the return URL).
  function follow() {
    try { sessionStorage.setItem(CLAIM_KEY, `${id}/${messageId}`) } catch { /* Then it waits for Continue. */ }
    session?.signIn(undefined, true)
  }
  useEffect(() => { if (!valid) return; if (linked) follow(); else void load() }, [id, messageId])
  // Back to the dashboard, or the homepage for someone without one.
  const leave = () => navigate(session?.identity ? '/overview' : '/', { replace: true })
  async function act() {
    if (held) return
    if (state === 'signin') { session?.signIn(); return }
    if (state === 'link') { follow(); return }
    if (state === 'failed' && !email) { await load(); return }
    if (state === 'mailbox') {
      setWorking(true)
      try { setAddress((await supportApi('unscoped').signInLink(id, messageId)).address); setState('sent') }
      catch (error) { if (error instanceof ApiError && error.status === 429) setState('links'); else failed(error) }
      finally { setWorking(false) }
      return
    }
    if (state !== 'ready' && state !== 'failed') { leave(); return }
    setWorking(true)
    try { await supportApi('unscoped').claim(id, messageId); setState('claimed') }
    catch (error) { failed(error) }
    finally { setWorking(false) }
  }
  // The second choice: a general answer by email, to the conversation's own address, without a sign-in.
  async function answer() {
    setAnswering(true)
    try { const answered = await supportApi('unscoped').answerByEmail(id, messageId); setAddress(answered.address); setState(answered.outcome === 'already_answered' ? 'already' : answered.outcome === 'answered' ? 'went' : 'answered') }
    catch (error) { setState(error instanceof ApiError && error.status === 429 ? 'busy' : error instanceof ApiError && error.status === 404 ? 'invalid' : 'failed') }
    finally { setAnswering(false) }
  }
  useEffect(() => { if (state === 'ready' && confirmOnce.current) { confirmOnce.current = false; void act() } }, [state])
  // A sign-in start refused at the cap (data/context.tsx holdSignIn): its button waits it out, counting down.
  const wait = useSecondsLeft(session?.signInWaitUntil), held = wait > 0 && (state === 'signin' || state === 'link')
  const copy = COPY[state], shown = email && (state === 'ready' || state === 'claimed' || state === 'failed')
  const text = typeof copy.text === 'string' ? copy.text : copy.text(address ?? 'your address')
  return <main className="support-continue">
    <Dialog open onOpenChange={open => { if (!open && !working && !answering) leave() }} analytics="support/continue" title={copy.title} className="support-continue__dialog"
      description={<span className="support-continue__text">{text}</span>}
      footer={<>
        <Button className="support-continue__instead" data-hidden={copy.instead ? undefined : ''} disabled={working} loading={answering} onClick={() => void answer()}>Answer me by email instead</Button>
        <Button variant="primary" className="support-continue__action" disabled={answering} aria-disabled={held || undefined} aria-label={held ? copy.action : undefined} loading={working || state === 'loading' || (state === 'link' && !!session?.signingIn)} onClick={() => void act()}>{held ? `Try again in ${countdown(wait)}` : copy.action}</Button>
      </>}>
      <div className="support-continue__email" data-empty={!shown && state !== 'loading' ? '' : undefined} data-more={copy.more && !shown && state !== 'loading' ? '' : undefined}>
        {state === 'loading' ? <><SkeletonText width="80%" /><SkeletonText width="92%" /><SkeletonText width="65%" /><SkeletonText width="50%" /></>
          : shown ? <>
            <span className="support-continue__subject">{email.subject?.trim() || '(no subject)'}</span>
            <p className="support-continue__preview">{email.preview?.trim() || '(no message text)'}</p>
            <span className="support-continue__received">{email.receivedAt ? `Received ${received(email.receivedAt)}` : 'Received recently'}</span>
          </>
          : copy.more ? <p className="support-continue__more">{copy.more}</p> : null}
      </div>
    </Dialog>
  </main>
}
