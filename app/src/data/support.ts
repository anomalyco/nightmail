import { recentFailedRequestIds, request } from './live'

// The in-app support handoff (hosted): POST /v1/contact-support opens a support conversation for this workspace.
// `url` is the support platform's page for it, when one is configured; otherwise the reference `id` goes in an email.
export type SupportHandoff = { id: string; url: string | null; token: string | null; expiresAt: string; shareContent: boolean }
/** One email waiting for its sender's sign-in, as GET /v1/support-conversations/{id}/claim shows it to that sender. */
export type SupportPendingEmail = { id: string; messageId: string; subject: string | null; receivedAt: string | null }
export const supportApi = {
  contact: (input: { shareContent: boolean; message?: string }) => {
    const requestIds = recentFailedRequestIds()
    return request<SupportHandoff>('/v1/contact-support', { method: 'POST', body: {
      kind: 'support', page: window.location.pathname.slice(0, 200), shareContent: input.shareContent,
      ...(requestIds.length ? { requestIds } : {}), ...(input.message ? { message: input.message } : {}),
    } })
  },
  /** The chat's own person lets support read message content in its workspace (support/PROTOCOL.md §4.3). */
  allowContent: (conversationId: string) => request<{ id: string; contentWorkspaceId: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/content-access`, { method: 'POST' }),
  /** The email a sign-in link is for (its subject and when it arrived, never its content), with the claim's own checks. */
  pending: (conversationId: string, messageId: string) => request<SupportPendingEmail>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/claim?messageId=${encodeURIComponent(messageId)}`),
  /** Confirm one emailed support request signed in: Nightmail answers it when this person's verified address wrote it. */
  claim: (conversationId: string, messageId: string) => request<{ id: string; messageId: string; mode: string }>(`/v1/support-conversations/${encodeURIComponent(conversationId)}/claim`, { method: 'POST', body: { messageId } }),
}

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
export const supportActionsApi = {
  get: (id: string, signal?: AbortSignal) => request<SupportAction>(action(id), { signal }),
  confirm: (id: string) => request<SupportAction>(`${action(id)}/confirm`, { method: 'POST' }),
  decline: (id: string) => request<SupportAction>(`${action(id)}/decline`, { method: 'POST' }),
}
