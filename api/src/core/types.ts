import { z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type SQL, sql } from 'drizzle-orm';
import type { ReadyConnection } from '../provider-credentials.js';
import { clientIpHeader } from '../brand.js';

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
 *  The reply is the one text here that a third party writes: the webhook's copy has no addresses (webhookData, sending/events.ts). */
export const EmailEventData = z.object({suppressionReason:SuppressionReason.optional(),
  bounceType:z.string().optional().describe('A bounce (email.bounced): SES bounceType — Permanent (hard bounce), Transient (soft bounce), Undetermined, or Unknown.'),
  bounceSubType:z.string().optional().describe('A bounce (email.bounced): SES bounceSubType, such as General, NoEmail, Suppressed, OnAccountSuppressionList, MailboxFull, MessageTooLarge, ContentRejected, AttachmentRejected, or EmailValidationSuppressed.'),
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
  /** An MCP sign-in: the account service's consent behind its token (oidc-resource.ts), which names the connection a staff member approved for the support inbox (support-agents.ts). */
  mcpConsent?: string;
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
  /** Hosted: staff members' approved agents may use the support inbox over MCP (src/support-agents.ts, SUPPORT_AGENT_ACCESS=on). Off unless set. */
  supportAgentAccess?: boolean;
  /** Hosted: email a domain's owners once when it is still pending an hour after it was added (src/domain-setup.ts, DOMAIN_SETUP_REMINDER=on). Off unless set. */
  /** Hosted: one NS lookup when a domain is added (createDomain, record-check.ts dnsZone). Always on for Hosted. */
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
  /** NIGHTMAIL_BUILTIN_REPLIES: a reply from a built-in domain may go once to a verified sender (builtin-domain.ts builtinReplyException); null: off. */
  builtinReplies?: { perDay: number; perRecipientPerDay: number; /** NIGHTMAIL_BUILTIN_SUPPORT_REPLIES; 0: support is never answered. */ supportPerDay: number } | null;
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
  /** NIGHTMAIL_LIST_RISK: the list-risk measure's private lines (src/list-risk-lines.ts). Null: the measure records no band. */
  listRisk?: import('../list-risk-lines.js').ListRiskLines | null;
  /** NIGHTMAIL_RAMP: the send review's private ramp sizing (src/ramp-lines.ts). Null: the defaults. */
  rampLines?: import('../ramp-lines.js').RampLinesOverride | null;
  /** NIGHTMAIL_ABUSE_MONITORING: abuse monitoring (src/abuse.ts) records from this instant on. Undefined: off. */
  abuseMonitoring?: { since: string };
  /** ABUSE_SLACK_WEBHOOK_URL, else OPERATOR_SLACK_WEBHOOK_URL: where abuse-monitoring alerts are posted (src/abuse-alerts.ts). Undefined: stored only. */
  abuseSlackWebhookUrl?: string;
  /** OPERATOR_SLACK_WEBHOOK_URL: where the operator alerts (src/operator-alerts.ts) and the health alerts (src/health.ts) are posted. Undefined: nothing is posted. */
  operatorSlackWebhookUrl?: string;
  /** OPERATOR_SLACK_MENTION: the Slack user ID urgent operator cards mention (src/operator-mention.ts). Undefined: no card mentions anyone. */
  operatorSlackMention?: string;
  /** DATABASE_DISK_GB in bytes: the Health page shows the database's size against it. Undefined: the size alone. */
  databaseDiskBytes?: number;
  /** DEPLOY_SHA and DEPLOY_AT: the commit this deploy runs and when it went out (Glass). Null when not set. */
  deploy?: { sha: string | null; at: string | null };
  /** PLANETSCALE_WEBHOOK_SECRET: the database disk alert also checks PlanetScale's signature (src/disk-alert.ts). Undefined: token alone; null: invalid configured signer, webhook disabled. */
  planetscaleWebhookSecret?: string | null;
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
  linkWarmup?: { initial: number; full: number; days: number; workspacePercent: number };
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
  /** Node's independent pool for deprecation counters. Never record on a request's transaction. */
  deprecatedCallDb?: Database;
  deprecatedCallScope?: object; // Stable database binding across Worker invocations.
  /** Wakes inbox long polls as mail is stored (inbox-wake.ts): the DISPATCHER namespace on Workers, pg_notify on Node. */
  inboxWake?: import('../inbox-wake.js').InboxWake;
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
  campaignRooms?: { connect: (name: string, person: import('../campaign-room-protocol.js').RoomPerson) => Promise<Response>; visit: (name: string, credential: string, lookup: (runtime: Runtime) => Promise<string | null>, saved?: number) => void };
  /** Where the screen's requests go to be repeated to the second classifier (src/screen-shadow.ts flushShadow), on a
   *  platform that must not make those calls in the invocation that sends mail: Cloudflare puts them on a queue whose
   *  consumer makes them. Returns at once and never throws. Without it they run in this process, in the background. */
  shadow?: (items: import('../screen-shadow.js').ShadowItem[]) => void;
  // Verified provider feedback (and simulated callbacks) leave the request path through this
  // sink and are ingested in batches, never through the sending jobs table.
  feedback?: { enqueue: (items: FeedbackItem[]) => Promise<void> };
  allowFeedbackTopic?: (arn:string)=>Promise<boolean>;
  allowSnsCertMiss?: (peer: string) => Promise<boolean>;
  snsCertificateState?: import('../ses/sns-ingress.js').SnsCertificateState; // Omitted by production: share one state per isolate, not per request.
  allowMalformedSns?: (peer: string) => Promise<boolean>;
  // A peer's failed SNS verifications across isolates (Workers: the ADMISSION limiter, weighted); false spends its budget.
  allowSnsFailure?: (peer: string) => Promise<boolean>;
  snsFailureBudget?: import('../ses/sns-ingress.js').SnsFailureBudget; // Tests only: production shares one per isolate.
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
export type MailboxAccess = { keyId: string; grantId?:string; workspaceId: string; admin: boolean; mailboxIds: string[] | null; scopeIds?: string[] | null; permissions: import('../db/mailbox.js').MailboxPermission[];
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
export type AccountRequestMetrics = { discoveryCacheHit?: boolean; parRequests?: number; tokenRequests?: number };
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; boundedBody?: boolean; importLease?: import('../isolate-memory.js').MemoryLease; importLeaseTransferred?: boolean; requestId: string; serverTimings: { name: string; durationMs: number }[]; mailboxAccess?: MailboxAccess;
  /** Elapsed time asleep between long-poll reads; queries and reauthorization are active request time. */
  pollWaitMs?: number;
  accountRequestMetrics?: AccountRequestMetrics;
  rateLimitedWorkspace?: string; // The verified credential's workspace, when the budget refuses it before the actor is set.
  /** The error code and field a failed request answered with, for its request log line. `unmatched`: no route did. */
  failure?: { code: string; mcpStale?: import('../mcp-session.js').StaleReason; field?: string; databaseCode?: string; unmatched?: boolean; origin?: { originClass: string; fetchSite?: string }; attachmentTypes?: AttachmentTypes; reason?: string };
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
export type JobContext = { id: string; attempts: number; workspaceId: string; startedAt?: number;
  /** The claim's lease (lease_until as claimed): the job is still this runner's while it matches. Absent when a handler is called directly. */
  leaseFence?: string;
  ingest?:import('../mailbox-ingest-input.js').IngestInput|null;
  deleteBinding?:ReadyConnection|null; webhook?: ClaimedWebhook | null; recordWithSettlement?: (ctes: import('drizzle-orm').SQL) => void };
export type JobBatchItem = { payload: Record<string, unknown>; job: JobContext };
export type JobBatchOutcome = { id: string; error?: unknown };
export type JobHandler = ((runtime: Runtime, payload: Record<string, unknown>, job: JobContext) => Promise<void>) & {
  /** Optional batch entry point for >= 2 same-workspace jobs claimed together. Returns one outcome per item. */
  batch?: (runtime: Runtime, items: JobBatchItem[]) => Promise<JobBatchOutcome[]>;
};

/** A refused attachment's declared type, the type its bytes are and its name's extension. */
export type AttachmentTypes = { declaredType: string; detectedType: string; extension: string };
