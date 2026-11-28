import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, SearchField, SecretInput, PageHeader, SectionHeader, Select, SkeletonText, StatusBadge, type Tone, fieldError, MutationError, SecretDialog } from '../../components/ui'
import { useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { inboundEventTypes, type InboundAddress, type InboundWebhook, type InboundWebhookInput, type MailboxEventType, type MailboxWebhookDelivery } from '../../data/types'
import { date, time } from '../../lib/format'
import { approvalLabel } from '../settings/key-labels'
import { headerDraftErrors, headerPayload, headersChanged, WebhookHeadersField, type HeaderDraft } from '../settings/webhook-headers'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { productName } from '../../../../api/src/brand'

// paused: held by a paused webhook until it resumes.
const deliveryStatus: Record<MailboxWebhookDelivery['status'], { label: string; tone: Tone }> = { pending: { label: 'Retrying', tone: 'warning' }, delivered: { label: 'Delivered', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' }, paused: { label: 'Held', tone: 'neutral' } }
// routeOnly is form state: a webhook that subscribes to no events and only gets mail a route sends to it.
type Draft = InboundWebhookInput & { routeOnly: boolean }
// A webhook a rule's destination created has no description: its name says what it is, not its masked URL.
const webhookTitle = (webhook: InboundWebhook) => webhook.description || webhook.name || webhook.url
const draftOf = (webhook: InboundWebhook): Draft => ({ url: '', description: webhook.description, eventTypes: [...webhook.eventTypes].sort(), addressIds: webhook.addressIds, format: webhook.format ?? 'nightmail', junk: webhook.junk, routeOnly: !webhook.eventTypes.length })
const payloadOf = ({ routeOnly, ...input }: Draft): InboundWebhookInput => ({ ...input, url: input.url.trim(), description: input.description.trim(), eventTypes: routeOnly ? [] : input.eventTypes })
// The inbound.new payload describes received mail only.
const receivedOnly = (types: MailboxEventType[]) => types.filter(type => type === 'message.received' || type === 'message.junk')
function validate(input: Draft, editing = false) {
  const errors: Record<string, string> = {}
  if (!editing || input.url.trim()) {
    try { const url = new URL(input.url.trim()); if (url.protocol !== 'https:' || url.username || url.password) errors.url = 'Enter an HTTPS URL without embedded credentials.' } catch { errors.url = 'Enter a valid HTTPS URL.' }
  }
  if (!input.routeOnly && !input.eventTypes.length) errors.eventTypes = 'Choose at least one event.'
  if (input.addressIds && !input.addressIds.length) errors.addressIds = 'Choose at least one address.'
  return errors
}

// Editing never shows the saved URL: its field is Replace URL, with the saved one masked as its placeholder, and left
// empty it keeps it. What each event and payload carries is in the API reference, not under each box.
function WebhookFields({ input, urlHint, onChange, addresses, addressSearch, onAddressSearch, addressSearchable, hasMoreAddresses, loadingMoreAddresses, onLoadMoreAddresses, errors, apiError, disabled, headers }: { input: Draft; urlHint?: string; onChange: (input: Draft) => void; addresses?: InboundAddress[]; addressSearch?: string; onAddressSearch?: (value: string) => void; addressSearchable?: boolean; hasMoreAddresses?: boolean; loadingMoreAddresses?: boolean; onLoadMoreAddresses?: () => void; errors: Record<string, string>; apiError: unknown; disabled: boolean; headers: { current: InboundWebhook['headers']; draft: HeaderDraft; onChange: (draft: HeaderDraft) => void } }) {
  // Events a scope or payload can't carry aren't offered: message.stored needs every address, inbound.new's payload
  // only describes received mail. Changing either drops them from the selection too.
  const events = inboundEventTypes.filter(type => !(type === 'message.stored' && input.addressIds !== null) && !(input.format === 'inbound' && !receivedOnly([type]).length))
  return <div className="stack">
    <div className="form-grid">
      <Field label="Description" htmlFor="mailbox-webhook-description"><Input id="mailbox-webhook-description" value={input.description} onChange={event => onChange({ ...input, description: event.target.value })} disabled={disabled} placeholder="Support agent runtime" /></Field>
      <Field label={urlHint ? 'Replace URL' : 'HTTPS URL'} htmlFor="mailbox-webhook-url" error={errors.url || fieldError(apiError, 'url')}><SecretInput id="mailbox-webhook-url" type="url" value={input.url} onChange={event => onChange({ ...input, url: event.target.value })} disabled={disabled} placeholder={urlHint ?? 'https://agents.acme.com/hooks/mail'} /></Field>
    </div>
    <div className="form-grid">
      <Field label="Addresses" htmlFor="mailbox-webhook-scope" error={errors.addressIds || fieldError(apiError, 'addressIds')}>
        <Select id="mailbox-webhook-scope" value={input.routeOnly ? 'routed' : input.addressIds === null ? 'all' : 'selected'} disabled={disabled}
          onValueChange={value => onChange({ ...input, routeOnly: value === 'routed', addressIds: value === 'selected' ? [] : null, eventTypes: value === 'selected' ? input.eventTypes.filter(type => type !== 'message.stored') : input.eventTypes.length ? input.eventTypes : ['message.received'] })}
          options={[{ value: 'all', label: 'Every address, new ones too' }, { value: 'selected', label: 'Selected addresses' }, { value: 'routed', label: 'Only mail an address sends here' }]} />
      </Field>
      <Field label="Payload" htmlFor="mailbox-webhook-format">
        <Select id="mailbox-webhook-format" value={input.format ?? 'nightmail'} disabled={disabled} onValueChange={value => onChange({ ...input, format: value as Draft['format'], junk: undefined, eventTypes: value === 'inbound' ? receivedOnly(input.eventTypes).length ? receivedOnly(input.eventTypes) : ['message.received'] : input.eventTypes })} options={[{ value: 'nightmail', label: `${productName} event` }, { value: 'inbound', label: 'inbound.new email.received' }]} />
      </Field>
    </div>
    <Checkbox disabled={disabled} checked={(input.junk ?? (input.format === 'inbound' ? 'include' : 'skip')) === 'include'} onCheckedChange={checked => onChange({ ...input, junk: checked ? 'include' : 'skip' })} label="Deliver junk mail too" />
    {!input.routeOnly && input.addressIds !== null && <div className="stack">
      {addressSearchable && onAddressSearch && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={addressSearch ?? ''} onChange={event => onAddressSearch(event.target.value)} />}
      <div className="settings-choices" role="group" aria-label="Addresses">{!addresses?.length ? <p className="muted">{addressSearch ? 'No matching addresses.' : 'No addresses yet.'}</p> : addresses.map(address => <Checkbox key={address.id} label={<PrivateAddress value={address.address} />} disabled={disabled} checked={input.addressIds!.includes(address.id)} onCheckedChange={checked => onChange({ ...input, addressIds: checked ? [...input.addressIds!, address.id] : input.addressIds!.filter(id => id !== address.id) })} />)}</div>
      {hasMoreAddresses && onLoadMoreAddresses && <Button variant="ghost" size="sm" loading={loadingMoreAddresses} onClick={onLoadMoreAddresses}>Load more addresses</Button>}
    </div>}
    {!input.routeOnly && <fieldset className="mailbox-webhook-events" disabled={disabled}>
      <legend className="ui-field__label">Events</legend>
      {events.map(type => <Checkbox key={type} label={<code>{type}</code>} checked={input.eventTypes.includes(type)} onCheckedChange={checked => onChange({ ...input, eventTypes: checked ? [...input.eventTypes, type] : input.eventTypes.filter(value => value !== type) })} />)}
      {(errors.eventTypes || fieldError(apiError, 'eventTypes')) && <p className="ui-field__error" role="alert">{errors.eventTypes || fieldError(apiError, 'eventTypes')}</p>}
    </fieldset>}
    <WebhookHeadersField current={headers.current} draft={headers.draft} onChange={headers.onChange} errors={errors} apiError={apiError} disabled={disabled} />
  </div>
}

// Webhooks are admin-only; members get a calm notice instead of requests that would be refused.
function AdminOnly({ title, backTo }: { title: string; backTo: string }) {
  return <div className="stack inbound-stack"><PageHeader title={title} backTo={backTo} /><EmptyState title="Owners and admins manage webhooks" /></div>
}
export function InboundWebhookDetailPage() { return useWorkspaceAccess().canAdminister ? <WebhookDetail /> : <AdminOnly title="Webhook" backTo="/receiving" /> }

// Webhooks are endpoints: their list is Mail routing's Destinations tab.
const list = '/receiving?tab=destinations'
function WebhookDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const webhook = useApiQuery(['inbound-webhook', id], (api, signal) => api.inbound.webhook(id, signal))
  const deliveries = useApiQuery(['inbound-webhook-deliveries', id], (api, signal) => api.inbound.webhookDeliveries(id, undefined, signal))
  const [addressSearch, setAddressSearch] = useState('')
  const addressQuery = useDebounced(addressSearch)
  const addresses = useAddressOptions({ search: addressQuery })
  const save = useApiMutation((api, patch: Parameters<typeof api.inbound.updateWebhook>[1]) => api.inbound.updateWebhook(id, patch), 'Webhook saved', false, invalidate.inboundWebhooks, id)
  const rotate = useApiMutation((api, _: void) => api.inbound.rotateWebhookSecret(id), undefined, false, invalidate.inboundWebhooks, id)
  const remove = useApiMutation((api, _: void) => api.inbound.deleteWebhook(id), 'Webhook deleted', false, invalidate.inboundWebhooks, id)
  const [input, setInput] = useState<Draft | null>(null)
  const [headers, setHeaders] = useState<HeaderDraft>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null)
  useEffect(() => { if (webhook.data && !input) setInput(draftOf(webhook.data)) }, [webhook.data, input])
  const current = webhook.data
  const chosenIds = input?.addressIds ?? current?.addressIds ?? []
  const resolvedSaved = useResolvedAddresses(chosenIds, addresses.items, Boolean(current))
  const shownAddresses = mergeAddresses(resolvedSaved.items, addresses.items)
  // Only a failed first load replaces the page: a later refetch that fails keeps the form and its unsaved edits.
  if (webhook.error && !webhook.data) return <><PageHeader title="Webhook" backTo={list} /><ErrorState error={webhook.error} onRetry={() => void webhook.refetch()} /></>
  // The saved response is newer than the cached endpoint until the refetch lands.
  const currentHeaders = save.data?.headers ?? current?.headers ?? []
  const dirty = !!current && !!input && (headersChanged(headers, currentHeaders) || JSON.stringify(draftOf(current)) !== JSON.stringify({ ...input, eventTypes: [...input.eventTypes].sort() }))
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input) return
    const next = { ...validate(input, true), ...headerDraftErrors(headers) }; setErrors(next)
    if (Object.keys(next).length) return
    const { url, ...patch } = payloadOf(input)
    try { const saved = await save.mutateAsync({ ...patch, ...(url ? { url } : {}), headers: headerPayload(headers, currentHeaders) }); setInput(draftOf(saved)); setHeaders(null) } catch { /* Shown in the form. */ }
  }
  return <div className="stack inbound-stack">
    <PageHeader title={current ? webhookTitle(current) : <SkeletonText width={220} lineHeight={28} />} backTo={list} actions={current && <>
      <Button onClick={() => void save.mutateAsync({ paused: !current.paused }).catch(() => undefined)} loading={save.isPending && !dirty}>{current.paused ? 'Resume' : 'Pause'}</Button>
      <Button onClick={() => setConfirm('rotate')}>Rotate secret</Button>
      <Button variant="danger" onClick={() => setConfirm('delete')}>Delete</Button>
    </>} />
    {!current || addresses.isPending || resolvedSaved.pending || deliveries.isPending ? <SkeletonText width="60%" /> : <>
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><StatusBadge status={current.paused ? 'Paused' : 'Active'} tone={current.paused ? 'neutral' : 'success'} /></dd></div>
        <div><dt>Created</dt><dd>{date(current.createdAt)}</dd></div>
        {current.approval && <div><dt>Agent approval</dt><dd>{approvalLabel(current.approval)}</dd></div>}
      </dl>
      {current.paused && <Alert tone="info">Events keep recording and stay readable through the events API.</Alert>}
      <section className="section section--bordered stack">
        <SectionHeader title="Recent deliveries" />
        {deliveries.error ? <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} /> : <DataTable skeletonRows={3} minRows={3} rows={deliveries.data ?? []} rowKey={row => row.id} empty={<EmptyState title="No deliveries yet" />}
          columns={[
            { key: 'time', label: 'Time (UTC)', width: 200, render: row => <span className="muted mailbox-nowrap">{date(row.createdAt, { month: 'short', day: 'numeric', timeZone: 'UTC' })} · {time(row.createdAt)}</span> },
            { key: 'status', label: 'Status', width: 120, render: row => <StatusBadge status={deliveryStatus[row.status].label} tone={deliveryStatus[row.status].tone} /> },
            { key: 'code', label: 'Response', width: 100, render: row => row.lastStatusCode ?? '—' },
            { key: 'attempts', label: 'Attempts', width: 90, render: row => row.attemptCount },
            { key: 'event', label: 'Event', render: row => <code className="settings-break">{row.eventId}</code> },
          ]} />}
      </section>
      <section className="section section--bordered stack">
        <SectionHeader title="Settings" />
        {!input ? <SkeletonText width="60%" /> : <form className="stack" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <WebhookFields input={input} urlHint={save.data?.url ?? current.url} onChange={setInput} addresses={shownAddresses} addressSearch={addressSearch} onAddressSearch={setAddressSearch} addressSearchable={addresses.hasMore || Boolean(addressSearch)} hasMoreAddresses={addresses.hasMore} loadingMoreAddresses={addresses.loadingMore} onLoadMoreAddresses={addresses.loadMore} errors={errors} apiError={save.error} disabled={save.isPending} headers={{ current: currentHeaders, draft: headers, onChange: setHeaders }} />
          <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending && dirty} disabled={!dirty}>Save changes</Button>{dirty && <Button onClick={() => { setInput(null); setHeaders(null); setErrors({}) }}>Discard</Button>}</div>
        </form>}
      </section>
    </>}
    <ConfirmDialog open={confirm === 'rotate'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Rotate signing secret?" description="The old secret stops working at once." confirmLabel="Rotate secret" pending={rotate.isPending} onConfirm={async () => { setSecret((await rotate.mutateAsync()).secret) }} />
    <ConfirmDialog open={confirm === 'delete'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Delete this webhook?" description="Pending deliveries are dropped and addresses stop delivering to it. Events stay readable through the events API." confirmLabel="Delete webhook" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate(list) }} />
    <SecretDialog secret={secret} title="New signing secret" onClose={() => setSecret(null)} />
  </div>
}
