import { request, type RequestScope } from './live'

// GET /v1/usage (hosted only): the price and the free allowances (sent and received, counted separately), whether
// billing charges yet, this month's counts and the daily sending limit with the steps it grows through. Every workspace
// member may read it; the received count is null for members, because it includes unrouted and spam mail they can't open. The balance
// itself is GET /v1/billing (data/billing.ts).
export interface UsageStep { cap: number; requires: string }
export interface Usage {
  billing: { enabled: boolean; enforcement: 'off' | 'shadow' | 'enforce' }
  pricing: { currency: 'USD'; perThousand: number; freeEmails: number; freeSentEmails: number; freeReceivedEmails: number; freeStorageBytes: number }
  month: { from: string; sent: number; received: number | null; billedSent: number; billedReceived: number | null }
  daily: { cap: number | null; used: number; resetAt: string | null; step: number | null } | null
  steps: UsageStep[]
  simulated: boolean
}
export const usageApi = (scope: RequestScope | 'unscoped') => ({ get: (signal?: AbortSignal) => request<Usage>('/v1/usage', { signal, scope }) })
