import { capabilityPattern, UNSUBSCRIBE_TOKEN, FORWARD_CONFIRM_TOKEN, FORWARD_STOP_TOKEN, SIGNIN_LINK_TOKEN } from '../capabilities.js';
import { HTTPException } from 'hono/http-exception';
import { z } from '@hono/zod-openapi';
import { schemaIssues as describeSchemaIssues, errorCodeOf, errorTypeOf, stackFrames, logFallback, log } from '../log.js';
import { API_FIELD_NAMES } from '../api-field-names.js';
import { productName } from '../brand.js';
import type { AttachmentTypes, Permission, Ctx, Actor } from './types.js';

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
  /** Which condition refused it, as a fixed code the request log may carry (builtin-domain.ts BuiltinReplyRefusal), never text. */
  logReason?: string;
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
export function requiredFor(method: string, path: string, need?: Permission | 'editContent' | import('../db/mailbox.js').MailboxPermission): Required {
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
let apiFieldNames: ReadonlySet<string> | undefined;
/** What a schema refused, where a path keeps only the field names the API publishes (log.ts schemaIssues). Built once
 *  from the generated list; nothing adds to it. */
export const schemaIssues = (error: unknown) => describeSchemaIssues(error, apiFieldNames ??= new Set(API_FIELD_NAMES));
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
    // A schema refusal (our own parse of an answer or a stored value) says where and what kind, never the value (schemaIssues).
    entry = { ...fields, code: errorCodeOf(fields.code), errorType: known ? undefined : errorTypeOf(error), databaseCode: databaseCodeOf(error), schema: known ? undefined : schemaIssues(error),
      stack: known ? undefined : stackFrames(error) };
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
export function notFound(entity: string): never { throw new ApiError(404, 'NOT_FOUND', `${entity} was not found.`); }
// Every bearer capability (src/capabilities.ts): a reader without manage sees none of them in mail, events or replies.
const CAPABILITIES = capabilityPattern(UNSUBSCRIBE_TOKEN, FORWARD_CONFIRM_TOKEN, FORWARD_STOP_TOKEN, SIGNIN_LINK_TOKEN);
export const redactCapabilityText = (value: string) => value.replace(CAPABILITIES, '[redacted]');
export function redactCapabilityData(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return redactCapabilityText(item);
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [redactCapabilityText(key), redact(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCapabilityText(key), redact(item)]));
}
