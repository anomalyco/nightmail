import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { id } from './core/http.js';
import { log } from './log.js';
import type { Config, Database, DbExecutor, JobHandler, Runtime } from './core/types.js';
import { productName } from './brand.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import type { ListContactResult } from './audience.js';

// The sign-up limit (hosted, migration 404): how many accounts may sign up on their own, set by an operator at
// Operator → Sign-ups (src/operator.ts). A place is taken by an account that signed up (nightmail_signups, one row per
// account, written in the transaction that creates it) or held for a waiting address an operator's raise let in
// (nightmail_waitlist.let_in_at). The sign-in gate, the operator's count and a raise all read `places` below, so the
// number an operator sees is the number the gate keeps. Staff, invitations and subjects an operator bound take none.

export type Places = { limit: number; signedUp: number; held: number; waiting: number; open: number };
/** The limit and what fills it, as one row (Glass reads it inside its own statement). Open is worked out from it. */
export const placesRow = sql`SELECT l.places AS "limit",(SELECT count(*)::int FROM nightmail_signups) AS "signedUp",
    (SELECT count(*)::int FROM nightmail_waitlist WHERE let_in_at IS NOT NULL) AS held,(SELECT count(*)::int FROM nightmail_waitlist WHERE let_in_at IS NULL) AS waiting
    FROM nightmail_signup_limit l WHERE l.singleton`;
export const withOpen = (row: Omit<Places, 'open'>): Places => ({ ...row, open: Math.max(0, row.limit - row.signedUp - row.held) });
/** The limit and what fills it, in one statement. Open: places left for anyone, after those held for the waitlist. */
export async function readPlaces(db: DbExecutor): Promise<Places> {
  const { rows: [row] } = await db.execute<Omit<Places, 'open'>>(placesRow);
  return withOpen(row!);
}
// One sign-up or one change of the limit at a time. Read the places in a later statement: under READ COMMITTED each
// statement sees what the previous holder committed.
const lockLimit = (db: DbExecutor) => db.execute(sql`SELECT FROM nightmail_signup_limit WHERE singleton FOR UPDATE`);

type Waited = { name: string | null; attempts: number; first_at: string; let_in_at: string | null };
export type Place = { via: 'waitlist' | 'open'; mailbox: string; waited: Waited | null };
/**
 * Whether a new account may sign up on its own, decided in the transaction that creates it (account-login.ts).
 * `addresses`: what the sign-in shows of its person's address, in order of preference, never an asserted address: the
 * mailbox it proves (account-policy.ts provenMailbox), the address a sign-in link it followed was emailed to, and the
 * GitHub account's verified primary address (githubVerifiedAddress). A place held for any of them is taken first,
 * otherwise an open one for the first. Either way the address leaves the waitlist here, and what its row said comes back
 * for recordSignup; a sign-in refused after all rolls the transaction back with the row. When any of them is already a
 * verified user's, or already took a place, it takes none: one place per person, and one per address. The caller
 * records the place once the user row exists.
 */
export async function takePlace(db: DbExecutor, addresses: (string | null)[]): Promise<Place | null> {
  await lockLimit(db);
  const shown = [...new Set(addresses.flatMap(address => address ? [address.toLowerCase()] : []))];
  if (!shown.length) return null;
  if ((await db.execute(sql`SELECT FROM unnest(${sql.param(shown)}::text[]) a WHERE EXISTS (SELECT FROM nightmail_users WHERE email_verified AND lower(email)=a)
    OR EXISTS (SELECT FROM nightmail_signups WHERE email=a)`)).rowCount) return null;
  const evidence = sql`name,attempts,first_at::text,let_in_at::text`;
  for (const address of shown) {
    const { rows: [waited] } = await db.execute<Waited>(sql`DELETE FROM nightmail_waitlist WHERE email=${address} AND let_in_at IS NOT NULL RETURNING ${evidence}`);
    if (waited) return { via: 'waitlist', mailbox: address, waited };
  }
  const address = shown[0]!;
  // As on dev, a closed gate never takes an unheld waitlist row lock while holding the installation's limit lock.
  // If a place is open, consume any waiting evidence in the statement already checking capacity.
  const { rows: [free] } = await db.execute<{ waited: Waited | null }>(sql`WITH capacity AS MATERIALIZED (
    SELECT places > (SELECT count(*) FROM nightmail_signups) + (SELECT count(*) FROM nightmail_waitlist WHERE let_in_at IS NOT NULL) AS open
    FROM nightmail_signup_limit WHERE singleton
  ), consumed AS (DELETE FROM nightmail_waitlist WHERE email=${address} AND (SELECT open FROM capacity) RETURNING ${evidence})
  SELECT (SELECT row_to_json(c) FROM consumed c) AS waited FROM capacity WHERE open`);
  return free ? { via: 'open', mailbox: address, waited: free.waited } : null;
}
/**
 * The sign-up, with what the sign-ups list may say of it ever after: the mailbox this sign-in proved, the name it gave,
 * and the waitlist row it consumed (when it first asked, how often, when a raise let it in). Never read from the account
 * later: a changed address or name isn't the one that signed up.
 */
export const recordSignup = (db: DbExecutor, userId: string, place: Place, name: string | null) =>
  db.execute(sql`INSERT INTO nightmail_signups(user_id,via,email,name,joined_at,attempts,let_in_at) VALUES(${userId},${place.via},${place.mailbox.length <= 320 ? place.mailbox : null},
    ${place.waited?.name ?? (name?.trim().slice(0, 200) || null)},${place.waited?.first_at ?? null}::timestamptz,${place.waited?.attempts ?? null},${place.waited?.let_in_at ?? null}::timestamptz)`);

/** How a raise gives out the places it adds: held for the waitlist (oldest first, each emailed), or open to anyone. */
export type Raise = 'hold' | 'open';
/**
 * Sets the limit. A hold raise holds the places it adds for the oldest waiting addresses (first attempt first); places
 * left over go to whoever signs in next. An open raise holds none: its places go to whoever signs in next, waiting or
 * not, and nobody is emailed (placesOpened with send false). Places already open stay open either way. Lowering it
 * removes nobody and keeps every held place.
 */
export async function setLimit(db: DbExecutor, limit: number, raise: Raise = 'hold') {
  await lockLimit(db);
  const before = await readPlaces(db);
  await db.execute(sql`UPDATE nightmail_signup_limit SET places=${limit} WHERE singleton`);
  const free = raise === 'open' ? 0 : Math.max(0, Math.min(limit - before.limit, limit - before.signedUp - before.held));
  const { rows } = free ? await db.execute<{ email: string }>(sql`UPDATE nightmail_waitlist w SET let_in_at=now() FROM (
      SELECT q.email FROM nightmail_waitlist q WHERE q.let_in_at IS NULL AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=q.email)
      ORDER BY q.first_at,q.email LIMIT ${free} FOR UPDATE OF q) oldest WHERE w.email=oldest.email RETURNING w.email`) : { rows: [] };
  return { before, after: await readPlaces(db), letIn: rows.map(row => row.email) };
}

/**
 * Where a waiting address stands in the order a hold raise lets the waitlist in (setLimit: first attempt first, then the
 * address, leaving out addresses that are already a verified user's): 1 is next. Null when it isn't waiting.
 */
export async function waitlistPosition(db: DbExecutor, address: string): Promise<number | null> {
  const email = address.toLowerCase();
  const { rows: [row] } = await db.execute<{ position: number }>(sql`SELECT 1+(SELECT count(*)::int FROM nightmail_waitlist q WHERE q.let_in_at IS NULL AND (q.first_at,q.email)<(me.first_at,me.email)
      AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=q.email)) AS position
    FROM nightmail_waitlist me WHERE me.email=${email} AND me.let_in_at IS NULL`);
  return row?.position ?? null;
}

/** Open places at or under which the operators hear that sign-ups are nearly full (placesAlert). */
export const LOW_PLACES = 10;
/**
 * Whether the operators should hear that sign-ups are nearly full (LOW_PLACES or fewer open) or full (none), once per
 * level: the level told is kept with the limit (migration 467), so the next check at the same level or above it says
 * nothing. Places reopening past a level clear it without a word (an operator's raise did that), so reaching it again is
 * told again. Called after a sign-up or a change of the limit commits, in its own transaction under the limit's lock;
 * returns the level newly reached, with the places it saw, or null.
 */
export async function placesAlert(db: DbExecutor): Promise<{ level: 'low' | 'full'; places: Places } | null> {
  await lockLimit(db);
  const places = await readPlaces(db), level = places.open === 0 ? 0 : places.open <= LOW_PLACES ? LOW_PLACES : null;
  const { rows: [told] } = await db.execute<{ alerted: number | null }>(sql`SELECT alerted_open AS alerted FROM nightmail_signup_limit WHERE singleton`);
  if (told!.alerted === level) return null;
  await db.execute(sql`UPDATE nightmail_signup_limit SET alerted_open=${level} WHERE singleton`);
  return level !== null && (told!.alerted === null || level < told!.alerted) ? { level: level === 0 ? 'full' : 'low', places } : null;
}

/**
 * Whether a sign-in that showed nothing of its address (GitHub without a verified primary address, a password) could take
 * a place by proving the mailbox: 'held' for its address, or 'open'. Either way the refusal offers a sign-in link to it.
 * Read without the lock: it only decides what the refusal says.
 */
export async function placeReady(db: DbExecutor, address: string): Promise<'held' | 'open' | null> {
  if ((await db.execute(sql`SELECT FROM nightmail_waitlist WHERE email=${address.toLowerCase()} AND let_in_at IS NOT NULL`)).rowCount) return 'held';
  return (await readPlaces(db)).open > 0 ? 'open' : null;
}

// Sign-in links (migration 466): a person whose sign-in shows nothing of an address with a place (a GitHub account
// without it as its verified primary, another Google account) asks for a link to it. The link proves the mailbox:
// following it and then signing in, with any method, takes the place held for the address, or an open one (account-login.ts,
// takePlace). It goes only to an address that asked for access (a waitlist row) with a place held for it, or while one is
// open, that no account has and that took no place; at most LINKS_A_DAY a day, and it works once, for LINK_MINUTES.
// The row keeps the address and expiry; the link carries the row's ID and an HMAC of it, so the table alone makes none.
// Rows are kept a day for the daily count (maintenance.ts removes them then). A support email's Continue page asks for
// links of its own (migration 571, support-conversations.ts): those rows name the conversation and message, never take a
// place, and each kind is counted and spent apart from the other.
export const LINK_MINUTES = 30;
const LINKS_A_DAY = 3;
let linkKey: { secret: string; key: Buffer } | undefined;
const linkMac = (config: Pick<Config, 'authSecret'>, id: string) => {
  if (linkKey?.secret !== config.authSecret) linkKey = { secret: config.authSecret, key: Buffer.from(hkdfSync('sha256', config.authSecret, 'nightmail:signin-link:v1', 'link', 32)) };
  return createHmac('sha256', linkKey.key).update(id).digest('base64url');
};
/** The link a sign-in link email carries: Overview, which signs in from it and keeps it in the sign-in's return URL. */
export const signinLinkUrl = (config: Pick<Config, 'authSecret' | 'publicUrl'>, id: string) => `${new URL(config.publicUrl).origin}/overview?link=${id}.${linkMac(config, id)}`;
/** A support email's sign-in link: its own Continue page, which signs in from it the same way. */
export const supportLinkUrl = (config: Pick<Config, 'authSecret' | 'publicUrl'>, id: string, conversationId: string, messageId: string) =>
  `${new URL(config.publicUrl).origin}/support/continue/${conversationId}/${messageId}?link=${id}.${linkMac(config, id)}`;
/** A new link's ID: the row's key, and what the link's HMAC is of. */
export const newLinkId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
/**
 * Emails a sign-in link to `address` when a place is held for it, or it is waiting while a place is open
 * (account-notices.ts signinLink, queued with the link in one transaction). Otherwise nothing, and the caller answers
 * the same either way, so the answer says nothing of an address.
 */
export async function sendSigninLink(runtime: Runtime, address: string) {
  const workspaceId = runtime.config.platformDomainWorkspace, email = address.toLowerCase();
  if (!runtime.config.multiTenant || !workspaceId) return;
  const id = newLinkId(), { signinLink } = await import('./account-notices.js');
  await runtime.db.transaction(async tx => {
    // One request per address at a time, so the daily count holds.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${email},46400))`);
    const { rows: [link] } = await tx.execute<{ id: string }>(sql`INSERT INTO nightmail_signin_links(id,email,expires_at) SELECT ${id},w.email,now()+make_interval(mins=>${LINK_MINUTES}::int) FROM nightmail_waitlist w
      WHERE w.email=${email} AND (w.let_in_at IS NOT NULL OR (SELECT l.places>(SELECT count(*) FROM nightmail_signups)+(SELECT count(*) FROM nightmail_waitlist WHERE let_in_at IS NOT NULL)
          FROM nightmail_signup_limit l WHERE l.singleton))
        AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=w.email) AND NOT EXISTS (SELECT FROM nightmail_signups s WHERE s.email=w.email)
        AND (SELECT count(*) FROM nightmail_signin_links l WHERE l.email=w.email AND l.conversation_id IS NULL AND l.created_at>now()-interval '1 day')<${LINKS_A_DAY}
      RETURNING id`);
    if (link) await tx.execute(signinLink(workspaceId, link.id));
  });
}
/** The row ID of a link this installation made (its HMAC checks), else null. */
function linkId(config: Pick<Config, 'authSecret'>, token: string) {
  const [id = '', mac = '', ...rest] = token.split('.');
  return rest.length || !/^[A-Za-z0-9_-]{24}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(linkMac(config, id))) ? null : id;
}
/**
 * The address a sign-in link went to, when `token` is one this installation made and it is unused and unexpired; else
 * null. It is spent in the caller's transaction, the sign-in's, so a sign-in that ends up refused leaves it unspent.
 */
export async function spendSigninLink(db: DbExecutor, config: Pick<Config, 'authSecret'>, token: string) {
  const id = linkId(config, token);
  if (!id) return null;
  const { rows: [link] } = await db.execute<{ email: string }>(sql`DELETE FROM nightmail_signin_links WHERE id=${id} AND conversation_id IS NULL AND expires_at>now() RETURNING email`);
  return link?.email ?? null;
}
/**
 * A support email's sign-in link (support-conversations.ts), unused and unexpired, followed by a sign-in whose verified
 * address (`email`) is the one it went to: that address, now a mailbox proved, and the link spent in the sign-in's
 * transaction. Anyone else's sign-in leaves it unspent, for the person it went to.
 */
export async function spendSupportLink(db: DbExecutor, config: Pick<Config, 'authSecret'>, token: string, email: string) {
  const id = linkId(config, token);
  if (!id) return null;
  const { rows: [link] } = await db.execute<{ email: string }>(sql`DELETE FROM nightmail_signin_links WHERE id=${id} AND conversation_id IS NOT NULL
    AND email=lower(${email}) AND expires_at>now() RETURNING email`);
  return link?.email ?? null;
}

/**
 * Emails every held address not yet told that it can sign in (account-notices.ts waitlistAdmitted, one email per
 * address ever). Called after a change of the limit commits, never inside it, so an email can't undo or hold up a
 * raise, and it never throws. A second raise tells only the addresses it newly let in; saving the limit again tells
 * any a failure missed. emailed: queued now. notEmailed: held addresses still without one (null when unknown). send
 * false (an open raise) emails nobody and only counts them.
 */
export async function placesOpened(runtime: Runtime, send = true): Promise<{ emailed: number; notEmailed: number | null }> {
  let emailed = 0;
  try {
    const { waitlistAdmitted, waitlistNoticeStatus } = await import('./account-notices.js');
    const untold = sql`FROM nightmail_waitlist w WHERE w.let_in_at IS NOT NULL AND ${waitlistNoticeStatus(sql`w.email`)} IS NULL`;
    const { rows } = send ? await runtime.db.execute<{ email: string }>(sql`SELECT w.email ${untold} ORDER BY w.let_in_at,w.first_at,w.email`) : { rows: [] };
    for (const { email } of rows) if (await waitlistAdmitted(runtime, runtime.db, email)) emailed++;
    const { rows: [left] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${untold}`);
    if (emailed) log('info', { code: 'SIGNUP_PLACES_EMAILED', count: emailed });
    if (left!.n) log('warn', { code: 'SIGNUP_PLACES_NOT_EMAILED', count: left!.n });
    return { emailed, notEmailed: left!.n };
  } catch (error) {
    log('warn', { code: 'SIGNUP_PLACES_NOT_EMAILED', emailed, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return { emailed, notEmailed: null };
  }
}

// The sign-ups list (hosted, NIGHTMAIL_SIGNUPS_LIST_ID): everyone who joins the waitlist or signs up is a contact of one
// list in the platform workspace, subscribed because they asked for access, with properties to segment by:
//   status         waiting, let_in (a raise holds a place for it), signed_up (it took a place) or admitted (an
//                  invitation or staff let it in after it joined; nothing new is consented)
//   joined_at      its first attempt; let_in_at and signed_up_at: ISO 8601 in UTC, which sorts in time order
//   attempts       its sign-in attempts while it waited
//   email_domain   its address's domain, and mailbox: free (gmail.com, …) or company
// Nothing on the sign-in or raise path writes for it. A waitlist row is due when it changed since it was last written
// (last_at or let_in_at after list_synced_at), a sign-up until it has been written once; every minute signupsTick queues
// one signups.sync job while anything is due, and the job writes each due address and marks the version it wrote. The
// contact is written from the waitlist row or the sign-up record alone (recordSignup), never the account's profile,
// through the audience code (audience.ts upsertListContact): an opt-out stays an opt-out, suppression is never touched
// and a deleted contact stays deleted. Hourly, signups.reconcile marks admitted the contacts still waiting whose address
// got in another way. Jobs carry no address. Without the list or the platform workspace nothing is queued.
export type SignupsList = { workspaceId: string; listId: string };
export const signupsList = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace' | 'signupsListId'>): SignupsList | null =>
  config.multiTenant && config.platformDomainWorkspace && config.signupsListId ? { workspaceId: config.platformDomainWorkspace, listId: config.signupsListId } : null;
const waitlistDue = sql`(list_synced_at IS NULL OR list_synced_at IS DISTINCT FROM greatest(last_at,let_in_at) OR list_synced_attempts IS DISTINCT FROM attempts)`;
const signupDue = sql`(list_synced_at IS NULL AND email IS NOT NULL)`;
// One job per kind and workspace: queued again only once the last run has finished.
const queueRun = (list: Pick<SignupsList, 'workspaceId'>, kind: 'sync' | 'reconcile', when = sql`true`) => sql`INSERT INTO jobs(id,type,workspace_id,payload)
  SELECT ${`signups.${kind}:${list.workspaceId}`},${`signups.${kind}`},${list.workspaceId},'{}'::jsonb WHERE ${when}
  ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed')`;
/**
 * Every minute (worker cron, Node runner): a signups.sync run while any waitlist row or sign-up is due for the sign-ups
 * list, or any account for the customers list. Never throws.
 */
export async function signupsTick(runtime: Runtime) {
  const list = signupsList(runtime.config), customers = customersWorkspace(runtime.config);
  if (!list && !customers) return;
  const due = [...list ? [sql`EXISTS (SELECT FROM nightmail_waitlist WHERE ${waitlistDue}) OR EXISTS (SELECT FROM nightmail_signups WHERE ${signupDue})`] : [],
    ...customers ? [customersDue(customers)] : []];
  try { await runtime.db.execute(queueRun({ workspaceId: list?.workspaceId ?? customers! }, 'sync', sql.join(due, sql` OR `))); }
  catch { log('warn', { code: 'SIGNUPS_LIST_NOT_QUEUED' }); }
}
/** Hourly (maintenance.ts): a signups.reconcile run, and a warning while the customers list is deleted. */
export async function queueSignupsReconcile(runtime: Runtime) {
  const list = signupsList(runtime.config), customers = customersWorkspace(runtime.config);
  if (list) await runtime.db.execute(queueRun(list, 'reconcile'));
  if (!customers) return;
  const { rows: [gone] } = await runtime.db.execute<{ list_id: string }>(sql`SELECT r.list_id FROM nightmail_customers_list r WHERE r.workspace_id=${customers} AND ${customersListGone}`);
  if (gone) log('warn', { code: 'CUSTOMERS_LIST_MISSING', workspaceId: customers, listId: gone.list_id });
}

const iso = (at: string) => new Date(at).toISOString();
/** A name as a contact's: one line of visible text with a letter, no address or link, at most 200 characters; else none. */
function contactName(raw: string | null | undefined) {
  const name = (raw ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return /\p{L}/u.test(name) && !/@|:\/\/|www\./i.test(name) && name !== `${productName} user` ? name : null;
}
const addressProperties = async (address: string) => {
  const domain = address.slice(address.lastIndexOf('@') + 1), { FREE_MAIL } = await import('./deliverability.js');
  return { email_domain: domain, mailbox: FREE_MAIL.includes(domain) ? 'free' : 'company' };
};
type Standing = { waiting: { name: string | null; attempts: number; joinedAt: string; letInAt: string | null; version: string } | null;
  signup: { name: string | null; joinedAt: string | null; attempts: number | null; letInAt: string | null; at: string } | null };
// One address at a time: what a run reads is at least as new as what an earlier one wrote. A transaction lock, so
// nothing is held on the waitlist or sign-up rows while the contact is written.
const lockAddress = (tx: DbExecutor, list: SignupsList, address: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${list.listId}:${address}`},40420))`);
/**
 * One address's contact, from where it stands now: a sign-up's own record, else its waitlist row. Returns the waitlist
 * row's version it saw (null: none) for the caller to mark once the contact has committed.
 */
async function syncAddress(db: Database, list: SignupsList, address: string): Promise<{ result: ListContactResult; version: string | null; attempts: number | null }> {
  const { upsertListContact } = await import('./audience.js'), byAddress = await addressProperties(address);
  return db.transaction(async tx => {
    await lockAddress(tx, list, address);
    const { rows: [standing] } = await tx.execute<Standing>(sql`SELECT
      (SELECT json_build_object('name',w.name,'attempts',w.attempts,'joinedAt',w.first_at,'letInAt',w.let_in_at,'version',greatest(w.last_at,w.let_in_at)) FROM nightmail_waitlist w WHERE w.email=${address}) AS waiting,
      (SELECT json_build_object('name',s.name,'joinedAt',s.joined_at,'attempts',s.attempts,'letInAt',s.let_in_at,'at',s.at) FROM nightmail_signups s WHERE s.email=${address} ORDER BY s.at LIMIT 1) AS signup`);
    const { waiting, signup } = standing!;
    if (signup) {
      // They asked on the waitlist first when the sign-up consumed a row; else signing up was the asking.
      const result = await upsertListContact(tx, list, list.listId, { email: address, name: contactName(signup.name),
        properties: { status: 'signed_up', ...byAddress, signed_up_at: iso(signup.at), ...signup.joinedAt ? { joined_at: iso(signup.joinedAt) } : {},
          ...signup.attempts !== null ? { attempts: signup.attempts } : {}, ...signup.letInAt ? { let_in_at: iso(signup.letInAt) } : {} },
        consent: signup.joinedAt ? waitlistConsent(signup.joinedAt) : { source: `${productName} sign-up`, evidence: 'Signed up for an account with this verified address.', occurredAt: iso(signup.at) } });
      return { result, version: waiting?.version ?? null, attempts: waiting?.attempts ?? null };
    }
    if (!waiting) return { result: 'gone' as const, version: null, attempts: null };
    const result = await upsertListContact(tx, list, list.listId, { email: address, name: contactName(waiting.name), fromWaitlist: true,
      properties: { status: waiting.letInAt ? 'let_in' : 'waiting', ...byAddress, joined_at: iso(waiting.joinedAt), attempts: waiting.attempts, ...waiting.letInAt ? { let_in_at: iso(waiting.letInAt) } : {} },
      consent: waitlistConsent(waiting.joinedAt) });
    return { result, version: waiting.version, attempts: waiting.attempts };
  });
}
// They asked for access: subscribed from when they first asked, unless they decided otherwise since.
const waitlistConsent = (joinedAt: string) => ({ source: `${productName} waitlist`, evidence: 'Asked for access by signing in with this verified address while sign-ups were closed, and joined the waitlist.', occurredAt: iso(joinedAt) });

const BATCH = 100, RUN_MS = 10_000;
type Counts = Partial<Record<ListContactResult | 'removed' | 'skipped', number>>;
const count = (counts: Counts, result: keyof Counts) => { counts[result] = (counts[result] ?? 0) + 1; };
/** Counts only: addresses never reach a log. A missing list stops the run; the next one tries again. */
function logRun(list: SignupsList, kind: string, counts: Counts) {
  if (counts.no_list) log('warn', { code: 'SIGNUPS_LIST_MISSING', workspaceId: list.workspaceId, listId: list.listId });
  else log('info', { code: 'SIGNUPS_LIST_SYNCED', workspaceId: list.workspaceId, kind, ...counts });
}
// A run queued under a list that has since been turned off or moved changes nothing.
const listOf = (runtime: Runtime, workspaceId: string) => { const list = signupsList(runtime.config); return list?.workspaceId === workspaceId ? list : null; };
const more = () => new JobDeferred(new Date().toISOString());
/** The sign-ups list's part of a run: due sign-ups, then due waitlist rows, 100 at a time, until `until`. */
async function syncSignupsList(runtime: Runtime, list: SignupsList, until: number): Promise<'done' | 'more' | 'missing'> {
  const counts: Counts = {};
  try {
    for (;;) {
      const { rows: signups } = await runtime.db.execute<{ user_id: string; email: string }>(sql`SELECT user_id,email FROM nightmail_signups WHERE ${signupDue} ORDER BY at LIMIT ${BATCH}`);
      const { rows: waiting } = signups.length ? { rows: [] } : await runtime.db.execute<{ email: string }>(sql`SELECT email FROM nightmail_waitlist WHERE ${waitlistDue} ORDER BY first_at,email LIMIT ${BATCH}`);
      if (!signups.length && !waiting.length) return 'done';
      for (const row of signups) {
        const { result } = await syncAddress(runtime.db, list, row.email);
        count(counts, result);
        if (result === 'no_list') return 'missing';
        await runtime.db.execute(sql`UPDATE nightmail_signups SET list_synced_at=now() WHERE user_id=${row.user_id}`);
      }
      for (const row of waiting) {
        const { result, version, attempts } = await syncAddress(runtime.db, list, row.email);
        count(counts, result);
        if (result === 'no_list') return 'missing';
        // The version written: a row changed meanwhile stays due.
        if (version) await runtime.db.execute(sql`UPDATE nightmail_waitlist SET list_synced_at=${version}::timestamptz,list_synced_attempts=${attempts}
          WHERE email=${row.email} AND attempts=${attempts} AND greatest(last_at,let_in_at)=${version}::timestamptz`);
      }
      if (Date.now() > until) return 'more';
    }
  } finally { if (Object.keys(counts).length) logRun(list, 'sync', counts); }
}

// The customers list (hosted, migration 579): every account that owns a workspace, at its verified address, is a contact
// of one list in the platform workspace named "Nightmail customers", for product news and service status. Nothing is set
// by hand. The first run with someone to write makes the list, under an advisory lock so two runs make one, and records
// its ID (nightmail_customers_list): it is found by ID whatever it is renamed to. Once deleted it stays deleted and nothing
// is written (CUSTOMERS_LIST_MISSING, hourly). A migration deleting the row makes a new one, which every account is
// written to again; each account's membership of the old list goes as it moves, so an old list that still exists (renamed
// rather than deleted) ends without everyone this put there. Each account is written once per list and address (nightmail_customers), with properties to segment
// by: signed_up_at (ISO 8601 in UTC), the sign-up's time for an account that took a place (joined_via sign-up), else when
// the account was made (joined_via admitted: an invitation, staff or an operator let it in); email_domain and mailbox as
// the sign-ups list has them; and the sign-up's name, else the account's. Consent, through upsertListContact: a contact
// with no decision is subscribed with the source "Nightmail account" (legitimate interests, not an opt-in) and the notice it
// rests on (CUSTOMERS_NOTICE), recorded again for one already subscribed so its history says why it is on this list; an opt-out stays an opt-out (one decision per
// contact in the workspace), suppression is never touched and a deleted contact stays deleted. An account whose address
// changes moves to the new one; one deleted, owning no workspace or without a verified address comes off (its contact,
// consent and suppression stay). The same signups.sync run does all of it, within a minute; jobs carry no address.
export const CUSTOMERS_LIST_NAME = `${productName} customers`;
/** Who is on the customers list: accounts with a verified address that own a workspace. Teammates too: drop the role. */
const customerAccount = (user: SQL) => sql`${user}.email_verified AND EXISTS (SELECT FROM workspace_members m WHERE m.user_id=${user}.id AND m.role='owner')`;
/** The customers list's workspace: the platform workspace, hosted. */
export const customersWorkspace = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace'>) => config.multiTenant && config.platformDomainWorkspace ? config.platformDomainWorkspace : null;
const customersListGone = sql`NOT EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id=r.workspace_id AND l.id=r.list_id)`;
const customerWritten = (workspaceId: string) => sql`EXISTS (SELECT FROM nightmail_customers c JOIN nightmail_customers_list r ON r.workspace_id=c.workspace_id AND r.list_id=c.list_id
  WHERE c.user_id=u.id AND c.workspace_id=${workspaceId} AND c.email=lower(u.email))`;
/** A row (c) whose account no longer qualifies. */
const customerLeft = sql`NOT EXISTS (SELECT FROM nightmail_users u WHERE u.id=c.user_id AND ${customerAccount(sql`u`)})`;
/**
 * Anything due for the customers list: an account to write while the workspace exists and its list does or is still to
 * be made, or a row whose account left (its row goes even while the list is deleted).
 */
const customersDue = (workspaceId: string) => sql`((EXISTS (SELECT FROM workspaces w WHERE w.id=${workspaceId})
  AND NOT EXISTS (SELECT FROM nightmail_customers_list r WHERE r.workspace_id=${workspaceId} AND ${customersListGone})
  AND EXISTS (SELECT FROM nightmail_users u WHERE ${customerAccount(sql`u`)} AND NOT ${customerWritten(workspaceId)})) OR EXISTS (SELECT FROM nightmail_customers c WHERE ${customerLeft}))`;
/**
 * The customers list's ID: the one recorded, else one made now, in the transaction that records it, under a lock that a
 * second run waits on and then finds it. Null when the recorded list has been deleted, or the workspace doesn't exist.
 */
export async function customersList(db: Database, workspaceId: string): Promise<string | null> {
  const recorded = sql`SELECT r.list_id,NOT ${customersListGone} AS present FROM nightmail_customers_list r WHERE r.workspace_id=${workspaceId}`;
  const { rows: [known] } = await db.execute<{ list_id: string; present: boolean }>(recorded);
  if (known) return known.present ? known.list_id : null;
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId},57900))`);
    const { rows: [made] } = await tx.execute<{ list_id: string; present: boolean }>(recorded);
    if (made) return made.present ? made.list_id : null;
    if (!(await tx.execute(sql`SELECT FROM workspaces WHERE id=${workspaceId}`)).rowCount) return null;
    const listId = id('lst');
    await tx.execute(sql`INSERT INTO audience_lists(id,workspace_id,name,description) VALUES(${listId},${workspaceId},${CUSTOMERS_LIST_NAME},
      ${`Kept by ${productName}: every account that owns a workspace, at its verified address. Rename it freely; deleted, it isn't made again.`})`);
    await tx.execute(sql`INSERT INTO nightmail_customers_list(workspace_id,list_id) VALUES(${workspaceId},${listId})`);
    log('info', { code: 'CUSTOMERS_LIST_CREATED', workspaceId, listId });
    return listId;
  });
}
/**
 * The notice a "Nightmail account" record rests on, as its policy version: the Privacy Policy and Terms that say customers
 * get product news and service status emails, and the line under every sign-in button, published together on that date
 * (app/src/features/legal/content, their `updated`); change it with them. A record is dated when the account signed up or
 * was made, so one dated before the notice is someone who signed up before it existed: the record doesn't claim they saw
 * it, and signed_up_at is what a send filters on.
 */
export const CUSTOMERS_NOTICE = 'Privacy Policy and Terms of 26 November 2026';
const customerConsent = (occurredAt: string) => ({ source: `${productName} account`, occurredAt, policyVersion: CUSTOMERS_NOTICE,
  evidence: `Account holder: owns a ${productName} workspace with this verified address. Product news and service status emails, on legitimate interests; not an opt-in. Dated when the account was created, which can be before the notice.` });
type Written = { workspace_id: string; list_id: string; email: string };
// One account at a time, so a run never writes an account twice or takes back what another just wrote.
const lockAccount = (tx: DbExecutor, userId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId},57901))`);
/** Takes the address a row names off its list, unless another account's row holds it there now. */
async function takeBack(tx: DbExecutor, userId: string, written: Written) {
  const { removeListContact } = await import('./audience.js');
  if ((await tx.execute(sql`SELECT FROM nightmail_customers WHERE user_id<>${userId} AND workspace_id=${written.workspace_id} AND list_id=${written.list_id} AND email=${written.email}`)).rowCount) return false;
  return removeListContact(tx, { workspaceId: written.workspace_id }, written.list_id, written.email);
}
/** One account's contact, from where it stands now, and the row that says so. Reads the account without locking it. */
async function writeCustomer(db: Database, workspaceId: string, listId: string, userId: string): Promise<ListContactResult | 'skipped'> {
  const { upsertListContact } = await import('./audience.js');
  return db.transaction(async tx => {
    await lockAccount(tx, userId);
    const { rows: [account] } = await tx.execute<{ email: string; name: string; created_at: string; signed_up: string | null; signup_name: string | null }>(sql`SELECT
        lower(u.email) AS email,u.name,to_json(u.created_at) AS created_at,to_json(s.at) AS signed_up,s.name AS signup_name
      FROM nightmail_users u LEFT JOIN nightmail_signups s ON s.user_id=u.id WHERE u.id=${userId} AND ${customerAccount(sql`u`)}`);
    const { rows: [written] } = await tx.execute<Written>(sql`SELECT workspace_id,list_id,email FROM nightmail_customers WHERE user_id=${userId}`);
    // No longer qualifies (taken off as one that left), or written meanwhile.
    if (!account || (written?.workspace_id === workspaceId && written.list_id === listId && written.email === account.email)) return 'skipped';
    const since = iso(account.signed_up ?? account.created_at);
    const result = await upsertListContact(tx, { workspaceId }, listId, { email: account.email, name: contactName(account.signup_name ?? account.name), consentAgain: true,
      properties: { ...await addressProperties(account.email), signed_up_at: since, joined_via: account.signed_up ? 'sign-up' : 'admitted' }, consent: customerConsent(since) });
    if (result === 'no_list') return result;
    if (written) await takeBack(tx, userId, written);
    await tx.execute(sql`INSERT INTO nightmail_customers(user_id,workspace_id,list_id,email) VALUES(${userId},${workspaceId},${listId},${account.email})
      ON CONFLICT(user_id) DO UPDATE SET workspace_id=excluded.workspace_id,list_id=excluded.list_id,email=excluded.email,written_at=now()`);
    return result;
  });
}
/** An account that left: its address comes off the list and its row goes. */
async function takeOffCustomer(db: Database, userId: string): Promise<'removed' | 'skipped'> {
  return db.transaction(async tx => {
    await lockAccount(tx, userId);
    const { rows: [written] } = await tx.execute<Written>(sql`SELECT c.workspace_id,c.list_id,c.email FROM nightmail_customers c WHERE c.user_id=${userId} AND ${customerLeft}`);
    if (!written) return 'skipped';
    await takeBack(tx, userId, written);
    await tx.execute(sql`DELETE FROM nightmail_customers WHERE user_id=${userId}`);
    return 'removed';
  });
}
/**
 * The customers list's part of a run: due accounts, then rows whose account left, 100 at a time, until `until`.
 * holdSignups: the sign-ups list is on and wrote everything due, so an account whose sign-up arrived since waits for it
 * (its contact's first consent is the sign-up's own).
 */
async function syncCustomers(runtime: Runtime, workspaceId: string, holdSignups: boolean, until: number): Promise<'done' | 'more'> {
  const listId = await customersList(runtime.db, workspaceId);
  const hold = holdSignups ? sql`AND NOT EXISTS (SELECT FROM nightmail_signups s WHERE s.user_id=u.id AND s.list_synced_at IS NULL AND s.email IS NOT NULL)` : sql``;
  const counts: Counts = {};
  try {
    for (;;) {
      const { rows: due } = listId ? await runtime.db.execute<{ id: string }>(sql`SELECT u.id FROM nightmail_users u WHERE ${customerAccount(sql`u`)} AND NOT ${customerWritten(workspaceId)} ${hold}
        ORDER BY u.created_at,u.id LIMIT ${BATCH}`) : { rows: [] };
      const { rows: left } = due.length ? { rows: [] } : await runtime.db.execute<{ user_id: string }>(sql`SELECT c.user_id FROM nightmail_customers c WHERE ${customerLeft} ORDER BY c.user_id LIMIT ${BATCH}`);
      if (!due.length && !left.length) return 'done';
      for (const row of due) {
        const result = await writeCustomer(runtime.db, workspaceId, listId!, row.id);
        count(counts, result);
        if (result === 'no_list') return 'done';
      }
      for (const row of left) count(counts, await takeOffCustomer(runtime.db, row.user_id));
      if (Date.now() > until) return 'more';
    }
  } finally { if (Object.keys(counts).length) log('info', { code: 'CUSTOMERS_LIST_SYNCED', workspaceId, ...listId ? { listId } : {}, ...counts }); }
}

export const signupJobs: Record<string, JobHandler> = {
  // The sign-ups list's due rows, then the customers list's, 100 at a time, for up to ten seconds a run; it comes back
  // while more are due. A missing sign-ups list stops only its own part.
  'signups.sync': retryDatabaseFailures(async (runtime, _payload, job) => {
    const list = listOf(runtime, job.workspaceId), customers = customersWorkspace(runtime.config) === job.workspaceId, until = Date.now() + RUN_MS;
    const signups = list ? await syncSignupsList(runtime, list, until) : null;
    if (signups === 'more') throw more();
    if (customers && await syncCustomers(runtime, job.workspaceId, signups === 'done', until) === 'more') throw more();
  }),
  // Contacts still waiting or let in whose address left the waitlist without a sign-up, because an invitation, staff or
  // an operator's binding let its account in: status admitted, and nothing else about them changes.
  'signups.reconcile': retryDatabaseFailures(async (runtime, payload, job) => {
    const list = listOf(runtime, job.workspaceId), until = Date.now() + RUN_MS, counts: Counts = {};
    if (!list) return;
    const admitted = (address: SQL) => sql`NOT EXISTS (SELECT FROM nightmail_waitlist w WHERE w.email=${address}) AND NOT EXISTS (SELECT FROM nightmail_signups s WHERE s.email=${address})
      AND EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=${address})`;
    const { PropertiesInput } = await import('./audience.js');
    let after = typeof payload.after === 'string' ? payload.after : '';
    try {
      for (;;) {
        // Only this sync can mark a membership. Lock and recheck both member and contact; a user edit,
        // deletion or manual re-add after the initial scan must not be overwritten.
        const page = await runtime.db.transaction(async tx => {
          const { rows } = await tx.execute<{ id: string; properties: Record<string, unknown> }>(sql`SELECT c.id,c.properties
            FROM audience_list_members m JOIN audience_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
            WHERE m.workspace_id=${list.workspaceId} AND m.list_id=${list.listId} AND m.signup_waitlist AND c.id>${after}
              AND c.deleted_at IS NULL AND c.properties->>'status' IN ('waiting','let_in') AND ${admitted(sql`c.email`)}
            ORDER BY c.id LIMIT ${BATCH} FOR UPDATE OF c SKIP LOCKED FOR SHARE OF m SKIP LOCKED`);
          const ids = rows.filter(c => PropertiesInput.safeParse({ ...c.properties, status: 'admitted' }).success).map(c => c.id);
          if (ids.length) await tx.execute(sql`UPDATE audience_contacts SET properties=jsonb_set(properties,'{status}','"admitted"'),updated_at=now()
            WHERE workspace_id=${list.workspaceId} AND id=ANY(${sql.param(ids)}::text[])`);
          return { rows, updated: ids.length };
        });
        counts.updated = (counts.updated ?? 0) + page.updated;
        if (page.rows.length < BATCH) return;
        after = page.rows[page.rows.length - 1]!.id;
        if (Date.now() > until) throw new JobDeferred(new Date().toISOString(), { after }); // Opaque contact ID, never the mailbox.
      }
    } finally { if (Object.keys(counts).length) logRun(list, 'reconcile', counts); }
  }),
};
