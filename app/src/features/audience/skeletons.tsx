import { Fragment } from 'react'
import { useSearchParams } from 'react-router'
import { SearchField, ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, Select, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import { AudienceHeader } from './header'
import { consentTitle, statusOptions } from './consent'
import './audience.css'

export function AudienceCellSkeleton({ secondary = false }: { secondary?: boolean }) {
  return <div><SkeletonText width="78%" />{secondary && <SkeletonText width="48%" lineHeight={18} />}</div>
}
// A column heading whose hover title says what the consent state means.
const consentLabel = (status: string, label = statusOptions.find(option => option.value === status)?.label ?? status) => <span title={consentTitle(status)}>{label}</span>
// Cards on a phone: a contact's address and status, then name, lists and when it was added.
export const contactColumns: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '28%', skeleton: <AudienceCellSkeleton />, card: 'title' },
  { key: 'status', label: 'Status', width: '17%', skeleton: <SkeletonText width={92} />, card: 'aside' },
  { key: 'name', label: 'Name', width: '18%', card: 'line' },
  // A card puts the lists after the date (the created column's card line), so names arriving later move nothing.
  { key: 'lists', label: 'Lists', width: '20%', card: 'hide' },
  { key: 'created', label: 'Added', width: '17%', skeleton: <SkeletonText width={95} />, card: 'inline' },
]
const memberColumns: SkeletonColumn[] = [contactColumns[0], contactColumns[1], { key: 'suppression', label: 'Suppression reason', width: '38%', card: 'line' }, contactColumns[4]]
// A consent tab already names the status, and only Suppressed has reasons to show; a card keeps the reason column's
// line, which shows the name when there is no reason.
export const memberColumnsFor = (status: string): SkeletonColumn[] => memberColumns.filter(column => !(status && column.key === 'status')).map(column => column.key === 'suppression' && status !== 'suppressed' ? { ...column, table: false } : column)
export const listColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '24%', card: 'title' },
  // A phone card gives consent two lines, two counts each, so all four fit at any width a count reaches.
  { key: 'subscribed', label: consentLabel('subscribed'), width: '12%', align: 'right', card: 'line' },
  { key: 'unknown', label: consentLabel('unknown'), width: '11%', align: 'right', card: 'inline' },
  { key: 'unsubscribed', label: consentLabel('unsubscribed'), width: '13%', align: 'right', card: 'line' },
  { key: 'suppressed', label: consentLabel('suppressed'), width: '12%', align: 'right', card: 'inline' },
  { key: 'total', label: 'Total', width: '11%', align: 'right', card: 'aside' },
  { key: 'created', label: 'Created', width: '17%', card: 'hide' },
]
export const segmentColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '30%', card: 'title' },
  { key: 'rules', label: 'Rules', width: '22%', card: 'line' },
  { key: 'matched', label: 'Matched', width: '14%', align: 'right', card: 'hide' },
  { key: 'eligible', label: 'Eligible', width: '14%', align: 'right', card: 'hide' },
  { key: 'updated', label: 'Updated', width: '20%', card: 'hide' },
]
export const activityColumns: SkeletonColumn[] = [
  { key: 'subject', label: 'Email', width: '55%' },
  { key: 'status', label: 'Latest event', width: '23%', skeleton: <SkeletonText width={90} /> },
  { key: 'time', label: 'Sent', width: '22%' },
]
export const consentColumns: SkeletonColumn[] = [
  { key: 'status', label: 'Status', width: '15%', card: 'title' },
  { key: 'source', label: 'Source', width: '17%', card: 'line' },
  { key: 'evidence', label: 'How', width: '38%', card: 'line' },
  { key: 'policy', label: 'Policy version', width: '14%', card: 'hide' },
  { key: 'at', label: 'When', width: '16%', card: 'aside' },
]
export function AudienceSummarySkeleton() {
  return <div className="audience-summary cluster">{[100, 115, 110, 125].map(width => <SkeletonText key={width} width={width} />)}</div>
}
export function AudienceMembersSkeleton() {
  const [params] = useSearchParams()
  const status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status')! : ''
  return <><Tabs value="" onValueChange={() => {}} items={[{ value: '', label: 'All members' }, ...statusOptions]} /><div className="data-toolbar"><ControlSkeleton width={320} /></div><TableSkeleton columns={memberColumnsFor(status)} rows={8} pagination /></>
}
export function ListDetailBodySkeleton() {
  return <LoadingRegion label="Loading list"><AudienceMembersSkeleton /></LoadingRegion>
}
export function ContactDetailBodySkeleton() {
  return <><div className="audience-summary cluster"><SkeletonText width={240} /><SkeletonText width={94} /></div>
    {/* Properties can grow by any number of custom rows, so Lists and Consent history appear with the contact, below
        them, instead of as placeholders the loaded rows would push down. */}
    <div className="section audience-properties"><section><SectionHeader title="Properties" /><dl className="ui-facts">{['Country', 'Added', 'Last opened'].map(label => <Fragment key={label}><dt>{label}</dt><dd><SkeletonText width="65%" /></dd></Fragment>)}</dl></section></div>
  </>
}
export function SegmentEditorBodySkeleton() {
  return <div className="stack audience-editor"><div className="audience-name"><FieldSkeleton label="Segment name" /></div>
    <section className="section stack"><SectionHeader title="Conditions" actions={<ControlSkeleton width={104} />} /><div className="cluster"><span>Match</span><ControlSkeleton width={220} /></div><div className="audience-rules"><div className="audience-rule audience-rule--head" aria-hidden="true"><span>Field</span><span>Condition</span><span>Value</span><span /></div><div className="audience-rule"><ControlSkeleton /><ControlSkeleton /><ControlSkeleton /><ControlSkeleton width="var(--control-height)" /></div></div><div className="cluster"><ControlSkeleton width={133} /></div></section>
    <section className="section stack"><SectionHeader title="Matching contacts" actions={<ControlSkeleton width={220} />} /><AudienceSummarySkeleton /></section></div>
}
export function AudienceRouteSkeleton({ kind, isNew = false }: { kind: 'contacts' | 'contact' | 'lists' | 'list' | 'segments' | 'segment'; isNew?: boolean }) {
  if (kind === 'contact') return <LoadingRegion className="audience-page" label="Loading contact"><PageHeader title={<SkeletonText width={64} lineHeight={24} />} backTo="/audience" actions={<><ControlSkeleton width={109} /><ControlSkeleton width={111} /></>} /><ContactDetailBodySkeleton /></LoadingRegion>
  if (kind === 'list') return <LoadingRegion className="audience-page" label="Loading list"><PageHeader title={<SkeletonText width={96} lineHeight={24} />} backTo="/audience/lists" actions={<><ControlSkeleton width={85} /><ControlSkeleton width={120} /></>} /><AudienceMembersSkeleton /></LoadingRegion>
  if (kind === 'segment') return <LoadingRegion className="audience-page" label="Loading segment"><PageHeader title={isNew ? 'Create segment' : 'Edit segment'} backTo="/audience/segments" actions={<ControlSkeleton width={121} />} /><SegmentEditorBodySkeleton /></LoadingRegion>
  const contacts = kind === 'contacts'
  return <LoadingRegion className="audience-page" label={`Loading ${kind}`}><AudienceHeader actions={<>{contacts && <ControlSkeleton width={120} />}<ControlSkeleton width={contacts ? 98 : kind === "lists" ? 85 : 121} /></>} />
    <div className="data-toolbar"><div className="cluster">{contacts ? <><SearchField className="search-box--list" aria-label="Search contacts" placeholder="Search email or name" disabled /><Select className="audience-status-filter" aria-label="Filter by consent" value="" onValueChange={() => {}} options={[{ value: '', label: 'All contacts' }]} disabled /><div className="audience-list-filter"><ControlSkeleton /></div></> : <ControlSkeleton width={320} />}</div></div>
    <TableSkeleton columns={contacts ? contactColumns : kind === 'lists' ? listColumns : segmentColumns} rows={contacts ? 8 : 5} pagination />
  </LoadingRegion>
}
