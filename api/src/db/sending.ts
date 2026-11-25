import { sql } from 'drizzle-orm';
import type { CampaignState } from '../states.js';
import type { SendingBinding } from '../domain-claims.js';
import type { CampaignScreen } from '../screen.js';
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** scheduled: a single send waiting for its time (admitted again then); the API shows it as queued with scheduled true. */
export type EmailStatus = 'scheduled' | 'queued' | 'attempting' | 'accepted' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'rejected' | 'rendering_failed' | 'delayed' | 'suppressed' | 'canceled' | 'acceptance_unknown' | 'simulated';
export type CampaignEditor = { format: 'react-email'; version: 1; document: Record<string, unknown> };
export type EmailSnapshot = {
  /** Null: known non-test send. A campaign ID: test of that campaign. Missing: legacy/unknown. */
  testCampaignId?: string | null;
  binding?: SendingBinding;
  from: string; fromName?: string; previewText?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; region: string;
  kind: 'transactional' | 'marketing'; subject: string; html?: string; text?: string;
  attachments: string[]; tracking: boolean; raw?: string;
  /** A mail app's signed or encrypted submission, sent as these bytes (Raw content); subject, html and text are what
   *  it shows, for the screen and the log. */
  mime?: string;
  template?: { name: string; data: Record<string, unknown>; source: { Subject?: string; Html?: string; Text?: string }; render: 'ses' | 'simulated' };
  headers: { Name: string; Value: string }[];
  deferredCampaign?: boolean;
  /** A scheduled send's own region request; without it, its release takes the sender's region at that time. */
  requestedRegion?: string;
  /** Server-side bulk evidence on a message its caller labelled transactional (hosted-sending.ts bulkFlags): held like marketing. */
  bulk?: true;
  /** Present only on mailbox replies; recipients who actually wrote to this mailbox in this thread. */
  replyAuthors?: string[];
  /** Immutable content provenance. Missing on legacy snapshots; never infer trust from missing mailbox history. */
  untrustedContent?: boolean;
  /** Live transactional only: ask the outbound content classifier before accepting into the queue. */
  screen?: boolean;
  /** Content-screen verdict recorded at accept time so the dispatcher never re-screens queued mail. 'platform': the
   *  dashboard's test email, whose words are fixed by us and which goes only to the signed-in person (sending.ts
   *  platformTestVerdict); reason says so. */
  screenVerdict?: { status: 'passed' | 'skipped' | 'platform'; reason?: 'platform test email'; spam?: number; model?: string; digest?: string; rules?: 'probation' | 'standard' | null };
  /** Sent campaign emails keep only their unsubscribe URL; the body is re-rendered from the frozen review on read. */
  unsubscribeUrl?: string;
  /** A sent required notice's email, which has no unsubscribe URL to keep: its body is re-rendered the same way. */
  requiredNotice?: true;
  /** A campaign copy or campaign test: the origin of its links (src/link-domains.ts), where its inline pictures are linked
   *  from (src/linked-images.ts). None: its pictures stay attached. */
  linkOrigin?: string;
  /** Nightmail-authored notice with a recipient-only capability; reads withhold it. */
  sealed?: boolean;
  /** Sent from a receiving address or inbox: a reply, a new conversation, a forward or a mail-client submission. Reading it needs mailbox access. */
  mailbox?: boolean;
  /** An ordinary send whose In-Reply-To names a stored message its sender could read: that message's thread (thread-view.ts joinReplies). */
  threadId?: string;
};
export type CampaignDraft = {
  regionPinned?: boolean;
  /** Only stored in the internal, immutable launch review. */
  binding?: SendingBinding;
  /** Only stored in the launch review: the workspace's postal address its footer shows. A review from before postal
   *  addresses has none until the campaign starts sending (src/sending.ts frozenPostalAddress). */
  postalAddress?: string;
  /** Only stored in the launch review: the origin of the links Nightmail adds to its copies (src/link-domains.ts). A
   *  review on the link domain (or from before link hosts) has none: each copy asks when it is made. */
  linkOrigin?: string;
  name: string; from: string; fromName?: string; previewText?: string; replyTo?: string[]; region: string; subject: string; html?: string;
  attachments: string[]; tracking: boolean; unsubscribePageUrl?: string;
  /** A required notice (src/sending.ts): to everyone in the audience but the suppressed, without an unsubscribe link. */
  requiredNotice?: boolean;
  audience: { listId?: string; segmentId?: string; excludeListIds?: string[]; excludeSegmentIds?: string[] };
  defaults: Record<string, string | number | boolean | null>;
};
export type ReviewedRecipient = { id: string; email: string; name?: string; properties: Record<string, unknown> };
const scope = () => ({ workspaceId: text('workspace_id').notNull() });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const emails = pgTable('sending_emails', {
  id: text('id').primaryKey(), ...scope(), region: text('region').notNull(), actorKeyId: text('actor_key_id').notNull(),
  reviewId: text('review_id'), reviewOrdinal: integer('review_ordinal'),
  campaignId: text('campaign_id'), from: text('from_address').notNull(), to: jsonb('to_addresses').$type<string[]>().notNull(), cc: jsonb('cc_addresses').$type<string[]>().notNull(), bcc: jsonb('bcc_addresses').$type<string[]>().notNull(),
  subject: text('subject').notNull(), status: text('status').$type<EmailStatus>().notNull().default('queued'), providerId: text('provider_id'),
  snapshot: jsonb('snapshot').$type<EmailSnapshot>().notNull(), simulated: boolean('simulated').notNull(), screened: boolean('screened').notNull().default(true),
  attemptStartedAt: time('attempt_started_at'), errorCode: text('error_code'), suppressionReason: text('suppression_reason'), scheduledAt: time('scheduled_at'), dispatchVersion: integer('dispatch_version').notNull().default(0),
  leaseUntil: time('lease_until'), accountPauseStartedAt: time('account_pause_started_at'),
  // Union of public event outcomes as bit flags (migration 031 trigger); see OUTCOME in operations.ts.
  eventOutcomes: smallint('event_outcomes').notNull().default(0),
  createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
  // The table has fillfactor 85 (migration 385), so later versions of a row fit on its page and stay HOT.
}, t => [index('sending_emails_created_page').on(t.workspaceId, t.createdAt.desc(), t.id.desc()), index('sending_emails_kind_created').on(t.workspaceId, sql`(${t.snapshot}->>'kind')`, t.createdAt), index('sending_emails_campaign_status').on(t.workspaceId, t.campaignId, t.status), uniqueIndex('sending_emails_provider').on(t.workspaceId, t.region, t.providerId), uniqueIndex('sending_emails_review_ordinal').on(t.reviewId, t.reviewOrdinal).where(sql`${t.reviewId} IS NOT NULL`)]);
export const emailEvents = pgTable('sending_email_events', {
  id: text('id').primaryKey(), ...scope(), emailId: text('email_id').notNull(), type: text('type').notNull(), providerId: text('provider_id'),
  externalId: text('external_id'), data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}), simulated: boolean('simulated').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, t => [index('sending_events_page').on(t.workspaceId, t.emailId, t.id), uniqueIndex('sending_events_external').on(t.workspaceId, t.externalId), index('sending_email_events_retention').on(t.workspaceId, t.createdAt)]);
export const attachments = pgTable('sending_attachments', {
  uploadedBy: text('uploaded_by'),
  id: text('id').primaryKey(), ...scope(), filename: text('filename').notNull(), contentType: text('content_type').notNull(), size: integer('size').notNull(),
  disposition: text('disposition').$type<'attachment' | 'inline'>().notNull(), contentId: text('content_id'), storageKey: text('storage_key').notNull(), checksum: text('checksum').notNull(), sourceTemplateAssetId: text('source_template_asset_id'),
  createdAt: time('created_at').notNull().defaultNow(),
}, t => [index('sending_attachments_page').on(t.workspaceId, t.id)]);
export const attachmentLinks = pgTable('sending_attachment_links', {
  ...scope(), attachmentId: text('attachment_id').notNull().references(() => attachments.id), ownerType: text('owner_type').$type<'email' | 'campaign' | 'review'|'mailbox'>().notNull(), ownerId: text('owner_id').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.attachmentId, t.ownerType, t.ownerId] }), index('sending_attachment_owner').on(t.workspaceId, t.ownerType, t.ownerId)]);
export type CampaignFailure = { code: string; message: string };
/** One (status, simulated) group of a campaign's emails with its outcome counts, as GET /v1/campaigns/{id}/stats counts them. */
export type CampaignStatsGroup = { status: EmailStatus; simulated: boolean; count: number; accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number };
/**
 * A campaign's counted outcomes for one review (src/sending.ts campaignStatsJob). computedAt: when the count started (it
 * includes every change made before then); revision: the workspace's mail revision then (dashboard-cache.ts mailRevision);
 * emails: how many it counted; frozen: a later count found fewer, so the 30-day retention has begun and these stay.
 */
export type StoredCampaignStats = { reviewId: string; computedAt: string; revision: string; emails: number; groups: CampaignStatsGroup[]; frozen?: boolean };
// One state (src/states.ts) plus the delivery cursors and settings of the current launch; `review_id` is the frozen
// snapshot that launch took (sending_campaign_reviews + sending_review_recipients), and NULL for an unlaunched draft.
export const campaigns = pgTable('sending_campaigns', {
  id: text('id').primaryKey(), ...scope(), revision: integer('revision').notNull().default(1), draft: jsonb('draft').$type<CampaignDraft>().notNull(),
  sourceTemplateId: text('source_template_id'), sourceTemplateRevision: integer('source_template_revision'),
  state: text('state').$type<CampaignState>().notNull().default('draft'), reviewId: text('review_id'), scheduledAt: time('scheduled_at'), archivedAt: time('archived_at'),
  actorKeyId: text('actor_key_id'), simulated: boolean('simulated').notNull().default(false), requestId: text('request_id'),
  total: integer('total').notNull().default(0), prepared: integer('prepared').notNull().default(0), expanded: integer('expanded').notNull().default(0), canceled: integer('canceled').notNull().default(0),
  error: jsonb('error').$type<CampaignFailure>(),
  // Paced delivery: optional cap per rolling 24-hour window, share of the send rate, pause and why releasing waits.
  pacePerDay: integer('pace_per_day'), autoPause: boolean('auto_pause').notNull().default(true), rateShare: doublePrecision('rate_share'),
  windowStartedAt: time('window_started_at'), windowExpanded: integer('window_expanded').notNull().default(0),
  pausedAt: time('paused_at'), pauseReason: jsonb('pause_reason').$type<CampaignFailure>(), healthCheckedAt: time('health_checked_at'),
  waitingReason: text('waiting_reason').$type<'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota' | 'list_probe' | 'balance' | 'feedback_lag' | 'ramp'>(), waitingUntil: time('waiting_until'),
  // Hosted list probe (migration 231): when release may continue after the probe, when it was cleared, and how many quarantines this launch had.
  probeWaitUntil: time('probe_wait_until'), probeClearedAt: time('probe_cleared_at'), quarantines: smallint('quarantines').notNull().default(0),
  // When a sender in good standing skipped the probe (migration 357): kept apart from a probe that went out and passed.
  probeSkippedAt: time('probe_skipped_at'),
  // After an owner resumed a failed list probe: the rest is released only to contacts the workspace delivered to before.
  deliveredOnly: boolean('delivered_only').notNull().default(false),
  // The last background count of its outcomes (migration 391).
  stats: jsonb('stats').$type<StoredCampaignStats>(),
  createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
  // draft.audience.listId, written by a trigger on every write of draft (migration 394): filters by list never read a draft.
  listId: text('list_id'),
  // Last eligible count returned by previewCampaignAudience (migration 429): fallback for CampaignQueued.queued on large deferred launches.
  audienceEstimate: integer('audience_estimate'),
  // The ramp (migration 500, src/standing-model.ts RAMP): the step (an index into RAMP.steps; their count is past the last
  // step), when its current hour started (null before its first release) and the review ordinal it started at.
  rampStep: smallint('ramp_step'), rampWindowStartedAt: time('ramp_window_started_at'), rampFrom: integer('ramp_from').notNull().default(0),
  // Send readiness (migration 500): the recommended plan's daily batches it was launched with, which 24-hour window it is
  // in (from 0), the largest daily cap that counts as a ramp when one was required (null: none was), and the consent
  // source its sender confirmed.
  pacePlan: integer('pace_plan').array(), windowIndex: integer('window_index').notNull().default(0), rampRequiredCap: integer('ramp_required_cap'),
  consent: jsonb('consent').$type<{ source: string; confirmedBy: string | null; confirmedAt: string }>(),
}, t => [index('sending_campaigns_page').on(t.workspaceId, t.id), index('sending_campaigns_created_page').on(t.workspaceId, t.createdAt.desc(), t.id.desc()), index('sending_campaigns_archive_page').on(t.workspaceId, t.archivedAt, t.createdAt.desc(), t.id.desc()),
  index('sending_campaigns_list_page').on(t.workspaceId, t.listId, t.createdAt.desc(), t.id.desc()).where(sql`${t.listId} IS NOT NULL`)]);
// The frozen snapshot a launch sends from: the draft and rendered base every recipient is interpolated into, and the
// recipient list (sending_review_recipients). It has no status; the campaign's state and cursors describe its use.
export const campaignReviews = pgTable('sending_campaign_reviews', {
  id: text('id').primaryKey(), ...scope(), campaignId: text('campaign_id').notNull(), revision: integer('revision').notNull(), draft: jsonb('draft').$type<CampaignDraft>().notNull(),
  contentHash: text('content_hash').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  // Version of the per-recipient renderer (interpolation, preheader, footer) that must reproduce this review's emails.
  rendererVersion: integer('renderer_version').notNull().default(1),
  rendered: jsonb('rendered').$type<{ html?: string; text?: string }>(),
  // Hosted screening state and its classifier budget, charged before each request (migration 312, src/sending.ts campaignVerdicts).
  screen: jsonb('screen').$type<CampaignScreen>(), screenBudget: integer('screen_budget'), screenCharged: integer('screen_charged').notNull().default(0),
  // Background audience freeze completion (migration 429): NULL while capture is pending/in progress; non-NULL once all
  // recipients are frozen in one REPEATABLE READ snapshot. staticPrepared records whether static content_hash rows were stamped inline.
  capturedAt: time('captured_at').defaultNow(), capturedCount: integer('captured_count'), staticPrepared: boolean('static_prepared').notNull().default(false),
}, t => [index('sending_review_campaign').on(t.workspaceId, t.campaignId)]);
// One verdict per campaign and copy as delivered (src/screen.ts copyKey), shared by every recipient whose copy is the same.
export const campaignScreens = pgTable('sending_campaign_screens', {
  campaignId: text('campaign_id').notNull(), ...scope(), copyHash: text('copy_hash').notNull(), requests: integer('requests').notNull(), windows: integer('windows').notNull().default(0),
  spam: doublePrecision('spam').notNull().default(0), model: text('model'), threshold: doublePrecision('threshold'), createdAt: time('created_at').notNull().defaultNow(), judgedAt: time('judged_at'),
}, t => [primaryKey({ columns: [t.campaignId, t.copyHash] })]);
// Recipient values are copied once from one database snapshot; no live contact joins during preparation or expansion.
export const reviewRecipients = pgTable('sending_review_recipients', {
  // No foreign key (migration 026): a statement-level trigger on reviews cascades deletes without a per-row insert check.
  reviewId: text('review_id').notNull(),
  ordinal: integer('ordinal').notNull(), recipient: jsonb('recipient').$type<ReviewedRecipient>().notNull(),
  recipientBytes: integer('recipient_bytes').notNull(), contentHash: text('content_hash'), subject: text('subject'), snapshotBytes: integer('snapshot_bytes'), screenRejected: boolean('screen_rejected').notNull().default(false),
}, t => [primaryKey({ columns: [t.reviewId, t.ordinal] })]);
export const regionalLimits = pgTable('sending_region_limits', {
  ...scope(), region: text('region').notNull(), maxSendRate: doublePrecision('max_send_rate').notNull().default(0), max24HourSend: doublePrecision('max_24_hour_send').notNull().default(0), sentLast24Hours: doublePrecision('sent_last_24_hours').notNull().default(0), reserved: integer('reserved').notNull().default(0),
  checkedAt: time('checked_at'), nextAllowedAt: time('next_allowed_at'),
}, t => [primaryKey({ columns: [t.workspaceId, t.region] })]);
export const sendingIdempotency = pgTable('sending_idempotency', {
  ...scope(), actorKeyId: text('actor_key_id').notNull(), path: text('path').notNull(), requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(), createdAt: time('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.actorKeyId, t.path, t.requestKey] })]);
