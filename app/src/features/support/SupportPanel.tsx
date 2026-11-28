import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Check, CircleAlert, Image as ImageIcon, ImagePlus, Square, UserRound, X } from 'lucide-react'
import { Button, DropdownMenu, IconButton, Skeleton } from '../../components/ui'
import { SheetOpenEffects, useSheetDrag } from '../../components/ui/sheet'
import { useSession } from '../../data/context'
import { PrivateAddress } from '../../components/PrivateAddress'
import { TOUCH, matches, usePhone, useTouch } from '../../lib/media'
import { Markdown, settled } from './markdown'
import { createDemoTransport } from './demo'
import { createSocketTransport, createUnavailableTransport, forgetSaved, loadDraft, saveDraft, supportOrigin } from './socket'
import { actionResult, actionTitle, actionVerb, endSupport, plural, supportStore, ticketTitle, type ActionPart, type Attachment, type ChatMessage, type ChatState, type Part, type SupportStore } from './store'
import { ActionSummary } from './actions'
import { IMAGE_TYPES, MAX_MESSAGE } from './protocol'
import './support.css'
import { NightmailMark } from '../../components/NightmailLogo'
import { productName } from '../../../../api/src/brand'

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')
// The account in this tab changes or signs out (data/context.tsx, or a 401 from the API): its conversation, socket and state
// end with it. A sign-out also forgets the conversations this tab saved.
for (const type of ['nightmail:account-changed', 'nightmail:account-signed-out', 'nightmail:unauthorized', 'nightmail:support-reset']) window.addEventListener(type, event => {
  endSupport()
  if (type !== 'nightmail:unauthorized' && type !== 'nightmail:support-reset' && (event as CustomEvent<{ signedOut?: boolean } | null>).detail?.signedOut !== false) forgetSaved()
})
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
/** The panel's own first line: shown at the top of the conversation once loaded, with no model call. */
const OPENING = 'Hey, what’s up? How can we help?'
/** The status line while an answer is being worked on and no step is running. */
const WORKING = 'Working on it…'
/** The chat can't take messages now (it refused, or its connection is lost): what is sent goes to the team as a ticket. */
const down = (state: ChatState) => state.connection === 'offline' || state.connection === 'unavailable'

// The support chat (hosted): Nightmail's AI support agent in a panel docked in the page's bottom-right corner on a desktop,
// opened from the sidebar's Help, which leaves the page readable beside it, and a sheet above the tab bar on a phone. It is not
// modal: on a desktop the page stays usable while the agent works, and the conversation carries on across pages.
export function SupportPanel({ mode, open, onClose, onUnread, resume }: { mode: 'demo' | 'live'; open: boolean; onClose: () => void; onUnread: (unread: boolean) => void; resume: string | null }) {
  const identity = useSession()?.identity ?? null
  const phone = usePhone(), touch = useTouch()
  const userId = identity?.id ?? 'demo', workspaceId = identity?.workspaceId ?? 'demo'
  const workspaceName = identity?.workspaces?.find(item => item.id === identity.workspaceId)?.name ?? null
  // One continuous conversation per account and workspace: another account or workspace gets its own, never this one's.
  // A dashboard with no support Worker to talk to (not on the hosted service's hosts, no VITE_SUPPORT_ORIGIN) gets the
  // chat's own refusal, never the scripted demo: only ?support=demo shows that.
  const store = useMemo(() => supportStore(`${mode}:${userId}:${workspaceId}`, () => {
    if (mode === 'demo') return createDemoTransport({ firstName: identity?.name?.trim().split(/\s+/)[0] || 'Ryan', workspace: { id: workspaceId, name: workspaceName ?? 'Acme' } })
    const origin = supportOrigin()
    return origin ? createSocketTransport({ origin, userId, workspaceId, resume }) : createUnavailableTransport()
  }, { read: () => loadDraft(mode, userId, workspaceId), write: draft => saveDraft(mode, userId, workspaceId, draft),
    parked: { read: () => loadDraft(mode, userId, workspaceId, 'parked'), write: text => saveDraft(mode, userId, workspaceId, text, 'parked') } }), [mode, userId, workspaceId])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    store.setVisible(open)
    if (open) store.start()
  }, [store, open])
  useEffect(() => { onUnread(state.unread) }, [state.unread])
  // Opening moves focus in (to the message box, or the panel itself on a touch screen, so the keyboard doesn't jump up);
  // closing with focus inside returns it to Help (the workspace menu's trigger on Get started, which has no Help button).
  useEffect(() => {
    const el = panel.current
    if (!el) return
    if (open) { const frame = requestAnimationFrame(() => (touch ? el : input.current ?? el).focus({ preventScroll: true })); return () => cancelAnimationFrame(frame) }
    if (el.contains(document.activeElement)) (document.getElementById('support-trigger') ?? document.getElementById('sidebar-workspace'))?.focus({ preventScroll: true })
  }, [open])
  const close = () => { panel.current?.style.removeProperty('transform'); onClose() }
  const drag = useSheetDrag(close, phone)
  const busy = state.busy || state.messages.some(message => message.streaming)
  const loading = !state.synced && !state.messages.length && state.connection !== 'offline' && state.connection !== 'unavailable'
  // A screenshot dragged over the panel: a drop target over the conversation (the page beside it isn't one).
  const canAttach = store.transport.uploads && (state.connection === 'open' || state.connection === 'ready') && !state.closed
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const files = (event: DragEvent) => [...event.dataTransfer.types].includes('Files')
  const drop = {
    onDragEnter: (event: DragEvent) => { if (!canAttach || !files(event)) return; event.preventDefault(); depth.current++; setDragging(true) },
    onDragOver: (event: DragEvent) => { if (!canAttach || !files(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
    onDragLeave: () => { if (depth.current && --depth.current === 0) setDragging(false) },
    onDrop: (event: DragEvent) => { if (!canAttach || !files(event)) return; event.preventDefault(); depth.current = 0; setDragging(false); void store.attach([...event.dataTransfer.files]) },
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Escape inside the panel closes it. A menu opened from it lives in a portal and handles its own Escape.
    if (event.key === 'Escape' && !event.defaultPrevented && panel.current?.contains(event.target as Node)) { event.preventDefault(); close() }
  }
  return <>
    {phone && <div className="support-overlay" data-open={open || undefined} aria-hidden="true" onClick={close} />}
    {(phone || touch) && open && <SheetOpenEffects />}
    <section ref={panel} id="support-panel" className={cx('support-panel', phone && 'support-panel--sheet')} role="dialog" aria-modal="false" aria-labelledby="support-title"
      data-open={open || undefined} data-busy={(busy || loading) || undefined} tabIndex={-1} onKeyDown={onKeyDown} {...drag} {...drop}>
      {phone && <div className="ui-sheet__grab" aria-hidden="true"><span /></div>}
      <Header state={state} store={store} workspaceName={workspaceName} onClose={close} />
      <Conversation state={state} store={store} open={open} loading={loading} />
      <Composer state={state} store={store} input={input} busy={busy} canAttach={canAttach} />
      <div className="support-drop" data-active={dragging || undefined} aria-hidden="true"><ImagePlus size={20} /><span>Drop a screenshot to attach</span></div>
      <div className="sr-only" role="status" aria-live="polite">{state.announcement}</div>
    </section>
  </>
}

function Header({ state, store, workspaceName, onClose }: { state: ChatState; store: SupportStore; workspaceName: string | null; onClose: () => void }) {
  const hello = state.hello
  // While it connects the header already reads as it will once connected; only the dot turns green.
  const workspace = hello?.workspace?.name ?? workspaceName
  const displayName = `${productName} Support`
  const [tone, subtitle] = state.closed ? ['neutral', 'Conversation ended']
    : state.connection === 'offline' ? ['warning', 'Offline · reconnecting']
    : state.connection === 'unavailable' ? ['warning', 'Chat unavailable']
    : [hello || state.connection === 'ready' ? 'success' : 'neutral', `${workspace ? `${workspace} · ` : ''}${hello?.agent.ai === false ? 'Support' : 'AI-assisted'}`]
  const ticketed = state.status === 'ticketed' || state.humanRequested
  return <header className="support-panel__header">
    <NightmailMark className="support-panel__mark" size={18} />
    <div className="support-panel__heading">
      <h2 id="support-title">{displayName}</h2>
      <p className="support-panel__subtitle" data-tone={tone}><span className="support-panel__dot" aria-hidden="true" /><span key={subtitle} className="support-panel__subtitle-text" title={subtitle}>{subtitle}</span></p>
    </div>
    <div className="support-panel__actions">
      {state.connection !== 'unavailable' && <DropdownMenu label="Conversation options" title="Conversation" items={[
        { label: ticketed ? `Passed to the ${productName} team` : 'Talk to a person', icon: <UserRound size={16} />, disabled: ticketed || (state.connection !== 'open' && state.connection !== 'ready') || Boolean(state.closed), onSelect: () => store.requestHuman() },
        { label: 'End conversation', icon: <X size={16} />, disabled: Boolean(state.closed) || state.connection !== 'open', onSelect: () => store.end() },
      ]} />}
      <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
    </div>
  </header>
}

function Conversation({ state, store, open, loading }: { state: ChatState; store: SupportStore; open: boolean; loading: boolean }) {
  const scroller = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null), pinned = useRef(true), touched = useRef(0)
  // The log grows downward from the top, so new text never moves what is already on screen; while the reader is at the
  // bottom it follows the newest line by scrolling. Only the reader's own scrolling (wheel, touch, keys, the scrollbar)
  // lets go of the bottom; the browser clamping or re-anchoring the scroll position never does.
  useLayoutEffect(() => {
    const el = scroller.current, content = inner.current
    if (!el || !content) return
    const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight }
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    follow()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { if (open && scroller.current) { pinned.current = true; scroller.current.scrollTop = scroller.current.scrollHeight } }, [open, state.synced])
  const last = state.messages.at(-1)
  useLayoutEffect(() => { if (last?.role === 'user') pinned.current = true }, [last?.id])
  const touch = () => { touched.current = performance.now() }
  return <div ref={scroller} className="support-log" tabIndex={0} aria-label="Conversation" onWheel={touch} onTouchMove={touch} onKeyDown={touch} onPointerDown={touch}
    onScroll={event => {
      const el = event.currentTarget, atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom) pinned.current = true
      else if (performance.now() - touched.current < 600) pinned.current = false
    }}>
    <div ref={inner} className="support-log__inner">
      {loading ? <div className="support-loading" role="status" aria-busy="true" aria-label="Loading conversation">
        <div className="support-loading__agent"><Skeleton width="76%" height={14} /><Skeleton width="52%" height={14} /></div>
        <div className="support-loading__user"><Skeleton width="58%" height={32} /></div>
        <div className="support-loading__agent"><Skeleton width="84%" height={14} /><Skeleton width="66%" height={14} /><Skeleton width="40%" height={14} /></div>
      </div> : <>
        <article className="support-message support-message--agent support-message--opening"><div className="support-text"><p>{OPENING}</p></div></article>
        {state.messages.map((message, index) => message.role === 'user' ? <UserMessage key={message.key ?? message.id} message={message} onRetry={() => store.retry()}
          filed={message.filed && !state.messages[index + 1]?.filed ? { replyTo: state.ticket?.replyTo ?? null } : null} />
          : <AgentMessage key={message.key ?? message.id} message={message} store={store} closed={Boolean(state.closed)} />)}
      </>}
      <InlineStatus state={state} store={store} />
    </div>
  </div>
}

// One line under the last of a run of filed messages says where they all went.
function UserMessage({ message, onRetry, filed }: { message: ChatMessage; onRetry: () => void; filed: { replyTo: string | null } | null }) {
  const text = message.parts.map(part => part.kind === 'text' ? part.text : '').join('')
  return <div className="support-message support-message--user" data-restored={message.restored || undefined}>
    {message.images?.length ? <div className="support-user-images">{message.images.map((image, i) => image.url
      ? <img key={i} src={image.url} alt={`Screenshot: ${image.name}`} width={120} height={84} />
      // After a reload the image itself isn't available (the server never sends it back): its name holds the place.
      : <span key={i} className="support-user-images__placeholder" title={image.name}><ImageIcon size={14} aria-hidden="true" /><span>Screenshot</span><span className="support-user-images__name">{image.name}</span></span>)}</div> : null}
    {text && <p className="support-user">{text}</p>}
    {message.failed && <p className="support-failed"><span>{message.failed}</span><Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button></p>}
    {/* The chat couldn't take it: it went to the team as a ticket, who answer by email (and here, when the chat is back). */}
    {filed && <p className="support-filed"><Check size={12} strokeWidth={2.5} aria-hidden="true" /><span>Filed as a ticket.{filed.replyTo ? <> We’ll reply to <PrivateAddress value={filed.replyTo} />.</> : ' We’ll reply by email.'}</span></p>}
  </div>
}

// An answer as it arrives: its text and the cards it asked for. While it is being worked on, one quiet status line says
// what the agent is doing (the step running, from its label; between steps "Working on it…"), and the text takes its
// place when it arrives. Steps never show their inputs: the labels are fixed text from the server.
function AgentMessage({ message, store, closed }: { message: ChatMessage; store: SupportStore; closed: boolean }) {
  const lastPart = message.parts.at(-1)
  const asking = message.parts.some(part => part.kind === 'consent' && (part.state === 'open' || part.state === 'allowing') || part.kind === 'action' && (!part.action || part.action.status === 'proposed'))
  const working = message.streaming && lastPart?.kind !== 'text' && !asking
  const running = [...message.parts].reverse().find(part => part.kind === 'tool' && part.state === 'running')
  const shown = message.parts.map((part, index) => ({ part, index })).filter(({ part }) => part.kind !== 'tool')
  if (!working && !shown.length) return null
  return <article className={cx('support-message', 'support-message--agent', message.kind === 'notice' && 'support-message--notice', message.kind === 'staff' && 'support-message--staff')} data-restored={message.restored || undefined}>
    {message.kind === 'staff' && <p className="support-message__author">{message.author || `The ${productName} team`}</p>}
    {shown.map(({ part, index }) => part.kind === 'text' ? <StreamText key={index} text={part.text} live={message.streaming} last={index === message.parts.length - 1} restored={message.restored} />
      : part.kind === 'consent' ? <ConsentCard key={index} part={part} closed={closed} onDecide={decision => decide(store, part.request.requestId, decision)} />
      : part.kind === 'ticket' ? <TicketCard key={index} part={part} />
      : part.kind === 'action' ? <ActionCard key={part.request.actionId} part={part} store={store} /> : null)}
    {working && <AgentStatus label={running?.kind === 'tool' && running.label.trim() ? running.label : WORKING} />}
  </article>
}

// A decision on the consent card hands the keyboard back to the message box (the card's buttons go away).
function decide(store: SupportStore, requestId: string, decision: 'allow' | 'deny') {
  store.consent(requestId, decision)
  if (!matches(TOUCH)) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#support-panel .support-composer__input')?.focus({ preventScroll: true }))
}

// Text that streams in: revealed at a steady pace that catches up when the stream runs ahead, with a caret at its end.
function StreamText({ text, live, last, restored }: { text: string; live: boolean; last: boolean; restored: boolean }) {
  // Only the message's last part can still grow; text followed by a step or a card is complete.
  const growing = live && last && !restored
  const shown = useSmoothText(text, growing)
  const revealing = shown.length < text.length
  return <div className="support-text"><Markdown text={growing || revealing ? settled(shown) : shown} tail={last && (growing || revealing) ? <Caret /> : null} /></div>
}
function useSmoothText(text: string, live: boolean) {
  const [count, setCount] = useState(() => live ? 0 : text.length)
  const position = useRef(count), previous = useRef(text)
  useEffect(() => {
    const before = previous.current
    previous.current = text
    // Replaced text (the output gate, or a final text that differs) shows at once; so does everything under reduced motion.
    if (!text.startsWith(before.slice(0, Math.floor(position.current))) || reducedMotion()) { position.current = text.length; setCount(text.length); return }
    if (position.current >= text.length) return
    let frame = 0, at = performance.now()
    const step = (now: number) => {
      const seconds = Math.min(64, now - at) / 1000
      at = now
      const backlog = text.length - position.current
      // Once the message has ended the rest is shown within about a quarter second: it is all here, and waiting on the
      // reveal would only delay the answer (after a tool call the text arrives in one piece at the end).
      position.current = Math.min(text.length, position.current + Math.max(live ? 60 : 600, backlog * (live ? 4 : 24)) * seconds)
      setCount(Math.floor(position.current))
      if (position.current < text.length) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [text, live])
  // Whole words only, and a word still arriving waits for its end: a word that grows letter by letter can outgrow its
  // line and jump to the next, which moves text already on screen (a layout shift). A whole word lands where it stays.
  if (count >= text.length && !live) return text
  const shown = text.slice(0, count)
  const boundary = count >= text.length ? Math.max(shown.lastIndexOf(' '), shown.lastIndexOf('\n')) : Math.max(shown.lastIndexOf(' '), shown.lastIndexOf('\n'), /\s/.test(text[count] ?? '') ? count - 1 : -1)
  return shown.slice(0, boundary + 1)
}
// The caret is an empty inline box (no text, no inline-block), so moving along with the text never counts as a layout shift.
function Caret() { return <span className="support-caret" aria-hidden="true" /> }

// The status line: a breathing dot and the label, with a slow sheen across it; a new label rolls in over the old one.
// Under reduced motion it is still text that changes in place.
function AgentStatus({ label }: { label: string }) {
  const [previous, setPrevious] = useState<string | null>(null)
  const last = useRef(label)
  useEffect(() => {
    if (last.current === label) return
    setPrevious(last.current)
    last.current = label
    const timer = setTimeout(() => setPrevious(null), 260)
    return () => clearTimeout(timer)
  }, [label])
  return <p className="support-status" role="status">
    <span className="support-status__dot" aria-hidden="true" />
    <span className="support-status__label">
      {previous && <span key={`was:${previous}`} className="support-status__text" data-leaving="" aria-hidden="true">{previous}</span>}
      <span key={label} className="support-status__text" data-entering={previous ? '' : undefined}>{label}</span>
    </span>
  </p>
}

function ConsentCard({ part, closed, onDecide }: { part: Extract<Part, { kind: 'consent' }>; closed: boolean; onDecide: (decision: 'allow' | 'deny') => void }) {
  const decided = part.state === 'allow' || part.state === 'deny'
  return <div className="support-card support-consent" data-state={part.state} role="group" aria-label="Allow access to email content">
    <p className="support-card__title">Let support read emails in <strong>{part.request.workspace.name}</strong>?</p>
    <p className="support-card__body">{part.request.why}</p>
    <div className="support-card__actions">
      <div className="support-card__choice" data-active={!decided || undefined} aria-hidden={decided || undefined}>
        <Button variant="primary" size="sm" loading={part.state === 'allowing'} disabled={decided || closed} tabIndex={decided ? -1 : undefined} onClick={() => onDecide('allow')}>Allow for this chat</Button>
        <Button size="sm" disabled={decided || closed || part.state === 'allowing'} tabIndex={decided ? -1 : undefined} onClick={() => onDecide('deny')}>Not now</Button>
      </div>
      <p className="support-card__resolved" data-active={decided || undefined} data-decision={decided ? part.state : undefined} aria-hidden={!decided || undefined}>
        {part.state === 'deny' ? 'Not shared.' : <><Check size={14} strokeWidth={2.5} aria-hidden="true" />Allowed for this conversation</>}
      </p>
    </div>
  </div>
}

// A change the agent proposed. The card shows Nightmail's own sentence for it, read with this session (never the agent's
// words), and the buttons wait for it: Decline, then the change's own verb (Retry delivery, Send test…), in the order the
// emailed link's dialog has them. The verb has Nightmail make the change for this person, exactly as its own route does,
// and the card then says what came of it from Nightmail's answer. Left alone, it stays open until it expires.
function ActionCard({ part, store }: { part: ActionPart; store: SupportStore }) {
  const { action, state, error } = part
  const deciding = state === 'confirming' || state === 'declining'
  const outcome = action ? actionResult(action) : null
  // Decidable once Nightmail's record is in, or after a read that failed for a passing reason: then the card shows the
  // sentence the server sent with the proposal, and Try again. Only a proposal that isn't this person's has no decision.
  const decidable = !part.unavailable && (action ? action.status === 'proposed' : state !== 'loading' && Boolean(error))
  const decide = (decision: 'confirm' | 'decline') => {
    void store.decideAction(part.request.actionId, decision)
    if (!matches(TOUCH)) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#support-panel .support-composer__input')?.focus({ preventScroll: true }))
  }
  return <div className="support-card support-action" data-state={action?.status ?? state} role="group" aria-label="Confirm a change" aria-busy={state === 'loading' || undefined}>
    <p className="support-card__title">{actionTitle(part.request.kind)}</p>
    {action ? <p className="support-card__body"><ActionSummary action={action} /></p>
      : state === 'loading' ? <div className="support-card__body support-action__loading" aria-hidden="true"><Skeleton width="94%" height={10} /><Skeleton width="58%" height={10} /></div>
      : !part.unavailable ? <p className="support-card__body">{part.request.summary}</p> : null}
    {error && <p className="support-card__error" role="alert"><span>{error}</span>
      {!part.unavailable && <Button variant="ghost" size="sm" disabled={state === 'loading'} onClick={() => store.retryAction(part.request.actionId)}>Try again</Button>}</p>}
    {(decidable || outcome || state === 'loading') && <div className="support-card__actions">
      <div className="support-card__choice support-action__choice" data-active={!outcome || undefined} aria-hidden={outcome ? true : undefined}>
        <Button size="sm" loading={state === 'declining'} disabled={!decidable || deciding} tabIndex={outcome ? -1 : undefined} onClick={() => decide('decline')}>Decline</Button>
        <Button variant="primary" size="sm" loading={state === 'confirming'} disabled={!decidable || deciding} tabIndex={outcome ? -1 : undefined} onClick={() => decide('confirm')}>{actionVerb(part.request.kind)}</Button>
      </div>
      <p className="support-card__resolved" data-active={outcome ? true : undefined} data-tone={outcome?.tone} aria-hidden={outcome ? undefined : true}>
        {outcome?.tone === 'success' && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}<span>{outcome?.text}</span>
      </p>
    </div>}
  </div>
}

// What the ticket is ("Bug report filed", "Billing question passed to …") and its ID, then its facts: where the reply
// goes, when, and the screenshots that went with it.
function TicketCard({ part }: { part: Extract<Part, { kind: 'ticket' }> }) {
  const { ticket, screenshots } = part
  const hasFacts = Boolean(ticket.replyTo || ticket.expect || screenshots > 0)
  return <div className="support-card support-ticket" role="group" aria-label="Ticket">
    <span className="support-ticket__mark" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
    <div className="support-ticket__text">
      <p className="support-ticket__title"><span>{ticketTitle(ticket)}</span><code>{ticket.ticketId}</code></p>
      {hasFacts && <dl className="support-ticket__facts">
        {ticket.replyTo && <div><dt>Reply to</dt><dd><MaskedAddress value={ticket.replyTo} /></dd></div>}
        {ticket.expect && <div><dt>When</dt><dd>{ticket.expect}</dd></div>}
        {screenshots > 0 && <div><dt>Screenshots</dt><dd>{screenshots}</dd></div>}
      </dl>}
    </div>
  </div>
}
// The reply address arrives masked ("a…@acme.com"). It reads like every address in the dashboard: its first characters,
// then a blurred run; the rest is never in the page.
function MaskedAddress({ value }: { value: string | null | undefined }) {
  if (typeof value !== 'string' || !value) return null
  const shown = [...value.split(/…|@/)[0]].slice(0, 2).join('')
  return <span className="support-masked" title="Hidden for privacy"><span>{shown}</span><span className="support-masked__rest" aria-hidden="true" /><span className="sr-only"> (address hidden)</span></span>
}

function InlineStatus({ state, store }: { state: ChatState; store: SupportStore }) {
  if (state.closed) return null
  const line = (tone: 'warning' | 'danger', text: ReactNode, action?: ReactNode) => <div className="support-inline" data-tone={tone}><span className="support-inline__dot" aria-hidden="true" /><span>{text}</span>{action}</div>
  // A message that couldn't be filed: past the hour's limit (it is back in the message box), or Nightmail out of reach.
  if (state.fileProblem === 'capped') return line('warning', 'That’s the limit for this hour. Your earlier messages are with our team.')
  if (state.fileProblem === 'capped_first') return line('warning', 'That’s the limit for this hour.')
  if (state.fileProblem === 'waiting') return line('warning', 'Can’t reach us right now. Your message is kept and goes as soon as it can.')
  // Once something is with the team, its line says so; until then, say what sending does while the chat is down.
  if (state.ticket && down(state)) return null
  if (state.connection === 'unavailable') return line('warning', 'What you send is filed as a ticket.')
  // A lost connection with a message being answered: the message says "Working on it…" and the header the reconnecting.
  if (state.connection === 'offline') return state.messages.some(message => message.streaming || message.local) ? null
    : line('warning', `Reconnecting to ${productName} support.`, <Button variant="ghost" size="sm" onClick={() => store.reconnect()}>Try now</Button>)
  if (state.limit) return line('warning', state.limit.message)
  return null
}

function Composer({ state, store, input, busy, canAttach }: { state: ChatState; store: SupportStore; input: RefObject<HTMLTextAreaElement | null>; busy: boolean; canAttach: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const picker = useRef<HTMLInputElement>(null)
  const until = state.limit?.until ?? null
  useEffect(() => { if (until && until > Date.now()) { const timer = setTimeout(() => setNow(Date.now()), until - Date.now() + 50); return () => clearTimeout(timer) } }, [until])
  // A refused screenshot's reason stays a few seconds, then the tray returns to what is attached.
  useEffect(() => { if (state.attachError) { const timer = setTimeout(() => store.clearAttachError(), 6000); return () => clearTimeout(timer) } }, [state.attachError])
  const limited = Boolean(state.limit && (state.limit.until === null || state.limit.until > now))
  // Short enough for one line on a 320 px phone: the box sizes to it while empty.
  const placeholder = limited ? 'Messages are paused for now' : state.ticket && down(state) ? 'Add to your ticket' : 'Ask about your sending'
  // The box grows with what is typed, up to six lines, then scrolls.
  useLayoutEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 132)}px` }, [state.draft, placeholder])
  if (state.closed) return <div className="support-composer support-composer--closed">
    <Button size="sm" onClick={() => store.restart()}>Start a new conversation</Button>
  </div>
  // Open for typing and sending from the moment the panel opens: what is sent before the conversation is connected goes
  // out once it is, and what the chat can't take (refused, or its connection lost) goes to the team as a ticket.
  const online = state.connection === 'open' && Boolean(state.hello)
  const sendable = store.sendable()
  const stop = busy && !state.draft.trim() && !state.attachments.length && online
  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (stop) { store.cancel(); return }
    if (!limited) store.send()
  }
  return <form className="support-composer" onSubmit={submit}>
    <AttachmentTray state={state} store={store} />
    <div className="support-composer__box" data-disabled={limited || undefined}>
      {store.transport.uploads && <>
        <IconButton size="sm" className="support-composer__attach" label="Attach a screenshot" disabled={!canAttach || limited} onClick={() => picker.current?.click()}><ImagePlus size={16} /></IconButton>
        {/* On a phone this opens the photo picker: images only, no camera capture. */}
        <input ref={picker} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden tabIndex={-1} onChange={event => { void store.attach([...event.target.files ?? []]); event.target.value = '' }} />
      </>}
      <textarea ref={input} className="support-composer__input" rows={1} value={state.draft} maxLength={MAX_MESSAGE} aria-label={`Message ${productName} Support`}
        placeholder={placeholder}
        onChange={event => store.setDraft(event.target.value)}
        onPaste={event => { const pasted = [...event.clipboardData.files]; if (pasted.length && canAttach) { event.preventDefault(); void store.attach(pasted) } }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
      <IconButton type="submit" variant={stop ? 'secondary' : 'primary'} size="sm" className="support-composer__send" label={stop ? 'Stop answering' : 'Send'} data-stop={stop || undefined} disabled={stop ? false : !sendable || limited}>
        <span className="support-composer__icons" aria-hidden="true"><ArrowUp size={14} strokeWidth={2.25} /><Square size={9} strokeWidth={0} fill="currentColor" /></span>
      </IconButton>
    </div>
  </form>
}

// Screenshots waiting in the message box: thumbnails to remove before sending, and one quiet line for how the upload is
// going (or why a file was refused). Two fixed layers over the bottom of the conversation, which makes room for them: the
// line just above the message box and the thumbnails above it. Each only appears or goes, so nothing on screen moves.
const TRAY_LINE = 24, TRAY_THUMBS = 60
function AttachmentTray({ state, store }: { state: ChatState; store: SupportStore }) {
  const { attachments, attachError } = state
  const tray = useRef<HTMLDivElement>(null)
  const shown = attachments.length > 0 || Boolean(attachError)
  const height = shown ? TRAY_LINE + (attachments.length ? TRAY_THUMBS : 0) : 0
  useLayoutEffect(() => {
    const panel = tray.current?.closest<HTMLElement>('.support-panel')
    panel?.style.setProperty('--tray', `${height}px`)
    return () => { panel?.style.removeProperty('--tray') }
  }, [height])
  const failed = attachments.find(item => item.state === 'failed')
  const uploading = attachments.some(item => item.state === 'uploading')
  const progress = Math.round(attachments.reduce((sum, item) => sum + (item.state === 'ready' ? 1 : item.progress), 0) / Math.max(1, attachments.length) * 100)
  const [tone, line] = attachError ? ['danger', attachError]
    : failed ? ['danger', `Couldn’t upload ${failed.name}: ${failed.error ?? 'the upload failed.'}`]
    : uploading ? ['progress', <>Uploading {plural(attachments.length, 'screenshot')}… <span className="support-tray__percent">{progress}%</span></>]
    : attachments.length ? ['done', `${plural(attachments.length, 'screenshot')} ready to send`] : ['', '']
  return <div ref={tray} className="support-tray" hidden={!shown}>
    {attachments.length > 0 && <ul className="support-tray__thumbs">{attachments.map(item => <Thumb key={item.key} item={item} onRemove={() => store.detach(item.key)} />)}</ul>}
    {line && <p className="support-tray__line" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="support-tray__mark" aria-hidden="true">{tone === 'danger' ? <CircleAlert size={12} /> : tone === 'done' ? <Check size={12} strokeWidth={2.5} /> : <span className="support-tool__dot" />}</span>
      <span>{line}</span>
    </p>}
  </div>
}
function Thumb({ item, onRemove }: { item: Attachment; onRemove: () => void }) {
  return <li className="support-thumb" data-state={item.state}>
    <img src={item.url} alt={item.name} width={48} height={48} />
    {item.state === 'uploading' && <span className="support-thumb__bar" aria-hidden="true" style={{ transform: `scaleX(${Math.max(.04, item.progress)})` }} />}
    <button type="button" className="support-thumb__remove" aria-label={`Remove ${item.name}`} onClick={onRemove}><X size={10} strokeWidth={2.5} /></button>
  </li>
}
