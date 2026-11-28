import { z } from '@hono/zod-openapi';
import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { DbExecutor } from './core.js';
import { mailMessages as messages, mailboxMessages as links, mailboxes } from './db/mailbox.js';
import { emails } from './db/sending.js';
import { EmailStatusFilter } from './sending.js';

export type LogFacetCut = {
  asOf: string;
  sent: { kind: 'transactional' | 'marketing'; status: string; n: number }[];
  admin: { total: number; spam: number };
  member: { total: number };
};
export type LogFacetPeriod = '24h' | '7d' | '30d';

const periodHours: Record<LogFacetPeriod, number> = { '24h': 24, '7d': 168, '30d': 720 };
const Kind = z.enum(['transactional', 'marketing']);
const Count = z.int().nonnegative();
const counts = {
  sent: z.array(z.strictObject({ kind: Kind, status: EmailStatusFilter, n: Count }))
    .max(Kind.options.length * EmailStatusFilter.options.length),
  admin: z.strictObject({ total: Count, spam: Count }),
  member: z.strictObject({ total: Count }),
};
const Cut = z.strictObject({ asOf: z.iso.datetime({ precision: 6 }), ...counts });
const WithRolling = Cut.extend({
  rolling: z.strictObject({ from: z.iso.datetime({ precision: 3 }), ...counts }),
});

const consistent = (cut: LogFacetCut) => cut.admin.spam <= cut.admin.total && cut.member.total <= cut.admin.total
  && new Set(cut.sent.map(row => `${row.kind}:${row.status}`)).size === cut.sent.length;

/** Validate a source or persisted cut without repairing incomplete counts. */
export function parseLogFacetCut(raw: unknown): LogFacetCut | null {
  const cut = Cut.safeParse(raw);
  return cut.success && consistent(cut.data) ? cut.data : null;
}

/**
 * Rows a fold from `lower` would read, or more than `cap` when it has more. A fold reads every email in its window
 * (about 420 heap bytes each, with no index-only path), so a window past the cap is refused before it starts rather
 * than read for 12 seconds, failed and retried. Sent mail comes from the hourly tallies (migration 407) when their
 * triggers are on: a few rows per hour.
 */
export const LOG_FACET_MAX_SOURCE_ROWS = 5_000_000;
export async function logFacetSourceRows(db: DbExecutor, workspaceId: string, lower: string, region: string | null, cap = LOG_FACET_MAX_SOURCE_ROWS) {
  const { talliesEnabled } = await import('./sending-tallies.js');
  const inRegion = (column: SQLWrapper) => region === null ? sql`` : sql` AND ${column} = ${region}`;
  const { rows: [sent] } = await db.execute<{ n: string }>(await talliesEnabled(db)
    ? sql`SELECT coalesce(sum(emails), 0)::bigint AS n FROM sending_metrics_hourly
        WHERE workspace_id = ${workspaceId} AND hour >= date_trunc('hour', ${lower}::timestamptz, 'UTC')${inRegion(sql`region`)}`
    : sql`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${emails} WHERE ${eq(emails.workspaceId, workspaceId)}
        AND ${emails.createdAt} >= ${lower}::timestamptz${inRegion(emails.region)} LIMIT ${cap + 1}) s`);
  const rest = cap - Number(sent?.n ?? 0);
  if (rest < 0) return cap + 1;
  const { rows: [received] } = await db.execute<{ n: string }>(sql`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${messages}
    WHERE ${eq(messages.workspaceId, workspaceId)} AND ${messages.direction} = 'inbound' AND ${messages.receivedAt} >= ${lower}::timestamptz${inRegion(messages.region)}
    LIMIT ${rest + 1}) r`);
  return cap - rest + Number(received?.n ?? 0);
}

/**
 * The request's absolute lower bound and optionally a rolling lower bound anchored to this statement's UTC minute.
 * Both are lower bounds only, so even future-dated mail remains in scope. They share the MVCC snapshot
 * and visibility clock, but counts from one lower bound are never used as counts for the other.
 */
export async function readLogFacetGeneration(
  db: DbExecutor, workspaceId: string, from: string, region: string | null, period?: LogFacetPeriod,
): Promise<{ cut: LogFacetCut; rolling?: { period: LogFacetPeriod; from: string; cut: LogFacetCut } }> {
  const absoluteFrom = sql`${from}::timestamptz`;
  const rollingFrom = period === undefined ? null : sql`(SELECT rolling_from FROM bounds)`;
  // The scans' lower bound is the same instant written inline: the planner estimates a stable expression, but not
  // the bounds CTE (an InitPlan counts as a third of the workspace and hashes every mailbox link in the installation).
  // The counts still use the exact bands below.
  const lower = period === undefined ? absoluteFrom : sql`least(${absoluteFrom}, (date_trunc('minute', statement_timestamp() AT TIME ZONE 'UTC')
    - make_interval(hours => ${periodHours[period]}::int)) AT TIME ZONE 'UTC')`;
  const scopedRange = (date: SQLWrapper, regionColumn: typeof emails.region | typeof messages.region) =>
    sql`${date} >= ${lower}${region === null ? sql`` : sql` AND ${eq(regionColumn, region)}`}`;
  // The scalar bounds reference is computed once, not truncated per matching row. Doing the clock
  // arithmetic in UTC keeps 24h/7d/30d independent of the session time zone and daylight saving.
  const bounds = period === undefined ? sql`` : sql`bounds AS MATERIALIZED (
    SELECT (date_trunc('minute', statement_timestamp() AT TIME ZONE 'UTC')
      - make_interval(hours => ${periodHours[period]}::int)) AT TIME ZONE 'UTC' AS rolling_from
  ), `;
  const sentCounts = rollingFrom === null ? sql`count(*) AS n` : sql`
    count(*) FILTER (WHERE ${emails.createdAt} >= ${absoluteFrom}) AS n,
    count(*) FILTER (WHERE ${emails.createdAt} >= ${rollingFrom}) AS rolling_n`;
  const sentInRegion = region === null ? null : eq(emails.region, region);
  // A small region can use the workspace/region index directly. For a populated region, that
  // index walks all its history to test the dates, so keep the date index as the access path.
  const sentRegionSize = sentInRegion === null ? sql`` : sql`sent_region AS MATERIALIZED (
    SELECT EXISTS (SELECT 1 FROM ${emails}
      WHERE ${eq(emails.workspaceId, workspaceId)} AND ${sentInRegion}
      OFFSET 65536 LIMIT 1) AS dense
  ), `;
  const denseSentRegion = sql`(SELECT dense FROM sent_region)`;
  const groupedSent = (regionalFilter: SQL) => sql`
    SELECT CASE ${emails.snapshot}->>'kind' WHEN 'transactional' THEN 'transactional' WHEN 'marketing' THEN 'marketing' END AS kind,
      CASE WHEN ${emails.status}=ANY(${sql.param(EmailStatusFilter.options)}::text[]) THEN ${emails.status} END AS status,${sentCounts}
    FROM ${emails} WHERE ${eq(emails.workspaceId, workspaceId)} AND ${emails.createdAt} >= ${lower}${regionalFilter}
    GROUP BY 1,2`;
  const sentGroups = sentInRegion === null ? groupedSent(sql``) : sql`
    ${groupedSent(sql` AND ${denseSentRegion} AND CASE WHEN ${sentInRegion} THEN true ELSE false END`)}
    UNION ALL ${groupedSent(sql` AND NOT ${denseSentRegion} AND ${sentInRegion}`)}`;
  const receivedBands = rollingFrom === null ? sql`` : sql`
    ${messages.receivedAt} >= ${absoluteFrom} AS in_absolute,
    ${messages.receivedAt} >= ${rollingFrom} AS in_rolling,`;
  const sent = (n: SQL) => sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'status',status,'n',${n})
      ORDER BY kind,status),'[]'::jsonb)
    FROM grouped WHERE kind IS NOT NULL${rollingFrom === null ? sql`` : sql` AND ${n}>0`})`;
  const received = (within?: SQL) => {
    const gate = within === undefined ? sql`` : sql` AND ${within}`;
    return {
      admin: sql`jsonb_build_object('total',count(*) FILTER (WHERE adm${gate}),'spam',count(*) FILTER (WHERE adm AND spam${gate}))`,
      member: sql`jsonb_build_object('total',count(*) FILTER (WHERE mem${gate}))`,
    };
  };
  const fixed = received(rollingFrom === null ? undefined : sql`in_absolute`);
  const roll = received(sql`in_rolling`);
  // Group sent rows in one pass. Unknown kinds collapse to one excluded bucket, exactly as the
  // public two-kind count excludes them; an invalid status in a counted kind fails validation.
  // For incoming messages, group the eligible message's links once by PK. The administrator's
  // retainedMail test requires a real live box unless lifecycle is default. The member's
  // visibleLinks test requires a workspace link, no hold, and no expired box (liveBox).
  const live = sql`(${mailboxes.deleteAfter} IS NULL OR ${mailboxes.deleteAfter}>statement_timestamp())`;
  const { rows } = await db.execute(sql`
    WITH ${bounds}${sentRegionSize}grouped AS MATERIALIZED (${sentGroups}), witness AS (
      SELECT ${messages.id},${messages.spam} AS spam,${receivedBands}
        ${messages.lifecycle}='default' OR coalesce(bool_or(${mailboxes.id} IS NOT NULL AND ${live}),false) AS adm,
        coalesce(bool_or(${eq(links.workspaceId, workspaceId)} AND ${links.heldReason} IS NULL AND ${live}),false) AS mem
      FROM ${messages} LEFT JOIN ${links} ON ${links.messageId}=${messages.id}
        LEFT JOIN ${mailboxes} ON ${mailboxes.id}=${links.mailboxId}
      WHERE ${eq(messages.workspaceId, workspaceId)} AND ${messages.direction}='inbound' AND ${scopedRange(messages.receivedAt, messages.region)}
      GROUP BY ${messages.id}
    )
    SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf",
      ${sent(sql`n`)} AS sent, ${fixed.admin} AS admin, ${fixed.member} AS member${rollingFrom === null ? sql`` : sql`,
      jsonb_build_object('from',to_char(${rollingFrom} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sent',${sent(sql`rolling_n`)},'admin',${roll.admin},'member',${roll.member}) AS rolling`}
    FROM witness`);
  const row = rows.length === 1 ? rows[0] : undefined;
  const invalid = () => new Error('Invalid log facet source result');
  if (period === undefined) {
    const cut = parseLogFacetCut(row);
    if (!cut) throw invalid();
    return { cut };
  }
  const parsed = WithRolling.safeParse(row);
  if (!parsed.success) throw invalid();
  const { rolling: { from: rollingStart, ...rollingCounts }, ...cut } = parsed.data;
  const rollingCut = { asOf: cut.asOf, ...rollingCounts };
  const expectedStart = Math.floor(Date.parse(cut.asOf) / 60_000) * 60_000 - periodHours[period] * 3_600_000;
  if (!consistent(cut) || !consistent(rollingCut) || Date.parse(rollingStart) !== expectedStart) throw invalid();
  return { cut, rolling: { period, from: rollingStart, cut: rollingCut } };
}
