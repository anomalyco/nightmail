import { request } from './live'
import type { SenderScore, SenderStanding, StandingStep } from './types'

// The operator API (/v1/operator/*): Nightmail staff with a platform role act on any Hosted workspace through one audited
// path. It is left out of the public SDK, so the /operator area calls it with the dashboard's own request helper.
export interface OperatorQueueItem { workspaceId: string; name: string; step: StandingStep; since: string; score: number | null; /** Null: no daily limit. */ dailyLimit: number | null; reasons: { code: string; message: string }[]; paused: boolean; quarantined: number; watch: boolean; strikes: number }
export interface OperatorDomain { name: string; region: string | null; pool: string; dkim: boolean; mailFrom: boolean; dmarc: string | null }
/** What Nightmail last applied to one regional SES tenant; none listed means never switched (enabled). */
export interface OperatorTenant { region: string; applied: 'ENABLED' | 'DISABLING' | 'DISABLED'; generation: number; appliedAt: string }
export interface OperatorMember { userId: string; email: string; role: string }
export interface OperatorCampaign { id: string; name: string; state: string; pauseReason: { code?: string; message?: string } | null; quarantines: number }
export interface OperatorWorkspace {
  workspace: { id: string; name: string; createdAt: string }; score: SenderScore; standing: SenderStanding | null
  connection: { region: string; paused: boolean; resuming: boolean; pauseReason: string | null; tenantGeneration: number; tenants: OperatorTenant[] } | null
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
/** workspaceId 'platform': a change to no one workspace (an operator role, a person's billing, the sign-up limit). */
export interface OperatorAction { at: string; workspaceId: string; action: string; operatorId: string | null; operatorEmail: string | null; via: string | null; reason: string | null; ticketRef: string | null; requestId: string | null; before: unknown; after: unknown; details: unknown }
/** The sign-up limit (api/src/signups.ts) and what fills it: accounts that signed up, places held for waiting addresses, and the rest. */
export interface SignupPlaces { limit: number; signedUp: number; held: number; waiting: number; open: number }
/** How a raise gives out the places it adds: held for the oldest waiting addresses (each emailed), or open to anyone. */
export type SignupRaise = 'hold' | 'open'
/** One workspace on the Sign-ups tab. standing is pause while its sending is paused, and null without hosted sending. */
export interface WorkspaceSummary { id: string; name: string; createdAt: string; owner: string | null; domain: string | null; domains: number; sent: number; standing: StandingStep | null }
/** One address on the waitlist: a verified sign-in nothing admitted yet (api/src/account-login.ts). */
export interface WaitlistEntry { email: string; name: string | null; attempts: number; firstAt: string; lastAt: string; /** When a raise of the sign-up limit held a place for it. */ letInAt: string | null; /** The email saying it can sign in. */ emailed: 'queued' | 'sent' | 'failed' | null }
/**
 * Health (GET /v1/operator/health, api/src/health.ts): the alerts that are open and what the minute tick last measured.
 * IDs and counts only. A section is null when its probe failed on the last tick: unknown, not fine.
 */
export interface HealthAlert { key: string; kind: string; label: string; severity: 'critical' | 'warning'; value: number; unit: string; words: string; since: string; sentAt: string | null; runbook: string }
export interface HealthCampaign { id: string; workspaceId: string; state: string; total: number; released: number; rate: number | null; acceptedRate: number | null; entitled: number | null; account: number | null; planned: number | null; etaSeconds: number | null; waiting: string | null; settled: number | null; bounceRate: number | null; behind: boolean }
export interface OperatorHealth {
  generatedAt: string | null; stale: boolean; delivery: 'slack' | 'off'; alerts: HealthAlert[]
  queues: { name: string; depth: number; oldestSeconds: number; behind: boolean; wake?: boolean }[]
  jobs: { type: string; pending: number; oldestSeconds: number; failed: number; failedLastHour: number; error: string | null; behind: boolean }[] | null
  campaigns: HealthCampaign[] | null; feedbackLagSeconds: number | null
  routes: { route: string; count: number; errors: number; p50Ms: number; p95Ms: number; slowestMs: number; behind: boolean }[] | null
  errors: { kind: 'code' | 'sqlstate' | 'error'; code: string; count: number }[] | null; requests: { count: number; errors: number } | null
  database: { connections: number; maxConnections: number; longTransactions: number; oldestTransactionSeconds: number; slowQueries: number; lockWaits: number; sizeBytes: number; diskBytes: number | null } | null
}
/**
 * Glass (GET /v1/operator/glass, api/src/glass.ts): everything going on in the installation in one read, cached 5 s.
 * A Day is a rolling 24 hours (the current hour and the 23 before it) and the 24 hours before those.
 * Money is integer micro-cents as strings; a Count stopped at its cap when atLeast.
 */
export type GlassCount = { n: number; atLeast: boolean }
export type GlassHour = { accepted: number; marketing: number; delivered: number; bounced: number; complained: number }
export type GlassGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
export type GlassDay = { last: number; previous: number }
export type GlassRequests = { requests: number; errors4xx: number; errors5xx: number }
export type GlassRegion = { region: string; place: string; sending: boolean; receiving: boolean; maxSendRate: number | null; max24HourSend: number | null; sentLast24Hours: number | null; checkedAt: string | null }
export interface Glass {
  generatedAt: string
  signups: { places: SignupPlaces; today: { open: number; waitlist: number }; week: { open: number; waitlist: number }; daily: number[]; hourly: number[]; day: GlassDay
    funnel: { signedUp: number; domainAdded: number; domainVerified: number; builtinReady: number; keyCreated: number; firstSend: number } }
  sending: { perMinute: number; minutes: number[]; today: { transactional: number; marketing: number }; hourly: GlassHour[]; previous: GlassHour; queued: GlassCount; held: GlassCount
    campaigns: { id: string; name: string; workspace: string; total: number; released: number; rate: number | null }[]; sendApi: { requests: number; p50Ms: number; p95Ms: number } | null }
  delivery: { grades: Record<GlassGrade, number>; calibrating: number; paused: number; held: number; steps: Record<StandingStep, number>; ramping: number; rampWaiting: number }
  receiving: { today: number; spam: number; atLeast: boolean; hourly: number[]; day: GlassDay }
  builtin: { active: number; ready: number; revoked: number; parent: { name: string; ok: boolean; problem: string | null; trippedAt: string | null; resetAt: string | null; checkedAt: string } | null }
  support: { open: number; ticketed: number; hourly: number[]; day: GlassDay; configured: { chat: boolean; email: boolean } }
  screening: { compared: GlassCount; agree: number | null; jevFlagged: number; jevfFlagged: number; jevFailed: number; jevfFailed: number; screened: number; rejected: number; hourly: number[] }
  api: { hourly: GlassRequests[]; previous: GlassRequests; p50Ms: number | null; p95Ms: number | null }
  money: { creditToday: string; creditMonth: string; creditDaily: number[]; owed: string; owing: number; usageMonth: string }
  system: { status: 'ok' | 'warning' | 'critical' | 'stale'; measuredAt: string | null
    alerts: { critical: number; warning: number; top: { key: string; label: string; severity: 'critical' | 'warning'; words: string; since: string }[] }
    ses: { regions: GlassRegion[]; total: { maxSendRate: number; max24HourSend: number; sentLast24Hours: number } }
    deploy: { sha: string | null; at: string | null } }
  visitors: { views: number; day: GlassDay; visitors: GlassCount; hourly: number[]; referrers: { host: string; views: number }[]; through: string | null }
}
/** Glass's Deliverability board (GET /v1/operator/glass/deliverability, api/src/glass-deliverability.ts): our mail by
 *  mailbox provider, kind and region for a period and the one before (cube), the period by bucket (series), each pool
 *  region's SES health and Amazon VDM estimates, Spamhaus DBL, standing and the workspaces with the most complaints and
 *  bounces. Cached 30 s; the page filters the cube itself. */
export type DeliverabilityWindow = '24h' | '7d' | '30d'
export type MailProvider = 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'proton' | 'gmx' | 'other'
export type DeliverabilityCounts = { accepted: number; delivered: number; hardBounced: number; softBounced: number; deferred: number; complained: number; opened: number; humanOpened: number; clicked: number }
export type VdmCounts = { send: number; delivery: number; permanentBounce: number; transientBounce: number; complaint: number; deliveryComplaint: number; open: number; deliveryOpen: number; click: number; deliveryClick: number }
type CheckState = { status: string | null; checkedAt: string | null }
export interface Deliverability {
  window: DeliverabilityWindow; generatedAt: string; since: string; until: string; previousSince: string; coverageFrom: string | null; unit: 'hour' | 'day'
  cube: { provider: MailProvider; kind: string; region: string; current: DeliverabilityCounts; previous: DeliverabilityCounts }[]
  series: ({ at: string; kind: string; region: string } & DeliverabilityCounts)[]
  regions: { region: string; place: string; sending: boolean
    ses: CheckState & { enforcement: string | null; sendingEnabled: boolean | null; productionAccess: boolean | null; vdm: boolean | null; engagement: boolean | null; error: string | null }
    vdm: CheckState & { error: string | null; since: string; until: string; previousSince: string; providers: { provider: MailProvider | 'all'; current: VdmCounts; previous: VdmCounts }[] } }[]
  blocklist: (CheckState & { domain: string })[]
  postmaster: (CheckState & { domain: string; url: string; error: string | null; spamRatio: { current: number | null; previous: number | null }
    latest: { day: string; spamRatio: number | null; spf: number | null; dkim: number | null; dmarc: number | null; deliveryErrorRatio: number | null } | null })[]
  standing: { grades: Record<GlassGrade, number>; calibrating: number; steps: Record<StandingStep, number> }
  top: Record<'complaints' | 'bounces', { workspaceId: string; accepted: number; bounced: number; complained: number }[]>
}
/** Glass's activity feed (GET /v1/operator/glass/activity): the newest 50 events, newest first, each once by its id. */
export type GlassEventKind = 'signup' | 'first_send' | 'domain_verified' | 'builtin_ready' | 'campaign_launched' | 'campaign_paused' | 'standing' | 'breaker' | 'alert' | 'link_fallback'
export interface GlassEvent { id: string; at: string; kind: GlassEventKind; workspace: { id: string; name: string } | null; subject: string | null; detail: string | null
  place: 'open' | 'waitlist' | null; email: string | null; tone: 'neutral' | 'success' | 'warning' | 'danger' }
export interface GlassActivity { events: GlassEvent[]; generatedAt: string }
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
  queue: async (input: { step?: StandingStep; q?: string }, signal?: AbortSignal) => (await request<{ data: OperatorQueueItem[] }>(`${base}/workspaces${query({ step: input.step, q: input.q?.trim(), limit: 200 })}`, { signal })).data,
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
  signups: (signal?: AbortSignal) => request<SignupPlaces>(`${base}/signups`, { signal }),
  health: (signal?: AbortSignal) => request<OperatorHealth>(`${base}/health`, { signal }),
  glass: (signal?: AbortSignal) => request<Glass>(`${base}/glass`, { signal }),
  glassDeliverability: (window: DeliverabilityWindow, signal?: AbortSignal) => request<Deliverability>(`${base}/glass/deliverability?window=${window}`, { signal }),
  /** after: the newest event's time the page has; the answer is the events at or after it. */
  glassActivity: (after?: string, signal?: AbortSignal) => request<GlassActivity>(`${base}/glass/activity${after ? `?after=${encodeURIComponent(after)}` : ''}`, { signal }),
  setSignupLimit: (limit: number, raise: SignupRaise, guard: OperatorGuard) => request<SignupPlaces & { letIn: number; emailed: number; notEmailed: number | null }>(`${base}/signups`, { method: 'PUT', body: { limit, raise }, idempotencyKey: guard.idempotencyKey }),
  allWorkspaces: async (input: { cursor?: string }, signal?: AbortSignal) => {
    const page = await request<{ data: WorkspaceSummary[]; nextCursor: string | null }>(`${base}/signups/workspaces${query({ cursor: input.cursor, limit: 100 })}`, { signal })
    return { items: page.data, nextCursor: page.nextCursor }
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
