import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actor } from './core/access.js';
import { ApiError, errors } from './core/errors.js';
import { budgetedRead, id, json, readLimit, readLimitNote, response, rowId, security } from './core/http.js';
import type { Actor, App, Database, DbExecutor } from './core/types.js';
import { AUDIENCE_READ_MAX_BYTES, CONTACT_PROPERTIES_DB_MAX_BYTES, CONTACT_PROPERTIES_MAX_BYTES, CONTACT_PROPERTIES_MAX_KEYS, isContactSizeCheckViolation, PropertiesInput, propertiesByteLength, withAudienceReadMemory } from './audience/schemas.js';
import { compileRule } from './audience/segments.js';
import { lockContacts } from './audience/consent.js';
import { utf8Bytes } from './read-bounds.js';
import { auditContext, auditInsert, type AuditContext } from './audit.js';
import { audiencePlans, consentAudit, contacts, listMembers, lists, segments, type AudienceOperation } from './db/audience.js';
import { jobs } from './db/core.js';
import { noteEnqueued } from './jobs.js';

const AUDIENCEQL_OPEN_PLAN_CAP = 25, AUDIENCEQL_MAX_TARGETS = 10_000;
const Statement = z.string().trim().min(1).max(4000).describe("AudienceQL statement. Supported: SELECT fields|count(*) FROM contacts [WHERE ...] [LIMIT n]; UPDATE contacts SET name|consent|properties.key = value WHERE ... [LIMIT n]; ADD contacts TO LIST 'name-or-id' WHERE ...; REMOVE contacts FROM LIST 'name-or-id' WHERE .... WHERE supports AND with =, !=, CONTAINS, IS NULL, IS NOT NULL and timestamp comparisons over id, email, name, consent, suppressed, list, segment, lastOpenAt, lastClickAt and properties.key. No raw tables, joins, comments or semicolons.");
const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Sample = z.object({ id: z.string(), email: z.string(), name: z.string().nullable(), consent: z.enum(['unknown', 'subscribed', 'unsubscribed']), suppressed: z.boolean() });
const QueryResult = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), Value.or(z.record(z.string(), Value)))), matched: z.number().int().describe('Exact count for SELECT count(*) or when truncated is false; otherwise the returned page size.'), truncated: z.boolean() }).openapi('AudienceQueryResult');
const PlanResult = z.object({ id: z.string(), operation: z.enum(['update_contacts', 'add_to_list', 'remove_from_list']), matched: z.number().int(), sample: z.array(Sample), warnings: z.array(z.string()), requiresResubscribeConfirmation: z.boolean(), expiresAt: z.string() }).openapi('AudienceOperationPlan');
const ApplyResult = z.object({ id: z.string(), operation: z.enum(['update_contacts', 'add_to_list', 'remove_from_list']), affected: z.number().int(), appliedAt: z.string() }).openapi('AudienceOperationResult');
type Literal = string | number | boolean | null;
type UpdateSet = { name?: string | null; consent?: 'subscribed' | 'unsubscribed'; properties?: Record<string, Literal> };

function scoped(column: { workspaceId: AnyPgColumn }, identity: Actor) { return eq(column.workspaceId, identity.workspaceId); }
function clean(statement: string) {
  const value = statement.trim();
  if (/[;\0]|--|\/\*/.test(value)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL does not allow semicolons, comments, or multiple statements.', 'statement');
  if (value.length > 4000) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL statements may contain at most 4000 characters.', 'statement');
  if (/\s{32}/.test(value)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL does not allow long runs of whitespace.', 'statement');
  return value;
}
function splitOutside(value: string, separator: ',' | 'AND'): string[] {
  const result: string[] = []; let start = 0; let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "'") { if (quoted && value[index + 1] === "'") index++; else quoted = !quoted; continue; }
    if (quoted) continue;
    if (separator === ',' && value[index] === ',') { result.push(value.slice(start, index).trim()); start = index + 1; }
    if (separator === 'AND' && /^\s+AND\s+/i.test(value.slice(index))) { const match = /^\s+AND\s+/i.exec(value.slice(index))!; result.push(value.slice(start, index).trim()); start = index + match[0].length; index = start - 1; }
  }
  if (quoted) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL contains an unterminated string.', 'statement');
  result.push(value.slice(start).trim()); return result.filter(Boolean);
}
function literal(raw: string): Literal {
  const value = raw.trim();
  if (/^NULL$/i.test(value)) return null;
  if (/^TRUE$/i.test(value)) return true;
  if (/^FALSE$/i.test(value)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  throw new ApiError(422, 'AUDIENCEQL_INVALID', `Use a quoted string, finite number, boolean, or NULL instead of ${value.slice(0, 40)}.`, 'statement');
}
async function reference(db: DbExecutor, identity: Actor, kind: 'list' | 'segment', value: string) {
  const table = kind === 'list' ? lists : segments;
  const rows = await db.select({ id: table.id, name: table.name, ...(kind === 'segment' ? { rule: segments.rule } : {}) }).from(table as typeof lists).where(and(scoped(table, identity), or(eq(table.id, value), eq(table.name, value)))).limit(2);
  if (!rows.length) throw new ApiError(422, 'AUDIENCEQL_REFERENCE_NOT_FOUND', `${kind === 'list' ? 'List' : 'Segment'} ${value} was not found.`, 'statement');
  if (rows.length > 1) throw new ApiError(422, 'AUDIENCEQL_REFERENCE_AMBIGUOUS', `Use the ${kind} ID because its name is not unique.`, 'statement');
  return rows[0]! as { id: string; rule?: typeof segments.$inferSelect.rule };
}
function compare(field: SQL | AnyPgColumn, operator: string, value: Literal): SQL {
  if (operator === 'IS NULL') return isNull(field as AnyPgColumn);
  if (operator === 'IS NOT NULL') return isNotNull(field as AnyPgColumn);
  if (value === null) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Use IS NULL or IS NOT NULL for NULL.', 'statement');
  if (operator === '=') return eq(field as AnyPgColumn, value);
  if (operator === '!=') return ne(field as AnyPgColumn, value);
  if (operator === 'CONTAINS' && typeof value === 'string') return sql`strpos(lower(${field}), lower(${value})) > 0`;
  if (operator === '>') return gt(field as AnyPgColumn, value);
  if (operator === '>=') return gte(field as AnyPgColumn, value);
  if (operator === '<') return lt(field as AnyPgColumn, value);
  if (operator === '<=') return lte(field as AnyPgColumn, value);
  throw new ApiError(422, 'AUDIENCEQL_INVALID', `Operator ${operator} is not valid for this field.`, 'statement');
}
async function whereSql(db: DbExecutor, identity: Actor, source: string | undefined): Promise<SQL[]> {
  if (!source) return [];
  if (/\s+OR\s+/i.test(source) || /[()]/.test(source)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL v1 supports AND conditions without parentheses.', 'statement');
  const result: SQL[] = [];
  for (const clause of splitOutside(source, 'AND')) {
    const match = /^([A-Za-z][A-Za-z0-9_.]*)\s+(IS NOT NULL|IS NULL|CONTAINS|!=|>=|<=|=|>|<)(?:\s+(.+))?$/i.exec(clause);
    if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Invalid WHERE condition: ${clause.slice(0, 80)}.`, 'statement');
    const name = match[1]!, operator = match[2]!.toUpperCase(), value = operator.startsWith('IS ') ? null : literal(match[3] ?? '');
    if (/^properties\.[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) { if (!['=', '!=', 'CONTAINS', 'IS NULL', 'IS NOT NULL'].includes(operator)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Property filters support =, !=, CONTAINS and NULL checks.', 'statement'); result.push(compare(sql`${contacts.properties} ->> ${name.slice(11)}`, operator, value === null ? null : String(value))); continue; }
    if (name === 'list' || name === 'segment') {
      if (!['=', '!='].includes(operator) || typeof value !== 'string') throw new ApiError(422, 'AUDIENCEQL_INVALID', `${name} supports = or != with a quoted name or ID.`, 'statement');
      const found = await reference(db, identity, name, value);
      const condition = name === 'list' ? sql`EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${found.id} AND m.contact_id = ${contacts.id})` : compileRule(found.rule!);
      result.push(operator === '=' ? condition : sql`NOT (${condition})`); continue;
    }
    const fields: Record<string, AnyPgColumn> = { id: contacts.id, email: contacts.email, name: contacts.name, consent: contacts.marketingConsent, suppressed: contacts.suppressed, lastOpenAt: contacts.lastOpenAt, lastClickAt: contacts.lastClickAt };
    const field = fields[name]; if (!field) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Unknown AudienceQL field ${name}.`, 'statement');
    if (name === 'suppressed' && typeof value !== 'boolean' && !operator.startsWith('IS ')) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'suppressed requires TRUE or FALSE.', 'statement');
    if ((name === 'lastOpenAt' || name === 'lastClickAt') && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new ApiError(422, 'AUDIENCEQL_INVALID', `${name} requires an ISO date string.`, 'statement');
    result.push(compare(field, operator, value));
  }
  return result;
}
function mScope(identity: Actor) { return sql`m.workspace_id = ${identity.workspaceId}`; }
const targetColumns = { id: contacts.id, email: contacts.email, name: contacts.name, updatedAt: contacts.updatedAt, marketingConsent: contacts.marketingConsent, suppressed: contacts.suppressed };
type TargetRow = { [K in keyof typeof targetColumns]: (typeof contacts.$inferSelect)[K] };
async function targetRows(db: DbExecutor, identity: Actor, where: string, extra?: SQL, explicitLimit?: number): Promise<TargetRow[]> {
  const conditions = await whereSql(db, identity, where);
  const cap = explicitLimit ?? AUDIENCEQL_MAX_TARGETS;
  const rows = await db.select(targetColumns).from(contacts).where(and(scoped(contacts, identity), isNull(contacts.deletedAt), ...conditions, extra)).orderBy(asc(contacts.id)).limit(explicitLimit ? cap : cap + 1);
  if (!explicitLimit && rows.length > AUDIENCEQL_MAX_TARGETS) throw new ApiError(422, 'AUDIENCEQL_LIMIT_EXCEEDED', 'A mutation plan may target at most 10,000 contacts. Narrow the WHERE clause or add LIMIT 10000 to update in batches.', 'statement');
  return rows;
}
function sample(rows: TargetRow[]) { return rows.slice(0, 10).map(row => ({ id: row.id, email: row.email, name: row.name, consent: row.marketingConsent, suppressed: row.suppressed })); }
/** Checks whether merging patchProps into any of targetIds would exceed the 50-key or 16 KiB contact property limits without loading passing rows' properties. */
async function assertMergedPropertiesWithinLimit(db: DbExecutor, identity: Actor, targetIds: string[], patchProps: Record<string, Literal>) {
  if (!targetIds.length) return;
  const patchJson = JSON.stringify(patchProps);
  for (const batch of chunks(targetIds, 2500)) {
    const { rows } = await db.execute<{ merged: Record<string, Literal>; key_count: number }>(sql`
      SELECT (${contacts.properties} || ${patchJson}::jsonb) AS merged,
        (SELECT count(*)::int FROM jsonb_object_keys(${contacts.properties} || ${patchJson}::jsonb)) AS key_count
      FROM ${contacts}
      WHERE ${and(scoped(contacts, identity), inArray(contacts.id, batch), isNull(contacts.deletedAt))}
        AND (
          octet_length((${contacts.properties} || ${patchJson}::jsonb)::text) > ${CONTACT_PROPERTIES_DB_MAX_BYTES}
          OR (SELECT count(*) FROM jsonb_object_keys(${contacts.properties} || ${patchJson}::jsonb)) > ${CONTACT_PROPERTIES_MAX_KEYS}
        )
      LIMIT 50`);
    for (const row of rows) {
      if (row.key_count > CONTACT_PROPERTIES_MAX_KEYS || !PropertiesInput.safeParse(row.merged).success) {
        throw new ApiError(422, 'AUDIENCEQL_PROPERTIES_INVALID', 'Merged contact properties exceed the 50-property or 16 KiB JSON limit.', 'statement');
      }
    }
  }
}
function parseMutation(statement: string): { kind: 'update'; set: UpdateSet; where: string; limit?: number } | { kind: 'add' | 'remove'; list: string; where: string } {
  const update = /^UPDATE\s+contacts\s+SET\s+(.+?)\s+WHERE\s+(.+?)(?:\s+LIMIT\s+(\d+))?$/is.exec(statement);
  if (update) {
    const set: UpdateSet = {};
    for (const assignment of splitOutside(update[1]!, ',')) {
      const match = /^([A-Za-z][A-Za-z0-9_.]*)\s*=\s*(.+)$/s.exec(assignment); if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Invalid SET assignment: ${assignment}.`, 'statement');
      const name = match[1]!, value = literal(match[2]!);
      if (name === 'name' && (typeof value === 'string' || value === null)) {
        if (typeof value === 'string' && value.length > 200) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Contact name may contain at most 200 characters.', 'statement');
        set.name = value;
      }
      else if (name === 'consent' && (value === 'subscribed' || value === 'unsubscribed')) set.consent = value;
      else if (/^properties\.[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) {
        if (typeof value === 'string' && value.length > 2000) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Property string values may contain at most 2000 characters.', 'statement');
        (set.properties ??= {})[name.slice(11)] = value;
      }
      else throw new ApiError(422, 'AUDIENCEQL_INVALID', `Cannot update AudienceQL field ${name}.`, 'statement');
    }
    if (!Object.keys(set).length) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'UPDATE requires at least one supported assignment.', 'statement');
    if (set.properties && (Object.keys(set.properties).length > CONTACT_PROPERTIES_MAX_KEYS || propertiesByteLength(set.properties) > CONTACT_PROPERTIES_MAX_BYTES)) {
      throw new ApiError(422, 'AUDIENCEQL_PROPERTIES_INVALID', 'Contact properties must total at most 50 keys and 16 KiB of JSON.', 'statement');
    }
    const limit = update[3] ? Number(update[3]) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > AUDIENCEQL_MAX_TARGETS)) throw new ApiError(422, 'AUDIENCEQL_INVALID', `UPDATE LIMIT must be between 1 and ${AUDIENCEQL_MAX_TARGETS}.`, 'statement');
    return { kind: 'update', set, where: update[2]!.trim(), limit };
  }
  const membership = /^(ADD\s+contacts\s+TO|REMOVE\s+contacts\s+FROM)\s+LIST\s+(.+?)\s+WHERE\s+(.+)$/is.exec(statement);
  if (membership) { const list = literal(membership[2]!); if (typeof list !== 'string') throw new ApiError(422, 'AUDIENCEQL_INVALID', 'LIST requires a quoted name or ID.', 'statement'); return { kind: membership[1]!.toUpperCase().startsWith('ADD') ? 'add' : 'remove', list, where: membership[3]!.trim() }; }
  throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Expected UPDATE contacts, ADD contacts TO LIST, or REMOVE contacts FROM LIST.', 'statement');
}

function fieldSqlExpr(field: string): { expr: SQL; bytesExpr: SQL } {
  if (field === 'id') return { expr: sql`${contacts.id}`, bytesExpr: sql`octet_length(${contacts.id}) + 12` };
  if (field === 'email') return { expr: sql`${contacts.email}`, bytesExpr: sql`octet_length(${contacts.email}) + 16` };
  if (field === 'name') return { expr: sql`${contacts.name}`, bytesExpr: sql`coalesce(octet_length(${contacts.name}), 4) + 14` };
  if (field === 'consent') return { expr: sql`${contacts.marketingConsent}`, bytesExpr: sql`28` };
  if (field === 'suppressed') return { expr: sql`${contacts.suppressed}`, bytesExpr: sql`24` };
  if (field === 'lastOpenAt') return { expr: sql`${contacts.lastOpenAt}::text`, bytesExpr: sql`48` };
  if (field === 'lastClickAt') return { expr: sql`${contacts.lastClickAt}::text`, bytesExpr: sql`48` };
  if (field === 'properties') return { expr: sql`${contacts.properties}`, bytesExpr: sql`octet_length(${contacts.properties}::text) + 18` };
  const key = field.slice(11);
  return { expr: sql`${contacts.properties} -> ${key}`, bytesExpr: sql`coalesce(octet_length((${contacts.properties} -> ${key})::text), 4) + ${field.length + 8}` };
}

async function queryAudienceJson(db: Database, identity: Actor, statement: string): Promise<string> {
  const match = /^SELECT\s+(.+?)\s+FROM\s+contacts(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is.exec(clean(statement));
  if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Expected SELECT fields FROM contacts [WHERE ...] [LIMIT n].', 'statement');
  const rawFields = match[1]!.trim();
  const isCount = /^count\(\*\)$/i.test(rawFields);
  const fields = isCount ? ['count'] : splitOutside(rawFields, ',');
  if (!isCount) {
    if (!fields.length || fields.length > 10) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Select between one and ten fields.', 'statement');
    const allowed = /^(?:id|email|name|consent|suppressed|lastOpenAt|lastClickAt|properties|properties\.[A-Za-z][A-Za-z0-9_]{0,79})$/;
    if (fields.some(field => !allowed.test(field))) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'SELECT contains an unsupported field.', 'statement');
  }
  const limit = match[3] ? Number(match[3]) : 100;
  if (!isCount && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'SELECT LIMIT must be between 1 and 1000.', 'statement');
  return budgetedRead(db, async tx => {
    const conditions = await whereSql(tx, identity, match[2]?.trim());
    const where = and(scoped(contacts, identity), isNull(contacts.deletedAt), ...conditions);
    if (isCount) {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(contacts).where(where);
      return JSON.stringify({ columns: ['count'], rows: [{ count }], matched: count, truncated: false });
    }
    // Fetch limit + 1 in one pass (no full-table count(*)) while capping cumulative response bytes in SQL.
    const uniqueFields = [...new Set(fields)];
    const selectEntries = uniqueFields.map((f, i) => {
      const { expr } = fieldSqlExpr(f);
      return sql`${expr} AS ${sql.raw(`f_${i}`)}`;
    });
    const bytesSum = sql.join(uniqueFields.map(f => fieldSqlExpr(f).bytesExpr), sql` + `);
    const outerCols = sql.join(uniqueFields.map((_, i) => sql.raw(`f_${i}`)), sql`, `);
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      WITH candidate AS (
        SELECT ${contacts.id} AS _sort_id, ${sql.join(selectEntries, sql`, `)}, (${bytesSum} + 16) AS row_bytes
        FROM ${contacts} WHERE ${where}
        ORDER BY ${contacts.id} ASC LIMIT ${limit + 1}
      ), sized AS (
        SELECT *, row_number() OVER (ORDER BY _sort_id) AS rn, sum(row_bytes) OVER (ORDER BY _sort_id ROWS UNBOUNDED PRECEDING) AS cum_bytes
        FROM candidate
      )
      SELECT ${outerCols}, (SELECT count(*)::int FROM candidate) AS _cand_count FROM sized
      WHERE rn <= ${limit} AND (rn = 1 OR cum_bytes <= ${AUDIENCE_READ_MAX_BYTES})
      ORDER BY rn`);
    const candidateCount = Number(rows[0]?._cand_count ?? 0);
    const fieldIndex = new Map(uniqueFields.map((f, i) => [f, `f_${i}`]));
    const colsJson = JSON.stringify(fields);
    const overhead = utf8Bytes(colsJson) + 64;
    const serializedRows: string[] = [];
    let bytes = overhead;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const obj: Record<string, unknown> = {};
      for (const field of fields) {
        const val = row[fieldIndex.get(field)!];
        obj[field] = val === undefined ? null : val;
      }
      const line = JSON.stringify(obj);
      const size = utf8Bytes(line) + (i > 0 ? 1 : 0);
      if (i > 0 && bytes + size > AUDIENCE_READ_MAX_BYTES) break;
      serializedRows.push(line);
      bytes += size;
    }
    const truncated = candidateCount > serializedRows.length;
    return `{"columns":${colsJson},"rows":[${serializedRows.join(',')}],"matched":${serializedRows.length},"truncated":${truncated}}`;
  }, readLimit(5));
}

async function planAudience(db: Database, identity: Actor, statement: string) {
  statement = clean(statement); const parsed = parseMutation(statement);
  const { rows, operation } = await budgetedRead(db, async tx => {
    if (parsed.kind === 'update') {
      const matchedRows = await targetRows(tx, identity, parsed.where, undefined, parsed.limit);
      if (parsed.set.properties) await assertMergedPropertiesWithinLimit(tx, identity, matchedRows.map(r => r.id), parsed.set.properties);
      return { rows: matchedRows, operation: { kind: 'update_contacts', targets: matchedRows.map(row => ({ id: row.id, email: row.email, updatedAt: row.updatedAt, consent: row.marketingConsent })), set: parsed.set } as AudienceOperation };
    }
    const list = await reference(tx, identity, 'list', parsed.list);
    const matchedRows = await targetRows(tx, identity, parsed.where, parsed.kind === 'add' ? sql`NOT EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${list.id} AND m.contact_id = ${contacts.id})` : sql`EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${list.id} AND m.contact_id = ${contacts.id})`);
    return { rows: matchedRows, operation: { kind: parsed.kind === 'add' ? 'add_to_list' : 'remove_from_list', targetIds: matchedRows.map(row => row.id), listId: list.id } as AudienceOperation };
  }, readLimit(5));
  const requiresResubscribeConfirmation = operation.kind === 'update_contacts' && operation.set.consent === 'subscribed' && operation.targets.some(target => target.consent === 'unsubscribed');
  const warnings = [...(rows.some(row => row.suppressed) ? [`${rows.filter(row => row.suppressed).length} suppressed contact(s) remain suppressed.`] : []), ...(requiresResubscribeConfirmation ? ['The plan includes prior opt-outs and requires explicit resubscribe confirmation.'] : [])];
  const planId = id('aqp'), expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(275819, hashtext(${identity.workspaceId}))`);
    await tx.insert(audiencePlans).values({ id: planId, workspaceId: identity.workspaceId, actorKeyId: identity.keyId, statement, operation, matched: rows.length, expiresAt, createdAt: sql`clock_timestamp()` as unknown as string });
    // Keep at most AUDIENCEQL_OPEN_PLAN_CAP unapplied plans per workspace (oldest evicted).
    await tx.execute(sql`DELETE FROM audience_operation_plans WHERE workspace_id = ${identity.workspaceId} AND applied_at IS NULL AND id <> ${planId}
      AND id IN (SELECT id FROM audience_operation_plans WHERE workspace_id = ${identity.workspaceId} AND applied_at IS NULL AND id <> ${planId} ORDER BY created_at DESC, id DESC OFFSET ${AUDIENCEQL_OPEN_PLAN_CAP - 1})`);
  });
  return { id: planId, operation: operation.kind, matched: rows.length, sample: sample(rows), warnings, requiresResubscribeConfirmation, expiresAt };
}
const chunks = <T,>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
async function applyPlan(db: Database, identity: Actor, planId: string, confirmResubscribe: boolean, audit: AuditContext, evidence?: string) {
  return db.transaction(async tx => {
    const [plan] = await tx.select().from(audiencePlans).where(and(scoped(audiencePlans, identity), eq(audiencePlans.id, planId), eq(audiencePlans.actorKeyId, identity.keyId))).limit(1).for('update');
    if (!plan) throw new ApiError(404, 'NOT_FOUND', `Audience operation plan was not found. Unapplied plans are removed once the workspace has ${AUDIENCEQL_OPEN_PLAN_CAP} newer ones (or after expiry). Create a new plan.`);
    if (plan.appliedAt) throw new ApiError(409, 'AUDIENCE_PLAN_APPLIED', 'This audience operation plan was already applied.');
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new ApiError(409, 'AUDIENCE_PLAN_EXPIRED', 'This audience operation plan expired. Create a new plan.');
    const operation = plan.operation; const appliedAt = new Date().toISOString();
    if (operation.kind === 'update_contacts') {
      // Several contacts are locked in email order everywhere (imports, SES feedback, lockContacts), so none of them deadlock.
      const ids = operation.targets.map(target => target.id);
      const current = ids.length ? await tx.select({ id: contacts.id, email: contacts.email, updatedAt: contacts.updatedAt, marketingConsent: contacts.marketingConsent }).from(contacts).where(and(scoped(contacts, identity), inArray(contacts.id, ids), isNull(contacts.deletedAt))).orderBy(asc(contacts.email)).for('update') : [];
      const expected = new Map(operation.targets.map(target => [target.id, target]));
      if (current.length !== ids.length || current.some(row => row.updatedAt !== expected.get(row.id)?.updatedAt)) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'A planned contact changed or was deleted. Review a new plan.');
      if (operation.set.consent === 'subscribed' && current.some(row => row.marketingConsent === 'unsubscribed') && !confirmResubscribe) throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'This plan includes prior opt-outs. Explicitly confirm renewed consent before applying it.');
      if (operation.set.properties) await assertMergedPropertiesWithinLimit(tx, identity, ids, operation.set.properties);
      try {
        for (const batch of chunks(ids, 5000)) await tx.update(contacts).set({ ...(Object.hasOwn(operation.set, 'name') ? { name: operation.set.name } : {}), ...(operation.set.consent ? { marketingConsent: operation.set.consent } : {}), ...(operation.set.properties ? { properties: sql`${contacts.properties} || ${JSON.stringify(operation.set.properties)}::jsonb` } : {}), updatedAt: appliedAt }).where(and(scoped(contacts, identity), inArray(contacts.id, batch)));
      } catch (err) {
        if (isContactSizeCheckViolation(err)) throw new ApiError(422, 'AUDIENCEQL_PROPERTIES_INVALID', 'Merged contact properties exceed the 50-property or 16 KiB JSON limit.', 'statement');
        throw err;
      }
      if (operation.set.consent) {
        const changed = current.filter(row => row.marketingConsent !== operation.set.consent).map(row => ({ row, eventId: rowId('cns') }));
        for (const batch of chunks(changed, 2500)) await tx.insert(consentAudit).values(batch.map(({ row, eventId }) => ({ id: eventId, workspaceId: identity.workspaceId, contactId: row.id, email: row.email, status: operation.set.consent!, source: 'audienceql', evidence: evidence ?? null, actorKeyId: identity.keyId, occurredAt: appliedAt })));
        const jobRows = chunks(changed, 100).map(batch => ({ id: rowId('job'), workspaceId: identity.workspaceId, type: 'operation.publishBatch', payload: { events: batch.map(({ row, eventId }) => ({ id: eventId, workspaceId: identity.workspaceId, type: 'contact.subscription_changed', region: null, createdAt: appliedAt, data: { contactId: row.id, status: operation.set.consent, source: 'audienceql' } })) } }));
        if (jobRows.length) { await tx.insert(jobs).values(jobRows); noteEnqueued(jobRows.length); }
      }
    } else {
      const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scoped(lists, identity), eq(lists.id, operation.listId))).limit(1).for('share');
      if (!list) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'The planned list was deleted. Review a new plan.');
      const currentMemberships = operation.targetIds.length ? await tx.select({ contactId: listMembers.contactId }).from(listMembers).where(and(scoped(listMembers, identity), eq(listMembers.listId, operation.listId), inArray(listMembers.contactId, operation.targetIds))) : [];
      if (operation.kind === 'add_to_list' && currentMemberships.length || operation.kind === 'remove_from_list' && currentMemberships.length !== operation.targetIds.length) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'List memberships changed after review. Review a new plan.');
      const active = operation.targetIds.length ? await lockContacts(tx, identity, operation.targetIds) : [];
      if (operation.kind === 'add_to_list' && active.length !== operation.targetIds.length) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'A planned contact changed or was deleted. Review a new plan.');
      if (operation.kind === 'add_to_list') {
        for (const batch of chunks(operation.targetIds, 1000)) if (batch.length) await tx.insert(listMembers).values(batch.map(contactId => ({ workspaceId: identity.workspaceId, listId: operation.listId, contactId }))).onConflictDoNothing();
      } else {
        for (const batch of chunks(operation.targetIds, 5000)) if (batch.length) await tx.delete(listMembers).where(and(scoped(listMembers, identity), eq(listMembers.listId, operation.listId), inArray(listMembers.contactId, batch)));
      }
    }
    // The plan's own write carries its audit row: counts and field names, never a contact's address.
    const after = operation.kind === 'update_contacts' ? { fields: Object.keys(operation.set), properties: Object.keys(operation.set.properties ?? {}), consent: operation.set.consent ?? null } : { listId: operation.listId };
    await tx.execute(sql`WITH applied AS (UPDATE audience_operation_plans SET applied_at=${appliedAt}::timestamptz WHERE workspace_id=${identity.workspaceId} AND id=${plan.id} RETURNING id),
      audit AS (${auditInsert(audit, { action: 'audience.bulk_apply', workspaceId: identity.workspaceId, target: { type: 'audience_plan', id: plan.id }, after: { operation: operation.kind, matched: plan.matched, ...after }, details: { resubscribeConfirmed: confirmResubscribe || undefined } }, { from: sql`applied` })}) SELECT 1`);
    return { id: plan.id, operation: operation.kind, affected: plan.matched, appliedAt };
  });
}

export function registerAudienceQuery(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/query', operationId: 'queryAudience', tags: ['Audience'], security, description: `Execute a bounded read-only AudienceQL SELECT against the virtual contacts schema. Results are bounded by response size as well as LIMIT (truncated is true when capped). ${readLimitNote(5)}`, request: { body: json(z.object({ statement: Statement }).strict()) }, responses: { 200: response(QueryResult), ...errors } }), async c => {
    const identity = actor(c), statement = c.req.valid('json').statement;
    return await withAudienceReadMemory(c, async () => {
      const body = await queryAudienceJson(c.env.db, identity, statement);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/plan', operationId: 'planAudienceMutation', tags: ['Audience'], security, description: `Create a 15-minute immutable plan for a bounded AudienceQL bulk mutation. Does not modify contacts or memberships. ${readLimitNote(5)} At most 10,000 contacts per plan; newest ${AUDIENCEQL_OPEN_PLAN_CAP} unapplied plans kept per workspace.`, request: { body: json(z.object({ statement: Statement }).strict()) }, responses: { 201: response(PlanResult), ...errors } }), async c => {
    const identity = actor(c, 'manage'), statement = c.req.valid('json').statement;
    return await withAudienceReadMemory(c, async () => {
      const plan = PlanResult.parse(await planAudience(c.env.db, identity, statement));
      return new Response(JSON.stringify(plan), { status: 201, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/apply', operationId: 'applyAudiencePlan', tags: ['Audience'], security, description: 'Apply an immutable AudienceQL plan once. Prior opt-outs require confirmResubscribe.', request: { body: json(z.object({ planId: z.string().regex(/^aqp_[0-9a-f]{32}$/), confirmResubscribe: z.boolean().default(false), evidence: z.string().trim().min(1).max(2000).optional().describe('For a consent change: how these people agreed, for example "Opted in at checkout". Stored with each consent record.') }).strict()) }, responses: { 200: response(ApplyResult), ...errors } }), async c => {
    const identity = actor(c, 'manage'), input = c.req.valid('json');
    return await withAudienceReadMemory(c, async () => {
      const applied = ApplyResult.parse(await applyPlan(c.env.db, identity, input.planId, input.confirmResubscribe, auditContext(c), input.evidence));
      return new Response(JSON.stringify(applied), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
}
