// PITCH ONLY (pitch/rule-page): the rule page code-first, behind ?v=d|e|f. A rule is its function, route(email, ctx),
// so the editor is the page; an agent writes and changes the code from plain words, and every version of the code is
// tested on recent real mail (each with the AI answer it got when it arrived). One draft holds the code, where the rule
// runs and whether it is on; one Save writes all of it as one version (applyRules, If-Match).
// The agent is a stand-in: POST /v1/rules/assist is answered by the pitch fixture (serve.mjs) with canned replies whose
// code it checks with the real rule checker. The API has no such operation yet.
//   D · Pair: editor and tests on the left, the conversation on the right; a change lands in the editor as a diff.
//   E · Command: a command bar over the editor; the side holds the tests, then the conversation.
//   F · Tabs: editor left; one side panel with Agent, Test and Runs on; a change is a diff in the agent's reply.
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, AtSign, Check, ChevronDown, CodeXml, Minus, Sparkles, X } from 'lucide-react'
import { Button, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState, Field, IconButton, PageHeader, Select, Sheet, Skeleton, Switch, Tabs, Textarea, useToast, type MenuItem } from '../../components/ui'
import { useApiDef, useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import { errorText } from '../../data/types'
import { staleAfterWrite } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { usePhone } from '../../lib/media'
import { ownRecipient, type ReceivedRecipients } from '../../lib/private-address'
import { firstOverview, useOverview, type OverviewEndpoint } from './overview'
import { Editor } from './rituals'
import { Match } from './parts'
import { addressOption, when } from './shared'
import { changedLines, diffLines } from './live'
import type { DryRun } from './trace'
import './inbound.css'
import './receiving.css'
import './rule-code-pitch.css'

type Binding = { rule: string; target: string; continue: boolean }
type RuleDef = { key: string; source: string; recipe?: unknown; enabled?: boolean }
type Config = { rules: RuleDef[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Received = ReceivedRecipients & { id: string; from: { name: string | null; address: string }; subject: string; at: string }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }
type Problem = { line: number; column: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[]; calls: string[]; decisions: string[]; questions: Record<string, string>; lists: string[] }
type Proposal = { source: string; base: string; status: 'pending' | 'accepted' | 'rejected'; added: number; removed: number }
type Msg = { id: number; role: 'user' | 'agent'; text: string; proposal?: Proposal; failed?: boolean }
type Assist = { reply: string; source: string | null; ok: boolean; diagnostics: Problem[] }
type EndpointType = OverviewEndpoint['type']
type Outcome = { acted: boolean; words: string; ai?: number; error?: string }
const LIST = '/receiving?tab=rules'
// Sender lists and which domains the AI may read are the workspace's, not one rule's: their proposed home.
const SHARED_SETTINGS = '/settings#receiving'
const ASK = 'Describe what it should do…'
export const OTHER_RULES = 'Other rules on these addresses'
export const AI_AT_ARRIVAL = 'The AI’s answer when this email arrived'
const SUGGESTIONS = ['Send refund requests from support@ to #support in Slack, junk newsletters', 'Also label invoices', 'Explain this rule']
const typeWord: Record<EndpointType, string> = { slack: 'Slack', discord: 'Discord', webhook: 'Webhook', forward: 'Forward' }
const ordinal = (n: number) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const endpointName = (call: string) => call.replace(/^endpoints\./, '').replace(/^endpoints\["|"\]$/g, '')

function actionWords(a: { op: string; ref?: string; value?: string }, endpoints: OverviewEndpoint[]) {
  if (a.ref?.startsWith('endpoint:')) {
    const name = a.ref.slice(9), e = endpoints.find(x => x.source === 'endpoint' && x.name === name)
    return e?.type === 'slack' || e?.type === 'discord' ? 'Posts to ' + name + ' in ' + typeWord[e.type] : e?.type === 'forward' ? 'Forwards to ' + name : 'Sends to ' + name
  }
  if (a.ref?.startsWith('inbox:')) return 'Delivers to the ' + a.ref.slice(6) + ' inbox'
  return ({ label: 'Labels it ' + (a.value ?? ''), junk: 'Marks it as junk', block: 'Rejects it', drop: 'Drops it', allow: 'Keeps it out of junk' } as Record<string, string>)[a.op] ?? a.op
}
function outcomeOf(r: DryRun | undefined, key: string, endpoints: OverviewEndpoint[]): Outcome | null {
  if (!r) return null
  const row = r.trace.find(t => t.key === key)
  if (!row) return { acted: false, words: 'Didn’t run' }
  const ai = Object.values(row.scores).find((v): v is number => typeof v === 'number')
  if (row.error) return { acted: false, words: 'Stopped with an error', error: row.error, ai }
  const acts = row.actions.map(a => actionWords(a, endpoints))
  return { acted: acts.length > 0, words: acts.length ? acts.join(' · ') : 'Does nothing', ai }
}

// ---------------------------------------------------------------- the page's state: one draft, one save
function useCodeRule(key: string) {
  const client = useQueryClient(), toast = useToast(), navigate = useNavigate()
  const overview = useOverview(firstOverview)
  const options = useApiDef(queries.inboundAddressOptions())
  const recent = useApiQuery(['pitch-recent'], (_api, signal) => request<{ data: Received[] }>('/v1/logs?direction=received&limit=12', { signal }).then(r => r.data))
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [source, setSource] = useState('')
  const [atts, setAtts] = useState<Binding[]>([])
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [completions, setCompletions] = useState<Completion[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [flash, setFlash] = useState<{ lines: number[]; at: number }>()
  const [messages, setMessages] = useState<Msg[]>([])
  const [thinking, setThinking] = useState(false)
  const ids = useRef(0)
  const rule = saved?.config.rules.find(r => r.key === key)
  function reset(s: Saved) {
    const r = s.config.rules.find(x => x.key === key)
    setSource(r?.source ?? ''); setAtts(s.config.attachments); setEnabled(r?.enabled !== false)
  }
  useEffect(() => {
    const ac = new AbortController()
    request<Saved>('/v1/rules', { signal: ac.signal }).then(s => { setSaved(s); reset(s) }, e => { if (!ac.signal.aborted) setLoadError(e) })
    request<{ completions: Completion[] }>('/v1/rules/typings', { signal: ac.signal }).then(t => setCompletions(t.completions), () => {})
    return () => ac.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  async function lint(text: string) {
    try { const r = await request<Check>('/v1/rules/check', { method: 'POST', body: { source: text, key } }); setCheck(r); return r.diagnostics }
    catch { return [] }
  }
  // Checked here too, so the summary and diagnostics are right while the editor is hidden (a phone's other tab).
  useEffect(() => { if (!saved) return; const t = setTimeout(() => void lint(source), 300); return () => clearTimeout(t) }, [source, !!saved]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = atts.filter(b => b.rule === key)
  const targets = mine.map(b => b.target)
  const after = mine.length ? mine.every(b => b.continue) : true
  const dirty = !!rule && !!saved && (source !== rule.source || !same(atts, saved.config.attachments) || enabled !== (rule.enabled !== false))
  const opts = options.data ?? []
  const endpoints = overview.data?.endpoints ?? []
  const addressOf = (t: string) => opts.find(o => o.id === t)?.address ?? t
  const pending = messages.find(m => m.proposal?.status === 'pending')?.proposal ?? null
  const refresh = () => void client.invalidateQueries({ predicate: q => staleAfterWrite(q.queryKey, false) }).catch(() => {})

  /** Where it runs, as a draft: added addresses run last on theirs; moving swaps it with its neighbour there. */
  const draft = {
    add: (t: string) => setAtts(a => [...a, { rule: key, target: t, continue: after }]),
    remove: (t: string) => setAtts(a => a.filter(b => !(b.rule === key && b.target === t))),
    move: (t: string, by: -1 | 1) => setAtts(a => {
      const all = [...a], idx = all.map((b, i) => ({ b, i })).filter(x => x.b.target === t), at = idx.findIndex(x => x.b.rule === key), other = idx[at + by]
      if (at < 0 || !other) return a
      const i = idx[at]!.i; [all[i], all[other.i]] = [all[other.i]!, all[i]!]
      return all
    }),
    setAfter: (v: boolean) => setAtts(a => a.map(b => b.rule === key ? { ...b, continue: v } : b)),
  }
  const placeOn = (t: string) => { const list = atts.filter(b => b.target === t); return { place: list.findIndex(b => b.rule === key) + 1, of: list.length, keys: list.map(b => b.rule) } }

  /** Everything on the page in one write: the code, where it runs (and in what order) and on or off. */
  async function save() {
    if (!saved || !rule || busy) return
    setBusy(true)
    try {
      const rules = saved.config.rules.map(r => r.key !== key ? r : source === r.source ? { ...r, enabled } : { key, source, enabled })
      const s = await request<Saved>('/v1/rules', { method: 'PUT', ifMatch: saved.version, body: { ...saved.config, rules, attachments: atts } })
      setSaved(s); reset(s); refresh(); toast(key + ' saved', 'success')
    } catch (e) { toast('Not saved: ' + errorText(e), 'error') }
    finally { setBusy(false) }
  }
  async function remove() {
    await request('/v1/rules/scripts/' + encodeURIComponent(key), { method: 'DELETE', ...(saved ? { ifMatch: saved.version } : {}) })
    refresh(); toast(key + ' deleted', 'success'); navigate(LIST, { replace: true })
  }

  // The agent: it proposes code; nothing reaches the draft until it is accepted, and nothing is saved until Save.
  const settle = (status: 'accepted' | 'rejected') => setMessages(m => m.map(x => x.proposal?.status === 'pending' ? { ...x, proposal: { ...x.proposal, status } } : x))
  async function ask(text: string) {
    const t = text.trim()
    if (!t || thinking) return
    setMessages(m => [...m.map(x => x.proposal?.status === 'pending' ? { ...x, proposal: { ...x.proposal, status: 'rejected' as const } } : x), { id: ++ids.current, role: 'user', text: t }])
    setThinking(true)
    try {
      const r = await request<Assist>('/v1/rules/assist', { method: 'POST', body: { key, source, message: t } })
      const lines = r.source ? diffLines(source, r.source) : []
      const proposal = r.source && r.source !== source && r.ok ? { source: r.source, base: source, status: 'pending' as const, added: lines.filter(l => l.kind === 'add').length, removed: lines.filter(l => l.kind === 'del').length } : undefined
      setMessages(m => [...m, { id: ++ids.current, role: 'agent', text: r.reply, proposal }])
    } catch (e) { setMessages(m => [...m, { id: ++ids.current, role: 'agent', text: errorText(e), failed: true }]) }
    finally { setThinking(false) }
  }
  function accept() {
    if (!pending) return
    setSource(pending.source); setFlash({ lines: changedLines(pending.base, pending.source), at: Date.now() }); settle('accepted')
  }

  // What the code does now, in words, from the checker (what it asks the AI and what it calls).
  const summary = useMemo(() => {
    if (!check) return null
    const q = Object.values(check.questions)
    const to = check.calls.map(c => { const n = endpointName(c), e = endpoints.find(x => x.source === 'endpoint' && x.name === n); return e?.type === 'slack' || e?.type === 'discord' ? n + ' in ' + typeWord[e.type] : e ? 'the ' + n + ' ' + typeWord[e.type].toLowerCase() : n })
    return 'Right now it ' + (q.length ? 'asks the AI “' + q[0] + '”' : 'asks the AI nothing') + (to.length ? ' and sends matches to ' + to.join(', ') : '') + '.'
  }, [check, endpoints])
  // Problems: the checker's, then an AI question on an address whose domain the AI may not read.
  const domains = saved?.config.evaluateDomains ?? []
  const blind = check?.decisions.length ? [...new Set(targets.map(t => addressOf(t).split('@')[1] ?? ''))].filter(d => d && !domains.includes(d)) : []
  const problems = [...(check?.diagnostics ?? []).map(d => ({ where: 'Line ' + d.line, text: d.message + (d.hint ? ' ' + d.hint : '') })), ...blind.map(d => ({ where: 'AI', text: 'The AI can’t read mail at ' + d + '.' }))]

  // Recent mail to its addresses (else any recent mail), one per conversation.
  const watched = new Set(targets.flatMap(t => { const o = opts.find(x => x.id === t); return o ? [o.address, ...o.aliases] : [t] }))
  const emails = useMemo(() => {
    const all = recent.data ?? [], seen = new Set<string>(), ours = all.filter(m => watched.has(ownRecipient(m) ?? ''))
    return (ours.length ? ours : all).filter(m => { const s = m.subject.replace(/^(re|fwd?):\s*/i, '').toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true }).slice(0, 6)
  }, [recent.data, [...watched].join()]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Dry runs src (unsaved, on, as if on the address each email went to) on every email, 350 ms after it changes.
   *  A test never asks the AI: each stored email brings the answer the AI gave when it arrived. */
  function useTests(src: string, on = true) {
    const [results, setResults] = useState<Record<string, { src: string; result?: DryRun; error?: string }>>({})
    const signature = JSON.stringify([src, emails.map(m => m.id), on, !!saved])
    useEffect(() => {
      if (!saved || !src || !emails.length || !on) return
      const ac = new AbortController()
      const timer = setTimeout(() => {
        for (const m of emails) {
          const to = ownRecipient(m) ?? m.to[0] ?? ''
          const config = { ...saved.config, rules: saved.config.rules.map(r => r.key === key ? { key, source: src, enabled: true } : r), attachments: [{ rule: key, target: to, continue: false }] }
          request<DryRun>('/v1/rules/test', { method: 'POST', signal: ac.signal, body: { messageId: m.id, to: [to], config } })
            .then(result => setResults(x => ({ ...x, [m.id]: { src, result } })), e => { if (!ac.signal.aborted) setResults(x => ({ ...x, [m.id]: { src, error: errorText(e) } })) })
        }
      }, 350)
      return () => { clearTimeout(timer); ac.abort() }
    }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
    const outcome = (id: string) => on ? outcomeOf(results[id]?.result, key, endpoints) : null
    const error = (id: string) => results[id]?.error
    // First results in: the list takes its final shape once; later runs swap words in place.
    const counted = on && emails.length > 0 && emails.every(m => results[m.id])
    const pendingRun = on && emails.some(m => results[m.id]?.src !== src)
    return { outcome, error, counted, pending: pendingRun, acted: emails.filter(m => outcome(m.id)?.acted).length }
  }

  return {
    key, saved, loadError, rule, overview, options: opts, endpoints, source, setSource, enabled, setEnabled, busy, dirty,
    status: busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved', save, discard: () => { if (saved) reset(saved) },
    targets, after, draft, placeOn, addressOf, deleting, setDeleting, remove, completions, lint, check, problems, flash,
    messages, thinking, pending, ask, accept, reject: () => settle('rejected'), summary, emails, recentReady: !!recent.data, useTests,
  }
}
type Page = ReturnType<typeof useCodeRule>
type Tests = ReturnType<Page['useTests']>

// ---------------------------------------------------------------- pieces shared by D, E and F
function Header({ p, runsOn = false }: { p: Page; runsOn?: boolean }) {
  const navigate = useNavigate(), phone = usePhone()
  const items: MenuItem[] = [
    { label: 'Sender lists and AI access', onSelect: () => navigate(SHARED_SETTINGS) },
    { label: 'Delete rule', destructive: true, onSelect: () => p.setDeleting(true) },
  ]
  return <>
    <PageHeader title={p.key} backTo={LIST} subtitle={runsOn && !phone ? <RunsOnButton p={p} /> : undefined} actions={<>
      <Button variant="ghost" className="rp-hide" data-hidden={!p.dirty || undefined} disabled={!p.dirty || p.busy} onClick={p.discard}>Discard</Button>
      <span className="cf-status" data-dirty={p.dirty || undefined} role="status">{p.status}</span>
      <Switch checked={p.enabled} onCheckedChange={p.setEnabled} label="On" />
      <Button variant="primary" loading={p.busy} disabled={!p.dirty} onClick={() => void p.save()}>Save</Button>
      <DropdownMenu label={'Actions for ' + p.key} items={items} />
    </>} />
    {runsOn && phone && <div className="cf-runs-row"><RunsOnButton p={p} /></div>}
    <ConfirmDialog open={p.deleting} onOpenChange={p.setDeleting} danger title={'Delete ' + p.key + '?'} description={'It stops running on ' + (p.targets.length === 1 ? 'its address' : 'its ' + p.targets.length + ' addresses') + '.'} confirmLabel="Delete rule" onConfirm={p.remove} />
  </>
}
/** D and E: where it runs, under the title; it opens the same list F has as a tab. */
function RunsOnButton({ p }: { p: Page }) {
  const [open, setOpen] = useState(false)
  const first = p.targets[0], n = p.targets.length
  return <>
    <button type="button" className="cf-runs-button" onClick={() => setOpen(true)}>
      <AtSign size={13} aria-hidden="true" /><span>Runs on</span>{first ? <><Match value={p.addressOf(first)} />{n > 1 && <span>+{n - 1}</span>}</> : <span>no address</span>}<ChevronDown size={13} aria-hidden="true" />
    </button>
    <Dialog open={open} onOpenChange={setOpen} title="Runs on" footer={<Button onClick={() => setOpen(false)}>Done</Button>}><RunsOn p={p} /></Dialog>
  </>
}
function RunsOn({ p }: { p: Page }) {
  const remaining = p.options.filter(o => !o.expiresAt && !p.targets.includes(o.id))
  return <div className="cf-runs">
    <ul className="cf-runs__list" role="list">{p.targets.map(t => {
      const { place, of, keys } = p.placeOn(t), address = p.addressOf(t)
      return <li key={t}>
        <span className="cf-runs__addr"><Match value={address} /><span className="cf-runs__chain" aria-label={ordinal(place) + ' of ' + of + ': ' + keys.join(', then ')}>{keys.map((k, i) => <Fragment key={k}>{i > 0 && <span aria-hidden="true"> → </span>}<span data-self={k === p.key || undefined}>{k}</span></Fragment>)}</span></span>
        <span className="cf-runs__actions">
          <IconButton label={'Run earlier on ' + address} disabled={place <= 1} onClick={() => p.draft.move(t, -1)}><ArrowUp size={14} /></IconButton>
          <IconButton label={'Run later on ' + address} disabled={place >= of} onClick={() => p.draft.move(t, 1)}><ArrowDown size={14} /></IconButton>
          <IconButton label={'Remove ' + address} onClick={() => p.draft.remove(t)}><X size={14} /></IconButton>
        </span>
      </li>
    })}</ul>
    {remaining.length > 0 && <Select className="cf-runs__add" aria-label="Add an address" value="" placeholder="Add an address" onValueChange={v => { if (v) p.draft.add(v) }} options={remaining.map(o => addressOption(o.id, o.address))} />}
    <Field label={OTHER_RULES} htmlFor="cf-after"><Select id="cf-after" value={p.after ? 'next' : 'stop'} onValueChange={v => p.draft.setAfter(v === 'next')} options={[{ value: 'next', label: 'Still run' }, { value: 'stop', label: 'Skipped when this one acts' }]} /></Field>
  </div>
}
function Diagnostics({ p }: { p: Page }) {
  const [open, setOpen] = useState(false)
  const n = p.problems.length, tone = p.check === null ? 'idle' : n ? (p.check.ok ? 'warn' : 'bad') : 'ok'
  useEffect(() => { if (!n) setOpen(false) }, [n])
  return <div className="cf-diag">
    <button type="button" className="cf-diag__button" aria-expanded={n ? open : undefined} disabled={!n} onClick={() => setOpen(!open)}>
      <span className="cf-dot" data-tone={tone} aria-hidden="true" />{p.check === null ? 'Checking' : n ? n + (n === 1 ? ' problem' : ' problems') : 'No problems'}{n > 0 && <ChevronDown size={12} aria-hidden="true" />}
    </button>
    {open && n > 0 && <ul className="cf-diag__list">{p.problems.map((x, i) => <li key={i}><span className="cf-diag__where">{x.where}</span><span>{x.text}</span></li>)}</ul>}
  </div>
}
function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="cf-counts"><span data-kind="add">+{added}</span> <span data-kind="del">−{removed}</span></span>
}
/** The agent's change as a diff: the code it replaces struck through, its new lines marked, numbered as they'll be. */
function DiffBox({ base, next, compact = false }: { base: string; next: string; compact?: boolean }) {
  const lines = diffLines(base.replace(/\n$/, ''), next.replace(/\n$/, ''))
  return <div className="cf-diff" data-compact={compact || undefined} aria-label="Proposed change">{lines.map((l, i) => <div key={i} className="cf-diff__row" data-kind={l.kind}>
    <span className="cf-diff__n" aria-hidden="true">{l.kind === 'del' ? '' : l.line}</span><span className="cf-diff__sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
    {l.kind === 'del' ? <del>{l.text || ' '}</del> : l.kind === 'add' ? <ins>{l.text || ' '}</ins> : <code>{l.text || ' '}</code>}
  </div>)}</div>
}
/** The editor, or, while the agent's change waits (D and E), that change as a diff to accept or reject. */
function CodePanel({ p, diff = true, reply }: { p: Page; diff?: boolean; reply?: string }) {
  const proposal = diff ? p.pending : null
  const calls = p.check?.calls.map(endpointName) ?? []
  const asks = Object.keys(p.check?.questions ?? {}).length
  return <section className="cf-panel cf-code" aria-label="Code">
    <div className="cf-panel__head">
      {proposal ? <>
        <span className="cf-change"><Sparkles size={13} aria-hidden="true" />Agent’s change<Counts added={proposal.added} removed={proposal.removed} /></span>
        <span className="cluster"><Button size="sm" onClick={p.reject}>Reject</Button><Button size="sm" variant="primary" onClick={p.accept}>Accept</Button></span>
      </> : <>
        <code className="cf-sig">route(email, ctx)</code>
        <span className="cf-head-end"><span className="cf-calls">{calls.length ? 'calls ' + calls.join(', ') : ''}{asks ? (calls.length ? ' · ' : '') + asks + (asks === 1 ? ' AI question' : ' AI questions') : ''}</span><Diagnostics p={p} /></span>
      </>}
    </div>
    {proposal && reply && <p className="cf-reply">{reply}</p>}
    <div className="cf-code__body">{proposal ? <DiffBox base={proposal.base} next={proposal.source} /> : <Editor value={p.source} change={p.setSource} completions={p.completions} check={p.lint} flash={p.flash} />}</div>
  </section>
}
/** The current code's results on recent mail and, while a change waits, the change's: what would differ is shown. */
function useTestState(p: Page) {
  const now = p.useTests(p.pending?.source ?? p.source)
  const before = p.useTests(p.source, !!p.pending)
  return { now, before }
}
function TestList({ p, t, bare = false }: { p: Page; t: { now: Tests; before: Tests }; bare?: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  const { now, before } = t
  const first = p.emails.find(m => now.outcome(m.id)?.acted)?.id ?? p.emails[0]?.id
  const shown = open ?? first
  const body = <div className="cf-tests__body">
    {!now.counted ? <ul key="placeholder" className="cf-mails" aria-hidden="true">{p.emails.map(m => <li key={m.id}><div className="cf-mail"><span /><span className="cf-mail__main"><Skeleton width="62%" height={13} /><Skeleton width="38%" height={11} /></span><span /></div></li>)}</ul>
      : <ul key="results" className="cf-mails" role="list">{p.emails.map(m => {
        const o = now.outcome(m.id), b = p.pending ? before.outcome(m.id) : null, err = now.error(m.id), isOpen = shown === m.id
        const changed = !!b && !!o && b.words !== o.words
        return <li key={m.id} data-open={isOpen || undefined}>
          <button type="button" className="cf-mail" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : m.id)}>
            <span className="cf-mail__mark" data-acted={o?.acted || undefined} aria-hidden="true">{o ? o.acted ? <Check size={13} /> : <Minus size={13} /> : null}</span>
            <span className="cf-mail__main">
              <span className="cf-mail__subject">{m.subject || '(no subject)'}</span>
              <span className="cf-mail__result" data-acted={o?.acted || undefined}>{err ? 'Error: ' + err : <>{changed && <><s>{b.acted ? b.words : 'Does nothing'}</s><span aria-hidden="true"> → </span></>}{o ? o.acted ? o.words : 'Does nothing' : ''}</>}</span>
            </span>
            <span className="cf-mail__meta">{o?.ai !== undefined && <span className="cf-mail__ai" title={AI_AT_ARRIVAL}>AI {Math.round(o.ai * 100)}%</span>}<time>{when(m.at)}</time></span>
          </button>
          {isOpen && <p className="cf-mail__detail">From {m.from.name ?? m.from.address} to <Match value={ownRecipient(m) ?? m.to[0] ?? ''} />{o?.ai !== undefined ? ' · the AI answered ' + Math.round(o.ai * 100) + '% when it arrived' : ''}</p>}
        </li>
      })}</ul>}
  </div>
  const count = now.counted ? (p.pending ? 'With the change · acts on ' : 'Acts on ') + now.acted + ' of ' + p.emails.length : ' '
  if (bare) return <div className="cf-tests cf-tests--bare"><div className="cf-tests__bar"><span className="cf-tests__count" data-pending={now.pending || undefined}>{count}</span></div>{body}</div>
  return <section className="cf-panel cf-tests" aria-label="Test">
    <div className="cf-panel__head"><span className="cf-label">Recent mail</span><span className="cf-tests__count" data-pending={now.pending || undefined}>{count}</span></div>
    {body}
  </section>
}
function ProposalCard({ p, proposal, inline, onReview }: { p: Page; proposal: Proposal; inline: boolean; onReview?: () => void }) {
  const state = { pending: inline ? 'In the editor' : 'Not applied', accepted: inline ? 'Accepted' : 'Applied', rejected: inline ? 'Rejected' : 'Dismissed' }[proposal.status]
  return <div className="cf-proposal" data-status={proposal.status}>
    <div className="cf-proposal__head"><span className="cf-change"><CodeXml size={13} aria-hidden="true" />Change<Counts added={proposal.added} removed={proposal.removed} /></span><span className="cf-proposal__state">{state}</span></div>
    {!inline && proposal.status === 'pending' && <DiffBox base={proposal.base} next={proposal.source} compact />}
    {proposal.status === 'pending' && (!inline
      ? <div className="cf-proposal__actions"><Button size="sm" onClick={p.reject}>Dismiss</Button><Button size="sm" variant="primary" onClick={p.accept}>Apply</Button></div>
      : onReview ? <div className="cf-proposal__actions"><Button size="sm" onClick={onReview}>Review</Button></div> : null)}
  </div>
}
/** The conversation. With composer, its own input (D, F); without, the command bar is the input (E). */
function Chat({ p, inline, onReview, composer = true }: { p: Page; inline: boolean; onReview?: () => void; composer?: boolean }) {
  const [text, setText] = useState('')
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }) }, [p.messages.length, p.thinking])
  const submit = (event?: FormEvent) => { event?.preventDefault(); if (!text.trim()) return; void p.ask(text); setText('') }
  return <div className="cf-chat">
    <div className="cf-chat__list" ref={list}>
      <div className="cf-msg cf-msg--agent cf-greet">{p.summary ? <p>{p.summary}</p> : <><Skeleton width="92%" height={13} /><Skeleton width="60%" height={13} /></>}</div>
      {p.messages.map(m => m.role === 'user'
        ? <div key={m.id} className="cf-msg cf-msg--user"><p>{m.text}</p></div>
        : <div key={m.id} className="cf-msg cf-msg--agent" data-failed={m.failed || undefined}><p>{m.text}</p>{m.proposal && <ProposalCard p={p} proposal={m.proposal} inline={inline} onReview={onReview} />}</div>)}
      {p.thinking && <div className="cf-msg cf-msg--agent cf-thinking" role="status"><span className="cf-thinking__dot" aria-hidden="true" />Writing the code…</div>}
      {!p.messages.length && <div className="cf-suggest" role="group" aria-label="Try">{SUGGESTIONS.map(s => <button key={s} type="button" className="cf-suggest__item" onClick={() => void p.ask(s)}>{s}</button>)}</div>}
    </div>
    {composer && <form className="cf-compose" onSubmit={submit}>
      <Textarea rows={2} value={text} aria-label="Ask the agent" placeholder={ASK} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
      <Button variant="primary" size="sm" type="submit" disabled={!text.trim() || p.thinking} aria-label="Send"><ArrowUp size={14} aria-hidden="true" /></Button>
    </form>}
  </div>
}
function AgentHead() {
  return <div className="cf-panel__head"><span className="cf-label"><Sparkles size={13} aria-hidden="true" />Agent</span></div>
}

// ---------------------------------------------------------------- D · Pair
function PairVersion({ p }: { p: Page }) {
  const phone = usePhone()
  const [tab, setTab] = useState<'code' | 'agent'>('code')
  const t = useTestState(p)
  return <div className="stack inbound-stack cf cf-d">
    <Header p={p} runsOn />
    {phone && <Tabs label="Show" value={tab} onValueChange={v => setTab(v as 'code' | 'agent')} items={[{ value: 'code', label: 'Code' }, { value: 'agent', label: p.pending ? 'Agent · 1 change' : 'Agent' }]} />}
    <div className="cf-grid cf-d__grid">
      <div className="cf-d__main" hidden={phone && tab !== 'code'}><CodePanel p={p} /><TestList p={p} t={t} /></div>
      <section className="cf-panel cf-d__side" aria-label="Agent" hidden={phone && tab !== 'agent'}><AgentHead /><Chat p={p} inline onReview={phone ? () => setTab('code') : undefined} /></section>
    </div>
  </div>
}

// ---------------------------------------------------------------- E · Command
function CommandBar({ p, onHistory }: { p: Page; onHistory?: () => void }) {
  const [text, setText] = useState(''), phone = usePhone()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <form className="cf-command" onSubmit={e => { e.preventDefault(); if (!text.trim()) return; void p.ask(text); setText('') }}>
    <Sparkles size={15} className="cf-command__icon" aria-hidden="true" />
    <input ref={input} className="cf-command__input" value={text} onChange={e => setText(e.target.value)} placeholder={phone ? 'Describe the rule…' : ASK} aria-label="Ask the agent" autoComplete="off" />
    {p.thinking ? <span className="cf-command__state" role="status">Writing…</span> : <kbd className="cf-kbd" aria-hidden="true">⌘K</kbd>}
    {onHistory && <Button size="sm" variant="ghost" onClick={onHistory}>History</Button>}
    <Button size="sm" variant="primary" type="submit" disabled={!text.trim() || p.thinking}>Ask</Button>
  </form>
}
function CommandVersion({ p }: { p: Page }) {
  const phone = usePhone()
  const [history, setHistory] = useState(false)
  const t = useTestState(p)
  const reply = p.pending ? [...p.messages].reverse().find(m => m.role === 'agent')?.text : undefined
  return <div className="stack inbound-stack cf cf-e">
    <Header p={p} runsOn />
    <div className="cf-grid cf-e__grid">
      <div className="cf-e__main">
        <CommandBar p={p} onHistory={phone ? () => setHistory(true) : undefined} />
        <CodePanel p={p} reply={reply} />
        {phone && <TestList p={p} t={t} />}
      </div>
      {!phone && <div className="cf-e__side">
        <TestList p={p} t={t} />
        <section className="cf-panel" aria-label="Conversation"><AgentHead /><Chat p={p} inline composer={false} /></section>
      </div>}
    </div>
    {phone && <Sheet open={history} onOpenChange={setHistory} title="Agent" className="cf-sheet"><Chat p={p} inline composer={false} /></Sheet>}
  </div>
}

// ---------------------------------------------------------------- F · Tabs
function TabsVersion({ p }: { p: Page }) {
  const phone = usePhone()
  // A phone opens on the code; a wide screen shows the code anyway and opens the side on the agent.
  const [chosen, setTab] = useState<'code' | 'agent' | 'test' | 'runs'>(() => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches ? 'code' : 'agent')
  const tab = !phone && chosen === 'code' ? 'agent' : chosen
  const t = useTestState(p)
  const testLabel = t.now.counted ? 'Test · ' + t.now.acted + '/' + p.emails.length : 'Test'
  const items = [...(phone ? [{ value: 'code', label: 'Code' }] : []), { value: 'agent', label: p.pending ? 'Agent · 1' : 'Agent' }, { value: 'runs', label: 'Runs on · ' + p.targets.length }, { value: 'test', label: testLabel }]
  const pick = (v: string) => setTab(v as typeof chosen)
  return <div className="stack inbound-stack cf cf-f">
    <Header p={p} />
    {phone && <Tabs label="Show" value={tab} onValueChange={pick} items={items} />}
    <div className="cf-grid cf-f__grid">
      <div className="cf-f__main" hidden={phone && tab !== 'code'}><CodePanel p={p} diff={false} /></div>
      <section className="cf-panel cf-f__side" aria-label="Side panel" hidden={phone && tab === 'code'}>
        {!phone && <div className="cf-panel__head cf-f__tabs"><Tabs label="Side panel" value={tab} onValueChange={pick} items={items} /></div>}
        {tab === 'agent' && <Chat p={p} inline={false} />}
        {tab === 'test' && <TestList p={p} t={t} bare />}
        {tab === 'runs' && <div className="cf-f__runs"><RunsOn p={p} /></div>}
      </section>
    </div>
  </div>
}

// ---------------------------------------------------------------- the page
export function CodeRulePitch({ ruleKey: key, v }: { ruleKey: string; v: 'd' | 'e' | 'f' }) {
  const p = useCodeRule(key)
  if (p.loadError) return <div className="stack inbound-stack"><PageHeader title={key} backTo={LIST} /><ErrorState error={p.loadError} onRetry={() => location.reload()} /></div>
  if (!p.saved || !p.overview.data || !p.options.length || !p.recentReady) return <div className="stack inbound-stack cf"><PageHeader title={key} backTo={LIST} /><div className="cf-loading" aria-busy="true"><Skeleton width="60%" height={18} /><Skeleton width="40%" height={18} /></div></div>
  if (!p.rule) return <div className="stack inbound-stack"><PageHeader title={key} backTo={LIST} /><EmptyState title={'No rule named ' + key} action={<Link className="ui-button ui-button--secondary ui-button--md" to={LIST}>Rules</Link>} /></div>
  return v === 'd' ? <PairVersion p={p} /> : v === 'e' ? <CommandVersion p={p} /> : <TabsVersion p={p} />
}
