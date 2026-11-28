import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ConfirmDialog, Dialog, useToast, type MenuItem } from '../../components/ui'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { inboxKeys, patchConversation, snapshotInbox, supportInboxApi, type Channel, type HeldReason, type InboxView, type SupportAction, type SupportConversation, type SupportDetail, type SupportInboxPage, type SupportMessage } from '../../data/support-inbox'
import { shortDateTime } from '../../lib/format'

// What the inbox list (index.tsx) and a conversation (conversation.tsx) share: the list a conversation was opened from,
// the single-key shortcuts and the send key, and every change staff make, shown at once and put back if the API refuses.

// What the inbox keeps between its pages in this visit: the list a conversation was opened from (j and k follow it) and
// the row selected in each view. Unsent replies are kept per conversation in this tab (data/support-inbox.ts).
export const memory: { list: { view: InboxView; q: string; channel: Channel | '' }; selected: Partial<Record<InboxView, string>> } = { list: { view: 'needs_you', q: '', channel: '' }, selected: {} }
export const CONVERSATION = /^conv_[a-z2-7]{26}$/
export const listPath = () => { const params = new URLSearchParams(); if (memory.list.view !== 'needs_you') params.set('view', memory.list.view); if (memory.list.q) params.set('q', memory.list.q); if (memory.list.channel) params.set('channel', memory.list.channel); const query = params.toString(); return query ? `/support?${query}` : '/support' }
export const useRole = () => useSession()?.identity?.operator ?? null
export const titleOf = (c: SupportConversation) => c.subject ?? c.firstLine ?? 'No messages yet'
export const when = (value: string | null | undefined) => value ? `${shortDateTime(value)} UTC` : '—'
export const flatten = (pages: SupportInboxPage[] | undefined) => pages?.flatMap(page => page.data) ?? []
export function cached(client: QueryClient, id: string) {
  for (const [, data] of client.getQueriesData<{ pages: SupportInboxPage[] }>({ queryKey: inboxKeys.lists })) { const found = flatten(data?.pages).find(c => c.id === id); if (found) return found }
  return client.getQueryData<SupportDetail>(inboxKeys.detail(id))?.conversation
}

// ---------------------------------------------------------------- keys

/**
 * The one rule for the key that sends from the reply box (Ryan, 26 Nov): Enter sends and Shift+Enter starts a new line;
 * ⌘↵ (Ctrl+Enter) sends too. On a touch keyboard the return key makes a new line and the Send button sends. Never while an
 * input method is composing (its Enter picks the word: Safari reports that keydown as key code 229 after compositionend).
 * The box itself refuses an empty send and one while another is in flight.
 */
export const sendKeyLabel = ['↵']
export const newLineKeyLabel = ['⇧', '↵']
export function isSendKey(event: { key: string; keyCode?: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; nativeEvent?: { isComposing?: boolean } }, touch: boolean) {
  if (event.key !== 'Enter' || event.nativeEvent?.isComposing || event.keyCode === 229 || event.altKey) return false
  if (event.metaKey || event.ctrlKey) return true
  return !touch && !event.shiftKey
}
const typing = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
/** The inbox's single-key shortcuts: never while typing, inside a dialog or menu, or with a modifier. Arrows move like j and k. */
export function useShortcuts(keys: Record<string, () => void>, enabled = true) {
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
  [['h'], 'Hand back to the agent'], [['u'], 'Mark read or unread'], [['/'], 'Search'], [[...sendKeyLabel], 'Send the reply or note'], [[...newLineKeyLabel], 'New line in the reply box'], [['?'], 'These shortcuts']]
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title="Keyboard shortcuts">
    <dl className="sinbox-keys">{shortcuts.map(([keys, text]) => <div key={text}><dt>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dt><dd>{text}</dd></div>)}</dl>
  </Dialog>
}

// ---------------------------------------------------------------- changes

/** A held answer that may hold account details the person can no longer see: never sent, as written or edited (the API refuses it). */
export const freshOnly: Partial<Record<HeldReason, string>> = { access: 'This person’s access changed after the agent wrote it, so it can’t be sent. Write a fresh reply.', earlier: 'An earlier version of the agent wrote it, so it can’t be sent. Write a fresh reply.' }


export type Confirming = { action: 'pause' | 'resume'; conversation: SupportConversation }
const confirmCopy: Record<Confirming['action'], { title: string; description: string; confirm: string; done: string }> = {
  pause: { title: 'Pause the agent?', description: 'It stops answering this customer until someone hands back.', confirm: 'Pause agent', done: 'Agent paused' },
  resume: { title: 'Hand back to the agent?', description: 'It answers the customer’s next message.', confirm: 'Hand back', done: 'Handed back to the agent' },
}
export const failedText = 'Couldn’t complete the action. Try again.'
/** Every change the inbox makes: shown at once in every list and the conversation, put back if the API refuses it, then read again. */
export function useInboxActions() {
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
  const updateMessages = (id: string, change: (list: SupportMessage[]) => SupportMessage[]) =>
    client.setQueryData<SupportDetail>(inboxKeys.detail(id), d => d && { ...d, messages: change(d.messages) })
  const pendingMessage = (c: SupportConversation, kind: 'reply' | 'note', text: string, key: string): SupportMessage => ({
    id: `pending:${key}`, seq: c.messageCount + 1, author: 'staff', kind, text, tools: [], attachments: [],
    staff: { ...me, viaAgent: false }, emailFrom: null, delivery: kind === 'reply' ? 'queued' : null,
    heldReason: null, files: [], email: null, deliveredAt: null, at: now(), draft: null,
  })
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
      : x => ({ ...x, agentState: 'active', pausedBy: null, pausedAt: null }), { done: confirmCopy[action].done, quiet: true }),
    read: (c: SupportConversation, read: boolean, seq?: number) => run(c, x => ({ ...x, unread: !read }), () => supportInboxApi.read(c.id, read, seq), { reread: false }).catch(() => {}),
    wake: (c: SupportConversation) => run(c, x => x, () => supportInboxApi.wake(c.id)).then(r => toast(r.woken ? 'Support service woken' : 'The support service didn’t answer', r.woken ? 'success' : 'error'), () => {}),
    reply: (c: SupportConversation, text: string, key: string) => {
      const pending = pendingMessage(c, 'reply', text, key)
      return run(c, x => { updateMessages(c.id, list => [...list, pending]); return { ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: x.pausedAt ?? now(), lastAuthor: 'staff', lastMessageAt: now(), messageCount: x.messageCount + 1, queuedReplies: x.queuedReplies + 1, done: null, unread: false } },
        () => supportInboxApi.reply(c.id, text, key), { after: sent => updateMessages(c.id, list => list.map(m => m.id === pending.id ? sent : m)), done: c.agentState === 'active' ? 'Reply queued. The agent is paused.' : 'Reply queued' })
    },
    // A held answer sent as a staff reply: the reply shows at once and the answer says who sent it.
    sendDraft: (c: SupportConversation, draftId: string, text: string | undefined, key: string) => {
      const held = client.getQueryData<SupportDetail>(inboxKeys.detail(c.id))?.messages.find(m => m.id === draftId)
      const body = text ?? held?.text ?? '', fresh = Boolean(held?.heldReason && freshOnly[held.heldReason])
      const decided = (replyId: string | null) => ({ outcome: fresh ? 'replaced' as const : text === undefined || text === held?.text.trim() ? 'sent' as const : 'edited' as const, by: me, at: now(), replyId })
      const pending = pendingMessage(c, 'reply', body, key)
      return run(c, x => { updateMessages(c.id, list => [...list.map(m => m.id === draftId ? { ...m, draft: decided(null) } : m), pending]); return { ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: x.pausedAt ?? now(), lastAuthor: 'staff', lastMessageAt: now(), messageCount: x.messageCount + 1, queuedReplies: x.queuedReplies + 1, done: null, unread: false } },
        () => supportInboxApi.sendDraft(c.id, draftId, text, key), { after: sent => updateMessages(c.id, list => list.map(m => m.id === pending.id ? sent : m.id === draftId ? { ...m, draft: decided(sent.id) } : m)), done: 'Reply queued' })
    },
    discardDraft: (c: SupportConversation, draftId: string) =>
      run(c, x => { updateMessages(c.id, list => list.map(m => m.id === draftId ? { ...m, draft: { outcome: 'discarded', by: me, at: now(), replyId: null } } : m)); return x },
        () => supportInboxApi.discardDraft(c.id, draftId, crypto.randomUUID()), { after: dropped => updateMessages(c.id, list => list.map(m => m.id === draftId ? dropped : m)), done: 'Draft discarded' }).catch(() => {}),
    // A note: shown at once in the timeline; it changes nothing the lists show.
    note: (c: SupportConversation, text: string, key: string) => {
      const pending = pendingMessage(c, 'note', text, key)
      return run(c, x => { updateMessages(c.id, list => [...list, pending]); return { ...x, messageCount: x.messageCount + 1, unread: false } },
        () => supportInboxApi.note(c.id, text, key), { after: sent => updateMessages(c.id, list => list.map(m => m.id === pending.id ? sent : m)), done: 'Note added' })
    },
  }
}
export type Actions = ReturnType<typeof useInboxActions>
/** A conversation's menu. The row is a link, so there's no Open; Mark done resolves its open ticket, so there's no separate
 *  Resolve. done: false on the conversation page, where Done is its own button. */
export function menuItems(c: SupportConversation, { canAct, actions, onConfirm, done = true }: { canAct: boolean; actions: Actions; onConfirm: (confirming: Confirming) => void; done?: boolean }): MenuItem[] {
  const items: (MenuItem | false)[] = [
    done && canAct && c.needsYou !== null && { label: c.ticket && !c.ticket.resolvedAt ? 'Mark done and resolve ticket' : 'Mark done', onSelect: () => void actions.done(c) },
    { label: c.unread ? 'Mark read' : 'Mark unread', onSelect: () => void actions.read(c, c.unread) },
    canAct && c.status !== 'closed' && c.channel !== 'agent_feedback' && (c.agentState === 'paused' ? { label: 'Hand back to the agent…', onSelect: () => onConfirm({ action: 'resume', conversation: c }) } : { label: 'Pause agent…', onSelect: () => onConfirm({ action: 'pause', conversation: c }) }),
    canAct && c.blockedWork > 0 && c.channel !== 'agent_feedback' && { label: 'Retry now', onSelect: () => void actions.wake(c) },
  ]
  return items.filter((item): item is MenuItem => Boolean(item))
}
export function ConfirmAction({ confirming, onClose, actions }: { confirming: Confirming | null; onClose: () => void; actions: Actions }) {
  const last = useRef(confirming)
  if (confirming) last.current = confirming
  const shown = confirming ?? last.current, copy = shown ? confirmCopy[shown.action] : confirmCopy.pause
  return <ConfirmDialog open={confirming !== null} onOpenChange={open => { if (!open) onClose() }} title={copy.title} description={copy.description} confirmLabel={copy.confirm} onConfirm={() => shown ? actions.confirm(shown) : undefined} />
}

