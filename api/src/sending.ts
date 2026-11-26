import { queueListRisk } from './list-risk-lines.js';
import { cachedDashboardRead, mailRevision } from './dashboard-cache.js';
import { talliesEnabled } from './sending-tallies.js';
import { boundRequestBody } from './request-body.js';
import { checkBudget } from './auth.js';
import { recordAudit, type AuditContext } from './audit.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNull, isNotNull, lt, lte, or, sql, SQL } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import type { DefaultTreeAdapterMap } from 'parse5';
import { apiKeys } from './db/core.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { lists, mergeSuppression, segments } from './db/audience.js';
import { literalSearch, SuppressionReason, EmailEventData, readCursor, encodeCursor, nextCursor, budgetedRead, readLimit, readLimitNote } from './core.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Attachment } from '@aws-sdk/client-sesv2';
import { actor, actorMailAccess, ApiError, apiFailureBody, describeApiFailure, AudienceSpec, denied, unrestrictedRequired, uploadKey, chargeRenderBudget, digest, errors, getSes, isSimulatedSes, id, rowId, IdParams, json, lazyModule, log, logError, ModuleLoadError, notFound, PageQuery, page, redactCapabilityData, redactCapabilityText, region, response, security, senderDomainAllowed, simulatedTopic, taggedEmailId, timed, withoutVerdict, wrapModuleLoad, type Actor, type App, type Ctx, type DbExecutor, type JobHandler, type Runtime, type Storage, type AttachmentTypes } from './core.js';
import { enqueue, JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures, wakeWebhooks } from './jobs.js';
import { countScreened, failScheduledRelease, CAMPAIGN_ACTIVE, CAMPAIGN_RUNNING, CAMPAIGN_STATES, campaignEditable, campaignReserved, campaignResumable, cancelCampaign, failCampaign, finishCampaigns, holdCampaign, launchCampaign, noteHealthChecked, pauseCampaign, quarantineCampaign, clearProbe, skipProbe, waitProbe, queueCampaignRun, recordExpanded, recordPrepared, rescheduleCampaign, restartRampWindow, restrictToDelivered, resumeCampaign, retireCampaignRun, reviseCampaign, runningState, setCampaignPacing, setRamp, startSending, unscheduleCampaign, terminalColumns, terminalEvents, wakeCampaignRun, type CampaignState } from './states.js';
import { productName } from './brand.js';
import { ADMISSION_MS, roomName } from './campaign-room-protocol.js';
import type { CampaignScreen, ScreenResult } from './screen.js';
export { simulatedTopic, taggedEmailId, terminalColumns, terminalEvents };
import { regionalSending, sendingConnections, type SendingBinding } from './domain-claims.js';
import { lockSendScope, type SendScope } from './send-scope.js';
import { uploadReservation } from './upload-reservation.js';
import { assertRegionEnabled, regionPattern } from './ses-region-state.js';
import { forDelivery, type ReadyConnection } from './provider-credentials.js';
import { bulkFlags, CAMPAIGN_TESTS, hostedCost, probationReason, realDestination, type ProbationReason } from './hosted-sending.js';
import { mailboxAddresses, mailboxKeys } from './db/mailbox.js';
import { CustomHeaders } from './custom-headers.js';
import { EmailThread, joinReplies, mailboxMail, sentThreadId, threadBlock, threadView, type RawThread } from './thread-view.js';
import { assertTopics, topicAllows, topicRule, type TopicRule } from './topics.js';
import { attachmentLinks, attachments, campaignReviews, campaigns, emailEvents, emails, type CampaignStatsGroup, type StoredCampaignStats, type CampaignDraft, type EmailSnapshot, type EmailStatus, type ReviewedRecipient } from './db/sending.js';
import { decodedDisplayName, AttachmentMetadata, AttachmentUpload, decodeBase64, fileTooLarge, invalidMetadataFields, mailAddress, MAX_ATTACHMENT_BYTES, MAX_JSON_ATTACHMENT_BYTES, metadataInvalid, mib, quoted, sizeText, postalAddressOf, postalAddressRequired, senderDisplayName, unsubscribePageLink, unsubscribePageUrl, validateAttachment, validMailAddressSql, type AttachmentMetadataInput } from './outbound-content.js';
import { foundLinkOrigin, linkAllowance, linkChoice, linkChoices, linkOrigin, linkReview, recordLinkUse } from './link-domains.js';
import { clients, type Client } from './email-preview/support.js';
import { CheckInput, CheckResult, splitMailbox, type CheckMail } from './sendability-schema.js';
import { withRedactedReply } from './deliverability.js';
import { headerPrefix, requestHeader } from './brand.js';
import { canonical, idempotencyGate, idempotencyKey, idempotent, IdempotencyHeaders, idempotentRequest, SendIdempotencyHeaders, replay, requestHash, validIdempotencyKey, type ClaimState, type IdempotentRequest } from './idempotency.js';
import { PREVIEW_ROUTE_NOTE, previewResponses, refuseHead, registerPreviewImages, renderPreview } from './preview-images.js';
import { actorJson, admission, admitted, charges, duplicateAttachment, QUARANTINE_CODES, RAMP_POLICY, refusal, scheduledCharges, shadowBilling, type AdmissionMail, type Admitted, type Refused, type Released } from './admission.js';
import { contentBytes, estimatedMimeBytes, SEND_LIMITS } from './send-limits.js';
import { SETUP_EMAIL, SETUP_SENDER } from './setup-email.js';
import { assertResponseWithinLimit, reserveMemory, responseByteLimit, withMemory } from './isolate-memory.js';
import { buildBoundedPageJson, PAGE_MAX_BYTES, streamBase64JsonResponse, utf8Bytes, withBoundedRead } from './read-bounds.js';
import { RATES } from './billing/money.js';
import { RecipientWarning, recipientWarnings, RiskBreakdown } from './list-hygiene.js';
import { assertBuiltinInput, assertBuiltinRecipients, assertBuiltinStillSends, awaitBuiltinSetup, BUILTIN_NOTE, isBuiltinHost } from './builtin-domain.js';
import { ATTACHMENT_LIMITS_TEXT, ATTACHMENT_REFUSALS_TEXT, ATTACHMENT_RULES_TEXT, UPLOAD_HEADERS } from './attachment-limits.js';
import { estimateFinish, judgeReadiness, LEGACY_READINESS_REASONS, LEGACY_REASON, RAMP, RAMP_HOUR_MS, rampLines, rampStart, READINESS_REASONS, type RampAt, type ReadinessReason } from './standing-model.js';

type HtmlParser = typeof import('parse5').parse;
const loadParse5 = lazyModule((): Promise<HtmlParser> => import('parse5').then(m => m.parse));
const loadBoundedHtml = lazyModule(() => import('./bounded-html.js'));
const loadCampaignBlocks = lazyModule(() => import('./campaign-blocks.js'));
const loadEmailPreview = lazyModule(() => import('./email-preview/index.js'));
const loadOpsUnsub = lazyModule(() => import('./operations.js'));
const loadScreen = lazyModule(() => import('./screen.js'));
const loadSendingSesv2 = lazyModule(() => import('@aws-sdk/client-sesv2'));

const MAX_BODY = 512 * 1024;
// Upload storage and batch expansion; the limits a send is admitted against are in send-limits.ts. Stored uploads are
// kept as long as their emails (30 days) and unused ones 30 days, so the stored quota is a rolling volume: it is set far
// above any month of real attachments (100 GiB is about 100,000 emails with a 1 MB file) and only stops runaway uploads.
const SENDING_LIMITS = { expandedCampaignBytes: 128 * 1024 * 1024 } as const;
const limitsTable = (runtime: Pick<Runtime, 'config'>) => sql.identifier(runtime.config.multiTenant ? 'regional_workspace_limits' : 'sending_region_limits');
// Preparation is bounded by bytes (4 MiB) and time (10 s) per job; a large row limit keeps small
// campaigns to one scheduler hop instead of one per thousand recipients.
const CAMPAIGN_PREPARE_ROWS = 20000;
const CAMPAIGN_EXPAND_ROWS = 2000;
const CAMPAIGN_CHUNK_BYTES = 4 * 1024 * 1024;
// Estimated final content validated per preparation job. Snapshots are transient here (only their
// digests are kept), so the ten-second bound is the real guard; this keeps a 10k static campaign to one hop.
const CAMPAIGN_PREPARE_BYTES = 64 * 1024 * 1024;
// Materialized-but-unsent rows per campaign / per workspace: about ten seconds of the regional
// send rate, so expansion (a scheduler job with its own latency) never starves the dispatcher.
const CAMPAIGN_BUFFER = 400;
const DAY_MS = 24 * 3600_000;
// Automatic pause: AWS reviews accounts at 5% bounces and 0.1% complaints, so pause well before either,
// once enough mail has been accepted for the rate to be meaningful.
const AUTO_PAUSE = { bounceRate: 0.02, bounceMinimum: 1000, complaintRate: 0.0008, complaintMinimum: 5000, hostedComplaintMinimum: 2000, intervalMs: 30 * 60_000 };
// Hosted list probe: the first min(500, 10%) recipients, at least 100, go out first. Release waits until they have left
// the queue and ten more minutes for their feedback; more than 3% bounces or two complaints quarantine the campaign.
export const PROBE = { share: 0.1, min: 100, max: 500, waitMs: 10 * 60_000, bounceRate: 0.03, complaints: 2 };
export const probeSize = (total: number) => Math.min(total, Math.max(PROBE.min, Math.min(PROBE.max, Math.ceil(total * PROBE.share))));
// The campaign ramp's check of each step's batch (src/standing-model.ts RAMP.check), in milliseconds.
const RAMP_CHECK = { ...RAMP.check, maxWaitMs: RAMP.check.maxWaitMinutes * 60_000, retryMs: RAMP.check.retryMinutes * 60_000 } as const;
// Campaigns stop releasing recipients while SES's remaining 24-hour quota is within this reserve, which
// stays available for transactional mail. The quota itself is read from SES, never configured.
export const sesDailyReserve = (max24: number, percent: number) => Math.ceil(max24 * percent / 100);
// The customer share: what outside (Hosted, not exempt) workspaces may still send in the rolling 24 hours, all of them
// together, out of a percent of the shared account's daily limit (migration 401). Their marketing waits for it, at
// dispatch and at campaign release; transactional mail, exempt workspaces and BYO accounts never do.
export const customerCredits = (max24: number, customerSent: number, percent: number) => Math.max(0, Math.floor(max24 * percent / 100) - customerSent);
export const QUOTA_REFRESH_MS = 60_000;
// A rate-shared campaign aims to release about every five to ten seconds. Each release covers the time actually
// elapsed since the previous one, because a real cycle (queue wake, claim, job) takes 13-20 s in production;
// it never banks more than 20 seconds while waiting, so a pause, hold or stall cannot be caught up at full rate.
const RELEASE_INTERVAL_MS = 5000, RELEASE_BURST_MS = 20000;
const campaignBuffer = (rate: number) => Math.min(20000, Math.max(CAMPAIGN_BUFFER, Math.ceil(rate * 10)));
const workspaceBuffer = (rate: number) => Math.min(50000, Math.max(1000, Math.ceil(rate * 20)));
// Recheck a full buffer or in-flight campaign once its backlog should have drained at the cached
// regional rate; rechecking sooner only repeats the same work. Unknown rates use a fixed interval.
const drainDelayMs = (backlog: number, rate: number, floor = 1000) => rate > 0 ? Math.max(floor, Math.min(15000, Math.ceil(1000 * backlog / rate))) : 5000;
const Address = mailAddress();
const Subject = z.string().min(1).max(998).refine(v => !/[\r\n]/.test(v), 'Subject cannot contain line breaks.');
const FromName = senderDisplayName();
const PreviewText = z.string().max(200).describe('Optional preheader text. Inserted as escaped hidden text into each outgoing HTML snapshot; draft HTML is unchanged. When set, supply HTML without its own duplicate preheader.');
export const CAMPAIGN_DEFAULTS_MAX_KEYS = 100;
export const CAMPAIGN_DEFAULTS_MAX_BYTES = 64 * 1024;
export const EMAIL_LIST_MAX_BYTES = PAGE_MAX_BYTES;
const LARGE_READ_RESERVE_THRESHOLD = 64 * 1024;
const Scalar = z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]);
const DataView = z.record(z.string().max(120), Scalar).default({});
const Data = DataView
  .refine(v => Object.keys(v).length <= CAMPAIGN_DEFAULTS_MAX_KEYS, `At most ${CAMPAIGN_DEFAULTS_MAX_KEYS} keys are supported.`)
  .refine(v => utf8Bytes(JSON.stringify(v)) <= CAMPAIGN_DEFAULTS_MAX_BYTES, 'Defaults must total at most 64 KiB of JSON.')
  .describe('Up to 100 key/value pairs, at most 64 KiB of JSON total.');
const StoredTemplateData = z.record(z.string(), z.unknown()).default({}).refine(value => {
  try { return JSON.stringify(value).length <= 262144; } catch { return false; }
}, 'Template data must be JSON serializable and at most 262,144 serialized characters.').describe('JSON substitution data, including nested objects and arrays, is passed unchanged to SES. SES stored templates do not automatically escape HTML: callers must escape untrusted values for their HTML context. Maximum serialized JSON length: 262,144 characters.');
const Region = z.string().min(1).max(40);
const AttachmentIds = z.array(z.string().min(1).max(120)).max(SEND_LIMITS.attachments).default([])
  .describe(`IDs of files uploaded first (uploadAttachment). ${ATTACHMENT_LIMITS_TEXT}`);
/** The send docs' attachment rules (sendEmail, sendEmailBatch, uploadAttachment), so an agent knows them before a refusal. */
const ATTACHMENT_NOTE = `Attachments: ${ATTACHMENT_LIMITS_TEXT} ${ATTACHMENT_RULES_TEXT} ${ATTACHMENT_REFUSALS_TEXT}`;
const TopicId = z.string().min(1).max(120);
const ContentFields = { subject: Subject.optional(), html: z.string().min(1).max(MAX_BODY).optional(), text: z.string().min(1).max(MAX_BODY).optional() };
const SendInput = z.object({
  from: Address.describe('An address at a domain verified in this workspace, or at a subdomain of one. Hosted: also any address at the workspace\u2019s built-in domain (connection.builtinDomain in GET /v1/me) until a domain of its own verifies.'), fromName: FromName.optional(), to: z.union([Address, z.array(Address).min(1).max(50)]), cc: z.array(Address).max(49).default([]), bcc: z.array(Address).max(49).default([]), replyTo: z.array(Address).max(10).default([]),
  region: Region.optional().describe(`Usually omitted: hosted ${productName} sends from the region bound to the sender domain, and a different value fails with SENDER_REGION_MISMATCH. Self-hosted installations default to their default region.`), kind: z.enum(['transactional', 'marketing']).default('transactional').describe(`marketing adds ${productName}'s footer (an Unsubscribe link, with the workspace's postal address under it when it has one) and the one-click List-Unsubscribe headers.`), ...ContentFields,
  template: z.object({ name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), data: StoredTemplateData }).strict().describe('Uses native SES stored-template rendering and snapshots its rendered MIME. SES does not automatically escape HTML; callers must escape untrusted HTML-context values. Simulated deployments do not render AWS templates.').optional(),
  attachments: AttachmentIds, tracking: z.boolean().optional(), headers: CustomHeaders.optional(),
  topicId: TopicId.optional().describe('kind marketing only (422 TOPIC_REQUIRES_MARKETING otherwise): the topic it is about (listTopics). A recipient who opted out of the topic is refused (reason topic_unsubscribed), and its one-click unsubscribe opts out of this topic only.'),
  screen: z.boolean().optional().describe('Request outbound harm screening at accept time for live transactional mail. Hosted live screening is operator-controlled and cannot be disabled by setting this field to false. Simulated mail is not screened. A positive reject verdict fails the request synchronously with 422 CONTENT_REJECTED_SPAM (nothing queued); during a temporary outage of both classifiers, the message is accepted (202) and held unscreened until a classifier answers. Mandatory Hosted screening with no classifier configured returns retryable 503 CONTENT_SCREEN_UNAVAILABLE with Retry-After.'),
}).strict().superRefine((v, ctx) => {
  if (v.template ? (v.subject !== undefined || v.html !== undefined || v.text !== undefined) : (!v.subject || (!v.html && !v.text))) ctx.addIssue({ code: 'custom', message: 'Provide subject and html/text, or template, but not both.' });
  if ((Array.isArray(v.to) ? v.to.length : 1) + v.cc.length + v.bcc.length > 50) ctx.addIssue({ code: 'custom', message: 'At most 50 recipients across to/cc/bcc.' });
  if (v.kind === 'marketing' && ((Array.isArray(v.to) ? v.to.length : 1) !== 1 || v.cc.length || v.bcc.length)) ctx.addIssue({ code: 'custom', message: 'Marketing messages require exactly one To recipient and no Cc/Bcc.' });
  if (v.template && (v.attachments.length || v.kind === 'marketing')) ctx.addIssue({ code: 'custom', message: 'Stored templates currently support transactional messages without attachments only.' });
}).openapi('BatchSendEmailItem');
// The screen's limits (src/screen.ts), as the API reference states them; the defaults of JEV_MESSAGE_LIMIT_BYTES and JEV_CAMPAIGN_LIMIT_BYTES.
const screenBytes = (n: number) => n.toLocaleString('en-US'), SCREEN = SEND_LIMITS.screen;
const RAMP_NOTE = `Marketing ramp: on Hosted sending, a workspace still ramping up (a new sender, exempt and first-party ones included) sends kind: marketing at most its ramp step's hourly ceiling (${RAMP.steps.map(x => x.ceilingPerHour.toLocaleString('en-US')).join(', ')} recipients an hour), shared with its campaigns. A send that would cross it is refused with nothing queued (a batch as a whole): retryable 429 RAMP_LIMIT_REACHED, with Retry-After (seconds until more room opens) and error.details[0] holding { step, steps, ceilingPerHour, usedThisHour, fitsNow, requested, stepOpensAt }. A scheduled marketing send is refused the same way when it is scheduled if it is larger than the step's whole ceiling, or if with the marketing already scheduled within 24 hours either side of its time it is more than the step sends in 24 hours (error.details[0] adds { scheduledBacklog, dailyBudget }); one that fits is held at its time until its hour has room (it stays scheduled, scheduledAt moving to when it tries again, with a dispatch_deferred event), never rejected for the ramp. While the workspace ramps and a campaign of it is stopped by the automatic pause, the list probe or the ramp's check (LIST_QUALITY, BOUNCE_RATE_HIGH, COMPLAINT_RATE_HIGH) and not resumed or canceled, marketing sends and schedules are refused with 409 RAMP_PAUSED (not retryable; error.details[0] holds { campaignId, pauseCode }): review and resume that campaign first. For a large list, send a campaign instead: campaigns are paced automatically. Transactional mail is never ramped or paused by it.`;
const SCREEN_LIMIT_NOTE = `Front-door admission and content screening: Hosted sending checks validation, recipient suppression/consent, balance, limits, and the outbound harm screen synchronously before queueing. Failing messages return an immediate error (422 RECIPIENT_INELIGIBLE, 422 CONTENT_REJECTED_SPAM, 422 CONTENT_TOO_LARGE_TO_SCREEN, or retryable 503 CONTENT_SCREEN_UNAVAILABLE with Retry-After when no mandatory classifier is configured) and nothing is queued; during a temporary outage of both classifiers, eligible mail is accepted (202) and held unscreened until a classifier answers. Screened-text limits: at most ${screenBytes(SCREEN.messageBytes)} UTF-8 bytes per message (installation default) and ${SCREEN.linkHosts} distinct link hosts (${screenBytes(SCREEN.linkHostBytes)} bytes of host names), counting link labels that name another host; over either limit, error.details[0] holds { screenedBytes, limitBytes } or { linkHosts, linkHostLimit } (plus index in a batch).`;
const CAMPAIGN_SCREEN_NOTE = `Hosted campaigns screen every distinct copy during launch and prepare before any row enters the sending queue, each distinct copy only once: recipients whose personalized copies read the same share one verdict. The campaign\u2019s own copy, placeholders unresolved, is screened first and may hold ${screenBytes(SCREEN.campaignBytes)} bytes of screened text (installation default; 422 CONTENT_TOO_LARGE_TO_SCREEN with error.details[0] { screenedBytes, limitBytes } otherwise); so may each copy. A failing copy never enters the sending queue (CONTENT_REJECTED_SPAM); when refused copies pass 5% and 10 recipients the campaign pauses once for review, and a positive verdict on the campaign\u2019s own copy fails it before anyone is sent to.`;
// The audience is frozen inside the launch request (sending.ts launch): a large one takes seconds, and one statement of it
// may run out of the database's time.
const CAMPAIGN_POSTAL_NOTE = 'Every email\u2019s footer shows the workspace\u2019s postal address under the Unsubscribe link, as US law (CAN-SPAM) requires, frozen as it is now: without one the request is refused with 422 POSTAL_ADDRESS_REQUIRED (set postalAddress with updateWorkspaceSettings).';
const CAMPAIGN_CAPTURE_NOTE = 'Audiences on lists up to 5,000 members freeze inside this request; larger audiences freeze in the background during preparing so this request returns immediately. CampaignQueued.queued is recipients expected; delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. Late capture failures (such as EMPTY_AUDIENCE or AUDIENCE_LIMIT_EXCEEDED) move the campaign to failed with delivery.error and leave the draft editable.';
const captureTimedOut = () => new ApiError(503, 'AUDIENCE_CAPTURE_TIMEOUT', 'The audience capture ran out of time and nothing was kept. Retry the launch; if it keeps running out of time, send to a smaller list.', undefined, true);
// SMTP already limits the entire MIME message to the advertised wire SIZE. Keep all
// address, HTML and encoded-size checks, without imposing the public JSON body-part cap.
const ProtocolBody = z.string().min(1).optional();
const ProtocolSendInput = SendInput.safeExtend({ html: ProtocolBody, text: ProtocolBody });
const ReplyAddressId = z.string().min(1).max(120).optional();
// A send at a later time: an RFC 3339 instant with Z or an offset (a local time without one is refused), stored and
// returned in UTC. The bounds are send_admission's (SEND_LIMITS.schedule), so an exact retry still replays its receipt.
const ScheduledAt = z.string().datetime({ offset: true }).describe(`Send at this time instead of now: an RFC 3339 instant with Z or an offset, such as 2026-11-20T09:00:00Z; times without an offset are refused, and the time is returned in UTC. From now (up to a minute in the past, which sends at once) to ${SEND_LIMITS.schedule.horizonSeconds / 86_400} days ahead; up to ${SEND_LIMITS.schedule.workspace.toLocaleString('en-US')} scheduled emails may wait per workspace (SCHEDULED_EMAIL_LIMIT_EXCEEDED). Content screening and suppression are checked at accept time; sending limits and the balance apply at scheduledAt, when an email they refuse is rejected with their code (email.rejected), except Hosted marketing its ramp hour has no room for, which is held until there is (RAMP_LIMIT_REACHED in sendEmail's description). Not with replyAddressId.`);
const SingleSendInput = SendInput.safeExtend({ replyAddressId: ReplyAddressId.describe('Track a conversation through this receivable address. Use explicit subject and text/html. Requires unrestricted manage permission; From and Reply-To must belong to the address.'), replyMailboxId: ReplyAddressId.openapi({ deprecated: true, description: 'Legacy spelling of replyAddressId.' }), scheduledAt: ScheduledAt.optional() })
  .refine(v => !(v.replyAddressId && v.replyMailboxId), { path: ['replyAddressId'], message: 'Supply only one reply address ID.' })
  .refine(v => !(v.scheduledAt && (v.replyAddressId || v.replyMailboxId)), { path: ['scheduledAt'], message: 'A tracked conversation send goes now; schedule only untracked sends.' }).openapi('SendEmailInput');
const BatchInput = z.object({ emails: z.array(SendInput).min(1).max(100).describe(`Up to 100 messages. Their html and text together may hold ${SEND_LIMITS.batchContentChars / 1024 / 1024} MiB (413 BATCH_CONTENT_TOO_LARGE).`) }).strict().openapi('SendEmailBatchInput');
/** Characters of html and text in a batch's messages together (SEND_LIMITS.batchContentChars). */
const batchContent = (mails: { html?: string; text?: string }[]) => mails.reduce((n, m) => n + (m.html?.length ?? 0) + (m.text?.length ?? 0), 0);
/** A batch with more than 2 MiB of content (the limit before 10 MiB) reserves, in the isolate's memory budget
 *  (isolate-memory.ts), what admitting it builds beside the parsed request: the rows' JSON and the statement's buffers,
 *  about three times its content. The largest batches then never peak together in one isolate; smaller ones run at once. */
const batchMemory = <T>(mails: SendRequest[], work: () => Promise<T>, opts?: { workspaceId?: string; signal?: AbortSignal }) =>
  batchContent(mails) > 2 * 1024 * 1024 ? withMemory(3 * mails.reduce((n, m) => n + contentBytes(m), 0), work, { route: 'email.batch', ...opts }) : work();
export const Status = z.enum(['queued', 'attempting', 'accepted', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'delayed', 'suppressed', 'canceled', 'acceptance_unknown', 'simulated']);
const UntrustedContent = z.boolean().describe('True for replies and older non-campaign mail of unknown origin: the subject or body may contain received content.');
const Email = z.object({ untrustedContent: UntrustedContent, id: z.string(), region: z.string(), campaignId: z.string().nullable(), from: z.string(), fromName: z.string().nullable(), kind: z.enum(['transactional', 'marketing']), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(),
  status: Status.describe('A scheduled email is queued, with scheduled true, until it is sent at scheduledAt.'), providerId: z.string().nullable(), simulated: z.boolean(), attemptStartedAt: z.string().nullable(), errorCode: z.string().nullable(), suppressionReason: SuppressionReason.nullable().optional(),
  scheduled: z.boolean().describe('True while a scheduled send waits for scheduledAt: it has not started sending, and cancelEmail or rescheduleEmail still apply. At that time it is admitted like a send made then (limits and balance included) and follows the usual lifecycle, or is rejected with the refusal\u2019s code.'),
  scheduledAt: z.string().nullable().describe('When a scheduled send goes (UTC). Also set while queued mail waits to be retried.'), createdAt: z.string().describe('When the email was submitted; a scheduled send\u2019s moves to the moment it was released at its time.'), updatedAt: z.string() }).openapi('Email');
const ScreenSummary = z.object({
  status: z.enum(['passed', 'skipped']),
}).openapi('EmailScreenSummary');
const Receipt = z.object({
  id: z.string(),
  status: z.literal('queued'),
  simulated: z.boolean(),
  screen: ScreenSummary.optional().describe('Content-screen outcome recorded at accept time when screening applies.'),
  warnings: z.array(RecipientWarning).optional().describe('Recipients whose address looks risky (a disposable inbox, a mistyped provider, a role address): the email was queued anyway. Campaigns and marketing sends skip risky contacts.'),
}).openapi('EmailQueued');
const SingleReceipt = z.object({ ...Receipt.shape, scheduledAt: z.string().optional().describe('A scheduled send: when it goes (UTC).'), inboundMessageId: z.string().optional(), mailboxMessageId: z.string().optional().openapi({ deprecated: true, description: 'Legacy alias for inboundMessageId.' }), threadId: z.string().optional() }).describe('For tracked sends, id is the transactional receipt, inboundMessageId identifies the stored message, and threadId identifies its conversation.').openapi('SingleEmailQueued');
const BatchReceipt = z.object({ data: z.array(Receipt) }).openapi('EmailBatchQueued');
const sendRecipients = (m: { to: string | string[]; cc: string[]; bcc: string[] }) => [...(Array.isArray(m.to) ? m.to : [m.to]), ...m.cc, ...m.bcc];
const Event = z.object({ id: z.string(), emailId: z.string(), type: z.string(), providerId: z.string().nullable(), simulated: z.boolean(), createdAt: z.string(), data: EmailEventData }).openapi('EmailEvent');
const EmailContent = z.object({ untrustedContent: UntrustedContent, subject: z.string(), html: z.string().nullable(), text: z.string().nullable(), raw: z.string().nullable(), attachments: z.array(z.string()), render: z.enum(['direct', 'ses', 'simulated']), templateName: z.string().nullable(), simulated: z.boolean() }).openapi('EmailContent');
const PreviewClient = z.enum(clients).openapi('EmailPreviewClient');
const previewOptions = {
  clients: z.array(PreviewClient).min(1).max(clients.length).refine(list => new Set<Client>(list).size === list.length, 'Select each client only once.').openapi({ uniqueItems: true }),
  theme: z.enum(['light', 'dark']),
  device: z.enum(['desktop', 'mobile']).optional().describe('Viewport width in CSS pixels: mobile 390, desktop 800. Defaults to mobile for iOS, Android and Samsung Email; otherwise desktop.'),
};
const EmailPreviewInput = z.union([
  z.object({ html: z.string().min(1).describe('HTML to preview, up to 256 KiB in UTF-8.'), ...previewOptions }).strict(),
  z.object({ emailId: IdParams.shape.id.describe('Outbound email with retained HTML visible to this credential.'), ...previewOptions }).strict(),
]).openapi('EmailPreviewInput', { description: 'Supply exactly one source: html or emailId.' }, { unionPreferredType: 'oneOf' });
const EmailPreviews = z.object({ previews: z.array(z.object({
  client: PreviewClient, html: z.string().describe('Untrusted offline document; render only as the srcdoc of an iframe with sandbox="". Empty for classic Outlook (lint only).'),
  issues: z.array(z.object({ feature: z.string(), clients: z.array(PreviewClient), severity: z.enum(['warning', 'error']) })),
})) }).openapi('EmailPreviews');
const AttachmentInfo = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable(), createdAt: z.string() }).openapi('Attachment');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) }).openapi('DeletedSendingResource');
const DraftAudience = AudienceSpec.partial({ listId: true }).default({});
const BlockHtml = z.string().max(MAX_BODY).describe('Block HTML: h1-h3, p, ul/ol, blockquote, pre>code, hr, img, buttons, columns and styled sections with inline formatting. A constrained email-safe style attribute supports color, typography, spacing, borders, radius and dimensions; arbitrary CSS remains rejected. No wrappers, tables, class or id. Call getContentGuide in MCP or GET /v1/campaign-content-guide for the full vocabulary and examples.');
const CampaignDraftFields = { name: z.string().trim().min(1).max(200), from: z.union([Address, z.literal('')]).default(''), fromName: FromName.optional(), previewText: PreviewText.optional(), replyTo: z.array(Address).max(10).default([]), region: Region, regionPinned:z.boolean().optional().describe('Regional MX only. False follows the From domain; the displayed region is a hint. A supplied region on create or a changed region on edit pins it. To unpin, pass false and omit region.'), subject: z.union([Subject, z.literal('')]).default(''), attachments: AttachmentIds, tracking: z.boolean().default(true), audience: DraftAudience, defaults: Data, unsubscribePageUrl: unsubscribePageUrl().optional(),
  topicId: TopicId.optional().describe('The topic the campaign is about (listTopics): it skips contacts who opted out of it, and its one-click unsubscribe opts out of this topic only. Not on a required notice.'),
  requiredNotice: z.boolean().optional().describe('A required notice: a message every recipient must get whatever their marketing choice, such as a change to terms, prices or taxes, never a promotion. It goes to everyone in the audience who is not suppressed, people who unsubscribed from marketing included, without an Unsubscribe link or List-Unsubscribe header, and is paced, limited and paused like any campaign. Only where an operator turned required notices on for the workspace (requiredNotices in getWorkspaceSettings); 403 REQUIRED_NOTICES_OFF otherwise. Sending or scheduling one needs confirmRequiredNotice. Turned off later, a launched notice pauses before releasing anyone more (pause reason REQUIRED_NOTICES_OFF) and is resumed or rescheduled only once they are on again. Resumed after a list-probe quarantine, it goes on to everyone captured for it (never deliveredOnly).') };
const CAMPAIGN_INPUT_NOTES = 'Drafts may omit sender, subject, content and audience until review or send, except that domain-restricted keys must supply a From address on one of their domains. Content is block HTML (see html); the same form is what the dashboard composer reads and writes, so people and agents edit one document. Simple {{name}} personalization works in text and quoted href/alt attributes; values are HTML-escaped and rendered URLs are validated. Durable campaign preparation is bounded and runs in background jobs.';
const CampaignInput = z.object({ ...CampaignDraftFields, html: BlockHtml.optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraftInput');
// Stored drafts predating block HTML or defaults caps remain readable; they are revalidated when saved or reviewed.
const CampaignDraftView = z.object({ ...CampaignDraftFields, defaults: DataView, html: z.string().optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraft');
const CampaignCreate = z.object({ ...CampaignInput.shape, region: Region.optional().describe('Defaults to the installation region. With regional MX delivery, omitting region follows the From domain.'), tracking: z.boolean().optional(), templateId: z.string().regex(/^tpl_[0-9a-f]{32}$/).optional().describe('Copies the active published revision of this global campaign template into a new independent campaign draft.') }).strict().openapi('CreateCampaignInput');
const CampaignReady = CampaignInput.extend({ from: Address, subject: Subject, audience: AudienceSpec }).refine(v => !!v.html?.trim(), { message: 'Provide html before reviewing.', path: ['html'] });
const CampaignStateValue = z.enum(CAMPAIGN_STATES).describe('draft: editable. preparing: the audience is being frozen (for large lists) and every message is being validated in the background. scheduled: validated and waiting for scheduledAt. sending: recipients are being released into the dispatch queue. paused: releasing stopped by the user or the health check; queued mail still dispatches. done: every recipient was released and dispatched. failed: capture, preparation or releasing failed (delivery.error); edit or launch again. canceled: terminal.');
const emptyCounts = () => ({ total: 0, byStatus: Object.fromEntries(Status.options.map(status => [status, 0])) as Record<EmailStatus, number> });
const CampaignCounts = z.object({ total: z.number().int().nonnegative(), byStatus: z.record(Status, z.number().int().nonnegative()) }).describe('Counts of immutable campaign email records grouped by their current status, not cumulative provider events or delivery rates. Drafts with no queued emails have zero counts.');
const Failure = z.object({ code: z.string(), message: z.string() });
export const FEEDBACK_LAG_HOLD_MS = 5 * 60_000;
export const FEEDBACK_LAG_FRESH_MS = 5 * 60_000;
export const FEEDBACK_LAG_DISPLAY_MS = 2 * 60_000;
/** Minimum queue backlogCount required before queue-level metrics() oldestMessageTimestamp counts as lane lag,
 *  so a handful of poison/unmatchable messages sitting in Cloudflare retry backoff never trip an installation-wide hold. */
export const FEEDBACK_LAG_MIN_DEPTH = 10;
export type FeedbackLag = { oldestMs: number; lane: 'routine' | 'priority' };

/** Persist the latest feedback queue lag sample (single-row upsert, called from minute cron and throttled on backlog). */
export async function recordFeedbackLag(db: DbExecutor, lane: 'routine' | 'priority', depth: number, oldestMs: number) {
  const safeDepth = Math.max(0, Math.round(depth)), safeOldest = Math.max(0, Math.round(oldestMs));
  await db.execute(sql`INSERT INTO operation_feedback_lag(lane, depth, oldest_ms, updated_at) VALUES (${lane}, ${safeDepth}, ${safeOldest}, now())
    ON CONFLICT (lane) DO UPDATE SET depth = excluded.depth, oldest_ms = excluded.oldest_ms, updated_at = now()`);
}
async function activeFeedbackLag(db: DbExecutor): Promise<FeedbackLag | null> {
  const { rows: [row] } = await db.execute<{ lane: 'routine' | 'priority'; oldest_ms: number }>(sql`
    SELECT lane, oldest_ms FROM operation_feedback_lag
    WHERE updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)
      AND oldest_ms >= ${FEEDBACK_LAG_DISPLAY_MS}
    ORDER BY oldest_ms DESC, (lane = 'priority') DESC LIMIT 1`);
  return row ? { lane: row.lane, oldestMs: Number(row.oldest_ms) } : null;
}

const Delivery = z.object({ total: z.number().int().describe('Fixed recipient count once the audience is frozen (recipients expected while a large audience is being captured).'), prepared: z.number().int().describe('Recipients whose message was validated.'), expanded: z.number().int().describe('Recipients materialized as immutable email records.'), canceled: z.number().int().describe('Recipients canceled before materialization. Materialized cancellations remain in counts.byStatus.canceled.'), error: Failure.nullable().describe('Why the campaign failed or was canceled by the system.'),
  pacing: z.object({ perDay: z.number().int().nullable().describe('Maximum recipients released per rolling 24-hour window; null means no daily cap.'), autoPause: z.boolean().describe('Pause automatically when bounce or complaint rates exceed safe thresholds.'), rateShare: z.number().describe('Maximum fraction of the SES per-second send rate this campaign uses; 1 is the full rate.'), windowStartedAt: z.string().nullable(), windowExpanded: z.number().int().describe('Recipients released in the current 24-hour window.'), nextWindowAt: z.string().nullable().describe('When the next 24-hour window opens, when a daily cap is set.'),
    plan: z.array(z.number().int()).nullable().describe('Sent with the recommended plan: its daily batches (one 24-hour window each; the last repeats). Null otherwise.'), batch: z.number().int().nullable().describe('With a plan: the batch the current window releases, from 1.'),
    firstBatch: z.object({ size: z.number().int().describe('Recipients the first day starts with.'), waitMinutes: z.number().int().describe('Minutes it then waits for their bounces and rejections before the rest of the day\'s batch.') }).nullable().optional().describe('With a plan: its first day\'s small batch and the wait after it.') }),
  consent: z.object({ source: z.string(), confirmedAt: z.string() }).nullable().describe('The consent source confirmed at launch, if any.'),
  pausedAt: z.string().nullable(), pauseReason: Failure.nullable(),
  deliveredOnly: z.boolean().describe('After a resumed list-probe quarantine: the rest goes only to contacts this workspace delivered to before; the others are counted in canceled. Never for a required notice.'),
  waiting: z.object({ reason: z.enum(['pacing_window', 'ses_daily_quota', 'hosted_daily_quota', 'list_probe', 'balance', 'feedback_lag', 'ramp', 'link_record']), linkHold: z.enum(['daily_budget', 'blocklist']).optional().describe('When present, the daily pacing window is the shared link allowance, or the link record is held for operator review.'), until: z.string() }).nullable().describe('Why releasing recipients is currently held, and the best estimate of until when. list_probe: Hosted sent the first recipients (the list probe) and waits for their bounces and complaints before releasing the rest. feedback_lag: releasing is briefly held while priority safety feedback (bounces/complaints) catches up. ramp: a Hosted sender\'s first large campaigns release in growing hourly steps (sendEstimate.ramp); this hour\'s step is used up, or its delivery results are still coming in before the next step. link_record: the campaign has no host for its unsubscribe link right now (its workspace\'s sending is paused, or with own link hosts, its domain\'s isn\'t active yet); it continues by itself.'),
  feedbackLag: z.object({ oldestMs: z.number().int(), lane: z.enum(['routine', 'priority']) }).nullable().describe('Present while a campaign is preparing, sending, or paused when delivery feedback ingestion is at least 2 minutes behind.') }).describe('The current launch: null until the campaign is sent or scheduled, and cleared by a new revision.').openapi('CampaignDelivery');
/** The daily cap of a campaign's `index`th 24-hour window: its plan's batch (the last repeating), else pacePerDay; null for none. */
const dailyCap = (row: Pick<typeof campaigns.$inferSelect, 'pacePlan' | 'pacePerDay' | 'windowIndex'>, index = row.windowIndex) =>
  row.pacePlan?.length ? row.pacePlan[Math.min(index, row.pacePlan.length - 1)]! : row.pacePerDay;
/** When a plan's first small batch is waiting for its feedback: the end of that wait (ms), else null. Only in the first window. */
const firstBatchWait = (row: Pick<typeof campaigns.$inferSelect, 'pacePlan' | 'paceFirstBatch' | 'paceFirstWaitMinutes'>, index: number, windowStartedAt: string | null, nowMs: number) => {
  if (!row.pacePlan?.length || !row.paceFirstBatch || !row.paceFirstWaitMinutes || index !== 0 || !windowStartedAt) return null;
  const until = Date.parse(windowStartedAt) + row.paceFirstWaitMinutes * 60_000;
  return nowMs < until ? until : null;
};
function deliveryView(row: Omit<typeof campaigns.$inferSelect, 'draft' | 'stats'>, feedbackLag: FeedbackLag | null = null) {
  if (!row.reviewId) return null;
  const next = dailyCap(row) !== null && row.windowStartedAt ? new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString() : null;
  const wait = row.waitingReason === 'link_budget' ? { reason: 'pacing_window', linkHold: 'daily_budget' }
    : row.waitingReason === 'link_listing' ? { reason: 'link_record', linkHold: 'blocklist' } : { reason: row.waitingReason };
  return Delivery.parse({ total: row.total, prepared: row.prepared, expanded: row.expanded, canceled: row.canceled, error: row.error ?? null,
    pacing: { perDay: row.pacePerDay, autoPause: row.autoPause, rateShare: row.rateShare ?? 1, windowStartedAt: row.windowStartedAt, windowExpanded: row.windowExpanded, nextWindowAt: next,
      plan: row.pacePlan, batch: row.pacePlan ? Math.min(row.windowIndex, row.pacePlan.length - 1) + 1 : null,
      firstBatch: row.pacePlan && row.paceFirstBatch && row.paceFirstWaitMinutes ? { size: row.paceFirstBatch, waitMinutes: row.paceFirstWaitMinutes } : null },
    consent: row.consent ? { source: row.consent.source, confirmedAt: row.consent.confirmedAt } : null,
    pausedAt: row.pausedAt, pauseReason: row.pauseReason ?? null, deliveredOnly: row.deliveredOnly, waiting: row.waitingReason && row.waitingUntil ? { ...wait, until: row.waitingUntil } : null,
    feedbackLag: ['preparing', 'sending', 'paused'].includes(row.state) ? feedbackLag : null });
}
const CampaignRamp = z.object({ step: z.number().int().describe('The step the campaign releases at, from 1.'), steps: z.number().int().describe('How many steps the ramp has; past the last one only the other limits apply.'), ceilingPerHour: z.number().int().describe('Most recipients this step releases in its hour.'),
  startedAt: z.string().nullable().describe('When this step\'s hour started: its first release. Null before it.'), released: z.number().int().describe('Recipients released since this step\'s hour started.') })
  .describe('Where the campaign is on the ramp. A Hosted sender\'s first large campaigns release in hourly steps that grow (1,000 an hour at first), moving to the next step once an hour at this one went out and its delivery results are in and clean; more than 3% bounces or more than 0.08% complaints (at least 2) in a step pause the campaign. The first step not already proven by the workspace\'s largest clean marketing hour of the last 30 days is where it starts, so an established sender skips it. Null when no ramp applies (self-hosted, your own AWS account, simulated mail, an established sender, or past the last step). Transactional mail never waits for it.').openapi('CampaignRamp');
const SendEstimate = z.object({
  recipients: z.number().int().nullable().describe('Recipients still to release: for a draft, the last audience count (previewCampaignAudience; null before one); once launched, those not released yet.'),
  ratePerSecond: z.number().nullable().describe('The region\'s send rate the campaign plans at, per second, before its rate share; null until the region\'s quota was read.'),
  ramp: CampaignRamp.nullable(),
  seconds: z.number().int().nullable().describe('How long releasing the recipients left takes from when it starts (the campaign\'s last change, updatedAt, or scheduledAt): from the ramp, the daily cap (pacing.perDay), the rate share and the region\'s send rate. A draft is estimated without a daily cap at the full rate. An estimate: it assumes clean, prompt feedback and leaves out the list probe\'s wait, quota holds and other mail sharing the rate. Null when it cannot be told (no audience count or send rate yet).'),
  finishAt: z.string().nullable().describe('A launched campaign: when its last recipient is expected to be released, as of its last change (updatedAt or scheduledAt, plus seconds). Null for a draft, while paused or failed, or when it cannot be told.'),
}).describe('How long sending takes, for a draft or a campaign that has recipients left to release. Null for a finished or canceled campaign; lists leave it out.').openapi('CampaignSendEstimate');
const Campaign = z.object({ id: z.string(), url: z.string().url().describe('Dashboard URL for opening this campaign. Drafts open in the editor; launched campaigns open in review.'), revision: z.number().int(), draft: CampaignDraftView, sourceTemplateId: z.string().nullable(), sourceTemplateRevision: z.number().int().nullable(), state: CampaignStateValue, scheduledAt: z.string().nullable(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), counts: CampaignCounts, delivery: Delivery.nullable(), sendEstimate: SendEstimate.nullable() }).openapi('Campaign');
const CampaignRate = z.object({ value: z.number().nonnegative().nullable().describe('Fraction, not percent. Both counts exclude simulated emails. Null when the denominator is zero or engagement tracking is disabled. Not clamped: delayed feedback can temporarily make outcomes exceed the denominator.'), numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative() });
const CampaignStats = z.object({
  id: z.string(), name: z.string(), state: CampaignStateValue, tracking: z.boolean(), counts: CampaignCounts, delivery: Delivery.nullable(),
  totals: z.object({ accepted: z.number().int(), delivered: z.number().int(), bounced: z.number().int(), complained: z.number().int(), opened: z.number().int(), clicked: z.number().int(), failed: z.number().int(), deliveryDelayed: z.number().int(), simulated: z.number().int() }).describe('Lifetime distinct email counts from current state and stored events; outcomes overlap. Accepted excludes simulated mail; other outcomes include simulated events for simulated mail. Opens and clicks include bots and privacy proxies. Failed means rejected or rendering failed; suppressed, canceled and uncertain mail remain in counts.byStatus.'),
  rates: z.object({ delivery: CampaignRate.describe('Delivered / accepted. Receiving-server acceptance, not inbox placement.'), bounce: CampaignRate.describe('Bounced / accepted.'), complaint: CampaignRate.describe('Complained / accepted.'), open: CampaignRate.describe('Unique opened emails / delivered.'), click: CampaignRate.describe('Unique clicked emails / delivered, not click-to-open rate.') }),
  computedAt: z.string().describe('When counts, totals and rates were counted: they include every change made before then. state and delivery are always current.'),
}).describe('Lifetime campaign statistics, with no date cutoff or pagination. Done means dispatch finished, not delivery finished. Feedback is asynchronous; missing engagement does not prove nobody read or clicked. Simulated outcomes are never evidence of real delivery.').openapi('CampaignStats');
/**
 * Background counts of campaign outcomes (campaignStatsJob), for campaigns of at least `from` recipients, whose stats a
 * read could not aggregate within its limit. A step counts one page, a fixed range of review ordinals, so it costs the
 * same however large the campaign; a job run takes steps for about `runMs`, then waits `pace` times as long as the run
 * took (at least `pauseMs`) before the next: with the job's own claim and settle the count uses about 3% of one
 * connection's database time, spread over the whole pass instead of a burst, and a larger campaign is simply counted
 * less often (2,000,000 recipients: 400 steps, a pass every 7 minutes or so on a fast core, longer on a slower one). A pass starts at most every `everyMs` while the campaign sends and only when the workspace's mail
 * changed; a finished campaign is counted once more, and when read after `readRefreshMs`. Exported for the tests.
 */
export const CAMPAIGN_STATS = { from: 20_000, page: 5_000, runMs: 250, pace: 32, pauseMs: 1_000, everyMs: 60_000, readRefreshMs: 600_000 };
const STATS_NOTE = `A campaign of at least ${CAMPAIGN_STATS.from.toLocaleString('en-US')} recipients is counted in the background: about once a minute while it sends (every few minutes for the largest, so counting stays a small share of the database's time), once more when it finishes, and again when read more than ${CAMPAIGN_STATS.readRefreshMs / 60_000} minutes later if anything changed. Its figures are the last count, so they can be minutes old; computedAt says when. A finished campaign keeps its figures after its emails leave the 30-day history.`;
/**
 * Outcome counts per (campaign, status, simulated) of the emails `where` selects, each email counted once per outcome
 * over all its stored events, without loading mail bodies. Groups of disjoint sets of emails add up, so counts taken
 * page by page equal one count over all of them.
 */
async function statsGroups(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, where: SQL | undefined) {
  const has = (bit: number) => sql`(${emails.eventOutcomes} & ${bit}) <> 0`;
  const count = (condition: SQL) => sql<number>`count(*) FILTER (WHERE ${condition})::int`;
  return db.select({
    campaignId: emails.campaignId, status: emails.status, simulated: emails.simulated, count: sql<number>`count(*)::int`,
    accepted: count(sql`NOT ${emails.simulated} AND ${emails.status} <> 'suppressed' AND (${emails.providerId} IS NOT NULL OR ${emails.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${has(1)})`),
    delivered: count(sql`${emails.status} = 'delivered' OR ${has(2)}`),
    bounced: count(sql`${emails.status} = 'bounced' OR ${has(4)}`),
    complained: count(sql`${emails.status} = 'complained' OR ${has(8)}`),
    opened: count(has(16)), clicked: count(has(32)),
    failed: count(sql`${emails.status} IN ('rejected', 'rendering_failed') OR ${has(64)}`),
    deliveryDelayed: count(sql`${emails.status} = 'delayed' OR ${has(128)}`),
  }).from(emails).where(and(scope(emails, a), where)).groupBy(emails.campaignId, emails.status, emails.simulated);
}
async function tallyStatsGroups(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, campaignIds: string[]) {
  if (!campaignIds.length) return [];
  const { rows } = await db.execute<CampaignStatsGroup & { campaignId: string }>(sql`SELECT
    campaign_id AS "campaignId", status, simulated,
    sum(email_count)::int AS count, sum(accepted)::int AS accepted, sum(delivered)::int AS delivered,
    sum(bounced)::int AS bounced, sum(complained)::int AS complained, sum(opened)::int AS opened,
    sum(clicked)::int AS clicked, sum(failed)::int AS failed, sum(delivery_delayed)::int AS "deliveryDelayed"
    FROM sending_campaign_tallies
    WHERE workspace_id = ${a.workspaceId} AND campaign_id = ANY(${sql.param(campaignIds)}::text[])
    GROUP BY 1, 2, 3 HAVING sum(email_count) > 0`);
  return rows;
}
/** The stored count of the campaign's current launch, if any (an earlier launch's never applies). */
const storedStats = (row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats'>) => row.reviewId && row.stats?.reviewId === row.reviewId ? row.stats : null;
const backgroundCounted = (row: typeof campaigns.$inferSelect) => row.total >= CAMPAIGN_STATS.from;
/** A listed campaign's stored totals (CampaignListStats), without counting anything. */
function listedStats(row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats'> & { tracking: boolean | null }) {
  const stored = storedStats(row);
  if (!stored) return null;
  const total = (key: 'accepted' | 'delivered' | 'opened' | 'clicked') => stored.groups.reduce((n, group) => n + group[key], 0);
  return { tracking: row.tracking ?? true, accepted: total('accepted'), delivered: total('delivered'), opened: total('opened'), clicked: total('clicked'), computedAt: stored.computedAt };
}
/**
 * Lifetime statistics of campaigns (GET /v1/campaigns/{id}/stats, and the support reads in src/support-deliverability.ts).
 * A large campaign with a stored count reads it; the others are counted now, in one statement over the campaign and
 * per-email event indexes for all of them. A stored count that saw more emails than are left is kept: the 30-day
 * retention removed the rest, and a finished campaign's figures outlive its emails.
 */
export async function campaignStats(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, rows: (typeof campaigns.$inferSelect)[]) {
  const result = new Map<string, z.infer<typeof CampaignStats>>();
  if (!rows.length) return result;
  const useTallies = await talliesEnabled(db);
  const countedAt = new Date().toISOString();
  if (useTallies) {
    // Exact at read time: sums folded rows + unfolded deltas in sending_campaign_tallies (< 2 ms at any scale).
    // After 30-day retention removes emails, a frozen or larger stored snapshot in sending_campaigns.stats stays in force.
    const grouped = await tallyStatsGroups(db, a, rows.map(row => row.id));
    for (const row of rows) {
      const stored = storedStats(row), counted = grouped.filter(item => item.campaignId === row.id);
      const tallyEmails = counted.reduce((n, item) => n + item.count, 0);
      const kept = stored && (stored.frozen || stored.emails > tallyEmails);
      result.set(row.id, statsView(row, kept ? stored.groups : counted, kept ? stored.computedAt : countedAt));
    }
    return result;
  }
  // Fallback when tally triggers are disabled (emergency undo): live aggregate behind budgetedRead.
  const live = rows.filter(row => !(backgroundCounted(row) && storedStats(row)));
  const grouped = live.length ? await statsGroups(db, a, live.length === 1 ? eq(emails.campaignId, live[0]!.id) : inArray(emails.campaignId, live.map(row => row.id))) : [];
  for (const row of rows) {
    const stored = storedStats(row), counted = grouped.filter(item => item.campaignId === row.id);
    const kept = stored && (backgroundCounted(row) || stored.emails > counted.reduce((n, item) => n + item.count, 0));
    result.set(row.id, statsView(row, kept ? stored.groups : counted, kept ? stored.computedAt : countedAt));
  }
  return result;
}
function statsView(row: typeof campaigns.$inferSelect, groups: CampaignStatsGroup[], computedAt: string): z.infer<typeof CampaignStats> {
  const real = { accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0 };
  const counts = emptyCounts(), totals = { ...real, simulated: 0 };
  for (const item of groups) {
    counts.byStatus[item.status] += item.count; counts.total += item.count;
    if (item.simulated) totals.simulated += item.count;
    for (const key of Object.keys(real) as (keyof typeof real)[]) {
      totals[key] += item[key];
      if (!item.simulated) real[key] += item[key];
    }
  }
  const rate = (numerator: number, denominator: number, enabled = true) => ({ numerator, denominator, value: denominator && enabled ? numerator / denominator : null });
  return { id: row.id, name: row.draft.name, state: row.state, tracking: row.draft.tracking, counts, delivery: deliveryView(row), totals,
    rates: { delivery: rate(real.delivered, real.accepted), bounce: rate(real.bounced, real.accepted), complaint: rate(real.complained, real.accepted), open: rate(real.opened, real.delivered, row.draft.tracking), click: rate(real.clicked, real.delivered, row.draft.tracking) }, computedAt };
}
const addGroups = (sum: CampaignStatsGroup[], page: CampaignStatsGroup[]) => {
  const next = sum.map(group => ({ ...group }));
  for (const item of page) {
    const { status, simulated, count, accepted, delivered, bounced, complained, opened, clicked, failed, deliveryDelayed } = item;
    const group = next.find(g => g.status === status && g.simulated === simulated);
    if (!group) { next.push({ status, simulated, count, accepted, delivered, bounced, complained, opened, clicked, failed, deliveryDelayed }); continue; }
    for (const key of ['count', 'accepted', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'deliveryDelayed'] as const) group[key] += item[key];
  }
  return next;
};
const campaignStatsJobId = (campaignId: string) => `campaign-stats:${campaignId}`;
/** Starts the campaign's background count at `at` (now when null), unless one is already waiting or running. */
const queueCampaignStats = (ref: { workspaceId: string; id: string }, at: string | null = null) => queueCampaignsStats(ref.workspaceId, [ref.id], at);
/** The same for several campaigns of a workspace, in one statement that takes their job rows in ID order. */
const queueCampaignsStats = (workspaceId: string, campaignIds: string[], at: string | null = null) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at)
  VALUES ${sql.join([...campaignIds].sort().map(campaignId => sql`(${campaignStatsJobId(campaignId)},'sending.campaignStats',${workspaceId},${JSON.stringify({ campaignId })}::jsonb,coalesce(${at}::timestamptz,now()))`), sql`,`)}
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL
  WHERE jobs.status IN ('completed','failed')`;
/** A read restarts the count of a launched campaign never counted, or of a finished one counted `readRefreshMs` ago. */
function statsDue(row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats' | 'state'>) {
  if (!row.reviewId) return false;
  const stored = storedStats(row);
  if (!stored) return true;
  return !stored.frozen && !(CAMPAIGN_ACTIVE as readonly string[]).includes(row.state) && Date.now() - Date.parse(stored.computedAt) >= CAMPAIGN_STATS.readRefreshMs;
}
type StatsPass = { reviewId: string; computedAt: string; revision: string; ordinal: number; groups: CampaignStatsGroup[] };
/**
 * One campaign's background count: a page of its emails by review ordinal (sending_emails_review_ordinal) per run, each
 * its own short statement outside any transaction, the running sums carried in the job's payload between runs, stored on
 * the campaign when the pass ends. Every email of a campaign belongs to its current review: the release is the only path
 * that writes campaign mail, and a launch takes a new review only while nothing was released.
 */
const campaignStatsJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A campaign count needs its campaign.');
  const campaignId = payload.campaignId, a = { workspaceId: job.workspaceId }, at = (ms: number) => new Date(Date.now() + ms).toISOString(), started = Date.now();
  const [row] = await runtime.db.select().from(campaigns).where(and(scope(campaigns, a), eq(campaigns.id, campaignId)));
  // Deleted, or a draft again: nothing to count until a launch queues this again.
  if (!row?.reviewId) return;
  const active = (CAMPAIGN_ACTIVE as readonly string[]).includes(row.state), stored = storedStats(row);
  let pass = payload.pass as StatsPass | undefined;
  if (pass?.reviewId !== row.reviewId) pass = undefined;
  if (!pass) {
    if (stored?.frozen) return;
    // While it sends, only a large campaign is counted (a small one is counted when read), and only once it released
    // someone: until then wait for its schedule, looking again at least every 15 minutes in case it moved.
    if (active && (row.expanded === 0 || !backgroundCounted(row))) {
      const due = row.expanded === 0 && row.scheduledAt ? Date.parse(row.scheduledAt) - Date.now() : 0;
      throw new JobDeferred(at(Math.min(Math.max(due, CAMPAIGN_STATS.everyMs), 15 * 60_000)), { campaignId });
    }
    // Nothing changed when the workspace has no newer email or email event; a finished campaign is counted once after
    // it finished, so its figures are exact then.
    const revision = await mailRevision(runtime, a.workspaceId);
    if (stored && stored.revision === revision && (active || Date.parse(stored.computedAt) >= Date.parse(row.updatedAt))) {
      if (active) throw new JobDeferred(at(CAMPAIGN_STATS.everyMs), { campaignId });
      return;
    }
    // The database's clock, which also stamps updated_at, so "counted after it finished" never depends on this host's clock.
    const { rows: [clock] } = await runtime.db.execute<{ at: string }>(sql`SELECT to_json(clock_timestamp())#>>'{}' AS at`);
    pass = { reviewId: row.reviewId, computedAt: new Date(clock!.at).toISOString(), revision, ordinal: 0, groups: [] };
  }
  // Pages, each its own statement, until the run has used `runMs`: the job's own claim and settle are then a small part
  // of each run.
  while (pass.ordinal < row.expanded) {
    const page = await statsGroups(runtime.db, a, and(eq(emails.campaignId, campaignId), eq(emails.reviewId, pass.reviewId), gt(emails.reviewOrdinal, pass.ordinal), lte(emails.reviewOrdinal, pass.ordinal + CAMPAIGN_STATS.page)));
    pass = { ...pass, ordinal: pass.ordinal + CAMPAIGN_STATS.page, groups: addGroups(pass.groups, page) };
    if (Date.now() - started >= CAMPAIGN_STATS.runMs) break;
  }
  // This run's database time, paid back as idle time before the next run or pass.
  const pause = Math.max(CAMPAIGN_STATS.pauseMs, CAMPAIGN_STATS.pace * (Date.now() - started));
  if (pass.ordinal < row.expanded) throw new JobDeferred(at(pause), { campaignId, pass });
  const counted: StoredCampaignStats = { reviewId: pass.reviewId, computedAt: pass.computedAt, revision: pass.revision, emails: pass.groups.reduce((n, g) => n + g.count, 0), groups: pass.groups };
  // A count never replaces one that saw more emails: the 30-day retention deleted those, so the stored figures stay, frozen.
  const kept = await runtime.db.execute(sql`UPDATE sending_campaigns SET stats=${JSON.stringify(counted)}::jsonb WHERE workspace_id=${a.workspaceId} AND id=${campaignId} AND review_id=${pass.reviewId}
    AND (stats->>'reviewId' IS DISTINCT FROM ${pass.reviewId} OR (stats->>'emails')::int <= ${counted.emails}) RETURNING id`);
  if (!kept.rows.length) {
    await runtime.db.execute(sql`UPDATE sending_campaigns SET stats=stats||'{"frozen":true}'::jsonb WHERE workspace_id=${a.workspaceId} AND id=${campaignId} AND stats->>'reviewId'=${pass.reviewId}`);
    return;
  }
  if (active) throw new JobDeferred(new Date(Math.max(Date.parse(pass.computedAt) + CAMPAIGN_STATS.everyMs, Date.now() + pause)).toISOString(), { campaignId });
  // A pass that started before the campaign finished is followed by one after it, so the finished figures are exact.
  if (Date.parse(pass.computedAt) < Date.parse(row.updatedAt)) throw new JobDeferred(at(pause), { campaignId });
});
const CampaignState = Campaign.pick({ id: true, revision: true, updatedAt: true, state: true, scheduledAt: true, archivedAt: true }).describe('Compact state for draft sync polling. Compare all fields, not only revision: archival and delivery state can change without a new draft revision. Fetch the full campaign when state changes. No draft content or delivery counts.').openapi('CampaignState');
const CampaignDraftSummary = CampaignDraftView.pick({ name: true, region: true, from: true, fromName: true, subject: true, previewText: true }).extend({ audience: AudienceSpec.pick({ listId: true, segmentId: true }).partial({ listId: true }).default({}) }).strict().openapi('CampaignDraftSummary');
const CampaignListStats = z.object({ tracking: z.boolean(), accepted: z.number().int(), delivered: z.number().int(), opened: z.number().int(), clicked: z.number().int(), computedAt: z.string().describe('When the count was taken.') })
  .describe('The campaign\u2019s last stored count: the totals getCampaignStats reported when it was taken (computedAt). Null when it has none. Listing never counts emails or events; listing with listId starts a count for finished campaigns whose figures are missing or stale, so they appear on a later read.').openapi('CampaignListStats');
const CampaignSummary = Campaign.omit({ draft: true, sendEstimate: true }).extend({ draft: CampaignDraftSummary, stats: CampaignListStats.nullable() }).describe('Campaign list metadata only. Fetch GET /v1/campaigns/{id} for the complete draft before editing or sending. Content, defaults, attachments and audience exclusions are intentionally omitted.').openapi('CampaignSummary');
// The filters' statuses: the published ones, and scheduled for sends still waiting (they read queued, with scheduled true).
export const EmailStatusFilter = z.enum([...Status.options, 'scheduled']);
// A literal substring search of sent mail (sending_log_text ILIKE): the trigram index answers terms of 3 characters or
// more; a shorter one can't use it and reads every email of the workspace, so it is refused.
export const SubstringSearch = z.string().trim().min(3, 'Search for at least 3 characters.').max(200);
/**
 * listEmails' time bounds. Integrations read from and to as sender and recipient (a production key sent an address in
 * from 13 times in 3 minutes), so a value that isn't a date-time is refused saying what the field is, and where an
 * address goes instead: search. (The 422's message ends the sentence: app.ts invalidFields.)
 */
const timeBound = (field: 'from' | 'to' | 'since' | 'until', edge: 'start' | 'end') => z.string().datetime({ offset: true, error: issue => {
  const address = typeof issue.input === 'string' && issue.input.includes('@');
  return `\`${field}\` is an ISO 8601 date-time (the ${edge} of the time range), such as 2026-11-01T00:00:00Z${address ? ', not an email address, and this looks like one' : ''}. To filter by ${edge === 'start' ? 'sender' : 'recipient'} address, use \`search\``;
} });
const EmailQuery = PageQuery.extend({ campaignId: z.string().max(120).optional(), status: EmailStatusFilter.optional().describe('scheduled lists sends waiting for their time; queued includes them.'), region: Region.optional(), kind: z.enum(['transactional', 'marketing']).optional(), search: SubstringSearch.optional().describe('Literal case-insensitive substring of sender, To/Cc/Bcc, subject or email/campaign/provider ID, at least 3 characters: a shorter term is refused with 422 VALIDATION_FAILED. This is how to filter by sender or recipient address.'),
  from: timeBound('from', 'start').optional().describe('The start of the time range: emails created at or after this ISO 8601 date-time with Z or an offset, such as 2026-11-01T00:00:00Z. A time, not a sender: filter by sender address with search. since is the same filter by a clearer name; send one of them.'),
  to: timeBound('to', 'end').optional().describe('The end of the time range: emails created before this ISO 8601 date-time with Z or an offset. A time, not a recipient: filter by recipient address with search. until is the same filter by a clearer name; send one of them.'),
  since: timeBound('since', 'start').optional().describe('The start of the time range, the same filter as from: emails created at or after this ISO 8601 date-time. Send since or from, not both.'),
  until: timeBound('until', 'end').optional().describe('The end of the time range, the same filter as to: emails created before this ISO 8601 date-time. Send until or to, not both.'),
}).superRefine((q, ctx) => {
  if (q.from && q.since) ctx.addIssue({ code: 'custom', path: ['since'], message: 'since and from are the same filter (the start of the time range): send one of them' });
  if (q.to && q.until) ctx.addIssue({ code: 'custom', path: ['until'], message: 'until and to are the same filter (the end of the time range): send one of them' });
  const start = q.since ?? q.from, end = q.until ?? q.to;
  if (start && end && Date.parse(start) >= Date.parse(end)) ctx.addIssue({ code: 'custom', path: [], message: 'from must precede to (since must precede until)' });
}).describe('Newest created emails first, with an opaque cursor bound to the filters. Date range is createdAt >= from (or since) and < to (or until): times, not addresses. Search is literal and case-insensitive across sender address, To/Cc/Bcc recipients, subject and email/campaign/provider IDs. Use status, region, kind and creation-date filters for those fields; error codes, simulation state and timestamps are not free-text fields.').openapi('ListEmailsQuery');
const CampaignQuery = PageQuery.extend({ region: Region.optional(), state: CampaignStateValue.optional(), archived: z.enum(['true', 'false']).default('false').describe('False lists active campaigns; true lists archived campaigns only.'), search: z.string().trim().min(1).max(200).optional(),
  listId: z.string().min(1).max(120).optional().describe('Only campaigns whose audience list is this one: a newsletter\u2019s issues.'),
  newsletter: z.enum(['true', 'false']).optional().describe('true: only campaigns whose audience list is a newsletter. false: only the others, with no list or a list that is not a newsletter.') }).describe('Newest created campaigns first, excluding archived campaigns by default, with an opaque cursor bound to the filters. Search is literal, case-insensitive name, subject or ID text.').openapi('ListCampaignsQuery');
const HistoryFigures = z.object({ largestSend: z.number().int().describe('Most recipients SES accepted from one campaign in the last 90 days.'),
  firstSentAt: z.string().nullable().optional().describe('When this workspace first had mail accepted (workspace history only); null with none.'),
  usualDay: z.number().int().optional().describe('The usual day: the median of the mail accepted on the days it sent in the last 14 days (workspace history only); 0 with none.'), sent: z.number().int().describe('Recipients SES accepted in the last 30 days.'),
  bounceRate: z.number().nullable().describe('Hard bounces ÷ accepted over the last 30 days; null with nothing sent.'), complaintRate: z.number().nullable().describe('Complaints ÷ accepted over the last 30 days; null with nothing sent.') });
const CampaignReadiness = z.object({
  verdict: z.enum(['ready', 'ramp_recommended', 'ramp_required']).describe('ready: send as you like. ramp_recommended: the plan is suggested. ramp_required: a Hosted send this large, from a new domain or far above anything its domain has sent, goes out with the plan (pacing.plan "recommended"), a daily limit no larger than its first day, or a confirmed consent source (consent); 422 RAMP_REQUIRED otherwise.'),
  summary: z.string().nullable().describe('Why, in one or two plain sentences, when a ramp is recommended or required.'),
  reasons: z.array(z.object({ code: z.enum(LEGACY_READINESS_REASONS), message: z.string() })).describe('The findings behind the verdict in the original codes, one per code: a newly registered domain, one new here and a new link domain read NEW_DOMAIN, a jump over the usual day SIZE_JUMP; blocklist findings appear only in findings. Prefer findings.'),
  findings: z.array(z.object({ code: z.enum(READINESS_REASONS), message: z.string() })).optional().describe('Every finding behind the verdict, with its own code: NEW_REGISTRATION (registered recently, from public registry data), NEW_HERE (registered long ago, new to this workspace), NEW_DOMAIN (added recently, registration not known), USUAL_JUMP, NEW_LINK_DOMAIN, BLOCKLISTED_BEFORE (an earlier send drew replies naming a blocklist and none has finished without since), BLOCKLIST_UNCOUNTED (a recent send\'s blocklist replies aren\'t counted yet, so it isn\'t taken for clean), and the original codes.'),
  domain: z.object({ name: z.string(), firstSeenAt: z.string().nullable().describe('When the From domain (or the domain it is under) was added to this workspace.'), ageDays: z.number().int().nullable().describe('Days since it was added to this workspace: its history here, not its age.'),
    registeredAt: z.string().nullable().optional().describe('When its registrable domain was registered (YYYY-MM-DD), from public registry data; null when not known (never taken for old).'),
    registeredDays: z.number().int().nullable().optional().describe('Days since registeredAt; null when not known.'),
    linkDomain: z.object({ name: z.string().describe('The registrable domain the links go on, when it is not the From domain\'s.'), registeredAt: z.string().nullable(), registeredDays: z.number().int().nullable() }).nullable().optional(),
    dmarc: z.enum(['reject', 'quarantine', 'none', 'missing', 'invalid']).nullable().describe('The DMARC policy last observed; null when not checked yet.'),
    mailFrom: z.enum(['verified', 'pending', 'failed', 'not_configured']).describe('The custom MAIL FROM domain (aligned SPF).'),
    sharedLinkPacing: z.boolean().optional().describe('This campaign shares the link domain’s daily sending allowance.'),
    linkHost: z.enum(['not_configured']).describe('Kept for compatibility, always not_configured: ownLinkHost and linkOrigin say where the links go.'),
    ownLinkHost: z.object({ hostname: z.string().describe('links.<domain>.'), active: z.boolean().describe('true: the links go there. false: it isn\u2019t set up yet, so they go on linkOrigin (the link domain) meanwhile.') }).nullable()
      .describe('The domain\'s own link host, when this workspace has them; null without one.'),
    linkOrigin: z.string().nullable().describe('Where this campaign\'s links (its unsubscribe link, the text part\'s, List-Unsubscribe and linked images) go if it launches now: the domain\'s own link host when active, else the link domain (Hosted) or this installation\'s own origin. Null when the launch would be refused for want of one (the workspace\'s sending is paused, or no link host for the domain). A launch on the link domain moves to the domain\'s own host for the copies made once that is active.') }),
  history: z.object({ workspace: HistoryFigures.describe('Every kind of mail the workspace sent; largestSend counts campaigns.'), domain: HistoryFigures.describe('Campaigns from this From domain.') }),
  list: z.object({ recipients: z.number().int(), risky: z.number().int().describe('Risky contacts the send skips.'),
    neverMailed: z.number().int().nullable().describe('Recipients who joined the list since it was last sent to (or ever, when it never was) and have no open or click on record; null when counting took too long.'),
    createdAt: z.string().nullable(), lastSentAt: z.string().nullable().describe('When a campaign last went to this list.'),
    lastImport: z.object({ at: z.string(), contacts: z.number().int(), consent: z.string().nullable().describe('The consent evidence it was imported with, if any.') }).nullable() }),
  sizeJump: z.number().nullable().describe('This send ÷ the largest campaign its domain sent in the last 90 days; null without one.'),
  usualJump: z.number().nullable().optional().describe('This send ÷ the workspace\'s usual day (history.workspace.usualDay); null without one.'),
  plan: z.object({ batches: z.array(z.number().int()).describe('Recipients per day, in order: one batch a day, the most engaged first and never-mailed last.'),
    firstBatch: z.object({ size: z.number().int().describe('Recipients the first day starts with.'), waitMinutes: z.number().int().describe('Minutes it then waits for their bounces and rejections before the rest of the day\'s batch.') }).nullable().optional().describe('The first day\'s small batch and wait, inside its batch; null when the first day is small already.'),
    seconds: z.number().int().nullable().describe('How long the plan takes from its start, the hourly ramp included.') }).nullable().describe('The recommended daily batches; null when one day covers everyone.'),
  required: z.object({ by: z.enum(['NEW_DOMAIN', 'SIZE_JUMP']).describe('Kept as it was: a newly registered domain reads NEW_DOMAIN and a blocklist SIZE_JUMP. reason says which.'),
    reason: z.enum(['NEW_REGISTRATION', 'BLOCKLISTED', 'NEW_DOMAIN', 'SIZE_JUMP']).optional().describe('What requires the ramp. BLOCKLISTED: mail from this From domain or with these links drew replies naming a blocklist and no send has finished without any since; a consent confirmation does not waive it.'), maxPerDay: z.number().int().describe('The largest daily limit that counts as a ramp: the plan\'s first day.') }).nullable(),
}).describe('Whether this campaign is ready to send as it is: its domain, its sender\'s history, its list and how much larger it is than before, with a verdict and a plan. Hosted shared sending with live SES can require the plan; elsewhere it is advice.').openapi('CampaignReadiness');
const AudienceCounts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int(),
  risky: z.number().int().describe('Contacts who could receive it but are flagged as risky (a disposable inbox, a mistyped provider, a role address, an address known to be undeliverable): the send skips them. Not in eligible.'),
  riskyByReason: RiskBreakdown.shape.byReason,
  topicExcluded: z.number().int().optional().describe('With a topic: the subscribed contacts it leaves out (who opted out of it, or for a topic only people who opt in get, who didn\u2019t). Counted in unsubscribed, not in eligible.'),
  approximate: z.literal(true).optional().describe('The topic\u2019s effect on this list couldn\u2019t be counted in time: eligible and topicExcluded are estimated from the workspace\u2019s choices about the topic. Sending counts it exactly.'),
  readiness: CampaignReadiness.nullable().optional().describe('With readiness=true: the send review of a marketing campaign with a sender; null for a required notice or a draft without a sender.') }).describe('Live counts for the saved audience: matched contacts, those eligible for marketing, and the suppressed, unsubscribed or risky remainder. For a required notice everyone not suppressed or risky is eligible and unsubscribed is 0. Read-only; sending freezes its own snapshot and rechecks consent at dispatch.').openapi('CampaignAudienceCounts');

const CampaignUpdate = z.object({ revision: z.number().int().positive(), draft: z.object({ ...CampaignInput.shape, region: Region.optional().describe('Omit to keep the current region selection. An unpinned regional MX draft follows its From domain.') }).strict() }).strict().openapi('CampaignUpdateInput');
const CampaignArchive = z.object({ archived: z.boolean() }).strict().openapi('CampaignArchiveInput');
const CampaignContentGuide = z.object({ format: z.literal('markdown'), markdown: z.string() }).openapi('CampaignContentGuide');
const CampaignPreview = z.object({ html: z.string().describe('Complete rendered email document; empty when the draft has no content.'), text: z.string() }).openapi('CampaignPreview');
const CampaignPreviewImage = z.object({ data: z.string().describe('Canonical base64 PNG screenshot.'), mimeType: z.literal('image/png') }).openapi('CampaignPreviewImage');
const Pacing = z.object({ perDay: z.number().int().min(100).max(10000000).nullable().optional().describe('Release at most this many recipients per rolling 24-hour window. Omit or null for no daily cap. Delivery always also respects the SES 24-hour quota.'), autoPause: z.boolean().default(true).describe('Pause automatically if the bounce rate exceeds 2% (after 1,000 accepted) or the complaint rate exceeds 0.08% (after 5,000 accepted). Hosted shared sending requires true; false is rejected.'),
  rateShare: z.number().min(0.05).max(1).optional().describe('Maximum fraction of the SES per-second send rate this campaign may use; the rest stays free for transactional mail and other campaigns. Defaults to 0.5 for paced campaigns; campaigns sent without pacing use the full rate.'),
  plan: z.literal('recommended').optional().describe('Send in the daily batches previewCampaignAudience recommends (readiness.plan), worked out again at launch: the most engaged contacts first, never-mailed last. Not with perDay.') }).strict()
  .refine(v => !(v.plan && v.perDay != null), { message: 'Choose the recommended plan or a daily limit, not both.', path: ['perDay'] }).openapi('CampaignPacing');
const ConsentConfirmation = z.object({ confirmed: z.literal(true), source: z.string().trim().min(RAMP.consent.minLength).max(RAMP.consent.maxLength).describe('Where this list\'s consent comes from, for example "Signed up at checkout on our site since 2023".') }).strict()
  .describe('The sender confirms everyone on the list agreed to this mail, and where that consent comes from. Lets a send the review requires a ramp for (readiness.verdict ramp_required) go out without the plan. Stored with the campaign, with who and when, and in the workspace\'s Activity. An agent asks the person first.').openapi('CampaignConsentConfirmation');
const CampaignSend = z.object({ revision: z.number().int().positive(), pacing: Pacing.optional(), consent: ConsentConfirmation.optional(),
  confirmRequiredNotice: z.literal(true).optional().describe('Required for a required notice (422 REQUIRED_NOTICE_UNCONFIRMED without it): the sender confirms it is a required notice with no promotion. Recorded with who and when. An agent asks the person first.') }).strict().openapi('CampaignSendInput');
const CampaignSchedule = z.object({ ...CampaignSend.shape, scheduledAt: z.string().datetime({ offset: true }) }).strict().openapi('CampaignScheduleInput');
const CampaignQueued = z.object({ id: z.string(), state: z.literal('preparing'), queued: z.number().int().describe('Recipients expected (exact for lists up to 5,000 members and unsegmented lists once list counts are enabled; may be 0 if an uncounted large list exceeds the 200 ms launch budget without a prior preview); delivery.total is authoritative once the audience is frozen.'), scheduledAt: z.string().nullable(), simulated: z.boolean(),
  risky: RiskBreakdown.nullable().default(null).describe('Recipients the send skips as risky contacts, by reason: exact when queued is; null when a large audience could not be counted at launch.'),
  readiness: CampaignReadiness.nullable().default(null).describe('The send review as of the launch (list.neverMailed is not counted then); null for a required notice.') }).openapi('CampaignQueued');
const CampaignCanceled = z.object({ id: z.string(), state: z.literal('canceled'), canceled: z.number().int(), inFlight: z.number().int() }).openapi('CampaignCanceled');
const TestCampaign = z.object({ to: Address, data: Data }).strict().openapi('CampaignTestInput');
export type SendRequest = z.infer<typeof SendInput>;
const now = () => new Date().toISOString();
// Metadata routes must not materialize HTML, raw MIME or template data from the immutable snapshot.
// Only the campaign relation or an explicit snapshot value proves this was not a reply.
export const sentUntrustedContent = sql<boolean>`${emails.campaignId} IS NULL AND ${emails.snapshot}->'untrustedContent' IS DISTINCT FROM 'false'::jsonb`;
const emailColumns = {
  untrustedContent: sentUntrustedContent,
  id: emails.id, region: emails.region, campaignId: emails.campaignId,
  from: emails.from, fromName: sql<string | null>`coalesce(${emails.snapshot}->>'fromName',CASE WHEN ${emails.reviewId} IS NOT NULL THEN (SELECT draft->>'fromName' FROM sending_campaign_reviews cr WHERE cr.id=${emails.reviewId} AND cr.workspace_id=${emails.workspaceId}) END)`, kind: sql<'transactional' | 'marketing'>`${emails.snapshot}->>'kind'`,
  to: emails.to, cc: emails.cc, bcc: emails.bcc, subject: emails.subject, status: emails.status,
  providerId: emails.providerId, simulated: emails.simulated, attemptStartedAt: emails.attemptStartedAt,
  errorCode: emails.errorCode, suppressionReason: emails.suppressionReason, scheduledAt: emails.scheduledAt, createdAt: emails.createdAt, updatedAt: emails.updatedAt,
};
// A waiting scheduled send reads queued with scheduled true: Email's status keeps its published values.
function emailView(row: Omit<z.input<typeof Email>, 'status' | 'scheduled'> & { status: EmailStatus }) {
  return Email.parse({ ...row, status: row.status === 'scheduled' ? 'queued' : row.status, scheduled: row.status === 'scheduled' });
}
// Subjects can carry unsubscribe capability tokens; like getEmailDetail and getEmailContent, only manage callers read them.
export function listedSubject<T extends { subject: string }>(a: Pick<Actor, 'permissions'>, row: T): T { return a.permissions.includes('manage') ? row : { ...row, subject: redactCapabilityText(row.subject) }; }
// Draft sync polling reads only state columns, without materializing drafts or aggregating email counts.
const campaignStateColumns = {
  id: campaigns.id, revision: campaigns.revision, updatedAt: campaigns.updatedAt,
  state: campaigns.state, scheduledAt: campaigns.scheduledAt, archivedAt: campaigns.archivedAt,
};
// Project the bounded list draft in PostgreSQL, before driver JSON parsing or application allocation.
const { draft: _draft, stats: _stats, ...campaignRowColumns } = getTableColumns(campaigns);
const campaignSummaryColumns = {
  ...campaignRowColumns,
  draft: sql<z.infer<typeof CampaignDraftSummary>>`jsonb_strip_nulls(jsonb_build_object(
    'name', ${campaigns.draft}->'name', 'region', ${campaigns.draft}->'region', 'from', ${campaigns.draft}->'from',
    'fromName', ${campaigns.draft}->'fromName', 'subject', ${campaigns.draft}->'subject', 'previewText', ${campaigns.draft}->'previewText',
    'audience', jsonb_build_object('listId', ${campaigns.draft}->'audience'->'listId', 'segmentId', ${campaigns.draft}->'audience'->'segmentId')
  ))`,
};
function campaignUrl(runtime: Runtime, row: { id: string; state: CampaignState; expanded: number }) {
  const url = new URL(`/campaigns/${encodeURIComponent(row.id)}/${campaignEditable(row) ? 'edit' : 'review'}`, runtime.config.publicUrl);
  return url.href;
}
type CampaignRow = Omit<typeof campaigns.$inferSelect, 'draft' | 'stats'> & { draft: unknown };
/** How long campaign detail reuses a large active campaign's per-status counts. The dashboard polls detail every 3 s while a campaign sends, and each count reads every recipient's email record. */
export const CAMPAIGN_PROGRESS_CACHE_SECONDS = 20;
/** Below this many recipients the count is cheap, so detail stays exact. */
export const CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS = 10_000;
const CAMPAIGN_PROGRESS_SCOPE = `while a campaign of at least ${CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS.toLocaleString('en-US')} recipients is preparing, scheduled, sending or paused`;
const CAMPAIGN_PROGRESS_NOTE = `For every credential, counts may be up to ${CAMPAIGN_PROGRESS_CACHE_SECONDS} seconds old ${CAMPAIGN_PROGRESS_SCOPE}; state and delivery are always current. Counts are exact for smaller campaigns, once a campaign is done, canceled or failed, and in the campaign that pause, resume and other changes return.`;
// A list read (read without detail) carries no send estimate; getCampaign and the responses about one campaign do.
async function campaignViews<T extends CampaignRow>(runtime: Runtime, a: Actor, rows: T[], read?: { origin: string; detail?: boolean }, db: DbExecutor = runtime.db) {
  if (!rows.length) return [];
  const estimates = !read || read.detail ? await sendEstimates(runtime, db, a, rows) : null;
  let grouped: { campaignId: string | null; status: EmailStatus; count: number }[];
  if (a.domains.length) {
    grouped = [];
  } else if (await talliesEnabled(db)) {
    // Exact at read time from sending_campaign_tallies (< 2 ms at any scale, never cached, never scans sending_emails).
    const ids = rows.map(row => row.id);
    const { rows: tallied } = await db.execute<{ campaignId: string; status: EmailStatus; count: number }>(sql`SELECT
      campaign_id AS "campaignId", status, sum(email_count)::int AS count
      FROM sending_campaign_tallies
      WHERE workspace_id = ${a.workspaceId} AND campaign_id = ANY(${sql.param(ids)}::text[])
      GROUP BY 1, 2 HAVING sum(email_count) > 0`);
    grouped = tallied;
  } else {
    // Fallback when tally triggers are disabled (emergency undo): live GROUP BY with progress cache.
    const load = async () => db.select({ campaignId: emails.campaignId, status: emails.status, count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), inArray(emails.campaignId, rows.map(row => row.id)))).groupBy(emails.campaignId, emails.status);
    const cached = async (scope: unknown[], ttlSeconds?: number) => (await cachedDashboardRead(read!.origin, JSON.stringify(scope), load, ttlSeconds)).value;
    const [one] = rows, progress = read?.detail && rows.length === 1 && (CAMPAIGN_ACTIVE as readonly string[]).includes(one!.state) && one!.total >= CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS;
    grouped = progress ? await cached(['campaign-progress', a.workspaceId, one!.id, one!.reviewId], CAMPAIGN_PROGRESS_CACHE_SECONDS)
      : read && !read.detail && a.credential === 'dashboard' ? await cached(['campaign-counts', a.workspaceId, rows.map(r => [r.id, r.updatedAt])]) : await load();
  }
  const lag = rows.some(row => row.reviewId && ['preparing', 'sending', 'paused'].includes(row.state))
    ? await activeFeedbackLag(db).catch(() => null)
    : null;
  return rows.map(row => {
    const counts = emptyCounts();
    for (const item of grouped) if (item.campaignId === row.id) { counts.byStatus[item.status] = Number(item.count); counts.total += Number(item.count); }
    return { ...row, url: campaignUrl(runtime, row), counts, delivery: deliveryView(row, lag), ...estimates ? { sendEstimate: estimates.get(row.id) ?? null } : {} };
  });
}
/**
 * Campaign.sendEstimate for each row: a draft (or a failed launch that released nobody) from its last audience count,
 * without pacing; a launched campaign from what it has left, its pacing and where it is on the ramp. One statement for
 * the region's planned rate and whether the ramp applies, and one more for the workspace's history while the campaign
 * has not taken its place on the ramp yet (its first release decides it).
 */
async function sendEstimates(runtime: Runtime, db: DbExecutor, a: Actor, rows: CampaignRow[]) {
  const estimates = new Map<string, z.infer<typeof SendEstimate> | null>();
  for (const row of rows) {
    const editable = campaignEditable(row), held = !editable && (row.state === 'paused' || row.state === 'failed');
    if (!editable && !held && !(CAMPAIGN_RUNNING as readonly string[]).includes(row.state)) { estimates.set(row.id, null); continue; }
    const region = (row.draft as Pick<CampaignDraft, 'region'>).region;
    const [info] = (await db.execute<{ rate: number; hosted: boolean }>(sql`SELECT coalesce((SELECT max_send_rate FROM ${limitsTable(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)::float8 AS rate,
      ${runtime.config.multiTenant ? sharedConnection(a.workspaceId) : sql`false`} AS hosted`)).rows;
    const rate = Number(info?.rate ?? 0);
    let ramp: RampAt | null = null;
    if (info?.hosted && !(editable ? isSimulatedSes(runtime) : row.simulated)) {
      const decided = editable ? null : row.rampStep;
      const step = decided ?? rampStart(await rampHistory(db, a.workspaceId));
      const startedAt = decided !== null && row.rampWindowStartedAt ? Date.parse(row.rampWindowStartedAt) : null;
      if (step < RAMP.steps.length) ramp = { step, startedAt, released: startedAt === null ? 0 : Math.max(0, row.expanded - row.rampFrom) };
    }
    const recipients = editable ? row.audienceEstimate : Math.max(0, row.total - row.expanded);
    // As of the campaign's last change (a draft's as a duration), so reading it twice gives the same answer.
    const scheduled = row.scheduledAt && row.expanded === 0 ? Date.parse(row.scheduledAt) : NaN, start = editable ? 0 : Math.max(Date.parse(row.updatedAt), scheduled || 0);
    const finish = recipients === null ? null : estimateFinish({ recipients, start, ratePerSecond: rate,
      ...editable ? {} : { rateShare: row.rateShare, perDay: row.pacePlan?.length ? row.pacePlan : row.pacePerDay, day: { startedAt: row.windowStartedAt ? Date.parse(row.windowStartedAt) : null, released: row.windowExpanded, index: row.windowIndex } }, ramp });
    estimates.set(row.id, SendEstimate.parse({ recipients, ratePerSecond: rate > 0 ? rate : null, seconds: finish === null ? null : Math.round((finish - start) / 1000),
      finishAt: finish === null || editable || held ? null : new Date(finish).toISOString(),
      ramp: ramp && { step: ramp.step + 1, steps: RAMP.steps.length, ceilingPerHour: RAMP.steps[ramp.step]!.ceilingPerHour, startedAt: ramp.startedAt === null ? null : new Date(ramp.startedAt).toISOString(), released: ramp.released } }));
  }
  return estimates;
}
/**
 * The send review of a marketing campaign (CampaignReadiness, RAMP.readiness): the From domain (when this workspace added
 * it, its DMARC and MAIL FROM as last observed), the workspace's and the domain's history (campaign accepts from the tallies,
 * the workspace's last 30 days from the hourly metrics), the list (when it was made, last sent to and last imported into,
 * with that import's consent evidence) and how much larger this send is, then the verdict and the plan. Two statements;
 * `audience` brings the recipients. `lastSent`: when the list was last sent to, if the caller already knows.
 */
async function sendReadiness(runtime: Runtime, db: DbExecutor, a: Actor, row: { id: string; draft: CampaignDraft },
  audience: { recipients: number; matched: number | null; risky: number; neverMailed: number | null; lastSent: string | null }) {
  const domain = (row.draft.from.split('@')[1] ?? '').toLowerCase(), listId = row.draft.audience?.listId ?? null, r = RAMP.readiness, c = RAMP.check;
  // Where this campaign's links go (src/link-domains.ts): a blocklist lists the link domain as readily as the sender's.
  const links = await linkReview(runtime, db, a.workspaceId, row.draft.from), linkHost = links.origin ? new URL(links.origin).hostname.toLowerCase() : null;
  // Clean: within the ramp check's bounce and complaint lines, no reply named a blocklist in the days it went out, and the
  // delivery history has counted it (src/delivery-history.ts), so a send not counted yet is never taken for clean.
  // Without the private ramp lines (NIGHTMAIL_RAMP) the review is today's: clean is the bounce and complaint lines alone.
  const tuned = !!runtime.config.rampLines;
  const clean = sql`bounced<=accepted*${c.bounceRate}::float8 AND (complained<${c.complaints}::int OR complained<=accepted*${c.complaintRate}::float8)${tuned ? sql` AND NOT blocked AND counted` : sql``}`;
  const [f] = (await db.execute<{ first_seen: string | null; dmarc: string | null; mail_from: string | null; ws_largest: number; dom_largest: number; dom_clean: number;
    dom_accepted: number; dom_bounced: number; dom_complained: number; ws_accepted: number | null; ws_bounced: number | null; ws_complained: number | null; usual_day: number | null; first_sent: string | null;
    blocked_day: string | null; last_clean_done: string | null; uncounted: boolean;
    list_created: string | null; last_import: { at: string; contacts: number; consent: string | null } | null; rate: number; hosted: boolean }>(sql`WITH dom AS (
      SELECT dc.created_at, dc.identity->'dmarc'->>'status' AS dmarc, dc.identity->'ses'->'MailFromAttributes'->>'MailFromDomainStatus' AS mail_from FROM domain_claims dc
      WHERE dc.workspace_id=${a.workspaceId} AND (dc.name=${domain} OR right(${domain}, length(dc.name)+1)='.'||dc.name) ORDER BY length(dc.name) DESC LIMIT 1
    ), sent AS MATERIALIZED (
      SELECT c.created_at, c.state, lower(split_part(c.draft->>'from','@',2)) AS domain, t.accepted, t.bounced, t.complained,
        c.updated_at <= coalesce((SELECT cursor_at FROM delivery_history_state WHERE id='rollup'), '-infinity') AS counted,
        EXISTS (SELECT 1 FROM delivery_blocklist_daily b WHERE b.workspace_id=c.workspace_id AND b.from_domain=lower(split_part(c.draft->>'from','@',2))
          AND b.day BETWEEN c.created_at::date AND c.created_at::date+3 AND b.rejections>0) AS blocked FROM sending_campaigns c
      CROSS JOIN LATERAL (SELECT coalesce(sum(accepted),0)::float8 AS accepted, coalesce(sum(bounced),0)::float8 AS bounced, coalesce(sum(complained),0)::float8 AS complained
        FROM sending_campaign_tallies t WHERE t.workspace_id=c.workspace_id AND t.campaign_id=c.id AND NOT t.simulated) t
      WHERE c.workspace_id=${a.workspaceId} AND c.id<>${row.id} AND NOT c.simulated AND c.expanded>0 AND c.created_at>now()-make_interval(days=>${r.lookbackDays}::int)
    ), hours AS (
      SELECT sum(accepted)::float8 AS a, sum(bounced)::float8 AS b, sum(complained)::float8 AS c FROM (SELECT hour, sum(accepted) AS accepted, sum(bounced) AS bounced, sum(complained) AS complained
        FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND hour>=now()-make_interval(days=>${r.windowDays}::int) GROUP BY hour HAVING sum(simulated)=0) x
    ), days AS (
      SELECT date_trunc('day', hour) AS day, sum(accepted)::float8 AS a FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND hour>=now()-interval '14 days'
      GROUP BY 1 HAVING sum(simulated)=0 AND sum(accepted)>0
    )
    SELECT (SELECT created_at::text FROM dom) AS first_seen, (SELECT dmarc FROM dom) AS dmarc, (SELECT mail_from FROM dom) AS mail_from,
      coalesce((SELECT max(accepted) FROM sent),0)::int AS ws_largest, coalesce((SELECT max(accepted) FROM sent WHERE domain=${domain}),0)::int AS dom_largest,
      coalesce((SELECT max(accepted) FROM sent WHERE domain=${domain} AND ${clean}),0)::int AS dom_clean,
      coalesce((SELECT sum(accepted) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_accepted,
      coalesce((SELECT sum(bounced) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_bounced,
      coalesce((SELECT sum(complained) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_complained,
      (SELECT a FROM hours)::bigint AS ws_accepted, (SELECT b FROM hours)::bigint AS ws_bounced, (SELECT c FROM hours)::bigint AS ws_complained,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a) FROM days)::bigint AS usual_day,
      (SELECT min(hour)::text FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND accepted>0 AND simulated=0) AS first_sent,
      (SELECT max(day)::text FROM delivery_blocklist_daily WHERE workspace_id=${a.workspaceId} AND (from_domain=${domain} OR link_host=${linkHost ?? ''}) AND day>current_date-90 AND rejections>0) AS blocked_day,
      (SELECT max(created_at)::text FROM sent WHERE domain=${domain} AND state='done' AND ${clean}) AS last_clean_done,
      EXISTS (SELECT 1 FROM sent WHERE domain=${domain} AND NOT counted) AS uncounted,
      (SELECT created_at::text FROM audience_lists WHERE workspace_id=${a.workspaceId} AND id=${listId}) AS list_created,
      (SELECT jsonb_build_object('at',i.created_at,'contacts',i.imported,'consent',(SELECT ca.evidence FROM audience_consent_audit ca WHERE ca.workspace_id=i.workspace_id
          AND ca.contact_id=i.sample_contact_ids[1] AND ca.import_id=i.id LIMIT 1))
        FROM audience_imports i WHERE i.workspace_id=${a.workspaceId} AND i.list_id=${listId} AND i.status='committed' ORDER BY i.created_at DESC LIMIT 1) AS last_import,
      coalesce((SELECT max_send_rate FROM ${limitsTable(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${row.draft.region}),0)::float8 AS rate,
      ${runtime.config.multiTenant ? sharedConnection(a.workspaceId) : sql`false`} AS hosted`)).rows;
  const live = !!f!.hosted && !isSimulatedSes(runtime), ageDays = f!.first_seen ? Math.floor((Date.now() - Date.parse(f!.first_seen)) / DAY_MS) : null;
  // How old the From domain and the domain its links go on are on the internet (src/domain-age.ts), apart from how long they have sent here.
  const age = await wrapModuleLoad(() => import('./domain-age.js'));
  const fromRoot = await age.registrableRoot(domain), linkRoot = await age.registrableRoot(links.origin ? new URL(links.origin).hostname : null);
  const registered = await age.registeredDays(db, [fromRoot, linkRoot]), reg = fromRoot ? registered.get(fromRoot) ?? null : null;
  const link = linkRoot && linkRoot !== fromRoot ? { name: linkRoot, registeredAt: registered.get(linkRoot)?.at ?? null, registeredDays: registered.get(linkRoot)?.days ?? null } : null;
  const usualDay = Number(f!.usual_day ?? 0), firstSentDays = f!.first_sent ? Math.floor((Date.now() - Date.parse(f!.first_sent)) / DAY_MS) : null;
  const dmarc = f!.dmarc && ['reject', 'quarantine', 'none', 'missing', 'invalid'].includes(f!.dmarc) ? f!.dmarc as 'reject' | 'quarantine' | 'none' | 'missing' | 'invalid' : null;
  const n = audience.recipients, wsAccepted = Number(f!.ws_accepted ?? 0);
  const judged = judgeReadiness({ recipients: n, matched: audience.matched, risky: audience.risky, neverMailed: audience.neverMailed, domainAgeDays: ageDays,
    dmarc: dmarc === null ? null : !['missing', 'invalid'].includes(dmarc), largestSend: f!.dom_largest, largestCleanSend: f!.dom_clean,
    accepted: wsAccepted, bounced: Number(f!.ws_bounced ?? 0), complained: Number(f!.ws_complained ?? 0), enforced: live,
    registeredDays: reg?.days ?? null, linkRegisteredDays: link?.registeredDays ?? null, usualDay, lines: tuned ? rampLines(runtime.config.rampLines) : undefined,
    blocklisted: !!f!.blocked_day && !(f!.last_clean_done && f!.last_clean_done.slice(0, 10) > f!.blocked_day), blocklistUncounted: !!f!.uncounted });
  const batches = judged.plan, first = batches[0] ?? 0, fmt = (v: number) => v.toLocaleString('en-US'), share = (v: number, of: number) => `${(100 * v / of).toFixed(of && v / of < 0.1 ? 1 : 0)}%`;
  const rampAt = live ? rampStart(await rampHistory(db, a.workspaceId)) : RAMP.steps.length;
  const seconds = batches.length > 1 ? estimateFinish({ recipients: n, start: 0, ratePerSecond: Number(f!.rate), perDay: batches, ramp: rampAt < RAMP.steps.length ? { step: rampAt, startedAt: null, released: 0 } : null }) : null;
  const ago = (days: number | null) => days === null ? 'recently' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${fmt(days)} days ago`;
  const month = (at: string | null) => at ? new Date(at + 'T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'an unknown date';
  const messages: Record<ReadinessReason, () => string> = {
    NEW_DOMAIN: () => `${domain} was added ${ago(ageDays)}, and when it was registered isn't known yet.`,
    NEW_HERE: () => `${fromRoot ?? domain} was registered in ${month(reg?.at ?? null)}; it was added here ${ago(ageDays)}${firstSentDays !== null && firstSentDays !== ageDays ? ` and this workspace first sent mail ${ago(firstSentDays)}` : ''}.`,
    NEW_REGISTRATION: () => `${fromRoot ?? domain} was registered ${ago(reg?.days ?? null)} (${month(reg?.at ?? null)}). Mailbox providers distrust mail from a domain that new.`,
    NEW_LINK_DOMAIN: () => `Its links go on ${link?.name}, registered ${ago(link?.registeredDays ?? null)}.`,
    BLOCKLISTED_BEFORE: () => `Replies to this workspace's mail ${linkHost && linkHost !== domain ? `from ${domain} or with links on ${linkHost}` : `from ${domain}`} named a blocklist on ${f!.blocked_day}, and no send has finished without one since.`,
    BLOCKLIST_UNCOUNTED: () => `The last send's blocklist replies aren't counted yet, so it isn't treated as a clean send.`,
    USUAL_JUMP: () => `This send is ${fmt(Math.round(judged.usualJump!))} times this workspace's usual day (${fmt(usualDay)} emails).`,
    SIZE_JUMP: () => `This send is ${fmt(Math.round(judged.jump!))} times the largest campaign ${domain} sent in the last ${r.lookbackDays} days (${fmt(f!.dom_largest)}).`,
    NO_HISTORY: () => f!.dom_largest ? `${domain}'s largest campaign in the last ${r.lookbackDays} days went to ${fmt(f!.dom_largest)} people.` : `${domain} hasn't sent a campaign in the last ${r.lookbackDays} days.`,
    RISKY_LIST: () => `${fmt(audience.risky)} risky addresses (${share(audience.risky, audience.matched ?? 1)} of the list) will be skipped.`,
    NEVER_MAILED: () => `${share(audience.neverMailed ?? 0, n)} of these recipients haven't been mailed before.`,
    NO_DMARC: () => `${domain} has no DMARC record.`,
    BOUNCES: () => `${share(Number(f!.ws_bounced), wsAccepted)} of the last ${r.windowDays} days' mail bounced.`,
    COMPLAINTS: () => `${share(Number(f!.ws_complained), wsAccepted)} of the last ${r.windowDays} days' mail was marked as spam.`,
  };
  const fb = judged.firstBatch, opening = fb ? ` The first day starts with ${fmt(fb.size)}, then waits ${fb.waitMinutes} minutes for their bounces and rejections before the rest.` : '';
  const headline = judged.requiredBy === 'BLOCKLISTED' ? `Mail from this sender drew replies naming a blocklist. Until a send finishes without any, sends go out in batches: we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'NEW_REGISTRATION' ? `This domain was registered recently and this list is much larger than anything it has sent. Mailbox providers block new domains that send to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'NEW_DOMAIN' ? `This domain is new and this list is much larger than anything it has sent. Mailbox providers block new senders who send to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'SIZE_JUMP' ? `This list is much larger than anything this domain has sent. Mailbox providers block senders who jump to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.verdict === 'ramp_recommended' && batches.length > 1 ? `Send this over ${batches.length} days: ${fmt(first)} of the most engaged recipients first, people never mailed before last.` : null;
  const summary = headline && headline + opening;
  const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;
  const findings = judged.reasons.map(code => ({ code, message: messages[code]() }));
  const legacy = findings.flatMap(f => { const code = (LEGACY_READINESS_REASONS as readonly string[]).includes(f.code) ? f.code as (typeof LEGACY_READINESS_REASONS)[number] : LEGACY_REASON[f.code]; return code ? [{ code, message: f.message }] : []; })
    .filter((f, i, all) => all.findIndex(g => g.code === f.code) === i);
  return CampaignReadiness.parse({ verdict: judged.verdict, summary, reasons: legacy, findings,
    domain: { name: domain, firstSeenAt: f!.first_seen ? new Date(f!.first_seen).toISOString() : null, ageDays, dmarc,
      mailFrom: f!.mail_from === 'SUCCESS' ? 'verified' : f!.mail_from === 'PENDING' ? 'pending' : f!.mail_from === 'FAILED' || f!.mail_from === 'TEMPORARY_FAILURE' ? 'failed' : 'not_configured',
      ...(!row.draft.requiredNotice && runtime.config.linkHost && runtime.config.linkWarmup && links.origin === `https://${runtime.config.linkHost}` ? { sharedLinkPacing: true } : {}),
      linkHost: 'not_configured', ownLinkHost: links.own, linkOrigin: links.origin, registeredAt: reg?.at ?? null, registeredDays: reg?.days ?? null, linkDomain: link },
    history: { workspace: { largestSend: f!.ws_largest, firstSentAt: f!.first_sent ? new Date(f!.first_sent).toISOString() : null, usualDay, sent: wsAccepted, bounceRate: rate(Number(f!.ws_bounced ?? 0), wsAccepted), complaintRate: rate(Number(f!.ws_complained ?? 0), wsAccepted) },
      domain: { largestSend: f!.dom_largest, sent: f!.dom_accepted, bounceRate: rate(f!.dom_bounced, f!.dom_accepted), complaintRate: rate(f!.dom_complained, f!.dom_accepted) } },
    list: { recipients: n, risky: audience.risky, neverMailed: audience.neverMailed, createdAt: f!.list_created ? new Date(f!.list_created).toISOString() : null,
      lastSentAt: audience.lastSent ? new Date(audience.lastSent).toISOString() : null,
      lastImport: f!.last_import ? { at: new Date(f!.last_import.at).toISOString(), contacts: f!.last_import.contacts, consent: f!.last_import.consent } : null },
    sizeJump: judged.jump === null ? null : Math.round(judged.jump * 10) / 10, usualJump: judged.usualJump === null ? null : Math.round(judged.usualJump * 10) / 10,
    plan: batches.length > 1 ? { batches, seconds: seconds === null ? null : Math.round(seconds / 1000), firstBatch: judged.firstBatch } : null,
    required: judged.requiredBy ? { by: judged.requiredBy === 'NEW_REGISTRATION' ? 'NEW_DOMAIN' : judged.requiredBy === 'BLOCKLISTED' ? 'SIZE_JUMP' : judged.requiredBy, reason: judged.requiredBy, maxPerDay: first } : null });
}
// Per-statement limits of the reads a dashboard repeats (budgetedRead): a list walk or aggregate gets 5 seconds; the
// campaign detail's status counts, polled every few seconds while it sends and read through one campaign's index, get 3.
const READ_LIMIT = { emails: 5, campaign: 3, campaignStats: 5 } as const;
export async function pageBinding(a: Actor, resource: string, query: Record<string, unknown>) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  // This fixed field is part of the hash in already-issued email and campaign cursors.
  return (await digest(canonical({ workspaceId: a.workspaceId, environment: 'live', resource, filters }))).slice(0, 24);
}

export const scope = (table: { workspaceId: AnyPgColumn }, a: Pick<Actor, 'workspaceId'>) => eq(table.workspaceId, a.workspaceId);
// A key restricted to sender domains reads only mail sent from those domains or their subdomains (L2).
export function senderDomainWhere(column: AnyPgColumn | SQL, allowed: readonly string[] | SQL) {
  if (!(allowed instanceof SQL) && !allowed.length) return undefined;
  // Reverse the domain with its label separator: exact names and descendants
  // occupy one contiguous C-collation index range ('.' immediately before '/').
  const domain = sql`(reverse(lower(split_part(${column}, '@', 2))) || '.') COLLATE "C"`;
  if (allowed instanceof SQL) return sql`EXISTS (SELECT FROM jsonb_array_elements_text(${allowed}) d(name)
    WHERE ${domain} >= reverse(lower(d.name)) || '.' AND ${domain} < reverse(lower(d.name)) || '/')`;
  return or(...allowed.map(value => { const prefix = [...value.toLowerCase()].reverse().join(''); return sql`(${domain} >= ${prefix+'.'} AND ${domain} < ${prefix+'/'})`; }));
}
// Tests are transactional for dispatch and have no campaign_id. Require an explicit JSON null:
// a missing key (SQL NULL) is an old snapshot that might have been a campaign test.
const directDelivery = sql`sending_emails.campaign_id IS NULL AND sending_emails.snapshot->'testCampaignId' = 'null'::jsonb`;
export const mailWhere = (a: Actor, emailId?: string) => and(scope(emails, a), emailId === undefined ? undefined : eq(emails.id, emailId), senderDomainWhere(emails.from, a.domains), a.domains.length ? directDelivery : undefined,
  actorMailAccess(a) ? undefined : sql`NOT ${mailboxMail}`);

// The same asset can legitimately be reused: allow the uploader or a link to an independently
// readable delivery. A link only to a test, a campaign, or ambiguous legacy mail proves nothing.
function domainAttachmentAccess(uploader: SQL, domains: readonly string[] | SQL) {
  return sql`(sending_attachments.uploaded_by = ${uploader} OR EXISTS (
    SELECT FROM sending_attachment_links l JOIN sending_emails ON sending_emails.workspace_id=l.workspace_id AND sending_emails.id=l.owner_id
    WHERE l.workspace_id=sending_attachments.workspace_id AND l.attachment_id=sending_attachments.id AND l.owner_type='email'
    AND ${directDelivery} AND NOT ${mailboxMail} AND ${senderDomainWhere(sql`sending_emails.from_address`, domains)}))`;
}
// An upload belongs to the workspace, so any sender may attach it. One that has gone out only in conversation mail is
// conversation content: a credential without mailbox access reads or reuses it when it uploaded it, or when it is also
// attached to something that credential can read (ordinary mail, a campaign or a review).
function sharedAttachmentAccess(uploader: SQL) {
  const links = sql`sending_attachment_links l WHERE l.workspace_id=sending_attachments.workspace_id AND l.attachment_id=sending_attachments.id`;
  const email = (mailbox: boolean) => sql`(l.owner_type='email' AND EXISTS (SELECT FROM sending_emails WHERE sending_emails.workspace_id=l.workspace_id AND sending_emails.id=l.owner_id AND ${mailbox ? mailboxMail : sql`NOT ${mailboxMail}`}))`;
  return sql`(sending_attachments.uploaded_by = ${uploader}
    OR NOT EXISTS (SELECT FROM ${links} AND (l.owner_type='mailbox' OR ${email(true)}))
    OR EXISTS (SELECT FROM ${links} AND (l.owner_type IN ('campaign','review') OR ${email(false)})))`;
}
// `conversation`: the mail is sent from a mailbox, whose own rules admitted the sender and its attachments.
function scopedAttachment(a: Actor, conversation = false) {
  const uploader = sql`${a.tokenId ?? a.keyId}`;
  return a.domains.length ? domainAttachmentAccess(uploader, a.domains) : conversation || actorMailAccess(a) ? undefined : sharedAttachmentAccess(uploader);
}
export const campaignWhere = (a: Actor, campaignId?: string) => and(scope(campaigns, a), campaignId === undefined ? undefined : eq(campaigns.id, campaignId), senderDomainWhere(sql`${campaigns.draft}->>'from'`, a.domains),
  a.domains.length ? and(eq(campaigns.state, 'draft'), isNull(campaigns.reviewId), sql`${campaigns.draft}->'audience' = '{}'::jsonb`) : undefined);
function keySender(a: Actor, from: string) {
  const domain = from.split('@')[1]!.toLowerCase();
  if (!senderDomainAllowed(a.domains, domain)) throw denied('SENDER_DOMAIN_FORBIDDEN', 'This API key cannot send from this domain or its parent domain.', { permission: 'sendEmail', level: 'on', scope: `domain:${domain}` }, 'from');
}
function draftSender(runtime: Runtime, a: Actor, draft: CampaignDraft) {
  if (!regionalSending(runtime)) region(runtime, draft.region);
  if (!draft.from && a.domains.length) throw denied('SENDER_DOMAIN_FORBIDDEN', 'A domain-restricted key must supply a From address on one of its domains.', { permission: 'sendEmail', level: 'on', scope: 'workspace' }, 'from');
  if (draft.from) keySender(a, draft.from);
  if (a.domains.length && Object.keys(draft.audience).length) throw unrestrictedRequired(a, 'Choosing a campaign audience needs', { permission: 'audience', level: 'write' });
}
// A draft's audience names only this workspace's lists and segments. Another workspace's ID gets the answer of one that
// doesn't exist, the answer the audience gives when it is read (audience.ts audienceConditions), so an ID can't be probed.
// IDs the stored draft already names pass unchecked: a draft outlives a deleted list and must stay editable.
async function draftAudience(db: DbExecutor, a: Actor, audience: CampaignDraft['audience'], stored: CampaignDraft['audience'] = {}) {
  const added = (now: (string | undefined)[], before: (string | undefined)[]) => [...new Set(now.filter((id): id is string => id !== undefined && !before.includes(id)))];
  const listIds = added([audience.listId, ...(audience.excludeListIds ?? [])], [stored.listId, ...(stored.excludeListIds ?? [])]);
  const segmentIds = added([audience.segmentId, ...(audience.excludeSegmentIds ?? [])], [stored.segmentId, ...(stored.excludeSegmentIds ?? [])]);
  if (listIds.length && (await db.select({ id: lists.id }).from(lists).where(and(scope(lists, a), inArray(lists.id, listIds)))).length !== listIds.length) notFound('List');
  if (segmentIds.length && (await db.select({ id: segments.id }).from(segments).where(and(scope(segments, a), inArray(segments.id, segmentIds)))).length !== segmentIds.length) notFound('Segment');
}
async function draftRegion(runtime:Runtime,db:DbExecutor,a:Actor,input:{from:string;region?:string;regionPinned?:boolean},previous?:CampaignDraft) {
  if (!regionalSending(runtime)) return {region:await assertRegionEnabled(db,a.workspaceId,input.region ?? previous?.region),regionPinned:previous?.regionPinned};
  // A whole-draft PATCH often echoes the displayed region. Preserve its provenance, not
  // just its value. Pre-rollout drafts with a sender or a nondefault selection retain it.
  const fallback=runtime.config.regions[0]!;
  const changed=previous!==undefined && input.region!==undefined && input.region!==previous.region;
  const inherited=previous ? previous.regionPinned ?? (!!previous.from || previous.region!==fallback) : input.region!==undefined;
  const pinned=changed || (input.regionPinned ?? inherited);
  if (pinned) {
    const selected=input.region ?? previous?.region ?? fallback;
    if (!regionPattern.test(selected)) throw new ApiError(422,'INVALID_REGION','Use a valid AWS region.','region');
    return {region:selected,regionPinned:true};
  }
  // Draft hints are not send authorization: a pending or disabled closest claim still wins,
  // and an unbound claim shadows its parent. No proof, pool readiness or tenant hold check.
  const host=input.from.split('@')[1]?.toLowerCase();
  const hint=host && (await db.execute<{region:string|null}>(sql`SELECT b.region FROM domain_claims dc LEFT JOIN domain_sending_bindings b USING(workspace_id,name,connection_id)
    WHERE dc.workspace_id=${a.workspaceId} AND right('.'||${host},length(dc.name)+1)='.'||dc.name ORDER BY length(dc.name) DESC LIMIT 1`)).rows[0]?.region;
  return {region:hint || fallback,regionPinned:false};
}
const campaignSendRegion=(runtime:Runtime,draft:CampaignDraft)=>regionalSending(runtime) && draft.regionPinned===false ? undefined : draft.region;
function readyCampaign(draft: CampaignDraft) {
  const parsed = CampaignReady.safeParse(draft);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))];
    throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', `Complete these campaign fields before review: ${fields.join(', ')}.`, fields.join(', '));
  }
  return parsed.data;
}
const keyed = (c: Ctx, a: Actor) => ({ ...idempotentRequest(c), workspaceId: a.workspaceId, actorKeyId: a.keyId });
// A replay is a read, too. A draft can have changed sender since the receipt was saved, and a temporary token may
// share its parent grant's receipt with a narrower domain scope.
const campaignReplay = (a: Actor, campaignId?: string) => async (db: DbExecutor, receipt: { id?: unknown; draft?: CampaignDraft }) => {
  if (!a.domains.length) return;
  if (receipt.draft && (Object.keys(receipt.draft.audience).length || !senderDomainAllowed(a.domains, receipt.draft.from.split('@')[1] ?? ''))) notFound('Campaign');
  const [visible] = await db.select({ id: campaigns.id }).from(campaigns).where(campaignWhere(a, campaignId ?? String(receipt.id)));
  if (!visible) notFound('Campaign');
};
async function findEmail(db: DbExecutor, a: Actor, emailId: string) {
  const [row] = await db.select({ ...getTableColumns(emails), untrustedContent: sentUntrustedContent }).from(emails).where(mailWhere(a, emailId));
  if (!row) notFound('Email');
  return row;
}
async function visibleEmailContent(runtime: Runtime,a: Actor,row: typeof emails.$inferSelect, untrustedContent: boolean) {
  // Sent campaign emails store a stub; queued ones have no body yet (html/text null, as before).
  const s = sentCampaignEmail(row.snapshot) ? await sentCampaignContent(runtime, a, row) : row.snapshot.deferredCampaign && !row.snapshot.attachments
    ? {...row.snapshot,subject:row.subject,attachments:(await runtime.db.execute<{ids:string[]}>(sql`SELECT draft->'attachments' AS ids FROM sending_campaign_reviews WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId}`)).rows[0]?.ids??[]} : row.snapshot;
  const manage = a.permissions.includes('manage');
  // App-owned capabilities only, not a general sanitizer for transactional bearer links.
  // Raw MIME can hide tokens inside encodings/folding; only managers receive that opaque content.
  const visible = (value: string | undefined) => value === undefined ? null : manage ? value : redactCapabilityText(value);
  // Sealed Nightmail notices (forward confirmations, sign-in links) carry a capability meant only for the recipient: withheld from every reader.
  if (row.snapshot.sealed) { const { sealCapabilities } = await import('./mailbox-send.js'); return EmailContent.parse({ untrustedContent, subject: s.subject, html: s.html === undefined ? null : sealCapabilities(s.html), text: s.text === undefined ? null : sealCapabilities(s.text), raw: null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated }); }
  return EmailContent.parse({ untrustedContent, subject: visible(s.subject), html: visible(s.html), text: visible(s.text), raw: manage ? s.raw ?? s.mime ?? null : null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated });
}
// Every reader, whatever its permissions, gets an event's data without the content screen's verdict.
function visibleEmailEvent(a: Actor, row: z.input<typeof Event>) {
  return Event.parse({ ...row, data: withoutVerdict(a.permissions.includes('manage') ? row.data : redactCapabilityData(row.data)) });
}
async function findCampaign(db: DbExecutor, a: Actor, campaignId: string, lock: boolean | 'share' = false) {
  const query = db.select().from(campaigns).where(campaignWhere(a, campaignId));
  const [row] = await (lock ? query.for(lock === 'share' ? 'share' : 'update') : query);
  if (!row) notFound('Campaign');
  return row;
}
// Paced delivery controls. Pausing stops releasing new recipients; mail already queued (a few seconds of
// the send rate) still dispatches. Resume continues from the same frozen position.
type CampaignChange = (db: DbExecutor, a: Actor, campaign: typeof campaigns.$inferSelect) => Promise<void>;
const sendingOnly = (campaign: typeof campaigns.$inferSelect) => { if (!(CAMPAIGN_ACTIVE as readonly string[]).includes(campaign.state) && !campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a preparing, scheduled, sending or paused campaign can be paused, resumed or paced.'); };
/** A delivery control in the caller's transaction: the campaign locked, its sender and state checked, then changed. */
async function controlCampaign(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, change: CampaignChange, allowed = sendingOnly) {
  const campaign = await findCampaign(db, a, campaignId, true); draftSender(runtime, a, campaign.draft);
  allowed(campaign);
  await change(db, a, campaign);
}
const pausing = (audit: AuditContext | Ctx): CampaignChange => async (db, a, campaign) => {
  if (campaign.state === 'paused') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'This campaign is already paused.');
  if (campaign.state === 'failed') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'This campaign failed; resume or cancel it.');
  if (campaign.expanded >= campaign.total) throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'Only a campaign that is still releasing recipients can be paused.');
  const ref = { workspaceId: a.workspaceId, id: campaign.id };
  await db.execute(pauseCampaign(ref, { code: 'PAUSED_BY_USER', message: 'Paused from the dashboard or API.' }));
  await db.execute(retireCampaignRun(ref, 'CAMPAIGN_PAUSED'));
  await recordAudit(db, audit, { action: 'campaign.pause', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaign.id }, before: { state: campaign.state } });
};
/** Pausing a campaign (POST /v1/campaigns/{id}/pause, and a support action the customer confirmed signed in), in the caller's transaction. */
export const pauseSendingCampaign = (runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, audit: AuditContext | Ctx) => controlCampaign(runtime, db, a, campaignId, pausing(audit));
type AttachmentFacts = Pick<typeof attachments.$inferSelect, 'id' | 'size' | 'contentId'> & Partial<Pick<typeof attachments.$inferSelect, 'filename' | 'contentType'>>;
/** What Amazon SES refuses in an attachment's content ID and MIME type, by field. */
function sesProblems(metadata: { contentId?: string | null; contentType?: string | null }) {
  const max = SEND_LIMITS.mimeFieldChars, out: Partial<Record<'contentId' | 'contentType', string>> = {};
  if ((metadata.contentId?.length ?? 0) > max) out.contentId = `is ${metadata.contentId!.length} characters, and Amazon SES takes at most ${max}`;
  if (metadata.contentType && metadata.contentType.length > max) out.contentType = `is ${metadata.contentType.length} characters, and Amazon SES takes at most ${max}`;
  else if (metadata.contentType && /[^ -~]/.test(metadata.contentType)) out.contentType = 'has characters outside printable ASCII, which Amazon SES refuses';
  return out;
}
function sesAttachment(metadata: { filename?: string; contentId?: string | null; contentType?: string }) {
  const problems = sesProblems(metadata), fields = Object.keys(problems) as (keyof typeof problems)[];
  if (fields.length) throw metadataInvalid(metadata, fields, false, problems);
}
type AttachmentProblem = { index: number; attachment?: number; id?: string; filename?: string; code: string; status: number; message: string; types?: AttachmentTypes; mailApp?: boolean };
/**
 * Every problem with the attachments of each email in a send, email by email and file by file, so a caller learns every
 * rule it broke in one try (a production agent found them one refusal at a time): a file missing or listed twice, a
 * content ID or type SES refuses, a content ID two files share, and files that together pass an email's limit, each
 * with its size.
 */
function attachmentProblems(lists: string[][], byId: Map<string, AttachmentFacts>): AttachmentProblem[] {
  const problems: AttachmentProblem[] = [];
  for (const [index, list] of lists.entries()) {
    const seen = new Map<string, number>(), cids = new Map<string, number>(), found: { k: number; row: AttachmentFacts }[] = [];
    for (const [k, id] of list.entries()) {
      const row = byId.get(id), at = { index, attachment: k, id, ...(row?.filename ? { filename: row.filename } : {}) }, name = row?.filename ? quoted(row.filename) : id;
      if (seen.has(id)) { problems.push({ ...at, code: 'DUPLICATE_ATTACHMENT', status: 422, message: `${name} is the same file as attachments.${seen.get(id)}: list each file once` }); continue; }
      seen.set(id, k);
      if (!row) { problems.push({ ...at, code: 'ATTACHMENT_NOT_FOUND', status: 404, message: `${id} was not found in this workspace: upload the file (POST /v1/attachments, or /v1/attachments/upload for raw bytes) and list the id it returns` }); continue; }
      found.push({ k, row });
      for (const [field, why] of Object.entries(sesProblems(row))) problems.push({ ...at, code: 'ATTACHMENT_METADATA_INVALID', status: 422, message: `${name}'s ${field} ${why}` });
      if (row.contentId) {
        const other = cids.get(row.contentId);
        if (other === undefined) cids.set(row.contentId, k);
        else problems.push({ ...at, code: 'DUPLICATE_CONTENT_ID', status: 422, message: `${name} has contentId ${quoted(row.contentId)}, as attachments.${other} does: each inline file needs its own` });
      }
    }
    const total = found.reduce((n, f) => n + f.row.size, 0);
    if (total > SEND_LIMITS.attachmentBytes) problems.push({ index, code: 'ATTACHMENT_LIMIT_EXCEEDED', status: 413,
      message: `the files are ${sizeText(total)} together, decoded (${found.map(f => `attachments.${f.k}${f.row.filename ? ` ${quoted(f.row.filename)}` : ''} ${sizeText(f.row.size)}`).join(', ')}), and one email carries at most ${mib(SEND_LIMITS.attachmentBytes)}: send fewer or smaller files, split them across emails, or link to large files from the email` });
  }
  return problems;
}
/** One refusal naming every problem: the first one's status, code, field and types, and each in the message and
 *  error.details. A mail app's message is the SMTP reply its user reads (gateway remote.rs): plain words naming each
 *  file once, the same in every part of a large envelope. */
function attachmentRefusal(problems: AttachmentProblem[], batch: boolean) {
  const path = (p: AttachmentProblem) => `${batch ? `emails.${p.index}.` : ''}attachments${p.attachment === undefined ? '' : `.${p.attachment}`}`;
  const line = (p: AttachmentProblem) => `${path(p)}: ${p.message.replace(/\.$/, '')}`, first = problems[0]!;
  const limits = problems.some(p => p.code === 'ATTACHMENT_LIMIT_EXCEEDED') ? ` ${ATTACHMENT_LIMITS_TEXT}` : '';
  const message = problems.every(p => p.mailApp) ? `Message not sent: ${[...new Set(problems.map(p => p.message))].join('; ')}.`
    : `${problems.length > 1 ? `${problems.length} attachment problems: ` : ''}${problems.map(line).join('; ')}.${limits}`;
  const error = new ApiError(first.status, first.code, message, path(first));
  error.attachmentTypes = first.types;
  error.details = problems.map(p => ({ ...(batch ? { index: p.index } : {}), ...(p.attachment === undefined ? {} : { attachment: p.attachment }), ...(p.id ? { id: p.id } : {}),
    ...(p.filename ? { filename: p.filename } : {}), code: p.code, message: line(p) }));
  return error;
}
// DUPLICATE_ATTACHMENT is a request's shape, answered before any file is looked up, and stays as it is.
const ATTACHMENT_REFUSALS = new Set(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_LIMIT_EXCEEDED', 'DUPLICATE_CONTENT_ID', 'ATTACHMENT_METADATA_INVALID']);
/** Before admitted: send_admission's attachment refusal (the first problem, for one email) becomes every problem in the send. */
async function refusedAttachments(runtime: Runtime, a: Actor, d: Admitted | Refused, out: Outgoing[], batch: boolean) {
  if (d.allowed || !ATTACHMENT_REFUSALS.has(d.code)) return;
  const lists = out.map(m => m.snapshot.attachments), ids = [...new Set(lists.flat())];
  const rows = ids.length ? await runtime.db.select().from(attachments).where(and(scope(attachments, a), scopedAttachment(a), inArray(attachments.id, ids))) : [];
  const problems = attachmentProblems(lists, new Map(rows.map(row => [row.id, row])));
  if (problems.length) throw attachmentRefusal(problems, batch);
}
function sesHeaders(count: number) {
  if (count>15) throw new ApiError(422,'TOO_MANY_HEADERS','SES accepts at most 15 message headers including unsubscribe and threading headers.','headers');
}
function distinctAttachmentIds(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw duplicateAttachment();
  return ids;
}
function validateAttachmentRows(ids: string[], rows: AttachmentFacts[]) {
  // A draft keeps files whose metadata SES would refuse (stored before that check); sending them is refused at admission.
  const problems = attachmentProblems([ids], new Map(rows.map(row => [row.id, row]))).filter(p => p.code !== 'ATTACHMENT_METADATA_INVALID');
  if (problems.length) throw attachmentRefusal(problems, false);
}
export async function attachmentRows(db: DbExecutor, a: Actor, ids: string[], lock = false, conversation = false) {
  if (!ids.length) return [];
  const query = db.select().from(attachments).where(and(scope(attachments, a), scopedAttachment(a, conversation), inArray(attachments.id, distinctAttachmentIds(ids)))).orderBy(asc(attachments.id));
  const rows = await (lock ? query.for('update') : query);
  validateAttachmentRows(ids, rows);
  return rows;
}
async function linkAttachments(db: DbExecutor, a: Actor, ids: string[], ownerType: 'email' | 'campaign' | 'review', ownerId: string, lockedAttachments?: (typeof attachments.$inferSelect)[], conversation = false) {
  // A campaign may reuse metadata already ownership-checked and locked in this same transaction.
  if (!lockedAttachments) await attachmentRows(db, a, ids, true, conversation);
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType, ownerId }))).onConflictDoNothing();
}
function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
export function formattedSender(from: string, fromName?: string, foldMime = false): string {
  // Domain authorization always uses the bare address; formatting happens only at the MIME/SES boundary.
  Address.parse(from);
  if (!fromName) return from;
  // Current admission validates FromName. A queued display name is data, not a new admission:
  // one that no longer passes the policy is left out and the bare address is sent.
  if (!FromName.safeParse(fromName).success) return from;
  fromName = decodedDisplayName(fromName);
  if (/^[\x20-\x7e]+$/.test(fromName)) return `"${fromName.replace(/["\\]/g, '\\$&')}" <${from}>`;
  // RFC 2047 encoded words, each below 75 characters and never splitting a UTF-8 code point.
  const words: string[] = []; let chunk = '';
  for (const character of fromName) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  const separator = foldMime ? '\r\n ' : ' ';
  return `${words.join(separator)}${separator}<${from}>`;
}
// SES Simple puts CID images beside the body in multipart/mixed. Build only
// the inline-image case ourselves so each image is related to its HTML part.
// The message is written once into one buffer of its exact size: text as it is built, each file's base64 (76-character
// lines) straight from its bytes. A 25 MiB attachment then costs its own bytes and the message, nothing between.
type Segment = string | { file: Uint8Array };
const LINE_BYTES = 57, ENCODE_CHUNK = LINE_BYTES * 1024;
const base64Size = (n: number) => { const chars = Math.ceil(n / 3) * 4; return chars + 2 * Math.max(0, Math.ceil(chars / 76) - 1); };
function writeSegments(segments: Segment[]): Uint8Array {
  const size = segments.reduce((n, segment) => n + (typeof segment === 'string' ? Buffer.byteLength(segment) : base64Size(segment.file.length)), 0);
  const out = Buffer.allocUnsafe(size);
  let at = 0;
  for (const segment of segments) {
    if (typeof segment === 'string') { at += out.write(segment, at); continue; }
    const file = segment.file;
    for (let i = 0; i < file.length; i += ENCODE_CHUNK) {
      const encoded = Buffer.from(file.buffer, file.byteOffset + i, Math.min(ENCODE_CHUNK, file.length - i)).toString('base64');
      for (let j = 0; j < encoded.length; j += 76) {
        if (i || j) at += out.write('\r\n', at);
        at += out.write(encoded.slice(j, j + 76), at, 'latin1');
      }
    }
  }
  if (at !== size) throw new Error('MIME size mismatch');
  return out;
}
export function inlineMessage(snapshot: EmailSnapshot, parts: Attachment[], archive?:{id:string;date:string}): Uint8Array {
  const crlf = '\r\n';
  const encodedWords = (value: string) => {
    const words: string[] = []; let chunk = '';
    for (const character of value) {
      if (Buffer.byteLength(chunk + character) > 45) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
      chunk += character;
    }
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
    return words.join(`${crlf} `);
  };
  const quotedPrintable = (value: string) => {
    const lines: string[] = []; let line = '';
    const flush = (soft: boolean) => { lines.push(soft ? `${line}=` : line.replace(/[ \t]$/, c => c === ' ' ? '=20' : '=09')); line = ''; };
    for (const byte of Buffer.from(value.replace(/\r\n|\r|\n/g, '\n'), 'utf8')) {
      if (byte === 0x0a) { flush(false); continue; }
      const token = byte === 0x3d || (byte < 0x20 && byte !== 0x09) || byte > 0x7e ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
      if (line.length + token.length > 73) flush(true);
      line += token;
    }
    flush(false);
    return lines.join(crlf);
  };
  const textPart = (type: 'plain' | 'html', body: string): Segment[] => [`Content-Type: text/${type}; charset=UTF-8${crlf}Content-Transfer-Encoding: quoted-printable${crlf}${crlf}${quotedPrintable(body)}`];
  const multipart = (type: 'related' | 'alternative' | 'mixed', children: Segment[][]): Segment[] => {
    const boundary = `nightmail_${archive ? `${archive.id}_${type}` : crypto.randomUUID()}`;
    return [`Content-Type: multipart/${type}; boundary="${boundary}"${type === 'related' ? '; type="text/html"' : ''}${crlf}${crlf}`,
      ...children.flatMap(child => [`--${boundary}${crlf}`, ...child, crlf]), `--${boundary}--${crlf}`];
  };
  const filePart = (part: Attachment): Segment[] => {
    if (!part.RawContent || !part.FileName || !part.ContentType || /[\r\n]/.test(part.ContentType) || (part.ContentId && !/^[a-zA-Z0-9_.@-]+$/.test(part.ContentId))) throw new ApiError(422, 'INVALID_MIME_ATTACHMENT', 'Attachment metadata cannot be encoded safely.');
    // RFC 2231 continuations preserve Unicode/quotes and keep filename lines short.
    const filename = [...Buffer.from(part.FileName)].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('').match(/.{1,60}/g)!;
    const disposition = part.ContentDisposition === 'INLINE' ? 'inline' : 'attachment';
    const parameters = filename.map((value, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ''}${value}`).join(`;${crlf}`);
    return [`Content-Type: ${part.ContentType}${crlf}Content-Transfer-Encoding: base64${crlf}Content-Disposition: ${disposition};${crlf}${parameters}${crlf}` +
      (part.ContentId ? `Content-ID: <${part.ContentId}>${crlf}` : '') + crlf, { file: part.RawContent }];
  };
  const inline = parts.filter(part => part.ContentDisposition === 'INLINE');
  const files = parts.filter(part => part.ContentDisposition !== 'INLINE');
  let body = snapshot.html === undefined ? textPart('plain',snapshot.text??'') : textPart('html',snapshot.html);
  if(inline.length)body=multipart('related',[body,...inline.map(filePart)]);
  if (snapshot.html!==undefined && snapshot.text !== undefined) body = multipart('alternative', [textPart('plain', snapshot.text), body]);
  if (files.length) body = multipart('mixed', [body, ...files.map(filePart)]);
  // Bcc stays only in the SES envelope, never the MIME headers.
  const headers = [
    `From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`,
    `To: ${snapshot.to.join(`,${crlf} `)}`,
    ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(`,${crlf} `)}`] : []),
    ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(`,${crlf} `)}`] : []),
    `Subject: ${/^[\x20-\x7e]{1,900}$/.test(snapshot.subject) && !snapshot.subject.includes('=?') ? snapshot.subject : encodedWords(snapshot.subject)}`,
    `Date: ${new Date(archive?.date??Date.now()).toUTCString()}`,
    ...(archive?[`Message-ID: <${archive.id}@nightmail.invalid>`]:[]),
    'MIME-Version: 1.0',
    ...snapshot.headers.map(header => {
      if (!/^[A-Za-z0-9-]+$/.test(header.Name) || /[\r\n]/.test(header.Value)) throw new ApiError(422, 'INVALID_MIME_HEADER', 'Message headers cannot contain line breaks.');
      return `${header.Name}: ${header.Value}`;
    }),
  ];
  // Body/attachment lines are bounded by their encoders. Check only message
  // headers rather than splitting a potentially multi-megabyte MIME body.
  if (headers.some(header => header.split(crlf).some(line => Buffer.byteLength(line) > 998))) throw new ApiError(422, 'MIME_LINE_TOO_LONG', 'An encoded message header exceeds the SMTP line limit.');
  const bytes = writeSegments([[...headers, ''].join(crlf), ...body]);
  if (bytes.length > SEND_LIMITS.encodedBytes) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', `Encoded MIME exceeds the ${SEND_LIMITS.encodedBytes / 1_000_000} MB message limit.`);
  return bytes;
}
function withPreheader(html: string | undefined, previewText: string | undefined, parse: HtmlParser | undefined, version = CAMPAIGN_RENDERER_VERSION): string | undefined {
  if (!html || !previewText) return html;
  if (!parse) throw new Error('HTML parser required');
  const stack: DefaultTreeAdapterMap['node'][] = [parse(html, { sourceCodeLocationInfo: true })];
  let bodyOffset = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      if (node.tagName === 'body') bodyOffset = node.sourceCodeLocation?.startTag?.endOffset ?? 0;
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  const preheader = `<div ${version===1?'data-opensend-preview':'data-bane-preview'}="true" data-skip-in-text="true" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escaped(previewText)}</div>`;
  return html.slice(0, bodyOffset) + preheader + html.slice(bodyOffset);
}
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'longdesc', 'data', 'codebase', 'profile', 'manifest', 'xlink:href']);
const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'aria-label', 'aria-description']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext']);
function validateUrl(value: string) {
  // The HTML parser has already decoded all character references (not just a regex subset).
  const normalized = value.replace(/[\x00-\x20\x7f]/g, '');
  let url: URL;
  try { url = new URL(normalized, 'https://template.invalid/'); } catch { throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML contains an invalid URL.'); }
  if (!['http:', 'https:', 'mailto:', 'tel:', 'cid:'].includes(url.protocol)) throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML URLs must use HTTP(S), mailto, tel, CID, or relative references.');
}
type HtmlPlaceholderAnalysis = { hasUrlPlaceholder: boolean; hasAttrPlaceholder: boolean; attrPlaceholderCount: number };
function inspectHtml(source: string, root: DefaultTreeAdapterMap['node'], template = false): HtmlPlaceholderAnalysis {
  const safe: { start: number; end: number; kind: 'text' | 'textAttr' | 'urlAttr' }[] = [];
  const stack: { node: DefaultTreeAdapterMap['node']; unsafe: boolean }[] = [{ node: root, unsafe: false }];
  while (stack.length) {
    const { node, unsafe } = stack.pop()!;
    const element = 'tagName' in node ? node : undefined;
    const blocked = unsafe || !!element && (RAW_TEXT_ELEMENTS.has(element.tagName) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml');
    if (node.nodeName === '#text' && !blocked && node.sourceCodeLocation) {
      const { startOffset: start, endOffset: end } = node.sourceCodeLocation;
      // HTML error recovery can coalesce text across ignored markup. Never trust such a
      // broad location as a text-only range; literal less-than signs should use &lt;.
      if (!source.slice(start, end).includes('<')) safe.push({ start, end, kind: 'text' });
    }
    if (element) {
      for (const attr of element.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        // Template structure is checked before rendering; validate complete URLs only after substitution.
        // Office markup carries its links and images under a prefix (o:href on VML), read like the plain attribute.
        if (!template && (URL_ATTRIBUTES.has(name) || /:(?:href|src)$/.test(name))) validateUrl(attr.value);
        if (!template && ['srcset', 'imagesrcset', 'ping', 'archive'].includes(name)) {
          const urls = name.endsWith('srcset') ? attr.value.split(',').map(part => part.trim().split(/\s+/)[0]!) : attr.value.trim().split(/\s+/);
          for (const url of urls) if (url) validateUrl(url);
        }
        if (template && !blocked && (URL_ATTRIBUTES.has(name) || TEXT_ATTRIBUTES.has(name))) {
          const location = element.sourceCodeLocation?.attrs?.[name];
          if (!location) continue;
          const original = source.slice(location.startOffset, location.endOffset);
          // Parser offsets identify the attribute; this only checks its lexical quoting, never parses HTML.
          const quoted = original.match(/^[^\s=]+\s*=\s*(["'])/);
          if (quoted && original.endsWith(quoted[1]!)) safe.push({ start: location.startOffset + quoted[0].length, end: location.endOffset - 1, kind: URL_ATTRIBUTES.has(name) ? 'urlAttr' : 'textAttr' });
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push({ node: child, unsafe: blocked });
    // A template's content, and markup a lenient client may read where this parser kept data (bounded-html.ts).
    if ('content' in node) stack.push({ node: (node as DefaultTreeAdapterMap['template']).content, unsafe: blocked });
  }
  safe.sort((a, b) => a.start - b.start); let rangeIndex = 0;
  let hasUrlPlaceholder = false, hasAttrPlaceholder = false, attrPlaceholderCount = 0;
  if (template) for (const match of source.matchAll(/{{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*}}/g)) {
    while (safe[rangeIndex] && safe[rangeIndex]!.end <= match.index) rangeIndex++;
    const range = safe[rangeIndex];
    if (!range || match.index < range.start || match.index + match[0].length > range.end) throw new ApiError(422, 'UNSAFE_TEMPLATE_CONTEXT', 'Campaign placeholders require HTML text nodes or quoted URL/title/alt/aria-label/aria-description attributes. Unquoted attributes, tag names, comments, script/style, event handlers and foreign markup are unsupported.');
    if (range.kind === 'urlAttr') hasUrlPlaceholder = true;
    if (range.kind !== 'text') { hasAttrPlaceholder = true; attrPlaceholderCount++; }
  }
  return { hasUrlPlaceholder, hasAttrPlaceholder, attrPlaceholderCount };
}
function validateInterpolationTemplate(source: string | undefined, html: boolean, parse?: HtmlParser): HtmlPlaceholderAnalysis {
  if (!source) return { hasUrlPlaceholder: false, hasAttrPlaceholder: false, attrPlaceholderCount: 0 };
  const unsupported = source.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, '');
  // Nested CSS blocks legitimately end in }}. Only an unmatched opening delimiter begins unsupported template syntax.
  if (unsupported.includes('{{')) throw new ApiError(422, 'UNSUPPORTED_TEMPLATE_SYNTAX', 'Campaigns support simple {{name}} substitutions, not helpers, HTML fragments, or Liquid syntax.');
  if (html) {
    if (!parse) throw new Error('HTML parser required');
    return inspectHtml(source, parse(source, {sourceCodeLocationInfo:true}), true);
  }
  return { hasUrlPlaceholder: false, hasAttrPlaceholder: false, attrPlaceholderCount: 0 };
}
/** Differential-test helper: validates HTML placeholders and reports whether any sit in a URL or text attribute. */
export async function analyzeHtmlPlaceholders(html: string): Promise<HtmlPlaceholderAnalysis> {
  return validateInterpolationTemplate(html, true, await loadParse5());
}
function interpolate(source: string | undefined, values: Record<string, unknown>, html: boolean, templateValidated = false, parse?: HtmlParser): string | undefined {
  if (!source) return source;
  if (!templateValidated) validateInterpolationTemplate(source, html, parse);
  let result = ''; let offset = 0;
  for (const match of source.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)) {
    const key = match[1]!;
    if (!Object.hasOwn(values, key) || values[key] === undefined || values[key] === null) throw new ApiError(422, 'MISSING_TEMPLATE_VARIABLE', `This email uses {{${key}}} but has no value for it. Add a fallback value for ${key} (defaults.${key}).`, key);
    const value = html ? escaped(String(values[key])) : String(values[key]);
    const prefix = source.slice(offset, match.index);
    if (result.length + prefix.length + value.length > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
    result += prefix + value; offset = match.index + match[0].length;
  }
  if (result.length + source.length - offset > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
  return result + source.slice(offset);
}
async function validateHtmlUrls(html: string | undefined) {
  if (html) {
    // Every reading a mail client may give the markup: a link only Outlook shows is checked like any other.
    const root = (await loadBoundedHtml()).boundedHtmlFragment(html, 'document', { clients: true });
    if (!root) throw new ApiError(422,'CONTENT_TOO_LARGE_TO_SCREEN','Simplify the HTML so it can be validated safely.','html');
    inspectHtml(html, root);
  }
}
export function sizeCheck(snapshot: EmailSnapshot, rows: { size: number }[]) {
  if (estimatedMimeBytes(snapshot, rows) > SEND_LIMITS.encodedBytes) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', `Estimated encoded MIME exceeds the ${SEND_LIMITS.encodedBytes / 1_000_000} MB message limit, Amazon SES's maximum.`);
}
// The renderer owns the MIME content, not the envelope or custom headers. A
// substituted Subject can contain physical header lines, including obsolete From : forms.
function renderedMimeHeaders(block:string) {
  const headers:string[]=[],seen=new Set<string>();
  for (const field of block.split(/\r\n(?![ \t])/)) {
    const allowed=/^(subject|mime-version|content-[a-z0-9-]+):/i.exec(field);
    if (!allowed) continue; // Drop the entire untrusted field, continuations included.
    const name=allowed[1]!.toLowerCase(),unfolded=field.replace(/\r\n[ \t]+/g,' ');
    if (seen.has(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded)) throw new ApiError(422,'INVALID_RENDERED_MIME','SES rendered an ambiguous or invalid MIME header.');
    seen.add(name);
    // Preserve legal folding only when unfolding would exceed the SMTP line limit.
    if (field.split('\r\n').some(line=>Buffer.byteLength(line)>998)) throw new ApiError(422,'INVALID_RENDERED_MIME','A rendered MIME header line exceeds the SMTP limit.');
    headers.push(Buffer.byteLength(unfolded)>998?field:unfolded);
  }
  return headers;
}
// `url` is Nightmail's own link for the recipient. A campaign with its own unsubscribe page (`page`) links the footer
// there, with the same token; List-Unsubscribe keeps Nightmail's link, as RFC 8058 allows the header one HTTPS URI and
// the one-click POST must reach Nightmail, which records it and redirects a confirming browser to the page.
/** The workspace's postal address now, or null when it has none. */
async function workspacePostalAddress(runtime: Runtime, db: DbExecutor, workspaceId: string) {
  return (await db.execute<{ address: string | null }>(sql`SELECT ${postalAddressOf(runtime.config.multiTenant, workspaceId)} AS address`)).rows[0]?.address ?? null;
}
/** A required notice ignores marketing opt-outs, so a workspace makes, sends, resumes or releases one only while an
 *  operator has them turned on (scripts/set-required-notices.ts). `message` replaces the refusal's, for the run's pause. */
async function requiredNoticesAllowed(db: DbExecutor, draft: Pick<CampaignDraft, 'requiredNotice'>, workspaceId: string, message = `Required notices are off for this workspace. Ask ${productName} to turn them on.`) {
  if (!draft.requiredNotice) return;
  const { rows: [row] } = await db.execute<{ on: boolean | null }>(sql`SELECT required_notices AS on FROM workspaces WHERE id=${workspaceId}`);
  if (!row?.on) throw new ApiError(403, 'REQUIRED_NOTICES_OFF', message, 'requiredNotice');
}
/** A draft's topic (src/topics.ts): marketing only, and one the workspace has and hasn't archived whenever it is set or
 *  changed. One archived since it was set stays on the draft, and its launch is refused (topicRule). */
async function draftTopic(db: DbExecutor, a: Actor, draft: Pick<CampaignDraft, 'topicId' | 'requiredNotice'>, current?: Pick<CampaignDraft, 'topicId'>) {
  if (!draft.topicId) return;
  if (draft.requiredNotice) throw new ApiError(422, 'TOPIC_REQUIRES_MARKETING', 'A required notice has no unsubscribe, so it can\u2019t have a topic.', 'topicId');
  if (draft.topicId !== current?.topicId) await assertTopics(db, a.workspaceId, [draft.topicId], () => 'topicId');
}
/** The topic a campaign's audience is read with: none for a required notice. `active`: as topicRule's. */
const campaignTopic = (db: DbExecutor, workspaceId: string, draft: Pick<CampaignDraft, 'topicId' | 'requiredNotice'>, active: boolean): Promise<TopicRule | null> =>
  draft.topicId && !draft.requiredNotice ? topicRule(db, workspaceId, draft.topicId, active) : Promise.resolve(null);
// `postalAddress`: the workspace's (CAN-SPAM), under the link in the same quiet style, one line per line.
// `requiredNotice`: a required notice has no unsubscribe, so its footer is the postal address alone and it gets no
// List-Unsubscribe headers; `url` is then unused.
/** `linkOrigin`: where the footer's link and List-Unsubscribe point (src/link-domains.ts), as a launch froze it. */
export type Footer = { unsubscribePageUrl?: string; postalAddress?: string | null; requiredNotice?: boolean; linkOrigin?: string };
function marketingFooter(snapshot: EmailSnapshot, url: string, footer: Footer = {}) {
  footerParts(snapshot, url, footer);
  if (footer.requiredNotice) return;
  // Keep caller headers; the unsubscribe pair is always Nightmail's own.
  snapshot.headers = [...snapshot.headers.filter(header => !/^list-unsubscribe/i.test(header.Name)), { Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
}
/** The footer's visible part, in the HTML and the text: what a preview and a campaign test show without the headers. */
function footerParts(parts: { html?: string; text?: string }, url: string, { unsubscribePageUrl: page, postalAddress, requiredNotice }: Footer) {
  const link = requiredNotice ? null : page ? unsubscribePageLink(page, url.slice(url.lastIndexOf('/') + 1)) : url, lines = postalAddress ? postalAddress.split('\n') : [];
  if (!link && !lines.length) return;
  if (parts.html) {
    const style = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#595959";
    const footer = (link ? `<p style="${style};margin:24px 0 0"><a href="${escaped(link)}" style="color:#595959;text-decoration:underline">Unsubscribe</a></p>` : '')
      + (lines.length ? `<p style="${style};margin:${link ? 8 : 24}px 0 0">${lines.map(escaped).join('<br>')}</p>` : '');
    const close = parts.html.search(/<\/td>\s*<\/tr>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i);
    parts.html = close >= 0 ? parts.html.slice(0, close) + footer + parts.html.slice(close) : parts.html + footer;
  }
  parts.text = (parts.text ?? '') + '\n\n' + [...link ? [`Unsubscribe: ${link}`] : [], ...lines].join('\n');
}
function structuredSnapshot(input:SendRequest & {region:string}):EmailSnapshot {
  return { testCampaignId: null, untrustedContent: !!input.headers?.some(h => h.name.toLowerCase() === 'in-reply-to'), from: input.from, ...(input.fromName !== undefined ? { fromName: input.fromName } : {}), to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo, region: input.region, kind: input.kind, subject: input.subject ?? '', html: input.html, text: input.text, attachments: input.attachments, tracking: input.tracking ?? input.kind === 'marketing', headers: (input.headers ?? []).map(header => ({ Name: header.name, Value: header.value })), ...(input.screen && input.kind === 'transactional' ? { screen: true } : {}), ...(input.topicId && input.kind === 'marketing' ? { topicId: input.topicId } : {}) };
}
// The dispatcher screens Hosted shared mail on a live installation with a classifier (dispatcher.ts prepareMail).
// Admission measures what that screen would read and refuses, with the numbers, what it would refuse, instead of
// accepting mail that is rejected later; the dispatcher's own check stays as a backstop. Bring-your-own AWS mail with
// screen: true is screened at dispatch, as before.
function screenedAtDispatch(runtime: Runtime, shared: boolean) {
  return !!runtime.config.screen && !isSimulatedSes(runtime) && shared && runtime.config.hostedScreen;
}
/** The screen's refusal of one message, or undefined when it fits the per-message limit. */
async function screenRefusal(runtime: Runtime, snapshot: EmailSnapshot, index?: number) {
  const screen = await loadScreen();
  // A campaign test is a campaign's copy: it has the campaign limit.
  const limits = runtime.config.screenLimits, test = !!snapshot.testCampaignId;
  try { screen.assertScreenable(await screen.measureScreen(snapshot), test ? limits.campaignBytes : limits.messageBytes, test ? 'campaign' : 'message', index); }
  catch (error) { if (error instanceof ApiError && error.code === 'CONTENT_TOO_LARGE_TO_SCREEN') return error; throw error; }
}
// A message from content the caller validated, before admission decides where it goes. `rows`: the attachments that
// size the copy (a campaign's), or null when admission sizes it.
async function prepare(request: SendRequest, rows: AttachmentFacts[] | null, htmlValidated = false): Promise<EmailSnapshot> {
  const snapshot = structuredSnapshot({ ...request, region: request.region ?? '' });
  sesHeaders(snapshot.headers.length + (request.kind === 'marketing' ? 2 : 0));
  if (!htmlValidated && snapshot.html) await validateHtmlUrls(snapshot.html);
  if (rows) sizeCheck(snapshot, rows);
  return snapshot;
}
/** Renders a stored SES template into the snapshot's raw MIME, in the region and connection admission resolved. */
async function renderTemplate(runtime: Runtime, snapshot: EmailSnapshot, template: NonNullable<SendRequest['template']>, connection: ReadyConnection | null) {
  if (runtime.config.multiTenant && connection?.kind !== 'byo') throw new ApiError(422, 'SHARED_STORED_TEMPLATE_UNSUPPORTED', 'AWS-stored templates require a bring-your-own AWS connection. Use explicit content on shared sending.', 'template');
  // Preserve native SES semantics in both HTML and plaintext; callers own context-specific escaping.
  const templateData = JSON.stringify(template.data);
  if (templateData.length > 262144) throw new ApiError(413, 'TEMPLATE_DATA_TOO_LARGE', 'Serialized template data exceeds 262,144 characters.');
  if (isSimulatedSes(runtime)) throw new ApiError(422, 'SIMULATED_TEMPLATE_UNSUPPORTED', 'Simulated sending supports explicit content and campaigns, not AWS-stored templates.');
  const [{ GetEmailTemplateCommand, TestRenderEmailTemplateCommand }, ses] = await Promise.all([loadSendingSesv2(), getSes(runtime, snapshot.region, forDelivery(connection ?? undefined,{purpose:'template',name:template.name}))]);
  const before = await ses.send(new GetEmailTemplateCommand({ TemplateName: template.name }));
  const rendered = await ses.send(new TestRenderEmailTemplateCommand({ TemplateName: template.name, TemplateData: templateData }));
  const after = await ses.send(new GetEmailTemplateCommand({ TemplateName: template.name }));
  if (canonical(before.TemplateContent) !== canonical(after.TemplateContent)) throw new ApiError(409, 'TEMPLATE_CHANGED', 'The stored template changed during rendering; retry the request.');
  if (!rendered.RenderedTemplate) throw new ApiError(422, 'TEMPLATE_RENDER_EMPTY', 'SES did not return rendered MIME content.');
  snapshot.subject = before.TemplateContent?.Subject ?? '';
  snapshot.template = { ...template, source: before.TemplateContent ?? {}, render: 'ses' };
  // Keep SES's complete rendered MIME rather than treating advanced stored-template syntax as an inline template.
  const normalized = rendered.RenderedTemplate.replace(/\r?\n/g, '\r\n');
  const split = normalized.indexOf('\r\n\r\n');
  if (split < 0) throw new ApiError(422, 'INVALID_RENDERED_MIME', 'SES rendered content has no MIME header/body separator.');
  const headers = renderedMimeHeaders(normalized.slice(0,split));
  snapshot.raw = [`From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`, `To: ${snapshot.to.join(', ')}`, ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(', ')}`] : []), ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(', ')}`] : []), ...headers, ...snapshot.headers.map(header => `${header.Name}: ${header.Value}`)].join('\r\n') + normalized.slice(split);
}
/** Writes an admitted mailbox send in one statement: its email row, which is the dispatch queue entry, and its attachment links. */
async function queueEmail(runtime: Runtime, db: DbExecutor, a: Actor, snapshot: EmailSnapshot, emailId = rowId('email'), countHostedScreen = false, screened = true) {
  const sim = isSimulatedSes(runtime);
  await db.execute(sql`WITH inserted AS (INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened)
      VALUES(${emailId},${a.workspaceId},${a.keyId},${snapshot.region},${snapshot.from},${JSON.stringify(snapshot.to)}::jsonb,${JSON.stringify(snapshot.cc)}::jsonb,${JSON.stringify(snapshot.bcc)}::jsonb,${snapshot.subject},${JSON.stringify(snapshot)}::jsonb,${sim},${screened}) RETURNING id, workspace_id, to_addresses||cc_addresses||bcc_addresses AS recipients)
    ${countHostedScreen ? sql`, screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM inserted WHERE hosted_real_cost(recipients) > 0`)})` : sql``},
    links AS (INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id) SELECT ${a.workspaceId},f,'email',id FROM inserted,jsonb_array_elements_text(${JSON.stringify(snapshot.attachments)}::jsonb) f ON CONFLICT DO NOTHING)
    SELECT id FROM inserted`);
  if (screened) noteDispatch(a, snapshot);
  return { id: emailId, status: 'queued' as const, simulated: sim };
}
function noteDispatch(a: Actor, { region, kind }: EmailSnapshot) {
  const targets = a.dispatchTargets ??= new Map();
  const target = targets.get(region) ?? { count: 0, priority: false };
  target.count++; target.priority ||= kind === 'transactional'; targets.set(region, target);
}
// A batch item's own failure names the item, as a validation error does (emails.3.from); a batch-wide limit names none.
function atItem(error: unknown, index?: number) {
  if (index !== undefined && error instanceof ApiError && !(error instanceof ModuleLoadError) && error.code !== 'BATCH_CONTENT_TOO_LARGE' && !error.field?.startsWith('emails.'))
    error.field = `emails.${index}${error.field ? `.${error.field}` : ''}`;
  return error;
}
// The attachments a sender may use, of those a request names: every upload for a sender with mailbox access (or a
// conversation, whose mailbox rules admitted them), otherwise the reader rule for its kind (scopedAttachment).
function visibleAssets(ids: string[], who: { workspace: SQL; uploader: SQL; domains: SQL; mailboxAccess: SQL }) {
  const requested = sql`${JSON.stringify([...new Set(ids)])}::jsonb`;
  return ids.length ? sql`CASE WHEN ${who.domains}='[]'::jsonb AND ${who.mailboxAccess} THEN ${requested} ELSE (
    SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM sending_attachments WHERE workspace_id=${who.workspace} AND id IN (SELECT jsonb_array_elements_text(${requested}))
    AND CASE WHEN ${who.domains}='[]'::jsonb THEN ${sharedAttachmentAccess(who.uploader)} ELSE ${domainAttachmentAccess(who.uploader, who.domains)} END
  ) END` : sql`'[]'::jsonb`;
}
const actorAssets = (a: Actor, ids: string[], conversation = false) => visibleAssets(ids, { workspace: sql`${a.workspaceId}::text`, uploader: sql`${a.tokenId ?? a.keyId}::text`,
  domains: sql`${JSON.stringify(a.domains)}::jsonb`, mailboxAccess: sql`${conversation || actorMailAccess(a) !== null}::boolean` });
const nulAttachment = () => new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid: text cannot contain the NUL character (U+0000).');

// ── Scheduled single sends (sendEmail scheduledAt) ──
// A scheduled email is a sending_emails row in status scheduled, which the dispatcher never leases, plus one release job
// keyed by the email (like a campaign's run). Rescheduling requeues that job with a fresh run token, which the runner
// fences its settlement on, so a worker that already decided to wait for the old time can't hold back an earlier one.
const releaseJobId = (emailId: string) => `release:${emailId}`;
/** Releases the emails `rows` yields (workspace_id, id) at `at`, or moves their waiting release there. */
const queueRelease = (rows: SQL, at: string) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at)
  SELECT 'release:'||r.id,'sending.release',r.workspace_id,jsonb_build_object('emailId',r.id,'run',${id('run')}::text),${at}::timestamptz FROM (${rows}) r
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL RETURNING 1`;
const scheduledEvent = (rows: SQL, type: 'scheduled' | 'rescheduled', at: string, simulated: boolean) => sql`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,data)
  SELECT public.row_id('event'),r.workspace_id,r.id,${type},${simulated},jsonb_build_object('scheduledAt',${at}::text) FROM (${rows}) r RETURNING 1`;
/** A send time within the schedule's bounds (the same as send_admission's), in UTC. */
function scheduleTime(value: string) {
  const at = Date.parse(value), now = Date.now(), { skewSeconds, horizonSeconds } = SEND_LIMITS.schedule;
  if (!(at >= now - skewSeconds * 1000 && at <= now + horizonSeconds * 1000)) throw new ApiError(422, 'INVALID_SCHEDULE', `Schedule between now and ${horizonSeconds / 86_400} days from now.`, 'scheduledAt');
  return new Date(at).toISOString();
}
// Refusals that pass on their own within minutes (the dispatch queue is full, Hosted setup is finishing): a scheduled
// send retries them every 30 seconds for up to 15 minutes past its time, then is rejected like any other refusal.
const RELEASE_WAITS = new Set(['PENDING_EMAIL_LIMIT_EXCEEDED', 'TENANT_NOT_READY']);
const RELEASE_GRACE_MS = 15 * 60_000, RELEASE_RETRY_MS = 30_000;
// A scheduled marketing email its ramp hour has no room for is held, never rejected: it goes when room opens, or once it
// has been held RAMP_HOLD_MS (it fit the step's ceiling, and a day of it, when it was scheduled), but never while the
// workspace is paused. A paused hold looks again after HOLD_RECHECK_MS to twice that and counts its RAMP_HOLD_MS again from the last
// time it found a pause.
// Held emails wake spread out, not all on the hour or in step: a workspace's whole schedule (up to 100,000) can be held,
// and each wake takes its admission lock.
const RAMP_HOLD_MS = 24 * 3_600_000, HOLD_RECHECK_MS = 30 * 60_000, HOLD_SPREAD_MS = 10 * 60_000;
const spread = (ms: number) => Math.floor(Math.random() * ms);
/**
 * The release job: at its time, a scheduled email is admitted by send_admission as a send made then, under its row lock:
 * standing and holds, the Hosted daily limit, the balance, the dispatch queue, and its region and binding resolved again.
 * Admitted, it moves scheduled -> queued with created_at now (so the hour it is charged and billed in is this one, as an
 * immediate send's) for the dispatcher. Refused, it is rejected with the refusal's code: a reject event and
 * email.rejected, nothing charged. Canceled or already released meanwhile: nothing to do; moved later: it waits.
 * Marketing its ramp hour has no room for, or that a quarantined campaign pauses (RAMP_PAUSED), is held instead
 * (RAMP_HOLD_MS): still scheduled, its scheduledAt the time it tries again, with a Waiting event (dispatch_deferred) when
 * its hold starts or changes cause. Once held, it stays held while the workspace is paused (RAMP_PAUSED, MARKETING_HELD
 * or HOSTED_SENDING_PAUSED) until the owner resumes or cancels; the dispatcher never leases a scheduled row.
 * One transaction: a crash before its commit leaves the email scheduled for the job's next attempt, after it leaves
 * nothing to redo, and the dispatcher's claim (queued -> attempting) sends it once. Its last attempt failing rejects
 * the email (endRelease) instead of leaving it waiting forever; the job runner's claim does the same when its last
 * lease runs out (jobs.ts, failScheduledRelease).
 */
const releaseScheduled: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const emailId = String(payload.emailId), wid = job.workspaceId;
  let outcome: Awaited<ReturnType<typeof release>>;
  try { outcome = await release(); } catch (error) {
    if (error instanceof JobDeferred || job.attempts < MAX_ATTEMPTS) throw error;
    // An email that can't be rejected now is not dropped: its release starts over, with a fresh set of attempts.
    const webhooks = await endRelease(runtime, wid, emailId, payload.run).catch(() => { throw new JobDeferred(new Date(Date.now() + 60_000).toISOString()); });
    return wakeWebhooks(runtime, webhooks);
  }
  // Held (committed with its event): its job waits, a fresh set of attempts each time (jobs.ts).
  if (outcome && 'held' in outcome) throw outcome.held;
  if (outcome?.route && !outcome.heldForScreen) {
    const { route, priority, maxSendRate } = outcome;
    try { await runtime.dispatch?.(route.region, route.connection?.aws_account_id, 1, route.connection?.kind, priority, maxSendRate); }
    catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', jobId: job.id, message: 'Released mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  } else if (outcome?.webhooks) await wakeWebhooks(runtime, outcome.webhooks);
  async function release() { return runtime.db.transaction(async tx => {
    // Its time by the database's clock, which the job runner's claim also reads.
    const [row] = await tx.select({ status: emails.status, scheduledAt: emails.scheduledAt, actorKeyId: emails.actorKeyId, from: emails.from, snapshot: emails.snapshot, simulated: emails.simulated,
      early: sql<boolean>`${emails.scheduledAt} > clock_timestamp()`, waits: sql<boolean>`${emails.scheduledAt} + make_interval(secs => ${RELEASE_GRACE_MS / 1000}) > clock_timestamp()` })
      .from(emails).where(and(eq(emails.workspaceId, wid), eq(emails.id, emailId))).for('update');
    if (row?.status !== 'scheduled') return null;
    if (row.early) throw new JobDeferred(row.scheduledAt!);
    const s = row.snapshot, files = [...new Set(s.attachments)], marketing = s.kind === 'marketing' || !!s.bulk;
    const mail: AdmissionMail = { host: row.from.split('@')[1]!.toLowerCase(), region: s.requestedRegion, kind: s.kind, attachments: files, bodyBytes: contentBytes(s) };
    const heldSince = typeof payload.heldSince === 'string' ? Date.parse(payload.heldSince) : null;
    // Held: it stays scheduled, at the time it tries again, and its job keeps when its RAMP_HOLD_MS started (now for a pause).
    const hold = async (code: string, until: number, data: Record<string, unknown> = {}) => {
      const at = new Date(Math.max(until, Date.now() + 1000)).toISOString(), changed = payload.heldBy !== code;
      await tx.execute(sql`WITH moved AS (UPDATE sending_emails SET scheduled_at=${at}::timestamptz,updated_at=clock_timestamp() WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' RETURNING workspace_id,id)
        ${changed ? sql`, noted AS (INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,data)
          SELECT public.row_id('event'),workspace_id,id,'dispatch_deferred',${row.simulated},${JSON.stringify({ code, providerCalled: false, until: at, ...data })}::jsonb FROM moved RETURNING 1)` : sql``} SELECT 1`);
      if (changed) log('info', { code: 'SCHEDULED_EMAIL_HELD', workspaceId: wid, emailId, reason: code, until: at });
      const since = code !== 'RAMP_LIMIT_REACHED' || heldSince === null ? new Date().toISOString() : payload.heldSince;
      return { held: new JobDeferred(at, { ...payload, heldBy: code, heldSince: since }) };
    };
    // Its sender's authority is the dispatcher's to recheck at the claim, as for any queued mail.
    const admit = async (ramped: boolean) => {
      const decision = await admission(runtime, wid, actorJson({ keyId: row.actorKeyId, domains: [] }), { stage: 'send', locks: 'take', mails: [mail],
        ...charges(runtime, [{ recipients: hostedCost(s.to, s.cc, s.bcc), marketing, ...(ramped ? { snapshot: s } : {}) }]) }, undefined, sql`${JSON.stringify(files)}::jsonb`);
      return (await tx.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s;
    };
    let d = await admit(true);
    // Held RAMP_HOLD_MS and still no room: it fit the step's ceiling when it was scheduled, so it goes now, past the ramp.
    if (!d.allowed && d.code === 'RAMP_LIMIT_REACHED' && heldSince !== null && Date.now() >= heldSince + RAMP_HOLD_MS) {
      log('warn', { code: 'SCHEDULED_EMAIL_RAMP_BOUND', workspaceId: wid, emailId, heldSince: payload.heldSince });
      d = await admit(false);
    }
    shadowBilling(d.billing, wid);
    if (d.allowed) {
      if (s.kind === 'marketing') {
        // Pre-upgrade scheduled snapshots carry the generated header rather than a separate origin.
        const origin = s.linkOrigin ?? s.headers.find(h => h.Name.toLowerCase() === 'list-unsubscribe')?.Value.match(/^<(https?:\/\/[^/]+)\/unsubscribe\//)?.[1];
        if (origin) {
          const n = hostedCost(s.to, s.cc, s.bcc), allowance = await linkAllowance(tx, runtime.config, wid, origin);
          // Roll back admission's charges along with the attempt, and retry the same scheduled email.
          if (allowance && n > allowance.left) throw new JobDeferred(allowance.until, payload);
          if (new URL(origin).hostname === runtime.config.linkHost) await recordLinkUse(tx, wid, runtime.config.linkHost, n);
        }
      }
      const route = d.mails[0]!;
      const needsVerdict = !isSimulatedSes(runtime) && !s.screenVerdict && ((route.connection?.kind === 'shared' && runtime.config.hostedScreen) || (s.screen && s.kind === 'transactional'));
      const { rows: [lim] } = await tx.execute<{ rate: number | null }>(route.connection?.aws_account_id
        ? sql`SELECT max_send_rate AS rate FROM provider_account_limits WHERE aws_account_id=${route.connection.aws_account_id} AND region=${route.region} AND max_send_rate>0`
        : sql`SELECT max_send_rate AS rate FROM sending_region_limits WHERE workspace_id=${wid} AND region=${route.region} AND max_send_rate>0`);
      await tx.execute(sql`UPDATE sending_emails SET status='queued',region=${route.region},screened=${!needsVerdict},created_at=clock_timestamp(),updated_at=clock_timestamp(),
        snapshot=(snapshot-'binding')||jsonb_build_object('region',${route.region}::text)${route.binding ? sql`||jsonb_build_object('binding',${JSON.stringify(route.binding)}::jsonb)` : sql``}
        WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled'`);
      const maxSendRate = typeof lim?.rate === 'number' && lim.rate > 0 ? lim.rate : undefined;
      return { route, priority: !marketing, maxSendRate, heldForScreen: needsVerdict };
    }
    // No room, or a quarantined campaign pauses the workspace's marketing (RAMP_PAUSED, asked before the room): held. Once
    // held, the workspace's own pauses hold it too.
    if (d.code === 'RAMP_LIMIT_REACHED') return hold(d.code, Date.parse(d.resetAt!) + spread(HOLD_SPREAD_MS));
    if (d.code === 'RAMP_PAUSED') return hold(d.code, Date.now() + HOLD_RECHECK_MS + spread(HOLD_RECHECK_MS), { campaignId: d.campaignId, pauseCode: d.pauseCode });
    if (heldSince !== null && (d.code === 'HOSTED_SENDING_PAUSED' || d.code === 'MARKETING_HELD')) return hold(d.code, Date.now() + HOLD_RECHECK_MS + spread(HOLD_RECHECK_MS));
    if (RELEASE_WAITS.has(d.code) && row.waits) throw new JobDeferred(new Date(Date.now() + RELEASE_RETRY_MS).toISOString());
    const { rows: [rejected] } = await tx.execute<{ n: number }>(sql`WITH rejected AS (UPDATE sending_emails SET status='rejected',error_code=${d.code},updated_at=clock_timestamp()
        WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' RETURNING ${terminalColumns}
      ), ${terminalEvents(sql`SELECT * FROM rejected`, sql`'{"providerCalled":false}'::jsonb`)} SELECT count(*)::int AS n FROM webhook_jobs`);
    log('warn', { code: 'SCHEDULED_EMAIL_REFUSED', workspaceId: wid, emailId, refusal: d.code, jobId: job.id });
    return { webhooks: rejected!.n };
  }); }
});
/** A release's last attempt failed: under the email's row lock, and only while this attempt's run is still the job's (a
 * reschedule requeues it with a new one), the scheduled email is rejected with SCHEDULE_RELEASE_FAILED. Returns the
 * webhook jobs it queued. Lock order, as cancel and reschedule: the email row first, then the job read in a statement of
 * its own, so it sees a reschedule that held the row while this one waited (one statement would keep the snapshot it
 * took before the wait and judge by the old run). */
async function endRelease(runtime: Runtime, wid: string, emailId: string, run: unknown) {
  return runtime.db.transaction(async tx => {
    if (!(await tx.execute(sql`SELECT 1 FROM sending_emails WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' FOR UPDATE`)).rows.length) return 0;
    const { rows: [job] } = await tx.execute<{ run: string | null }>(sql`SELECT payload->>'run' AS run FROM jobs WHERE id=${releaseJobId(emailId)}`);
    if ((job?.run ?? null) !== (typeof run === 'string' ? run : null)) return 0;
    const { rows: [ended] } = await tx.execute<{ n: number }>(sql`WITH ${failScheduledRelease(sql`SELECT ${wid}::text AS workspace_id,${emailId}::text AS id`)} SELECT count(*)::int AS n FROM webhook_jobs`);
    log('warn', { code: 'SCHEDULE_RELEASE_FAILED', workspaceId: wid, emailId });
    return ended!.n;
  });
}

/** One message of a send, as built before admission: what TypeScript alone found wrong with it waits in `invalid`. */
type ScreenSummaryValue = { status: 'passed' | 'skipped' };
type Outgoing = { snapshot: EmailSnapshot; recipients: number; marketing: boolean; template?: SendRequest['template']; token?: { hash: string; email: string }; duplicate?: boolean; invalid?: unknown; oversize?: ApiError; emailId?: string; screenSummary?: ScreenSummaryValue; countScreened?: boolean; heldForScreen?: boolean;
  /** The dashboard's test email to this address (admitTestEmail): the screen records a platform verdict for it instead of
   *  asking the classifier, if and only if the message is that email, word for word, to that one address. */
  platformTestTo?: string };
const linkHostMissing = (): never => { throw new Error('A marketing message is built with its link origin (admitEmails).'); };
/** A direct send's messages, built and checked without the database: URLs, headers, duplicates and the batch's size.
 *  `postalAddress`: the workspace's, for the footer of its marketing mail (admitEmails reads it). */
async function directMessages(runtime: Runtime, mails: SendRequest[], batch: boolean, postalAddress?: string | null, origins: (string | undefined)[] = []): Promise<Outgoing[]> {
  const bulk = bulkFlags(mails), out: Outgoing[] = [];
  for (const [i, m] of mails.entries()) {
    const snapshot = structuredSnapshot({ ...m, region: m.region ?? '' });
    if (bulk[i]) snapshot.bulk = true;
    if (snapshot.html) await validateHtmlUrls(snapshot.html).catch(e => { throw atItem(e, batch ? i : undefined); });
    // PostgreSQL cannot store NUL in an attachment ID; nothing that names one is admitted.
    if (m.attachments.some(file => file.includes('\0'))) throw nulAttachment();
    // A repeated attachment is refused by admission after the sender's rules and before the attachment lookup.
    const message: Outgoing = { snapshot, recipients: hostedCost(m.to, m.cc, m.bcc), marketing: m.kind === 'marketing' || bulk[i]!, template: m.template,
      duplicate: new Set(m.attachments).size !== m.attachments.length };
    try {
      sesHeaders(snapshot.headers.length + (m.kind === 'marketing' ? 2 : 0));
      if (m.kind === 'marketing') {
        // Only the token's hash and destination come from local preparation; the statement gives it the workspace.
        const link = await (await loadOpsUnsub()).createUnsubscribeLink(origins[i] ?? linkHostMissing(), '', snapshot.to[0]!);
        snapshot.linkOrigin = origins[i];
        marketingFooter(snapshot, link.url, { postalAddress }); message.token = { hash: link.record.tokenHash, email: link.record.email };
      }
    } catch (e) { if (e instanceof ModuleLoadError) throw e; message.invalid = atItem(e, batch ? i : undefined); }
    out.push(message);
  }
  return out;
}
/** A send request without the Hono context: internal senders (sendSystemEmail) build one directly. */
type SendCall = IdempotentRequest & { runtime: Runtime; db?: DbExecutor };
const sendCall = (c: Ctx): SendCall => ({ runtime: c.env, ...idempotentRequest(c) });
// used is null for an uncharged duplicate of a request that still holds its key.
export type Principal = { id:string;workspace_id:string;permissions:Actor['permissions'];domains:string[];used:number|null;max_requests:number };
type Identity = { credential: SQL; authorize: (key: Principal) => Actor } | { actor: Actor };
type SendReceipt = { id: string; status: 'queued'; simulated: boolean; scheduledAt?: string; screen?: ScreenSummaryValue };
const SCREEN_RETRY_AFTER_S = 30;
const BATCH_SCREEN_CONCURRENCY = 4;
const isSystemNoticeKey = (keyId: string) => keyId.startsWith('standing:') || keyId.startsWith('billing:') || keyId.startsWith('notice:');
let acceptScreenSkipLoggedAt = 0;
function unavailableScreenError(message = 'Content screening is temporarily unavailable; retry shortly.') {
  const err = new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', message, undefined, true);
  err.retryAfterSeconds = SCREEN_RETRY_AFTER_S;
  return err;
}
function recipientIneligibleError(rows: { ord: number; email: string; reason: string }[], batch: boolean) {
  const first = rows[0]!;
  const err = new ApiError(422, 'RECIPIENT_INELIGIBLE', `Recipient ${first.email} is not eligible for delivery (${first.reason}).`, batch ? `emails.${first.ord}.to` : 'to');
  err.details = rows.map(r => ({ ...(batch ? { index: r.ord } : {}), email: r.email, reason: r.reason }));
  return err;
}
async function flushScreenObservability(runtime: Runtime) {
  const [{ flushScreenCalls }, { flushShadow }] = await Promise.all([import('./screen-calls.js'), import('./screen-shadow.js')]);
  flushShadow(runtime);
  if (runtime.deferNudge) runtime.deferNudge(async rt => { await flushScreenCalls(rt.db, runtime.db); });
  else await flushScreenCalls(runtime.db);
}
function mayScreenAtAccept(runtime: Runtime, out: Outgoing[]) {
  if (isSimulatedSes(runtime)) return false;
  if (runtime.config.multiTenant && runtime.config.hostedScreen) return true;
  return out.some(m => m.snapshot.screen && m.snapshot.kind === 'transactional');
}
async function checkRecipientsEligible(db: DbExecutor, workspaceId: string, out: Outgoing[], batch: boolean, skip = false) {
  if (skip || !out.length) return;
  const input = out.map((m, ord) => ({
    ord,
    marketing: m.snapshot.kind === 'marketing',
    destinations: [...m.snapshot.to, ...m.snapshot.cc, ...m.snapshot.bcc].map(e => e.toLowerCase()),
    reply_authors: m.snapshot.replyAuthors ?? [],
    topic: m.snapshot.topicId ?? null,
  }));
  const { rows } = await db.execute<{ ord: number; email: string; reason: string }>(sql`
    SELECT x.ord, d.email, cause.reason
    FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS x(ord int, marketing boolean, destinations jsonb, reply_authors jsonb, topic text)
    CROSS JOIN LATERAL jsonb_array_elements_text(x.destinations) WITH ORDINALITY d(email, n)
    LEFT JOIN audience_contacts c ON c.workspace_id = ${workspaceId} AND c.email = d.email
    CROSS JOIN LATERAL (SELECT CASE
      WHEN x.marketing AND c.marketing_consent = 'unsubscribed' THEN 'unsubscribed'
      WHEN c.suppressed AND NOT coalesce(NOT x.marketing AND c.suppression_reason = 'email_validation'
        AND c.marketing_consent <> 'unsubscribed' AND x.reply_authors ? d.email, false) THEN coalesce(c.suppression_reason, 'suppressed')
      WHEN x.marketing AND c.deleted_at IS NOT NULL THEN 'contact_deleted'
      WHEN x.marketing AND c.marketing_consent IS DISTINCT FROM 'subscribed' THEN 'consent_missing'
      WHEN x.marketing AND NOT ${topicAllows(sql`c.workspace_id`, sql`c.id`, sql`x.topic`)} THEN 'topic_unsubscribed'
      WHEN x.marketing AND c.risk IS NOT NULL AND NOT c.risk_allowed THEN 'risky_' || c.risk
    END AS reason) cause
    WHERE cause.reason IS NOT NULL
    ORDER BY x.ord, d.n`);
  if (rows.length) throw recipientIneligibleError(rows, batch);
}
/** Runs Hosted content rules (probation/standard HTML + attachment picture checks) and synchronous Jev/JevF screening
 *  at accept time before anything enters sending_emails. Parallelizes batch screening with bounded concurrency. */
async function screenOutgoingAtAccept(runtime: Runtime, a: Actor, out: Outgoing[], decided: Admitted, probation: boolean, batch: boolean, db: DbExecutor = runtime.db) {
  if (isSimulatedSes(runtime)) return;
  const settings = runtime.config.screen;
  const allAttachIds = [...new Set(out.flatMap(m => m.snapshot.attachments))];
  let loadedAttachments: Map<string, typeof attachments.$inferSelect> | undefined;
  type ScreenTask = { index: number; message: Outgoing; copy: EmailSnapshot; hosted: boolean; required: boolean; rules: 'probation' | 'standard' | null; region: string };
  const tasks: ScreenTask[] = [], unsendable: AttachmentProblem[] = [];
  for (const [i, m] of out.entries()) {
    const route = decided.mails[i]!;
    const conn = route.connection;
    const shared = conn?.kind === 'shared';
    const hosted = Boolean(shared && runtime.config.hostedScreen);
    // A built-in domain's mail is screened with a new sender's rules, whatever the connection's tier.
    const builtin = isBuiltinHost(runtime.config, m.snapshot.from.split('@')[1]!);
    const trusted = !builtin && Boolean(runtime.config.trustedPool && conn?.pool_tier === 'trusted' && conn?.legacy_names === false);
    if (shared && m.snapshot.raw) throw atItem(new ApiError(422, 'SHARED_RAW_UNSUPPORTED', 'Hosted sending requires structured SES content.'), batch ? i : undefined);
    if (shared && m.snapshot.mime && !trusted) throw atItem(new ApiError(422, 'SEALED_MAIL_UNAVAILABLE', 'Signed and encrypted mail goes out as written, which a sender can do once its first messages are evaluated.'), batch ? i : undefined);
    const rules: 'probation' | 'standard' | null = !hosted || trusted ? null : probation || builtin ? 'probation' : 'standard';
    const shouldScreen = hosted || Boolean(m.snapshot.screen && m.snapshot.kind === 'transactional');
    let copy = m.snapshot;
    if (rules) {
      const delivery = await import('./screened-html.js');
      try { copy = delivery.hostedCopy(m.snapshot, rules === 'probation'); }
      catch (error) { throw atItem(error, batch ? i : undefined); }
      if (m.snapshot.attachments.length) {
        if (!loadedAttachments) {
          const rows = await db.select().from(attachments).where(and(scope(attachments, a), inArray(attachments.id, allAttachIds))).orderBy(asc(attachments.id));
          loadedAttachments = new Map(rows.map(r => [r.id, r]));
        }
        // Every file of every email is read before refusing, so one refusal names them all.
        for (const [k, attId] of m.snapshot.attachments.entries()) {
          const attRow = loadedAttachments.get(attId);
          if (!attRow) continue;
          const body = await verifiedAttachment(runtime, attRow);
          try { delivery.hostedAttachment(attRow, body, rules === 'probation', !!m.snapshot.mailApp); } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            unsendable.push({ index: i, attachment: k, id: attId, filename: attRow.filename, code: error.code, status: error.status, message: error.message, types: error.attachmentTypes, mailApp: m.snapshot.mailApp });
          }
        }
      }
    }
    if (shouldScreen) {
      m.emailId ??= rowId('email');
      const verdict = m.platformTestTo ? platformTestVerdict(m.snapshot, m.platformTestTo, rules) : undefined;
      if (verdict) {
        // The local rules above still ran (the copy a probation sender's mail goes out as); only the classifier is spared.
        if (rules === 'probation') m.snapshot = copy;
        m.snapshot.screenVerdict = verdict;
        continue;
      }
      tasks.push({ index: i, message: m, copy, hosted, required: hosted && (!trusted || m.snapshot.kind === 'marketing'), rules, region: route.region });
    }
  }
  if (unsendable.length) throw attachmentRefusal(unsendable, batch);
  if (!tasks.length) return;
  if (!settings) {
    if (tasks.some(t => t.required)) throw unavailableScreenError('Hosted content screening is unavailable; retry shortly.');
    if (Date.now() - acceptScreenSkipLoggedAt >= 60000) {
      acceptScreenSkipLoggedAt = Date.now();
      log('warn', { code: 'CONTENT_SCREEN_SKIPPED', workspaceId: a.workspaceId, message: 'screen requested but TYPESAFE_API_KEY is not configured' });
    }
    for (const t of tasks) {
      t.message.snapshot.screenVerdict = { status: 'skipped', rules: t.rules };
      t.message.screenSummary = { status: 'skipped' };
    }
    return;
  }
  const screen = await loadScreen();
  const scopedRuntime: Runtime = { ...runtime, config: { ...runtime.config, workspaceId: a.workspaceId } };
  type JudgedVerdict = { kind: 'judged'; task: ScreenTask; result: ScreenResult; rejected: boolean };
  type UnavailableVerdict = { kind: 'unavailable'; task: ScreenTask; message: string };
  type Verdict = JudgedVerdict | UnavailableVerdict;
  const verdicts: Verdict[] = new Array(tasks.length);
  // failing: unavailable answers since the last verdict. A verdict earlier in the batch (a cached one included) must not
  // switch the bound off, so this resets on each verdict instead of requiring none at all.
  let next = 0, failing = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(tasks.length, BATCH_SCREEN_CONCURRENCY) }, async () => {
      while (next < tasks.length) {
        const pos = next++, task = tasks[pos]!;
        // Once BATCH_SCREEN_CONCURRENCY requests in a row found no classifier, the rest of the batch is held without asking:
        // at most 2 × BATCH_SCREEN_CONCURRENCY - 1 requests start after the last verdict, however large the batch.
        if (failing >= BATCH_SCREEN_CONCURRENCY) {
          verdicts[pos] = { kind: 'unavailable', task, message: 'Content screening is temporarily unavailable.' };
          continue;
        }
        const call = { emailId: task.message.emailId, workspaceId: a.workspaceId, region: task.region, kind: task.copy.kind, required: task.required };
        try {
          const result = await screen.screenSnapshot(scopedRuntime, task.copy, task.required, call);
          if (!result) {
            failing++;
            verdicts[pos] = { kind: 'unavailable', task, message: 'Content screening is temporarily unavailable.' };
            continue;
          }
          failing = 0;
          const rejected = result.spam >= result.threshold && (task.required || settings.mode === 'reject');
          verdicts[pos] = { kind: 'judged', task, result, rejected };
        } catch (error) {
          if (error instanceof ApiError && error.code === 'CONTENT_SCREEN_UNAVAILABLE') {
            failing++;
            verdicts[pos] = { kind: 'unavailable', task, message: error.message };
            continue;
          }
          throw error;
        }
      }
    }));
  } catch (error) {
    await flushScreenObservability(runtime).catch(() => {});
    throw error;
  }
  const judged = verdicts.filter((v): v is JudgedVerdict => v.kind === 'judged');
  const rejected = judged.filter(v => v.rejected);
  if (rejected.length) {
    // Count every judged real-destination Hosted verdict toward reputation even though nothing enters sending_emails.
    const hostedJudged = judged.filter(v => v.task.hosted).map(v => ({
      recipients: [...v.task.message.snapshot.to, ...v.task.message.snapshot.cc, ...v.task.message.snapshot.bcc],
      rejected: v.rejected ? 1 : 0,
    }));
    if (hostedJudged.length) {
      await runtime.db.execute(countScreened(sql`SELECT ${a.workspaceId}::text AS workspace_id, x.rejected
        FROM jsonb_to_recordset(${JSON.stringify(hostedJudged)}::jsonb) x(recipients jsonb, rejected int)
        WHERE hosted_real_cost(x.recipients) > 0`)).catch(() => {});
    }
    for (const r of rejected) {
      log('warn', { code: 'CONTENT_REJECTED_SPAM', workspaceId: a.workspaceId, emailId: r.task.message.emailId, spam: r.result.spam, model: r.result.model, threshold: r.result.threshold });
    }
    await flushScreenObservability(runtime).catch(() => {});
    const first = rejected[0]!;
    const err = new ApiError(422, 'CONTENT_REJECTED_SPAM', 'The content classifier judged this message to be deceptive or harmful.', batch ? `emails.${first.task.index}` : undefined);
    if (batch) err.details = rejected.map(r => ({ index: r.task.index, code: 'CONTENT_REJECTED_SPAM' }));
    throw err;
  }
  for (const v of verdicts) {
    if (v.kind === 'unavailable') {
      // Neither classifier answered: accept the email and hold it (screened = false) so screenHeldMail screens it
      // once a classifier recovers. The mail room never sends unverdicted rows.
      v.task.message.heldForScreen = true;
      log('warn', { code: 'CONTENT_SCREEN_HELD', workspaceId: a.workspaceId, emailId: v.task.message.emailId, region: v.task.region, kind: v.task.copy.kind, required: v.task.required, message: v.message });
      continue;
    }
    if (v.result.spam >= v.result.threshold) {
      log('warn', { code: 'CONTENT_SPAM_SUSPECTED', workspaceId: a.workspaceId, emailId: v.task.message.emailId, spam: v.result.spam, model: v.result.model });
    }
    if (v.task.rules === 'probation') v.task.message.snapshot = v.task.copy;
    v.task.message.snapshot.screenVerdict = { status: 'passed', spam: v.result.spam, model: v.result.model, digest: v.result.digest, rules: v.task.rules };
    v.task.message.screenSummary = { status: 'passed' };
    if (v.task.hosted) v.task.message.countScreened = true;
  }
  await flushScreenObservability(runtime).catch(() => {});
}
/** Pre-checks admission (balance, limits, domain, attachments, oversize), suppression, and content screening outside DB write locks. */
async function prepareFrontDoor(runtime: Runtime, a: Actor, out: Outgoing[], batch: boolean, scheduledAt?: string, skipSuppression = false) {
  const cfg = runtime.config, sim = isSimulatedSes(runtime);
  for (const [i, m] of out.entries()) {
    if (cfg.screen && !sim && cfg.hostedScreen) m.oversize = await screenRefusal(runtime, m.snapshot, batch ? i : undefined);
  }
  const check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out),
    ...(scheduledAt ? scheduledCharges(runtime, out, scheduledAt) : charges(runtime, out)) }, undefined, actorAssets(a, out.flatMap(m => m.snapshot.attachments)));
  const { rows: [pre] } = await runtime.db.execute<{ s: Admitted | Refused; probation: ProbationReason | null }>(sql`
    SELECT ${check} AS s, ${cfg.multiTenant ? probationReason(sql`${a.workspaceId}`) : sql`NULL`} AS probation`);
  await refusedAttachments(runtime, a, pre!.s, out, batch);
  const decided = admitted(runtime, pre!.s, a.workspaceId, { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  await checkRecipientsEligible(runtime.db, a.workspaceId, out, batch, skipSuppression || isSystemNoticeKey(a.keyId));
  await screenOutgoingAtAccept(runtime, a, out, decided, pre!.probation !== null, batch, runtime.db);
}
// A built-in domain's mail also names its recipients: send_admission checks them against its send scope and caps.
const admissionMails = (runtime: Runtime, out: Outgoing[]): AdmissionMail[] => out.map(({ snapshot: s, duplicate, invalid, oversize }) => ({ host: s.from.split('@')[1]!.toLowerCase(), region: s.region || undefined,
  kind: s.kind, attachments: [...new Set(s.attachments)], bodyBytes: contentBytes(s), duplicate: !!duplicate, invalid: !!invalid, oversize: !!oversize,
  ...(isBuiltinHost(runtime.config, s.from.split('@')[1]!) ? { recipients: [...s.to, ...s.cc, ...s.bcc].map(e => e.toLowerCase()) } : {}) }));

/**
 * Admits a send in one statement: the API key's authentication and budget (a warm key), the idempotency claim, the
 * send locks, the decision (send_admission) and every row the send writes. Direct and batch sends, self-hosted and
 * template sends, dashboard and platform notices and campaign tests all come here (template sends and campaign tests
 * through claimedSend);
 * the screen's measure runs here too, and the decision refuses it only for mail the screen would read.
 */
async function admitSends(call: SendCall, body: unknown, out: Outgoing[], identity: Identity, options: { batch: boolean; campaign?: { id: string; revision: number }; scheduledAt?: string }): Promise<SendReceipt | { data: SendReceipt[] }> {
  const runtime = call.runtime, cfg = runtime.config, sim = isSimulatedSes(runtime), key = call.key, batch = options.batch, at = options.scheduledAt;
  const guarded = !at && (cfg.linkHost || cfg.linkHosts) && out.some(m => m.snapshot.kind === 'marketing' && m.snapshot.linkOrigin);
  if (guarded && !call.db) return runtime.db.transaction(db => admitSends({ ...call, db }, body, out, identity, options));
  // A scheduled send keeps the region it asked for, if any: its release resolves the sender's region again.
  if (at) for (const m of out) if (m.snapshot.region) m.snapshot.requestedRegion = m.snapshot.region;
  let expanded = 0;
  for (const [i, m] of out.entries()) {
    if (cfg.screen && !sim && cfg.hostedScreen) m.oversize = await screenRefusal(runtime, m.snapshot, batch ? i : undefined);
    expanded += Buffer.byteLength(JSON.stringify(m.snapshot)) + 40;
    if (batch && expanded > SENDING_LIMITS.expandedCampaignBytes) m.invalid ??= new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Expanded batch content exceeds the ${SENDING_LIMITS.expandedCampaignBytes / 1024 / 1024} MiB limit. Submit smaller batches.`);
  }
  const hash = key === undefined ? null : await requestHash(body);
  const data = out.map(m => ({ id: m.emailId ?? rowId('email'), status: 'queued' as const, simulated: sim, ...(at ? { scheduledAt: at } : {}), ...(m.screenSummary ? { screen: m.screenSummary } : {}) })), receipt = batch ? { data } : data[0]!;
  const rows = out.map((m, ord) => ({ ord, id: data[ord]!.id, snapshot: m.snapshot, hash: m.token?.hash, email: m.token?.email, screened: !m.heldForScreen, count_screened: !!m.countScreened, marketing: m.snapshot.kind === 'marketing', destinations: [...m.snapshot.to, ...m.snapshot.cc, ...m.snapshot.bcc].map(e => e.toLowerCase()), reply_authors: m.snapshot.replyAuthors ?? [] }));
  const skipSuppression = 'actor' in identity && isSystemNoticeKey(identity.actor.keyId);
  const ids = [...new Set(out.flatMap(m => m.snapshot.attachments))];
  const principal = 'credential' in identity ? sql`SELECT k.*,b.used FROM credential k LEFT JOIN budget b ON true` : sql`SELECT ${identity.actor.keyId}::text AS id,${identity.actor.workspaceId}::text AS workspace_id,
    ${JSON.stringify(identity.actor.permissions)}::jsonb AS permissions,${JSON.stringify(identity.actor.domains)}::jsonb AS domains,0 AS used,0 AS max_requests`;
  const assets = visibleAssets(ids, 'credential' in identity
    ? { workspace: sql`k.workspace_id`, uploader: sql`k.id`, domains: sql`k.domains`, mailboxAccess: sql`k.permissions ? 'manage'` }
    : { workspace: sql`k.workspace_id`, uploader: sql`${identity.actor.tokenId ?? identity.actor.keyId}::text`, domains: sql`k.domains`, mailboxAccess: sql`${actorMailAccess(identity.actor) !== null}::boolean` });
  // A scheduled send is charged nothing now: its release admits it as a send at its time (releaseScheduled).
  const decision = await admission(runtime, sql`k.workspace_id`, sql`jsonb_build_object('id',k.id,'domains',k.domains)`, { stage: 'send', locks: 'take', mails: admissionMails(runtime, out),
    ...(at ? scheduledCharges(runtime, out, at) : charges(runtime, out)), ...(key !== undefined ? { claim: { path: call.path, key, hash: hash!, receipt } } : {}), ...(options.campaign ? { campaign: options.campaign } : {}) }, undefined, assets);
  const { rows: [result] } = await (call.db ?? runtime.db).execute<Principal & { s: Admitted | Refused | ClaimState | null; ineligible: { ord: number; email: string; reason: string }[] | null; max_send_rate: number | null }>(sql`WITH ${'credential' in identity ? sql`${identity.credential},` : sql``} state AS MATERIALIZED (
    SELECT k.*, CASE WHEN k.used IS NULL THEN jsonb_build_object('previous',NULL,'busy',true) WHEN k.used<=k.max_requests AND k.permissions ?| ARRAY['manage','send'] THEN ${decision} END s FROM (${principal}) k
  ), raw_submitted AS MATERIALIZED (SELECT k.workspace_id,k.id AS actor_id,m.ord,m.id,m.hash,m.email,m.screened,m.count_screened,m.marketing,m.destinations,m.reply_authors,
      m.snapshot||jsonb_build_object('region',x->>'region')||CASE WHEN jsonb_typeof(x->'binding')='object' THEN jsonb_build_object('binding',x->'binding') ELSE '{}' END AS snapshot
    FROM state k,jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) m(ord int,id text,hash text,email text,screened boolean,count_screened boolean,marketing boolean,destinations jsonb,reply_authors jsonb,snapshot jsonb) CROSS JOIN LATERAL (SELECT k.s->'mails'->m.ord AS x) r
    WHERE k.s->>'allowed'='true'
  ), ineligible AS MATERIALIZED (${skipSuppression ? sql`SELECT NULL::int AS ord, NULL::text AS email, NULL::text AS reason WHERE false` : sql`
    SELECT r.ord, d.email, cause.reason
    FROM raw_submitted r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.destinations) WITH ORDINALITY d(email, n)
    LEFT JOIN audience_contacts c ON c.workspace_id = r.workspace_id AND c.email = d.email
    CROSS JOIN LATERAL (SELECT CASE
      WHEN r.marketing AND c.marketing_consent = 'unsubscribed' THEN 'unsubscribed'
      WHEN c.suppressed AND NOT coalesce(NOT r.marketing AND c.suppression_reason = 'email_validation'
        AND c.marketing_consent <> 'unsubscribed' AND r.reply_authors ? d.email, false) THEN coalesce(c.suppression_reason, 'suppressed')
      WHEN r.marketing AND c.deleted_at IS NOT NULL THEN 'contact_deleted'
      WHEN r.marketing AND c.marketing_consent IS DISTINCT FROM 'subscribed' THEN 'consent_missing'
      WHEN r.marketing AND NOT ${topicAllows(sql`c.workspace_id`, sql`c.id`, sql`r.snapshot->>'topicId'`)} THEN 'topic_unsubscribed'
      WHEN r.marketing AND c.risk IS NOT NULL AND NOT c.risk_allowed THEN 'risky_' || c.risk
    END AS reason) cause
    WHERE cause.reason IS NOT NULL
    ORDER BY r.ord, d.n`}
  ),
  submitted AS MATERIALIZED (SELECT * FROM raw_submitted WHERE NOT EXISTS (SELECT 1 FROM ineligible)),
  inserted AS (INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened,status,scheduled_at)
    SELECT id,workspace_id,actor_id,snapshot->>'region',snapshot->>'from',snapshot->'to',snapshot->'cc',snapshot->'bcc',snapshot->>'subject',snapshot,${sim},screened,${at ? 'scheduled' : 'queued'},${at ?? null}::timestamptz FROM submitted),
  ${out.some(m => m.countScreened) ? sql`screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM submitted WHERE count_screened AND hosted_real_cost(destinations) > 0`)}),` : sql``}
  ${at ? sql`scheduled AS (${scheduledEvent(sql`SELECT workspace_id,id FROM submitted`, 'scheduled', at, sim)}), release AS (${queueRelease(sql`SELECT workspace_id,id FROM submitted`, at)}),` : sql``}
  links AS (INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id) SELECT workspace_id,a,'email',id FROM submitted,jsonb_array_elements_text(snapshot->'attachments') a),
  tokens AS (INSERT INTO operation_unsubscribe_tokens(workspace_id,token_hash,email,topic_id) SELECT workspace_id,hash,email,snapshot->>'topicId' FROM submitted WHERE hash IS NOT NULL)
  SELECT k.id,k.workspace_id,k.permissions,k.domains,k.used,k.max_requests,k.s,
    (SELECT jsonb_agg(to_jsonb(i)) FROM ineligible i) AS ineligible,
    (SELECT l.max_send_rate FROM provider_account_limits l WHERE l.aws_account_id = (k.s->'mails'->0->'connection'->>'aws_account_id') AND l.region = (k.s->'mails'->0->>'region') AND l.max_send_rate > 0) AS max_send_rate
  FROM state k`);
  if (!result) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
  const a = 'actor' in identity ? identity.actor : identity.authorize(result);
  const state = result.s!;
  // The statement's claim is idempotency_claim: the one replay rule answers a key it did not get.
  if ('previous' in state) return replay<typeof receipt>(state, hash!);
  await refusedAttachments(runtime, a, state as Admitted | Refused, out, batch);
  const decided = admitted(runtime, state as Admitted | Refused, a.workspaceId, { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  if (result.ineligible?.length) {
    // The statement's own claim holds this receipt, and nothing was queued: free the key so a retry is judged again.
    if (key !== undefined) await (call.db ?? runtime.db).execute(sql`DELETE FROM sending_idempotency WHERE workspace_id = ${result.workspace_id} AND actor_key_id = ${result.id} AND path = ${call.path} AND request_key = ${key}`);
    throw recipientIneligibleError(result.ineligible, batch);
  }
  if (guarded) {
    const counts = new Map<string, number>();
    for (const { snapshot, recipients } of out) if (snapshot.kind === 'marketing' && snapshot.linkOrigin) counts.set(snapshot.linkOrigin, (counts.get(snapshot.linkOrigin) ?? 0) + recipients);
    for (const [origin, n] of [...counts].sort(([a], [b]) => a.split('.').reverse().join('.').localeCompare(b.split('.').reverse().join('.')))) {
      const budget = await linkAllowance(call.db!, cfg, a.workspaceId, origin);
      if (budget && n > budget.left) {
        const error = new ApiError(429, budget.reason === 'link_listing' ? 'LINK_DOMAIN_HELD' : 'LINK_BUDGET_REACHED',
          budget.reason === 'link_listing' ? 'Marketing on this link domain is paused for review.' : 'The shared link domain has no room for this send today. Campaigns send the remainder on later days.', undefined, true);
        error.retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(budget.until)-Date.now())/1000));
        throw error;
      }
      if (new URL(origin).hostname === cfg.linkHost) await recordLinkUse(call.db!, a.workspaceId, cfg.linkHost, n);
    }
  }
  // Its release job wakes the dispatcher at its time; one due within a minute needs the scheduler awake now to follow it.
  if (at) { if (Date.parse(at) - Date.now() < 60_000) a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); return receipt; }
  const maxSendRate = typeof result.max_send_rate === 'number' && result.max_send_rate > 0 ? result.max_send_rate : undefined;
  for (const [i, m] of out.entries()) {
    if (m.heldForScreen) continue;
    const route = decided.mails[i]!;
    if (route.connection) a.dispatchAccount = { aws_account_id: route.connection.aws_account_id, kind: route.connection.kind, ...(maxSendRate ? { maxSendRate } : {}) };
    noteDispatch(a, { ...m.snapshot, region: route.region });
  }
  return receipt;
}
/**
 * A send that reads or renders something mutable before it is admitted: a stored template (SES renders it) or a
 * campaign test (its draft). Its Idempotency-Key is claimed first, pending, and committed before that work, so a
 * duplicate is IDEMPOTENCY_IN_PROGRESS and renders nothing; the claim is completed in the transaction that writes the
 * email and released only if nothing was written (idempotent's prepare). No send lock is held while it renders: the
 * transaction runs the one admission statement after the work.
 */
async function claimedSend(call: SendCall, a: Actor, body: unknown, work: () => Promise<{ out: Outgoing[]; campaign?: { id: string; revision: number } }>, options: { batch: boolean; scheduledAt?: string; replayed?: (db: DbExecutor, receipt: SendReceipt) => Promise<void> }) {
  let prepared: Awaited<ReturnType<typeof work>> | undefined;
  const admit = (db?: DbExecutor) => admitSends({ ...call, key: undefined, db }, body, prepared!.out, { actor: a }, { batch: options.batch, campaign: prepared!.campaign, scheduledAt: options.scheduledAt });
  if (call.key === undefined) { prepared = await work(); return admit(); }
  return idempotent<SendReceipt | { data: SendReceipt[] }>(call.runtime.db, { path: call.path, key: call.key, workspaceId: a.workspaceId, actorKeyId: a.keyId }, body, admit,
    { prepare: async () => { prepared = await work(); }, replayed: options.replayed && ((db, receipt) => 'id' in receipt ? options.replayed!(db, receipt) : Promise.resolve()) });
}
/** Renders each stored template through SES in the region a check-only decision resolves (no lock is held). */
async function renderTemplates(runtime: Runtime, a: Actor, out: Outgoing[], batch: boolean) {
  const cfg = runtime.config, check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out), ...charges(runtime, out) },
    undefined, actorAssets(a, out.flatMap(m => m.snapshot.attachments)));
  const decided = admitted(runtime, (await runtime.db.execute<{ s: Admitted | Refused }>(sql`SELECT ${check} AS s`)).rows[0]!.s, a.workspaceId,
    { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  for (const [i, m] of out.entries()) if (m.template) {
    const route = decided.mails[i]!, scoped = { ...runtime, config: { ...cfg, workspaceId: a.workspaceId, regions: [route.region] } };
    m.snapshot.region = route.region;
    await renderTemplate(scoped, m.snapshot, m.template, route.connection).catch(e => { throw atItem(e, batch ? i : undefined); });
  }
}
/** POST /v1/emails/send and /batch after authentication, the dashboard's test email and the platform's notices. */
async function admitEmails(call: SendCall, a: Actor, input: SendRequest | { emails: SendRequest[] }, scheduledAt?: string, sealed = false, platformTestTo?: string) {
  const batch = 'emails' in input, mails = batch ? input.emails : [input];
  await assertBuiltinStillSends(call.runtime, call.db ?? call.runtime.db, a.workspaceId, mails.map(m => m.from), batch);
  assertBuiltinInput(call.runtime.config, mails.map(m => ({ ...m, scheduledAt })), batch);
  await assertBuiltinRecipients(call.runtime, call.db ?? call.runtime.db, a.workspaceId, mails.map(m => ({ from: m.from, recipients: [...(Array.isArray(m.to) ? m.to : [m.to]), ...m.cc, ...m.bcc] })), batch);
  if (mails.some(m => isBuiltinHost(call.runtime.config, m.from.split('@')[1]!))) await awaitBuiltinSetup(call.runtime, a.workspaceId);
  // A topic is about marketing (src/topics.ts): its opt-outs and its one-click unsubscribe. One read for the whole send.
  const at = (i: number, field: string) => batch ? `emails.${i}.${field}` : field;
  const plain = mails.findIndex(m => m.topicId && m.kind !== 'marketing');
  if (plain >= 0) throw new ApiError(422, 'TOPIC_REQUIRES_MARKETING', 'A topic is for marketing mail (kind: marketing): transactional mail has no unsubscribe.', at(plain, 'topicId'));
  await assertTopics(call.db ?? call.runtime.db, a.workspaceId, mails.map(m => m.topicId), i => at(i, 'topicId'));
  // Marketing mail's footer carries the workspace's postal address when it has one. Unlike a campaign, a marketing send
  // without one is not refused: its caller writes the whole message and may include the address itself.
  const marketing = mails.some(m => m.kind === 'marketing'), db = call.db ?? call.runtime.db;
  const address = marketing ? await workspacePostalAddress(call.runtime, db, a.workspaceId) : null;
  // Its unsubscribe link goes on the link domain (src/link-domains.ts; a domain's own active link host when those are on),
  // whose use these recipients are recorded in; refused while the workspace is paused.
  const choose = marketing ? linkChoices(call.runtime, db, a.workspaceId) : undefined;
  const choices = choose ? await Promise.all(mails.map((m, i) => m.kind === 'marketing' ? choose(m.from).catch(error => { throw atItem(error, batch ? i : undefined); }) : undefined)) : [];
  const out = await directMessages(call.runtime, mails, batch, address, choices.map(choice => choice?.origin));
  if (sealed) for (const m of out) m.snapshot.sealed = true;
  if (platformTestTo) for (const m of out) m.platformTestTo = platformTestTo;
  // A reply by header joins the conversation it answers only when its sender can read that message.
  await joinReplies(call.db ?? call.runtime.db, actorMailAccess(a), out.map(m => m.snapshot));
  const screened = mayScreenAtAccept(call.runtime, out), needsPrep = out.some(m => m.template) || screened;
  if (!needsPrep) return admitSends(call, input, out, { actor: a }, { batch, scheduledAt });
  return claimedSend(call, a, input, async () => {
    if (out.some(m => m.template)) await renderTemplates(call.runtime, a, out, batch);
    if (screened) await prepareFrontDoor(call.runtime, a, out, batch, scheduledAt);
    return { out };
  }, { batch, scheduledAt });
}
/** A message an app submitted over SMTP with a send-only key (protocol-relay.ts), as POST /v1/emails/send takes it. */
export type RelayedMessage = { from: string; fromName?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; subject: string; text?: string; html?: string; attachments: string[]; headers: { name: string; value: string }[]; mime?: string };
/**
 * A relayed message built as sendEmail builds one. SMTP's envelope decides who gets it, and every recipient may be Bcc
 * (a To-less message), which sendEmail's schema refuses: it checks them together as To, then the copy takes the
 * message's own To, Cc and Bcc, as a mail client's submission does (queueMailboxEmail). SMTP already bounds the whole
 * message, so the bodies keep no JSON part cap.
 */
async function relayedMessage(runtime: Runtime, input: RelayedMessage) {
  const { mime, ...fields } = input;
  const parsed = ProtocolSendInput.safeParse({ ...fields, to: [...input.to, ...input.cc, ...input.bcc], cc: [], bcc: [] });
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Message fields are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
  const out = await directMessages(runtime, [parsed.data], false), message = out[0]!;
  if (message.invalid) throw message.invalid;
  if (mime) passThrough(message.snapshot, mime, message.marketing);
  Object.assign(message.snapshot, { to: input.to, cc: input.cc, bcc: input.bcc, mailApp: true });
  return { parsed: parsed.data, out };
}
/** Before a relayed message's attachments are uploaded: the message and its sender's admission, checked without
 *  sending or locking (renderTemplates' check), so a send that would be refused writes nothing. */
export async function checkRelayed(runtime: Runtime, a: Actor, input: RelayedMessage) {
  const { out } = await relayedMessage(runtime, { ...input, attachments: [] });
  const check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out), ...charges(runtime, out) });
  admitted(runtime, (await runtime.db.execute<{ s: Admitted | Refused }>(sql`SELECT ${check} AS s`)).rows[0]!.s, a.workspaceId);
}
/**
 * A relayed message, admitted as POST /v1/emails/send without an Idempotency-Key admits one: in one statement that reads
 * the key through `credential` (as a bearer key's request does) and writes the email. Its attachments were uploaded by
 * the key, as POST /v1/attachments would.
 */
export async function admitRelayed(runtime: Runtime, inputs: RelayedMessage[], credential: SQL, authorize: (key: Principal) => Actor): Promise<SendReceipt[]> {
  // An envelope past SES's 50 recipients arrives in parts (protocol-relay.ts): admitted together, as a batch is.
  const each: Awaited<ReturnType<typeof relayedMessage>>[] = [];
  for (const input of inputs) each.push(await relayedMessage(runtime, input));
  const out = each.flatMap(e => e.out), batch = out.length > 1;
  if (mayScreenAtAccept(runtime, out)) {
    const { rows: [keyRow] } = await runtime.db.execute<Principal>(sql`WITH ${credential} SELECT k.*, b.used FROM credential k LEFT JOIN budget b ON true`);
    if (!keyRow) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
    const a = authorize(keyRow);
    await prepareFrontDoor(runtime, a, out, batch);
    const receipt = await admitSends({ runtime, path: '/v1/emails/send' }, batch ? { emails: each.map(e => e.parsed) } : each[0]!.parsed, out, { actor: a }, { batch });
    return 'data' in receipt ? receipt.data : [receipt];
  }
  const receipt = await admitSends({ runtime, path: '/v1/emails/send' }, batch ? { emails: each.map(e => e.parsed) } : each[0]!.parsed, out, { credential, authorize }, { batch });
  return 'data' in receipt ? receipt.data : [receipt];
}
// Auth middleware calls this only for ordinary bearer keys, after the request size gate. Malformed inputs, mailbox
// tracking, provider-rendered templates, replies by In-Reply-To (whose thread depends on what the key can read,
// joinReplies) and marketing mail (whose footer needs the workspace's postal address before the statement that finds
// the workspace) keep their normal authenticated handler (including error ordering).
export async function tryAtomicKeyAdmission(c:Ctx,credentialCtes:(charge?:SQL)=>SQL) {
  if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return;
  await boundRequestBody(c);
  const body=await c.req.json().catch(()=>undefined), batch=c.req.path==='/v1/emails/batch';
  const parsed=batch?BatchInput.safeParse(body):SingleSendInput.safeParse(body);
  if(!parsed.success)return;
  const input=parsed.data,mails='emails' in input?input.emails:[input];
  // Fall through to the authenticated handler whenever front-door content screening may run (keeps Jev/JevF outside DB locks).
  if(!isSimulatedSes(c.env) && ((c.env.config.multiTenant && c.env.config.hostedScreen) || mails.some(m => m.screen && m.kind === 'transactional'))) return;
  if(('replyAddressId' in input && input.replyAddressId)||('replyMailboxId' in input && input.replyMailboxId)||('scheduledAt' in input && input.scheduledAt)||mails.some(m=>m.template || m.kind==='marketing' || isBuiltinHost(c.env.config,m.from.split('@')[1]!) || m.attachments.some(a=>a.includes('\0')) || m.headers?.some(h=>h.name.toLowerCase()==='in-reply-to')))return;
  const key=c.req.header('Idempotency-Key');if(key!==undefined && !validIdempotencyKey(key))return;
  if(batch && batchContent(mails)>SEND_LIMITS.batchContentChars)return;
  // The statement authenticates the key and answers 401, 429 and 403 before any admission answer. A duplicate of a
  // request still holding its Idempotency-Key is refused before it waits on the key's budget row, uncharged.
  const credential=credentialCtes(key===undefined?undefined:idempotencyGate(c.req.path,key));
  const authorize=(k:Principal):Actor=>{if(k.used!==null)checkBudget(c,k.used,k.max_requests);const a:Actor={keyId:k.id,workspaceId:k.workspace_id,permissions:k.permissions,domains:k.domains,credential:'apiKey'};c.set('actor',a);return actor(c,'send');};
  const call={runtime:c.env,path:c.req.path,key};
  return c.json(await batchMemory(mails,async()=>admitSends(call,input,await directMessages(c.env,mails,batch),{credential,authorize},{batch})),202);
}

/** The raw upload's body, at most MAX_ATTACHMENT_BYTES, read from the request stream without another copy when its length is known. */
async function uploadBody(request: Request, length: number | null, filename: string): Promise<Uint8Array> {
  const tooLarge = () => fileTooLarge(filename, null, MAX_ATTACHMENT_BYTES);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  try {
    if (length !== null) {
      const out = new Uint8Array(length);
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > length) throw new ApiError(400, 'REQUEST_BODY_INVALID', 'The body is longer than its Content-Length.');
        out.set(value, at); at += value.byteLength;
      }
      if (at !== length) throw new ApiError(400, 'REQUEST_BODY_INVALID', 'The body is shorter than its Content-Length.');
      return out;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw tooLarge();
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
    return out;
  } finally { void reader.cancel().catch(() => {}); }
}
/** How long a download's response may take to be read before it is ended and its file let go (tests shorten it). */
export const attachmentDownload = { idleMs: 6_000, readMs: 60_000 };
async function saveAttachment(c: Ctx, a: Actor, metadata: AttachmentMetadataInput, bytes: Uint8Array, max = MAX_ATTACHMENT_BYTES) {
  sesAttachment(metadata);
  const input = validateAttachment(metadata, bytes, max);
  const checksum = await bytesDigest(bytes);
  const upload=attachmentUpload(c.env,a,input,bytes,checksum,a.tokenId ?? a.keyId);
  try { return await idempotent(c.env.db,keyed(c,a),{...input,size:bytes.length,checksum},async db=>AttachmentInfo.parse(await upload.finish(db)),{prepare:upload.put}); }
  finally { await upload.refund(); }
}
function attachmentUpload(runtime:Runtime,a:Pick<Actor,'workspaceId'>,input:ReturnType<typeof validateAttachment>,bytes:Uint8Array,checksum:string,uploadedBy?:string){
  const attachmentId=id('attachment'),storageKey=uploadKey(a.workspaceId,attachmentId);
  const upload=uploadReservation(runtime,a.workspaceId,attachmentId,storageKey,bytes,input.contentType);
  return {
    put:upload.put,
    async finish(db:DbExecutor){
      await upload.claim(db);
      const [row]=await db.insert(attachments).values({id:attachmentId,workspaceId:a.workspaceId,uploadedBy,...input,storageKey,checksum,size:bytes.length}).returning();return row!;
    },
    refund:upload.refund,
  };
}
/** Reserve quota before uploading. No database connection is held during object storage I/O.
 * Unused uploads (including a concurrent idempotency loser) use ordinary attachment retention. */
export async function storeAttachmentBytes(runtime: Runtime, a: Pick<Actor,'workspaceId'>, metadata: { filename: string; contentType: string; disposition?: 'attachment' | 'inline'; contentId?: string }, bytes: Uint8Array, uploadedBy?: string) {
  sesAttachment(metadata);
  const parsed = AttachmentMetadata.safeParse({ filename: metadata.filename, contentType: metadata.contentType, disposition: metadata.disposition ?? 'attachment', ...(metadata.contentId ? { contentId: metadata.contentId } : {}) });
  if (!parsed.success) throw metadataInvalid(metadata, invalidMetadataFields(parsed.error.issues));
  const upload=attachmentUpload(runtime,a,validateAttachment(parsed.data,bytes),bytes,await bytesDigest(bytes),uploadedBy);
  try {await upload.put();return await runtime.db.transaction(upload.finish);}finally{await upload.refund();}
}
/** A mail app's signed or encrypted submission goes out as its own bytes (protocol-submit.ts sealedPassthrough). Nothing
 *  can be added to them, so not as bulk mail, which is held and sent as marketing. */
function passThrough(snapshot: EmailSnapshot, mime: string, bulk: boolean) {
  if (bulk) throw new ApiError(422, 'UNSUPPORTED_MESSAGE', 'Signed or encrypted mail can’t be sent as bulk mail.');
  snapshot.mime = mime;
}
export type MailboxSendRequest = { protocolEnvelope?:boolean; mime?: string; from: string; fromName?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; region?: string; subject: string; html?: string; text?: string; attachments: string[]; tracking?: boolean; screen?: boolean; sealed?: boolean; headers: { Name: string; Value: string }[] };
/** Queues one transactional email from a mailbox through the send admission and dispatch pipeline, with extra MIME
 * headers. Only sendFromMailbox calls it, under the send locks it holds. */
export async function queueMailboxEmail(runtime: Runtime, db: DbExecutor, held: SendScope, a: Actor, request: MailboxSendRequest, replyAuthors: string[] | null) {
  sesHeaders(request.headers.length);
  // A built-in domain stops sending once the workspace's own verifies, and its Reply-To stays at its own name, here as on POST /v1/emails/send.
  await assertBuiltinStillSends(runtime, db, a.workspaceId, [request.from]);
  assertBuiltinInput(runtime.config, [{ from: request.from, replyTo: request.replyTo, attachments: request.attachments }]);
  await assertBuiltinRecipients(runtime, db, a.workspaceId, [{ from: request.from, recipients: [...request.to, ...request.cc, ...request.bcc] }]);
  const schema = request.protocolEnvelope ? ProtocolSendInput : SendInput;
  const parsed = schema.safeParse({ from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}), to: request.protocolEnvelope?[...request.to,...request.cc,...request.bcc]:request.to, cc:request.protocolEnvelope?[]:request.cc, bcc:request.protocolEnvelope?[]:request.bcc, replyTo: request.replyTo, region: request.region, kind: 'transactional', subject: request.subject, ...(request.html ? { html: request.html } : {}), ...(request.text ? { text: request.text } : {}), attachments: request.attachments, tracking: request.tracking ?? false, screen: request.screen });
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Message fields are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
  for (const header of request.headers) if (!/^[!-9;-~]{1,126}$/.test(header.Name) || !/^[ -~]{1,995}$/.test(header.Value) || header.Name.length + header.Value.length > 996) throw new ApiError(422, 'INVALID_MIME_HEADER', `Header ${header.Name} is not a valid single-line ASCII header.`);
  // The same bulk evidence as POST /v1/emails/*, over the whole envelope and every header (threads, replies, forwards,
  // tracked sends and SMTP submissions all arrive here): bulk mail is charged and held as marketing.
  const [isBulk] = bulkFlags([{ kind: 'transactional', to: request.to, cc: request.cc, bcc: request.bcc, subject: request.subject, html: request.html, text: request.text,
    headers: [...(parsed.data.headers ?? []), ...request.headers.map(h => ({ name: h.Name, value: h.Value }))] }]);
  const snapshot = await prepare(parsed.data, null);
  if (request.mime) passThrough(snapshot, request.mime, !!isBulk);
  const cfg = runtime.config, oversize = cfg.screen && !isSimulatedSes(runtime) && cfg.hostedScreen ? await screenRefusal(runtime, snapshot) : undefined;
  const message: Outgoing = { snapshot, recipients: hostedCost(request.to, request.cc, request.bcc), marketing: !!isBulk, oversize };
  // The mailbox rules admitted this sender and these attachments; the sending log's reader rule is for other callers.
  const decided = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${await admission(runtime, a.workspaceId, actorJson(a),
    { stage: 'send', locks: held, mails: admissionMails(runtime, [message]), ...charges(runtime, [message]) }, undefined, actorAssets(a, snapshot.attachments, true))} AS s`)).rows[0]!.s,
    a.workspaceId, { oversize: () => oversize });
  const route = decided.mails[0]!;
  snapshot.region = route.region;
  if (route.binding) snapshot.binding = route.binding;
  if (route.connection) {
    const { rows: [lim] } = await db.execute<{ rate: number | null }>(sql`SELECT max_send_rate AS rate FROM provider_account_limits WHERE aws_account_id=${route.connection.aws_account_id} AND region=${route.region} AND max_send_rate>0`);
    a.dispatchAccount = { aws_account_id: route.connection.aws_account_id, kind: route.connection.kind, ...(typeof lim?.rate === 'number' && lim.rate > 0 ? { maxSendRate: lim.rate } : {}) };
  }
  if (isBulk) snapshot.bulk = true;
  if(request.protocolEnvelope){snapshot.to=request.to;snapshot.cc=request.cc;snapshot.bcc=request.bcc;snapshot.mailApp=true;}
  snapshot.headers = [...snapshot.headers, ...request.headers];
  snapshot.untrustedContent = replyAuthors !== null || snapshot.headers.some(h => h.Name.toLowerCase() === 'in-reply-to');
  if (replyAuthors !== null) snapshot.replyAuthors = replyAuthors;
  if (request.sealed) snapshot.sealed = true;
  snapshot.mailbox = true;
  message.snapshot = snapshot;
  await checkRecipientsEligible(db, a.workspaceId, [message], false);
  if (mayScreenAtAccept(runtime, [message])) {
    const prob = cfg.multiTenant ? (await db.execute<{ p: ProbationReason | null }>(sql`SELECT ${probationReason(sql`${a.workspaceId}`)} AS p`)).rows[0]?.p !== null : false;
    await screenOutgoingAtAccept(runtime, a, [message], decided, prob, false, db);
  }
  const receipt = await queueEmail(runtime, db, a, message.snapshot, message.emailId, !!message.countScreened, !message.heldForScreen);
  return { emailId: receipt.id, snapshot: message.snapshot };
}
/** An agent (API key or MCP) read or saved this draft: anyone with it open sees it for two minutes (src/campaign-room.ts),
 *  and a save (saved: its revision) shows on their pages at once, with the agent's name. In the background, only where
 *  rooms exist (the Worker), and only for a campaign that can still be edited. People are in the room through their own
 *  socket, and their tab tells it they saved. */
function agentVisit(c: Ctx, a: Actor, campaign: typeof campaigns.$inferSelect, saved?: number) {
  if (!c.env.campaignRooms || !(a.credential === 'apiKey' || a.credential === 'mcp' || a.credential === 'agentToken') || campaign.archivedAt || !campaignEditable(campaign)) return;
  c.env.campaignRooms.visit(roomName(a.workspaceId, campaign.id), a.keyId, runtime => import('./ritual-version.js').then(({ credentialName }) => credentialName(runtime.db, a)), saved);
}
function editable(row: typeof campaigns.$inferSelect, revision?: number) {
  if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before editing, reviewing or sending it.');
  if (revision !== undefined && row.revision !== revision) throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign has changed; fetch it and review again.');
  if (!campaignEditable(row)) throw new ApiError(409, 'CAMPAIGN_LOCKED', row.state === 'failed' ? 'This campaign already released recipients; resume or cancel it instead of changing it.' : 'Only drafts and failed campaigns that released nothing may be changed.');
}
/** Rejects campaign html outside the block vocabulary with the offending tag or attribute named. */
async function assertBlockContent(html: string | undefined, complete = false) {
  if (!html) return;
  const { validateBlockHtml, BlockContentError } = await loadCampaignBlocks();
  try { validateBlockHtml(html, { complete }); } catch (error) {
    if (error instanceof BlockContentError) throw new ApiError(422, 'CAMPAIGN_CONTENT_INVALID', error.message, 'html');
    throw error;
  }
}
/** Block HTML becomes the styled email plus a plain-text alternative. Legacy drafts fail here with the block error until re-saved. */
async function renderCampaignContent(runtime: Runtime, draft: Pick<CampaignDraft, 'html' | 'subject'>, complete = true): Promise<{ html: string | undefined; text: string | undefined }> {
  if (!draft.html?.trim()) return { html: undefined, text: undefined };
  await assertBlockContent(draft.html, complete);
  const { renderBlockHtml, renderBlockText } = await loadCampaignBlocks();
  return { html: renderBlockHtml(draft.html, { title: draft.subject }), text: renderBlockText(draft.html) || undefined };
}
/** A campaign, in one read with the footer its copies show: the postal address its launch froze, or the workspace's
 *  while it is still editable (campaignEditable). */
async function campaignWithFooter(runtime: Runtime, a: Actor, campaignId: string): Promise<{ row: typeof campaigns.$inferSelect; footer: Footer }> {
  const frozen = sql`${campaigns.reviewId} IS NOT NULL AND NOT (${campaigns.state}='draft' OR (${campaigns.state}='failed' AND ${campaigns.expanded}=0))`;
  // The link host its copies use (src/link-domains.ts): the one its launch froze, else the sender's active one now.
  const sender = sql`lower(split_part(${campaigns.draft}->>'from','@',2))`;
  const [found] = await runtime.db.select({ row: campaigns, address: sql<string | null>`CASE WHEN ${frozen}
      THEN (SELECT r.draft->>'postalAddress' FROM sending_campaign_reviews r WHERE r.workspace_id=${a.workspaceId} AND r.id=${campaigns.reviewId})
      ELSE ${postalAddressOf(runtime.config.multiTenant, a.workspaceId)} END`,
    link: sql<string | null>`coalesce(CASE WHEN ${frozen} THEN (SELECT r.draft->>'linkOrigin' FROM sending_campaign_reviews r WHERE r.workspace_id=${a.workspaceId} AND r.id=${campaigns.reviewId}) END,
      (SELECT 'https://'||h.hostname FROM link_hosts h WHERE h.workspace_id=${a.workspaceId} AND h.status='active' AND (h.domain=${sender} OR right(${sender},length(h.domain)+1)='.'||h.domain) ORDER BY length(h.domain) DESC LIMIT 1))` })
    .from(campaigns).where(campaignWhere(a, campaignId));
  if (!found) return notFound('Campaign');
  // Without one, the link domain its copies would link on now, unless the workspace is paused (src/link-domains.ts): its
  // tests and previews show it. Nothing is recorded: a test is transactional, and its copies record as they are released.
  const link = found.link ?? (runtime.config.linkHost && !found.row.draft.requiredNotice
    ? (await linkChoice(runtime, runtime.db, a.workspaceId, found.row.draft.from).catch(() => null))?.origin : undefined);
  return { row: found.row, footer: { unsubscribePageUrl: found.row.draft.unsubscribePageUrl, postalAddress: found.address, requiredNotice: found.row.draft.requiredNotice, ...link ? { linkOrigin: link } : {} } };
}
// A draft's topic counts its opt-outs as not eligible, archived or not: archiving lets none of them through.
const displayAudience = async (runtime: Runtime, a: Actor, draft: CampaignDraft, spec: z.infer<typeof AudienceSpec>) => {
  const [m, topic] = await Promise.all([wrapModuleLoad(() => import('./audience.js')), campaignTopic(runtime.db, a.workspaceId, draft, false)]);
  return m.countCampaignAudienceForDisplay(runtime.db, a, spec, draft.requiredNotice === true, topic);
};
type DisplayAudience = ReturnType<typeof displayAudience>;

async function savedCampaignAudience(runtime: Runtime, a: Actor, row: typeof campaigns.$inferSelect, shared?: DisplayAudience, withReadiness = false) {
  const audience = AudienceSpec.safeParse(row.draft.audience);
  if (!audience.success) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Choose an audience list before counting recipients.', 'audience.listId');
  const counts = await (shared ?? displayAudience(runtime, a, row.draft, audience.data));
  if (row.audienceEstimate !== counts.eligible) {
    // Review's revision-bound read mustn't write its estimate over a teammate's newer saved draft.
    await runtime.db.execute(sql`UPDATE sending_campaigns SET audience_estimate = ${counts.eligible}
      WHERE workspace_id = ${a.workspaceId} AND id = ${row.id} ${shared ? sql`AND revision = ${row.revision}` : sql``}`).catch(() => {});
  }
  // The send review, when asked for: a marketing campaign with a sender. The never-mailed count is its own bounded read.
  if (!withReadiness) return AudienceCounts.parse(counts);
  let readiness: z.infer<typeof CampaignReadiness> | null = null;
  if (!row.draft.requiredNotice && row.draft.from) {
    const audienceMod = await wrapModuleLoad(() => import('./audience.js'));
    const lastSent = await audienceMod.listLastSent(runtime.db, a, audience.data.listId);
    const neverMailed = await audienceMod.countNeverMailed(runtime.db, a, audience.data, false, lastSent, await campaignTopic(runtime.db, a.workspaceId, row.draft, false));
    readiness = await sendReadiness(runtime, runtime.db, a, row, { recipients: counts.eligible, matched: counts.matched, risky: counts.risky, neverMailed, lastSent });
  }
  return AudienceCounts.parse({ ...counts, readiness });
}

async function advisoryCheck(runtime: Runtime, a: Actor, mail: CheckMail, source: 'draft' | 'email' | 'campaign') {
  const domain = splitMailbox(mail.from).address.split('@').at(-1)!.toLowerCase();
  // Name the domain only when the caller sent it: a stored email's or campaign's sender is named by ID.
  if (!senderDomainAllowed(a.domains, domain)) throw denied('DOMAIN_NOT_ALLOWED', 'The From domain is outside this key’s scope.', { permission: 'sendEmail', level: 'on', ...(source === 'draft' ? { scope: `domain:${domain}` as const } : {}) }, 'from');
  const [{ checkMail }, { checkContext }] = await Promise.all([wrapModuleLoad(() => import('./sendability.js')), wrapModuleLoad(() => import('./sendability-context.js'))]);
  const context = await checkContext(runtime, a, domain);
  return checkMail(mail, source === 'campaign' ? { ...context, screenLimitBytes: runtime.config.screenLimits.campaignBytes } : context);
}

async function campaignAdvisory(runtime: Runtime, a: Actor, { row, footer }: Awaited<ReturnType<typeof campaignWithFooter>>, shared?: DisplayAudience) {
  const d = row.draft, audience = AudienceSpec.safeParse(d.audience);
  const [rendered, recipients, files] = await Promise.all([renderCampaignContent(runtime, d, false), row.reviewId ? row.total : audience.success && !a.domains.length
    ? (shared ?? displayAudience(runtime, a, d, audience.data)).then(r => r.eligible) : undefined, attachmentRows(runtime.db, a, d.attachments)]);
  if (!d.from || (!rendered.html && !rendered.text)) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Set a sender and add content before checking this campaign.', 'campaignId');
  const mail: CheckMail = { from: d.from, fromName: d.fromName, subject: d.subject, ...rendered, previewText: d.previewText, tracking: d.tracking,
    ...d.requiredNotice ? { stream: 'transactional' as const } : { stream: 'marketing' as const, generatedUnsubscribe: true, postalAddress: !!footer.postalAddress },
    recipientCount: recipients === undefined ? undefined : Math.min(recipients, row.pacePerDay ?? Infinity), attachments: files, headers: d.replyTo?.[0] ? { 'Reply-To': d.replyTo[0] } : undefined };
  return advisoryCheck(runtime, a, mail, 'campaign');
}

async function reviewPart<T>(c: Ctx, read: Promise<T>) {
  try { return { data: await read } as const; }
  catch (error) {
    const { responseError, known, transient, conflict } = describeApiFailure(error), requestId = c.get('requestId');
    if (!known && responseError.status >= 500) logError(error, { requestId, route: 'campaign.review-display', code: responseError.code, status: responseError.status });
    return { status: responseError.status, error: apiFailureBody(responseError, requestId), ...(transient || conflict ? { retryAfter: 1 } : {}) } as const;
  }
}

/** A campaign's preview: its rendered draft with the footer its emails get, the link a placeholder on the link host
 *  its launch would use. A draft that couldn't launch for want of one shows this installation's own: it is never sent. */
async function previewParts(runtime: Runtime, workspaceId: string, draft: CampaignDraft, footer: Footer) {
  const rendered = await renderCampaignContent(runtime, draft, false);
  if (!rendered.html && !rendered.text) return rendered;
  let origin = runtime.config.publicUrl;
  if (!footer.requiredNotice) try { origin = foundLinkOrigin(runtime.config, workspaceId, draft.from, footer.linkOrigin); } catch { /* Never sent: shown as this installation's own. */ }
  footerParts(rendered, unsubscribePlaceholder(origin), footer);
  return rendered;
}
const RECIPIENT_CONTENT_ERRORS = new Set(['CAMPAIGN_RECIPIENT_INVALID', 'MISSING_TEMPLATE_VARIABLE', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'UNSAFE_TEMPLATE_CONTEXT', 'UNSAFE_HTML_URL', 'ENCODED_MESSAGE_TOO_LARGE', 'RENDERED_CONTENT_TOO_LARGE']);
// rendered: the content the review already rendered and checked, or undefined to render the draft now (a test).
// rows: the campaign's attachments that size each copy, or null when admission sizes it (a test).
async function campaignMessage(runtime: Runtime, draft: CampaignDraft, contact: ReviewedRecipient, test: boolean, rows: AttachmentFacts[] | null, rendered?: { html?: string; text?: string }, templateValidated = false, htmlValidated = false, version = CAMPAIGN_RENDERER_VERSION) {
  try {
    const values = { ...draft.defaults, ...Object.fromEntries(Object.entries(contact.properties).filter(([, value]) => value !== null && value !== undefined)), email: contact.email, ...(contact.name ? { name: contact.name } : {}) };
    rendered ??= await renderCampaignContent(runtime, draft);
    const parse = rendered.html && (!templateValidated || draft.previewText) ? await loadParse5() : undefined;
    const parsed = SendInput.safeParse({ from: draft.from, fromName: draft.fromName, to: contact.email, replyTo: draft.replyTo, region: test ? campaignSendRegion(runtime,draft) : draft.region, kind: test ? 'transactional' : 'marketing', subject: interpolate(draft.subject, values, false, templateValidated), html: withPreheader(interpolate(rendered.html, values, true, templateValidated, parse), draft.previewText, parse, version), text: interpolate(rendered.text, values, false, templateValidated), attachments: draft.attachments, tracking: test ? false : draft.tracking });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))].join(', ');
      throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Recipient or rendered message is invalid (${fields}).`);
    }
    const snapshot = await prepare(parsed.data, rows, htmlValidated);
    if (draft.previewText !== undefined) snapshot.previewText = draft.previewText;
    return snapshot;
  } catch (error) {
    // Add only a contact identifier to known local validation failures; never rewrite database/provider errors.
    if (error instanceof ApiError && RECIPIENT_CONTENT_ERRORS.has(error.code)) {
      // A test has no contact: name the sample data that fills the gap instead of an internal recipient id.
      if (test && error.code === 'MISSING_TEMPLATE_VARIABLE') throw new ApiError(error.status, error.code, `This email uses {{${error.field}}} but the test has no value for it. Add a fallback value for ${error.field} (defaults.${error.field}) or a sample value (data.${error.field}).`, `data.${error.field}`, error.retryable);
      throw new ApiError(error.status, error.code, test ? error.message : `Contact ${contact.id}: ${error.message}`, test ? error.field : 'contactId', error.retryable);
    }
    throw error;
  }
}

/**
 * The front door of a Hosted campaign test (CAMPAIGN_TESTS), in one statement before the screen reads it: its address is
 * the workspace's own (the members rule is the built-in domain's, migration 501), and this hour has room, which it takes.
 * A domain counts only while its verification is current: one whose records went missing ('lost', still sending through
 * its grace period) proves nothing about who receives there now.
 */
async function admitCampaignTest(runtime: Runtime, a: Actor, to: string) {
  if (!runtime.config.multiTenant) return;
  const address = to.toLowerCase(), host = address.split('@')[1]!;
  const { rows: [gate] } = await runtime.db.execute<{ own: boolean; charged: boolean; reset_at: string }>(sql`WITH own AS (SELECT ${!realDestination(address)}
      OR EXISTS (SELECT FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=${a.workspaceId} AND u.email_verified AND lower(u.email)=${address})
      OR EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id=${a.workspaceId} AND dc.sending_state='verified' AND (dc.name=${host} OR right(${host},length(dc.name)+1)='.'||dc.name)) AS ok),
    charge AS (INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) SELECT ${a.workspaceId},'campaign-test',date_trunc('hour',now()),1 FROM own WHERE ok
      ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
      WHERE b.window_start<>excluded.window_start OR b.used<${CAMPAIGN_TESTS.perHour} RETURNING 1)
    SELECT (SELECT ok FROM own) AS own, EXISTS (SELECT FROM charge) AS charged, date_trunc('hour',now())+interval '1 hour' AS reset_at`);
  if (!gate!.own) throw new ApiError(422, 'TEST_RECIPIENT_NOT_OWNED', `A campaign test goes only to an address this workspace has proven is its own: a member’s verified email or an address at one of its currently verified domains, its receiving addresses and inboxes included. Send the campaign to reach ${to}.`, 'to');
  if (!gate!.charged) {
    const resetAt = new Date(gate!.reset_at).toISOString();
    throw new ApiError(429, 'CAMPAIGN_TEST_LIMIT', `A workspace sends at most ${CAMPAIGN_TESTS.perHour} campaign tests an hour, and this hour’s are used. Try again after ${resetAt.slice(11, 16)} UTC.`, undefined, true, resetAt);
  }
}

/**
 * The dashboard's test email (POST /v1/domains/{id}/test-send), to the signed-in user: fixed content from hello@<domain>,
 * or onboarding's setup email (setup-email.ts) from "<productName> Setup" <setup@domain> with the subject and text they
 * wrote. Without them, or with onboarding's own words, the content is ours. It reads as a real first email, plain text:
 * "test" and placeholder wording in a subject or body send mail to spam.
 */
export const platformTestEmail = (domain: string, custom?: { subject: string; text: string }) => {
  if (custom) return { from: `${SETUP_SENDER.local}@${domain}`, fromName: SETUP_SENDER.name, subject: custom.subject, text: custom.text };
  const from = `hello@${domain}`;
  return { from, fromName: undefined, subject: `Your first email from ${productName}`, text: `Hi,\n\n${domain} is set up, and this is the first email sent from ${from}.\n\nThanks,\n${productName}\n` };
};
/**
 * The content screen's verdict for the dashboard's test email: its words are ours (the fixed test, or onboarding's setup
 * email as the dashboard wrote it) and it goes only to the person who asked for it, so there is nothing for the
 * classifier to judge, and Hosted dispatch (which sends nothing without a verdict) takes this one, recorded as such.
 * Anything else, a changed word, another or a further recipient, a header, an attachment or HTML, gets no verdict here
 * and is screened as usual.
 */
export function platformTestVerdict(s: EmailSnapshot, to: string, rules: 'probation' | 'standard' | null): EmailSnapshot['screenVerdict'] {
  const domain = s.from.split('@')[1] ?? '';
  const ours = [platformTestEmail(domain), platformTestEmail(domain, SETUP_EMAIL)].some(fixed => s.from === fixed.from && (s.fromName ?? undefined) === fixed.fromName && s.subject === fixed.subject && s.text === fixed.text);
  const exact = ours && s.html === undefined && s.kind === 'transactional'
    && s.to.length === 1 && s.to[0]!.toLowerCase() === to.toLowerCase() && !s.cc.length && !s.bcc.length && !s.replyTo.length && !s.attachments.length
    && !s.headers.length && !s.template && !s.raw && !s.mime;
  return exact ? { status: 'platform', reason: 'platform test email', rules } : undefined;
}
export async function admitTestEmail(c: Ctx, a: Actor, domain: string, to: string, custom?: { subject: string; text: string }) {
  const { fromName, ...mail } = platformTestEmail(domain, custom);
  return Receipt.parse(await admitEmails(sendCall(c), a, SingleSendInput.parse({ ...mail, ...fromName ? { fromName } : {}, to: [to] }), undefined, false, to));
}

export function registerSending(app: App) {
  registerPreviewImages(app);
  app.openapi(createRoute({method:'post',path:'/v1/emails/check',operationId:'checkEmail',tags:['Emails'],security,
    summary:'Check email sendability without sending', description:`Read-only 0–100 advisory score, not an inbox-placement probability or admission decision. Supply one draft (HTML or text), outbound email ID, or campaign ID. Uses visible retained content, cached From-domain facts, and workspace reputation for unrestricted readers. No DNS/asset fetches or paid screen. Scores use current evidence, not a historical delivery verdict. HTML has the preview lint’s 256 KiB UTF-8 and tree budgets. Marketing drafts are checked as supplied; ${productName} adds the unsubscribe headers, the link and the workspace’s postal address to campaigns and to marketing mail it sent, so those are checked as sent. Each finding’s fix is one plain sentence and fixIn says where it is made. MIME bytes are estimated.`,
    request:{body:json(CheckInput)},responses:{200:response(CheckResult),...errors}}),async c=>{
    const a=actor(c,'read'), input=c.req.valid('json'); let mail:CheckMail;
    if ('emailId' in input) {
      const row=await findEmail(c.env.db,a,input.emailId);
      // Rehydrate the frozen campaign snapshot once so From name, headers, and tracking describe the same copy as the body.
      const s=sentCampaignEmail(row.snapshot) ? await sentCampaignContent(c.env,a,row) : row.snapshot;
      const body=await visibleEmailContent(c.env,a,{...row,snapshot:s},row.untrustedContent);
      if (!body.html && !body.text) throw new ApiError(422,'EMAIL_BODY_UNAVAILABLE','No retained HTML or plain text is available for checking.','emailId');
      // A required notice is checked as the transactional message it is: it has no unsubscribe, by design.
      const notice=!!row.snapshot.requiredNotice;
      mail={from:row.from,fromName:s.fromName,subject:body.subject??'',stream:notice ? 'transactional' : s.kind??'transactional',text:body.text??undefined,html:body.html??undefined,
        headers:Object.fromEntries([...(s.headers??[]).map(h=>[h.Name,h.Value]),...(s.replyTo?.length ? [['Reply-To',s.replyTo[0]!]] : [])]),
        // Marketing mail went out with the unsubscribe headers and link (and the workspace's postal address) Nightmail adds, however its copy is stored.
        previewText:s.previewText,tracking:s.tracking,...(s.kind==='marketing' && !notice ? {generatedUnsubscribe:true,postalAddress:!!await workspacePostalAddress(c.env,c.env.db,a.workspaceId)} : {}),attachments:await attachmentRows(c.env.db,a,body.attachments,false,!!s.mailbox && !!actorMailAccess(a))};
    } else if ('campaignId' in input) {
      return c.json(await campaignAdvisory(c.env, a, await campaignWithFooter(c.env, a, input.campaignId)), 200);
    } else mail=input;
    return c.json(await advisoryCheck(c.env, a, mail, mail === input ? 'draft' : 'email'), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/send', operationId: 'sendEmail', description: `${SCREEN_LIMIT_NOTE} ${RAMP_NOTE} ${BUILTIN_NOTE} ${ATTACHMENT_NOTE}`, tags: ['Emails'], security, request: { headers: SendIdempotencyHeaders, body: json(SingleSendInput) }, responses: { 202: response(SingleReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const replyAddressId = input.replyAddressId ?? input.replyMailboxId;
    if (replyAddressId) {
      if (a.domains.length || !a.permissions.includes('manage')) throw denied('MAILBOX_ACCESS_REQUIRED', 'Use manage permission on all domains, or start the thread with a key limited to that address.', { permission: 'sendEmail', level: 'on', scope: `address:${replyAddressId}` });
      if (input.html) await validateHtmlUrls(input.html);
      const { finishMailboxArchive, trackedAttachments, queueTrackedMailboxSend } = await wrapModuleLoad(() => import('./mailbox-send.js'));
      let files:Awaited<ReturnType<typeof trackedAttachments>>=[];
      const result = await idempotent(c.env.db, keyed(c, a), input, tx => queueTrackedMailboxSend(c.env, tx, a, replyAddressId, input, input.replyAddressId ? 'replyAddressId' : 'replyMailboxId',files),{prepare:input.attachments.length ? async()=>{files=await trackedAttachments(c.env,a,replyAddressId,input);} : undefined});
      if(input.attachments.length)await finishMailboxArchive(c.env,a.workspaceId,result.mailboxMessageId);
      return c.json(SingleReceipt.parse({ ...result, inboundMessageId: result.mailboxMessageId }), 202);
    }
    const result = await admitEmails(sendCall(c), a, input, input.scheduledAt && new Date(Date.parse(input.scheduledAt)).toISOString());
    return c.json(SingleReceipt.parse({ ...result, ...recipientWarnings(sendRecipients(input)) }), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/batch', operationId: 'sendEmailBatch', description: `${SCREEN_LIMIT_NOTE} ${RAMP_NOTE} ${BUILTIN_NOTE} ${ATTACHMENT_NOTE}`, tags: ['Emails'], security, request: { headers: SendIdempotencyHeaders, body: json(BatchInput) }, responses: { 202: response(BatchReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (batchContent(input.emails) > SEND_LIMITS.batchContentChars) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Combined batch body content may not exceed ${SEND_LIMITS.batchContentChars / 1024 / 1024} MiB.`);
    const result = await batchMemory(input.emails, () => admitEmails(sendCall(c), a, input), { workspaceId: a.workspaceId, signal: c.req.raw.signal });
    const receipts = (result as { data: SendReceipt[] }).data;
    return c.json(BatchReceipt.parse({ data: receipts.map((receipt, i) => ({ ...receipt, ...recipientWarnings(sendRecipients(input.emails[i]!)) })) }), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/preview', operationId: 'previewEmail', tags: ['Emails'], security,
    summary: 'Preview HTML in selected email clients',
    description: 'Read-only offline emulation, not a screenshot. Supply HTML or an outbound email ID; stored HTML has the same access and redaction as getEmailContent. Render untrusted output only via iframe.srcdoc with sandbox=""; the embedded CSP blocks remote assets. Results follow the requested client order. Classic Outlook is lint only (empty html). New Outlook for Windows models Outlook web; actual client behavior is unverified. Input over 256 KiB UTF-8, excessive document complexity, or combined output HTML over 4 MiB returns 413.',
    request: { body: json(EmailPreviewInput) }, responses: { 200: response(EmailPreviews), ...errors },
  }), async c => {
    const a = actor(c), input = c.req.valid('json');
    let html: string;
    if ('emailId' in input) {
      const row = await findEmail(c.env.db, a, input.emailId);
      const content = await visibleEmailContent(c.env, a, row, row.untrustedContent);
      if (!content.html) throw new ApiError(422, 'EMAIL_HTML_UNAVAILABLE', 'This email has no retained HTML to preview.', 'emailId');
      html = content.html;
    } else html = input.html;
    const { emulateMany, PreviewLimitError } = await loadEmailPreview();
    try {
      return c.json({ previews: emulateMany(html, { clients: input.clients, theme: input.theme, device: input.device }) }, 200);
    } catch (error) {
      if (error instanceof PreviewLimitError) throw new ApiError(413, 'EMAIL_PREVIEW_LIMIT_EXCEEDED', error.message);
      throw error;
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails', operationId: 'listEmails', description: `Sent emails, newest first. from and to (or since and until) are ISO 8601 times that bound when an email was created, not addresses: filter by sender or recipient address with search. Pages are also bounded by response size and may return fewer than limit emails; follow nextCursor while non-null. ${readLimitNote(READ_LIMIT.emails)}`, tags: ['Emails'], security, request: { query: EmailQuery }, responses: { 200: response(page(Email)), ...errors } }), async c => {
    // since and until are from and to by other names: one filter, so a cursor serves either.
    // Only bounds that were sent: an absent one stays absent, as cursors already issued were bound without it.
    const { since, until, ...named } = c.req.valid('query'), q = { ...named, ...since ? { from: since } : {}, ...until ? { to: until } : {} };
    const a = actor(c), binding = await pageBinding(a, 'emails', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    const maxBytes = Math.min(EMAIL_LIST_MAX_BYTES, responseByteLimit(c.req.raw) ?? EMAIL_LIST_MAX_BYTES);
    const where = and(mailWhere(a),
      cursor ? sql`(${emails.createdAt}, ${emails.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.campaignId ? eq(emails.campaignId, q.campaignId) : undefined, q.status === 'queued' ? inArray(emails.status, ['queued', 'scheduled']) : q.status ? eq(emails.status, q.status) : undefined,
      q.region ? eq(emails.region, q.region) : undefined, q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined,
      q.from ? gte(emails.createdAt, q.from) : undefined, q.to ? lt(emails.createdAt, q.to) : undefined,
      search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${search}` : undefined,
    );
    type RawEmailRow = { untrusted_content: boolean; id: string; region: string; campaign_id: string | null; from_address: string; from_name: string | null; kind: 'transactional' | 'marketing'; to_addresses: string[]; cc_addresses: string[]; bcc_addresses: string[]; subject: string; status: EmailStatus; provider_id: string | null; simulated: boolean; attempt_started_at: string | null; error_code: string | null; suppression_reason: string | null; scheduled_at: string | null; created_at: string; updated_at: string; candidate_count: number };
    const { rows } = await budgetedRead(c.env.db, db => db.execute<RawEmailRow>(sql`
      WITH candidate AS (
        SELECT (${sentUntrustedContent}) AS untrusted_content,
          ${emails.id} AS id, ${emails.region} AS region, ${emails.campaignId} AS campaign_id,
          ${emails.from} AS from_address,
          coalesce(${emails.snapshot}->>'fromName', CASE WHEN ${emails.reviewId} IS NOT NULL THEN (SELECT draft->>'fromName' FROM sending_campaign_reviews cr WHERE cr.id = ${emails.reviewId} AND cr.workspace_id = ${emails.workspaceId}) END) AS from_name,
          ${emails.snapshot}->>'kind' AS kind,
          ${emails.to} AS to_addresses, ${emails.cc} AS cc_addresses, ${emails.bcc} AS bcc_addresses,
          ${emails.subject} AS subject, ${emails.status} AS status, ${emails.providerId} AS provider_id,
          ${emails.simulated} AS simulated, ${emails.attemptStartedAt} AS attempt_started_at,
          ${emails.errorCode} AS error_code, ${emails.suppressionReason} AS suppression_reason,
          ${emails.scheduledAt} AS scheduled_at, ${emails.createdAt} AS created_at, ${emails.updatedAt} AS updated_at,
          (octet_length(${emails.to}::text) + octet_length(${emails.cc}::text) + octet_length(${emails.bcc}::text) + octet_length(${emails.subject}) + 512) AS row_bytes
        FROM ${emails} WHERE ${where}
        ORDER BY ${emails.createdAt} DESC, ${emails.id} DESC LIMIT ${q.limit + 1}
      ), sized AS (
        SELECT *, row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn,
          sum(row_bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS cum_bytes
        FROM candidate
      )
      SELECT untrusted_content, id, region, campaign_id, from_address, from_name, kind,
        to_addresses, cc_addresses, bcc_addresses, subject, status, provider_id, simulated,
        attempt_started_at::text, error_code, suppression_reason, scheduled_at::text,
        created_at::text, updated_at::text,
        (SELECT count(*)::int FROM candidate) AS candidate_count
      FROM sized WHERE rn = 1 OR cum_bytes <= ${maxBytes}
      ORDER BY rn`), readLimit(READ_LIMIT.emails));
    const candidateCount = rows[0]?.candidate_count ?? 0;
    const rawPage = rows.slice(0, q.limit);
    const items = rawPage.map(r => emailView(listedSubject(a, {
      untrustedContent: r.untrusted_content, id: r.id, region: r.region, campaignId: r.campaign_id,
      from: r.from_address, fromName: r.from_name, kind: r.kind, to: r.to_addresses, cc: r.cc_addresses,
      bcc: r.bcc_addresses, subject: r.subject, status: r.status, providerId: r.provider_id,
      simulated: r.simulated, attemptStartedAt: r.attempt_started_at, errorCode: r.error_code,
      suppressionReason: r.suppression_reason, scheduledAt: r.scheduled_at, createdAt: r.created_at, updatedAt: r.updated_at,
    })));
    const rawById = new Map(rawPage.map(r => [r.id, r.created_at]));
    const bounded = buildBoundedPageJson(items, candidateCount > items.length, maxBytes);
    const encodedNext = bounded.nextCursor ? encodeCursor({ id: bounded.nextCursor, createdAt: rawById.get(bounded.nextCursor) ?? items[bounded.count - 1]!.createdAt }, binding) : null;
    const payload = encodedNext
      ? bounded.json.slice(0, bounded.json.lastIndexOf(',"nextCursor":')) + ',"nextCursor":' + JSON.stringify(encodedNext) + '}'
      : bounded.json;
    return c.body(payload, 200, { 'content-type': 'application/json; charset=UTF-8' }) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}', operationId: 'getEmail', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => {
    const a = actor(c), [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(a, c.req.valid('param').id)).limit(1);
    return c.json(emailView(listedSubject(a, row ?? notFound('Email'))), 200);
  });
  const emailSnapshotBytes = async (db: DbExecutor, a: Actor, emailId: string) => {
    const [probe] = await db.select({ bytes: sql<number>`coalesce(octet_length(${emails.snapshot}::text), 0)::int` }).from(emails).where(mailWhere(a, emailId)).limit(1);
    if (!probe) notFound('Email');
    return probe.bytes;
  };
  app.openapi(createRoute({ method:'get', path:'/v1/emails/{id}/detail', operationId:'getEmailDetail', tags:['Emails'], security,
    description:'One log detail: metadata, visible HTML/text, attachment IDs, the first 100 events, active contact for a single To address, and the conversation the email belongs to. Uses the same content and event redaction as their individual endpoints; no raw MIME. Continue events with listEmailEvents.',
    request:{params:IdParams},responses:{200:response(z.object({email:Email,content:EmailContent.pick({html:true,text:true,attachments:true}),events:page(Event),contact:z.object({id:z.string(),suppressed:z.boolean(),suppressedAt:z.string().nullable().describe('When the address was suppressed (UTC). Null when it is not suppressed, and for a suppression from before these dates were kept.')}).nullable(),
      thread:EmailThread.nullable().describe('The conversation: of a reply from a receiving address or inbox, or of an email whose In-Reply-To named a stored message its sender could read, with the messages around it that you can read. Null for an email in none, when you can read none of the conversation\'s received or stored messages, and for credentials that cannot read received mail.')}).openapi('EmailDetail')),...errors} }),async c=>{
    const a=actor(c), emailId=c.req.valid('param').id, access=actorMailAccess(a);
    const snapBytes = await emailSnapshotBytes(c.env.db, a, emailId);
    assertResponseWithinLimit(c.req.raw, snapBytes + 16384);
    const run = async (): Promise<Response> => {
      const [detail]=await c.env.db.select({mail:emails,fromName:emailColumns.fromName,untrustedContent:sentUntrustedContent,
        contact:a.domains.length ? sql<null>`NULL` : sql<{id:string;suppressed:boolean;suppressedAt:string|null}|null>`(SELECT jsonb_build_object('id',c.id,'suppressed',c.suppressed,'suppressedAt',CASE WHEN c.suppressed THEN c.suppressed_at END) FROM audience_contacts c
          WHERE c.workspace_id=sending_emails.workspace_id AND c.deleted_at IS NULL AND jsonb_array_length(sending_emails.to_addresses)=1 AND c.email=lower(sending_emails.to_addresses->>0))`,
        timeline:sql<z.input<typeof Event>[]>`(SELECT coalesce(jsonb_agg(t ORDER BY t."createdAt"::timestamptz,t.id),'[]') FROM (
          SELECT id,email_id AS "emailId",type,provider_id AS "providerId",simulated,created_at::text AS "createdAt",data FROM sending_email_events
          WHERE workspace_id=sending_emails.workspace_id AND email_id=sending_emails.id ORDER BY created_at,id LIMIT 101) t)`,
        thread:access ? threadBlock(access,{thread:sentThreadId,focus:sql`sending_emails.id`,sends:true}) : sql<RawThread|null>`NULL`,
      }).from(emails).where(mailWhere(a,emailId)).limit(1);
      if(!detail) return notFound('Email');
      const {mail,contact,timeline,untrustedContent}=detail, {html,text,attachments}=await visibleEmailContent(c.env,a,mail,untrustedContent);
      const thread=threadView(detail.thread,a.permissions.includes('manage'));
      const email=emailView({...mail,untrustedContent,subject:a.permissions.includes('manage') ? mail.subject : redactCapabilityText(mail.subject),fromName:detail.fromName,kind:mail.snapshot.kind});
      return c.json({email,content:{html,text,attachments},contact,thread,events:{data:timeline.slice(0,100).map(r=>visibleEmailEvent(a,r)),nextCursor:nextCursor(timeline as {id:string;createdAt:string}[],100,`email-events:${mail.id}`)}},200);
    };
    return (snapBytes > LARGE_READ_RESERVE_THRESHOLD ? await withBoundedRead(c, () => run(), { route: 'email.detail', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/content', operationId: 'getEmailContent', description: 'Manage keys receive full snapshots. Other readers receive app unsubscribe tokens redacted from subject/HTML/text and raw MIME withheld (null), since MIME encodings can conceal capabilities. Other transactional bearer links are not sanitized; grant content-read access only to trusted integrations.', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(EmailContent), ...errors } }), async c => {
    const a = actor(c), emailId = c.req.valid('param').id;
    const snapBytes = await emailSnapshotBytes(c.env.db, a, emailId);
    assertResponseWithinLimit(c.req.raw, snapBytes + 4096);
    const run = async (): Promise<Response> => {
      const row = await findEmail(c.env.db, a, emailId);
      return c.json(await visibleEmailContent(c.env, a, row, row.untrustedContent), 200);
    };
    return (snapBytes > LARGE_READ_RESERVE_THRESHOLD ? await withBoundedRead(c, () => run(), { route: 'email.content', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/events', operationId: 'listEmailEvents', tags: ['Emails'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Event)), ...errors } }), async c => {
    // Oldest first by creation time: event IDs are random, so ordering by ID shuffled an email's history.
    const a = actor(c); const emailId = c.req.valid('param').id; await findEmail(c.env.db, a, emailId); const q = c.req.valid('query'), binding = `email-events:${emailId}`, cursor = readCursor(q.cursor, binding);
    const rows = await c.env.db.select().from(emailEvents).where(and(scope(emailEvents, a), eq(emailEvents.emailId, emailId), cursor ? sql`(${emailEvents.createdAt},${emailEvents.id})>(${cursor.at}::timestamptz,${cursor.id})` : undefined)).orderBy(asc(emailEvents.createdAt), asc(emailEvents.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => visibleEmailEvent(a,r)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  // A scheduled send can be canceled or moved until its release at scheduledAt starts sending it (releaseScheduled holds
  // the same row lock): after that, 409 EMAIL_NOT_SCHEDULED.
  const notScheduled = () => new ApiError(409, 'EMAIL_NOT_SCHEDULED', 'Only a scheduled email that has not started sending can be canceled or rescheduled.');
  const scheduledControl = async (c: Ctx, change: (tx: DbExecutor, a: Actor, emailId: string, row: { status: EmailStatus; simulated: boolean }) => Promise<number>) => {
    const a = actor(c, 'send'), emailId = c.req.param('id')!;
    const webhooks = await c.env.db.transaction(async tx => {
      const [row] = await tx.select({ status: emails.status, simulated: emails.simulated }).from(emails).where(mailWhere(a, emailId)).for('update');
      return change(tx, a, emailId, row ?? notFound('Email'));
    });
    await wakeWebhooks(c.env, webhooks);
    const [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(a, emailId)).limit(1);
    return c.json(emailView(listedSubject(a, row ?? notFound('Email'))), 200);
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/{id}/cancel', operationId: 'cancelEmail', summary: 'Cancel a scheduled email',
    description: 'Cancel an email scheduled with sendEmail scheduledAt before it starts sending: it becomes canceled (errorCode EMAIL_CANCELED) with a canceled event and the email.rejected webhook, and is never sent or charged. Canceling a canceled email returns it unchanged. Once its time has come and it was released to send, 409 EMAIL_NOT_SCHEDULED.',
    tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => scheduledControl(c, async (tx, a, emailId, row) => {
    if (row.status === 'canceled') return 0;
    if (row.status !== 'scheduled') throw notScheduled();
    const { rows: [canceled] } = await tx.execute<{ n: number }>(sql`WITH canceled AS (UPDATE sending_emails SET status='canceled',error_code='EMAIL_CANCELED',updated_at=clock_timestamp()
        WHERE workspace_id=${a.workspaceId} AND id=${emailId} AND status='scheduled' RETURNING ${terminalColumns}
      ), ${terminalEvents(sql`SELECT * FROM canceled`)}, retired AS (UPDATE jobs SET status='completed',lease_until=NULL,last_error='EMAIL_CANCELED' WHERE id=${releaseJobId(emailId)} AND status='pending' RETURNING 1)
      SELECT count(*)::int AS n FROM webhook_jobs`);
    return canceled!.n;
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/{id}/reschedule', operationId: 'rescheduleEmail', summary: 'Move a scheduled email to another time',
    description: 'Change when an email scheduled with sendEmail scheduledAt is sent, before it starts sending; its content and recipients stay as they are. The same bounds as scheduling: from now to 30 days ahead, as a UTC instant (422 INVALID_SCHEDULE). Records a rescheduled event. Once its time has come and it was released to send, or after it was canceled, 409 EMAIL_NOT_SCHEDULED.',
    tags: ['Emails'], security, request: { params: IdParams, body: json(z.object({ scheduledAt: ScheduledAt.describe('The new send time: an RFC 3339 instant with Z or an offset, returned in UTC.') }).strict().openapi('EmailRescheduleInput')) },
    responses: { 200: response(Email), ...errors } }), async c => {
    const at = scheduleTime(c.req.valid('json').scheduledAt);
    return scheduledControl(c, async (tx, a, emailId, row) => {
      if (row.status !== 'scheduled') throw notScheduled();
      await tx.execute(sql`WITH moved AS (UPDATE sending_emails SET scheduled_at=${at}::timestamptz,updated_at=clock_timestamp() WHERE workspace_id=${a.workspaceId} AND id=${emailId} AND status='scheduled' RETURNING workspace_id,id),
        noted AS (${scheduledEvent(sql`SELECT workspace_id,id FROM moved`, 'rescheduled', at, row.simulated)}) ${queueRelease(sql`SELECT workspace_id,id FROM moved`, at)}`);
      if (Date.parse(at) - Date.now() < 60_000) a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1);
      return 0;
    });
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/attachments', operationId: 'uploadAttachment', tags: ['Attachments'], security,
    description: `Uploads one file as base64 in JSON; list the returned id in an email's attachments. For files over ${mib(MAX_JSON_ATTACHMENT_BYTES)}, POST /v1/attachments/upload takes the raw bytes as the body, with the fields in headers: ${UPLOAD_HEADERS.filename} (URI-encoded), Content-Type, ${UPLOAD_HEADERS.disposition} and ${UPLOAD_HEADERS.contentId}; 422 ATTACHMENT_METADATA_INVALID names every header that is wrong, what it held and what it must be. ${ATTACHMENT_NOTE}`, request: { headers: IdempotencyHeaders, body: json(AttachmentUpload) }, responses: { 201: response(AttachmentInfo), ...errors } }), async c => {
    const a = actor(c, 'send'); const { content, ...metadata } = c.req.valid('json');
    const bytes = decodeBase64(content);
    const result = await saveAttachment(c, a, metadata, bytes, MAX_JSON_ATTACHMENT_BYTES);
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.post('/v1/attachments/upload', async c => {
    const a = actor(c, 'send');
    const encodedFilename = requestHeader(c.req.raw.headers, 'filename');
    let filename = '';
    try { filename = encodedFilename ? decodeURIComponent(encodedFilename) : ''; } catch { throw new ApiError(422, 'ATTACHMENT_FILENAME_INVALID', `${headerPrefix}Filename must be URI-encoded UTF-8.`); }
    const contentLength = Number(c.req.header('content-length'));
    const sent = { filename, contentType: c.req.header('content-type') ?? 'application/octet-stream', disposition: requestHeader(c.req.raw.headers, 'disposition') ?? 'attachment', contentId: requestHeader(c.req.raw.headers, 'content-id') ?? undefined };
    const parsed = AttachmentMetadata.safeParse(sent);
    // Every header that is wrong at once, each with what was sent and what it must be.
    if (!parsed.success) throw metadataInvalid(sent, invalidMetadataFields(parsed.error.issues), true);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) throw fileTooLarge(filename, contentLength, MAX_ATTACHMENT_BYTES);
    // The isolate's memory for this file is held before a byte is read (isolate-memory.ts): with a Content-Length the
    // body is read into one buffer of that size; without one, into chunks of at most the limit, then one copy.
    const known = Number.isFinite(contentLength) && contentLength >= 0;
    const result = await withMemory(known ? contentLength * 1.15 + 1024 * 1024 : 2.15 * MAX_ATTACHMENT_BYTES, async () => saveAttachment(c, a, parsed.data, await uploadBody(c.req.raw, known ? contentLength : null, filename)), { route: 'attachment.upload', workspaceId: a.workspaceId, signal: c.req.raw.signal });
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}', operationId: 'getAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo), ...errors } }), async c => {
    const [row] = await attachmentRows(c.env.db, actor(c), [c.req.valid('param').id]); return c.json(AttachmentInfo.parse(row), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}/content', operationId: 'getAttachmentContent', description: 'Returns the private attachment as canonical base64 JSON, scoped like its metadata. At most 25 MiB decoded; never a public object URL or executable inline response.', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo.extend({ content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) }).openapi('AttachmentContent')), ...errors } }), async c => {
    const a = actor(c);
    const [row] = await attachmentRows(c.env.db, a, [c.req.valid('param').id]);
    assertResponseWithinLimit(c.req.raw, Math.ceil(row!.size / 3) * 4 + 512);
    // The file counts against the isolate's self-reclaiming budget (isolate-memory.ts) until read, canceled, or past
    // its idle/hard deadline, and streams out base64 a chunk at a time so the file is the only large buffer.
    let lease: import('./isolate-memory.js').MemoryLease;
    try {
      lease = await reserveMemory(row!.size * 1.15 + 1024 * 1024, { route: 'attachment.download', workspaceId: a.workspaceId, signal: c.req.raw.signal, idleMs: attachmentDownload.idleMs, maxMs: attachmentDownload.readMs });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let file: Uint8Array;
    try {
      const asset = await c.env.storage.get(row!.storageKey);
      if (!asset || asset.body.length !== row!.size || asset.body.length > MAX_ATTACHMENT_BYTES || await bytesDigest(asset.body) !== row!.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
      file = asset.body;
    } catch (error) { lease.release(); throw error; }
    const jsonMeta = JSON.stringify({ ...AttachmentInfo.parse(row), content: '' });
    return streamBase64JsonResponse(c, lease, jsonMeta, file, {
      idleMs: attachmentDownload.idleMs,
      maxMs: attachmentDownload.readMs,
      timeoutError: () => new ApiError(504, 'DOWNLOAD_TIMEOUT', 'The attachment was not read in time.'),
    }) as never;
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/attachments/{id}', operationId: 'deleteAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const attachmentId = c.req.valid('param').id;
    // Attachments belong to the workspace, not to a sender domain, so a domain-restricted key can't show one is its own.
    if (a.domains.length) throw unrestrictedRequired(a, 'Deleting an attachment needs', { permission: 'sendEmail', level: 'on' }, 'Unused attachments are removed automatically after 30 days.');
    await c.env.db.transaction(async db => {
      const [row] = await attachmentRows(db, a, [attachmentId], true);
      const links = await db.select().from(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.attachmentId, attachmentId))).limit(1);
      if (links.length) throw new ApiError(409, 'ATTACHMENT_IN_USE', 'Remove this attachment from all drafts first; queued and retained emails keep their immutable attachment references.');
      if (!row!.sourceTemplateAssetId) await enqueue(db,{workspaceId:a.workspaceId,type:'maintenance.deleteAttachment',payload:{key:row!.storageKey}});
      await db.delete(attachments).where(and(scope(attachments, a), eq(attachments.id, attachmentId)));
    }); return c.json({ id: attachmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns', operationId: 'createCampaign', description: 'Create a campaign draft; only a name is required. templateId copies an active published global template, including its content and assets, into this workspace. With regional MX delivery, drafts can be edited before sender setup is complete; the sender and region are checked when sending a test or launching. Returns a dashboard URL so an agent and user can continue editing together.', tags: ['Campaigns'], security, request: { headers: IdempotencyHeaders, body: json(CampaignCreate) }, responses: { 201: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    await assertBlockContent(input.html);
    const result = await idempotent(c.env.db, keyed(c, a), input, async db => {
      const campaignId = id('campaign'); const source = input.templateId ? await (await wrapModuleLoad(() => import('./templates.js'))).instantiateTemplate(c.env, db, a, input.templateId) : null;
      const draft = { name: input.name, from: input.from, ...(input.fromName ?? source?.draft.fromName ? { fromName: input.fromName ?? source?.draft.fromName } : {}), ...(input.previewText ?? source?.draft.previewText ? { previewText: input.previewText ?? source?.draft.previewText } : {}), replyTo: input.replyTo.length ? input.replyTo : source?.draft.replyTo ?? [], ...await draftRegion(c.env,db,a,input), subject: input.subject || source?.draft.subject || '', attachments: [...new Set([...(source?.draft.attachments ?? []), ...input.attachments])], tracking: input.tracking ?? source?.draft.tracking ?? true, audience: input.audience, defaults: { ...(source?.draft.defaults ?? {}), ...input.defaults }, ...(input.html ?? source?.draft.html ? { html: input.html ?? source?.draft.html } : {}), ...(input.unsubscribePageUrl ?? source?.draft.unsubscribePageUrl ? { unsubscribePageUrl: input.unsubscribePageUrl ?? source?.draft.unsubscribePageUrl } : {}), ...(input.topicId ? { topicId: input.topicId } : {}), ...(input.requiredNotice ? { requiredNotice: true } : {}) };
      draftSender(c.env, a, draft);
      await draftAudience(db, a, draft.audience);
      await draftTopic(db, a, draft);
      await requiredNoticesAllowed(db, draft, a.workspaceId);
      await linkAttachments(db, a, draft.attachments, 'campaign', campaignId);
      const [row] = await db.insert(campaigns).values({ id: campaignId, workspaceId: a.workspaceId, draft, sourceTemplateId: source?.templateId ?? null, sourceTemplateRevision: source?.templateRevision ?? null }).returning();
      return { ...row!, counts: emptyCounts() };
    }, { replayed: campaignReplay(a) });
    const sendEstimate = (await sendEstimates(c.env, c.env.db, a, [result])).get(result.id) ?? null;
    return c.json(Campaign.parse({ ...result, archivedAt: result.archivedAt ?? null, url: campaignUrl(c.env, result), delivery: null, sendEstimate }), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns', operationId: 'listCampaigns', description: `Returns bounded campaign metadata summaries. Fetch an individual campaign for its full editable draft; list drafts omit bodies, defaults, attachments and audience exclusions. Dashboard list counts may be cached for up to 60 seconds; API credentials get exact list counts. getCampaign may reuse counts for up to ${CAMPAIGN_PROGRESS_CACHE_SECONDS} seconds ${CAMPAIGN_PROGRESS_SCOPE}. A newsletter's issues are the campaigns to its list: filter with listId.`, tags: ['Campaigns'], security, request: { query: CampaignQuery }, responses: { 200: response(page(CampaignSummary)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), binding = await pageBinding(a, 'campaigns', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    // list_id is the draft's audience list (migration 394), so these filters never read a draft; a newsletter is a list with a sender.
    const newsletterList = sql`EXISTS (SELECT 1 FROM audience_lists l WHERE l.workspace_id = ${campaigns.workspaceId} AND l.id = ${campaigns.listId} AND l.newsletter_from IS NOT NULL)`;
    const rows = await timed(c, 'campaign-list-db', () => c.env.db.select({ ...campaignSummaryColumns, stats: campaigns.stats,
      // Only beside a stored count (the draft is read again for it).
      tracking: sql<boolean | null>`CASE WHEN ${campaigns.stats}->>'reviewId' = ${campaigns.reviewId} THEN (${campaigns.draft}->>'tracking')::boolean END` }).from(campaigns).where(and(campaignWhere(a),
      q.archived === 'true' ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt),
      cursor ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.region ? sql`${campaigns.draft}->>'region' = ${q.region}` : undefined, q.state ? eq(campaigns.state, q.state) : undefined,
      search ? sql`(${campaigns.id} ILIKE ${search} OR ${campaigns.draft}->>'name' ILIKE ${search} OR ${campaigns.draft}->>'subject' ILIKE ${search})` : undefined,
      q.listId ? eq(campaigns.listId, q.listId) : undefined, q.newsletter === 'true' ? newsletterList : q.newsletter === 'false' ? sql`NOT ${newsletterList}` : undefined,
    )).orderBy(desc(campaigns.createdAt), desc(campaigns.id)).limit(q.limit + 1));
    const listed = rows.slice(0, q.limit);
    // A newsletter's issues: finished campaigns whose stored count is missing or stale are counted in the background (the
    // job deduplicates), so their figures appear on a later read. This read counts nothing. A stale count is queued only
    // when the job would count again (campaignStatsJob): the workspace's mail changed since, or the campaign did, so a read
    // of a quiet workspace queues nothing.
    const finished = q.listId ? listed.filter(row => !(CAMPAIGN_ACTIVE as readonly string[]).includes(row.state) && statsDue(row)) : [];
    const revision = finished.some(row => storedStats(row)) ? await mailRevision(c.env, a.workspaceId) : null;
    const due = finished.filter(row => { const stored = storedStats(row); return !stored || stored.revision !== revision || Date.parse(stored.computedAt) < Date.parse(row.updatedAt); }).map(row => row.id);
    if (due.length) await c.env.db.execute(queueCampaignsStats(a.workspaceId, due));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, listed.map(({ stats: _stats, tracking: _tracking, ...row }) => row), { origin: new URL(c.req.url).origin }));
    return c.json({ data: views.map((row, i) => CampaignSummary.parse({ ...row, stats: listedStats(listed[i]!) })), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  // The dashboard's campaign room (src/campaign-room.ts): a WebSocket that shows who else has the campaign open. Not part of
  // the public API, and people only: agents appear through their own reads and saves (agentVisit). A browser's WebSocket
  // carries no headers of its own, so the Worker takes its account and workspace from this URL's query (worker.ts).
  app.get('/v1/campaigns/:id/room', async c => {
    const rooms = c.env.campaignRooms;
    if (!rooms) throw new ApiError(404, 'PRESENCE_UNAVAILABLE', 'Live presence needs campaign rooms, which only the Cloudflare deployment runs.');
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(426, 'WEBSOCKET_REQUIRED', 'Open the campaign room with a WebSocket.');
    const a = actor(c);
    if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    // Cookies ride along on any site's WebSocket to this host, so only the dashboard's own pages may open one.
    (await import('./account-login.js')).requireDashboardOrigin(c.env, c.req.raw);
    const campaignId = c.req.param('id');
    const [row] = await c.env.db.select({ id: campaigns.id }).from(campaigns).where(campaignWhere(a, campaignId)).limit(1);
    if (!row) notFound('Campaign');
    // The room knows each person by a key of its own, never their user ID, and shows API keys' and MCP clients' names
    // only to those who see them in Settings (owners and admins; self-hosted, everyone).
    const room = roomName(a.workspaceId, campaignId), key = (await digest(`${room}:${a.keyId}`)).slice(0, 16);
    const names = !c.env.config.multiTenant || a.role === 'owner' || a.role === 'admin';
    return rooms.connect(room, { kind: 'person', id: key, name: a.name?.trim() || 'A teammate', view: c.req.query('view') === 'review' ? 'review' : 'write', names, until: Date.now() + ADMISSION_MS });
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}', operationId: 'getCampaign', description: `The campaign with its full draft, per-status email counts and delivery progress. ${CAMPAIGN_PROGRESS_NOTE} ${readLimitNote(READ_LIMIT.campaign)}`, tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c), campaignId = c.req.valid('param').id;
    const [probe] = await c.env.db.select({ bytes: sql<number>`coalesce(octet_length(${campaigns.draft}::text), 0)::int` }).from(campaigns).where(campaignWhere(a, campaignId)).limit(1);
    if (!probe) notFound('Campaign');
    assertResponseWithinLimit(c.req.raw, probe.bytes + 4096);
    const run = async (): Promise<Response> => {
      const row = await timed(c, 'campaign-db', () => findCampaign(c.env.db, a, campaignId));
      agentVisit(c, a, row);
      const views = await timed(c, 'campaign-counts-db', () => budgetedRead(c.env.db, db => campaignViews(c.env, a, [row], { origin: new URL(c.req.url).origin, detail: true }, db), readLimit(READ_LIMIT.campaign)));
      return c.json(Campaign.parse(views[0]!), 200);
    };
    return (probe.bytes > LARGE_READ_RESERVE_THRESHOLD * 2 ? await withBoundedRead(c, () => run(), { route: 'campaign.get', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/stats', operationId: 'getCampaignStats', description: 'Lifetime campaign delivery and unique open/click statistics, progress, tracking setting and rates with numeric numerators/denominators. Counts distinct emails across all stored feedback, not event occurrences. Delivery/bounce/complaint rates use accepted emails; open/click rates use delivered emails. Both rate counts exclude simulated emails. Rates are fractions, null for zero denominators; engagement rates are also null with tracking disabled. Delivered means receiving-server acceptance, not inbox placement. Engagement includes bots/privacy proxies. Done means dispatch finished; asynchronous feedback can still change totals. ' + STATS_NOTE + ' ' + readLimitNote(READ_LIMIT.campaignStats), tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignStats), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    // Queued before the read, so one that runs out of time is answered from the count next time.
    if (statsDue(row)) await c.env.db.execute(queueCampaignStats(campaignRef(a, row.id)));
    return c.json(CampaignStats.parse((await budgetedRead(c.env.db, db => campaignStats(db, a, [row]), readLimit(READ_LIMIT.campaignStats))).get(row.id)!), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaign-content-guide', operationId: 'getCampaignContentGuide', description: 'The complete campaign and template content vocabulary, personalization syntax, restrictions and examples as Markdown. Read it once before writing or editing html.', tags: ['Campaigns'], security, responses: { 200: response(CampaignContentGuide), ...errors } }), async c => {
    actor(c);
    const { CAMPAIGN_CONTENT_GUIDE } = await loadCampaignBlocks();
    return c.json({ format: 'markdown' as const, markdown: CAMPAIGN_CONTENT_GUIDE }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview', operationId: 'previewCampaign', description: 'Renders the saved draft’s block HTML as the styled email and its plain-text alternative, with the footer every email gets (the Unsubscribe link, a placeholder here, and the workspace’s postal address) and without personalization. Placeholders remain visible as {{name}}.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignPreview), ...errors } }), async c => {
    const a = actor(c), { row, footer } = await campaignWithFooter(c.env, a, c.req.valid('param').id);
    const rendered = await previewParts(c.env, a.workspaceId, row.draft, footer);
    return c.json({ html: rendered.html ?? '', text: rendered.text ?? '' }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/audience', operationId: 'previewCampaignAudience', description: 'Counts the saved audience right now: matched contacts and how many are eligible, suppressed or unsubscribed. With readiness=true it also reviews the send (CampaignReadiness): whether it is ready to go out as it is, why, and the daily batches it recommends; send it with pacing.plan "recommended" to follow them. Read-only and never frozen; send or schedule takes its own snapshot and consent is rechecked at dispatch.', tags: ['Campaigns'], security, request: { params: IdParams, query: z.object({ readiness: z.enum(['true', 'false']).optional().describe('Also review the send (readiness).') }) }, responses: { 200: response(AudienceCounts), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    return c.json(await savedCampaignAudience(c.env, a, row, undefined, c.req.valid('query').readiness === 'true'), 200);
  });
  // One authenticated presentation read for Review; public audience and advisory operations stay separate.
  app.get('/v1/campaigns/:id/review-display', async c => {
    const a = actor(c, 'read');
    if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const input = z.object({ id: IdParams.shape.id, revision: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int()),
      check: z.enum(['true', 'false']), readiness: z.enum(['true', 'false']).optional() }).safeParse({ id: c.req.param('id'), revision: c.req.query('revision'), check: c.req.query('check'), readiness: c.req.query('readiness') });
    if (!input.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Supply the saved campaign revision and whether to run Checks.');
    const saved = await campaignWithFooter(c.env, a, input.data.id);
    editable(saved.row, input.data.revision);
    const spec = AudienceSpec.safeParse(saved.row.draft.audience);
    const shared = spec.success ? displayAudience(c.env, a, saved.row.draft, spec.data) : undefined;
    const [audience, check] = await Promise.all([
      reviewPart(c, savedCampaignAudience(c.env, a, saved.row, shared, input.data.readiness === 'true')),
      input.data.check === 'true' ? reviewPart(c, campaignAdvisory(c.env, a, saved, shared)) : null,
    ]);
    return c.json({ audience, check }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview-image', operationId: 'renderCampaignPreviewImage', description: 'Renders the saved campaign draft as a full-page, 720 px wide PNG for visual review. Inline CID images are embedded; remote HTTPS images are loaded by the isolated renderer.' + PREVIEW_ROUTE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams }, responses: { ...previewResponses(CampaignPreviewImage), ...errors } }), async c => {
    refuseHead(c);
    const a = actor(c, 'send'), { row, footer } = await campaignWithFooter(c.env, a, c.req.valid('param').id);
    if (!c.env.renderHtmlImage) throw new ApiError(503, 'PREVIEW_RENDERING_UNAVAILABLE', 'Visual campaign preview rendering is not configured.', undefined, true);
    await chargeRenderBudget(c, a.workspaceId);
    const inline = (await attachmentRows(c.env.db, a, row.draft.attachments)).filter(item => item.disposition === 'inline' && item.contentId), render = c.env.renderHtmlImage;
    // The page is passed on, not kept here: renderPreview drops it once it is rendered.
    const link = await renderPreview(c.env, a.workspaceId, (await previewParts(c.env, a.workspaceId, row.draft, footer)).html ?? '', inline, async item => {
      const asset = await c.env.storage.get(item.storageKey);
      if (!asset || asset.body.length !== item.size || await bytesDigest(asset.body) !== item.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An inline campaign image is missing or changed.', undefined, true);
      return asset.body;
    }, async (page, grow) => {
      try { return await render(page, grow); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'PREVIEW_RENDERING_FAILED', 'The visual campaign preview could not be rendered. Try again.', undefined, true); }
    });
    c.header('Location', link.url);
    return c.json({ ...link, mimeType: 'image/png' as const }, 303);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/state', operationId: 'getCampaignState', description: 'Compact authenticated state for draft sync polling; fetch the full campaign with getCampaign when state changes. Compare all returned fields, not only revision: archive and delivery changes need not increment the draft revision. Omits draft content and delivery counts.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignState), ...errors } }), async c => {
    const [row] = await c.env.db.select(campaignStateColumns).from(campaigns).where(campaignWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(CampaignState.parse(row ?? notFound('Campaign')), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}', operationId: 'updateCampaign', description: 'Replace the whole draft at the current revision. Read the campaign first: html is block HTML that people may have edited in the dashboard composer, so send the complete updated html rather than a fragment. Rejected content names the unsupported tag or attribute. A failed campaign becomes a draft again.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignUpdate) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    await assertBlockContent(input.draft.html);
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      const draft = {...input.draft,...await draftRegion(c.env,db,a,input.draft,current.draft)};
      draftSender(c.env, a, draft);
      draftSender(c.env, a, current.draft); editable(current, input.revision);
      await draftAudience(db, a, draft.audience, current.draft.audience);
      await draftTopic(db, a, draft, current.draft);
      await requiredNoticesAllowed(db, draft, a.workspaceId);
      await attachmentRows(db, a, input.draft.attachments, true);
      await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId)));
      await linkAttachments(db, a, input.draft.attachments, 'campaign', campaignId);
      const audienceChanged = JSON.stringify(draft.audience ?? null) !== JSON.stringify(current.draft.audience ?? null) || Boolean(draft.requiredNotice) !== Boolean(current.draft.requiredNotice) || (draft.topicId ?? null) !== (current.draft.topicId ?? null);
      const revised = await db.execute<typeof campaigns.$inferSelect>(reviseCampaign(campaignRef(a, campaignId), sql`,draft=${JSON.stringify(draft)}::jsonb,revision=${current.revision + 1}${audienceChanged ? sql`,audience_estimate=NULL` : sql``}`));
      if (!revised.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being saved; fetch it and try again.');
      return (await findCampaign(db, a, campaignId))!;
    });
    agentVisit(c, a, row, row.revision);
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}/archive', operationId: 'setCampaignArchived', description: 'Archive a campaign to hide it from default lists, or restore it. Preserves its content, revision, delivery state and history. Preparing, scheduled, sending or paused campaigns must finish or be canceled before archiving. Archived campaigns cannot be edited, tested or sent until restored.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignArchive) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'), campaignId = c.req.valid('param').id, input = c.req.valid('json');
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      draftSender(c.env, a, current.draft);
      if (a.role === 'member' && !campaignEditable(current)) throw denied('PERMISSION_DENIED', 'Members can archive only campaign drafts.', { permission: 'audience', level: 'write', person: 'admin' });
      if (input.archived && ((CAMPAIGN_ACTIVE as readonly string[]).includes(current.state) || campaignResumable(current))) throw new ApiError(409, 'CAMPAIGN_ACTIVE', 'Cancel or finish sending this campaign before archiving it.');
      if (Boolean(current.archivedAt) === input.archived) return current;
      const [updated] = await db.update(campaigns).set({ archivedAt: input.archived ? now() : null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning();
      return updated!;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/campaigns/{id}', operationId: 'deleteCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, current.draft); editable(current); await db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews r WHERE l.owner_type = 'review' AND l.owner_id = r.id AND l.workspace_id = r.workspace_id AND r.workspace_id = ${a.workspaceId} AND r.campaign_id = ${campaignId}`); await db.delete(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.campaignId, campaignId))); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await db.delete(campaigns).where(campaignWhere(a, campaignId)); });
    return c.json({ id: campaignId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/test', operationId: 'testCampaign', description: `Send the current draft, personalized with data, to one address as a transactional test. It shows the footer as recipients get it (the Unsubscribe link, a placeholder here, and the workspace’s postal address, if set) without List-Unsubscribe headers, and needs no postal address. On Hosted sending a test goes only to an address the workspace has proven is its own: a member’s verified email, an address at one of its currently verified domains or their subdomains (its receiving addresses and inboxes there included; not a domain whose verification lapsed), or the SES mailbox simulator (422 TEST_RECIPIENT_NOT_OWNED otherwise; send the campaign to reach anyone else), a workspace sends at most ${CAMPAIGN_TESTS.perHour} tests a clock hour (429 CAMPAIGN_TEST_LIMIT, retryable at resetAt), and each test is screened on its own, with the campaign limit (${screenBytes(SCREEN.campaignBytes)} bytes of screened text by default; 422 CONTENT_TOO_LARGE_TO_SCREEN with error.details[0] { screenedBytes, limitBytes } over it).`, tags: ['Campaigns'], security, request: { params: IdParams, headers: SendIdempotencyHeaders, body: json(TestCampaign) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'), input = c.req.valid('json'), campaignId = c.req.valid('param').id;
    // With its key claimed, read and render the draft, then admit the test in one statement that locks the campaign
    // and requires the revision it rendered. A replay rechecks that the caller may still read the campaign.
    const result = await claimedSend(sendCall(c), a, input, async () => {
      const { row, footer } = await campaignWithFooter(c.env, a, campaignId);
      if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before sending a test.');
      const message = await campaignMessage(c.env, row.draft, { id: 'test-recipient', email: input.to, properties: input.data }, true, null);
      await admitCampaignTest(c.env, a, input.to);
      // The footer as recipients get it, its link the placeholder on the link host they get: a test is transactional,
      // without List-Unsubscribe, and refused as the launch would be when there is no link host.
      // Its pictures are linked from that host too, as recipients' are (src/linked-images.ts); a required notice's stay attached.
      const origin = footer.requiredNotice ? undefined : foundLinkOrigin(c.env.config, a.workspaceId, row.draft.from, footer.linkOrigin);
      const snapshot = { ...message, testCampaignId: campaignId, ...origin ? { linkOrigin: origin } : {} };
      footerParts(snapshot, unsubscribePlaceholder(origin ?? c.env.config.publicUrl), footer);
      const out: Outgoing[] = [{ snapshot, recipients: hostedCost(input.to), marketing: false }];
      if (mayScreenAtAccept(c.env, out)) await prepareFrontDoor(c.env, a, out, false);
      return { out, campaign: { id: campaignId, revision: row.revision } };
    }, { batch: false, replayed: (db, receipt) => campaignReplay(a, campaignId)(db, receipt) });
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/send', operationId: 'sendCampaign', description: 'Accept the current revision for durable background delivery: small audiences (<=5,000 list members) freeze immediately while larger audiences freeze in the background during preparing, every message is validated before sending, then recipients are released into the dispatch queue. The 202 queued count is recipients expected (not SES acceptance or delivery); delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. ' + CAMPAIGN_POSTAL_NOTE + ' ' + CAMPAIGN_SCREEN_NOTE + ' ' + CAMPAIGN_CAPTURE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSend) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const result = await idempotent(c.env.db, keyed(c, a), input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'), c), { replayed: campaignReplay(a, c.req.valid('param').id) }); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/schedule', operationId: 'scheduleCampaign', description: 'Accept the current revision for durable scheduled delivery. Small audiences (<=5,000 list members) freeze immediately while larger audiences freeze and validate in the background during preparing; no recipient is materialized or sent before scheduledAt. The 202 queued count is recipients expected; delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. ' + CAMPAIGN_POSTAL_NOTE + ' ' + CAMPAIGN_SCREEN_NOTE + ' ' + CAMPAIGN_CAPTURE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSchedule) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c.env.db, keyed(c, a), input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'), c), { replayed: campaignReplay(a, c.req.valid('param').id) }); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/cancel', operationId: 'cancelCampaign', description: 'Stop a preparing, scheduled, sending, paused or failed campaign: unreleased recipients are never materialized and queued mail is canceled; mail already attempting or accepted is reported as inFlight.', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders }, responses: { 200: response(CampaignCanceled), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c.env.db, keyed(c, a), {}, async db => {
      const row = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, row.draft);
      if (row.state === 'done') throw new ApiError(409, 'CAMPAIGN_ALREADY_DISPATCHED', 'This campaign has already finished dispatching.');
      if (row.state === 'draft') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a campaign that was sent or scheduled can be canceled.');
      const canceled = await cancelCampaignWork(db, a, row);
      await recordAudit(db, c, { action: 'campaign.cancel', workspaceId: a.workspaceId, target: { type: 'campaign', id: row.id }, before: { state: row.state } });
      return canceled;
    }, { replayed: campaignReplay(a, campaignId) });
    if (a.wakeJobs) { await wakeWebhooks(c.env,a.wakeJobs); a.wakeJobs=0; }
    return c.json(CampaignCanceled.parse(result), 200);
  });
  const control = async (c: Ctx, change: CampaignChange, allowed = sendingOnly) => {
    const a = actor(c, 'send'), campaignId = c.req.param('id')!;
    await c.env.db.transaction(db => controlCampaign(c.env, db, a, campaignId, change, allowed));
    const row = await findCampaign(c.env.db, a, campaignId);
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pause', operationId: 'pauseCampaign', description: 'Stop releasing new recipients. Queued mail (a few seconds of the send rate) still dispatches. Resume continues from the same position; cancel still works while paused.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, pausing(c)));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/resume', operationId: 'resumeCampaign', description: 'Continue releasing recipients from where a paused campaign stopped, or where a campaign that failed after releasing some recipients stopped (it continues on the same frozen snapshot, never a new one). After an automatic pause, the next health check runs 30 minutes later.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (!campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign, or one that failed after releasing recipients, can be resumed.');
    if (campaign.state === 'paused' && campaign.quarantines >= 2 && QUARANTINE_CODES.includes(campaign.pauseReason?.code ?? ''))
      throw new ApiError(409, 'QUARANTINE_REVIEW_REQUIRED', 'This campaign was quarantined twice for list quality. An operator reviews it before it sends again: ask for a review from the dashboard.');
    await requiredNoticesAllowed(db, campaign.draft, a.workspaceId);
    const ref = { workspaceId: a.workspaceId, id: campaign.id }, next = runningState(campaign);
    await db.execute(resumeCampaign(ref, next));
    // The owner's one resume of a failed list probe releases the rest only to contacts this workspace delivered to
    // before (the others are skipped and counted as canceled), and the campaign's own health check runs at once.
    // A required notice goes on to everyone captured for it: those never delivered to before are exactly who it must
    // reach. The automatic pauses still apply to it. A second quarantine needs an operator (above).
    if (campaign.pauseReason?.code === 'LIST_QUALITY') { await db.execute(clearProbe(ref)); if (!campaign.draft.requiredNotice) await db.execute(restrictToDelivered(ref)); }
    if (campaign.state==='failed' && campaign.error?.code==='JOB_LEASE_EXHAUSTED') await reserveCampaign(c.env,db,await lockSendScope(db,a.workspaceId,{campaignId:campaign.id}),a,campaign.actorKeyId??a.keyId,0);
    await db.execute(queueCampaignRun(ref, campaign.requestId ? { requestId: campaign.requestId } : {}, next === 'scheduled' ? campaign.scheduledAt : null));
    await db.execute(queueCampaignStats(ref));
    await recordAudit(db, c, { action: 'campaign.resume', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaign.id }, before: { state: campaign.state }, after: { state: next } });
    a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1);
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pacing', operationId: 'setCampaignPacing', description: 'Change the daily cap or automatic pause of a scheduled or sending campaign, for example to raise 50,000 to 100,000 per day. Takes effect on the next release.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({ perDay: z.number().int().min(100).max(10000000).nullable().optional().describe('Release at most this many recipients per rolling 24-hour window. Omit to keep the current cap; null removes it. Delivery always also respects the SES 24-hour quota.'), autoPause: z.boolean().optional().describe('Omit to keep the current setting. Hosted shared sending always enforces automatic pause; false is rejected.'), rateShare: z.number().min(0.05).max(1).optional().describe('Omit to keep the current setting.') }).strict().openapi('CampaignPacingUpdate')) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (campaign.expanded >= campaign.total) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'This campaign has finished releasing recipients.');
    if (campaign.state === 'failed') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Resume this campaign before changing its pacing.');
    const input = c.req.valid('json'), ref = { workspaceId: a.workspaceId, id: campaign.id };
    if (input.autoPause === false && c.env.config.multiTenant && (await db.execute(sql`SELECT 1 WHERE ${sharedConnection(a.workspaceId)}`)).rowCount) throw hostedAutoPauseRequired();
    // A daily limit replaces a launch plan. Where the review required a ramp and no consent source was confirmed, it stays
    // no larger than the plan's first day.
    if (input.perDay !== undefined && campaign.rampRequiredCap !== null && !campaign.consent && (input.perDay === null || input.perDay > campaign.rampRequiredCap))
      throw new ApiError(422, 'RAMP_REQUIRED', `This send needed a ramp when it launched, so its daily limit stays at most ${campaign.rampRequiredCap.toLocaleString('en-US')}.`, 'perDay');
    await db.execute(setCampaignPacing(ref, { pacePerDay: input.perDay === undefined ? campaign.pacePerDay : input.perDay, autoPause: input.autoPause ?? campaign.autoPause, rateShare: input.rateShare ?? campaign.rateShare, keepPlan: input.perDay === undefined }));
    // A release waiting for the next window or quota rechecks now under the new settings.
    if (campaign.state === 'sending') { await db.execute(wakeCampaignRun(ref)); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
  }));
  // A schedule that has not released anyone yet can go back to an editable draft or move to another time.
  const unreleasedSchedule = (campaign: typeof campaigns.$inferSelect) => {
    if (!campaign.scheduledAt || campaign.expanded > 0 || !['preparing', 'scheduled', 'paused'].includes(campaign.state)) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'Only a scheduled campaign that has not started sending can be unscheduled or rescheduled. Pause or cancel a campaign that is sending.');
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/unschedule', operationId: 'unscheduleCampaign', description: 'Return a scheduled campaign that has not started sending to an editable draft, for example to fix a typo. Nobody was emailed; the frozen audience is released and captured again when you schedule or send it.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    const ref = campaignRef(a, campaign.id);
    if (!(await db.execute(unscheduleCampaign(ref))).rows.length) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'This campaign started sending; pause or cancel it instead.');
    await db.execute(retireCampaignRun(ref, 'CAMPAIGN_UNSCHEDULED'));
  }, unreleasedSchedule));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/reschedule', operationId: 'rescheduleCampaign', description: 'Move the send time of a scheduled campaign that has not started sending. The frozen audience and content stay as they are; unschedule it to edit them.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({ scheduledAt: CampaignSchedule.shape.scheduledAt }).strict().openapi('CampaignRescheduleInput')) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (a.role === 'member') throw denied('PERMISSION_DENIED', 'Only workspace owners and admins can schedule campaigns.', { permission: 'sendEmail', level: 'on', person: 'admin' });
    await requiredNoticesAllowed(db, campaign.draft, a.workspaceId);
    const at = Date.parse(c.req.valid('json').scheduledAt);
    if (at <= Date.now() || at > Date.now() + 365 * 86400000) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.', 'scheduledAt');
    const ref = campaignRef(a, campaign.id);
    if (!(await db.execute(rescheduleCampaign(ref, new Date(at).toISOString()))).rows.length) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'This campaign started sending; it can no longer be rescheduled.');
    // Requeue the run with a fresh token in this transaction: a worker that already decided to wait for the old time
    // (or to start sending at it) can no longer settle its deferral, so an earlier time is never missed. Only waiting
    // runs: a paused campaign has none, and resume queues one.
    if (campaign.state !== 'paused') { await db.execute(queueCampaignRun(ref, campaign.requestId ? { requestId: campaign.requestId } : {})); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
  }, unreleasedSchedule));
}

const campaignRef = (a: Pick<Actor, 'workspaceId'>, campaignId: string) => ({ workspaceId: a.workspaceId, id: campaignId });
const sharedConnection = (wid: string) => sql`EXISTS (SELECT 1 FROM provider_connections WHERE workspace_id=${wid} AND kind='shared')`;
const hostedAutoPauseRequired = () => new ApiError(422, 'HOSTED_AUTO_PAUSE_REQUIRED', 'Automatic bounce and complaint pauses cannot be disabled on Hosted shared sending.', 'autoPause');
/** The admission decision on a campaign's recipients: those of every active or resumable campaign still unreleased, plus
 * its rows still in the dispatch queue, each counted once, against the per-workspace and per-key limits. A failed launch
 * that released nothing holds no reservation. Direct mail keeps its own limit. */
async function reserveCampaign(runtime: Runtime, db: DbExecutor, held: SendScope, a: Actor, keyId: string, incoming: number) {
  const outstanding = sql`jsonb_build_object('outstanding',(SELECT jsonb_build_object('total',coalesce(sum(n),0),'key',coalesce(sum(n) FILTER (WHERE actor_key_id=${keyId}),0)) FROM (
    SELECT c.actor_key_id, c.total - c.expanded + (SELECT count(*) FROM sending_emails e WHERE e.workspace_id = c.workspace_id AND e.campaign_id = c.id AND e.status IN ('queued','attempting')) AS n
    FROM sending_campaigns c WHERE c.workspace_id = ${a.workspaceId} AND ${campaignReserved()}) o))`;
  const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'reserve', locks: held, incoming }, outstanding);
  admitted(runtime, (await db.execute<{ s: { allowed: true } | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId);
}
const cancelPageSize=1000;
async function cancelPage(db:DbExecutor,wid:string,campaignId:string,code:string,first=false) {
  // The parent state already fences new claims. Count before the bounded update so the
  // request keeps its original response; a skipped busy envelope is picked up next turn.
  const filter=sql`workspace_id=${wid} AND campaign_id=${campaignId} AND status='queued'`;
  const {rows:[page]}=await db.execute<{count:number;remaining:boolean;jobs:number}>(sql`WITH page AS (
    SELECT id FROM sending_emails WHERE ${filter} ORDER BY id LIMIT ${cancelPageSize} FOR UPDATE SKIP LOCKED
  ), canceled AS (UPDATE sending_emails SET status='canceled',error_code=${code},lease_until=NULL,updated_at=now()
    WHERE id IN (SELECT id FROM page) AND ${filter} RETURNING ${terminalColumns}), ${terminalEvents(sql`SELECT * FROM canceled`)},
  remaining AS (SELECT EXISTS(SELECT FROM sending_emails e WHERE ${filter} AND NOT EXISTS(SELECT FROM canceled c WHERE c.id=e.id)) AS more)
  ${first ? sql`, continuation AS (INSERT INTO jobs(id,workspace_id,type,payload) SELECT ${'cancel:'+campaignId},${wid},'sending.cancelPage',jsonb_build_object('campaignId',${campaignId}::text,'code',${code}::text)
    FROM remaining WHERE more ON CONFLICT DO NOTHING RETURNING 1)` : sql``}
  SELECT ${first ? sql`(SELECT count(*)::int FROM sending_emails WHERE ${filter})` : sql`0`} AS count,more AS remaining,
    ((SELECT count(*) FROM webhook_jobs) ${first?sql`+(SELECT count(*) FROM continuation)`:sql``})::int AS jobs FROM remaining`);
  return page!;
}
const cancelPageJob:JobHandler=retryDatabaseFailures(async(runtime,payload,job)=>{
  const page=await cancelPage(runtime.db,job.workspaceId,String(payload.campaignId),String(payload.code));
  await wakeWebhooks(runtime,page.jobs);
  if (page.remaining) throw new JobDeferred(new Date(Date.now()+2000).toISOString());
});
async function cancelCampaignWork(db: DbExecutor, a: Actor, row: typeof campaigns.$inferSelect, errorCode?: string) {
  const ref = campaignRef(a, row.id);
  const moved = await db.execute(cancelCampaign(ref, errorCode ? { code: errorCode, message: 'The sending origin is no longer authorized.' } : null));
  const unexpanded = moved.rows.length ? row.total - row.expanded : 0;
  if (moved.rows.length) await db.execute(retireCampaignRun(ref, 'CAMPAIGN_CANCELED'));
  const page=moved.rows.length ? await cancelPage(db,a.workspaceId,row.id,errorCode??'CAMPAIGN_CANCELED',true) : {count:0,jobs:0};
  a.wakeJobs=(a.wakeJobs??0)+page.jobs;
  const inFlight = await talliesEnabled(db)
    ? Number((await db.execute<{ count: number }>(sql`SELECT coalesce(sum(email_count), 0)::int AS count FROM sending_campaign_tallies
        WHERE workspace_id = ${a.workspaceId} AND campaign_id = ${row.id} AND status IN ('attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown')`)).rows[0]?.count ?? 0)
    : (await db.select({ count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, row.id), inArray(emails.status, ['attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown']))))[0]!.count;
  return { id: row.id, state: 'canceled' as const, canceled: page.count + unexpanded, inFlight };
}
/** Which of these addresses this workspace delivered to before, outside this campaign (lower case). */
async function deliveredBefore(db: DbExecutor, wid: string, campaignId: string, emails: string[]) {
  const { rows } = await db.execute<{ email: string }>(sql`SELECT DISTINCT lower(t.addr) AS email FROM sending_emails p CROSS JOIN LATERAL jsonb_array_elements_text(p.to_addresses) t(addr)
    WHERE p.workspace_id=${wid} AND p.campaign_id IS DISTINCT FROM ${campaignId} AND NOT p.simulated AND (p.status='delivered' OR p.event_outcomes & 2 <> 0)
      AND lower(t.addr) IN (SELECT lower(x) FROM jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb) x)`);
  return new Set(rows.map(r => r.email));
}
async function recipientChunk(db: DbExecutor, reviewId: string, cursor: number, limit = CAMPAIGN_PREPARE_ROWS) {
  const result = await db.execute<{ ordinal: number; recipient: ReviewedRecipient; content_hash: string | null; subject: string | null; snapshot_bytes: number | null; recipient_bytes: number; screen_rejected: boolean }>(sql`
    WITH batch AS (
      SELECT ordinal, recipient, content_hash, subject, snapshot_bytes, recipient_bytes, screen_rejected FROM sending_review_recipients
      WHERE review_id = ${reviewId} AND ordinal > ${cursor} ORDER BY ordinal LIMIT ${limit}
    ), sized AS (
      SELECT *, sum(recipient_bytes + coalesce(octet_length(subject), 0) + 64) OVER (ORDER BY ordinal) AS bytes FROM batch
    ) SELECT ordinal, recipient, content_hash, subject, snapshot_bytes, recipient_bytes, screen_rejected FROM sized
      WHERE bytes <= ${CAMPAIGN_CHUNK_BYTES} OR ordinal = ${cursor + 1} ORDER BY ordinal`);
  return result.rows;
}
function backgroundFailure(error: unknown) {
  const code = error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED';
  // A missing placeholder value says what fixes it. Never name the contact: campaign errors are shown to everyone who can
  // see the campaign, so other content errors stay the sanitized summary.
  const placeholder = error instanceof ApiError && code === 'MISSING_TEMPLATE_VARIABLE' ? /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/.exec(error.message)?.[1] : undefined;
  if (placeholder) return { code, message: `A recipient has no value for {{${placeholder}}} (${code}). Add a fallback value for ${placeholder} and send again.` };
  if (error instanceof ApiError && code === 'CAMPAIGN_RECIPIENT_INVALID') return { code, message: "A recipient's email address or personalized content is invalid (CAMPAIGN_RECIPIENT_INVALID). Fix or remove the contact and send again." };
  // Capture, screen, size and limit refusals name only counts, sizes and limits, never a contact or its values.
  if (error instanceof ApiError && (['EMPTY_AUDIENCE', 'AUDIENCE_LIMIT_EXCEEDED', 'AUDIENCE_CAPTURE_BUSY', 'CAMPAIGN_RECIPIENT_DATA_TOO_LARGE', 'ENCODED_MESSAGE_TOO_LARGE', 'RENDERED_CONTENT_TOO_LARGE', 'UNSAFE_HTML_URL', 'UNSAFE_TEMPLATE_CONTEXT', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'CONTENT_REJECTED_SPAM', 'CONTENT_TOO_LARGE_TO_SCREEN', 'CONTENT_SCREEN_BUDGET_EXCEEDED', 'INSUFFICIENT_BALANCE'].includes(code) || code.endsWith('_LIMIT_EXCEEDED'))) return { code, message: error.message };
  return { code, message: `Campaign work could not finish (${code}). Correct the cause and send again, or cancel the campaign.` };
}
// Send and schedule: freeze the audience and content now, reserve the recipients, and hand the one run job the rest.
// The audience capture (up to 2,000,000 recipients: minutes at that size) runs before the send locks. The campaign row
// and the workspace's admission row, which every send in the workspace takes, are locked after it, only for what decides
// the launch: the admission, the review, the reserve and the state change. The capture stays in this transaction, so
// the frozen list is one snapshot and a launch that fails or is cancelled before it commits leaves nothing behind.
async function launch(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, input: { revision: number; scheduledAt?: string; pacing?: z.infer<typeof Pacing>; consent?: z.infer<typeof ConsentConfirmation>; confirmRequiredNotice?: true }, requestId: string | undefined, c: Ctx) {
  // A campaign launch is one job that must start now; ask the response path for an uncoalesced scheduler wake.
  a.wakeJobs = Math.max(a.wakeJobs ?? 0, 12);
  if (input.scheduledAt && (Date.parse(input.scheduledAt) <= Date.now() || Date.parse(input.scheduledAt) > Date.now() + 365 * 86400000)) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.');
  // Campaign mail is never dispatched for a member origin (approvedOriginUser); refuse here instead of canceling later.
  if (a.role === 'member') throw denied('PERMISSION_DENIED', 'Only workspace owners and admins can send campaigns.', { permission: 'sendEmail', level: 'on', person: 'admin' });
  const row = await findCampaign(db, a, campaignId); editable(row, input.revision);
  // One launch of a campaign at a time, until this transaction ends: a second is refused at once instead of capturing the
  // audience again. Keyed on the workspace too, and taken only once the campaign is found in it. (Advisory lock classes:
  // 275812 and 275815 large captures in audience.ts, 275813 public stats.)
  if (!(await db.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275814, hashtext(${a.workspaceId} || ':' || ${campaignId}))`)).rowCount)
    throw new ApiError(409, 'CAMPAIGN_LOCKED', 'Another request is sending this campaign; fetch it to see its state.', undefined, true);
  // The footer's postal address (CAN-SPAM), read once and frozen in the review: every copy and rebuild of this launch
  // shows the same one. Without it the launch is refused after the admission check below, before anything is captured.
  const postalAddress = await workspacePostalAddress(runtime, db, a.workspaceId);
  const draft = { ...readyCampaign(row.draft), ...postalAddress ? { postalAddress } : {} };
  // A required notice: still allowed for this workspace, and confirmed by the sender as having no promotion.
  await requiredNoticesAllowed(db, draft, a.workspaceId);
  if (draft.requiredNotice && !input.confirmRequiredNotice) throw new ApiError(422, 'REQUIRED_NOTICE_UNCONFIRMED', 'Confirm that this is a required notice with no promotion (confirmRequiredNotice: true).', 'confirmRequiredNotice');
  // Its topic, which it still has and hasn't archived: the capture leaves out its opt-outs, and the dispatcher skips those
  // made after it, whatever becomes of the topic (frozen with the draft in the review).
  const topic = await campaignTopic(db, a.workspaceId, draft, true);
  const rendered = await renderCampaignContent(runtime, draft), cfg = runtime.config;
  // What the campaign's screen would refuse in the background, measured now; admission refuses it for screened mail.
  let oversize: ApiError | undefined;
  if (cfg.screen && !isSimulatedSes(runtime) && cfg.hostedScreen) {
    const screen = await loadScreen();
    try { screen.assertScreenable(await screen.measureScreen(await campaignCopy(runtime, draft, rendered)), cfg.screenLimits.campaignBytes, 'campaign'); }
    catch (error) { if (!(error instanceof ApiError) || error.code !== 'CONTENT_TOO_LARGE_TO_SCREEN') throw error; oversize = error; }
  }
  // The sender, a marketing hold, the balance (402 now, so the owner learns before the campaign waits) and the attachments.
  const ids = distinctAttachmentIds(draft.attachments), local = { oversize: () => oversize };
  const decide = async (locks: SendScope | 'none') => {
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'launch', locks, billable: 1, autoPause: input.pacing?.autoPause !== false,
      mails: [{ host: draft.from.split('@')[1]!.toLowerCase(), region: campaignSendRegion(runtime, row.draft), kind: 'marketing', attachments: ids, bodyBytes: 0, oversize: !!oversize }] }, undefined, actorAssets(a, ids));
    return (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s;
  };
  // Decided once before the capture, so a refused launch captures nothing, and again under the send locks after it. This
  // check locks the sender claim and the attachments it reads; rolling back its savepoint releases them, so none is held
  // through the capture (in the send locks' order they come after the admission row).
  await db.execute(sql`SAVEPOINT launch_check`);
  try { const check = await decide('none'); if (!check.allowed) throw refusal(runtime, check, local); }
  finally { await db.execute(sql`ROLLBACK TO SAVEPOINT launch_check`); await db.execute(sql`RELEASE SAVEPOINT launch_check`); }
  if (!postalAddress) throw postalAddressRequired();
  // The host of the links Nightmail adds (src/link-domains.ts), frozen in the review like the postal address, so every
  // copy of this launch links the same one. Refused here, after the sender's own checks, when the workspace is paused (or,
  // with own link hosts only, the domain has none active). The link domain is never frozen: each copy asks when it is made,
  // so a pause stops the rest at once, and a domain whose own link host turns active moves to it. A required notice has no
  // unsubscribe link.
  const choice = draft.requiredNotice ? undefined : await linkChoice(runtime, db, a.workspaceId, row.draft.from);
  const links = choice && !choice.shared ? choice.origin : undefined;
  const reviewId = id('review'), propertyKeys = placeholderKeys(draft, rendered);
  const audienceMod = await wrapModuleLoad(() => import('./audience.js'));
  const smallList = await audienceMod.isSmallAudienceList(db, a, draft.audience.listId);
  let judgedRecipients: number | undefined;
  let queued: number;
  // Contacts the send skips as risky (src/list-hygiene.ts): exact for a captured audience, from list counts for a whole large list.
  let risky: { total: number; byReason: Record<string, number> } | null = null;
  let capturedAt: string | null = null;
  let capturedCount: number | null = null;
  if (smallList) {
    // The list probe's sample leads only where the probe applies (Hosted shared sending, live); elsewhere the order is the list's.
    const probed = runtime.config.multiTenant && !isSimulatedSes(runtime) && Boolean((await db.execute(sql`SELECT 1 WHERE ${sharedConnection(a.workspaceId)}`)).rowCount);
    const counts = await audienceMod.snapshotCampaignAudience(db, a, draft.audience, reviewId, propertyKeys, draft.requiredNotice === true, { large: false, topic, ...probed ? { leading: probeSize } : {} }).catch(error => {
      // A statement past the database's limit (or cancelled) ends the launch; its transaction keeps nothing.
      if ([error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014')) throw captureTimedOut();
      throw error;
    });
    queued = counts.eligible;
    risky = counts.risky;
    capturedAt = now();
    // Sync launch finalizes sending_campaigns in this same transaction, so capturedCount stays NULL (no pending finalizeCapture).
  } else {
    const estimate = await audienceMod.estimateCampaignAudience(db, a, draft.audience, draft.requiredNotice === true, row.audienceEstimate ?? null, topic);
    if (estimate.definitive === 'empty') throw audienceMod.emptyAudience(draft.requiredNotice === true);
    if (estimate.definitive === 'over_limit') throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaign reviews support at most 2,000,000 matching contacts. No recipients were truncated.');
    queued = estimate.queued;
    risky = estimate.risky ?? null;
    // Counting timed out (a large segment, launched without a fresh preview): the review judges the list's subscribers,
    // an upper bound, rather than 0 or a stale count, so a large send can't skip a required ramp by not being counted.
    if (estimate.approximate) judgedRecipients = Math.max(queued, await audienceMod.listSubscribedBound(db, a, draft.audience.listId));
  }
  // The send review as of now (src/standing-model.ts RAMP.readiness). A send it requires a ramp for goes with the
  // recommended plan, a daily limit no larger than its first day, or a consent source the sender confirms.
  const readiness = draft.requiredNotice ? null : await sendReadiness(runtime, db, a, { id: campaignId, draft },
    { recipients: judgedRecipients ?? queued, matched: null, risky: risky?.total ?? 0, neverMailed: null, lastSent: await audienceMod.listLastSent(db, a, draft.audience.listId) });
  const plan = input.pacing?.plan === 'recommended' && readiness?.plan ? readiness.plan.batches : null;
  // A consent confirmation answers a new domain or a size jump, not a blocklist: after one, only a ramp will do.
  const consentWaives = !!input.consent && readiness?.required?.reason !== 'BLOCKLISTED';
  if (readiness?.required && !plan && !consentWaives && !(input.pacing?.perDay != null && input.pacing.perDay <= readiness.required.maxPerDay))
    throw new ApiError(422, 'RAMP_REQUIRED', `${readiness.summary} Send it with the recommended plan (pacing.plan "recommended"), a daily limit of at most ${readiness.required.maxPerDay.toLocaleString('en-US')}, or confirm where this list's consent comes from (consent).`, 'pacing');
  const consent = input.consent ? { source: input.consent.source, confirmedBy: a.keyId, confirmedAt: now() } : null;
  // The send locks. The campaign is still the revision that was captured, or the launch fails and its capture rolls back.
  const held = await lockSendScope(db, a.workspaceId, { campaignId });
  editable(await findCampaign(db, a, campaignId, true), input.revision);
  const route = admitted(runtime, await decide(held), a.workspaceId, local).mails[0]!;
  const reviewed={...row.draft,...route.binding ? {region:route.region,binding:route.binding} : {},postalAddress,...links ? {linkOrigin:links} : {}};
  const contentHash = await digest(canonical({ version: 2, draft: reviewed, rendered }));
  await db.insert(campaignReviews).values({ id: reviewId, rendererVersion: CAMPAIGN_RENDERER_VERSION, workspaceId: a.workspaceId, campaignId, revision: row.revision, draft: reviewed, contentHash, rendered, capturedAt, capturedCount, staticPrepared: false });
  // The list-risk measure of a marketing campaign's list, recorded on this review by a job (src/list-risk.ts); it decides nothing.
  if (!draft.requiredNotice && draft.audience?.listId) await db.execute(queueListRisk(a.workspaceId, campaignId, reviewId, draft.audience.listId,
    readiness ? { verdict: readiness.verdict, required: readiness.required?.reason ?? readiness.required?.by ?? null, reasons: (readiness.findings ?? readiness.reasons).map(reason => reason.code) } : null));
  await reserveCampaign(runtime, db, held, a, a.keyId, queued);
  // Who confirmed the notice and when, in the workspace's Activity.
  if (draft.requiredNotice) await recordAudit(db, c, { action: 'campaign.required_notice_confirmed', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaignId },
    details: { confirmation: 'This is a required notice with no promotion.', revision: row.revision, reviewId, recipients: queued, ...capturedAt ? {} : { deferredCapture: true }, ...input.scheduledAt ? { scheduledAt: input.scheduledAt } : {} } });
  // Who confirmed the list's consent source, and what it is, in the workspace's Activity.
  if (consent) await recordAudit(db, c, { action: 'campaign.consent_confirmed', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaignId },
    details: { source: consent.source, revision: row.revision, reviewId, recipients: queued, verdict: readiness?.verdict ?? null } });
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType: 'review' as const, ownerId: reviewId }))).onConflictDoNothing();
  const ref = campaignRef(a, campaignId);
  const moved = await db.execute(launchCampaign(ref, { reviewId, resolvedRegion:route.region!==row.draft.region ? route.region : undefined, actorKeyId: a.keyId, simulated: isSimulatedSes(runtime), total: queued, requestId: requestId ?? null, scheduledAt: input.scheduledAt ?? null,
    pacePerDay: input.pacing?.perDay ?? null, autoPause: input.pacing?.autoPause ?? true, rateShare: input.pacing ? input.pacing.rateShare ?? 0.5 : null,
    pacePlan: plan, firstBatch: plan ? readiness?.plan?.firstBatch ?? null : null, rampRequiredCap: readiness?.required?.maxPerDay ?? null, consent }));
  if (!moved.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being sent; fetch it and try again.');
  await db.execute(queueCampaignRun(ref, requestId ? { requestId } : {}));
  await db.execute(queueCampaignStats(ref, input.scheduledAt ?? null));
  return { id: campaignId, state: 'preparing' as const, queued, scheduledAt: input.scheduledAt ?? null, simulated: isSimulatedSes(runtime), risky, readiness };
}
async function bytesDigest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join(''); }
// Reuse fully verified bytes across invocations sharing the same bucket binding.
// Pending reads remain local to each Storage wrapper/invocation: Workers cannot
// await I/O owned by a different request. Both paths retain bounded byte storage.
const attachmentCaches = new WeakMap<object, { bytes: number; entries: Map<string, Uint8Array> }>();
const attachmentLoads = new WeakMap<Storage, Map<string, Promise<Uint8Array>>>();
export async function verifiedAttachment(runtime: Runtime, row: typeof attachments.$inferSelect) {
  const scope = runtime.storage.cacheScope ?? runtime.storage;
  let cache = attachmentCaches.get(scope);
  if (!cache) { cache = { bytes: 0, entries: new Map() }; attachmentCaches.set(scope, cache); }
  const key = `${row.storageKey}:${row.checksum}:${row.size}`;
  const cached = cache.entries.get(key);
  if (cached) { cache.entries.delete(key); cache.entries.set(key, cached); return cached; }
  let pending = attachmentLoads.get(runtime.storage);
  if (!pending) { pending = new Map(); attachmentLoads.set(runtime.storage, pending); }
  const existing = pending.get(key);
  if (existing) return existing;
  const load = (async () => {
    const asset = await runtime.storage.get(row.storageKey);
    if (!asset || asset.body.length !== row.size || await bytesDigest(asset.body) !== row.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
    const already = cache!.entries.get(key);
    if (already) return already;
    const limit = 32 * 1024 * 1024;
    while (cache!.bytes + asset.body.length > limit && cache!.entries.size) {
      const oldest = cache!.entries.entries().next().value as [string, Uint8Array];
      cache!.entries.delete(oldest[0]); cache!.bytes -= oldest[1].length;
    }
    if (asset.body.length <= limit) { cache!.entries.set(key, asset.body); cache!.bytes += asset.body.length; }
    return asset.body;
  })();
  pending.set(key, load);
  try { return await load; } finally { if (pending.get(key) === load) pending.delete(key); }
}

// validation_suppressed is an SES Bounce with bounceSubType EmailValidationSuppressed: SES Auto Validation dropped the
// recipient before sending, so it is not a delivery bounce (AWS excludes it from Reputation.BounceRate). The email becomes
// suppressed rather than bounced, and its public email.bounced event carries no bounced outcome (migration 034).
// It drops one recipient, so it ranks below any outcome SES reports for a recipient it did send to: on a multi-recipient
// email a delivery, hard bounce or complaint wins in either arrival order. Migration 153 enforces this ranking and the
// EMAIL_VALIDATION_SUPPRESSED error code (kept only while suppressed, never over an earlier error) in the database, so a
// Worker still running an older rank table during a deploy cannot restore 'suppressed' or skip a delivery either.
export const statusForEvent: Record<string, EmailStatus> = { send: 'sent', delivery: 'delivered', bounce: 'bounced', non_permanent_bounce: 'delayed', validation_suppressed: 'suppressed', complaint: 'complained', complaint_feedback: 'accepted', reject: 'rejected', rendering_failure: 'rendering_failed', delivery_delay: 'delayed', accepted: 'accepted', suppressed: 'suppressed', acceptance_unknown: 'acceptance_unknown', simulated: 'simulated' };
// Publish email.sent from the SendEmail response; a later SES Send is status feedback only.
export const publicEventType: Record<string, string> = { accepted: 'email.sent', delivery: 'email.delivered', bounce: 'email.bounced', non_permanent_bounce: 'email.bounced', validation_suppressed: 'email.bounced', complaint: 'email.complained', reject: 'email.rejected', acceptance_unknown: 'email.rejected', rendering_failure: 'email.rendering_failed', delivery_delay: 'email.delivery_delayed', open: 'email.opened', click: 'email.clicked' };
export const rank: Record<EmailStatus, number> = { scheduled: 0, queued: 0, attempting: 10, acceptance_unknown: 20, accepted: 30, sent: 40, delayed: 45, suppressed: 50, delivered: 60, bounced: 70, complained: 80, rejected: 70, rendering_failed: 70, canceled: 70, simulated: 70 };
const outcomeBitForEvent: Record<string, number> = { send: 1, accepted: 1, delivery: 3, bounce: 5, non_permanent_bounce: 129, complaint: 9, delivery_delay: 129, open: 16, click: 32, reject: 64, rendering_failure: 64 };
type EmailEventInput = { workspaceId: string; type: string; providerId?: string; errorCode?: string; data?: Record<string, unknown>; recipientHashes?: string[]; externalId?: string; createdAt?: string; receipt?: { topicArn: string; messageId: string } };
type IncomingReceipt = { topicArn: string; messageId: string; region: string; payload: Record<string, unknown>; recoveryType?: 'operation.ses' | 'operation.simulatedFeedbackRecovery' };
export async function recordEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const { event, runnable } = await persistEmailEvent(runtime, input);
  if (runnable) try { await runtime.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  return event;
}
// Only authenticated ingress and the guarded test-only callback handler use this.
export async function ingestRoutineSesEvent(runtime: Runtime, input: RoutineIngress) {
  const result = (await ingestRoutineSesEvents(runtime, [input]))[0]!;
  if (!result.error && input.type !== 'receipt') log('info', { code: 'SES_FEEDBACK_INGESTED', workspaceId: result.workspaceId,
    kind: input.type === 'send' ? 'Send' : 'Delivery', outcome: result.event ? 'processed' : result.runnable > 0 ? 'deferred' : 'duplicate', runnable: result.runnable });
  return result;
}
/** An email event's data as its webhook carries it (the published event and each delivery's payload): the receiving
 *  server's reply with its addresses and IP addresses replaced, cut at 160 characters (withRedactedReply). An email
 *  webhook carried no recipient address before the reply, and giving the whole reply later would be an addition where
 *  taking it back would be a break. The email's own events keep the reply as stored. Undefined when the data has no
 *  reply: the webhook then carries the event's data. */
const webhookData = (data: Record<string, unknown> | undefined) => typeof data?.diagnosticCode === 'string' ? withRedactedReply(data) : undefined;
export type RoutineIngress = Omit<EmailEventInput, 'workspaceId'> & { workspaceId?: string; providerId: string; taggedEmailId?: string; ingress: IncomingReceipt;
  effects?: { reported: (string | null)[] | null; suppress: string | null; observe: string | null; receiptTime: boolean } };
// One statement persists verified callbacks and their side effects. Only subscriptions and
// non-routine callbacks deliberately deferred by HTTP ingress merely open their receipt.
// Early callbacks with a known owner keep a recovery job; unresolved owners return an error for redelivery.
export async function ingestRoutineSesEvents(runtime: Runtime, inputs: RoutineIngress[]) {
  if (!inputs.length) return [];
  const mx = runtime.config.multiTenant;
  const effects = inputs.some(input => input.effects);
  const topicMatch = mx ? sql`AND (x.simulated OR (e.feedback_topic_arn=x.topic_arn AND EXISTS(SELECT FROM provider_feedback_history h WHERE h.topic_arn=x.topic_arn AND h.region=x.region AND h.aws_account_id=split_part(x.topic_arn,':',5))))` : sql``;
  const rows = inputs.map((input, index) => ({
    ordinal: index, job_workspace: input.workspaceId, simulated: simulatedTopic(input.ingress.topicArn, input.ingress.region), topic_arn: input.ingress.topicArn, message_id: input.ingress.messageId, region: input.ingress.region, provider_id: input.providerId,
    type: input.type, next_status: statusForEvent[input.type]!, next_rank: rank[statusForEvent[input.type]!], public_type: publicEventType[input.type] ?? null, outcome_bit: outcomeBitForEvent[input.type] ?? 0,
    external_id: input.externalId ?? null, data: input.data ?? {}, public_data: webhookData(input.data), effects: input.effects, created_at: input.createdAt ?? now(),
    event_id: rowId('event'), recovery_job_id: rowId('job'), recovery_type: input.ingress.recoveryType, payload: input.ingress.payload, tagged_email_id: input.taggedEmailId ?? null,
  }));
  // Remove embedded NUL without changing literal backslash-u text (consume JSON escapes in pairs).
  const json=JSON.stringify(rows), safe=json.includes('\\u0000') ? json.replace(/\\(?:u0000|.)/g,m=>m==='\\u0000'?'\uFFFD':m) : json;
  const result = await runtime.db.execute<{ ordinal: number; workspaceId: string | null; error: string | null; event: typeof emailEvents.$inferSelect | null; runnable: number; recovery:boolean; hooks:number }>(sql`WITH raw AS (
      SELECT * FROM jsonb_to_recordset(${safe}::jsonb) AS x(ordinal int, job_workspace text, simulated boolean, topic_arn text, message_id text, region text, provider_id text,
        type text, next_status text, next_rank int, public_type text, outcome_bit int, external_id text, data jsonb, public_data jsonb, effects jsonb, created_at timestamptz, event_id text, recovery_job_id text, recovery_type text, payload jsonb, tagged_email_id text)
    ), candidates AS (
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.provider_id = x.provider_id
      WHERE x.tagged_email_id IS NULL AND e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
      UNION ALL
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.id = x.tagged_email_id
      WHERE e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
    ), locked AS MATERIALIZED (
      SELECT x.ordinal, e.id, e.workspace_id, e.simulated, e.status, e.provider_id ${effects ? sql`, e.to_addresses,e.cc_addresses,e.bcc_addresses` : sql``} FROM raw x
      JOIN (SELECT ordinal, min(id) AS id FROM candidates GROUP BY ordinal HAVING count(*) = 1) c USING (ordinal)
      JOIN sending_emails e ON e.id = c.id
      WHERE e.provider_id = x.provider_id OR (e.id = x.tagged_email_id AND e.provider_id IS NULL AND e.status IN ('attempting','acceptance_unknown'))
      ORDER BY e.id FOR UPDATE OF e
    ) ${mx ? sql`` : sql`, accounts AS (
      -- Same single-account binding as resolveRegionRuntime: only the installation's own registered topics count.
      SELECT s.workspace_id, CASE WHEN count(DISTINCT r.trusted_account_id) = 1 THEN min(r.trusted_account_id) END AS account
      FROM (SELECT DISTINCT workspace_id FROM locked WHERE NOT simulated) l JOIN ses_installation_settings s USING (workspace_id)
      LEFT JOIN ses_region_discovery r ON r.workspace_id = s.workspace_id AND r.trusted_account_id ~ '^[0-9]{12}$'
        AND r.trusted_topic_arn = 'arn:aws:sns:' || r.region || ':' || r.trusted_account_id || ':bane-' || left(encode(sha256(convert_to(s.installation_id, 'UTF8')), 'hex'), 20) || '-feedback'
      GROUP BY s.workspace_id
    )`}, input AS (
      SELECT x.*, coalesce(l.workspace_id, x.job_workspace) AS workspace_id, l.status, ${effects ? sql`l.to_addresses,l.cc_addresses,l.bcc_addresses,` : sql``}
        coalesce(x.recovery_type, CASE WHEN x.type = 'receipt' AND l.status = 'attempting' AND l.provider_id IS NULL THEN 'operation.ses' END) AS job_type,
        CASE WHEN x.type <> 'receipt' AND (l.provider_id IS NOT NULL OR l.status = 'acceptance_unknown') THEN l.id END AS email_id,
        CASE WHEN l.id IS NULL AND x.job_workspace IS NULL THEN 'SES_EMAIL_NOT_FOUND'
             ${mx ? sql`WHEN NOT x.simulated AND (l.id IS NULL OR to_jsonb(split_part(x.topic_arn,':',5)) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}') THEN 'SES_ACCOUNT_MISMATCH'` : sql`
             WHEN NOT x.simulated AND a.workspace_id IS NULL THEN 'REGION_SETTINGS_NOT_INITIALIZED'
             WHEN a.account IS NOT NULL AND to_jsonb(a.account) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}' THEN 'SES_ACCOUNT_MISMATCH'`} END AS error
      FROM raw x LEFT JOIN locked l USING (ordinal) ${mx ? sql`` : sql`LEFT JOIN accounts a ON a.workspace_id = l.workspace_id AND NOT x.simulated`}
    ), distinct_receipts AS (
      SELECT DISTINCT ON (topic_arn,message_id) * FROM input WHERE error IS NULL ORDER BY topic_arn,message_id,ordinal
    ), incoming AS (
      INSERT INTO operation_sns_receipts AS receipt(topic_arn, message_id, workspace_id, processed_at)
       SELECT x.topic_arn, x.message_id, x.workspace_id, CASE WHEN x.email_id IS NOT NULL THEN clock_timestamp() END
       FROM distinct_receipts x ON CONFLICT (topic_arn,message_id) DO UPDATE SET processed_at=excluded.processed_at
       WHERE receipt.processed_at IS NULL AND excluded.processed_at IS NOT NULL AND receipt.workspace_id=excluded.workspace_id
       RETURNING topic_arn, message_id, workspace_id, created_at
    ), recovery AS (
      INSERT INTO jobs(id, workspace_id, type, payload, available_at)
       SELECT DISTINCT ON (topic_arn, message_id) x.recovery_job_id, x.workspace_id, x.job_type, x.payload,
         clock_timestamp() + CASE WHEN x.type = 'receipt' AND x.status <> 'attempting' THEN interval '0 seconds' ELSE interval '15 seconds' END
       FROM distinct_receipts x JOIN incoming i USING (topic_arn, message_id, workspace_id)
      WHERE x.error IS NULL AND x.email_id IS NULL AND x.job_type IS NOT NULL RETURNING id
    ), matched AS (
      SELECT x.*, CASE WHEN x.effects->>'receiptTime'='true' THEN i.created_at ELSE x.created_at END AS event_time
      FROM distinct_receipts x JOIN incoming i USING (topic_arn,message_id,workspace_id) WHERE x.email_id IS NOT NULL
    ) ${effects ? sql`, recipients AS MATERIALIZED (
      SELECT DISTINCT x.event_id,lower(address) AS address FROM matched x,
        jsonb_array_elements_text(x.to_addresses || x.cc_addresses || x.bcc_addresses) AS address
      WHERE x.effects->'reported' ? lower(address) OR (x.effects->>'observe' IS NOT NULL AND jsonb_array_length(x.to_addresses)=1 AND x.cc_addresses='[]' AND x.bcc_addresses='[]')
    ), contact_events AS (
      -- Effects follow the receipt this statement processed, not a newly inserted event: a recovery
      -- job that stored the event and died before its suppression left the receipt open for us.
      -- The merges below are idempotent, so overlapping with that job's own retry is harmless.
      SELECT x.workspace_id,r.address,x.ordinal,x.event_time,x.effects->>'suppress' AS reason,x.effects->>'observe' AS observe,
        min(x.ordinal) FILTER (WHERE x.effects->>'suppress' IS NOT NULL) OVER (PARTITION BY x.workspace_id,r.address) AS first_suppression
      FROM matched x JOIN recipients r USING(event_id)
    ), contact_changes AS (
      -- One write per address. A missing contact starts existing at its first suppression;
      -- an earlier open must not create it or retroactively contribute engagement.
      INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,suppressed_at,last_open_at,last_click_at,open_observed_since,click_observed_since,observed_since)
      SELECT 'con_'||replace(gen_random_uuid()::text,'-',''),v.workspace_id,v.address,bool_or(reason IS NOT NULL),
        (array_agg(reason ORDER BY (reason='complaint') DESC,(reason='hard_bounce') DESC,ordinal DESC) FILTER (WHERE reason IS NOT NULL))[1],
        max(event_time) FILTER (WHERE reason IS NOT NULL),
        max(event_time) FILTER (WHERE observe='open'),max(event_time) FILTER (WHERE observe='click'),
        min(event_time) FILTER (WHERE observe='open'),min(event_time) FILTER (WHERE observe='click'),min(event_time) FILTER (WHERE observe IS NOT NULL)
      FROM contact_events v LEFT JOIN audience_contacts c ON c.workspace_id=v.workspace_id AND c.email=v.address
      WHERE (reason IS NOT NULL OR observe IS NOT NULL) AND (c.id IS NOT NULL OR ordinal>=first_suppression)
      GROUP BY v.workspace_id,v.address ORDER BY v.workspace_id,v.address ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE SET
        ${mergeSuppression},
        last_open_at=greatest(c.last_open_at,excluded.last_open_at),last_click_at=greatest(c.last_click_at,excluded.last_click_at),
        open_observed_since=least(c.open_observed_since,excluded.open_observed_since),click_observed_since=least(c.click_observed_since,excluded.click_observed_since),
        observed_since=least(c.observed_since,excluded.observed_since),updated_at=now()
      WHERE (excluded.suppressed AND (NOT c.suppressed OR (excluded.suppression_reason = 'complaint' AND c.suppression_reason IS DISTINCT FROM 'complaint') OR (excluded.suppression_reason = 'hard_bounce' AND c.suppression_reason IS DISTINCT FROM 'complaint' AND c.suppression_reason IS DISTINCT FROM 'hard_bounce')))
        OR (excluded.suppressed AND c.suppressed AND (c.suppressed_at IS NULL OR excluded.suppressed_at > c.suppressed_at))
        OR (excluded.last_open_at IS NOT NULL AND (c.last_open_at IS NULL OR excluded.last_open_at > c.last_open_at))
        OR (excluded.last_click_at IS NOT NULL AND (c.last_click_at IS NULL OR excluded.last_click_at > c.last_click_at))
        OR (excluded.open_observed_since IS NOT NULL AND (c.open_observed_since IS NULL OR excluded.open_observed_since < c.open_observed_since))
        OR (excluded.click_observed_since IS NOT NULL AND (c.click_observed_since IS NULL OR excluded.click_observed_since < c.click_observed_since))
        OR (excluded.observed_since IS NOT NULL AND (c.observed_since IS NULL OR excluded.observed_since < c.observed_since)) RETURNING 1
    )` : sql``}, shared_locks AS MATERIALIZED (
      -- When a batch contains a suppression transition (which triggers sending_emails billing/usage/health updates
      -- after sending_email_events inserts), pre-acquire per-workspace advisory lock 275820 in ascending hashtext
      -- order across all potentially-writing workspaces in this batch so multi-workspace mixed batches never invert.
      SELECT pg_advisory_xact_lock(275820, h)
      FROM (
        SELECT DISTINCT hashtext(m.workspace_id) AS h
        FROM matched m
        WHERE EXISTS (SELECT 1 FROM matched s WHERE s.type = 'validation_suppressed' OR s.status = 'suppressed')
          AND NOT m.simulated
          AND (m.type IN ('validation_suppressed', 'complaint', 'accepted', 'send')
               OR (m.type = 'bounce' AND m.data->>'bounceType' = 'Permanent')
               OR m.status = 'suppressed')
        ORDER BY 1
      ) x ${effects ? sql`WHERE (SELECT count(*) FROM contact_changes) >= 0` : sql``}
    ), inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at,recipient_hashes)
       SELECT x.event_id, x.workspace_id, x.email_id, x.type, x.provider_id, x.external_id,
         x.data || jsonb_build_object('emailId', x.email_id, 'providerId', x.provider_id), x.simulated, x.event_time,
         ${mx && effects ? sql`CASE WHEN x.type IN ('bounce','complaint') AND jsonb_typeof(x.effects->'reported')='array'
           AND EXISTS(SELECT FROM provider_feedback_history WHERE topic_arn=x.topic_arn AND kind='shared') THEN ARRAY(
           SELECT encode(sha256(convert_to(x.email_id,'UTF8') || decode('00','hex') || convert_to(r.address,'UTF8')),'hex')
           FROM recipients r WHERE r.event_id=x.event_id AND r.address NOT LIKE '%@simulator.amazonses.com' ORDER BY r.address) END` : sql`NULL`}
       FROM matched x WHERE (SELECT count(*) FROM shared_locks) >= 0 ORDER BY x.workspace_id,x.email_id,x.ordinal
      ON CONFLICT DO NOTHING RETURNING *
    ), outcome_totals AS (
      SELECT x.email_id, x.workspace_id, bit_or(x.outcome_bit)::smallint AS add_bits
      FROM matched x JOIN inserted ins ON ins.id = x.event_id
      GROUP BY x.email_id, x.workspace_id
    ), ranked AS (
      SELECT x.*,max(x.next_rank) OVER(PARTITION BY x.email_id ORDER BY x.ordinal) AS running_rank FROM matched x JOIN inserted ins ON ins.id=x.event_id
      WHERE x.next_rank IS NOT NULL
    ), winner AS MATERIALIZED (
      SELECT DISTINCT ON (email_id) *,
        bool_or(type='validation_suppressed' AND next_rank>=greatest(running_rank,(${JSON.stringify(rank)}::jsonb->>status)::int)) OVER(PARTITION BY email_id) AS validation
      FROM ranked ORDER BY email_id,next_rank DESC,ordinal DESC
    ), email_updates AS (
      SELECT o.email_id, o.workspace_id, o.add_bits,
        (w.email_id IS NOT NULL AND w.next_rank >= (${JSON.stringify(rank)}::jsonb ->> w.status)::int) AS advance_status,
        w.next_status, w.provider_id, coalesce(w.validation, false) AS validation
      FROM outcome_totals o LEFT JOIN winner w ON w.email_id = o.email_id AND w.workspace_id = o.workspace_id
      ORDER BY o.email_id
    ), updated AS (
      -- Apply status upgrades AND outcome bits (including opens/clicks/delays where next_status IS NULL) in ONE update
      -- so sending_email_events_outcomes and operation_events_email_outcomes become 0-row no-ops on the hot path.
      UPDATE sending_emails e SET
        status = CASE WHEN u.advance_status THEN u.next_status ELSE e.status END,
        provider_id = CASE WHEN u.advance_status THEN coalesce(u.provider_id, e.provider_id) ELSE e.provider_id END,
        event_outcomes = e.event_outcomes | u.add_bits,
        error_code = CASE WHEN u.advance_status AND u.validation THEN 'EMAIL_VALIDATION_SUPPRESSED' ELSE e.error_code END,
        suppression_reason = CASE WHEN u.advance_status THEN CASE WHEN u.next_status='suppressed' AND u.validation THEN 'email_validation' END ELSE e.suppression_reason END,
        updated_at = CASE WHEN u.advance_status THEN clock_timestamp() ELSE e.updated_at END
      FROM email_updates u
      WHERE e.id = u.email_id AND e.workspace_id = u.workspace_id
        AND (u.advance_status OR (u.add_bits <> 0 AND (e.event_outcomes | u.add_bits) <> e.event_outcomes))
    ), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT ins.id, ins.workspace_id, x.public_type, x.region, ins.created_at,
         coalesce(x.public_data, x.data) || jsonb_build_object('simulated', x.simulated, 'providerId', x.provider_id, 'emailId', x.email_id)
      FROM inserted ins JOIN input x ON x.event_id = ins.id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), deliveries AS (
      INSERT INTO operation_deliveries(id, workspace_id, webhook_id, event_id, payload)
      SELECT public.row_id('whd'), p.workspace_id, w.id, p.id,
        jsonb_build_object('id', p.id, 'workspaceId', p.workspace_id, 'type', p.type, 'region', p.region, 'createdAt', p.created_at, 'data', p.data)
      FROM published p JOIN operation_webhooks w ON w.workspace_id = p.workspace_id
      WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
      ON CONFLICT DO NOTHING RETURNING id, workspace_id
    ), webhook_jobs AS (
      INSERT INTO jobs(id, workspace_id, type, payload)
      SELECT public.row_id('job'), workspace_id, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
    ) SELECT x.ordinal, x.workspace_id AS "workspaceId", coalesce(x.error,CASE WHEN x.effects IS NOT NULL AND x.email_id IS NULL THEN 'SES_EMAIL_NOT_FOUND' END) AS error,
      (SELECT row_to_json(e) FROM (SELECT ins.id, ins.workspace_id AS "workspaceId", ins.email_id AS "emailId", ins.type,
        ins.provider_id AS "providerId", ins.external_id AS "externalId", ins.data, ins.simulated, ins.created_at::text AS "createdAt" FROM inserted ins WHERE ins.id = x.event_id) e) AS event,
      (SELECT count(*)::int FROM webhook_jobs) AS hooks,EXISTS(SELECT FROM recovery r WHERE r.id=x.recovery_job_id) AS recovery,
      ((SELECT count(*) FROM webhook_jobs) + (SELECT count(*) FROM recovery r WHERE r.id = x.recovery_job_id))::int AS runnable
    FROM input x ORDER BY x.ordinal`);
  return result.rows;
}
async function persistEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const next = statusForEvent[input.type];
  const publicType = publicEventType[input.type];
  const outcomeBit = outcomeBitForEvent[input.type] ?? 0;
  // One transaction inside PostgreSQL instead of BEGIN/read/insert/update/enqueue/COMMIT over the
  // network. The locked row determines monotonic status; only a newly inserted event may change it
  // or publish a callback. Simulated acceptance also queues its Send/Delivery callback vehicles here
  // unless the runtime provides a feedback sink (Cloudflare pushes them to the feedback queue).
  const simulatedJobs = isSimulatedSes(runtime) && input.type === 'accepted' && !!input.providerId?.startsWith('sim_') && !runtime.feedback;
  const result = await runtime.db.execute<{ event: typeof emailEvents.$inferSelect | null; runnable: number; region: string }>(sql`WITH mail AS MATERIALIZED (
    SELECT id, status, region, simulated FROM sending_emails WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.emailId} FOR UPDATE
  ), inserted AS (
    INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at, recipient_hashes)
    SELECT ${rowId('event')}, ${input.workspaceId}, mail.id, ${input.type}, ${input.providerId ?? null},
      ${input.externalId ?? null}, ${JSON.stringify(input.data ?? {})}::jsonb, mail.simulated, ${input.createdAt ?? now()}::timestamptz, ${sql.param(input.recipientHashes ?? null)}::text[]
    FROM mail ON CONFLICT DO NOTHING RETURNING *
  ), updated AS (
    UPDATE sending_emails e SET
      status = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN ${next ?? null} ELSE e.status END,
      provider_id = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN coalesce(${input.providerId || null}::text, e.provider_id) ELSE e.provider_id END,
      event_outcomes = e.event_outcomes | ${outcomeBit}::smallint,
      error_code = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN coalesce(${input.errorCode ?? null}::text, e.error_code) ELSE e.error_code END,
      suppression_reason = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN ${input.type==='validation_suppressed'?'email_validation':null} ELSE e.suppression_reason END,
      updated_at = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN clock_timestamp() ELSE e.updated_at END
    FROM mail, inserted WHERE e.id = mail.id AND e.workspace_id = ${input.workspaceId}
      AND ((${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int)
        OR (${outcomeBit}::smallint <> 0 AND (e.event_outcomes | ${outcomeBit}::smallint) <> e.event_outcomes))
  ), published AS (
    INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
    SELECT inserted.id, inserted.workspace_id, ${publicType ?? null}::text, mail.region, inserted.created_at,
      ${JSON.stringify({ ...(webhookData(input.data) ?? input.data ?? {}), ...(input.providerId ? { providerId: input.providerId } : {}) })}::jsonb || jsonb_build_object('emailId',mail.id,'simulated',mail.simulated)
    FROM inserted, mail WHERE ${publicType ?? null}::text IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
  ), deliveries AS (
    INSERT INTO operation_deliveries(id, workspace_id, webhook_id, event_id, payload)
    SELECT public.row_id('whd'), p.workspace_id, w.id, p.id,
      jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'type',p.type,'region',p.region,'createdAt',p.created_at,'data',p.data)
    FROM published p JOIN operation_webhooks w ON w.workspace_id=p.workspace_id
    WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
    ON CONFLICT DO NOTHING RETURNING id, workspace_id
  ), webhook_jobs AS (
    INSERT INTO jobs(id, workspace_id, type, payload)
    SELECT public.row_id('job'), workspace_id, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
  ), simulated_callbacks AS (
    SELECT 'urn:bane:simulated-ses:' || mail.region AS topic_arn, mail.id || ':' || kind AS message_id, inserted.workspace_id,
      inserted.created_at + CASE WHEN kind='Delivery' THEN ${runtime.config.simulatedSes.deliveryDelayMs}::int ELSE 0 END * interval '1 millisecond' AS created_at
    FROM inserted, mail, unnest(ARRAY['Send','Delivery']) kind
    WHERE ${simulatedJobs}::boolean
  ), simulated_jobs AS (
    INSERT INTO jobs(id, workspace_id, type, available_at, payload)
    SELECT public.row_id('job'), r.workspace_id, 'operation.simulatedFeedback', r.created_at,
      jsonb_build_object('topicArn',r.topic_arn,'messageId',r.message_id,'region',mail.region,
        'message', jsonb_build_object('eventType',split_part(r.message_id,':',2),'mail',jsonb_build_object('messageId',${input.providerId ?? null}::text),
          lower(split_part(r.message_id,':',2)),jsonb_build_object('timestamp',r.created_at)))
    FROM simulated_callbacks r, mail
  ), receipt_processed AS (
    UPDATE operation_sns_receipts SET processed_at = clock_timestamp()
    WHERE workspace_id = ${input.workspaceId}
      AND topic_arn = ${input.receipt?.topicArn ?? null} AND message_id = ${input.receipt?.messageId ?? null} AND EXISTS (SELECT 1 FROM mail)
  ) SELECT (SELECT row_to_json(e) FROM (SELECT id, workspace_id AS "workspaceId", email_id AS "emailId", type,
    provider_id AS "providerId", external_id AS "externalId", data, simulated, created_at::text AS "createdAt" FROM inserted) e) AS event,
    (SELECT count(*) FROM webhook_jobs)::int AS runnable, (SELECT region FROM mail) AS region`);
  const row = result.rows[0]!;
  if (isSimulatedSes(runtime) && input.type === 'accepted' && input.providerId?.startsWith('sim_') && runtime.feedback && row.event) await queueSimulatedFeedback(runtime, [{ emailId: input.emailId, region: row.region, providerId: input.providerId, createdAt: row.event.createdAt }]);
  return row;
}
// Simulated acceptance produces the same Send/Delivery callbacks a live SNS subscription would,
// pushed through the runtime's feedback sink to exercise the live ingestion path.
export async function queueSimulatedFeedback(runtime: Runtime, accepted: { emailId: string; region: string; providerId: string; createdAt: string }[]) {
  if (!runtime.feedback || !accepted.length) return;
  const delay = runtime.config.simulatedSes.deliveryDelayMs;
  const items = accepted.flatMap(item => (['Send', 'Delivery'] as const).map(kind => {
    const at = new Date(Date.parse(item.createdAt) + (kind === 'Delivery' ? delay : 0)).toISOString();
    return { region: item.region, topicArn: `urn:bane:simulated-ses:${item.region}`, messageId: `${item.emailId}:${kind}`,
      message: { eventType: kind, mail: { messageId: item.providerId }, [kind.toLowerCase()]: { timestamp: at } } };
  }));
  await runtime.feedback.enqueue(items);
}
// Shared by campaign workers and the dispatch claim. A queued origin cannot bootstrap membership.
export function approvedOriginUser(runtime: Runtime, workspaceId: SQL, userId: SQL, direct = sql`false`) {
  const c = runtime.config;
  return sql`SELECT 1 FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id
    JOIN nightmail_oidc_identities i ON i.user_id=u.id AND i.issuer=${c.accountIssuer}
    WHERE m.workspace_id=${workspaceId} AND m.user_id=${userId}
    AND (m.role IN ('owner','admin') OR (${c.multiTenant} AND m.role='member' AND ${direct}))
    AND (${c.multiTenant} OR ${JSON.stringify(c.allowedSubjects)}::jsonb ? i.subject) LIMIT 1 FOR SHARE OF m,u,i`;
}
export async function originAllowed(runtime: Runtime, db: DbExecutor, mail: { workspaceId: string; actorKeyId: string; campaignId?: string | null; snapshot: Pick<EmailSnapshot, 'from'> }) {
  // Session-origin jobs retain the OIDC principal, not a browser session or bootstrap credential.
  // Queued work may re-check membership but must never create or restore it.
  if (mail.actorKeyId.startsWith('user_')) {
    return (await db.execute(approvedOriginUser(runtime, sql`${mail.workspaceId}`, sql`${mail.actorKeyId.slice(5)}`, sql`${!mail.campaignId}::boolean`))).rows.length > 0;
  }
  if (mail.actorKeyId.startsWith('mbk_')) {
    // Mailbox keys may send only as an address of a mailbox they are scoped to.
    const [key] = await db.select().from(mailboxKeys).where(and(eq(mailboxKeys.id, mail.actorKeyId), eq(mailboxKeys.workspaceId, mail.workspaceId),sql`mail_key_grant_allows(${mailboxKeys.workspaceId},${mailboxKeys.id},'key',${receivingPolicy(runtime.config)}::jsonb)`)).for('share');
    if (!key || key.revokedAt || !key.permissions.includes('send')) return false;
    const [owner] = await db.select({ mailboxId: mailboxAddresses.mailboxId }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, mail.workspaceId), eq(mailboxAddresses.address, mail.snapshot.from.toLowerCase())));
    return !!owner && (!key.mailboxIds || key.mailboxIds.includes(owner.mailboxId));
  }
  if (mail.actorKeyId.startsWith('mcp_')) {
    const grant = await (await wrapModuleLoad(() => import('./mcp-auth.js'))).getMcpGrantActor(runtime, mail.actorKeyId, mail.workspaceId, db, 'lasting');
    return !!grant && (!mail.campaignId || grant.role !== 'member') && grant.workspaceId === mail.workspaceId &&
      (grant.permissions.includes('manage') || grant.permissions.includes('send')) &&
      senderDomainAllowed(grant.domains, mail.snapshot.from.split('@')[1]!);
  }
  // Removed bootstrap origins fail closed; only durable API keys are accepted below.
  const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, mail.actorKeyId), eq(apiKeys.workspaceId, mail.workspaceId),sql`mail_key_grant_allows(${apiKeys.workspaceId},${apiKeys.id},'api_key',${receivingPolicy(runtime.config)}::jsonb)`)).for('share');
  // Shared readers allow parallel sends but conflict with revocation/permission updates through the durable attempt claim,
  // never through SES I/O. Once attempting, revocation cannot recall an in-flight provider call.
  return !!key && !key.revokedAt && (key.permissions.includes('manage') || key.permissions.includes('send')) && senderDomainAllowed(key.domains, mail.snapshot.from.split('@')[1]!);
}
export function checkedDispatchAttachments(ids: string[], rows: (typeof attachments.$inferSelect)[]) {
  validateAttachmentRows(distinctAttachmentIds(ids), rows);
  return rows;
}

const LEGACY_CONTENT_HASH = /^[0-9a-f]{64}$/;
const STATIC_S1_CONTENT_HASH = /^s1:[0-9a-f]{64}$/;
export const isSupportedContentHash = (hash: string | null | undefined): hash is string =>
  !!hash && (LEGACY_CONTENT_HASH.test(hash) || STATIC_S1_CONTENT_HASH.test(hash));
const unsupportedHashFormat = () => new ApiError(409, 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED', 'Paused: this campaign uses a newer content hash format that this release cannot verify. Deploy the matching release before resuming.', undefined, true);
export async function staticContentHash(baseHash: string, email: string): Promise<string> {
  return `s1:${await digest(`${baseHash}:${email}`)}`;
}
/**
 * Verifies a frozen recipient's content_hash in either the legacy full-snapshot format (64 hex chars) or the compact
 * static `s1:` format (`s1:${sha256(baseHash + ':' + email)}`). Unknown future formats throw retryable
 * CAMPAIGN_HASH_FORMAT_UNSUPPORTED so release/dispatch pause and defer instead of rejecting unsent recipients.
 */
export async function verifyCampaignContentHash(customer: EmailSnapshot, storedHash: string): Promise<boolean> {
  if (STATIC_S1_CONTENT_HASH.test(storedHash)) {
    const baseHash = await digest(canonical({ ...customer, to: [] }));
    return (await staticContentHash(baseHash, customer.to[0] ?? '')) === storedHash;
  }
  if (LEGACY_CONTENT_HASH.test(storedHash)) {
    return (await digest(canonical(customer))) === storedHash;
  }
  throw unsupportedHashFormat();
}
// Reviews frozen before campaign mail stopped linking web fonts hold a font block (v1: data-opensend-fonts) whose URLs
// name this installation. A copy goes out, and reads back, without it; its hash and screen key still cover the review
// as frozen. Block HTML has no <style> of its own, so the renderer's block is the only one this can match.
const LEGACY_FONTS = /<style data-(?:bane|opensend)-fonts>[^<]*<\/style>/;
const withoutLegacyFonts = (snapshot: EmailSnapshot): EmailSnapshot => snapshot.html && LEGACY_FONTS.test(snapshot.html) ? { ...snapshot, html: snapshot.html.replace(LEGACY_FONTS, '') } : snapshot;
export async function materializeCampaignEmail(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, review: { version: number; draft: CampaignDraft; rendered: { html?: string; text?: string }; contentHash: string | null; recipient: ReviewedRecipient } | null, prefetched?: (typeof attachments.$inferSelect)[]) {
  // Review/recipient data and attachment metadata are immutable; retained email
  // links prevent attachment deletion. No transaction is needed to render them.
  // The winning claim persists its snapshot and token atomically; losing workers
  // discard their render without writing a different snapshot over the winner.
  const rows = prefetched ? checkedDispatchAttachments(mail.snapshot.attachments, prefetched) : await attachmentRows(runtime.db, a, mail.snapshot.attachments);
  if (!review?.rendered || !review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The reviewed recipient is unavailable.');
  if (!isSupportedContentHash(review.contentHash)) throw unsupportedHashFormat();
  const customer = await campaignMessage(runtime, review.draft, review.recipient, false, rows, review.rendered, true, !review.rendered.html?.includes('{{'), review.version);
  if (!(await verifyCampaignContentHash(customer, review.contentHash))) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_CHANGED', 'The renderer no longer reproduces the reviewed message. No provider attempt was made.');
  // `keyed`: the same customer copy with the footer generated for the placeholder link, as campaign screening keys it.
  const keyed = screenedAs(runtime, customer, review.draft);
  // A required notice has no unsubscribe link: it goes out exactly as it is keyed, and no token is made for it.
  if (review.draft.requiredNotice) {
    sizeCheck(keyed, rows);
    return { mail: { ...mail, snapshot: withoutLegacyFonts({ ...keyed, headers: [...keyed.headers] }) }, rows, unsubscribe: undefined, stored: { kind: 'marketing' as const, deferredCampaign: true, requiredNotice: true as const }, keyed };
  }
  // Keep the origin charged at release (or already rendered on an earlier attempt). Only older rows need a fresh lookup.
  const origin = mail.snapshot.linkOrigin ?? (mail.snapshot.unsubscribeUrl ? new URL(mail.snapshot.unsubscribeUrl).origin : undefined) ?? review.draft.linkOrigin ?? await linkOrigin(runtime, runtime.db, a.workspaceId, review.draft.from);
  // A retried row (throttled requeue) reuses the link it was first rendered with, so every attempt sends the same message.
  const reused = mail.snapshot.unsubscribeUrl?.startsWith(`${origin}/unsubscribe/`) ? mail.snapshot.unsubscribeUrl : undefined;
  // Its link is about the campaign's topic (src/topics.ts), when it has one: its one-click opts out of that topic alone.
  const topicId = review.draft.topicId ?? null;
  const unsubscribe = reused
    ? { url: reused, record: { tokenHash: await digest(reused.slice(reused.lastIndexOf('/') + 1)), workspaceId: a.workspaceId, email: customer.to[0]!.trim().toLowerCase(), topicId } }
    : await (await loadOpsUnsub()).createUnsubscribeLink(origin, a.workspaceId, customer.to[0]!, topicId);
  const page = review.draft.unsubscribePageUrl;
  // Its inline pictures are linked from the same host as its unsubscribe link (src/linked-images.ts).
  const snapshot = { ...withoutLegacyFonts(withUnsubscribe(runtime, customer, unsubscribe.url, { ...review.draft, linkOrigin: origin })), linkOrigin: origin };
  sizeCheck(snapshot, rows);
  // Persist only the compact stub plus the unsubscribe URL: the body is reproducible from the frozen review and
  // recipient (verified by contentHash), so storing ~2-3 KB of rendered HTML per recipient bought nothing.
  const stored = { kind:'marketing' as const,deferredCampaign:true,unsubscribeUrl:unsubscribe.url };
  return { mail: { ...mail, snapshot }, rows, unsubscribe: { ...unsubscribe.record, page }, stored, keyed };
}
// Bump when interpolation, preheader or footer output changes, and keep the previous renderer for older reviews.
export const CAMPAIGN_RENDERER_VERSION = 2;
/** A campaign email that was rendered and sent: its stub keeps the unsubscribe URL, or marks a required notice. */
const sentCampaignEmail = (s: EmailSnapshot) => !!s.deferredCampaign && !!(s.unsubscribeUrl || s.requiredNotice);
// Rebuilds a sent campaign email from its frozen review, recipient values and stored unsubscribe URL, and refuses to
// show anything that does not match the hash of what was reviewed and sent.
type SentReview = { draft: CampaignDraft; rendered: { html?: string; text?: string } | null; renderer_version: number; recipient: ReviewedRecipient; content_hash: string | null };
export async function sentCampaignContent(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect): Promise<EmailSnapshot> {
  if (!mail.reviewId || mail.reviewOrdinal === null || !sentCampaignEmail(mail.snapshot)) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  const found = await runtime.db.execute<SentReview>(sql`
    SELECT v.draft, v.rendered, v.renderer_version, r.recipient, r.content_hash
    FROM sending_campaign_reviews v JOIN sending_review_recipients r ON r.review_id = v.id AND r.ordinal = ${mail.reviewOrdinal}
    WHERE v.id = ${mail.reviewId} AND v.campaign_id = ${mail.campaignId} AND v.workspace_id = ${a.workspaceId}`);
  return rebuildCampaignEmail(runtime, a, mail.snapshot, found.rows[0], await attachmentRows(runtime.db, a, found.rows[0]?.draft.attachments ?? []));
}
// Pure: no writes, no provider calls. Also used to verify stored bodies before they are dropped.
export async function rebuildCampaignEmail(runtime: Runtime, a: Actor, stub: EmailSnapshot, review: SentReview | undefined, rows: (typeof attachments.$inferSelect)[]): Promise<EmailSnapshot> {
  if (!review?.rendered || !review.content_hash) throw new ApiError(410, 'EMAIL_CONTENT_EXPIRED', 'The campaign review this email was rendered from has been retired.');
  if (![1, CAMPAIGN_RENDERER_VERSION].includes(review.renderer_version)) throw new ApiError(409, 'CAMPAIGN_RENDERER_CHANGED', `This email was rendered by campaign renderer v${review.renderer_version}; this release supports v1 and v${CAMPAIGN_RENDERER_VERSION}.`);
  if (!(review.draft.requiredNotice ? stub.requiredNotice : stub.unsubscribeUrl)) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  if (!isSupportedContentHash(review.content_hash)) throw unsupportedHashFormat();
  const snapshot = await campaignMessage(runtime, review.draft, review.recipient, false, rows, review.rendered, true, !review.rendered.html?.includes('{{'), review.renderer_version);
  if (!(await verifyCampaignContentHash(snapshot, review.content_hash))) throw new ApiError(409, 'CAMPAIGN_CONTENT_UNREPRODUCIBLE', 'The renderer no longer reproduces the message that was sent.');
  marketingFooter(snapshot, stub.unsubscribeUrl ?? '', review.draft);
  return withoutLegacyFonts(snapshot);
}
// Accepted means provider acceptance evidence; bounce and complaint rates are over accepted mail. Suppressed mail
// (ineligible at claim time, or dropped by SES Auto Validation before sending) is neither accepted nor bounced.
const campaignOutcomes = (wid: string, campaign: SQL) => sql`SELECT
    count(*) FILTER (WHERE status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed')))::int AS accepted,
    count(*) FILTER (WHERE status = 'bounced')::int AS bounced, count(*) FILTER (WHERE status = 'complained')::int AS complained, max(created_at) AS last
    FROM sending_emails WHERE workspace_id = ${wid} AND campaign_id = ${campaign}`;
async function campaignHealth(db: DbExecutor, a: Actor, campaignId: string, hosted = false, probe?: number): Promise<{ code: string; message: string } | null> {
  const [row] = (await db.execute<{ accepted: number; bounced: number; complained: number }>(campaignOutcomes(a.workspaceId, sql`${campaignId}`))).rows;
  const percent = (part: number, whole: number) => `${(100 * part / whole).toFixed(2)}%`;
  if (probe !== undefined && row!.accepted && (row!.bounced / row!.accepted > PROBE.bounceRate || row!.complained >= PROBE.complaints))
    return { code: 'LIST_QUALITY', message: `Quarantined: the first ${row!.accepted} recipients (the list probe) had ${row!.bounced} hard bounces (${percent(row!.bounced, row!.accepted)}; the line is ${PROBE.bounceRate * 100}%) and ${row!.complained} spam complaints (the line is ${PROBE.complaints}). Bounced addresses were suppressed. Remove contacts you have not mailed before, or confirm the list's source, then resume.` };
  if (probe !== undefined) return null;
  if (row!.accepted >= AUTO_PAUSE.bounceMinimum && row!.bounced / row!.accepted > AUTO_PAUSE.bounceRate)
    return { code: 'BOUNCE_RATE_HIGH', message: `Paused automatically: ${percent(row!.bounced, row!.accepted)} of ${row!.accepted} accepted emails bounced (limit ${AUTO_PAUSE.bounceRate * 100}%). Review the audience before resuming.` };
  if (row!.accepted >= (hosted ? AUTO_PAUSE.hostedComplaintMinimum : AUTO_PAUSE.complaintMinimum) && row!.complained / row!.accepted > AUTO_PAUSE.complaintRate)
    return { code: 'COMPLAINT_RATE_HIGH', message: `Paused automatically: ${percent(row!.complained, row!.accepted)} of ${row!.accepted} accepted emails were marked as spam (limit ${AUTO_PAUSE.complaintRate * 100}%). Review the audience before resuming.` };
  return null;
}
/**
 * The workspace's largest clean, mature hour of real marketing mail in the last RAMP.historyDays days, as SES accepted it:
 * where its campaigns, and its marketing sent through the API, start on the ramp (src/standing-model.ts rampStart).
 * ramp_clean_hour (migration 501) says what counts: mature is 90% of it delivered or bounced; clean is within the ramp's
 * bounce and complaint lines (RAMP_CHECK), and so is the whole window, else nothing counts. The hour still running never
 * counts.
 */
async function rampHistory(db: DbExecutor, workspaceId: string) {
  const [found] = (await db.execute<{ best: number }>(sql`SELECT ramp_clean_hour(${workspaceId},${JSON.stringify(RAMP_POLICY.history)}::jsonb) AS best`)).rows;
  return Number(found?.best ?? 0);
}
/** What a ramp step's hour released (review ordinals after `from`, through the cursor) and the feedback it has so far. */
async function rampBatch(db: DbExecutor, a: Actor, row: Pick<RunRow, 'reviewId' | 'expanded'>, from: number) {
  const [batch] = (await db.execute<{ released: number; waiting: number; accepted: number; resolved: number; bounced: number; complained: number }>(sql`SELECT count(*)::int AS released,
      count(*) FILTER (WHERE status IN ('queued','attempting'))::int AS waiting,
      count(*) FILTER (WHERE status<>'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR event_outcomes & 1 <> 0))::int AS accepted,
      count(*) FILTER (WHERE status IN ('delivered','bounced','complained') OR event_outcomes & 6 <> 0)::int AS resolved,
      count(*) FILTER (WHERE status='bounced' OR event_outcomes & 4 <> 0)::int AS bounced,
      count(*) FILTER (WHERE status='complained' OR event_outcomes & 8 <> 0)::int AS complained
    FROM sending_emails WHERE review_id=${row.reviewId} AND review_ordinal>${from} AND review_ordinal<=${row.expanded} AND workspace_id=${a.workspaceId}`)).rows;
  return batch!;
}
/** A ramp step's batch over the ramp's lines (RAMP_CHECK): the automatic pause's codes, with what the ramp is in the message. */
function rampHealth(batch: Awaited<ReturnType<typeof rampBatch>>, step: number): { code: string; message: string } | null {
  const percent = (part: number) => `${(100 * part / batch.accepted).toFixed(2)}%`, n = (value: number) => value.toLocaleString('en-US');
  const about = `A new sender's large campaign goes out in hourly steps that grow, and each step is checked before the next: this was step ${step + 1} of ${RAMP.steps.length}, up to ${n(RAMP.steps[step]!.ceilingPerHour)} an hour.`;
  if (batch.accepted >= RAMP_CHECK.bounceMinimum && batch.bounced > batch.accepted * RAMP_CHECK.bounceRate)
    return { code: 'BOUNCE_RATE_HIGH', message: `Paused automatically while ramping up: ${n(batch.bounced)} of the last step's ${n(batch.accepted)} accepted emails bounced (${percent(batch.bounced)}; the line is ${RAMP_CHECK.bounceRate * 100}%). ${about} Bounced addresses were suppressed. Review the list, then resume.` };
  if (batch.complained >= RAMP_CHECK.complaints && batch.complained > batch.accepted * RAMP_CHECK.complaintRate)
    return { code: 'COMPLAINT_RATE_HIGH', message: `Paused automatically while ramping up: ${n(batch.complained)} of the last step's ${n(batch.accepted)} accepted emails were marked as spam (${percent(batch.complained)}; the line is ${RAMP_CHECK.complaintRate * 100}%). ${about} Review the audience, then resume.` };
  return null;
}
/**
 * Whether a sender in good standing may skip this campaign's list probe: an earlier campaign delivered to these
 * recipients, by address, and their feedback is in and clean. It reads every one of this launch's frozen recipients,
 * whatever list or segment they came from, against what one of the workspace's last three campaigns finished in the last
 * 90 days did with the same addresses. A campaign over 10,000 recipients is always probed: it is never read in part.
 *  - it delivered to at least 90% of them: an address it bounced, drew a complaint from, never mailed or has no result
 *    for counts against it;
 *  - their feedback is mature: at least 90% of those it mailed resolved as delivered or bounced, and the probe's ten-minute
 *    wait has passed since the last of them changed (its acceptance, or feedback after it);
 *  - it was clean: hard bounces within the probe's 3% and complaints within the automatic pause's 0.08% of those it mailed.
 * That campaign finished without a quarantine and was not one released only to earlier recipients after one.
 */
const CLEAN_LIST = { days: 90, coverage: 0.9, resolved: 0.9, candidates: 3, largest: 10_000 } as const;
export async function listMailedCleanly(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, row: Pick<RunRow, 'id' | 'reviewId' | 'total'>) {
  if (row.total > CLEAN_LIST.largest) return false;
  // This launch's addresses (at most 10,000), then each candidate's mail to them, matched by a hashed array lookup.
  const emails = (await db.execute<{ email: string }>(sql`SELECT DISTINCT lower(recipient->>'email') AS email FROM sending_review_recipients WHERE review_id=${row.reviewId}`)).rows.map(r => r.email);
  if (!emails.length) return false;
  const [found] = (await db.execute<{ clean: boolean }>(sql`WITH candidates AS MATERIALIZED (
      SELECT c.id FROM sending_campaigns c WHERE c.workspace_id=${a.workspaceId} AND c.id<>${row.id} AND c.state='done' AND NOT c.simulated AND c.quarantines=0 AND NOT c.delivered_only
        AND c.updated_at>now()-make_interval(days=>${CLEAN_LIST.days}::int) ORDER BY c.updated_at DESC LIMIT ${CLEAN_LIST.candidates}
    ), mailed AS MATERIALIZED (
      SELECT e.campaign_id,lower(e.to_addresses->>0) AS email,bool_or(e.status='delivered' OR e.event_outcomes & 2 <> 0) AS delivered,
        bool_or(e.status='bounced' OR e.event_outcomes & 4 <> 0) AS bounced,bool_or(e.status='complained' OR e.event_outcomes & 8 <> 0) AS complained,max(e.updated_at) AS changed
      FROM candidates c JOIN sending_emails e ON e.workspace_id=${a.workspaceId} AND e.campaign_id=c.id AND lower(e.to_addresses->>0)=ANY(${sql.param(emails)}::text[])
        AND e.status<>'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR e.event_outcomes & 1 <> 0)
      GROUP BY 1,2
    ), history AS (
      SELECT campaign_id,count(*) FILTER (WHERE delivered AND NOT bounced AND NOT complained) AS covered,count(*) AS mailed,count(*) FILTER (WHERE delivered OR bounced) AS resolved,
        count(*) FILTER (WHERE bounced) AS bounced,count(*) FILTER (WHERE complained) AS complained,max(changed) AS changed
      FROM mailed GROUP BY campaign_id
    )
    SELECT EXISTS (SELECT FROM history h
      WHERE h.covered>0 AND h.covered>=${Math.ceil(CLEAN_LIST.coverage * emails.length)}::int AND h.resolved>=h.mailed*${CLEAN_LIST.resolved}::numeric
        AND h.changed<=now()-make_interval(secs=>${PROBE.waitMs / 1000}::int) AND h.bounced<=h.mailed*${PROBE.bounceRate}::numeric AND h.complained<=h.mailed*${AUTO_PAUSE.complaintRate}::numeric) AS clean`)).rows;
  return found!.clean;
}
// The campaign row with its frozen snapshot and the cached regional limits: one read per step of the run job.
type RunAccount = NonNullable<Actor['dispatchAccount']> & { pauseReason: string | null; generation:number; trusted: boolean; probation: ProbationReason | null; exempt: boolean };
type RunRow = typeof campaigns.$inferSelect & { reviewVersion: number | null; reviewDraft: CampaignDraft | null; reviewRendered: { html?: string; text?: string } | null; reviewHash: string | null; reviewScreen: CampaignScreen | null; reviewCapturedAt: string | null; reviewCapturedCount: number | null; reviewStaticPrepared: boolean | null; rate: number; max24: number; sent24: number; customer24: number; quotaCheckedAt: string | null; priorityLagMs: number | null; dbNow: string; account: RunAccount | null };
async function readRun(runtime: Runtime, a: Actor, campaignId: string): Promise<RunRow | undefined> {
  const limits = limitsTable(runtime), region = sql`${campaignReviews.draft}->>'region'`;
  const [row] = await runtime.db.select({ ...getTableColumns(campaigns), reviewVersion: campaignReviews.rendererVersion, reviewDraft: campaignReviews.draft, reviewRendered: campaignReviews.rendered, reviewHash: campaignReviews.contentHash, reviewScreen: campaignReviews.screen, reviewCapturedAt: campaignReviews.capturedAt, reviewCapturedCount: campaignReviews.capturedCount, reviewStaticPrepared: campaignReviews.staticPrepared,
    autoPause: runtime.config.multiTenant ? sql<boolean>`${campaigns.autoPause} OR ${sharedConnection(a.workspaceId)}` : campaigns.autoPause,
    account: runtime.config.multiTenant ? sql<RunAccount>`(SELECT jsonb_build_object('aws_account_id', aws_account_id, 'kind', kind, 'pauseReason', pause_reason,'generation',generation,
      'trusted', ${!!runtime.config.trustedPool} AND coalesce(pool_tier='trusted' AND legacy_names=false, false),'probation',${probationReason(sql`${a.workspaceId}::text`)},
      'exempt',(SELECT exempt_hosted_quotas FROM workspaces WHERE id=${a.workspaceId}))
      FROM ${sendingConnections(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region})` : sql<null>`NULL`,
    rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    max24: sql<number>`coalesce((SELECT max_24_hour_send FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    sent24: sql<number>`coalesce((SELECT sent_last_24_hours FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    customer24: runtime.config.multiTenant ? sql<number>`coalesce((SELECT customer_sent_24_hours FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)` : sql<number>`0`,
    quotaCheckedAt: sql<string | null>`(SELECT checked_at::text FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region})`,
    priorityLagMs: sql<number | null>`coalesce(
      (SELECT oldest_ms FROM operation_feedback_lag WHERE lane = 'priority' AND updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)),
      (SELECT oldest_ms FROM operation_feedback_lag WHERE lane = 'routine' AND updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)
        AND NOT EXISTS (SELECT 1 FROM operation_feedback_lag WHERE lane = 'priority'))
    )`,
    dbNow: sql<string>`clock_timestamp()::text`,
  }).from(campaigns).leftJoin(campaignReviews, eq(campaignReviews.id, campaigns.reviewId)).where(campaignWhere(a, campaignId));
  return row;
}
/** How a campaign's copies are delivered (src/dispatcher.ts prepareMail decides the same per message): the probation copy,
 *  as written under the image rule, or (the trusted tier) as written. */
const contentRules = (row: RunRow) => !row.account || row.account.trusted ? null : row.account.probation !== null ? 'probation' as const : 'standard' as const;
const staleReview = () => new ApiError(409,'SENDER_BINDING_CHANGED','The reviewed sending binding is no longer ready.');
/** A campaign's message as admission sees it at preparation and release: its reviewed sender, region and binding. */
const reviewedMail = (draft: CampaignDraft): AdmissionMail & { from: string; binding?: SendingBinding } => ({ host: draft.from.split('@')[1]!.toLowerCase(), from: draft.from,
  region: draft.region, binding: draft.binding, kind: 'marketing', attachments: [...new Set(draft.attachments)], bodyBytes: 0 });
const PLACEHOLDER = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;
/** The placeholders a campaign's subject and rendered parts use: the contact properties its audience snapshot keeps. */
const placeholderKeys = (draft: Pick<CampaignDraft, 'subject'>, rendered: { html?: string; text?: string }) =>
  [...new Set([draft.subject, rendered.html ?? '', rendered.text ?? ''].flatMap(value => [...value.matchAll(PLACEHOLDER)].map(match => match[1]!)))];
/** Whether the dispatcher screens a campaign's mail (dispatcher.ts prepareMail): Hosted shared sending, live, with a classifier. */
const campaignScreened = screenedAtDispatch;
/** The unsubscribe link a campaign copy is screened with: the one part of a copy Nightmail generates per recipient. */
export const unsubscribePlaceholder = (origin: string) => `${origin.replace(/\/$/, '')}/unsubscribe/u_${'0'.repeat(64)}`;
/** The link host of a campaign's copies as its launch froze it; this installation's own origin for a review frozen before
 *  link hosts, which its screen keys were made with. Only keys and checks use that origin: delivery never does. */
const keyedOrigin = (runtime: Runtime, footer: Footer) => footer.linkOrigin ?? runtime.config.publicUrl;
/** A campaign's own copy as each recipient gets it, placeholders unresolved: preheader, and footer with a placeholder link. */
export async function campaignCopy(runtime: Runtime, draft: CampaignDraft, rendered: { html?: string; text?: string }, version = CAMPAIGN_RENDERER_VERSION): Promise<EmailSnapshot> {
  const parse = rendered.html && draft.previewText ? await loadParse5() : undefined;
  const copy: EmailSnapshot = { testCampaignId: null, from: draft.from, ...(draft.fromName ? { fromName: draft.fromName } : {}), ...(draft.previewText !== undefined ? { previewText: draft.previewText } : {}),
    to: [], cc: [], bcc: [], replyTo: draft.replyTo ?? [], region: draft.region, kind: 'marketing', subject: draft.subject, html: withPreheader(rendered.html, draft.previewText, parse, version), text: rendered.text,
    attachments: draft.attachments, tracking: draft.tracking, headers: [] };
  marketingFooter(copy, unsubscribePlaceholder(keyedOrigin(runtime, draft)), draft);
  return copy;
}
export type CampaignScreenRef = { workspaceId: string; campaignId: string; reviewId: string };
export type CopyVerdict = (ScreenResult & { key: string }) | { refused: ApiError } | null;
/**
 * Verdicts for campaign copies, each keyed by the copy as it is delivered (src/screen.ts copyKey), with its own
 * unsubscribe link set back to the placeholder (screenedAs). Each distinct copy is screened as a single message is
 * (src/screen.ts screenInput), once: a verdict is durable per campaign and key (sending_campaign_screens), copies with
 * the same key share it, a relaunch of the same campaign reuses it, and an interrupted screen resumes at its next
 * request. Every request is charged to the review's budget before it is made, whether or not it succeeds, so a retry
 * asks only for what is left. Returns, per copy, its verdict, the refusal of a copy over the campaign limit, or null when
 * the deadline came first.
 */
export async function campaignVerdicts(runtime: Runtime, ref: CampaignScreenRef, copies: EmailSnapshot[], deadline: number): Promise<CopyVerdict[]> {
  const screen = await loadScreen(), keys = await Promise.all(copies.map(copy => screen.copyKey(runtime, copy)));
  // A plain loop: no closure here may hold the copies, which are as large as a message, past this call.
  const distinct = new Map<string, EmailSnapshot>();
  for (let i = 0; i < copies.length; i++) if (!distinct.has(keys[i]!)) distinct.set(keys[i]!, copies[i]!);
  type Row = { copy_hash: string; windows: number; spam: number; model: string | null; threshold: number | null; judged: boolean };
  const fields = sql`copy_hash,windows,spam,model,threshold,judged_at IS NOT NULL AS judged`;
  const select = async (hashes: string[]) => new Map((hashes.length ? (await runtime.db.execute<Row>(sql`SELECT ${fields} FROM sending_campaign_screens
    WHERE workspace_id=${ref.workspaceId} AND campaign_id=${ref.campaignId} AND copy_hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`)).rows : []).map(row => [row.copy_hash, row]));
  let rows = await select([...distinct.keys()]);
  // Only a copy without a verdict is read: measured (one over the campaign limit is refused), and its requests built.
  const inputs = new Map<string, import('./screen.js').ScreenInput>(), refusals = new Map<string, ApiError>();
  for (const [key, copy] of distinct) {
    if (rows.get(key)?.judged) continue;
    try { inputs.set(key, await screen.screenInput(runtime, copy)); }
    catch (error) { if (error instanceof ApiError && error.code === 'CONTENT_TOO_LARGE_TO_SCREEN') refusals.set(key, error); else throw error; }
  }
  if (inputs.size) {
    await runtime.db.execute(sql`INSERT INTO sending_campaign_screens(campaign_id,workspace_id,copy_hash,requests)
      SELECT ${ref.campaignId},${ref.workspaceId},x.key,x.requests FROM jsonb_to_recordset(${JSON.stringify([...inputs].map(([key, input]) => ({ key, requests: input.requests.length })))}::jsonb) x(key text,requests int)
      ON CONFLICT (campaign_id,copy_hash) DO NOTHING`);
    rows = new Map([...rows, ...await select([...inputs.keys()])]);
  }
  const work = [...inputs.keys()].filter(key => !rows.get(key)?.judged);
  const call = { workspaceId: ref.workspaceId, campaignId: ref.campaignId, region: copies[0]?.region, kind: 'marketing', required: true };
  const charge = async () => {
    const charged = await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen_charged=screen_charged+1
      WHERE workspace_id=${ref.workspaceId} AND id=${ref.reviewId} AND screen_charged<screen_budget`);
    if (!charged.rowCount) throw new ApiError(422, 'CONTENT_SCREEN_BUDGET_EXCEEDED', 'This campaign has used the classifier requests its audience allows; its unscreened copies are not sent.');
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
    while (next < work.length && Date.now() < deadline) {
      const key = work[next++]!, input = inputs.get(key)!;
      let row = rows.get(key)!;
      while (!row.judged) {
        const result = await screen.screenWindow(runtime, input, row.windows, call, key, charge);
        const winner = row.threshold === null || row.model === null ? result : screen.decisiveVerdict({ spam: row.spam, model: row.model, threshold: row.threshold }, result);
        const [moved] = (await runtime.db.execute<Row>(sql`UPDATE sending_campaign_screens SET windows=windows+1,spam=${winner.spam},model=${winner.model},threshold=${winner.threshold},
          judged_at=CASE WHEN windows+1>=requests THEN clock_timestamp() END
          WHERE campaign_id=${ref.campaignId} AND copy_hash=${key} AND windows=${row.windows}
          RETURNING ${fields}`)).rows;
        row = moved ?? (await runtime.db.execute<Row>(sql`SELECT ${fields} FROM sending_campaign_screens WHERE campaign_id=${ref.campaignId} AND copy_hash=${key}`)).rows[0]!;
      }
      rows.set(key, row);
    }
  }));
  return keys.map(key => {
    const refused = refusals.get(key);
    if (refused) return { refused };
    const row = rows.get(key);
    return row?.judged && row.threshold !== null && row.model !== null ? { key, spam: row.spam, model: row.model, threshold: row.threshold } : null;
  });
}
/** The unsubscribe link Nightmail generates for one recipient (src/operations.ts createUnsubscribeLink): the copy's link
 *  host (`origin`), `/unsubscribe/u_` and 64 lowercase hex digits, and nothing else. */
export function generatedUnsubscribeUrl(origin: string, value: string): string {
  const prefix = `${origin.replace(/\/$/, '')}/unsubscribe/u_`;
  if (!value.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(value.slice(prefix.length))) throw new ApiError(409, 'UNSUBSCRIBE_LINK_INVALID', 'The unsubscribe link of this message is not one this installation generated. No provider attempt was made.');
  return value;
}
/**
 * A campaign copy as it is keyed and screened (src/screen.ts copyKey): the customer's copy byte for byte, with the slots
 * Nightmail adds to it (the unsubscribe footer's link and the List-Unsubscribe headers, marketingFooter) generated for
 * the placeholder link. The copy is delivered with the same slots generated for the recipient's own link
 * (withUnsubscribe), from the same customer copy, so the two differ only there: nothing is ever found or replaced in the
 * customer's content, and the customer's bytes, whatever they hold, are part of the key.
 */
export function screenedAs(runtime: Runtime, customer: EmailSnapshot, footer: Footer = {}): EmailSnapshot {
  const copy = { ...customer, headers: [...customer.headers] };
  marketingFooter(copy, unsubscribePlaceholder(keyedOrigin(runtime, footer)), footer);
  return copy;
}
/** A campaign copy as delivered: the customer's copy with the footer and headers generated for the recipient's link. */
export function withUnsubscribe(runtime: Runtime, customer: EmailSnapshot, url: string, footer: Footer = {}): EmailSnapshot {
  const copy = { ...customer, headers: [...customer.headers] };
  marketingFooter(copy, generatedUnsubscribeUrl(keyedOrigin(runtime, footer), url), footer);
  return copy;
}
const SCREEN_AHEAD = 2000, SCREEN_PAGE = 500, SCREEN_BUDGET_MS = 8000, SCREEN_CONCURRENCY = 4, SCREEN_BYTES_IN_FLIGHT = 8 * 1024 * 1024;
const screenBackoff = (failures: number) => new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures, 5))).toISOString();
async function saveScreen(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen) {
  await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen=${JSON.stringify(state)}::jsonb WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId}`);
  return state;
}
// A classifier outage waits in place, longer each time in a row; nothing is released without a verdict.
async function screenOutage(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen, error: unknown): Promise<never> {
  if (!(error instanceof ApiError) || error.code !== 'CONTENT_SCREEN_UNAVAILABLE') throw error;
  await saveScreen(runtime, a, row, { ...state, failures: state.failures + 1 });
  log('warn', { code: error.code, campaignId: row.id, failures: state.failures + 1 });
  throw new JobDeferred(screenBackoff(state.failures));
}
const screenRef = (a: Actor, row: RunRow): CampaignScreenRef => ({ workspaceId: a.workspaceId, campaignId: row.id, reviewId: row.reviewId! });
// preparing, before any recipient: the campaign's own copy, placeholders unresolved, is screened first as an early
// refusal, and the review gets its budget: enough requests to screen every recipient's copy on its own, and a few retries.
async function screenCampaignStep(runtime: Runtime, a: Actor, row: RunRow) {
  const limits = runtime.config.screenLimits, screen = await loadScreen();
  const rules = contentRules(row), fresh: CampaignScreen = { contentHash: row.reviewHash!, probation: rules === 'probation', template: null, screenedThrough: 0, recipients: 0, rejected: 0, failures: 0, quarantined: false };
  const state = row.reviewScreen?.contentHash === row.reviewHash ? row.reviewScreen! : await saveScreen(runtime, a, row, fresh);
  await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen_budget=${(Math.max(row.total, 1) + 10) * screen.chunksFor(limits.campaignBytes)} WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId} AND screen_budget IS NULL`);
  const own = await campaignCopy(runtime, row.reviewDraft!, row.reviewRendered!, row.reviewVersion!);
  let verdict: CopyVerdict;
  try { [verdict] = await campaignVerdicts(runtime, screenRef(a, row), [rules ? (await import('./screened-html.js')).hostedCopy(own, rules === 'probation') : own], Date.now() + SCREEN_BUDGET_MS); }
  catch (error) { return screenOutage(runtime, a, row, state, error); }
  if (!verdict) return;
  if ('refused' in verdict) throw verdict.refused;
  const done = await saveScreen(runtime, a, row, { ...state, template: verdict, failures: 0 });
  log('info', { code: 'CAMPAIGN_TEMPLATE_SCREENED', campaignId: row.id, spam: verdict.spam, model: verdict.model, threshold: verdict.threshold });
  if (verdict.spam >= verdict.threshold) await campaignRejected(runtime, a, row, done);
}
// sending, before a release: the next recipients' copies are rendered as delivered and screened, each distinct one
// once, and the release never goes past the last recipient whose copy has a verdict (dispatch refuses a copy the screen
// refused, and screens on its own any copy without a verdict). Copies stream through a few at a time, as many as fit
// SCREEN_BYTES_IN_FLIGHT by their prepared size (snapshot_bytes, and the size each copy actually rendered at), and only
// a digest of each is kept. The completed prefix is checkpointed about every second; the time budget is checked after
// each group, so a pass always gets at least one copy through however long it takes.
async function screenAhead(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen, through: number): Promise<CampaignScreen> {
  const draft = row.reviewDraft!, rendered = row.reviewRendered!, started = Date.now(), ref = screenRef(a, row), screen = await loadScreen();
  const assets = await attachmentRows(runtime.db, a, draft.attachments);
  const probationCopy = contentRules(row) === 'probation' ? (await import('./screened-html.js')).probationCopy : undefined;
  // Copies that are the same up to their recipient share one screen: by a digest of the copy, never the copy itself.
  const forms = new Map<string, Promise<CopyVerdict>>();
  const verdictOf = async (recipient: ReviewedRecipient) => {
    const keyed = screenedAs(runtime, await campaignMessage(runtime, draft, recipient, false, assets, rendered, true, !rendered.html?.includes('{{'), row.reviewVersion!), draft);
    // The copy as the dispatcher keys it (probation senders' rewritten, src/dispatcher.ts prepareMail).
    const copy = probationCopy ? probationCopy({ ...keyed, to: [] }) : { ...keyed, to: [] };
    const size = Buffer.byteLength(copy.html ?? '') + Buffer.byteLength(copy.text ?? ''), form = await screen.copyKey(runtime, copy);
    let verdict = forms.get(form);
    if (!verdict) { verdict = campaignVerdicts(runtime, ref, [copy], Number.POSITIVE_INFINITY).then(([one]) => one ?? null); forms.set(form, verdict); }
    return { verdict: await verdict, size };
  };
  let progress = state, judged: { email: string; rejected: number }[] = [], rejectedOrdinals: number[] = [], saved = Date.now(), largest = 0;
  // Reputation counts each recipient's verdict when the screen judged it, whether or not it is released; the dispatcher
  // doesn't count these copies again. Failing copies are marked screen_rejected so releaseStep never queues them.
  const checkpoint = async () => {
    if (rejectedOrdinals.length) {
      await runtime.db.execute(sql`UPDATE sending_review_recipients SET screen_rejected = true
        WHERE review_id = ${row.reviewId} AND ordinal = ANY(${sql.param(rejectedOrdinals)}::int[])`);
      rejectedOrdinals = [];
    }
    if (judged.length) await runtime.db.execute(countScreened(sql`SELECT ${a.workspaceId}::text AS workspace_id,x.rejected FROM jsonb_to_recordset(${JSON.stringify(judged)}::jsonb) x(email text,rejected int)
      WHERE hosted_real_cost(jsonb_build_array(x.email))>0`));
    judged = []; saved = Date.now();
    return saveScreen(runtime, a, row, progress);
  };
  try {
    pages: while (progress.screenedThrough < through) {
      const page = await recipientChunk(runtime.db, row.reviewId!, progress.screenedThrough, Math.min(SCREEN_PAGE, through - progress.screenedThrough));
      for (let next = 0; next < page.length;) {
        const group = [page[next]!];
        let bytes = Math.max(largest, Number(page[next]!.snapshot_bytes ?? 0));
        while (group.length < SCREEN_CONCURRENCY && next + group.length < page.length) {
          const more = Math.max(largest, Number(page[next + group.length]!.snapshot_bytes ?? 0));
          if (bytes + more > SCREEN_BYTES_IN_FLIGHT) break;
          bytes += more; group.push(page[next + group.length]!);
        }
        const results = await Promise.all(group.map(recipient => verdictOf(recipient.recipient)));
        let rejected = 0;
        for (const [i, { verdict, size }] of results.entries()) {
          largest = Math.max(largest, size);
          if (!verdict) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'A copy was left without a verdict.', undefined, true);
          const spamRefused = 'spam' in verdict && verdict.spam >= verdict.threshold;
          const refused = spamRefused || 'refused' in verdict;
          if (refused) {
            rejectedOrdinals.push(group[i]!.ordinal);
            if (spamRefused) rejected++;
          }
          if ('spam' in verdict) judged.push({ email: group[i]!.recipient.email, rejected: spamRefused ? 1 : 0 });
        }
        progress = { ...progress, screenedThrough: group.at(-1)!.ordinal, recipients: progress.recipients + group.length, rejected: progress.rejected + rejected, failures: 0 };
        next += group.length;
        if (Date.now() - started >= SCREEN_BUDGET_MS) break pages;
        if (Date.now() - saved >= 1000) await checkpoint();
      }
    }
  } catch (error) {
    await checkpoint();
    return screenOutage(runtime, a, row, progress, error);
  }
  return checkpoint();
}
async function campaignRejected(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen): Promise<never> {
  await runtime.db.execute(countScreened(sql`SELECT v.workspace_id,1 AS rejected FROM sending_campaign_reviews v JOIN sending_review_recipients r ON r.review_id=v.id
    WHERE v.workspace_id=${a.workspaceId} AND v.id=${row.reviewId} AND hosted_real_cost(jsonb_build_array(r.recipient->>'email'))>0`));
  log('warn', { code: 'CONTENT_REJECTED_SPAM', campaignId: row.id, spam: state.template?.spam, model: state.template?.model });
  throw new ApiError(422, 'CONTENT_REJECTED_SPAM', 'The content classifier judged this campaign to be deceptive or harmful. No recipient was sent to.');
}
const STATIC_PREPARE_SLICE_ROWS = 200_000;

/** Validates a static campaign once and computes the shared s1: base digest and JSON byte size (excluding recipient to). */
async function prepareStaticStamp(
  runtime: Runtime,
  draft: CampaignDraft,
  rendered: { html?: string; text?: string },
  lockedAttachments: AttachmentFacts[],
  reviewVersion: number,
) {
  const parse = rendered.html ? await loadParse5() : undefined;
  validateInterpolationTemplate(draft.subject, false);
  validateInterpolationTemplate(rendered.html, true, parse);
  validateInterpolationTemplate(rendered.text, false);
  await validateHtmlUrls(rendered.html);
  // Build once with a longest-shape valid recipient address (254 bytes) to verify SendInput, headers and MIME sizeCheck.
  const longestValid = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  const staticSnapshot = await campaignMessage(runtime, draft, { id: 'static', email: longestValid, properties: {} }, false, lockedAttachments, rendered, true, true, reviewVersion);
  const baseHash = await digest(canonical({ ...staticSnapshot, to: [] }));
  const withFooter = { ...staticSnapshot, headers: [...staticSnapshot.headers] };
  marketingFooter(withFooter, unsubscribePlaceholder(keyedOrigin(runtime, draft)), draft);
  sizeCheck(withFooter, lockedAttachments);
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...withFooter, to: [] }), 'utf8');
  return {
    baseHash,
    baseBytes,
    storedSubject: staticSnapshot.subject === draft.subject ? null : staticSnapshot.subject,
  };
}

/**
 * Transaction 2 of background capture (normal READ COMMITTED, milliseconds): locks send scope + campaign row,
 * reconciles recipient reservation for any delta against the initial estimate, updates Hosted screen_budget if needed,
 * records the exact frozen total/prepared cursors, and advances state via runningState(). Idempotent across crashes
 * between Tx 1 commit and Tx 2 commit.
 */
async function finalizeCapture(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const ref = campaignRef(a, row.id);
  const hosted = row.account?.kind === 'shared';
  await runtime.db.transaction(async db => {
    const held = await lockSendScope(db, a.workspaceId, { campaignId: row.id });
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return;
    const [rev] = (await db.execute<{ captured_at: string | null; captured_count: number | null; static_prepared: boolean }>(sql`
      SELECT captured_at::text, captured_count, static_prepared FROM sending_campaign_reviews WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`)).rows;
    if (!rev?.captured_at || rev.captured_count === null) return;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: row.reviewDraft!.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return; }
    // Delta is > 0 when onProgress skipped under pool contention (leaving campaign.total at its initial estimate).
    const delta = Math.max(0, rev.captured_count - campaign.total);
    try {
      await reserveCampaign(runtime, db, held, a, a.keyId, delta);
    } catch (error) {
      // A pending/recipient limit refusal after the 202 must fail the campaign immediately (leaving the draft editable)
      // rather than retrying 6 times over ~81 minutes while the campaign looks stuck in preparing.
      if (error instanceof ApiError && (error.code === 'CAMPAIGN_PENDING_LIMIT_EXCEEDED' || error.code.endsWith('_LIMIT_EXCEEDED'))) {
        throw new ApiError(error.status, error.code, error.message, error.field, false);
      }
      throw error;
    }
    if (campaignScreened(runtime, hosted)) {
      const limits = runtime.config.screenLimits, screen = await loadScreen();
      const needed = (rev.captured_count + 10) * screen.chunksFor(limits.campaignBytes);
      await db.execute(sql`UPDATE sending_campaign_reviews SET screen_budget = greatest(coalesce(screen_budget, 0), ${needed}) WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
    }
    const prepared = rev.static_prepared ? rev.captured_count : 0;
    const next = runningState({ prepared, total: rev.captured_count, scheduledAt: campaign.scheduledAt });
    const set = sql`,total=${rev.captured_count},prepared=${prepared}`;
    await db.execute(next === 'preparing' ? sql`UPDATE sending_campaigns SET updated_at=now()${set} WHERE workspace_id=${a.workspaceId} AND id=${row.id} AND state='preparing' RETURNING id`
      : sql`UPDATE sending_campaigns SET state=${next},updated_at=now()${set} WHERE workspace_id=${a.workspaceId} AND id=${row.id} AND state='preparing' RETURNING id`);
    await db.execute(sql`UPDATE sending_campaign_reviews SET captured_count = NULL WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
    log('info', { code: 'CAMPAIGN_CAPTURE_FINALIZED', jobId, campaignId: campaign.id, total: rev.captured_count, prepared, staticPrepared: rev.static_prepared, nextState: next });
  });
}

/**
 * Background audience freeze for large campaigns (>5,000 list members).
 * Runs inside ONE REPEATABLE READ transaction so the frozen set is a single consistent MVCC snapshot even when contacts
 * unsubscribe or imports commit concurrently. Inserts run in bounded 200,000-row slices (each <= ~3 s on lab), reporting
 * live progress on a separate pool connection without touching sending_campaigns inside the REPEATABLE READ transaction
 * (avoiding 40001 conflicts). Static campaigns validate addresses and stamp s1: content_hash inline during capture.
 */
async function captureStep(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const screenState = campaignScreened(runtime, row.account?.kind === 'shared') ? row.reviewScreen?.contentHash === row.reviewHash ? row.reviewScreen : null : undefined;
  if (screenState !== undefined && screenState?.template?.threshold === undefined) return screenCampaignStep(runtime, a, row);
  if (screenState?.template && screenState.template.spam >= screenState.template.threshold!) return campaignRejected(runtime, a, row, screenState);

  const review = { draft: row.reviewDraft!, rendered: row.reviewRendered! };
  const draft = review.draft;
  const parsedAudience = AudienceSpec.safeParse(draft.audience);
  if (!parsedAudience.success || !draft.from || !draft.subject) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen campaign draft is incomplete.');
  const audienceSpec = parsedAudience.data;
  const propertyKeys = placeholderKeys(draft, review.rendered);
  const messageStatic = ![draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));

  // Verify origin + admission + attachments before starting the REPEATABLE READ capture transaction.
  const prepCheck = await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return null;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return null; }
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'prepare', locks: 'none', mails: [reviewedMail(draft)] }, undefined, actorAssets(a, draft.attachments));
    const lockedAttachments = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId, { retryable: ['SES_SETUP_REQUIRED'] }).assets;
    // Verify the review is still uncaptured before clearing stale progress from an interrupted attempt (guards against
    // a stalled run resetting a capture that another attempt already finished).
    const [revCheck] = (await db.execute<{ captured_at: string | null }>(sql`SELECT captured_at::text FROM sending_campaign_reviews WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`)).rows;
    if (!revCheck || revCheck.captured_at !== null) return null;
    if (campaign.prepared > 0) await db.execute(sql`UPDATE sending_campaigns SET prepared = 0, updated_at = now() WHERE workspace_id = ${a.workspaceId} AND id = ${row.id} AND state = 'preparing' AND review_id = ${row.reviewId}`);
    return { lockedAttachments };
  });
  if (!prepCheck) return;

  const staticStamp = messageStatic
    ? await prepareStaticStamp(runtime, draft, review.rendered, prepCheck.lockedAttachments, row.reviewVersion!)
    : undefined;
  const audienceMod = await wrapModuleLoad(() => import('./audience.js'));
  const topic = await campaignTopic(runtime.db, a.workspaceId, draft, false);
  const started = Date.now();
  let aborted = false;

  try {
    await runtime.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const counts = await audienceMod.snapshotCampaignAudience(tx, a, audienceSpec, row.reviewId!, propertyKeys, draft.requiredNotice === true, {
        large: true,
        topic,
        staticStamp,
        // The list probe's sample leads only where the probe applies (Hosted shared sending, live).
        ...row.account?.kind === 'shared' && !row.simulated ? { leading: probeSize } : {},
        onProgress: async progress => {
          // Separate pool connection (runtime.db): checks for cancel/unschedule and publishes visible progress without
          // mutating sending_campaigns inside the REPEATABLE READ transaction. Server-side lock_timeout (500 ms) and
          // statement_timeout (800 ms) cancel blocked writes cleanly in Postgres (no leaked connections or hung backends),
          // and fencing on v.captured_at IS NULL + greatest(c.prepared, ...) ensures a late write can never move prepared
          // backwards or overwrite a finished capture.
          try {
            return await runtime.db.transaction(async ptx => {
              await ptx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
              await ptx.execute(sql`SET LOCAL statement_timeout = '800ms'`);
              const [cur] = (await ptx.execute<{ state: string; review_id: string | null }>(sql`
                SELECT state, review_id FROM sending_campaigns WHERE workspace_id = ${a.workspaceId} AND id = ${row.id}`)).rows;
              if (!cur || cur.state !== 'preparing' || cur.review_id !== row.reviewId) return 'abort' as const;
              const visiblePrepared = Math.min(progress.prepared, Math.max(0, progress.total - 1));
              await ptx.execute(sql`
                UPDATE sending_campaigns c
                SET total = ${progress.total}, prepared = greatest(c.prepared, ${visiblePrepared}), updated_at = now()
                FROM sending_campaign_reviews v
                WHERE c.workspace_id = ${a.workspaceId} AND c.id = ${row.id}
                  AND c.state = 'preparing' AND c.review_id = ${row.reviewId}
                  AND v.id = c.review_id AND v.workspace_id = c.workspace_id AND v.captured_at IS NULL`);
              return 'continue' as const;
            });
          } catch {
            return 'continue';
          }
        },
      });
      await tx.execute(sql`
        UPDATE sending_campaign_reviews
        SET captured_at = now(), captured_count = ${counts.eligible}, static_prepared = ${Boolean(staticStamp)}
        WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
      log('info', { code: 'CAMPAIGN_CAPTURE_COMPLETED', jobId, campaignId: row.id, reviewId: row.reviewId, eligible: counts.eligible, staticPrepared: Boolean(staticStamp), durationMs: Date.now() - started });
    });
  } catch (error) {
    if (error instanceof audienceMod.CaptureAborted) { aborted = true; }
    else if ([error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014')) throw captureTimedOut();
    else throw error;
  }
  if (aborted) return;
  await finalizeCapture(runtime, a, row, jobId);
}

// preparing: validate the next chunk of frozen recipients (every substitution, URL and MIME size) and keep only each
// message's digest; when the whole list is validated the campaign moves to its schedule or straight to sending.
async function prepareStep(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const state = campaignScreened(runtime, row.account?.kind === 'shared') ? row.reviewScreen?.contentHash === row.reviewHash ? row.reviewScreen : null : undefined;
  if (state !== undefined && state?.template?.threshold === undefined) return screenCampaignStep(runtime, a, row);
  if (state?.template && state.template.spam >= state.template.threshold!) return campaignRejected(runtime, a, row, state);
  const ref = campaignRef(a, row.id), review = { draft: row.reviewDraft!, rendered: row.reviewRendered! };
  await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: review.draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return; }
    // The reviewed binding, the region's setup and the attachments, outside the send locks (claim locks last).
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'prepare', locks: 'none', mails: [reviewedMail(review.draft)] }, undefined, actorAssets(a, review.draft.attachments));
    const lockedAttachments = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId, { retryable: ['SES_SETUP_REQUIRED'] }).assets;
    const messageStatic = ![review.draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));
    const started = Date.now();
    if (messageStatic) {
      // Set-based static preparation (used for small <=5,000 sync launches and pre-deploy static reviews mid-prepare).
      const stamp = await prepareStaticStamp(runtime, review.draft, review.rendered, lockedAttachments, row.reviewVersion!);
      const sliceEnd = Math.min(campaign.total, campaign.prepared + STATIC_PREPARE_SLICE_ROWS);
      const expected = sliceEnd - campaign.prepared;
      if (expected <= 0) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
      const invalid = await db.execute<{ id: string }>(sql`
        SELECT recipient->>'id' AS id FROM sending_review_recipients
        WHERE review_id = ${campaign.reviewId} AND ordinal > ${campaign.prepared} AND ordinal <= ${sliceEnd}
          AND NOT ${validMailAddressSql(sql`recipient->>'email'`)}
        ORDER BY ordinal LIMIT 1`);
      if (invalid.rows[0]) {
        throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Contact ${invalid.rows[0].id}: Recipient or rendered message is invalid (to).`, 'contactId');
      }
      const { rows: [stamped] } = await db.execute<{ n: number; max_ordinal: number | null }>(sql`
        WITH updated AS (
          UPDATE sending_review_recipients
          SET content_hash = 's1:' || encode(sha256(convert_to(${stamp.baseHash} || ':' || (recipient->>'email'), 'UTF8')), 'hex'),
              subject = ${stamp.storedSubject},
              snapshot_bytes = ${stamp.baseBytes} + octet_length(to_json(recipient->>'email')::text)
          WHERE review_id = ${campaign.reviewId} AND ordinal > ${campaign.prepared} AND ordinal <= ${sliceEnd} AND content_hash IS NULL
          RETURNING ordinal
        )
        SELECT count(*)::int AS n, max(ordinal)::int AS max_ordinal FROM updated`);
      if ((stamped?.n ?? 0) !== expected || stamped?.max_ordinal !== sliceEnd) {
        throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
      }
      log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId, campaignId: campaign.id, cursor: campaign.prepared, rows: expected, messageStatic: true, durationMs: Date.now() - started });
      await db.execute(recordPrepared(ref, sliceEnd, runningState({ prepared: sliceEnd, total: campaign.total, scheduledAt: campaign.scheduledAt })));
      return;
    }

    // Personalized preparation: keeps the all-validated-before-any-send guarantee.
    const recipients = await recipientChunk(db, campaign.reviewId!, campaign.prepared);
    if (!recipients.length) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
    const parse = review.rendered.html ? await loadParse5() : undefined;
    validateInterpolationTemplate(review.draft.subject, false);
    const htmlInfo = validateInterpolationTemplate(review.rendered.html, true, parse);
    validateInterpolationTemplate(review.rendered.text, false);
    const htmlStatic = !review.rendered.html?.includes('{{');
    const templateHtmlBytes = review.rendered.html ? Buffer.byteLength(review.rendered.html, 'utf8') : 0;
    // When no {{placeholder}} sits in a URL attribute, HTML-escaped substitution in text or text-only attributes cannot
    // alter any URL or DOM structure, so validateHtmlUrls runs once instead of re-parsing HTML per recipient.
    const htmlUrlsOnce = htmlStatic || !htmlInfo.hasUrlPlaceholder;
    if (htmlUrlsOnce && review.rendered.html) {
      await validateHtmlUrls(review.draft.previewText ? withPreheader(review.rendered.html, review.draft.previewText, parse, row.reviewVersion!) : review.rendered.html);
    }
    let cursor = campaign.prepared, payloadBytes = 0;
    const prepared: { ordinal: number; hash: string; subject: string; bytes: number }[] = [];
    for (const recipient of recipients) {
      if (recipient.ordinal !== cursor + 1 || recipient.content_hash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
      // If a text attribute holds a placeholder and recipient data could push total attribute bytes past bounded-html's
      // 512 KiB budget, fall back to full per-row validateHtmlUrls so the result is always identical.
      const rowHtmlValidated = htmlUrlsOnce && (!htmlInfo.hasAttrPlaceholder || templateHtmlBytes + htmlInfo.attrPlaceholderCount * (recipient.recipient_bytes ?? 0) <= 512 * 1024);
      const snapshot = await campaignMessage(runtime, review.draft, recipient.recipient, false, lockedAttachments, review.rendered, true, rowHtmlValidated, row.reviewVersion!);
      const contentHash = await digest(canonical(snapshot));
      marketingFooter(snapshot, unsubscribePlaceholder(keyedOrigin(runtime, review.draft)), review.draft);
      sizeCheck(snapshot, lockedAttachments);
      const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      const entryBytes = 160 + Buffer.byteLength(snapshot.subject, 'utf8');
      if (prepared.length && payloadBytes + entryBytes > CAMPAIGN_PREPARE_BYTES) break;
      prepared.push({ ordinal: recipient.ordinal, hash: contentHash, subject: snapshot.subject, bytes: size }); payloadBytes += entryBytes; cursor = recipient.ordinal;
      if (Date.now() - started >= 10000) break;
    }
    log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId, campaignId: campaign.id, cursor: campaign.prepared, rows: prepared.length, messageStatic: false, htmlUrlsOnce, durationMs: Date.now() - started });
    await db.execute(sql`UPDATE sending_review_recipients r SET content_hash = p.hash, subject = nullif(p.subject,${review.draft.subject}), snapshot_bytes = p.bytes
      FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) AS p(ordinal integer, hash text, subject text, bytes integer)
      WHERE r.review_id = ${campaign.reviewId} AND r.ordinal = p.ordinal AND r.content_hash IS NULL`);
    await db.execute(recordPrepared(ref, cursor, runningState({ prepared: cursor, total: campaign.total, scheduledAt: campaign.scheduledAt })));
  });
}
/**
 * A campaign launched before postal addresses existed froze none in its review. Before its first release it takes the
 * workspace's, stamped into the review once, so it never sends without one and every copy and rebuild of it shows the
 * same address. With none set it pauses with POSTAL_ADDRESS_REQUIRED (runCampaign); resuming after one is added
 * continues it. One that had already released recipients finishes as it started, so all its copies read the same.
 */
async function frozenPostalAddress(runtime: Runtime, a: Actor, row: RunRow) {
  const review = sql`workspace_id=${a.workspaceId} AND id=${row.reviewId}`;
  const { rows: [found] } = await runtime.db.execute<{ address: string | null }>(sql`WITH current AS (SELECT ${postalAddressOf(runtime.config.multiTenant, a.workspaceId)} AS address),
    stamped AS (UPDATE sending_campaign_reviews SET draft=draft||jsonb_build_object('postalAddress',c.address) FROM current c
      WHERE ${review} AND c.address IS NOT NULL AND NOT draft ? 'postalAddress' RETURNING draft->>'postalAddress' AS address)
    SELECT coalesce((SELECT address FROM stamped),(SELECT draft->>'postalAddress' FROM sending_campaign_reviews WHERE ${review})) AS address`);
  if (!found?.address) throw new ApiError(409, 'POSTAL_ADDRESS_REQUIRED', 'Paused before sending anyone: the workspace has no postal address, which US law (CAN-SPAM) requires in every marketing email. Add it in Settings, then resume this campaign.', 'postalAddress');
  log('info', { code: 'CAMPAIGN_POSTAL_ADDRESS_FROZEN', campaignId: row.id });
  return found.address;
}
/** How long a campaign launched before link hosts, and its queued email, wait before looking for their link host again. */
export const LINK_RECORD_RECHECK_MS = 15 * 60_000;
// sending: release the next recipients into the dispatch queue within the buffer, pacing, rate share and SES quota.
// Returns 'again' when another release can start at once, 'done' when this run has nothing more to do, and waits in
// place (JobDeferred on the same job row) otherwise.
async function releaseStep(runtime: Runtime, a: Actor, row: RunRow, payload: Record<string, unknown>): Promise<'again' | 'done'> {
  const ref = campaignRef(a, row.id), nowMs = Date.now();
  // Every recipient is released: the dispatcher marks the campaign done when its last row leaves the queue. When no row
  // is left to leave it (the last release skipped everyone remaining, or the last rows went out while the campaign was
  // paused) nothing would until the minute sweep, so the run finishes it. The statement moves sending -> done only with
  // nothing queued or attempting: with a row in flight it changes nothing and the dispatcher finishes the campaign.
  const settle = () => runtime.db.execute(finishCampaigns(sql`SELECT ${a.workspaceId}::text AS workspace_id, ${row.id}::text AS campaign_id`));
  if (row.expanded >= row.total) { await settle(); return 'done'; }
  if (row.expanded === 0 && row.reviewDraft!.postalAddress === undefined) row.reviewDraft = { ...row.reviewDraft!, postalAddress: await frozenPostalAddress(runtime, a, row) };
  // Do not turn a retired generation into a pacing/quota wait, or refresh its provider quota.
  if (row.reviewDraft?.binding && row.account?.generation!==row.reviewDraft.binding.generation) throw staleReview();
  // Poll a full buffer with one bounded count, before the locks and origin checks; the transaction rechecks capacity under the admission lock.
  const limits = { campaign: campaignBuffer(row.rate), total: workspaceBuffer(row.rate) };
  const [buffered] = (await runtime.db.execute<{ total: number; campaign: number }>(sql`SELECT
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id IS NOT NULL AND status IN ('queued','attempting') LIMIT ${limits.total}) e) AS total,
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id=${row.id} AND status IN ('queued','attempting') LIMIT ${limits.campaign}) c) AS campaign`)).rows;
  // Record why releasing is held (shown on the campaign), then wait in place.
  const hold = async (reason: 'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota' | 'list_probe' | 'feedback_lag' | 'ramp' | 'link_record', until: string): Promise<never> => {
    await runtime.db.execute(holdCampaign(ref, reason, until));
    throw new JobDeferred(until, payload);
  };
  // A campaign whose review froze no link host (launched before link hosts, or on the link domain) asks each release
  // (src/link-domains.ts). With none to use (the workspace paused, or with own link hosts only, none active), it waits
  // without releasing anyone and looks again every 15 minutes; a domain's own host turning active wakes it at once
  // (wakeLinkRecordHolds). On the link domain, the release records its recipients there.
  let releaseOrigin = row.reviewDraft!.requiredNotice ? undefined : row.reviewDraft!.linkOrigin;
  if (!row.reviewDraft!.linkOrigin && !row.reviewDraft!.requiredNotice) {
    const choice = await linkChoice(runtime, runtime.db, a.workspaceId, row.reviewDraft!.from).catch(error => { if (error instanceof ApiError && error.code === 'LINK_RECORD_REQUIRED') return null; throw error; });
    if (!choice) return hold('link_record', new Date(nowMs + LINK_RECORD_RECHECK_MS).toISOString());
    releaseOrigin = choice.origin;
  }
  // A stale/nonexistent sample is not an unlimited allowance. When a known quota (or a
  // previously held campaign) needs a new sample, use the dispatcher's elected cache refresher.
  // This works with an empty queue and does not release a probe/buffer of speculative emails.
  const dbNow = Date.parse(row.dbNow);
  let max = Number(row.max24), sent = Number(row.sent24), customerSent = Number(row.customer24), refreshAt = Date.parse(row.quotaCheckedAt ?? '') + QUOTA_REFRESH_MS;
  // A brand-new region has no previous allowance to preserve. Keep its normal cold-start
  // buffer and Hosted admission checks; the first dispatch populates its quota cache.
  if ((row.quotaCheckedAt !== null || max > 0 || row.waitingReason === 'ses_daily_quota') && !(refreshAt > dbNow)) {
    const { campaignQuota } = await wrapModuleLoad(() => import('./dispatcher.js'));
    const q = await campaignQuota(runtime, a, row.reviewDraft!.region, row.account?.aws_account_id).catch(error => { if (error instanceof ModuleLoadError) throw error; return null; });
    if (!q) return hold('ses_daily_quota', new Date(dbNow + QUOTA_REFRESH_MS).toISOString());
    max = q.max24HourSend; sent = q.sentLast24Hours; customerSent = q.customerSent ?? 0; refreshAt = q.checkedAt + QUOTA_REFRESH_MS;
  }
  const sesCapacity = max > 0 ? max - sent - sesDailyReserve(max, runtime.config.dispatch.dailyHeadroomPercent) : max === 0 && row.waitingReason === 'ses_daily_quota' ? 0 : Infinity;
  // An outside workspace's campaign also waits for the customer share, shown as waiting for Hosted sending capacity.
  const outside = row.account?.kind === 'shared' && !row.account.exempt && !isSimulatedSes(runtime);
  const shareCapacity = outside && max > 0 ? customerCredits(max, customerSent, runtime.config.dispatch.customerSharePercent) : Infinity;
  const quotaUntil = new Date(Math.max(dbNow + 1000, Number.isFinite(refreshAt) ? refreshAt : dbNow + QUOTA_REFRESH_MS)).toISOString();
  if (sesCapacity <= buffered!.total) return hold('ses_daily_quota', quotaUntil);
  if (shareCapacity <= buffered!.total) return hold('hosted_daily_quota', quotaUntil);
  // Release hysteresis: once this campaign already has rows buffered, wait until at least a quarter of its buffer has drained
  // (or the remaining recipients fit) instead of topping up tiny batches that contend on locks and wake shards nonstop.
  const room = Math.min(limits.campaign - buffered!.campaign, limits.total - buffered!.total);
  const minRelease = Math.min(row.total - row.expanded, Math.floor(limits.campaign / 4), CAMPAIGN_EXPAND_ROWS);
  if (room <= 0 || (buffered!.campaign > 0 && room < minRelease)) {
    const backlog = room <= 0
      ? Math.max(buffered!.campaign - limits.campaign / 2, buffered!.total - limits.total / 2)
      : Math.max(buffered!.campaign - Math.max(0, limits.campaign - minRelease), buffered!.total - Math.max(0, limits.total - minRelease));
    throw new JobDeferred(new Date(nowMs + drainDelayMs(backlog, row.rate)).toISOString(), payload);
  }
  const cap = dailyCap(row), rolling = cap !== null && !!row.windowStartedAt && nowMs - Date.parse(row.windowStartedAt) >= DAY_MS;
  // Automatic pause: checked at most every 30 minutes while releasing, so always before a new daily window
  // opens; a resume restarts the 30 minutes so a deliberate resume is not immediately re-paused.
  const hosted = runtime.config.multiTenant && row.account?.kind === 'shared';
  // `rampStep`: a ramp step's batch paused it. That batch is done with: a resume starts a new hour on the same step.
  const quarantine = async (unhealthy: { code: string; message: string }, rampStep?: number) => {
    const paused = await runtime.db.transaction(async tx => {
      const moved = await tx.execute(hosted ? quarantineCampaign(ref, unhealthy) : pauseCampaign(ref, unhealthy));
      if (moved.rows.length && rampStep !== undefined) await tx.execute(restartRampWindow(ref));
      if (moved.rows.length && hosted) await (await wrapModuleLoad(() => import('./standing.js'))).applyChange(tx, { workspaceId: a.workspaceId, actor: { kind: 'system', via: 'job' }, kind: 'quarantine',
        details: { campaignId: row.id, campaignName: row.draft.name ?? row.id, code: unhealthy.code, message: unhealthy.message } });
      return moved;
    });
    if (paused.rows.length) log('warn', { code: 'CAMPAIGN_AUTO_PAUSED', campaignId: row.id, reason: unhealthy.code, ...rampStep === undefined ? {} : { rampStep: rampStep + 1 } });
    return 'done' as const;
  };
  // The list probe: release only the probe, wait for its feedback, then check it before releasing the rest. A sender in
  // good standing skips it for up to 10,000 recipients an earlier campaign delivered to cleanly (listMailedCleanly): decided once,
  // before the first release, and recorded as skipped, not passed. While the sender stays in good standing a skipped
  // campaign releases on; once it is below (or a check has started), everything released so far is the probe: nothing
  // more is released until it has left the queue, waited ten minutes and passed the probe's check, and a check that
  // passes clears it as a probe that went out would. The automatic pause below still applies to every campaign.
  const listed = hosted && row.autoPause && !row.simulated && !row.probeClearedAt && row.total > probeSize(row.total), good = row.account?.probation === null;
  let probe = listed ? probeSize(row.total) : null;
  if (listed && row.probeSkippedAt) probe = good && !row.probeWaitUntil ? null : Math.max(row.expanded, probeSize(row.total));
  else if (listed && row.expanded === 0 && good && await listMailedCleanly(runtime.db, a, row)) {
    await runtime.db.execute(skipProbe(ref));
    log('info', { code: 'CAMPAIGN_PROBE_SKIPPED', campaignId: row.id });
    probe = null;
  }
  let probeLeft = Number.POSITIVE_INFINITY;
  if (probe !== null && row.expanded >= probe) {
    if (buffered!.campaign > 0) throw new JobDeferred(new Date(nowMs + drainDelayMs(buffered!.campaign, row.rate)).toISOString(), payload);
    if (!row.probeWaitUntil) {
      const until = new Date(dbNow + PROBE.waitMs).toISOString();
      await runtime.db.execute(waitProbe(ref, until));
      throw new JobDeferred(until, payload);
    }
    if (Date.parse(row.probeWaitUntil) > dbNow) await hold('list_probe', row.probeWaitUntil);
    // Hold before passing the list probe when safety feedback is >= 5 min behind so a probe cannot clear blind.
    if (row.autoPause && (row.priorityLagMs ?? 0) >= FEEDBACK_LAG_HOLD_MS) {
      return hold('feedback_lag', new Date(dbNow + 60_000).toISOString());
    }
    const unhealthy = await campaignHealth(runtime.db, a, row.id, true, probe);
    if (unhealthy) return quarantine(unhealthy);
    await runtime.db.execute(clearProbe(ref));
  } else if (probe !== null) probeLeft = probe - row.expanded;
  // Hold new releases (never a manual pause) when priority safety feedback (bounces/complaints) is >= 5 minutes behind
  // so auto-pause does not send blind; routine opens/clicks lagging never hold a send (unless running without a priority
  // queue), and stale samples (> 5 min old) expire. Queue-level lag is installation-wide because Cloudflare Queues
  // reports per-queue age, not per-workspace; workspaces with autoPause disabled are never held.
  if (row.autoPause && (row.priorityLagMs ?? 0) >= FEEDBACK_LAG_HOLD_MS) {
    return hold('feedback_lag', new Date(dbNow + 60_000).toISOString());
  }
  if (row.autoPause && (!row.healthCheckedAt || nowMs - Date.parse(row.healthCheckedAt) >= AUTO_PAUSE.intervalMs)) {
    const unhealthy = await campaignHealth(runtime.db, a, row.id, hosted);
    if (unhealthy) return quarantine(unhealthy);
    await runtime.db.execute(noteHealthChecked(ref));
  }
  // Daily pacing: at most pacePerDay recipients, or the plan's batch, per rolling 24-hour window.
  // A plan's first small batch, out: wait for its bounces and rejections (the automatic pause reads them) before the rest of the day.
  const firstWait = firstBatchWait(row, row.windowIndex, row.windowStartedAt, nowMs);
  if (firstWait !== null && row.windowExpanded >= row.paceFirstBatch!) await hold('pacing_window', new Date(firstWait).toISOString());
  if (cap !== null && row.windowStartedAt && !rolling && row.windowExpanded >= cap) await hold('pacing_window', new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString());
  // The ramp (src/standing-model.ts RAMP): Hosted live campaigns, exempt workspaces too. Its first release places it, from
  // the workspace's history. A step's hour releases at most its ceiling; once the hour is over, its batch is checked when
  // its feedback is mature (RAMP_CHECK) and the campaign moves on, stays on the step for another hour or pauses.
  let rampLeft = Number.POSITIVE_INFINITY;
  if (hosted && !row.simulated) {
    let step = row.rampStep ?? rampStart(await rampHistory(runtime.db, a.workspaceId)), from = row.rampFrom;
    let opened = row.rampStep !== null && row.rampWindowStartedAt ? Date.parse(row.rampWindowStartedAt) : null;
    if (row.rampStep === null) log('info', { code: 'CAMPAIGN_RAMP_PLACED', campaignId: row.id, step: step + 1, steps: RAMP.steps.length });
    // The workspace's other ramped campaigns and its marketing sent through the API share the step's hourly ceiling:
    // splitting one send into many campaigns, sending several at once or sending the list through the API doesn't multiply
    // it. What the campaigns released in their current hours, from their own rows, and the API's marketing this clock hour
    // (hosted_usage_hourly.api_marketing, migration 501, whose ramp_refusal counts the campaigns' hours the same way).
    const [others] = (await runtime.db.execute<{ n: number }>(sql`SELECT ((SELECT coalesce(sum(greatest(expanded-ramp_from,0)),0) FROM sending_campaigns
      WHERE workspace_id=${a.workspaceId} AND id<>${row.id} AND state='sending' AND NOT simulated AND ramp_step IS NOT NULL AND ramp_step<${RAMP.steps.length}
        AND ramp_window_started_at>now()-make_interval(secs=>${RAMP_HOUR_MS / 1000}::int))
      + coalesce((SELECT api_marketing FROM hosted_usage_hourly WHERE workspace_id=${a.workspaceId} AND hour=date_trunc('hour',now(),'UTC')),0))::int AS n`)).rows;
    const shared = Number(others?.n ?? 0);
    if (step < RAMP.steps.length && opened !== null && dbNow >= opened + RAMP_HOUR_MS) {
      const batch = row.expanded > from ? await rampBatch(runtime.db, a, row, from) : null;
      if (batch?.released) {
        if (batch.waiting > 0) return hold('ramp', new Date(dbNow + Math.max(RAMP_CHECK.retryMs, drainDelayMs(batch.waiting, row.rate))).toISOString());
        if (batch.resolved < batch.accepted * RAMP_CHECK.resolved && dbNow < opened + RAMP_HOUR_MS + RAMP_CHECK.maxWaitMs) return hold('ramp', new Date(dbNow + RAMP_CHECK.retryMs).toISOString());
        const unhealthy = rampHealth(batch, step);
        if (unhealthy) return quarantine(unhealthy, step);
        // Proven by what the workspace's ramped campaigns released together, as they share the ceiling.
        if (batch.released + shared >= RAMP.steps[step]!.ceilingPerHour * RAMP.advance) step++;
      }
      opened = null;
    }
    if (step < RAMP.steps.length && opened === null) { opened = dbNow; from = row.expanded; }
    const startedAt = step < RAMP.steps.length ? new Date(opened!).toISOString() : null;
    if (step !== row.rampStep || from !== row.rampFrom || startedAt !== (row.rampWindowStartedAt && new Date(row.rampWindowStartedAt).toISOString())) await runtime.db.execute(setRamp(ref, step, startedAt, from));
    if (step < RAMP.steps.length) {
      rampLeft = RAMP.steps[step]!.ceilingPerHour - (row.expanded - from) - shared;
      if (rampLeft <= 0) return hold('ramp', new Date(opened! + RAMP_HOUR_MS).toISOString());
    }
  }
  // SES 24-hour quota (cached from GetAccount about every minute): keep a reserve for transactional mail.
  let rateAllowance = Number.POSITIVE_INFINITY, shareRate = 0;
  // Rate share: release at most rateShare of the regional send rate, measured from the previous release.
  if (row.rateShare !== null && row.rateShare < 1 && Number(row.rate) > 0) {
    shareRate = row.rateShare * Number(row.rate);
    const last = typeof payload.releasedAt === 'string' ? Date.parse(payload.releasedAt) : nowMs - RELEASE_INTERVAL_MS;
    rateAllowance = Math.floor(shareRate * Math.min(Math.max(0, nowMs - last), RELEASE_BURST_MS) / 1000);
    if (rateAllowance < 1) throw new JobDeferred(new Date(last + Math.ceil(1000 / shareRate)).toISOString(), payload);
  }
  // Screened campaigns release only recipients whose copies have verdicts; a refused share past the screen's restrict
  // line (src/standing-model.ts) pauses the campaign once, for its owner to review.
  let screened = Number.POSITIVE_INFINITY;
  if (campaignScreened(runtime, hosted) && row.reviewScreen?.contentHash === row.reviewHash && row.reviewScreen?.template) {
    let state = row.reviewScreen;
    const through = Math.min(row.total, row.expanded + SCREEN_AHEAD);
    if (state.screenedThrough < through) state = await screenAhead(runtime, a, row, state, through);
    const line = (await wrapModuleLoad(() => import('./standing-model.js'))).LADDER.screen.restrict[0];
    if (!state.quarantined && state.rejected >= line.count && state.rejected / state.recipients >= line.rate) {
      await saveScreen(runtime, a, row, { ...state, quarantined: true });
      return quarantine({ code: 'CONTENT_REJECTED_SPAM', message: `Paused: the content screen refused ${state.rejected} of ${state.recipients} recipients' copies as spam (the line is ${line.rate * 100}% and ${line.count}). Refused copies are never sent. Review the content and contact values before resuming.` });
    }
    screened = state.screenedThrough - row.expanded;
    if (screened <= 0) return 'again';
  }
  const draft = row.reviewDraft!, limits_ = limitsTable(runtime);
  const released = await runtime.db.transaction(async db => {
    const held = await lockSendScope(db, a.workspaceId, { campaignId: row.id });
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'sending' || campaign.reviewId !== row.reviewId || campaign.expanded >= campaign.total) return null;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return null; }
    // A required notice whose workspace no longer has them pauses here (runCampaign), before anyone more is released:
    // a scheduled one at its time, a paced one at its next window. Turned on again, a resume continues from here.
    await requiredNoticesAllowed(db, draft, a.workspaceId, 'Paused: required notices were turned off for this workspace, so nobody more is sent this notice. Resume it once they are on again, or cancel it.');
    // The admission decision on this release: a pause or hold, the reviewed binding (fencing the insert against a
    // disable or reclaim since the precheck), and how many recipients the Hosted limit and the balance afford.
    const release = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'release', locks: held, mails: [reviewedMail(draft)] }, sql`jsonb_build_object('simulated',${campaign.simulated}::boolean)`);
    const [buffer] = await db.select({ total: sql<number>`count(*)::int`, campaign: sql<number>`count(*) FILTER (WHERE ${emails.campaignId} = ${campaign.id})::int`,
      decision: sql<Released | Refused>`${release}`,
      rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits_} WHERE workspace_id=${a.workspaceId} AND region=${draft.region}),0)`,
    }).from(emails).where(and(scope(emails, a), isNotNull(emails.campaignId), inArray(emails.status, ['queued', 'attempting'])));
    // A capped campaign opens a new 24-hour window when the previous one has elapsed (or on its first release); with a
    // plan, each window after the first is its next batch.
    const opening = dailyCap(campaign) !== null && (!campaign.windowStartedAt || Date.now() - Date.parse(campaign.windowStartedAt) >= DAY_MS);
    const windowStart = opening ? now() : campaign.windowStartedAt, windowIndex = opening && campaign.windowStartedAt ? campaign.windowIndex + 1 : campaign.windowIndex;
    const windowUsed = opening ? 0 : campaign.windowExpanded, dayCap = dailyCap(campaign, windowIndex);
    // In the first window, before the first small batch's wait is over, only the first small batch goes.
    const windowCap = dayCap !== null && (windowIndex === 0 && campaign.paceFirstBatch && campaign.pacePlan?.length && (opening || firstBatchWait(campaign, 0, windowStart, Date.now()) !== null))
      ? Math.min(dayCap, campaign.paceFirstBatch) : dayCap;
    const paceLeft = windowCap === null ? Number.POSITIVE_INFINITY : windowCap - windowUsed;
    if (paceLeft <= 0) throw new JobDeferred(new Date(Date.parse(windowStart!) + (windowCap !== dayCap ? campaign.paceFirstWaitMinutes! * 60_000 : DAY_MS)).toISOString(), payload);
    const sesAllowance = Math.min(sesCapacity, shareCapacity) - buffer!.total;
    if (sesAllowance <= 0) return sesCapacity <= shareCapacity ? 'ses_daily_quota' as const : 'hosted_daily_quota' as const;
    const cBuf = campaignBuffer(buffer!.rate), wBuf = workspaceBuffer(buffer!.rate);
    const bufRoom = Math.min(cBuf - buffer!.campaign, wBuf - buffer!.total);
    const demand = Math.min(CAMPAIGN_EXPAND_ROWS, campaign.total - campaign.expanded, paceLeft, sesAllowance, rateAllowance, probeLeft, screened, rampLeft);
    const txMinRelease = Math.min(demand, Math.floor(cBuf / 4));
    const capacity = Math.min(demand, bufRoom);
    if (capacity <= 0 || (buffer!.campaign > 0 && bufRoom < txMinRelease)) {
      // Lost a race with another release or buffer is still more than three-quarters full: wait for it to drain.
      const backlog = capacity <= 0
        ? Math.max(buffer!.campaign - cBuf / 2, buffer!.total - wBuf / 2)
        : Math.max(buffer!.campaign - Math.max(0, cBuf - txMinRelease), buffer!.total - Math.max(0, wBuf - txMinRelease));
      throw new JobDeferred(new Date(Date.now() + drainDelayMs(backlog, buffer!.rate)).toISOString(), payload);
    }
    const allowed = admitted(runtime, buffer!.decision, a.workspaceId);
    const links = releaseOrigin ? await linkAllowance(db, runtime.config, a.workspaceId, releaseOrigin) : null;
    if (links && !links.left) {
      await db.execute(holdCampaign(ref, links.reason, links.until));
      return { count: 0, completed: false, linkUntil: links.until, hostedUntil: null, balanceUntil: null };
    }
    const chunk = await recipientChunk(db, campaign.reviewId!, campaign.expanded, Math.min(capacity, links?.left ?? capacity));
    if (!chunk.length || chunk.some((recipient, index) => !recipient.content_hash || recipient.ordinal !== campaign.expanded + index + 1)) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The prepared audience is incomplete.');
    // Refuse unknown future hash formats before releasing any row so the campaign pauses intact instead of burning recipients.
    if (chunk.some(recipient => !isSupportedContentHash(recipient.content_hash))) throw unsupportedHashFormat();
    const delivered = campaign.deliveredOnly ? await deliveredBefore(db, a.workspaceId, campaign.id, chunk.map(r => r.recipient.email)) : null;
    const affordable = allowed.hostedLeft ?? Number.POSITIVE_INFINITY;
    // The processed prefix: every recipient up to the last affordable one that is sent; skipped ones cost nothing.
    const processed: typeof chunk = [], recipients: typeof chunk = [];
    for (const r of chunk) {
      const send = !r.screen_rejected && (!delivered || delivered.has(r.recipient.email.toLowerCase()));
      if (send && recipients.length >= affordable) break;
      processed.push(r); if (send) recipients.push(r);
    }
    let hostedUntil: string | null = null, balanceUntil: string | null = null;
    if (processed.length < chunk.length) {
      hostedUntil = allowed.nextChangeAt!;
      if (!processed.length) {
        await db.execute(holdCampaign(ref, 'hosted_daily_quota', hostedUntil));
        return {count:0, completed:false, hostedUntil, balanceUntil: null as string | null};
      }
    }
    // Billing (Hosted, enforced prepaid): release only what the balance and the free sending allowance cover; with nothing
    // covered the campaign waits on 'balance' until a credit (billing.restored wakes it) or an hour passes.
    const bill = allowed.billing;
    if (bill) {
      const affordable = bill.affordable;
      if (affordable < recipients.length && !bill.enforced) log('info', { code: 'BILLING_SHADOW_DENY', workspaceId: a.workspaceId, campaignId: campaign.id, requiredUc: String(RATES.emailUc * BigInt(Math.max(0, recipients.length - bill.freeSentLeft))), availableUc: bill.availableUc });
      else if (affordable < recipients.length) {
        const until = new Date(Date.now() + 3_600_000).toISOString();
        if (affordable === 0) {
          await db.execute(holdCampaign(ref, 'balance', until));
          return { count: 0, completed: false, hostedUntil: null, balanceUntil: until };
        }
        // Keep the prefix through the last recipient the balance covers (skipped ones before it stay processed).
        processed.splice(processed.indexOf(recipients[affordable - 1]!) + 1);
        recipients.splice(affordable);
        hostedUntil = null; balanceUntil = until;
      }
    }
    // The review owns its assets. Only one variable-size bind per release page; no
    // per-recipient headers, base content, asset IDs, or denormalized attachment links.
    const prepared=recipients.map(r=>({id:rowId('email'),ordinal:r.ordinal,address:r.recipient.email,subject:r.subject??draft.subject}));
    // On the link domain: the release's recipients are recorded there (src/link-domains.ts recordLinkUse).
    if (runtime.config.linkHost && releaseOrigin === `https://${runtime.config.linkHost}` && prepared.length) await recordLinkUse(db, a.workspaceId, runtime.config.linkHost, prepared.length);
    const tpl = row.reviewScreen?.template;
    const stub={kind:'marketing',deferredCampaign:true,...(!draft.linkOrigin && releaseOrigin ? {linkOrigin:releaseOrigin} : {}),...(tpl ? { screenVerdict: { status: 'passed', spam: tpl.spam, model: tpl.model, digest: tpl.key } } : {})};
    if (prepared.length) await db.execute(sql`INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,campaign_id,review_id,review_ordinal,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened,scheduled_at)
      SELECT p.id,${a.workspaceId},${a.keyId},${draft.region},${campaign.id},${campaign.reviewId},p.ordinal,${draft.from},jsonb_build_array(p.address),'[]','[]',p.subject,${JSON.stringify(stub)}::jsonb,${campaign.simulated},true,${campaign.scheduledAt}
      FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) p(id text,ordinal int,address text,subject text)`);
    const expanded = processed[processed.length - 1]!.ordinal, skipped = processed.length - recipients.length;
    await db.execute(recordExpanded(ref, expanded, windowStart, windowUsed + prepared.length, balanceUntil ?? hostedUntil, skipped, balanceUntil ? 'balance' : 'hosted_daily_quota', windowIndex));
    if (skipped) log('info', { code: 'CAMPAIGN_RECIPIENTS_SKIPPED', campaignId: campaign.id, skipped, reason: 'not_delivered_before' });
    log('info', { code: 'CAMPAIGN_RELEASED', campaignId: campaign.id, released: prepared.length, expanded, total: campaign.total, capacity, buffered: buffer!.campaign, workspaceBuffered: buffer!.total, rate: buffer!.rate });
    return { count: prepared.length, completed: expanded === campaign.total, hostedUntil, balanceUntil };
  });
  if (!released) return 'done';
  if (typeof released === 'string') return hold(released, quotaUntil);
  // Released rows are claimed directly by the region dispatcher.
  if (released.count) try { await runtime.dispatch?.(draft.region, row.account?.aws_account_id, released.count, row.account?.kind, false, Number(row.rate) > 0 ? Number(row.rate) : undefined); } catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', campaignId: row.id, message: 'Released mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  // Usually the oldest bucket expires first. Also notice an earlier refund or operator raise.
  // Waiting on balance: billing.restored wakes the run as soon as credit lands; otherwise look again in an hour.
  if ('linkUntil' in released && released.linkUntil) throw new JobDeferred(released.linkUntil, payload);
  if (released.balanceUntil && !released.completed) throw new JobDeferred(released.balanceUntil, payload);
  if (released.hostedUntil) throw new JobDeferred(new Date(Math.min(Date.parse(released.hostedUntil),dbNow+QUOTA_REFRESH_MS)).toISOString(),payload);
  if (released.completed) { if (!released.count) await settle(); return 'done'; }
  if (sesCapacity <= buffered!.total + released.count) return hold('ses_daily_quota', quotaUntil);
  if (shareCapacity <= buffered!.total + released.count) return hold('hosted_daily_quota', quotaUntil);
  // A rate-shared continuation runs once this release has been paid for at the campaign's share.
  if (shareRate) throw new JobDeferred(new Date(Date.now() + Math.max(1000, Math.ceil(1000 * released.count / shareRate))).toISOString(), { ...payload, releasedAt: now() });
  return 'again';
}
// One job per campaign (jobs.id = campaign.run:<id>): it reads the row, acts for its state and loops while the next
// step can start at once (prepare chunks, prepare -> sending, buffer refills); it waits in place for the schedule,
// the dispatch buffer, pacing or quota, and stops as soon as the state is one it does not run (paused, done,
// failed, canceled). A definitive error or the last retry leaves `failed`, never a campaign sending forever.
const RUN_BUDGET_MS = 12000;
const CAPTURE_BUSY_MAX_DEFERS = 60;
const runCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A campaign run needs its campaign.');
  const campaignId = payload.campaignId, a: Actor = { workspaceId: job.workspaceId, keyId: 'worker', permissions: ['manage'], domains: [] };
  const ref = campaignRef(a, campaignId), started = Date.now();
  try {
    for (;;) {
      const row = await readRun(runtime, a, campaignId);
      if (!row || !(CAMPAIGN_RUNNING as readonly string[]).includes(row.state)) return;
      if (row.account?.pauseReason && row.expanded < row.total) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', row.account.pauseReason);
      if (row.simulated !== isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'The campaign was launched with a different SES configuration. No more recipients were queued.');
      if (!row.reviewDraft || !row.reviewRendered) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen message source is missing.');
      a.keyId = row.actorKeyId ?? a.keyId;
      if (row.state === 'preparing') {
        if (row.reviewCapturedAt === null) await captureStep(runtime, a, row, job.id);
        else if (row.reviewCapturedCount !== null) await finalizeCapture(runtime, a, row, job.id);
        else await prepareStep(runtime, a, row, job.id);
      }
      else if (row.state === 'scheduled') {
        if (row.scheduledAt && Date.parse(row.scheduledAt) > Date.now()) throw new JobDeferred(row.scheduledAt, payload);
        await runtime.db.execute(startSending(ref, { scheduledAt: row.scheduledAt, reviewId: row.reviewId }));
      } else if (await releaseStep(runtime, a, row, payload) === 'done') return;
      if (Date.now() - started >= RUN_BUDGET_MS) throw new JobDeferred(now(), payload);
    }
  } catch (error) {
    if (error instanceof JobDeferred || error instanceof ModuleLoadError) throw error;
    if (error instanceof ApiError && error.code === 'AUDIENCE_CAPTURE_BUSY') {
      const busyCount = typeof payload._captureBusy === 'number' && Number.isInteger(payload._captureBusy) ? payload._captureBusy + 1 : 1;
      if (busyCount <= CAPTURE_BUSY_MAX_DEFERS) {
        if (busyCount % 12 === 0) log('warn', { code: 'CAMPAIGN_CAPTURE_BUSY_DEFERRED', campaignId, jobId: job.id, busyCount });
        throw new JobDeferred(new Date(Date.now() + 5_000).toISOString(), { ...payload, _captureBusy: busyCount }, true);
      }
      // Ceiling reached (5 min): fail loudly with draft still editable instead of deferring forever.
      error = new ApiError(503, 'AUDIENCE_CAPTURE_BUSY', 'Audience capture slots stayed busy for over 5 minutes; try sending this campaign again.', undefined, false);
    }
    if (error instanceof ApiError && ['HOSTED_SENDING_PAUSED', 'MARKETING_HELD', 'POSTAL_ADDRESS_REQUIRED', 'REQUIRED_NOTICES_OFF', 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED'].includes(error.code)) {
      await runtime.db.execute(pauseCampaign(ref, { code: error.code, message: error.message }));
      return;
    }
    const retry = !(error instanceof ApiError) || error.retryable;
    if (!(error instanceof ApiError)) log('warn', { code: 'CAMPAIGN_RUN_RETRY', campaignId, jobId: job.id, message: error instanceof Error ? error.message : String(error) });
    if (retry && job.attempts < MAX_ATTEMPTS) throw new ApiError(503, error instanceof ApiError ? error.code : 'CAMPAIGN_RUN_FAILED', 'The campaign run will retry from its durable cursors.', undefined, true);
    try {
      const failed = await runtime.db.execute(failCampaign(ref, backgroundFailure(error)));
      if (failed.rows.length) log('error', { code: 'CAMPAIGN_FAILED', campaignId, jobId: job.id, cause: error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED' });
    } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign failure state will retry until it is durable.', undefined, true); }
  } finally { if (a.wakeJobs) await wakeWebhooks(runtime,a.wakeJobs); }
};
// Pre-migration email.dispatch job rows complete as no-ops: sending_emails.status drives the dispatcher (src/dispatcher.ts).
const retiredDispatchJob: JobHandler = async () => {};
// Job rows of the previous release's prepare/expand/finish chain continue as runs of the same campaign.
export const jobHandlers: Record<string, JobHandler> = { 'sending.cancelPage':cancelPageJob, 'sending.campaignStats': campaignStatsJob, 'sending.release': releaseScheduled, 'email.dispatch': retiredDispatchJob, 'campaign.run': runCampaign, 'campaign.prepare': runCampaign, 'campaign.expand': runCampaign, 'campaign.finish': runCampaign };
/**
 * One of Nightmail's own account emails (src/account-notices.ts) from the platform workspace, through the ordinary
 * admission path: one transactional email per recipient, deduplicated by the idempotency key, charged to that workspace
 * like any send, with the product's name as the sender's. Its origin names the committed row it is about: standing:<event id>, billing:<notice id> or
 * notice:<account notice id>. It dispatches only from the configured platform workspace and only while that row exists
 * (the dispatcher's claim); it is not a general system bypass.
 */

const HELD_SCREEN_LIMIT = 300;
const HELD_SCREEN_CHUNK = 50;
const HELD_SCREEN_CONCURRENCY = 4;
const HELD_SCREEN_BUDGET_MS = 15_000;
const HELD_OUTAGE_ABORT = 4;

/** Background screen sweep outside the mail room (minute cron & Node runner): leases queued/scheduled rows held with
 *  `screened = false` (outage-held accepts, pre-deploy rows, rollout-window rows, or pre-deploy scheduled releases) in
 *  bounded chunks up to `limit` within `budgetMs`, screens them with the same outbound harm screen used at accept
 *  time, and either marks them `screened = true` (waking the mail room) or rejects them with the same status, error code
 *  and `email.rejected` webhook/event. Outages back off and abort the sweep early; logs one held-backlog summary line. */
export async function screenHeldMail(runtime: Runtime, limit = HELD_SCREEN_LIMIT, budgetMs = HELD_SCREEN_BUDGET_MS): Promise<{ leased: number; passed: number; rejected: number; deferred: number; remaining: number }> {
  const mx = runtime.config.multiTenant, started = Date.now(), deadline = started + budgetMs;
  type HeldRow = {
    id: string; workspace_id: string; region: string; actor_key_id: string; review_id: string | null; review_ordinal: number | null;
    campaign_id: string | null; from_address: string; to_addresses: string[]; cc_addresses: string[]; bcc_addresses: string[];
    subject: string; status: EmailStatus; provider_id: string | null; snapshot: EmailSnapshot; simulated: boolean; screened: boolean;
    attempt_started_at: string | null; error_code: string | null; suppression_reason: string | null; scheduled_at: string | null;
    dispatch_version: number; lease_until: string | null; account_pause_started_at: string | null; event_outcomes: number;
    created_at: string; updated_at: string;
    connection: (ReadyConnection & { pool_tier?: string; legacy_names?: boolean }) | null;
    on_probation: boolean; max_send_rate: number | null;
    review_version: number | null; review_draft: CampaignDraft | null; review_rendered: { html?: string; text?: string } | null;
    review_screen: CampaignScreen | null; review_hash: string | null; review_content_hash: string | null; review_recipient: ReviewedRecipient | null;
  };
  let leased = 0, passed = 0, rejected = 0, deferred = 0, consecutiveOutages = 0;
  const toWake = new Map<string, { region: string; accountId?: string; kind?: ReadyConnection['kind']; count: number; priority: boolean; maxSendRate?: number }>();
  const settings = runtime.config.screen;
  let screen: Awaited<ReturnType<typeof loadScreen>> | undefined;

  const processRow = async (r: HeldRow) => {
    const wid = r.workspace_id, id = r.id, ver = r.dispatch_version;
    const snapshot = r.snapshot;
    const conn = r.connection;
    const shared = conn?.kind === 'shared';
    const hosted = Boolean(mx && shared && runtime.config.hostedScreen);
    // A built-in domain's mail has a new sender's rules, as at accept (screenOutgoingAtAccept).
    const builtin = isBuiltinHost(runtime.config, snapshot.from.split('@')[1]!);
    const trusted = !builtin && Boolean(runtime.config.trustedPool && conn?.pool_tier === 'trusted' && conn?.legacy_names === false);
    const required = hosted && (!trusted || snapshot.kind === 'marketing');
    const rules: 'probation' | 'standard' | null = isSimulatedSes(runtime) || !hosted || trusted ? null : r.on_probation || builtin ? 'probation' : 'standard';
    const needsScreen = !r.simulated && !isSimulatedSes(runtime) && (hosted || Boolean(snapshot.screen && snapshot.kind === 'transactional'));

    // A row that could not be judged now (an outage, a failure of its own) waits 45 s out of oldest-first order so
    // failing rows never starve rows behind them while still coming due on the very next minute cron tick.
    const releaseHeld = async () => {
      deferred++;
      consecutiveOutages++;
      await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = clock_timestamp() + interval '45 seconds'
        WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened`);
    };
    const passHeld = async (nextSnapshot: EmailSnapshot, countHosted: boolean) => {
      const { rows: [updated] } = await runtime.db.execute<{ status: EmailStatus }>(sql`
        WITH moved AS (
          UPDATE sending_emails SET screened = true, lease_until = NULL, snapshot = ${JSON.stringify(nextSnapshot)}::jsonb, updated_at = clock_timestamp()
          WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened
          RETURNING status, workspace_id, to_addresses || cc_addresses || bcc_addresses AS recipients
        )
        ${countHosted ? sql`, screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM moved WHERE hosted_real_cost(recipients) > 0`)})` : sql``}
        SELECT status FROM moved`);
      if (!updated) return;
      passed++;
      consecutiveOutages = 0;
      if (updated.status === 'queued') {
        const key = `${conn?.aws_account_id ?? ''}:${r.region}`;
        const entry = toWake.get(key) ?? { region: r.region, accountId: conn?.aws_account_id, kind: conn?.kind, count: 0, priority: false, maxSendRate: typeof r.max_send_rate === 'number' && r.max_send_rate > 0 ? r.max_send_rate : undefined };
        entry.count++;
        entry.priority ||= nextSnapshot.kind === 'transactional';
        toWake.set(key, entry);
      }
    };
    const rejectHeld = async (code: string, screenData?: { spam: number; model: string; threshold: number }, countHosted = false) => {
      const { rows: [res] } = await runtime.db.execute<{ n: number; moved: number }>(sql`
        WITH rejected AS (
          UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
          WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened
          RETURNING ${terminalColumns}, to_addresses || cc_addresses || bcc_addresses AS recipients
        ), ${countHosted ? sql`screen_counted AS (${countScreened(sql`SELECT workspace_id, 1 AS rejected FROM rejected WHERE hosted_real_cost(recipients) > 0`)}), ` : sql``}
        ${terminalEvents(sql`SELECT * FROM rejected`, sql`${JSON.stringify({ providerCalled: false, ...(screenData ? { screen: screenData } : {}) })}::jsonb`)}
        SELECT (SELECT count(*)::int FROM webhook_jobs) AS n, (SELECT count(*)::int FROM rejected) AS moved`);
      if (!res?.moved) return;
      rejected++;
      consecutiveOutages = 0;
      if (res.n) await wakeWebhooks(runtime, res.n);
      if (screenData) log('warn', { code, emailId: id, workspaceId: wid, spam: screenData.spam, model: screenData.model });
      else log('warn', { code, emailId: id, workspaceId: wid });
      if (r.campaign_id) {
        await runtime.db.execute(finishCampaigns(sql`SELECT ${wid}::text AS workspace_id, ${r.campaign_id}::text AS campaign_id`));
      }
    };

    try {
      if (!needsScreen) { await passHeld(snapshot, false); return; }
      if (shared && snapshot.raw) { await rejectHeld('SHARED_RAW_UNSUPPORTED'); return; }
      if (shared && snapshot.mime && !trusted) { await rejectHeld('SEALED_MAIL_UNAVAILABLE'); return; }
      const scopedRt: Runtime = { ...runtime, config: { ...runtime.config, workspaceId: wid } };
      const a: Actor = { workspaceId: wid, keyId: r.actor_key_id, permissions: ['manage'], domains: [] };

      if (snapshot.deferredCampaign && r.review_id && r.campaign_id) {
        if (!r.review_draft || !r.review_rendered || !r.review_recipient || !r.review_content_hash) { await rejectHeld('CAMPAIGN_SNAPSHOT_INVALID'); return; }
        if (!settings) { await releaseHeld(); return; }
        const mailRow: typeof emails.$inferSelect = {
          id, workspaceId: wid, region: r.region, actorKeyId: r.actor_key_id, reviewId: r.review_id, reviewOrdinal: r.review_ordinal,
          campaignId: r.campaign_id, from: r.from_address, to: r.to_addresses, cc: r.cc_addresses, bcc: r.bcc_addresses,
          subject: r.subject, status: r.status, providerId: r.provider_id, snapshot, simulated: r.simulated, screened: r.screened,
          attemptStartedAt: r.attempt_started_at, errorCode: r.error_code, suppressionReason: r.suppression_reason,
          scheduledAt: r.scheduled_at, dispatchVersion: r.dispatch_version, leaseUntil: r.lease_until,
          accountPauseStartedAt: r.account_pause_started_at, eventOutcomes: r.event_outcomes, createdAt: r.created_at, updatedAt: r.updated_at,
        };
        const materialized = await materializeCampaignEmail(scopedRt, a, mailRow, {
          version: r.review_version ?? 1, draft: r.review_draft, rendered: r.review_rendered, contentHash: r.review_content_hash, recipient: r.review_recipient,
        }).catch(error => { if (error instanceof ApiError && error.code === 'LINK_RECORD_REQUIRED') return null; throw error; });
        // A campaign launched before link hosts whose sending domain has none active yet: the email waits, as its campaign
        // does (releaseStep), and is screened once the link host is active. Not an outage: the sweep goes on.
        if (!materialized) {
          deferred++;
          await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = clock_timestamp() + ${LINK_RECORD_RECHECK_MS}::float8 * interval '1 millisecond'
            WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened`);
          return;
        }
        const delivery = rules ? await import('./screened-html.js') : undefined;
        let copy = { ...materialized.keyed, to: [] as string[] };
        if (delivery) copy = delivery.hostedCopy(copy, rules === 'probation');
        const [verdict] = await campaignVerdicts(scopedRt, { workspaceId: wid, campaignId: r.campaign_id, reviewId: r.review_id }, [copy], Date.now() + 8000);
        if (!verdict) { await releaseHeld(); return; }
        if ('refused' in verdict) { await rejectHeld(verdict.refused.code); return; }
        const alreadyCounted = Boolean(r.review_screen?.template && r.review_screen.contentHash === r.review_hash);
        if (verdict.spam >= verdict.threshold) {
          await rejectHeld('CONTENT_REJECTED_SPAM', { spam: verdict.spam, model: verdict.model, threshold: verdict.threshold }, !alreadyCounted && hosted);
          return;
        }
        await passHeld({ ...snapshot, screenVerdict: { status: 'passed', spam: verdict.spam, model: verdict.model, digest: verdict.key, rules } }, !alreadyCounted && hosted);
        return;
      }

      let copy = snapshot;
      if (rules) {
        const delivery = await import('./screened-html.js');
        copy = delivery.hostedCopy(snapshot, rules === 'probation');
        if (snapshot.attachments.length) {
          const attRows = await attachmentRows(runtime.db, a, snapshot.attachments);
          for (const attRow of attRows) {
            const body = await verifiedAttachment(runtime, attRow);
            if (rules === 'standard') delivery.shownAttachment(attRow.filename, attRow.contentType, body, attRow.disposition === 'inline');
            else delivery.screenedAttachment(attRow.filename, attRow.contentType, body, attRow.disposition === 'inline');
          }
        }
      }
      if (!settings) {
        if (required) { await releaseHeld(); return; }
        await passHeld({ ...snapshot, screenVerdict: { status: 'skipped', rules } }, false);
        return;
      }
      screen ??= await loadScreen();
      const result = await screen.screenSnapshot(scopedRt, copy, required, { emailId: id, workspaceId: wid, region: r.region, kind: copy.kind, required });
      if (!result) { await releaseHeld(); return; }
      if (result.spam >= result.threshold && (required || settings.mode === 'reject')) {
        await rejectHeld('CONTENT_REJECTED_SPAM', { spam: result.spam, model: result.model, threshold: result.threshold }, hosted);
        return;
      }
      if (result.spam >= result.threshold) log('warn', { code: 'CONTENT_SPAM_SUSPECTED', workspaceId: wid, emailId: id, spam: result.spam, model: result.model });
      const nextSnap: EmailSnapshot = { ...(rules === 'probation' ? copy : snapshot), screenVerdict: { status: 'passed', spam: result.spam, model: result.model, digest: result.digest, rules } };
      await passHeld(nextSnap, hosted);
    } catch (error) {
      if (error instanceof ModuleLoadError) { await releaseHeld(); throw error; }
      if (error instanceof ApiError && !error.retryable && error.code !== 'CONTENT_SCREEN_UNAVAILABLE') {
        await rejectHeld(error.code);
        return;
      }
      await releaseHeld();
    }
  };

  while (leased < limit && Date.now() < deadline && consecutiveOutages < HELD_OUTAGE_ABORT) {
    const chunkLimit = Math.min(HELD_SCREEN_CHUNK, limit - leased);
    const { rows } = await runtime.db.execute<HeldRow>(sql`
      -- Rows not tried yet first, then the ones whose last try is oldest: a row that keeps failing goes to the back, so a
      -- few of them can never trip the outage abort ahead of every other held row.
      WITH due AS (
        SELECT workspace_id, id, lease_until AS tried FROM sending_emails
        WHERE status IN ('queued', 'scheduled') AND NOT screened
          AND (lease_until IS NULL OR lease_until < clock_timestamp())
        ORDER BY lease_until NULLS FIRST, created_at, id
        LIMIT ${chunkLimit}
        FOR UPDATE SKIP LOCKED
      ), leased AS (
        UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes'
        FROM due WHERE e.workspace_id = due.workspace_id AND e.id = due.id
        RETURNING e.*, due.tried
      )
      SELECT leased.id, leased.workspace_id, leased.region, leased.actor_key_id, leased.review_id, leased.review_ordinal,
        leased.campaign_id, leased.from_address, leased.to_addresses, leased.cc_addresses, leased.bcc_addresses,
        leased.subject, leased.status, leased.provider_id, leased.snapshot, leased.simulated, leased.screened,
        leased.attempt_started_at::text, leased.error_code, leased.suppression_reason, leased.scheduled_at::text,
        leased.dispatch_version, leased.lease_until::text, leased.account_pause_started_at::text, leased.event_outcomes,
        leased.created_at::text, leased.updated_at::text,
        ${mx ? sql`to_jsonb(pc)` : sql`NULL`} AS connection,
        ${mx ? sql`${probationReason(sql`leased.workspace_id`)} IS NOT NULL` : sql`false`} AS on_probation,
        ${mx ? sql`(SELECT l.max_send_rate FROM provider_account_limits l WHERE l.aws_account_id = pc.aws_account_id AND l.region = leased.region AND l.max_send_rate > 0)` : sql`(SELECT l.max_send_rate FROM sending_region_limits l WHERE l.workspace_id = leased.workspace_id AND l.region = leased.region AND l.max_send_rate > 0)`} AS max_send_rate,
        r.renderer_version AS review_version, r.draft AS review_draft, r.rendered AS review_rendered, r.screen AS review_screen, r.content_hash AS review_hash,
        CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.content_hash FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_content_hash,
        CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.recipient FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_recipient
      FROM leased
      ${mx ? sql`LEFT JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id = leased.workspace_id AND pc.region = leased.region` : sql``}
      LEFT JOIN sending_campaign_reviews r ON r.workspace_id = leased.workspace_id AND r.campaign_id = leased.campaign_id AND r.id = leased.review_id
      ORDER BY leased.tried NULLS FIRST, leased.created_at, leased.id`);
    if (!rows.length) break;

    let next = 0;
    const active = new Set<Promise<void>>();
    const beforeJudged = passed + rejected;
    try {
      while (next < rows.length || active.size) {
        // Each outstanding screen can still report an outage. Reserve its place in the abort window
        // before starting another row; a fast failure must not launch a fifth behind three slow ones.
        while (next < rows.length && active.size < Math.min(HELD_SCREEN_CONCURRENCY, HELD_OUTAGE_ABORT - consecutiveOutages) && Date.now() < deadline) {
          const task: Promise<void> = processRow(rows[next++]!).finally(() => active.delete(task));
          active.add(task);
        }
        if (!active.size) break;
        await Promise.race(active);
      }
    } finally {
      await Promise.allSettled(active);
      const unattempted = rows.slice(next);
      if (unattempted.length) {
        await runtime.db.execute(sql`UPDATE sending_emails e SET lease_until = NULL
          FROM jsonb_to_recordset(${JSON.stringify(unattempted.map(r => ({ workspace_id: r.workspace_id, id: r.id, dispatch_version: r.dispatch_version })))}::jsonb)
            AS x(workspace_id text, id text, dispatch_version int)
          WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.dispatch_version = x.dispatch_version
            AND e.status IN ('queued', 'scheduled') AND NOT e.screened`).catch(() => {});
      }
      leased += rows.length - unattempted.length;
    }
    if (rows.length < chunkLimit || next < rows.length || passed + rejected === beforeJudged) break;
  }

  if (leased > 0) await flushScreenObservability(runtime).catch(() => {});
  for (const target of toWake.values()) {
    try { await runtime.dispatch?.(target.region, target.accountId, target.count, target.kind, target.priority, target.maxSendRate); }
    catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', region: target.region, message: 'Screened mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  }
  const { rows: [backlog] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM sending_emails WHERE status IN ('queued', 'scheduled') AND NOT screened`);
  const remaining = backlog?.n ?? 0;
  if (leased > 0 || remaining > 0) {
    log(remaining > 0 ? 'warn' : 'info', { code: 'HELD_SCREEN_SWEEP', leased, passed, rejected, deferred, remaining, ms: Date.now() - started });
  }
  return { leased, passed, rejected, deferred, remaining };
}

export async function sendSystemEmail(runtime: Runtime, workspaceId: string, mail: { from: string; to: string[]; subject: string; text: string; html?: string; idempotencyKey: string; sealed?: boolean } & ({ standingEvent: string } | { billingNotice: string } | { notice: string })) {
  const origin = 'standingEvent' in mail ? `standing:${mail.standingEvent}` : 'billingNotice' in mail ? `billing:${mail.billingNotice}` : `notice:${mail.notice}`;
  const a: Actor = { workspaceId, keyId: origin, permissions: ['send'], domains: [], credential: 'apiKey' };
  const input = BatchInput.parse({ emails: mail.to.map(to => ({ from: mail.from, fromName: productName, to: [to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), kind: 'transactional' })) });
  return admitEmails({ runtime, path: '/v1/emails/batch', key: idempotencyKey(mail.idempotencyKey) }, a, input, undefined, mail.sealed);
}
