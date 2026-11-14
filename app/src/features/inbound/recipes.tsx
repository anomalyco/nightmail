// Rituals as most people use them: the list (the Receiving page's Rituals tab), the add screen with ready-made rituals
// (recipes) grouped by what they do, and the short form a recipe opens. Every write goes through the public API
// (createRitualFromRecipe, updateRitualFromRecipe, updateRitual, deleteRitual, createEndpoint). A recipe's ritual is an
// ordinary script the API wrote; "Edit as code" opens it in the editor (rituals.tsx), and a hand edit makes it a script.
import { lazy, Suspense, useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, Ban, CodeXml, Forward, Hash, MessageSquare, ShieldAlert, Sparkles, Star, Webhook, X, type LucideIcon } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, SecretInput, Select, Switch, Textarea, useToast, type SelectOption } from '../../components/ui'
import { FieldSkeleton, LoadingRegion, Skeleton } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import { staleAfterWrite } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { ApiError } from '../../data/types'
import { useSingleFlight } from '../../lib/single-flight'
import { productName } from '../../../../api/src/brand'
import { ritualRecipes } from '../../../../api/src/ritual-schema'
import { concepts, guides } from './concepts'
import { useLiveVersion } from './live'
import { ago, firstOverview, useOverview, type Overview, type OverviewEndpoint, type OverviewRitual } from './overview'
import { ConceptLine } from './parts'
import { CreatedEndpointDialog, discordUrl, slackUrl, targetProblem, type Endpoint } from './ritual-connections'
import { AskAgentLink } from './ritual-agent'
import { addressOption, idempotencyFor } from './shared'
import './inbound.css'
import './receiving.css'
import './recipes.css'

const RitualsPage = lazy(() => import('./rituals').then(m => ({ default: m.RitualsPage })))
const errorText = (e: unknown) => e instanceof ApiError ? e.text : (e as Error).message
const LIST = '/receiving?tab=rituals'
/** The add screen's last tile: everything a recipe can't say. */
const script = { name: 'Write a script', description: 'The full ritual language, checked as you type.' }

// listRitualRecipes, as the add screen and the form read it.
type FieldType = 'slack' | 'discord' | 'chat' | 'forward' | 'webhook' | 'meaning' | 'label' | 'senders'
type RecipeField = { name: string; type: FieldType; label: string; placeholder: string | null; hint: string | null }
type Recipe = { id: string; group: string; name: string; description: string; sentence: string; fields: RecipeField[]; omens: boolean }
type Catalog = { groups: { id: string; title: string }[]; data: Recipe[]; omenPricePerThousand: string }
const useRecipes = (enabled = true) => useApiQuery(['ritual-recipes'], (_api, signal) => request<Catalog>('/v1/rituals/recipes', { signal }), { enabled })

const icons: Record<string, LucideIcon> = {
  slack: Hash, discord: MessageSquare, forward: Forward, webhook: Webhook, 'junk-newsletters': Archive, 'block-senders': Ban,
  'allow-senders': Star, 'junk-failed-dmarc': ShieldAlert, 'label-by-meaning': Sparkles, 'alert-by-meaning': Sparkles,
}
const RecipeIcon = ({ id, size = 15 }: { id: string | null; size?: number }) => { const Icon = (id && icons[id]) || CodeXml; return <Icon className="rcv-icon" size={size} aria-hidden="true" /> }
const ritualPath = (key: string) => `/receiving/rituals/${encodeURIComponent(key)}`
// A ritual named "new" shares its path with the add screen, so its editor is /new/code, which NewRecipeRoute serves.
const codePath = (key: string) => `${ritualPath(key)}/code`
const editPath = (r: Pick<OverviewRitual, 'key' | 'recipe'>) => r.recipe && r.key !== 'new' ? ritualPath(r.key) : codePath(r.key)

/** What a ritual does, in a sentence with its blanks filled in. Its recipe's wording comes from the shared catalogue
 *  (ritual-schema.ts, the source listRitualRecipes serves), so the list needs no read beyond the overview. */
export function Sentence({ ritual }: { ritual: Pick<OverviewRitual, 'key' | 'recipe'> }) {
  const recipe = ritual.recipe && ritualRecipes.find(r => r.id === ritual.recipe!.id)
  if (!recipe) return <>Your own script <code className="recipe-code">{ritual.key}</code></>
  const params = ritual.recipe!.params
  return <>{recipe.sentence.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    if (!name) return part
    const value = params[name]
    return <span key={i} className="recipe-blank">{Array.isArray(value) ? <Senders list={value} /> : value}</span>
  })}</>
}
function Senders({ list }: { list: string[] }) {
  return <>{list.slice(0, 2).map((s, i) => <span key={s}>{i > 0 && ', '}<PrivateAddress value={s} /></span>)}{list.length > 2 && ` +${list.length - 2}`}</>
}
function Addresses({ list, max = 1 }: { list: string[]; max?: number }) {
  return <span className="recipe-addresses">{list.slice(0, max).map((a, i) => <span key={a}>{i > 0 && ', '}<PrivateAddress value={a} /></span>)}{list.length > max && <span className="muted">+{list.length - max}</span>}</span>
}

/** The Rituals tab: every ritual as its sentence, where it runs, when it last acted, an on/off switch and a menu. */
export function RitualsTab({ overview, refresh }: { overview: Overview; refresh: () => Promise<unknown> }) {
  const navigate = useNavigate(), toast = useToast()
  useRecipes() // warms the add screen
  const [switching, setSwitching] = useState<Record<string, boolean>>({})
  const [deleting, setDeleting] = useState<OverviewRitual | null>(null), [deleteOpen, setDeleteOpen] = useState(false)
  const toggle = useSingleFlight('rituals.toggle', async (r: OverviewRitual, enabled: boolean) => {
    setSwitching(s => ({ ...s, [r.key]: enabled }))
    try {
      await request(`/v1/rituals/scripts/${encodeURIComponent(r.key)}`, { method: 'PATCH', body: { enabled } })
      await refresh()
      toast(enabled ? `${r.key} is on` : `${r.key} is off · it keeps its addresses`, 'success')
    } catch (e) { toast(errorText(e), 'error') }
    finally { setSwitching(s => { const { [r.key]: _, ...rest } = s; return rest }) }
  })
  async function remove(r: OverviewRitual) {
    await request(`/v1/rituals/scripts/${encodeURIComponent(r.key)}`, { method: 'DELETE' })
    await refresh()
    toast(`${r.key} deleted`, 'success')
  }
  const last = (r: OverviewRitual) => !r.enabled ? <span className="muted">Off</span>
    : r.lastMatchedAt ? <time dateTime={r.lastMatchedAt} title={new Date(r.lastMatchedAt).toLocaleString()}>{ago(r.lastMatchedAt)}</time>
    : <span className="muted" title="Not in the last 1,000 emails">Not lately</span>
  const runsOn = (r: OverviewRitual) => r.addresses.length ? <Addresses list={r.addresses} />
    : <Link className="rcv-add" to={r.recipe ? editPath(r) : `${codePath(r.key)}#attach`} onClick={e => e.stopPropagation()}>Not attached · attach</Link>
  return <div className="stack rcv-tab">
    <div className="rcv-kindline"><ConceptLine line={concepts.rituals.line} example={concepts.rituals.example} guide={guides.rituals} /><Link className="ui-button ui-button--secondary ui-button--sm" to="/receiving/rituals/new">New ritual</Link></div>
    <DataTable className="rcv-table recipe-table" rows={overview.rituals} rowKey={r => r.key} rowHref={editPath}
      empty={<EmptyState title="No rituals yet" description="Post new mail to Slack, forward it, or keep out junk." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rituals/new">New ritual</Link>} />}
      columns={[
        { key: 'what', label: 'Ritual', width: '50%', card: 'title', render: r => <span className="recipe-row" data-off={!r.enabled || undefined}><RecipeIcon id={r.recipe?.id ?? null} /><span className="recipe-sentence"><Sentence ritual={r} /></span></span> },
        { key: 'on', label: 'Runs on', width: '24%', card: 'line', render: runsOn, cardRender: r => <span className="recipe-card-line">{runsOn(r)}<span aria-hidden="true">·</span>{last(r)}</span> },
        { key: 'last', label: 'Last matched', width: '13%', card: 'hide', render: last },
        { key: 'actions', label: '', align: 'right', card: 'end', render: r => <span className="recipe-controls">
          <Switch checked={switching[r.key] ?? r.enabled} disabled={r.key in switching} onCheckedChange={v => void toggle(r, v)} label={<span className="sr-only">Run {r.key}</span>} />
          <DropdownMenu label={`Actions for ${r.key}`} title={<Sentence ritual={r} />} items={[
            { label: 'Edit', onSelect: () => navigate(editPath(r)) },
            ...(r.recipe ? [{ label: 'Edit as code', onSelect: () => navigate(codePath(r.key)) }] : []),
            { label: 'Trace', onSelect: () => navigate('/receiving/trace', { state: r.addresses[0] ? { to: r.addresses[0] } : null }) },
            { label: 'Delete', destructive: true, onSelect: () => { setDeleting(r); setDeleteOpen(true) } },
          ]} />
        </span> },
      ]} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} danger title={`Delete ${deleting?.key ?? 'this ritual'}?`} description="It stops running on its addresses. Earlier versions stay restorable over the API."
      confirmLabel="Delete ritual" onConfirm={() => deleting ? remove(deleting) : undefined} />
  </div>
}

/** New ritual: the recipes, grouped by what they do, then "Write a script" and the agent link. Each opens its own page. */
export function NewRitualPage() {
  const { canAdminister } = useWorkspaceAccess()
  const catalog = useRecipes(canAdminister)
  const options = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister })
  // The Receiving page's first read (usually cached by now): the prompts name the address rituals run on most.
  const overview = useOverview(firstOverview, false, canAdminister)
  const [params] = useSearchParams()
  const address = params.get('address')
  const suffix = address ? `?address=${encodeURIComponent(address)}` : ''
  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title="New ritual" backTo={LIST} /><EmptyState title={concepts.rituals.adminOnly} /></div>
  const c = catalog.data && (overview.data || overview.error) && (options.data || options.error) ? catalog.data : undefined
  const used = (overview.data?.rituals ?? []).flatMap(r => r.addresses)
  const agentAddress = (options.data ?? []).find(a => a.id === address)?.address ?? [...new Set(used)].sort((a, b) => used.filter(x => x === b).length - used.filter(x => x === a).length)[0] ?? null
  return <div className="stack inbound-stack recipe-page">
    <PageHeader title="New ritual" backTo={LIST} />
    {catalog.error && !c ? <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      : !c ? <LoadingRegion label="Loading recipes"><div className="recipe-groups" aria-hidden="true">{[2, 2, 4, 2].map((n, g) => <section key={g} className="recipe-group">
        <Skeleton width={120} height={14} /><div className="recipe-tiles">{Array.from({ length: n }, (_, i) => <span key={i} className="recipe-tile recipe-tile--skeleton" />)}</div></section>)}</div></LoadingRegion>
      : <div className="recipe-groups">
        {c.groups.map(g => {
          const recipes = c.data.filter(r => r.group === g.id)
          // AI recipes are billed per email checked: said once, over the group's cards.
          return <section key={g.id} className="recipe-group" aria-labelledby={`recipes-${g.id}`}>
            <h2 id={`recipes-${g.id}`}>{g.title}{recipes.every(r => r.omens) && <span className="recipe-group__price"> · ${c.omenPricePerThousand} per 1,000 emails checked</span>}</h2>
            <div className="recipe-tiles">{recipes.map(r => <Link key={r.id} className="recipe-tile" to={`/receiving/rituals/new/${r.id}${suffix}`}>
              <RecipeIcon id={r.id} size={16} />
              <span className="recipe-tile__text"><strong>{r.name}</strong><span className="muted">{r.description}</span></span>
            </Link>)}</div>
          </section>
        })}
        <section className="recipe-group" aria-labelledby="recipes-script">
          <h2 id="recipes-script">Anything else</h2>
          <div className="recipe-tiles">
            <Link className="recipe-tile" to="/receiving/rituals/new/script"><RecipeIcon id={null} size={16} /><span className="recipe-tile__text"><strong>{script.name}</strong><span className="muted">{script.description}</span></span></Link>
          </div>
          <AskAgentLink address={agentAddress} />
        </section>
      </div>}
  </div>
}

/** /receiving/rituals/new/:recipe: a recipe's form. "code" is the editor of a script named new (see codePath). */
export function NewRecipeRoute() {
  const { recipe } = useParams()
  if (recipe === 'code') return <Suspense fallback={null}><RitualsPage /></Suspense>
  return <RecipeForm recipeId={recipe ?? ''} />
}
/** /receiving/rituals/:key: a recipe ritual's form; a script opens in the editor. */
export function RitualRoute() {
  const { key } = useParams()
  return <RecipeForm ritualKey={key ?? ''} />
}

function RecipeForm({ recipeId, ritualKey }: { recipeId?: string; ritualKey?: string }) {
  const { canAdminister } = useWorkspaceAccess()
  const catalog = useRecipes(canAdminister)
  const overview = useOverview({ limit: 1 }, false, canAdminister)
  const options = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister })
  const [params] = useSearchParams()
  const client = useQueryClient()
  // Endpoints confirmed or added elsewhere (a forward's recipient agreeing) show up in the pickers.
  useLiveVersion(canAdminister && !!overview.data, change => { if (!change.first && change.endpointsMoved) void overview.refetch() }, { endpoints: true })
  const existing = ritualKey ? overview.data?.rituals.find(r => r.key === ritualKey) : undefined
  const id = recipeId ?? existing?.recipe?.id
  const recipe = catalog.data?.data.find(r => r.id === id)
  const back = ritualKey ? LIST : '/receiving/rituals/new'
  const title = recipe?.name ?? (ritualKey ? ritualKey : ritualRecipes.find(r => r.id === recipeId)?.name ?? 'New ritual')
  const header = (actions?: ReactNode) => <PageHeader title={title} backTo={back} actions={actions} />
  if (!canAdminister) return <div className="stack inbound-stack">{header()}<EmptyState title={concepts.rituals.adminOnly} /></div>
  const error = catalog.error ?? overview.error ?? options.error
  if (error && !(catalog.data && overview.data && options.data)) return <div className="stack inbound-stack">{header()}<ErrorState error={error} onRetry={() => { void catalog.refetch(); void overview.refetch(); void options.refetch() }} /></div>
  if (!catalog.data || !overview.data || !options.data) return <div className="stack inbound-stack recipe-page">{header()}
    <LoadingRegion label="Loading the form"><div className="recipe-form" aria-hidden="true"><Skeleton width="70%" height={14} /><FieldSkeleton /><FieldSkeleton /></div></LoadingRegion></div>
  if (ritualKey && !existing) return <div className="stack inbound-stack">{header()}<EmptyState title={`No ritual named ${ritualKey}`} action={<Link className="ui-button ui-button--secondary ui-button--md" to={LIST}>Rituals</Link>} /></div>
  if (existing && !existing.recipe) return <Navigate replace to={codePath(existing.key)} />
  if (!recipe) return <div className="stack inbound-stack">{header()}<EmptyState title={`No recipe named ${id}`} action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rituals/new">New ritual</Link>} /></div>
  const preset = params.get('address')
  return <RecipeEditor key={existing?.key ?? recipe.id} recipe={recipe} price={catalog.data.omenPricePerThousand} existing={existing} overview={overview.data}
    addresses={options.data} preset={preset} header={header} back={back}
    refresh={() => client.invalidateQueries({ predicate: query => staleAfterWrite(query.queryKey, false) })} />
}

type AddressOption = { id: string; address: string; aliases: string[]; expiresAt?: string | null }
type EndpointType = OverviewEndpoint['type']
const NEW = '+new'
const endpointTypes: Partial<Record<FieldType, EndpointType[]>> = { slack: ['slack'], discord: ['discord'], chat: ['slack', 'discord'], forward: ['forward'], webhook: ['webhook'] }
const newOption: Partial<Record<FieldType, string>> = { slack: 'New Slack channel', discord: 'New Discord channel', chat: 'New channel', forward: 'Someone new', webhook: 'New webhook' }
const newTarget: Partial<Record<FieldType, { label: string; placeholder: string; hint: string; empty: string }>> = {
  slack: { label: 'Slack webhook URL', placeholder: 'https://hooks.slack.com/services/…', hint: 'From Slack’s Incoming Webhooks app.', empty: 'Paste the Slack webhook URL.' },
  discord: { label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…', hint: 'Channel settings, Integrations, Webhooks.', empty: 'Paste the Discord webhook URL.' },
  chat: { label: 'Slack or Discord webhook URL', placeholder: 'https://hooks.slack.com/services/…', hint: 'An incoming webhook URL from either one.', empty: 'Paste the channel’s webhook URL.' },
  webhook: { label: 'Your URL', placeholder: 'https://', hint: `${productName} posts signed JSON; the secret shows once.`, empty: 'Enter your URL.' },
  forward: { label: 'Their address', placeholder: 'team@example.com', hint: 'They agree by email first, unless it’s your domain.', empty: 'Enter their address.' },
}
/** The endpoint type a pasted URL is for (Slack or Discord, for a field that takes either), or what is wrong with it. */
function targetCheck(type: FieldType, value: string): { type?: EndpointType; error?: string } {
  const endpoint: EndpointType | undefined = type === 'chat' ? (slackUrl.test(value) ? 'slack' : discordUrl.test(value) ? 'discord' : undefined) : endpointTypes[type]![0]
  if (!endpoint) return { error: targetProblem('webhook', value) || 'Use a Slack or Discord incoming webhook URL.' }
  const error = targetProblem(endpoint, value)
  return error ? { error } : { type: endpoint }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56)
const freeName = (base: string, taken: Set<string>) => { const stem = slug(base) || 'endpoint'; for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem}-${n}`; if (!taken.has(name)) return name } }
const splitSenders = (text: string) => [...new Set(text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
type Made = { name: string; type: EndpointType; status: OverviewEndpoint['status']; target: string }

function RecipeEditor({ recipe, price, existing, overview, addresses, preset, header, back, refresh }: {
  recipe: Recipe; price: string; existing?: OverviewRitual; overview: Overview; addresses: AddressOption[]; preset: string | null
  header: (actions?: ReactNode) => ReactNode; back: string; refresh: () => Promise<unknown>
}) {
  const navigate = useNavigate(), toast = useToast()
  const targetsList = addresses.flatMap(a => [{ value: a.id, label: a.address, expires: !!a.expiresAt }, ...a.aliases.map(alias => ({ value: alias, label: alias, expires: false }))])
  const labelOf = (value: string) => targetsList.find(t => t.value === value)?.label ?? value
  const [made, setMade] = useState<Made[]>([])
  // The overview's copy wins once it lists an endpoint made here: it has the recipient's answer.
  const endpoints = [...overview.endpoints.filter(e => e.source === 'endpoint'), ...made.filter(m => !overview.endpoints.some(e => e.name === m.name))]
  const choices = (f: RecipeField) => endpoints.filter(e => endpointTypes[f.type]!.includes(e.type))
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(recipe.fields.map(f => {
    const saved = existing?.recipe?.params[f.name]
    if (saved !== undefined) return [f.name, Array.isArray(saved) ? saved.join(', ') : saved]
    if (!endpointTypes[f.type]) return [f.name, '']
    const first = choices(f).find(e => e.status === 'ready')
    return [f.name, first?.name ?? NEW]
  })))
  const [urls, setUrls] = useState<Record<string, string>>({})
  // A new ritual starts on the address the workspace's rituals run on most (else its first permanent one).
  const uses = (value: string) => overview.rituals.reduce((n, r) => n + r.attachedTo.filter(t => t === value).length, 0)
  const firstAddress = targetsList.filter(t => !t.expires).reduce<typeof targetsList[number] | undefined>((best, t) => !best || uses(t.value) > uses(best.value) ? t : best, undefined)?.value
  const [targets, setTargets] = useState<string[]>(() => existing ? existing.attachedTo : [preset && targetsList.some(t => t.value === preset) ? preset : firstAddress].filter((t): t is string => !!t))
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [secret, setSecret] = useState<(Endpoint & { secret?: string }) | null>(null)
  const [attempt] = useState({ key: '', body: '' })

  const taken = new Set(endpoints.map(e => e.name).concat(overview.endpoints.map(e => e.name)))
  const fieldError = (f: RecipeField): string => {
    const server = error instanceof ApiError ? error.fields[`params.${f.name}`] : undefined
    if (server) return server
    if (!tried) return ''
    const value = (values[f.name] ?? '').trim()
    if (endpointTypes[f.type]) {
      if (value !== NEW) return value ? '' : 'Choose one.'
      const url = (urls[f.name] ?? '').trim()
      return url ? targetCheck(f.type, url).error ?? '' : newTarget[f.type]!.empty
    }
    if (f.type === 'senders') return splitSenders(value).length ? '' : 'Add at least one address or @domain.'
    return value ? '' : `Fill in ${f.label.toLowerCase()}.`
  }
  const targetsError = (error instanceof ApiError ? error.fields.addresses : undefined) || (tried && !targets.length ? 'Choose at least one address.' : '')
  // A forward that its recipient hasn't confirmed can't be saved yet: the API refuses it until they agree.
  const waiting = recipe.fields.map(f => f.type === 'forward' ? endpoints.find(e => e.name === values[f.name] && e.type === 'forward') : undefined).find(e => e && e.status !== 'ready')
  const general = error && !(error instanceof ApiError && (Object.keys(error.fields).some(k => k.startsWith('params.') || k === 'addresses'))) ? errorText(error) : ''

  /** Creates the endpoint a field's "new" option describes, once: a retry after a failed save reuses it. */
  async function createEndpoint(f: RecipeField): Promise<Endpoint & { secret?: string }> {
    const url = urls[f.name]!.trim(), type = targetCheck(f.type, url).type!
    const base = type === 'forward' ? url.split('@')[0]! : labelOf(targets[0] ?? '').split('@')[0] || type
    const name = freeName(base, taken)
    const post = (body: Record<string, unknown>) => request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })
    let created: Endpoint & { secret?: string }
    if (type === 'forward') {
      // On a domain this workspace verified, no confirmation email is needed; anywhere else the recipient agrees first.
      const body = { type, name, address: url, ...(targets[0] ? { from: targets[0] } : {}) }
      try { created = await post({ ...body, preverify: true }) }
      catch (e) { if (!(e instanceof ApiError && e.code === 'PREVERIFY_NOT_ALLOWED')) throw e; created = await post(body) }
    } else created = await post({ type, name, url })
    setMade(list => [...list, { name: created.name, type: created.type, status: created.status, target: created.target }])
    setValues(v => ({ ...v, [f.name]: created.name })); setUrls(u => ({ ...u, [f.name]: '' }))
    return created
  }
  const save = useSingleFlight('rituals.recipe.save', async () => {
    setBusy(true); setError(null)
    try {
      const params: Record<string, string | string[]> = {}
      let webhook: (Endpoint & { secret?: string }) | null = null
      for (const f of recipe.fields) {
        const value = (values[f.name] ?? '').trim()
        if (endpointTypes[f.type] && value === NEW) {
          const created = await createEndpoint(f)
          if (created.secret) webhook = created
          if (created.status === 'pending') { await refresh(); return }
          params[f.name] = created.name
        } else params[f.name] = f.type === 'senders' ? splitSenders(value) : value
      }
      if (existing) await request(`/v1/rituals/scripts/${encodeURIComponent(existing.key)}/recipe`, { method: 'PUT', body: { params, addresses: targets } })
      else await request('/v1/rituals/recipes', { method: 'POST', body: { recipe: recipe.id, params, addresses: targets } })
      await refresh()
      toast(existing ? `${existing.key} saved` : `${recipe.name} is on`, 'success')
      if (webhook) setSecret(webhook); else navigate(LIST)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }, existing?.key ?? recipe.id)
  function submit(event: FormEvent) {
    event.preventDefault(); setTried(true); setError(null)
    const invalid = recipe.fields.some(f => {
      const value = (values[f.name] ?? '').trim()
      if (endpointTypes[f.type]) return !value || (value === NEW && (!(urls[f.name] ?? '').trim() || !!targetCheck(f.type, urls[f.name]!.trim()).error))
      return f.type === 'senders' ? !splitSenders(value).length : !value
    })
    if (invalid || !targets.length || waiting) return
    void save()
  }
  const remaining = targetsList.filter(t => !targets.includes(t.value))
  const domains = [...new Set(targets.map(t => labelOf(t).split('@')[1]).filter(Boolean))]
  return <div className="stack inbound-stack recipe-page">
    {header(existing && <Link className="ui-button ui-button--secondary ui-button--md" to={codePath(existing.key)}>Edit as code</Link>)}
    <form className="recipe-form" onSubmit={submit} noValidate>
      <p className="recipe-form__intro muted">{recipe.description}</p>
      {recipe.omens && <p className="recipe-price"><Sparkles size={14} aria-hidden="true" /><span>${price} per 1,000 emails checked{domains.length ? <> · reads mail at {domains.join(', ')}</> : null}</span></p>}
      <Field label="Runs on mail to" error={targetsError || undefined}>
        <div className="recipe-targets">
          {targets.map(t => <span key={t} className="recipe-target"><PrivateAddress value={labelOf(t)} /><IconButton size="sm" label="Remove address" onClick={() => setTargets(targets.filter(x => x !== t))} disabled={busy}><X size={13} aria-hidden="true" /></IconButton></span>)}
          {remaining.length > 0 && targets.length < 10 && <Select className="address-select-trigger recipe-targets__add" menuClassName="address-select" aria-label="Add an address" value="" placeholder={targets.length ? 'Add another' : 'Choose an address'}
            onValueChange={v => { if (v) setTargets([...targets, v]) }} options={remaining.map(t => addressOption(t.value, t.label))} />}
        </div>
      </Field>
      {recipe.fields.map(f => {
        const err = fieldError(f), id = `recipe-${f.name}`
        if (endpointTypes[f.type]) {
          const list = choices(f), value = values[f.name] ?? NEW
          const opts: SelectOption[] = [...list.map(e => ({ value: e.name, text: e.name, disabled: e.type === 'forward' && e.status !== 'ready' && e.name !== value,
            label: <>{e.name}{f.type === 'chat' ? <span className="muted"> · {e.type === 'slack' ? 'Slack' : 'Discord'}</span> : e.type === 'forward' ? <span className="muted"> · <PrivateAddress value={e.target} /></span> : null}</> })),
          { value: NEW, label: newOption[f.type]! }]
          const add = newTarget[f.type]!, url = urls[f.name] ?? ''
          return <div key={f.name} className="stack recipe-field">
            <Field label={f.label} error={value === NEW ? undefined : err || undefined}>
              <Select id={id} value={value} onValueChange={v => { setValues({ ...values, [f.name]: v }); setError(null) }} options={opts} />
            </Field>
            {value === NEW && <Field label={add.label} error={err || undefined} hint={`${add.hint} Saved as endpoint ${freeName(f.type === 'forward' ? url.split('@')[0] ?? '' : labelOf(targets[0] ?? '').split('@')[0] || f.type, taken)}.`}>
              <SecretInput type={f.type === 'forward' ? 'email' : f.type === 'webhook' ? 'url' : 'password'} autoComplete="off" value={url} placeholder={add.placeholder} aria-invalid={!!err || undefined}
                onChange={e => { setUrls({ ...urls, [f.name]: e.target.value }); setError(null) }} />
            </Field>}
          </div>
        }
        const value = values[f.name] ?? ''
        return <Field key={f.name} label={f.label} htmlFor={id} error={err || undefined} hint={f.hint ?? undefined}>
          {f.type === 'senders'
            ? <Textarea id={id} rows={3} value={value} placeholder={f.placeholder ?? undefined} spellCheck={false} aria-invalid={!!err || undefined} onChange={e => { setValues({ ...values, [f.name]: e.target.value }); setError(null) }} />
            : <Input id={id} value={value} placeholder={f.placeholder ?? undefined} autoComplete="off" aria-invalid={!!err || undefined} onChange={e => { setValues({ ...values, [f.name]: f.type === 'label' ? e.target.value.toLowerCase().replace(/\s+/g, '-') : e.target.value }); setError(null) }} />}
        </Field>
      })}
      {waiting && <Alert tone="info">We emailed <PrivateAddress value={waiting.target} /> to confirm. Save once they agree.</Alert>}
      {general && <Alert tone="danger">{general}</Alert>}
      <div className="recipe-form__actions">
        <Link className="ui-button ui-button--ghost ui-button--md" to={back}>Cancel</Link>
        <Button variant="primary" type="submit" loading={busy} disabled={!!waiting}>Save</Button>
      </div>
    </form>
    <CreatedEndpointDialog created={secret} writeRitual={false} onClose={() => { setSecret(null); navigate(LIST) }} />
  </div>
}
