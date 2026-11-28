import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { autocompletion } from '@codemirror/autocomplete'
import { forceLinting, linter, lintGutter, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button, Checkbox, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, SearchField, Select, Sheet, Skeleton, Textarea, useToast, type MenuItem } from '../../components/ui'
import { mergeAddresses, useAddressOptions, useResolvedAddresses } from '../../data/addresses'
import { useDebounced } from '../../lib/pagination'
import { isAbortError, request } from '../../data/live'
import { ApiError, errorText } from '../../data/types'
import { useApiDef, useApiQuery, useRequestScope, useWorkspaceAccess } from '../../data/context'
import { invalidate, invalidateResources } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { useLeaveGuard } from '../../lib/leave-guard'
import { RITUALS_PER_ADDRESS } from '../../../../api/src/ritual-schema'
import { usePhone, useTouch } from '../../lib/media'
import { concepts } from './concepts'
import { firstOverview, useOverview, type OverviewEndpoint } from './overview'
import { PrivateAddress } from '../../components/PrivateAddress'
import type { DryRun } from './trace'
import { Match } from './parts'
import './inbound.css'
import './receiving.css'
import { useSingleFlight } from '../../lib/single-flight'
import { actorText, changedLines, diffLines, useLiveVersion, type ChangeActor, type DiffLine, type LiveChange } from './live'
import { addressOption, cleanName, openBuilder, rulePath, splitBuilderPath } from './shared'
import { maskedParts, ownRecipient, type ReceivedRecipients } from '../../lib/private-address'
const runNext = 'Run the next one too'
// The workspace's sender lists and where AI decisions read mail: every rule's, opened from any rule's menu.
const sharedSettings = 'Sender lists and AI access'
const savedMeanwhile = (version: number) => `Version ${version} was saved meanwhile: load theirs or keep yours.`

type Binding = { rule: string; target: string; continue: boolean }
type Received = ReceivedRecipients & { id: string; from: { name: string | null; address: string }; subject: string; at: string }
type Config = { rules: { key: string; source: string; recipe?: { id: string; params: unknown }; enabled?: boolean }[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Problem = { rule?: string; line: number; column: number; endLine?: number; endColumn?: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[]; calls: string[]; decisions: string[]; questions: Record<string, string>; lists: string[] }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/
// A new rule: the function, and one line that shows the shape of a rule.
const starter = () => `export default function route(email, ctx) {\n  // e.g. return junk("newsletter")\n  \n}\n`
const LIST = '/receiving?tab=rules'
/** A new rule's place in the draft's attachments until it has a name: no saved rule can be called this. */
const DRAFT = ':new'
const listsToText = (lists: Record<string, string[]>) => Object.entries(lists).map(([name, entries]) => `${name}: ${entries.join(', ')}`).join('\n')
function textToLists(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const [name, rest = ''] = line.split(':')
    const key = name?.trim().toLowerCase()
    if (key) out[key] = rest.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  }
  return out
}
const domainsToText = (domains: string[]) => domains.join(', ')
// Nightmail's color tokens, so the editor follows the light and dark themes. Few colors on purpose.
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--color-muted)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-info)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--color-accent)' },
  { tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName), tags.punctuation, tags.bracket], color: 'var(--color-text)' },
]))
const offset = (view: EditorView, line: number, column: number) => {
  const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  return Math.min(l.from + Math.max(0, column - 1), l.to)
}

// Lines a save made elsewhere changed, marked for a moment (inbound.css .ritual-editor__changed). Never the person's own typing.
const markLines = StateEffect.define<number[]>()
const changedLine = Decoration.line({ class: 'ritual-editor__changed' })
const changedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes)
    for (const effect of tr.effects) if (effect.is(markLines)) {
      const lines = new RangeSetBuilder<Decoration>()
      for (const n of [...new Set(effect.value)].sort((a, b) => a - b)) if (n >= 1 && n <= tr.state.doc.lines) { const at = tr.state.doc.line(n).from; lines.add(at, at, changedLine) }
      marks = lines.finish()
    }
    return marks
  },
  provide: field => EditorView.decorations.from(field),
})
type Flash = { lines: number[]; at: number }

/** CodeMirror with workspace completions and live diagnostics from checkRule. `flash` marks lines a remote save
 *  changed; `relint` checks the script again (the workspace's endpoints changed). */
function Editor({ value, change, completions, check, flash, relint }: { value: string; change: (s: string) => void; completions: Completion[]; check: (source: string) => Promise<Problem[]>; flash?: Flash; relint?: number }) {
  const parent = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null)
  const latest = useRef({ change, completions, check })
  latest.current = { change, completions, check }
  useEffect(() => {
    const v = new EditorView({
      parent: parent.current!, doc: value,
      extensions: [
        basicSetup, javascript(), highlight, EditorView.lineWrapping, lintGutter(), changedField,
        EditorView.contentAttributes.of({ 'aria-label': 'Rule source' }),
        autocompletion({ override: [ctx => {
          if (!ctx.explicit && /Comment/.test(syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name)) return null
          const word = ctx.matchBefore(/[\w.[\]"-]+/)
          if (!word || (word.from === word.to && !ctx.explicit)) return null
          return { from: word.from, options: latest.current.completions.map(c => ({ label: c.label, type: c.type, detail: c.detail, info: c.info, ...(c.apply ? { apply: c.apply } : {}) })) }
        }] }),
        linter(async editor => (await latest.current.check(editor.state.doc.toString())).map((p): LintDiagnostic => {
          const from = offset(editor, p.line, p.column)
          return { from, to: Math.max(from + 1, offset(editor, p.endLine ?? p.line, p.endColumn ?? p.column)), severity: 'error', message: p.hint ? `${p.message} ${p.hint}` : p.message }
        }), { delay: 400 }),
        EditorView.updateListener.of(u => { if (u.docChanged) latest.current.change(u.state.doc.toString()) }),
      ],
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current, doc = v?.state.doc.toString()
    if (!v || doc === undefined || doc === value) return
    // Replace only the part that differs, so the cursor and the scroll stay where they were.
    let from = 0, end = 0
    while (from < doc.length && from < value.length && doc[from] === value[from]) from++
    while (end < doc.length - from && end < value.length - from && doc[doc.length - 1 - end] === value[value.length - 1 - end]) end++
    v.dispatch({ changes: { from, to: doc.length - end, insert: value.slice(from, value.length - end) } })
  }, [value])
  useEffect(() => {
    const v = view.current
    if (!v || !flash?.lines.length) return
    v.dispatch({ effects: markLines.of(flash.lines) })
    const clear = setTimeout(() => view.current?.dispatch({ effects: markLines.of([]) }), 2600)
    return () => clearTimeout(clear)
  }, [flash])
  useEffect(() => { if (relint && view.current) forceLinting(view.current) }, [relint])
  return <div className="ritual-editor" ref={parent} />
}

type Incoming = Saved & { actor: ChangeActor | null }
type DiffPart = { title: string; lines: DiffLine[] }
/** Who saved a version that arrived while you were editing, to start a sentence. */
function whoSaved(actor: ChangeActor | null) {
  if (actor?.type === 'mcp') return actor.self ? 'This agent' : actor.name ?? 'Your agent'
  if (actor?.type === 'member' && actor.self) return 'You, in another tab,'
  const who = actorText(actor)
  return who[0]!.toUpperCase() + who.slice(1)
}
/** What a save made elsewhere changed, script by script: base → theirs, or yours → theirs for the script you are
 *  editing when both of you changed it. Attachments, sender lists and AI decision hosts are named, not diffed. */
function changesBetween(base: Config, theirs: Config, key: string, yours: string | null): { parts: DiffPart[]; other: string[] } {
  const before = new Map(base.rules.map(r => [r.key, r.source])), after = new Map(theirs.rules.map(r => [r.key, r.source]))
  const parts: DiffPart[] = []
  for (const k of [...after.keys(), ...[...before.keys()].filter(k => !after.has(k))]) {
    const b = before.get(k), t = after.get(k)
    if (b === t) continue
    if (k === key && yours !== null && yours !== b) parts.push({ title: t === undefined ? `${k}: yours, deleted in theirs` : `${k}: yours → theirs`, lines: diffLines(yours, t ?? '') })
    else parts.push({ title: t === undefined ? `${k} (deleted)` : b === undefined ? `${k} (new)` : k, lines: diffLines(b ?? '', t ?? '') })
  }
  const other = [
    ...(JSON.stringify(base.attachments) !== JSON.stringify(theirs.attachments) ? ['where rules run'] : []),
    ...(JSON.stringify(base.senderLists) !== JSON.stringify(theirs.senderLists) ? ['sender lists'] : []),
    ...(JSON.stringify(base.evaluateDomains) !== JSON.stringify(theirs.evaluateDomains) ? ['where AI decisions read mail'] : []),
  ]
  return { parts, other }
}
/** Two lines of context around each change; longer unchanged runs fold to a gap. */
function folded(lines: DiffLine[]): (DiffLine | null)[] {
  const near = new Set<number>()
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let j = i - 2; j <= i + 2; j++) near.add(j) })
  const out: (DiffLine | null)[] = []
  lines.forEach((l, i) => { if (near.has(i)) out.push(l); else if (out.at(-1) !== null) out.push(null) })
  return out
}
function DiffView({ parts }: { parts: DiffPart[] }) {
  return <div className="ritual-diff" tabIndex={0} aria-label="What changed">{parts.length ? parts.map(part => <div key={part.title}>
    <p className="ritual-diff__title">{part.title}</p>
    <pre className="ritual-diff__lines">{folded(part.lines).map((l, i) => l === null ? <span key={i} className="ritual-diff__gap">⋯</span>
      : l.kind === 'add' ? <ins key={i} className="ritual-diff__line ritual-diff__line--add"><span className="ritual-diff__sign" aria-hidden="true">+</span>{l.text || ' '}</ins>
      : l.kind === 'del' ? <del key={i} className="ritual-diff__line ritual-diff__line--del"><span className="ritual-diff__sign" aria-hidden="true">−</span>{l.text || ' '}</del>
      : <span key={i} className="ritual-diff__line"><span className="ritual-diff__sign" aria-hidden="true"> </span>{l.text || ' '}</span>)}</pre>
  </div>) : <p className="ritual-diff__title">No script changed.</p>}</div>
}

/** What one action does to an email, in a word or two. */
function actionWords(a: { op: string; ref?: string; value?: string }, endpoints: OverviewEndpoint[]) {
  if (a.ref?.startsWith('endpoint:')) {
    const name = a.ref.slice(9), type = endpoints.find(x => x.source === 'endpoint' && x.name === name)?.type
    return type === 'slack' || type === 'discord' ? '#' + name : type === 'forward' ? 'Forwarded to ' + name : name + ' webhook'
  }
  if (a.ref?.startsWith('inbox:')) return a.ref.slice(6) + ' inbox'
  return ({ label: 'Labelled ' + (a.value ?? ''), junk: 'Junk', block: 'Rejected', drop: 'Dropped', allow: 'Kept out of junk' } as Record<string, string>)[a.op] ?? a.op
}
type Outcome = { words: string; ai?: number; error?: string }
function outcomeOf(r: DryRun | undefined, key: string, endpoints: OverviewEndpoint[]): Outcome | null {
  if (!r) return null
  const row = r.trace.find(t => t.key === key)
  if (!row) return { words: '' }
  const ai = Object.values(row.scores).find((v): v is number => typeof v === 'number')
  return { words: row.error ? 'Error' : row.actions.map(a => actionWords(a, endpoints)).join(', '), ai, ...(row.error ? { error: row.error } : {}) }
}

/** Where the rule runs: its addresses, each with the rules there in order (this one moves among them), whether the next
 *  one still runs after it acts, and a way off. All of it is the page's draft until Save. */
function RunsOn({ id, name, atts, change, targets }: { id: string; name: string; atts: Binding[]; change: (next: Binding[]) => void; targets: { value: string; label: string }[] }) {
  const label = (value: string) => targets.find(t => t.value === value)?.label ?? value
  // A label can't hold a PrivateAddress: it names an address as masked, by its first two characters.
  const spoken = (value: string) => { const m = maskedParts(label(value)); return m ? m.shown + '…' : label(value) }
  const mine = atts.flatMap((b, i) => b.rule === id ? [{ ...b, i }] : [])
  const free = targets.filter(t => !mine.some(b => b.target === t.value) && atts.filter(b => b.target === t.value).length < RITUALS_PER_ADDRESS)
  return <div className="rule-runs">
    {mine.length > 0 && <ul role="list">{mine.map(b => {
      const there = atts.map((x, j) => ({ x, j })).filter(({ x }) => x.target === b.target), at = there.findIndex(({ j }) => j === b.i)
      const swap = (j: number | undefined) => { if (j === undefined) return; const a = [...atts]; [a[b.i], a[j]] = [a[j]!, a[b.i]!]; change(a) }
      return <li key={b.target}>
        <span className="rule-runs__address"><PrivateAddress value={label(b.target)} /></span>
        <span className="rule-runs__actions">
          <IconButton label={'Run earlier on ' + spoken(b.target)} disabled={at <= 0} onClick={() => swap(there[at - 1]?.j)}><ArrowUp size={14} aria-hidden="true" /></IconButton>
          <IconButton label={'Run later on ' + spoken(b.target)} disabled={at >= there.length - 1} onClick={() => swap(there[at + 1]?.j)}><ArrowDown size={14} aria-hidden="true" /></IconButton>
          <IconButton label={'Remove ' + spoken(b.target)} onClick={() => change(atts.filter((_, j) => j !== b.i))}><X size={14} aria-hidden="true" /></IconButton>
        </span>
        {there.length > 1 && <>
          <span className="rule-runs__order" aria-label={'Runs ' + (at + 1) + ' of ' + there.length}>{there.map(({ x }, n) => <span key={x.rule} data-self={x.rule === id || undefined}>{n > 0 && <span aria-hidden="true"> → </span>}{x.rule === id ? name : x.rule}</span>)}</span>
          <Checkbox checked={b.continue} onCheckedChange={v => change(atts.map((x, j) => j === b.i ? { ...x, continue: v } : x))} label={runNext} />
        </>}
      </li>
    })}</ul>}
    {free.length > 0 && <Select className="address-select-trigger" menuClassName="address-select" aria-label="Add an address" value="" placeholder={mine.length ? 'Add an address' : 'Choose an address'}
      onValueChange={v => { if (v) change([...atts, { rule: id, target: v, continue: false }]) }} options={free.map(t => addressOption(t.value, t.label))} />}
  </div>
}

/**
 * One rule: the page is its code. The code, where it runs (its addresses and its order on each), on or off, and the
 * workspace's sender lists and AI hosts are one draft; Save writes all of it as one version (applyRules, If-Match) and
 * Undo goes back to the saved one. Problems are the editor's own marks. "Try on recent mail" runs the draft on recent
 * mail, each email with the AI's answer from when it arrived, and only while it is open.
 */
export function RulePage() {
  const { canAdminister } = useWorkspaceAccess()
  const scope = useRequestScope()
  const toast = useToast()
  const client = useQueryClient()
  const navigate = useNavigate()
  const phone = usePhone(), touch = useTouch()
  // /receiving/rules/:key opens that rule; /receiving/rules/new/script starts one. A rule named "new" opens at
  // /receiving/rules/new/code (recipes.tsx, NewRecipeRoute).
  const route = useParams(), wanted = route.key ?? (route.recipe === 'code' ? 'new' : '')
  const routeLocation = useLocation()
  const preset = useSearchParams()[0].get('address')
  const [addressSearch, setAddressSearch] = useState('')
  const addresses = useAddressOptions({ enabled: canAdminister, search: useDebounced(addressSearch) })
  // The Mail routing page's first read, usually cached: only its endpoints are used here, to name what the rule did.
  const overview = useOverview(firstOverview, false, canAdminister)
  const recent = useApiQuery(['rule-recent'], (api, signal) => request<{ data: Received[] }>('/v1/logs?direction=received&limit=24', { signal, scope: api.scope }).then(r => r.data), { enabled: canAdminister })
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  // The rule's key (a new rule's is typed over the code), and the saved rule on screen ('' for a new one).
  const [key, setKey] = useState(wanted)
  const [opened, setOpened] = useState('')
  const [missing, setMissing] = useState(false)
  const [source, setSource] = useState('')
  const [origin, setOrigin] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [atts, setAtts] = useState<Binding[]>([])
  const [baseAtts, setBaseAtts] = useState<Binding[]>([])
  const [lists, setLists] = useState('')
  const [domains, setDomains] = useState('')
  const [completions, setCompletions] = useState<Completion[]>([])
  const [problems, setProblems] = useState<Problem[]>([])
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmScript, setConfirmScript] = useState(false)
  // #attach and #try links land with their part open.
  const [runsOpen, setRunsOpen] = useState(routeLocation.hash === '#attach')
  const [sharedOpen, setSharedOpen] = useState(false)
  const [trying, setTrying] = useState(routeLocation.hash === '#try')
  const [shown, setShown] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { src: string; result?: DryRun }>>({})
  const [clean, setClean] = useState<Record<string, string>>({})
  // Live: saves made elsewhere (an agent over MCP, an API key, another tab) arrive while this page is open. With no
  // local edits they land in place; with local edits they wait in incoming until you load theirs or keep yours.
  const [remote, setRemote] = useState<LiveChange | null>(null)
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  const [landed, setLanded] = useState(0)
  const [flash, setFlash] = useState<Flash>()
  const [relint, setRelint] = useState(0)
  const [showDiff, setShowDiff] = useState(false)
  const [confirmKeep, setConfirmKeep] = useState(false)
  const listsRef = useRef<Record<string, string[]>>({})
  listsRef.current = textToLists(lists)
  const keyRef = useRef(key)
  keyRef.current = key

  /** Shows one saved rule, or a new one (wanted is ''), from a saved config: the last saved state, which Undo returns to. */
  function open(s: Saved, wanted: string) {
    const r = s.config.rules.find(x => x.key === wanted)
    // A new rule from an address's New rule starts on that address.
    const start = r || !preset ? s.config.attachments : [...s.config.attachments, { rule: DRAFT, target: preset, continue: false }]
    setKey(r?.key ?? ''); setOpened(r?.key ?? ''); setMissing(!!wanted && !r); setSource(r?.source ?? starter()); setOrigin(r?.source ?? starter()); setEnabled(r?.enabled !== false)
    setAtts(start); setBaseAtts(start); setLists(listsToText(s.config.senderLists)); setDomains(domainsToText(s.config.evaluateDomains)); setProblems([])
  }
  useEffect(() => {
    if (!canAdminister) return
    const ac = new AbortController()
    request<{ completions: Completion[] }>('/v1/rules/typings', { signal: ac.signal, scope }).then(t => setCompletions(t.completions)).catch(() => {})
    request<Saved>('/v1/rules', { signal: ac.signal, scope }).then(s => { setSaved(s); open(s, wanted) }).catch(e => { if (!ac.signal.aborted && !isAbortError(e)) setLoadError(e as Error) })
    return () => ac.abort()
  }, [canAdminister]) // eslint-disable-line react-hooks/exhaustive-deps
  // Another rule's path (the page stays mounted between them): open it, unless it is the one on screen (a new rule's
  // first save moves to its own path).
  useEffect(() => { if (saved && wanted !== keyRef.current) open(saved, wanted) }, [wanted]) // eslint-disable-line react-hooks/exhaustive-deps

  const rule = saved?.config.rules.find(r => r.key === opened)
  // In the draft's attachments a new rule is DRAFT until it is saved; anywhere a key is needed before it has one, "draft".
  const id = opened || DRAFT
  const keyValid = KEY.test(key)
  const ruleKey = opened || (keyValid ? key : 'draft')
  // A new rule named like a saved one: saving would replace that rule's script, so it is refused here.
  const clash = !opened && !!saved?.config.rules.some(r => r.key === key)
  const config = useMemo<Config | null>(() => saved && ({
    ...saved.config,
    rules: opened ? saved.config.rules.map(r => r.key === opened ? { ...r, source, enabled } : r) : [...saved.config.rules, { key: ruleKey, source, enabled }],
    attachments: atts.map(b => b.rule === DRAFT ? { ...b, rule: ruleKey } : b),
    senderLists: textToLists(lists),
    evaluateDomains: domains.split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  }), [saved, opened, ruleKey, source, enabled, atts, lists, domains])
  const scriptChanged = source !== origin
  const enabledChanged = !!rule && enabled !== (rule.enabled !== false)
  const attsChanged = JSON.stringify(atts) !== JSON.stringify(baseAtts)
  const listsChanged = !!saved && !!config && JSON.stringify(config.senderLists) !== JSON.stringify(saved.config.senderLists)
  const domainsChanged = !!saved && !!config && JSON.stringify(config.evaluateDomains) !== JSON.stringify(saved.config.evaluateDomains)
  const dirty = !!saved && !missing && (scriptChanged || enabledChanged || attsChanged || listsChanged || domainsChanged || (!opened && (!!key || !enabled)))
  // A rule made from a recipe keeps it only while its source is what the recipe writes: saving other code makes it a
  // script (the API drops the recipe). The address builder can then no longer change a split, so that save asks first.
  const split = rule?.recipe?.id === 'split' || rule?.recipe?.id === 'split-by-meaning'

  const live = useRef({ saved, dirty, key, opened, source, atts })
  live.current = { saved, dirty, key, opened, source, atts }
  useLiveVersion(canAdminister && !!saved, change => {
    setRemote(change)
    // A new or changed endpoint changes what a rule can call: new completions, and the script checked again.
    if (change.endpointsMoved) request<{ completions: Completion[] }>('/v1/rules/typings', { scope }).then(t => { setCompletions(t.completions); setRelint(n => n + 1) }).catch(() => {})
  }, { endpoints: true })
  // A version newer than the one on screen (and not this page's own save, which is never in flight here) is read once,
  // and again 4 s later if that read fails.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!remote || !saved || pending || removing || remote.version <= Math.max(saved.version, incoming?.version ?? 0)) return
    const ac = new AbortController()
    let again: ReturnType<typeof setTimeout> | undefined
    request<Saved>('/v1/rules', { signal: ac.signal, scope }).then(s => land(s, remote.actor)).catch(e => { if (!ac.signal.aborted && !isAbortError(e)) again = setTimeout(() => setRetry(n => n + 1), 4000) })
    return () => { ac.abort(); clearTimeout(again) }
  }, [remote, saved?.version, incoming?.version, pending, removing, retry]) // eslint-disable-line react-hooks/exhaustive-deps
  // Your edits are gone (Undo, or undone by hand) while their version waits: it lands as if you hadn't edited.
  useEffect(() => {
    if (!incoming || dirty || pending) return
    const { actor, ...s } = incoming
    setIncoming(null); land(s, actor)
  }, [incoming, dirty, pending]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Their attachments, with a new rule's own (it is in nobody's saved config yet). */
  const withMine = (theirs: Binding[], mine: Binding[]) => [...theirs, ...mine.filter(b => b.rule === DRAFT)]
  function land(s: Saved, actor: ChangeActor | null) {
    const { saved: base, dirty, key, opened, source, atts } = live.current
    if (!base || s.version <= base.version) return
    // Only routes moved: the version is still the If-Match for saving, so take it quietly.
    if (JSON.stringify(s.config) === JSON.stringify(base.config)) { setSaved(s); return }
    if (dirty) { setIncoming({ ...s, actor }); setShowDiff(false); setConfirmKeep(false); return }
    setSaved(s); setIncoming(null)
    const theirs = s.config.rules.find(r => r.key === key)
    if (opened && !theirs) {
      toast(whoSaved(actor) + ' deleted ' + key, 'info')
      navigate(LIST, { replace: true })
      return
    }
    if (theirs && opened) {
      if (theirs.source !== source) { setSource(theirs.source); setFlash({ lines: changedLines(source, theirs.source), at: Date.now() }) }
      setOrigin(theirs.source); setEnabled(theirs.enabled !== false)
    }
    const next = withMine(s.config.attachments, atts)
    setAtts(next); setBaseAtts(next); setLists(listsToText(s.config.senderLists)); setDomains(domainsToText(s.config.evaluateDomains))
    // The page has no status line: a save made elsewhere says so once, and marks the lines it changed.
    setLanded(s.version); toast(whoSaved(actor) + ' saved version ' + s.version, 'info')
  }
  /** Their version replaces your edits. */
  function loadTheirs() {
    if (!incoming) return
    const { actor: _actor, ...s } = incoming, before = source
    setSaved(s); setIncoming(null)
    const theirs = s.config.rules.find(r => r.key === opened)
    if (opened && !theirs) { navigate(LIST, { replace: true }); return }
    open(s, opened)
    if (theirs && theirs.source !== before) setFlash({ lines: changedLines(before, theirs.source), at: Date.now() })
  }
  // Keeping yours rebases the draft onto their version (its If-Match). What only they changed stays theirs; where
  // both of you changed the same thing, yours replaces theirs, and that is confirmed first.
  const theirScript = incoming?.config.rules.find(r => r.key === key)?.source
  const overlaps = !incoming || !saved ? [] : [
    ...(scriptChanged && theirScript !== rule?.source ? [theirScript === undefined ? 'their deletion of ' + key : rule ? 'their changes to ' + key : 'their rule named ' + key] : []),
    ...(attsChanged && JSON.stringify(incoming.config.attachments) !== JSON.stringify(saved.config.attachments) ? ['where their rules run'] : []),
    ...(listsChanged && JSON.stringify(incoming.config.senderLists) !== JSON.stringify(saved.config.senderLists) ? ['their sender lists'] : []),
    ...(domainsChanged && JSON.stringify(incoming.config.evaluateDomains) !== JSON.stringify(saved.config.evaluateDomains) ? ['their AI decision hosts'] : []),
  ]
  function keepMine() {
    if (!incoming) return
    if (overlaps.length && !confirmKeep) { setConfirmKeep(true); return }
    const { actor: _actor, ...s } = incoming
    const theirs = s.config.rules.find(r => r.key === opened)
    if (!listsChanged) setLists(listsToText(s.config.senderLists))
    if (!domainsChanged) setDomains(domainsToText(s.config.evaluateDomains))
    if (theirs && !scriptChanged) setSource(theirs.source)
    if (theirs && !enabledChanged) setEnabled(theirs.enabled !== false)
    if (theirs) setOrigin(theirs.source)
    // Deleted in theirs: saving brings yours back as a new rule of the same name.
    const mine = opened && !theirs ? atts.map(b => b.rule === opened ? { ...b, rule: DRAFT } : b) : atts
    if (opened && !theirs) setOpened('')
    setAtts(attsChanged ? mine : withMine(s.config.attachments, mine)); setBaseAtts(withMine(s.config.attachments, baseAtts))
    setSaved(s); setIncoming(null); setConfirmKeep(false); setShowDiff(false)
    toast('Your edits now sit on version ' + s.version + '. Save to apply.', 'success')
  }

  const refresh = () => void invalidateResources(client, invalidate.rules).catch(() => {})
  /** The checker's problems, for the editor's own marks. It reports where a problem starts; the squiggle runs under the
   *  whole name there. */
  async function lint(text: string): Promise<Problem[]> {
    try {
      const r = await request<Check>('/v1/rules/check', { method: 'POST', body: { source: text, key: KEY.test(keyRef.current) ? keyRef.current : 'draft', senderLists: listsRef.current }, scope })
      const lines = text.split('\n')
      const marked = r.diagnostics.map(d => (d.endLine ?? d.line) !== d.line ? d : { ...d, endColumn: Math.max(d.endColumn ?? 0, d.column + Math.max(1, /^[\w$.]*/.exec((lines[d.line - 1] ?? '').slice(d.column - 1))![0].length)) })
      setProblems(marked)
      return marked
    } catch { return [] }
  }
  /** Saves the draft as one version. Resolves false when it didn't save; the reason is shown. Single flight: a second
   *  Save or ⌘S before the first answers would send the same version again and report a conflict next to the success. */
  const save = useSingleFlight('rules.save', async (): Promise<boolean> => {
    if (!saved || !config || !keyValid || clash) return false
    if (incoming) { toast(savedMeanwhile(incoming.version), 'error'); return false }
    setPending(true)
    try {
      const s = await request<Saved>('/v1/rules', { method: 'PUT', body: config, ifMatch: saved.version, scope })
      setSaved(s); open(s, key); refresh()
      if (key !== wanted) navigate(rulePath(key), { replace: true })
      toast(key + ' saved · version ' + s.version, 'success')
      return true
    } catch (e) {
      if (isAbortError(e)) return false
      const first = e instanceof ApiError ? (e.details as Problem[] | undefined)?.[0] : undefined
      toast('Not saved: ' + (first ? (first.rule && first.rule !== key ? first.rule + ', line ' : 'line ') + first.line + ': ' + first.message : errorText(e)), 'error')
      return false
    } finally { setPending(false) }
  })
  const canSave = !!saved && !missing && (dirty || !opened) && keyValid && !clash && !pending && !incoming
  const askSave = () => { if (!canSave) return; if (split && scriptChanged) setConfirmScript(true); else void save() }
  const remove = useSingleFlight('rules.delete', async () => {
    if (!saved) return
    // Marked as a write in flight, so the live view never reports this delete as someone else's.
    setRemoving(true)
    try {
      const s = await request<Saved>('/v1/rules/scripts/' + encodeURIComponent(opened), { method: 'DELETE', ifMatch: saved.version, scope })
      setSaved(s); refresh(); toast(opened + ' deleted', 'success')
      navigate(LIST, { replace: true })
    } finally { setRemoving(false) }
  }, opened)
  const leaveGuard = useLeaveGuard(dirty, { what: 'the changes to ' + (key || 'this rule'), save: () => save() })
  // ⌘S / Ctrl+S saves from anywhere on the page, the editor included; ⌘↵ opens and closes the results.
  const keys = useRef({ askSave, trying })
  keys.current = { askSave, trying }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 's') { event.preventDefault(); keys.current.askSave() }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setTrying(!keys.current.trying) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const attachedTargetIds = [...atts.map(b => b.target), ...(preset ? [preset] : [])]
  const resolvedTargets = useResolvedAddresses(attachedTargetIds, addresses.items, canAdminister)
  const knownAddresses = mergeAddresses(resolvedTargets.items, addresses.items)
  const targets = knownAddresses.flatMap(a => [{ label: a.address, value: a.id }, ...a.aliases.map(alias => ({ label: alias, value: alias }))])
  const targetName = (value: string) => targets.find(t => t.value === value)?.label ?? value
  const mine = atts.filter(b => b.rule === id).map(b => targetName(b.target))
  const endpoints = overview.data?.endpoints ?? []
  // Recent mail to its addresses (else any recent mail), one per conversation.
  const emails = useMemo(() => {
    const all = recent.data ?? [], seen = new Set<string>(), ours = all.filter(m => mine.includes(ownRecipient(m) ?? ''))
    return (ours.length ? ours : all).filter(m => { const s = m.subject.replace(/^(re|fwd?):\s*/i, '').toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true }).slice(0, 6)
  }, [recent.data, mine.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  /** One email through the given config's version of this rule alone, on and as if on the address the email went to.
   *  The AI is never asked: each stored email brings the answer it got when it arrived. */
  const dryRun = (m: Received, on: Config, signal: AbortSignal) => {
    const to = ownRecipient(m) ?? m.to[0] ?? ''
    return request<DryRun>('/v1/rules/test', { method: 'POST', signal, scope, body: { messageId: m.id, to: [to], config: { ...on, rules: on.rules.map(r => r.key === ruleKey ? { ...r, enabled: true } : r), attachments: [{ rule: ruleKey, target: to, continue: false }] } } })
  }
  const signature = JSON.stringify([source, ruleKey, lists, emails.map(m => m.id), !!saved, trying])
  useEffect(() => {
    if (!config || !emails.length || !trying) return
    const ac = new AbortController()
    const timer = setTimeout(() => {
      for (const m of emails) dryRun(m, config, ac.signal).then(result => setResults(x => ({ ...x, [m.id]: { src: source, result } })), () => { if (!ac.signal.aborted) setResults(x => ({ ...x, [m.id]: { src: source } })) })
    }, 350)
    return () => { clearTimeout(timer); ac.abort() }
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
  const outcome = (m: string) => outcomeOf(results[m]?.result, ruleKey, endpoints)
  const settled = emails.length > 0 && emails.every(m => results[m.id]?.src === source)
  // What the saved rule does to each email: what an edit is compared with. Kept from a run of the saved code, or, when
  // the results open on a draft that already differs, from one run of the saved rule.
  useEffect(() => { if (opened && settled && !scriptChanged) setClean(Object.fromEntries(emails.map(m => [m.id, outcome(m.id)?.words ?? '']))) }, [settled, scriptChanged, opened, saved?.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const baseless = trying && !!rule && !!saved && scriptChanged && emails.some(m => !(m.id in clean))
  useEffect(() => {
    if (!baseless || !saved) return
    const ac = new AbortController()
    void Promise.all(emails.map(m => dryRun(m, saved.config, ac.signal).then(r => [m.id, outcomeOf(r, ruleKey, endpoints)?.words ?? ''] as const, () => [m.id, ''] as const)))
      .then(rows => { if (!ac.signal.aborted) setClean(Object.fromEntries(rows)) })
    return () => ac.abort()
  }, [baseless]) // eslint-disable-line react-hooks/exhaustive-deps
  const was = (m: string) => !!rule && settled && scriptChanged && m in clean && clean[m] !== (outcome(m)?.words ?? '') ? clean[m]! : null

  const title = wanted || 'New rule'
  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title={title} backTo={LIST} /><EmptyState title={concepts.rules.adminOnly} /></div>
  if (loadError) return <div className="stack inbound-stack"><PageHeader title={title} backTo={LIST} /><ErrorState error={loadError} onRetry={() => location.reload()} /></div>
  if (missing) return <div className="stack inbound-stack"><PageHeader title={title} backTo={LIST} /><EmptyState title={'No rule named ' + wanted} action={<Link className="ui-button ui-button--secondary ui-button--md" to={LIST}>Rules</Link>} /></div>
  const ready = !!saved && !addresses.isPending && !resolvedTargets.pending && recent.isFetched
  const builder = split && opened ? splitBuilderPath(opened, atts.filter(b => b.rule === opened).map(b => b.target), knownAddresses) : null
  const items: MenuItem[] = [
    ...(builder ? [{ label: openBuilder, onSelect: () => navigate(builder) }] : []),
    { label: enabled ? 'Turn off' : 'Turn on', onSelect: () => setEnabled(!enabled) },
    { label: sharedSettings, onSelect: () => setSharedOpen(true) },
    ...(opened ? [{ label: 'Delete rule', destructive: true, onSelect: () => setConfirmDelete(true) }] : []),
  ]
  const changes = incoming && saved ? changesBetween(saved.config, incoming.config, key, scriptChanged ? source : null) : null
  const problem = problems[0]
  // The addresses it runs on, in a line that opens where it runs.
  const first = mine.slice(0, 3), more = mine.length - first.length
  const on = <button type="button" className="rule-on" disabled={!ready} onClick={() => setRunsOpen(true)}>
    {!ready ? <Skeleton width={200} height={12} /> : <><span className="rule-on__text">{mine.length ? <>Mail to {first.map((address, i) => <span key={address}>{i > 0 && (i === first.length - 1 && !more ? ' and ' : ', ')}<span className="rule-on__address"><Match value={address} host={false} />@</span></span>)}{more > 0 && ' and ' + more + ' more'}</> : 'Choose an address'}</span><ChevronDown size={14} aria-hidden="true" /></>}
  </button>
  const name = opened || !saved ? <span title={opened || title}>{opened || title}{!!opened && !enabled && <span className="rule-off">Off</span>}</span>
    : <input className="rule-name" value={key} size={Math.max(8, key.length)} placeholder="new-rule" aria-label="Rule name" aria-invalid={(!!key && !keyValid) || clash || undefined} title={key && !keyValid ? 'Lowercase letters, digits and hyphens' : clash ? 'A rule named ' + key + ' exists' : undefined}
        autoFocus spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={e => setKey(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'))} />
  const mail = !emails.length ? <p className="rule-mail__none">No mail yet</p> : <ul className="rule-mail" role="list" aria-label="Recent mail">{emails.map(m => {
    const o = outcome(m.id), old = was(m.id), isOpen = shown === m.id
    return <li key={m.id} data-acted={!!o?.words || undefined} data-changed={old !== null || undefined}>
      <button type="button" className="rule-mail__row" aria-expanded={isOpen} onClick={() => setShown(isOpen ? null : m.id)}>
        <span className="rule-mail__from">{cleanName(m.from.name) || <PrivateAddress value={m.from.address} />}</span>
        <span className="rule-mail__subject">{m.subject || '(no subject)'}</span>
        <span className="rule-mail__out">{old !== null && old !== '' && <s>{old}</s>}{o?.words}</span>
      </button>
      {isOpen && <p className="rule-mail__why">To <Match value={ownRecipient(m) ?? m.to[0] ?? ''} />{o?.ai !== undefined && <>. The AI was {Math.round(o.ai * 100)}% sure.</>}{o?.error && <> {o.error}</>}</p>}
    </li>
  })}</ul>
  return <div className="stack inbound-stack rule-page" data-landed={landed === saved?.version || undefined}>
    <PageHeader title={name} subtitle={phone ? undefined : on} backTo={LIST} actions={<>
      <Button variant="ghost" className="rule-undo" data-hidden={!dirty || undefined} disabled={!dirty || pending} onClick={() => saved && open(saved, opened)}>Undo</Button>
      <Button variant="primary" loading={pending} disabled={!canSave} onClick={askSave}>Save</Button>
      <span className="rule-menu" data-hidden={!ready || undefined}><DropdownMenu label={'Actions for ' + (key || 'this rule')} items={items} /></span>
    </>} />
    {phone && <div className="rule-on-row">{on}</div>}
    <div className="rule-body">
      <div className="rule-code">
        {saved ? <Editor value={source} change={setSource} completions={completions} check={lint} flash={flash} relint={relint} /> : <div className="ritual-editor" aria-busy="true" />}
        {/* Touch has no hover for the editor's message: the first problem lies over the editor's bottom edge. */}
        {touch && problem && !incoming && <p className="rule-problem" role="status"><span>Line {problem.line}</span>{problem.message}{problem.hint ? ' ' + problem.hint : ''}</p>}
        {/* Saved elsewhere while you were editing: over the editor, so nothing on the page moves. */}
        {incoming && changes && <div className="ritual-incoming" role="group" aria-label={'Version ' + incoming.version + ' saved elsewhere'}>
          <p className="ritual-incoming__title"><strong>{whoSaved(incoming.actor)} saved version {incoming.version}</strong></p>
          <p className="ritual-incoming__detail muted">{(() => {
            // What you both changed, then what only they changed (theirs stays either way).
            const both = overlaps.map(o => o.replace(/^(where )?their (deletion of |changes to |rule named )?/, '$1'))
            const only = [...changes.parts.map(p => p.title.split(/[: ]/)[0]!), ...changes.other].filter(name => !both.includes(name))
            return <>{both.length ? <>You both changed {both.join(' and ')}.</> : <>Your edits don’t overlap with it.</>}{only.length ? <> It also changed {only.join(', ')}, which stays as they saved it.</> : null}</>
          })()}</p>
          {showDiff && <DiffView parts={changes.parts} />}
          {confirmKeep && <p className="ritual-incoming__warn">Saving yours replaces {overlaps.join(' and ')}.</p>}
          <div className="ritual-incoming__actions">
            <Button size="sm" variant="ghost" aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>{showDiff ? 'Hide diff' : 'View diff'}</Button>
            <Button size="sm" onClick={loadTheirs}>Load theirs</Button>
            {confirmKeep && <Button size="sm" variant="ghost" onClick={() => setConfirmKeep(false)}>Cancel</Button>}
            <Button size="sm" variant={confirmKeep ? 'danger' : 'secondary'} onClick={keepMine}>{confirmKeep ? 'Keep mine anyway' : 'Keep mine'}</Button>
          </div>
        </div>}
      </div>
      {/* Closed, one quiet line and nothing is run. Open, recent mail with what the draft does to each email: under the
          editor, which gives up the room, or in a sheet on a phone. */}
      <div className="rule-try" data-open={trying || undefined}>
        <button type="button" className="rule-try__button" aria-expanded={trying} aria-keyshortcuts="Meta+Enter" disabled={!ready} onClick={() => setTrying(!trying)}>Try on recent mail<ChevronUp size={14} aria-hidden="true" /></button>
        {ready && trying && !phone && mail}
        {ready && phone && <Sheet open={trying} onOpenChange={setTrying} title="Recent mail"><div className="rule-sheet">{mail}</div></Sheet>}
      </div>
    </div>
    <Dialog open={runsOpen && ready} onOpenChange={setRunsOpen} title="Runs on" footer={<Button onClick={() => setRunsOpen(false)}>Done</Button>}>
      <div className="stack">
        {(addresses.hasMore || Boolean(addressSearch)) && <SearchField aria-label="Search addresses" placeholder="Search addresses" value={addressSearch} onChange={event => setAddressSearch(event.target.value)} />}
        <RunsOn id={id} name={key || 'this rule'} atts={atts} change={setAtts} targets={targets} />
        {addresses.hasMore && <Button variant="ghost" size="sm" loading={addresses.loadingMore} onClick={addresses.loadMore}>Load more addresses</Button>}
      </div>
    </Dialog>
    {/* Shared by every rule, not just this one. A list is one per line (vip: an address, @partner.example); AI decisions
        read mail only at the hosts listed, and give their default answer everywhere else. */}
    <Dialog open={sharedOpen} onOpenChange={setSharedOpen} title={sharedSettings} footer={<Button onClick={() => setSharedOpen(false)}>Done</Button>}>
      <div className="stack rule-shared">
        <Field label="Sender lists, one per line"><Textarea className="private-field" rows={4} value={lists} onChange={e => setLists(e.target.value)} spellCheck={false} placeholder="vip: @partner.example" /></Field>
        <Field label="AI decisions can read mail at"><Input value={domains} onChange={e => setDomains(e.target.value)} placeholder={((overview.data?.domains ?? []).find(d => d.status === 'active')?.name ?? 'reply.example.com') + ', …'} /></Field>
      </div>
    </Dialog>
    {leaveGuard}
    <ConfirmDialog open={confirmScript} onOpenChange={setConfirmScript} title={'Save ' + key + ' as code?'} description="The address builder can no longer change this split." confirmLabel="Save as code" onConfirm={async () => { await save() }} />
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={'Delete ' + key + '?'} description={'It stops running on every address it’s attached to' + (atts.some(b => b.rule === opened) ? ' (' + atts.filter(b => b.rule === opened).length + ')' : '') + '. Earlier versions stay restorable over the API.'}
      confirmLabel="Delete rule" danger onConfirm={remove} />
  </div>
}
