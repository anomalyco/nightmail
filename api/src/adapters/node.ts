import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import dns from 'node:dns';
import { request } from 'node:https';
import { isIPv4, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { loadConfig } from '../config.js';
import { ApiError } from '../core/errors.js';
import { log } from '../log.js';
import type { Runtime, WebhookFetch } from '../core/types.js';
import { s3Storage } from './storage.js';
import { InboxWaiters, MAX_WATCH_MS, onlyWhenWoken, readNotice, type InboxWake } from '../inbox-wake.js';

// Node can reach loopback, RFC1918, link-local (cloud metadata), CGNAT, ULA and other non-global
// ranges, so a webhook host is checked at connect time, after DNS, where rebinding cannot help.
const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];
const nonGlobalV4 = (ip: string) => {
  const [a, b] = v4(ip);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
};
export function isGlobalAddress(ip: string): boolean {
  if (isIPv4(ip)) return !nonGlobalV4(ip);
  const lower = ip.toLowerCase().replace(/%.*$/, '');
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isGlobalAddress(mapped[1]!);
  if (lower === '::' || lower === '::1' || lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || first === 0x2002 || first === 0x0100 || lower.startsWith('2001:db8:'));
}
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses.filter(entry => isGlobalAddress(entry.address));
    if (!list.length) return callback(new ApiError(422, 'WEBHOOK_ADDRESS_BLOCKED', 'The webhook host resolves only to private or reserved addresses.'), '');
    if (options.all) callback(null, list); else callback(null, list[0]!.address, list[0]!.family);
  });
};
export const nodeWebhookFetch: WebhookFetch = (url, init) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = request(target, { method: init.method, headers: init.headers, lookup: guardedLookup, signal: init.signal }, response => {
    response.resume(); resolve({ status: response.statusCode ?? 0,retryAfter:response.headers['retry-after'] });
  });
  req.on('error', reject);
  req.end(init.body);
});
// A client whose upload is refused for its size may still be sending the body. Closing the socket with those bytes unread
// makes the kernel reset the connection, and a client that writes again before it reads gets a broken pipe instead of the
// 413 (RFC 9112 section 9.6). Close in stages instead: send the answer and a FIN, read and discard at most 64 KiB more,
// then stop reading, and close once the client hangs up or 2 seconds after the answer.
const REFUSED_BODY_DISCARD_BYTES = 64 * 1024, REFUSED_BODY_LINGER_MS = 2000;
export function closeAfterRefusal(socket: Duplex & { destroySoon(): void; _paused?: boolean }) {
  let closing = false;
  // Node calls this once the answer is written to a socket it won't reuse (Hono's adapter may call it again later).
  socket.destroySoon = () => {
    if (closing || socket.destroyed) return;
    closing = true;
    const timer = setTimeout(() => socket.destroy(), REFUSED_BODY_LINGER_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.once('end', () => socket.destroy());
    let left = REFUSED_BODY_DISCARD_BYTES;
    // The answer is finished. Only the discard listener may consume further input, never Node's HTTP parser.
    socket.removeAllListeners('data');
    socket.on('data', (chunk: Buffer) => {
      if ((left -= chunk.length) > 0) return;
      // The unfinished IncomingMessage can still ask to resume its socket during adapter cleanup.
      socket._paused = true;
      socket.pause();
    });
    socket.end();
  };
}

export function postgresConnection(connectionString: string | undefined) {
  if (!connectionString) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL is required.');
  let url: URL; try { url = new URL(connectionString); } catch { throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must use PostgreSQL.');
  const local = ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname);
  if (!local && url.searchParams.get('sslmode') !== 'verify-full') throw new ApiError(503, 'DATABASE_TLS_REQUIRED', 'Remote PostgreSQL requires sslmode=verify-full. Only local development database hosts may omit TLS.');
  // libpq accepts "system" as a CA-store selector; node-postgres treats it as a filename.
  // Use Node's trusted CA store instead, retaining verify-full certificate/hostname checks.
  if (url.searchParams.get('sslrootcert') === 'system') { url.searchParams.delete('sslrootcert'); connectionString = url.toString(); }
  return { connectionString, connectionTimeoutMillis: 10000 };
}
/** Dedicated, lazy Node connections for a Logs nudge or runner tick. Neither a browser request
 * nor mail orchestration holds its own connection while the background source is read. */
export function nodeLogFacetLane(runtime:Runtime, connectionString:string|undefined) {
  let pool:Pool|undefined, worker:Runtime|undefined, stopping=false, closed:Promise<void>|undefined;
  const inflight=new Map<string,Promise<void>>(), again=new Set<string>();
  const aggregates=new Map<string,Promise<void>>(), repeatAggregate=new Set<string>();
  const get=()=>{
    if(!worker) {
      pool=new Pool({...postgresConnection(connectionString),max:5,idleTimeoutMillis:30000,application_name:'logs-facet-background'});
      pool.on('error',()=>log('warn',{code:'LOG_FACET_POOL_ERROR'}));
      worker={...runtime,db:drizzle(pool),startLogFacetFold:undefined,startLogFacetAggregate:undefined};
    }
    return worker;
  };
  const nudge=(slot:string)=>{
    if(stopping)return;
    if(inflight.has(slot)){again.add(slot);return;}
    const independent=get();
    const work=import('../log-facet-fold.js').then(m=>m.foldLogFacetSlot(independent,slot))
      .catch(()=>log('warn',{code:'LOG_FACET_SLOT_FAILED',jobId:slot})).finally(()=>{
        inflight.delete(slot);
        // A newly admitted run can reuse this PK while the previous promise is settling.
        if(again.delete(slot))nudge(slot);
      });
    inflight.set(slot,work);
  };
  const aggregate=(workspace:string)=>{
    if(stopping)return;
    if(aggregates.has(workspace)){repeatAggregate.add(workspace);return;}
    // The durable demand and runner survive a missed local hint; don't build an unbounded queue
    // of promises or connections when many hosted dashboards navigate at once.
    if(aggregates.size>=2)return;
    const independent=get();
    const work=import('../log-facet-aggregate-worker.js').then(async m=>{await m.runFacetAggregateTurn(independent.db,workspace);})
      .catch(()=>log('warn',{code:'LOG_FACET_AGGREGATE_FAILED',workspaceId:workspace})).finally(()=>{
        aggregates.delete(workspace);if(repeatAggregate.delete(workspace))aggregate(workspace);
      });
    aggregates.set(workspace,work);
  };
  return {get,nudge,aggregate,close:()=>{stopping=true;return closed??=(async()=>{
    await Promise.all([...inflight.values(),...aggregates.values()]);await pool?.end();
  })();}};
}
const INBOX_CHANNEL = 'nightmail_inbox';
/**
 * Inbox long polls on Node (inbox-wake.ts): notify wakes this process's polls at once, and the statement that stored the
 * mail notifies INBOX_CHANNEL at its commit for every other process's, since the runner stores and the API serves the
 * poll. The listener starts with a process's first watch, so one that only stores never listens; a lost listener just
 * leaves the polls their second's read.
 */
export function nodeInboxWake(connection: ConstructorParameters<typeof Client>[0]): InboxWake & { close(): Promise<void> } {
  const local = new Map<string, InboxWaiters>();
  let listener: Promise<Client | null> | null = null, closed = false;
  const listen = () => listener ??= (async () => {
    const client = new Client(connection);
    client.on('error', () => { listener = null; void client.end().catch(() => {}); });
    client.on('notification', message => { const notice = readNotice(message.payload ?? ''); if (notice) local.get(notice.workspaceId)?.wake(notice.inboxIds); });
    await client.connect();
    await client.query(`LISTEN ${INBOX_CHANNEL}`);
    if (closed) { await client.end(); return null; }
    return client;
  })().catch(() => { listener = null; return null; });
  return {
    channel: INBOX_CHANNEL,
    watch(workspaceId, inboxId, ms) {
      if (!closed) void listen();
      const waiters = local.get(workspaceId) ?? local.set(workspaceId, new InboxWaiters()).get(workspaceId)!, controller = new AbortController();
      const woken = waiters.wait(inboxId, Math.min(MAX_WATCH_MS, ms), controller.signal).finally(() => { if (!waiters.size && local.get(workspaceId) === waiters) local.delete(workspaceId); });
      return { woken: onlyWhenWoken(woken), cancel: () => controller.abort() };
    },
    async notify(workspaceId, inboxIds) { local.get(workspaceId)?.wake(inboxIds); },
    async close() { closed = true; const client = await listener; listener = null; await client?.end().catch(() => {}); },
  };
}
export function nodeRuntime(env: Record<string, string | undefined>): { runtime: Runtime; close: () => Promise<void> } {
  const pool = new Pool({ ...postgresConnection(env.DATABASE_URL), max: 10, idleTimeoutMillis: 30000 });
  // pg evicts failed idle clients, but an unhandled pool error also terminates Node.
  // Keep the API/runner alive to reconnect; never log the error's client/config data.
  pool.on('error', () => log('error', { code: 'POSTGRES_POOL_ERROR', message: 'An idle PostgreSQL connection failed; the pool will reconnect.' }));
  const inboxWake = nodeInboxWake(postgresConnection(env.DATABASE_URL));
  const counters = new Pool({ ...postgresConnection(env.DATABASE_URL), max: 2, connectionTimeoutMillis: 1000, idleTimeoutMillis: 30000 });
  counters.on('error', () => log('error', { code: 'DEPRECATED_COUNTER_POOL_ERROR' }));
  const runtime: Runtime = { db: drizzle(pool), deprecatedCallDb: drizzle(counters), storage: s3Storage(env), config: loadConfig(env), webhookFetch: nodeWebhookFetch, inboxWake };
  return { runtime, close: async () => { await inboxWake.close(); await Promise.all([pool.end(), counters.end()]); } };
}
