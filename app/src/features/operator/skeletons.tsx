import { forwardRef, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, Download } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { useSession } from '../../data/context'
import { Button, type ButtonProps, EmptyState, FacetRail, LoadingRegion, Meter, MetricRow, PageHeader, SearchField, SectionHeader, Select, Skeleton, Sparkline, SplitPane, TableSkeleton, Tabs, type FacetGroup, type SkeletonColumn, type Tone } from '../../components/ui'
import type { AbuseBand, DeliverabilityWindow } from '../../data/operator'
import './operator.css'

// Not an operator: no such page. An operator signed in with GitHub: staff tools need this account's Google sign-in
// (api/src/account-policy.ts), one button away.
export function StaffOnly() {
  const session = useSession()
  return session?.identity?.staffSignIn
    ? <EmptyState headingAs="h1" title="Sign in with Google to use staff tools" action={<Button variant="primary" onClick={session.signInForStaff}>Sign in with Google</Button>} />
    : <EmptyState headingAs="h1" title="Page not found" action={<Link to="/overview">Return to overview</Link>} />
}

// The operator console's column definitions (card slots included), shared by the route skeleton and the loaded tables.
export const queueColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '25%' },
  { key: 'step', label: 'Step', width: 112, card: 'aside' },
  { key: 'reason', label: 'Why', card: 'line' },
  { key: 'score', label: 'Score', width: 72, align: 'right', card: 'line' },
  { key: 'limit', label: 'Daily limit', width: 104, align: 'right', card: 'inline' },
  { key: 'since', label: 'Since', width: 160, card: 'inline' },
]
export const actionColumnDefs: SkeletonColumn[] = [
  { key: 'action', label: 'Action', width: '20%' },
  { key: 'at', label: 'When', width: 160, card: 'aside' },
  { key: 'workspace', label: 'Workspace', width: '18%', card: 'line' },
  { key: 'reason', label: 'Reason', card: 'line' },
  { key: 'ticket', label: 'Ticket', width: 140, card: 'inline' },
]
export const factorColumnDefs: SkeletonColumn[] = [
  { key: 'factor', label: 'Factor', width: '30%' },
  { key: 'score', label: 'Score', width: 80, align: 'right', card: 'aside' },
  { key: 'value', label: 'Value', width: 96, align: 'right', card: 'line' },
  { key: 'weight', label: 'Weight', width: 80, align: 'right', card: 'inline' },
  { key: 'points', label: 'Points', width: 80, align: 'right', card: 'inline' },
]
export const domainColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Domain', width: '30%' },
  { key: 'pool', label: 'Pool', width: 112, card: 'aside' },
  { key: 'region', label: 'Region', width: 112, card: 'line' },
  { key: 'dkim', label: 'DKIM', width: 80, card: 'inline' },
  { key: 'mailFrom', label: 'MAIL FROM', width: 104, card: 'inline' },
  { key: 'dmarc', label: 'DMARC', width: 112, card: 'line' },
]
export const memberColumnDefs: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '46%' },
  { key: 'role', label: 'Role', width: 120, card: 'aside' },
  { key: 'user', label: 'User', card: 'line' },
  { key: 'billing', label: 'Billing', width: 180, card: 'line' },
  { key: 'actions', label: '', width: 48, card: 'end' },
]
export const campaignColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '30%' },
  { key: 'state', label: 'State', width: 112, card: 'aside' },
  { key: 'pause', label: 'Pause reason', card: 'line' },
  { key: 'quarantines', label: 'Quarantines', width: 112, align: 'right', card: 'inline' },
  { key: 'actions', label: '', width: 56, align: 'right', card: 'end' },
]
export const timelineColumnDefs: SkeletonColumn[] = [
  { key: 'title', label: 'Event', width: '40%' },
  { key: 'kind', label: 'Kind', width: 112, card: 'aside' },
  { key: 'detail', label: 'Detail', card: 'line' },
  { key: 'at', label: 'When', width: 160, card: 'line' },
]
// The waitlist (?view=waitlist): a phone's card shows the address, its latest attempt, the name and the count, then
// whether a raise of the sign-up limit let it in and its email went.
export const waitlistColumnDefs: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '28%', card: 'title' },
  { key: 'name', label: 'Name', card: 'line' },
  { key: 'first', label: 'First attempt', width: 176, card: 'inline' },
  { key: 'last', label: 'Last attempt', width: 176, card: 'aside' },
  { key: 'attempts', label: 'Attempts', width: 96, align: 'right', card: 'inline' },
  { key: 'letIn', label: 'Let in', width: 216, card: 'line' },
]

// Sign-ups (?view=signups): the limit and what fills it, then every workspace, newest first. A phone's card shows the
// name and standing, the owner and when it joined, then its verified domain and what it sent.
export const signupFacts = ['Signed up', 'Held for the waitlist', 'Open', 'Waiting'] as const
export function SignupFacts({ values }: { values?: Record<(typeof signupFacts)[number], ReactNode> }) {
  return <dl className="op-facts op-facts--four">{signupFacts.map(title => <div key={title}><dt>{title}</dt><dd>{values ? values[title] : <Skeleton width={72} height={14} />}</dd></div>)}</dl>
}
export const signupColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '24%', card: 'title' },
  { key: 'owner', label: 'Owner', card: 'line' },
  { key: 'joined', label: 'Joined', width: 160, card: 'inline' },
  { key: 'domain', label: 'Domain', width: '18%', card: 'line' },
  { key: 'sent', label: 'Sent', width: 104, align: 'right', card: 'inline' },
  { key: 'standing', label: 'Standing', width: 112, card: 'aside' },
]
// Health (?view=health; the whole page on a self-hosted installation): six facts, then one table of what the minute
// tick measured, alerts first. A phone's card shows what it is and its state, the area, then the figures.
export const healthFacts = ['Measured', 'Open alerts', 'Feedback lag', 'Jobs due', 'Connections', 'Database'] as const
export function HealthFacts({ values }: { values?: Record<(typeof healthFacts)[number], ReactNode> }) {
  return <dl className="op-facts">{healthFacts.map(title => <div key={title}><dt>{title}</dt><dd>{values ? values[title] : <Skeleton width={72} height={14} />}</dd></div>)}</dl>
}
export const healthColumnDefs: SkeletonColumn[] = [
  { key: 'area', label: 'Area', width: 112, card: 'inline' },
  { key: 'what', label: 'What', width: '24%', card: 'title' },
  { key: 'state', label: 'State', width: 112, card: 'aside' },
  { key: 'now', label: 'Now', card: 'line' },
  { key: 'detail', label: 'Detail', width: '24%', card: 'line' },
]
export const HealthSkeleton = () => <><HealthFacts /><TableSkeleton className="op-table" columns={healthColumnDefs} rows={8} /></>
// A self-hosted installation has no operator area: Health is its whole page.
export function SelfHostedHealthSkeleton() {
  return <><PageHeader title="Health" /><LoadingRegion label="Loading health"><div className="op-page"><HealthSkeleton /></div></LoadingRegion></>
}
// The Sign-ups tab's header action, for the operator role: it opens the limit's dialog.
export const SetLimitTrigger = (props: ButtonProps) => <Button {...props}>Set limit…</Button>

// UI notes (/operator/notes): staff's design and bug notes on the dashboard. The screenshot column is for the table; a
// phone's card shows the note, its status, page, type and age, with its selection checkbox at the end for the bulk menu.
export const noteColumnDefs: SkeletonColumn[] = [
  { key: 'select', label: '', width: 40, card: 'end' },
  { key: 'shot', label: 'Screenshot', width: 92, card: 'hide' },
  { key: 'note', label: 'Note', card: 'title' },
  { key: 'status', label: 'Status', width: 124, card: 'aside' },
  { key: 'page', label: 'Page', width: '20%', card: 'line' },
  { key: 'kind', label: 'Type', width: 104, card: 'inline' },
  { key: 'created', label: 'Left', width: 168, card: 'inline' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const noteStatusOptions = [{ value: '', label: 'Open and in progress' }, { value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'fixed', label: 'Fixed' }, { value: 'wontfix', label: 'Won’t fix' }, { value: 'all', label: 'All notes' }]
export const noteKindOptions = [{ value: '', label: 'All types' }, ...['alignment', 'spacing', 'copy', 'bug', 'motion', 'mobile', 'other'].map(kind => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))]
export function NotesToolbar({ search = '', status = '', kind = '', onSearch, onStatus, onKind, actions, disabled = false }: { search?: string; status?: string; kind?: string; onSearch?: (value: string) => void; onStatus?: (value: string) => void; onKind?: (value: string) => void; actions?: ReactNode; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search notes and pages" placeholder="Search notes and pages" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by status" value={status} onValueChange={value => onStatus?.(value)} disabled={disabled} options={noteStatusOptions} />
    <Select aria-label="Filter by type" value={kind} onValueChange={value => onKind?.(value)} disabled={disabled} options={noteKindOptions} />
  </div>{actions ?? <Button className="op-bulk" disabled>Select notes <ChevronDown size={14} aria-hidden="true" /></Button>}</div>
}
export function OperatorNotesSkeleton() {
  return <>
    <PageHeader title="Operator" actions={<Button disabled>Agent keys</Button>} />
    <LoadingRegion label="Loading UI notes"><div className="op-page">
      <Tabs value="notes" onValueChange={() => {}} disabled items={notesTabs} label="Operator views" />
      <NotesToolbar disabled />
      <TableSkeleton className="op-notes" columns={noteColumnDefs} rows={6} />
    </div></LoadingRegion>
  </>
}

// Abuse (?view=abuse): clusters of related accounts by risk, and the alert outbox (&show=alerts). A phone's card shows
// the reasons, the risk beside them, then the counts and when it last changed.
export const clusterColumnDefs: SkeletonColumn[] = [
  { key: 'risk', label: 'Risk', width: 132, card: 'aside' },
  { key: 'why', label: 'Why', card: 'title' },
  { key: 'accounts', label: 'Accounts', width: 96, align: 'right', card: 'inline' },
  { key: 'workspaces', label: 'Workspaces', width: 112, align: 'right', card: 'inline' },
  { key: 'changed', label: 'Changed', width: 168, card: 'line' },
]
// Operator → Lists (./lists.tsx): one row per launched campaign to a list.
export const listColumnDefs: SkeletonColumn[] = [
  { key: 'campaign', label: 'Campaign', card: 'title' },
  { key: 'band', label: 'List risk', width: 132, card: 'aside' },
  { key: 'flagged', label: 'Flagged', width: 96, align: 'right', card: 'inline' },
  { key: 'review', label: 'Review said', width: 168, card: 'inline' },
  { key: 'bounced', label: 'Bounced', width: 96, align: 'right', card: 'inline' },
  { key: 'blocklist', label: 'Blocklist', width: 96, align: 'right', card: 'inline' },
  { key: 'probe', label: 'Probe', width: 112, card: 'inline' },
  { key: 'launched', label: 'Launched', width: 168, card: 'line' },
]
export const alertColumnDefs: SkeletonColumn[] = [
  { key: 'alert', label: 'Alert', card: 'title' },
  { key: 'status', label: 'Status', width: 132, card: 'aside' },
  { key: 'workspaces', label: 'Workspaces', width: 112, align: 'right', card: 'inline' },
  { key: 'created', label: 'Created', width: 168, card: 'line' },
]
// One cluster (/operator/abuse/:id): its workspaces with this month's free use, and its accounts.
export const clusterWorkspaceColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '26%', card: 'title' },
  { key: 'account', label: 'Account', width: 88, card: 'aside' },
  { key: 'plan', label: 'Plan', width: 88, card: 'inline' },
  { key: 'sent', label: 'Sent', width: 128, align: 'right', card: 'line' },
  { key: 'received', label: 'Received', width: 128, align: 'right', card: 'line' },
  { key: 'step', label: 'Step', width: 112, card: 'inline' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const clusterAccountColumnDefs: SkeletonColumn[] = [
  { key: 'key', label: 'Account', width: 88, card: 'aside' },
  { key: 'who', label: 'Sign-in', card: 'title' },
  { key: 'user', label: 'User', width: '34%', card: 'line' },
]
export const bandLabel: Record<AbuseBand, string> = { high: 'High', review: 'Review', watch: 'Watch', low: 'Low' }
export const bandTone: Record<AbuseBand, Tone> = { high: 'danger', review: 'warning', watch: 'info', low: 'neutral' }
export const abuseBands: AbuseBand[] = ['high', 'review', 'watch', 'low']
/** What the Abuse tab shows: ?band=high narrows the clusters; ?show=alerts is the alert outbox. */
export const abuseView = (search: string) => { const params = new URLSearchParams(search), band = params.get('band'); return { alerts: params.get('show') === 'alerts', band: abuseBands.includes(band as AbuseBand) ? band as AbuseBand : null } }
// The rail beside the list: risk levels with their counts, and the outbox. Counts arrive with the list (a dash until then).
export function abuseFacets({ band, alerts, counts, outbox, onBand, onAlerts }: { band: AbuseBand | null; alerts: boolean; counts?: Record<AbuseBand, number>; outbox?: number; onBand?: (band: AbuseBand | null) => void; onAlerts?: () => void }): FacetGroup[] {
  const pick = (value: AbuseBand | null) => onBand ? () => onBand(value) : undefined
  return [
    { key: 'risk', title: 'Risk', items: [{ key: 'all', label: 'All', count: counts ? abuseBands.reduce((sum, key) => sum + counts[key], 0) : null, selected: !alerts && band === null, onSelect: pick(null) },
      ...abuseBands.map(key => ({ key, label: bandLabel[key], tone: bandTone[key], count: counts ? counts[key] : null, selected: !alerts && band === key, onSelect: pick(key) }))] },
    { key: 'outbox', title: 'Outbox', items: [{ key: 'alerts', label: 'Alerts', count: outbox ?? null, selected: alerts, onSelect: onAlerts }] },
  ]
}
export function AbuseSkeleton({ search }: { search: string }) {
  const view = abuseView(search)
  return <SplitPane className="op-abuse" collapse="row" rail={<FacetRail label="Abuse views" groups={abuseFacets(view)} />}><TableSkeleton className="op-table" columns={view.alerts ? alertColumnDefs : clusterColumnDefs} rows={6} /></SplitPane>
}
export const dailyLimitError = 'A whole number from 1 to 10,000,000.'
export const clusterFacts = ['Risk', 'Score', 'Accounts', 'Workspaces', 'First seen', 'Changed', 'Alert', 'Review'] as const
/** The cluster's review actions in its header, for the operator role: the same two buttons while it loads. */
export const reviewActions = ['Watch', 'Dismiss'] as const
// The cluster's rail on a wide window: the other clusters, to step through them. Rows are 32px in every state.
export function ClusterRailSkeleton() {
  return <ul className="op-cluster-rail" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <li key={i}><span className="op-cluster-rail__row"><Skeleton width={72} height={12} /><Skeleton width={96} height={12} /></span></li>)}</ul>
}
export function ClusterBodySkeleton() {
  return <div className="op-page" aria-hidden="true">
    <dl className="op-facts op-facts--four">{clusterFacts.map(title => <div key={title}><dt>{title}</dt><dd><Skeleton width={88} height={14} /></dd></div>)}</dl>
    <div className="op-grid"><section className="op-section"><SectionHeader title="Why" /><Skeleton height={224} /></section><section className="op-section"><SectionHeader title="Links" /><Skeleton height={224} /></section></div>
    <section className="op-section"><SectionHeader title="Workspaces" /><TableSkeleton className="op-table" columns={clusterWorkspaceColumnDefs} rows={3} /></section>
  </div>
}
export function OperatorClusterSkeleton({ actions }: { actions: boolean }) {
  return <>
    <PageHeader title="Related accounts" backTo="/operator?view=abuse" actions={actions ? reviewActions.map(action => <Button key={action} disabled>{action}</Button>) : undefined} />
    <LoadingRegion label="Loading the cluster"><SplitPane className="op-cluster" rail={<ClusterRailSkeleton />}><ClusterBodySkeleton /></SplitPane></LoadingRegion>
  </>
}

const baseTabs = [{ value: 'queue', label: 'Review queue' }, { value: 'signups', label: 'Sign-ups' }, { value: 'abuse', label: 'Abuse' }, { value: 'lists', label: 'Lists' }, { value: 'actions', label: 'Actions' }, { value: 'waitlist', label: 'Waitlist' }, { value: 'health', label: 'Health' }]
/** The tab a /operator address opens: ?view=signups, ?view=abuse, ?view=lists, ?view=actions, ?view=waitlist or ?view=health, else the review queue. */
export const operatorView = (search: string) => { const view = new URLSearchParams(search).get('view'); return view === 'actions' || view === 'waitlist' || view === 'abuse' || view === 'lists' || view === 'signups' || view === 'health' ? view : 'queue' }
const notesTabs = [...baseTabs, { value: 'notes', label: 'UI notes' }]
/** UI notes has a tab only for the people the API allows (GET /v1/me uiNotes). */
export const useOperatorTabs = () => useSession()?.identity?.uiNotes === true ? notesTabs : baseTabs
export const facts = ['Step', 'Score', 'Daily limit', 'Since', 'Strikes', 'Connection'] as const

export const stepOptions = [{ value: '', label: 'Needs review' }, { value: 'pause', label: 'Paused' }, { value: 'restrict', label: 'Restricted' }, { value: 'warn', label: 'Warned' }, { value: 'notice', label: 'Notice' }]
// Search spans every workspace (by ID or name); the step filter narrows the queue.
export function QueueToolbar({ search = '', step = '', onSearch, onStep, disabled = false }: { search?: string; step?: string; onSearch?: (value: string) => void; onStep?: (value: string) => void; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search all workspaces" placeholder="Search all workspaces" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by step" value={step} onValueChange={value => onStep?.(value)} disabled={disabled || search.trim() !== ''} options={stepOptions} />
  </div></div>
}
// Search spans addresses and names; the export downloads everyone the search lists, addresses in full.
export function WaitlistToolbar({ search = '', onSearch, onExport, exporting = false, exportable = false, disabled = false }: { search?: string; onSearch?: (value: string) => void; onExport?: () => void; exporting?: boolean; exportable?: boolean; disabled?: boolean }) {
  return <div className="data-toolbar op-waitlist-tools"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search the waitlist" placeholder="Search addresses and names" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
  </div><Button className="op-export" aria-label="Export as CSV" title="Download everyone listed as a CSV file" disabled={disabled || !exportable} loading={exporting} onClick={onExport}><Download size={16} aria-hidden="true" /><span>Export CSV</span></Button></div>
}
export function OperatorQueueSkeleton({ view = 'queue', search = '', canAct = false }: { view?: string; search?: string; canAct?: boolean }) {
  return <>
    <PageHeader title="Operator" actions={view === 'signups' && canAct ? <SetLimitTrigger disabled /> : undefined} />
    <LoadingRegion label={view === 'waitlist' ? 'Loading the waitlist' : view === 'abuse' ? 'Loading related accounts' : view === 'lists' ? 'Loading lists' : view === 'signups' ? 'Loading sign-ups' : view === 'health' ? 'Loading health' : 'Loading the review queue'}><div className="op-page">
      <Tabs value={view} onValueChange={() => {}} disabled items={useOperatorTabs()} label="Operator views" />
      {view === 'queue' && <QueueToolbar disabled />}
      {view === 'waitlist' && <WaitlistToolbar disabled />}
      {view === 'signups' && <SignupFacts />}
      {view === 'abuse' ? <AbuseSkeleton search={search} /> : view === 'health' ? <HealthSkeleton /> : <TableSkeleton columns={view === 'queue' ? queueColumnDefs : view === 'waitlist' ? waitlistColumnDefs : view === 'signups' ? signupColumnDefs : view === 'lists' ? listColumnDefs : actionColumnDefs} rows={6} />}
    </div></LoadingRegion>
  </>
}
export function WorkspaceBodySkeleton() {
  return <div className="op-page" aria-hidden="true">
    <dl className="op-facts">{facts.map(title => <div key={title}><dt>{title}</dt><dd><Skeleton width={88} height={14} /></dd></div>)}</dl>
    <div className="op-grid"><section className="op-section"><SectionHeader title="Standing" /><Skeleton height={168} /></section><section className="op-section"><SectionHeader title="Limit" /><Skeleton height={168} /></section></div>
    <section className="op-section"><SectionHeader title="Factors" /><TableSkeleton columns={factorColumnDefs} rows={6} /></section>
  </div>
}
// The workspace's actions menu trigger. It forwards its props and ref, so the menu (or a phone's action sheet) can open from it.
export const ActionsTrigger = forwardRef<HTMLButtonElement, ButtonProps>(function ActionsTrigger(props, ref) {
  return <Button {...props} ref={ref}>Actions <ChevronDown size={14} aria-hidden="true" /></Button>
})
export function OperatorWorkspaceSkeleton({ actions }: { actions: boolean }) {
  return <>
    <PageHeader title="Workspace" backTo="/operator" actions={actions ? <ActionsTrigger disabled /> : undefined} />
    <LoadingRegion label="Loading the workspace"><WorkspaceBodySkeleton /></LoadingRegion>
  </>
}
// Glass (/glass): a live board for operators. On the left, fixed tiles (a big figure, its last 24 hours and its change
// from the 24 hours before), the funnel, every SES pool region and groups of metric rows; on the right, the activity
// feed in a column of its own (under everything on a narrow screen). Every block has its size here, rows and all, so the
// route's placeholder, the page's loading state and each 5-second refresh draw the same boxes in the same places.
// glass.tsx fills them.
export type GlassRowDef = { key: string; label?: string; spark?: true; meter?: true; cells?: readonly string[]; note?: string }
export type GlassFill = { label?: ReactNode; hint?: ReactNode; spark?: readonly number[]; value: ReactNode; unit?: ReactNode; tone?: Tone; empty?: boolean
  meter?: { value: number; max: number; mark?: number; tone?: Tone; label?: string }; cells?: ReactNode[] }
/** A tile: its figure, a hint under it, and in its foot a trend (`spark`, oldest first), parts of a whole (`parts`), a share (`meter`) or a line of text (`note`). */
export type GlassTileFill = { value: ReactNode; hint?: ReactNode; tone?: Tone; delta?: { text: string; tone?: Tone; title: string }
  spark?: readonly number[]; note?: ReactNode; parts?: { value: number; tone: Tone; label: string }[]; meter?: { value: number; max: number; tone?: Tone; label: string } }
export type GlassRegionFill = { region: ReactNode; place: ReactNode; sending: ReactNode; receiving: ReactNode; rate: ReactNode; quota: ReactNode; share: ReactNode
  meter?: { value: number; max: number; tone?: Tone; label: string }; checked: ReactNode; empty?: boolean }
export type GlassBoardFill = { tile: (key: string) => GlassTileFill; funnel: (key: string) => { value: ReactNode; share?: ReactNode; meter: { value: number; max: number } }
  regions: GlassRegionFill[]; total: GlassRegionFill; row: (group: string, row: string) => GlassFill }
export const glassTiles = [
  ['sent', 'Sent · 24 h'], ['minute', 'Per minute'], ['delivered', 'Delivered'], ['bounced', 'Bounced'], ['complained', 'Complained'],
  ['signups', 'Sign-ups · 24 h'], ['places', 'Open places'], ['received', 'Received · 24 h'], ['queued', 'Queued'], ['ramp', 'On the ramp'],
  ['standing', 'Paused senders'], ['builtin', 'Built-in domains'], ['visitors', 'Visitors today'], ['support', 'Support · 7 d'], ['screened', 'Screened · 24 h'],
  ['classifiers', 'Classifiers agree'], ['api', 'API · 24 h'], ['errors', 'API errors'], ['latency', 'API latency'], ['health', 'Health'],
] as const
export const glassFunnel = [['signedUp', 'Signed up'], ['domainAdded', 'Added a domain'], ['domainVerified', 'Verified it'], ['builtinReady', 'Built-in ready'], ['keyCreated', 'Created a key'], ['firstSend', 'Sent mail']] as const
/** Region rows are kept for at least this many regions, so a page with fewer draws the same height. */
export const GLASS_REGION_SLOTS = 2
const STEP_SLOTS = ['OK', 'Notice', 'Warn', 'Restrict', 'Pause']
const GRADE_SLOTS = ['A+', 'A', 'B', 'C', 'D', 'F', 'Warmup']
const slots = (prefix: string, n: number, extra: Omit<GlassRowDef, 'key'> = {}) => Array.from({ length: n }, (_, i): GlassRowDef => ({ key: `${prefix}:${i}`, ...extra }))
export const glassGroups: GlassGroupDef[] = [
  { key: 'sending', title: 'Sending now', to: ['/operator?view=health', 'Health'], rows: [{ key: 'transactional', label: 'Transactional', spark: true }, { key: 'marketing', label: 'Marketing', spark: true },
    { key: 'held', label: 'Held for screening' }, { key: 'api', label: 'Send API' }, ...slots('campaign', 2, { meter: true })] },
  { key: 'standing', title: 'Standing', to: ['/operator', 'Queue'], rows: [{ key: 'grades', cells: GRADE_SLOTS }, { key: 'steps', cells: STEP_SLOTS }, { key: 'paused', label: 'Paused' },
    { key: 'held', label: 'Marketing held' }, { key: 'revoked', label: 'Built-in domains revoked' }, { key: 'parent', label: 'Built-in parent' }] },
  { key: 'system', title: 'System', to: ['/operator?view=health', 'Health'], rows: [{ key: 'health', label: 'Health' }, ...slots('alert', 3), { key: 'deploy', label: 'Deploy' }, { key: 'classifiers', label: 'Classifier errors' }] },
  { key: 'money', title: 'Money', rows: [{ key: 'creditToday', label: 'Credit today' }, { key: 'creditMonth', label: 'Credit this month', spark: true }, { key: 'owed', label: 'Owed' }, { key: 'usage', label: 'Usage this month' }] },
  { key: 'visitors', title: 'Visitors', rows: [{ key: 'views', label: 'Page views today', spark: true }, ...slots('referrer', 3)] },
]

function GlassTile({ label, fill }: { label: string; fill?: GlassTileFill }) {
  return <div className="glass-tile" role="group" aria-label={label}>
    <div className="glass-tile__head"><span className="glass-tile__label">{label}</span>
      {/* Laid out from the head's right edge and pulled back by its own width: a change that grows never moves a box. */}
      <span className="glass-delta">{fill?.delta && <span className={`ui-tone--${fill.delta.tone ?? 'neutral'}`} title={fill.delta.title}>{fill.delta.text}</span>}</span></div>
    <div className={fill?.tone && fill.tone !== 'neutral' ? `glass-tile__figure ui-tone--${fill.tone}` : 'glass-tile__figure'}>{fill ? fill.value : <Skeleton width={96} height={22} />}</div>
    <div className="glass-tile__hint">{fill ? fill.hint : <Skeleton width={128} height={10} />}</div>
    <div className="glass-tile__foot">{fill?.parts ? <span className="glass-parts" role="img" aria-label={fill.parts.map(p => `${p.label} ${p.value}`).join(', ')}>{fill.parts.map(p => <i key={p.label} className={`ui-tone--${p.tone}`} style={{ flexGrow: p.value }} />)}</span>
      : fill?.meter ? <Meter value={fill.meter.value} max={fill.meter.max} tone={fill.meter.tone} label={fill.meter.label} />
      : fill?.note ? <span className="glass-tile__note">{fill.note}</span>
      : <Sparkline values={fill?.spark ?? []} />}</div>
  </div>
}
const regionSkeleton: GlassRegionFill = { region: <Skeleton width={72} height={12} />, place: '', sending: <Skeleton width={56} height={12} />, receiving: <Skeleton width={56} height={12} />, rate: <Skeleton width={40} height={12} />,
  quota: <Skeleton width={96} height={12} />, share: '', checked: <Skeleton width={48} height={12} /> }
function GlassRegionRow({ row, total = false }: { row: GlassRegionFill; total?: boolean }) {
  return <div className={total ? 'glass-region glass-region--total' : row.empty ? 'glass-region glass-empty' : 'glass-region'} role="row">
    <span role="cell" className="glass-region__name"><span className="glass-region__code">{row.region}</span><span className="glass-region__place">{row.place}</span></span>
    <span role="cell" className="glass-region__sending">{row.sending}</span><span role="cell" className="glass-region__receiving">{row.receiving}</span>
    <span role="cell" className="glass-region__rate">{row.rate}</span>
    <span role="cell" className="glass-region__quota"><span className="glass-region__sent">{row.quota}</span><span className="glass-region__share">{row.share}</span>
      <Meter value={row.meter?.value ?? 0} max={row.meter?.max ?? 1} tone={row.meter?.tone} label={row.meter?.label} /></span>
    <span role="cell" className="glass-region__checked">{row.checked}</span>
  </div>
}
/** A placeholder one line of text tall, so the text that replaces it takes the same box. */
const SkeletonLine = ({ width }: { width: number }) => <span className="glass-skel-line"><Skeleton width={width} height={12} /></span>
type GlassGroupDef = { key: string; title: string; to?: [href: string, label: string]; rows: GlassRowDef[] }
/** Groups of 40px rows in as many columns as fit: a metric row each, a row of labelled cells, or a fixed note. */
function GlassGroupList({ groups, row: fillRow }: { groups: GlassGroupDef[]; row?: (group: string, row: string) => GlassFill }) {
  return <div className="glass">{groups.map(group => <section key={group.key} className="glass-group" aria-label={group.title}>
    <SectionHeader title={group.title} actions={groupLink(group.to)} />
    {group.rows.map(def => {
      if (def.note) return <p key={def.key} className="glass-note">{def.note}</p>
      const row = fillRow?.(group.key, def.key)
      if (def.cells) return <div key={def.key} className="glass-grades" role="list" aria-label={def.key === 'grades' ? 'Sender scores' : 'Standing steps'} style={{ gridTemplateColumns: `repeat(${def.cells.length}, minmax(0, 1fr))` }}>{def.cells.map((cell, i) =>
        <span key={cell} role="listitem"><span>{cell}</span><b>{row?.cells?.[i] ?? <Skeleton width={16} height={12} />}</b></span>)}</div>
      return <MetricRow key={def.key} className={row?.empty ? 'glass-empty' : undefined} label={row ? row.label ?? def.label : def.label ?? <SkeletonLine width={112} />} hint={row?.hint}
        spark={def.spark && <Sparkline values={row?.spark ?? []} />} value={row ? row.value : <Skeleton width={56} height={14} />} unit={row?.unit} tone={row?.tone}
        meter={def.meter && <Meter value={row?.meter?.value ?? 0} max={row?.meter?.max ?? 1} mark={row?.meter?.mark} tone={row?.meter?.tone} label={row?.meter?.label} />} />
    })}
  </section>)}</div>
}
const groupLink = (to?: [string, string]) => to && <Link className="ui-button ui-button--ghost ui-button--sm" to={to[0]}>{to[1]} <ArrowUpRight size={16} aria-hidden="true" /></Link>
/** The board, filled by `fill`; without it, every figure is a placeholder of its own size. `feed`: the activity column's rows. */
export function GlassBoard({ fill, feed, live }: { fill?: GlassBoardFill; feed?: ReactNode; live?: ReactNode }) {
  const regions = fill ? [...fill.regions, ...Array.from({ length: Math.max(0, GLASS_REGION_SLOTS - fill.regions.length) }, (): GlassRegionFill => ({ region: '', place: '', sending: '', receiving: '', rate: '', quota: '', share: '', checked: '', empty: true }))]
    : Array.from({ length: GLASS_REGION_SLOTS }, () => regionSkeleton)
  return <div className="glass-board">
    <div className="glass-main">
      <section className="glass-tiles" aria-label="Now">{glassTiles.map(([key, label]) => <GlassTile key={key} label={label} fill={fill?.tile(key)} />)}</section>
      <section className="glass-section" aria-label="Funnel · 30 days">
        <SectionHeader title="Funnel · 30 days" actions={groupLink(['/operator?view=signups', 'Workspaces'])} />
        <ol className="glass-funnel">{glassFunnel.map(([key, label]) => { const step = fill?.funnel(key); return <li key={key}>
          <span className="glass-funnel__label">{label}</span>
          <span className="glass-funnel__figure">{step ? step.value : <Skeleton width={48} height={16} />}<span className="glass-funnel__share">{step?.share}</span></span>
          <Meter value={step?.meter.value ?? 0} max={step?.meter.max ?? 1} />
        </li> })}</ol>
      </section>
      <section className="glass-section" aria-label="SES regions">
        <SectionHeader title="SES regions" />
        <div className="glass-regions" role="table" aria-label="SES regions">
          <div className="glass-region glass-region--head" role="row">{['Region', 'Sending', 'Receiving', 'Max rate', 'Sent · 24 h of quota', 'Checked'].map(title => <span key={title} role="columnheader">{title}</span>)}</div>
          {regions.map((row, i) => <GlassRegionRow key={i} row={row} />)}
          <GlassRegionRow total row={fill?.total ?? { ...regionSkeleton, region: 'Total' }} />
        </div>
      </section>
      <GlassGroupList groups={glassGroups} row={fill?.row} />
    </div>
    <aside className="glass-feed" aria-label="Activity">
      <div className="glass-feed__head"><h2 className="glass-feed__title">Activity</h2>{live}</div>
      <div className="glass-feed__list">{feed ?? <ol className="glass-feed__rows" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <li key={i} className="glass-event" style={{ transform: `translateY(${i * GLASS_EVENT_HEIGHT}px)` }}>
        <span className="glass-event__icon" /><span className="glass-event__text"><Skeleton width={160} height={12} /><Skeleton width={112} height={10} /></span><span className="glass-event__time"><Skeleton width={24} height={10} /></span></li>)}</ol>}</div>
    </aside>
  </div>
}
/** A feed row's height: rows are placed by a transform, so a new one slides the others down without a layout shift. */
export const GLASS_EVENT_HEIGHT = 52
/** Whether the figures are live: a dot and the time they are from, in a box as wide as its placeholder. */
export const GlassAsOf = ({ at, state = 'live' }: { at?: ReactNode; state?: 'live' | 'stalled' }) => <span className="glass-asof" data-state={at ? state : undefined}>
  <span className="glass-asof__dot" aria-hidden="true" />{at ?? <Skeleton width="12ch" height={14} />}</span>
/** /glass shows the live board; /glass?view=deliverability the Deliverability board. */
export type GlassView = 'live' | 'deliverability'
export const glassView = (search: string): GlassView => new URLSearchParams(search).get('view') === 'deliverability' ? 'deliverability' : 'live'
const glassViews = [{ value: 'live', label: 'Live' }, { value: 'deliverability', label: 'Deliverability' }]
export const GlassTabs = ({ value, onValueChange }: { value: GlassView; onValueChange?: (view: GlassView) => void }) =>
  <div className="glass-views"><Tabs value={value} onValueChange={view => onValueChange?.(view as GlassView)} items={glassViews} label="Glass views" disabled={!onValueChange} /></div>
export function GlassSkeleton() {
  const view = glassView(useLocation().search)
  return <><PageHeader title="Glass" actions={<GlassAsOf />} /><GlassTabs value={view} />
    <LoadingRegion label={view === 'live' ? 'Loading glass' : 'Loading deliverability'}>{view === 'live' ? <GlassBoard /> : <DeliverabilityBoard controls={<DeliverabilityControls {...deliverabilitySettings(useLocation().search)} />} />}</LoadingRegion></>
}

// The Deliverability board: a control strip (period, stream, region), eight tiles, the providers worst first, groups of
// rows (engagement, SES accounts, our domains, standing, the workspaces with the most complaints and bounces) and Amazon
// VDM's estimates. Every block has a fixed number of rows (an empty one keeps its place), so a period or filter that
// changes the figures moves nothing. deliverability.tsx fills it.
export type DeliverabilityStream = 'all' | 'transactional' | 'marketing'
export const DELIVERABILITY_WINDOWS: { value: DeliverabilityWindow; label: string; before: string }[] = [{ value: '24h', label: '24 h', before: 'the 24 h before' }, { value: '7d', label: '7 days', before: 'the 7 days before' }, { value: '30d', label: '30 days', before: 'the 30 days before' }]
export function deliverabilitySettings(search: string) {
  const params = new URLSearchParams(search), window = params.get('window'), stream = params.get('stream')
  return { window: DELIVERABILITY_WINDOWS.some(w => w.value === window) ? window as DeliverabilityWindow : '7d' as DeliverabilityWindow,
    stream: stream === 'transactional' || stream === 'marketing' ? stream as DeliverabilityStream : 'all' as DeliverabilityStream, region: params.get('region') || 'all' }
}
const streams = [{ value: 'all', label: 'All mail' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]
export function DeliverabilityControls({ window, stream, region, regions = [], note, onChange }: { window: DeliverabilityWindow; stream: DeliverabilityStream; region: string; regions?: { value: string; label: string }[]; note?: ReactNode
  onChange?: (key: 'window' | 'stream' | 'region', value: string) => void }) {
  const options = [{ value: 'all', label: 'All regions' }, ...regions.some(r => r.value === region) || region === 'all' ? [] : [{ value: region, label: region }], ...regions]
  return <div className="dlv-controls">
    <Tabs value={window} onValueChange={value => onChange?.('window', value)} items={DELIVERABILITY_WINDOWS} label="Period" disabled={!onChange} />
    <Tabs value={stream} onValueChange={value => onChange?.('stream', value)} items={streams} label="Mail" disabled={!onChange} />
    <Select className="dlv-region" aria-label="Region" value={region} onValueChange={value => onChange?.('region', value)} options={options} disabled={!onChange} />
    <span className="dlv-note"><span>{note ?? <SkeletonLine width={180} />}</span></span>
  </div>
}
export const deliverabilityTiles = [['accepted', 'Accepted'], ['delivered', 'Delivered'], ['hard', 'Hard bounces'], ['soft', 'Soft bounces'], ['deferred', 'Deferred'],
  ['complained', 'Complaints'], ['human', 'Opened by people'], ['clicked', 'Clicked']] as const
export const providerColumns = [['provider', 'Provider'], ['accepted', 'Accepted'], ['delivered', 'Delivered'], ['change', 'vs before'], ['hard', 'Hard bounce'], ['soft', 'Soft bounce'],
  ['deferred', 'Deferred'], ['complained', 'Complaints'], ['human', 'Human opens'], ['machine', 'Bot opens'], ['clicked', 'Clicked']] as const
export const vdmColumns = [['isp', 'ISP'], ['send', 'Sent'], ['delivered', 'Delivered'], ['permanent', 'Hard bounce'], ['transient', 'Soft bounce'], ['complaint', 'Complaints'], ['open', 'Opens'], ['click', 'Clicks']] as const
/** Mailbox providers (api/src/deliverability.ts PROVIDERS) and VDM's rows: every provider has a row, mail or none. */
export const PROVIDER_SLOTS = 7, VDM_SLOTS = 6
export type DeliverabilityRow = { cells: ReactNode[]; tones?: (Tone | undefined)[]; empty?: boolean }
export type DeliverabilityFill = { domainCount: number; tile: (key: string) => GlassTileFill; providers: DeliverabilityRow[]; vdm: { status: ReactNode; rows: DeliverabilityRow[] }; row: (group: string, row: string) => GlassFill }
export const deliverabilityGroups: GlassGroupDef[] = [
  { key: 'engagement', title: 'Engagement', rows: [{ key: 'opened', label: 'Opened', spark: true }, { key: 'human', label: 'Opened by people', spark: true }, { key: 'machine', label: 'Opened by machines only' },
    { key: 'clicked', label: 'Clicked', spark: true }, { key: 'cto', label: 'Clicks per opener' },
    { key: 'note', note: 'Over delivered mail. Apple Mail Privacy Protection and link scanners open mail by themselves; SES flags those opens, counted here as machines. Clicks are the firmer signal.' }] },
  { key: 'ses', title: 'SES accounts', to: ['/operator?view=health', 'Health'], rows: slots('region', GLASS_REGION_SLOTS) },
  { key: 'domains', title: 'Domains', rows: [{ key: 'budget', label: 'Shared link recipients today' }, ...slots('dbl', 2), ...slots('postmaster', 2)] },
  { key: 'standing', title: 'Standing', to: ['/operator', 'Queue'], rows: [{ key: 'grades', cells: GRADE_SLOTS }, { key: 'steps', cells: STEP_SLOTS }] },
  { key: 'complaints', title: 'Most complaints', to: ['/operator', 'Queue'], rows: slots('ws', 10) },
  { key: 'bounces', title: 'Most bounces', to: ['/operator', 'Queue'], rows: slots('ws', 10) },
]
function DeliverabilityTable({ label, columns, rows, slots: n, className }: { label: string; columns: readonly (readonly [string, string])[]; rows?: DeliverabilityRow[]; slots: number; className: string }) {
  return <div className={`dlv-table ${className}`} role="table" aria-label={label}>
    <div className="dlv-row dlv-row--head" role="row">{columns.map(([key, title]) => <span key={key} role="columnheader" data-col={key}>{title}</span>)}</div>
    {Array.from({ length: n }, (_, i) => { const row = rows?.[i]; return <div key={i} className={row?.empty ? 'dlv-row glass-empty' : 'dlv-row'} role="row">
      {columns.map(([key, title], c) => <span key={key} role="cell" data-col={key} data-label={title} className={row?.tones?.[c] && row.tones[c] !== 'neutral' ? `ui-tone--${row.tones[c]}` : undefined}>
        {row ? row.cells[c] : <SkeletonLine width={c ? 40 : 88} />}</span>)}
    </div> })}
  </div>
}
/** The Deliverability board, filled by `fill`; without it, every figure is a placeholder of its own size. */
export function DeliverabilityBoard({ fill, controls, stale = false }: { fill?: DeliverabilityFill; controls: ReactNode; stale?: boolean }) {
  return <div className="dlv" data-stale={stale || undefined}>
    {controls}
    <section className="glass-tiles dlv-tiles" aria-label="Our mail">{deliverabilityTiles.map(([key, label]) => <GlassTile key={key} label={label} fill={fill?.tile(key)} />)}</section>
    <section className="glass-section" aria-label="By mailbox provider">
      <SectionHeader title="By mailbox provider · worst first" />
      <DeliverabilityTable label="By mailbox provider" columns={providerColumns} rows={fill?.providers} slots={PROVIDER_SLOTS} className="dlv-table--providers" />
    </section>
    <GlassGroupList groups={deliverabilityGroups.map(group => group.key === 'domains' && fill && fill.domainCount > 2
      ? { ...group, rows: [...group.rows, ...Array.from({ length: fill.domainCount - 2 }, (_, i) => ({ key: `dbl:${i + 2}` }))] } : group)} row={fill?.row} />
    <section className="glass-section" aria-label="Amazon VDM estimates">
      <SectionHeader title="Amazon VDM · estimates" />
      <p className="dlv-status">{fill ? fill.vdm.status : <Skeleton width={320} height={12} />}</p>
      <DeliverabilityTable label="Amazon VDM estimates by ISP" columns={vdmColumns} rows={fill?.vdm.rows} slots={VDM_SLOTS} className="dlv-table--vdm" />
    </section>
  </div>
}

// The route-level placeholder while the operator chunk loads.
export function OperatorRouteSkeleton({ operator }: { operator: 'operator' | 'operator:read' | null | undefined }) {
  const { pathname, search } = useLocation(), identity = useSession()?.identity, uiNotes = identity?.uiNotes === true
  if (!operator) return identity && identity.multiTenant !== true && pathname === '/operator' ? <SelfHostedHealthSkeleton /> : null
  if (pathname === '/operator/notes') return uiNotes ? <OperatorNotesSkeleton /> : null
  if (pathname.startsWith('/operator/abuse/')) return <OperatorClusterSkeleton actions={operator === 'operator'} />
  return pathname.startsWith('/operator/workspaces/') ? <OperatorWorkspaceSkeleton actions={operator === 'operator'} /> : <OperatorQueueSkeleton view={operatorView(search)} search={search} canAct={operator === 'operator'} />
}
