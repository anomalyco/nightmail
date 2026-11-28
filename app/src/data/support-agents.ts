import { request, type RequestScope } from './live'
import { productName } from '../../../api/src/brand'
import { mcpServerUrl } from '../../../api/src/mcp-clients'

// A staff member's agents in the support inbox (/v1/operator/support-agents, api/src/support-agents.ts): an agent signed
// in over MCP as an operator asks with a code and a link; its person approves it here, from a staff session, and sees and
// revokes what they approved.
export interface SupportAgentConnection { connectionId: string; /** The connection's own claim, never verified. */ client: string | null; profile: string | null; connectedAt: string }
export interface SupportAgentRequest { userCode: string; agent: SupportAgentConnection; status: 'pending' | 'approved' | 'denied' | 'expired'; createdAt: string; expiresAt: string; can: string; never: string; days: number }
export interface SupportAgentApproval { id: string; agent: SupportAgentConnection; approvedAt: string; expiresAt: string; lastUsedAt: string | null }

const base = '/v1/operator/support-agents'
export const supportAgentsKey = ['operator', 'support-agents'] as const
export const supportAgentsApi = (scope: RequestScope) => ({
  list: (signal?: AbortSignal) => request<{ data: SupportAgentApproval[] }>(base, { signal, scope }),
  lookUp: (userCode: string, signal?: AbortSignal) => request<SupportAgentRequest>(`${base}/lookup`, { method: 'POST', body: { userCode }, signal, scope }),
  approve: (userCode: string) => request<SupportAgentApproval>(`${base}/approve`, { method: 'POST', body: { userCode }, scope }),
  deny: (userCode: string) => request<{ userCode: string; status: 'denied' }>(`${base}/deny`, { method: 'POST', body: { userCode }, scope }),
  revoke: (id: string) => request<{ id: string; revoked: true }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE', scope }),
})

/** What Copy for your agent copies: connect signed in as you, then the support inbox; the first call asks for approval. */
export const supportAgentPrompt = (origin: string) => `Connect to ${productName}'s MCP server at ${mcpServerUrl(origin)} and sign in as me. Then use supportInbox to tell me what's waiting in support. The first time, it gives you a link and a code: show me both so I can approve you.`
