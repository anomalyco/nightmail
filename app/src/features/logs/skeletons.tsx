import { Download, Search } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useRegion, useWorkspaceAccess } from '../../data/context'
import { Button, Input, LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, SkeletonText, TableSkeleton, Tabs } from '../../components/ui'
import { rememberedPageSize } from '../../lib/pagination'
import { logsPageColumnDefs } from './rows'
import { useDetailLayout } from './detail-layout'
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
// A sent email in the window's layout (detail-layout.ts): the header, the delivery, the preview's toolbar and its empty
// stage, and from 1200 px the details column. The score's place has a placeholder only in that column: elsewhere it
// appears where nothing else depends on it.
export function EmailDetailSkeleton() {
  const { mode } = useDetailLayout()
  // A phone or tablet: the subject, the status line, the preview's one row of controls and its frame.
  if (mode === 'stack') return <div className="email-detail" data-mode={mode}><PageHeader title={<SkeletonText width={240} lineHeight={24} />} backTo="/logs" subtitle={<div className="email-status"><SkeletonText width={180} /></div>} />
    <LoadingRegion label="Loading email"><div className="email-detail__body"><section className="email-detail__preview"><div className="ev" data-compact><div className="ev-toolbar"><Skeleton width={112} height={28} /></div>
      <div className="ev-stage"><div className="ev-canvas"><div className="ev-placeholder" /></div></div></div></section></div></LoadingRegion></div>
  const delivery = <div className="delivery" data-vertical={mode !== 'panel' || undefined}>{mode === 'panel' ? <SkeletonText width={300} lineHeight={28} /> : <div className="delivery__skeleton">{[96, 80, 112].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div>}</div>
  return <div className="email-detail" data-mode={mode}><PageHeader title={<SkeletonText width={320} lineHeight={24} />} backTo="/logs" subtitle={<div className="email-facts"><SkeletonText width={420} /></div>} actions={<Skeleton width={80} height={22} />} />
    <LoadingRegion label="Loading email">
      {mode === 'panel' && delivery}
      <div className="email-detail__body">
        <section className="email-detail__preview"><div className="ev" data-fill><div className="ev-toolbar"><Skeleton width={360} height={28} /></div>
          <div className="ev-stage"><div className="ev-captions" /><div className="ev-canvas"><div className="ev-placeholder" /></div></div></div></section>
        {mode === 'column' && <aside className="email-detail__side"><section className="email-detail__delivery"><h2 className="ss__title">Delivery</h2>{delivery}</section>
          <section className="ss"><div className="ss__head"><h2 className="ss__title">Sendability</h2><SkeletonText width={52} /></div><div className="ss__fixes">{['86%', '70%', '78%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section></aside>}
      </div>
    </LoadingRegion></div>
}
// A received message: its facts, the body with its views beside the details, and its identifiers.
export function ReceivedEmailSkeleton() {
  const { multiTenant } = useWorkspaceAccess()
  return <><PageHeader title={<SkeletonText width={320} lineHeight={28} />} backTo="/logs" actions={<Skeleton width={80} height={22} />} /><LoadingRegion label="Loading email"><dl className="email-metadata">{['From', 'To', 'Address'].map(label => <div key={label}><dt>{label}</dt><dd><SkeletonText width="75%" /></dd></div>)}</dl><div className="email-detail-grid"><section><Tabs value="preview" onValueChange={() => {}} items={[{ value: 'preview', label: 'Preview' }, { value: 'plain', label: 'Plain text' }, { value: 'html', label: 'HTML' }, { value: 'headers', label: 'Headers' }]} /><div className="email-preview-skeleton"><SkeletonText width="55%" lineHeight={32} /><SkeletonText /><SkeletonText width="80%" /><SkeletonText width="60%" /></div></section><section className="delivery-timeline received-details"><SectionHeader title="Details" /><ol>{[0, 1, 2].map(i => <li key={i}><Skeleton width={6} height={6} /><div><div className="cluster between"><SkeletonText width={90} /><Skeleton width={60} /></div></div></li>)}</ol></section></div><div className="message-identifiers"><Skeleton width={260} height={34} /><Skeleton width={180} />{!multiTenant && <Skeleton width={120} />}</div></LoadingRegion></>
}
