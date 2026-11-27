import type { ReactNode } from 'react'
import { FacetRail, SplitPane, statusTone, type Facet, type FacetGroup, type Tone } from '../../components/ui'
import type { LogCounts, LogDirection, LogEntry } from '../../data/types'
import { label } from '../../lib/format'

// Logs' filters beside the list, from 1440 px; narrower, the toolbar's status and stream pickers filter instead, so
// each filter is on screen once. Each value counts what choosing it would list: the log's dates under the other filters
// (GET /v1/logs/facets), not the page on screen. Until the exact response arrives, the statuses keep their dashes. A
// direction lists a fixed set of rows, so the route skeleton, a loading page and a loaded one hold the same space, and
// counts arriving move nothing.
// A status's colour is its badge's in the table (rows.tsx): received mail is green, spam red, sent mail its StatusBadge tone.
export const logTone = (row: Pick<LogEntry, 'status'>): Tone => row.status === 'received' ? 'success' : row.status === 'spam' ? 'danger' : statusTone(row.status)

// Core sent statuses shown by default; rare and internal pipeline states fold into the More menu in the facet rail.
export const primarySentStatuses = ['delivered', 'bounced', 'complained', 'delayed', 'rejected', 'scheduled']
export const moreSentStatuses = [
  'suppressed', 'rendering_failed', 'accepted', 'queued', 'attempting', 'sent',
  'canceled', 'acceptance_unknown', 'simulated',
]
export const sentStatuses = [...primarySentStatuses, ...moreSentStatuses]
export const receivedStatuses = ['received', 'spam']
/** Every status a direction accepts from the URL or filter menu. */
export function logStatuses(direction: LogDirection, { campaign, canAdminister }: { campaign: boolean; canAdminister: boolean }) {
  const allowed = new Set([...direction === 'received' ? [] : sentStatuses, ...campaign || direction !== 'received' ? [] : canAdminister ? receivedStatuses : ['received']])
  return [...receivedStatuses, ...sentStatuses].filter(status => allowed.has(status))
}
/** Statuses shown directly in the narrow/phone picker: core statuses plus any rare status currently active in the URL. */
export function pickerStatuses(statuses: string[], active: string) {
  const rare = new Set(moreSentStatuses)
  return statuses.filter(status => !rare.has(status) || status === active)
}
/** Whether a status can be combined with the chosen stream: received mail has none. */
export const withStream = (status: string, stream: string) => stream === 'all' || !receivedStatuses.includes(status)
const countWidth = 68

export type LogFilters = { statuses: string[]; status: string; stream: string; streams: boolean; setStatus: (value: string) => void; setStream: (value: string) => void }
type RailFilters = Pick<LogFilters, 'statuses' | 'streams'> & Partial<LogFilters>
export function logFacetGroups(counts: LogCounts | undefined, filters: RailFilters): FacetGroup[] {
  // Exact counts omit statuses with zero matches; while counts are pending, show dashes so every row keeps its slot.
  const count = (status: string) => counts ? (counts.status[status] ?? 0) : null
  const choose = (status: string) => filters.setStatus?.(filters.status === status ? 'all' : status)
  // Received mail has no stream: while one is chosen, Received and Spam keep their rows (nothing moves) but neither count
  // nor choose, since choosing one would drop the stream and list mail the count left out.
  const streamless = (status: string) => !withStream(status, filters.stream ?? 'all')
  const rare = new Set(moreSentStatuses)
  const main = filters.statuses.filter(status => !rare.has(status))
  const extra = filters.statuses.filter(status => rare.has(status))
  const items: Facet[] = main.map(status =>
    streamless(status)
      ? { key: status, label: label(status), tone: logTone({ status }), count: null, title: 'Received mail has no stream' }
      : { key: status, label: label(status), tone: logTone({ status }), count: count(status), ...filters.setStatus && { selected: filters.status === status, onSelect: () => choose(status) } }
  )
  if (extra.length) {
    const activeExtra = extra.find(status => filters.status === status)
    const extraSum = counts ? extra.reduce((sum, status) => sum + (counts.status[status] ?? 0), 0) : null
    items.push({
      key: 'more',
      label: activeExtra ? label(activeExtra) : 'More',
      ...(activeExtra ? { tone: logTone({ status: activeExtra }) } : { dot: false }),
      count: activeExtra ? count(activeExtra) : extraSum,
      selected: Boolean(activeExtra),
      ...(filters.setStatus && {
        menuLabel: 'More statuses',
        menu: [
          ...(activeExtra ? [{ label: 'All statuses', onSelect: () => filters.setStatus!('all') }] : []),
          ...extra.map(status => {
            const n = count(status)
            return { label: label(status), hint: n === null ? undefined : n.toLocaleString(), onSelect: () => choose(status) }
          }),
        ],
      }),
    })
  }
  const groups: FacetGroup[] = [{ key: 'status', title: 'Status', items }]
  // Streams are sent mail's: received mail has none, so the group leaves with it.
  if (filters.streams) groups.push({ key: 'stream', title: 'Stream', items: (['transactional', 'marketing'] as const).map(stream => ({ key: stream, label: label(stream), dot: false, count: counts ? counts.stream[stream] : null,
    ...filters.setStream && { selected: filters.stream === stream, onSelect: () => filters.setStream!(filters.stream === stream ? 'all' : stream) } })) })
  return groups
}

/** The list's body with its filters beside it. `blank`: a log with no mail at all keeps the rail's place, empty. */
export function LogsBody({ counts, asOf, from, viewKey, filters, blank, children }: { counts: LogCounts | undefined; asOf?: string | null; from?: string; viewKey?: string; filters: RailFilters; blank?: boolean; children: ReactNode }) {
  const detail = from ? `Counts from ${from}${asOf ? `, as of ${asOf}` : ''}.` : undefined
  return <SplitPane className="logs-split" rail={blank ? null : <FacetRail key={viewKey} label="Filters" countSlot={{ width: countWidth, detail }} groups={logFacetGroups(counts, filters)} />}>{children}</SplitPane>
}
