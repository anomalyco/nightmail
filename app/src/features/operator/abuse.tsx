import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, FacetRail, Field, Input, MutationError, PageHeader, SectionHeader, Skeleton, SplitPane, StatusBadge, Textarea, useToast, type Column, type MenuItem, type Tone } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSession } from '../../data/context'
import { isoTime, operatorApi, type AbuseAccount, type AbuseAlert, type AbuseBand, type AbuseCluster, type AbuseClusterDetail, type AbuseLink, type AbuseReason, type AbuseReview, type AbuseWorkspace, type SlackCard } from '../../data/operator'
import { errorText } from '../../data/types'
import { label, number, shortDateTime } from '../../lib/format'
import { abuseFacets, abuseView, alertColumnDefs, bandLabel, bandTone, ClusterBodySkeleton, clusterAccountColumnDefs, clusterColumnDefs, clusterFacts, ClusterRailSkeleton, clusterWorkspaceColumnDefs, dailyLimitError, reviewActions, StaffOnly } from './skeletons'
import { ListsView } from './lists'
import { At, def, InfiniteMore, reasonCheck, StepBadge, useShown, when } from './shared'

// Operator → Abuse: accounts and workspaces that abuse monitoring found related, by risk, for a person to review.
// A cluster opens beside the list of the others: why it scored, what links its members (kinds and counts, never a
// value), and its workspaces with this month's free use. Nothing here acts by itself: an operator clicks Pause or Set
// limit, and the note they give stays in the staff audit; or reviews the cluster's alert with Watch or Dismiss. Every
// read of this area is recorded for staff.
const reasonLabel: Record<string, string> = {
  MULTI_ACCOUNT: 'Several accounts', FREE_TIER_MULTIPLIED: 'Free allowance multiplied', THROWAWAY_SIGNUP: 'Throwaway sign-up', SIGNUP_BURST: 'Sign-up burst', SHARED_CARD: 'Shared card', PAYMENT_RISK: 'Payment risk',
  SIMILAR_CONTENT: 'Similar mail', SHARED_LINKS: 'Shared link domains', SENDER_STANDING: 'Sender standing', FAST_FIRST_SEND: 'Fast first send', WAITLIST_REPEAT: 'Repeated refusals',
}
const kindLabel: Record<string, string> = { email: 'address', email_alias: 'mailbox', email_domain: 'email domain', provider: 'sign-in account', net: 'network', card: 'card', send_domain: 'sending domain', content: 'mail wording', link: 'link domain' }
const reasonText = (reason: AbuseReason) => reasonLabel[reason.code] ?? label(reason.code.toLowerCase())
const Risk = ({ band, score }: { band: AbuseBand; score: number }) => <span className="op-risk"><StatusBadge status={bandLabel[band]} tone={bandTone[band]} /><span className="op-risk__score">{score}</span></span>
const why = (cluster: AbuseCluster) => [...cluster.reasons].sort((a, b) => b.points - a.points).map(reasonText).join(' · ')

const clusterColumns: Column<AbuseCluster>[] = [
  { ...def(clusterColumnDefs, 'risk'), render: row => <Risk band={row.band} score={row.score} /> },
  { ...def(clusterColumnDefs, 'why'), render: row => <span className="op-cell" title={why(row)}>{why(row) || '—'}</span> },
  { ...def(clusterColumnDefs, 'accounts'), render: row => number(row.accounts), cardRender: row => `${number(row.accounts)} accounts` },
  { ...def(clusterColumnDefs, 'workspaces'), render: row => number(row.workspaces), cardRender: row => `${number(row.workspaces)} ${row.workspaces === 1 ? 'workspace' : 'workspaces'}` },
  { ...def(clusterColumnDefs, 'changed'), render: row => <At value={row.changedAt} />, cardRender: row => `changed ${when(row.changedAt)}` },
]
const kindText: Record<AbuseAlert['kind'], string> = { new: 'New', raised: 'Risk raised', grew: 'New member' }
// Stored: its post to Slack is queued, the one thing here still waiting on us (amber), or no webhook is set. Stale: it
// no longer needed a look before it was posted, so it never was; why stays shown. Not confirmed: Slack didn't answer
// either of its two posts, so it may be in the channel (amber, never Sent's green). Failed: Slack refused it (red).
const statusText: Record<Exclude<AbuseAlert['status'], 'stale'>, string> = { stored: 'Queued', sent: 'Sent', failed: 'Failed', unconfirmed: 'Not confirmed' }
const staleText: Record<NonNullable<AbuseAlert['staleReason']>, string> = { cluster_gone: 'Stale: cluster gone', band_dropped: 'Stale: risk dropped', reviewed: 'Stale: reviewed', expired: 'Stale: expired' }
const statusTones: Record<AbuseAlert['status'], Tone> = { stored: 'warning', sent: 'success', failed: 'danger', stale: 'neutral', unconfirmed: 'warning' }
const deliveryText = (row: AbuseAlert, posting: boolean) => row.status === 'stale' ? staleText[row.staleReason ?? 'expired'] : row.status !== 'stored' ? statusText[row.status] : posting ? 'Queued' : 'Not posted'
const reviewText: Record<AbuseReview['action'], string> = { watch: 'Watched', dismiss: 'Dismissed' }
// When, in a tooltip; who, as a masked address where it shows (never in a tooltip, which can't mask it).
const reviewTitle = (review: AbuseReview) => `${reviewText[review.action]} ${when(review.at)}`
const alertTitle = (row: AbuseAlert) => `${bandLabel[row.band]} risk · ${kindText[row.kind]} · ${row.score}`
// On a phone the card's title is the level and score, and the kind moves to the line below, so the status beside the
// title ("Stale: risk dropped") never cuts the score off.
const alertCardTitle = (row: AbuseAlert) => `${bandLabel[row.band]} risk · ${row.score}`
// The alert's name opens its card; on a phone the whole card does.
const alertColumns = (open: (row: AbuseAlert) => void, posting: boolean): Column<AbuseAlert>[] => [
  { ...def(alertColumnDefs, 'alert'), render: row => <button type="button" className="op-reason" onClick={event => { event.stopPropagation(); open(row) }}>{alertTitle(row)}</button>, cardRender: alertCardTitle },
  { ...def(alertColumnDefs, 'status'), render: row => row.review ? <span title={reviewTitle(row.review)}><StatusBadge status={reviewText[row.review.action]} tone="neutral" /></span> : <StatusBadge status={deliveryText(row, posting)} tone={statusTones[row.status]} /> },
  { ...def(alertColumnDefs, 'workspaces'), render: row => number(row.workspaces), cardRender: row => `${kindText[row.kind]} · ${number(row.workspaces)} ${row.workspaces === 1 ? 'workspace' : 'workspaces'}` },
  { ...def(alertColumnDefs, 'created'), render: row => <At value={row.createdAt} /> },
]

/** The Abuse tab of /operator: a facet rail (risk levels, the outbox) beside the clusters or the alerts. */
export function AbuseView() {
  const [params, setParams] = useSearchParams()
  const view = abuseView(params.toString())
  const set = (change: (next: URLSearchParams) => void) => setParams(previous => { const next = new URLSearchParams(previous); change(next); return next }, { replace: true })
  const clusters = useInfiniteQuery({
    queryKey: ['operator', 'abuse', 'clusters', view.band], initialPageParam: undefined as string | undefined, placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) => operatorApi.abuseClusters({ band: view.band ?? undefined, cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const first = clusters.data?.pages[0], rows = (clusters.data?.pages ?? []).flatMap(page => page.items)
  const groups = abuseFacets({ ...view, counts: first?.counts, outbox: first?.alerts,
    onBand: band => set(next => { next.set('view', 'abuse'); next.delete('show'); if (band) next.set('band', band); else next.delete('band') }),
    onAlerts: () => set(next => { next.set('view', 'abuse'); next.delete('band'); next.set('show', 'alerts') }),
    onLists: () => set(next => { next.set('view', 'lists'); next.delete('band'); next.delete('show') }) })
  return <SplitPane className="op-abuse" collapse="row" rail={<FacetRail label="Abuse views" groups={groups} />}>
    {view.lists ? <ListsView /> : view.alerts ? <Alerts /> : clusters.isError && !clusters.data ? <ErrorState error={clusters.error} onRetry={() => void clusters.refetch()} /> : <>
      <DataTable loading={clusters.isPending} skeletonRows={6} rows={rows} rowKey={row => row.id} rowHref={row => `/operator/abuse/${row.id}`} columns={clusterColumns}
        empty={<EmptyState title={first && !first.monitoring ? 'Abuse monitoring is off' : view.band ? `No ${bandLabel[view.band].toLowerCase()}-risk clusters` : 'No related accounts found'} action={view.band ? <Button onClick={() => set(next => next.delete('band'))}>Show all</Button> : undefined} />} />
      <InfiniteMore query={clusters} />
    </>}
  </SplitPane>
}

// The outbox: each alert with the Slack card it posted, or would post once a webhook is set.
function Alerts() {
  const alerts = useInfiniteQuery({
    queryKey: ['operator', 'abuse', 'alerts'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.abuseAlerts({ cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (alerts.data?.pages ?? []).flatMap(page => page.items), delivery = alerts.data?.pages[0]?.delivery
  const [shown, setShown] = useState<AbuseAlert | null>(null)
  if (alerts.isError && !alerts.data) return <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
  return <>
    <DataTable loading={alerts.isPending} skeletonRows={6} rows={rows} rowKey={row => row.id} onRowClick={setShown} columns={alertColumns(setShown, delivery === 'slack')} empty={<EmptyState title="No alerts yet" />} />
    <InfiniteMore query={alerts} />
    {shown && <Dialog open onOpenChange={next => { if (!next) setShown(null) }} title="Slack card" footer={<><Button onClick={() => setShown(null)}>Close</Button><Link className="ui-button ui-button--primary ui-button--md" to={`/operator/abuse/${shown.clusterId}`}>Open cluster</Link></>}>
      {shown.status === 'unconfirmed' && <Alert tone="warning">Slack didn’t answer either post in time, so this card may be in the channel once or twice, or not at all. Check the channel.</Alert>}
      <SlackPreview card={shown.payload} />
    </Dialog>}
  </>
}
// Slack's mrkdwn as the cards use it: *bold*, `code`, line breaks and the level's mark (:mag: review, :rotating_light: high).
const slackEmoji: Record<string, string> = { mag: '🔍', rotating_light: '🚨' }
function mrkdwn(text: string): ReactNode[] {
  return text.replace(/:([a-z_]+):/g, (code, name: string) => slackEmoji[name] ?? code).split('\n').flatMap((line, i) => [i > 0 ? <br key={`br${i}`} /> : null, ...line.split(/(\*[^*]+\*|`[^`]+`)/).filter(Boolean).map((part, j) =>
    part.startsWith('*') ? <strong key={`${i}:${j}`}>{part.slice(1, -1)}</strong> : part.startsWith('`') ? <code key={`${i}:${j}`}>{part.slice(1, -1)}</code> : part)])
}
/** The card as Slack lays it out: a heading, fields two to a row, sections, its buttons (as their labels) and a footnote. */
export function SlackPreview({ card }: { card: SlackCard }) {
  return <div className="op-slack">{card.blocks.map((block, i) => block.type === 'header' ? <p key={i} className="op-slack__header">{block.text?.text}</p>
    : block.type === 'section' && block.fields ? <dl key={i} className="op-slack__fields">{block.fields.map((field, j) => <div key={j}>{mrkdwn(field.text)}</div>)}</dl>
    : block.type === 'section' ? <p key={i}>{mrkdwn(block.text?.text ?? '')}</p>
    : block.type === 'actions' ? <p key={i} className="op-slack__actions">{(block.elements ?? []).map((element, j) => <span key={j} title={element.url}>{typeof element.text === 'string' ? element.text : element.text?.text}</span>)}</p>
    : block.type === 'context' ? <p key={i} className="op-slack__context">{(block.elements ?? []).map(element => typeof element.text === 'string' ? element.text : element.text?.text).join(' ')}</p> : null)}</div>
}

// ---------------------------------------------------------------- one cluster

type Pending = { kind: 'pause' | 'limit'; workspace: AbuseWorkspace; key: string }
export function OperatorClusterPage() {
  const role = useSession()?.identity?.operator ?? null
  const id = useParams().id ?? ''
  const detail = useQuery({ queryKey: ['operator', 'abuse', 'cluster', id], queryFn: ({ signal }) => operatorApi.abuseCluster(id, signal), enabled: Boolean(role && id) })
  // The cluster's latest alert, which Slack links here: what Watch and Dismiss decide on.
  const alerts = useQuery({ queryKey: ['operator', 'abuse', 'alerts', id], queryFn: ({ signal }) => operatorApi.abuseAlerts({ cluster: id, limit: 1 }, signal), enabled: Boolean(role && id) })
  const alert = alerts.data ? { alert: alerts.data.items[0] ?? null, posting: alerts.data.delivery === 'slack' } : undefined
  const [action, setAction] = useState<Pending | null>(null)
  if (!role) return <StaffOnly />
  return <>
    <PageHeader title="Related accounts" backTo="/operator?view=abuse" actions={role === 'operator' ? <ReviewActions alert={alert?.alert} /> : undefined} />
    <SplitPane className="op-cluster" rail={<ClusterRail current={id} />}>
      {detail.data ? <ClusterBody cluster={detail.data} alert={alert} canAct={role === 'operator'} onAct={(kind, workspace) => setAction({ kind, workspace, key: crypto.randomUUID() })} />
        : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <ClusterBodySkeleton />}
    </SplitPane>
    <ActionDialog action={action} cluster={id} onClose={() => setAction(null)} />
  </>
}
// Watch (reviewed: alert again only at a higher risk) or Dismiss (not abuse: alert again only with new members or
// reasons) the cluster's latest alert; Pause is on each workspace. Disabled while it loads, without an alert, and for
// the decision already taken.
function ReviewActions({ alert }: { alert: AbuseAlert | null | undefined }) {
  const client = useQueryClient(), toast = useToast()
  const mutation = useMutation({
    mutationFn: (action: AbuseReview['action']) => operatorApi.abuseReview(alert!.id, action),
    onSuccess: (_, action) => { toast(action === 'watch' ? 'Alert watched' : 'Alert dismissed', 'success'); void client.invalidateQueries({ queryKey: ['operator', 'abuse'] }) },
    onError: error => toast(errorText(error), 'error'),
  })
  const titles = { watch: 'Reviewed: alert again only at a higher risk', dismiss: 'Not abuse: alert again only with new members or reasons' }
  return <>{(['watch', 'dismiss'] as const).map((action, i) => <Button key={action} title={titles[action]} disabled={!alert || alert.review?.action === action || mutation.isPending}
    loading={mutation.isPending && mutation.variables === action} onClick={() => mutation.mutate(action)}>{reviewActions[i]}</Button>)}</>
}
// The other clusters, highest risk first, to step through without going back to the list.
function ClusterRail({ current }: { current: string }) {
  const list = useQuery({ queryKey: ['operator', 'abuse', 'rail'], queryFn: ({ signal }) => operatorApi.abuseClusters({ limit: 30 }, signal) })
  if (!list.data) return list.isError ? null : <ClusterRailSkeleton />
  return <ul className="op-cluster-rail" aria-label="Clusters">{list.data.items.map(cluster => <li key={cluster.id}>
    <Link className="op-cluster-rail__row" to={`/operator/abuse/${cluster.id}`} aria-current={cluster.id === current ? 'page' : undefined} replace>
      <Risk band={cluster.band} score={cluster.score} /><span className="op-cell op-cluster-rail__why">{cluster.reasons.length ? reasonText([...cluster.reasons].sort((a, b) => b.points - a.points)[0]!) : ''}</span>
    </Link></li>)}{list.data.nextCursor && <li><Link className="op-cluster-rail__row muted" to="/operator?view=abuse">More clusters…</Link></li>}</ul>
}

const planLabel: Record<AbuseWorkspace['plan'], string> = { free: 'Free', paid: 'Paid', exempt: 'Not billed' }
const use = (value: { used: number; limit: number }) => `${number(value.used)} / ${number(value.limit)}`
function ClusterBody({ cluster, alert, canAct, onAct }: { cluster: AbuseClusterDetail; alert?: { alert: AbuseAlert | null; posting: boolean }; canAct: boolean; onAct: (kind: Pending['kind'], workspace: AbuseWorkspace) => void }) {
  const navigate = useNavigate(), latest = alert?.alert
  const facts: Record<(typeof clusterFacts)[number], ReactNode> = {
    Risk: <StatusBadge status={bandLabel[cluster.band]} tone={bandTone[cluster.band]} />, Score: `${cluster.score} · peak ${cluster.peak}`, Accounts: number(cluster.accounts.length), Workspaces: number(cluster.workspaces.length),
    'First seen': <span title={when(cluster.firstAt)}>{shortDateTime(isoTime(cluster.firstAt))}</span>, Changed: <span title={when(cluster.changedAt)}>{shortDateTime(isoTime(cluster.changedAt))}</span>,
    Alert: !alert ? <Skeleton width={88} height={14} /> : latest ? <span className="op-cell" title={when(latest.sentAt ?? latest.createdAt)}>{bandLabel[latest.band]} · {deliveryText(latest, alert.posting)}</span> : '—',
    Review: !alert ? <Skeleton width={88} height={14} /> : latest?.review ? <><span title={reviewTitle(latest.review)}>{reviewText[latest.review.action]}</span>{latest.review.by && <><span className="op-review-by">·</span><PrivateAddress value={latest.review.by} /></>}</> : latest ? 'Open' : '—',
  }
  const workspaceColumns: Column<AbuseWorkspace>[] = [
    { ...def(clusterWorkspaceColumnDefs, 'name'), render: w => <span className="op-ws" title={`${w.name} · ${w.id}`}><Link className="op-cell" to={`/operator/workspaces/${encodeURIComponent(w.id)}`}>{w.name}</Link><span className="op-muted-id">{w.id}</span></span>, cardRender: w => w.name },
    { ...def(clusterWorkspaceColumnDefs, 'account'), render: w => <span className="op-muted-id">{w.account ?? '—'}</span> },
    { ...def(clusterWorkspaceColumnDefs, 'plan'), render: w => planLabel[w.plan] },
    { ...def(clusterWorkspaceColumnDefs, 'sent'), render: w => use(w.sent), cardRender: w => `Sent ${use(w.sent)}` },
    { ...def(clusterWorkspaceColumnDefs, 'received'), render: w => use(w.received), cardRender: w => `Received ${use(w.received)}` },
    { ...def(clusterWorkspaceColumnDefs, 'step'), render: w => w.step ? <StepBadge step={w.step} /> : <span className="muted">{w.sending === 'shared' ? 'Not graded' : w.sending === 'byo' ? 'Own AWS' : 'Not sending'}</span> },
    { ...def(clusterWorkspaceColumnDefs, 'actions'), render: w => {
      const items: MenuItem[] = [{ label: 'Open workspace', onSelect: () => navigate(`/operator/workspaces/${encodeURIComponent(w.id)}`) },
        ...(canAct && w.sending === 'shared' ? [...(w.paused ? [] : [{ label: 'Pause sending…', destructive: true, onSelect: () => onAct('pause', w) }]), { label: 'Set daily limit…', onSelect: () => onAct('limit', w) }] : [])]
      return <DropdownMenu label={`Actions for ${w.name}`} title={w.name} items={items} />
    } },
  ]
  const accountColumns: Column<AbuseAccount>[] = [
    { ...def(clusterAccountColumnDefs, 'key'), render: a => <span className="op-muted-id">{a.key}</span> },
    { ...def(clusterAccountColumnDefs, 'who'), render: a => a.kind === 'refused' ? <span className="muted">Refused sign-in</span> : a.email ? <span className="op-email"><PrivateAddress value={a.email} /></span> : <span className="op-cell">{a.name ?? 'User'}</span> },
    { ...def(clusterAccountColumnDefs, 'user'), render: a => a.userId ? <span className="op-muted-id op-cell" title={a.userId}>{a.userId}</span> : '—', cardRender: a => a.userId ?? 'Never admitted' },
  ]
  const reasons = [...cluster.reasons].sort((a, b) => b.points - a.points), shared = cluster.links.filter(link => !link.owner)
  return <div className="op-page">
    <dl className="op-facts op-facts--four">{clusterFacts.map(title => <div key={title}><dt>{title}</dt><dd>{facts[title]}</dd></div>)}</dl>
    <div className="op-grid">
      <section className="op-section" aria-labelledby="op-why"><SectionHeader title={<span id="op-why">Why</span>} />
        <ul className="op-why">{reasons.map(reason => <li key={reason.code}><span className="op-cell" title={reason.code}>{reasonText(reason)}</span><span className="op-why__count">{reason.count === undefined ? '' : `× ${number(reason.count)}`}</span><span className="op-why__points">+{reason.points}</span></li>)}</ul>
      </section>
      <section className="op-section" aria-labelledby="op-links"><SectionHeader title={<span id="op-links">Links</span>} />
        <ClusterGraph cluster={cluster} />
        <ul className="op-links">{shared.slice(0, 12).map(link => <li key={`${link.a}|${link.b}`}><span className="op-muted-id">{nodeName(cluster, link.a)} ↔ {nodeName(cluster, link.b)}</span>
          <span className="op-cell" title={linkText(link)}>{linkText(link)}</span></li>)}{shared.length > 12 && <li className="muted">and {number(shared.length - 12)} more</li>}</ul>
      </section>
    </div>
    <section className="op-section"><SectionHeader title="Workspaces" /><DataTable rows={cluster.workspaces} rowKey={w => w.id} columns={workspaceColumns} empty={<EmptyState title="No workspaces" />} /></section>
    <section className="op-section"><SectionHeader title="Accounts" /><DataTable rows={cluster.accounts} rowKey={a => a.key} columns={accountColumns} empty={<EmptyState title="No accounts" />} /></section>
  </div>
}
const nodeName = (cluster: AbuseClusterDetail, key: string) => cluster.workspaces.find(w => w.id === key)?.name ?? key
const linkText = (link: AbuseLink) => label(link.kinds.map(kind => `same ${kindLabel[kind.kind] ?? kind.kind}${kind.shared > 1 ? ` × ${kind.shared}` : ''}`).join(', ')) + (link.strength === 'partial' ? ' (weak)' : '')

// The cluster as a drawing: accounts on the left, workspaces on the right. A solid line is ownership, a dark one a link
// strong enough to join the two, a dashed one a weaker link. The list under it says the same in words.
function ClusterGraph({ cluster }: { cluster: AbuseClusterDetail }) {
  const row = 30, pad = 18, width = 400, left = 56, right = 220
  const accounts = cluster.accounts.map((account, i) => ({ key: account.key, text: account.key, x: left, y: pad + i * row }))
  const workspaces = cluster.workspaces.map((workspace, i) => ({ key: workspace.id, text: workspace.name.length > 22 ? `${workspace.name.slice(0, 21)}…` : workspace.name, x: right, y: pad + i * row }))
  const at = new Map([...accounts, ...workspaces].map(node => [node.key, node])), height = Math.max(accounts.length, workspaces.length, 1) * row + pad
  return <div className="op-graph" style={{ height: Math.min(264, height) }}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${accounts.length} accounts and ${workspaces.length} workspaces, with what links them`} preserveAspectRatio="xMidYMid meet">
    {cluster.links.map(link => {
      const a = at.get(link.a), b = at.get(link.b)
      if (!a || !b) return null
      // Two nodes in one column are joined by an arc into the middle; across columns by a straight line.
      const bend = a.x === b.x ? (a.x === left ? 1 : -1) * Math.min(120, 28 + Math.abs(a.y - b.y) * .5) : 0
      return <path key={`${link.a}|${link.b}|${link.strength}`} className={`op-graph__edge op-graph__edge--${link.strength}`} d={bend ? `M${a.x} ${a.y} Q${a.x + bend} ${(a.y + b.y) / 2} ${b.x} ${b.y}` : `M${a.x} ${a.y} L${b.x} ${b.y}`} />
    })}
    {accounts.map(node => <g key={node.key}><circle className="op-graph__node" cx={node.x} cy={node.y} r={4} /><text className="op-graph__label" x={node.x - 12} y={node.y + 4} textAnchor="end">{node.text}</text></g>)}
    {workspaces.map(node => <g key={node.key}><rect className="op-graph__node" x={node.x - 4} y={node.y - 4} width={8} height={8} /><text className="op-graph__label" x={node.x + 12} y={node.y + 4}>{node.text}</text></g>)}
  </svg></div>
}

// Pause or a daily limit, from the cluster. The note is for staff: the workspace is told only that it followed a review.
const copy = { pause: { title: 'Pause sending?', confirm: 'Pause sending', done: 'Sending paused' }, limit: { title: 'Set the daily limit', confirm: 'Save limit', done: 'Limit saved' } }
function ActionDialog({ action, cluster, onClose }: { action: Pending | null; cluster: string; onClose: () => void }) {
  const shown = useShown(action)
  return <Dialog open={action !== null} onOpenChange={next => { if (!next) onClose() }} title={shown ? copy[shown.kind].title : ''}>
    {shown && <ActionForm key={shown.key} action={shown} cluster={cluster} onClose={onClose} />}
  </Dialog>
}
function ActionForm({ action, cluster, onClose }: { action: Pending; cluster: string; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const [note, setNote] = useState(''), [ticket, setTicket] = useState(''), [daily, setDaily] = useState(action.workspace.dailyLimit ? String(action.workspace.dailyLimit) : ''), [tried, setTried] = useState(false)
  const noteError = reasonCheck(note)
  const dailyValue = Number(daily), dailyError = action.kind === 'limit' && !(Number.isInteger(dailyValue) && dailyValue >= 1 && dailyValue <= 10_000_000) ? dailyLimitError : ''
  const mutation = useMutation({
    mutationFn: () => {
      const input = { cluster, note, ticketRef: ticket }, guard = { idempotencyKey: action.key }
      return action.kind === 'pause' ? operatorApi.abusePause(action.workspace.id, input, guard) : operatorApi.abuseLimit(action.workspace.id, { ...input, daily: dailyValue }, guard)
    },
    onSuccess: () => { toast(copy[action.kind].done, 'success'); void client.invalidateQueries({ queryKey: ['operator'] }); onClose() },
  })
  function submit(event: FormEvent) { event.preventDefault(); setTried(true); if (!noteError && !dailyError) mutation.mutate() }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    {action.kind === 'limit' && <Field label="Daily limit" error={tried ? dailyError : ''}><Input type="number" inputMode="numeric" min={1} max={10_000_000} step={1} value={daily} onChange={event => setDaily(event.target.value)} /></Field>}
    <Field label="Note for the staff audit" error={tried ? noteError : ''}><Textarea value={note} maxLength={1000} onChange={event => setNote(event.target.value)} /></Field>
    <Field label="Ticket ID or URL"><Input value={ticket} maxLength={200} onChange={event => setTicket(event.target.value)} /></Field>
    <MutationError error={mutation.error} />
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant={action.kind === 'pause' ? 'danger' : 'primary'} loading={mutation.isPending}>{copy[action.kind].confirm}</Button></div>
  </form>
}
