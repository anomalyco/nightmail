import type { z } from '@hono/zod-openapi';
import { sql, and, isNull, type SQL } from 'drizzle-orm';
import type { Actor, DbExecutor, Database } from '../core/types.js';
import { notFound, ApiError } from '../core/errors.js';
import { type AudienceSpec, statementTimedOut } from '../core/http.js';
import { contacts } from '../db/audience.js';
import { type TopicRule, topicChoiceReaches, topicChoiceJoin } from '../topics.js';
import { validMailAddressSql } from '../outbound-content.js';
import { RAMP } from '../standing-model.js';
import { skippedRisk, RISKS, type Risk, riskCounts, type RiskCounts } from '../list-hygiene.js';
import { scope } from './schemas.js';
import { audienceConditions } from './segments.js';

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
export async function countNeverMailed(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice: boolean, lastSent: string | null, topic?: TopicRule | null): Promise<number | null> {
  const conditions = await audienceConditions(db, identity, spec, false, true);
  return (db as Database).transaction(async tx => {
    await tx.execute(sql`SAVEPOINT never_mailed`);
    try {
      await tx.execute(sql`SET LOCAL statement_timeout = '1s'`);
      await tx.execute(sql`SET LOCAL enable_nestloop = off`);
      const [row] = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${contacts} ${memberJoin(identity, spec.listId)} ${topicJoin(topic)}
        WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} AND ${reachable(requiredNotice, topic)} AND ${neverMailed(lastSent)}`)).rows;
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
// people who unsubscribed from marketing or never subscribed included. A campaign with a topic (src/topics.ts) reaches the
// subscribers who didn't opt out of it (or, for a topic nobody gets by default, opted in), read from its choices joined
// beside each contact (topicJoin, in the statement's FROM); a required notice has none.
// Contacts flagged as risky are skipped unless their owner allowed them (src/list-hygiene.ts), whatever the campaign.
const consented = (requiredNotice: boolean, topic?: TopicRule | null) => requiredNotice ? sql`true`
  : topic ? sql`(${contacts.marketingConsent} = 'subscribed' AND ${topicChoiceReaches(topic)})` : sql`${contacts.marketingConsent} = 'subscribed'`;
const topicJoin = (topic?: TopicRule | null) => topicChoiceJoin(topic, sql`${contacts.workspaceId}`, sql`${contacts.id}`);
const skipped = skippedRisk(sql`${contacts.risk}`, sql`${contacts.riskAllowed}`);
const reachable = (requiredNotice: boolean, topic?: TopicRule | null) => sql`NOT ${contacts.suppressed} AND ${consented(requiredNotice, topic)} AND (${contacts.risk} IS NULL OR ${contacts.riskAllowed})`;
/** Who campaigns skip as risky out of the reachable, by reason: counted aggregates named risky_<reason>. */
const riskyColumns = (risk: SQL, risky: SQL = sql`true`) => sql.join(RISKS.map(r => sql`count(*) FILTER (WHERE ${risky} AND ${risk} = ${r})::int AS ${sql.identifier(`risky_${r}`)}`), sql`, `);
type RiskyRow = { [K in `risky_${Risk}`]: number };
const riskyOf = (row: RiskyRow) => riskCounts(RISKS.map(r => ({ risk: r, count: row[`risky_${r}`] })));
export type AudienceCountsResult = { matched: number; eligible: number; suppressed: number; unsubscribed: number; risky: number; riskyByReason: RiskCounts; topicExcluded?: number; approximate?: true };
/** Read-only counts of the live audience (the dashboard's pre-send check); nothing is frozen or locked. */
export async function countCampaignAudience(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice = false, topic?: TopicRule | null): Promise<AudienceCountsResult> {
  const conditions = await audienceConditions(db, identity, spec, false);
  if (requiredNotice) topic = null;
  const [row] = (await db.execute<{ matched: number; eligible: number; suppressed: number; unsubscribed: number; excluded: number } & RiskyRow>(sql`SELECT count(*)::int AS matched,
      count(*) FILTER (WHERE ${reachable(requiredNotice, topic)})::int AS eligible,
      ${topic ? sql`count(*) FILTER (WHERE NOT ${contacts.suppressed} AND ${contacts.marketingConsent} = 'subscribed' AND NOT ${topicChoiceReaches(topic)})::int` : sql`0`} AS excluded,
      count(*) FILTER (WHERE ${contacts.suppressed})::int AS suppressed,
      count(*) FILTER (WHERE NOT ${contacts.suppressed} AND NOT (${consented(requiredNotice, topic)}))::int AS unsubscribed,
      ${riskyColumns(sql`${contacts.risk}`, sql`NOT ${contacts.suppressed} AND ${consented(requiredNotice, topic)} AND ${skipped}`)}
    FROM ${contacts} ${topicJoin(topic)} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)}`)).rows;
  const risky = riskyOf(row!);
  return { matched: row!.matched, eligible: row!.eligible, suppressed: row!.suppressed, unsubscribed: row!.unsubscribed, risky: risky.total, riskyByReason: risky.byReason, ...topic ? { topicExcluded: row!.excluded } : {} };
}
/** The list's members campaigns skip as risky, by reason: the workspace's flagged contacts (migration 498's partial index)
 *  joined to the list's memberships by hash. Run it with nested loops off (riskyByHash): on statistics from before the
 *  flags (an hourly pass changes a few percent of a table, too few for autovacuum to analyze it) the planner expects one
 *  flagged contact and probes the memberships once per flagged contact, 12 s cold for 75,000 of a 2,000,000-member list on
 *  the lab, against 0.26 s warm by hash (and a sequential read of the memberships cold). */
const listRisky = (identity: Pick<Actor, 'workspaceId'>, listId: string, requiredNotice: boolean, topic?: TopicRule | null) => sql`(SELECT coalesce(jsonb_object_agg(risk, n), '{}'::jsonb) FROM (
    SELECT c.risk, count(*)::int AS n FROM audience_contacts c ${topicChoiceJoin(topic, sql`c.workspace_id`, sql`c.id`)}
    WHERE c.workspace_id = ${identity.workspaceId} AND c.risk IS NOT NULL AND NOT c.risk_allowed AND c.deleted_at IS NULL AND NOT c.suppressed
      ${requiredNotice ? sql`` : sql`AND c.marketing_consent = 'subscribed'`} ${topic ? sql`AND ${topicChoiceReaches(topic)}` : sql``}
      AND EXISTS (SELECT 1 FROM audience_list_members m WHERE m.workspace_id = c.workspace_id AND m.list_id = ${listId} AND m.contact_id = c.id)
    GROUP BY c.risk) r)`;
/**
 * listTopicOut under a time budget, in a savepoint whose settings end with it. The read probes a large list's memberships
 * and contacts for each of the topic's choices: about 1 s warm for 100,000 opt-outs of a 2,000,000-member list, and up to
 * 10 s the first time those tables are read (a freshly written lab copy). Past the budget it falls back to the topic's own
 * rows in the workspace, as if each chooser were a subscriber on this list (approximate): fewer reached for a topic people
 * leave, more for one they join. When even that runs out, none left out (approximate): never fewer than the list holds.
 */
const TOPIC_COUNT_MS = 1500, TOPIC_FALLBACK_MS = 500;
async function boundedTopicOut(db: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string, topic: TopicRule, subscribed: number): Promise<{ out: number; approximate?: true }> {
  const within = async <T>(ms: number, work: (tx: DbExecutor) => Promise<T>): Promise<T | null> => (db as Database).transaction(async tx => {
    await tx.execute(sql`SAVEPOINT topic_count`);
    try { await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ms}ms'`)); return await work(tx); }
    catch (error) { if (!statementTimedOut(error)) throw error; return null; }
    finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT topic_count`); await tx.execute(sql`RELEASE SAVEPOINT topic_count`); }
  });
  const exact = await within(TOPIC_COUNT_MS, tx => listTopicOut(tx, identity, listId, topic, subscribed));
  if (exact !== null) return { out: exact };
  const chose = await within(TOPIC_FALLBACK_MS, async tx => Number((await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audience_contact_topics
    WHERE workspace_id = ${identity.workspaceId} AND topic_id = ${topic.id} AND subscribed = ${!topic.subscribedByDefault}`)).rows[0]?.n ?? 0));
  if (chose === null) return { out: 0, approximate: true };
  return { out: topic.subscribedByDefault ? Math.min(chose, subscribed) : Math.max(0, subscribed - chose), approximate: true };
}
/** Of a list's subscribers (not suppressed, not deleted), how many its topic doesn't reach: those who opted out of it, or
 *  for a topic nobody gets by default, all but those who opted in. Read from the topic's own choices (the table's key
 *  prefix) joined to their contacts and memberships by key, never from the whole list: the list's counts
 *  (audience_list_counts) know nothing of topics, and this makes them a topic's in time that grows with its choices. */
async function listTopicOut(db: DbExecutor, identity: Pick<Actor, 'workspaceId'>, listId: string, topic: TopicRule, subscribed: number) {
  const { rows: [row] } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audience_contact_topics ct
    JOIN audience_contacts c ON c.id = ct.contact_id AND c.workspace_id = ct.workspace_id
    WHERE ct.workspace_id = ${identity.workspaceId} AND ct.topic_id = ${topic.id} AND ct.subscribed = ${!topic.subscribedByDefault}
      AND c.deleted_at IS NULL AND NOT c.suppressed AND c.marketing_consent = 'subscribed'
      AND EXISTS (SELECT 1 FROM audience_list_members m WHERE m.workspace_id = ct.workspace_id AND m.list_id = ${listId} AND m.contact_id = ct.contact_id)`);
  const chose = row?.n ?? 0;
  return topic.subscribedByDefault ? chose : Math.max(0, subscribed - chose);
}
export const riskyFrom = (json: Record<string, number> | null) => riskCounts(Object.entries(json ?? {}).map(([risk, count]) => ({ risk, count })));
async function riskyByHash<T>(db: DbExecutor, work: (db: DbExecutor) => Promise<T>, own: boolean) {
  if (own && 'transaction' in db) return (db as Database).transaction(async tx => { await tx.execute(sql`SET LOCAL enable_nestloop = off`); return work(tx); });
  await db.execute(sql`SET LOCAL enable_nestloop = off`);
  try { return await work(db); } finally { await db.execute(sql`SET LOCAL enable_nestloop TO DEFAULT`); }
}

/** Display-only whole-list counts. The list tally includes every committed delta, not just its last fold. */
export async function countCampaignAudienceForDisplay(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, requiredNotice = false, topic?: TopicRule | null): Promise<AudienceCountsResult> {
  if (identity.domains.length || spec.segmentId || spec.excludeListIds?.length || spec.excludeSegmentIds?.length) {
    return countCampaignAudience(db, identity, spec, requiredNotice, topic);
  }
  if (requiredNotice) topic = null;
  // Anchor to the scoped list so a missing or foreign list still returns 404, not the counts of an empty list.
  const { rows: [row] } = await riskyByHash(db, db => db.execute<{ subscribed: number; unsubscribed: number; unknown: number; suppressed: number; risky: Record<string, number> | null }>(sql`
    SELECT coalesce(sum(c.subscribed), 0)::int AS subscribed, coalesce(sum(c.unsubscribed), 0)::int AS unsubscribed,
      coalesce(sum(c.unknown), 0)::int AS unknown, coalesce(sum(c.suppressed), 0)::int AS suppressed, ${listRisky(identity, spec.listId, requiredNotice, topic)} AS risky
    FROM audience_lists l LEFT JOIN audience_list_counts c ON c.workspace_id = l.workspace_id AND c.list_id = l.id
    WHERE l.workspace_id = ${identity.workspaceId} AND l.id = ${spec.listId}
    GROUP BY l.id`), true);
  if (!row) return notFound('List');
  // A topic's opt-outs are counted with the unsubscribed, as countCampaignAudience counts them, in bounded time: past it the
  // counts are approximate (boundedTopicOut).
  const counted = topic ? await boundedTopicOut(db, identity, spec.listId, topic, row.subscribed) : null;
  const out = counted?.out ?? 0, notSubscribed = row.unsubscribed + row.unknown, risky = riskyFrom(row.risky);
  return {
    matched: row.subscribed + notSubscribed + row.suppressed,
    eligible: Math.max(0, (requiredNotice ? row.subscribed + notSubscribed : row.subscribed - out) - risky.total),
    suppressed: row.suppressed,
    unsubscribed: requiredNotice ? 0 : notSubscribed + out,
    risky: risky.total, riskyByReason: risky.byReason,
    ...topic ? { topicExcluded: out } : {}, ...counted?.approximate ? { approximate: true as const } : {},
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
  /** The campaign's topic: its opt-outs are left out like the unsubscribed. */
  topic?: TopicRule | null;
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
  topic?: TopicRule | null,
): Promise<{ queued: number; definitive?: 'empty' | 'over_limit'; risky?: { total: number; byReason: RiskCounts }; approximate?: true }> {
  const conditions = await audienceConditions(db, identity, spec, true);
  if (requiredNotice) topic = null;
  if (!spec.segmentId && !spec.excludeListIds?.length && !spec.excludeSegmentIds?.length) {
    const hasTally = (await db.execute<{ ok: boolean }>(sql`SELECT to_regclass('public.audience_list_counts') IS NOT NULL AS ok`)).rows[0]?.ok;
    if (hasTally) {
      const [tally] = (await riskyByHash(db, db => db.execute<{ subscribed: number; reachable: number; risky: Record<string, number> | null }>(sql`
        SELECT coalesce(sum(subscribed), 0)::int AS subscribed,
               coalesce(sum(subscribed + unsubscribed + unknown), 0)::int AS reachable, ${listRisky(identity, spec.listId, requiredNotice, topic)} AS risky
        FROM audience_list_counts
        WHERE workspace_id = ${identity.workspaceId} AND list_id = ${spec.listId}`), false)).rows;
      // A topic's count is bounded in time; past it the launch judges the list's subscribers, an upper bound, as when
      // counting a segment runs out (approximate), so a large send can't skip a required ramp by not being counted.
      const subscribed = tally?.subscribed ?? 0, counted = topic ? await boundedTopicOut(db, identity, spec.listId, topic, subscribed) : null;
      const out = counted?.approximate ? 0 : counted?.out ?? 0, risky = riskyFrom(tally?.risky ?? null), expected = (requiredNotice ? (tally?.reachable ?? 0) : subscribed - out) - risky.total;
      if (expected > 0) return { queued: expected, risky, ...counted?.approximate ? { approximate: true as const } : {} };
    }
  }
  await db.execute(sql`SAVEPOINT audience_estimate`);
  try {
    await db.execute(sql.raw(`SET LOCAL statement_timeout = '${ESTIMATE_TIMEOUT_MS}ms'`));
    await db.execute(sql`SET LOCAL enable_nestloop = off`);
    const [row] = (await db.execute<{ eligible: number }>(sql`
      SELECT count(*)::int AS eligible FROM (
        SELECT 1 FROM ${contacts} ${topicJoin(topic)}
        WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} AND ${reachable(requiredNotice, topic)}
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
  const topic = requiredNotice ? null : options?.topic;
  const skippedRiskSql = sql`CASE WHEN NOT ${contacts.suppressed} AND ${consented(requiredNotice, topic)} AND ${skipped} THEN ${contacts.risk} END`;
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
        SELECT ${rankExpr} AS rank, ${contacts.id} AS id, ${contacts.email} AS email, ${reachable(requiredNotice, topic)} AS eligible, ${contacts.suppressed} AS suppressed, ${skippedRiskSql} AS skipped_risk, ${order}
        FROM ${contacts} ${memberJoin(identity, spec.listId)} ${topicJoin(topic)} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} LIMIT ${SNAPSHOT_MAX_MATCHED + 1}`
    : sql`CREATE TEMP TABLE audience_snapshot ON COMMIT DROP AS
        SELECT ${rankExpr} AS rank, ${contacts.id} AS id, ${reachable(requiredNotice, topic)} AS eligible, ${contacts.suppressed} AS suppressed, ${skippedRiskSql} AS skipped_risk, ${order}
        FROM ${contacts} ${memberJoin(identity, spec.listId)} ${topicJoin(topic)} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)} LIMIT ${SNAPSHOT_MAX_MATCHED + 1}`);
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
