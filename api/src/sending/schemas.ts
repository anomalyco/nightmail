import { type AuditContext, recordAudit } from '../audit.js';
import { z } from '@hono/zod-openapi';
import { sql, eq, SQL, or, and, isNull, inArray, getTableColumns } from 'drizzle-orm';
import { lists, segments } from '../db/audience.js';
import { IdParams, AudienceSpec, PageQuery, digest } from '../core/http.js';
import { type Runtime, SuppressionReason, EmailEventData, type Actor, type DbExecutor, type Ctx, withoutVerdict } from '../core/types.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actorMailAccess, senderDomainAllowed } from '../core/access.js';
import { lazyModule, ApiError, denied, unrestrictedRequired, notFound, redactCapabilityData } from '../core/errors.js';
import { region } from '../core/ses.js';
import { CAMPAIGN_STATES, CAMPAIGN_ACTIVE, campaignResumable, pauseCampaign, retireCampaignRun } from '../states.js';
import { productName } from '../brand.js';
import { regionalSending } from '../domain-claims.js';
import { assertRegionEnabled, regionPattern } from '../ses-region-state.js';
import { CustomHeaders } from '../custom-headers.js';
import { mailboxMail } from '../thread-view.js';
import { type EmailStatus, campaigns, emails, type CampaignDraft } from '../db/sending.js';
import { mailAddress, senderDisplayName, parseSenderAddress, transactionalUnsubscribeUrl, unsubscribePageUrl } from '../outbound-content.js';
import { clients, type Client } from '../email-preview/support.js';
import { canonical, idempotentRequest } from '../idempotency.js';
import { SEND_LIMITS, contentBytes } from '../send-limits.js';
import { withMemory } from '../isolate-memory.js';
import { PAGE_MAX_BYTES, utf8Bytes } from '../read-bounds.js';
import { RecipientWarning, RiskBreakdown } from '../list-hygiene.js';
import { ATTACHMENT_LIMITS_TEXT, ATTACHMENT_RULES_TEXT, ATTACHMENT_REFUSALS_TEXT } from '../attachment-limits.js';
import { RAMP, LEGACY_READINESS_REASONS, READINESS_REASONS } from '../standing-model.js';
import type { FeedbackLag } from './events.js';

export type HtmlParser = typeof import('parse5').parse;
export const loadParse5 = lazyModule((): Promise<HtmlParser> => import('parse5').then(m => m.parse));
export const loadBoundedHtml = lazyModule(() => import('../bounded-html.js'));
export const loadCampaignBlocks = lazyModule(() => import('../campaign-blocks.js'));
export const loadEmailPreview = lazyModule(() => import('../email-preview/index.js'));
export const loadOpsUnsub = lazyModule(() => import('../audience/unsubscribe.js'));
export const loadScreen = lazyModule(() => import('../screen.js'));
export const loadSendingSesv2 = lazyModule(() => import('@aws-sdk/client-sesv2'));

export const MAX_BODY = 512 * 1024;
// Upload storage and batch expansion; the limits a send is admitted against are in send-limits.ts. Stored uploads are
// kept as long as their emails (30 days) and unused ones 30 days, so the stored quota is a rolling volume: it is set far
// above any month of real attachments (100 GiB is about 100,000 emails with a 1 MB file) and only stops runaway uploads.
export const SENDING_LIMITS = { expandedCampaignBytes: 128 * 1024 * 1024 } as const;
export const limitsTable = (runtime: Pick<Runtime, 'config'>) => sql.identifier(runtime.config.multiTenant ? 'regional_workspace_limits' : 'sending_region_limits');
// Preparation is bounded by bytes (4 MiB) and time (10 s) per job; a large row limit keeps small
// campaigns to one scheduler hop instead of one per thousand recipients.
export const CAMPAIGN_PREPARE_ROWS = 20000;
export const CAMPAIGN_EXPAND_ROWS = 2000;
export const CAMPAIGN_CHUNK_BYTES = 4 * 1024 * 1024;
// Estimated final content validated per preparation job. Snapshots are transient here (only their
// digests are kept), so the ten-second bound is the real guard; this keeps a 10k static campaign to one hop.
export const CAMPAIGN_PREPARE_BYTES = 64 * 1024 * 1024;
// Materialized-but-unsent rows per campaign / per workspace: about ten seconds of the regional
// send rate, so expansion (a scheduler job with its own latency) never starves the dispatcher.
const CAMPAIGN_BUFFER = 400;
export const DAY_MS = 24 * 3600_000;
// Automatic pause: AWS reviews accounts at 5% bounces and 0.1% complaints, so pause well before either,
// once enough mail has been accepted for the rate to be meaningful.
export const AUTO_PAUSE = { bounceRate: 0.02, bounceMinimum: 1000, complaintRate: 0.0008, complaintMinimum: 5000, hostedComplaintMinimum: 2000, intervalMs: 30 * 60_000 };
// Hosted list probe: the first min(500, 10%) recipients, at least 100, go out first. Release waits until they have left
// the queue and ten more minutes for their feedback; more than 3% bounces or two complaints quarantine the campaign.
export const PROBE = { share: 0.1, min: 100, max: 500, waitMs: 10 * 60_000, bounceRate: 0.03, complaints: 2 };
export const probeSize = (total: number) => Math.min(total, Math.max(PROBE.min, Math.min(PROBE.max, Math.ceil(total * PROBE.share))));
// The campaign ramp's check of each step's batch (src/standing-model.ts RAMP.check), in milliseconds.
export const RAMP_CHECK = { ...RAMP.check, maxWaitMs: RAMP.check.maxWaitMinutes * 60_000, retryMs: RAMP.check.retryMinutes * 60_000 } as const;
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
export const RELEASE_INTERVAL_MS = 5000, RELEASE_BURST_MS = 20000;
export const campaignBuffer = (rate: number) => Math.min(20000, Math.max(CAMPAIGN_BUFFER, Math.ceil(rate * 10)));
export const workspaceBuffer = (rate: number) => Math.min(50000, Math.max(1000, Math.ceil(rate * 20)));
// Recheck a full buffer or in-flight campaign once its backlog should have drained at the cached
// regional rate; rechecking sooner only repeats the same work. Unknown rates use a fixed interval.
export const drainDelayMs = (backlog: number, rate: number, floor = 1000) => rate > 0 ? Math.max(floor, Math.min(15000, Math.ceil(1000 * backlog / rate))) : 5000;
export const Address = mailAddress();
const Subject = z.string().min(1).max(998).refine(v => !/[\r\n]/.test(v), 'Subject cannot contain line breaks.');
export const FromName = senderDisplayName();
const PreviewText = z.string().max(200).describe('Optional preheader text. Inserted as escaped hidden text into each outgoing HTML snapshot; draft HTML is unchanged. When set, supply HTML without its own duplicate preheader.');
export const CAMPAIGN_DEFAULTS_MAX_KEYS = 100;
export const CAMPAIGN_DEFAULTS_MAX_BYTES = 64 * 1024;
export const EMAIL_LIST_MAX_BYTES = PAGE_MAX_BYTES;
export const LARGE_READ_RESERVE_THRESHOLD = 64 * 1024;
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
export const ATTACHMENT_NOTE = `Attachments: ${ATTACHMENT_LIMITS_TEXT} ${ATTACHMENT_RULES_TEXT} ${ATTACHMENT_REFUSALS_TEXT}`;
const TopicId = z.string().min(1).max(120);
const ContentFields = { subject: Subject.optional(), html: z.string().min(1).max(MAX_BODY).optional(), text: z.string().min(1).max(MAX_BODY).optional() };
const SendFrom = z.string().max(460).refine(v => parseSenderAddress(v) !== null, 'Use an email address or "Name <address>", or set fromName separately.');
const TransactionalUnsubscribe = z.object({
  url: transactionalUnsubscribeUrl().describe('HTTPS URL for RFC 8058 one-click unsubscribe (POST List-Unsubscribe=One-Click).'),
}).strict().describe(`kind transactional only (422 UNSUBSCRIBE_REQUIRES_TRANSACTIONAL on marketing, where ${productName} manages unsubscribe headers). Writes List-Unsubscribe and List-Unsubscribe-Post: List-Unsubscribe=One-Click headers for apps managing their own notification opt-outs.`);
export const SendInput = z.object({
  from: SendFrom.describe('An address at a domain verified in this workspace, or at a subdomain of one — either a bare address or "Display Name <address>" (or set fromName separately). Hosted: also any address at the workspace\u2019s built-in domain (connection.builtinDomain in GET /v1/me) until a domain of its own verifies.'), fromName: FromName.optional(), to: z.union([Address, z.array(Address).min(1).max(50)]), cc: z.array(Address).max(49).default([]), bcc: z.array(Address).max(49).default([]), replyTo: z.array(Address).max(10).default([]),
  region: Region.optional().describe(`Usually omitted: hosted ${productName} sends from the region bound to the sender domain, and a different value fails with SENDER_REGION_MISMATCH. Self-hosted installations default to their default region.`), kind: z.enum(['transactional', 'marketing']).default('transactional').describe(`marketing adds ${productName}'s footer (an Unsubscribe link, with the workspace's postal address under it when it has one) and the one-click List-Unsubscribe headers.`), ...ContentFields,
  template: z.object({ name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), data: StoredTemplateData }).strict().describe('Uses native SES stored-template rendering and snapshots its rendered MIME. SES does not automatically escape HTML; callers must escape untrusted HTML-context values. Simulated deployments do not render AWS templates.').optional(),
  attachments: AttachmentIds, tracking: z.boolean().optional(), headers: CustomHeaders.optional(),
  unsubscribe: TransactionalUnsubscribe.optional(),
  topicId: TopicId.optional().describe('kind marketing only (422 TOPIC_REQUIRES_MARKETING otherwise): the topic it is about (listTopics). A recipient who opted out of the topic is refused (reason topic_unsubscribed), and its one-click unsubscribe opts out of this topic only.'),
  screen: z.boolean().optional().describe('Request outbound harm screening at accept time for live transactional mail. Hosted live screening is operator-controlled and cannot be disabled by setting this field to false. Simulated mail is not screened. A positive reject verdict fails the request synchronously with 422 CONTENT_REJECTED_SPAM (nothing queued); during a temporary outage of both classifiers, the message is accepted (202) and held unscreened until a classifier answers. Mandatory Hosted screening with no classifier configured returns retryable 503 CONTENT_SCREEN_UNAVAILABLE with Retry-After.'),
}).strict().superRefine((v, ctx) => {
  const parsed = parseSenderAddress(v.from);
  if (parsed?.name && v.fromName !== undefined && parsed.name !== v.fromName) ctx.addIssue({ code: 'custom', path: ['fromName'], message: 'Supply the sender display name in either from or fromName, not both.' });
  if (v.template ? (v.subject !== undefined || v.html !== undefined || v.text !== undefined) : (!v.subject || (!v.html && !v.text))) ctx.addIssue({ code: 'custom', message: 'Provide subject and html/text, or template, but not both.' });
  if ((Array.isArray(v.to) ? v.to.length : 1) + v.cc.length + v.bcc.length > 50) ctx.addIssue({ code: 'custom', message: 'At most 50 recipients across to/cc/bcc.' });
  if (v.kind === 'marketing' && ((Array.isArray(v.to) ? v.to.length : 1) !== 1 || v.cc.length || v.bcc.length)) ctx.addIssue({ code: 'custom', message: 'Marketing messages require exactly one To recipient and no Cc/Bcc.' });
  if (v.template && (v.attachments.length || v.kind === 'marketing')) ctx.addIssue({ code: 'custom', message: 'Stored templates currently support transactional messages without attachments only.' });
}).openapi('BatchSendEmailItem');
export function normalizeSender<T extends { from: string; fromName?: string }>(mail: T): T {
  const parsed = parseSenderAddress(mail.from);
  if (!parsed || parsed.address === mail.from) return mail;
  return { ...mail, from: parsed.address, ...(mail.fromName === undefined && parsed.name ? { fromName: parsed.name } : {}) };
}
// The screen's limits (src/screen.ts), as the API reference states them; the defaults of JEV_MESSAGE_LIMIT_BYTES and JEV_CAMPAIGN_LIMIT_BYTES.
export const screenBytes = (n: number) => n.toLocaleString('en-US'), SCREEN = SEND_LIMITS.screen;
export const RAMP_NOTE = `Marketing ramp: on Hosted sending, a workspace still ramping up (a new sender, exempt and first-party ones included) sends kind: marketing at most its ramp step's hourly ceiling (${RAMP.steps.map(x => x.ceilingPerHour.toLocaleString('en-US')).join(', ')} recipients an hour), shared with its campaigns. A send that would cross it is refused with nothing queued (a batch as a whole): retryable 429 RAMP_LIMIT_REACHED, with Retry-After (seconds until more room opens) and error.details[0] holding { step, steps, ceilingPerHour, usedThisHour, fitsNow, requested, stepOpensAt }. A scheduled marketing send is refused the same way when it is scheduled if it is larger than the step's whole ceiling, or if with the marketing already scheduled within 24 hours either side of its time it is more than the step sends in 24 hours (error.details[0] adds { scheduledBacklog, dailyBudget }); one that fits is held at its time until its hour has room (it stays scheduled, scheduledAt moving to when it tries again, with a dispatch_deferred event), never rejected for the ramp. While the workspace ramps and a campaign of it is stopped by the automatic pause, the list probe or the ramp's check (LIST_QUALITY, BOUNCE_RATE_HIGH, COMPLAINT_RATE_HIGH) and not resumed or canceled, marketing sends and schedules are refused with 409 RAMP_PAUSED (not retryable; error.details[0] holds { campaignId, pauseCode }): review and resume that campaign first. For a large list, send a campaign instead: campaigns are paced automatically. Transactional mail is never ramped or paused by it.`;
export const SCREEN_LIMIT_NOTE = `Front-door admission and content screening: Hosted sending checks validation, recipient suppression/consent, balance, limits, and the outbound harm screen synchronously before queueing. Failing messages return an immediate error (422 RECIPIENT_INELIGIBLE, 422 CONTENT_REJECTED_SPAM, 422 CONTENT_TOO_LARGE_TO_SCREEN, or retryable 503 CONTENT_SCREEN_UNAVAILABLE with Retry-After when no mandatory classifier is configured) and nothing is queued; during a temporary outage of both classifiers, eligible mail is accepted (202) and held unscreened until a classifier answers. Screened-text limits: at most ${screenBytes(SCREEN.messageBytes)} UTF-8 bytes per message (installation default) and ${SCREEN.linkHosts} distinct link hosts (${screenBytes(SCREEN.linkHostBytes)} bytes of host names), counting link labels that name another host; over either limit, error.details[0] holds { screenedBytes, limitBytes } or { linkHosts, linkHostLimit } (plus index in a batch).`;
export const CAMPAIGN_SCREEN_NOTE = `Hosted campaigns screen every distinct copy during launch and prepare before any row enters the sending queue, each distinct copy only once: recipients whose personalized copies read the same share one verdict. The campaign\u2019s own copy, placeholders unresolved, is screened first and may hold ${screenBytes(SCREEN.campaignBytes)} bytes of screened text (installation default; 422 CONTENT_TOO_LARGE_TO_SCREEN with error.details[0] { screenedBytes, limitBytes } otherwise); so may each copy. A failing copy never enters the sending queue (CONTENT_REJECTED_SPAM); when refused copies pass 5% and 10 recipients the campaign pauses once for review, and a positive verdict on the campaign\u2019s own copy fails it before anyone is sent to.`;
// The audience is frozen inside the launch request (campaigns/launch.ts launch): a large one takes seconds, and one statement of it
// may run out of the database's time.
export const CAMPAIGN_POSTAL_NOTE = 'Every email\u2019s footer shows the workspace\u2019s postal address under the Unsubscribe link, as US law (CAN-SPAM) requires, frozen as it is now: without one the request is refused with 422 POSTAL_ADDRESS_REQUIRED (set postalAddress with updateWorkspaceSettings).';
export const CAMPAIGN_CAPTURE_NOTE = 'Audiences on lists up to 5,000 members freeze inside this request; larger audiences freeze in the background during preparing so this request returns immediately. CampaignQueued.queued is recipients expected; delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. Late capture failures (such as EMPTY_AUDIENCE or AUDIENCE_LIMIT_EXCEEDED) move the campaign to failed with delivery.error and leave the draft editable.';
export const captureTimedOut = () => new ApiError(503, 'AUDIENCE_CAPTURE_TIMEOUT', 'The audience capture ran out of time and nothing was kept. Retry the launch; if it keeps running out of time, send to a smaller list.', undefined, true);
// SMTP already limits the entire MIME message to the advertised wire SIZE. Keep all
// address, HTML and encoded-size checks, without imposing the public JSON body-part cap.
const ProtocolBody = z.string().min(1).optional();
export const ProtocolSendInput = SendInput.safeExtend({ html: ProtocolBody, text: ProtocolBody });
const ReplyAddressId = z.string().min(1).max(120).optional();
// A send at a later time: an RFC 3339 instant with Z or an offset (a local time without one is refused), stored and
// returned in UTC. The bounds are send_admission's (SEND_LIMITS.schedule), so an exact retry still replays its receipt.
export const ScheduledAt = z.string().datetime({ offset: true }).describe(`Send at this time instead of now: an RFC 3339 instant with Z or an offset, such as 2026-11-20T09:00:00Z; times without an offset are refused, and the time is returned in UTC. From now (up to a minute in the past, which sends at once) to ${SEND_LIMITS.schedule.horizonSeconds / 86_400} days ahead; up to ${SEND_LIMITS.schedule.workspace.toLocaleString('en-US')} scheduled emails may wait per workspace (SCHEDULED_EMAIL_LIMIT_EXCEEDED). Content screening and suppression are checked at accept time; sending limits and the balance apply at scheduledAt, when an email they refuse is rejected with their code (email.rejected), except Hosted marketing its ramp hour has no room for, which is held until there is (RAMP_LIMIT_REACHED in sendEmail's description). Not with replyAddressId.`);
export const SingleSendInput = SendInput.safeExtend({ replyAddressId: ReplyAddressId.describe('Track a conversation through this receivable address. Use explicit subject and text/html. Requires unrestricted manage permission; From and Reply-To must belong to the address.'), replyMailboxId: ReplyAddressId.openapi({ deprecated: true, description: 'Legacy spelling of replyAddressId.' }), scheduledAt: ScheduledAt.optional() })
  .refine(v => !(v.replyAddressId && v.replyMailboxId), { path: ['replyAddressId'], message: 'Supply only one reply address ID.' })
  .refine(v => !(v.scheduledAt && (v.replyAddressId || v.replyMailboxId)), { path: ['scheduledAt'], message: 'A tracked conversation send goes now; schedule only untracked sends.' }).openapi('SendEmailInput');
export const BatchInput = z.object({ emails: z.array(SendInput).min(1).max(100).describe(`Up to 100 messages. Their html and text together may hold ${SEND_LIMITS.batchContentChars / 1024 / 1024} MiB (413 BATCH_CONTENT_TOO_LARGE).`) }).strict().openapi('SendEmailBatchInput');
/** Characters of html and text in a batch's messages together (SEND_LIMITS.batchContentChars). */
export const batchContent = (mails: { html?: string; text?: string }[]) => mails.reduce((n, m) => n + (m.html?.length ?? 0) + (m.text?.length ?? 0), 0);
/** A batch with more than 2 MiB of content (the limit before 10 MiB) reserves, in the isolate's memory budget
 *  (isolate-memory.ts), what admitting it builds beside the parsed request: the rows' JSON and the statement's buffers,
 *  about three times its content. The largest batches then never peak together in one isolate; smaller ones run at once. */
export const batchMemory = <T>(mails: SendRequest[], work: () => Promise<T>, opts?: { workspaceId?: string; signal?: AbortSignal }) =>
  batchContent(mails) > 2 * 1024 * 1024 ? withMemory(3 * mails.reduce((n, m) => n + contentBytes(m), 0), work, { route: 'email.batch', ...opts }) : work();
export const Status = z.enum(['queued', 'attempting', 'accepted', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'delayed', 'suppressed', 'canceled', 'acceptance_unknown', 'simulated']);
const UntrustedContent = z.boolean().describe('True for replies and older non-campaign mail of unknown origin: the subject or body may contain received content.');
export const Email = z.object({ untrustedContent: UntrustedContent, id: z.string(), region: z.string(), campaignId: z.string().nullable(), from: z.string(), fromName: z.string().nullable(), kind: z.enum(['transactional', 'marketing']), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(),
  status: Status.describe('A scheduled email is queued, with scheduled true, until it is sent at scheduledAt.'), providerId: z.string().nullable(), simulated: z.boolean(), attemptStartedAt: z.string().nullable(), errorCode: z.string().nullable(), suppressionReason: SuppressionReason.nullable().optional(),
  scheduled: z.boolean().describe('True while a scheduled send waits for scheduledAt: it has not started sending, and cancelEmail or rescheduleEmail still apply. At that time it is admitted like a send made then (limits and balance included) and follows the usual lifecycle, or is rejected with the refusal\u2019s code.'),
  scheduledAt: z.string().nullable().describe('When a scheduled send goes (UTC). Also set while queued mail waits to be retried.'), createdAt: z.string().describe('When the email was submitted; a scheduled send\u2019s moves to the moment it was released at its time.'), updatedAt: z.string() }).openapi('Email');
const ScreenSummary = z.object({
  status: z.enum(['passed', 'skipped']),
}).openapi('EmailScreenSummary');
export const Receipt = z.object({
  id: z.string(),
  status: z.literal('queued'),
  simulated: z.boolean(),
  screen: ScreenSummary.optional().describe('Content-screen outcome recorded at accept time when screening applies.'),
  warnings: z.array(RecipientWarning).optional().describe('Recipients whose address looks risky (a disposable inbox, a mistyped provider, a role address): the email was queued anyway. Campaigns and marketing sends skip risky contacts.'),
}).openapi('EmailQueued');
export const SingleReceipt = z.object({ ...Receipt.shape, scheduledAt: z.string().optional().describe('A scheduled send: when it goes (UTC).'), inboundMessageId: z.string().optional(), mailboxMessageId: z.string().optional().openapi({ deprecated: true, description: 'Legacy alias for inboundMessageId.' }), threadId: z.string().optional() }).describe('For tracked sends, id is the transactional receipt, inboundMessageId identifies the stored message, and threadId identifies its conversation.').openapi('SingleEmailQueued');
export const BatchReceipt = z.object({ data: z.array(Receipt) }).openapi('EmailBatchQueued');
export const sendRecipients = (m: { to: string | string[]; cc: string[]; bcc: string[] }) => [...(Array.isArray(m.to) ? m.to : [m.to]), ...m.cc, ...m.bcc];
export const Event = z.object({ id: z.string(), emailId: z.string(), type: z.string(), providerId: z.string().nullable(), simulated: z.boolean(), createdAt: z.string(), data: EmailEventData }).openapi('EmailEvent');
export const EmailContent = z.object({ untrustedContent: UntrustedContent, subject: z.string(), html: z.string().nullable(), text: z.string().nullable(), raw: z.string().nullable(), attachments: z.array(z.string()), render: z.enum(['direct', 'ses', 'simulated']), templateName: z.string().nullable(), simulated: z.boolean() }).openapi('EmailContent');
const PreviewClient = z.enum(clients).openapi('EmailPreviewClient');
const previewOptions = {
  clients: z.array(PreviewClient).min(1).max(clients.length).refine(list => new Set<Client>(list).size === list.length, 'Select each client only once.').openapi({ uniqueItems: true }),
  theme: z.enum(['light', 'dark']),
  device: z.enum(['desktop', 'mobile']).optional().describe('Viewport width in CSS pixels: mobile 390, desktop 800. Defaults to mobile for iOS, Android and Samsung Email; otherwise desktop.'),
};
export const EmailPreviewInput = z.union([
  z.object({ html: z.string().min(1).describe('HTML to preview, up to 256 KiB in UTF-8.'), ...previewOptions }).strict(),
  z.object({ emailId: IdParams.shape.id.describe('Outbound email with retained HTML visible to this credential.'), ...previewOptions }).strict(),
]).openapi('EmailPreviewInput', { description: 'Supply exactly one source: html or emailId.' }, { unionPreferredType: 'oneOf' });
export const EmailPreviews = z.object({ previews: z.array(z.object({
  client: PreviewClient, html: z.string().describe('Untrusted offline document; render only as the srcdoc of an iframe with sandbox="". Empty for classic Outlook (lint only).'),
  issues: z.array(z.object({ feature: z.string(), clients: z.array(PreviewClient), severity: z.enum(['warning', 'error']) })),
})) }).openapi('EmailPreviews');
export const AttachmentInfo = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable(), createdAt: z.string() }).openapi('Attachment');
export const Removed = z.object({ id: z.string(), deleted: z.literal(true) }).openapi('DeletedSendingResource');
const DraftAudience = AudienceSpec.partial({ listId: true }).default({});
const BlockHtml = z.string().max(MAX_BODY).describe('Block HTML: h1-h3, p, ul/ol, blockquote, pre>code, hr, img, buttons, columns and styled sections with inline formatting. A constrained email-safe style attribute supports color, typography, spacing, borders, radius and dimensions; arbitrary CSS remains rejected. No wrappers, tables, class or id. Call getContentGuide in MCP or GET /v1/campaign-content-guide for the full vocabulary and examples.');
const CampaignDraftFields = { name: z.string().trim().min(1).max(200), from: z.union([Address, z.literal('')]).default(''), fromName: FromName.optional(), previewText: PreviewText.optional(), replyTo: z.array(Address).max(10).default([]), region: Region, regionPinned:z.boolean().optional().describe('Regional MX only. False follows the From domain; the displayed region is a hint. A supplied region on create or a changed region on edit pins it. To unpin, pass false and omit region.'), subject: z.union([Subject, z.literal('')]).default(''), attachments: AttachmentIds, tracking: z.boolean().default(true), audience: DraftAudience, defaults: Data, unsubscribePageUrl: unsubscribePageUrl().optional(),
  topicId: TopicId.optional().describe('The topic the campaign is about (listTopics): it skips contacts who opted out of it, and its one-click unsubscribe opts out of this topic only. Not on a required notice.'),
  requiredNotice: z.boolean().optional().describe('A required notice: a message every recipient must get whatever their marketing choice, such as a change to terms, prices or taxes, never a promotion. It goes to everyone in the audience who is not suppressed, people who unsubscribed from marketing included, without an Unsubscribe link or List-Unsubscribe header, and is paced, limited and paused like any campaign. Only where an operator turned required notices on for the workspace (requiredNotices in getWorkspaceSettings); 403 REQUIRED_NOTICES_OFF otherwise. Sending or scheduling one needs confirmRequiredNotice. Turned off later, a launched notice pauses before releasing anyone more (pause reason REQUIRED_NOTICES_OFF) and is resumed or rescheduled only once they are on again. Resumed after a list-probe quarantine, it goes on to everyone captured for it (never deliveredOnly).') };
const CAMPAIGN_INPUT_NOTES = 'Drafts may omit sender, subject, content and audience until review or send, except that domain-restricted keys must supply a From address on one of their domains. Content is block HTML (see html); the same form is what the dashboard composer reads and writes, so people and agents edit one document. Simple {{name}} personalization works in text and quoted href/alt attributes; values are HTML-escaped and rendered URLs are validated. Durable campaign preparation is bounded and runs in background jobs.';
const CampaignInput = z.object({ ...CampaignDraftFields, html: BlockHtml.optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraftInput');
// Stored drafts predating block HTML or defaults caps remain readable; they are revalidated when saved or reviewed.
const CampaignDraftView = z.object({ ...CampaignDraftFields, defaults: DataView, html: z.string().optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraft');
export const CampaignCreate = z.object({ ...CampaignInput.shape, region: Region.optional().describe('Defaults to the installation region. With regional MX delivery, omitting region follows the From domain.'), tracking: z.boolean().optional(), templateId: z.string().regex(/^tpl_[0-9a-f]{32}$/).optional().describe('Copies the active published revision of this global campaign template into a new independent campaign draft.') }).strict().openapi('CreateCampaignInput');
const CampaignReady = CampaignInput.extend({ from: Address, subject: Subject, audience: AudienceSpec }).refine(v => !!v.html?.trim(), { message: 'Provide html before reviewing.', path: ['html'] });
const CampaignStateValue = z.enum(CAMPAIGN_STATES).describe('draft: editable. preparing: the audience is being frozen (for large lists) and every message is being validated in the background. scheduled: validated and waiting for scheduledAt. sending: recipients are being released into the dispatch queue. paused: releasing stopped by the user or the health check; queued mail still dispatches. done: every recipient was released and dispatched. failed: capture, preparation or releasing failed (delivery.error); edit or launch again. canceled: terminal.');
export const emptyCounts = () => ({ total: 0, byStatus: Object.fromEntries(Status.options.map(status => [status, 0])) as Record<EmailStatus, number> });
const CampaignCounts = z.object({ total: z.number().int().nonnegative(), byStatus: z.record(Status, z.number().int().nonnegative()) }).describe('Counts of immutable campaign email records grouped by their current status, not cumulative provider events or delivery rates. Drafts with no queued emails have zero counts.');
const Failure = z.object({ code: z.string(), message: z.string() });

const Delivery = z.object({ total: z.number().int().describe('Fixed recipient count once the audience is frozen (recipients expected while a large audience is being captured).'), prepared: z.number().int().describe('Recipients whose message was validated.'), expanded: z.number().int().describe('Recipients materialized as immutable email records.'), canceled: z.number().int().describe('Recipients canceled before materialization. Materialized cancellations remain in counts.byStatus.canceled.'), error: Failure.nullable().describe('Why the campaign failed or was canceled by the system.'),
  pacing: z.object({ perDay: z.number().int().nullable().describe('Maximum recipients released per rolling 24-hour window; null means no daily cap.'), autoPause: z.boolean().describe('Pause automatically when bounce or complaint rates exceed safe thresholds.'), rateShare: z.number().describe('Maximum fraction of the SES per-second send rate this campaign uses; 1 is the full rate.'), windowStartedAt: z.string().nullable(), windowExpanded: z.number().int().describe('Recipients released in the current 24-hour window.'), nextWindowAt: z.string().nullable().describe('When the next 24-hour window opens, when a daily cap is set.'),
    plan: z.array(z.number().int()).nullable().describe('Sent with the recommended plan: its daily batches (one 24-hour window each; the last repeats). Null otherwise.'), batch: z.number().int().nullable().describe('With a plan: the batch the current window releases, from 1.'),
    held: z.object({ since: z.string(), batch: z.number().int().describe('The batch the plan repeats, from 1.'), why: z.array(z.enum(['bounces', 'complaints', 'blocklist'])).describe('What made the last day unhealthy: hard bounces over 3% of at least 100 accepted, complaints over 0.08% (at least 2), or a reply naming a blocklist.'), toGrow: z.string().describe('What lets the plan open its next batch, in a sentence.') }).nullable().optional().describe('With a plan whose growth is checked: held on the same batch since the day before it was not healthy; null while it grows.'),
    firstBatch: z.object({ size: z.number().int().describe('Recipients the first day starts with.'), waitMinutes: z.number().int().describe('Minutes it then waits for their bounces and rejections before the rest of the day\'s batch.') }).nullable().optional().describe('With a plan: its first day\'s small batch and the wait after it.') }),
  consent: z.object({ source: z.string(), confirmedAt: z.string() }).nullable().describe('The consent source confirmed at launch, if any.'),
  pausedAt: z.string().nullable(), pauseReason: Failure.nullable(),
  deliveredOnly: z.boolean().describe('After a resumed list-probe quarantine: the rest goes only to contacts this workspace delivered to before; the others are counted in canceled. Never for a required notice.'),
  waiting: z.object({ reason: z.enum(['pacing_window', 'ses_daily_quota', 'hosted_daily_quota', 'list_probe', 'balance', 'feedback_lag', 'ramp', 'link_record']), linkHold: z.enum(['daily_budget', 'blocklist']).optional().describe('When present, the daily pacing window is the shared link allowance, or the link record is held for operator review.'), until: z.string() }).nullable().describe('Why releasing recipients is currently held, and the best estimate of until when. list_probe: Hosted sent the first recipients (the list probe) and waits for their bounces and complaints before releasing the rest. feedback_lag: releasing is briefly held while priority safety feedback (bounces/complaints) catches up. ramp: a Hosted sender\'s first large campaigns release in growing hourly steps (sendEstimate.ramp); this hour\'s step is used up, or its delivery results are still coming in before the next step. link_record: the campaign has no host for its unsubscribe link right now (its workspace\'s sending is paused, or with own link hosts, its domain\'s isn\'t active yet); it continues by itself.'),
  stoppedDomains: z.array(z.object({ domain: z.string(), stoppedAt: z.string() })).optional()
    .describe('Recipient domains this campaign stopped sending to because its mail there kept bouncing for good (the rest of its recipients there are counted in canceled, are not charged and are not suppressed), oldest first, at most 50. Empty unless the guard is on.'),
  feedbackLag: z.object({ oldestMs: z.number().int(), lane: z.enum(['routine', 'priority']) }).nullable().describe('Present while a campaign is preparing, sending, or paused when delivery feedback ingestion is at least 2 minutes behind.') }).describe('The current launch: null until the campaign is sent or scheduled, and cleared by a new revision.').openapi('CampaignDelivery');
/** The daily cap of a campaign's `index`th 24-hour window: its plan's batch (the last repeating), else pacePerDay; null for none. */
export const dailyCap = (row: Pick<typeof campaigns.$inferSelect, 'pacePlan' | 'pacePerDay' | 'windowIndex'>, index = row.windowIndex) =>
  row.pacePlan?.length ? row.pacePlan[Math.min(index, row.pacePlan.length - 1)]! : row.pacePerDay;
/** When a plan's first small batch is waiting for its feedback: the end of that wait (ms), else null. Only in the first window. */
export const firstBatchWait = (row: Pick<typeof campaigns.$inferSelect, 'pacePlan' | 'paceFirstBatch' | 'paceFirstWaitMinutes'>, index: number, windowStartedAt: string | null, nowMs: number) => {
  if (!row.pacePlan?.length || !row.paceFirstBatch || !row.paceFirstWaitMinutes || index !== 0 || !windowStartedAt) return null;
  const until = Date.parse(windowStartedAt) + row.paceFirstWaitMinutes * 60_000;
  return nowMs < until ? until : null;
};
export type StoppedDomain = { domain: string; stoppedAt: string };
export function deliveryView(row: Omit<typeof campaigns.$inferSelect, 'draft' | 'stats'>, feedbackLag: FeedbackLag | null = null, stopped: StoppedDomain[] = []) {
  if (!row.reviewId) return null;
  const next = dailyCap(row) !== null && row.windowStartedAt ? new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString() : null;
  const wait = row.waitingReason === 'link_budget' ? { reason: 'pacing_window', linkHold: 'daily_budget' }
    : row.waitingReason === 'link_listing' ? { reason: 'link_record', linkHold: 'blocklist' } : { reason: row.waitingReason };
  return Delivery.parse({ total: row.total, prepared: row.prepared, expanded: row.expanded, canceled: row.canceled, error: row.error ?? null,
    pacing: { perDay: row.pacePerDay, autoPause: row.autoPause, rateShare: row.rateShare ?? 1, windowStartedAt: row.windowStartedAt, windowExpanded: row.windowExpanded, nextWindowAt: next,
      plan: row.pacePlan, batch: row.pacePlan ? Math.min(row.windowIndex, row.pacePlan.length - 1) + 1 : null,
      firstBatch: row.pacePlan && row.paceFirstBatch && row.paceFirstWaitMinutes ? { size: row.paceFirstBatch, waitMinutes: row.paceFirstWaitMinutes } : null,
      // Only while it still sends: a finished or canceled campaign isn't repeating a batch.
      held: row.pacePlan && row.planHeld && ['sending', 'paused'].includes(row.state) ? { ...row.planHeld, toGrow: 'It opens its next batch after a day with hard bounces at most 3% of what was accepted, complaints under 0.08% and no reply naming a blocklist: remove the addresses that bounce or complain, and fix whatever the blocklist lists.' } : null },
    consent: row.consent ? { source: row.consent.source, confirmedAt: row.consent.confirmedAt } : null,
    pausedAt: row.pausedAt, pauseReason: row.pauseReason ?? null, deliveredOnly: row.deliveredOnly, waiting: row.waitingReason && row.waitingUntil ? { ...wait, until: row.waitingUntil } : null,
    feedbackLag: ['preparing', 'sending', 'paused'].includes(row.state) ? feedbackLag : null, stoppedDomains: stopped });
}
const CampaignRamp = z.object({ step: z.number().int().describe('The step the campaign releases at, from 1.'), steps: z.number().int().describe('How many steps the ramp has; past the last one only the other limits apply.'), ceilingPerHour: z.number().int().describe('Most recipients this step releases in its hour.'),
  startedAt: z.string().nullable().describe('When this step\'s hour started: its first release. Null before it.'), released: z.number().int().describe('Recipients released since this step\'s hour started.') })
  .describe('Where the campaign is on the ramp. A Hosted sender\'s first large campaigns release in hourly steps that grow (1,000 an hour at first), moving to the next step once an hour at this one went out and its delivery results are in and clean; more than 3% bounces or more than 0.08% complaints (at least 2) in a step pause the campaign. The first step not already proven by the workspace\'s largest clean marketing hour of the last 30 days is where it starts, so an established sender skips it. Null when no ramp applies (self-hosted, your own AWS account, simulated mail, an established sender, or past the last step). Transactional mail never waits for it.').openapi('CampaignRamp');
export const SendEstimate = z.object({
  recipients: z.number().int().nullable().describe('Recipients still to release: for a draft, the last audience count (previewCampaignAudience; null before one); once launched, those not released yet.'),
  ratePerSecond: z.number().nullable().describe('The region\'s send rate the campaign plans at, per second, before its rate share; null until the region\'s quota was read.'),
  ramp: CampaignRamp.nullable(),
  seconds: z.number().int().nullable().describe('How long releasing the recipients left takes from when it starts (the campaign\'s last change, updatedAt, or scheduledAt): from the ramp, the daily cap (pacing.perDay), the rate share and the region\'s send rate. A draft is estimated without a daily cap at the full rate. An estimate: it assumes clean, prompt feedback and leaves out the list probe\'s wait, quota holds and other mail sharing the rate. Null when it cannot be told (no audience count or send rate yet).'),
  finishAt: z.string().nullable().describe('A launched campaign: when its last recipient is expected to be released, as of its last change (updatedAt or scheduledAt, plus seconds). Null for a draft, while paused or failed, or when it cannot be told.'),
}).describe('How long sending takes, for a draft or a campaign that has recipients left to release. Null for a finished or canceled campaign; lists leave it out.').openapi('CampaignSendEstimate');
export const Campaign = z.object({ id: z.string(), url: z.string().url().describe('Dashboard URL for opening this campaign. Drafts open in the editor; launched campaigns open in review.'), revision: z.number().int(), draft: CampaignDraftView, sourceTemplateId: z.string().nullable(), sourceTemplateRevision: z.number().int().nullable(), state: CampaignStateValue, scheduledAt: z.string().nullable(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), counts: CampaignCounts, delivery: Delivery.nullable(), sendEstimate: SendEstimate.nullable() }).openapi('Campaign');
const CampaignRate = z.object({ value: z.number().nonnegative().nullable().describe('Fraction, not percent. Both counts exclude simulated emails. Null when the denominator is zero or engagement tracking is disabled. Not clamped: delayed feedback can temporarily make outcomes exceed the denominator.'), numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative() });
export const CampaignStats = z.object({
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
export const STATS_NOTE = `A campaign of at least ${CAMPAIGN_STATS.from.toLocaleString('en-US')} recipients is counted in the background: about once a minute while it sends (every few minutes for the largest, so counting stays a small share of the database's time), once more when it finishes, and again when read more than ${CAMPAIGN_STATS.readRefreshMs / 60_000} minutes later if anything changed. Its figures are the last count, so they can be minutes old; computedAt says when. A finished campaign keeps its figures after its emails leave the 30-day history.`;
export const CampaignState = Campaign.pick({ id: true, revision: true, updatedAt: true, state: true, scheduledAt: true, archivedAt: true }).describe('Compact state for draft sync polling. Compare all fields, not only revision: archival and delivery state can change without a new draft revision. Fetch the full campaign when state changes. No draft content or delivery counts.').openapi('CampaignState');
export const CampaignDraftSummary = CampaignDraftView.pick({ name: true, region: true, from: true, fromName: true, subject: true, previewText: true }).extend({ audience: AudienceSpec.pick({ listId: true, segmentId: true }).partial({ listId: true }).default({}) }).strict().openapi('CampaignDraftSummary');
const CampaignListStats = z.object({ tracking: z.boolean(), accepted: z.number().int(), delivered: z.number().int(), opened: z.number().int(), clicked: z.number().int(), computedAt: z.string().describe('When the count was taken.') })
  .describe('The campaign\u2019s last stored count: the totals getCampaignStats reported when it was taken (computedAt). Null when it has none. Listing never counts emails or events; listing with listId starts a count for finished campaigns whose figures are missing or stale, so they appear on a later read.').openapi('CampaignListStats');
export const CampaignSummary = Campaign.omit({ draft: true, sendEstimate: true }).extend({ draft: CampaignDraftSummary, stats: CampaignListStats.nullable() }).describe('Campaign list metadata only. Fetch GET /v1/campaigns/{id} for the complete draft before editing or sending. Content, defaults, attachments and audience exclusions are intentionally omitted.').openapi('CampaignSummary');
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
export const EmailQuery = PageQuery.extend({ campaignId: z.string().max(120).optional(), status: EmailStatusFilter.optional().describe('scheduled lists sends waiting for their time; queued includes them.'), region: Region.optional(), kind: z.enum(['transactional', 'marketing']).optional(), search: SubstringSearch.optional().describe('Literal case-insensitive substring of sender, To/Cc/Bcc, subject or email/campaign/provider ID, at least 3 characters: a shorter term is refused with 422 VALIDATION_FAILED. This is how to filter by sender or recipient address.'),
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
export const CampaignQuery = PageQuery.extend({ region: Region.optional(), state: CampaignStateValue.optional(), archived: z.enum(['true', 'false']).default('false').describe('False lists active campaigns; true lists archived campaigns only.'), search: z.string().trim().min(1).max(200).optional(),
  listId: z.string().min(1).max(120).optional().describe('Only campaigns whose audience list is this one: a newsletter\u2019s issues.'),
  newsletter: z.enum(['true', 'false']).optional().describe('true: only campaigns whose audience list is a newsletter. false: only the others, with no list or a list that is not a newsletter.') }).describe('Newest created campaigns first, excluding archived campaigns by default, with an opaque cursor bound to the filters. Search is literal, case-insensitive name, subject or ID text.').openapi('ListCampaignsQuery');
const HistoryFigures = z.object({ largestSend: z.number().int().describe('Most recipients SES accepted from one campaign in the last 90 days.'),
  firstSentAt: z.string().nullable().optional().describe('When this workspace first had mail accepted (workspace history only); null with none.'),
  usualDay: z.number().int().optional().describe('The usual day: the median of the mail accepted on the days it sent in the last 14 days (workspace history only); 0 with none.'), sent: z.number().int().describe('Recipients SES accepted in the last 30 days.'),
  bounceRate: z.number().nullable().describe('Hard bounces ÷ accepted over the last 30 days; null with nothing sent.'), complaintRate: z.number().nullable().describe('Complaints ÷ accepted over the last 30 days; null with nothing sent.') });
export const CampaignReadiness = z.object({
  verdict: z.enum(['ready', 'ramp_recommended', 'ramp_required']).describe('ready: send as you like. ramp_recommended: the plan is suggested. ramp_required: a Hosted send this large, from a new domain or far above anything its domain has sent, goes out with the plan (pacing.plan "recommended"), a daily limit no larger than its first day, or a confirmed consent source (consent); 422 RAMP_REQUIRED otherwise.'),
  summary: z.string().nullable().describe('Why, in one or two plain sentences, when a ramp is recommended or required.'),
  reasons: z.array(z.object({ code: z.enum(LEGACY_READINESS_REASONS), message: z.string() })).describe('The findings behind the verdict in the original codes, one per code: a newly registered domain, one new here and a new link domain read NEW_DOMAIN, a jump over the usual day SIZE_JUMP; blocklist findings appear only in findings. Prefer findings.'),
  findings: z.array(z.object({ code: z.enum(READINESS_REASONS), message: z.string() })).optional().describe('Every finding behind the verdict, with its own code: NEW_REGISTRATION (registered recently, from public registry data), NEW_HERE (registered long ago, new to this workspace), NEW_DOMAIN (added recently, registration not known), USUAL_JUMP, NEW_LINK_DOMAIN, BLOCKLISTED_BEFORE (an earlier send drew replies naming a blocklist and none has finished without since), BLOCKLIST_UNCOUNTED (a recent send\'s blocklist replies aren\'t counted yet, so it isn\'t taken for clean), and the original codes.'),
  unavailable: z.string().optional().describe('Present when part of the review couldn\'t be worked out just now (sizing the plan): what was left out, in a sentence. The review is then the one without that part, and its verdict is at least ramp_recommended. A launch that fails the same way is refused, 503 SEND_PLAN_UNAVAILABLE (retryable), with nothing sent.'),
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
export const AudienceCounts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int(),
  risky: z.number().int().describe('Contacts who could receive it but are flagged as risky (a disposable inbox, a mistyped provider, a role address, an address known to be undeliverable): the send skips them. Not in eligible.'),
  riskyByReason: RiskBreakdown.shape.byReason,
  topicExcluded: z.number().int().optional().describe('With a topic: the subscribed contacts it leaves out (who opted out of it, or for a topic only people who opt in get, who didn\u2019t). Counted in unsubscribed, not in eligible.'),
  approximate: z.literal(true).optional().describe('The topic\u2019s effect on this list couldn\u2019t be counted in time: eligible and topicExcluded are estimated from the workspace\u2019s choices about the topic. Sending counts it exactly.'),
  readiness: CampaignReadiness.nullable().optional().describe('With readiness=true: the send review of a marketing campaign with a sender; null for a required notice or a draft without a sender.') }).describe('Live counts for the saved audience: matched contacts, those eligible for marketing, and the suppressed, unsubscribed or risky remainder. For a required notice everyone not suppressed or risky is eligible and unsubscribed is 0. Read-only; sending freezes its own snapshot and rechecks consent at dispatch.').openapi('CampaignAudienceCounts');

export const CampaignUpdate = z.object({ revision: z.number().int().positive(), draft: z.object({ ...CampaignInput.shape, region: Region.optional().describe('Omit to keep the current region selection. An unpinned regional MX draft follows its From domain.') }).strict() }).strict().openapi('CampaignUpdateInput');
export const CampaignArchive = z.object({ archived: z.boolean() }).strict().openapi('CampaignArchiveInput');
export const CampaignContentGuide = z.object({ format: z.literal('markdown'), markdown: z.string() }).openapi('CampaignContentGuide');
export const CampaignPreview = z.object({ html: z.string().describe('Complete rendered email document; empty when the draft has no content.'), text: z.string() }).openapi('CampaignPreview');
export const CampaignPreviewImage = z.object({ data: z.string().describe('Canonical base64 PNG screenshot.'), mimeType: z.literal('image/png') }).openapi('CampaignPreviewImage');
export const Pacing = z.object({ perDay: z.number().int().min(100).max(10000000).nullable().optional().describe('Release at most this many recipients per rolling 24-hour window. Omit or null for no daily cap. Delivery always also respects the SES 24-hour quota.'), autoPause: z.boolean().default(true).describe('Pause automatically if the bounce rate exceeds 2% (after 1,000 accepted) or the complaint rate exceeds 0.08% (after 5,000 accepted). Hosted shared sending requires true; false is rejected.'),
  rateShare: z.number().min(0.05).max(1).optional().describe('Maximum fraction of the SES per-second send rate this campaign may use; the rest stays free for transactional mail and other campaigns. Defaults to 0.5 for paced campaigns; campaigns sent without pacing use the full rate.'),
  plan: z.literal('recommended').optional().describe('Send in the daily batches previewCampaignAudience recommends (readiness.plan), worked out again at launch: the most engaged contacts first, never-mailed last. Not with perDay.') }).strict()
  .refine(v => !(v.plan && v.perDay != null), { message: 'Choose the recommended plan or a daily limit, not both.', path: ['perDay'] }).openapi('CampaignPacing');
export const ConsentConfirmation = z.object({ confirmed: z.literal(true), source: z.string().trim().min(RAMP.consent.minLength).max(RAMP.consent.maxLength).describe('Where this list\'s consent comes from, for example "Signed up at checkout on our site since 2023".') }).strict()
  .describe('The sender confirms everyone on the list agreed to this mail, and where that consent comes from. Lets a send the review requires a ramp for (readiness.verdict ramp_required) go out without the plan. Stored with the campaign, with who and when, and in the workspace\'s Activity. An agent asks the person first.').openapi('CampaignConsentConfirmation');
export const CampaignSend = z.object({ revision: z.number().int().positive(), pacing: Pacing.optional(), consent: ConsentConfirmation.optional(),
  confirmRequiredNotice: z.literal(true).optional().describe('Required for a required notice (422 REQUIRED_NOTICE_UNCONFIRMED without it): the sender confirms it is a required notice with no promotion. Recorded with who and when. An agent asks the person first.') }).strict().openapi('CampaignSendInput');
export const CampaignSchedule = z.object({ ...CampaignSend.shape, scheduledAt: z.string().datetime({ offset: true }) }).strict().openapi('CampaignScheduleInput');
export const CampaignQueued = z.object({ id: z.string(), state: z.literal('preparing'), queued: z.number().int().describe('Recipients expected (exact for lists up to 5,000 members and unsegmented lists once list counts are enabled; may be 0 if an uncounted large list exceeds the 200 ms launch budget without a prior preview); delivery.total is authoritative once the audience is frozen.'), scheduledAt: z.string().nullable(), simulated: z.boolean(),
  risky: RiskBreakdown.nullable().default(null).describe('Recipients the send skips as risky contacts, by reason: exact when queued is; null when a large audience could not be counted at launch.'),
  readiness: CampaignReadiness.nullable().default(null).describe('The send review as of the launch (list.neverMailed is not counted then); null for a required notice.') }).openapi('CampaignQueued');
export const CampaignCanceled = z.object({ id: z.string(), state: z.literal('canceled'), canceled: z.number().int(), inFlight: z.number().int() }).openapi('CampaignCanceled');
export const TestCampaign = z.object({ to: Address, data: Data }).strict().openapi('CampaignTestInput');
export type SendRequest = z.infer<typeof SendInput>;
export const now = () => new Date().toISOString();
// Metadata routes must not materialize HTML, raw MIME or template data from the immutable snapshot.
// Only the campaign relation or an explicit snapshot value proves this was not a reply.
export const sentUntrustedContent = sql<boolean>`${emails.campaignId} IS NULL AND ${emails.snapshot}->'untrustedContent' IS DISTINCT FROM 'false'::jsonb`;
// Per-statement limits of the reads a dashboard repeats (budgetedRead): a list walk or aggregate gets 5 seconds; the
// campaign detail's status counts, polled every few seconds while it sends and read through one campaign's index, get 3.
export const READ_LIMIT = { emails: 5, campaign: 3, campaignStats: 5 } as const;
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
export function domainAttachmentAccess(uploader: SQL, domains: readonly string[] | SQL) {
  return sql`(sending_attachments.uploaded_by = ${uploader} OR EXISTS (
    SELECT FROM sending_attachment_links l JOIN sending_emails ON sending_emails.workspace_id=l.workspace_id AND sending_emails.id=l.owner_id
    WHERE l.workspace_id=sending_attachments.workspace_id AND l.attachment_id=sending_attachments.id AND l.owner_type='email'
    AND ${directDelivery} AND NOT ${mailboxMail} AND ${senderDomainWhere(sql`sending_emails.from_address`, domains)}))`;
}
// An upload belongs to the workspace, so any sender may attach it. One that has gone out only in conversation mail is
// conversation content: a credential without mailbox access reads or reuses it when it uploaded it, or when it is also
// attached to something that credential can read (ordinary mail, a campaign or a review).
export function sharedAttachmentAccess(uploader: SQL) {
  const links = sql`sending_attachment_links l WHERE l.workspace_id=sending_attachments.workspace_id AND l.attachment_id=sending_attachments.id`;
  const email = (mailbox: boolean) => sql`(l.owner_type='email' AND EXISTS (SELECT FROM sending_emails WHERE sending_emails.workspace_id=l.workspace_id AND sending_emails.id=l.owner_id AND ${mailbox ? mailboxMail : sql`NOT ${mailboxMail}`}))`;
  return sql`(sending_attachments.uploaded_by = ${uploader}
    OR NOT EXISTS (SELECT FROM ${links} AND (l.owner_type='mailbox' OR ${email(true)}))
    OR EXISTS (SELECT FROM ${links} AND (l.owner_type IN ('campaign','review') OR ${email(false)})))`;
}
// `conversation`: the mail is sent from a mailbox, whose own rules admitted the sender and its attachments.
export function scopedAttachment(a: Actor, conversation = false) {
  const uploader = sql`${a.tokenId ?? a.keyId}`;
  return a.domains.length ? domainAttachmentAccess(uploader, a.domains) : conversation || actorMailAccess(a) ? undefined : sharedAttachmentAccess(uploader);
}
export const campaignWhere = (a: Actor, campaignId?: string) => and(scope(campaigns, a), campaignId === undefined ? undefined : eq(campaigns.id, campaignId), senderDomainWhere(sql`${campaigns.draft}->>'from'`, a.domains),
  a.domains.length ? and(eq(campaigns.state, 'draft'), isNull(campaigns.reviewId), sql`${campaigns.draft}->'audience' = '{}'::jsonb`) : undefined);
function keySender(a: Actor, from: string) {
  const domain = from.split('@')[1]!.toLowerCase();
  if (!senderDomainAllowed(a.domains, domain)) throw denied('SENDER_DOMAIN_FORBIDDEN', 'This API key cannot send from this domain or its parent domain.', { permission: 'sendEmail', level: 'on', scope: `domain:${domain}` }, 'from');
}
export function draftSender(runtime: Runtime, a: Actor, draft: CampaignDraft) {
  if (!regionalSending(runtime)) region(runtime, draft.region);
  if (!draft.from && a.domains.length) throw denied('SENDER_DOMAIN_FORBIDDEN', 'A domain-restricted key must supply a From address on one of its domains.', { permission: 'sendEmail', level: 'on', scope: 'workspace' }, 'from');
  if (draft.from) keySender(a, draft.from);
  if (a.domains.length && Object.keys(draft.audience).length) throw unrestrictedRequired(a, 'Choosing a campaign audience needs', { permission: 'audience', level: 'write' });
}
// A draft's audience names only this workspace's lists and segments. Another workspace's ID gets the answer of one that
// doesn't exist, the answer the audience gives when it is read (audience/segments.ts audienceConditions), so an ID can't be probed.
// IDs the stored draft already names pass unchecked: a draft outlives a deleted list and must stay editable.
export async function draftAudience(db: DbExecutor, a: Actor, audience: CampaignDraft['audience'], stored: CampaignDraft['audience'] = {}) {
  const added = (now: (string | undefined)[], before: (string | undefined)[]) => [...new Set(now.filter((id): id is string => id !== undefined && !before.includes(id)))];
  const listIds = added([audience.listId, ...(audience.excludeListIds ?? [])], [stored.listId, ...(stored.excludeListIds ?? [])]);
  const segmentIds = added([audience.segmentId, ...(audience.excludeSegmentIds ?? [])], [stored.segmentId, ...(stored.excludeSegmentIds ?? [])]);
  if (listIds.length && (await db.select({ id: lists.id }).from(lists).where(and(scope(lists, a), inArray(lists.id, listIds)))).length !== listIds.length) notFound('List');
  if (segmentIds.length && (await db.select({ id: segments.id }).from(segments).where(and(scope(segments, a), inArray(segments.id, segmentIds)))).length !== segmentIds.length) notFound('Segment');
}
export async function draftRegion(runtime:Runtime,db:DbExecutor,a:Actor,input:{from:string;region?:string;regionPinned?:boolean},previous?:CampaignDraft) {
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
export const campaignSendRegion=(runtime:Runtime,draft:CampaignDraft)=>regionalSending(runtime) && draft.regionPinned===false ? undefined : draft.region;
export function readyCampaign(draft: CampaignDraft) {
  const parsed = CampaignReady.safeParse(draft);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))];
    throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', `Complete these campaign fields before review: ${fields.join(', ')}.`, fields.join(', '));
  }
  return parsed.data;
}
export const keyed = (c: Ctx, a: Actor) => ({ ...idempotentRequest(c), workspaceId: a.workspaceId, actorKeyId: a.keyId });
// A replay is a read, too. A draft can have changed sender since the receipt was saved, and a temporary token may
// share its parent grant's receipt with a narrower domain scope.
export const campaignReplay = (a: Actor, campaignId?: string) => async (db: DbExecutor, receipt: { id?: unknown; draft?: CampaignDraft }) => {
  if (!a.domains.length) return;
  if (receipt.draft && (Object.keys(receipt.draft.audience).length || !senderDomainAllowed(a.domains, receipt.draft.from.split('@')[1] ?? ''))) notFound('Campaign');
  const [visible] = await db.select({ id: campaigns.id }).from(campaigns).where(campaignWhere(a, campaignId ?? String(receipt.id)));
  if (!visible) notFound('Campaign');
};
export async function findEmail(db: DbExecutor, a: Actor, emailId: string) {
  const [row] = await db.select({ ...getTableColumns(emails), untrustedContent: sentUntrustedContent }).from(emails).where(mailWhere(a, emailId));
  if (!row) notFound('Email');
  return row;
}
// Every reader, whatever its permissions, gets an event's data without the content screen's verdict.
export function visibleEmailEvent(a: Actor, row: z.input<typeof Event>) {
  return Event.parse({ ...row, data: withoutVerdict(a.permissions.includes('manage') ? row.data : redactCapabilityData(row.data)) });
}
export async function findCampaign(db: DbExecutor, a: Actor, campaignId: string, lock: boolean | 'share' = false) {
  const query = db.select().from(campaigns).where(campaignWhere(a, campaignId));
  const [row] = await (lock ? query.for(lock === 'share' ? 'share' : 'update') : query);
  if (!row) notFound('Campaign');
  return row;
}
// Paced delivery controls. Pausing stops releasing new recipients; mail already queued (a few seconds of
// the send rate) still dispatches. Resume continues from the same frozen position.
export type CampaignChange = (db: DbExecutor, a: Actor, campaign: typeof campaigns.$inferSelect) => Promise<void>;
export const sendingOnly = (campaign: typeof campaigns.$inferSelect) => { if (!(CAMPAIGN_ACTIVE as readonly string[]).includes(campaign.state) && !campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a preparing, scheduled, sending or paused campaign can be paused, resumed or paced.'); };
/** A delivery control in the caller's transaction: the campaign locked, its sender and state checked, then changed. */
export async function controlCampaign(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, change: CampaignChange, allowed = sendingOnly) {
  const campaign = await findCampaign(db, a, campaignId, true); draftSender(runtime, a, campaign.draft);
  allowed(campaign);
  await change(db, a, campaign);
}
export const pausing = (audit: AuditContext | Ctx): CampaignChange => async (db, a, campaign) => {
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
export const sharedConnection = (wid: string) => sql`EXISTS (SELECT 1 FROM provider_connections WHERE workspace_id=${wid} AND kind='shared')`;
// Bump when interpolation, preheader or footer output changes, and keep the previous renderer for older reviews.
export const CAMPAIGN_RENDERER_VERSION = 2;
/** The unsubscribe link a campaign copy is screened with: the one part of a copy Nightmail generates per recipient. */
export const unsubscribePlaceholder = (origin: string) => `${origin.replace(/\/$/, '')}/unsubscribe/u_${'0'.repeat(64)}`;
