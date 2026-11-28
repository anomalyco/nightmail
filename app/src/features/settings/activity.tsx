import { useState, type ReactNode } from 'react'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { Button, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Select, StatusBadge } from '../../components/ui'
import { actionLabel, activityApi, activityAreas, type AuditEntry } from '../../data/activity'
import { useRequestScope } from '../../data/context'
import { ago, shortDateTime } from '../../lib/format'
import { PrivateAddress } from '../../components/PrivateAddress'
import { AddressText } from '../../components/AddressText'
import { usd } from '../../data/billing'
import type { MailPermission } from '../../data/types'
import { accessLabel, domainScope, mailLabel } from './key-labels'
import { maskedParts } from '../../lib/private-address'
import { settingsColumns } from './skeletons'
import { productName } from '../../../../api/src/brand'

// Settings → Activity (hosted, owners and admins): what happened in this workspace, newest first, 50 at a time.
// Rows are one line each (the shared one-line row); a row opens its details (before → after, reason, request ID). The section takes the
// panel's full width, so values show whole on a desktop; a cell that still runs out of room ends in an ellipsis and
// shows all of it on hover. An address is never put in that tooltip: it stays masked until it is revealed itself.
const credential: Partial<Record<AuditEntry['actor']['type'], string>> = { api_key: 'API key', mcp_grant: 'Agent', agent_token: 'Agent token', inbox_key: 'API key', app_password: 'App password' }
export function Who({ actor }: { actor: AuditEntry['actor'] }) {
  if (actor.type === 'member') return actor.email ? <PrivateAddress value={actor.email} /> : <>{actor.label ?? 'A member'}</>
  // Support reading the workspace under a grant stands out from everything the workspace did itself.
  if (actor.type === 'support') return <StatusBadge status={`${productName} support`} tone="info" />
  if (actor.type === 'system' || actor.type === 'operator') return <>{productName}</>
  if (actor.type === 'stripe') return <>Stripe</>
  const detail = actor.label ?? actor.id
  return <>{credential[actor.type] ?? actor.type}{detail && <span className="muted"> · {detail}</span>}</>
}
const plain = (text: string | null | undefined) => text && !maskedParts(text) ? text : null
function whoText(actor: AuditEntry['actor']) {
  if (actor.type === 'member') return actor.email ? null : plain(actor.label ?? 'A member')
  if (actor.type === 'support') return `${productName} support`
  if (actor.type === 'system' || actor.type === 'operator') return productName
  if (actor.type === 'stripe') return 'Stripe'
  const detail = actor.label ?? actor.id
  return plain(`${credential[actor.type] ?? actor.type}${detail ? ` · ${detail}` : ''}`)
}
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
// The object's name from the summary when it has one (a key's name, a domain, an address), else its ID.
function summaryName(entry: AuditEntry) {
  const after = record(entry.summary.after), before = record(entry.summary.before)
  for (const source of [after, before, entry.summary]) for (const key of ['name', 'description', 'address', 'domain', 'email']) {
    const value = source?.[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}
const targetName = (entry: AuditEntry) => summaryName(entry) ?? entry.target?.id ?? null
// Support's view names the request that let it in: whose request, and the ticket.
const ticketOf = (entry: AuditEntry) => typeof entry.summary.ticket === 'string' ? entry.summary.ticket : null
function Target({ entry }: { entry: AuditEntry }) {
  if (entry.action === 'support.view') {
    const ticket = ticketOf(entry)
    return <>{entry.subject?.email ? <>For <PrivateAddress value={entry.subject.email} /></> : 'Support request'}{ticket && <span className="muted"> · {ticket}</span>}</>
  }
  const name = targetName(entry)
  return name ? <PrivateAddress value={name} /> : <span className="muted">—</span>
}
// Where it came from: the client family and network, or, without a client (support, jobs, webhooks), the channel.
const channel: Record<string, string> = { dashboard: 'Dashboard', api: 'API', mcp: 'MCP', imap: 'IMAP', smtp: 'SMTP', console: productName, support: `${productName} support`, script: productName, job: productName, webhook: 'Webhook' }
const source = (entry: AuditEntry) => entry.client ?? channel[entry.via] ?? entry.via
const fromText = (entry: AuditEntry) => [source(entry), entry.network].filter(Boolean).join(' · ')
// The client without its version (Chrome on macOS); the full source and network are its hover title and in the details.
const shortSource = (entry: AuditEntry) => source(entry).replace(/ \d+(?:\.\d+)*(?= on )/, '')
function targetText(entry: AuditEntry) {
  if (entry.action === 'support.view') return entry.subject?.email ? null : ['Support request', ticketOf(entry)].filter(Boolean).join(' · ')
  return plain(targetName(entry))
}
// `hint` is the tooltip while the value fits.
function Cell({ full, hint, className, children }: { full: string | null; hint?: string; className?: string; children: ReactNode }) {
  return <span className={className ? `activity-cell ${className}` : 'activity-cell'} title={hint} onPointerEnter={event => {
    const cell = event.currentTarget, clipped = [cell, ...cell.children].some(part => part.scrollWidth > part.clientWidth)
    const title = full && clipped ? full : hint
    if (title) cell.title = title
    else cell.removeAttribute('title')
  }}>{children}</span>
}
// How long ago; the exact time is in the row's details.
function When({ at }: { at: string }) {
  return <time dateTime={at}>{ago(at) ?? '—'}</time>
}

export function ActivitySection() {
  const scope = useRequestScope()
  const [area, setArea] = useState('')
  const [open, setOpen] = useState<AuditEntry | null>(null)
  const activity = useInfiniteQuery({
    queryKey: ['nightmail', 'activity', area],
    queryFn: ({ pageParam, signal }) => activityApi(scope).list({ action: area || undefined, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  })
  const rows = activity.data?.pages.flatMap(page => page.data) ?? []
  const [when, who, action, target, from] = settingsColumns.activity
  return <section className="section stack activity">
    <div className="settings-actions"><Select className="activity-filter" aria-label="Show activity for" value={area} onValueChange={setArea} options={[{ value: '', label: 'All activity' }, ...activityAreas]} /></div>
    {activity.error && !activity.data ? <ErrorState error={activity.error} onRetry={() => void activity.refetch()} /> : <DataTable className="activity-table" loading={activity.isPending} skeletonRows={8} minRows={3} rows={rows} rowKey={entry => entry.id} onRowClick={setOpen}
      empty={<EmptyState title={area ? 'No matching activity' : 'No activity yet'} />} columns={[
        { ...when, render: entry => <When at={entry.at} /> },
        // A card names who did it and where from on one line, and the target only by its name: IDs are in the details.
        { ...who, render: entry => <Cell full={whoText(entry.actor)}><Who actor={entry.actor} /></Cell>, cardRender: entry => <><Who actor={entry.actor} /><span className="muted"> · via {shortSource(entry)}</span></> },
        { ...action, render: entry => <Cell full={actionLabel(entry.action)} hint={entry.action}>{actionLabel(entry.action)}</Cell>, cardRender: entry => actionLabel(entry.action) },
        { ...target, render: entry => <Cell full={targetText(entry)}><Target entry={entry} /></Cell>, cardRender: entry => entry.action === 'support.view' || summaryName(entry) ? <Target entry={entry} /> : null },
        { ...from, render: entry => <Cell full={fromText(entry)} hint={fromText(entry)} className="activity-from"><span>{shortSource(entry)}</span></Cell>, cardRender: fromText },
      ]} />}
    {activity.hasNextPage && <div className="activity-more"><Button loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>Load more</Button></div>}
    {activity.isFetchNextPageError ? <ErrorState error={activity.error} onRetry={() => void activity.fetchNextPage()} /> : null}
    <ActivityDetails entry={open} onClose={() => setOpen(null)} />
  </section>
}

// A summary in words: each field gets a label (paidUc → Paid), money in dollars, times in UTC, a key's access as the
// keys table words it, lists joined. Bookkeeping fields (the payment attempt, a promotion's code) are left out. Any
// address is masked like every address (an invitation's email, a member's), so a shared screen never spells one out.
const fieldLabels: Record<string, string> = { paidUc: 'Paid', amountUc: 'Amount', balanceAfterUc: 'Balance after', balanceBeforeUc: 'Balance before', expiresAt: 'Expires', mcpGrant: 'Agent grant', permissions: 'Access', mail: 'Mail', prefix: 'Key prefix', addressIds: 'Addresses', inboxId: 'Inbox', createdInboxIds: 'Created inboxes' }
const hiddenFields = new Set(['source', 'promo', 'promoCode', 'attemptId'])
const fieldLabel = (key: string) => fieldLabels[key] ?? (key.replace(/Uc$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()))
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
function words(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (/Uc$/.test(key) && (typeof value === 'string' || typeof value === 'number') && /^-?\d+$/.test(String(value))) return usd(String(value))
  if (/At$/.test(key) && typeof value === 'string' && !Number.isNaN(Date.parse(value))) return `${shortDateTime(value)} UTC`
  if (key === 'permissions' && strings(value)) return accessLabel(value, false)
  if (key === 'domains' && strings(value)) return domainScope(value)
  if (key === 'mail' && strings(value)) return mailLabel(value as MailPermission[])
  if (key === 'access' && record(value)) {
    const access = record(value)!, mail = strings(access.mail) ? mailLabel(access.mail as MailPermission[]) : null
    const scope = access.type === 'inbox' ? 'one inbox' : strings(access.addressIds) ? `${access.addressIds.length} ${access.addressIds.length === 1 ? 'address' : 'addresses'}` : null
    return [mail, scope].filter(Boolean).join(' · ') || '—'
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return value.toLocaleString('en-US')
  if (strings(value)) return value.length ? value.join(', ') : 'None'
  const object = record(value)
  if (object) return Object.entries(object).filter(([field, item]) => !hiddenFields.has(field) && item !== undefined && item !== null).map(([field, item]) => `${fieldLabel(field)}: ${words(field, item)}`).join(' · ') || '—'
  return typeof value === 'string' ? value : JSON.stringify(value)
}
const show = (key: string, value: unknown): ReactNode => value === undefined ? '—' : <AddressText text={words(key, value)} />
function Changes({ summary }: { summary: Record<string, unknown> }) {
  const before = record(summary.before), after = record(summary.after)
  const rows: { key: string; value: ReactNode }[] = []
  if (before || after) for (const key of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]) {
    const was = before?.[key], now = after?.[key]
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    if (hiddenFields.has(key)) continue
    rows.push({ key, value: before && after ? <><span className="muted">{show(key, was)}</span> → {show(key, now)}</> : show(key, after ? now : was) })
  }
  else for (const key of ['before', 'after'].filter(key => key in summary)) rows.push({ key, value: show(key, summary[key]) })
  for (const [key, value] of Object.entries(summary)) if (key !== 'before' && key !== 'after' && !hiddenFields.has(key)) rows.push({ key, value: show(key, value) })
  if (!rows.length) return <p className="muted activity-none">No details recorded.</p>
  return <dl className="activity-changes">{rows.map(row => <div key={row.key}><dt>{fieldLabel(row.key)}</dt><dd>{row.value}</dd></div>)}</dl>
}
function ActivityDetails({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  // When it happened leads the facts; where it came from (the channel with its client and network) is From.
  return <Dialog open={entry !== null} onOpenChange={open => { if (!open) onClose() }} title={entry ? actionLabel(entry.action) : ''}>
    {entry && <div className="stack">
      <dl className="settings-facts activity-facts">
        <div><dt>When</dt><dd>{shortDateTime(entry.at)} UTC</dd></div>
        <div><dt>Who</dt><dd><Who actor={entry.actor} /></dd></div>
        <div><dt>Target</dt><dd>{entry.target ? <><Target entry={entry} />{entry.action !== 'support.view' && targetName(entry) !== entry.target.id && entry.target.id && <span className="muted"> · <code>{entry.target.id}</code></span>}</> : '—'}</dd></div>
        <div><dt>From</dt><dd>{[fromText(entry), entry.client ? `via ${channel[entry.via] ?? entry.via}` : null].filter(Boolean).join(' · ')}</dd></div>
        {entry.subject && <div><dt>{entry.action === 'support.view' ? 'Requested by' : 'Member'}</dt><dd>{entry.subject.email ? <PrivateAddress value={entry.subject.email} /> : <code>{entry.subject.userId}</code>}</dd></div>}
        {entry.action === 'support.view' && ticketOf(entry) && <div><dt>Ticket</dt><dd>{ticketOf(entry)}</dd></div>}
        {entry.reason && <div className="settings-fact-wide"><dt>Reason</dt><dd>{entry.reason}</dd></div>}
        <div className="settings-fact-wide"><dt>Request ID</dt><dd>{entry.requestId ? <span className="cluster settings-inline"><code>{entry.requestId}</code><CopyButton value={entry.requestId} label="Copy request ID" /></span> : '—'}</dd></div>
      </dl>
      <div className="stack activity-summary"><h3>Changes</h3><Changes summary={entry.summary} /></div>
    </div>}
  </Dialog>
}
