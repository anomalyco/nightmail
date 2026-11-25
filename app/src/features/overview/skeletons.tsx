import { ArrowUpRight, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import type { RegionCatalogEntry } from '../../data/types'
import { label } from '../../lib/format'
import { useCompactShell, useMediaQuery } from '../../lib/media'
import { Icon, IconButton, LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, StatusBadge, TableSkeleton, Tabs, type Column, type SkeletonColumn } from '../../components/ui'
import type { LogEntry } from '../../data/types'
import { logColumnDefs, logColumns } from '../logs/rows'
import { useLatestRowCount } from './latest'
import { setPanelHidden, usePanelHidden } from './panel'
import '../score/score.css'
import './overview.css'

// Hosted mail manages its region, so it shows no status; a bring-your-own connection shows its own state,
// and self-hosted SES shows the region's discovery status.
export function RegionStatus({ current }: { current?: RegionCatalogEntry }) {
  const { multiTenant } = useWorkspaceAccess()
  const connection = useSession()?.identity?.connection
  if (multiTenant) return connection?.kind === 'byo' ? <StatusBadge status={label(connection.state)} tone={connection.state === 'ready' ? 'success' : connection.state === 'failed' ? 'danger' : 'warning'} /> : null
  return current ? <StatusBadge status={label(current.discoveryStatus)} tone={current.discoveryStatus === 'ready' ? 'success' : current.discoveryStatus === 'blocked' ? 'danger' : 'warning'} /> : <Skeleton width={84} height={20} />
}

export const factTitles = ['Emails', 'Delivered', 'Bounced', 'Complaints'] as const
// Latest emails are Logs' rows in a 790px column, so the table says what Logs says in fewer columns: the other party
// is one column (who it went to, or who it came from; received mail is the one with the Received status), and the
// direction and stream columns stay for phone cards only. The address is masked by default, so it takes a fixed width
// and the subject the rest.
const logColumn = (key: string) => logColumns.find(column => column.key === key)!
export const latestColumnDefs: SkeletonColumn[] = logColumnDefs.map(column => column.key === 'direction' || column.key === 'from' || column.key === 'stream' ? { ...column, table: false as const }
  : column.key === 'status' ? { ...column, width: 160 } : column.key === 'to' ? { ...column, key: 'contact', label: 'To · from', width: 180 } : column)
export const latestColumns: Column<LogEntry>[] = latestColumnDefs.map(column => ({ ...logColumn(column.key === 'contact' ? 'to' : column.key), ...column, render: column.key === 'contact' ? (row: LogEntry) => (row.direction === 'sent' ? logColumn('to') : logColumn('from')).render(row) : logColumn(column.key).render }))

// Hides or shows the inspector rail beside the main column (panel.ts). It closes the control strip, here and in the
// route skeleton alike, and is not there where the rail stacks under the main column (overview.css).
export function PanelToggle() {
  const hidden = usePanelHidden()
  return <IconButton className="ov-panel-toggle" label={hidden ? 'Show panel' : 'Hide panel'} aria-expanded={!hidden} aria-controls="overview-panel" onClick={() => setPanelHidden(!hidden)}><Icon icon={hidden ? PanelRightOpen : PanelRightClose} /></IconButton>
}

// Each skeleton has exactly the loaded block's dimensions (see overview.css), so swapping in the data moves nothing.
export function FactTilesSkeleton() {
  return <>{factTitles.map(title => <div key={title} className="ov-kpi" aria-hidden="true">
    <div className="ov-kpi__head"><span>{title}</span></div><div className="ov-kpi__value"><Skeleton width={88} height={18} /></div><span className="ov-kpi__spark ov-kpi__spark--loading" />
  </div>)}</>
}
// The sender score's place under the tiles where there is no sidebar to carry it, as its card draws itself while it
// loads (features/score).
export function ScoreTileSkeleton() {
  return <div className="gauge-card gauge-card--compact" aria-hidden="true"><span className="gauge-skeleton" /></div>
}
export function ChartSkeleton() {
  return <section className="ov-chart" aria-hidden="true"><div className="ov-chart__head"><span className="ov-label">Activity</span></div><div className="ov-chart__plot ov-chart__plot--loading" /></section>
}
export function AsideSkeleton() {
  return <div className="ov-aside-skeleton" aria-hidden="true"><span /><span /></div>
}
// The route-level placeholder while the Overview code loads: the same header, columns and blocks, and as many latest
// email rows as the page will reserve (latest.ts). In one column the list comes last, after the detail column has
// loaded, so it has no place here.
export function OverviewRouteSkeleton() {
  const { regionId } = useRegion()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const count = useLatestRowCount()
  const stacked = useMediaQuery('(max-width: 960px)'), compact = useCompactShell()
  return <div className="ov-page">
    <PageHeader className="ov-strip" title="Overview" actions={<><div className="cluster ov-controls" data-wide={!multiTenant || undefined}>{!multiTenant && <>{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus /></>}<Tabs value="24h" onValueChange={() => {}} disabled items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" /><Select aria-label="Email stream" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All emails' }]} /></div><PanelToggle /></>} />
    <LoadingRegion label="Loading overview">
      <div className="ov-kpis" aria-hidden="true"><FactTilesSkeleton />{compact && <ScoreTileSkeleton />}</div>
      <div className="ov-split">
        <div className="ov-split__main"><ChartSkeleton />{!stacked && <section className="ov-latest"><SectionHeader title="Latest emails" actions={<span className="ui-button ui-button--ghost ui-button--sm" aria-disabled="true">Logs <Icon icon={ArrowUpRight} size="sm" /></span>} /><TableSkeleton className="logs-table ov-table" columns={latestColumnDefs} rows={count} /></section>}</div>
        <aside className="ov-split__aside">{!stacked && <AsideSkeleton />}</aside>
      </div>
    </LoadingRegion>
  </div>
}
