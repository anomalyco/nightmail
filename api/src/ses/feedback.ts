import { z } from '@hono/zod-openapi';
import { sql, and, eq, or, isNull } from 'drizzle-orm';
import { lazyModule, ApiError, ModuleLoadError, wrapModuleLoad } from '../core/errors.js';
import { simulatedTopic, taggedEmailId, isSimulatedSes } from '../core/ses.js';
import { digest, id, rowId } from '../core/http.js';
import { log } from '../log.js';
import { EmailEventData, type Runtime, type FeedbackItem, type JobHandler } from '../core/types.js';
import { jobs } from '../db/core.js';
import { contacts, mergeSuppression } from '../db/audience.js';
import { emails } from '../db/sending.js';
import type { RoutineIngress } from '../sending/events.js';
import { realDestination } from '../hosted-sending.js';
import { eventTypes, type EventType, snsReceipts, type PublishedEvent, events, webhooks, deliveries } from '../db/operations.js';
import { now, scoped, publishEvent } from '../webhooks/crypto.js';

export const loadSendingOps = lazyModule(() => import('../sending/events.js'));
export const eventSchema = z.object({ id: z.string(), type: z.enum(eventTypes), createdAt: z.string(), workspaceId: z.string(), region: z.string().nullable(), data: EmailEventData }).openapi('Event');
export function verifySesAccount(runtime: Runtime, message: unknown, topicArn: string) {
  const accountId = (message as { mail?: { sendingAccountId?: unknown } } | null)?.mail?.sendingAccountId;
  // SNS topics can receive cross-account SES events; only an explicit SES account binding is authoritative.
  const expected = runtime.config.multiTenant ? topicArn.split(':')[4] : runtime.config.awsAccountId;
  if ((runtime.config.multiTenant && !/^\d{12}$/.test(expected ?? '')) || (expected && accountId !== expected)) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'The SES sending account is missing or does not match this topic.');
}

const sesEvents: Record<string, { type: EventType; rawType: string }> = { Send: { type: 'email.sent', rawType: 'send' }, Delivery: { type: 'email.delivered', rawType: 'delivery' }, Bounce: { type: 'email.bounced', rawType: 'bounce' }, Complaint: { type: 'email.complained', rawType: 'complaint' }, DeliveryDelay: { type: 'email.delivery_delayed', rawType: 'delivery_delay' }, Reject: { type: 'email.rejected', rawType: 'reject' }, RenderingFailure: { type: 'email.rendering_failed', rawType: 'rendering_failure' }, Open: { type: 'email.opened', rawType: 'open' }, Click: { type: 'email.clicked', rawType: 'click' } };
export function sesFeedbackIdentity(data: Record<string, any>) {
  const providerId = data?.mail?.messageId;
  if (typeof providerId !== 'string' || !providerId) throw new ApiError(422, 'SES_INVALID_EVENT', 'SES event lacks a mail.messageId.');
  const eventType = data.eventType ?? data.notificationType, kind = eventType === 'Rendering Failure' ? 'RenderingFailure' : eventType;
  if (typeof kind !== 'string' || (kind !== 'Subscription' && !Object.hasOwn(sesEvents,kind))) throw new ApiError(422, 'SES_UNSUPPORTED_EVENT', 'Unsupported SES event type.');
  return { providerId, kind };
}
// ISPs can omit feedback type on an actual complaint. An explicit non-abuse report
// (notably not-spam) is an observation, not permission to suppress the recipient.
function feedbackClass(kind: string, detail: Record<string, any>) {
  if (kind === 'Complaint') return typeof detail.complaintFeedbackType === 'string' && detail.complaintFeedbackType.trim().toLowerCase()==='not-spam' ? 'complaint_feedback' : 'complaint';
  if (kind === 'Bounce') return detail.bounceType !== 'Permanent' ? 'non_permanent_bounce' : detail.bounceSubType === 'EmailValidationSuppressed' ? 'validation_suppressed' : 'bounce';
  return sesEvents[kind]?.rawType;
}
// What a bounce or a delay keeps of SES's report, in its email event (EmailEventData): the receiving server's reply, of
// the first recipient that has one, as one bounded line; and a delay's kind and deadline. The reply is a stranger's
// text: bidi overrides, isolates and zero-width marks go (the set the dashboard takes from sender names,
// app/src/lib/private-address.ts), then control characters, surrogates and white space become single spaces. A bounce
// SES wrote itself keeps none: its text is about the sending account at Amazon, which a hosted sender cannot act on.
const DIAGNOSTIC_CHARS = 500, SES_BOUNCES = ['Suppressed', 'OnAccountSuppressionList', 'EmailValidationSuppressed'];
function feedbackReason(kind: string, detail: Record<string, any>) {
  if (kind !== 'Bounce' && kind !== 'DeliveryDelay') return {};
  const recipients: unknown = kind === 'Bounce' ? detail.bouncedRecipients : detail.delayedRecipients;
  const reply = kind === 'Bounce' && SES_BOUNCES.includes(detail.bounceSubType) ? undefined
    : (Array.isArray(recipients) ? recipients : []).map(r => typeof r?.diagnosticCode === 'string' ? r.diagnosticCode.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\s]+/g, ' ').trim() : '').find(Boolean);
  const expires = kind === 'DeliveryDelay' && typeof detail.expirationTime === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(detail.expirationTime) ? Date.parse(detail.expirationTime) : NaN;
  return { ...(reply ? { diagnosticCode: reply.slice(0, DIAGNOSTIC_CHARS) } : {}),
    ...(kind === 'DeliveryDelay' && typeof detail.delayType === 'string' && /^[A-Za-z]{1,64}$/.test(detail.delayType) ? { delayType: detail.delayType } : {}),
    ...(Number.isFinite(expires) ? { expirationTime: new Date(expires).toISOString() } : {}) };
}
export function routineInput(item: FeedbackItem, enqueueOther = false): RoutineIngress {
  const data = item.message as Record<string, any>;
  const { kind, providerId } = sesFeedbackIdentity(data);
  const type = kind === 'Send' ? 'send' : kind === 'Delivery' ? 'delivery' : 'receipt';
  const simulated = simulatedTopic(item.topicArn, item.region);
  if (type === 'receipt' && simulated) throw new ApiError(422, 'SIMULATED_FEEDBACK_UNSUPPORTED', 'The simulator emits Send and Delivery callbacks only.');
  // HTTP without a queue still defers these to its durable job. The queue can apply the
  // same facts to a whole batch; subscription changes keep their distinct consent workflow.
  const detail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const extended = type === 'receipt' && !enqueueOther && kind !== 'Subscription';
  const timestamp = detail.timestamp;
  const createdAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : now();
  const payload = { message: item.message, topicArn: item.topicArn, messageId: item.messageId, region: item.region };
  const classification = feedbackClass(kind, detail), validation = classification === 'validation_suppressed';
  const engagement = kind === 'Open' || kind === 'Click';
  const reported = kind === 'Bounce' ? detail.bouncedRecipients : kind === 'Complaint' ? detail.complainedRecipients : undefined;
  return { type: extended ? classification! : type, providerId, taggedEmailId: taggedEmailId(item.message), createdAt, externalId: `${item.topicArn}:${item.messageId}`,
    data: { providerId, ...(validation ? {suppressionReason:'email_validation'} : {}), ...(engagement ? { isBotEvent: detail.isBotEvent ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof detail.link === 'string' ? { link: detail.link } : {}),
      ...(kind === 'Bounce' ? { bounceType: detail.bounceType ?? 'Unknown', bounceSubType: detail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Complaint' && detail.complaintFeedbackType != null ? {complaintFeedbackType:detail.complaintFeedbackType} : {}), ...feedbackReason(kind, detail) },
    ...(extended ? { effects: { reported: Array.isArray(reported) && reported.length ? reported.map(r => typeof r?.emailAddress === 'string' ? r.emailAddress.toLowerCase() : null) : null,
      suppress: classification === 'complaint' ? 'complaint' : validation ? 'email_validation' : classification === 'bounce' ? 'hard_bounce' : null,
      observe: engagement && detail.isBotEvent !== true && detail.isBotEvent !== 'Likely' ? kind.toLowerCase() : null,
      receiptTime: !(typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) } } : {}),
    ingress: { topicArn: item.topicArn, messageId: item.messageId, region: item.region, payload, recoveryType: type === 'receipt' && !enqueueOther && !extended ? undefined : simulated ? 'operation.simulatedFeedbackRecovery' : 'operation.ses' } };
}
/**
 * Batch feedback ingestion for the feedback queue consumer. Mail status, reputation, engagement
 * and delivery jobs commit in one statement per batch; subscription changes use the consent
 * workflow after opening a receipt. Returns one outcome per input so the caller
 * can acknowledge or retry messages individually. Live items are trusted only after the SNS
 * signature check at ingress; simulated items must carry the simulator's synthetic identity.
 */
export async function ingestFeedbackBatch(runtime: Runtime, items: FeedbackItem[]): Promise<{ ok: boolean; error?: string }[]> {
  const { ingestRoutineSesEvents } = await loadSendingOps();
  const outcomes: { ok: boolean; error?: string }[] = items.map(() => ({ ok: false }));
  const group: { index: number; input: RoutineIngress }[] = [];
  const other: { index: number; item: FeedbackItem; workspaceId: string }[] = [];
  for (const [index, item] of items.entries()) {
    // An SES tenant status change from EventBridge, published to the pool's own feedback topic (src/standing.ts).
    // A database failure propagates, so the queue redelivers it.
    const standing = runtime.config.multiTenant && !simulatedTopic(item.topicArn) && item.message?.source === 'aws.ses' ? await import('../standing.js') : null;
    const tenantEvent = standing?.tenantStatusEvent(item.message);
    if (standing && tenantEvent) {
      const refused = await standing.ingestTenantStatus(runtime, tenantEvent, item);
      outcomes[index] = refused ? { ok: false, error: refused } : { ok: true }; continue;
    }
    try {
      if (simulatedTopic(item.topicArn)) assertSimulatedFeedback(runtime, item);
      else verifySesAccount(runtime, item.message, item.topicArn);
      group.push({ index, input: routineInput(item) });
    } catch (error) { outcomes[index] = { ok: false, error: error instanceof ApiError ? error.code : 'FEEDBACK_INVALID' }; }
  }
  const persist = async (batch: typeof group, retry = true): Promise<void> => {
    if (!batch.length) return;
    let results: Awaited<ReturnType<typeof ingestRoutineSesEvents>>;
    try {
      results = await ingestRoutineSesEvents(runtime, batch.map(entry => entry.input));
    } catch (error) {
      if (error instanceof ModuleLoadError) throw error;
      const failure=feedbackFailure(error);
      if (failure!=='retry' && (batch.length>1 || retry)) {
        if (failure==='conflict') await feedbackBackoff();
        if (batch.length===1) return persist(batch,false);
        const mid=Math.ceil(batch.length/2);
        await persist(batch.slice(0,mid)); await persist(batch.slice(mid)); return;
      }
      for (const {index} of batch) outcomes[index]=failure==='data' ? await quarantineFeedback(runtime,items[index]!) : {ok:false,error:'FEEDBACK_PERSIST_FAILED'};
      return;
    }
    for (const [position, entry] of batch.entries()) {
      const result = results[position]!;
      if (result.error || !result.workspaceId) {
        const error = result.error ?? 'SES_EMAIL_NOT_FOUND';
        outcomes[entry.index] = { ok: false, error: !result.workspaceId && error === 'SES_EMAIL_NOT_FOUND' ? 'SES_FEEDBACK_UNMATCHED' : error };
        continue;
      }
      if (entry.input.type === 'receipt') { other.push({ index: entry.index, item: items[entry.index]!, workspaceId: result.workspaceId }); continue; }
      outcomes[entry.index] = { ok: true };
    }
    try {
      if(results.some(r=>r.recovery)) await runtime.wake?.(1);
      if(results[0]?.hooks) await runtime.wake?.(results[0].hooks,'webhook');
    }catch{log('warn',{code:'QUEUE_WAKE_FAILED',message:'Feedback recovery and webhook jobs remain durable.'});}
  };
  await persist(group);
  // Subscription changes include separate consent audit records; preserve their input order.
  for (const { index, item, workspaceId } of other.sort((a,b)=>a.index-b.index)) {
    for (let attempt=1; attempt<=2; attempt++) try {
      await processSesReceipt(runtime, item, { id: `feedback:${item.topicArn}:${item.messageId}`, attempts: attempt, workspaceId });
      outcomes[index] = { ok: true }; break;
    } catch (error) {
      if (error instanceof ModuleLoadError) throw error;
      if (error instanceof ApiError && (error.code === 'SES_EMAIL_NOT_FOUND' || error.code === 'SES_ENVIRONMENT_MISMATCH')) {
        outcomes[index] = {ok:false,error:error.code}; break;
      }
      const failure=feedbackFailure(error);
      if (failure==='retry' || attempt===2) {
        outcomes[index]=failure==='data' ? await quarantineFeedback(runtime,item,workspaceId) : {ok:false,error:'FEEDBACK_PROCESS_FAILED'}; break;
      }
      if (failure==='conflict') await feedbackBackoff();
    }
  }
  return outcomes;
}

function feedbackFailure(error: unknown) {
  if (error instanceof ApiError) return error.retryable ? 'retry' : 'data';
  const pg=error as {cause?:{code?:string};code?:string}|null, code=pg?.cause?.code ?? pg?.code ?? '';
  if (code==='40P01' || code==='40001') return 'conflict';
  return /^(22|23|54)[0-9A-Z]{3}$/.test(code) ? 'data' : 'retry';
}
const feedbackBackoff=()=>new Promise(resolve=>setTimeout(resolve,10+Math.random()*20));
async function quarantineFeedback(runtime: Runtime, item: FeedbackItem, workspaceId?:string) {
  try {
    // Keep the verified input as escaped JSON text, not JSONB: a diagnostic may contain NUL.
    const key = await digest(JSON.stringify([item.topicArn,item.messageId]));
    const provider=(item.message.mail as {messageId?:unknown})?.messageId, tag=taggedEmailId(item.message);
    const simulated=simulatedTopic(item.topicArn, item.region);
    // Never take a workspace ID from a payload. Prefer the receipt; a rolled-back first
    // receipt can still be attributed if its pinned topic/region/provider match is unique.
    await runtime.db.execute(sql`INSERT INTO operation_feedback_failures(id,payload,topic_arn,workspace_id) VALUES (${key},${JSON.stringify(item)},${item.topicArn},
      coalesce(${workspaceId??null}::text,(SELECT workspace_id FROM operation_sns_receipts WHERE topic_arn=${item.topicArn} AND message_id=${item.messageId}),
        (SELECT min(workspace_id) FROM sending_emails WHERE region=${item.region} AND simulated=${simulated} AND provider_id=${typeof provider==='string' && /^[!-~]+$/.test(provider)?provider:null}
          ${tag?sql`AND id=${tag}`:sql``} ${!simulated && runtime.config.multiTenant?sql`AND feedback_topic_arn=${item.topicArn}`:sql``} HAVING count(*)=1))) ON CONFLICT DO NOTHING`);
    log('error',{code:'SES_FEEDBACK_QUARANTINED',id:key});
    return {ok:false,error:'SES_FEEDBACK_QUARANTINED'};
  } catch { return {ok:false,error:'FEEDBACK_PERSIST_FAILED'}; }
}

const UNTAGGED_PAYLOAD_CAP = 65536, RECOVERY_PREFIX = 'feedback-recovery/v1/';
type QueueRecoveryReason = 'FEEDBACK_UNTAGGED' | 'FEEDBACK_LEGACY_RECOVERY' | 'FEEDBACK_QUEUE_RECOVERY';
function recoverableJson(body: unknown): string | undefined {
  const seen = new Set<object>();
  const valid = (value: unknown): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    seen.add(value);
    const entries = Object.entries(value);
    const ok = (!Array.isArray(value) || entries.length === value.length && entries.every(([key], index) => key === String(index))) && entries.every(([, v]) => valid(v));
    seen.delete(value); return ok;
  };
  try { return valid(body) ? JSON.stringify(body) : undefined; } catch { return undefined; }
}
async function retainQueueFeedback(runtime: Runtime, lane: string, body: unknown, reason: QueueRecoveryReason): Promise<string | undefined> {
  // JSON is the provider-feedback format. Never replace an unrepresentable body with a preview and ack it.
  const text = recoverableJson(body); if (text === undefined) return;
  const prefix = reason === 'FEEDBACK_UNTAGGED' ? 'untagged' : reason === 'FEEDBACK_LEGACY_RECOVERY' ? 'legacy' : 'queue';
  const key = `${prefix}:${await digest(`${lane}\n${text}`)}`;
  const topic = (body as { topicArn?: unknown; body?: { topicArn?: unknown } } | null)?.topicArn ?? (body as { body?: { topicArn?: unknown } } | null)?.body?.topicArn;
  const chunks: string[] = [];
  if (text.length > UNTAGGED_PAYLOAD_CAP) {
    // Split on Unicode code points: passing a lone surrogate to PostgreSQL would destroy that byte sequence.
    const points = Array.from(text);
    for (let i = 0; i < points.length; i += 16384) chunks.push(points.slice(i, i + 16384).join(''));
  }
  return runtime.db.transaction(async tx => {
    const result = await tx.execute(sql`INSERT INTO operation_feedback_failures(id,payload,topic_arn,reason,payload_chunk_count)
      VALUES (${key},${chunks.length ? '' : text},${typeof topic === 'string' && topic.length <= 512 ? topic : null},${reason},${chunks.length})
      ON CONFLICT (id) DO UPDATE SET reason=EXCLUDED.reason RETURNING id`);
    if (result.rowCount !== 1) return;
    if (chunks.length) await tx.execute(sql`INSERT INTO operation_feedback_failure_chunks(failure_id,ordinal,payload)
      SELECT ${key},ordinality-1,payload FROM unnest(${sql.param(chunks)}::text[]) WITH ORDINALITY AS c(payload,ordinality) ON CONFLICT DO NOTHING`);
    return key;
  });
}
/**
 * Keeps an untagged item from the legacy feedback queue for operator review. The body is untrusted:
 * it is stored as complete text/chunks under a content digest and never attributed from its body.
 */
export async function quarantineUntaggedFeedback(runtime: Runtime, lane: string, body: unknown): Promise<boolean> {
  return !!await retainQueueFeedback(runtime, lane, body, 'FEEDBACK_UNTAGGED');
}
async function retainOrSpillFeedback(runtime: Runtime, body: import('../adapters/feedback-queue.js').LegacyFeedbackRecovery | import('../adapters/feedback-archive.js').FeedbackArchive, reason: QueueRecoveryReason): Promise<'database' | 'storage'> {
  try {
    if (!await retainQueueFeedback(runtime, body.source.queue, body, reason)) throw new Error('Feedback recovery could not be encoded');
    return 'database';
  } catch {
    // Independent of PostgreSQL and queue-message size. The complete, authenticated object is
    // reconciled into the quarantine table by the minute cron before this key is removed.
    const text = JSON.stringify(body), key = `${RECOVERY_PREFIX}${await digest(text)}.json`;
    await runtime.storage.put(key, Buffer.from(text), 'application/json');
    log('warn', { code: 'FEEDBACK_RECOVERY_SPILLED', sourceQueue: body.source.queue, sourceId: body.source.id });
    return 'storage';
  }
}
export async function retainLegacyFeedback(runtime: Runtime, body: import('../adapters/feedback-queue.js').LegacyFeedbackRecovery): Promise<'database' | 'storage'> {
  const { authenticLegacyRecovery } = await import('../adapters/feedback-queue.js');
  if (!authenticLegacyRecovery(runtime.config, body)) throw new Error('Unauthenticated legacy recovery');
  return retainOrSpillFeedback(runtime, body, 'FEEDBACK_LEGACY_RECOVERY');
}
export async function archiveQueueFeedback(runtime: Runtime, source: import('../adapters/feedback-archive.js').FeedbackSource, body: unknown, error: string): Promise<void> {
  const { feedbackArchive } = await import('../adapters/feedback-archive.js');
  const archive = await feedbackArchive(runtime.config.authSecret, source, body, error);
  await retainOrSpillFeedback(runtime, archive, 'FEEDBACK_QUEUE_RECOVERY');
}
/** Drain the private object-store spill buffer into PostgreSQL; never ingest from storage directly. */
export async function drainFeedbackRecovery(runtime: Runtime): Promise<number> {
  if (!runtime.storage.list) return 0;
  const [{ authenticLegacyRecovery }, { authenticFeedbackArchive }] = await Promise.all([import('../adapters/feedback-queue.js'),import('../adapters/feedback-archive.js')]);
  let stored = 0, after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await runtime.storage.list(RECOVERY_PREFIX, after);
    for (const entry of listed.objects) {
      const object = await runtime.storage.get(entry.key); if (!object) continue;
      const text = Buffer.from(object.body).toString('utf8');
      if (entry.key !== `${RECOVERY_PREFIX}${await digest(text)}.json`) { log('error',{code:'FEEDBACK_RECOVERY_CORRUPT'}); continue; }
      let value: unknown; try { value = JSON.parse(text); } catch { log('error',{code:'FEEDBACK_RECOVERY_CORRUPT'}); continue; }
      const reason = authenticLegacyRecovery(runtime.config,value) ? 'FEEDBACK_LEGACY_RECOVERY' : authenticFeedbackArchive(runtime.config,value) ? 'FEEDBACK_QUEUE_RECOVERY' : undefined;
      if (!reason) { log('error',{code:'FEEDBACK_RECOVERY_UNAUTHENTICATED'}); continue; }
      const source = (value as {source:{queue:string}}).source;
      if (!await retainQueueFeedback(runtime,source.queue,value,reason)) throw new Error('Feedback recovery could not be restored');
      await runtime.storage.delete(entry.key); stored++;
    }
    after = listed.cursor; if (!after) break;
  }
  return stored;
}
export async function completeLegacyFeedback(runtime: Runtime, body: import('../adapters/feedback-queue.js').LegacyFeedbackRecovery): Promise<void> {
  const id = `legacy:${await digest(`${body.source.queue}\n${JSON.stringify(body)}`)}`;
  await runtime.db.execute(sql`DELETE FROM operation_feedback_failures WHERE id=${id} AND reason='FEEDBACK_LEGACY_RECOVERY'`);
}
export async function readFeedbackQuarantine(runtime: Runtime, ids?: string[], after?: string) {
  const rows = (await runtime.db.execute<{ id: string; reason: string; payload: string; topic_arn: string | null; created_at: string; payload_chunk_count: number; actual_chunks: number }>(sql`
    SELECT f.id,f.reason,CASE WHEN f.payload_chunk_count=0 THEN f.payload ELSE c.payload END AS payload,
      f.topic_arn,f.created_at::text,f.payload_chunk_count,coalesce(c.n,0)::int AS actual_chunks
    FROM operation_feedback_failures f LEFT JOIN LATERAL
      (SELECT string_agg(payload,'' ORDER BY ordinal) AS payload,count(*) AS n FROM operation_feedback_failure_chunks WHERE failure_id=f.id) c ON true
    WHERE f.reason IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY') ${ids ? sql`AND f.id = ANY(${sql.param(ids)}::text[])` : sql``}
      ${after ? sql`AND (f.created_at,f.id) > (SELECT created_at,id FROM operation_feedback_failures WHERE id=${after})` : sql``}
    ORDER BY f.created_at,f.id LIMIT 500`)).rows;
  for (const row of rows) if (row.payload_chunk_count !== row.actual_chunks) throw new Error(`Incomplete feedback recovery ${row.id}`);
  return rows;
}
/** Replays only authenticated quarantine rows. An operator's selection is not provider provenance. */
export async function replayQuarantinedFeedback(runtime: Runtime, ids: string[]): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (!ids.length) return [];
  const { authenticatedFeedbackItem } = await import('../adapters/feedback-queue.js');
  const { authenticFeedbackArchive, feedbackArchiveBody } = await import('../adapters/feedback-archive.js');
  const rows = await readFeedbackQuarantine(runtime, ids);
  const items: { id: string; item?: FeedbackItem; error?: string }[] = rows.map(row => {
    try {
      const stored = JSON.parse(row.payload), raw = authenticFeedbackArchive(runtime.config,stored) ? feedbackArchiveBody(stored) : stored;
      const authenticated = authenticatedFeedbackItem(runtime.config, raw);
      const value = authenticated ?? raw as Partial<FeedbackItem> | null;
      if (!value || typeof value !== 'object' || typeof value.region !== 'string' || typeof value.topicArn !== 'string' || typeof value.messageId !== 'string' || !value.message || typeof value.message !== 'object') return { id: row.id, error: 'FEEDBACK_INVALID' };
      if (!authenticated) return { id: row.id, error: 'FEEDBACK_UNAUTHENTICATED' };
      return { id: row.id, item: authenticated };
    } catch { return { id: row.id, error: 'FEEDBACK_INVALID' }; }
  });
  const outcomes = await ingestFeedbackBatch(runtime, items.flatMap(entry => entry.item ? [entry.item] : []));
  const results = items.map(entry => entry.item ? { id: entry.id, ...outcomes.shift()! } : { id: entry.id, ok: false, error: entry.error });
  const done = results.filter(r => r.ok).map(r => r.id);
  if (done.length) await runtime.db.execute(sql`DELETE FROM operation_feedback_failures WHERE reason IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY') AND id = ANY(${sql.param(done)}::text[])`);
  return results;
}

const processSesReceipt: JobHandler = async (runtime, payload, job) => {
  const receiptWhere = and(scoped(snsReceipts, job), eq(snsReceipts.topicArn, String(payload.topicArn)), eq(snsReceipts.messageId, String(payload.messageId)));
  const data = payload.message as Record<string, any>;
  const { recordEmailEvent } = await loadSendingOps();
  const { kind, providerId } = sesFeedbackIdentity(data);
  const tagged = taggedEmailId(data);
  const [input] = await runtime.db.select({ receipt: snsReceipts, hostedFeedback: runtime.config.multiTenant && (kind==='Bounce' || kind==='Complaint')
    ? sql<boolean>`EXISTS (SELECT 1 FROM provider_feedback_history WHERE topic_arn=${String(payload.topicArn)} AND kind='shared')` : sql<boolean>`false`, email: {
    id: emails.id, region: emails.region, to: emails.to, cc: emails.cc, bcc: emails.bcc, simulated: emails.simulated,
  } }).from(snsReceipts).leftJoin(emails, and(scoped(emails, job), eq(emails.region, String(payload.region)),runtime.config.multiTenant && !simulatedTopic(payload.topicArn) ? sql`"sending_emails".feedback_topic_arn=${String(payload.topicArn)}` : undefined, tagged
    // Fallback for a lost provider response: see ingestRoutineSesEvents.
    ? and(eq(emails.id, tagged), or(eq(emails.providerId, providerId), and(isNull(emails.providerId), eq(emails.status, 'acceptance_unknown'))))
    : eq(emails.providerId, providerId))).where(receiptWhere);
  if (!input || input.receipt.processedAt) return;
  const { receipt, email } = input;
  if (!email) throw new ApiError(409, 'SES_EMAIL_NOT_FOUND', 'The SES message is not yet associated with a local email.', undefined, true);
  if (email.simulated !== simulatedTopic(payload.topicArn, String(payload.region))) throw new ApiError(403, 'SES_ENVIRONMENT_MISMATCH', 'Feedback and email simulation modes must match.');
  if (kind === 'Subscription') {
    const preferences = data.subscription?.newTopicPreferences;
    // SES topic defaults are not evidence of app-wide opt-in; never reverse local opt-outs from them.
    if (preferences?.unsubscribeAll === true && email.to.length === 1 && !email.cc.length && !email.bcc.length) {
      await (await wrapModuleLoad(() => import('../audience/consent.js'))).recordUnsubscribe(runtime, job.workspaceId, email.to[0]!, 'ses-subscription');
    } else {
      await publishEvent(runtime, { id: `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`, type: 'contact.subscription_changed', createdAt: receipt.createdAt, workspaceId: job.workspaceId, region: email.region, data: { emailId: email.id, source: 'ses', preferences: preferences ?? null, appliedToWorkspaceConsent: false } });
    }
    await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere); return;
  }
  const mapped = sesEvents[kind]!;
  const eventDetail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const eventTime = typeof eventDetail.timestamp === 'string' && Number.isFinite(Date.parse(eventDetail.timestamp)) ? new Date(eventDetail.timestamp).toISOString() : receipt.createdAt;
  const eventId = `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`;
  const normalized: PublishedEvent = { id: eventId, workspaceId: job.workspaceId, region: email.region, type: mapped.type, createdAt: eventTime, data: { emailId: email.id, providerId, ...(kind === 'Open' || kind === 'Click' ? { isBotEvent: eventDetail.isBotEvent ?? 'Unknown' } : {}), ...((kind === 'Bounce') ? { bounceType: eventDetail.bounceType ?? 'Unknown', bounceSubType: eventDetail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof eventDetail.link === 'string' ? { link: eventDetail.link } : {}), ...feedbackReason(kind, eventDetail) } };
  // Routine send/delivery events have no later consent or engagement writes.
  // Mark their receipt in the same commit as status, event and webhook fan-out.
  const routine = kind === 'Send' || kind === 'Delivery';
  // SES Auto Validation drops risky recipients before sending and reports each as a Permanent bounce with this subtype.
  // It never left SES, so record it as suppressed (not bounced); the contact is still suppressed below.
  const classification = feedbackClass(kind,eventDetail)!, validationSuppressed = classification === 'validation_suppressed';
  if (kind === 'Complaint' && eventDetail.complaintFeedbackType != null) normalized.data.complaintFeedbackType=eventDetail.complaintFeedbackType;
  if (validationSuppressed) normalized.data.suppressionReason='email_validation';
  const candidates: unknown[] = kind === 'Bounce' ? (data.bounce?.bouncedRecipients ?? []).map((r: any) => r.emailAddress) : kind === 'Complaint' ? (data.complaint?.complainedRecipients ?? []).map((r: any) => r.emailAddress) : (email.to.length === 1 && !email.cc.length && !email.bcc.length ? email.to : []);
  const envelope = new Set([...email.to,...email.cc,...email.bcc].map(v => v.toLowerCase()));
  const recipients = [...new Set(candidates.filter((v): v is string => typeof v === 'string').map(v => v.toLowerCase()).filter(v => envelope.has(v)))];
  // One SNS notification can identify up to 50 recipients. Scope hashes to this message so they
  // deduplicate overlapping reports without linking recipients across mail. [] means no real matched recipient;
  // absent recipient evidence counts as one, just like legacy feedback rows.
  const recipientHashes = input.hostedFeedback && !email.simulated && (classification === 'bounce' || classification === 'complaint') && candidates.length
    ? await Promise.all(recipients.filter(realDestination).map(v => digest(`${email.id}\0${v}`))) : undefined;
  await recordEmailEvent(runtime, { workspaceId: job.workspaceId, emailId: email.id, providerId, type: classification,
    ...(validationSuppressed ? { errorCode: 'EMAIL_VALIDATION_SUPPRESSED' } : {}), externalId: `${payload.topicArn}:${payload.messageId}`, data: normalized.data, createdAt: eventTime, recipientHashes,
    ...(routine ? { receipt: { topicArn: String(payload.topicArn), messageId: String(payload.messageId) } } : {}),
  });
  if (routine) return;
  const suppress = classification === 'complaint' || classification === 'bounce' || validationSuppressed;
  const observeEngagement = (kind === 'Open' || kind === 'Click') && normalized.data.isBotEvent !== true && normalized.data.isBotEvent !== 'Likely';
  if (recipients.length && (suppress || observeEngagement)) await runtime.db.transaction(async tx => {
    // Several contacts are locked in email order, as the database sorts it, wherever several are (imports, the feedback
    // batch, lockContacts in audience/consent.ts): a bounce for two people and someone adding both to a list wait for each
    // other instead of deadlocking. SES lists the recipients in its own order.
    const ordered = recipients.length > 1 ? (await tx.execute<{ address: string }>(sql`SELECT address FROM unnest(${sql.param(recipients)}::text[]) address ORDER BY address`)).rows.map(row => row.address) : recipients;
    for (const address of ordered) {
      const contactWhere = and(scoped(contacts, job), eq(contacts.email, address));
      if (suppress) {
        const suppressionReason = kind === 'Complaint' ? 'complaint' : validationSuppressed ? 'email_validation' : 'hard_bounce';
        await tx.execute(sql`INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,suppressed_at)
          VALUES (${id('con')},${job.workspaceId},${address},true,${suppressionReason},${eventTime}) ON CONFLICT ON CONSTRAINT audience_contacts_email_scope
          DO UPDATE SET ${mergeSuppression},updated_at=now()`);
      } else if (observeEngagement) {
        const column = kind === 'Open' ? contacts.lastOpenAt : contacts.lastClickAt;
        const observed = kind === 'Open' ? contacts.openObservedSince : contacts.clickObservedSince;
        await tx.update(contacts).set({ [kind === 'Open' ? 'lastOpenAt' : 'lastClickAt']: sql`greatest(${column}, ${eventTime}::timestamptz)`, [kind === 'Open' ? 'openObservedSince' : 'clickObservedSince']: sql`least(coalesce(${observed}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, observedSince: sql`least(coalesce(${contacts.observedSince}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, updatedAt: now() }).where(contactWhere);
      }
    }
  });
  await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere);
};
export const sesJob: JobHandler = async (runtime, payload, job) => {
  if (simulatedTopic(payload.topicArn)) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'Synthetic callbacks are not SNS events.');
  verifySesAccount(runtime, payload.message, String(payload.topicArn));
  await processSesReceipt(runtime, payload, job);
};
function assertSimulatedFeedback(runtime: Runtime, payload: Record<string, unknown>) {
  const message = payload.message as { mail?: { messageId?: unknown } } | undefined;
  if (!isSimulatedSes(runtime) ||
    !simulatedTopic(payload.topicArn, String(payload.region)) ||
    typeof message?.mail?.messageId !== 'string' || !message.mail.messageId.startsWith('sim_')) {
    throw new ApiError(403, 'SIMULATED_FEEDBACK_FORBIDDEN', 'Synthetic feedback requires a simulated deployment and a synthetic provider identity.');
  }
}
export const simulatedFeedbackJob: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  const { ingestRoutineSesEvent } = await loadSendingOps();
  const input = routineInput({ topicArn: String(payload.topicArn), messageId: String(payload.messageId), region: String(payload.region), message: payload.message as Record<string, unknown> });
  await ingestRoutineSesEvent(runtime, { ...input, workspaceId: job.workspaceId });
};
export const simulatedFeedbackRecovery: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  await processSesReceipt(runtime, payload, job);
};
export const publishJob: JobHandler = async (runtime, payload, job) => {
  const parsed = eventSchema.safeParse(payload.event);
  if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'The queued event is invalid or has mismatched scope.');
  await publishEvent(runtime, parsed.data);
};
export const publishBatchJob: JobHandler = async (runtime, payload, job) => {
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) throw new ApiError(422, 'INVALID_EVENT_BATCH', 'Event batches must contain between one and 100 events.');
  const batch: PublishedEvent[] = [];
  for (const value of payload.events) {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'A queued batch event is invalid or has mismatched scope.');
    batch.push(parsed.data);
  }
  const unique = batch.filter((event, index) => batch.findIndex(candidate => candidate.id === event.id) === index);
  await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(unique).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return;
    const accepted = new Set(inserted.map(row => row.id));
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, unique[0]!), eq(webhooks.paused, false)));
    const queued = unique.filter(event => accepted.has(event.id)).flatMap(event => endpoints.filter(endpoint =>
      endpoint.eventTypes.includes(event.type) && (!endpoint.regions || event.region === null || endpoint.regions.includes(event.region))
    ).map(endpoint => ({ event, endpoint, deliveryId: rowId('whd') })));
    if (!queued.length) return;
    for (let offset = 0; offset < queued.length; offset += 1000) {
      const group = queued.slice(offset, offset + 1000);
      await tx.insert(deliveries).values(group.map(({ event, endpoint, deliveryId }) => ({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event })));
      await tx.insert(jobs).values(group.map(({ event, deliveryId }) => ({ id: rowId('job'), type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } })));
    }
  });
};
