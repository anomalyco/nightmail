import { useMemo } from 'react'
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { useApi } from './context'
import type { InboundAddress } from './types'

const SINGLE_LOOKUP_LIMIT = 8
const MAX_BULK_PAGES = 10

/**
 * Shared paginated + server-searchable receiving-address picker hook.
 * Loads 100 addresses per page (never looping 10 pages automatically), supports server-side search via ?q=,
 * and keeps previous results on screen while typing.
 */
export function useAddressOptions({ enabled = true, search = '', kind }: { enabled?: boolean; search?: string; kind?: 'address' | 'inbox' } = {}) {
  const api = useApi()
  const q = search.trim()
  const query = useInfiniteQuery({
    queryKey: ['nightmail', 'inbound-addresses', 'options', kind ?? 'all', q],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.inbound.addresses({ kind, search: q || undefined, cursor: pageParam }, signal),
    getNextPageParam: last => last.nextCursor ?? undefined,
    placeholderData: previous => previous,
    staleTime: 60_000,
    retry: false,
  })
  const items = useMemo(() => {
    const pages = query.data?.pages ?? []
    if (pages.length <= 1) return pages[0] ?? []
    const seen = new Set<string>(), out: InboundAddress[] = []
    for (const page of pages) for (const item of page) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
    return out
  }, [query.data])
  return {
    items,
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMore: () => { void query.fetchNextPage() },
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}

/**
 * Resolves saved or referenced address IDs that are not on the currently loaded page(s):
 * - When a handful (<= 8) are missing, fetches each by ID (GET /v1/inbound/addresses/:id).
 * - When many (> 8) are missing (e.g. API keys page with 100 off-page address-scoped keys), walks bounded address
 *   pages (100/page, stopping early once all wanted IDs are found, capped at 10 pages) instead of firing N+1 lookups,
 *   and falls back to single lookups only for up to 8 remaining unresolved IDs.
 */
export function useResolvedAddresses(ids: readonly (string | null | undefined)[], loaded: readonly InboundAddress[], enabled = true, nextCursor?: string | null) {
  const api = useApi()
  const loadedIds = useMemo(() => new Set(loaded.map(item => item.id)), [loaded])
  // Only look up opaque address IDs (skip email aliases containing '@' and anything already loaded).
  const missing = useMemo(() => {
    const unique = new Set<string>()
    for (const id of ids) if (id && !id.includes('@') && !loadedIds.has(id)) unique.add(id)
    return [...unique].sort()
  }, [ids, loadedIds])
  const useBulk = enabled && missing.length > SINGLE_LOOKUP_LIMIT && (nextCursor === undefined || Boolean(nextCursor))
  const bulk = useQuery({
    queryKey: ['nightmail', 'inbound-addresses', 'bulk-resolve', nextCursor ?? null, missing],
    enabled: useBulk,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const wanted = new Set(missing)
      const collected: InboundAddress[] = []
      let cursor: string | undefined = nextCursor ?? undefined
      for (let pages = 0; pages < MAX_BULK_PAGES && wanted.size > 0; pages++) {
        const page = await api.inbound.addresses({ cursor }, signal)
        for (const item of page) {
          collected.push(item)
          wanted.delete(item.id)
        }
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      return collected
    },
  })
  const bulkItems = bulk.data ?? []
  const bulkIds = useMemo(() => new Set(bulkItems.map(item => item.id)), [bulkItems])
  // Single lookups: used when <= 8 IDs are missing, OR for up to 8 IDs still missing after bounded bulk pages finish.
  const singleIds = useMemo(() => {
    if (!enabled) return []
    if (!useBulk) return missing.slice(0, SINGLE_LOOKUP_LIMIT)
    if (bulk.isPending) return []
    return missing.filter(id => !bulkIds.has(id)).slice(0, SINGLE_LOOKUP_LIMIT)
  }, [enabled, useBulk, bulk.isPending, missing, bulkIds])
  const results = useQueries({
    queries: singleIds.map(id => ({
      queryKey: ['nightmail', 'inbound-address', id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => api.inbound.address(id, signal),
      staleTime: 60_000,
      retry: false,
    })),
  })
  const singleItems = useMemo(() => results.map(r => r.data).filter((item): item is InboundAddress => Boolean(item)), [results])
  const items = useMemo(() => {
    const wanted = new Set(missing)
    const out: InboundAddress[] = [], seen = new Set<string>()
    for (const item of [...bulkItems, ...singleItems]) {
      if (wanted.has(item.id) && !seen.has(item.id)) { seen.add(item.id); out.push(item) }
    }
    return out
  }, [missing, bulkItems, singleItems])
  const byId = useMemo(() => new Map<string, InboundAddress>([...loaded, ...bulkItems, ...singleItems].map(item => [item.id, item])), [loaded, bulkItems, singleItems])
  const pending = enabled && missing.length > 0 && ((useBulk && bulk.isPending) || results.some(r => r.isPending))
  return { items, byId, pending }
}

/** Merges resolved saved addresses ahead of loaded picker pages (deduplicated by ID), so saved off-page choices always show. */
export function mergeAddresses(resolved: readonly InboundAddress[], loaded: readonly InboundAddress[]): InboundAddress[] {
  if (!resolved.length) return [...loaded]
  const seen = new Set<string>(), out: InboundAddress[] = []
  for (const item of resolved) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
  for (const item of loaded) if (!seen.has(item.id)) { seen.add(item.id); out.push(item) }
  return out
}
