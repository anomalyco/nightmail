import { sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './core/types.js';

const ROUTE_PAGE=256;
async function routeLock(tx:DbExecutor) {
  const {rows:[r]}=await tx.execute<{held:boolean}>(sql`SELECT set_config('lock_timeout','150ms',true),
    set_config('statement_timeout','2s',true),pg_try_advisory_xact_lock(712009,1) AS held`);
  return r?.held===true;
}

/** hints(message_id, workspace_id, captured_at) is a bounded input. A foreign-workspace link
 * can affect admin retention: resolve both the actual message and any previously counted owner,
 * rather than assuming a link's workspace field is the only affected workspace. */
const queueOwners=sql`ids AS MATERIALIZED (SELECT message_id,min(captured_at) AS captured_at FROM hints GROUP BY message_id),
  owners AS (
    SELECT message_id,workspace_id,captured_at FROM hints
    UNION ALL SELECT i.message_id,m.workspace_id,i.captured_at FROM ids i CROSS JOIN LATERAL (
      SELECT workspace_id FROM mail_messages WHERE id=i.message_id OFFSET 0) m
    UNION ALL SELECT i.message_id,p.workspace_id,i.captured_at FROM ids i JOIN log_facet_message_facts p ON p.message_id=i.message_id
      JOIN log_facet_coverage c ON c.workspace_id=p.workspace_id AND c.generation=p.generation
  ), queued AS (
    INSERT INTO log_facet_dirty_messages(workspace_id,generation,message_id,captured_at)
    SELECT c.workspace_id,c.generation,o.message_id,min(o.captured_at) FROM owners o JOIN log_facet_coverage c USING(workspace_id)
    GROUP BY 1,2,3 ORDER BY 1,3)`;

/** No high-water sequence skip. Rows invisible to this snapshot stay queued when they commit.
 * Append the derived dirty work and acknowledge only the picked source rows in one transaction. */
export async function routeInboundFacetChanges(db:Database,limit=ROUTE_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>ROUTE_PAGE)throw new RangeError('Invalid Logs routing batch');
  return db.transaction(async tx=>{
    if(!await routeLock(tx))return null;
    const {rows:[result]}=await tx.execute<{routed:number}>(sql`WITH picked AS MATERIALIZED (
      SELECT id,source,workspace_id,entity_id,captured_at FROM log_facet_changes WHERE source IN ('message','link','box')
      ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), hints AS MATERIALIZED (SELECT entity_id AS message_id,workspace_id,captured_at FROM picked WHERE source IN ('message','link')),
    ${queueOwners}, boxes AS (
      INSERT INTO log_facet_box_work(box_id,captured_at)
      SELECT entity_id,min(captured_at) FROM picked WHERE source='box' GROUP BY entity_id ORDER BY entity_id
      ON CONFLICT(box_id) DO UPDATE SET rerun=true,captured_at=least(log_facet_box_work.captured_at,excluded.captured_at)),
    removed AS (DELETE FROM log_facet_changes j USING picked p WHERE j.id=p.id)
    SELECT count(*)::int AS routed FROM picked`);
    return result?.routed??0;
  },{isolationLevel:'repeatable read'});
}

/** One indexed page from one changed mailbox. Later changes ask for ONE successor scan; they
 * don't reset an active cursor and starve its tail. A deleted link independently marked its ID. */
export async function expandFacetBoxPage(db:Database,limit=ROUTE_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>ROUTE_PAGE)throw new RangeError('Invalid Logs inbox page size');
  return db.transaction(async tx=>{
    if(!await routeLock(tx))return null;
    const {rows:[box]}=await tx.execute<{box_id:string;after_id:string|null;captured_at:string;rerun:boolean}>(sql`
      SELECT box_id,after_id,captured_at::text,rerun FROM log_facet_box_work ORDER BY turn_at,box_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(!box)return null;
    const after=box.after_id===null?sql``:sql`AND message_id>${box.after_id}`;
    const {rows:[page]}=await tx.execute<{n:number;last_id:string|null}>(sql`WITH hints AS MATERIALIZED (
      SELECT message_id,workspace_id,${box.captured_at}::timestamptz AS captured_at FROM mailbox_messages
      WHERE mailbox_id=${box.box_id} ${after} ORDER BY message_id LIMIT ${limit}
    ),${queueOwners} SELECT count(*)::int AS n,max(message_id) AS last_id FROM hints`);
    if(!page)throw new Error('Missing Logs inbox page');
    if(page.n===limit || box.rerun){
      await tx.execute(sql`UPDATE log_facet_box_work SET after_id=${page.n===limit?page.last_id:null},
        rerun=CASE WHEN ${page.n}::int=${limit}::int THEN rerun ELSE false END,turn_at=statement_timestamp() WHERE box_id=${box.box_id}`);
    }else await tx.execute(sql`DELETE FROM log_facet_box_work WHERE box_id=${box.box_id}`);
    return {read:page.n,complete:page.n<limit&&!box.rerun};
  },{isolationLevel:'repeatable read'});
}
