// Routes: the route editor ("Goes to"), opened from a route row or an address's page.
import { useState, type FormEvent, type ReactNode } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, Dialog, ErrorState, Field, Input, SearchField, Select, Switch, fieldError, MutationError } from '../../components/ui'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { useApi, useApiDef, useApiMutation, useRequestScope } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { ApiError, type ForwardEndpoint, type InboundAddress, type InboundWebhook, type MailRoute } from '../../data/types'
import { request } from '../../data/live'
import { PrivateAddress } from '../../components/PrivateAddress'
import { CreatedEndpointDialog, EndpointDialog, endpointStatusLabel, type Endpoint } from './ritual-connections'
import { outcomes } from './concepts'
import '../settings/settings.css'
import './inbound.css'
type Kind = 'inbox' | 'webhook' | 'forward'
/** `waiting`: a forward its recipient hasn't agreed to yet (it can be chosen: forwarding starts once they do), or one
 *  they declined or stopped (it can't). */
type Destination = { id: string; name: string; detail: string; kind: Kind; paused: boolean; routeOnly: boolean; href: string; webhook?: InboundWebhook; waiting?: string; declined?: boolean }
function destinationsOf(addresses: InboundAddress[], webhooks: InboundWebhook[], forwards: ForwardEndpoint[]): Destination[] {
  return [
    ...addresses.map(a => ({ id: a.id, name: a.displayName || a.address, detail: a.address, kind: 'inbox' as const, paused: false, routeOnly: false, href: `/receiving/addresses/${a.id}` })),
    ...webhooks.map(h => ({ id: h.id, name: h.name || h.description || h.url, detail: h.url, kind: 'webhook' as const, paused: h.paused, routeOnly: !h.eventTypes.length, href: `/receiving/webhooks/${h.id}`, webhook: h })),
    ...forwards.map(f => ({ id: f.id, name: f.name, detail: f.target, kind: 'forward' as const, paused: f.status === 'paused', routeOnly: false, href: '/receiving?tab=endpoints',
      waiting: f.status === 'ready' || f.status === 'paused' ? undefined : endpointStatusLabel[f.status], declined: f.status === 'declined' })),
  ]
}

// One row per recipient rule, read as "mail to X goes to Y". Address rows are the implicit routes every inbox has.
export const TITLE = 'Where should this mail go?'

/** Loads what a route can deliver to (inboxes, webhooks and forwards) and opens the editor for one route, or a new one for `match`. */
export function RouteEditor({ match, route, to, version, onClose }: { match: string; route?: { id: string; enabled: boolean; to: string[] | 'drop' } | null; to?: string[]; version?: number; onClose: () => void }) {
  const api = useApi()
  const [addressSearch, setAddressSearch] = useState('')
  const addressQuery = useDebounced(addressSearch)
  const addresses = useAddressOptions({ search: addressQuery })
  const webhooks = useInfiniteQuery({
    queryKey: ['nightmail', 'inbound-webhooks', 'route-options'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.inbound.webhooks(signal, pageParam),
    getNextPageParam: last => last.nextCursor ?? undefined,
    retry: false,
  })
  const forwards = useApiDef(queries.forwardEndpoints())
  const targetIds = Array.isArray(route?.to) ? route.to : to ?? []
  const resolved = useResolvedAddresses(targetIds.filter(id => id.startsWith('mbx_')), addresses.items, !addresses.isPending)
  const error = (addresses.isError && !addresses.items.length && addresses.error) || (!webhooks.data && webhooks.error) || (!forwards.data && forwards.error)
  if (error) return <Dialog open onOpenChange={next => { if (!next) onClose() }} title={TITLE}>
    <ErrorState error={error} onRetry={() => { if (addresses.error) void addresses.refetch(); if (webhooks.error) void webhooks.refetch(); if (forwards.error) void forwards.refetch() }} />
  </Dialog>
  // The dialog opens once everything it lists has loaded, so nothing moves in it.
  if (addresses.isPending || resolved.pending || !webhooks.data || !forwards.data) return null
  const allAddresses = mergeAddresses(resolved.items, addresses.items)
  const allWebhooks = webhooks.data.pages.flatMap(page => page)
  const draft = route ? { match, to: route.to, route: { id: route.id, enabled: route.enabled, match, to: route.to } as MailRoute } : { match, to: to ?? [] }
  return <RouteDialog draft={draft} version={version} destinations={destinationsOf(allAddresses, allWebhooks, forwards.data)} owners={allAddresses} onClose={onClose}
    addressSearch={addresses.hasMore || Boolean(addressSearch) ? { value: addressSearch, onChange: setAddressSearch } : undefined}
    moreAddresses={addresses.hasMore ? { loading: addresses.loadingMore, load: addresses.loadMore } : undefined}
    moreWebhooks={webhooks.hasNextPage ? { loading: webhooks.isFetchingNextPage, load: () => void webhooks.fetchNextPage() } : undefined}
    refreshWebhooks={async () => (await webhooks.refetch()).data?.pages.flatMap(page => page) ?? []} refreshForwards={async () => { await forwards.refetch() }} />
}

type Action = 'deliver' | 'keep' | 'drop'
function RouteDialog({ draft, version, destinations, owners, onClose, addressSearch, moreAddresses, moreWebhooks, refreshWebhooks, refreshForwards }: { draft: { match: string; to: string[] | 'drop'; route?: MailRoute }; version?: number; destinations: Destination[]; owners: InboundAddress[]; onClose: () => void; addressSearch?: { value: string; onChange: (value: string) => void }; moreAddresses?: { loading: boolean; load: () => void }; moreWebhooks?: { loading: boolean; load: () => void }; refreshWebhooks: () => Promise<InboundWebhook[]>; refreshForwards: () => Promise<void> }) {
  // A new webhook or forward endpoint is made here, without leaving, and ticked once it can take mail.
  const [creating, setCreating] = useState<'webhook' | 'forward' | null>(null)
  const [created, setCreated] = useState<(Endpoint & { secret?: string }) | null>(null)
  const route = draft.route
  const [match, setMatch] = useState(draft.match)
  const [action, setAction] = useState<Action>(draft.to === 'drop' ? 'drop' : draft.to.length || !route ? 'deliver' : 'keep')
  const [selected, setSelected] = useState<string[]>(Array.isArray(draft.to) ? draft.to : [])
  const [enabled, setEnabled] = useState(route?.enabled ?? true)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Saved with the version this editor read (the overview's): a change made meanwhile to this route (or a new route for
  // its address) is said, never overwritten. One elsewhere in the workspace only sends it again with the new version.
  const scope = useRequestScope()
  const versioned = async <T,>(send: (ifMatch: number | undefined) => Promise<T>): Promise<T> => {
    try { return await send(version) } catch (error) {
      if (version === undefined || !(error instanceof ApiError && error.code === 'VERSION_CONFLICT')) throw error
      const now = await request<{ version: number; routes: MailRoute[] }>('/v1/routing', { scope })
      const mine = route ? now.routes.find(r => r.id === route.id) : now.routes.find(r => r.match === draft.match)
      const set = (to: string[] | 'drop') => Array.isArray(to) ? [...to].sort().join(',') : to
      const same = route ? !!mine && mine.match === route.match && mine.enabled === route.enabled && set(mine.to) === set(route.to) : !mine
      if (!same) throw new ApiError('This changed since you opened it. Close it and open it again to see the change.', 'VERSION_CONFLICT')
      return send(now.version)
    }
  }
  const path = route ? `/v1/routing/routes/${encodeURIComponent(route.id)}` : '/v1/routing/routes'
  const save = useApiMutation((_api, input: { match: string; to: string[] | 'drop'; enabled: boolean }) => versioned(ifMatch => request<MailRoute>(path, { method: route ? 'PATCH' : 'POST', body: input, ifMatch, scope })), 'Saved', false, invalidate.routing, route?.id)
  const remove = useApiMutation((_api, _: void) => versioned(ifMatch => request(path, { method: 'DELETE', ifMatch, scope })), 'Removed', false, invalidate.routing, route?.id)
  const normalized = match.trim().toLowerCase()
  const owner = owners.find(a => a.address === normalized || a.aliases.includes(normalized))
  const losesOwner = owner && (action !== 'deliver' || !selected.includes(owner.id))
  const toggle = (id: string, on: boolean) => { setProblem(null); setSelected(on ? [...selected, id] : selected.filter(value => value !== id)) }
  const tick = (id: string) => { setAction('deliver'); setSelected(current => current.includes(id) ? current : [...current, id]) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!normalized.includes('@')) return setProblem('Enter an address, a pattern or *@domain.')
    if (action === 'deliver' && !selected.length) return setProblem('Choose at least one inbox, webhook or forward.')
    const order = new Map(destinations.map((d, i) => [d.id, i]))
    try { await save.mutateAsync({ match: normalized, to: action === 'drop' ? 'drop' : action === 'keep' ? [] : [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)), enabled }); onClose() } catch { /* Shown in the form. */ }
  }
  const group = (kind: Kind, label: string, empty: ReactNode) => {
    const items = destinations.filter(d => d.kind === kind)
    return <fieldset className="routing-choices" disabled={save.isPending}>
      <legend className="ui-field__label">{label}</legend>
      {items.length ? <div className="settings-choices">{items.map(d => <Checkbox key={d.id} checked={selected.includes(d.id)} disabled={!!d.declined && !selected.includes(d.id)} onCheckedChange={on => toggle(d.id, on)}
        label={<span className="settings-cell-stack"><span>{d.kind === 'inbox' && d.name === d.detail ? <PrivateAddress value={d.name} /> : d.name}{d.paused ? ' (paused)' : d.waiting ? ` (${d.waiting.toLowerCase()})` : ''}</span>{d.detail !== d.name && <span className="ui-field__hint">{d.kind === 'webhook' ? d.detail : <PrivateAddress value={d.detail} />}</span>}</span>} />)}</div> : <p className="muted">{empty}</p>}
      {/* Slack and Discord are a rule's to post, never a route's: the way there sits beside New webhook. */}
      {kind === 'webhook' && <div className="cluster"><Button size="sm" onClick={() => setCreating('webhook')}>New webhook</Button><Link className="ui-button ui-button--ghost ui-button--sm" to="/receiving/rules/new">Slack or Discord</Link></div>}
      {kind === 'forward' && <div className="cluster"><Button size="sm" onClick={() => setCreating('forward')}>New forward</Button></div>}
    </fieldset>
  }
  return <>
    <Dialog open onOpenChange={next => { if (!next && !save.isPending) onClose() }} title={TITLE}
      footer={<>
        {route && <Button variant="ghost" className="routing-delete" disabled={save.isPending} onClick={() => setConfirmDelete(true)}>Remove</Button>}
        <Button disabled={save.isPending} onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="routing-route" loading={save.isPending}>Save</Button>
      </>}>
      <form id="routing-route" className="stack" onSubmit={submit} noValidate>
        {/* An address, a pattern (reply+*@acme.com) or a whole domain (*@acme.com); the most specific route wins. */}
        <Field label="Mail to" htmlFor="routing-match" error={fieldError(save.error, 'match')}>
          <Input id="routing-match" value={match} autoFocus={!draft.match} disabled={save.isPending} placeholder="support@acme.com or *@acme.com" onChange={e => { setMatch(e.target.value); setProblem(null) }} />
        </Field>
        <Field label="Deliver to" htmlFor="routing-action" error={fieldError(save.error, 'to')}>
          <Select id="routing-action" value={action} disabled={save.isPending} onValueChange={value => { setAction(value as Action); setProblem(null) }}
            options={[{ value: 'deliver', label: 'These destinations' }, { value: 'keep', label: outcomes.store }, { value: 'drop', label: outcomes.drop }]} />
        </Field>
        {action === 'deliver' && <>
          {group('inbox', 'Inboxes', <>No addresses yet. <Link to="/receiving">Create one</Link>.</>)}
          {addressSearch && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={addressSearch.value} onChange={event => addressSearch.onChange(event.target.value)} />}
          {moreAddresses && <Button variant="ghost" size="sm" loading={moreAddresses.loading} onClick={moreAddresses.load}>Load more addresses</Button>}
          {group('webhook', 'Webhooks', 'No webhooks yet')}
          {moreWebhooks && <Button variant="ghost" size="sm" loading={moreWebhooks.loading} onClick={moreWebhooks.load}>Load more webhooks</Button>}
          {group('forward', 'Forwards', 'No forwards yet')}
        </>}
        {action === 'drop' && <Alert tone="warning">Dropped mail is not stored and cannot be recovered.</Alert>}
        {losesOwner && <Alert tone="warning">Mail to <PrivateAddress value={normalized} /> will stop reaching {owner.displayName || <PrivateAddress value={owner.address} />}. Tick its inbox to keep it.</Alert>}
        {route && <Switch checked={enabled} disabled={save.isPending} onCheckedChange={setEnabled} label="On" />}
        {problem && <p className="ui-field__error" role="alert">{problem}</p>}
        {!fieldError(save.error, 'match') && !fieldError(save.error, 'to') && <MutationError error={save.error} />}
      </form>
    </Dialog>
    <EndpointDialog open={!!creating} onOpenChange={open => { if (!open) setCreating(null) }} types={[creating ?? 'webhook']} taken={destinations.map(d => d.webhook?.key ?? '').filter(Boolean)} onCreated={async endpoint => {
      setCreating(null); setCreated(endpoint)
      if (endpoint.type === 'forward') {
        // Ticked at once: it forwards mail received from the moment its recipient agrees (at once on a domain this
        // workspace verified).
        await refreshForwards()
        tick(endpoint.id)
        return
      }
      const hook = (await refreshWebhooks()).find(h => h.key === endpoint.name)
      if (hook) tick(hook.id)
    }} />
    <CreatedEndpointDialog created={created} onClose={() => setCreated(null)} writeRule={false} />
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} danger title="Remove this?" description="Its mail falls back to its own inbox, a wildcard or the domain’s catch-all." confirmLabel="Remove" pending={remove.isPending}
      onConfirm={async () => { try { await remove.mutateAsync(); setConfirmDelete(false); onClose() } catch { /* The dialog stays open. */ } }} />
  </>
}
