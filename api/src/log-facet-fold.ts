import { sql } from 'drizzle-orm';
import { ApiError, databaseCodeOf } from './core/errors.js';
import { budgetedRead, digest, rowId } from './core/http.js';
import { log } from './log.js';
import type { DbExecutor, JobHandler, Runtime } from './core/types.js';
import { parseLogFacetCut, readLogFacetGeneration, type LogFacetCut, type LogFacetPeriod } from './log-facet-source.js';

// Historical reads use a durable, stamped certificate. An unconditional refresh waits for a cut
// that starts after enrollment; a 24h display poll can explicitly accept a recent, same-anchor cut.
const TYPE = 'logs.facetFold', SNAPSHOT = 'logs.facetSnapshot';
const SLOTS = Array.from({ length: 4 }, (_, n) => 'job_logfacets_slot_' + n);
const MAX_PER_WORKSPACE = 3, SOURCE_SECONDS = 12;
export const LOG_FACET_TICK_MS = 1_000, LOG_FACET_WAIT_MS = 30_000;
const HOLD_SECONDS = 45, LEASE_SECONDS = 18, GENERIC_BACKSTOP_SECONDS = 120;
const POLL_REUSE_SECONDS = 60;
const periods = { '24h': 1_440, '7d': 10_080, '30d': 43_200 } as const;
export const logFacetPeriod = (value: unknown): LogFacetPeriod | undefined =>
  value === '24h' || value === '7d' || value === '30d' ? value : undefined;
type Published = { version: 1; period: LogFacetPeriod; region: string | null; from: string; cut: LogFacetCut; absolute?: { from: string; cut: LogFacetCut } };
const snapshotId = async (workspaceId:string, region:string|null, period:LogFacetPeriod) =>
  'job_logfacets_snapshot_' + await digest(JSON.stringify([1,workspaceId,region,period]));
function canonicalLower(period:LogFacetPeriod, cut:LogFacetCut, from:string) {
  const stamp=Date.parse(cut.asOf);
  return Number.isFinite(stamp) && from===new Date((Math.floor(stamp/60_000)-periods[period])*60_000).toISOString();
}
// One PK lookup; never inspect worker slots or raw history on the initial dashboard display.
// A distinct certificate per actual workspace, selected region and rolling interval survives slot reuse.
export async function readPublishedLogFacet(db:DbExecutor, workspaceId:string, region:string|null, period:LogFacetPeriod) {
  const key=await snapshotId(workspaceId,region,period);
  const {rows:[row]}=await db.execute<{payload:Published}>(sql`SELECT payload FROM jobs WHERE id=${key}
    AND type=${SNAPSHOT} AND workspace_id=${workspaceId} AND status='completed'`);
  const p=row?.payload;
  if (!p || p.version !== 1 || p.period !== period || p.region !== region || typeof p.from !== 'string') return null;
  const cut=parseLogFacetCut(p.cut);
  return cut && canonicalLower(period,cut,p.from) ? {cut,from:p.from} : null;
}
/** Display polls reuse only their exact absolute lower bound, at the original source time. Never
 * substitute the rolling cut for a different anchor, even if both are described as "24h". */
export async function readRecent24hFacet(db:DbExecutor, workspaceId:string, region:string|null, from:string) {
  const key=await snapshotId(workspaceId,region,'24h');
  const {rows:[r]}=await db.execute<{payload:Published}>(sql`SELECT payload FROM jobs WHERE id=${key}
    AND workspace_id=${workspaceId} AND type=${SNAPSHOT} AND status='completed'
    AND (payload#>>'{cut,asOf}') COLLATE "C" BETWEEN
      to_char((statement_timestamp()-${POLL_REUSE_SECONDS}*interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      AND to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  const p=r?.payload;
  if (!p || p.version!==1 || p.period!=='24h' || p.region!==region) return null;
  const rolling=parseLogFacetCut(p.cut);
  if (!rolling || !canonicalLower('24h',rolling,p.from)) return null;
  if (p.from===from) return rolling;
  const cut=p.absolute?.from===from ? parseLogFacetCut(p.absolute.cut) : null;
  return cut?.asOf===rolling.asOf ? cut : null;
}
export type FacetTicket = { slot: string; run: string; workspaceId: string; generation: number; wake: boolean; waiting: boolean };
type Payload = { run: string; from: string; region: string | null; period?: LogFacetPeriod; wanted: number; sealed: number; published: number; cut?: LogFacetCut };
const unavailable = () => new ApiError(503, 'FACET_CATCHUP_UNAVAILABLE', 'Exact Logs counts are temporarily unavailable.', undefined, true);
const capacity = () => new ApiError(503, 'FACET_FOLD_CAPACITY', 'The exact Logs count slots are busy.', undefined, true);
// Older servers update created_at on admission but don't register or release waiters. If one joined
// this run, or a process died while waiting, retain the old bounded grace rather than strand its ticket.
const tracked = sql`jobs.payload->'joinedAt' = to_jsonb(extract(epoch FROM jobs.created_at))`;
export const reusableLogFacetSlot = sql`jobs.status IN ('completed','failed') AND
  (coalesce(${tracked} AND jobs.payload->>'waiting'='0',false) OR jobs.created_at < statement_timestamp()-${HOLD_SECONDS}*interval '1 second')`;

// Four short, indexed control rows across the installation. The only table used is the existing
// durable jobs table. Admission and publication never lock a source mail row or a sender queue.
export async function enrollLogFacet(runtime: Runtime, workspaceId: string, from: string, region: string | null, period?: LogFacetPeriod, waiting=true): Promise<FacetTicket> {
  return (await enroll(runtime,workspaceId,from,region,period,waiting,false))!;
}
// A null ticket asks the HTTP caller to repeat its authorized snapshot read. The fold may have
// published between its quick read and admission (including while the window was being sized).
export function enroll24hPoll(runtime:Runtime, workspaceId:string, from:string, region:string|null) {
  return enroll(runtime,workspaceId,from,region,'24h',true,true);
}
async function enroll(runtime:Runtime, workspaceId:string, from:string, region:string|null, period:LogFacetPeriod|undefined, waiting:boolean, poll:boolean) {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('lock_timeout','200ms',true),set_config('statement_timeout','1000ms',true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712006, 1)`);
    const { rows } = await tx.execute<{ id:string; workspace_id:string; type:string; status:string; payload:Payload; cold:boolean }>(sql`
      SELECT id,workspace_id,type,status,payload,(${reusableLogFacetSlot}) AS cold
      FROM jobs WHERE id=ANY(${sql.param(SLOTS)}::text[]) ORDER BY id`);
    if (rows.some(r => r.type !== TYPE)) throw unavailable();
    const match = rows.find(r => r.workspace_id === workspaceId && r.payload.from === from && r.payload.region === region && r.payload.period === period);
    if (poll) {
      // Serialize only with this matched worker's publication. The admission lock prevents another
      // scope from displacing its slot while we recheck the durable certificate.
      if (match) await tx.execute(sql`SELECT id FROM jobs WHERE id=${match.id} FOR NO KEY UPDATE`);
      if (await readRecent24hFacet(tx,workspaceId,region,from)) return null;
    }
    if (match) {
      // Evaluate these fields on the current row, not on the earlier SELECT: a worker can have
      // sealed/published in between. No reader advances a generation that is already waiting.
      const { rows:[ticket] } = await tx.execute<{ run:string; generation:number; wake:boolean }>(sql`
        WITH prior AS MATERIALIZED (
          SELECT id AS chosen,status AS old_status FROM jobs WHERE id=${match.id} AND workspace_id=${workspaceId}
            AND type=${TYPE} AND payload->>'run'=${match.payload.run} FOR NO KEY UPDATE
        )
        UPDATE jobs SET payload=jsonb_set(CASE WHEN ${tracked} THEN payload || jsonb_build_object(
            'waiting',(payload->>'waiting')::int+${waiting?1:0}::int,'joinedAt',extract(epoch FROM statement_timestamp()))
          ELSE payload-'waiting'-'joinedAt' END,'{wanted}',to_jsonb(CASE WHEN ${poll}::boolean AND old_status IN ('pending','running')
            THEN (payload->>'wanted')::int ELSE greatest((payload->>'wanted')::int,(payload->>'sealed')::int+1) END)),
          created_at=statement_timestamp(),status=CASE WHEN old_status IN ('completed','failed') THEN 'pending' ELSE old_status END,
          available_at=CASE WHEN old_status IN ('completed','failed') THEN statement_timestamp()+${GENERIC_BACKSTOP_SECONDS}*interval '1 second' ELSE available_at END,
          attempts=CASE WHEN old_status IN ('completed','failed') THEN 0 ELSE attempts END,
          last_error=CASE WHEN old_status IN ('completed','failed') THEN NULL ELSE last_error END
        FROM prior WHERE id=prior.chosen
        RETURNING payload->>'run' AS run,(payload->>'wanted')::int AS generation,old_status IN ('completed','failed') AS wake`);
      if (!ticket) throw unavailable();
      return {slot:match.id,run:ticket.run,workspaceId,generation:ticket.generation,wake:ticket.wake,waiting};
    }
    if (rows.filter(r => !r.cold && r.workspace_id === workspaceId).length >= MAX_PER_WORKSPACE) throw capacity();
    const slot = SLOTS.find(id => !rows.some(r => r.id === id)) ?? rows.find(r => r.cold)?.id;
    if (!slot) throw capacity();
    const run = rowId('fold'), payload:Payload={ run,from,region,...period && {period},wanted:1,sealed:0,published:0 };
    const write=await tx.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload,status,available_at,created_at)
      VALUES(${slot},${workspaceId},${TYPE},${JSON.stringify(payload)}::jsonb || jsonb_build_object('waiting',${waiting?1:0}::int,
        'joinedAt',extract(epoch FROM statement_timestamp())),'pending',statement_timestamp()+${GENERIC_BACKSTOP_SECONDS}*interval '1 second',statement_timestamp())
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,payload=excluded.payload,status='pending',attempts=0,
        last_error=NULL,lease_until=NULL,created_at=statement_timestamp(),available_at=excluded.available_at
      WHERE jobs.type=${TYPE} AND (${reusableLogFacetSlot})
      RETURNING id`);
    if (!write.rowCount) throw capacity();
    return {slot,run,workspaceId,generation:1,wake:true,waiting};
  }).catch((error:unknown)=>{
    // Only this short admission transaction: its lock/statement deadlines mean the fold
    // couldn't be enrolled. The independent source-size budget still refuses with 422.
    const code=databaseCodeOf(error);
    if(code==='55P03'||code==='57014')throw capacity();
    throw error;
  });
}

/** Only the calling request releases its admission, once, including on cancellation or loss of
 * access. A late release cannot decrement a replacement run. A lost release expires via the grace. */
export async function releaseLogFacetTicket(db:DbExecutor,t:FacetTicket) {
  if (!t.waiting) return;
  t.waiting=false;
  try {
    await db.execute(sql`UPDATE jobs SET payload=jsonb_set(payload,'{waiting}',to_jsonb((payload->>'waiting')::int-1))
      WHERE id=${t.slot} AND workspace_id=${t.workspaceId} AND type=${TYPE} AND payload->>'run'=${t.run} AND (payload->>'waiting')::int>0`);
  } catch { log('warn',{code:'LOG_FACET_RELEASE_FAILED',jobId:t.slot}); }
}

// Only the dedicated worker takes a source snapshot; ordinary mail orchestration can re-arm a missed nudge.
// The seal commits BEFORE taking the actual source snapshot. A writer, reader, or other workspace
// cannot extend that snapshot. Publication preserves any already-enrolled next generation atomically.
async function runSealed(runtime:Runtime, slot:string, workspaceId:string, fence:string) {
  const own = sql`id=${slot} AND type=${TYPE} AND workspace_id=${workspaceId} AND status='running' AND lease_until=${fence}::timestamptz`;
  const { rows:[sealed] }=await runtime.db.execute<{ run:string; g:number; from:string; region:string|null; period:string|null }>(sql`
    UPDATE jobs SET payload=jsonb_set(payload,'{sealed}',payload->'wanted') WHERE ${own}
    RETURNING payload->>'run' AS run,(payload->>'sealed')::int AS g,payload->>'from' AS "from",payload->>'region' AS region,payload->>'period' AS period`);
  if (!sealed) return false;
  const still = sql`${own} AND payload->>'run'=${sealed.run} AND (payload->>'sealed')::int=${sealed.g}`;
  try {
    const period=logFacetPeriod(sealed.period);
    const {cut,rolling}=await budgetedRead(runtime.db, tx => readLogFacetGeneration(tx,workspaceId,sealed.from,sealed.region,period),
      { seconds:SOURCE_SECONDS,refusal:unavailable });
    if (period && (!rolling || period !== rolling.period || rolling.cut.asOf !== cut.asOf ||
      !canonicalLower(period,rolling.cut,rolling.from))) throw unavailable();
    // Publication of both forms is one transaction. A stale lease cannot publish either; a slower
    // fold for another absolute anchor in this same period cannot overwrite a newer historical cut.
    const remember = !rolling ? sql`` : sql`, remembered AS (
      INSERT INTO jobs(id,workspace_id,type,payload,status) SELECT ${await snapshotId(workspaceId,sealed.region,rolling.period)},
        ${workspaceId},${SNAPSHOT},${JSON.stringify({version:1,period:rolling.period,region:sealed.region,from:rolling.from,cut:rolling.cut,
          ...(rolling.period==='24h' && rolling.from!==sealed.from && {absolute:{from:sealed.from,cut}})} satisfies Published)}::jsonb,'completed' FROM published
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=statement_timestamp()
      WHERE jobs.workspace_id=excluded.workspace_id AND jobs.type=excluded.type AND jobs.status='completed'
        AND jobs.payload->'region'=excluded.payload->'region' AND jobs.payload->>'period'=excluded.payload->>'period'
        AND ((jobs.payload#>>'{cut,asOf}') COLLATE "C") < ((excluded.payload#>>'{cut,asOf}') COLLATE "C")
    )`;
    const { rows:[published] }=await runtime.db.execute<{ status:string }>(sql`WITH published AS (UPDATE jobs SET
      payload=payload || jsonb_build_object('published',${sealed.g}::int,'cut',${JSON.stringify(cut)}::jsonb),
      status=CASE WHEN (payload->>'wanted')::int>${sealed.g} THEN 'pending' ELSE 'completed' END,
      lease_until=NULL,available_at=statement_timestamp()+${GENERIC_BACKSTOP_SECONDS}*interval '1 second',
      last_error=NULL,attempts=0 WHERE ${still} RETURNING status)${remember} SELECT status FROM published`);
    return published?.status === 'pending';
  } catch (error) {
    // This is a failure to produce a number, never a success deadline or an exact zero.
    await runtime.db.execute(sql`UPDATE jobs SET status='failed',lease_until=NULL,last_error='FACET_SOURCE_UNAVAILABLE' WHERE ${still}`);
    log('warn',{code:'LOG_FACET_FOLD_FAILED',workspaceId,jobId:slot});
    throw error;
  }
}
export const logFacetJob:JobHandler=async(runtime,_payload,job)=>{
  if(!SLOTS.includes(job.id)||!job.leaseFence) throw unavailable();
  // A missed wake or expired lease might reach the ordinary work queue. Re-arm it cheaply;
  // never make a send/feedback orchestration slot perform the expensive historical fold.
  const result=await runtime.db.execute(sql`UPDATE jobs SET status='pending',lease_until=NULL,attempts=0,
    available_at=statement_timestamp()+${GENERIC_BACKSTOP_SECONDS}*interval '1 second'
    WHERE id=${job.id} AND workspace_id=${job.workspaceId} AND type=${TYPE} AND status='running' AND lease_until=${job.leaseFence}::timestamptz RETURNING id`);
  if(result.rowCount)runtime.startLogFacetFold?.(job.id);
};

// At most one source reader per reserved slot. The lease fence protects restarts/late workers. In
// normal service a ticket is covered by this cut or its one successor; ongoing mail needs no drain.
export async function foldLogFacetSlot(runtime:Runtime, slot:string) {
  if(!SLOTS.includes(slot)) return;
  for(let pass=0;pass<2;pass++){
    const {rows:[claim]}=await runtime.db.execute<{workspace_id:string;fence:string}>(sql`UPDATE jobs SET status='running',attempts=attempts+1,
      lease_until=clock_timestamp()+${LEASE_SECONDS}*interval '1 second'
      WHERE id=${slot} AND type=${TYPE} AND (status='pending' OR (status='running' AND lease_until<=clock_timestamp()))
      RETURNING workspace_id,lease_until::text AS fence`);
    if(!claim || !await runSealed(runtime,slot,claim.workspace_id,claim.fence)) break;
  }
}
export async function dueLogFacetSlots(db:DbExecutor) {
  const {rows}=await db.execute<{id:string}>(sql`SELECT id FROM jobs WHERE id=ANY(${sql.param(SLOTS)}::text[]) AND type=${TYPE}
    AND (status='pending' OR (status='running' AND lease_until<=clock_timestamp())) ORDER BY id`);
  return rows.map(r=>r.id);
}
export async function readTicketCut(db:DbExecutor,t:FacetTicket):Promise<LogFacetCut|null> {
  const {rows:[r]}=await db.execute<{status:string;cut:LogFacetCut|null}>(sql`SELECT status,
    CASE WHEN (payload->>'published')::int>=${t.generation} THEN payload->'cut' END AS cut FROM jobs
    WHERE id=${t.slot} AND type=${TYPE} AND workspace_id=${t.workspaceId} AND payload->>'run'=${t.run}`);
  if(!r) throw unavailable();
  if(r.cut) return r.cut;
  if(r.status==='failed') throw unavailable();
  return null;
}
