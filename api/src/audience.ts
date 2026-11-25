import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './core.js';
import { actor, ApiError, AudienceSpec, budgetedRead, chargeBudget, databaseCodeOf, unrestrictedRequired, errors, id, IdParams, json, log, notFound, page, PageQuery, readLimit, readLimitNote, response, rowId, security, statementTimedOut, type Actor, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { productName } from './brand.js';
export { AudienceSpec };
import { contacts, consentAudit, imports, listCounts, listMembers, lists, segments, type PropertyRule, type SegmentRule } from './db/audience.js';
import { enqueue, noteEnqueued } from './jobs.js';
import { MEMORY_LIMITS, reserveMemory, runInMemoryScope, type MemoryLease } from './isolate-memory.js';
import { buildBoundedPageJson, PAGE_MAX_BYTES, READ_MAX_WAITERS, READ_RESERVATION_BYTES, streamTextPartsResponse, utf8Bytes, withBoundedRead } from './read-bounds.js';
import { mailAddress, validMailAddressSql } from './outbound-content.js';
import { SEND_LIMITS } from './send-limits.js';
import { RAMP } from './standing-model.js';
import { bouncedElsewhere, classifyAddress, contactRisk, domainOf, domainRisks, hygieneLists, noRisks, peekHygieneLists, RiskBreakdown, RiskReason, RISKS, riskCounts, riskFor, skippedRisk, staticRiskSql, validAddress, type HygieneLists, type Risk, type RiskCounts } from './list-hygiene.js';

export const CONTACT_PROPERTIES_MAX_KEYS = 50;
export const CONTACT_PROPERTIES_MAX_BYTES = 16 * 1024;
/** Matches migration 453's CHECK constraint (16 KiB compact JSON + 256 B Postgres jsonb::text formatting slack). */
export const CONTACT_PROPERTIES_DB_MAX_BYTES = 16_640;
export const CONTACT_LIST_IDS_PAGE_MAX = 50;
export const CONTACT_LIST_IDS_SINGLE_MAX = 200;
export const AUDIENCE_READ_MAX_BYTES = PAGE_MAX_BYTES;
export const AUDIENCE_READ_RESERVATION_BYTES = READ_RESERVATION_BYTES;
export const AUDIENCE_READ_MAX_WAITERS = READ_MAX_WAITERS;
const AUDIENCE_READ_SECONDS = 5;
export { utf8Bytes };
export function isContactSizeCheckViolation(err: unknown): boolean {
  if (databaseCodeOf(err) !== '23514') return false;
  const text = String((err as { constraint?: unknown; cause?: { constraint?: unknown; message?: unknown }; message?: unknown })?.constraint ?? (err as { cause?: { constraint?: unknown; message?: unknown } })?.cause?.constraint ?? (err as { cause?: { message?: unknown } })?.cause?.message ?? (err as { message?: unknown })?.message ?? '');
  return text.includes('audience_contacts_properties_size') || text.includes('audience_contacts_name_length');
}
/** Counts UTF-8 JSON bytes conservatively for both JS and Postgres jsonb (where extreme-exponent numbers expand to full decimal). */
export function propertiesByteLength(properties: Record<string, unknown>): number {
  let bytes = utf8Bytes(JSON.stringify(properties));
  for (const val of Object.values(properties)) {
    if (typeof val === 'number' && val !== 0 && Number.isFinite(val)) {
      const exp = Math.abs(Math.floor(Math.log10(Math.abs(val))));
      if (exp >= 20) bytes += exp + 4;
    }
  }
  return bytes;
}

const Email = mailAddress(z.string().trim()).transform(v => v.toLowerCase()).openapi({format:'email'});
const Properties = z.record(z.string().min(1).max(80), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= CONTACT_PROPERTIES_MAX_KEYS, 'At most 50 properties are supported.');
export const PropertiesInput = Properties.refine(v => propertiesByteLength(v) <= CONTACT_PROPERTIES_MAX_BYTES, 'Contact properties must total at most 16 KiB of JSON.').describe('Up to 50 key/value pairs, at most 16 KiB of JSON total.');
export const ContactInput = z.object({ email: Email, name: z.string().trim().max(200).optional(), properties: PropertiesInput.default({}) }).strict();
const ContactPatch = z.object({ name: z.string().trim().max(200).nullable().optional(), properties: PropertiesInput.optional(), riskAllowed: z.boolean().optional().describe('true sends campaigns and marketing to a contact flagged as risky anyway; false skips it again. Owners and admins only (manage permission). Only for a contact with a risk (409 CONTACT_NOT_RISKY otherwise).') }).strict();
export function withAudienceReadMemory(c: Ctx, work: () => Promise<Response>): Promise<Response> {
  return withBoundedRead(c, () => work(), { route: 'audience.read' });
}
const Scope = { workspaceId: z.string() };
const Dates = { createdAt: z.string(), updatedAt: z.string() };
const ContactRisk = z.object({ reason: RiskReason, suggestion: z.string().nullable().describe('For typo_domain, the address with the provider it most likely meant.'), allowed: z.boolean().describe('Its owner allowed it: campaigns and marketing sends reach it anyway.') }).nullable()
  .describe('Why campaigns and marketing sends skip this contact, or null when nothing is wrong with the address. Flagged when the contact is created or imported, and again hourly for every contact. Transactional mail is never refused.').openapi('ContactRisk');
const Contact = z.object({ id: z.string(), ...Scope, email: z.string(), name: z.string().nullable(), properties: Properties, marketingConsent: z.enum(['unknown', 'subscribed', 'unsubscribed']), suppressed: z.boolean(), suppressionReason: z.string().nullable(), risk: ContactRisk, lastOpenAt: z.string().nullable(), lastClickAt: z.string().nullable(), observedSince: z.string().nullable(), openObservedSince: z.string().nullable(), clickObservedSince: z.string().nullable(), deletedAt: z.string().nullable(), ...Dates }).openapi('Contact');
/** A contact row as the API shows it: its risk as reason, suggestion and allowance. */
export function contactBody<T extends { email: string; risk: string | null; riskAllowed: boolean }>({ riskAllowed, ...row }: T) { return { ...row, risk: contactRisk({ email: row.email, risk: row.risk, riskAllowed }) }; }
const ListInput = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).default('') }).strict();
const List = ListInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('ContactList');
const ContactRead = Contact.extend({ listIds: z.array(z.string()).describe('Up to 50 list IDs on paginated contact reads (200 on getContact), sorted by ID.') }).openapi('ContactRead');
const ListCounts = z.object({ total: z.number().int(), subscribed: z.number().int(), unsubscribed: z.number().int(), unknown: z.number().int(), suppressed: z.number().int() }).describe('Active members only. Suppressed takes precedence over consent; subscribed, unsubscribed, unknown and suppressed are mutually exclusive and sum to total.');
const ListRead = z.object({ ...List.shape, counts: ListCounts.nullable() }).strict().openapi('ContactListRead');
const SearchQuery = PageQuery.extend({ search: z.string().trim().min(1).max(200).optional() });
const ListQuery = SearchQuery.extend({ counts: z.enum(['true', 'false']).default('true').describe('false leaves member counts out (counts is null). Counts are kept as memberships, consent and suppression change, so reading them does not count members.') }).openapi('ListContactListsQuery');
const ContactQuery = SearchQuery.extend({ email: Email.optional().describe('Exact, case-insensitive email match. Uses the unique email index; prefer it over search for one address.'), consent: z.enum(['unknown', 'subscribed', 'unsubscribed']).optional(), suppressed: z.enum(['true', 'false']).optional(), risky: z.enum(['true']).optional().describe('true: only contacts campaigns skip as risky (risk set and not allowed).'), listId: z.string().min(1).max(120).optional() }).openapi('ListContactsQuery');
// A condition on any contact property, with the operators of its value's type (compilePropertyRule).
const property = { field: z.literal('property'), key: z.string().min(1).max(80).describe('The property name, as in a contact\'s properties.') };
const PropertyRule = z.union([
  z.object({ ...property, type: z.literal('string'), operator: z.enum(['eq', 'neq', 'contains']).describe('Compare JSON strings only. eq and neq are case-sensitive; contains ignores case. Missing, null and non-string properties never match.'), value: z.string().max(200) }).strict(),
  z.object({ ...property, type: z.literal('number'), operator: z.enum(['eq', 'lt', 'gt']), value: z.number().finite().describe('Compared with a property that is a JSON number or a signed decimal string, optionally in scientific notation, within PostgreSQL numeric range. Other values never match.') }).strict(),
  z.object({ ...property, type: z.literal('date'), operator: z.enum(['before', 'after', 'on']), value: z.iso.date().describe('Compare UTC calendar days. Accept a valid YYYY-MM-DD or a date with T and HH:MM[:SS[.fraction]], optionally Z or a signed hour/minute offset. No offset means UTC; invalid values never match.') }).strict(),
  z.object({ ...property, type: z.enum(['string', 'number', 'date']), operator: z.enum(['set', 'notSet']).describe('set: the property has a value other than null; notSet: it has none. The same for every type.') }).strict(),
]);
const RuleLeaf = z.union([z.object({ field: z.enum(['email', 'firstName', 'plan', 'country']), operator: z.enum(['eq', 'neq', 'contains']), value: z.string().max(200) }).strict(), z.object({ field: z.enum(['lastOpenAt', 'lastClickAt']), operator: z.enum(['within', 'inactive']), days: z.number().int().min(1).max(730) }).strict()]);
// Finite-depth schemas remain fully representable in OpenAPI; no recursive lazy schema. Property leaves come after the
// alternatives that were there first, so the published anyOf keeps each earlier alternative at its index.
let ruleSchema: z.ZodType<SegmentRule> = z.union([RuleLeaf, PropertyRule]);
for (let depth = 0; depth < 3; depth++) ruleSchema = z.union([RuleLeaf, z.object({ operator: z.enum(['and', 'or']), rules: z.array(ruleSchema).min(1).max(10) }).strict(), PropertyRule]);
function ruleSize(rule: SegmentRule): number { return 'rules' in rule ? 1 + rule.rules.reduce((n, child) => n + ruleSize(child), 0) : 1; }
const Rule = ruleSchema.refine(v => ruleSize(v) <= 50, 'A segment supports at most 50 rules and three nested groups.').openapi('SegmentRule');
const SegmentInput = z.object({ name: z.string().trim().min(1).max(200), rule: Rule }).strict();
const Segment = SegmentInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('Segment');
const Counts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int(), risky: z.number().int().describe('Subscribed, not suppressed and flagged as risky: campaigns skip them. Not in eligible.') });
const Deleted = z.object({ id: z.string(), deleted: z.literal(true) });
const Audit = z.object({ id: z.string(), ...Scope, contactId: z.string(), email: z.string(), status: z.enum(['subscribed', 'unsubscribed']), source: z.string(), policyVersion: z.string().nullable(), evidence: z.string().nullable(), actorKeyId: z.string().nullable(), importId: z.string().nullable().describe('Committed import ID when source is import; null otherwise.'), occurredAt: z.string(), createdAt: z.string() });
const ConsentInput = z.object({ status: z.enum(['subscribed', 'unsubscribed']), source: z.string().trim().min(1).max(200).optional(), policyVersion: z.string().trim().min(1).max(120).optional(), evidence: z.string().trim().min(1).max(2000).optional(), occurredAt: z.string().datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 60000, 'Consent cannot occur in the future.').optional(), confirmResubscribe: z.boolean().default(false) }).strict();
const ImportRowSchema = z.object({ row: z.number().int(), email: z.string(), name: z.string().optional(), properties: Properties, risk: RiskReason.optional().describe('What the address says about it, if anything: the contact is imported and flagged, and campaigns skip it.') });
const ImportErrorSchema = z.object({ row: z.number().int(), field: z.string(), message: z.string() });
const Import = z.object({ id: z.string(), ...Scope, listId: z.string().nullable(), status: z.enum(['preview', 'committed']), rows: z.array(ImportRowSchema), errors: z.array(ImportErrorSchema), imported: z.number().int(), rowsRetained: z.boolean().describe('false once committed row payloads are no longer kept after the retention window (rows is then [] while imported keeps the count).'), risky: RiskBreakdown.nullable().describe('Rows flagged as risky. At preview, what the addresses say; once committed, the imported contacts campaigns skip, addresses that bounced elsewhere included. null for imports from before list hygiene.'), errorsRetained: z.boolean().describe('false once per-row error details are no longer kept after the retention window (errors is then []).'), ...Dates }).openapi('AudienceImport');
// How long a preview looks up domains it hasn't checked before (src/list-hygiene.ts domainRisks).
const IMPORT_DNS_MS = 3_000;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024, IMPORT_MAX_ROWS = 50_000, IMPORT_OPEN_PREVIEW_CAP = 50, IMPORT_SAMPLE_CONTACT_IDS = 2000;
export const IMPORT_PREVIEW_RATE_PER_MINUTE = 40;
// Measured workerd isolate peaks (idle ~29 MB, 128 MB isolate cap, 64 MiB working budget):
// - 1 x 5 MiB non-Latin commit: ~75 MB (+46 MB) -> 48 MiB prevents 2-3 commits overlapping past 128 MB (3 x 20 MiB hit 131 MB)
//   while still fitting a 1.4 MB preview (~13 MiB) alongside a running commit (48 + 13 = 61 <= 64 MiB).
// - 1 x 5 MiB preview: ~87 MB (+58 MB) -> 42 MiB (8x + 2 MiB) serializes two 5 MiB previews.
// - 1 x 50k-row GET: ~81-90 MB (+52-61 MB) -> 24 MiB caps concurrent GETs under ~100 MB.
// - Unread streamed responses shrink to <= 12 MiB and self-reclaim via isolate-memory.ts + streamTextPartsResponse.
export const IMPORT_GET_RESERVATION_BYTES = 24 * 1024 * 1024;
export const IMPORT_COMMIT_RESERVATION_BYTES = 48 * 1024 * 1024;
export const importPreviewReservationBytes = (bytes: number) => Math.min(SEND_LIMITS.isolateWorkingBytes, Math.max(0, bytes) * 8 + 2 * 1024 * 1024);
function importNotFound(): never { throw new ApiError(404, 'NOT_FOUND', `Import was not found. A preview that was never committed is removed once the workspace has ${IMPORT_OPEN_PREVIEW_CAP} newer ones (or after 7 days). Preview the file again.`); }
const importMetaColumns = { id: imports.id, workspaceId: imports.workspaceId, listId: imports.listId, status: imports.status, imported: imports.imported, rowsScrubbedAt: imports.rowsScrubbedAt, errorsScrubbedAt: imports.errorsScrubbedAt, riskSummary: imports.riskSummary, createdAt: imports.createdAt, updatedAt: imports.updatedAt };
type ImportMeta = { [K in keyof typeof importMetaColumns]: (typeof imports.$inferSelect)[K] };
// Retained receipts only counted the reasons known when they were written. A receipt from before hygiene still has no summary.
const receiptRisk = (stored: ImportMeta['riskSummary']) => stored ? { total: stored.total, byReason: { ...noRisks(), ...stored.byReason } } : null;
const importSummary = ({ rowsScrubbedAt, errorsScrubbedAt, riskSummary, ...meta }: ImportMeta) => ({ ...meta, rowsRetained: rowsScrubbedAt === null, errorsRetained: errorsScrubbedAt === null, risky: receiptRisk(riskSummary) });
const ImportCommit = z.object({ consent: z.object({ status: z.literal('subscribed'), evidence: z.string().trim().min(1).max(2000).describe('How these people agreed to marketing email, for example "Opted in at checkout". Stored with each consent record.'), policyVersion: z.string().trim().min(1).max(120).optional() }).strict().optional().describe('Records that everyone in this import agreed to receive marketing email. It changes only contacts with no consent decision yet: prior opt-outs stay unsubscribed and suppressed addresses stay suppressed. Omit it to import without consent.') }).strict().openapi('CommitContactImportInput');
const CommittedImport = Import.extend({ subscribed: z.number().int().describe('Contacts this commit marked subscribed; 0 without consent or when the import was already committed.') }).openapi('CommittedContactImport');
const ImportInput = z.object({ csv: z.string().min(1).max(IMPORT_MAX_BYTES), listId: z.string().min(1).max(120).optional(), mapping: z.object({ email: z.string().min(1).max(200), name: z.string().min(1).max(200).optional(), firstName: z.string().min(1).max(200).optional(), plan: z.string().min(1).max(200).optional(), country: z.string().min(1).max(200).optional() }).strict() }).strict();

function scope(table: { workspaceId: AnyPgColumn }, identity: Pick<Actor, 'workspaceId'>) { return eq(table.workspaceId, identity.workspaceId); }
function scopeValues(identity: Pick<Actor, 'workspaceId'>) { return { workspaceId: identity.workspaceId }; }
function paginate<T extends { id: string }>(rows: T[], limit: number) { return { data: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }; }
async function findContact(db: DbExecutor, identity: Actor, contactId: string) { const [row] = await db.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1); return row ?? notFound('Contact'); }
// A list's own fields, as list routes return them: a newsletter's sender and reader count (src/newsletters.ts) are not.
const listColumns = { id: lists.id, workspaceId: lists.workspaceId, name: lists.name, description: lists.description, createdAt: lists.createdAt, updatedAt: lists.updatedAt };
type ListRow = { [K in keyof typeof listColumns]: (typeof lists.$inferSelect)[K] };
async function findList(db: DbExecutor, identity: Actor, listId: string) { const [row] = await db.select(listColumns).from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1); return row ?? notFound('List'); }
async function findSegment(db: DbExecutor, identity: Actor, segmentId: string) { const [row] = await db.select().from(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).limit(1); return row ?? notFound('Segment'); }

// Literal substring search: %, _ and backslash have no wildcard meaning.
function searchText(column: AnyPgColumn, search: string): SQL { return sql`strpos(lower(${column}), lower(${search})) > 0`; }
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
async function readContacts(db: DbExecutor, identity: Actor, rows: Array<typeof contacts.$inferSelect>, maxListsPerContact = CONTACT_LIST_IDS_PAGE_MAX) {
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
async function boundedContactPage(db: DbExecutor, identity: Actor, query: z.infer<typeof ContactQuery>) {
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
async function readLists(db: DbExecutor, identity: Actor, rows: ListRow[]) {
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

export function compileRule(rule: SegmentRule): SQL { return sql`coalesce((${compileRuleCondition(rule)}), false)`; }
function compileRuleCondition(rule: SegmentRule): SQL {
  if ('rules' in rule) {
    if (rule.operator === 'or') {
      // Collapse text-eq leaves on one target inside OR into one ANY(...) test so 20-50 condition OR segments extract JSONB once per row.
      const eqByField = new Map<string, string[]>();
      const numberEq = new Map<string, number[]>();
      const other: SegmentRule[] = [];
      for (const child of rule.rules) {
        const eq = textEquality(child);
        if (eq) eqByField.set(eq.target, [...eqByField.get(eq.target) ?? [], eq.value]);
        else if ('field' in child && child.field === 'property' && child.type === 'number' && child.operator === 'eq') {
          const values = numberEq.get(child.key) ?? []; values.push(child.value); numberEq.set(child.key, values);
        } else other.push(child);
      }
      const parts: SQL[] = other.map(compileRule);
      for (const [f, vals] of eqByField) {
        const typed = f.startsWith('property:'), key = typed ? f.slice('property:'.length) : f;
        const expr = f === 'email' ? sql`${contacts.email}` : sql`(${contacts.properties} ->> ${key})`;
        const condition = vals.length === 1
          ? sql`coalesce(${expr} = ${vals[0]!}, false)`
          : sql`coalesce(${expr} = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(vals)])}::jsonb))), false)`;
        parts.push(typed ? sql`(${stringProperty(key)} AND ${condition})` : condition);
      }
      for (const [key, values] of numberEq) {
        const number = propertyNumber(key);
        parts.push(values.length === 1 ? sql`${number} = ${String(values[0])}::numeric`
          : sql`${number} = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(values)])}::jsonb)::numeric))`);
      }
      return sql`(${sql.join(parts, sql` OR `)})`;
    }
    return sql`(${sql.join(rule.rules.map(compileRule), sql` AND `)})`;
  }
  if ('days' in rule) {
    const cutoff = new Date(Date.now() - rule.days * 86400000).toISOString();
    const timestamp = rule.field === 'lastOpenAt' ? contacts.lastOpenAt : contacts.lastClickAt;
    const coverage = rule.field === 'lastOpenAt' ? contacts.openObservedSince : contacts.clickObservedSince;
    return rule.operator === 'within' ? sql`${timestamp} >= ${cutoff}::timestamptz` : sql`(${coverage} <= ${cutoff}::timestamptz AND (${timestamp} IS NULL OR ${timestamp} < ${cutoff}::timestamptz))`;
  }
  if (rule.field === 'property') return compilePropertyRule(rule);
  const field = rule.field === 'email' ? sql`${contacts.email}` : sql`(${contacts.properties} ->> ${rule.field})`;
  const value = rule.field === 'email' ? rule.value.trim().toLowerCase() : rule.value;
  if (rule.operator === 'eq') return sql`${field} = ${value}`;
  if (rule.operator === 'neq') return sql`(${field} IS NOT NULL AND ${field} <> ${value})`;
  // strpos treats wildcard characters as literal text, never SQL syntax.
  return sql`strpos(lower(${field}), lower(${rule.value})) > 0`;
}
// Keep typed comparisons separate from legacy fields, which compare their textual JSON representation.
function textEquality(rule: SegmentRule): { target: string; value: string } | null {
  if ('rules' in rule || 'days' in rule || rule.operator !== 'eq') return null;
  if (rule.field !== 'property') return rule.field === 'email' ? { target: 'email', value: rule.value.trim().toLowerCase() } : { target: rule.field, value: rule.value };
  return rule.type === 'string' ? { target: `property:${rule.key}`, value: rule.value } : null;
}
const stringProperty = (key: string) => sql`jsonb_typeof(${contacts.properties} -> ${key}) = 'string'`;
const NUMBER_TEXT = '^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]+)?$';
const CLOCK = '(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?|24:00(?::00(?:[.]0+)?)?';
const ISO_TEXT = `^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])(?:[Tt](?:${CLOCK})(?:[Zz]|[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?)?)?$`;
const ZONE = '([+-])([0-9]{2})(?::?([0-9]{2}))?$';
// C-collated sentinels outside the entire four-digit ISO range, including at either year boundary.
function adjacentDay(day: string, delta: number) {
  const date = new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000), year = date.getUTCFullYear();
  return year < 0 ? '' : year > 9999 ? ':' : date.toISOString().slice(0, 10);
}
// SQL dates have no year zero. ISO year 0000 is 1 BC in the same proleptic Gregorian calendar.
function propertyDay(text: SQL, operator: 'before' | 'after' | 'on', target: string) {
  const lexical = sql`(${text} COLLATE "C")`;
  // Offsets and 24:00 can move a local date by at most one day. Reject distant misses before parsing.
  const coarse = operator === 'before' ? sql`${lexical} < ${adjacentDay(target, 1)}` : operator === 'after' ? sql`${lexical} >= ${target}`
    : sql`${lexical} >= ${adjacentDay(target, -1)} AND ${lexical} < ${adjacentDay(target, 2)}`;
  const local = sql`(CASE WHEN left(${text},4) = '0000' THEN '0001' || substr(${text},5,6) || ' BC' ELSE left(${text},10) END)`;
  // The shape enforces valid months and days 1..31. Only the last three days can need a calendar check.
  const validCalendar = sql`(substr(${text},9,2) COLLATE "C" <= '28' OR pg_input_is_valid(${local}, 'date'))`;
  // Shift the comparison day rather than rounding a timestamp: 23:59:59.999999999 still belongs to this day.
  // A scalar offset expression keeps the whole scan parallelizable. Its casts are inside the full-shape CASE.
  const zone = sql`(regexp_match(substr(${text},12), ${ZONE}))`;
  const minutes = sql`(substr(${text},12,2)::int * 60 + substr(${text},15,2)::int -
    (CASE ${zone}[1] WHEN '-' THEN -1 ELSE 1 END) * (coalesce(${zone}[2]::int,0)*60 + coalesce(${zone}[3]::int,0)))`;
  const bound = sql`CASE WHEN length(${text}) = 10 OR (right(${text},1) IN ('Z','z') AND substr(${text},12,2) <> '24') THEN ${target}
    WHEN ${minutes} < 0 THEN ${adjacentDay(target,1)} WHEN ${minutes} >= 1440 THEN ${adjacentDay(target,-1)} ELSE ${target} END`;
  const comparison = sql.raw(operator === 'before' ? '<' : operator === 'after' ? '>' : '=');
  return sql`(${coarse} AND CASE WHEN ${text} ~ ${ISO_TEXT} AND ${validCalendar}
    THEN (left(${text},10) COLLATE "C") ${comparison} (${bound}) ELSE false END)`;
}
function propertyNumber(key: string) {
  const value = sql`(${contacts.properties} -> ${key})`, text = sql`(${contacts.properties} ->> ${key})`;
  return sql`(CASE jsonb_typeof(${value}) WHEN 'number' THEN ${value}::numeric WHEN 'string' THEN CASE WHEN ${text} ~ ${NUMBER_TEXT} AND pg_input_is_valid(${text}, 'numeric') THEN ${text}::numeric END END)`;
}
function compilePropertyRule(rule: PropertyRule): SQL {
  const text = sql`(${contacts.properties} ->> ${rule.key})`;
  if (!('value' in rule)) return rule.operator === 'set' ? sql`${text} IS NOT NULL` : sql`${text} IS NULL`;
  if (rule.type === 'string') {
    const condition = rule.operator === 'eq' ? sql`${text} = ${rule.value}` : rule.operator === 'neq' ? sql`${text} <> ${rule.value}`
      : sql`strpos(lower(${text}), lower(${rule.value})) > 0`;
    return sql`(${stringProperty(rule.key)} AND ${condition})`;
  }
  if (rule.type === 'number') {
    const number = propertyNumber(rule.key);
    return sql`${number} ${sql.raw(rule.operator === 'lt' ? '<' : rule.operator === 'gt' ? '>' : '=')} ${String(rule.value)}::numeric`;
  }
  return propertyDay(text, rule.operator, rule.value);
}
// Keep the full membership-key probe correlated even immediately after a large import,
// before PostgreSQL has analyzed the new row distribution.
function inList(identity: Actor, listId: string): SQL { return sql`EXISTS (SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${listMembers.contactId} = ${contacts.id} OFFSET 0)`; }
const PREVIEW_SMALL_LIST = 5000, PREVIEW_VERY_LARGE_LIST = 100_000, PREVIEW_READ_SECONDS = 15;
async function previewSegmentCounts(db: DbExecutor, identity: Actor, rule: SegmentRule, listId?: string) {
  const ruleSql = compileRule(rule);
  let fromSql: SQL;
  if (listId) {
    const big = await db.execute(sql`SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} ORDER BY ${listMembers.contactId} OFFSET ${PREVIEW_SMALL_LIST} LIMIT 1`);
    if (!big.rowCount) {
      fromSql = sql`${listMembers} JOIN ${contacts} ON ${contacts.workspaceId} = ${listMembers.workspaceId} AND ${contacts.id} = ${listMembers.contactId} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${isNull(contacts.deletedAt)} AND ${ruleSql}`;
    } else {
      // Medium lists (5k..100k) benefit from planner-chosen semi-joins; very large lists (>100k) fence EXISTS with OFFSET 0
      // so Postgres filters contacts by the segment rule first instead of merge-joining millions of memberships.
      const huge = await db.execute(sql`SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} ORDER BY ${listMembers.contactId} OFFSET ${PREVIEW_VERY_LARGE_LIST} LIMIT 1`);
      fromSql = huge.rowCount
        ? sql`${contacts} WHERE ${scope(contacts, identity)} AND ${isNull(contacts.deletedAt)} AND ${ruleSql} AND ${inList(identity, listId)}`
        : sql`${contacts} WHERE ${scope(contacts, identity)} AND ${isNull(contacts.deletedAt)} AND ${ruleSql} AND EXISTS (SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${listMembers.contactId} = ${contacts.id})`;
    }
  } else {
    fromSql = sql`${contacts} WHERE ${scope(contacts, identity)} AND ${isNull(contacts.deletedAt)} AND ${ruleSql}`;
  }
  const { rows: [row] } = await db.execute<{ matched: number; eligible: number; suppressed: number; unsubscribed: number; risky: number }>(sql`
    SELECT count(*)::int AS matched,
      count(*) FILTER (WHERE NOT suppressed AND marketing_consent = 'subscribed' AND NOT risky)::int AS eligible,
      count(*) FILTER (WHERE suppressed)::int AS suppressed,
      count(*) FILTER (WHERE NOT suppressed AND marketing_consent <> 'subscribed')::int AS unsubscribed,
      count(*) FILTER (WHERE NOT suppressed AND marketing_consent = 'subscribed' AND risky)::int AS risky
    FROM (SELECT ${contacts.suppressed} AS suppressed, ${contacts.marketingConsent} AS marketing_consent, ${skippedRisk(sql`${contacts.risk}`, sql`${contacts.riskAllowed}`)} AS risky FROM ${fromSql} LIMIT 1001) bounded`);
  if (row!.matched > 1000) throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'This preview supports at most 1000 matching contacts. Narrow the audience; no contacts were silently truncated.');
  return row!;
}
// One INSERT ... SELECT captures membership, consent and only referenced personalization values.
// Keyset-paging the live audience across transactions would not be a review snapshot.
// The audience's lists and segments, locked for share when the caller snapshots, and the matching conditions over contacts.
async function audienceConditions(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, lock: boolean, joined = false) {
  if (identity.domains.length) throw unrestrictedRequired(identity, 'The workspace audience needs', { permission: 'audience', level: 'read' });
  const listIds = [...new Set([spec.listId, ...(spec.excludeListIds ?? [])])].sort();
  const segmentIds = [...new Set([...(spec.segmentId ? [spec.segmentId] : []), ...(spec.excludeSegmentIds ?? [])])].sort();
  const listQuery = db.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), inArray(lists.id, listIds))).orderBy(asc(lists.id));
  if ((await (lock ? listQuery.for('share') : listQuery)).length !== listIds.length) notFound('List');
  const segmentQuery = db.select().from(segments).where(and(scope(segments, identity), inArray(segments.id, segmentIds))).orderBy(asc(segments.id));
  const lockedSegments = segmentIds.length ? await (lock ? segmentQuery.for('share') : segmentQuery) : [];
  if (lockedSegments.length !== segmentIds.length) notFound('Segment');
  // Set-based membership (no OFFSET 0 fence) lets the planner hash-join millions of members instead of probing per contact.
  const member = (listId: string) => sql`EXISTS (SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${listMembers.contactId} = ${contacts.id})`;
  // joined: the caller joins the list's memberships (memberJoin) for when each contact joined, instead of this test.
  const conditions = joined ? [] : [member(spec.listId)];
  if (spec.segmentId) conditions.push(compileRule(lockedSegments.find(row => row.id === spec.segmentId)!.rule));
  for (const listId of spec.excludeListIds ?? []) conditions.push(sql`NOT (${member(listId)})`);
  for (const segmentId of spec.excludeSegmentIds ?? []) conditions.push(sql`NOT (${compileRule(lockedSegments.find(row => row.id === segmentId)!.rule)})`);
  return conditions;
}
/** The main list's memberships, joined to its contacts: `lm.created_at` is when each joined the list. */
const memberJoin = (identity: Pick<Actor, 'workspaceId'>, listId: string) => sql`JOIN audience_list_members lm ON lm.workspace_id = ${contacts.workspaceId} AND lm.list_id = ${listId} AND lm.contact_id = ${contacts.id} AND lm.workspace_id = ${identity.workspaceId}`;
/** When the list was last sent to: the capture of its latest real campaign that released anyone (null: never). */
export async function listLastSent(db: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string): Promise<string | null> {
  const [row] = (await db.execute<{ at: string | null }>(sql`SELECT max(coalesce(r.captured_at, c.updated_at))::text AS at FROM sending_campaigns c
    LEFT JOIN sending_campaign_reviews r ON r.workspace_id = c.workspace_id AND r.id = c.review_id
    WHERE c.workspace_id = ${identity.workspaceId} AND c.list_id = ${listId} AND c.expanded > 0 AND NOT c.simulated`)).rows;
  return row?.at ?? null;
}
/** Engagement tiers for a campaign's order (RAMP.plan): 0 opened or clicked within engagedDays, 1 mailed before (any open
 *  or click on record, or on the list when it was last sent to), 2 never mailed: joined since, with nothing on record. */
const engagedAt = sql`greatest(${contacts.lastOpenAt}, ${contacts.lastClickAt})`;
const neverMailed = (lastSent: string | null) => sql`(${contacts.observedSince} IS NULL AND ${lastSent === null ? sql`true` : sql`lm.created_at > ${lastSent}::timestamptz`})`;
const tierSql = (lastSent: string | null) => sql`(CASE WHEN ${engagedAt} >= now() - make_interval(days => ${RAMP.plan.engagedDays}::int) THEN 0 WHEN ${neverMailed(lastSent)} THEN 2 ELSE 1 END)::smallint`;
/** Of the audience a campaign would reach, how many were never mailed (tier 2); null when counting takes over a second. */
export async function countNeverMailed(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice: boolean, lastSent: string | null): Promise<number | null> {
  const conditions = await audienceConditions(db, identity, spec, false, true);
  return (db as Database).transaction(async tx => {
    await tx.execute(sql`SAVEPOINT never_mailed`);
    try {
      await tx.execute(sql`SET LOCAL statement_timeout = '1s'`);
      await tx.execute(sql`SET LOCAL enable_nestloop = off`);
      const [row] = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${contacts} ${memberJoin(identity, spec.listId)}
        WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} AND ${reachable(requiredNotice)} AND ${neverMailed(lastSent)}`)).rows;
      return row?.n ?? 0;
    } catch (error) {
      if (!statementTimedOut(error)) throw error;
      return null;
    } finally {
      // The settings end with the savepoint, never leaking into the caller's transaction.
      await tx.execute(sql`ROLLBACK TO SAVEPOINT never_mailed`);
      await tx.execute(sql`RELEASE SAVEPOINT never_mailed`);
    }
  });
}
// Who a campaign may reach: subscribers, or for a required notice everyone who is not suppressed (bounced, complained),
// people who unsubscribed from marketing or never subscribed included.
// Contacts flagged as risky are skipped unless their owner allowed them (src/list-hygiene.ts), whatever the campaign.
const consented = (requiredNotice: boolean) => requiredNotice ? sql`true` : sql`${contacts.marketingConsent} = 'subscribed'`;
const skipped = skippedRisk(sql`${contacts.risk}`, sql`${contacts.riskAllowed}`);
const reachable = (requiredNotice: boolean) => sql`NOT ${contacts.suppressed} AND ${consented(requiredNotice)} AND (${contacts.risk} IS NULL OR ${contacts.riskAllowed})`;
/** Who campaigns skip as risky out of the reachable, by reason: counted aggregates named risky_<reason>. */
const riskyColumns = (risk: SQL, risky: SQL = sql`true`) => sql.join(RISKS.map(r => sql`count(*) FILTER (WHERE ${risky} AND ${risk} = ${r})::int AS ${sql.identifier(`risky_${r}`)}`), sql`, `);
type RiskyRow = { [K in `risky_${Risk}`]: number };
const riskyOf = (row: RiskyRow) => riskCounts(RISKS.map(r => ({ risk: r, count: row[`risky_${r}`] })));
export type AudienceCountsResult = { matched: number; eligible: number; suppressed: number; unsubscribed: number; risky: number; riskyByReason: RiskCounts };
/** Read-only counts of the live audience (the dashboard's pre-send check); nothing is frozen or locked. */
export async function countCampaignAudience(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice = false): Promise<AudienceCountsResult> {
  const conditions = await audienceConditions(db, identity, spec, false);
  const [row] = (await db.execute<{ matched: number; eligible: number; suppressed: number; unsubscribed: number } & RiskyRow>(sql`SELECT count(*)::int AS matched,
      count(*) FILTER (WHERE ${reachable(requiredNotice)})::int AS eligible,
      count(*) FILTER (WHERE ${contacts.suppressed})::int AS suppressed,
      count(*) FILTER (WHERE NOT ${contacts.suppressed} AND NOT (${consented(requiredNotice)}))::int AS unsubscribed,
      ${riskyColumns(sql`${contacts.risk}`, sql`NOT ${contacts.suppressed} AND ${consented(requiredNotice)} AND ${skipped}`)}
    FROM ${contacts} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)}`)).rows;
  const risky = riskyOf(row!);
  return { matched: row!.matched, eligible: row!.eligible, suppressed: row!.suppressed, unsubscribed: row!.unsubscribed, risky: risky.total, riskyByReason: risky.byReason };
}
/** The list's members campaigns skip as risky, by reason: the workspace's flagged contacts (migration 498's partial index)
 *  joined to the list's memberships by hash. Run it with nested loops off (riskyByHash): on statistics from before the
 *  flags (an hourly pass changes a few percent of a table, too few for autovacuum to analyze it) the planner expects one
 *  flagged contact and probes the memberships once per flagged contact, 12 s cold for 75,000 of a 2,000,000-member list on
 *  the lab, against 0.26 s warm by hash (and a sequential read of the memberships cold). */
const listRisky = (identity: Pick<Actor, 'workspaceId'>, listId: string, requiredNotice: boolean) => sql`(SELECT coalesce(jsonb_object_agg(risk, n), '{}'::jsonb) FROM (
    SELECT c.risk, count(*)::int AS n FROM audience_contacts c
    WHERE c.workspace_id = ${identity.workspaceId} AND c.risk IS NOT NULL AND NOT c.risk_allowed AND c.deleted_at IS NULL AND NOT c.suppressed
      ${requiredNotice ? sql`` : sql`AND c.marketing_consent = 'subscribed'`}
      AND EXISTS (SELECT 1 FROM audience_list_members m WHERE m.workspace_id = c.workspace_id AND m.list_id = ${listId} AND m.contact_id = c.id)
    GROUP BY c.risk) r)`;
const riskyFrom = (json: Record<string, number> | null) => riskCounts(Object.entries(json ?? {}).map(([risk, count]) => ({ risk, count })));
async function riskyByHash<T>(db: DbExecutor, work: (db: DbExecutor) => Promise<T>, own: boolean) {
  if (own && 'transaction' in db) return (db as Database).transaction(async tx => { await tx.execute(sql`SET LOCAL enable_nestloop = off`); return work(tx); });
  await db.execute(sql`SET LOCAL enable_nestloop = off`);
  try { return await work(db); } finally { await db.execute(sql`SET LOCAL enable_nestloop TO DEFAULT`); }
}

/** Display-only whole-list counts. The list tally includes every committed delta, not just its last fold. */
export async function countCampaignAudienceForDisplay(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice = false): Promise<AudienceCountsResult> {
  if (identity.domains.length || spec.segmentId || spec.excludeListIds?.length || spec.excludeSegmentIds?.length) {
    return countCampaignAudience(db, identity, spec, requiredNotice);
  }
  // Anchor to the scoped list so a missing or foreign list still returns 404, not the counts of an empty list.
  const { rows: [row] } = await riskyByHash(db, db => db.execute<{ subscribed: number; unsubscribed: number; unknown: number; suppressed: number; risky: Record<string, number> | null }>(sql`
    SELECT coalesce(sum(c.subscribed), 0)::int AS subscribed, coalesce(sum(c.unsubscribed), 0)::int AS unsubscribed,
      coalesce(sum(c.unknown), 0)::int AS unknown, coalesce(sum(c.suppressed), 0)::int AS suppressed, ${listRisky(identity, spec.listId, requiredNotice)} AS risky
    FROM audience_lists l LEFT JOIN audience_list_counts c ON c.workspace_id = l.workspace_id AND c.list_id = l.id
    WHERE l.workspace_id = ${identity.workspaceId} AND l.id = ${spec.listId}
    GROUP BY l.id`), true);
  if (!row) return notFound('List');
  const notSubscribed = row.unsubscribed + row.unknown, risky = riskyFrom(row.risky);
  return {
    matched: row.subscribed + notSubscribed + row.suppressed,
    eligible: Math.max(0, (requiredNotice ? row.subscribed + notSubscribed : row.subscribed) - risky.total),
    suppressed: row.suppressed,
    unsubscribed: requiredNotice ? 0 : notSubscribed,
    risky: risky.total, riskyByReason: risky.byReason,
  };
}
export const SYNC_CAPTURE_MAX_LIST_MEMBERS = 5_000;
const SNAPSHOT_MAX_MATCHED = 2_000_000, SNAPSHOT_MAX_RECIPIENT_BYTES = 1_048_576, SNAPSHOT_MAX_REVIEW_BYTES = 1_073_741_824;
const DEFAULT_CAPTURE_SLICE_ROWS = 200_000;
const ESTIMATE_TIMEOUT_MS = 200;

export class CaptureAborted extends Error {
  constructor() { super('Campaign capture aborted because the campaign is no longer preparing.'); }
}
export type StaticStampSpec = { baseHash: string; baseBytes: number; storedSubject: string | null };
export type SnapshotProgress = { total: number; captured: number; prepared: number };
export type SnapshotOptions = {
  large?: boolean;
  staticStamp?: StaticStampSpec;
  sliceRows?: number;
  onProgress?: (progress: SnapshotProgress) => Promise<'continue' | 'abort'>;
  /** How many of the first recipients are a uniform sample of the whole audience (the Hosted list probe's size). */
  leading?: (eligible: number) => number;
};

/** O(SYNC_CAPTURE_MAX_LIST_MEMBERS) PK Index-Only Scan (~0.5 ms regardless of whether the list has 2M or 20M members). */
export async function isSmallAudienceList(db: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string): Promise<boolean> {
  const probe = await db.execute(sql`SELECT 1 FROM audience_list_members WHERE workspace_id=${identity.workspaceId} AND list_id=${listId} ORDER BY contact_id OFFSET ${SYNC_CAPTURE_MAX_LIST_MEMBERS} LIMIT 1`);
  return !probe.rowCount;
}

/**
 * Fast O(1)/bounded recipient estimate for CampaignQueued.queued on deferred large launches (>5,000 members):
 * 1. Whole list + audience_list_counts tally (#596) when present (~0.2 ms, exact).
 * 2. Segment or missing tally: bounded count inside a 200 ms savepoint (exact when fast).
 * 3. Last known preview count stored on the campaign (sending_campaigns.audience_estimate), if any.
 * 4. Only then 0.
 * Always validates list/segment existence before the savepoint so 404 errors remain synchronous.
 */
/** At most how many subscribers a campaign to `listId` reaches (a segment of it or exclusions reach fewer): the list's
 *  counts (audience_list_counts), 0 without them. Constant time: the launch's readiness bound when counting timed out. */
export async function listSubscribedBound(db: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string) {
  if (!(await db.execute<{ ok: boolean }>(sql`SELECT to_regclass('public.audience_list_counts') IS NOT NULL AS ok`)).rows[0]?.ok) return 0;
  const [row] = (await db.execute<{ n: number }>(sql`SELECT coalesce(sum(subscribed), 0)::int AS n FROM audience_list_counts WHERE workspace_id = ${identity.workspaceId} AND list_id = ${listId}`)).rows;
  return Number(row?.n ?? 0);
}
export async function estimateCampaignAudience(
  db: DbExecutor,
  identity: Actor,
  spec: z.infer<typeof AudienceSpec>,
  requiredNotice: boolean,
  cachedEstimate: number | null,
): Promise<{ queued: number; definitive?: 'empty' | 'over_limit'; risky?: { total: number; byReason: RiskCounts }; approximate?: true }> {
  const conditions = await audienceConditions(db, identity, spec, true);
  if (!spec.segmentId && !spec.excludeListIds?.length && !spec.excludeSegmentIds?.length) {
    const hasTally = (await db.execute<{ ok: boolean }>(sql`SELECT to_regclass('public.audience_list_counts') IS NOT NULL AS ok`)).rows[0]?.ok;
    if (hasTally) {
      const [tally] = (await riskyByHash(db, db => db.execute<{ subscribed: number; reachable: number; risky: Record<string, number> | null }>(sql`
        SELECT coalesce(sum(subscribed), 0)::int AS subscribed,
               coalesce(sum(subscribed + unsubscribed + unknown), 0)::int AS reachable, ${listRisky(identity, spec.listId, requiredNotice)} AS risky
        FROM audience_list_counts
        WHERE workspace_id = ${identity.workspaceId} AND list_id = ${spec.listId}`), false)).rows;
      const risky = riskyFrom(tally?.risky ?? null), expected = (requiredNotice ? (tally?.reachable ?? 0) : (tally?.subscribed ?? 0)) - risky.total;
      if (expected > 0) return { queued: expected, risky };
    }
  }
  await db.execute(sql`SAVEPOINT audience_estimate`);
  try {
    await db.execute(sql.raw(`SET LOCAL statement_timeout = '${ESTIMATE_TIMEOUT_MS}ms'`));
    await db.execute(sql`SET LOCAL enable_nestloop = off`);
    const [row] = (await db.execute<{ eligible: number }>(sql`
      SELECT count(*)::int AS eligible FROM (
        SELECT 1 FROM ${contacts}
        WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} AND ${reachable(requiredNotice)}
        LIMIT ${SNAPSHOT_MAX_MATCHED + 1}
      ) bounded`)).rows;
    const eligible = row?.eligible ?? 0;
    if (eligible === 0) return { queued: 0, definitive: 'empty' };
    if (eligible > SNAPSHOT_MAX_MATCHED) return { queued: eligible, definitive: 'over_limit' };
    return { queued: eligible };
  } catch (error) {
    if (!statementTimedOut(error)) throw error;
    return { queued: cachedEstimate !== null && cachedEstimate > 0 ? cachedEstimate : 0, approximate: true };
  } finally {
    // Always roll back the read-only savepoint (even on success) so SET LOCAL statement_timeout=200ms and
    // enable_nestloop=off NEVER leak into the rest of the launch transaction.
    await db.execute(sql`ROLLBACK TO SAVEPOINT audience_estimate`);
    await db.execute(sql`RELEASE SAVEPOINT audience_estimate`);
  }
}

type SnapshotCounts = { matched: number; eligible: number; suppressed: number; unsubscribed: number; risky: { total: number; byReason: RiskCounts }; bytes: string | number; captured: number; maxBytes?: number };
export const emptyAudience = (requiredNotice: boolean, risky = 0) => new ApiError(422, 'EMPTY_AUDIENCE', `${requiredNotice ? 'This campaign has no recipients who can receive email.' : 'This campaign has no eligible subscribed recipients.'}${risky ? ` ${risky.toLocaleString('en-US')} risky ${risky === 1 ? 'address is' : 'addresses are'} skipped: see Audience.` : ''}`);
function checkedSnapshot(row: SnapshotCounts, requiredNotice: boolean) {
  if (row.matched > SNAPSHOT_MAX_MATCHED) throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaign reviews support at most 2,000,000 matching contacts. No recipients were truncated.');
  if (row.captured !== row.eligible || (row.maxBytes ?? 0) > SNAPSHOT_MAX_RECIPIENT_BYTES || Number(row.bytes) > SNAPSHOT_MAX_REVIEW_BYTES) throw new ApiError(413, 'CAMPAIGN_RECIPIENT_DATA_TOO_LARGE', 'Referenced personalization exceeds 1 GiB per review or 1 MiB per recipient.');
  if (!row.eligible) throw emptyAudience(requiredNotice, row.risky.total);
  return { matched: row.matched, eligible: row.eligible, suppressed: row.suppressed, unsubscribed: row.unsubscribed, risky: row.risky, recipientBytes: Number(row.bytes) };
}
// Flat SQL expressions avoid executing correlated jsonb_each/jsonb_object_agg and array_position subplans millions of times.
function priorityRankSql(priority: z.infer<typeof AudienceSpec>['priority'], propsCol: SQL): SQL {
  if (!priority) return sql`0::smallint`;
  const branches = priority.values.map((val, idx) => sql`WHEN ${val} THEN ${idx + 1}`);
  return sql`(CASE ${propsCol} ->> ${priority.property} ${sql.join(branches, sql` `)} ELSE ${priority.values.length + 1} END)::smallint`;
}
function recipientJsonSql(propertyKeys: string[], idCol: SQL, emailCol: SQL, nameCol: SQL, propsCol: SQL): SQL {
  const customKeys = [...new Set(propertyKeys)];
  const propsExpr = customKeys.length
    ? sql.join(customKeys.map(k => sql`(CASE WHEN ${propsCol} ? ${k} THEN jsonb_build_object(${k}::text, ${propsCol} -> ${k}) ELSE '{}'::jsonb END)`), sql` || `)
    : sql`'{}'::jsonb`;
  return sql`jsonb_strip_nulls(jsonb_build_object('id', ${idCol}, 'email', ${emailCol}, 'name', nullif(${propertyKeys.includes('name') ? nameCol : sql`NULL::text`}, ''), 'properties', ${propsExpr}))`;
}
export async function snapshotCampaignAudience(
  db: DbExecutor,
  identity: Actor,
  spec: z.infer<typeof AudienceSpec>,
  reviewId: string,
  propertyKeys: string[],
  requiredNotice = false,
  options?: SnapshotOptions,
) {
  const conditions = await audienceConditions(db, identity, spec, true, true);
  const rankExpr = priorityRankSql(spec.priority, sql`${contacts.properties}`);
  // The order (RAMP.plan): the most engaged first, never-mailed last, in the order they joined the list.
  const lastSent = await listLastSent(db, identity, spec.listId);
  const order = sql`${tierSql(lastSent)} AS tier, ${engagedAt} AS engaged, lm.created_at AS joined, hashtextextended(${contacts.id}, 0) AS h`;
  const counts = sql`count(*)::int AS matched,count(*) FILTER (WHERE eligible)::int AS eligible,
    count(*) FILTER (WHERE suppressed)::int AS suppressed,count(*) FILTER (WHERE NOT eligible AND NOT suppressed AND skipped_risk IS NULL)::int AS unsubscribed,
    ${riskyColumns(sql`skipped_risk`)}`;
  // The risk of a contact this capture skips for it alone: reachable but for its risk.
  const skippedRiskSql = sql`CASE WHEN NOT ${contacts.suppressed} AND ${consented(requiredNotice)} AND ${skipped} THEN ${contacts.risk} END`;
  // The audience's contacts and list members are joined whole, by hash, whatever the statistics say. With stale ones
  // (tables autovacuum found empty, then a list imported before the next analyze) the planner expects one row on each
  // side and compares every contact with every member in a nested loop: minutes at 50,000 members, never done at
  // 2,000,000.
  const wholeJoins = async <T extends Record<string, unknown>>(statement: SQL) => {
    await db.execute(sql`SET LOCAL enable_nestloop = off`);
    const result = await db.execute<T>(statement);
    await db.execute(sql`SET LOCAL enable_nestloop TO DEFAULT`);
    return result;
  };
  const large = options?.large ?? !(await isSmallAudienceList(db, identity, spec.listId));
  if (large) {
    if (!(await db.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275815, hashtext(${identity.workspaceId}))`)).rowCount) throw new ApiError(503,'AUDIENCE_CAPTURE_BUSY','Another large audience capture is running in this workspace; retry the launch when it finishes.',undefined,true);
    if (!(await db.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275812,1) OR pg_try_advisory_xact_lock(275812,2)`)).rowCount) throw new ApiError(503,'AUDIENCE_CAPTURE_BUSY','Large audience captures are busy; retry the launch.',undefined,true);
    await db.execute(sql`SET LOCAL work_mem = '128MB'`);
  }
  const carriesEmail = propertyKeys.length === 0;
  const sliceRows = options?.sliceRows ?? DEFAULT_CAPTURE_SLICE_ROWS;
  await db.execute(sql`DROP TABLE IF EXISTS pg_temp.audience_snapshot, pg_temp.audience_ordered`);
  const staged = await wholeJoins(carriesEmail
    ? sql`CREATE TEMP TABLE audience_snapshot ON COMMIT DROP AS
        SELECT ${rankExpr} AS rank, ${contacts.id} AS id, ${contacts.email} AS email, ${reachable(requiredNotice)} AS eligible, ${contacts.suppressed} AS suppressed, ${skippedRiskSql} AS skipped_risk, ${order}
        FROM ${contacts} ${memberJoin(identity, spec.listId)} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} LIMIT ${SNAPSHOT_MAX_MATCHED + 1}`
    : sql`CREATE TEMP TABLE audience_snapshot ON COMMIT DROP AS
        SELECT ${rankExpr} AS rank, ${contacts.id} AS id, ${reachable(requiredNotice)} AS eligible, ${contacts.suppressed} AS suppressed, ${skippedRiskSql} AS skipped_risk, ${order}
        FROM ${contacts} ${memberJoin(identity, spec.listId)} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} LIMIT ${SNAPSHOT_MAX_MATCHED + 1}`);
  if ((staged.rowCount ?? 0) > SNAPSHOT_MAX_MATCHED) throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaign reviews support at most 2,000,000 matching contacts. No recipients were truncated.');
  const [snapshotRow] = (await db.execute<{ matched: number; eligible: number; suppressed: number; unsubscribed: number } & RiskyRow>(sql`SELECT ${counts} FROM audience_snapshot`)).rows;
  const { matched, eligible, suppressed, unsubscribed } = snapshotRow!, risky = riskyOf(snapshotRow!);
  if (!eligible) throw emptyAudience(requiredNotice, risky.total);
  // The order. The first `leading` recipients (the Hosted list probe) are a uniform sample of the whole audience: the
  // smallest ID hashes, so time-ordered UUIDv7 IDs and the engagement order below cannot make the probe look cleaner than
  // the list (an engaged-first probe would hide the never-mailed tail it exists to catch). Then the explicit priority,
  // the engagement tiers (most recently engaged first), and the order contacts joined the list. One sort, after a top-N
  // pick of the sample's last hash; drop audience_snapshot immediately.
  const lead = Math.min(eligible, Math.max(0, Math.floor(options?.leading?.(eligible) ?? 0)));
  // (Named apart from h: ORDER BY h would sort by the text output column, not the hash.)
  const [edge] = lead ? (await db.execute<{ edge_h: string; edge_id: string }>(sql`SELECT h::text AS edge_h, id AS edge_id FROM audience_snapshot WHERE eligible ORDER BY h, id OFFSET ${lead - 1} LIMIT 1`)).rows : [];
  const sampled = edge ? sql`(h, id) <= (${edge.edge_h}::bigint, ${edge.edge_id}::text)` : sql`false`;
  const ordering = sql`ORDER BY ${sampled} DESC, CASE WHEN ${sampled} THEN h END, rank, tier, engaged DESC NULLS LAST, joined, id`;
  await db.execute(carriesEmail
    ? sql`CREATE TEMP TABLE audience_ordered ON COMMIT DROP AS SELECT (row_number() OVER (${ordering}))::int AS ordinal, id, email FROM audience_snapshot WHERE eligible`
    : sql`CREATE TEMP TABLE audience_ordered ON COMMIT DROP AS SELECT (row_number() OVER (${ordering}))::int AS ordinal, id FROM audience_snapshot WHERE eligible`);
  await db.execute(sql`DROP TABLE pg_temp.audience_snapshot`);
  const multiSlice = eligible > sliceRows;
  if (multiSlice) {
    await db.execute(sql`CREATE UNIQUE INDEX ON audience_ordered (ordinal)`);
    await db.execute(sql`ANALYZE audience_ordered`);
  }
  if (options?.onProgress) {
    if (await options.onProgress({ total: eligible, captured: 0, prepared: 0 }) === 'abort') throw new CaptureAborted();
  }
  const insertRecipientExpr = recipientJsonSql(propertyKeys, sql`c.id`, sql`c.email`, sql`c.name`, sql`c.properties`);
  const stamp = options?.staticStamp;
  let captured = 0, totalBytes = 0, maxBytes = 0;
  for (let from = 0; from < eligible; from += sliceRows) {
    const to = Math.min(eligible, from + sliceRows);
    let chunk: { captured: number; max_bytes: number; total_bytes: string } | undefined;
    if (carriesEmail && stamp) {
      const { rows: [ins] } = await db.execute<{ captured: number; max_bytes: number; total_bytes: string; first_bad_id: string | null }>(sql`
        WITH slice AS (
          SELECT o.ordinal, o.id, o.email, ${validMailAddressSql(sql`o.email`)} AS ok,
            jsonb_build_object('id', o.id, 'email', o.email, 'properties', '{}'::jsonb) AS recipient
          FROM audience_ordered o
          WHERE o.ordinal > ${from} AND o.ordinal <= ${to}
          ORDER BY o.ordinal
        ), bad AS (
          SELECT id FROM slice WHERE NOT ok ORDER BY ordinal LIMIT 1
        ), inserted AS (
          INSERT INTO sending_review_recipients(review_id, ordinal, recipient, recipient_bytes, content_hash, subject, snapshot_bytes)
          SELECT ${reviewId}, s.ordinal, s.recipient, octet_length(s.recipient::text),
            's1:' || encode(sha256(convert_to(${stamp.baseHash} || ':' || s.email, 'UTF8')), 'hex'),
            ${stamp.storedSubject},
            ${stamp.baseBytes} + octet_length(s.email) + 2
          FROM slice s
          WHERE s.ok AND NOT EXISTS (SELECT 1 FROM bad)
          ORDER BY s.ordinal
          RETURNING recipient_bytes
        )
        SELECT count(*)::int AS captured, coalesce(max(recipient_bytes), 0)::int AS max_bytes, coalesce(sum(recipient_bytes), 0)::bigint AS total_bytes,
          (SELECT id FROM bad) AS first_bad_id
        FROM inserted`);
      if (ins?.first_bad_id) {
        throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Contact ${ins.first_bad_id}: Recipient or rendered message is invalid (to).`, 'contactId');
      }
      chunk = ins;
    } else if (carriesEmail) {
      ({ rows: [chunk] } = await db.execute<{ captured: number; max_bytes: number; total_bytes: string }>(sql`
        WITH inserted AS (
          INSERT INTO sending_review_recipients(review_id, ordinal, recipient, recipient_bytes)
          SELECT ${reviewId}, o.ordinal, r.recipient, octet_length(r.recipient::text)
          FROM audience_ordered o
          CROSS JOIN LATERAL (SELECT jsonb_build_object('id', o.id, 'email', o.email, 'properties', '{}'::jsonb) AS recipient) r
          WHERE o.ordinal > ${from} AND o.ordinal <= ${to}
          ORDER BY o.ordinal
          RETURNING recipient_bytes
        )
        SELECT count(*)::int AS captured, coalesce(max(recipient_bytes), 0)::int AS max_bytes, coalesce(sum(recipient_bytes), 0)::bigint AS total_bytes FROM inserted`));
    } else {
      const insertSql = sql`
        WITH inserted AS (
          INSERT INTO sending_review_recipients(review_id, ordinal, recipient, recipient_bytes)
          SELECT ${reviewId}, o.ordinal, r.recipient, octet_length(r.recipient::text)
          FROM audience_ordered o
          JOIN audience_contacts c ON c.workspace_id = ${identity.workspaceId} AND c.id = o.id
          CROSS JOIN LATERAL (SELECT ${insertRecipientExpr} AS recipient) r
          WHERE o.ordinal > ${from} AND o.ordinal <= ${to}
          ORDER BY o.ordinal
          RETURNING recipient_bytes
        )
        SELECT count(*)::int AS captured, coalesce(max(recipient_bytes), 0)::int AS max_bytes, coalesce(sum(recipient_bytes), 0)::bigint AS total_bytes FROM inserted`;
      // Single-slice personalized captures use hash join (immune to stale reltuples=0 stats); multi-slice captures join
      // bounded slices against the contacts PK index so each slice stays well under a 30 s statement timeout.
      ({ rows: [chunk] } = multiSlice
        ? await db.execute<{ captured: number; max_bytes: number; total_bytes: string }>(insertSql)
        : await wholeJoins<{ captured: number; max_bytes: number; total_bytes: string }>(insertSql));
    }
    captured += chunk?.captured ?? 0;
    maxBytes = Math.max(maxBytes, chunk?.max_bytes ?? 0);
    totalBytes += Number(chunk?.total_bytes ?? 0);
    if (maxBytes > SNAPSHOT_MAX_RECIPIENT_BYTES || totalBytes > SNAPSHOT_MAX_REVIEW_BYTES) {
      throw new ApiError(413, 'CAMPAIGN_RECIPIENT_DATA_TOO_LARGE', 'Referenced personalization exceeds 1 GiB per review or 1 MiB per recipient.');
    }
    if (options?.onProgress) {
      if (await options.onProgress({ total: eligible, captured, prepared: stamp ? captured : 0 }) === 'abort') throw new CaptureAborted();
    }
  }
  if (large) await db.execute(sql`SET LOCAL work_mem TO DEFAULT`);
  return checkedSnapshot({ matched, eligible, suppressed, unsubscribed, risky, captured, bytes: totalBytes, maxBytes }, requiredNotice);
}
export async function isSuppressed(runtime: Runtime, identity: Actor, email: string): Promise<boolean> {
  const [row] = await runtime.db.select({ suppressed: contacts.suppressed }).from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email.trim().toLowerCase()))).limit(1);
  return row?.suppressed ?? false;
}
export async function canMarket(runtime: Runtime, identity: Actor, email: string): Promise<boolean> {
  const [row] = await runtime.db.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email.trim().toLowerCase()))).limit(1);
  return !!row && !row.deletedAt && !row.suppressed && row.marketingConsent === 'subscribed';
}
export async function recordUnsubscribe(runtime: Runtime, workspaceId: string, email: string, source: 'footer-confirm' | 'rfc8058-post' | 'ses-subscription'): Promise<{ contactId: string; changed: boolean }> {
  const normalized = Email.safeParse(email);
  if (!normalized.success) throw new ApiError(422, 'INVALID_EMAIL', 'A valid email address is required.');
  return runtime.db.transaction(async tx => {
    const identity = { workspaceId };
    await tx.insert(contacts).values({ id: rowId('con'), ...identity, email: normalized.data, risk: staticRiskSql(normalized.data, workspaceId, peekHygieneLists()) as unknown as Risk }).onConflictDoNothing();
    const [contact] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, normalized.data))).limit(1).for('update');
    if (!contact) throw new ApiError(500, 'CONSENT_WRITE_FAILED', 'Unable to persist consent.');
    if (contact.marketingConsent === 'unsubscribed') return { contactId: contact.id, changed: false };
    const now = new Date().toISOString();
    const evidence = source === 'ses-subscription' ? 'Signed SES subscription event reported unsubscribeAll for a single-recipient email.' : source === 'rfc8058-post' ? 'POST request presented a valid one-click unsubscribe token; no human identity asserted.' : 'Footer confirmation form submitted with a valid unsubscribe token; no human identity asserted.';
    await recordConsent(tx, identity, contact, { status: 'unsubscribed', source, evidence, occurredAt: now, actorKeyId: null }, now);
    return { contactId: contact.id, changed: true };
  });
}
/**
 * A consent decision for a contact its caller holds FOR UPDATE: its audit record, the contact.subscription_changed event
 * when the status changes, and the contact itself. The consent route, an unsubscribe and the sign-ups list (signups.ts)
 * all write consent through here. `at`: one time for the event and the contact (an unsubscribe's decision time);
 * without it each is stamped when it is written, after the audit, as the consent route always has.
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
 * A contact the installation keeps in a list from records of its own (the sign-ups list, signups.ts), under the API's
 * rules: the address and name are checked as createContact checks them, properties merge into the contact's own within
 * the 50-key and 16 KiB limits (a merge past them leaves the properties as they were), and the contact joins the list.
 * Consent is recorded only for a contact with no decision yet that isn't suppressed: an opt-out stays an opt-out, and
 * suppression is never touched. A deleted contact stays deleted: what deletion retains is there to keep it from being
 * enrolled again. A waitlist sync marks the membership so reconciliation can distinguish it from a manual addition.
 * Takes the list, then the contact, as an import does.
 */
export async function upsertListContact(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string,
  input: { email: string; name: string | null; fromWaitlist?: boolean; properties: Record<string, string | number | boolean | null>; consent: { source: string; evidence: string; occurredAt: string } }): Promise<ListContactResult> {
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
  if (contact.marketingConsent === 'unknown' && !contact.suppressed) await recordConsent(tx, identity, contact, { status: 'subscribed', ...input.consent, actorKeyId: null });
  if (input.fromWaitlist) await tx.execute(sql`INSERT INTO audience_list_members(workspace_id,list_id,contact_id,signup_waitlist)
    VALUES(${identity.workspaceId},${listId},${contact.id},true) ON CONFLICT(workspace_id,list_id,contact_id)
    DO UPDATE SET signup_waitlist=true WHERE audience_list_members.signup_waitlist IS DISTINCT FROM true`);
  else await tx.insert(listMembers).values({ ...scopeValues(identity), listId, contactId: contact.id }).onConflictDoNothing();
  return added ? 'added' : 'updated';
}

function utf8ByteLength(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      bytes += 2;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    } else bytes += 2;
  }
  return bytes;
}
// Streams one CSV row at a time into a reused buffer using charCodeAt scanning (no RegExp match allocations
// and no 50,000-element string[][] in Worker memory). Rules match app/src/features/audience/csv.ts.
function forEachCsvRow(text: string, onRow: (values: string[], rowIndex: number) => void): number {
  if (utf8ByteLength(text) > IMPORT_MAX_BYTES) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 5 MiB and 50,000 contact rows.');
  const len = text.length, row: string[] = [];
  let i = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0, cell = '', hasCell = false, endedQuote = false, yielded = 0;
  const flushRow = () => {
    row.push(cell); cell = ''; hasCell = false; endedQuote = false;
    let nonBlank = false;
    for (let k = 0; k < row.length; k++) if (row[k]!.trim()) { nonBlank = true; break; }
    if (nonBlank) {
      yielded++;
      if (yielded > IMPORT_MAX_ROWS + 1) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 50,000 contact rows.');
      onRow(row, yielded);
    }
    row.length = 0;
  };
  while (i < len) {
    const start = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 34 || c === 10 || c === 13) break;
      i++;
    }
    if (i > start) {
      if (endedQuote) {
        for (let k = start; k < i; k++) { const c = text.charCodeAt(k); if (c !== 32 && c !== 9) throw new ApiError(422, 'INVALID_CSV', 'Unexpected text after a quoted field.'); }
      } else {
        cell = hasCell ? cell + text.slice(start, i) : text.slice(start, i);
        hasCell = true;
      }
    }
    if (i >= len) break;
    const c = text.charCodeAt(i);
    if (c === 34) {
      if (hasCell || endedQuote) throw new ApiError(422, 'INVALID_CSV', 'Unexpected quote: quote the whole field and double embedded quotes.');
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote < 0) throw new ApiError(422, 'INVALID_CSV', 'A quoted field has no closing quote.');
        cell = hasCell ? cell + text.slice(from, quote) : text.slice(from, quote);
        hasCell = true;
        if (text.charCodeAt(quote + 1) !== 34) { from = quote + 1; break; }
        cell += '"'; from = quote + 2;
      }
      endedQuote = true; i = from;
    } else if (c === 44) {
      row.push(cell); cell = ''; hasCell = false; endedQuote = false;
      if (row.length > 100) throw new ApiError(422, 'INVALID_CSV', 'At most 100 CSV columns are supported.');
      i++;
    } else {
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      flushRow();
    }
  }
  flushRow();
  if (yielded < 2) throw new ApiError(422, 'INVALID_CSV', 'Include a header and at least one contact row.');
  return yielded;
}
class JsonArrayBuilder {
  private chunks: string[] = ['['];
  private pending: string[] = [];
  count = 0;
  push(itemJson: string) {
    this.pending.push((this.count++ ? ',' : '') + itemJson);
    if (this.pending.length >= 512) { this.chunks.push(this.pending.join('')); this.pending.length = 0; }
  }
  finish(): string {
    if (this.pending.length) { this.chunks.push(this.pending.join('')); this.pending.length = 0; }
    this.chunks.push(']');
    const out = this.chunks.join('');
    this.chunks.length = 0;
    return out;
  }
}
function previewImport(input: z.infer<typeof ImportInput>, hygiene: HygieneLists) {
  const mapping = Object.entries(input.mapping);
  let headerLen = 0, emailIdx = -1, nameIdx: number | undefined;
  let propCols: ReadonlyArray<readonly ['firstName' | 'plan' | 'country', number]> = [];
  const rows = new JsonArrayBuilder(), failures = new JsonArrayBuilder(), seen = new Set<string>(), risky = { total: 0, byReason: noRisks() };
  // Rows whose domain the DNS check decides (nothing the address says, or a role name a dead domain outranks), by domain.
  const domains = new Map<string, { plain: number; role: number }>();
  forEachCsvRow(input.csv, (values, rowNum) => {
    if (rowNum === 1) {
      const headers = values.map(h => h.trim());
      if (new Set(headers).size !== headers.length || headers.some(h => !h)) throw new ApiError(422, 'INVALID_CSV_HEADERS', 'CSV headers must be nonempty and unique.');
      const columnIndex = new Map<string, number>();
      for (const [field, column] of mapping) {
        const idx = headers.indexOf(column);
        if (idx < 0) throw new ApiError(422, 'INVALID_IMPORT_MAPPING', `The mapped column for ${field} was not found.`, `mapping.${field}`);
        columnIndex.set(field, idx);
      }
      headerLen = headers.length; emailIdx = columnIndex.get('email')!; nameIdx = columnIndex.get('name');
      propCols = (['firstName', 'plan', 'country'] as const).flatMap(key => {
        const idx = columnIndex.get(key);
        return idx !== undefined ? [[key, idx] as const] : [];
      });
      return;
    }
    if (values.length !== headerLen) { failures.push(JSON.stringify({ row: rowNum, field: 'row', message: 'The row has a different number of columns than the header.' })); return; }
    const rawEmail = values[emailIdx]!.trim();
    const rawName = nameIdx !== undefined ? values[nameIdx]!.trim() : undefined;
    let fastOk = validAddress(rawEmail) && (rawName === undefined || rawName.length <= 200);
    let propJson = '';
    if (fastOk) {
      for (let j = 0; j < propCols.length; j++) {
        const [key, idx] = propCols[j]!;
        const val = values[idx]!.trim();
        if (val.length > 2000) { fastOk = false; break; }
        propJson += (j ? ',' : '') + `"${key}":${JSON.stringify(val)}`;
      }
    }
    let email: string, rowJson: string;
    if (fastOk) {
      email = rawEmail.toLowerCase();
      rowJson = rawName !== undefined
        ? `{"row":${rowNum},"email":${JSON.stringify(email)},"name":${JSON.stringify(rawName)},"properties":{${propJson}}}`
        : `{"row":${rowNum},"email":${JSON.stringify(email)},"properties":{${propJson}}}`;
    } else {
      const properties: Record<string, string> = {};
      for (let j = 0; j < propCols.length; j++) { const [key, idx] = propCols[j]!; properties[key] = values[idx]!.trim(); }
      const parsed = ContactInput.safeParse({ email: rawEmail, name: rawName, properties });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) failures.push(JSON.stringify({ row: rowNum, field: issue.path.join('.'), message: issue.message }));
        return;
      }
      email = parsed.data.email;
      rowJson = JSON.stringify(parsed.data.name !== undefined ? { row: rowNum, email, name: parsed.data.name, properties: parsed.data.properties } : { row: rowNum, email, properties: parsed.data.properties });
    }
    if (seen.has(email)) { failures.push(JSON.stringify({ row: rowNum, field: 'email', message: 'Duplicate normalized email within this import.' })); return; }
    seen.add(email);
    // The row keeps what its address says (list hygiene): commit stores it on a new contact.
    const risk = classifyAddress(email, hygiene)?.risk;
    if (risk) { risky.byReason[risk]++; risky.total++; rowJson = `${rowJson.slice(0, -1)},"risk":"${risk}"}`; }
    if (!risk || risk === 'role') { const d = domainOf(email), n = domains.get(d) ?? { plain: 0, role: 0 }; n[risk ? 'role' : 'plain']++; domains.set(d, n); }
    rows.push(rowJson);
  });
  seen.clear();
  return { rowsJson: rows.finish(), errorsJson: failures.finish(), rowCount: rows.count, risky, domains };
}
export const importStream = { idleMs: MEMORY_LIMITS.streamIdleMs, maxMs: MEMORY_LIMITS.streamMaxMs };
const importStreamBytes = (chars: number) => Math.min(12 * 1024 * 1024, Math.max(256 * 1024, Math.ceil(chars)));

// Stream large import JSON responses one 64 KiB chunk at a time on pull(), holding a shrunk self-reclaiming memory lease.
function streamImportResponse(c: Ctx, meta: ImportMeta, rowsJson: string, errorsJson: string, status: 200 | 201, subscribed?: number, lease?: MemoryLease): Response {
  lease?.shrink(importStreamBytes(rowsJson.length + errorsJson.length));
  const parts = [
    `{"id":${JSON.stringify(meta.id)},"workspaceId":${JSON.stringify(meta.workspaceId)},"listId":${JSON.stringify(meta.listId)},"status":${JSON.stringify(meta.status)},"rows":`,
    rowsJson,
    `,"errors":`,
    errorsJson,
    `,"imported":${meta.imported},"rowsRetained":${meta.rowsScrubbedAt === null},"errorsRetained":${meta.errorsScrubbedAt === null},"risky":${JSON.stringify(receiptRisk(meta.riskSummary))},"createdAt":${JSON.stringify(meta.createdAt)},"updatedAt":${JSON.stringify(meta.updatedAt)}${subscribed !== undefined ? `,"subscribed":${subscribed}` : ''}}`,
  ];
  return streamTextPartsResponse(c, parts, status, { lease, idleMs: importStream.idleMs, maxMs: importStream.maxMs });
}

export function registerAudience(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts', operationId: 'listContacts', tags: ['Audience'], security, description: `Active contacts with current list IDs. A search that is one complete email address returns that contact (exact, any case). Any other search is a case-insensitive literal substring of the email or name. Consent and suppression filters are independent. Pages are also bounded by response size and may return fewer than limit contacts; follow nextCursor while non-null. ${readLimitNote(AUDIENCE_READ_SECONDS)}`, request: { query: ContactQuery }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query');
    return await withAudienceReadMemory(c, async () => {
      const { items, hasMore } = await budgetedRead(c.env.db, async tx => {
        if (query.listId) await findList(tx, identity, query.listId);
        const { rows, hasMore: more } = await boundedContactPage(tx, identity, query);
        return { items: await readContacts(tx, identity, rows, CONTACT_LIST_IDS_PAGE_MAX), hasMore: more };
      }, readLimit(AUDIENCE_READ_SECONDS));
      const { json: body } = buildBoundedPageJson(items, hasMore, AUDIENCE_READ_MAX_BYTES);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts', operationId: 'createContact', tags: ['Audience'], security, request: { body: json(ContactInput) }, responses: { 201: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), input = c.req.valid('json');
    let contact: typeof contacts.$inferSelect | undefined;
    try {
      [contact] = await c.env.db.insert(contacts).values({ id: rowId('con'), ...scopeValues(identity), ...input, risk: await riskFor(c.env, input.email, identity.workspaceId) as unknown as Risk }).onConflictDoNothing().returning();
    } catch (err) {
      if (isContactSizeCheckViolation(err)) throw new ApiError(422, 'VALIDATION_FAILED', 'Contact properties must total at most 16 KiB of JSON.', 'properties');
      throw err;
    }
    if (!contact) throw new ApiError(409, 'CONTACT_EXISTS', 'This address already has a contact or retained consent record. Use imports to restore a deleted contact without changing consent.');
    return c.json(contactBody(contact), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}', operationId: 'getContact', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ContactRead), ...errors } }), async c => {
    const identity = actor(c), row = await findContact(c.env.db, identity, c.req.valid('param').id);
    return c.json((await readContacts(c.env.db, identity, [row], CONTACT_LIST_IDS_SINGLE_MAX))[0]!, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/contacts/{id}', operationId: 'updateContact', tags: ['Audience'], security, request: { params: IdParams, body: json(ContactPatch) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id, input = c.req.valid('json'), found = await findContact(c.env.db, identity, contactId);
    // Sending to a risky address anyway is an owner's or admin's call (manage), not every member's who edits contacts.
    if (input.riskAllowed !== undefined) actor(c, 'manage');
    if (input.riskAllowed !== undefined && !found.risk) throw new ApiError(409, 'CONTACT_NOT_RISKY', 'This contact is not flagged as risky, so there is nothing to allow.', 'riskAllowed');
    let contact: typeof contacts.$inferSelect | undefined;
    try {
      // The allowance is for the risk the caller saw: one the hourly pass changed meanwhile stays skipped.
      [contact] = await c.env.db.update(contacts).set({ ...input, updatedAt: new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt), input.riskAllowed !== undefined ? eq(contacts.risk, found.risk!) : undefined)).returning();
    } catch (err) {
      if (isContactSizeCheckViolation(err)) throw new ApiError(422, 'VALIDATION_FAILED', 'Contact properties must total at most 16 KiB of JSON.', 'properties');
      throw err;
    }
    return c.json(contactBody(contact ?? notFound('Contact')), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/contacts/{id}', operationId: 'deleteContact', tags: ['Audience'], security, description: 'Remove contact profile and memberships, retaining minimal consent/suppression to prevent accidental re-enrollment.', request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => {
      await findContact(tx, identity, contactId);
      await tx.update(contacts).set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: null, properties: {} }).where(and(scope(contacts, identity), eq(contacts.id, contactId)));
      await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.contactId, contactId)));
    });
    return c.json({ id: contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts/{id}/consent', operationId: 'updateContactConsent', tags: ['Consent'], security, description: `Set marketing subscription status. Source, policy version, evidence and occurrence time are optional audit context; ${productName} records the actor and current time when omitted. Does not lift delivery suppression. Profile edits cannot establish consent; an import can only when its commit attests consent.`, request: { params: IdParams, body: json(ConsentInput) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id, input = c.req.valid('json');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const source = input.source ?? (identity.credential === 'dashboard' ? 'dashboard' : identity.credential === 'mcp' ? 'mcp' : identity.credential === 'agentToken' ? 'agent-token' : 'api');
    const contact = await c.env.db.transaction(async tx => {
      const [existing] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1).for('update');
      if (!existing) return notFound('Contact');
      if (existing.marketingConsent === 'unsubscribed' && input.status === 'subscribed' && !input.confirmResubscribe) throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'Explicitly confirm renewed verifiable consent to replace a prior opt-out.', 'confirmResubscribe');
      if (input.status === 'subscribed') {
        const [latest] = await tx.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId))).orderBy(sql`${consentAudit.occurredAt} DESC`).limit(1);
        if (latest && Date.parse(occurredAt) <= Date.parse(latest.occurredAt)) throw new ApiError(409, 'STALE_CONSENT', 'Renewed consent must be newer than the prior consent decision.');
      }
      return recordConsent(tx, identity, existing, { status: input.status, source, policyVersion: input.policyVersion, evidence: input.evidence, occurredAt, actorKeyId: identity.keyId });
    }); return c.json(contactBody(contact), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}/consent', operationId: 'listContactConsentEvents', tags: ['Consent'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Audit)), ...errors } }), async c => {
    const identity = actor(c), contactId = c.req.valid('param').id, query = c.req.valid('query'); await findContact(c.env.db, identity, contactId);
    const rows = await c.env.db.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId), query.cursor ? gt(consentAudit.id, query.cursor) : undefined)).orderBy(asc(consentAudit.id)).limit(query.limit + 1);
    return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists', operationId: 'listContactLists', tags: ['Audience'], security, request: { query: ListQuery }, responses: { 200: response(page(ListRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select(listColumns).from(lists).where(and(scope(lists, identity), query.search ? searchText(lists.name, query.search) : undefined, query.cursor ? gt(lists.id, query.cursor) : undefined)).orderBy(asc(lists.id)).limit(query.limit + 1);
    const result = paginate(rows, query.limit); return c.json({ ...result, data: query.counts === 'false' ? result.data.map(row => ({ ...row, counts: null })) : await readLists(c.env.db, identity, result.data) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists', operationId: 'createContactList', tags: ['Audience'], security, request: { body: json(ListInput) }, responses: { 201: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(lists).values({ id: id('lst'), ...scopeValues(identity), ...c.req.valid('json') }).returning(listColumns); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}', operationId: 'getContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ListRead), ...errors } }), async c => {
    const identity = actor(c), row = await findList(c.env.db, identity, c.req.valid('param').id);
    return c.json((await readLists(c.env.db, identity, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/lists/{id}', operationId: 'updateContactList', tags: ['Audience'], security, request: { params: IdParams, body: json(ListInput.partial()) }, responses: { 200: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(lists).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(lists, identity), eq(lists.id, c.req.valid('param').id))).returning(listColumns); return c.json(row ?? notFound('List'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}', operationId: 'deleteContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => { const [row] = await tx.delete(lists).where(and(scope(lists, identity), eq(lists.id, listId))).returning(); if (!row) notFound('List'); await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, listId))); }); return c.json({ id: listId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}/members', operationId: 'listListMembers', tags: ['Audience'], security, description: `Active list members with current list IDs. Pages are also bounded by response size and may return fewer than limit contacts; follow nextCursor while non-null. ${readLimitNote(AUDIENCE_READ_SECONDS)}`, request: { params: IdParams, query: ContactQuery.omit({ listId: true }) }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), listId = c.req.valid('param').id, query = c.req.valid('query');
    return await withAudienceReadMemory(c, async () => {
      const { items, hasMore } = await budgetedRead(c.env.db, async tx => {
        await findList(tx, identity, listId);
        const { rows, hasMore: more } = await boundedContactPage(tx, identity, { ...query, listId });
        return { items: await readContacts(tx, identity, rows, CONTACT_LIST_IDS_PAGE_MAX), hasMore: more };
      }, readLimit(AUDIENCE_READ_SECONDS));
      const { json: body } = buildBoundedPageJson(items, hasMore, AUDIENCE_READ_MAX_BYTES);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists/{id}/members', operationId: 'addListMembers', tags: ['Audience'], security, request: { params: IdParams, body: json(z.object({ contactIds: z.array(z.string().min(1).max(120)).min(1).max(100) }).strict()) }, responses: { 200: response(z.object({ added: z.number().int() })), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id, contactIds = [...new Set(c.req.valid('json').contactIds)];
    const added = await c.env.db.transaction(async tx => { const [list] = await tx.select().from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1).for('update'); if (!list) notFound('List'); if ((await lockContacts(tx, identity, contactIds)).length !== contactIds.length) notFound('Contact'); const result = await tx.insert(listMembers).values(contactIds.map(contactId => ({ ...scopeValues(identity), listId, contactId }))).onConflictDoNothing().returning(); return result.length; }); return c.json({ added }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}/members/{contactId}', operationId: 'removeListMember', tags: ['Audience'], security, request: { params: IdParams.extend({ contactId: z.string().min(1).max(120) }) }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), params = c.req.valid('param'); await findList(c.env.db, identity, params.id);
    await c.env.db.transaction(async tx => { await lockContacts(tx, identity, [params.contactId]); await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, params.id), eq(listMembers.contactId, params.contactId))); }); return c.json({ id: params.contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments', operationId: 'listSegments', tags: ['Audience'], security, request: { query: SearchQuery }, responses: { 200: response(page(Segment)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select().from(segments).where(and(scope(segments, identity), query.search ? searchText(segments.name, query.search) : undefined, query.cursor ? gt(segments.id, query.cursor) : undefined)).orderBy(asc(segments.id)).limit(query.limit + 1); return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments', operationId: 'createSegment', tags: ['Audience'], security, request: { body: json(SegmentInput) }, responses: { 201: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(segments).values({ id: id('seg'), ...scopeValues(identity), ...c.req.valid('json') }).returning(); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments/{id}', operationId: 'getSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Segment), ...errors } }), async c => c.json(await findSegment(c.env.db, actor(c), c.req.valid('param').id), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/segments/{id}', operationId: 'updateSegment', tags: ['Audience'], security, request: { params: IdParams, body: json(SegmentInput.partial()) }, responses: { 200: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(segments).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(segments, identity), eq(segments.id, c.req.valid('param').id))).returning(); return c.json(row ?? notFound('Segment'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/segments/{id}', operationId: 'deleteSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), segmentId = c.req.valid('param').id; const [row] = await c.env.db.delete(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).returning(); if (!row) notFound('Segment'); return c.json({ id: segmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments/{id}/preview', operationId: 'previewSegment', tags: ['Audience'], security, description: `Bounded to 1000 matches. Unknown observation history is never classified as inactive. Counts separate suppressed and other non-consenting contacts. ${readLimitNote(PREVIEW_READ_SECONDS)}`, request: { params: IdParams, body: json(z.object({ listId: z.string().min(1).max(120).optional() }).strict()) }, responses: { 200: response(Counts), ...errors } }), async c => {
    const identity = actor(c), segmentId = c.req.valid('param').id, listId = c.req.valid('json').listId;
    return await withAudienceReadMemory(c, async () => {
      const result = await budgetedRead(c.env.db, async tx => {
        const segment = await findSegment(tx, identity, segmentId);
        if (listId) await findList(tx, identity, listId);
        return previewSegmentCounts(tx, identity, segment.rule, listId);
      }, readLimit(PREVIEW_READ_SECONDS));
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports', operationId: 'previewContactImport', tags: ['Audience'], security, description: `Persist a preview before commit. Feature limit: 5 MiB UTF-8 CSV, 50,000 rows, 100 columns per import; preview and commit a larger file in parts of that size (the dashboard does this for files up to 1,000,000 rows and 100 MiB). Map headers explicitly. Valid rows can commit alongside a retained row-error report. Imports never lift suppression; consent changes only when the commit attests it. Each workspace keeps at most ${IMPORT_OPEN_PREVIEW_CAP} uncommitted previews (oldest evicted) and allows ${IMPORT_PREVIEW_RATE_PER_MINUTE} previews per minute.`, request: { body: json(ImportInput) }, responses: { 201: response(Import), ...errors } }), async c => {
    const input = c.req.valid('json'), identity = actor(c, input.listId ? 'manage' : 'editContent');
    if (input.listId) await findList(c.env.db, identity, input.listId);
    if (!await chargeBudget(c.env, identity.workspaceId, 'imports:preview', IMPORT_PREVIEW_RATE_PER_MINUTE)) {
      c.header('Retry-After', '60');
      throw new ApiError(429, 'IMPORT_PREVIEW_RATE_LIMITED', `This workspace allows ${IMPORT_PREVIEW_RATE_PER_MINUTE} contact import previews per minute. Retry after the window resets.`, undefined, true);
    }
    // Reuse the outer self-reclaiming pre-parse lease from app.ts (or acquire one if invoked directly) and shrink it
    // when handing off to streamImportResponse.
    const reserveBytes = importPreviewReservationBytes(input.csv.length);
    const outerLease = c.get('importLease');
    let ownLease: MemoryLease | undefined;
    if (!outerLease) {
      try {
        ownLease = await reserveMemory(reserveBytes, { route: 'import.preview', workspaceId: identity.workspaceId, signal: c.req.raw.signal, idleMs: 15_000, maxMs: 45_000, wsBusyCode: 'IMPORT_CONCURRENCY_LIMIT', busyCode: 'IMPORT_CONCURRENCY_LIMIT' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
        if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
        throw error;
      }
    }
    const lease = outerLease ?? ownLease!;
    let transferred = false;
    try {
      const built = await runInMemoryScope(reserveBytes, async () => {
        if (c.req.raw.signal?.aborted) return null;
        const hygiene = await hygieneLists(c.env.db), { rowsJson, errorsJson, risky, domains } = previewImport(input, hygiene);
        // The domains' DNS verdicts (cached, else looked up for a few seconds; the rest are queued and the resolver flags
        // their contacts once imported). The summary counts them; the commit stores what is known by then.
        for (const [domain, risk] of await domainRisks(c.env, hygiene, domains.keys(), Date.now() + IMPORT_DNS_MS)) {
          const n = domains.get(domain)!;
          risky.byReason[risk] += n.plain + n.role; risky.byReason.role -= n.role; risky.total += n.plain;
        }
        const newId = id('imp');
        const meta = await c.env.db.transaction(async tx => {
          // Transaction-scoped advisory lock (supported by Hyperdrive and PgBouncer transaction pooling) keeps the
          // newest IMPORT_OPEN_PREVIEW_CAP uncommitted previews per workspace even under concurrent previews.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(275818, hashtext(${identity.workspaceId}))`);
          const [row] = await tx.insert(imports).values({ id: newId, ...scopeValues(identity), listId: input.listId, riskSummary: risky, rows: sql`${rowsJson}::jsonb` as unknown as never, errors: sql`${errorsJson}::jsonb` as unknown as never, createdAt: sql`clock_timestamp()` as unknown as string, updatedAt: sql`clock_timestamp()` as unknown as string }).returning(importMetaColumns);
          await tx.execute(sql`DELETE FROM audience_imports WHERE workspace_id = ${identity.workspaceId} AND status = 'preview' AND id <> ${newId}
            AND id IN (SELECT id FROM audience_imports WHERE workspace_id = ${identity.workspaceId} AND status = 'preview' AND id <> ${newId} ORDER BY created_at DESC, id DESC OFFSET ${IMPORT_OPEN_PREVIEW_CAP - 1})`);
          return row!;
        });
        return { meta, rowsJson, errorsJson };
      }, () => lease.touch());
      if (!built) return new Response(null, { status: 499 }) as never;
      transferred = true;
      if (outerLease) c.set('importLeaseTransferred', true);
      return streamImportResponse(c, built.meta, built.rowsJson, built.errorsJson, 201, undefined, lease) as never;
    } finally {
      if (!transferred && ownLease) ownLease.release();
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports', operationId: 'listContactImports', tags: ['Audience'], security, request: { query: PageQuery }, responses: { 200: response(page(Import.omit({ rows: true, errors: true }))), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select(importMetaColumns).from(imports).where(and(scope(imports, identity), query.cursor ? gt(imports.id, query.cursor) : undefined)).orderBy(asc(imports.id)).limit(query.limit + 1); const result = paginate(rows, query.limit); return c.json({ ...result, data: result.data.map(importSummary) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports/{id}', operationId: 'getContactImport', tags: ['Audience'], security, description: 'Read one import preview or committed import report. Committed row payloads are retained briefly after commit (rowsRetained is false and rows is [] once scrubbed; imported keeps the count); per-row errors are retained longer (errorsRetained is false once scrubbed).', request: { params: IdParams }, responses: { 200: response(Import), ...errors } }), async c => {
    const identity = actor(c);
    const reserveBytes = IMPORT_GET_RESERVATION_BYTES;
    let lease: MemoryLease;
    try {
      lease = await reserveMemory(reserveBytes, { route: 'import.read', workspaceId: identity.workspaceId, signal: c.req.raw.signal, maxWorkspaceBytes: 32 * 1024 * 1024, wsBusyCode: 'IMPORT_CONCURRENCY_LIMIT', busyCode: 'IMPORT_CONCURRENCY_LIMIT' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let transferred = false;
    try {
      const [row] = await runInMemoryScope(reserveBytes, () => c.env.db.select({ ...importMetaColumns, rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` }).from(imports).where(and(scope(imports, identity), eq(imports.id, c.req.valid('param').id))).limit(1), () => lease.touch());
      if (!row) importNotFound();
      transferred = true;
      return streamImportResponse(c, row, row.rowsText, row.errorsText, 200, undefined, lease) as never;
    } finally {
      if (!transferred) lease.release();
    }
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports/{id}/commit', operationId: 'commitContactImport', tags: ['Audience'], security, description: 'Imports every valid row of a previewed import. Without consent, imported contacts keep their consent decision (new contacts have none, so campaigns skip them). With consent, everyone imported who had no decision is marked subscribed with your evidence. A repeated commit changes nothing. One import commits at a time per workspace (503 IMPORT_COMMIT_BUSY if another is running; retryable).', request: { params: IdParams, body: { ...json(ImportCommit), required: false } }, responses: { 200: response(CommittedImport), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), importId = c.req.valid('param').id, consent = c.req.valid('json').consent;
    const reserveBytes = IMPORT_COMMIT_RESERVATION_BYTES;
    let lease: MemoryLease;
    try {
      lease = await reserveMemory(reserveBytes, { route: 'import.commit', workspaceId: identity.workspaceId, signal: c.req.raw.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let transferred = false;
    try {
      const result = await runInMemoryScope(reserveBytes, async () => {
        if (c.req.raw.signal?.aborted) return null;
        return c.env.db.transaction(async tx => {
          // One commit at a time per workspace (transaction-scoped try-lock: supported by Hyperdrive and PgBouncer
          // transaction mode, released automatically at COMMIT/ROLLBACK), matching AUDIENCE_CAPTURE_BUSY.
          if (!(await tx.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275817, hashtext(${identity.workspaceId}))`)).rowCount)
            throw new ApiError(503, 'IMPORT_COMMIT_BUSY', 'Another contact import is committing in this workspace; retry when it finishes.', undefined, true);
          const [job] = await tx.select({ ...importMetaColumns, rowCount: sql<number>`jsonb_array_length(${imports.rows})::int` }).from(imports).where(and(scope(imports, identity), eq(imports.id, importId))).limit(1).for('update');
          if (!job) importNotFound();
          if (job.listId) actor(c, 'manage');
          if (job.status === 'committed') {
            const [full] = await tx.select({ rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` }).from(imports).where(and(scope(imports, identity), eq(imports.id, importId))).limit(1);
            return { meta: job, rowsText: full!.rowsText, errorsText: full!.errorsText, subscribed: 0 };
          }
          // A share lock keeps the list from being changed or deleted mid-commit.
          if (job.listId) { const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), eq(lists.id, job.listId))).limit(1).for('share'); if (!list) notFound('List'); }
          // Domain verdicts count only while the checks are on (NIGHTMAIL_HYGIENE_DNS), as everywhere else.
          const now = new Date().toISOString(), dnsOn = !!c.env.config.hygieneDnsUrl;
          let subscribed = 0;
          let sampleContactIds: string[] = [];
          let riskSummary = riskyFrom(null);
          if (job.rowCount > 0) {
            // Statement 1: upsert contacts with time-ordered UUIDv7 IDs (row_id('con') format), check merged property
            // limits (<= 50) in SQL, and — when consent is attested — insert brand-new contacts directly as 'subscribed'
            // (xmax = 0) with their consent audit and folded operation.publishBatch jobs. Kept separate from
            // audience_list_members inserts (Statement 3) so statement triggers on audience_contacts (e.g. restoring a
            // deleted contact) and audience_list_members never fire in the same statement and double-count.
            const initialConsent = consent ? 'subscribed' : 'unknown';
            const tsHex = Date.now().toString(16).padStart(12, '0');
            const { rows: [step1] } = await tx.execute<{ bad_row: number | null; inserted_subscribed: number; jobs_enqueued: number; existing_unknown_ids: string[] | null; contact_ids: string[] | null; sample_ids: string[] | null; risky: Record<string, number> | null }>(sql`
              WITH incoming AS (
                SELECT (r->>'row')::int AS row_num, r->>'email' AS email, r->>'name' AS name, coalesce(r->'properties', '{}'::jsonb) AS properties, r->>'risk' AS risk,
                  m.verdict AS domain_verdict
                FROM audience_imports i CROSS JOIN LATERAL jsonb_array_elements(i.rows) r
                  LEFT JOIN hygiene_mail_domains m ON m.domain = split_part(r->>'email', '@', 2)
                WHERE i.workspace_id = ${identity.workspaceId} AND i.id = ${importId}
              ), upserted AS (
                -- A new contact gets the risk its preview found, its domain's verdict as checked by now (a domain that can't
                -- receive mail outranks a role name), else dead when the address bounced elsewhere; an existing contact keeps
                -- its own (and its owner's allowance), unless it was deleted and comes back new.
                INSERT INTO audience_contacts AS c (id, workspace_id, email, name, properties, marketing_consent, risk)
                SELECT 'con_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, email, name, properties, ${initialConsent},
                  CASE WHEN risk IS NOT NULL AND risk <> 'role' THEN risk WHEN ${dnsOn} AND domain_verdict = 'no_mail' THEN 'no_mail_domain'
                    WHEN risk = 'role' THEN risk
                    WHEN ${bouncedElsewhere(sql`incoming.email`, sql`${identity.workspaceId}::text`)} THEN 'dead' END
                FROM incoming ORDER BY email
                ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE SET name = coalesce(excluded.name, c.name), properties = c.properties || excluded.properties, deleted_at = NULL, updated_at = ${now},
                  risk = CASE WHEN c.deleted_at IS NULL THEN c.risk ELSE excluded.risk END, risk_allowed = c.risk_allowed AND c.deleted_at IS NULL
                RETURNING c.id, c.email, c.properties, (xmax = 0) AS inserted, c.marketing_consent, c.risk, c.risk_allowed
              ), bad AS (
                SELECT inc.row_num FROM upserted u JOIN incoming inc ON inc.email = u.email
                WHERE (NOT u.inserted AND (SELECT count(*) FROM jsonb_object_keys(u.properties)) > ${CONTACT_PROPERTIES_MAX_KEYS})
                  OR octet_length(u.properties::text) > ${CONTACT_PROPERTIES_DB_MAX_BYTES}
                ORDER BY inc.row_num LIMIT 1
              )${consent ? sql`, audited AS (
                INSERT INTO audience_consent_audit (id, workspace_id, contact_id, email, status, source, policy_version, evidence, actor_key_id, import_id, occurred_at)
                SELECT 'cns_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, id, email, 'subscribed', 'import', ${consent.policyVersion ?? null}, ${consent.evidence}, ${identity.keyId}, ${job.id}, ${now}
                FROM upserted WHERE inserted
                RETURNING id, contact_id
              ), numbered AS (
                SELECT id, contact_id, ((row_number() OVER () - 1) / 100) AS grp FROM audited
              ), batched AS (
                SELECT grp,
                  jsonb_build_object('events', jsonb_agg(jsonb_build_object(
                    'id', id, 'type', 'contact.subscription_changed', 'createdAt', ${now}::text, 'workspaceId', ${identity.workspaceId}::text, 'region', NULL,
                    'data', jsonb_build_object('contactId', contact_id, 'status', 'subscribed', 'source', 'import')
                  ))) AS payload
                FROM (SELECT grp, id, contact_id FROM numbered ORDER BY grp) s GROUP BY grp
              ), enqueued AS (
                INSERT INTO jobs (id, workspace_id, type, payload)
                SELECT 'job_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, 'operation.publishBatch', payload FROM batched
                RETURNING 1
              )` : sql``}
              SELECT (SELECT row_num FROM bad) AS bad_row,
                ${consent ? sql`(SELECT count(*)::int FROM audited)` : sql`0`} AS inserted_subscribed,
                ${consent ? sql`(SELECT count(*)::int FROM enqueued)` : sql`0`} AS jobs_enqueued,
                ${consent ? sql`ARRAY(SELECT id FROM upserted WHERE NOT inserted AND marketing_consent = 'unknown' ORDER BY id)` : sql`NULL::text[]`} AS existing_unknown_ids,
                ${job.listId ? sql`ARRAY(SELECT id FROM upserted)` : sql`NULL::text[]`} AS contact_ids,
                ARRAY(SELECT id FROM upserted ORDER BY hashtextextended(id, 0) LIMIT ${IMPORT_SAMPLE_CONTACT_IDS}) AS sample_ids,
                (SELECT jsonb_object_agg(risk, n) FROM (SELECT risk, count(*)::int AS n FROM upserted WHERE risk IS NOT NULL AND NOT risk_allowed GROUP BY risk) r) AS risky`);
            if (step1?.bad_row != null) throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', `Row ${step1.bad_row}: merged contact properties exceed the supported limits. No rows were imported.`, `rows.${step1.bad_row}.properties`);
            sampleContactIds = step1?.sample_ids ?? [];
            riskSummary = riskyFrom(step1?.risky ?? null);
            subscribed += step1?.inserted_subscribed ?? 0;
            noteEnqueued(step1?.jobs_enqueued ?? 0);
            // Statement 2 (only when re-imported existing contacts had marketing_consent = 'unknown'): upgrade them
            // by primary key, write consent audit, and fold publishBatch jobs into one insert.
            if (consent && step1?.existing_unknown_ids?.length) {
              const { rows: [step2] } = await tx.execute<{ subscribed: number; jobs_enqueued: number }>(sql`
                WITH changed AS (
                  UPDATE audience_contacts c SET marketing_consent = 'subscribed', updated_at = ${now}
                  WHERE c.workspace_id = ${identity.workspaceId} AND c.id = ANY(${sql.param(step1.existing_unknown_ids)}::text[]) AND c.marketing_consent = 'unknown'
                  RETURNING c.id, c.email
                ), audited AS (
                  INSERT INTO audience_consent_audit (id, workspace_id, contact_id, email, status, source, policy_version, evidence, actor_key_id, import_id, occurred_at)
                  SELECT 'cns_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, id, email, 'subscribed', 'import', ${consent.policyVersion ?? null}, ${consent.evidence}, ${identity.keyId}, ${job.id}, ${now} FROM changed
                  RETURNING id, contact_id
                ), numbered AS (
                  SELECT id, contact_id, ((row_number() OVER () - 1) / 100) AS grp FROM audited
                ), batched AS (
                  SELECT grp,
                    jsonb_build_object('events', jsonb_agg(jsonb_build_object(
                      'id', id, 'type', 'contact.subscription_changed', 'createdAt', ${now}::text, 'workspaceId', ${identity.workspaceId}::text, 'region', NULL,
                      'data', jsonb_build_object('contactId', contact_id, 'status', 'subscribed', 'source', 'import')
                    ))) AS payload
                  FROM (SELECT grp, id, contact_id FROM numbered ORDER BY grp) s GROUP BY grp
                ), enqueued AS (
                  INSERT INTO jobs (id, workspace_id, type, payload)
                  SELECT 'job_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, 'operation.publishBatch', payload FROM batched
                  RETURNING 1
                )
                SELECT (SELECT count(*)::int FROM audited) AS subscribed, (SELECT count(*)::int FROM enqueued) AS jobs_enqueued`);
              subscribed += step2?.subscribed ?? 0;
              noteEnqueued(step2?.jobs_enqueued ?? 0);
            }
            // Statement 3: add list memberships from Statement 1's sorted contact IDs once every contact is in its
            // final state (avoids re-scanning audience_contacts and keeps audience_members_added in its own statement
            // so statement triggers on audience_contacts and audience_list_members compose without double-counting).
            if (job.listId && step1?.contact_ids?.length) {
              await tx.execute(sql`
                INSERT INTO audience_list_members (workspace_id, list_id, contact_id)
                SELECT ${identity.workspaceId}, ${job.listId}::text, cid
                FROM unnest(${sql.param(step1.contact_ids)}::text[]) AS cid
                ON CONFLICT DO NOTHING`);
            }
          }
          const [updated] = await tx.update(imports).set({ status: 'committed', imported: job.rowCount, sampleContactIds, riskSummary, consentLinkedAt: now, updatedAt: now }).where(and(scope(imports, identity), eq(imports.id, job.id))).returning({ ...importMetaColumns, rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` });
          return { meta: updated!, rowsText: updated!.rowsText, errorsText: updated!.errorsText, subscribed };
        });
      });
      if (!result) return new Response(null, { status: 499 }) as never;
      transferred = true;
      return streamImportResponse(c, result.meta, result.rowsText, result.errorsText, 200, result.subscribed, lease) as never;
    } catch (error) {
      if (isContactSizeCheckViolation(error)) throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', 'Merged contact properties exceed the 50-property or 16 KiB JSON limit. No rows were imported.', 'rows');
      if (statementTimedOut(error)) throw new ApiError(503, 'IMPORT_COMMIT_TIMEOUT', 'The contact import commit ran out of time and nothing was imported. Retry the commit.', undefined, true);
      throw error;
    } finally {
      if (!transferred) lease.release();
    }
  });
}
