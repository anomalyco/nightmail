import { sql } from 'drizzle-orm';
import { z } from 'zod';

// The lines the list-risk measure (src/list-risk.ts) bands an audience by. They come only from the private setting
// NIGHTMAIL_LIST_RISK (JSON, e.g. {"FLAGGED_SOURCE":{"elevated":0.1,"high":0.2}}); without it the measure records its
// shares and no band. Shares are fractions of the sampled audience; RECENT_BLOCKLIST is a count.
export const LIST_RISK_FACTORS = ['FLAGGED_SOURCE', 'DEAD_DOMAINS', 'UNENGAGED', 'NEVER_MAILED', 'LAST_SEND_BOUNCES', 'LAST_SEND_COMPLAINTS', 'RECENT_BLOCKLIST'] as const;
export type ListRiskFactor = (typeof LIST_RISK_FACTORS)[number];
const Line = z.object({ elevated: z.number().nonnegative().optional(), high: z.number().nonnegative().optional() }).strict();
export const ListRiskLines = z.object(Object.fromEntries(LIST_RISK_FACTORS.map(f => [f, Line.optional()])) as Record<ListRiskFactor, z.ZodOptional<typeof Line>>).strict();
export type ListRiskLines = z.infer<typeof ListRiskLines>;
/** The setting's lines, or null when it is unset or not valid JSON of this shape. */
export function parseListRiskLines(raw: unknown): ListRiskLines | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return ListRiskLines.parse(JSON.parse(raw)); } catch { return null; }
}

/** What the send review said at launch, kept beside the measure so the two can be compared with what happened. */
export type ReviewAtLaunch = { verdict: string; required: string | null; reasons: string[] };
/** The job a launch queues in its own transaction: a marketing campaign to a list. */
// A minute after the launch: never ahead of the campaign's own first job, and the list hardly changes in a minute.
export const queueListRisk = (workspaceId: string, campaignId: string, reviewId: string, listId: string, review: ReviewAtLaunch | null = null) => sql`INSERT INTO jobs (id, workspace_id, type, payload, available_at)
  VALUES (${'list-risk:' + reviewId}, ${workspaceId}, 'audience.listRisk', ${JSON.stringify({ workspaceId, campaignId, reviewId, listId, review })}::jsonb, now() + interval '1 minute') ON CONFLICT (id) DO NOTHING`;
