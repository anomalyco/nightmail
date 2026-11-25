import { AlignCenter, AlignLeft, AlignRight, Bold, Braces, ChevronRight, ImagePlus, Italic, MoreHorizontal, Redo2, Shapes, SlidersHorizontal, Type, Undo2, X, type LucideIcon } from 'lucide-react'
import {
  Button, ControlSkeleton, Field, Icon, IconButton, LoadingRegion, PageHeader, SearchField, SectionHeader,
  Select, Skeleton, SkeletonText, StatusBadge, TableSkeleton, Tabs, type SkeletonColumn,
} from '../../components/ui'
import { Notices } from '../../components/Notices'
import { CampaignsHeader } from './header'
import { modKey, usePhone } from '../../lib/media'
import { useSearchParams } from 'react-router'
import { useWorkspaceAccess } from '../../data/context'
import { newsletterPath } from '../newsletters/shared'
import './campaigns.css'
import { CampaignBar, CampaignSteps } from './steps'

// A campaign's card: its name and status, its subject, then recipients, delivery and last activity.
export const campaignColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '35%', skeleton: <div className="campaign-row-name"><SkeletonText width="68%" lineHeight={18} /><SkeletonText width="88%" lineHeight={18} /></div>, card: 'title' },
  { key: 'status', label: 'Status', skeleton: <SkeletonText width={65} lineHeight={18} />, card: 'aside' },
  { key: 'subject', label: 'Subject', card: 'line', table: false },
  { key: 'recipients', label: 'Recipients', align: 'right', skeleton: <SkeletonText width={45} />, card: 'line' },
  { key: 'delivered', label: 'Delivered', align: 'right', skeleton: <SkeletonText width={42} />, card: 'inline' },
  { key: 'updated', label: 'Last activity · UTC', skeleton: <SkeletonText width="90%" />, card: 'inline' },
  { key: 'archive', label: <span className="sr-only">Actions</span>, width: 48, align: 'right', skeleton: <span />, card: 'end' },
]

// A template's card: its name and status, its subject or purpose, when it changed, and Use template.
export const templateColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Template', skeleton: campaignColumns[0].skeleton, card: 'title' },
  { key: 'status', label: 'Status', width: 120, skeleton: <SkeletonText width={65} lineHeight={18} />, card: 'aside' },
  { key: 'about', label: 'About', card: 'line', table: false },
  { key: 'updated', label: 'Updated · UTC', width: 190, skeleton: <SkeletonText width="90%" />, card: 'hide' },
  { key: 'action', label: '', width: 150, align: 'right', skeleton: <span />, card: 'end' },
]

export function CampaignAudienceSkeleton() {
  return <LoadingRegion label="Loading audience" className="campaign-audience-review-skeleton">
    <p className="campaign-audience-source"><SkeletonText width={120} /></p>
    <div className="campaign-audience-summary">
      <div className="campaign-summary-line"><strong>Eligible recipients</strong><SkeletonText width={45} /></div>
      <div className="campaign-summary-line"><span>Matched contacts</span><SkeletonText width={45} /></div>
      <div className="campaign-summary-line muted"><span>Suppressed</span><SkeletonText width={35} /></div>
      <div className="campaign-summary-line muted"><span>Not subscribed</span><SkeletonText width={35} /></div>
    </div>
    <Button disabled>Refresh count</Button>
  </LoadingRegion>
}

// The composer's tools and panel as the editor opens them (EmailComposer, disabled until it is ready), so the studio's
// rail (from 900 px) and its docked Style panel (from 1150 px) are in place from the first frame; below 900 px
// the toolbar row on the sheet. Outside the studio (a preview dialog) only the toolbar row and the canvas show.
const railTools: LucideIcon[][] = [[Type, ImagePlus, Shapes, Braces], [Bold, Italic, AlignLeft, AlignCenter, AlignRight], [Undo2, Redo2], [SlidersHorizontal]]
export function ComposerSkeleton() {
  return <LoadingRegion label="Loading composer" className="composer-loading">
    <div className="composer-rail composer-skeleton-rail" aria-hidden="true">{railTools.map((group, index) => <div key={index} className="composer-rail__group">{group.map((glyph, tool) => <span key={tool} className="composer-skeleton-tool"><Icon icon={glyph} /></span>)}</div>)}</div>
    <div className="composer-skeleton-tools"><ControlSkeleton width={90} /><ControlSkeleton width={28} /><ControlSkeleton width={28} /></div>
    <div className="composer-skeleton-canvas"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><SkeletonText width="60%" /></div>
    <div className="composer-inspector composer-skeleton-panel" aria-hidden="true">
      <div className="composer-inspector-header"><span className="composer-inspector-title">Style</span><span className="composer-skeleton-tool composer-skeleton-tool--sm"><Icon icon={X} /></span></div>
      <p className="composer-inspector-hint">Select a block to style it.</p>
    </div>
  </LoadingRegion>
}

export function CampaignRouteSkeleton({ kind, isNew = false }: { kind: 'list' | 'editor' | 'review' | 'templates' | 'template'; isNew?: boolean }) {
  const phone = usePhone()
  const { canAdminister } = useWorkspaceAccess()
  // "New issue" on a newsletter's page opens the composer for that newsletter.
  const [search] = useSearchParams(), issueOf = isNew ? search.get('newsletter') : null
  if (kind === 'list' || kind === 'templates') {
    const templates = kind === 'templates'
    return <>
      <CampaignsHeader actions={<>{!templates && canAdminister && <Button disabled>New newsletter</Button>}<Button variant="primary" disabled>{templates ? 'Create template' : 'Create campaign'}</Button></>} />
      <div className="data-toolbar"><div className="cluster"><SearchField className="search-box--list" aria-label={templates ? 'Search templates' : 'Search campaigns'} placeholder={templates ? 'Search templates' : 'Search campaigns'} disabled /><Select aria-label={templates ? 'Filter templates' : 'Filter by status'} value="all" onValueChange={() => {}} options={[{ value: 'all', label: templates ? 'Active' : 'All campaigns' }]} disabled /></div></div>
      <TableSkeleton className="campaigns-table" columns={templates ? templateColumns : campaignColumns} rows={4} pagination />
    </>
  }
  if (kind === 'template') return <div className="campaign-compose-page template-compose-page">
    <PageHeader title="Edit template" backTo="/campaigns/templates" actions={<>{!phone && <span className="campaign-sync-status"><span className="campaign-sync-dot" /></span>}{phone ? <><Button variant="primary" disabled>Publish</Button><IconButton label="More actions" disabled><Icon icon={MoreHorizontal} /></IconButton></> : <><Button variant="ghost" disabled>Preview</Button><Button variant="ghost" disabled>Archive</Button><Button variant="secondary" disabled>Use template</Button><Button variant="primary" disabled>Publish</Button></>}</>} />
    <LoadingRegion label="Loading template editor" className="campaign-compose-workspace">
      <div className="campaign-compose-scroll"><div className="studio-notices"><Notices /></div><div className="campaign-compose-sheet">
        <div className="campaign-compose-metadata" aria-hidden="true">
          {['Name', 'Purpose', 'Subject', 'Inbox preview', 'From name', 'Reply to'].map(label => <div className="campaign-compose-row" key={label}><span>{label}</span><ControlSkeleton /></div>)}
        </div>
        <ComposerSkeleton />
      </div></div>
    </LoadingRegion>
  </div>
  // The loaded editor's bar (index.tsx): back, the path, the name and Draft; the presence place, the save status, the
  // actions with Continue's shortcut. Then the sheet's From and Subject rows, and the composer.
  if (kind === 'editor') return <div className="campaign-compose-page campaign-studio">
    <CampaignBar back={issueOf ? newsletterPath(issueOf) : undefined} crumb={issueOf ? <SkeletonText width={88} lineHeight={18} /> : 'Campaigns'} title={<><h1 className="sr-only">{issueOf ? 'New issue' : isNew ? 'Create campaign' : 'Edit campaign'}</h1><div className="studio-name studio-name--loading">{isNew ? <span className="studio-name__placeholder">{issueOf ? 'Untitled issue' : 'Untitled campaign'}</span> : <SkeletonText width={180} />}</div></>} status={<StatusBadge status="draft" tone="neutral" />} steps={<CampaignSteps step="write" />} actions={<>
      <div className="campaign-presence" data-reserve aria-hidden="true" />
      {!phone && <span className="campaign-sync-status"><span className="campaign-sync-dot" /><span>{isNew ? 'New draft' : 'Connecting…'}</span></span>}
      {phone ? <><Button variant="primary" disabled>Continue</Button><IconButton label="More actions" disabled><Icon icon={MoreHorizontal} /></IconButton></> : <>{isNew && <Button variant="ghost" disabled>Use a template</Button>}<Button variant="secondary" disabled>Send test</Button><Button variant="primary" disabled>Continue<kbd className="ui-kbd" aria-hidden="true">{modKey}↩</kbd></Button></>}
    </>} />
    <LoadingRegion label="Loading campaign editor" className="campaign-compose-workspace">
      <div className="campaign-compose-scroll"><div className="studio-notices"><Notices /></div><div className="campaign-compose-sheet">
        <div className="campaign-compose-metadata" aria-hidden="true">
          <div className="campaign-compose-row campaign-compose-sender"><span>From</span><ControlSkeleton /><Button variant="ghost" size="sm" className="campaign-sender-toggle" disabled>Reply-To<Icon icon={ChevronRight} size="sm" /></Button></div>
          <div className="campaign-compose-row campaign-compose-subject"><span>Subject</span><ControlSkeleton /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled>Preview text</Button></div>
        </div>
        <ComposerSkeleton />
      </div></div>
    </LoadingRegion>
  </div>
  return <div className="campaign-review campaign-review--draft">
    <CampaignBar title={<h1 className="studio-title"><SkeletonText width={220} lineHeight={24} /></h1>} actions={<SkeletonText width={65} lineHeight={20} />} />
    <LoadingRegion label="Loading campaign review" className="review-stages">
      {(['Recipients', 'Message', 'Checks', 'Send'] as const).map((title, index) => <section className="review-stage" data-open={index === 0 || undefined} key={title}>
        <div className="review-stage__head"><span className="campaign-steps__mark review-stage__mark" aria-hidden="true">{index + 1}</span><span className="review-stage__title">{title}</span><span className="review-stage__summary"><SkeletonText width={140} /></span></div>
        {index === 0 && <div className="review-stage__body"><div className="review-stage__content"><div className="campaign-audience-picker">
          <Field label="List" htmlFor="campaign-list-loading"><Select id="campaign-list-loading" aria-label="Recipient list" value="" onValueChange={() => {}} options={[{ value: '', label: 'Loading lists…' }]} disabled /></Field>
          <Field label="Segment" htmlFor="campaign-segment-loading"><Select id="campaign-segment-loading" aria-label="Segment" value="" onValueChange={() => {}} options={[{ value: '', label: 'Everyone on the list' }]} disabled /></Field>
        </div></div><div className="review-stage__footer"><Button variant="primary" disabled>Next</Button></div></div>}
      </section>)}
    </LoadingRegion>
  </div>
}
