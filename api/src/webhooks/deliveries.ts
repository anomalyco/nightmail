import { recordAudit, auditInsert, auditContext } from '../audit.js';
import { approvalField, tiedNextStep, tieAllows } from '../approval-ties.js';
import { z, createRoute } from '@hono/zod-openapi';
import { and, eq, lt, desc, sql, asc } from 'drizzle-orm';
import { WebhookUrlHint, webhookUrlHint } from '../core/access.js';
import { ApiError, redactCapabilityData, notFound, errors, denied } from '../core/errors.js';
import { region } from '../core/ses.js';
import { id, rowId, security, PageQuery, response, json, IdParams, chargeBudget, readCursor, nextCursor } from '../core/http.js';
import type { Database, Actor, Runtime, DbExecutor, App, JobHandler } from '../core/types.js';
import { chargeManualDelivery, enqueue, WEBHOOK_ATTEMPTS, JobDeferred, webhookClaimCtes, claimedWithWebhooks } from '../jobs.js';
import { refusedForGood, retryAfterMs, ActionRetry } from '../ritual-retry.js';
import { withRegionSettings } from '../ses-region-state.js';
import { eventTypes, webhookSecretAudit, deliveries, webhooks, type PublishedEvent, deliveryAttempts } from '../db/operations.js';
import { webhookUserAgent, webhookTestHeaders } from '../brand.js';
import { eventSchema } from '../ses/feedback.js';
import { WebhookHeaderViews, WebhookHeaders, outwardEvent, scoped, webhookUrl, now, workspaceActor, metadata, webhookManager, secretBinding, webhookSecret, encrypt, encryptWebhookHeaders, ownWebhook, decrypt, hmac, postWebhook } from './crypto.js';

const webhookSchema = z.object({ id: z.string(), url: WebhookUrlHint, description: z.string(), eventTypes: z.array(z.enum(eventTypes)), regions: z.array(z.string()).nullable(), paused: z.boolean(), headers: WebhookHeaderViews, createdAt: z.string(), updatedAt: z.string(), approval: approvalField }).openapi('Webhook');
const webhookInput = z.object({ url: z.string().url().max(2048), description: z.string().max(500).default(''), eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).default(['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed']), regions: z.array(z.string()).min(1).max(40).nullable().optional(), paused: z.boolean().default(false), headers: WebhookHeaders.optional() }).openapi('CreateWebhook');
const webhookPatch = webhookInput.partial().extend({ description: z.string().max(500).optional(), eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).optional(), paused: z.boolean().optional() }).openapi('UpdateWebhook');
const secretSchema = z.object({ secret: z.string() }).openapi('WebhookSecret');
const deliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), payload: eventSchema, synthetic: z.boolean(), status: z.enum(['pending', 'delivered', 'failed', 'paused']), attemptCount: z.number(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('WebhookDelivery');
const attemptSchema = z.object({ id: z.string(), deliveryId: z.string(), statusCode: z.number().nullable(), error: z.string().nullable(), durationMs: z.number(), createdAt: z.string() }).openapi('WebhookAttempt');
const queuedSchema = z.object({ id: z.string(), status: z.literal('pending') }).openapi('QueuedWebhookDelivery');
const deletedSchema = z.object({ deleted: z.boolean() }).openapi('WebhookDeleted');
const listSchema = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
// A held webhook is marked (reconfirm). Its URL is write-only, so nothing is posted to it, a test included, until
// the URL is sent again. Sending the URL takes the webhook over: the mark goes, and so does the signing secret the
// approval was given (on create or rotate).
const webhookNeedsUrl = () => new ApiError(409, 'WEBHOOK_URL_REQUIRED', 'Deliveries were held when the approval that set up or changed this webhook was removed, and its URL is write-only. Send the URL again to resume; the webhook then gets a new signing secret.', 'url');
const REVEALS_PER_MINUTE = 10;
/** One row in webhook_secret_audit (migration 220) for each hand-out of a signing secret. */
const recordSecret = (db: Pick<Database, 'insert'>, a: Actor, webhookId: string, action: 'created' | 'revealed' | 'rotated') =>
  db.insert(webhookSecretAudit).values({ workspaceId: a.workspaceId, id: id('wsa'), webhookId, action, actorKeyId: a.keyId, credential: a.credential ?? 'apiKey', actorEmail: a.email ?? null });
function visibleDelivery(row: typeof deliveries.$inferSelect, a: Actor) {
  return deliverySchema.parse({ ...row, payload: outwardEvent(a.permissions.includes('manage') ? row.payload : { ...row.payload, data: redactCapabilityData(row.payload.data) }) });
}
async function getWebhook(runtime: Runtime, a: Actor, webhookId: string, db: DbExecutor = runtime.db) { const [row] = await db.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))); return row ?? notFound('Webhook'); }
/**
 * Testing a sending webhook (POST /v1/webhooks/{id}/test, and a support action the customer confirmed signed in): one
 * synthetic email.delivered delivery, charged as one manual post, in the caller's transaction.
 */
export async function testSendingWebhook(runtime: Runtime, tx: DbExecutor, a: Actor, webhookId: string) {
  const endpoint = await getWebhook(runtime, a, webhookId, tx); webhookUrl(runtime, endpoint.url);
  if (endpoint.reconfirm) throw webhookNeedsUrl();
  const deliveryId = rowId('whd'), event: PublishedEvent = { id: id('evt_test'), type: 'email.delivered', createdAt: now(), workspaceId: a.workspaceId, region: null, data: { synthetic: true, test: true, message: 'Explicit webhook endpoint test. No email was sent.' } };
  await chargeManualDelivery(tx, a.workspaceId, 1); await tx.insert(deliveries).values({ id: deliveryId, workspaceId: a.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event, synthetic: true }); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId, generation: 0 } });
  return { id: deliveryId, status: 'pending' as const };
}
/** Retrying a sending-webhook delivery (POST /v1/webhooks/{id}/deliveries/{deliveryId}/retry, and a confirmed support action), in the caller's transaction. */
export async function retrySendingDelivery(runtime: Runtime, tx: DbExecutor, a: Actor, webhookId: string, deliveryId: string) {
  await getWebhook(runtime, a, webhookId, tx);
  const [row] = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, webhookId), eq(deliveries.id, deliveryId))).for('update'); if (!row) return notFound('Delivery');
  if (row.status === 'pending') throw new ApiError(409, 'DELIVERY_PENDING', 'This delivery already has a pending attempt.');
  const generation = row.generation + 1; await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(eq(deliveries.id, row.id)); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId: row.id, generation } });
  await chargeManualDelivery(tx, a.workspaceId, 1);
  return { id: deliveryId, status: 'pending' as const };
}

export function registerWebhooks(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks', operationId: 'listWebhooks', tags: ['Webhooks'], security, request: { query: PageQuery }, responses: { 200: response(listSchema(webhookSchema, 'WebhookPage')), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'); const rows = await c.env.db.select().from(webhooks).where(and(scoped(webhooks, a), q.cursor ? lt(webhooks.id, q.cursor) : undefined)).orderBy(desc(webhooks.id)).limit(q.limit + 1);
    return c.json({ data: await Promise.all(rows.slice(0, q.limit).map(row => metadata(c.env, row, a))), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  // The signing secret comes back once with the new endpoint, like an API key, so a first delivery can be verified
  // without a rotation; revealWebhookSecret reads it again later and rotateWebhookSecret replaces it.
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks', operationId: 'createWebhook', tags: ['Webhooks'], security, description: 'Create an endpoint for email events. The response includes the signing secret (whsec_…) used for the Webhook-Signature header; store it on your server. Deliveries follow Standard Webhooks: Webhook-Signature is v1,<base64 HMAC-SHA256 of "{Webhook-Id}.{Webhook-Timestamp}.{raw body}"> keyed with the base64 bytes after whsec_. Failed deliveries (408, 429, 5xx or network error) are tried up to 10 times with exponential backoff (15 s, 1 min, 4 min, 16 min, 64 min, ~4.3 h, then 12 h between remaining attempts, honoring Retry-After). Set up over MCP, or with a key that was, it is tied to that approval: approval and nextStep in the result say until when.', request: { body: json(webhookInput) }, responses: { 201: response(webhookSchema.extend({ secret: z.string().describe('The signing secret, whsec_ followed by 32 base64 bytes. Read it again with revealWebhookSecret.'), nextStep: z.string().optional().describe('Only for a webhook tied to an MCP approval: what it depends on and how to make a lasting one.') }).openapi('CreatedWebhook')), ...errors } }), async c => {
    const a = webhookManager(c), { headers, ...body } = c.req.valid('json'), webhookId = id('wh'); const url = webhookUrl(c.env, body.url), binding = secretBinding(a, webhookId), secret = webhookSecret();
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const values = { ...body, id: webhookId, workspaceId: a.workspaceId, url, regions: body.regions ?? null, encryptedSecret: await encrypt(c.env, secret, binding), encryptedHeaders: await encryptWebhookHeaders(c.env, headers, binding) };
    const [row] = await c.env.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(140913,hashtext(${a.workspaceId}))`);
      if ((await tx.execute(sql`SELECT 1 FROM operation_webhooks WHERE workspace_id=${a.workspaceId} OFFSET 9 LIMIT 1`)).rowCount) throw new ApiError(409,'WEBHOOK_LIMIT_REACHED','A workspace can have at most 10 operation webhook endpoints (including paused endpoints).');
      await ownWebhook(c, tx, a, webhookId);
      const created = await tx.insert(webhooks).values(values).returning();
      await recordSecret(tx, a, webhookId, 'created');
      await recordAudit(tx, c, { action: 'webhook.create', workspaceId: a.workspaceId, target: { type: 'webhook', id: webhookId }, after: { url: webhookUrlHint(url), eventTypes: body.eventTypes, regions: body.regions ?? null, paused: body.paused, headerNames: headers?.map(h => h.name) } });
      return created;
    });
    c.header('Cache-Control', 'no-store');
    const view = await metadata(c.env, row!, a);
    return c.json({ ...view, ...view.approval ? { nextStep: tiedNextStep('webhook', view.approval) } : {}, secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}', operationId: 'getWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c); return c.json(await metadata(c.env, await getWebhook(c.env, a, c.req.valid('param').id), a), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/webhooks/{id}', operationId: 'updateWebhook', tags: ['Webhooks'], security, request: { params: IdParams, body: json(webhookPatch) }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = webhookManager(c), current = await getWebhook(c.env, a, c.req.valid('param').id), { headers, ...body } = c.req.valid('json'); if (body.url) body.url = webhookUrl(c.env, body.url);
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const row = await c.env.db.transaction(async tx => {
      await ownWebhook(c, tx, a, current.id);
      const [locked] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).for('update'); if (!locked) return notFound('Webhook');
      if (locked.reconfirm && body.paused === false && !body.url) throw webhookNeedsUrl();
      const takeover = locked.reconfirm && body.url ? { reconfirm: false, encryptedSecret: await encrypt(c.env, webhookSecret(), secretBinding(a, current.id)) } : {};
      const [updated] = await tx.update(webhooks).set({ ...body, ...takeover, encryptedHeaders: await encryptWebhookHeaders(c.env, headers ?? (body.url && body.url !== locked.url ? [] : undefined), secretBinding(a, current.id)), updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).returning();
      // The first page resumes with the unpause; a full page hands the rest to a resume job (resumeDeliveries).
      if (locked.paused && body.paused === false && await resumeParked(tx, a.workspaceId, current.id) === RESUME_PAGE)
        await enqueue(tx, { type: 'operation.resumeDeliveries', workspaceId: a.workspaceId, payload: { webhookId: current.id } });
      // Changed field names and non-secret values: a URL hint, never header values.
      await recordAudit(tx, c, { action: 'webhook.update', workspaceId: a.workspaceId, target: { type: 'webhook', id: current.id }, details: { fields: [...Object.keys(body), ...(headers ? ['headers'] : [])] },
        before: { url: body.url ? webhookUrlHint(locked.url) : undefined, eventTypes: body.eventTypes ? locked.eventTypes : undefined, regions: body.regions !== undefined ? locked.regions : undefined, paused: body.paused !== undefined ? locked.paused : undefined },
        after: { url: body.url ? webhookUrlHint(body.url) : undefined, eventTypes: body.eventTypes, regions: body.regions, paused: body.paused, headerNames: headers?.map(h => h.name) } });
      return updated!;
    }); return c.json(await metadata(c.env, row, a), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/webhooks/{id}', operationId: 'deleteWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(deletedSchema), ...errors } }), async c => {
    const a = webhookManager(c), row = await getWebhook(c.env, a, c.req.valid('param').id);
    await c.env.db.execute(sql`WITH deleted AS (DELETE FROM operation_webhooks WHERE workspace_id=${a.workspaceId} AND id=${row.id} RETURNING id),
      audit AS (${auditInsert(auditContext(c), { action: 'webhook.delete', workspaceId: a.workspaceId, target: { type: 'webhook', id: sql`deleted.id` }, before: { url: webhookUrlHint(row.url), eventTypes: row.eventTypes, paused: row.paused } }, { from: sql`deleted` })}) SELECT 1`);
    return c.json({ deleted: true }, 200);
  });
  // Reveal hands out a durable capability: whoever holds the secret can sign requests the receiver trusts, with no trace in
  // Nightmail. So only a person's own credentials read it back (a dashboard session, or an API key not made through an MCP
  // approval), at most REVEALS_PER_MINUTE times a minute per workspace, and every hand-out is recorded. Rotation stays open
  // to every manage credential: it breaks the receiver until it is updated, so it can't go unnoticed.
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/secret', operationId: 'revealWebhookSecret', tags: ['Webhooks'], security, description: `Read the endpoint's signing secret back. Only a dashboard session or an API key you created can: MCP approvals, the API keys they create and temporary agent tokens get 403 CREDENTIAL_DELEGATION_FORBIDDEN (they can rotate it instead). At most ${REVEALS_PER_MINUTE} reads a minute per workspace (429 REVEAL_RATE_LIMITED); each read is recorded with the credential and time.`, request: { params: IdParams }, responses: { 200: response(secretSchema), ...errors } }), async c => {
    const a = webhookManager(c);
    if (a.credential === 'mcp' || a.credential === 'agentToken' || a.grantId) throw denied('CREDENTIAL_DELEGATION_FORBIDDEN', 'Read a signing secret back from the dashboard or with an API key you created. MCP approvals and agent tokens can rotate it instead.', { permission: 'configuration', level: 'write', credential: 'notDelegated' });
    const row = await getWebhook(c.env, a, c.req.valid('param').id); c.header('Cache-Control', 'no-store');
    if (!await chargeBudget(c.env, a.workspaceId, 'webhook-secret:reveal', REVEALS_PER_MINUTE)) {
      c.header('Retry-After', '60');
      throw new ApiError(429, 'REVEAL_RATE_LIMITED', `This workspace read signing secrets back ${REVEALS_PER_MINUTE} times in the last minute. Retry after the window resets.`, undefined, true);
    }
    const secret = await decrypt(c.env, row.encryptedSecret, secretBinding(a, row.id));
    // Both records commit before the secret is returned: the secret hand-out log and the account's audit trail.
    await c.env.db.transaction(async tx => {
      await recordSecret(tx, a, row.id, 'revealed');
      await recordAudit(tx, c, { action: 'webhook.secret_reveal', workspaceId: a.workspaceId, target: { type: 'webhook', id: row.id }, details: { url: webhookUrlHint(row.url) } });
    });
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/rotate-secret', operationId: 'rotateWebhookSecret', tags: ['Webhooks'], security, description: 'Replace the endpoint\'s signing secret and return the new one. Deliveries are signed with it from now on, so update your receiver. Each rotation is recorded with the credential and time.', request: { params: IdParams }, responses: { 200: response(secretSchema), ...errors } }), async c => {
    const a = webhookManager(c), webhookId = c.req.valid('param').id, binding = secretBinding(a, webhookId); c.header('Cache-Control', 'no-store');
    // The approval is held and the webhook row locked from the read to the end: the secret written is the one the row
    // holds when this commits, and a removal that lands later holds the webhook, whose URL then takes it over.
    const secret = await c.env.db.transaction(async tx => {
      await ownWebhook(c, tx, a, webhookId);
      const [row] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))).for('update'); if (!row) return notFound('Webhook');
      const secret = webhookSecret();
      await tx.update(webhooks).set({ encryptedSecret: await encrypt(c.env, secret, binding), updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId)));
      await recordSecret(tx, a, webhookId, 'rotated');
      await recordAudit(tx, c, { action: 'webhook.secret_rotate', workspaceId: a.workspaceId, target: { type: 'webhook', id: row.id }, details: { url: webhookUrlHint(row.url) } });
      return secret;
    });
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/test', operationId: 'testWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), webhookId = c.req.valid('param').id;
    return c.json(await c.env.db.transaction(tx => testSendingWebhook(c.env, tx, a, webhookId)), 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tags: ['Webhooks'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(listSchema(deliverySchema, 'WebhookDeliveryPage')), ...errors } }), async c => {
    // Newest first by creation time: delivery IDs are random, so ordering by ID showed an arbitrary sample, not the latest.
    const a = workspaceActor(c), endpoint = await getWebhook(c.env, a, c.req.valid('param').id), q = c.req.valid('query'), binding = `webhook-deliveries:${endpoint.id}`, cursor = readCursor(q.cursor, binding);
    const rows = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, endpoint.id), cursor ? sql`(${deliveries.createdAt},${deliveries.id})<(${cursor.at}::timestamptz,${cursor.id})` : undefined)).orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(row => visibleDelivery(row, a)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  const deliveryParams = z.object({ id: z.string(), deliveryId: z.string() }).openapi('WebhookDeliveryParams');
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries/{deliveryId}', operationId: 'getWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 200: response(deliverySchema.extend({ attempts: z.array(attemptSchema) }).openapi('WebhookDeliveryDetail')), ...errors } }), async c => {
    const a = workspaceActor(c), p = c.req.valid('param'); const [row] = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))); if (!row) return notFound('Delivery'); const attempts = await c.env.db.select().from(deliveryAttempts).where(and(scoped(deliveryAttempts, a), eq(deliveryAttempts.deliveryId, row.id))).orderBy(asc(deliveryAttempts.createdAt)); return c.json({ ...visibleDelivery(row, a), attempts: attempts.map(row => attemptSchema.parse(row)) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', operationId: 'retryWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), p = c.req.valid('param');
    return c.json(await c.env.db.transaction(tx => retrySendingDelivery(c.env, tx, a, p.id, p.deliveryId)), 202);
  });
}

// Resumes one page of an unpaused endpoint's parked deliveries and returns the page's size; a full page means more
// may remain. A resumed delivery keeps the attempts it already made: a pause holds the remaining retries, it does not
// refill them. One that already used its attempts fails instead of starting another round. An endpoint paused again
// resumes nothing: its next unpause starts over.
const RESUME_PAGE = 100;
async function resumeParked(db: DbExecutor, workspaceId: string, webhookId: string) {
  const { rows } = await db.execute<{ n: number }>(sql`WITH hook AS MATERIALIZED (
      SELECT id FROM operation_webhooks WHERE workspace_id=${workspaceId} AND id=${webhookId} AND NOT paused FOR SHARE
    ), parked AS (
      SELECT d.id, d.attempt_count FROM operation_deliveries d JOIN hook ON hook.id=d.webhook_id WHERE d.workspace_id=${workspaceId} AND d.status='paused' ORDER BY d.id LIMIT ${RESUME_PAGE} FOR UPDATE OF d
    ), exhausted AS (
      UPDATE operation_deliveries d SET status='failed', last_error='WEBHOOK_RETRIES_EXHAUSTED', updated_at=now() FROM parked p WHERE d.id=p.id AND p.attempt_count>=${WEBHOOK_ATTEMPTS}
    ), resumed AS (
      UPDATE operation_deliveries d SET status='pending', generation=d.generation+1, updated_at=now() FROM parked p WHERE d.id=p.id AND p.attempt_count<${WEBHOOK_ATTEMPTS} RETURNING d.id, d.generation, d.attempt_count
    ), queued AS (
      INSERT INTO jobs(id, workspace_id, type, payload, attempts)
      SELECT public.row_id('job'), ${workspaceId}, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', generation), attempt_count FROM resumed
    ) SELECT count(*)::int AS n FROM parked`);
  return Number(rows[0]?.n ?? 0);
}
// Each page commits on its own; after a few seconds the job yields and is picked up again.
export const resumeDeliveries: JobHandler = async (runtime, payload, job) => {
  for (const until = Date.now() + 5_000; Date.now() < until;)
    if (await resumeParked(runtime.db, job.workspaceId, String(payload.webhookId)) < RESUME_PAGE) return;
  throw new JobDeferred(now());
};
export const webhookJob: JobHandler = async (runtime, payload, job) => {
  const delivery = job.webhook !== undefined ? job.webhook : (await runtime.db.execute<{webhook: import('../core/types.js').ClaimedWebhook | null}>(sql`WITH claimed AS (
    SELECT ${job.id}::text id,${job.workspaceId}::text workspace_id,${JSON.stringify(payload)}::jsonb payload,'operation.webhook'::text type
  ), ${webhookClaimCtes} ${claimedWithWebhooks}`)).rows[0]?.webhook;
  if (!delivery) return;
  const start = Date.now(); let statusCode: number | null = null, error: string | null = null, retryable = true, afterMs = 0;
  // A webhook tied to an approval is posted to only while that approval is active, like a request from a key the
  // approval created. Otherwise the delivery fails here, unsent; it can be retried by hand once the approval is active.
  // Every approval that owns it must be active: the rule getWebhook reports as approval.active (approval-ties.ts).
  const inactive = !!delivery.owned && !(await runtime.db.execute<{ allowed: boolean }>(sql`SELECT ${tieAllows(runtime.config, job.workspaceId, delivery.webhook_id, 'webhook')} AS allowed`)).rows[0]!.allowed;
  if (inactive) { error = 'APPROVAL_INACTIVE'; retryable = false; }
  else try {
    const url = webhookUrl(runtime, delivery.url), binding = secretBinding(job, delivery.webhook_id), secret = await decrypt(runtime, delivery.encrypted_secret, binding);
    const body = JSON.stringify(outwardEvent(eventSchema.parse(delivery.payload))), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmac(secret, `${delivery.event_id}.${timestamp}.${body}`);
    const result = await postWebhook(runtime, url, { 'Webhook-Id': delivery.event_id, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': webhookUserAgent, ...(delivery.synthetic ? Object.fromEntries(webhookTestHeaders.map(name => [name, 'true'])) : {}) }, body, delivery.encrypted_headers, binding);
    statusCode = result.status;
    if (statusCode < 200 || statusCode >= 300) { error = 'WEBHOOK_HTTP_ERROR'; retryable = !refusedForGood(statusCode); afterMs = retryAfterMs(result.retryAfter); }
  } catch (e) { if(e instanceof JobDeferred)throw e; error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < WEBHOOK_ATTEMPTS;
  const records = sql`attempt AS (INSERT INTO operation_delivery_attempts(id,workspace_id,delivery_id,status_code,error,duration_ms)
    SELECT ${id('wha')},${job.workspaceId},${delivery.delivery_id},${statusCode}::int,${error}::text,${Date.now()-start}::int FROM settled),
    recorded AS (UPDATE operation_deliveries SET attempt_count=attempt_count+1,status=${!error ? 'delivered' : retry ? 'pending' : 'failed'},
      last_status_code=${statusCode}::int,last_error=${error}::text,updated_at=now() FROM settled
      WHERE workspace_id=${job.workspaceId} AND operation_deliveries.id=${delivery.delivery_id} AND generation=${delivery.generation})`;
  if (job.recordWithSettlement) job.recordWithSettlement(records);
  else await runtime.db.execute(sql`WITH settled AS (SELECT 1), ${records} SELECT 1`);
  // A retry waits at least the endpoint's Retry-After (src/jobs.ts retryDelay).
  if (error && !inactive) throw retry ? new ActionRetry(error, afterMs) : new ApiError(503, error, 'Webhook delivery failed; inspect the stored delivery attempts.', undefined, false);
};
