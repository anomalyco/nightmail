import { request } from './live'
import type { SenderScore, SenderStanding, StandingStep } from './types'

// The operator API (/v1/operator/*): Nightmail staff with a platform role act on any Hosted workspace through one audited
// path. It is left out of the public SDK, so the /operator area calls it with the dashboard's own request helper.
export interface OperatorQueueItem { workspaceId: string; name: string; step: StandingStep; since: string; score: number | null; /** Null: no daily limit. */ dailyLimit: number | null; reasons: { code: string; message: string }[]; paused: boolean; quarantined: number; watch: boolean; strikes: number }
export interface OperatorDomain { name: string; region: string | null; pool: string; dkim: boolean; mailFrom: boolean; dmarc: string | null }
/** What Nightmail last applied to one regional SES tenant; none listed means never switched (enabled). */
export interface OperatorTenant { region: string; applied: 'ENABLED' | 'DISABLING' | 'DISABLED'; generation: number; appliedAt: string }
/** The AWS reputation policy of the workspace's SES tenants: strict on probation, standard once graduated or exempt. */
export interface OperatorTenantPolicy {
  level: 'strict' | 'standard'; why: 'exempt' | 'graduated' | 'evaluation' | 'growth' | 'standing'; standardFrom: string | null
  /** Each ready tenant: what was applied (null: not known yet) and when AWS last refused standard. */
  tenants: { region: string; applied: 'strict' | 'standard' | null; appliedAt: string | null; refusedAt: string | null }[]
}
export interface OperatorMember { userId: string; email: string; role: string }
export interface OperatorCampaign { id: string; name: string; state: string; pauseReason: { code?: string; message?: string } | null; quarantines: number }
export interface OperatorWorkspace {
  workspace: { id: string; name: string; createdAt: string }; score: SenderScore; standing: SenderStanding | null
  connection: { region: string; paused: boolean; resuming: boolean; pauseReason: string | null; tenantGeneration: number; tenants: OperatorTenant[]; policy: OperatorTenantPolicy } | null
  domains: OperatorDomain[]; members: OperatorMember[]; siblings: { id: string; name: string }[]
  override: { daily: number; expiresAt: string | null } | null; exempt: boolean; campaigns: OperatorCampaign[]
  /** Domains held and allowed: 100 unless an operator set another limit (custom). */
  domainLimit: OperatorDomainLimit
}
export interface OperatorDomainLimit { used: number; limit: number; custom: boolean }
/** Billing as an operator sees it: whether the workspace is free (not billed), why, and each member's free account. */
export interface OperatorBillingFree {
  free: boolean; via: 'workspace' | 'account' | null; until: string | null
  workspace: { at: string; until: string | null; reason: string | null; by: string | null; expired: boolean } | null
  people: { userId: string; email: string; role: string; free: { reason: string; until: string | null; grantedAt: string; grantedBy: string; live: boolean } | null }[]
}
export interface OperatorBilling { account: { mode?: string; balance_uc?: number; promo_uc?: number } | null; free: OperatorBillingFree; decisions: { month: number; day: number } }
export type FreeInput = OperatorWhy & { free: boolean; until?: string | null }
export type TimelineKind = 'standing' | 'limit' | 'quarantine' | 'release' | 'tenant' | 'operator' | 'score' | 'audit' | 'bounces' | 'rejection'
export interface OperatorTimelineItem { at: string; kind: TimelineKind; title: string; detail: unknown }
export interface OperatorAction { at: string; workspaceId: string; action: string; operatorId: string | null; via: string | null; reason: string | null; ticketRef: string | null; requestId: string | null; before: unknown; after: unknown; details: unknown }
/** One address on the waitlist: a verified sign-in nothing admitted yet (api/src/account-login.ts). */
export interface WaitlistEntry { email: string; name: string | null; attempts: number; firstAt: string; lastAt: string }
/** Abuse monitoring (/v1/operator/abuse/*): accounts and workspaces that share signals, scored for a person to review. */
export type AbuseBand = 'low' | 'watch' | 'review' | 'high'
export interface AbuseReason { code: string; points: number; count?: number }
export interface AbuseCluster { id: string; score: number; band: AbuseBand; peak: number; accounts: number; workspaces: number; reasons: AbuseReason[]; firstAt: string; changedAt: string; scoredAt: string }
export interface AbuseAccount { key: string; kind: 'user' | 'refused'; userId: string | null; email: string | null; name: string | null }
export interface AbuseWorkspace { id: string; name: string; createdAt: string; account: string | null; plan: 'free' | 'paid' | 'exempt'; sent: { used: number; limit: number }; received: { used: number; limit: number }; step: StandingStep | null; dailyLimit: number | null; sending: string | null; paused: boolean }
/** a and b are an account key (A1) or a workspace ID; kinds say what is shared and how many values, never a value. */
export interface AbuseLink { a: string; b: string; owner: boolean; strength: 'owner' | 'strong' | 'partial'; kinds: { kind: string; shared: number }[] }
export interface AbuseClusterDetail extends Omit<AbuseCluster, 'accounts' | 'workspaces'> { accounts: AbuseAccount[]; workspaces: AbuseWorkspace[]; links: AbuseLink[] }
export interface AbuseClusterPage { items: AbuseCluster[]; nextCursor: string | null; counts: Record<AbuseBand, number>; alerts: number; monitoring: boolean }
/** A Slack message as it is, or would be, posted: the blocks this page draws. */
export interface SlackCard { text: string; blocks: { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { type: string; text?: { text: string } | string; url?: string }[] }[] }
export interface AbuseAlert { id: string; clusterId: string; band: 'review' | 'high'; score: number; kind: 'new' | 'raised' | 'grew'; workspaces: number; status: 'stored' | 'sent' | 'failed'; attempts: number; createdAt: string; sentAt: string | null; payload: SlackCard }
/** An action taken from the abuse view: the note stays in the staff audit; the workspace's own records get a fixed reason. */
export type AbuseEvidence = { cluster: string; note: string; ticketRef?: string }
export type OperatorReceipt = { ok: true; version: number | null; step: string | null }
/** Every mutation carries why (10–1000 characters) and optionally the support ticket. */
export type OperatorWhy = { reason: string; ticketRef?: string }
/** One key per dialog opening, so a retried submit is answered once; If-Match is the standing version it was decided on. */
export type OperatorGuard = { idempotencyKey: string; ifMatch?: number }

// Normalizes a timestamp to ISO-8601 with milliseconds for display: the timeline and audit send ISO with microseconds,
// and JSON-built fields (createdAt) carry Postgres' offset form.
export function isoTime(value: string) {
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d\d)$/, '$1:00')
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toISOString() : value
}

const base = '/v1/operator', id = encodeURIComponent
const query = (values: Record<string, string | number | undefined>) => { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value)); const text = params.toString(); return text ? `?${text}` : '' }
const why = ({ reason, ticketRef }: OperatorWhy) => ({ reason: reason.trim(), ...ticketRef?.trim() ? { ticketRef: ticketRef.trim() } : {} })
const evidence = ({ cluster, note, ticketRef }: AbuseEvidence) => ({ evidence: { cluster, note: note.trim() }, ...ticketRef?.trim() ? { ticketRef: ticketRef.trim() } : {} })
const write = (path: string, method: 'POST' | 'PUT', body: unknown, guard: OperatorGuard) => request<OperatorReceipt>(`${base}${path}`, { method, body, idempotencyKey: guard.idempotencyKey, ifMatch: guard.ifMatch })

export const operatorApi = {
  queue: async (input: { step?: StandingStep; q?: string }, signal?: AbortSignal) => (await request<{ data: OperatorQueueItem[] }>(`${base}/workspaces${query({ step: input.step, q: input.q?.trim(), limit: 100 })}`, { signal })).data,
  workspace: (workspaceId: string, signal?: AbortSignal) => request<OperatorWorkspace>(`${base}/workspaces/${id(workspaceId)}`, { signal }),
  // Paged by the API's opaque cursor, so rows that share a timestamp are never skipped at a page boundary.
  timeline: async (workspaceId: string, cursor: string | undefined, signal?: AbortSignal) => {
    const page = await request<{ data: OperatorTimelineItem[]; nextCursor: string | null }>(`${base}/workspaces/${id(workspaceId)}/timeline${query({ cursor, limit: 50 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor }
  },
  actions: async (input: { workspaceId?: string; cursor?: string }, signal?: AbortSignal) => {
    const page = await request<{ data: OperatorAction[]; nextCursor: string | null }>(`${base}/actions${query({ workspaceId: input.workspaceId, cursor: input.cursor, limit: 50 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor }
  },
  waitlist: async (input: { q?: string; cursor?: string; limit?: number }, signal?: AbortSignal) => {
    const page = await request<{ data: WaitlistEntry[]; nextCursor: string | null; total: number }>(`${base}/waitlist${query({ q: input.q?.trim(), cursor: input.cursor, limit: input.limit ?? 100 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor, total: page.total }
  },
  pause: (workspaceId: string, input: OperatorWhy, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/pause`, 'POST', why(input), guard),
  liftGrowth: (workspaceId: string, input: OperatorWhy, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/growth/lift`, 'POST', why(input), guard),
  resume: (workspaceId: string, input: OperatorWhy & { restore: 50 | 100 }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/resume`, 'POST', { ...why(input), restore: input.restore }, guard),
  marketing: (workspaceId: string, input: OperatorWhy & { held: boolean }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/marketing`, 'PUT', { held: input.held, ...why(input) }, guard),
  limit: (workspaceId: string, input: OperatorWhy & { daily: number | null; expiresAt: string | null }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/limit`, 'PUT', { daily: input.daily, expiresAt: input.daily === null ? null : input.expiresAt, ...why(input) }, guard),
  domainLimit: (workspaceId: string, input: OperatorWhy & { limit: number | null }, guard: OperatorGuard) => request<{ ok: true; domainLimit: OperatorDomainLimit }>(`${base}/workspaces/${id(workspaceId)}/domain-limit`, { method: 'PUT', body: { limit: input.limit, ...why(input) }, idempotencyKey: guard.idempotencyKey }),
  releaseCampaign: (campaignId: string, input: OperatorWhy, guard: OperatorGuard) => write(`/campaigns/${id(campaignId)}/release`, 'POST', why(input), guard),
  abuseClusters: async (input: { band?: AbuseBand; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<AbuseClusterPage> => {
    const page = await request<{ data: AbuseCluster[] } & Omit<AbuseClusterPage, 'items'>>(`${base}/abuse/clusters${query({ band: input.band, cursor: input.cursor, limit: input.limit ?? 50 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor, counts: page.counts, alerts: page.alerts, monitoring: page.monitoring }
  },
  abuseCluster: (clusterId: string, signal?: AbortSignal) => request<AbuseClusterDetail>(`${base}/abuse/clusters/${id(clusterId)}`, { signal }),
  abuseAlerts: async (input: { cursor?: string }, signal?: AbortSignal) => {
    const page = await request<{ data: AbuseAlert[]; nextCursor: string | null; delivery: 'slack' | 'off' }>(`${base}/abuse/alerts${query({ cursor: input.cursor, limit: 50 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor, delivery: page.delivery }
  },
  abusePause: (workspaceId: string, input: AbuseEvidence, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/pause`, 'POST', evidence(input), guard),
  abuseLimit: (workspaceId: string, input: AbuseEvidence & { daily: number }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/limit`, 'PUT', { daily: input.daily, expiresAt: null, ...evidence(input) }, guard),
  billing: (workspaceId: string, signal?: AbortSignal) => request<OperatorBilling>(`${base}/billing/${id(workspaceId)}`, { signal }),
  /** Free (not billed): the workspace's own flag, or a person's (every workspace they own, bound to their sign-in). */
  workspaceFree: (workspaceId: string, input: FreeInput, guard: OperatorGuard) => request(`${base}/billing/${id(workspaceId)}/free`, { method: 'PUT', body: { free: input.free, ...input.free && input.until ? { until: input.until } : {}, ...why(input) }, idempotencyKey: guard.idempotencyKey }),
  personFree: (userId: string, input: FreeInput, guard: OperatorGuard) => request(`${base}/billing/people/${id(userId)}/free`, { method: 'PUT', body: { free: input.free, ...input.free && input.until ? { until: input.until } : {}, ...why(input) }, idempotencyKey: guard.idempotencyKey }),
}
