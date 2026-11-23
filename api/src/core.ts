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
  // Number of emails queued per region, for a bounded post-commit wake.
  dispatchTargets?: Map<string, { count: number; priority: boolean }>;
  dispatchAccount?: { aws_account_id: string; kind: ReadyConnection['kind'] };
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
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** The object's body as a stream from the bucket, for responses that should not buffer it (preview links). */
  stream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Up to 1,000 objects in key order after `after`; `cursor` continues the listing and is absent at its end. */
  list?(prefix: string, after?: string): Promise<{ objects: { key: string; uploaded: Date }[]; cursor?: string }>;
}
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
  /** Self-hosted: subjects (or '*') that become owners of 'default' at their first sign-in. */
  defaultWorkspaceOwners: '*' | string[];
  multiTenant: boolean;
  platformAccount?: string;
  /** The one Hosted workspace that may own the installation's own domain (PUBLIC_URL's host). */
  platformDomainWorkspace?: string;
  /** Hosted only: From for Nightmail's own owner notices (sender standing), on the platform workspace's domain. */
  notifyFrom?: string;
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
  /** NIGHTMAIL_ABUSE_MONITORING: abuse monitoring (src/abuse.ts) records from this instant on. Undefined: off. */
  abuseMonitoring?: { since: string };
  /** ABUSE_SLACK_WEBHOOK_URL: where abuse-monitoring alerts are posted (src/abuse-alerts.ts). Undefined: stored only. */
  abuseSlackWebhookUrl?: string;
  /** OPERATOR_SLACK_WEBHOOK_URL: where the operator alerts are posted (src/operator-alerts.ts). Undefined: nothing is posted. */
  operatorSlackWebhookUrl?: string;
  /** NIGHTMAIL_ABUSE_ENFORCE. Reserved: abuse monitoring never blocks, and no code reads this yet. */
  abuseEnforce?: boolean;
  /** Hosted billing. stripe is undefined until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set (money routes answer 503 BILLING_NOT_CONFIGURED). */
  billing?: { stripe?: { secretKey: string; webhookSecret: string; automaticTax: boolean; apiBase: string } };
  placementShadow?: boolean;
  placementDblZone?: string;
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
  sesFeedbackUrl?: string;
  regions: string[];
  liveEnabled: boolean;
  simulatedSes: { latencyMs: number; maxSendRate: number; deliveryDelayMs: number };
  // Pacing target relative to the provider quota: factor (1.1 aims 10% above) and an optional absolute live rate.
  dispatch: { rateFactor: number; targetRate?: number; dailyHeadroomPercent: number; customerSharePercent: number };
  encryptionKey: string;
  previousEncryptionKey?: string;
  awsAccountId?: string;
  snsTopicArns: string[];
  // Subset of snsTopicArns that carries SES inbound receipt notifications for mailboxes.
  inboundTopicArns?: string[];
  reputationAlertUrl?: string;
  // Opt-in Jev content screen for live transactional sends with `screen: true`; undefined without TYPESAFE_API_KEY.
  screen?: { apiKey: string; endpoint: string; model: string; mode: 'reject' | 'flag'; threshold: number };
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
  // Nudges the long-lived dispatcher for one account/region after queued mail commits. Dispatch
  // never depends on it: the dispatcher also polls and the scheduler pings it every minute.
  dispatch?: (region: string, accountId?: string, emails?: number, kind?: ReadyConnection['kind'], priority?: boolean) => Promise<void>;
  /** True once the content classifier must not be called in this run (src/dispatcher-do.ts: a request landed on the shard,
   *  and a call now would carry its visitor). Checked right before each request; a call not made throws ScreenHandover. */
  screenHandover?: () => boolean;
  // Verified provider feedback (and simulated callbacks) leave the request path through this
  // sink and are ingested in batches, never through the sending jobs table.
  feedback?: { enqueue: (items: FeedbackItem[]) => Promise<void> };
  allowFeedbackTopic?: (arn:string)=>Promise<boolean>;
  allowSnsCertMiss?: (peer: string) => Promise<boolean>;
  snsCertificateState?: import('./operations.js').SnsCertificateState; // Omitted by production: share one state per isolate, not per request.
  allowMalformedSns?: (peer: string) => Promise<boolean>;
  // A workspace's preview memory a minute (Workers: the ADMISSION limiter, weighted by bytes). Node has only the per-process budget.
  allowPreview?: (workspaceId: string, bytes: number) => Promise<boolean>;
  // Dashboard analytics (src/analytics.ts): the Workers ANALYTICS bucket and the ANALYTICS_INGEST limiter. Node uses
  // the installation's bucket and a per-process cap.
  analyticsStorage?: Storage;
  allowAnalytics?: (peer: string) => Promise<boolean>;
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
export type MailboxAccess = { keyId: string; grantId?:string; workspaceId: string; admin: boolean; mailboxIds: string[] | null; scopeIds?: string[] | null; permissions: import('./db/mailbox.js').MailboxPermission[] };
/**
 * A support conversation (src/support-conversations.ts) as supportGate loaded it: its person, the workspace whose content
 * they shared, and the workspaces this route's dashboard counterpart lets the person's role read now.
 */
export type SupportScope = { userId: string; contentWorkspaceId: string | null;
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[];
  conversation: { id: string; channel: 'chat' | 'email'; verification: string; workspaceId: string | null } };
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; boundedBody?: boolean; requestId: string; serverTimings: { name: string; durationMs: number }[]; mailboxAccess?: MailboxAccess;
  /** The error code and field a failed request answered with, for its request log line. `unmatched`: no route did. */
  failure?: { code: string; field?: string; databaseCode?: string; unmatched?: boolean };
  /** Who a protocol handler authenticated (MCP authenticates inside its route), for the request log line. */
  principal?: { type: string; workspace?: string }; support?: SupportScope } };
export type App = OpenAPIHono<AppEnv>;
export type Ctx = Context<AppEnv>;
/** Who sent a request: its ID, and the client's address and user agent as the entry point (server.ts, worker.ts) set them. */
export type RequestOrigin = { requestId: string; clientIp: string | null; userAgent: string | null };
// An in-process call (an MCP tool) is part of its outer request and keeps that request's ID, client and user agent.
// It rides on the runtime under a private symbol, like the delegated actor, so no header can supply it.
const outerRequest = Symbol('outerRequest');
export const withOuterRequest = <R extends Runtime>(runtime: R, origin: RequestOrigin): R => ({ ...runtime, [outerRequest]: origin });
const outerOf = (runtime: Runtime | undefined) => (runtime as (Runtime & { [outerRequest]?: RequestOrigin }) | undefined)?.[outerRequest];
/** A new request's ID: the outer request's for an in-process call. */
export const newRequestId = (runtime: Runtime | undefined) => outerOf(runtime)?.requestId ?? `req_${crypto.randomUUID().replaceAll('-', '')}`;
export const requestOrigin = (c: Ctx): RequestOrigin => outerOf(c.env)
  ?? { requestId: c.get('requestId'), clientIp: c.req.header(clientIpHeader) ?? null, userAgent: c.req.header('user-agent') ?? null };
/** One claimed delivery and what its endpoint needs to post it. `type` is the endpoint's (absent for sent-mail webhooks); url and encrypted_secret are a webhook's. */
export type ClaimedWebhook = { type?: 'webhook' | 'slack' | 'discord' | 'forward'; routed?:boolean;format?:string;name?:string;include?:string[];timeout_seconds?:number;retry_attempts?:number; delivery_id: string; generation: number; event_id: string; payload: unknown; synthetic: boolean; webhook_id: string; url: string; encrypted_secret: string; encrypted_headers: string | null; owned?: boolean };
export type JobHandler = (runtime: Runtime, payload: Record<string, unknown>, job: { id: string; attempts: number; workspaceId: string;
  /** The claim's lease (lease_until as claimed): the job is still this runner's while it matches. Absent when a handler is called directly. */
  leaseFence?: string;
  ingest?:import('./mailbox-ingest-input.js').IngestInput|null;
  deleteBinding?:ReadyConnection|null; webhook?: ClaimedWebhook | null; recordWithSettlement?: (ctes: import('drizzle-orm').SQL) => void }) => Promise<void>;

export class ApiError extends Error {
  /** Structured detail for errors that have several parts, such as rule compile diagnostics. */
  details?: Record<string, unknown>[];
  /** The field names a log line may name: the schema's own, never a key the caller sent (app.ts invalidFields). */
  logField?: string;
  /** What a permission refusal needs (denied): error.required and the Nightmail-Required-Permission header. */
  required?: Required;
  /** The workspace whose daily limit refused this send (admission.ts): the error handler queues its once-a-day email and operator alert. */
  limitReachedFor?: string;
  constructor(public status: number, public code: string, message: string, public field?: string, public retryable = false, public resetAt?: string) { super(message); }
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
  ['audience', /^\w+ \/v1\/(?:contacts|lists|newsletters|segments|contact-imports|audience-query|templates|template-assets|campaign-content-guide|campaigns)(?:\/|$)/],
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
/** UNRESTRICTED_KEY_REQUIRED: a credential limited to sender domains is refused a workspace-wide area. */
export const unrestrictedRequired = (message: string, need: Required) => denied('UNRESTRICTED_KEY_REQUIRED', message, { ...need, scope: 'workspace' });
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
export async function budgetedRead<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>, budget: ReadBudget): Promise<T> {
  if (!Number.isInteger(budget.seconds) || budget.seconds < 1) throw new Error('A read budget is a whole number of seconds.');
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${budget.seconds}s'`));
      return work(tx);
    }, { accessMode: 'read only' });
  } catch (error) {
    if (statementTimedOut(error)) throw budget.refusal();
    throw error;
  }
}
/** A statement ended by statement_timeout (SQLSTATE 57014), as the driver reports it or wraps it. */
export const statementTimedOut = (error: unknown) => [error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014');
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
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
export function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url') : null;
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
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, requiredOf(c, action));
  return value;
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
  if (!a || (!a.permissions.includes('manage') && !a.permissions.includes(permission))) return denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, need);
  if (a.domains.length || a.role === 'member')
    return denied('ADMIN_REQUIRED', 'Receiving configuration covers every address in the workspace. Use an owner or admin session, or an API key with manage permission on all domains.', a.role === 'member' ? { ...need, person: 'admin' } : { ...need, scope: 'workspace' });
  if (!change) return null;
  if (a.grantId && !a.receivingConsent) return denied('ADMIN_REQUIRED', 'Changing receiving configuration requires an owner or admin of this workspace.', { ...need, person: 'admin' });
  return lastingRefusal(a, change, need);
}
/** Key administration (auth.ts manageKeys, and the deprecated inbound key routes): why it refuses this actor, or null.
 *  It takes unrestricted manage and a lasting credential. */
export function keyAdminRefusal(a: Actor): ApiError | null {
  const need: Required = { permission: 'configuration', level: 'write' };
  if (!a.permissions.includes('manage')) return denied('PERMISSION_DENIED', 'This operation requires manage permission.', need);
  const temporary = lastingRefusal(a, KEY_CHANGE, need);
  if (temporary) return temporary;
  if (a.domains.length) return denied('PERMISSION_DENIED', 'Key administration requires unrestricted management access.', { ...need, scope: 'workspace' });
  return null;
}
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
export const unrestrictedRoute = (path: string) => /^\/v1\/(?:contacts|lists|newsletters|segments|contact-imports|audience-query|settings|webhooks|metrics|sender-score|usage|billing|regions|app-passwords)(?:\/|$)/.test(path)
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
  if (actor.domains.length) return 'UNRESTRICTED_KEY_REQUIRED';
  if (!actor.permissions.includes('manage') && actor.credential === 'apiKey' && actor.permissions.includes('read') && method.toUpperCase() === 'GET' && /^\/v1\/inbound\/webhooks(?:\/[^/]+)?$/.test(path))
    return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: [] };
  return actorMailAccess(actor) ?? 'ADMIN_REQUIRED';
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
// Database connection failures are transient: the statement never reached the database or the connection dropped.
// Hyperdrive reports its own failures (pool exhausted, origin refused the connection) as SQLSTATE 58000; Postgres
// passes 53300 (too many connections), class 08 (connection exceptions) and 57P01-57P03 (shutdown, starting up);
// node-postgres throws plain errors when a socket drops. Drizzle wraps all of them, so read the cause chain.
const TRANSIENT_SQLSTATES = new Set(['58000', '53300', '57P01', '57P02', '57P03']);
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
        return typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code) || TRANSIENT_SOCKET_CODES.has(code)) || typeof message === 'string' && TRANSIENT_DRIVER_MESSAGE.test(message);
      } catch { return false; }
    });
  } catch { return false; } // A hostile proxy is not a database error.
}
/** A transaction Postgres rolled back to break a deadlock (40P01) or a serialization conflict (40001): nothing it wrote
 * was kept, so the same request or job can safely run again. */
export const databaseConflict = (error: unknown) => !(error instanceof ApiError) && ['40P01', '40001'].includes(databaseCodeOf(error) ?? '');
/** What callers see when the database is briefly unreachable: retry, nothing was committed by this request. */
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
