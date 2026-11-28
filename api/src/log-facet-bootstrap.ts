import { sql } from 'drizzle-orm';
import { statementTimedOut } from './core/http.js';
import type { Runtime } from './core/types.js';
import { enrollLogFacet, readPublishedLogFacet, reusableLogFacetSlot, type FacetTicket } from './log-facet-fold.js';
import { LOG_FACET_MAX_SOURCE_ROWS, logFacetSourceRows } from './log-facet-source.js';

export const LOG_FACET_BOOTSTRAP_TICK_MS = 60_000;
const CONTROL = 'maintenance:log-facet-bootstrap', TYPE = 'logs.facetBootstrap';
const PAGE = 16;
// The four worker PKs and the admission lock belong to log-facet-fold.ts.
const SLOTS = Array.from({ length: 4 }, (_, n) => 'job_logfacets_slot_' + n);
type Cursor = { version: 1; after: string };

/**
 * Discover at most one missing Hosted all-region 30d cut. The completed control row checkpoints the
 * workspace cursor and next turn; it is never a runnable job. Callers hand the ordinary fold ticket
 * to their dedicated facet worker only after this transaction has committed.
 */
export async function bootstrapLogFacet(runtime: Runtime): Promise<FacetTicket | null> {
  if (!runtime.config.multiTenant) return null;
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout','750ms',true),set_config('lock_timeout','150ms',true)`);
    const { rows: [election] } = await tx.execute<{ held: boolean }>(sql`SELECT pg_try_advisory_xact_lock(712006, 2) AS held`);
    if (!election?.held) return null;
    const { rows: [control] } = await tx.execute<{ type: string; workspace_id: string; status: string; payload: Cursor; due: boolean }>(sql`
      SELECT type,workspace_id,status,payload,available_at <= statement_timestamp() AS due FROM jobs WHERE id=${CONTROL}`);
    if (control && (!control.due || control.type !== TYPE || control.workspace_id !== CONTROL || control.status !== 'completed'
      || control.payload?.version !== 1 || typeof control.payload.after !== 'string')) return null;
    let after = control?.payload.after ?? '';
    const checkpoint = () => tx.execute(sql`
      INSERT INTO jobs(id,workspace_id,type,payload,status,available_at)
        VALUES(${CONTROL},${CONTROL},${TYPE},${JSON.stringify({ version: 1, after } satisfies Cursor)}::jsonb,'completed',
          date_trunc('minute',statement_timestamp(),'UTC') + interval '1 minute')
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,created_at=statement_timestamp()
      WHERE jobs.type=excluded.type AND jobs.workspace_id=excluded.workspace_id AND jobs.status='completed'`);
    // Materialize a workspace PK page before looking at mail. Each existence probe keeps its
    // ordered LIMIT (OFFSET 0 prevents a hash of the entire source), using the workspace/date index.
    const { rows: page } = await tx.execute<{ id: string; from: string; mail: boolean }>(sql`
      WITH page AS MATERIALIZED (SELECT id FROM workspaces WHERE id>${after} ORDER BY id LIMIT ${PAGE}),
      boundary AS MATERIALIZED (SELECT date_trunc('minute',statement_timestamp(),'UTC') - interval '720 hours' AS since)
      SELECT p.id,to_char(b.since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "from",
        (EXISTS (SELECT 1 FROM sending_emails WHERE workspace_id=p.id AND created_at>=b.since
          ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 0)
        OR EXISTS (SELECT 1 FROM mail_messages WHERE workspace_id=p.id AND direction='inbound' AND received_at>=b.since
          ORDER BY received_at DESC,id DESC LIMIT 1 OFFSET 0)) AS mail
      FROM page p CROSS JOIN boundary b ORDER BY p.id`);
    for (const candidate of page) {
      if (!candidate.mail || await readPublishedLogFacet(tx, candidate.id, null, '30d')) {
        after = candidate.id;
        continue;
      }
      // A window too large to fold (or to size within this turn's limit) is skipped, not enrolled to fail every cycle.
      await tx.execute(sql`SAVEPOINT log_facet_size`);
      let large = true;
      try { large = await logFacetSourceRows(tx, candidate.id, candidate.from, null) > LOG_FACET_MAX_SOURCE_ROWS; }
      catch (error) { if (!statementTimedOut(error)) throw error; }
      finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT log_facet_size`); await tx.execute(sql`RELEASE SAVEPOINT log_facet_size`); }
      if (large) {
        after = candidate.id;
        continue;
      }
      // Do not wait behind a viewer. Under the same admission lock, leave at least two reusable
      // slots even after our admission, and give any pending/running fold priority over discovery.
      const { rows: [gate] } = await tx.execute<{ held: boolean }>(sql`SELECT pg_try_advisory_xact_lock(712006, 1) AS held`);
      if (!gate?.held) { await checkpoint(); return null; }
      const { rows: [room] } = await tx.execute<{ hot: number; blocked: boolean }>(sql`
        SELECT count(*) FILTER (WHERE NOT (${reusableLogFacetSlot}))::int AS hot,
          coalesce(bool_or(type<>'logs.facetFold' OR status NOT IN ('completed','failed')),false) AS blocked
        FROM jobs WHERE id=ANY(${sql.param(SLOTS)}::text[])`);
      if (!room || room.blocked || room.hot > 1) { await checkpoint(); return null; }
      // Publication can have won the race with the first PK read. Don't start another fold for it.
      if (await readPublishedLogFacet(tx, candidate.id, null, '30d')) {
        after = candidate.id;
        await checkpoint();
        return null;
      }
      const ticket = await enrollLogFacet({ ...runtime, db: tx }, candidate.id, candidate.from, null, '30d', false);
      after = candidate.id;
      await checkpoint();
      return ticket;
    }
    if (page.length < PAGE) after = '';
    await checkpoint();
    return null;
  });
}
