import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Button, Checkbox, Dialog, Disclosure, Field, Input, fieldError, MutationError } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiDef, useApiMutation, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { ApiKeyInput, AppPasswordInput, AppPasswordProtocol, Inbox, KeyPermission, MailPermission, PageRequest } from '../../data/types'
import '../inbound/inbound.css'
import './api-keys.css'

/** What a new API key can reach: the whole workspace (four permission sets), or only mail at chosen addresses, one
 *  agent inbox, or the inboxes it creates. `/api-keys?create=<purpose>` opens Create key on it. */
export type Purpose = 'manage' | 'send' | 'read_send' | 'read' | 'addresses' | 'inbox' | 'create'
type WorkspacePurpose = Extract<Purpose, 'manage' | 'send' | 'read_send' | 'read'>
const workspacePermissions: Record<WorkspacePurpose, KeyPermission[]> = { manage: ['read', 'send', 'manage'], send: ['send'], read_send: ['read', 'send'], read: ['read'] }
const isWorkspace = (purpose: Purpose): purpose is WorkspacePurpose => purpose in workspacePermissions
// Each choice is named for what it reaches; what it can and can't do is in "What this key can do", which opens under
// the form and follows the choices.
const purposes: { value: Purpose; label: string; does: string }[] = [
  { value: 'manage', label: 'Full access', does: 'Sends, reads, and manages domains, keys and settings.' },
  { value: 'send', label: 'Sending only', does: 'Sends email from your app. Can’t read logs or change settings.' },
  { value: 'read_send', label: 'Send and read', does: 'Sends email and reads logs and events. Can’t change settings.' },
  { value: 'read', label: 'Read only', does: 'Reads logs, events and settings. Can’t send.' },
  { value: 'addresses', label: 'Mail at chosen addresses', does: 'Reads mail at the receiving addresses you choose. Nothing else.' },
  { value: 'inbox', label: 'One agent inbox', does: 'Reads one agent inbox. Stops working when the inbox is deleted.' },
  { value: 'create', label: 'Creates agent inboxes', does: 'Creates agent inboxes and reads only the ones it created.' },
]
type Kind = 'api' | 'agent' | 'app'
// The type's name says who uses it; the page's "Which key to use" compares them.
const kinds: { value: Kind; label: string }[] = [
  { value: 'api', label: 'API key for your app or script' },
  { value: 'agent', label: 'Connect an agent over MCP' },
  { value: 'app', label: 'App password for a mail app' },
]
/** sendExample: a workspace key's first send. agent: an API key, which also connects an agent over MCP. */
export type CreatedSecret = { secret: string; title: string; description?: string; sendExample?: boolean; agent?: boolean }

/** Create key: the type first (API key, agent token, app password), then what it can reach. An agent token is the
 *  Connect an agent flow, so choosing it hands over to that dialog. `initial` opens straight on an API key's form, as
 *  Overview's "Create key" does with the domain it just verified. Render only while open, so form state and the created
 *  secret in mutation state go away on close. */
export function CreateKeyDialog({ open, onOpenChange, onCreated, onConnectAgent, initial }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (created: CreatedSecret) => void; onConnectAgent: () => void; initial?: { purpose?: Purpose; domain?: string } }) {
  const [kind, setKind] = useState<Kind | null>(initial ? 'api' : null)
  const [pending, setPending] = useState(false)
  // One dialog for every step, so moving between them keeps focus inside it.
  const form = kind === 'api' ? { title: 'Create API key', id: 'create-key', submit: 'Create key' } : kind === 'app' ? { title: 'Create app password', id: 'create-app-password', submit: 'Create password' } : null
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title={form?.title ?? 'Create key'}
    footer={form ? <><Button disabled={pending} onClick={() => setKind(null)}>Back</Button><Button variant="primary" loading={pending} type="submit" form={form.id}>{form.submit}</Button></> : <Button onClick={() => onOpenChange(false)}>Cancel</Button>}>
    {kind === 'api' ? <ApiKeyForm open={open} onOpenChange={onOpenChange} onPending={setPending} onCreated={onCreated} initial={initial} />
      : kind === 'app' ? <AppPasswordForm open={open} onOpenChange={onOpenChange} onPending={setPending} onCreated={onCreated} />
      : <ul className="keys-types" aria-label="What kind of key?">
        {kinds.map(item => <li key={item.value}>
          <button type="button" className="keys-type" onClick={() => { if (item.value === 'agent') { onOpenChange(false); onConnectAgent() } else setKind(item.value) }}>
            <span className="keys-type__label">{item.label}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>)}
      </ul>}
  </Dialog>
}

/** Active inboxes to choose from, a page of 50 at a time: Load more reaches the rest. */
function useInboxOptions(key: string, filter: { type?: Inbox['type'] }, enabled: boolean) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: ['nightmail', 'agent-inboxes', key],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.inboxes.list({ ...filter, status: 'active', cursor: pageParam }, signal),
    getNextPageParam: last => last.nextCursor ?? undefined,
    staleTime: 60_000,
    retry: false,
  })
}
const activeInboxes = (query: ReturnType<typeof useInboxOptions>) => (query.data?.pages.flat() ?? []).filter(box => box.status === 'active')

/** Which inbox: a radio list, because a select would show the address unmasked. With none to choose, its place is the
 *  link to make one. */
function InboxChoice({ name, query, value, onChange, disabled, error, none }: { name: string; query: ReturnType<typeof useInboxOptions>; value: string; onChange: (id: string) => void; disabled: boolean; error?: string; none: ReactNode }) {
  const inboxes = activeInboxes(query)
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? `${name}-error` : undefined}>
    <legend className="ui-field__label">Inbox</legend>
    {query.isPending && !query.isError ? <p className="muted" role="status">Loading inboxes…</p> : !inboxes.length && !query.isError ? <div className="keys-form-note">{none}</div>
      : <div className="settings-key-domain-options">{inboxes.map(box => <label key={box.id} className="keys-choice">
        <input type="radio" name={name} value={box.id} checked={value === box.id} onChange={() => onChange(box.id)} />
        <span>{box.name ? <>{box.name} · </> : null}<PrivateAddress value={box.address} /></span>
      </label>)}</div>}
    {query.isError && <div className="stack"><MutationError error={query.error} /><Button onClick={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()) }}>Retry loading inboxes</Button></div>}
    {query.hasNextPage && !query.isError && <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more inboxes</Button>}
    {error && <p id={`${name}-error`} className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

export const chooseAddress = 'Choose an address, or Every address.'
/** Which receiving addresses a key reaches, or every one: one control for Create key and a key's Edit addresses.
 *  `empty` takes the options' place while they load or when there are none. */
export function AddressChoice({ id, options, every, chosen, onEvery, onToggle, disabled, error, empty }: { id: string; options: { id: string; address: string }[]; every: boolean; chosen: string[];
  onEvery: (every: boolean) => void; onToggle: (id: string, checked: boolean) => void; disabled: boolean; error?: string; empty?: ReactNode }) {
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? `${id}-error` : undefined}>
    <legend className="ui-field__label">Addresses</legend>
    <Checkbox label="Every address, including new ones" checked={every} onCheckedChange={onEvery} disabled={disabled} />
    <div className="settings-key-domain-options">
      {empty ?? options.map(item => <Checkbox key={item.id} label={<PrivateAddress value={item.address} />} checked={!every && chosen.includes(item.id)} disabled={disabled} onCheckedChange={checked => onToggle(item.id, checked)} />)}
    </div>
    {error && <p id={`${id}-error`} className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

type FormProps = { open: boolean; onOpenChange: (open: boolean) => void; onPending: (pending: boolean) => void; onCreated: (created: CreatedSecret) => void }

function ApiKeyForm({ open, onOpenChange, onPending, onCreated, initial }: FormProps & { initial?: { purpose?: Purpose; domain?: string } }) {
  const api = useApi()
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input))
  const addresses = useApiDef(queries.inboundAddressOptions())
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<Purpose>(initial?.purpose ?? 'send')
  const [allDomains, setAllDomains] = useState(!initial?.domain)
  const [selectedDomains, setSelectedDomains] = useState<string[]>(initial?.domain ? [initial.domain.toLowerCase()] : [])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [inboxId, setInboxId] = useState('')
  const [reply, setReply] = useState(false)
  const [organize, setOrganize] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const workspace = isWorkspace(purpose)
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const domainOptions = useInfiniteQuery({
    queryKey: ['nightmail', 'domains', 'key-options'],
    enabled: open && workspace,
    initialPageParam: { page: 1 } as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({ pageParam, signal }) => api.domains.list({ ...pageParam, pageSize: 10 }, signal),
    getNextPageParam: last => last.nextCursor ? { cursor: last.nextCursor } : undefined,
    staleTime: 60_000,
    retry: false,
  })
  const inboxes = useInboxOptions('key-options', {}, open && purpose === 'inbox')
  const options = (domainOptions.data?.pages.flatMap(page => page.items) ?? []).map(domain => domain.name.toLowerCase())
  const domains = [...new Set([...options, ...selectedDomains])].sort()
  // Inboxes have their own choice; this list is the receiving addresses.
  const receiving = (addresses.data ?? []).filter(item => item.kind !== 'inbox')
  const chosenInbox = inboxId || activeInboxes(inboxes)[0]?.id || ''
  const nameError = errors.name || fieldError(create.error, 'name')
  const domainError = errors.domains || fieldError(create.error, 'domains')
  const addressError = errors.addressIds || fieldError(create.error, 'access.addressIds')
  const inboxError = errors.inboxId || fieldError(create.error, 'access.inboxId')
  const mailError = fieldError(create.error, 'access.mail')

  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  function toggleDomain(domain: string, checked: boolean) {
    clearError('domains')
    setAllDomains(false)
    setSelectedDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain))
  }
  function toggleAddress(id: string, checked: boolean) {
    clearError('addressIds')
    setAllAddresses(false)
    setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name for this key.'
    if (workspace && !allDomains && !selectedDomains.length) next.domains = 'Select at least one domain, or choose All domains.'
    else if (workspace && !allDomains && selectedDomains.length > 50) next.domains = 'Select up to 50 domains.'
    if (purpose === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = chooseAddress
    if (purpose === 'inbox' && !chosenInbox) next.inboxId = 'Choose an inbox.'
    setErrors(next)
    if (Object.keys(next).length) { if (next.name) document.getElementById('key-name')?.focus(); return }
    const mail: MailPermission[] = ['read', ...(reply ? ['send' as const] : []), ...(organize ? ['modify' as const] : [])]
    const input: ApiKeyInput = isWorkspace(purpose) ? { name: name.trim(), permissions: workspacePermissions[purpose], domains: allDomains ? [] : selectedDomains }
      : purpose === 'addresses' ? { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail } }
      : purpose === 'inbox' ? { name: name.trim(), access: { type: 'inbox', inboxId: chosenInbox, mail: mail.filter(p => p !== 'create') as Exclude<MailPermission, 'create'>[] } }
      : { name: name.trim(), access: { type: 'addresses', addressIds: [], mail: ['create', 'read', 'modify'] } }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      onCreated({ secret: result.secret, title: 'API key created', sendExample: workspace, agent: true })
    } catch { /* Shown in the form. */ }
  }

  // A sending domain covers its subdomains (SENDER_DOMAIN_FORBIDDEN names "this domain or its parent domain").
  const example = selectedDomains[0] ?? domains[0]
  const placeholder = workspace ? 'Order notifications' : purpose === 'create' ? 'End-to-end tests' : purpose === 'inbox' ? 'Sign-up test' : 'Support agent'
  const where = purpose === 'inbox' ? 'this inbox' : 'these addresses'
  // What the choices above add up to, in plain lines: the detail behind "What this key can do".
  const can = [
    purposes.find(item => item.value === purpose)!.does,
    ...workspace && !allDomains ? [`Sends and email logs are limited to the chosen domains and their subdomains${example ? `: ${example} also covers mail from news.${example}` : ''}.`, 'Contacts, lists, templates and campaigns stay workspace-wide.', ...purpose === 'manage' ? ['Limited to domains, it can’t manage keys, inbound or settings.'] : []] : [],
    ...purpose === 'addresses' || purpose === 'inbox' ? ['Lists and reads mail, events and attachments.', ...reply ? [`Replies and starts conversations, from ${where} only.${purpose === 'inbox' ? ' Needs replies on for the inbox.' : ''}`] : [], ...organize ? ['Marks read, archives, stars and labels.'] : []] : [],
  ]

  return <>
    <form id="create-key" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="key-name" error={nameError}><Input id="key-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder={placeholder} /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can reach</legend>
        {purposes.map(item => <label key={item.value} className="keys-choice">
          <input type="radio" name="key-purpose" value={item.value} checked={purpose === item.value} onChange={() => { setPurpose(item.value); setErrors({}); create.reset() }} />
          <span>{item.label}</span>
        </label>)}
      </fieldset>
      {workspace && <fieldset className="settings-key-domains" disabled={pending} aria-describedby={domainError ? 'key-domain-error' : undefined}>
        <legend className="ui-field__label">Domains it can send from</legend>
        <Checkbox label="All domains, including new ones" checked={allDomains} onCheckedChange={checked => { setAllDomains(checked); setSelectedDomains([]); clearError('domains') }} disabled={pending} />
        <div className="settings-key-domain-options">
          {domainOptions.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !domainOptions.isError ? <Link className="keys-form-note" to="/domains" onClick={() => onOpenChange(false)}>Add a domain</Link> : domains.map(domain => <Checkbox key={domain} label={domain} checked={!allDomains && selectedDomains.includes(domain)} onCheckedChange={checked => toggleDomain(domain, checked)} disabled={pending} />)}
        </div>
        {domainOptions.isError && <div className="stack"><MutationError error={domainOptions.error} /><Button onClick={() => { void (domainOptions.isFetchNextPageError ? domainOptions.fetchNextPage() : domainOptions.refetch()) }}>Retry loading domains</Button></div>}
        {domainOptions.hasNextPage && !domainOptions.isError && <Button variant="ghost" loading={domainOptions.isFetchingNextPage} onClick={() => void domainOptions.fetchNextPage()}>Load more domains</Button>}
        {domainError && <p id="key-domain-error" className="ui-field__error" role="alert">{domainError}</p>}
      </fieldset>}
      {purpose === 'addresses' && <AddressChoice id="key-address" options={receiving} every={allAddresses} chosen={addressIds} disabled={pending} error={addressError}
        onEvery={checked => { setAllAddresses(checked); setAddressIds([]); clearError('addressIds') }} onToggle={toggleAddress}
        empty={addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : !receiving.length ? <Link className="keys-form-note" to="/receiving" onClick={() => onOpenChange(false)}>Create an address</Link> : undefined} />}
      {purpose === 'inbox' && <InboxChoice name="key-inbox" query={inboxes} value={chosenInbox} onChange={id => { setInboxId(id); clearError('inboxId') }} disabled={pending} error={inboxError}
        none={<Link to="/receiving/inboxes" onClick={() => onOpenChange(false)}>Create an agent inbox</Link>} />}
      {(purpose === 'addresses' || purpose === 'inbox') && <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can do</legend>
        {[{ value: false, label: 'Read' }, { value: true, label: 'Read and reply' }].map(item => <label key={item.label} className="keys-choice">
          <input type="radio" name="key-mail" checked={reply === item.value} onChange={() => setReply(item.value)} />
          <span>{item.label}</span>
        </label>)}
        <Checkbox checked={organize} onCheckedChange={setOrganize} disabled={pending} label="Organize mail" />
        {mailError && <p className="ui-field__error" role="alert">{mailError}</p>}
      </fieldset>}
      <Disclosure className="keys-can" title="What this key can do"><ul>{can.map(line => <li key={line}>{line}</li>)}</ul></Disclosure>
    </form>
  </>
}

function AppPasswordForm({ open, onOpenChange, onPending, onCreated }: FormProps) {
  const { multiTenant } = useWorkspaceAccess()
  const create = useApiMutation((api, input: AppPasswordInput) => api.credentials.createAppPassword(input))
  const inboxes = useInboxOptions('app-password-options', { type: 'persistent' }, open)
  const [inboxId, setInboxId] = useState('')
  const [name, setName] = useState('')
  const [protocols, setProtocols] = useState<AppPasswordProtocol[]>(['imap', 'smtp'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const chosen = inboxId || activeInboxes(inboxes)[0]?.id || ''
  const toggle = (protocol: AppPasswordProtocol, checked: boolean) => { setErrors(current => ({ ...current, protocols: '' })); setProtocols(current => checked ? [...new Set([...current, protocol])] : current.filter(item => item !== protocol)) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!chosen) next.inboxId = 'Choose a persistent inbox.'
    if (!name.trim()) next.name = 'Enter a name, such as the mail app it’s for.'
    if (!protocols.length) next.protocols = 'Choose IMAP, SMTP or both.'
    setErrors(next)
    if (Object.values(next).some(Boolean)) { if (next.name && !next.inboxId) document.getElementById('app-password-name')?.focus(); return }
    try {
      const result = await create.mutateAsync({ inboxId: chosen, name: name.trim(), protocols })
      onOpenChange(false)
      onCreated({ secret: result.password, title: 'App password created', description: 'Shown once: copy it now and use it as your mail app’s password.' })
    } catch { /* Shown in the form. */ }
  }
  const protocolError = errors.protocols || fieldError(create.error, 'protocols')
  return <>
    <form id="create-app-password" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      {/* A mail app opens only an inbox that keeps its mail; those are made over the API, so its place links the guide. */}
      <InboxChoice name="app-password-inbox" query={inboxes} value={chosen} onChange={setInboxId} disabled={pending} error={errors.inboxId}
        none={<Link to="/docs/inboxes" onClick={() => onOpenChange(false)}>Create a persistent inbox</Link>} />
      <Field label="Name" htmlFor="app-password-name" error={errors.name || fieldError(create.error, 'name')}><Input id="app-password-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder="Apple Mail" autoComplete="off" /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What the mail app can do</legend>
        <Checkbox checked={protocols.includes('imap')} onCheckedChange={checked => toggle('imap', checked)} disabled={pending} label="Read and file its mail (IMAP)" />
        <Checkbox checked={protocols.includes('smtp')} onCheckedChange={checked => toggle('smtp', checked)} disabled={pending} label="Send from its address (SMTP)" />
        {multiTenant && <p className="ui-field__hint">Billed by the day while the inbox has an app password.</p>}
        {protocolError && <p className="ui-field__error" role="alert">{protocolError}</p>}
      </fieldset>
    </form>
  </>
}
