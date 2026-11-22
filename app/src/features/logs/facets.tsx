import type { ReactNode } from 'react'
import { FacetRail, SplitPane, statusTone, type FacetGroup, type Tone } from '../../components/ui'
import type { LogCounts, LogDirection, LogEntry } from '../../data/types'
import { label, number } from '../../lib/format'

// Logs' filters beside the list (Signal Log), from 1440 px; narrower, the toolbar's status and stream pickers filter
// instead, so each filter is on screen once. Each value counts what choosing it would list: the log's dates under the
// other filters (GET /v1/logs?counts=true), not the page on screen. Counts that take too long never arrive: the statuses
// keep their dashes. A direction lists a fixed set of rows, so the route
// skeleton, a loading page and a loaded one hold the same space, and counts arriving move nothing.
// A status's colour is its badge's in the table (rows.tsx): received mail is green, spam red, sent mail its StatusBadge tone.
export const logTone = (row: Pick<LogEntry, 'status'>): Tone => row.status === 'received' ? 'success' : row.status === 'spam' ? 'danger' : statusTone(row.status)

// Sent statuses, most looked-for first; received and spam filter received mail (spam is visible to owners and admins).
export const sentStatuses = ['delivered', 'bounced', 'complained', 'delayed', 'suppressed', 'rejected', 'rendering_failed', 'scheduled', 'queued', 'attempting', 'accepted', 'sent', 'canceled', 'acceptance_unknown', 'simulated']
export const receivedStatuses = ['received', 'spam']
/** The statuses a list can filter by, in the order the pickers show them. */
export function logStatuses(direction: LogDirection, { campaign, canAdminister }: { campaign: boolean; canAdminister: boolean }) {
  const allowed = new Set([...direction === 'received' ? [] : sentStatuses, ...campaign || direction === 'sent' ? [] : canAdminister ? receivedStatuses : ['received']])
  return [...receivedStatuses, ...sentStatuses].filter(status => allowed.has(status))
}
// The search box's hint: a campaign's emails are found by their exact address or email ID, not part of it.
export const searchHint = (campaign: boolean) => campaign ? 'Exact address or email ID' : 'Search logs'
/** Whether a status can be combined with the chosen stream: received mail has none. */
export const withStream = (status: string, stream: string) => stream === 'all' || !receivedStatuses.includes(status)
// Always a row of their own: the outcomes people come for. Every other status is in one Other row's menu.
const PINNED = ['delivered', 'received', 'bounced', 'complained', 'scheduled', 'spam']

export type LogFilters = { statuses: string[]; status: string; stream: string; streams: boolean; setStatus: (value: string) => void; setStream: (value: string) => void }
type RailFilters = Pick<LogFilters, 'statuses' | 'streams'> & Partial<LogFilters>
export function logFacetGroups(counts: LogCounts | undefined, filters: RailFilters): FacetGroup[] {
  const count = (status: string) => counts ? counts.status[status] ?? 0 : null
  const choose = (status: string) => filters.setStatus?.(filters.status === status ? 'all' : status)
  // Received mail has no stream: while one is chosen, Received and Spam keep their rows (nothing moves) but neither count
  // nor choose, since choosing one would drop the stream and list mail the count left out.
  const streamless = (status: string) => !withStream(status, filters.stream ?? 'all')
  const pinned = PINNED.filter(status => filters.statuses.includes(status)), others = filters.statuses.filter(status => !PINNED.includes(status))
  const chosen = filters.status && others.includes(filters.status) ? filters.status : null
  // Other opens the statuses with mail (all of them until the counts arrive), each with its count; none, and it is just a zero.
  const listed = others.filter(status => !counts || status === chosen || (count(status) ?? 0) > 0)
  const menu = filters.setStatus && listed.length ? listed.map(status => ({ label: counts ? `${label(status)} · ${number(count(status) ?? 0)}` : label(status), onSelect: () => choose(status) })) : undefined
  const groups: FacetGroup[] = [{ key: 'status', title: 'Status', items: [
    ...pinned.map(status => streamless(status) ? { key: status, label: label(status), tone: logTone({ status }), count: null, title: 'Received mail has no stream' }
      : { key: status, label: label(status), tone: logTone({ status }), count: count(status), ...filters.setStatus && { selected: filters.status === status, onSelect: () => choose(status) } }),
    ...others.length ? [{ key: 'other', label: chosen ? label(chosen) : 'Other', tone: chosen ? logTone({ status: chosen }) : 'neutral' as Tone, dot: Boolean(chosen),
      count: counts ? chosen ? count(chosen) : others.reduce((sum, status) => sum + (count(status) ?? 0), 0) : null, selected: Boolean(chosen), menuLabel: chosen ? `Other statuses: ${label(chosen)}` : 'Other statuses', menu }] : [],
  ] }]
  // Streams are sent mail's: received mail has none, so the group leaves with it.
  if (filters.streams) groups.push({ key: 'stream', title: 'Stream', items: (['transactional', 'marketing'] as const).map(stream => ({ key: stream, label: label(stream), dot: false, count: counts ? counts.stream[stream] : null,
    ...filters.setStream && { selected: filters.stream === stream, onSelect: () => filters.setStream!(filters.stream === stream ? 'all' : stream) } })) })
  return groups
}

/** The list's body with its filters beside it. `blank`: a log with no mail at all keeps the rail's place, empty. */
export function LogsBody({ counts, filters, blank, children }: { counts: LogCounts | undefined; filters: RailFilters; blank?: boolean; children: ReactNode }) {
  return <SplitPane className="logs-split" rail={blank ? null : <FacetRail label="Filters" groups={logFacetGroups(counts, filters)} />}>{children}</SplitPane>
}
