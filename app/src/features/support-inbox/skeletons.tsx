import type { ReactNode } from 'react'
import { Bot, ChevronRight, Mail, MessageSquare, MoreHorizontal } from 'lucide-react'
import { useLocation } from 'react-router'
import { BackLink, Button, IconButton, LoadingRegion, PageHeader, SearchField, Select, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn, type Tone } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { channelLabels, type Channel, type InboxCounts, type InboxView, type SupportConversation } from '../../data/support-inbox'
import './support-inbox.css'
import './conversation.css'

// The support inbox's column definitions (card slots included), shared by the route skeleton and the loaded list. A
// phone's card: the customer and last activity, the conversation (its subject, then the last message itself), then its
// status.
export const inboxColumnDefs: SkeletonColumn[] = [
  { key: 'customer', label: 'Customer', width: 'var(--sinbox-customer, 22%)', card: 'title' },
  { key: 'subject', label: 'Conversation', card: 'line' },
  { key: 'preview', label: 'Last message', card: 'line', table: false },
  { key: 'status', label: 'Status', width: 'var(--sinbox-status, 168px)', card: 'line' },
  { key: 'activity', label: 'Last', width: 64, align: 'right', card: 'aside' },
  { key: 'actions', label: '', width: 40, align: 'right', card: 'end' },
]
export const inboxViews: { value: InboxView; label: string; count?: keyof InboxCounts }[] = [{ value: 'needs_you', label: 'Needs you', count: 'needsYou' }, { value: 'all', label: 'All' }]
export const viewOf = (search: string): InboxView => { const view = new URLSearchParams(search).get('view'); return view && view !== 'needs_you' ? 'all' : 'needs_you' }
export const channelOf = (search: string): Channel | '' => { const channel = new URLSearchParams(search).get('channel'); return channel && Object.hasOwn(channelLabels, channel) ? channel as Channel : '' }

// Where a conversation stands, in six states: three distinct failure states (Not sent, No reply sent, Blocked), what
// staff owe (Needs reply when urgent, Urgent for agent feedback, which has nobody to reply to, Open otherwise), Waiting
// (open, awaiting the customer or agent), and Done.
export type Triage = { key: 'failed' | 'no_reply' | 'blocked' | 'needs_you' | 'waiting' | 'done'; text: string; tone: Tone }
export function triageOf(c: SupportConversation): Triage {
  const reasons = c.needsYou?.reasons
  if (!reasons) {
    if (c.done || c.status === 'closed' || (c.channel === 'agent_feedback' && Boolean(c.ticket?.resolvedAt))) return { key: 'done', text: 'Done', tone: 'neutral' }
    return { key: 'waiting', text: 'Waiting', tone: 'neutral' }
  }
  if (reasons.includes('failed')) return { key: 'failed', text: 'Not sent', tone: 'danger' }
  if (reasons.includes('no_reply')) return { key: 'no_reply', text: 'No reply sent', tone: 'danger' }
  if (reasons.includes('blocked')) return { key: 'blocked', text: 'Blocked', tone: 'warning' }
  return { key: 'needs_you', text: !c.needsYou!.urgent ? 'Open' : c.channel === 'agent_feedback' ? 'Urgent' : 'Needs reply', tone: c.needsYou!.urgent ? 'warning' : 'info' }
}
export function InboxTabs({ view, counts, onChange, disabled = false }: { view: InboxView; counts: InboxCounts | null; onChange?: (view: InboxView) => void; disabled?: boolean }) {
  return <div className="sinbox-tabs"><Tabs value={view} label="Support views" disabled={disabled} onValueChange={value => onChange?.(value as InboxView)}
    items={inboxViews.map(({ value, label, count }) => ({ value, label, count: !count ? undefined : counts ? counts[count] ?? 0 : null }))} /></div>
}
const channelOptions = [{ value: 'all', label: 'All channels' }, ...Object.entries(channelLabels).map(([value, label]) => ({ value, label }))]
/** Search and channel filter. */
export function InboxToolbar({ search = '', onSearch, channel = '', onChannel, disabled = false }: { search?: string; onSearch?: (value: string) => void; channel?: Channel | ''; onChannel?: (channel: Channel | '') => void; disabled?: boolean }) {
  return <div className="data-toolbar sinbox-toolbar"><div className="cluster sinbox-toolbar__filters">
    <SearchField className="search-box--list" aria-label="Search conversations" placeholder="Search conversations" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur() }} />
    <Select className="sinbox-channel-select" aria-label="Channel" value={channel || 'all'} options={channelOptions} disabled={disabled || !onChannel} onValueChange={value => onChannel?.(value === 'all' ? '' : value as Channel)} />
  </div></div>
}
/** The menu's place in the header (Your agents, ../operator/agents), held while the inbox loads. */
export const SupportMenuSkeleton = () => <IconButton label="Support menu" disabled><MoreHorizontal size={16} /></IconButton>
export function SupportInboxSkeleton({ view, channel }: { view: InboxView; channel: Channel | '' }) {
  return <>
    <PageHeader title="Support" actions={<SupportMenuSkeleton />} />
    <LoadingRegion label="Loading support conversations"><div className="sinbox-page">
      <InboxTabs view={view} counts={null} disabled />
      <InboxToolbar channel={channel} disabled />
      <TableSkeleton className="sinbox-table" columns={inboxColumnDefs} rows={12} />
    </div></LoadingRegion>
  </>
}

/** Who a conversation is with, for its header: the person, else their address, else the workspace that filed it. */
export function whoOf(c: SupportConversation): ReactNode {
  const address = c.customer?.email ?? c.sender
  return c.customer?.name ?? (address ? <PrivateAddress value={address} /> : c.workspace?.name ?? 'Unknown sender')
}
const channelIcons = { chat: MessageSquare, email: Mail, agent_feedback: Bot }
/** A conversation's header, loaded or not (one height either way): back, who (after the channel's icon, its slot held
 *  while loading) and where it stands (a button that opens Details, with a chevron on a phone), then Details on a wide
 *  screen, Done and the menu. */
export function ConversationHeader({ channel, who, status, onDetails, done, menu }: { channel?: Channel; who?: ReactNode; status?: ReactNode; onDetails?: () => void; done?: { onClick: () => void; title: string }; menu?: ReactNode }) {
  const Icon = channel && channelIcons[channel]
  return <header className="sinbox-chat__header sinbox-chat__column">
    <BackLink to="/support" />
    <button type="button" className="sinbox-chat__who" disabled={!onDetails} onClick={onDetails} aria-haspopup="dialog" title={onDetails ? 'Details' : undefined}>
      <span className="sinbox-chat__name"><span className="sinbox-chat__channel">{Icon && <Icon size={14} aria-label={channelLabels[channel!]} />}</span><span className="sinbox-chat__name-text">{who ?? <Skeleton width={140} height={14} />}</span>{who && <ChevronRight size={16} aria-hidden="true" className="sinbox-chat__chevron" />}</span>
      <span className="sinbox-chat__state">{status}</span>
    </button>
    <div className="cluster sinbox-chat__actions">
      <Button variant="ghost" className="sinbox-chat__details" disabled={!onDetails} onClick={onDetails}>Details</Button>
      <Button disabled={!done} title={done?.title} onClick={done?.onClick}>Done</Button>
      {menu ?? <IconButton label="Conversation actions" disabled><MoreHorizontal size={16} /></IconButton>}
    </div>
  </header>
}
/** The thread before it loads: a few bubbles and lines where the messages go. */
export function ThreadSkeleton() {
  return <div className="sinbox-chat__scroll"><LoadingRegion label="Loading the conversation"><div className="sinbox-chat__column sinbox-chat__thread" aria-hidden="true">
    {[62, 78, 48].map((width, index) => <div key={index} className="sinbox-msg" data-role={index % 2 ? 'agent' : 'customer'} data-first="">
      <p className="sinbox-msg__meta"><Skeleton width={96} height={10} /></p>
      <div className={index % 2 ? 'sinbox-msg__prose' : 'sinbox-msg__bubble'} style={{ width: `${width}%` }}><SkeletonText width="100%" lineHeight={20} /><SkeletonText width="60%" lineHeight={20} /></div>
    </div>)}
  </div></LoadingRegion></div>
}
export function SupportConversationSkeleton() {
  return <div className="sinbox-chat"><ConversationHeader /><ThreadSkeleton /></div>
}
// The route-level placeholder while the support inbox's code loads.
export function SupportRouteSkeleton({ operator }: { operator: 'operator' | 'operator:read' | null | undefined }) {
  const { pathname, search } = useLocation()
  if (!operator) return null
  return pathname.startsWith('/support/') ? <SupportConversationSkeleton /> : <SupportInboxSkeleton view={viewOf(search)} channel={channelOf(search)} />
}
