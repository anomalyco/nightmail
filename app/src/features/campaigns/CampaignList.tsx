import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router'
import { useApi, useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { useNewsletters } from '../newsletters/shared'
import { composer } from './composer-chunk'
import { onIdle, warmCampaignEditor } from './composer-content'
import { campaignEditable, type Campaign } from '../../data/types'
import { SearchField, Button, DataTable, EmptyState, ErrorState, Pagination, PaginationSkeleton, Select, StatusBadge } from '../../components/ui'
import { date, number, percent, shortDateTime, time } from '../../lib/format'
import { campaignColumns } from './skeletons'
import { useSearchDraft } from '../../lib/pagination'
import { CampaignArchiveButton } from './CampaignArchiveButton'
import { campaignDisplayStatus, campaignPollInterval } from './CampaignProgress'
import { CampaignsHeader } from './header'
import './campaigns.css'

// Simulated sends count as delivered here (the review page lists them apart). Past the email history the stored totals
// count instead; null when neither is known. Demo campaigns carry only `delivered`.
const delivered = (campaign: Campaign): number | null => (campaign.counts?.total ?? 0) > 0 ? (campaign.counts!.byStatus.delivered ?? 0) + (campaign.counts!.byStatus.simulated ?? 0)
  : campaign.stats ? campaign.stats.delivered : campaign.counts ? null : (campaign.delivered ?? null)
const deliveredShare = (campaign: Campaign) => { const recipients = campaign.recipients ?? 0; const count = campaign.status === 'done' && recipients > 0 ? delivered(campaign) : null; return count === null ? null : count / recipients }
const campaignPath = (campaign: Campaign) => `/campaigns/${encodeURIComponent(campaign.id)}/${!campaign.archivedAt && campaignEditable(campaign) ? 'edit' : 'review'}`

export function CampaignsPage() {
  const navigate = useNavigate()
  const api = useApi()
  const cache = useQueryClient()
  const warm = usePrefetchQueries()
  const [params, setParams] = useSearchParams()
  // Warm the composer chunk on idle so both phone taps and quick desktop clicks never wait for the editor bundle.
  useEffect(() => onIdle(() => { void composer.preload().catch(() => {}) }), [])
  const archived = params.get('archived') === 'true'
  const search = params.get('search') || ''
  const status = !archived && ['draft', 'preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled'].includes(params.get('status') || '') ? params.get('status')! : 'all'
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = 10
  // A newsletter's issues are on its own page: with newsletters, this page holds the campaigns that are none's issue.
  const { canAdminister } = useWorkspaceAccess()
  const request = { search, archived, status: status === 'all' ? undefined : status, page, pageSize, ...(useNewsletters().length ? { newsletter: false } : {}) }
  const query = useApiDef(queries.campaigns(request), { keepPrevious: true, interval: data => {
    const intervals = (data?.items ?? []).map(campaignPollInterval).filter((value): value is number => value !== false)
    return intervals.length ? Math.max(15_000, Math.min(...intervals)) : false
  } })
  const filtered = Boolean(search || status !== 'all')
  // On page 1 idle, warm the top editable draft (campaign JSON + inline images) so phone taps and zero-hover
  // clicks open with body text and images already in cache.
  const idleWarmId = !archived && !filtered && page === 1
    ? (query.data?.items ?? []).find(row => !row.archivedAt && campaignEditable(row))?.id ?? ''
    : ''
  useEffect(() => {
    if (!idleWarmId) return
    return onIdle(() => { void warmCampaignEditor(cache, api, idleWarmId) }, 400)
  }, [idleWarmId, cache, api])
  function filter(key: string, value: string, replace = false) {
    setParams(previous => { const next = new URLSearchParams(previous); value ? next.set(key, value) : next.delete(key); next.delete('page'); return next }, { replace })
  }
  const [draft, type] = useSearchDraft(search, value => filter('search', value, true))
  function selectTab(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('page'); next.delete('status'); next.delete('archived')
      if (value === 'archived') next.set('archived', 'true')
      else if (value !== 'all') next.set('status', value)
      return next
    })
  }
  return <div className="campaigns-page">
    <CampaignsHeader actions={<>{canAdminister && <Button onClick={() => navigate('/newsletters/new')}>New newsletter</Button>}<Button variant="primary" onPointerEnter={() => void composer.preload().catch(() => {})} onPointerDown={() => void composer.preload().catch(() => {})} onFocus={() => void composer.preload().catch(() => {})} onClick={() => navigate('/campaigns/new')}>Create campaign</Button></>} />
    <div className="data-toolbar"><div className="cluster"><SearchField className="search-box--list" aria-label="Search campaigns" placeholder="Search campaigns" value={draft} onChange={event => type(event.target.value)} /><Select aria-label="Filter by status" value={archived ? 'archived' : status} onValueChange={selectTab} options={[
      { value: 'all', label: 'All campaigns' }, { value: 'draft', label: 'Drafts' }, { value: 'scheduled', label: 'Scheduled' },
      { value: 'sending', label: 'Sending' }, { value: 'paused', label: 'Paused' }, { value: 'done', label: 'Done' }, { value: 'failed', label: 'Failed' }, { value: 'canceled', label: 'Canceled' },
      { value: 'archived', label: 'Archived' },
    ]} /></div></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable className="campaigns-table ui-table--two-line" loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} rowHref={campaignPath} onRowIntent={row => { if (campaignPath(row).endsWith('/edit')) void warmCampaignEditor(cache, api, row.id); else void warm([queries.campaign(row.id)]) }} empty={<EmptyState title={filtered ? 'No matching campaigns' : archived ? 'No archived campaigns' : 'No campaigns yet'} action={filtered ? <Button variant="secondary" onClick={() => setParams(archived ? { archived: 'true' } : {})}>Clear filters</Button> : archived ? undefined : <Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} columns={[
        { ...campaignColumns[0], render: row => <div className="campaign-row-name"><span title={row.name}>{row.name}</span>{row.subject.trim() && row.subject.trim() !== row.name.trim() && <span className="muted" title={row.subject}>{row.subject}</span>}</div>, cardRender: row => row.name },
        { ...campaignColumns[1], render: row => <StatusBadge status={campaignDisplayStatus(row)} /> },
        { ...campaignColumns[2], render: row => row.subject.trim() || <span className="muted">No subject</span> },
        { ...campaignColumns[3], render: row => campaignEditable(row) || row.recipients === undefined ? '—' : number(row.recipients), cardRender: row => campaignEditable(row) || row.recipients === undefined ? null : `${number(row.recipients)} ${row.recipients === 1 ? 'recipient' : 'recipients'}` },
        { ...campaignColumns[4], render: row => { const count = deliveredShare(row); return count === null ? '—' : percent(count) }, cardRender: row => { const count = deliveredShare(row); return count === null ? null : `${percent(count, 0)} delivered` } },
        { ...campaignColumns[5], render: row => { const at = row.scheduledAt || row.updatedAt; return <span className="muted campaign-activity" title={`${date(at)} · ${time(at)} UTC`}>{shortDateTime(at)}</span> }, cardRender: row => (row.scheduledAt ? 'Sends ' : '') + date(row.scheduledAt || row.updatedAt, { month: 'short', day: 'numeric', timeZone: 'UTC' }) },
        { ...campaignColumns[6], render: row => <CampaignArchiveButton campaign={row} compact onSuccess={() => filter('page', '')} /> },
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} count={query.data.items.length} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
    </>}
  </div>
}
