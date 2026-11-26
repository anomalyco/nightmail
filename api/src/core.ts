import { HTTPException } from 'hono/http-exception';
import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { sql, type SQL } from 'drizzle-orm';
import { errorCodeOf, errorTypeOf, log, logFallback, stackFrames } from './log.js';
import type { ReadyConnection } from './provider-credentials.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { clientIpHeader, productName } from './brand.js';
import { addSesBodySplice } from './ses-body.js';

export type Database = NodePgDatabase;
export const SuppressionReason = z.string().describe('Reason recorded when this send was suppressed. For a multi-recipient send blocked locally, this is the first blocked recipient in To, Cc, Bcc order.');
export const SuppressionEventData = z.object({suppressionReason:SuppressionReason.optional()}).catchall(z.unknown());
/** An email event's data as anything outside Nightmail's own records gets it: without the content screen's verdict on a
 *  refused email (its score, the classifier's model, the threshold). A sender learns that the content check refused it
 *  (code CONTENT_REJECTED_SPAM), never how close it was or what judged it. The verdict stays in Nightmail's own record,
 *  the stored reject event's data.screen (sending_email_events), which only the operator timeline reads for staff. It is
 *  removed wherever that data leaves: where the published event and each webhook payload are built from the stored
 *  event (withoutVerdictSql, in terminalEvents), and on every read of an event's data for a caller and every webhook
 *  post (this function), which also covers published events and payloads stored before either was in place. */
export function withoutVerdict<T extends Record<string, unknown>>(data: T): T {
  if (!data || typeof data !== 'object' || !('screen' in data)) return data;
  const { screen: _verdict, ...rest } = data;
  return rest as T;
}
/** withoutVerdict inside a statement: a stored event's data (jsonb) as it is copied into a published event. */
export const withoutVerdictSql = (data: SQL) => sql`(${data}-'screen'::text)`;
/** An email event's data, in the email's events and in its webhook: with what SES reported about a bounce or a delay.
 *  The reply is the one text here that a third party writes: the webhook's copy has no addresses (webhookData, sending.ts). */
export const EmailEventData = z.object({suppressionReason:SuppressionReason.optional(),
  diagnosticCode:z.string().optional().describe('A bounce or a delay: the receiving server\u2019s reply as SES reported it, such as "smtp; 550 5.1.1 user unknown". Written by the receiving server: untrusted text, to read as data, that can hold the recipient\u2019s address, host names and IP addresses. On the email\u2019s own events (getEmailDetail, listEmailEvents) it is up to 500 characters, as one line without control or invisible characters. In a webhook payload and the webhook delivery log, the addresses and IP addresses in it are replaced by pattern (<address>, <ip>) and it is up to 160 characters. For several recipients, the first that has one. Absent when SES reported none, for a bounce SES generated itself (its suppression list, its address validation), and on events stored before this field.'),
  delayType:z.string().optional().describe('A delay: SES\u2019s reason, such as MailboxFull, SpamDetected, RecipientServerError, TransientCommunicationFailure, IPFailure or General.'),
  expirationTime:z.string().optional().describe('A delay: when SES stops retrying the delivery (UTC).')}).catchall(z.unknown())
  .describe('What the event recorded. An email the content screen refused says so in code (CONTENT_REJECTED_SPAM) and nothing more: the screen\u2019s score, its model and its threshold are never part of an event or a webhook payload.');
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Permission = 'read' | 'send' | 'manage';
export interface Actor {
  workspaceId: string; permissions: Permission[]; domains: string[]; keyId: string; credential?: 'dashboard' | 'apiKey' | 'mcp' | 'agentToken' | 'operatorService' | 'support' | 'uiNotesKey'; email?: string; name?: string;
  /**
   * The person behind a credential that is not a session: whose MCP approval this is (for the approval itself, its
   * agent tokens and the keys it created), or the operator who made a UI notes key (src/ui-notes.ts).
   */
  userId?: string;
  /** A dashboard session's sign-in proved hosted staff (a Google Workspace sign-in, account-policy.ts). Staff tools need it. */
  staff?: boolean;
  role?: string; receivingConsent?:boolean; grantId?:string; tokenId?:string;
  /** An API key an agent received through agent setup (agent-setup.ts): it never administers keys or reaches billing
   *  (keyAdminRefusal, agentSetupRefusal). */
  agentSetup?: boolean;
  // Number of emails queued per region, for a bounded post-commit wake.
  dispatchTargets?: Map<string, { count: number; priority: boolean }>;
  dispatchAccount?: { aws_account_id: string; kind: ReadyConnection['kind']; maxSendRate?: number };
  // Orchestration jobs this request committed that must not wait for a coalesced wake (campaign launches).
  wakeJobs?: number;
  wakeJobPool?: 'webhook';
}
export interface Storage {
  // Identity for reusable immutable bytes only, never pending request-bound I/O.
  readonly cacheScope?: object;
  /**
   * `signal` cancels an S3 put; an R2 binding put cannot be cancelled once it starts (an already
   * aborted signal still stops it). No backend bounds when a put can land, so the hourly cleanup
   * reconciles storage against its records instead (maintenance.ts).
   */
  put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Atomic creation (used for the shared, disposable daily analytics salt). */
  createIfAbsent?(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** The object's body as a stream from the bucket, for responses that should not buffer it (preview links). */
  stream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Up to 1,000 objects in key order after `after`; `cursor` continues the listing and is absent at its end. */
  list?(prefix: string, after?: string): Promise<{ objects: { key: string; uploaded: Date }[]; cursor?: string }>;
}
export type ScreenClassifier = 'jevf' | 'jev';
export type ScreenModel = { apiKey: string; endpoint: string; model: string; threshold: number };
type JevFModel = ScreenModel & { deadlineMs: number; maxConcurrency: number };
export interface Config {
  /** Requests per minute per credential. */
  apiRateLimitPerMinute: number;
  workspaceId: string;
  authSecret: string;
  mailGatewayToken?:string;
  /** The mail gateway's IMAP and SMTP hosts for mail clients (MAILGW_PUBLIC_DOMAIN); set only while the gateway is. */
  mailServers?: { imap: string; smtp: string };
  previousAuthSecret?: string;
  accountIssuer?: string;
  /** The OAuth scope names the MCP server asks for (config OAUTH_SCOPE_PREFIX); tokens with any accepted prefix work. */
  oauthScopePrefix?: 'bane' | 'nightmail';
  /** Earlier origins still served (PREVIOUS_PUBLIC_URLS): their /mcp resource stays valid for tokens minted there. */
  previousOrigins?: string[];
  /** The stack and role name prefix a new BYO connection gets (BYO_STACK_PREFIX). */
  byoStackPrefix?: 'Bane' | 'Nightmail';
  accountClient?: { id: string; privateKey: string; algorithm: 'RS256' | 'ES256' };
  /** The `acr` values accepted on ID tokens and on every MCP access token, one of which each must carry. Hosted
   * installations accept only the account service's sign-in methods (GitHub, Google and email). */
  accountRequiredAcr?: string[];
  /** Self-hosted access policy: exact issuer subjects. Identity is (issuer, subject); addresses never admit anyone. */
  allowedSubjects: string[];
  /** Hosted staff: Google Workspace domains of the sign-in's provider identity (see account-policy.ts). */
  staffGoogleDomains: string[];
  /** Hosted: the issuer subjects allowed to use staff UI notes (src/ui-notes.ts); empty turns the feature off. */
  uiNotesSubjects?: { issuer: string; subject: string }[];
  /** Dashboard usage analytics (src/analytics.ts, DASHBOARD_ANALYTICS=on): off unless set. */
  dashboardAnalytics?: boolean;
  /** Hosted: email a domain's owners once when it is still pending an hour after it was added (src/domain-setup.ts, DOMAIN_SETUP_REMINDER=on). Off unless set. */
  /** Hosted: one NS lookup when a domain is added (createDomain, record-check.ts dnsZone). DOMAIN_NS_CHECK=off turns it off. */
  domainNsCheck?: boolean;
  domainSetupReminder?: boolean;
  /** Hosted: email a new workspace's owners once when it has no domain an hour after sign-up (src/domain-setup.ts, NO_DOMAIN_REMINDER=on). Off unless set. */
  noDomainReminder?: boolean;
  analyticsPush?: { url: string; secret: string };
  /** Self-hosted: subjects (or '*') that become owners of 'default' at their first sign-in. */
  defaultWorkspaceOwners: '*' | string[];
  multiTenant: boolean;
  platformAccount?: string;
  /** The one Hosted workspace that may own the installation's own domain (PUBLIC_URL's host). */
  platformDomainWorkspace?: string;
  /** Hosted only: From for Nightmail's own owner notices (sender standing), on the platform workspace's domain. */
  notifyFrom?: string;
  /** Hosted only: the parent domain of every workspace's built-in domain (src/builtin-domain.ts), and who those send to. */
  builtinDomain?: string;
  builtinScope: 'anyone' | 'members';
  /** Hosted only: the platform workspace's list of waitlist joins and sign-ups (src/signups.ts signupsList). */
  signupsListId?: string;
  /** Hosted only: the support platform's operator credential, its URL and the handoff signing key (src/support.ts). */
  support?: { url?: string; signingKey?: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string }; addressIds?: string[] };
  /** Hosted only: where support reads this Worker's request lines (Workers Logs, src/support-logs.ts). */
  observability?: { token: string; accountId: string; script: string };
  regionalSending?: boolean;
  trustedPool?: boolean;
  receivingRedrive?:boolean;
  allowSesSandbox?: boolean;
  requireDmarcForBulk?: boolean;
  hostedScreen?: boolean;
  /** NIGHTMAIL_HYGIENE_LISTS: the nightly sync of list hygiene's open lists (src/list-hygiene.ts). False: the vendored snapshot only. */
  hygieneLists?: boolean;
  /** NIGHTMAIL_HYGIENE_DNS: the DNS-over-HTTPS resolver list hygiene checks recipient domains with (src/mail-dns.ts). Null: no domain checks. */
  hygieneDnsUrl?: string | null;
  /** NIGHTMAIL_RAMP: the send review's private ramp sizing (src/ramp-lines.ts). Null: the defaults. */
  rampLines?: import('./ramp-lines.js').RampLinesOverride | null;
  /** NIGHTMAIL_ABUSE_MONITORING: abuse monitoring (src/abuse.ts) records from this instant on. Undefined: off. */
  abuseMonitoring?: { since: string };
  /** ABUSE_SLACK_WEBHOOK_URL, else OPERATOR_SLACK_WEBHOOK_URL: where abuse-monitoring alerts are posted (src/abuse-alerts.ts). Undefined: stored only. */
  abuseSlackWebhookUrl?: string;
  /** OPERATOR_SLACK_WEBHOOK_URL: where the operator alerts (src/operator-alerts.ts) and the health alerts (src/health.ts) are posted. Undefined: nothing is posted. */
  operatorSlackWebhookUrl?: string;
  /** DATABASE_DISK_GB in bytes: the Health page shows the database's size against it. Undefined: the size alone. */
  databaseDiskBytes?: number;
  /** DEPLOY_SHA and DEPLOY_AT: the commit this deploy runs and when it went out (Glass). Null when not set. */
  deploy?: { sha: string | null; at: string | null };
  /** PLANETSCALE_WEBHOOK_SECRET: the database disk alert also checks PlanetScale's signature (src/disk-alert.ts). Undefined: token alone; null: invalid configured signer, webhook disabled. */
  planetscaleWebhookSecret?: string | null;
  /** NIGHTMAIL_ABUSE_ENFORCE. Reserved: abuse monitoring never blocks, and no code reads this yet. */
  abuseEnforce?: boolean;
  /** Hosted billing. stripe is undefined until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set (money routes answer 503 BILLING_NOT_CONFIGURED). */
  billing?: { stripe?: { secretKey: string; webhookSecret: string; automaticTax: boolean; creditProduct: string; taxCode: string; apiBase: string } };
  placementShadow?: boolean;
  placementDblZone?: string;
  /** Glass's Gmail Postmaster Tools reads (NIGHTMAIL_POSTMASTER_CREDENTIALS): an OAuth grant with postmaster.readonly. */
  postmaster?: { clientId: string; clientSecret: string; refreshToken: string };
  byoTemplateUrl?: string;
  byoV2?: boolean;
  byoV5TemplateUrl?: string;
  /** BYO_EVENTS_ORIGIN: where connected accounts' SNS topics deliver. */
  byoEventsOrigin?: string;
  domainConnect?: { privateKey: import('node:crypto').KeyObject; keyId: string };
  /** Regions offered for MX shared sending; defaults to us-east-2. */
  sharedRegions?: string[];
  hostedSendCaps: { firstWeek: number };
  publicUrl: string;
  /** CAMPAIGN_IMAGES: campaign mail links its inline pictures from publicUrl/i/… instead of carrying them (src/linked-images.ts). */
  linkedImages: boolean;
  /** Hosted: the link domain the links in campaign and marketing mail go on (NIGHTMAIL_LINK_HOST, src/link-domains.ts). */
  linkHost?: string;
  /** Own link hosts (src/link-domains.ts), off unless set: the Cloudflare for SaaS zone customers' links.<domain> CNAMEs
   *  reach (`target`, a name in that zone) and the token that edits its custom hostnames. `workspaces` (Hosted,
   *  NIGHTMAIL_LINK_HOST_WORKSPACES): the only workspaces they are for, none when empty; absent (self-hosted), every one. */
  linkHosts?: { zoneId: string; token: string; target: string; workspaces?: readonly string[] };
  sesFeedbackUrl?: string;
  regions: string[];
  liveEnabled: boolean;
  simulatedSes: { latencyMs: number; maxSendRate: number; deliveryDelayMs: number };
  // Pacing target relative to the provider quota: factor (1.1 aims 10% above) and an optional absolute live rate.
  dispatch: { rateFactor: number; txReservePercent?: number; targetRate?: number; dailyHeadroomPercent: number; customerSharePercent: number };
  encryptionKey: string;
  previousEncryptionKey?: string;
  awsAccountId?: string;
  snsTopicArns: string[];
  // Subset of snsTopicArns that carries SES inbound receipt notifications for mailboxes.
  inboundTopicArns?: string[];
  reputationAlertUrl?: string;
  // Outbound harm screening. Inbound Ritual questions always use the Jev entry.
  screen?: { primary: ScreenClassifier; mode: 'reject' | 'flag'; jev: ScreenModel; jevf?: JevFModel };
  // JevF comparisons run only with Jev primary; a successful JevF gate needs no second call.
  shadow?: JevFModel;
  // Screened-text limits (src/screen.ts): one message, and one campaign screened once for all its recipients.
  screenLimits: { messageBytes: number; campaignBytes: number };
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSets: { transactional: string; marketing: string };
}
export interface RenderedImage { data: Uint8Array; mimeType: 'image/png'; }
export interface PublicImage { data: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; }
export type FeedbackItem = { region: string; topicArn: string; messageId: string; message: Record<string, unknown>; topicKind?:'byo'|'shared'; mac?: string };
export interface Runtime {
  mailR2?: { bucket: R2Bucket; name: string; write: boolean };
  db: Database; storage: Storage; config: Config;
  // Workers' public egress guards connect-time DNS; Node instead pins the checked IP in TLS.
  placementEdge?: { probesPerJob:number };
  wake?: (readyJobs?: number, immediate?: 'webhook'|'ingest') => Promise<void>;
  deferNudge?: (work: (runtime: Runtime) => Promise<void>) => void;
  /** Starts work now on a database connection of its own that outlives the request (the Worker's waitUntil), for work
   * the request starts but doesn't wait for (startHostedMail). Absent where the request's own pool outlives it (Node). */
  detach?: (work: (runtime: Runtime) => Promise<void>) => Promise<void>;
  /** Wakes inbox long polls as mail is stored (inbox-wake.ts): the DISPATCHER namespace on Workers, pg_notify on Node. */
  inboxWake?: import('./inbox-wake.js').InboxWake;
  /** Starts a sealed Logs fold on a separate worker connection. The caller never runs it on its HTTP pool. */
  startLogFacetFold?: (slot: string) => void;
  /** Coalesced off-request nudge for a workspace's incrementally certified Logs buckets. */
  startLogFacetAggregate?: (workspaceId: string) => void;
  // Nudges the long-lived dispatcher for one account/region after queued mail commits. Dispatch
  // never depends on it: the dispatcher also polls and the scheduler pings it every minute.
  dispatch?: (region: string, accountId?: string, emails?: number, kind?: ReadyConnection['kind'], priority?: boolean, maxSendRate?: number) => Promise<void>;
  /** Campaign rooms (src/campaign-room.ts): who has a campaign open in the dashboard. Cloudflare only: the Node server has
   *  none, and its dashboard shows no presence. connect answers the WebSocket upgrade. visit reports an agent's read or
   *  save (saved: the revision it made) in the background, never delaying or failing the request: nothing when nobody
   *  is in the room, and its name (lookup, given a runtime of its own) is looked up only when someone is. */
  campaignRooms?: { connect: (name: string, person: import('./campaign-room-protocol.js').RoomPerson) => Promise<Response>; visit: (name: string, credential: string, lookup: (runtime: Runtime) => Promise<string | null>, saved?: number) => void };
  /** Where the screen's requests go to be repeated to the second classifier (src/screen-shadow.ts flushShadow), on a
   *  platform that must not make those calls in the invocation that sends mail: Cloudflare puts them on a queue whose
   *  consumer makes them. Returns at once and never throws. Without it they run in this process, in the background. */
  shadow?: (items: import('./screen-shadow.js').ShadowItem[]) => void;
  // Verified provider feedback (and simulated callbacks) leave the request path through this
  // sink and are ingested in batches, never through the sending jobs table.
  feedback?: { enqueue: (items: FeedbackItem[]) => Promise<void> };
  allowFeedbackTopic?: (arn:string)=>Promise<boolean>;
  allowSnsCertMiss?: (peer: string) => Promise<boolean>;
  snsCertificateState?: import('./operations.js').SnsCertificateState; // Omitted by production: share one state per isolate, not per request.
  allowMalformedSns?: (peer: string) => Promise<boolean>;
  // A peer's failed SNS verifications across isolates (Workers: the ADMISSION limiter, weighted); false spends its budget.
  allowSnsFailure?: (peer: string) => Promise<boolean>;
  snsFailureBudget?: import('./operations.js').SnsFailureBudget; // Tests only: production shares one per isolate.
  // A workspace's preview memory a minute (Workers: the ADMISSION limiter, weighted by bytes). Node has only the per-process budget.
  allowPreview?: (workspaceId: string, bytes: number) => Promise<boolean>;
  // Dashboard analytics (src/analytics.ts): the Workers ANALYTICS bucket and the ANALYTICS_INGEST limiter. Node uses
  // the installation's bucket and a per-process cap.
  analyticsStorage?: Storage;
  analyticsPeer?: { ip: string; country?: string; bot?: boolean };
  allowAnalytics?: (peer: string) => Promise<boolean>;
  // The database disk alert (src/disk-alert.ts): the Workers DISK_ALERT limiter, one card a minute per threshold. Node has the per-process count.
  allowDiskAlert?: (key: string) => Promise<boolean>;
  jwksCacheScope?: object; // Workers create a new DB adapter per request; scope public keys to the binding instead.
  // Set only by the SupportPlatform service-binding entrypoint (src/support-platform.ts), never from a request.
  platformCaller?: 'bane-support';
  // The support conversation (conv_…) a binding request() is for, set only by that entrypoint method, never from a
  // request: supportGate derives the customer from its row (src/support-conversations.ts).
  supportConversation?: string;
  renderHtmlImage?: (html: string, grow?: (bytes: number) => void) => Promise<RenderedImage>; importPublicImage?: (url: string) => Promise<PublicImage>;
  // Outbound webhook transport. Node supplies a connect-time guard against private addresses
  // (see adapters/node.ts); Workers use plain fetch, which cannot reach them.
  webhookFetch?: WebhookFetch;
}
export type WebhookFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number;retryAfter?:string|null }>;
// mailboxIds is what the credential can see now (a provisioning key also sees the inboxes it created);
// scopeIds is an inbox key's configured scope, which never changes for that key.
export type MailboxAccess = { keyId: string; grantId?:string; workspaceId: string; admin: boolean; mailboxIds: string[] | null; scopeIds?: string[] | null; permissions: import('./db/mailbox.js').MailboxPermission[];
  /** An API key limited to sender domains, with read (domainMailAccess): it reads only mail addressed to those domains.
   *  mailboxIds are the receiving addresses there (mailboxAuth reads them), and each message must also have an envelope
   *  recipient there, or for sent mail be from there (thread-view.ts addressedToDomains). */
  domains?: string[] };
/**
 * A support conversation (src/support-conversations.ts) as supportGate loaded it: its person, the workspace whose content
 * they shared, and the workspaces this route's dashboard counterpart lets the person's role read now.
 */
export type SupportScope = { userId: string; contentWorkspaceId: string | null;
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[];
  conversation: { id: string; channel: 'chat' | 'email'; verification: string; workspaceId: string | null } };
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; boundedBody?: boolean; importLease?: import('./isolate-memory.js').MemoryLease; importLeaseTransferred?: boolean; requestId: string; serverTimings: { name: string; durationMs: number }[]; mailboxAccess?: MailboxAccess;
  /** Elapsed time asleep between long-poll reads; queries and reauthorization are active request time. */
  pollWaitMs?: number;
  /** The error code and field a failed request answered with, for its request log line. `unmatched`: no route did. */
  failure?: { code: string; field?: string; databaseCode?: string; unmatched?: boolean; origin?: { originClass: string; fetchSite?: string }; attachmentTypes?: AttachmentTypes };
  /** Who a protocol handler authenticated (MCP authenticates inside its route), for the request log line. */
  principal?: { type: string; workspace?: string }; support?: SupportScope } };
export type App = OpenAPIHono<AppEnv>;
export type Ctx = Context<AppEnv>;
/** Who sent a request: its ID, and the client's address and user agent as the entry point (server.ts, worker.ts) set them. */
export type RequestOrigin = { requestId: string; clientIp: string | null; userAgent: string | null; onPollWait?: (ms: number) => void };
// An in-process call (an MCP tool) is part of its outer request and keeps that request's ID, client and user agent.
// It rides on the runtime under a private symbol, like the delegated actor, so no header can supply it.
const outerRequest = Symbol('outerRequest');
export const withOuterRequest = <R extends Runtime>(runtime: R, origin: RequestOrigin): R => ({ ...runtime, [outerRequest]: origin });
const outerOf = (runtime: Runtime | undefined) => (runtime as (Runtime & { [outerRequest]?: RequestOrigin }) | undefined)?.[outerRequest];
/** A new request's ID: the outer request's for an in-process call. */
export const newRequestId = (runtime: Runtime | undefined) => outerOf(runtime)?.requestId ?? `req_${crypto.randomUUID().replaceAll('-', '')}`;
export const requestOrigin = (c: Ctx): RequestOrigin => outerOf(c.env)
  ?? { requestId: c.get('requestId'), clientIp: c.req.header(clientIpHeader) ?? null, userAgent: c.req.header('user-agent') ?? null, onPollWait: ms => addPollWait(c, ms) };
const addPollWait = (c: Ctx, ms: number) => c.set('pollWaitMs', (c.get('pollWaitMs') ?? 0) + ms);
/** Only the timer is idle. An in-process MCP tool's timer is also idle time for the enclosing HTTP request. `until`: a wake
 *  that ends the wait sooner (inbox-wake.ts). */
export async function waitForPollTick(c: Ctx, ms: number, until?: Promise<void>) {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, ms); }), ...until ? [until] : []]);
  clearTimeout(timer);
  const elapsed = Math.max(0, Date.now() - start);
  addPollWait(c, elapsed);
  outerOf(c.env)?.onPollWait?.(elapsed);
}
/** One claimed delivery and what its endpoint needs to post it. `type` is the endpoint's (absent for sent-mail webhooks); url and encrypted_secret are a webhook's. */
export type ClaimedWebhook = { type?: 'webhook' | 'slack' | 'discord' | 'forward'; routed?:boolean;format?:string;name?:string;include?:string[];timeout_seconds?:number;retry_attempts?:number; delivery_id: string; generation: number; event_id: string; payload: unknown; synthetic: boolean; webhook_id: string; url: string; encrypted_secret: string; encrypted_headers: string | null; owned?: boolean };
export type JobContext = { id: string; attempts: number; workspaceId: string;
  /** The claim's lease (lease_until as claimed): the job is still this runner's while it matches. Absent when a handler is called directly. */
  leaseFence?: string;
  ingest?:import('./mailbox-ingest-input.js').IngestInput|null;
  deleteBinding?:ReadyConnection|null; webhook?: ClaimedWebhook | null; recordWithSettlement?: (ctes: import('drizzle-orm').SQL) => void };
export type JobBatchItem = { payload: Record<string, unknown>; job: JobContext };
export type JobBatchOutcome = { id: string; error?: unknown };
export type JobHandler = ((runtime: Runtime, payload: Record<string, unknown>, job: JobContext) => Promise<void>) & {
  /** Optional batch entry point for >= 2 same-workspace jobs claimed together. Returns one outcome per item. */
  batch?: (runtime: Runtime, items: JobBatchItem[]) => Promise<JobBatchOutcome[]>;
};

/** A refused attachment's declared type, the type its bytes are and its name's extension. */
export type AttachmentTypes = { declaredType: string; detectedType: string; extension: string };
export class ApiError extends Error {
  /** Structured detail for errors that have several parts, such as rule compile diagnostics. */
  details?: Record<string, unknown>[];
  /** The field names a log line may name: the schema's own, never a key the caller sent (app.ts invalidFields). */
  logField?: string;
  /** What a permission refusal needs (denied): error.required and the Nightmail-Required-Permission header. */
  required?: Required;
  /** The workspace whose daily limit refused this send (admission.ts): the error handler queues its once-a-day email and operator alert. */
  limitReachedFor?: string;
  /** What the request log may say about a refused request's Origin: its class and Sec-Fetch-Site, never the origin. */
  origin?: { originClass: string; fetchSite?: string };
  /** Seconds for the HTTP Retry-After header when a retryable 503/429 has a fixed backoff instead of resetAt. */
  retryAfterSeconds?: number;
  /** What the request log may say about a refused attachment (screened-html.ts attachmentTypes): types, never its name or content. */
  attachmentTypes?: AttachmentTypes;
  constructor(public status: number, public code: string, message: string, public field?: string, public retryable = false, public resetAt?: string) { super(message); }
}
/** Classify once, whether the error is the whole response or a failed part of a private dashboard read. */
export function describeApiFailure(error: unknown) {
  const known = error instanceof ApiError;
  const invalidJson = error instanceof SyntaxError || error instanceof HTTPException && error.status===400 && error.message==='Malformed JSON in request body';
  const database = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string };
  const keyTaken = database.code === '23505' && (database.constraint === 'mailboxes_key' || database.constraint === 'mailbox_webhooks_key');
  // A deadlock or serialization victim was rolled back whole: retryable, not a 500 that tells clients never to retry.
  const conflict = !known && !invalidJson && databaseConflict(error);
  // An MCP approval revoked while its request ran: the object it would own has no grant left.
  const grantRevoked = database.code === '23503' && database.constraint === 'mail_grant_objects_resource_grant_fkey';
  // A refused or dropped database connection, a read-only or full database and a statement cancelled at its time or
  // lock limit are a retryable 503, not an internal error (see transientDatabaseError).
  const transient = !known && !invalidJson && transientDatabaseError(error);
  // Values Postgres cannot store come from the request: U+0000 in any text (22021, or 22P05 inside JSON) and a
  // date outside its range, such as year 0000 or a +16:00 offset, which ISO 8601 validation accepts (22007/22008/22009). A client error, not a 500.
  const refused = known || invalidJson ? undefined : databaseCodeOf(error);
  const nul = refused === '22021' || refused === '22P05', badDate = refused === '22007' || refused === '22008' || refused === '22009';
  const responseError = known ? error : invalidJson ? new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.')
    : transient ? databaseUnavailable()
    : nul ? new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid: text cannot contain the NUL character (U+0000).')
    : badDate ? new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid: a date is out of range. Use a year from 0001 to 9999 and an offset within ±15:59.')
    : database.code==='BR001' ? new ApiError(422,'ROUTING_PLAN_TOO_LARGE','A host routing plan exceeds 256 KiB. Shorten or remove wildcard rules before enabling routing.')
    : conflict ? new ApiError(503, 'DATABASE_CONFLICT', 'The request conflicted with a concurrent change and was rolled back. Retry it.', undefined, true)
    : grantRevoked ? new ApiError(401, 'AUTH_INVALID', 'The MCP approval behind this request was revoked while it ran. Nothing was created.')
    : keyTaken ? new ApiError(409, 'KEY_TAKEN', `Another ${database.constraint === 'mailboxes_key' ? 'address' : 'webhook'} in this workspace already uses that key. Choose another.`, 'key')
    : new ApiError(500, 'INTERNAL_ERROR', 'Unexpected server failure. Use the request ID to locate the server log.');
  return { known, invalidJson, conflict, transient, responseError };
}
export function apiFailureBody(error: ApiError, requestId: string) {
  return { code: error.code, message: error.message, requestId, retryable: error.retryable, ...(error.field ? { field: error.field } : {}), ...(error.resetAt ? { resetAt: error.resetAt } : {}), ...(error.details ? { details: error.details } : {}), ...(error.required ? { required: error.required } : {}) };
}
/** The permissions a refusal names in error.required, each covering one area of the API (requiredFor). */
export const PERMISSIONS = { sendEmail: 'Send email', sentMail: 'Sent mail', receivedMail: 'Received mail', inboxes: 'Inboxes', audience: 'Audience & content',
  receivingRules: 'Receiving rules', configuration: 'Configuration' } as const;
export type PermissionName = keyof typeof PERMISSIONS;
/**
 * What a refused request needs: the permission the operation takes, and the scope or kind of credential when the refusal
 * is about them. The workspace itself, its members, invitations and billing take no permission: they are a person's, so
 * those refusals name the person instead.
 */
export type Required = {
  permission?: PermissionName; level?: 'on' | 'read' | 'write';
  /** What the credential's scope must cover: workspace (no sender-domain limit), allAddresses, domain:<name> or address:<address>. */
  scope?: 'workspace' | 'allAddresses' | `domain:${string}` | `address:${string}`;
  /** notDelegated: a dashboard session, or an API key that no MCP approval made. lasting: anything but a temporary agent token. */
  credential?: 'dashboard' | 'signIn' | 'lasting' | 'notDelegated';
  /** A person (a signed-in dashboard session or their own MCP sign-in) with this role in the workspace; admin is an owner or admin. */
  person?: 'admin' | 'owner';
};
export const requiredHeader = `${productName}-Required-Permission`;
/**
 * A permission refusal: 403 with the code and message clients already match on, a sentence naming the permission, and
 * error.required. Every refusal of a credential's permissions, scope, kind or role goes through here.
 */
export function denied(code: string, message: string, required: Required, field?: string) {
  const { permission, level, scope } = required;
  const where = scope === 'workspace' ? ' on the whole workspace' : scope === 'allAddresses' ? ' on every address' : scope ? ` for ${scope.slice(scope.indexOf(':') + 1)}` : '';
  const error = new ApiError(403, code, permission ? `${message} Needs ${PERMISSIONS[permission]}${level && level !== 'on' ? `: ${level}` : ''}${where}.` : message, field);
  if (Object.keys(required).length) error.required = required;
  return error;
}
const snake = (value: string) => value.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
/** The Nightmail-Required-Permission header: received_mail=read; scope="allAddresses"; credential=not_delegated; person=admin. */
export const requiredHeaderValue = (r: Required) => [r.permission ? (r.level ? `${snake(r.permission)}=${r.level}` : snake(r.permission)) : r.level && `level=${r.level}`,
  r.scope && `scope="${r.scope.replace(/[^\x20-\x7e]|["\\]/g, '')}"`, r.credential && `credential=${snake(r.credential)}`, r.person && `person=${r.person}`].filter(Boolean).join('; ');
// Which permission a route belongs to, by method and path (a concrete path or an OpenAPI template); the first match wins.
const PERMISSION_ROUTES: [PermissionName, RegExp][] = [
  ['configuration', /^\w+ \/v1\/inboxes\/[^/]+\/app-passwords(?:\/|$)/],
  ['sendEmail', /^POST \/v1\/(?:emails\/(?:send|batch|check|preview|[^/]+\/(?:cancel|reschedule))|attachments|campaigns\/[^/]+\/(?:test|send|schedule|unschedule|reschedule|pause|resume|pacing|cancel)|domains\/[^/]+\/test-send|inbound\/threads(?:\/[^/]+\/reply)?)$|^DELETE \/v1\/attachments\/[^/]+$/],
  ['sentMail', /^\w+ \/v1\/(?:emails|events|logs|metrics|sender-score|usage|overview|attachments)(?:\/|$)|^\w+ \/v1\/campaigns\/[^/]+\/stats$/],
  ['receivedMail', /^\w+ \/v1\/(?:inbound\/(?:messages|threads|events)|inboxes\/[^/]+\/(?:messages|folders|changes|simulate))(?:\/|$)/],
  ['inboxes', /^\w+ \/v1\/(?:inboxes|inbound\/(?:addresses|retired))(?:\/|$)/],
  ['audience', /^\w+ \/v1\/(?:contacts|lists|newsletters|segments|topics|contact-imports|audience-query|templates|template-assets|campaign-content-guide|campaigns)(?:\/|$)/],
  ['receivingRules', /^\w+ \/v1\/(?:routing|rules|endpoints|inbox-connections|inbound\/(?:endpoints|policy|domains|overview))(?:\/|$)|^\w+ \/v1\/domains\/[^/]+\/receiving-host$/],
];
/**
 * The permission a request needs at the level a check asks for: a credential's read, send or manage (editContent is
 * manage), an address key's read, send, modify or create, or, without one, read for GET and write otherwise.
 * Everything not listed above is Configuration. The workspace, its members, invitations and billing are an owner's or
 * admin's (person), creating a workspace and accepting an invitation any person's, and staff areas take none.
 */
export function requiredFor(method: string, path: string, need?: Permission | 'editContent' | import('./db/mailbox.js').MailboxPermission): Required {
  if (need === 'create') return { permission: 'inboxes', level: 'write' };
  if (/^\/v1\/(?:operator|support)(?:\/|$)/.test(path)) return {};
  if (/^\/v1\/(?:workspaces\/current|billing|activity)(?:\/|$)/.test(path)) return { person: 'admin' };
  if (/^\/v1\/workspaces(?:\/|$)/.test(path)) return {};
  const verb = method.toUpperCase(), route = `${verb} ${path}`, permission = PERMISSION_ROUTES.find(([, pattern]) => pattern.test(route))?.[0] ?? 'configuration';
  // send is Send email on sending and sent mail's routes; on another route (a campaign draft, a template preview) it is that
  // route's permission at write.
  if (need === 'send' && (permission === 'sendEmail' || permission === 'sentMail')) return { permission: 'sendEmail', level: 'on' };
  const read = need ? need === 'read' : verb === 'GET' || verb === 'HEAD';
  if (permission === 'sendEmail') return read ? { permission: 'sentMail', level: 'read' } : { permission, level: 'on' };
  return { permission, level: read ? 'read' : 'write' };
}
export const requiredOf = (c: Ctx, need?: Parameters<typeof requiredFor>[2]) => requiredFor(c.req.method, c.req.path, need);
/**
 * What a limited credential may do, as one sentence that names its limits: "This key can only send from acme.com." A
 * refusal starts with it, so whoever reads it (often an integration that made a key in onboarding's Send only tab) knows
 * which key they used, not only what it lacks.
 */
export function credentialLimits(a: Pick<Actor, 'permissions' | 'domains' | 'credential'>) {
  const who = a.credential === 'agentToken' ? 'This agent token' : a.credential === 'mcp' ? 'This MCP connection' : 'This key';
  const domains = a.domains.length <= 2 ? a.domains.join(' and ') : `${a.domains[0]}, ${a.domains[1]} and ${a.domains.length - 2} more`;
  const from = a.domains.length ? ` from ${domains}` : '', send = a.permissions.includes('send'), read = a.permissions.includes('read');
  if (a.permissions.includes('manage')) return `${who} is limited to the sender domain${a.domains.length > 1 ? 's' : ''} ${domains}.`;
  if (send && read) return `${who} can only send${from} and read what was sent${from ? ' from there' : ''}.`;
  if (send) return `${who} can only send${from}.`;
  return `${who} can only read${from ? ` mail sent${from}` : ''}.`;
}
/** Where a full-access key comes from: the dashboard's Create key, or a full-access key itself. */
export const FULL_ACCESS_KEY = 'create one in the dashboard under API keys → Create key → Full access, or with a full-access key via POST /v1/api-keys';
// The workspace-wide areas a credential limited to sender domains is refused (UNRESTRICTED_KEY_REQUIRED), by path, as the
// subject of "… need a full-access key". The first match names it.
const RESTRICTED_AREAS: [RegExp, string][] = [
  [/^\/v1\/inbound\/addresses(?:\/|$)/, 'Inbound addresses need'], [/^\/v1\/inbound\/domains(?:\/|$)/, 'Inbound domains need'],
  [/^\/v1\/(?:inboxes\/[^/]+\/)?app-passwords(?:\/|$)/, 'Mail client passwords need'], [/^\/v1\/(?:inbound|inboxes)(?:\/|$)/, 'Received mail and inboxes need'],
  [/^\/v1\/billing(?:\/|$)/, 'Billing needs'], [/^\/v1\/campaigns(?:\/|$)/, 'A campaign’s audience and delivery need'],
  [/^\/v1\/(?:contacts|lists|segments|topics|contact-imports|audience-query)(?:\/|$)/, 'The workspace audience needs'], [/^\/v1\/newsletters(?:\/|$)/, 'Newsletters need'],
  [/^\/v1\/(?:templates|template-assets)(?:\/|$)/, 'Templates need'], [/^\/v1\/webhooks(?:\/|$)/, 'Webhooks need'], [/^\/v1\/regions(?:\/|$)/, 'Region settings need'],
  [/^\/v1\/settings(?:\/|$)/, 'Workspace settings need'], [/^\/v1\/(?:metrics|sender-score|usage)(?:\/|$)/, 'Workspace-wide numbers need'],
];
export const restrictedArea = (path: string) => RESTRICTED_AREAS.find(([pattern]) => pattern.test(path))?.[1] ?? 'This needs';
/** Reading received mail: messages, threads, their attachments and events, which a key limited to addresses also reads. */
export const receivedMailRead = (method: string, path: string) => method.toUpperCase() === 'GET' && /^\/v1\/(?:inbound\/(?:messages|threads|events)|inboxes\/[^/]+\/messages)(?:\/|$)/.test(path);
const ADDRESS_KEY_EXAMPLE = '{"name":"Replies","access":{"type":"addresses","addressIds":["mbx_…"],"mail":["read","send"]}}';
/**
 * Why an API key can't read received mail (a production agent with a key limited to its sender domain hit this reading
 * its replies, then guessed at POST /v1/api-keys), and exactly what to change: the key limited to receiving addresses
 * that reads them, made with the request shown or in the dashboard, or Full access. `origin` links the docs.
 */
export function receivedMailRefusal(code: 'UNRESTRICTED_KEY_REQUIRED' | 'ADMIN_REQUIRED', a: Pick<Actor, 'permissions' | 'domains' | 'credential' | 'keyId'>, need: Required, origin: string) {
  const domains = a.domains.length <= 2 ? a.domains.join(' and ') : `${a.domains[0]}, ${a.domains[1]} and ${a.domains.length - 2} more`;
  const addressKey = `with a full-access key, find their IDs with GET /v1/inbound/addresses, then POST /v1/api-keys with ${ADDRESS_KEY_EXAMPLE}; or in the dashboard, API keys → Create key → Mail at chosen addresses`;
  const docs = `Docs: ${origin}/docs/operations/createApiKey.md`;
  // A key limited to sender domains reads the replies addressed to them once it has Read (domainMailAccess).
  if (a.domains.length && !a.permissions.includes('read') && !a.permissions.includes('manage')) return denied(code, `${credentialLimits(a)} To read the replies to ${domains}, it needs Read: add Read to it in the dashboard (API keys → Edit; it keeps its secret) or with a full-access key: PATCH /v1/api-keys/${a.keyId} with {"permissions":${JSON.stringify([...a.permissions, 'read'])}}. Or create a key with Read and Send limited to ${domains}, in the dashboard (API keys → Create key) or with a full-access key: POST /v1/api-keys with {"name":"Agent","permissions":["read","send"],"domains":${JSON.stringify(a.domains)}}. It reads only received mail addressed to ${domains}. ${docs}`,
    { ...need, scope: 'workspace' });
  return denied(code, a.domains.length
    ? `${credentialLimits(a)} It reads the received mail addressed to ${domains} with GET /v1/inbound/messages, /v1/inbound/threads and /v1/inbound/events, not agent inboxes or the rest of receiving. For an inbox's mail, use a key limited to the receiving addresses (Read, and Send to answer from them): ${addressKey}. A full-access key reads all received mail. ${docs}`
    : `${credentialLimits(a)} Received mail needs Full access, or a key limited to receiving addresses. Make this key Full access in the dashboard (API keys → Edit; it keeps its secret) or with a full-access key: PATCH /v1/api-keys/${a.keyId} with {"permissions":["read","send","manage"]}. Or, for replies at some addresses only, use a key limited to them: ${addressKey}. ${docs}`,
    code === 'UNRESTRICTED_KEY_REQUIRED' ? { ...need, scope: 'workspace' } : need);
}
/**
 * UNRESTRICTED_KEY_REQUIRED: a credential limited to sender domains is refused a workspace-wide area. The message says
 * what the credential is, what the area needs and where to get it: "This key can only send from acme.com. Inbound
 * addresses need a full-access key: create one in the dashboard under API keys → Create key → Full access, …".
 */
export const unrestrictedRequired = (a: Pick<Actor, 'permissions' | 'domains' | 'credential'> | undefined, area: string, need: Required, note?: string) =>
  fullAccessRefusal('UNRESTRICTED_KEY_REQUIRED', a, area, { ...need, scope: 'workspace' }, note);
/**
 * A refusal, under `code`, of a credential that isn't full access, worded as unrestrictedRequired words it. An API key
 * with no sender-domain limit is one edit away from Full access: it is told that edit on its own ID (an agent with a Read
 * only key listing receiving addresses retried six times when told to create another key, which keys can't do), and that
 * asking again with it changes nothing.
 */
export const fullAccessRefusal = (code: string, a: (Pick<Actor, 'permissions' | 'domains' | 'credential'> & { keyId?: string }) | undefined, area: string, need: Required, note?: string) =>
  denied(code, a?.credential === 'apiKey' && !a.domains.length && a.keyId
    ? `${credentialLimits(a)} ${area} Full access: make this key Full access in the dashboard (API keys → Edit; it keeps its secret) or with a full-access key: PATCH /v1/api-keys/${a.keyId} with {"permissions":["read","send","manage"]}.${note ? ` ${note}` : ''} Until then this key gets the same answer.`
    : `${a ? `${credentialLimits(a)} ` : ''}${area} a full-access key: ${FULL_ACCESS_KEY}.${note ? ` ${note}` : ''}`, need);
export class ModuleLoadError extends ApiError {
  constructor(cause?: unknown) {
    super(503, 'MODULE_LOAD_FAILED', 'Unable to load a required runtime module; retry shortly.', undefined, true);
    this.name = 'ModuleLoadError';
    if (cause !== undefined) this.cause = cause;
  }
}
export function wrapModuleLoad<T>(work: () => Promise<T>): Promise<T> {
  try {
    return work().catch(error => { throw error instanceof ModuleLoadError ? error : new ModuleLoadError(error); });
  } catch (error) {
    return Promise.reject(error instanceof ModuleLoadError ? error : new ModuleLoadError(error));
  }
}
export function lazyModule<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= wrapModuleLoad(load).catch(error => { pending = undefined; throw error; });
}
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), field: z.string().optional(), retryable: z.boolean(), resetAt: z.iso.datetime().optional().describe('Next capacity change for a Hosted rolling send limit.'), details: z.array(z.record(z.string(), z.unknown())).optional().describe('Every problem found, when there is more than one part, such as rule diagnostics with rule, line, column, message and hint, or a measurement, such as CONTENT_TOO_LARGE_TO_SCREEN with screenedBytes and limitBytes (and index in a batch).'),
  required: z.object({
    permission: z.enum(Object.keys(PERMISSIONS) as [PermissionName, ...PermissionName[]]).optional().describe('The permission: sendEmail, sentMail, receivedMail, inboxes, audience (audience and content), receivingRules or configuration.'),
    level: z.enum(['on', 'read', 'write']).optional().describe('The level of that permission: on (sendEmail), read or write. With person alone, what the person\'s MCP sign-in must be approved for.'),
    scope: z.string().optional().describe('What the credential\'s scope must cover: workspace (no sender-domain limit), allAddresses (every receiving address), domain:<name> or address:<address>.'),
    credential: z.enum(['dashboard', 'signIn', 'lasting', 'notDelegated']).optional().describe('The kind of credential: dashboard (a signed-in dashboard session), signIn (an MCP sign-in), lasting (anything but a temporary agent token) or notDelegated (a dashboard session, or an API key no MCP approval made).'),
    person: z.enum(['admin', 'owner']).optional().describe('A person, never a key: a signed-in dashboard session or their own MCP sign-in, with this role in the workspace (admin is an owner or admin). The workspace, its members, invitations and billing are a person\'s.'),
  }).optional().describe(`On a 403 permission refusal: what the request needs that this credential lacks. The ${requiredHeader} header says the same.`) }) }).openapi('ApiError');
export const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].map(status => [status, { description: 'Request failed; use error.code and requestId to diagnose.', content: { 'application/json': { schema: ErrorSchema } } }]));
/**
 * How long each statement of a read may run (budgetedRead), and the refusal past it. A dashboard read that needs longer
 * holds one of the database's few connections for up to the proxy's 60 seconds, beside sending: past its limit it is
 * refused instead, and the caller narrows it.
 */
export type ReadBudget = { seconds: number; refusal: () => ApiError };
/** A list or aggregate the caller can narrow (Logs, listEmails, metrics, campaign counts, inbound lists). */
export const readLimit = (seconds: number): ReadBudget => ({ seconds,
  refusal: () => new ApiError(422, 'READ_TOO_LARGE', `This request is too broad to answer within ${seconds} seconds. Narrow the dates or filters.`) });
/** The OpenAPI description of that refusal, for the routes that take a budget. */
export const readLimitNote = (seconds: number) => `Each statement stops after ${seconds} seconds: a request that needs longer is refused with 422 READ_TOO_LARGE. Narrow the dates or filters.`;
/**
 * One read-only transaction whose every statement stops after the budget's seconds (SET LOCAL statement_timeout), so a
 * slow read is refused (SQLSTATE 57014 becomes the budget's refusal) instead of holding its connection. Costs BEGIN,
 * SET and COMMIT: three round trips on the read's own connection.
 */
export async function budgetedRead<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>, budget: ReadBudget, isolationLevel?: 'repeatable read'): Promise<T> {
  if (!Number.isInteger(budget.seconds) || budget.seconds < 1) throw new Error('A read budget is a whole number of seconds.');
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${budget.seconds}s'`));
      return work(tx);
    }, { accessMode: 'read only', ...(isolationLevel && { isolationLevel }) });
  } catch (error) {
    if (statementTimedOut(error)) throw budget.refusal();
    throw error;
  }
}
/** A statement ended by statement_timeout (SQLSTATE 57014), as the driver reports it or wraps it. */
export const statementTimedOut = (error: unknown) => [error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014');
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
export function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
export const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const AudienceSpec = z.object({ listId: z.string().min(1).max(120), segmentId: z.string().min(1).max(120).optional(), excludeListIds: z.array(z.string().min(1).max(120)).max(20).optional(), excludeSegmentIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  priority: z.object({ property: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), values: z.array(z.string().max(200)).min(1).max(20) }).strict().optional().describe('Send order: contacts whose property equals an earlier value are reviewed and released first; everyone else follows. Useful with paced sending, e.g. { property: "plan", values: ["active", "former"] }.') }).strict();
export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } }, required: true });
export const response = <T extends z.ZodType>(schema: T, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
export const page = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
/** A random ID: the prefix, `_` and 32 hex characters (a UUIDv4, 122 random bits). Anything that must be unguessable uses this. */
export function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
/**
 * A time-ordered ID for high-volume rows (emails, events, webhook and inbound webhook deliveries, jobs, threads), in
 * id()'s format: a UUIDv7 (RFC 9562), 48 bits of Unix milliseconds then 74 random bits, so a new row lands at the end
 * of its indexes instead of on a random page. row_id() builds the same in SQL (migration 392). It shows when the row was
 * made, so it is never a secret or a capability; and IDs from the same millisecond, or from machines whose clocks
 * differ, come in no particular order.
 */
export function rowId(prefix: string) { return `${prefix}_${Date.now().toString(16).padStart(12, '0')}7${crypto.randomUUID().replaceAll('-', '').slice(13)}`; }
/** A timestamp as the API returns it (ISO 8601, UTC), from Postgres text ("2026-11-13 10:00:00.123+00") or ISO. */
export const isoTime = (value: string | null | undefined) => value ? new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString() : null;
/** A (created_at, id) page cursor, bound to its resource and filters; microseconds survive the round trip. */
export function readCursor(value: string | undefined, binding: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    // ISO 8601 allows offsets up to ±23:59; Postgres refuses past ±15:59 (22009), so an edited cursor would be a 500.
    const tuple = z.tuple([z.string().datetime({ offset: true }).regex(/(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/), z.string().min(1).max(120), z.literal(binding)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: tuple[0], id: tuple[1] };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}
export function encodeCursor(last: { id: string; createdAt: string }, binding: string) {
  return Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url');
}
export function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? encodeCursor(last, binding) : null;
}
/**
 * Where a sending upload is stored. The prefix belongs to uploads alone: every other key family starts
 * with a workspace ID or a mail class, and no workspace may be named `uploads` (migration 158).
 */
export const uploadKey = (workspaceId: string, attachmentId: string) => `uploads/${workspaceId}/${attachmentId}`;
export function actor(c: Ctx, action: Permission | 'editContent' = 'read'): Actor {
  const value = c.get('actor');
  // Dashboard roles include content editing. A scoped machine grant is still bounded by its
  // original permission contract: send alone does not delegate contact or template management.
  const permission = action === 'editContent' ? (c.env.config.multiTenant && value?.credential === 'dashboard' ? 'send' : 'manage') : action;
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw value?.credential === 'apiKey'
    ? missingPermission(value, permission, requiredOf(c, action)) : denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, requiredOf(c, action));
  return value;
}
/**
 * PERMISSION_DENIED for an API key that lacks a permission (onboarding's Send only key reading back what it sent, most
 * often): what the key can do, then how to get one that can: the same key with the permission added (API keys → Edit
 * keeps its secret, so nothing is redeployed), or a full-access key. denied() adds what the endpoint needs.
 */
export function missingPermission(a: Pick<Actor, 'permissions' | 'domains' | 'credential'>, permission: Permission, need: Required) {
  const add = permission === 'manage' ? 'Make it Full access' : `Add ${permission === 'read' ? 'Read' : 'Send'} to it`;
  return denied('PERMISSION_DENIED', `${credentialLimits(a)} ${add} in the dashboard (API keys → Edit; it keeps its secret), or use a full-access key: ${FULL_ACCESS_KEY}.`, need);
}
/**
 * The one rule for changes that outlive the credential making them: API keys, sending and receiving webhooks, endpoints,
 * routes, rules, inbound keys, mail client passwords and inbox connections. A temporary agent token lasts at most a
 * day, so it reads and tests these but never creates, changes or removes them. Every such write calls this; the MCP
 * listing asks lastingRefusal of the same routes (keyAdminRoute, receivingAdminRoute, lastingRoute).
 */
export function lasting(c: Ctx, what: string) {
  const refusal = lastingRefusal(c.get('actor'), what, requiredOf(c, 'manage'));
  if (refusal) throw refusal;
}
export const lastingRefusal = (a: Actor | undefined, what: string, need: Required = {}) => a?.credential === 'agentToken'
  ? denied('CREDENTIAL_DELEGATION_FORBIDDEN', `Temporary agent tokens cannot ${what}. Use the dashboard, an API key or the MCP approval itself.`, { ...need, credential: 'lasting' }) : null;
/** What `lasting` refuses, for the areas that share a wording (sending and receiving webhooks; API keys and inbound keys). */
export const WEBHOOK_CHANGE = 'create, change or delete webhooks or read their signing secrets', KEY_CHANGE = 'create, list or revoke API keys';
/** What `lasting` refuses on receiving hosts: adding, changing or removing one, turning receiving on or off, or its catch-all. */
export const RECEIVING_HOST_CHANGE = 'add, change or remove receiving hosts';
/**
 * Receiving configuration (routing, rules, endpoints, inbox connections) covers every address in the workspace: an
 * owner or admin, an API key with manage on all domains, or an MCP approval with receiving consent, which reads with
 * read. A change (`change` says what, for the error) needs manage, receiving consent and a lasting credential.
 */
export function receivingAdmin(c: Ctx, change?: string): Actor {
  const refusal = receivingAdminRefusal(c.get('actor'), change);
  if (refusal) throw refusal;
  return c.get('actor');
}
/** Why receivingAdmin refuses this actor, or null. The MCP listing asks the same of receivingAdminRoute's operations. */
export function receivingAdminRefusal(a: Actor | undefined, change?: string): ApiError | null {
  const permission = !change && a?.receivingConsent ? 'read' : 'manage', need: Required = { permission: 'receivingRules', level: change ? 'write' : 'read' };
  if (!a || (!a.permissions.includes('manage') && !a.permissions.includes(permission))) return a?.credential === 'apiKey' ? missingPermission(a, permission, need) : denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, need);
  if (a.domains.length && a.credential === 'apiKey') return fullAccessRefusal('ADMIN_REQUIRED', a, 'Receiving configuration covers every address in the workspace, so it needs', { ...need, scope: 'workspace' });
  if (a.domains.length || a.role === 'member')
    return denied('ADMIN_REQUIRED', 'Receiving configuration covers every address in the workspace. Use an owner or admin session, or an API key with manage permission on all domains.', a.role === 'member' ? { ...need, person: 'admin' } : { ...need, scope: 'workspace' });
  if (!change) return null;
  if (a.grantId && !a.receivingConsent) return denied('ADMIN_REQUIRED', 'Changing receiving configuration requires an owner or admin of this workspace.', { ...need, person: 'admin' });
  return lastingRefusal(a, change, need);
}
/** Key administration (auth.ts manageKeys, and the deprecated inbound key routes): why it refuses this actor, or null.
 *  It takes unrestricted manage and a lasting credential that is not an agent's own setup key: an agent that received
 *  its key through agent setup can't make itself, or anyone, another API key or agent token. */
export function keyAdminRefusal(a: Actor): ApiError | null {
  const need: Required = { permission: 'configuration', level: 'write' };
  // An API key that isn't full access (onboarding's Send only key, most often): say which key it is and where keys are made.
  if (a.credential === 'apiKey' && (!a.permissions.includes('manage') || a.domains.length))
    return denied('PERMISSION_DENIED', `${credentialLimits(a).slice(0, -1)}, so it can't ${KEY_CHANGE}. Create keys in the dashboard under API keys → Create key, or with a full-access key via POST /v1/api-keys.`,
      a.permissions.includes('manage') ? { ...need, scope: 'workspace' } : need);
  if (!a.permissions.includes('manage')) return denied('PERMISSION_DENIED', 'This operation requires manage permission.', need);
  const temporary = lastingRefusal(a, KEY_CHANGE, need);
  if (temporary) return temporary;
  if (a.agentSetup) return denied('PERMISSION_DENIED', `A key an agent received at setup can't ${KEY_CHANGE}. An owner or admin does that in the dashboard (API keys).`, { ...need, person: 'admin' });
  if (a.domains.length) return denied('PERMISSION_DENIED', 'Key administration requires unrestricted management access.', { ...need, scope: 'workspace' });
  return null;
}
/** Billing (its balance, payments and top-ups): an agent's setup key never reaches it, reads included. REST refuses it in
 *  app.ts and the MCP listing leaves it out (mcp.ts refusal), with the same answer. */
/** agentSetupRefusal's credential routes: an inbox connection's key and a mail client password, which would outlive the
 *  agent's key when it is revoked. Inbox routes authenticate after the /v1 guard, so createInbox's own key (inboxes.ts,
 *  from its body) and app passwords (inbox-passwords.ts) are refused in their handlers too; this keeps the MCP listing. */
const agentCredentialRoute = (method: string, path: string) => method.toUpperCase() === 'POST' && (path === '/v1/inbox-connections' || /^\/v1\/inboxes\/[^/]+\/app-passwords$/.test(path));
export const agentCredentialRefusal = () => denied('PERMISSION_DENIED', 'A key an agent received at setup can\'t create inbox keys or mail client passwords: they would outlive it when it is revoked. An owner or admin does that in the dashboard.', { person: 'admin' });
export const agentSetupRefusal = (a: Actor | undefined, path: string, method = 'GET') => !a?.agentSetup ? null
  : /^\/v1\/billing(?:\/|$)/.test(path) ? denied('PERMISSION_DENIED', 'A key an agent received at setup can\'t read or change billing. An owner or admin does that in the dashboard (Settings → Billing).', { person: 'admin' })
  : agentCredentialRoute(method, path) ? agentCredentialRefusal() : null;
/** createAgentToken: only an MCP approval delegates a temporary token. Why it refuses this actor, or null. */
export const agentTokenMintRefusal = (a: Actor) => a.credential === 'mcp' && a.keyId.startsWith('mcp_') ? null
  : denied('MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.', { credential: 'signIn' });
// ---------- route guards shared by REST and the MCP listing ----------
// Each takes a concrete request path or an OpenAPI template ({id} segments). The middleware that
// enforces a guard and the MCP listing that must agree with it call the same predicate.
/** mailboxAuth: inbox keys, or a workspace credential through actorMailAccess. */
export const mailboxRoute = (path: string) => /^\/v1\/(?:inbound|inboxes)(?:\/|$)/.test(path);
const appPasswordRoute = (path: string) => /^\/v1\/(?:inboxes\/[^/]+\/)?app-passwords(?:\/|$)/.test(path);
/** requireReceivingConsent: an MCP grant without explicit receiving consent is refused. */
export const receivingConsentRoute = (path: string) =>
  appPasswordRoute(path) || /^\/v1\/(?:routing|rules|endpoints|inbound\/(?:retired|domains|addresses|webhooks|overview|endpoints))(?:\/|$)|^\/v1\/(?:inbox-connections|inbound\/policy|domains\/[^/]+\/receiving-host|inbound\/messages\/[^/]+\/redeliver)$/.test(path);
/** notMember: workspace members are refused these areas whatever their scopes. */
export const ownerRoute = (method: string, path: string) => {
  const verb = method.toUpperCase();
  return appPasswordRoute(path) || /^\/v1\/(?:domains|webhooks|agent-tokens)(?:\/|$)|^\/v1\/regions\/|^\/v1\/settings\/ses$/.test(path) || (path === '/v1/regions' && verb !== 'GET')
    || (verb === 'POST' && /^\/v1\/campaigns\/[^/]+\/(?:send|schedule|unschedule|reschedule|pause|resume|pacing|cancel)$/.test(path));
};
/** UNRESTRICTED_KEY_REQUIRED (app.ts): a sender-domain credential is refused these workspace-wide areas. Audience records
 *  have no sender domain, and a campaign's audience and delivery act on the workspace audience (a draft stays editable). */
export const unrestrictedRoute = (path: string) => /^\/v1\/(?:contacts|lists|newsletters|segments|topics|contact-imports|audience-query|settings|webhooks|metrics|sender-score|usage|billing|regions|app-passwords)(?:\/|$)/.test(path)
  || !['state', 'preview', 'preview-image', 'archive', undefined].includes(/^\/v1\/campaigns\/[^/]+\/([^/]+)$/.exec(path)?.[1]);
// The routes of the guards above that handlers call, for the MCP listing (each verified against REST's answers for reads).
/** receivingAdmin's routes: routing, rules, endpoints, inbox connections and an address's flow (its route and rule
 *  together). */
export const receivingAdminRoute = (path: string) => /^\/v1\/(?:routing|rules|endpoints|inbox-connections)(?:\/|$)|^\/v1\/inbound\/addresses\/[^/]+\/flow$/.test(path);
/** keyAdminRefusal's routes: API keys, and listing and revoking agent tokens. */
export const keyAdminRoute = (method: string, path: string) => /^\/v1\/(?:api-keys|agent-tokens)(?:\/|$)/.test(path) && !agentTokenMintRoute(method, path);
/** agentTokenMintRefusal's route: createAgentToken. */
export const agentTokenMintRoute = (method: string, path: string) => method.toUpperCase() === 'POST' && path === '/v1/agent-tokens';
/** lasting's other routes: setting up sending and receiving webhooks and reading their secrets, mail client passwords, and
 *  receiving hosts (adding, changing or removing one, choosing one, turning a domain's receiving on or off, its catch-all).
 *  Testing a webhook, retrying a delivery and checking a domain's MX stay a temporary token's. */
export function lastingRoute(method: string, path: string) {
  const verb = method.toUpperCase();
  return (verb === 'POST' && /^\/v1\/(?:inbound\/)?webhooks$/.test(path)) || ((verb === 'PATCH' || verb === 'DELETE') && /^\/v1\/(?:inbound\/)?webhooks\/[^/]+$/.test(path))
    || /^\/v1\/(?:inbound\/)?webhooks\/[^/]+\/(?:rotate-secret|secret)$/.test(path) || (verb !== 'GET' && /^\/v1\/inboxes\/[^/]+\/app-passwords(?:\/[^/]+)?$/.test(path))
    || (verb !== 'GET' && /^\/v1\/inbound\/domains\/[^/]+(?:\/(?:enable|disable|hosts(?:\/[^/]+)?|subdomains(?:\/[^/]+)?))?$/.test(path)) || (verb === 'POST' && /^\/v1\/domains\/[^/]+\/receiving-host$/.test(path));
}
/**
 * Members and invitations (listing members, and listing, creating and revoking invitations) and the workspace's
 * Activity: an owner or admin in person. That is a signed-in dashboard session, or their own MCP sign-in (a person's
 * approval, checked against their role now) with read to list members and invitations and manage to change them or to
 * read Activity, which names every member and credential. Never an API key, a key an approval made or a temporary agent
 * token: a membership outlasts every one of them. Why it refuses this actor, or null; the MCP listing asks the same of
 * memberAdminRoute's operations. Changing a member's role and removing a member stay with the dashboard (dashboardSession).
 */
export function memberAdminRefusal(a: Actor | undefined, change: boolean): ApiError | null {
  const signIn = a?.credential === 'mcp' && a.keyId.startsWith('mcp_'), need: Required = { person: 'admin' };
  if (!a || (a.credential !== 'dashboard' && !signIn)) return denied('DASHBOARD_AUTH_REQUIRED', 'Members, invitations and Activity are for an owner or admin in person: a signed-in dashboard session or their own MCP sign-in. API keys and agent tokens cannot.', need);
  if (a.role !== 'owner' && a.role !== 'admin') return denied('PERMISSION_DENIED', 'Workspace administration requires an owner or admin.', need);
  const permission = change ? 'manage' : 'read';
  if (signIn && !a.permissions.includes('manage') && !a.permissions.includes(permission)) return denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, { ...need, level: change ? 'write' : 'read' });
  return null;
}
/** memberAdminRefusal's routes: listing members, listing, creating and revoking invitations, and reading Activity. */
export const memberAdminRoute = (method: string, path: string) => path === '/v1/workspaces/current/invitations' || (method.toUpperCase() === 'GET' && (path === '/v1/workspaces/current/members' || path === '/v1/activity'));
/** Whether memberAdminRefusal asks a sign-in for manage here: every change, and reading Activity. */
export const memberAdminManage = (method: string, path: string) => method.toUpperCase() !== 'GET' || path === '/v1/activity';
/** notMember (app.ts): whether REST refuses this actor the route because it is a workspace member. */
export const memberRefused = (actor: Pick<Actor, 'role'> | undefined, method: string, path: string) => actor?.role === 'member' && ownerRoute(method, path);
/** Hosted workspace administration: a signed-in dashboard session, and with `manage` an owner or admin. Not found when self-hosted. */
export function dashboardSession(c: Ctx, manage = false) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { ...requiredOf(c), credential: 'dashboard' });
  if (manage && a.role !== 'admin' && a.role !== 'owner') throw denied('PERMISSION_DENIED', 'Workspace administration requires an owner or admin.', { ...requiredOf(c), person: 'admin' });
  return { workspaceId: a.workspaceId, userId: a.keyId.slice(5), email: a.email! };
}
/**
 * Whether a route's guard admits this caller. A summary reports a section as null when its own endpoint would refuse
 * the caller (403, 404) or isn't set up on this installation (a *_NOT_CONFIGURED error), instead of failing the whole read.
 */
export function admits(guard: () => unknown) {
  try { guard(); return true; }
  catch (error) { if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.code.endsWith('_NOT_CONFIGURED'))) return false; throw error; }
}
// Received mail a Nightmail credential can read: dashboard members read addressed mail; unrestricted manage credentials read
// the whole workspace; everything else reads none. Used by mailboxAuth, the unified logs and the MCP listing.
export function actorMailAccess(actor: Actor): MailboxAccess | null {
  if (actor.domains.length) return null;
  if (actor.role === 'member' && actor.credential === 'dashboard') return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: ['read', 'send'] };
  if (!actor.permissions.includes('manage')) return null;
  return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: true, mailboxIds: null, permissions: ['read', 'send', 'modify'] };
}
/**
 * What mail a workspace credential reaches on a mailbox path (mailboxAuth), or why it reaches none. The MCP listing
 * asks the same question. A sender-domain credential never reaches mail; an unrestricted read API key reads inbound
 * webhook settings, not mail or delivery history.
 */
export function workspaceMailAccess(actor: Actor, method: string, path: string): MailboxAccess | 'UNRESTRICTED_KEY_REQUIRED' | 'ADMIN_REQUIRED' {
  if (actor.domains.length) return domainMailAccess(actor, method, path) ?? 'UNRESTRICTED_KEY_REQUIRED';
  if (!actor.permissions.includes('manage') && actor.credential === 'apiKey' && actor.permissions.includes('read') && method.toUpperCase() === 'GET' && /^\/v1\/inbound\/webhooks(?:\/[^/]+)?$/.test(path))
    return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: [] };
  return actorMailAccess(actor) ?? 'ADMIN_REQUIRED';
}
/** The received-mail reads a key limited to sender domains may make: messages, their attachments, threads and events. */
const DOMAIN_MAIL_READS = /^\/v1\/inbound\/(?:messages(?:\/[^/]+(?:\/(?:attachments|parts)\/[^/]+)?)?|threads(?:\/[^/]+)?|events)$/;
/**
 * A workspace API key limited to sender domains that can read (read, or manage) reads the received mail addressed to
 * those domains, so "Read and Send limited to example.com" is a whole agent key: it sends from there and reads the replies.
 * Only those reads: everything else under /v1/inbound and /v1/inboxes stays a full-access key's (UNRESTRICTED_KEY_REQUIRED).
 * mailboxIds start empty, so the access reaches nothing until mailboxAuth puts the receiving addresses there in them.
 * A send-only key stays send-only; agent tokens and MCP sign-ins limited to domains read none.
 */
export function domainMailAccess(actor: Actor, method: string, path: string): MailboxAccess | null {
  if (actor.credential !== 'apiKey' || !actor.domains.length || (!actor.permissions.includes('read') && !actor.permissions.includes('manage'))) return null;
  if (method.toUpperCase() !== 'GET' || !DOMAIN_MAIL_READS.test(path)) return null;
  return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: [], permissions: ['read'], domains: [...actor.domains] };
}
export function senderDomainAllowed(allowed: readonly string[], candidate: string) {
  const domain = candidate.toLowerCase();
  return !allowed.length || allowed.some(value => { const parent = value.toLowerCase(); return domain === parent || domain.endsWith(`.${parent}`); });
}
export const webhookUrlHint = (url: string) => '••••' + url.slice(-4);
export const WebhookUrlHint = z.string().describe('Write-only HTTPS endpoint. Only the last four characters are shown; omit url on update to keep the saved URL.');
export function region(runtime: Runtime, value: string) {
  if (!runtime.config.regions.includes(value)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested region is not configured for this deployment.', 'region');
  return value;
}
// Runtime identities are invocation-local in Workers; never reuse an I/O client
// across requests. Node drains also receive a fresh resolved runtime.
const sesClients = new WeakMap<Runtime, Map<string, SESv2Client>>();
export const isSimulatedSes = (runtime: Runtime) => !runtime.config.liveEnabled || !runtime.config.aws;
export function assertSesConfigured(runtime: Runtime) {
  if (isSimulatedSes(runtime)) throw new ApiError(503, 'SES_NOT_CONFIGURED', 'Live SES access is disabled or AWS credentials are missing.');
}
export function assertSharedAccount(runtime: Runtime, row: Pick<ReadyConnection, 'kind' | 'aws_account_id'>) {
  if (runtime.config.multiTenant && row.kind === 'shared' && runtime.config.platformAccount && row.aws_account_id !== null && row.aws_account_id !== runtime.config.platformAccount)
    throw new ApiError(503, 'AWS_ACCOUNT_MISMATCH', 'This Hosted binding belongs to a different platform account.', undefined, true);
}
// Old queued simulator jobs and SNS receipts retain their original topic as a deduplication key.
export function simulatedTopic(topic: unknown, region?: unknown) {
  if (typeof topic !== 'string') return false;
  return ['urn:bane:simulated-ses:', 'urn:opensend:simulated-ses:'].some(prefix => region === undefined ? topic.startsWith(prefix) : topic === prefix + region);
}
/** The bane_email_id tag the dispatcher stamps on every SES message (only meaningful after SNS signature verification). */
export function taggedEmailId(message: unknown): string | undefined {
  const tags = (message as { mail?: { tags?: Record<string, unknown> } } | undefined)?.mail?.tags;
  const tag = tags?.bane_email_id ?? tags?.opensend_email_id;
  const value = Array.isArray(tag) ? tag[0] : undefined;
  return typeof value === 'string' && /^email_[a-z0-9]{8,64}$/.test(value) ? value : undefined;
}
const loadSesClientDeps = lazyModule(() => Promise.all([import('@aws-sdk/client-sesv2'), import('@smithy/fetch-http-handler'), import('./provider-credentials.js')]));
export async function preloadSesTransport(multiTenant = false) {
  const [sesv2, { FetchHttpHandler }, creds] = await wrapModuleLoad(() => loadSesClientDeps());
  if (multiTenant) await wrapModuleLoad(() => creds.loadStsSdk());
  const getSesSync = (runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): SESv2Client => {
    region(runtime, selectedRegion);
    assertSesConfigured(runtime);
    if (runtime.config.multiTenant && connection) assertSharedAccount(runtime, connection); // Even a cached SDK client must not cross a rebind.
    let clients = runClients ?? sesClients.get(runtime);
    if (!clients) { clients = new Map(); sesClients.set(runtime, clients); }
    // The dispatcher leases the connection alongside the mail. One shared-account client can
    // sign for all Hosted tenants (TenantName is on the command); BYO role rotations must get
    // a new provider. Never put a request-bound client or pending STS promise across invocations.
    const key = runClients && connection
      ? JSON.stringify([selectedRegion, connection.kind, connection.aws_account_id, connection.role_arn, connection.external_id, connection.deliverySession])
      : connection ? JSON.stringify([selectedRegion, connection.id, connection.identitySession, connection.deliverySession]) : selectedRegion;
    let client = clients.get(key);
    if (!client) {
      client = new sesv2.SESv2Client({ region: selectedRegion, ...(runtime.config.multiTenant ? { credentials: () => creds.workspaceCredentials(runtime, selectedRegion, connection), ignoreConfiguredEndpointUrls: true } : { credentials: runtime.config.aws }), maxAttempts: 1, cacheMiddleware: !!runClients, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) });
      addSesBodySplice(client.middlewareStack);
      clients.set(key, client);
    }
    return client;
  };
  return { sesv2, getSesSync };
}
export async function getSes(runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): Promise<SESv2Client> {
  region(runtime, selectedRegion);
  assertSesConfigured(runtime);
  if (runtime.config.multiTenant && connection) assertSharedAccount(runtime,connection); // Even a cached SDK client must not cross a rebind.
  const { getSesSync } = await preloadSesTransport(runtime.config.multiTenant);
  return getSesSync(runtime, selectedRegion, connection, runClients);
}
// Transient database failures: the same request or job works once the database has recovered.
// Connection failures: the statement never reached the database or the connection dropped. Hyperdrive reports its own
// (pool exhausted, origin refused the connection) as SQLSTATE 58000; Postgres passes 53300 (too many connections),
// class 08 (connection exceptions) and 57P01-57P03 (shutdown, starting up); node-postgres throws plain errors when a
// socket drops.
// Refused or cancelled statements: Postgres kept nothing of the statement or of the transaction it ran in. The cluster
// is read-only (25006; a managed cluster whose disk is nearly full refuses every write this way, and PlanetScale's
// pg_readonly raises it without an SQLSTATE, so it arrives as XX000 and is told apart by its message, never by XX000
// alone), the disk is full (53100), or the statement was cancelled at statement_timeout (57014; a read's own budget is
// READ_TOO_LARGE instead, see budgetedRead) or after waiting lock_timeout for a lock (55P03).
// Either way, statements the request committed before the failing one stay, which is what Idempotency-Key is for.
// Drizzle wraps all of them, so read the cause chain.
const TRANSIENT_SQLSTATES = new Set(['58000', '53300', '57P01', '57P02', '57P03', '25006', '53100', '57014', '55P03']);
const READ_ONLY_CLUSTER = /^pg_readonly: invalid statement because cluster is read-only\b/;
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);
// node-postgres's pool checkout timeout is the same condition as Hyperdrive's "Failed to acquire a connection".
const TRANSIENT_DRIVER_MESSAGE = /^(?:Connection terminated(?: unexpectedly)?|Client has encountered a connection error and is not queryable|Failed to acquire a connection from the pool\.?|timeout exceeded when trying to connect|Server connection attempt failed: .+)$/;
const errorChain = (error: unknown) => { const chain: Error[] = []; try { for (let current = error; current instanceof Error && chain.length < 5; current = current.cause) chain.push(current); } catch { /* A throwing cause getter or proxy ends the chain. */ } return chain; };
/** The SQLSTATE behind an error, including one wrapped by Drizzle, for logs: a five-character string or nothing. */
export const databaseCodeOf = (error: unknown) => {
  for (const e of errorChain(error)) {
    let code: unknown;
    try { code = (e as { code?: unknown }).code; } catch { continue; }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
};
export function transientDatabaseError(error: unknown) {
  try {
    if (error instanceof ApiError) return false;
    return errorChain(error).some(e => {
      try {
        const code: unknown = (e as { code?: unknown }).code, message: unknown = e.message;
        return typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code) || TRANSIENT_SOCKET_CODES.has(code) || code === 'XX000' && typeof message === 'string' && READ_ONLY_CLUSTER.test(message))
          || typeof message === 'string' && TRANSIENT_DRIVER_MESSAGE.test(message);
      } catch { return false; }
    });
  } catch { return false; } // A hostile proxy is not a database error.
}
/** A transaction Postgres rolled back to break a deadlock (40P01) or a serialization conflict (40001): nothing it wrote
 * was kept, so the same request or job can safely run again. */
export const databaseConflict = (error: unknown) => !(error instanceof ApiError) && ['40P01', '40001'].includes(databaseCodeOf(error) ?? '');
/** What callers see when the database is briefly unreachable, read-only or too slow: retry (see TRANSIENT_SQLSTATES). */
export const databaseUnavailable = (background = false) => new ApiError(503, 'DATABASE_UNAVAILABLE', background ? 'The database was briefly unavailable; the job will be retried.' : 'The database is briefly unavailable. Retry the request.', undefined, true);
export { errorCodeOf, errorTypeOf, log, setLogContext, stackFrames } from './log.js';
/**
 * One line for an unexpected failure: its code, error class, SQLSTATE and Nightmail's own stack frames. Never a message:
 * neither the error's nor an ApiError's, whose text can quote request data (a template variable, a filename).
 */
export function logError(error: unknown, fields: Record<string, unknown> & { code: string; message?: never }, level: 'error' | 'warn' = 'error') {
  let entry: Record<string, unknown>;
  try {
    let known = false;
    try { known = error instanceof ApiError; } catch { /* A proxy: treat as unexpected. */ }
    // `code` usually comes from an ApiError; it is logged only as an error-code-shaped string.
    entry = { ...fields, code: errorCodeOf(fields.code), errorType: known ? undefined : errorTypeOf(error), databaseCode: databaseCodeOf(error), stack: known ? undefined : stackFrames(error) };
  } catch { return logFallback(); }
  log(level, entry);
}
/**
 * Why a platform call failed, for the few lines that must say so (a dispatcher run that failed): the error's own
 * message, cut to 300 characters; log scrubs addresses and credential-like runs from it like any string. Undefined for
 * an ApiError (its code says it), for anything that came from the database or a socket (a driver error's text quotes
 * the statement and its parameters, which can be a customer's data; its SQLSTATE is logged instead) and for an AWS SDK
 * error (its text can name an identity or a domain; its class name is logged instead). What is left is the platform's
 * own: a Durable Object storage or binding failure, a module that would not load. logError never logs a message; this
 * is the one explicit exception, passed as `cause`.
 */
export function platformMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error) || error instanceof ApiError) return undefined;
    for (const e of errorChain(error)) {
      const driver = e as { code?: unknown; severity?: unknown; query?: unknown; params?: unknown; name?: unknown; $metadata?: unknown; $fault?: unknown };
      if (typeof driver.code === 'string' || driver.severity !== undefined || driver.query !== undefined || driver.params !== undefined || driver.name === 'DrizzleQueryError' || driver.$metadata !== undefined || driver.$fault !== undefined) return undefined;
    }
    const message: unknown = error.message;
    return typeof message === 'string' && message ? message.slice(0, 300) : undefined;
  } catch { return undefined; }
}
export { SECURITY_HEADERS };
export function applySecurityHeaders(headers: Headers): Headers {
  // Route-specific policies (notably OAuth form redirects) take precedence.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return headers;
}
export function secureResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: applySecurityHeaders(new Headers(response.headers)) });
}
// HTTPS installations name auth cookies `__Host-nightmail.*`; plain-HTTP local development uses `nightmail.*`. A browser may
// still hold the pre-rename `bane.*` ones (account-login.ts reads and migrates them; remove after rename cleanup).
export function hasSessionCookie(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return Boolean(cookie && /(?:^|;\s*)(?:__Host-)?(?:nightmail|bane)\.session_token(?:\.\d+)?=[^;\s]/.test(cookie));
}
/** The routes Amazon SNS posts signed notifications to: SES feedback and connected accounts' stack requests. */
export const snsIngress = (path: string) => path === '/v1/events/ses' || path === '/v1/events/cloudformation';
export function publicFailureBucket(path: string, status: number, headers?: Headers): 'auth' | 'unsubscribe' | null {
  // SNS callers share egress addresses; reject untrusted topics/signatures without charging that pool.
  if (status < 400 || status >= 500 || snsIngress(path)) return null;
  if (/^\/unsubscribe(?:\/|$)/.test(path) || /^\/v1\/forwarding\//.test(path)) return 'unsubscribe';
  if (status !== 401 || !/^\/v1(?:\/|$)/.test(path)) return null;
  return headers && !headers.has('authorization') && !hasSessionCookie(headers) ? null : 'auth';
}
export function admissionPeer(address: string): string {
  if (!address.includes(':')) return address;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
    if (mapped) return mapped.slice(1).flatMap(v => [parseInt(v,16) >>> 8, parseInt(v,16) & 255]).join('.');
    const [left, right] = canonical.split('::');
    const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
    return [...a, ...Array(8-a.length-b.length).fill('0'), ...b].slice(0,4).join(':') + '::';
  } catch { return 'unknown'; }
}
// Cloudflare gives every cross-zone Worker subrequest the same client address and names the calling
// zone in CF-Worker, so callers on Workers (OpenCode Console among them) would otherwise share one
// admission bucket and one failure budget with every other Worker on the Internet. Only that egress
// address may choose a bucket this way; any other client keeps its own address.
const WORKER_EGRESS = admissionPeer('2a06:98c0:3600::103');
export function admissionKey(address: string, worker: string | null) {
  const zone = worker?.trim().toLowerCase();
  return address === WORKER_EGRESS && zone && /^[a-z0-9.-]{1,253}$/.test(zone) ? `worker:${zone}` : address;
}

// Identity entry has a request budget; authenticated API routes have a failure
// budget. Check completed failures before dispatch, never charge concurrency.
const failureCounts = new Map<string, number>();
let failureMinute = 0;
export function allowMalformedSns(peer: string) {
  const minute=Math.floor(Date.now()/60000);
  if(minute!==failureMinute){failureCounts.clear(); failureMinute=minute;}
  const key=`malformed-sns:${peer}`, count=failureCounts.get(key)??0;
  if(count>=40 || (!count && failureCounts.size>=4096)) return false;
  failureCounts.set(key,count+1); return true;
}
export async function guardPublicRequest(path: string, headers: Headers, peer: string, work: () => Promise<Response>) {
  const entry = /^\/(?:api\/auth|\.well-known)(?:\/|$)/.test(path) || path==='/mcp/login' || path==='/mcp/consent';
  const lane = entry ? 'identity-entry' : publicFailureBucket(path, 401, headers);
  if (!lane) return work();
  const minute = Math.floor(Date.now()/60000);
  if (minute !== failureMinute) { failureCounts.clear(); failureMinute = minute; }
  const key = `${lane}:${peer}`;
  // At capacity, rely on edge admission for unknown peers. Never share either
  // a penalty or an in-flight reservation between unrelated credentials.
  if (!failureCounts.has(key) && failureCounts.size >= 4096) return entry ? publicFailureDenied() : work();
  const count = failureCounts.get(key) ?? 0;
  if (count >= 40) return publicFailureDenied();
  if(entry) failureCounts.set(key,count+1);
  const response=await work();
  if(!entry && minute===failureMinute && publicFailureBucket(path,response.status,headers) && (failureCounts.has(key) || failureCounts.size<4096)) {
    failureCounts.set(key,Math.min(40,(failureCounts.get(key)??0)+1));
  }
  return response;
}
/**
 * One atomic per-minute counter in api_request_budgets, named by `key` within a workspace: true while this minute's
 * charges, this one included, stay within `limit`. A window stored in the future (an operator's or a test's hold) stays.
 */
/** Read-only check for whether a workspace's per-minute budget is already spent (does not increment usage). */
export async function budgetExhausted(runtime: Pick<Runtime, 'db'>, workspaceId: string, key: string, limit: number) {
  const { rows: [row] } = await runtime.db.execute<{ exhausted: boolean }>(sql`SELECT (window_start >= date_trunc('minute', now()) AND used >= ${limit}) AS exhausted FROM api_request_budgets WHERE workspace_id = ${workspaceId} AND key_id = ${key}`);
  return row?.exhausted === true;
}
export async function chargeBudget(runtime: Pick<Runtime, 'db'>, workspaceId: string, key: string, limit: number) {
  const { rows: [row] } = await runtime.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${workspaceId}, ${key}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN excluded.window_start > api_request_budgets.window_start THEN 1 ELSE least(api_request_budgets.used + 1, ${limit + 1}) END,
      window_start = greatest(api_request_budgets.window_start, excluded.window_start) RETURNING used`);
  return row!.used <= limit;
}
// All credentials and image-producing routes share one atomic workspace counter.
export async function chargeRenderBudget(c: Ctx, workspaceId: string) {
  const limit = 30;
  if (!await chargeBudget(c.env, workspaceId, 'render:images', limit)) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'RENDER_RATE_LIMITED', `This workspace allows ${limit} image previews and imports per minute. Retry after the window resets.`, undefined, true);
  }
}
export async function timed<T>(c: Ctx, name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { c.get('serverTimings').push({ name, durationMs: performance.now() - start }); }
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
export function notFound(entity: string): never { throw new ApiError(404, 'NOT_FOUND', `${entity} was not found.`); }
export const redactCapabilityText = (value: string) => value.replace(/u_[0-9a-f]{64}/g, '[redacted]');
export function redactCapabilityData(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return redactCapabilityText(item);
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [redactCapabilityText(key), redact(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCapabilityText(key), redact(item)]));
}
export function admissionDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'ADMISSION_RATE_LIMITED', operation: 'admission' });
  return secureResponse(Response.json({ error: { code: 'ADMISSION_RATE_LIMITED', message: 'Too many requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
export function publicFailureDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'PUBLIC_RATE_LIMITED', operation: 'public-failure' });
  return secureResponse(Response.json({ error: { code: 'PUBLIC_RATE_LIMITED', message: 'Too many failed public requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
