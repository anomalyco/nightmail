import { nightmailApi } from './nightmail.js';
import type { Env } from './env.js';
import { addressHash } from './tokens.js';
import { log, logError } from './log.js';
import { productName } from '../../api/src/brand.js';

// Daily caps (review M5, R1): model turns, tickets and inbound mail, per person or sender and per budget, per UTC day in
// D1. Budgets don't share: verified customers have their own ticket reserve, each intake address its own, so unverified
// mail at abuse@ can't starve legal@, privacy@ or a customer's escalation. A sender is identified by the DMARC-aligned
// From when DMARC passes; otherwise all unauthenticated mail to one address shares a coarse bucket (a spoofed From
// can't spread itself across many keys). Mail over a cap is kept (bounded) and listed in one daily digest to the team,
// never silently dropped; the first time a global cap is hit each day the team is also told at once. Both emails are
// notices: frozen when first queued and resent by the cron sweep until Nightmail accepts them.

export const DEFAULT_LIMITS = {
  /** Daily model turns reserved for signed-in chats and verified customer emails, and per person. */
  turnsPerDay: 1500,
  turnsPerPerson: 100,
  /** Separate daily budget for general (non-member) email answers, in total and per sender domain. */
  turnsGeneralPerDay: 100,
  turnsPerEmailDomain: 10,
  /** Model turns per email sender address (a verified email's turn counts against its person's cap too). */
  turnsPerEmailSender: 5,
  /** Tickets for verified customers (chat, verified email, a DMARC-passing Nightmail user at an intake address). */
  ticketsVerifiedPerDay: 60,
  /** Tickets from everyone else, per intake address. */
  ticketsIntakePerMailbox: 40,
  /** Tickets per verified customer, or per DMARC-passing sender. */
  ticketsPerPerson: 3,
  /** Inbound mail per DMARC-passing sender, per address's unauthenticated bucket, and in total. */
  mailPerSender: 20,
  mailUnauthenticatedPerMailbox: 30,
  /** Within support@'s unauthenticated bucket, per From address (each such email gets a sign-in reply): one forged address can't spend it all. */
  mailUnauthenticatedPerAddress: 3,
  mailPerDay: 2000,
  /** Agent feedback reports the triage agent reads a day (triage.ts): past it, the rest wait, and get no note if a day goes by. */
  triagePerDay: 100,
  /** "Confirm it's me" links per address a day, and the least time between two for the same open confirmation. */
  confirmsPerAddress: 3,
  confirmResendMinutes: 60,
};
export type Limits = typeof DEFAULT_LIMITS;

/** The caps, with stage overrides from vars (LIMIT_<NAME> as a positive integer). */
export function limits(env: Env): Limits {
  const out = { ...DEFAULT_LIMITS }, vars = env as unknown as Record<string, unknown>;
  for (const name of Object.keys(out) as (keyof Limits)[]) {
    const value = Number(vars[`LIMIT_${name.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]);
    if (Number.isInteger(value) && value > 0) out[name] = value;
  }
  return out;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const TWO_LABEL_PSL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'co.jp', 'ne.jp', 'or.jp', 'co.in', 'com.mx', 'co.za', 'com.sg', 'com.hk', 'co.kr', 'com.tr', 'com.ar']);
/** Registrable domain of an email address (lowercase), for per-domain general-email caps. */
export function registrableDomain(email: string): string {
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LABEL_PSL.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;
}

/** Counts one use of `key` today and says whether it is within `limit`. Atomic in D1. */
export async function countToday(env: Env, key: string, limit: number, now = Date.now()): Promise<{ ok: boolean; n: number }> {
  const row = await env.DB.prepare('INSERT INTO daily_counters (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1 RETURNING n').bind(today(now), key).first<{ n: number }>();
  const n = row?.n ?? Number.MAX_SAFE_INTEGER;
  return { ok: n <= limit, n };
}

export type Mailbox = 'support' | 'abuse' | 'privacy' | 'legal';
/** The mail-cap identity of a sender (R1): the address when DMARC passes, else the address's unauthenticated bucket. */
export async function mailIdentity(env: Env, mailbox: Mailbox, sender: string, dmarcPass: boolean) {
  const cap = limits(env);
  return dmarcPass ? { key: `sender:${await addressHash(sender)}:mail`, limit: cap.mailPerSender } : { key: `unauthenticated:${mailbox}:mail`, limit: cap.mailUnauthenticatedPerMailbox };
}

/** Whether one more inbound message fits today (its sender's or bucket's cap, then the total). */
export async function mailAllowed(env: Env, mailbox: Mailbox, sender: string, dmarcPass: boolean, count = countToday): Promise<{ ok: true } | { ok: false; reason: string }> {
  const id = await mailIdentity(env, mailbox, sender, dmarcPass), cap = limits(env);
  // Unauthenticated mail at support@ (each answered with a sign-in for that email): its From address first, so a few
  // forged addresses can't use up the bucket every other sender without DMARC shares.
  if (!dmarcPass && mailbox === 'support' && !(await count(env, `unauthenticated:support:${await addressHash(sender)}:mail`, cap.mailUnauthenticatedPerAddress)).ok) return { ok: false, reason: 'unauthenticated mail per address' };
  if (!(await count(env, id.key, id.limit)).ok) return { ok: false, reason: dmarcPass ? 'mail per sender' : `unauthenticated mail to ${mailbox}@` };
  if (!(await count(env, 'global:mail', cap.mailPerDay)).ok) { await alertOnce(env, 'mail', cap.mailPerDay); return { ok: false, reason: 'mail per day' }; }
  return { ok: true };
}

/**
 * Whether a new ticket fits: a verified customer's from the verified reserve (and their own cap), anyone else's from
 * their intake address's budget (and, when DMARC passes, their own cap). `scope` says which cap refused it.
 */
export async function ticketAllowed(env: Env, input: { verifiedUserId: string | null; mailbox: Mailbox; sender: string | null; dmarcPass: boolean }, count = countToday): Promise<{ ok: true } | { ok: false; scope: 'person' | 'global'; reason: string }> {
  const cap = limits(env);
  if (input.verifiedUserId) {
    if (!(await count(env, `user:${input.verifiedUserId}:tickets`, cap.ticketsPerPerson)).ok) return { ok: false, scope: 'person', reason: 'tickets per customer' };
    if (!(await count(env, 'global:tickets:verified', cap.ticketsVerifiedPerDay)).ok) { await alertOnce(env, 'tickets', cap.ticketsVerifiedPerDay); return { ok: false, scope: 'global', reason: 'verified tickets per day' }; }
    return { ok: true };
  }
  if (input.dmarcPass && input.sender && !(await count(env, `sender:${await addressHash(input.sender)}:tickets`, cap.ticketsPerPerson)).ok) return { ok: false, scope: 'person', reason: 'tickets per sender' };
  if (!(await count(env, `global:tickets:intake:${input.mailbox}`, cap.ticketsIntakePerMailbox)).ok) return { ok: false, scope: 'global', reason: `tickets for ${input.mailbox}@` };
  return { ok: true };
}

export type Held = { channel: Mailbox; reason: string; sender: string | null; dmarc: string | null; subject: string | null; text: string | null; messageId: string; threadId: string | null };
/** The row that keeps a message for the team's digest, unless it is already kept for that reason. */
export function overflowRow(env: Env, held: Held) {
  return env.DB.prepare(`INSERT INTO overflow (day, channel, reason, sender, dmarc, subject, text, message_id, thread_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM overflow WHERE message_id = ? AND channel = ? AND reason = ?)`)
    .bind(today(), held.channel, held.reason, held.sender?.slice(0, 254) ?? null, held.dmarc, held.subject?.slice(0, 200) ?? null, held.text?.slice(0, 4000) ?? null, held.messageId, held.threadId, Date.now(), held.messageId, held.channel, held.reason);
}

/** Keeps a message that went over a cap for the team's digest (bounded: 4,000 characters, 2,000 messages a day). */
export async function holdOverCap(env: Env, held: Held, count = countToday) {
  const n = await count(env, 'overflow:kept', 2000);
  log('warn', { event: 'email', code: 'OVER_CAP_HELD', channel: held.channel, reason: held.reason, kept: n.ok });
  if (!n.ok) return;
  await overflowRow(env, held).run();
}

/** Tells the team once a day that a global cap was reached (idempotent per day and kind). */
export async function alertOnce(env: Env, kind: 'turns' | 'tickets' | 'mail', limit: number) {
  log('error', { event: 'cap', code: 'SUPPORT_DAILY_CAP_REACHED', kind, limit });
  const what = { turns: 'model-turn budget', tickets: 'verified-customer ticket reserve', mail: 'inbound mail cap' }[kind];
  await notice(env, `cap-${kind}-${today()}`, { subject: `[${productName} support] Daily ${what} reached (${limit})`,
    text: [`The support agent reached its daily ${what} of ${limit} on ${today()} (UTC).`, '', kind === 'turns'
      ? 'Until midnight UTC, chats show "support is busy" and support emails get a fixed reply saying the team will answer.'
      : 'Until midnight UTC, mail over the cap is kept and listed in tomorrow’s over-cap digest; nothing is dropped.', '',
      'Raise it with the matching LIMIT_* var, or check the conversations for abuse.'].join('\n') });
}

type Notice = { addressId?: string; to: string[]; subject: string; text: string };
/**
 * A team email sent once under its idempotency key: the request is frozen when first queued, and the cron sweep resends
 * exactly it (resendNotices) until Nightmail accepts it. A later call with the same key does nothing.
 */
export async function notice(env: Env, key: string, email: { subject: string; text: string }) {
  const now = Date.now(), request: Notice = { addressId: env.SUPPORT_ADDRESS_ID, to: [env.TICKET_TO], ...email };
  const queued = await env.DB.prepare('INSERT INTO support_notices (key, request, due_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING').bind(key, JSON.stringify(request), now, now).run();
  if (queued.meta.changes) await sendNotice(env, key, request, 0);
}

async function sendNotice(env: Env, key: string, request: Notice, attempts: number) {
  try {
    await nightmailApi(env).startThread(request, key);
    await env.DB.prepare('UPDATE support_notices SET sent_at = ?, attempts = ?, last_error = NULL WHERE key = ?').bind(Date.now(), attempts + 1, key).run();
  } catch (error) {
    logError(error, { event: 'notice', code: 'SUPPORT_NOTICE_FAILED', attempt: attempts + 1 });
    const status = (error as { status?: number }).status ?? 0, code = (error as { code?: string }).code ?? 'ERROR';
    await env.DB.prepare('UPDATE support_notices SET attempts = ?, due_at = ?, last_error = ? WHERE key = ?')
      .bind(attempts + 1, Date.now() + Math.min(60, 5 * 2 ** attempts) * 60_000, `${status}:${String(code).slice(0, 60)}`, key).run();
  }
}

/** The sweep's part: unsent notices from the last two days whose retry is due, each resent as first queued. */
export async function resendNotices(env: Env, now = Date.now()) {
  const due = (await env.DB.prepare('SELECT key, request, attempts FROM support_notices WHERE sent_at IS NULL AND due_at <= ? AND created_at > ? ORDER BY created_at LIMIT 10')
    .bind(now, now - 2 * 86_400_000).all<{ key: string; request: string; attempts: number }>()).results;
  for (const row of due) await sendNotice(env, row.key, JSON.parse(row.request) as Notice, row.attempts);
  return due.length;
}

/** The daily cron (00:10 UTC): yesterday's over-cap digest to the team, and the retention sweep (review L2). */
export async function daily(env: Env, now = Date.now()) {
  const day = today(now - 86_400_000);
  const rows = (await env.DB.prepare('SELECT channel, reason, sender, dmarc, subject, message_id, thread_id FROM overflow WHERE day = ? ORDER BY id LIMIT 200').bind(day).all<{ channel: string; reason: string; sender: string | null; dmarc: string | null; subject: string | null; message_id: string; thread_id: string | null }>()).results;
  const total = (await env.DB.prepare('SELECT count(*) AS n FROM overflow WHERE day = ?').bind(day).first<{ n: number }>())?.n ?? 0;
  if (total) {
    const lines = [`${total} message${total === 1 ? ' was' : 's were'} over a daily cap on ${day} (UTC) and kept here instead of being answered or ticketed. Everything is also in ${productName}'s inbox.`, '',
      ...rows.map(r => `- ${r.channel}@ · ${r.reason} · ${r.sender ?? 'unknown'} (DMARC ${r.dmarc ?? 'none'}) · "${(r.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120)}" · ${r.message_id}${r.thread_id ? ` · thread ${r.thread_id}` : ''}`),
      ...(total > rows.length ? [`…and ${total - rows.length} more (D1 overflow, day ${day}).`] : []), '', 'Subjects and senders are untrusted.'];
    await notice(env, `overflow-${day}`, { subject: `[${productName} support] ${total} message${total === 1 ? '' : 's'} over cap on ${day}`, text: lines.join('\n') });
  }
  // Retention: counters a week, single-use records and notices a month, overflow 30 days, finished work 35 days (the
  // replay poller dedupes against it for the 30 days Nightmail keeps events), closed conversations a year, and
  // tickets a year after their last change (staff resolve them in Nightmail's Support inbox). Mail kept at the edge for an address nobody configured within 30 days is given up (it stays in Nightmail's inbox).
  const ago = (days: number) => now - days * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("UPDATE support_work SET state = 'dead', updated_at = ? WHERE object = '' AND state = 'blocked' AND created_at < ?").bind(now, ago(30)),
    env.DB.prepare("DELETE FROM support_work WHERE state IN ('done', 'held', 'dead', 'parked') AND updated_at < ?").bind(ago(35)),
    env.DB.prepare('DELETE FROM support_notices WHERE created_at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM daily_counters WHERE day < ?').bind(today(ago(7))),
    env.DB.prepare('DELETE FROM overflow WHERE created_at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM handoffs_used WHERE used_at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM confirmations WHERE used_at < ?').bind(ago(30)),
    env.DB.prepare('DELETE FROM pending_confirms WHERE sent_at < ?').bind(ago(2)),
    env.DB.prepare('DELETE FROM tickets WHERE updated_at < ?').bind(ago(365)),
    env.DB.prepare("DELETE FROM conversations WHERE status = 'closed' AND closed_at < ? AND id NOT IN (SELECT conversation_id FROM tickets)").bind(ago(365)),
  ]);
  return { digest: total };
}
