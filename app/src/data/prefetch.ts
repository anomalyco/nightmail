import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { rememberedPageSize } from '../lib/pagination'
import { routeHandle } from '../lib/routes'
import { useApi, useLogsVisibility, useRegion, useSession, useWorkspaceAccess } from './context'
import { queries, type QueryDef } from './queries'
import { firstOverview, overviewQuery } from '../features/inbound/overview'
import type { Api } from './types'
import { openApiQuery } from '../features/docs/openapi'
import { latestRequest } from '../features/overview/latest'
import { keptRangeStart } from '../features/logs/range'
import { issuesRequest, useNewsletters } from '../features/newsletters/shared'

// A warmed result stays fresh this long, so repeated hovers and the idle sweep never refetch it.
const FRESH = 30_000
export const sidebarPaths = ['/overview', '/logs', '/receiving', '/campaigns', '/audience', '/domains', '/api-keys', '/smtp-imap', '/settings'] as const

// newsletters: whether the workspace has any (Campaigns then leaves their issues out).
type Scope = { regionId: string; multiTenant: boolean; canAdminister: boolean; newsletters: boolean; logsVisibility: string | null; mailGateway: boolean }
/** Preloads only the JS chunk for a route (no API requests): used by the idle sweep so opening one page never scans every other page's data. */
export const preloadRouteChunk = (path: string) => routeHandle(path).handle.preload?.().catch(() => {}) ?? Promise.resolve()

// The first screen of the page currently opening (cold load). Never runs multi-page loops.
function firstScreen(path: string, { regionId, multiTenant, canAdminister, newsletters, logsVisibility, mailGateway }: Scope): QueryDef<unknown>[] {
  const scoped = multiTenant || Boolean(regionId)
  // One newsletter's page: the newsletter with its readers, and its newest issues.
  const newsletter = /^\/newsletters\/(?!new$)([^/]+)$/.exec(path)?.[1]
  if (newsletter) { const id = decodeURIComponent(newsletter); return [queries.newsletter(id), queries.campaigns(issuesRequest(id))] }
  switch (path) {
    case '/overview': return scoped ? [queries.overview(regionId, '24h', 'all'), queries.recentCampaigns(regionId), queries.senderScore(), queries.logs(latestRequest(regionId)), ...(canAdminister ? [queries.overviewSetup()] : [])] : []
    case '/logs': { const pageSize = rememberedPageSize('logs'); return scoped && pageSize && logsVisibility ? [queries.logs({ regionId, direction: 'all', search: '', status: undefined, stream: undefined, from: keptRangeStart('30d'), page: 1, pageSize }, logsVisibility)] : [] }
    // Mail routing is one read: addresses (routes), counts, rules, destinations (endpoints) and domains.
    case '/receiving': return [overviewQuery(firstOverview) as QueryDef<unknown>]
    case '/campaigns': return [queries.campaigns(campaignsRequest(newsletters))]
    case '/newsletters': return [queries.newsletters()]
    case '/audience': { const pageSize = rememberedPageSize('contacts'); return [queries.audienceLists(), ...(pageSize ? [queries.contacts({ page: 1, pageSize, search: '', status: '', listId: '' })] : [])] }
    // Self-hosted domain reads call SES for every identity (the list refreshes by default), so only hosted workspaces warm it.
    case '/domains': return multiTenant && canAdminister ? [queries.domains(regionId, 1)] : []
    case '/api-keys': return canAdminister ? [queries.keys(undefined, false), queries.agents(false), queries.appPasswords()] : []
    // SMTP & IMAP: the app passwords under its IMAP settings (the settings themselves come with the session).
    case '/smtp-imap': return canAdminister && mailGateway ? [queries.appPasswords()] : []
    // Self-hosted settings load their own region and workspace data; hosted memberships come with the session (/v1/me).
    case '/settings': return !multiTenant || !canAdminister ? [] : [queries.connection(), queries.webhooks(), queries.workspaceMembers(), queries.workspaceInvitations()]
    default: return []
  }
}

// Cheap single-page reads safe to warm on an 80 ms hover: omits heavy aggregates (/v1/metrics, /v1/logs?limit=100,
// /v1/inbound/overview), write-on-GET endpoints (/v1/newsletters/:id), and multi-page loops.
function hoverQueries(path: string, scope: Scope): QueryDef<unknown>[] {
  const { regionId, multiTenant, canAdminister } = scope
  const scoped = multiTenant || Boolean(regionId)
  const newsletter = /^\/newsletters\/(?!new$)([^/]+)$/.exec(path)?.[1]
  if (newsletter) return [queries.campaigns(issuesRequest(decodeURIComponent(newsletter)))]
  switch (path) {
    case '/overview': return scoped ? [queries.recentCampaigns(regionId), queries.senderScore(), ...(canAdminister ? [queries.overviewSetup()] : [])] : []
    case '/receiving': return []
    default: return firstScreen(path, scope)
  }
}

/** The Campaigns page's first request. With newsletters, their issues are on their own pages, not here. */
export const campaignsRequest = (newsletters: boolean) => ({ search: '', archived: false, status: undefined, page: 1, pageSize: 10, ...(newsletters ? { newsletter: false } : {}) })

export function prefetchQueries(cache: QueryClient, api: Api, defs: QueryDef<unknown>[]) {
  return Promise.allSettled(defs.map(query => cache.prefetchQuery({ queryKey: ['nightmail', ...query.key], queryFn: ({ signal }) => query.read(api, signal), staleTime: FRESH })))
}

// Warms a few queries for the current API (GET only; anything fresh or in flight is skipped).
export function usePrefetchQueries() {
  const cache = useQueryClient()
  const api = useApi()
  return useCallback((defs: QueryDef<unknown>[]) => prefetchQueries(cache, api, defs), [cache, api])
}

// Loads a sidebar page's code and warms its queries. mode='active' warms full first-screen queries for the page
// currently opening; mode='hover' warms only cheap single-page queries (never heavy aggregates or write-on-GET).
export function usePrefetchRoute(mode: 'active' | 'hover' = 'active') {
  const cache = useQueryClient()
  const api = useApi()
  const { regionId } = useRegion()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const logsVisibility = useLogsVisibility()
  const newsletters = useNewsletters().length > 0
  const mailGateway = Boolean(useSession()?.identity?.mailServers)
  return useCallback(async (path: string) => {
    const chunk = preloadRouteChunk(path)
    const defs = (mode === 'hover' ? hoverQueries : firstScreen)(path, { regionId, multiTenant, canAdminister, newsletters, logsVisibility, mailGateway })
    const data = defs.length ? prefetchQueries(cache, api, defs) : undefined
    // The docs read the public API definition, not the workspace's API.
    const docs = path === '/docs' ? cache.prefetchQuery(openApiQuery) : undefined
    await Promise.all([chunk, data, docs])
  }, [cache, api, mode, regionId, multiTenant, canAdminister, newsletters, logsVisibility, mailGateway])
}

// Hover intent: a pointer that rests on a link for a moment (not one crossing it) or focuses/presses it warms the chunk
// and cheap first-screen queries only.
export function useRouteIntent() {
  const prefetchHover = usePrefetchRoute('hover')
  const prefetchActive = usePrefetchRoute('active')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (path: string) => ({
    onPointerEnter: () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void prefetchHover(path), 80) },
    onPointerLeave: () => window.clearTimeout(timer.current),
    onPointerDown: () => { window.clearTimeout(timer.current); void prefetchActive(path) },
    onFocus: () => { window.clearTimeout(timer.current); void prefetchHover(path) },
  })
}
