import { blocklistPause } from '../send-guards.js';
import { mailRevision } from '../dashboard-cache.js';
import { talliesEnabled } from '../sending-tallies.js';
import { emailAccepted, emailBounced, emailComplained, emailDelivered } from '../email-outcomes.js';
import type { z } from '@hono/zod-openapi';
import { type SQL, sql, and, eq, inArray, gt, lte } from 'drizzle-orm';
import type { DbExecutor, Actor, JobHandler } from '../core/types.js';
import { ApiError } from '../core/errors.js';
import { retryDatabaseFailures, JobDeferred } from '../jobs.js';
import { CAMPAIGN_ACTIVE } from '../states.js';
import { emails, type CampaignStatsGroup, campaigns, type StoredCampaignStats } from '../db/sending.js';
import { RAMP_POLICY } from '../admission.js';
import { type RampLines, RAMP } from '../standing-model.js';
import { scope, CAMPAIGN_STATS, type CampaignStats, emptyCounts, deliveryView, PROBE, AUTO_PAUSE, RAMP_CHECK } from '../sending/schemas.js';
import type { RunRow } from './materialize.js';

/**
 * Outcome counts per (campaign, status, simulated) of the emails `where` selects, each email counted once per outcome
 * over all its stored events, without loading mail bodies. Groups of disjoint sets of emails add up, so counts taken
 * page by page equal one count over all of them.
 */
async function statsGroups(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, where: SQL | undefined) {
  const has = (bit: number) => sql`(${emails.eventOutcomes} & ${bit}) <> 0`;
  const count = (condition: SQL) => sql<number>`count(*) FILTER (WHERE ${condition})::int`;
  return db.select({
    campaignId: emails.campaignId, status: emails.status, simulated: emails.simulated, count: sql<number>`count(*)::int`,
    accepted: count(sql`NOT ${emails.simulated} AND ${emails.status} <> 'suppressed' AND (${emails.providerId} IS NOT NULL OR ${emails.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${has(1)})`),
    delivered: count(sql`${emails.status} = 'delivered' OR ${has(2)}`),
    bounced: count(sql`${emails.status} = 'bounced' OR ${has(4)}`),
    complained: count(sql`${emails.status} = 'complained' OR ${has(8)}`),
    opened: count(has(16)), clicked: count(has(32)),
    failed: count(sql`${emails.status} IN ('rejected', 'rendering_failed') OR ${has(64)}`),
    deliveryDelayed: count(sql`${emails.status} = 'delayed' OR ${has(128)}`),
  }).from(emails).where(and(scope(emails, a), where)).groupBy(emails.campaignId, emails.status, emails.simulated);
}
async function tallyStatsGroups(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, campaignIds: string[]) {
  if (!campaignIds.length) return [];
  const { rows } = await db.execute<CampaignStatsGroup & { campaignId: string }>(sql`SELECT
    campaign_id AS "campaignId", status, simulated,
    sum(email_count)::int AS count, sum(accepted)::int AS accepted, sum(delivered)::int AS delivered,
    sum(bounced)::int AS bounced, sum(complained)::int AS complained, sum(opened)::int AS opened,
    sum(clicked)::int AS clicked, sum(failed)::int AS failed, sum(delivery_delayed)::int AS "deliveryDelayed"
    FROM sending_campaign_tallies
    WHERE workspace_id = ${a.workspaceId} AND campaign_id = ANY(${sql.param(campaignIds)}::text[])
    GROUP BY 1, 2, 3 HAVING sum(email_count) > 0`);
  return rows;
}
/** The stored count of the campaign's current launch, if any (an earlier launch's never applies). */
export const storedStats = (row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats'>) => row.reviewId && row.stats?.reviewId === row.reviewId ? row.stats : null;
const backgroundCounted = (row: typeof campaigns.$inferSelect) => row.total >= CAMPAIGN_STATS.from;
/** A listed campaign's stored totals (CampaignListStats), without counting anything. */
export function listedStats(row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats'> & { tracking: boolean | null }) {
  const stored = storedStats(row);
  if (!stored) return null;
  const total = (key: 'accepted' | 'delivered' | 'opened' | 'clicked') => stored.groups.reduce((n, group) => n + group[key], 0);
  return { tracking: row.tracking ?? true, accepted: total('accepted'), delivered: total('delivered'), opened: total('opened'), clicked: total('clicked'), computedAt: stored.computedAt };
}
/**
 * Lifetime statistics of campaigns (GET /v1/campaigns/{id}/stats, and the support reads in src/support-deliverability.ts).
 * A large campaign with a stored count reads it; the others are counted now, in one statement over the campaign and
 * per-email event indexes for all of them. A stored count that saw more emails than are left is kept: the 30-day
 * retention removed the rest, and a finished campaign's figures outlive its emails.
 */
export async function campaignStats(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, rows: (typeof campaigns.$inferSelect)[]) {
  const result = new Map<string, z.infer<typeof CampaignStats>>();
  if (!rows.length) return result;
  const useTallies = await talliesEnabled(db);
  const countedAt = new Date().toISOString();
  if (useTallies) {
    // Exact at read time: sums folded rows + unfolded deltas in sending_campaign_tallies (< 2 ms at any scale).
    // After 30-day retention removes emails, a frozen or larger stored snapshot in sending_campaigns.stats stays in force.
    const grouped = await tallyStatsGroups(db, a, rows.map(row => row.id));
    for (const row of rows) {
      const stored = storedStats(row), counted = grouped.filter(item => item.campaignId === row.id);
      const tallyEmails = counted.reduce((n, item) => n + item.count, 0);
      const kept = stored && (stored.frozen || stored.emails > tallyEmails);
      result.set(row.id, statsView(row, kept ? stored.groups : counted, kept ? stored.computedAt : countedAt));
    }
    return result;
  }
  // Fallback when tally triggers are disabled (emergency undo): live aggregate behind budgetedRead.
  const live = rows.filter(row => !(backgroundCounted(row) && storedStats(row)));
  const grouped = live.length ? await statsGroups(db, a, live.length === 1 ? eq(emails.campaignId, live[0]!.id) : inArray(emails.campaignId, live.map(row => row.id))) : [];
  for (const row of rows) {
    const stored = storedStats(row), counted = grouped.filter(item => item.campaignId === row.id);
    const kept = stored && (backgroundCounted(row) || stored.emails > counted.reduce((n, item) => n + item.count, 0));
    result.set(row.id, statsView(row, kept ? stored.groups : counted, kept ? stored.computedAt : countedAt));
  }
  return result;
}
function statsView(row: typeof campaigns.$inferSelect, groups: CampaignStatsGroup[], computedAt: string): z.infer<typeof CampaignStats> {
  const real = { accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0 };
  const counts = emptyCounts(), totals = { ...real, simulated: 0 };
  for (const item of groups) {
    counts.byStatus[item.status] += item.count; counts.total += item.count;
    if (item.simulated) totals.simulated += item.count;
    for (const key of Object.keys(real) as (keyof typeof real)[]) {
      totals[key] += item[key];
      if (!item.simulated) real[key] += item[key];
    }
  }
  const rate = (numerator: number, denominator: number, enabled = true) => ({ numerator, denominator, value: denominator && enabled ? numerator / denominator : null });
  return { id: row.id, name: row.draft.name, state: row.state, tracking: row.draft.tracking, counts, delivery: deliveryView(row), totals,
    rates: { delivery: rate(real.delivered, real.accepted), bounce: rate(real.bounced, real.accepted), complaint: rate(real.complained, real.accepted), open: rate(real.opened, real.delivered, row.draft.tracking), click: rate(real.clicked, real.delivered, row.draft.tracking) }, computedAt };
}
const addGroups = (sum: CampaignStatsGroup[], page: CampaignStatsGroup[]) => {
  const next = sum.map(group => ({ ...group }));
  for (const item of page) {
    const { status, simulated, count, accepted, delivered, bounced, complained, opened, clicked, failed, deliveryDelayed } = item;
    const group = next.find(g => g.status === status && g.simulated === simulated);
    if (!group) { next.push({ status, simulated, count, accepted, delivered, bounced, complained, opened, clicked, failed, deliveryDelayed }); continue; }
    for (const key of ['count', 'accepted', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'deliveryDelayed'] as const) group[key] += item[key];
  }
  return next;
};
const campaignStatsJobId = (campaignId: string) => `campaign-stats:${campaignId}`;
/** Starts the campaign's background count at `at` (now when null), unless one is already waiting or running. */
export const queueCampaignStats = (ref: { workspaceId: string; id: string }, at: string | null = null) => queueCampaignsStats(ref.workspaceId, [ref.id], at);
/** The same for several campaigns of a workspace, in one statement that takes their job rows in ID order. */
export const queueCampaignsStats = (workspaceId: string, campaignIds: string[], at: string | null = null) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at)
  VALUES ${sql.join([...campaignIds].sort().map(campaignId => sql`(${campaignStatsJobId(campaignId)},'sending.campaignStats',${workspaceId},${JSON.stringify({ campaignId })}::jsonb,coalesce(${at}::timestamptz,now()))`), sql`,`)}
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL
  WHERE jobs.status IN ('completed','failed')`;
/** A read restarts the count of a launched campaign never counted, or of a finished one counted `readRefreshMs` ago. */
export function statsDue(row: Pick<typeof campaigns.$inferSelect, 'reviewId' | 'stats' | 'state'>) {
  if (!row.reviewId) return false;
  const stored = storedStats(row);
  if (!stored) return true;
  return !stored.frozen && !(CAMPAIGN_ACTIVE as readonly string[]).includes(row.state) && Date.now() - Date.parse(stored.computedAt) >= CAMPAIGN_STATS.readRefreshMs;
}
type StatsPass = { reviewId: string; computedAt: string; revision: string; ordinal: number; groups: CampaignStatsGroup[] };
/**
 * One campaign's background count: a page of its emails by review ordinal (sending_emails_review_ordinal) per run, each
 * its own short statement outside any transaction, the running sums carried in the job's payload between runs, stored on
 * the campaign when the pass ends. Every email of a campaign belongs to its current review: the release is the only path
 * that writes campaign mail, and a launch takes a new review only while nothing was released.
 */
export const campaignStatsJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A campaign count needs its campaign.');
  const campaignId = payload.campaignId, a = { workspaceId: job.workspaceId }, at = (ms: number) => new Date(Date.now() + ms).toISOString(), started = Date.now();
  const [row] = await runtime.db.select().from(campaigns).where(and(scope(campaigns, a), eq(campaigns.id, campaignId)));
  // Deleted, or a draft again: nothing to count until a launch queues this again.
  if (!row?.reviewId) return;
  const active = (CAMPAIGN_ACTIVE as readonly string[]).includes(row.state), stored = storedStats(row);
  let pass = payload.pass as StatsPass | undefined;
  if (pass?.reviewId !== row.reviewId) pass = undefined;
  if (!pass) {
    if (stored?.frozen) return;
    // While it sends, only a large campaign is counted (a small one is counted when read), and only once it released
    // someone: until then wait for its schedule, looking again at least every 15 minutes in case it moved.
    if (active && (row.expanded === 0 || !backgroundCounted(row))) {
      const due = row.expanded === 0 && row.scheduledAt ? Date.parse(row.scheduledAt) - Date.now() : 0;
      throw new JobDeferred(at(Math.min(Math.max(due, CAMPAIGN_STATS.everyMs), 15 * 60_000)), { campaignId });
    }
    // Nothing changed when the workspace has no newer email or email event; a finished campaign is counted once after
    // it finished, so its figures are exact then.
    const revision = await mailRevision(runtime, a.workspaceId);
    if (stored && stored.revision === revision && (active || Date.parse(stored.computedAt) >= Date.parse(row.updatedAt))) {
      if (active) throw new JobDeferred(at(CAMPAIGN_STATS.everyMs), { campaignId });
      return;
    }
    // The database's clock, which also stamps updated_at, so "counted after it finished" never depends on this host's clock.
    const { rows: [clock] } = await runtime.db.execute<{ at: string }>(sql`SELECT to_json(clock_timestamp())#>>'{}' AS at`);
    pass = { reviewId: row.reviewId, computedAt: new Date(clock!.at).toISOString(), revision, ordinal: 0, groups: [] };
  }
  // Pages, each its own statement, until the run has used `runMs`: the job's own claim and settle are then a small part
  // of each run.
  while (pass.ordinal < row.expanded) {
    const page = await statsGroups(runtime.db, a, and(eq(emails.campaignId, campaignId), eq(emails.reviewId, pass.reviewId), gt(emails.reviewOrdinal, pass.ordinal), lte(emails.reviewOrdinal, pass.ordinal + CAMPAIGN_STATS.page)));
    pass = { ...pass, ordinal: pass.ordinal + CAMPAIGN_STATS.page, groups: addGroups(pass.groups, page) };
    if (Date.now() - started >= CAMPAIGN_STATS.runMs) break;
  }
  // This run's database time, paid back as idle time before the next run or pass.
  const pause = Math.max(CAMPAIGN_STATS.pauseMs, CAMPAIGN_STATS.pace * (Date.now() - started));
  if (pass.ordinal < row.expanded) throw new JobDeferred(at(pause), { campaignId, pass });
  const counted: StoredCampaignStats = { reviewId: pass.reviewId, computedAt: pass.computedAt, revision: pass.revision, emails: pass.groups.reduce((n, g) => n + g.count, 0), groups: pass.groups };
  // A count never replaces one that saw more emails: the 30-day retention deleted those, so the stored figures stay, frozen.
  const kept = await runtime.db.execute(sql`UPDATE sending_campaigns SET stats=${JSON.stringify(counted)}::jsonb WHERE workspace_id=${a.workspaceId} AND id=${campaignId} AND review_id=${pass.reviewId}
    AND (stats->>'reviewId' IS DISTINCT FROM ${pass.reviewId} OR (stats->>'emails')::int <= ${counted.emails}) RETURNING id`);
  if (!kept.rows.length) {
    await runtime.db.execute(sql`UPDATE sending_campaigns SET stats=stats||'{"frozen":true}'::jsonb WHERE workspace_id=${a.workspaceId} AND id=${campaignId} AND stats->>'reviewId'=${pass.reviewId}`);
    return;
  }
  if (active) throw new JobDeferred(new Date(Math.max(Date.parse(pass.computedAt) + CAMPAIGN_STATS.everyMs, Date.now() + pause)).toISOString(), { campaignId });
  // A pass that started before the campaign finished is followed by one after it, so the finished figures are exact.
  if (Date.parse(pass.computedAt) < Date.parse(row.updatedAt)) throw new JobDeferred(at(pause), { campaignId });
});
/**
 * A campaign's accepted, bounced and complained emails (src/email-outcomes.ts): bounce and complaint rates are over
 * accepted mail, and suppressed mail (ineligible at claim time, or dropped by SES Auto Validation) is neither accepted nor
 * bounced. A real campaign reads its tallies (migration 407, kept by the same statement that changes an email), a few
 * rows whatever its size; a simulated one, whose tallies count nothing as accepted, or one while the tally triggers are
 * off, counts its emails.
 */
export async function campaignOutcomes(db: DbExecutor, wid: string, campaignId: string, simulated: boolean) {
  const [row] = (await db.execute<{ accepted: number; bounced: number; complained: number }>(!simulated && await talliesEnabled(db)
    ? sql`SELECT coalesce(sum(accepted), 0)::int AS accepted, coalesce(sum(bounced), 0)::int AS bounced, coalesce(sum(complained), 0)::int AS complained
        FROM sending_campaign_tallies WHERE workspace_id = ${wid} AND campaign_id = ${campaignId} AND NOT simulated`
    : sql`SELECT count(*) FILTER (WHERE ${emailAccepted()})::int AS accepted, count(*) FILTER (WHERE ${emailBounced()})::int AS bounced,
        count(*) FILTER (WHERE ${emailComplained()})::int AS complained FROM sending_emails e WHERE e.workspace_id = ${wid} AND e.campaign_id = ${campaignId}`)).rows;
  return row!;
}
export async function campaignHealth(db: DbExecutor, a: Actor, campaign: Pick<RunRow, 'id' | 'simulated'>, hosted = false, probe?: number, lines?: RampLines): Promise<{ code: string; message: string } | null> {
  const campaignId = campaign.id;
  // Replies naming a blocklist first (src/send-guards.ts): the probe and every later check.
  const listed = lines ? await blocklistPause(db, a.workspaceId, campaignId, lines) : null;
  if (listed) return listed;
  const row = await campaignOutcomes(db, a.workspaceId, campaignId, campaign.simulated);
  const percent = (part: number, whole: number) => `${(100 * part / whole).toFixed(2)}%`;
  if (probe !== undefined && row.accepted && (row.bounced / row.accepted > PROBE.bounceRate || row.complained >= PROBE.complaints))
    return { code: 'LIST_QUALITY', message: `Quarantined: the first ${row.accepted} recipients (the list probe) had ${row.bounced} hard bounces (${percent(row.bounced, row.accepted)}; the line is ${PROBE.bounceRate * 100}%) and ${row.complained} spam complaints (the line is ${PROBE.complaints}). Bounced addresses were suppressed. Remove contacts you have not mailed before, or confirm the list's source, then resume.` };
  if (probe !== undefined) return null;
  if (row.accepted >= AUTO_PAUSE.bounceMinimum && row.bounced / row.accepted > AUTO_PAUSE.bounceRate)
    return { code: 'BOUNCE_RATE_HIGH', message: `Paused automatically: ${percent(row.bounced, row.accepted)} of ${row.accepted} accepted emails bounced (limit ${AUTO_PAUSE.bounceRate * 100}%). Review the audience before resuming.` };
  if (row.accepted >= (hosted ? AUTO_PAUSE.hostedComplaintMinimum : AUTO_PAUSE.complaintMinimum) && row.complained / row.accepted > AUTO_PAUSE.complaintRate)
    return { code: 'COMPLAINT_RATE_HIGH', message: `Paused automatically: ${percent(row.complained, row.accepted)} of ${row.accepted} accepted emails were marked as spam (limit ${AUTO_PAUSE.complaintRate * 100}%). Review the audience before resuming.` };
  return null;
}
/**
 * The workspace's largest clean, mature hour of real marketing mail in the last RAMP.historyDays days, as SES accepted it:
 * where its campaigns, and its marketing sent through the API, start on the ramp (src/standing-model.ts rampStart).
 * ramp_clean_hour (migration 501) says what counts: mature is 90% of it delivered or bounced; clean is within the ramp's
 * bounce and complaint lines (RAMP_CHECK), and so is the whole window, else nothing counts. The hour still running never
 * counts.
 */
export async function rampHistory(db: DbExecutor, workspaceId: string) {
  const [found] = (await db.execute<{ best: number }>(sql`SELECT ramp_clean_hour(${workspaceId},${JSON.stringify(RAMP_POLICY.history)}::jsonb) AS best`)).rows;
  return Number(found?.best ?? 0);
}
/** What a ramp step's hour released (review ordinals after `from`, through the cursor) and the feedback it has so far. */
export async function rampBatch(db: DbExecutor, a: Actor, row: Pick<RunRow, 'reviewId' | 'expanded'>, from: number) {
  const [batch] = (await db.execute<{ released: number; waiting: number; accepted: number; resolved: number; bounced: number; complained: number }>(sql`SELECT count(*)::int AS released,
      count(*) FILTER (WHERE status IN ('queued','attempting'))::int AS waiting,
      count(*) FILTER (WHERE ${emailAccepted('')})::int AS accepted,
      count(*) FILTER (WHERE status = 'complained' OR ${emailDelivered('')} OR ${emailBounced('')})::int AS resolved,
      count(*) FILTER (WHERE ${emailBounced('')})::int AS bounced,
      count(*) FILTER (WHERE ${emailComplained('')})::int AS complained
    FROM sending_emails WHERE review_id=${row.reviewId} AND review_ordinal>${from} AND review_ordinal<=${row.expanded} AND workspace_id=${a.workspaceId}`)).rows;
  return batch!;
}
/** A ramp step's batch over the ramp's lines (RAMP_CHECK): the automatic pause's codes, with what the ramp is in the message. */
export function rampHealth(batch: Awaited<ReturnType<typeof rampBatch>>, step: number): { code: string; message: string } | null {
  const percent = (part: number) => `${(100 * part / batch.accepted).toFixed(2)}%`, n = (value: number) => value.toLocaleString('en-US');
  const about = `A new sender's large campaign goes out in hourly steps that grow, and each step is checked before the next: this was step ${step + 1} of ${RAMP.steps.length}, up to ${n(RAMP.steps[step]!.ceilingPerHour)} an hour.`;
  if (batch.accepted >= RAMP_CHECK.bounceMinimum && batch.bounced > batch.accepted * RAMP_CHECK.bounceRate)
    return { code: 'BOUNCE_RATE_HIGH', message: `Paused automatically while ramping up: ${n(batch.bounced)} of the last step's ${n(batch.accepted)} accepted emails bounced (${percent(batch.bounced)}; the line is ${RAMP_CHECK.bounceRate * 100}%). ${about} Bounced addresses were suppressed. Review the list, then resume.` };
  if (batch.complained >= RAMP_CHECK.complaints && batch.complained > batch.accepted * RAMP_CHECK.complaintRate)
    return { code: 'COMPLAINT_RATE_HIGH', message: `Paused automatically while ramping up: ${n(batch.complained)} of the last step's ${n(batch.accepted)} accepted emails were marked as spam (${percent(batch.complained)}; the line is ${RAMP_CHECK.complaintRate * 100}%). ${about} Review the audience, then resume.` };
  return null;
}
/**
 * Whether a sender in good standing may skip this campaign's list probe: an earlier campaign delivered to these
 * recipients, by address, and their feedback is in and clean. It reads every one of this launch's frozen recipients,
 * whatever list or segment they came from, against what one of the workspace's last three campaigns finished in the last
 * 90 days did with the same addresses. A campaign over 10,000 recipients is always probed: it is never read in part.
 *  - it delivered to at least 90% of them: an address it bounced, drew a complaint from, never mailed or has no result
 *    for counts against it;
 *  - their feedback is mature: at least 90% of those it mailed resolved as delivered or bounced, and the probe's ten-minute
 *    wait has passed since the last of them changed (its acceptance, or feedback after it);
 *  - it was clean: hard bounces within the probe's 3% and complaints within the automatic pause's 0.08% of those it mailed.
 * That campaign finished without a quarantine and was not one released only to earlier recipients after one.
 */
const CLEAN_LIST = { days: 90, coverage: 0.9, resolved: 0.9, candidates: 3, largest: 10_000 } as const;
export async function listMailedCleanly(db: DbExecutor, a: Pick<Actor, 'workspaceId'>, row: Pick<RunRow, 'id' | 'reviewId' | 'total'>) {
  if (row.total > CLEAN_LIST.largest) return false;
  // This launch's addresses (at most 10,000), then each candidate's mail to them, matched by a hashed array lookup.
  const emails = (await db.execute<{ email: string }>(sql`SELECT DISTINCT lower(recipient->>'email') AS email FROM sending_review_recipients WHERE review_id=${row.reviewId}`)).rows.map(r => r.email);
  if (!emails.length) return false;
  const [found] = (await db.execute<{ clean: boolean }>(sql`WITH candidates AS MATERIALIZED (
      SELECT c.id FROM sending_campaigns c WHERE c.workspace_id=${a.workspaceId} AND c.id<>${row.id} AND c.state='done' AND NOT c.simulated AND c.quarantines=0 AND NOT c.delivered_only
        AND c.updated_at>now()-make_interval(days=>${CLEAN_LIST.days}::int) ORDER BY c.updated_at DESC LIMIT ${CLEAN_LIST.candidates}
    ), mailed AS MATERIALIZED (
      SELECT e.campaign_id,lower(e.to_addresses->>0) AS email,bool_or(${emailDelivered()}) AS delivered,
        bool_or(${emailBounced()}) AS bounced,bool_or(${emailComplained()}) AS complained,max(e.updated_at) AS changed
      FROM candidates c JOIN sending_emails e ON e.workspace_id=${a.workspaceId} AND e.campaign_id=c.id AND lower(e.to_addresses->>0)=ANY(${sql.param(emails)}::text[])
        AND ${emailAccepted()}
      GROUP BY 1,2
    ), history AS (
      SELECT campaign_id,count(*) FILTER (WHERE delivered AND NOT bounced AND NOT complained) AS covered,count(*) AS mailed,count(*) FILTER (WHERE delivered OR bounced) AS resolved,
        count(*) FILTER (WHERE bounced) AS bounced,count(*) FILTER (WHERE complained) AS complained,max(changed) AS changed
      FROM mailed GROUP BY campaign_id
    )
    SELECT EXISTS (SELECT FROM history h
      WHERE h.covered>0 AND h.covered>=${Math.ceil(CLEAN_LIST.coverage * emails.length)}::int AND h.resolved>=h.mailed*${CLEAN_LIST.resolved}::numeric
        AND h.changed<=now()-make_interval(secs=>${PROBE.waitMs / 1000}::int) AND h.bounced<=h.mailed*${PROBE.bounceRate}::numeric AND h.complained<=h.mailed*${AUTO_PAUSE.complaintRate}::numeric) AS clean`)).rows;
  return found!.clean;
}
