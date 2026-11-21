// PITCH ONLY (pitch/rule-page): the rule page, calm, behind ?v=g|h|i (also on /receiving/rules/new).
// The owner turned down D–F as too much text: panel headers, small uppercase labels, three things competing. These three
// keep what worked (the rule is its function; an agent writes it from plain words; every version runs on recent real
// mail, each email with the AI answer it got on arrival; one draft, one Save) and drop the rest:
//   - One artifact, two readings. The code is the rule; above it is the same rule in one plain sentence. Here the
//     sentence is derived from the source; the real agent would write it with the code and the API would store it.
//   - The agent is one input, not a conversation. Its change lands in the draft at once: the sentence, the mail and the
//     code all show it, and Undo or Save is the only decision. Nothing is live until Save.
//   - No section labels, no panel headers, no status words. "Changed" is one neutral fill, on mail rows and code lines.
//   G · Sentence: one column. The sentence, the input, recent mail; the code folds open under them.
//   H · Side by side: the code on the left; the sentence, recent mail and the input in one quiet column beside it.
//   I · Inbox: recent mail is the page, each email with what the rule does to it; the input is docked under it.
//   J · Code (the owner's answer to G–I: "the page needs to be code first"): the page is the editor. No agent and no
//     sentence. Over it: the name, the addresses, Undo, Save and the menu. Problems are the editor's own (a squiggle,
//     its message on hover, a mark by the line number). "Try on recent mail" under the editor (⌘↵) opens the mail with
//     what the code does to each email; nothing is tested while it is closed.
// The agent is a stand-in (POST /v1/rules/assist, answered by the pitch fixture with canned replies it checks with the
// real rule checker). The API has no such operation yet.
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, ChevronDown, ChevronRight, ChevronUp, Sparkles } from 'lucide-react'
import { Button, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState, PageHeader, Sheet, Skeleton, Tabs, useToast, type MenuItem } from '../../components/ui'
import { useApiDef, useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import { errorText } from '../../data/types'
import { staleAfterWrite } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { usePhone, useTouch } from '../../lib/media'
import { ownRecipient, type ReceivedRecipients } from '../../lib/private-address'
import { firstOverview, useOverview, type OverviewEndpoint } from './overview'
import { Editor } from './rituals'
import { Match } from './parts'
import { changedLines } from './live'
import { RunsOn, SHARED_LABEL, blindWords } from './rule-code-pitch'
import type { DryRun } from './trace'
import './inbound.css'
import './receiving.css'
import './rule-code-pitch.css'
import './rule-calm-pitch.css'

type V = 'g' | 'h' | 'i' | 'j'
type Binding = { rule: string; target: string; continue: boolean }
type RuleDef = { key: string; source: string; recipe?: unknown; enabled?: boolean }
type Config = { rules: RuleDef[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Received = ReceivedRecipients & { id: string; from: { name: string | null; address: string }; subject: string; at: string }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }
type Problem = { line: number; column: number; endColumn?: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[]; decisions: string[] }
type Assist = { reply: string; source: string | null; ok: boolean; name?: string }
type Outcome = { words: string; ai?: number }

const LIST = '/receiving?tab=rules'
const SHARED_SETTINGS = '/settings#receiving'
const DRAFT = 'new-rule'
const BLANK = 'export default function route(email, ctx) {\n  \n}\n'
// J's new rule: the function and one line that shows the shape of a rule.
const STARTER = 'export default function route(email, ctx) {\n  // e.g. return junk("newsletter")\n  \n}\n'
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/
const QUESTION = 'What should this rule do?'
const STARTERS = ['Post refund requests to #support', 'Junk newsletters', 'Label invoices']
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const plural = (s: string) => /s$/.test(s) ? s : s + 's'

/** What one action does to an email, in a word or two. */
function actionWords(a: { op: string; ref?: string; value?: string }, endpoints: OverviewEndpoint[]) {
  if (a.ref?.startsWith('endpoint:')) {
    const name = a.ref.slice(9), type = endpoints.find(x => x.source === 'endpoint' && x.name === name)?.type
    return type === 'slack' || type === 'discord' ? '#' + name : type === 'forward' ? 'Forwarded to ' + name : name + ' webhook'
  }
  if (a.ref?.startsWith('inbox:')) return a.ref.slice(6) + ' inbox'
  return ({ label: 'Labelled ' + (a.value ?? ''), junk: 'Junk', block: 'Rejected', drop: 'Dropped', allow: 'Kept out of junk' } as Record<string, string>)[a.op] ?? a.op
}
function outcomeOf(r: DryRun | undefined, key: string, endpoints: OverviewEndpoint[]): Outcome | null {
  if (!r) return null
  const row = r.trace.find(t => t.key === key)
  if (!row) return { words: '' }
  const ai = Object.values(row.scores).find((v): v is number => typeof v === 'number')
  return { words: row.error ? 'Error' : row.actions.map(a => actionWords(a, endpoints)).join(', '), ai }
}
/** The rule in one plain sentence. A stand-in for the agent's own description: it reads the few shapes the pitch's
 *  rules take (an AI question, a destination, junk, a label, one address). */
function describe(source: string, endpoints: OverviewEndpoint[]) {
  const out: string[] = []
  const junk = /junk\("([^"]+)"\)/.exec(source)
  if (junk) out.push('Junks ' + plural(junk[1]!))
  const allow = /email\.from\.address === "([^"]+)"[^\n]*allow\(/.exec(source)
  if (allow) out.push('Never junks ' + allow[1])
  const question = /decisions\(email, \{\s*\w+: "([^"]+)"/.exec(source)
  const call = /endpoints\.(\w+)\(|endpoints\["([^"]+)"\]\(/.exec(source)
  const only = /ctx\.recipient !== "([^"@]+)@/.exec(source)
  if (call) {
    const name = call[1] ?? call[2]!, type = endpoints.find(x => x.source === 'endpoint' && x.name === name)?.type
    const thing = question ? plural(question[1]!.replace(/^does this (email|message) look like (an? )?/i, '').replace(/\?$/, '')) : 'mail'
    const verb = type === 'slack' || type === 'discord' ? 'Posts' : type === 'forward' ? 'Forwards' : 'Sends'
    const to = type === 'slack' || type === 'discord' ? '#' + name : type === 'forward' ? name : 'the ' + name + ' webhook'
    out.push((only ? 'For ' + only[1] + '@, ' + verb.toLowerCase() : verb) + ' ' + thing + ' to ' + to)
  }
  const label = /label\("([^"]+)"\)/.exec(source)
  if (label) out.push('Labels ' + plural(label[1]!))
  return out.length ? out.join('. ') + '.' : 'Does nothing yet.'
}
function useStored(name: string, initial: boolean) {
  const [value, set] = useState(() => { try { return (localStorage.getItem(name) ?? String(initial)) === 'true' } catch { return initial } })
  return [value, (v: boolean) => { set(v); try { localStorage.setItem(name, String(v)) } catch { /* private mode */ } }] as const
}

// ---------------------------------------------------------------- the page's state: one draft, one save
function useRule(key: string | null, v: V) {
  const client = useQueryClient(), toast = useToast(), navigate = useNavigate()
  const isNew = key === null, id = key ?? DRAFT, coded = v === 'j', blank = coded ? STARTER : ''
  const overview = useOverview(firstOverview)
  const options = useApiDef(queries.inboundAddressOptions())
  const recent = useApiQuery(['pitch-recent'], (_api, signal) => request<{ data: Received[] }>('/v1/logs?direction=received&limit=12', { signal }).then(r => r.data))
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [source, setSource] = useState('')
  const [atts, setAtts] = useState<Binding[]>([])
  const [enabled, setEnabled] = useState(true)
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [completions, setCompletions] = useState<Completion[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [mark, setMark] = useState<{ lines: number[]; at: number; hold: true }>()
  const [thinking, setThinking] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [clean, setClean] = useState<Record<string, string>>({})
  const [seed, setSeed] = useState<{ text: string; at: number }>()
  // J tests only while its results are open.
  const [testing, setTesting] = useState(!coded)
  const opts = options.data ?? []
  const endpoints = overview.data?.endpoints ?? []
  const rule = saved?.config.rules.find(r => r.key === id)
  const savedSource = rule?.source ?? ''
  function reset(s: Saved) {
    const r = s.config.rules.find(x => x.key === id)
    setSource(r?.source ?? blank); setAtts(s.config.attachments); setEnabled(r?.enabled !== false); setName(null); setReply(null); setMark({ lines: [], at: Date.now(), hold: true })
  }
  useEffect(() => {
    const ac = new AbortController()
    request<Saved>('/v1/rules', { signal: ac.signal }).then(s => { setSaved(s); reset(s) }, e => { if (!ac.signal.aborted) setLoadError(e) })
    request<{ completions: Completion[] }>('/v1/rules/typings', { signal: ac.signal }).then(t => setCompletions(t.completions), () => {})
    return () => ac.abort()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new rule starts on the support address, or the first one.
  const first = (opts.find(o => o.address.startsWith('support@')) ?? opts[0])?.id
  useEffect(() => { if (isNew && saved && first) setAtts(a => a.some(b => b.rule === id) ? a : [...a, { rule: id, target: first, continue: true }]) }, [isNew, !!saved, first]) // eslint-disable-line react-hooks/exhaustive-deps
  async function lint(text: string) {
    try {
      const r = await request<Check>('/v1/rules/check', { method: 'POST', body: { source: text, key: id } }); setCheck(r)
      if (!coded) return r.diagnostics
      // J has no list of problems, so the editor's marks carry them: a squiggle runs under the whole name it starts at,
      // and an AI question on mail the AI may not read is marked where the code asks it.
      const lines = text.split('\n')
      const whole = r.diagnostics.map(d => ({ ...d, endColumn: Math.max(d.endColumn ?? 0, d.column + Math.max(1, /^[\w$.]*/.exec((lines[d.line - 1] ?? '').slice(d.column - 1))![0].length)) }))
      if (!r.decisions.length) return whole
      const at = lines.findIndex(l => l.includes('decisions(')), column = at < 0 ? 1 : lines[at]!.indexOf('decisions(') + 1
      return [...whole, ...blindDomains().map(d => ({ line: Math.max(1, at + 1), column, endColumn: column + 9, message: blindWords(d) }))]
    }
    catch { return [] }
  }
  useEffect(() => { if (!saved || !source) return; const t = setTimeout(() => void lint(source), 300); return () => clearTimeout(t) }, [source, !!saved]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = atts.filter(b => b.rule === id)
  const targets = mine.map(b => b.target)
  const after = mine.length ? mine.every(b => b.continue) : true
  const written = source.trim() !== '' && source !== BLANK && source !== STARTER
  const named = KEY.test(name ?? '') && !saved?.config.rules.some(r => r.key === name)
  const dirty = !!saved && (isNew ? written || (coded && !!name) : !!rule && (source !== rule.source || !same(atts, saved.config.attachments) || enabled !== (rule.enabled !== false)))
  const addressOf = (t: string) => opts.find(o => o.id === t)?.address ?? t
  const refresh = () => void client.invalidateQueries({ predicate: q => staleAfterWrite(q.queryKey, false) }).catch(() => {})
  const draft = {
    add: (t: string) => setAtts(a => [...a, { rule: id, target: t, continue: after }]),
    remove: (t: string) => setAtts(a => a.filter(b => !(b.rule === id && b.target === t))),
    move: (t: string, by: -1 | 1) => setAtts(a => {
      const all = [...a], idx = all.map((b, i) => ({ b, i })).filter(x => x.b.target === t), at = idx.findIndex(x => x.b.rule === id), other = idx[at + by]
      if (at < 0 || !other) return a
      const i = idx[at]!.i; [all[i], all[other.i]] = [all[other.i]!, all[i]!]
      return all
    }),
    setAfter: (next: boolean) => setAtts(a => a.map(b => b.rule === id ? { ...b, continue: next } : b)),
  }
  const placeOn = (t: string) => { const list = atts.filter(b => b.target === t); return { place: list.findIndex(b => b.rule === id) + 1, of: list.length, keys: list.map(b => b.rule) } }

  /** Everything on the page in one write: the code, where it runs and on or off. A new rule is named here. */
  const canSave = dirty && (!isNew || (written && (!coded || named)))
  async function save() {
    if (!saved || busy || !canSave) return
    setBusy(true)
    try {
      const as = isNew ? (name ?? 'rule-' + (saved.config.rules.length + 1)) : id
      const rules = isNew ? [...saved.config.rules, { key: as, source, enabled }] : saved.config.rules.map(r => r.key !== id ? r : source === r.source ? { ...r, enabled } : { key: id, source, enabled })
      const s = await request<Saved>('/v1/rules', { method: 'PUT', ifMatch: saved.version, body: { ...saved.config, rules, attachments: atts.map(b => b.rule === id ? { ...b, rule: as } : b) } })
      refresh(); toast(as + ' saved', 'success')
      if (isNew) navigate('/receiving/rules/' + encodeURIComponent(as) + '?v=' + v, { replace: true })
      else { setSaved(s); reset(s) }
    } catch (e) { toast('Not saved: ' + errorText(e), 'error') }
    finally { setBusy(false) }
  }
  async function remove() {
    await request('/v1/rules/scripts/' + encodeURIComponent(id), { method: 'DELETE', ...(saved ? { ifMatch: saved.version } : {}) })
    refresh(); toast(id + ' deleted', 'success'); navigate(LIST, { replace: true })
  }
  /** The agent writes into the draft: the sentence, the mail and the code show its change; Undo or Save decides. */
  async function ask(text: string) {
    const t = text.trim()
    if (!t || thinking) return
    setThinking(true); setReply(null)
    try {
      const base = written ? source : BLANK
      const r = await request<Assist>('/v1/rules/assist', { method: 'POST', body: { key: id, source: base, message: t } })
      if (r.source && r.ok && r.source !== source) {
        setSource(r.source)
        if (isNew) setName(r.name ?? null); else setMark({ lines: changedLines(savedSource, r.source), at: Date.now(), hold: true })
      } else setReply(r.reply)
    } catch (e) { setReply(errorText(e)) }
    finally { setThinking(false) }
  }

  const summary = useMemo(() => describe(source, endpoints), [source, endpoints])
  const domains = saved?.config.evaluateDomains ?? []
  const blindDomains = () => [...new Set(targets.map(t => addressOf(t).split('@')[1] ?? ''))].filter(d => d && !domains.includes(d))
  const blind = check?.decisions.length ? blindDomains() : []
  const problems = !written ? [] : [...(check?.diagnostics ?? []).map(d => ({ where: 'Line ' + d.line, text: d.message + (d.hint ? ' ' + d.hint : '') })), ...blind.map(d => ({ where: 'AI', text: blindWords(d) }))]

  // Recent mail to its addresses (else any recent mail), one per conversation.
  const watched = new Set(targets.flatMap(t => { const o = opts.find(x => x.id === t); return o ? [o.address, ...o.aliases] : [t] }))
  const emails = useMemo(() => {
    const all = recent.data ?? [], seen = new Set<string>(), ours = all.filter(m => watched.has(ownRecipient(m) ?? ''))
    return (ours.length ? ours : all).filter(m => { const s = m.subject.replace(/^(re|fwd?):\s*/i, '').toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true }).slice(0, v === 'i' ? 9 : 6)
  }, [recent.data, [...watched].join()]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Dry runs the draft's code on every email, 350 ms after it changes, as if on the address each email went to.
   *  A test never asks the AI: each stored email brings the answer the AI gave when it arrived. */
  const [results, setResults] = useState<Record<string, { src: string; result?: DryRun }>>({})
  const signature = JSON.stringify([source, emails.map(m => m.id), !!saved, testing])
  useEffect(() => {
    if (!saved || !written || !emails.length || !testing) return
    const ac = new AbortController()
    const timer = setTimeout(() => {
      for (const m of emails) {
        const to = ownRecipient(m) ?? m.to[0] ?? ''
        const mineNow = { key: id, source, enabled: true }
        const config = { ...saved.config, rules: rule ? saved.config.rules.map(r => r.key === id ? mineNow : r) : [...saved.config.rules, mineNow], attachments: [{ rule: id, target: to, continue: false }] }
        request<DryRun>('/v1/rules/test', { method: 'POST', signal: ac.signal, body: { messageId: m.id, to: [to], config } })
          .then(result => setResults(x => ({ ...x, [m.id]: { src: source, result } })), () => { if (!ac.signal.aborted) setResults(x => ({ ...x, [m.id]: { src: source } })) })
      }
    }, 350)
    return () => { clearTimeout(timer); ac.abort() }
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
  const outcome = (m: string) => written ? outcomeOf(results[m]?.result, id, endpoints) : null
  const settled = emails.length > 0 && emails.every(m => results[m.id]?.src === source)
  // What the saved rule does to each email, kept from the last time the draft matched it: what a change is compared with.
  useEffect(() => { if (!isNew && settled && source === savedSource) setClean(Object.fromEntries(emails.map(m => [m.id, outcome(m.id)?.words ?? '']))) }, [settled, source, savedSource]) // eslint-disable-line react-hooks/exhaustive-deps
  // J can open its results on a draft that already differs: the saved rule is then run once, to compare with.
  const baseless = coded && testing && !!rule && !!saved && source !== savedSource && emails.some(m => !(m.id in clean))
  useEffect(() => {
    if (!baseless || !saved) return
    const ac = new AbortController()
    void Promise.all(emails.map(m => {
      const to = ownRecipient(m) ?? m.to[0] ?? ''
      return request<DryRun>('/v1/rules/test', { method: 'POST', signal: ac.signal, body: { messageId: m.id, to: [to], config: { ...saved.config, attachments: [{ rule: id, target: to, continue: false }] } } })
        .then(r => [m.id, outcomeOf(r, id, endpoints)?.words ?? ''] as const, () => [m.id, ''] as const)
    })).then(rows => { if (!ac.signal.aborted) setClean(Object.fromEntries(rows)) })
    return () => ac.abort()
  }, [baseless]) // eslint-disable-line react-hooks/exhaustive-deps
  const was = (m: string) => !isNew && settled && source !== savedSource && m in clean && clean[m] !== (outcome(m)?.words ?? '') ? clean[m]! : null

  return {
    key: id, v, isNew, title: key ?? (name || 'New rule'), saved, loadError, missing: !isNew && !!saved && !rule, ready: !!saved && !!overview.data && opts.length > 0 && !!recent.data,
    options: opts, source, setSource, written, enabled, setEnabled, busy, dirty, canSave, save, name, setName, testing, setTesting, undo: () => { if (saved) reset(saved) },
    targets, after, draft, placeOn, addressOf, deleting, setDeleting, remove, completions, lint, problems, mark,
    thinking, reply, ask, summary, emails, outcome, was, seed, about: (subject: string) => setSeed({ text: 'Mail like “' + subject + '” should ', at: Date.now() }),
  }
}
type Rule = ReturnType<typeof useRule>

// ---------------------------------------------------------------- the pieces G, H and I share
/** The title, then Undo and Save. On and off, and delete, are in the menu. */
function Top({ p, children, more = [], title, subtitle, settings = true }: { p: Rule; children?: ReactNode; more?: MenuItem[]; title?: ReactNode; subtitle?: ReactNode; settings?: boolean }) {
  const navigate = useNavigate()
  const items: MenuItem[] = [
    ...more,
    { label: p.enabled ? 'Turn off' : 'Turn on', onSelect: () => p.setEnabled(!p.enabled) },
    ...(settings ? [{ label: SHARED_LABEL, onSelect: () => navigate(SHARED_SETTINGS) }] : []),
    { label: 'Delete rule', destructive: true, onSelect: () => p.setDeleting(true) },
  ]
  return <>
    <PageHeader title={title ?? <>{p.title}{!p.enabled && <span className="calm-off">Off</span>}</>} subtitle={subtitle} backTo={LIST} actions={<>
      <Button variant="ghost" className="calm-undo" data-hidden={!p.dirty || undefined} disabled={!p.dirty || p.busy} onClick={p.undo}>Undo</Button>
      {children}
      <Button variant="primary" loading={p.busy} disabled={!p.canSave} onClick={() => void p.save()}>Save</Button>
      {!p.isNew && <DropdownMenu label={'Actions for ' + p.key} items={items} />}
    </>} />
    <ConfirmDialog open={p.deleting} onOpenChange={p.setDeleting} danger title={'Delete ' + p.key + '?'} description={'It stops running on ' + (p.targets.length === 1 ? 'its address' : 'its ' + p.targets.length + ' addresses') + '.'} confirmLabel="Delete rule" onConfirm={p.remove} />
  </>
}
/** The rule in a sentence (a new rule: the question), and the mail it runs on, which opens where it runs. */
function Sentence({ p, size = 'lg' }: { p: Rule; size?: 'xl' | 'lg' }) {
  return <div className="calm-say" data-size={size}>
    <p className="calm-say__text">{p.written ? p.summary : QUESTION}</p>
    <Addresses p={p} />
  </div>
}
/** The mail the rule runs on, in a line; it opens where it runs (addresses, their order, other rules). */
function Addresses({ p }: { p: Rule }) {
  const [open, setOpen] = useState(false)
  const shown = p.targets.slice(0, 3), more = p.targets.length - shown.length
  return <>
    <button type="button" className="calm-say__on" onClick={() => setOpen(true)}>
      {p.targets.length ? <>Mail to {shown.map((t, i) => <Fragment key={t}>{i > 0 && (i === shown.length - 1 && !more ? ' and ' : ', ')}<span className="calm-say__addr"><Match value={p.addressOf(t)} host={false} />@</span></Fragment>)}{more > 0 && ' and ' + more + ' more'}</> : 'Choose an address'}<ChevronDown size={14} aria-hidden="true" />
    </button>
    <Dialog open={open} onOpenChange={setOpen} title="Runs on" footer={<Button onClick={() => setOpen(false)}>Done</Button>}><RunsOn p={p} /></Dialog>
  </>
}
/** The agent: one input. ⌘K puts the cursor in it. */
function Ask({ p }: { p: Rule }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // An email's "Not right?" starts the sentence about it.
  useEffect(() => { if (p.seed) { setText(p.seed.text); input.current?.focus() } }, [p.seed])
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim()) return; void p.ask(text); setText('') }
  return <div className="calm-ask-wrap">
    <form className="calm-ask" onSubmit={submit}>
      <Sparkles size={16} className="calm-ask__icon" aria-hidden="true" />
      <input ref={input} className="calm-ask__input" value={text} onChange={e => setText(e.target.value)} disabled={p.thinking} placeholder={p.thinking ? 'Writing…' : p.written ? 'Describe a change…' : 'Describe it…'} aria-label={p.written ? 'Describe a change' : QUESTION} autoComplete="off" />
      <Button variant="primary" type="submit" className="calm-ask__send" aria-label="Send" loading={p.thinking} disabled={!text.trim()}>{!p.thinking && <ArrowUp size={16} aria-hidden="true" />}</Button>
    </form>
    {p.reply && <p className="calm-reply" role="status">{p.reply}</p>}
  </div>
}
/** A new rule's first words: three things people ask for. */
function Starters({ p, inline = false }: { p: Rule; inline?: boolean }) {
  return <ul className={inline ? 'calm-starters calm-starters--inline' : 'calm-rows calm-starters'} role="list">{STARTERS.map(s => <li key={s}><button type="button" className="calm-row" disabled={p.thinking} onClick={() => void p.ask(s)}><span className="calm-row__main">{s}</span></button></li>)}</ul>
}
/** Recent mail, each email with what the draft does to it. A row the draft treats differently from the saved rule is
 *  filled, with what the saved rule did struck through. With detail, a row opens to who sent it and the AI's answer. */
function Mail({ p, detail = false, heading = true }: { p: Rule; detail?: boolean; heading?: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  return <section className="calm-mail" data-detail={detail || undefined} aria-label="Recent mail">
    {heading && <h2 className="calm-head">Recent mail</h2>}
    <ul className="calm-rows" role="list">{p.emails.map(m => {
      const o = p.outcome(m.id), old = p.was(m.id), isOpen = detail && open === m.id
      const inner = <>
        {detail && <span className="calm-row__from">{m.from.name ?? m.from.address}</span>}
        <span className="calm-row__main">{m.subject || '(no subject)'}</span>
        <span className="calm-row__out">{old !== null && old !== '' && <s>{old}</s>}{o?.words}</span>
      </>
      return <li key={m.id} data-acted={!!o?.words || undefined} data-changed={old !== null || undefined}>
        {detail ? <button type="button" className="calm-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : m.id)}>{inner}</button> : <div className="calm-row">{inner}</div>}
        {isOpen && <p className="calm-row__why"><span>To <Match value={ownRecipient(m) ?? m.to[0] ?? ''} />{o?.ai !== undefined && <>. The AI was {Math.round(o.ai * 100)}% sure.</>}</span>{p.v !== 'j' && <Button variant="ghost" onClick={() => p.about(m.subject)}>Not right?</Button>}</p>}
      </li>
    })}</ul>
  </section>
}
/** The code. Lines the agent changed since the last save are filled; problems show only when there are some. */
function Code({ p, fill = false, list = true }: { p: Rule; fill?: boolean; list?: boolean }) {
  return <div className="calm-code" data-fill={fill || undefined}>
    <Editor value={p.source || BLANK} change={p.setSource} completions={p.completions} check={p.lint} flash={p.mark} relint={p.targets.length + 1} />
    {list && p.problems.length > 0 && <ul className="calm-problems" role="list">{p.problems.map((x, i) => <li key={i}><span>{x.where}</span>{x.text}</li>)}</ul>}
  </div>
}
const problemWords = (p: Rule) => p.problems.length ? p.problems.length + (p.problems.length === 1 ? ' problem' : ' problems') : null

// ---------------------------------------------------------------- G · Sentence
function SentenceVersion({ p }: { p: Rule }) {
  const [code, setCode] = useStored('nightmail.pitch.rule-code', false)
  const fold = useRef<HTMLDivElement>(null)
  const toggle = () => { setCode(!code); if (!code) requestAnimationFrame(() => fold.current?.scrollIntoView({ block: 'nearest' })) }
  return <div className="stack calm calm-g">
    <Top p={p} />
    <Sentence p={p} size="xl" />
    <Ask p={p} />
    {p.written ? <Mail p={p} /> : <Starters p={p} />}
    <div className="calm-fold" data-open={code || undefined} ref={fold}>
      <button type="button" className="calm-row calm-fold__button" aria-expanded={code} onClick={toggle}>
        <span className="calm-row__main">Code</span><span className="calm-row__out calm-bad">{problemWords(p)}</span><ChevronRight size={16} aria-hidden="true" />
      </button>
      {code && <Code p={p} />}
    </div>
  </div>
}

// ---------------------------------------------------------------- H · Side by side
function SideVersion({ p }: { p: Rule }) {
  const phone = usePhone()
  const [tab, setTab] = useState<'rule' | 'code'>('rule')
  return <div className="stack calm calm-h">
    <Top p={p} />
    {phone && <Tabs label="Show" value={tab} onValueChange={t => setTab(t as 'rule' | 'code')} items={[{ value: 'rule', label: 'Rule' }, { value: 'code', label: 'Code' }]} />}
    <div className="calm-h__grid">
      <div className="calm-h__code" hidden={phone && tab !== 'code'}><Code p={p} fill /></div>
      <div className="calm-h__side" hidden={phone && tab !== 'rule'}>
        <Sentence p={p} />
        {p.written ? <Mail p={p} /> : <Starters p={p} />}
        <Ask p={p} />
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------- I · Inbox
function InboxVersion({ p }: { p: Rule }) {
  const phone = usePhone()
  const [code, setCode] = useStored('nightmail.pitch.rule-code-pane', false)
  return <div className="stack calm calm-i" data-code={(code && !phone) || undefined}>
    <Top p={p} more={phone ? [{ label: 'Code', onSelect: () => setCode(true) }] : []}>{!phone && <Button aria-pressed={code} onClick={() => setCode(!code)}>Code{problemWords(p) && <span className="calm-bad"> · {problemWords(p)}</span>}</Button>}</Top>
    <div className="calm-i__grid">
      <div className="calm-i__main">
        <Sentence p={p} />
        <Mail p={p} detail />
        <div className="calm-i__dock">{!p.written && <Starters p={p} inline />}<Ask p={p} /></div>
      </div>
      {code && !phone && <div className="calm-i__code"><Code p={p} fill /></div>}
    </div>
    {phone && <Sheet open={code} onOpenChange={setCode} title="Code" className="calm-sheet"><Code p={p} /></Sheet>}
  </div>
}

// ---------------------------------------------------------------- J · Code
/** Closed, one quiet line under the editor. Open (click or ⌘↵): recent mail with what the code does to each email, under
 *  the editor, or in a sheet on a phone. */
function Try({ p }: { p: Rule }) {
  const phone = usePhone()
  const open = p.testing, set = p.setTesting
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); set(!open) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const mail = p.emails.length ? <Mail p={p} detail heading={false} /> : <p className="calm-reply">No mail yet</p>
  return <div className="calm-try" data-open={open || undefined}>
    <button type="button" className="calm-try__button" aria-expanded={open} aria-keyshortcuts="Meta+Enter" onClick={() => set(!open)}>Try on recent mail<ChevronUp size={14} aria-hidden="true" /></button>
    {open && !phone && mail}
    {phone && <Sheet open={open} onOpenChange={set} title="Recent mail"><div className="calm">{mail}</div></Sheet>}
  </div>
}
function CodeVersion({ p }: { p: Rule }) {
  const phone = usePhone(), touch = useTouch()
  const name = p.isNew ? <input className="calm-name" value={p.name ?? ''} size={Math.max(8, (p.name ?? '').length)} placeholder="new-rule" aria-label="Rule name" autoFocus spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={e => p.setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || null)} /> : undefined
  const problem = p.problems[0]
  return <div className="stack calm calm-j">
    <Top p={p} title={name} subtitle={phone ? undefined : <Addresses p={p} />} settings={false} />
    {phone && <div className="calm-j__on"><Addresses p={p} /></div>}
    <div className="calm-j__body">
      <div className="calm-j__code"><Code p={p} fill list={false} />{touch && problem && <p className="calm-j__problem" role="status"><span>{problem.where}</span>{problem.text}</p>}</div>
      <Try p={p} />
    </div>
  </div>
}

// ---------------------------------------------------------------- the page
export function CalmRulePitch({ ruleKey: key, v }: { ruleKey: string | null; v: V }) {
  const p = useRule(key, v)
  const shell = 'stack calm calm-' + v
  if (p.loadError) return <div className={shell}><PageHeader title={p.title} backTo={LIST} /><ErrorState error={p.loadError} onRetry={() => location.reload()} /></div>
  if (!p.ready) return <div className={shell}><PageHeader title={p.title} backTo={LIST} />{v === 'j' ? <div className="calm-j__body" aria-busy="true"><div className="calm-j__code"><div className="calm-code" data-fill /></div></div> : <div className="calm-loading" aria-busy="true"><Skeleton width="70%" height={24} /><Skeleton width="34%" height={14} /></div>}</div>
  if (p.missing) return <div className={shell}><PageHeader title={p.title} backTo={LIST} /><EmptyState title={'No rule named ' + p.title} action={<Link className="ui-button ui-button--secondary ui-button--md" to={LIST}>Rules</Link>} /></div>
  return v === 'g' ? <SentenceVersion p={p} /> : v === 'h' ? <SideVersion p={p} /> : v === 'i' ? <InboxVersion p={p} /> : <CodeVersion p={p} />
}
