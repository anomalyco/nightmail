import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { request } from './live'
import type { Brief as SupportBrief, HeldReason, InboxCounts, SupportApproval, SupportAuthor, SupportChannel as Channel, SupportConversation, SupportDetail, SupportEmail, SupportEmailFull, SupportEvent, SupportEventKind, SupportInboxPage, SupportMessage, SupportTicket, SupportWorkspace, TriageReason } from '../../../api/src/support-contract.js'

// The support inbox (/v1/operator/support-inbox, api/src/support-inbox.ts, shared contract api/src/support-contract.ts):
// every support conversation, for Nightmail staff. Like the rest of the operator API it is left out of the public SDK,
// so the inbox calls it with the dashboard's own request helper. Its views: Needs you (what only a person can move
// forward, most urgent first) and All.
export type InboxView = 'needs_you' | 'all'
export type { Channel, HeldReason, InboxCounts, SupportApproval, SupportAuthor, SupportBrief, SupportConversation, SupportDetail, SupportEmail, SupportEmailFull, SupportEvent, SupportEventKind, SupportInboxPage, SupportMessage, SupportTicket, SupportWorkspace, TriageReason }
export const channelLabels: Record<Channel, string> = { chat: 'Chat', email: 'Email', agent_feedback: 'Agent feedback' }
export type SupportAction = 'pause' | 'resume' | 'resolve'

const base = '/v1/operator/support-inbox', id = encodeURIComponent
export const supportInboxApi = {
  list: ({ view, q, channel, cursor }: { view: InboxView; q?: string; channel?: Channel; cursor?: string }, signal?: AbortSignal) => {
    const params = new URLSearchParams({ view, limit: '50' })
    if (q) params.set('q', q)
    if (channel) params.set('channel', channel)
    if (cursor) params.set('cursor', cursor)
    return request<SupportInboxPage>(`${base}?${params}`, { signal })
  },
  detail: (conversationId: string, signal?: AbortSignal) => request<SupportDetail>(`${base}/${id(conversationId)}`, { signal }),
  reply: (conversationId: string, text: string, idempotencyKey: string) => request<SupportMessage>(`${base}/${id(conversationId)}/replies`, { method: 'POST', body: { text }, idempotencyKey }),
  /** A held agent answer, sent as the agent wrote it (no text) or edited, as a staff reply: it pauses the agent like any reply. */
  sendDraft: (conversationId: string, messageId: string, text: string | undefined, idempotencyKey: string) => request<SupportMessage>(`${base}/${id(conversationId)}/drafts/${id(messageId)}/send`, { method: 'POST', body: text === undefined ? {} : { text }, idempotencyKey }),
  discardDraft: (conversationId: string, messageId: string, idempotencyKey: string) => request<SupportMessage>(`${base}/${id(conversationId)}/drafts/${id(messageId)}/discard`, { method: 'POST', idempotencyKey }),
  /** An internal note: staff see it in the timeline; the customer and the agent never do. */
  note: (conversationId: string, text: string, idempotencyKey: string) => request<SupportMessage>(`${base}/${id(conversationId)}/notes`, { method: 'POST', body: { text }, idempotencyKey }),
  /** A customer email in full: all of its text and its HTML as stored (render it sandboxed, images off until asked). */
  email: (conversationId: string, messageId: string, signal?: AbortSignal) => request<SupportEmailFull>(`${base}/${id(conversationId)}/emails/${id(messageId)}`, { signal }),
  emailAttachment: (conversationId: string, messageId: string, attachmentId: string) => request<{ url: string; expiresAt: string }>(`${base}/${id(conversationId)}/emails/${id(messageId)}/attachments/${id(attachmentId)}`),
  /** A chat screenshot, held by the support service: a link for five minutes. */
  file: (conversationId: string, attachmentId: string) => request<{ url: string; expiresAt: string }>(`${base}/${id(conversationId)}/files/${id(attachmentId)}`),
  act: (conversationId: string, action: SupportAction, idempotencyKey: string) => request<SupportConversation>(`${base}/${id(conversationId)}/${action}`, { method: 'POST', idempotencyKey }),
  /** Mark done, for the ticket on screen (null for none): one filed since refuses it (409 SUPPORT_TICKET_CHANGED). */
  done: (conversationId: string, ticketId: string | null, idempotencyKey: string) => request<SupportConversation>(`${base}/${id(conversationId)}/done`, { method: 'POST', body: { ticketId }, idempotencyKey }),
  /** Undo Mark done (whoever marked it, for a few minutes): a ticket Done resolved opens again. */
  undoDone: (conversationId: string, idempotencyKey: string) => request<SupportConversation>(`${base}/${id(conversationId)}/done`, { method: 'DELETE', idempotencyKey }),
  wake: (conversationId: string) => request<{ id: string; woken: boolean }>(`${base}/${id(conversationId)}/wake`, { method: 'POST' }),
  /** An approval, through its emailed link's token. Reading it changes nothing. */
  approval: (conversationId: string, approvalId: string, token: string, signal?: AbortSignal) => request<SupportApproval>(`${base}/${id(conversationId)}/approvals/${id(approvalId)}?token=${id(token)}`, { signal }),
  decideApproval: (conversationId: string, approvalId: string, token: string, decision: 'approve' | 'decline', idempotencyKey: string) =>
    request<SupportApproval>(`${base}/${id(conversationId)}/approvals/${id(approvalId)}`, { method: 'POST', body: { token, decision }, idempotencyKey }),
  read: (conversationId: string, read: boolean, seq?: number) => request<{ id: string; unread: boolean }>(`${base}/${id(conversationId)}/read`, { method: 'PUT', body: seq === undefined ? { read } : { read, seq } }),
}

export const inboxKeys = {
  all: ['support-inbox'] as const,
  lists: ['support-inbox', 'list'] as const,
  list: (view: InboxView, q: string, channel: Channel | '') => ['support-inbox', 'list', view, q, channel] as const,
  detail: (conversationId: string) => ['support-inbox', 'detail', conversationId] as const,
}
export const listQuery = (view: InboxView, q: string, channel: Channel | '' = '') => ({
  queryKey: inboxKeys.list(view, q, channel), initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => supportInboxApi.list({ view, q: q || undefined, channel: channel || undefined, cursor: pageParam }, signal),
  getNextPageParam: (page: SupportInboxPage) => page.nextCursor ?? undefined,
})
// A conversation stays fresh for 15 seconds: hovering it, opening it and moving past it read it once.
export const DETAIL_FRESH = 15_000
export const detailQuery = (conversationId: string) => ({ queryKey: inboxKeys.detail(conversationId), queryFn: ({ signal }: { signal: AbortSignal }) => supportInboxApi.detail(conversationId, signal), staleTime: DETAIL_FRESH })
export const prefetchConversation = (client: QueryClient, conversationId: string) => client.prefetchQuery(detailQuery(conversationId))

// ---------- what the inbox shows before the API answers (optimistic updates) ----------

// The API's rule (api/src/support-inbox.ts "Needs you"), for the change a click predicts; the next read replaces it.
export function triage(c: SupportConversation): SupportConversation['needsYou'] {
  if (c.done) return null
  const ticket = Boolean(c.ticket && !c.ticket.resolvedAt), blocked = c.blockedWork > 0, failed = c.needsYou?.reasons.includes('failed') ?? false
  const paused = c.agentState === 'paused' && c.status !== 'closed' && c.lastAuthor !== 'staff'
  // Only the API knows how long the customer has waited; a reply from staff answers it.
  const noReply = (c.needsYou?.reasons.includes('no_reply') ?? false) && c.lastAuthor === 'customer'
  const reasons = ([['ticket', ticket], ['blocked', blocked], ['failed', failed], ['paused', paused], ['no_reply', noReply]] as const).filter(([, on]) => on).map(([reason]) => reason)
  if (!reasons.length) return null
  return { reasons, urgent: (ticket && c.ticket?.severity === 'P1') || failed || noReply || (c.lastAuthor === 'customer' && (paused || blocked)), since: c.needsYou?.since ?? new Date().toISOString() }
}
export const inView = (c: SupportConversation, view: InboxView) => view === 'all' || c.needsYou !== null
const inList = (c: SupportConversation, key: readonly unknown[]) => inView(c, key[2] as InboxView) && (!key[4] || c.channel === key[4])

type ListData = InfiniteData<SupportInboxPage, string | undefined>
/** Every cached list and the conversation's own page, after `change`: rows that leave a view leave it, and the counts follow. */
export function patchConversation(client: QueryClient, conversationId: string, change: (c: SupportConversation) => SupportConversation) {
  let before: SupportConversation | undefined
  const detail = client.getQueryData<SupportDetail>(inboxKeys.detail(conversationId))
  for (const [, data] of client.getQueriesData<ListData>({ queryKey: inboxKeys.lists })) before ??= data?.pages.flatMap(page => page.data).find(c => c.id === conversationId)
  before ??= detail?.conversation
  if (!before) return
  const predicted = change(before), changed = { ...predicted, needsYou: triage(predicted) }
  const delta = Number(inView(changed, 'needs_you')) - Number(inView(before, 'needs_you'))
  for (const [key, data] of client.getQueriesData<ListData>({ queryKey: inboxKeys.lists })) {
    if (!data) continue
    client.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map(page => ({
        ...page, counts: { ...page.counts, needsYou: Math.max(0, page.counts.needsYou + delta) },
        data: page.data.flatMap(c => c.id !== conversationId ? [c] : inList(changed, key) ? [changed] : []),
      })),
    })
  }
  if (detail) client.setQueryData<SupportDetail>(inboxKeys.detail(conversationId), { ...detail, conversation: { ...detail.conversation, ...changed } })
}
/** A snapshot of every inbox query, to put back when a change the inbox predicted fails. */
export function snapshotInbox(client: QueryClient) {
  const saved = client.getQueriesData({ queryKey: inboxKeys.all })
  return () => { for (const [key, data] of saved) client.setQueryData(key, data) }
}

// ---------- unsent replies ----------

// A reply staff are writing, per staff member and conversation, kept in this tab (sessionStorage) until it is sent or
// discarded: it survives moving between conversations and a reload, and a reply that fails comes back into its box with
// why, wherever staff are when it fails. `key` is its Idempotency-Key: sent again unedited, it is never sent twice.
export type InboxDraft = { text: string; key: string; failed: string | null; sending: { text: string; key: string } | null; mode?: 'reply' | 'note'; draftOf?: string | null }
const DRAFTS = 'nightmail.support-inbox.drafts'
const draftListeners = new Set<() => void>()
let drafts: { user: string; map: Record<string, InboxDraft> } | null = null
function draftsOf(user: string) {
  if (drafts?.user === user) return drafts.map
  let map: Record<string, InboxDraft> = {}
  try { map = JSON.parse(sessionStorage.getItem(`${DRAFTS}:${user}`) ?? '{}') ?? {} } catch { /* None kept. */ }
  // A reply still sending when the page went away may or may not have arrived: it is back in its box, with its own key.
  for (const [id, draft] of Object.entries(map)) if (draft.sending) map[id] = { text: [draft.sending.text, draft.text].filter(Boolean).join('\n\n'), key: draft.text ? crypto.randomUUID() : draft.sending.key,
    failed: 'The page closed while this was sending. Check the conversation before sending it again.', sending: null }
  drafts = { user, map }
  return map
}
export const inboxDraft = (user: string, conversationId: string): InboxDraft | undefined => draftsOf(user)[conversationId]
export const subscribeInboxDrafts = (listener: () => void) => { draftListeners.add(listener); return () => { draftListeners.delete(listener) } }
/** Changes one conversation's draft (null discards it); a draft with nothing in it is dropped. */
export function updateInboxDraft(user: string, conversationId: string, change: (draft: InboxDraft) => Partial<InboxDraft> | null) {
  const map = { ...draftsOf(user) }, current = map[conversationId] ?? { text: '', key: crypto.randomUUID(), failed: null, sending: null }
  const patch = change(current), next = patch && { ...current, ...patch }
  // A note chosen, or a held answer's reply started, with nothing typed yet is kept too, so the box stays what it is.
  if (next && (next.text || next.failed || next.sending || next.mode === 'note' || next.draftOf)) map[conversationId] = next
  else delete map[conversationId]
  drafts = { user, map }
  try { if (Object.keys(map).length) sessionStorage.setItem(`${DRAFTS}:${user}`, JSON.stringify(map)); else sessionStorage.removeItem(`${DRAFTS}:${user}`) } catch { /* Kept for this page only. */ }
  for (const listener of draftListeners) listener()
}
/** Signing out forgets every unsent reply in this tab. */
export function forgetInboxDrafts() {
  drafts = null
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(`${DRAFTS}:`)) sessionStorage.removeItem(key) } catch { /* Nothing kept. */ }
  for (const listener of draftListeners) listener()
}
