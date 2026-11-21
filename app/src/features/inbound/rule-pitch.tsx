// PITCH ONLY (branch pitch/rule-page): three takes on one rule's page, behind ?v=a|b|c on /receiving/rules/:key and
// /receiving/rules/:key/code. Every version is one page for every kind of rule (no separate form and code pages), keeps
// code one click away and reads and writes the public API only.
//   A · Sentence: the rule as one When / If / Then sentence whose blanks are the controls, a test line under it.
//   B · Workbench: the rule on the left, its result on each recent email on the right, rerun on every change.
//   C · Inspector: short rows (Runs on, Looks like, Posts to…), each opened and saved in its own sheet.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Check, ChevronRight, CodeXml, Minus, Plus, Sparkles, X } from 'lucide-react'
import { Alert, Button, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, PageHeader, Select, Switch, Tabs, Textarea, useToast, type MenuItem, type SelectOption } from '../../components/ui'
import { Skeleton } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import { errorText } from '../../data/types'
import { staleAfterWrite } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { usePhone } from '../../lib/media'
import { ownRecipient, type ReceivedRecipients } from '../../lib/private-address'
import { buildRecipe, ritualRecipes, splitTests, type RecipeField, type RitualRecipe } from '../../../../api/src/ritual-schema'
import { ago, firstOverview, useOverview, type OverviewEndpoint } from './overview'
import { Editor } from './rituals'
import { Match, TargetIcon } from './parts'
import { addressOption, when } from './shared'
import type { DryRun } from './trace'
import './inbound.css'
import './receiving.css'
import './recipes.css'
import './rule-pitch.css'

type Binding = { rule: string; target: string; continue: boolean }
type RuleDef = { key: string; source: string; recipe?: { id: string; params: Record<string, string | string[]> }; enabled?: boolean }
type Config = { rules: RuleDef[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Received = ReceivedRecipients & { id: string; from: { name: string | null; address: string }; subject: string; at: string }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }
type Problem = { line: number; column: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[] }
type EndpointType = OverviewEndpoint['type']
const LIST = '/receiving?tab=rules'
const NEW = '+new'

/** The pitch's version for this URL, or null for today's page. */
export const pitchVersion = (search: string) => { const v = new URLSearchParams(search).get('v'); return v === 'a' || v === 'b' || v === 'c' ? v : null }

// ---------------------------------------------------------------- words
/** A recipe as When / If / Then parts; {field} is a blank. Scripts have none: their If / Then is the code. */
const parts: Record<string, { if?: string; then: string; otherwise?: string }> = {
  'alert-by-meaning': { if: 'it looks like {meaning}', then: 'post it to {channel}' },
  'label-by-meaning': { if: 'it looks like {meaning}', then: 'label it {label}' },
  'split-by-meaning': { if: 'it looks like {meaning}', then: 'send it to {then}', otherwise: 'send it to {otherwise}' },
  split: { if: '{test} {value}', then: 'send it to {then}', otherwise: 'send it to {otherwise}' },
  slack: { then: 'post it to {channel}' },
  discord: { then: 'post it to {channel}' },
  forward: { then: 'forward it to {to}' },
  webhook: { then: 'send it to {app}' },
  'junk-newsletters': { if: 'it’s a newsletter', then: 'mark it as junk' },
  'block-senders': { if: 'it’s from {senders}', then: 'reject it' },
  'allow-senders': { if: 'it’s from {senders}', then: 'never mark it as junk' },
  'junk-failed-dmarc': { if: 'it fails DMARC', then: 'mark it as junk' },
}
const fieldLabels: Partial<Record<RecipeField['type'], string>> = { meaning: 'Looks like', slack: 'Posts to', discord: 'Posts to', chat: 'Posts to', forward: 'Forwards to', webhook: 'Sends to', label: 'Label', senders: 'From', test: 'If', words: 'Mentions' }
const fieldLabel = (f: RecipeField) => f.name === 'otherwise' ? 'Otherwise' : f.type === 'destination' ? 'Sends to' : fieldLabels[f.type] ?? f.label
const endpointTypes: Partial<Record<RecipeField['type'], EndpointType[]>> = { slack: ['slack'], discord: ['discord'], chat: ['slack', 'discord'], forward: ['forward'], webhook: ['webhook'], destination: ['slack', 'discord', 'webhook', 'forward'] }
const typeWord: Record<EndpointType, string> = { slack: 'Slack', discord: 'Discord', webhook: 'Webhook', forward: 'Forward' }
const testWords: Record<string, string> = { always: 'it’s any mail', from: 'it’s from', subject: 'the subject mentions', text: 'it mentions', attachment: 'it has an attachment' }
const others = { next: 'Still run', stop: 'Skipped when it acts' }
const newWording = 'Tested with the old wording’s AI answers until new mail'
const strParams = (p?: Record<string, string | string[]>) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const ordinal = (n: number) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th')

function actionWords(a: { op: string; ref?: string; value?: string }, endpoints: OverviewEndpoint[]) {
  if (a.ref?.startsWith('endpoint:')) {
    const name = a.ref.slice(9), e = endpoints.find(x => x.source === 'endpoint' && x.name === name)
    return e?.type === 'slack' || e?.type === 'discord' ? `Posts to ${name} in ${typeWord[e.type]}` : e?.type === 'forward' ? `Forwards to ${name}` : `Sends to ${name}`
  }
  if (a.ref?.startsWith('inbox:')) return `Delivers to the ${a.ref.slice(6)} inbox`
  return ({ label: `Labels it ${a.value ?? ''}`, junk: 'Marks it as junk', block: 'Rejects it', drop: 'Drops it', allow: 'Keeps it out of junk' } as Record<string, string>)[a.op] ?? a.op
}
type Outcome = { acted: boolean; words: string; ai?: number; error?: string }
function outcomeOf(r: DryRun | undefined, key: string, endpoints: OverviewEndpoint[]): Outcome | null {
  if (!r) return null
  const row = r.trace.find(t => t.key === key)
  if (!row) return { acted: false, words: 'Didn’t run' }
  const ai = Object.values(row.scores).find((v): v is number => typeof v === 'number')
  if (row.error) return { acted: false, words: 'Stopped with an error', error: row.error, ai }
  const acts = row.actions.map(a => actionWords(a, endpoints))
  return { acted: acts.length > 0, words: acts.length ? acts.join(' · ') : 'Does nothing', ai }
}

/** What the AI answered, in words: "Looks like a refund request · AI 94%". */
const aiWords = (ai: number, meaning: string) => (ai >= 0.7 ? 'Looks like ' : 'Doesn’t look like ') + meaning + ' · AI ' + Math.round(ai * 100) + '%'

// ---------------------------------------------------------------- state shared by the three versions
function useRulePage(key: string) {
  const client = useQueryClient(), toast = useToast(), navigate = useNavigate()
  const overview = useOverview(firstOverview)
  const options = useApiDef(queries.inboundAddressOptions())
  const recent = useApiQuery(['pitch-recent'], (_api, signal) => request<{ data: Received[] }>('/v1/logs?direction=received&limit=12', { signal }).then(r => r.data))
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [params, setParams] = useState<Record<string, string>>({})
  const [targets, setTargets] = useState<string[]>([])
  const [after, setAfter] = useState(true)
  const [source, setSource] = useState('')
  const [code, setCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState<RecipeField | null>(null)
  const [completions, setCompletions] = useState<Completion[]>([])
  const [check, setCheck] = useState<Check | null>(null)

  const rule = saved?.config.rules.find(r => r.key === key)
  const recipe: RitualRecipe | undefined = rule?.recipe ? ritualRecipes.find(r => r.id === rule.recipe!.id) : undefined
  const mine = useMemo(() => (saved?.config.attachments ?? []).filter(b => b.rule === key), [saved, key])
  const savedAfter = mine.length ? mine.every(b => b.continue) : true
  function reset(s: Saved) {
    const r = s.config.rules.find(x => x.key === key)
    const m = s.config.attachments.filter(b => b.rule === key)
    setParams(strParams(r?.recipe?.params)); setTargets(m.map(b => b.target)); setAfter(m.length ? m.every(b => b.continue) : true)
    setSource(r?.source ?? ''); setEnabled(r?.enabled !== false); setCode(!r?.recipe)
  }
  useEffect(() => {
    const ac = new AbortController()
    request<Saved>('/v1/rules', { signal: ac.signal }).then(s => { setSaved(s); reset(s) }, e => { if (!ac.signal.aborted) setLoadError(e) })
    request<{ completions: Completion[] }>('/v1/rules/typings', { signal: ac.signal }).then(t => setCompletions(t.completions), () => {})
    return () => ac.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const endpoints = overview.data?.endpoints ?? []
  const kind = (name: string) => endpoints.find(e => e.source === 'endpoint' && e.name === name)?.type
  const built = recipe && overview.data ? buildRecipe(recipe.id, params, kind) : null
  const sourceEdited = !!rule && source !== rule.source
  // Code wins once it was edited by hand; until then a recipe's script is what its blanks write.
  const draftSource = sourceEdited || !recipe ? source : built?.ok ? built.source : rule?.source ?? ''
  const paramsChanged = !!rule && !same(params, strParams(rule.recipe?.params))
  const targetsChanged = !same(targets, mine.map(b => b.target))
  const dirty = !!rule && (paramsChanged || targetsChanged || after !== savedAfter || sourceEdited)
  const opts = options.data ?? []
  const addressOf = (t: string) => opts.find(o => o.id === t)?.address ?? t
  const status = busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'

  const refresh = () => void client.invalidateQueries({ predicate: q => staleAfterWrite(q.queryKey, false) }).catch(() => {})
  const reread = async () => { const s = await request<Saved>('/v1/rules'); setSaved(s); refresh(); return s }
  /** This rule's attachments as the draft has them: kept ones keep their place, new ones run last on their address. */
  const nextAttachments = (list: Binding[]) => [
    ...list.filter(b => b.rule !== key || targets.includes(b.target)).map(b => b.rule === key ? { ...b, continue: after } : b),
    ...targets.filter(t => !list.some(b => b.rule === key && b.target === t)).map(t => ({ rule: key, target: t, continue: after })),
  ]
  async function save() {
    if (!saved || !rule || busy) return false
    setBusy(true)
    try {
      let s = saved
      if (sourceEdited || !recipe) {
        s = await request<Saved>('/v1/rules', { method: 'PUT', ifMatch: s.version, body: { ...s.config, rules: s.config.rules.map(r => r.key === key ? { key, source: draftSource, ...(r.enabled === false ? { enabled: false } : {}) } : r), attachments: nextAttachments(s.config.attachments) } })
      } else {
        if (paramsChanged || targetsChanged) {
          if (!built?.ok) throw new Error(built?.message ?? 'Fill in every blank.')
          await request('/v1/rules/scripts/' + encodeURIComponent(key) + '/recipe', { method: 'PUT', body: { params: built.params, addresses: targets } })
          s = await request<Saved>('/v1/rules')
        }
        if (s.config.attachments.some(b => b.rule === key && b.continue !== after)) s = await request<Saved>('/v1/rules/attachments', { method: 'PUT', ifMatch: s.version, body: { attachments: s.config.attachments.map(b => b.rule === key ? { ...b, continue: after } : b) } })
      }
      setSaved(s); reset(s); refresh(); toast(key + ' saved', 'success')
      return true
    } catch (e) { toast('Not saved: ' + errorText(e), 'error'); return false }
    finally { setBusy(false) }
  }
  async function toggle(v: boolean) {
    setEnabled(v)
    try { await request('/v1/rules/scripts/' + encodeURIComponent(key), { method: 'PATCH', body: { enabled: v } }); await reread(); toast(key + (v ? ' is on' : ' is off'), 'success') }
    catch (e) { setEnabled(!v); toast(errorText(e), 'error') }
  }
  /** Where this rule runs on one address, among that address's rules. */
  const placeOn = (target: string) => {
    const list = (saved?.config.attachments ?? []).filter(b => b.target === target)
    const at = list.findIndex(b => b.rule === key)
    return { place: at + 1, of: list.length, keys: list.map(b => b.rule) }
  }
  async function move(target: string, by: -1 | 1) {
    if (!saved) return
    const all = [...saved.config.attachments], idx = all.map((b, i) => ({ b, i })).filter(x => x.b.target === target), at = idx.findIndex(x => x.b.rule === key), other = idx[at + by]
    if (at < 0 || !other) return
    const i = idx[at]!.i; [all[i], all[other.i]] = [all[other.i]!, all[i]!]
    try { const s = await request<Saved>('/v1/rules/attachments', { method: 'PUT', ifMatch: saved.version, body: { attachments: all } }); setSaved(s); refresh(); toast('Moved ' + (by < 0 ? 'earlier' : 'later') + ' on ' + addressOf(target), 'success') }
    catch (e) { toast(errorText(e), 'error') }
  }
  async function remove() {
    await request('/v1/rules/scripts/' + encodeURIComponent(key), { method: 'DELETE', ...(saved ? { ifMatch: saved.version } : {}) })
    refresh(); toast(key + ' deleted', 'success'); navigate(LIST, { replace: true })
  }
  async function lint(text: string) {
    try { const r = await request<Check>('/v1/rules/check', { method: 'POST', body: { source: text, key, senderLists: saved?.config.senderLists ?? {} } }); setCheck(r); return r.diagnostics }
    catch { return [] }
  }
  function openCode(on: boolean) { if (on && !sourceEdited) setSource(draftSource); setCode(on) }

  // Recent mail to this rule's addresses first (else any recent mail): what a test runs on.
  const watched = new Set(targets.flatMap(t => { const o = opts.find(x => x.id === t); return o ? [o.address, ...o.aliases] : [t] }))
  const emails = useMemo(() => { const all = recent.data ?? [], seen = new Set<string>(); const ours = all.filter(m => watched.has(ownRecipient(m) ?? '')); return (ours.length ? ours : all).filter(m => { const s = m.subject.replace(/^(re|fwd?):\s*/i, '').toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true }).slice(0, 6) }, [recent.data, [...watched].join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const question = recipe?.decisions && built?.ok && typeof built.params.meaning === 'string' ? 'Does this email look like ' + built.params.meaning + '?' : null
  const meaningChanged = !!recipe?.decisions && params.meaning !== strParams(rule?.recipe?.params).meaning

  /** Dry runs this rule (unsaved, on, as if on the address the mail went to) on each email, again 350 ms after a change.
   *  A test never asks the AI: a stored email brings the answer the AI gave when it arrived. A new wording has no answer
   *  yet, so it is tested with the answers to the saved wording (kept from the first run). */
  function useTests(list: Received[]) {
    const [results, setResults] = useState<Record<string, { result?: DryRun; error?: string }>>({})
    const [pending, setPending] = useState(false)
    const known = useRef<Record<string, number>>({})
    const signature = JSON.stringify([draftSource, list.map(m => m.id), !!saved])
    useEffect(() => {
      if (!saved || !draftSource || !list.length) return
      const ac = new AbortController()
      setPending(true)
      const timer = setTimeout(() => {
        void Promise.allSettled(list.map(m => {
          const to = ownRecipient(m) ?? m.to[0] ?? ''
          const config = { ...saved.config, rules: saved.config.rules.map(r => r.key === key ? { key, source: draftSource, enabled: true } : r), attachments: [{ rule: key, target: to, continue: false }] }
          return request<DryRun>('/v1/rules/test', { method: 'POST', signal: ac.signal, body: { messageId: m.id, to: [to], config, ...(meaningChanged && question ? { scores: { [question]: known.current[m.id] ?? 0 } } : {}) } })
            .then(result => {
              const ai = Object.values(result.trace.find(t => t.key === key)?.scores ?? {}).find((v): v is number => typeof v === 'number')
              if (!meaningChanged && ai !== undefined) known.current[m.id] = ai
              setResults(x => ({ ...x, [m.id]: { result } }))
            }, e => { if (!ac.signal.aborted) setResults(x => ({ ...x, [m.id]: { error: errorText(e) } })) })
        })).then(() => { if (!ac.signal.aborted) setPending(false) })
      }, 350)
      return () => { clearTimeout(timer); ac.abort() }
    }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
    return { results, pending, outcome: (id: string) => outcomeOf(results[id]?.result, key, endpoints), error: (id: string) => results[id]?.error }
  }

  return {
    key, saved, loadError, rule, recipe, overview, options: opts, endpoints, params, setParam: (name: string, value: string) => setParams(p => ({ ...p, [name]: value })),
    targets, setTargets, after, setAfter, source, setSource, code, openCode, busy, enabled, toggle, dirty, status, save, discard: () => { if (saved) reset(saved) },
    addressOf, placeOn, move, deleting, setDeleting, remove, creating, setCreating, completions, lint, check, draftSource, built, emails, recentReady: !!recent.data,
    useTests, meaningChanged, lastActed: overview.data?.rules.find(r => r.key === key)?.lastMatchedAt ?? null,
  }
}
type Page = ReturnType<typeof useRulePage>

// ---------------------------------------------------------------- shared controls
function destinationOptions(p: Page, f: RecipeField): SelectOption[] {
  const types = endpointTypes[f.type] ?? []
  const list = p.endpoints.filter(e => e.source === 'endpoint' && types.includes(e.type))
  return [
    ...list.map(e => ({ value: e.name, text: e.name + ' ' + typeWord[e.type], label: <span className="rp-dest"><TargetIcon type={e.type} size={13} />{e.name}<span className="muted">{typeWord[e.type]}</span></span> })),
    ...(f.type === 'destination' ? [{ value: 'store', label: 'Keep it' }, { value: 'drop', label: 'Drop it' }] : []),
    ...(f.type !== 'forward' ? [{ value: NEW, text: 'New channel', label: <span className="rp-dest"><Plus size={13} className="rcv-icon" aria-hidden="true" />New channel</span> }] : []),
  ]
}
/** One blank's control in a form: B's fields and C's sheets. */
function FieldControl({ p, f, id }: { p: Page; f: RecipeField; id?: string }) {
  const value = p.params[f.name] ?? ''
  if (endpointTypes[f.type]) return <Select id={id} aria-label={fieldLabel(f)} value={value} onValueChange={v => v === NEW ? p.setCreating(f) : p.setParam(f.name, v)} options={destinationOptions(p, f)} />
  if (f.type === 'test') return <Select id={id} aria-label="If" value={value} onValueChange={v => p.setParam(f.name, v)} options={splitTests.map(t => ({ value: t, label: testWords[t]! }))} />
  if (f.type === 'senders') return <Textarea id={id} rows={2} value={value} spellCheck={false} placeholder={f.placeholder} onChange={e => p.setParam(f.name, e.target.value)} />
  return <Input id={id} value={value} placeholder={f.placeholder} autoComplete="off" onChange={e => p.setParam(f.name, e.target.value)} />
}
/** The addresses it runs on as removable chips, and a picker for one more. */
function AddressChips({ p, token = false }: { p: Page; token?: boolean }) {
  const remaining = p.options.filter(o => !o.expiresAt && !p.targets.includes(o.id))
  return <span className="rp-chips">
    {p.targets.map(t => token
      ? <AddressToken key={t} p={p} target={t} />
      : <span key={t} className="rp-chip"><Match value={p.addressOf(t)} /><button type="button" className="rp-chip__x" aria-label={'Remove ' + p.addressOf(t)} onClick={() => p.setTargets(p.targets.filter(x => x !== t))}><X size={12} aria-hidden="true" /></button></span>)}
    {remaining.length > 0 && <Select className={token ? 'rp-token rp-token--add' : 'rp-chips__add'} aria-label="Add an address" value="" placeholder={token ? 'add' : 'Add an address'}
      onValueChange={v => { if (v) p.setTargets([...p.targets, v]) }} options={remaining.map(o => addressOption(o.id, o.address))} />}
  </span>
}
/** A: an address in the sentence. Its menu holds where it runs among that address's rules, and Remove. */
function AddressToken({ p, target }: { p: Page; target: string }) {
  const { place, of } = p.placeOn(target)
  const items: MenuItem[] = [
    ...(place > 1 ? [{ label: 'Run earlier', icon: <ArrowUp size={14} />, onSelect: () => void p.move(target, -1) }] : []),
    ...(place > 0 && place < of ? [{ label: 'Run later', icon: <ArrowDown size={14} />, onSelect: () => void p.move(target, 1) }] : []),
    { label: 'Remove', destructive: true, onSelect: () => p.setTargets(p.targets.filter(x => x !== target)) },
  ]
  return <DropdownMenu label={p.addressOf(target) + ' options'} align="start" title={<>{place > 0 ? ordinal(place) + ' of ' + of + ' rules on ' : 'New on '}<PrivateAddress value={p.addressOf(target)} /></>} items={items}
    trigger={<button type="button" className="rp-token rp-token--address"><Match value={p.addressOf(target)} /></button>} />
}
function CodeBox({ p, tall = false }: { p: Page; tall?: boolean }) {
  const first = p.check?.diagnostics[0]
  return <div className="rp-code" data-tall={tall || undefined}>
    <Editor value={p.source} change={p.setSource} completions={p.completions} check={p.lint} />
    <p className={p.check && !p.check.ok ? 'rp-code__status ritual-error' : 'rp-code__status muted'}>{p.check === null ? 'Checking…' : first ? 'Line ' + first.line + ': ' + first.message : 'No problems'}</p>
  </div>
}
function NewDestination({ p }: { p: Page }) {
  const [url, setUrl] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const f = p.creating
  const type: EndpointType = /discord(app)?\.com\/api\/webhooks/.test(url) ? 'discord' : /hooks\.slack\.com/.test(url) ? 'slack' : 'webhook'
  async function create() {
    if (!f) return
    setBusy(true); setError('')
    try {
      const made = await request<{ name: string }>('/v1/endpoints', { method: 'POST', body: { type, name: name || type, url } })
      await p.overview.refetch(); p.setParam(f.name, made.name); p.setCreating(null); setUrl(''); setName('')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog open={!!f} onOpenChange={o => { if (!o) p.setCreating(null) }} title="New channel"
    footer={<><Button onClick={() => p.setCreating(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!url} onClick={() => void create()}>Add</Button></>}>
    <div className="stack">
      <Field label="Webhook URL"><Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" /></Field>
      <Field label="Name"><Input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} placeholder="refunds" /></Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  </Dialog>
}
const AiMark = () => <span className="rp-ai" title="Nightmail’s AI reads each email. AI rules are free."><Sparkles size={13} aria-hidden="true" />AI</span>
function Menu({ p }: { p: Page }) {
  const items: MenuItem[] = [
    ...(p.recipe ? [{ label: p.code ? 'Edit in plain words' : 'Edit as code', icon: <CodeXml size={14} />, onSelect: () => p.openCode(!p.code) }] : []),
    { label: 'Delete rule', destructive: true, onSelect: () => p.setDeleting(true) },
  ]
  return <DropdownMenu label={'Actions for ' + p.key} items={items} />
}
function Shared({ p }: { p: Page }) {
  const n = p.targets.length
  return <>
    <NewDestination p={p} />
    <ConfirmDialog open={p.deleting} onOpenChange={p.setDeleting} danger title={'Delete ' + p.key + '?'} description={'It stops running on ' + (n === 1 ? 'its address' : 'its ' + n + ' addresses') + '.'} confirmLabel="Delete rule" onConfirm={p.remove} />
  </>
}

// ---------------------------------------------------------------- A · Sentence
function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rp-a__line"><span className="rp-label">{label}</span><div className="rp-a__words">{children}</div></div>
}
/** A recipe's part with each blank as an inline control. */
function Blanks({ p, template }: { p: Page; template: string }) {
  return <>{template.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1], f = name ? p.recipe?.fields.find(x => x.name === name) : undefined
    if (!f) return part ? <span key={i}>{part}</span> : null
    const value = p.params[f.name] ?? ''
    if (endpointTypes[f.type] || f.type === 'test') return <Fragment key={i}><FieldToken p={p} f={f} /></Fragment>
    return <input key={i} className="rp-token rp-token--text" aria-label={fieldLabel(f)} value={value} placeholder={f.placeholder ?? fieldLabel(f).toLowerCase()} size={Math.max(4, (value || f.placeholder || '').length)} spellCheck={false} autoComplete="off" onChange={e => p.setParam(f.name, e.target.value)} />
  })}</>
}
function FieldToken({ p, f }: { p: Page; f: RecipeField }) {
  const value = p.params[f.name] ?? ''
  if (f.type === 'test') return <Select className="rp-token" aria-label="If" value={value} onValueChange={v => p.setParam(f.name, v)} options={splitTests.map(t => ({ value: t, label: testWords[t]! }))} />
  return <Select className="rp-token" aria-label={fieldLabel(f)} value={value} onValueChange={v => v === NEW ? p.setCreating(f) : p.setParam(f.name, v)} options={destinationOptions(p, f)} />
}
function ResultLine({ p, outcome, error, email }: { p: Page; outcome: Outcome | null; error?: string; email?: Received }) {
  if (error) return <p className="rp-result ritual-error">{error}</p>
  if (!email) return <p className="rp-result muted">No mail yet</p>
  return <p className="rp-result" data-acted={outcome?.acted || undefined}>
    <span className="rp-result__mark" aria-hidden="true">{outcome ? outcome.acted ? <Check size={14} /> : <Minus size={14} /> : null}</span>
    <span className="rp-result__words">{outcome ? outcome.words : 'Running…'}</span>
    {p.recipe?.decisions && !p.code && outcome?.ai !== undefined && <span className="rp-result__ai muted">{aiWords(outcome.ai, p.built?.ok ? String(p.built.params.meaning ?? '') : '')}</span>}
  </p>
}
function SentenceVersion({ p }: { p: Page }) {
  const words = p.recipe ? parts[p.recipe.id] : undefined
  const [picked, setPicked] = useState('')
  const tests = p.useTests(p.emails)
  const counted = p.emails.length > 0 && p.emails.every(m => tests.outcome(m.id) || tests.error(m.id))
  // Starts on the newest email it acts on, so the sentence above is shown doing its job.
  const email = p.emails.find(m => m.id === picked) ?? p.emails.find(m => tests.outcome(m.id)?.acted) ?? p.emails[0]
  return <div className="stack inbound-stack rp rp-a">
    <PageHeader title={p.key} backTo={LIST} actions={<><Switch checked={p.enabled} onCheckedChange={v => void p.toggle(v)} label="On" /><Menu p={p} /></>} />
    <section className="rp-a__sentence" aria-label="What it does">
      <Line label="When">mail arrives at <AddressChips p={p} token /></Line>
      {p.code || !words ? <div className="rp-a__line rp-a__line--code"><span className="rp-label">Code</span><CodeBox p={p} /></div> : <>
        {words.if && <Line label="If"><Blanks p={p} template={words.if} />{p.recipe?.decisions && <AiMark />}</Line>}
        <Line label="Then"><Blanks p={p} template={words.then} /></Line>
        {words.otherwise && <Line label="Else"><Blanks p={p} template={words.otherwise} /></Line>}
      </>}
      <Line label="After">other rules <Select className="rp-token" aria-label="Other rules" value={p.after ? 'next' : 'stop'} onValueChange={v => p.setAfter(v === 'next')} options={[{ value: 'next', label: 'still run' }, { value: 'stop', label: 'are skipped when it acts' }]} /></Line>
      <footer className="rp-a__foot">
        <span className="rp-status" data-dirty={p.dirty || undefined}>{p.status}</span>
        <div className="cluster"><Button variant="ghost" data-hidden={!p.dirty || undefined} className="rp-hide" disabled={!p.dirty || p.busy} onClick={p.discard}>Discard</Button><Button variant="primary" loading={p.busy} disabled={!p.dirty} onClick={() => void p.save()}>Save</Button></div>
      </footer>
    </section>
    <section className="rp-a__try" aria-label="Try it">
      <div className="rp-a__tryline">
        <span className="rp-label">Try on</span>
        {p.emails.length ? <Select className="rp-a__email" aria-label="Email to try" value={counted || picked ? email?.id ?? '' : ''} placeholder="Recent mail" disabled={!counted && !picked} onValueChange={setPicked}
          options={p.emails.map(m => ({ value: m.id, text: m.subject, label: <span className="rp-email"><span className="rp-email__subject">{m.subject || '(no subject)'}</span><span className="muted">{(m.from.name ?? m.from.address) + ' · ' + when(m.at)}</span></span> }))} /> : <Skeleton width={280} height={28} />}
      </div>
      {counted || picked ? <ResultLine p={p} email={email} outcome={email ? tests.outcome(email.id) : null} error={email ? tests.error(email.id) : undefined} /> : <p className="rp-result" aria-hidden="true"> </p>}
      {p.meaningChanged && <div className="rp-assume muted">{newWording}</div>}
    </section>
    <Shared p={p} />
  </div>
}

// ---------------------------------------------------------------- B · Workbench
function WorkbenchVersion({ p }: { p: Page }) {
  const phone = usePhone()
  const [pane, setPane] = useState<'rule' | 'test'>('rule')
  const tests = p.useTests(p.emails)
  const [open, setOpen] = useState<string | null>(null)
  const acted = p.emails.filter(m => tests.outcome(m.id)?.acted).length
  const counted = p.emails.length > 0 && p.emails.every(m => tests.outcome(m.id) || tests.error(m.id))
  // Opens on the newest email it acts on, once every first run is in: the list arrives in its final shape.
  const shown = open ?? p.emails.find(m => tests.outcome(m.id)?.acted)?.id ?? p.emails[0]?.id ?? null
  const rule = <section className="rp-b__pane" aria-label="Rule" hidden={phone && pane !== 'rule'}>
    <div className="rp-b__head" hidden={phone}>
      {p.recipe ? <Tabs label="Edit as" value={p.code ? 'code' : 'simple'} onValueChange={v => p.openCode(v === 'code')} items={[{ value: 'simple', label: 'Simple' }, { value: 'code', label: 'Code' }]} /> : <span className="rp-label">Code</span>}
    </div>
    <div className="rp-b__form">
      <Field label="Mail to"><AddressChips p={p} /></Field>
      {p.code || !p.recipe ? <CodeBox p={p} tall /> : p.recipe.fields.map(f => <Field key={f.name} htmlFor={'rp-b-' + f.name} label={<span className="rp-b__label">{fieldLabel(f)}{f.type === 'meaning' && <AiMark />}</span>}><FieldControl p={p} f={f} id={'rp-b-' + f.name} /></Field>)}
      <Field label="Other rules on these addresses" htmlFor="rp-b-after"><Select id="rp-b-after" value={p.after ? 'next' : 'stop'} onValueChange={v => p.setAfter(v === 'next')} options={[{ value: 'next', label: others.next }, { value: 'stop', label: others.stop }]} /></Field>
    </div>
  </section>
  const test = <section className="rp-b__pane rp-b__pane--test" aria-label="Test" hidden={phone && pane !== 'test'}>
    <div className="rp-b__head">
      <span className="rp-label">Recent mail</span>
      <span className="rp-b__count" data-pending={tests.pending || undefined}>{counted ? 'Acts on ' + acted + ' of ' + p.emails.length : ' '}</span>
    </div>
    {p.meaningChanged && <div className="rp-assume muted">{newWording}</div>}
    {!counted && <ul className="rp-b__mail" aria-hidden="true">{p.emails.map(m => <li key={m.id}><div className="rp-b__row"><span /><span className="rp-b__msg"><Skeleton width="60%" height={13} /><Skeleton width="30%" height={11} /></span></div></li>)}</ul>}
    {counted && <ul className="rp-b__mail" role="list">{p.emails.map(m => {
      const o = tests.outcome(m.id), err = tests.error(m.id), isOpen = shown === m.id
      return <li key={m.id} data-open={isOpen || undefined}>
        <button type="button" className="rp-b__row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : m.id)}>
          <span className="rp-b__mark" data-acted={o?.acted || undefined} aria-hidden="true">{o ? o.acted ? <Check size={13} /> : <Minus size={13} /> : null}</span>
          <span className="rp-b__msg"><span className="rp-b__subject">{m.subject || '(no subject)'}</span><span className="rp-b__from muted">{m.from.name ?? m.from.address}</span></span>
          {p.recipe?.decisions && <span className="rp-b__ai" title="The AI’s answer when this email arrived">{o?.ai !== undefined && <><span className="rp-meter" aria-hidden="true"><span style={{ transform: 'scaleX(' + o.ai + ')' }} /></span><span className="rp-b__pct">{Math.round(o.ai * 100)}%</span></>}</span>}
          <span className="rp-b__result" data-acted={o?.acted || undefined}>{err ? 'Error' : o ? o.acted ? o.words : '—' : ''}</span>
          <time className="rp-b__time muted">{when(m.at)}</time>
        </button>
        {isOpen && <ol className="rp-b__steps">
          <li><span className="rp-label">To</span><Match value={ownRecipient(m) ?? m.to[0] ?? ''} /></li>
          {p.recipe?.decisions && !p.code && <li><span className="rp-label">If</span><span>{o?.ai !== undefined ? aiWords(o.ai, p.built?.ok ? String(p.built.params.meaning ?? '') : '') : '…'}</span><span className="muted">{o?.ai !== undefined ? 'needs 70%' : ''}</span></li>}
          <li><span className="rp-label">Then</span><span>{err ?? o?.error ?? o?.words ?? '…'}</span></li>
          <li><span className="rp-label">After</span><span>{o?.acted ? p.after ? 'Other rules still run' : 'Other rules are skipped' : 'Other rules run'}</span></li>
        </ol>}
      </li>
    })}</ul>}
  </section>
  return <div className="stack inbound-stack rp rp-b">
    <PageHeader title={p.key} backTo={LIST} actions={<>
      <Button variant="ghost" data-hidden={!p.dirty || undefined} className="rp-hide" disabled={!p.dirty || p.busy} onClick={p.discard}>Discard</Button>
      <span className="rp-status" data-dirty={p.dirty || undefined}>{p.status}</span>
      <Button variant="primary" loading={p.busy} disabled={!p.dirty} onClick={() => void p.save()}>Save</Button>
      <Switch checked={p.enabled} onCheckedChange={v => void p.toggle(v)} label="On" />
      <Menu p={p} />
    </>} />
    {phone && <Tabs label="Show" value={pane === 'test' ? 'test' : p.code ? 'code' : 'simple'} onValueChange={v => { if (v === 'test') setPane('test'); else { setPane('rule'); if (p.recipe) p.openCode(v === 'code') } }}
      items={[...(p.recipe ? [{ value: 'simple', label: 'Simple' }] : []), { value: 'code', label: 'Code' }, { value: 'test', label: counted ? 'Test · ' + acted + ' of ' + p.emails.length : 'Test' }]} />}
    <div className="rp-b__panes">{rule}{test}</div>
    <Shared p={p} />
  </div>
}

// ---------------------------------------------------------------- C · Inspector
type SheetName = null | 'addresses' | 'after' | 'code' | 'test' | 'order' | `field:${string}`
function Row({ label, value, onClick, danger, icon, tall }: { label: string; value?: ReactNode; onClick: () => void; danger?: boolean; icon?: ReactNode; tall?: boolean }) {
  return <li><button type="button" className="rp-c__row" data-danger={danger || undefined} data-tall={tall || undefined} onClick={onClick}>
    <span className="rp-c__label">{icon}{label}</span><span className="rp-c__value">{typeof value === 'string' ? <span className="rp-c__clip">{value}</span> : value}</span>{!danger && <ChevronRight size={15} className="rp-c__chev" aria-hidden="true" />}
  </button></li>
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rp-c__group" aria-label={title}><h2 className="rp-label">{title}</h2><ul className="rp-c__rows" role="list">{children}</ul></section>
}
function valueOf(p: Page, f: RecipeField): ReactNode {
  const v = p.params[f.name] ?? ''
  if (endpointTypes[f.type]) { const e = p.endpoints.find(x => x.source === 'endpoint' && x.name === v); return e ? <span className="rp-dest"><TargetIcon type={e.type} size={13} />{e.name}<span className="muted">{typeWord[e.type]}</span></span> : v === 'store' ? 'Keep it' : v === 'drop' ? 'Drop it' : v }
  if (f.type === 'test') return testWords[v] ?? v
  return v || <span className="muted">Not set</span>
}
function InspectorVersion({ p }: { p: Page }) {
  const [sheet, setSheet] = useState<SheetName>(null)
  const opener = useRef<HTMLElement | null>(null)
  const tests = p.useTests(p.emails)
  const last = p.emails.find(m => tests.outcome(m.id)?.acted) ?? p.emails[0], lastOutcome = last ? tests.outcome(last.id) : null
  const acted = p.emails.filter(m => tests.outcome(m.id)?.acted).length
  const counted = p.emails.length > 0 && p.emails.every(m => tests.outcome(m.id) || tests.error(m.id))
  const open = (s: SheetName) => { opener.current = document.activeElement as HTMLElement; setSheet(s) }
  const close = () => { p.discard(); setSheet(null) }
  const done = async () => { if (!p.dirty || await p.save()) setSheet(null) }
  const field = sheet?.startsWith('field:') ? p.recipe?.fields.find(f => f.name === sheet.slice(6)) : undefined
  const footer = <><Button onClick={close}>Cancel</Button><Button variant="primary" loading={p.busy} disabled={!p.dirty} onClick={() => void done()}>Save</Button></>
  const n = p.targets.length
  const places = p.targets.map(t => ({ t, ...p.placeOn(t) }))
  const order = places[0] && places.every(x => x.place === places[0]!.place) ? ordinal(places[0].place) + ' on ' + (n === 1 ? 'its address' : 'all ' + n) : places.map(x => ordinal(x.place) + ' on ' + p.addressOf(x.t).split('@')[0] + '@').join(' · ')
  return <div className="stack inbound-stack rp rp-c">
    <PageHeader title={p.key} backTo={LIST} actions={<Switch checked={p.enabled} onCheckedChange={v => void p.toggle(v)} label={p.enabled ? 'On' : 'Off'} />} />
    <p className="rp-c__summary">{p.recipe ? <Summary p={p} /> : 'Runs its own code.'}</p>
    <Group title="Rule">
      <Row label="Runs on" onClick={() => open('addresses')} value={n ? <span className="rp-c__addrs"><Match value={p.addressOf(p.targets[0]!)} />{n > 1 && <span className="muted">+{n - 1}</span>}</span> : <span className="muted">No address</span>} />
      {p.recipe ? p.recipe.fields.map(f => <Row key={f.name} label={fieldLabel(f)} icon={f.type === 'meaning' ? <Sparkles size={13} className="rcv-icon" aria-hidden="true" /> : undefined} value={valueOf(p, f)} onClick={() => open(`field:${f.name}`)} />)
        : <Row label="Code" value={p.source.trim().split('\n').length + ' lines'} onClick={() => open('code')} />}
      <Row label="Other rules" value={p.after ? others.next : others.stop} onClick={() => open('after')} />
    </Group>
    <Group title="Results">
      <Row label="Recent mail" onClick={() => open('test')} value={counted ? 'Acts on ' + acted + ' of the last ' + p.emails.length : <span className="rp-c__skel"><Skeleton width={160} height={13} /></span>} />
      <Row label="Latest match" tall onClick={() => open('test')} value={!counted ? <span className="rp-c__skel"><Skeleton width={220} height={13} /></span> : last ? <span className="rp-c__test"><span className="rp-b__mark" data-acted={lastOutcome?.acted || undefined} aria-hidden="true">{lastOutcome ? lastOutcome.acted ? <Check size={13} /> : <Minus size={13} /> : null}</span><span className="rp-c__clip">{last.subject}</span><span className="muted rp-c__clip">{lastOutcome ? (lastOutcome.acted ? lastOutcome.words : 'Does nothing') + ' · ' + ago(last.at) + ' ago' : '\u00a0'}</span></span> : <span className="muted">No mail yet</span>} />
    </Group>
    <Group title="More">
      <Row label="Order" value={order} onClick={() => open('order')} />
      {p.recipe && <Row label="Code" value="View or edit the code" onClick={() => open('code')} />}
      <Row label="Delete rule" danger onClick={() => p.setDeleting(true)} />
    </Group>

    <Dialog open={sheet === 'addresses'} onOpenChange={o => { if (!o) close() }} title="Runs on" footer={footer} returnFocus={opener}>
      <AddressChips p={p} />
    </Dialog>
    <Dialog open={!!field} onOpenChange={o => { if (!o) close() }} title={field ? fieldLabel(field) : ''} footer={footer} returnFocus={opener}>
      {field && <FieldControl p={p} f={field} />}
    </Dialog>
    <Dialog open={sheet === 'after'} onOpenChange={o => { if (!o) close() }} title="Other rules" footer={footer} returnFocus={opener}>
      <div className="rp-c__choices" role="radiogroup" aria-label="Other rules">{(['next', 'stop'] as const).map(v => <button key={v} type="button" role="radio" aria-checked={p.after === (v === 'next')} className="rp-c__choice" onClick={() => p.setAfter(v === 'next')}>
        <span>{others[v]}</span>{p.after === (v === 'next') && <Check size={14} aria-hidden="true" />}</button>)}</div>
    </Dialog>
    <Dialog open={sheet === 'code'} size="lg" onOpenChange={o => { if (!o) close() }} title="Code" footer={footer} returnFocus={opener}>
      {sheet === 'code' && <CodeOpen p={p} />}
    </Dialog>
    <Dialog open={sheet === 'order'} onOpenChange={o => { if (!o) setSheet(null) }} title="Order" returnFocus={opener} footer={<Button onClick={() => setSheet(null)}>Done</Button>}>
      <ul className="rp-c__order" role="list">{places.map(x => <li key={x.t}>
        <span className="rp-c__order-addr"><Match value={p.addressOf(x.t)} /><span className="muted">{x.place ? ordinal(x.place) + ' of ' + x.of : 'New'}</span></span>
        <span className="cluster"><Button size="sm" variant="ghost" disabled={x.place <= 1} onClick={() => void p.move(x.t, -1)} aria-label="Run earlier"><ArrowUp size={14} /></Button><Button size="sm" variant="ghost" disabled={!x.place || x.place >= x.of} onClick={() => void p.move(x.t, 1)} aria-label="Run later"><ArrowDown size={14} /></Button></span>
      </li>)}</ul>
    </Dialog>
    <Dialog open={sheet === 'test'} size="lg" onOpenChange={o => { if (!o) setSheet(null) }} title="Test on recent mail" returnFocus={opener}>
      {sheet === 'test' && <TestList p={p} />}
    </Dialog>
    <Shared p={p} />
  </div>
}
function CodeOpen({ p }: { p: Page }) {
  useEffect(() => { p.openCode(true); return () => p.openCode(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <CodeBox p={p} tall />
}
function TestList({ p }: { p: Page }) {
  const tests = p.useTests(p.emails)
  return <ul className="rp-b__mail rp-c__tests" role="list">{p.emails.map(m => { const o = tests.outcome(m.id); return <li key={m.id}><div className="rp-b__row">
    <span className="rp-b__mark" data-acted={o?.acted || undefined} aria-hidden="true">{o ? o.acted ? <Check size={13} /> : <Minus size={13} /> : null}</span>
    <span className="rp-b__msg"><span className="rp-b__subject">{m.subject}</span><span className="rp-b__from muted">{m.from.name ?? m.from.address}</span></span>
    <span className="rp-b__result" data-acted={o?.acted || undefined}>{o ? o.acted ? o.words : '—' : ''}</span>
  </div></li> })}</ul>
}
/** C's one-line summary: the recipe's sentence with its blanks filled. */
function Summary({ p }: { p: Page }) {
  const words = p.recipe ? parts[p.recipe.id] : undefined
  if (!words) return null
  const fill = (t: string) => t.split(/(\{\w+\})/).map((part, i) => { const name = /^\{(\w+)\}$/.exec(part)?.[1]; const f = name ? p.recipe!.fields.find(x => x.name === name) : undefined; return f ? <span key={i} className="recipe-blank">{f.type === 'test' ? testWords[p.params[f.name] ?? ''] : p.params[f.name]}</span> : <Fragment key={i}>{part}</Fragment> })
  return <>{words.if ? <>If {fill(words.if)}, </> : null}{fill(words.then)}{words.otherwise ? <>; otherwise {fill(words.otherwise)}</> : null}.</>
}

// ---------------------------------------------------------------- the page
export function RulePitch() {
  const { key = '' } = useParams()
  const [search] = useSearchParams()
  const v = pitchVersion('?' + search.toString()) ?? 'a'
  const p = useRulePage(key)
  if (p.loadError) return <div className="stack inbound-stack"><PageHeader title={key} backTo={LIST} /><ErrorState error={p.loadError} onRetry={() => location.reload()} /></div>
  if (!p.saved || !p.overview.data || !p.options.length || !p.recentReady) return <div className="stack inbound-stack rp"><PageHeader title={key} backTo={LIST} /><div className="rp-loading" aria-busy="true"><Skeleton width="60%" height={18} /><Skeleton width="40%" height={18} /></div></div>
  if (!p.rule) return <div className="stack inbound-stack"><PageHeader title={key} backTo={LIST} /><EmptyState title={'No rule named ' + key} action={<Link className="ui-button ui-button--secondary ui-button--md" to={LIST}>Rules</Link>} /></div>
  return v === 'a' ? <SentenceVersion p={p} /> : v === 'b' ? <WorkbenchVersion p={p} /> : <InspectorVersion p={p} />
}
