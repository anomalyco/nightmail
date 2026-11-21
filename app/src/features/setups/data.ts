import { useQueryClient } from '@tanstack/react-query'
import { useApiQuery } from '../../data/context'
import { request } from '../../data/live'

// Pitch (branch pitch/setups): what a workspace has set up, and the newsletter as a thing you open. The API has no
// /v1/setups; app/scripts/setups-pitch.mjs stands in for it. Underneath, an issue is a campaign and readers are a list.
export type SetupKind = 'newsletter' | 'app' | 'campaigns' | 'support' | 'agent'
export type SetupRole = 'owner' | 'admin' | 'member' | 'writer'
export interface SetupSummary { id: string; kind: SetupKind; name: string; waiting: number }
export interface Setups {
  /** The caller's role: in the workspace, or on the one newsletter they were invited to (`only`). */
  role: SetupRole; only: string | null
  has: { app?: boolean; audience?: boolean; domains?: boolean; receiving?: boolean; campaigns?: boolean }
  setups: SetupSummary[]
}
export interface Issue { id: string; number: number; subject: string; state: 'draft' | 'requested' | 'scheduled' | 'sent'; sentAt?: string; updatedAt?: string; scheduledAt?: string; sendAt?: string; recipients?: number; opened?: number; clicked?: number; by?: string; approvedBy?: string; html?: string }
export interface Person { id: string; name: string; email: string; role: SetupRole }
export interface SendRequest { id: string; issueId: string; by: string; at: string; issue: Issue }
export interface Newsletter {
  id: string; kind: 'newsletter'; name: string; from: string; readers: number; joined: number; growth: { at: string; readers: number }[]
  form: { page: string; tag: string }; issues: Issue[]; people: Person[]; invitations: { email: string; role: SetupRole }[]; requests: SendRequest[]
  role: SetupRole; can: { send: boolean; invite: boolean }
}

export const useSetups = () => useApiQuery(['setups'], (_api, signal) => request<Setups>('/v1/setups', { signal }))
export const useNewsletter = (id: string) => useApiQuery(['setups', id], (_api, signal) => request<Newsletter>(`/v1/setups/${encodeURIComponent(id)}`, { signal }))
/** A write to one newsletter: the answer is the newsletter as it now is. */
export function useNewsletterWrite(id: string) {
  const client = useQueryClient()
  return async (path: string, body: unknown = {}) => {
    const next = await request<Newsletter>(`/v1/setups/${encodeURIComponent(id)}${path}`, { method: 'POST', body })
    client.setQueryData(['nightmail', 'setups', id], next)
    void client.invalidateQueries({ queryKey: ['nightmail', 'setups'], exact: true })
    return next
  }
}
export function useCreateSetup() {
  const client = useQueryClient()
  return async (input: { kind: SetupKind; name: string; from: string }) => {
    const created = await request<{ id: string }>('/v1/setups', { method: 'POST', body: input })
    await client.invalidateQueries({ queryKey: ['nightmail', 'setups'] })
    return created
  }
}

export const roleName: Record<SetupRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', writer: 'Writer' }
export const newsletterPath = (id: string) => `/newsletters/${encodeURIComponent(id)}`
export const issuePath = (id: string, issue: string) => `${newsletterPath(id)}/issues/${encodeURIComponent(issue)}`
