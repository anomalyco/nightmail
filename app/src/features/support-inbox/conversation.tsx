import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Bot, Check, ChevronRight, Clock, Hand, Image as ImageIcon, Lock, Paperclip, Ticket, X } from 'lucide-react'
import { Button, Dialog, DropdownMenu, EmptyState, ErrorState, KeyValues, StatusBadge, Textarea, useToast } from '../../components/ui'
import { useKeyboardInset } from '../../components/ui/sheet'
import { PrivateAddress } from '../../components/PrivateAddress'
import { ReceivedEmailPreview } from '../../components/EmailPreview'
import { productName } from '../../../../api/src/brand'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { channelLabels, detailQuery, inboxDraft, inboxKeys, listQuery, prefetchConversation, subscribeInboxDrafts, supportInboxApi, updateInboxDraft, type Channel, type HeldReason, type SupportBrief, type SupportConversation, type SupportDetail, type SupportEmail, type SupportEvent, type SupportMessage } from '../../data/support-inbox'
import { ago, label, number, shortDateTime } from '../../lib/format'
import { useTouch } from '../../lib/media'
import { StaffOnly } from '../operator/skeletons'
import { Markdown } from '../support/markdown'
import { cached, CONVERSATION, ConfirmAction, failedText, flatten, freshOnly, isSendKey, listPath, memory, menuItems, ShortcutsDialog, titleOf, useInboxActions, useRole, useShortcuts, when, type Actions, type Confirming } from './actions'
import { ConversationHeader, ThreadSkeleton, triageOf, whoOf } from './skeletons'
import './conversation.css'

// One support conversation (/support/:id), as a chat: one column, the newest message at the bottom and the reply box
// docked under it, always in view (above the tab bar and the keyboard on a phone). The customer's words are bubbles;
// ours (the agent's and staff's) are plain text under a small mark and name; a note or the agent's held answer is a card.
// Events are quiet centred lines, days are separated, and a message's time sits beside its name. The customer's details
// and the agent's summary are behind Details (a panel from the right, a sheet on a phone).

/** The conversations around this one, in the list it was opened from. One that left the list (marked done, answered) keeps its place, so j and k still go on from it. */
function useNeighbors(id: string, rows: SupportConversation[]) {
  const order = useRef<string[]>([])
  const ids = rows.map(c => c.id)
  if (ids.length) {
    const at = order.current.indexOf(id)
    if (ids.includes(id) || at < 0) order.current = ids
    else { const before = order.current.slice(0, at).filter(other => ids.includes(other)); order.current = [...before, id, ...ids.filter(other => !before.includes(other))] }
  }
  const at = order.current.indexOf(id)
  return { next: at >= 0 ? order.current[at + 1] : undefined, previous: at > 0 ? order.current[at - 1] : undefined }
}


export function SupportConversationPage() {
  const role = useRole(), canAct = role === 'operator'
  const id = useParams().id ?? '', valid = CONVERSATION.test(id)
  const client = useQueryClient(), navigate = useNavigate(), location = useLocation()
  const detail = useQuery({ ...detailQuery(id), enabled: Boolean(role && valid), refetchInterval: query => query.state.status === 'error' ? false : 30_000 })
  const list = useInfiniteQuery({ ...listQuery(memory.list.view, memory.list.q, memory.list.channel), enabled: Boolean(role), staleTime: 5_000 })
  const rows = flatten(list.data?.pages)
  const { next, previous } = useNeighbors(id, rows)
  const conversation = detail.data?.conversation ?? rows.find(c => c.id === id) ?? (valid ? cached(client, id) : undefined)
  const actions = useInboxActions()
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false), [details, setDetails] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  // On a phone the page ends where the keyboard begins, so the reply box rises with it.
  useKeyboardInset()
  // The conversations either side are read ahead, so j and k open them at once.
  useEffect(() => { if (!detail.data) return; for (const other of [next, previous]) if (other) void prefetchConversation(client, other) }, [Boolean(detail.data), next, previous])
  // Shown is read: through the messages on screen, so one arriving later is still new. Once per transcript length, so
  // marking it unread here (u) stays unread.
  const unread = detail.data?.conversation.unread, seen = detail.data?.conversation.messageCount, marked = useRef('')
  useEffect(() => {
    if (!unread || !detail.data || marked.current === `${id}:${seen}`) return
    marked.current = `${id}:${seen}`
    void actions.read(detail.data.conversation, true, seen)
  }, [id, unread, seen])
  const wantsReply = (location.state as { reply?: boolean } | null)?.reply === true
  useEffect(() => { if (wantsReply && detail.data) composer.current?.focus('reply') }, [Boolean(detail.data), wantsReply])
  const go = (to: string | undefined) => { if (to) navigate(`/support/${to}`, { replace: true }) }
  const back = () => { if (location.key !== 'default') navigate(-1); else navigate(listPath()) }
  // Done (e, the button): marks this conversation done if it needs you, then opens the next one, or goes back to the
  // list after the last.
  const finish = () => {
    if (!conversation) return
    const after = next ?? previous
    if (canAct && conversation.needsYou) void actions.done(conversation)
    if (after) go(after); else back()
  }
  // Details belong to the conversation they were opened on: another one closes them.
  useEffect(() => { setDetails(false) }, [id])
  useShortcuts({
    j: () => go(next), k: () => go(previous), Escape: back, r: () => composer.current?.focus('reply'), n: () => composer.current?.focus('note'), '?': () => setKeysOpen(true), e: finish,
    h: () => { if (conversation && canAct && conversation.agentState === 'paused' && conversation.status !== 'closed') setConfirming({ action: 'resume', conversation }) },
    u: () => conversation && void actions.read(conversation, conversation.unread, conversation.unread ? conversation.messageCount : undefined),
  }, Boolean(role && valid))
  if (!role) return <StaffOnly />
  if (!valid) return <EmptyState headingAs="h1" title="Page not found" action={<Link to="/support">Return to support</Link>} />
  const status = conversation && triageOf(conversation)
  const marks = canAct && conversation?.needsYou != null
  return <div className="sinbox-chat">
    <ConversationHeader channel={conversation?.channel} who={conversation && whoOf(conversation)} status={status && <StatusBadge status={status.text} tone={status.tone} />}
      onDetails={detail.data ? () => setDetails(true) : undefined}
      done={conversation ? { onClick: finish, title: `${marks ? 'Mark done and open' : 'Open'} ${next ?? previous ? 'the next conversation' : 'the list'} (e)` } : undefined}
      menu={conversation && <DropdownMenu label="Conversation actions" title={titleOf(conversation)} items={menuItems(conversation, { canAct, actions, onConfirm: setConfirming, done: false })} />} />
    {detail.data ? <Thread key={id} detail={detail.data} canAct={canAct} actions={actions} composer={composer} onConfirm={setConfirming} />
      : detail.isError ? <div className="sinbox-chat__scroll"><div className="sinbox-chat__column sinbox-chat__thread"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div></div>
      : <ThreadSkeleton />}
    {detail.data && <Dialog open={details} onOpenChange={setDetails} title="Details" size="lg" className="sinbox-details">
      {detail.data.brief && <div className="sinbox-details__brief"><AiSummary brief={detail.data.brief} subject={titleOf(detail.data.conversation)} /></div>}
      <CustomerPanel detail={detail.data} />
      <Activity detail={detail.data} />
    </Dialog>}
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ApprovalPrompt conversationId={id} canAct={canAct} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </div>
}

/**
 * A decision a staff email linked to (?approval=…&token=…, api/src/support-approvals.ts), ready to confirm. Opening the
 * link did nothing: only Approve here (the operator role) runs it. Not now leaves it waiting; Decline closes it.
 */
function ApprovalPrompt({ conversationId, canAct }: { conversationId: string; canAct: boolean }) {
  const [params, setParams] = useSearchParams(), approvalId = params.get('approval'), token = params.get('token')
  const client = useQueryClient(), toast = useToast(), key = useRef(crypto.randomUUID()), [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const linked = Boolean(approvalId && token)
  const approval = useQuery({ queryKey: ['support-inbox', 'approval', conversationId, approvalId], queryFn: ({ signal }) => supportInboxApi.approval(conversationId, approvalId!, token!, signal), enabled: linked, retry: false, staleTime: Infinity })
  const close = () => setParams(previous => { const next = new URLSearchParams(previous); next.delete('approval'); next.delete('token'); return next }, { replace: true })
  useEffect(() => { if (linked && approval.isError) { toast('That approval link isn’t valid any more. The conversation is open as it is.', 'error'); close() } }, [linked, approval.isError])
  const a = approval.data
  if (!linked || !a) return null
  async function decide(decision: 'approve' | 'decline') {
    setBusy(decision)
    try {
      const decided = await supportInboxApi.decideApproval(conversationId, a!.id, token!, decision, key.current)
      const why = typeof decided.result?.message === 'string' ? decided.result.message : 'Try it from the conversation.'
      toast(decided.state === 'approved' ? `Done: ${decided.label.toLowerCase()}.` : decided.state === 'failed' ? `${decided.label} didn’t go through. ${why}` : 'Declined.', decided.state === 'failed' ? 'error' : 'success')
      void client.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) })
      close()
    } catch (error) { toast(error instanceof ApiError ? error.message : failedText, 'error') }
    finally { setBusy(null) }
  }
  const waiting = a.state === 'proposed', by = a.decidedBy?.name ?? 'Staff', blocked = waiting ? a.preview?.blocked ?? null : null
  const status = a.state === 'expired' ? 'Expired. Act on it from the conversation if it still needs doing.'
    : a.state === 'approved' ? `${by} approved it${a.decidedAt ? ` ${shortDateTime(a.decidedAt)}` : ''}.` : a.state === 'declined' ? `${by} declined it.` : a.state === 'failed' ? `${by} approved it, and it failed.` : null
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }} title={a.label} description={a.effect}
    footer={waiting && canAct ? <><Button variant="ghost" disabled={busy !== null} loading={busy === 'decline'} onClick={() => void decide('decline')}>Decline</Button>
      <Button disabled={busy !== null} onClick={close}>Not now</Button><Button variant="primary" disabled={busy !== null || blocked !== null} loading={busy === 'approve'} onClick={() => void decide('approve')}>Approve</Button></>
      : <Button onClick={close}>Close</Button>}>
    {/* Why: for a held answer, why it was held as stored now ("Held by the output check"), above what would go; the reason it was proposed with once it is gone. */}
    <KeyValues items={[...(a.summary ? [['What', a.summary]] as [string, string][] : []), ...(waiting && a.change ? [['Now', a.change.now], ['After', a.change.after]] as [string, string][] : []), ['Why', waiting && a.preview?.held ? a.preview.held : a.reason], ['Proposed by', a.proposedBy === 'agent' ? 'The support agent' : `${productName}, in the email to staff`],
      [waiting ? 'Expires' : 'State', status ?? shortDateTime(a.expiresAt)], ...(!canAct && waiting ? [['Who can approve', 'Staff with the operator role']] as [string, string][] : [])]} />
    {waiting && a.preview?.text && <blockquote className="sinbox-approval__preview" aria-label="What would be sent">{a.preview.text}</blockquote>}
    {blocked && <p className="sinbox-approval__blocked" role="status">{blocked}</p>}
  </Dialog>
}


// ---------------------------------------------------------------- the thread

/** Who wrote a message, as the chat shows them: the customer's words, the agent's or staff's, a note (staff's, or the
 *  triage agent's on an agent report), or the agent's held answer, a draft until someone decides. */
type Role = 'customer' | 'agent' | 'staff' | 'note' | 'draft'
/** `filedNext`: the next message of its run was filed too, and carries the run's one Filed mark. */
type ChatMessage = { type: 'message'; key: string; m: SupportMessage; role: Role; author: string; first: boolean; last: boolean; filedNext?: boolean }
type ChatRow = { type: 'day'; key: string; label: string } | { type: 'proposal'; key: string; at: string; text: string } | ChatMessage

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10)
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayFormatYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
function dayLabel(iso: string, now = Date.now()) {
  const d = day(iso)
  if (d === day(new Date(now).toISOString())) return 'Today'
  if (d === day(new Date(now - 86_400_000).toISOString())) return 'Yesterday'
  return (new Date(iso).getUTCFullYear() === new Date(now).getUTCFullYear() ? dayFormat : dayFormatYear).format(new Date(iso))
}
const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const Time = ({ at }: { at: string }) => <time className="sinbox-chat__time" dateTime={at} title={when(at)}>{clockFormat.format(new Date(at))}</time>
const initials = (name: string) => name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'
/** Our sender's mark: the agent's bot, a person's initials. */
const Mark = ({ name, agent }: { name: string; agent: boolean }) => <span className="sinbox-mark" data-agent={agent || undefined} aria-hidden="true">{agent ? <Bot size={12} /> : initials(name)}</span>

/** The support platform's replies the customer saw (a fixed reply, a reply asking them to sign in) are part of the
 *  conversation; its records (a choice they made, an email it won't answer yet, an agent report's provenance) are
 *  Activity. */
const toCustomer = (m: SupportMessage) => m.author === 'system' && (m.kind === 'notice' || m.kind === 'waiting')
/** The agent filed again on a conversation that has its ticket (support/src/conversation.ts): a note in the thread, from the AI. */
const ticketNote = (m: SupportMessage) => m.author === 'system' && m.kind === 'ticket_note'
function describe(m: SupportMessage, c: SupportConversation) {
  const note = (m.kind === 'note' && (m.author === 'staff' || m.author === 'agent')) || ticketNote(m)
  // An agent's report that asks something (verification agent, api/src/feedback-triage.ts): its first message is the agent's words, not the person's.
  const author = m.author === 'customer' && m.kind === 'agent_report' ? 'Their agent' : m.author === 'customer' ? c.customer?.name ?? m.email?.from.name ?? (c.channel === 'agent_feedback' ? 'Agent’s report' : 'Customer')
    : m.author === 'agent' ? note ? 'Triage agent' : 'Nightmail AI' : ticketNote(m) ? 'Nightmail AI' : m.author === 'system' ? productName : m.staff?.name ?? m.emailFrom ?? 'Staff'
  const role: Role = note ? 'note' : held(m) ? 'draft' : m.author === 'customer' ? 'customer' : m.author === 'staff' ? 'staff' : 'agent'
  return { author, role }
}
/** A proposal the agent made is waiting while no approval or decline for it came after. */
function waitingProposals(events: SupportEvent[]) {
  const decided = new Set(events.filter(e => e.kind === 'approved' || e.kind === 'declined').map(e => String(e.details.approval ?? '')))
  return events.filter(e => e.kind === 'proposed' && !decided.has(String(e.details.approval ?? '')))
}
const sentenceCase = (text: string) => /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text
const GROUP_MS = 10 * 60_000
/**
 * The thread is what people said and what needs a decision: the messages, oldest first, and a proposal still waiting
 * for approval, by time. Each run of messages from one sender (within ten minutes, nothing between them) shares one
 * name and time; a draft and an email stand alone. Days are separated only when the thread spans more than one.
 * Everything else that happened is Activity, in Details.
 */
function chatRows(detail: SupportDetail): ChatRow[] {
  const c = detail.conversation
  const entries = [
    ...waitingProposals(detail.events).map((event, order) => ({ key: event.id, at: event.at, event, message: undefined, rank: 0, order })),
    ...detail.messages.filter(m => m.author !== 'system' || toCustomer(m) || ticketNote(m)).map(message => ({ key: message.id, at: message.at, event: undefined, message, rank: 1, order: message.seq })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rank - b.rank || a.order - b.order)
  const days = new Set(entries.map(entry => day(entry.at))).size > 1, rows: ChatRow[] = []
  let lastDay = '', previous: ChatMessage | null = null
  for (const entry of entries) {
    if (days && day(entry.at) !== lastDay) { lastDay = day(entry.at); rows.push({ type: 'day', key: `day:${lastDay}`, label: dayLabel(entry.at) }); previous = null }
    if (entry.event) { rows.push({ type: 'proposal', key: entry.key, at: entry.at, text: `Waiting for approval: ${sentenceCase(String(entry.event.details.label ?? 'a change'))}` }); previous = null; continue }
    const m = entry.message!, { author, role } = describe(m, c)
    const row: ChatMessage = { type: 'message', key: entry.key, m, role, author, first: true, last: true }
    if (previous && previous.author === author && previous.role === role && !previous.m.staff?.viaAgent === !m.staff?.viaAgent && role !== 'draft' && !m.email && !previous.m.email && Date.parse(m.at) - Date.parse(previous.m.at) < GROUP_MS) { previous.last = false; row.first = false; previous.filedNext = m.kind === 'filed' && previous.m.kind === 'filed' }
    rows.push(row)
    previous = row
  }
  return rows
}
/** Everything else that happened, oldest first, for Details: events, what the agent checked before it answered, and
 *  the support platform's records. */
function activityOf(detail: SupportDetail) {
  return [
    ...detail.events.map(event => ({ key: event.id, at: event.at, text: eventText(event, detail.conversation), ok: undefined as boolean | undefined })),
    ...detail.messages.flatMap(m => m.tools.map((tool, index) => ({ key: `${m.id}:${index}`, at: m.at, text: tool.label, ok: tool.ok }))),
    ...detail.messages.filter(m => m.author === 'system' && !toCustomer(m) && !ticketNote(m)).map(m => ({ key: m.id, at: m.at, text: m.text, ok: undefined })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * The thread's scroller: it opens at the newest message, and while it is at the bottom it stays there (a message
 * arriving, the reply box growing, the keyboard opening). Scrolled up to read, nothing moves. Staff's own reply or note
 * scrolls down to it. The scroll event a pin itself causes arrives a frame later, after the box may have grown again, so
 * it never counts as scrolling away.
 */
function useStickToBottom(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, count: number, mine: boolean) {
  const atBottom = useRef(true), pinned = useRef(-1)
  const pin = () => { const el = scroller.current; if (!el) return; el.scrollTop = el.scrollHeight; pinned.current = el.scrollTop; atBottom.current = true }
  useLayoutEffect(pin, [])
  useEffect(() => {
    const el = scroller.current, inner = content.current
    if (!el || !inner) return
    const onScroll = () => { atBottom.current = el.scrollTop === pinned.current || el.scrollHeight - el.scrollTop - el.clientHeight < 32 }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(() => { if (atBottom.current) pin() })
    observer.observe(el); observer.observe(inner)
    return () => { el.removeEventListener('scroll', onScroll); observer.disconnect() }
  }, [])
  useLayoutEffect(() => { if (atBottom.current || mine) pin() }, [count])
}

function Thread({ detail, canAct, actions, composer, onConfirm }: { detail: SupportDetail; canAct: boolean; actions: Actions; composer: RefObject<ComposerHandle | null>; onConfirm: (confirming: Confirming) => void }) {
  const c = detail.conversation, user = useSession()?.identity?.id ?? ''
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const rows = chatRows(detail), last = rows.at(-1)
  useStickToBottom(scroller, content, rows.length, last?.type === 'message' && last.m.id.startsWith('pending:'))
  // Edit and send: the held answer goes into the reply box, marked as that draft, so sending it decides the draft.
  // A fresh reply starts from an empty box: nothing of the held answer is carried over.
  const edit = (m: SupportMessage, fresh: boolean) => { updateInboxDraft(user, c.id, () => ({ text: fresh ? '' : m.text.trim(), key: crypto.randomUUID(), mode: 'reply', draftOf: m.id, failed: null })); composer.current?.focus('reply') }
  return <>
    <div className="sinbox-chat__scroll" ref={scroller}>
      <div className="sinbox-chat__column sinbox-chat__thread" ref={content}>
        {c.channel === 'email' && c.subject && <p className="sinbox-chat__subject">{c.subject}</p>}
        {detail.earlierMessages > 0 && <p className="sinbox-chat__event">{number(detail.earlierMessages)} earlier {detail.earlierMessages === 1 ? 'message isn’t' : 'messages aren’t'} shown.</p>}
        {rows.map(row => row.type === 'day' ? <p key={row.key} className="sinbox-chat__day">{row.label}</p>
          : row.type === 'proposal' ? <p key={row.key} className="sinbox-chat__proposal"><span aria-hidden="true" />{row.text} · <Time at={row.at} /></p>
          : <Message key={row.key} row={row} c={c} canAct={canAct} actions={actions} onEdit={edit} />)}
        {!rows.some(row => row.type === 'message') && <p className="sinbox-chat__empty">No messages yet</p>}
      </div>
    </div>
    <footer className="sinbox-chat__dock sinbox-chat__column">
      <DockStatus detail={detail} canAct={canAct} actions={actions} onConfirm={onConfirm} />
      {canAct && <Composer ref={composer} detail={detail} actions={actions} />}
    </footer>
  </>
}

/** One message: its sender and time (the first of a run), then the customer's words in a bubble, ours as text under the
 *  mark, a note or a held answer as a card. Delivery shows only when it isn't plain: Queued, or Not sent; customer
 *  messages filed while the chat couldn't answer are marked Filed, once under the last of a run. */
function Message({ row, c, canAct, actions, onEdit }: { row: ChatMessage; c: SupportConversation; canAct: boolean; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const { m, role } = row, customer = role === 'customer', pending = m.id.startsWith('pending:')
  const queued = m.author === 'staff' && m.kind !== 'note' && (m.delivery === 'queued' || pending)
  // A message the support chat couldn't take, filed by the dashboard (kind filed), one mark for a run of them: why and
  // when are in Activity.
  const filed = customer && m.kind === 'filed' && !row.filedNext
  return <div className="sinbox-msg" data-role={role} data-first={row.first || undefined} data-last={row.last || undefined} data-email={m.email ? '' : undefined} data-pending={pending || undefined}>
    {row.first && <p className="sinbox-msg__meta">
      {!customer && <Mark name={row.author} agent={m.author === 'agent'} />}
      <span className="sinbox-msg__author">{row.author}{m.staff?.viaAgent && ' · via agent'}</span>
      {role === 'note' && <span className="sinbox-msg__note" title="Only staff see notes"><Lock size={12} aria-hidden="true" />Note<span className="sr-only">: only staff see it</span></span>}
      <Time at={m.at} />
    </p>}
    {customer ? <div className="sinbox-msg__bubble sinbox-raised"><Body m={m} c={c} /></div>
      : role === 'draft' ? <div className="sinbox-msg__card sinbox-raised" data-draft=""><DraftLabel m={m} /><Body m={m} c={c} /><DraftFoot m={m} c={c} canAct={canAct} actions={actions} onEdit={onEdit} /></div>
      : role === 'note' ? <div className="sinbox-msg__card sinbox-raised"><Body m={m} c={c} /></div>
      : <div className="sinbox-msg__prose"><Body m={m} c={c} /></div>}
    {(m.delivery === 'failed' || queued || filed) && <div className="sinbox-msg__below">
      {m.delivery === 'failed' ? <span className="sinbox-delivery" data-state="failed"><AlertCircle size={12} aria-hidden="true" />Not sent</span>
        : queued ? <span className="sinbox-delivery"><Clock size={12} aria-hidden="true" />Queued</span>
        : <span className="sinbox-delivery" title="Filed as a ticket: the chat couldn’t answer"><Ticket size={12} aria-hidden="true" />Filed</span>}
    </div>}
  </div>
}
/** What a message says: a customer email as it arrived, the agent's Markdown, or the words as written, then its screenshots. */
function Body({ m, c }: { m: SupportMessage; c: SupportConversation }) {
  return <>
    {m.email ? <EmailBody conversationId={c.id} email={m.email} subject={c.subject} />
      : m.author === 'agent' && m.kind !== 'note' ? <div className="sinbox-text"><Markdown text={m.text} /></div> : <div className="sinbox-plain">{m.text}</div>}
    {m.files.length > 0 && !m.email && <Files conversationId={c.id} files={m.files} />}
  </>
}
/** A held answer's label: Draft, not sent, until someone decides, then who decided what. Why it was held is the
 *  card's tooltip; only a reason that leaves just a fresh reply is spelled out, since it takes Send away. */
const DraftLabel = ({ m }: { m: SupportMessage }) => <p className="sinbox-draft__label" data-decided={m.draft ? '' : undefined} title={!m.draft && m.heldReason ? heldWhy[m.heldReason] : m.draft ? when(m.draft.at) : undefined}>
  <span aria-hidden="true" />{m.draft ? `${decidedText[m.draft.outcome]} ${m.draft.by.name ?? 'staff'}` : 'Draft, not sent'}</p>
function DraftFoot({ m, c, canAct, actions, onEdit }: { m: SupportMessage; c: SupportConversation; canAct: boolean; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const fresh = !m.draft && m.heldReason ? freshOnly[m.heldReason] : undefined
  return <>
    {fresh && <p className="sinbox-held">{fresh}</p>}
    {!m.draft && canAct && c.status !== 'closed' && !m.id.startsWith('pending:') && <DraftActions m={m} c={c} actions={actions} onEdit={onEdit} />}
  </>
}
const heldWhy: Record<HeldReason, string> = {
  paused: 'Held: staff took over after the agent wrote it.', gate: 'Held by the output check.', access: 'Held: the customer’s access changed before it went out.',
  closed: 'Held: the conversation ended first.', earlier: 'Held: an earlier version of the agent wrote it.',
}
const held = (m: SupportMessage) => m.author === 'agent' && (m.delivery === 'held' || m.kind === 'held')
const size = (bytes: number | null) => bytes === null ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const decidedText = { sent: 'Sent as written by', edited: 'Edited and sent by', replaced: 'Replaced with a fresh reply by', discarded: 'Discarded by' }
/** A held answer's choices: send it as the agent wrote it, edit it in the reply box first, or discard it (in place, asked
 *  once more). One that can't be sent offers only a fresh reply, from an empty reply box, or discarding it. */
function DraftActions({ m, c, actions, onEdit }: { m: SupportMessage; c: SupportConversation; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const [confirming, setConfirming] = useState(false)
  const fresh = m.heldReason ? freshOnly[m.heldReason] : undefined
  return <div className="sinbox-draft" onKeyDown={event => { if (event.key === 'Escape' && confirming) { event.stopPropagation(); setConfirming(false) } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirming(false) }}>
    <span className="cluster sinbox-draft__actions">
      {fresh ? <Button size="sm" onClick={() => { setConfirming(false); onEdit(m, true) }}>Write a fresh reply</Button> : <>
        <Button size="sm" onClick={() => { setConfirming(false); void actions.sendDraft(c, m.id, undefined, crypto.randomUUID()).catch(() => {}) }}>Send as written</Button>
        <Button size="sm" onClick={() => { setConfirming(false); onEdit(m, false) }}>Edit and send</Button></>}
      <Button size="sm" variant={confirming ? 'danger' : 'ghost'} onClick={() => { if (!confirming) setConfirming(true); else { setConfirming(false); void actions.discardDraft(c, m.id) } }}>{confirming ? 'Discard it' : 'Discard'}</Button>
    </span>
    {confirming && <span className="sinbox-draft__warn" role="status">It’s never sent. The customer isn’t told.</span>}
  </div>
}

/** A customer email as it arrived: its reply first, the quoted history on request, its formatting (sandboxed, remote images off until asked) and the full text when it was longer, and its attachments. */
function EmailBody({ conversationId, email, subject }: { conversationId: string; email: SupportEmail; subject: string | null }) {
  const [quoted, setQuoted] = useState(false), [formatted, setFormatted] = useState(false), [full, setFull] = useState(false)
  const loaded = useQuery({ queryKey: [...inboxKeys.detail(conversationId), 'email', email.id], queryFn: ({ signal }) => supportInboxApi.email(conversationId, email.id, signal), enabled: formatted || full, staleTime: Infinity })
  const toast = useToast()
  const text = full && loaded.data ? loaded.data.text : email.text, reply = (full && loaded.data ? loaded.data.replyText : email.replyText).trim() || text
  const hasQuote = reply.trim() !== text.trim()
  const html = formatted ? loaded.data?.html ?? null : null
  async function open(attachmentId: string) {
    try { window.open((await supportInboxApi.emailAttachment(conversationId, email.id, attachmentId)).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof ApiError ? error.message : 'The attachment couldn’t be opened.', 'error') }
  }
  return <div className="sinbox-email">
    {email.subject && email.subject !== subject && <p className="sinbox-email__subject">{email.subject}</p>}
    {html ? <ReceivedEmailPreview html={html} tooComplex={loaded.data?.htmlTooComplex} title={`Email from ${email.from.name ?? email.from.address}`} className="sinbox-email__html" />
      : <div className="sinbox-plain">{(quoted ? text : reply) || <span className="sinbox-faint">(no text)</span>}</div>}
    {(hasQuote || email.hasHtml || email.textTruncated) && <div className="cluster sinbox-email__toggles">
      {hasQuote && !html && <Button variant="ghost" size="sm" onClick={() => setQuoted(value => !value)}>{quoted ? 'Hide quoted text' : 'Show quoted text'}</Button>}
      {email.hasHtml && <Button variant="ghost" size="sm" loading={formatted && loaded.isFetching && !loaded.data} onClick={() => setFormatted(value => !value)}>{formatted ? 'Show plain text' : 'Show formatted'}</Button>}
      {email.textTruncated && !(full && loaded.data) && <Button variant="ghost" size="sm" loading={full && loaded.isFetching} onClick={() => { setFull(true); setQuoted(true) }}>Show the full message</Button>}
    </div>}
    {email.attachments.length > 0 && <ul className="sinbox-files" aria-label="Attachments">{email.attachments.map(file => <li key={file.id}>
      <button type="button" disabled={!file.available} title={file.available ? `Open ${file.filename}` : 'Not scanned clean, so it can’t be opened'} onClick={() => void open(file.id)}>
        <Paperclip size={14} aria-hidden="true" /><span className="sinbox-files__name">{file.filename}</span><span className="sinbox-files__size">{size(file.size)}</span></button>
    </li>)}</ul>}
  </div>
}
/** A chat's screenshots: opened from the support service on request, never loaded into the page. */
function Files({ conversationId, files }: { conversationId: string; files: SupportMessage['files'] }) {
  const toast = useToast()
  async function open(attachmentId: string) {
    try { window.open((await supportInboxApi.file(conversationId, attachmentId)).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof ApiError ? error.message : 'The screenshot couldn’t be opened.', 'error') }
  }
  return <ul className="sinbox-files" aria-label="Screenshots">{files.map(file => <li key={file.id}>
    <button type="button" title={`Open ${file.name ?? 'the screenshot'}`} onClick={() => void open(file.id)}><ImageIcon size={14} aria-hidden="true" />
      <span className="sinbox-files__name">{file.name ?? 'Screenshot'}</span><span className="sinbox-files__size">{size(file.size)}</span></button>
  </li>)}</ul>
}

// What happened besides the messages, in words, for Activity.
/** A safe action the agent took on its own (api/src/support-actions.ts), in words, with what it acted on. */
const actionWords: Record<string, string> = { verify_domain: 'The agent re-checked DNS for', recheck_receiving_host: 'The agent re-checked the MX of', resend_forward: 'The agent resent the forward confirmation for' }
function eventText(e: SupportEvent, c: SupportConversation): string {
  const who = e.by ? e.by.name ?? 'Staff' : null, d = e.details as Record<string, string | boolean | null | undefined>
  switch (e.kind) {
    case 'opened': return c.channel === 'agent_feedback' || c.verification === 'agent' ? 'Filed by an agent' : `Opened by ${c.channel === 'email' ? 'email' : 'chat'}`
    // reason chat_unavailable: the dashboard filed a message the support chat couldn't take (api/src/support-conversations.ts fileChatTicket).
    case 'ticket': return d.by === 'nightmail' ? `${d.reason === 'chat_unavailable' ? 'Filed: the chat couldn’t answer' : 'Ticket opened: this needs a person'}${d.severity ? ` · ${d.severity}` : ''}` : `The agent filed a ticket${d.type ? ` · ${label(String(d.type))}` : ''}${d.severity ? ` · ${d.severity}` : ''}`
    case 'priority': return `Priority ${d.from ?? '—'} → ${d.to ?? '—'}`
    case 'paused': return d.by === 'ticket' ? 'Handed to you: the agent stopped for the ticket' : d.reply ? `${who ?? 'Staff'} replied and took over from the agent` : `${who ?? 'Staff'} paused the agent`
    case 'resumed': return `${who ?? 'Staff'} handed back to the agent`
    case 'resolved': return `${who ?? 'Staff'} resolved the ticket`
    case 'done': return `${who ?? 'Staff'} marked it done`
    case 'undone': return `${who ?? 'Staff'} undid Done`
    case 'closed': return 'Conversation closed'
    case 'approved': return d.failed ? `${who ?? 'Staff'} approved ${approvalWords(d)}, and it failed` : `${who ?? 'Staff'} approved ${approvalWords(d)}`
    case 'declined': return `${who ?? 'Staff'} declined ${approvalWords(d)}`
    case 'action': return `${actionWords[String(d.kind)] ?? 'The agent acted on'} ${d.host ?? d.domain ?? d.endpoint ?? 'its target'}`
    case 'proposed': return `The agent asked staff to approve: ${d.label ?? 'a change'}${d.summary ? ` · ${d.summary}` : ''}`
  }
}
const approvalWords = (d: Record<string, unknown>) => d.kind === 'retry_work' ? 'retrying the stuck work' : typeof d.label === 'string' ? `“${d.label}”` : 'a proposed action'

/** Over the reply box, at most one short line, and only when there is something to know or do, most pressing first:
 *  replies off, the agent's work stuck (Retry), a customer who got no reply, the AI paused (Resume). */
function DockStatus({ detail, canAct, actions, onConfirm }: { detail: SupportDetail; canAct: boolean; actions: Actions; onConfirm: (confirming: Confirming) => void }) {
  const c = detail.conversation, feedback = c.channel === 'agent_feedback', open = c.status !== 'closed' && !feedback
  const line = open && canAct && !detail.replyAvailable ? { tone: 'warning', text: 'Replies are off: the support service is offline' }
    : !feedback && c.blockedWork > 0 ? { tone: 'warning', text: 'The AI’s work here is stuck', action: canAct && <Button size="sm" variant="ghost" onClick={() => void actions.wake(c)}>Retry</Button> }
    : c.needsYou?.reasons.includes('no_reply') ? { tone: 'danger', text: 'No reply sent' }
    : open && c.agentState === 'paused' ? { tone: 'muted', text: 'AI paused', action: canAct && <Button size="sm" variant="ghost" onClick={() => onConfirm({ action: 'resume', conversation: c })}>Resume</Button> }
    : null
  if (!line) return null
  return <p className="sinbox-chat__status" data-tone={line.tone}>{line.tone === 'muted' ? <Hand size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}<span>{line.text}</span>{line.action}</p>
}

export type ComposerHandle = { focus: (mode?: ComposeMode) => void }
type ComposeMode = 'reply' | 'note'
// The staff reply, or an internal note, always ready: typing changes nothing; sending a reply pauses the agent if it is
// active (Send's tooltip says so, and who gets it). A note changes nothing for the customer or the agent; in note mode
// the box is tinted and marked Note and its button says Add note, so a key never sends a note as a reply. Enter sends
// (isSendKey: not on a touch keyboard, not mid-composition), never an empty box or while the last one is still sending.
// Nothing sits under the box and nothing in it changes height on focus, so the row with Reply, Note and Send stays where
// the finger is; the field grows upward with what is typed, then scrolls. What is typed, and a reply that failed with
// why, stay with the conversation until sent or discarded, wherever staff go meanwhile.
const Composer = forwardRef<ComposerHandle, { detail: SupportDetail; actions: Actions }>(function Composer({ detail, actions }, ref) {
  const c = detail.conversation, identity = useSession()?.identity, user = identity?.id ?? ''
  const draft = useSyncExternalStore(subscribeInboxDrafts, () => inboxDraft(user, c.id)), text = draft?.text ?? ''
  // Closed, or agent feedback (api/src/feedback.ts, filed by an agent's credential): nobody to reply to, so notes only.
  // A reply being written when the conversation closed is stranded: it stays a reply that can't be sent (Send and Enter
  // do nothing) until staff choose to keep it as a note. The mode never changes by itself, in either direction.
  const feedback = c.channel === 'agent_feedback', closed = c.status === 'closed' || feedback
  const stranded = closed && Boolean(text.trim()) && draft?.mode !== 'note'
  const mode: ComposeMode = stranded ? 'reply' : closed ? 'note' : draft?.mode ?? 'reply'
  // One send at a time, decided at once: two Enters in the same instant would otherwise both start (the draft's own
  // sending flag only lands with the next render) and the second, refused for its reused key, would read as Not sent.
  const field = useRef<HTMLTextAreaElement>(null), composing = useRef(false), inFlight = useRef(false), touch = useTouch()
  const setMode = (next: ComposeMode) => updateInboxDraft(user, c.id, () => ({ mode: next }))
  const focus = (next: ComposeMode = 'reply') => { if (next !== mode && !closed) setMode(next); requestAnimationFrame(() => field.current?.focus()) }
  useImperativeHandle(ref, () => ({ focus }), [mode, closed])
  // The field is as tall as what is typed (the stylesheet caps it, then it scrolls).
  useLayoutEffect(() => { const el = field.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }, [text])
  const handling = c.agentState === 'active'
  const note = mode === 'note', offline = !note && !detail.replyAvailable
  function send(event?: FormEvent) {
    event?.preventDefault()
    const body = text.trim()
    if (!body || offline || stranded || !draft || draft.sending || inFlight.current) return
    inFlight.current = true
    const sent = { text: body, key: draft.key }
    updateInboxDraft(user, c.id, () => ({ text: '', key: crypto.randomUUID(), failed: null, sending: sent }))
    // Sent: the keys are the inbox's again (e marks it done, j moves on).
    field.current?.blur()
    // A failure puts the text back in this conversation's box (before anything typed since), with its own key.
    const draftOf = !note ? draft.draftOf ?? null : null
    if (draftOf) updateInboxDraft(user, c.id, () => ({ draftOf: null }))
    ;(note ? actions.note(c, body, sent.key) : draftOf ? actions.sendDraft(c, draftOf, body, sent.key) : actions.reply(c, body, sent.key)).then(() => updateInboxDraft(user, c.id, () => ({ sending: null })),
      error => updateInboxDraft(user, c.id, now => ({ sending: null, mode, draftOf, failed: error instanceof ApiError ? error.message : failedText,
        ...now.text ? { text: `${sent.text}\n\n${now.text}`, key: crypto.randomUUID() } : { text: sent.text, key: sent.key } })))
      .finally(() => { inFlight.current = false })
  }
  const name = c.customer?.name ?? 'the customer', target = detail.replyTarget
  const editing = !note && draft?.draftOf ? detail.messages.find(m => m.id === draft.draftOf && !m.draft) : undefined
  const keys = touch ? '' : ` · Enter ${note ? 'adds it' : 'sends'}, Shift+Enter makes a new line`
  const title = note ? `Only staff see notes${keys}` : `To ${name}${c.channel === 'email' ? ' by email' : ' in their chat'}${c.channel === 'email' && !target.verified ? ' (their email didn’t pass DMARC, so it may not arrive)' : ''}${handling ? '. Sending pauses the AI' : ''}${keys}`
  return <form className="sinbox-composer" data-mode={mode} data-unavailable={offline || stranded || undefined} onSubmit={send}>
    {stranded && <p className="sinbox-composer__stranded" role="alert"><AlertCircle size={14} aria-hidden="true" /><span>Closed: this reply can’t be sent</span>
      <Button size="sm" variant="ghost" onClick={() => { updateInboxDraft(user, c.id, () => ({ mode: 'note', draftOf: null })); requestAnimationFrame(() => field.current?.focus()) }}>Keep as a note</Button></p>}
    <div className="sinbox-composer__box sinbox-raised">
      {draft?.failed && <p className="sinbox-composer__failed" role="alert">Not sent: {draft.failed}</p>}
      {editing && <p className="sinbox-composer__editing">{editing.heldReason && freshOnly[editing.heldReason] ? 'A fresh reply in place of the AI’s draft' : 'Editing the AI’s draft'} · <button type="button" onClick={() => updateInboxDraft(user, c.id, () => ({ draftOf: null }))}>Keep it separate</button></p>}
      <Textarea ref={field} aria-label={note ? 'Internal note' : 'Reply'} placeholder={note ? (feedback ? 'Add a note about this report' : 'Add a note for staff') : `Reply to ${name}`} value={text} maxLength={8000} disabled={offline} rows={1}
        onChange={event => { const value = event.target.value; updateInboxDraft(user, c.id, () => ({ text: value, key: crypto.randomUUID(), mode })) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => { if (!composing.current && isSendKey(event, touch)) { event.preventDefault(); send() } else if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur() } }} />
      <div className="sinbox-composer__bar">
        {stranded ? <span className="sinbox-composer__mark" data-reply="">Reply</span>
          : closed ? <span className="sinbox-composer__mark" title="Only staff see notes"><Lock size={12} aria-hidden="true" />Note</span>
          : <div className="sinbox-composer__modes" role="group" aria-label="Write">
            <button type="button" aria-pressed={!note} onClick={() => focus('reply')}>Reply</button>
            <button type="button" aria-pressed={note} title="Only staff see notes" onClick={() => focus('note')}>{note && <Lock size={12} aria-hidden="true" />}Note</button>
          </div>}
        <span className="cluster sinbox-composer__buttons">{draft?.failed && <Button variant="ghost" onClick={() => updateInboxDraft(user, c.id, () => null)}>Discard</Button>}
          <Button type="submit" variant="primary" title={title} disabled={!text.trim() || offline || stranded || Boolean(draft?.sending)}>{note ? 'Add note' : 'Send'}</Button></span>
      </div>
    </div>
  </form>
})

// ---------------------------------------------------------------- details

/** What happened besides what was said, oldest first, each with its time: events, what the agent checked before it
 *  answered (with whether it worked), and the support platform's records (an agent report's provenance among them). */
function Activity({ detail }: { detail: SupportDetail }) {
  const items = activityOf(detail)
  if (!items.length) return null
  return <section className="sinbox-activity"><h3 className="ui-label">Activity</h3>
    <ol>{items.map(item => <li key={item.key}>
      <span className="sinbox-activity__text">{item.ok !== undefined && (item.ok ? <Check size={12} aria-label="Done" /> : <X size={12} aria-label="Failed" />)}{item.text}</span>
      <time dateTime={item.at} title={when(item.at)}>{shortDateTime(item.at)}</time>
    </li>)}</ol>
  </section>
}

/** The agent's ticket brief, folded: its own summary, in Details and never in place of the messages. */
function AiSummary({ brief, subject }: { brief: SupportBrief; subject: string }) {
  return <details className="sinbox-summary">
    <summary><Bot size={14} aria-hidden="true" /><span className="sinbox-summary__label">AI summary</span>{brief.title !== subject && <span className="sinbox-summary__title">{brief.title}</span>}<ChevronRight size={14} aria-hidden="true" className="sinbox-summary__chevron" /></summary>
    <dl className="sinbox-summary__body">
      <div><dt>Summary</dt><dd>{brief.summary}</dd></div>
      {brief.ask && <div><dt>What they asked</dt><dd>{brief.ask}</dd></div>}
      {brief.tried && brief.tried.length > 0 && <div><dt>What it checked</dt><dd><ul className="sinbox-summary__tried">{brief.tried.map((item, index) => <li key={`${item.tool}:${index}`}>{item.tool ? <><code>{item.tool}</code>{item.finding ? ` — ${item.finding}` : ''}</> : item.finding}</li>)}</ul></dd></div>}
      {brief.recommendation && <div><dt>Recommendation</dt><dd>{brief.recommendation}</dd></div>}
    </dl>
    <p className="sinbox-summary__note">Written by the agent when it filed the ticket. The conversation is what was actually said.</p>
  </details>
}


// A ticket Nightmail opened because the conversation needed a person (api/src/support-staff-mail.ts) is type staff.
const ticketText = (c: SupportConversation) => !c.ticket ? null : `${[c.ticket.severity, c.ticket.type && (c.ticket.type === 'staff' ? 'needs a person' : label(c.ticket.type))].filter(Boolean).join(' ') || 'Ticket'}${c.ticket.resolvedAt ? ' · resolved' : ''}`
/** One line for how the person was verified (keeps read-only and unverified states unmistakable without repeating Proof, Access and DMARC). */
function verifiedRow(c: SupportDetail['conversation'], hasUser: boolean): ReactNode {
  if (c.verification === 'none') return <StatusBadge status={c.mode === 'pending_signin' ? 'Waiting for sign-in' : 'Not verified'} tone="warning" />
  if (c.verification === 'handoff') return c.mode === 'non_member' ? 'Signed in (chat) · no workspace' : 'Signed in (chat)'
  if (c.verification === 'signin') return 'Signed in to claim · read only'
  if (c.verification === 'agent') return 'Asked by their agent · answered by email · read only'
  if (c.verification === 'dmarc') {
    const dkim = c.evidence.dkimAligned === false ? ', DKIM unaligned' : ''
    return hasUser ? `Email (DMARC${dkim}) · read only` : `Email (DMARC${dkim}) · no account`
  }
  return 'Workspace credential'
}
// The customer panel (Signal Log): each section a small caps label with its rule over muted keys and mono values, or a short list.
const Label = ({ children }: { children: ReactNode }) => <h3 className="ui-label">{children}</h3>
function CustomerPanel({ detail }: { detail: SupportDetail }) {
  const { conversation: c, customer } = detail, user = customer.user, evidence = c.evidence
  const others = customer.conversations
  const target = detail.replyTarget
  const replies: ReactNode = c.channel === 'email' ? target.address ? <span className="sinbox-address"><PrivateAddress value={target.address} />{!target.verified && <StatusBadge status="Didn’t pass DMARC" tone="warning" />}</span> : '—'
    : target.address ? <>Their chat, or <PrivateAddress value={target.address} /> once it’s closed</> : 'Their chat'
  const extra: [string, ReactNode][] = [
    ...c.channel !== 'agent_feedback' && c.status !== 'closed' ? [['Replies go to', replies] as [string, ReactNode]] : [],
    ...c.ticket ? [['Ticket', <span title={c.ticket.id}>{ticketText(c)}</span>] as [string, ReactNode]] : [],
    ...c.page ? [['Opened from', c.page] as [string, ReactNode]] : [],
  ]
  const customerRows: [string, ReactNode][] = user ? [
    ...user.name ? [['Name', user.name] as [string, ReactNode]] : [],
    ...user.email ? [['Email', <span className="sinbox-address"><PrivateAddress value={user.email} />{!user.emailVerified && <StatusBadge status="Unverified" tone="warning" />}</span>] as [string, ReactNode]] : [],
    ['Verified', verifiedRow(c, true)],
    ...extra,
  ] : [
    ['Sender', c.sender ? <span className="sinbox-address"><PrivateAddress value={c.sender} /></span> : '—'],
    ['Verified', verifiedRow(c, false)],
    ...extra,
  ]
  return <div className="sinbox-panel__body">
    {c.channel === 'agent_feedback' ? <section><Label>Filed by</Label>
      <KeyValues className="sinbox-kv" items={[
        ['Workspace', c.workspace ? <Link to={`/operator/workspaces/${encodeURIComponent(c.workspace.id)}`} title={c.workspace.id}>{c.workspace.name}</Link> : '—'],
        ['Credential', evidence.filedBy ? <span title={evidence.credentialId ?? undefined}>{evidence.filedBy}</span> : '—'],
        ...extra,
      ]} />
    </section> : <section><Label>Customer</Label>
      <KeyValues className="sinbox-kv" items={customerRows} />
    </section>}
    {user && customer.workspaces.length > 0 && <section><Label>Workspaces</Label>
      <ul className="sinbox-list">{customer.workspaces.map(w => <li key={w.id}>
        <Link to={`/operator/workspaces/${encodeURIComponent(w.id)}`} className="sinbox-list__main">{w.name}</Link>
        <span className="sinbox-list__meta">{[w.role, w.standing && w.standing !== 'ok' ? w.standing : null, w.sending?.paused ? 'paused' : null, w.inScope ? 'in scope' : null].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
    </section>}
    {user && customer.notes.length > 0 && <section><Label>Notes</Label>
      <ul className="sinbox-notes">{customer.notes.map(n => <li key={n.id}><p>{n.text}</p><span className="sinbox-list__meta">{n.author} · {when(n.createdAt)}</span></li>)}</ul>
    </section>}
    {others.length > 0 && <section><Label>Other conversations</Label>
      <ul className="sinbox-list">{others.map(o => <li key={o.id}>
        <Link to={`/support/${o.id}`} className="sinbox-list__main">{o.subject ?? channelLabels[o.channel as Channel] ?? 'Chat'}</Link>
        <span className="sinbox-list__meta">{[o.status, o.ticket?.severity, ago(o.lastMessageAt ?? o.createdAt)].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
    </section>}
  </div>
}
