// getInboundOverview: the Mail routing page in one read (routes page, counts, rules, endpoints, domains).
import { useApiQuery } from '../../data/context'
import { request, type RequestScope } from '../../data/live'
import type { Api, InboundAddress, MailboxDomain } from '../../data/types'

export type TargetType = 'inbox' | 'webhook' | 'slack' | 'discord' | 'forward' | 'store' | 'drop' | 'create_address'
export type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused'
export type Target = { type: TargetType; id: string | null; name: string; detail: string | null; via: string | null; status: EndpointStatus | null }
export type RouteKind = 'address' | 'inbox' | 'route' | 'pattern' | 'catch_all'
export type RouteEntry = {
  id: string; kind: RouteKind; match: string; host: string
  address: InboundAddress | null
  route: { id: string; enabled: boolean; to: string[] | 'drop' } | null
  catchAll: 'store' | 'create_address' | null
  rules: string[]; to: Target[]
  /** The complete list's size; more than to.length only when toTruncated (more webhook subscribers than listed). */
  toTotal: number; toTruncated: boolean; toMore: string | null
}
export type RecipeRef = { id: string; params: Record<string, string | string[]> }
/** A rule as the list shows it: made from a recipe (its sentence) or a script, on or off, and when it last acted. */
export type OverviewRule = { key: string; calls: string[]; delivers: string[]; decisions: string[]; /** Each decision's question (testRules' scores keys). */ questions?: string[]; attachedTo: string[]; addresses: string[]; recipe: RecipeRef | null; enabled: boolean; lastMatchedAt: string | null }
export type OverviewEndpoint = { id: string; source: 'endpoint' | 'inbound_webhook'; name: string; type: 'webhook' | 'slack' | 'discord' | 'forward'; status: EndpointStatus; target: string; call: string | null; eventTypes: string[]; routes: number; rules: string[] }
/** A domain as the overview lists it: its receiving host, receiving status and catch-all. */
/** `domain`: the domain itself, where `name` is its first receiving host; `hosts`: every host it receives at. */
export type OverviewDomain = Pick<MailboxDomain, 'id' | 'name' | 'status' | 'catchAll'> & { domain?: string; hosts?: string[] }
export type Overview = {
  counts: { address: number; auto: number; route: number; pattern: number; catch_all: number; inbox: number }
  routes: { data: RouteEntry[]; nextCursor: string | null }
  rules: OverviewRule[]; endpoints: OverviewEndpoint[]; endpointsTruncated: boolean; domains: OverviewDomain[]; manage: boolean
  /** The routing and rules version this was read at: setInboundAddressFlow's If-Match. */
  version?: number
}
export type OverviewQuery = { kind?: string; origin?: 'api' | 'auto'; domain?: string; q?: string; cursor?: string; limit?: number }

/** listInboundEndpoints: every endpoint a page at a time, or with addressId the webhooks that get that address's received mail. */
export type EndpointPage = { data: OverviewEndpoint[]; nextCursor: string | null }
export type EndpointQuery = { addressId?: string; cursor?: string; limit: number }
export const endpointsKey = (query: EndpointQuery) => ['inbound-endpoints', query.addressId ?? '', query.cursor ?? '', query.limit] as const
export function useEndpointPage(query: EndpointQuery, enabled = true) {
  return useApiQuery(endpointsKey(query), (api, signal) => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
    return request<EndpointPage>(`/v1/inbound/endpoints?${params}`, { signal, scope: api.scope })
  }, { keepPrevious: true, enabled })
}
export const overviewKey = (query: OverviewQuery) => ['inbound-overview', query.kind ?? '', query.origin ?? '', query.domain ?? '', query.q ?? '', query.cursor ?? '', query.limit ?? 50] as const
export const readOverview = (query: OverviewQuery, scope: RequestScope | 'unscoped', signal?: AbortSignal) => {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
  return request<Overview>(`/v1/inbound/overview${params.size ? `?${params}` : ''}`, { signal, scope })
}
export function useOverview(query: OverviewQuery, keepPrevious = false, enabled = true) {
  return useApiQuery(overviewKey(query), (api, signal) => readOverview(query, api.scope, signal), { keepPrevious, enabled })
}
// The Routes tab's first read with no filters, shared with the sidebar prefetch so both use one cache key.
export const firstOverview: OverviewQuery = { limit: 50 }
export const overviewQuery = (query: OverviewQuery) => ({ key: overviewKey(query), read: (api: Api, signal: AbortSignal) => readOverview(query, api.scope, signal) })

export const receivingDomains = <D extends Pick<MailboxDomain, 'status'>>(domains: D[]) => domains.filter(d => !['off', 'disabled'].includes(d.status))
export { ago } from '../../lib/format'
export const expiresIn = (iso: string | null | undefined) => {
  if (!iso) return null
  const hours = Math.round((Date.parse(iso) - Date.now()) / 3_600_000)
  return hours <= 0 ? 'Expired' : hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} days`
}
export const typeLabel: Record<TargetType, string> = { inbox: 'Inbox', webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward', store: 'Stored', drop: 'Dropped', create_address: 'New address' }
