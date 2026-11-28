import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, Checkbox, ConfirmDialog, CopyButton, DataTable, Dialog, EmptyState, KeyValues, ErrorState, Field, Input, SecretInput, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, StatusBadge, DropdownMenu, fieldError, MutationError, SecretDialog } from '../../components/ui'
import { useApiMutation, useApiDef, useApiQuery, useApi, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import type { RegionCatalogEntry, Webhook, WebhookDelivery, WebhookEvent, WebhookInput } from '../../data/types'
import { useRegionCatalog } from '../../data/regions'
import { date, label, number, shortDateTime, time } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { AdminOnlyPage } from './admin-only'
import { deliveryColumns, SettingsRouteSkeleton, WebhookBodySkeleton, webhookColumns } from './skeletons'
import { headerDraftErrors, HeaderNames, headerPayload, headersChanged, WebhookHeadersField, type HeaderDraft } from './webhook-headers'
import { productName } from '../../../../api/src/brand'
import { webhookEdits, type WebhookFields } from './webhook-patch'

const events: WebhookEvent[] = ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed', 'email.opened', 'email.clicked', 'contact.subscription_changed', 'account.standing.changed']
// The same defaults as POST /v1/webhooks: every delivery outcome. Opens, clicks, subscription and standing changes are opt-in.
const defaultEvents: WebhookEvent[] = ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed']
const blankEndpoint: WebhookInput = { name: '', url: '', regionIds: 'all', events: [...defaultEvents] }
const column = (columns: ReturnType<typeof webhookColumns>, key: string) => columns.find(item => item.key === key)!
// The endpoint's answer as a labelled value; a delivery still waiting has had none yet.
const responseText = (delivery: WebhookDelivery) => delivery.response ? `Response ${delivery.response}` : delivery.status === 'pending' || delivery.status === 'retry_pending' ? 'No response yet' : 'No response'
const eventLabel = (event: string) => event === 'account.standing.changed' ? 'Sending standing changed' : label(event.replace(/^email\./, '').replace('.', '_'))
// The events a webhook gets, named rather than counted: "All events", or the first and how many more.
const eventSummary = (list: WebhookEvent[]) => list.length === events.length ? 'All events' : `${eventLabel(list[0] ?? '')}${list.length > 1 ? ` +${number(list.length - 1)}` : ''}`
function scopeText(scope: Webhook['regionIds']) { return scope === 'all' ? 'All regions' : scope.join(', ') }
const FULL_URL = 'Enter a full URL, such as https://acme.com/hooks/email.'
function validate(input: WebhookInput) {
  const errors: Record<string, string> = {}
  if (!input.name.trim()) errors.name = 'Enter a name for this webhook.'
  if (!input.id || input.url.trim()) {
    try {
      const url = new URL(input.url.trim())
      if (url.protocol !== 'https:') errors.url = 'Use an https:// URL.'
      else if (url.username || url.password) errors.url = 'Remove the user name and password from the URL. Send them as a header.'
      else if (!url.hostname) errors.url = FULL_URL
    } catch { errors.url = FULL_URL }
  }
  if (input.regionIds && input.regionIds !== 'all' && (input.regionIds.length === 0 || input.regionIds.some(region => !region.trim()))) errors.regionIds = 'Choose at least one region.'
  if (input.events.length === 0) errors.events = 'Choose at least one event.'
  return errors
}

// An existing webhook's URL field starts empty with the saved URL as its placeholder: left empty, the URL stays.
function EndpointFields({ input, savedUrl, onChange, regions, errors, apiError, disabled, headers }: { input: WebhookInput; savedUrl?: string; onChange: (input: WebhookInput) => void; regions: RegionCatalogEntry[]; errors: Record<string, string>; apiError: unknown; disabled: boolean; headers: { current: Webhook['headers']; draft: HeaderDraft; onChange: (draft: HeaderDraft) => void } }) {
  // Hosted endpoints leave regionIds out: they cover every region and an update keeps the saved scope.
  const scope = input.regionIds
  return <div className="stack">
    <div className="form-grid webhook-fields">
      <Field label="Name" htmlFor="endpoint-name" error={errors.name || fieldError(apiError, 'name')}><Input id="endpoint-name" value={input.name} onChange={event => onChange({ ...input, name: event.target.value })} required disabled={disabled} placeholder="Support notifications" /></Field>
      <Field label="Endpoint URL" htmlFor="endpoint-url" error={errors.url || fieldError(apiError, 'url')}><SecretInput id="endpoint-url" type="url" value={input.url} onChange={event => onChange({ ...input, url: event.target.value })} required={!input.id} disabled={disabled} placeholder={savedUrl ?? 'https://support.acme.com/hooks/email'} /></Field>
    </div>
    {scope !== undefined && <div className="stack settings-region-scope"><Field label="Region scope" htmlFor="endpoint-scope" error={errors.regionIds || fieldError(apiError, 'regionIds')}><Select id="endpoint-scope" value={scope === 'all' ? 'all' : 'selected'} onValueChange={value => onChange({ ...input, regionIds: value === 'all' ? 'all' : regions.filter(region => region.enabled).map(region => region.region) })} disabled={disabled} options={[{ value: 'all', label: 'All regions, including new ones' }, { value: 'selected', label: 'Selected regions' }]} /></Field>
    {scope !== 'all' && <div className="settings-choices" role="group" aria-label="Selected regions">{regions.map(region => { const checked = scope.includes(region.region); return <Checkbox key={region.region} label={`${region.region}${region.enabled ? '' : ' · Disabled'}`} checked={checked} disabled={disabled || (!region.enabled && !checked)} onCheckedChange={next => onChange({ ...input, regionIds: next ? [...scope, region.region] : scope.filter(id => id !== region.region) })} /> })}</div>}</div>}
    <div className="ui-field"><div id="endpoint-events-label" className="ui-field__label">Events</div><div className="settings-choices settings-choices--events" role="group" aria-labelledby="endpoint-events-label" aria-describedby={errors.events || fieldError(apiError, 'events') ? 'endpoint-events-error' : undefined}>{events.map(event => <Checkbox key={event} label={eventLabel(event)} checked={input.events.includes(event)} disabled={disabled} onCheckedChange={checked => onChange({ ...input, events: checked ? [...input.events, event] : input.events.filter(current => current !== event) })} />)}</div>{(errors.events || fieldError(apiError, 'events')) && <div id="endpoint-events-error" className="ui-field__error" role="alert">{errors.events || fieldError(apiError, 'events')}</div>}</div>
    <WebhookHeadersField current={headers.current} draft={headers.draft} onChange={headers.onChange} errors={errors} apiError={apiError} disabled={disabled} />
  </div>
}

export const useWebhooks = (cursor?: string, enabled = true) => useApiDef(queries.webhooks(cursor), { enabled, keepPrevious: true })
// Outbound webhooks: the table, its rows open each one. Signatures and the event payloads are in the docs, linked from a
// webhook's signing secret.
export function WebhooksSection() {
  const navigate = useNavigate()
  const pagination = useCursorPagination()
  const webhooks = useWebhooks(pagination.cursor)
  const { multiTenant } = useWorkspaceAccess()
  const columns = webhookColumns(multiTenant)
  // Headers only when a webhook has some: while loading it isn't shown either, so the usual case never shifts.
  const withHeaders = webhooks.data?.some(webhook => webhook.headers.length > 0) ?? false
  return <section id="webhooks" className="section stack settings-group settings-rule">
    {multiTenant ? <div className="settings-actions"><Button onClick={() => navigate('/settings/webhooks/new')}>Add webhook</Button></div> : <SectionHeader title="Webhooks" actions={<Button onClick={() => navigate('/settings/webhooks/new')}>Add webhook</Button>} />}
    {webhooks.error ? <ErrorState error={webhooks.error} onRetry={() => void webhooks.refetch()} /> : <DataTable className="ui-table--two-line" loading={webhooks.isPending} skeletonRows={2} minRows={2} rows={webhooks.data ?? []} rowKey={webhook => webhook.id} rowHref={webhook => `/settings/webhooks/${webhook.id}`} empty={<EmptyState title="No webhooks" />} columns={[
      { ...column(columns, 'name'), render: (webhook: Webhook) => <div className="settings-webhook-name"><span title={webhook.name}>{webhook.name}</span><span className="muted" title={webhook.url}>{webhook.url}</span></div>, cardRender: (webhook: Webhook) => webhook.name },
      { ...column(columns, 'url'), render: (webhook: Webhook) => webhook.url },
      ...multiTenant ? [] : [{ ...column(columns, 'scope'), render: (webhook: Webhook) => scopeText(webhook.regionIds) }],
      { ...column(columns, 'events'), render: (webhook: Webhook) => <span className="settings-webhook-events" title={webhook.events.map(eventLabel).join(', ')}>{eventSummary(webhook.events)}</span>, cardRender: (webhook: Webhook) => eventSummary(webhook.events) },
      ...withHeaders ? [{ ...column(columns, 'headers'), render: (webhook: Webhook) => <HeaderNames headers={webhook.headers} /> }] : [],
      { ...column(columns, 'status'), render: (webhook: Webhook) => <StatusBadge status={label(webhook.status)} /> },
    ]} />}
    {webhooks.data && <Pagination page={pagination.page} pageSize={20} nextCursor={webhooks.data.nextCursor} onPageChange={next => pagination.onPageChange(next, webhooks.data.nextCursor)} />}
  </section>
}

function NewWebhook() {
  const navigate = useNavigate()
  const { multiTenant } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !multiTenant })
  const save = useApiMutation((api, input: WebhookInput) => api.webhooks.create(input), 'Webhook created', false, invalidate.webhooks)
  // Hosted endpoints are created without a region scope, so they cover every region.
  const [input, setInput] = useState<WebhookInput>(() => multiTenant ? { name: '', url: '', events: [...defaultEvents] } : blankEndpoint)
  // The signing secret comes back once with the new webhook: show it before moving on to the webhook's page.
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null)
  const [headers, setHeaders] = useState<HeaderDraft>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = { ...validate(input), ...headerDraftErrors(headers) }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    try {
      const endpoint = await save.mutateAsync({ ...input, name: input.name.trim(), url: input.url.trim(), headers: headerPayload(headers) })
      if (endpoint.secret) setCreated({ id: endpoint.id, secret: endpoint.secret })
      else navigate(`/settings/webhooks/${endpoint.id}`, { replace: true })
    } catch { /* Shown inline. */ }
  }
  return <div className="stack settings-page">
    <PageHeader title="Add webhook" backTo="/settings#webhooks" />
    {!multiTenant && regions.isPending ? <WebhookBodySkeleton isNew /> : !multiTenant && regions.error ? <ErrorState error={regions.error} onRetry={() => void regions.refetch()} /> : <form className="stack" onSubmit={submit} noValidate>
      <MutationError error={save.error} />
      <EndpointFields input={input} onChange={setInput} regions={regions.data?.data ?? []} errors={errors} apiError={save.error} disabled={save.isPending} headers={{ current: [], draft: headers, onChange: setHeaders }} />
      <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending}>Add webhook</Button></div>
    </form>}
    <SecretDialog secret={created?.secret ?? null} title="Webhook created · Signing secret" description={`Keep it on your server: anyone with it can sign requests as ${productName}.`} onClose={() => { const id = created?.id; setCreated(null); if (id) navigate(`/settings/webhooks/${id}`, { replace: true }) }}><SigningGuide /></SecretDialog>
  </div>
}

function ExistingWebhook({ id }: { id: string }) {
  // A new delivery (a test, a fresh event) settles in seconds: read the webhook again while one from the last two minutes
  // is pending. Older pending deliveries are in a backoff that lasts hours, so they don't keep a 3 s loop running.
  const webhook = useApiQuery(['webhook', id], (api, signal) => api.webhooks.get(id, signal), { interval: data => data?.deliveries.some(delivery => delivery.status === 'pending' && Date.now() - Date.parse(delivery.at) < 120_000) ? 3000 : false })
  const { multiTenant } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !multiTenant })
  if (webhook.isPending || (!multiTenant && regions.isPending)) return <SettingsRouteSkeleton kind="webhook" />
  // Only a failed first read takes the page. Once the editor is up, a failed refresh (a poll, or the reread after a
  // test or retry) keeps it and its unsaved edits, and says so in Delivery history with its own retry.
  if (!webhook.data || (!multiTenant && !regions.data)) return <ErrorState error={webhook.error || regions.error} onRetry={() => { void webhook.refetch(); if (!multiTenant) void regions.refetch() }} />
  return <WebhookEditor key={id} webhook={webhook.data} regions={regions.data?.data ?? []} refreshError={webhook.error} onRefresh={() => void webhook.refetch()} />
}

function WebhookEditor({ webhook: read, regions, refreshError, onRefresh }: { webhook: Webhook; regions: RegionCatalogEntry[]; refreshError: unknown; onRefresh: () => void }) {
  const navigate = useNavigate()
  const { multiTenant } = useWorkspaceAccess()
  const save = useApiMutation((api, value: { edits: Partial<WebhookFields>; headers?: WebhookInput['headers'] }) => api.webhooks.update(read.id, value.edits, value.headers), 'Webhook saved', false, invalidate.webhooks)
  // The webhook as last read: the saved response until a newer read replaces it.
  const webhook = save.data && (save.data.updatedAt ?? '') > (read.updatedAt ?? '') ? { ...read, ...save.data, deliveries: read.deliveries, nextCursor: read.nextCursor } : read
  // The form holds only what the person changed; every other field shows the webhook as last read, so a change saved
  // elsewhere (another tab, a teammate) shows up here and is never written back. Saving sends only the changes.
  // Hosted users can't change the region scope, so it is never part of their form.
  const saved: WebhookFields = { name: webhook.name, url: '', ...multiTenant ? {} : { regionIds: webhook.regionIds }, events: webhook.events }
  const [edits, setEdits] = useState<Partial<WebhookFields>>({})
  const input: WebhookInput = { id: webhook.id, ...saved, ...edits, events: (edits.events ?? saved.events) as WebhookEvent[] }
  const setInput = (next: WebhookInput) => setEdits(webhookEdits(next, saved))
  const deliveryColumnSet = deliveryColumns(multiTenant)
  async function retryDelivery(delivery: WebhookDelivery) { try { await retry.mutateAsync({ id: webhook.id, deliveryId: delivery.id }); setHistory(null); historyPagination.reset() } catch { /* Shown inline. */ } }
  const [headers, setHeaders] = useState<HeaderDraft>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [action, setAction] = useState<'pause' | 'resume' | 'rotate' | 'delete' | null>(null)
  const [secret, setSecret] = useState<{ value: string; rotated: boolean } | null>(null)
  const api = useApi()
  const historyPagination = useCursorPagination()
  const [history, setHistory] = useState<{items: WebhookDelivery[]; nextCursor?: string | null} | null>(null)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  // The delivery open in the inspector, read from the current rows on every render, so a poll that settles it updates
  // the dialog too; the row as opened stays shown if it leaves the page.
  const [opened, setInspected] = useState<WebhookDelivery | null>(null)
  const rows = history?.items ?? webhook.deliveries
  const inspected = opened && (rows.find(delivery => delivery.id === opened.id) ?? opened)
  const status = useApiMutation((api, value: { id: string; status: 'active' | 'paused' }) => api.webhooks.setStatus(value.id, value.status), 'Webhook status updated', false, invalidate.webhooks)
  const rotate = useApiMutation((api, id: string) => api.webhooks.rotate(id), 'Signing secret rotated', false, invalidate.webhooks)
  // Reading the secret changes nothing, so it refreshes nothing.
  const reveal = useApiMutation((api, id: string) => api.webhooks.reveal(id), undefined, false, false)
  const remove = useApiMutation((api, id: string) => api.webhooks.remove(id), 'Webhook deleted', false, invalidate.webhooks)
  const test = useApiMutation((api, id: string) => api.webhooks.test(id), 'Test delivery created', false, invalidate.webhookDelivery)
  const retry = useApiMutation((api, value: { id: string; deliveryId: string }) => api.webhooks.retry(value.id, value.deliveryId), 'Delivery retry queued', false, invalidate.webhookDelivery)
  const pending = save.isPending || status.isPending || rotate.isPending || remove.isPending || test.isPending || retry.isPending

  const currentHistoryCursor = history ? history.nextCursor : webhook.nextCursor
  async function changeHistoryPage(nextPage: number) {
    const cursor = historyPagination.cursorForPage(nextPage, currentHistoryCursor)
    if (nextPage === 1) { historyPagination.onPageChange(nextPage, currentHistoryCursor); setHistory(null); return }
    setHistoryBusy(true); setHistoryError(null)
    try { setHistory(await api.webhookDeliveries(webhook.id, cursor)); historyPagination.onPageChange(nextPage, currentHistoryCursor) }
    catch (error) { setHistoryError(error) }
    finally { setHistoryBusy(false) }
  }
  const currentHeaders = webhook.headers
  // Nothing to save until something changed.
  const dirty = Object.keys(edits).length > 0 || headersChanged(headers, currentHeaders)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = { ...validate(input), ...headerDraftErrors(headers) }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const changedHeaders = headerPayload(headers, currentHeaders)
    if (!dirty) return
    try { await save.mutateAsync({ edits, headers: changedHeaders }); setEdits({}); setHeaders(null) } catch { /* Shown inline. */ }
  }
  async function confirm() {
    if (action === 'pause' || action === 'resume') {await status.mutateAsync({ id: webhook.id, status: action === 'pause' ? 'paused' : 'active' }); setHistory(null); historyPagination.reset()}
    if (action === 'rotate') { const result = await rotate.mutateAsync(webhook.id); setSecret({ value: result.secret, rotated: true }); rotate.reset() }
    if (action === 'delete') { await remove.mutateAsync(webhook.id); navigate('/settings#webhooks') }
  }
  const actionTitle = action === 'rotate' ? `Rotate ${webhook.name} signing secret?` : action === 'delete' ? `Delete ${webhook.name}?` : `${action === 'pause' ? 'Pause' : 'Resume'} ${webhook.name}?`
  const actionDescription = action === 'rotate' ? 'The current secret stops working at once, so update your server with the new one.' : action === 'delete' ? `${productName} stops calling this URL. Its delivery history is deleted too.` : action === 'pause' ? `${productName} stops calling this URL. Events from the pause are kept and delivered when you resume.` : `Events held while it was paused are delivered.`
  return <div className="stack settings-page">
    <PageHeader title={webhook.name} backTo="/settings#webhooks" actions={<><StatusBadge status={label(webhook.status)} /><Button disabled={pending} onClick={() => setAction(webhook.status === 'active' ? 'pause' : 'resume')}>{webhook.status === 'active' ? 'Pause' : 'Resume'}</Button><Button variant="primary" form="edit-webhook" type="submit" loading={save.isPending} disabled={pending || !dirty}>Save changes</Button></>} />
    <form id="edit-webhook" className="stack" onSubmit={submit} noValidate><MutationError error={save.error} /><EndpointFields input={input} savedUrl={webhook.url} onChange={setInput} regions={regions} errors={errors} apiError={save.error} disabled={pending} headers={{ current: currentHeaders, draft: headers, onChange: setHeaders }} /></form>
    <section className="section stack settings-rule settings-secret"><SectionHeader title={<span className="settings-guide-title">Signing secret<SigningGuide /></span>} actions={<><Button loading={reveal.isPending} disabled={pending} onClick={async () => { try { setSecret({ value: (await reveal.mutateAsync(webhook.id)).secret, rotated: false }) } catch { /* Shown inline. */ } }}>Reveal</Button><Button disabled={pending} onClick={() => setAction('rotate')}>Rotate</Button><Button loading={test.isPending} disabled={pending || webhook.status === 'paused'} title={webhook.status === 'paused' ? 'Resume this webhook to test delivery' : 'Sends a sample email.delivered event, marked as a test'} onClick={async () => { try { await test.mutateAsync(webhook.id); setHistory(null); historyPagination.reset() } catch { /* Shown inline. */ } }}>Test webhook</Button></>} /><MutationError error={test.error ?? reveal.error} /></section>
    <section className="section stack settings-rule"><SectionHeader title="Delivery history" /><MutationError error={retry.error} />
      {refreshError ? <ErrorState error={refreshError} onRetry={onRefresh} /> : null}
      <DataTable className="ui-table--two-line" minRows={3} rows={rows} rowKey={delivery => delivery.id} empty={<EmptyState title="No deliveries yet" />} columns={[
        { ...column(deliveryColumnSet, 'time'), render: (delivery: WebhookDelivery) => <div>{time(delivery.at)}<div className="muted">{date(delivery.at)}</div></div>, cardRender: (delivery: WebhookDelivery) => `${date(delivery.at, { month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${time(delivery.at)}` },
        ...multiTenant ? [] : [{ ...column(deliveryColumnSet, 'region'), render: (delivery: WebhookDelivery) => delivery.regionId }],
        { ...column(deliveryColumnSet, 'event'), // The event is its name (email.delivered), never a word that reads as the outcome; Status says how it went.
        render: (delivery: WebhookDelivery) => <span className="settings-cell-stack"><code title={eventLabel(delivery.event)}>{delivery.event}</code>{delivery.test && <span className="muted">Test event</span>}</span>, cardRender: (delivery: WebhookDelivery) => <><code>{delivery.event}</code>{delivery.test && <span className="muted"> · test</span>}<span className="muted"> · {responseText(delivery)}</span></> },
        { ...column(deliveryColumnSet, 'status'), render: (delivery: WebhookDelivery) => <div className="settings-cell-stack"><StatusBadge status={label(delivery.status)} /><span className="muted">{responseText(delivery)}</span></div>, cardRender: (delivery: WebhookDelivery) => <StatusBadge status={label(delivery.status)} /> },
        { ...column(deliveryColumnSet, 'attempts'), render: (delivery: WebhookDelivery) => number(delivery.attempts), cardRender: (delivery: WebhookDelivery) => `${number(delivery.attempts)} ${delivery.attempts === 1 ? 'attempt' : 'attempts'}` },
        { ...column(deliveryColumnSet, 'actions'), render: (delivery: WebhookDelivery) => <div className="cluster settings-row-actions">{['retry_pending', 'failed'].includes(delivery.status) && <Button disabled={pending || webhook.status === 'paused'} loading={retry.isPending && retry.variables?.deliveryId === delivery.id} onClick={() => void retryDelivery(delivery)}>Retry now</Button>}<Button variant="ghost" onClick={() => setInspected(delivery)}>Inspect</Button></div>,
          cardRender: (delivery: WebhookDelivery) => <DropdownMenu label={`Actions for the ${eventLabel(delivery.event)} delivery`} title={eventLabel(delivery.event)} items={[
            ...['retry_pending', 'failed'].includes(delivery.status) ? [{ label: 'Retry now', disabled: pending || webhook.status === 'paused', onSelect: () => void retryDelivery(delivery) }] : [],
            { label: 'Inspect', onSelect: () => setInspected(delivery) },
          ]} /> },
      ]} />
      <MutationError error={historyError} />{historyBusy ? <PaginationSkeleton /> : <Pagination page={historyPagination.page} pageSize={20} nextCursor={currentHistoryCursor} onPageChange={next => void changeHistoryPage(next)} />}
    </section>
    <div><Button variant="danger" disabled={pending} onClick={() => setAction('delete')}>Delete webhook</Button></div>
    <ConfirmDialog open={action !== null} onOpenChange={open => { if (!open) setAction(null) }} title={actionTitle} description={actionDescription} confirmLabel={action === 'rotate' ? 'Rotate secret' : action === 'delete' ? 'Delete webhook' : action === 'pause' ? 'Pause webhook' : 'Resume webhook'} danger={action === 'delete' || action === 'rotate'} pending={pending} onConfirm={confirm} />
    <SecretDialog secret={secret?.value ?? null} title={`${webhook.name} · ${secret?.rotated ? 'New signing secret' : 'Signing secret'}`} description={`Keep it on your server: anyone with it can sign requests as ${productName}.`} onClose={() => { setSecret(null); rotate.reset(); reveal.reset() }}><SigningGuide /></SecretDialog>
    {/* A delivery in full: its facts as key/value rows, then the payload as sent, with copy for both the ID and the JSON. */}
    <Dialog size="lg" open={inspected !== null} onOpenChange={open => { if (!open) setInspected(null) }} title={inspected?.test ? 'Test delivery payload' : 'Delivery payload'}
      status={inspected && <StatusBadge status={label(inspected.status)} />}>
      {inspected && <>
        <KeyValues className="settings-delivery-facts" items={[['Event', <code>{inspected.event}</code>], ['Response', inspected.response ?? 'No response'], ['Attempts', number(inspected.attempts)], ['Created', `${shortDateTime(inspected.at)} UTC`], ...multiTenant ? [] : [['Region', inspected.regionId] as [string, ReactNode]], ['ID', <span className="ui-kv__id"><code>{inspected.id}</code><CopyButton value={inspected.id} label="Copy delivery ID" /></span>]]} />
        <div className="settings-payload-head"><h3 className="ui-label">Payload</h3><CopyButton value={JSON.stringify(inspected.payload ?? {}, null, 2)} label="Copy payload" /></div>
        <pre className="settings-payload">{JSON.stringify(inspected.payload ?? {}, null, 2)}</pre>
      </>}
    </Dialog>
  </div>
}

export function WebhookDetailPage() {
  const { id } = useParams()
  if (!useWorkspaceAccess().canAdminister) return <AdminOnlyPage title={!id || id === 'new' ? 'Add webhook' : 'Webhook'} backTo="/settings#webhooks" />
  return !id || id === 'new' ? <NewWebhook /> : <ExistingWebhook key={id} id={id} />
}

// How to verify a signature with the secret (the Webhook-Signature header), wherever the secret is shown: the docs' guide.
function SigningGuide() {
  return <Link className="guide-link" to="/docs/webhook-signatures">Guide</Link>
}
