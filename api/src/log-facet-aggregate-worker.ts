import { sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './core/types.js';
import { databaseCodeOf } from './core/errors.js';
import { log } from './log.js';
import { logFacetPeriod } from './log-facet-fold.js';
import { advanceInboundFacetClock, drainDirtyFacetMessages, seedInboundFacetPage } from './log-facet-aggregate-inbound.js';
import { captureFacetSignature, ensureFacetGeneration, expireFacetChanges, facetGenerationIntact, pruneFacetGeneration, pruneFacetViews, trimFacetFootprint } from './log-facet-aggregate-retention.js';
import { expandFacetBoxPage, routeInboundFacetChanges } from './log-facet-aggregate-routing.js';
import { drainSentFacetPackets, seedSentFacetPage, retireSentSeedWitnesses } from './log-facet-aggregate-sent.js';
import { publishFacetBucketView, rollingFacetFrom, utcFacetStamp } from './log-facet-aggregate-view.js';

const TURN_MS=180, BATCHES=8, VIEWS=4;
/** Current inputs visible in THIS snapshot. Late commits are intentionally not included in the
 * stamp. An unrouted foreign link or mailbox-lifetime page cannot be assumed to belong elsewhere. */
const noMissing=(workspace:string,generation:string,sourceTime:string)=>sql`
  NOT EXISTS(SELECT 1 FROM log_facet_changes WHERE workspace_id=${workspace} AND source='sent')
  AND NOT EXISTS(SELECT 1 FROM log_facet_changes WHERE source IN ('message','link','box'))
  AND NOT EXISTS(SELECT 1 FROM log_facet_box_work)
  AND NOT EXISTS(SELECT 1 FROM log_facet_dirty_messages WHERE workspace_id=${workspace} AND generation=${generation})
  AND NOT EXISTS(SELECT 1 FROM log_facet_deadlines WHERE workspace_id=${workspace} AND generation=${generation}
    AND deadline<=${sourceTime}::timestamptz AND n<>0)`;
async function completeAt(db:DbExecutor,workspace:string,generation:string,stamp:string) {
  const {rows:[r]}=await db.execute<{ok:boolean}>(sql`SELECT c.sent_done AND p.seeded AND p.advancing_to IS NULL
    AND p.visibility_clock<=${stamp}::timestamptz AND ${noMissing(workspace,generation,stamp)} AS ok
    FROM log_facet_coverage c JOIN log_facet_inbound_progress p USING(workspace_id,generation)
    WHERE c.workspace_id=${workspace} AND c.generation=${generation}`);
  return r?.ok===true;
}

/** The upkeep transaction is the certificate fence. Its FIRST statement takes the RR snapshot
 * and saves that statement's native UTC microsecond clock. All bounded mutations, proof, and
 * publications then commit together. A partial turn explicitly withdraws the mutable generation
 * certificate, while previously published immutable view cuts stay readable at their old as-of. */
export async function runFacetAggregateTurn(db:Database,workspace:string) {
  const generation=await ensureFacetGeneration(db,workspace);if(!generation)return null;
  return db.transaction(async tx=>{
    const began=performance.now();
    const {rows:[first]}=await tx.execute<{stamp:string;held:boolean}>(sql`SELECT
      set_config('lock_timeout','150ms',true),set_config('statement_timeout','2s',true),
      ${utcFacetStamp(sql`statement_timestamp()`)} AS stamp,pg_current_snapshot(),
      pg_try_advisory_xact_lock(712008,hashtext(${workspace})) AS held`);
    if(!first?.held)return null;
    // Bound genuinely active worker transactions, not registered workspaces or viewers. These
    // four permits disappear at commit; an unsuccessful try leaves demand durably pending.
    const permit=await tx.execute(sql`SELECT i FROM generate_series(0,3) i
      WHERE pg_try_advisory_xact_lock(712010,((hashtext(${workspace})::bigint&3)+i)::int%4) LIMIT 1`);
    if(!permit.rowCount)return null;
    const signature=await captureFacetSignature(tx);if(!signature)return null;
    const state=(await tx.execute<{sd:boolean;md:boolean;retired:boolean;floor:string}>(sql`SELECT c.sent_done AS sd,p.seeded AS md,c.sent_witnesses_retired AS retired,
      c.covered_from::text AS floor FROM log_facet_coverage c JOIN log_facet_generations g USING(workspace_id,generation)
      JOIN log_facet_inbound_progress p USING(workspace_id,generation) WHERE c.workspace_id=${workspace} AND c.generation=${generation}
      AND g.capture_signature=${signature} AND ${facetGenerationIntact(workspace)}`)).rows[0];
    if(!state)return null;
    const work={seedSent:0,seedMail:0,packets:0,messages:0,routed:0,boxKeys:0,deadlines:0,published:0};
    // A clean snapshot can certify now: no mail read, empty-drain transactions, or clock-only
    // rewrites when no deadline was crossed. All predicates use the SAME snapshot as the bins.
    const clean=state.sd&&state.md&&await completeAt(tx,workspace,generation,first.stamp);
    // At most one legacy page per direction per turn; an already certified view never reads source
    // history for being opened or polled. New work is consumed in bounded, independently retryable slices.
    if(!state.sd)work.seedSent=(await seedSentFacetPage(tx,workspace))?.read??0;
    if(!state.md && performance.now()-began<TURN_MS)work.seedMail=(await seedInboundFacetPage(tx,workspace))?.read??0;
    let clockDone:boolean=false;
    for(let pass=0;!clean&&pass<BATCHES && (pass===0||performance.now()-began<TURN_MS);pass++){
      const routed=await routeInboundFacetChanges(tx),box=await expandFacetBoxPage(tx);
      const time:{expired:number;done:boolean}|null=clockDone?null:await advanceInboundFacetClock(tx,workspace,512,first.stamp);
      clockDone ||= time?.done===true;
      const messages=await drainDirtyFacetMessages(tx,workspace),packets=await drainSentFacetPackets(tx,workspace);
      work.routed+=routed??0;work.boxKeys+=box?.read??0;work.deadlines+=time?.expired??0;
      work.messages+=messages??0;work.packets+=packets?.packets??0;
      if(!routed&&!box&&!time?.expired&&!messages&&!packets?.packets)break;
    }
    const ready=(clean||await completeAt(tx,workspace,generation,first.stamp)) && Date.parse(rollingFacetFrom(first.stamp,'30d'))>=Date.parse(state.floor);
    if(ready){
      const {rows:views}=await tx.execute<{region:string;period:string;anchor:string}>(sql`SELECT d.region,d.period,
        to_char(d.anchor AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS anchor FROM log_facet_demands d
        LEFT JOIN log_facet_results r ON (r.workspace_id,r.region,r.period,r.anchor)=(d.workspace_id,d.region,d.period,d.anchor)
          AND r.generation=${generation}
        WHERE d.workspace_id=${workspace} AND d.expires_at>statement_timestamp() AND d.anchor>=${state.floor}::timestamptz
          AND (r.as_of IS NULL OR r.as_of<d.wanted_at)
        ORDER BY coalesce(r.as_of,d.created_at),d.region,d.period,d.anchor LIMIT ${VIEWS}`);
      let defaultServed=false;
      for(const view of views){
        const period=logFacetPeriod(view.period);if(!period)throw new Error('Invalid Logs aggregate period');
        await publishFacetBucketView(tx,workspace,generation,view.region||null,period,view.anchor,first.stamp);
        defaultServed ||= !view.region&&period==='30d';work.published++;
      }
      if(!defaultServed){
        // A large workspace with no viewers still gets the default prior certificate. An idle
        // browser doesn't cause repeated scans of history; renew stale bootstrap views from buckets.
        const {rowCount}=await tx.execute(sql`SELECT 1 FROM log_facet_rolling WHERE workspace_id=${workspace} AND region='' AND period='30d'
          AND generation=${generation} AND published_at>statement_timestamp()-interval '5 minutes'`);
        if(!rowCount)await publishFacetBucketView(tx,workspace,generation,null,'30d',rollingFacetFrom(first.stamp,'30d'),first.stamp,false);
      }
      if(!state.retired)await retireSentSeedWitnesses(tx,workspace);
    }
    // Do not let an unrelated enrollment overwrite the result or reset an in-flight source turn.
    // Pending inputs/wanted cuts also wake the scheduler independently of the idle check.
    await tx.execute(sql`UPDATE log_facet_generations SET certified_at=${ready?first.stamp:null}::timestamptz,
      next_at=clock_timestamp()+${ready&&work.published<VIEWS?'10 seconds':'200 milliseconds'}::interval
      WHERE workspace_id=${workspace} AND generation=${generation}`);
    return {generation,stamp:ready?first.stamp:null,ready,work,ms:performance.now()-began};
  },{isolationLevel:'repeatable read'}).catch((error: unknown) => {
    // Another workspace can acknowledge shared inbound work after this turn took its
    // snapshot. PostgreSQL rolled the entire turn back: the next tick gets a fresh snapshot.
    if (databaseCodeOf(error) !== '40001') throw error;
    log('info', { code: 'LOG_FACET_SNAPSHOT_RETRY', workspaceId: workspace });
    return null;
  });
}

/** Discovery is one workspace PK page, never a mail-volume count. Both raw existence probes
 * stop at the first recent row on their workspace/date indexes, including for very large tenants. */
export async function discoverFacetWorkspaces(db:DbExecutor,after:string) {
  const {rows}=await db.execute<{id:string;mail:boolean}>(sql`WITH page AS MATERIALIZED (
    SELECT id FROM workspaces WHERE id>${after} ORDER BY id LIMIT 16)
    SELECT p.id,EXISTS(SELECT 1 FROM sending_emails WHERE workspace_id=p.id
      AND created_at>=date_trunc('minute',statement_timestamp(),'UTC')-interval '720 hours'
      ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 0) OR EXISTS(SELECT 1 FROM mail_messages WHERE workspace_id=p.id
      AND direction='inbound' AND received_at>=date_trunc('minute',statement_timestamp(),'UTC')-interval '720 hours'
      ORDER BY received_at DESC,id DESC LIMIT 1 OFFSET 0) AS mail FROM page p ORDER BY p.id`);
  return rows;
}

/** A bounded registry page outside the requested GET. Use the existing durable jobs PK for
 * the discovery cursor only; neither source workers nor callers occupy discovery slots. */
async function discover(db:Database) {
  return db.transaction(async tx=>{
    const {rows:[lock]}=await tx.execute<{held:boolean}>(sql`SELECT set_config('lock_timeout','150ms',true),
      set_config('statement_timeout','1s',true),pg_try_advisory_xact_lock(712009,4) AS held`);
    if(!lock?.held)return;
    const id='maintenance:log-facet-aggregate-discovery';
    const {rows:[prior]}=await tx.execute<{cursor:string;due:boolean;type:string}>(sql`SELECT payload->>'after' AS cursor,
      available_at<=statement_timestamp() AS due,type FROM jobs WHERE id=${id}`);
    if(prior && (!prior.due||prior.type!=='logs.aggregateDiscovery'))return;
    const page=await discoverFacetWorkspaces(tx,prior?.cursor??'');
    const scopes=page.filter(w=>w.mail).map(w=>w.id);
    if(scopes.length)await tx.execute(sql`INSERT INTO log_facet_wakes(workspace_id)
      SELECT id FROM unnest(${sql.param(scopes)}::text[]) s(id) WHERE NOT EXISTS
        (SELECT 1 FROM log_facet_generations g WHERE g.workspace_id=s.id) ORDER BY id ON CONFLICT(workspace_id) DO NOTHING`);
    const end=page.length<16?'':page.at(-1)!.id;
    await tx.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload,status,available_at)
      VALUES(${id},${id},'logs.aggregateDiscovery',jsonb_build_object('after',${end}::text),'completed',statement_timestamp()+interval '1 minute')
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,created_at=statement_timestamp()
      WHERE jobs.type='logs.aggregateDiscovery' AND jobs.workspace_id=excluded.workspace_id`);
  });
}

/** Slow and idle scopes get a fair indexed turn. Explicit demand is a separate, coalesced hint.
 * The registry's next_at is also a backstop on a missed hint or a runner/Worker restart. */
async function due(db:DbExecutor) {
  const {rows}=await db.execute<{workspace_id:string}>(sql`WITH wake AS MATERIALIZED (
    SELECT workspace_id,requested_at FROM log_facet_wakes ORDER BY requested_at,workspace_id LIMIT 4),
    independent AS MATERIALIZED (SELECT workspace_id,next_at FROM log_facet_generations WHERE next_at<=statement_timestamp()
      ORDER BY next_at,workspace_id LIMIT 4),
    source_head AS MATERIALIZED (SELECT workspace_id,captured_at FROM log_facet_changes ORDER BY id LIMIT 32),
    choices AS (SELECT workspace_id,requested_at AS at FROM wake UNION ALL SELECT workspace_id,next_at FROM independent
      UNION ALL SELECT h.workspace_id,h.captured_at FROM source_head h JOIN workspaces w ON w.id=h.workspace_id)
    SELECT workspace_id FROM choices GROUP BY 1 ORDER BY min(at),workspace_id`);
  return rows.map(r=>r.workspace_id);
}

/** One dedicated bounded maintenance burst. Nodes call it on their independent lane; Workers
 * run it through waitUntil/Hyperdrive, never as part of a sending orchestration transaction. */
export async function maintainFacetAggregates(db:Database,budgetMs:number,upkeep:boolean) {
  const end=performance.now()+budgetMs;
  const registry=(await db.execute<{installed:boolean}>(sql`SELECT to_regclass('log_facet_wakes') IS NOT NULL AS installed`)).rows[0];
  if(!registry?.installed)return false;
  if(upkeep){
    for(let i=0;i<128 && performance.now()<end;i++){
      const p=await expireFacetChanges(db);
      if(!p||Math.max(p.source,p.dirty,p.boxes)<512)break;
    }
    await pruneFacetViews(db);await pruneFacetGeneration(db);
  }
  if(!await captureFacetSignature(db))return false;
  if(upkeep)await discover(db);
  let retry:string[]=[];
  for(let i=0;i<128&&performance.now()<end;i++){
    const names=[...new Set([...(await due(db)),...retry])];retry=[];
    if(!names.length)break;
    for(const workspace of names){
      if(performance.now()>=end)break;
      await db.execute(sql`DELETE FROM log_facet_wakes WHERE workspace_id=${workspace}`);
      const turn=await runFacetAggregateTurn(db,workspace);
      if(upkeep && i===0 && turn?.ready && performance.now()<end){
        await retireSentSeedWitnesses(db,workspace);await trimFacetFootprint(db,workspace);
      }
      if(turn && (!turn.ready && Object.values(turn.work).some(v=>v>0) || turn.work.published===VIEWS))retry.push(workspace);
    }
  }
  return true;
}
