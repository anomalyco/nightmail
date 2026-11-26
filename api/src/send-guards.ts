import { sql } from 'drizzle-orm';
import { log, type DbExecutor } from './core.js';
import { blocklistNamed } from './delivery-history.js';
import { placementRoot } from './domain-registry.js';
import { PUBLIC_MAILBOXES } from './list-hygiene.js';
import { BLOCKLIST_PAUSE, RAMP, type RampLines } from './standing-model.js';

// A sending campaign's guards, beside the automatic pause (src/sending.ts campaignHealth and the release loop). Lines from
// RampLines: each guard is off until the private NIGHTMAIL_RAMP setting names it, so unset, a campaign sends as before.
//  - Blocklist replies: a receiving server that names a blocklist (src/delivery-history.ts blocklistNamed) is saying a domain
//    or link in the mail is listed. Enough of them in a short window, each from a different receiving organisation (one
//    registered domain), pause the campaign (BLOCKLISTED): a listing shows at many, and one recipient's own server, or
//    one person's few domains, can't pause someone's campaign by wording their rejections. The sender can
//    resume once none has arrived for the window, an operator any time (Operator → release), and an operator alert goes out.
//  - Dead recipient domains: a domain where this campaign's mail mostly bounced for good in the last window is skipped for
//    the rest of the send. Large mailbox providers never are: a bounce rate there is the list's problem, which the
//    automatic pause answers.
//  - A plan grows only after a healthy day: its next daily batch opens only if the day before stayed within the ramp
//    check's lines and drew no blocklist reply; otherwise it repeats the same batch.

const REPLY = sql`coalesce(v.data->>'diagnosticCode', v.data #>> '{bounce,bouncedRecipients,0,diagnosticCode}', v.data #>> '{deliveryDelay,delayedRecipients,0,diagnosticCode}')`;
// A cheap first pass in SQL; blocklistNamed decides.
const NAMES = '(spamhaus|uribl|surbl|spamcop|barracuda|brbl|block ?list|black ?list|deny ?list|dnsbl|rbl|dbl|sbl|xbl|pbl)';
// The most failed emails a count reads: far more than any listing needs to show at several organisations.
const FAILED_READ = 20_000;

/**
 * Replies naming a blocklist to this campaign's mail that arrived since `since` (an instant) or in the last `minutes`. Read
 * from the campaign's bounced and delayed mail first (the campaign's status index, materialized so the planner can't start
 * from the events instead), then each one's feedback by its email (the events' page index): never a range of every event
 * of the workspace, which a large send fills with hundreds of thousands an hour against a few thousand failures.
 * At most 500 replies read. Answers how many of the campaign's emails drew one, and from how many receiving organisations
 * (the recipient domain's registered domain), so repeated delays of one email, or one organisation's many addresses or
 * domains, count once.
 */
export async function campaignBlocklistReplies(db: DbExecutor, workspaceId: string, campaignId: string, window: { minutes: number } | { since: string }) {
  const from = 'since' in window ? sql`${window.since}::timestamptz` : sql`now() - make_interval(mins => ${window.minutes})`;
  const { rows } = await db.execute<{ id: string; domain: string; reply: string | null }>(sql`WITH failed AS MATERIALIZED (
      SELECT e.id, e.workspace_id, lower(split_part(e.to_addresses->>0, '@', 2)) AS domain FROM sending_emails e
      WHERE e.workspace_id = ${workspaceId} AND e.campaign_id = ${campaignId} AND e.status IN ('bounced', 'delayed') AND e.updated_at > ${from} LIMIT ${FAILED_READ}
    ) SELECT f.id, f.domain, v.reply FROM failed f
      CROSS JOIN LATERAL (SELECT ${REPLY} AS reply FROM sending_email_events v WHERE v.workspace_id = f.workspace_id AND v.email_id = f.id
        AND v.type IN ('bounce', 'non_permanent_bounce', 'delivery_delay') AND v.created_at > ${from}) v
    WHERE v.reply ~* ${NAMES} LIMIT 500`);
  const named = rows.filter(row => blocklistNamed(row.reply));
  const organisations = new Set(await Promise.all([...new Set(named.map(row => row.domain))].map(async domain => (domain && (await placementRoot(domain)).root) || domain)));
  return { emails: new Set(named.map(row => row.id)).size, organisations: organisations.size };
}

/** The pause a campaign gets once enough blocklist replies arrived in the window, from as many organisations, else null (and always null with the guard off). */
export async function blocklistPause(db: DbExecutor, workspaceId: string, campaignId: string, lines: RampLines) {
  if (!lines.blocklistPause) return null;
  const { emails: replies, organisations } = await campaignBlocklistReplies(db, workspaceId, campaignId, { minutes: lines.blocklistPause.windowMinutes });
  if (organisations < lines.blocklistPause.replies) return null;
  return { code: 'BLOCKLISTED', message: `Paused automatically: ${replies.toLocaleString('en-US')} replies from receiving servers named a blocklist, so a domain or link in this campaign is probably listed. Find which one and fix it before sending more. You can resume once no new ones arrive, or ask for a review.` };
}

/** Stops the campaign releasing to recipient domains its mail there mostly bounced at in the window; returns the domains newly stopped. */
export async function stopDeadDomains(db: DbExecutor, workspaceId: string, campaignId: string, lines: RampLines) {
  const s = lines.domainStop;
  if (!s) return [];
  const resolved = sql`(e.status IN ('delivered', 'bounced', 'complained') OR e.event_outcomes & 6 <> 0)`, bounced = sql`(e.status = 'bounced' OR e.event_outcomes & 4 <> 0)`;
  const { rows } = await db.execute<{ domain: string; resolved: number; bounced: number }>(sql`SELECT lower(split_part(e.to_addresses->>0, '@', 2)) AS domain,
      count(*) FILTER (WHERE ${resolved})::int AS resolved, count(*) FILTER (WHERE ${bounced})::int AS bounced
    FROM sending_emails e WHERE e.workspace_id = ${workspaceId} AND e.created_at > now() - make_interval(mins => ${s.windowMinutes}) AND e.campaign_id = ${campaignId}
    GROUP BY 1 HAVING count(*) FILTER (WHERE ${resolved}) >= ${s.sent} AND count(*) FILTER (WHERE ${bounced}) >= count(*) FILTER (WHERE ${resolved}) * ${s.bouncedShare}::float8
    LIMIT 1000`);
  const dead = rows.filter(row => row.domain && !PUBLIC_MAILBOXES.has(row.domain));
  if (!dead.length) return [];
  const { rows: added } = await db.execute<{ domain: string }>(sql`INSERT INTO campaign_stopped_domains (workspace_id, campaign_id, domain, resolved, bounced)
    SELECT ${workspaceId}, ${campaignId}, d, r, b FROM unnest(${sql.param(dead.map(x => x.domain))}::text[], ${sql.param(dead.map(x => x.resolved))}::int[], ${sql.param(dead.map(x => x.bounced))}::int[]) AS u(d, r, b)
    ON CONFLICT (campaign_id, domain) DO NOTHING RETURNING domain`);
  if (added.length) log('info', { code: 'CAMPAIGN_DOMAINS_STOPPED', workspaceId, campaignId, domains: added.length });
  return added.map(row => row.domain);
}

/** The recipient domains a campaign no longer releases to. */
export async function stoppedDomains(db: DbExecutor, campaignId: string) {
  const { rows } = await db.execute<{ domain: string }>(sql`SELECT domain FROM campaign_stopped_domains WHERE campaign_id = ${campaignId}`);
  return new Set(rows.map(row => row.domain));
}

/** How a plan's last daily window went, and whether it stayed within the ramp check's lines with no blocklist reply: then its next batch opens. */
export type PlanDay = { healthy: boolean; accepted: number; bounced: number; complained: number; blocklistReplies: number };
export async function planWindowHealthy(db: DbExecutor, workspaceId: string, campaignId: string, windowStartedAt: string): Promise<PlanDay> {
  const c = RAMP.check;
  const { rows: [w] } = await db.execute<{ accepted: number; bounced: number; complained: number }>(sql`SELECT
      count(*) FILTER (WHERE e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.event_outcomes & 1 <> 0))::int AS accepted,
      count(*) FILTER (WHERE e.status = 'bounced' OR e.event_outcomes & 4 <> 0)::int AS bounced, count(*) FILTER (WHERE e.status = 'complained' OR e.event_outcomes & 8 <> 0)::int AS complained
    FROM sending_emails e WHERE e.workspace_id = ${workspaceId} AND e.created_at >= ${windowStartedAt}::timestamptz AND e.campaign_id = ${campaignId}`);
  const accepted = Number(w?.accepted ?? 0), bounced = Number(w?.bounced ?? 0), complained = Number(w?.complained ?? 0);
  const clean = (accepted < c.bounceMinimum || bounced <= accepted * c.bounceRate) && (complained < c.complaints || complained <= accepted * c.complaintRate);
  const blocklistReplies = (await campaignBlocklistReplies(db, workspaceId, campaignId, { since: windowStartedAt })).emails;
  return { healthy: clean && blocklistReplies === 0, accepted, bounced, complained, blocklistReplies };
}
/** What a held plan tells its sender: why the day didn't count as healthy, and what lets the plan grow. */
export function planHeldWhy(day: PlanDay) {
  const c = RAMP.check, why: ('bounces' | 'complaints' | 'blocklist')[] = [];
  if (day.accepted >= c.bounceMinimum && day.bounced > day.accepted * c.bounceRate) why.push('bounces');
  if (day.complained >= c.complaints && day.complained > day.accepted * c.complaintRate) why.push('complaints');
  if (day.blocklistReplies > 0) why.push('blocklist');
  return why;
}
/** The window a BLOCKLISTED campaign's resume waits for no new reply: the setting's, else the public default (the guard may have been turned off since). */
export const blocklistWindow = (lines: RampLines) => (lines.blocklistPause ?? BLOCKLIST_PAUSE).windowMinutes;
