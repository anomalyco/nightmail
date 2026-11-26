import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Archive, Bot, Check, CheckCheck, ChevronRight, CircleCheck, CircleX, Flag, Hand, Image as ImageIcon, Inbox, Info, Mail, MessageSquare, Paperclip, Ticket, Undo2, X } from 'lucide-react'
import { Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, KeyValues, PageHeader, StatusBadge, StatusDot, Textarea, useToast, type Column, type MenuItem, type Tone } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { ReceivedEmailPreview } from '../../components/EmailPreview'
import { productName } from '../../../../api/src/brand'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { detailQuery, inboxDraft, inboxKeys, listQuery, patchConversation, prefetchConversation, snapshotInbox, subscribeInboxDrafts, supportInboxApi, updateInboxDraft, channelLabels, type Channel, type InboxView, type HeldReason, type SupportAction, type SupportBrief, type SupportConversation, type SupportDetail, type SupportEmail, type SupportEvent, type SupportEventKind, type SupportInboxPage, type SupportMessage } from '../../data/support-inbox'
import { ago, label, number, shortDateTime } from '../../lib/format'
import { useSearchDraft } from '../../lib/pagination'
import { usePhone } from '../../lib/media'
import { Markdown } from '../support/markdown'
import { ActionsTrigger, StaffOnly } from '../operator/skeletons'
import { channelOf, ConversationActions, ConversationBodySkeleton, InboxBody, InboxTabs, InboxToolbar, inboxColumnDefs, SupportConversationSkeleton, SupportInboxSkeleton, triageOf, viewOf } from './skeletons'

// The support inbox (lazy, /support): Nightmail staff triage every support conversation. Needs you (the default) is
// what only a person can move forward, most urgent first (api/src/support-inbox.ts); AI handling is what the agent owes
// the next message in; Waiting on customer has been answered; Done and All. Each row previews the last message itself.
// A conversation is one timeline: every message in full (a customer's email as it arrived), what the agent sent or held,
// staff replies and notes, and what happened besides. Keyboard first: j and k move, Enter or o opens, Esc goes back,
// r replies, n adds a note, e marks done (and moves on; Undo on its toast), h hands back, u marks read or unread,
// / searches, ? lists the keys. In
// the list the selected row and the focused one are always the same, so a key acts on what is on screen. Lists and
// conversations come from the query cache at once and refresh behind it; a conversation is read ahead on hover, on
// selection and next to the open one, so moving between them never waits. Changes show before the API answers.

// What the inbox keeps between its pages in this visit: the list a conversation was opened from (j and k follow it) and
// the row selected in each view. Unsent replies are kept per conversation in this tab (data/support-inbox.ts).
const memory: { list: { view: InboxView; q: string; channel: Channel | '' }; selected: Partial<Record<InboxView, string>> } = { list: { view: 'needs_you', q: '', channel: '' }, selected: {} }
const CONVERSATION = /^conv_[a-z2-7]{26}$/
const listPath = () => { const params = new URLSearchParams(); if (memory.list.view !== 'needs_you') params.set('view', memory.list.view); if (memory.list.q) params.set('q', memory.list.q); if (memory.list.channel) params.set('channel', memory.list.channel); const query = params.toString(); return query ? `/support?${query}` : '/support' }
const useRole = () => useSession()?.identity?.operator ?? null
const def = (key: string) => inboxColumnDefs.find(column => column.key === key)!
const titleOf = (c: SupportConversation) => c.subject ?? c.firstLine ?? 'No messages yet'
const when = (value: string | null | undefined) => value ? `${shortDateTime(value)} UTC` : '—'
const lastActivity = (c: SupportConversation) => c.lastMessageAt ?? c.createdAt
const flatten = (pages: SupportInboxPage[] | undefined) => pages?.flatMap(page => page.data) ?? []
function cached(client: QueryClient, id: string) {
  for (const [, data] of client.getQueriesData<{ pages: SupportInboxPage[] }>({ queryKey: inboxKeys.lists })) { const found = flatten(data?.pages).find(c => c.id === id); if (found) return found }
  return client.getQueryData<SupportDetail>(inboxKeys.detail(id))?.conversation
}

// ---------------------------------------------------------------- keys

const typing = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
/** The inbox's single-key shortcuts: never while typing, inside a dialog or menu, or with a modifier. Arrows move like j and k. */
function useShortcuts(keys: Record<string, () => void>, enabled = true) {
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing || typing(event.target)) return
      if (document.querySelector('[role=dialog][data-state=open], [role=alertdialog], [role=menu]')) return
      const key = event.key === 'ArrowDown' ? 'j' : event.key === 'ArrowUp' ? 'k' : event.key
      // Enter on a focused link or button is that control's own (a view's tab only changes the view, so Enter opens).
      if (key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('a, button:not([role=tab])')) return
      const run = latest.current[key]
      if (!run) return
      event.preventDefault()
      run()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}
const shortcuts: [string[], string][] = [[['j', 'k'], 'Next or previous conversation'], [['Enter', 'o'], 'Open'], [['Esc'], 'Back to the list'], [['r'], 'Reply'], [['n'], 'Add an internal note'], [['e'], 'Mark done and move on (Undo on its toast)'],
  [['h'], 'Hand back to the agent'], [['u'], 'Mark read or unread'], [['/'], 'Search'], [['⌘', '↵'], 'Send a reply'], [['?'], 'These shortcuts']]
function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title="Keyboard shortcuts" className="sinbox-shortcuts">
    <dl className="sinbox-keys">{shortcuts.map(([keys, text]) => <div key={text}><dt>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dt><dd>{text}</dd></div>)}</dl>
  </Dialog>
}

// ---------------------------------------------------------------- changes

type Confirming = { action: 'pause' | 'resume' | 'resolve'; conversation: SupportConversation }
const confirmCopy: Record<Confirming['action'], { title: string; description: string; confirm: string; done: string }> = {
  pause: { title: 'Pause the agent?', description: 'It stops answering this customer until someone hands back.', confirm: 'Pause agent', done: 'Agent paused' },
  resume: { title: 'Hand back to the agent?', description: 'It answers the customer’s next message.', confirm: 'Hand back', done: 'Handed back to the agent' },
  resolve: { title: 'Resolve this ticket?', description: 'The customer isn’t told.', confirm: 'Resolve ticket', done: 'Ticket resolved' },
}
const failedText = 'Couldn’t complete the action. Try again.'
/** Every change the inbox makes: shown at once in every list and the conversation, put back if the API refuses it, then read again. */
function useInboxActions() {
  const client = useQueryClient(), toast = useToast(), identity = useSession()?.identity
  const me = { userId: identity?.id ?? '', name: identity?.name ?? null }
  // reread: false for a change the prediction already shows exactly (a read marker), so nothing is fetched again.
  async function run<T>(c: SupportConversation, predict: (c: SupportConversation) => SupportConversation, call: () => Promise<T>, { done, quiet = false, after, reread = true }: { done?: string; quiet?: boolean; after?: (result: T) => void; reread?: boolean } = {}) {
    const restore = snapshotInbox(client)
    // A read in flight would land over the prediction; the conversations around it keep theirs (read ahead).
    await Promise.all([client.cancelQueries({ queryKey: inboxKeys.lists }), client.cancelQueries({ queryKey: inboxKeys.detail(c.id) })])
    patchConversation(client, c.id, predict)
    try {
      const result = await call()
      after?.(result)
      if (done) toast(done, 'success')
      return result
    } catch (error) {
      restore()
      if (!quiet) toast(error instanceof ApiError ? error.message : failedText, 'error')
      throw error
    } finally {
      if (reread) {
        void client.invalidateQueries({ queryKey: inboxKeys.lists })
        void client.invalidateQueries({ queryKey: inboxKeys.detail(c.id) })
      }
    }
  }
  const now = () => new Date().toISOString()
  const act = (c: SupportConversation, action: SupportAction, predict: (c: SupportConversation) => SupportConversation, options: { done?: string; quiet?: boolean } = {}) =>
    run(c, predict, () => supportInboxApi.act(c.id, action, crypto.randomUUID()), options)
  // Undo puts back what that Done changed: the conversation, and the ticket it resolved.
  const undo = (c: SupportConversation, ticketId: string | null) => run(c, x => ({ ...x, done: null, ticket: ticketId && x.ticket?.id === ticketId ? { ...x.ticket, resolvedAt: null } : x.ticket }),
    () => supportInboxApi.undoDone(c.id, crypto.randomUUID()), { done: 'Back in Needs you' }).catch(() => {})
  return {
    // Done is for this conversation and the ticket it showed when the key was pressed: one filed since refuses it.
    done: (c: SupportConversation) => {
      const ticketId = c.ticket && !c.ticket.resolvedAt ? c.ticket.id : null
      return run(c, x => ({ ...x, done: { at: now(), userId: me.userId, name: me.name }, ticket: ticketId && x.ticket ? { ...x.ticket, resolvedAt: now() } : x.ticket }),
        () => supportInboxApi.done(c.id, ticketId, crypto.randomUUID()),
        { after: () => toast(ticketId ? 'Marked done. Ticket resolved.' : 'Marked done', 'success', { action: { label: 'Undo', onSelect: () => void undo(c, ticketId) }, duration: 5000 }) }).catch(() => {})
    },
    confirm: ({ action, conversation }: Confirming) => act(conversation, action, action === 'pause' ? x => ({ ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: now(), done: null })
      : action === 'resume' ? x => ({ ...x, agentState: 'active', pausedBy: null, pausedAt: null }) : x => ({ ...x, ticket: x.ticket && { ...x.ticket, resolvedAt: now() } }), { done: confirmCopy[action].done, quiet: true }),
    read: (c: SupportConversation, read: boolean, seq?: number) => run(c, x => ({ ...x, unread: !read }), () => supportInboxApi.read(c.id, read, seq), { reread: false }).catch(() => {}),
    wake: (c: SupportConversation) => run(c, x => x, () => supportInboxApi.wake(c.id)).then(r => toast(r.woken ? 'Support service woken' : 'The support service didn’t answer', r.woken ? 'success' : 'error'), () => {}),
    reply: (c: SupportConversation, text: string, key: string) => {
      const pending: SupportMessage = { id: `pending:${key}`, seq: c.messageCount + 1, author: 'staff', kind: 'reply', text, tools: [], attachments: [], staff: me, delivery: 'queued', heldReason: null, files: [], email: null, deliveredAt: null, at: now(), draft: null }
      const messages = (change: (list: SupportMessage[]) => SupportMessage[]) => client.setQueryData<SupportDetail>(inboxKeys.detail(c.id), d => d && { ...d, messages: change(d.messages) })
      return run(c, x => { messages(list => [...list, pending]); return { ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: x.pausedAt ?? now(), lastAuthor: 'staff', lastMessageAt: now(), messageCount: x.messageCount + 1, queuedReplies: x.queuedReplies + 1, done: null, unread: false } },
        () => supportInboxApi.reply(c.id, text, key), { after: sent => messages(list => list.map(m => m.id === pending.id ? sent : m)), done: c.agentState === 'active' ? 'Reply queued. The agent is paused.' : 'Reply queued' })
    },
    // A held answer sent as a staff reply: the reply shows at once and the answer says who sent it.
    sendDraft: (c: SupportConversation, draftId: string, text: string | undefined, key: string) => {
      const held = client.getQueryData<SupportDetail>(inboxKeys.detail(c.id))?.messages.find(m => m.id === draftId)
      const body = text ?? held?.text ?? '', fresh = Boolean(held?.heldReason && freshOnly[held.heldReason])
      const decided = (replyId: string | null) => ({ outcome: fresh ? 'replaced' as const : text === undefined || text === held?.text.trim() ? 'sent' as const : 'edited' as const, by: me, at: now(), replyId })
      const pending: SupportMessage = { id: `pending:${key}`, seq: c.messageCount + 1, author: 'staff', kind: 'reply', text: body, tools: [], attachments: [], staff: me, delivery: 'queued', heldReason: null, files: [], email: null, deliveredAt: null, at: now(), draft: null }
      const messages = (change: (list: SupportMessage[]) => SupportMessage[]) => client.setQueryData<SupportDetail>(inboxKeys.detail(c.id), d => d && { ...d, messages: change(d.messages) })
      return run(c, x => { messages(list => [...list.map(m => m.id === draftId ? { ...m, draft: decided(null) } : m), pending]); return { ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: x.pausedAt ?? now(), lastAuthor: 'staff', lastMessageAt: now(), messageCount: x.messageCount + 1, queuedReplies: x.queuedReplies + 1, done: null, unread: false } },
        () => supportInboxApi.sendDraft(c.id, draftId, text, key), { after: sent => messages(list => list.map(m => m.id === pending.id ? sent : m.id === draftId ? { ...m, draft: decided(sent.id) } : m)), done: 'Reply queued' })
    },
    discardDraft: (c: SupportConversation, draftId: string) => {
      const messages = (change: (list: SupportMessage[]) => SupportMessage[]) => client.setQueryData<SupportDetail>(inboxKeys.detail(c.id), d => d && { ...d, messages: change(d.messages) })
      return run(c, x => { messages(list => list.map(m => m.id === draftId ? { ...m, draft: { outcome: 'discarded', by: me, at: now(), replyId: null } } : m)); return x },
        () => supportInboxApi.discardDraft(c.id, draftId, crypto.randomUUID()), { after: dropped => messages(list => list.map(m => m.id === draftId ? dropped : m)), done: 'Draft discarded' }).catch(() => {})
    },
    // A note: shown at once in the timeline; it changes nothing the lists show.
    note: (c: SupportConversation, text: string, key: string) => {
      const pending: SupportMessage = { id: `pending:${key}`, seq: c.messageCount + 1, author: 'staff', kind: 'note', text, tools: [], attachments: [], staff: me, delivery: null, heldReason: null, files: [], email: null, deliveredAt: null, at: now(), draft: null }
      const messages = (change: (list: SupportMessage[]) => SupportMessage[]) => client.setQueryData<SupportDetail>(inboxKeys.detail(c.id), d => d && { ...d, messages: change(d.messages) })
      return run(c, x => { messages(list => [...list, pending]); return { ...x, messageCount: x.messageCount + 1, unread: false } },
        () => supportInboxApi.note(c.id, text, key), { after: sent => messages(list => list.map(m => m.id === pending.id ? sent : m)), done: 'Note added' })
    },
  }
}
type Actions = ReturnType<typeof useInboxActions>
/** onDone: a conversation's own Mark done, which also opens the next one. */
function menuItems(c: SupportConversation, { canAct, actions, onConfirm, open, onDone }: { canAct: boolean; actions: Actions; onConfirm: (confirming: Confirming) => void; open?: () => void; onDone?: () => void }): MenuItem[] {
  const items: (MenuItem | false)[] = [
    Boolean(open) && { label: 'Open', onSelect: open! },
    canAct && c.needsYou !== null && { label: c.ticket && !c.ticket.resolvedAt ? 'Mark done and resolve ticket' : 'Mark done', onSelect: onDone ?? (() => void actions.done(c)) },
    { label: c.unread ? 'Mark read' : 'Mark unread', onSelect: () => void actions.read(c, c.unread) },
    canAct && c.status !== 'closed' && c.channel !== 'agent_feedback' && (c.agentState === 'paused' ? { label: 'Hand back to the agent…', onSelect: () => onConfirm({ action: 'resume', conversation: c }) } : { label: 'Pause agent…', onSelect: () => onConfirm({ action: 'pause', conversation: c }) }),
    canAct && Boolean(c.ticket && !c.ticket.resolvedAt) && { label: 'Resolve ticket…', onSelect: () => onConfirm({ action: 'resolve', conversation: c }) },
    canAct && c.blockedWork > 0 && c.channel !== 'agent_feedback' && { label: 'Retry now', onSelect: () => void actions.wake(c) },
  ]
  return items.filter((item): item is MenuItem => Boolean(item))
}
function ConfirmAction({ confirming, onClose, actions }: { confirming: Confirming | null; onClose: () => void; actions: Actions }) {
  const last = useRef(confirming)
  if (confirming) last.current = confirming
  const shown = confirming ?? last.current, copy = shown ? confirmCopy[shown.action] : confirmCopy.pause
  return <ConfirmDialog open={confirming !== null} onOpenChange={open => { if (!open) onClose() }} title={copy.title} description={copy.description} confirmLabel={copy.confirm} onConfirm={() => shown ? actions.confirm(shown) : undefined} />
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
    <KeyValues items={[['Why', a.reason], ['Proposed by', a.proposedBy === 'agent' ? 'The support agent' : `${productName}, in the email to staff`],
      [waiting ? 'Expires' : 'State', status ?? shortDateTime(a.expiresAt)], ...(!canAct && waiting ? [['Who can approve', 'Staff with the operator role']] as [string, string][] : [])]} />
    {waiting && a.preview?.text && <blockquote className="sinbox-approval__preview" aria-label="What would be sent">{a.preview.text}</blockquote>}
    {blocked && <p className="sinbox-approval__blocked" role="status">{blocked}</p>}
  </Dialog>
}

// ---------------------------------------------------------------- cells

// A ticket Nightmail opened because the conversation needed a person (api/src/support-staff-mail.ts) is type staff.
const ticketText = (c: SupportConversation) => !c.ticket ? null : `${[c.ticket.severity, c.ticket.type && (c.ticket.type === 'staff' ? 'needs a person' : label(c.ticket.type))].filter(Boolean).join(' ') || 'Ticket'}${c.ticket.resolvedAt ? ' · resolved' : ''}`
function agentOf(c: SupportConversation): { text: string; by?: string; tone: Tone } {
  if (c.agentState === 'active') return { text: c.status === 'closed' ? 'Closed' : 'Active', tone: c.status === 'closed' ? 'neutral' : 'success' }
  return { text: 'Paused', by: c.pausedBy?.kind === 'ticket' ? 'the ticket' : c.pausedBy?.name ?? undefined, tone: 'warning' }
}
const ChannelIcon = ({ channel }: { channel: SupportConversation['channel'] }) => channel === 'email' ? <Mail size={14} aria-label="Email" /> : channel === 'agent_feedback' ? <Bot size={14} aria-label="Agent feedback" /> : <MessageSquare size={14} aria-label="Chat" />
/** Who filed agent feedback, short, from its Filed by (api/src/feedback.ts): the API key's name, the MCP sign-in's app and
 *  person, the agent token's purpose. An address stays behind the blur-addresses setting. */
function Filer({ text }: { text: string }) {
  const quoted = /"([^"]+)"/.exec(text)?.[1], email = /\bby (\S+@\S+)$|\bof (\S+@\S+)$/.exec(text), address = email?.[1] ?? email?.[2]
  const what = text.startsWith('the API key') ? `${quoted ?? 'API key'} (API key)` : text.startsWith('an MCP sign-in') ? `${quoted ?? 'An app'} (MCP)`
    : text.startsWith('an agent token') ? `${quoted ?? 'An agent'} (agent token)` : text.startsWith('the dashboard') ? 'Dashboard' : text
  return <>{what}{address && <> · <PrivateAddress value={address} /></>}</>
}
// Who a conversation is from: the person, else the address, else the workspace (agent feedback's, with who filed it in
// the words of its Filed by); "Unknown sender" only when nothing is known.
function Who({ c }: { c: SupportConversation }) {
  const address = c.customer?.email ?? c.sender
  return <span className="sinbox-who" data-unread={c.unread || undefined}>
    <span className="sinbox-unread" role={c.unread ? 'img' : undefined} aria-label={c.unread ? 'Unread' : undefined} />
    <span className="sinbox-channel"><ChannelIcon channel={c.channel} /></span>
    <span className="sinbox-who__name">{c.customer?.name ?? (address ? <PrivateAddress value={address} /> : c.workspace?.name ?? 'Unknown sender')}</span>
    {!c.customer?.name && !address && c.workspace && c.filedBy && <span className="sinbox-who__by"><Filer text={c.filedBy} /></span>}
  </span>
}
const previewBy = (p: NonNullable<SupportConversation['preview']>) => p.held ? 'AI draft, not sent: ' : p.author === 'agent' ? 'AI: ' : p.author === 'staff' ? 'Staff: ' : ''
// The subject (or the customer's first line), then the last message itself, muted, on the same line.
const previewOf = (c: SupportConversation) => c.preview && c.preview.text !== titleOf(c) ? c.preview : null
// Agent feedback has one message, its subject: its card's second line says what it is instead of repeating it.
const Preview = ({ c }: { c: SupportConversation }) => { const preview = previewOf(c); return preview ? <span className="sinbox-preview"><span className="sinbox-preview__by">{previewBy(preview)}</span>{preview.text}</span> : c.channel === 'agent_feedback' ? <span className="sinbox-preview">Report from an agent · nobody to reply to</span> : null }
const Subject = ({ c, preview = true }: { c: SupportConversation; preview?: boolean }) => <span className="sinbox-subject">
  <span className="sinbox-subject__text" data-placeholder={c.subject || c.firstLine ? undefined : ''}>{titleOf(c)}</span>
  {preview && previewOf(c) && <Preview c={c} />}
</span>
const priorityTone: Record<string, Tone> = { P1: 'danger', P2: 'warning', P3: 'neutral' }
const priorityOf = (c: SupportConversation) => c.ticket && !c.ticket.resolvedAt ? c.ticket.severity : null

// ---------------------------------------------------------------- the list

export function SupportInboxPage() {
  const role = useRole(), canAct = role === 'operator'
  const location = useLocation(), navigate = useNavigate(), client = useQueryClient(), phone = usePhone()
  const [params, setParams] = useSearchParams()
  const view = viewOf(location.search), channel = channelOf(location.search), q = (params.get('q') ?? '').trim()
  const [search, setSearch] = useSearchDraft(params.get('q') ?? '', value => setParams(previous => { const next = new URLSearchParams(previous); if (value.trim()) next.set('q', value.trim()); else next.delete('q'); return next }, { replace: true }))
  useEffect(() => { memory.list = { view, q, channel } }, [view, q, channel])
  const setChannel = (next: Channel | '') => setParams(previous => { const params = new URLSearchParams(previous); if (next) params.set('channel', next); else params.delete('channel'); return params }, { replace: true })
  // A search keeps the rows it replaces until its answer arrives; another tab never shows this one's.
  const list = useInfiniteQuery({ ...listQuery(view, q, channel), enabled: Boolean(role), staleTime: 5_000, refetchInterval: query => query.state.status === 'error' ? false : 30_000,
    placeholderData: (previous, query) => query?.queryKey[2] === view ? previous : undefined })
  // The rail counts each channel before the channel filter (this view and search, every channel).
  const everyChannel = useInfiniteQuery({ ...listQuery(view, q, ''), enabled: Boolean(role && channel), staleTime: 5_000 })
  const rows = flatten(list.data?.pages), counts = list.data?.pages[0]?.counts ?? null
  // Each view keeps its own selected row.
  const [selection, setSelection] = useState(() => ({ ...memory.selected }))
  const setSelectedId = (id: string) => setSelection(current => ({ ...current, [view]: id }))
  const index = Math.max(0, rows.findIndex(c => c.id === selection[view])), selected = rows[index]
  useEffect(() => { if (selected) memory.selected[view] = selected.id }, [view, selected?.id])
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false)
  const actions = useInboxActions()
  // The other views' first pages load once this one has, so switching tabs never waits.
  useEffect(() => {
    if (!list.data || !role) return
    for (const other of ['needs_you', 'agent', 'waiting', 'done', 'all'] as const) if (other !== view) void client.prefetchInfiniteQuery({ ...listQuery(other, ''), staleTime: 5_000 })
  }, [Boolean(list.data), role])
  // The selected row is read ahead (once it has stayed selected a moment), and kept in view.
  useEffect(() => {
    if (!selected || phone) return
    const timer = window.setTimeout(() => void prefetchConversation(client, selected.id), 120)
    document.querySelector('.sinbox-table tr[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    return () => window.clearTimeout(timer)
  }, [selected?.id])
  const open = (c: SupportConversation, reply = false) => { memory.selected[view] = c.id; navigate(`/support/${c.id}`, { state: { reply } }) }
  // Selecting a row from inside the list takes focus with it, so the focused row is always the one a key acts on.
  const select = (id: string) => {
    setSelectedId(id)
    if (document.activeElement?.closest('.sinbox-table')) requestAnimationFrame(() => document.querySelector<HTMLElement>('.sinbox-table [data-selected="true"] .ui-row-link')?.focus({ preventScroll: true }))
  }
  const move = (step: number) => {
    const next = rows[index + step]
    if (next) select(next.id)
    if (step > 0 && index + step >= rows.length - 3 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
  }
  useShortcuts({
    j: () => move(1), k: () => move(-1), Enter: () => selected && open(selected), o: () => selected && open(selected), r: () => selected && canAct && open(selected, true),
    // e acts on the row on screen when it is pressed; with nothing to mark it only moves on.
    e: () => {
      if (!selected) return
      if (!canAct || !selected.needsYou) { move(1); return }
      const target = selected, after = rows[index + 1] ?? rows[index - 1]
      if (view === 'needs_you' && after) select(after.id)
      void actions.done(target)
    },
    h: () => { if (selected && canAct && selected.agentState === 'paused' && selected.status !== 'closed') setConfirming({ action: 'resume', conversation: selected }) },
    u: () => selected && void actions.read(selected, selected.unread), '?': () => setKeysOpen(true),
  }, Boolean(role))
  if (!role) return <StaffOnly />
  if (!list.data && !list.isError) return <SupportInboxSkeleton view={view} channel={channel} />
  const columns: Column<SupportConversation>[] = [
    { ...def('customer'), render: c => <Who c={c} /> },
    { ...def('subject'), render: c => <Subject c={c} />, cardRender: c => <Subject c={c} preview={false} /> },
    { ...def('preview'), render: c => <Preview c={c} /> },
    { ...def('status'), render: c => { const s = triageOf(c); return <StatusBadge status={s.text} tone={s.tone} /> }, cardRender: c => triageOf(c).text },
    { ...def('priority'), render: c => { const p = priorityOf(c); return p ? <StatusDot tone={priorityTone[p] ?? 'neutral'}>{p}</StatusDot> : <span className="sinbox-faint">—</span> }, cardRender: c => priorityOf(c) },
    { ...def('activity'), render: c => <time className="nowrap" dateTime={lastActivity(c)} title={when(lastActivity(c))}>{ago(lastActivity(c))}</time> },
    { ...def('actions'), render: c => <DropdownMenu label="Conversation actions" title={titleOf(c)} items={menuItems(c, { canAct, actions, onConfirm: setConfirming, open: () => open(c) })} /> },
  ]
  const empty = q || channel ? <EmptyState title="No conversation matches" action={<Button onClick={() => { setSearch(''); setChannel('') }}>Clear filters</Button>} />
    : <EmptyState title={{ needs_you: 'Nothing needs you', agent: 'The agent isn’t handling anything right now', waiting: 'Nobody is waiting on a customer', done: 'Nothing is done yet', all: 'No support conversations yet' }[view]} />
  return <>
    <PageHeader title="Support" />
    <div className="sinbox-page">
      <InboxTabs view={view} counts={counts} onChange={next => setParams(previous => { const params = new URLSearchParams(previous); if (next === 'needs_you') params.delete('view'); else params.set('view', next); return params }, { replace: true })} />
      <InboxToolbar search={search} onSearch={setSearch} channel={channel} onChannel={setChannel} onShortcuts={() => setKeysOpen(true)} />
      {list.isError && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <InboxBody rows={rows} everyChannel={channel ? everyChannel.data && flatten(everyChannel.data.pages) : rows} channel={channel} setChannel={setChannel}>
        <DataTable className="sinbox-table" rows={rows} rowKey={c => c.id} columns={columns} selectedId={phone ? undefined : selected?.id} empty={empty} rowKeys={false}
          rowHref={c => `/support/${c.id}`} rowLabel={titleOf} onRowIntent={c => void prefetchConversation(client, c.id)} onRowFocus={phone ? undefined : c => setSelectedId(c.id)} />
        {list.hasNextPage && <Button className="sinbox-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
      </InboxBody>}
    </div>
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </>
}

// ---------------------------------------------------------------- one conversation

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
  const client = useQueryClient(), navigate = useNavigate(), location = useLocation(), phone = usePhone()
  const detail = useQuery({ ...detailQuery(id), enabled: Boolean(role && valid), refetchInterval: query => query.state.status === 'error' ? false : 30_000 })
  const list = useInfiniteQuery({ ...listQuery(memory.list.view, memory.list.q, memory.list.channel), enabled: Boolean(role), staleTime: 5_000 })
  const rows = flatten(list.data?.pages)
  const { next, previous } = useNeighbors(id, rows)
  const conversation = detail.data?.conversation ?? rows.find(c => c.id === id) ?? (valid ? cached(client, id) : undefined)
  const actions = useInboxActions()
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false), [sheet, setSheet] = useState(false)
  const composer = useRef<ComposerHandle>(null)
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
  // Done (e, the button, the menu's Mark done): marks this conversation done if it needs you, then opens the next one, or
  // goes back to the list after the last.
  const finish = () => {
    if (!conversation) return
    const after = next ?? previous
    if (canAct && conversation.needsYou) void actions.done(conversation)
    if (after) go(after); else back()
  }
  // The customer sheet belongs to the conversation it was opened on: another one (from its own links) closes it.
  useEffect(() => { setSheet(false) }, [id])
  useShortcuts({
    j: () => go(next), k: () => go(previous), Escape: back, r: () => composer.current?.focus('reply'), n: () => composer.current?.focus('note'), '?': () => setKeysOpen(true), e: finish,
    h: () => { if (conversation && canAct && conversation.agentState === 'paused' && conversation.status !== 'closed') setConfirming({ action: 'resume', conversation }) },
    u: () => conversation && void actions.read(conversation, conversation.unread, conversation.unread ? conversation.messageCount : undefined),
  }, Boolean(role && valid))
  if (!role) return <StaffOnly />
  if (!valid) return <EmptyState headingAs="h1" title="Page not found" action={<Link to="/support">Return to support</Link>} />
  if (!conversation) return detail.isError ? <div className="sinbox-conversation-page"><PageHeader backTo="/support" title="Conversation" /><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div> : <SupportConversationSkeleton panel={!phone} />
  const menu = <DropdownMenu label="Conversation actions" title={titleOf(conversation)} trigger={phone ? undefined : <ActionsTrigger />} items={menuItems(conversation, { canAct, actions, onConfirm: setConfirming, onDone: finish })} />
  const marks = canAct && conversation.needsYou !== null
  return <div className="sinbox-conversation-page">
    <PageHeader backTo="/support" title={<span className="sinbox-title" title={titleOf(conversation)}>{titleOf(conversation)}</span>} subtitle={<Facts c={conversation} />}
      actions={<ConversationActions panel={!phone} customer={detail.data ? () => setSheet(true) : undefined} menu={menu}
        done={{ onClick: finish, title: `${marks ? 'Mark done and open' : 'Open'} ${next ?? previous ? 'the next conversation' : 'the list'} (e)` }} />} />
    {detail.data ? <div className="sinbox-conversation">
      <Transcript key={id} detail={detail.data} canAct={canAct} actions={actions} composer={composer} />
      {!phone && <aside className="sinbox-panel" aria-label="Customer"><CustomerPanel detail={detail.data} /></aside>}
    </div> : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <ConversationBodySkeleton panel={!phone} />}
    {phone && detail.data && <Dialog open={sheet} onOpenChange={setSheet} title="Customer" className="sinbox-sheet"><CustomerPanel detail={detail.data} /></Dialog>}
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ApprovalPrompt conversationId={id} canAct={canAct} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </div>
}

// The facts line under the title, in mono: the channel, why it is here (dot and word) and the agent.
function Facts({ c }: { c: SupportConversation }) {
  const status = triageOf(c), agent = agentOf(c)
  return <p className="sinbox-subtitle"><span className="sinbox-fact"><ChannelIcon channel={c.channel} />{channelLabels[c.channel]}</span>
    <span className="sinbox-fact"><StatusBadge status={status.text} tone={status.tone} /></span>{c.channel !== 'agent_feedback' && <span className="sinbox-fact"><span className="sinbox-fact__key">Agent</span>{agent.text.toLowerCase()}{agent.by ? ` by ${agent.by}` : ''}</span>}</p>
}

// ---------------------------------------------------------------- the timeline

// One timeline, oldest first: every message and what happened besides, by time (an event before a message written in the
// same moment: a take-over comes before the reply that made it).
type Entry = { key: string; at: number; event: SupportEvent; message?: never } | { key: string; at: number; message: SupportMessage; event?: never }
function timelineOf(detail: SupportDetail): Entry[] {
  const entries: (Entry & { rank: number; order: number })[] = [
    ...detail.events.map((event, order) => ({ key: event.id, at: Date.parse(event.at), event, rank: event.kind === 'closed' ? 2 : 0, order })),
    ...detail.messages.map(message => ({ key: message.id, at: Date.parse(message.at), message, rank: 1, order: message.seq })),
  ]
  return entries.sort((a, b) => a.at - b.at || a.rank - b.rank || a.order - b.order)
}
const heldWhy: Record<HeldReason, string> = {
  paused: 'Not sent: staff took over after the agent wrote it.', gate: 'Not sent: the output check held it.', access: 'Not sent: the customer’s access changed before it went out.',
  closed: 'Not sent: the conversation ended first.', earlier: 'Not sent: an earlier version of the agent wrote it.',
}
const deliveryBadge: Record<string, { text: string; tone: Tone } | undefined> = { queued: { text: 'Queued', tone: 'warning' }, failed: { text: 'Not sent', tone: 'danger' }, sent: { text: 'Sent', tone: 'success' } }
const held = (m: SupportMessage) => m.author === 'agent' && (m.delivery === 'held' || m.kind === 'held')
const size = (bytes: number | null) => bytes === null ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const decidedText = { sent: 'Sent as written by', edited: 'Edited and sent by', replaced: 'Replaced with a fresh reply by', discarded: 'Discarded by' }
/** A held answer that may hold account details the person can no longer see: never sent, as written or edited (the API refuses it). */
const freshOnly: Partial<Record<HeldReason, string>> = { access: 'This person’s access changed after the agent wrote it, so it can’t be sent. Write a fresh reply.', earlier: 'An earlier version of the agent wrote it, so it can’t be sent. Write a fresh reply.' }
/** A held answer's choices: send it as the agent wrote it, edit it in the reply box first, or discard it (in place, asked
 *  once more). One that can't be sent offers only a fresh reply, from an empty reply box, or discarding it. */
function DraftActions({ m, c, actions, onEdit }: { m: SupportMessage; c: SupportDetail['conversation']; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
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

function Message({ m, detail, canAct, actions, onEdit }: { m: SupportMessage; detail: SupportDetail; canAct: boolean; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const c = detail.conversation, note = m.author === 'staff' && m.kind === 'note', isHeld = held(m)
  // The support platform's own notices (a fixed reply, a pause notice) are a line, like an event.
  if (m.author === 'system') return <li className="sinbox-event"><Info size={14} aria-hidden="true" /><span className="sinbox-event__text">{m.text}</span><time dateTime={m.at} title={when(m.at)}>{shortDateTime(m.at)}</time></li>
  const author = m.author === 'customer' ? c.customer?.name ?? m.email?.from.name ?? (c.channel === 'agent_feedback' ? 'Agent’s report' : 'Customer') : m.author === 'agent' ? 'Nightmail AI' : m.staff?.name ?? 'Staff'
  const via = note ? 'Internal note' : m.author === 'customer' ? (m.email ? 'Email' : channelLabels[c.channel]) : m.author === 'staff' ? `Reply by ${c.channel === 'email' ? 'email' : 'chat'}` : null
  const badge = isHeld ? m.draft && (m.draft.outcome === 'sent' || m.draft.outcome === 'edited') ? { text: 'Held, then sent by staff', tone: 'neutral' as Tone } : { text: 'Held, not sent', tone: 'warning' as Tone } : m.author === 'agent' ? deliveryBadge[m.delivery ?? 'sent'] : m.author === 'staff' && !note ? deliveryBadge[m.delivery ?? ''] : undefined
  return <li className="sinbox-message" data-author={m.author} data-note={note || undefined} data-held={isHeld || undefined} data-pending={m.id.startsWith('pending:') || undefined}>
    <div className="sinbox-message__meta">
      <span className="sinbox-message__author">{author}</span>
      {m.email && <span className="sinbox-message__from"><PrivateAddress value={m.email.from.address} /></span>}
      {via && <span className="sinbox-message__via">{via}</span>}
      {badge && <StatusBadge status={badge.text} tone={badge.tone} />}
      <time className="sinbox-message__time" dateTime={m.at} title={when(m.at)}>{shortDateTime(m.at)}</time>
    </div>
    {m.email ? <EmailBody conversationId={c.id} email={m.email} subject={c.subject} />
      : m.author === 'agent' ? <div className="sinbox-text"><Markdown text={m.text} /></div> : <div className="sinbox-message__body">{m.text}</div>}
    {m.files.length > 0 && !m.email && <Files conversationId={c.id} files={m.files} />}
    {m.tools.length > 0 && <ul className="sinbox-tools" aria-label="What the agent checked">{m.tools.map((tool, index) => <li key={index}>{tool.ok ? <Check size={12} aria-label="Done" /> : <X size={12} aria-label="Failed" />}{tool.label}</li>)}</ul>}
    {isHeld && !m.draft && <p className="sinbox-held">{m.heldReason ? freshOnly[m.heldReason] ?? heldWhy[m.heldReason] : 'Not sent.'}</p>}
    {isHeld && m.draft && <p className="sinbox-held" data-decided="">{decidedText[m.draft.outcome]} {m.draft.by.name ?? 'staff'} · <time dateTime={m.draft.at} title={when(m.draft.at)}>{shortDateTime(m.draft.at)}</time></p>}
    {isHeld && !m.draft && canAct && c.status !== 'closed' && !m.id.startsWith('pending:') && <DraftActions m={m} c={c} actions={actions} onEdit={onEdit} />}
  </li>
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
      : <div className="sinbox-message__body">{(quoted ? text : reply) || <span className="sinbox-faint">(no text)</span>}</div>}
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

// What happened besides the messages, as one quiet line each.
const eventIcon: Record<SupportEventKind, typeof Info> = { opened: Inbox, ticket: Ticket, priority: Flag, paused: Hand, resumed: Bot, resolved: CheckCheck, done: Check, undone: Undo2, closed: Archive, approved: CircleCheck, declined: CircleX }
function eventText(e: SupportEvent, c: SupportDetail['conversation']) {
  const who = e.by ? e.by.name ?? 'Staff' : null, d = e.details as Record<string, string | boolean | null | undefined>
  switch (e.kind) {
    case 'opened': return c.channel === 'agent_feedback' ? 'Filed by an agent' : `Opened by ${c.channel === 'email' ? 'email' : 'chat'}`
    case 'ticket': return d.by === 'nightmail' ? `Ticket opened: this needs a person${d.severity ? ` · ${d.severity}` : ''}` : `The agent filed a ticket${d.type ? ` · ${label(String(d.type))}` : ''}${d.severity ? ` · ${d.severity}` : ''}`
    case 'priority': return `Priority ${d.from ?? '—'} → ${d.to ?? '—'}`
    case 'paused': return d.by === 'ticket' ? 'Handed to you: the agent stopped for the ticket' : d.reply ? `${who ?? 'Staff'} replied and took over from the agent` : `${who ?? 'Staff'} paused the agent`
    case 'resumed': return `${who ?? 'Staff'} handed back to the agent`
    case 'resolved': return `${who ?? 'Staff'} resolved the ticket`
    case 'done': return `${who ?? 'Staff'} marked it done`
    case 'undone': return `${who ?? 'Staff'} undid Done`
    case 'closed': return 'Conversation closed'
    case 'approved': return d.failed ? `${who ?? 'Staff'} approved ${approvalWords(d.kind)}, and it failed` : `${who ?? 'Staff'} approved ${approvalWords(d.kind)}`
    case 'declined': return `${who ?? 'Staff'} declined ${approvalWords(d.kind)}`
  }
}
const approvalWords = (kind: unknown) => kind === 'retry_work' ? 'retrying the stuck work' : 'a proposed action'
function EventLine({ e, c }: { e: SupportEvent; c: SupportDetail['conversation'] }) {
  const Icon = e.kind !== 'opened' ? eventIcon[e.kind] ?? Info : c.channel === 'chat' ? MessageSquare : c.channel === 'agent_feedback' ? Bot : Mail
  return <li className="sinbox-event" data-kind={e.kind}><Icon size={14} aria-hidden="true" /><span className="sinbox-event__text">{eventText(e, c)}</span><time dateTime={e.at} title={when(e.at)}>{shortDateTime(e.at)}</time></li>
}

/** The agent's ticket brief, folded: its own summary, above the messages and never in place of them. */
function AiSummary({ brief }: { brief: SupportBrief }) {
  return <details className="sinbox-summary">
    <summary><Bot size={14} aria-hidden="true" /><span className="sinbox-summary__label">AI summary</span><span className="sinbox-summary__title">{brief.title}</span><ChevronRight size={14} aria-hidden="true" className="sinbox-summary__chevron" /></summary>
    <dl className="sinbox-summary__body">
      <div><dt>Summary</dt><dd>{brief.summary}</dd></div>
      {brief.ask && <div><dt>What they asked</dt><dd>{brief.ask}</dd></div>}
      {brief.recommendation && <div><dt>Recommendation</dt><dd>{brief.recommendation}</dd></div>}
    </dl>
    <p className="sinbox-summary__note">Written by the agent when it filed the ticket. The timeline below is what was actually said.</p>
  </details>
}

// A conversation opens at its newest message: a long transcript scrolls to its end (Back keeps where it was).
function useOpenAtEnd() {
  const navigation = useNavigationType()
  useEffect(() => {
    if (navigation === 'POP') return
    const main = document.getElementById('main-content'), scroller = main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement
    if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight
  }, [])
}
function Transcript({ detail, canAct, actions, composer }: { detail: SupportDetail; canAct: boolean; actions: Actions; composer: RefObject<ComposerHandle | null> }) {
  useOpenAtEnd()
  const entries = timelineOf(detail), user = useSession()?.identity?.id ?? ''
  // Edit and send: the held answer goes into the reply box, marked as that draft, so sending it decides the draft.
  // A fresh reply starts from an empty box: nothing of the held answer is carried over.
  const edit = (m: SupportMessage, fresh: boolean) => { updateInboxDraft(user, detail.conversation.id, () => ({ text: fresh ? '' : m.text.trim(), key: crypto.randomUUID(), mode: 'reply', draftOf: m.id, failed: null })); composer.current?.focus('reply') }
  return <div className="sinbox-transcript">
    {detail.brief && <AiSummary brief={detail.brief} />}
    {detail.earlierMessages > 0 && <p className="sinbox-earlier">{number(detail.earlierMessages)} earlier {detail.earlierMessages === 1 ? 'message isn’t' : 'messages aren’t'} shown.</p>}
    {entries.length ? <ol className="sinbox-timeline">{entries.map(entry => entry.event ? <EventLine key={entry.key} e={entry.event} c={detail.conversation} /> : <Message key={entry.key} m={entry.message} detail={detail} canAct={canAct} actions={actions} onEdit={edit} />)}</ol>
      : <EmptyState title="No messages yet" />}
    {canAct && <Composer ref={composer} detail={detail} actions={actions} />}
  </div>
}

type ComposerHandle = { focus: (mode?: ComposeMode) => void }
type ComposeMode = 'reply' | 'note'
// The staff reply, or an internal note. While the agent is handling the conversation a reply waits behind Take over (r),
// or, when the agent is blocked, behind Retry now; sending a reply pauses the agent. A note needs no take-over and
// changes nothing for the customer or the agent. What is typed, and a reply that failed with why, stay with the
// conversation until sent or discarded, wherever staff go meanwhile.
const Composer = forwardRef<ComposerHandle, { detail: SupportDetail; actions: Actions }>(function Composer({ detail, actions }, ref) {
  const c = detail.conversation, identity = useSession()?.identity, user = identity?.id ?? ''
  const draft = useSyncExternalStore(subscribeInboxDrafts, () => inboxDraft(user, c.id)), text = draft?.text ?? ''
  // Closed, or agent feedback (api/src/feedback.ts, filed by an agent's credential): nobody to reply to, so notes only.
  const feedback = c.channel === 'agent_feedback', closed = c.status === 'closed' || feedback, mode: ComposeMode = closed ? 'note' : draft?.mode ?? 'reply'
  const [taken, setTaken] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const setMode = (next: ComposeMode) => updateInboxDraft(user, c.id, () => ({ mode: next }))
  const take = (next: ComposeMode = 'reply') => { if (next === 'reply') setTaken(true); if (next !== mode) setMode(next); requestAnimationFrame(() => field.current?.focus()) }
  useImperativeHandle(ref, () => ({ focus: take }), [mode])
  const handling = c.agentState === 'active'
  if (mode === 'reply' && handling && !taken && !text && !draft?.failed) {
    const blocked = c.blockedWork > 0, noReply = c.needsYou?.reasons.includes('no_reply') ?? false
    return <div className="sinbox-composer sinbox-composer--idle" data-blocked={blocked || noReply || undefined}>
      <span>{blocked ? 'The agent is blocked: its work here is waiting.' : noReply ? 'No reply sent: the customer is still waiting for one.' : 'The agent is handling this.'}</span>
      <span className="cluster">{blocked && <Button onClick={() => void actions.wake(c)}>Retry now</Button>}<Button variant="ghost" onClick={() => take('note')}>Add note</Button><Button onClick={() => take('reply')}>Take over</Button></span>
    </div>
  }
  const note = mode === 'note', offline = !note && !detail.replyAvailable
  function send(event?: FormEvent) {
    event?.preventDefault()
    const body = text.trim()
    if (!body || offline || !draft) return
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
  }
  const name = c.customer?.name ?? 'the customer', me = identity?.name ?? 'you', target = detail.replyTarget
  const editing = !note && draft?.draftOf ? detail.messages.find(m => m.id === draft.draftOf && !m.draft) : undefined
  const hint = feedback ? 'An agent filed this report: there’s nobody to reply to. Resolve it or mark it done; notes are for staff.' : note ? 'Only staff see notes. The customer and the agent never do.'
    : offline ? 'The support service is offline, so replies are off.'
    : c.channel === 'email' ? <>Replying as {me} · an email in this thread{target.address ? <> to <PrivateAddress value={target.address} /></> : ''}, from {productName} support{!target.verified && '. Their email didn’t pass DMARC, so it may not be delivered'}{handling ? '. Sending pauses the agent.' : '.'}</>
    : <>Replying as {me} in their chat{target.address ? <> (emailed to <PrivateAddress value={target.address} /> if it’s closed)</> : ''}{handling ? '. Sending pauses the agent.' : '.'}</>
  return <form className="sinbox-composer" data-mode={mode} data-filled={text ? true : undefined} data-unavailable={offline || undefined} onSubmit={send}>
    {!closed && <div className="sinbox-composer__modes" role="group" aria-label="Write">
      <button type="button" aria-pressed={!note} onClick={() => take('reply')}>Reply</button>
      <button type="button" aria-pressed={note} onClick={() => take('note')}>Note</button>
    </div>}
    {editing && <p className="sinbox-composer__editing">{editing.heldReason && freshOnly[editing.heldReason] ? 'A fresh reply instead of the agent’s held answer, which can’t be sent.' : 'Editing the agent’s held answer: sending it goes out as your reply.'} <button type="button" onClick={() => updateInboxDraft(user, c.id, () => ({ draftOf: null }))}>Keep it separate</button></p>}
    <Textarea ref={field} aria-label={note ? 'Internal note' : 'Reply'} placeholder={note ? 'Add an internal note' : `Reply to ${name}`} value={text} maxLength={8000} disabled={offline}
      onChange={event => { const value = event.target.value; updateInboxDraft(user, c.id, () => ({ text: value, key: crypto.randomUUID(), mode })) }}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() } else if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur() } }} />
    <div className="sinbox-composer__actions">
      {draft?.failed ? <span className="sinbox-composer__failed" role="alert">Not sent: {draft.failed}</span> : <span className="sinbox-composer__hint">{hint}</span>}
      <span className="cluster sinbox-composer__buttons">{draft?.failed && <Button variant="ghost" onClick={() => updateInboxDraft(user, c.id, () => null)}>Discard</Button>}
        <Button type="submit" variant="primary" disabled={!text.trim() || offline}>{note ? 'Add note' : 'Send reply'}</Button></span></div>
  </form>
})

// ---------------------------------------------------------------- the customer panel

const verification: Record<SupportConversation['verification'], string> = { handoff: 'Signed in (chat)', dmarc: 'Email passed DMARC', signin: 'Signed in to claim it', none: 'Not verified', credential: 'The workspace’s credential' }
const mode: Record<SupportConversation['mode'], string> = { member: 'Member', non_member: 'No workspace', pending_signin: 'Waiting for sign-in', unverified: 'Unverified' }
// The customer panel (Signal Log): each section a small caps label with its rule over muted keys and mono values, or a short list.
const Label = ({ children }: { children: ReactNode }) => <h3 className="ui-label ui-label--rule">{children}</h3>
const None = ({ children }: { children: ReactNode }) => <p className="sinbox-none">{children}</p>
function CustomerPanel({ detail }: { detail: SupportDetail }) {
  const { conversation: c, customer } = detail, user = customer.user, evidence = c.evidence
  const others = customer.conversations
  const facts: [string, ReactNode][] = [
    ...c.workspace && c.channel !== 'agent_feedback' ? [['Workspace', c.workspace.name] as [string, ReactNode]] : [],
    ...c.page ? [['Opened from', c.page] as [string, ReactNode]] : [],
    ...evidence.dmarc ? [['DMARC', `${evidence.dmarc}${evidence.dkimAligned === null ? '' : evidence.dkimAligned ? ' · DKIM aligned' : ' · DKIM not aligned'}`] as [string, ReactNode]] : [],
    ['Ticket', c.ticket ? <span className="sinbox-ticket"><span>{ticketText(c)}</span><span className="sinbox-faint">{c.ticket.id}</span></span> : 'None'],
    ['Agent', `${number(c.turns)} ${c.turns === 1 ? 'turn' : 'turns'} · $${c.costUsd.toFixed(2)}`],
    ['Started', when(c.createdAt)],
  ]
  return <div className="sinbox-panel__body">
    {c.channel === 'agent_feedback' ? <section><Label>Filed by</Label>
      <KeyValues className="sinbox-kv" items={[
        ['Workspace', c.workspace ? <span className="sinbox-ticket"><Link to={`/operator/workspaces/${encodeURIComponent(c.workspace.id)}`}>{c.workspace.name}</Link><span className="sinbox-faint">{c.workspace.id}</span></span> : '—'],
        ['Credential', evidence.filedBy ? <span className="sinbox-ticket"><span>{evidence.filedBy}</span>{evidence.credentialId && <span className="sinbox-faint">{evidence.credentialId}</span>}</span> : '—'],
      ]} />
    </section> : <section><Label>Account</Label>
      <KeyValues className="sinbox-kv" items={user ? [
        ['Name', user.name ?? '—'],
        ['Email', user.email ? <span className="sinbox-address"><PrivateAddress value={user.email} />{user.emailVerified ? <StatusBadge status="Verified" tone="success" /> : <StatusBadge status="Unverified" tone="warning" />}</span> : '—'],
        ['Proof', verification[c.verification]], ['Access', mode[c.mode]], ['Signed up', when(user.createdAt)],
      ] : [['Sender', c.sender ? <span className="sinbox-address"><PrivateAddress value={c.sender} /></span> : '—'], ['Proof', verification[c.verification]], ['Access', 'No account linked']]} />
    </section>}
    <section><Label>Conversation</Label><KeyValues className="sinbox-kv" items={facts} /></section>
    {user && <section><Label>Workspaces</Label>
      {customer.workspaces.length ? <ul className="sinbox-list">{customer.workspaces.map(w => <li key={w.id}>
        <Link to={`/operator/workspaces/${encodeURIComponent(w.id)}`} className="sinbox-list__main">{w.name}</Link>
        <span className="sinbox-list__meta">{[w.role, w.standing && w.standing !== 'ok' ? w.standing : null, w.sending?.paused ? 'paused' : null, w.inScope ? 'in scope' : null].filter(Boolean).join(' · ')}</span>
      </li>)}</ul> : <None>No workspaces</None>}
    </section>}
    {user && <section><Label>Notes</Label>
      {customer.notes.length ? <ul className="sinbox-notes">{customer.notes.map(n => <li key={n.id}><p>{n.text}</p><span className="sinbox-list__meta">{n.author} · {when(n.createdAt)}</span></li>)}</ul> : <None>No notes</None>}
    </section>}
    <section><Label>Other conversations</Label>
      {others.length ? <ul className="sinbox-list">{others.map(o => <li key={o.id}>
        <Link to={`/support/${o.id}`} className="sinbox-list__main">{o.subject ?? channelLabels[o.channel as Channel] ?? 'Chat'}</Link>
        <span className="sinbox-list__meta">{[o.status, o.ticket?.severity, ago(o.lastMessageAt ?? o.createdAt)].filter(Boolean).join(' · ')}</span>
      </li>)}</ul> : <None>No other conversations</None>}
    </section>
    {user && <section><Label>Recent activity</Label>
      {customer.activity.length ? <ul className="sinbox-list">{customer.activity.slice(0, 10).map(e => <li key={e.id}>
        <span className="sinbox-list__main">{label(e.action.replace(/[._]/g, ' '))}</span><time className="sinbox-list__meta" dateTime={e.at} title={when(e.at)}>{ago(e.at)}</time>
      </li>)}</ul> : <None>No activity yet</None>}
    </section>}
  </div>
}
