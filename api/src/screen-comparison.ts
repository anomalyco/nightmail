import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Database } from './core/types.js';

// The operator's reading of screen_comparisons (src/screen-shadow.ts, migration 452): the content screen's requests beside
// the same requests repeated to the second classifier. Everything here comes from that one table, by created_at.

const Count = z.number().int();
const Quantiles = z.object({ requests: Count.describe('Requests that were made and timed.'), p50: z.number().nullable(), p95: z.number().nullable(), p99: z.number().nullable() });
const Agreement = z.object({ compared: Count.describe('Both classifiers answered.'), bothFlag: Count, bothPass: Count,
  jevFlagJevfPass: Count.describe('Jev was at or above its cutoff, JevF below its own.'),
  jevPassJevfFlag: Count.describe('Jev was below its cutoff, JevF at or above its own.') });
const Tokens = z.object({ reported: Count.describe('Requests whose answer reported input tokens.'), total: Count, mean: z.number().nullable(), max: Count.nullable() });
const Hour = z.object({ calls: Count.describe('Requests made.'), rateLimited: Count, timeouts: Count, errors: Count.describe('Every other failure: network, another HTTP status, an invalid answer.'),
  rateLimitedRate: z.number().nullable(), timeoutRate: z.number().nullable(), errorRate: z.number().nullable() });
export const ScreenComparison = z.object({
  since: z.string(), until: z.string(),
  configured: z.boolean().describe('Whether this installation is running JevF shadow comparisons.'),
  counts: z.object({ pairs: Count.describe('Requests the screen made, each with what became of its repeat.'), digests: Count.describe('Distinct messages and campaign copies.'),
    email: Count, campaignTest: Count, campaignCopy: Count, jevAnswered: Count, jevfAnswered: Count, bothAnswered: Count }),
  coverage: z.object({ called: Count.describe('Requests repeated to the second classifier.'), answered: Count, refusedTooLarge: Count.describe('Refused as over its input limit.'),
    skippedBreaker: Count, skippedRateLimited: Count, skippedBacklog: Count,
    lost: Count.describe('Its queue message was delivered again and no row had been written: never asked a second time.'),
    answeredShare: z.number().nullable().describe('Of the screen\'s requests, the share the second classifier answered.') }),
  outcomes: z.object({ jev: z.record(z.string(), Count), jevf: z.record(z.string(), Count) }),
  agreement: z.object({ threshold: z.object({ min: z.number().nullable(), max: z.number().nullable() }).describe('The Jev thresholds in force on the compared requests.'),
    requests: Agreement, messages: Agreement.describe('Per message or campaign copy whose every request both answered: the highest score of each, as the screen decides.') }),
  scoreDifference: z.object({ mean: z.number().nullable().describe('Second classifier minus screen.'), meanAbsolute: z.number().nullable(), p50Absolute: z.number().nullable(), p95Absolute: z.number().nullable(), p99Absolute: z.number().nullable(),
    histogram: z.array(z.object({ from: z.number(), to: z.number(), count: Count })).describe('Second classifier minus screen, in steps of 0.1 from -1 to 1; empty steps are left out.') }),
  latencyMs: z.object({ jev: Quantiles, jevf: Quantiles }),
  tokens: z.object({ jev: Tokens, jevf: Tokens, jevOver4096: Count.describe('Screen requests of more than 4,096 input tokens.') }),
  hourly: z.array(z.object({ hour: z.string(), pairs: Count, jev: Hour, jevf: Hour.extend({ skipped: Count.describe('Not asked, or lost.'), refusedTooLarge: Count }) })).describe('Newest first, at most 168 hours.'),
  disagreements: z.array(z.object({ at: z.string(), pairId: z.string(), kind: z.string(), workspaceId: z.string().nullable(), emailId: z.string().nullable(), campaignId: z.string().nullable(),
    digest: z.string(), window: Count, windows: Count, threshold: z.number(), jevScore: z.number(), jevfScore: z.number(), jevModel: z.string().nullable(), jevfModel: z.string().nullable(),
    jevfRequestId: z.string().nullable() })).describe('The 50 most recent requests the two decided differently: IDs and digests, never content.'),
});

const STATEMENT_MS = 20000, HOURS = 168, RECENT = 50;
const rate = (n: number, of: number) => of ? n / of : null;
const number = (value: unknown) => value === null || value === undefined ? null : Number(value);

export async function screenComparison(db: Database, since: Date, configured: boolean): Promise<z.infer<typeof ScreenComparison>> {
  const from = since.toISOString();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout',${String(STATEMENT_MS)},true)`);
    const { rows: [t] } = await tx.execute<Record<string, unknown>>(sql`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS until,count(*)::int AS pairs,count(DISTINCT digest)::int AS digests,
      count(*) FILTER (WHERE kind='email')::int AS email,count(*) FILTER (WHERE kind='campaign_test')::int AS campaign_test,count(*) FILTER (WHERE kind='campaign_copy')::int AS campaign_copy,
      count(*) FILTER (WHERE jev_outcome='ok')::int AS jev_ok,count(*) FILTER (WHERE jevf_outcome='ok')::int AS jevf_ok,count(*) FILTER (WHERE jev_outcome='ok' AND jevf_outcome='ok')::int AS both_ok,
      count(*) FILTER (WHERE jevf_outcome NOT LIKE 'skipped%' AND jevf_outcome<>'lost')::int AS called,count(*) FILTER (WHERE jevf_outcome='refused_too_large')::int AS refused,count(*) FILTER (WHERE jevf_outcome='lost')::int AS lost,
      count(*) FILTER (WHERE jevf_outcome='skipped_breaker')::int AS skipped_breaker,count(*) FILTER (WHERE jevf_outcome='skipped_rate_limited')::int AS skipped_rate_limited,
      count(*) FILTER (WHERE jevf_outcome='skipped_backlog')::int AS skipped_backlog,
      count(*) FILTER (WHERE jev_flagged AND jevf_flagged)::int AS both_flag,count(*) FILTER (WHERE NOT jev_flagged AND NOT jevf_flagged)::int AS both_pass,
      count(*) FILTER (WHERE jev_flagged AND NOT jevf_flagged)::int AS jev_only,count(*) FILTER (WHERE NOT jev_flagged AND jevf_flagged)::int AS jevf_only,
      min(threshold) FILTER (WHERE jev_flagged IS NOT NULL AND jevf_flagged IS NOT NULL) AS threshold_min,max(threshold) FILTER (WHERE jev_flagged IS NOT NULL AND jevf_flagged IS NOT NULL) AS threshold_max,
      avg(jevf_score-jev_score) AS diff,avg(abs(jevf_score-jev_score)) AS diff_abs,percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY abs(jevf_score-jev_score)) AS diff_q,
      count(jev_ms)::int AS jev_timed,percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY jev_ms) AS jev_q,
      count(jevf_ms)::int AS jevf_timed,percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY jevf_ms) AS jevf_q,
      count(jev_input_tokens)::int AS jev_tokens_n,coalesce(sum(jev_input_tokens),0)::float8 AS jev_tokens,avg(jev_input_tokens)::float8 AS jev_tokens_avg,max(jev_input_tokens) AS jev_tokens_max,
      count(jevf_input_tokens)::int AS jevf_tokens_n,coalesce(sum(jevf_input_tokens),0)::float8 AS jevf_tokens,avg(jevf_input_tokens)::float8 AS jevf_tokens_avg,max(jevf_input_tokens) AS jevf_tokens_max,
      count(*) FILTER (WHERE jev_input_tokens>4096)::int AS jev_over
      FROM screen_comparisons WHERE created_at>=${from}::timestamptz`);
    const outcomes = (await tx.execute<{ jev: string; jevf: string; n: number }>(sql`SELECT jev_outcome AS jev,jevf_outcome AS jevf,count(*)::int AS n FROM screen_comparisons WHERE created_at>=${from}::timestamptz GROUP BY 1,2`)).rows;
    const { rows: [m] } = await tx.execute<Record<string, unknown>>(sql`SELECT count(*)::int AS compared,count(*) FILTER (WHERE jev AND jevf)::int AS both_flag,count(*) FILTER (WHERE NOT jev AND NOT jevf)::int AS both_pass,
      count(*) FILTER (WHERE jev AND NOT jevf)::int AS jev_only,count(*) FILTER (WHERE NOT jev AND jevf)::int AS jevf_only
      FROM (SELECT bool_or(jev_flagged) AS jev,bool_or(jevf_flagged) AS jevf FROM screen_comparisons
        WHERE created_at>=${from}::timestamptz AND jev_flagged IS NOT NULL AND jevf_flagged IS NOT NULL
        GROUP BY workspace_id,kind,coalesce(email_id,campaign_id),digest HAVING count(DISTINCT window_index)>=max(windows)) message`);
    const histogram = (await tx.execute<{ step: number; n: number }>(sql`SELECT least(width_bucket(jevf_score-jev_score,-1,1,20),20) AS step,count(*)::int AS n FROM screen_comparisons
      WHERE created_at>=${from}::timestamptz AND jev_score IS NOT NULL AND jevf_score IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
    const hours = (await tx.execute<Record<string, unknown>>(sql`SELECT to_char(date_trunc('hour',created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour,count(*)::int AS pairs,
      count(*) FILTER (WHERE jev_outcome='http_429')::int AS jev_limited,count(*) FILTER (WHERE jev_outcome='timeout')::int AS jev_timeouts,
      count(*) FILTER (WHERE jev_outcome NOT IN ('ok','http_429','timeout'))::int AS jev_errors,
      count(*) FILTER (WHERE jevf_outcome NOT LIKE 'skipped%' AND jevf_outcome<>'lost')::int AS jevf_calls,count(*) FILTER (WHERE jevf_outcome LIKE 'skipped%' OR jevf_outcome='lost')::int AS jevf_skipped,
      count(*) FILTER (WHERE jevf_outcome='rate_limited')::int AS jevf_limited,count(*) FILTER (WHERE jevf_outcome='timeout')::int AS jevf_timeouts,
      count(*) FILTER (WHERE jevf_outcome='refused_too_large')::int AS jevf_refused,
      count(*) FILTER (WHERE jevf_outcome NOT IN ('ok','rate_limited','timeout','refused_too_large','lost') AND jevf_outcome NOT LIKE 'skipped%')::int AS jevf_errors
      FROM screen_comparisons WHERE created_at>=${from}::timestamptz GROUP BY date_trunc('hour',created_at) ORDER BY date_trunc('hour',created_at) DESC LIMIT ${HOURS}`)).rows;
    const recent = (await tx.execute<Record<string, unknown>>(sql`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,pair_id,kind,workspace_id,email_id,campaign_id,digest,window_index,windows,
      threshold,jev_score,jevf_score,jev_model,jevf_model,jevf_request_id FROM screen_comparisons
      WHERE created_at>=${from}::timestamptz AND jev_flagged<>jevf_flagged ORDER BY created_at DESC,id DESC LIMIT ${RECENT}`)).rows;
    const n = (key: string) => Number(t?.[key] ?? 0), q = (key: string, i: number) => number((t?.[key] as unknown[] | null)?.[i]);
    const by = (side: 'jev' | 'jevf') => { const counts: Record<string, number> = {}; for (const row of outcomes) counts[row[side]] = (counts[row[side]] ?? 0) + row.n; return counts; };
    const agreement = (row: Record<string, unknown> | undefined, compared: number) => ({ compared, bothFlag: Number(row?.both_flag ?? 0), bothPass: Number(row?.both_pass ?? 0), jevFlagJevfPass: Number(row?.jev_only ?? 0), jevPassJevfFlag: Number(row?.jevf_only ?? 0) });
    const hour = (calls: number, limited: number, timeouts: number, errors: number) => ({ calls, rateLimited: limited, timeouts, errors, rateLimitedRate: rate(limited, calls), timeoutRate: rate(timeouts, calls), errorRate: rate(errors, calls) });
    return {
      since: from, until: String(t?.until ?? new Date().toISOString()), configured,
      counts: { pairs: n('pairs'), digests: n('digests'), email: n('email'), campaignTest: n('campaign_test'), campaignCopy: n('campaign_copy'), jevAnswered: n('jev_ok'), jevfAnswered: n('jevf_ok'), bothAnswered: n('both_ok') },
      coverage: { called: n('called'), answered: n('jevf_ok'), refusedTooLarge: n('refused'), skippedBreaker: n('skipped_breaker'), skippedRateLimited: n('skipped_rate_limited'), skippedBacklog: n('skipped_backlog'), lost: n('lost'), answeredShare: rate(n('jevf_ok'), n('pairs')) },
      outcomes: { jev: by('jev'), jevf: by('jevf') },
      agreement: { threshold: { min: number(t?.threshold_min), max: number(t?.threshold_max) }, requests: agreement(t, n('both_flag') + n('both_pass') + n('jev_only') + n('jevf_only')), messages: agreement(m, Number(m?.compared ?? 0)) },
      scoreDifference: { mean: number(t?.diff), meanAbsolute: number(t?.diff_abs), p50Absolute: q('diff_q', 0), p95Absolute: q('diff_q', 1), p99Absolute: q('diff_q', 2),
        histogram: histogram.map(row => ({ from: Math.round((-1 + (row.step - 1) * 0.1) * 10) / 10, to: Math.round((-1 + row.step * 0.1) * 10) / 10, count: row.n })) },
      latencyMs: { jev: { requests: n('jev_timed'), p50: q('jev_q', 0), p95: q('jev_q', 1), p99: q('jev_q', 2) }, jevf: { requests: n('jevf_timed'), p50: q('jevf_q', 0), p95: q('jevf_q', 1), p99: q('jevf_q', 2) } },
      tokens: { jev: { reported: n('jev_tokens_n'), total: n('jev_tokens'), mean: number(t?.jev_tokens_avg), max: number(t?.jev_tokens_max) }, jevf: { reported: n('jevf_tokens_n'), total: n('jevf_tokens'), mean: number(t?.jevf_tokens_avg), max: number(t?.jevf_tokens_max) }, jevOver4096: n('jev_over') },
      hourly: hours.map(row => { const c = (key: string) => Number(row[key] ?? 0); return { hour: String(row.hour), pairs: c('pairs'), jev: hour(c('pairs'), c('jev_limited'), c('jev_timeouts'), c('jev_errors')),
        jevf: { ...hour(c('jevf_calls'), c('jevf_limited'), c('jevf_timeouts'), c('jevf_errors')), skipped: c('jevf_skipped'), refusedTooLarge: c('jevf_refused') } }; }),
      disagreements: recent.map(row => ({ at: String(row.at), pairId: String(row.pair_id), kind: String(row.kind), workspaceId: row.workspace_id as string | null, emailId: row.email_id as string | null, campaignId: row.campaign_id as string | null,
        digest: String(row.digest), window: Number(row.window_index), windows: Number(row.windows), threshold: Number(row.threshold), jevScore: Number(row.jev_score), jevfScore: Number(row.jevf_score),
        jevModel: row.jev_model as string | null, jevfModel: row.jevf_model as string | null, jevfRequestId: row.jevf_request_id as string | null })),
    };
  });
}
