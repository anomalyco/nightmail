import { sql } from 'drizzle-orm';
import { rowId } from './core/http.js';
import type { Database, DbExecutor } from './core/types.js';

export const FACET_CHANGE_RETENTION_HOURS=24;
const GC_PAGE=512;
/** A disable/re-enable between ticks still changes the pg_trigger tuple XID; TRUNCATE or a
 * relation rewrite changes its filenode. Re-seed on either rather than silently trusting a gap. */
export async function captureFacetSignature(db:DbExecutor) {
  const {rows:[r]}=await db.execute<{installed:boolean;signature:string|null}>(sql`WITH sources(rel,tag,fn) AS (
    VALUES ('sending_emails','sent','log_facet_capture_sent'),('mail_messages','messages','log_facet_capture_messages'),
      ('mailbox_messages','links','log_facet_capture_links'),('mailboxes','boxes','log_facet_capture_mailboxes')),
    ops(op,bits,old_tab,new_tab) AS (VALUES ('insert',4,NULL::text,'facet_new'),('update',16,'facet_old','facet_new'),('delete',8,'facet_old',NULL::text))
    SELECT to_regclass('log_facet_rolling') IS NOT NULL AND to_regclass('log_facet_generations') IS NOT NULL AND count(t.oid)=12 AND bool_and(
      t.tgenabled IN ('O','A') AND t.tgtype=o.bits AND f.proname=s.fn AND t.tgoldtable::text IS NOT DISTINCT FROM o.old_tab
      AND t.tgnewtable::text IS NOT DISTINCT FROM o.new_tab) AS installed,
      string_agg(concat_ws(':',t.tgrelid,pg_relation_filenode(t.tgrelid),t.oid,t.xmin,f.oid,f.xmin),'|' ORDER BY s.rel,o.op) AS signature
    FROM sources s CROSS JOIN ops o LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(s.rel) AND t.tgname='zz_log_facet_'||s.tag||'_'||o.op
    LEFT JOIN pg_proc f ON f.oid=t.tgfoid`);
  return r?.installed?r.signature:null;
}
/** A gap in unresolved link/box lineage can affect another workspace; refuse certification of
 * every older generation in that case. Historical cuts remain honest at their previous stamp. */
export const facetGenerationIntact=(workspace:string)=>sql`g.born_at>coalesce((
  SELECT max(gap.lost_at) FROM log_facet_gaps gap WHERE (gap.scope_kind,gap.scope_key) IN
    (('install',''),('workspace',${workspace}))),'-infinity'::timestamptz)`;

/** Start a new generation after a real gap, without deleting mail or claiming that a partial
 * rebuild has any counts. The worker retires old private state separately in bounded pages. */
export async function ensureFacetGeneration(db:Database,workspace:string) {
  return db.transaction(async tx=>{
    const {rows:[held]}=await tx.execute<{held:boolean}>(sql`SELECT set_config('lock_timeout','150ms',true),
      set_config('statement_timeout','2s',true),pg_try_advisory_xact_lock(712008,hashtext(${workspace})) AS held`);
    if(!held?.held)return null;
    const signature=await captureFacetSignature(tx);if(!signature)return null;
    const {rows:[prior]}=await tx.execute<{generation:string;intact:boolean}>(sql`SELECT c.generation,
      coalesce(g.generation=c.generation AND g.capture_signature=${signature} AND ${facetGenerationIntact(workspace)},false) AS intact
      FROM log_facet_coverage c LEFT JOIN log_facet_generations g USING(workspace_id) WHERE c.workspace_id=${workspace}
      FOR NO KEY UPDATE OF c`);
    if(prior?.intact)return prior.generation;
    const next=rowId('facets');
    if(prior)await tx.execute(sql`INSERT INTO log_facet_retired_generations(workspace_id,generation) VALUES(${workspace},${prior.generation})
      ON CONFLICT(workspace_id,generation) DO NOTHING`);
    await tx.execute(sql`INSERT INTO log_facet_coverage(workspace_id,generation,covered_from)
      VALUES(${workspace},${next},date_trunc('hour',statement_timestamp(),'UTC')-interval '768 hours')
      ON CONFLICT(workspace_id) DO UPDATE SET generation=excluded.generation,covered_from=excluded.covered_from,
        sent_after_at=NULL,sent_after_id=NULL,sent_done=false,sent_tail_snapshot=NULL,sent_seed_xmax=NULL,sent_witnesses_retired=false`);
    await tx.execute(sql`INSERT INTO log_facet_generations(workspace_id,generation,capture_signature) VALUES(${workspace},${next},${signature})
      ON CONFLICT(workspace_id) DO UPDATE SET generation=excluded.generation,capture_signature=excluded.capture_signature,born_at=excluded.born_at,
        certified_at=NULL,next_at=excluded.next_at`);
    await tx.execute(sql`INSERT INTO log_facet_inbound_progress(workspace_id,generation) VALUES(${workspace},${next})`);
    return next;
  },{isolationLevel:'repeatable read'});
}

/** Applied capture is deleted with its aggregate update. For an outage past 24h, invalidate
 * affected coverage IN THE SAME transaction as pruning expired inputs; never bridge an unseen
 * change by advancing a watermark. Each run takes at most one page from each of three queues. */
export async function expireFacetChanges(db:Database,limit=GC_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>GC_PAGE)throw new RangeError('Invalid Logs retention page size');
  return db.transaction(async tx=>{
    const {rows:[gate]}=await tx.execute<{held:boolean}>(sql`SELECT set_config('lock_timeout','150ms',true),
      set_config('statement_timeout','2s',true),pg_try_advisory_xact_lock(712009,3) held`);
    if(!gate?.held)return null;
    const age=sql`statement_timestamp()-${FACET_CHANGE_RETENTION_HOURS}*interval '1 hour'`;
    const {rows:[r]}=await tx.execute<{source:number;dirty:number;boxes:number;scopes:number}>(sql`WITH source AS MATERIALIZED (
      SELECT id,workspace_id,source AS origin FROM log_facet_changes WHERE captured_at<${age}
      ORDER BY captured_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED),
    dirty AS MATERIALIZED (SELECT id,workspace_id FROM log_facet_dirty_messages WHERE captured_at<${age}
      ORDER BY captured_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED),
    boxes AS MATERIALIZED (SELECT box_id FROM log_facet_box_work WHERE captured_at<${age}
      ORDER BY captured_at,box_id LIMIT ${limit} FOR UPDATE SKIP LOCKED),
    lost AS (SELECT 'workspace'::text AS kind,workspace_id AS key FROM source WHERE origin='sent'
      UNION SELECT 'workspace',workspace_id FROM dirty
      UNION SELECT 'install','' WHERE EXISTS(SELECT 1 FROM source WHERE origin<>'sent') OR EXISTS(SELECT 1 FROM boxes)),
    fenced AS (INSERT INTO log_facet_gaps(scope_kind,scope_key,lost_at)
      SELECT kind,key,statement_timestamp() FROM lost ORDER BY kind,key
      ON CONFLICT(scope_kind,scope_key) DO UPDATE SET lost_at=greatest(log_facet_gaps.lost_at,excluded.lost_at)),
    dropped_source AS (DELETE FROM log_facet_changes j USING source s WHERE j.id=s.id),
    dropped_dirty AS (DELETE FROM log_facet_dirty_messages d USING dirty x WHERE d.id=x.id),
    dropped_boxes AS (DELETE FROM log_facet_box_work b USING boxes x WHERE b.box_id=x.box_id)
    SELECT (SELECT count(*)::int FROM source) AS source,(SELECT count(*)::int FROM dirty) AS dirty,
      (SELECT count(*)::int FROM boxes) AS boxes,(SELECT count(*)::int FROM lost) AS scopes`);
    return r??null;
  },{isolationLevel:'repeatable read'});
}

const tables=['log_facet_dirty_messages','log_facet_sent_seeds','log_facet_deadlines','log_facet_message_facts','log_facet_buckets','log_facet_inbound_progress'] as const;
/** Never rewrite or cascade-delete a large stale projection on the source writer or a request. */
export async function pruneFacetGeneration(db:Database,limit=GC_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>GC_PAGE)throw new RangeError('Invalid Logs cleanup page size');
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT set_config('lock_timeout','150ms',true),set_config('statement_timeout','2s',true)`);
    const {rows:[old]}=await tx.execute<{workspace_id:string;generation:string}>(sql`SELECT workspace_id,generation
      FROM log_facet_retired_generations ORDER BY retired_at,workspace_id,generation LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(!old)return null;
    let remaining=limit;
    for(const table of tables){
      const name=sql.identifier(table);
      const q=await tx.execute(sql`WITH page AS MATERIALIZED (SELECT ctid FROM ${name}
        WHERE workspace_id=${old.workspace_id} AND generation=${old.generation} LIMIT ${remaining})
        DELETE FROM ${name} t USING page p WHERE t.ctid=p.ctid AND t.workspace_id=${old.workspace_id} AND t.generation=${old.generation}`);
      remaining-=q.rowCount??0;if(!remaining)break;
    }
    if(remaining)await tx.execute(sql`DELETE FROM log_facet_retired_generations WHERE workspace_id=${old.workspace_id} AND generation=${old.generation}`);
    return limit-remaining;
  });
}

/** Inactive per-view demands/results have short independent lifetimes, not mail retention. */
export async function pruneFacetViews(db:DbExecutor) {
  return db.execute(sql`WITH d AS MATERIALIZED (SELECT ctid FROM log_facet_demands WHERE expires_at<=statement_timestamp()
      ORDER BY expires_at LIMIT ${GC_PAGE} FOR UPDATE SKIP LOCKED),
    r AS MATERIALIZED (SELECT ctid FROM log_facet_results WHERE expires_at<=statement_timestamp()
      ORDER BY expires_at LIMIT ${GC_PAGE} FOR UPDATE SKIP LOCKED),
    remove_d AS (DELETE FROM log_facet_demands t USING d WHERE t.ctid=d.ctid)
    DELETE FROM log_facet_results t USING r WHERE t.ctid=r.ctid`);
}

/** Retain a full extra day beyond the private dashboard's maximum accepted 31-day anchor,
 * including all future mail. Reclaim only private cells, deadline groups and lineage before that
 * floor, plus empty cells. Source mail and a previously published historical cut are untouched. */
export async function trimFacetFootprint(db:Database,workspace:string,limit=GC_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>GC_PAGE)throw new RangeError('Invalid Logs horizon cleanup');
  return db.transaction(async tx=>{
    const {rows:[gate]}=await tx.execute<{held:boolean}>(sql`SELECT set_config('lock_timeout','150ms',true),
      set_config('statement_timeout','2s',true),pg_try_advisory_xact_lock(712008,hashtext(${workspace})) AS held`);
    if(!gate?.held)return 0;
    const {rows:[c]}=await tx.execute<{generation:string;floor:string}>(sql`SELECT c.generation,
      greatest(c.covered_from,date_trunc('hour',statement_timestamp(),'UTC')-interval '768 hours')::text AS floor
      FROM log_facet_coverage c JOIN log_facet_inbound_progress p USING(workspace_id,generation)
      WHERE c.workspace_id=${workspace} AND c.sent_done AND c.sent_witnesses_retired AND p.seeded AND p.advancing_to IS NULL
      FOR NO KEY UPDATE OF c`);
    if(!c)return 0;
    await tx.execute(sql`UPDATE log_facet_coverage SET covered_from=${c.floor}::timestamptz
      WHERE workspace_id=${workspace} AND generation=${c.generation} AND covered_from<${c.floor}::timestamptz`);
    const removals=[
      ['log_facet_buckets',sql`grain='minute' AND bucket_at<${c.floor}::timestamptz`],
      ['log_facet_buckets',sql`grain='hour' AND bucket_at<${c.floor}::timestamptz`],
      ['log_facet_message_facts',sql`minute<${c.floor}::timestamptz`],
      ['log_facet_deadlines',sql`minute<${c.floor}::timestamptz`],
      ['log_facet_deadlines',sql`n=0`],['log_facet_buckets',sql`n=0`],
    ] as const;
    let left=limit;
    for(const [table,predicate] of removals){
      const name=sql.identifier(table);
      const result=await tx.execute(sql`WITH page AS MATERIALIZED (SELECT ctid FROM ${name} WHERE workspace_id=${workspace}
        AND generation=${c.generation} AND ${predicate} LIMIT ${left}) DELETE FROM ${name} t USING page p
        WHERE t.ctid=p.ctid AND t.workspace_id=${workspace} AND t.generation=${c.generation}`);
      left-=result.rowCount??0;if(!left)break;
    }
    return limit-left;
  });
}
