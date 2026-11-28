import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Alert, Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Input, KeyValues, LoadingRegion, PageHeader, Select, SkeletonText, Tabs, useToast, fieldError, MutationError } from '../../components/ui'
import { useApiMutation, useApiQuery, useRequestScope, useWorkspaceAccess } from '../../data/context'
import { addressForget, cancelOwnQueries, forgetResource, invalidate } from '../../data/invalidation'
import { date, number } from '../../lib/format'
import { AddressMail } from './threads'
import { FlowPanel } from './panel'
import { AddressBuilder, builderFits } from './builder'
import { isSplit } from './flow'
import { isAbortError, request } from '../../data/live'
import { ApiError, errorText, type InboundAddress, type InboundAddressPatch, type MailRoute } from '../../data/types'
import { AliasEditor, aliasState, commitAliases, type AliasState } from './aliases'
import { steps } from './concepts'
import { typeLabel, useOverview } from './overview'
import { Match, RitualIcon, TargetIcon, targetName } from './parts'
import { RuleLine } from './recipes'
import { rulePath, splitBuilderPath } from './shared'
import { RouteEditor } from './routing'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSingleFlight } from '../../lib/single-flight'
import { RITUALS_PER_ADDRESS } from '../../../../api/src/ritual-schema'

// `base` is the saved address the edit started from, so a just-saved form doesn't wait on the refetch.
type AddressForm = { base: InboundAddress; displayName: string; aliases: AliasState }
const formOf = (address: InboundAddress): AddressForm => ({ base: address, displayName: address.displayName ?? '', aliases: aliasState(address.aliases) })
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

type RuleConfig = { version: number; config: { attachments: { rule: string; target: string; continue: boolean }[] } }

/** Address → Rules → Destinations for one address, with what can be done at each step right there. Its aliases and
 *  wildcards are edited in one place, its Settings tab. */
function AddressPath({ address, overview }: { address: InboundAddress; overview: ReturnType<typeof useOverview> }) {
  const toast = useToast()
  const entry = overview.data?.routes.data.find(r => r.address?.id === address.id)
  const [ritual, setRitual] = useState('')
  const scope = useRequestScope()
  const [busy, setBusy] = useState(false)
  const [routing, setRouting] = useState(false)
  // Single flight: attaching reads the saved version and writes against it, so a second click would conflict with the first.
  type Attachments = RuleConfig['config']['attachments']
  const attach = useSingleFlight('rules.attachments', async (change: (list: Attachments) => Attachments, done: string, undo?: (list: Attachments) => Attachments) => {
    setBusy(true)
    try {
      const current = await request<RuleConfig>('/v1/rules', { scope })
      await request('/v1/rules/attachments', { method: 'PUT', body: { attachments: change(current.config.attachments) }, ifMatch: current.version, scope })
      // Detaching changes how live mail is handled: Undo puts the rule back where it was.
      toast(done, 'success', undo ? { action: { label: 'Undo', onSelect: () => void attach(undo, 'Rule put back.') } } : undefined); setRitual(''); await overview.refetch()
    } catch (e) { if (!isAbortError(e)) toast(errorText(e), 'error') } finally { setBusy(false) }
  }, address.id)
  const detach = (key: string) => void attach(list => list.filter(b => !(b.rule === key && b.target === address.id)), 'Rule detached.', list => {
    if (list.some(b => b.rule === key && b.target === address.id)) return list
    const before = attachedNow.indexOf(key), after = attachedNow[before + 1]
    const at = after ? list.findIndex(b => b.rule === after && b.target === address.id) : -1
    const entry = { rule: key, target: address.id, continue: !!overview.data?.rules.find(r => r.key === key)?.recipe }
    return at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)]
  })
  const attached = entry?.rules ?? [], attachedNow = attached
  const available = (overview.data?.rules ?? []).filter(r => !attached.includes(r.key))
  // A rule opens on its page, its code. A two-way rule that runs only here (the address builder's) opens the builder on it.
  const ruleLink = (k: string) => {
    const r = overview.data?.rules.find(x => x.key === k)
    return (r?.recipe?.id === 'split' || r?.recipe?.id === 'split-by-meaning' ? splitBuilderPath(k, r.attachedTo, [address]) : null) ?? rulePath(k)
  }
  return <div className="addr-path" aria-label="How mail to this address is handled">
    <section className="addr-step" id="route">
      <h2>{steps.receive.title}</h2>
      <ul>
        <li><Match value={address.address} /></li>
        {address.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
        {address.rules.map(r => <li key={r}><Match value={r} /><span className="muted">wildcard</span></li>)}
      </ul>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="rules">
      <h2>{steps.process.title}</h2>
      {!entry ? <SkeletonText width="50%" /> : attached.length ? <ul>{attached.map((k, i) => <li key={k}><RitualIcon /><Link className="addr-rule" to={ruleLink(k)}><RuleLine rule={overview.data?.rules.find(r => r.key === k)} keyName={k} endpoints={overview.data?.endpoints} /></Link>{i < attached.length - 1 && <span className="addr-then">then</span>}<span className="addr-grow" />
        <IconButton size="sm" label={`Detach ${k}`} disabled={busy} onClick={() => detach(k)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>
        : <p className="addr-step__empty">{steps.process.empty}</p>}
      <div className="addr-step__foot">
        {available.length > 0 && <div className="addr-step__actions">
          <Select aria-label="Rule to attach" value={ritual} onValueChange={setRitual} options={[{ value: '', label: 'Attach a rule…' }, ...available.map(r => ({ value: r.key, text: r.key, label: <RuleLine rule={r} keyName={r.key} endpoints={overview.data?.endpoints} /> }))]} />
          <Button size="sm" disabled={!ritual || busy || attached.length >= RITUALS_PER_ADDRESS} onClick={() => void attach(list => [...list, { rule: ritual, target: address.id, continue: !!available.find(r => r.key === ritual)?.recipe }], `${ritual} attached.`)}>Attach</Button>
        </div>}
        <div className="addr-step__actions"><Link className="ui-button ui-button--ghost ui-button--sm" to={`/receiving/rules/new?address=${encodeURIComponent(address.id)}`}>New rule</Link></div>
      </div>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="goes-to">
      <h2>{steps.deliver.title}</h2>
      {/* The list is where its mail goes, a route's changes included (no Inbox when the route sends it elsewhere,
          Dropped when it drops it); webhooks past the first 50 are one link away. */}
      {!entry ? <SkeletonText width="50%" /> : <ul>{entry.to.map(t => <li key={`${t.type}:${t.id}`}><TargetIcon type={t.type} /><span>{targetName(t, address.id)}</span>{(t.via || t.status === 'paused' || t.type !== 'inbox' || t.id !== address.id) && <span className="muted">{t.via ? 'via a rule' : t.status === 'paused' ? 'Paused' : typeLabel[t.type]}</span>}</li>)}
        {entry.toTruncated && <li><Link to={`/receiving?tab=destinations&address=${encodeURIComponent(address.id)}`}>{number(entry.toTotal - entry.to.length)} more {entry.toTotal - entry.to.length === 1 ? 'webhook' : 'webhooks'}</Link></li>}</ul>}
      <div className="addr-step__actions"><Button size="sm" onClick={() => setRouting(true)}>Change</Button></div>
    </section>
    {routing && <RouteEditor match={address.address} route={entry?.route} to={[address.id]} version={overview.data?.version} onClose={() => { setRouting(false); void overview.refetch() }} />}
  </div>
}

/** Wildcard patterns that also deliver here, such as reply+*@acme.com. */
function PatternsField({ address, inputRef }: { address: InboundAddress; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [draft, setDraft] = useState('')
  const save = useApiMutation((api, rules: string[]) => api.inbound.updateAddress(address.id, { rules } as InboundAddressPatch), 'Wildcards saved', false, invalidate.inboundAddresses, address.id)
  const rules = save.data?.rules ?? address.rules
  const domain = address.address.split('@')[1]
  async function add() {
    const value = draft.trim().toLowerCase(), full = value.includes('@') ? value : `${value}@${domain}`
    if (!value) return
    try { await save.mutateAsync([...rules, full]); setDraft('') } catch { /* Shown below. */ }
  }
  return <div className="ui-field addr-patterns">
    <label className="ui-field__label" htmlFor="address-pattern">Wildcards</label>
    {rules.length > 0 && <ul>{rules.map(r => <li key={r}><Match value={r} /><IconButton size="sm" label="Remove wildcard" disabled={save.isPending} onClick={() => void save.mutateAsync(rules.filter(x => x !== r)).catch(() => undefined)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>}
    <div className="addr-patterns__add"><Input ref={inputRef} id="address-pattern" value={draft} disabled={save.isPending} placeholder={`name+*@${domain}`} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} autoComplete="off" spellCheck={false} />
      <Button disabled={!draft.trim() || save.isPending} loading={save.isPending} onClick={() => void add()}>Add</Button></div>
    {save.error && <div className="ui-field__hint ui-field__error" role="alert">{errorText(save.error)}</div>}
  </div>
}

type AddressTab = 'mail' | 'flow' | 'settings'

export function InboundAddressDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { canAdminister } = useWorkspaceAccess()
  const client = useQueryClient()
  // Set when Delete is confirmed, before the DELETE goes out: the address's reads (its page, its mail) stop, so nothing
  // asks for it once it is gone. Cleared again if the delete fails. (data/invalidation.ts forgetResource)
  const [deleted, setDeleted] = useState(false)
  const address = useApiQuery(['inbound-address', id], (api, signal) => api.inbound.address(id, signal), { enabled: !deleted })
  const save = useApiMutation((api, patch: InboundAddressPatch) => api.inbound.updateAddress(id, patch), 'Address saved', false, invalidate.inboundAddresses, id)
  const remove = useApiMutation((api, _: void) => api.inbound.deleteAddress(id), 'Address deleted', false, false, id)
  async function deleteAddress() {
    flushSync(() => setDeleted(true))
    void cancelOwnQueries(client, id, addressForget).catch(() => {})
    try { await remove.mutateAsync() } catch (error) { setDeleted(false); throw error }
    navigate('/receiving')
    void forgetResource(client, id, addressForget).catch(() => {})
  }
  const [edited, setInput] = useState<AddressForm | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The routes that deliver here, read when Delete is pressed so the confirmation names them before it opens: deleting
  // takes the address out of them (deleteInboundAddress with detach), and a route left with nothing only keeps its mail.
  const [delivering, setDelivering] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const scope = useRequestScope()
  async function askDelete() {
    setChecking(true)
    try { setDelivering((await request<{ routes: MailRoute[] }>('/v1/routing', { scope })).routes.filter(r => Array.isArray(r.to) && r.to.includes(id)).map(r => r.match)) }
    catch { setDelivering([]) }
    finally { setChecking(false); setConfirmDelete(true) }
  }
  // Deleted elsewhere (an agent, a teammate, another tab): the page says so, and the lists that still show it drop it.
  const gone = !address.data && address.error instanceof ApiError && address.error.status === 404
  useEffect(() => { if (gone) void forgetResource(client, id, addressForget).catch(() => {}) }, [gone, client, id])
  const patternInput = useRef<HTMLInputElement>(null)
  const current = address.data
  // Mail first: opening an address shows its mail. Where its mail goes and its settings are for owners and admins.
  const asked = params.get('tab')
  const tab: AddressTab = canAdminister && (asked === 'flow' || asked === 'settings') ? asked : 'mail'
  // The open conversation stays in the URL (and its unsent reply in the page) while another tab is looked at.
  const show = (next: AddressTab) => setParams(previous => {
    const query = new URLSearchParams()
    if (next !== 'mail') query.set('tab', next)
    for (const key of ['view', 'thread', 'message']) { const value = previous.get(key); if (value) query.set(key, value) }
    return query
  }, { replace: true })
  const overview = useOverview({ q: current?.address ?? '', kind: current?.kind === 'inbox' ? 'inbox' : 'address', limit: 5 }, false, canAdminister && !!current && tab === 'flow' && !deleted)
  // Where its mail goes is the flow panel's diagram; Edit (or ?edit from the panel) opens its steps to change them.
  const entry = overview.data?.routes.data.find(r => r.address?.id === id)
  // Its host waits for its MX record (as when creating the address turned receiving on): the domain's page shows the record,
  // with Copy, until it is live.
  const host = current?.address.split('@')[1]
  const waitingDomain = overview.data?.domains.find(d => d.name === host && d.status === 'waiting_for_mx')
  // Edit opens the builder when it can draw the flow. ?edit=1 (Edit otherwise, or a builder's "more rules") shows the
  // steps: its route, changed in the route editor, and every rule it runs, to attach or detach. From the URL, so a link
  // to them works on this page too.
  const editing = params.get('edit') !== null
  const setEditing = (on: boolean) => setParams(previous => { const next = new URLSearchParams(previous); if (on) next.set('edit', '1'); else next.delete('edit'); return next }, { replace: true })
  const [building, setBuilding] = useState(false)
  const input = edited ?? (current ? formOf(current) : null)
  // Only a failed first load replaces the page: a later refetch that fails keeps the Settings form and its edits.
  if (gone) return <><PageHeader title="Address" backTo="/receiving" /><EmptyState title="This address no longer exists" description="Its mail stays in Logs." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving">Back to addresses</Link>} /></>
  if (address.error && !current) return <><PageHeader title="Address" backTo="/receiving" /><ErrorState error={address.error} onRetry={() => void address.refetch()} /></>
  const base = input?.base
  const dirty = !!base && !!input && (input.displayName.trim() !== (base.displayName ?? '') || !sameList(input.aliases.list, base.aliases) || !!input.aliases.draft.trim())
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input || !base) return
    // Text still in the alias box counts: add it, or stop on it so nothing invalid is sent.
    const aliases = commitAliases(input.aliases, { address: base.address, temporary: !!base.expiresAt })
    if (!aliases.ok) { setInput({ ...input, aliases: { list: aliases.list, draft: aliases.draft, message: aliases.message } }); focus(() => document.getElementById('inbound-address-aliases')); return }
    const patch: InboundAddressPatch = {}
    if (input.displayName.trim() !== (base.displayName ?? '')) patch.displayName = input.displayName.trim() || null
    if (!sameList(aliases.list, base.aliases)) patch.aliases = aliases.list
    if (!Object.keys(patch).length) { setInput(null); return }
    setInput({ ...input, aliases: { list: aliases.list, draft: '', message: null } })
    try { setInput(formOf(await save.mutateAsync(patch))) } catch { /* Shown in the form. */ }
  }
  const focus = (target: () => HTMLElement | null) => { const el = target(); el?.scrollIntoView({ block: 'center' }); el?.focus() }
  const focusSettings = (target: () => HTMLElement | null) => { show('settings'); requestAnimationFrame(() => requestAnimationFrame(() => focus(target))) }
  const expired = !!current?.expiresAt && Date.parse(current.expiresAt) <= Date.now()
  return <div className="stack inbound-stack addr-root" data-tab={tab}>
    <PageHeader title={current ? <PrivateAddress value={current.address} /> : <SkeletonText width={240} lineHeight={28} />} backTo={tab === 'mail' && params.get('thread') ? `/receiving/addresses/${id}` : '/receiving'} />
    {canAdminister && <Tabs label="Address" value={tab} onValueChange={value => show(value as AddressTab)}
      items={[{ value: 'mail', label: 'Mail' }, { value: 'flow', label: 'Where mail goes' }, { value: 'settings', label: 'Settings' }]} />}
    {expired && <Alert tone="info">This temporary address expired. It can’t receive or send.</Alert>}
    {/* Mail stays mounted, hidden, behind the other tabs: a reply being written survives a look at them. */}
    <AddressMail addressId={id} hidden={tab !== 'mail'} enabled={!deleted} />
    {tab === 'mail' ? null
      : !current || (tab === 'flow' && overview.data === undefined && !overview.error) ? <LoadingRegion label="Loading address"><div className="addr-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion>
      : tab === 'flow' ? <div className="stack addr-page">{waitingDomain && <Alert tone="warning" title={`${host} is waiting for its MX record`}>Mail to this address arrives once it’s published.<div className="cluster builder-receiving-actions"><Link className="ui-button ui-button--secondary ui-button--sm" to={`/domains/${waitingDomain.id}`}>See the record</Link></div></Alert>}
        {editing || !entry || !overview.data
        ? <>{entry && overview.data && entry.rules.filter(key => isSplit(overview.data!.rules.find(r => r.key === key))).length > 1 && <Alert tone="info">It splits its mail with more than one rule. Open a rule to change it.</Alert>}
          <AddressPath address={current} overview={overview} />
          {entry && <div className="cluster"><Button onClick={() => setEditing(false)}>Done</Button></div>}</>
        : <div className="addr-flow"><FlowPanel entry={entry} overview={overview.data} onEdit={() => { if (builderFits(entry, overview.data!)) setBuilding(true); else setEditing(true) }} mailLink={false} /></div>}
        {building && overview.data && <AddressBuilder open address={current} domains={overview.data.domains} onOpenChange={open => { if (!open) { setBuilding(false); void overview.refetch() } }} />}</div>
      : <div className="stack addr-page">
        <KeyValues className="addr-facts" items={[
          ...(current.publicAddress && current.publicAddress !== current.address ? [['Sends as', <PrivateAddress key="s" value={current.publicAddress} />] as [string, ReactNode]] : []),
          ['Created', `${current.origin === 'auto' ? 'By the catch-all, ' : ''}${date(current.createdAt)}`],
          ...(current.expiresAt ? [['Expires', date(current.expiresAt)] as [string, ReactNode]] : []),
        ]} />
        {input && <form className="stack inbound-settings-form" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <Field label="Display name" htmlFor="inbound-address-display" error={fieldError(save.error, 'displayName')}><Input id="inbound-address-display" value={input.displayName} onChange={event => setInput({ ...input, displayName: event.target.value })} disabled={save.isPending} placeholder="Support" /></Field>
          {/* A temporary address can have neither aliases nor wildcards, so it has no editor for them. */}
          {!current.expiresAt && <>
            <AliasEditor id="inbound-address-aliases" address={current.address} saved={input.base.aliases} value={input.aliases} onChange={aliases => setInput({ ...input, aliases })} disabled={save.isPending} error={fieldError(save.error, 'aliases')} />
            <PatternsField key={current.updatedAt} address={current} inputRef={patternInput} />
          </>}
          <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Save changes</Button>{dirty && !save.isPending && <Button onClick={() => { setInput(null); save.reset() }}>Discard</Button>}</div>
        </form>}
        <div className="addr-danger"><Button variant="danger" loading={checking} onClick={() => void askDelete()}>Delete address</Button></div>
      </div>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this address?" description={<>Its mail stays in Logs. New mail to it and its aliases follows the domain’s catch-all.{delivering.length > 0 && <> {delivering.length === 1 ? 'The route for ' : 'Routes for '}{delivering.slice(0, 3).map((match, i) => <span key={match}>{i > 0 && (i === Math.min(delivering.length, 3) - 1 && delivering.length <= 3 ? ' and ' : ', ')}<PrivateAddress value={match} /></span>)}{delivering.length > 3 && ` and ${number(delivering.length - 3)} more`} {delivering.length === 1 ? 'delivers' : 'deliver'} here too: deleting takes it out of {delivering.length === 1 ? 'that route' : 'them'}, and a route left with no destination only keeps its mail.</>}</>} confirmLabel="Delete address" danger pending={remove.isPending} onConfirm={deleteAddress} />
  </div>
}
