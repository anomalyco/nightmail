import { sql } from 'drizzle-orm';
import { log, logError, type DbExecutor, type Runtime } from './core.js';

// First-party delivery history: what each workspace's own mail did, kept past the 30 days the sent-mail log keeps it
// (migration 542). Read by the workspace's own audience review; never by another workspace.
//  - delivery_domain_stats: per workspace and recipient domain, every message to one recipient there by outcome, and the
//    failures by class (bounceClass).
//  - audience_contacts mailed_count, delivered_count, first_mailed_at, last_mailed_at, soft_failures: the campaign and
//    marketing mail each contact was sent.
//  - delivery_blocklist_daily: replies naming a blocklist, by day, workspace, From domain and link host.
// One writer: the hourly rollup below, under a lease, reads finished mail a day old or more (its feedback is in by then)
// by a cursor over (created_at, id), a page at a time, and writes a page's sums and its cursor in one transaction, so a
// message is counted once. It starts 30 days back, which is everything the log still holds. The send path and feedback
// handling are untouched. Opens, clicks and complaints that arrive after that day aren't counted here (the contact's
// last_open_at and last_click_at still see them). Counted: mail SES accepted, to exactly one recipient (campaigns and
// nearly all API sends), not simulated. Not counted: mail that waited more than a day between its creation and its
// sending (held by a pause or a quota, or scheduled that far ahead): the cursor has passed it by then, and waiting for it
// would hold up everyone else.

export const BOUNCE_CLASSES = ['user_unknown', 'dead_domain', 'mailbox_full', 'blocklist', 'policy', 'reputation', 'auth', 'validation', 'other'] as const;
export type BounceClass = (typeof BOUNCE_CLASSES)[number];

// The blocklist a reply names, if it names one. Mail servers say it in their own words: "listed by Spamhaus DBL",
// "URIBL_DBL_SPAM", "blocked using zen.spamhaus.org", "Client host blocked using b.barracudacentral.org".
// A bare three-letter zone name (DBL, SBL, XBL, PBL) counts only next to a word that says something was listed or blocked:
// on its own it turns up in addresses, host names and queue IDs. Addresses are taken out of the reply before matching.
const LISTED = String.raw`(?:listed|blocked|blacklisted|blocklisted|rejected)[^.;]{0,40}`;
const BLOCKLISTS: [string, RegExp][] = [
  ['spamhaus', new RegExp(String.raw`spamhaus|(?<![a-z0-9])(?:sbl-xbl|uribl_dbl\w*)(?![a-z0-9])|${LISTED}(?<![a-z0-9])(?:dbl|sbl|xbl|pbl)(?![a-z0-9])`, 'i')],
  ['uribl', /uribl/i],
  ['surbl', /surbl/i],
  ['spamcop', /spamcop/i],
  ['barracuda', /barracudacentral|(?<![a-z0-9])brbl(?![a-z0-9])|barracuda reputation/i],
  ['other', new RegExp(String.raw`(?<![a-z0-9])(?:block|black|deny)[ -]?list(?:ed)?(?![a-z0-9])|(?<![a-z0-9])dnsbl(?![a-z0-9])|${LISTED}(?<![a-z0-9])rbl(?![a-z0-9])`, 'i')],
];
/** The reply's first 2,000 characters (the receiving server writes it, and its length), without the addresses it quotes
 *  (<user@host> and bare user@host). Bounded so no reply can make the matching slow. */
const withoutAddresses = (reply: string) => reply.slice(0, 2_000).replace(/<[^<>]*>/g, ' ').replace(/[^\s<>@]{1,64}@[^\s<>]+/g, ' ');
export function blocklistNamed(reply: string | null | undefined): string | null {
  if (!reply) return null;
  const said = withoutAddresses(reply);
  for (const [name, pattern] of BLOCKLISTS) if (pattern.test(said)) return name;
  return null;
}

// An enhanced status code standing on its own, never digits inside an IP address or a version (10.5.1.3, 5.1.1.20).
const code = (codes: string) => String.raw`(?<![\w.])(?:${codes})(?!\w|\.\d)`;
const AUTH = new RegExp(code(String.raw`5\.7\.(?:26|27|509|515)`) + String.raw`|unauthenticated|\b(?:dmarc|spf|dkim)\b(?!=pass)[^.]{0,40}(?:fail|reject|policy)`, 'i');
const FULL = new RegExp(code(String.raw`[45]\.2\.2`) + String.raw`|mailbox (?:is )?full|over ?quota|quota (?:exceeded|full)|insufficient (?:system )?storage|out of storage`, 'i');
const DEAD_DOMAIN = new RegExp(code(String.raw`5\.1\.2|5\.4\.4`) + String.raw`|host (?:or domain name )?not found|domain (?:name )?(?:does not exist|not found|doesn't exist)|nxdomain|no mx|null mx|unrouteable|unroutable|name service error|no route to host`, 'i');
const USER_UNKNOWN = new RegExp(code(String.raw`5\.1\.[136]`) + String.raw`|user unknown|unknown (?:user|recipient)|no such (?:user|mailbox|recipient|address)|(?:mailbox|user|recipient|address|account) (?:does not exist|doesn't exist|not found|unavailable|disabled|is disabled|inactive)|invalid (?:recipient|mailbox|address)|not a valid (?:mailbox|address|recipient)`, 'i');
// 5.1.0 is used both for unknown recipients and for sender or spam rejections: only after the policy checks.
const ADDRESS_FALLBACK = new RegExp(code(String.raw`5\.1\.0`) + String.raw`|recipient (?:address )?rejected|address rejected`, 'i');
const REPUTATION = new RegExp(code(String.raw`4\.7\.(?:28|650)`) + String.raw`|tss04|rate limit|too many (?:messages|connections|emails|recipients)|throttl|reputation|temporarily (?:deferred|rate)|grey ?list|gray ?list`, 'i');
const POLICY = new RegExp(code(String.raw`5\.7\.\d{1,3}`) + String.raw`|spam|policy|content|rejected by|message rejected|access denied|not accepted|security`, 'i');

/**
 * Why a message failed, from SES's event: its type (bounce, non_permanent_bounce, validation_suppressed, delivery_delay),
 * bounce subtype, enhanced status and the receiving server's reply. A reply naming a blocklist is blocklist first, whatever
 * else it says, since that is about the sender's domains and links and not the recipient.
 */
export function bounceClass(e: { type: string; subType?: string | null; status?: string | null; diagnostic?: string | null }): BounceClass {
  if (e.type === 'validation_suppressed' || e.subType === 'EmailValidationSuppressed') return 'validation';
  if (blocklistNamed(e.diagnostic)) return 'blocklist';
  const said = (e.status ?? '').slice(0, 20) + ' ' + withoutAddresses(e.diagnostic ?? '');
  if (e.subType === 'ContentRejected' || e.subType === 'AttachmentRejected') return 'policy';
  if (AUTH.test(said)) return 'auth';
  if (e.subType === 'MailboxFull' || FULL.test(said)) return 'mailbox_full';
  if (DEAD_DOMAIN.test(said)) return 'dead_domain';
  // SES's own suppression list holds addresses that bounced recently.
  if (e.subType === 'NoEmail' || e.subType === 'Suppressed' || e.subType === 'OnAccountSuppressionList' || USER_UNKNOWN.test(said)) return 'user_unknown';
  if (REPUTATION.test(said)) return 'reputation';
  if (POLICY.test(said)) return 'policy';
  if (ADDRESS_FALLBACK.test(said)) return 'user_unknown';
  return 'other';
}

// 500 a page: a page's contact update holds those contacts until it commits, and a send to them waits that long. On
// packed pages (no room for a HOT update) 2,000 contacts took 2.3–2.6 s at the 2M scale; 500 keep it well under a second.
const ROLLUP = { page: 500, budgetMs: 20_000, matureHours: 24, backDays: 30, statementMs: 5_000, lockMs: 1_000, lease: '10 minutes', maxBudgetMs: 5 * 60_000 } as const;
const OUTCOME = { accepted: 1, delivered: 2, bounced: 4, complained: 8, opened: 16, clicked: 32, delayed: 128 } as const;
type Mail = { id: string; workspace_id: string; at: string; status: string; o: number; simulated: boolean; single: boolean; accepted: boolean; marketing: boolean; rcpt: string | null; from_domain: string; link_host: string | null };
type Feedback = { email_id: string; type: string; sub_type: string | null; status: string | null; diagnostic: string | null };
type Domain = { sent: number; delivered: number; hard: number; soft: number; complained: number; opened: number; clicked: number; classes: Record<BounceClass, number>; failedSince: number; first: string; last: string; lastDelivered: string | null };
type Contact = { mailed: number; delivered: number; first: string; last: string; soft: number; reset: boolean };

const transaction = <T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>) => db.transaction(async tx => {
  await tx.execute(sql`SELECT set_config('statement_timeout',${String(ROLLUP.statementMs)},true),set_config('lock_timeout',${String(ROLLUP.lockMs)},true)`);
  return work(tx);
});
const arr = (values: unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** Folds one page of finished mail after the cursor; returns how many messages it read (the page is full while more wait). */
async function foldPage(tx: DbExecutor, cursor: { at: string; id: string }, lease: string) {
  const { rows: mail } = await tx.execute<Mail>(sql`SELECT e.id, e.workspace_id, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, e.status, e.event_outcomes::int AS o, e.simulated,
      jsonb_array_length(e.to_addresses)=1 AND e.cc_addresses='[]'::jsonb AND e.bcc_addresses='[]'::jsonb AS single,
      (e.provider_id IS NOT NULL OR e.event_outcomes & 1 <> 0) AS accepted, (e.campaign_id IS NOT NULL OR e.snapshot->>'kind'='marketing') AS marketing,
      lower(e.to_addresses->>0) AS rcpt, lower(split_part(e.from_address,'@',2)) AS from_domain,
      lower(substring(e.snapshot->>'unsubscribeUrl' from '^https?://([^/:?#]+)')) AS link_host
    FROM sending_emails e
    WHERE e.status <> ALL(ARRAY['queued','attempting']) AND e.created_at >= ${cursor.at}::timestamptz AND (e.created_at, e.id) > (${cursor.at}::timestamptz, ${cursor.id})
      AND e.created_at < now() - make_interval(hours => ${ROLLUP.matureHours})
    ORDER BY e.created_at, e.id LIMIT ${ROLLUP.page}`);
  if (!mail.length) return { read: 0, counted: 0, blocklisted: 0, cursor };
  const counted = mail.filter(m => m.single && m.accepted && !m.simulated && m.status !== 'scheduled' && m.rcpt?.includes('@'));
  const delivered = (m: Mail) => (m.o & OUTCOME.delivered) !== 0 || m.status === 'delivered';
  // SES's account of each message that failed or was held up: its bounces, deferrals and delays, oldest first.
  const asked = counted.filter(m => !delivered(m) || (m.o & OUTCOME.delayed) !== 0 || ['bounced', 'delayed', 'suppressed'].includes(m.status));
  const feedback = new Map<string, Feedback[]>();
  if (asked.length) {
    const { rows } = await tx.execute<Feedback>(sql`SELECT v.email_id, v.type, v.data->>'bounceSubType' AS sub_type,
        coalesce(v.data->>'status', v.data #>> '{bounce,bouncedRecipients,0,status}', v.data #>> '{deliveryDelay,delayedRecipients,0,status}') AS status,
        coalesce(v.data->>'diagnosticCode', v.data #>> '{bounce,bouncedRecipients,0,diagnosticCode}', v.data #>> '{deliveryDelay,delayedRecipients,0,diagnosticCode}') AS diagnostic
      FROM unnest(${arr(asked.map(m => m.workspace_id), 'text')}, ${arr(asked.map(m => m.id), 'text')}) AS u(w, i)
      JOIN sending_email_events v ON v.workspace_id = u.w AND v.email_id = u.i
      WHERE v.type IN ('bounce','non_permanent_bounce','validation_suppressed','delivery_delay') ORDER BY v.created_at, v.id`);
    for (const row of rows) feedback.set(row.email_id, [...(feedback.get(row.email_id) ?? []), row]);
  }
  const domains = new Map<string, Domain>(), contacts = new Map<string, Contact>(), blocked = new Map<string, number>();
  for (const m of counted) {
    // A bounce after a delivery event (a relay accepted it, then returned it) is a bounce.
    const events = feedback.get(m.id) ?? [], hard = (m.o & OUTCOME.bounced) !== 0 || m.status === 'bounced';
    const validation = !hard && (m.status === 'suppressed' || events.some(e => e.type === 'validation_suppressed'));
    const ok = !hard && !validation && delivered(m);
    const soft = !ok && !validation && !hard && ((m.o & OUTCOME.delayed) !== 0 || m.status === 'delayed' || events.length > 0);
    const named = events.map(e => blocklistNamed(e.diagnostic)).find(Boolean);
    if (named) { const key = JSON.stringify([m.workspace_id, m.at.slice(0, 10), m.from_domain, m.link_host ?? '', named]); blocked.set(key, (blocked.get(key) ?? 0) + 1); }
    const domainKey = JSON.stringify([m.workspace_id, domainOf(m.rcpt!)]);
    const d = domains.get(domainKey) ?? { sent: 0, delivered: 0, hard: 0, soft: 0, complained: 0, opened: 0, clicked: 0, classes: Object.fromEntries(BOUNCE_CLASSES.map(c => [c, 0])) as Domain['classes'], failedSince: 0, first: m.at, last: m.at, lastDelivered: null };
    d.sent++; d.last = m.at;
    if (ok) { d.delivered++; d.lastDelivered = m.at; d.failedSince = 0; }
    if (hard || validation) { d.hard += hard ? 1 : 0; d.failedSince++; }
    if (soft) d.soft++;
    if (!ok && (hard || validation || soft)) {
      // The event that decided it: the permanent one for a bounce, else the last deferral or delay.
      const deciding = [...events].reverse().find(e => hard || validation ? e.type === 'bounce' || e.type === 'validation_suppressed' : true) ?? events.at(-1);
      d.classes[deciding ? bounceClass({ type: deciding.type, subType: deciding.sub_type, status: deciding.status, diagnostic: deciding.diagnostic }) : validation ? 'validation' : 'other']++;
    }
    if (m.o & OUTCOME.complained) d.complained++;
    if (m.o & OUTCOME.opened) d.opened++;
    if (m.o & OUTCOME.clicked) d.clicked++;
    domains.set(domainKey, d);
    if (!m.marketing) continue;
    const contactKey = JSON.stringify([m.workspace_id, m.rcpt]);
    const c = contacts.get(contactKey) ?? { mailed: 0, delivered: 0, first: m.at, last: m.at, soft: 0, reset: false };
    c.mailed++; c.last = m.at;
    if (ok) { c.delivered++; c.soft = 0; c.reset = true; } else if (soft) c.soft++;
    contacts.set(contactKey, c);
  }
  // Sums in a fixed order of keys (one writer, under the lease). Contacts are locked first in (workspace, email) order, the
  // order the dispatcher and SES feedback lock them in, so a page and a send never deadlock on two contacts.
  const ds = [...domains].sort(([a], [b]) => a < b ? -1 : 1).map(([key, d]) => ({ key: JSON.parse(key) as [string, string], d }));
  if (ds.length) await tx.execute(sql`INSERT INTO delivery_domain_stats AS s (workspace_id, domain, sent, delivered, hard_bounced, soft_failed, complained, opened, clicked,
      ${sql.raw(BOUNCE_CLASSES.join(', '))}, failed_since_delivery, first_seen, last_seen, last_delivered)
    SELECT * FROM unnest(${arr(ds.map(x => x.key[0]), 'text')}, ${arr(ds.map(x => x.key[1]), 'text')}, ${arr(ds.map(x => x.d.sent), 'bigint')}, ${arr(ds.map(x => x.d.delivered), 'bigint')},
      ${arr(ds.map(x => x.d.hard), 'bigint')}, ${arr(ds.map(x => x.d.soft), 'bigint')}, ${arr(ds.map(x => x.d.complained), 'bigint')}, ${arr(ds.map(x => x.d.opened), 'bigint')}, ${arr(ds.map(x => x.d.clicked), 'bigint')},
      ${sql.join(BOUNCE_CLASSES.map(c => arr(ds.map(x => x.d.classes[c]), 'bigint')), sql`, `)},
      ${arr(ds.map(x => x.d.failedSince), 'int')}, ${arr(ds.map(x => x.d.first), 'timestamptz')}, ${arr(ds.map(x => x.d.last), 'timestamptz')}, ${arr(ds.map(x => x.d.lastDelivered), 'timestamptz')})
    ON CONFLICT (workspace_id, domain) DO UPDATE SET sent=s.sent+excluded.sent, delivered=s.delivered+excluded.delivered, hard_bounced=s.hard_bounced+excluded.hard_bounced,
      soft_failed=s.soft_failed+excluded.soft_failed, complained=s.complained+excluded.complained, opened=s.opened+excluded.opened, clicked=s.clicked+excluded.clicked,
      ${sql.raw(BOUNCE_CLASSES.map(c => c + '=s.' + c + '+excluded.' + c).join(', '))},
      failed_since_delivery=CASE WHEN excluded.last_delivered IS NOT NULL THEN excluded.failed_since_delivery ELSE s.failed_since_delivery+excluded.failed_since_delivery END,
      first_seen=least(s.first_seen, excluded.first_seen), last_seen=greatest(s.last_seen, excluded.last_seen), last_delivered=greatest(s.last_delivered, excluded.last_delivered)`);
  const cs = [...contacts].sort(([a], [b]) => a < b ? -1 : 1).map(([key, c]) => ({ key: JSON.parse(key) as [string, string], c }));
  if (cs.length) await tx.execute(sql`SELECT 1 FROM audience_contacts c JOIN unnest(${arr(cs.map(x => x.key[0]), 'text')}, ${arr(cs.map(x => x.key[1]), 'text')}) AS u(w, email)
    ON c.workspace_id=u.w AND c.email=u.email ORDER BY c.workspace_id, c.email FOR UPDATE OF c`);
  if (cs.length) await tx.execute(sql`UPDATE audience_contacts c SET mailed_count=c.mailed_count+u.mailed, delivered_count=c.delivered_count+u.delivered,
      first_mailed_at=least(coalesce(c.first_mailed_at, u.first), u.first), last_mailed_at=greatest(c.last_mailed_at, u.last),
      soft_failures=CASE WHEN u.reset THEN u.soft ELSE least(c.soft_failures+u.soft, 32767) END
    FROM unnest(${arr(cs.map(x => x.key[0]), 'text')}, ${arr(cs.map(x => x.key[1]), 'text')}, ${arr(cs.map(x => x.c.mailed), 'int')}, ${arr(cs.map(x => x.c.delivered), 'int')},
      ${arr(cs.map(x => x.c.first), 'timestamptz')}, ${arr(cs.map(x => x.c.last), 'timestamptz')}, ${arr(cs.map(x => x.c.soft), 'int')}, ${arr(cs.map(x => x.c.reset), 'boolean')}) AS u(w, email, mailed, delivered, first, last, soft, reset)
    WHERE c.workspace_id=u.w AND c.email=u.email`);
  const bs = [...blocked].sort(([a], [b]) => a < b ? -1 : 1).map(([key, n]) => ({ key: JSON.parse(key) as [string, string, string, string, string], n }));
  if (bs.length) await tx.execute(sql`INSERT INTO delivery_blocklist_daily AS b (workspace_id, day, from_domain, link_host, list, rejections)
    SELECT * FROM unnest(${arr(bs.map(x => x.key[0]), 'text')}, ${arr(bs.map(x => x.key[1]), 'date')}, ${arr(bs.map(x => x.key[2]), 'text')}, ${arr(bs.map(x => x.key[3]), 'text')}, ${arr(bs.map(x => x.key[4]), 'text')}, ${arr(bs.map(x => x.n), 'int')})
    ON CONFLICT (workspace_id, day, from_domain, link_host, list) DO UPDATE SET rejections=b.rejections+excluded.rejections`);
  const last = mail.at(-1)!, next = { at: last.at, id: last.id };
  // Only while this run still holds the lease: a run that outlived it rolls its page back instead of counting it twice.
  const { rowCount } = await tx.execute(sql`UPDATE delivery_history_state SET cursor_at=${next.at}::timestamptz, cursor_id=${next.id}, updated_at=now()
    WHERE id='rollup' AND lease_until=${lease}::timestamptz AND lease_until > now()`);
  if (rowCount !== 1) throw new Error('DELIVERY_HISTORY_LEASE_LOST');
  return { read: mail.length, counted: counted.length, blocklisted: bs.reduce((n, x) => n + x.n, 0), cursor: next };
}

/**
 * The hourly rollup (maintenance.ts hourlyUpkeep): pages of finished mail until the budget ends or nothing waits. One run
 * at a time (the lease); a page that fails is rolled back and read again next run.
 */
export async function deliveryHistoryHourly(runtime: Pick<Runtime, 'db'>, options: { budgetMs?: number } = {}) {
  const started = Date.now(), deadline = started + Math.min(options.budgetMs ?? ROLLUP.budgetMs, ROLLUP.maxBudgetMs), result = { pages: 0, read: 0, counted: 0, blocklisted: 0 };
  const { rows: [state] } = await runtime.db.execute<{ at: string; id: string; lease: string }>(sql`INSERT INTO delivery_history_state AS s (id, cursor_at, cursor_id, lease_until)
      VALUES ('rollup', now() - make_interval(days => ${ROLLUP.backDays}), '', now() + ${ROLLUP.lease}::interval)
    ON CONFLICT (id) DO UPDATE SET lease_until=excluded.lease_until WHERE s.lease_until IS NULL OR s.lease_until <= now()
    RETURNING to_char(cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, coalesce(cursor_id, '') AS id, lease_until::text AS lease`);
  if (!state) { log('info', { code: 'DELIVERY_HISTORY_BUSY' }); return null; }
  let cursor = { at: state.at, id: state.id };
  try {
    while (Date.now() < deadline) {
      const page = await transaction(runtime.db, tx => foldPage(tx, cursor, state.lease));
      if (!page.read) break;
      cursor = page.cursor; result.pages++; result.read += page.read; result.counted += page.counted; result.blocklisted += page.blocklisted;
      if (page.read < ROLLUP.page) break;
    }
  } catch (error) {
    logError(error, { code: 'DELIVERY_HISTORY_PAGE_FAILED' }, 'warn');
  } finally {
    await runtime.db.execute(sql`UPDATE delivery_history_state SET lease_until=NULL WHERE id='rollup' AND lease_until=${state.lease}::timestamptz`);
  }
  log('info', { code: 'DELIVERY_HISTORY', ...result, cursor: cursor.at, ms: Date.now() - started });
  return { ...result, cursor: cursor.at };
}
