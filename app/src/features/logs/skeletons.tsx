import { Download, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useRegion, useWorkspaceAccess } from '../../data/context'
import { Button, Input, LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, SkeletonText, TableSkeleton, Tabs } from '../../components/ui'
import { rememberedPageSize } from '../../lib/pagination'
import { logsPageColumnDefs } from './rows'
import './logs.css'
// The sent email's skeleton draws the preview's toolbar and frame, whose styles live with EmailInsight (a lazy chunk):
// they load with the skeleton, so its placeholders hold their size before that chunk arrives.
import '../../components/email-insight.css'
// Exactly the loaded page: the header with the direction tabs, the toolbar and the table with its remembered page size.
export function LogsRouteSkeleton() {
  const { regionId } = useRegion()
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const [params] = useSearchParams()
  const campaign = Boolean(params.get('campaign')), view = params.get('view'), direction = campaign ? 'sent' : view === 'sent' || view === 'received' ? view : 'all'
  return <div className="logs-page"><PageHeader title="Logs" actions={<div className="cluster logs-controls">{!multiTenant && !canAdminister && <span className="muted">{regionId}</span>}<Tabs label="Direction" value={direction} onValueChange={() => {}} disabled items={[{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]} /></div>} />
    <div className="data-toolbar"><div className="cluster">{campaign && <Skeleton width={160} height={28} />}<div className="search-box"><Search size={16} /><Input type="search" aria-label="Search logs" placeholder="Search logs" disabled /></div><Select value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All statuses' }]} /><Select value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All streams' }]} /></div><Button disabled><Download size={16} />Export page</Button></div>
    <TableSkeleton className="logs-table" columns={logsPageColumnDefs} rows={rememberedPageSize('logs') || 16} pagination /></div>
}
// A sent email: the header, its facts and delivery line, then the preview's switcher and frame. The score beside (or,
// on a phone, below) the preview has no placeholder: it appears in a place nothing else depends on.
export function EmailDetailSkeleton() {
  return <div className="email-detail"><PageHeader title={<SkeletonText width={320} lineHeight={24} />} backTo="/logs" subtitle={<div className="email-facts"><SkeletonText width={420} /></div>} actions={<Skeleton width={80} height={22} />} />
    <LoadingRegion label="Loading email"><div className="delivery"><SkeletonText width={300} lineHeight={28} /></div>
      <div className="email-detail__body"><section className="email-detail__preview"><div className="ev"><div className="ev-toolbar"><Skeleton width={360} height={28} /></div><div className="email-frame email-frame--loading" /></div></section></div>
    </LoadingRegion></div>
}
// A received message: its facts, the body with its views beside the details, and its identifiers.
export function ReceivedEmailSkeleton() {
  const { multiTenant } = useWorkspaceAccess()
  return <><PageHeader title={<SkeletonText width={320} lineHeight={28} />} backTo="/logs" actions={<Skeleton width={80} height={22} />} /><LoadingRegion label="Loading email"><dl className="email-metadata">{['From', 'To', 'Address'].map(label => <div key={label}><dt>{label}</dt><dd><SkeletonText width="75%" /></dd></div>)}</dl><div className="email-detail-grid"><section><Tabs value="preview" onValueChange={() => {}} items={[{ value: 'preview', label: 'Preview' }, { value: 'plain', label: 'Plain text' }, { value: 'html', label: 'HTML' }, { value: 'headers', label: 'Headers' }]} /><div className="email-preview-skeleton"><SkeletonText width="55%" lineHeight={32} /><SkeletonText /><SkeletonText width="80%" /><SkeletonText width="60%" /></div></section><section className="delivery-timeline received-details"><SectionHeader title="Details" /><ol>{[0, 1, 2].map(i => <li key={i}><Skeleton width={6} height={6} /><div><div className="cluster between"><SkeletonText width={90} /><Skeleton width={60} /></div></div></li>)}</ol></section></div><div className="message-identifiers"><Skeleton width={260} height={34} /><Skeleton width={180} />{!multiTenant && <Skeleton width={120} />}</div></LoadingRegion></>
}
