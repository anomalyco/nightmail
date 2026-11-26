import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Checkbox, ControlSkeleton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, PageHeader, SectionHeader, Select, SkeletonText, StatusBadge, Switch, Tabs, Textarea, useToast, type Column, type MenuItem, type Tone, ErrorText, MutationError } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSession } from '../../data/context'
import { ApiError, type SenderScoreFactor, type StandingReason, type StandingStep } from '../../data/types'
import { isoTime, operatorApi, type OperatorAction, type OperatorCampaign, type OperatorDomain, type OperatorMember, type OperatorQueueItem, type OperatorTimelineItem, type OperatorWorkspace, type SignupPlaces, type SignupRaise, type TimelineKind, type WaitlistEntry, type WorkspaceSummary } from '../../data/operator'
import { label, number, shortDateTime } from '../../lib/format'
import { downloadCsvChunks, formatCsvRow } from '../../lib/download'
import { errorText } from '../../data/types'
import { factorFormats } from '../score'
import { actionColumnDefs, ActionsTrigger, dailyLimitError, campaignColumnDefs, domainColumnDefs, factorColumnDefs, facts, memberColumnDefs, operatorView, useOperatorTabs, OperatorWorkspaceSkeleton, StaffOnly, QueueToolbar, queueColumnDefs, SetLimitTrigger, SignupFacts, signupColumnDefs, timelineColumnDefs, waitlistColumnDefs, WaitlistToolbar } from './skeletons'
import { useDebounced } from '../../lib/pagination'
import { AbuseView } from './abuse'
import { ListsView } from './lists'
import { HealthView } from './health'

// The operator console (lazy, /operator): Nightmail staff with a platform role review flagged Hosted workspaces and act on
// them through the audited operator API. Impersonation-free: it reads standing, score, limits and evidence, never
// message bodies, and every address is masked. `operator:read` sees everything and changes nothing.
// UI notes (/operator/notes) live in ./notes and load with this chunk.
export { OperatorNotesPage } from './notes'
export { OperatorClusterPage } from './abuse'
export { GlassPage } from './glass'
const useOperatorRole = () => useSession()?.identity?.operator ?? null
const NotFound = StaffOnly
const def = (defs: typeof queueColumnDefs, key: string) => defs.find(column => column.key === key)!
const when = (value: string | null | undefined) => value ? `${shortDateTime(isoTime(value))} UTC` : '—'
const At = ({ value }: { value: string | null | undefined }) => <span className="nowrap">{when(value)}</span>
const stepTone: Record<StandingStep, Tone> = { ok: 'success', notice: 'neutral', warn: 'warning', restrict: 'warning', pause: 'danger' }
const stepLabel: Record<StandingStep, string> = { ok: 'Good', notice: 'Notice', warn: 'Warn', restrict: 'Restrict', pause: 'Pause' }
const StepBadge = ({ step }: { step: StandingStep }) => <StatusBadge status={stepLabel[step]} tone={stepTone[step]} />


export function OperatorPage() {
  const role = useOperatorRole()
  const [params, setParams] = useSearchParams()
  const view = operatorView(params.toString())
  const navigate = useNavigate(), tabs = useOperatorTabs(), identity = useSession()?.identity
  // A self-hosted installation has no operator area: this address is its Health page, for anyone signed in.
  if (!role && identity && identity.multiTenant !== true) return <><PageHeader title="Health" /><div className="op-page"><HealthView /></div></>
  if (!role) return <NotFound />
  return <>
    <PageHeader title="Operator" actions={view === 'signups' && role === 'operator' ? <SetLimit /> : undefined} />
    <div className="op-page">
      <Tabs value={view} label="Operator views" items={tabs} onValueChange={value => value === 'notes' ? navigate('/operator/notes') : setParams(previous => { const next = new URLSearchParams(previous); next.delete('band'); next.delete('show'); if (value === 'queue') next.delete('view'); else next.set('view', value); return next }, { replace: true })} />
      {view === 'queue' ? <Queue /> : view === 'signups' ? <Signups /> : view === 'abuse' ? <AbuseView /> : view === 'lists' ? <ListsView /> : view === 'waitlist' ? <Waitlist /> : view === 'health' ? <HealthView /> : <Actions />}
    </div>
  </>
}

// Sign-ups: how many accounts may sign up on their own (api/src/signups.ts), what fills that, and every workspace with
// what judging it needs: when it joined, its owner, a verified domain, what it sent and its standing.
const useSignupPlaces = () => useQuery({ queryKey: ['operator', 'signups'], queryFn: ({ signal }) => operatorApi.signups(signal) })
const standingText: Record<StandingStep, string> = { ok: 'Good', notice: 'Notice', warn: 'Warned', restrict: 'Restricted', pause: 'Paused' }
const signupColumns: Column<WorkspaceSummary>[] = [
  { ...def(signupColumnDefs, 'name'), render: row => <span className="op-ws" title={`${row.name} · ${row.id}`}><span className="op-cell">{row.name}</span><span className="op-muted-id">{row.id}</span></span>, cardRender: row => row.name },
  { ...def(signupColumnDefs, 'owner'), render: row => row.owner ? <span className="op-email"><PrivateAddress value={row.owner} /></span> : <span className="muted">—</span>, cardRender: row => row.owner ? <PrivateAddress value={row.owner} /> : 'No owner' },
  { ...def(signupColumnDefs, 'joined'), render: row => <At value={row.createdAt} />, cardRender: row => `joined ${when(row.createdAt)}` },
  { ...def(signupColumnDefs, 'domain'), render: row => row.domain ? <span className="op-cell" title={row.domain}>{row.domain}{row.domains > 1 && <span className="muted">{` +${row.domains - 1}`}</span>}</span> : <span className="muted">None</span>,
    cardRender: row => row.domain ? `${row.domain}${row.domains > 1 ? ` +${row.domains - 1}` : ''}` : 'No verified domain' },
  { ...def(signupColumnDefs, 'sent'), render: row => number(row.sent), cardRender: row => `${number(row.sent)} sent` },
  { ...def(signupColumnDefs, 'standing'), render: row => !row.standing ? <span className="muted">—</span> : <span className={row.standing === 'ok' ? 'muted' : undefined}>{standingText[row.standing]}</span> },
]
function Signups() {
  const query = useSignupPlaces(), places = query.data, unknown = query.isError && !places
  const list = useInfiniteQuery({
    queryKey: ['operator', 'signups', 'workspaces'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.allWorkspaces({ cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (list.data?.pages ?? []).flatMap(page => page.items)
  return <>
    <SignupFacts values={places ? { 'Signed up': `${number(places.signedUp)} of ${number(places.limit)}`, 'Held for the waitlist': number(places.held), Open: number(places.open), Waiting: number(places.waiting) }
      : unknown ? { 'Signed up': '—', 'Held for the waitlist': '—', Open: '—', Waiting: '—' } : undefined} />
    {list.isError && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <>
      <DataTable className="op-table" loading={list.isPending} skeletonRows={6} rows={rows} rowKey={row => row.id} columns={signupColumns}
        rowHref={row => row.standing ? `/operator/workspaces/${encodeURIComponent(row.id)}` : undefined} empty={<EmptyState title="No workspaces yet" />} />
      {list.hasNextPage && <Button className="op-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
      {list.isError && list.data && <Alert tone="danger"><ErrorText error={list.error} /></Alert>}
    </>}
  </>
}
// One number. A raise holds its places for the oldest on the waitlist, or opens them to anyone; lowering it removes no
// one. The change is audited.
function SetLimit() {
  const places = useSignupPlaces().data
  const [key, setKey] = useState<string | null>(null)
  // The form decides on the places as they were when it opened, and keeps them while the dialog closes.
  const shown = useRef<{ key: string; places: SignupPlaces } | null>(null)
  if (key && places && shown.current?.key !== key) shown.current = { key, places }
  return <>
    <SetLimitTrigger disabled={!places} onClick={() => setKey(crypto.randomUUID())} />
    <Dialog open={key !== null} onOpenChange={next => { if (!next) setKey(null) }} title="Set the sign-up limit"
      description={shown.current && `${number(shown.current.places.signedUp)} signed up · ${number(shown.current.places.held)} held · ${number(shown.current.places.open)} open · ${number(shown.current.places.waiting)} waiting`}>
      {shown.current && <SignupLimitForm key={shown.current.key} idempotencyKey={shown.current.key} places={shown.current.places} onClose={() => setKey(null)} />}
    </Dialog>
  </>
}
function SignupLimitForm({ places, idempotencyKey, onClose }: { places: SignupPlaces; idempotencyKey: string; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const [value, setValue] = useState(String(places.limit)), [raise, setRaise] = useState<SignupRaise>('hold'), [tried, setTried] = useState(false)
  const limit = Number(value), error = value.trim() === '' || !(Number.isInteger(limit) && limit >= 0 && limit <= 1_000_000) ? 'A whole number from 0 to 1,000,000.' : ''
  // As api/src/signups.ts setLimit: a hold raise holds the places it adds, as far as the waitlist goes; an open one holds none.
  const raising = !error && limit > places.limit, added = raising ? Math.min(limit - places.limit, Math.max(0, limit - places.signedUp - places.held)) : 0
  // Only a raise has new places; any other save is sent as hold, so it still retries the emails an earlier save missed.
  const sent: SignupRaise = raising ? raise : 'hold'
  const letIn = sent === 'hold' ? Math.min(places.waiting, added) : 0, opened = added - letIn
  const hint = error ? '' : limit < places.limit ? 'Lowering it removes no one.'
    : [letIn && `Holds ${number(letIn)} for the oldest waiting and emails them.`, opened && `Opens ${number(opened)} to anyone, first come, no emails.`].filter(Boolean).join(' ')
  const mutation = useMutation({
    mutationFn: () => operatorApi.setSignupLimit(limit, sent, { idempotencyKey }),
    // Everyone held is emailed once; one a failure missed is said here, and saving again emails it.
    onSuccess: saved => {
      const missed = sent === 'hold' ? saved.notEmailed ?? 0 : 0
      toast(sent === 'open' ? `Limit saved. ${number(saved.open)} open to anyone.` : missed ? `Limit saved. ${number(missed)} held ${missed === 1 ? 'address isn’t' : 'addresses aren’t'} emailed yet: save again to retry.`
        : saved.emailed ? `Limit saved. ${number(saved.emailed)} emailed that they can sign in.` : 'Limit saved', missed ? 'error' : 'success')
      void client.invalidateQueries({ queryKey: ['operator'] }); onClose()
    },
  })
  function submit(event: FormEvent) { event.preventDefault(); setTried(true); if (!error) mutation.mutate() }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    <Field label="Places" error={tried ? error : ''} hint={hint}><Input type="number" inputMode="numeric" min={0} max={1_000_000} step={1} autoFocus value={value} onChange={event => setValue(event.target.value)} /></Field>
    <Field label="New places" htmlFor="signup-raise"><Select id="signup-raise" value={raise} disabled={!raising} onValueChange={next => setRaise(next as SignupRaise)}
      options={[{ value: 'hold', label: 'Hold for the waitlist' }, { value: 'open', label: 'Open to anyone' }]} /></Field>
    <MutationError error={mutation.error} />
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={mutation.isPending}>Save limit</Button></div>
  </form>
}

const flags = (row: OperatorQueueItem) => [row.paused && 'paused', row.quarantined > 0 && `${row.quarantined} quarantined`, row.watch && 'watched', row.strikes > 0 && `${row.strikes} ${row.strikes === 1 ? 'strike' : 'strikes'}`].filter(Boolean).join(' · ')
const queueColumns: Column<OperatorQueueItem>[] = [
  { ...def(queueColumnDefs, 'name'), render: row => <span className="op-ws" title={`${row.name} · ${row.workspaceId}`}><span className="op-cell">{row.name}</span><span className="op-muted-id">{row.workspaceId}</span></span>, cardRender: row => row.name },
  { ...def(queueColumnDefs, 'step'), render: row => <StepBadge step={row.step} /> },
  { ...def(queueColumnDefs, 'reason'), render: row => <span className="op-cell" title={row.reasons.map(reason => reason.message).join('\n')}>{flags(row) && <span className="op-flags">{flags(row)} · </span>}{row.reasons[0]?.message ?? '—'}</span> },
  { ...def(queueColumnDefs, 'score'), render: row => row.score === null ? '—' : row.score.toFixed(1), cardRender: row => row.score === null ? 'Calibrating' : `Score ${row.score.toFixed(1)}` },
  { ...def(queueColumnDefs, 'limit'), render: row => row.dailyLimit === null ? 'None' : number(row.dailyLimit), cardRender: row => row.dailyLimit === null ? 'No daily limit' : `${number(row.dailyLimit)}/day` },
  { ...def(queueColumnDefs, 'since'), render: row => <At value={row.since} />, cardRender: row => `since ${when(row.since)}` },
]
function Queue() {
  const [search, setSearch] = useState('')
  const [step, setStep] = useState('')
  const q = useDebounced(search.trim())
  const queue = useQuery({ queryKey: ['operator', 'queue', q ? '' : step, q], queryFn: ({ signal }) => operatorApi.queue({ q: q || undefined, step: q ? undefined : step as StandingStep || undefined }, signal), placeholderData: previous => previous })
  return <>
    <QueueToolbar search={search} step={step} onSearch={setSearch} onStep={setStep} />
    {queue.isError && !queue.data ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      : <>
        <DataTable className="op-table" loading={queue.isPending} skeletonRows={6} rows={queue.data ?? []} rowKey={row => row.workspaceId} rowHref={row => `/operator/workspaces/${encodeURIComponent(row.workspaceId)}`}
          empty={<EmptyState title={q ? 'No workspace matches' : 'Nothing to review'} action={q ? <Button onClick={() => setSearch('')}>Clear search</Button> : undefined} />} columns={queueColumns} />
        {(queue.data?.length ?? 0) >= 200 && <p className="op-total muted">Showing first 200 workspaces — filter by standing or search to narrow.</p>}
      </>}
  </>
}

const actionLabel = (row: OperatorAction) => row.action === 'operator-set-signup-limit' ? 'Set sign-up limit' : label(row.action.replace(/^operator-/, '').replaceAll('-', '_'))
// 'platform' is no workspace: an operator role, a person's billing or the sign-up limit.
const actionWorkspace = (row: OperatorAction) => row.workspaceId === 'platform' ? <span className="muted">—</span> : <Link to={`/operator/workspaces/${encodeURIComponent(row.workspaceId)}`} className="op-muted-id">{row.workspaceId}</Link>
// What a change without a reason changed, from its before and after: the sign-up limit's old and new number.
const actionReason = (row: OperatorAction) => {
  const from = record(row.before).limit, to = record(row.after).limit
  return row.reason ?? (row.action === 'operator-set-signup-limit' && typeof from === 'number' && typeof to === 'number' ? `${number(from)} → ${number(to)}` : null)
}
const actionColumns: Column<OperatorAction>[] = [
  { ...def(actionColumnDefs, 'action'), render: actionLabel },
  { ...def(actionColumnDefs, 'at'), render: row => <At value={row.at} /> },
  { ...def(actionColumnDefs, 'workspace'), render: actionWorkspace },
  { ...def(actionColumnDefs, 'reason'), render: row => { const reason = actionReason(row); return <span className="op-cell" title={reason ?? undefined}>{reason ?? '—'}</span> } },
  { ...def(actionColumnDefs, 'ticket'), render: row => <span className="op-cell">{row.ticketRef ?? '—'}</span>, cardRender: row => row.ticketRef ? `Ticket ${row.ticketRef}` : row.via ?? '' },
]
// A table row's whole story, for what a cell cuts short (a phone has no hover to show it).
function DetailDialog({ title, rows, onClose }: { title: string; rows: [string, ReactNode][]; onClose: () => void }) {
  return <Dialog open onOpenChange={next => { if (!next) onClose() }} title={title} footer={<Button onClick={onClose}>Close</Button>}>
    <Rows rows={rows.filter(([, value]) => value !== null && value !== '')} />
  </Dialog>
}
function Actions() {
  const actions = useInfiniteQuery({
    queryKey: ['operator', 'actions'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.actions({ cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (actions.data?.pages ?? []).flatMap(page => page.items)
  const [shown, setShown] = useState<OperatorAction | null>(null)
  return <>
    {actions.isError && !actions.data ? <ErrorState error={actions.error} onRetry={() => void actions.refetch()} /> : <>
      <DataTable className="op-table" loading={actions.isPending} skeletonRows={6} rows={rows} rowKey={row => `${row.at}:${row.workspaceId}:${row.action}:${row.requestId ?? ''}`} onRowClick={setShown} empty={<EmptyState title="No operator actions yet" />} columns={actionColumns} />
      {actions.hasNextPage && <Button className="op-more" loading={actions.isFetchingNextPage} onClick={() => void actions.fetchNextPage()}>Load more</Button>}
      {actions.isError && actions.data && <Alert tone="danger"><ErrorText error={actions.error} /></Alert>}
    </>}
    {shown && <DetailDialog title={actionLabel(shown)} onClose={() => setShown(null)} rows={[
      ['When', when(shown.at)], ['By', shown.operatorEmail ? <PrivateAddress value={shown.operatorEmail} /> : shown.operatorId], ['Workspace', shown.workspaceId === 'platform' ? null : <Link to={`/operator/workspaces/${encodeURIComponent(shown.workspaceId)}`}>{shown.workspaceId}</Link>],
      ['Reason', actionReason(shown)], ['Ticket', shown.ticketRef], ['Via', shown.via], ['Request', shown.requestId ? <span className="op-muted-id">{shown.requestId}</span> : null],
    ]} />}
  </>
}

// The waitlist: verified sign-ins nothing admitted yet, to email when Nightmail opens. Addresses are masked like every
// other; the CSV export has them in full. Let in: a raise of the sign-up limit holds a place for it, and emails it.
const emailedText = { sent: 'emailed', queued: 'email queued', failed: 'email failed' } as const
const letInText = (row: WaitlistEntry) => `${when(row.letInAt)} · ${row.emailed ? emailedText[row.emailed] : 'not emailed'}`
const waitlistColumns: Column<WaitlistEntry>[] = [
  { ...def(waitlistColumnDefs, 'email'), render: row => <span className="op-email"><PrivateAddress value={row.email} /></span> },
  { ...def(waitlistColumnDefs, 'name'), render: row => <span className="op-cell" title={row.name ?? undefined}>{row.name || '—'}</span>, cardRender: row => row.name || 'No name' },
  { ...def(waitlistColumnDefs, 'first'), render: row => <At value={row.firstAt} />, cardRender: row => `first ${when(row.firstAt)}` },
  { ...def(waitlistColumnDefs, 'last'), render: row => <At value={row.lastAt} /> },
  { ...def(waitlistColumnDefs, 'attempts'), render: row => number(row.attempts), cardRender: row => `${number(row.attempts)} ${row.attempts === 1 ? 'attempt' : 'attempts'}` },
  { ...def(waitlistColumnDefs, 'letIn'), render: row => row.letInAt ? <span className="op-cell" title={letInText(row)}>{letInText(row)}</span> : <span className="muted">—</span>, cardRender: row => row.letInAt ? `Let in ${letInText(row)}` : 'Waiting' },
]
function Waitlist() {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim())
  const list = useInfiniteQuery({
    queryKey: ['operator', 'waitlist', q], initialPageParam: undefined as string | undefined, placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) => operatorApi.waitlist({ q: q || undefined, cursor: pageParam }, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (list.data?.pages ?? []).flatMap(page => page.items), total = list.data?.pages[0]?.total
  const [exporting, setExporting] = useState(false)
  // Bound browser CSV export to 25,000 rows (25 pages of 1,000) and format per page so large waitlists cannot OOM the tab.
  async function exportCsv() {
    setExporting(true)
    try {
      const MAX_PAGES = 25
      const chunks: string[] = [formatCsvRow(['Email', 'Name', 'First attempt (UTC)', 'Last attempt (UTC)', 'Attempts', 'Let in (UTC)', 'Emailed'])]
      let cursor: string | undefined, pages = 0, truncated = false
      do {
        const page = await operatorApi.waitlist({ q: q || undefined, cursor, limit: 1000 })
        if (page.items.length) chunks.push('\r\n' + page.items.map(row => formatCsvRow([row.email, row.name ?? '', isoTime(row.firstAt), isoTime(row.lastAt), row.attempts, row.letInAt ? isoTime(row.letInAt) : '', row.emailed ?? ''])).join('\r\n'))
        cursor = page.nextCursor ?? undefined
        if (cursor && ++pages >= MAX_PAGES) { truncated = true; break }
      } while (cursor)
      downloadCsvChunks('nightmail-waitlist.csv', chunks)
      if (truncated) toast('Exported first 25,000 entries. Filter by search to export the rest.', 'info')
    } catch (error) { toast(errorText(error, 'Couldn’t export the waitlist.'), 'error') }
    finally { setExporting(false) }
  }
  return <>
    <WaitlistToolbar search={search} onSearch={setSearch} onExport={() => void exportCsv()} exporting={exporting} exportable={rows.length > 0} />
    {list.isError && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <>
      <DataTable className="op-table" loading={list.isPending} skeletonRows={6} rows={rows} rowKey={row => row.email} columns={waitlistColumns}
        empty={<EmptyState title={q ? 'No one matches' : 'No one on the waitlist yet'} action={q ? <Button onClick={() => setSearch('')}>Clear search</Button> : undefined} />} />
      {rows.length > 0 && total !== undefined && <p className="op-total muted">{number(total)} {total === 1 ? 'person' : 'people'}</p>}
      {list.hasNextPage && <Button className="op-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
      {list.isError && list.data && <Alert tone="danger"><ErrorText error={list.error} /></Alert>}
    </>}
  </>
}

// ---------------------------------------------------------------- one workspace

type ActionKind = 'pause' | 'resume' | 'hold' | 'release' | 'limit' | 'growth' | 'domains' | 'campaign'
type PendingAction = { kind: ActionKind; key: string; campaign?: OperatorCampaign }
const open = (kind: ActionKind, campaign?: OperatorCampaign): PendingAction => ({ kind, key: crypto.randomUUID(), campaign })

export function OperatorWorkspacePage() {
  const role = useOperatorRole()
  const id = useParams().id ?? ''
  const enabled = Boolean(role && id)
  const detail = useQuery({ queryKey: ['operator', 'workspace', id], queryFn: ({ signal }) => operatorApi.workspace(id, signal), enabled })
  const [action, setAction] = useState<PendingAction | null>(null)
  if (!role) return <NotFound />
  if (!detail.data && !detail.isError) return <OperatorWorkspaceSkeleton actions={role === 'operator'} />
  const data = detail.data
  const paused = Boolean(data?.connection?.paused || data?.standing?.step === 'pause'), held = Boolean(data?.standing?.marketingHeld)
  const items: MenuItem[] = [
    paused ? { label: 'Resume sending…', onSelect: () => setAction(open('resume')) } : { label: 'Pause sending…', destructive: true, onSelect: () => setAction(open('pause')) },
    held ? { label: 'Release marketing…', onSelect: () => setAction(open('release')) } : { label: 'Hold marketing…', onSelect: () => setAction(open('hold')) },
    { label: 'Set daily limit…', onSelect: () => setAction(open('limit')) },
    ...(data?.score?.limit?.growth ? [{ label: 'Lift growth pace…', onSelect: () => setAction(open('growth')) }] : []),
    { label: 'Set domain limit…', onSelect: () => setAction(open('domains')) },
  ]
  return <>
    <PageHeader title={data?.workspace.name ?? 'Workspace'} backTo="/operator" actions={role === 'operator' ? data ? <DropdownMenu label="Workspace actions" title={data.workspace.name} trigger={<ActionsTrigger />} items={items} /> : <ActionsTrigger disabled /> : undefined} />
    {!data ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <>
      <WorkspaceBody data={data} canAct={role === 'operator'} onReleaseCampaign={campaign => setAction(open('campaign', campaign))} />
      <ActionDialog action={action} workspace={data} onClose={() => setAction(null)} />
    </>}
  </>
}

const Rows = ({ rows }: { rows: [string, ReactNode][] }) => <dl className="op-rows">{rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>
const yes = (value: boolean) => value ? 'Yes' : 'No'

function WorkspaceBody({ data, canAct, onReleaseCampaign }: { data: OperatorWorkspace; canAct: boolean; onReleaseCampaign: (campaign: OperatorCampaign) => void }) {
  const { score, standing, connection } = data, limit = score.limit
  const graded = score.state === 'graded' && score.score !== null
  const factValues: Record<(typeof facts)[number], ReactNode> = {
    Step: standing ? <StepBadge step={standing.step} /> : '—',
    Score: graded ? `${score.score!.toFixed(1)} · ${score.grade}` : `Calibrating ${score.emails.firstEmails}/${score.needed}`,
    'Daily limit': limit?.daily == null ? 'None' : `${number(limit.daily)}/day`,
    Since: standing ? when(standing.since) : '—',
    Strikes: standing ? number(standing.strikes) : '—',
    Connection: connection ? `${connection.region}${connection.paused ? ' · paused' : ''}` : 'None',
  }
  const offer = standing?.selfService
  const factorColumns: Column<SenderScoreFactor>[] = [
    { ...def(factorColumnDefs, 'factor'), render: f => <span title={f.basis}>{f.label}</span> },
    { ...def(factorColumnDefs, 'score'), render: f => f.score === null ? 'Neutral' : f.score.toFixed(1), cardRender: f => f.score === null ? 'Neutral' : `Score ${f.score.toFixed(1)}` },
    { ...def(factorColumnDefs, 'value'), render: f => f.value === null ? '—' : factorFormats[f.key](f.value), cardRender: f => f.value === null ? 'No data' : factorFormats[f.key](f.value) },
    { ...def(factorColumnDefs, 'weight'), render: f => number(f.weight), cardRender: f => `weight ${f.weight}` },
    { ...def(factorColumnDefs, 'points'), render: f => f.points === null ? '—' : f.points.toFixed(2), cardRender: f => f.points === null ? 'no points' : `${f.points.toFixed(2)} pts` },
  ]
  const domainColumns: Column<OperatorDomain>[] = [
    { ...def(domainColumnDefs, 'name'), render: d => <span className="op-cell" title={d.name}>{d.name}</span>, cardRender: d => d.name },
    { ...def(domainColumnDefs, 'pool'), render: d => label(d.pool) },
    { ...def(domainColumnDefs, 'region'), render: d => d.region ?? '—' },
    { ...def(domainColumnDefs, 'dkim'), render: d => yes(d.dkim), cardRender: d => `DKIM ${d.dkim ? 'on' : 'off'}` },
    { ...def(domainColumnDefs, 'mailFrom'), render: d => yes(d.mailFrom), cardRender: d => `MAIL FROM ${d.mailFrom ? 'on' : 'off'}` },
    { ...def(domainColumnDefs, 'dmarc'), render: d => d.dmarc ? label(d.dmarc) : 'None', cardRender: d => `DMARC ${d.dmarc ?? 'none'}` },
  ]
  const billing = useQuery({ queryKey: ['operator', 'billing', data.workspace.id], queryFn: ({ signal }) => operatorApi.billing(data.workspace.id, signal) })
  const [freeAction, setFreeAction] = useState<FreeAction | null>(null)
  const [reason, setReason] = useState<StandingReason | null>(null)
  const personFree = (userId: string) => billing.data?.free.people.find(p => p.userId === userId)?.free ?? null
  const memberColumns: Column<OperatorMember>[] = [
    { ...def(memberColumnDefs, 'email'), render: m => <span className="op-email"><PrivateAddress value={m.email} /></span> },
    { ...def(memberColumnDefs, 'role'), render: m => label(m.role) },
    { ...def(memberColumnDefs, 'user'), render: m => <span className="op-muted-id">{m.userId}</span> },
    { ...def(memberColumnDefs, 'billing'), render: m => !billing.data ? billing.isError ? '—' : <SkeletonText width={96} /> : personFree(m.userId)?.live ? <span className="op-cell" title={personFree(m.userId)!.reason}>Free account{personFree(m.userId)!.until ? ` · until ${when(personFree(m.userId)!.until)}` : ''}</span> : <span className="muted">Billed</span> },
    { ...def(memberColumnDefs, 'actions'), render: m => canAct && billing.data ? <DropdownMenu label={`Billing for member ${m.userId}`} title="Billing" items={[personFree(m.userId)
      ? { label: 'End free account…', onSelect: () => setFreeAction({ kind: 'person', on: false, userId: m.userId, key: crypto.randomUUID() }) }
      : { label: 'Make account free…', onSelect: () => setFreeAction({ kind: 'person', on: true, userId: m.userId, key: crypto.randomUUID() }) }]} /> : null },
  ]
  const free = billing.data?.free
  const billingState = !free ? null : free.free ? `Free (not billed) · ${free.via === 'workspace' ? 'workspace flag' : 'an owner’s free account'}${free.until ? ` · until ${when(free.until)}` : ''}` : 'Billed · Prepaid'
  const campaignColumns: Column<OperatorCampaign>[] = [
    { ...def(campaignColumnDefs, 'name'), render: c => <span className="op-cell">{c.name}</span> },
    { ...def(campaignColumnDefs, 'state'), render: c => <StatusBadge status={c.state} /> },
    { ...def(campaignColumnDefs, 'pause'), render: c => <span className="op-cell" title={c.pauseReason?.message}>{c.pauseReason?.code ? label(c.pauseReason.code.toLowerCase()) : '—'}</span> },
    { ...def(campaignColumnDefs, 'quarantines'), render: c => number(c.quarantines), cardRender: c => `${number(c.quarantines)} ${c.quarantines === 1 ? 'quarantine' : 'quarantines'}` },
    { ...def(campaignColumnDefs, 'actions'), render: c => canAct && c.state === 'paused' ? <DropdownMenu label={`Actions for ${c.name}`} title={c.name} items={[{ label: 'Release campaign…', onSelect: () => onReleaseCampaign(c) }]} /> : null },
  ]
  return <div className="op-page">
    <dl className="op-facts">{facts.map(title => <div key={title}><dt>{title}</dt><dd>{factValues[title]}</dd></div>)}</dl>
    <div className="op-grid">
      <section className="op-section" aria-labelledby="op-standing"><SectionHeader title={<span id="op-standing">Standing and why</span>} />
        {/* Each reason opens its code, window and step: the ladder's detail stays one click away. */}
        {standing?.reasons.length ? <ul className="op-reasons">{standing.reasons.map(reason => <li key={reason.code}><button type="button" className="op-reason" onClick={() => setReason(reason)}>{reason.message}</button></li>)}</ul> : null}
        <Rows rows={[
          ['Pause', connection?.paused ? `${standing?.pauseKind === 'bounce' ? 'Bounce-only' : 'Full'}${connection.pauseReason ? ` · ${connection.pauseReason}` : ''}` : 'Not paused'],
          ['SES tenants', !connection ? '—' : connection.resuming ? 'Enabling before sending resumes' : connection.tenants.length ? connection.tenants.map(t => `${t.region} ${t.applied === 'DISABLED' ? 'disabled' : t.applied === 'DISABLING' ? 'possibly disabled' : 'enabled'}`).join(' · ') : 'Enabled'],
          ['Marketing', standing?.marketingRelease ? `Released at ${standing.marketingRelease.percent}% until ${when(standing.marketingRelease.until)}` : standing?.marketingHeld ? 'Held' : 'Flowing'],
          ['Self-service', !offer ? '—' : offer.available ? `${label(offer.action ?? 'none')} available` : offer.reason ? `${offer.reason}${offer.availableAt ? ` From ${when(offer.availableAt)}.` : ''}` : 'Nothing to release'],
          ['Version', standing ? `${standing.version} · sequence ${standing.sequence}` : '—'],
          ['Sponsor siblings', data.siblings.length ? <ul className="op-siblings">{data.siblings.map(sibling => <li key={sibling.id}><Link to={`/operator/workspaces/${encodeURIComponent(sibling.id)}`}>{sibling.name}</Link></li>)}</ul> : 'None'],
          ['Created', when(data.workspace.createdAt)],
        ]} />
      </section>
      <section className="op-section" aria-labelledby="op-limit"><SectionHeader title={<span id="op-limit">Limit math</span>} />
        {limit ? <Rows rows={[
          ['Enforced', limit.daily === null ? 'No daily limit' : `${number(limit.daily)} a day · ${label(limit.source)}`],
          ['Score band', `${limit.unlimited && limit.source === 'score' ? 'None' : `${number(limit.band)} a day`}${limit.next ? ` · next ${limit.next.unlimited ? 'none' : number(limit.next.limit)} at ${limit.next.atScore}` : ''}`],
          ['Score', graded ? `${score.score!.toFixed(1)} → target ${score.target.toFixed(1)} · quality ${score.raw.toFixed(1)}` : `Evaluating${score.gradedBy ? `, graded by ${when(score.gradedBy)}` : ''}`],
          ['Override', limit.override ? `${number(limit.override.daily)} a day${limit.override.expiresAt ? ` until ${when(limit.override.expiresAt)}` : ', no expiry'}` : data.exempt ? 'Exempt from hosted quotas' : 'None'],
          ['Restore', limit.restore ? `${number(limit.restore.daily)} a day until ${when(limit.restore.until)}` : 'None'],
          ['Strike cap', limit.strikeCapUntil ? `50% until ${when(limit.strikeCapUntil)}` : 'None'],
          ['Growth pace', limit.growth ? `${number(limit.growth.used)} of ${number(limit.growth.hourly)} this hour, until ${when(limit.growth.until)}` : 'None'],
          ['Bursts', `${number(limit.perMinute)} a minute · marketing ${number(limit.marketingPerHour)} an hour`],
          ['Transactional reserve', number(limit.transactionalReserve)],
        ]} /> : <EmptyState title="No hosted limit" />}
      </section>
    </div>
    <section className="op-section"><SectionHeader title="Factors" /><DataTable className="op-table" rows={score.factors} rowKey={f => f.key} columns={factorColumns} empty={<EmptyState title="No factors yet" />} /></section>
    <section className="op-section"><SectionHeader title="Domains" actions={<span className="muted">{`${number(data.domainLimit.used)} of ${number(data.domainLimit.limit)}${data.domainLimit.custom ? ' · set by an operator' : ''}`}</span>} /><DataTable className="op-table" rows={data.domains} rowKey={d => d.name} columns={domainColumns} empty={<EmptyState title="No domains" />} /></section>
    <section className="op-section" aria-labelledby="op-billing"><SectionHeader title={<span id="op-billing">Billing</span>} />
      {billing.isError && !billing.data ? <ErrorState error={billing.error} onRetry={() => void billing.refetch()} /> : <dl className="op-rows op-rows--single">
        <div><dt>Status</dt><dd title={billingState ?? undefined}>{billingState ?? <SkeletonText width={220} />}</dd></div>
        <div><dt>Free (not billed)</dt><dd className="op-free">{!free ? <ControlSkeleton width={36} /> : <>
          <span title={canAct ? undefined : 'Needs the operator role'}><Switch label={<span className="sr-only">Free (not billed)</span>} checked={Boolean(free.workspace && !free.workspace.expired)} disabled={!canAct}
            onCheckedChange={on => setFreeAction({ kind: 'workspace', on, key: crypto.randomUUID() })} /></span>
          {free.workspace && <span className="muted op-cell" title={free.workspace.reason ?? undefined}>{`${free.workspace.expired ? 'Ended' : 'Since'} ${when(free.workspace.expired ? free.workspace.until : free.workspace.at)}${!free.workspace.expired && free.workspace.until ? ` · until ${when(free.workspace.until)}` : ''} · ${free.workspace.reason ?? ''}`}</span>}
        </>}</dd></div>
        <div><dt>Free owners</dt><dd>{!free ? <SkeletonText width={160} /> : number(free.people.filter(p => p.role === 'owner' && p.free?.live).length)}</dd></div>
        <div><dt>AI decisions</dt><dd>{!billing.data ? <SkeletonText width={200} /> : `${number(billing.data.decisions.month)} this month · ${number(billing.data.decisions.day)} in 24 hours`}</dd></div>
      </dl>}
    </section>
    <section className="op-section"><SectionHeader title="Members" /><DataTable className="op-table" rows={data.members} rowKey={m => m.userId} columns={memberColumns} empty={<EmptyState title="No members" />} /></section>
    <FreeDialog action={freeAction} workspaceId={data.workspace.id} onClose={() => setFreeAction(null)} />
    <section className="op-section"><SectionHeader title="Campaigns" /><DataTable className="op-table" rows={data.campaigns} rowKey={c => c.id} columns={campaignColumns} empty={<EmptyState title="No active or quarantined campaigns" />} /></section>
    <Timeline workspaceId={data.workspace.id} />
    {reason && <DetailDialog title="Standing reason" onClose={() => setReason(null)} rows={[['Reason', reason.message], ['Code', <span className="op-muted-id">{reason.code}</span>], ['Window', reason.window ?? null], ['Step', <StepBadge step={reason.step} />]]} />}
  </div>
}

const kindTone: Record<TimelineKind, Tone> = { standing: 'warning', limit: 'neutral', quarantine: 'danger', release: 'success', tenant: 'warning', operator: 'info', score: 'neutral', audit: 'info', bounces: 'warning', rejection: 'danger' }
type Json = Record<string, unknown>
const record = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
// One line of what the API recorded for an event; it carries no addresses and no message bodies.
function detailText(item: OperatorTimelineItem) {
  const d = record(item.detail), details = record(d.details), actor = record(d.actor)
  const reasons = Array.isArray(d.reasons) ? d.reasons.map(reason => record(reason).message).filter((m): m is string => typeof m === 'string') : []
  const parts: unknown[] = item.kind === 'score' ? [`${number(Number(d.accepted ?? 0))} accepted`, `${number(Number(d.bounced ?? 0))} bounced`, `${number(Number(d.complained ?? 0))} complaints`, `${number(Number(d.rejected ?? 0))} rejected`]
    : item.kind === 'audit' ? [d.reason, d.ticketRef && `ticket ${d.ticketRef}`, d.via]
    : item.kind === 'rejection' ? [d.spam !== undefined && `spam ${typeof d.spam === 'object' ? JSON.stringify(d.spam) : d.spam}`, typeof d.threshold === 'number' && `threshold ${d.threshold}`, d.campaignId && `campaign ${d.campaignId}`]
    : item.kind === 'bounces' ? []
    : [...reasons, details.reason, details.ticketRef && `ticket ${details.ticketRef}`, actor.kind && `by ${actor.kind}${actor.via ? ` via ${actor.via}` : ''}`]
  return parts.filter(part => typeof part === 'string' && part).join(' · ')
}
const timelineColumns: Column<OperatorTimelineItem & { key: string }>[] = [
  { ...def(timelineColumnDefs, 'title'), render: item => <span className="op-cell" title={item.title}>{item.title}</span> },
  { ...def(timelineColumnDefs, 'kind'), render: item => <StatusBadge status={label(item.kind)} tone={kindTone[item.kind] ?? 'neutral'} /> },
  { ...def(timelineColumnDefs, 'detail'), render: item => { const text = detailText(item); return <span className="op-cell muted" title={text}>{text || '—'}</span> } },
  { ...def(timelineColumnDefs, 'at'), render: item => <At value={item.at} /> },
]
// The evidence timeline: standing changes, operator actions, the daily score, bounces and complaints by recipient
// domain and screen rejections, newest first. "Load more" pages back with the API's cursor.
function Timeline({ workspaceId }: { workspaceId: string }) {
  const timeline = useInfiniteQuery({
    queryKey: ['operator', 'timeline', workspaceId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.timeline(workspaceId, pageParam, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (timeline.data?.pages ?? []).flatMap((page, p) => page.items.map((item, i) => ({ ...item, key: `${p}:${i}:${item.at}:${item.kind}` })))
  const [shown, setShown] = useState<OperatorTimelineItem | null>(null)
  return <section className="op-section"><SectionHeader title="Evidence timeline" />
    {timeline.isError && !timeline.data ? <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} /> : <>
      <DataTable className="op-table" loading={timeline.isPending} skeletonRows={5} rows={rows} rowKey={row => row.key} onRowClick={setShown} columns={timelineColumns} empty={<EmptyState title="No events yet" />} />
      {shown && <DetailDialog title="Event" onClose={() => setShown(null)} rows={[['Event', shown.title], ['Kind', <StatusBadge status={label(shown.kind)} tone={kindTone[shown.kind] ?? 'neutral'} />], ['When', when(shown.at)], ['Detail', detailText(shown)]]} />}
      {timeline.hasNextPage && <Button className="op-more" loading={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>Load more</Button>}
      {timeline.isError && timeline.data && <Alert tone="danger"><ErrorText error={timeline.error} /></Alert>}
    </>}
  </section>
}

// ---------------------------------------------------------------- actions

// A consequential action says, in one sentence, the consequence its title doesn't (pause, resume, hold, release);
// setting a limit or releasing one campaign is said by its title and fields.
const actionCopy: Record<ActionKind, { title: string; description?: string; confirm: string; done: string; danger?: boolean }> = {
  pause: { title: 'Pause sending?', description: 'Owners see a pause banner and get an email.', confirm: 'Pause sending', done: 'Sending paused', danger: true },
  resume: { title: 'Resume sending?', description: 'A strike stays on record.', confirm: 'Resume sending', done: 'Sending resumed' },
  hold: { title: 'Hold marketing?', description: 'Campaigns pause and new marketing is refused.', confirm: 'Hold marketing', done: 'Marketing held' },
  release: { title: 'Release marketing?', description: 'The workspace moves to Warn until it clears.', confirm: 'Release marketing', done: 'Marketing released' },
  limit: { title: 'Set the daily limit', confirm: 'Save limit', done: 'Limit saved' },
  growth: { title: 'Lift the growth pace?', confirm: 'Lift growth pace', done: 'Growth pace lifted' },
  domains: { title: 'Set the domain limit', confirm: 'Save limit', done: 'Domain limit saved' },
  campaign: { title: 'Release this campaign?', confirm: 'Release campaign', done: 'Campaign released' },
}
const reasonLabel = 'Reason for the audit log'
const reasonCheck = (reason: string) => reason.trim().length < 10 ? 'At least 10 characters.' : reason.trim().length > 1000 ? 'At most 1,000 characters.' : ''
const futureError = 'A time in the future.'
const ticketLabel = 'Ticket ID or URL'
// An optional date: its Add button leaves it out (no end) until pressed, so empty never needs explaining.
function OptionalDate({ add, label, value, onChange, error, disabled }: { add: string; label: string; value: string; onChange: (value: string) => void; error?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(value !== '')
  if (!open) return <Button variant="ghost" className="op-add-date" disabled={disabled} onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />{add}</Button>
  return <Field label={label} error={error}><Input type="datetime-local" autoFocus value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></Field>
}
// Each opening has its own Idempotency-Key, and every submit sends If-Match with the standing version it was decided on.
// Free (not billed): a workspace's own flag, or a person's (every workspace they own while they own it). Operators only;
// the reason goes into the audit log. An end date is optional. Billing again says what it charges before it does.
type FreeAction = { kind: 'workspace' | 'person'; on: boolean; userId?: string; key: string }
function FreeDialog({ action, workspaceId, onClose }: { action: FreeAction | null; workspaceId: string; onClose: () => void }) {
  const last = useRef(action)
  if (action) last.current = action
  const shown = action ?? last.current
  const title = !shown ? '' : shown.kind === 'workspace' ? shown.on ? 'Make this workspace free?' : 'Bill this workspace again?' : shown.on ? 'Make every workspace this person owns free?' : 'End this person’s free account?'
  const description = !shown || shown.on ? undefined : shown.kind === 'workspace'
    ? 'Usage settled from now on is charged again, unless an owner has a free account.'
    : 'The workspaces they own are billed again unless they are free on their own.'
  return <Dialog open={action !== null} onOpenChange={next => { if (!next) onClose() }} title={title} description={description}>
    {shown && <FreeForm key={shown.key} action={shown} workspaceId={workspaceId} onClose={onClose} />}
  </Dialog>
}
function FreeForm({ action, workspaceId, onClose }: { action: FreeAction; workspaceId: string; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const [reason, setReason] = useState(''), [ticket, setTicket] = useState(''), [until, setUntil] = useState(''), [tried, setTried] = useState(false)
  const reasonError = reasonCheck(reason), untilError = until && !(Date.parse(until) > Date.now()) ? futureError : ''
  const mutation = useMutation({
    mutationFn: () => {
      const input = { free: action.on, reason, ticketRef: ticket, until: until ? new Date(until).toISOString() : null }, guard = { idempotencyKey: action.key }
      return action.kind === 'workspace' ? operatorApi.workspaceFree(workspaceId, input, guard) : operatorApi.personFree(action.userId!, input, guard)
    },
    onSuccess: () => { toast(action.on ? 'Marked free' : 'Billed again', 'success'); void client.invalidateQueries({ queryKey: ['operator'] }); onClose() },
  })
  function submit(event: FormEvent) { event.preventDefault(); setTried(true); if (!reasonError && !untilError) mutation.mutate() }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    <Field label={reasonLabel} error={tried ? reasonError : ''}><Textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></Field>
    <Field label={ticketLabel}><Input value={ticket} maxLength={200} onChange={event => setTicket(event.target.value)} /></Field>
    {action.on && <OptionalDate add="Add an end date" label="Ends" value={until} onChange={setUntil} error={tried ? untilError : ''} />}
    <MutationError error={mutation.error} />
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={mutation.isPending}>{action.on ? 'Make free' : 'Bill again'}</Button></div>
  </form>
}
function ActionDialog({ action, workspace, onClose }: { action: PendingAction | null; workspace: OperatorWorkspace; onClose: () => void }) {
  const last = useRef(action)
  if (action) last.current = action
  const shown = action ?? last.current
  return <Dialog open={action !== null} onOpenChange={next => { if (!next) onClose() }} title={!shown ? '' : shown.kind === 'campaign' && shown.campaign ? `Release ${shown.campaign.name}?` : actionCopy[shown.kind].title} description={shown ? actionCopy[shown.kind].description : undefined}>
    {shown && <ActionForm key={shown.key} action={shown} workspace={workspace} onClose={onClose} />}
  </Dialog>
}
function ActionForm({ action, workspace, onClose }: { action: PendingAction; workspace: OperatorWorkspace; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const copy = actionCopy[action.kind]
  const [reason, setReason] = useState(''), [ticket, setTicket] = useState(''), [restore, setRestore] = useState<'50' | '100'>('50')
  // The limit starts at the current override, or else at the score's band, so the number to change from is in the field.
  const band = workspace.score.limit?.band
  const [daily, setDaily] = useState(workspace.override ? String(workspace.override.daily) : band ? String(band) : ''), [expires, setExpires] = useState(''), [clear, setClear] = useState(false)
  const [domainLimit, setDomainLimit] = useState(String(workspace.domainLimit.limit)), [defaultDomains, setDefaultDomains] = useState(false)
  const [tried, setTried] = useState(false)
  const reasonError = reasonCheck(reason)
  const domainValue = Number(domainLimit), domainError = action.kind === 'domains' && !defaultDomains && !(Number.isInteger(domainValue) && domainValue >= 1 && domainValue <= 10_000) ? 'A whole number from 1 to 10,000.' : ''
  const ticketError = ticket.trim().length > 200 ? 'At most 200 characters.' : ''
  const dailyValue = Number(daily), dailyError = action.kind === 'limit' && !clear && !(Number.isInteger(dailyValue) && dailyValue >= 1 && dailyValue <= 10_000_000) ? dailyLimitError : ''
  const expiresAt = Date.parse(expires), expiresError = action.kind === 'limit' && !clear && expires ? !(expiresAt > Date.now()) ? futureError : expiresAt > Date.now() + 366 * 86_400_000 ? 'At most a year ahead.' : '' : ''
  const mutation = useMutation({
    mutationFn: () => {
      const id = workspace.workspace.id, why = { reason, ticketRef: ticket }, guard = { idempotencyKey: action.key, ifMatch: workspace.standing?.version }
      switch (action.kind) {
        case 'pause': return operatorApi.pause(id, why, guard)
        case 'resume': return operatorApi.resume(id, { ...why, restore: restore === '100' ? 100 : 50 }, guard)
        case 'hold': return operatorApi.marketing(id, { ...why, held: true }, guard)
        case 'release': return operatorApi.marketing(id, { ...why, held: false }, guard)
        case 'growth': return operatorApi.liftGrowth(id, why, guard)
        case 'limit': return operatorApi.limit(id, { ...why, daily: clear ? null : dailyValue, expiresAt: expires ? new Date(expires).toISOString() : null }, guard)
        case 'domains': return operatorApi.domainLimit(id, { ...why, limit: defaultDomains ? null : domainValue }, guard).then(() => undefined)
        case 'campaign': return operatorApi.releaseCampaign(action.campaign!.id, why, guard)
      }
    },
    onSuccess: () => { toast(copy.done, 'success'); void client.invalidateQueries({ queryKey: ['operator'] }); onClose() },
    // A stale version means someone (or the ladder) changed the standing: reread it so the next try decides on it.
    onError: error => { if (error instanceof ApiError && error.status === 412) void client.invalidateQueries({ queryKey: ['operator', 'workspace', workspace.workspace.id] }) },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    setTried(true)
    if (reasonError || ticketError || dailyError || expiresError || domainError) return
    mutation.mutate()
  }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    {action.kind === 'resume' && <Field label="Restore"><Select aria-label="Restore" value={restore} onValueChange={value => setRestore(value as '50' | '100')} options={[{ value: '50', label: '50% of the limit for 48 hours' }, { value: '100', label: 'The full limit' }]} /></Field>}
    {action.kind === 'limit' && <>
      <Checkbox checked={clear} onCheckedChange={setClear} label="Return to the score’s limit" disabled={!workspace.override} />
      <Field label="Daily limit" error={tried ? dailyError : ''}><Input type="number" inputMode="numeric" min={1} max={10_000_000} step={1} value={clear ? '' : daily} disabled={clear} onChange={event => setDaily(event.target.value)} /></Field>
    </>}
    {action.kind === 'domains' && <>
      <Checkbox checked={defaultDomains} onCheckedChange={setDefaultDomains} label="Return to the default of 100" disabled={!workspace.domainLimit.custom} />
      <Field label={`Domain limit (${number(workspace.domainLimit.used)} in use)`} error={tried ? domainError : ''}><Input type="number" inputMode="numeric" min={1} max={10_000} step={1} value={defaultDomains ? '' : domainLimit} disabled={defaultDomains} onChange={event => setDomainLimit(event.target.value)} /></Field>
    </>}
    <Field label={reasonLabel} error={tried ? reasonError : ''}><Textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></Field>
    <Field label={ticketLabel} error={tried ? ticketError : ''}><Input value={ticket} maxLength={200} onChange={event => setTicket(event.target.value)} /></Field>
    {action.kind === 'limit' && <OptionalDate add="Add an expiry" label="Expires" value={expires} onChange={setExpires} error={tried ? expiresError : ''} disabled={clear} />}
    <MutationError error={mutation.error} />
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant={copy.danger ? 'danger' : 'primary'} loading={mutation.isPending}>{copy.confirm}</Button></div>
  </form>
}
