import type { WorkspaceFocus } from '../../../api/src/workspace-focus.js'
import { productName } from '../../../api/src/brand.js'
import type { Grade, Step } from '../../../api/src/standing-model.js'
import type { WebhookFields } from '../features/settings/webhook-patch.js'
export type RegionId = string
export type ISODate = string
export type Stream = 'transactional' | 'marketing'
export type AutoValidationMode = 'inherit' | 'off' | 'managed' | 'medium' | 'high' | 'unknown'
export type EmailStatus = 'queued' | 'attempting' | 'accepted' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'complaint' | 'deferred' | 'rejected' | 'rendering_failed' | 'delayed' | 'suppressed' | 'canceled' | 'acceptance_unknown' | 'simulated'
// Statuses a sent email can still leave without anyone acting on it: a page showing one reads it again until it settles.
export const pendingEmailStatuses: readonly string[] = ['queued', 'attempting', 'accepted', 'sent', 'deferred', 'delayed'] satisfies EmailStatus[]
export type ContactStatus = 'unknown' | 'subscribed' | 'unsubscribed' | 'suppressed'
// The API's campaign states.
export type CampaignStatus = 'draft' | 'preparing' | 'scheduled' | 'sending' | 'paused' | 'done' | 'failed' | 'canceled'
// Editable, deletable and launchable from scratch: a draft, or a failed launch that released nothing. A failed launch that
// already released recipients can only resume from its cursor or be canceled (it still holds its reservation).
export const campaignEditable = (campaign: Pick<Campaign, 'status' | 'delivery'>) => campaign.status === 'draft' || (campaign.status === 'failed' && !(campaign.delivery?.expanded ?? 0))
export const campaignResumable = (campaign: Pick<Campaign, 'status' | 'delivery'>) => campaign.status === 'paused' || (campaign.status === 'failed' && (campaign.delivery?.expanded ?? 0) > 0)
export const campaignActive = (campaign: Pick<Campaign, 'status' | 'delivery'>) => ['preparing', 'scheduled', 'sending', 'paused'].includes(campaign.status) || campaignResumable(campaign)
export type WebhookEvent = 'send' | 'delivered' | 'bounced' | 'complaint' | 'rejected' | 'delivery_delayed' | 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.rejected' | 'email.rendering_failed' | 'email.delivery_delayed' | 'email.opened' | 'email.clicked' | 'contact.subscription_changed' | 'account.standing.changed'
export type TimeRange = '24h' | '7d' | '30d'
export interface PageRequest { page?: number; pageSize?: number; search?: string; regionId?: RegionId; status?: string; stream?: string; listId?: string; segmentId?: string; campaignId?: string; cursor?: string; to?: string; from?: string }
/** Hosted: domains in the workspace and how many it may have (100 unless Nightmail raised it on request). */
export interface DomainQuota { used: number; limit: number }
export interface PageResult<T> { items: T[]; total?: number; nextCursor?: string | null; page: number; pageSize: number; facets?: Record<string, number> }
export interface RegionCatalogEntry {
  region: string; enabled: boolean; isDefault: boolean
  discoveryStatus: 'not_discovered' | 'discovering' | 'stale' | 'ready' | 'needs_provisioning' | 'blocked'
  lastDiscoveredAt: string | null; provisionJobId: string | null
  provisionStatus: 'pending' | 'running' | 'completed' | 'failed' | null; provisionError: string | null
}
export interface RegionCatalog { defaultRegion: string; data: RegionCatalogEntry[] }
export interface RegionConfigureInput { enabled?: boolean; makeDefault?: boolean }
export interface RegionProvisionReceipt { jobId: string; status: 'pending' | 'running' }
export interface SesDiscovery {
  region: string; checkedAt: string
  account: { id: string; productionAccess: boolean | null; sendingEnabled: boolean | null; enforcementStatus: string | null; quota: { max24HourSend: number | null; maxSendRate: number | null; sentLast24Hours: number | null } } | null
  domains: { name: string; verificationStatus: string | null; sendingEnabled: boolean | null }[]
  identitiesTruncated: boolean
  resources: {
    transactional: SesConfigurationSet; marketing: SesConfigurationSet; eventDestinationName: string
    topic: { name: string; arn: string | null; exists: boolean | null; owned: boolean | null; policyReady: boolean | null; subscription: 'unknown' | 'missing' | 'pending' | 'confirmed'; rawMessageDelivery: boolean | null; subscriptionsTruncated: boolean; staleSubscriptions: number }
  }
  feedbackUrl: string | null; status: 'ready' | 'needs_provisioning' | 'blocked'; provisioned: boolean
  blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[]
  reputation?: SesReputation | null
}
export interface SesReputation { available: boolean; reason: string | null; bounceRate: number | null; complaintRate: number | null; series: { at: string; bounceRate: number | null; complaintRate: number | null }[] }
interface SesConfigurationSet { name: string; exists: boolean | null; owned: boolean | null; sendingEnabled: boolean | null; eventDestinationExists: boolean | null; eventWired: boolean | null; autoValidation: AutoValidationMode | null }
export interface Workspace { id: string; name: string; postalAddress: string | null; accountId?: string; role: string; members?: { id: string; name: string; email: string; role: string }[] }
/** GET /v1/settings/workspace: the name and the postal address every campaign footer shows (null until set). */
// requiredNotices: an operator let this workspace's campaigns be required notices (Campaign.requiredNotice).
export interface WorkspaceSettings { name: string; postalAddress: string | null; requiredNotices?: boolean; focus?: WorkspaceFocus[] | null }
/** What a provider event recorded: a bounce's SES type and subtype, a delay's type and when SES stops retrying, a complaint's feedback type, a click's link, and whether SES thought an open or click came from a bot. */
export interface EmailEventDetail { bounceType?: string; bounceSubType?: string; delayType?: string; retryUntil?: ISODate; feedbackType?: string; link?: string; bot?: boolean }
/** diagnostic: a bounce's or a delay's reply from the receiving server, as SES reported it. */
export interface EmailEvent { id: string; type: string; at: ISODate; description: string; diagnostic?: string; detail?: EmailEventDetail }
/** POST /v1/emails/check: an advisory 0–100 sendability score, never an inbox-placement probability. */
export type SendabilityCategory = 'authentication' | 'content' | 'headers' | 'size' | 'rendering' | 'reputation'
/** fix: what to do, in plain words; fixIn: where it is done (the From domain, the workspace's settings, how it is sent, or the message). */
export interface SendabilityFinding { ruleId: string; category: SendabilityCategory; severity: 'info' | 'warning' | 'error'; title: string; detail: string; fix: string; fixIn: 'domain' | 'workspace' | 'sending' | 'message'; evidence?: Record<string, number | string> }
/** domainId: the From domain's, when it is one of the workspace's. */
export interface SendabilityReport { score: number; grade: SenderGrade; domainId: string | null; categories: { id: SendabilityCategory; score: number; weight: number }[]; findings: SendabilityFinding[] }
export type EmailCheckInput = { emailId: string } | { campaignId: string }
/** POST /v1/emails/preview: offline per-client emulation. Classic Outlook for Windows is lint only (empty html). */
export type PreviewClient = 'gmail-web' | 'gmail-ios' | 'gmail-android' | 'gmail-ios-non-google' | 'gmail-android-non-google' | 'apple-mail-macos' | 'apple-mail-ios' | 'outlook-web' | 'outlook-new-windows' | 'outlook-mac' | 'outlook-classic-windows' | 'yahoo-web' | 'aol-web' | 'samsung-email'
export interface PreviewIssue { feature: string; clients: PreviewClient[]; severity: 'warning' | 'error' }
export interface ClientPreview { client: PreviewClient; html: string; issues: PreviewIssue[] }
export interface EmailPreviewRequest { source: { emailId: string } | { html: string }; clients: PreviewClient[]; theme: 'light' | 'dark'; device: 'desktop' | 'mobile' }
export interface Email { scheduled?: boolean; scheduledAt?: ISODate | null; errorCode?: string | null; suppressionReason?: string | null; contact?: {id:string; suppressed:boolean; suppressedAt?: ISODate | null} | null; campaignId?: string | null; text?: string | null; eventsNextCursor?: string | null; fromName?: string; simulated?: boolean; attachments?: string[]; id: string; regionId: RegionId; to: string; from: string; subject: string; stream: Stream; status: EmailStatus; sentAt: ISODate; html: string; events: EmailEvent[]; thread?: EmailThread | null }
/** The conversation an email belongs to (getEmailDetail, getInboundMessage?includeThread=true): up to 50 of the messages around it, oldest first, and how many the reader sees. */
export interface EmailThread { id: string; count: number; messages: ThreadMessage[] }
/** id: the stored message (msg_…), or an email that answers by header and has no copy (its email ID). emailId: the sent email, on outbound messages. */
export interface ThreadMessage { id: string; emailId: string | null; direction: 'inbound' | 'outbound'; from: MailAddress; snippet: string; at: ISODate; status: string; attachmentCount: number }
export interface ChartPoint { at: ISODate; sent: number; delivered: number; bounced: number; complaints: number }
/** GET /v1/sender-score: the workspace's reputation grade, computed by the API. */
export type SenderGrade = Grade
export interface SenderScoreFactor { key: 'complaints' | 'content' | 'bounces' | 'hygiene' | 'auth' | 'engagement'; label: string; weight: number; value: number | null; score: number | null; points: number | null; source: 'measured' | 'neutral'; basis: string }
/** Hosted only: the daily limit the score sets (rolling 24 hours, recipients; none in good standing), the pace and what changes them. */
export interface SenderLimit { daily: number | null; unlimited: boolean; source: 'calibrating' | 'score' | 'override' | 'exempt'; band: number; next: { limit: number; atScore: number; unlimited: boolean } | null; override: { daily: number; expiresAt: ISODate | null } | null; restore: { daily: number; until: ISODate } | null; strikeCapUntil: ISODate | null; /** The growth pace after the evaluation, while it limits. */ growth: { hourly: number; used: number; until: ISODate } | null; perMinute: number; marketingPerHour: number; transactionalReserve: number }
export type StandingStep = Step
export interface StandingReason { code: string; metric: 'complaints' | 'bounces' | 'marketing_bounces' | 'transactional_bounces' | 'screen' | 'external'; value: number; count: number; threshold: number; minimum: number; window: '24h' | '7d' | null; step: StandingStep; message: string }
/** Hosted only: the enforcement step, why, and what an owner may release from the dashboard. */
export interface SenderStanding { step: StandingStep; reasons: StandingReason[]; since: ISODate; pauseKind: 'bounce' | 'full' | null; marketingHeld: boolean; marketingRelease: { percent: number; until: ISODate } | null; strikes: number; selfService: { available: boolean; action: 'release_marketing' | 'resume_sending' | null; reason: string | null; availableAt: ISODate | null }; version: number; sequence: number }
export interface SenderScore { state: 'warmup' | 'graded'; emails: { firstEmails: number; last30Days: number }; needed: number; calibratedAt: ISODate | null; gradedBy: ISODate | null; score: number | null; grade: SenderGrade | null; target: number; raw: number; band: { min: number; max: number } | null; next: { grade: SenderGrade; at: number } | null; factors: SenderScoreFactor[]; history: { date: string; score: number }[]; limit: SenderLimit | null; standing: SenderStanding | null; computedAt: ISODate }
/** POST /v1/sender-score/release: the fix checklist an owner confirms before releasing a restrict or a bounce-only pause. */
export interface StandingReleaseInput { checklist: { bouncedRemoved: true; listSourceConfirmed: true } }
export interface Overview { periodStart: ISODate; periodEnd: ISODate; sent: number; delivered: number; bounced: number; complaints: number; deferred: number; previousSent: number; points: ChartPoint[]; recentCampaigns?: Campaign[] }
/** Why list hygiene flags an address (API ContactRisk): campaigns skip the contact unless it is allowed. */
export type RiskReason = 'invalid' | 'disposable' | 'typo_domain' | 'role' | 'dead' | 'no_mail_domain'
export interface ContactRisk { reason: RiskReason; /** For typo_domain: the address it most likely meant. */ suggestion: string | null; allowed: boolean }
export interface RiskBreakdown { total: number; byReason: Record<RiskReason, number> }
export interface Contact { properties?: Record<string, string | number | boolean | null>; id: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[]; createdAt: ISODate; lastOpenedAt: ISODate | null; suppressionReason?: string; risk: ContactRisk | null }
export interface ContactInput { id?: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[] }
export interface AudienceList { unknown?: number; id: string; name: string; total: number; subscribed: number; unsubscribed: number; suppressed: number; createdAt: ISODate }
export interface Segment { rule: Record<string, unknown>; id: string; name: string; updatedAt: ISODate }
export type SegmentInput = Pick<Segment, 'name' | 'rule'> & { id?: string }
/** risky: subscribed and not suppressed, but skipped as risky (not in eligible); riskyByReason only for a campaign's audience. */
export interface AudiencePreview { matched: number; suppressed: number; unsubscribed: number; eligible: number; risky?: number; riskyByReason?: Record<RiskReason, number>; readiness?: CampaignReadiness | null; contacts: Contact[] }
// The API's CampaignReadiness: the send review of a marketing campaign (api/src/standing-model.ts RAMP.readiness).
type HistoryFigures = { largestSend: number; sent: number; bounceRate: number | null; complaintRate: number | null }
export interface CampaignReadiness {
  verdict: 'ready' | 'ramp_recommended' | 'ramp_required'; summary: string | null; reasons: { code: string; message: string }[]; findings?: { code: string; message: string }[]
  domain: { name: string; firstSeenAt: ISODate | null; ageDays: number | null; registeredAt?: string | null; registeredDays?: number | null; dmarc: 'reject' | 'quarantine' | 'none' | 'missing' | 'invalid' | null; mailFrom: 'verified' | 'pending' | 'failed' | 'not_configured'
    sharedLinkPacing?: boolean; linkHost: 'not_configured'; ownLinkHost: { hostname: string; active: boolean } | null; linkOrigin: string | null }
  history: { workspace: HistoryFigures; domain: HistoryFigures }
  list: { recipients: number; risky: number; neverMailed: number | null; createdAt: ISODate | null; lastSentAt: ISODate | null; lastImport: { at: ISODate; contacts: number; consent: string | null } | null }
  sizeJump: number | null; plan: { batches: number[]; seconds: number | null } | null; required: { by: 'NEW_DOMAIN' | 'SIZE_JUMP'; reason?: 'NEW_REGISTRATION' | 'BLOCKLISTED' | 'NEW_DOMAIN' | 'SIZE_JUMP'; maxPerDay: number } | null
}
type ReviewDisplayPart<T> = { data: T; error?: never } | { data?: never; status: number; retryAfter?: number;
  error: { code: string; message: string; field?: string; requestId: string; retryable: boolean; details?: Record<string, unknown>[] } }
export interface CampaignReviewDisplay {
  audience: ReviewDisplayPart<Omit<AudiencePreview, 'contacts'>>
  check: ReviewDisplayPart<SendabilityReport> | null
}
export type CampaignPreview = { html: string; text: string }
// A campaign's last stored count, as the list returns it (null until one exists); listing never counts.
export interface CampaignListStats { tracking: boolean; accepted: number; delivered: number; opened: number; clicked: number; computedAt: ISODate }
// A newsletter is a list with a sender: its ID is the list's, and its issues are the campaigns sent to that list.
// readers: how many can receive an issue, and how many of them joined on each of the last 182 UTC days (oldest first);
// null while a large list has never been counted.
export interface NewsletterReaders { count: number; daily: number[]; since: string; countedAt: ISODate }
export interface Newsletter { id: string; name: string; from: string; fromName: string | null; url: string; createdAt: ISODate; readers?: NewsletterReaders | null }
export interface Campaign { stats?: CampaignListStats | null; counts?: { total: number; byStatus: Record<string, number> }; delivery?: CampaignDelivery | null; sendEstimate?: CampaignSendEstimate | null; archivedAt?: ISODate | null; revision?: number; draft?: Record<string, any>; attachments?: string[]; sourceTemplateId?: string | null; sourceTemplateRevision?: number | null; id: string; regionId: RegionId; name: string; subject: string; previewText: string; fromName: string; fromEmail: string; replyTo: string[]; unsubscribePageUrl: string; requiredNotice: boolean; listId: string; segmentId: string | null; html: string; status: CampaignStatus; createdAt: ISODate; updatedAt: ISODate; scheduledAt: ISODate | null; recipients: number; delivered: number; bounced: number; complaints: number }
// pacing, pausedAt, pauseReason, waiting, and rateShare are optional so older API responses still type-check.
// rateShare is the fraction (0.05–1) of the SES per-second send rate the campaign may use; 1 is the full rate.
export interface CampaignPacing { perDay: number | null; autoPause: boolean; rateShare?: number; windowStartedAt: ISODate | null; windowExpanded: number; nextWindowAt: ISODate | null; plan?: number[] | null; batch?: number | null }
export interface CampaignDelivery { total: number; prepared: number; expanded: number; canceled: number; error: { code: string; message: string } | null; pacing?: CampaignPacing; pausedAt?: ISODate | null; pauseReason?: { code: string; message: string } | null; waiting?: { reason: 'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota' | 'list_probe' | 'balance' | 'feedback_lag' | 'ramp' | 'link_record'; linkHold?: 'daily_budget' | 'blocklist'; until: ISODate } | null; feedbackLag?: { oldestMs: number; lane: 'routine' | 'priority' } | null }
// The API's Campaign.sendEstimate: what is left to release, the region's planned rate, where the sender is on the ramp
// (api/src/standing-model.ts RAMP; step counts from 1) and when the last recipient is expected to go out.
export interface CampaignRamp { step: number; steps: number; ceilingPerHour: number; startedAt: ISODate | null; released: number }
export interface CampaignSendEstimate { recipients: number | null; ratePerSecond: number | null; ramp: CampaignRamp | null; seconds: number | null; finishAt: ISODate | null }
export interface CampaignPacingInput { perDay: number | null; autoPause?: boolean; rateShare?: number }
type CampaignRate = { value: number | null; numerator: number; denominator: number }
// Lifetime distinct email outcomes (GET /v1/campaigns/{id}/stats); outcomes overlap and simulated mail is counted separately.
export interface CampaignStats { tracking: boolean; totals: { accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number; simulated: number }; rates: Record<'delivery' | 'bounce' | 'complaint' | 'open' | 'click', CampaignRate> }
// defaults are the fallback values for {{placeholders}} a contact has no value for (the API's draft.defaults).
export type CampaignInput = Pick<Campaign, 'regionId' | 'name' | 'subject' | 'previewText' | 'fromName' | 'fromEmail' | 'listId' | 'segmentId' | 'html'> & { replyTo?: string[]; unsubscribePageUrl?: string; requiredNotice?: boolean; id?: string; revision?: number; draft?: Record<string, any>; attachments?: string[]; defaults?: Record<string, string>; templateId?: string; idempotencyKey?: string }
export interface CampaignState { id: string; revision: number; updatedAt: ISODate; status: CampaignStatus; scheduledAt: ISODate | null; archivedAt: ISODate | null }
export interface SendCampaignInput { revision?: number; id: string; mode: 'now' | 'schedule'; scheduledAt?: ISODate; pacing?: { perDay?: number | null; autoPause?: boolean; rateShare?: number; plan?: 'recommended' }; consent?: { confirmed: true; source: string }; confirmRequiredNotice?: boolean }
// Settings → Activity's entries (data/activity.ts) and an API key's history: the workspace's audit trail.
export type AuditActorType = 'member' | 'api_key' | 'mcp_grant' | 'agent_token' | 'inbox_key' | 'app_password' | 'operator' | 'support' | 'system' | 'stripe'
export type AuditEntry = {
  id: string
  at: string
  action: string
  actor: { type: AuditActorType; id: string | null; label: string | null; email: string | null }
  via: string
  target: { type: string; id: string | null } | null
  /** The member the event concerns when it is not the actor: whose role changed, or whose support request let Nightmail support in. */
  subject: { userId: string; email: string | null } | null
  summary: Record<string, unknown>
  reason: string | null
  requestId: string | null
  network: string | null
  client: string | null
}
export type KeyPermission = 'read' | 'send' | 'manage'
/** What a key limited to mail may do there: read, send (reply and start conversations), modify (mark read, archive,
 *  label) and create (make agent inboxes and use the ones it made). */
export type MailPermission = 'read' | 'send' | 'modify' | 'create'
/** One API key type. workspace: permissions and domains. addresses: only mail at chosen receiving addresses (null: every
 *  address, including new ones; [] with create: only the inboxes it creates). inbox: one agent inbox. */
export interface ApiKeyAccess { type: 'workspace' | 'addresses' | 'inbox'; addressIds: string[] | null; inboxId: string | null; mail: MailPermission[] }
export interface ApiKey { id: string; name: string; prefix: string; permissions: KeyPermission[]; domains: string[]; createdAt: ISODate; lastUsedAt: ISODate | null; revokedAt: ISODate | null; expiresAt: ISODate | null; access: ApiKeyAccess; approval: ApprovalTie | null; lastChange: Pick<AuditEntry, 'at' | 'action' | 'actor'> | null; agent: { client: string | null } | null }
/** The MCP approvals a key or webhook is tied to: it works only while every one of them is active (active), until the earliest end (endsAt). */
export interface ApprovalTie { active: boolean; endsAt: ISODate; owners: { id: string; endsAt: ISODate; active: boolean }[] }
export type CreateApiKeyAccess = { type: 'workspace' } | { type: 'addresses'; addressIds?: string[]; mail?: MailPermission[] } | { type: 'inbox'; inboxId: string; mail?: MailPermission[] }
/** A limited access takes its abilities in access.mail, without permissions or domains. expiresAt: null never expires. */
export interface ApiKeyInput { name: string; permissions?: KeyPermission[]; domains?: string[]; access?: CreateApiKeyAccess; expiresAt?: ISODate | null }
export interface CreatedApiKey { key: ApiKey; secret: string }
/** updateApiKey: only the fields that change. Domains and addresses are added and removed rather than replaced where
 *  they can be, so an edit made meanwhile elsewhere isn't undone. */
export interface ApiKeyUpdate { name?: string; expiresAt?: ISODate | null; permissions?: KeyPermission[]; domains?: string[]; addDomains?: string[]; removeDomains?: string[];
  access?: { type?: 'addresses' | 'inbox'; inboxId?: string; addressIds?: string[] | null; addAddressIds?: string[]; removeAddressIds?: string[]; mail?: MailPermission[] } }
export interface AgentTokenSummary { id: string; grantId: string; permissions: KeyPermission[]; domains: string[]; purpose: string; expiresAt: ISODate; createdAt: ISODate; lastUsedAt: ISODate | null; revokedAt: ISODate | null }
/** A connected agent (GET /v1/agents): an MCP sign-in and the short-lived agent tokens it made in this workspace. `own`
 *  false is another member's agent that made tokens here (owners and admins see these). */
export interface Agent { id: string; clientId: string; name: string | null; profile: string | null; userEmail: string; own: boolean; status: 'active' | 'revoked' | 'expired'; permissions: KeyPermission[]; workspaceId: string | null; createdAt: ISODate; lastUsedAt: ISODate | null; tokens: AgentTokenSummary[] }
export type AppPasswordProtocol = 'imap' | 'smtp'
export interface AppPassword { id: string; name: string; protocols: AppPasswordProtocol[]; createdAt: ISODate; inboxId: string; inboxAddress: string }
export interface AppPasswordInput { inboxId: string; name: string; protocols: AppPasswordProtocol[] }
export interface CreatedAppPassword { id: string; name: string; protocols: AppPasswordProtocol[]; password: string; createdAt: ISODate }
export interface CampaignTemplateDraft { name: string; description: string; subject: string; previewText?: string; fromName?: string; replyTo: string[]; html?: string; attachments: string[]; unsubscribePageUrl?: string }
export interface CampaignTemplate { id: string; url: string; revision: number; draft: CampaignTemplateDraft; published: CampaignTemplateDraft | null; publishedRevision: number | null; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate }
export interface CampaignTemplateSummary { id: string; url: string; revision: number; name: string; description: string; subject: string; published: boolean; publishedRevision: number | null; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate }
export interface AttachmentApi { upload(file: File, inline?: {contentId: string}): Promise<Attachment>; get(id: string, signal?: AbortSignal): Promise<Attachment>; content(id: string, signal?: AbortSignal): Promise<{id: string; filename: string; contentType: string; content: string}>; remove(id: string): Promise<void> }
export type DnsRecordPurpose = 'sending' | 'receiving' | 'mail_from' | 'dmarc' | 'links'
type Dmarc = { status: 'missing' | 'invalid' | 'none' | 'quarantine' | 'reject'; record: string | null; source: string | null; adkim: 'r' | 's'; aspf: 'r' | 's'; alignment: { dkim: boolean; spf: boolean } }
// What a connected AWS account's disconnect keeps in the account and couldn't remove (DELETE /v1/connection).
export interface DisconnectSummary {
  retained: { domain: string; region: string; regionLabel: string; createdByNightmail: boolean; records: { type: 'CNAME' | 'MX' | 'TXT'; name: string; value: string; priority?: number }[] }[]
  leftBehind: { region: string; kind: string; resource: string }[]
  stack: { name: string; consoleUrl: string } | null
}
/** What public DNS showed for a pending record: when Check now ran (verifyDomain), or at the API's last background check; null when DNS didn't answer. */
/** wildcard: a wildcard record (*.domain) answers this missing CNAME's name with an address. */
export interface PublicDns { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string; wildcard?: string; /** A registrar's parking or forwarding record answers it (Porkbun's pixie.porkbun.com). */ parking?: { owner: string; target: string } }
export interface DnsRecord { id: string; type: 'TXT' | 'CNAME' | 'MX'; name: string; value: string; status: 'verified' | 'pending' | 'not_checked'; purpose?: DnsRecordPurpose; note?: string; publicDns?: PublicDns | null }
// Why receiving at `host` needs attention, from the API's DNS checks. Blocking issues can't work until DNS or the choice changes.
export interface ReceivingIssue { code: 'cname' | 'foreign_mx' | 'split' | 'wildcard' | 'bane_record' | 'host_taken' | 'claimed' | 'delegated' | 'mx_missing' | 'wrong_region' | 'null_mx' | 'proof_stale' | 'identity_stale'; host: string; blocking: boolean; message: string; provider?: string | null; target?: string | null; suggestion?: string | null }
/** Hosted: the workspace's built-in domain (connection.builtinDomain in GET /v1/me): who it sends to, its caps, and whether it sends now. */
export interface BuiltinDomain { id: string | null; name: string; sending: 'ready' | 'pending' | 'closed' | 'off'; /** Every built-in domain's sending is paused (the circuit breaker). */ paused?: true; scope: 'anyone' | 'members'; perDay: number; perMinute: number; /** Recipients in the rolling 24 hours, as perDay counts them (older APIs: absent). */ used?: number }
export interface Domain { /** The workspace's built-in domain: no DNS of its own, can't be deleted. */ builtIn?: boolean; /** The built-in domain's limits (GET /v1/domains/{id}). */ limits?: { scope: 'anyone' | 'members'; perDay: number; perMinute: number; unsupported: string[]; summary: string }; /** No nameservers serve the domain (unregistered or mistyped): set when it is added, by Check now and by the background check. */ dnsIssue?: { code: 'no_dns'; message: string } | null; dnsHost?: { name: string; zone: string; url: string | null } | null; receivingIssue?: ReceivingIssue | null; releasesAt?: string | null; dmarc?: Dmarc | null; dnsStatus?: 'available' | 'unavailable'; dnsUnavailableReason?: string | null; id: string; regionId: RegionId; name: string; status: 'verified' | 'pending' | 'issue'; verified?: boolean; dkimStatus?: 'verified' | 'pending' | 'failed'; mailFromDomain?: string | null; mailFromStatus: 'verified' | 'pending' | 'not_configured' | 'failed'; sending?: 'pending' | 'verified'; receiving?: 'pending' | 'verified'; records: DnsRecord[]; createdAt: ISODate }
export type MailboxDomainStatus = 'off' | 'provisioning' | 'waiting_for_mx' | 'active' | 'disabling' | 'disabled' | 'failed'
export interface MailboxDomain {
  id: string; name: string; region: RegionId; status: MailboxDomainStatus; catchAll: 'create_address' | 'store'
  dns: { type: 'MX'; name: string; value: string; priority: number }[]
  mx: { state: 'active' | 'missing' | 'conflict' | 'mixed' | 'wrong_region' | 'null_mx' | 'cname' | 'error'; message: string; providers: string[]; checkedAt: ISODate } | null
  lastError: string | null; enabledAt: ISODate | null; checkedAt: ISODate | null; addressCount: number
  subdomains?: { enabled: boolean; count: number; dns: { type: 'MX'; name: string; value: string; priority: number }[] }
}
// One host a domain receives on (the domain itself or a subdomain), each with its own status, MX record and catch-all.
export interface ReceivingHost { id: string; domainId: string; name: string; status: 'pending' | 'active' | 'mixed' | 'lost' | 'failed' | 'removed'; catchAll: 'create_address' | 'store'; dns: { type: 'MX'; name: string; value: string; priority: number }[]; mx: MailboxDomain['mx']; issue: ReceivingIssue | null; addressCount: number }
export interface Mailbox { id: string; key?: string | null; address: string; displayName: string | null; domain: string; aliases: string[]; rules: string[]; origin: 'api' | 'auto'; createdAt: ISODate; updatedAt: ISODate; stats: { threads: number; unreadThreads: number; lastMessageAt: ISODate | null }; publicAddress?: string | null; expiresAt?: ISODate | null; kind?: 'address' | 'inbox' }
export interface MailAddress { name: string | null; address: string }
export const inboundEventTypes = ['message.received', 'message.junk', 'message.stored', 'message.queued', 'message.sent', 'message.delivered', 'message.delayed', 'message.bounced', 'message.complained', 'message.failed', 'thread.updated', 'address.created', 'address.deleted', 'inbox.created', 'inbox.deleted', 'message.held', 'inbox.quota_exceeded'] as const
export type MailboxEventType = typeof inboundEventTypes[number]
export interface MailboxWebhookDelivery { id: string; webhookId: string; eventId: string; status: 'pending' | 'delivered' | 'failed' | 'paused'; attemptCount: number; lastStatusCode: number | null; lastError: string | null; createdAt: ISODate; updatedAt: ISODate }
// Agent inboxes: expiring addresses for agents and tests (`/v1/inboxes`). The ID also works as an addressId.
export type InboxStatus = 'active' | 'expired' | 'deleting'
export interface Inbox {
  id: string; kind: 'inbox'; type: 'ephemeral' | 'sandbox' | 'persistent'; address: string; domain: string; name: string | null; metadata: Record<string, unknown>; clientId: string | null
  status: InboxStatus; createdAt: ISODate; expiresAt: ISODate; deleteAfter: ISODate; limits: { messages: number; bytes: number }
  send: { enabled: boolean; replyOnly: true }; usage: { messages: number; bytes: number; held: number; unread: number; lastMessageAt: ISODate | null }
}
export interface InboxInput { type: Inbox['type']; domain?: string; name?: string; ttlSeconds: number; send?: { enabled: boolean }; credential?: { name: string; permissions: ('read' | 'modify' | 'send')[] } }
export interface CreatedInbox extends Inbox { credential?: { id: string; secret: string; permissions: string[]; expiresAt: ISODate } }
export interface InboxMessage {
  id: string; threadId: string; cursor: string; from: MailAddress; to: MailAddress[]; toCount?: number; subject: string; snippet: string; receivedAt: ISODate; read: boolean; junk: boolean
  /** When Nightmail stored it, and how long after its receipt reached it (older APIs: absent). */ storedAt?: ISODate; processingMs?: number | null
  held: 'quota' | 'expired' | null; attachmentCount: number; auth: { spf?: string; dkim?: string; dmarc?: string }; simulated: boolean; hiddenContent: boolean
  extract: { codes: string[]; links: { text: string; href: string; mismatch: boolean }[] }
}
export interface InboxMessageDetail extends InboxMessage { text: string; replyText: string; html: string | null; attachments: { id: string; filename: string; contentType: string; size: number; url: string | null; expiresAt: ISODate | null }[] }
/** servedAt: when the page was read, on storedAt's clock (older APIs: absent). */
export interface InboxMessagePage { data: InboxMessage[]; cursor: string; hasMore: boolean; servedAt?: ISODate }
// Inbound is thread-first: a conversation can be visible through several receiving addresses.
export type InboundAddress = Mailbox
export interface InboundAddressInput { address: string; displayName?: string | null; aliases?: string[]; publicAddress?: string; ttlSeconds?: number }
export interface InboundAddressPatch { displayName?: string | null; aliases?: string[] }
export type InboundThreadView = 'inbox' | 'starred' | 'archive' | 'spam' | 'trash' | 'all'
/** from: the newest visible message's sender (absent on older API responses). */
export interface InboundThread { id: string; subject: string; snippet: string; from?: MailAddress; lastMessageAt: ISODate; addressIds: string[]; messageCount: number }
export interface InboundMessage {
  id: string; threadId: string; addressIds: string[]; direction: 'inbound' | 'outbound'; status: string
  from: MailAddress; to: MailAddress[]; toCount?: number; cc: MailAddress[]; ccCount?: number; replyTo: MailAddress[]; replyToCount?: number; subject: string; snippet: string
  text: string; replyText: string; receivedAt: ISODate; bodyTruncated: boolean; attachmentCount: number
  emailId: string | null; messageId: string | null; inReplyTo: string | null; references: string[]; referencesCount?: number
  /** Read state for the requested address scope; absent on older API responses. */
  read?: boolean
}
export interface InboundAttachment { id: string; filename: string; contentType: string; size: number; disposition: string; contentId: string | null }
// htmlTooComplex: the HTML is past the API's parsing budget; show the text instead of rendering it.
export interface InboundMessageDetail extends InboundMessage { html: string | null; htmlTooComplex?: boolean; attachments: InboundAttachment[] }
export interface InboundAddressState { addressId: string; unreadCount: number; archived: boolean; starred: boolean; trashed: boolean; spam: boolean; labels: string[] }
export interface InboundThreadPatch { addressId?: string; read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean; spam?: boolean; addLabels?: string[]; removeLabels?: string[] }
export interface InboundRecipients { to: string[]; cc: string[]; bcc: string[] }
export interface InboundThreadDetail extends InboundThread { messages: InboundMessage[]; nextCursor: string | null; addressStates?: InboundAddressState[] }
export interface InboundReplyInput { text: string; addressId?: string; replyToMessageId?: string; replyAll?: boolean; allowAutomated?: boolean; expectedRecipients?: InboundRecipients; idempotencyKey: string }
export interface InboundThreadInput { addressId: string; to: string[]; subject: string; text: string; idempotencyKey: string }
/** Header values are write-only: reads return names, and a masked hint for managers. */
export interface WebhookHeaderView { name: string; hint?: string; updatedAt?: ISODate }
/** Omitted on update to keep the current headers; any list replaces them all, and [] removes them. */
export interface WebhookHeaderInput { name: string; value: string }
export type InboundWebhookFormat = 'nightmail' | 'inbound'
/** A forward endpoint as listEndpoints returns it: routes name it by id, and only a confirmed (ready) one gets mail. */
export interface ForwardEndpoint { id: string; name: string; status: 'ready' | 'pending' | 'expired' | 'declined' | 'paused'; target: string }
export interface InboundWebhook { id: string; key?: string | null; name?: string | null; url: string; description: string; eventTypes: MailboxEventType[]; addressIds: string[] | null; paused: boolean; headers: WebhookHeaderView[]; format?: InboundWebhookFormat; junk?: 'skip' | 'include'; createdAt: ISODate; updatedAt: ISODate; approval: ApprovalTie | null }
/** eventTypes [] is a route-only webhook: it gets only the mail a route sends to it. */
export interface InboundWebhookInput { url: string; description: string; eventTypes: MailboxEventType[]; addressIds: string[] | null; headers?: WebhookHeaderInput[]; format?: InboundWebhookFormat; junk?: 'skip' | 'include' }
/** A recipient → destinations rule. to: [] keeps mail without an inbox; 'drop' discards it. */
export interface MailRoute { id: string; key: string | null; match: string; to: string[] | 'drop'; enabled: boolean; subaddresses: boolean; note: string; createdAt: ISODate }
export interface MailRouteInput { match: string; to: string[] | 'drop'; enabled?: boolean }
export type RouteTier = 'exact' | 'address' | 'pattern' | 'subaddress' | 'catchall' | 'default'
export interface RoutedRecipient { address: string; tier: RouteTier; route: string | null; inboxes: string[]; webhooks: string[]; dropped: boolean; junk: boolean; domainDefault: 'store' | 'create_address'; warnings: string[] }
export interface RoutingTestResult { version: number; unsaved: boolean; message: { from: string | null; subject: string | null } | null; recipients: RoutedRecipient[] }
export interface RoutingTestInput { to?: string[]; raw?: string; junk?: boolean }
// One row of the unified logs (GET /v1/logs): sent or received mail, newest first. Delivery details of received mail
// (envelopeTo, regionId, the spam status) reach administrators only.
export type LogDirection = 'all' | 'sent' | 'received'
/** Exact counts for each status and stream under the other filters, between the same dates (GET /v1/logs/facets). */
export interface LogCounts { status: Record<string, number>; stream: { transactional: number; marketing: number } }
export type LogVisibility = 'admin' | 'member'
export type LogFacetFilters = Pick<PageRequest, 'regionId' | 'status' | 'stream' | 'search' | 'campaignId' | 'from' | 'to'> & { direction?: LogDirection }
export type LogFacetInput = LogFacetFilters & { mode: 'last' | 'refresh'; range: TimeRange; visibility: LogVisibility }
type LogFacetNumbers = { counts: LogCounts; asOf: ISODate | null; from: ISODate; visibility: LogVisibility }
export type LogFacetRead =
  | { counts: null; asOf: null; from: null; visibility: LogVisibility }
  | LogFacetNumbers
  | { state: 'pending'; last: (LogFacetNumbers & { asOf: ISODate }) | null; retryAfterSeconds: number; attempt?: number }
export interface LogEntry {
  id: string; direction: 'sent' | 'received'; at: ISODate; status: string; from: MailAddress; to: string[]; toCount?: number; subject: string
  stream: Stream | null; campaignId: string | null; simulated: boolean; attachmentCount: number | null; threadId: string | null; threadCount: number | null
  /** A sent email waiting to be sent (status scheduled): when it goes. */
  scheduledAt: ISODate | null
  addresses: { id: string; address: string }[] | null; regionId: RegionId | null; envelopeTo: string[] | null; envelopeToCount?: number | null
}
export interface ReceivedEmail {
  id: string; threadId: string; status: string; from: MailAddress; to: MailAddress[]; toCount?: number; subject: string; snippet: string
  receivedAt: ISODate; attachmentCount: number
  // Delivery details: present for owners and admins only.
  spam?: boolean; region?: RegionId | null; envelopeTo?: string[]; envelopeToCount?: number; addresses?: { id: string; address: string }[]
}
export interface ReceivedEmailDetail extends ReceivedEmail {
  sentAt: ISODate | null; cc: MailAddress[]; ccCount?: number; replyTo: MailAddress[]; replyToCount?: number; messageId: string | null; inReplyTo: string | null; references: string[]; referencesCount?: number
  text: string; replyText: string; html: string | null; htmlTooComplex?: boolean; bodyTruncated: boolean; headers?: { name: string; value: string }[]
  attachments: { id: string; filename: string; contentType: string; size: number; contentId: string | null; disposition: 'attachment' | 'inline'; url: string | null }[]
  verdicts?: { spf?: string; dkim?: string; dmarc?: string; spam?: string; virus?: string }
  sizeBytes?: number | null; rawUrl?: string | null
  thread?: EmailThread | null
}
export interface WebhookDelivery { id: string; at: ISODate; regionId: RegionId; event: WebhookEvent; response: number | null; attempts: number; status: 'delivered' | 'retry_pending' | 'pending' | 'failed' | 'paused'; payload: Record<string, unknown>; /** A Test endpoint delivery, not real traffic. */ test?: boolean }
export interface Webhook { id: string; name: string; url: string; regionIds: RegionId[] | 'all'; events: WebhookEvent[]; status: 'active' | 'paused'; secretHint: string; headers: WebhookHeaderView[]; deliveries: WebhookDelivery[]; nextCursor?: string | null; updatedAt?: string; /** The signing secret: only in the response that created the webhook. */ secret?: string }
// An update without regionIds keeps the endpoint's saved region scope.
export type WebhookInput = Pick<Webhook, 'name' | 'url' | 'events'> & { regionIds?: Webhook['regionIds']; id?: string; headers?: WebhookHeaderInput[] }
// Plain-language copy with a next step for errors a new workspace can meet. The server's message stays in `detail`.
// A dashboard session that meets these is a member: say who can do it instead of the key jargon behind the code.
const ownersOnly = 'Only workspace owners and admins can do this. Ask one to do it, or to make you an admin.'
export const permissionCodes = new Set(['PERMISSION_DENIED', 'ADMIN_REQUIRED', 'OWNER_REQUIRED'])
/** A read past its time limit: the same filters would fail again, so the person narrows them instead of retrying. */
export const tooBroadCode = 'READ_TOO_LARGE'
const friendlyErrors: Record<string, (detail: string) => string> = {
  PERMISSION_DENIED: detail => /permission|owner or admin|administration|principal/i.test(detail) ? ownersOnly : detail,
  ADMIN_REQUIRED: () => ownersOnly,
  OWNER_REQUIRED: () => 'Only a workspace owner can do this.',
  SES_NOT_CONFIGURED: () => 'Sending isn’t available on this server right now. Try again in a few minutes.',
  TENANT_NOT_READY: () => 'Your workspace is still being set up for sending. Try again in a minute.',
  HOSTED_SENDING_PAUSED: detail => `Sending is paused while ${productName} reviews this workspace${detail ? ` (${detail.replace(/\.$/, '')})` : ''}.`,
  SENDER_DOMAIN_NOT_VERIFIED: () => 'This sender’s domain isn’t verified. Check its DNS records in Domains, then send once it shows Verified.',
  SEND_LIMIT_REACHED: detail => detail,
  BALANCE_EXHAUSTED: () => 'Sending is paused: your balance is empty. Add credit in Settings → Billing.',
  PAYMENT_METHOD_REQUIRED: () => 'Save a card first: auto-recharge charges it.',
  FIRST_TOP_UP_LIMIT: detail => detail,
  TOP_UP_RATE_LIMITED: () => 'Too many payment attempts. Wait a few minutes, then try again.',
  BILLING_NOT_CONFIGURED: () => 'Payments aren’t set up on this installation yet.',
  NETWORK_UNAVAILABLE: detail => detail,
  AUDIENCEQL_LIMIT_EXCEEDED: () => 'A bulk change can update at most 10,000 contacts. Filter to a smaller list and try again.',
  AUDIENCE_PLAN_EXPIRED: () => 'This count is more than 15 minutes old. Count again, then confirm.',
  STALE_AUDIENCE_PLAN: () => 'Some of these contacts changed after they were counted. Count again, then confirm.',
  [tooBroadCode]: () => 'Too much mail to load at once. Narrow the dates or filters.',
}
/**
 * A failed API call. `message` is what to show a person: plain language with a next step, so any `error.message`
 * renders correctly. The server's own wording is `detail`; the code and request ID are `reference`, for support and
 * logs (Contact support also sends the last few failed request IDs).
 */
export class ApiError extends Error {
  /** The server's own message. */
  readonly detail: string
  /** The code and request ID, for support and logs. */
  readonly reference: string
  /** Every problem, when the API reports several (rule diagnostics). */
  details?: Record<string, unknown>[]
  /** Retry-After seconds from a 429 or 503 response. */
  retryAfter?: number
  /** Whether the server marked this failure as retryable. */
  retryable?: boolean
  constructor(detail: string, public code: string = 'validation', public fields: Record<string, string> = {}, public requestId?: string, public status?: number) {
    super(friendlyErrors[code]?.(detail) ?? detail)
    this.name = 'ApiError'
    this.detail = detail
    this.reference = `${code}${requestId ? ` · Request ${requestId}` : ''}`
  }
}
/** The generic retry line for an error without its own text. */
export const tryAgain = 'Something went wrong. Try again.'
/** What to show for an error as plain text (a toast, a status line): its message, or `fallback` for a non-Error. */
export const errorText = (error: unknown, fallback = tryAgain) => error instanceof Error ? error.message : typeof error === 'string' && error ? error : fallback

// The UI depends on this boundary, never on fixture data or a transport implementation.
// Dates cross the boundary as ISO-8601 strings; rates are ratios, not formatted percentages.
export type CursorItems<T> = T[] & { nextCursor?: string | null }
export interface Api {
  consentHistory: (id: string, cursor?: string) => Promise<{items: ConsentEvent[]; nextCursor: string | null}>
  emailEvents: (id: string, cursor?: string) => Promise<{items: EmailEvent[]; nextCursor: string | null}>
  attachments: AttachmentApi
  templateAssets: AttachmentApi
  imports: { preview(input: {csv: string; mapping: Record<string, string>; listId?: string}, signal?: AbortSignal): Promise<ImportPreview>; commit(id: string, input?: ImportCommitInput, signal?: AbortSignal): Promise<ImportPreview> }
  consent: (id: string, input: ConsentInput) => Promise<Contact>
  /** AudienceQL bulk changes: plan counts and samples the contacts a statement changes; apply changes exactly those. */
  audienceQuery: { plan(statement: string): Promise<AudiencePlan>; apply(input: { planId: string; confirmResubscribe?: boolean; evidence?: string }): Promise<{ affected: number }> }
  webhookDeliveries: (id: string, cursor?: string) => Promise<{items: WebhookDelivery[]; nextCursor: string | null}>
  regions: { list(signal?: AbortSignal): Promise<RegionCatalog>; configure(region: string, input: RegionConfigureInput, signal?: AbortSignal): Promise<RegionCatalog>; discover(region: string, options?: { refresh?: boolean }, signal?: AbortSignal): Promise<SesDiscovery>; provision(region: string, signal?: AbortSignal): Promise<RegionProvisionReceipt>; updateAutoValidation(region: string, stream: Stream, mode: Exclude<AutoValidationMode, 'inherit' | 'unknown'>, signal?: AbortSignal): Promise<{stream: Stream; mode: AutoValidationMode}> }
  workspace: { get(signal?: AbortSignal): Promise<Workspace>; update(input: { name?: string; postalAddress?: string | null }, signal?: AbortSignal): Promise<Workspace>; settings(signal?: AbortSignal): Promise<WorkspaceSettings>; updateSettings(input: { postalAddress?: string | null; focus?: WorkspaceFocus[] | null }, signal?: AbortSignal): Promise<WorkspaceSettings> }
  overview: { get(input: { regionId: string; range: TimeRange; stream?: Stream }, signal?: AbortSignal): Promise<Overview>; setup(signal?: AbortSignal): Promise<OverviewSetup> }
  senderScore: { get(signal?: AbortSignal): Promise<SenderScore>; release(input: StandingReleaseInput, signal?: AbortSignal): Promise<SenderScore> }
  emails: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Email>>; get(id: string, signal?: AbortSignal): Promise<Email>; cancel(id: string, signal?: AbortSignal): Promise<Email>; reschedule(id: string, scheduledAt: ISODate, signal?: AbortSignal): Promise<Email>; check(input: EmailCheckInput, signal?: AbortSignal): Promise<SendabilityReport>; preview(input: EmailPreviewRequest, signal?: AbortSignal): Promise<ClientPreview[]> }
  logs: { list(input: PageRequest & { direction?: LogDirection }, signal?: AbortSignal): Promise<PageResult<LogEntry>>; facets(input: LogFacetInput, signal?: AbortSignal): Promise<LogFacetRead> }
  newsletters: { list(signal?: AbortSignal, cursor?: string): Promise<CursorItems<Newsletter>>; get(id: string, signal?: AbortSignal): Promise<Newsletter>; create(input: { name: string; from: string; fromName?: string }, signal?: AbortSignal): Promise<Newsletter> }
  campaigns: { list(input: PageRequest & { archived?: boolean; /** Only campaigns to this list: a newsletter's issues. */ listId?: string; /** false: only campaigns that are no newsletter's issue. */ newsletter?: boolean }, signal?: AbortSignal): Promise<PageResult<Campaign>>; get(id: string, signal?: AbortSignal): Promise<Campaign>; state(id: string, signal?: AbortSignal): Promise<CampaignState>; preview(id: string, signal?: AbortSignal): Promise<CampaignPreview>; setArchived(input: { id: string; archived: boolean }, signal?: AbortSignal): Promise<Campaign>; save(input: CampaignInput, signal?: AbortSignal): Promise<Campaign>; audience(input: { id: string; listId: string; segmentId: string | null }, signal?: AbortSignal): Promise<AudiencePreview>; reviewDisplay(id: string, revision: number, check: boolean, signal?: AbortSignal): Promise<CampaignReviewDisplay>; send(input: SendCampaignInput, signal?: AbortSignal): Promise<Campaign | CampaignSendReceipt>; pause(id: string, signal?: AbortSignal): Promise<Campaign>; resume(id: string, signal?: AbortSignal): Promise<Campaign>; setPacing(id: string, input: CampaignPacingInput, signal?: AbortSignal): Promise<Campaign>; unschedule(id: string, signal?: AbortSignal): Promise<Campaign>; reschedule(id: string, scheduledAt: ISODate, signal?: AbortSignal): Promise<Campaign>; cancel(id: string, signal?: AbortSignal): Promise<{ canceled: number; inFlight: number }>; stats(id: string, signal?: AbortSignal): Promise<CampaignStats>; test(input: { id: string; to: string; data?: Record<string, string> }, signal?: AbortSignal): Promise<{ accepted: boolean; id?: string; status?: string; simulated?: boolean }> }
  templates: { list(input?: PageRequest & { archived?: boolean; publishedOnly?: boolean }, signal?: AbortSignal): Promise<PageResult<CampaignTemplateSummary>>; get(id: string, signal?: AbortSignal): Promise<CampaignTemplate>; create(input: {name: string; description?: string}, signal?: AbortSignal): Promise<CampaignTemplate>; update(id: string, revision: number, draft: CampaignTemplateDraft, signal?: AbortSignal): Promise<CampaignTemplate>; publish(id: string, revision: number, signal?: AbortSignal): Promise<CampaignTemplate>; archive(id: string, archived: boolean, signal?: AbortSignal): Promise<CampaignTemplate>; remove(id: string, signal?: AbortSignal): Promise<void>; preview(id: string, published?: boolean, signal?: AbortSignal): Promise<CampaignPreview> }
  contacts: { list(input: PageRequest & { email?: string }, signal?: AbortSignal): Promise<PageResult<Contact>>; get(id: string, signal?: AbortSignal): Promise<Contact>; save(input: ContactInput, signal?: AbortSignal): Promise<Contact>; /** true: campaigns reach a risky contact anyway; false: they skip it again. */ allowRisk(id: string, allowed: boolean, signal?: AbortSignal): Promise<Contact> }
  lists: { list(input?: PageRequest & { counts?: boolean }, signal?: AbortSignal): Promise<PageResult<AudienceList>>; get(id: string, signal?: AbortSignal): Promise<AudienceList>; create(input: { name: string }, signal?: AbortSignal): Promise<AudienceList>; remove(id: string, signal?: AbortSignal): Promise<void> }
  segments: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<Segment>>; get(id: string, signal?: AbortSignal): Promise<Segment>; save(input: SegmentInput, signal?: AbortSignal): Promise<Segment>; preview(input: { id: string; listId?: string }, signal?: AbortSignal): Promise<AudiencePreview> }
  /** Every API key, workspace-wide or limited to addresses or an inbox, in one cursor list (100 a page). */
  keys: { list(signal?: AbortSignal, cursor?: string, includeRevoked?: boolean): Promise<CursorItems<ApiKey>>; create(input: ApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey>; update(id: string, change: ApiKeyUpdate, signal?: AbortSignal): Promise<ApiKey>; changes(id: string, signal?: AbortSignal): Promise<AuditEntry[]>; revoke(id: string, signal?: AbortSignal): Promise<void> }
  /** Agent tokens (connected agents and the tokens they made) and app passwords. */
  credentials: {
    agents(includeInactive?: boolean, signal?: AbortSignal): Promise<Agent[]>
    /** Your own agent: its sign-in and every token it made. Another member's: the tokens it made in this workspace. */
    revokeAgent(id: string, signal?: AbortSignal): Promise<{ scope: 'agent' | 'tokens' }>
    revokeAgentToken(id: string, signal?: AbortSignal): Promise<void>
    bindMcpConnection(id: string, input: { workspaceId: string }, signal?: AbortSignal): Promise<void>
    appPasswords(signal?: AbortSignal): Promise<AppPassword[]>
    createAppPassword(input: AppPasswordInput, signal?: AbortSignal): Promise<CreatedAppPassword>
    revokeAppPassword(inboxId: string, id: string, signal?: AbortSignal): Promise<void>
  }
  domains: { list(input: PageRequest & { refresh?: boolean }, signal?: AbortSignal): Promise<PageResult<Domain> & { quota?: DomainQuota }>; get(id: string, signal?: AbortSignal): Promise<Domain>; create(input: { regionId: string; name: string }, signal?: AbortSignal): Promise<Domain>; configureMailFrom(id: string, mailFromDomain: string, signal?: AbortSignal): Promise<Domain>; removeMailFrom(id: string, signal?: AbortSignal): Promise<Domain>; verify(id: string, signal?: AbortSignal): Promise<Domain>; chooseReceivingHost(id: string, input: { host: string | null; confirm?: boolean }, signal?: AbortSignal): Promise<Domain>; remove(id: string, signal?: AbortSignal): Promise<void> }
  mailboxes: { domains(signal?: AbortSignal): Promise<MailboxDomain[]>; domain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; enableDomain(id: string, input: { force?: boolean }, signal?: AbortSignal): Promise<MailboxDomain>; disableDomain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; checkDomain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; receivedEmail(id: string, signal?: AbortSignal, delivery?: boolean): Promise<ReceivedEmailDetail> }
  inboxes: {
    folders(id:string,signal?:AbortSignal):Promise<{data:{id:string;role:string|null;path:string;subscribed:boolean;total:number;unseen:number}[]}>
    list(input: { search?: string; cursor?: string; type?: Inbox['type']; status?: InboxStatus }, signal?: AbortSignal): Promise<CursorItems<Inbox>>
    get(id: string, signal?: AbortSignal): Promise<Inbox>
    create(input: InboxInput, signal?: AbortSignal): Promise<CreatedInbox>
    remove(id: string, signal?: AbortSignal): Promise<void>
    messages(id: string, input: { after?: string;folder?:string }, signal?: AbortSignal): Promise<InboxMessagePage>
    message(id: string, messageId: string, signal?: AbortSignal): Promise<InboxMessageDetail>
  }
  inbound: {
    addresses(input: { search?: string; cursor?: string; kind?: 'address' | 'inbox' }, signal?: AbortSignal): Promise<CursorItems<InboundAddress>>
    address(id: string, signal?: AbortSignal): Promise<InboundAddress>
    createAddress(input: InboundAddressInput, signal?: AbortSignal): Promise<InboundAddress>
    updateAddress(id: string, patch: InboundAddressPatch, signal?: AbortSignal): Promise<InboundAddress>
    deleteAddress(id: string, signal?: AbortSignal): Promise<void>
    threads(input: { addressId?: string; q?: string; view: InboundThreadView; cursor?: string }, signal?: AbortSignal): Promise<CursorItems<InboundThread>>
    thread(id: string, input: { addressId?: string; cursor?: string }, signal?: AbortSignal): Promise<InboundThreadDetail>
    updateThread(threadId: string, patch: InboundThreadPatch, signal?: AbortSignal): Promise<InboundAddressState>
    message(id: string, input: { addressId?: string }, signal?: AbortSignal): Promise<InboundMessageDetail>
    attachmentUrl(messageId: string, attachmentId: string, input: { addressId?: string }, signal?: AbortSignal): Promise<{ url: string; expiresAt: ISODate }>
    reply(threadId: string, input: InboundReplyInput, signal?: AbortSignal): Promise<InboundMessage>
    startThread(input: InboundThreadInput, signal?: AbortSignal): Promise<InboundMessage>
    webhooks(signal?: AbortSignal, cursor?: string): Promise<CursorItems<InboundWebhook>>
    /** Every forward endpoint (a workspace has at most 500): what a route can forward its mail to once confirmed. */
    forwards(signal?: AbortSignal): Promise<ForwardEndpoint[]>
    /** One page of inbound webhooks; addressId keeps those that get that address's received mail. */
    webhook(id: string, signal?: AbortSignal): Promise<InboundWebhook>
    updateWebhook(id: string, patch: Partial<InboundWebhookInput> & { paused?: boolean }, signal?: AbortSignal): Promise<InboundWebhook>
    deleteWebhook(id: string, signal?: AbortSignal): Promise<void>
    rotateWebhookSecret(id: string, signal?: AbortSignal): Promise<{ secret: string }>
    webhookDeliveries(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorItems<MailboxWebhookDelivery>>
  }
  routing: {
    routes(signal?: AbortSignal): Promise<{ version: number; routes: MailRoute[] }>
    createRoute(input: MailRouteInput, signal?: AbortSignal): Promise<MailRoute>
    updateRoute(id: string, patch: Partial<MailRouteInput>, signal?: AbortSignal): Promise<MailRoute>
    deleteRoute(id: string, signal?: AbortSignal): Promise<void>
    test(input: RoutingTestInput, signal?: AbortSignal): Promise<RoutingTestResult>
  }
  webhooks: { list(signal?: AbortSignal, cursor?: string): Promise<CursorItems<Webhook>>; get(id: string, signal?: AbortSignal): Promise<Webhook>; create(input: WebhookInput, signal?: AbortSignal): Promise<Webhook>; /** Only the changed fields (features/settings/webhook-patch.ts). */ update(id: string, edits: Partial<WebhookFields>, headers?: WebhookHeaderInput[], signal?: AbortSignal): Promise<Webhook>; setStatus(id: string, status: 'active' | 'paused', signal?: AbortSignal): Promise<Webhook>; test(id: string, signal?: AbortSignal): Promise<WebhookDelivery>; retry(id: string, deliveryId: string, signal?: AbortSignal): Promise<WebhookDelivery>; rotate(id: string, signal?: AbortSignal): Promise<{ secret: string }>; reveal(id: string, signal?: AbortSignal): Promise<{ secret: string }>; remove(id: string, signal?: AbortSignal): Promise<void> }
}

export interface SendingLimit { cap: number | null; used: number; resetAt: string | null; nextCap: number | null; nextCapAt: string | null }
/** What the workspace is here for, the first leading (api/src/workspace-focus.ts). */
export type { WorkspaceFocus }
/** Each focus's first steps and whether an agent is connected, yes or no (GET /v1/overview/setup). */
export interface SetupProgress { inbox: boolean; received: boolean; contacts: boolean; campaign: boolean; campaignSent: boolean; newsletter: boolean; readers: boolean; issueSent: boolean; /** An agent is connected (older APIs: absent). */ agent?: boolean }
export interface Identity { /** GET /v1/me: this workspace's focus; null until chosen, empty when skipped. */ focus?: WorkspaceFocus[] | null; /** GET /v1/me: starting while a workspace made seconds ago still has its Hosted mail written; read /v1/me again. */ hostedSetup?: 'starting' | null; /** The workspace's newsletters, oldest first, at most 4: the sidebar names up to three. */ newsletters?: { id: string; name: string }[] | null; id: string; workspaceId: string; /** The OAuth scopes this installation's MCP server asks for (read, send, manage). */ mcpScopes?: string[]; role?: WorkspaceRole | null; multiTenant?: boolean; workspaces?: WorkspaceMembership[] | null; connection?: (Pick<ProviderConnection, 'kind' | 'region' | 'state' | 'tenant'> & { attention?: string | null; sendingLimit?: SendingLimit | null; domains?: { total: number; verified: number }; sent?: boolean; received?: boolean; standing?: { step: StandingStep; marketingHeld: boolean } | null; builtinDomain?: BuiltinDomain | null }) | null; /** Nightmail staff only: the platform operator role, which opens /operator. Null in a session that didn't sign in with Google. */ operator?: 'operator' | 'operator:read' | null; /** Nightmail staff only: an operator role this session can't use until it signs in with Google. */ staffSignIn?: boolean; /** Staff UI notes, for the people the API allows (UI_NOTES_SUBJECTS); false for everyone else. */ uiNotes?: boolean; /** Whether this session can create another workspace: hosted, only staff for now. */ canCreateWorkspace?: boolean; /** Whether this installation records dashboard use (lib/analytics.ts). */ analytics?: boolean; /** Hosted: an operator lets this workspace connect its own AWS account. Otherwise onboarding sets up Hosted mail without asking. */ byo?: boolean; /** Whether this installation shows who else has a campaign open (the Cloudflare deployment's campaign rooms). */ presence?: boolean; /** Hosted dashboard sessions: an empty balance pausing sending or holding received mail, and auto-recharge. */ billing?: { enforcement: 'off' | 'shadow' | 'enforce'; /** Anomaly made the workspace free: never charged or paused for the balance. */ free?: boolean; sending: 'ok' | 'low' | 'paused'; receiving: 'ok' | 'grace' | 'held'; autoRecharge: 'off' | 'on' | 'pending' | 'failed' | 'capped' } | null; /** The hosts mail apps connect to; null when this installation has no IMAP/SMTP gateway. */ mailServers?: { imap: string; smtp: string } | null; name: string | null; email: string | null; permissions: string[]; domains: string[]; origin: string; host: string }

export type WorkspaceRole = 'owner' | 'admin' | 'member'
export interface WorkspaceMembership { id: string; name: string; slug: string; role: WorkspaceRole }
// GET /v1/overview/setup: Overview's setup and next steps in one read. A part is null where its own list would refuse the caller.
export interface OverviewSetup { domains: Domain[] | null; apiKeys: { active: number } | null; emails: { any: boolean }; webhooks: { total: number } | null; invitations: { pending: number } | null; progress?: SetupProgress | null }
export interface WorkspaceMember { id: string; userId: string; email: string; name: string; role: WorkspaceRole }
export type ConnectionKind = 'shared' | 'byo'
export type ConnectionState = 'awaiting_role' | 'provisioning' | 'ready' | 'failed' | 'scanning' | 'ready_to_import' | 'disconnecting'
export type TenantState = 'pending' | 'ready' | 'failed'
export interface ProviderConnection { id: string; kind: ConnectionKind; region: string; state: ConnectionState; tenant: TenantState; awsAccountId: string | null; roleArn: string | null; templateVersion: string | null; quickCreateUrl: string | null; importedDomains?: number
  /** A connected AWS account's stack (regional bring-your-own AWS): its template version, deletion, and why it was last refused. */
  stack?: { version: string | null; latest?: string; updateAvailable?: boolean; features?: string[]; deleted: boolean; error: string | null } | null
  /** The connected account's last health check. */
  health?: { checkedAt: string; issues: { code: string; region?: string; message: string }[] } | null
  /** While a connected AWS account disconnects: what's left to remove, and what stays in the account. */
  cleanup?: { operationId: string; lastError: { region: string | null; code: string } | null; remaining: { region: string; resources: { kind: string; resource: string }[] }[]; summary: DisconnectSummary | null }
  /** The connected account's read-only inventory, region by region. */
  scan?: { revision: number; cursor: { checked: number; total: number }; state: 'awaiting_role' | 'failed' | 'scanning' | 'partial' | 'ready_to_import'; error: string | null; alreadySendsEmail: boolean | null; regions: ByoRegion[] }
  /** Verified domains found in the account, to import as they are. */
  candidates?: ByoCandidate[] }
export interface ByoRegion { region: string; regionLabel: string; scanState: string; scanError: string | null; sendingState: string; receivingState: string; error: string | null
  facts: { production?: boolean; review?: { status: string; caseId: string | null } | null; enforcement?: string; sendingEnabled?: boolean; max24HourSend?: number; maxSendRate?: number }
  pending: { domain: string; importing: boolean; error: string | null }[]; failedIntents: { domain: string; importing: boolean; error: string }[] }
export interface ByoCandidate { id: string; domain: string; region: string; regionLabel: string; selectable: boolean; status: 'verified' | 'signing_pending' | 'not_verified' | 'incomplete' | 'already_bound' | 'overlap'; sandbox: boolean | null }
export interface WorkspaceInvitation { id: string; workspaceId: string; email: string; role: WorkspaceRole; expiresAt: string; acceptUrl: string }
/** A new invitation: emailed says whether the invitee was sent the link, and notEmailedReason why not. */
export interface CreatedWorkspaceInvitation extends WorkspaceInvitation { emailed?: boolean; notEmailedReason?: 'not_available' | 'new_workspace' | 'allowance_used' | null }
export interface WorkspaceInvitationPreview { id: string; workspaceId: string; workspaceName: string; workspaceSlug: string; inviterEmail: string; role: WorkspaceRole; expiresAt: string; status: 'pending' | 'accepted' }
export interface Attachment { disposition?: 'attachment' | 'inline'; contentId?: string | null; id: string; filename: string; contentType: string; size: number }
export interface ConsentInput { status: "subscribed" | "unsubscribed"; source?: string; evidence?: string; policyVersion?: string; occurredAt?: string; confirmResubscribe?: boolean }
export interface ConsentEvent { id: string; status: "subscribed" | "unsubscribed"; source: string; evidence: string | null; policyVersion: string | null; occurredAt: string }
/** risky: at preview, what the addresses say; once committed, the imported contacts campaigns skip (null before list hygiene). */
export interface ImportPreview { id: string; status: "preview" | "committed"; imported: number; rows: {row: number; email: string; name?: string; risk?: RiskReason}[]; errors: {row: number; field: string; message: string}[]; risky: RiskBreakdown | null; /** Set by commit: contacts it marked subscribed. */ subscribed?: number }
/** Commit an import; `consent` records that everyone imported without a consent decision agreed to marketing email. */
export interface ImportCommitInput { consent?: { status: 'subscribed'; evidence: string; policyVersion?: string } }
export interface AudiencePlan { id: string; operation: 'update_contacts' | 'add_to_list' | 'remove_from_list'; matched: number; sample: { id: string; email: string; name: string | null; consent: 'unknown' | 'subscribed' | 'unsubscribed'; suppressed: boolean }[]; warnings: string[]; requiresResubscribeConfirmation: boolean; expiresAt: string }

export interface CampaignSendReceipt { id: string; state: "preparing"; queued: number; scheduledAt: string | null; simulated: boolean; /** Recipients the send skips as risky; null when a large audience wasn't counted at launch. */ risky?: RiskBreakdown | null }
