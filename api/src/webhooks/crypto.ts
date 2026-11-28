import { approvalTie } from '../approval-ties.js';
import { z } from '@hono/zod-openapi';
import { eq, sql, isNull, lt, desc, and } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { isIP } from 'node:net';
import { actor, lasting, WEBHOOK_CHANGE, webhookUrlHint } from '../core/access.js';
import { unrestrictedRequired, restrictedArea, requiredOf, wrapModuleLoad, ApiError } from '../core/errors.js';
import { digest, rowId } from '../core/http.js';
import { log } from '../log.js';
import { type Actor, type Ctx, type Permission, type DbExecutor, type Runtime, type Config, type Database, withoutVerdict } from '../core/types.js';
import { JobDeferred, enqueue } from '../jobs.js';
import { retryAfterMs } from '../ritual-retry.js';
import { webhookSecretBinding as mailboxSecretBinding } from '../mailbox-events.js';
import { endpoints } from '../db/mailbox.js';
import { webhooks, type PublishedEvent, eventTypes, events, deliveries } from '../db/operations.js';
import { productName } from '../brand.js';

export const now = () => new Date().toISOString();
export const scoped = (table: { workspaceId: AnyPgColumn }, a: Pick<Actor, 'workspaceId'>) => eq(table.workspaceId, a.workspaceId);
const reservedHeader = /^(?:host|content-length|content-type|content-encoding|transfer-encoding|connection|keep-alive|te|trailer|upgrade|http2-settings|expect|cookie|user-agent|webhook-id|webhook-timestamp|webhook-signature|nightmail-test|bane-test|opensend-test)$|^proxy-/i;
export const WebhookHeaders = z.array(z.object({
  name: z.string().min(1).max(64).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(name => !reservedHeader.test(name), 'Reserved webhook header.'),
  value: z.string().max(2048).regex(/^[\t\x20-\x7e\x80-\xff]*$/, 'Use single-line HTTP field bytes.'),
}).strict()).max(10).superRefine((headers, ctx) => {
  const names = new Set(headers.map(h => h.name.toLowerCase()));
  if (names.size !== headers.length) ctx.addIssue({ code: 'custom', message: 'Header names must be unique regardless of case.' });
  if (headers.reduce((size, h) => size + h.name.length + Buffer.byteLength(h.value), 0) > 8192) ctx.addIssue({ code: 'custom', message: 'Header names and values exceed 8 KiB.' });
}).describe(`Write-only custom HTTP request headers, e.g. Authorization. Up to 10 unique names (case-insensitive) and 8192 UTF-8 bytes of names and values. Omit on update to keep, supply the complete list to replace, or [] to clear. Transport, Cookie and ${productName} delivery headers are reserved.`);
export const WebhookHeaderViews = z.array(z.object({ name: z.string(), hint: z.string().optional(), updatedAt: z.string().datetime().optional() })).describe('Configured names only for readers. Managers also see a masked hint and the time the header list was last replaced.');
export function workspaceActor(c: Ctx, permission: Permission = 'read') { const a = actor(c, permission); if (a.domains.length) throw unrestrictedRequired(a, restrictedArea(c.req.path), requiredOf(c, permission)); return a; }
// Like API keys, webhooks are set up, changed and removed by lasting credentials: a temporary agent token reads them and
// their deliveries, and can test or retry a delivery, but does not create, change or delete them or read their signing
// secrets.
export function webhookManager(c: Ctx) {
  const a = workspaceActor(c, 'manage');
  lasting(c, WEBHOOK_CHANGE);
  return a;
}
// A webhook that an approval sets up, changes or rotates the signing secret of is tied to the approval, like the keys it
// creates: it is posted to only while the approval is active (webhookJob) and is held when the approval is removed
// (migration 198). The approval is read again here, inside the write's transaction, and held (shared lock) until the
// write commits: a removal under way finishes first and the write is refused; one that starts later waits for the
// write and then holds the webhook. It is taken before the webhook row, the order a removal takes the two in.
export async function ownWebhook(c: Ctx, tx: DbExecutor, a: Actor, webhookId: string) {
  if (!a.grantId) return;
  const { getMcpGrantActor, approvalUse } = await wrapModuleLoad(() => import('../mcp-auth.js'));
  const grant = await getMcpGrantActor(c.env, 'mcp_' + a.grantId, a.workspaceId, tx, approvalUse(a));
  if (grant?.workspaceId !== a.workspaceId || !grant.permissions.includes('manage')) throw new ApiError(401, 'AUTH_INVALID', 'The MCP approval behind this request was revoked while it ran. Nothing was changed.');
  await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${a.grantId},${a.workspaceId},'webhook',${webhookId}) ON CONFLICT DO NOTHING`);
}
export async function metadata(runtime: Runtime, row: typeof webhooks.$inferSelect, a: Actor) {
  const { encryptedSecret: _, encryptedHeaders, workspaceId: _w, reconfirm: _r, ...value } = row;
  return { ...value, url: webhookUrlHint(value.url), headers: await webhookHeaderViews(runtime, encryptedHeaders, secretBinding(row, row.id), a.permissions.includes('manage')),
    approval: await approvalTie(runtime, row.workspaceId, ['webhook'], row.id) };
}

// The single endpoint rule for sending and inbound webhooks: public HTTPS DNS names only, never
// credentials, IP literals, internal TLDs or this installation itself.
export function webhookUrl(runtime: Pick<Runtime, 'config'>, value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'A public HTTPS webhook URL is required.', 'url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal|invalid|test|home|lan|arpa)$/.test(host) || host.endsWith('.')) throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'Webhook endpoints must use public HTTPS DNS names without credentials or fragments.', 'url');
  const own = [runtime.config.publicUrl, ...(runtime.config.previousOrigins ?? []), runtime.config.sesFeedbackUrl].flatMap(value => value ? [new URL(value).hostname.toLowerCase().replace(/\.$/, '')] : []);
  if (own.includes(host)) throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'Webhook endpoints cannot point back at this installation.', 'url');
  return url.toString();
}
const hookTimeouts=new Map<string,{count:number;until:number}>();
/** Answers that say the endpoint is overloaded or down, which open its breaker like timeouts do. */
const OVERLOADED = new Set([429, 502, 503, 504]);
/** The one outbound transport for sending and inbound webhooks: no redirects, five-second budget, response bodies discarded.
 *  Three timeouts or overloaded answers in a row hold every delivery to the endpoint for 30 s, or its Retry-After (up to 15 min). */
export async function postWebhook(runtime: Runtime, url: string, headers: Record<string, string>, body: string, encryptedHeaders: string | null, binding: string, timeoutSeconds=5) {
  const key=await digest(binding+'\n'+url),prior=hookTimeouts.get(key);
  // Nothing leaves while the breaker is open: return only this claim's attempt. Resetting the count let every delivery to an
  // endpoint that always times out retry forever (three real tries per window, the rest deferred back to attempt 0).
  if(prior && prior.count>=3 && prior.until>Date.now())throw new JobDeferred(new Date(prior.until).toISOString(),undefined,true);
  const custom = await readWebhookHeaders(runtime, encryptedHeaders, binding);
  const merged = new Headers();
  for (const { name, value } of custom.headers) if (!reservedHeader.test(name)) merged.set(name, value);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set('Content-Type', 'application/json');
  const init = { method: 'POST' as const, headers: Object.fromEntries(merged), body, signal: AbortSignal.timeout(timeoutSeconds*1000) };
  const trip=(holdMs:number)=>{
    const last=hookTimeouts.get(key), count=1+(last && last.until>Date.now()?last.count:0);
    if(!last && hookTimeouts.size>=1024)hookTimeouts.delete(hookTimeouts.keys().next().value!);
    // A later timeout or 503 never shortens a window an endpoint's Retry-After already asked for.
    hookTimeouts.set(key,{count,until:Math.max(last?.until??0,Date.now()+Math.max(30000+timeoutSeconds*1000,Math.min(holdMs,15*60000)))});
  };
  try {
    const result=runtime.webhookFetch?await runtime.webhookFetch(url,init):await fetch(url,{...init,redirect:'manual'});
    if(result instanceof Response) await result.body?.cancel();
    const retryAfter=result instanceof Response?result.headers.get('retry-after'):result.retryAfter;
    if(OVERLOADED.has(result.status))trip(retryAfterMs(retryAfter));else hookTimeouts.delete(key);
    return {status:result.status,retryAfter};
  }catch(error){
    if(init.signal.aborted || error instanceof Error && error.name==='TimeoutError')trip(0);
    throw error;
  }
}
async function encryptionKey(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'A 32-byte hexadecimal encryption key is required.');
  const bytes = unhex(value);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 16), key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], h => parseInt(h, 16));
export async function encrypt(runtime: Pick<Runtime, 'config'>, secret: string, binding: string) {
  const current = await encryptionKey(runtime.config.encryptionKey), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, current.key, new TextEncoder().encode(secret));
  return `v1.${current.id}.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
export async function decrypt(runtime: {config: Pick<Config, 'encryptionKey' | 'previousEncryptionKey'>}, ciphertext: string, binding: string) {
  const parts = ciphertext.split('.'), versioned = parts.length === 4 && parts[0] === 'v1';
  const [iv, value] = versioned ? parts.slice(2) : parts;
  const rotationRequired = () => new ApiError(503, 'KEY_ROTATION_REQUIRED', 'The webhook secret cannot be decrypted with configured keys. Restore its encryption key or rotate the webhook secret.');
  if ((!versioned && parts.length !== 2) || !/^[a-f0-9]{24}$/i.test(iv ?? '') || !/^(?:[a-f0-9]{2}){16,}$/i.test(value ?? '')) throw rotationRequired();
  const keys = [await encryptionKey(runtime.config.encryptionKey)];
  if (runtime.config.previousEncryptionKey) keys.push(await encryptionKey(runtime.config.previousEncryptionKey));
  for (const candidate of keys) {
    if (versioned && candidate.id !== parts[1]) continue;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv!), additionalData: new TextEncoder().encode(binding) }, candidate.key, unhex(value!))); } catch { /* Legacy envelopes may belong to the previous key. */ }
  }
  throw rotationRequired();
}
export function webhookSecret() { return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`; }
type HeaderList = z.infer<typeof WebhookHeaders>;
export async function encryptWebhookHeaders(runtime: Runtime, headers: HeaderList | undefined, binding: string) {
  if (headers === undefined) return undefined; // PATCH omission leaves the column untouched.
  return headers.length ? encrypt(runtime, JSON.stringify({ headers, updatedAt: now() }), `${binding}:headers`) : null;
}
async function readWebhookHeaders(runtime: Runtime, ciphertext: string | null, binding: string): Promise<{ headers: HeaderList; updatedAt: string }> {
  return ciphertext === null ? { headers: [], updatedAt: '' } : JSON.parse(await decrypt(runtime, ciphertext, `${binding}:headers`));
}
export async function webhookHeaderViews(runtime: Runtime, ciphertext: string | null, binding: string, manage: boolean) {
  const { headers, updatedAt } = await readWebhookHeaders(runtime, ciphertext, binding);
  return headers.map(({ name, value }) => manage ? { name, hint: '••••' + (value.length > 8 ? value.slice(-4) : ''), updatedAt } : { name });
}
export async function hmac(secret: string, value: string) { const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64'); if (!secret.startsWith('whsec_') || bytes.length !== 32) throw new ApiError(503, 'WEBHOOK_SECRET_ROTATION_REQUIRED', 'Rotate this endpoint secret to enable Standard Webhooks signatures.'); const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))).toString('base64'); }
export const secretBinding = (a: Pick<Actor, 'workspaceId'>, webhookId: string) => `${a.workspaceId}:live:${webhookId}`;

// Installer-only, resumable rewrapping; no webhook signing secret is rotated or returned.
// Decryption failure aborts, leaving earlier successful updates safe to skip on rerun.
export async function reencryptWebhookSecrets(db: Database, config: Config): Promise<{ scanned: number; reencrypted: number; skipped: number; conflicted: number }> {
  const runtime = { config }, current = await encryptionKey(config.encryptionKey);
  const counts = { scanned: 0, reencrypted: 0, skipped: 0, conflicted: 0 };
  const currentEnvelope = new RegExp(`^v1\\.${current.id}\\.[a-f0-9]{24}\\.(?:[a-f0-9]{2}){16,}$`, 'i');
  const rewrap = async (ciphertext: string | null, aad: string) => ciphertext !== null && !currentEnvelope.test(ciphertext) ? encrypt(runtime, await decrypt(runtime, ciphertext, aad), aad) : undefined;
  const same = (column: AnyPgColumn, value: string | null) => value === null ? isNull(column) : eq(column, value);
  for (const table of [webhooks, endpoints]) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.select({ id: table.id, workspaceId: table.workspaceId, encryptedSecret: table.encryptedSecret, encryptedHeaders: table.encryptedHeaders, encryptedTarget: table === endpoints ? endpoints.encryptedTarget : sql<null>`NULL` }).from(table).where(cursor ? lt(table.id, cursor) : undefined).orderBy(desc(table.id)).limit(100);
      for (const row of rows) {
        counts.scanned++;
        const binding = table === webhooks ? secretBinding(row, row.id) : mailboxSecretBinding(row.workspaceId, row.id);
        // An endpoint's Slack or Discord URL or forward address (encrypted_target) is rewrapped with its secret and headers.
        const encryptedSecret = await rewrap(row.encryptedSecret, binding), encryptedHeaders = await rewrap(row.encryptedHeaders, `${binding}:headers`), encryptedTarget = await rewrap(row.encryptedTarget, `${row.workspaceId}:endpoint:${row.id}`);
        if (!encryptedSecret && !encryptedHeaders && !encryptedTarget) { counts.skipped++; continue; }
        // Neither a concurrent secret rotation nor a header or URL replacement may be overwritten.
        const updated = table === webhooks
          ? await db.update(webhooks).set({ encryptedSecret, encryptedHeaders, updatedAt: now() }).where(and(eq(webhooks.id, row.id), scoped(webhooks, row), same(webhooks.encryptedSecret, row.encryptedSecret), same(webhooks.encryptedHeaders, row.encryptedHeaders))).returning({ id: webhooks.id })
          : await db.update(endpoints).set({ encryptedSecret, encryptedHeaders, encryptedTarget, updatedAt: now() }).where(and(eq(endpoints.id, row.id), scoped(endpoints, row), same(endpoints.encryptedSecret, row.encryptedSecret), same(endpoints.encryptedHeaders, row.encryptedHeaders), same(endpoints.encryptedTarget, row.encryptedTarget))).returning({ id: endpoints.id });
        if (updated.length) counts.reencrypted++; else counts.conflicted++;
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  return counts;
}

// A webhook payload stored before the published event was built without the content screen's verdict (states.ts
// terminalEvents) may hold it: what a caller reads of the delivery log, and what is posted or posted again, never does.
export const outwardEvent = <T extends { data: Record<string, unknown> }>(event: T): T => ({ ...event, data: withoutVerdict(event.data) });

export async function publishEvent(runtime: Runtime, event: PublishedEvent, wake = true): Promise<void> {
  if (!eventTypes.includes(event.type)) throw new ApiError(422, 'INVALID_EVENT_TYPE', 'Unknown webhook event type.');
  const readyJobs = await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(event).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return 0;
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, event), eq(webhooks.paused, false)));
    let count = 0;
    for (const endpoint of endpoints) {
      if (!endpoint.eventTypes.includes(event.type) || (endpoint.regions && event.region !== null && !endpoint.regions.includes(event.region))) continue;
      const deliveryId = rowId('whd');
      await tx.insert(deliveries).values({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event });
      await enqueue(tx, { type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } });
      count++;
    }
    return count;
  });
  if (wake && readyJobs > 0) try { await runtime.wake?.(readyJobs,'webhook'); } catch { log('warn', { eventId: event.id, code: 'QUEUE_WAKE_FAILED', message: 'The event is committed; the scheduler will recover pending deliveries.' }); }
}
