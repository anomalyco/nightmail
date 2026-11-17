import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, Field, Input, MutationError, StatusDot, fieldError, type Tone } from '../../components/ui'
import { useApiMutation, useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import { ApiError, type ReceivingHost } from '../../data/types'
import { catchAllSetting } from '../inbound/concepts'
import { receivingIssueTitle } from './receiving-issue-title'
import { settingsColumns } from './skeletons'
import { relativeHost } from './domain-records'

const hostStatus: Record<ReceivingHost['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for MX', tone: 'warning' }, active: { label: 'Receiving', tone: 'success' }, mixed: { label: 'Receiving, MX shared', tone: 'warning' },
  lost: { label: 'MX missing', tone: 'danger' }, failed: { label: 'Failed', tone: 'danger' }, removed: { label: 'Removed', tone: 'neutral' },
}
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
  const [removing, setRemoving] = useState<ReceivingHost | null>(null)
  const add = useApiMutation((_api, input: { name: string; confirm: boolean }) => request<ReceivingHost>(path(domainId), { method: 'POST', body: input }), 'Host added', true, true, domainId)
  const update = useApiMutation((_api, input: { id: string; catchAll: ReceivingHost['catchAll'] }) => request<ReceivingHost>(path(domainId, input.id), { method: 'PATCH', body: { catchAll: input.catchAll } }), 'Catch-all saved', false, true, domainId)
  const remove = useApiMutation((_api, id: string) => request<ReceivingHost>(path(domainId, id), { method: 'DELETE' }), 'Host removed', true, true, domainId)
  function open() { add.reset(); setName(''); setAdding(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = name.trim().toLowerCase()
    try { await add.mutateAsync({ name: value, confirm: false }); setAdding(false) }
    catch (error) {
      // Another provider receives this host's mail today: ask before moving it.
      if (error instanceof ApiError && error.code === 'RECEIVING_HOST_IN_USE') { add.reset(); setAdding(false); setMoveMail({ name: value, message: error.detail.replace(/^Move mail for \S+\? /, '').replace(/ Send confirm: true to choose it anyway\.$/, '') }) }
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
      { ...catchAllColumn, render: host => catchAllSetting.options[host.catchAll] },
      { ...actionsColumn, render: host => <DropdownMenu label={`Actions for ${host.name}`} title={relativeHost(host.name, domainName)} items={menu(host)} /> },
    ]} />
    <Dialog open={adding} onOpenChange={next => { if (!add.isPending) setAdding(next) }} title="Add host" footer={<><Button disabled={add.isPending} onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={add.isPending} type="submit" form="add-receiving-host">Add host</Button></>}>
      <form id="add-receiving-host" className="stack" onSubmit={submit} noValidate>
        <MutationError error={fieldError(add.error, 'name') ? null : add.error} />
        <Field label="Host" htmlFor="receiving-host-name" error={fieldError(add.error, 'name')}><Input id="receiving-host-name" autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={add.isPending} placeholder={`inbox.${domainName}`} /></Field>
      </form>
    </Dialog>
    <ConfirmDialog open={!!moveMail} onOpenChange={next => { if (!next) setMoveMail(null) }} title={`Move mail for ${moveMail?.name ?? domainName}?`}
      description={moveMail?.message ?? ''} confirmLabel={`Use ${moveMail?.name ?? domainName}`} danger onConfirm={() => add.mutateAsync({ name: moveMail!.name, confirm: true })} />
    <ConfirmDialog open={!!removing} onOpenChange={next => { if (!next) setRemoving(null) }} title={`Stop receiving on ${removing?.name ?? ''}?`}
      description="Its addresses and mail are kept." confirmLabel="Remove" danger pending={remove.isPending} onConfirm={() => remove.mutateAsync(removing!.id)} />
  </>
}
