import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import { Button, ErrorText, Input, Textarea } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { currentScope, isAbortError, isCurrentScope, request } from '../../data/live'
import { ApiError, type InboxMessage, type InboxMessagePage } from '../../data/types'
import { analytics } from '../../lib/analytics'
import { modKey } from '../../lib/media'
import { SETUP_EMAIL, SETUP_LIMITS, SETUP_SENDER } from '../../../../api/src/setup-email'
import { Kbd, useStepKeys } from './keys'

// Onboarding's first step: an email to yourself from "Nightmail Setup", sent through the API (POST
// /v1/domains/{id}/test-send with its words) from setup@ on the built-in domain, then the reply, which the built-in
// domain's catch-all delivers to its Inbox and a long poll on that inbox brings here. Each side says what it measured: the
// send's round trip in this browser, and for the reply, when it was received, how long Nightmail took to store it
// (processingMs) and how long after that it reached this page (servedAt − storedAt, both the server's clock).
const rise = (index: number) => ({ '--i': index }) as CSSProperties
const WAIT_S = 25
/** A reply that reaches the page later than this after it was stored waited on a page that wasn't listening: no figure. */
const PUSH_SHOWN_MS = 5000

export type FirstEmailPhase = 'compose' | 'sending' | 'waiting' | 'replied'
export type FirstEmail = {
  subject: string; text: string; phase: FirstEmailPhase; error: unknown
  /** The send's round trip, measured here. */ sentMs: number | null
  /** Its subject as sent: the reply is the message after `after` whose subject contains it. */ sent: { subject: string; after: Promise<string | null> } | null
  reply: { message: InboxMessage; servedAt: string | null } | null
}
export const firstEmail = (): FirstEmail => ({ subject: SETUP_EMAIL.subject, text: SETUP_EMAIL.text, phase: 'compose', error: null, sentMs: null, sent: null, reply: null })

/** The built-in domain's Inbox (builtin-domain.ts), where its catch-all delivers mail to any other address at it. */
async function builtinInbox(domain: string, signal?: AbortSignal) {
  const address = `hello@${domain}`
  const page = await request<{ data: { id: string; address: string }[] }>(`/v1/inboxes?q=${encodeURIComponent(address)}&limit=5`, { signal })
  return page.data.find(inbox => inbox.address === address)?.id ?? null
}
const messagesPath = (inbox: string, query: Record<string, string>) => `/v1/inboxes/${encodeURIComponent(inbox)}/messages?${new URLSearchParams(query)}`
/** The cursor after the last message already there with this subject, so an earlier reply is never taken for this one's. */
async function lastCursor(inbox: string, subject: string) {
  let after = '0'
  for (let page = 0; page < 20; page++) {
    const read = await request<InboxMessagePage>(messagesPath(inbox, { after, subjectContains: subject, limit: '100' }))
    after = read.cursor
    if (!read.hasMore) return after
  }
  return after
}

/** The reply's own words: the snippet up to the quoted email under it. */
export function replyWords(snippet: string) {
  const cut = snippet.search(/\s*(?:On\s[^\n]{4,200}?wrote:|-{2,}\s*Original Message|_{8,}|\n>|^>)/m)
  return (cut > 0 ? snippet.slice(0, cut) : snippet).trim() || snippet.trim()
}
const ms = (value: number) => `${Math.max(0, Math.round(value)).toLocaleString('en-US')} ms`
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

// A webmail link for the addresses people use most; anything else gets none.
function webmail(email: string | null | undefined) {
  const host = email?.split('@')[1]?.toLowerCase() ?? ''
  if (['gmail.com', 'googlemail.com'].includes(host)) return { label: 'Open Gmail', href: 'https://mail.google.com/mail/u/0/#inbox' }
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(host)) return { label: 'Open Outlook', href: 'https://outlook.live.com/mail/0/' }
  if (['icloud.com', 'me.com', 'mac.com'].includes(host)) return { label: 'Open iCloud Mail', href: 'https://www.icloud.com/mail' }
  if (['yahoo.com', 'ymail.com'].includes(host)) return { label: 'Open Yahoo Mail', href: 'https://mail.yahoo.com' }
  return null
}

/**
 * An annotation beside what it measures, joined to it by a thin line; on a narrow screen it sits under it. Its box is laid
 * out from the first frame (`shown` only fades it in), so a figure landing moves nothing.
 */
export function Callout({ shown, label, children }: { shown: boolean; label: string; children: ReactNode }) {
  return <aside className="onb-callout" data-shown={shown || undefined} aria-label={label} aria-hidden={!shown || undefined}>
    <span className="onb-callout__line" aria-hidden="true" />
    <div className="onb-callout__body">{children}</div>
  </aside>
}

type Props = { email: string | null; domain: string | null; domainId: string | null; ready: boolean; state: FirstEmail; onChange: (update: (state: FirstEmail) => FirstEmail) => void; onContinue: () => void; onSkip: () => void }

/** Step 1: write it, send it, reply to it. Usable while the account is provisioned; Send waits for `ready`. */
export function FirstEmailStep({ email, domain, domainId, ready, state, onChange, onContinue, onSkip }: Props) {
  const { phase } = state
  const composing = phase === 'compose', sending = phase === 'sending', sent = phase === 'waiting' || phase === 'replied'
  const canSend = composing && ready && Boolean(domainId) && Boolean(state.subject.trim()) && Boolean(state.text.trim())
  const shown = useRef(false)
  useEffect(() => { if (!shown.current) { shown.current = true; analytics().track('onboarding', 'email/shown') } }, [])

  // The Inbox is found while the email is written, so the wait for the reply starts with the send.
  const inbox = useRef<Promise<string | null> | null>(null)
  useEffect(() => { if (domain && !inbox.current) inbox.current = builtinInbox(domain).catch(() => null) }, [domain])

  async function send() {
    if (!canSend || !domainId || !domain) return
    const subject = state.subject.trim(), text = state.text.trim()
    inbox.current ??= builtinInbox(domain).catch(() => null)
    // Where the reply will be looked for from: read while the email goes out, never in front of it.
    const after = inbox.current.then(id => id ? lastCursor(id, subject) : null).catch(() => null)
    onChange(current => ({ ...current, subject, text, phase: 'sending', error: null, sentMs: null, reply: null, sent: { subject, after } }))
    const started = performance.now()
    try {
      await request(`/v1/domains/${encodeURIComponent(domainId)}/test-send`, { method: 'POST', body: { subject, text }, idempotencyKey: crypto.randomUUID() })
      const took = performance.now() - started
      analytics().track('onboarding', 'email/sent')
      onChange(current => ({ ...current, phase: 'waiting', sentMs: took }))
    } catch (error) {
      onChange(current => ({ ...current, phase: 'compose', error, sent: null }))
    }
  }

  useReplyWait(phase === 'waiting' ? state.sent : null, inbox.current, reply => {
    analytics().track('onboarding', 'email/replied')
    onChange(current => current.phase === 'waiting' ? { ...current, phase: 'replied', reply } : current)
  })

  const skip = () => { analytics().track('onboarding', 'email/skip'); onSkip() }
  const go = () => { if (composing) void send(); else if (phase === 'replied') onContinue() }
  useStepKeys({ modEnter: go, enter: go, escape: phase === 'replied' ? onContinue : skip })

  const reply = state.reply, mail = webmail(email)
  const pushed = reply?.servedAt && reply.message.storedAt ? Date.parse(reply.servedAt) - Date.parse(reply.message.storedAt) : null
  const titles: [FirstEmailPhase[], string, string][] = [
    [['compose', 'sending'], 'Send yourself an email', `It comes from ${SETUP_SENDER.name}. Reply from your inbox and watch the reply arrive here.`],
    [['waiting'], 'Now check your email and reply to it', `Open the email from ${SETUP_SENDER.name} and hit reply. It shows up here the moment it lands.`],
    [['replied'], 'Your reply is here', 'Sending and receiving both work. Next, what you want to do with them.'],
  ]
  // The send is the person's own act, so its heading may take another line; waiting and replied share one cell, as the
  // reply lands on its own and must move nothing.
  const shownTitles = titles.filter(([phases]) => composing || sending ? phases.includes('compose') : !phases.includes('compose'))
  return <div className="onboarding onb-email-step" data-phase={phase}>
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title onboarding-slot">{shownTitles.map(([phases, title]) => <span key={title} data-active={phases.includes(phase) || undefined} aria-hidden={!phases.includes(phase) || undefined}>{title}</span>)}</h1>
      <p className="muted onboarding-builtin-copy onboarding-slot">{shownTitles.map(([phases, , line]) => <span key={line} data-active={phases.includes(phase) || undefined} aria-hidden={!phases.includes(phase) || undefined}>{line}</span>)}</p>
    </div>

    <div className="onb-annotated onb-rise" style={rise(1)}>
      <form className="onb-mail" data-sent={sent || undefined} aria-label="Your first email" onSubmit={event => { event.preventDefault(); void send() }}>
        <dl className="onb-mail__head">
          <div><dt>From</dt><dd>{SETUP_SENDER.name}</dd></div>
          <div><dt>To</dt><dd>{email ? <PrivateAddress value={email} /> : null}</dd></div>
        </dl>
        <label className="sr-only" htmlFor="onb-mail-subject">Subject</label>
        <Input id="onb-mail-subject" className="onb-mail__subject" value={state.subject} maxLength={SETUP_LIMITS.subject} readOnly={!composing} autoComplete="off"
          onChange={event => onChange(current => ({ ...current, subject: event.target.value.replace(/[\r\n]/g, ' ') }))} />
        <label className="sr-only" htmlFor="onb-mail-text">Message</label>
        <Textarea id="onb-mail-text" className="onb-mail__text" value={state.text} maxLength={SETUP_LIMITS.text} readOnly={!composing} rows={4}
          onChange={event => onChange(current => ({ ...current, text: event.target.value }))}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }} />
        <div className="onb-mail__foot">
          <span className="onboarding-slot onb-mail__status">
            <span data-active={composing || undefined} aria-hidden={!composing || undefined}><Button type="submit" variant="primary" disabled={!canSend} aria-keyshortcuts="Meta+Enter Control+Enter" data-analytics="onboarding/email/send">Send<Kbd>{modKey}↵</Kbd></Button></span>
            <span data-active={sending || undefined} aria-hidden={!sending || undefined}><Button variant="primary" loading tabIndex={-1}>Send<Kbd>{modKey}↵</Kbd></Button></span>
            <span data-active={sent || undefined} aria-hidden={!sent || undefined} className="onb-mail__sent"><Check size={14} strokeWidth={2.5} aria-hidden />Sent</span>
          </span>
        </div>
      </form>
      <Callout shown={state.sentMs !== null} label="How it was sent">
        <span>Sent through the API in</span> <strong className="onb-num">{state.sentMs === null ? '0 ms' : ms(state.sentMs)}</strong>
      </Callout>
    </div>
    {state.error ? <p className="onboarding-error onb-email-error" role="alert"><ErrorText error={state.error} /></p> : null}

    {!composing && <div className="onb-reply-zone">
      <div className="onboarding-slot onb-reply-slot">
        <div className="onb-waiting" data-active={!reply || undefined} aria-hidden={Boolean(reply) || undefined}>
          <span className="connect-agent__pulse" aria-hidden="true" />
          <span>Waiting for your reply</span>
          {mail && <a className="ui-button ui-button--ghost ui-button--sm" href={mail.href} target="_blank" rel="noopener noreferrer" data-analytics="onboarding/email/webmail">{mail.label}<ArrowUpRight size={14} aria-hidden /></a>}
        </div>
        <div className="onb-annotated" data-active={reply ? true : undefined} aria-hidden={reply ? undefined : true}>
          <article className="onb-mail onb-mail--reply" aria-label="Your reply">
            <dl className="onb-mail__head">
              <div><dt>From</dt><dd>{reply ? <PrivateAddress value={reply.message.from.address} /> : '\u00a0'}</dd></div>
              <div><dt>Subject</dt><dd className="onb-mail__line">{reply?.message.subject || '\u00a0'}</dd></div>
            </dl>
            <p className="onb-mail__words">{reply ? replyWords(reply.message.snippet) : '\u00a0'}</p>
          </article>
          <Callout shown={Boolean(reply)} label="How it arrived">
            <span className="onb-callout__row"><span>Received at</span> <strong className="onb-num">{reply ? clock(reply.message.receivedAt) : '00:00:00'}</strong></span>
            {(!reply || typeof reply.message.processingMs === 'number') && <span className="onb-callout__row"><span>Processed in</span> <strong className="onb-num">{ms(reply?.message.processingMs ?? 0)}</strong></span>}
            {(!reply || (pushed !== null && pushed <= PUSH_SHOWN_MS)) && <span className="onb-callout__row"><span>Pushed here in</span> <strong className="onb-num">{ms(pushed ?? 0)}</strong></span>}
          </Callout>
        </div>
      </div>
    </div>}
    <span className="sr-only" role="status">{reply ? `Your reply arrived at ${clock(reply.message.receivedAt)}.` : sent ? 'Sent. Waiting for your reply.' : ''}</span>

    <div className="onboarding-connect-actions onb-rise onb-email-actions" style={rise(2)}>
      <span className="onboarding-slot">
        <span data-active={phase === 'replied' || undefined} aria-hidden={phase !== 'replied' || undefined}><Button variant="primary" tabIndex={phase === 'replied' ? undefined : -1} data-analytics="onboarding/email/continue" onClick={onContinue}>Continue<Kbd>↵</Kbd></Button></span>
        <span data-active={phase !== 'replied' || undefined} aria-hidden={phase === 'replied' || undefined}><button type="button" className="onboarding-skip" tabIndex={phase === 'replied' ? -1 : undefined} data-analytics="onboarding/email/skip" onClick={skip}>Skip<Kbd>Esc</Kbd></button></span>
      </span>
    </div>
  </div>
}

/**
 * Waits for the reply: the first message in the Inbox after the send's cursor whose subject contains the one sent, by a
 * long poll that holds until one arrives (paused while the tab is hidden). A wait cut short early, again and again, means
 * something on the way ends long requests: it polls every 4 s instead.
 */
function useReplyWait(sent: FirstEmail['sent'], inboxPromise: Promise<string | null> | null, onReply: (reply: NonNullable<FirstEmail['reply']>) => void) {
  const latest = useRef(onReply)
  latest.current = onReply
  useEffect(() => {
    if (!sent || !inboxPromise) return
    const scope = currentScope()
    let stopped = false, controller: AbortController | null = null, wake: (() => void) | null = null, timer: ReturnType<typeof setTimeout> | undefined
    const hidden = () => document.visibilityState === 'hidden'
    const pause = (ms: number) => new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, ms) })
    const onVisibility = () => { if (hidden()) controller?.abort(); else { clearTimeout(timer); wake?.() } }
    document.addEventListener('visibilitychange', onVisibility)
    void (async () => {
      const inbox = await inboxPromise, start = await sent.after
      if (!inbox || start === null || stopped) return
      let after: string = start
      let failures = 0, cut = 0, polling = false
      while (!stopped && isCurrentScope(scope)) {
        if (hidden()) { await new Promise<void>(resolve => { wake = resolve }); continue }
        controller = new AbortController()
        const wait = polling ? 0 : WAIT_S, started = Date.now()
        try {
          const page: InboxMessagePage = await request<InboxMessagePage>(messagesPath(inbox, { after, wait: String(wait), subjectContains: sent.subject, limit: '5' }), { signal: controller.signal, scope })
          if (stopped) return
          failures = 0
          const found = page.data[0]
          if (found) { latest.current({ message: found, servedAt: page.servedAt ?? null }); return }
          after = page.cursor
          if (wait && Date.now() - started < 2000) { if (++cut >= 3) polling = true } else cut = 0
          if (polling) await pause(4000)
        } catch (error) {
          if (stopped || !isCurrentScope(scope)) return
          if (isAbortError(error)) continue
          if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) return
          failures++
          await pause(error instanceof ApiError && error.status === 429 ? 60_000 : Math.min(30_000, 2000 * 2 ** (failures - 1)))
        }
      }
    })()
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); wake?.(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [sent, inboxPromise])
}

/** The thin bar along the top while the account is provisioned: it fills and fades once it's ready, and never moves anything. */
export function ProvisioningBar({ active }: { active: boolean }) {
  const [state, setState] = useState<'running' | 'done' | 'gone'>(active ? 'running' : 'gone')
  if (active && state !== 'running') setState('running')
  if (!active && state === 'running') setState('done')
  useEffect(() => {
    if (state !== 'done') return
    const timer = setTimeout(() => setState('gone'), 700)
    return () => clearTimeout(timer)
  }, [state])
  if (state === 'gone') return null
  return <div className="onb-provisioning" data-state={state}>
    <div className="onb-provisioning__track" aria-hidden="true"><span /></div>
    <p className="onb-provisioning__label">Provisioning your account</p>
    <span className="sr-only" role="status">{state === 'running' ? 'Provisioning your account' : 'Your account is ready'}</span>
  </div>
}

