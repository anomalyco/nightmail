import { sql } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import { statementTimedOut } from './core/http.js';
import type { DbExecutor, JobHandler } from './core/types.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { displayEvidenceColumns, displayScoreId, displayScoreView, DISPLAY_SCORE_ID_PREFIX, DISPLAY_SCORE_JOB, type SenderScore } from './sender-score.js';
import type { DayEvidence, DomainAuth } from './standing-model.js';

export const DISPLAY_DISCOVERY_JOB = 'maintenance.discoverSenderDisplayScore';
const DISCOVERY_ID = 'maintenance:sender-display-discovery';
const PAGE_ROWS = 8_000, MIN_ROWS = 64, CLAIM_ROWS = 128, DISCOVERY_ROWS = 64;
const PAGE_STEPS = 4, STEP_MS = 1_800, BETWEEN_TURNS_MS = 1_000, BUSY_RETRY_MS = 5_000, REFRESH_MS = 60 * 60_000;
const aged = (ms: number) => new Date(Date.now() + ms).toISOString();
const lower = sql`date_trunc('day',statement_timestamp(),'UTC') - interval '29 days'`;
const limits = sql`SELECT set_config('statement_timeout','1000ms',true), set_config('lock_timeout','150ms',true)`;

type Cursor = { id: string; at: string };
type Bins = Record<string, number>;
type SummaryAuth = { emails: number; dkim: boolean | null; mailFrom: boolean | null; dmarc: string | null };
type Pass = {
  since: string; asOf: string; fence: Cursor | null; after?: Cursor; mailDone?: boolean;
  days: Record<string, DayEvidence>; weighted: Bins; claimAfter?: string; claims: Bins;
};
type State = { version: 1; run: string; size?: number; pass?: Pass; view?: SenderScore };
const fresh = (): State => ({ version: 1, run: crypto.randomUUID() });

const currentAuth = sql`identity #>> '{ses,DkimAttributes,Status}'='SUCCESS' AND identity #>> '{ses,DkimAttributes,SigningEnabled}'='true' AS dkim,
  identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS' AS "mailFrom",
  identity #>> '{dmarc,status}' AS dmarc`;
function add(bins: Bins, { emails, dkim, mailFrom, dmarc }: SummaryAuth) {
  // Twelve equivalence classes: the legacy auth model uses only these booleans and the three DMARC weights.
  const k = Number(!!dkim) * 8 + Number(!!mailFrom) * 4 + (dmarc === 'none' ? 1 : dmarc === 'quarantine' || dmarc === 'reject' ? 2 : 0);
  bins[k] = (bins[k] ?? 0) + emails;
}
function authInputs(bins: Bins): DomainAuth[] {
  return Object.entries(bins).map(([k, emails]) => ({ name: k, emails, dkim: !!(Number(k) & 8),
    mailFrom: !!(Number(k) & 4), dmarc: Number(k) & 2 ? 'reject' : Number(k) & 1 ? 'none' : null }));
}

/** Page raw rows before filtering, detoasting, or doing recipient/host work. Keep leading timestamp
 * bounds explicit as well as the tuple bounds so a deep cursor is a seek, not a date-prefix walk. */
export function displayScorePage(wid: string, since: string, fence: Cursor, after?: Cursor, size = PAGE_ROWS) {
  return sql`WITH page AS MATERIALIZED (
    SELECT id,created_at,status,error_code,event_outcomes,provider_id,campaign_id,from_address,simulated,
      to_addresses,cc_addresses,bcc_addresses,snapshot
    FROM sending_emails WHERE workspace_id=${wid}
      AND created_at>=${since}::timestamptz AND created_at<=${fence.at}::timestamptz
      AND (created_at,id)<=(${fence.at}::timestamptz,${fence.id})
      ${after ? sql`AND created_at>=${after.at}::timestamptz AND (created_at,id)>(${after.at}::timestamptz,${after.id})` : sql``}
    ORDER BY created_at,id LIMIT ${size}
  ), mail AS MATERIALIZED (
    SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
      status,error_code,event_outcomes,provider_id,campaign_id,
      CASE WHEN campaign_id IS NOT NULL THEN 'marketing' ELSE snapshot->>'kind' END AS kind,
      lower(substring(from_address from '@([A-Za-z0-9.-]+)')) AS domain
    FROM page WHERE NOT simulated AND CASE
      WHEN jsonb_typeof(to_addresses)='array' AND jsonb_typeof(cc_addresses)='array' AND jsonb_typeof(bcc_addresses)='array'
        AND (lower(to_addresses->>0) NOT LIKE '%@simulator.amazonses.com'
          OR lower(cc_addresses->>0) NOT LIKE '%@simulator.amazonses.com'
          OR lower(bcc_addresses->>0) NOT LIKE '%@simulator.amazonses.com') THEN true
      ELSE hosted_real_cost(to_addresses||cc_addresses||bcc_addresses)>0 END
  ), days AS (
    SELECT day,${displayEvidenceColumns} FROM mail GROUP BY day
  ), hosts AS (
    SELECT string_to_array(domain,'.') AS labels,count(*)::int AS n FROM mail WHERE domain IS NOT NULL GROUP BY 1
  ), matches AS (
    SELECT d.dkim,d."mailFrom",d.dmarc,sum(h.n)::int AS emails
    FROM hosts h CROSS JOIN LATERAL generate_subscripts(h.labels,1) AS suffix(i)
    CROSS JOIN LATERAL (SELECT ${currentAuth} FROM domain_claims WHERE workspace_id=${wid}
      AND name=array_to_string(h.labels[i:],'.') AND sending_state='verified' LIMIT 1) d
    GROUP BY 1,2,3
  )
  SELECT (SELECT json_build_object('at',created_at::text,'id',id) FROM page ORDER BY created_at DESC,id DESC LIMIT 1) AS cursor,
    (SELECT coalesce(json_agg(days),'[]') FROM days) AS days,(SELECT coalesce(json_agg(matches),'[]') FROM matches) AS auth`;
}

async function makePass(db: DbExecutor, wid: string): Promise<Pass> {
  const {rows:[r]} = await db.execute<{ since: string; at: string; fence: Cursor | null }>(sql`SELECT
    (${lower})::text AS since,statement_timestamp()::text AS at,
    (SELECT json_build_object('at',created_at::text,'id',id) FROM sending_emails
      WHERE workspace_id=${wid} AND created_at>=${lower} ORDER BY created_at DESC,id DESC LIMIT 1) AS fence`);
  return { since: r!.since, asOf: r!.at, fence: r!.fence, days: {}, weighted: {}, claims: {} };
}

async function advance(db: DbExecutor, wid: string, pass: Pass, size: number) {
  if (pass.fence && !pass.mailDone) {
    const {rows:[page]} = await db.execute<{ cursor: Cursor | null; days: DayEvidence[]; auth: SummaryAuth[] }>(
      displayScorePage(wid, pass.since, pass.fence, pass.after, size));
    for (const item of page!.days) {
      const existing = pass.days[item.day];
      if (existing) {
        for (const key of Object.keys(item) as (keyof DayEvidence)[]) if (key !== 'day') existing[key] += item[key];
      } else pass.days[item.day] = item;
    }
    for (const item of page!.auth) add(pass.weighted, item);
    if (page!.cursor && (page!.cursor.id !== pass.fence.id || page!.cursor.at !== pass.fence.at)) pass.after = page!.cursor;
    else pass.mailDone = true;
  }
  if (pass.fence && !pass.mailDone) return;
  if (!Object.keys(pass.weighted).length) {
    // With no observed mail from any verified From domain, the model weighs verified domains equally.
    const {rows} = await db.execute<SummaryAuth & { name: string; verified: boolean }>(sql`
      SELECT name,sending_state='verified' AS verified,${currentAuth},1 AS emails FROM domain_claims
      WHERE workspace_id=${wid} AND name>${pass.claimAfter ?? ''} ORDER BY name LIMIT ${CLAIM_ROWS}`);
    for (const row of rows) if (row.verified) add(pass.claims, row);
    if (rows.length === CLAIM_ROWS) { pass.claimAfter = rows.at(-1)!.name; return; }
  }
  return displayScoreView(Object.values(pass.days), authInputs(Object.keys(pass.weighted).length ? pass.weighted : pass.claims), new Date(pass.asOf));
}

export const senderDisplayScoreJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (job.id !== displayScoreId(job.workspaceId) || payload.version !== 1 || typeof payload.run !== 'string')
    throw new ApiError(500,'JOB_PAYLOAD_INVALID','Invalid sender display score job.');
  // The published view stays readable during checkpointing. The real job settlement, not the handler, atomically
  // stores the new payload under its lease and run fence. No work sent from an expired lease can overwrite it.
  const previous = payload as State, state = structuredClone(previous);
  const wid = job.workspaceId;
  let attempt: 'defer' | 'retire' | 'published' | 'progress';
  try {
    attempt = await runtime.db.transaction(async tx => {
      await tx.execute(limits);
      // Bound aggregate read pressure across workers. No product writer takes this lock.
      const {rows:[token]} = await tx.execute<{ held: boolean }>(sql`SELECT pg_try_advisory_xact_lock(275813, 6) AS held`);
      if (!token?.held) return 'defer';
      const {rows:[eligible]} = await tx.execute<{ ok: boolean }>(sql`SELECT EXISTS(SELECT FROM workspaces WHERE id=${wid})
        AND NOT EXISTS(SELECT FROM sender_standing WHERE workspace_id=${wid}) AS ok`);
      if (!eligible?.ok) return 'retire';
      const end = Date.now() + STEP_MS;
      state.pass ??= await makePass(tx, wid);
      for (let i=0;i<PAGE_STEPS && Date.now()<end;i++) {
        const view = await advance(tx, wid, state.pass, state.size ?? PAGE_ROWS);
        if (view) {
          state.view = view;
          delete state.pass;
          delete state.size;
          return 'published';
        }
      }
      return 'progress';
    }, { accessMode:'read only' });
  } catch (error) {
    if (!statementTimedOut(error)) throw error;
    // A one-second cancellation doesn't discard earlier checkpoints or pin the front of the shared queue.
    if ((previous.size ?? PAGE_ROWS) <= MIN_ROWS) throw error;
    throw new JobDeferred(aged(BETWEEN_TURNS_MS), { ...previous, size: Math.max(MIN_ROWS, Math.floor((previous.size ?? PAGE_ROWS)/2)) });
  }
  if (attempt === 'retire') return; // completed rows are not published and are eligible for existing job retention
  if (attempt === 'defer') throw new JobDeferred(aged(BUSY_RETRY_MS),previous);
  throw new JobDeferred(aged(attempt === 'published' ? REFRESH_MS : BETWEEN_TURNS_MS),state);
});

/** Seed/recover one genuinely scheduled and fenced scanner. Uses its own durable job payload for the workspace cursor. */
export async function ensureSenderDisplayDiscovery(db: DbExecutor) {
  await db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload)
    VALUES(${DISCOVERY_ID},${DISCOVERY_ID},${DISPLAY_DISCOVERY_JOB},${JSON.stringify({run:crypto.randomUUID(),after:''})}::jsonb)
    ON CONFLICT(id) DO UPDATE SET status='pending', attempts=0, payload=excluded.payload, available_at=now(),lease_until=NULL,last_error=NULL
    WHERE jobs.type=excluded.type AND jobs.workspace_id=excluded.workspace_id AND jobs.status='failed'
      AND jobs.available_at<=now()-interval '5 minutes'`);
}

export const senderDisplayDiscoveryJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (job.id !== DISCOVERY_ID || job.workspaceId !== DISCOVERY_ID || typeof payload.after !== 'string' || typeof payload.run !== 'string')
    throw new ApiError(500,'JOB_PAYLOAD_INVALID','Invalid sender display discovery job.');
  const next = await runtime.db.transaction(async tx => {
    await tx.execute(limits);
    const {rows:[result]} = await tx.execute<{ next: string }>(sql`WITH page AS MATERIALIZED (
      SELECT id FROM workspaces WHERE id>${payload.after as string} ORDER BY id LIMIT ${DISCOVERY_ROWS}
    ), ready AS (
      INSERT INTO jobs(id,workspace_id,type,payload)
      SELECT ${DISPLAY_SCORE_ID_PREFIX}||p.id,p.id,${DISPLAY_SCORE_JOB},${JSON.stringify(fresh())}::jsonb FROM page p
      WHERE (SELECT 1 FROM sender_standing WHERE workspace_id=p.id LIMIT 1) IS NULL
        AND ((SELECT 1 FROM sending_emails WHERE workspace_id=p.id AND created_at>=${lower}
          ORDER BY created_at DESC,id DESC LIMIT 1) IS NOT NULL
          OR (SELECT 1 FROM domain_claims WHERE workspace_id=p.id LIMIT 1) IS NOT NULL)
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,
        payload=CASE WHEN jobs.status='failed' AND jobs.payload->>'version'='1'
          THEN jobs.payload||jsonb_build_object('run',excluded.payload->>'run') ELSE excluded.payload END
      WHERE jobs.type=excluded.type AND jobs.workspace_id=excluded.workspace_id
        AND (jobs.status='completed' OR (jobs.status='failed' AND jobs.available_at<=now()-interval '1 hour'))
    ) SELECT CASE WHEN count(*)=${DISCOVERY_ROWS} THEN max(id) ELSE '' END AS next FROM page`);
    return result!.next;
  });
  throw new JobDeferred(aged(next ? BETWEEN_TURNS_MS : 60_000), { run:payload.run, after:next });
});
