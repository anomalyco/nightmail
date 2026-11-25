// New address, and where its mail goes, in one place; Edit opens it for an address whose flow it can draw (builderFits:
// one destination, or one two-way rule, and not paused). Anything more is the address's steps, on its page. New: the
// address, then its flow, then the result with Test. Editing: the flow, then the result. The flow is drawn as the flow
// panel draws it: the email at the top, an optional rule that forks it two ways, and the destination slots below.
// Saving makes any new destination first (createEndpoint, or createInboundAddress for a new inbox; kept for a retry),
// then writes the flow in one version. A new address is createInboundAddress with its flow: when any of it fails,
// nothing is created. An address that exists is setInboundAddressFlow with only what changed and the version the
// builder read, so a change made meanwhile is shown, never overwritten. The API keeps a paused route paused and gives
// this address its own copy of a rule another address shares.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, SearchField, Select, StatusDot, type SelectOption } from '../../components/ui'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiDef, useApiQuery, useRequestScope, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { isSubdomainName, rootMxWarning } from '../settings/domain-records'
import { hostStatus, moveReason, useReceivingHosts } from '../settings/receiving-hosts'
import { isAbortError, request } from '../../data/live'
import { invalidate, invalidateResources } from '../../data/invalidation'
import { ApiError, errorText, type InboundAddress, type MailboxDomain } from '../../data/types'
import { idempotencyFor, addressOption } from './shared'
import { Flow, FlowFork, FlowItem, FlowStage, isSplit, splitOf } from './flow'
import { FlowPanel } from './panel'
import { receivingDomains, useOverview, type Overview, type OverviewRule, type RouteEntry, type Target } from './overview'
import { Match, TargetIcon } from './parts'
import { AwaitingConfirm, discordUrl, slackUrl, targetProblem, urlHint } from './ritual-connections'
import { catchAllNote, outcomes } from './concepts'
import { RuleLine } from './recipes'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
const FULL = 'Enter a full email address.'
const onDomains = (names: string[], typed?: string) => `${typed ? `${typed} isn’t one of your domains. ` : ''}Use an address on ${names.length === 1 ? names[0] : `one of your domains: ${names.join(', ')}`}.`
// A name alone (support): the address it most likely means, at the workspace's first host, for the message and its button.
const LOCAL = /^[^\s@<>,;*]+$/
/**
 * An address on one of the workspace's domains where nothing receives yet: creating it turns receiving on there
 * (createInboundAddress), so the address step offers that, with the MX record to add and, at a domain's own name, what
 * that record takes over.
 */
function TurnOnReceiving({ host, domainId }: { host: string; domainId: string }) {
  const domain = useApiDef(queries.domain(domainId))
  const value = domain.data?.records.find(record => record.purpose === 'receiving' && record.type === 'MX')?.value
  return <Alert tone="info" title={`Turn on receiving for ${host}`}>
    Creating this address turns receiving on at {host}. Then add this MX record at your DNS provider: <code>{host}</code> MX <code>{value ?? '…'}</code>.
    {host === domain.data?.name && <> {rootMxWarning(host)}</>}
  </Alert>
}
type CreatedReceiving = { domainId: string; host: string; turnedOn: boolean; status?: string; verified?: boolean; dns: { type: 'MX'; name: string; value: string; priority: number }[] }
/**
 * After an address is created on a host that doesn't route mail here yet: the MX record that makes it receive, with the
 * host's status read again every 15 seconds until it receives, and, while its domain is still being verified, a line
 * saying mail waits for that too (with a link to its records).
 */
function ReceivingSetupNote({ setup }: { setup: CreatedReceiving }) {
  const record = setup.dns[0]
  const hosts = useReceivingHosts(setup.domainId, true, 15_000)
  const domain = useApiQuery(['nightmail', 'domain', setup.domainId], (api, signal) => api.domains.get(setup.domainId, signal), { interval: current => current && (current.status === 'verified' || current.sending === 'verified') ? false : 15_000, enabled: setup.verified === false })
  const host = hosts.data?.find(item => item.name === setup.host)
  const verified = setup.verified !== false || domain.data?.status === 'verified' || domain.data?.sending === 'verified'
  const receiving = host?.status === 'active' && verified
  const status = host ? hostStatus[host.status] : null
  return <Alert tone={receiving ? 'success' : 'info'} title={receiving ? `${setup.host} receives mail` : setup.turnedOn ? `Receiving is on for ${setup.host}` : `${setup.host} doesn’t receive mail yet`}>
    {record && !receiving && <>Publish this MX record at your DNS provider: <code>{record.name}</code> MX {record.priority} <code>{record.value}</code>. Mail arrives once it’s live.</>}
    {!verified && <> Its domain is still being verified, so mail waits for that too: <Link to={`/domains/${setup.domainId}`}>see its records</Link>.</>}
    <span className="builder-receiving-status"><StatusDot tone={receiving ? 'success' : status?.tone ?? 'warning'}>{receiving ? 'Receiving' : !verified && host?.status === 'active' ? 'Waiting for verification' : status?.label ?? 'Waiting for MX'}</StatusDot></span>
  </Alert>
}
const lifetimes = [{ value: '', label: 'Always' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]

/** What the rule checks, in plain words. ai asks the AI (a decision) whether the email looks like what is described. */
export type Condition = 'from' | 'subject' | 'text' | 'attachment' | 'ai'
export const conditions: { value: Condition; label: string; placeholder?: string }[] = [
  { value: 'subject', label: 'The subject mentions', placeholder: 'refund, return' },
  { value: 'text', label: 'The email mentions', placeholder: 'invoice' },
  { value: 'from', label: 'The sender is', placeholder: 'ceo@example.com, @partner.example' },
  { value: 'attachment', label: 'It has an attachment' },
  { value: 'ai', label: 'It looks like', placeholder: 'a refund request' },
]
type NewType = 'inbox' | 'slack' | 'discord' | 'webhook' | 'forward'
/** A destination slot's choice: own (its inbox), inbox:<ID>, endpoint:<name>, hook:<ID> (an event webhook, routes only), store, drop or new:<type>. */
type Slot = string
type Side = 'then' | 'otherwise'
type Plan = { split: boolean; condition: Condition; value: string; then: Slot; otherwise: Slot; targets: Record<string, string> }
/** The flow as saved when the builder opened it: the rule it draws, the route, and what else the route delivers to. */
type Base = { rule: OverviewRule | null; plan: Plan; also: Target[] }
type Resolved = { param: string; route: string[] | 'drop' | null; chat: boolean }
type NewEndpoint = { type: 'slack' | 'discord' | 'webhook'; name: string; url: string }
type Change = { endpoints?: NewEndpoint[]; rule?: string; split?: { recipe: string; params: Record<string, string> } | null; deliver?: string[] | 'drop' | null }
const newLabel: Record<NewType, string> = { inbox: 'New inbox', slack: 'New Slack channel', discord: 'New Discord channel', webhook: 'New webhook', forward: 'Forward to someone new' }
const newField: Record<NewType, { label: string; placeholder: string }> = {
  inbox: { label: 'Its address', placeholder: 'refunds@' },
  slack: { label: 'Slack webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
  discord: { label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
  webhook: { label: 'Your URL', placeholder: 'https://' },
  forward: { label: 'Their address', placeholder: 'team@example.com' },
}
const blank: Plan = { split: false, condition: 'subject', value: '', then: 'own', otherwise: 'own', targets: {} }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56)
const freeName = (base: string, taken: Set<string>) => { const stem = slug(base) || 'desk'; for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem}-${n}`; if (!taken.has(name)) return name } }
const words = (v: unknown) => Array.isArray(v) ? v.join(', ') : String(v ?? '')
const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean).join(',')

/** Whether the builder can draw (and so change) an address's flow: an address with at most one two-way rule, a route
 *  that isn't paused, and no more than one place its route sends to unless a rule splits it. */
export function builderFits(entry: RouteEntry, overview: Overview): boolean {
  if (entry.kind !== 'address' || !entry.address) return false
  if (entry.route && !entry.route.enabled) return false
  const splits = entry.rules.map(key => overview.rules.find(r => r.key === key)).filter(isSplit)
  if (splits.length > 1) return false
  return splits.length === 1 ? entry.route?.to !== 'drop' : !(Array.isArray(entry.route?.to) && entry.route.to.length > 1)
}

/** The address's flow as the builder draws it, from the overview's row; null when a destination is one it can't name. */
function baseOf(entry: RouteEntry, overview: Overview, boxes: InboundAddress[], key?: string): Base | null {
  const own = entry.address?.id
  const pickOfParam = (param: string): Slot | null => {
    if (param === 'store' || param === 'drop') return param
    if (param.startsWith('inbox:')) { const key = param.slice(6), box = entry.address?.key === key ? entry.address : boxes.find(b => b.key === key); return !box ? null : box.id === own ? 'own' : `inbox:${box.id}` }
    return overview.endpoints.some(e => e.source === 'endpoint' && e.name === param) ? `endpoint:${param}` : null
  }
  const pickOfRoute = (id: string): Slot | null => {
    if (id === own) return 'own'
    if (boxes.some(b => b.id === id)) return `inbox:${id}`
    const e = overview.endpoints.find(x => x.id === id)
    return !e ? null : e.source === 'endpoint' ? `endpoint:${e.name}` : `hook:${e.id}`
  }
  // What the route delivers on its own, beside a rule: drawn under the fork as Also, and kept unless replaced.
  const also = entry.to.filter(t => !t.via && t.type !== 'store' && t.type !== 'drop')
  // One rule asked for by key (a split's Rules row, or its line on the address's page): that one, whichever it is.
  const rule = key ? overview.rules.find(r => r.key === key && isSplit(r) && entry.rules.includes(r.key)) ?? null : splitOf(entry, overview) ?? null
  if (key && !rule) return null
  if (rule?.recipe) {
    const p = rule.recipe.params, ai = rule.recipe.id === 'split-by-meaning', always = !ai && p.test === 'always'
    const then = pickOfParam(words(p.then)), otherwise = always ? 'own' : pickOfParam(words(p.otherwise))
    if (!then || !otherwise) return null
    return { rule, also, plan: { ...blank, split: !always, condition: ai ? 'ai' : always ? 'subject' : p.test as Condition, value: ai ? words(p.meaning) : words(p.value), then, otherwise } }
  }
  const to = entry.route?.to
  const then = !to ? 'own' : to === 'drop' ? 'drop' : !to.length ? 'store' : pickOfRoute(to[0]!)
  return then ? { rule: null, also: [], plan: { ...blank, then } } : null
}

/** A rule's fields as the builder writes them, and as the overview reads them back, for telling an unchanged one. */
const sameRule = (a: { recipe: string; params: Record<string, string> }, rule: OverviewRule) => {
  if (a.recipe !== rule.recipe?.id) return false
  const b = rule.recipe.params, keys = new Set([...Object.keys(a.params), ...Object.keys(b)])
  return [...keys].every(k => list(words(a.params[k])) === list(words(b[k])))
}
/** Where a route sends mail, compared as a set; no route and a route to its own inbox are the same. */
const sameDeliver = (a: string[] | 'drop' | null, b: string[] | 'drop' | null, own: string) => {
  const norm = (x: string[] | 'drop' | null) => x === null ? 'own' : x === 'drop' ? 'drop' : x.length === 1 && x[0] === own ? 'own' : [...x].sort().join(',')
  return norm(a) === norm(b)
}
/** Whether an address's route and two-way rule are what they were: a change elsewhere in the workspace doesn't count. */
const sameFlow = (a: RouteEntry | undefined, b: RouteEntry | undefined, ao: Overview, bo: Overview) => {
  if (!a || !b) return a === b
  const ra = splitOf(a, ao), rb = splitOf(b, bo)
  return JSON.stringify([a.route?.to ?? null, a.route?.enabled ?? null, ra?.key ?? null, ra?.recipe ?? null, ra?.enabled ?? null, ra?.attachedTo ?? null])
    === JSON.stringify([b.route?.to ?? null, b.route?.enabled ?? null, rb?.key ?? null, rb?.recipe ?? null, rb?.enabled ?? null, rb?.attachedTo ?? null])
}

/** One destination slot: a picker of every place mail can go, and the field a new one needs. */
function DestinationPicker({ id, value, onChange, target, onTarget, own, boxes, overview, routeOnly, error, domain }: {
  id: string; value: Slot; onChange: (next: Slot) => void; target: string; onTarget: (next: string) => void; own: string; boxes: InboundAddress[]; overview: Overview; routeOnly: boolean; error?: string; domain?: string
}) {
  // A rule names its destinations; a webhook made for events (no name) can only be a route's, with nothing else to choose.
  const named = overview.endpoints.filter(e => e.source === 'endpoint')
  const options: SelectOption[] = [
    { value: 'own', label: <>Its inbox</>, text: 'Its inbox' },
    ...boxes.filter(b => b.address !== own && b.kind !== 'inbox').map(b => ({ ...addressOption(`inbox:${b.id}`, b.address, b.displayName ?? undefined), label: <>{b.displayName ? `${b.displayName} inbox` : <><PrivateAddress value={b.address} /> inbox</>}</> })),
    ...named.map(e => ({ value: `endpoint:${e.name}`, text: e.name, disabled: e.type === 'forward' && e.status !== 'ready', label: <span className="builder-option"><TargetIcon type={e.type} />{e.name}<span className="muted"> · {typeWord[e.type]}</span></span> })),
    ...(routeOnly ? overview.endpoints.filter(e => e.source === 'inbound_webhook').map(e => ({ value: `hook:${e.id}`, text: e.name, label: <span className="builder-option"><TargetIcon type="webhook" />{e.name}<span className="muted"> · Webhook</span></span> })) : []),
    { value: 'store', label: outcomes.store },
    { value: 'drop', label: outcomes.drop },
    ...(['inbox', 'slack', 'discord', 'webhook', 'forward'] as NewType[]).map(type => ({ value: `new:${type}`, label: newLabel[type] })),
  ]
  const fresh = value.startsWith('new:') ? value.slice(4) as NewType : null
  return <div className="stack builder-slot">
    <Select id={id} aria-label="Destination" value={value} onValueChange={onChange} options={options} />
    {fresh && <Field label={newField[fresh].label} htmlFor={id + '-target'} error={error} hint={fresh === 'slack' || fresh === 'discord' ? urlHint[fresh] : undefined}>
      <Input id={id + '-target'} type={fresh === 'forward' || fresh === 'inbox' ? 'email' : 'url'} value={target} placeholder={fresh === 'inbox' ? `refunds@${domain ?? 'example.com'}` : newField[fresh].placeholder} autoComplete="off" onChange={e => onTarget(e.target.value)} aria-invalid={!!error || undefined} />
    </Field>}
    {!fresh && error && <p className="ui-field__error" role="alert">{error}</p>}
  </div>
}
const typeWord = { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' } as const
const targetWord = (t: Target, own: string | undefined, start = false) => t.type === 'inbox' ? (t.id === own ? (start ? 'Its inbox' : 'its inbox') : <><PrivateAddress value={t.name} /> inbox</>) : t.name

type Step = 'address' | 'flow' | 'done'
/**
 * The builder. New: the address, then where its mail goes, then the result with Test. Editing (address given): where
 * its mail goes, then the result; split preselects a two-way rule of that kind when the address has none (New rule's
 * Split by words or meaning). Wildcards and catch-alls keep "Where should this mail go?" (routing.tsx).
 */
export function AddressBuilder({ open, onOpenChange, domains, initial = '', address, split, rule: ruleKey, onSaved, onPattern }: { open: boolean; onOpenChange: (open: boolean) => void; domains: Pick<MailboxDomain, 'id' | 'name' | 'status'>[] | Overview['domains']; initial?: string; address?: InboundAddress; split?: Condition; rule?: string; onSaved?: (address: InboundAddress) => void; onPattern?: (match: string) => void }) {
  const client = useQueryClient()
  const receiving = receivingDomains(domains)
  const { multiTenant } = useWorkspaceAccess()
  // Hosted, an address on one of the workspace's domains (or a subdomain of one) where nothing receives yet turns
  // receiving on there when it is created (createInboundAddress), so the address step takes it and says so.
  const roots = [...new Set(domains.flatMap(d => 'domain' in d && typeof d.domain === 'string' ? [d.domain] : []))]
  // The domain an address at a host belongs to (the longest of the workspace's domains it is on), for its MX record.
  const domainOf = (host: string) => domains.flatMap(d => 'domain' in d && typeof d.domain === 'string' && (host === d.domain || host.endsWith(`.${d.domain}`)) ? [{ id: d.id, name: d.domain }] : []).sort((a, b) => b.name.length - a.name.length)[0]
  // Every host addresses can be made at: a domain's first host and any it receives at beside it (an added host).
  const listed = [...new Set([...receiving.map(d => d.name), ...domains.flatMap(d => 'hosts' in d && Array.isArray(d.hosts) ? d.hosts : [])])]
  // Most likely first: a domain of the workspace's own (the domain itself, then its other hosts) before the built-in domain.
  const builtin = useSession()?.identity?.connection?.builtinDomain?.name
  const rank = (host: string) => (host === builtin ? 2 : 0) + (roots.includes(host) ? 0 : 1)
  const hosts = [...listed].sort((a, b) => rank(a) - rank(b))
  const turnsOn = (host: string) => multiTenant && !hosts.includes(host) && roots.some(root => host === root || host.endsWith(`.${root}`))
  // What creating it said about receiving: the MX record to publish, until its host routes mail here.
  const [receivingSetup, setReceivingSetup] = useState<CreatedReceiving | null>(null)
  const navigate = useNavigate()
  // Editing an address that exists: one given, or the one this builder just made (Edit on its result).
  const [editing, setEditing] = useState(!!address)
  const [step, setStep] = useState<Step>(address ? 'flow' : 'address')
  const [saved, setSaved] = useState<InboundAddress | null>(address ?? null)
  const [form, setForm] = useState({ address: initial, displayName: '', lifetime: '', publicAddress: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [pulse, setPulse] = useState(0)
  const [problem, setProblem] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  // Another provider receives mail at the new address's host today: creating it waits for consent to move that mail.
  const [moveHost, setMoveHost] = useState<{ host: string; domainId: string; message: string } | null>(null)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  // Each write's idempotency (a retry of the same body reuses its key), and the destinations a save made, reused by a retry.
  const attempts = useRef(new Map<string, { key: string; body: string }>())
  const made = useRef(new Map<string, { id: string; name: string; key?: string | null }>())
  const attempt = (name: string) => { let a = attempts.current.get(name); if (!a) attempts.current.set(name, a = { key: '', body: '' }); return a }
  const api = useApi()
  const [boxSearch, setBoxSearch] = useState('')
  const [checkingAddress, setCheckingAddress] = useState(false)
  const boxes = useAddressOptions({ enabled: open, search: useDebounced(boxSearch) })
  const current = saved?.address ?? form.address.trim().toLowerCase()
  const overview = useOverview({ q: current, kind: 'address', limit: 5 }, false, open && step !== 'address')
  const entry = saved ? overview.data?.routes.data.find(r => r.address?.id === saved.id) : undefined
  const routeRefIds = [
    saved?.id,
    ...(Array.isArray(entry?.route?.to) ? entry.route.to : []),
    ...(entry?.to ?? []).map(t => t.id),
  ].filter((id): id is string => Boolean(id && id.startsWith('mbx_')))
  const resolvedBoxes = useResolvedAddresses(routeRefIds, boxes.items, open && !boxes.isPending)
  const allBoxes = mergeAddresses(resolvedBoxes.items, boxes.items)
  // The flow as it was when the builder opened it: what a save compares with, and the version it sends.
  const [opened, setOpened] = useState<{ entry: RouteEntry; overview: Overview } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  // Opening starts afresh. Before the effects below, so the flow they capture from cached data isn't cleared after.
  useEffect(() => { if (open) { setEditing(!!address); setStep(address ? 'flow' : 'address'); setSaved(address ?? null); setForm({ address: initial, displayName: '', lifetime: '', publicAddress: '' }); setErrors({}); setCodes({}); setReceivingSetup(null); setMoveHost(null); setProblem(null); setPlan(null); setWaiting(null); setConflict(false); setOpened(null); setReplace(false); setBoxSearch(''); made.current.clear() } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && editing && !opened && entry && overview.data && !boxes.isPending && !resolvedBoxes.pending) setOpened({ entry, overview: overview.data }) }, [open, editing, opened, entry, overview.data, boxes.isPending, resolvedBoxes.pending])
  // A rule given by key changes that rule only (its fork and its sides), on an address with any number of rules:
  // the address's route and its other rules stay.
  const ruleMode = editing && !!ruleKey
  const base = opened && !boxes.isPending && !resolvedBoxes.pending ? baseOf(opened.entry, opened.overview, allBoxes, ruleMode ? ruleKey : undefined) : null
  const fits = !editing || !opened || ((ruleMode || builderFits(opened.entry, opened.overview)) && !!base)
  // New rule's Split on an address that already splits its mail: replacing that rule is asked first, never assumed.
  const [replace, setReplace] = useState(false)
  const asking = !!split && !!base?.rule && !replace && !ruleMode
  const draft = plan ?? base?.plan ?? blank
  // Opened from New rule's Split by words or meaning: the address's flow split on that kind of check, where its mail went
  // before on both sides until one is chosen. One that already splits its mail opens on that rule, to change it.
  useEffect(() => { if (open && split && base && !base.rule && !plan) setPlan({ ...base.plan, split: true, condition: split, otherwise: base.plan.then }) }, [open, split, base, plan])
  // Rules the builder doesn't draw (ready-made ones, scripts) keep running beside it.
  const others = (opened?.entry.rules ?? entry?.rules ?? []).filter(key => key !== base?.rule?.key).length
  const set = (patch: Partial<Plan>) => { setPlan({ ...draft, ...patch }); setProblem(null); setErrors({}) }
  const refresh = () => invalidateResources(client, invalidate.rules)
  const dirty = step !== 'done' && (plan !== null || form.address !== initial || !!form.displayName || !!form.lifetime || !!form.publicAddress)
  // Leaving with something typed asks first: closing, Cancel, or a link out of the builder.
  const close = (then?: () => void) => {
    if (busy) return
    const go = () => { onOpenChange(false); then?.() }
    if (dirty) setLeaving(() => go); else go()
  }
  const leaveTo = (to: string) => (event: { preventDefault: () => void }) => { event.preventDefault(); close(() => navigate(to)) }

  // The * the address step turned away, for its button to the catch-all's or wildcard's route editor.
  const typed = form.address.trim().toLowerCase()
  const pattern = errors.address && EMAIL.test(typed) && typed.split('@')[0]!.includes('*') && hosts.includes(typed.split('@')[1]!) ? typed : null
  const existing = errors.address ? allBoxes.find(b => b.address === typed || b.aliases.includes(typed)) : undefined
  // The name typed without its domain: offered back with the first host, one press away.
  // A rejected address that one of the workspace's hosts would fix (a name alone, or another domain): one button per host.
  const fixLocal = codes.address === 'missing_domain' ? typed : codes.address === 'not_your_domain' ? typed.split('@')[0]! : ''
  const fixes = fixLocal ? hosts.slice(0, 4).map(host => `${fixLocal}@${host}`) : []
  async function next(event: FormEvent) {
    event.preventDefault()
    if (boxes.isPending || checkingAddress) return
    const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase(), found: Record<string, string> = {}
    // Said exactly: an empty field, a name without its domain (the common slip), or something else that isn't an address.
    const example = `support@${hosts[0] ?? 'example.com'}`
    // Each rejection has a code for analytics (never the value): empty, missing_domain, invalid, not_your_domain, exists.
    const code: Record<string, string> = {}
    if (!value) { found.address = `Enter an address, such as ${example}.`; code.address = 'empty' }
    else if (LOCAL.test(value)) { found.address = hosts.length > 1 ? `Add the domain, such as ${value}@${hosts[0]}.` : hosts[0] ? `Add the domain: ${value}@${hosts[0]}.` : `Add the domain, such as ${value}@example.com.`; code.address = 'missing_domain' }
    else if (!EMAIL.test(value)) { found.address = `${value} isn’t a full email address: use a name, @ and a domain, such as ${example}.`; code.address = 'invalid' }
    // A * makes a catch-all or wildcard (a route), never an address with a * in its name.
    else if (value.split('@')[0]!.includes('*')) { found.address = value.startsWith('*@') ? catchAllNote : 'An address with * is a wildcard.'; code.address = 'invalid' }
    else if ((hosts.length || roots.length) && !hosts.includes(value.split('@')[1]!) && !turnsOn(value.split('@')[1]!)) { found.address = onDomains([...new Set([...hosts, ...roots])], value.split('@')[1]); code.address = 'not_your_domain' }
    else if (allBoxes.some(b => b.address === value || b.aliases.includes(value))) { found.address = `${value} already exists.`; code.address = 'exists' }
    else if (boxes.hasMore) {
      setCheckingAddress(true)
      try {
        const matches = await api.inbound.addresses({ search: value })
        if (matches.some(b => b.address === value || b.aliases.includes(value))) { found.address = `${value} already exists.`; code.address = 'exists' }
      } catch { /* Server validates uniqueness on submit if lookup fails. */ }
      finally { setCheckingAddress(false) }
    }
    if (sender && form.lifetime) found.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) found.publicAddress = FULL
    // The API takes a public sender only as the same local part on a parent domain.
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) found.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    // Pressed again on the same refusal: back to the field, and the message flashes, so the press isn't silent.
    if (found.address && found.address === errors.address) { setPulse(p => p + 1); document.getElementById('builder-address-input')?.focus() }
    setErrors(found); setCodes(code)
    if (!Object.keys(found).length) setStep('flow')
  }

  const scope = useRequestScope()
  const own = saved?.address ?? form.address.trim().toLowerCase()
  const ownKeys = () => new Set(allBoxes.map(b => b.key).filter((k): k is string => !!k))
  /** A key for an inbox a rule names, which a new one gets from its address (another inbox: PATCH, a write to its name only). */
  async function keyed(box: InboundAddress): Promise<string> {
    if (box.key) return box.key
    const updated = await request<InboundAddress>(`/v1/inbound/addresses/${encodeURIComponent(box.id)}`, { method: 'PATCH', body: { key: freeName(box.address.split('@')[0]!, ownKeys()) }, scope })
    return updated.key!
  }
  const targetError = (pick: Slot, value: string) => {
    if (!pick.startsWith('new:')) return ''
    const type = pick.slice(4) as NewType, v = value.trim().toLowerCase()
    if (!v) return type === 'forward' || type === 'inbox' ? 'Enter its address.' : 'Paste the URL.'
    if (type === 'inbox') return !EMAIL.test(v) || v.split('@')[0]!.includes('*') ? FULL : !hosts.includes(v.split('@')[1]!) ? onDomains(hosts, v.split('@')[1]) : v === own || allBoxes.some(b => b.address === v) ? 'That address exists: pick it above.' : ''
    return type === 'slack' && !slackUrl.test(v) ? targetProblem('slack', v) : type === 'discord' && !discordUrl.test(v) ? targetProblem('discord', v) : targetProblem(type, v)
  }

  /** Makes the new destinations a draft names (each once: a retry reuses what an earlier try made) and says how a rule
   *  and a route name each slot. New names are chosen for both slots before either is made, so they never collide. */
  async function realize(sides: Side[], ownKey: string | null | undefined, from: string | undefined, endpoints: NewEndpoint[]): Promise<Record<Side, Resolved> | 'waiting'> {
    const o = overview.data!, taken = new Set([...o.endpoints.map(e => e.name), ...[...made.current.values()].map(m => m.name)])
    const names: Partial<Record<Side, string>> = {}
    const asRule = draft.split || ruleMode
    for (const side of sides) {
      const pick = draft[side], value = (draft.targets[side] ?? '').trim()
      if (!pick.startsWith('new:') || pick === 'new:inbox' || made.current.has(`${pick}|${value}`)) continue
      const type = pick.slice(4) as NewType
      names[side] = freeName(type === 'forward' ? value.split('@')[0]! : `${own.split('@')[0]}-${type}`, taken)
      taken.add(names[side]!)
    }
    const out = {} as Record<Side, Resolved>
    for (const side of sides) {
      const pick = draft[side], value = (draft.targets[side] ?? '').trim()
      if (pick === 'own') { out[side] = { param: `inbox:${ownKey ?? ''}`, route: null, chat: false }; continue }
      if (pick === 'store') { out[side] = { param: 'store', route: [], chat: false }; continue }
      if (pick === 'drop') { out[side] = { param: 'drop', route: 'drop', chat: false }; continue }
      if (pick.startsWith('inbox:')) { const box = allBoxes.find(b => b.id === pick.slice(6))!; out[side] = { param: asRule ? `inbox:${await keyed(box)}` : '', route: [box.id], chat: false }; continue }
      if (pick.startsWith('hook:')) { out[side] = { param: '', route: [pick.slice(5)], chat: false }; continue }
      if (pick.startsWith('endpoint:')) {
        const e = o.endpoints.find(x => x.source === 'endpoint' && x.name === pick.slice(9))!
        out[side] = { param: e.name, route: e.type === 'webhook' || e.type === 'forward' ? [e.id] : null, chat: e.type === 'slack' || e.type === 'discord' }
        continue
      }
      const type = pick.slice(4) as NewType, cache = `${pick}|${value}`
      // A new Slack, Discord or webhook endpoint is made with the flow, in its one write: nothing is left if that fails.
      if (type === 'slack' || type === 'discord' || type === 'webhook') {
        endpoints.push({ type, name: names[side]!, url: value })
        out[side] = { param: names[side]!, route: type === 'webhook' ? [`webhook:${names[side]}`] : null, chat: type !== 'webhook' }
        continue
      }
      let thing = made.current.get(cache)
      if (!thing && type === 'inbox') {
        const address = value.toLowerCase(), body = { address, key: freeName(address.split('@')[0]!, new Set([...ownKeys(), ...(ownKey ? [ownKey] : [])])) }
        const box = await request<InboundAddress>('/v1/inbound/addresses', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt(cache), body), scope })
        thing = { id: box.id, name: box.address, key: box.key }
        made.current.set(cache, thing)
      } else if (!thing) {
        // A forward is made first: its recipient confirms by email before a route or rule can use it.
        const post = (body: Record<string, unknown>) => request<{ id: string; name: string; status: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt(cache), body), scope })
        const body = { type, name: names[side]!, address: value, ...(from ? { from } : {}) }
        let created: { id: string; name: string; status: string }
        try { created = await post({ ...body, preverify: true }) } catch (e) { if (!(e instanceof ApiError && e.code === 'PREVERIFY_NOT_ALLOWED')) throw e; created = await post(body) }
        thing = { id: created.id, name: created.name }
        made.current.set(cache, thing)
        if (created.status !== 'ready') { setWaiting(value); return 'waiting' }
      } else if (type === 'forward') {
        // Made by an earlier try and waiting for its recipient: saved once they confirm.
        const now = await request<{ status: string }>(`/v1/endpoints/${encodeURIComponent(thing.name)}`, { scope })
        if (now.status !== 'ready') { setWaiting(value); return 'waiting' }
      }
      out[side] = type === 'inbox' ? { param: `inbox:${thing.key ?? ''}`, route: [thing.id], chat: false } : { param: thing.name, route: [thing.id], chat: false }
    }
    return out
  }

  /** The two-way rule a draft makes: a fork, or one destination that only a rule reaches (a Slack or Discord post). */
  function plannedRule(r: Record<Side, Resolved>): { recipe: string; params: Record<string, string> } | null {
    if (!draft.split && !r.then.chat && !ruleMode) return null
    if (!draft.split) return { recipe: 'split', params: { test: 'always', then: r.then.param } }
    if (draft.condition === 'ai') return { recipe: 'split-by-meaning', params: { meaning: draft.value.trim(), then: r.then.param, otherwise: r.otherwise.param } }
    return { recipe: 'split', params: { test: draft.condition, ...(draft.condition === 'attachment' ? {} : { value: draft.value.trim() }), then: r.then.param, otherwise: r.otherwise.param } }
  }
  // Destinations the route sends to beside the rule, which saving one destination would stop: said before Save.
  const replacing = editing && !!base?.rule && !draft.split && base.also.length > 0

  async function save(event: FormEvent) {
    event.preventDefault()
    const found: Record<string, string> = {}
    if (draft.split && draft.condition !== 'attachment' && !draft.value.trim()) found.value = draft.condition === 'ai' ? 'Describe it, like a refund request.' : draft.condition === 'from' ? 'Add an address or @domain.' : 'Add a word to look for.'
    const thenProblem = targetError(draft.then, draft.targets.then ?? ''), otherProblem = draft.split ? targetError(draft.otherwise, draft.targets.otherwise ?? '') : ''
    if (thenProblem) found.then = thenProblem
    if (otherProblem) found.otherwise = otherProblem
    setErrors(found)
    if (Object.keys(found).length) return
    setBusy(true); setProblem(null); setWaiting(null); setConflict(false)
    try {
      const sides: Side[] = draft.split ? ['then', 'otherwise'] : ['then']
      // A rule names its own inbox by key; one destination reaches it with no route at all.
      const needsOwn = draft.split && sides.some(side => draft[side] === 'own')
      if (!editing) {
        // A new address: its new destinations first, then the address and its flow in one call.
        const local = form.address.trim().toLowerCase().split('@')[0]!
        const ownKey = needsOwn ? freeName(local, ownKeys()) : null
        const endpoints: NewEndpoint[] = []
        const r = await realize(sides, ownKey, undefined, endpoints)
        if (r === 'waiting') return
        const rule = plannedRule(r)
        const flow = { ...(endpoints.length ? { endpoints } : {}), ...(rule ? { split: rule, deliver: [] } : r.then.route !== null ? { deliver: r.then.route } : {}) }
        const value = form.address.trim().toLowerCase(), sender = form.publicAddress.trim().toLowerCase()
        const body = { address: value, displayName: form.displayName.trim() || null, ...(ownKey ? { key: ownKey } : {}), ...(sender ? { publicAddress: sender } : {}), ...(form.lifetime ? { ttlSeconds: Number(form.lifetime) } : {}), ...(Object.keys(flow).length ? { flow } : {}) }
        const { receiving: setup, ...self } = await request<InboundAddress & { receiving?: CreatedReceiving }>('/v1/inbound/addresses', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt('address'), body), scope })
        setSaved(self); setEditing(true); setReceivingSetup(setup ?? null)
        await refresh()
        onSaved?.(self)
      } else {
        if (!base || !opened || !saved) return
        const ownKey = needsOwn ? await keyed(saved) : saved.key
        const endpoints: NewEndpoint[] = []
        const r = await realize(sides, ownKey, saved.id, endpoints)
        if (r === 'waiting') return
        const rule = plannedRule(r)
        const change: Change = endpoints.length ? { endpoints } : {}
        if (!rule && base.rule) { change.rule = base.rule.key; change.split = null }
        else if (rule && (!base.rule || !sameRule(rule, base.rule))) { if (base.rule) change.rule = base.rule.key; change.split = rule }
        // A rule decides where mail goes, so the route sends nowhere else; a route that already sent beside the rule (Also)
        // is kept, and one rule changed by key never touches the route.
        const deliver = ruleMode ? undefined : rule ? (base.rule ? undefined : []) : r.then.route
        if (deliver !== undefined && !sameDeliver(deliver, opened.entry.route?.to ?? null, saved.id)) change.deliver = deliver
        if (Object.keys(change).length === (endpoints.length ? 1 : 0)) delete change.endpoints
        if (Object.keys(change).length) await write(change, opened.overview.version, false)
        await refresh()
        onSaved?.(saved)
      }
      // Edit after Done reads the saved flow back, not this draft.
      setPlan(null); setOpened(null)
      setStep('done')
    } catch (error) {
      if (isAbortError(error)) return
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') setConflict(true)
      else if (error instanceof ApiError && error.code === 'RECEIVING_HOST_IN_USE' && !editing && domainOf(form.address.trim().toLowerCase().split('@')[1]!)) {
        const host = form.address.trim().toLowerCase().split('@')[1]!, why = /another provider\. (.*?) To move it here anyway/.exec(error.detail)?.[1] ?? ''
        setMoveHost({ host, domainId: domainOf(host)!.id, message: moveReason(why, hosts) })
      }
      else if (error instanceof ApiError && error.fields['params.value']) setErrors({ value: error.fields['params.value'] })
      else setProblem(error)
    } finally { setBusy(false) }
  }
  /** setInboundAddressFlow with the version the builder read. When that version is stale only because something else in
   *  the workspace changed, it is sent once more with the new one; when this address's flow changed, Conflict says so. */
  async function write(change: Change, version: number | undefined, retried: boolean): Promise<void> {
    try {
      await request(`/v1/inbound/addresses/${encodeURIComponent(saved!.id)}/flow`, { method: 'PATCH', body: change, ifMatch: version, scope })
    } catch (error) {
      if (retried || !(error instanceof ApiError && error.code === 'VERSION_CONFLICT')) throw error
      const fresh = (await overview.refetch()).data
      const now = fresh?.routes.data.find(r => r.address?.id === saved!.id)
      if (!fresh || !now || !sameFlow(opened!.entry, now, opened!.overview, fresh)) throw error
      await write(change, fresh.version, true)
    }
  }
  const startOver = async () => {
    const fresh = (await overview.refetch()).data, now = fresh?.routes.data.find(r => r.address?.id === saved?.id)
    if (fresh && now) setOpened({ entry: now, overview: fresh })
    setPlan(null); setConflict(false); setErrors({}); setProblem(null)
  }

  const title = step === 'address' ? 'New address' : step === 'flow' && asking ? 'Replace the existing split?' : <PrivateAddress value={own} />
  const ready = step !== 'flow' || (!boxes.isPending && !resolvedBoxes.pending && overview.data !== undefined && (!editing || !!opened))
  const stepsPath = saved ? `/receiving/addresses/${saved.id}?tab=flow&edit=1` : null
  const footer = step === 'address' ? <><Button onClick={() => close()}>Cancel</Button><Button variant="primary" type="submit" form="builder-address" loading={checkingAddress} disabled={boxes.isPending}>Next</Button></>
    : step === 'flow' && asking ? <><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={() => { setReplace(true); setPlan({ ...base!.plan, split: true, condition: split!, value: '' }) }}>Replace it</Button></>
    : step === 'flow' ? <>{editing ? <Button disabled={busy} onClick={() => close()}>Cancel</Button> : <Button disabled={busy} onClick={() => setStep('address')}>Back</Button>}{fits && <Button variant="primary" type="submit" form="builder-flow" loading={busy} disabled={!ready || conflict}>Save</Button>}</>
    : <>{saved && <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/addresses/${saved.id}`} onClick={() => onOpenChange(false)}>Open address</Link>}<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></>
  const picker = (side: Side, routeOnly: boolean) => <div className="stack">
    {(boxes.hasMore || Boolean(boxSearch)) && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={boxSearch} onChange={event => setBoxSearch(event.target.value)} />}
    <DestinationPicker id={`builder-${side}`} value={draft[side]} onChange={value => set({ [side]: value })} target={draft.targets[side] ?? ''} onTarget={value => set({ targets: { ...draft.targets, [side]: value } })} own={own} boxes={allBoxes} overview={overview.data!} routeOnly={routeOnly} error={errors[side]} domain={own.split('@')[1]} />
    {boxes.hasMore && <Button variant="ghost" size="sm" loading={boxes.loadingMore} onClick={boxes.loadMore}>Load more addresses</Button>}
  </div>
  let body: ReactNode
  if (step === 'address') body = <form id="builder-address" className="stack" onSubmit={e => void next(e)} noValidate>
    <Field label="Address" htmlFor="builder-address-input" error={errors.address} errorCode={codes.address} pulse={pulse}>
      <Input id="builder-address-input" type="email" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder={`name@${hosts[0] ?? 'example.com'}`} autoFocus autoComplete="off" />
    </Field>
    {!errors.address && EMAIL.test(typed) && turnsOn(typed.split('@')[1]!) && domainOf(typed.split('@')[1]!) && <TurnOnReceiving host={typed.split('@')[1]!} domainId={domainOf(typed.split('@')[1]!)!.id} />}
    {onPattern && pattern && <div className="cluster"><Button size="sm" onClick={() => { onOpenChange(false); onPattern(pattern) }}>{pattern.startsWith('*@') ? 'Edit the catch-all' : 'Set up the wildcard'}</Button></div>}
    {fixes.length > 0 && <div className="cluster">{fixes.map(fix => <Button key={fix} size="sm" onClick={() => { setForm({ ...form, address: fix }); setErrors({}); setCodes({}) }}>Use {fix}</Button>)}</div>}
    {existing && <div className="cluster"><Link className="ui-button ui-button--secondary ui-button--sm" to={`/receiving/addresses/${existing.id}?tab=flow`} onClick={() => onOpenChange(false)}>Open it</Link></div>}
    <Field label="Display name" htmlFor="builder-address-name"><Input id="builder-address-name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="Name" /></Field>
    <details className="inbound-advanced" open={!!form.lifetime || !!form.publicAddress || !!errors.publicAddress || undefined}>
      <summary>More options</summary>
      <div className="stack inbound-advanced__body">
        <Field label="Receives mail for" htmlFor="builder-lifetime"><Select id="builder-lifetime" value={form.lifetime} onValueChange={value => setForm({ ...form, lifetime: value, ...(value ? { publicAddress: '' } : {}) })} options={lifetimes} /></Field>
        {!form.lifetime && <Field label="Reply as" htmlFor="builder-public" error={errors.publicAddress}><Input id="builder-public" type="email" value={form.publicAddress} onChange={e => setForm({ ...form, publicAddress: e.target.value })} autoComplete="off" /></Field>}
      </div>
    </details>
  </form>
  else if (step === 'flow' && fits && asking) body = <div className="stack">
    <p>It already splits its mail with this rule. Replacing it changes where that mail goes.</p>
    <Flow label="Its rule now"><FlowStage kind="process"><FlowItem><RuleLine rule={base!.rule!} keyName={base!.rule!.key} endpoints={overview.data?.endpoints} /></FlowItem></FlowStage></Flow>
  </div>
  else if (step === 'flow' && !fits) body = <div className="stack">
    <Alert tone="info">Its mail goes further than this editor shows.</Alert>
    {stepsPath && <p><Link to={stepsPath} onClick={leaveTo(stepsPath)}>Edit on its page</Link></p>}
  </div>
  else if (step === 'flow') body = <form id="builder-flow" className="stack" onSubmit={save} noValidate>
    {!ready ? <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div> : <Flow label="Where this mail goes">
      <FlowStage kind="receive"><FlowItem><Match value={own} /></FlowItem></FlowStage>
      <FlowStage kind="process">
        {/* One rule changed by key keeps its shape: the toggle would reroute the address, which isn't this editor's. */}
        {!ruleMode && <div className="builder-ways" role="group" aria-label="How many ways">
          <button type="button" className="rcv-kind" aria-pressed={!draft.split} onClick={() => set({ split: false })}>One destination</button>
          <button type="button" className="rcv-kind" aria-pressed={draft.split} onClick={() => set({ split: true })}>Split with a rule</button>
        </div>}
        {draft.split && <div className="builder-condition">
          <Select aria-label="If" value={draft.condition} onValueChange={value => set({ condition: value as Condition })} options={conditions.map(c => ({ value: c.value, label: c.label }))} />
          {draft.condition !== 'attachment' && <Field label={<span className="sr-only">{conditions.find(c => c.value === draft.condition)!.label}</span>} htmlFor="builder-value" error={errors.value}>
            <Input id="builder-value" value={draft.value} placeholder={conditions.find(c => c.value === draft.condition)!.placeholder} autoComplete="off" onChange={e => set({ value: e.target.value })} aria-invalid={!!errors.value || undefined} />
          </Field>}
        </div>}
        {others > 0 && stepsPath && <FlowItem><Link to={stepsPath} onClick={leaveTo(stepsPath)}>{others} more {others === 1 ? 'rule' : 'rules'}</Link></FlowItem>}
      </FlowStage>
      {draft.split ? <FlowFork labels={['If yes', 'Otherwise']} yes={picker('then', false)} no={picker('otherwise', false)} />
        : <FlowStage kind="deliver">{picker('then', !ruleMode)}</FlowStage>}
      {draft.split && base?.rule && base.also.length > 0 && <FlowStage kind="deliver" title="Also">
        {base.also.map(t => <FlowItem key={`${t.type}:${t.id}`} icon={<TargetIcon type={t.type} />}>{targetWord(t, saved?.id, true)}</FlowItem>)}
      </FlowStage>}
    </Flow>}
    {base?.rule && base.rule.attachedTo.length > 1 && <Alert tone="info">Its rule also runs on other addresses. A change here applies to this one only.</Alert>}
    {replacing && <Alert tone="warning">Its mail also goes to {base!.also.map((t, i) => <span key={`${t.type}:${t.id}`}>{i > 0 && (i === base!.also.length - 1 ? ' and ' : ', ')}{targetWord(t, saved?.id)}</span>)}. Saving stops that.</Alert>}
    {conflict && <><Alert tone="warning">Its flow changed since you opened it. Nothing was saved.</Alert><div className="cluster"><Button size="sm" onClick={() => void startOver()}>Show the saved flow</Button></div></>}
    {waiting && <AwaitingConfirm address={waiting} />}
    {problem !== null && <Alert tone="danger">{errorText(problem)}</Alert>}
  </form>
  else body = receivingSetup ? <div className="stack"><ReceivingSetupNote setup={receivingSetup} />{entry && overview.data ? <div className="addr-flow"><FlowPanel entry={entry} overview={overview.data} onEdit={() => { if (builderFits(entry, overview.data!)) { setPlan(null); setStep('flow') } else close(() => navigate(stepsPath!)) }} mailLink={false} /></div> : null}</div>
    : entry && overview.data ? <div className="addr-flow"><FlowPanel entry={entry} overview={overview.data} onEdit={() => { if (builderFits(entry, overview.data!)) { setPlan(null); setStep('flow') } else close(() => navigate(stepsPath!)) }} mailLink={false} /></div>
    : <div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div>
  return <>
    <Dialog size="lg" open={open} onOpenChange={next => { if (!next) close() }} title={title} analytics="address-builder" footer={footer} className="builder">{body}</Dialog>
    {/* Yes adds the host with consent (addReceivingHost, confirm) and creates the address again; No leaves both as they are. */}
    <ConfirmDialog open={!!moveHost} onOpenChange={next => { if (!next) setMoveHost(null) }} title={`Move mail for ${moveHost?.host ?? ''}?`}
      description={<>{moveHost?.message || 'Another provider receives mail there today.'} Creating this address turns receiving on there, so mail moves once you publish its MX record.{moveHost && !isSubdomainName(moveHost.host) && <> To keep that mail where it is, use a subdomain such as mail.{moveHost.host} instead.</>}</>}
      confirmLabel={`Use ${moveHost?.host ?? ''}`} danger onConfirm={async () => {
        await request(`/v1/inbound/domains/${encodeURIComponent(moveHost!.domainId)}/hosts`, { method: 'POST', body: { name: moveHost!.host, confirm: true }, scope })
        void save({ preventDefault() {} } as FormEvent)
      }} />
    <ConfirmDialog open={!!leaving} onOpenChange={next => { if (!next) setLeaving(null) }} title="Discard changes?" description="What you set here isn’t saved." confirmLabel="Discard" danger onConfirm={() => { const go = leaving; setLeaving(null); go?.() }} />
  </>
}
