import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { errors, response, security, type App } from './core.js';
import { BOUNCE_CLASSES, blocklistNamed, bounceClass, type BounceClass } from './delivery-history.js';
import { LIST_RISK_FACTORS } from './list-risk-lines.js';
import { operatorActor } from './operator.js';

// Operator → Lists: each recent marketing campaign to a list, with the list-risk measure its launch recorded
// (src/list-risk.ts), what the send review said then, and what happened: delivery, bounces by class, complaints, replies
// naming a blocklist and the list probe. For staff to judge the measure against outcomes before it decides anything.
// Shares and counts only: never an address, a domain or a line the band was judged by.
const LIMITS = { page: 20, failures: 1_000, days: 90 } as const;
const Level = z.enum(['elevated', 'high']);
const Measure = z.object({ sampled: z.number().int(), exact: z.boolean(), band: z.enum(['low', 'elevated', 'high']).nullable(),
  factors: z.array(z.object({ code: z.enum(LIST_RISK_FACTORS), level: Level })), values: z.record(z.string(), z.number()),
  counts: z.object({ flagged: z.number().int(), deadDomains: z.number().int(), unengaged: z.number().int(), unengagedBase: z.number().int(), neverMailed: z.number().int(),
    softFailing: z.number().int(), proven: z.number().int().optional() }) });
const ListRow = z.object({
  campaignId: z.string(), campaignName: z.string(), workspaceId: z.string(), workspaceName: z.string(), launchedAt: z.string(), recipients: z.number().int(), state: z.string(),
  measure: Measure.nullable().describe('Recorded at launch; null for a launch from before the measure, or while its job is pending.'),
  review: z.object({ verdict: z.string(), required: z.string().nullable(), reasons: z.array(z.string()) }).nullable().describe('What the send review said at launch; null before it was kept.'),
  outcome: z.object({ accepted: z.number().int(), delivered: z.number().int(), bounced: z.number().int(), complained: z.number().int(),
    probe: z.enum(['passed', 'quarantined', 'none']), pauseCode: z.string().nullable(),
    failures: z.object({ read: z.number().int().describe('Failed messages read: at most 1,000, and their feedback is kept 30 days.'),
      classes: z.record(z.enum(BOUNCE_CLASSES), z.number().int()), blocklistReplies: z.number().int() }) }),
}).openapi('OperatorListRow');
type Failures = { read: number; classes: Record<BounceClass, number>; blocklistReplies: number };
type Row = { id: string; name: string; workspace_id: string; workspace_name: string; launched_at: string; total: number; state: string; pause_code: string | null;
  probe_cleared: boolean; list_risk: Record<string, unknown> | null; accepted: number; delivered: number; bounced: number; complained: number };
const measureOf = (risk: Record<string, unknown> | null) => { const parsed = risk ? Measure.safeParse(risk) : null; return parsed?.success ? parsed.data : null; };
function reviewOf(risk: Record<string, unknown> | null) {
  const review = risk?.review as { verdict?: unknown; required?: unknown; reasons?: unknown } | null | undefined;
  if (!review || typeof review.verdict !== 'string') return null;
  return { verdict: review.verdict, required: typeof review.required === 'string' ? review.required : null,
    reasons: Array.isArray(review.reasons) ? review.reasons.filter((x): x is string => typeof x === 'string') : [] };
}

export function registerOperatorLists(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/lists', operationId: 'operatorListLists',
    request: { query: z.object({ cursor: z.string().max(120).regex(/^\d{13}\|[A-Za-z0-9_-]{1,80}$/).optional(), limit: z.coerce.number().int().min(1).max(50).default(LIMITS.page) }) },
    responses: { 200: response(z.object({ data: z.array(ListRow), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), [afterMs, afterId] = q.cursor?.split('|') ?? [];
    const launched = sql`date_trunc('milliseconds', r.created_at)`;
    const { rows } = await c.env.db.execute<Row>(sql`SELECT c.id, coalesce(c.draft->>'name', c.id) AS name, c.workspace_id, coalesce(w.name, c.workspace_id) AS workspace_name,
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS launched_at, c.total, c.state, c.pause_reason->>'code' AS pause_code,
        c.probe_cleared_at IS NOT NULL AS probe_cleared, r.list_risk, t.accepted, t.delivered, t.bounced, t.complained
      FROM sending_campaigns c JOIN sending_campaign_reviews r ON r.id = c.review_id AND r.workspace_id = c.workspace_id LEFT JOIN workspaces w ON w.id = c.workspace_id
      CROSS JOIN LATERAL (SELECT coalesce(sum(accepted), 0)::int AS accepted, coalesce(sum(delivered), 0)::int AS delivered, coalesce(sum(bounced), 0)::int AS bounced,
          coalesce(sum(complained), 0)::int AS complained
        FROM sending_campaign_tallies t WHERE t.workspace_id = c.workspace_id AND t.campaign_id = c.id AND NOT t.simulated) t
      WHERE NOT c.simulated AND c.list_id IS NOT NULL AND coalesce((c.draft->>'requiredNotice')::boolean, false) = false AND r.created_at > now() - make_interval(days => ${LIMITS.days})
        ${afterMs ? sql`AND (${launched}, c.id) < (to_timestamp(${Number(afterMs)} / 1000.0), ${afterId})` : sql``}
      ORDER BY ${launched} DESC, c.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    // Each campaign's failed mail (bounced, delayed, dropped by SES), at most LIMITS.failures, with its latest feedback.
    const failures = new Map<string, Failures>(page.map(row => [row.id, { read: 0, classes: Object.fromEntries(BOUNCE_CLASSES.map(k => [k, 0])) as Record<BounceClass, number>, blocklistReplies: 0 }]));
    if (page.length) {
      const { rows: failed } = await c.env.db.execute<{ campaign_id: string; type: string; sub_type: string | null; status: string | null; diagnostic: string | null }>(sql`SELECT u.id AS campaign_id,
          f.type, f.sub_type, f.status, f.diagnostic
        FROM unnest(${sql.param(page.map(row => row.id))}::text[], ${sql.param(page.map(row => row.workspace_id))}::text[]) AS u(id, w)
        CROSS JOIN LATERAL (SELECT v.type, v.sub_type, v.status, v.diagnostic FROM sending_emails e
          CROSS JOIN LATERAL (SELECT v.type, v.data->>'bounceSubType' AS sub_type,
              coalesce(v.data->>'status', v.data #>> '{bounce,bouncedRecipients,0,status}', v.data #>> '{deliveryDelay,delayedRecipients,0,status}') AS status,
              coalesce(v.data->>'diagnosticCode', v.data #>> '{bounce,bouncedRecipients,0,diagnosticCode}', v.data #>> '{deliveryDelay,delayedRecipients,0,diagnosticCode}') AS diagnostic
            FROM sending_email_events v WHERE v.workspace_id = e.workspace_id AND v.email_id = e.id
              AND v.type IN ('bounce', 'non_permanent_bounce', 'validation_suppressed', 'delivery_delay') ORDER BY v.created_at DESC LIMIT 1) v
          WHERE e.workspace_id = u.w AND e.campaign_id = u.id AND e.status IN ('bounced', 'delayed', 'suppressed') LIMIT ${LIMITS.failures}) f`);
      for (const row of failed) {
        const sum = failures.get(row.campaign_id)!;
        sum.read++;
        sum.classes[bounceClass({ type: row.type, subType: row.sub_type, status: row.status, diagnostic: row.diagnostic })]++;
        if (blocklistNamed(row.diagnostic)) sum.blocklistReplies++;
      }
    }
    const last = page.at(-1);
    return c.json({ data: page.map(row => ({ campaignId: row.id, campaignName: row.name, workspaceId: row.workspace_id, workspaceName: row.workspace_name, launchedAt: row.launched_at,
      recipients: row.total, state: row.state, measure: measureOf(row.list_risk), review: reviewOf(row.list_risk),
      outcome: { accepted: row.accepted, delivered: row.delivered, bounced: row.bounced, complained: row.complained,
        probe: row.pause_code === 'LIST_QUALITY' ? 'quarantined' as const : row.probe_cleared ? 'passed' as const : 'none' as const, pauseCode: row.pause_code,
        failures: failures.get(row.id)! } })),
      nextCursor: rows.length > q.limit && last ? `${Date.parse(last.launched_at)}|${last.id}` : null }, 200);
  });
}
