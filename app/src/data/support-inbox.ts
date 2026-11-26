import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { request } from './live'

// The support inbox (/v1/operator/support-inbox, api/src/support-inbox.ts): every support conversation, for Nightmail
// staff. Like the rest of the operator API it is left out of the public SDK, so the inbox calls it with the dashboard's
// own request helper. Its views: Needs you (what only a person can move forward, most urgent first), AI handling (the agent
// owes the next message), Waiting on customer, Done and All.
export type InboxView = 'needs_you' | 'agent' | 'waiting' | 'done' | 'all'
/** agent_feedback: a report an agent filed with sendFeedback (api/src/feedback.ts); nobody to reply to. */
export type Channel = 'chat' | 'email' | 'agent_feedback'
export const channelLabels: Record<Channel, string> = { chat: 'Chat', email: 'Email', agent_feedback: 'Agent feedback' }
export type SupportAuthor = 'customer' | 'agent' | 'staff' | 'system'
export type TriageReason = 'ticket' | 'blocked' | 'failed' | 'paused' | 'no_reply'
export interface SupportTicket { id: string; type: string | null; severity: string | null; resolvedAt: string | null }
export interface SupportConversation {
  id: string; channel: Channel; mode: 'member' | 'non_member' | 'pending_signin' | 'unverified'; verification: 'handoff' | 'dmarc' | 'signin' | 'none' | 'credential'
  status: 'open' | 'ticketed' | 'closed'; subject: string | null; customer: { userId: string; name: string | null; email: string | null } | null; sender: string | null
  workspace: { id: string; name: string } | null; filedBy?: string | null; ticket: SupportTicket | null; agentState: 'active' | 'paused'
  pausedBy: { kind: 'staff' | 'ticket'; userId: string | null; name: string | null } | null; pausedAt: string | null
  lastAuthor: SupportAuthor | null; needsReply: boolean; preview: { author: SupportAuthor; text: string; held: boolean } | null; messageCount: number; queuedReplies: number; turns: number; costUsd: number; blockedWork: number
  firstLine: string | null; needsYou: { reasons: TriageReason[]; urgent: boolean; since: string } | null; done: { at: string; userId: string; name: string | null } | null; unread: boolean
  createdAt: string; lastMessageAt: string | null; closedAt: string | null
}
export type HeldReason = 'paused' | 'gate' | 'access' | 'closed' | 'earlier'
export interface SupportEmail {
  id: string; subject: string; from: { name: string | null; address: string }; to: { name: string | null; address: string }[]; cc: { name: string | null; address: string }[]; receivedAt: string
  text: string; replyText: string; textTruncated: boolean; hasHtml: boolean
  attachments: { id: string; filename: string; contentType: string; size: number; inline: boolean; available: boolean }[]
}
export interface SupportMessage {
  id: string; seq: number; author: SupportAuthor; kind: string | null; text: string; tools: { label: string; ok: boolean }[]; attachments: string[]
  staff: { userId: string; name: string | null } | null; delivery: 'queued' | 'sent' | 'failed' | 'held' | null; heldReason: HeldReason | null
  files: { id: string; name: string | null; type: string | null; size: number | null }[]; email: SupportEmail | null; deliveredAt: string | null; at: string
  draft: { outcome: 'sent' | 'edited' | 'replaced' | 'discarded'; by: { userId: string; name: string | null }; at: string; replyId: string | null } | null
}
export type SupportEventKind = 'opened' | 'ticket' | 'priority' | 'paused' | 'resumed' | 'resolved' | 'done' | 'undone' | 'closed' | 'approved' | 'declined' | 'action' | 'proposed'
/** A one-click decision a staff email linked to (api/src/support-approvals.ts): only a signed-in operator's confirm runs it. */
export interface SupportApproval {
  id: string; conversationId: string; kind: string; label: string; effect: string; risky: boolean; reason: string; proposedBy: 'nightmail' | 'agent'
  /** An agent's risky proposal: its exact target in Nightmail's words, with its numbers. */
  summary: string | null
  /** A limit or balance it changes: its value now (read when opened) and after approving. */
  change: { now: string; after: string } | null
  state: 'proposed' | 'approved' | 'declined' | 'failed' | 'expired'; createdAt: string; expiresAt: string; decidedAt: string | null
  decidedBy: { userId: string; name: string | null } | null; result: Record<string, unknown> | null
  /** Send the held answer: exactly what would go, and why it can't, when it can't. */
  preview: { text: string | null; blocked: string | null } | null
}
export interface SupportEvent { id: string; kind: SupportEventKind; by: { userId: string; name: string | null } | null; details: Record<string, unknown>; at: string }
export interface SupportBrief { title: string; summary: string; ask: string; recommendation: string }
export interface SupportWorkspace { id: string; name: string; role: string; joinedAt: string; createdAt: string; members: number; inScope: boolean; contentShared: boolean; sending: { kind: string; region: string | null; paused: boolean } | null; standing: string | null }
export interface SupportDetail {
  conversation: SupportConversation & { threadId: string | null; page: string | null; contentWorkspaceId: string | null
    evidence: { handoff: string | null; message: string | null; dmarc: string | null; dkimAligned: boolean | null; claimedAt: string | null
      /** Agent feedback: the key, sign-in or token that filed it (api/src/feedback.ts), and its ID. */
      filedBy?: string | null; credentialId?: string | null } }
  messages: SupportMessage[]; earlierMessages: number; events: SupportEvent[]; brief: SupportBrief | null; replyTarget: { address: string | null; verified: boolean }
  customer: {
    user: { id: string; name: string | null; email: string | null; emailVerified: boolean; createdAt: string } | null
    workspaces: SupportWorkspace[]
    conversations: { id: string; channel: string; mode: string; verification: string; status: string; subject: string | null; ticket: SupportTicket | null; createdAt: string; lastMessageAt: string | null }[]
    activity: { id: string; at: string; action: string; workspaceId: string | null; actorType: string; via: string; internal: boolean; summary: Record<string, unknown> }[]
    notes: { id: string; text: string; author: 'agent' | 'staff'; workspaceId: string | null; conversationId: string; createdAt: string }[]
  }
  replyAvailable: boolean
}
export type InboxCounts = { needsYou: number; agent: number; waiting: number }
export interface SupportInboxPage { data: SupportConversation[]; nextCursor: string | null; replyAvailable: boolean; counts: InboxCounts }
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
  email: (conversationId: string, messageId: string, signal?: AbortSignal) => request<{ id: string; text: string; replyText: string; html: string | null; htmlTooComplex: boolean; bodyTruncated: boolean }>(`${base}/${id(conversationId)}/emails/${id(messageId)}`, { signal }),
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
/** The agent or staff wrote last (a held draft wasn't sent), so the customer has the next word. */
const answered = (c: SupportConversation) => (c.lastAuthor === 'agent' || c.lastAuthor === 'staff') && !c.preview?.held
export function inView(c: SupportConversation, view: InboxView) {
  switch (view) {
    case 'all': return true
    case 'needs_you': return c.needsYou !== null
    case 'agent': return c.status !== 'closed' && c.channel !== 'agent_feedback' && c.agentState === 'active' && c.needsYou === null && !c.done && !answered(c)
    case 'waiting': return c.status !== 'closed' && c.channel !== 'agent_feedback' && c.needsYou === null && !c.done && answered(c)
    case 'done': return c.needsYou === null && (c.done !== null || c.status === 'closed' || (c.channel === 'agent_feedback' && Boolean(c.ticket?.resolvedAt)))
  }
}
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
  const moved = (view: InboxView) => Number(inView(changed, view)) - Number(inView(before, view))
  const delta = { needsYou: moved('needs_you'), agent: moved('agent'), waiting: moved('waiting') }
  for (const [key, data] of client.getQueriesData<ListData>({ queryKey: inboxKeys.lists })) {
    if (!data) continue
    client.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map(page => ({
        ...page, counts: { needsYou: Math.max(0, page.counts.needsYou + delta.needsYou), agent: Math.max(0, page.counts.agent + delta.agent), waiting: Math.max(0, (page.counts.waiting ?? 0) + delta.waiting) },
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
