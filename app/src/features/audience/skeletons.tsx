import { Fragment } from 'react'
import { useSearchParams } from 'react-router'
import { SearchField, ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, Select, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import { AudienceHeader } from './header'
import { consentTitle, statusOptions } from './consent'
import { rememberedPageSize } from '../../lib/pagination'
import './audience.css'

export function AudienceCellSkeleton({ secondary = false }: { secondary?: boolean }) {
  return <div><SkeletonText width="78%" />{secondary && <SkeletonText width="48%" lineHeight={18} />}</div>
}
// A column heading whose hover title says what the consent state means.
const consentLabel = (status: string, label = statusOptions.find(option => option.value === status)?.label ?? status) => <span title={consentTitle(status)}>{label}</span>
// The address takes the table's slack; status, lists and the date keep to their content on the right. A name is not a
// column of its own (most contacts have none): the table shows it beside the address, muted, on the same line, and a
// phone's card on its own line. Cards on a phone: a contact's address and status, then name, lists and when it was added.
export const contactColumns: SkeletonColumn[] = [
  { key: 'email', label: 'Email', skeleton: <AudienceCellSkeleton />, card: 'title' },
  { key: 'status', label: 'Status', width: 128, skeleton: <SkeletonText width={92} />, card: 'aside' },
  { key: 'name', label: 'Name', card: 'line', table: false },
  // A card puts the lists after the date (the created column's card line), so names arriving later move nothing.
  { key: 'lists', label: 'Lists', width: 176, card: 'hide' },
  { key: 'created', label: 'Added', width: 124, skeleton: <SkeletonText width={86} />, card: 'inline' },
]
// Risky contacts, filtered: why each was flagged in place of the status the filter names, and a row menu to send anyway.
const actionsColumn: SkeletonColumn = { key: 'actions', label: '', width: 56, align: 'right', skeleton: <span />, card: 'end' }
const reasonColumn: SkeletonColumn = { key: 'reason', label: 'Reason', width: 184, skeleton: <SkeletonText width={120} />, card: 'line' }
export const contactColumnsFor = (status: string): SkeletonColumn[] => status === 'risky' ? [contactColumns[0], reasonColumn, ...contactColumns.slice(2), actionsColumn] : contactColumns
const memberColumns: SkeletonColumn[] = [contactColumns[0], contactColumns[1], { key: 'suppression', label: 'Suppression reason', width: 184, card: 'line' }, contactColumns[4]]
// A status tab already names the status, and only Suppressed and Risky have reasons to show; a card keeps the reason
// column's line, which shows the name when there is no reason.
export const memberColumnsFor = (status: string): SkeletonColumn[] => [...memberColumns, ...(status === 'risky' ? [actionsColumn] : [])].filter(column => !(status && column.key === 'status'))
  .map(column => column.key !== 'suppression' || status === 'suppressed' ? column : status === 'risky' ? { ...column, label: 'Reason' } : { ...column, table: false })
// The name takes the slack; the counts and the date keep to their content (the table scrolls sideways before a name
// gets too narrow, audience.css).
export const listColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', card: 'title' },
  // A phone card gives consent two lines, two counts each, so all four fit at any width a count reaches.
  { key: 'subscribed', label: consentLabel('subscribed'), width: 104, align: 'right', card: 'line' },
  { key: 'unknown', label: consentLabel('unknown'), width: 96, align: 'right', card: 'inline' },
  { key: 'unsubscribed', label: consentLabel('unsubscribed'), width: 112, align: 'right', card: 'line' },
  { key: 'suppressed', label: consentLabel('suppressed'), width: 104, align: 'right', card: 'inline' },
  { key: 'total', label: 'Total', width: 88, align: 'right', card: 'aside' },
  { key: 'created', label: 'Created', width: 124, card: 'hide' },
]
// The loaded table's own columns (segments.tsx), so the route skeleton and the list agree.
export const segmentColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '32%', card: 'title' },
  { key: 'rule', label: 'Conditions', card: 'line' },
  { key: 'updatedAt', label: 'Updated', width: 124, card: 'hide' },
]
// Topics (topics.tsx): the name takes the slack; a card shows the description under it, and the menu at its end.
export const topicColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '24%', card: 'title' },
  { key: 'description', label: 'Description', card: 'line' },
  { key: 'default', label: 'Who gets it', width: 280, card: 'line' },
  // How many chose: out of a topic everyone gets, in to an opt-in one. A dash until counted, so the row never moves.
  { key: 'count', label: <span title="How many have opted out of a topic everyone gets, or in to an opt-in one, counted when the page opened">Choices</span>, width: 132, align: 'right', card: 'line' },
  { key: 'created', label: 'Created', width: 124, card: 'hide' },
  { key: 'actions', label: '', width: 56, align: 'right', skeleton: <span />, card: 'end' },
]
export const activityColumns: SkeletonColumn[] = [
  { key: 'subject', label: 'Email' },
  { key: 'status', label: 'Latest event', width: 144, skeleton: <SkeletonText width={90} /> },
  { key: 'time', label: 'Sent', width: 124 },
]
export const consentColumns: SkeletonColumn[] = [
  { key: 'status', label: 'Status', width: 128, card: 'title' },
  { key: 'source', label: 'Source', width: 168, card: 'line' },
  { key: 'evidence', label: 'How', card: 'line' },
  { key: 'policy', label: 'Policy version', width: 128, card: 'hide' },
  { key: 'at', label: 'When', width: 124, card: 'aside' },
]
export function AudienceSummarySkeleton() {
  return <div className="audience-summary cluster">{[100, 115, 110, 125].map(width => <SkeletonText key={width} width={width} />)}</div>
}
export function AudienceMembersSkeleton() {
  const [params] = useSearchParams()
  const status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status')! : ''
  return <><Tabs value="" onValueChange={() => {}} items={[{ value: '', label: 'All members' }, ...statusOptions]} /><div className="data-toolbar"><ControlSkeleton width={320} /></div><TableSkeleton className="audience-contacts" columns={memberColumnsFor(status)} rows={8} pagination /></>
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
export function AudienceRouteSkeleton({ kind, isNew = false }: { kind: 'contacts' | 'contact' | 'lists' | 'list' | 'segments' | 'segment' | 'topics'; isNew?: boolean }) {
  const [params] = useSearchParams()
  const status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status')! : ''
  if (kind === 'contact') return <LoadingRegion className="audience-page" label="Loading contact"><PageHeader title={<SkeletonText width={64} lineHeight={24} />} backTo="/audience" actions={<><ControlSkeleton width={109} /><ControlSkeleton width={111} /></>} /><ContactDetailBodySkeleton /></LoadingRegion>
  if (kind === 'list') return <LoadingRegion className="audience-page" label="Loading list"><PageHeader title={<SkeletonText width={96} lineHeight={24} />} backTo="/audience/lists" actions={<><ControlSkeleton width={85} /><ControlSkeleton width={120} /></>} /><AudienceMembersSkeleton /></LoadingRegion>
  if (kind === 'segment') return <LoadingRegion className="audience-page" label="Loading segment"><PageHeader title={isNew ? 'Create segment' : 'Edit segment'} backTo="/audience/segments" actions={<ControlSkeleton width={121} />} /><SegmentEditorBodySkeleton /></LoadingRegion>
  if (kind === 'topics') return <LoadingRegion className="audience-page" label="Loading topics"><AudienceHeader actions={<ControlSkeleton width={113} />} /><div className="data-toolbar"><Select className="audience-status-filter" aria-label="Show" value="active" onValueChange={() => {}} options={[{ value: 'active', label: 'Active topics' }]} disabled /></div><TableSkeleton className="audience-topics" columns={topicColumns} rows={5} /></LoadingRegion>
  const contacts = kind === 'contacts'
  return <LoadingRegion className="audience-page" label={`Loading ${kind}`}><AudienceHeader actions={<>{contacts && <ControlSkeleton width={120} />}<ControlSkeleton width={contacts ? 98 : kind === "lists" ? 85 : 121} /></>} />
    <div className="data-toolbar"><div className="cluster">{contacts ? <><SearchField className="search-box--list" aria-label="Search contacts" placeholder="Search email or name" disabled /><Select className="audience-status-filter" aria-label="Filter by status" value="" onValueChange={() => {}} options={[{ value: '', label: 'All contacts' }]} disabled /><div className="audience-list-filter"><ControlSkeleton /></div></> : <ControlSkeleton width={320} />}</div></div>
    <TableSkeleton className={contacts ? 'audience-contacts' : kind === 'lists' ? 'audience-lists' : undefined} columns={contacts ? contactColumnsFor(status) : kind === 'lists' ? listColumns : segmentColumns} rows={contacts ? rememberedPageSize('contacts') || 8 : 5} pagination />
  </LoadingRegion>
}
