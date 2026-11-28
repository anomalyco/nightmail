import { Button, FieldSkeleton, LoadingRegion, PageHeader, SkeletonText, TableSkeleton, type SkeletonColumn } from '../../components/ui'
import { issuesShape, useNewsletters } from './shared'
import './newsletters.css'

// An issue's card: its subject, then when it was sent, to how many readers and how many opened it, on one line.
const base: SkeletonColumn[] = [
  { key: 'subject', label: 'Issue', skeleton: <SkeletonText width="56%" />, card: 'title' },
  { key: 'sent', label: 'Sent', width: 160, skeleton: <SkeletonText width={52} />, card: 'line' },
  { key: 'recipients', label: 'Readers', width: 96, align: 'right', skeleton: <SkeletonText width={44} />, card: 'hide' },
]
const engagement: SkeletonColumn[] = [
  { key: 'opened', label: 'Opened', width: 88, align: 'right', skeleton: <SkeletonText width={30} />, card: 'hide' },
  { key: 'clicked', label: 'Clicked', width: 88, align: 'right', skeleton: <SkeletonText width={30} />, card: 'hide' },
]
/** Opens and clicks are columns only when an issue on the page has them. */
export const issueColumns = (withEngagement: boolean) => withEngagement ? [...base, ...engagement] : base
export const newsletterColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Newsletter', skeleton: <SkeletonText width="40%" />, card: 'title' },
  { key: 'from', label: 'From', width: '40%', skeleton: <SkeletonText width="60%" />, card: 'line' },
]

export function ReadersSkeleton() {
  return <LoadingRegion label="Loading readers" className="newsletter-readers">
    <div className="newsletter-readers__count"><SkeletonText width={150} lineHeight={36} /></div>
    <div className="newsletter-growth" aria-hidden="true"><div className="newsletter-growth__bars" /><div className="newsletter-growth__caption"><SkeletonText width={130} lineHeight={16} /></div></div>
  </LoadingRegion>
}
export function IssuesSkeleton({ id }: { id: string }) {
  const shape = issuesShape(id)
  return <TableSkeleton className="newsletter-issues" columns={issueColumns(shape.engagement)} rows={shape.rows} />
}
/** The newsletter's page before its code or data: its name is the sidebar's, so the title is already right. */
function NewsletterSkeleton({ id }: { id: string }) {
  const name = useNewsletters().find(item => item.id === id)?.name
  return <div className="stack newsletter">
    <PageHeader title={name ?? <SkeletonText width={140} lineHeight={24} />} actions={<Button variant="primary" disabled>New issue</Button>} />
    <ReadersSkeleton />
    <IssuesSkeleton id={id} />
  </div>
}
// `id`: the path's second part (absent on the list of newsletters, "new" on the form).
export function NewsletterRouteSkeleton({ id }: { id?: string }) {
  if (id === 'new') return <div className="stack newsletter-new"><PageHeader title="New newsletter" backTo="/campaigns" actions={<Button variant="primary" disabled>Create newsletter</Button>} /><FieldSkeleton label="Name" /><FieldSkeleton label="From" /></div>
  if (id) return <NewsletterSkeleton id={decodeURIComponent(id)} />
  return <div className="stack"><PageHeader title="Newsletters" /><TableSkeleton columns={newsletterColumns} rows={4} /></div>
}
