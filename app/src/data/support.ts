import { recentFailedRequestIds, request, type RequestScope } from './live'

// The support chat's handoff (hosted): POST /v1/contact-support signs who is asking, in which workspace, from which page
// and after which failed requests; the Help panel opens or resumes its conversation with `token` (features/support/socket.ts),
// and files a message the chat can't take as a ticket with the same call.
export type SupportHandoff = { id: string; url: string | null; token: string | null; expiresAt: string; shareContent: boolean
  /** A message filed as a ticket (`ticket` in the request): the chat that holds it, its ID there, and where the team replies. */
  ticket?: { conversationId: string; messageId: string; replyTo: string | null } | null }
/** The signed-in person's open chat conversation in the current workspace, from GET /v1/support-conversations/current. */
export type CurrentSupportConversation = { id: string; status: 'open' | 'ticketed'; createdAt: string; lastMessageAt: string | null }
/** One email waiting for its sender's sign-in, as GET /v1/support-conversations/{id}/claim shows it to that sender. */
export type SupportPendingEmail = { id: string; messageId: string; subject: string | null; preview: string | null; receivedAt: string | null }
export const supportApi = (scope: RequestScope | 'unscoped') => ({
  /** The open support chat conversation for this person and workspace, or null when none is open. */
  current: () => request<{ conversation: CurrentSupportConversation | null }>('/v1/support-conversations/current', { scope }),
  /** A handoff for the chat, carrying the page this person is on and the last failed requests' IDs; with `ticket`, a
   *  message the chat couldn't take, filed for the team instead (in this person's chat, with the same page and IDs). */
  contact: (input: { shareContent: boolean; ticket?: string }) => {
    const requestIds = recentFailedRequestIds()
    return request<SupportHandoff>('/v1/contact-support', { method: 'POST', scope, body: {
      kind: 'support', page: window.location.pathname.slice(0, 200), shareContent: input.shareContent, ...(requestIds.length ? { requestIds } : {}),
      ...(input.ticket ? { ticket: { message: input.ticket } } : {}),
    } })
  },
  /** The chat's own person lets support read message content in its workspace (support/PROTOCOL.md §4.3). */
  allowContent: (conversationId: string) => request<{ id: string; contentWorkspaceId: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/content-access`, { method: 'POST', scope }),
  /** The email a sign-in link is for (its subject and when it arrived, never its content), with the claim's own checks. */
  pending: (conversationId: string, messageId: string) => request<SupportPendingEmail>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/claim?messageId=${encodeURIComponent(messageId)}`, { scope }),
  /** Confirm one emailed support request signed in: Nightmail answers it when this person's verified address wrote it. */
  claim: (conversationId: string, messageId: string) => request<{ id: string; messageId: string; mode: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/claim`, { method: 'POST', body: { messageId }, scope }),
  /** A sign-in link to the address that email came from, for a sign-in that proves no mailbox. The answer is the same
   *  whether or not one went out; address is where it goes, masked unless this session's sign-in proved it. */
  signInLink: (conversationId: string, messageId: string) => request<{ requested: true; address: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/sign-in-link`, { method: 'POST', body: { messageId }, scope }),
  /** A general answer by email, with no account access, to the address that email came from, once: whoever holds the
   *  link may ask, signed in or not. address as signInLink shows it. */
  answerByEmail: (conversationId: string, messageId: string) => request<{ outcome: 'released' | 'already_released' | 'answered' | 'already_answered'; address: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/answer-by-email`, { method: 'POST', body: { messageId }, scope }),
})

/** A change support proposed to the signed-in person (api/src/support-actions.ts): its sentence is
 *  Nightmail's own, from its records, with each name a person typed apart in `parts.labels`. */
export type SupportActionKind = 'retry_webhook_delivery' | 'test_webhook' | 'retry_inbound_delivery' | 'test_inbound_webhook' | 'redeliver_message' | 'pause_campaign'
export type SupportAction = {
  id: string; kind: SupportActionKind; status: 'proposed' | 'running' | 'done' | 'failed' | 'declined' | 'expired'; summary: string
  parts: { template: string; labels: Record<string, string> }; workspaceId: string; target: Record<string, string>; url: string
  result: Record<string, unknown> | null; error: { code: string; message: string } | null
  /** A done test or retry's delivery as it stands now: done only means it was queued. */
  delivery: { status: 'pending' | 'delivered' | 'failed' | 'paused'; attempts: number; statusCode: number | null } | null
  createdAt: string; expiresAt: string; resolvedAt: string | null
}
// Only the person it was proposed to reads or decides it, with their own dashboard session; anyone else gets 404.
const action = (id: string) => `/v1/support-actions/${encodeURIComponent(id)}`
export const supportActionsApi = (scope: RequestScope) => ({
  get: (id: string, signal?: AbortSignal) => request<SupportAction>(action(id), { signal, scope }),
  confirm: (id: string) => request<SupportAction>(`${action(id)}/confirm`, { method: 'POST', scope }),
  decline: (id: string) => request<SupportAction>(`${action(id)}/decline`, { method: 'POST', scope }),
})
