import type { z } from '@hono/zod-openapi';
import { type SQL, sql, isNull, eq, and, gt, inArray, asc } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbExecutor, Actor, Runtime } from '../core/types.js';
import { ApiError } from '../core/errors.js';
import { rowId } from '../core/http.js';
import { log } from '../log.js';
import { lists, contacts, listMembers, listCounts, consentAudit } from '../db/audience.js';
import { enqueue } from '../jobs.js';
import { recordTopicChoices, topicStates } from '../topics.js';
import { skippedRisk, type Risk, staticRiskSql, peekHygieneLists, hygieneLists } from '../list-hygiene.js';
import { type listColumns, scope, Email, type ContactQuery, CONTACT_LIST_IDS_PAGE_MAX, contactBody, AUDIENCE_READ_MAX_BYTES, scopeValues, ContactInput, PropertiesInput } from './schemas.js';
import { inList } from './segments.js';

type ListRow = { [K in keyof typeof listColumns]: (typeof lists.$inferSelect)[K] };

// Literal substring search: %, _ and backslash have no wildcard meaning.
export function searchText(column: AnyPgColumn, search: string): SQL { return sql`strpos(lower(${column}), lower(${search})) > 0`; }
// The same match through the trigram index (migration 462). Fold the original term in Postgres before adding escapes; a
// custom escape leaves backslash literal.
function searchLike(column: AnyPgColumn, search: string): SQL {
  const escaped = sql`replace(replace(replace(lower(${search}), '!', '!!'), '%', '!%'), '_', '!_')`;
  return sql`lower(${column}) LIKE ('%' || ${escaped} || '%') ESCAPE '!'`;
}
// The trigram index returns every match before a page can be sorted: milliseconds for a rare term, seconds for one in a
// third of the workspace, and the planner can't tell them apart (a partial index's expressions have no statistics). So it
// is asked for at most this many matches; a term with more is common enough that the ID-order walk reaches its page first.
const TRIGRAM_CANDIDATES = 2_000;
async function trigramCandidates(db: DbExecutor, identity: Actor, search: string) {
  // With no guaranteed trigram, GIN can scan the whole index.
  if (!/[a-zA-Z0-9]{3}/.test(search) || wholeAddress(search)) return undefined;
  const { rows } = await db.execute<{ id: string }>(sql`SELECT ${contacts.id} AS id FROM ${contacts}
    WHERE ${scope(contacts, identity)} AND ${isNull(contacts.deletedAt)} AND (${searchLike(contacts.email, search)} OR ${searchLike(contacts.name, search)})
    LIMIT ${TRIGRAM_CANDIDATES + 1}`);
  return rows.length > TRIGRAM_CANDIDATES ? undefined : rows.map(row => row.id);
}
// A complete address uses the unique email index; other searches match a literal substring of either field.
const wholeAddress = (search: string | undefined) => { const address = Email.safeParse(search); return address.success ? address.data : undefined; };
function contactFilters(identity: Actor, query: z.infer<typeof ContactQuery>, candidates?: string[]) {
  const address = wholeAddress(query.search);
  return [query.email ? eq(contacts.email, query.email) : undefined, address ? eq(contacts.email, address) : candidates ? sql`${contacts.id} = ANY(${sql.param(candidates)}::text[])` : query.search ? sql`(${searchText(contacts.email, query.search)} OR ${searchText(contacts.name, query.search)})` : undefined, query.consent ? eq(contacts.marketingConsent, query.consent) : undefined, query.suppressed !== undefined ? eq(contacts.suppressed, query.suppressed === 'true') : undefined, query.risky ? skippedRisk(sql`${contacts.risk}`, sql`${contacts.riskAllowed}`) : undefined, query.listId ? inList(identity, query.listId) : undefined];
}
export async function readContacts(db: DbExecutor, identity: Actor, rows: Array<typeof contacts.$inferSelect>, maxListsPerContact = CONTACT_LIST_IDS_PAGE_MAX) {
  if (!rows.length) return [];
  const idsJson = JSON.stringify(rows.map(row => row.id));
  const { rows: memberships } = await db.execute<{ contact_id: string; list_id: string }>(sql`
    SELECT cid.id AS contact_id, m.list_id
    FROM jsonb_array_elements_text(${idsJson}::jsonb) AS cid(id)
    CROSS JOIN LATERAL (
      SELECT m.list_id
      FROM audience_list_members m
      JOIN audience_lists l ON l.workspace_id = m.workspace_id AND l.id = m.list_id
      WHERE m.workspace_id = ${identity.workspaceId} AND m.contact_id = cid.id
      ORDER BY m.list_id ASC
      LIMIT ${maxListsPerContact}
    ) m`);
  const byContact = new Map<string, string[]>();
  for (const member of memberships) { const ids = byContact.get(member.contact_id) ?? []; ids.push(member.list_id); byContact.set(member.contact_id, ids); }
  return rows.map(row => ({ ...contactBody(row), listIds: byContact.get(row.id) ?? [] }));
}
// A list this size or smaller is read through its own memberships whatever the filter: at most this many contact probes.
const SMALL_LIST = 5000;
type ContactRow = typeof contacts.$inferSelect;
type RawContactRow = { id: string; workspace_id: string; email: string; name: string | null; properties: Record<string, string | number | boolean | null>; marketing_consent: 'unknown' | 'subscribed' | 'unsubscribed'; suppressed: boolean; suppression_reason: string | null; risk: Risk | null; risk_allowed: boolean; last_open_at: string | null; last_click_at: string | null; observed_since: string | null; open_observed_since: string | null; click_observed_since: string | null; deleted_at: string | null; created_at: string; updated_at: string; candidate_count: number };
function mapRawContact(r: RawContactRow): ContactRow {
  return { id: r.id, workspaceId: r.workspace_id, email: r.email, name: r.name, properties: r.properties, marketingConsent: r.marketing_consent, suppressed: r.suppressed, suppressionReason: r.suppression_reason, risk: r.risk, riskAllowed: r.risk_allowed, lastOpenAt: r.last_open_at, lastClickAt: r.last_click_at, observedSince: r.observed_since, openObservedSince: r.open_observed_since, clickObservedSince: r.click_observed_since, deletedAt: r.deleted_at, createdAt: r.created_at, updatedAt: r.updated_at };
}
/**
 * Fetches one page of active contacts in ID order while capping cumulative serialized bytes in SQL (always >= 1 row
 * if any match), preserving membership-ordered index scans for unfiltered or small lists.
 */
export async function boundedContactPage(db: DbExecutor, identity: Actor, query: z.infer<typeof ContactQuery>) {
  const { listId } = query, filtered = !!query.search || !!query.consent || query.suppressed !== undefined || !!query.risky;
  const byMembership = !!listId && !query.email && !wholeAddress(query.search) && (!filtered
    || !(await db.execute(sql`SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} OFFSET ${SMALL_LIST} LIMIT 1`)).rows.length);
  // Bound both sides of the membership join so a merge can seek instead of scanning contacts up to the cursor.
  const membershipCursor = query.cursor ? and(gt(listMembers.contactId, query.cursor), gt(contacts.id, query.cursor)) : undefined;
  const candidates = !byMembership && query.search ? await trigramCandidates(db, identity, query.search) : undefined;
  if (candidates?.length === 0) return { rows: [], hasMore: false };
  const candidateSql = byMembership
    ? sql`SELECT ${contacts.id} AS id, ${contacts.workspaceId} AS workspace_id, ${contacts.email} AS email, ${contacts.name} AS name, ${contacts.properties} AS properties, ${contacts.marketingConsent} AS marketing_consent, ${contacts.suppressed} AS suppressed, ${contacts.suppressionReason} AS suppression_reason, ${contacts.risk} AS risk, ${contacts.riskAllowed} AS risk_allowed,
        ${contacts.lastOpenAt} AS last_open_at, ${contacts.lastClickAt} AS last_click_at, ${contacts.observedSince} AS observed_since, ${contacts.openObservedSince} AS open_observed_since, ${contacts.clickObservedSince} AS click_observed_since, ${contacts.deletedAt} AS deleted_at, ${contacts.createdAt} AS created_at, ${contacts.updatedAt} AS updated_at,
        (octet_length(${contacts.properties}::text) + octet_length(${contacts.email}) + coalesce(octet_length(${contacts.name}), 0) + 384) AS row_bytes
      FROM ${listMembers}
      JOIN ${contacts} ON ${contacts.workspaceId} = ${listMembers.workspaceId} AND ${contacts.id} = ${listMembers.contactId}
      WHERE ${and(scope(listMembers, identity), eq(listMembers.listId, listId!), isNull(contacts.deletedAt), ...contactFilters(identity, { ...query, listId: undefined }), membershipCursor)}
      ORDER BY ${listMembers.contactId} ASC LIMIT ${query.limit + 1}`
    : sql`SELECT id, workspace_id, email, name, properties, marketing_consent, suppressed, suppression_reason, risk, risk_allowed,
        last_open_at, last_click_at, observed_since, open_observed_since, click_observed_since, deleted_at, created_at, updated_at,
        (octet_length(properties::text) + octet_length(email) + coalesce(octet_length(name), 0) + 384) AS row_bytes
      FROM ${contacts}
      WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...contactFilters(identity, query, candidates), query.cursor ? gt(contacts.id, query.cursor) : undefined)}
      ORDER BY ${contacts.id} ASC LIMIT ${query.limit + 1}`;
  const { rows } = await db.execute<RawContactRow>(sql`
    WITH candidate AS (${candidateSql}), sized AS (
      SELECT *, row_number() OVER (ORDER BY id) AS rn, sum(row_bytes) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS cum_bytes
      FROM candidate
    )
    SELECT id, workspace_id, email, name, properties, marketing_consent, suppressed, suppression_reason, risk, risk_allowed,
      last_open_at::text, last_click_at::text, observed_since::text, open_observed_since::text, click_observed_since::text,
      deleted_at::text, created_at::text, updated_at::text,
      (SELECT count(*)::int FROM candidate) AS candidate_count
    FROM sized WHERE rn = 1 OR cum_bytes <= ${AUDIENCE_READ_MAX_BYTES}
    ORDER BY rn`);
  const candidateCount = rows[0]?.candidate_count ?? 0;
  const pageRows = rows.slice(0, query.limit).map(mapRawContact);
  const hasMore = candidateCount > pageRows.length;
  return { rows: pageRows, hasMore };
}
// Counts are the sums of the list's rows in audience_list_counts, which the database keeps as memberships and contacts
// change (migration 405): a few rows per list, however many members it has.
export async function readLists(db: DbExecutor, identity: Actor, rows: ListRow[]) {
  if (!rows.length) return [];
  const sums = await db.select({ listId: listCounts.listId, subscribed: sql<number>`sum(${listCounts.subscribed})::int`, unsubscribed: sql<number>`sum(${listCounts.unsubscribed})::int`, unknown: sql<number>`sum(${listCounts.unknown})::int`, suppressed: sql<number>`sum(${listCounts.suppressed})::int` }).from(listCounts).where(and(scope(listCounts, identity), inArray(listCounts.listId, rows.map(row => row.id)))).groupBy(listCounts.listId);
  const byList = new Map(sums.map(({ listId, ...counts }) => [listId, { total: counts.subscribed + counts.unsubscribed + counts.unknown + counts.suppressed, ...counts }]));
  return rows.map(row => ({ ...row, counts: byList.get(row.id) ?? { total: 0, subscribed: 0, unsubscribed: 0, unknown: 0, suppressed: 0 } }));
}
// A membership change reads its contact's state to count it (migration 405), so it locks the contact first, as an
// import, a consent change and a deletion do: contact, then membership, several contacts in email order. Deleted
// contacts are locked too (an import may be restoring one). Returns the IDs that are active contacts.
export async function lockContacts(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, contactIds: string[]) {
  const rows = await tx.select({ id: contacts.id, deletedAt: contacts.deletedAt }).from(contacts).where(and(scope(contacts, identity), inArray(contacts.id, contactIds))).orderBy(asc(contacts.email)).for('share');
  return rows.filter(row => !row.deletedAt).map(row => row.id);
}
/** Who acted on an unsubscribe link, as the consent history records it: the mailbox's one-click (RFC 8058), the hosted
 *  confirmation, the hosted preference page (src/audience/unsubscribe.ts), or SES's own subscription event. */
export type RecipientSource = 'footer-confirm' | 'rfc8058-post' | 'ses-subscription' | 'preferences';
const RECIPIENT_EVIDENCE: Record<RecipientSource, string> = {
  'ses-subscription': 'Signed SES subscription event reported unsubscribeAll for a single-recipient email.',
  'rfc8058-post': 'POST request presented a valid one-click unsubscribe token; no human identity asserted.',
  'footer-confirm': 'Footer confirmation form submitted with a valid unsubscribe token; no human identity asserted.',
  preferences: 'Preference page submitted with a valid unsubscribe token; no human identity asserted.',
};
/** The contact an unsubscribe link names, held FOR UPDATE; made when the address has none, so the opt-out is kept for it. */
async function linkContact(tx: DbExecutor, workspaceId: string, email: string) {
  const normalized = Email.safeParse(email);
  if (!normalized.success) throw new ApiError(422, 'INVALID_EMAIL', 'A valid email address is required.');
  const identity = { workspaceId };
  await tx.insert(contacts).values({ id: rowId('con'), ...identity, email: normalized.data, risk: staticRiskSql(normalized.data, workspaceId, peekHygieneLists()) as unknown as Risk }).onConflictDoNothing();
  const [contact] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, normalized.data))).limit(1).for('update');
  if (!contact) throw new ApiError(500, 'CONSENT_WRITE_FAILED', 'Unable to persist consent.');
  return contact;
}
export async function recordUnsubscribe(runtime: Runtime, workspaceId: string, email: string, source: RecipientSource): Promise<{ contactId: string; changed: boolean }> {
  return runtime.db.transaction(async tx => {
    const contact = await linkContact(tx, workspaceId, email);
    if (contact.marketingConsent === 'unsubscribed') return { contactId: contact.id, changed: false };
    const now = new Date().toISOString();
    await recordConsent(tx, { workspaceId }, contact, { status: 'unsubscribed', source, evidence: RECIPIENT_EVIDENCE[source], occurredAt: now, actorKeyId: null }, now);
    return { contactId: contact.id, changed: true };
  });
}
/** A recipient's unsubscribe from mail with a topic (src/audience/unsubscribe.ts /unsubscribe): that topic only, archived or not; the
 *  contact's marketing consent stays as it is. A contact deleted since keeps its choice, as it keeps its consent. */
export async function recordTopicUnsubscribe(runtime: Runtime, workspaceId: string, email: string, topicId: string, source: 'footer-confirm' | 'rfc8058-post'): Promise<{ contactId: string; changed: boolean }> {
  return runtime.db.transaction(async tx => {
    const contact = await linkContact(tx, workspaceId, email);
    const changed = await recordTopicChoices(tx, workspaceId, contact, [{ topicId, subscribed: false }], { source, evidence: `${RECIPIENT_EVIDENCE[source]} The link was about this topic.`, occurredAt: new Date().toISOString(), actorKeyId: null }, false, true);
    return { contactId: contact.id, changed: changed.length > 0 };
  });
}
/** What the hosted preference page shows the holder of an unsubscribe link, and nothing more: the address's marketing
 *  consent (null without a contact), the workspace's topics that aren't archived with its choice about each, and the
 *  link's own topic, archived or not. Reads only; nothing is made. */
export async function linkPreferences(db: DbExecutor, workspaceId: string, email: string, topicId: string | null) {
  const [contact] = await db.select({ id: contacts.id, consent: contacts.marketingConsent, deletedAt: contacts.deletedAt }).from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email.trim().toLowerCase()))).limit(1);
  const current = contact && !contact.deletedAt ? contact : null;
  const topics = await topicStates(db, workspaceId, current?.id ?? null, topicId);
  return { consent: current?.consent ?? null, topics: topics.filter(topic => !topic.archived), linked: topics.find(topic => topic.id === topicId) ?? null };
}
/**
 * The preference page's Save, which only ever removes: of the topics it showed (`shown`) that still reach the person, those
 * left unchecked (not in `on`) are recorded as opt-outs (source preferences), each with its consent record and event. A
 * public link never turns a topic on: not one the person left, not an opt-in topic they never joined. Asking for that is
 * ignored and records nothing; getting a topic again is the sender's to record (updateContactConsent). A topic archived or
 * made since the page was shown is left alone, and a person unsubscribed from everything, or with no contact, changes
 * nothing here. Returns the topics it turned off, or null for such a person.
 */
export async function recordPreferences(runtime: Runtime, workspaceId: string, email: string, shown: string[], on: Set<string>) {
  return runtime.db.transaction(async tx => {
    const [contact] = await tx.select().from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email.trim().toLowerCase()), isNull(contacts.deletedAt))).limit(1).for('update');
    if (contact?.marketingConsent !== 'subscribed') return null;
    const off = (await topicStates(tx, workspaceId, contact.id, null)).filter(topic => !topic.archived && topic.subscribed && shown.includes(topic.id) && !on.has(topic.id));
    if (off.length) await recordTopicChoices(tx, workspaceId, contact, off.map(topic => ({ topicId: topic.id, subscribed: false })), { source: 'preferences', evidence: RECIPIENT_EVIDENCE.preferences, occurredAt: new Date().toISOString(), actorKeyId: null }, false);
    return off.map(topic => ({ topicId: topic.id, name: topic.name }));
  });
}
/**
 * A consent decision for a contact its caller holds FOR UPDATE: its audit record, the contact.subscription_changed event
 * when the status changes, and the contact itself. The consent route, an unsubscribe and the sign-ups and customers
 * lists (signups.ts) all write consent through here. `at`: one time for the event and the contact (an unsubscribe's
 * decision time); without it each is stamped when it is written, after the audit, as the consent route always has.
 */
export async function recordConsent(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, contact: Pick<ContactRow, 'id' | 'email' | 'marketingConsent'>,
  decision: { status: 'subscribed' | 'unsubscribed'; source: string; policyVersion?: string; evidence?: string; occurredAt: string; actorKeyId: string | null }, at?: string) {
  const auditId = rowId('cns');
  await tx.insert(consentAudit).values({ id: auditId, ...scopeValues(identity), contactId: contact.id, email: contact.email, status: decision.status, source: decision.source, policyVersion: decision.policyVersion ?? null, evidence: decision.evidence ?? null, occurredAt: decision.occurredAt, actorKeyId: decision.actorKeyId });
  if (contact.marketingConsent !== decision.status) await enqueue(tx, { type: 'operation.publish', ...scopeValues(identity), payload: { event: { id: auditId, type: 'contact.subscription_changed', createdAt: at ?? new Date().toISOString(), ...scopeValues(identity), region: null, data: { contactId: contact.id, status: decision.status, source: decision.source } } } });
  const [updated] = await tx.update(contacts).set({ marketingConsent: decision.status, updatedAt: at ?? new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contact.id))).returning();
  return updated!;
}
export type ListContactResult = 'added' | 'updated' | 'deleted' | 'invalid' | 'no_list' | 'gone';
/**
 * A contact the installation keeps in a list from records of its own (the sign-ups and customers lists, signups.ts),
 * under the API's rules: the address and name are checked as createContact checks them, properties merge into the
 * contact's own within the 50-key and 16 KiB limits (a merge past them leaves the properties as they were), and the
 * contact joins the list.
 * Consent is recorded only for a contact with no decision yet that isn't suppressed: an opt-out stays an opt-out, and
 * suppression is never touched. consentAgain also records it for a contact already subscribed, so its history says why it
 * is on this list too (the status, and so the contact, is unchanged). A deleted contact stays deleted: what deletion
 * retains is there to keep it from being enrolled again. A waitlist sync marks the membership so reconciliation can
 * distinguish it from a manual addition. Takes the list, then the contact, as an import does.
 */
export async function upsertListContact(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string,
  input: { email: string; name: string | null; fromWaitlist?: boolean; consentAgain?: boolean; properties: Record<string, string | number | boolean | null>; consent: { source: string; evidence: string; occurredAt: string; policyVersion?: string } }): Promise<ListContactResult> {
  const parsed = ContactInput.safeParse({ email: input.email, ...input.name ? { name: input.name } : {}, properties: input.properties });
  if (!parsed.success) return 'invalid';
  const { email, name, properties } = parsed.data;
  const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1).for('share');
  if (!list) return 'no_list';
  const added = (await tx.insert(contacts).values({ id: rowId('con'), ...scopeValues(identity), email, name: name || null, properties, risk: staticRiskSql(email, identity.workspaceId, await hygieneLists(tx)) as unknown as Risk }).onConflictDoNothing().returning({ id: contacts.id })).length > 0;
  const [contact] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email))).limit(1).for('update');
  if (!contact) throw new ApiError(500, 'CONTACT_WRITE_FAILED', 'Unable to persist the contact.', undefined, true);
  if (contact.deletedAt) return 'deleted';
  if (!added) {
    const merged = { ...contact.properties, ...properties }, fits = PropertiesInput.safeParse(merged).success;
    const changed = fits && Object.entries(properties).some(([key, value]) => contact.properties[key] !== value);
    if (!fits) log('warn', { code: 'LIST_CONTACT_PROPERTIES_FULL', workspaceId: identity.workspaceId, contactId: contact.id });
    if (changed || (name && name !== contact.name)) await tx.update(contacts).set({ ...changed ? { properties: merged } : {}, ...name ? { name } : {}, updatedAt: new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contact.id)));
  }
  if (!contact.suppressed && (contact.marketingConsent === 'unknown' || (input.consentAgain && contact.marketingConsent === 'subscribed'))) await recordConsent(tx, identity, contact, { status: 'subscribed', ...input.consent, actorKeyId: null });
  if (input.fromWaitlist) await tx.execute(sql`INSERT INTO audience_list_members(workspace_id,list_id,contact_id,signup_waitlist)
    VALUES(${identity.workspaceId},${listId},${contact.id},true) ON CONFLICT(workspace_id,list_id,contact_id)
    DO UPDATE SET signup_waitlist=true WHERE audience_list_members.signup_waitlist IS DISTINCT FROM true`);
  else await tx.insert(listMembers).values({ ...scopeValues(identity), listId, contactId: contact.id }).onConflictDoNothing();
  return added ? 'added' : 'updated';
}
/**
 * Takes an address the installation's own records put on a list (the customers list, signups.ts) off it again: the
 * membership only. The contact, its consent and its suppression stay. Takes the list, then the contact, as
 * upsertListContact does. False when the list, the contact or the membership is already gone.
 */
export async function removeListContact(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string, email: string): Promise<boolean> {
  const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1).for('share');
  if (!list) return false;
  const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email))).limit(1).for('update');
  if (!contact) return false;
  return (await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, listId), eq(listMembers.contactId, contact.id))).returning({ id: listMembers.contactId })).length > 0;
}
