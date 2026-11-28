// The flow every receiving screen draws, top to bottom: Receive (the address) → Process (its rules) → Deliver (its
// destinations). The address panel and an address's page show it, and a test marks the path one email took: what it
// took is ticked, the rest goes quiet. Neutral throughout: the accent is for buttons and charts.
import { useState, type FormEvent, type ReactNode } from 'react'
import { AtSign, Check, Send, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import { Alert, Checkbox, Field, Input, LoadingRegion, Select, StatusDot, Textarea } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { request } from '../../data/live'
import { errorText, type InboundAddress } from '../../data/types'
import { kindNote, outcomes, steps } from './concepts'
import { expiresIn, type Overview, type OverviewRule, type RouteEntry, type Target } from './overview'
import { Match, TargetIcon, targetName } from './parts'
import { RuleLine } from './recipes'
import { endpointStatusLabel, endpointStatusTone } from './ritual-connections'
import { receivingStatus } from './status'
import type { DryRun, TraceRecipient, TraceRow } from './trace'

export type StageKind = 'receive' | 'process' | 'deliver'
const stageIcons: Record<StageKind, LucideIcon> = { receive: AtSign, process: Workflow, deliver: Send }
/** The three stages' icons, the same on every screen: an address receives, a rule processes, a destination delivers. */
export function StageIcon({ kind, size = 14 }: { kind: StageKind; size?: number }) {
  const Icon = stageIcons[kind]
  return <Icon className="rcv-icon" size={size} aria-hidden="true" />
}

/** A test's verdict on one step: taken (true), passed by (false), or no test yet (undefined). */
export type Hit = boolean | undefined
const hitOf = (hit: Hit) => hit === undefined ? undefined : hit ? 'yes' : 'no'

export function Flow({ label, tested, children }: { label: string; tested?: boolean; children: ReactNode }) {
  return <ol className="flow" aria-label={label} data-tested={tested || undefined}>{children}</ol>
}
export function FlowStage({ kind, title = steps[kind].title, children }: { kind: StageKind; title?: ReactNode; children: ReactNode }) {
  return <li className="flow-stage" data-kind={kind}>
    <div className="flow-stage__head"><StageIcon kind={kind} /><span className="flow-stage__title">{title}</span></div>
    <div className="flow-stage__body">{children}</div>
  </li>
}
/** Where a rule splits the mail: two destination slots side by side under a fork (one above the other on a phone),
 *  each with its own label, "If yes" and "Otherwise". It stands in the flow where the Destinations stage would. */
export function FlowFork({ labels, yes, no }: { labels: [string, string]; yes: ReactNode; no: ReactNode }) {
  return <li className="flow-fork">
    <div className="flow-fork__ways">
      {[yes, no].map((slot, i) => <div key={i} className="flow-stage flow-fork__way" data-kind="deliver">
        <div className="flow-stage__head"><StageIcon kind="deliver" /><span className="flow-stage__title">{labels[i]}</span></div>
        <div className="flow-stage__body">{slot}</div>
      </div>)}
    </div>
  </li>
}
/** One line in a stage: an icon, what it is (a quieter note under it), and its status at the end, or a tick once a test took it. */
export function FlowItem({ icon, children, note, aside, hit }: { icon?: ReactNode; children: ReactNode; note?: ReactNode; aside?: ReactNode; hit?: Hit }) {
  return <div className="flow-item" data-hit={hitOf(hit)}>
    {icon ? <span className="flow-item__icon">{icon}</span> : null}
    <span className="flow-item__text"><span className="flow-item__main">{children}</span>{note ? <span className="flow-item__note">{note}</span> : null}</span>
    {hit ? <span className="flow-item__aside"><Check className="flow-item__tick" size={14} aria-label="Taken" /></span> : aside ? <span className="flow-item__aside">{aside}</span> : null}
  </div>
}

// ---------------------------------------------------------------- what a flow says, from the overview's one read

/** A destination's health, when it has one: ready, waiting for its recipient, paused or declined. */
export function Health({ status }: { status: Target['status'] }) {
  if (!status) return null
  return <StatusDot tone={endpointStatusTone[status]} muted={status === 'ready'}>{endpointStatusLabel[status]}</StatusDot>
}
const local = (value: string) => value.slice(0, value.indexOf('@') + 1)
/** What a row receives besides its own address, in a few words. */
function receiveNote(entry: RouteEntry): ReactNode {
  const a = entry.address
  if (entry.kind === 'catch_all') return 'Catch-all'
  if (entry.kind === 'pattern') return a ? <>Wildcard for <PrivateAddress value={a.address} /></> : kindNote.pattern
  if (entry.kind === 'route') return kindNote.route
  if (entry.kind === 'inbox') return [kindNote.inbox, expiresIn(a?.expiresAt)].filter(Boolean).join(' · ')
  if (a?.origin === 'auto') return kindNote.auto
  // Aliases and wildcards by their part before the @, as the list writes them: an address stays masked until revealed.
  const also = [...(a?.aliases ?? []), ...(a?.rules ?? [])].map(local)
  return [a?.displayName, a?.expiresAt ? expiresIn(a.expiresAt) : null, also.length ? `also ${also.join(', ')}` : null].filter(Boolean).join(' · ') || null
}

const aiUndecided = 'Decided by AI when real mail arrives'
/** What one test run did for one recipient: where its mail went and which rules acted. */
/** What one test run did for one recipient; assumed: the AI answer a test took for its AI decisions, when one was chosen. */
export type TestOutcome = { recipient: TraceRecipient | null; rows: TraceRow[]; assumed?: 'yes' | 'no' }
export const outcomeOf = (result: DryRun, address: string, assumed?: 'yes' | 'no'): TestOutcome => ({
  recipient: result.recipients.find(r => r.address === address) ?? result.recipients[0] ?? null,
  rows: result.trace.filter(row => row.recipient === address),
  ...(assumed ? { assumed } : {}),
})
const reached = (t: Target, r: TraceRecipient) => t.type === 'inbox' ? !!t.id && (r.inboxes ?? []).includes(t.id)
  : t.type === 'drop' ? !!r.dropped
  : t.type === 'store' || t.type === 'create_address' ? !r.dropped && !(r.inboxes ?? []).length && !(r.webhooks ?? []).length
  : !!t.id && (r.webhooks ?? []).includes(t.id)

/** One side of a two-way rule as the flow draws it: its destination's name, icon and health, and whether a test took it. */
type Side = { type: Target['type']; name: ReactNode; status: Target['status']; hit: (r: TraceRecipient) => boolean }
function sideOf(param: string | undefined, entry: RouteEntry, overview: Overview, boxes: InboundAddress[]): Side {
  if (!param || param === 'store') return { type: 'store', name: outcomes.store, status: null, hit: r => !r.dropped && !(r.inboxes ?? []).length && !(r.webhooks ?? []).length }
  if (param === 'drop') return { type: 'drop', name: outcomes.drop, status: null, hit: r => !!r.dropped }
  if (param.startsWith('inbox:')) {
    const key = param.slice(6), box = entry.address?.key === key ? entry.address : boxes.find(b => b.key === key)
    const name = box?.id === entry.address?.id ? 'Its inbox' : box ? box.displayName ? `${box.displayName} inbox` : <><PrivateAddress value={box.address} /> inbox</> : `The ${key} inbox`
    return { type: 'inbox', name, status: null, hit: r => !!box && (r.inboxes ?? []).includes(box.id) }
  }
  const e = overview.endpoints.find(x => x.source === 'endpoint' && x.name === param)
  return { type: e?.type ?? 'webhook', name: param, status: e?.status ?? null, hit: r => !!e && (r.webhooks ?? []).includes(e.id) }
}
export const isSplit = (rule?: Pick<OverviewRule, 'recipe'>) => !!rule?.recipe && (rule.recipe.id === 'split' || rule.recipe.id === 'split-by-meaning')
/** The two-way rule an address's flow draws (and the builder changes): the first in the order its rules run. */
export const splitOf = (entry: Pick<RouteEntry, 'rules'>, overview: Pick<Overview, 'rules'>) => entry.rules.map(key => overview.rules.find(r => r.key === key)).find(isSplit)

/** The flow of one address, catch-all or wildcard, from the overview's row; a test outcome marks the path taken. An
 *  address whose mail a two-way rule splits draws the fork the builder makes: its two destinations side by side. */
export function EntryFlow({ entry, overview, outcome, boxes = [] }: { entry: RouteEntry; overview: Overview; outcome?: TestOutcome | null; boxes?: InboundAddress[] }) {
  const rules = new Map(overview.rules.map(r => [r.key, r]))
  const split = splitOf(entry, overview)
  const params = split?.recipe?.params ?? {}, one = (v: unknown) => typeof v === 'string' ? v : undefined
  const ways = split && (split.recipe!.id === 'split-by-meaning' || params.test !== 'always') ? [sideOf(one(params.then), entry, overview, boxes), sideOf(one(params.otherwise), entry, overview, boxes)] : null
  const single = split && !ways ? sideOf(one(params.then), entry, overview, boxes) : null
  // What the fork (or the one way) delivers is said there; the rest of the address's destinations stay listed.
  const drawn = (t: Target) => !!split && (t.via === split.key || t.type === 'store')
  const rest = entry.to.filter(t => !drawn(t))
  const domain = overview.domains.find(d => d.name === entry.host)
  const r = outcome?.recipient ?? null, tested = !!r
  const acted = new Set((outcome?.rows ?? []).filter(row => row.actions.length > 0).map(row => row.key))
  const failed = new Map((outcome?.rows ?? []).filter(row => row.error).map(row => [row.key, row.error!]))
  return <Flow label="Mail flow" tested={tested}>
    <FlowStage kind="receive">
      <FlowItem note={receiveNote(entry)} hit={tested || undefined}
        aside={domain && domain.status !== 'active' ? <StatusDot tone={receivingStatus[domain.status].tone}>{receivingStatus[domain.status].label}</StatusDot> : undefined}>
        <Match value={entry.match} />
      </FlowItem>
    </FlowStage>
    <FlowStage kind="process">
      {entry.rules.length ? entry.rules.map(key => {
        const rule = rules.get(key)
        return <FlowItem key={key} hit={tested ? acted.has(key) : undefined} note={failed.get(key)} aside={rule && !rule.enabled ? <StatusDot tone="neutral" muted>Off</StatusDot> : undefined}>
          <RuleLine rule={rule} keyName={key} endpoints={overview.endpoints} />
        </FlowItem>
      }) : <FlowItem><span className="muted">{steps.process.empty}</span></FlowItem>}
    </FlowStage>
    {ways && <FlowFork labels={['If yes', 'Otherwise']} yes={<SideItem side={ways[0]!} r={r} />} no={<SideItem side={ways[1]!} r={r} />} />}
    {(!ways || rest.length > 0) && <FlowStage kind="deliver" title={ways ? 'Also' : undefined}>
      {single && <SideItem side={single} r={r} />}
      {rest.map(t => <FlowItem key={`${t.type}:${t.id}`} icon={<TargetIcon type={t.type} />} hit={r ? reached(t, r) : undefined}
        aside={<Health status={t.status} />}>
        {t.type === 'inbox' && t.id !== entry.address?.id ? <><PrivateAddress value={t.name} /> inbox</> : t.type === 'inbox' ? 'Its inbox' : <PrivateAddress value={targetName(t, entry.address?.id)} />}
        {/* A rule's destination gets only the mail that rule sends it. */}
        {t.via && <span className="flow-via">via a rule</span>}
      </FlowItem>)}
      {entry.toTruncated && <FlowItem><span className="muted">+{entry.toTotal - entry.to.length} more webhooks</span></FlowItem>}
    </FlowStage>}
  </Flow>
}
function SideItem({ side, r }: { side: Side; r: TraceRecipient | null }) {
  return <FlowItem icon={<TargetIcon type={side.type} />} hit={r ? side.hit(r) : undefined} aside={<Health status={side.status} />}>{side.name}</FlowItem>
}

const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)).join('.*') + '$')
/** How a recipient was matched, in a few words: its own address, a wildcard, the catch-all. */
function matchedBy(r: TraceRecipient, overview: Overview, addresses: Pick<InboundAddress, 'address' | 'rules'>[]): ReactNode {
  const routeRow = r.route ? overview.routes.data.find(e => e.route?.id === r.route) : undefined
  const wildcard = routeRow?.match ?? addresses.flatMap(a => a.rules).find(rule => glob(rule).test(r.address))
  if (r.tier === 'pattern') return wildcard ? <>Caught by the wildcard <Match value={wildcard} /></> : 'Caught by a wildcard'
  if (r.tier === 'subaddress') return 'Caught by its address without the +tag'
  if (r.tier === 'catchall') return 'Caught by the catch-all'
  if (r.tier === 'default') return r.domainDefault === 'create_address' ? 'The catch-all creates it' : 'The catch-all keeps it'
  return null
}
/** The path one email took, from a test: where it was received and how, the rules that ran (ticked when they acted),
 *  and where it was delivered. Until the test answers it is one loading block, replaced whole (a stage that grew as
 *  its rules arrived would push the next one down); the caller says what failed. */
export function OutcomeFlow({ address, overview, outcome, error, addresses = [], unasked = false }: { address: string; overview: Overview; outcome: TestOutcome | null; error: string | null; addresses?: InboundAddress[]; unasked?: boolean }) {
  const r = outcome?.recipient ?? null
  // A test never asks the AI (unasked): a rule that read an AI answer got its fallback, so neither it nor where the mail
  // went is ticked, and Destinations says the AI decides on real mail.
  // With an answer chosen for the test (Sample → The AI says), the result is real for that answer and says so.
  const readsAi = (row: TraceRow) => row.timeline.some(step => step.kind === 'decisions')
  const byAi = (row: TraceRow) => unasked && !outcome?.assumed && readsAi(row)
  const undecided = !!r && (outcome?.rows ?? []).some(byAi)
  const assumedNote = (row: TraceRow) => outcome?.assumed && readsAi(row) ? (outcome.assumed === 'yes' ? 'If the AI says yes' : 'If the AI says no') : undefined
  if (!r && !error) return <LoadingRegion label="Testing"><div className="flow-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion>
  return <Flow label="Mail flow" tested={!!r}>
    <FlowStage kind="receive"><FlowItem hit={r ? true : undefined} note={r ? matchedBy(r, overview, addresses) : undefined}><Match value={r?.address ?? address} /></FlowItem></FlowStage>
    <FlowStage kind="process">{!r ? <FlowItem><span className="muted">—</span></FlowItem> : outcome!.rows.length ? outcome!.rows.map(row => <FlowItem key={row.key} hit={byAi(row) ? undefined : row.actions.length > 0} note={row.error ?? assumedNote(row)}><RuleLine rule={overview.rules.find(x => x.key === row.key)} keyName={row.key} endpoints={overview.endpoints} /></FlowItem>)
      : <FlowItem><span className="muted">{steps.process.empty}</span></FlowItem>}</FlowStage>
    <FlowStage kind="deliver">{!r ? <FlowItem><span className="muted">—</span></FlowItem> : undecided ? <FlowItem icon={<Sparkles className="rcv-icon" size={16} aria-hidden="true" />}><span className="muted">{aiUndecided}</span></FlowItem> : <Delivered recipient={r} overview={overview} addresses={addresses} />}</FlowStage>
  </Flow>
}

/** Where a test's mail went, by name: inboxes, destinations, or stored or dropped. */
export function Delivered({ recipient: r, overview, addresses = [] }: { recipient: TraceRecipient; overview: Overview; addresses?: InboundAddress[] }) {
  const inboxes = new Map([...overview.routes.data.flatMap(e => e.address ? [e.address] : []), ...addresses].map(a => [a.id, a]))
  const ends = overview.endpoints
  if (r.dropped) return <FlowItem icon={<TargetIcon type="drop" />} hit>{outcomes.drop}</FlowItem>
  const items = [
    ...(r.inboxes ?? []).map(id => <FlowItem key={id} icon={<TargetIcon type="inbox" />} hit>{(box => !box ? 'An inbox' : box.displayName ? `${box.displayName} inbox` : <><PrivateAddress value={box.address} /> inbox</>)(inboxes.get(id))}</FlowItem>),
    ...(r.webhooks ?? []).map(id => { const e = ends.find(x => x.id === id); return <FlowItem key={id} icon={<TargetIcon type={e?.type ?? 'webhook'} />} hit>{e?.name ?? 'A destination'}</FlowItem> }),
  ]
  return <>{items.length ? items : <FlowItem icon={<TargetIcon type="store" />} hit>{outcomes.store}</FlowItem>}
    {!!r.labels?.length && <FlowItem><span className="muted">Labeled {r.labels.join(', ')}</span></FlowItem>}
    {r.junk && <FlowItem><span className="muted">Kept as junk</span></FlowItem>}</>
}

// ---------------------------------------------------------------- test: send a sample and see where it goes

/** A test's sample email; attachment adds a small file, ai the answer its AI decisions take (unset: not asked, so not decided). */
export type Sample = { from: string; subject: string; text: string; attachment?: boolean; ai?: 'yes' | 'no' }
export const defaultSample: Sample = { from: 'dana@example.net', subject: 'Refund for order 4821', text: 'Hi, the blender arrived broken. Could I get a refund? Order 4821.' }
const mimeOf = (to: string, s: Sample) => {
  const head = ['From: ' + s.from, 'To: ' + to, 'Subject: ' + s.subject.replace(/[\r\n]+/g, ' '), 'Message-ID: <sample@example.net>', 'MIME-Version: 1.0']
  if (!s.attachment) return [...head, 'Content-Type: text/plain; charset=utf-8', '', s.text].join('\r\n')
  return [...head, 'Content-Type: multipart/mixed; boundary="sample"', '', '--sample', 'Content-Type: text/plain; charset=utf-8', '', s.text, '--sample',
    'Content-Type: text/plain; name="receipt.txt"', 'Content-Disposition: attachment; filename="receipt.txt"', '', 'Order 4821', '--sample--', ''].join('\r\n')
}
/** The address a test sends to for a row: its own, or one its wildcard or catch-all would catch. */
export const testAddress = (match: string) => match.startsWith('*@') ? 'someone' + match.slice(1) : match.replace(/\*/g, 'test')

/** Runs the dry run (testRules) for one address with a sample email: nothing is sent or saved, and the AI isn't asked. */
export function useFlowTest() {
  const [state, setState] = useState<{ address: string; outcome: TestOutcome | null; error: string | null; pending: boolean } | null>(null)
  // decisions: the questions the address's rules ask the AI, answered with the sample's chosen answer (1 yes, 0 no).
  async function run(address: string, sample: Sample, decisions: string[] = []) {
    setState({ address, outcome: null, error: null, pending: true })
    try {
      const assumed = sample.ai && decisions.length ? sample.ai : undefined
      const scores = assumed ? Object.fromEntries(decisions.map(name => [name, assumed === 'yes' ? 1 : 0])) : undefined
      const result = await request<DryRun>('/v1/rules/test', { method: 'POST', body: { mime: mimeOf(address, sample), ...(scores ? { scores } : {}) } })
      setState({ address, outcome: outcomeOf(result, address, assumed), error: null, pending: false })
    } catch (error) { setState({ address, outcome: null, error: errorText(error), pending: false }) }
  }
  return { address: state?.address ?? null, outcome: state?.outcome ?? null, error: state?.error ?? null, pending: state?.pending ?? false, run, clear: () => setState(null) }
}
export type FlowTest = ReturnType<typeof useFlowTest>
const aiAnswers = [{ value: 'unset', label: 'Not set' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
/** The sample a test sends: a refund request unless changed. One line until opened. ai: the address's rules ask the AI,
 *  so the answer a test assumes can be chosen (a test never asks it). */
export function SampleFields({ sample, onChange, disabled, id = 'flow-sample', ai = false }: { sample: Sample; onChange: (next: Sample) => void; disabled?: boolean; id?: string; ai?: boolean }) {
  return <details className="flow-sample">
    <summary>Sample: <span className="flow-sample__subject">{sample.subject || '(no subject)'}</span>{sample.attachment && <span className="muted"> · attachment</span>}{ai && sample.ai && <span className="muted"> · AI says {sample.ai}</span>}</summary>
    <div className="stack flow-sample__fields">
      <Field label="From" htmlFor={id + '-from'}><Input id={id + '-from'} value={sample.from} disabled={disabled} onChange={e => onChange({ ...sample, from: e.target.value })} autoComplete="off" /></Field>
      <Field label="Subject" htmlFor={id + '-subject'}><Input id={id + '-subject'} value={sample.subject} disabled={disabled} onChange={e => onChange({ ...sample, subject: e.target.value })} autoComplete="off" /></Field>
      <Field label="Text" htmlFor={id + '-text'}><Textarea id={id + '-text'} rows={3} value={sample.text} disabled={disabled} onChange={e => onChange({ ...sample, text: e.target.value })} /></Field>
      <Checkbox checked={!!sample.attachment} disabled={disabled} onCheckedChange={on => onChange({ ...sample, attachment: on === true })} label="With an attachment" />
      {ai && <Field label="The AI says" htmlFor={id + '-ai'}><Select id={id + '-ai'} value={sample.ai ?? 'unset'} disabled={disabled} onValueChange={v => onChange({ ...sample, ai: v === 'unset' ? undefined : v as 'yes' | 'no' })} options={aiAnswers} /></Field>}
    </div>
  </details>
}
/** Test: the sample it sends, and what went wrong when it didn't run. The Test button sits with the panel's actions. */
export function TestBar({ address, test, sample, onSample, id = 'flow-test', decisions = [] }: { address: string; test: FlowTest; sample: Sample; onSample: (next: Sample) => void; id?: string; decisions?: string[] }) {
  const submit = (event: FormEvent) => { event.preventDefault(); void test.run(address, sample, decisions) }
  // Its id names the form its Test button submits: two panels on one screen (the builder over the list) each have their own.
  return <form className="flow-test" id={id} onSubmit={submit}>
    <SampleFields id={id + '-sample'} sample={sample} onChange={next => { onSample(next); test.clear() }} disabled={test.pending} ai={decisions.length > 0} />
    {test.error && test.address === address && <Alert tone="danger">{test.error}</Alert>}
  </form>
}
