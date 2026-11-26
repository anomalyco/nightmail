import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, denied, errors, hasSessionCookie, id, json, notFound, response, timed, webhookUrlHint, withoutVerdict, type App, type AppEnv, type Ctx, type DbExecutor, type SupportScope } from './core.js';
import { AuditEntry, AuditFilters, auditContext, auditInsert, customerTrail, operatorRequired, requireOperator, userEmail } from './audit.js';
import { supportRead, withRedactedReply } from './deliverability.js';
import { GOOD_STANDING, limitRequest, type Step } from './standing-model.js';
import { cached, registerSupportDeliverability } from './support-deliverability.js';
import { registerSupportReceiving } from './support-receiving.js';
import { registerSupportSmtp } from './smtp-refusals.js';
import { ERROR_CODE, groupLines, LOG_RETENTION_DAYS, LOG_ROWS, LogsUnavailable, requestLines, ROUTE_TEMPLATE, type RequestLine } from './support-logs.js';
import { CONVERSATION_ID, keyId, signSupportToken } from './support-platform.js';
import { ceilingFor, routedOnly, sectionIds } from './support-conversations.js';
import { productName } from './brand.js';

// Support integration (api/README.md "Support integration"). Internal: these routes are for Nightmail's operators and its
// support platform, never for customers.
//
// 1. A signed-in member presses "Contact support" (POST /v1/contact-support): Nightmail stores a handoff (workspace, user,
//    page, recent request IDs, and whether they share message content for this request) and returns the support
//    platform's URL carrying an Ed25519-signed handoff token.
// 2. The support platform registers a conversation from that handoff (src/support-conversations.ts): Nightmail checks
//    its own signature and the unused handoff row, and binds the conversation to that person and workspace, once.
// 3. The agent reads the account only through SupportPlatform.request(conversationId, …), which puts the conversation on
//    the runtime, never in a request. Every /v1/support/* route derives the customer from the conversation's row; a
//    workspaceId filter can only narrow it. Every call is written to audit_events, and each workspace's Activity shows
//    "Nightmail support viewed this workspace" once per conversation. Never secrets; message content only with the
//    customer's own opt-in in that chat.
//
// Access: /v1/operator/* answers only an operator (operatorGate), /v1/support/* only an open, registered conversation
// (supportGate). Every other credential, including a workspace owner's session, gets the same 403 for every path under
// them, real or not.

/** Requests per minute per support conversation. */
export const SUPPORT_RATE_PER_MINUTE = 120;
/**
 * The deliverability reads (src/support-deliverability.ts) aggregate up to 30 days of mail, the routes read tallies 7 days of
 * deliveries per destination (src/support-receiving.ts), and the request reads ask Workers Logs (src/support-logs.ts): each
 * costs 5 of the 120.
 */
export const SUPPORT_EXPENSIVE_WEIGHT = 5;
const EXPENSIVE = /^\/v1\/support\/(?:deliverability\/[^/]+|screen|campaigns(?:\/[^/]+(?:\/lint)?)?|audience\/health|domains\/[^/]+\/health|emails\/[^/]+\/lint|requests(?:\/[^/]+)?|receiving\/routes)$/;
export const supportWeight = (path: string) => EXPENSIVE.test(path) ? SUPPORT_EXPENSIVE_WEIGHT : 1;
const supportRequired = () => new ApiError(403, 'SUPPORT_GRANT_REQUIRED', `This area is for ${productName} support, for an open support conversation.`);

/**
 * /v1/operator and /v1/operator/*: an operator's dashboard session, or the support platform through the SupportPlatform
 * service binding (src/support-platform.ts) on the support routes only, else 403. No bearer token is an operator: the
 * static platform token (BANE_SUPPORT_PLATFORM_TOKEN) is retired. The one bearer credential here is a UI notes key
 * (src/ui-notes.ts), and only on the requests notesKeyRoute names: reading UI notes, setting their status and reading
 * the installation's health.
 */
export const operatorGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  // A self-hosted installation has no operator area, with one exception: its Health page (src/health.ts), for anyone
  // signed in to its dashboard. The route itself refuses any other credential.
  if (!c.env.config.multiTenant) {
    if (c.req.method !== 'GET' || c.req.path !== '/v1/operator/health' || c.req.header('authorization') !== undefined || !hasSessionCookie(c.req.raw.headers)) throw operatorRequired();
    const { authenticate } = await import('./auth.js');
    return authenticate(c, next);
  }
  if (c.req.header('authorization') !== undefined) {
    const { notesKeyRoute, authenticateNotesKey } = await import('./ui-notes.js');
    if (!notesKeyRoute(c.req.method, c.req.path) || c.env.platformCaller) throw operatorRequired();
    await authenticateNotesKey(c);
    return next();
  }
  if (c.env.platformCaller === 'bane-support') {
    if (!c.req.path.startsWith('/v1/operator/support/') || c.env.supportConversation !== undefined) throw operatorRequired();
    const { chargeGrantBudget, checkBudget } = await import('./auth.js');
    checkBudget(c, await timed(c, 'budget-db', () => chargeGrantBudget(c.env, 'platform', 'ops_support')), c.env.config.apiRateLimitPerMinute);
    c.set('actor', { workspaceId: '', permissions: [], domains: [], keyId: 'service:bane-support', credential: 'operatorService' });
    return next();
  }
  if (!hasSessionCookie(c.req.raw.headers)) throw operatorRequired();
  const { authenticate } = await import('./auth.js');
  try { await authenticate(c, async () => {}); await requireOperator(c, 'operator:read'); }
  catch (error) { if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) throw operatorRequired(); throw error; }
  // Staff UI notes are for UI_NOTES_SUBJECTS only: any other operator gets 404 before a body is even read.
  if (/^\/v1\/operator\/ui-note(?:s|-keys)(?:\/|$)/.test(c.req.path)) {
    const { uiNotesAllowed } = await import('./operator-identity.js');
    if (!(await uiNotesAllowed(c.env.db, c.env.config.uiNotesSubjects, c.get('actor').keyId.slice(5)))) notFound('Endpoint');
  }
  return next();
};

/**
 * /v1/support/*: only SupportPlatform.request() names a conversation (Runtime.supportConversation, never a header,
 * query parameter or body), and any credential on the request refuses it. One statement loads the open conversation (it
 * must have a user), joins that user's live memberships within its scope and filters them by the roles this route's
 * dashboard counterpart admits (SUPPORT_CEILINGS), charges the conversation's minute budget (supportWeight: 5 for an
 * aggregate read, else 1), writes the internal support.read row and, the first time the conversation reads a workspace,
 * the customer-visible "support.view". A route without a ceiling is refused, and an email conversation is refused a
 * chat's own routes (changes, notes, billing, the activity trail, request logs, webhooks and receiving configuration): it
 * reads only the account's status, domains and sending, and narrows its workspace.
 */
export const supportGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const conversationId = c.env.supportConversation;
  if (conversationId === undefined || !c.env.config.multiTenant || c.env.platformCaller !== 'bane-support' || !CONVERSATION_ID.test(conversationId) || c.req.header('authorization') !== undefined || hasSessionCookie(c.req.raw.headers)) throw supportRequired();
  const ceiling = ceilingFor(c.req.method, c.req.path);
  if (!ceiling) {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw new ApiError(403, 'SUPPORT_READ_ONLY', 'A support conversation can only read, choose its workspace and keep notes.');
    return notFound('Endpoint');
  }
  const filter = c.req.query('workspaceId') ?? null, context = auditContext(c), limit = SUPPORT_RATE_PER_MINUTE, weight = supportWeight(c.req.path), label = `${productName} support`;
  const query = Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => [k.slice(0, 40), v.join(',').slice(0, 120)]).slice(0, 12));
  const call = { route: c.req.path.slice(0, 200), method: c.req.method, query };
  const { rows: [conv] } = await timed(c, 'support-db', () => c.env.db.execute<{ id: string; user_id: string; channel: 'chat' | 'email'; verification: string; workspace_id: string | null;
    content_workspace_id: string | null; used: number; workspaces: SupportScope['workspaces'] }>(sql`WITH conv AS (
      UPDATE support_conversations SET used = CASE WHEN window_start = date_trunc('minute', now()) THEN least(used + ${weight}::int, ${limit + 1}) ELSE ${weight}::int END,
        window_start = date_trunc('minute', now()), last_used_at = now()
      WHERE id = ${conversationId} AND status <> 'closed' AND user_id IS NOT NULL AND (${ceiling.chatOnly !== true}::boolean OR channel = 'chat')
      RETURNING id, user_id, channel, verification, workspace_id, content_workspace_id, used
    ), scope AS (
      SELECT m.workspace_id AS id, w.name, m.role FROM conv JOIN workspace_members m ON m.user_id = conv.user_id AND (conv.workspace_id IS NULL OR m.workspace_id = conv.workspace_id)
        JOIN workspaces w ON w.id = m.workspace_id WHERE m.role = ANY(${sql.param(ceiling.roles)}::text[])
    ), logged AS (
      INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, actor_label, via, action, target_type, target_id, summary, ticket_ref, request_id, ip_network, user_agent, internal, retain_until)
      SELECT (SELECT id FROM scope WHERE id = ${filter}), conv.user_id, 'support', conv.id, ${label}::text, 'support', 'support.read', 'user', conv.user_id,
        ${JSON.stringify(call)}::jsonb || jsonb_build_object('channel', conv.channel, 'workspaces', (SELECT coalesce(jsonb_agg(id), '[]') FROM scope)), conv.id,
        ${context.requestId}, ${context.ipNetwork}, ${context.userAgent}, true, now() + interval '90 days' FROM conv WHERE conv.used <= ${limit}
    ), viewed AS (
      INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, actor_label, via, action, target_type, target_id, summary, ticket_ref, request_id, internal, retain_until)
      SELECT s.id, conv.user_id, 'support', conv.id, ${label}::text, 'support', 'support.view', 'workspace', s.id,
        jsonb_build_object('ticket', conv.id, 'member', conv.user_id, 'channel', conv.channel, 'verification', conv.verification, 'contentShared', coalesce(conv.content_workspace_id = s.id, false)),
        conv.id, ${context.requestId}, false, now() + interval '1 year' FROM conv, scope s
      WHERE ${ceiling.views !== false} AND conv.used <= ${limit} AND (${filter}::text IS NULL OR s.id = ${filter})
      ON CONFLICT (actor_id, workspace_id) WHERE action = 'support.view' DO NOTHING
    ) SELECT conv.id, conv.user_id, conv.channel, conv.verification, conv.workspace_id, conv.content_workspace_id, conv.used,
      coalesce((SELECT json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY name, id) FROM scope), '[]') AS workspaces FROM conv`));
  if (!conv) {
    // Nothing was charged or logged: say why when it is an email conversation asking for a chat's route.
    if (ceiling.chatOnly && (await c.env.db.execute(sql`SELECT FROM support_conversations WHERE id = ${conversationId} AND channel = 'email' AND status <> 'closed' AND user_id IS NOT NULL`)).rows.length)
      throw new ApiError(403, 'SUPPORT_CHAT_ONLY', 'An email support conversation reads only the account’s status, domains and sending, and narrows its workspace: changes, notes, billing, the activity trail, request logs, webhooks and receiving configuration are a chat’s.');
    throw supportRequired();
  }
  if (conv.used > limit) { c.header('Retry-After', '60'); throw new ApiError(429, 'REQUEST_RATE_LIMITED', `A support conversation may make ${limit} requests a minute. Retry after the window resets.`, undefined, true); }
  // Content only where the customer opted in (a chat's own workspace), and only while they still belong to it.
  const contentWorkspaceId = conv.workspaces.some(w => w.id === conv.content_workspace_id) ? conv.content_workspace_id : null;
  const scope: SupportScope = { userId: conv.user_id, contentWorkspaceId, workspaces: conv.workspaces,
    conversation: { id: conv.id, channel: conv.channel, verification: conv.verification, workspaceId: conv.workspace_id } };
  if (filter !== null && !scope.workspaces.some(w => w.id === filter)) notFound('Workspace');
  c.set('support', scope);
  c.set('actor', { workspaceId: filter ?? scope.workspaces[0]?.id ?? '', permissions: [], domains: [], keyId: conv.id, credential: 'support' });
  return next();
};

// ---------- the customer's in-app handoff ----------

/** A handoff opens at most one conversation, within this many minutes; its signed token lives 10 minutes. */
const HANDOFF_MINUTES = 30, HANDOFF_TOKEN_SECONDS = 600, HANDOFFS_PER_HOUR = 10;
const Handoff = z.object({
  id: z.string().describe('The support reference (sho_…). Quote it to support.'),
  url: z.string().nullable().describe('Where to continue with support, carrying the signed handoff; null when no support site is configured.'),
  token: z.string().nullable().describe('The signed handoff (EdDSA JWS, 10 minutes), or null when signing is not configured.'),
  expiresAt: z.string().describe('Until when support can use this handoff to open read access (30 minutes, once).'),
  shareContent: z.boolean(),
}).openapi('SupportHandoff');

// ---------- what support reads ----------

const WorkspaceFilter = z.object({ workspaceId: z.string().max(100).optional().describe('Only this workspace; it must be one of the conversation’s. Omit for all of them.') });
const Page = z.object({ cursor: z.string().max(200).optional().describe('nextCursor from the previous page.'), limit: z.coerce.number().int().min(1).max(100).default(25) });
const Since = z.object({ since: z.iso.datetime().optional().describe('Only items at or after this time (default: 7 days ago).') });
const tags = ['Support (internal)'];
const supportSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }];
const describe = (text: string) => `${text} Internal: for ${productName} support’s conversations, through the support platform’s binding, never for customers.`;
function scoped(c: Ctx, roles?: ('owner' | 'admin' | 'member')[]) {
  const scope = c.get('support')!, filter = c.req.query('workspaceId');
  const workspaces = scope.workspaces.filter(w => (!filter || w.id === filter) && (!roles || roles.includes(w.role)));
  return { scope, ids: workspaces.map(w => w.id), workspaces };
}
const ids = (list: string[]) => sql`${sql.param(list)}::text[]`;
const DAY = 86_400_000, RECENT_REQUEST_HOURS = 6;
/**
 * What Nightmail recorded for one request in these workspaces: its request lines from Workers Logs (the last
 * LOG_RETENTION_DAYS days), the changes it made, the campaign launches it started and the routing versions it wrote.
 * GET /v1/support/requests/{requestId} answers it for a conversation's workspaces, and the feedback triage agent's trace
 * (src/feedback-triage.ts) for the one workspace a report belongs to. The request line is looked for in the last 6 hours
 * first (most requests quoted are recent, and a short window answers several times faster), then in the whole retention
 * window; the database reads run meanwhile.
 */
export async function requestTrace(c: Ctx, list: string[], requestId: string) {
  const db = c.env.db, observability = c.env.config.observability;
  const logLines = async () => {
    if (!observability) return { logs: [] as Omit<RequestLine, 'requestId'>[], logsAvailable: false };
    try {
      const now = Date.now(), { lines } = await cached(c, 'request', list, requestId, async () => {
        const recent = await requestLines(observability, { workspaceIds: list, from: now - RECENT_REQUEST_HOURS * 3_600_000, to: now + 60_000, requestId, limit: 20 });
        return recent.lines.length ? recent : requestLines(observability, { workspaceIds: list, from: now - LOG_RETENTION_DAYS * DAY, to: now + 60_000, requestId, limit: 20 });
      });
      return { logs: lines.map(({ requestId: _r, ...line }) => line), logsAvailable: true };
    } catch (error) { if (!(error instanceof LogsUnavailable)) throw error; return { logs: [], logsAvailable: false }; }
  };
  const [{ logs, logsAvailable }, { data: auditEvents }, { rows: campaigns }, { rows: routing }] = await Promise.all([
    logLines(), customerTrail(db, list, AuditFilters.parse({ requestId, limit: 20 })),
    list.length ? db.execute<{ workspaceId: string; id: string; name: string; state: string; error: unknown }>(sql`SELECT workspace_id AS "workspaceId", id, coalesce(draft ->> 'name', id) AS name, state, error
      FROM sending_campaigns WHERE request_id = ${requestId} AND workspace_id = ANY(${ids(list)}) LIMIT 20`) : { rows: [] },
    list.length ? db.execute<{ workspaceId: string; version: number; resourceId: string; at: string }>(sql`SELECT workspace_id AS "workspaceId", version, resource_id AS "resourceId", created_at::text AS at
      FROM mail_routing_audit WHERE request_id = ${requestId} AND workspace_id = ANY(${ids(list)}) LIMIT 50`) : { rows: [] },
  ]);
  const changed = !!(auditEvents.length || campaigns.length || routing.length);
  return { requestId, found: changed || logs.length > 0, changed, logs, logsAvailable, auditEvents, campaigns, routingVersions: routing.map(r => ({ ...r, at: new Date(r.at).toISOString() })) };
}
/** A conversation reads received mail as the dashboard shows it to the role (actorMailAccess): a member only mail on receiving addresses. */
function receivedAsMember(workspaces: SupportScope['workspaces']) {
  const members = routedOnly(workspaces);
  return members.length ? sql`AND (workspace_id <> ALL(${ids(members)}) OR EXISTS (SELECT FROM mailbox_messages mm WHERE mm.message_id = mail_messages.id AND mm.workspace_id = mail_messages.workspace_id))` : sql``;
}
const sinceOf = (since: string | undefined, days = 7) => since ?? new Date(Date.now() - days * 86_400_000).toISOString();
function keyset(cursor: string | undefined) {
  if (!cursor) return null;
  const [at, key] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !key || Number.isNaN(Date.parse(at))) throw new ApiError(422, 'INVALID_CURSOR', 'The cursor is not valid. Start again without it.', 'cursor');
  return { at, key };
}
const nextCursor = <T extends { at_text: string; key: string }>(rows: T[], limit: number) => rows.length > limit ? Buffer.from(`${rows[limit - 1]!.at_text}|${rows[limit - 1]!.key}`).toString('base64url') : null;
const strip = <T extends Record<string, unknown>>(row: T) => { const { at_text: _a, key: _k, ...rest } = row; return rest; };

const WorkspaceSummary = z.object({
  id: z.string(), name: z.string(), role: z.enum(['owner', 'admin', 'member']).describe('The customer’s role in this workspace.'), createdAt: z.string(),
  sending: z.object({ kind: z.string().describe(`shared (${productName} Hosted) or byo (their own AWS).`), region: z.string(), state: z.string().nullable(), paused: z.boolean(), pauseReason: z.string().nullable(),
    dailyLimitOverride: z.number().nullable() }).nullable().describe('The sending connection, or null when none is set up.'),
  counts: z.record(z.string(), z.number()).describe('How many of each resource the workspace has: domains, apiKeys, webhooks, inboxes, addresses, routes, endpoints, campaigns, templates, contacts (counted up to 100,000).'),
}).openapi('SupportWorkspace');
const DomainSummary = z.object({
  workspaceId: z.string(), id: z.string(), name: z.string(), region: z.string().nullable(), createdAt: z.string().nullable(),
  sending: z.string().nullable().describe('pending, verified, failed or lost.'), dkim: z.string().nullable(), mailFrom: z.string().nullable(), dmarc: z.string().nullable(),
  receiving: z.string().nullable().describe('off, pending, active or lost.'), lostSince: z.string().nullable(),
}).openapi('SupportDomain');
const EmailSummary = z.object({
  workspaceId: z.string(), id: z.string(), direction: z.enum(['sent', 'received']), at: z.string(), from: z.string(), to: z.array(z.string()), subject: z.string(),
  status: z.string(), errorCode: z.string().nullable(), suppressionReason: z.string().nullable(), campaignId: z.string().nullable(), kind: z.string().nullable(), simulated: z.boolean().nullable(),
  providerMessageId: z.string().nullable().describe('The SES message ID, for provider-side lookups.'),
}).openapi('SupportEmail');
const DeliveryEvent = z.object({ workspaceId: z.string(), id: z.string(), emailId: z.string(), type: z.string().describe('send, delivery, bounce, complaint, reject, open, click…'), at: z.string(),
  detail: z.record(z.string(), z.unknown()).describe('The provider’s event detail (bounce type, complaint feedback type, and for a bounce or a delay the receiving server’s reply in diagnosticCode, redacted: addresses are <address>, IPs <ip>, 160 characters). Never the content screen’s score, model or threshold on a refused email.') }).openapi('SupportDeliveryEvent');
const WebhookDelivery = z.object({ workspaceId: z.string(), id: z.string(), source: z.enum(['email', 'inbound']).describe('email: sending events; inbound: received mail.'), webhookId: z.string(),
  endpoint: z.string().describe('The last four characters of the URL; URLs are credentials.'), eventType: z.string().nullable(), status: z.string(), attempts: z.number(), lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('SupportWebhookDelivery');
const Standing = z.object({ workspaceId: z.string(), connection: z.record(z.string(), z.unknown()).nullable(), limits: z.record(z.string(), z.unknown()),
  standing: z.record(z.string(), z.unknown()).nullable().describe('The sender standing (step, reasons, score, daily limit) where the reputation system is enabled.'),
  last24h: z.record(z.string(), z.number()).describe('Sent mail in the last 24 hours by status (counted up to 50,000).') }).openapi('SupportStanding');

/** `email`: the API-key count is left out (an email conversation never reads keys). */
async function workspaceSummaries(db: DbExecutor, list: SupportScope['workspaces'], email = false) {
  if (!list.length) return [];
  const { rows } = await db.execute<{ id: string; created_at: string; sending: z.infer<typeof WorkspaceSummary>['sending']; counts: Record<string, number> }>(sql`SELECT w.id, w.created_at::text,
      (SELECT json_build_object('kind', pc.kind, 'region', pc.region, 'state', to_jsonb(pc) ->> 'state', 'paused', pc.paused_at IS NOT NULL, 'pauseReason', left(to_jsonb(pc) ->> 'pause_reason', 300),
        'dailyLimitOverride', w.send_cap_override) FROM provider_connections pc WHERE pc.workspace_id = w.id) AS sending,
      json_build_object('domains', (SELECT count(*) FROM operation_domains WHERE workspace_id = w.id), 'apiKeys', (SELECT count(*) FROM api_keys WHERE workspace_id = w.id AND revoked_at IS NULL),
        'webhooks', (SELECT count(*) FROM operation_webhooks WHERE workspace_id = w.id) + (SELECT count(*) FROM mailbox_webhooks WHERE workspace_id = w.id AND type = 'webhook'),
        'inboxes', (SELECT count(*) FROM mailboxes WHERE workspace_id = w.id AND kind = 'inbox'), 'addresses', (SELECT count(*) FROM mailboxes WHERE workspace_id = w.id AND kind = 'address'),
        'routes', (SELECT count(*) FROM mail_routes WHERE workspace_id = w.id), 'endpoints', (SELECT count(*) FROM mailbox_webhooks WHERE workspace_id = w.id AND type <> 'webhook'),
        'campaigns', (SELECT count(*) FROM sending_campaigns WHERE workspace_id = w.id), 'templates', (SELECT count(*) FROM campaign_templates WHERE workspace_id = w.id),
        'contacts', (SELECT count(*) FROM (SELECT FROM audience_contacts WHERE workspace_id = w.id LIMIT 100000) x)) AS counts
    FROM workspaces w WHERE w.id = ANY(${ids(list.map(w => w.id))})`);
  const counts = (all: Record<string, number> | undefined) => { if (!all || !email) return all ?? {}; const { apiKeys: _keys, ...rest } = all; return rest; };
  return list.map(w => { const r = rows.find(x => x.id === w.id); return { ...w, createdAt: r ? new Date(r.created_at).toISOString() : '', sending: r?.sending ?? null, counts: counts(r?.counts) }; });
}
async function domainSummaries(db: DbExecutor, list: string[], limit = 200) {
  if (!list.length) return [];
  return (await db.execute<z.infer<typeof DomainSummary>>(sql`SELECT d.workspace_id AS "workspaceId", d.id, d.name, d.region, d.created_at::text AS "createdAt",
      c.claim ->> 'sending_state' AS sending, c.claim #>> '{identity,ses,DkimAttributes,Status}' AS dkim, c.claim #>> '{identity,ses,MailFromAttributes,MailFromDomainStatus}' AS "mailFrom",
      c.claim #>> '{identity,dmarc,status}' AS dmarc, c.claim ->> 'receiving_state' AS receiving, c.claim ->> 'lost_since' AS "lostSince"
    FROM operation_domains d LEFT JOIN LATERAL (SELECT to_jsonb(dc) AS claim FROM domain_claims dc WHERE dc.name = d.name AND dc.workspace_id = d.workspace_id) c ON true
    WHERE d.workspace_id = ANY(${ids(list)}) ORDER BY d.workspace_id, d.name LIMIT ${limit}`)).rows;
}
async function standings(db: DbExecutor, list: string[]) {
  if (!list.length) return [];
  const { rows } = await db.execute<z.infer<typeof Standing>>(sql`SELECT w.id AS "workspaceId",
      (SELECT jsonb_build_object('kind', pc.kind, 'region', pc.region, 'state', to_jsonb(pc) ->> 'state', 'pausedAt', pc.paused_at, 'pauseReason', left(to_jsonb(pc) ->> 'pause_reason', 300),
        'resumedAt', to_jsonb(pc) ->> 'resumed_at') FROM provider_connections pc WHERE pc.workspace_id = w.id) AS connection,
      jsonb_build_object('dailyOverride', w.send_cap_override, 'pendingOverride', w.pending_cap_override, 'exempt', w.exempt_hosted_quotas,
        'overrideExpiresAt', to_jsonb(w) ->> 'send_cap_override_expires_at') AS limits,
      -- What the customer's own score card and banners show (#115), never operator-only fields such as the watch flag.
      (SELECT jsonb_build_object('step', s.step, 'since', s.since, 'reasons', s.reasons, 'phase', s.phase, 'score', s.score, 'dailyLimit', s.daily_limit, 'factors', s.factors,
        'pauseKind', s.pause_kind, 'marketingHold', s.marketing_hold, 'releaseUntil', s.release_until, 'releasePercent', s.release_percent, 'strikes', jsonb_array_length(s.strikes),
        'strikeUntil', s.strike_until, 'version', s.version) FROM sender_standing s WHERE s.workspace_id = w.id) AS standing,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int AS n FROM (SELECT status FROM sending_emails
        WHERE workspace_id = w.id AND created_at > now() - interval '24 hours' LIMIT 50000) x GROUP BY status) y) AS "last24h"
    FROM workspaces w WHERE w.id = ANY(${ids(list)}) ORDER BY w.name, w.id`);
  return rows;
}
/** The last 24 hours' failures; webhook deliveries only of `hooks` (a conversation's: where its role reads webhooks). */
async function failures(db: DbExecutor, list: string[], hooks = list) {
  if (!list.length) return { sends: [] as Record<string, unknown>[], bounces: [] as Record<string, unknown>[], webhookDeliveries: [] as Record<string, unknown>[] };
  type Row = Record<string, unknown>;
  const { rows: [row] } = await db.execute<{ sends: Row[]; bounces: Row[]; webhooks: Row[] }>(sql`SELECT
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", status, coalesce(error_code, suppression_reason, status) AS code, count(*)::int AS count, max(created_at)::text AS "lastAt"
      FROM (SELECT workspace_id, status, error_code, suppression_reason, created_at FROM sending_emails WHERE workspace_id = ANY(${ids(list)}) AND created_at > now() - interval '24 hours'
        AND status IN ('failed','rejected','suppressed','canceled','bounced','complained','acceptance_unknown') LIMIT 20000) e GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS sends,
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", type, coalesce(data #>> '{bounce,bounceType}', data #>> '{complaint,complaintFeedbackType}', data ->> 'code') AS reason,
      count(*)::int AS count FROM (SELECT workspace_id, type, data FROM sending_email_events WHERE workspace_id = ANY(${ids(list)}) AND created_at > now() - interval '24 hours'
        AND type IN ('bounce','complaint','reject') LIMIT 20000) v GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS bounces,
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", webhook_id AS "webhookId", source, count(*)::int AS count, max(last_status_code) AS "lastStatusCode",
      left(max(last_error), 300) AS "lastError" FROM (SELECT workspace_id, webhook_id, 'email' AS source, last_status_code, last_error FROM operation_deliveries
        WHERE workspace_id = ANY(${ids(hooks)}) AND status = 'failed' AND updated_at > now() - interval '24 hours'
      UNION ALL SELECT workspace_id, webhook_id, 'inbound', last_status_code, last_error FROM mailbox_webhook_deliveries
        WHERE workspace_id = ANY(${ids(hooks)}) AND status = 'failed' AND updated_at > now() - interval '24 hours') d GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS webhooks`);
  return { sends: row!.sends, bounces: row!.bounces, webhookDeliveries: row!.webhooks };
}

/** The operator routes for the support platform. */
export function registerSupportOperator(app: App) {
  const operatorSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'get', path: '/v1/operator/support/handoffs/{id}', operationId: 'operatorGetSupportHandoff',
    request: { params: z.object({ id: z.string().regex(/^sho_[0-9a-f]{32}$/) }) },
    responses: { 200: response(z.object({ id: z.string(), userId: z.string(), workspaceId: z.string(), kind: z.string(), page: z.string().nullable(), requestIds: z.array(z.string()), message: z.string().nullable(),
      shareContent: z.boolean(), createdAt: z.string(), expiresAt: z.string(), usedAt: z.string().nullable(), conversationId: z.string().nullable() })), ...errors } }), async c => {
    await requireOperator(c, 'operator:read');
    const { rows: [row] } = await c.env.db.execute<{ id: string; userId: string; workspaceId: string; kind: string; page: string | null; requestIds: string[]; message: string | null; shareContent: boolean; createdAt: string; expiresAt: string; usedAt: string | null; conversationId: string | null }>(sql`SELECT id,
      user_id AS "userId", workspace_id AS "workspaceId", kind, page, request_ids AS "requestIds", message, share_content AS "shareContent", created_at::text AS "createdAt", expires_at::text AS "expiresAt",
      used_at::text AS "usedAt", conversation_id AS "conversationId" FROM support_handoffs WHERE id = ${c.req.valid('param').id}`);
    if (!row) notFound('Handoff');
    return c.json({ ...row!, createdAt: new Date(row!.createdAt).toISOString(), expiresAt: new Date(row!.expiresAt).toISOString(), usedAt: row!.usedAt ? new Date(row!.usedAt).toISOString() : null }, 200);
  });
}

/** The customer's "Contact support", the public signing keys and a conversation's read routes. */
export function registerSupport(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-support', operationId: 'contactSupport', tags: ['Workspaces'], security: [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[],
    description: 'Hosted: start a support request from the dashboard. Returns a support reference and, when configured, the support site’s URL carrying a signed handoff (this workspace, you, the page and recent request IDs). Support reads message content only if shareContent is true, only in this workspace and only for this request (one conversation, within 30 minutes). Any member may contact support.',
    request: { body: json(z.object({
      kind: z.enum(['support', 'appeal', 'limit_request']).default('support'),
      page: z.string().trim().max(200).regex(/^\/[^\s]*$/).optional().describe('The dashboard path the person was on.'),
      requestIds: z.array(z.string().regex(/^req_[0-9a-f]{32}$/)).max(5).default([]).describe('x-request-id values of recent failed requests.'),
      shareContent: z.boolean().default(false).describe('Let support read message content (email bodies) in this workspace, for this request only.'),
      message: z.string().trim().max(2000).optional(),
    }).strict()) },
    responses: { 201: response(Handoff), ...errors } }), async c => {
    if (!c.env.config.multiTenant) notFound('Endpoint');
    const a = c.get('actor');
    if (a?.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const body = c.req.valid('json'), userId = a.keyId.slice(5), handoffId = id('sho');
    const { rows: [row] } = await c.env.db.execute<{ id: string; expires_at: string; name: string; email: string }>(sql`WITH h AS (
        INSERT INTO support_handoffs(id, user_id, workspace_id, kind, page, request_ids, message, share_content, expires_at)
        SELECT ${handoffId}, ${userId}, ${a.workspaceId}, ${body.kind}, ${body.page ?? null}, ${sql.param(body.requestIds)}::text[], ${body.message ?? null}, ${body.shareContent}, now() + ${`${HANDOFF_MINUTES} minutes`}::interval
        WHERE (SELECT count(*) FROM support_handoffs WHERE user_id = ${userId} AND created_at > now() - interval '1 hour') < ${HANDOFFS_PER_HOUR}
        RETURNING id, expires_at
      ), logged AS (${auditInsert(auditContext(c), { action: 'support.contact', workspaceId: a.workspaceId, target: { type: 'support_handoff', id: handoffId },
        after: { kind: body.kind, page: body.page, requestIds: body.requestIds, contentShared: body.shareContent } }, { where: sql`EXISTS (SELECT FROM h)` })})
      SELECT h.id, h.expires_at::text, w.name, ${userEmail(sql`${userId}`)} AS email FROM h, workspaces w WHERE w.id = ${a.workspaceId}`);
    if (!row) { c.header('Retry-After', '3600'); throw new ApiError(429, 'SUPPORT_RATE_LIMITED', `You can contact support ${HANDOFFS_PER_HOUR} times an hour. Email support with your earlier reference instead.`, undefined, true); }
    const support = c.env.config.support, now = Math.floor(Date.now() / 1000);
    const token = support?.signingKey ? await signSupportToken(support.signingKey, { iss: c.env.config.publicUrl, aud: 'bane-support', jti: handoffId, iat: now, exp: now + HANDOFF_TOKEN_SECONDS,
      kind: body.kind, workspace: { id: a.workspaceId, name: row.name }, user: { id: userId, email: row.email, role: a.role }, page: body.page ?? null, requestIds: body.requestIds,
      shareContent: body.shareContent, message: !!body.message }) : null;
    const url = support?.url ? `${support.url}#${token ? `handoff=${token}` : `handoffId=${handoffId}`}` : null;
    return c.json({ id: handoffId, url, token, expiresAt: new Date(row.expires_at).toISOString(), shareContent: body.shareContent }, 201);
  });
  app.get('/v1/public/support-keys', async c => {
    const key = c.env.config.support?.signingKey;
    c.header('cache-control', 'public, max-age=300');
    return c.json({ keys: key ? [{ kty: 'OKP', crv: 'Ed25519', x: key.x, kid: await keyId(key.x), alg: 'EdDSA', use: 'sig' }] : [] });
  });

  // ---------- GET /v1/support/* (supportGate has loaded the conversation and logged the call) ----------
  const meta = (operationId: string, description: string) => ({ hide: true, method: 'get' as const, operationId, tags, security: supportSecurity, description: describe(description) });

  const Context = z.object({
    grant: z.object({ id: z.string(), ticketRef: z.string(), expiresAt: z.string(), contentShared: z.boolean().describe('Whether this request may read email bodies (the customer opted in).'),
      contentWorkspaceId: z.string().nullable().describe('The one workspace whose email bodies this request may read, or null.') })
      .describe('The support conversation: id and ticketRef are its ID, and expiresAt is the time of this read, since a conversation’s access is checked on every request.'),
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), createdAt: z.string().nullable() }),
    workspaces: z.array(WorkspaceSummary), domains: z.array(DomainSummary).describe('Up to 50 domains across the workspaces.'),
    recentFailures: z.object({ since: z.string(), sends: z.array(z.record(z.string(), z.unknown())).describe('Failed, rejected, suppressed and bounced sends in the last 24 hours, by code.'),
      bounces: z.array(z.record(z.string(), z.unknown())).describe('Bounce, complaint and reject events in the last 24 hours, by reason.'),
      webhookDeliveries: z.array(z.record(z.string(), z.unknown())).describe('Webhook deliveries that failed in the last 24 hours, by webhook.'),
      authErrors: z.null().describe(`${productName} does not store failed sign-ins or rejected API keys; look up a request ID instead.`) }),
    standing: z.array(Standing), recentActivity: z.array(AuditEntry).describe('The last 20 customer-visible audit entries (owner and admin workspaces).'),
    openEnforcement: z.array(z.object({ workspaceId: z.string(), kind: z.string(), since: z.string().nullable(), reason: z.string().nullable() })).describe('Paused sending and paused campaigns.'),
    handoff: z.object({ id: z.string(), page: z.string().nullable(), requestIds: z.array(z.string()), message: z.string().nullable(), createdAt: z.string() }).nullable().describe('What the customer sent from "Contact support", for a chat opened from it.'),
    links: z.object({ requestIds: z.array(z.string()).describe('Request IDs to look up with /v1/support/requests/{requestId}.') }),
  }).openapi('SupportContext');
  app.openapi(createRoute({ ...meta('getSupportContext', 'Start here: one compact summary of the customer for a support conversation: who they are, their workspaces and roles, sending setup and limits, domains and their verification, failures in the last 24 hours, open enforcement, the last 20 audit entries and request IDs to drill into.'), path: '/v1/support/context', request: { query: WorkspaceFilter }, responses: { 200: response(Context), ...errors } }), async c => {
    const { scope, ids: list, workspaces } = scoped(c), email = scope.conversation.channel === 'email', db = c.env.db;
    // A conversation reads domains and webhook failures only where its role reads them in the dashboard (CONTEXT_SECTIONS).
    // Email reads the account's status, domains and sending only: no activity trail (it carries key and billing events),
    // no webhook failures, no request IDs and no API-key count; those sections stay empty.
    const admin = email ? [] : workspaces.filter(w => w.role !== 'member').map(w => w.id);
    const domainIds = sectionIds('domains', workspaces), hookIds = email ? [] : sectionIds('webhookDeliveries', workspaces);
    // Independent reads, in parallel (the support platform's runtime has a pool for this: src/worker.ts).
    const [{ rows: [user] }, { rows: [handoff] }, summaries, domains, recent, activity, stand, { rows: enforcement }] = await Promise.all([
      db.execute<{ id: string; name: string | null; email: string | null; created_at: string | null }>(sql`SELECT id, name, email, created_at::text FROM nightmail_users WHERE id = ${scope.userId}`),
      db.execute<{ id: string; page: string | null; request_ids: string[]; message: string | null; created_at: string }>(sql`SELECT h.id, h.page, h.request_ids, h.message, h.created_at::text FROM support_handoffs h WHERE h.conversation_id = ${scope.conversation.id}`),
      workspaceSummaries(db, workspaces, email), domainSummaries(db, domainIds, 50), failures(db, list, hookIds), admin.length ? customerTrail(db, admin, AuditFilters.parse({ limit: 20 })) : Promise.resolve({ data: [] as z.infer<typeof AuditEntry>[] }), standings(db, list),
      db.execute<{ workspaceId: string; kind: string; since: string | null; reason: string | null }>(sql`SELECT workspace_id AS "workspaceId", 'sending_paused' AS kind, paused_at::text AS since,
          left(to_jsonb(pc) ->> 'pause_reason', 300) AS reason FROM provider_connections pc WHERE workspace_id = ANY(${ids(list)}) AND paused_at IS NOT NULL
        UNION ALL SELECT workspace_id, 'campaign_paused:' || id, paused_at::text, left(pause_reason::text, 300) FROM sending_campaigns WHERE workspace_id = ANY(${ids(list)}) AND state = 'paused' LIMIT 20`),
    ]);
    const requestIds = email ? [] : [...new Set([...(handoff?.request_ids ?? []), ...activity.data.map(e => e.requestId).filter((r): r is string => !!r)])].slice(0, 10);
    return c.json({ grant: { id: scope.conversation.id, ticketRef: scope.conversation.id, expiresAt: new Date().toISOString(), contentShared: !!scope.contentWorkspaceId, contentWorkspaceId: scope.contentWorkspaceId },
      user: { id: scope.userId, name: user?.name ?? null, email: user?.email ?? null, createdAt: user?.created_at ? new Date(user.created_at).toISOString() : null },
      workspaces: summaries, domains, recentFailures: { since: new Date(Date.now() - 86_400_000).toISOString(), ...recent, authErrors: null }, standing: stand, recentActivity: activity.data,
      openEnforcement: enforcement.map(e => ({ ...e, since: e.since ? new Date(e.since).toISOString() : null })),
      handoff: handoff ? { id: handoff.id, page: handoff.page, requestIds: handoff.request_ids, message: handoff.message, createdAt: new Date(handoff.created_at).toISOString() } : null,
      links: { requestIds } }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportWorkspaces', 'The customer’s workspaces with their role, sending connection and resource counts.'), path: '/v1/support/workspaces', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(WorkspaceSummary) })), ...errors } }), async c =>
    c.json({ data: await workspaceSummaries(c.env.db, scoped(c).workspaces, c.get('support')!.conversation.channel === 'email') }, 200));
  app.openapi(createRoute({ ...meta('listSupportDomains', 'Every domain with its sending verification (DKIM, MAIL FROM, DMARC) and receiving state.'), path: '/v1/support/domains', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(DomainSummary) })), ...errors } }), async c =>
    c.json({ data: await domainSummaries(c.env.db, scoped(c).ids) }, 200));

  const EmailQuery = WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    direction: z.enum(['sent', 'received']).default('sent'),
    status: z.string().max(40).optional().describe('Sent: queued, accepted, delivered, bounced, complained, failed, suppressed, canceled…; received: received, held…'),
    address: z.string().trim().toLowerCase().max(254).optional().describe('Only mail to or from this exact address.'),
  });
  app.openapi(createRoute({ ...meta('listSupportEmails', 'Sent or received mail, newest first: addresses, subject, status and error codes. Never bodies; read one email for its events (and its body when the customer shared content).'), path: '/v1/support/emails', request: { query: EmailQuery }, responses: { 200: response(z.object({ data: z.array(EmailSummary), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), { scope, ids: list, workspaces } = scoped(c), cursor = keyset(q.cursor), routed = receivedAsMember(workspaces);
    // Email reads sending only: an email conversation lists no received mail.
    if (!list.length || (q.direction === 'received' && scope.conversation.channel === 'email')) return c.json({ data: [], nextCursor: null }, 200);
    // Equality on the leading workspace column lets each ordered index seek stop after one page. An exact address matches
    // too few rows for that: the seek would read the whole window one row at a time, so it keeps the parallel scan and sort.
    const seek = !q.address;
    const wid = !seek ? sql`ANY(${ids(list)})` : list.length === 1 ? sql`${list[0]}` : sql`granted.wid`;
    const page = q.direction === 'sent' ? sql`SELECT workspace_id AS "workspaceId", id, 'sent' AS direction, created_at::text AS at_text,
        id AS key, created_at::text AS at, from_address AS "from", to_addresses AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", campaign_id AS "campaignId",
        snapshot ->> 'kind' AS kind, simulated, provider_id AS "providerMessageId" FROM sending_emails
      WHERE workspace_id = ${wid} AND created_at >= ${sinceOf(q.since)}::timestamptz ${q.status ? sql`AND status = ${q.status}` : sql``}
        ${q.address ? sql`AND (lower(from_address) = ${q.address} OR to_addresses ? ${q.address} OR cc_addresses ? ${q.address} OR bcc_addresses ? ${q.address})` : sql``}
        ${cursor ? sql`AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
      ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`
      : sql`SELECT workspace_id AS "workspaceId", id, 'received' AS direction, received_at::text AS at_text, id AS key,
        received_at::text AS at, from_address AS "from", envelope_to AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", NULL AS "campaignId",
        CASE WHEN spam THEN 'spam' WHEN automated THEN 'automated' END AS kind, NULL::boolean AS simulated, ses_message_id AS "providerMessageId" FROM mail_messages
      WHERE workspace_id = ${wid} AND direction = 'inbound' AND received_at >= ${sinceOf(q.since)}::timestamptz ${routed} ${q.status ? sql`AND status = ${q.status}` : sql``}
        ${q.address ? sql`AND (lower(from_address) = ${q.address} OR envelope_to ? ${q.address})` : sql``}
        ${cursor ? sql`AND (received_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
      ORDER BY received_at DESC, id DESC LIMIT ${q.limit + 1}`;
    const { rows } = await c.env.db.execute<z.infer<typeof EmailSummary> & { at_text: string; key: string }>(!seek || list.length === 1 ? page : sql`
      SELECT p.* FROM unnest(${ids(list)}) AS granted(wid) CROSS JOIN LATERAL (${page}) p
      ORDER BY p.at_text::timestamptz DESC, p.key DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit).map(r => ({ ...strip(r), at: new Date(r.at).toISOString() })), nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  const EmailDetail = EmailSummary.extend({
    events: z.array(DeliveryEvent).describe('Delivery events for a sent email, oldest first.'),
    authentication: z.record(z.string(), z.unknown()).nullable().describe('SPF, DKIM and DMARC verdicts of a received email.'),
    content: z.object({ subject: z.string(), text: z.string().nullable(), html: z.string().nullable() }).nullable().describe('The body, only when the customer shared message content with this request and the email is in that workspace (grant.contentWorkspaceId); otherwise null.'),
  }).openapi('SupportEmailDetail');
  app.openapi(createRoute({ ...meta('getSupportEmail', 'One sent or received email with its delivery events; its body only when the customer shared message content with this request.'), path: '/v1/support/emails/{id}', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(EmailDetail), ...errors } }), async c => {
    const { scope, ids: list, workspaces } = scoped(c), emailId = c.req.valid('param').id, db = c.env.db, routed = receivedAsMember(workspaces), shared = (workspace: SQL) => scope.contentWorkspaceId ? sql`${workspace} = ${scope.contentWorkspaceId}` : sql`false`;
    const { rows: [sent] } = await db.execute<z.infer<typeof EmailSummary> & { snapshot: { subject?: string; text?: string; html?: string } }>(sql`SELECT workspace_id AS "workspaceId", id, 'sent' AS direction,
        created_at::text AS at, from_address AS "from", to_addresses AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", campaign_id AS "campaignId",
        snapshot ->> 'kind' AS kind, simulated, provider_id AS "providerMessageId", CASE WHEN ${shared(sql`workspace_id`)} THEN jsonb_build_object('subject', snapshot -> 'subject', 'text', snapshot -> 'text', 'html', snapshot -> 'html') END AS snapshot
      FROM sending_emails WHERE id = ${emailId} AND workspace_id = ANY(${ids(list)})`);
    if (sent) {
      const { rows: events } = await db.execute<z.infer<typeof DeliveryEvent>>(sql`SELECT workspace_id AS "workspaceId", id, email_id AS "emailId", type, created_at::text AS at, data AS detail
        FROM sending_email_events WHERE workspace_id = ${sent.workspaceId} AND email_id = ${sent.id} ORDER BY created_at, id LIMIT 100`);
      const { snapshot, ...rest } = sent;
      return c.json({ ...rest, at: new Date(sent.at).toISOString(), events: events.map(e => ({ ...e, at: new Date(e.at).toISOString(), detail: withRedactedReply(withoutVerdict(e.detail ?? {})) })), authentication: null,
        content: snapshot ? { subject: snapshot.subject ?? sent.subject, text: snapshot.text ?? null, html: snapshot.html ?? null } : null }, 200);
    }
    // Email reads sending only: an email conversation opens no received message.
    if (scope.conversation.channel === 'email') notFound('Email');
    const { rows: [received] } = await db.execute<z.infer<typeof EmailSummary> & { verdicts: Record<string, unknown> | null; text: string | null; html: string | null }>(sql`SELECT workspace_id AS "workspaceId", id,
        'received' AS direction, received_at::text AS at, from_address AS "from", envelope_to AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", NULL AS "campaignId",
        CASE WHEN spam THEN 'spam' WHEN automated THEN 'automated' END AS kind, NULL::boolean AS simulated, ses_message_id AS "providerMessageId", verdicts,
        CASE WHEN ${shared(sql`workspace_id`)} THEN text END AS text, CASE WHEN ${shared(sql`workspace_id`)} THEN html END AS html, ${shared(sql`workspace_id`)} AS content_shared
      FROM mail_messages WHERE id = ${emailId} AND workspace_id = ANY(${ids(list)}) AND direction = 'inbound' ${routed}`);
    if (!received) notFound('Email');
    const { verdicts, text, html, content_shared: contentShared, ...rest } = received! as typeof received & { content_shared: boolean };
    return c.json({ ...rest, at: new Date(received!.at).toISOString(), events: [], authentication: verdicts ?? null, content: contentShared ? { subject: received!.subject, text, html } : null }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportEvents', 'Delivery events of sent mail (send, delivery, bounce, complaint, reject, open, click), newest first.'), path: '/v1/support/events', request: { query: WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    emailId: z.string().max(120).optional(), type: z.string().max(40).optional() }) }, responses: { 200: response(z.object({ data: z.array(DeliveryEvent), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, cursor = keyset(q.cursor);
    if (!list.length) return c.json({ data: [], nextCursor: null }, 200);
    const { rows } = await c.env.db.execute<z.infer<typeof DeliveryEvent> & { at_text: string; key: string }>(sql`SELECT workspace_id AS "workspaceId", id, email_id AS "emailId", type, created_at::text AS at,
        created_at::text AS at_text, id AS key, data AS detail FROM sending_email_events
      WHERE workspace_id = ANY(${ids(list)}) AND created_at >= ${sinceOf(q.since)}::timestamptz ${q.emailId ? sql`AND email_id = ${q.emailId}` : sql``} ${q.type ? sql`AND type = ${q.type}` : sql``}
        ${cursor ? sql`AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``} ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit).map(r => ({ ...strip(r), at: new Date(r.at).toISOString(), detail: withRedactedReply(withoutVerdict(r.detail ?? {})) })), nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportWebhookDeliveries', 'Webhook deliveries (sending events and received mail), newest first, with attempts, the last HTTP status and error. Never payloads or URLs.'), path: '/v1/support/webhook-deliveries', request: { query: WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    status: z.enum(['pending', 'delivered', 'failed', 'paused']).optional(), webhookId: z.string().max(120).optional() }) }, responses: { 200: response(z.object({ data: z.array(WebhookDelivery), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, cursor = keyset(q.cursor);
    if (!list.length) return c.json({ data: [], nextCursor: null }, 200);
    const filters = (t: SQL) => sql`${t}.workspace_id = ANY(${ids(list)}) AND ${t}.updated_at >= ${sinceOf(q.since)}::timestamptz ${q.status ? sql`AND ${t}.status = ${q.status}` : sql``} ${q.webhookId ? sql`AND ${t}.webhook_id = ${q.webhookId}` : sql``}`;
    const { rows } = await c.env.db.execute<z.infer<typeof WebhookDelivery> & { at_text: string; key: string; url: string | null }>(sql`SELECT * FROM (
        SELECT d.workspace_id AS "workspaceId", d.id, 'email' AS source, d.webhook_id AS "webhookId", w.url, d.payload ->> 'type' AS "eventType", d.status, d.attempt_count AS attempts,
          d.last_status_code AS "lastStatusCode", left(d.last_error, 300) AS "lastError", d.created_at::text AS "createdAt", d.updated_at::text AS "updatedAt", d.updated_at AS sort, d.updated_at::text AS at_text, d.id AS key
        FROM operation_deliveries d LEFT JOIN operation_webhooks w ON w.id = d.webhook_id WHERE ${filters(sql`d`)}
        UNION ALL SELECT d.workspace_id, d.id, 'inbound', d.webhook_id, w.url, d.payload ->> 'type', d.status, d.attempt_count, d.last_status_code, left(d.last_error, 300), d.created_at::text, d.updated_at::text,
          d.updated_at, d.updated_at::text, d.id FROM mailbox_webhook_deliveries d LEFT JOIN mailbox_webhooks w ON w.id = d.webhook_id WHERE ${filters(sql`d`)}
      ) x ${cursor ? sql`WHERE (sort, key) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``} ORDER BY sort DESC, key DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit).map(r => { const { url, sort: _s, ...rest } = strip(r) as typeof r & { sort?: unknown }; return { ...rest, endpoint: url ? webhookUrlHint(url) : '', createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() }; }),
      nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  const StandingDetail = Standing.extend({
    history: z.object({
      days: z.array(z.object({ day: z.string(), score: z.number().nullable(), quality: z.number().nullable(), limit: z.number().nullable(), step: z.string().nullable(),
        accepted: z.number(), bounced: z.number(), complained: z.number(), rejected: z.number() })).describe('The published daily score, quality, limit and step, with the day’s real mail (accepted, hard-bounced, complained, screen-rejected), oldest first. The only source for days older than the 30 days mail is kept.'),
      changes: z.array(z.object({ at: z.string(), kind: z.string().describe('step, limit, quarantine, release, tenant or operator.'), from: z.string().nullable(), to: z.string().nullable(), reasons: z.array(z.string()),
        limitFrom: z.number().nullable(), limitTo: z.number().nullable() })).describe('Changes of standing (ladder steps, limit bands, quarantines, releases), newest first, at most 50.'),
    }).describe('The last 60 days.'),
    limitRequest: z.object({ eligibleForAutoApproval: z.boolean().describe('Always false: nothing is approved automatically.'), reasons: z.array(z.object({ code: z.string(), message: z.string() })).describe('Why a higher limit is not needed or not automatic: NO_DAILY_LIMIT, EVALUATING, SCORE_CAP, LADDER_STEP or NO_STANDING.'), maxAuto: z.number().describe('Always 0.'),
      requested: z.number().nullable() }).describe(`Deprecated: a workspace in good standing (score ${GOOD_STANDING} and up, no warning) has no daily limit, and a limit set by the score or a warning lifts by itself as the workspace recovers, so no limit request is approved automatically. A person can still review a capped workspace and set an operator override.`),
  }).openapi('SupportStandingDetail');
  app.openapi(createRoute({ ...meta('getSupportStanding', 'Sending standing and limits per workspace: the connection and any pause with its reason, limit overrides, the sender standing where enabled (a null dailyLimit is no daily limit), the last 24 hours of sends by status, 60 days of score, limit and step history, and why a higher limit is or is not needed.'), path: '/v1/support/standing',
    request: { query: WorkspaceFilter.extend({ requestedLimit: z.coerce.number().int().min(1).max(10_000_000).optional().describe('The daily limit the customer asks for; echoed as limitRequest.requested.') }) },
    responses: { 200: response(z.object({ data: z.array(StandingDetail) })), ...errors } }), async c => {
    const list = scoped(c).ids, requested = c.req.valid('query').requestedLimit;
    type History = { workspace_id: string; phase: 'seed' | 'calibrating' | 'graded' | null; step: Step | null; daily: number | null; days: z.infer<typeof StandingDetail>['history']['days']; changes: z.infer<typeof StandingDetail>['history']['changes'] };
    const { rows, history } = await supportRead(c.env.db, async tx => ({ rows: await standings(tx, list), history: list.length ? (await tx.execute<History>(sql`SELECT w.id AS workspace_id,
        s.phase, s.step, s.daily_limit AS daily,
        (SELECT coalesce(json_agg(json_build_object('day', d.day::text, 'score', d.score::float8, 'quality', d.quality::float8, 'limit', d.daily_limit, 'step', d.step, 'accepted', d.accepted, 'bounced', d.bounced,
          'complained', d.complained, 'rejected', d.rejected) ORDER BY d.day), '[]') FROM sender_score_daily d WHERE d.workspace_id = w.id AND d.day > (now() AT TIME ZONE 'UTC')::date - 60) AS days,
        (SELECT coalesce(json_agg(x ORDER BY x.at DESC), '[]') FROM (SELECT e.at, e.kind, e.from_step AS "from", e.to_step AS "to", ARRAY(SELECT r->>'code' FROM jsonb_array_elements(e.reasons) r WHERE r ? 'code') AS reasons,
          CASE WHEN jsonb_typeof(e.details->'from') = 'number' THEN (e.details->>'from')::numeric::int END AS "limitFrom", CASE WHEN jsonb_typeof(e.details->'to') = 'number' THEN (e.details->>'to')::numeric::int END AS "limitTo"
          FROM standing_events e WHERE e.workspace_id = w.id AND e.at > now() - interval '60 days' ORDER BY e.at DESC, e.id DESC LIMIT 50) x) AS changes
      FROM unnest(${ids(list)}) w(id) LEFT JOIN sender_standing s ON s.workspace_id = w.id`)).rows : [] }));
    return c.json({ data: rows.map(row => {
      const h = history.find(x => x.workspace_id === row.workspaceId)!;
      return { ...row, history: { days: h.days, changes: h.changes.map(x => ({ ...x, at: new Date(x.at).toISOString() })) },
        limitRequest: { ...limitRequest({ phase: h.phase, step: h.step, daily: h.daily }), requested: requested ?? null } };
    }) }, 200);
  });
  const Billing = z.object({ available: z.boolean().describe('False until billing is enabled on this installation.'), data: z.array(z.object({ workspaceId: z.string(), account: z.record(z.string(), z.unknown()).nullable(),
    ledger: z.array(z.record(z.string(), z.unknown())).describe('The latest 50 ledger entries: top-ups, usage, refunds, disputes, credits.') })) }).openapi('SupportBilling');
  app.openapi(createRoute({ ...meta('getSupportBilling', 'Balance, payments and the billing ledger of the workspaces the customer owns or administers.'), path: '/v1/support/billing', request: { query: WorkspaceFilter }, responses: { 200: response(Billing), ...errors } }), async c => {
    const list = scoped(c, ['owner', 'admin']).ids, db = c.env.db;
    // The billing tables (migrations 291–302), read through to_jsonb; Stripe's customer and card IDs stay out.
    const { rows: [tables] } = await db.execute<{ accounts: boolean; ledger: boolean }>(sql`SELECT to_regclass('billing_accounts') IS NOT NULL AS accounts, to_regclass('billing_ledger') IS NOT NULL AS ledger`);
    if (!tables?.ledger || !list.length) return c.json({ available: !!tables?.ledger, data: [] }, 200);
    const { rows } = await db.execute<{ workspaceId: string; account: Record<string, unknown> | null; ledger: Record<string, unknown>[] }>(sql`SELECT w.id AS "workspaceId",
      ${tables.accounts ? sql`(SELECT to_jsonb(a) - 'stripe_customer' - 'stripe_payment_method' - 'card_fingerprint' FROM billing_accounts a WHERE a.workspace_id = w.id)` : sql`NULL::jsonb`} AS account,
      coalesce((SELECT jsonb_agg(to_jsonb(b) - 'workspace_id') FROM (SELECT * FROM billing_ledger b WHERE b.workspace_id = w.id ORDER BY b.id DESC LIMIT 50) b), '[]') AS ledger
      FROM workspaces w WHERE w.id = ANY(${ids(list)})`);
    return c.json({ available: true, data: rows }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportAudit', 'The audit trail the customer sees in Settings → Activity (who changed what, when, from where), for the workspaces they own or administer. Filter by time, action or actor; newest first.'), path: '/v1/support/audit', request: { query: WorkspaceFilter.extend(AuditFilters.shape) }, responses: { 200: response(z.object({ data: z.array(AuditEntry), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const { workspaceId: _w, ...filters } = c.req.valid('query');
    return c.json(await customerTrail(c.env.db, scoped(c, ['owner', 'admin']).ids, filters), 200);
  });
  // The customer's own requests, from this Worker's request lines in Workers Logs (src/support-logs.ts).
  const Retention = z.literal(`${LOG_RETENTION_DAYS} days`).describe('How long Workers Logs keep request lines.');
  const Principal = z.string().describe('How the caller authenticated: dashboard, apiKey, mcp, agentToken, inboxKey…; never which key or user.');
  const RequestGroup = z.object({ route: z.string().describe('The route template (/v1/emails/:id), never a path.'), method: z.string(), status: z.number(), code: z.string().nullable().describe(`The error code ${productName} answered with.`),
    principal: Principal, count: z.number(), firstSeen: z.string(), lastSeen: z.string(),
    sampleRequestIds: z.array(z.string()).describe('Up to 5 of the latest, to look up with /v1/support/requests/{requestId}.') }).openapi('SupportRequestGroup');
  const RequestLog = z.object({
    available: z.boolean().describe('False when this installation does not read Workers Logs (reason not_configured) or they did not answer (unavailable).'),
    reason: z.enum(['not_configured', 'unavailable']).optional(),
    window: z.object({ since: z.string(), until: z.string() }), retention: Retention,
    groups: z.array(RequestGroup).describe('At most 50, most frequent first.'),
    totals: z.object({ errors: z.number().describe('Matching request lines in the window.'),
      truncated: z.boolean().describe(`More than ${LOG_ROWS.toLocaleString('en-US')} lines matched, so the counts are of a sample spread over the window: narrow it.`) }),
    computedAt: z.string(),
  }).openapi('SupportRequestLog');
  app.openapi(createRoute({ ...meta('listSupportRequests', `The customer’s own failed API requests over at most the last ${LOG_RETENTION_DAYS} days, from Workers Logs: grouped by route template, method, status, error code and how the caller authenticated, with counts, first and last seen and up to 5 request IDs each. Only requests ${productName} could attribute to one of the conversation’s workspaces (a rejected key cannot be); never messages, addresses, user agents, URLs or bodies. Cached 60 seconds.`),
    path: '/v1/support/requests', request: { query: WorkspaceFilter.extend({
      status: z.enum(['error', '5xx', '4xx']).default('error').describe('error: every status of 400 or more (default); 5xx or 4xx only.'),
      since: z.iso.datetime().optional().describe(`Window start (default: 24 hours before until). At most ${LOG_RETENTION_DAYS} days back.`), until: z.iso.datetime().optional().describe('Window end (default: now).'),
      route: z.string().max(200).regex(ROUTE_TEMPLATE).optional().describe('Only this route template, as a group names it.'), code: z.string().regex(ERROR_CODE).optional().describe('Only this error code.') }) },
    responses: { 200: response(RequestLog), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, now = Date.now();
    const until = q.until ? Date.parse(q.until) : Math.ceil(now / 60_000) * 60_000, since = q.since ? Date.parse(q.since) : until - DAY;
    if (since >= until) throw new ApiError(422, 'INVALID_DATE_RANGE', 'since must be before until.', 'since');
    if (since < now - LOG_RETENTION_DAYS * DAY - 60_000) throw new ApiError(422, 'WINDOW_TOO_OLD', `Workers Logs keep request lines ${LOG_RETENTION_DAYS} days: since can be at most that far back.`, 'since');
    const window = { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, retention = `${LOG_RETENTION_DAYS} days` as const;
    const none = (reason: 'not_configured' | 'unavailable') => c.json({ available: false, reason, window, retention, groups: [], totals: { errors: 0, truncated: false }, computedAt: new Date().toISOString() }, 200);
    const observability = c.env.config.observability;
    if (!observability) return none('not_configured');
    try {
      return c.json(await cached(c, 'requests', list, { ...window, status: q.status, route: q.route, code: q.code }, async () => {
        const { lines, truncated } = await requestLines(observability, { workspaceIds: list, from: since, to: until, status: q.status, route: q.route, code: q.code, limit: LOG_ROWS });
        return { available: true, window, retention, groups: groupLines(lines), totals: { errors: lines.length, truncated } };
      }), 200);
    } catch (error) { if (error instanceof LogsUnavailable) return none('unavailable'); throw error; }
  });
  const RequestTrace = z.object({
    requestId: z.string(), found: z.boolean().describe(`Whether ${productName} logged or stored anything about this request for this customer.`),
    logs: z.array(z.object({ at: z.string(), route: z.string(), method: z.string(), status: z.number(), code: z.string().nullable(), durationMs: z.number().nullable(), principal: Principal, workspaceId: z.string() }))
      .describe(`Its request lines from Workers Logs (the last ${LOG_RETENTION_DAYS} days), in the conversation’s workspaces. Successful requests are sampled, so one may be missing.`),
    logsAvailable: z.boolean().describe('False when this installation does not read Workers Logs or they did not answer; logs is then empty.'),
    auditEvents: z.array(AuditEntry).describe('Changes the request made.'),
    campaigns: z.array(z.object({ workspaceId: z.string(), id: z.string(), name: z.string(), state: z.string(), error: z.unknown().nullable() })).describe('Campaign launches the request started.'),
    routingVersions: z.array(z.object({ workspaceId: z.string(), version: z.number(), resourceId: z.string(), at: z.string() })).describe('Routing versions the request wrote.'),
    note: z.string(),
  }).openapi('SupportRequestTrace');
  app.openapi(createRoute({ ...meta('getSupportRequest', `What ${productName} recorded for one API request (the x-request-id a customer quotes): its request line from Workers Logs (route, status, error code, duration; the last ${LOG_RETENTION_DAYS} days), the changes it made, campaign launches and routing versions.`), path: '/v1/support/requests/{requestId}', request: { query: WorkspaceFilter, params: z.object({ requestId: z.string().regex(/^req_[0-9a-f]{32}$/) }) }, responses: { 200: response(RequestTrace), ...errors } }), async c => {
    const { changed, ...trace } = await requestTrace(c, scoped(c).ids, c.req.valid('param').requestId);
    return c.json({ ...trace, note: changed ? 'Changes recorded for this request.' : trace.found ? `Logged, but it changed nothing ${productName} stores: see logs for its route, status and error code.`
      : `Nothing recorded: the request changed nothing${trace.logsAvailable ? ` and is not in the last ${LOG_RETENTION_DAYS} days of request logs` : ''}, belongs to another account, or is older than the retention window. Ask for the time, the route and the error code shown.` }, 200);
  });
  registerSupportDeliverability(app, meta, WorkspaceFilter);
  registerSupportReceiving(app, meta, WorkspaceFilter);
  registerSupportSmtp(app, meta, WorkspaceFilter);
}
