import { z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { log, logError, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { ALLOWED, buildLists, fetchSource, SOURCES, type BuiltLists, type FetchedSource } from './hygiene-sources.js';
import { resolveMailDomains, type MailDomain } from './mail-dns.js';

// List hygiene, at the front door. An address that looks like a spam trap or can't reach a person is flagged on its contact
// (audience_contacts.risk, migration 497) when the contact is created or imported, and the hourly pass below flags the
// contacts that were there before and follows the lists, the domain checks and new bounces. Campaigns and marketing sends
// skip a flagged contact unless its owner allowed it (risk_allowed); transactional mail is never refused, only warned about.
//  - invalid: not an address mail can be delivered to (the syntax campaign capture would refuse).
//  - typo_domain: one edit away from a large mailbox provider (gmial.com, hotmial.com, yahooo.com, gmail.con).
//  - disposable: a public temporary inbox on a listed domain or subdomain (src/hygiene-sources.ts).
//  - no_mail_domain: the domain can't receive mail: it doesn't exist, publishes a null MX, or has no MX and no address
//    (src/mail-dns.ts, cached a day per domain in hygiene_mail_domains, migration 509).
//  - role: an address that is never a subscriber (abuse@, postmaster@, noreply@): marketing there is reported.
//  - dead: hard-bounced in another workspace in the last year. A bounce in its own workspace suppresses it already.
export const RISKS = ['invalid', 'disposable', 'typo_domain', 'role', 'dead', 'no_mail_domain'] as const;
export type Risk = (typeof RISKS)[number];
export const RiskReason = z.enum(RISKS).describe('invalid: not a deliverable address. disposable: a public temporary inbox on a listed domain or subdomain. typo_domain: a mistyped mailbox provider (gmial.com). role: abuse@, postmaster@, noreply@ and the like. dead: known to be undeliverable (a recent permanent bounce). no_mail_domain: the domain can\'t receive mail (it doesn\'t exist, or has no mail server).');
export const RiskBreakdown = z.object({ total: z.number().int(), byReason: z.object(Object.fromEntries(RISKS.map(r => [r, z.number().int()])) as Record<Risk, z.ZodNumber>) }).openapi('RiskBreakdown');
/** Recipients of a send whose address alone looks risky: transactional mail goes anyway, with these in its receipt. */
export const RecipientWarning = z.object({ email: z.string(), risk: RiskReason.exclude(['dead', 'no_mail_domain']), suggestion: z.string().nullable() }).openapi('RecipientWarning');
/** Warnings for a send's recipients. No database read on the send path: the lists this isolate holds, else the floor. */
export function recipientWarnings(addresses: string[]) {
  const lists = peekHygieneLists();
  const warnings = addresses.flatMap(address => { const email = (/<([^<>]+)>\s*$/.exec(address)?.[1] ?? address).trim(), found = classifyAddress(email, lists); return found ? [{ email, risk: found.risk, suggestion: found.suggestion }] : []; });
  return warnings.length ? { warnings } : {};
}
/** Bump when a rule changes: with the lists' own version, a new one reclassifies every contact. */
const RULES = 3;

const ADDRESS = /^(?!\.)(?!.*\.\.)[a-z0-9_'+.\-]*[a-z0-9_+\-]@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9][a-z0-9-]*[a-z0-9])$/i;
/** The address syntax createContact accepts (mailAddress in outbound-content.ts), without a schema: the import preview and
 *  the hourly pass run it on every row. */
export function validAddress(email: string): boolean {
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !ADDRESS.test(email)) return false;
  const at = email.indexOf('@');
  if (at > 64) return false;
  let start = at + 1;
  for (;;) {
    const dot = email.indexOf('.', start), end = dot < 0 ? email.length : dot;
    if (end - start > 63) return false;
    if (dot < 0) return true;
    start = dot + 1;
  }
}

// Providers anyone can sign up with (abuse.ts compares addresses with it too).
export const PUBLIC_MAILBOXES = new Set(`gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com rocketmail.com icloud.com me.com mac.com
  aol.com proton.me protonmail.com pm.me gmx.com gmx.net gmx.de web.de mail.com zoho.com zohomail.com yandex.com yandex.ru mail.ru qq.com 163.com 126.com sina.com
  fastmail.com fastmail.fm hey.com tutanota.com tuta.io tuta.com tutamail.com duck.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es outlook.fr outlook.de
  outlook.es outlook.it live.co.uk live.fr yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.co.jp yahoo.co.in yahoo.com.br yahoo.ca comcast.net verizon.net
  att.net sbcglobal.net cox.net orange.fr free.fr laposte.net t-online.de libero.it naver.com daum.net seznam.cz wp.pl o2.pl btinternet.com sky.com`.split(/\s+/));

// ----- The lists -----------------------------------------------------------------------------------------------------------
// The nightly sync's lists (hygiene_lists 'built'), else the vendored snapshot (src/hygiene-snapshot.ts, only imported then).
// Held per isolate and checked against the stored version every ten minutes: a sorted string and its line offsets (about
// 2 MB for 110,000 domains), searched by halving, not a Set of them.
export type HygieneLists = { version: string; source: 'synced' | 'snapshot'; isDisposable(domain: string): boolean; providers: Set<string>; roles: string[] };
function sortedLines(body: string) {
  const starts: number[] = [];
  if (body) { starts.push(0); for (let i = body.indexOf('\n'); i >= 0; i = body.indexOf('\n', i + 1)) starts.push(i + 1); }
  const offsets = Uint32Array.from(starts), line = (i: number) => body.slice(offsets[i]!, i + 1 < offsets.length ? offsets[i + 1]! - 1 : body.length);
  return (name: string) => {
    let lo = 0, hi = offsets.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1, at = line(mid); if (at === name) return true; if (at < name) lo = mid + 1; else hi = mid - 1; }
    return false;
  };
}
export function makeLists(built: Pick<BuiltLists, 'version' | 'disposable' | 'providers' | 'roles'>, source: HygieneLists['source']): HygieneLists {
  const has = sortedLines(built.disposable);
  return { version: built.version, source, providers: new Set(built.providers), roles: built.roles,
    // A domain or one it is under (sub.mailinator.com), never one the allowlist names.
    isDisposable: domain => { for (let name = domain.toLowerCase(); name.includes('.'); name = name.slice(name.indexOf('.') + 1)) { if (ALLOWED.has(name)) return false; if (has(name)) return true; } return false; } };
}
let held: { lists: HygieneLists; checkedAt: number } | undefined, loading: Promise<HygieneLists> | undefined;
const LISTS_CHECK_MS = 10 * 60_000;
/** The lists this isolate already holds, without reading anything: for the send path and sign-ins. */
export const peekHygieneLists = () => held?.lists ?? null;
export function hygieneLists(db: DbExecutor): Promise<HygieneLists> {
  if (held && Date.now() - held.checkedAt < LISTS_CHECK_MS) return Promise.resolve(held.lists);
  return loading ??= (async () => {
    try {
      const [current] = (await db.execute<{ version: string }>(sql`SELECT version FROM hygiene_lists WHERE name = 'built'`)).rows;
      if (held && (current?.version ?? null) === (held.lists.source === 'synced' ? held.lists.version : null)) { held.checkedAt = Date.now(); return held.lists; }
      if (current) {
        const [row] = (await db.execute<{ version: string; body: string; meta: { providers: string[]; roles: string[] } }>(sql`SELECT version, body, meta FROM hygiene_lists WHERE name = 'built'`)).rows;
        if (row) { held = { lists: makeLists({ version: row.version, disposable: row.body, ...row.meta }, 'synced'), checkedAt: Date.now() }; return held.lists; }
      }
      const { HYGIENE_SNAPSHOT } = await import('./hygiene-snapshot.js');
      held = { lists: makeLists(HYGIENE_SNAPSHOT, 'snapshot'), checkedAt: Date.now() };
      return held.lists;
    } finally { loading = undefined; }
  })();
}
/** For tests: forget what this isolate holds. */
export function forgetHygieneLists() { held = undefined; }

// Without lists (a send, a sign-in, before this isolate loaded them): the services most seen in imports and sign-ups.
const FLOOR = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org guerrillamail.biz guerrillamailblock.com sharklasers.com grr.la
  pokemail.net spam4.me 10minutemail.com 10minutemail.net tempmail.com temp-mail.org temp-mail.io tempmail.net tempmail.dev tempmailo.com tempail.com tempr.email
  tmpmail.org tmpmail.net yopmail.com yopmail.fr yopmail.net trashmail.com trashmail.net trashmail.de getnada.com nada.email dispostable.com maildrop.cc
  throwawaymail.com fakeinbox.com mohmal.com emailondeck.com mintemail.com mytemp.email mailnesia.com moakt.com 1secmail.com 1secmail.org 1secmail.net
  discard.email mailsac.com harakirimail.com emailfake.com generator.email minuteinbox.com mail.tm mail.gw dropmail.me fexpost.com fexbox.org fextemp.com
  mailto.plus merepost.com rover.info uberip.com maxxspace.com`.split(/\s+/));
/** Disposable by the lists this isolate holds, else the floor: for callers that can't read the database. */
export const isKnownDisposable = (domain: string) => { const lists = peekHygieneLists(); return lists ? lists.isDisposable(domain) : FLOOR.has(domain.toLowerCase()); };

// ----- Address rules -------------------------------------------------------------------------------------------------------
// The large providers whose names people mistype: a domain one edit from the name (gmial.com, yahooo.com, hotmial.co.uk)
// is a typo of it. Smaller providers' names are close to real companies' (naver.com, never.com), so only these.
const TYPO_NAMES = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'comcast.net', 'protonmail.com', 'sbcglobal.net',
  'btinternet.com', 'rocketmail.com', 'bellsouth.net', 'hotmail.co.uk', 'yahoo.co.uk'];
// A provider's own name under a suffix one edit from its own (gmail.con, hotmail.co, aol.cm, comcast.ner).
const TYPO_SUFFIXES = [...TYPO_NAMES, 'aol.com', 'live.com', 'msn.com', 'ymail.com', 'me.com', 'mac.com', 'att.net', 'verizon.net', 'cox.net', 'charter.net',
  'earthlink.net', 'juno.com', 'qq.com', '163.com', '126.com', 'mail.com', 'gmx.com', 'gmx.net', 'live.co.uk'];
// Real domains one edit from those, never typos.
const NOT_TYPOS = ['mail.com', 'email.com', 'ymail.com', 'gmx.com', 'cloud.com', 'wahoo.com', 'hotmail.co.jp', 'live.co.uk', 'live.co.za', 'yahoo.co.in', 'yahoo.co.jp'];
const EDIT = 'abcdefghijklmnopqrstuvwxyz0123456789-';
function oneEdit(word: string) {
  const out = new Set<string>();
  for (let i = 0; i <= word.length; i++) {
    for (const c of EDIT) out.add(word.slice(0, i) + c + word.slice(i));
    if (i === word.length) break;
    out.add(word.slice(0, i) + word.slice(i + 1));
    for (const c of EDIT) out.add(word.slice(0, i) + c + word.slice(i + 1));
    if (i + 1 < word.length) out.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  out.delete(word);
  return [...out].filter(v => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(v) && !v.includes('..'));
}
let typos: Map<string, string> | undefined;
function typoOf(domain: string) {
  if (!typos) {
    const map = new Map<string, string>(), split = (d: string) => [d.slice(0, d.indexOf('.')), d.slice(d.indexOf('.') + 1)] as const;
    for (const target of TYPO_NAMES) { const [name, suffix] = split(target); for (const v of oneEdit(name)) if (!map.has(`${v}.${suffix}`)) map.set(`${v}.${suffix}`, target); }
    for (const target of TYPO_SUFFIXES) { const [name, suffix] = split(target); for (const v of oneEdit(suffix)) if (!map.has(`${name}.${v}`)) map.set(`${name}.${v}`, target); }
    for (const real of [...PUBLIC_MAILBOXES, ...TYPO_SUFFIXES, ...NOT_TYPOS]) map.delete(real);
    typos = map;
  }
  return typos.get(domain) ?? null;
}

// RFC 2142 and no-reply mailboxes: nobody subscribes from them, and mail there reaches the people who report abuse. The
// synced role list (info@, sales@, …) is the soft tier: it counts in list statistics (deliverability.ts), never as a risk.
const ROLES = new Set('abuse postmaster hostmaster mailer-daemon noc noreply no-reply no_reply donotreply do-not-reply do_not_reply nobody devnull spam usenet uucp unsubscribe list-request'.split(' '));

export type Classified = { risk: Exclude<Risk, 'dead' | 'no_mail_domain'>; suggestion: string | null };
/** What the address says, by the rules and the lists (null: the floor). The domain's DNS and dead need the database. */
export function classifyAddress(email: string, lists: Pick<HygieneLists, 'isDisposable'> | null): Classified | null {
  if (!validAddress(email)) return { risk: 'invalid', suggestion: null };
  const at = email.lastIndexOf('@'), local = email.slice(0, at), domain = email.slice(at + 1).toLowerCase();
  // A provider's typo first, with the address it meant: the lists carry some of them (gmial.com), set up to catch it.
  const fix = typoOf(domain);
  if (fix) return { risk: 'typo_domain', suggestion: `${local}@${fix}` };
  if (lists ? lists.isDisposable(domain) : FLOOR.has(domain)) return { risk: 'disposable', suggestion: null };
  const plus = local.indexOf('+'), mailbox = (plus > 0 ? local.slice(0, plus) : local).toLowerCase();
  if (ROLES.has(mailbox)) return { risk: 'role', suggestion: null };
  return null;
}
/** The address's domain, lowercased. */
export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
/** The stronger of what the address says and what its domain says: a domain that can't receive mail outranks a role name. */
export const combinedRisk = (own: Classified | null, domain: DomainRisk | undefined): Exclude<Risk, 'dead'> | null =>
  own && own.risk !== 'role' ? own.risk : domain ?? own?.risk ?? null;

/** An address that hard-bounced in another workspace in the last year (migration 498's partial index). */
export const bouncedElsewhere = (email: SQL, workspaceId: SQL) => sql`EXISTS (SELECT 1 FROM audience_contacts b WHERE b.email = ${email} AND b.suppressed
  AND b.suppression_reason = 'hard_bounce' AND b.workspace_id <> ${workspaceId} AND b.suppressed_at > now() - interval '365 days')`;
/** A new contact's stored risk when its domain isn't checked here (an unsubscribe, the sign-ups list): the address, else
 *  dead. The hourly pass and the resolver add the domain's verdict. */
export const staticRiskSql = (email: string, workspaceId: string, lists: HygieneLists | null) => {
  const own = classifyAddress(email, lists);
  return own ? sql`${own.risk}::text` : sql`CASE WHEN ${bouncedElsewhere(sql`${email}::text`, sql`${workspaceId}::text`)} THEN 'dead' END`;
};
/** A new contact's stored risk, its domain checked now (from the cache, or DNS within budgetMs). */
export async function riskFor(runtime: Pick<Runtime, 'db' | 'config'>, email: string, workspaceId: string, budgetMs = 1_500): Promise<SQL> {
  const lists = await hygieneLists(runtime.db), own = classifyAddress(email, lists), domain = domainOf(email);
  const risk = combinedRisk(own, own && own.risk !== 'role' ? undefined : (await domainRisks(runtime, lists, [domain], Date.now() + budgetMs)).get(domain));
  return risk ? sql`${risk}::text` : sql`CASE WHEN ${bouncedElsewhere(sql`${email}::text`, sql`${workspaceId}::text`)} THEN 'dead' END`;
}
/** A contact campaigns and marketing sends skip: flagged, and not allowed by its owner. */
export const skippedRisk = (risk: SQL, allowed: SQL) => sql`(${risk} IS NOT NULL AND NOT ${allowed})`;

/** The contact's risk as the API shows it. */
export function contactRisk(row: { email: string; risk: string | null; riskAllowed: boolean }) {
  if (!row.risk || !(RISKS as readonly string[]).includes(row.risk)) return null;
  const reason = row.risk as Risk;
  return { reason, suggestion: reason === 'typo_domain' ? classifyAddress(row.email, null)?.suggestion ?? null : null, allowed: row.riskAllowed };
}
export type RiskCounts = Record<Risk, number>;
export const noRisks = (): RiskCounts => ({ invalid: 0, disposable: 0, typo_domain: 0, role: 0, dead: 0, no_mail_domain: 0 });
/** Counts by reason, from rows of (risk, count). */
export function riskCounts(rows: { risk: string | null; count: number }[]) {
  const byReason = noRisks();
  let total = 0;
  for (const row of rows) if (row.risk && row.risk in byReason) { byReason[row.risk as Risk] += Number(row.count); total += Number(row.count); }
  return { total, byReason };
}

// ----- Domains ---------------------------------------------------------------------------------------------------------------
// Each recipient domain's mail verdict (src/mail-dns.ts), cached in hygiene_mail_domains a day at a time. A domain not
// checked yet, or checked more than a day ago, is looked up now when there is time (a contact created, an import previewed),
// and otherwise left 'pending' for the resolver below. Providers on the lists are never looked up. Never per address.
export type DomainRisk = 'no_mail_domain';
const DOMAIN = { freshHours: 24, unknownRetryMinutes: 60, keepDays: 90, concurrency: 24 } as const;
type DomainRow = { domain: string; verdict: 'pending' | MailDomain['verdict']; mx: string[]; fresh: boolean };
const riskOfDomain = (row: Pick<DomainRow, 'verdict'> | undefined): DomainRisk | undefined =>
  row?.verdict === 'no_mail' ? 'no_mail_domain' : undefined;
const checkable = (lists: HygieneLists, domain: string) => !lists.providers.has(domain) && !ALLOWED.has(domain) && !PUBLIC_MAILBOXES.has(domain);
/** The verdicts of these domains (\`deadline\` in the past: only what is cached), storing what was looked up and queueing the rest. */
export async function domainRisks(runtime: Pick<Runtime, 'db' | 'config'>, lists: HygieneLists, domains: Iterable<string>, deadline: number): Promise<Map<string, DomainRisk>> {
  const out = new Map<string, DomainRisk>(), url = runtime.config.hygieneDnsUrl;
  const wanted = [...new Set(domains)].filter(d => checkable(lists, d));
  if (!url || !wanted.length) return out;
  const { rows } = await runtime.db.execute<DomainRow>(sql`SELECT domain, verdict, mx, coalesce(checked_at > now() - make_interval(hours => ${DOMAIN.freshHours}), false) AS fresh
    FROM hygiene_mail_domains WHERE domain = ANY(${sql.param(wanted)}::text[])`);
  const known = new Map(rows.map(r => [r.domain, r]));
  const due = wanted.filter(d => !known.get(d)?.fresh);
  const looked = due.length && deadline > Date.now() ? await resolveMailDomains(url, due, deadline, DOMAIN.concurrency) : new Map<string, MailDomain>();
  if (looked.size) await storeVerdicts(runtime.db, lists, looked);
  const queued = due.filter(d => !looked.has(d) && !known.has(d));
  if (queued.length) {
    await runtime.db.execute(sql`INSERT INTO hygiene_mail_domains (domain) SELECT unnest(${sql.param(queued)}::text[]) ON CONFLICT (domain) DO NOTHING`);
    await wakeResolver(runtime.db);
  }
  for (const d of wanted) { const risk = riskOfDomain(looked.get(d) ?? known.get(d)); if (risk) out.set(d, risk); }
  return out;
}
async function storeVerdicts(db: DbExecutor, lists: HygieneLists, looked: Map<string, MailDomain>) {
  const rows = [...looked].map(([domain, v]) => ({ domain, verdict: v.verdict, detail: v.detail, mx: v.mx, listed: lists.isDisposable(domain) }));
  await db.execute(sql`INSERT INTO hygiene_mail_domains AS h (domain, verdict, detail, mx, listed, checked_at, requested_at)
    SELECT r.domain, r.verdict, r.detail, coalesce(ARRAY(SELECT jsonb_array_elements_text(r.mx)), '{}'), r.listed, now(), now()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(domain text, verdict text, detail text, mx jsonb, listed boolean)
    ON CONFLICT (domain) DO UPDATE SET verdict = excluded.verdict, detail = excluded.detail, mx = excluded.mx, listed = excluded.listed,
      checked_at = excluded.checked_at, requested_at = excluded.requested_at`);
}
// One resolver run queued at a time, through the shared schedule row (job_schedule), as the other maintenance jobs elect.
async function wakeResolver(db: DbExecutor) {
  await db.execute(sql`WITH elected AS (INSERT INTO job_schedule (workspace_id, next_wake_at) VALUES ('maintenance:hygiene-domains', now() + interval '1 minute')
      ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at = excluded.next_wake_at WHERE job_schedule.next_wake_at <= now() RETURNING 1)
    INSERT INTO jobs (id, workspace_id, type, payload) SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), 'platform', 'hygiene.resolveDomains', '{}'::jsonb FROM elected`);
}
/**
 * The resolver: pending domains (and ones whose last lookup failed an hour ago or more), oldest first, within the budget.
 * A domain that can't receive mail flags its contacts that aren't flagged
 * for something stronger, at once: found by the email search index (migration 462). Returns how many it looked up.
 */
export async function resolvePendingDomains(runtime: Pick<Runtime, 'db' | 'config'>, budgetMs = 30_000) {
  const url = runtime.config.hygieneDnsUrl;
  if (!url) return { looked: 0, flagged: 0, more: false };
  const deadline = Date.now() + budgetMs, lists = await hygieneLists(runtime.db);
  // Claimed by moving their request time past the run, so a second runner takes others.
  const { rows } = await runtime.db.execute<{ domain: string }>(sql`UPDATE hygiene_mail_domains SET requested_at = now() + make_interval(secs => ${Math.ceil(budgetMs / 1000) + 60})
    WHERE domain IN (SELECT domain FROM hygiene_mail_domains WHERE (verdict = 'pending' AND requested_at <= now())
      OR (verdict = 'unknown' AND requested_at <= now() - make_interval(mins => ${DOMAIN.unknownRetryMinutes})) ORDER BY requested_at LIMIT 2000 FOR UPDATE SKIP LOCKED)
    RETURNING domain`);
  const looked = await resolveMailDomains(url, rows.map(r => r.domain), deadline, 32);
  if (looked.size) await storeVerdicts(runtime.db, lists, looked);
  const left = rows.filter(r => !looked.has(r.domain)).map(r => r.domain);
  if (left.length) await runtime.db.execute(sql`UPDATE hygiene_mail_domains SET requested_at = now() WHERE domain = ANY(${sql.param(left)}::text[]) AND verdict = 'pending'`);
  let flagged = 0;
  for (const [domain, verdict] of looked) {
    const risk = riskOfDomain(verdict);
    if (!risk) continue;
    const moved = await runtime.db.execute(sql`UPDATE audience_contacts SET risk = ${risk}, risk_allowed = false
      WHERE lower(email) LIKE ('%@' || ${domain}) AND deleted_at IS NULL AND (risk IS NULL OR risk IN ('role', 'dead'))`);
    flagged += moved.rowCount ?? 0;
  }
  await runtime.db.execute(sql`DELETE FROM hygiene_mail_domains WHERE domain IN (SELECT domain FROM hygiene_mail_domains WHERE checked_at < now() - make_interval(days => ${DOMAIN.keepDays}) LIMIT 1000)`);
  const [more] = (await runtime.db.execute<{ more: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM hygiene_mail_domains WHERE verdict = 'pending' AND requested_at <= now()) AS more`)).rows;
  if (looked.size) log('info', { code: 'HYGIENE_DOMAINS_RESOLVED', looked: looked.size, flagged, more: more!.more });
  return { looked: looked.size, flagged, more: more!.more };
}
/** The queued resolver: runs while domains are pending, about twelve seconds a turn. */
export const resolveDomainsJob: JobHandler = async runtime => {
  const run = await resolvePendingDomains(runtime, 12_000);
  if (run.more) throw new (await import('./jobs.js')).JobDeferred(new Date(Date.now() + 1_000).toISOString());
};

// ----- The nightly sync ------------------------------------------------------------------------------------------------------
// Once a day (elected through job_schedule), from the hourly upkeep: each source fetched and checked (fetchSource), its last
// good copy kept (hygiene_lists 'source:<name>'), and the lists rebuilt from the copies. A source that has never been
// fetched is covered by the vendored snapshot's union. A new version reclassifies everyone.
// A day's change to the built lists is bounded. An upstream that suddenly lists thousands more domains, drops real
// providers (which is what keeps them off the disposable union) is treated as broken or
// poisoned: the last built lists stay, with an error to look at, until an operator accepts the change (acceptChange).
const SYNC_CAP = { added: 2_000, addedShare: 0.02, droppedProviders: 25, droppedShare: 0.01 } as const;
export async function syncHygieneLists(runtime: Pick<Runtime, 'db' | 'config'>, fetcher: typeof fetch = fetch, force = false, acceptChange = false) {
  if (!runtime.config.hygieneLists) return null;
  const db = runtime.db;
  const [elected] = (await db.execute<{ ok: number }>(sql`INSERT INTO job_schedule (workspace_id, next_wake_at) VALUES ('maintenance:hygiene-lists', now() + interval '1 day')
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at = excluded.next_wake_at WHERE job_schedule.next_wake_at <= now() OR ${force}
      OR NOT EXISTS (SELECT 1 FROM hygiene_lists WHERE name = 'built') RETURNING 1 AS ok`)).rows;
  if (!elected) return null;
  // Each source's last good copy: its count to check a new one against; the copy itself only read for a source that fails.
  const stored = new Map((await db.execute<{ name: string; meta: { count: number; sha256: string; fetchedAt: string; mx?: string[] } }>(sql`SELECT name, meta FROM hygiene_lists WHERE name LIKE 'source:%'`)).rows
    .map(r => [r.name.slice('source:'.length), r]));
  const copies: FetchedSource[] = [], failed: { name: string; error: string }[] = [];
  for (const source of SOURCES) {
    const previous = stored.get(source.name);
    try {
      const got = await fetchSource(source, previous?.meta.count ?? null, fetcher);
      await db.execute(sql`INSERT INTO hygiene_lists (name, version, body, meta, updated_at) VALUES (${`source:${source.name}`}, ${got.sha256}, ${got.entries.join('\n')},
          ${JSON.stringify({ count: got.entries.length, sha256: got.sha256, fetchedAt: got.fetchedAt, bytes: got.bytes, license: source.license, repository: source.repository, ...got.mx ? { mx: got.mx } : {} })}::jsonb, now())
        ON CONFLICT (name) DO UPDATE SET version = excluded.version, body = excluded.body, meta = excluded.meta, updated_at = now()`);
      copies.push(got);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : 'failed';
      failed.push({ name: source.name, error: message });
      log('warn', { code: 'HYGIENE_SOURCE_FAILED', source: source.name, error: message, kept: !!previous });
      if (previous) {
        const [kept] = (await db.execute<{ body: string }>(sql`SELECT body FROM hygiene_lists WHERE name = ${`source:${source.name}`}`)).rows;
        copies.push({ name: source.name, entries: kept?.body ? kept.body.split('\n') : [], mx: previous.meta.mx, sha256: previous.meta.sha256, bytes: 0, fetchedAt: previous.meta.fetchedAt });
      }
    }
  }
  // The snapshot's providers stay on the allowlist for good: a providers source that drops a real provider (or is emptied)
  // never puts it on the disposable list. A source never fetched is covered by the snapshot's union.
  const { HYGIENE_SNAPSHOT } = await import('./hygiene-snapshot.js');
  const missing = SOURCES.filter(s => !copies.some(c => c.name === s.name));
  if (missing.length) {
    copies.push({ name: missing.find(s => s.kind === 'disposable')?.name ?? missing[0]!.name, entries: HYGIENE_SNAPSHOT.disposable.split('\n'), sha256: HYGIENE_SNAPSHOT.version, bytes: 0, fetchedAt: HYGIENE_SNAPSHOT.builtAt });
    for (const s of missing.filter(s => s.kind !== 'disposable')) copies.push({ name: s.name, entries: s.kind === 'roles' ? HYGIENE_SNAPSHOT.roles : HYGIENE_SNAPSHOT.providers,
      ...s.kind === 'providers' ? { mx: HYGIENE_SNAPSHOT.providerMx } : {}, sha256: HYGIENE_SNAPSHOT.version, bytes: 0, fetchedAt: HYGIENE_SNAPSHOT.builtAt });
  }
  const built = buildLists(copies, HYGIENE_SNAPSHOT.providers);
  const version = built.version;
  const [prev] = (await db.execute<{ version: string; body: string; meta: { providers?: string[] } }>(sql`SELECT version, body, meta FROM hygiene_lists WHERE name = 'built'`)).rows;
  if (prev && prev.version !== version && !acceptChange) {
    const had = new Set(prev.body ? prev.body.split('\n') : []), providers = new Set(built.providers);
    const added = (built.disposable ? built.disposable.split('\n') : []).filter(d => !had.has(d)).length;
    const dropped = (prev.meta.providers ?? []).filter(p => !providers.has(p));
    const over = [
      added > Math.max(SYNC_CAP.added, had.size * SYNC_CAP.addedShare) ? `${added} disposable domains added` : null,
      dropped.length > Math.max(SYNC_CAP.droppedProviders, (prev.meta.providers?.length ?? 0) * SYNC_CAP.droppedShare) ? `${dropped.length} providers dropped (${dropped.slice(0, 5).join(', ')})` : null,
    ].filter((x): x is string => x !== null);
    if (over.length) {
      const error = `refused, over a day's change: ${over.join('; ')}`;
      log('error', { code: 'HYGIENE_LISTS_CHANGE_REFUSED', kept: prev.version, refused: version, error, failed: failed.map(f => f.name) });
      return { version: prev.version, failed: [...failed, { name: 'built', error }] };
    }
  }
  await db.execute(sql`INSERT INTO hygiene_lists (name, version, body, meta, updated_at) VALUES ('built', ${version}, ${built.disposable},
      ${JSON.stringify({ providers: built.providers, roles: built.roles, sources: built.sources, failed, builtAt: built.builtAt })}::jsonb, now())
    ON CONFLICT (name) DO UPDATE SET version = excluded.version, body = excluded.body, meta = excluded.meta, updated_at = now() WHERE hygiene_lists.version IS DISTINCT FROM excluded.version`);
  log(failed.length ? 'warn' : 'info', { code: 'HYGIENE_LISTS_SYNCED', version, disposable: built.disposable ? built.disposable.split('\n').length : 0, providers: built.providers.length, roles: built.roles.length, failed: failed.map(f => f.name) });
  return { version, failed };
}

// ----- The hourly pass ---------------------------------------------------------------------------------------------------
// Every contact, in ID order across workspaces, a bounded slice an hour: a contact created before this existed, one whose
// address another workspace has since hard-bounced, and every contact again when the lists or a rule change (their
// version). Domains it hasn't checked are queued for the resolver, never looked up here; the resolver flags their contacts.
// A full pass starts again a day after the last one finished. Only changed rows are written, risk alone: a contact's
// updated_at is its owner's edits. A row another statement holds is skipped until the next pass, so the pass never waits
// on an import or the feedback batch, and a changed risk clears its owner's allowance (it was for another reason).
const PASS = { batch: 5000, leaseMinutes: 10, statementSeconds: 15, everyHours: 24 } as const;
export async function classifyContacts(runtime: Pick<Runtime, 'db' | 'config'>, budgetMs = 45_000, clock = Date.now) {
  const until = clock() + budgetMs, db = runtime.db, lists = await hygieneLists(db), version = `${lists.version}.${RULES}`;
  const restart = sql`s.version IS DISTINCT FROM excluded.version OR (s.cursor IS NULL AND s.finished_at < now() - make_interval(hours => ${PASS.everyHours}))`;
  const { rows: [state] } = await db.execute<{ cursor: string | null }>(sql`INSERT INTO audience_hygiene_state AS s (id, version, cursor, started_at, lease_until)
    VALUES ('contacts', ${version}, '', now(), now() + make_interval(mins => ${PASS.leaseMinutes}))
    ON CONFLICT (id) DO UPDATE SET lease_until = excluded.lease_until, version = excluded.version,
      cursor = CASE WHEN ${restart} THEN '' ELSE s.cursor END, started_at = CASE WHEN ${restart} THEN now() ELSE s.started_at END
    WHERE s.lease_until IS NULL OR s.lease_until <= now()
    RETURNING cursor`);
  if (!state) return null;
  let cursor = state.cursor, read = 0, changed = 0, skipped = 0;
  try {
    while (cursor !== null && clock() < until) {
      const after = cursor;
      const step = await db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${PASS.statementSeconds}s'`));
        const { rows } = await tx.execute<{ id: string; workspace_id: string; email: string; risk: string | null; dead: boolean }>(sql`SELECT c.id, c.workspace_id, c.email, c.risk,
            ${bouncedElsewhere(sql`c.email`, sql`c.workspace_id`)} AS dead
          FROM audience_contacts c WHERE c.id > ${after} AND c.deleted_at IS NULL ORDER BY c.id LIMIT ${PASS.batch}`);
        const own = rows.map(row => classifyAddress(row.email, lists));
        const domains = await domainRisks({ db: tx, config: runtime.config }, lists, rows.filter((_, i) => !own[i] || own[i]!.risk === 'role').map(r => domainOf(r.email)), 0);
        const changes = rows.flatMap((row, i) => {
          const risk = combinedRisk(own[i]!, domains.get(domainOf(row.email))) ?? (row.dead ? 'dead' : null);
          return risk === row.risk ? [] : [{ id: row.id, workspace_id: row.workspace_id, old: row.risk, risk }];
        });
        let written = 0;
        if (changes.length) {
          const result = await tx.execute(sql`WITH want AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS w(id text, workspace_id text, old text, risk text)),
            locked AS (SELECT t.workspace_id, t.id, w.risk FROM audience_contacts t JOIN want w ON t.workspace_id = w.workspace_id AND t.id = w.id
              WHERE t.risk IS NOT DISTINCT FROM w.old AND t.deleted_at IS NULL FOR UPDATE OF t SKIP LOCKED)
            UPDATE audience_contacts t SET risk = l.risk, risk_allowed = false FROM locked l WHERE t.workspace_id = l.workspace_id AND t.id = l.id`);
          written = result.rowCount ?? 0;
        }
        const next = rows.length < PASS.batch ? null : rows[rows.length - 1]!.id;
        await tx.execute(next === null
          ? sql`UPDATE audience_hygiene_state SET cursor = NULL, finished_at = now() WHERE id = 'contacts'`
          : sql`UPDATE audience_hygiene_state SET cursor = ${next} WHERE id = 'contacts'`);
        return { next, read: rows.length, changes: changes.length, written };
      });
      cursor = step.next; read += step.read; changed += step.written; skipped += step.changes - step.written;
    }
  } catch (error) {
    logError(error, { code: 'AUDIENCE_HYGIENE_FAILED' }, 'warn');
  } finally {
    await db.execute(sql`UPDATE audience_hygiene_state SET lease_until = NULL WHERE id = 'contacts'`).catch(() => {});
  }
  if (read) log('info', { code: 'AUDIENCE_HYGIENE_PASS', version, lists: lists.source, read, changed, skipped, finished: cursor === null });
  return { read, changed, skipped, finished: cursor === null };
}
