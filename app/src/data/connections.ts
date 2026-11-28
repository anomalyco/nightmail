import { useQueryClient } from '@tanstack/react-query'
import { request, type RequestScope } from './live'
import type { ConnectionKind, DisconnectSummary, Identity, ProviderConnection } from './types'

// Multi-tenant sending connection. Owner/admin dashboard sessions only.
const path = '/v1/connection'
export const connectionApi = (scope: RequestScope | 'unscoped') => ({
  get: async (signal?: AbortSignal) => (await request<{ connection: ProviderConnection | null }>(path, { signal, scope })).connection,
  create: (input: { kind: ConnectionKind; region?: string }) => request<ProviderConnection>(path, { method: 'POST', body: input, scope }),
  verify: (awsAccountId: string) => request<ProviderConnection>(`${path}/verify`, { method: 'POST', body: { awsAccountId }, scope }),
  // A connected AWS account answers with its cleanup and what stays in the account; any other connection is gone at once.
  remove: () => request<{ deleted: true } | { operationId: string; summary: DisconnectSummary }>(path, { method: 'DELETE', scope }),
  // A connected AWS account: import domains found in it, add a new one in a region, and ask AWS for production access.
  importDomains: (revision: number, candidateIds: string[]) => request<{ operationId: string; regions: string[] }>(`${path}/imports`, { method: 'POST', body: { revision, candidateIds, confirm: true }, scope }),
  addDomain: (name: string, region: string) => request<{ operationId: string; regions: string[] }>('/v1/domains', { method: 'POST', body: { name, region }, scope }),
  // Prepares a change set of the account's stack to the newest template; the customer reviews and runs it in AWS.
  updateStack: () => request<{ version: string; changeSetId: string; consoleUrl: string }>(`${path}/stack/update`, { method: 'POST', scope }),
  rescan: () => request<{ operationId: string; revision: number }>(`${path}/scan`, { method: 'POST', scope }),
  requestProductionAccess: (region: string, input: { websiteUrl: string; useCase: string; mailType: 'TRANSACTIONAL' | 'MARKETING' }) => request<{ region: string; production: boolean; review: { status: string; caseId: string | null } | null }>(`${path}/regions/${encodeURIComponent(region)}/production-access`, { method: 'POST', body: { ...input, confirm: true }, scope }),
})
export const connectionKindLabel: Record<ConnectionKind, string> = { shared: 'Hosted mail', byo: 'Your AWS account' }
// AWS still confirming a bring-your-own setup; repeating the verify request resumes it.
export const retryableConnectionErrors = new Set(['CONNECTION_BUSY', 'SNS_CONFIRMATION_PENDING', 'PROVISIONING_INCOMPLETE', 'AWS_SETUP_TIMEOUT', 'AWS_THROTTLED'])
// Keeps the full connection and the /v1/me summary (which gates the app) in step.
export function useConnectionCache() {
  const client = useQueryClient()
  return (connection: ProviderConnection | null) => {
    client.setQueryData(['nightmail', 'connection'], connection)
    client.setQueryData<Identity>(['identity'], old => old && { ...old, connection: connection && { kind: connection.kind, region: connection.region, state: connection.state, tenant: connection.tenant } })
  }
}
