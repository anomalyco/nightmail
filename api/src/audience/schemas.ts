import { z } from '@hono/zod-openapi';
import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Ctx, Actor, DbExecutor } from '../core/types.js';
import { databaseCodeOf, ApiError, notFound } from '../core/errors.js';
import { PageQuery } from '../core/http.js';
import { PropertyRule, type SegmentRule, imports, contacts, lists, segments } from '../db/audience.js';
import { ContactTopic } from '../topics.js';
import { PAGE_MAX_BYTES, utf8Bytes, withBoundedRead } from '../read-bounds.js';
import { mailAddress } from '../outbound-content.js';
import { SEND_LIMITS } from '../send-limits.js';
import { RiskReason, contactRisk, RiskBreakdown, noRisks } from '../list-hygiene.js';

export const CONTACT_PROPERTIES_MAX_KEYS = 50;
export const CONTACT_PROPERTIES_MAX_BYTES = 16 * 1024;
/** Matches migration 453's CHECK constraint (16 KiB compact JSON + 256 B Postgres jsonb::text formatting slack). */
export const CONTACT_PROPERTIES_DB_MAX_BYTES = 16_640;
export const CONTACT_LIST_IDS_PAGE_MAX = 50;
export const CONTACT_LIST_IDS_SINGLE_MAX = 200;
export const AUDIENCE_READ_MAX_BYTES = PAGE_MAX_BYTES;
export const AUDIENCE_READ_SECONDS = 5;
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

export const Email = mailAddress(z.string().trim()).transform(v => v.toLowerCase()).openapi({format:'email'});
const Properties = z.record(z.string().min(1).max(80), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= CONTACT_PROPERTIES_MAX_KEYS, 'At most 50 properties are supported.');
export const PropertiesInput = Properties.refine(v => propertiesByteLength(v) <= CONTACT_PROPERTIES_MAX_BYTES, 'Contact properties must total at most 16 KiB of JSON.').describe('Up to 50 key/value pairs, at most 16 KiB of JSON total.');
const ContactListIds = z.array(z.string().min(1).max(120)).max(CONTACT_LIST_IDS_SINGLE_MAX).optional().describe('Optional list IDs for this contact (atomically replaces memberships on update). Non-empty on create or changing memberships on update requires manage permission.');
export const ContactInput = z.object({ email: Email, name: z.string().trim().max(200).optional(), properties: PropertiesInput.default({}), listIds: ContactListIds }).strict();
export const ContactPatch = z.object({ name: z.string().trim().max(200).nullable().optional(), properties: PropertiesInput.optional(), riskAllowed: z.boolean().optional().describe('true sends campaigns and marketing to a contact flagged as risky anyway; false skips it again. Owners and admins only (manage permission). Only for a contact with a risk (409 CONTACT_NOT_RISKY otherwise).'), listIds: ContactListIds }).strict();
export function withAudienceReadMemory(c: Ctx, work: () => Promise<Response>): Promise<Response> {
  return withBoundedRead(c, () => work(), { route: 'audience.read' });
}
const Scope = { workspaceId: z.string() };
const Dates = { createdAt: z.string(), updatedAt: z.string() };
const ContactRisk = z.object({ reason: RiskReason, suggestion: z.string().nullable().describe('For typo_domain, the address with the provider it most likely meant.'), allowed: z.boolean().describe('Its owner allowed it: campaigns and marketing sends reach it anyway.') }).nullable()
  .describe('Why campaigns and marketing sends skip this contact, or null when nothing is wrong with the address. Flagged when the contact is created or imported, and again hourly for every contact. Transactional mail is never refused.').openapi('ContactRisk');
export const Contact = z.object({ id: z.string(), ...Scope, email: z.string(), name: z.string().nullable(), properties: Properties, marketingConsent: z.enum(['unknown', 'subscribed', 'unsubscribed']), suppressed: z.boolean(), suppressionReason: z.string().nullable(), risk: ContactRisk, lastOpenAt: z.string().nullable(), lastClickAt: z.string().nullable(), observedSince: z.string().nullable(), openObservedSince: z.string().nullable(), clickObservedSince: z.string().nullable(), deletedAt: z.string().nullable(), ...Dates }).openapi('Contact');
/** A contact row as the API shows it: its risk as reason, suggestion and allowance. */
export function contactBody<T extends { email: string; risk: string | null; riskAllowed: boolean }>({ riskAllowed, ...row }: T) { return { ...row, risk: contactRisk({ email: row.email, risk: row.risk, riskAllowed }) }; }
export const ListInput = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).default('') }).strict();
export const List = ListInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('ContactList');
export const ContactRead = Contact.extend({ listIds: z.array(z.string()).describe('Up to 50 list IDs on paginated contact reads (200 on getContact), sorted by ID.') }).openapi('ContactRead');
// Spread, not extend: an extension of a named schema is published as allOf, which reads as a different response to clients.
export const ContactDetail = z.object({ ...ContactRead.shape, topics: z.array(ContactTopic).describe('Every topic of the workspace that isn\u2019t archived, oldest first, with whether its sends reach this contact. Set one with updateContactConsent and topicId.') }).openapi('ContactDetail');
const ListCounts = z.object({ total: z.number().int(), subscribed: z.number().int(), unsubscribed: z.number().int(), unknown: z.number().int(), suppressed: z.number().int() }).describe('Active members only. Suppressed takes precedence over consent; subscribed, unsubscribed, unknown and suppressed are mutually exclusive and sum to total.');
export const ListRead = z.object({ ...List.shape, counts: ListCounts.nullable() }).strict().openapi('ContactListRead');
export const SearchQuery = PageQuery.extend({ search: z.string().trim().min(1).max(200).optional() });
export const ListQuery = SearchQuery.extend({ counts: z.enum(['true', 'false']).default('true').describe('false leaves member counts out (counts is null). Counts are kept as memberships, consent and suppression change, so reading them does not count members.') }).openapi('ListContactListsQuery');
export const ContactQuery = SearchQuery.extend({ email: Email.optional().describe('Exact, case-insensitive email match. Uses the unique email index; prefer it over search for one address.'), consent: z.enum(['unknown', 'subscribed', 'unsubscribed']).optional(), suppressed: z.enum(['true', 'false']).optional(), risky: z.enum(['true']).optional().describe('true: only contacts campaigns skip as risky (risk set and not allowed).'), listId: z.string().min(1).max(120).optional() }).openapi('ListContactsQuery');
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
export const SegmentInput = z.object({ name: z.string().trim().min(1).max(200), rule: Rule }).strict();
export const Segment = SegmentInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('Segment');
export const Counts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int(), risky: z.number().int().describe('Subscribed, not suppressed and flagged as risky: campaigns skip them. Not in eligible.') });
export const Deleted = z.object({ id: z.string(), deleted: z.literal(true) });
export const Audit = z.object({ id: z.string(), ...Scope, contactId: z.string(), email: z.string(), status: z.enum(['subscribed', 'unsubscribed']), source: z.string(), policyVersion: z.string().nullable(), evidence: z.string().nullable(), actorKeyId: z.string().nullable(), importId: z.string().nullable().describe('Committed import ID when source is import; null otherwise.'), topicId: z.string().nullable().describe('The topic this decision is about (updateContactConsent with topicId, or an unsubscribe from mail with a topic); null for marketing as a whole.'), occurredAt: z.string(), createdAt: z.string() });
export const ConsentInput = z.object({ status: z.enum(['subscribed', 'unsubscribed']), topicId: z.string().min(1).max(120).optional().describe('A topic (listTopics): the decision is about that kind of mail only, and marketing consent stays as it is. Without it, the decision is about all marketing.'), source: z.string().trim().min(1).max(200).optional(), policyVersion: z.string().trim().min(1).max(120).optional(), evidence: z.string().trim().min(1).max(2000).optional(), occurredAt: z.string().datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 60000, 'Consent cannot occur in the future.').optional(), confirmResubscribe: z.boolean().default(false) }).strict();
const ImportRowSchema = z.object({ row: z.number().int(), email: z.string(), name: z.string().optional(), properties: Properties, risk: RiskReason.optional().describe('What the address says about it, if anything: the contact is imported and flagged, and campaigns skip it.') });
const ImportErrorSchema = z.object({ row: z.number().int(), field: z.string(), message: z.string() });
export const Import = z.object({ id: z.string(), ...Scope, listId: z.string().nullable(), status: z.enum(['preview', 'committed']), rows: z.array(ImportRowSchema), errors: z.array(ImportErrorSchema), imported: z.number().int(), rowsRetained: z.boolean().describe('false once committed row payloads are no longer kept after the retention window (rows is then [] while imported keeps the count).'), risky: RiskBreakdown.nullable().describe('Rows flagged as risky. At preview, what the addresses say; once committed, the imported contacts campaigns skip, addresses that bounced elsewhere included. null for imports from before list hygiene.'), errorsRetained: z.boolean().describe('false once per-row error details are no longer kept after the retention window (errors is then []).'), ...Dates }).openapi('AudienceImport');
// How long a preview looks up domains it hasn't checked before (src/list-hygiene.ts domainRisks).
export const IMPORT_DNS_MS = 3_000;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024, IMPORT_MAX_ROWS = 50_000, IMPORT_OPEN_PREVIEW_CAP = 50, IMPORT_SAMPLE_CONTACT_IDS = 2000;
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
export function importNotFound(): never { throw new ApiError(404, 'NOT_FOUND', `Import was not found. A preview that was never committed is removed once the workspace has ${IMPORT_OPEN_PREVIEW_CAP} newer ones (or after 7 days). Preview the file again.`); }
export const importMetaColumns = { id: imports.id, workspaceId: imports.workspaceId, listId: imports.listId, status: imports.status, imported: imports.imported, rowsScrubbedAt: imports.rowsScrubbedAt, errorsScrubbedAt: imports.errorsScrubbedAt, riskSummary: imports.riskSummary, createdAt: imports.createdAt, updatedAt: imports.updatedAt };
export type ImportMeta = { [K in keyof typeof importMetaColumns]: (typeof imports.$inferSelect)[K] };
// Retained receipts only counted the reasons known when they were written. A receipt from before hygiene still has no summary.
export const receiptRisk = (stored: ImportMeta['riskSummary']) => stored ? { total: stored.total, byReason: { ...noRisks(), ...stored.byReason } } : null;
export const importSummary = ({ rowsScrubbedAt, errorsScrubbedAt, riskSummary, ...meta }: ImportMeta) => ({ ...meta, rowsRetained: rowsScrubbedAt === null, errorsRetained: errorsScrubbedAt === null, risky: receiptRisk(riskSummary) });
export const ImportCommit = z.object({ consent: z.object({ status: z.literal('subscribed'), evidence: z.string().trim().min(1).max(2000).describe('How these people agreed to marketing email, for example "Opted in at checkout". Stored with each consent record.'), policyVersion: z.string().trim().min(1).max(120).optional() }).strict().optional().describe('Records that everyone in this import agreed to receive marketing email. It changes only contacts with no consent decision yet: prior opt-outs stay unsubscribed and suppressed addresses stay suppressed. Omit it to import without consent.') }).strict().openapi('CommitContactImportInput');
export const CommittedImport = Import.extend({ subscribed: z.number().int().describe('Contacts this commit marked subscribed; 0 without consent or when the import was already committed.') }).openapi('CommittedContactImport');
export const ImportInput = z.object({ csv: z.string().min(1).max(IMPORT_MAX_BYTES), listId: z.string().min(1).max(120).optional(), mapping: z.object({ email: z.string().min(1).max(200), name: z.string().min(1).max(200).optional(), firstName: z.string().min(1).max(200).optional(), plan: z.string().min(1).max(200).optional(), country: z.string().min(1).max(200).optional() }).strict() }).strict();

export function scope(table: { workspaceId: AnyPgColumn }, identity: Pick<Actor, 'workspaceId'>) { return eq(table.workspaceId, identity.workspaceId); }
export function scopeValues(identity: Pick<Actor, 'workspaceId'>) { return { workspaceId: identity.workspaceId }; }
export function paginate<T extends { id: string }>(rows: T[], limit: number) { return { data: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }; }
export async function findContact(db: DbExecutor, identity: Actor, contactId: string) { const [row] = await db.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1); return row ?? notFound('Contact'); }
// A list's own fields, as list routes return them: a newsletter's sender and reader count (src/newsletters.ts) are not.
export const listColumns = { id: lists.id, workspaceId: lists.workspaceId, name: lists.name, description: lists.description, createdAt: lists.createdAt, updatedAt: lists.updatedAt };
export async function findList(db: DbExecutor, identity: Actor, listId: string) { const [row] = await db.select(listColumns).from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1); return row ?? notFound('List'); }
export async function lockLists(tx: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listIds: string[]) {
  if (!listIds.length) return;
  const existing = await tx.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), inArray(lists.id, listIds))).orderBy(asc(lists.id)).for('share');
  if (existing.length !== listIds.length) notFound('List');
}
export async function findSegment(db: DbExecutor, identity: Actor, segmentId: string) { const [row] = await db.select().from(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).limit(1); return row ?? notFound('Segment'); }
