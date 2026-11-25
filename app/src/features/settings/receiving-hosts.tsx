import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, Field, Input, MutationError, StatusDot, fieldError, type Tone } from '../../components/ui'
import { useApiMutation, useApiQuery } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { request } from '../../data/live'
import { ApiError, type ReceivingHost } from '../../data/types'
import { catchAllSetting } from '../inbound/concepts'
import { receivingIssueTitle } from './receiving-issue-title'
import { settingsColumns } from './skeletons'
import { isSubdomainName, relativeHost, rootMxWarning } from './domain-records'

export const hostStatus: Record<ReceivingHost['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for MX', tone: 'warning' }, active: { label: 'Receiving', tone: 'success' }, mixed: { label: 'Receiving, MX shared', tone: 'warning' },
  lost: { label: 'MX missing', tone: 'danger' }, failed: { label: 'Failed', tone: 'danger' }, removed: { label: 'Removed', tone: 'neutral' },
}
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/**
 * A host as typed, checked the way the API checks it (receiving-hosts.ts hostName): any case, a trailing dot, @ for the
 * domain itself, a label (inbox) or a subdomain of the domain. Returns the full host name, or what to fix.
 */
export function typedHost(typed: string, domainName: string): { host: string } | { problem: string; code: 'empty' | 'invalid' } {
  const value = typed.trim().toLowerCase().replace(/\.$/, '')
  if (!value) return { problem: `Enter a host: @ for ${domainName} itself, a label such as inbox, or inbox.${domainName}.`, code: 'empty' }
  const host = value === '@' ? domainName : value === domainName || value.endsWith(`.${domainName}`) ? value : `${value}.${domainName}`
  const labels = host === domainName ? [] : host.slice(0, -(domainName.length + 1)).split('.')
  if (host.length > 253 || labels.some(label => !LABEL.test(label))) return { problem: `Use ${domainName} or one of its subdomains, such as inbox or inbox.${domainName}: letters, digits and hyphens only.`, code: 'invalid' }
  return { host }
}
/** The API's reason a host's mail is elsewhere today, without the API's own instructions, and without suggesting a host the domain already receives on. */
export function moveReason(message: string, hosts: string[]) {
  return message.replace(/^Move mail for \S+\? /, '').replace(/ Send confirm: true to choose it anyway\.$/, '')
    .replace(/ Use (\S+) for receiving instead\./, (all, host: string) => hosts.includes(host) ? '' : all)
}
/** Which rule refused a host, for analytics (a constant, never the host): the API's RECEIVING_HOST_TAKEN is "taken". */
const rejection = (error: unknown) => error instanceof ApiError && error.fields.name ? error.code === 'VALIDATION_FAILED' ? 'invalid' : error.code.toLowerCase().replace(/^receiving_host_/, '').slice(0, 32) : undefined
const path = (domainId: string, hostId?: string) => `/v1/inbound/domains/${encodeURIComponent(domainId)}/hosts${hostId ? `/${encodeURIComponent(hostId)}` : ''}`

/** The hosts the domain receives on, read with the page so the section arrives at its final height. */
export function useReceivingHosts(domainId: string, enabled: boolean, interval: number | false = false) {
  return useApiQuery(['mailbox-domain', domainId, 'hosts'], (_api, signal) => request<{ data: ReceivingHost[] }>(path(domainId), { signal }).then(page => page.data.filter(host => host.status !== 'removed')), { enabled, interval: () => interval })
}

/** A domain receives on any set of hosts at once: the domain itself and any of its subdomains, each added and removed on its own. */
export function ReceivingHosts({ domainId, domainName, hosts, actions, title = <h2 id="domain-receiving">Receiving</h2> }: { domainId: string; domainName: string; hosts: ReceivingHost[]; actions?: ReactNode; title?: ReactNode }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [moveMail, setMoveMail] = useState<{ name: string; message: string } | null>(null)
  const [invalid, setInvalid] = useState('')
  const [invalidCode, setInvalidCode] = useState<string>()
  // Set once Move mail is confirmed: closing it any other way goes back to Add host with the name, to choose another.
  const moving = useRef(false)
  const [removing, setRemoving] = useState<ReceivingHost | null>(null)
  const add = useApiMutation((_api, input: { name: string; confirm: boolean }) => request<ReceivingHost>(path(domainId), { method: 'POST', body: input }), 'Host added', true, invalidate.mailboxDomains, domainId)
  const update = useApiMutation((_api, input: { id: string; catchAll: ReceivingHost['catchAll'] }) => request<ReceivingHost>(path(domainId, input.id), { method: 'PATCH', body: { catchAll: input.catchAll } }), 'Catch-all saved', false, invalidate.mailboxDomains, domainId)
  const remove = useApiMutation((_api, id: string) => request<ReceivingHost>(path(domainId, id), { method: 'DELETE' }), 'Host removed', true, invalidate.mailboxDomains, domainId)
  function open() { add.reset(); setName(''); setInvalid(''); setAdding(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const typed = typedHost(name, domainName)
    if ('problem' in typed) { add.reset(); setInvalid(typed.problem); setInvalidCode(typed.code); return }
    setInvalid('')
    try { await add.mutateAsync({ name: typed.host, confirm: false }); setAdding(false) }
    catch (error) {
      // Another provider receives this host's mail today: ask before moving it.
      if (error instanceof ApiError && error.code === 'RECEIVING_HOST_IN_USE') { add.reset(); setAdding(false); moving.current = false; setMoveMail({ name: typed.host, message: moveReason(error.detail, hosts.map(host => host.name)) }) }
    }
  }
  const [hostColumn, statusColumn, addressesColumn, catchAllColumn, actionsColumn] = settingsColumns.hosts
  const menu = (host: ReceivingHost) => [
    { label: host.catchAll === 'store' ? `Catch-all: ${catchAllSetting.options.create_address}` : `Catch-all: ${catchAllSetting.options.store}`, onSelect: () => void update.mutateAsync({ id: host.id, catchAll: host.catchAll === 'store' ? 'create_address' : 'store' }).catch(() => undefined) },
    { label: 'Remove', destructive: true, onSelect: () => { remove.reset(); setRemoving(host) } },
  ]
  return <>
    <div className="ui-section-header"><div className="domain-group-title">{title}</div><div className="cluster">{actions}<Button onClick={open}>Add host</Button></div></div>
    <MutationError error={update.error} />
    <DataTable className="receiving-hosts" rows={hosts} rowKey={host => host.id} columns={[
      // Relative to the domain, as its DNS records are: @ is the domain itself.
      { ...hostColumn, render: host => <span className="domain-name" title={host.name}>{relativeHost(host.name, domainName)}</span> },
      { ...statusColumn, render: host => { const status = hostStatus[host.status], issue = host.issue
        return <StatusDot tone={issue?.blocking ? 'danger' : status.tone} title={issue ? `${receivingIssueTitle(issue.code, issue.host)}. ${issue.message}` : host.status === 'active' ? undefined : host.mx?.message}>{status.label}</StatusDot> } },
      { ...addressesColumn, render: host => <Link to={`/receiving?domain=${encodeURIComponent(host.name)}`}>{host.addressCount.toLocaleString('en-US')}</Link> },
      { ...catchAllColumn, render: host => <span className="settings-cell" title={catchAllSetting.options[host.catchAll]}>{catchAllSetting.options[host.catchAll]}</span>, cardRender: host => catchAllSetting.options[host.catchAll] },
      { ...actionsColumn, render: host => <DropdownMenu label={`Actions for ${host.name}`} title={relativeHost(host.name, domainName)} items={menu(host)} /> },
    ]} />
    <Dialog open={adding} onOpenChange={next => { if (!add.isPending) setAdding(next) }} title="Add host" footer={<><Button disabled={add.isPending} onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={add.isPending} type="submit" form="add-receiving-host">Add host</Button></>}>
      <form id="add-receiving-host" className="stack" onSubmit={submit} noValidate>
        <MutationError error={fieldError(add.error, 'name') ? null : add.error} />
        <Field label="Host" htmlFor="receiving-host-name" error={invalid || fieldError(add.error, 'name')} errorCode={invalid ? invalidCode : rejection(add.error)}><Input id="receiving-host-name" autoFocus required value={name} onChange={event => { setName(event.target.value); setInvalid('') }} disabled={add.isPending} placeholder={`inbox.${domainName}`} /></Field>
        {/* The domain itself is a host like any other: offered here once it isn't one, with what its MX record takes over. */}
        {(['@', domainName, `${domainName}.`] as string[]).includes(name.trim().toLowerCase()) ? <Alert tone={isSubdomainName(domainName) ? 'info' : 'warning'}>{rootMxWarning(domainName)}</Alert>
          : !hosts.some(host => host.name === domainName) && <div className="cluster"><Button size="sm" onClick={() => setName(domainName)} disabled={add.isPending}>Use {domainName} itself</Button></div>}
      </form>
    </Dialog>
    <ConfirmDialog open={!!moveMail} onOpenChange={next => { if (!next) { if (!moving.current && moveMail) { add.reset(); setName(moveMail.name); setAdding(true) } setMoveMail(null) } }} title={`Move mail for ${moveMail?.name ?? domainName}?`}
      description={<>{moveMail?.message}{moveMail?.name === domainName && !isSubdomainName(domainName) && <> To keep that mail where it is, cancel and add a subdomain such as mail.{domainName} instead.</>}</>}
      confirmLabel={`Use ${moveMail?.name ?? domainName}`} danger onConfirm={async () => { moving.current = true; try { await add.mutateAsync({ name: moveMail!.name, confirm: true }) } catch (error) { moving.current = false; throw error } }} />
    <ConfirmDialog open={!!removing} onOpenChange={next => { if (!next) setRemoving(null) }} title={`Stop receiving on ${removing?.name ?? ''}?`}
      description="Its addresses and mail are kept." confirmLabel="Remove" danger pending={remove.isPending} onConfirm={() => remove.mutateAsync(removing!.id)} />
  </>
}
