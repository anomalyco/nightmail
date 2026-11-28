import { sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './core.js';

const SOURCE_PAGE = 2048, CHANGE_PACKETS = 128;
type Coverage = { generation:string; floor:string; after_at:string|null; after_id:string|null; done:boolean;
  tail:string|null; xmax:string|null; retired:boolean };

/** One short worker transaction per workspace. This lock is never acquired by a mail writer. */
export async function lockFacetCoverage(db:DbExecutor, workspace:string) {
  const {rows:[lock]}=await db.execute<{held:boolean}>(sql`SELECT
    set_config('lock_timeout','150ms',true),set_config('statement_timeout','2s',true),
    pg_try_advisory_xact_lock(712008,hashtext(${workspace})) held`);
  if (!lock?.held) return null;
  const {rows:[c]}=await db.execute<Coverage>(sql`SELECT generation,covered_from::text AS floor,
    sent_after_at::text AS after_at,sent_after_id AS after_id,sent_done AS done,
    sent_tail_snapshot::text AS tail,sent_seed_xmax::text AS xmax,sent_witnesses_retired AS retired
    FROM log_facet_coverage WHERE workspace_id=${workspace} FOR NO KEY UPDATE SKIP LOCKED`);
  return c??null;
}

/** Call with a delta(region, minute, band, status, n) CTE. Bulk upsert in established key order on
 * private accumulator rows only. Do not clamp a partial result or publish it as a certified cut. */
export function mergeFacetCells(workspace:string,generation:string) {
  return sql`merged AS (
    INSERT INTO log_facet_buckets(workspace_id,generation,grain,bucket_at,region,band,status,n)
    SELECT ${workspace},${generation},g.grain,g.bucket_at,coalesce(d.region,''),d.band,d.status,sum(d.n)::bigint
    FROM delta d CROSS JOIN LATERAL (VALUES ('minute',d.minute),('hour',date_trunc('hour',d.minute,'UTC'))) g(grain,bucket_at)
    GROUP BY 3,4,5,6,7 HAVING sum(d.n)<>0 ORDER BY 3,4,5,6,7
    ON CONFLICT(workspace_id,generation,grain,bucket_at,region,band,status)
    DO UPDATE SET n=log_facet_buckets.n+excluded.n)`;
}

/** Seed at most one indexed source page and remember its actual MVCC snapshot in the SAME
 * transaction. A restart repeats at most an uncommitted page, even if every timestamp is equal. */
export async function seedSentFacetPage(db:Database,workspace:string,limit=SOURCE_PAGE) {
  if (!Number.isInteger(limit)||limit<1||limit>SOURCE_PAGE) throw new RangeError('Invalid Logs seed page size');
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c||c.done)return null;
    const after=c.after_at===null ? sql`` : sql`AND (created_at,id)>(${c.after_at}::timestamptz,${c.after_id}::text)`;
    const {rows:[result]}=await tx.execute<{read:number;done:boolean}>(sql`WITH page AS MATERIALIZED (
      SELECT id,created_at,region,snapshot->>'kind' AS kind,status FROM sending_emails
      WHERE workspace_id=${workspace} AND created_at>=${c.floor}::timestamptz ${after}
      ORDER BY created_at,id LIMIT ${limit}
    ), edge AS MATERIALIZED (SELECT created_at,id FROM page ORDER BY created_at DESC,id DESC LIMIT 1),
    size AS MATERIALIZED (SELECT count(*)::int AS n FROM page),
    delta AS (SELECT region,date_trunc('minute',created_at,'UTC') AS minute,kind AS band,status,count(*)::bigint AS n
      FROM page WHERE kind IN ('marketing','transactional') GROUP BY 1,2,3,4),
    ${mergeFacetCells(workspace,c.generation)}, witness AS (
      INSERT INTO log_facet_sent_seeds(workspace_id,generation,high_at,high_id,seed_snapshot)
      SELECT ${workspace},${c.generation},created_at,id,pg_current_snapshot() FROM edge)
    UPDATE log_facet_coverage SET sent_after_at=coalesce((SELECT created_at FROM edge),sent_after_at),
      sent_after_id=coalesce((SELECT id FROM edge),sent_after_id),sent_done=size.n<${limit},
      sent_tail_snapshot=CASE WHEN size.n<${limit} THEN pg_current_snapshot() END,
      sent_seed_xmax=CASE WHEN size.n<${limit} THEN pg_snapshot_xmax(pg_current_snapshot()) END
      FROM size WHERE workspace_id=${workspace} AND generation=${c.generation}
      RETURNING size.n AS read,sent_done AS done`);
    return result??null;
  },{isolationLevel:'repeatable read'});
}

/** A visible journal row isn't necessarily newer than the source page. Its top-level XID and
 * exact (source_at,id) say whether that page already includes the change. New transactions after
 * a completed seed take the packet's signed total directly, without inspecting individual IDs. */
export async function drainSentFacetPackets(db:Database,workspace:string,limit=CHANGE_PACKETS) {
  if (!Number.isInteger(limit)||limit<1||limit>CHANGE_PACKETS) throw new RangeError('Invalid Logs change batch');
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c)return null;
    const eligible=c.done ? sql`` : c.after_at===null ? sql`AND source_at<${c.floor}::timestamptz`
      : sql`AND (source_at,sent_ids[1])<=(${c.after_at}::timestamptz,${c.after_id}::text)`;
    const order=c.done ? sql`id` : sql`source_at,sent_ids[1],id`;
    const fast=c.retired ? sql`true` : c.xmax ? sql`writer_xid>=${c.xmax}::xid8` : sql`false`;
    const {rows:[result]}=await tx.execute<{packets:number;remaining_partial:number}>(sql`WITH chosen AS MATERIALIZED (
      SELECT id,writer_xid,region,minute,source_at,kind,status,delta,sent_ids,
        (source_at<${c.floor}::timestamptz OR ${fast}) AS direct FROM log_facet_changes
      WHERE workspace_id=${workspace} AND source='sent' ${eligible}
      ORDER BY ${order} LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), keys AS MATERIALIZED (
      SELECT p.id,p.delta,k.mail_id,coalesce(w.seed_snapshot,${c.tail}::pg_snapshot) AS seed,p.writer_xid
      FROM (SELECT * FROM chosen WHERE NOT direct) p CROSS JOIN LATERAL unnest(p.sent_ids) k(mail_id)
      LEFT JOIN LATERAL (SELECT s.seed_snapshot FROM log_facet_sent_seeds s
        WHERE s.workspace_id=${workspace} AND s.generation=${c.generation} AND (s.high_at,s.high_id)>=(p.source_at,k.mail_id)
        ORDER BY s.high_at,s.high_id LIMIT 1) w ON true
    ), decisions AS MATERIALIZED (
      SELECT id,CASE WHEN source_at<${c.floor}::timestamptz THEN 0 ELSE delta END::bigint AS add_n,ARRAY[]::text[] AS keep FROM chosen WHERE direct
      UNION ALL
      SELECT id,coalesce(sum(sign(delta)) FILTER (WHERE seed IS NOT NULL AND NOT pg_visible_in_snapshot(writer_xid,seed)),0)::bigint,
        coalesce(array_agg(mail_id ORDER BY mail_id) FILTER (WHERE seed IS NULL),ARRAY[]::text[])
      FROM keys GROUP BY id
    ), delta AS (SELECT p.region,p.minute,p.kind AS band,p.status,d.add_n AS n FROM decisions d JOIN chosen p USING(id) WHERE d.add_n<>0),
    ${mergeFacetCells(workspace,c.generation)}, consumed AS (
      DELETE FROM log_facet_changes j USING decisions d WHERE j.id=d.id AND cardinality(d.keep)=0),
    remainder AS (
      UPDATE log_facet_changes j SET sent_ids=d.keep,delta=sign(j.delta)::bigint*cardinality(d.keep)
      FROM decisions d WHERE j.id=d.id AND cardinality(d.keep)>0 AND cardinality(d.keep)<cardinality(j.sent_ids))
    SELECT count(*)::int AS packets,count(*) FILTER (WHERE cardinality(keep)>0)::int AS remaining_partial FROM decisions`);
    return result??null;
  },{isolationLevel:'repeatable read'});
}

/** Only retire snapshot witnesses once no older in-flight XID can appear AND no previously
 * committed visible packet still needs one. Physical cleanup is independently page bounded. */
export async function retireSentSeedWitnesses(db:Database,workspace:string) {
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c?.done||!c.xmax)return 0;
    if(!c.retired){
      const can=await tx.execute(sql`UPDATE log_facet_coverage SET sent_witnesses_retired=true,sent_tail_snapshot=NULL
        WHERE workspace_id=${workspace} AND generation=${c.generation} AND pg_snapshot_xmin(pg_current_snapshot())>=sent_seed_xmax
          AND NOT EXISTS(SELECT 1 FROM log_facet_changes WHERE workspace_id=${workspace} AND source='sent' AND writer_xid<sent_seed_xmax)
        RETURNING 1`);
      if(!can.rowCount)return 0;
    }
    const deleted=await tx.execute(sql`WITH page AS MATERIALIZED (
      SELECT high_at,high_id FROM log_facet_sent_seeds WHERE workspace_id=${workspace} AND generation=${c.generation}
      ORDER BY high_at,high_id LIMIT 1024)
      DELETE FROM log_facet_sent_seeds s USING page p WHERE s.workspace_id=${workspace} AND s.generation=${c.generation}
        AND (s.high_at,s.high_id)=(p.high_at,p.high_id)`);
    return deleted.rowCount??0;
  },{isolationLevel:'repeatable read'});
}
