import { sql } from 'drizzle-orm';
import type { DbExecutor } from './core/types.js';
import { parseLogFacetCut, type LogFacetCut, type LogFacetPeriod } from './log-facet-source.js';
import { captureFacetSignature, facetGenerationIntact } from './log-facet-aggregate-retention.js';

const hours:Record<LogFacetPeriod,number>={'24h':24,'7d':168,'30d':720};
const iso=(ms:number)=>new Date(ms).toISOString();
export const rollingFacetFrom=(asOf:string,period:LogFacetPeriod)=>iso(Math.floor(Date.parse(asOf)/60000)*60000-hours[period]*3600000);
const wholeHoursFrom=(from:string)=>iso(Math.ceil(Date.parse(from)/3600000)*3600000);
export const utcFacetStamp=(column:ReturnType<typeof sql>)=>sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type Cell={view:string;band:string;status:string;n:string};
type AggregateBands={from:string;cut:LogFacetCut;rolling:{from:string;cut:LogFacetCut}};
const empty=(asOf:string):LogFacetCut=>({asOf,sent:[],admin:{total:0,spam:0},member:{total:0}});
export async function hasFacetRegistry(db:DbExecutor) {
  return (await db.execute<{ready:boolean}>(sql`SELECT to_regclass('log_facet_rolling') IS NOT NULL AS ready`)).rows[0]?.ready===true;
}
/** 'off' without the complete capture; 'seeded' once the current intact generation has read its source history. */
export async function facetAggregateState(db:DbExecutor,workspace:string):Promise<'off'|'seeding'|'seeded'> {
  const signature=await captureFacetSignature(db);if(signature===null)return 'off';
  const {rows:[r]}=await db.execute<{seeded:boolean}>(sql`SELECT c.sent_done AND p.seeded AS seeded FROM log_facet_coverage c
    JOIN log_facet_generations g USING(workspace_id,generation) JOIN log_facet_inbound_progress p USING(workspace_id,generation)
    WHERE c.workspace_id=${workspace} AND g.capture_signature=${signature} AND ${facetGenerationIntact(workspace)}`);
  return r?.seeded===true?'seeded':'seeding';
}
export async function wakeFacetAggregate(db:DbExecutor,workspace:string) {
  await db.execute(sql`INSERT INTO log_facet_wakes(workspace_id) VALUES(${workspace}) ON CONFLICT(workspace_id) DO NOTHING`);
}
export async function readArchivedBucketFacet(db:DbExecutor,workspace:string,region:string|null,period:LogFacetPeriod) {
  const {rows:[r]}=await db.execute<{cut:LogFacetCut;stamp:string;from:string}>(sql`SELECT cut,${utcFacetStamp(sql`as_of`)} AS stamp,
    to_char(lower_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "from" FROM log_facet_rolling
    WHERE workspace_id=${workspace} AND region=${region??''} AND period=${period}`);
  if(!r)return null;
  const cut=parseLogFacetCut(r.cut);
  return cut && cut.asOf===r.stamp && r.from===rollingFacetFrom(cut.asOf,period) ? {cut,from:r.from} : null;
}
/** Only for an already certified transaction snapshot/generation. Two index ranges per distinct
 * bound: the partial hour's minute cells and the complete hours (including all future mail).
 * No source mail, memberships, or expanded change packets are read here. */
export async function readFacetBucketBands(db:DbExecutor,workspace:string,generation:string,region:string|null,
  period:LogFacetPeriod,from:string,asOf:string):Promise<AggregateBands> {
  const rolling=rollingFacetFrom(asOf,period),fixed=empty(asOf),other=from===rolling?fixed:empty(asOf);
  const extra=from===rolling?sql``:sql`,('rolling',${rolling}::timestamptz,${wholeHoursFrom(rolling)}::timestamptz)`;
  const inRegion=region===null?sql``:sql`AND region=${region}`;
  const {rows}=await db.execute<Cell>(sql`WITH bounds(view,start_at,whole_at) AS MATERIALIZED (
    VALUES ('absolute',${from}::timestamptz,${wholeHoursFrom(from)}::timestamptz)${extra}), parts AS (
    SELECT b.view,p.band,p.status,p.n FROM bounds b CROSS JOIN LATERAL (
      SELECT band,status,n FROM log_facet_buckets WHERE workspace_id=${workspace} AND generation=${generation} AND grain='hour'
        AND bucket_at>=b.whole_at ${inRegion} OFFSET 0) p
    UNION ALL SELECT b.view,p.band,p.status,p.n FROM bounds b CROSS JOIN LATERAL (
      SELECT band,status,n FROM log_facet_buckets WHERE workspace_id=${workspace} AND generation=${generation} AND grain='minute'
        AND bucket_at>=b.start_at AND bucket_at<b.whole_at ${inRegion} OFFSET 0) p)
    SELECT view,band,status,sum(n)::text AS n FROM parts GROUP BY view,band,status HAVING sum(n)<>0 ORDER BY view,band,status`);
  for(const row of rows){
    const c=row.view==='absolute'?fixed:other,n=Number(row.n);
    if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid certified Logs cell');
    if(row.band==='transactional'||row.band==='marketing')c.sent.push({kind:row.band,status:row.status,n});
    else if(row.band==='admin'&&(row.status==='received'||row.status==='spam')){c.admin.total+=n;if(row.status==='spam')c.admin.spam+=n;}
    else if(row.band==='member'&&row.status==='received')c.member.total+=n;
    else throw new Error('Unknown certified Logs cell');
  }
  if(!parseLogFacetCut(fixed)||!parseLogFacetCut(other))throw new Error('Invalid certified Logs matrix');
  return {from,cut:fixed,rolling:{from:rolling,cut:other}};
}

/** Reads never initialize the schema, write on a historical GET, or silently substitute an
 * uncertified accumulator. A partial pass removes certified_at in the same transaction as its edits. */
export async function readCertifiedRollingFacet(db:DbExecutor,workspace:string,region:string|null,period:LogFacetPeriod) {
  const {rows:[s]}=await db.execute<{generation:string;stamp:string;floor:string}>(sql`SELECT g.generation,
    ${utcFacetStamp(sql`g.certified_at`)} AS stamp,c.covered_from::text AS floor FROM log_facet_generations g
    JOIN log_facet_coverage c USING(workspace_id,generation) WHERE g.workspace_id=${workspace} AND g.certified_at IS NOT NULL
    AND ${facetGenerationIntact(workspace)}`);
  if(!s)return null;
  const from=rollingFacetFrom(s.stamp,period);
  if(Date.parse(from)<Date.parse(s.floor))return null;
  const {cut}=await readFacetBucketBands(db,workspace,s.generation,region,period,from,s.stamp);
  return {cut,from};
}

export type AggregateTicket={workspace:string;region:string|null;period:LogFacetPeriod;from:string;after:string};
export async function enrollAggregateFacet(db:DbExecutor,workspace:string,region:string|null,period:LogFacetPeriod,from:string):Promise<AggregateTicket> {
  const {rows:[r]}=await db.execute<{after:string}>(sql`WITH wake AS (
    INSERT INTO log_facet_wakes(workspace_id) VALUES(${workspace}) ON CONFLICT(workspace_id) DO NOTHING)
    INSERT INTO log_facet_demands(workspace_id,region,period,anchor,wanted_at,expires_at)
    VALUES(${workspace},${region??''},${period},${from}::timestamptz,statement_timestamp(),statement_timestamp()+interval '3 minutes')
    ON CONFLICT(workspace_id,region,period,anchor) DO UPDATE SET wanted_at=greatest(log_facet_demands.wanted_at,excluded.wanted_at),
      expires_at=greatest(log_facet_demands.expires_at,excluded.expires_at) RETURNING ${utcFacetStamp(sql`statement_timestamp()`)} AS "after"`);
  if(!r)throw new Error('Could not register Logs demand');
  return {workspace,region,period,from,after:r.after};
}
/** Caller reauthorizes in this same read snapshot before projecting a band's numbers. */
export async function readAggregateTicket(db:DbExecutor,t:AggregateTicket) {
  const {rows:[s]}=await db.execute<{cut:LogFacetCut;stamp:string}>(sql`SELECT r.cut,${utcFacetStamp(sql`r.as_of`)} AS stamp
    FROM log_facet_results r JOIN log_facet_generations g USING(workspace_id,generation) WHERE
    r.workspace_id=${t.workspace} AND r.region=${t.region??''} AND r.period=${t.period} AND r.anchor=${t.from}::timestamptz
    AND r.as_of>=${t.after}::timestamptz AND r.expires_at>statement_timestamp() AND ${facetGenerationIntact(t.workspace)}`);
  if(!s)return null;
  const c=parseLogFacetCut(s.cut);return c?.asOf===s.stamp?c:null;
}
export async function readRecentAggregateDay(db:DbExecutor,workspace:string,region:string|null,from:string) {
  const {rows:[s]}=await db.execute<{cut:LogFacetCut;stamp:string}>(sql`SELECT r.cut,${utcFacetStamp(sql`r.as_of`)} AS stamp
    FROM log_facet_results r JOIN log_facet_generations g USING(workspace_id,generation)
    WHERE r.workspace_id=${workspace} AND r.region=${region??''} AND r.period='24h' AND r.anchor=${from}::timestamptz
      AND r.as_of BETWEEN statement_timestamp()-interval '1 minute' AND statement_timestamp() AND ${facetGenerationIntact(workspace)}`);
  if(!s)return null;
  const c=parseLogFacetCut(s.cut);return c?.asOf===s.stamp?c:null;
}

/** Commit both exact lower bounds from the same certified source epoch. Later arrivals write
 * demand, not this result; they cannot extend a sealed epoch or overwrite a newer publication. */
export async function publishFacetBucketView(db:DbExecutor,workspace:string,generation:string,region:string|null,
  period:LogFacetPeriod,from:string,asOf:string,demand=true) {
  const {cut,rolling}=await readFacetBucketBands(db,workspace,generation,region,period,from,asOf);
  const result=demand?sql`WITH served AS (
    INSERT INTO log_facet_results(workspace_id,generation,region,period,anchor,as_of,cut,expires_at)
    VALUES(${workspace},${generation},${region??''},${period},${from}::timestamptz,${asOf}::timestamptz,${JSON.stringify(cut)}::jsonb,statement_timestamp()+interval '3 minutes')
    ON CONFLICT(workspace_id,region,period,anchor) DO UPDATE SET generation=excluded.generation,as_of=excluded.as_of,
      cut=excluded.cut,expires_at=excluded.expires_at WHERE log_facet_results.as_of<=excluded.as_of)`:sql``;
  await db.execute(sql`${result} INSERT INTO log_facet_rolling(workspace_id,region,period,generation,lower_at,as_of,cut)
    VALUES(${workspace},${region??''},${period},${generation},${rolling.from}::timestamptz,${asOf}::timestamptz,${JSON.stringify(rolling.cut)}::jsonb)
    ON CONFLICT(workspace_id,region,period) DO UPDATE SET generation=excluded.generation,lower_at=excluded.lower_at,
      as_of=excluded.as_of,cut=excluded.cut,published_at=statement_timestamp() WHERE log_facet_rolling.as_of<=excluded.as_of`);
  return cut;
}
