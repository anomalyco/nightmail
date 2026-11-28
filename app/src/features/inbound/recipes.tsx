// Rules as most people use them: the list (the Mail routing page's Rules tab), the add screen with ready-made rules
// (recipes) grouped by what they do, and the short form a recipe opens to make its rule. Every write goes through the
// public API (createRuleFromRecipe, updateRule, deleteRule, createEndpoint). A recipe's rule is an ordinary script the
// API wrote: like every rule it opens as its code (rituals.tsx), and saving a hand edit there makes it a script.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, Ban, CodeXml, Forward, Hash, MessageSquare, ShieldAlert, Sparkles, Split, Star, Webhook, X, type LucideIcon } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, SearchField, SecretInput, Select, Switch, Textarea, useToast, type SelectOption } from '../../components/ui'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { chunk } from '../../lib/preloadable'
import { useDebounced } from '../../lib/pagination'
import { FieldSkeleton, LoadingRegion, Skeleton } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery, useRequestScope, useWorkspaceAccess } from '../../data/context'
import { isAbortError, request } from '../../data/live'
import { invalidate, invalidateResources } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { ApiError, errorText } from '../../data/types'
import { useSingleFlight } from '../../lib/single-flight'
import { ritualRecipes } from '../../../../api/src/ritual-schema'
import { concepts } from './concepts'
import { useLiveVersion } from './live'
import { ago, firstOverview, useOverview, type Overview, type OverviewEndpoint, type OverviewRule } from './overview'
import { AwaitingConfirm, CreatedEndpointDialog, ForwardSenderOffer, discordUrl, forwardSenderNeeded, slackUrl, targetProblem, type Endpoint } from './ritual-connections'
import { AskAgentLink } from './ritual-agent'
import type { Condition } from './builder'
import { addressOption, freeKey, idempotencyFor, openBuilder, rulePath, splitBuilderPath } from './shared'
import './inbound.css'
import './receiving.css'
import './recipes.css'

const RulePage = chunk(() => import('./rituals')).page(m => m.RulePage)
const LIST = '/receiving?tab=rules'

// listRuleRecipes, as the add screen and the form read it.
type FieldType = 'slack' | 'discord' | 'chat' | 'forward' | 'webhook' | 'meaning' | 'label' | 'senders'
type RecipeField = { name: string; type: FieldType; label: string; placeholder: string | null; hint: string | null }
type Recipe = { id: string; group: string; name: string; description: string; sentence: string; fields: RecipeField[]; decisions: boolean }
type Catalog = { groups: { id: string; title: string }[]; data: Recipe[] }
const useRecipes = (enabled = true) => useApiQuery(['rule-recipes'], (_api, signal) => request<Catalog>('/v1/rules/recipes', { signal }), { enabled })

const icons: Record<string, LucideIcon> = {
  slack: Hash, discord: MessageSquare, forward: Forward, webhook: Webhook, 'junk-newsletters': Archive, 'block-senders': Ban,
  'allow-senders': Star, 'junk-failed-dmarc': ShieldAlert, 'label-by-meaning': Sparkles, 'alert-by-meaning': Sparkles,
  split: Split, 'split-by-meaning': Sparkles,
}
const RecipeIcon = ({ id, size = 15 }: { id: string | null; size?: number }) => { const Icon = (id && icons[id]) || CodeXml; return <Icon className="rcv-icon" size={size} aria-hidden="true" /> }
const isSplitRule = (r: Pick<OverviewRule, 'recipe'>) => r.recipe?.id === 'split' || r.recipe?.id === 'split-by-meaning'

/** What a rule does, in a sentence with its blanks filled in. Its recipe's wording comes from the shared catalogue
 *  (ritual-schema.ts, the source listRuleRecipes serves), so the list needs no read beyond the overview. */
export function Sentence({ ritual }: { ritual: Pick<OverviewRule, 'key' | 'recipe'> }) {
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
/** A rule in plain words wherever it appears: a ready-made rule's sentence, or a script by its name. */
export function RuleLine({ rule, keyName, endpoints }: { rule?: Pick<OverviewRule, 'key' | 'recipe'>; keyName: string; endpoints?: Pick<OverviewEndpoint, 'name' | 'type'>[] }) {
  if (rule?.recipe && (rule.recipe.id === 'split' || rule.recipe.id === 'split-by-meaning')) return <SplitSentence params={rule.recipe.params} meaning={rule.recipe.id === 'split-by-meaning'} endpoints={endpoints} />
  if (rule?.recipe) return <Sentence ritual={rule} />
  return <code className="recipe-code">{keyName}</code>
}
/** An address's rules on one line: the first in plain words, and how many more. */
export function RulesSummary({ keys, rules, endpoints }: { keys: string[]; rules: OverviewRule[]; endpoints?: Pick<OverviewEndpoint, 'name' | 'type'>[] }) {
  const first = keys[0]
  if (!first) return null
  return <span className="rcv-rules"><span className="rcv-rules__first"><RuleLine rule={rules.find(r => r.key === first)} keyName={first} endpoints={endpoints} /></span>{keys.length > 1 && <span className="muted">+{keys.length - 1}</span>}</span>
}
/** A two-way rule (the address builder's) in words: "If the subject mentions refund, send to refunds; otherwise to the support inbox". */
const testWords: Record<string, string> = { from: 'the sender is', subject: 'the subject mentions', text: 'the email mentions', attachment: 'it has an attachment' }
// A Slack or Discord destination says so ("support in Slack"): its name alone could be an inbox's.
const chatWords: Record<string, string> = { slack: 'Slack', discord: 'Discord' }
const destinationWords = (value: string | string[] | undefined, endpoints?: Pick<OverviewEndpoint, 'name' | 'type'>[]) => {
  const v = typeof value === 'string' ? value : '', chat = chatWords[endpoints?.find(e => e.name === v)?.type ?? '']
  return v === 'store' ? 'keep it' : v === 'drop' ? 'drop it' : v.startsWith('inbox:') ? `the ${v.slice(6)} inbox` : chat ? `${v} in ${chat}` : v
}
function SplitSentence({ params, meaning, endpoints }: { params: Record<string, string | string[]>; meaning: boolean; endpoints?: Pick<OverviewEndpoint, 'name' | 'type'>[] }) {
  const blank = (text: ReactNode) => <span className="recipe-blank">{text}</span>
  const words = (v: string | string[] | undefined) => Array.isArray(v) ? v.join(', ') : v ?? ''
  if (!meaning && params.test === 'always') return <>Send all mail to {blank(destinationWords(params.then, endpoints))}</>
  const condition = meaning ? <>it looks like {blank(words(params.meaning))}</> : params.test === 'from' ? <>{testWords.from} {blank(<Senders list={[params.value ?? []].flat()} />)}</>
    : params.test === 'attachment' ? testWords.attachment : <>{testWords[words(params.test)] ?? words(params.test)} {blank(words(params.value))}</>
  return <>If {condition}, send to {blank(destinationWords(params.then, endpoints))}; otherwise to {blank(destinationWords(params.otherwise, endpoints))}</>
}
function Senders({ list }: { list: string[] }) {
  return <>{list.slice(0, 2).map((s, i) => <span key={s}>{i > 0 && ', '}<PrivateAddress value={s} /></span>)}{list.length > 2 && ` +${list.length - 2}`}</>
}
function Addresses({ list, max = 1 }: { list: string[]; max?: number }) {
  return <span className="recipe-addresses">{list.slice(0, max).map((a, i) => <span key={a}>{i > 0 && ', '}<PrivateAddress value={a} /></span>)}{list.length > max && <span className="muted">+{list.length - max}</span>}</span>
}

/** The Rules tab: every rule as its sentence, where it runs, when it last acted, an on/off switch and a menu. */
export function RulesTab({ overview, refresh }: { overview: Overview; refresh: () => Promise<unknown> }) {
  const navigate = useNavigate(), toast = useToast()
  useRecipes() // warms the add screen
  const options = useApiDef(queries.inboundAddressOptions())
  const ruleTargetIds = overview.rules.flatMap(r => r.attachedTo)
  const resolvedTargets = useResolvedAddresses(ruleTargetIds, options.data ?? [])
  const knownRuleAddresses = mergeAddresses(resolvedTargets.items, options.data ?? [])
  // Every rule opens on its page, its code. A two-way rule (the address builder's) can also be changed in the builder,
  // on the one address it runs on.
  const builderPath = (r: OverviewRule) => isSplitRule(r) ? splitBuilderPath(r.key, r.attachedTo, knownRuleAddresses) : null
  const [switching, setSwitching] = useState<Record<string, boolean>>({})
  const [deleting, setDeleting] = useState<OverviewRule | null>(null), [deleteOpen, setDeleteOpen] = useState(false)
  const scope = useRequestScope()
  const toggle = useSingleFlight('rules.toggle', async (r: OverviewRule, enabled: boolean) => {
    setSwitching(s => ({ ...s, [r.key]: enabled }))
    try {
      await request(`/v1/rules/scripts/${encodeURIComponent(r.key)}`, { method: 'PATCH', body: { enabled }, scope })
      await refresh()
      toast(enabled ? 'Rule on' : 'Rule off', 'success')
    } catch (e) { if (!isAbortError(e)) toast(errorText(e), 'error') }
    finally { setSwitching(s => { const { [r.key]: _, ...rest } = s; return rest }) }
  })
  async function remove(r: OverviewRule) {
    await request(`/v1/rules/scripts/${encodeURIComponent(r.key)}`, { method: 'DELETE', scope })
    await refresh()
    toast(`${r.key} deleted`, 'success')
  }
  const last = (r: OverviewRule) => !r.enabled ? null
    : r.lastMatchedAt ? <time dateTime={r.lastMatchedAt} title={new Date(r.lastMatchedAt).toLocaleString()}>{ago(r.lastMatchedAt)}</time>
    : <span className="muted" title="Not in the last 1,000 emails">Not lately</span>
  const runsOn = (r: OverviewRule) => r.addresses.length ? <Addresses list={r.addresses} />
    : <Link className="rcv-add" to={`${rulePath(r.key)}#attach`} onClick={e => e.stopPropagation()}>Not attached · attach</Link>
  return <div className="stack rcv-tab">
    {overview.rules.length > 0 && <div className="rcv-kindline"><Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rules/new">New rule</Link></div>}
    <DataTable className="rcv-table recipe-table" rows={overview.rules} rowKey={r => r.key} rowHref={r => rulePath(r.key)}
      empty={<EmptyState title="No rules yet" action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rules/new">New rule</Link>} />}
      columns={[
        { key: 'what', label: 'Rule', card: 'title', render: r => <span className="recipe-row" data-off={!r.enabled || undefined}><RecipeIcon id={r.recipe?.id ?? null} /><span className="recipe-sentence"><RuleLine rule={r} keyName={r.key} endpoints={overview.endpoints} /></span></span> },
        { key: 'on', label: 'Runs on', width: '26%', card: 'line', render: runsOn, cardRender: r => <span className="recipe-card-line">{runsOn(r)}</span> },
        { key: 'last', label: 'Last matched', width: 128, card: 'hide', render: last },
        { key: 'actions', label: '', width: 96, align: 'right', card: 'end', render: r => <span className="recipe-controls">
          <Switch checked={switching[r.key] ?? r.enabled} disabled={r.key in switching} onCheckedChange={v => void toggle(r, v)} label={<span className="sr-only">Run {r.key}</span>} />
          <DropdownMenu label={`Actions for ${r.key}`} title={<RuleLine rule={r} keyName={r.key} endpoints={overview.endpoints} />} items={[
            ...(builderPath(r) ? [{ label: openBuilder, onSelect: () => navigate(builderPath(r)!) }] : []),
            { label: 'Delete', destructive: true, onSelect: () => { setDeleting(r); setDeleteOpen(true) } },
          ]} />
        </span> },
      ]} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} danger title={`Delete ${deleting?.key ?? 'this rule'}?`} description="It stops running on its addresses. Earlier versions stay restorable over the API."
      confirmLabel="Delete rule" onConfirm={() => deleting ? remove(deleting) : undefined} />
  </div>
}

/** New rule: splitting an address's mail two ways (the address builder), the recipes grouped by what they do, then the
 *  tucked-away ways for those who code: write a script, or ask an agent. Each opens its own page. */
export function NewRulePage() {
  const { canAdminister } = useWorkspaceAccess()
  const catalog = useRecipes(canAdminister)
  const [splitSearch, setSplitSearch] = useState('')
  const options = useAddressOptions({ enabled: canAdminister, search: useDebounced(splitSearch) })
  // The Mail routing page's first read (usually cached by now): the prompts name the address rules run on most.
  const overview = useOverview(firstOverview, false, canAdminister)
  const [params] = useSearchParams()
  const [choosing, setChoosing] = useState<Condition | null>(null)
  const address = params.get('address')
  const resolvedParam = useResolvedAddresses(address ? [address] : [], options.items, canAdminister && !options.isPending)
  const allOptions = mergeAddresses(resolvedParam.items, options.items)
  const suffix = address ? `?address=${encodeURIComponent(address)}` : ''
  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title="New rule" backTo={LIST} /><EmptyState title={concepts.rules.adminOnly} /></div>
  const c = catalog.data && (overview.data || overview.error) && (!options.isPending || options.isError) && !resolvedParam.pending ? catalog.data : undefined
  const used = (overview.data?.rules ?? []).flatMap(r => r.addresses)
  const agentAddress = allOptions.find(a => a.id === address)?.address ?? [...new Set(used)].sort((a, b) => used.filter(x => x === b).length - used.filter(x => x === a).length)[0] ?? null
  // Splitting mail two ways is the address builder's, on an address: the one this came from, else the one asked for.
  const scoped = allOptions.find(a => a.id === address && a.kind !== 'inbox')
  const splittable = allOptions.filter(a => a.kind !== 'inbox')
  const splitTile = (condition: Condition, icon: ReactNode, name: string) => scoped
    ? <Link className="recipe-tile" to={`/receiving?build=${encodeURIComponent(scoped.id)}&split=${condition}`}>{icon}<strong>{name}</strong></Link>
    : <button type="button" className="recipe-tile" onClick={() => setChoosing(condition)}>{icon}<strong>{name}</strong></button>
  return <div className="stack inbound-stack recipe-page">
    <PageHeader title="New rule" backTo={LIST} />
    {catalog.error && !c ? <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      : !c ? <LoadingRegion label="Loading recipes"><div className="recipe-groups" aria-hidden="true">{[2, 2, 4, 2].map((n, g) => <section key={g} className="recipe-group">
        <Skeleton width={120} height={14} /><div className="recipe-tiles">{Array.from({ length: n }, (_, i) => <span key={i} className="recipe-tile recipe-tile--skeleton" />)}</div></section>)}</div></LoadingRegion>
      : <div className="recipe-groups">
        {splittable.length > 0 && <section className="recipe-group" aria-labelledby="recipes-split">
          <h2 id="recipes-split">Split mail</h2>
          <div className="recipe-tiles">
            {splitTile('subject', <Split className="rcv-icon" size={16} aria-hidden="true" />, 'Split by words')}
            {splitTile('ai', <Sparkles className="rcv-icon" size={16} aria-hidden="true" />, 'Split by meaning')}
          </div>
        </section>}
        {c.groups.map(g => {
          const recipes = c.data.filter(r => r.group === g.id)
          // A tile is its name under the group's heading. An AI recipe's form says, above Save, that it's free and what the AI reads.
          return <section key={g.id} className="recipe-group" aria-labelledby={`recipes-${g.id}`}>
            <h2 id={`recipes-${g.id}`}>{g.title}</h2>
            <div className="recipe-tiles">{recipes.map(r => <Link key={r.id} className="recipe-tile" to={`/receiving/rules/new/${r.id}${suffix}`}>
              <RecipeIcon id={r.id} size={16} /><strong>{r.name}</strong>
            </Link>)}</div>
          </section>
        })}
        {/* For those who code: tucked away, one line. */}
        <section className="recipe-group recipe-advanced" aria-labelledby="recipes-script">
          <h2 id="recipes-script">Advanced</h2>
          <div className="cluster"><Link className="ui-button ui-button--ghost ui-button--sm recipe-agent-link" to={`/receiving/rules/new/script${suffix}`}><CodeXml size={14} aria-hidden="true" />Write code</Link><AskAgentLink address={agentAddress} /></div>
        </section>
      </div>}
    <SplitChooser condition={choosing} onClose={() => { setChoosing(null); setSplitSearch('') }} addresses={splittable} search={splitSearch} onSearch={setSplitSearch} searchable={options.hasMore || Boolean(splitSearch)} hasMore={options.hasMore} loadingMore={options.loadingMore} onLoadMore={options.loadMore} />
  </div>
}

/** Split mail from New rule without an address: which address's mail, before the builder opens on it. */
function SplitChooser({ condition, onClose, addresses, search, onSearch, searchable, hasMore, loadingMore, onLoadMore }: { condition: Condition | null; onClose: () => void; addresses: { id: string; address: string; displayName?: string | null }[]; search: string; onSearch: (v: string) => void; searchable: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  const navigate = useNavigate()
  const [chosen, setChosen] = useState('')
  const go = (event: FormEvent) => { event.preventDefault(); if (chosen && condition) navigate(`/receiving?build=${encodeURIComponent(chosen)}&split=${condition}`) }
  return <Dialog open={condition !== null} onOpenChange={open => { if (!open) { onClose(); setChosen('') } }} title="Which address?"
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="split-chooser" disabled={!chosen}>Next</Button></>}>
    <form id="split-chooser" className="stack" onSubmit={go}>
      {searchable && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={search} onChange={event => onSearch(event.target.value)} />}
      <Field label="Split the mail of" htmlFor="split-chooser-address"><Select id="split-chooser-address" value={chosen} onValueChange={setChosen} placeholder="Choose an address" options={addresses.map(a => addressOption(a.id, a.address, a.displayName ?? undefined))} /></Field>
      {hasMore && <Button variant="ghost" size="sm" loading={loadingMore} onClick={onLoadMore}>Load more addresses</Button>}
    </form>
  </Dialog>
}

/** /receiving/rules/new/:recipe: a recipe's form, which makes a rule. "code" is the page of a rule named new (see rulePath). */
export function NewRecipeRoute() {
  const { recipe } = useParams()
  if (recipe === 'code') return <RulePage />
  return <RecipeForm recipeId={recipe ?? ''} />
}

/** A recipe's one or two fields and the addresses to run on: it makes the rule, whose own page is then its code (rituals.tsx). */
function RecipeForm({ recipeId }: { recipeId: string }) {
  const { canAdminister } = useWorkspaceAccess()
  const catalog = useRecipes(canAdminister)
  const overview = useOverview(firstOverview, false, canAdminister)
  const [addressSearch, setAddressSearch] = useState('')
  const options = useAddressOptions({ enabled: canAdminister, search: useDebounced(addressSearch) })
  const [params] = useSearchParams()
  const preset = params.get('address')
  const resolvedPreset = useResolvedAddresses(preset ? [preset] : [], options.items, canAdminister && !options.isPending)
  const client = useQueryClient()
  // Endpoints confirmed or added elsewhere (a forward's recipient agreeing) show up in the pickers.
  useLiveVersion(canAdminister && !!overview.data, change => { if (!change.first && change.endpointsMoved) void overview.refetch() }, { endpoints: true })
  const recipe = catalog.data?.data.find(r => r.id === recipeId)
  const back = '/receiving/rules/new'
  const title = recipe?.name ?? ritualRecipes.find(r => r.id === recipeId)?.name ?? 'New rule'
  const header = (actions?: ReactNode) => <PageHeader title={title} backTo={back} actions={actions} />
  if (!canAdminister) return <div className="stack inbound-stack">{header()}<EmptyState title={concepts.rules.adminOnly} /></div>
  const error = catalog.error ?? overview.error ?? (options.isError && !options.items.length ? options.error : null)
  if (error && !(catalog.data && overview.data && !options.isPending)) return <div className="stack inbound-stack">{header()}<ErrorState error={error} onRetry={() => { void catalog.refetch(); void overview.refetch(); void options.refetch() }} /></div>
  if (!catalog.data || !overview.data || options.isPending || resolvedPreset.pending) return <div className="stack inbound-stack recipe-page">{header()}
    <LoadingRegion label="Loading the form"><div className="recipe-form" aria-hidden="true">{ritualRecipes.find(r => r.id === recipeId)?.decisions && <Skeleton width="50%" height={14} />}<FieldSkeleton /><FieldSkeleton /></div></LoadingRegion></div>
  if (!recipe) return <div className="stack inbound-stack">{header()}<EmptyState title={`No recipe named ${recipeId}`} action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rules/new">New rule</Link>} /></div>
  return <RecipeEditor key={recipe.id} recipe={recipe} overview={overview.data}
    addresses={mergeAddresses(resolvedPreset.items, options.items)} preset={preset} header={header} back={back}
    addressSearch={addressSearch} onAddressSearch={setAddressSearch} addressSearchable={options.hasMore || Boolean(addressSearch)}
    hasMoreAddresses={options.hasMore} loadingMoreAddresses={options.loadingMore} onLoadMoreAddresses={options.loadMore}
    addressesComplete={!options.isFetching && !addressSearch && !options.hasMore} refetchAddresses={() => void options.refetch()}
    refresh={() => invalidateResources(client, invalidate.rules)} />
}

type AddressOption = { id: string; address: string; aliases: string[]; expiresAt?: string | null }
type EndpointType = OverviewEndpoint['type']
const NEW = '+new'
const endpointTypes: Partial<Record<FieldType, EndpointType[]>> = { slack: ['slack'], discord: ['discord'], chat: ['slack', 'discord'], forward: ['forward'], webhook: ['webhook'] }
// A new forward's option says what happens next: the recipient confirms by email first (unless it's on a domain this
// workspace verified); the rule is saved at once and forwards mail received from the moment they agree.
const newOption: Partial<Record<FieldType, string>> = { slack: 'New Slack channel', discord: 'New Discord channel', chat: 'New channel', forward: 'Someone new, who confirms by email', webhook: 'New webhook' }
const newTarget: Partial<Record<FieldType, { label: string; placeholder: string; empty: string }>> = {
  slack: { label: 'Slack incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…', empty: 'Paste the Slack webhook URL.' },
  discord: { label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…', empty: 'Paste the Discord webhook URL.' },
  chat: { label: 'Slack or Discord webhook URL', placeholder: 'https://hooks.slack.com/services/…', empty: 'Paste the channel’s webhook URL.' },
  webhook: { label: 'Your URL', placeholder: 'https://', empty: 'Enter your URL.' },
  forward: { label: 'Their address', placeholder: 'team@example.com', empty: 'Enter their address.' },
}
/** The endpoint type a pasted URL is for (Slack or Discord, for a field that takes either), or what is wrong with it. */
function targetCheck(type: FieldType, value: string): { type?: EndpointType; error?: string } {
  const endpoint: EndpointType | undefined = type === 'chat' ? (slackUrl.test(value) ? 'slack' : discordUrl.test(value) ? 'discord' : undefined) : endpointTypes[type]![0]
  if (!endpoint) return { error: targetProblem('webhook', value) || 'Use a Slack or Discord incoming webhook URL.' }
  const error = targetProblem(endpoint, value)
  return error ? { error } : { type: endpoint }
}
const splitSenders = (text: string) => [...new Set(text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
type Made = { name: string; type: EndpointType; status: OverviewEndpoint['status']; target: string }

/** `addressesComplete`: `addresses` is a fresh read of every address (no search, no more pages), so a target it lacks is gone. */
function RecipeEditor({ recipe, overview, addresses, preset, header, back, addressSearch, onAddressSearch, addressSearchable, hasMoreAddresses, loadingMoreAddresses, onLoadMoreAddresses, addressesComplete, refetchAddresses, refresh }: {
  recipe: Recipe; overview: Overview; addresses: AddressOption[]; preset: string | null
  header: (actions?: ReactNode) => ReactNode; back: string; addressSearch: string; onAddressSearch: (v: string) => void; addressSearchable: boolean; hasMoreAddresses: boolean; loadingMoreAddresses: boolean; onLoadMoreAddresses: () => void
  addressesComplete: boolean; refetchAddresses: () => void; refresh: () => Promise<unknown>
}) {
  const navigate = useNavigate(), toast = useToast()
  const targetsList = addresses.flatMap(a => [{ value: a.id, label: a.address, expires: !!a.expiresAt }, ...a.aliases.map(alias => ({ value: alias, label: alias, expires: false }))])
  const labelOf = (value: string) => targetsList.find(t => t.value === value)?.label ?? value
  const [made, setMade] = useState<Made[]>([])
  // The overview's copy wins once it lists an endpoint made here: it has the recipient's answer.
  const endpoints = [...overview.endpoints.filter(e => e.source === 'endpoint'), ...made.filter(m => !overview.endpoints.some(e => e.name === m.name))]
  const choices = (f: RecipeField) => endpoints.filter(e => endpointTypes[f.type]!.includes(e.type))
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(recipe.fields.map(f => {
    if (!endpointTypes[f.type]) return [f.name, '']
    const first = choices(f).find(e => e.status === 'ready')
    return [f.name, first?.name ?? NEW]
  })))
  const [urls, setUrls] = useState<Record<string, string>>({})
  // A new rule starts on the address the workspace's rules run on most (else its first permanent one).
  const uses = (value: string) => overview.rules.reduce((n, r) => n + r.attachedTo.filter(t => t === value).length, 0)
  const firstAddress = targetsList.filter(t => !t.expires).reduce<typeof targetsList[number] | undefined>((best, t) => !best || uses(t.value) > uses(best.value) ? t : best, undefined)?.value
  const [targets, setTargets] = useState<string[]>(() => [preset && targetsList.some(t => t.value === preset) ? preset : firstAddress].filter((t): t is string => !!t))
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // The form opens on the cached address list, which can still hold an address or inbox deleted since (by an agent, through
  // the API): once a fresh full read arrives, targets it lacks are dropped, and an emptied list starts on the first address.
  // (ws_b1540cad saved twice on an inbox deleted four minutes before: 422 UNKNOWN_TARGET.)
  useEffect(() => {
    if (!addressesComplete) return
    setTargets(current => { const kept = current.filter(t => targetsList.some(o => o.value === t)); return kept.length === current.length ? current : kept.length ? kept : firstAddress ? [firstAddress] : [] })
  }, [addressesComplete, addresses]) // eslint-disable-line react-hooks/exhaustive-deps
  const [secret, setSecret] = useState<(Endpoint & { secret?: string }) | null>(null)
  // The address made to send a forward's confirmation from, when none could (ForwardSenderOffer).
  const [forwardFrom, setForwardFrom] = useState<string | null>(null)
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
  // A forward its recipient hasn't agreed to yet: the rule saves, and forwards mail received from the moment they do.
  const waiting = recipe.fields.map(f => f.type === 'forward' ? endpoints.find(e => e.name === values[f.name] && e.type === 'forward') : undefined).find(e => e && (e.status === 'pending' || e.status === 'expired'))
  const general = error && !(error instanceof ApiError && (Object.keys(error.fields).some(k => k.startsWith('params.') || k === 'addresses'))) ? errorText(error) : ''

  /** Creates the endpoint a field's "new" option describes, once: a retry after a failed save reuses it. */
  async function createEndpoint(f: RecipeField): Promise<Endpoint & { secret?: string }> {
    const url = urls[f.name]!.trim(), type = targetCheck(f.type, url).type!
    const base = type === 'forward' ? url.split('@')[0]! : labelOf(targets[0] ?? '').split('@')[0] || type
    const name = freeKey(base, taken, 'endpoint')
    const post = (body: Record<string, unknown>) => request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })
    let created: Endpoint & { secret?: string }
    if (type === 'forward') {
      // The API decides: on a domain this workspace verified nobody is asked; anywhere else the recipient agrees first,
      // asked by the address the rule runs on (with none that can, one the API makes).
      const sender = forwardFrom ?? targets[0]
      created = await post({ type, name, address: url, preverify: 'auto', ...(sender ? { from: sender } : { createSender: true }) })
    } else created = await post({ type, name, url })
    setMade(list => [...list, { name: created.name, type: created.type, status: created.status, target: created.target }])
    setValues(v => ({ ...v, [f.name]: created.name })); setUrls(u => ({ ...u, [f.name]: '' }))
    return created
  }
  const save = useSingleFlight('rules.recipe.save', async () => {
    setBusy(true); setError(null)
    try {
      const params: Record<string, string | string[]> = {}
      let webhook: (Endpoint & { secret?: string }) | null = null, asked: string | null = waiting?.target ?? null
      for (const f of recipe.fields) {
        const value = (values[f.name] ?? '').trim()
        if (endpointTypes[f.type] && value === NEW) {
          const created = await createEndpoint(f)
          if (created.secret) webhook = created
          if (created.status === 'pending') asked = created.target
          params[f.name] = created.name
        } else params[f.name] = f.type === 'senders' ? splitSenders(value) : value
      }
      await request('/v1/rules/recipes', { method: 'POST', body: { recipe: recipe.id, params, addresses: targets } })
      await refresh()
      toast(asked ? `${recipe.name} is on. Forwarding starts once ${asked} agrees.` : `${recipe.name} is on`, 'success')
      if (webhook) setSecret(webhook); else navigate(LIST)
    } catch (e) {
      // A target gone since the list was read: read it again, which drops it (above); the message lists the valid ones.
      if (e instanceof ApiError && e.code === 'UNKNOWN_TARGET') refetchAddresses()
      setError(e)
    } finally { setBusy(false) }
  }, recipe.id)
  function submit(event: FormEvent) {
    event.preventDefault(); setTried(true); setError(null)
    const invalid = recipe.fields.some(f => {
      const value = (values[f.name] ?? '').trim()
      if (endpointTypes[f.type]) return !value || (value === NEW && (!(urls[f.name] ?? '').trim() || !!targetCheck(f.type, urls[f.name]!.trim()).error))
      return f.type === 'senders' ? !splitSenders(value).length : !value
    })
    if (invalid || !targets.length) return
    void save()
  }
  const remaining = targetsList.filter(t => !targets.includes(t.value))
  const domains = [...new Set(targets.map(t => labelOf(t).split('@')[1]).filter(Boolean))]
  return <div className="stack inbound-stack recipe-page">
    {header()}
    <form className="recipe-form" onSubmit={submit} noValidate>
      {recipe.decisions && <p className="recipe-ai"><Sparkles size={14} aria-hidden="true" /><span>AI rules are free{domains.length ? <> · reads mail at {domains.join(', ')}</> : null}</span></p>}
      <Field label="Runs on mail to" error={targetsError || undefined}>
        <div className="recipe-targets">
          {targets.map(t => <span key={t} className="recipe-target"><PrivateAddress value={labelOf(t)} /><IconButton size="sm" label="Remove address" onClick={() => setTargets(targets.filter(x => x !== t))} disabled={busy}><X size={13} aria-hidden="true" /></IconButton></span>)}
          {remaining.length > 0 && targets.length < 10 && <Select className="address-select-trigger recipe-targets__add" menuClassName="address-select" aria-label="Add an address" value="" placeholder={targets.length ? 'Add another' : 'Choose an address'}
            onValueChange={v => { if (v) setTargets([...targets, v]) }} options={remaining.map(t => addressOption(t.value, t.label))} />}
        </div>
        {addressesComplete && !targetsList.length && <p className="muted recipe-targets__empty">No addresses yet. <Link to="/receiving?new=address">Create an address</Link> or <Link to="/receiving/inboxes">an agent inbox</Link>, then come back.</p>}
        {addressSearchable && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={addressSearch} onChange={event => onAddressSearch(event.target.value)} />}
        {hasMoreAddresses && <Button variant="ghost" size="sm" loading={loadingMoreAddresses} onClick={onLoadMoreAddresses}>Load more addresses</Button>}
      </Field>
      {recipe.fields.map(f => {
        const err = fieldError(f), id = `recipe-${f.name}`
        if (endpointTypes[f.type]) {
          const list = choices(f), value = values[f.name] ?? NEW
          const opts: SelectOption[] = [...list.map(e => ({ value: e.name, text: e.name, disabled: e.type === 'forward' && e.status === 'declined' && e.name !== value,
            label: <>{e.name}{f.type === 'chat' ? <span className="muted"> · {e.type === 'slack' ? 'Slack' : 'Discord'}</span> : e.type === 'forward' ? <span className="muted"> · <PrivateAddress value={e.target} /></span> : null}</> })),
          { value: NEW, label: newOption[f.type]! }]
          const add = newTarget[f.type]!, url = urls[f.name] ?? ''
          return <div key={f.name} className="stack recipe-field">
            <Field label={f.label} error={value === NEW ? undefined : err || undefined}>
              <Select id={id} value={value} onValueChange={v => { setValues({ ...values, [f.name]: v }); setError(null) }} options={opts} />
            </Field>
            {value === NEW && <Field label={add.label} error={err || undefined}>
              <SecretInput type={f.type === 'forward' ? 'email' : f.type === 'webhook' ? 'url' : 'password'} autoComplete="off" value={url} placeholder={add.placeholder} aria-invalid={!!err || undefined}
                onChange={e => { setUrls({ ...urls, [f.name]: e.target.value }); setError(null) }} />
            </Field>}
          </div>
        }
        const value = values[f.name] ?? ''
        return <Field key={f.name} label={f.label} htmlFor={id} error={err || undefined}>
          {f.type === 'senders'
            ? <Textarea id={id} rows={3} value={value} placeholder={f.placeholder ?? undefined} spellCheck={false} aria-invalid={!!err || undefined} onChange={e => { setValues({ ...values, [f.name]: e.target.value }); setError(null) }} />
            : <Input id={id} value={value} placeholder={f.placeholder ?? undefined} autoComplete="off" aria-invalid={!!err || undefined} onChange={e => { setValues({ ...values, [f.name]: f.type === 'label' ? e.target.value.toLowerCase().replace(/\s+/g, '-') : e.target.value }); setError(null) }} />}
        </Field>
      })}
      {waiting && <AwaitingConfirm address={waiting.target} />}
      {general && !forwardSenderNeeded(error) && <Alert tone="danger">{general}</Alert>}
      <ForwardSenderOffer error={error} onCreated={box => { setForwardFrom(box.id); setError(null); refetchAddresses(); return save() }} />
      <div className="recipe-form__actions">
        <Link className="ui-button ui-button--ghost ui-button--md" to={back}>Cancel</Link>
        <Button variant="primary" type="submit" loading={busy}>Save</Button>
      </div>
    </form>
    <CreatedEndpointDialog created={secret} writeRule={false} onClose={() => { setSecret(null); navigate(LIST) }} />
  </div>
}
