import { useEffect, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeftRight } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, StatusBadge, StatusDot, fieldError, MutationError, useToast } from '../../components/ui'
import { useApiMutation, useApiDef, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { ApiError, type DnsRecord, type Domain, type MailboxDomain, type ReceivingHost } from '../../data/types'
import { productName } from '../../../../api/src/brand'
import { domainPattern, normalizeDomain } from '../../lib/domain'
import { mxTone, receivingStatus } from '../inbound/status'
import { receivingIssueReason, receivingIssueTitle } from './receiving-issue-title'
import { AdminOnlyPage } from './admin-only'
import { DomainDetailSkeleton, domainColumns } from './skeletons'
import { DnsRecordTable, DnsWaitNote, DomainRecords, checkSummary, dnsChecks, domainState, recordRow, recordsFor, useDnsSetup, useDomain, zoneLines, type DnsChecks } from './domain-records'
import { cancelDomainQueries, forgetDomain, invalidate } from '../../data/invalidation'
import { ReceivingHosts, useReceivingHosts } from './receiving-hosts'
import { DomainSetupAlert, RecordsCorrectAlert, recordsCorrect, setupGap } from './domain-setup-alert'
import { BuiltinBadge, builtinFirst, builtinStatus } from './builtin-domain'

function downloadDnsRecords(domain: string, records: DnsRecord[]) {
  const text = `; DNS records for ${domain}\n; Import into your DNS provider or add each record manually.\n${zoneLines(records)}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${domain}-dns-records.txt` })
  link.click()
  URL.revokeObjectURL(url)
}

// What sending setup still waits for, beside its status; null once it waits for nothing.
function sendingNote(domain: Domain) {
  const ownership = recordsFor(domain, 'sending').filter(record => record.type === 'TXT')
  const parts = [domain.dkimStatus && domain.dkimStatus !== 'verified' && `DKIM ${domain.dkimStatus}`, ownership.length > 0 && !ownership.every(record => record.status === 'verified') && 'Ownership pending', ['pending', 'failed'].includes(domain.mailFromStatus) && `MAIL FROM ${domain.mailFromStatus}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : domain.status === 'verified' ? null : 'Waiting for DNS'
}

// The status word alone; what setup still waits for is in its hover title and on the domain's page.
function SendingCell({ domain }: { domain: Domain }) {
  const { status } = domainState(domain), note = sendingNote(domain)
  return <StatusDot tone={domain.status === 'issue' ? 'danger' : domain.status === 'verified' ? 'success' : 'warning'} title={note ?? undefined}>{status}</StatusDot>
}

// One line per domain: the host it receives at (the domain itself or a subdomain such as reply.), or Off. The column
// says "Receiving", so an active host needs no word of its own; other states and DNS issues add a short note. A card has
// no Addresses column, so an active host's card notes its address count instead. One page per domain for sending and
// receiving: Receiving doesn't list domains of its own.
function ReceivingCell({ domain, receiving, unknown = false, card = false }: { domain: Domain; receiving?: MailboxDomain; unknown?: boolean; card?: boolean }) {
  const issue = domain.receivingIssue
  if (issue) return <StatusDot tone={issue.blocking ? 'danger' : 'warning'} note={receivingIssueReason(issue.code)} title={`${receivingIssueTitle(issue.code, issue.host)}. ${issue.message}`}>{issue.host}</StatusDot>
  if (unknown) return <span className="muted" title="Couldn’t load receiving status">—</span>
  if (!receiving || receiving.status === 'off' || receiving.status === 'disabled') return <StatusDot tone="neutral" muted note={<Link className="domain-setup-link" to={`/domains/${domain.id}`}>Set up</Link>}>Off</StatusDot>
  const status = receivingStatus[receiving.status]
  const detail = receiving.status === 'failed' ? receiving.lastError : receiving.status === 'waiting_for_mx' ? receiving.mx?.message : null
  return <StatusDot tone={status.tone} note={receiving.status !== 'active' ? status.label : card ? `${receiving.addressCount.toLocaleString('en-US')} ${receiving.addressCount === 1 ? 'address' : 'addresses'}` : undefined} title={[`${status.label} at ${receiving.name}`, detail].filter(Boolean).join('. ')}>{receiving.name}</StatusDot>
}

/** Hosted: the hosts the domain receives on, each with its status, addresses (which open its routes in Mail routing) and catch-all. Only once receiving is set up: before that the Receiving record above says how to turn it on. */
/** The page reads the receiving domain and its hosts before it shows (so this section arrives at its final height) and passes them in. */
/** `onCheck`: the page's records check, run with Check MX now so the line above the records (and this button's notice)
 *  names what sending still waits for, such as a missing DKIM record: someone stuck presses whichever check is nearest. */
function ReceivingSettings({ domainId, domainName, receiving, hosts, onCheck }: { domainId: string; domainName: string; receiving: { data?: MailboxDomain; error: unknown; refetch: () => unknown }; hosts: { data?: ReceivingHost[]; error: unknown; refetch: () => unknown }; onCheck?: () => Promise<string | null> }) {
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), undefined, false, invalidate.mailboxDomains, domainId)
  const toast = useToast(), checking = useRef(false)
  // Pressed again and again (six times in ten seconds, by one stuck owner): like Check now, the button rests for a few
  // seconds after each press ("Checking…", at the same width), so it is one check and one notice.
  const [resting, setResting] = useState(false)
  useEffect(() => { if (!resting) return; const timer = setTimeout(() => setResting(false), CHECK_REST_MS); return () => clearTimeout(timer) }, [resting])
  async function checkMx() {
    if (checking.current || resting) return
    checking.current = true
    setResting(true)
    try {
      const [, waiting] = await Promise.all([check.mutateAsync(), onCheck?.() ?? null])
      // "MX records checked" alone reads as all clear while a sending record is missing: the notice names it.
      toast(waiting ? `MX records checked. Sending still waits: ${waiting}` : 'MX records checked', waiting ? 'info' : 'success')
    } catch { /* Shown inline. */ } finally { checking.current = false }
  }
  const state = receiving.data
  const failed = receiving.error ?? hosts.error
  if (!state || !hosts.data) return failed ? <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={failed as Error} onRetry={() => { void receiving.refetch(); void hosts.refetch() }} /></section> : null
  if (state.status === 'off') return null
  return <section className="section stack" aria-labelledby="domain-receiving">
    <ReceivingHosts domainId={domainId} domainName={domainName} hosts={hosts.data} actions={state.status !== 'active' && <Button className="domain-check" disabled={resting} aria-busy={check.isPending || undefined} onClick={() => void checkMx()}><span data-active={!resting || undefined}>Check MX now</span><span data-active={resting || undefined} aria-hidden={!resting || undefined}>Checking…</span></Button>} />
    <MutationError error={check.error} />
  </section>
}

export function DomainsPage() {
  return useWorkspaceAccess().canAdminister ? <DomainsList /> : <AdminOnlyPage title="Domains" button="Add domain" />
}
// A newsletter created from an address on a domain the workspace hasn't verified sends its creator here (?add= opens Add
// domain with the name filled in) and on to the domain's records; `then` is the newsletter's page, where Back returns.
// ?add also opens it from Overview's setup step and from ⌘K, whether or not the page is open; it then leaves the URL.
const returnTo = (params: URLSearchParams) => { const then = params.get('then') ?? ''; return /^\/newsletters\/[^/?#]+$/.test(then) ? then : '' }
function DomainsList() {
  const { regionId } = useRegion()
  const [params, setParams] = useSearchParams(), then = returnTo(params)
  const warm = usePrefetchQueries()
  const { multiTenant } = useWorkspaceAccess()
  const columns = domainColumns(multiTenant)
  const navigate = useNavigate()
  const [pageState, setPageState] = useState({ regionId, page: 1 })
  const page = pageState.regionId === regionId ? pageState.page : 1
  const domains = useApiDef(queries.domains(regionId, page), { keepPrevious: previous => previous[1] === regionId })
  const inbound = useApiDef(queries.inboundDomains())
  const receivingOf = (id: string) => inbound.data?.find(d => d.id === id)
  const quota = domains.data?.quota
  const create = useApiMutation((api, input: { regionId: string; name: string }) => api.domains.create(input), 'Domain added', true, invalidate.domains)
  const [open, setOpen] = useState(() => params.has('add'))
  const [name, setName] = useState(() => params.get('add') ?? '')
  const [invalid, setInvalid] = useState('')
  function openCreate(value = '') { create.reset(); setName(value); setInvalid(''); setOpen(true) }
  useEffect(() => {
    if (!params.has('add')) return
    openCreate(params.get('add') ?? '')
    setParams(previous => { const next = new URLSearchParams(previous); next.delete('add'); return next }, { replace: true })
  }, [params, setParams]) // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = normalizeDomain(name)
    if (!domainPattern.test(value)) { setInvalid('Enter a domain like updates.acme.com.'); return }
    setInvalid('')
    setName(value)
    try {
      const domain = await create.mutateAsync({ regionId, name: value })
      setOpen(false)
      navigate(`/domains/${domain.id}${then ? `?then=${encodeURIComponent(then)}` : ''}`)
    } catch { /* Shown inline. */ }
  }
  return <div className="stack">
    <PageHeader title="Domains" actions={<Button variant="primary" onClick={() => openCreate()} data-analytics="domains/add">Add domain</Button>} />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable className="domains-table" loading={domains.isPending || (inbound.isPending && !inbound.error)} skeletonRows={3} minRows={3} rows={builtinFirst(domains.data?.items ?? [])} rowKey={row => row.id} rowHref={row => `/domains/${row.id}`} onRowIntent={row => void warm([queries.domain(row.id)])} empty={<EmptyState title={multiTenant ? 'No domains' : 'No domains in this region'} action={<Button onClick={() => openCreate()}>Add domain</Button>} />} columns={[
        { ...columns[0], render: row => <span className="domain-name-cell"><span className="domain-name" title={row.name}>{row.name}</span>{row.builtIn && <BuiltinBadge />}</span> },
        { ...columns[1], render: row => <SendingCell domain={row} /> },
        { ...columns[2], render: row => <ReceivingCell domain={row} receiving={receivingOf(row.id)} unknown={!!inbound.error} />, cardRender: row => <ReceivingCell domain={row} receiving={receivingOf(row.id)} unknown={!!inbound.error} card /> },
        { ...columns[3], render: row => { const r = receivingOf(row.id); return r && r.status !== 'off' && r.status !== 'disabled' ? <Link to={`/receiving?domain=${encodeURIComponent(r.name)}`} onClick={event => event.stopPropagation()}>{r.addressCount.toLocaleString('en-US')}</Link> : <span className="muted" title={inbound.error ? 'Couldn’t load receiving status' : undefined}>—</span> } },
        ...multiTenant ? [] : [{ ...columns[4], render: (row: Domain) => row.regionId }],
      ]} />
      {domains.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={10} total={domains.data.total} nextCursor={domains.data.nextCursor} onPageChange={next => setPageState({ regionId, page: next })} />}
    </>}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add domain" analytics="domains/add" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="add-domain">Add domain</Button></>}>
      <form id="add-domain" className="stack" onSubmit={submit} noValidate>
        {quota && quota.used >= quota.limit && !create.error && <Alert tone="warning">{`This workspace has ${quota.used.toLocaleString('en-US')} of its ${quota.limit.toLocaleString('en-US')} domains. Remove one, or ask support for a higher limit.`}</Alert>}
        <MutationError error={create.error} />
        <Field label="Domain name" htmlFor="domain-name" error={invalid || fieldError(create.error, 'name')}><Input id="domain-name" autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} placeholder="updates.acme.com" /></Field>
        {!multiTenant && <Field label="Sending region" htmlFor="domain-region"><Input id="domain-region" value={regionId} readOnly /></Field>}
      </form>
    </Dialog>
  </div>
}

const CHECK_REST_MS = 8_000
export function DomainDetailPage() {
  return useWorkspaceAccess().canAdminister ? <DomainDetail /> : <AdminOnlyPage title="Domain" backTo="/domains" />
}
function DomainDetail() {
  const then = returnTo(useSearchParams()[0])
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { regionId, setRegionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  const hosted = useSession()?.identity?.connection?.kind === 'shared'
  const [recheckUntil, setRecheckUntil] = useState(0)
  // Set when Delete is confirmed, before the DELETE goes out: every read of the domain below stops (no poll, no focus
  // refetch), so nothing reaches the API after the domain is gone, and dropping its cache entries on the way back to
  // Domains starts nothing either. Cleared again if the delete fails.
  const [deleted, setDeleted] = useState(false)
  const domain = useDomain(id, recheckUntil, !deleted)
  // Receiving set up through the API checks the domain in the background: follow it until it settles.
  const receiving = useApiQuery(['mailbox-domain', id], (api, signal) => api.mailboxes.domain(id, signal), { enabled: multiTenant && !deleted, interval: state => state?.status === 'provisioning' ? 5_000 : false })
  const hosts = useReceivingHosts(id, multiTenant && !deleted, receiving.data?.status === 'provisioning' ? 5_000 : false)
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Checking records', true, invalidate.domains)
  // The same records check without its own notice, for Check MX now (whose notice says what it found).
  const recheck = useApiMutation((api, domainId: string) => api.domains.verify(domainId), undefined, true, invalidate.domains)
  const client = useQueryClient()
  // Invalidate only after leaving: refetching this domain would 404 while the dialog closes.
  const remove = useApiMutation((api, domainId: string) => api.domains.remove(domainId), 'Domain deleted', true, false)
  const configureMailFrom = useApiMutation((api, input: {id: string; mailFromDomain: string}) => api.domains.configureMailFrom(input.id, input.mailFromDomain), 'Custom MAIL FROM configured', true, invalidate.domains)
  const removeMailFrom = useApiMutation(async (api, domainId: string) => {
    const updated = await api.domains.removeMailFrom(domainId)
    client.setQueryData(['nightmail', 'domain', domainId], updated)
    return updated
  }, 'Custom MAIL FROM removed', true, invalidate.domains)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // A domain with no DNS at all is usually a typo: Change name adds the right one, then deletes this one (there's no rename).
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameInvalid, setRenameInvalid] = useState('')
  const [renameKept, setRenameKept] = useState<Domain | null>(null)
  const createRenamed = useApiMutation((api, input: { regionId: string; name: string }) => api.domains.create(input), 'Domain added', true, invalidate.domains)
  function openRename() { createRenamed.reset(); setRenameValue(domain.data?.name ?? ''); setRenameInvalid(''); setRenameOpen(true) }
  async function submitRename(event: FormEvent) {
    event.preventDefault()
    const current = domain.data, value = normalizeDomain(renameValue)
    if (!current) return
    if (!domainPattern.test(value)) { setRenameInvalid('Enter a domain like updates.acme.com.'); return }
    if (value === current.name) { setRenameInvalid('Enter the corrected name.'); return }
    setRenameInvalid('')
    let made: Domain
    try { made = await createRenamed.mutateAsync({ regionId: current.regionId, name: value }) } catch { return /* Shown inline; this domain is kept. */ }
    setRenameOpen(false)
    // The mistyped one goes as Delete domain removes it, its reads stopped first; if that fails, both stay and it says so.
    flushSync(() => setDeleted(true))
    void cancelDomainQueries(client, id).catch(() => {})
    try { await remove.mutateAsync(id) } catch { setDeleted(false); setRenameKept(made); return }
    navigate(`/domains/${made.id}`, { replace: true })
    void forgetDomain(client, id).catch(() => {})
  }
  // The name stays in the dialog's text while it closes, after the domain no longer has one.
  const [removingMailFrom, setRemovingMailFrom] = useState({ open: false, name: '' })
  const [mailFromOpen, setMailFromOpen] = useState(false)
  const [mailFromDomain, setMailFromDomain] = useState('')
  const [mailFromInvalid, setMailFromInvalid] = useState('')
  function openMailFrom() { configureMailFrom.reset(); setMailFromDomain(domain.data?.mailFromDomain ?? `email.${domain.data?.name ?? ''}`); setMailFromInvalid(''); setMailFromOpen(true) }
  async function submitMailFrom(event: FormEvent) {
    event.preventDefault()
    const current = domain.data, value = mailFromDomain.trim().toLowerCase()
    if (!current || !domainPattern.test(value) || value === current.name || !value.endsWith(`.${current.name}`)) { setMailFromInvalid(`Use an unused subdomain of ${current?.name ?? 'this domain'}.`); return }
    setMailFromInvalid('')
    try { await configureMailFrom.mutateAsync({id, mailFromDomain: value}); setMailFromOpen(false) } catch { /* Shown inline. */ }
  }
  const dns = useDnsSetup(domain.data)
  // Hosted receiving: a free subdomain by default. Choosing a host goes through the API's DNS checks: a CNAME, one of
  // Nightmail's own names or a host in use elsewhere is refused; a host another provider receives for asks before moving its mail.
  const [moveMail, setMoveMail] = useState<{ host: string; message: string } | null>(null)
  const choose = useApiMutation(async (api, input: { host: string | null; confirm?: boolean }) => {
    const updated = await api.domains.chooseReceivingHost(id, input)
    client.setQueryData(['nightmail', 'domain', id], updated)
    return updated
  }, undefined, false, invalidate.domains, id)
  async function chooseHost(host: string | null) {
    choose.reset()
    try { await choose.mutateAsync({ host }) }
    catch (error) { if (host && error instanceof ApiError && error.code === 'RECEIVING_HOST_IN_USE') { choose.reset(); setMoveMail({ host, message: error.detail.replace(/^Move mail for \S+\? /, '').replace(/ Send confirm: true to choose it anyway\.$/, '') }) } }
  }
  // What Check now found in public DNS for this domain, kept while the page polls. The button rests for a few seconds
  // after each press ("Checking…"): verification runs in the background meanwhile, and DNS answers are cached for 30 s.
  const [checks, setChecks] = useState<{ id: string; found: DnsChecks } | null>(null)
  const [resting, setResting] = useState(false)
  useEffect(() => { if (!resting) return; const timer = setTimeout(() => setResting(false), CHECK_REST_MS); return () => clearTimeout(timer) }, [resting])
  // Both check buttons run it: Check now, and Check MX now under Receiving. A press while it rests uses the last answer.
  async function checkRecords(mutation: typeof verify) {
    if (resting) return checks?.id === id ? checks.found : null
    setResting(true)
    try { const found = dnsChecks(await mutation.mutateAsync(id)); setChecks({ id, found }); if (multiTenant) setRecheckUntil(Date.now() + 30_000); return found } catch { return null }
  }
  async function checkNow() { await checkRecords(verify) }
  /** For Check MX now: what sending still waits for, in the words of the line above the records; null when nothing. */
  async function checkFromMx() {
    const found = await checkRecords(recheck), current = domain.data
    if (!found || !current) return null
    const summary = checkSummary(current, found)
    return summary?.tone === 'danger' ? summary.text : null
  }
  // The reads stop before the DELETE is sent, not once it answers: it takes a second or more (SES included), and a poll
  // that fired meanwhile reached the API after the domain was gone and answered 404. A read already in flight is cancelled.
  async function deleteDomain() {
    flushSync(() => setDeleted(true))
    void cancelDomainQueries(client, id).catch(() => {})
    try { await remove.mutateAsync(id) } catch (error) { setDeleted(false); throw error }
    navigate('/domains', { replace: true })
    void forgetDomain(client, id).catch(() => {})
  }
  if (domain.isPending || (!domain.error && (dns.pending || (multiTenant && ((receiving.isPending && !receiving.error) || (hosts.isPending && !hosts.error)))))) return <DomainDetailSkeleton />
  if (domain.error) return <div className="stack"><PageHeader title="Domain" backTo="/domains" /><ErrorState error={domain.error} onRetry={() => void domain.refetch()} /></div>
  const current = domain.data
  const state = domainState(current)
  const receivingRecord = recordsFor(current, 'receiving')[0]
  const onRoot = receivingRecord?.name === current.name
  // Before the domain receives, its own host's row offers the root or a subdomain instead (Check now in the header checks MX too).
  const receivingActions = multiTenant && receivingRecord && receivingRecord.status !== 'verified' ? [{ label: onRoot ? 'Use a subdomain instead' : `Use ${current.name} instead`, icon: <ArrowLeftRight size={16} />, onSelect: () => void chooseHost(onRoot ? null : current.name) }] : undefined
  const sesUrl = `https://${current.regionId}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(current.regionId)}#/identities/${encodeURIComponent(current.name)}`
  // Check now's answers, or until it is pressed the background check's that the domain's reads carry (domain-setup-alert.tsx).
  const pressed = checks?.id === id ? checks.found : undefined, gap = setupGap(current, pressed)
  if (current.builtIn) return <BuiltinDomainDetail domain={current} backTo={then || '/domains'} />
  return <div className="stack">
    <PageHeader title={current.name} backTo={then || '/domains'} actions={<>
      <StatusBadge status={state.status} tone={state.tone} />
      <Button className="domain-check" disabled={resting} aria-busy={verify.isPending || undefined} onClick={() => void checkNow()} data-analytics="domains/check"><span data-active={!resting || undefined}>Check now</span><span data-active={resting || undefined} aria-hidden={!resting || undefined}>Checking…</span></Button>
      {!hosted && <a className="ui-button ui-button--secondary ui-button--md" href={sesUrl} target="_blank" rel="noreferrer">Open in SES</a>}
      {multiTenant && <Button variant="danger" onClick={() => { remove.reset(); setDeleteOpen(true) }}>Delete domain</Button>}
    </>} />
    <MutationError error={verify.error ?? choose.error} />
    {renameKept && <Alert tone="warning" title={`${renameKept.name} was added, but ${current.name} wasn’t deleted`}>Delete it with Delete domain, or <Link to={`/domains/${renameKept.id}`}>open {renameKept.name}</Link>.</Alert>}
    {!multiTenant && regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    {gap ? <DomainSetupAlert domain={current} gap={gap} page actions={gap.noDns && multiTenant && <><Button size="sm" onClick={openRename}>Change name</Button><Button size="sm" variant="danger" onClick={() => { remove.reset(); setDeleteOpen(true) }}>Delete domain</Button></>} /> : recordsCorrect(current, pressed) && <RecordsCorrectAlert />}
    <div className="domain-sections">
      <DomainRecords domain={current} setup={dns.setup} checks={pressed ?? dnsChecks(current)} receivingView={multiTenant ? { off: receiving.data?.status === 'off', actions: receivingActions } : undefined} mailFrom={{ onEdit: openMailFrom, onRemove: () => { removeMailFrom.reset(); setRemovingMailFrom({ open: true, name: current.mailFromDomain ?? '' }) } }} actions={current.records.length > 0 && <Button onClick={() => downloadDnsRecords(current.name, current.records)}>Download .txt</Button>} />
      <DnsWaitNote domain={current} />
      {multiTenant && <ReceivingSettings domainId={id} domainName={current.name} receiving={receiving} hosts={hosts} onCheck={checkFromMx} />}
      {!multiTenant && <MailboxReceiving domainId={id} domainName={current.name} />}
    </div>
    <ConfirmDialog open={!!moveMail} onOpenChange={open => { if (!open) setMoveMail(null) }} title={`Move mail for ${moveMail?.host ?? current.name}?`}
      description={`${moveMail?.message ?? ''} Mail stops arriving there once the MX record changes.`} confirmLabel={`Use ${moveMail?.host ?? current.name} anyway`} danger
      onConfirm={() => choose.mutateAsync({ host: moveMail!.host, confirm: true })} />
    <Dialog open={renameOpen} onOpenChange={next => { if (!createRenamed.isPending) setRenameOpen(next) }} title="Change name" footer={<><Button disabled={createRenamed.isPending} onClick={() => setRenameOpen(false)}>Cancel</Button><Button variant="primary" loading={createRenamed.isPending} type="submit" form="rename-domain">Add and delete {current.name}</Button></>}>
      <form id="rename-domain" className="stack" onSubmit={submitRename} noValidate>
        <MutationError error={fieldError(createRenamed.error, 'name') ? null : createRenamed.error} />
        <Field label="Domain name" htmlFor="rename-domain-name" error={renameInvalid || fieldError(createRenamed.error, 'name')}><Input id="rename-domain-name" autoFocus required value={renameValue} onChange={event => setRenameValue(event.target.value)} disabled={createRenamed.isPending} placeholder="updates.acme.com" /></Field>
      </form>
    </Dialog>
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${current.name}?`} description="Sending from it stops." confirmLabel="Delete domain" danger pending={remove.isPending} onConfirm={deleteDomain} />
    <ConfirmDialog open={removingMailFrom.open} onOpenChange={open => setRemovingMailFrom(state => ({ ...state, open }))} title="Remove custom MAIL FROM?"
      description={`Mail from ${current.name} goes back to the default MAIL FROM, amazonses.com.`} confirmLabel="Remove" danger pending={removeMailFrom.isPending} onConfirm={() => removeMailFrom.mutateAsync(id)} />
    <Dialog open={mailFromOpen} onOpenChange={next => {if (!configureMailFrom.isPending) setMailFromOpen(next)}} title={current.mailFromDomain ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} footer={<><Button disabled={configureMailFrom.isPending} onClick={() => setMailFromOpen(false)}>Cancel</Button><Button variant="primary" loading={configureMailFrom.isPending} type="submit" form="configure-mail-from">Save</Button></>}>
      <form id="configure-mail-from" className="stack" onSubmit={submitMailFrom} noValidate>
        <MutationError error={configureMailFrom.error} />
        <Field label="MAIL FROM domain" htmlFor="mail-from-domain" error={mailFromInvalid || fieldError(configureMailFrom.error, 'mailFromDomain')}><Input id="mail-from-domain" autoFocus required value={mailFromDomain} onChange={event => setMailFromDomain(event.target.value)} disabled={configureMailFrom.isPending} placeholder={`email.${current.name}`} /></Field>
      </form>
    </Dialog>
  </div>
}

// The built-in domain has no records, MAIL FROM, hosts or Delete: what it is, who it sends to, and where its mail goes. Its
// catch-all is a route to the default inbox (api/src/builtin-domain.ts), which Receiving shows with its addresses.
function BuiltinDomainDetail({ domain, backTo }: { domain: Domain; backTo: string }) {
  const builtin = useSession()?.identity?.connection?.builtinDomain
  const state = domainState(domain)
  return <div className="stack">
    <PageHeader title={domain.name} backTo={backTo} actions={<><BuiltinBadge /><StatusBadge status={state.status} tone={state.tone} /></>} />
    <div className="domain-sections">
      <section className="section stack" aria-label="Built-in domain">
        <SectionHeader title="Built-in domain" />
        <p className="muted domain-builtin-copy">{[`${productName} set this domain up for your workspace, so it needs no DNS.`, builtin?.name === domain.name ? builtinStatus(builtin) : null, `Mail to an address with no inbox or route of its own goes to ${BUILTIN_INBOX}@${domain.name}.`].filter(Boolean).join(' ')}</p>
        <div className="cluster"><Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving?domain=${encodeURIComponent(domain.name)}`}>Open in Mail routing</Link><Link className="ui-button ui-button--secondary ui-button--md" to="/domains?add">Add your own domain</Link></div>
      </section>
    </div>
  </div>
}
const BUILTIN_INBOX = 'hello'

// Self-hosted receiving. Enabling it on a domain that isn't verified yet is refused by the API, which says so inline.
function MailboxReceiving({ domainId, domainName }: { domainId: string; domainName: string }) {
  const receiving = useApiQuery(['mailbox-domain', domainId], (api, signal) => api.mailboxes.domain(domainId, signal), { interval: state => state && ['provisioning', 'waiting_for_mx', 'disabling'].includes(state.status) ? 30_000 : false })
  const enable = useApiMutation((api, force: boolean) => api.mailboxes.enableDomain(domainId, { force }), 'Receiving setup started', false, invalidate.mailboxDomains, domainId)
  const disable = useApiMutation((api, _: void) => api.mailboxes.disableDomain(domainId), 'Receiving turned off', false, invalidate.mailboxDomains, domainId)
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked', false, invalidate.mailboxDomains, domainId)
  const hosts = useReceivingHosts(domainId, !!receiving.data && !['off', 'disabled'].includes(receiving.data.status))
  const [conflict, setConflict] = useState<string | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  async function start() {
    try { await enable.mutateAsync(false) }
    catch (error) { if (error instanceof ApiError && error.code === 'MX_CONFLICT') { enable.reset(); setConflict(error.detail.replace(/ Retry with force=true to continue anyway\.$/, '')) } }
  }
  if (receiving.error) return <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={receiving.error} onRetry={() => void receiving.refetch()} /></section>
  const state = receiving.data
  const on = !!state && !['off', 'disabled'].includes(state.status)
  const status = state ? receivingStatus[state.status] : null
  const records: DnsRecord[] = (state?.dns ?? []).map((record, index) => ({ id: `mx_${index}`, type: 'MX', name: record.name, value: `${record.priority} ${record.value}`, status: state?.mx?.state === 'active' ? 'verified' : 'pending', purpose: 'receiving' }))
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>Receiving</h2></div>
      <div className="cluster">{on ? <>
        <Button loading={check.isPending} onClick={async () => { try { await check.mutateAsync() } catch { /* Shown inline. */ } }}>Check MX</Button>
        {state!.status !== 'disabling' && <Button onClick={() => setDisableOpen(true)}>Turn off</Button>}
      </> : <Button variant="primary" disabled={!state} loading={enable.isPending} onClick={start}>Enable receiving</Button>}</div>
    </div>
    <MutationError error={enable.error ?? disable.error ?? check.error} />
    {state && status && on && <>
      <dl className="settings-facts domain-facts">
        <div><dt>Status</dt><dd><StatusBadge status={status.label} tone={status.tone} /></dd></div>
        <div><dt>Region</dt><dd>{state.region}</dd></div>
      </dl>
      {state.lastError && <Alert tone="danger">{state.lastError}</Alert>}
      {state.status === 'provisioning' && <Alert tone="info">Setting up S3, SNS and the SES receipt rule. This takes about a minute.</Alert>}
      {state.mx && state.status !== 'provisioning' && <Alert tone={mxTone(state.mx.state)}>{state.mx.message}</Alert>}
      <DnsRecordTable domain={domainName} rows={records.map(record => recordRow(record))} />
      {hosts.data && <ReceivingHosts domainId={domainId} domainName={domainName} hosts={hosts.data} title={<h3>Hosts</h3>} />}
    </>}
    <ConfirmDialog open={!!conflict} onOpenChange={open => { if (!open) setConflict(null) }} title={`Move mail for ${domainName}?`} description={`${conflict ?? ''} Mail stops arriving at that provider once the MX record changes.`} confirmLabel="Enable anyway" danger onConfirm={() => enable.mutateAsync(true)} />
    <ConfirmDialog open={disableOpen} onOpenChange={setDisableOpen} title={`Stop receiving on ${domainName}?`} description="SES stops accepting mail for this domain. Addresses and stored messages are kept." confirmLabel="Turn off" danger onConfirm={() => disable.mutateAsync()} />
  </section>
}
