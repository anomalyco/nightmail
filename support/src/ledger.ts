import type { Env } from './env.js';
import { nightmailApi, platformBody, type OutboxReply } from './nightmail.js';
import { INTAKE, type Mailbox } from './intake.js';
import { countToday, overflowRow, resendNotices } from './limits.js';
import { replay } from './replay.js';
import { fromRow, type TicketRow } from './tickets.js';
import type { Flow } from './work.js';
import { newId } from './tokens.js';
import { log, logError } from './log.js';

// The work ledger (D1 `support_work`, migrations/0005). Every message a flow accepts gets a row before its webhook
// answers, mail refused at the edge is kept as a row instead of vanishing, and each object mirrors its work items here
// (work.ts). The cron sweep (every five minutes) reads it, never each object, to finish what an earlier step left:
// unsent team notices, intake mail for an address configured since, tickets no team email or follow-up covers, answers
// parked for their sender's sign-in (a claim's own wake can be lost), and the replay poller (replay.ts), which accepts
// mail no webhook delivered. It also pulls the staff inbox's replies (api/src/support-inbox.ts) and hands each to its
// conversation: a wake does the same for one conversation at once, and pulling is what lets staff reply at all (they can
// only while it happens).

export type Source = 'webhook' | 'poller';
const DAY = 86_400_000, MINUTES_10 = 600_000, MINUTES_5 = 300_000;
/** Conversations with an answer parked for a sign-in, woken per sweep. */
const SIGNIN_WAKES = 50;

/** Whether the flow already accepted or kept this message: a later delivery of it changes nothing. */
export async function ledgered(env: Env, flow: Flow, messageId: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM support_work WHERE flow = ? AND message_id = ? AND kind = 'message' LIMIT 1").bind(flow, messageId).first());
}

/** The ledger row of an accepted message; the object's own mirror fills in its progress. */
function accepted(env: Env, flow: Flow, object: string, messageId: string, threadId: string, source: Source) {
  const now = Date.now();
  return env.DB.prepare(`INSERT INTO support_work (flow, object, id, kind, state, source, message_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, 'message', 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT (flow, object, id) DO UPDATE SET source = coalesce(support_work.source, excluded.source)`).bind(flow, object, `msg:${messageId}`, source, messageId, threadId, now, now).run();
}

/** A message kept before any object: held for the digest, or blocked until its address is configured. */
function edge(env: Env, flow: Flow, input: { messageId: string; threadId: string; state: 'held' | 'blocked'; reason: 'rate' | 'unconfigured' | 'replay_closed'; source: Source; detail?: object }) {
  const now = Date.now();
  return env.DB.prepare(`INSERT INTO support_work (flow, object, id, kind, state, reason, source, message_id, thread_id, detail, created_at, updated_at)
    VALUES (?, '', ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (flow, object, id) DO NOTHING`)
    .bind(flow, `msg:${input.messageId}`, input.state, input.reason, input.source, input.messageId, input.threadId, input.detail ? JSON.stringify(input.detail) : null, now, now);
}

/**
 * Support mail into its thread's conversation (created on first use). The object stores the message and arms its alarm
 * before this returns, so once the ledger row is written the message can't be lost. False: D1 lost the thread's row.
 */
export async function acceptSupport(env: Env, input: { messageId: string; threadId: string; deliveryId: string; source: Source }) {
  const { messageId, threadId } = input, now = Date.now();
  let row = await env.DB.prepare('SELECT id FROM conversations WHERE thread_id = ?').bind(threadId).first<{ id: string }>();
  if (!row) {
    await env.DB.prepare("INSERT INTO conversations (id, channel, thread_id, created_at, updated_at) VALUES (?, 'email', ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING").bind(newId('conv'), threadId, now, now).run();
    row = await env.DB.prepare('SELECT id FROM conversations WHERE thread_id = ?').bind(threadId).first<{ id: string }>();
  }
  if (!row) return false;
  const object = env.CONVERSATION.idFromName(row.id);
  await env.CONVERSATION.get(object).enqueueInbound({ conversationId: row.id, threadId, messageId, deliveryId: input.deliveryId });
  await accepted(env, 'support', object.toString(), messageId, threadId, input.source);
  return true;
}

/** The intake address among a message's recipients (envelope recipients, else the To header), if it is configured. */
export function intakeAddress(env: Env, recipients: string) {
  return env.INTAKE_ADDRESSES.split(',').map(a => a.trim().toLowerCase()).find(a => a && recipients.includes(a) && a.split('@')[0]! in INTAKE);
}

/** Intake mail into its thread's object. */
export async function acceptIntake(env: Env, input: { messageId: string; threadId: string; address: string; source: Source }) {
  const { messageId, threadId, address } = input, object = env.INTAKE.idFromName(threadId);
  await env.INTAKE.get(object).enqueue({ threadId, messageId, mailbox: address.split('@')[0] as Mailbox, address });
  await accepted(env, 'intake', object.toString(), messageId, threadId, input.source);
}

const HELD = { rate: 'mail per minute per sender', replay_closed: 'replayed after its thread closed' };
/**
 * Support mail kept before any object, never read or answered, only a row the digest lists: over the per-sender edge
 * limit (a webhook), or replayed for a thread whose conversation is closed and gone (the poller).
 */
export async function holdAtEdge(env: Env, input: { messageId: string; threadId: string; sender: string | null; subject: string | null; reason: keyof typeof HELD }) {
  const kept = await countToday(env, 'overflow:kept', 2000);
  log('warn', { event: 'email', code: 'OVER_CAP_HELD', channel: 'support', reason: input.reason, kept: kept.ok });
  await env.DB.batch([
    edge(env, 'support', { ...input, state: 'held', source: input.reason === 'rate' ? 'webhook' : 'poller' }),
    ...(kept.ok ? [overflowRow(env, { channel: 'support', reason: HELD[input.reason], sender: input.sender, dmarc: 'not checked', subject: input.subject, text: null, messageId: input.messageId, threadId: input.threadId })] : []),
  ]);
}

/** Intake mail for an address the Worker doesn't list: kept, blocked, until the sweep finds the address configured. */
export async function blockUnconfigured(env: Env, input: { messageId: string; threadId: string; recipients: string }) {
  log('error', { event: 'email', code: 'INTAKE_ADDRESS_UNCONFIGURED' });
  await edge(env, 'intake', { ...input, state: 'blocked', reason: 'unconfigured', source: 'webhook', detail: { recipients: input.recipients.slice(0, 4000) } }).run();
}

/** Every five minutes: each step on its own, so one failing never stops the others. */
export async function sweep(env: Env, now = Date.now()) {
  const result: Record<string, number> = {};
  const steps: [string, () => Promise<number>][] = [['notices', () => resendNotices(env, now)], ['intake', () => acceptConfigured(env, now)], ['tickets', () => ticketMail(env, now)], ['staffMail', () => staffMail(env)], ['staff', () => staffReplies(env)], ['signins', () => signinWakes(env, now)],
    ['replaySupport', () => replay(env, 'support', now)], ['replayIntake', () => replay(env, 'intake', now)]];
  for (const [name, step] of steps) {
    try { result[name] = await step(); }
    catch (error) { logError(error, { event: 'scheduled', code: 'SUPPORT_SWEEP_STEP_FAILED', step: name }); }
  }
  return result;
}

/**
 * Conversations whose answers wait for their sender's sign-in, woken to ask Nightmail again (the claim's own wake can be
 * lost), until each is released or its conversation closes (which holds it). Only those due, the longest due first, and
 * each one's next check is moved later here, before the wake, as well as by the object itself (SIGNIN_CHECKS in
 * conversation.ts, mirrored here): whatever the wakes do, every parked answer's turn comes, never only the same first few.
 */
async function signinWakes(env: Env, now: number) {
  const rows = (await env.DB.prepare("SELECT object, min(due_at) AS due FROM support_work WHERE flow = 'support' AND kind = 'answer' AND state = 'parked' AND due_at <= ? GROUP BY object ORDER BY due, object LIMIT ?")
    .bind(now, SIGNIN_WAKES).all<{ object: string; due: number }>()).results;
  let n = 0;
  for (const row of rows) {
    await env.DB.prepare("UPDATE support_work SET due_at = ? WHERE flow = 'support' AND object = ? AND kind = 'answer' AND state = 'parked' AND due_at <= ?").bind(now + MINUTES_5, row.object, now).run();
    try { await env.CONVERSATION.get(env.CONVERSATION.idFromString(row.object)).wake(); n++; }
    catch (error) { logError(error, { event: 'email', code: 'SIGNIN_WAKE_FAILED' }, 'warn'); }
  }
  return n;
}

/**
 * One path to a human (api/src/support-staff-mail.ts): the staff emails Nightmail wrote, each sent from the support
 * address to the team (TICKET_TO, the one place it is kept) under its own key, then reported sent. A thread's first
 * email starts it; later ones reply in it under the same subject. A failed send is tried again on the next sweep, as
 * the same email under the same key, so it never goes twice.
 */
async function staffMail(env: Env) {
  if (!env.TICKET_TO || !env.SUPPORT_ADDRESS_ID) return 0;
  const due = platformBody(await env.BANE.staffMail()).data, api = nightmailApi(env);
  let n = 0;
  for (const mail of due) {
    try {
      const sent = mail.threadId && mail.replyToMessageId
        ? await api.reply(mail.threadId, { replyToMessageId: mail.replyToMessageId, to: env.TICKET_TO, subject: mail.subject, text: mail.text, html: mail.html, addressId: env.SUPPORT_ADDRESS_ID }, mail.key)
        : await api.startThread({ to: [env.TICKET_TO], subject: mail.subject, text: mail.text, html: mail.html }, mail.key);
      platformBody(await env.BANE.staffMailSent(mail.key, { threadId: sent.threadId, messageId: sent.id }));
      n++;
    } catch (error) { logError(error, { event: 'ticket', code: 'STAFF_MAIL_FAILED', key: mail.key }, 'warn'); }
  }
  return n;
}

/** Every staff reply waiting in Nightmail's outbox, to its conversation (each queues it once). */
async function staffReplies(env: Env) {
  const pulled = platformBody(await env.BANE.pullOutbox());
  const byConversation = new Map<string, OutboxReply[]>();
  for (const reply of pulled.data) byConversation.set(reply.conversationId, [...byConversation.get(reply.conversationId) ?? [], reply]);
  let n = 0;
  for (const [id, replies] of byConversation) {
    try { n += await env.CONVERSATION.get(env.CONVERSATION.idFromName(id)).deliver({ replies }); }
    catch (error) { logError(error, { event: 'inbox', code: 'STAFF_REPLY_HANDOFF_FAILED' }, 'warn'); }
  }
  return n;
}

/** Intake mail blocked for an unlisted address, accepted once INTAKE_ADDRESSES lists it. */
async function acceptConfigured(env: Env, now: number) {
  const rows = (await env.DB.prepare("SELECT id, message_id, thread_id, detail FROM support_work WHERE flow = 'intake' AND object = '' AND state = 'blocked' AND created_at > ? ORDER BY created_at LIMIT 50")
    .bind(now - 30 * DAY).all<{ id: string; message_id: string; thread_id: string; detail: string | null }>()).results;
  let n = 0;
  for (const row of rows) {
    const address = intakeAddress(env, (JSON.parse(row.detail ?? '{}') as { recipients?: string }).recipients ?? '');
    if (!address) continue;
    await acceptIntake(env, { messageId: row.message_id, threadId: row.thread_id, address, source: 'webhook' });
    await env.DB.prepare("UPDATE support_work SET state = 'done', updated_at = ? WHERE flow = 'intake' AND object = '' AND id = ?").bind(Date.now(), row.id).run();
    n++;
  }
  return n;
}

const TICKET = `SELECT t.id, t.conversation_id, t.channel, t.type, t.title, t.severity, t.due_at, t.customer, t.summary, t.ask, t.tried, t.recommendation, t.evidence, t.details,
  t.followup_thread_id, t.cost_usd, t.model, c.thread_id AS owner FROM tickets t LEFT JOIN conversations c ON c.id = t.conversation_id`;
/**
 * Tickets whose team email (or, for a chat, the customer's follow-up) no work item covers: filed before the work queue,
 * or whose item was lost. The owning object queues the item, rebuilt from the D1 row; an existing item is left alone,
 * so a ticket is emailed once whichever path got there first. Follow-ups only within a day: a late one would confuse.
 */
async function ticketMail(env: Env, now: number) {
  const open = "t.status IN ('open', 'waiting_customer') AND t.created_at < ? AND t.created_at > ?";
  const notify = (await env.DB.prepare(`${TICKET} WHERE t.notified_at IS NULL AND ${open} AND NOT EXISTS (SELECT 1 FROM support_work w WHERE w.id = 'notify:' || t.id) ORDER BY t.created_at LIMIT 20`)
    .bind(now - MINUTES_10, now - 30 * DAY).all<TicketRow & { owner: string | null }>()).results;
  const followup = (await env.DB.prepare(`${TICKET} WHERE t.channel = 'chat' AND t.followup_thread_id IS NULL AND ${open} AND json_extract(t.customer, '$.verified') = 'handoff'
    AND json_extract(t.customer, '$.email') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM support_work w WHERE w.id = 'followup:' || t.id) ORDER BY t.created_at LIMIT 20`)
    .bind(now - MINUTES_10, now - DAY).all<TicketRow & { owner: string | null }>()).results;
  let n = 0;
  for (const [kind, rows] of [['notify', notify], ['followup', followup]] as const) {
    for (const row of rows) {
      const ticket = fromRow(row);
      const added = row.owner?.startsWith('intake:')
        ? kind === 'notify' && (await env.INTAKE.get(env.INTAKE.idFromName(row.owner.slice('intake:'.length))).ensure(ticket)).added
        : (await env.CONVERSATION.get(env.CONVERSATION.idFromName(row.conversation_id)).ensure({ kind, ...ticket })).added;
      if (added) { n++; log('warn', { event: 'ticket', code: 'TICKET_MAIL_RESTORED', kind, ticket: row.id }); }
    }
  }
  return n;
}
