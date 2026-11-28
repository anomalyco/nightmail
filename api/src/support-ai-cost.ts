import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './core/types.js';
import { SUPPORT_AI } from './health-thresholds.js';

// What the support AI costs. Every model call's cost reaches Nightmail one of two ways, and each lands here as a row of
// support_ai_usage (migration 576):
//  - the answering agent's (chat and email, support/src/conversation.ts) with its conversation's counters, which the
//    support platform mirrors after its turns (support-inbox.ts operatorMirrorSupportState): the row is what they grew by;
//  - the feedback triage agent's (support/src/triage.ts) after it reads a report (feedback-triage.ts).
// Glass adds the rows up (supportAiSql), and the health tick compares today's total with SUPPORT_AI.dailyLineUsd.

export type AiAgent = 'support' | 'triage';
/** One row of spend: a conversation's model turns and their cost. Nothing is written for zero. */
export function recordAiUsage(tx: DbExecutor, usage: { conversationId: string; agent: AiAgent; turns: number; costUsd: number }) {
  const turns = Math.max(0, Math.trunc(usage.turns)), cost = Math.max(0, usage.costUsd);
  if (!turns && !(cost > 0)) return Promise.resolve();
  return tx.execute(sql`INSERT INTO support_ai_usage (conversation_id, agent, turns, cost_usd) VALUES (${usage.conversationId}, ${usage.agent}, ${turns}, ${cost}::numeric)`);
}

/** Since UTC midnight: what the health tick compares with the daily line. */
export const aiCostToday = sql`(SELECT coalesce(sum(cost_usd),0)::float8 FROM support_ai_usage WHERE at>=date_trunc('day',now(),'UTC'))`;

const TOP = 3;
const period = (since: SQL) => sql`(SELECT json_build_object('costUsd',coalesce(sum(cost_usd),0)::float8,'turns',coalesce(sum(turns),0)::int,'conversations',count(DISTINCT conversation_id)::int)
  FROM support_ai_usage WHERE at>=${since})`;
/**
 * Glass's view of the spend, one JSON value: today (UTC), the last 7 and 30 days with the conversations and turns behind
 * each, each of the last 30 UTC days, the conversations the AI answered in those 30 days and what they cost, and the
 * conversations that cost the most in them. A conversation is answered when the answering agent spent on it in those 30
 * days and an agent message of it reached the customer (the inbox's own rule, support-inbox.ts reached). The totals, the
 * days and the most expensive include the triage agent's spend; the answered ones' cost doesn't (it answers nobody), nor
 * conversations the AI never answered.
 */
export const supportAiSql = (reached: SQL) => sql`(SELECT json_build_object('line',${SUPPORT_AI.dailyLineUsd}::float8,
    'today',${period(sql`date_trunc('day',now(),'UTC')`)},'week',${period(sql`now()-interval '7 days'`)},'month',${period(sql`now()-interval '30 days'`)},
    'daily',(SELECT coalesce(json_agg(coalesce(d.cost,0) ORDER BY g.day),'[]') FROM generate_series(date_trunc('day',now(),'UTC')-interval '29 days',date_trunc('day',now(),'UTC'),interval '1 day') g(day)
      LEFT JOIN (SELECT date_trunc('day',at,'UTC') AS day,sum(cost_usd)::float8 AS cost FROM support_ai_usage WHERE at>=date_trunc('day',now(),'UTC')-interval '29 days' GROUP BY 1) d ON d.day=g.day),
    'answered',(SELECT json_build_object('n',count(*)::int,'costUsd',coalesce(sum(u.cost),0)::float8)
      FROM (SELECT conversation_id,sum(cost_usd) AS cost FROM support_ai_usage WHERE at>=now()-interval '30 days' AND agent='support' AND conversation_id IS NOT NULL GROUP BY 1) u
      WHERE EXISTS (SELECT FROM support_messages o WHERE o.conversation_id=u.conversation_id AND o.author='agent' AND ${reached})),
    'top',(SELECT coalesce(json_agg(json_build_object('id',t.conversation_id,'channel',c.channel,'workspace',CASE WHEN w.id IS NOT NULL THEN json_build_object('id',w.id,'name',w.name) END,
        'costUsd',t.cost,'turns',t.turns) ORDER BY t.cost DESC,t.conversation_id),'[]')
      FROM (SELECT conversation_id,sum(cost_usd)::float8 AS cost,sum(turns)::int AS turns FROM support_ai_usage WHERE at>=now()-interval '30 days' AND conversation_id IS NOT NULL
        GROUP BY 1 HAVING sum(cost_usd)>0 ORDER BY 2 DESC,1 LIMIT ${TOP}) t
      LEFT JOIN support_conversations c ON c.id=t.conversation_id LEFT JOIN workspaces w ON w.id=c.workspace_id)))`;
