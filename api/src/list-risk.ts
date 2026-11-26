import { sql } from 'drizzle-orm';
import { log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { RISKS, type Risk } from './list-hygiene.js';
import { LIST_RISK_FACTORS, type ListRiskFactor, type ListRiskLines, type ReviewAtLaunch } from './list-risk-lines.js';

// The list-risk measure: how a campaign's list was collected and how it has fared, from this workspace's own contacts
// and mail only (the delivery history of src/delivery-history.ts, the contacts' risk flags of src/list-hygiene.ts and the
// campaign tallies). Recorded on the review of every marketing campaign to a list (sending_campaign_reviews.list_risk,
// migration 543) by a job its launch queues; nothing reads it to decide anything yet.
//  - FLAGGED_SOURCE: contacts flagged risky, those the send skips included: how the list was gathered, not who gets mail.
//  - DEAD_DOMAINS: contacts at a domain where this workspace's mail mostly failed for good (DEAD_DOMAIN below).
//  - UNENGAGED: of contacts mailed at least UNENGAGED.mailed times over UNENGAGED.days or more, those with no open or click in that time.
//  - NEVER_MAILED: contacts never mailed (no delivery history and no tracked open or click).
//  - LAST_SEND_BOUNCES, LAST_SEND_COMPLAINTS: the rates of the last campaign to this list.
//  - RECENT_BLOCKLIST: replies naming a blocklist to this workspace's mail in the last RECENT_DAYS days.
// Also recorded: soft-failing contacts and proven ones (delivered to before, or opened or clicked), so that how much a
// list's history should outweigh how it was gathered can be judged from real reviews before anything acts on it.
// A band (low, elevated, high) only with NIGHTMAIL_LIST_RISK set (src/list-risk-lines.ts): any factor over its high
// line, or two over their elevated lines, is high; one is elevated. NEVER_MAILED is never high: a new opt-in list is all
// never-mailed.
const SAMPLE = 10_000;
const DEAD_DOMAIN = { sent: 10, failedShare: 0.5, failedSinceDelivery: 10 } as const;
const UNENGAGED = { mailed: 5, days: 180, minimumBase: 100 } as const;
const LAST_SEND = { minimumAccepted: 100 } as const;
const RECENT_DAYS = 14;
export type Band = 'low' | 'elevated' | 'high';
export type ListRisk = {
  version: 1; at: string; listId: string;
  /** Contacts read: all of them up to SAMPLE, else a uniform sample of SAMPLE. */
  sampled: number; exact: boolean;
  counts: { flagged: number; deadDomains: number; unengaged: number; unengagedBase: number; neverMailed: number; softFailing: number; proven: number; byReason: Record<Risk, number> };
  lastSend: { campaignId: string; accepted: number; bounced: number; complained: number } | null;
  recentBlocklist: number;
  values: Partial<Record<ListRiskFactor, number>>;
  band: Band | null;
  factors: { code: ListRiskFactor; level: 'elevated' | 'high' }[];
  /** What the send review said at launch (verdict, what required a ramp, its reason codes); absent on reviews from before it was kept. */
  review?: ReviewAtLaunch | null;
};

/** The factors' values and, with lines, the band. */
export function bandListRisk(values: Partial<Record<ListRiskFactor, number>>, lines: ListRiskLines | null): Pick<ListRisk, 'band' | 'factors'> {
  if (!lines) return { band: null, factors: [] };
  const factors: ListRisk['factors'] = [];
  for (const code of LIST_RISK_FACTORS) {
    const value = values[code], line = lines[code];
    if (value === undefined || !line) continue;
    if (line.high !== undefined && value >= line.high && code !== 'NEVER_MAILED') factors.push({ code, level: 'high' });
    else if (line.elevated !== undefined && value >= line.elevated) factors.push({ code, level: 'elevated' });
  }
  const band: Band = factors.some(f => f.level === 'high') || factors.length >= 2 ? 'high' : factors.length ? 'elevated' : 'low';
  return { band, factors };
}

/** Measures one list of a workspace. A few bounded statements: a sample of the list by primary key, its domains' history, the last campaign's tallies. */
export async function measureListRisk(db: DbExecutor, workspaceId: string, listId: string, lines: ListRiskLines | null, excludeCampaignId: string | null = null): Promise<ListRisk> {
  const reasons = RISKS.map(r => sql`count(*) FILTER (WHERE c.risk = ${r})::int AS ${sql.identifier('r_' + r)}`);
  const { rows: [m] } = await db.execute<Record<string, number>>(sql`WITH picked AS MATERIALIZED (
      SELECT m.contact_id FROM audience_list_members m WHERE m.workspace_id = ${workspaceId} AND m.list_id = ${listId}
      ORDER BY hashtextextended(m.contact_id, 0) LIMIT ${SAMPLE + 1}
    ), c AS MATERIALIZED (
      SELECT c.* FROM picked p CROSS JOIN LATERAL (
        SELECT c.workspace_id, c.deleted_at, c.email, c.risk, c.mailed_count, c.delivered_count, c.first_mailed_at, c.observed_since, c.last_open_at, c.last_click_at, c.soft_failures
        FROM audience_contacts c WHERE c.id = p.contact_id LIMIT 1) c
      WHERE c.workspace_id = ${workspaceId} AND c.deleted_at IS NULL
    )
    SELECT (SELECT count(*) FROM picked)::int AS picked, count(*)::int AS n, count(*) FILTER (WHERE c.risk IS NOT NULL)::int AS flagged,
      count(*) FILTER (WHERE d.sent >= ${DEAD_DOMAIN.sent} AND (d.user_unknown + d.dead_domain + d.validation) >= d.sent * ${DEAD_DOMAIN.failedShare}::float8
        OR d.failed_since_delivery >= ${DEAD_DOMAIN.failedSinceDelivery})::int AS dead_domains,
      count(*) FILTER (WHERE c.mailed_count >= ${UNENGAGED.mailed} AND c.first_mailed_at <= now() - make_interval(days => ${UNENGAGED.days}))::int AS unengaged_base,
      count(*) FILTER (WHERE c.mailed_count >= ${UNENGAGED.mailed} AND c.first_mailed_at <= now() - make_interval(days => ${UNENGAGED.days})
        AND coalesce(greatest(c.last_open_at, c.last_click_at), '-infinity') < now() - make_interval(days => ${UNENGAGED.days}))::int AS unengaged,
      count(*) FILTER (WHERE c.mailed_count = 0 AND c.observed_since IS NULL)::int AS never_mailed,
      count(*) FILTER (WHERE c.soft_failures >= 3)::int AS soft_failing,
      count(*) FILTER (WHERE c.delivered_count > 0 OR c.last_open_at IS NOT NULL OR c.last_click_at IS NOT NULL)::int AS proven, ${sql.join(reasons, sql`, `)}
    FROM c LEFT JOIN delivery_domain_stats d ON d.workspace_id = ${workspaceId} AND d.domain = split_part(c.email, '@', 2)`);
  const { rows: [last] } = await db.execute<{ id: string; accepted: number; bounced: number; complained: number }>(sql`SELECT c.id, t.accepted, t.bounced, t.complained
    FROM sending_campaigns c CROSS JOIN LATERAL (SELECT coalesce(sum(accepted), 0)::int AS accepted, coalesce(sum(bounced), 0)::int AS bounced, coalesce(sum(complained), 0)::int AS complained
      FROM sending_campaign_tallies t WHERE t.workspace_id = c.workspace_id AND t.campaign_id = c.id AND NOT t.simulated) t
    WHERE c.workspace_id = ${workspaceId} AND c.list_id = ${listId} AND NOT c.simulated AND c.expanded > 0 ${excludeCampaignId ? sql`AND c.id <> ${excludeCampaignId}` : sql``}
    ORDER BY c.created_at DESC LIMIT 1`);
  const { rows: [blocked] } = await db.execute<{ n: number }>(sql`SELECT coalesce(sum(rejections), 0)::int AS n FROM delivery_blocklist_daily
    WHERE workspace_id = ${workspaceId} AND day >= current_date - ${RECENT_DAYS}::int`);
  const n = Number(m!.n), share = (k: number) => n ? k / n : 0;
  const counts = { flagged: Number(m!.flagged), deadDomains: Number(m!.dead_domains), unengaged: Number(m!.unengaged), unengagedBase: Number(m!.unengaged_base),
    neverMailed: Number(m!.never_mailed), softFailing: Number(m!.soft_failing), proven: Number(m!.proven), byReason: Object.fromEntries(RISKS.map(r => [r, Number(m!['r_' + r])])) as Record<Risk, number> };
  const values: ListRisk['values'] = {};
  if (n) { values.FLAGGED_SOURCE = share(counts.flagged); values.DEAD_DOMAINS = share(counts.deadDomains); values.NEVER_MAILED = share(counts.neverMailed); }
  if (counts.unengagedBase >= UNENGAGED.minimumBase) values.UNENGAGED = counts.unengaged / counts.unengagedBase;
  if (last && last.accepted >= LAST_SEND.minimumAccepted) { values.LAST_SEND_BOUNCES = last.bounced / last.accepted; values.LAST_SEND_COMPLAINTS = last.complained / last.accepted; }
  values.RECENT_BLOCKLIST = Number(blocked?.n ?? 0);
  return { version: 1, at: new Date().toISOString(), listId, sampled: n, exact: Number(m!.picked) <= SAMPLE, counts,
    lastSend: last ? { campaignId: last.id, accepted: last.accepted, bounced: last.bounced, complained: last.complained } : null,
    recentBlocklist: values.RECENT_BLOCKLIST, values, ...bandListRisk(values, lines) };
}

/** audience.listRisk: records the measure on a launched campaign's review, once, as the list stood at launch (queued by the launch). */
export const listRiskJob: JobHandler = async (runtime: Runtime, payload) => {
  const { campaignId, reviewId, listId, review } = payload as { campaignId?: string; reviewId?: string; listId?: string; review?: ReviewAtLaunch | null };
  const workspaceId = (payload as { workspaceId?: string }).workspaceId;
  if (!campaignId || !reviewId || !listId || !workspaceId) return;
  await runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout', '15000', true)`);
    const risk: ListRisk = { ...await measureListRisk(tx, workspaceId, listId, runtime.config.listRisk ?? null, campaignId), review: review ?? null };
    const { rowCount } = await tx.execute(sql`UPDATE sending_campaign_reviews SET list_risk = ${JSON.stringify(risk)}::jsonb
      WHERE workspace_id = ${workspaceId} AND id = ${reviewId} AND list_risk IS NULL`);
    if (rowCount) log('info', { code: 'LIST_RISK_RECORDED', workspaceId, campaignId, band: risk.band, sampled: risk.sampled });
  });
};
