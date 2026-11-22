import { Fragment, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Download, Paperclip, Search, X } from 'lucide-react'
import { useApiDef, useApiQuery, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { LogDirection, LogEntry, ReceivedEmailDetail, TimeRange } from '../../data/types'
import { Alert, Button, CopyButton, DataTable, EmptyState, ErrorState, Input, PaginationSkeleton, PageHeader, Pagination, SectionHeader, Select, Sheet, StatusBadge, Tabs } from '../../components/ui'
import { ReceivedEmailPreview } from '../../components/EmailPreview'
import { date, fileSize, label, time } from '../../lib/format'
import { downloadCsv } from '../../lib/download'
import { ReceivedEmailSkeleton } from './skeletons'
import { isReceivedId, logsPageColumns, logCsvRows, logHref, logRowLabel, useLogRowIntent } from './rows'
import { useAdaptivePageSize, useSearchDraft } from '../../lib/pagination'
import { AddressList, PrivateAddress, Sender } from '../../components/PrivateAddress'
import { EmailDetailPage } from './email-detail'
import { useScheduledActions } from './scheduled'
import { ThreadChip, ThreadTimeline, threaded, threadItems, useThreadPrefetch } from './thread'
import { useMediaQuery } from '../../lib/media'
import { LogsBody, logStatuses, receivedStatuses, searchCopy, sentStatuses, withStream, type LogFilters } from './facets'
import { logRange, logRanges, rangeStart } from './range'

const directions = [{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]
const option = (value: string) => ({ value, label: value === 'all' ? 'All statuses' : label(value) })
const streams = [{ value: 'all', label: 'All streams' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]
export const logDirection = (view: string | null, campaignId?: string): LogDirection => campaignId ? 'sent' : view === 'sent' || view === 'received' ? view : 'all'
// A range's start (range.ts), kept until another range is chosen.
function useRangeStart(range: TimeRange) {
  const [start, setStart] = useState(() => ({ range, from: rangeStart(range) }))
  if (start.range === range) return start.from
  const next = { range, from: rangeStart(range) }
  setStart(next)
  return next.from
}
// A substring search needs 3 characters (the API refuses fewer): until then the list isn't searched.
const searchTerm = (value: string) => value.trim().length >= 3 ? value.trim() : ''

// Logs: sent and received mail in one list, newest first (GET /v1/logs). Received mail follows the API's rules: owners
// and admins see every received message, including unrouted mail; members see mail on receiving addresses.
export function LogsPage() {
  const { regionId } = useRegion()
  const [params] = useSearchParams()
  const campaignId = params.get('campaign') || undefined
  return <Logs key={`${regionId}:${campaignId ?? ''}`} regionId={regionId} campaignId={campaignId} />
}
// The sidebar's region selector already names the region; repeat it only when it is hidden or a campaign filter shows another region.
// Hosted logs span every region and name none.
function LogsHeader({ regionId, direction, onDirection, locked, range, onRange }: { regionId: string; direction: LogDirection; onDirection: (value: LogDirection) => void; locked?: boolean; range: TimeRange; onRange: (value: TimeRange) => void }) {
  const selected = useRegion().regionId
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  return <PageHeader title="Logs" actions={<div className="cluster logs-controls">{!multiTenant && (!canAdminister || regionId !== selected) && <span className="muted">{regionId}</span>}
    <Tabs label="Direction" value={direction} onValueChange={value => onDirection(value as LogDirection)} disabled={locked} items={directions} />
    <Tabs label="Time range" value={range} onValueChange={value => onRange(value as TimeRange)} items={logRanges} /></div>} />
}
// Everything that decides the rows is in the URL (view, q, status, stream, page), so Back from an email, a reload or a
// shared link shows the same page of the same list. Filters replace the entry instead of adding one per keystroke.
function Logs({ regionId, campaignId }: { regionId: string; campaignId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const rowIntent = useLogRowIntent()
  const scheduled = useScheduledActions()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  // A campaign sends from one region, so its filter replaces the region selector; it lists sent mail only.
  const campaign = useApiQuery(['campaign', campaignId ?? null], (api, signal) => campaignId ? api.campaigns.get(campaignId, signal) : Promise.resolve(null))
  const direction = logDirection(searchParams.get('view'), campaignId)
  const search = searchParams.get('q') ?? '', searched = searchTerm(search)
  const range = logRange(searchParams.get('range')), from = useRangeStart(range)
  const statuses = logStatuses(direction, { campaign: Boolean(campaignId), canAdminister }), allowed = new Set(statuses)
  const requested = searchParams.get('status') ?? 'all'
  const status = allowed.has(requested) ? requested : 'all'
  const receivedOnly = direction === 'received' || receivedStatuses.includes(status)
  const copy = searchCopy(Boolean(campaignId), !receivedOnly, Boolean(searched))
  const requestedStream = searchParams.get('stream')
  const stream = !receivedOnly && (requestedStream === 'transactional' || requestedStream === 'marketing') ? requestedStream : 'all'
  const page = Math.max(1, Math.floor(Number(searchParams.get('page'))) || 1)
  const update = (changes: Record<string, string | null>, keepPage = false) => setSearchParams(previous => {
    const next = new URLSearchParams(previous)
    for (const [key, value] of Object.entries(changes)) if (value === null || value === '' || value === 'all') next.delete(key); else next.set(key, value)
    if (!keepPage) next.delete('page')
    return next
  }, { replace: true })
  const clearCampaign = () => update({ campaign: null })
  const [draft, type] = useSearchDraft(search, value => update({ q: value }))
  const {pageSize, tableRef, measured} = useAdaptivePageSize(5, 100, 'logs')
  // A new page size (the window resized) starts from the first page; the size settling on mount keeps the URL's page.
  const fitted = useRef<number | null>(null)
  useEffect(() => { if (!measured) return; if (fitted.current !== null && fitted.current !== pageSize) update({ page: null }); fitted.current = pageSize }, [pageSize, measured]) // eslint-disable-line react-hooks/exhaustive-deps
  // Status and stream follow the direction: a sent status leaves Received, received and spam leave Sent, and streams are sent mail only.
  const setDirection = (value: LogDirection) => update({ view: value, status: value === 'received' && sentStatuses.includes(status) || value === 'sent' && receivedStatuses.includes(status) ? null : status, stream: value === 'received' ? null : stream })
  const params = { ...(campaignId ? { campaignId } : { regionId }), direction, search: searched, status: status === 'all' ? undefined : status, stream: stream === 'all' ? undefined : stream, from, page, pageSize }
  const query = useApiDef(queries.logs(params), { interval: 30_000, enabled: measured, keepPrevious: true })
  // The filters' counts, for the list's dates under the other filters: read only where the filters are on screen
  // (logs.css), apart from the list, which never waits for them. Counts the API can't finish in time are refused: the
  // filters keep their dashes, and they aren't asked again until the filters or dates change.
  const railed = useMediaQuery('(min-width: 1440px)')
  const counts = useApiDef(queries.logCounts({ ...(campaignId ? { campaignId } : { regionId }), direction, search: searched, status: params.status, stream: params.stream, from }), { interval: (_, failed) => failed ? false : 30_000, enabled: railed, keepPrevious: true })
  // A page the session has no cursor for (a reload, or the window's page size changed) comes back as page 1: say so in the URL too.
  const served = query.data && !query.isPlaceholderData ? query.data.page : undefined
  useEffect(() => { if (served !== undefined && served !== page) update({ page: served === 1 ? null : String(served) }, true) }, [served, page]) // eslint-disable-line react-hooks/exhaustive-deps
  // The previous filter's rows stay on screen while the next loads, keyed apart from the result that replaces them: a
  // row in both lists (received mail under All and Received) is swapped in place, not moved down the table.
  const filtered = Boolean(searched || campaignId || status !== 'all' || stream !== 'all' || range !== '30d')
  // A campaign's own empty state needs its summary: wait for it, or offer to retry it, before calling the list unmatched.
  const campaignOnly = Boolean(campaignId) && !searched && status === 'all' && stream === 'all' && range === '30d'
  // The filters beside the list set the same URL filters as the toolbar's pickers, which they replace from 1440 px.
  const setStatus = (value: string) => update({ status: value, ...receivedStatuses.includes(value) ? { stream: null } : {} })
  const filters: LogFilters = { statuses, status, stream, streams: !receivedOnly, setStatus, setStream: value => update({ stream: value }) }
  // No mail at all yet: the first-run message alone, without a rail of zeros (its place stays, so nothing moves).
  const blank = Boolean(query.data && !query.isPlaceholderData && !query.data.items.length && !filtered && page === 1)
  // An export is the rows on screen for the filters shown: while the next filter's rows load, the previous rows stay up
  // but can't be exported, and neither can rows while the search box holds text the list hasn't searched for yet.
  const exportable = Boolean(query.data?.items.length) && !query.isPlaceholderData && draft.trim() === searched
  return <div className="logs-page"><LogsHeader regionId={campaign.data?.regionId ?? regionId} direction={direction} onDirection={setDirection} locked={Boolean(campaignId)} range={range} onRange={value => update({ range: value === '30d' ? null : value })} />
    <div className="data-toolbar"><div className="cluster">{campaignId && <Button variant="secondary" aria-label={`Remove campaign filter: ${campaign.data?.name ?? campaignId}`} onClick={clearCampaign} title={campaign.data?.name}><span className="logs-campaign-chip">Campaign: {campaign.data?.name ?? campaignId}</span><X size={14} aria-hidden /></Button>}<div className="search-box"><Search size={16} /><Input type="search" aria-label="Search logs" placeholder={copy.placeholder} maxLength={200} value={draft} onChange={event => type(event.target.value)} /></div>
      <Select className="logs-filter" aria-label="Email status" value={status} onValueChange={setStatus} options={['all', ...statuses].map(value => ({ ...option(value), disabled: !withStream(value, stream) }))} />
      <Select className="logs-filter" aria-label="Email stream filter" value={stream} disabled={receivedOnly} onValueChange={value => update({ stream: value })} options={streams} /></div>
      <Button className="logs-export" aria-label="Export this page as CSV" title="Download the rows on this page as a CSV file" disabled={!exportable} onClick={() => downloadCsv(campaignId ? `nightmail-${campaignId}-logs-page.csv` : 'nightmail-logs-page.csv', logCsvRows(query.data?.items ?? [], !multiTenant))}><Download size={16} /><span>Export CSV</span></Button>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <LogsBody counts={counts.data} filters={filters} blank={blank}>
      <DataTable<LogEntry> className="logs-table" tableRef={tableRef} loading={query.isPending || (campaignOnly && campaign.isPending)} skeletonRows={pageSize} minRows={pageSize} rows={query.data?.items ?? []} rowKey={row => `${query.isPlaceholderData ? 'previous:' : ''}${row.direction}:${row.id}`} rowHref={logHref} rowLabel={logRowLabel} onRowIntent={rowIntent} columns={scheduled.columns(logsPageColumns)}
        empty={campaignOnly && campaign.isError && !campaign.data ? <ErrorState error={campaign.error} onRetry={() => campaign.refetch()} />
          // A campaign that hasn't sent says when it will, in its heading.
          : campaignId && campaignOnly && campaign.data && !campaign.data.counts?.total ? <EmptyState title={campaign.data.scheduledAt && Date.parse(campaign.data.scheduledAt) > Date.now() ? `Scheduled for ${date(campaign.data.scheduledAt)} at ${time(campaign.data.scheduledAt)} UTC` : 'Nothing sent from this campaign yet'} action={<Link className="ui-button ui-button--secondary ui-button--md" to={`/campaigns/${encodeURIComponent(campaignId)}/review`}>Back to campaign</Link>} />
          : filtered ? <EmptyState title={copy.emptyTitle} action={<Button onClick={() => update({ q: null, status: null, stream: null, campaign: null, range: null, ...direction !== 'all' && !campaignId ? { view: null } : {} })}>Clear filters</Button>} />
          : <EmptyState title={direction === 'received' ? 'No mail received yet' : direction === 'sent' ? 'No mail sent yet' : 'No mail yet'} action={direction === 'received' ? <Link className="ui-button ui-button--primary ui-button--md" to="/receiving">Set up receiving</Link> : <Link className="ui-button ui-button--primary ui-button--md" to="/docs#quickstart">Send your first email</Link>} />} />
      {scheduled.dialogs}
      {query.data ? <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} count={query.data.items.length} onPageChange={next => update({ page: next === 1 ? null : String(next) }, true)} /> : <PaginationSkeleton />}
    </LogsBody>}
  </div>
}

// One detail route for both directions: received message IDs start with msg_.
export function LogDetailPage() {
  const { id = '' } = useParams()
  return isReceivedId(id) ? <ReceivedEmailDetailPage /> : <EmailDetailPage />
}

const checkTone = (value?: string) => value === 'PASS' ? 'success' as const : value === 'FAIL' ? 'danger' as const : value === 'GRAY' ? 'warning' as const : 'neutral' as const
// NONE is a sender without the record to check, not a failure: the badge says so.
const verdictLabel = (value: string) => value.toUpperCase() === 'NONE' ? 'no record' : label(value.toLowerCase())
export function ReceivedEmailDetailPage() {
  const { id = '' } = useParams()
  // Delivery details (envelope, region, verdicts, headers, the raw .eml) are for owners and admins; members read the message.
  const { canAdminister } = useWorkspaceAccess()
  // Moving to another message of its thread keeps this one up until that one arrives, as a sent email does.
  const query = useApiDef(queries.receivedEmail(id, canAdminister), { keepPrevious: true })
  if (query.isPending) return <ReceivedEmailSkeleton />
  if (query.isError) return <><PageHeader title="Received email" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return <ReceivedEmailDetailView key={query.data.id} email={query.data} focus={id} />
}
function ReceivedEmailDetailView({ email, focus }: { email: ReceivedEmailDetail; focus: string }) {
  const { multiTenant } = useWorkspaceAccess()
  const [view, setView] = useState('preview')
  // Its conversation heads the details beside the body; where they stack under it (850 px and narrower), a sheet opens it from the header.
  const thread = threaded(email.thread) ? email.thread : null
  const items = threadItems(thread, focus)
  const [sheet, setSheet] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  const open = { warm: useThreadPrefetch(items), onNavigate: () => setSheet(false) }
  const stacked = useMediaQuery('(max-width: 850px)')
  // Inline images reference attachments by Content-ID. The preview swaps in the signed S3 link only for an
  // exact img[src="cid:…"] after sanitizing, never by text replacement in sender-controlled HTML (L15).
  const html = email.html ?? ''
  const inlineImages = Object.fromEntries(email.attachments.flatMap(file => file.contentId && file.url ? [[file.contentId, file.url]] : []))
  const hasHtml = html.trim().length > 0
  const verdicts = email.verdicts ?? {}
  const checks = (['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const).filter(key => verdicts[key])
  // To is the envelope when the API has it. When every recipient is one of the receiving addresses, they link to the inbox and the Address row would only repeat them.
  const recipients = email.envelopeTo?.length ? email.envelopeTo : email.to.map(to => to.address)
  const inboxFor = (address: string) => email.addresses?.find(mailbox => mailbox.address.toLowerCase() === address.toLowerCase())
  const routed = Boolean(email.addresses?.length) && recipients.every(address => inboxFor(address))
  const chip = thread && stacked && <ThreadChip count={thread.count} onOpen={from => { opener.current = from; setSheet(true) }} />
  return <div className="email-detail-page"><PageHeader title={email.subject || '(no subject)'} backTo="/logs" actions={email.rawUrl || chip ? <>{chip}{email.rawUrl && <a className="ui-button ui-button--secondary ui-button--md" href={email.rawUrl}><Download size={16} />Download .eml</a>}</> : undefined} />
    <dl className="email-metadata"><div><dt>From</dt><dd><Sender name={email.from.name} address={email.from.address} /></dd></div><div><dt>To</dt><dd>{recipients.map((address, index) => <Fragment key={`${index}:${address}`}>{index > 0 && ', '}{inboxFor(address) ? <Link to={`/receiving/inbox?address=${encodeURIComponent(inboxFor(address)!.id)}&thread=${encodeURIComponent(email.threadId)}&message=${encodeURIComponent(email.id)}`}><PrivateAddress value={address} /></Link> : <PrivateAddress value={address} />}</Fragment>)}</dd></div>{email.addresses && !routed && <div><dt>Address</dt><dd>{email.addresses.length ? email.addresses.map((mailbox, index) => <Fragment key={mailbox.id}>{index > 0 && ', '}<Link to={`/receiving/inbox?address=${encodeURIComponent(mailbox.id)}&thread=${encodeURIComponent(email.threadId)}&message=${encodeURIComponent(email.id)}`}><PrivateAddress value={mailbox.address} /></Link></Fragment>) : 'Unrouted'}</dd></div>}</dl>
    {email.spam && <Alert tone="warning">SES flagged this message as spam or a virus.</Alert>}
    {email.bodyTruncated && <Alert tone="info">Part of this message was too large to store. Download the original for the full content.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'plain', label: 'Plain text' }, { value: 'html', label: 'HTML' }, { value: 'headers', label: 'Headers' }]} />
      {view === 'preview' ? hasHtml ? <><ReceivedEmailPreview html={html} tooComplex={email.htmlTooComplex} title="Received message preview" inlineImages={inlineImages} />{email.htmlTooComplex && email.text && <pre className="plain-text-preview">{email.text}</pre>}</> : email.text ? <pre className="plain-text-preview">{email.text}</pre> : <EmptyState title="This message has no body" />
        : view === 'plain' ? <pre className="message-source">{email.text || 'No plain-text body.'}</pre>
        : view === 'html' ? <pre className="message-source">{email.html || 'No HTML body.'}</pre>
        : <pre className="message-source">{(email.headers ?? []).map(header => `${header.name}: ${header.value}`).join('\n') || 'No headers stored.'}</pre>}
    </section><section className="delivery-timeline received-details">
      {thread && !stacked && <ThreadTimeline thread={thread} items={items} open={open} />}
      <SectionHeader title="Details" />
      <dl className="received-facts">
        <div><dt>Received</dt><dd>{date(email.receivedAt)} · {time(email.receivedAt)} UTC</dd></div>
        {email.sentAt && <div><dt>Sent</dt><dd>{date(email.sentAt)} · {time(email.sentAt)} UTC</dd></div>}
        {checks.length > 0 && <div><dt>Checks</dt><dd><span className="cluster">{checks.map(key => <StatusBadge key={key} status={`${key.toUpperCase()} ${verdictLabel(String(verdicts[key]))}`} tone={checkTone(String(verdicts[key]))} />)}</span></dd></div>}
        {email.cc.length > 0 && <div><dt>Cc</dt><dd><AddressList values={email.cc.map(cc => cc.address)} /></dd></div>}
        {email.replyTo.length > 0 && <div><dt>Reply-To</dt><dd><AddressList values={email.replyTo.map(r => r.address)} /></dd></div>}
        {email.sizeBytes != null && <div><dt>Size</dt><dd>{fileSize(email.sizeBytes)}</dd></div>}
      </dl>
      {email.attachments.length > 0 && <div className="received-group"><h3 className="received-heading">Attachments</h3><ul className="received-attachments">{email.attachments.map(file => <li key={file.id}>
        <Paperclip size={14} aria-hidden />{file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a> : <span>{file.filename}</span>}<span className="muted">{fileSize(file.size)}{file.disposition === 'inline' ? ' · inline' : ''}</span>
      </li>)}</ul></div>}
    </section></div>
    <div className="message-identifiers"><span className="cluster">Message ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy message ID" /></span>{email.messageId && <span className="cluster">Message-ID <span className="identifier" title={email.messageId}>{email.messageId}</span><CopyButton value={email.messageId} label="Copy Message-ID header" /></span>}{!multiTenant && <span>SES · {email.region ?? '—'}</span>}</div>
    {thread && stacked && <Sheet open={sheet} onOpenChange={setSheet} title={`Thread · ${thread.count}`} className="email-detail-sheet" returnFocus={opener}>
      <ThreadTimeline thread={thread} items={items} open={open} titled={false} />
    </Sheet>}
  </div>
}
