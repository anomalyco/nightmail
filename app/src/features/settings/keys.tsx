import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useSearchParams } from 'react-router'
import { Button, Checkbox, ConfirmDialog, CopyButton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, KeyValues, PageHeader, Pagination, StatusBadge, Tabs, useToast, SecretDialog } from '../../components/ui'
import { useApiMutation, useApiDef, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { useResolvedAddresses } from '../../data/addresses'
import type { Agent, AgentTokenSummary, ApiKey, AppPassword, ApprovalTie } from '../../data/types'
import { date, shortDateTime } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { AdminOnlyPage } from './admin-only'
import { KeySendExample } from '../docs/first-send'
import { CreateKeyDialog, EditKeyDialog, useDomainOptions, useInboxOptions, type CreatedSecret, type Purpose } from './create-key'
import { actionLabel } from '../../data/activity'
import { Who } from './activity'
import { accessLabel, agentAccess, approvalLabel, connectionTitle, domainScope, mailLabel, protocolLabel } from './key-labels'
import { keyTypes, settingsColumns, type KeyTypeFilter } from './skeletons'
import './api-keys.css'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'
import { ConnectAgentButton, ConnectAgentDialog, McpKeySetup } from '../docs/connect-agent'
import { MailSettings, useMailServers } from '../docs/mail-settings'
import { apiKeyEnv, productName } from '../../../../api/src/brand'

// One table for the three credential types: API keys, agent tokens (a connected agent, with the short-lived tokens it
// made nested under it) and app passwords.
type Row =
  | { kind: 'key'; id: string; key: ApiKey }
  | { kind: 'agent'; id: string; agent: Agent }
  | { kind: 'token'; id: string; token: AgentTokenSummary }
  | { kind: 'app'; id: string; password: AppPassword }
const typeName: Record<Row['kind'], string> = { key: 'API key', agent: 'Agent token', token: 'Agent token', app: 'App password' }
const lastUsed = (value: string | null) => value ? date(value) : 'Never'
const usedLine = (value: string | null) => value ? `Used ${date(value)}` : 'Never used'
const newestFirst = <T extends { createdAt: string }>(items: T[]) => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
const past = (value: string | null) => value !== null && Date.parse(value) <= Date.now()
/** Revoked, ended (an inbox key past its end, usually its inbox's), expired, or null while it works. */
const keyState = (key: ApiKey) => key.revokedAt ? 'Revoked' : past(key.expiresAt) ? key.access.type === 'inbox' ? 'Ended' : 'Expired' : null
// An expired key can be given a later expiry, so it keeps its actions; a revoked or ended one has none.
const keyLocked = (key: ApiKey) => Boolean(key.revokedAt) || keyState(key) === 'Ended'
const tokenState = (token: AgentTokenSummary) => token.revokedAt ? 'Revoked' : past(token.expiresAt) ? 'Expired' : null
const agentState = (agent: Agent) => agent.status === 'revoked' ? 'Revoked' : agent.status === 'expired' ? 'Expired' : null
// Another member's agent can only lose the tokens it made here, so once none is active there is nothing to revoke.
const rowState = (row: Row): ReactNode => {
  const state = row.kind === 'key' ? keyLocked(row.key) ? keyState(row.key) : null : row.kind === 'token' ? tokenState(row.token) : row.kind === 'app' ? null : agentState(row.agent)
  return state ? <span className="muted">{state}</span> : row.kind === 'agent' && !row.agent.own && !row.agent.tokens.some(token => !tokenState(token)) ? <span className="muted">—</span> : null
}
const rowName = (row: Row) => row.kind === 'key' ? row.key.name : row.kind === 'agent' ? connectionTitle(row.agent) : row.kind === 'token' ? row.token.purpose : row.password.name
// Everything about an API key is edited on its secret, an expired one's expiry included.
const editable = (row: Row): row is Extract<Row, { kind: 'key' }> => row.kind === 'key' && !keyLocked(row.key)
const revokeLabel = (row: Row) => row.kind === 'key' ? 'Revoke key' : row.kind === 'agent' ? (row.agent.own ? 'Revoke agent' : 'Revoke its tokens') : row.kind === 'token' ? 'Revoke token' : 'Revoke password'
// An agent's key says which agent it is for, where its name doesn't already (a key named before it did, or renamed).
const agentClient = (key: ApiKey) => key.agent?.client && !key.name.startsWith(key.agent.client) ? `${key.agent.client} · ` : ''
const expiry = (token: AgentTokenSummary) => tokenState(token) ?? `Expires ${shortDateTime(token.expiresAt)} UTC`

export function ApiKeysPage() {
  // /api-keys?connect=1 (from Overview and Docs) opens Connect your agent. Members connect one as themselves too, so
  // their locked page keeps the button.
  const [connectLink] = useState(() => new URLSearchParams(window.location.search).has('connect'))
  return useWorkspaceAccess().canAdminister ? <ApiKeys connectLink={connectLink} /> : <AdminOnlyPage title="API keys" button="Create key" actions={<ConnectAgentButton initiallyOpen={connectLink} />} />
}
function ApiKeys({ connectLink }: { connectLink: boolean }) {
  const toast = useToast()
  const [showRevoked, setShowRevoked] = useState(false)
  const [type, setType] = useState<KeyTypeFilter>('all')
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const keys = useApiDef(queries.keys(cursor, showRevoked), { keepPrevious: true })
  const agents = useApiDef(queries.agents(showRevoked), { keepPrevious: true })
  const passwords = useApiDef(queries.appPasswords())
  const addresses = useApiDef(queries.inboundAddressOptions())
  const revokeKey = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked', false, invalidate.apiKeys)
  // Your own agent loses its sign-in and every token; another member's loses the tokens it made here.
  const revokeAgent = useApiMutation(async (api, id: string) => { const result = await api.credentials.revokeAgent(id); toast(result.scope === 'agent' ? 'Agent revoked' : 'Agent tokens revoked', 'success') }, undefined, false, invalidate.agents)
  const revokeToken = useApiMutation((api, id: string) => api.credentials.revokeAgentToken(id), 'Agent token revoked', false, invalidate.agents)
  const revokePassword = useApiMutation((api, password: AppPassword) => api.credentials.revokeAppPassword(password.inboxId, password.id), 'App password revoked', false, invalidate.appPasswords)
  // /api-keys?create=send&domain=acme.com opens Create key on an API key, filled in (Overview's setup step links here),
  // /api-keys?create=smtp on an SMTP login (the Keys guide links there) and /api-keys?create=app on an app password
  // (onboarding's inbox for myself links there);
  // the parameters then leave the URL, so Back and reload don't open it again. A link followed while the page is open
  // (⌘K's New API key) opens the form the same way; Create key opens it from the start.
  const [params, setParams] = useSearchParams()
  const mailServers = useMailServers()
  const linked = (params: URLSearchParams) => {
    if (!params.has('create')) return undefined
    // Without a mail gateway an SMTP login could never sign in: the link opens the key types instead.
    if (params.get('create') === 'smtp') return mailServers ? { smtp: true } : {}
    if (params.get('create') === 'app') return { app: true }
    const asked = params.get('create') === 'inbound' ? 'addresses' : params.get('create')
    return { purpose: (['send', 'read_send', 'read', 'manage', 'addresses', 'inbox', 'create'] as Purpose[]).find(value => value === asked) ?? 'send', domain: params.get('domain') || undefined }
  }
  const [initial, setInitial] = useState(() => linked(params))
  const [open, setOpen] = useState(Boolean(initial))
  // Warm domains while on API keys so Create key opens directly to the API key form without shifting as domains land.
  const createDomains = useDomainOptions(true)
  const [connecting, setConnecting] = useState(connectLink)
  useEffect(() => {
    if (!params.has('create')) return
    setInitial(linked(params)); setOpen(true)
    setParams(previous => { const next = new URLSearchParams(previous); next.delete('create'); next.delete('domain'); return next }, { replace: true })
  }, [params, setParams]) // eslint-disable-line react-hooks/exhaustive-deps
  const [secret, setSecret] = useState<CreatedSecret | null>(null)
  const [revoking, setRevoking] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)
  const [editing, setEditing] = useState<ApiKey | null>(null)
  // The row or card a key's details opened from: Revoke and Edit replace the details dialog, so when they close, focus
  // goes back there rather than to the page's top.
  const opener = useRef<HTMLElement | null>(null)
  const view = (row: Row) => { const focused = document.activeElement; opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null; setViewing(row) }
  const referencedIds = (keys.data ?? []).flatMap(key => key.access.type === 'addresses' ? key.access.addressIds ?? [] : [])
  const resolvedAddresses = useResolvedAddresses(referencedIds, addresses.data ?? [], Boolean(keys.data && addresses.data), addresses.data?.nextCursor ?? null)
  const address = (id: string) => resolvedAddresses.byId.get(id)?.address ?? addresses.data?.find(item => item.id === id)?.address ?? id
  // Edit opens once what its form lists has loaded (a workspace key's domains, an inbox key's inboxes), so they don't
  // push its fields down as they arrive.
  const editDomains = useDomainOptions(editing?.access.type === 'workspace')
  const editInboxes = useInboxOptions('key-options', {}, editing?.access.type === 'inbox')
  const editReady = editing && !(editing.access.type === 'workspace' ? editDomains.isPending : editing.access.type === 'inbox' && editInboxes.isPending)
  const actions = (row: Row) => [...editable(row) ? [{ label: 'Edit', onSelect: () => { opener.current = null; setEditing(row.key) } }] : [], { label: revokeLabel(row), destructive: true, onSelect: () => { opener.current = null; setRevoking(row) } }]

  // Hide empty credential-type tabs once counts arrive; keep a tab if its read failed so the user can retry it.
  const countsReady = !keys.isPending && !agents.isPending && !passwords.isPending
  const nonEmpty = keyTypes.filter(item => item.value !== 'all' && (
    item.value === 'api' ? Boolean(keys.error || keys.data?.length)
      : item.value === 'agent' ? Boolean(agents.error || agents.data?.length)
      : Boolean(passwords.error || passwords.data?.length)
  ))
  const visibleTabs = !countsReady ? [...keyTypes].filter(item => item.value !== 'app') : nonEmpty.length > 1 ? [keyTypes[0], ...nonEmpty] : []
  const activeType: KeyTypeFilter = visibleTabs.some(item => item.value === type) ? type : 'all'

  // API keys page by cursor; agents and app passwords aren't paginated, so they join the first page. Each source fails
  // on its own: the others still list, with one error and a retry for every source that failed.
  const firstPage = !cursor
  const sources = [
    ...(activeType === 'all' || activeType === 'api' ? [{ query: keys }] : []),
    ...((activeType === 'all' && firstPage) || activeType === 'agent' ? [{ query: agents }] : []),
    ...((activeType === 'all' && firstPage) || activeType === 'app' ? [{ query: passwords }] : []),
  ]
  const failed = sources.filter(source => source.query.error)
  const keysShown = activeType === 'all' || activeType === 'api'
  // Addresses name a limited key's scope; without them the key would list IDs, so it waits for them (not their failure).
  // A previous page or filter kept as placeholder counts as loading, so its rows never show live Revoke buttons as this page's.
  const listLoading = sources.some(source => source.query.isPending || source.query.isPlaceholderData) || keysShown && addresses.isPending
  const listFailed = failed.length === sources.length
  const included = (query: typeof keys | typeof agents | typeof passwords) => sources.some(source => source.query === query) && !query.error
  const rows: Row[] = [
    ...(included(keys) ? newestFirst(keys.data ?? []).map(key => ({ kind: 'key' as const, id: key.id, key })) : []),
    ...(included(agents) ? newestFirst(agents.data ?? []).flatMap(agent => [{ kind: 'agent' as const, id: agent.id, agent }, ...newestFirst(agent.tokens).map(token => ({ kind: 'token' as const, id: token.id, token }))]) : []),
    // App passwords are active only: revoking one removes it.
    ...(included(passwords) ? newestFirst(passwords.data ?? []).map(password => ({ kind: 'app' as const, id: password.id, password })) : []),
  ]
  const active = showRevoked ? '' : 'active '
  const empty = failed.length ? <EmptyState title="Nothing else to show" />
    : cursor && keysShown ? <EmptyState title="No keys on this page" />
    : activeType === 'api' ? <EmptyState title={`No ${active}API keys`} />
    : activeType === 'agent' ? <EmptyState title="No agents connected" action={<Button onClick={() => setConnecting(true)}>Connect your agent</Button>} />
    : activeType === 'app' ? <EmptyState title="No app passwords" />
    : <EmptyState title={`No ${active}keys`} />

  const keyAccess = (key: ApiKey): { first: ReactNode; second: string } => {
    const { access } = key
    if (access.type === 'workspace') return { first: accessLabel(key.permissions, key.domains.length === 0), second: domainScope(key.domains) }
    if (access.type === 'inbox') return { first: <>Inbox: <PrivateAddress value={address(access.inboxId ?? '')} /></>, second: mailLabel(access.mail) }
    if (access.addressIds?.length === 0) return { first: 'Creates inboxes', second: 'Reads only the inboxes it created' }
    return { first: access.addressIds ? <>Addresses: <AddressList values={access.addressIds.map(address)} /></> : 'Every address', second: mailLabel(access.mail) }
  }
  const name = (row: Row): { first: ReactNode; second: ReactNode } => {
    if (row.kind === 'key') return { first: row.key.name, second: `${agentClient(row.key)}Created ${date(row.key.createdAt)}${row.key.expiresAt && !row.key.revokedAt ? ` · ${past(row.key.expiresAt) ? 'ended' : 'ends'} ${date(row.key.expiresAt)}` : ''}` }
    if (row.kind === 'agent') return { first: connectionTitle(row.agent), second: row.agent.own ? row.agent.clientId : <PrivateAddress value={row.agent.userEmail} /> }
    if (row.kind === 'token') return { first: row.token.purpose, second: expiry(row.token) }
    return { first: row.password.name, second: `Created ${date(row.password.createdAt)}` }
  }
  const access = (row: Row): { first: ReactNode; second: ReactNode } => {
    if (row.kind === 'key') return keyAccess(row.key)
    if (row.kind === 'agent') return { first: agentAccess(row.agent.permissions), second: `Signed in ${date(row.agent.createdAt)}` }
    if (row.kind === 'token') return { first: accessLabel(row.token.permissions, false), second: domainScope(row.token.domains) }
    return { first: protocolLabel(row.password.protocols), second: <PrivateAddress value={row.password.inboxAddress} /> }
  }
  const used = (row: Row) => row.kind === 'key' ? lastUsed(row.key.lastUsedAt) : row.kind === 'agent' ? lastUsed(row.agent.lastUsedAt) : row.kind === 'token' ? lastUsed(row.token.lastUsedAt) : <span className="muted" title={`${productName} doesn’t track an app password’s last use`}>—</span>
  // On a phone the last line says what matters most for each: a key's prefix and use, a token's expiry.
  const cardLast = (row: Row) => {
    if (row.kind === 'key') return <><code>{row.key.prefix}</code> · {keyState(row.key) ?? usedLine(row.key.lastUsedAt)}</>
    if (row.kind === 'agent') return agentState(row.agent) ?? usedLine(row.agent.lastUsedAt)
    if (row.kind === 'token') return expiry(row.token)
    return `Created ${date(row.password.createdAt)}`
  }
  // A key created over MCP works only while that agent's approval is active.
  const tiedTo = (tie: ApprovalTie) => { const names = tie.owners.flatMap(owner => { const agent = agents.data?.find(item => item.id === owner.id); return agent ? [connectionTitle(agent)] : [] }); return names.length ? `${names.join(', ')} · ${approvalLabel(tie)}` : approvalLabel(tie) }
  // Everything a row shows, in full: the table and the phone's cards clip long names, scopes and address lists.
  const details = (row: Row): [string, ReactNode][] => {
    const { first, second } = access(row)
    if (row.kind === 'key') return [['Type', typeName.key], ...(row.key.agent ? [['Client', row.key.agent.client ? <><bdi>{row.key.agent.client}</bdi><span className="muted"> · as the agent named itself</span></> : <span className="muted">The agent didn’t name itself</span>] as [string, ReactNode]] : []), ['Access', first], [row.key.access.type === 'workspace' ? 'Domains' : 'Mail', second], ['Key prefix', <code>{row.key.prefix}</code>], ['Created', date(row.key.createdAt)], ['Expires', row.key.expiresAt ? `${past(row.key.expiresAt) ? 'Ended ' : ''}${shortDateTime(row.key.expiresAt)} UTC` : 'Never'], ['Last used', lastUsed(row.key.lastUsedAt)], ...(row.key.lastChange ? [['Last changed', <>{date(row.key.lastChange.at)} · <Who actor={row.key.lastChange.actor} /></>] as [string, ReactNode]] : []), ...(row.key.approval ? [['Agent approval', tiedTo(row.key.approval)] as [string, ReactNode]] : []), ...(row.key.revokedAt ? [['Revoked', date(row.key.revokedAt)] as [string, ReactNode]] : [])]
    if (row.kind === 'agent') return [['Type', typeName.agent], ['Access', first], ['Client', row.agent.clientId], ['Account', row.agent.own ? 'You' : <PrivateAddress value={row.agent.userEmail} />], ['Signed in', date(row.agent.createdAt)], ['Last used', lastUsed(row.agent.lastUsedAt)], ['Status', agentState(row.agent) ?? 'Active']]
    if (row.kind === 'token') return [['Type', typeName.token], ['Access', first], ['Domains', second], ['Expires', tokenState(row.token) ?? `${shortDateTime(row.token.expiresAt)} UTC`], ['Last used', lastUsed(row.token.lastUsedAt)]]
    return [['Type', typeName.app], ['Access', first], ['Inbox', second], ['Created', date(row.password.createdAt)]]
  }
  const [nameColumn, typeColumn, accessColumn, prefixColumn, lastColumn, actionsColumn] = settingsColumns.keys

  return <div className="stack">
    <PageHeader title="API keys" actions={<Button variant="primary" onClick={() => { setInitial(undefined); setOpen(true) }} data-analytics="keys/create">Create key</Button>} />
    <div className="keys-sections">
      <section className="section stack" aria-label="Keys">
        <div className="data-toolbar keys-toolbar">
          {visibleTabs.length > 0 && <Tabs label="Type" value={activeType} disabled={!countsReady} onValueChange={value => { setType(value as KeyTypeFilter); pagination.reset() }} items={visibleTabs} />}
          <div className="keys-inactive"><Checkbox label="Show inactive" checked={showRevoked} onCheckedChange={checked => { setShowRevoked(checked); pagination.reset() }} /></div>
        </div>
        {!listFailed && <DataTable className="keys-table ui-table--two-line" loading={listLoading} skeletonRows={3} rows={rows} rowKey={row => row.id} onRowClick={view} empty={empty}
          columns={[
            { ...nameColumn, render: row => <TwoLines nested={row.kind === 'token'} first={name(row).first} second={name(row).second} />, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{name(row).first}</span> },
            ...(activeType === 'all' ? [{ ...typeColumn, render: (row: Row) => typeName[row.kind] }] : []),
            { ...accessColumn, render: row => <TwoLines first={access(row).first} second={access(row).second} />, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{access(row).first} · {access(row).second}</span> },
            { ...prefixColumn, render: row => row.kind === 'key' ? <code>{row.key.prefix}</code> : <span className="muted">—</span> },
            { ...lastColumn, render: used, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{cardLast(row)}</span> },
            { ...actionsColumn, render: row => rowState(row) ?? <DropdownMenu label={`Actions for ${rowName(row)}`} title={rowName(row)} items={actions(row)} />,
              cardRender: row => rowState(row) ? null : <DropdownMenu label={`Actions for ${rowName(row)}`} title={rowName(row)} items={actions(row)} /> },
          ]} />}
        {failed.length > 0 && <ErrorState error={failed[0].query.error} onRetry={() => failed.forEach(source => void source.query.refetch())} />}
        {keysShown && !listLoading && (!keys.error || pagination.page > 1) && <Pagination page={pagination.page} pageSize={100} nextCursor={keys.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, keys.data?.nextCursor)} />}
      </section>
    </div>
    {open && !createDomains.isPending && <CreateKeyDialog open onOpenChange={setOpen} initial={initial} onCreated={setSecret} />}
    <ConnectAgentDialog open={connecting} onOpenChange={setConnecting} />
    <SecretDialog secret={secret?.secret ?? null} title={secret?.title ?? 'Key created'} description={secret?.description} onClose={() => setSecret(null)}>{secret?.sendExample && <KeySendExample apiKey={secret.secret} />}{secret?.agent && <McpKeySetup secret={secret.secret} env={apiKeyEnv} />}{secret?.mail && <MailSettings username={secret.mail.username} imap={secret.mail.imap} smtp={secret.mail.smtp} />}</SecretDialog>
    <KeyDetails row={viewing} fields={viewing ? details(viewing) : []} onClose={() => setViewing(null)} onRevoke={row => { setViewing(null); setRevoking(row) }} onEdit={key => { setViewing(null); setEditing(key) }} />
    {editing && editReady && <EditKeyDialog apiKey={editing} onClose={() => setEditing(null)} returnFocus={opener} />}
    <RevokeDialog row={revoking} returnFocus={opener} onClose={() => setRevoking(null)} pending={revokeKey.isPending || revokeAgent.isPending || revokeToken.isPending || revokePassword.isPending}
      onConfirm={async row => {
        if (row.kind === 'key') await revokeKey.mutateAsync(row.key.id)
        else if (row.kind === 'agent') await revokeAgent.mutateAsync(row.agent.id)
        else if (row.kind === 'token') await revokeToken.mutateAsync(row.token.id)
        else await revokePassword.mutateAsync(row.password)
      }} />
  </div>
}

// One row in full, with its actions: the way to read a long name or address list on a phone, where a card clips it. Its
// state beside the title; what it can reach, then its prefix, ID and dates; a key's changes in a second tab, loaded
// with the dialog. Both tabs share one cell sized by the details, and the changes scroll inside it, so neither switching
// tabs nor the history arriving moves the footer.
const accessFacts = new Set(['Type', 'Access', 'Domains', 'Mail', 'Inbox', 'Client', 'Account', 'Agent approval'])
// What identifies the key; the rest (created, last used, expires) is its dates.
const keyFacts = new Set(['Key prefix', 'ID'])
const stateOf = (row: Row) => row.kind === 'key' ? keyState(row.key) : row.kind === 'token' ? tokenState(row.token) : row.kind === 'agent' ? agentState(row.agent) : null
function KeyDetails({ row, fields, onClose, onRevoke, onEdit }: { row: Row | null; fields: [string, ReactNode][]; onClose: () => void; onRevoke: (row: Row) => void; onEdit: (key: ApiKey) => void }) {
  const [tab, setTab] = useState('details')
  const id = row?.id
  useEffect(() => { setTab('details') }, [id])
  const state = row ? stateOf(row) : null
  const facts = fields.filter(([label]) => label !== 'Status')
  const life: [string, ReactNode][] = [...facts.filter(([label]) => !accessFacts.has(label)), ...(row?.kind === 'key' ? [['ID', <span className="ui-kv__id"><code>{row.key.id}</code><CopyButton value={row.key.id} label="Copy key ID" /></span>] as [string, ReactNode]] : [])]
  return <Dialog size="lg" open={row !== null} onOpenChange={next => { if (!next) onClose() }} title={row ? rowName(row) : ''}
    status={row && <StatusBadge status={state ?? 'Active'} tone={state === 'Revoked' || state === 'Ended' ? 'danger' : state ? 'warning' : 'success'} />}
    footer={row && (!rowState(row) || editable(row)) ? <>
      {!rowState(row) && <Button variant="danger" className="ui-dialog__footer-start" onClick={() => onRevoke(row)}>{revokeLabel(row)}</Button>}
      {editable(row) && <Button variant="primary" onClick={() => onEdit(row.key)}>Edit</Button>}
    </> : undefined}>
    {row?.kind === 'key' && <Tabs label="Key" value={tab} onValueChange={setTab} items={[{ value: 'details', label: 'Details' }, { value: 'changes', label: 'Changes' }]} />}
    <div className="keys-panels">
      <div className="keys-details" data-inactive={tab !== 'details' || undefined} inert={tab !== 'details'}>
        <h3 className="ui-label ui-label--rule">Permissions</h3>
        <KeyValues items={facts.filter(([label]) => accessFacts.has(label))} />
        {life.some(([label]) => keyFacts.has(label)) && <><h3 className="ui-label ui-label--rule">Key</h3>
        <KeyValues items={life.filter(([label]) => keyFacts.has(label))} /></>}
        <h3 className="ui-label ui-label--rule">Dates</h3>
        <KeyValues items={life.filter(([label]) => !keyFacts.has(label))} />
      </div>
      {row?.kind === 'key' && <div className="keys-changes" data-inactive={tab !== 'changes' || undefined} inert={tab !== 'changes'}><KeyChanges keyId={row.key.id} /></div>}
    </div>
  </Dialog>
}

// What changed in each entry, named by field: "name, domains".
const fieldWords: Record<string, string> = { name: 'name', permissions: 'permissions', domains: 'domains', access: 'access', expiresAt: 'expiry' }
function changedFields(summary: Record<string, unknown>) {
  const before = (summary.before ?? {}) as Record<string, unknown>, after = (summary.after ?? {}) as Record<string, unknown>
  return Object.keys(fieldWords).filter(field => (field in before || field in after) && JSON.stringify(before[field]) !== JSON.stringify(after[field])).map(field => fieldWords[field]).join(', ')
}
function KeyChanges({ keyId }: { keyId: string }) {
  const changes = useApiDef(queries.keyChanges(keyId))
  if (changes.error) return <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
  if (!changes.data) return <p className="muted" role="status">Loading changes…</p>
  if (!changes.data.length) return <EmptyState title="No changes in the last year" />
  return <ol className="keys-change-list">{changes.data.map(entry => { const fields = entry.action === 'api_key.update' ? changedFields(entry.summary) : ''; return <li key={entry.id}>
    <span>{actionLabel(entry.action)}{fields && <span className="muted">: {fields}</span>}</span>
    <span className="muted">{shortDateTime(entry.at)} UTC · <Who actor={entry.actor} /></span>
  </li> })}</ol>
}

// What revoking each one ends, said before it happens.
function RevokeDialog({ row, onClose, onConfirm, pending, returnFocus }: { row: Row | null; onClose: () => void; onConfirm: (row: Row) => Promise<void>; pending: boolean; returnFocus: RefObject<HTMLElement | null> }) {
  const description: ReactNode = !row ? ''
    : row.kind === 'key' ? row.key.access.type === 'workspace' ? 'Requests using this key will stop working. Revoking a key cannot be undone.' : 'Agents using this key stop working immediately, and queued mail it sent will not be dispatched. Revoking cannot be undone.'
    : row.kind === 'agent' ? row.agent.own ? 'This revokes its sign-in and every agent token it made: they stop working immediately.' : <>This revokes the agent tokens it made in this workspace. The sign-in belongs to <PrivateAddress value={row.agent.userEmail} />.</>
    : row.kind === 'token' ? 'This short-lived token stops working immediately. Revoking it cannot be undone.'
    : 'Mail apps using it are signed out and can’t sign in with it again. The inbox and its mail stay.'
  const label = row ? revokeLabel(row) : 'Revoke'
  return <ConfirmDialog open={row !== null} onOpenChange={next => { if (!next) onClose() }} title={`Revoke ${row ? rowName(row) : 'key'}?`} description={description} confirmLabel={label} danger pending={pending} returnFocus={returnFocus} onConfirm={async () => { if (row) await onConfirm(row) }} />
}

function TwoLines({ first, second, nested = false }: { first: ReactNode; second: ReactNode; nested?: boolean }) {
  return <div className={`settings-cell-stack keys-cell${nested ? ' keys-cell--nested' : ''}`}><span title={typeof first === 'string' ? first : undefined}>{first}</span><span className="muted" title={typeof second === 'string' ? second : undefined}>{second}</span></div>
}
