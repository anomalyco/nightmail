import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { actorMailAccess, ApiError, errors, id, isoTime, json, log, memberRefused, notFound, receivingAdminRefusal, response, wrapModuleLoad, type Actor, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { placementRoot } from './domain-registry.js';
import { auditContext, auditInsert, systemContext, type AuditContext, type AuditEvent } from './audit.js';
import { productName } from './brand.js';
import type { EndpointRecord } from './db/mailbox.js';
import { AGENT_KINDS, cappedCredit, CREDIT_CAP_CENTS, KINDS as APPROVALS, propose as proposeApproval } from './support-approvals.js';
import { event } from './support-inbox.js';

// Support actions (api/README.md "Support integration"). A support conversation proposes one of a few fixed changes for
// its person; only that person, signed in to the dashboard, confirms it, and confirming runs the same function as the
// change's public route. Nightmail writes what the person approves from its own rows, so neither the support platform
// nor its model chooses the words.
//
// Safe actions the agent takes on its own, for an owner or admin of the conversation's workspace, with no confirmation:
// each is reversible or changes nothing but stored state, and each is recorded (a customer-visible entry by support, an
// internal support.action, and a line on the conversation's timeline in the staff inbox). Each target takes turns
// across every conversation (support_action_slots, migration 564):
// - re-check a sending domain's DNS, or a receiving host's (its domain's Check now, which checks its MX too): once a
//   minute per domain or host;
// - resend a forward's confirmation email (the dashboard's Send again): nothing is forwarded until the recipient allows
//   it, and the new link replaces the earlier one; once in 10 minutes per forward, within the endpoint's own daily limits.
// Risky changes (limits, pauses, credit, a campaign's release) the agent only proposes to staff (POST /v1/support/approvals,
// src/support-approvals.ts): a signed-in operator approves each in the dashboard, and only that runs it.

const KINDS = {
  retry_webhook_delivery: { route: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', access: 'webhooks', target: 'Delivery' },
  test_webhook: { route: '/v1/webhooks/{id}/test', access: 'webhooks', target: 'Webhook' },
  retry_inbound_delivery: { route: '/v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry', access: 'receiving', target: 'Delivery' },
  test_inbound_webhook: { route: '/v1/inbound/webhooks/{id}/test', access: 'receiving', target: 'Webhook' },
  redeliver_message: { route: '/v1/inbound/messages/{messageId}/redeliver', access: 'receiving', target: 'Message' },
  // The workspace's owner pauses its own campaign from support: an admin, whose own session may pause it in the dashboard,
  // is offered no card for it (decision on #915), and an owner demoted since the proposal can't confirm it.
  pause_campaign: { route: '/v1/campaigns/{id}/pause', access: 'campaigns', target: 'Campaign', owner: true },
} as const;
type Kind = keyof typeof KINDS;
/** Open proposals per conversation, and how long one stays open. */
export const OPEN_ACTIONS = 3, ACTION_HOURS = 24;
/** Risky proposals to staff waiting per conversation (POST /v1/support/approvals). */
export const OPEN_PROPOSALS = 3;
/**
 * How long a confirmed inbound-webhook test may stay running: its post (at most 30 seconds) happens after its claim
 * commits, so a request that died in between never records the answer. After this the action settles as failed with
 * an unknown outcome, and the test is never posted again.
 */
export const RUNNING_MINUTES = 5;

/** A person's dashboard actor in a workspace, as a signed-in session gets it (account-login.ts accountSessionActor). */
const personActor = (keyId: string, workspaceId: string, role: string, credential: 'dashboard' | 'support'): Actor =>
  ({ keyId, workspaceId, role, permissions: role === 'member' ? ['read', 'send'] : ['manage'], domains: [], credential });
/** Why this actor may not make the change, or null: a kind marked owner, anyone but the owner; then the public route's path guard (app.ts memberRefused) and its own check. */
function refusal(kind: Kind, a: Actor) {
  const { route, access } = KINDS[kind];
  if ('owner' in KINDS[kind] && a.role !== 'owner') return new ApiError(403, 'PERMISSION_DENIED', 'From support, only the workspace’s owner can make this change. An owner or admin can still do it in the dashboard.');
  const allowed = !memberRefused(a, 'POST', route) && (access === 'webhooks' ? a.permissions.includes('manage') && !a.domains.length
    : access === 'receiving' ? actorMailAccess(a)?.admin === true : a.permissions.includes('manage') || a.permissions.includes('send'));
  return allowed ? null : new ApiError(403, 'PERMISSION_DENIED', 'This operation requires a workspace owner or admin.');
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const Proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry_webhook_delivery'), webhookId: Id, deliveryId: Id }).strict(),
  z.object({ kind: z.literal('test_webhook'), webhookId: Id }).strict(),
  z.object({ kind: z.literal('retry_inbound_delivery'), webhookId: Id, deliveryId: Id }).strict(),
  z.object({ kind: z.literal('test_inbound_webhook'), webhookId: Id }).strict(),
  z.object({ kind: z.literal('redeliver_message'), messageId: Id, webhookId: Id.optional().describe('Only this endpoint; omit for every route webhook that finished with the message.') }).strict(),
  z.object({ kind: z.literal('pause_campaign'), campaignId: Id }).strict(),
]).openapi('SupportActionProposal');
type Target = Omit<z.infer<typeof Proposal>, 'kind'>;
type Targets = Partial<Record<'webhookId' | 'deliveryId' | 'messageId' | 'campaignId', string>>;
const Status = z.enum(['proposed', 'running', 'done', 'failed', 'declined', 'expired']);
const Action = z.object({
  id: z.string(), kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]),
  status: Status.describe(`proposed: waiting for the customer; running: a test is posting; done or failed: what the public route answered (failed with SUPPORT_ACTION_OUTCOME_UNKNOWN when a test's answer was never recorded within ${RUNNING_MINUTES} minutes; it is never posted again); declined; expired after 24 hours.`),
  summary: z.string().describe(`What the customer approves, as plain text: never render it as Markdown or HTML. ${productName}'s own sentence from its records, with each name a person typed (a workspace, a campaign, the end of a webhook URL) inserted as a JSON-quoted string, its control and formatting characters (bidirectional ones included) removed.`),
  parts: z.object({
    template: z.string().describe(`The same sentence with a {placeholder} where each typed name goes. Nothing in it was typed by a person.`),
    labels: z.record(z.string(), z.string()).describe('The typed names, as data: put each in place of its {placeholder} once, as text.'),
  }).describe('The summary in parts, to render the typed names apart from the sentence.'),
  workspaceId: z.string(), target: z.record(z.string(), z.string()),
  url: z.string().describe('Where the customer confirms or declines it, signed in.'),
  result: z.record(z.string(), z.unknown()).nullable().describe('The public route’s answer when it ran.'),
  error: z.object({ code: z.string(), message: z.string() }).nullable().describe('The public route’s error when it refused.'),
  delivery: z.object({
    status: z.enum(['pending', 'delivered', 'failed', 'paused']).describe('pending: queued or retrying, its endpoint has not accepted it yet; delivered: the endpoint accepted it; failed: it gave up; paused: held while the webhook is paused.'),
    attempts: z.number().int(), statusCode: z.number().int().nullable().describe('The endpoint’s last HTTP answer, if any.'),
  }).nullable().describe('For a done test or retry of a sending or inbound webhook delivery: that delivery as it stands now. done means it was queued; this says whether it has reached the endpoint.'),
  createdAt: z.string(), expiresAt: z.string(), resolvedAt: z.string().nullable(),
}).openapi('SupportAction');
type Parts = { template: string; labels: Record<string, string> };
type Row = { id: string; conversation_id: string; user_id: string; workspace_id: string; kind: Kind; target: Targets; summary: string; parts: Parts; status: 'proposed' | 'running' | 'done' | 'failed' | 'declined';
  result: { body?: Record<string, unknown>; error?: { code: string; message: string } } | null; created_at: string; expires_at: string; resolved_at: string | null; expired: boolean; stale: boolean };
const running = sql`${`${RUNNING_MINUTES} minutes`}::interval`;
const columns = sql`id, conversation_id, user_id, workspace_id, kind, target, summary, parts, status, result, created_at::text, expires_at::text, resolved_at::text, expires_at <= now() AS expired,
  status = 'running' AND started_at <= now() - ${running} AS stale`;
type Delivery = z.infer<typeof Action>['delivery'];
const view = (c: Ctx, row: Row, delivery: Delivery = null): z.infer<typeof Action> => ({
  id: row.id, kind: row.kind, status: row.status === 'proposed' && row.expired ? 'expired' : row.status, summary: row.summary, parts: row.parts, workspaceId: row.workspace_id, target: row.target as Record<string, string>,
  url: `${new URL(c.env.config.publicUrl).origin}/support/actions/${row.id}`, result: row.result?.body ?? null, error: row.result?.error ?? null, delivery,
  createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, resolvedAt: isoTime(row.resolved_at),
});
/** The delivery a done test or retry queued, as it stands now: confirming only queues it, so "done" never means it arrived. */
async function deliveryOf(db: DbExecutor, row: Row): Promise<Delivery> {
  if (row.status !== 'done') return null;
  const id = row.kind === 'test_webhook' ? row.result?.body?.id : row.kind === 'retry_webhook_delivery' || row.kind === 'retry_inbound_delivery' ? row.target.deliveryId : null;
  if (typeof id !== 'string') return null;
  const table = row.kind === 'retry_inbound_delivery' ? sql`mailbox_webhook_deliveries` : sql`operation_deliveries`;
  const { rows: [d] } = await db.execute<{ status: string; attempts: number; code: number | null }>(sql`SELECT status, attempt_count AS attempts, last_status_code AS code FROM ${table}
    WHERE id = ${id} AND workspace_id = ${row.workspace_id}`);
  if (!d) return null;
  const status = (['delivered', 'failed', 'paused'] as const).find(known => known === d.status) ?? 'pending';
  return { status, attempts: d.attempts, statusCode: d.code };
}
/** A proposal as its reader gets it, with its delivery where it has one. */
const shown = async (c: Ctx, row: Row) => view(c, row, await deliveryOf(c.env.db, row));

// ---------- the summary, from Nightmail's own rows ----------

type Facts = { workspace_id: string; workspace: string; url?: string | null; name?: string | null; status?: string; attempts?: number; event?: string | null; at?: string; campaign?: string; expanded?: number; total?: number };
/** The target's row in one of these workspaces, with what its summary names. */
function factsOf(kind: Kind, t: Targets, ids: string[]): SQL {
  const scope = sql`${sql.param(ids)}::text[]`;
  switch (kind) {
    case 'retry_webhook_delivery': return sql`SELECT d.workspace_id, w.name AS workspace, h.url, h.description AS name, d.status, d.attempt_count AS attempts, d.payload->>'type' AS event,
        d.created_at::text AS at
      FROM operation_deliveries d JOIN operation_webhooks h ON h.id = d.webhook_id AND h.workspace_id = d.workspace_id JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = ${t.deliveryId} AND d.webhook_id = ${t.webhookId} AND d.workspace_id = ANY(${scope})`;
    case 'test_webhook': return sql`SELECT h.workspace_id, w.name AS workspace, h.url, h.description AS name FROM operation_webhooks h JOIN workspaces w ON w.id = h.workspace_id
      WHERE h.id = ${t.webhookId} AND h.workspace_id = ANY(${scope})`;
    case 'retry_inbound_delivery': return sql`SELECT d.workspace_id, w.name AS workspace, h.url, coalesce(h.name, h.description) AS name, d.status, d.attempt_count AS attempts,
        d.created_at::text AS at
      FROM mailbox_webhook_deliveries d JOIN mailbox_webhooks h ON h.id = d.webhook_id AND h.workspace_id = d.workspace_id AND h.type = 'webhook' JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = ${t.deliveryId} AND d.webhook_id = ${t.webhookId} AND d.workspace_id = ANY(${scope})`;
    case 'test_inbound_webhook': return sql`SELECT h.workspace_id, w.name AS workspace, h.url, coalesce(h.name, h.description) AS name FROM mailbox_webhooks h JOIN workspaces w ON w.id = h.workspace_id
      WHERE h.id = ${t.webhookId} AND h.type = 'webhook' AND h.workspace_id = ANY(${scope})`;
    case 'redeliver_message': return sql`SELECT m.workspace_id, w.name AS workspace, m.received_at::text AS at, h.url, coalesce(h.name, h.description) AS name, h.id IS NOT NULL OR ${t.webhookId ?? null}::text IS NULL AS found
      FROM mail_messages m JOIN workspaces w ON w.id = m.workspace_id LEFT JOIN mailbox_webhooks h ON h.id = ${t.webhookId ?? null} AND h.workspace_id = m.workspace_id
      WHERE m.id = ${t.messageId} AND m.direction = 'inbound' AND m.workspace_id = ANY(${scope})`;
    case 'pause_campaign': return sql`SELECT c.workspace_id, w.name AS workspace, c.draft->>'name' AS campaign, c.state AS status, c.expanded, c.total
      FROM sending_campaigns c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ${t.campaignId} AND c.workspace_id = ANY(${scope})`;
  }
}
/**
 * A name someone typed (a workspace, a campaign, a webhook and the site it posts to), as data: control, formatting (bidirectional
 * ones included), surrogate, private-use and unassigned characters removed, on one line, at most 80 characters.
 */
const label = (value: string | null | undefined) => Array.from((value ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('');
/** The sentence with each typed name in place, JSON-quoted: a name can never end its quotes or read as the sentence. */
const render = ({ template, labels }: Parts) => template.replace(/\{([a-z]+)\}/g, (_, name: string) => JSON.stringify(labels[name] ?? ''));
const tries = (n = 0) => `${n} attempt${n === 1 ? '' : 's'}`;
const minute = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** A time as a person reads it: "Nov 21, 09:14 UTC". */
const readable = (value: string | null | undefined) => value ? `${minute.format(new Date(isoTime(value)!))} UTC` : 'earlier';
/** Where a delivery stands, in words. */
function standing(status: string | undefined, attempts = 0) {
  switch (status) {
    case 'failed': return `It failed after ${tries(attempts)}.`;
    case 'delivered': return `It was delivered after ${tries(attempts)}.`;
    case 'paused': return `It is held while the webhook is paused (${tries(attempts)} so far).`;
    case 'pending': return attempts ? `It is waiting for its next try (${tries(attempts)} so far).` : 'It hasn’t been tried yet.';
    default: return `It is ${/^[a-z_]{1,20}$/.test(status ?? '') ? status!.replace(/_/g, ' ') : 'in an unknown state'} after ${tries(attempts)}.`;
  }
}
/**
 * A webhook as its owner knows it: its name and the site it posts to, both labels. The site is the URL's registrable
 * domain, never the rest: URLs stay write-only, and a service can make a subdomain or path an endpoint's secret.
 */
async function webhookOf(f: Facts, labels: Record<string, string>, fallback: string | undefined) {
  const name = label(f.name);
  let host = '';
  try { host = f.url ? new URL(f.url).hostname : ''; } catch { /* An unreadable URL names no site. */ }
  const site = host ? label((await placementRoot(host)).root ?? host) : '';
  if (name) labels.webhook = name;
  if (site) labels.site = site;
  return [name && '{webhook}', site && 'at {site}'].filter(Boolean).join(' ') || fallback || '';
}
/** Nightmail's sentence for a proposal, in plain words: only its own values (states, counts, times) inline, typed names as labels. */
async function partsOf(kind: Kind, t: Targets, f: Facts): Promise<Parts> {
  const labels: Record<string, string> = { workspace: label(f.workspace) }, where = 'in the workspace {workspace}';
  const webhook = await webhookOf(f, labels, t.webhookId);
  const event = /^[a-z][a-z_.]{0,39}$/.test(f.event ?? '') ? f.event : 'event';
  const template = (() => { switch (kind) {
    case 'retry_webhook_delivery': return `Retry the ${event} delivery from ${readable(f.at)} to your sending webhook ${webhook}, ${where}. ${standing(f.status, f.attempts)}`;
    case 'test_webhook': return `Send a test email.delivered event to your sending webhook ${webhook}, ${where}. No email is sent.`;
    case 'retry_inbound_delivery': return `Retry the delivery of received mail from ${readable(f.at)} to your inbound webhook ${webhook}, ${where}. ${standing(f.status, f.attempts)}`;
    case 'test_inbound_webhook': return `Send a test message.received event for an example message to your inbound webhook ${webhook}, ${where}.`;
    case 'redeliver_message': return `Redeliver the email received ${readable(f.at)} to ${t.webhookId ? `your inbound webhook ${webhook}` : 'every route webhook that already finished with it'}, ${where}.`;
    case 'pause_campaign': labels.campaign = label(f.campaign); return `Pause the campaign {campaign} ${where}. It stops releasing new recipients (${Number(f.expanded)} of ${Number(f.total)} released so far); resuming continues from the same place.`;
  } })();
  return { template, labels };
}

// ---------- confirming: the public route's own function, once ----------

type Performed = { body: Record<string, unknown>; trail?: Pick<AuditEvent, 'action' | 'target' | 'details'>; post?: EndpointRecord };
/**
 * Runs a confirmed action's change in the caller's transaction and answers the public route's body, with the
 * customer-visible entry to write for the person who confirmed (a campaign pause writes its own). A test of an inbound
 * webhook is checked and charged here, and posted (`post`) once this commits.
 */
async function perform(runtime: Runtime, tx: DbExecutor, row: Row, a: Actor, audit: AuditContext): Promise<Performed> {
  const t = row.target as Required<Targets>;
  switch (row.kind) {
    case 'retry_webhook_delivery': return { body: await (await wrapModuleLoad(() => import('./operations.js'))).retrySendingDelivery(runtime, tx, a, t.webhookId, t.deliveryId),
      trail: { action: 'webhook.delivery_retry', target: { type: 'webhook_delivery', id: t.deliveryId }, details: { webhook: t.webhookId } } };
    case 'test_webhook': { const body = await (await wrapModuleLoad(() => import('./operations.js'))).testSendingWebhook(runtime, tx, a, t.webhookId);
      return { body, trail: { action: 'webhook.test', target: { type: 'webhook', id: t.webhookId }, details: { delivery: body.id } } }; }
    case 'retry_inbound_delivery': await (await wrapModuleLoad(() => import('./endpoints.js'))).retryInboundDelivery(tx, a.workspaceId, t.webhookId, t.deliveryId);
      return { body: { ok: true }, trail: { action: 'inbound_webhook.delivery_retry', target: { type: 'inbound_webhook_delivery', id: t.deliveryId }, details: { webhook: t.webhookId } } };
    case 'redeliver_message': { const queued = await (await wrapModuleLoad(() => import('./endpoints.js'))).redeliverMessage(tx, a.workspaceId, t.messageId, row.target.webhookId);
      return { body: { queued }, trail: { action: 'inbound_message.redeliver', target: { type: 'message', id: t.messageId }, details: { webhook: row.target.webhookId ?? null, queued } } }; }
    case 'test_inbound_webhook': return { body: {}, post: await (await wrapModuleLoad(() => import('./endpoints.js'))).prepareInboundTest(tx, a.workspaceId, t.webhookId),
      trail: { action: 'inbound_webhook.test', target: { type: 'inbound_webhook', id: t.webhookId } } };
    case 'pause_campaign': await (await wrapModuleLoad(() => import('./sending.js'))).pauseSendingCampaign(runtime, tx, a, t.campaignId, audit); return { body: { id: t.campaignId, state: 'paused' } };
  }
}
/** What the request wakes once it commits, as the public route would (app.ts wakes after the response). */
function woken(row: Row, a: Actor, body: Record<string, unknown>) {
  if (row.kind === 'retry_inbound_delivery') a.wakeJobs = 1;
  if (row.kind === 'redeliver_message') a.wakeJobs = Number(body.queued) || 0;
  if (row.kind !== 'redeliver_message' && row.kind !== 'pause_campaign') a.wakeJobPool = 'webhook';
}
/** A refusal of the public route, as the action records it; anything else is a server failure. */
const refusedBy = (error: unknown) => error instanceof ApiError ? { error: { code: error.code, message: error.message } } : null;
/** The internal trail of an action: the person who decided, from their dashboard session, and how it ended. */
const decided = (context: AuditContext, row: Row, details: Record<string, unknown>, options: { where?: SQL } = {}) => auditInsert(context, { action: 'support.action', workspaceId: row.workspace_id,
  userId: row.user_id, target: { type: 'support_action', id: row.id }, details: { kind: row.kind, target: row.target, ...details }, ticketRef: row.conversation_id, internal: true }, options);
/** The customer-visible entry of the change itself, for the person who confirmed it. */
const changed = (context: AuditContext, row: Row, trail: NonNullable<Performed['trail']>) => auditInsert(context, { ...trail, workspaceId: row.workspace_id,
  details: { ...trail.details, supportAction: row.id }, ticketRef: row.conversation_id, internal: false });
/** The finished action and its outcome on the trail, in one statement; nothing when it already ended. */
const finish = (context: AuditContext, row: Row, result: NonNullable<Row['result']>, from: Row['status'], outcome = result.error ? 'failed' : 'done') => sql`WITH s AS (
    UPDATE support_actions SET status = ${result.error ? 'failed' : 'done'}, result = ${JSON.stringify(result)}::jsonb, resolved_at = now() WHERE id = ${row.id} AND status = ${from} RETURNING ${columns}
  ), logged AS (${decided(context, row, { outcome, code: result.error?.code }, { where: sql`EXISTS (SELECT FROM s)` })}) SELECT * FROM s`;
const unknown = { error: { code: 'SUPPORT_ACTION_OUTCOME_UNKNOWN', message: 'The test’s answer was never recorded, so it may or may not have reached the endpoint. It was not sent again.' } };
/** A test whose answer never came back within RUNNING_MINUTES settles as failed, outcome unknown; it is never posted again. */
async function settled(db: DbExecutor, row: Row) {
  if (!row.stale) return row;
  const { rows: [done] } = await db.execute<Row>(sql`${finish(systemContext('job'), row, unknown, 'running', 'unknown')}`);
  if (done) log('warn', { code: 'SUPPORT_ACTION_OUTCOME_UNKNOWN', actionId: row.id });
  return done ?? (await db.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${row.id}`)).rows[0]!;
}

/** How often a safe action may run for one target, in seconds. */
export const ACTION_TURNS = { verify_domain: 60, recheck_receiving_host: 60, resend_forward: 600 } as const;
type SafeKind = keyof typeof ACTION_TURNS;
/**
 * A safe action's turn for its target, in the action's own transaction (a failed action gives it back): refused while the
 * same action ran for the same target within its window, from whichever conversation.
 */
async function takeTurn(tx: DbExecutor, kind: SafeKind, target: string) {
  const { rows } = await tx.execute(sql`INSERT INTO support_action_slots(kind, target) VALUES (${kind}, ${target})
    ON CONFLICT (kind, target) DO UPDATE SET at = now() WHERE support_action_slots.at <= now() - make_interval(secs => ${ACTION_TURNS[kind]}) RETURNING 1`);
  if (rows.length) return;
  const seconds = ACTION_TURNS[kind], error = new ApiError(429, 'SUPPORT_ACTION_TOO_SOON', `This was just done for the same ${kind === 'resend_forward' ? 'forward' : kind === 'verify_domain' ? 'domain' : 'receiving host'}: it can run again ${seconds >= 120 ? `${seconds / 60} minutes` : `${seconds} seconds`} after the last time.`, undefined, true);
  error.retryAfterSeconds = seconds;
  throw error;
}
type Conversation = { id: string; userId: string; workspaces: { id: string; role: string }[] };
/** Support acting for the conversation's person: who the customer's activity says did it, and for whom. */
const supportContext = (c: Ctx, conversation: Conversation): AuditContext => ({ ...auditContext(c), actor: { type: 'support', id: conversation.id, userId: conversation.userId, via: 'support', label: `${productName} support` } });
/** A safe action's internal trail and timeline line, in its transaction: `kind`, its target and what it names. */
async function recordAction(tx: DbExecutor, context: AuditContext, conversation: Conversation, workspaceId: string, kind: SafeKind, target: { type: string; id: string }, details: Record<string, unknown>) {
  await tx.execute(auditInsert(context, { workspaceId, userId: conversation.userId, target, ticketRef: conversation.id, action: 'support.action', details: { kind, ...details }, internal: true }));
  await tx.execute(event(conversation.id, 'action', null, { kind, target, ...details }));
}
/**
 * Re-checks a domain's DNS now, as the customer's own Check now does (Domains, or Check MX now under Receiving: both
 * verify the domain, and the verification checks its receiving MX too), for an owner or admin: queues a background
 * verification and answers the stored status. The customer sees that support re-checked it, and for whom.
 */
async function recheckDomain(c: Ctx, conversation: Conversation, domainId: string, as: { kind: 'verify_domain' | 'recheck_receiving_host'; target: { type: string; id: string }; details?: Record<string, unknown> }) {
  const { rows: [domain] } = await c.env.db.execute<{ workspace_id: string; name: string }>(sql`SELECT workspace_id, name FROM operation_domains
    WHERE id = ${domainId} AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`);
  if (!domain) notFound('Domain');
  const a = personActor(conversation.id, domain!.workspace_id, conversation.workspaces.find(w => w.id === domain!.workspace_id)!.role, 'support');
  if (memberRefused(a, 'POST', '/v1/domains/{id}/verify') || !a.permissions.includes('manage')) throw new ApiError(403, 'PERMISSION_DENIED', 'This operation requires a workspace owner or admin.');
  c.set('actor', a);
  // The re-check and its trail commit together: the customer sees that support checked the domain, and for whom.
  const context = supportContext(c, conversation);
  const readiness = await c.env.db.transaction(async tx => {
    await takeTurn(tx, as.kind, as.target.id);
    const readiness = await (await wrapModuleLoad(() => import('./operations.js'))).verifyHostedDomain({ ...c.env, db: tx }, a, domainId);
    const queued = a.wakeJobs === 1, details = { domain: domain!.name, ...as.details, queued };
    await tx.execute(auditInsert(context, { workspaceId: domain!.workspace_id, userId: conversation.userId, target: { type: 'domain', id: domainId }, ticketRef: conversation.id, action: 'domain.verify', details, internal: false }));
    await recordAction(tx, context, conversation, domain!.workspace_id, as.kind, as.target, details);
    return readiness;
  });
  return { readiness, workspaceId: domain!.workspace_id, queued: a.wakeJobs === 1 };
}

export function registerSupportActions(app: App) {
  const tags = ['Support (internal)'], security: Record<string, string[]>[] = [{ bearerAuth: [] }];
  const describe = (text: string) => `${text} Internal: for ${productName} support, for one support conversation, never for customers.`;
  const conversationOf = (c: Ctx) => {
    const support = c.get('support'), conversation = support?.conversation;
    if (!support || !conversation) throw new ApiError(403, 'SUPPORT_CONVERSATION_REQUIRED', 'Only a support conversation proposes actions.');
    const filter = c.req.query('workspaceId');
    // supportGate kept the workspaces where the person's role may make these changes (SUPPORT_CEILINGS).
    return { id: conversation.id, userId: support.userId, workspaces: support.workspaces.filter(w => !filter || w.id === filter) };
  };

  // A proposal needs a workspace where the person may act: with none, nothing in any body could be one.
  for (const path of ['/v1/support/actions', '/v1/support/approvals']) app.use(path, async (c, next) => {
    if (c.req.method === 'POST' && c.get('support')?.conversation && !c.get('support')!.workspaces.length) notFound('Workspace');
    await next();
  });
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/actions', operationId: 'proposeSupportAction', tags, security,
    description: describe(`Propose a change the customer confirms signed in: retry or redeliver webhook mail, test a webhook, or pause a campaign. ${productName} checks the target is in the conversation’s scope and that the customer’s role may make it there, writes the summary from its own records, and keeps it open 24 hours. At most ${OPEN_ACTIONS} are open per conversation; proposing the same change again answers the open one.`),
    request: { body: json(Proposal) }, responses: { 200: response(Action), 201: response(Action), ...errors } }), async c => {
    const conversation = conversationOf(c), { kind, ...target } = c.req.valid('json') as { kind: Kind } & Target, targets = target as Targets;
    const proposed = await c.env.db.transaction(async tx => {
      // Proposals for one conversation take turns: the count below sees every one proposed before it.
      await tx.execute(sql`SELECT id FROM support_conversations WHERE id = ${conversation.id} FOR UPDATE`);
      const { rows: [facts] } = await tx.execute<Facts & { found?: boolean }>(factsOf(kind, targets, conversation.workspaces.map(w => w.id)));
      if (!facts) notFound(KINDS[kind].target);
      if (facts.found === false) notFound('Webhook');
      const role = conversation.workspaces.find(w => w.id === facts.workspace_id)!.role, refused = refusal(kind, personActor(`user_${conversation.userId}`, facts.workspace_id, role, 'dashboard'));
      if (refused) throw refused;
      const { rows: [open] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE conversation_id = ${conversation.id} AND kind = ${kind} AND target = ${JSON.stringify(targets)}::jsonb
        AND status = 'proposed' AND expires_at > now() LIMIT 1`);
      if (open) return { row: open, created: false };
      const { rows: [count] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM support_actions WHERE conversation_id = ${conversation.id} AND status = 'proposed' AND expires_at > now()`);
      if (count!.n >= OPEN_ACTIONS) throw new ApiError(409, 'SUPPORT_ACTIONS_OPEN', `This conversation already has ${OPEN_ACTIONS} open proposals. Wait until the customer confirms or declines one, or it expires.`);
      const parts = await partsOf(kind, targets, facts);
      const { rows: [row] } = await tx.execute<Row>(sql`INSERT INTO support_actions(id, conversation_id, user_id, workspace_id, kind, target, summary, parts, expires_at)
        VALUES (${id('sac')}, ${conversation.id}, ${conversation.userId}, ${facts.workspace_id}, ${kind}, ${JSON.stringify(targets)}::jsonb, ${render(parts)}, ${JSON.stringify(parts)}::jsonb,
          now() + ${`${ACTION_HOURS} hours`}::interval)
        RETURNING ${columns}`);
      return { row: row!, created: true };
    });
    if (proposed.created) log('info', { code: 'SUPPORT_ACTION_PROPOSED', conversationId: conversation.id, actionId: proposed.row.id, kind });
    return c.json(view(c, proposed.row), proposed.created ? 201 : 200);
  });

  const ActionParam = z.object({ id: z.string().regex(/^sac_[0-9a-f]{32}$/) });
  app.openapi(createRoute({ hide: true, method: 'get', path: '/v1/support/actions/{id}', operationId: 'getSupportAction', tags, security,
    description: describe('One of this conversation’s proposals and what came of it: the state the customer left it in, and the public route’s answer. Read it after the customer acts; never take the outcome from anywhere else.'),
    request: { params: ActionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const conversation = conversationOf(c);
    const { rows: [row] } = await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${c.req.valid('param').id} AND conversation_id = ${conversation.id}
      AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`);
    if (!row) notFound('Support action');
    return c.json(await shown(c, await settled(c.env.db, row!)), 200);
  });

  const Recheck = z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), sending: z.string(), receiving: z.string(),
    mailFromStatus: z.string().nullable(), recheckQueued: z.boolean().describe('False when a re-check was already due: read the domain’s health again shortly.') }).openapi('SupportDomainRecheck');
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/domains/{id}/verify', operationId: 'recheckSupportDomain', tags, security,
    description: describe('Re-check a domain’s DNS now, as the customer’s own “Verify” does (an owner or admin’s domain only): queues a background verification and answers the stored status. Needs no confirmation.'),
    request: { params: z.object({ id: Id }) }, responses: { 200: response(Recheck), ...errors } }), async c => {
    const { readiness, workspaceId, queued } = await recheckDomain(c, conversationOf(c), c.req.valid('param').id, { kind: 'verify_domain', target: { type: 'domain', id: c.req.valid('param').id } });
    return c.json({ id: readiness.id, workspaceId, name: readiness.name, verificationStatus: readiness.verificationStatus, verified: readiness.verified, dkimStatus: readiness.dkimStatus,
      sending: readiness.sending, receiving: readiness.receiving, mailFromStatus: readiness.mailFromStatus, recheckQueued: queued }, 200);
  });

  const HostRecheck = z.object({ id: z.string(), workspaceId: z.string(), domainId: z.string(), host: z.string(), status: z.string().describe('The host\u2019s stored state before this check finishes: read receiving_hosts again shortly.'),
    lastCheckedAt: z.string().nullable(), recheckQueued: z.boolean().describe('False when a check was already due: read the hosts again shortly.') }).openapi('SupportReceivingHostRecheck');
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/receiving/hosts/{id}/recheck', operationId: 'recheckSupportReceivingHost', tags, security,
    description: describe(`Re-check a receiving host's MX now (an owner or admin's), as the customer's own Check MX now does: its domain is verified in the background, MX included, and the host's stored state is answered. Needs no confirmation. Once a minute per host.`),
    request: { params: z.object({ id: Id }) }, responses: { 200: response(HostRecheck), ...errors } }), async c => {
    const conversation = conversationOf(c), hostId = c.req.valid('param').id;
    const host = async () => (await c.env.db.execute<{ id: string; workspace_id: string; domain_id: string; host: string; status: string; checked_at: string | null }>(sql`SELECT id, workspace_id, domain_id,
        coalesce(receiving_host, name) AS host, status, checked_at::text AS checked_at FROM mailbox_domains WHERE id = ${hostId} AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`)).rows[0];
    const found = await host();
    if (!found) notFound('Receiving host');
    const { queued } = await recheckDomain(c, conversation, found!.domain_id, { kind: 'recheck_receiving_host', target: { type: 'receiving_host', id: hostId }, details: { host: found!.host } });
    const now = (await host())!;
    return c.json({ id: now.id, workspaceId: now.workspace_id, domainId: now.domain_id, host: now.host, status: now.status, lastCheckedAt: isoTime(now.checked_at), recheckQueued: queued }, 200);
  });

  const Resent = z.object({ id: z.string(), workspaceId: z.string(), name: z.string().nullable(), status: z.literal('pending'), requestedAt: z.string().nullable(), expiresAt: z.string().nullable(),
    recipientDomain: z.string().nullable().describe('The domain of the address it forwards to (never the whole address).') }).openapi('SupportForwardResent');
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/receiving/forwards/{id}/resend', operationId: 'resendSupportForwardConfirmation', tags, security,
    description: describe(`Email a forward's recipient a new confirmation link (an owner or admin's forward not yet confirmed), as the dashboard's Send again does: the new link replaces the earlier one. Needs no confirmation: nothing is forwarded until the recipient allows it. Once in 10 minutes per forward, within the endpoint's own daily limits.`),
    request: { params: z.object({ id: Id }) }, responses: { 200: response(Resent), ...errors } }), async c => {
    const conversation = conversationOf(c), endpointId = c.req.valid('param').id;
    const { rows: [forward] } = await c.env.db.execute<{ workspace_id: string; key: string | null }>(sql`SELECT workspace_id, key FROM mailbox_webhooks WHERE id = ${endpointId} AND type = 'forward'
      AND workspace_id = ANY(${sql.param(conversation.workspaces.map(w => w.id))}::text[])`);
    if (!forward) notFound('Forward');
    const wid = forward!.workspace_id, a = personActor(conversation.id, wid, conversation.workspaces.find(w => w.id === wid)!.role, 'support');
    const refused = receivingAdminRefusal(a, 'resend a forward confirmation');
    if (refused) throw refused;
    c.set('actor', a);
    const context = supportContext(c, conversation), { resendForwardConfirmation } = await wrapModuleLoad(() => import('./endpoints.js'));
    await c.env.db.transaction(async tx => {
      await takeTurn(tx, 'resend_forward', endpointId);
      if (!await resendForwardConfirmation(c, tx, wid, { id: endpointId })) notFound('Forward');
      const details = { endpoint: forward!.key };
      await tx.execute(auditInsert(context, { workspaceId: wid, userId: conversation.userId, target: { type: 'endpoint', id: endpointId }, ticketRef: conversation.id, action: 'endpoint.verification', details, internal: false }));
      await recordAction(tx, context, conversation, wid, 'resend_forward', { type: 'endpoint', id: endpointId }, details);
    });
    // The confirmation email is queued: the request wakes the jobs once it commits, as the dashboard's does.
    a.wakeJobs = 1;
    const { rows: [now] } = await c.env.db.execute<{ requested_at: string | null; expires_at: string | null; target: string | null }>(sql`SELECT requested_at::text, expires_at::text, encrypted_target AS target FROM mailbox_webhooks WHERE id = ${endpointId} AND workspace_id = ${wid}`);
    let recipientDomain: string | null = null;
    try { const address = await (await wrapModuleLoad(() => import('./operations.js'))).decrypt(c.env, now!.target!, `${wid}:endpoint:${endpointId}`); recipientDomain = address.slice(address.lastIndexOf('@') + 1).toLowerCase() || null; } catch { /* Named by its endpoint alone. */ }
    return c.json({ id: endpointId, workspaceId: wid, name: forward!.key, status: 'pending' as const, requestedAt: isoTime(now?.requested_at), expiresAt: isoTime(now?.expires_at), recipientDomain }, 200);
  });

  // ---------- risky changes: proposed to staff, never run here ----------
  const ProposalBody = z.object({
    kind: z.enum(AGENT_KINDS as [string, ...string[]]).describe(AGENT_KINDS.map(k => `${k}: ${APPROVALS[k].label}`).join('; ')),
    reason: z.string().trim().min(10).max(400).describe('Why, in plain words, for staff: what the customer asked and what the reads showed.'),
    daily: z.number().int().optional().describe('raise_daily_limit: the daily limit to set.'), limit: z.number().int().optional().describe('raise_domain_limit: the domain limit to set.'),
    campaignId: Id.optional().describe('release_campaign: the paused campaign.'),
    amountCents: z.number().int().optional().describe('grant_credit: the promotional credit asked for, in cents. A proposal grants at most 10,000 ($100): a larger ask, up to 100,000, is capped, and staff see the ask. One credit proposal waits per conversation at a time.'),
  }).strict().openapi('SupportApprovalProposal');
  const Proposed = z.object({ id: z.string(), kind: z.string(), label: z.string(), summary: z.string(), state: z.literal('proposed'), expiresAt: z.string() }).openapi('SupportApprovalProposed');
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/approvals', operationId: 'proposeSupportApproval', tags, security,
    description: describe(`Propose a risky change to ${productName} staff for the conversation's workspace (an owner or admin's): a limit, a pause or resume, the marketing hold's or a campaign's release, or promotional credit (at most $100 a proposal, one waiting per conversation; a larger ask is capped and shown). Nothing runs here: it waits for a signed-in operator's approval in the dashboard, from the staff email, for 72 hours; the conversation gets a ticket if it has none open. At most ${OPEN_PROPOSALS} open per conversation; the same proposal again answers the open one.`),
    request: { body: json(ProposalBody) }, responses: { 200: response(Proposed), 201: response(Proposed), ...errors } }), async c => {
    const conversation = conversationOf(c), { kind: name, reason, ...fields } = c.req.valid('json'), kind = name as (typeof AGENT_KINDS)[number];
    if (conversation.workspaces.length !== 1) throw new ApiError(422, 'WORKSPACE_REQUIRED', 'A proposal is for one workspace: pass workspaceId.', 'workspaceId');
    // Credit: one proposal grants at most CREDIT_CAP_CENTS; a larger ask (up to the console's own $1,000) is capped, and the
    // ask is kept so staff see it. More is for a person to start themselves.
    const credit = kind === 'grant_credit' && typeof fields.amountCents === 'number' && fields.amountCents <= 100_000 ? cappedCredit(fields.amountCents) : {};
    const wid = conversation.workspaces[0]!.id, parsed = APPROVALS[kind].payload!.safeParse({ workspaceId: wid, ...fields, ...credit });
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', `${kind} takes ${Object.keys(APPROVALS[kind].payload!.shape).filter(k => k !== 'workspaceId').join(', ') || 'nothing but the reason'}, in range.`);
    const payload = parsed.data as Record<string, unknown>;
    if (kind === 'release_campaign' && !(await c.env.db.execute(sql`SELECT FROM sending_campaigns WHERE id = ${String(payload.campaignId)} AND workspace_id = ${wid}`)).rows.length) notFound('Campaign');
    const context = supportContext(c, conversation);
    const made = await c.env.db.transaction(async tx => {
      // Proposals for one conversation take turns: the count below sees every one proposed before it.
      await tx.execute(sql`SELECT id FROM support_conversations WHERE id = ${conversation.id} FOR UPDATE`);
      const { rows: [open] } = await tx.execute<{ n: number; same: boolean; credit: boolean }>(sql`SELECT count(*)::int AS n, bool_or(kind = ${kind} AND payload = ${JSON.stringify(payload)}::jsonb) AS same,
          bool_or(kind = 'grant_credit') AS credit FROM support_approvals
        WHERE conversation_id = ${conversation.id} AND proposed_by = 'agent' AND state = 'proposed' AND expires_at > now()`);
      if (!open?.same && kind === 'grant_credit' && open?.credit) throw new ApiError(409, 'SUPPORT_CREDIT_PROPOSAL_OPEN', `This conversation already has a credit proposal waiting for staff: one at a time, and at most ${'$'}${CREDIT_CAP_CENTS / 100} each. More is for a person: file a ticket.`);
      if (!open?.same && open!.n >= OPEN_PROPOSALS) throw new ApiError(409, 'SUPPORT_PROPOSALS_OPEN', `This conversation already has ${OPEN_PROPOSALS} proposals waiting for staff.`);
      const approval = await proposeApproval(tx, { conversationId: conversation.id, kind, reason, proposedBy: 'agent', payload });
      if (approval.created) {
        // It needs a person now: a ticket (if none is open) puts it in Needs you, and the staff email carries the approval.
        await (await wrapModuleLoad(() => import('./support-staff-mail.js'))).openStaffTicket(tx, conversation.id, 'P3', true);
        await tx.execute(sql`UPDATE support_conversations SET done_at = NULL, done_by = NULL WHERE id = ${conversation.id} AND done_at IS NOT NULL`);
        await tx.execute(event(conversation.id, 'proposed', null, { approval: approval.id, kind, label: APPROVALS[kind].label, summary: APPROVALS[kind].summary!(payload) }));
        await tx.execute(auditInsert(context, { workspaceId: wid, userId: conversation.userId, target: { type: 'support_approval', id: approval.id }, ticketRef: conversation.id, action: 'support.proposal',
          details: { kind, payload }, internal: true }));
      }
      return approval;
    });
    if (made.created) log('info', { code: 'SUPPORT_APPROVAL_PROPOSED', conversationId: conversation.id, approvalId: made.id, kind });
    return c.json({ id: made.id, kind, label: APPROVALS[kind].label, summary: APPROVALS[kind].summary!(payload), state: 'proposed' as const, expiresAt: made.expiresAt.toISOString() }, made.created ? 201 : 200);
  });

  // ---------- the customer's own session: only the person a proposal is for, while a member of its workspace ----------
  const sessionSecurity: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const SessionParam = z.object({ id: z.string().regex(/^sac_[0-9a-f]{32}$/) });
  /** The signed-in person, like accepting an invitation: never a bearer credential or the support platform; writes from the dashboard's origin. */
  async function person(c: Ctx) {
    if (!c.env.config.multiTenant) notFound('Endpoint');
    if (c.env.platformCaller) throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
    const { verifiedDashboardUser, requireDashboardOrigin } = await wrapModuleLoad(() => import('./dashboard-auth.js'));
    const { userId } = await verifiedDashboardUser(c.env, c.req.raw.headers);
    if (c.req.method !== 'GET') requireDashboardOrigin(c.env, c.req.raw);
    return userId;
  }
  /** The proposal locked, with the person's role in its workspace now (held until the decision commits); 404 for anyone else. */
  async function decision(tx: DbExecutor, actionId: string, userId: string) {
    const { rows: [row] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${actionId} AND user_id = ${userId} FOR UPDATE`);
    const { rows: [member] } = row ? await tx.execute<{ role: string }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${row.workspace_id} AND user_id = ${userId} FOR SHARE`) : { rows: [] };
    if (!row || !member) notFound('Support action');
    return { row: await settled(tx, row!), a: personActor(`user_${userId}`, row!.workspace_id, member!.role, 'dashboard') };
  }
  const expired = () => new ApiError(409, 'SUPPORT_ACTION_EXPIRED', 'This proposal expired. Ask support again if you still want it.');

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'get', path: '/v1/support-actions/{id}', operationId: 'getSupportActionProposal',
    description: `A change ${productName} support proposed to you, in ${productName}’s words, and what came of it. Only you, while a member of its workspace.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c);
    const { rows: [row] } = await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_actions s WHERE id = ${c.req.valid('param').id} AND user_id = ${userId}
      AND EXISTS (SELECT FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = s.user_id)`);
    if (!row) notFound('Support action');
    return c.json(await shown(c, await settled(c.env.db, row!)), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-actions/{id}/confirm', operationId: 'confirmSupportAction',
    description: `Make a change ${productName} support proposed to you: it runs exactly as its own route does, once, while your role there still allows it. Confirming again answers what came of it.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c), actionId = c.req.valid('param').id;
    // A campaign's controls read its workspace's regions first, as the public route's middleware does (app.ts).
    const { rows: [peek] } = await c.env.db.execute<{ kind: Kind; workspace_id: string }>(sql`SELECT kind, workspace_id FROM support_actions WHERE id = ${actionId} AND user_id = ${userId}`);
    if (!peek) notFound('Support action');
    const runtime = peek!.kind === 'pause_campaign' ? await (await wrapModuleLoad(() => import('./ses-region-state.js'))).withRegionSettings(c.env, peek!.workspace_id) : c.env;
    const claimed = await c.env.db.transaction(async (tx): Promise<{ row: Row; post?: EndpointRecord }> => {
      const { row, a } = await decision(tx, actionId, userId);
      if (row.status === 'declined') throw new ApiError(409, 'SUPPORT_ACTION_DECLINED', 'You declined this proposal. Ask support again if you want it now.');
      if (row.status !== 'proposed') return { row };
      if (row.expired) throw expired();
      const refused = refusal(row.kind, a);
      if (refused) throw refused;
      c.set('actor', a);
      const context = auditContext(c);
      // The change, its own visible entry and the decision commit together; a change its route refuses rolls back
      // alone, and is recorded. A test of an inbound webhook commits its checks and charge here as running, and posts after.
      await tx.execute(sql`SAVEPOINT support_action`);
      let performed: Performed | undefined, result: NonNullable<Row['result']>;
      try { performed = await perform(runtime, tx, row, a, context); await tx.execute(sql`RELEASE SAVEPOINT support_action`); woken(row, a, performed.body); result = { body: performed.body }; }
      catch (error) { const failed = refusedBy(error); if (!failed) throw error; await tx.execute(sql`ROLLBACK TO SAVEPOINT support_action`); result = failed; }
      if (performed?.trail) await tx.execute(changed(context, row, performed.trail));
      if (performed?.post) {
        const { rows: [started] } = await tx.execute<Row>(sql`WITH s AS (UPDATE support_actions SET status = 'running', started_at = now() WHERE id = ${row.id} RETURNING ${columns}),
          logged AS (${decided(context, row, { outcome: 'running' })}) SELECT * FROM s`);
        return { row: started!, post: performed.post };
      }
      return { row: (await tx.execute<Row>(finish(context, row, result, 'proposed'))).rows[0]! };
    });
    if (!claimed.post) return c.json(await shown(c, claimed.row), 200);
    // Posted once: a request that dies from here on leaves it running until settled() calls the outcome unknown.
    let result: NonNullable<Row['result']>, failure: unknown;
    try { result = { body: await (await wrapModuleLoad(() => import('./endpoints.js'))).postInboundTest(runtime, claimed.post) }; }
    catch (error) { failure = refusedBy(error) ? undefined : error; result = refusedBy(error) ?? { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server failure.' } }; }
    const { rows: [finished] } = await c.env.db.execute<Row>(finish(auditContext(c), claimed.row, result, 'running'));
    if (failure) throw failure;
    return c.json(await shown(c, finished ?? (await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_actions WHERE id = ${actionId}`)).rows[0]!), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-actions/{id}/decline', operationId: 'declineSupportAction',
    description: `Decline a change ${productName} support proposed to you. Nothing changes; declining again answers the same.`,
    request: { params: SessionParam }, responses: { 200: response(Action), ...errors } }), async c => {
    const userId = await person(c), actionId = c.req.valid('param').id;
    const row = await c.env.db.transaction(async tx => {
      const { row, a } = await decision(tx, actionId, userId);
      if (row.status === 'declined') return row;
      if (row.status !== 'proposed') throw new ApiError(409, 'SUPPORT_ACTION_CONFIRMED', 'You already confirmed this proposal.');
      if (row.expired) throw expired();
      c.set('actor', a);
      const { rows: [declined] } = await tx.execute<Row>(sql`WITH s AS (UPDATE support_actions SET status = 'declined', resolved_at = now() WHERE id = ${row.id} RETURNING ${columns}),
        logged AS (${decided(auditContext(c), row, { outcome: 'declined' })}) SELECT * FROM s`);
      return declined!;
    });
    return c.json(view(c, row), 200);
  });
}
