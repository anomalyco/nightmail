import { useQueryClient } from '@tanstack/react-query'
import { request, type RequestScope } from './live'
import type { CreatedWorkspaceInvitation, Identity, WorkspaceInvitation, WorkspaceInvitationPreview, WorkspaceMember, WorkspaceMembership, WorkspaceRole } from './types'

// Multi-tenant workspace administration. Only reachable when /v1/me reports multiTenant; the memberships come with it (identity.workspaces).
const current = '/v1/workspaces/current'
export const workspaceApi = (scope: RequestScope | 'unscoped') => ({
  create: (name: string) => request<WorkspaceMembership>('/v1/workspaces', { method: 'POST', body: { name }, scope }),
  rename: (name: string) => request<WorkspaceMembership>(current, { method: 'PATCH', body: { name }, scope }),
  members: async (signal?: AbortSignal) => (await request<{ data: WorkspaceMember[] }>(`${current}/members`, { signal, scope })).data,
  updateMember: (id: string, role: WorkspaceRole) => request<{ id: string; role: WorkspaceRole }>(`${current}/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role }, scope }),
  removeMember: (id: string) => request(`${current}/members/${encodeURIComponent(id)}`, { method: 'DELETE', scope }),
  invitations: async (signal?: AbortSignal) => (await request<{ data: WorkspaceInvitation[] }>(`${current}/invitations`, { signal, scope })).data,
  invite: (input: { email: string; role: WorkspaceRole }) => request<CreatedWorkspaceInvitation>(`${current}/invitations`, { method: 'POST', body: input, scope }),
  revokeInvitation: (id: string) => request(`${current}/invitations?id=${encodeURIComponent(id)}`, { method: 'DELETE', scope }),
  // The invitation the signed-in recipient followed. Reading it changes nothing; only accept joins.
  reviewInvitation: (id: string, signal?: AbortSignal) => request<WorkspaceInvitationPreview>(`/v1/workspaces/invitations/${encodeURIComponent(id)}`, { signal, scope }),
  acceptInvitation: (id: string) => request<{ workspaceId: string }>(`/v1/workspaces/invitations/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {}, scope }),
})
export const roleLabel: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
// The memberships arrive with the session (GET /v1/me): keep a rename in step without another request, or reread them.
export function useMembershipCache() {
  const client = useQueryClient()
  return {
    renamed: (workspace: Pick<WorkspaceMembership, 'id' | 'name'>) => client.setQueryData<Identity>(['identity'], old => old && { ...old, workspaces: old.workspaces?.map(item => item.id === workspace.id ? { ...item, name: workspace.name } : item) }),
    refresh: () => client.invalidateQueries({ queryKey: ['identity'] }),
  }
}
