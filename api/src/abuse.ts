import { createHmac, hkdfSync } from 'node:crypto';
import { sql, type SQL, type Assume } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { ipNetwork, userAgentFamily } from './audit.js';
import { clientIpHeader, clientNetworkHeader } from './brand.js';
import { isBuiltinHost } from './builtin-domain.js';
import type { Client, Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { JobDeferred } from './jobs.js';
import { databaseCodeOf } from './core/errors.js';
import { log } from './log.js';
import type { JobHandler, Runtime } from './core/types.js';
import { placementRoot } from './domain-registry.js';
import { isKnownDisposable, PUBLIC_MAILBOXES } from './list-hygiene.js';

// Abuse and fraud monitoring for hosted installations: small facts ("signals") about users, workspaces and refused
// sign-ins, kept so that related accounts can be recognised by a person later.
//
// Monitoring only. Nothing here blocks, pauses or limits anyone, and the resulting scores only guide human review.
// - Off unless NIGHTMAIL_ABUSE_MONITORING names an activation time that has passed. Nothing created before the
//   database first ran with that setting is ever read. Expiry runs whether it is on or off.
// - Queued stage jobs write signals from three durable records:
//   the sign-in log (a sign-in adds what it observed, already pseudonymised, to the row it writes anyway), the
//   payment records and the sending log. No request waits on, queues for or connects to anything here, and the send
//   path runs no code and no statement of this module.
// - Erasure and exclusion hold. Every write happens in a transaction that first takes the entity's lock and then
//   checks its exclusions and its floor (the instant of its last erasure); the privacy command takes the same lock.
//   No cursor is reset by an erasure, so nothing observed before it can come back.
// - Bounded. Every statement runs with a short statement and lock timeout, in work-limited slices that continue from
//   stored cursors.
//
// A stored value is a keyed one-way hash (an address, a network, a card, a domain, a content fingerprint) or a value
// that names no person (an ASN, a country, a browser from a closed list, a flag). The service holds the key, so it can
// test a candidate value against the store; nobody without the key can.

export type AbuseTx = { execute<T extends QueryResultRow = QueryResultRow>(statement: SQL): Promise<QueryResult<Assume<T, QueryResultRow>>> };
export type Hosted = Pick<Runtime, 'db' | 'config'> & { deadline?: number; tx?: AbuseTx; stage?: AbuseStage; lease?: string; epoch?: string };
export type Entity = { type: 'user' | 'workspace' | 'attempt'; id: string };
/** One fact. `at`: when it was true (the provider accepted the mail, the payment changed); now when absent. */
export type Signal = { kind: string; value: string; detail?: Record<string, string | number | boolean>; at?: string };
/** The client as the entry point saw it (clientIpHeader, clientNetworkHeader) and its browser. */
export type RequestNetwork = { ip: string | null; userAgent: string | null; asn: string | null; country: string | null };
/** Whether monitoring is on: a hosted installation whose configured activation time has passed. */
export const monitoring = (config: Runtime['config'], now = Date.now()) => config.multiTenant && !!config.abuseMonitoring && Date.parse(config.abuseMonitoring.since) <= now;

// Fingerprints of sent mail are kept as long as the sent-mail records (30 days); everything else 90 days after it was
// last seen. Runs whether monitoring is on or off (maintenance.ts).
const MAIL_KINDS = ['content', 'link', 'send_domain'];
export const abuseExpired = sql`last_at < now() - interval '30 days' AND (kind = ANY(${sql.param(MAIL_KINDS)}::text[]) OR last_at < now() - interval '90 days')`;
// An entity keeps at most this many values of one kind; the least recently seen leave first.
const ENTITY_KIND_MOST = 100;
const STATEMENT_MS = 2000, LOCK_MS = 500;

let derived: { secret: string; key: Buffer } | undefined;
/** A keyed one-way hash: HMAC-SHA-256 under a key derived from the root secret, 128 bits. Rotating the secret starts a
 *  new epoch: new hashes match nothing stored before, and the old rows expire. */
export function signalHash(config: Pick<Runtime['config'], 'authSecret'>, kind: string, value: string) {
  if (derived?.secret !== config.authSecret) derived = { secret: config.authSecret, key: Buffer.from(hkdfSync('sha256', config.authSecret, 'nightmail:abuse:v1', 'signals', 32)) };
  return createHmac('sha256', derived.key).update(`${kind}\n${value}`).digest('hex').slice(0, 32);
}

// ----- Addresses ---------------------------------------------------------------------------------------------------------
// Providers that document how they read an address: case never matters, a plus tag is ignored, and for Gmail dots are
// too. Anywhere else only the exact address is compared. `as`: the provider's other name for the same mailboxes.
const ALIASES: Record<string, { dots?: true; as?: string }> = { 'gmail.com': { dots: true }, 'googlemail.com': { dots: true, as: 'gmail.com' },
  'outlook.com': {}, 'hotmail.com': {}, 'live.com': {}, 'icloud.com': {}, 'proton.me': {}, 'protonmail.com': {}, 'fastmail.com': {} };
/**
 * An address as it is compared. `exact`: the address with its domain lowercased, nothing else changed. `alias`: the
 * mailbox it names at a provider that documents its equivalences (ALIASES), or null anywhere else. `tagged`: such a
 * provider ignored a plus tag in it.
 */
export function readAddress(address: string) {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  const local = address.slice(0, at), domain = address.slice(at + 1).toLowerCase().replace(/\.$/, ''), rule = ALIASES[domain];
  let mailbox = local.toLowerCase();
  const plus = mailbox.indexOf('+'), tagged = !!rule && plus > 0;
  if (tagged) mailbox = mailbox.slice(0, plus);
  if (rule?.dots) mailbox = mailbox.replaceAll('.', '');
  return { exact: `${local}@${domain}`, alias: rule ? `${mailbox}@${rule.as ?? domain}` : null, tagged, domain, disposable: isKnownDisposable(domain), publicMailbox: PUBLIC_MAILBOXES.has(domain) };
}
const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** The registrable domain of a DNS host name under a known public suffix, or null: never an IP literal, a bare label,
 *  a name under an unknown suffix or a public suffix itself. */
export async function registrableDomain(host: string) {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!DNS_NAME.test(name)) return null;
  const { root, known } = await placementRoot(name);
  return known ? root : null;
}

// ----- Requests ----------------------------------------------------------------------------------------------------------
/** Who is asking, from the headers the entry point set (server.ts, worker.ts). */
export function requestNetwork(headers: Headers): RequestNetwork {
  const [asn = '', country = ''] = (headers.get(clientNetworkHeader) ?? '').split(';');
  return { ip: headers.get(clientIpHeader), userAgent: headers.get('user-agent'), asn: /^AS\d{1,10}$/.test(asn) ? asn : null, country: /^[A-Z]{2}$/.test(country) ? country : null };
}
const BROWSER = /^(?:Chrome|Firefox|Safari|Edge) \d{1,3}(?: on (?:Windows|macOS|Linux|iOS|Android))?$/;
/** A browser from a closed list (four families, a major version of at most three digits, five systems), or "other":
 *  never a token copied from the user agent. */
export function browserFamily(agent: string | null | undefined) {
  const family = userAgentFamily(agent);
  return family && BROWSER.test(family) ? family : 'other';
}
/** The network as a keyed hash of its /24 (or /48), its ASN and country, and the browser from the closed list. */
function networkSignals(config: Runtime['config'], network: RequestNetwork | null | undefined): Signal[] {
  if (!network) return [];
  const out: Signal[] = [], net = ipNetwork(network.ip);
  if (net) out.push({ kind: 'net', value: signalHash(config, 'net', net) });
  if (network.asn) out.push({ kind: 'asn', value: network.asn, ...(network.country ? { detail: { country: network.country } } : {}) });
  if (network.userAgent) out.push({ kind: 'browser', value: browserFamily(network.userAgent) });
  return out;
}

// ----- The store ---------------------------------------------------------------------------------------------------------
/** A key that exclusions, floors and locks are held under: a user, a workspace, or a sign-in subject ("issuer subject",
 *  which unlike a refused sign-in's hashed entity survives a change of the root secret). */
export type Guard = { type: 'user' | 'workspace' | 'subject'; id: string };
const subjectGuard = (issuer: string, subject: string): Guard => ({ type: 'subject', id: `${issuer} ${subject}` });
/** One short transaction with the module's statement and lock timeouts: a slow or blocked statement ends, it never waits. */
class StageDeadline extends Error {}
const rollbackItem = sql`ROLLBACK TO SAVEPOINT abuse_item`;
// Leave room for the configuration round trip and COMMIT/ROLLBACK. Never send a data
// statement with a timeout larger than the time left. Near the deadline halve it,
// so setting the shorter limit doesn't itself spend the remaining window.
const WIRE_RESERVE_MS = 100;
export function bounded<T>(runtime: Hosted, work: (tx: AbuseTx) => Promise<T>): Promise<T> {
  if (runtime.tx) return work(runtime.tx);
  const remaining = () => (runtime.deadline ?? Infinity) - Date.now() - WIRE_RESERVE_MS;
  const limit = () => {
    if (remaining() < WIRE_RESERVE_MS) throw new StageDeadline();
    return Math.min(STATEMENT_MS, Math.floor(remaining() / 2));
  };
  limit();
  return runtime.db.transaction(async tx => {
    let timeout = limit();
    // Only non-blocking advisory tries here: no relation is read before the timeouts are installed.
    const ownership = runtime.stage ? sql`,pg_try_advisory_xact_lock_shared(327461638,0) AND
      pg_try_advisory_xact_lock(327461638,${2+STAGES.indexOf(runtime.stage)}::int) AS owns` : sql``;
    const { rows: [claim] } = await tx.execute<{ owns?: boolean }>(sql`SELECT set_config('statement_timeout',${String(timeout)},true),set_config('lock_timeout',${String(LOCK_MS)},true)${ownership}`);
    if (claim?.owns === false) throw new StageDeadline();
    if (!runtime.deadline) return work(tx);
    const timed: AbuseTx = { async execute<T extends QueryResultRow>(statement: SQL) {
      // An aborted subtransaction accepts only ROLLBACK; SET would fail with 25P02.
      if (statement === rollbackItem) { limit(); return tx.execute<T>(statement); }
      if (timeout > remaining()) {
        timeout = limit();
        await tx.execute(sql`SELECT set_config('statement_timeout',${String(timeout)},true)`);
      }
      if (timeout > remaining()) throw new StageDeadline();
      return tx.execute<T>(statement);
    } };
    if (runtime.epoch) {
      // The hourly tick takes the exclusive activation lock before resetting the floor.
      // No transaction started with old cursors can write into the new epoch.
      const active = await timed.execute(sql`SELECT FROM abuse_state WHERE id='monitor' AND configured=${runtime.config.abuseMonitoring!.since}::timestamptz
        AND active_since=${runtime.epoch}::timestamptz AND lease_until='infinity'`);
      if (!active.rowCount) throw new StageDeadline();
    }
    return work(timed);
  });
}
// Writers hold entity guards first. The graph reader holds the exclusive side while it
// gathers, scores, stores the alert and acknowledges links. No network I/O under this lock.
export const graphLock = (tx: AbuseTx, exclusive = false) => tx.execute(exclusive
  ? sql`SELECT pg_advisory_xact_lock(327461638,1)` : sql`SELECT pg_advisory_xact_lock_shared(327461638,1)`);
const guardKey = (g: Guard | Entity) => `abuse:${g.type}:${g.id}`;
async function tryGuards(tx: AbuseTx, keys: string[]) {
  const sorted = [...new Set(keys)].sort();
  const { rows } = await tx.execute<{ key: string; held: boolean }>(sql`SELECT key,pg_try_advisory_xact_lock(hashtextextended(key,0)) AS held
    FROM unnest(${sql.param(sorted)}::text[]) WITH ORDINALITY g(key,n) ORDER BY n`);
  return new Set(rows.filter(g => g.held).map(g => g.key));
}
// The scorer already holds the graph lock. Never wait here for a writer or a privacy
// command which took an entity guard first: roll back and give it the graph immediately.
export async function lockClusterMembers(tx: AbuseTx, members: Entity[]) {
  const keys = members.map(guardKey);
  if ((await tryGuards(tx,keys)).size !== new Set(keys).size) throw new StageDeadline();
}
/** Takes the guards' locks for the rest of the transaction, always in the same order. Writers and the privacy command
 *  take them before they read or write anything about the entity, so neither can miss the other's change. */
async function lockGuards(tx: AbuseTx, guards: (Guard | Entity)[]) {
  for (const key of [...new Set(guards.map(guardKey))].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
const guardPairs = (guards: Guard[]) => sql.join(guards.map(guard => sql`(${guard.type},${guard.id})`), sql`, `);
/** Whether a workspace is excluded: by an exclusion of its own, or by one of a current owner's. */
export const workspaceExcluded = (workspaceId: SQL) => sql`(EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type='workspace' AND x.entity_id=${workspaceId})
  OR EXISTS (SELECT FROM abuse_exclusions x JOIN workspace_members m ON m.user_id=x.entity_id AND m.role='owner' WHERE x.entity_type='user' AND m.workspace_id=${workspaceId}))`;
/** Whether any of these guards is excluded (a workspace also through its owners). */
const excluded = (guards: Guard[]) => sql`(EXISTS (SELECT FROM abuse_exclusions x WHERE (x.entity_type,x.entity_id) IN (${guardPairs(guards)}))${
  sql.join(guards.filter(guard => guard.type === 'workspace').map(guard => sql` OR ${workspaceExcluded(sql`${guard.id}`)}`), sql``)})`;
/** The latest erasure among these guards: nothing observed at or before it is ever recorded. */
const floorOf = (guards: Guard[]) => sql`coalesce((SELECT max(f.ignore_through) FROM abuse_floors f WHERE (f.entity_type,f.entity_id) IN (${guardPairs(guards)})),'-infinity'::timestamptz)`;
/**
 * Notes signals for one entity, inside the caller's transaction and after lockGuards: a new row, or a later sighting
 * of a row it has. Nothing is written when a guard is excluded, and nothing observed at or before a guard's floor.
 * Returns the number of new rows.
 */
async function writeSignals(tx: AbuseTx, entity: Entity, guards: Guard[], signals: Signal[], count: boolean) {
  const rows = [...new Map(signals.filter(s => s.value && s.value.length <= 255).map(s => [`${s.kind}\n${s.value}`, { kind: s.kind, value: s.value, detail: s.detail ?? null, at: s.at ?? null }])).values()];
  if (!rows.length) return 0;
  const { rows: [written] } = await tx.execute<{ added: number }>(sql`WITH incoming AS (
      SELECT r.kind,r.value,r.detail,coalesce(r.at,now()) AS at FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(kind text,value text,detail jsonb,at timestamptz)
      WHERE NOT ${excluded(guards)} AND coalesce(r.at,now())>${floorOf(guards)}),
    written AS (INSERT INTO abuse_signals(entity_type,entity_id,kind,value,detail,first_at,last_at) SELECT ${entity.type},${entity.id},kind,value,detail,at,at FROM incoming
      ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+${count ? 1 : 0},last_at=greatest(abuse_signals.last_at,excluded.last_at),detail=coalesce(excluded.detail,abuse_signals.detail)
      RETURNING (xmax=0) AS fresh)
    SELECT count(*) FILTER (WHERE fresh)::int AS added FROM written`);
  return written?.added ?? 0;
}
/** Past ENTITY_KIND_MOST values of one kind, the least recently seen leave. The last statement of a write, under the
 *  entity's lock, so the limit holds whatever else is writing. */
const trimSignals = (tx: AbuseTx, entity: Entity) => tx.execute(sql`DELETE FROM abuse_signals s USING (SELECT kind,value,row_number() OVER (PARTITION BY kind ORDER BY last_at DESC,value) AS n
    FROM abuse_signals WHERE entity_type=${entity.type} AND entity_id=${entity.id}) old
  WHERE s.entity_type=${entity.type} AND s.entity_id=${entity.id} AND s.kind=old.kind AND s.value=old.value AND old.n>${ENTITY_KIND_MOST}`);

// ----- Links -------------------------------------------------------------------------------------------------------------
// Values two entities can share. A value held by more than LINK_HOLDERS_MOST entities is common infrastructure (a campus
// network, a popular link shortener) and links nobody: not when a link is written, and not later, when a value that
// was rare then has become common (src/abuse-clusters.ts reads links through this too).
export const LINK_KINDS = ['email', 'email_alias', 'email_domain', 'provider', 'net', 'card', 'send_domain', 'content', 'link'];
export const rare = (kind: SQL, value: SQL) => sql`abuse_rare_value(${kind},${value})`;
/** A link expires with the signals it came from: its last_at is the latest moment both sides held a shared value. */
export const linkExpired = sql`last_at < now() - interval '30 days' AND (kind = ANY(${sql.param(MAIL_KINDS)}::text[]) OR last_at < now() - interval '90 days')`;
/**
 * Links one entity to the others that hold a value it was just given, inside the transaction that wrote the values:
 * at most LINK_PARTNERS_MOST other entities, each pair with the number of rare values of that kind they share now.
 * Incremental by construction: only the values just written are looked at, never the whole store.
 */
async function linkEntity(tx: AbuseTx, entity: Entity, signals: Signal[]) {
  if (signals.some(s => LINK_KINDS.includes(s.kind))) await tx.execute(sql`SELECT abuse_link_holder(${entity.type},${entity.id},${JSON.stringify(signals)}::jsonb)`);
}

// ----- Sign-ins ----------------------------------------------------------------------------------------------------------
const attemptEntity = (config: Runtime['config'], issuer: string, subject: string) => `att_${signalHash(config, 'attempt', `${issuer}\n${subject}`)}`;
export type SignInObserved = {
  outcome: string;
  /** The address the issuer verified, or null. */
  email: string | null;
  provider: { provider: string; sub: string } | null;
  network?: RequestNetwork | null;
};
/**
 * What a verified sign-in shows, admitted or refused, as the sign-in log keeps it (nightmail_signin_attempts.observed):
 * its address, the account behind it and where it came from, hashed here, in the request. Null while monitoring is
 * off. Pure: it reads and writes nothing; the hourly job reads the log later.
 */
export function signInSignals(config: Runtime['config'], o: SignInObserved): Signal[] | null {
  if (!monitoring(config)) return null;
  const signals = networkSignals(config, o.network), email = o.email ? readAddress(o.email) : null;
  if (email) {
    signals.push({ kind: 'email', value: signalHash(config, 'email', email.exact) });
    if (email.alias) signals.push({ kind: 'email_alias', value: signalHash(config, 'email_alias', email.alias) });
    if (!email.publicMailbox) signals.push({ kind: 'email_domain', value: signalHash(config, 'email_domain', email.domain), detail: { class: email.disposable ? 'disposable' : 'own' } });
    if (email.disposable) signals.push({ kind: 'flag', value: 'disposable_email' });
    if (email.tagged) signals.push({ kind: 'flag', value: 'plus_alias' });
  }
  if (o.provider) signals.push({ kind: 'provider', value: signalHash(config, 'provider', `${o.provider.provider}\n${o.provider.sub}`) });
  if (o.outcome === 'not_approved') signals.push({ kind: 'flag', value: 'waitlisted' });
  return signals;
}
// What the job accepts from the sign-in log: exactly the kinds and value shapes signInSignals writes, nothing else.
const hash = z.string().regex(/^[0-9a-f]{32}$/), bare = <K extends string, V extends z.ZodType>(kind: K, value: V) => z.object({ kind: z.literal(kind), value }).strict();
const ObservedSignal = z.union([bare('email', hash), bare('email_alias', hash), bare('provider', hash), bare('net', hash),
  z.object({ kind: z.literal('email_domain'), value: hash, detail: z.object({ class: z.enum(['own', 'disposable']) }).strict() }).strict(),
  z.object({ kind: z.literal('asn'), value: z.string().regex(/^AS\d{1,10}$/), detail: z.object({ country: z.string().regex(/^[A-Z]{2}$/) }).strict().optional() }).strict(),
  bare('browser', z.string().regex(new RegExp(`${BROWSER.source}|^other$`))), bare('flag', z.enum(['disposable_email', 'plus_alias', 'waitlisted']))]);
const Observed = z.array(ObservedSignal).max(12);

// ----- Fingerprints of sent mail -----------------------------------------------------------------------------------------
const MAIL_BYTES = 64 * 1024, MAX_WORDS = 4000, MIN_WORDS = 20, HASHES = 24, BANDS = 3, LINKS_MOST = 10, LINK_CANDIDATES = 200;
/** At most `bytes` UTF-8 bytes of a string, cut at a character. */
function clip(value: string | null | undefined, bytes: number) {
  if (!value || bytes <= 0) return '';
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.toString('utf8', 0, end);
}
/** A message's HTML and text parts within one combined byte budget, HTML first. */
function mailParts(html?: string | null, text?: string | null) {
  const markup = clip(html, MAIL_BYTES);
  return { html: markup, text: clip(text, MAIL_BYTES - Buffer.byteLength(markup)) };
}
/** The text of an HTML part without its markup, style sheets, scripts and head. One pass; never a parse. */
function htmlText(html: string) {
  const lower = html.toLowerCase();
  let out = '', i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += `${html.slice(i, lt)} `;
    if (lower.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const block = /^<(style|script|head|title)[\s>]/.exec(lower.slice(lt, lt + 8))?.[1];
    if (block) { const close = lower.indexOf(`</${block}`, gt); i = close < 0 ? html.length : close; }
    else i = gt + 1;
  }
  return out.replace(/&[a-z0-9#]{1,10};/gi, ' ');
}
/** The words a fingerprint is made of: case, numbers, links and addresses removed, so an order number changes nothing. */
export function contentWords(subject: string, html?: string | null, text?: string | null): string[] {
  const parts = mailParts(html, text), body = parts.html ? htmlText(parts.html) : parts.text, words: string[] = [];
  for (const chunk of `${subject.slice(0, 1000)} ${body}`.normalize('NFKC').toLowerCase().split(/\s+/)) {
    if (chunk.length > 40 || chunk.includes('@') || chunk.includes('://')) continue;
    for (const word of chunk.replace(/\d+/g, '0').match(/[\p{L}\p{N}]+/gu) ?? []) { words.push(word); if (words.length >= MAX_WORDS) return words; }
  }
  return words;
}
const fmix = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const SEEDS = Array.from({ length: HASHES }, (_, i) => fmix(0x9e3779b9 * (i + 1)));
/**
 * A message's content fingerprint: MinHash over its three-word shingles (the minima use fixed seeds), grouped into
 * bands, each band stored as a keyed hash. One band is evidence on its own: two messages share a band only when
 * their wording agrees almost throughout, so a shared value always describes one pair of messages. Null for a
 * message too short to tell apart from boilerplate.
 */
export function contentFingerprint(config: Pick<Runtime['config'], 'authSecret'>, subject: string, html?: string | null, text?: string | null): string[] | null {
  const words = contentWords(subject, html, text);
  if (words.length < MIN_WORDS) return null;
  const minima = new Uint32Array(HASHES).fill(0xffffffff);
  for (let i = 0; i + 2 < words.length; i++) {
    const shingle = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    let h = 0x811c9dc5;
    for (let c = 0; c < shingle.length; c++) h = Math.imul(h ^ shingle.charCodeAt(c), 0x01000193);
    for (let k = 0; k < HASHES; k++) { const v = fmix(h ^ SEEDS[k]!); if (v < minima[k]!) minima[k] = v; }
  }
  const size = HASHES / BANDS;
  return Array.from({ length: BANDS }, (_, band) => signalHash(config, 'content', `${band}:${Array.from(minima.slice(band * size, (band + 1) * size)).join(',')}`).slice(0, 16));
}
/**
 * The registrable domains a message links to or loads: each http(s) URL is read with the URL parser, and only a DNS
 * host name under a known public suffix counts. A URL with credentials, an IP literal or a malformed name is skipped
 * whole. The caller stores them hashed; they are never logged.
 */
export async function linkDomains(html?: string | null, text?: string | null): Promise<string[]> {
  const parts = mailParts(html, text), roots = new Set<string>();
  let candidates = 0;
  for (const match of `${parts.html} ${parts.text}`.matchAll(/https?:\/\/[^\s"'<>()\\]{4,2048}/gi)) {
    if (++candidates > LINK_CANDIDATES || roots.size >= LINKS_MOST) break;
    let url: URL;
    try { url = new URL(match[0]); } catch { continue; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) continue;
    const root = await registrableDomain(url.hostname);
    if (root) roots.add(root);
  }
  return [...roots];
}

// ----- The stage jobs ----------------------------------------------------------------------------------------------------
// Work limits of one run. Each stage stops at its limit or its own wall-time budget and continues from committed receipts or its cursor.
const SIGN_INS_A_RUN = 200, PAYMENTS_A_RUN = 200, WORKSPACE_PAGE = 200, WORKSPACE_PAGES = 10, SAMPLED_A_RUN = 100, MESSAGES_A_WORKSPACE = 6, NEW_ROWS_A_RUN = 5000;
type Cursors = { signIns?: { at: string; key: string }; payments?: { at: string; id: string }; workspaces?: string };
type SignInPosition = { at: string; key: string; source_key: string };
type Run = { signInSeek: SignInPosition | null; scanningSignIns: boolean; batchSize: number; advanced: boolean; since: string; cursors: Cursors; items: number; added: number; deadline: number; cuts: Record<string, Cut>; /** Workspaces the sample read mail of. */ checked?: number };
/** Why a stage stopped with work left: its share of the time ran out, or it reached a per-run limit. */
export type Cut = 'time' | 'limit' | 'retry';
const spent = (run: Run) => Date.now() >= run.deadline || run.added >= NEW_ROWS_A_RUN;
/** Productive slices continue immediately; stalled slices back off. Health measures the oldest outstanding work. */
const cut = (run: Run, stage: AbuseStage, why?: Cut) => { if (run.cuts[stage] !== 'time') run.cuts[stage] = why ?? (Date.now() >= run.deadline ? 'time' : 'limit'); };
export const utc = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Sign-ins from the sign-in log, in the order they happened: what each observed (signInSignals), dated by the sign-in,
 * on the user it is or, for a refused one, on a keyed hash of its subject. A user takes over what its refused
 * sign-ins left. Only sign-ins since monitoring started; each version of a row is read once.
 */
const BATCH_SIZE = 16;
// No source lock or write. A receipt names the version actually read, not whatever
// version happens to be current when we commit. Only success settles a version.
const hasPermit = (stage: string) => sql`EXISTS (SELECT FROM abuse_retry_slots WHERE stage=${stage} AND available_at<=now())`;
const outstanding = (stage: string, key: SQL, at: SQL, count = sql`0`, health = false) => sql`NOT EXISTS (
  SELECT FROM abuse_work_versions v WHERE (v.stage,v.source_key,v.version_at,v.version_count)=
    (${stage},${key},${at},${count}) AND (v.failures=0 ${health ? sql`` : sql`OR v.retry_after>now() OR NOT ${hasPermit(stage)}`}))`;
const signInKey = sql`abuse_key(a.issuer,a.subject)`, paymentKey = sql`abuse_key(p.id)`;
const eligibleSignIn = (since: SQL, at: SQL, key: SQL, health = false) => sql`a.observed IS NOT NULL AND a.last_at>${since} AND
  (a.last_at,md5(a.issuer||' '||a.subject))>(coalesce(${at},${since}),coalesce(${key},'')) AND
  coalesce((SELECT v.failures>0 ${health ? sql`` : sql`AND v.retry_after<=now()`} FROM abuse_work_versions v
    WHERE (v.stage,v.source_key,v.version_at,v.version_count)=('signIns',${signInKey},a.last_at,a.attempts)),true)`;
const eligiblePayment = (since: SQL, at: SQL, id: SQL, health = false) => sql`p.created_at>=${since} AND NOT EXISTS (SELECT FROM abuse_floors f WHERE f.entity_type='workspace' AND f.entity_id=p.workspace_id AND f.ignore_through>=p.updated_at) AND
  (p.updated_at,p.id)>(coalesce(${at},${since}),coalesce(${id},'')) AND ${outstanding('payments',paymentKey,sql`p.updated_at`,sql`0`,health)}`;

export type WorkVersion = { source_key: string; at: string; attempts?: number };
// Among due retries use the oldest retry time, not the oldest source timestamp:
// repeatedly failing old sources must not monopolize the permits.
export const workOrder = (stage: string, key: SQL, at: SQL) => sql`coalesce((SELECT retry_after FROM abuse_work_versions
  WHERE stage=${stage} AND source_key=${key} AND version_at=${at} AND version_count=0 AND failures>0),${at})`;
export const runnableSeed = (stage: string, key: SQL, at: SQL) => outstanding(stage,key,at);
function itemReason(error: unknown) {
  const code = databaseCodeOf(error);
  // Positive attribution only. A driver failure, cancellation, resource limit,
  // serialization conflict or unknown exception is never an item's fault.
  return error instanceof InvalidObservation ? 'INVALID_OBSERVATION'
    : code && /^(22|23)/.test(code) ? code : null;
}
class InvalidObservation extends Error {}
// The permit commits with the outcome; infrastructure errors roll it back too.
export async function isolateItem(tx: AbuseTx, stage: string, version: WorkVersion, work: () => Promise<void>) {
  const match = sql`stage=${stage} AND source_key=${version.source_key} AND version_at=${version.at}::timestamptz AND version_count=${version.attempts ?? 0}`;
  const { rows: [permit] } = await tx.execute<{retry:boolean;allowed:boolean}>(sql`WITH prior AS MATERIALIZED (
    SELECT FROM abuse_work_versions WHERE ${match} AND failures>0), claimed AS (
    UPDATE abuse_retry_slots SET available_at=clock_timestamp()+interval '15 minutes'
    WHERE EXISTS (SELECT FROM prior) AND (stage,slot)=(SELECT stage,slot FROM abuse_retry_slots
      WHERE stage=${stage} AND available_at<=now() ORDER BY available_at,slot LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING 1)
    SELECT EXISTS(SELECT FROM prior) AS retry,EXISTS(SELECT FROM claimed) AS allowed`);
  if (permit!.retry && !permit!.allowed) return false;
  await tx.execute(sql`SAVEPOINT abuse_item`);
  try { await work(); }
  catch (error) {
    const reason = itemReason(error);
    if (!reason) throw error;
    await tx.execute(rollbackItem);
    await tx.execute(sql`WITH failed AS (INSERT INTO abuse_work_versions AS v(stage,source_key,version_at,version_count,failures,reason,first_failed_at,retry_after)
      VALUES (${stage},${version.source_key},${version.at}::timestamptz,${version.attempts ?? 0},1,${reason},clock_timestamp(),clock_timestamp()+interval '15 minutes')
      ON CONFLICT (stage,source_key,version_at,version_count) DO UPDATE SET failures=v.failures+1,reason=excluded.reason,
        retry_after=clock_timestamp()+CASE WHEN v.failures=1 THEN interval '30 minutes' ELSE interval '1 hour' END
      WHERE v.failures>0 RETURNING source_key,retry_after)
      UPDATE abuse_signin_queue q SET retry_after=f.retry_after FROM failed f WHERE ${stage}='signIns' AND q.source_key=f.source_key`);
    log('warn',{code:'ABUSE_ITEM_RETRY',stage,reason});
    return false;
  }
  if (permit!.retry && (stage==='links' || stage==='scores')) await tx.execute(sql`DELETE FROM abuse_work_versions WHERE ${match}`);
  return true;
}
type Candidate = { issuer: string; subject: string; user_id: string | null };
async function foldSignIns(runtime: Hosted, run: Run) {
  const legacy = run.cursors.signIns, where = eligibleSignIn(sql`${run.since}::timestamptz`,sql`${legacy?.at ?? null}::timestamptz`,sql`${legacy?.key ?? null}::text`);
  let items = 0;
  // The earliest pending hint survives a job cut. Seek past busy guards within the slice.
  let after: SignInPosition | undefined = run.signInSeek ?? undefined;
  let busy = false, retries = true, retryTurn = true;
  let scanning = run.scanningSignIns;
  while (!spent(run) && items < SIGN_INS_A_RUN) {
    if (scanning) {
      after = undefined;
      const page = await bounded(runtime, tx => tx.execute<{ more: boolean }>(sql`SELECT abuse_stage_signin_page()>=0 AS more`));
      scanning = page.rows[0]!.more;
      if (scanning) { run.advanced = true; continue; }
    }
    const started = Date.now();
    let size = Math.min(run.batchSize,SIGN_INS_A_RUN-items);
    let folding = false, next = after;
    const batch = await bounded(runtime, async tx => {
      // Limit the ordered index walk BEFORE resolving identities. Neither the
      // receipt count nor a burst sharing one timestamp changes the pick size.
      const retry = retries && retryTurn;
      if (retry) size=1;
      const { rows: page } = await tx.execute<SignInPosition & {issuer: string|null;subject:string|null;user_id:string|null}>(sql`WITH heads AS MATERIALIZED (
        SELECT * FROM abuse_signin_queue
        ${retry ? sql`WHERE retry_after<=now() AND ${hasPermit('signIns')} ORDER BY retry_after,source_key` : sql`WHERE retry_after IS NULL
          ${after ? sql`AND (version_at,order_key,source_key)>(${after.at}::timestamptz,${after.key},${after.source_key})` : sql``}
          ORDER BY version_at,order_key,source_key`} LIMIT ${size})
        SELECT ${utc(sql`h.version_at`)} AS at,h.order_key AS key,h.source_key,a.issuer,a.subject,i.user_id FROM heads h
        LEFT JOIN LATERAL (SELECT issuer,subject FROM nightmail_signin_attempts a WHERE a.ctid=h.source_tid
          AND abuse_key(a.issuer,a.subject)=h.source_key LIMIT 1) a ON true
        LEFT JOIN LATERAL (SELECT user_id FROM nightmail_oidc_identities i WHERE (i.issuer,i.subject)=(a.issuer,a.subject) LIMIT 1) i ON true
        ORDER BY h.version_at,h.order_key,h.source_key`);
      const last = page.at(-1);
      if (!retry) next = last && { at: last.at, key: last.key, source_key: last.source_key };
      const candidates = page.filter((r): r is SignInPosition & Candidate => r.issuer!==null && r.subject!==null);
      const keys = (r: Candidate) => [guardKey(subjectGuard(r.issuer,r.subject)),guardKey({type:'attempt',id:attemptEntity(runtime.config,r.issuer,r.subject)}),
        ...(r.user_id ? [guardKey({type:'user',id:r.user_id})] : [])];
      const held = candidates.length ? await tryGuards(tx,candidates.flatMap(keys)) : new Set<string>();
      const ready = candidates.filter(r => keys(r).every(k => held.has(k)));
      if (retry && ready.length<candidates.length) retries=false;
      busy ||= ready.length < candidates.length;
      // A fresh READ COMMITTED statement after taking the locks: erasures, exclusions,
      // admissions and replacements committed since discovery are visible here.
      const { rows } = ready.length ? await tx.execute<Candidate & WorkVersion & { observed: unknown }>(sql`SELECT a.issuer,a.subject,i.user_id,a.observed,a.attempts,${signInKey} AS source_key,${utc(sql`a.last_at`)} AS at
        FROM jsonb_to_recordset(${JSON.stringify(ready)}::jsonb) r(issuer text,subject text,user_id text)
        JOIN LATERAL (SELECT * FROM nightmail_signin_attempts a WHERE (a.issuer,a.subject)=(r.issuer,r.subject) LIMIT 1) a ON true
        LEFT JOIN LATERAL (SELECT user_id FROM nightmail_oidc_identities i WHERE (i.issuer,i.subject)=(a.issuer,a.subject) LIMIT 1) i ON true
        WHERE ${where} AND i.user_id IS NOT DISTINCT FROM r.user_id ORDER BY a.last_at,md5(a.issuer||' '||a.subject)`) : { rows: [] };
      const current = new Set(rows.map(r => r.source_key));
      const stale = [...page.filter(r => r.subject===null),...ready.filter(r => !current.has(r.source_key))];
      if (stale.length) await tx.execute(sql`WITH removed AS (DELETE FROM abuse_signin_queue WHERE source_key=ANY(${sql.param(stale.map(r=>r.source_key))}::text[]) RETURNING 1)
        UPDATE abuse_state SET signin_rescan=true WHERE id='monitor' AND EXISTS (SELECT FROM removed)`);
      if (!rows.length) return { read: page.length, folded: 0, added: 0, known: retry };
      const validated = rows.map(({ observed, ...r }) => {
        const signals = Observed.safeParse(observed).data;
        return { ...r, signals, attempt: attemptEntity(runtime.config,r.issuer,r.subject) };
      });
      await graphLock(tx);
      let added = 0;
      const fold = async () => {
        if (validated.some(r=>!r.signals)) throw new InvalidObservation();
        const result = await tx.execute<{ added: number }>(sql`SELECT abuse_fold_signins(${JSON.stringify(validated)}::jsonb,
          ${busy || retry ? null : JSON.stringify(next)}::jsonb) AS added`);
        await wakeClusters(tx, validated.map(r => r.user_id ? { type: 'user', id: r.user_id } : { type: 'attempt', id: r.attempt }));
        added = result.rows[0]!.added;
      };
      folding = true;
      if (rows.length === 1) {
        if (!await isolateItem(tx,'signIns',rows[0]!,fold)) return {read: page.length,folded: 0,added: 0,known: retry};
      } else await fold();
      return { read: page.length, folded: rows.length, added, known:retry };
    }).catch(error => {
      // A failed batch has no committed writes. Isolate errors one at a time;
      // infrastructure failures leave the item untouched and cut the whole stage.
      if (!folding || size === 1 || !itemReason(error)) throw error;
      run.batchSize = 1;
      return {read: 0,folded: 0,added: 0,retry: true};
    });
    if ('retry' in batch) continue;
    after = next;
    retryTurn=!batch.known;
    items += batch.folded; run.items = items; run.added += batch.added;
    if (batch.folded) {
      log('info', { code: 'ABUSE_SIGNIN_BATCH', items: batch.folded, msPerItem: (Date.now()-started)/batch.folded });
      // A whole successful batch earns back capacity, including across job cuts.
      if (!batch.known && batch.folded===size) run.batchSize=Math.min(BATCH_SIZE,run.batchSize*2);
    }
    if (batch.known) {
      if (!batch.read) retries=false;
      continue;
    }
    if (items < SIGN_INS_A_RUN && batch.read < size) {
      if (retries) continue;
      if (busy) { cut(run,'signIns','limit'); return items; }
      const reset = await bounded(runtime,tx=>tx.execute<{rescan:boolean}>(sql`WITH prior AS MATERIALIZED (
        SELECT signin_rescan OR EXISTS (SELECT FROM abuse_signin_queue WHERE retry_after IS NULL) AS rescan FROM abuse_state WHERE id='monitor')
        UPDATE abuse_state SET signin_scan_block=0,signin_scan_end=NULL,signin_rescan=false,signin_seek=NULL FROM prior
        WHERE id='monitor' AND signin_scan_block<0 RETURNING prior.rescan`));
      if (reset.rows[0] && !reset.rows[0].rescan) return items;
      scanning=true; after=undefined;
    }
  }
  cut(run,'signIns'); return items;
}

async function foldPayments(runtime: Hosted, run: Run) {
  const legacy = run.cursors.payments, where = eligiblePayment(sql`${run.since}::timestamptz`,sql`${legacy?.at ?? null}::timestamptz`,sql`${legacy?.id ?? null}::text`);
  let items = 0;
  const skipped: string[] = [];
  while (!spent(run) && items + skipped.length < PAYMENTS_A_RUN) {
    const folded = await bounded(runtime, async tx => {
      const { rows: [row] } = await tx.execute<{ id: string; workspace_id: string }>(sql`SELECT p.id,p.workspace_id FROM billing_payment_attempts p
        WHERE ${where} AND NOT (p.id=ANY(${sql.param(skipped)}::text[])) ORDER BY ${workOrder('payments',paymentKey,sql`p.updated_at`)},p.id LIMIT 1`);
      if (!row) return null;
      const workspace: Guard & Entity = { type: 'workspace', id: row.workspace_id };
      if (!(await tryGuards(tx,[guardKey(workspace)])).size) return { busy: row.id, added: 0 };
      // Payment records can outlive both their erased receipts and the 90-day
      // privacy floor. Never reconstruct an already-expired card signal from one.
      const { rows: [current] } = await tx.execute<{ fingerprint: string | null; at: string; source_key: string }>(sql`SELECT
        CASE WHEN p.updated_at>=now()-interval '90 days' AND NOT ${workspaceExcluded(sql`p.workspace_id`)} THEN p.card_fingerprint END AS fingerprint,${paymentKey} AS source_key,${utc(sql`p.updated_at`)} AS at
        FROM billing_payment_attempts p WHERE p.id=${row.id} AND p.workspace_id=${workspace.id} AND ${where}`);
      if (!current) return { busy: row.id, added: 0 };
      let added = 0;
      if (current.fingerprint) await graphLock(tx);
      const ok = await isolateItem(tx,'payments',current,async () => {
        if (current.fingerprint) {
          const card = [{ kind: 'card', value: signalHash(runtime.config,'card',current.fingerprint), at: current.at }];
          added = await writeSignals(tx,workspace,[workspace],card,false);
          await trimSignals(tx,workspace); await linkEntity(tx,workspace,card);
          await wakeClusters(tx,[workspace]);
        }
        await tx.execute(sql`INSERT INTO abuse_work_versions(stage,source_key,version_at) VALUES('payments',${current.source_key},${current.at}::timestamptz)
          ON CONFLICT(stage,source_key,version_at,version_count) DO UPDATE SET failures=0,reason=NULL,retry_after=NULL,first_failed_at=NULL`);
      });
      return { busy: null, added, retry: !ok };
    });
    if (folded === null) {
      if (skipped.length) cut(run,'payments','limit');
      return items;
    }
    if ('retry' in folded && folded.retry) continue;
    if (folded.busy !== null) skipped.push(folded.busy);
    else { run.added += folded.added; run.items = ++items; }
  }
  cut(run,'payments'); return items;
}
// Mail the provider accepted through the Hosted pool: not simulated, with the provider's message ID, and dispatched
// on a feedback topic recorded as a Hosted pool's. Mail without that record (scheduled, canceled, suppressed, rejected,
// a connected account's, or older than the record) never qualifies.
const hostedAccepted = (mail: SQL) => sql`NOT ${mail}.simulated AND ${mail}.provider_id IS NOT NULL AND ${mail}.status NOT IN ('scheduled','queued','attempting','canceled','suppressed','rejected','rendering_failed','acceptance_unknown','simulated')
  AND EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn=${mail}.feedback_topic_arn AND h.kind='shared')`;
// Mail that reaches no one outside the workspace, much of it the same for every new workspace, says nothing about what
// the workspace sends and is never fingerprinted: Nightmail's own words (the dashboard's test email, and onboarding's
// setup email sent unchanged: screened as 'platform'), a campaign test, and anything addressed only to the members' own
// verified sign-in addresses (onboarding's setup email as edited, every send from the built-in domain while it sends to
// members only). The members rule is the built-in domain's (send_admission).
const ownMail = (mail: SQL) => sql`(${mail}.snapshot @> '{"screenVerdict":{"status":"platform"}}'::jsonb OR ${mail}.snapshot->>'testCampaignId' IS NOT NULL
  OR NOT EXISTS (SELECT FROM jsonb_array_elements_text(${mail}.to_addresses||${mail}.cc_addresses||${mail}.bcc_addresses) r(address) WHERE NOT EXISTS (
    SELECT FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=${mail}.workspace_id AND u.email_verified AND lower(u.email)=lower(r.address))))`;
/** How long after its stamp an accepted event may become visible, as far as the sample's mark assumes (settledThrough). */
export const SAMPLE_SETTLE = { marginMs: 15 * 60_000 };
/** Which limit decided how far a sample run may record a read (sampleBound). */
export type SampleBound = {
  /** The instant, or null: no marks for a workspace with nothing eligible this run. */
  at: string | null;
  /** margin: SAMPLE_SETTLE alone. writer: an open writer of sent-mail events started earlier. hidden: one whose start
   *  this role cannot see holds the write lock. unreadable: the check failed. missing: no sending_email_events table. */
  rule: 'margin' | 'writer' | 'hidden' | 'unreadable' | 'missing';
  /** Open writers of sent-mail events (sessions holding the write lock), how many of them hidden, the oldest's age in
   *  seconds (visible ones), and their process IDs (for a test's failure message; never logged). */
  writers: number; hidden: number; oldestSeconds: number | null; pids: number[];
};
/**
 * The latest instant a read can be recorded through without skipping mail that becomes visible after it. Accepted mail
 * is stamped with clock_timestamp() inside the statement that writes it (dispatcher.ts recordOutcomes, sending/events.ts
 * persistEmailEvent and ingestRoutineSesEvents; check-premerge.ts "Accepted mail stamp" refuses any other stamp;
 * simulated mail, stamped with the Worker's clock, is never sampled: NOT v.simulated below). Such a statement takes
 * RowExclusiveLock on sending_email_events (or the partition it names) when it starts, before any row is stamped, and
 * the transaction holds it to its end. So a row that can still become visible with a stamp earlier than now belongs to
 * a transaction that holds that lock now, whoever owns it: pg_locks lists every session's locks (fast-path ones too) to
 * every role, unlike pg_stat_activity, which hides another role's start. The instant is the earlier of:
 * - the start of the oldest session holding that lock (its rows are stamped at or after it): a writer that takes the
 *   lock after this check stamps after it;
 * - SAMPLE_SETTLE.marginMs before now: a stamp that is not this clock's inside its statement (a writer check-premerge
 *   doesn't see, a clock step), for as long as the margin.
 * A session holding the lock whose activity is hidden from this role (another role: its state and start read null), or
 * a prepared transaction holding it (no session), makes it unknown: null, never ignored. One of ours shown idle has
 * ended the transaction that held it since pg_locks was read (or begins one after the snapshot): nothing. Sessions that hold no such lock (autovacuum, a long read, an idle transaction)
 * hold nothing back. Waiting lock requests count too. The margin is measured from this statement's start, before it
 * reads pg_locks or pg_stat_activity (a snapshot taken at its first read in a transaction, so cleared first): a
 * lock-holder with no activity row has ended (its rows are visible to the reads, which all start after this check) or
 * began after the snapshot, so after the statement started, and stamps later than the mark.
 */
export async function sampleBound(runtime: Hosted): Promise<SampleBound> {
  const none = { writers: 0, hidden: 0, oldestSeconds: null, pids: [] };
  try {
    const { rows: [view] } = await bounded(runtime, async tx => {
      await tx.execute(sql`SELECT pg_stat_clear_snapshot()`);
      return tx.execute<{ found: boolean; at: string; writer: boolean; writers: number; hidden: number; oldest: number | null; pids: number[] | null }>(sql`WITH RECURSIVE
        target(oid) AS (SELECT to_regclass('sending_email_events')::oid UNION SELECT i.inhrelid FROM pg_inherits i JOIN target t ON i.inhparent=t.oid),
        holders AS (SELECT DISTINCT l.pid FROM pg_locks l WHERE l.locktype='relation' AND l.mode='RowExclusiveLock'
          AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.relation IN (SELECT oid FROM target WHERE oid IS NOT NULL)
          AND l.pid IS DISTINCT FROM pg_backend_pid()),
        seen AS (SELECT h.pid,a.pid IS NOT NULL AS listed,a.state IS NULL AS hidden,a.xact_start FROM holders h LEFT JOIN pg_stat_activity a ON a.pid=h.pid),
        margin AS (SELECT statement_timestamp()-make_interval(secs=>${SAMPLE_SETTLE.marginMs / 1000}) AS at)
        SELECT (SELECT bool_or(oid IS NOT NULL) FROM target) AS found,
          ${utc(sql`(least((SELECT at FROM margin),min(s.xact_start))-interval '1 microsecond')`)} AS at,
          coalesce(min(s.xact_start)<(SELECT at FROM margin),false) AS writer,
          count(*) FILTER (WHERE s.pid IS NULL OR (s.listed AND (s.hidden OR s.xact_start IS NOT NULL)))::int AS writers,
          count(*) FILTER (WHERE s.pid IS NULL OR (s.listed AND s.hidden))::int AS hidden,
          extract(epoch FROM clock_timestamp()-min(s.xact_start))::float8 AS oldest,
          array_agg(s.pid) FILTER (WHERE s.listed AND (s.hidden OR s.xact_start IS NOT NULL)) AS pids
        FROM seen s`);
    });
    if (!view?.found) return { at: null, rule: 'missing', ...none };
    const found = { writers: view.writers, hidden: view.hidden, oldestSeconds: view.oldest === null ? null : Math.round(view.oldest), pids: view.pids ?? [] };
    if (view.hidden > 0) return { at: null, rule: 'hidden', ...found };
    return { at: view.at, rule: view.writer ? 'writer' : 'margin', ...found };
  } catch (error) {
    if (timeError(error)) throw error;
    return { at: null, rule: 'unreadable', ...none };
  }
}
/**
 * sampleBound for a run, said in the logs and counted: a run that may set no marks logs ABUSE_SAMPLE_MARKS_HELD with
 * which rule held them, and abuse_state.sample_held counts such runs in a row (Health: abuse-sample-held); a run whose
 * marks an open writer older than the margin capped logs ABUSE_SAMPLE_MARKS_CAPPED with its age. Never a query, a role
 * or a process ID.
 */
async function settledThrough(runtime: Hosted) {
  const bound = await sampleBound(runtime);
  if (bound.at === null) log('error', { code: 'ABUSE_SAMPLE_MARKS_HELD', reason: bound.rule, writers: bound.writers, hidden: bound.hidden });
  else if (bound.rule === 'writer') log('info', { code: 'ABUSE_SAMPLE_MARKS_CAPPED', writers: bound.writers, oldestSeconds: bound.oldestSeconds });
  try { await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_state SET sample_held=CASE WHEN ${bound.at === null} THEN least(sample_held+1,32767) ELSE 0 END WHERE id='monitor'`)); }
  catch (error) { if (timeError(error)) throw error; log('warn', { code: 'ABUSE_STEP_FAILED', step: 'sampleHeld' }); }
  return bound.at;
}
/**
 * Fingerprints a bounded sample of the mail each workspace had accepted since it was last sampled, its own mail
 * (ownMail) left out: content bands and the hashed domains it links to and sends from (never the built-in domain, whose
 * root every workspace shares), dated by the acceptance. Never mail accepted before monitoring
 * started, before the workspace's last erasure or more than a day ago, and never a message (or a campaign's frozen
 * review) created before monitoring started, so nothing scheduled earlier is read. Workspaces are visited in ID order
 * from a stored cursor, a page at a time. A workspace is read only when it accepted mail past how far it was last read
 * (abuse_sampling.sampled_through), recorded whether or not any of that mail was eligible: one whose mail is all its own,
 * or not through the Hosted pool, costs nothing again until it accepts more.
 */
async function sampleSends(runtime: Hosted, run: Run) {
  let sampled = 0;
  // No time left for it at all: said so, as any stop with work left.
  if (spent(run)) { cut(run, 'sample'); return 0; }
  // How far a read of a workspace with nothing eligible can be recorded without skipping mail that becomes visible
  // late: the earlier of two bounds, each covering what the other cannot (settledThrough). Hidden or unreadable: no mark.
  const settled = await settledThrough(runtime);
  const floor = (workspaceId: SQL) => sql`greatest(coalesce((SELECT s.sampled_through FROM abuse_sampling s WHERE s.workspace_id=${workspaceId}),'-infinity'::timestamptz),
    coalesce((SELECT f.ignore_through FROM abuse_floors f WHERE f.entity_type='workspace' AND f.entity_id=${workspaceId}),'-infinity'::timestamptz),${run.since}::timestamptz,now()-interval '1 day')`;
  for (let page = 0; page < WORKSPACE_PAGES && sampled < SAMPLED_A_RUN && !spent(run); page++) {
    const start = run.cursors.workspaces ?? '';
    const { rows: ids } = await bounded(runtime, tx => tx.execute<{ id: string }>(sql`SELECT id FROM workspaces WHERE id>${start} ORDER BY id LIMIT ${WORKSPACE_PAGE}`));
    if (!ids.length) { await bounded(runtime, tx => tx.execute(samplePosition(''))); break; }
    const { rows: due } = await bounded(runtime, tx => tx.execute<{ id: string }>(sql`SELECT w.id FROM unnest(${sql.param(ids.map(row => row.id))}::text[]) AS w(id)
      WHERE NOT ${workspaceExcluded(sql`w.id`)}
        AND EXISTS (SELECT FROM sending_email_events v WHERE v.workspace_id=w.id AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor(sql`w.id`)})
      ORDER BY w.id`));
    for (const workspace of due) {
      // Out of time or work: the next run starts at this workspace.
      if (sampled >= SAMPLED_A_RUN || spent(run)) { cut(run, 'sample'); return sampled; }
      // A workspace whose sample fails or times out is skipped until the cursor comes round again.
      try {
        const added = await bounded(runtime, tx => sampleWorkspace(runtime, tx, run, workspace.id, floor(sql`${workspace.id}`), settled));
        run.advanced = true; // The workspace cursor committed even if no mail qualified.
        if (added !== null) { run.added += added; run.items = ++sampled; }
      } catch (error) {
        if (timeError(error)) throw error;
        log('warn', { code: 'ABUSE_STEP_FAILED', step: 'workspace' });
      }
    }
    run.cursors.workspaces = ids.length < WORKSPACE_PAGE ? '' : ids.at(-1)!.id;
    await bounded(runtime, tx => tx.execute(samplePosition(run.cursors.workspaces!)));
    run.advanced ||= ids.length === WORKSPACE_PAGE;
    if (ids.length < WORKSPACE_PAGE) break;
    // The next page waits for the next run: out of time, work or pages.
    if (page + 1 >= WORKSPACE_PAGES || sampled >= SAMPLED_A_RUN || spent(run)) cut(run, 'sample', sampled >= SAMPLED_A_RUN || page + 1 >= WORKSPACE_PAGES ? 'limit' : undefined);
  }
  return sampled;
}
async function sampleWorkspace(runtime: Hosted, tx: AbuseTx, run: Run, workspaceId: string, floor: SQL, settled: string | null) {
  const workspace: Entity = { type: 'workspace', id: workspaceId }, guards = [workspace as Guard];
  // Under the workspace's lock, its exclusions and floor are read again before any content is.
  await lockGuards(tx, guards);
  run.checked = (run.checked ?? 0) + 1;
  // With nothing eligible: read through its newest accepted mail, never past what is surely visible (settled), never
  // back from an earlier read.
  const readThrough = settled === null ? null : sql`INSERT INTO abuse_sampling(workspace_id,sampled_through) SELECT ${workspaceId},least(max(v.created_at),${settled}::timestamptz) FROM sending_email_events v
    WHERE v.workspace_id=${workspaceId} AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor} HAVING max(v.created_at) IS NOT NULL
    ON CONFLICT (workspace_id) DO UPDATE SET sampled_through=greatest(abuse_sampling.sampled_through,excluded.sampled_through),sampled_at=clock_timestamp()`;
  const { rows: recent } = await tx.execute<{ id: string; review_id: string | null; campaign_id: string | null; subject: string; at: string }>(sql`WITH position AS (${samplePosition(workspaceId)}) SELECT e.id,e.review_id,e.campaign_id,e.subject,${utc(sql`v.created_at`)} AS at
    FROM sending_email_events v JOIN sending_emails e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    LEFT JOIN sending_campaign_reviews r ON r.workspace_id=e.workspace_id AND r.id=e.review_id
    WHERE v.workspace_id=${workspaceId} AND v.type='accepted' AND NOT v.simulated AND v.created_at>${floor} AND NOT ${excluded(guards)} AND ${hostedAccepted(sql`e`)} AND NOT ${ownMail(sql`e`)}
      AND e.created_at>=${run.since}::timestamptz AND (e.review_id IS NULL OR r.created_at>=${run.since}::timestamptz)
    ORDER BY v.created_at DESC LIMIT 40`);
  // Nothing to fingerprint (all its own mail, or not through the Hosted pool): recorded, so it is not read again for it.
  if (!recent.length) { if (readThrough) await tx.execute(readThrough); return null; }
  // One message per campaign or subject first, so a single large campaign doesn't use up the sample.
  const picked = [...new Map(recent.map(row => [row.review_id ?? row.campaign_id ?? row.subject, row])).values()].slice(0, MESSAGES_A_WORKSPACE);
  const { rows: mail } = await tx.execute<{ id: string; sender: string; html: string | null; text: string | null }>(sql`SELECT e.id,e.from_address AS sender,
      left(coalesce(r.rendered->>'html',e.snapshot->>'html'),24000) AS html,left(coalesce(r.rendered->>'text',e.snapshot->>'text'),8000) AS text
    FROM sending_emails e LEFT JOIN sending_campaign_reviews r ON r.workspace_id=e.workspace_id AND r.id=e.review_id
    WHERE e.workspace_id=${workspaceId} AND e.id=ANY(${sql.param(picked.map(row => row.id))}::text[]) AND ${hostedAccepted(sql`e`)}`);
  const signals: Signal[] = [];
  for (const message of mail) {
    const { subject, at } = picked.find(row => row.id === message.id)!;
    for (const band of contentFingerprint(runtime.config, subject, message.html, message.text) ?? []) signals.push({ kind: 'content', value: band, at });
    for (const domain of await linkDomains(message.html, message.text)) signals.push({ kind: 'link', value: signalHash(runtime.config, 'link', domain), at });
    const host = message.sender.slice(message.sender.lastIndexOf('@') + 1), sender = isBuiltinHost(runtime.config, host) ? null : await registrableDomain(host);
    if (sender) signals.push({ kind: 'send_domain', value: signalHash(runtime.config, 'send_domain', sender), at });
  }
  await graphLock(tx);
  const added = await writeSignals(tx, workspace, guards, signals, false);
  await trimSignals(tx, workspace);
  await linkEntity(tx, workspace, signals);
  await wakeClusters(tx, [workspace]);
  // Sampled: through the newest message it fingerprinted, as before (re-reading sampled mail would wake its links and
  // clusters again for nothing).
  await tx.execute(sql`INSERT INTO abuse_sampling(workspace_id,sampled_through) VALUES(${workspaceId},${recent[0]!.at}::timestamptz)
    ON CONFLICT (workspace_id) DO UPDATE SET sampled_through=excluded.sampled_through,sampled_at=now()`);
  return added;
}
const samplePosition = (id: string) => sql`UPDATE abuse_state SET cursors=jsonb_set(cursors,'{workspaces}',to_jsonb(${id}::text)) WHERE id='monitor'`;
const STAGES = ['signIns','payments','clusters','sample'] as const;
export type AbuseStage = typeof STAGES[number];
const budgets: Record<AbuseStage,number> = { signIns: 5000, payments: 5000, clusters: 8000, sample: 20_000 };
const timeError = (error: unknown) => error instanceof StageDeadline || ['57014','55P03'].includes(databaseCodeOf(error) ?? '');

async function wakeClusters(tx: AbuseTx, members: Entity[]) {
  // The scorer may already have read a member before this fold. Revisit its score
  // even when only a flag changed. Keep the original due time while work is pending.
  await tx.execute(sql`WITH dirty AS (UPDATE abuse_clusters c SET score_requested_at=statement_timestamp()
    WHERE score_requested_at IS NULL AND id IN (SELECT m.cluster_id FROM abuse_cluster_members m
      JOIN jsonb_to_recordset(${JSON.stringify(members)}::jsonb) e(type text,id text) ON (m.entity_type,m.entity_id)=(e.type,e.id)) RETURNING id)
    UPDATE jobs SET status=CASE WHEN status='running' THEN status ELSE 'pending' END,
      payload=payload||jsonb_build_object('revision',coalesce((payload->>'revision')::bigint,0)+1),
      available_at=CASE WHEN status='pending' AND NOT (payload ? 'waitingForItem' AND
        (EXISTS (SELECT FROM dirty) OR EXISTS (SELECT FROM identity_links l JOIN jsonb_to_recordset(${JSON.stringify(members)}::jsonb) m(type text,id text)
          ON (m.type,m.id) IN ((l.a_type,l.a_id),(l.b_type,l.b_id)) WHERE l.pending AND NOT EXISTS (SELECT FROM abuse_work_versions v
            WHERE v.stage='links' AND v.source_key=abuse_key(l.a_type,l.a_id) AND v.failures>0)))) THEN available_at ELSE now() END,
      attempts=CASE WHEN status='running' THEN attempts ELSE 0 END
    WHERE id='abuse.stage.clusters' AND (EXISTS (SELECT FROM dirty) OR EXISTS (SELECT FROM identity_links WHERE pending))`);
}

/** The tick only seeds durable jobs and sweeps alert delivery. An infinite legacy lease
 * prevents an old hourly worker from folding concurrently during a rolling upgrade. */
export async function seedAbuseStages(runtime: Hosted, hourly = false) {
  if (!runtime.config.multiTenant) return null;
  if (!monitoring(runtime.config)) {
    if (!hourly) return null;
    await bounded(runtime, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(327461638,0)`);
      await tx.execute(sql`DELETE FROM abuse_state WHERE lease_until IS NULL OR lease_until<=now() OR lease_until='infinity'`);
    });
    return null;
  }
  const since = runtime.config.abuseMonitoring!.since;
  const ready = await bounded(runtime, async tx => {
    const active = await tx.execute(sql`SELECT FROM abuse_state WHERE id='monitor' AND configured=${since}::timestamptz AND lease_until='infinity'`);
    if (!active.rowCount) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(327461638,0)`);
      const state = await tx.execute(sql`INSERT INTO abuse_state AS s(id,configured,active_since,lease_until)
        VALUES('monitor',${since}::timestamptz,greatest(${since}::timestamptz,now()),'infinity')
        ON CONFLICT (id) DO UPDATE SET lease_until=excluded.lease_until,configured=excluded.configured,
          active_since=CASE WHEN s.configured=excluded.configured THEN s.active_since ELSE excluded.active_since END,
          signin_scan_block=CASE WHEN s.configured=excluded.configured THEN s.signin_scan_block ELSE 0 END,
          signin_scan_end=CASE WHEN s.configured=excluded.configured THEN s.signin_scan_end END,
          cursors=CASE WHEN s.configured=excluded.configured THEN s.cursors ELSE '{}'::jsonb END
        WHERE s.lease_until IS NULL OR s.lease_until<=now() OR s.lease_until='infinity' RETURNING id`);
      if (!state.rowCount) return false;
    }
    // Even a long drain or a held subject gets a fresh source sweep on the
    // hourly tick. Never restart a partial sweep or pull its pending job forward.
    if (hourly) await tx.execute(sql`UPDATE abuse_state SET signin_scan_block=0,signin_scan_end=NULL
      WHERE id='monitor' AND signin_scan_block<0`);
    await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT t,t,'platform','{}'::jsonb
      FROM unnest(${sql.param(STAGES.map(s => 'abuse.stage.'+s))}::text[]) t ORDER BY t
      ON CONFLICT(id) ${hourly ? sql`DO UPDATE SET status='pending',available_at=now(),attempts=0,last_error=NULL,lease_until=NULL,
        payload=jobs.payload-'stalls'-'batchSize' WHERE jobs.status IN ('completed','failed')` : sql`DO NOTHING`}`);
    return true;
  });
  return ready || null;
}

export async function abuseHourly(runtime: Hosted) {
  if (!await seedAbuseStages(runtime,true)) return null;
  await (await import('./abuse-alerts.js')).sweepAlerts(runtime);
  return true;
}

// The server timeout bounds SQL. This wall clock also bounds waiting for a pooled connection,
// a network stall, and COMMIT. Destroy an overdue connection: a detached transaction must
// never keep running after its job gives up its lease. Receipts cover an uncertain COMMIT.
async function withStageConnection<T>(host: Hosted, deadline: number, work: (db: Hosted['db']) => Promise<T>) {
  const pool = (host.db as Hosted['db'] & { $client?: Pool | Client }).$client;
  if (!pool || !('totalCount' in pool)) return work(host.db);
  let client: PoolClient | undefined, expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const connection = pool.connect().then(async acquired => {
    if (expired) { acquired.release(); throw new StageDeadline(); }
    client = acquired;
    try { return await work(drizzle(acquired)); }
    finally { if (!expired) acquired.release(); }
  });
  try {
    return await Promise.race([connection, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; client?.release(true); reject(new StageDeadline()); }, Math.max(0,deadline-Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export async function runAbuseStage(host: Hosted, stage: AbuseStage, budget = budgets[stage], batchSize = BATCH_SIZE) {
  const started = Date.now(), runtime = { ...host, stage, deadline: Math.min(started+budget,host.deadline ?? Infinity,host.lease ? Date.parse(host.lease) : Infinity) };
  let retryAt: string | null = null;
  let items = 0, added = 0, checked = 0, stopped: Cut | undefined;
  let active: Run | undefined;
  if (monitoring(host.config)) try {
    await withStageConnection(host,runtime.deadline,async db => {
      runtime.db = db;
      const { rows: [state] } = await bounded(runtime, tx => tx.execute<{ since: string; cursors: Cursors; scanningSignIns:boolean; signInSeek:SignInPosition | null }>(sql`SELECT ${utc(sql`active_since`)} AS since,cursors,signin_scan_block>=0 AS "scanningSignIns",signin_seek AS "signInSeek"
        FROM abuse_state WHERE configured=${host.config.abuseMonitoring!.since}::timestamptz AND lease_until='infinity'
        ${runtime.lease ? sql`AND EXISTS (SELECT FROM jobs WHERE id=${'abuse.stage.'+stage} AND status='running' AND lease_until=${runtime.lease}::timestamptz)` : sql``}`));
      if (state) {
        runtime.epoch = state.since;
        const run: Run = active = { ...state, batchSize, advanced: false, deadline: runtime.deadline, items: 0, added: 0, cuts: {}, checked: 0 };
        if (stage === 'signIns') items = await foldSignIns(runtime,run);
        if (stage === 'payments') items = await foldPayments(runtime,run);
        if (stage === 'sample') items = await sampleSends(runtime,run);
        if (stage === 'clusters') {
          const { refreshClusters } = await import('./abuse-clusters.js');
          const r = await refreshClusters(runtime,runtime.deadline,() => { run.items++; });
          items = r.grouped+r.rescored;
          if (r.cut) cut(run,stage,r.cut);
        }
        added = run.added; checked = run.checked ?? 0; stopped = run.cuts[stage];
        if (!stopped && stage!=='sample' && host.lease) {
          const {rows:[waiting]} = await bounded(runtime,tx=>tx.execute<{at:string|null}>(sql`SELECT
            CASE WHEN min(retry_after) IS NOT NULL THEN min(greatest(retry_after,slot_due)) END AS at FROM (SELECT live.retry_after,
                (SELECT min(available_at) FROM abuse_retry_slots WHERE stage=live.stage) AS slot_due FROM (${liveFailures(stage)}) live) due`));
          retryAt=waiting!.at;
        }
      }
    });
  } catch (error) {
    if (!timeError(error)) {
      if (!host.lease) throw error;
      log('error',{code:'ABUSE_STAGE_FAILED',stage,reason:databaseCodeOf(error) ?? 'STAGE_ERROR'});
    }
    stopped = timeError(error) ? 'time' : 'retry'; items = active?.items ?? 0; added = active?.added ?? 0; checked = active?.checked ?? 0;
  }
  if (stopped) log(stopped === 'time' ? 'warn' : 'info', { code: 'ABUSE_STEP_CUT', step: stage, reason: stopped });
  log('info', { code: 'ABUSE_STAGE', step: stage, items, added, ...(stage === 'sample' && { checked }), ms: Date.now()-started, cut: stopped });
  return { items, added, checked, retryAt: retryAt as string|null, cut: stopped, advanced: items > 0 || !!active?.advanced, batchSize: active?.batchSize ?? batchSize };
}

// A cut needs time to make its singleton due again. Bound the queue's status write as
// well as the fold; on an unavailable database the existing lease recovers the row.
export async function settleStage(host: Hosted, type: string, started: number, statement: SQL) {
  const stage = STAGES.find(s => type === 'abuse.stage.'+s);
  const deadline = Math.min(Date.now()+STATEMENT_MS, started+(stage ? budgets[stage] : 0)+STATEMENT_MS);
  return withStageConnection(host,deadline,db => bounded({ ...host, db, deadline },tx => tx.execute(statement)));
}

export const abuseStageJob: JobHandler = async (runtime,payload,job) => {
  const stage = STAGES.find(s => job.id==='abuse.stage.'+s);
  if (!stage) throw new Error('Unknown abuse stage');
  const scoped = { ...runtime, lease: job.leaseFence, deadline: (job.startedAt ?? Date.now())+budgets[stage] };
  const batchSize = Math.max(1,Math.min(BATCH_SIZE,Number(payload.batchSize) || BATCH_SIZE));
  const { waitingForItem: _waiting, ...continuation } = payload;
  const result = await runAbuseStage(scoped,stage,budgets[stage],batchSize);
  const defer = () => {
    const stalls = result.advanced ? 0 : Math.min(6,(Number(payload.stalls) || 0)+1);
    const delay = stalls ? Math.min(900,30*2**(stalls-1)) : 0;
    const size = result.cut==='time' && !result.advanced ? Math.max(1,Math.floor(result.batchSize/2)) : result.batchSize;
    if (delay) log('warn',{code:'ABUSE_STAGE_BACKOFF',stage,delay,batchSize:size});
    throw new JobDeferred(new Date(Date.now()+1000*delay).toISOString(),{...continuation,stalls,batchSize:size});
  };
  if (result.cut) defer();
  if (result.retryAt) {
    // A finished pass with only data retries left may sleep until the first
    // due item/permit. Never spin if another worker changed either meanwhile.
    const at=new Date(Math.max(Date.now()+15*60_000,new Date(result.retryAt).getTime())).toISOString();
    if (stage!=='clusters') throw new JobDeferred(at,{...payload,stalls:0,batchSize:result.batchSize});
    // A fresh grouping/scoring request can wake an idle scorer. Fence this
    // transition just like completion, or a concurrent wake could be lost.
    const waiting=await settleStage(runtime,job.id,job.startedAt ?? Date.now(),sql`UPDATE jobs SET
      status='pending',lease_until=NULL,last_error=NULL,attempts=0,available_at=${at}::timestamptz,
      payload=(payload-'stalls')||'{"waitingForItem":true}'::jsonb
      WHERE id=${job.id} AND status='running' AND lease_until=${job.leaseFence}::timestamptz AND
      coalesce((payload->>'revision')::bigint,0)=${Number(payload.revision ?? 0)} RETURNING id`);
    if (!waiting.rowCount) defer();
    return;
  }
  // Don't lose a writer's wake between the last empty read and settlement.
  if (stage==='clusters' && job.leaseFence) {
    if (scoped.deadline-Date.now()<2*WIRE_RESERVE_MS) defer();
    const settled = await withStageConnection(scoped,scoped.deadline,db => bounded({ ...scoped, db }, tx => tx.execute(sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL,payload=payload-'stalls'-'batchSize'-'waitingForItem'
      WHERE id=${job.id} AND status='running' AND lease_until=${job.leaseFence}::timestamptz AND
      coalesce((payload->>'revision')::bigint,0)=${Number(payload.revision ?? 0)} RETURNING id`))).catch(error => {
      if (timeError(error)) defer();
      throw error;
    });
    if (!settled.rowCount) defer();
  }
};

// Match current source versions in sets: a replaced/deleted source or a component
// already handled by another seed must disappear from Health without operator cleanup.
function liveFailures(stage?: AbuseStage) {
  const sources: SQL[] = [];
  if (!stage || stage==='signIns') sources.push(sql`SELECT 'signIns' AS stage,abuse_key(a.issuer,a.subject) AS key,a.last_at AS at,a.attempts AS n
    FROM nightmail_signin_attempts a WHERE observed IS NOT NULL AND EXISTS(SELECT FROM failed WHERE stage='signIns')`);
  if (!stage || stage==='payments') sources.push(sql`SELECT 'payments' AS stage,abuse_key(id) AS key,updated_at AS at,0 AS n
    FROM billing_payment_attempts WHERE EXISTS(SELECT FROM failed WHERE stage='payments')`);
  if (!stage || stage==='clusters') sources.push(sql`SELECT 'links' AS stage,abuse_key(a_type,a_id) AS key,min(pending_since) AS at,0 AS n
    FROM identity_links WHERE pending AND EXISTS(SELECT FROM failed WHERE stage='links') GROUP BY a_type,a_id
    UNION ALL SELECT 'scores',abuse_key(id),least(score_requested_at,scored_at+interval '30 minutes'),0
    FROM abuse_clusters WHERE EXISTS(SELECT FROM failed WHERE stage='scores')`);
  return sql`WITH failed AS MATERIALIZED (SELECT * FROM abuse_work_versions WHERE failures>0
    ${stage==='clusters' ? sql`AND stage IN ('links','scores')` : stage ? sql`AND stage=${stage}` : sql``}),
    current AS (${sql.join(sources,sql` UNION ALL `)})
    SELECT f.* FROM failed f JOIN current c ON (c.stage,c.key COLLATE "C",c.at,c.n)=(f.stage,f.source_key,f.version_at,f.version_count)`;
}
export const abuseFailures = sql`(SELECT json_object_agg(stage,json_build_object('count',n,'seconds',seconds)) FROM
  (SELECT stage,count(*) AS n,extract(epoch FROM now()-min(first_failed_at)) AS seconds FROM (${liveFailures()}) live GROUP BY stage) totals)`;

export const abuseLag = sql`(SELECT json_build_object(
  'sign-ins',extract(epoch FROM now()-(SELECT a.last_at FROM nightmail_signin_attempts a WHERE ${eligibleSignIn(sql`s.active_since`,sql`(s.cursors#>>'{signIns,at}')::timestamptz`,sql`s.cursors#>>'{signIns,key}'`,true)} ORDER BY a.last_at LIMIT 1)),
  'payments',extract(epoch FROM now()-(SELECT p.updated_at FROM billing_payment_attempts p WHERE ${eligiblePayment(sql`s.active_since`,sql`(s.cursors#>>'{payments,at}')::timestamptz`,sql`s.cursors#>>'{payments,id}'`,true)} ORDER BY p.updated_at LIMIT 1)),
  'pending links',extract(epoch FROM now()-(SELECT min(pending_since) FROM identity_links WHERE pending)),
  'cluster scoring',extract(epoch FROM now()-least((SELECT min(scored_at) FROM abuse_clusters WHERE scored_at<=now()-interval '30 minutes')+interval '30 minutes',(SELECT min(score_requested_at) FROM abuse_clusters))))
  FROM abuse_state s WHERE id='monitor')`;

// ----- A person's or a workspace's own signals ---------------------------------------------------------------------------
/** Whose signals a request is about: a user (with the workspaces they own and their sign-in subjects), one workspace,
 *  or a sign-in subject that was never admitted. */
export type SubjectTarget = { user: string } | { workspace: string } | { subject: { issuer: string; subject: string } };
/** Why an entity is excluded. One entity can be excluded for several reasons at once; each is lifted on its own. */
export const EXCLUSION_SOURCES = ['objection', 'agreement', 'operator'] as const;
export type ExclusionSource = (typeof EXCLUSION_SOURCES)[number];
/**
 * For an access, objection or erasure request (scripts/abuse-subject.ts), in one transaction under the entities' locks,
 * so no writer can add to what it removes:
 * - show: what is held, by kind and never by value, and the sources that exclude it;
 * - erase: deletes it and sets the floor, so nothing observed until now is recorded later either;
 * - exclude: erases, and records an exclusion under `source`. A user's exclusion covers the workspaces they own for
 *   as long as they own them; it is not copied onto the workspaces;
 * - include: lifts the exclusion of that `source` only, and sets the floor so the excluded time is never read.
 */
export async function abuseSubject(runtime: Hosted, target: SubjectTarget, action: 'show' | 'erase' | 'exclude' | 'include', options: { source?: ExclusionSource; reason?: string } = {}) {
  return runtime.db.transaction(async tx => {
    const subjects = 'user' in target ? (await tx.execute<{ issuer: string; subject: string }>(sql`SELECT issuer,subject FROM nightmail_oidc_identities WHERE user_id=${target.user}`)).rows : 'subject' in target ? [target.subject] : [];
    const owned = 'user' in target ? (await tx.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM workspace_members WHERE user_id=${target.user} AND role='owner'`)).rows.map(row => row.workspace_id)
      : 'workspace' in target ? [target.workspace] : [];
    // Exclusions sit on the user, the workspace or the subject itself; floors and locks also on what a user owns.
    const own: Guard[] = ['user' in target ? { type: 'user', id: target.user } : 'workspace' in target ? { type: 'workspace', id: target.workspace } : subjectGuard(target.subject.issuer, target.subject.subject),
      ...('user' in target ? subjects.map(s => subjectGuard(s.issuer, s.subject)) : [])];
    const guards: Guard[] = [...own, ...('user' in target ? owned.map(id => ({ type: 'workspace' as const, id })) : [])];
    const entities: Entity[] = [...('user' in target ? [{ type: 'user' as const, id: target.user }] : []), ...owned.map(id => ({ type: 'workspace' as const, id })),
      ...subjects.map(s => ({ type: 'attempt' as const, id: attemptEntity(runtime.config, s.issuer, s.subject) }))];
    const pairs = sql.join(entities.map(entity => sql`(${entity.type},${entity.id})`), sql`, `), source = options.source ?? 'objection';
    await lockGuards(tx, [...guards,...entities]);
    if (action !== 'show') await graphLock(tx,true);
    if (action === 'exclude') for (const guard of own) await tx.execute(sql`INSERT INTO abuse_exclusions(entity_type,entity_id,source,reason) VALUES(${guard.type},${guard.id},${source},${options.reason ?? ''})
      ON CONFLICT (entity_type,entity_id,source) DO UPDATE SET reason=excluded.reason`);
    if (action === 'include') await tx.execute(sql`DELETE FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${guardPairs(own)}) AND source=${source}`);
    if (action !== 'show') for (const guard of guards) await tx.execute(sql`INSERT INTO abuse_floors(entity_type,entity_id,ignore_through) VALUES(${guard.type},${guard.id},clock_timestamp())
      ON CONFLICT (entity_type,entity_id) DO UPDATE SET ignore_through=excluded.ignore_through`);
    if (action === 'erase' || action === 'exclude') {
      // Delete monitor receipts under the same guards as folding. A payment still
      // in its source log is covered by the erasure floor; no signal can return.
      for (const s of subjects) await tx.execute(sql`WITH hints AS (DELETE FROM abuse_signin_queue WHERE source_key=abuse_key(${s.issuer},${s.subject})),
        seek AS (UPDATE abuse_state SET signin_seek=NULL WHERE signin_seek->>'source_key'=abuse_key(${s.issuer},${s.subject}))
        DELETE FROM abuse_work_versions WHERE stage='signIns' AND source_key=abuse_key(${s.issuer},${s.subject})`);
      await tx.execute(sql`DELETE FROM abuse_work_versions WHERE
        (stage='payments' AND source_key IN (SELECT abuse_key(id) FROM billing_payment_attempts WHERE workspace_id=ANY(${sql.param(owned)}::text[])))
        OR (stage='scores' AND source_key IN (SELECT abuse_key(cluster_id) FROM abuse_cluster_members WHERE (entity_type,entity_id) IN (${pairs})))
        OR (stage='links' AND source_key IN (SELECT abuse_key(a_type,a_id) FROM identity_links WHERE (a_type,a_id) IN (${pairs}) OR (b_type,b_id) IN (${pairs})))`);
      await tx.execute(sql`DELETE FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs})`);
      // What was derived from them: their links, every alert about them, and the clusters they were in (the other members are grouped again).
      await tx.execute(sql`DELETE FROM identity_links WHERE (a_type,a_id) IN (${pairs}) OR (b_type,b_id) IN (${pairs})`);
      await tx.execute(sql`DELETE FROM abuse_alerts WHERE cluster_id IN (SELECT m.cluster_id FROM abuse_cluster_members m WHERE (m.entity_type,m.entity_id) IN (${pairs}))
        OR members && ${sql.param(entities.map(entity => `${entity.type}:${entity.id}`))}::text[]`);
      await tx.execute(sql`WITH left_behind AS (DELETE FROM abuse_clusters c USING abuse_cluster_members m WHERE m.cluster_id=c.id AND (m.entity_type,m.entity_id) IN (${pairs}) RETURNING c.members)
        UPDATE identity_links l SET pending=true FROM left_behind b, jsonb_to_recordset(b.members) AS e(type text,id text)
        WHERE NOT l.pending AND ((l.a_type,l.a_id)=(e.type,e.id) OR (l.b_type,l.b_id)=(e.type,e.id))`);
      // What a sign-in observed and the job has not read yet.
      for (const s of subjects) await tx.execute(sql`UPDATE nightmail_signin_attempts SET observed=NULL WHERE issuer=${s.issuer} AND subject=${s.subject} AND observed IS NOT NULL`);
    }
    const { rows: held } = await tx.execute<{ kind: string; values: number; first: string; last: string }>(sql`SELECT kind,count(*)::int AS values,min(first_at)::text AS first,max(last_at)::text AS last
      FROM abuse_signals WHERE (entity_type,entity_id) IN (${pairs}) GROUP BY kind ORDER BY kind`);
    const { rows: sources } = await tx.execute<{ source: string }>(sql`SELECT DISTINCT source FROM abuse_exclusions WHERE (entity_type,entity_id) IN (${guardPairs(own)}) ORDER BY source`);
    // recording: false while anything excludes it, its own exclusions or, for a workspace, an owner's.
    const { rows: [state] } = await tx.execute<{ excluded: boolean }>(sql`SELECT ${excluded(own)} AS excluded`);
    return { held, excluded: sources.map(row => row.source), recording: !state!.excluded, entities: entities.length };
  });
}
