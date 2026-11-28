import { connectionApi } from './connections'
import { ApiError, type InboundThreadView, type Api, type LogDirection, type LogFacetInput, type PageRequest, type Stream, type TimeRange } from './types'
import { usageApi } from './usage'
import { billingApi } from './billing'
import { workspaceApi } from './workspaces'

// The first-screen queries of the sidebar pages, defined once: a page reads them through useApiDef and
// data/prefetch.ts warms the very same keys and readers before the page is opened.
export type QueryDef<T> = { key: readonly unknown[]; read: (api: Api, signal: AbortSignal) => Promise<T> }
const def = <T>(key: readonly unknown[], read: QueryDef<T>['read']): QueryDef<T> => ({ key, read })

export const queries = {
  overview: (regionId: string, range: TimeRange, stream: Stream | 'all') => def(['overview', regionId, range, stream], (api, signal) => api.overview.get({ regionId, range, stream: stream === 'all' ? undefined : stream }, signal)),
  recentCampaigns: (regionId: string) => def(['campaigns', 'recent', regionId], (api, signal) => api.campaigns.list({ regionId, pageSize: 4 }, signal)),
  senderScore: () => def(['sender-score'], (api, signal) => api.senderScore.get(signal)),
  emails: (params: PageRequest) => def(['emails', params], (api, signal) => api.emails.list(params, signal)),
  logs: (params: PageRequest & { direction?: LogDirection }, visibility?: string | null) => def(visibility === undefined ? ['logs', params] : ['logs', params, visibility], (api, signal) => api.logs.list(params, signal)),
  logFacets: (input: LogFacetInput, view: string) => def(['logs', 'facets', view, input], (api, signal) => api.logs.facets(input, signal)),
  inboundDomains: () => def(['mailbox-domains'], (api, signal) => api.mailboxes.domains(signal)),
  inboundWebhooks: (cursor?: string) => def(['inbound-webhooks', cursor ?? null], (api, signal) => api.inbound.webhooks(signal, cursor)),
  forwardEndpoints: () => def(['forward-endpoints'], (api, signal) => api.inbound.forwards(signal)),
  routing: () => def(['routing'], (api, signal) => api.routing.routes(signal)),
  receivingAddresses: (search: string, cursor: string | undefined) => def(['inbound-addresses', 'address', search, cursor ?? null], (api, signal) => api.inbound.addresses({ kind: 'address', search: search || undefined, cursor }, signal)),
  // First page of receiving addresses for pickers (100 addresses; callers check nextCursor to paginate or disclose more).
  inboundAddressOptions: (cursor?: string) => def(['inbound-addresses', 'options', cursor ?? null], (api, signal) => api.inbound.addresses({ cursor }, signal)),
  inboundThreads: (addressId: string | undefined, view: InboundThreadView, q: string, cursor: string | undefined) => def(['inbound-threads', addressId ?? null, view, q, cursor ?? null], (api, signal) => api.inbound.threads({ addressId, view, q: q || undefined, cursor }, signal)),
  email: (id: string) => def(['email', id], (api, signal) => api.emails.get(id, signal)),
  receivedEmail: (id: string, canAdminister: boolean) => def(['received-email', id, canAdminister], (api, signal) => api.mailboxes.receivedEmail(id, signal, canAdminister)),
  campaign: (id: string) => def(['campaign', id], (api, signal) => api.campaigns.get(id, signal)),
  template: (id: string) => def(['template', id], (api, signal) => api.templates.get(id, signal)),
  domain: (id: string) => def(['domain', id], (api, signal) => api.domains.get(id, signal)),
  newsletter: (id: string) => def(['newsletter', id], (api, signal) => api.newsletters.get(id, signal)),
  newsletters: (cursor?: string) => def(['newsletters', cursor ?? null], (api, signal) => api.newsletters.list(signal, cursor)),
  campaigns: (request: PageRequest & { archived?: boolean; listId?: string; newsletter?: boolean }) => def(['campaigns', request], (api, signal) => api.campaigns.list(request, signal)),
  contacts: (params: PageRequest) => def(['contacts', params], (api, signal) => api.contacts.list(params, signal)),
  audienceLists: (search = '', cursor?: string) => def(['lists', 'options', { pageSize: 100, search, cursor }], async (api, signal) => {
    const page = await api.lists.list({ pageSize: 100, search, cursor, counts: false }, signal)
    return Object.assign(page.items, { nextCursor: page.nextCursor ?? null })
  }),
  // Overview's setup steps and next steps: domains, key, webhook and invitation counts and whether mail exists, in one request.
  overviewSetup: () => def(['overview-setup'], (api, signal) => api.overview.setup(signal)),
  domains: (regionId: string, page: number) => def(['domains', regionId, page], (api, signal) => api.domains.list({ regionId, page, pageSize: 10 }, signal)),
  keys: (cursor: string | undefined, showRevoked: boolean) => def(['keys', cursor, showRevoked], (api, signal) => api.keys.list(signal, cursor, showRevoked)),
  keyChanges: (id: string) => def(['key-changes', id], (api, signal) => api.keys.changes(id, signal)),
  // Connected agents with the tokens they made here. With inactive ones: Settings → Account and the rules page read
  // the same list (your own sign-ins, `own`), so they share the cache.
  agents: (includeInactive: boolean) => def(['agents', includeInactive], (api, signal) => api.credentials.agents(includeInactive, signal)),
  /** One of your own sign-ins (another account's is not in your list). */
  ownAgent: (id: string) => def(['agents', 'own', id], async (api, signal) => {
    const found = (await api.credentials.agents(true, signal)).find(agent => agent.own && agent.id === id)
    if (!found) throw new ApiError('Agent was not found.', 'NOT_FOUND', {}, undefined, 404)
    return found
  }),
  appPasswords: () => def(['app-passwords'], (api, signal) => api.credentials.appPasswords(signal)),
  webhooks: (cursor?: string) => def(['webhooks', cursor], (api, signal) => api.webhooks.list(signal, cursor)),
  connection: () => def(['connection'], (api, signal) => connectionApi(api.scope).get(signal)),
  usage: () => def(['usage'], (api, signal) => usageApi(api.scope).get(signal)),
  billing: () => def(['billing'], (api, signal) => billingApi(api.scope).get(signal)),
  /** The workspace's name and postal address (GET /v1/settings/workspace): Settings and the campaign send prompt share it. */
  workspaceSettings: () => def(['workspace-settings'], (api, signal) => api.workspace.settings(signal)),
  billingLedger: (cursor: string | undefined) => def(['billing-ledger', cursor ?? null], (api, signal) => billingApi(api.scope).ledger(cursor, signal)),
  billingPayments: (cursor: string | undefined) => def(['billing-payments', cursor ?? null], (api, signal) => billingApi(api.scope).payments(cursor, signal)),
  // This month by meter (UTC): Plan & usage's AI decision count.
  billingMonth: () => def(['billing-usage', 'month'], (api, signal) => billingApi(api.scope).usage({ granularity: 'month' }, signal)),
  workspaceMembers: () => def(['workspace-members'], (api, signal) => workspaceApi(api.scope).members(signal)),
  workspaceInvitations: () => def(['workspace-invitations'], (api, signal) => workspaceApi(api.scope).invitations(signal)),
}
