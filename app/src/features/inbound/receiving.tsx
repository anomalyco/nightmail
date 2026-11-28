// Mail routing (/receiving): Addresses, Rules and Destinations (the API's routes, rules and endpoints), in the order mail meets them:
// received, processed, delivered. One read (getInboundOverview) per screen.
import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Check, X } from 'lucide-react'
import { Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, IconButton, PageHeader, Pagination, SearchField, Select, StatusBadge, Tabs, useToast } from '../../components/ui'
import { useApiDef, useApiQuery, useRequestScope, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useResolvedAddresses } from '../../data/addresses'
import { isAbortError, request } from '../../data/live'
import { errorText, type InboundAddress } from '../../data/types'
import { number } from '../../lib/format'
import { useMediaQuery } from '../../lib/media'
import { FlowPanel, mailOf } from './panel'
import { splitOf } from './flow'
import { useCursorPagination, useSearchDraft } from '../../lib/pagination'
import { AddressBuilder, builderFits, conditions, type Condition } from './builder'
import { concepts, kindNote, kinds, type KindFilter } from './concepts'
import { NewInboxDialog } from './inboxes'
import { ConnectAgentButton } from '../docs/connect-agent'
import { ago, expiresIn, receivingDomains, typeLabel, useEndpointPage, useOverview, type Overview, type OverviewEndpoint, type RouteEntry } from './overview'
import { Match, RouteIcon, TargetIcon, Targets, targetName } from './parts'
import { RulesSummary, RulesTab } from './recipes'
import { CreatedEndpointDialog, EndpointDialog, endpointStatusLabel, endpointStatusTone, type EditableEndpoint, type Endpoint } from './ritual-connections'
import { RouteEditor } from './routing'
import { ReceivingBodySkeleton } from './skeletons'
import { actorText, useLiveVersion } from './live'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import { resourceOf } from '../../data/invalidation'

type Tab = 'addresses' | 'rules' | 'destinations'
// Links from before the rename keep working: tab=routes, tab=endpoints and tab=rituals land on today's tab.
const legacyTab: Record<string, Tab> = { routes: 'addresses', endpoints: 'destinations', rituals: 'rules' }
const PAGE = 50
const kindQuery: Record<KindFilter, { kind?: string; origin?: 'api' | 'auto' }> = {
  all: {}, address: { kind: 'address,route', origin: 'api' }, pattern: { kind: 'pattern' }, catch_all: { kind: 'catch_all' }, inbox: { kind: 'inbox' }, auto: { kind: 'address', origin: 'auto' },
}
const kindCount = (counts: Overview['counts'], kind: KindFilter) => kind === 'all' ? counts.address + counts.auto + counts.route + counts.pattern + counts.catch_all + counts.inbox
  : kind === 'address' ? counts.address + counts.route : counts[kind]

// Under each route's address: what it is, in a few words.
function note(r: RouteEntry) {
  const a = r.address
  if (r.kind === 'catch_all') return 'Catch-all'
  if (r.kind === 'route') return kindNote.route
  if (r.kind === 'pattern') return a ? <>Wildcard for <PrivateAddress value={a.address} /></> : kindNote.pattern
  if (r.kind === 'inbox') return [kindNote.inbox, a?.displayName, expiresIn(a?.expiresAt)].filter(Boolean).join(' · ')
  if (a?.origin === 'auto') return kindNote.auto
  const also = a?.aliases.length ? <>also <AddressList values={a.aliases.map(x => x.slice(0, x.indexOf('@') + 1))} /></> : null
  const parts = [a?.displayName, a?.expiresAt ? expiresIn(a.expiresAt) : null, also].filter(Boolean)
  return parts.length ? parts.map((part, i) => <span key={i}>{i > 0 && ' · '}{part}</span>) : null
}
// The same line as text for a tooltip, when the cell clips it. An address never goes in: it stays masked until revealed.
const noteTitle = (r: RouteEntry) => r.kind === 'catch_all' || r.kind === 'route' || r.address?.origin === 'auto' ? undefined
  : [r.kind === 'inbox' ? kindNote.inbox : null, r.address?.displayName, expiresIn(r.address?.expiresAt)].filter(Boolean).join(' · ') || undefined
/** Where a row's mail goes, as the list says it. A two-way rule's address names its two sides first: its route
 *  stores nothing more ("Stored, no inbox") unless a side keeps it. */
const shownTargets = (r: RouteEntry, overview: Overview) => {
  const split = splitOf(r, overview), p = split?.recipe?.params
  if (!p || p.then === 'store' || p.otherwise === 'store') return { to: r.to, total: r.toTotal }
  const to = [...r.to.filter(t => t.via === split!.key), ...r.to.filter(t => t.via !== split!.key && t.type !== 'store')]
  return { to, total: r.toTotal - (r.to.length - to.length) }
}
const targetsTitle = (r: RouteEntry) => r.to.map(t => isMailbox(t.name) ? typeLabel[t.type] : targetName(t, r.address?.id)).join(', ')

/** A new account: the three steps everything else builds on, each with the one action that starts it. */
function GettingStarted({ overview, onCreate }: { overview: Overview; onCreate: () => void }) {
  const live = overview.domains.filter(d => d.status === 'active'), sendOnly = overview.domains.filter(d => ['off', 'disabled'].includes(d.status))
  const step = (n: number, done: boolean, title: string, action: ReactNode) => <li className="rcv-step" data-done={done || undefined}>
    <span className="rcv-step__n" aria-hidden="true">{done ? <Check size={13} /> : n}</span><div className="rcv-step__body"><h3>{title}</h3>{action}</div></li>
  // Each step is its heading and the action that starts it; each waits on the one before (its buttons are off until then).
  // This list shows only while there is no address, so the third always waits. An agent inbox needs no DNS, so testing
  // can start before any of it.
  // The step to take now is the primary button; New address waits on the first, as the header's does.
  return <ol className="rcv-steps">
    {step(1, live.length > 0, 'Receive on a domain', !live.length && <Link className="ui-button ui-button--primary ui-button--md" to={sendOnly[0] ? `/domains/${sendOnly[0].id}` : '/domains'}>Set up receiving</Link>)}
    {step(2, false, 'Create an address', <Button variant={live.length ? 'primary' : 'secondary'} disabled={!live.length} onClick={onCreate}>New address</Button>)}
    {/* Rules run on an address, and a forward asks its recipient from one: both wait on the second step, as it waits on the first. */}
    {step(3, false, 'Add a rule or a destination', <div className="cluster"><Button variant="secondary" disabled>New rule</Button><Button variant="secondary" disabled>New destination</Button></div>)}
    <li className="rcv-steps__aside"><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/inboxes">Try an agent inbox</Link></li>
  </ol>
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
/** The panel sits beside the list from this width; below it, it opens over the page (a full-height sheet on a phone). */
const DOCKED = '(min-width: 1180px)'

/** The kinds, one line at every width: whole labels with their counts, scrolling sideways when they don't fit. A kind
 *  with nothing in it is left out, unless it's the one chosen. */
function KindFilter({ overview, value, onChange }: { overview: Overview; value: KindFilter; onChange: (kind: KindFilter) => void }) {
  const shown = (Object.keys(kinds) as KindFilter[]).filter(k => (overview.manage || ['all', 'address', 'inbox', 'auto'].includes(k)) && (k === 'all' || k === value || kindCount(overview.counts, k) > 0))
  return <div className="rcv-kinds" role="group" aria-label="Kind">{shown.map(k => <button key={k} type="button" className="rcv-kind" aria-pressed={value === k} onClick={() => onChange(k)}>
    <span>{kinds[k].label}</span><span className="rcv-kind__count">{number(kindCount(overview.counts, k))}</span>
  </button>)}</div>
}

function AddressesTab({ overview, fetching, filters, setFilter, page, onPage, onCreate, onEditRoute, onBuild }: { overview: Overview; fetching: boolean; filters: { kind: KindFilter; domain: string; q: string }; setFilter: (patch: Partial<{ kind: KindFilter; domain: string; q: string }>) => void; page: number; onPage: (next: number) => void; onCreate: (address?: string) => void; onEditRoute: (r: RouteEntry) => void; onBuild: (address: InboundAddress) => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const docked = useMediaQuery(DOCKED)
  const [newInbox, setNewInbox] = useState(false)
  const [draft, type] = useSearchDraft(filters.q, value => setFilter({ q: value }))
  const hosts = receivingDomains(overview.domains)
  const total = kindCount(overview.counts, 'all')
  if (!overview.manage && !total && !filters.q) return <EmptyState title="No addresses to show" />
  if (overview.manage && !hosts.length && !total) return <GettingStarted overview={overview} onCreate={() => onCreate()} />
  const rows = overview.routes.data
  // A full address typed in the search opens its row, or, when it has none, where its mail would go.
  const typed = filters.q.trim().toLowerCase(), complete = EMAIL.test(typed)
  const exact = complete ? rows.find(r => r.match === typed || r.address?.address === typed || r.address?.aliases.includes(typed)) : undefined
  const lookup = overview.manage && complete && !exact && hosts.some(d => typed.endsWith('@' + d.name)) ? typed : undefined
  const chosen = rows.find(r => r.id === params.get('open'))
  // Beside the list, the panel always shows one: the chosen row, the typed one, or the first.
  const selected = chosen ?? exact ?? rows.find(r => r.address?.id === params.get('build')) ?? (docked && !lookup ? rows[0] : undefined)
  const choose = (r: RouteEntry | null) => setParams(previous => { const next = new URLSearchParams(previous); if (r) next.set('open', r.id); else next.delete('open'); return next }, { replace: true })
  // An address opens the builder when it can draw its flow, else its steps on its page; an agent inbox its own page; a
  // wildcard or catch-all its route.
  const edit = (r: RouteEntry) => { const own = r.address && r.kind !== 'pattern'; if (own && r.kind === 'inbox') navigate(`/receiving/inboxes/${r.address!.id}`); else if (own && builderFits(r, overview)) onBuild(r.address!); else if (own) navigate(`/receiving/addresses/${r.address!.id}?tab=flow&edit=1`); else onEditRoute(r) }
  const showPanel = overview.manage && (!!selected || !!lookup)
  const empty = filters.q ? 'Nothing matches' : kinds[filters.kind].empty
  const addRule = (r: RouteEntry) => overview.manage && r.address && r.kind !== 'pattern' ? <Link className="rcv-add" to={`/receiving/rules/new?address=${encodeURIComponent(r.address.id)}`} onClick={e => e.stopPropagation()}>Add a rule</Link> : null
  const panel = showPanel && <FlowPanel key={selected?.id ?? lookup} entry={lookup ? undefined : selected} lookup={lookup} overview={overview} onEdit={edit} onCreate={address => onCreate(address)} />
  return <div className="stack rcv-tab">
    <div className="rcv-toolbar">
      <KindFilter overview={overview} value={filters.kind} onChange={kind => setFilter({ kind })} />
      <div className="rcv-toolbar__end">
        {hosts.length > 1 && <Select className="rcv-domain" aria-label="Domain" value={filters.domain || 'all'} onValueChange={v => setFilter({ domain: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'All domains' }, ...hosts.map(d => ({ value: d.name, label: d.name }))]} />}
        <SearchField className="search-box--list rcv-search" aria-label="Search or type an address" placeholder="Search or type an address" value={draft} onChange={e => type(e.target.value)} />
        {/* New address is the page's own action; agent inboxes add theirs while they are the filter. */}
        {canAdminister && filters.kind === 'inbox' && <div className="cluster"><ConnectAgentButton /><Button onClick={() => setNewInbox(true)}>New agent inbox</Button></div>}
      </div>
    </div>
    <div className="rcv-browse" data-docked={(docked && showPanel) || undefined}>
      <div className="rcv-browse__list">
        <DataTable className="rcv-table ui-table--two-line" rows={rows} rowKey={r => r.id} selectedId={docked ? selected?.id : undefined} rowLabel={r => r.match}
          onRowClick={overview.manage ? r => choose(r) : r => { const to = mailOf(r); if (to) navigate(to) }} loading={false} minRows={Math.min(8, rows.length)}
          empty={docked && lookup ? <EmptyState title="No address yet" /> : <EmptyState title={empty} action={!filters.q && filters.kind === 'address' && canAdminister ? <Button onClick={() => onCreate()}>New address</Button> : undefined} />}
          columns={[
            // One line per address: what it receives, the rules that process it (beside the list, the panel says it),
            // where it is delivered, and its last mail. A card: the address and its new mail, what it is, where it goes.
            { key: 'match', label: 'Address', card: 'title', render: r => <div className="rcv-cell"><RouteIcon entry={r} /><div className="settings-cell-stack"><Match value={r.match} host={!filters.domain} />{note(r) ? <span className="muted receiving-clip" title={noteTitle(r)}>{note(r)}</span> : null}</div></div>,
              cardRender: r => <span className="rcv-cell"><RouteIcon entry={r} /><Match value={r.match} host={!filters.domain} /></span> },
            { key: 'note', label: 'Kind', table: false, card: 'line', render: r => note(r) },
            // Rules in plain words; an address without one says how to add one, on a phone too.
            ...(docked ? [] : [{ key: 'rules', label: 'Rules', width: '20%', card: 'hide' as const, render: (r: RouteEntry) => r.rules.length ? <RulesSummary keys={r.rules} rules={overview.rules} endpoints={overview.endpoints} /> : addRule(r) ?? <span className="muted">—</span> }]),
            { key: 'to', label: 'Destinations', width: docked ? '38%' : '30%', card: 'line', render: r => <span className="rcv-to" title={targetsTitle(r)}><Targets {...shownTargets(r, overview)} ownId={r.address?.id} max={2} /></span>, cardRender: r => <span className="rcv-card-to"><Targets {...shownTargets(r, overview)} ownId={r.address?.id} max={2} />{!r.rules.length && addRule(r) && <><span aria-hidden="true">·</span>{addRule(r)}</>}</span> },
            { key: 'last', label: 'Last mail', width: 136, align: 'right', card: 'aside', render: r => <LastMail entry={r} /> },
          ]} />
        <div className="rcv-foot" data-busy={fetching || undefined}>
          <Pagination page={page} pageSize={PAGE} total={kindCount(overview.counts, filters.kind)} nextCursor={overview.routes.nextCursor} onPageChange={onPage} />
        </div>
        {!docked && lookup && panel}
      </div>
      {docked && panel}
    </div>
    {/* Smaller screens: the chosen row's flow opens over the page, a full-height sheet on a phone. */}
    <Dialog size="lg" open={!docked && !!chosen && overview.manage} onOpenChange={open => { if (!open) choose(null) }} title="Where its mail goes">{!docked && chosen && panel}</Dialog>
    <NewInboxDialog open={newInbox} onOpenChange={setNewInbox} />
  </div>
}
/** New mail and when the last arrived: "4 new · 7m". */
function LastMail({ entry: r }: { entry: RouteEntry }) {
  if (!r.address || r.kind === 'pattern') return <span className="muted">—</span>
  const unread = r.address.stats.unreadThreads, at = r.address.stats.lastMessageAt
  if (!unread && !at) return <span className="muted">—</span>
  return <span className="rcv-last">{unread > 0 && <strong className="rcv-unread">{number(unread)} new</strong>}{at && <span>{ago(at)}</span>}</span>
}

const ENDPOINT_PAGE = 50
const destinationType: Record<OverviewEndpoint['type'], string> = { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' }
/** What a destination is and where it points: "Webhook · ••••/crm". A Slack or Discord target already names its kind. */
const DestinationTarget = ({ e }: { e: Pick<OverviewEndpoint, 'type' | 'target'> }) => e.target.toLowerCase().startsWith(e.type) ? <PrivateAddress value={e.target} /> : <>{destinationType[e.type]} · <PrivateAddress value={e.target} /></>
// What a webhook subscribes to, in words: received mail is "all new mail".
const eventWord: Record<string, string> = { 'message.received': 'All new mail', 'message.junk': 'Junk', 'message.stored': 'Stored mail' }
const eventWords = (types: string[]) => types.length === 1 ? eventWord[types[0]!] ?? types[0]! : types.includes('message.received') ? `All new mail +${types.length - 1}` : `${types.length} events`
/** Destinations (the API's endpoints): where processed mail is delivered. Webhooks, Slack, Discord and forwards. */
function DestinationsTab({ overview, refresh }: { overview: Overview; refresh: () => void }) {
  const toast = useToast(), navigate = useNavigate(), client = useQueryClient()
  // Every endpoint, a page at a time; ?address= keeps the webhooks that get that address's received mail (an address's "more webhooks" link).
  const [params, setParams] = useSearchParams(), address = params.get('address') ?? undefined
  const pagination = useCursorPagination()
  // With nothing to list the overview already says so, and the empty state shows at once.
  const none = !address && !overview.endpoints.length && !overview.endpointsTruncated
  const list = useEndpointPage({ addressId: address, cursor: pagination.cursor, limit: ENDPOINT_PAGE }, !none)
  const addresses = useApiDef(queries.inboundAddressOptions(), { enabled: !!address })
  const resolvedFilter = useResolvedAddresses(address ? [address] : [], addresses.data ?? [], !!address)
  const reload = () => { refresh(); void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === 'inbound-endpoints' }) }
  const showAll = () => { setParams(previous => { const next = new URLSearchParams(previous); next.delete('address'); return next }, { replace: true }); pagination.reset() }
  // The first page holds as many rows as the overview counted, so the list keeps its height while it loads.
  const expected = address ? 2 : Math.max(1, Math.min(ENDPOINT_PAGE, overview.endpoints.length))
  // ?new=1 (the first-run checklist's New destination) opens the form at once.
  const [creating, setCreating] = useState(params.get('new') === '1')
  useEffect(() => { if (params.get('new')) setParams(previous => { const next = new URLSearchParams(previous); next.delete('new'); return next }, { replace: true }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [created, setCreated] = useState<(Endpoint & { secret?: string }) | null>(null)
  // Kept after closing, so the dialog's title and fields don't change while it animates out.
  const [editing, setEditing] = useState<EditableEndpoint | null>(null), [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState<OverviewEndpoint | null>(null), [deleteOpen, setDeleteOpen] = useState(false)
  const scope = useRequestScope()
  async function act(e: OverviewEndpoint, path: string, method: string, body: unknown, done: string) {
    try {
      const result = await request<{ ok?: boolean; error?: string | null }>(`/v1/endpoints/${encodeURIComponent(e.name)}${path}`, { method, ...(body === undefined ? {} : { body }), scope })
      toast(result.ok === false ? `${e.name} answered ${result.error ?? 'an error'}.` : done, result.ok === false ? 'error' : 'success')
      reload()
    } catch (error) { if (!isAbortError(error)) toast(errorText(error), 'error') }
  }
  // A webhook opens its own page (events, deliveries, headers, secret), named or not.
  const webhookPage = (e: OverviewEndpoint) => e.type === 'webhook' ? `/receiving/webhooks/${e.id}` : null
  const used = (e: OverviewEndpoint) => [e.routes ? `${number(e.routes)} ${e.routes === 1 ? 'address' : 'addresses'}` : null, e.rules.length ? `${number(e.rules.length)} ${e.rules.length === 1 ? 'rule' : 'rules'}` : null, e.eventTypes.length ? eventWords(e.eventTypes) : null].filter(Boolean).join(' · ')
  return <div className="stack rcv-tab">
    <div className="rcv-kindline">
      {address && <span className="rcv-filter-chip">{(a => a ? <PrivateAddress value={a} /> : 'One address')(resolvedFilter.byId.get(address)?.address ?? addresses.data?.find(item => item.id === address)?.address)}<IconButton size="sm" label="Show every destination" onClick={showAll}><X size={14} aria-hidden="true" /></IconButton></span>}
      {/* With none yet, the empty list's own button is the one. */}
      {!none && <div className="cluster"><Button onClick={() => setCreating(true)}>New destination</Button></div>}
    </div>
    {list.error && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <DataTable className="rcv-table ui-table--two-line" rows={none ? [] : list.data?.data ?? []} rowKey={e => e.id} rowHref={webhookPage}
      loading={!none && !list.data} skeletonRows={expected} minRows={none ? 0 : Math.min(expected, list.data?.data.length ?? expected)}
      empty={address ? <EmptyState title="No webhook gets this address’s mail" /> : <EmptyState title="No destinations yet" action={<Button onClick={() => setCreating(true)}>New destination</Button>} />}
      columns={[
        // Its name, then what it is and where it points: "crm · Webhook · ••••/crm". Never the code that calls it.
        { key: 'name', label: 'Destination', card: 'title', render: e => <div className="rcv-cell"><TargetIcon type={e.type} /><div className="settings-cell-stack"><span className="receiving-clip" title={e.name}>{e.name}</span><span className="muted receiving-clip"><DestinationTarget e={e} /></span></div></div>,
          cardRender: e => <span className="rcv-cell"><TargetIcon type={e.type} />{e.name}</span> },
        { key: 'target', label: 'Target', table: false, card: 'line', render: e => <DestinationTarget e={e} /> },
        { key: 'used', label: 'Used by', width: '30%', card: 'line', render: e => used(e) || <span className="muted">Nothing yet</span> },
        { key: 'status', label: 'Status', width: 128, card: 'aside', render: e => <StatusBadge status={endpointStatusLabel[e.status]} tone={endpointStatusTone[e.status]} /> },
        { key: 'actions', label: '', width: 52, align: 'right', render: e => e.source === 'inbound_webhook' ? <DropdownMenu label={`Actions for ${e.name}`} items={[{ label: 'Open', onSelect: () => navigate(webhookPage(e)!) }]} /> : <DropdownMenu label={`Actions for ${e.name}`} items={[
          ...(e.type === 'webhook' ? [{ label: 'Open', onSelect: () => navigate(webhookPage(e)!) }] : []),
          { label: 'Edit', onSelect: () => { setEditing(e); setEditOpen(true) } },
          ...(e.type !== 'forward' ? [{ label: 'Send a test message', onSelect: () => void act(e, '/test', 'POST', undefined, `Test posted to ${e.call}.`) }] : []),
          ...(e.type === 'forward' && e.status !== 'ready' ? [{ label: 'Resend confirmation', onSelect: () => void act(e, '/verification', 'POST', {}, 'Confirmation email queued.') }] : []),
          { label: e.status === 'paused' ? 'Resume' : 'Pause', onSelect: () => void act(e, '', 'PATCH', { paused: e.status !== 'paused' }, e.status === 'paused' ? 'Resumed.' : 'Paused. Calls wait until you resume.') },
          { label: 'Delete', destructive: true, onSelect: () => { setDeleting(e); setDeleteOpen(true) } },
        ]} /> },
      ]} />}
    {list.data && <Pagination page={pagination.page} pageSize={ENDPOINT_PAGE} nextCursor={list.data.nextCursor} count={list.data.data.length} onPageChange={next => pagination.onPageChange(next, list.data?.nextCursor)} />}
    <EndpointDialog open={creating} onOpenChange={setCreating} taken={overview.endpoints.map(e => e.name)} onCreated={e => { setCreating(false); setCreated(e); reload() }} />
    <EndpointDialog open={editOpen} editing={editing} onOpenChange={setEditOpen} onSaved={e => { setEditOpen(false); toast(`Saved ${e.name}.`, 'success'); reload() }} />
    <CreatedEndpointDialog created={created} onClose={() => setCreated(null)} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} danger title={`Delete ${deleting?.name ?? 'this destination'}?`} description="Rules and addresses that send to it stop delivering. This can’t be undone." confirmLabel="Delete destination"
      onConfirm={() => deleting ? act(deleting, '', 'DELETE', undefined, `${deleting.name} deleted.`) : undefined} />
  </div>
}

export function ReceivingPage() {
  const [params, setParams] = useSearchParams()
  const { canAdminister } = useWorkspaceAccess()
  // A link from before a rename shows today's tab at once, and the address bar then says its name.
  const asked = params.get('tab') ?? '', legacy = legacyTab[asked]
  const tab: Tab = legacy ?? (asked === 'rules' || asked === 'destinations' ? asked : 'addresses')
  useEffect(() => { if (legacy) setParams(previous => { const next = new URLSearchParams(previous); if (legacy === 'addresses') next.delete('tab'); else next.set('tab', legacy); return next }, { replace: true }) }, [legacy, setParams])
  const kind = (params.get('kind') ?? 'all') as KindFilter
  const filters = { kind: kind in kinds ? kind : 'all' as KindFilter, domain: params.get('domain') ?? '', q: params.get('q') ?? '' }
  const pagination = useCursorPagination()
  const overview = useOverview({ ...kindQuery[filters.kind], domain: filters.domain || undefined, q: filters.q.trim() || undefined, cursor: pagination.cursor, limit: PAGE }, true)
  // New address (or Create this address, its address filled in), or an address's flow to change: one builder.
  // ?new=address (from a form that needs an address first, such as a rule's) opens New address.
  const [creating, setCreating] = useState<{ address: string } | null>(() => params.get('new') === 'address' ? { address: '' } : null)
  useEffect(() => { if (params.get('new') === 'address') setParams(previous => { const next = new URLSearchParams(previous); next.delete('new'); return next }, { replace: true }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [building, setBuilding] = useState<InboundAddress | null>(null)
  // ?build=<address ID> opens the builder on that address: from a Rules row (&rule=<key>), or New rule's Split by words
  // or meaning (&split=<check>), which split its mail on that check when it has no two-way rule yet.
  const buildId = params.get('build'), splitParam = params.get('split') as Condition | null
  const toBuild = useApiQuery(['inbound-address', buildId], (api, signal) => buildId ? api.inbound.address(buildId, signal) : Promise.resolve(null), { enabled: !!buildId })
  const shown = building ?? toBuild.data ?? null
  const closeBuilder = () => { setBuilding(null); if (buildId) setParams(previous => { const next = new URLSearchParams(previous); for (const k of ['build', 'split', 'rule']) next.delete(k); return next }, { replace: true }); void overview.refetch() }
  const [editing, setEditing] = useState<RouteEntry | null>(null)
  // A catch-all or wildcard typed into New address opens its route editor instead.
  const [pattern, setPattern] = useState<string | null>(null)
  function update(patch: Record<string, string | null | undefined>) {
    // From the latest URL: a debounced search write must not undo a filter picked while it waited.
    setParams(previous => {
      const next = new URLSearchParams(previous)
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '' || (k === 'kind' && v === 'all') || (k === 'tab' && v === 'addresses')) next.delete(k); else next.set(k, v) }
      return next
    }, { replace: true })
    pagination.reset()
  }
  const data = overview.data
  const manage = data?.manage ?? canAdminister
  // Live: a route, rule or endpoint saved elsewhere (an agent over MCP, an API key, another tab) refreshes the lists
  // in place and says who saved it. This person's own saves refresh through their mutations and say nothing here.
  const client = useQueryClient(), toast = useToast()
  useLiveVersion(manage && !!data, change => {
    if (change.first) return
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['inbound-overview', 'inbound-endpoints'].includes(resourceOf(query.queryKey)) })
    if (change.actor?.self && change.actor.type === 'member') return
    toast(`${change.versionMoved ? 'Addresses and rules' : 'Destinations'} updated by ${actorText(change.actor)}`, 'info')
  }, { endpoints: true })
  // Addresses and inboxes an agent makes or deletes don't move that version: coming back to the page (from the agent's
  // terminal or another tab) reads the lists again, so nothing deleted meanwhile is still there to open.
  useEffect(() => {
    let last = 0
    const catchUp = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2000) return
      last = Date.now()
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['inbound-overview', 'inbound-addresses', 'agent-inboxes'].includes(resourceOf(query.queryKey)) })
    }
    window.addEventListener('focus', catchUp); document.addEventListener('visibilitychange', catchUp)
    return () => { window.removeEventListener('focus', catchUp); document.removeEventListener('visibilitychange', catchUp) }
  }, [client])
  const counts = data && { addresses: kindCount(data.counts, 'all'), rules: data.rules.length, destinations: data.endpoints.length }
  return <div className="stack inbound-stack receiving-page">
    {/* The page's one action. An address's mail is on its own page; every address's mail is in Logs. */}
    {/* Until a domain receives, the first-run steps carry the way in; a dead button here would only say no. */}
    <PageHeader title="Mail routing" actions={manage && (!data || receivingDomains(data.domains).length > 0) && <Button variant="primary" disabled={!data} onClick={() => setCreating({ address: '' })}>New address</Button>} />
    {overview.error && !data ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : !data || !counts ? <ReceivingBodySkeleton /> : <div className="rcv-page">
      <Tabs label="Mail routing" value={tab} onValueChange={value => update({ tab: value, kind: null, address: null })}
        items={[{ value: 'addresses', label: concepts.addresses.title, count: counts.addresses }, ...(data.manage ? [{ value: 'rules', label: concepts.rules.title, count: counts.rules }, { value: 'destinations', label: concepts.destinations.title, count: counts.destinations }] : [])]} />
      {tab === 'rules' && data.manage ? <RulesTab overview={data} refresh={() => overview.refetch()} />
        : tab === 'destinations' && data.manage ? <DestinationsTab overview={data} refresh={() => void overview.refetch()} />
        : <AddressesTab overview={data} fetching={overview.isFetching} filters={filters} onCreate={address => setCreating({ address: address ?? '' })} onEditRoute={setEditing} onBuild={setBuilding}
          page={pagination.page} onPage={next => pagination.onPageChange(next, data.routes.nextCursor)} setFilter={patch => update(patch)} />}
    </div>}
    {data && <AddressBuilder open={!!creating} initial={creating?.address} onOpenChange={open => { if (!open) setCreating(null) }} domains={data.domains} onPattern={setPattern} />}
    {data && shown && <AddressBuilder open address={shown} rule={!building ? params.get('rule') ?? undefined : undefined} split={!building && splitParam && conditions.some(c => c.value === splitParam) ? splitParam : undefined} onOpenChange={open => { if (!open) closeBuilder() }} domains={data.domains} />}
    {editing && <RouteEditor match={editing.match} route={editing.route} version={data?.version} onClose={() => { setEditing(null); void overview.refetch() }} />}
    {pattern && <RouteEditor match={pattern} route={data?.routes.data.find(r => r.match === pattern)?.route ?? null} version={data?.version} onClose={() => { setPattern(null); void overview.refetch() }} />}
  </div>
}
