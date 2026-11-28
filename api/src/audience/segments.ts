import type { z } from '@hono/zod-openapi';
import { type SQL, sql, isNull, and, inArray, asc } from 'drizzle-orm';
import type { Actor, DbExecutor } from '../core/types.js';
import { ApiError, unrestrictedRequired, notFound } from '../core/errors.js';
import type { AudienceSpec } from '../core/http.js';
import { type SegmentRule, contacts, type PropertyRule, listMembers, lists, segments } from '../db/audience.js';
import { skippedRisk } from '../list-hygiene.js';
import { scope } from './schemas.js';

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
export function inList(identity: Actor, listId: string): SQL { return sql`EXISTS (SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${listMembers.contactId} = ${contacts.id} OFFSET 0)`; }
export const PREVIEW_SMALL_LIST = 5000, PREVIEW_VERY_LARGE_LIST = 100_000, PREVIEW_READ_SECONDS = 15;
export async function previewSegmentCounts(db: DbExecutor, identity: Actor, rule: SegmentRule, listId?: string) {
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
export async function audienceConditions(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, lock: boolean, joined = false) {
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
