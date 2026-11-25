import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useApiDef, useApiMutation, useApiQuery, useRegion, useApi, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { priceUc, total, usd } from '../../data/billing'
import { invalidate, useRefreshListsOnChange } from '../../data/invalidation'
import { useRegionCatalog } from '../../data/regions'
import { ApiError, campaignEditable, errorText, campaignResumable, type Api, type Campaign, type CampaignInput, type CampaignReviewDisplay, type Newsletter, type SendCampaignInput, type WorkspaceSettings } from '../../data/types'
import { PostalAddressDialog } from '../../components/PostalAddress'
import { newsletterPath, useNewsletterOf, useShowNewsletter } from '../newsletters/shared'
import {
  Button, Checkbox, ConfirmDialog, Dialog, DropdownMenu, EmptyState, ErrorState,
  Field, Icon, IconButton, Input, PageHeader, SectionHeader, Select, SkeletonText,
  StatusBadge, Tabs, useToast,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { Notices } from '../../components/Notices'
import { Checks, checksCount, checksSummary, LOW_SENDABILITY } from '../../components/EmailInsight'
import { date, label, number, percent } from '../../lib/format'
import { CampaignAudienceSkeleton, CampaignRouteSkeleton } from './skeletons'
import { CampaignPacing, CampaignProgress, SummaryLine, campaignDisplayStatus, campaignLogs, campaignPollInterval, maxPerDay, maxRatePercent, minPerDay, minRatePercent, perDayError, ratePercentError } from './CampaignProgress'
import { CampaignArchiveButton } from './CampaignArchiveButton'
import { CampaignBar, CampaignSteps } from './steps'
import { productName } from '../../../../api/src/brand'
export { CampaignsPage } from './CampaignList'
export { TemplatesPage, TemplateEditorPage } from './templates'
import { TemplatePickerDialog } from './templates'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { draftAttachments } from './composer-content'
import { composer as composerChunk, EmailComposer } from './composer-chunk'
import { ChunkFallback } from '../../lib/preloadable'
import { CampaignSenderInput, SenderLines } from './CampaignSenderInput'
import { AttachmentList, CampaignAttachments, type CampaignAttachmentsRef } from './CampaignAttachments'
import { campaignVersion, useCampaignSync } from './useCampaignSync'
import { ComposerSkeleton } from './skeletons'
import { composerLoading, invalidSender } from './copy'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'
import { localLabel, parseUtc, ScheduleField, scheduleError, utcLabel } from '../../components/ScheduleField'
import { useSingleFlight } from '../../lib/single-flight'
import { modKey, usePhone } from '../../lib/media'
import { useLeaveGuard } from '../../lib/leave-guard'
import { emailIsValid, replyToAddresses, replyToError } from './reply-to'
import { mergeCampaign, mergeFieldsText, type MergeField } from './merge'
import { announceSave, CampaignPresence, useCampaignPresence, type Room, type Save } from './presence'
import { PresenceOverlay } from './presence-overlay'

// {{placeholders}} the campaign uses; email always resolves, everything else needs a contact value or a fallback.
const placeholderPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
export const placeholders = (...sources: (string | undefined)[]) => [...new Set(sources.flatMap(source => [...(source ?? '').matchAll(placeholderPattern)].map(match => match[1]!)))]
// The API's rule (outbound-content.ts unsubscribePageUrl), checked as typed so autosave never sends a page it refuses.
const unsubscribePageError = (value = '') => {
  const text = value.trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (/^https:\/\//i.test(text) && text.length <= 1000 && !/\s/.test(text) && !url.username && !url.password && !/^[^/?#]*@/.test(text.slice(8))) return url.searchParams.has('unsubscribe_token') ? 'Remove unsubscribe_token from the address.' : ''
  } catch { /* not a URL */ }
  return 'Enter an https:// address without a user name or password.'
}
const nobodyEligible = 'Nobody on this list can receive campaigns yet. Mark contacts as subscribed or choose another list.'
const campaignRoute = (campaign: Pick<Campaign, 'id'>, view: 'edit' | 'review') => `/campaigns/${encodeURIComponent(campaign.id)}/${view}`
function campaignReadinessError(campaign: Campaign) {
  const missing = [!campaign.name.trim() && 'a campaign name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a valid sender email address', !campaign.listId && 'a recipient list', !campaign.html.trim() && 'email content'].filter(Boolean)
  return missing.length ? `Complete the draft before reviewing or sending: add ${missing.join(', ')}.` : ''
}
// A test goes to one address, so it needs a complete message but no recipient list (the API sends it without one).
const campaignMessageReady = (campaign: Campaign) => Boolean(campaign.name.trim() && campaign.subject.trim() && emailIsValid(campaign.fromEmail.trim()) && campaign.html.trim())
const olderCampaign = (candidate: Campaign, baseline: Campaign) => (candidate.revision ?? 1) < (baseline.revision ?? 1) || ((candidate.revision ?? 1) === (baseline.revision ?? 1) && Date.parse(candidate.updatedAt) < Date.parse(baseline.updatedAt))
const campaignInput = (campaign: Campaign): CampaignInput => ({
  id: campaign.id, revision: campaign.revision, draft: campaign.draft, attachments: campaign.attachments, regionId: campaign.regionId,
  name: campaign.name, subject: campaign.subject, previewText: campaign.previewText, fromName: campaign.fromName, fromEmail: campaign.fromEmail, replyTo: campaign.replyTo, unsubscribePageUrl: campaign.unsubscribePageUrl, requiredNotice: campaign.requiredNotice,
  listId: campaign.listId, segmentId: campaign.segmentId, html: campaign.html, defaults: Object.fromEntries(Object.entries(campaign.draft?.defaults ?? {}).map(([key, value]) => [key, String(value)])),
})

export function CampaignEditorPage() {
  const { id } = useParams()
  const { regionId } = useRegion()
  // Hosted campaigns follow their From domain's region, so a new draft needs no region at all.
  const { multiTenant } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !id && !multiTenant })
  const fallbackRegion = multiTenant ? '' : regionId || regions.data?.defaultRegion || ''
  const scope = useRef({ id, key: id ?? 'new', createdId: null as string | null })
  if (scope.current.id !== id) {
    const ownCreation = !scope.current.id && id === scope.current.createdId
    scope.current = { id, key: ownCreation ? scope.current.key : id ?? 'new', createdId: null }
  }
  if (!id && !multiTenant && !fallbackRegion) {
    if (regions.isPending) return <CampaignRouteSkeleton kind="editor" isNew />
    return <><PageHeader title="Create campaign" backTo="/campaigns" />{regions.isError ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} /> : <EmptyState title="No sending region" action={<Link className="ui-button ui-button--secondary ui-button--md" to="/settings#workspace">Choose a default region</Link>} />}</>
  }
  return <CampaignEditorLoader key={scope.current.key} id={id} fallbackRegion={fallbackRegion} preserveEditor={next => {scope.current.createdId = next.id}} />
}

function CampaignEditorLoader({ id, fallbackRegion, preserveEditor }: { id?: string; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const query = useApiQuery<Campaign | null>(['campaign', id ?? 'new'], (api, signal) => id ? api.campaigns.get(id, signal) : Promise.resolve(null))
  // "New issue" on a newsletter's page (?newsletter=): the draft starts with that newsletter's sender and readers.
  const [search] = useSearchParams(), issueOf = id ? '' : search.get('newsletter') ?? ''
  const newsletter = useApiDef(queries.newsletter(issueOf), { enabled: Boolean(issueOf) })
  const opened = useRef<Campaign | null | undefined>(undefined)
  useEffect(() => { void composerChunk.preload().catch(() => {}) }, [])
  useEffect(() => {
    if (query.data) console.info(`[${productName} timing] campaign content ready`, { navigationMs: Number(performance.now().toFixed(1)), revision: query.data.revision })
  }, [query.data])
  if (opened.current === undefined && query.data !== undefined && (query.data === null || (!query.data.archivedAt && campaignEditable(query.data)))) opened.current = query.data
  // Once opened, background refetches must never unmount an unsaved working copy.
  if (issueOf && opened.current === null && !newsletter.data) return newsletter.isError ? <ErrorState error={newsletter.error} onRetry={() => newsletter.refetch()} /> : <CampaignRouteSkeleton kind="editor" isNew />
  if (opened.current !== undefined) return <CampaignEditor initial={opened.current} newsletter={newsletter.data} fallbackRegion={fallbackRegion} preserveEditor={preserveEditor} />
  if (query.isPending) return <CampaignRouteSkeleton kind="editor" isNew={!id} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  // Archived and sent campaigns can't be edited: their review page is where to read, restore or follow them.
  if (query.data) return <Navigate to={campaignRoute(query.data, 'review')} replace />
  return null
}

function CampaignEditor({ initial, newsletter, fallbackRegion, preserveEditor }: { initial: Campaign | null; newsletter?: Newsletter; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const toast = useToast()
  const phone = usePhone()
  const { multiTenant } = useWorkspaceAccess()
  const api = useApi()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(initial)
  const acceptedRef = useRef(initial)
  const [form, setForm] = useState<CampaignInput>(() => initial ? campaignInput(initial) : { regionId: fallbackRegion, name: '', subject: '', previewText: '', fromName: newsletter?.fromName ?? '', fromEmail: newsletter?.from ?? '', replyTo: [], listId: newsletter?.id ?? '', segmentId: null, html: '', defaults: {} })
  // A campaign to a newsletter's list is its issue: the page says so and goes back to the newsletter, and the sidebar marks it.
  const issueOf = useNewsletterOf(form.listId), thing = issueOf ? 'issue' : 'campaign'
  useShowNewsletter(issueOf?.id ?? null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  // Body placeholders are known from the last saved body; subject and inbox preview are read as they are typed.
  const [bodyKeys, setBodyKeys] = useState(() => placeholders(initial?.html))
  const [replyToText, setReplyToText] = useState(() => (initial?.replyTo ?? []).join(', '))
  // Checked once you leave the field, not on every keystroke of an address still being typed.
  const [replyToLeft, setReplyToLeft] = useState(true)
  const formRef = useRef(form)
  function updateForm(next: CampaignInput) { formRef.current = next; setForm(next) }
  const editVersion = useRef(0)
  const [edits, setEdits] = useState(0)
  const [autosaving, setAutosaving] = useState(false)
  const [autosavePaused, setAutosavePaused] = useState(false)
  const creation = useRef<{ input: CampaignInput; version: number; ambiguous?: boolean } | null>(null)
  const mounted = useRef(true)
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [generation, setGeneration] = useState(0)
  // A merge that took someone else's message or sender remounts just that part (rebase below).
  const [rebased, setRebased] = useState({ body: 0, sender: 0 })
  const [composerReady, setComposerReady] = useState(false)
  const readyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const [remote, setRemote] = useState<Campaign | null>(null)
  const remoteRef = useRef<Campaign | null>(null)
  const [reviewUpdate, setReviewUpdate] = useState(false)
  // Every attachment this page has seen on a version of the draft: where the composer finds an image the message shows
  // but the form no longer lists (after a merge), so no saved message refers to an image it doesn't attach.
  const seenAttachments = useRef(new Set(initial?.attachments ?? []))
  const rememberAttachments = (version: Campaign) => { for (const id of version.attachments ?? []) seenAttachments.current.add(id) }
  // Who made the saves the room announced, by revision, until that version reaches this page.
  const authors = useRef(new Map<number, Save['by']>())
  const [loadingLatest, setLoadingLatest] = useState(false)
  const refreshController = useRef<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const handleComposerReady = useCallback(() => { readyRef.current = true; setComposerReady(true) }, [])
  // Review's Edit message and Edit audience land on what they name: the message body or the recipient list, in view and focused.
  const { hash } = useLocation()
  useEffect(() => {
    if (!composerReady || hash !== '#message') return
    const target = document.querySelector<HTMLElement>('.composer-canvas [contenteditable="true"]')
    target?.scrollIntoView({ block: 'center', behavior: 'instant' })
    target?.focus({ preventScroll: true })
  }, [composerReady, hash])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(Boolean(initial?.previewText))
  const [senderOpen, setSenderOpen] = useState(false)
  const previewInput = useRef<HTMLInputElement>(null)
  const guard = useRef(false)
  // Write shows the latest version, so Review starts from it next time.
  useEffect(() => { if (initial?.id) readHere.delete(initial.id) }, [initial?.id])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; refreshController.current?.abort() }
  }, [])
  const [domainCursor, setDomainCursor] = useState<string | undefined>()
  const options = useApiQuery(['campaign-options', { pageSize: 100, domains: domainCursor }], async (api, signal) => {
    const domainPage = await api.domains.list({pageSize: 100, cursor: domainCursor, refresh: false}, signal)
    return { domains: domainPage.items.filter(domain => domain.status === 'verified'), next: domainPage.nextCursor }
  })
  const previousOptions = useRef<typeof options.data>(undefined)
  if (options.data) previousOptions.current = options.data
  const choices = options.data ?? previousOptions.current ?? { domains: [], next: null }
  const cache = useQueryClient()
  // Saves write the campaign into the cache instead of refetching every query on each autosave.
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input), undefined, false, false)
  const pending = preparing || autosaving || attachmentsBusy || composerBusy || saveMutation.isPending || loadingLatest
  busyRef.current = pending
  const markDirty = useCallback(() => { editVersion.current += 1; setEdits(editVersion.current); dirtyRef.current = true; setDirty(true); setError('') }, [])
  // Message edits made since the saved version (accepted): whether this person changed the message, for a merge.
  const bodyEdits = useRef(0), bodySaved = useRef(0), staleRetries = useRef(0)
  const handleComposerDirty = useCallback(() => { if (readyRef.current) { bodyEdits.current += 1; markDirty() } }, [markDirty])
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    updateForm({ ...formRef.current, [key]: value })
    markDirty()
  }
  function queueRemote(next: Campaign | null) { remoteRef.current = next; setRemote(next) }
  function applyRemote(next: Campaign) {
    // A manual reload and background poll can finish out of order. Never discard
    // a newer snapshot that arrived while the reload was in flight.
    if (remoteRef.current && olderCampaign(next, remoteRef.current)) next = remoteRef.current
    if (acceptedRef.current && olderCampaign(next, acceptedRef.current)) next = acceptedRef.current
    acceptedRef.current = next
    rememberAttachments(next)
    setAccepted(next)
    updateForm(campaignInput(next))
    setReplyToText(next.replyTo.join(', '))
    setAutosavePaused(false)
    creation.current = null
    dirtyRef.current = false
    setDirty(false)
    readyRef.current = false
    setComposerReady(readyRef.current)
    setGeneration(value => value + 1)
    bodySaved.current = bodyEdits.current
    staleRetries.current = 0
    setPreviewOpen(Boolean(next.previewText))
    queueRemote(null)
    setReviewUpdate(false)
    setTestOpen(false)
    setError('')
  }
  function receiveRemote(next: Campaign) {
    const baseline = acceptedRef.current
    if (!baseline || next.id !== baseline.id || campaignVersion(next) === campaignVersion(baseline)) return
    if (olderCampaign(next, baseline) || (remoteRef.current && olderCampaign(next, remoteRef.current))) return
    setTestOpen(false)
    if (busyRef.current) queueRemote(next)
    else if (!dirtyRef.current) applyRemote(next)
    else if (!rebase(next)) queueRemote(next)
    // The newest announced save this version includes names who made it, once.
    const revision = next.revision ?? 1, made = [...authors.current].filter(([at]) => at <= revision).sort(([a], [b]) => b - a)[0]
    for (const [at] of authors.current) if (at <= revision) authors.current.delete(at)
    if (made) toast(`${made[1].name} saved this ${thing}`, 'info')
  }
  // Someone else saved while this person has unsaved edits. Where only they changed a field, theirs lands; where only
  // this person did, the edit stays; where both did, `prefer` decides. Without one, nothing lands and the fields both
  // changed stay unmerged, and so does a version that can't take edits: null. Once it landed, what it took of theirs comes
  // back (maybe nothing), and autosave saves on their revision.
  function rebase(theirs: Campaign, prefer?: 'mine' | 'theirs'): Set<MergeField> | null {
    const base = acceptedRef.current
    if (!base || theirs.id !== base.id || olderCampaign(theirs, base) || theirs.archivedAt || !campaignEditable(theirs)) return null
    const { input, conflicts, taken } = mergeCampaign(campaignInput(base), formRef.current, campaignInput(theirs), bodyEdits.current !== bodySaved.current, prefer ?? 'mine')
    if (conflicts.length && !prefer) return null
    rememberAttachments(theirs)
    acceptedRef.current = theirs
    setAccepted(theirs)
    updateForm(input)
    if (taken.has('replyTo')) setReplyToText(theirs.replyTo.join(', '))
    if (taken.has('html')) { bodySaved.current = bodyEdits.current; readyRef.current = false; setComposerReady(false); setBodyKeys(placeholders(theirs.html)) }
    if (taken.has('html') || taken.has('sender')) setRebased(value => ({ body: value.body + Number(taken.has('html')), sender: value.sender + Number(taken.has('sender')) }))
    queueRemote(null)
    setReviewUpdate(false)
    setAutosavePaused(false)
    markDirty()
    return taken
  }
  const sync = useCampaignSync(accepted, receiveRemote)
  const { present, room } = useCampaignPresence(accepted?.id, 'write')
  // Someone else saved: read it now instead of at the next poll, and say who once it lands (receiveRemote).
  const self = room.self
  useEffect(() => room.onSave(save => { if (save.by.id !== self) authors.current.set(save.revision, save.by); sync.checkNow() }), [room.onSave, sync.checkNow, self])
  const current = remote ?? accepted
  const unavailable = Boolean(sync.error && 'status' in sync.error && [401, 403, 404].includes(Number(sync.error.status)))
  const readOnly = unavailable || Boolean(current && (current.archivedAt || !campaignEditable(current)))
  const controlsDisabled = preparing || attachmentsBusy || composerBusy || loadingLatest || readOnly
  const replyToProblem = replyToError(replyToText)
  const replyToValidation = replyToLeft ? replyToProblem : ''
  const unsubscribePageValidation = unsubscribePageError(form.unsubscribePageUrl)
  const fallbackKeys = [...new Set([...placeholders(form.subject, form.previewText), ...bodyKeys])].filter(key => key !== 'email')
  const saveDisabled = options.isPending || options.isError || !composerReady || readOnly || Boolean(remote) || Boolean(replyToProblem) || Boolean(unsubscribePageValidation)
  useEffect(() => {
    if (!dirty || pending || saveDisabled || autosavePaused || !form.name.trim()) return
    const timer = setTimeout(() => { void save('auto') }, 800)
    return () => clearTimeout(timer)
  }, [edits, dirty, pending, saveDisabled, autosavePaused, form.name])
  useEffect(() => { if (!remote || busyRef.current) return; if (!dirtyRef.current) applyRemote(remote); else rebase(remote) }, [remote, pending, dirty])
  // Both changed the same field: keep these edits there, or load theirs there. Everything else merges either way.
  // A version that can't take edits any more (sent, archived) has nothing to merge into: loading it drops yours.
  const remoteLocked = Boolean(remote && (remote.archivedAt || !campaignEditable(remote)))
  const conflicts = remote && accepted && !remoteLocked ? mergeCampaign(campaignInput(accepted), form, campaignInput(remote), bodyEdits.current !== bodySaved.current, 'mine').conflicts : []
  async function loadLatest(prefer: 'mine' | 'theirs') {
    if (!acceptedRef.current || pending) return
    const controller = new AbortController()
    refreshController.current?.abort()
    refreshController.current = controller
    setLoadingLatest(true)
    busyRef.current = true
    try {
      const latest = await api.campaigns.get(acceptedRef.current.id, controller.signal)
      if (controller.signal.aborted) return
      // The choice was about the version the dialog showed: a newer one is shown and asked about again.
      const shown = remoteRef.current
      if (dirtyRef.current && shown && campaignVersion(latest) !== campaignVersion(shown) && !olderCampaign(latest, shown)) { queueRemote(latest); return }
      // Theirs can't take edits any more (sent, archived): nothing to keep, so it simply loads.
      if (!dirtyRef.current || !rebase(latest, prefer)) applyRemote(latest)
    } catch (cause) { if (!controller.signal.aborted) toast(errorText(cause), 'error') }
    finally { if (!controller.signal.aborted) { setLoadingLatest(false); busyRef.current = false } }
  }
  const syncLabel = autosaving || preparing || saveMutation.isPending ? 'Saving…' : remote ? 'Update available' : autosavePaused ? 'Save failed' : error ? 'Check draft' : unavailable ? 'Unavailable' : readOnly ? 'Read only' : sync.connection === 'offline' ? 'Sync interrupted' : dirty ? form.name.trim() ? 'Unsaved changes' : 'Name required' : accepted ? 'Saved' : 'New draft'
  const syncActionable = Boolean(remote || error || autosavePaused || sync.connection === 'offline')
  const syncState = error || autosavePaused || sync.connection === 'offline' ? 'offline' : remote || dirty || autosaving ? 'changed' : sync.connection
  const syncTitle = error || sync.error?.message || (remote ? conflicts.length ? `You both changed ${mergeFieldsText(conflicts)}.` : 'A newer version is available.' : autosavePaused ? 'Autosave paused. Retry saving your changes.' : readOnly ? `This ${thing} is no longer editable.` : 'Changes save automatically and sync with MCP and the API.')
  function syncAction() { if (remote) setReviewUpdate(true); else if (autosavePaused) void save('edit'); else if (error) toast(error, 'error'); else sync.checkNow() }
  function reportError(value: string) { setError(value); toast(value, 'error') }
  async function save(next: 'auto' | 'edit' | 'review' | 'test') {
    if (guard.current || pending || !readyRef.current || readOnly) return
    const automatic = next === 'auto'
    if (remoteRef.current) { if (!automatic) setReviewUpdate(true); return }
    const continuing = next === 'review' || next === 'test'
    const input = creation.current?.input ?? formRef.current
    const version = creation.current?.version ?? editVersion.current
    const validation = !input.name.trim() ? issueOf ? 'Enter an issue name.' : 'Enter a campaign name.'
      : continuing && !input.subject.trim() ? 'Enter a subject before continuing.'
      : (continuing || input.fromEmail.trim()) && !emailIsValid(input.fromEmail.trim()) ? invalidSender
      : !multiTenant && (!input.regionId.trim() || input.regionId.trim().length > 40) ? 'Enter a region identifier of 1–40 characters.' : ''
    if (validation) { if (!automatic) reportError(validation); return }
    // An unchanged saved draft needs no new revision: open the test or review straight away.
    if (continuing && acceptedRef.current && !dirtyRef.current && !creation.current) {
      // A saved draft can still miss its message (an empty body): say so rather than open a test the API refuses.
      if (next === 'test') { if (campaignMessageReady(acceptedRef.current)) setTestOpen(true); else reportError(acceptedRef.current.html.trim() ? campaignReadinessError({ ...acceptedRef.current, listId: acceptedRef.current.listId || 'any' }) : 'Add some email content before sending a test.') }
      else navigate(campaignRoute(acceptedRef.current, 'review'))
      return
    }
    guard.current = true
    busyRef.current = true
    setError('')
    setAutosavePaused(false)
    if (automatic) setAutosaving(true)
    else setPreparing(true)
    const bodyVersion = bodyEdits.current
    let retry = false
    try {
      let submitted = creation.current?.input
      if (!submitted) {
        const content = await composer.current?.prepare()
        if (!content) throw new Error(composerLoading)
        if (continuing && !content.html.trim()) throw new Error('Add some email content before continuing.')
        submitted = { ...input, html: content.html, attachments: draftAttachments(input.attachments, content), defaults: Object.fromEntries(Object.entries(input.defaults ?? {}).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)), name: input.name.trim(), subject: input.subject.trim(), fromName: input.fromName.trim(), fromEmail: input.fromEmail.trim(), regionId: input.regionId.trim() }
        if (!submitted.id) {
          submitted.idempotencyKey = crypto.randomUUID()
          creation.current = { input: structuredClone(submitted), version }
        }
      }
      const saved = await saveMutation.mutateAsync(submitted)
      cache.setQueryData(['nightmail', 'campaign', saved.id], saved)
      void cache.invalidateQueries({queryKey: ['nightmail', 'campaigns'], refetchType: 'none'})
      if (!mounted.current) return
      creation.current = null
      const changedWhileSaving = editVersion.current !== version
      acceptedRef.current = saved
      bodySaved.current = bodyVersion
      staleRetries.current = 0
      announceSave(saved.id, saved.revision)
      setAccepted(saved)
      dirtyRef.current = changedWhileSaving
      setDirty(changedWhileSaving)
      queueRemote(remoteRef.current && olderCampaign(saved, remoteRef.current) ? remoteRef.current : null)
      rememberAttachments(saved)
      // Edited while saving: the form keeps its newer edits, and learns which attachments this save added or dropped
      // (an image the composer uploaded, one #583's pruning removed), so a later merge reads them as saved, not as removed.
      const sent = new Set(input.attachments ?? []), stored = new Set(saved.attachments ?? []), kept = (formRef.current.attachments ?? []).filter(id => !sent.has(id) || stored.has(id))
      updateForm({...formRef.current, id: saved.id, revision: saved.revision, draft: saved.draft, attachments: changedWhileSaving ? [...kept, ...(saved.attachments ?? []).filter(id => !sent.has(id) && !kept.includes(id))] : saved.attachments})
      const reviewing = next === 'review' && !changedWhileSaving
      if (!submitted.id && !reviewing) {
        preserveEditor(saved)
        navigate(campaignRoute(saved, 'edit'), { replace: true })
      }
      if (next === 'test' && !changedWhileSaving) setTestOpen(true)
      else if (reviewing) navigate(campaignRoute(saved, 'review'))
      setBodyKeys(placeholders(submitted.html))
    } catch (cause) {
      if (!mounted.current) return
      // Someone else saved first: lay these edits over their version and save again, a few times at most. Where you both
      // changed the same field, their version waits behind "Update available".
      if (cause instanceof ApiError && cause.code === 'STALE_CAMPAIGN_REVISION' && acceptedRef.current && staleRetries.current < 3) {
        staleRetries.current += 1
        const latest = await api.campaigns.get(acceptedRef.current.id).catch(() => null)
        if (!mounted.current) return
        const taken = latest && rebase(latest)
        // Continue and Send test act on what this person saw: when the merge brought in someone else's change, it
        // stops and shows it instead of going on with it.
        if (taken) { retry = !automatic && !(continuing && taken.size); if (continuing && taken.size) toast(`Someone else changed this ${thing}. Check it, then try again.`, 'info'); return }
        if (latest) { queueRemote(latest); if (!automatic) setReviewUpdate(true); return }
      }
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0
      if (creation.current) {
        if (!creation.current.ambiguous && status >= 400 && status < 500 && status !== 408) creation.current = null
        else creation.current.ambiguous = true
      }
      setAutosavePaused(true)
      if (automatic) setError(errorText(cause))
      else reportError(errorText(cause))
      sync.checkNow()
    } finally {
      guard.current = false
      if (mounted.current) { setPreparing(false); setAutosaving(false) }
    }
    if (retry) void save(next)
  }
  // In-app links ask before dropping edits autosave hasn't stored: a draft without a name, a failed save, or typing
  // inside autosave's 800 ms wait. Closing or reloading the tab gets the browser's prompt.
  const leaveGuard = useLeaveGuard(dirty || autosavePaused, { what: `this ${thing}`, save: async () => { await save('edit'); return !dirtyRef.current && !creation.current } })
  const senderValidation = replyToValidation
  const senderDetailsOpen = senderOpen || Boolean(senderValidation)
  const toggleSender = () => { const next = !senderOpen; setSenderOpen(next); if (next) requestAnimationFrame(() => document.getElementById('campaign-reply-to')?.focus({ preventScroll: true })) }
  const review = () => void save('review')
  // ⌘↩ (Ctrl+Enter) continues to Review whenever Continue could, from anywhere in the studio, the email included: it is
  // read before the editor's own Mod-Enter (a line break), which Shift+Enter still makes.
  const blocked = saveDisabled || pending || autosavePaused
  const continueKey = useRef<(() => void) | undefined>(undefined)
  continueKey.current = blocked ? undefined : review
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.isComposing || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault(); event.stopPropagation()
      if (!event.repeat) continueKey.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return <div className="campaign-compose-page campaign-studio">
    <CampaignBar back={issueOf ? newsletterPath(issueOf.id) : undefined} crumb={issueOf?.name ?? 'Campaigns'} title={<>
      <h1 className="sr-only">{issueOf ? accepted ? 'Edit issue' : 'New issue' : accepted ? 'Edit campaign' : 'Create campaign'}</h1>
      <Input id="campaign-name" className="studio-name" aria-label={issueOf ? 'Issue name' : 'Campaign name'} placeholder={issueOf ? 'Untitled issue' : 'Untitled campaign'} value={form.name} onChange={event => change('name', event.target.value)} required disabled={controlsDisabled} />
    </>} status={<StatusBadge status={accepted?.status ?? 'draft'} tone={accepted?.status === 'failed' ? 'danger' : 'neutral'} />} steps={<CampaignSteps step="write" onReview={blocked ? undefined : review} />} actions={<>
      <CampaignPresence present={present} room />
      {!phone && <div className="campaign-sync-status" role="status" data-state={syncState} data-actionable={syncActionable || undefined} title={syncTitle}>
        <span className="campaign-sync-dot" aria-hidden="true" />
        {syncActionable ? <Button variant="ghost" size="sm" disabled={pending} onClick={syncAction}>{syncLabel}</Button> : <span>{syncLabel}</span>}
      </div>}
      {phone ? <>
        <Button variant="primary" disabled={blocked} loading={preparing} onClick={review}>Continue</Button>
        <DropdownMenu label="More actions" trigger={<IconButton label={syncActionable ? `More actions. ${syncLabel}` : 'More actions'} className="campaign-menu-trigger" data-state={syncActionable ? syncState : undefined}><MoreHorizontal size={16} /></IconButton>} items={[
          ...(syncActionable ? [{ label: `${syncLabel} · ${remote ? 'Choose' : error && !autosavePaused ? 'Details' : 'Retry'}`, hint: syncTitle, disabled: pending, onSelect: syncAction }] : []),
          // A new draft offers a template; once it has saved (named), a test send.
          ...(accepted ? [{ label: 'Send test', disabled: saveDisabled || pending || autosavePaused, onSelect: () => void save('test') }] : [{ label: 'Use a template', disabled: pending, onSelect: () => setTemplatesOpen(true) }]),
        ]} />
      </> : <>
        {!accepted && <Button variant="ghost" disabled={pending} onClick={() => setTemplatesOpen(true)}>Use a template</Button>}
        <Button variant="secondary" disabled={!accepted || blocked} title={!accepted ? `Name the ${thing} first` : undefined} onClick={() => save('test')}>Send test</Button>
        <Button variant="primary" disabled={blocked} loading={preparing} onClick={review} aria-keyshortcuts="Meta+Enter Control+Enter" data-analytics="campaigns/review">Continue<kbd className="ui-kbd" aria-hidden="true">{modKey}↩</kbd></Button>
      </>}
    </>} />
    {options.isError && <ErrorState error={options.error} onRetry={() => options.refetch()} />}
    <PresenceOverlay room={room} />
    <section className="campaign-compose-workspace" aria-label={issueOf ? 'Issue composer' : 'Campaign composer'}>
      <div className="campaign-compose-scroll">
        <div className="studio-notices"><Notices /></div>
        <div className="campaign-compose-sheet">
          <div className="campaign-compose-metadata">
            <div className="campaign-compose-row campaign-compose-sender"><label htmlFor="campaign-from-email">From</label><CampaignSenderInput key={`${generation}.${rebased.sender}`} name={form.fromName} email={form.fromEmail} domains={choices.domains.map(domain => domain.name)} disabled={controlsDisabled || options.isPending} onChange={({name, email}) => {const domain = email.split('@')[1]?.toLowerCase(); const supports = (parent: string) => domain === parent || domain?.endsWith(`.${parent}`); const match = choices.domains.find(item => supports(item.name) && item.regionId === formRef.current.regionId) ?? choices.domains.find(item => supports(item.name)); if (name !== formRef.current.fromName || email !== formRef.current.fromEmail || (match && match.regionId !== formRef.current.regionId)) updateForm({...formRef.current, fromName: name, fromEmail: email, ...(match ? {regionId: match.regionId} : {})}); markDirty()}} /><Button variant="ghost" size="sm" className="campaign-sender-toggle" aria-expanded={senderDetailsOpen} aria-controls="campaign-sender-details" onClick={toggleSender}>Reply-To<Icon icon={ChevronRight} size="sm" /></Button></div>
            <div id="campaign-sender-details" className="campaign-compose-preview" data-open={senderDetailsOpen || undefined} aria-hidden={!senderDetailsOpen} inert={!senderDetailsOpen}>
              <div>
                <div className="campaign-compose-row"><label htmlFor="campaign-reply-to">Reply-To</label><Input id="campaign-reply-to" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="reply@example.com" value={replyToText} aria-invalid={Boolean(replyToValidation) || undefined} aria-describedby={replyToValidation ? 'campaign-reply-to-error' : undefined} onChange={event => { const value = event.target.value; setReplyToText(value); setReplyToLeft(false); updateForm({...formRef.current, replyTo: replyToAddresses(value)}); markDirty() }} onBlur={() => setReplyToLeft(true)} disabled={controlsDisabled} /></div>
                {replyToValidation && <div id="campaign-reply-to-error" className="campaign-compose-feedback ui-field__error" role="alert">{replyToValidation}</div>}
              </div>
            </div>
            {(domainCursor || choices.next) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setDomainCursor(undefined)}>First domains</Button><Button disabled={!choices.next} onClick={() => setDomainCursor(choices.next ?? undefined)}>More domains</Button></div>}
            {!options.isPending && choices.domains.length === 0 && <div className="campaign-compose-feedback campaign-note" data-tone="warning"><span>No verified domains on this page · <Link to="/domains">Add a domain</Link></span></div>}
            <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="campaign-subject">Subject</label><Input id="campaign-subject" placeholder="Add a subject" value={form.subject} onChange={event => change('subject', event.target.value)} disabled={controlsDisabled} /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled={controlsDisabled} aria-expanded={previewOpen} aria-controls="campaign-preview-row" onClick={() => {setPreviewOpen(!previewOpen); if (!previewOpen) requestAnimationFrame(() => previewInput.current?.focus({preventScroll: true}))}}>Preview text</Button></div>
            <div id="campaign-preview-row" className="campaign-compose-preview" data-open={previewOpen || undefined} aria-hidden={!previewOpen} inert={!previewOpen}>
              <div><div className="campaign-compose-row"><label htmlFor="campaign-preview">Preview</label><Input ref={previewInput} id="campaign-preview" aria-label="Preview text" maxLength={200} placeholder="Shown after the subject" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={controlsDisabled} /></div></div>
            </div>
          </div>
          <ChunkFallback.Provider value={<ComposerSkeleton />}><EmailComposer key={`${generation}.${rebased.body}`} ref={composer} personalize attachmentIds={form.attachments ?? []} knownAttachmentIds={[...seenAttachments.current]} initialHtml={form.html} disabled={controlsDisabled} onReady={handleComposerReady} onDirty={handleComposerDirty} onBusy={value => {busyRef.current = value || attachmentsBusy || guard.current || loadingLatest; setComposerBusy(value); if (value) markDirty()}} onAttach={() => {markDirty(); attachments.current?.open()}} /></ChunkFallback.Provider>
          <CampaignAttachments key={`attachments:${generation}`} ref={attachments} ids={form.attachments ?? []} persisted={form.draft?.attachments ?? []} body={form.draft?.html ?? form.html} shown={composerReady} onChange={ids => change('attachments', ids)} onBusy={value => {busyRef.current = value || guard.current || loadingLatest; setAttachmentsBusy(value)}} disabled={preparing || autosaving || saveMutation.isPending || composerBusy || loadingLatest || readOnly} />
          {/* Every contact has an email, so {{email}} needs no fallback and no row. */}
          {fallbackKeys.length > 0 && <section className="campaign-personalize" aria-labelledby="campaign-personalize-title">
            <h2 className="campaign-personalize__lead" id="campaign-personalize-title">Fallbacks</h2>
            {fallbackKeys.map(key => <div key={key} className="campaign-compose-row"><label htmlFor={`campaign-fallback-${key}`}>{`{{${key}}}`}</label><Input id={`campaign-fallback-${key}`} placeholder={key === 'name' || key === 'firstName' ? 'there' : undefined} value={form.defaults?.[key] ?? ''} aria-invalid={!form.defaults?.[key]?.trim() || undefined} onChange={event => change('defaults', { ...formRef.current.defaults, [key]: event.target.value })} disabled={controlsDisabled} /></div>)}
          </section>}
        </div>
      </div>
    </section>
    <Dialog open={reviewUpdate} onOpenChange={value => {if (!loadingLatest) setReviewUpdate(value)}} title={conflicts.length ? `You both changed ${mergeFieldsText(conflicts)}` : `This ${thing} changed elsewhere`} description={remoteLocked ? 'It can’t be edited any more. Loading it discards your unsaved changes.' : 'Your other edits stay either way.'} footer={remoteLocked ? <Button variant="primary" loading={loadingLatest} onClick={() => void loadLatest('theirs')}>Load latest</Button> : <><Button disabled={loadingLatest} onClick={() => void loadLatest('theirs')}>Load theirs</Button><Button variant="primary" loading={loadingLatest} onClick={() => void loadLatest('mine')}>Keep mine</Button></>}>{null}</Dialog>
    {accepted && testOpen && <TestEmailDialog campaign={accepted} open={testOpen} onOpenChange={setTestOpen} />}
    {templatesOpen && <TemplatePickerDialog onOpenChange={setTemplatesOpen} />}
    {leaveGuard}
  </div>
}

function TestEmailDialog({ campaign, open, onOpenChange }: { campaign: Campaign; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const guard = useRef(false)
  // Placeholders without a fallback need a sample value, or the test can't render.
  const fallbacks = campaign.draft?.defaults ?? {}
  const samples = placeholders(campaign.subject, campaign.previewText, campaign.html).filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  const [data, setData] = useState<Record<string, string>>(() => Object.fromEntries(samples.map(key => [key, key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : ''])))
  const [sent, setSent] = useState<{ to: string; id?: string } | null>(null)
  const mutation = useApiMutation((api, input: { id: string; to: string; data: Record<string, string> }) => api.campaigns.test(input), undefined, false, invalidate.campaignTest)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (guard.current || mutation.isPending) return
    if (!emailIsValid(to.trim())) { setError('Recipient email: enter an address like you@example.com.'); return }
    const missing = samples.find(key => !data[key]?.trim())
    if (missing) { setError(`Sample {{${missing}}}: enter a value to show in the test, or add a fallback in the editor.`); return }
    setError('')
    guard.current = true
    try {
      const result = await mutation.mutateAsync({ id: campaign.id, to: to.trim(), data: Object.fromEntries(samples.map(key => [key, data[key]!.trim()])) })
      if (!result.accepted) { setError('The test wasn’t accepted. Try again.'); return }
      setSent({ to: to.trim(), id: result.id })
    } catch (cause) { setError(errorText(cause)) }
    finally { guard.current = false }
  }
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setError(''); onOpenChange(value) } }} title="Send test email">
    {sent ? <div className="stack">
      <p className="campaign-note" data-tone="success" role="status"><span>Test sent to <PrivateAddress value={sent.to} />.{sent.id && <> <Link to={`/logs/${encodeURIComponent(sent.id)}`}>View in Logs</Link></>}</span></p>
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" onClick={() => { setSent(null); mutation.reset() }}>Send another</Button><Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></div>
    </div> : <form className="stack" onSubmit={submit} noValidate>
      <Field label="Recipient email" htmlFor="campaign-test-recipient"><Input id="campaign-test-recipient" type="email" autoComplete="email" autoFocus value={to} onChange={event => { setTo(event.target.value); setError('') }} disabled={mutation.isPending} /></Field>
      {samples.map(key => <Field key={key} label={`Sample {{${key}}}`} htmlFor={`campaign-test-${key}`}><Input id={`campaign-test-${key}`} value={data[key] ?? ''} onChange={event => { setData({ ...data, [key]: event.target.value }); setError('') }} disabled={mutation.isPending} /></Field>)}
      {error && <p className="campaign-note" data-tone="danger" role="alert">{error}</p>}
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" loading={mutation.isPending}>Send test</Button></div>
    </form>}
  </Dialog>
}

// Lightweight controls when GET /v1/campaigns/{id} fails (e.g. 422 READ_TOO_LARGE on a 1.8M send):
// reads GET /v1/campaigns/{id}/state (single row, no counts) so Pause, Resume, Unschedule and Cancel stay usable.
function CampaignControlFallback({ id, state, error, refreshing, onRetry }: { id: string; state: import('../../data/types').CampaignState; error: unknown; refreshing: boolean; onRetry: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const toast = useToast()
  const { canAdminister } = useWorkspaceAccess()
  const [confirm, setConfirm] = useState<'cancel' | 'unschedule' | null>(null)
  const [busy, setBusy] = useState<'pause' | 'resume' | 'unschedule' | 'cancel' | null>(null)
  const [actionError, setActionError] = useState('')
  const active = ['preparing', 'sending'].includes(state.status)
  const paused = state.status === 'paused' || state.status === 'failed'
  const scheduled = state.status === 'scheduled'
  const cancellable = !state.archivedAt && (active || paused)
  async function run(kind: 'pause' | 'resume' | 'unschedule', call: () => Promise<Campaign>, message: string) {
    setBusy(kind); setActionError('')
    try {
      const next = await call()
      toast(message, 'success')
      cache.setQueryData(['nightmail', 'campaign', id], next)
      void cache.invalidateQueries({ queryKey: ['nightmail', 'campaign-state', id] })
      void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' })
    } catch (cause) { setActionError(errorText(cause)) }
    finally { setBusy(null) }
  }
  async function cancel() {
    setBusy('cancel'); setActionError('')
    try {
      const result = await api.campaigns.cancel(id)
      toast(`Campaign canceled · ${number(result.canceled)} not sent`, 'success')
      setConfirm(null)
      void cache.invalidateQueries({ queryKey: ['nightmail', 'campaign-state', id] })
      void cache.invalidateQueries({ queryKey: ['nightmail', 'campaign', id] })
      void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' })
    } catch (cause) { setActionError(errorText(cause)) }
    finally { setBusy(null) }
  }
  return <div className="campaign-review">
    <CampaignBar back={state.archivedAt ? '/campaigns?archived=true' : '/campaigns'} title={<h1 className="studio-title">Campaign</h1>}
      actions={<><Link className="ui-button ui-button--secondary ui-button--md" to={campaignLogs(id)}>View logs</Link><StatusBadge status={campaignDisplayStatus(state)} /></>} />
    <div className="campaign-review__body stack">
      <div className="campaign-scheduled" data-tone="warning" role="status">
        <div className="campaign-scheduled__text">
          <strong>Live counts unavailable</strong>
          <span className="muted">{errorText(error, 'Couldn’t load campaign counts.')}</span>
        </div>
        <div className="cluster">
          {active && canAdminister && <Button variant="secondary" size="sm" loading={busy === 'pause'} disabled={busy !== null} onClick={() => void run('pause', () => api.campaigns.pause(id), 'Sending paused')}>Pause</Button>}
          {paused && canAdminister && <Button variant="primary" size="sm" loading={busy === 'resume'} disabled={busy !== null} onClick={() => void run('resume', () => api.campaigns.resume(id), 'Sending resumed')}>Resume</Button>}
          {scheduled && canAdminister && <Button variant="secondary" size="sm" loading={busy === 'unschedule'} disabled={busy !== null} onClick={() => setConfirm('unschedule')}>Unschedule</Button>}
          {cancellable && canAdminister && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm('cancel')}>Cancel campaign</Button>}
          <Button variant="secondary" size="sm" loading={refreshing} disabled={busy !== null} onClick={onRetry}>Retry</Button>
        </div>
      </div>
      {actionError && <p className="campaign-note" data-tone="danger" role="alert">{actionError}</p>}
    </div>
    <ConfirmDialog open={confirm === 'cancel'} onOpenChange={open => { if (!open) setConfirm(null) }} danger title="Cancel this campaign?" description="Queued emails are canceled and remaining recipients won’t get it. Sent emails stay sent. You can’t undo this." confirmLabel="Cancel campaign" pending={busy === 'cancel'} onConfirm={cancel} />
    <ConfirmDialog open={confirm === 'unschedule'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Unschedule this campaign?" description="It becomes a draft again and won’t send." confirmLabel="Unschedule" pending={busy === 'unschedule'} onConfirm={async () => { await run('unschedule', () => api.campaigns.unschedule(id), 'Unscheduled. The campaign is a draft again.'); setConfirm(null) }} />
  </div>
}

const reviewDisplayQuery = (campaign: Campaign) => {
  const revision = campaign.revision ?? 0, check = !campaignReadinessError(campaign)
  return {
    key: ['campaign-review-display', campaign.id, revision, check],
    read: (api: Api, signal: AbortSignal) => api.campaigns.reviewDisplay(campaign.id, revision, check, signal),
  }
}

function reviewCheckError(part: CampaignReviewDisplay['check'], requestError: Error | null) {
  if (!part?.error) return requestError
  const failure = part.error
  const error = new ApiError(failure.message, failure.code, failure.field ? { [failure.field]: failure.message } : {}, failure.requestId, part.status)
  error.details = failure.details
  error.retryable = failure.retryable
  error.retryAfter = part.retryAfter
  return error
}

export function CampaignReviewPage() {
  const { id = '' } = useParams()
  const query = useApiDef(queries.campaign(id), { interval: campaignPollInterval })
  // If detail fails (e.g. 422 READ_TOO_LARGE on a large send), fall back to compact /state so Pause & Cancel stay usable.
  const missingOrDenied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status ?? 0)
  const fallbackState = useApiQuery(['campaign-state', id], (api, signal) => api.campaigns.state(id, signal), { enabled: query.isError && !query.data && !missingOrDenied })
  // The polled review learns of a finished or paused send before the cached Campaigns list does.
  useRefreshListsOnChange('campaigns', query.data?.status ?? fallbackState.data?.status)
  const stats = useCampaignStats(query.data)
  // Whether a draft may be a required notice is read beside it, so the Recipients choice is there from the first frame.
  const settings = useApiDef(queries.workspaceSettings())
  const editableDraft = Boolean(query.data && !query.data.archivedAt && campaignEditable(query.data))
  const prefetch = usePrefetchQueries()
  useEffect(() => {
    const saved = query.data
    if (!saved || !editableDraft || !settings.isPending) return
    const revision = saved.revision ?? 0
    const previous = readHere.get(saved.id)
    // Don't warm a newer revision over one held for approval. Leave that decision to useReadCampaign at mount.
    if (previous && (previous.revision ?? 0) < revision) return
    if (saved.listId) void prefetch([reviewDisplayQuery(saved)])
  }, [query.data, editableDraft, settings.isPending, prefetch])
  const refetch = query.refetch
  const refresh = useCallback(() => void refetch({ cancelRefetch: false }), [refetch])
  const waitingStats = Boolean(query.data && campaignFinished(query.data) && stats.isPending && stats.errorUpdateCount === 0)
  if (query.isPending || (query.isError && !query.data && !missingOrDenied && fallbackState.isPending) || waitingStats || (editableDraft && settings.isPending)) return <CampaignRouteSkeleton kind="review" />
  if (!query.data) return fallbackState.data ? <CampaignControlFallback id={id} state={fallbackState.data} error={query.error} refreshing={query.isFetching} onRetry={() => void query.refetch()} /> : <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <CampaignReview key={id} campaign={query.data} stats={stats} settings={settings} stale={query.isError} refreshing={query.isFetching} refresh={refresh} />
}

// The server renders block HTML into the styled email; the review shows that rendering, not the blocks.
function CampaignRenderedPreview({ campaign, transform = html => html }: { campaign: Campaign; transform?: (html: string) => string }) {
  const preview = useApiQuery(['campaign-preview', campaign.id, campaign.revision], (api, signal) => api.campaigns.preview(campaign.id, signal))
  if (preview.isPending) return <div className="ui-email-preview campaign-preview-loading" role="status"><SkeletonText width="55%" lineHeight={28} /><SkeletonText /><SkeletonText width="80%" /></div>
  if (preview.isError) return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
  return <EmailPreview html={transform(preview.data.html)} title="Campaign email preview" attachmentIds={campaign.attachments} respectStyles remoteImages />
}
// A schedule that has released nobody yet can still move or go back to a draft.
const unreleasedSchedule = (campaign: Campaign) => Boolean(campaign.scheduledAt) && ['preparing', 'scheduled', 'paused'].includes(campaign.status) && (campaign.delivery?.expanded ?? 0) === 0
const sampleValue = (key: string) => key === 'email' ? 'sam@example.com' : key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : `[${key}]`
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

// A Review change saved on the version it was read at; if someone saved since, it goes again on theirs, unless they
// changed the same thing (then the stale-revision error stands and the page reloads the campaign).
async function saveChange(api: ReturnType<typeof useApi>, campaign: Campaign, change: Partial<CampaignInput>) {
  const mine = { ...campaignInput(campaign), ...change }
  try { return await api.campaigns.save(mine) }
  catch (cause) {
    if (!(cause instanceof ApiError && cause.code === 'STALE_CAMPAIGN_REVISION')) throw cause
    // Review is where the message is approved: a save here never brings in a change this page didn't show. When anything
    // of theirs would be taken, or their message differs by a single byte (the merge compares messages as the composer
    // reads them, which evens some changes out, such as a link it can't import), the stale-revision error stands, as
    // does Send's until the page is read again.
    const base = campaignInput(campaign), latest = campaignInput(await api.campaigns.get(campaign.id))
    const { input, conflicts, taken } = mergeCampaign(base, mine, latest, false, 'mine')
    if (conflicts.length || taken.size || latest.html !== base.html || String(latest.attachments ?? []) !== String(base.attachments ?? [])) throw cause
    return api.campaigns.save(input)
  }
}

// The revisions of each campaign this tab saved itself, or this person saved in another tab (the room says so): what
// Review shows without asking (useReadCampaign).
const savedHere = new Map<string, Set<number>>()
const noteSaved = (id: string, revision: number | undefined) => { if (revision) (savedHere.get(id) ?? savedHere.set(id, new Set()).get(id)!).add(revision) }
function useCampaignCache() {
  const cache = useQueryClient()
  return (next: Campaign) => { noteSaved(next.id, next.revision); cache.setQueryData(['nightmail', 'campaign', next.id], next); void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' }); announceSave(next.id, next.revision) }
}
// A Review write the API refused because the draft changed meanwhile: read the campaign again, so the page learns of the
// newer version (and holds it, useReadCampaign) instead of only saying it failed.
function useStaleRefetch() {
  const cache = useQueryClient()
  return (cause: unknown, id: string) => { if (cause instanceof ApiError && cause.code === 'STALE_CAMPAIGN_REVISION') void cache.invalidateQueries({ queryKey: ['nightmail', 'campaign', id] }) }
}

// Review is where a draft is approved, so it shows the version this person has read and never puts a newer one in its
// place by itself. However a teammate's or an agent's save arrives (the room's announcement, a refetch after a refused
// write, a reconnect, a write that refreshes the page), it waits behind a note that says who saved, until they choose
// "Read it again"; meanwhile Send and Schedule carry the revision read, so the API refuses them (409). Shown at once:
// every revision this tab or this person saved (savedHere), and a draft that stopped being one (sent, scheduled,
// archived), where there is nothing left to approve.
// What Review last showed of each campaign in this tab, so leaving the page and coming back keeps a newer version held.
const readHere = new Map<string, Campaign>()
function useReadCampaign(latest: Campaign, room: Room, refresh: () => void) {
  const [read, setRead] = useState(() => { const kept = readHere.get(latest.id); return kept && (kept.revision ?? 1) < (latest.revision ?? 1) ? kept : latest })
  useEffect(() => { readHere.set(read.id, read) }, [read])
  const [authors, setAuthors] = useState<ReadonlyMap<number, string>>(new Map())
  const editable = (version: Campaign) => !version.archivedAt && campaignEditable(version)
  const from = read.revision ?? 1, to = latest.revision ?? 1
  const unread = read.id === latest.id && editable(read) && editable(latest) && to > from
    && Array.from({ length: to - from }, (_, i) => from + 1 + i).some(revision => !savedHere.get(latest.id)?.has(revision))
  useEffect(() => { if (!unread && read !== latest) setRead(latest) }, [unread, read, latest])
  const latestRef = useRef(latest), refreshRef = useRef(refresh)
  latestRef.current = latest; refreshRef.current = refresh
  useEffect(() => room.onSave(save => {
    // Announcements of what the page already has say nothing new (and can't name the next save's author).
    if (save.revision <= (latestRef.current.revision ?? 1)) return
    if (save.by.id === room.self) noteSaved(latestRef.current.id, save.revision)
    else setAuthors(names => new Map(names).set(save.revision, save.by.name))
    refreshRef.current()
  }), [room.onSave, room.self])
  const by = unread ? [...new Set([...authors].filter(([revision]) => revision > from && revision <= to).map(([, name]) => name))] : []
  return { campaign: unread ? read : latest, unread, by, readAgain: () => { setRead(latest); setAuthors(new Map()) } }
}

function ScheduledBanner({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const navigate = useNavigate()
  const toast = useToast()
  const accept = useCampaignCache()
  const { canAdminister } = useWorkspaceAccess()
  const [dialog, setDialog] = useState<'reschedule' | 'edit' | 'unschedule' | null>(null)
  const at = campaign.scheduledAt!
  const total = campaign.delivery?.total ?? campaign.recipients
  async function unschedule(edit: boolean) {
    accept(await api.campaigns.unschedule(campaign.id))
    toast(edit ? 'Unscheduled. Schedule it again after editing.' : 'Unscheduled. The campaign is a draft again.', 'success')
    if (edit) navigate(campaignRoute(campaign, 'edit'))
  }
  const blocked = canAdminister ? undefined : 'Only owners and admins can change a schedule.'
  return <>
    <div className="campaign-scheduled" role="status">
      <div className="campaign-scheduled__text"><strong>Scheduled for {utcLabel(at)}</strong><span className="muted">{localLabel(at)} · {number(total)} {total === 1 ? 'recipient' : 'recipients'}</span></div>
      <div className="cluster"><Button size="sm" disabled={!canAdminister} title={blocked} onClick={() => setDialog('reschedule')}>Reschedule</Button><Button size="sm" disabled={!canAdminister} title={blocked ?? 'Unschedules it so you can edit; schedule it again afterwards'} onClick={() => setDialog('edit')}>Edit</Button><Button size="sm" variant="ghost" disabled={!canAdminister} title={blocked} onClick={() => setDialog('unschedule')}>Unschedule</Button></div>
    </div>
    <ConfirmDialog open={dialog === 'edit'} onOpenChange={open => setDialog(open ? 'edit' : null)} title="Edit this campaign?" description="Editing turns it back into a draft. Schedule it again when you’re done." confirmLabel="Unschedule and edit" onConfirm={() => unschedule(true)} />
    <ConfirmDialog open={dialog === 'unschedule'} onOpenChange={open => setDialog(open ? 'unschedule' : null)} title="Unschedule this campaign?" description="It becomes a draft again and won’t send." confirmLabel="Unschedule" onConfirm={() => unschedule(false)} />
    {dialog === 'reschedule' && <RescheduleDialog campaign={campaign} onClose={() => setDialog(null)} />}
  </>
}

function RescheduleDialog({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache()
  const [value, setValue] = useState(() => campaign.scheduledAt!.slice(0, 16))
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // Single flight: a second Reschedule before the first answers would send the same change again.
  const reschedule = useSingleFlight('campaigns.reschedule', async (at: string) => {
    setPending(true)
    try { const next = await api.campaigns.reschedule(campaign.id, at); accept(next); toast(`Rescheduled for ${utcLabel(next.scheduledAt!)}`, 'success'); onClose() }
    catch (cause) { setError(errorText(cause)) }
    finally { setPending(false) }
  }, campaign.id)
  function submit(event: FormEvent) {
    event.preventDefault()
    const problem = scheduleError(value)
    if (problem) { setError(problem); return }
    void reschedule(parseUtc(value)!.toISOString())
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }} title="Reschedule campaign">
    <form className="stack" onSubmit={submit} noValidate>
      <ScheduleField id="campaign-reschedule" value={value} onChange={next => { setValue(next); setError('') }} error={error} disabled={pending} />
      <div className="cluster campaign-dialog-actions"><Button type="button" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={pending}>Reschedule</Button></div>
    </form>
  </Dialog>
}

// Stops a campaign that is sending, paused or failed after releasing some recipients; emails already sent stay sent.
function CancelCampaignButton({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const toast = useToast()
  const cache = useQueryClient()
  const { canAdminister } = useWorkspaceAccess()
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" disabled={!canAdminister} title={canAdminister ? 'Stop releasing recipients and cancel queued emails' : 'Only owners and admins can cancel campaigns.'} onClick={() => setOpen(true)}>Cancel campaign</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} danger title="Cancel this campaign?" description="Queued emails are canceled and remaining recipients won’t get it. Sent emails stay sent. You can’t undo this." confirmLabel="Cancel campaign" onConfirm={async () => { const result = await api.campaigns.cancel(campaign.id); toast(`Campaign canceled · ${number(result.canceled)} not sent`, 'success'); await cache.invalidateQueries({ queryKey: ['nightmail', 'campaign', campaign.id] }); void cache.invalidateQueries({ queryKey: ['nightmail', 'campaigns'], refetchType: 'none' }) }} />
  </>
}

type ReviewRowId = 'to' | 'message' | 'score' | 'when'
// A Review stage: a numbered card whose header says what is set; the open one fills the page, and Next moves on.
function ReviewStage({ n, id, title, summary, done, open, onOpen, footer, children }: { n: number; id: ReviewRowId; title: string; summary: ReactNode; done: boolean; open: boolean; onOpen: () => void; footer?: ReactNode; children: ReactNode }) {
  return <section className="review-stage" data-open={open || undefined} aria-labelledby={`review-${id}-title`}>
    <button type="button" className="review-stage__head" aria-expanded={open} aria-controls={`review-${id}`} onClick={onOpen}>
      <span className="campaign-steps__mark review-stage__mark" data-done={(done && !open) || undefined} aria-hidden="true">{done && !open ? <Check size={12} /> : n}</span>
      <span className="review-stage__title" id={`review-${id}-title`}>{title}</span>
      <span className="review-stage__summary">{summary}</span>
    </button>
    <div id={`review-${id}`} className="review-stage__body" inert={!open} aria-hidden={!open}>
      <div className="review-stage__content">{children}</div>
      {footer && <div className="review-stage__footer">{footer}</div>}
    </div>
  </section>
}

// The campaign's own unsubscribe page, if it has one: saved when you leave the field.
function UnsubscribePageField({ campaign, disabled }: { campaign: Campaign; disabled?: boolean }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache()
  const staleRefetch = useStaleRefetch()
  const [value, setValue] = useState(campaign.unsubscribePageUrl ?? '')
  const [left, setLeft] = useState(true)
  const [saving, setSaving] = useState(false)
  // The page moved to another version of the draft (read again, or this person's own save): the field follows, unless
  // it is being typed in, so leaving it never writes back the old value.
  useEffect(() => { if (left) setValue(campaign.unsubscribePageUrl ?? '') }, [campaign.unsubscribePageUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  const problem = unsubscribePageError(value)
  async function save() {
    setLeft(true)
    const next = value.trim()
    if (problem || next === (campaign.unsubscribePageUrl ?? '')) return
    setSaving(true)
    try { accept(await saveChange(api, campaign, { unsubscribePageUrl: next })) }
    catch (cause) { toast(errorText(cause), 'error'); staleRefetch(cause, campaign.id) }
    finally { setSaving(false) }
  }
  return <Field label="Unsubscribe page" htmlFor="campaign-unsubscribe-page" error={left ? problem : ''}><Input id="campaign-unsubscribe-page" type="url" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={1000} placeholder={`${productName}’s page`} value={value} aria-invalid={(left && Boolean(problem)) || undefined} onChange={event => { setValue(event.target.value); setLeft(false) }} onBlur={() => void save()} disabled={disabled || saving} /></Field>
}

// The Review step's recipient list and segment, and where an operator allowed it the campaign's kind: choosing one
// saves the draft, and the counts under it follow.
function useReviewAudienceOptions(campaign: Campaign, enabled: boolean) {
  const [cursor, setCursor] = useState<string | undefined>()
  const [segmentCursor, setSegmentCursor] = useState<string | undefined>()
  const options = useApiQuery(['campaign-audience-options', cursor ?? '', segmentCursor ?? ''], async (api, signal) => {
    const [listPage, segmentPage] = await Promise.all([api.lists.list({ pageSize: 100, cursor, counts: false }, signal), api.segments.list({ pageSize: 100, cursor: segmentCursor }, signal)])
    return { lists: [...listPage.items].sort((a, b) => a.name.localeCompare(b.name)), segments: [...segmentPage.items].sort((a, b) => a.name.localeCompare(b.name)), next: listPage.nextCursor, nextSegment: segmentPage.nextCursor }
  }, { enabled })
  const lists = options.data?.lists ?? [], segments = options.data?.segments ?? []
  // The chosen list or segment may not be on the loaded page: read its name, so it never shows as an ID.
  const listMissing = enabled && Boolean(campaign.listId) && !options.isPending && !lists.some(list => list.id === campaign.listId)
  const segmentMissing = enabled && Boolean(campaign.segmentId) && !options.isPending && !segments.some(segment => segment.id === campaign.segmentId)
  const chosenList = useApiQuery(['lists', campaign.listId], (api, signal) => api.lists.get(campaign.listId, signal), { enabled: listMissing })
  const chosenSegment = useApiQuery(['segments', campaign.segmentId ?? ''], (api, signal) => api.segments.get(campaign.segmentId!, signal), { enabled: segmentMissing })
  const listName = lists.find(list => list.id === campaign.listId)?.name ?? chosenList.data?.name
  const segmentName = segments.find(segment => segment.id === campaign.segmentId)?.name ?? chosenSegment.data?.name
  return { cursor, setCursor, segmentCursor, setSegmentCursor, options, lists, segments, listMissing, segmentMissing, chosenList, chosenSegment, listName, segmentName }
}

function AudiencePicker({ campaign, audience, notices, disabled }: { campaign: Campaign; audience: ReturnType<typeof useReviewAudienceOptions>; notices: boolean; disabled?: boolean }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache(), staleRefetch = useStaleRefetch()
  const [saving, setSaving] = useState(false)
  const { cursor, setCursor, segmentCursor, setSegmentCursor, options, lists, segments, listMissing, segmentMissing, chosenList, chosenSegment } = audience
  async function save(change: Partial<CampaignInput>) {
    setSaving(true)
    try { accept(await saveChange(api, campaign, change)) }
    catch (cause) { toast(errorText(cause), 'error'); staleRefetch(cause, campaign.id) }
    finally { setSaving(false) }
  }
  async function choose(listId: string, segmentId: string | null) {
    if (saving || (listId === campaign.listId && segmentId === (campaign.segmentId ?? null))) return
    await save({ listId, segmentId })
  }
  const off = disabled || saving || options.isPending
  return <div className="campaign-audience-picker">
    <Field label="List" htmlFor="campaign-list"><Select id="campaign-list" aria-label="Recipient list" disabled={off} value={campaign.listId} onValueChange={value => void choose(value, campaign.segmentId ?? null)} options={options.isPending ? [{ value: campaign.listId, label: 'Loading lists…', disabled: true }] : lists.length ? [{ value: '', label: 'Choose a list' }, ...(listMissing ? [{ value: campaign.listId, label: chosenList.data?.name ?? (chosenList.isError ? 'List not found' : 'Loading list…') }] : []), ...lists.map(list => ({ value: list.id, label: list.name }))] : [{ value: '', label: 'No lists yet. Create one in Audience.', disabled: true }]} /></Field>
    {(cursor || options.data?.next) && <div className="cluster"><Button onClick={() => setCursor(undefined)}>First lists</Button><Button disabled={!options.data?.next} onClick={() => setCursor(options.data?.next ?? undefined)}>More lists</Button></div>}
    <Field label="Segment" htmlFor="campaign-segment"><Select id="campaign-segment" aria-label="Segment" disabled={off || !campaign.listId} value={campaign.segmentId ?? ''} onValueChange={value => void choose(campaign.listId, value || null)} options={[{ value: '', label: 'Everyone on the list' }, ...(campaign.segmentId && segmentMissing ? [{ value: campaign.segmentId, label: chosenSegment.data?.name ? `Only ${chosenSegment.data.name}` : chosenSegment.isError ? 'Segment not found' : 'Loading segment…' }] : []), ...segments.map(segment => ({ value: segment.id, label: `Only ${segment.name}` })), ...(!options.isPending && !segments.length ? [{ value: '__none', label: 'No segments yet. Create one in Audience.', disabled: true }] : [])]} /></Field>
    {(segmentCursor || options.data?.nextSegment) && <div className="cluster"><Button disabled={!segmentCursor} onClick={() => setSegmentCursor(undefined)}>First segments</Button><Button disabled={!options.data?.nextSegment} onClick={() => setSegmentCursor(options.data?.nextSegment ?? undefined)}>More segments</Button></div>}
    {/* A campaign that is already a notice keeps the choice, so it can go back to marketing if notices were turned off. */}
    {(notices || campaign.requiredNotice) && <Field label="Kind" htmlFor="campaign-kind" hint={campaign.requiredNotice ? 'Reaches people who unsubscribed too, with no unsubscribe link.' : undefined}><Select id="campaign-kind" aria-label="Kind" disabled={disabled || saving} value={campaign.requiredNotice ? 'notice' : 'marketing'} onValueChange={value => { if (!saving && (value === 'notice') !== campaign.requiredNotice) void save({ requiredNotice: value === 'notice' }) }} options={[{ value: 'marketing', label: 'Marketing' }, { value: 'notice', label: 'Required notice', disabled: !notices }]} /></Field>}
  </div>
}

// Where the campaign goes: the list (and segment) by name, never by id.
function AudienceSource({ listId, segmentId, prefix }: { listId: string; segmentId: string | null; prefix?: string }) {
  const list = useApiQuery(['lists', listId], (api, signal) => api.lists.get(listId, signal), { enabled: Boolean(listId) })
  const segment = useApiQuery(['segments', segmentId ?? ''], (api, signal) => api.segments.get(segmentId!, signal), { enabled: Boolean(segmentId) })
  if (!listId) return <p className="campaign-audience-source muted">No list chosen yet.</p>
  return <p className="campaign-audience-source" title={list.data?.name}>{prefix}{list.data ? <Link to={`/audience/lists/${encodeURIComponent(listId)}`}>{list.data.name}</Link> : <SkeletonText width={120} />}{segmentId && <span className="muted"> · only {segment.data?.name ?? 'segment'}</span>}</p>
}

// A send that is over: its results stay, and nothing can be released any more.
const campaignFinished = (campaign: Campaign) => ['done', 'canceled'].includes(campaign.status) || (campaign.status === 'failed' && !campaignResumable(campaign))
// A finished campaign's lifetime figures: opens and clicks, and its outcomes once its emails are past the history.
// The review waits for them, so its results open whole.
const useCampaignStats = (campaign: Campaign | undefined) => useApiQuery(['campaign-stats', campaign?.id ?? ''], (api, signal) => api.campaigns.stats(campaign!.id, signal), { enabled: Boolean(campaign && campaignFinished(campaign)) })
const day = (value: string) => date(value, { month: 'short', day: 'numeric', ...(new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })

// Only the outcomes that happened, each opening its emails in Logs; opens and clicks as the newsletter's issues show them.
// A count links only when Logs lists exactly that many: Canceled, and Recipients with some never queued, stay plain.
function CampaignResults({ campaign, stats: statsQuery }: { campaign: Campaign; stats: ReturnType<typeof useCampaignStats> }) {
  const byStatus = campaign.counts?.byStatus ?? {}
  const total = Math.max(campaign.counts?.total ?? 0, campaign.delivery?.total ?? 0)
  // Past the email history, the per-email counts are gone: the stored totals keep the outcomes (not suppressed or canceled).
  const expired = (campaign.counts?.total ?? 0) === 0 && (campaign.delivery?.expanded ?? 0) > 0
  const stats = statsQuery.data
  const totals = expired ? stats?.totals : undefined
  const figure = (perEmail: number, stored?: number) => expired ? stored ?? null : perEmail
  const logs = (status?: string) => expired ? undefined : campaignLogs(campaign.id, status)
  const rate = (value?: number | null) => value ? percent(value, 0) : null
  const failures = (['rejected', 'rendering_failed'] as const).filter(status => (byStatus[status] ?? 0) > 0)
  const rows: { label: string; count: number | string | null; status?: string; always?: boolean }[] = [
    { label: 'Delivered', count: figure(byStatus.delivered ?? 0, totals?.delivered), status: 'delivered', always: true },
    { label: 'Simulated', count: figure(byStatus.simulated ?? 0, totals?.simulated), status: 'simulated' },
    { label: 'Opened', count: stats?.tracking ? rate(stats.rates.open.value) : null },
    { label: 'Clicked', count: stats?.tracking ? rate(stats.rates.click.value) : null },
    { label: 'Bounced', count: figure(byStatus.bounced ?? 0, totals?.bounced), status: 'bounced' },
    { label: 'Complaints', count: figure(byStatus.complained ?? 0, totals?.complained), status: 'complained' },
    ...expired ? [{ label: 'Failed', count: totals?.failed ?? null }]
      : failures.map(status => ({ label: failures.length > 1 ? label(status) : 'Failed', count: byStatus[status]!, status })),
    { label: 'Suppressed', count: expired ? null : byStatus.suppressed ?? 0, status: 'suppressed' },
    { label: 'Canceled', count: expired ? null : (byStatus.canceled ?? 0) + (campaign.delivery?.canceled ?? 0) },
  ]
  return <div className="campaign-audience-summary">
    <SummaryLine label={<strong>Recipients</strong>} figure={number(total)} to={campaign.counts?.total && campaign.counts.total === total ? logs() : undefined} />
    {rows.filter(row => row.always || (typeof row.count === 'number' ? row.count > 0 : Boolean(row.count))).map(row => <SummaryLine key={row.label} label={row.label}
      figure={row.count === null ? '—' : typeof row.count === 'number' ? number(row.count) : row.count} to={row.status && typeof row.count === 'number' && row.count > 0 ? logs(row.status) : undefined} />)}
    {statsQuery.isError && <div className="campaign-summary-line muted"><span>Engagement stats unavailable</span><Button variant="ghost" size="sm" loading={statsQuery.isFetching} onClick={() => void statsQuery.refetch()}>Retry</Button></div>}
  </div>
}

function CampaignReview({ campaign: latest, stats, settings, stale, refreshing, refresh }: { campaign: Campaign; stats: ReturnType<typeof useCampaignStats>; settings: ReturnType<typeof useApiDef<WorkspaceSettings>>; stale: boolean; refreshing: boolean; refresh: () => void }) {
  const navigate = useNavigate()
  // Review joins the draft's room too: someone still writing sees you here, and you see them.
  const { present, room } = useCampaignPresence(!latest.archivedAt && campaignEditable(latest) ? latest.id : null, 'review')
  const { campaign, unread, by, readAgain } = useReadCampaign(latest, room, refresh)
  // An issue goes back to its newsletter, and the sidebar marks it.
  const issueOf = useNewsletterOf(campaign.listId), thing = issueOf ? 'issue' : 'campaign'
  useShowNewsletter(issueOf?.id ?? null)
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduled, setScheduled] = useState('')
  const [error, setError] = useState('')
  const [scheduleProblem, setScheduleProblem] = useState('')
  const [confirmation, setConfirmation] = useState<SendCampaignInput | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [pace, setPace] = useState({ limit: false, perDay: '50000', autoPause: true, share: '100' })
  // A required notice is sent only once the sender confirms it has no promotion (the API records who and when).
  const [noticeConfirmed, setNoticeConfirmed] = useState(false)
  const [paceToggled, setPaceToggled] = useState(false)
  // Review is four stages, one open at a time, starting with recipients.
  const [openRow, setOpenRow] = useState<ReviewRowId>('to')
  const [seen, setSeen] = useState(() => new Set<ReviewRowId>())
  useEffect(() => { if (openRow && !seen.has(openRow)) setSeen(new Set([...seen, openRow])) }, [openRow, seen])
  const guard = useRef(false)
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const origin = multiTenant ? '' : ` from ${campaign.regionId}`

  const draft = !campaign.archivedAt && campaignEditable(campaign)
  const readinessError = campaignReadinessError(campaign)
  const fallbacks = campaign.draft?.defaults ?? {}
  const keys = placeholders(campaign.subject, campaign.previewText, campaign.html)
  const missingFallbacks = keys.filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  // A live count of the saved audience, read as the page opens; the send freezes its own snapshot.
  const display = useApiDef(reviewDisplayQuery(campaign), { enabled: draft && Boolean(campaign.listId),
    keepPrevious: previous => previous[1] === campaign.id && previous[3] === true && !readinessError })
  // Keep the previous Checks result while a new revision is read, never the previous audience.
  const count = display.isPlaceholderData ? undefined : display.data?.audience
  const audience = { data: count?.data, isError: Boolean(count?.error || display.isError) }
  const refreshedDisplayErrors = useRef(new Set<string>())
  useEffect(() => {
    if (!(display.error instanceof ApiError) || !['STALE_CAMPAIGN_REVISION', 'CAMPAIGN_ARCHIVED', 'CAMPAIGN_LOCKED'].includes(display.error.code)) return
    // A retry of the held revision can return a new Error object without changing what Review holds.
    const key = `${campaign.revision}:${display.error.code}`
    if (refreshedDisplayErrors.current.has(key)) return
    refreshedDisplayErrors.current.add(key)
    refresh()
  }, [campaign.revision, display.error, refresh])
  const audienceOptions = useReviewAudienceOptions(campaign, draft)
  const { listName, segmentName } = audienceOptions
  const perDay = Number(pace.perDay.trim().replaceAll(',', ''))
  const paceError = pace.limit ? perDayError(perDay) : ''
  const paceDays = pace.limit && !paceError && audience.data?.eligible ? Math.ceil(audience.data.eligible / perDay) : null
  const sharePercent = Number(pace.share.trim())
  const shareError = ratePercentError(sharePercent)
  // A value that needs fixing keeps the fields open.
  const paceOpen = paceToggled || Boolean(paceError || shareError)
  const paceLine = [pace.limit && `${number(perDay)} per day`, `${pace.share.trim()}% speed`, !multiTenant && (pace.autoPause ? 'auto-pause on' : 'auto-pause off')].filter(Boolean).join(' · ')
  const paceSummary = (input: SendCampaignInput | null) => !input?.pacing ? '' : `${input.pacing.perDay ? ` Sends to up to ${number(input.pacing.perDay)} recipients per day${paceDays ? ` (about ${paceDays} ${paceDays === 1 ? 'day' : 'days'})` : ''}.` : ''}${input.pacing.rateShare != null && input.pacing.rateShare < 1 ? ` Uses at most ${Math.round(input.pacing.rateShare * 100)}% of your sending speed.` : ''}${input.pacing.autoPause === false ? ' Auto-pause on high bounces or complaints is off.' : ''}`
  const toast = useToast()
  const staleRefetch = useStaleRefetch()
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input), undefined, false, invalidate.campaignSend)
  // Every campaign footer carries the workspace's postal address, so Send and Schedule ask for it first when it is
  // missing, then go on: to the confirmation, or straight to sending when the API asked after it was confirmed.
  const [addressFor, setAddressFor] = useState<{ input: SendCampaignInput; confirmed: boolean } | null>(null)
  const recipients = audience.data ? `${number(audience.data.eligible)} eligible ${audience.data.eligible === 1 ? 'recipient' : 'recipients'}` : 'the eligible recipients'
  const audienceName = `${listName ? ` in ${listName}` : ''}`
  // Hosted and enforced: what the send costs beyond the free allowance, against the balance, read while the page opens.
  const billing = useApiDef(queries.billing(), { enabled: draft && multiTenant && canAdminister }).data
  const cost = billing && billing.enforcement === 'enforce' && billing.mode === 'prepaid' && billing.balance && audience.data ? (() => {
    const beyond = Math.max(0, audience.data.eligible - billing.free.sent.left), uc = BigInt(beyond) * priceUc(billing.prices.emailPerThousand) / 1000n
    return ` Estimated cost ${usd(uc)} (${number(beyond)} ${beyond === 1 ? 'recipient' : 'recipients'} beyond your free sends). Balance ${usd(total(billing.balance))}.${BigInt(billing.balance.available) < uc ? ` The ${thing} pauses when the balance runs out and resumes after you add credit.` : ''}`
  })() : ''
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); return }
    setError('')
    if (audience.data && audience.data.eligible < 1) { setError(nobodyEligible); return }
    if (paceError) { setError(`Recipients per day: ${paceError}`); return }
    if (shareError) { setError(`Sending speed limit: ${shareError}`); return }
    if (campaign.requiredNotice && !noticeConfirmed) { setError('Confirm that this is a required notice with no promotion.'); return }
    const input: SendCampaignInput = { id: campaign.id, mode, revision: campaign.revision, ...(campaign.requiredNotice ? { confirmRequiredNotice: true } : {}) }
    // Defaults (no daily limit, auto-pause on, full send rate) need no pacing object.
    if (pace.limit || !pace.autoPause || sharePercent < 100) input.pacing = { perDay: pace.limit ? perDay : null, autoPause: pace.autoPause, rateShare: sharePercent / 100 }
    if (mode === 'schedule') {
      // datetime-local has no offset: this field is explicitly UTC, never the browser's local zone.
      const problem = scheduleError(scheduled)
      if (problem) { setScheduleProblem(problem); return }
      input.scheduledAt = parseUtc(scheduled)!.toISOString()
    }
    if (canAdminister && settings.data && !settings.data.postalAddress) { setAddressFor({ input, confirmed: false }); return }
    setConfirmation(input)
  }
  async function send(input: SendCampaignInput) {
    if (!draft || guard.current || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); setConfirmation(null); return }
    guard.current = true
    setError('')
    try { const result = await sendMutation.mutateAsync(input); if ('queued' in result && !result.scheduledAt) toast(result.queued > 0 ? `Sending started · ${number(result.queued)} ${result.queued === 1 ? 'recipient' : 'recipients'}${result.simulated ? ' · simulated' : ''}` : `Sending started · preparing recipients${result.simulated ? ' · simulated' : ''}`, 'success'); setConfirmation(null) }
    catch (cause) {
      setConfirmation(null)
      if (cause instanceof ApiError && cause.code === 'POSTAL_ADDRESS_REQUIRED') setAddressFor({ input, confirmed: true })
      else { setError(errorText(cause)); staleRefetch(cause, campaign.id) }
    }
    finally { guard.current = false }
  }
  const confirmSend = () => confirmation ? send(confirmation) : undefined
  const noticeNote = campaign.requiredNotice ? ' People who unsubscribed get it too; suppressed addresses never do.' : ''
  const scheduledView = !draft && !campaign.archivedAt && unreleasedSchedule(campaign)
  const sentSomething = (campaign.counts?.total ?? 0) > 0
  const finished = campaignFinished(campaign)
  const cancellable = !draft && !campaign.archivedAt && !scheduledView && (['preparing', 'sending', 'paused'].includes(campaign.status) || campaignResumable(campaign))
  const check = draft && !readinessError ? display.data?.check ?? null : null
  const sendability = { data: check?.data, error: !readinessError ? reviewCheckError(check, display.error) : null,
    isPending: display.isPending, refetch: display.refetch }
  // The step is ticked when there is nothing to fix; the send confirmation mentions the checks only when the score is low.
  const toFix = sendability.data ? checksCount(sendability.data) : 0
  const scoreNote = sendability.data && sendability.data.score < LOW_SENDABILITY && toFix ? ` Checks found ${checksSummary(sendability.data)}.` : ''
  const previewHtml = (html: string) => keys.length ? html.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => escapeHtml(fallbacks[key] ? String(fallbacks[key]) : sampleValue(key))) : html
  // What the Write step still needs, each named, and what this step needs: shown under the send button.
  const missing = [!campaign.name.trim() && 'a name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a sender', !campaign.html.trim() && 'content'].filter(Boolean) as string[]
  const writeLink = <Link to={campaignRoute(campaign, 'edit')}>Write</Link>
  // Shown in every open stage's footer, until they read the newer version (useReadCampaign).
  const unreadNote = unread && <>{by.length ? `${by.join(' and ')} saved this ${thing}` : `This ${thing} changed`} after you opened it. <Button size="sm" onClick={() => { readAgain(); setError(''); setOpenRow('message') }}>Read it again</Button></>
  const notes: ['neutral' | 'warning' | 'danger', ReactNode][] = !draft ? [] : [
    ...(missing.length ? [['neutral', <>Add {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} in {writeLink}.</>] as ['neutral', ReactNode]] : !campaign.listId ? [['neutral', 'Choose a list in Recipients.'] as ['neutral', ReactNode]] : []),
    ...(!canAdminister ? [['neutral', `Only owners and admins can send or schedule ${thing}s.`] as ['neutral', ReactNode]] : []),
    ...(unreadNote ? [['warning', unreadNote] as ['warning', ReactNode]] : []),
    ...(error ? [['danger', error] as ['danger', ReactNode]] : []),
  ]
  const bar = <CampaignBar back={campaign.archivedAt ? '/campaigns?archived=true' : issueOf ? newsletterPath(issueOf.id) : '/campaigns'} crumb={issueOf?.name ?? 'Campaigns'} title={<h1 className="studio-title">{campaign.name}</h1>} steps={draft && <CampaignSteps step="review" writeTo={campaignRoute(campaign, 'edit')} />} actions={<><CampaignPresence present={present} room={draft} />{stale && <span className="campaign-note" data-tone="warning" title="Showing the last available counts.">Couldn’t refresh</span>}{!campaignEditable(campaign) && !finished && sentSomething && <Link className="ui-button ui-button--secondary ui-button--md" to={`/logs?campaign=${encodeURIComponent(campaign.id)}`}>View logs</Link>}<StatusBadge status={campaignDisplayStatus(campaign)} />{campaign.archivedAt && <CampaignArchiveButton campaign={campaign} />}</>} />
  const dialogs = <>
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? `Schedule this ${thing}?` : `Send this ${thing} now?`} description={confirmation?.mode === 'schedule' ? `Send “${campaign.name}”${origin} to ${recipients}${audienceName} on ${utcLabel(confirmation.scheduledAt!)} (${localLabel(confirmation.scheduledAt!)}).${paceSummary(confirmation)}${cost}${noticeNote}${scoreNote} You can change this until sending starts.` : `Send “${campaign.name}”${origin} to ${recipients}${audienceName} now.${paceSummary(confirmation)}${cost}${noticeNote || ' Consent is checked again as each email sends.'}${scoreNote} You can’t undo this.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Schedule' : 'Send now'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && testOpen && <TestEmailDialog campaign={campaign} open={testOpen} onOpenChange={setTestOpen} />}
    {addressFor && <PostalAddressDialog open onOpenChange={open => { if (!open) setAddressFor(null) }} initial={null} required title="Add your postal address" submitLabel="Continue"
      onSaved={() => { if (addressFor.confirmed) void send(addressFor.input); else setConfirmation(addressFor.input) }} />}
  </>
  if (draft) {
    const eligible = audience.data?.eligible ?? 0
    const segmentLabel = segmentName ? ` · only ${segmentName}` : ''
    const toSummary = !campaign.listId ? 'No list chosen'
      : !audience.data ? `${listName ?? 'Your list'}${audience.isError ? ' · couldn’t count' : ''}`
      : eligible ? `${number(eligible)} ${eligible === 1 ? 'contact' : 'contacts'} in ${listName ?? 'your list'}${segmentLabel}${campaign.requiredNotice ? ' · required notice' : ''}`
      : <span className="review-warn">Nobody in {listName ?? 'your list'} can receive it yet</span>
    const scoreSummary = sendability.data ? checksSummary(sendability.data) : missing.length ? 'After the message is complete' : !campaign.listId ? 'After you choose a list' : sendability.error ? 'Couldn’t check' : 'Checking…'
    const scheduledAt = mode === 'schedule' && scheduled && !scheduleError(scheduled) ? parseUtc(scheduled)!.toISOString() : null
    const messageSummary = missing.length ? `Add ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} in Write` : campaign.subject
    const whenSummary = mode === 'now' ? 'Send now' : scheduledAt ? utcLabel(scheduledAt) : 'Pick a time'
    const order: ReviewRowId[] = ['to', 'message', 'score', 'when']
    const next = (row: ReviewRowId) => <>{unreadNote && openRow === row && <ul className="campaign-notes"><li className="campaign-note" data-tone="warning"><span>{unreadNote}</span></li></ul>}<Button variant="primary" onClick={() => setOpenRow(order[order.indexOf(row) + 1]!)}>Next</Button></>
    return <div className="campaign-review campaign-review--draft">
      {bar}
      {campaign.delivery?.error && <p className="campaign-note" data-tone="danger" role="alert">{campaign.delivery.error.message}</p>}
      <div className="review-stages">
        <ReviewStage n={1} id="to" title="Recipients" open={openRow === 'to'} done={Boolean(campaign.listId && eligible)} onOpen={() => setOpenRow('to')} summary={toSummary} footer={next('to')}>
          <AudiencePicker campaign={campaign} audience={audienceOptions} notices={settings.data?.requiredNotices === true} disabled={sendMutation.isPending} />
          {audience.data && campaign.listId && <p className="review-detail">{number(audience.data.matched)} on the list{audience.data.suppressed ? ` · ${number(audience.data.suppressed)} suppressed` : ''}{audience.data.unsubscribed ? <> · {number(audience.data.unsubscribed)} not subscribed · <Link to={`/audience/lists/${encodeURIComponent(campaign.listId)}?status=unknown`}>Fix</Link></> : null}</p>}
        </ReviewStage>
        <ReviewStage n={2} id="message" title="Message" open={openRow === 'message'} done={!missing.length && !missingFallbacks.length} onOpen={() => setOpenRow('message')} summary={messageSummary} footer={next('message')}>
          <div className="review-message">
            <div className="review-message__details">
              <dl className="review-facts">
                <dt>From</dt><dd>{campaign.fromEmail ? <SenderLines name={campaign.fromName} address={campaign.fromEmail} /> : <span className="muted">Not set</span>}</dd>
                {campaign.replyTo.length > 0 && <><dt>Reply to</dt><dd><AddressList values={campaign.replyTo} /></dd></>}
                <dt>Subject</dt><dd>{campaign.subject || <span className="muted">Not set</span>}</dd>
                {campaign.previewText && <><dt>Inbox preview</dt><dd>{campaign.previewText}</dd></>}
                {(campaign.attachments?.length ?? 0) > 0 && <><dt>Attached</dt><dd><AttachmentList ids={campaign.attachments!} body={campaign.html} /></dd></>}
              </dl>
              {missingFallbacks.length > 0 && <p className="review-detail review-warn">{missingFallbacks.map(key => `{{${key}}}`).join(', ')} {missingFallbacks.length === 1 ? 'needs' : 'need'} a fallback, or contacts without a value stop the send.</p>}
              {!campaign.requiredNotice && <UnsubscribePageField campaign={campaign} disabled={sendMutation.isPending} />}
              <div className="review-actions"><Link className="ui-button ui-button--secondary ui-button--md" to={`${campaignRoute(campaign, 'edit')}#message`}>Edit</Link><Button disabled={!campaignMessageReady(campaign)} onClick={() => setTestOpen(true)}>Send test</Button></div>
            </div>
            <div className="review-message__preview">{seen.has('message') && <CampaignRenderedPreview campaign={campaign} transform={previewHtml} />}</div>
          </div>
        </ReviewStage>
        <ReviewStage n={3} id="score" title="Checks" open={openRow === 'score'} done={Boolean(sendability.data && !toFix)} onOpen={() => setOpenRow('score')} summary={scoreSummary} footer={next('score')}>
          {sendability.data || sendability.error ? <Checks check={sendability} titled={false} message={`${campaignRoute(campaign, 'edit')}#message`} /> : <p className="review-detail">{scoreSummary}.</p>}
        </ReviewStage>
        <ReviewStage n={4} id="when" title="Send" open={openRow === 'when'} done={false} onOpen={() => setOpenRow('when')} summary={whenSummary} footer={<>
          {campaign.requiredNotice && <div className="review-confirm"><Checkbox label="This is a required notice, with no promotion." checked={noticeConfirmed} disabled={sendMutation.isPending} onCheckedChange={value => { setNoticeConfirmed(value); setError('') }} /></div>}
          {notes.length > 0 && <ul className="campaign-notes">{notes.map(([tone, text], index) => <li key={index} className="campaign-note" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}><span>{text}</span></li>)}</ul>}
          <Button variant="primary" loading={sendMutation.isPending} disabled={!canAdminister || Boolean(readinessError) || Boolean(audience.data && !audience.data.eligible)} onClick={requestConfirmation} data-analytics={mode === 'schedule' ? 'campaigns/schedule' : 'campaigns/send'}>{mode === 'schedule' ? 'Schedule' : eligible ? `Send to ${number(eligible)} ${eligible === 1 ? 'contact' : 'contacts'}` : 'Send now'}</Button>
        </>}>
          <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError(''); setScheduleProblem('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
          {mode === 'schedule' && <ScheduleField id="campaign-schedule" value={scheduled} onChange={value => { setScheduled(value); setScheduleProblem(''); setError('') }} error={scheduleProblem} disabled={sendMutation.isPending} />}
          <div className="campaign-pacing-options" role="group" aria-labelledby="campaign-pacing-label">
            <div className="campaign-pacing-head"><Button id="campaign-pacing-label" variant="ghost" size="sm" className="campaign-pacing-toggle" aria-expanded={paceOpen} aria-controls="campaign-pacing-fields" onClick={() => setPaceToggled(!paceOpen)}><ChevronRight size={14} aria-hidden="true" />Pace sending</Button>{!paceOpen && <span className="muted campaign-pacing-summary">{paceLine}</span>}</div>
            {paceOpen && <div id="campaign-pacing-fields" className="campaign-pacing-fields">
              <Checkbox label="Limit recipients per day" checked={pace.limit} disabled={sendMutation.isPending} onCheckedChange={limit => { setPace({ ...pace, limit }); setError('') }} />
              {pace.limit && <Field label="Recipients per day" htmlFor="campaign-per-day" error={paceError}><Input id="campaign-per-day" type="number" inputMode="numeric" min={minPerDay} max={maxPerDay} step={1} value={pace.perDay} onChange={event => { setPace({ ...pace, perDay: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>}
              <Field label="Sending speed limit (%)" htmlFor="campaign-rate-share" error={shareError}><Input id="campaign-rate-share" type="number" inputMode="numeric" min={minRatePercent} max={maxRatePercent} step={1} value={pace.share} onChange={event => { setPace({ ...pace, share: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>
              {/* Hosted always pauses on high bounces or complaints. */}
              {!multiTenant && <Checkbox label="Pause automatically on high bounces or complaints" checked={pace.autoPause} disabled={sendMutation.isPending} onCheckedChange={autoPause => setPace({ ...pace, autoPause })} />}
            </div>}
          </div>
        </ReviewStage>
      </div>
      {dialogs}
    </div>
  }
  return <div className="campaign-review">
    {bar}
    <div className="campaign-review__body stack">
    {scheduledView && <ScheduledBanner campaign={campaign} />}
    <div className="campaign-review-layout">
      <section className="campaign-fields campaign-recipients">
        {campaign.delivery?.error && <p className="campaign-note" data-tone="danger" role="alert">{campaign.delivery.error.message}</p>}
        {!scheduledView && <SectionHeader title="Delivery" actions={finished ? undefined : <div className="cluster">{cancellable && <CancelCampaignButton campaign={campaign} />}<Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing} title="This page also updates by itself">Refresh</Button></div>} />}
        {/* Eligible recipients is matched contacts less the suppressed and not subscribed lines under it. */}
        {<>
          {scheduledView ? <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} prefix="To " /> : <>
            <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} prefix={campaign.status === 'done' ? `Sent ${day(campaign.scheduledAt || campaign.updatedAt)} to ` : undefined} />
            <CampaignPacing key={`${campaign.id}:${campaign.delivery?.pacing?.perDay ?? ''}:${campaign.delivery?.pacing?.autoPause ?? ''}:${campaign.delivery?.pacing?.rateShare ?? ''}`} campaign={campaign} />
            {finished ? <CampaignResults campaign={campaign} stats={stats} /> : campaign.counts ? <CampaignProgress campaign={campaign} /> : <div className="campaign-audience-summary"><div className="campaign-summary-line"><span>Recipients</span><span>{number(campaign.recipients)}</span></div></div>}
          </>}
          {scheduledView && <CampaignPacing key={`${campaign.id}:paused`} campaign={campaign} />}
        </>}
      </section>
      <section className="campaign-fields campaign-message">
        <dl className="ui-facts campaign-message-details">{campaign.requiredNotice && <><dt>Kind</dt><dd>Required notice</dd></>}<dt>From</dt><dd><SenderLines name={campaign.fromName} address={campaign.fromEmail} /></dd>{campaign.replyTo.length > 0 && <><dt>Reply to</dt><dd><AddressList values={campaign.replyTo} /></dd></>}<dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Inbox preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <CampaignRenderedPreview campaign={campaign} transform={previewHtml} />
      </section>
    </div>
    </div>
    {dialogs}
  </div>
}
