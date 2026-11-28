import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, digest, mailboxRoute, webhookUrlHint, type Ctx, type Database, type DbExecutor } from './core.js';
import { utf8Bytes } from './read-bounds.js';
import { SEND_LIMITS } from './send-limits.js';

/**
 * Idempotency-Key: one protocol on sending_idempotency for every caller. The create middleware below, idempotent()
 * (campaigns, uploads, mailbox and thread sends, stored-template sends and campaign tests) and the one-statement send
 * admission (send_admission: direct and batch sends, internal notices) all claim a key with the SQL function
 * idempotency_claim (migration 317), and all answer
 * with the one replay rule in replay():
 *
 * - a finished request replays its stored result;
 * - a request still in flight answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After at once (it never waits);
 * - the same key with a different request is 409 IDEMPOTENCY_CONFLICT;
 * - a claim whose request may have committed without recording its result is 409 IDEMPOTENCY_OUTCOME_UNKNOWN.
 *
 * A key is scoped to its workspace, the caller's key and the request path. Callers choose what the hash covers: the
 * body for sends and campaigns, the body and the caller's authority for the middleware's creates. A finished send's
 * key is deleted with its email log after at least 30 days (maintenance.ts SEND_KEYS); every other key is kept.
 */
const keyHeader = (lifetime: string) => z.object({
  'Idempotency-Key': z.string().optional().openapi({
    minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]+$', example: 'order-4821-receipt',
    description: `Optional. Makes retries safe. Repeating a request with the same key and the same body returns the original result without performing the write again. While the first request with a key is still running, a duplicate returns 409 IDEMPOTENCY_IN_PROGRESS with Retry-After: retry with the same key, never a new one. Reusing a key with a different body returns 409 IDEMPOTENCY_CONFLICT. Keys are scoped to the API key and request path. ${lifetime} Without a key, every request is processed, so a retried send can deliver twice.`,
  }),
});
/** Not a send route: retention never deletes these keys (maintenance.ts SEND_PATH lists the routes whose keys expire). */
export const IdempotencyHeaders = keyHeader("This route's keys do not expire: a repeat with the same key replays the original result at any later time.");
/** Sends: a key lives as long as the email log of what it sent (maintenance.ts SEND_KEYS), a scheduled send's 30 days past its latest time. */
export const SendIdempotencyHeaders = keyHeader(`A send's key is kept at least 30 days from the request, as long as the log of the emails it queued; then it is deleted, and the same key is a new request that sends again. A scheduled send's key is kept at least ${30 + SEND_LIMITS.schedule.horizonSeconds / 86_400} days, after which a repeat is refused because its time has passed.`);
// The OpenAPI constraints above are documentation: the handler validates the key itself, so a bad key is
// INVALID_IDEMPOTENCY_KEY rather than a generic validation error.
export const validIdempotencyKey = (key: string) => key.length <= 200 && /^[\x21-\x7e]+$/.test(key);
export function idempotencyKey(key: string | undefined) {
  if (key !== undefined && !validIdempotencyKey(key)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
  return key;
}
/** A request's identity, without the Hono context: internal senders pass their own path and key. */
export type IdempotentRequest = { path: string; key?: string };
export const idempotentRequest = (c: Ctx): IdempotentRequest => ({ path: c.req.path, key: idempotencyKey(c.req.header('Idempotency-Key')) });

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const requestHash = (value: unknown) => digest(canonical(value));

export type IdempotencyScope = { workspaceId: string; actorKeyId: string; path: string; key: string };
/** What idempotency_claim returns for a key this request did not get. */
export type ClaimState = { previous: Record<string, unknown> | null; hash?: string; createdAt?: string; busy?: true };
/**
 * For the `credential` row of an API key's authentication (auth.ts credentialCtes): whether the request may charge
 * the key's request budget. A Hosted send holds that budget row until its admission statement commits, so a
 * duplicate of a request still holding its key is refused before it would wait there, and is not charged.
 */
export const idempotencyGate = (path: string, key: string) => sql`CASE WHEN credential.grant_id IS NOT NULL OR NOT (credential.permissions ?| ARRAY['manage','send']) THEN true
  ELSE idempotency_admits(credential.workspace_id, credential.id, ${path}, ${key}) END`;
/** The claim, an expression: NULL when this request now owns the key, otherwise its ClaimState. */
const claimKey = (s: IdempotencyScope, hash: string) => sql`idempotency_claim(${s.workspaceId}, ${s.actorKeyId}, ${s.path}, ${s.key}, ${hash}, NULL::jsonb)`;
const where = (s: IdempotencyScope) => sql`workspace_id = ${s.workspaceId} AND actor_key_id = ${s.actorKeyId} AND path = ${s.path} AND request_key = ${s.key}`;
async function claim(db: DbExecutor, s: IdempotencyScope, hash: string) {
  return (await db.execute<{ state: ClaimState | null }>(sql`SELECT ${claimKey(s, hash)} AS state`)).rows[0]!.state;
}
export const MAX_IDEMPOTENT_RESULT_BYTES = 256 * 1024;
const oversizedResultError = (id?: string | null) => {
  const err = new ApiError(409, 'IDEMPOTENT_RESPONSE_TOO_LARGE', `This Idempotency-Key already completed${id ? ` (${id})` : ''}, but its response exceeded the replay size limit. Fetch the resource instead of repeating the request.`);
  if (id) err.details = [{ id }];
  return err;
};
const complete = (db: DbExecutor, s: IdempotencyScope, result: unknown) => {
  const serialized = JSON.stringify(result);
  if (utf8Bytes(serialized) > MAX_IDEMPOTENT_RESULT_BYTES) {
    const rec = result && typeof result === 'object' ? result as { status?: unknown; id?: unknown; body?: unknown } : null;
    const bodyId = rec?.body && typeof rec.body === 'object' && typeof (rec.body as { id?: unknown }).id === 'string' ? (rec.body as { id: string }).id : null;
    const id = typeof rec?.id === 'string' ? rec.id : bodyId;
    const compact = typeof rec?.status === 'number' ? { status: rec.status, oversized: true, id } : { oversized: true, id };
    return db.execute(sql`UPDATE sending_idempotency SET result = ${JSON.stringify(compact)}::jsonb WHERE ${where(s)}`);
  }
  return db.execute(sql`UPDATE sending_idempotency SET result = ${serialized}::jsonb WHERE ${where(s)}`);
};
// Frees a claim that has no result: one whose request was refused or never wrote.
// Requests whose handler failed inside a transaction that rolled back: nothing was committed, so their key is
// released like a refusal's, and a retry runs again (rolledBack). A failure that may follow a commit keeps the unknown outcome.
const rolledBackRequests = new WeakSet<Request>();
export const rolledBack = (c: Ctx) => { rolledBackRequests.add(c.req.raw); };
const release = (db: DbExecutor, s: IdempotencyScope) => db.execute(sql`DELETE FROM sending_idempotency WHERE ${where(s)} AND result IS NULL`);

const inProgress = () => new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Another request with this Idempotency-Key is still running. Retry with the same key after Retry-After; do not repeat the request with a new key.', undefined, true);
/** The replay rule. Returns the stored result of a finished request; throws for every other state. */
export function replay<T>(state: ClaimState, hash: string): T {
  if (state.busy) throw inProgress();
  if (state.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request. Use a new key for a new request.');
  const stored = state.previous;
  if (stored?.unknown === true) throw new ApiError(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'The original request failed after it may have committed. Check whether it took effect before starting another request.');
  if (stored?.oversized === true) throw oversizedResultError(typeof stored.id === 'string' ? stored.id : null);
  if (!stored) {
    if (Date.now() - Date.parse(state.createdAt!) >= 600_000) throw new ApiError(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'No result was recorded within ten minutes. Check whether the request took effect before starting another.');
    throw inProgress();
  }
  return stored as T;
}

/**
 * Runs work in one transaction under the request's key and stores its result with the claim. While the request
 * holds the key a duplicate answers IDEMPOTENCY_IN_PROGRESS; once it commits, the duplicate replays the result.
 * - prepare: I/O that must run outside the transaction (an object upload). Only the request that owns the key runs
 *   it: the claim commits first, pending, and the transaction stores the result with the write. A failure leaves no
 *   result, so it frees the key; a commit whose acknowledgement was lost keeps its result and replays.
 * - replayed: rechecks that the caller may still read a replayed result.
 */
export async function idempotent<T extends Record<string, unknown>>(db: Database, request: IdempotentRequest & { workspaceId: string; actorKeyId: string }, body: unknown, work: (tx: DbExecutor) => Promise<T>,
  options: { prepare?: () => Promise<void>; replayed?: (db: DbExecutor, result: T) => Promise<void> } = {}): Promise<T> {
  const { prepare, replayed } = options;
  if (request.key === undefined) { await prepare?.(); return db.transaction(work); }
  const scope = { workspaceId: request.workspaceId, actorKeyId: request.actorKeyId, path: request.path, key: request.key };
  const hash = await requestHash(body);
  const answer = async (tx: DbExecutor, state: ClaimState) => { const result = replay<T>(state, hash); await replayed?.(tx, result); return result; };
  if (prepare) {
    const state = await claim(db, scope, hash);
    if (state) return answer(db, state);
    try {
      await prepare();
      return await db.transaction(async tx => { const result = await work(tx); await complete(tx, scope, result); return result; });
    } catch (error) { await release(db, scope).catch(() => {}); throw error; }
  }
  return db.transaction(async tx => {
    const state = await claim(tx, scope, hash);
    if (state) return answer(tx, state);
    const result = await work(tx);
    await complete(tx, scope, result);
    return result;
  });
}

/**
 * Every create accepts Idempotency-Key. Sends, uploads, thread starts and replies, campaign drafts and launches and
 * domain creation use idempotent() in their own handlers; this middleware covers the rest. Its claim commits before
 * the handler runs, so a duplicate sees it in flight. A committed reservation prevents a second create if the
 * worker loses the result after the handler commits. A handler that fails after it attempted a database write may
 * have committed (a lost acknowledgement, a failed read after the write), so its key keeps an unknown outcome
 * instead of being released. No pool slot spans the handler.
 *
 * A result that carries a secret (API key, token, webhook secret, inbox key) is never stored. Replaying it returns
 * 409 IDEMPOTENT_SECRET_WITHHELD naming what was created, so the caller can revoke it and create another instead of
 * getting a duplicate.
 */
export const AUTHENTICATED_CREATES = [
  /^\/v1\/(?:contacts|lists|newsletters|segments|topics|contact-imports|templates|template-assets|webhooks|api-keys|agent-tokens|endpoints|inbox-connections)$/,
  /^\/v1\/template-assets\/import$/,
  /^\/v1\/routing\/routes$/,
  /^\/v1\/(?:rules\/recipes|workspaces|audience-query\/plan|feedback)$/,
  // A retried top-up returns the same Checkout link or charge instead of starting a second payment.
  /^\/v1\/billing\/(?:top-ups|top-up-links)$/,
];
export const MAILBOX_CREATES = [
  /^\/v1\/inboxes$/,
  /^\/v1\/inboxes\/[^/]+\/(?:app-passwords|folders)$/,
  /^\/v1\/inbound\/(?:addresses|webhooks)$/,
  /^\/v1\/inbound\/domains\/[^/]+\/subdomains$/,
];
/** Whether POST <path> is covered by the create Idempotency-Key middleware (matching app.ts/mailbox.ts partitioning). */
export const createKeyRoute = (path: string) => (mailboxRoute(path) ? MAILBOX_CREATES : AUTHENTICATED_CREATES).some(p => p.test(path));
// Field names that hold credentials at any depth (createInbox nests its key under credential.secret).
// "key" is not one: addresses and webhooks use it for their routing key.
const SECRET_FIELDS = new Set(['secret', 'token', 'verificationToken', 'password']);

function carriesSecret(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === 'string') return /^(?:Bearer |nm_|bane_|whsec_)/.test(value); // bane_: remove after rename cleanup
  if (Array.isArray(value)) return value.some(item => carriesSecret(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => (SECRET_FIELDS.has(k) && typeof v === 'string' && v.length > 0) || carriesSecret(v, depth + 1));
}

// The handler's view of the database: every call that can write (or runs raw SQL, which may)
// marks the request as possibly committed before it starts.
const WRITES = new Set<PropertyKey>(['insert', 'update', 'delete', 'execute', 'transaction']);
function attemptedWrites(db: Ctx['env']['db'], mark: () => void): Ctx['env']['db'] {
  return new Proxy(db, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    return WRITES.has(prop) ? (...args: unknown[]) => { mark(); return value.apply(target, args); } : value.bind(target);
  } });
}

function idempotentCreates(paths: RegExp[]) {
  return async (c: Ctx, next: () => Promise<void>) => {
    const principal = c.get('actor') ?? c.get('mailboxAccess');
    if (c.req.header('Idempotency-Key') === undefined || c.req.method !== 'POST' || !principal || !paths.some(p => p.test(c.req.path))) return next();
    const key = idempotencyKey(c.req.header('Idempotency-Key'))!;
    const text = await c.req.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* hash the raw body */ }
    // The request's authority is part of its identity: permissions, sender domains or an inbox
    // key's configured scope (not the inboxes a provisioning key has since created, or its own
    // retry would conflict), and receiving consent.
    const inbox = c.get('mailboxAccess'), scope = inbox && (inbox.scopeIds === undefined ? inbox.mailboxIds : inbox.scopeIds);
    const hash = await requestHash([parsed,principal.permissions,c.get('actor')?.domains??scope,'receivingConsent' in principal?principal.receivingConsent??false:false]);
    const identity = { workspaceId: principal.workspaceId, actorKeyId: c.get('actor')?.tokenId??principal.keyId, path: c.req.path, key };
    const db = c.env.db;
    const state = await claim(db, identity, hash);
    if (state) {
      const stored = replay<{ status: number; body?: unknown; withheld?: boolean; oversized?: boolean; id?: string | null }>(state, hash);
      if (stored.withheld) throw new ApiError(409, 'IDEMPOTENT_SECRET_WITHHELD', `This Idempotency-Key already created ${stored.id ?? 'the resource'}. Its secret was shown once and is not stored; revoke it and create another if it was lost.`);
      if (stored.oversized) throw oversizedResultError(stored.id);
      c.header('Idempotent-Replayed', 'true');
      // Receipts created before URL masking contain the full outbound webhook URL.
      if (c.req.path === '/v1/webhooks' && stored.body && typeof stored.body === 'object' && 'url' in stored.body && typeof stored.body.url === 'string') {
        return c.json({ ...stored.body, url: webhookUrlHint(stored.body.url) }, stored.status as 201);
      }
      return c.json(stored.body as object, stored.status as 200);
    }
    // A 4xx is a refusal: release the winning request's reservation so the key can be retried.
    // So is a failure before the handler attempted any write. A 5xx or thrown error after a write
    // attempt may follow a commit, so the key keeps an unknown outcome: a retry never creates
    // twice. Once the handler succeeds, a failure recording its result must not permit another.
    let wrote = false;
    c.env = { ...c.env, db: attemptedWrites(db, () => { wrote = true; }) };
    const settle = (status: number) => status < 500 || !wrote || rolledBackRequests.has(c.req.raw) ? release(db, identity) : complete(db, identity, { status, unknown: true });
    try { await next(); }
    catch (error) { await settle(500); throw error; }
    finally { c.env = { ...c.env, db }; }
    const status = c.res.status;
    if (status < 200 || status >= 300) {
      if (status >= 400) await settle(status);
      return c.res;
    }
    // Inspect the response body once without calling Response.clone() (teeing + cancelling one branch deadlocks
    // under Node's stream implementation when the other branch has not been consumed yet). For responses within
    // MAX_IDEMPOTENT_RESULT_BYTES we buffer and replay the exact bytes; once a response exceeds the limit we stop
    // buffering, extract its leading resource id, and pipe the remaining chunks directly to the caller.
    const captured = await captureBoundedResponse(c.res, MAX_IDEMPOTENT_RESULT_BYTES);
    c.res = captured.response;
    if (captured.oversized) {
      await complete(db, identity, { status, oversized: true, id: captured.id });
      return c.res;
    }
    const body = captured.body;
    const withheld = carriesSecret(body);
    const id = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : null;
    await complete(db, identity, withheld ? { status, withheld: true, id } : { status, body });
    return c.res;
  };
}
async function captureBoundedResponse(res: Response, limit: number): Promise<
  { oversized: true; id: string | null; response: Response } | { oversized: false; body: unknown; response: Response }
> {
  if (!res.body) return { oversized: false, body: null, response: res };
  const reader = res.body.getReader();
  const kept: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        const combined = concatBytes(kept, bytes);
        const text = new TextDecoder().decode(combined);
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        return { oversized: false, body, response: new Response(combined as Uint8Array<ArrayBuffer>, { status: res.status, statusText: res.statusText, headers: res.headers }) };
      }
      kept.push(value);
      bytes += value.byteLength;
      if (bytes > limit) {
        const headText = new TextDecoder().decode(concatBytes(kept, Math.min(bytes, 1024)));
        const m = /"id"\s*:\s*"([^"\\]{1,120})"/.exec(headText);
        let index = 0;
        const passthrough = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index < kept.length) { controller.enqueue(kept[index++]!); return; }
            const next = await reader.read();
            if (next.done) { reader.releaseLock(); controller.close(); return; }
            controller.enqueue(next.value);
          },
          cancel(reason) { return reader.cancel(reason).catch(() => {}); },
        });
        return { oversized: true, id: m ? m[1]! : null, response: new Response(passthrough, { status: res.status, statusText: res.statusText, headers: res.headers }) };
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}
function concatBytes(chunks: Uint8Array[], maxBytes: number): Uint8Array {
  const out = new Uint8Array(maxBytes);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= maxBytes) break;
    const take = Math.min(chunk.byteLength, maxBytes - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}
export const authenticatedCreates = idempotentCreates(AUTHENTICATED_CREATES);
export const mailboxCreates = idempotentCreates(MAILBOX_CREATES);
