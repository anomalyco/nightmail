import { ChevronRight, Paperclip, Reply } from 'lucide-react'
import { StatusBadge, type Column, type SkeletonColumn } from '../../components/ui'
import { PrivateAddress, Sender } from '../../components/PrivateAddress'
import type { LogDirection, LogEntry } from '../../data/types'
import { useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { preloadRouteChunk, usePrefetchQueries } from '../../data/prefetch'
import { date, label } from '../../lib/format'
import { receivedTo } from '../../lib/private-address'

// One log row, shared by Logs and Overview's latest emails: the same columns, masking and click-through in both, for sent
// and received mail alike. On a phone each row is a card: the subject (the link) and the time, then direction, status and
// the other party (LogParty).
export const logColumnDefs: SkeletonColumn[] = [
  { key: 'time', label: 'Time · UTC', width: 148, card: 'aside' }, { key: 'direction', label: <span className="sr-only">Direction</span>, width: 48, card: 'line' },
  { key: 'status', label: 'Status', width: 124, card: 'inline' }, { key: 'from', label: 'From', width: '14%', card: 'inline' }, { key: 'to', label: 'To', width: '14%', card: 'hide' },
  { key: 'subject', label: 'Subject', card: 'title' }, { key: 'stream', label: 'Stream', width: 116, card: 'hide' }, { key: 'open', label: '', width: 28, card: 'hide' },
]

export const logTimestamp = (value: string) => date(value, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
// A stream's time: the date muted, the time bright (both UTC).
const LogTime = ({ at }: { at: string }) => <span className="log-time" title={at}><span className="log-time__date">{date(at, { month: 'short', day: '2-digit', timeZone: 'UTC' })}</span> {date(at, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })}</span>
// A card's time: the hour today, the date before that (UTC, like the table).
const cardTime = (value: string) => date(value, value.slice(0, 10) === new Date().toISOString().slice(0, 10) ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
// The row link's name (its visible text is only the time): which way, how it went, the subject and when.
export const logRowLabel = (row: LogEntry) => `${row.direction === 'sent' ? 'Sent' : 'Received'}, ${row.direction === 'sent' ? label(row.status) : row.status === 'spam' ? 'Spam' : 'Received'}: ${row.subject || '(no subject)'}, ${logTimestamp(row.at)} UTC`
// Sent and received mail open at /logs/:id; received message IDs start with msg_.
export const logHref = (row: Pick<LogEntry, 'id'>) => `/logs/${encodeURIComponent(row.id)}`
export const isReceivedId = (id: string) => id.startsWith('msg_')
// A row about to be opened: warm its detail read (and the Logs code, from Overview).
export function useLogRowIntent() {
  const warm = usePrefetchQueries()
  const { canAdminister } = useWorkspaceAccess()
  return (row: Pick<LogEntry, 'id'>) => { void preloadRouteChunk('/logs'); void warm([isReceivedId(row.id) ? queries.receivedEmail(row.id, canAdminister) : queries.email(row.id)]) }
}

// A threaded row's message count, after its subject (the detail page lists them).
function ThreadCount({ count }: { count: number }) {
  return <span className="log-thread" title={`${count} messages in this thread`}><Reply size={12} aria-hidden="true" />{count}<span className="sr-only"> messages in this thread</span></span>
}
// Who received mail was for (lib/private-address.ts), masked like every address.
function ReceivedTo({ row }: { row: LogEntry }) {
  const to = receivedTo(row)
  return to ? <PrivateAddress value={to} /> : <span className="muted">—</span>
}
function SentTo({ to, total }: { to: string[]; total?: number }) {
  if (!to.length) return <span className="muted">—</span>
  const more = Math.max(to.length, total ?? to.length) - 1
  return <PrivateAddress value={to[0]!}>{more > 0 && <span className="muted">&nbsp;+{more}</span>}</PrivateAddress>
}
// Who sent it: the sender's display name where it has one (names stay readable while addresses are blurred), else the
// masked address.
const From = ({ row }: { row: LogEntry }) => <bdi className="log-from"><Sender name={row.from.name} address={row.from.address} nameOnly /></bdi>
/** The other party, saying which way: "To" and the first recipient for sent mail, "From" and the sender for received mail.
 *  One cell for every list that has a single column for it (Overview's latest emails, a phone's card). */
export function LogParty({ row }: { row: LogEntry }) {
  return <span className="log-party"><span className="log-party__way">{row.direction === 'sent' ? 'To' : 'From'}</span>{row.direction === 'sent' ? <SentTo to={row.to} total={row.toCount} /> : <From row={row} />}</span>
}

export const logColumns: Column<LogEntry>[] = [
  { ...logColumnDefs[0]!, render: row => <LogTime at={row.at} />, cardRender: row => <time dateTime={row.at} title={`${logTimestamp(row.at)} UTC`}>{cardTime(row.at)}</time> },
  { ...logColumnDefs[1]!, render: row => <span className="log-direction" data-direction={row.direction} title={row.direction === 'sent' ? 'Sent' : 'Received'}>{row.direction === 'sent' ? 'Out' : 'In'}</span> },
  { ...logColumnDefs[2]!, render: row => row.direction === 'sent' ? <StatusBadge status={row.status} /> : row.status === 'spam' ? <StatusBadge status="Spam" tone="danger" /> : <StatusBadge status="Received" tone="success" /> },
  { ...logColumnDefs[3]!, render: row => <From row={row} />, cardRender: row => <LogParty row={row} /> },
  { ...logColumnDefs[4]!, render: row => row.direction === 'sent' ? <SentTo to={row.to} total={row.toCount} /> : <ReceivedTo row={row} /> },
  // The subject first, so subjects line up down the list; an attachment's clip and a thread's count follow it.
  { ...logColumnDefs[5]!, render: row => <span className="log-subject" title={row.subject}><span className={row.subject ? undefined : 'muted'}>{row.subject || '(no subject)'}</span>{(row.attachmentCount ?? 0) > 0 && <Paperclip className="log-clip" size={12} aria-label={`${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`} />}{(row.threadCount ?? 0) > 1 && <ThreadCount count={row.threadCount!} />}</span> },
  { ...logColumnDefs[6]!, render: row => <span className="muted">{row.stream ? label(row.stream) : '—'}</span> },
  { ...logColumnDefs[7]!, render: () => <ChevronRight size={14} aria-hidden /> },
]

// The Logs page gives Status the room its longest label needs ("Acceptance unknown", in mono); Overview keeps the compact column.
// Its last column also holds a scheduled email's menu (features/logs/scheduled.tsx), at the end of its card on a phone.
// The subject keeps the room: the addresses take less, and the stream shows only on a wide window (logs.css).
const wide = <T extends { key: string; width?: number | string; card?: SkeletonColumn['card'] }>(columns: T[]): T[] => columns.map(column => column.key === 'status' ? { ...column, width: 164 } : column.key === 'open' ? { ...column, width: 40, card: 'end' } : column.key === 'from' || column.key === 'to' ? { ...column, width: '12%' } : column.key === 'stream' ? { ...column, width: 124 } : column)
const logsPageColumns = wide(logColumns)
const logsPageColumnDefs = wide(logColumnDefs)
// Sent and Received are the same list in the same columns, each row's status included (Received or Spam for received
// mail, as under All). Only All mixes directions, so only All has the direction column; received mail has no stream, so
// Received has no stream column.
const forView = <T extends { key: string }>(columns: T[], direction: LogDirection) => columns.filter(column => !(column.key === 'direction' && direction !== 'all') && !(column.key === 'stream' && direction === 'received'))
export const logsViewColumns = (direction: LogDirection): Column<LogEntry>[] => forView(logsPageColumns, direction)
export const logsViewColumnDefs = (direction: LogDirection) => forView(logsPageColumnDefs, direction)

// CSV is an explicit export: addresses in full, like the detail pages.
export function logCsvRows(rows: LogEntry[], regions: boolean): string[][] {
  return [['Direction', 'Time', 'Status', 'From', 'To', 'Subject', 'Stream', ...regions ? ['Region'] : []],
    ...rows.map(row => [row.direction, row.at, row.status, row.from.address, (row.direction === 'received' ? row.envelopeTo ?? row.to : row.to).join(' '), row.subject, row.stream ?? '', ...regions ? [row.regionId ?? ''] : []])]
}
