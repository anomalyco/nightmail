import { ApiError, type MailRoute, type RoutingTestResult, type Api, type PageRequest, type PageResult, type Campaign, type CampaignState, type Contact, type AudienceList, type AudiencePreview, type Segment, type Domain, type Webhook, type WebhookDelivery, type MailboxDomain, type MailboxWebhookDelivery, type ReceivedEmailDetail, type InboundAddress, type InboundAddressState, type InboundMessage, type InboundMessageDetail, type InboundThread, type InboundThreadDetail, type InboundWebhook, type ForwardEndpoint, type Email, type RegionCatalog, type SesDiscovery, type RegionProvisionReceipt, type Workspace, type OverviewSetup, type CampaignReviewDisplay, type CampaignTemplate, type CampaignTemplateDraft, type CampaignTemplateSummary, type EmailEvent, type SendabilityReport, type ClientPreview, type Newsletter, type CampaignPreview, type CampaignSendReceipt, type CampaignStats, type Attachment, type ImportPreview, type AudiencePlan } from './types'
import type { Agent, ApiKey, AppPassword, AuditEntry, CreatedAppPassword, DomainQuota, Topic, WorkspaceSettings } from './types'
import type { CreatedInbox, Inbox, InboxMessageDetail, InboxMessagePage, LogDirection, LogEntry, SenderScore } from './types'
import type {
  AgentList as SdkAgentList,
  ApiError as SdkApiError,
  ApiKey as SdkApiKey,
  ApiKeyChangePage as SdkApiKeyChangePage,
  AppPasswordList as SdkAppPasswordList,
  Attachment as SdkAttachment,
  AttachmentContent as SdkAttachmentContent,
  AudienceImport as SdkAudienceImport,
  AudienceOperationPlan as SdkAudienceOperationPlan,
  AudienceOperationResult as SdkAudienceOperationResult,
  Campaign as SdkCampaign,
  CampaignAudienceCounts as SdkCampaignAudienceCounts,
  CampaignCanceled as SdkCampaignCanceled,
  CampaignPreview as SdkCampaignPreview,
  CampaignQueued as SdkCampaignQueued,
  CampaignState as SdkCampaignState,
  CampaignStats as SdkCampaignStats,
  CampaignSummary as SdkCampaignSummary,
  CampaignTemplate as SdkCampaignTemplate,
  CampaignTemplateDraft as SdkCampaignTemplateDraft,
  CampaignTemplatePreview as SdkCampaignTemplatePreview,
  CampaignTemplateSummary as SdkCampaignTemplateSummary,
  CommittedContactImport as SdkCommittedContactImport,
  ConfigureRegionAutoValidationResponse as SdkAutoValidationResponse,
  Contact as SdkContact,
  ContactDetail as SdkContactDetail,
  ContactList as SdkContactList,
  ContactListRead as SdkContactListRead,
  ContactRead as SdkContactRead,
  CreateApiKeyResponse as SdkCreateApiKeyResponse,
  CreateInboxAppPasswordResponse as SdkCreateInboxAppPasswordResponse,
  CreatedInbox as SdkCreatedInbox,
  CreatedWebhook as SdkCreatedWebhook,
  DomainPage as SdkDomainPage,
  DomainReadiness as SdkDomainReadiness,
  Email as SdkEmail,
  EmailCheckResult as SdkEmailCheckResult,
  EmailDetail as SdkEmailDetail,
  EmailEvent as SdkEmailEvent,
  EmailPreviews as SdkEmailPreviews,
  EmailQueued as SdkEmailQueued,
  EndpointPage as SdkEndpointPage,
  GetCurrentIdentityResponse as SdkIdentity,
  GetTemplateAssetContentResponse as SdkTemplateAssetContent,
  InboundAddress as SdkInboundAddress,
  InboundAddressPage as SdkInboundAddressPage,
  InboundAttachmentDownload as SdkInboundAttachmentDownload,
  InboundDomain as SdkInboundDomain,
  InboundDomainList as SdkInboundDomainList,
  InboundMessage as SdkInboundMessage,
  InboundMessageDetail as SdkInboundMessageDetail,
  InboundThreadAddressState as SdkInboundThreadAddressState,
  InboundThreadDetail as SdkInboundThreadDetail,
  InboundThreadPage as SdkInboundThreadPage,
  InboundWebhook as SdkInboundWebhook,
  InboundWebhookDeliveryPage as SdkInboundWebhookDeliveryPage,
  InboundWebhookList as SdkInboundWebhookList,
  InboundWebhookRotatedSecret as SdkInboundWebhookRotatedSecret,
  Inbox as SdkInbox,
  InboxMessageDetail as SdkInboxMessageDetail,
  InboxMessagePage as SdkInboxMessagePage,
  InboxPage as SdkInboxPage,
  ListApiKeysResponse as SdkApiKeyPage,
  ListCampaignTemplatesResponse as SdkCampaignTemplatePage,
  ListCampaignsResponse as SdkCampaignPage,
  ListContactConsentEventsResponse as SdkConsentEventPage,
  ListContactListsResponse as SdkContactListPage,
  ListContactsResponse as SdkContactPage,
  ListEmailEventsResponse as SdkEmailEventPage,
  ListEmailsResponse as SdkEmailPage,
  ListInboxFoldersResponse as SdkInboxFolderList,
  ListLogsResponse as SdkLogPage,
  ListNewslettersResponse as SdkNewsletterPage,
  ListSegmentsResponse as SdkSegmentPage,
  ListTopicsResponse as SdkTopicPage,
  LogEntry as SdkLogEntry,
  MailRoute as SdkMailRoute,
  Metrics as SdkMetrics,
  Newsletter as SdkNewsletter,
  NewsletterRead as SdkNewsletterRead,
  OverviewSetup as SdkOverviewSetup,
  PreviewSegmentResponse as SdkSegmentPreview,
  QueuedWebhookDelivery as SdkQueuedWebhookDelivery,
  RegionProvisionReceipt as SdkRegionProvisionReceipt,
  RevokeAgentResponse as SdkRevokeAgentResponse,
  RoutingConfig as SdkRoutingConfig,
  RoutingTestResult as SdkRoutingTestResult,
  Segment as SdkSegment,
  SenderScore as SdkSenderScore,
  SesDiscovery as SdkSesDiscovery,
  TemplateAsset as SdkTemplateAsset,
  Topic as SdkTopic,
  UpdatedInboundWebhook as SdkUpdatedInboundWebhook,
  Webhook as SdkWebhook,
  WebhookDelivery as SdkWebhookDelivery,
  WebhookDeliveryPage as SdkWebhookDeliveryPage,
  WebhookPage as SdkWebhookPage,
  WebhookSecret as SdkWebhookSecret,
  WorkspaceSettings as SdkWorkspaceSettings,
} from '../../../sdk/src/types.gen'
import { headerPrefix, productName } from '../../../api/src/brand'
import { isPublicPage } from '../../../api/src/site-index'
import { analytics } from '../lib/analytics'
import { webhookPatchBody } from '../features/settings/webhook-patch'
import { countPending, decodeLogFacets, foldableFacetView } from './log-facets'
const idPath = (id: string) => encodeURIComponent(id)
// The account this tab acts as (a browser can connect several, data/accounts.ts), sent as X-Nightmail-Account. It is per tab
// (sessionStorage), so two tabs can show two accounts; unknown in a new tab until /v1/me answers as the browser default.
const accountStorageKey = 'nightmail.account'
let accountSelection: string | null = (() => { try { return sessionStorage.getItem(accountStorageKey) } catch { return null } })()
export const selectedAccount = () => accountSelection
// The dashboard's selected workspace (multi-tenant installations only), sent with every request as X-Nightmail-Workspace:
// without it the API acts in the workspace the account selected last, in whichever tab. Remembered per account.
const accountHeader = `${headerPrefix}Account`, workspaceHeader = `${headerPrefix}Workspace`
const workspaceKey = (account: string | null) => account ? `nightmail.workspace:${account}` : 'nightmail.workspace'
export const rememberedWorkspace = (account: string | null) => { try { return localStorage.getItem(workspaceKey(account)) } catch { return null } }
let workspaceSelection: string | null = accountSelection ? rememberedWorkspace(accountSelection) : null
export const selectedWorkspace = () => workspaceSelection
// Every workspace or account switch bumps selectionEpoch and aborts scopeController so in-flight fetches from the
// previous scope cancel immediately, stale responses are dropped even across A -> B -> A round trips, and any closure
// pinned to the previous scope fails closed before calling fetch().
export type RequestScope = { readonly account: string | null; readonly workspace: string | null; readonly epoch: number }
let selectionEpoch = 0
let scopeController = new AbortController()
export const currentScope = (): RequestScope => ({ account: accountSelection, workspace: workspaceSelection, epoch: selectionEpoch })
export const isCurrentScope = (scope: RequestScope) => scope.epoch === selectionEpoch && scope.account === accountSelection && scope.workspace === workspaceSelection
export const aborted = () => new DOMException('The operation was aborted.', 'AbortError')
export const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'

// Combines two AbortSignals, falling back to a manual AbortController on browsers without AbortSignal.any (Safari < 17.4).
function combineSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([a, b]), cleanup: () => {} }
  }
  const combined = new AbortController()
  if (a.aborted || b.aborted) { combined.abort(); return { signal: combined.signal, cleanup: () => {} } }
  const onAbort = () => combined.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return {
    signal: combined.signal,
    cleanup: () => { a.removeEventListener('abort', onAbort); b.removeEventListener('abort', onAbort) },
  }
}

// Writes cut off by a workspace/account switch: remembered per (account, workspace) in memory so returning to that
// workspace tells the person in a few words that their last save may have landed.
const scopeId = (account: string | null, workspace: string | null) => `${account ?? ''}\0${workspace ?? ''}`
const activeWrites = new Set<{ account: string | null; workspace: string | null }>()
const interruptedWrites = new Set<string>()
const isMutatingRequest = (method: string, path: string) =>
  method !== 'GET' && method !== 'HEAD' &&
  !path.startsWith('/api/auth/') &&
  !/^\/v1\/(?:rules\/(?:test|check)|routing\/test|emails\/(?:check|preview)|audience-query\/plan|segments\/[^/]+\/preview)$/.test(path)
export function takeInterruptedWrite(account: string | null, workspace: string | null): boolean {
  const key = scopeId(account, workspace)
  if (!interruptedWrites.has(key)) return false
  interruptedWrites.delete(key)
  return true
}
export function clearInterruptedWrites(account?: string | null) {
  if (!account) { interruptedWrites.clear(); return }
  const prefix = `${account}\0`
  for (const key of interruptedWrites) if (key.startsWith(prefix)) interruptedWrites.delete(key)
}

function bumpScope() {
  for (const write of activeWrites) interruptedWrites.add(scopeId(write.account, write.workspace))
  selectionEpoch += 1
  scopeController.abort()
  scopeController = new AbortController()
  try { window.dispatchEvent(new Event('nightmail:scope-changed')) } catch { /* Non-browser environment. */ }
}
export function selectWorkspace(id: string | null) {
  const previous = workspaceSelection
  workspaceSelection = id
  if (previous !== null && id !== previous) bumpScope()
  try { if (id) localStorage.setItem(workspaceKey(accountSelection), id); else localStorage.removeItem(workspaceKey(accountSelection)) } catch { /* Selection can remain session-only. */ }
}
/** Act as another account in this tab, in the workspace last used with it. Responses to earlier requests are dropped. */
export function selectAccount(id: string | null) {
  const previousAccount = accountSelection, previousWorkspace = workspaceSelection
  if (id !== accountSelection) { accountSelection = id; workspaceSelection = id ? rememberedWorkspace(id) : null }
  if ((previousAccount !== null && accountSelection !== previousAccount) || (previousWorkspace !== null && workspaceSelection !== previousWorkspace)) bumpScope()
  try { if (id) sessionStorage.setItem(accountStorageKey, id); else sessionStorage.removeItem(accountStorageKey) } catch { /* Selection can remain in memory. */ }
}
// Whether this browser has a dashboard session, as far as a page can tell without asking (its cookies are httpOnly): 'in'
// after an expected sign-in return or a successful /v1/me, 'out' after it last said signed out, and before either,
// a remembered dashboard or account. The hint never authorizes a request.
// The public pages ask /v1/me only where a session is likely. public/theme.js reads the same keys for its early fetch.
const sessionHintKey = 'nightmail.session'
export function rememberSession(signedIn: boolean) { try { localStorage.setItem(sessionHintKey, signedIn ? 'in' : 'out') } catch { /* The tab can still know its account. */ } }
export function sessionLikely() {
  try {
    const hint = localStorage.getItem(sessionHintKey)
    return hint === 'in' || (hint === null && (localStorage.getItem('nightmail.dashboard-ready') !== null || sessionStorage.getItem(accountStorageKey) !== null))
  } catch { return selectedAccount() !== null }
}
/** Pages a visitor can read without an account (api/src/site-index.ts, PUBLIC_PAGE: public/theme.js's early check reads
 *  the same pattern). A query string isn't evidence of a session. */
export const asksOnlyIfLikely = isPublicPage

/** A WebSocket URL on this origin for this tab's account and workspace. A browser's WebSocket can't send the headers every
 *  other request carries, so the API reads them from the query for its sockets (the campaign room). */
export function socketUrl(path: string, query: Record<string, string> = {}) {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [name, value] of Object.entries({ ...query, ...(accountSelection ? { account: accountSelection } : {}), ...(workspaceSelection ? { workspace: workspaceSelection } : {}) })) url.searchParams.set(name, value)
  return url.href
}
// Responses public/theme.js started before the app loaded. Each is used once, and only while fresh
// and for the account and workspace the app would have asked about.
type EarlyRequests = { account?: string | null; workspace: string | null; at: number; responses: Record<string, Promise<Response> | undefined> }
// A request that is aborted before it reads the response (React StrictMode's first mount) puts it back for the next one.
async function takeEarly(path: string, signal?: AbortSignal) {
  const early = (window as { __nightmailEarly?: EarlyRequests }).__nightmailEarly
  const pending = early?.responses[path]
  if (!early || !pending) return null
  delete early.responses[path]
  if ((early.account ?? null) !== accountSelection || early.workspace !== workspaceSelection || Date.now() - early.at >= 10_000) return null
  const restore = () => { early.responses[path] ??= pending }
  if (signal?.aborted) { restore(); throw aborted() }
  signal?.addEventListener('abort', restore, { once: true })
  try {
    const response = await pending
    if (signal?.aborted) { restore(); throw aborted() }
    return response
  } finally { signal?.removeEventListener('abort', restore) }
}
// The request IDs of the last few failed API calls, newest first: the support chat's handoff sends them so support can find
// the errors. Only the API's own IDs: the handoff refuses anything else, and with it the chat.
const failedRequests: string[] = []
function rememberFailedRequest(id: string) {
  if (!/^req_[0-9a-f]{32}$/.test(id) || failedRequests[0] === id) return
  failedRequests.unshift(id)
  failedRequests.length = Math.min(failedRequests.length, 5)
}
export const recentFailedRequestIds = () => [...failedRequests]
export type RequestOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  idempotencyKey?: string
  ifMatch?: number
  file?: { bytes: Blob; headers: Record<string, string> }
  scope: RequestScope | 'unscoped'
  account?: string | null
  workspace?: string | null
  expectedStatus?: number
}
export async function request<T = unknown>(path: string, options: RequestOptions): Promise<T> {
  const started = performance.now()
  const sessionAgnostic = path.startsWith('/api/auth/') || path === '/health'
  const pinnedScope = options.scope === 'unscoped' ? undefined : options.scope
  // Fail closed before calling fetch() when a caller pinned to an earlier account/workspace fires after a switch.
  if (pinnedScope && !isCurrentScope(pinnedScope)) throw aborted()
  const probe = options.account !== undefined || options.workspace !== undefined
  const scoped = !probe && !sessionAgnostic
  // Every request acts as the account and workspace selected when it was sent, never ones chosen later.
  const account = options.account !== undefined ? options.account : accountSelection
  const workspace = options.workspace !== undefined ? options.workspace : workspaceSelection
  const epoch = selectionEpoch
  const method = options.method ?? 'GET'
  const linked = scoped && options.signal ? combineSignals(options.signal, scopeController.signal) : null
  const signal = linked ? linked.signal : scoped ? scopeController.signal : options.signal
  const trackedWrite = scoped && isMutatingRequest(method, path) ? { account, workspace } : null
  if (trackedWrite) activeWrites.add(trackedWrite)
  let response: Response
  let data: unknown
  try {
    try {
      const early = !probe && options.method === undefined && options.body === undefined && !options.file ? takeEarly(path, signal) : null
      response = (early && await early) ?? await fetch(path, { method, credentials: 'include', signal,
        headers: { Accept: 'application/json', ...(options.ifMatch===undefined?{}:{'If-Match':String(options.ifMatch)}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.file?.headers, ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}), ...(account ? { [accountHeader]: account } : {}), ...(workspace ? { [workspaceHeader]: workspace } : {}) },
        body: options.file?.bytes ?? (options.body === undefined ? undefined : JSON.stringify(options.body)) })
    } catch (error) {
      if (isAbortError(error)) throw error
      analytics().apiError(method, path, undefined, 'NETWORK_UNAVAILABLE')
      throw new ApiError(`Cannot reach ${productName}. Check the API service and try again.`, 'NETWORK_UNAVAILABLE')
    }
    data = await response.json().catch(() => null)
  } finally {
    if (trackedWrite) activeWrites.delete(trackedWrite)
    linked?.cleanup()
  }
  // The tab switched accounts or workspaces while this was in flight: its answer belongs to the other scope and is never shown.
  if (pinnedScope && !isCurrentScope(pinnedScope)) throw aborted()
  if (scoped && (epoch !== selectionEpoch || (account !== null && account !== accountSelection) || (workspace !== null && workspace !== workspaceSelection))) throw aborted()
  const durationMs = Number((performance.now() - started).toFixed(1))
  if (path.includes('/campaigns') || path === '/api/auth/get-session' || path === '/v1/me') console.info(`[${productName} timing] request`, {
    path: new URL(path, window.location.origin).pathname,
    status: response.status,
    durationMs,
    serverTiming: response.headers.get('server-timing') ?? 'unavailable',
    requestId: response.headers.get('x-request-id') ?? 'unavailable',
  })
  if (!response.ok) {
    const error = typeof data === 'object' && data !== null && 'error' in data ? (data as Partial<SdkApiError>).error : undefined
    const code = typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`
    const message = typeof error?.message === 'string' ? error.message : 'Couldn’t complete the request.'
    if (response.status === 401 && path.startsWith('/v1/') && path !== '/v1/me') window.dispatchEvent(new Event(code === 'ACCOUNT_SIGNED_OUT' ? 'nightmail:account-signed-out' : 'nightmail:unauthorized'))
    analytics().apiError(options.method ?? 'GET', path, response.status, code, typeof error?.field === 'string' ? error.field : undefined)
    const failure = new ApiError(message, code, error?.field ? { [error.field]: message } : {}, error?.requestId ?? response.headers.get('x-request-id') ?? undefined, response.status)
    const retryAfterHeader = Number(response.headers.get('retry-after'))
    if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) failure.retryAfter = retryAfterHeader
    if (error?.retryable === true) failure.retryable = true
    if (failure.requestId) rememberFailedRequest(failure.requestId)
    if (Array.isArray(error?.details)) failure.details = error.details
    throw failure
  }
  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    throw new ApiError('The response was not complete.', 'INVALID_RESPONSE', {}, response.headers.get('x-request-id') ?? undefined, response.status)
  }
  if (data === null && response.status !== 204 && path !== '/api/auth/get-session') {
    const failure = new ApiError('The response ended before finishing. Try again.', 'INVALID_RESPONSE', {}, response.headers.get('x-request-id') ?? undefined, response.status)
    failure.retryable = true
    throw failure
  }
  analytics().apiResult(options.method ?? 'GET', path, data)
  return data as T
}
const mapContact = (r: SdkContact | SdkContactRead | SdkContactDetail): Contact => ({
  id: r.id,
  email: r.email,
  name: r.name ?? '',
  properties: r.properties,
  country: typeof r.properties?.country === 'string' ? r.properties.country : '',
  status: r.suppressed ? 'suppressed' : r.marketingConsent,
  listIds: 'listIds' in r ? r.listIds : [],
  createdAt: r.createdAt,
  lastOpenedAt: r.lastOpenAt,
  suppressionReason: r.suppressionReason ?? undefined,
  risk: r.risk ?? null,
  ...('topics' in r ? { topics: r.topics } : {}),
})
const mapList = (r: SdkContactList | SdkContactListRead): AudienceList => {
  const counts = 'counts' in r ? r.counts : null
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    total: counts?.total,
    subscribed: counts?.subscribed,
    unsubscribed: counts?.unsubscribed,
    suppressed: counts?.suppressed,
    unknown: counts?.unknown,
  }
}
const mapSegment = (r: SdkSegment): Segment => ({ id: r.id, name: r.name, rule: r.rule, updatedAt: r.updatedAt })
const mapCampaign = (r: SdkCampaign): Campaign => ({
  id: r.id,
  status: r.state,
  counts: r.counts,
  delivery: r.delivery ?? null,
  sendEstimate: r.sendEstimate ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  scheduledAt: r.scheduledAt,
  archivedAt: r.archivedAt ?? null,
  revision: r.revision,
  sourceTemplateId: r.sourceTemplateId,
  sourceTemplateRevision: r.sourceTemplateRevision,
  draft: r.draft,
  regionId: r.draft.region,
  name: r.draft.name,
  fromEmail: r.draft.from ?? '',
  fromName: r.draft.fromName ?? '',
  replyTo: r.draft.replyTo ?? [],
  unsubscribePageUrl: r.draft.unsubscribePageUrl ?? '',
  requiredNotice: r.draft.requiredNotice === true,
  topicId: r.draft.topicId ?? '',
  subject: r.draft.subject ?? '',
  previewText: r.draft.previewText ?? '',
  html: r.draft.html ?? '',
  listId: r.draft.audience?.listId ?? '',
  segmentId: r.draft.audience?.segmentId ?? null,
  attachments: r.draft.attachments ?? [],
  recipients: r.delivery?.total ?? r.counts?.total,
  delivered: r.counts?.byStatus?.delivered,
  bounced: r.counts?.byStatus?.bounced,
  complaints: r.counts?.byStatus?.complained,
})
const mapCampaignSummary = (r: SdkCampaignSummary): Campaign => ({
  id: r.id,
  status: r.state,
  stats: r.stats,
  counts: r.counts,
  delivery: r.delivery ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  scheduledAt: r.scheduledAt,
  archivedAt: r.archivedAt ?? null,
  revision: r.revision,
  sourceTemplateId: r.sourceTemplateId,
  sourceTemplateRevision: r.sourceTemplateRevision,
  regionId: r.draft.region,
  name: r.draft.name,
  fromEmail: r.draft.from ?? '',
  fromName: r.draft.fromName ?? '',
  replyTo: [],
  unsubscribePageUrl: '',
  requiredNotice: false,
  topicId: '',
  subject: r.draft.subject ?? '',
  previewText: r.draft.previewText ?? '',
  html: '',
  listId: r.draft.audience?.listId ?? '',
  segmentId: r.draft.audience?.segmentId ?? null,
  recipients: r.delivery?.total ?? r.counts?.total,
  delivered: r.counts?.byStatus?.delivered,
  bounced: r.counts?.byStatus?.bounced,
  complaints: r.counts?.byStatus?.complained,
})
const nonEmpty = (value: unknown) => typeof value === 'string' && value ? value : undefined
const mapEmailEvent = (r: SdkEmailEvent): EmailEvent => ({
  id: r.id,
  type: r.type,
  at: r.createdAt,
  description: r.type,
  diagnostic: nonEmpty(r.data?.diagnosticCode),
  detail: {
    bounceType: nonEmpty(r.data?.bounceType),
    bounceSubType: nonEmpty(r.data?.bounceSubType),
    delayType: nonEmpty(r.data?.delayType),
    retryUntil: nonEmpty(r.data?.expirationTime),
    feedbackType: nonEmpty(r.data?.complaintFeedbackType),
    link: nonEmpty(r.data?.link),
    bot: r.data?.isBotEvent === true || r.data?.isBotEvent === 'Likely' || undefined,
  },
})
const mapLog = (r: SdkLogEntry): LogEntry => ({ ...r, regionId: r.region })
const mapEmail = (r: SdkEmail): Email => ({
  id: r.id,
  regionId: r.region,
  campaignId: r.campaignId,
  from: r.from,
  fromName: r.fromName ?? undefined,
  stream: r.kind,
  to: r.to.join(', '),
  subject: r.subject,
  status: r.status,
  simulated: r.simulated,
  errorCode: r.errorCode,
  suppressionReason: r.suppressionReason,
  scheduled: r.scheduled,
  scheduledAt: r.scheduledAt,
  sentAt: r.createdAt,
  html: '',
  events: [],
})
const sesStatus = (value: unknown): 'verified' | 'failed' | 'pending' | null => typeof value !== 'string' ? null : value.toUpperCase() === 'SUCCESS' ? 'verified' : ['FAILED', 'TEMPORARY_FAILURE'].includes(value.toUpperCase()) ? 'failed' : 'pending'
const mapDomain = (r: SdkDomainReadiness): Domain => {
  const dkimStatus = sesStatus(r.dkimStatus) ?? 'pending', mailFromStatus = sesStatus(r.mailFromStatus) ?? 'not_configured'
  // The API reports each record's status; older APIs did not, so derive it from the record's purpose.
  const recordStatus = (d: SdkDomainReadiness['dns'][number]): 'verified' | 'pending' => d.status === 'verified' || d.status === 'pending' ? d.status : ((d.purpose ?? (d.type === 'CNAME' ? 'sending' : 'mail_from')) === 'mail_from' ? mailFromStatus : dkimStatus) === 'verified' ? 'verified' : 'pending'
  return {
    id: r.id,
    name: r.name,
    regionId: r.region,
    status: r.ready ? 'verified' : r.verificationStatus === 'FAILED' ? 'issue' : 'pending',
    verified: r.verified,
    dkimStatus,
    mailFromDomain: r.mailFromDomain,
    mailFromStatus,
    sending: r.sending ?? (r.ready ? 'verified' : 'pending'),
    receiving: r.receiving ?? 'pending',
    dmarc: r.dmarc,
    dnsStatus: r.dnsStatus,
    dnsUnavailableReason: r.dnsUnavailableReason,
    dnsHost: r.dnsHost,
    dnsIssue: r.dnsIssue,
    releasesAt: r.releasesAt,
    receivingIssue: r.receivingIssue,
    builtIn: r.builtIn,
    limits: r.limits,
    records: (r.dns ?? []).map((d, i) => ({
      id: String(i),
      type: d.type,
      name: d.name,
      value: d.priority === undefined ? d.value : `${d.priority} ${d.value}`,
      status: recordStatus(d),
      purpose: d.purpose,
      note: d.note,
      publicDns: d.publicDns,
    })),
  }
}
const mapDelivery = (r: SdkWebhookDelivery): WebhookDelivery => ({
  id: r.id,
  at: r.createdAt,
  regionId: r.payload.region ?? 'Workspace',
  event: r.payload.type,
  response: r.lastStatusCode,
  attempts: r.attemptCount,
  status: r.status,
  payload: r.payload,
  test: r.synthetic === true || r.payload.data?.test === true,
})
const mapWebhook = (r: SdkWebhook | SdkCreatedWebhook): Webhook => ({
  id: r.id,
  name: r.description || r.url,
  url: r.url,
  regionIds: r.regions ?? 'all',
  events: r.eventTypes,
  status: r.paused ? 'paused' : 'active',
  secretHint: 'Hidden. Reveal it to copy, or rotate it to replace it.',
  headers: r.headers ?? [],
  deliveries: [],
  updatedAt: r.updatedAt,
  ...('secret' in r && typeof r.secret === 'string' ? { secret: r.secret } : {}),
})
const mapTemplateDraft = (d: SdkCampaignTemplateDraft): CampaignTemplateDraft => ({
  name: d.name,
  description: d.description ?? '',
  subject: d.subject ?? '',
  previewText: d.previewText,
  fromName: d.fromName,
  replyTo: d.replyTo ?? [],
  html: d.html,
  attachments: d.attachments ?? [],
  unsubscribePageUrl: d.unsubscribePageUrl,
})
const mapTemplate = (r: SdkCampaignTemplate): CampaignTemplate => ({
  ...r,
  draft: mapTemplateDraft(r.draft),
  published: r.published ? mapTemplateDraft(r.published) : null,
})
const verdictString = (v: string | boolean | undefined) => typeof v === 'string' ? v : undefined
const mapReceivedEmail = (r: SdkInboundMessageDetail): ReceivedEmailDetail => ({
  id: r.id,
  threadId: r.threadId,
  status: r.status,
  from: r.from,
  to: r.to,
  toCount: r.toCount,
  subject: r.subject,
  snippet: r.snippet,
  receivedAt: r.receivedAt,
  attachmentCount: r.attachmentCount,
  spam: r.spam,
  region: r.region,
  envelopeTo: r.envelopeTo,
  envelopeToCount: r.envelopeToCount,
  addresses: r.addresses,
  sentAt: r.sentAt ?? null,
  cc: r.cc,
  ccCount: r.ccCount,
  replyTo: r.replyTo,
  replyToCount: r.replyToCount,
  messageId: r.messageId,
  inReplyTo: r.inReplyTo,
  references: r.references,
  referencesCount: r.referencesCount,
  text: r.text,
  replyText: r.replyText,
  html: r.html,
  htmlTooComplex: r.htmlTooComplex,
  bodyTruncated: r.bodyTruncated,
  headers: r.headers,
  attachments: r.attachments.map(a => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    contentId: a.contentId,
    disposition: a.disposition === 'inline' ? 'inline' : 'attachment',
    url: a.url ?? null,
  })),
  verdicts: r.verdicts ? {
    spf: verdictString(r.verdicts.spf),
    dkim: verdictString(r.verdicts.dkim),
    dmarc: verdictString(r.verdicts.dmarc),
    spam: verdictString(r.verdicts.spam),
    virus: verdictString(r.verdicts.virus),
  } : undefined,
  sizeBytes: r.sizeBytes,
  rawUrl: r.rawUrl,
  thread: r.thread ?? null,
})
function regionCatalog(value: unknown): RegionCatalog {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const nullableString = (v: unknown) => v === null || typeof v === 'string'
  if (!record(value) || typeof value.defaultRegion !== 'string' || !Array.isArray(value.data) || !value.data.every((row: unknown) => record(row)
    && typeof row.region === 'string' && typeof row.enabled === 'boolean' && typeof row.isDefault === 'boolean'
    && typeof row.discoveryStatus === 'string' && ['not_discovered', 'discovering', 'stale', 'ready', 'needs_provisioning', 'blocked'].includes(row.discoveryStatus)
    && nullableString(row.lastDiscoveredAt) && nullableString(row.provisionJobId) && nullableString(row.provisionError)
    && (row.provisionStatus === null || (typeof row.provisionStatus === 'string' && ['pending', 'running', 'completed', 'failed'].includes(row.provisionStatus))))) {
    throw new ApiError('The API returned an invalid region catalog.', 'INVALID_RESPONSE')
  }
  return value as unknown as RegionCatalog
}

export function createLiveApi(scope?: RequestScope): Api {
  const apiScope: RequestScope | 'unscoped' = scope ?? 'unscoped'
  const call = <T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => request<T>(`/v1${path}`, { method, body, signal, scope: apiScope })
  const inboundCall = <T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => call<T>(`/inbound${path}`, method, body, signal)
  // Page numbers are local navigation only. The API owns cursors and never supplies fictional totals.
  const cursors = new Map<string, Map<number, string | undefined>>()
  // Attachments go up as raw bytes (up to 25 MiB); template assets as base64 JSON (up to 8 MiB).
  const uploadAttachment = (file: File, inline?: {contentId: string}): Promise<Attachment> => {
    if (file.size > 25 * 1024 * 1024) throw new ApiError('Attachments must total at most 25 MiB.', 'ATTACHMENT_TOO_LARGE')
    return request<SdkAttachment>('/v1/attachments/upload', { method: 'POST', scope: apiScope, file: { bytes: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Nightmail-Filename': encodeURIComponent(file.name), ...(inline ? { 'X-Nightmail-Disposition': 'inline', 'X-Nightmail-Content-Id': inline.contentId } : {}) } } })
  }
  const uploadFile = async (path: string, file: File, inline?: {contentId: string}): Promise<Attachment> => {
    if (file.size > 8 * 1024 * 1024) throw new ApiError('Assets must total at most 8 MiB.', 'ATTACHMENT_TOO_LARGE')
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return call<SdkTemplateAsset>(path, 'POST', {filename: file.name, contentType: file.type || 'application/octet-stream', content: btoa(binary), ...(inline ? {disposition: 'inline', contentId: inline.contentId} : {})})
  }
  const logFilters = (input: PageRequest & { direction?: LogDirection }) => ({ direction: input.direction === 'all' ? undefined : input.direction, region: input.regionId, campaignId: input.campaignId, kind: input.stream, status: input.status, search: input.search, from: input.from, to: input.to })
  async function page<TRow, T, TPage extends { data: TRow[]; nextCursor: string | null } = { data: TRow[]; nextCursor: string | null }, X extends object = object>(
    path: string,
    input: PageRequest = {},
    map: (r: TRow) => T,
    filters: Record<string, string | boolean | undefined> = {},
    signal?: AbortSignal,
    extra?: (data: TPage) => X,
  ): Promise<PageResult<T> & X> {
    const limit = Math.min(path === '/domains' ? 10 : 100, input.pageSize ?? 20)
    const key = JSON.stringify([path, limit, filters])
    const history = cursors.get(key) ?? new Map([[1, undefined]])
    cursors.set(key, history)
    const requested = input.page ?? 1
    const current = input.cursor !== undefined || history.has(requested) ? requested : 1
    const cursor = input.cursor ?? history.get(current)
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    const data = await call<TPage>(`${path}?${params}`, 'GET', undefined, signal)
    if (data.nextCursor) history.set(current + 1, data.nextCursor)
    else history.delete(current + 1)
    return { items: data.data.map(map), page: current, pageSize: limit, nextCursor: data.nextCursor, total: undefined, ...extra?.(data) as X }
  }
  const getCampaign = async (id: string, signal?: AbortSignal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}`, 'GET', undefined, signal))
  const getContact = async (id: string, signal?: AbortSignal) => mapContact(await call<SdkContactDetail>(`/contacts/${idPath(id)}`, 'GET', undefined, signal))
  const getWorkspace = async (signal?: AbortSignal) => {
    const [settings, identity] = await Promise.all([call<SdkWorkspaceSettings>('/settings/workspace', 'GET', undefined, signal), call<SdkIdentity>('/me', 'GET', undefined, signal)])
    return { name: settings.name, postalAddress: settings.postalAddress, id: identity.id, role: identity.permissions.join(', ') } satisfies Workspace
  }
  const deliveries = async (id: string, cursor?: string) => { const result = await page<SdkWebhookDelivery, WebhookDelivery, SdkWebhookDeliveryPage>(`/webhooks/${idPath(id)}/deliveries`, { cursor, pageSize: 20 }, mapDelivery); return { items: result.items, nextCursor: result.nextCursor ?? null } }
  return {
    scope: apiScope,
    consentHistory: async (id, cursor) => { const result = await call<SdkConsentEventPage>(`/contacts/${idPath(id)}/consent?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); return { items: result.data, nextCursor: result.nextCursor } },
    emailEvents: async (id, cursor) => { const result = await call<SdkEmailEventPage>(`/emails/${idPath(id)}/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); return { items: result.data.map(mapEmailEvent), nextCursor: result.nextCursor } },
    regions: {
      list: async signal => regionCatalog(await call<unknown>('/regions', 'GET', undefined, signal)),
      configure: async (region, input, signal) => regionCatalog(await call<unknown>(`/regions/${idPath(region)}`, 'PUT', input, signal)),
      discover: (region, options, signal) => call<SdkSesDiscovery>(`/regions/${idPath(region)}/discovery${options?.refresh === true ? '?refresh=true' : ''}`, 'GET', undefined, signal),
      provision: (region, signal) => call<SdkRegionProvisionReceipt>(`/regions/${idPath(region)}/provision`, 'POST', { confirm: true }, signal),
      updateAutoValidation: (region, stream, mode, signal) => call<SdkAutoValidationResponse>(`/regions/${idPath(region)}/auto-validation`, 'PUT', { stream, mode, confirm: true }, signal),
    },
    workspace: { get: getWorkspace, update: async (input, signal) => { await call<SdkWorkspaceSettings>('/settings/workspace', 'PATCH', input, signal); return getWorkspace(signal) },
      settings: signal => call<SdkWorkspaceSettings>('/settings/workspace', 'GET', undefined, signal), updateSettings: (input, signal) => call<SdkWorkspaceSettings>('/settings/workspace', 'PATCH', input, signal) },
    senderScore: { get: signal => call<SdkSenderScore>('/sender-score', 'GET', undefined, signal), release: (input, signal) => call<SdkSenderScore>('/sender-score/release', 'POST', input, signal) },
    overview: { get: async (input, signal) => {
      // The window ends at the API's now, not this device's: a browser clock ahead of the server can't send a start after
      // the end, and the chart below is laid out from the from/to the API answers with.
      const params = new URLSearchParams({ ...(input.regionId ? { region: input.regionId } : {}), from: new Date(Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[input.range]) * 86400000).toISOString() })
      if (input.stream) params.set('stream', input.stream)
      // 24h uses 10-minute buckets (sending_metrics_ten_minute); 7d uses 1-hour and 30d folds 1-hour into 4-hour
      // buckets (sending_metrics_hourly), keeping every range around 144–180 points with zero raw table scans.
      const granularity = input.range === '24h' ? '10m' : 'hour'
      const step = input.range === '24h' ? 600_000 : input.range === '7d' ? 3_600_000 : 4 * 3_600_000
      // One request returns the chart buckets and the previous period's totals.
      const chartParams = new URLSearchParams(params); chartParams.set('granularity', granularity); chartParams.set('include', 'previous')
      const metrics = await call<SdkMetrics>(`/metrics?${chartParams}`, 'GET', undefined, signal)
      if (!metrics.previous) throw new ApiError('The API did not return the previous period’s totals.', 'INVALID_RESPONSE')
      // The public created-cohort contract defines absent UTC buckets as no emails.
      // Fill that known absence across the selected interval, not across guessed history.
      const buckets = granularity === '10m' ? metrics.tenMinute : metrics.hourly
      if (!Array.isArray(buckets)) throw new ApiError('The API did not return the requested chart buckets.', 'INVALID_RESPONSE')
      const series = new Map<number, { sent: number; delivered: number; bounced: number; complaints: number }>()
      for (const row of buckets) {
        const key = Math.floor(Date.parse(row.date) / step) * step
        const acc = series.get(key) ?? { sent: 0, delivered: 0, bounced: 0, complaints: 0 }
        acc.sent += row.count ?? 0; acc.delivered += row.delivered ?? 0; acc.bounced += row.bounced ?? 0; acc.complaints += row.complained ?? 0
        series.set(key, acc)
      }
      const startAt = Math.floor(Date.parse(metrics.from) / step) * step, endAt = Date.parse(metrics.to)
      const points = []
      for (let bucket = startAt; bucket < endAt; bucket += step) {
        const at = new Date(bucket).toISOString(), row = series.get(bucket)
        points.push({ at, sent: row?.sent ?? 0, delivered: row?.delivered ?? 0, bounced: row?.bounced ?? 0, complaints: row?.complaints ?? 0 })
      }
      return { periodStart: metrics.from, periodEnd: metrics.to, sent: metrics.totals.emails, delivered: metrics.totals.delivered, bounced: metrics.totals.bounced, complaints: metrics.totals.complained, deferred: metrics.totals.deliveryDelayed, previousSent: metrics.previous.totals.emails, points }
    },
    // One read for Overview's setup and next steps; each part is null where its own list would refuse this session.
    setup: async signal => { const r = await call<Omit<SdkOverviewSetup, 'domains'> & { domains: SdkDomainPage | null }>('/overview/setup', 'GET', undefined, signal); return { ...r, domains: r.domains ? r.domains.data.map(mapDomain) : null } satisfies OverviewSetup } },
    logs: {
      list: (input, signal) => page<SdkLogEntry, LogEntry, SdkLogPage>('/logs', input, mapLog, logFilters(input), signal),
      facets: async (input, signal) => {
        const params = new URLSearchParams({ mode: input.mode, range: input.range })
        if (input.mode === 'refresh' && input.range === '24h' && foldableFacetView(input)) params.set('prefer', 'recent')
        const { from, to, search, campaignId, ...rolling } = logFilters(input)
        const filters = input.mode === 'last' ? rolling : { ...rolling, from, to, search, campaignId }
        for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
        const data = await request<unknown>(`/v1/logs/facets?${params}`, { method: 'GET', expectedStatus: 200, scope: apiScope, signal })
        return countPending(decodeLogFacets(data, input), params.toString())
      },
    },
    emails: {
      list: (input, signal) => page<SdkEmail, Email, SdkEmailPage>('/emails', input, mapEmail, { region: input.regionId, campaignId: input.campaignId, kind: input.stream, status: input.status, search: input.search, to: input.to, from: input.from }, signal),
      get: async (id, signal) => {
        const { email, content, events, contact, thread } = await call<SdkEmailDetail>(`/emails/${idPath(id)}/detail`, 'GET', undefined, signal)
        return { ...mapEmail(email), html: content.html ?? '', text: content.text, attachments: content.attachments, events: events.data.map(mapEmailEvent), eventsNextCursor: events.nextCursor, contact, thread: thread ?? null }
      },
      cancel: async (id, signal) => mapEmail(await call<SdkEmail>(`/emails/${idPath(id)}/cancel`, 'POST', undefined, signal)),
      reschedule: async (id, scheduledAt, signal) => mapEmail(await call<SdkEmail>(`/emails/${idPath(id)}/reschedule`, 'POST', { scheduledAt }, signal)),
      check: (input, signal) => call<SdkEmailCheckResult>('/emails/check', 'POST', input, signal) satisfies Promise<SendabilityReport>,
      preview: async ({ source, ...options }, signal): Promise<ClientPreview[]> => (await call<SdkEmailPreviews>('/emails/preview', 'POST', { ...source, ...options }, signal)).previews,
    },
    newsletters: {
      list: async (signal, cursor) => { const result = await call<SdkNewsletterPage>(`/newsletters?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data as Newsletter[], { nextCursor: result.nextCursor }) },
      get: (id, signal) => call<SdkNewsletterRead>(`/newsletters/${idPath(id)}`, 'GET', undefined, signal),
      create: (input, signal) => call<SdkNewsletter>('/newsletters', 'POST', input, signal),
    },
    campaigns: {
      list: (input, signal) => page<SdkCampaignSummary, Campaign, SdkCampaignPage>('/campaigns', input, mapCampaignSummary, {region: input.regionId, state: input.status, search: input.search, archived: input.archived === true ? 'true' : 'false', listId: input.listId, newsletter: input.newsletter === undefined ? undefined : String(input.newsletter)}, signal), get: getCampaign,
      state: async (id, signal): Promise<CampaignState> => { const r = await call<SdkCampaignState>(`/campaigns/${idPath(id)}/state`, 'GET', undefined, signal); return { id: r.id, revision: r.revision, updatedAt: r.updatedAt, status: r.state, scheduledAt: r.scheduledAt, archivedAt: r.archivedAt } },
      preview: (id, signal) => call<SdkCampaignPreview>(`/campaigns/${idPath(id)}/preview`, 'GET', undefined, signal) satisfies Promise<CampaignPreview>,
      setArchived: async (input, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(input.id)}/archive`, 'PATCH', {archived: input.archived}, signal)),
      save: async (input, signal) => {
        // The MX dashboard's current region is a navigation filter, not a delivery pin.
        const region = selectedWorkspace() ? undefined : input.regionId
        if (!input.id && input.templateId) return mapCampaign(await request<SdkCampaign>('/v1/campaigns', {method: 'POST', body: {templateId: input.templateId, name: input.name, region}, signal, idempotencyKey: input.idempotencyKey, scope: apiScope}))
        const existing = input.draft ?? {}
        const {listId: _oldList, segmentId: _oldSegment, ...audience} = existing.audience ?? {}
        const draft = { ...existing, name: input.name, region, from: input.fromEmail, fromName: input.fromName, replyTo: input.replyTo ?? existing.replyTo ?? [], unsubscribePageUrl: input.unsubscribePageUrl === undefined ? existing.unsubscribePageUrl : input.unsubscribePageUrl.trim() || undefined, requiredNotice: input.requiredNotice === undefined ? existing.requiredNotice : input.requiredNotice || undefined, topicId: input.topicId === undefined ? existing.topicId : input.topicId || undefined, previewText: input.previewText, subject: input.subject, html: input.html, attachments: input.attachments ?? existing.attachments ?? [], defaults: input.defaults ?? existing.defaults ?? {}, audience: {...audience, ...(input.listId ? {listId: input.listId} : {}), ...(input.segmentId ? {segmentId: input.segmentId} : {})} }
        if (input.id && !input.revision) throw new ApiError('Reload this campaign before saving.', 'REVISION_REQUIRED')
        return mapCampaign(await request<SdkCampaign>(input.id ? `/v1/campaigns/${idPath(input.id)}` : '/v1/campaigns', {method: input.id ? 'PATCH' : 'POST', body: input.id ? {revision: input.revision, draft} : {...draft, ...(input.templateId ? {templateId: input.templateId} : {})}, signal, idempotencyKey: input.id ? undefined : input.idempotencyKey, scope: apiScope}))
      },
      audience: async (input, signal): Promise<AudiencePreview> => ({ ...await call<SdkCampaignAudienceCounts>(`/campaigns/${idPath(input.id)}/audience`, 'GET', undefined, signal), contacts: [] }),
      reviewDisplay: (id, revision, check, signal) => call<CampaignReviewDisplay>(
        `/campaigns/${idPath(id)}/review-display?${new URLSearchParams({ revision: String(revision), check: String(check), readiness: 'true' })}`, 'GET', undefined, signal),
      send: async (input, signal): Promise<CampaignSendReceipt> => {
        if (!input.revision) throw new ApiError('Reload this campaign before sending.', 'REVISION_REQUIRED')
        return call<SdkCampaignQueued>(`/campaigns/${idPath(input.id)}/${input.mode === 'schedule' ? 'schedule' : 'send'}`, 'POST', {revision: input.revision, ...(input.mode === 'schedule' ? {scheduledAt: input.scheduledAt} : {}), ...(input.pacing ? {pacing: input.pacing} : {}), ...(input.consent ? {consent: input.consent} : {}), ...(input.confirmRequiredNotice ? {confirmRequiredNotice: true} : {})}, signal)
      },
      pause: async (id, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}/pause`, 'POST', {}, signal)),
      resume: async (id, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}/resume`, 'POST', {}, signal)),
      setPacing: async (id, input, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}/pacing`, 'POST', {perDay: input.perDay, ...(input.autoPause === undefined ? {} : {autoPause: input.autoPause}), ...(input.rateShare === undefined ? {} : {rateShare: input.rateShare})}, signal)),
      unschedule: async (id, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}/unschedule`, 'POST', {}, signal)),
      reschedule: async (id, scheduledAt, signal) => mapCampaign(await call<SdkCampaign>(`/campaigns/${idPath(id)}/reschedule`, 'POST', {scheduledAt}, signal)),
      cancel: async (id, signal) => { const result = await request<SdkCampaignCanceled>(`/v1/campaigns/${idPath(id)}/cancel`, {method: 'POST', signal, idempotencyKey: crypto.randomUUID(), scope: apiScope}); return {canceled: result.canceled, inFlight: result.inFlight} },
      stats: (id, signal) => call<SdkCampaignStats>(`/campaigns/${idPath(id)}/stats`, 'GET', undefined, signal) satisfies Promise<CampaignStats>,
      test: async (input, signal) => { const result = await call<SdkEmailQueued>(`/campaigns/${idPath(input.id)}/test`, 'POST', {to: input.to, ...(input.data && Object.keys(input.data).length ? {data: input.data} : {})}, signal); return {accepted: result.status === 'queued', id: result.id, status: result.status, simulated: result.simulated} }
    },
    attachments: {
      get: (id, signal) => call<SdkAttachment>(`/attachments/${idPath(id)}`, 'GET', undefined, signal),
      content: (id, signal) => call<SdkAttachmentContent>(`/attachments/${idPath(id)}/content`, 'GET', undefined, signal),
      upload: (file, inline) => uploadAttachment(file, inline),
      remove: async id => { await call<unknown>(`/attachments/${idPath(id)}`, 'DELETE') }
    },
    templateAssets: {
      get: (id, signal) => call<SdkTemplateAsset>(`/template-assets/${idPath(id)}`, 'GET', undefined, signal),
      content: (id, signal) => call<SdkTemplateAssetContent>(`/template-assets/${idPath(id)}/content`, 'GET', undefined, signal),
      upload: (file, inline) => uploadFile('/template-assets', file, inline),
      remove: async id => { await call<unknown>(`/template-assets/${idPath(id)}`, 'DELETE') },
    },
    contacts: {
      list: (input, signal) => page<SdkContactRead, Contact, SdkContactPage>('/contacts', input, mapContact, {email: input.email, search: input.search, listId: input.listId, ...(input.status === 'suppressed' ? {suppressed: true} : input.status === 'risky' ? {risky: true, suppressed: false} : input.status ? {consent: input.status, suppressed: false} : {})}, signal),
      get: getContact,
      save: async (input, signal) => {
        const current = input.id ? await call<SdkContactDetail>(`/contacts/${idPath(input.id)}`, 'GET', undefined, signal) : null
        const body = {name: input.name, properties: {...current?.properties, country: input.country}, ...(!input.id ? {email: input.email} : {})}
        const result = await call<SdkContact>(input.id ? `/contacts/${idPath(input.id)}` : '/contacts', input.id ? 'PATCH' : 'POST', body, signal)
        const oldLists: string[] = current?.listIds ?? []
        const added = input.listIds.filter(x => !oldLists.includes(x))
        const removed = oldLists.filter(x => !input.listIds.includes(x))
        for (const listId of added) await call<unknown>(`/lists/${idPath(listId)}/members`, 'POST', {contactIds: [result.id]}, signal)
        for (const listId of removed) await call<unknown>(`/lists/${idPath(listId)}/members/${idPath(result.id)}`, 'DELETE', undefined, signal)
        return added.length || removed.length ? getContact(result.id, signal) : mapContact({ ...result, listIds: oldLists })
      },
      allowRisk: async (id, allowed, signal) => mapContact(await call<SdkContact>(`/contacts/${idPath(id)}`, 'PATCH', {riskAllowed: allowed}, signal)),
    },
    consent: async (id, input) => mapContact(await call<SdkContact>(`/contacts/${idPath(id)}/consent`, 'POST', input)),
    imports: { preview: (input, signal): Promise<ImportPreview> => call<SdkAudienceImport>('/contact-imports', 'POST', input, signal), commit: (id, input, signal): Promise<ImportPreview> => call<SdkCommittedContactImport>(`/contact-imports/${idPath(id)}/commit`, 'POST', input?.consent ? input : undefined, signal) },
    audienceQuery: { plan: (statement): Promise<AudiencePlan> => call<SdkAudienceOperationPlan>('/audience-query/plan', 'POST', {statement}), apply: input => call<SdkAudienceOperationResult>('/audience-query/apply', 'POST', input) },
    lists: { list: (input = {}, signal) => page<SdkContactListRead, AudienceList, SdkContactListPage>('/lists', input, mapList, {search: input.search, counts: input.counts === false ? 'false' : undefined}, signal), get: async (id, signal) => mapList(await call<SdkContactListRead>(`/lists/${idPath(id)}`, 'GET', undefined, signal)), create: async (input, signal) => mapList(await call<SdkContactList>('/lists', 'POST', input, signal)), remove: async (id, signal) => { await call<unknown>(`/lists/${idPath(id)}`, 'DELETE', undefined, signal) } },
    // A workspace has at most 100 topics that aren't archived: one page holds them all.
    topics: { list: async (input = {}, signal) => (await call<SdkTopicPage>(`/topics?limit=100${input.archived ? '&archived=true' : ''}${input.counts ? '&counts=true' : ''}`, 'GET', undefined, signal)).data, create: (input, signal) => call<SdkTopic>('/topics', 'POST', input, signal) satisfies Promise<Topic>, update: (id, input, signal) => call<SdkTopic>(`/topics/${idPath(id)}`, 'PATCH', input, signal) satisfies Promise<Topic> },
    segments: {
      list: (input = {}, signal) => page<SdkSegment, Segment, SdkSegmentPage>('/segments', input, mapSegment, {search: input.search}, signal), get: async (id, signal) => mapSegment(await call<SdkSegment>(`/segments/${idPath(id)}`, 'GET', undefined, signal)),
      save: async (input, signal) => mapSegment(await call<SdkSegment>(input.id ? `/segments/${idPath(input.id)}` : '/segments', input.id ? 'PATCH' : 'POST', {name: input.name, rule: input.rule}, signal)),
      preview: async (input, signal): Promise<AudiencePreview> => ({...await call<SdkSegmentPreview>(`/segments/${idPath(input.id)}/preview`, 'POST', input.listId ? {listId: input.listId} : {}, signal), contacts: []})
    },
    keys: {
      list: async (signal, cursor, includeRevoked = true) => { const result = await call<SdkApiKeyPage>(`/api-keys?limit=100&includeRevoked=${includeRevoked}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data as ApiKey[], { nextCursor: result.nextCursor }) },
      create: async (input, signal) => { const { secret, nextStep: _nextStep, ...key } = await call<SdkCreateApiKeyResponse>('/api-keys', 'POST', input, signal); return { key, secret } },
      update: (id, change, signal) => call<SdkApiKey>(`/api-keys/${idPath(id)}`, 'PATCH', change, signal),
      changes: async (id, signal): Promise<AuditEntry[]> => (await call<SdkApiKeyChangePage>(`/api-keys/${idPath(id)}/changes?limit=20`, 'GET', undefined, signal)).data,
      revoke: async (id, signal) => { await call<unknown>(`/api-keys/${idPath(id)}/revoke`, 'POST', undefined, signal) }
    },
    credentials: {
      agents: async (includeInactive = false, signal): Promise<Agent[]> => (await call<SdkAgentList>(`/agents?includeInactive=${includeInactive}`, 'GET', undefined, signal)).data,
      revokeAgent: (id, signal) => call<SdkRevokeAgentResponse>(`/agents/${idPath(id)}/revoke`, 'POST', undefined, signal),
      revokeAgentToken: async (id, signal) => { await call<unknown>(`/agent-tokens/${idPath(id)}/revoke`, 'POST', undefined, signal) },
      bindMcpConnection: async (id, input, signal) => { await call<unknown>(`/mcp-connections/${idPath(id)}/workspace`, 'POST', input, signal) },
      appPasswords: async (signal): Promise<AppPassword[]> => (await call<SdkAppPasswordList>('/app-passwords', 'GET', undefined, signal)).data,
      createAppPassword: ({ inboxId, ...input }, signal): Promise<CreatedAppPassword> => call<SdkCreateInboxAppPasswordResponse>(`/inboxes/${idPath(inboxId)}/app-passwords`, 'POST', input, signal),
      revokeAppPassword: async (inboxId, id, signal) => { await call<unknown>(`/inboxes/${idPath(inboxId)}/app-passwords/${idPath(id)}`, 'DELETE', undefined, signal) },
    },
    templates: {
      list: (input = {}, signal) => page<SdkCampaignTemplateSummary, CampaignTemplateSummary, SdkCampaignTemplatePage>('/templates', input, row => row, {search: input.search, archived: input.archived === true ? 'true' : 'false', publishedOnly: input.publishedOnly === true ? 'true' : 'false'}, signal),
      get: async (id, signal) => mapTemplate(await call<SdkCampaignTemplate>(`/templates/${idPath(id)}`, 'GET', undefined, signal)),
      create: async (input, signal) => mapTemplate(await call<SdkCampaignTemplate>('/templates', 'POST', input, signal)),
      update: async (id, revision, draft, signal) => mapTemplate(await call<SdkCampaignTemplate>(`/templates/${idPath(id)}`, 'PATCH', {revision, draft}, signal)),
      publish: async (id, revision, signal) => mapTemplate(await call<SdkCampaignTemplate>(`/templates/${idPath(id)}/publish`, 'POST', {revision}, signal)),
      archive: async (id, archived, signal) => mapTemplate(await call<SdkCampaignTemplate>(`/templates/${idPath(id)}/archive`, 'PATCH', {archived}, signal)),
      remove: async (id, signal) => { await call<unknown>(`/templates/${idPath(id)}`, 'DELETE', undefined, signal) },
      preview: (id, published = false, signal) => call<SdkCampaignTemplatePreview>(`/templates/${idPath(id)}/preview?published=${published}`, 'GET', undefined, signal),
    },
    domains: { list: (input, signal) => page<SdkDomainReadiness, Domain, SdkDomainPage, { quota?: DomainQuota }>('/domains', input, mapDomain, {region: input.regionId, refresh: input.refresh === false ? 'false' : undefined}, signal, data => ({ quota: data.quota })), get: async (id, signal) => mapDomain(await call<SdkDomainReadiness>(`/domains/${idPath(id)}`, 'GET', undefined, signal)), create: async (input, signal) => mapDomain(await call<SdkDomainReadiness>('/domains', 'POST', {name: input.name, region: input.regionId || undefined}, signal)), configureMailFrom: async (id, mailFromDomain, signal) => mapDomain(await call<SdkDomainReadiness>(`/domains/${idPath(id)}/mail-from`, 'POST', {mailFromDomain}, signal)), removeMailFrom: async (id, signal) => mapDomain(await call<SdkDomainReadiness>(`/domains/${idPath(id)}/mail-from`, 'DELETE', undefined, signal)), verify: async (id, signal) => mapDomain(await call<SdkDomainReadiness>(`/domains/${idPath(id)}/verify`, 'POST', undefined, signal)), chooseReceivingHost: async (id, input, signal) => mapDomain(await call<SdkDomainReadiness>(`/domains/${idPath(id)}/receiving-host`, 'POST', {host: input.host, confirm: input.confirm ?? false}, signal)), remove: async (id, signal) => { await call<unknown>(`/domains/${idPath(id)}`, 'DELETE', undefined, signal) } },
    mailboxes: {
      domains: async (signal): Promise<MailboxDomain[]> => (await inboundCall<SdkInboundDomainList>('/domains', 'GET', undefined, signal)).data,
      domain: (id, signal): Promise<MailboxDomain> => inboundCall<SdkInboundDomain>(`/domains/${idPath(id)}`, 'GET', undefined, signal),
      enableDomain: (id, input, signal): Promise<MailboxDomain> => inboundCall<SdkInboundDomain>(`/domains/${idPath(id)}/enable`, 'POST', { force: input.force ?? false }, signal),
      disableDomain: (id, signal): Promise<MailboxDomain> => inboundCall<SdkInboundDomain>(`/domains/${idPath(id)}/disable`, 'POST', undefined, signal),
      checkDomain: (id, signal): Promise<MailboxDomain> => inboundCall<SdkInboundDomain>(`/domains/${idPath(id)}/check`, 'POST', undefined, signal),
      receivedEmail: async (id, signal, delivery = true) => mapReceivedEmail(await inboundCall<SdkInboundMessageDetail>(`/messages/${idPath(id)}?includeDelivery=${delivery}&includeHtml=true&includeThread=true`, 'GET', undefined, signal)),
    },
    inboxes: {
      folders: async (id, signal) => {
        const result = await call<SdkInboxFolderList>(`/inboxes/${idPath(id)}/folders`, 'GET', undefined, signal)
        return { data: [...result.data, ...(result.additionalFolders ?? [])] }
      },
      list: async (input, signal) => { const query = new URLSearchParams({ limit: '50', ...(input.search ? { q: input.search } : {}), ...(input.type ? { type: input.type } : {}), ...(input.status ? { status: input.status } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }); const result = await call<SdkInboxPage>(`/inboxes?${query}`, 'GET', undefined, signal); return Object.assign(result.data as Inbox[], { nextCursor: result.nextCursor }) },
      get: (id, signal): Promise<Inbox> => call<SdkInbox>(`/inboxes/${idPath(id)}`, 'GET', undefined, signal),
      create: (input, signal): Promise<CreatedInbox> => call<SdkCreatedInbox>('/inboxes', 'POST', input, signal),
      remove: async (id, signal) => { await call<unknown>(`/inboxes/${idPath(id)}`, 'DELETE', undefined, signal) },
      messages: (id, input, signal): Promise<InboxMessagePage> => call<SdkInboxMessagePage>(`/inboxes/${idPath(id)}/messages?${new URLSearchParams({ ...(input.folder?{folder:input.folder}:{include:'held'}), extract: 'codes,links', limit: '50', ...(input.after ? { after: input.after } : {}) })}`, 'GET', undefined, signal),
      message: (id, messageId, signal): Promise<InboxMessageDetail> => call<SdkInboxMessageDetail>(`/inboxes/${idPath(id)}/messages/${idPath(messageId)}?extract=codes,links`, 'GET', undefined, signal),
    },
    inbound: {
      addresses: async (input, signal) => { const query = new URLSearchParams({ limit: '100', ...(input.kind ? { kind: input.kind } : {}), ...(input.search ? { q: input.search } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }); const result = await inboundCall<SdkInboundAddressPage>(`/addresses?${query}`, 'GET', undefined, signal); return Object.assign(result.data as InboundAddress[], { nextCursor: result.nextCursor }) },
      address: (id, signal): Promise<InboundAddress> => inboundCall<SdkInboundAddress>(`/addresses/${idPath(id)}`, 'GET', undefined, signal),
      createAddress: (input, signal): Promise<InboundAddress> => inboundCall<SdkInboundAddress>('/addresses', 'POST', input, signal),
      updateAddress: (id, patch, signal): Promise<InboundAddress> => inboundCall<SdkInboundAddress>(`/addresses/${idPath(id)}`, 'PATCH', patch, signal),
      // The dashboard confirms deletion, so routes that deliver to it lose it in the same change.
      deleteAddress: async (id, signal) => { await inboundCall<unknown>(`/addresses/${idPath(id)}?detach=true`, 'DELETE', undefined, signal) },
      threads: async (input, signal) => { const query = new URLSearchParams({ view: input.view, limit: '50', ...(input.addressId ? { addressId: input.addressId } : {}), ...(input.q ? { q: input.q } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }); const result = await inboundCall<SdkInboundThreadPage>(`/threads?${query}`, 'GET', undefined, signal); return Object.assign(result.data as InboundThread[], { nextCursor: result.nextCursor }) },
      thread: (id, input, signal): Promise<InboundThreadDetail> => { const query = new URLSearchParams({ limit: '50', ...(input.addressId ? { addressId: input.addressId } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }); return inboundCall<SdkInboundThreadDetail>(`/threads/${idPath(id)}?${query}`, 'GET', undefined, signal) },
      updateThread: (threadId, patch, signal): Promise<InboundAddressState> => inboundCall<SdkInboundThreadAddressState>(`/threads/${idPath(threadId)}`, 'PATCH', patch, signal),
      message: (id, input, signal): Promise<InboundMessageDetail> => inboundCall<SdkInboundMessageDetail>(`/messages/${idPath(id)}?${new URLSearchParams({ includeHtml: 'true', ...(input.addressId ? { addressId: input.addressId } : {}) })}`, 'GET', undefined, signal),
      attachmentUrl: (messageId, attachmentId, input, signal) => inboundCall<SdkInboundAttachmentDownload>(`/messages/${idPath(messageId)}/attachments/${idPath(attachmentId)}${input.addressId ? `?addressId=${encodeURIComponent(input.addressId)}` : ''}`, 'GET', undefined, signal),
      reply: (threadId, { idempotencyKey, ...input }, signal): Promise<InboundMessage> => request<SdkInboundMessage>(`/v1/inbound/threads/${idPath(threadId)}/reply`, { method: 'POST', body: input, signal, idempotencyKey, scope: apiScope }),
      startThread: ({ idempotencyKey, ...input }, signal): Promise<InboundMessage> => request<SdkInboundMessage>('/v1/inbound/threads', { method: 'POST', body: input, signal, idempotencyKey, scope: apiScope }),
      webhooks: async (signal, cursor) => { const result = await inboundCall<SdkInboundWebhookList>(`/webhooks?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data as InboundWebhook[], { nextCursor: result.nextCursor }) },
      forwards: async signal => {
        const all: ForwardEndpoint[] = []
        for (let cursor: string | null = null; ;) {
          const result: SdkEndpointPage = await call<SdkEndpointPage>(`/endpoints?type=forward&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal)
          all.push(...result.data)
          if (!(cursor = result.nextCursor)) return all
        }
      },
      webhook: (id, signal): Promise<InboundWebhook> => inboundCall<SdkInboundWebhook>(`/webhooks/${idPath(id)}`, 'GET', undefined, signal),
      updateWebhook: (id, patch, signal): Promise<SdkUpdatedInboundWebhook> => inboundCall<SdkUpdatedInboundWebhook>(`/webhooks/${idPath(id)}`, 'PATCH', patch, signal),
      deleteWebhook: async (id, signal) => { await inboundCall<unknown>(`/webhooks/${idPath(id)}?detach=true`, 'DELETE', undefined, signal) },
      rotateWebhookSecret: (id, signal) => inboundCall<SdkInboundWebhookRotatedSecret>(`/webhooks/${idPath(id)}/rotate-secret`, 'POST', undefined, signal),
      webhookDeliveries: async (id, cursor, signal) => { const result = await inboundCall<SdkInboundWebhookDeliveryPage>(`/webhooks/${idPath(id)}/deliveries?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data as MailboxWebhookDelivery[], { nextCursor: result.nextCursor }) },
    },
    routing: {
      routes: (signal): Promise<{ version: number; routes: MailRoute[] }> => call<SdkRoutingConfig>('/routing', 'GET', undefined, signal),
      createRoute: (input, signal): Promise<MailRoute> => call<SdkMailRoute>('/routing/routes', 'POST', input, signal),
      updateRoute: (id, patch, signal): Promise<MailRoute> => call<SdkMailRoute>(`/routing/routes/${idPath(id)}`, 'PATCH', patch, signal),
      deleteRoute: async (id, signal) => { await call<unknown>(`/routing/routes/${idPath(id)}`, 'DELETE', undefined, signal) },
      test: (input, signal): Promise<RoutingTestResult> => call<SdkRoutingTestResult>('/routing/test', 'POST', { ...(input.to ? { envelope: { to: input.to } } : {}), ...(input.raw ? { raw: input.raw } : {}), verdicts: { spam: input.junk ? 'FAIL' : 'PASS', dmarc: 'PASS' } }, signal),
    },
    webhooks: {
      list: async (signal, cursor) => { const result = await call<SdkWebhookPage>(`/webhooks?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data.map(mapWebhook), { nextCursor: result.nextCursor }) },
      get: async (id, signal) => { const [row, history] = await Promise.all([call<SdkWebhook>(`/webhooks/${idPath(id)}`, 'GET', undefined, signal), deliveries(id)]); return { ...mapWebhook(row), deliveries: history.items, nextCursor: history.nextCursor } },
      create: async (input, signal) => mapWebhook(await call<SdkCreatedWebhook>('/webhooks', 'POST', {description: input.name, url: input.url || undefined, ...(input.regionIds === undefined ? {} : {regions: input.regionIds === 'all' ? null : input.regionIds}), eventTypes: input.events, headers: input.headers}, signal)),
      // A changed field at a time: a field the form didn't change keeps whatever the webhook has now.
      update: async (id, edits, headers, signal) => mapWebhook(await call<SdkWebhook>(`/webhooks/${idPath(id)}`, 'PATCH', webhookPatchBody(edits, headers), signal)),
      setStatus: async (id, status, signal) => mapWebhook(await call<SdkWebhook>(`/webhooks/${idPath(id)}`, 'PATCH', {paused: status === 'paused'}, signal)),
      test: async (id, signal) => { const queued = await call<SdkQueuedWebhookDelivery>(`/webhooks/${idPath(id)}/test`, 'POST', undefined, signal); return mapDelivery(await call<SdkWebhookDelivery>(`/webhooks/${idPath(id)}/deliveries/${idPath(queued.id)}`, 'GET', undefined, signal)) },
      retry: async (id, deliveryId, signal) => { await call<unknown>(`/webhooks/${idPath(id)}/deliveries/${idPath(deliveryId)}/retry`, 'POST', undefined, signal); return mapDelivery(await call<SdkWebhookDelivery>(`/webhooks/${idPath(id)}/deliveries/${idPath(deliveryId)}`, 'GET', undefined, signal)) },
      rotate: (id, signal) => call<SdkWebhookSecret>(`/webhooks/${idPath(id)}/rotate-secret`, 'POST', undefined, signal), reveal: (id, signal) => call<SdkWebhookSecret>(`/webhooks/${idPath(id)}/secret`, 'GET', undefined, signal), remove: async (id, signal) => { await call<unknown>(`/webhooks/${idPath(id)}`, 'DELETE', undefined, signal) }
    },
    webhookDeliveries: deliveries
  }
}
