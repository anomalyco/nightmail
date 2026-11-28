import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Button, Checkbox, Dialog, Disclosure, Field, Input, SearchField, fieldError, MutationError } from '../../components/ui'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiMutation } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { SmtpUsername, useMailServers } from '../docs/mail-settings'
import type { ApiKey, ApiKeyInput, ApiKeyUpdate, AppPasswordInput, AppPasswordProtocol, Inbox, KeyPermission, MailPermission, PageRequest } from '../../data/types'
import { accessLabel } from './key-labels'
import '../inbound/inbound.css'
import './api-keys.css'

/** What a new API key can reach: the whole workspace (four permission sets), or only mail at chosen addresses, one
 *  agent inbox, or the inboxes it creates. `/api-keys?create=<purpose>` opens Create key on it. */
export type Purpose = 'manage' | 'send' | 'read_send' | 'read' | 'addresses' | 'inbox' | 'create'
type WorkspacePurpose = Extract<Purpose, 'manage' | 'send' | 'read_send' | 'read'>
const workspacePermissions: Record<WorkspacePurpose, KeyPermission[]> = { manage: ['read', 'send', 'manage'], send: ['send'], read_send: ['read', 'send'], read: ['read'] }
const isWorkspace = (purpose: Purpose | 'current'): purpose is WorkspacePurpose => purpose in workspacePermissions
// Create key offers the three common choices first; the rest open under More.
const common = new Set<Purpose | 'current'>(['manage', 'send', 'read'])
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
type Kind = 'api' | 'smtp' | 'app'
const forms: Record<Kind, { title: string; id: string; submit: string }> = {
  api: { title: 'Create API key', id: 'create-key', submit: 'Create key' },
  smtp: { title: 'Create SMTP login', id: 'create-smtp-login', submit: 'Create login' },
  app: { title: 'Create app password', id: 'create-app-password', submit: 'Create password' },
}
/** sendExample: a workspace key's first send. agent: an API key, which also connects an agent over MCP. mail: the
 *  server settings a mail app or an app's SMTP needs, with the username it signs in with. */
const NAME_MAX = 100
export type CreatedSecret = { secret: string; title: string; description?: string; sendExample?: boolean; agent?: boolean; mail?: { username: ReactNode; imap: boolean; smtp: boolean } }

/** Create key: opens directly to the API key form, with SMTP login and app password as secondary links below it.
 *  `initial` can still open straight to SMTP login (/api-keys?create=smtp) or app password (/api-keys?create=app).
 *  Render only while open, so form state and the created secret in mutation state go away on close. */
export function CreateKeyDialog({ open, onOpenChange, onCreated, initial }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (created: CreatedSecret) => void; initial?: { purpose?: Purpose; domain?: string; smtp?: boolean; app?: boolean } }) {
  // SMTP needs the installation's mail gateway: without one, fall back to the API key form.
  const servers = useMailServers()
  // Opened straight on SMTP login or app password (a link, or SMTP & IMAP's buttons), it closes with Cancel: Back is
  // for coming from the API key form.
  const [opened] = useState<Kind>(initial?.smtp && servers ? 'smtp' : initial?.app ? 'app' : 'api')
  const [kind, setKind] = useState<Kind>(opened)
  const [pending, setPending] = useState(false)
  useDomainOptions(open)
  const active: Kind = kind === 'smtp' && !servers ? 'api' : kind
  const form = forms[active]
  const props = { open, onOpenChange, onPending: setPending, onCreated }
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title={form.title}
    footer={<>{active === opened ? <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button> : <Button disabled={pending} onClick={() => setKind('api')}>Back</Button>}<Button variant="primary" loading={pending} type="submit" form={form.id}>{form.submit}</Button></>}>
    {active === 'api' ? <>
      <ApiKeyForm {...props} initial={initial} />
      <div className="keys-alt">
        <span className="muted">Or create</span>
        <div className="cluster">
          {servers && <Button variant="ghost" size="sm" disabled={pending} onClick={() => setKind('smtp')}>SMTP login</Button>}
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setKind('app')}>App password</Button>
        </div>
      </div>
    </>
      : active === 'smtp' ? <SmtpLoginForm {...props} />
      : <AppPasswordForm {...props} />}
  </Dialog>
}

/** Active inboxes to choose from, a page of 50 at a time: Load more reaches the rest. */
export function useInboxOptions(key: string, filter: { type?: Inbox['type'] }, enabled: boolean) {
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

/** A failed address read in an address choice's place, with the same retry as the domain list: never an empty list. */
function AddressesFailed({ query }: { query: { error: unknown; refetch: () => unknown } }) {
  return <div className="stack"><MutationError error={query.error} /><Button onClick={() => void query.refetch()}>Retry loading addresses</Button></div>
}

export const chooseAddress = 'Choose an address, or Every address.'
const tooManyDomains = 'Select up to 50 domains.'
/** Which receiving addresses a key reaches, or every one: one control for Create key and a key's Edit addresses.
 *  `empty` takes the options' place while they load or when there are none. */
export function AddressChoice({ id, options, every, chosen, onEvery, onToggle, disabled, error, empty, search, onSearch, searchable, hasMore, loadingMore, onLoadMore }: { id: string; options: { id: string; address: string }[]; every: boolean; chosen: string[];
  onEvery: (every: boolean) => void; onToggle: (id: string, checked: boolean) => void; disabled: boolean; error?: string; empty?: ReactNode;
  search?: string; onSearch?: (value: string) => void; searchable?: boolean; hasMore?: boolean; loadingMore?: boolean; onLoadMore?: () => void }) {
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? `${id}-error` : undefined}>
    <legend className="ui-field__label">Addresses</legend>
    <Checkbox label="Every address, including new ones" checked={every} onCheckedChange={onEvery} disabled={disabled} />
    {searchable && onSearch && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={search ?? ''} onChange={event => onSearch(event.target.value)} />}
    <div className="settings-key-domain-options">
      {empty ?? options.map(item => <Checkbox key={item.id} label={<PrivateAddress value={item.address} />} checked={!every && chosen.includes(item.id)} disabled={disabled} onCheckedChange={checked => onToggle(item.id, checked)} />)}
    </div>
    {hasMore && onLoadMore && <Button variant="ghost" size="sm" loading={loadingMore} onClick={onLoadMore}>Load more addresses</Button>}
    {error && <p id={`${id}-error`} className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

/** The workspace's sending domains, 10 at a time: Load more reaches the rest. Create key loads them as it opens, and
 *  the API keys page before it opens a form from a link, so a form's domain list never grows under its other fields. */
export function useDomainOptions(enabled: boolean) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: ['nightmail', 'domains', 'key-options'],
    enabled,
    initialPageParam: { page: 1 } as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({ pageParam, signal }) => api.domains.list({ ...pageParam, pageSize: 10 }, signal),
    getNextPageParam: last => last.nextCursor ? { cursor: last.nextCursor } : undefined,
    staleTime: 60_000,
    retry: false,
  })
}
const domainNames = (query: ReturnType<typeof useDomainOptions>, chosen: string[]) => [...new Set([...(query.data?.pages.flatMap(page => page.items) ?? []).map(domain => domain.name.toLowerCase()), ...chosen])].sort()

/** Which domains a key sends from. `every`: the All domains choice, which an SMTP login doesn't have. */
function DomainChoice({ query, chosen, onToggle, every, disabled, error, onLeave }: { query: ReturnType<typeof useDomainOptions>; chosen: string[]; onToggle: (domain: string, checked: boolean) => void;
  every?: { checked: boolean; onChange: (checked: boolean) => void }; disabled: boolean; error?: string; onLeave: () => void }) {
  const domains = domainNames(query, chosen)
  return <fieldset className="settings-key-domains" disabled={disabled} aria-describedby={error ? 'key-domain-error' : undefined}>
    <legend className="ui-field__label">Domains it can send from</legend>
    {every && <Checkbox label="All domains, including new ones" checked={every.checked} onCheckedChange={every.onChange} disabled={disabled} />}
    <div className="settings-key-domain-options">
      {query.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !query.isError ? <Link className="keys-form-note" to="/domains" onClick={onLeave}>Add a domain</Link> : domains.map(domain => <Checkbox key={domain} label={domain} checked={!every?.checked && chosen.includes(domain)} onCheckedChange={checked => onToggle(domain, checked)} disabled={disabled} />)}
    </div>
    {query.isError && <div className="stack"><MutationError error={query.error} /><Button onClick={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()) }}>Retry loading domains</Button></div>}
    {query.hasNextPage && !query.isError && <Button variant="ghost" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more domains</Button>}
    {error && <p id="key-domain-error" className="ui-field__error" role="alert">{error}</p>}
  </fieldset>
}

type FormProps = { open: boolean; onOpenChange: (open: boolean) => void; onPending: (pending: boolean) => void; onCreated: (created: CreatedSecret) => void }

/** The choice a key is now: one of the four permission sets, or what mail it reaches. A workspace key with another set
 *  of permissions keeps it (current) until another is chosen. */
type FormPurpose = Purpose | 'current'
const workspacePurposes: WorkspacePurpose[] = ['manage', 'send', 'read_send', 'read']
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.includes(item))
function purposeOf(key: ApiKey): FormPurpose {
  if (key.access.type === 'workspace') return workspacePurposes.find(purpose => sameSet(workspacePermissions[purpose], key.permissions)) ?? 'current'
  if (key.access.type === 'inbox') return 'inbox'
  return key.access.addressIds?.length === 0 && key.access.mail.includes('create') ? 'create' : 'addresses'
}
const inWorkspace = (purpose: FormPurpose): purpose is WorkspacePurpose | 'current' => purpose === 'current' || isWorkspace(purpose)
const mailOrder = (mail: MailPermission[]) => (['create', 'read', 'send', 'modify'] as const).filter(permission => mail.includes(permission))
/** A datetime-local value in UTC, to the minute. */
const utcInput = (iso: string) => iso.slice(0, 16)
const in30Days = () => utcInput(new Date(Date.now() + 30 * 86_400_000).toISOString())

/** Create key's API key form, and Edit key's: the same choices, prefilled from the key. An edit sends only what
 *  changed, adding and removing domains and addresses rather than replacing them, so an edit made meanwhile elsewhere
 *  isn't undone; the key keeps its secret. A key's kind stays: a workspace key edits as one, a key limited to mail as
 *  one for addresses, one inbox or created inboxes. */
function ApiKeyForm({ open, onOpenChange, onPending, onCreated, initial, editing }: FormProps & { initial?: { purpose?: Purpose; domain?: string }; editing?: ApiKey }) {
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), undefined, false, invalidate.apiKeys)
  const update = useApiMutation((api, change: ApiKeyUpdate) => api.keys.update(editing!.id, change), 'Key updated', false, invalidate.apiKeys)
  const write = editing ? update : create
  const was = editing?.access
  const [name, setName] = useState(editing?.name ?? '')
  const [purpose, setPurpose] = useState<FormPurpose>(editing ? purposeOf(editing) : initial?.purpose ?? 'send')
  const startDomains = editing?.domains ?? (initial?.domain ? [initial.domain.toLowerCase()] : [])
  const [allDomains, setAllDomains] = useState(editing ? !editing.domains.length : !initial?.domain)
  const [selectedDomains, setSelectedDomains] = useState<string[]>(startDomains)
  const [allAddresses, setAllAddresses] = useState(was?.type === 'addresses' && was.addressIds === null)
  const [addressIds, setAddressIds] = useState<string[]>(was?.type === 'addresses' ? was.addressIds ?? [] : [])
  const [inboxId, setInboxId] = useState(was?.inboxId ?? '')
  // A new key limited to mail starts read-only: organizing (which can delete an inbox) is chosen, never a default.
  const [mail, setMail] = useState<MailPermission[]>(was && was.type !== 'workspace' ? was.mail : ['read'])
  const [expires, setExpires] = useState(Boolean(editing?.expiresAt))
  const [expiry, setExpiry] = useState(editing?.expiresAt ? utcInput(editing.expiresAt) : in30Days())
  const [expiryTouched, setExpiryTouched] = useState(false)
  const [more, setMore] = useState(!common.has(purpose))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const workspace = inWorkspace(purpose)
  const pending = write.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const domainOptions = useDomainOptions(open && workspace)
  const inboxes = useInboxOptions('key-options', {}, open && purpose === 'inbox')
  const [addressSearch, setAddressSearch] = useState('')
  const addressQuery = useDebounced(addressSearch)
  const addresses = useAddressOptions({ enabled: open && purpose === 'addresses', search: addressQuery })
  const savedAddressIds = was?.type === 'addresses' ? was.addressIds ?? [] : []
  const resolvedSaved = useResolvedAddresses([...savedAddressIds, ...addressIds], addresses.items, open && purpose === 'addresses')
  const domains = domainNames(domainOptions, selectedDomains)
  // Inboxes have their own choice; saved/chosen off-page addresses resolve by ID and stay visible so saving never drops them.
  const mergedAddresses = mergeAddresses(resolvedSaved.items, addresses.items)
  const receiving = mergedAddresses.filter(item => item.kind !== 'inbox' || savedAddressIds.includes(item.id) || addressIds.includes(item.id))
  const shownAddresses = [...receiving, ...savedAddressIds.filter(id => !receiving.some(item => item.id === id)).map(id => ({ id, address: id }))]
  const chosenInbox = inboxId || activeInboxes(inboxes)[0]?.id || ''
  const finalMail = mailOrder(purpose === 'create' ? [...new Set<MailPermission>(['create', ...mail])] : mail)
  const failed = (...fields: string[]) => fields.map(field => fieldError(write.error, field)).find(Boolean)
  // The name's one rule: some text, up to 100 characters once trimmed (any characters; names needn't be unique). Each
  // refusal says which part failed and records it as a code for analytics, never the name.
  const serverName = failed('name')
  const nameError = errors.name || (serverName && (name.trim().length > NAME_MAX ? `Use at most ${NAME_MAX} characters: this name has ${name.trim().length}.` : serverName))
  const nameCode = errors.name ? 'empty' : serverName ? (name.trim().length > NAME_MAX ? 'too_long' : 'invalid') : undefined
  const domainError = errors.domains || failed('domains', 'addDomains', 'removeDomains')
  const addressError = errors.addressIds || failed('access.addressIds', 'access.addAddressIds', 'access.removeAddressIds')
  const inboxError = errors.inboxId || failed('access.inboxId')
  const mailError = errors.mail || failed('access.mail')
  const expiryError = errors.expiresAt || failed('expiresAt')

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
  const setMailBit = (permission: MailPermission, on: boolean) => { clearError('mail'); setMail(current => on ? [...new Set([...current, permission])] : current.filter(item => item !== permission)) }
  const reading = mail.includes('read') ? mail.includes('send') ? 'reply' : 'read' : mail.includes('send') ? 'send' : null
  const setReading = (value: 'read' | 'reply' | 'send') => { clearError('mail'); setMail(current => [...current.filter(item => item !== 'read' && item !== 'send'), ...value !== 'send' ? ['read' as const] : [], ...value !== 'read' ? ['send' as const] : []]) }
  const expiresAt = () => expires ? new Date(`${expiry}:00Z`).toISOString() : null

  /** What an edit changes, and nothing else. */
  function changes(key: ApiKey): ApiKeyUpdate {
    const out: ApiKeyUpdate = {}
    if (name.trim() !== key.name) out.name = name.trim()
    if (expiryTouched && expiresAt() !== key.expiresAt) out.expiresAt = expiresAt()
    if (key.access.type === 'workspace') {
      if (purpose !== 'current' && isWorkspace(purpose) && !sameSet(workspacePermissions[purpose], key.permissions)) out.permissions = workspacePermissions[purpose]
      const before = key.domains, add = selectedDomains.filter(domain => !before.includes(domain)), remove = before.filter(domain => !selectedDomains.includes(domain))
      if (allDomains) { if (before.length) out.domains = [] }
      else if (!before.length) out.domains = selectedDomains
      else { if (add.length) out.addDomains = add; if (remove.length) out.removeDomains = remove }
      return out
    }
    const access: NonNullable<ApiKeyUpdate['access']> = {}, before = key.access
    if (!sameSet(finalMail, before.mail)) access.mail = finalMail
    if (purpose === 'inbox') {
      if (before.type !== 'inbox') Object.assign(access, { type: 'inbox', inboxId: chosenInbox })
      else if (chosenInbox !== before.inboxId) access.inboxId = chosenInbox
    } else {
      const target = purpose === 'create' ? [] : allAddresses ? null : addressIds
      const add = target?.filter(id => !before.addressIds?.includes(id)) ?? [], remove = before.addressIds?.filter(id => !target?.includes(id)) ?? []
      if (before.type === 'inbox') Object.assign(access, { type: 'addresses', addressIds: target })
      else if (target === null || before.addressIds === null || !target.length) { if (JSON.stringify(target) !== JSON.stringify(before.addressIds)) access.addressIds = target }
      else { if (add.length) access.addAddressIds = add; if (remove.length) access.removeAddressIds = remove }
    }
    if (Object.keys(access).length) out.access = access
    return out
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = `Enter a name for this key, such as ${placeholder}.`
    if (workspace && !allDomains && !selectedDomains.length) next.domains = 'Select at least one domain, or choose All domains.'
    else if (workspace && !allDomains && selectedDomains.length > 50) next.domains = tooManyDomains
    if (purpose === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = chooseAddress
    if (purpose === 'inbox' && !chosenInbox) next.inboxId = 'Choose an inbox.'
    if (!workspace && !finalMail.length) next.mail = 'Choose what it can do.'
    if (expires && (editing ? expiryTouched : true) && !(Date.parse(`${expiry}:00Z`) > Date.now())) next.expiresAt = 'Choose a time to come, in UTC.'
    setErrors(next)
    if (Object.keys(next).length) { if (next.name) document.getElementById('key-name')?.focus(); return }
    if (editing) {
      const change = changes(editing)
      try { if (Object.keys(change).length) await update.mutateAsync(change); onOpenChange(false) } catch { /* Shown in the form. */ }
      return
    }
    const ends = expires ? { expiresAt: expiresAt() } : {}
    const input: ApiKeyInput = isWorkspace(purpose) ? { name: name.trim(), permissions: workspacePermissions[purpose], domains: allDomains ? [] : selectedDomains, ...ends }
      : purpose === 'addresses' ? { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail: finalMail }, ...ends }
      : purpose === 'inbox' ? { name: name.trim(), access: { type: 'inbox', inboxId: chosenInbox, mail: finalMail }, ...ends }
      : { name: name.trim(), access: { type: 'addresses', addressIds: [], mail: finalMail }, ...ends }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      // The sending example only for a key that can send.
      onCreated({ secret: result.secret, title: 'API key created', sendExample: workspace && result.key.permissions.includes('send'), agent: true })
    } catch { /* Shown in the form. */ }
  }

  // An edit keeps the key's kind, so it chooses among that kind's purposes.
  const choices: { value: FormPurpose; label: string; does: string }[] = !editing ? purposes
    : editing.access.type !== 'workspace' ? purposes.filter(item => !isWorkspace(item.value))
    : [...purposeOf(editing) === 'current' ? [{ value: 'current' as const, label: `As now: ${accessLabel(editing.permissions, false).toLowerCase()}`, does: 'Keeps the permissions it has.' }] : [], ...purposes.filter(item => isWorkspace(item.value))]
  // A sending domain covers its subdomains (SENDER_DOMAIN_FORBIDDEN names "this domain or its parent domain").
  const example = selectedDomains[0] ?? domains[0]
  const placeholder = workspace ? 'Order notifications' : purpose === 'create' ? 'End-to-end tests' : purpose === 'inbox' ? 'Sign-up test' : 'Support agent'
  const where = purpose === 'inbox' ? 'this inbox' : 'these addresses'
  const reads = mail.includes('read'), replies = mail.includes('send'), organizes = mail.includes('modify')
  // What the choices above add up to, in plain lines: the detail behind "What this key can do".
  const can = [
    choices.find(item => item.value === purpose)!.does,
    ...workspace && !allDomains ? [`Sends and email logs are limited to the chosen domains and their subdomains${example ? `: ${example} also covers mail from news.${example}` : ''}.`, 'It can’t launch campaigns or reach contacts, lists, settings, webhooks or received mail.', ...purpose === 'manage' ? ['Limited to domains, it can’t manage keys or receiving.'] : []] : [],
    ...purpose === 'addresses' || purpose === 'inbox' ? [...reads ? ['Lists and reads mail, events and attachments.'] : [], ...replies ? [`Replies and starts conversations, from ${where} only.${purpose === 'inbox' ? ' Needs replies on for the inbox.' : ''}`] : [], ...organizes ? [`Marks read, archives, stars and labels${purpose === 'inbox' ? ', and can delete the inbox' : allAddresses ? ', and can delete agent inboxes' : ''}.`] : [], ...mail.includes('create') ? ['Creates agent inboxes and reaches the ones it created.'] : []] : [],
    ...expires ? [`Stops working at ${expiry.replace('T', ' ')} UTC${purpose === 'inbox' ? ', or when its inbox ends' : ''}.`] : purpose === 'inbox' ? ['Stops working when its inbox ends.'] : [],
  ]
  const formId = editing ? 'edit-key' : 'create-key'
  const choice = (item: { value: FormPurpose; label: string }) => <label key={item.value} className="keys-choice">
    <input type="radio" name="key-purpose" value={item.value} checked={purpose === item.value} onChange={() => { setPurpose(item.value); setErrors({}); write.reset() }} />
    <span>{item.label}</span>
  </label>

  return <>
    <form id={formId} className="stack" onSubmit={submit} noValidate>
      <MutationError error={write.error} />
      <Field label="Name" htmlFor="key-name" error={nameError} errorCode={nameCode} hint={`Up to ${NAME_MAX} characters.`}><Input id="key-name" value={name} maxLength={NAME_MAX} onChange={event => { setName(event.target.value); if (errors.name) setErrors(({ name: _, ...rest }) => rest) }} autoFocus={!editing} required disabled={pending} placeholder={placeholder} /></Field>
      {/* The grey example reads as filled in; an empty name offers it as the name. */}
      {nameCode === 'empty' && <div className="cluster"><Button size="sm" onClick={() => { setName(placeholder); setErrors(({ name: _, ...rest }) => rest) }} disabled={pending}>Use “{placeholder}”</Button></div>}
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can reach</legend>
        {editing ? choices.map(choice) : <>
          {choices.filter(item => common.has(item.value)).map(choice)}
          <details className="keys-more" open={more} onToggle={event => setMore(event.currentTarget.open)}>
            <summary>More<ChevronRight size={14} aria-hidden="true" /></summary>
            <div className="keys-more__choices">{choices.filter(item => !common.has(item.value)).map(choice)}</div>
          </details>
        </>}
      </fieldset>
      {workspace && <DomainChoice query={domainOptions} chosen={selectedDomains} onToggle={toggleDomain} disabled={pending} error={domainError} onLeave={() => onOpenChange(false)}
        every={{ checked: allDomains, onChange: checked => { setAllDomains(checked); setSelectedDomains([]); clearError('domains') } }} />}
      {purpose === 'addresses' && <AddressChoice id="key-address" options={shownAddresses} every={allAddresses} chosen={addressIds} disabled={pending} error={addressError}
        search={addressSearch} onSearch={setAddressSearch} searchable={addresses.hasMore || Boolean(addressSearch)}
        hasMore={addresses.hasMore} loadingMore={addresses.loadingMore} onLoadMore={addresses.loadMore}
        onEvery={checked => { setAllAddresses(checked); setAddressIds(checked ? [] : savedAddressIds); clearError('addressIds') }} onToggle={toggleAddress}
        empty={addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : addresses.isError ? <AddressesFailed query={addresses} /> : !shownAddresses.length ? (addressSearch ? <p className="muted">No matching addresses.</p> : <Link className="keys-form-note" to="/receiving" onClick={() => onOpenChange(false)}>Create an address</Link>) : undefined} />}
      {purpose === 'inbox' && <InboxChoice name="key-inbox" query={inboxes} value={chosenInbox} onChange={id => { setInboxId(id); clearError('inboxId') }} disabled={pending} error={inboxError}
        none={<Link to="/receiving/inboxes" onClick={() => onOpenChange(false)}>Create an agent inbox</Link>} />}
      {!workspace && <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can do</legend>
        {[{ value: 'read' as const, label: 'Read' }, { value: 'reply' as const, label: 'Read and reply' }, ...was?.mail.includes('send') && !was.mail.includes('read') ? [{ value: 'send' as const, label: 'Reply only' }] : []].map(item => <label key={item.value} className="keys-choice">
          <input type="radio" name="key-mail" checked={reading === item.value} onChange={() => setReading(item.value)} />
          <span>{item.label}</span>
        </label>)}
        <Checkbox checked={organizes} onCheckedChange={checked => setMailBit('modify', checked)} disabled={pending} label="Organize mail" />
        {purpose !== 'create' && <Checkbox checked={mail.includes('create')} onCheckedChange={checked => setMailBit('create', checked)} disabled={pending} label="Create agent inboxes" />}
        {mailError && <p className="ui-field__error" role="alert">{mailError}</p>}
      </fieldset>}
      <fieldset className="keys-purpose" disabled={pending} aria-describedby={expiryError ? 'key-expiry-error' : undefined}>
        <legend className="ui-field__label">Expiry</legend>
        {[{ value: false, label: purpose === 'inbox' ? 'When its inbox ends' : 'Never expires' }, { value: true, label: 'On a date (UTC)' }].map(item => <label key={item.label} className="keys-choice">
          <input type="radio" name="key-expiry" checked={expires === item.value} onChange={() => { setExpires(item.value); setExpiryTouched(true); clearError('expiresAt') }} />
          <span>{item.label}</span>
        </label>)}
        {expires && <Input id="key-expiry" type="datetime-local" aria-label="Expires at (UTC)" value={expiry} aria-invalid={Boolean(expiryError) || undefined} onChange={event => { setExpiry(event.target.value); setExpiryTouched(true); clearError('expiresAt') }} disabled={pending} />}
        {expiryError && <p id="key-expiry-error" className="ui-field__error" role="alert">{expiryError}</p>}
      </fieldset>
      <Disclosure className="keys-can" title="What this key can do"><ul>{can.map(line => <li key={line}>{line}</li>)}</ul></Disclosure>
    </form>
  </>
}

/** Edit key: the API key form, prefilled from the key. Render only while open, so its choices start from the key. */
export function EditKeyDialog({ apiKey, onClose, returnFocus }: { apiKey: ApiKey; onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const [pending, setPending] = useState(false)
  return <Dialog open onOpenChange={next => { if (!next && !pending) onClose() }} title="Edit key" returnFocus={returnFocus}
    footer={<><Button disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" loading={pending} type="submit" form="edit-key">Save</Button></>}>
    <ApiKeyForm open editing={apiKey} onOpenChange={next => { if (!next) onClose() }} onPending={setPending} onCreated={() => {}} />
  </Dialog>
}

function AppPasswordForm({ open, onOpenChange, onPending, onCreated }: FormProps) {
  const create = useApiMutation((api, input: AppPasswordInput) => api.credentials.createAppPassword(input), undefined, false, invalidate.appPasswords)
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
      const inbox = activeInboxes(inboxes).find(box => box.id === chosen)
      onCreated({ secret: result.password, title: 'App password created',
        mail: { username: inbox ? <PrivateAddress value={inbox.address} /> : 'The inbox address', imap: protocols.includes('imap'), smtp: protocols.includes('smtp') } })
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
        {protocolError && <p className="ui-field__error" role="alert">{protocolError}</p>}
      </fieldset>
    </form>
  </>
}

/** An SMTP login: an API key that can only send, from chosen domains or receiving addresses. An app signs in to SMTP
 *  as apikey with it; its mail goes out like an API send. */
function SmtpLoginForm({ open, onOpenChange, onPending, onCreated }: FormProps) {
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), undefined, false, invalidate.apiKeys)
  const domainOptions = useDomainOptions(open)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'domains' | 'addresses'>('domains')
  const [domains, setDomains] = useState<string[]>([])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [addressSearch, setAddressSearch] = useState('')
  const addressQuery = useDebounced(addressSearch)
  const addresses = useAddressOptions({ enabled: open && scope === 'addresses', search: addressQuery, kind: 'address' })
  const resolvedSelected = useResolvedAddresses(addressIds, addresses.items, open && scope === 'addresses')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending
  useEffect(() => onPending(pending), [pending, onPending])
  const receiving = mergeAddresses(resolvedSelected.items, addresses.items).filter(item => item.kind !== 'inbox')
  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  const servers = useMailServers()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!servers) return
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name, such as the app it’s for.'
    if (scope === 'domains' && !domains.length) next.domains = 'Select at least one domain.'
    else if (scope === 'domains' && domains.length > 50) next.domains = tooManyDomains
    if (scope === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = chooseAddress
    setErrors(next)
    if (Object.keys(next).length) { if (next.name) document.getElementById('smtp-login-name')?.focus(); return }
    const input: ApiKeyInput = scope === 'domains' ? { name: name.trim(), permissions: ['send'], domains }
      : { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail: ['send'] } }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      onCreated({ secret: result.secret, title: 'SMTP login created', mail: { username: <SmtpUsername />, imap: false, smtp: true } })
    } catch { /* Shown in the form. */ }
  }
  return <form id="create-smtp-login" className="stack" onSubmit={submit} noValidate>
    <MutationError error={create.error} />
    <Field label="Name" htmlFor="smtp-login-name" error={errors.name || fieldError(create.error, 'name')}><Input id="smtp-login-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder="Sign-in emails" autoComplete="off" /></Field>
    <fieldset className="keys-purpose" disabled={pending}>
      <legend className="ui-field__label">Sends from</legend>
      {([['domains', 'Chosen domains'], ['addresses', 'Chosen addresses']] as const).map(([value, label]) => <label key={value} className="keys-choice">
        <input type="radio" name="smtp-login-scope" value={value} checked={scope === value} onChange={() => { setScope(value); setErrors({}); create.reset() }} />
        <span>{label}</span>
      </label>)}
    </fieldset>
    {scope === 'domains' ? <DomainChoice query={domainOptions} chosen={domains} disabled={pending} error={errors.domains || fieldError(create.error, 'domains')} onLeave={() => onOpenChange(false)}
      onToggle={(domain, checked) => { clearError('domains'); setDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain)) }} />
      : <AddressChoice id="smtp-login-address" options={receiving} every={allAddresses} chosen={addressIds} disabled={pending} error={errors.addressIds || fieldError(create.error, 'access.addressIds')}
        search={addressSearch} onSearch={setAddressSearch} searchable={addresses.hasMore || Boolean(addressSearch)}
        hasMore={addresses.hasMore} loadingMore={addresses.loadingMore} onLoadMore={addresses.loadMore}
        onEvery={checked => { setAllAddresses(checked); setAddressIds([]); clearError('addressIds') }}
        onToggle={(id, checked) => { clearError('addressIds'); setAllAddresses(false); setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id)) }}
        empty={addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : addresses.isError ? <AddressesFailed query={addresses} /> : !receiving.length ? (addressSearch ? <p className="muted">No matching addresses.</p> : <Link className="keys-form-note" to="/receiving" onClick={() => onOpenChange(false)}>Create an address</Link>) : undefined} />}
    <Disclosure className="keys-can" title="What this login can do"><ul>
      <li>Sends from an app over SMTP, as {scope === 'domains' ? 'any address on these domains and their subdomains' : 'these addresses'}.</li>
      <li>Mail goes out like an API send: the same limits, suppressions and events.</li>
      <li>Can’t read mail, logs or settings.</li>
    </ul></Disclosure>
  </form>
}
