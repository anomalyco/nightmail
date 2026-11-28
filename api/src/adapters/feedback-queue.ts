import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FeedbackItem, Runtime } from '../core.js';
import type { FeedbackSource } from './feedback-archive.js';

// The feedback queue is an account-level resource: any Worker in the same Cloudflare account can
// bind it as a producer. Items are therefore tagged with a MAC under the installation secret when
// they leave the request path, and the tagged lane's consumer only ingests items that carry a valid tag.
// Cache derived 32-byte HKDF keys per isolate (at most 16 entries across secret rotation) so a 100-item batch runs
// HKDF once per isolate instead of 100-300 times per batch.
const macKeyCache = new Map<string, Buffer>();
const macKey = (secret: string, purpose = 'bane:feedback-queue:v1'): Buffer => {
  const key = `${purpose}:${secret}`;
  const cached = macKeyCache.get(key);
  if (cached) return cached;
  const derived = Buffer.from(hkdfSync('sha256', secret, '', purpose, 32));
  if (macKeyCache.size >= 16) macKeyCache.delete(macKeyCache.keys().next().value!);
  macKeyCache.set(key, derived);
  return derived;
};
const canonical = (item: Omit<FeedbackItem, 'mac'>) => JSON.stringify([item.region, item.topicArn, item.messageId, item.topicKind ?? null, item.message]);
export function feedbackMac(secret: string, item: Omit<FeedbackItem, 'mac'>): string {
  return createHmac('sha256', macKey(secret)).update(canonical(item)).digest('base64url');
}
export type FeedbackSecrets = { authSecret: string; previousAuthSecret?: string };
/**
 * Whether a queued item was tagged by this installation (the current or, during rotation, the previous
 * secret). Total over any queue body: a foreign producer controls every byte, so nothing here throws.
 */
export function authenticFeedback(secrets: FeedbackSecrets, item: unknown): item is FeedbackItem & { mac: string } {
  if (typeof item !== 'object' || item === null) return false;
  const { mac, ...body } = item as FeedbackItem;
  if (typeof mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return false;
  let given: Buffer; try { given = Buffer.from(mac, 'ascii'); } catch { return false; }
  for (const secret of [secrets.authSecret, secrets.previousAuthSecret]) {
    if (!secret) continue;
    let expected: Buffer; try { expected = Buffer.from(feedbackMac(secret, body), 'ascii'); } catch { return false; }
    if (expected.length === given.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export type LegacyFeedbackRecovery = { recovery: 'legacy-feedback-v1'; source: { queue: string; id: string; enqueuedAt: string; cutover: string }; body: FeedbackItem; mac: string };
const recoveryMac = (secret: string, source: LegacyFeedbackRecovery['source'], body: FeedbackItem) =>
  createHmac('sha256', macKey(secret, 'bane:feedback-recovery:v1')).update(JSON.stringify([source.queue, source.id, source.enqueuedAt, source.cutover, body])).digest('base64url');
/** Only the consumer may mint this, from platform metadata after the historical gate passed. */
function legacyRecovery(secret: string, source: LegacyFeedbackRecovery['source'], body: FeedbackItem): LegacyFeedbackRecovery {
  if (!source.queue || !source.id) throw new Error('Missing platform feedback provenance');
  return { recovery: 'legacy-feedback-v1', source, body, mac: recoveryMac(secret, source, body) };
}
export function authenticLegacyRecovery(secrets: FeedbackSecrets, value: unknown): value is LegacyFeedbackRecovery {
  try {
    const r = value as LegacyFeedbackRecovery;
    if (r?.recovery !== 'legacy-feedback-v1' || !r.source || typeof r.source.queue !== 'string' || !r.source.queue || typeof r.source.id !== 'string' || !r.source.id ||
      typeof r.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.mac)) return false;
    const cutoff = legacyFeedbackCutover(r.source.cutover), stamp = Date.parse(r.source.enqueuedAt);
    if (!cutoff || !Number.isFinite(stamp) || stamp <= 0 || stamp >= cutoff || !unsignedFeedback(r.body)) return false;
    return [secrets.authSecret, secrets.previousAuthSecret].some(secret => !!secret && timingSafeEqual(Buffer.from(r.mac, 'ascii'), Buffer.from(recoveryMac(secret, r.source, r.body), 'ascii')));
  } catch { return false; }
}
export function authenticatedFeedbackItem(secrets: FeedbackSecrets, body: unknown): FeedbackItem | undefined {
  if (authenticLegacyRecovery(secrets, body)) return body.body;
  if (authenticFeedback(secrets, body)) return body;
}
/** The shape the previous Worker version enqueued: a plain object carrying no tag, refusal or recovery envelope. */
const untaggedShape = (body: unknown): body is object =>
  !!body && typeof body === 'object' && !Array.isArray(body) && !('mac' in body) && !('refused' in body) && !('recovery' in body);
const unsignedFeedback = (body: unknown): body is FeedbackItem => {
  if (!untaggedShape(body)) return false;
  const item = body as Partial<FeedbackItem>;
  return typeof item.region === 'string' && typeof item.topicArn === 'string' && typeof item.messageId === 'string' && !!item.message && typeof item.message === 'object' && !Array.isArray(item.message);
};

// Safety, suppression, consent and standing events route to the dedicated priority lane so bounces, complaints,
// rejections, unsubscribes and tenant-status updates never wait behind routine deliveries, opens and clicks.
const PRIORITY_EVENT_TYPES = new Set(['Bounce', 'Complaint', 'Reject', 'RenderingFailure', 'Subscription']);
export function isPriorityFeedback(item: Pick<FeedbackItem, 'message'>): boolean {
  const msg = item.message as { eventType?: unknown; notificationType?: unknown; source?: unknown } | undefined;
  if (!msg || typeof msg !== 'object') return false;
  if (msg.source === 'aws.ses') return true;
  const kind = typeof msg.eventType === 'string' ? msg.eventType : typeof msg.notificationType === 'string' ? msg.notificationType : '';
  return PRIORITY_EVENT_TYPES.has(kind);
}

/** Measure lane lag from first deliveries only (attempts === 1) so a single retried/poison message whose Cloudflare
 *  enqueue timestamp is minutes old never holds every workspace's auto-pause campaigns. Returns null if the batch
 *  contained only retries. */
export function batchFirstDeliveryLag(messages: readonly { attempts: number; timestamp: Date }[], nowMs = Date.now()): { count: number; oldestMs: number } | null {
  let count = 0, oldestMs = 0;
  for (const m of messages) {
    if (m.attempts !== 1) continue;
    count++;
    const age = Math.max(0, nowMs - m.timestamp.getTime());
    if (age > oldestMs) oldestMs = age;
  }
  return count > 0 ? { count, oldestMs } : null;
}

/** Apply a depth floor to queue-level metrics() oldestMessageTimestamp so a handful of unmatchable/poison messages
 *  sitting in Cloudflare retry backoff never trip an installation-wide hold. */
export function metricsEffectiveLagMs(depth: number, oldestMessageTimestamp: Date | undefined, minDepth: number, nowMs = Date.now()): number {
  if (!oldestMessageTimestamp || depth < minDepth) return 0;
  return Math.max(0, nowMs - oldestMessageTimestamp.getTime());
}

// Verified provider feedback (and simulated callbacks) leave the request path through the feedback queues in batches of
// at most 100 messages. When a priority queue is bound, safety/suppression/consent events go there; otherwise everything
// falls back cleanly to the routine feedback queue.
export function feedbackSink(queue: Queue<FeedbackItem>, secret: string, priorityQueue?: Queue<FeedbackItem>): NonNullable<Runtime['feedback']> {
  const sendChunked = async (target: Queue<FeedbackItem>, batch: { body: FeedbackItem & { mac: string } }[]) => {
    for (let i = 0; i < batch.length; i += 100) await target.sendBatch(batch.slice(i, i + 100));
  };
  return { enqueue: async items => {
    const routine: { body: FeedbackItem & { mac: string } }[] = [];
    const priority: { body: FeedbackItem & { mac: string } }[] = [];
    for (const item of items) {
      const { mac: _, ...body } = item;
      const wrapped = { body: { ...body, mac: feedbackMac(secret, body) } };
      if (priorityQueue && isPriorityFeedback(body)) priority.push(wrapped);
      else routine.push(wrapped);
    }
    if (priority.length && routine.length) await Promise.all([sendChunked(priorityQueue!, priority), sendChunked(queue, routine)]);
    else if (priority.length) await sendChunked(priorityQueue!, priority);
    else if (routine.length) await sendChunked(queue, routine);
  } };
}

// Signal already-committed jobs immediately. Never coalesce a later commit into a wake
// which may already have drained the queue. Delayed retry reservations are separate.
export function workWake(queue: Queue, concurrency: number): NonNullable<Runtime['wake']> {
  return async (readyJobs = 1) => {
    const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / concurrency)));
    if (count === 1) await queue.send({ kind: 'wake' });
    else await queue.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
  };
}

const invalidFeedback = new Set(['SES_INVALID_EVENT', 'SES_UNSUPPORTED_EVENT', 'SES_ACCOUNT_MISMATCH', 'SNS_TOPIC_NOT_ALLOWED', 'SES_TENANT_NOT_OWNED', 'SES_ENVIRONMENT_MISMATCH', 'SIMULATED_FEEDBACK_FORBIDDEN', 'SIMULATED_FEEDBACK_UNSUPPORTED']);
/**
 * The tagged lane (`FEEDBACK_QUEUE`) carries what this installation
 * tagged; anything else on it is archived with platform provenance. Both native DLQs are archive-only
 * consumers, not unconsumed terminal queues. The legacy lane is the
 * queue the previous Worker version wrote to without tags: only messages the platform enqueued before
 * the fixed deployment cutover may drain unsigned. New or undated items are quarantined for review;
 * no body-supplied date establishes provenance. Tagged items are
 * verified like the tagged lane's. One message's verdict never changes another's; a quarantine or
 * archive write that fails holds only that message for a later attempt.
 */
export type FeedbackLane = 'tagged' | 'priority' | 'legacy' | 'tagged-dlq' | 'legacy-dlq';
export type FeedbackVerdict = 'ingest' | 'legacy' | 'untagged' | 'refused';
/** Missing, malformed or future cutovers fail closed. Never derive this from a queued body. */
export function legacyFeedbackCutover(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const cutover = Date.parse(value);
  return Number.isFinite(cutover) && cutover > 0 && cutover <= now ? cutover : undefined;
}
export type FeedbackClass = { verdict: FeedbackVerdict; item?: FeedbackItem; recovery?: boolean };
/** Authenticate a queue body once; `item` is what an 'ingest' verdict hands to ingestion. */
export function classifyFeedback(secrets: FeedbackSecrets, lane: FeedbackLane, body: unknown, provenance?: { timestamp?: Date; cutover?: number }): FeedbackClass {
  if (lane === 'tagged-dlq' || lane === 'legacy-dlq') return { verdict: 'refused' };
  if (authenticLegacyRecovery(secrets, body)) return { verdict: 'ingest', item: body.body, recovery: true };
  if (authenticFeedback(secrets, body)) return { verdict: 'ingest', item: body };
  if (lane !== 'legacy' || !untaggedShape(body)) return { verdict: 'refused' };
  const timestamp = provenance?.timestamp?.getTime(), cutover = provenance?.cutover;
  return timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0 && cutover !== undefined && Number.isFinite(cutover) && cutover <= Date.now() && timestamp < cutover &&
    unsignedFeedback(body) ? { verdict: 'legacy' } : { verdict: 'untagged' };
}
// A missing owner on a customer-controlled topic or beyond detail retention is routine; a recent pool event might
// race the acceptance write, so only those two retire unmatched after one short retry (never paging through quarantine).
const routineUnmatched = (item: FeedbackItem) => {
  const stamp = (item.message.mail as { timestamp?: string } | undefined)?.timestamp;
  return item.topicKind === 'byo' || (!!stamp && Date.parse(stamp) < Date.now() - 30 * 86400000);
};
type FeedbackMessage = Pick<Message, 'id' | 'attempts' | 'retry' | 'ack'> & { body: unknown; timestamp?: Date };
export async function settleFeedbackBatch(options: {
  secrets: FeedbackSecrets; lane: FeedbackLane; sourceQueue: string; messages: readonly FeedbackMessage[]; legacyCutover?: number;
  ingest: (items: FeedbackItem[]) => Promise<{ ok: boolean; error?: string }[]>;
  /** Durably retain the complete signed envelope before enqueue/ack. A failed enqueue may stay archived. */
  promoteLegacy: (item: LegacyFeedbackRecovery) => Promise<void>;
  completeLegacy: (item: LegacyFeedbackRecovery) => Promise<void>;
  /** Store the full body and platform provenance in quarantine (or its durable, drained spill buffer). */
  archive: (source: FeedbackSource, body: unknown, error: string) => Promise<void>;
}) {
  const { secrets, lane, messages, ingest, archive } = options;
  const sourceOf = (message: FeedbackMessage): FeedbackSource => ({ queue: options.sourceQueue, id: message.id, enqueuedAt: message.timestamp!.toISOString(), attempts: message.attempts });
  // Classify and authenticate each message ONCE per batch (avoids re-running HMAC 2-3x per item).
  const classified = messages.map(message => classifyFeedback(secrets, lane, message.body, { timestamp: message.timestamp, cutover: options.legacyCutover }));
  const verdicts = classified.map(c => c.verdict);
  let retiredUnmatched = 0, quarantined = 0, held = 0, promoted = 0;
  // Preserve provenance before any unrelated ingestion can throw and retry the entire batch.
  for (const [index, message] of messages.entries()) if (verdicts[index] === 'legacy') {
    let recovery: LegacyFeedbackRecovery | undefined;
    try {
      recovery = legacyRecovery(secrets.authSecret, { queue: options.sourceQueue, id: message.id, enqueuedAt: message.timestamp!.toISOString(), cutover: new Date(options.legacyCutover!).toISOString() }, message.body as FeedbackItem);
      await options.promoteLegacy(recovery);
      promoted++; message.ack();
    } catch {
      try { await archive(sourceOf(message), recovery ?? message.body, 'FEEDBACK_LEGACY_PROMOTION_FAILED'); quarantined++; message.ack(); }
      catch { message.retry({ delaySeconds: 60 }); held++; }
    }
  }
  const items = classified.filter(c => c.verdict === 'ingest').map(c => c.item!);
  let ingested: { ok: boolean; error?: string }[];
  try { ingested = items.length ? await ingest(items) : []; }
  catch { ingested = items.map(() => ({ ok: false, error: 'FEEDBACK_PERSIST_FAILED' })); }
  const outcomes = verdicts.map(verdict => verdict === 'ingest' ? ingested.shift()! : verdict === 'legacy' ? { ok: true } : { ok: false, error: verdict === 'untagged' ? 'FEEDBACK_UNTAGGED' : 'FEEDBACK_UNAUTHENTICATED' });
  for (const [index, message] of messages.entries()) {
    const { verdict, item, recovery } = classified[index]!;
    if (verdict === 'legacy') continue;
    if (verdict === 'ingest') {
      if (outcomes[index]?.ok && recovery) {
        try { await options.completeLegacy(message.body as LegacyFeedbackRecovery); } catch { message.retry({ delaySeconds: 60 }); held++; continue; }
      }
      if (outcomes[index]?.ok) { message.ack(); continue; }
      const error = outcomes[index]?.error ?? 'FEEDBACK_PERSIST_FAILED';
      if (error === 'SES_FEEDBACK_UNMATCHED' && message.attempts > 1 && routineUnmatched(item!)) { message.ack(); retiredUnmatched++; continue; }
      if (message.attempts < 5 && error !== 'SES_FEEDBACK_QUARANTINED' && !invalidFeedback.has(error)) {
        message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) }); continue;
      }
      try { await archive(sourceOf(message),message.body,error); quarantined++; message.ack(); }
      catch { message.retry({ delaySeconds: 60 }); held++; }
      continue;
    }
    try {
      await archive(sourceOf(message), message.body, lane.endsWith('-dlq') ? 'FEEDBACK_DEAD_LETTER' : verdict === 'untagged' ? 'FEEDBACK_UNTAGGED' : 'FEEDBACK_UNAUTHENTICATED');
      quarantined++;
      message.ack();
    } catch { message.retry({ delaySeconds: 60 }); held++; }
  }
  const untagged = verdicts.filter(v => v === 'untagged').length, unauthenticated = verdicts.filter(v => v === 'refused').length;
  return { outcomes, untagged, unauthenticated, quarantined, held, promoted, retiredUnmatched, failed: outcomes.filter(outcome => !outcome.ok).length - retiredUnmatched - untagged - unauthenticated };
}
