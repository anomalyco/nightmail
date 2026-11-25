import { useEffect, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeftRight } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, StatusBadge, StatusDot, fieldError, MutationError } from '../../components/ui'
import { useApiMutation, useApiDef, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { ApiError, type DnsRecord, type Domain, type MailboxDomain, type ReceivingHost } from '../../data/types'
import { request } from '../../data/live'
import { domainPattern, normalizeDomain } from '../../lib/domain'
import { mxTone, receivingStatus } from '../inbound/status'
import { receivingIssueReason, receivingIssueTitle } from './receiving-issue-title'
import { AdminOnlyPage } from './admin-only'
import { DomainDetailSkeleton, domainColumns } from './skeletons'
import { DnsRecordTable, DnsWaitNote, DomainRecords, dnsChecks, domainState, recordRow, recordsFor, useDnsSetup, useDomain, zoneLines, type DnsChecks } from './domain-records'
import { invalidate, invalidateResources, resourceOf } from '../../data/invalidation'
import { ReceivingHosts, useReceivingHosts } from './receiving-hosts'
import { DomainSetupAlert, setupGap } from './domain-setup-alert'

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
  return <StatusDot tone={domain.status === 'issue' ? 'danger' : domain.status === 'verified' ? 'success' : 'warning'} title={note ? `${status} · ${note}` : undefined}>{status}</StatusDot>
}

// One line per domain: the host it receives at (the domain itself or a subdomain such as reply.), or Off. The column
// says "Receiving", so an active host needs no word of its own; other states and DNS issues add a short note. A card has
// no Addresses column, so an active host's card notes its address count instead. One page per domain for sending and
// receiving: Receiving doesn't list domains of its own.
function ReceivingCell({ domain, receiving, unknown = false, card = false }: { domain: Domain; receiving?: MailboxDomain; unknown?: boolean; card?: boolean }) {
  const issue = domain.receivingIssue
  if (issue) return <StatusDot tone={issue.blocking ? 'danger' : 'warning'} note={receivingIssueReason(issue.code)} title={`${receivingIssueTitle(issue.code, issue.host)}. ${issue.message}`}>{issue.host}</StatusDot>
  if (unknown) return <span className="muted" title="Couldn’t load receiving status">—</span>
  if (!receiving || receiving.status === 'off' || receiving.status === 'disabled') return <StatusDot tone="neutral" muted title="Receiving is off. Set it up on the domain’s page." note={<Link className="domain-setup-link" to={`/domains/${domain.id}`}>Set up</Link>}>Off</StatusDot>
  const status = receivingStatus[receiving.status]
  const detail = receiving.status === 'failed' ? receiving.lastError : receiving.status === 'waiting_for_mx' ? receiving.mx?.message : null
  return <StatusDot tone={status.tone} note={receiving.status !== 'active' ? status.label : card ? `${receiving.addressCount.toLocaleString('en-US')} ${receiving.addressCount === 1 ? 'address' : 'addresses'}` : undefined} title={[`${status.label} at ${receiving.name}`, detail].filter(Boolean).join('. ')}>{receiving.name}</StatusDot>
}

/** Hosted: the hosts the domain receives on, each with its status, addresses (which open its routes in Receiving) and catch-all. Only once receiving is set up: before that the Receiving record above says how to turn it on. */
/** The page reads the receiving domain and its hosts before it shows (so this section arrives at its final height) and passes them in. */
function ReceivingSettings({ domainId, domainName, receiving, hosts }: { domainId: string; domainName: string; receiving: { data?: MailboxDomain; error: unknown; refetch: () => unknown }; hosts: { data?: ReceivingHost[]; error: unknown; refetch: () => unknown } }) {
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked', false, invalidate.mailboxDomains, domainId)
  const state = receiving.data
  const failed = receiving.error ?? hosts.error
  if (!state || !hosts.data) return failed ? <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={failed as Error} onRetry={() => { void receiving.refetch(); void hosts.refetch() }} /></section> : null
  if (state.status === 'off') return null
  return <section className="section stack" aria-labelledby="domain-receiving">
    <ReceivingHosts domainId={domainId} domainName={domainName} hosts={hosts.data} actions={state.status !== 'active' && <Button loading={check.isPending} onClick={() => void check.mutateAsync().catch(() => undefined)}>Check MX now</Button>} />
    <MutationError error={check.error} />
  </section>
}

export function DomainsPage() {
  return useWorkspaceAccess().canAdminister ? <DomainsList /> : <AdminOnlyPage title="Domains" button="Add domain" />
}
// A newsletter created from an address on a domain the workspace hasn't verified sends its creator here (?add= opens Add
// domain with the name filled in) and on to the domain's records; `then` is the newsletter's page, where Back returns.
const returnTo = (params: URLSearchParams) => { const then = params.get('then') ?? ''; return /^\/newsletters\/[^/?#]+$/.test(then) ? then : '' }
function DomainsList() {
  const { regionId } = useRegion()
  const [params] = useSearchParams(), then = returnTo(params)
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
  const [open, setOpen] = useState(() => Boolean(params.get('add')))
  const [name, setName] = useState(() => params.get('add') ?? '')
  const [invalid, setInvalid] = useState('')
  function openCreate() { create.reset(); setName(''); setInvalid(''); setOpen(true) }
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
    <PageHeader title="Domains" actions={<Button variant="primary" onClick={openCreate} data-analytics="domains/add">Add domain</Button>} />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable className="domains-table" loading={domains.isPending || (inbound.isPending && !inbound.error)} skeletonRows={3} minRows={3} rows={domains.data?.items ?? []} rowKey={row => row.id} rowHref={row => `/domains/${row.id}`} onRowIntent={row => void warm([queries.domain(row.id)])} empty={<EmptyState title={multiTenant ? 'No domains' : 'No domains in this region'} action={<Button onClick={openCreate}>Add domain</Button>} />} columns={[
        { ...columns[0], render: row => <span className="domain-name" title={row.name}>{row.name}</span> },
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
  const domain = useDomain(id, recheckUntil)
  // Receiving set up through the API checks the domain in the background: follow it until it settles.
  const receiving = useApiQuery(['mailbox-domain', id], (api, signal) => api.mailboxes.domain(id, signal), { enabled: multiTenant, interval: state => state?.status === 'provisioning' ? 5_000 : false })
  const hosts = useReceivingHosts(id, multiTenant, receiving.data?.status === 'provisioning' ? 5_000 : false)
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Checking records', true, invalidate.domains)
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
  async function checkNow() {
    if (resting) return
    setResting(true)
    try { const checked = await verify.mutateAsync(id); setChecks({ id, found: dnsChecks(checked) }); if (multiTenant) setRecheckUntil(Date.now() + 30_000) } catch { /* Shown inline. */ }
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
  return <div className="stack">
    <PageHeader title={current.name} backTo={then || '/domains'} actions={<>
      <StatusBadge status={state.status} tone={state.tone} />
      <Button className="domain-check" disabled={resting} aria-busy={verify.isPending || undefined} onClick={() => void checkNow()} data-analytics="domains/check"><span data-active={!resting || undefined}>Check now</span><span data-active={resting || undefined} aria-hidden={!resting || undefined}>Checking…</span></Button>
      {!hosted && <a className="ui-button ui-button--secondary ui-button--md" href={sesUrl} target="_blank" rel="noreferrer">Open in SES</a>}
      {multiTenant && <Button variant="danger" onClick={() => { remove.reset(); setDeleteOpen(true) }}>Delete domain</Button>}
    </>} />
    <MutationError error={verify.error ?? choose.error} />
    {!multiTenant && regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    {gap && <DomainSetupAlert domain={current} gap={gap} page />}
    <div className="domain-sections">
      <DomainRecords domain={current} setup={dns.setup} checks={pressed ?? dnsChecks(current)} receivingView={multiTenant ? { off: receiving.data?.status === 'off', actions: receivingActions } : undefined} mailFrom={{ onEdit: openMailFrom, onRemove: () => { removeMailFrom.reset(); setRemovingMailFrom({ open: true, name: current.mailFromDomain ?? '' }) } }} actions={current.records.length > 0 && <Button onClick={() => downloadDnsRecords(current.name, current.records)}>Download .txt</Button>} />
      <DnsWaitNote domain={current} />
      {multiTenant && <ReceivingSettings domainId={id} domainName={current.name} receiving={receiving} hosts={hosts} />}
      {!multiTenant && <MailboxReceiving domainId={id} domainName={current.name} />}
    </div>
    <ConfirmDialog open={!!moveMail} onOpenChange={open => { if (!open) setMoveMail(null) }} title={`Move mail for ${moveMail?.host ?? current.name}?`}
      description={`${moveMail?.message ?? ''} Mail stops arriving there once the MX record changes.`} confirmLabel={`Use ${moveMail?.host ?? current.name} anyway`} danger
      onConfirm={() => choose.mutateAsync({ host: moveMail!.host, confirm: true })} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${current.name}?`} description="Sending from it stops. Its DNS records stay at your DNS provider until you remove them." confirmLabel="Delete domain" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(id); navigate('/domains', { replace: true }); client.removeQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === 'domain' && query.queryKey[2] === id }); void invalidateResources(client, invalidate.domains.filter(r => r !== 'domain')) }} />
    <ConfirmDialog open={removingMailFrom.open} onOpenChange={open => setRemovingMailFrom(state => ({ ...state, open }))} title="Remove custom MAIL FROM?"
      description={`Mail from ${current.name} goes back to the default MAIL FROM, amazonses.com. You can then delete the MX and SPF records for ${removingMailFrom.name} at your DNS provider.`} confirmLabel="Remove" danger pending={removeMailFrom.isPending} onConfirm={() => removeMailFrom.mutateAsync(id)} />
    <Dialog open={mailFromOpen} onOpenChange={next => {if (!configureMailFrom.isPending) setMailFromOpen(next)}} title={current.mailFromDomain ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} footer={<><Button disabled={configureMailFrom.isPending} onClick={() => setMailFromOpen(false)}>Cancel</Button><Button variant="primary" loading={configureMailFrom.isPending} type="submit" form="configure-mail-from">Save</Button></>}>
      <form id="configure-mail-from" className="stack" onSubmit={submitMailFrom} noValidate>
        <MutationError error={configureMailFrom.error} />
        <Field label="MAIL FROM domain" htmlFor="mail-from-domain" error={mailFromInvalid || fieldError(configureMailFrom.error, 'mailFromDomain')}><Input id="mail-from-domain" autoFocus required value={mailFromDomain} onChange={event => setMailFromDomain(event.target.value)} disabled={configureMailFrom.isPending} placeholder={`email.${current.name}`} /></Field>
      </form>
    </Dialog>
  </div>
}

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
