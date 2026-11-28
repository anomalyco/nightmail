import { sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './core.js';
import { lockFacetCoverage, mergeFacetCells } from './log-facet-aggregate-sent.js';

const MESSAGE_PAGE=256, DEADLINE_PAGE=512;
type Progress={ after_at:string|null; after_id:string|null; seeded:boolean; clock:string; advancing:string|null };
async function progress(db:DbExecutor,workspace:string,generation:string) {
  const {rows:[p]}=await db.execute<Progress>(sql`SELECT after_at::text,after_id,seeded,
    visibility_clock::text AS clock,advancing_to::text AS advancing FROM log_facet_inbound_progress
    WHERE workspace_id=${workspace} AND generation=${generation} FOR NO KEY UPDATE`);
  return p??null;
}

/** Recompute only the requested message PKs. A shared message contributes once per audience.
 * Keep the final qualifying deadline for each audience; a held link is eligible for admin only.
 * A missing box never retains non-default mail for admin, but follows visibleLinks' NOT EXISTS
 * expired-box rule for a member link. No mailbox is enumerated on its writer or a viewer's GET. */
async function reconcile(db:DbExecutor,workspace:string,generation:string,floor:string,clock:string,ids:string[]) {
  if(!ids.length)return;
  await db.execute(sql`WITH requested AS MATERIALIZED (SELECT DISTINCT mail_id FROM unnest(${sql.param(ids)}::text[]) k(mail_id)),
    prior AS MATERIALIZED (SELECT p.* FROM requested k JOIN log_facet_message_facts p ON p.message_id=k.mail_id
      WHERE p.workspace_id=${workspace} AND p.generation=${generation}),
    current AS MATERIALIZED (
      SELECT m.id AS message_id,date_trunc('minute',m.received_at,'UTC') AS minute,coalesce(m.region,'') AS region,m.spam,
        CASE WHEN m.lifecycle='default' OR links.admin_forever THEN 'infinity'::timestamptz
          ELSE coalesce(links.admin_last,'-infinity'::timestamptz) END AS admin_until,
        CASE WHEN links.member_forever THEN 'infinity'::timestamptz
          ELSE coalesce(links.member_last,'-infinity'::timestamptz) END AS member_until
      FROM requested k CROSS JOIN LATERAL (SELECT id,region,received_at,spam,lifecycle FROM mail_messages
        WHERE id=k.mail_id AND workspace_id=${workspace} AND direction='inbound' AND received_at>=${floor}::timestamptz OFFSET 0) m
      CROSS JOIN LATERAL (SELECT bool_or(b.id IS NOT NULL AND b.delete_after IS NULL) AS admin_forever,
        max(b.delete_after) AS admin_last,
        bool_or(l.workspace_id=${workspace} AND l.held_reason IS NULL AND b.delete_after IS NULL) AS member_forever,
        max(b.delete_after) FILTER (WHERE l.workspace_id=${workspace} AND l.held_reason IS NULL) AS member_last
        FROM mailbox_messages l LEFT JOIN mailboxes b ON b.id=l.mailbox_id WHERE l.message_id=m.id) links
    ), changed AS MATERIALIZED (SELECT coalesce(o.message_id,n.message_id) AS id FROM prior o FULL JOIN current n USING(message_id)
      WHERE (o.minute,o.region,o.spam,o.admin_until,o.member_until) IS DISTINCT FROM
        (n.minute,n.region,n.spam,n.admin_until,n.member_until)),
    movement AS (SELECT o.minute,o.region,o.spam,o.admin_until,o.member_until,-1 AS d FROM prior o JOIN changed x ON x.id=o.message_id
      WHERE o.minute>=${floor}::timestamptz
      UNION ALL SELECT n.minute,n.region,n.spam,n.admin_until,n.member_until,1 FROM current n JOIN changed x ON x.id=n.message_id),
    atoms AS MATERIALIZED (SELECT m.minute,m.region,m.d,k.band,k.status,k.deadline FROM movement m
      CROSS JOIN LATERAL (VALUES ('admin',CASE WHEN m.spam THEN 'spam' ELSE 'received' END,m.admin_until),
        ('member','received',m.member_until)) k(band,status,deadline) WHERE k.deadline>${clock}::timestamptz),
    delta AS (SELECT region,minute,band,status,d AS n FROM atoms),
    ${mergeFacetCells(workspace,generation)}, expiry AS (
      INSERT INTO log_facet_deadlines(workspace_id,generation,deadline,minute,region,band,status,n)
      SELECT ${workspace},${generation},deadline,minute,region,band,status,sum(d)::bigint FROM atoms WHERE isfinite(deadline)
      GROUP BY 3,4,5,6,7 HAVING sum(d)<>0 ORDER BY 3,4,5,6,7
      ON CONFLICT(workspace_id,generation,deadline,minute,region,band,status) DO UPDATE SET n=log_facet_deadlines.n+excluded.n),
    removed AS (DELETE FROM log_facet_message_facts p USING changed x WHERE p.workspace_id=${workspace} AND p.generation=${generation}
      AND p.message_id=x.id AND NOT EXISTS (SELECT 1 FROM current n WHERE n.message_id=x.id))
    INSERT INTO log_facet_message_facts(workspace_id,generation,message_id,minute,region,spam,admin_until,member_until)
    SELECT ${workspace},${generation},n.message_id,n.minute,n.region,n.spam,n.admin_until,n.member_until
      FROM current n JOIN changed x ON n.message_id=x.id ORDER BY n.message_id
    ON CONFLICT(workspace_id,generation,message_id) DO UPDATE SET minute=excluded.minute,region=excluded.region,
      spam=excluded.spam,admin_until=excluded.admin_until,member_until=excluded.member_until`);
}

export async function seedInboundFacetPage(db:Database,workspace:string,limit=MESSAGE_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>MESSAGE_PAGE)throw new RangeError('Invalid Logs inbound seed page size');
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c)return null;
    const p=await progress(tx,workspace,c.generation);if(!p||p.seeded||p.advancing)return null;
    const after=p.after_at===null?sql``:sql`AND (received_at,id)>(${p.after_at}::timestamptz,${p.after_id}::text)`;
    const {rows}=await tx.execute<{id:string;at:string}>(sql`SELECT id,received_at::text AS at FROM mail_messages
      WHERE workspace_id=${workspace} AND direction='inbound' AND received_at>=${c.floor}::timestamptz ${after}
      ORDER BY received_at,id LIMIT ${limit}`);
    await reconcile(tx,workspace,c.generation,c.floor,p.clock,rows.map(r=>r.id));
    const last=rows.at(-1),done=rows.length<limit;
    await tx.execute(sql`UPDATE log_facet_inbound_progress SET after_at=coalesce(${last?.at??null}::timestamptz,after_at),
      after_id=coalesce(${last?.id??null}::text,after_id),seeded=${done}
      WHERE workspace_id=${workspace} AND generation=${c.generation}`);
    return {read:rows.length,done};
  },{isolationLevel:'repeatable read'});
}

/** Incoming dirty messages are append-only in the router. Delete only the actual rows observed,
 * not every row for an ID: a concurrent committed follow-up must remain visible to the next pass. */
export async function drainDirtyFacetMessages(db:Database,workspace:string,limit=MESSAGE_PAGE) {
  if(!Number.isInteger(limit)||limit<1||limit>MESSAGE_PAGE)throw new RangeError('Invalid Logs message batch');
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c)return null;
    const p=await progress(tx,workspace,c.generation);if(!p||p.advancing)return null;
    const {rows}=await tx.execute<{id:string;message_id:string}>(sql`SELECT id::text,message_id FROM log_facet_dirty_messages
      WHERE workspace_id=${workspace} AND generation=${c.generation} ORDER BY log_facet_dirty_messages.id LIMIT ${limit} FOR UPDATE SKIP LOCKED`);
    await reconcile(tx,workspace,c.generation,c.floor,p.clock,[...new Set(rows.map(r=>r.message_id))]);
    if(rows.length)await tx.execute(sql`DELETE FROM log_facet_dirty_messages WHERE workspace_id=${workspace} AND generation=${c.generation}
      AND id=ANY(${sql.param(rows.map(r=>r.id))}::bigint[])`);
    return rows.length;
  },{isolationLevel:'repeatable read'});
}

/** Apply clock-only expirations using grouped deadlines, never a per-mail scan. A partly applied
 * time frontier is private: source reconciliation and certification wait until it is complete. */
export async function advanceInboundFacetClock(db:Database,workspace:string,limit=DEADLINE_PAGE,sourceTime?:string) {
  if(!Number.isInteger(limit)||limit<1||limit>DEADLINE_PAGE)throw new RangeError('Invalid Logs expiry batch');
  return db.transaction(async tx=>{
    const c=await lockFacetCoverage(tx,workspace);if(!c)return null;
    const p=await progress(tx,workspace,c.generation);if(!p)return null;
    const {rows:[result]}=await tx.execute<{expired:number;done:boolean}>(sql`WITH boundary AS MATERIALIZED (
      SELECT coalesce(${p.advancing}::timestamptz,greatest(${p.clock}::timestamptz,
        coalesce(${sourceTime??null}::timestamptz,statement_timestamp()))) AS target),
      page AS MATERIALIZED (SELECT minute,region,band,status,deadline,n FROM log_facet_deadlines
        WHERE workspace_id=${workspace} AND generation=${c.generation} AND deadline<=(SELECT target FROM boundary)
        ORDER BY deadline,minute,region,band,status LIMIT ${limit+1}),
      batch AS MATERIALIZED (SELECT * FROM page ORDER BY deadline,minute,region,band,status LIMIT ${limit}),
      delta AS (SELECT minute,region,band,status,-n AS n FROM batch WHERE minute>=${c.floor}::timestamptz),${mergeFacetCells(workspace,c.generation)},
      removed AS (DELETE FROM log_facet_deadlines d USING batch b WHERE d.workspace_id=${workspace} AND d.generation=${c.generation}
        AND (d.deadline,d.minute,d.region,d.band,d.status)=(b.deadline,b.minute,b.region,b.band,b.status)),
      size AS MATERIALIZED (SELECT count(*)::int AS n FROM page)
      UPDATE log_facet_inbound_progress SET visibility_clock=CASE WHEN size.n<=${limit} THEN boundary.target ELSE visibility_clock END,
        advancing_to=CASE WHEN size.n>${limit} THEN boundary.target END FROM size,boundary
      WHERE workspace_id=${workspace} AND generation=${c.generation}
      RETURNING least(size.n,${limit}::int) AS expired,size.n<=${limit} AS done`);
    return result??null;
  },{isolationLevel:'repeatable read'});
}
