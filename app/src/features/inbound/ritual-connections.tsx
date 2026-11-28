import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { PrivateAddress } from '../../components/PrivateAddress'
import { Alert, Button, Checkbox, CopyButton, Dialog, Field, Input, SearchField, SecretInput, Select, type Tone } from '../../components/ui'
import { useRequestScope } from '../../data/context'
import { request } from '../../data/live'
import { ApiError, errorText, type InboundAddress, type WebhookSecrets } from '../../data/types'
import { useAddressOptions } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { idempotencyFor, SecretField } from './shared'
import '../settings/settings.css'
import './inbound.css'
import { useSingleFlight } from '../../lib/single-flight'

type EndpointType = 'slack' | 'discord' | 'webhook' | 'forward'
type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused'
export type Endpoint = { id: string; name: string; type: EndpointType; status: EndpointStatus; call: string; target: string; policy: { perMinute: number; retryOnTimeout: boolean; idempotent: boolean }; expiresAt: string | null; requestFrom?: string | null; nextStep: string; createdAt: string;
  /** Only in createEndpoint's answer: whether a forward's recipient was emailed, and the address made to ask them. */
  confirmation?: 'emailed' | 'skipped'; createdSender?: { id: string; address: string } }
const typeLabel: Record<EndpointType, string> = { slack: 'Slack', discord: 'Discord', webhook: 'Webhook', forward: 'Forward' }
const statusTone: Record<EndpointStatus, Tone> = { ready: 'success', pending: 'warning', expired: 'warning', declined: 'danger', paused: 'neutral' }
const statusLabel: Record<EndpointStatus, string> = { ready: 'Ready', pending: 'Awaiting recipient', expired: 'Link expired', declined: 'Declined', paused: 'Paused' }
const targetLabel: Record<EndpointType, string> = { slack: 'Slack incoming webhook URL', discord: 'Discord webhook URL', webhook: 'HTTPS URL', forward: 'Recipient address' }

/** Where a chat's webhook URL comes from, one line under its field (here and in the address builder). */
export const urlHint: Record<'slack' | 'discord', ReactNode> = {
  slack: <>Paste the URL from Slack’s Incoming Webhooks app. <a href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noreferrer">Get one</a></>,
  discord: <>Paste the URL from the channel’s Integrations, then Webhooks. <a href="https://support.discord.com/hc/en-us/articles/228383668" target="_blank" rel="noreferrer">Get one</a></>,
}
export const slackUrl = /^https:\/\/hooks\.slack\.com\//i, discordUrl = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i
/** What is wrong with an endpoint's URL or forward address, or '' when it will do. The recipe form checks with it too. */
export function targetProblem(type: EndpointType, value: string) {
  if (type === 'forward') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '' : 'Enter a full email address, like team@example.com.'
  if (!/^https:\/\//i.test(value)) return 'Start the URL with https://.'
  if (type === 'slack' && !slackUrl.test(value)) return 'Use Slack’s incoming webhook URL, starting https://hooks.slack.com/.'
  if (type === 'discord' && !discordUrl.test(value)) return 'Use Discord’s webhook URL, starting https://discord.com/api/webhooks/.'
  return ''
}
/** A name for a new destination from where it points: a forward's local part, a webhook's site, else its type; free of
 *  the names already taken (taken, -2, -3…). */
function suggestName(type: EndpointType, value: string, taken: Set<string>) {
  let base: string = type
  if (type === 'forward' && value.includes('@')) base = value.split('@')[0]!
  else if (type === 'webhook') { try { const host = new URL(value).hostname.split('.'); base = host.length > 1 ? host[host.length - 2]! : host[0]! } catch { /* Not a URL yet. */ } }
  const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || type
  for (let n = 1; ; n++) { const name = n === 1 ? stem : stem + '-' + n; if (!taken.has(name)) return name }
}
/** The endpoint as the edit form needs it: what it is and whether it's paused. Its URL is write-only and never here. */
export type EditableEndpoint = { name: string; type: EndpointType; status: EndpointStatus; target: string }
const chat = (type: EndpointType) => type === 'slack' || type === 'discord'
/**
 * Creates an endpoint, or with `editing` edits one in place (PATCH, only what changed). Editing never shows the stored
 * URL: the field starts empty as "Replace URL", and left empty the endpoint keeps its URL.
 */
export function EndpointDialog({ open, onOpenChange, onCreated, onSaved, editing, types = Object.keys(typeLabel) as EndpointType[], taken = [] }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (e: Endpoint & { secret?: string }) => void; onSaved?: (e: Endpoint & WebhookSecrets) => void; editing?: EditableEndpoint | null; types?: EndpointType[]; taken?: string[] }) {
  const [boxSearch, setBoxSearch] = useState('')
  const boxes = useAddressOptions({ enabled: open && !editing, search: useDebounced(boxSearch) })
  const [type, setType] = useState<EndpointType>(types[0]!)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [from, setFrom] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [attempt] = useState({ key: '', body: '' })
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (!open) return
    setType(editing?.type ?? types[0]!); setName(editing?.name ?? ''); setTarget(''); setError(null); setTried(false); setEnabled(editing ? editing.status !== 'paused' : true)
  }, [open, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Errors name the field and the fix, as soon as there's something to judge (or on Create).
  const value = target.trim()
  // A new destination names itself from where it points unless a name is typed: rules call it by this name.
  const suggested = editing ? '' : suggestName(type, value, new Set(taken))
  const finalName = name.trim() || suggested
  const nameValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(finalName)
  const retyped = !!editing && type !== editing.type
  // Editing keeps the URL when the field is left empty, unless the type changed (a Discord endpoint needs a Discord URL).
  const targetRequired = !editing || retyped
  const targetError = !value ? (tried && targetRequired && !(editing?.type === 'forward') ? (retyped ? `Enter the ${typeLabel[type]} webhook URL to switch to ${typeLabel[type]}.` : `Enter the ${targetLabel[type].replace(/^HTTPS URL$/, 'URL').toLowerCase()}.`) : '')
    : targetProblem(type, value)
  const nameError = name && !nameValid ? `Use lowercase letters, digits and hyphens, like ${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'support'}.` : !finalName && tried ? 'Name it, like support. Rules call it by this name.' : ''
  // Only what changed goes to the API; an empty URL field is left out, so the stored URL stays.
  const changes = editing ? {
    ...(finalName !== editing.name ? { name: finalName } : {}),
    ...(retyped ? { type } : {}),
    ...(value && editing.type !== 'forward' ? { url: value } : {}),
    ...(enabled !== (editing.status !== 'paused') ? { paused: !enabled } : {}),
  } : null
  const serverError = (field: string) => error instanceof ApiError ? error.fields[field] : undefined
  const generalError = error && !forwardSenderNeeded(error) && !(error instanceof ApiError && ['name', 'url', 'type', 'paused'].some(f => error.fields[f])) ? errorText(error) : ''
  // Single flight: a second Create before the first answers would post the endpoint again.
  // `sender`: the address Create made for it just now (ForwardSenderOffer), sent as from.
  const scope = useRequestScope()
  const send = useSingleFlight(editing ? 'endpoints.update' : 'endpoints.create', async (sender?: string) => {
    setBusy(true); setError(null)
    try {
      if (editing) onSaved?.(await request<Endpoint & WebhookSecrets>(`/v1/endpoints/${encodeURIComponent(editing.name)}`, { method: 'PATCH', body: changes, scope }))
      else {
        // The API decides whether the recipient is asked (auto: not on a domain this workspace verified) and, with no address
        // that can ask, makes one (createSender): the answer says which, and who asked.
        const sendFrom = sender ?? from
        const body = { type, name: finalName, ...(type === 'forward' ? { address: value, preverify: 'auto', ...(sendFrom ? { from: sendFrom } : { createSender: true }) } : { url: value }) }
        onCreated?.(await request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body), scope }))
      }
    }
    catch (e) { setError(e) }
    finally { setBusy(false) }
  }, editing?.name)
  function submit(event: FormEvent) {
    event.preventDefault(); setTried(true)
    if (!nameValid || targetError || (targetRequired && !value && editing?.type !== 'forward')) return
    if (editing && !Object.keys(changes!).length) { onOpenChange(false); return }
    void send()
  }
  // Editing: Slack and Discord switch between each other; webhooks and forwards keep their type.
  const typeOptions = editing ? (chat(editing.type) ? types.filter(chat) : [editing.type]) : types
  const formId = editing ? 'endpoint-edit' : 'endpoint-create'
  // A stored URL is never shown: the field is Replace URL, empty keeps it. A webhook's new URL drops the custom headers
  // set on it over the API, so that is said as soon as one is typed, before Save.
  const dropsHeaders = !!editing && editing.type === 'webhook' && type === 'webhook' && !!value
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }} title={editing ? `Edit ${editing.name}` : 'New destination'}
    footer={<><Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form={formId} loading={busy}>{editing ? 'Save' : 'Create'}</Button></>}>
    <form id={formId} className="stack" onSubmit={submit} noValidate>
      {typeOptions.length > 1 || editing ? <Field label="Type">
        <Select value={type} disabled={typeOptions.length === 1} onValueChange={v => { setType(v as EndpointType); setTarget(''); setTried(false); setError(null) }} options={typeOptions.map(value => ({ value, label: typeLabel[value] }))} />
      </Field> : null}
      {editing?.type === 'forward'
        ? <Field label="Recipient address"><p className="endpoint-recipient"><PrivateAddress value={editing.target} /></p></Field>
        : <Field label={editing ? 'Replace URL' : targetLabel[type]} error={targetError || serverError('url') || undefined} hint={!editing && (type === 'slack' || type === 'discord') ? urlHint[type] : undefined}>
          <SecretInput type={type === 'forward' ? 'email' : type === 'webhook' ? 'url' : 'password'} autoComplete="off" value={target} onChange={e => { setTarget(e.target.value); if (serverError('url')) setError(null) }}
            placeholder={type === 'forward' ? 'team@example.com' : editing && !retyped ? 'Keep the current URL' : 'https://'} aria-invalid={!!(targetError || serverError('url')) || undefined} />
        </Field>}
      {/* Where it points first; its name (what rules call it) follows, filled in from that until typed over. */}
      <Field label="Name" error={nameError || serverError('name') || undefined}>
        <Input value={name} onChange={e => { setName(e.target.value.toLowerCase().replace(/[\s_]+/g, '-')); if (serverError('name')) setError(null) }} placeholder={editing ? editing.name : suggested || (type === 'forward' ? 'team' : type === 'webhook' ? 'crm' : type === 'discord' ? 'alerts' : 'support')} autoComplete="off" aria-invalid={!!(nameError || serverError('name')) || undefined} />
      </Field>
      {dropsHeaders && <Alert tone="warning">A new URL drops the custom headers set on this webhook over the API.</Alert>}
      {/* Who asks the recipient: one of the workspace's addresses (with none, the API makes one). On a domain this
          workspace verified nobody is asked, and the answer says so. */}
      {!editing && type === 'forward' && (boxes.items.length > 0 || Boolean(boxSearch)) && <Field label="Confirmation from">
        <div className="stack">
          {(boxes.hasMore || Boolean(boxSearch)) && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={boxSearch} onChange={event => setBoxSearch(event.target.value)} />}
          <Select mask value={from} onValueChange={setFrom} options={[{ value: '', label: 'Oldest address' }, ...boxes.items.map(a => ({ value: a.id, label: a.address }))]} />
          {boxes.hasMore && <Button variant="ghost" size="sm" loading={boxes.loadingMore} onClick={boxes.loadMore}>Load more addresses</Button>}
        </div>
      </Field>}
      {editing && <Checkbox checked={enabled} onCheckedChange={setEnabled} label="Enabled" />}
      {(generalError || serverError('type') || serverError('paused')) && <Alert tone="danger">{generalError || serverError('type') || serverError('paused')}</Alert>}
      <ForwardSenderOffer error={error} onCreated={box => { setFrom(box.id); return send(box.id) }} />
    </form>
  </Dialog>
}

/** Shown once after creating a destination (an endpoint): how rules call it, and a webhook's signing secret, which is never shown again. */
export function CreatedEndpointDialog({ created, onClose, writeRule = true }: { created: (Endpoint & { secret?: string }) | null; onClose: () => void; writeRule?: boolean }) {
  const call = created ? `${created.call}${created.type === 'slack' ? '({ text: `New mail from ${email.from.address}` })' : created.type === 'discord' ? '({ content: `New mail from ${email.from.address}` })' : created.type === 'webhook' ? '({ subject: email.subject })' : '()'}` : ''
  return <Dialog sensitive={Boolean(created?.secret)} open={!!created} onOpenChange={next => { if (!next) onClose() }} title={created?.status === 'pending' ? 'Confirmation sent' : 'Destination created'}
    footer={<><Button onClick={onClose}>Done</Button>{writeRule && <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/rules/new" onClick={onClose}>New rule</Link>}</>}>
    {created && <div className="stack">
      {created.type === 'forward' && <ForwardAsked endpoint={created} />}
      <Field label="Call it from a rule"><div className="settings-copy-cell"><code>{call}</code><CopyButton value={call} label="Copy call" /></div></Field>
      {created.secret && <SecretField label="Signing secret" value={created.secret} copyLabel="Copy secret" />}
    </div>}
  </Dialog>
}
export { statusLabel as endpointStatusLabel, statusTone as endpointStatusTone }
type SenderNeed = { suggested: string | null; reason: string | null; domain: string | null; domainId: string | null }
const text = (value: unknown) => typeof value === 'string' ? value : null
/** Why a refused forward has no address to ask its recipient from (FORWARD_SENDER_REQUIRED): an address to create, or
 *  the reason none can be offered (a domain of its own that doesn't receive yet, a built-in domain that emails members
 *  only, or no domain that receives), or null for any other error. */
export const forwardSenderNeeded = (error: unknown): SenderNeed | null => {
  if (!(error instanceof ApiError && error.code === 'FORWARD_SENDER_REQUIRED')) return null
  const d = error.details?.[0] ?? {}
  return { suggested: text(d.suggestedFrom), reason: text(d.reason), domain: text(d.domain), domainId: text(d.domainId) }
}
/**
 * A forward refused for want of an address to send its confirmation from: one click creates the suggested address
 * (forward@ at a host that receives mail now, which turns nothing on) and `onCreated` sends the forward again from it.
 * With no such host there is nothing to create here: it points to the addresses, where receiving is set up first.
 * Wherever a forward is made.
 */
export function ForwardSenderOffer({ error, onCreated }: { error: unknown; onCreated: (address: InboundAddress) => void | Promise<void> }) {
  const scope = useRequestScope()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<unknown>(null)
  const need = forwardSenderNeeded(error)
  if (!need) return null
  async function create() {
    setBusy(true); setFailed(null)
    try { await onCreated(await request<InboundAddress>('/v1/inbound/addresses', { method: 'POST', body: { address: need!.suggested }, scope })) }
    catch (e) { setFailed(e) } finally { setBusy(false) }
  }
  // What to do next is a control of its own (a tap target), never a link inside the sentence.
  const next = need.suggested ? null
    : need.reason === 'domain_not_receiving' ? { to: need.domainId ? `/domains/${need.domainId}` : '/domains', label: 'Set up receiving' }
    : need.reason === 'builtin_members_only' ? { to: '/domains', label: 'Add your domain' }
    : { to: '/receiving', label: 'Set up receiving' }
  return <Alert tone="info" title={need.reason === 'builtin_members_only' ? 'It can’t ask them yet' : 'It needs an address to send from'}>
    {need.suggested ? <>Forwarding first emails them a request to confirm, from one of your addresses, and you don’t have one yet. It can come from <span className="forward-sender-offer__from"><PrivateAddress value={need.suggested} /></span>, a new address.</>
      : need.reason === 'domain_not_receiving' && need.domain ? <>The request to confirm comes from one of your addresses at {need.domain}, which doesn’t receive mail yet.</>
      : need.reason === 'builtin_members_only' ? <>Your built-in domain emails only members of this workspace. Forward to your sign-in address, or add your own domain.</>
      : <>Forwarding first emails them a request to confirm, from one of your addresses, and no domain of yours receives mail yet.</>}
    {need.suggested && <div className="cluster forward-sender-offer"><Button size="sm" variant="primary" loading={busy} onClick={() => void create()}>Create it and continue</Button></div>}
    {next && <div className="cluster forward-sender-offer"><Link className="ui-button ui-button--secondary ui-button--sm" to={next.to}>{next.label}</Link></div>}
    {failed !== null && <p className="ui-field__error" role="alert">{errorText(failed)}</p>}
  </Alert>
}
/** A new forward waits for its recipient: said once wherever a forward is made. Nothing else waits for them: mail
 *  received from the moment they agree is forwarded. */
export function AwaitingConfirm({ address, from }: { address: string; from?: string | null }) {
  return <Alert tone="info">We emailed <PrivateAddress value={address} />{from ? <> from <PrivateAddress value={from} /></> : null} to confirm. Forwarding starts once they agree.</Alert>
}
/** What creating a forward did: asked its recipient (from which address, and whether that address is new), or nothing
 *  to ask (on a domain this workspace verified). */
function ForwardAsked({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.status !== 'pending') return null
  return <>
    <AwaitingConfirm address={endpoint.target} from={endpoint.requestFrom} />
    {endpoint.createdSender && <p className="muted"><PrivateAddress value={endpoint.createdSender.address} /> is a new address, made to ask them.</p>}
  </>
}
