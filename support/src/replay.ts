import { nightmailApi, NightmailError, type InboundEvent } from './nightmail.js';
import type { Env } from './env.js';
import { INTAKE } from './intake.js';
import { acceptIntake, acceptSupport, holdAtEdge, ledgered } from './ledger.js';
import { MissingSecret } from './tokens.js';
import type { Flow } from './work.js';
import { log, logError } from './log.js';

// Replay and readiness (support/README.md "Replay and readiness"). Nightmail records a message.received event for every
// message an address receives, routed or not, and keeps it 30 days. Each sweep reads them with each flow's own key, so
// mail that reached an address before its route existed, or whose webhook never came, is still answered once: the
// ledger (D1 support_work) and each object's own dedupe make the poller and the webhook safe to overlap.

const PER_TICK = 50, CLOSED_GONE_MS = 7 * 86_400_000, READY_LAG_SECONDS = 900;
/** not_configured: this Worker has no key for the flow (its secret is unset); unauthorized: Nightmail refused the key. */
type Keys = 'ok' | 'missing' | 'extra' | 'not_configured' | 'unauthorized' | 'unavailable';
type Address = { id: string; address: string };

/** The addresses a flow answers for: SUPPORT_ADDRESSES (default SUPPORT_ADDRESS), or the intake addresses. */
export function configured(env: Env, flow: Flow) {
  const list = flow === 'intake' ? env.INTAKE_ADDRESSES : env.SUPPORT_ADDRESSES || env.SUPPORT_ADDRESS;
  const all = [...new Set(list.split(',').map(a => a.trim().toLowerCase()).filter(Boolean))];
  return flow === 'intake' ? all.filter(a => a.split('@')[0]! in INTAKE) : all;
}

/**
 * One flow's turn in the sweep: check that its key reads exactly its addresses, replay what they received since each
 * cursor, and once coverage is complete again (or on the first check), retry blocked work at once.
 */
export async function replay(env: Env, flow: Flow, now = Date.now()) {
  const want = configured(env, flow);
  let keys: Keys, covered: Address[] = [], missing = 0, extra = 0;
  try {
    const seen = await readable(env, flow);
    covered = seen.filter(a => want.includes(a.address));
    missing = want.filter(a => !seen.some(s => s.address === a)).length;
    extra = seen.filter(s => !want.includes(s.address)).length;
    keys = missing ? 'missing' : extra ? 'extra' : 'ok';
  } catch (error) {
    keys = error instanceof MissingSecret ? 'not_configured' : error instanceof NightmailError && [401, 403].includes(error.status) ? 'unauthorized' : 'unavailable';
    logError(error, { event: 'replay', code: 'SUPPORT_KEY_CHECK_FAILED', flow }, 'warn');
  }
  const before = await env.DB.prepare('SELECT keys FROM support_checks WHERE flow = ?').bind(flow).first<{ keys: Keys }>();
  await env.DB.prepare(`INSERT INTO support_checks (flow, keys, missing, extra, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (flow) DO UPDATE SET keys = excluded.keys, missing = excluded.missing, extra = excluded.extra, checked_at = excluded.checked_at`).bind(flow, keys, missing, extra, now).run();
  if (keys !== 'ok') log('error', { event: 'replay', code: 'SUPPORT_KEY_COVERAGE', flow, keys, missing, extra });
  const admitted = covered.length ? await poll(env, flow, covered, now) : 0;
  const complete = (state: Keys | undefined) => state === 'ok' || state === 'extra';
  if (complete(keys) && !complete(before?.keys)) await retryBlocked(env, flow);
  return admitted;
}

/** Every receiving address the flow's key can read. */
async function readable(env: Env, flow: Flow): Promise<Address[]> {
  const api = nightmailApi(env, flow), out: Address[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const { data, nextCursor } = await api.addresses(cursor);
    out.push(...data.map(a => ({ id: a.id, address: a.address.toLowerCase() })));
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

/**
 * Up to 50 events per flow per sweep, address by address from each one's cursor. An address the key can't read isn't
 * polled, so its cursor never passes mail it couldn't see; a new address starts at the flow's first cursor, recorded at
 * install (mail before it went through the webhooks). The flow's '*' row says when the poller was last caught up.
 */
async function poll(env: Env, flow: Flow, covered: Address[], now: number) {
  const api = nightmailApi(env, flow), save = (address: string, cursor: string) => env.DB.prepare(`INSERT INTO replay_cursors (flow, address_id, cursor, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (flow, address_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).bind(flow, address, cursor, now);
  const base = await env.DB.prepare("SELECT cursor FROM replay_cursors WHERE flow = ? AND address_id = '*'").bind(flow).first<{ cursor: string }>();
  if (!base) { await save('*', (await api.events({ limit: 1 })).cursor).run(); return 0; }
  let budget = PER_TICK, admitted = 0, caughtUp = true;
  for (const address of covered) {
    if (!budget) { caughtUp = false; break; }
    let cursor = (await env.DB.prepare('SELECT cursor FROM replay_cursors WHERE flow = ? AND address_id = ?').bind(flow, address.id).first<{ cursor: string }>())?.cursor ?? base.cursor;
    const page = await api.events({ addressId: address.id, after: cursor, limit: budget });
    try {
      for (const event of page.data) {
        if (event.type === 'message.received' && event.messageId && event.addressId === address.id && !(await ledgered(env, flow, event.messageId))) {
          await admit(env, flow, address, event as InboundEvent & { messageId: string }, now);
          admitted++;
        }
        cursor = event.cursor;
      }
    } finally { await save(address.id, cursor).run(); }
    budget -= page.data.length;
    if (page.data.length && !budget) caughtUp = false;
  }
  if (caughtUp) await env.DB.prepare("UPDATE replay_cursors SET updated_at = ? WHERE flow = ? AND address_id = '*'").bind(now, flow).run();
  if (admitted) log('warn', { event: 'replay', code: 'SUPPORT_REPLAYED', flow, admitted });
  return admitted;
}

/** A replayed message, accepted as its webhook would have been; never into a conversation that is closed and gone. */
async function admit(env: Env, flow: Flow, address: Address, event: InboundEvent & { messageId: string }, now: number) {
  const threadId = event.threadId ?? event.messageId;
  if (flow === 'intake') return acceptIntake(env, { messageId: event.messageId, threadId, address: address.address, source: 'poller' });
  const conversation = await env.DB.prepare('SELECT status, closed_at FROM conversations WHERE thread_id = ?').bind(threadId).first<{ status: string; closed_at: number | null }>();
  if (conversation?.status === 'closed' && conversation.closed_at !== null && now - conversation.closed_at > CLOSED_GONE_MS)
    return holdAtEdge(env, { messageId: event.messageId, threadId, sender: null, subject: null, reason: 'replay_closed' });
  if (!(await acceptSupport(env, { messageId: event.messageId, threadId, deliveryId: `replay:${event.cursor}`, source: 'poller' }))) throw new Error('Thread row missing');
}

/** Blocked work in this flow's objects (from the mirror) runs now instead of at its next retry. */
async function retryBlocked(env: Env, flow: Flow) {
  const objects = (await env.DB.prepare("SELECT DISTINCT object FROM support_work WHERE flow = ? AND object != '' AND state = 'blocked' LIMIT 50").bind(flow).all<{ object: string }>()).results;
  for (const { object } of objects) {
    if (flow === 'intake') await env.INTAKE.get(env.INTAKE.idFromString(object)).retryBlocked();
    else await env.CONVERSATION.get(env.CONVERSATION.idFromString(object)).retryBlocked();
  }
  if (objects.length) log('info', { event: 'replay', code: 'SUPPORT_WORK_WOKEN', flow, objects: objects.length });
}

// Public readiness is one bit: both flows can read their mail, the work queue is moving, and replay is current.
export async function readiness(env: Env, now = Date.now()) {
  const ready = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM support_checks WHERE flow IN ('support','intake') AND keys='ok')=2
    AND NOT EXISTS (SELECT 1 FROM support_work WHERE state='blocked' OR (state='pending' AND attempts>=6))
    AND (SELECT min(updated_at) FROM replay_cursors WHERE address_id='*') > ? AS ready`)
    .bind(now - READY_LAG_SECONDS * 1000).first<number>('ready');
  return { ready: ready === 1 };
}
