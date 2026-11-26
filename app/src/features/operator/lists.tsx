import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Alert, Button, DataTable, Dialog, EmptyState, ErrorState, ErrorText, StatusBadge, type Column, type Tone } from '../../components/ui'
import { isoTime, operatorApi, type ListRiskBand, type OperatorListRow } from '../../data/operator'
import { label, number, shortDateTime } from '../../lib/format'
import { listColumnDefs } from './skeletons'

// Operator → Lists: each recent marketing campaign to a list, with the list-risk measure its launch recorded (shares and
// counts of that workspace's own contacts), what the send review said then, and what happened. The measure decides
// nothing yet; this is where it is judged against outcomes. The lines a band was judged by live on the server only.
const def = (key: string) => listColumnDefs.find(column => column.key === key)!
const when = (value: string) => `${shortDateTime(isoTime(value))} UTC`
const percent = (part: number, whole: number) => whole > 0 ? `${(100 * part / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '—'
const share = (value: number | undefined) => value === undefined ? '—' : `${(100 * value).toFixed(value < 0.1 ? 1 : 0)}%`
const bandTone: Record<ListRiskBand, Tone> = { low: 'success', elevated: 'warning', high: 'danger' }
const bandText: Record<ListRiskBand, string> = { low: 'Low', elevated: 'Elevated', high: 'High' }
const factorText: Record<string, string> = { FLAGGED_SOURCE: 'Flagged contacts', DEAD_DOMAINS: 'Dead domains', UNENGAGED: 'Unengaged', NEVER_MAILED: 'Never mailed',
  LAST_SEND_BOUNCES: 'Last send bounces', LAST_SEND_COMPLAINTS: 'Last send complaints', RECENT_BLOCKLIST: 'Blocklist replies, 14 days' }
const verdictText: Record<string, string> = { ready: 'Ready', ramp_recommended: 'Ramp recommended', ramp_required: 'Ramp required' }
const probeText: Record<OperatorListRow['outcome']['probe'], string> = { passed: 'Passed', quarantined: 'Quarantined', none: '—' }
const classText: Record<string, string> = { user_unknown: 'Unknown user', dead_domain: 'Dead domain', mailbox_full: 'Mailbox full', blocklist: 'Blocklist', policy: 'Policy or content',
  reputation: 'Rate or reputation', auth: 'Authentication', validation: 'SES validation', other: 'Other' }
const Band = ({ row }: { row: OperatorListRow }) => !row.measure ? <span className="muted">Not measured</span>
  : row.measure.band ? <StatusBadge status={bandText[row.measure.band]} tone={bandTone[row.measure.band]} /> : <span className="muted">No band</span>
const bandCard = (row: OperatorListRow) => !row.measure ? 'Not measured' : row.measure.band ? `${bandText[row.measure.band]} risk` : 'No band'
const columns: Column<OperatorListRow>[] = [
  { ...def('campaign'), render: row => <span className="op-ws" title={`${row.campaignName} · ${row.workspaceName}`}><span className="op-cell">{row.campaignName}</span><span className="op-muted-id">{row.workspaceName}</span></span>,
    cardRender: row => `${row.campaignName} · ${row.workspaceName}` },
  { ...def('band'), render: row => <Band row={row} />, cardRender: bandCard },
  { ...def('flagged'), render: row => share(row.measure?.values.FLAGGED_SOURCE), cardRender: row => `${share(row.measure?.values.FLAGGED_SOURCE)} flagged` },
  { ...def('review'), render: row => row.review ? verdictText[row.review.verdict] ?? label(row.review.verdict) : <span className="muted">—</span>,
    cardRender: row => row.review ? verdictText[row.review.verdict] ?? label(row.review.verdict) : 'No review kept' },
  { ...def('bounced'), render: row => percent(row.outcome.bounced, row.outcome.accepted), cardRender: row => `${percent(row.outcome.bounced, row.outcome.accepted)} bounced` },
  { ...def('blocklist'), render: row => number(row.outcome.failures.blocklistReplies), cardRender: row => `${number(row.outcome.failures.blocklistReplies)} blocklist` },
  { ...def('probe'), render: row => probeText[row.outcome.probe], cardRender: row => `probe ${probeText[row.outcome.probe].toLowerCase()}` },
  { ...def('launched'), render: row => <span className="nowrap">{when(row.launchedAt)}</span>, cardRender: row => `launched ${when(row.launchedAt)}` },
]

/** The Lists tab of /operator. A row opens what the measure, the review and the outcome each say. */
export function ListsView() {
  const lists = useInfiniteQuery({
    queryKey: ['operator', 'lists'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.lists({ cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (lists.data?.pages ?? []).flatMap(page => page.items)
  const [shown, setShown] = useState<OperatorListRow | null>(null)
  if (lists.isError && !lists.data) return <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />
  return <>
    <DataTable className="op-table" loading={lists.isPending} skeletonRows={6} rows={rows} rowKey={row => row.campaignId} onRowClick={setShown} columns={columns}
      empty={<EmptyState title="No campaigns to lists in the last 90 days" />} />
    {lists.hasNextPage && <Button className="op-more" loading={lists.isFetchingNextPage} onClick={() => void lists.fetchNextPage()}>Load more</Button>}
    {lists.isError && lists.data && <Alert tone="danger"><ErrorText error={lists.error} /></Alert>}
    {shown && <Dialog open onOpenChange={next => { if (!next) setShown(null) }} title={shown.campaignName} footer={<Button onClick={() => setShown(null)}>Close</Button>}>
      <ListDetail row={shown} />
    </Dialog>}
  </>
}

function ListDetail({ row }: { row: OperatorListRow }) {
  const m = row.measure, o = row.outcome, f = o.failures
  const classes = Object.entries(f.classes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return <dl className="op-rows">
    <div><dt>Workspace</dt><dd>{row.workspaceName}</dd></div>
    <div><dt>Recipients</dt><dd>{number(row.recipients)}</dd></div>
    <div><dt>List risk</dt><dd>{bandCard(row)}{m && `, ${m.exact ? 'all' : 'a sample of'} ${number(m.sampled)} contacts`}</dd></div>
    <div><dt>Over the lines</dt><dd>{m?.factors.length ? m.factors.map(x => `${factorText[x.code] ?? x.code} (${x.level})`).join(', ') : '—'}</dd></div>
    {m && Object.entries(factorText).map(([code, text]) => <div key={code}><dt>{text}</dt><dd>{code.startsWith('RECENT') ? number(m.values[code] ?? 0) : share(m.values[code])}</dd></div>)}
    {m && <div><dt>Proven contacts</dt><dd>{m.counts.proven === undefined ? '—' : share(m.counts.proven / Math.max(1, m.sampled))}</dd></div>}
    <div><dt>Review said</dt><dd>{row.review ? [verdictText[row.review.verdict] ?? label(row.review.verdict), row.review.required && `required by ${label(row.review.required.toLowerCase())}`, row.review.reasons.map(r => label(r.toLowerCase())).join(', ')].filter(Boolean).join(' · ') : 'Not kept'}</dd></div>
    <div><dt>Delivered</dt><dd>{`${number(o.delivered)} of ${number(o.accepted)} accepted`}</dd></div>
    <div><dt>Bounced</dt><dd>{`${number(o.bounced)} (${percent(o.bounced, o.accepted)})`}</dd></div>
    <div><dt>Complaints</dt><dd>{`${number(o.complained)} (${percent(o.complained, o.accepted)})`}</dd></div>
    <div><dt>List probe</dt><dd>{probeText[o.probe]}{o.pauseCode && o.pauseCode !== 'LIST_QUALITY' ? `, paused: ${label(o.pauseCode.toLowerCase())}` : ''}</dd></div>
    <div><dt>Failures read</dt><dd>{number(f.read)}{f.read ? `, ${number(f.blocklistReplies)} naming a blocklist` : ''}</dd></div>
    <div><dt>By class</dt><dd>{classes.length ? classes.map(([k, n]) => `${classText[k] ?? k} ${number(n)}`).join(', ') : '—'}</dd></div>
  </dl>
}
