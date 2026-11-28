import { sql } from 'drizzle-orm';
import { log } from './log.js';
import { logError } from './core/errors.js';
import type { Runtime } from './core/types.js';

// content_screen_calls (migration 397): one row per classifier request, the same record as its CONTENT_SCREEN_CALL line
// (src/screen.ts), for operators who read the database. A row waits in memory, per database client, until
// flushScreenCalls writes them all in one INSERT when a dispatch run ends (src/dispatcher.ts runDispatcher) or a job drain
// ends (src/jobs.ts processJobs). So no write sits between a lease and SES or inside a statement that records a send, and
// a write that fails or takes more than two seconds drops its rows with one log line. A run that never ends (a deploy, an
// evicted isolate) loses the rows it was holding; nothing waits for them. The INSERT runs under a transaction-local
// statement_timeout and lock_timeout (WRITE_MS, LOCK_MS; as src/abuse.ts bounded does), so the database itself cancels a slow
// or blocked write and its connection comes back: a lock on this table can never hold one of a dispatcher's two connections.

/** Outbound calls this isolate has in flight, by kind, for each classifier request's record: a Worker invocation waits for
 *  response headers on at most six connections at once, so a classifier request can queue behind SES sends while its
 *  deadline runs. The dispatcher counts its SES sends here (src/dispatcher.ts pacedSender); the classifier's own are
 *  counted in src/screen.ts. Records only: nothing reads it to decide anything. */
export const outbound = { ses: 0 };

/** The columns a row may have, before they are bounded: strings cut to 100 characters (the vendor's request ID to 80),
 *  numbers rounded and range-checked. */
export type ScreenCallRow = { at: number; workspaceId?: string; emailId?: string; campaignId?: string; kind?: string; required?: boolean; region?: string; shard?: number;
  outcome?: string; phase?: string; httpStatus?: number; headersMs?: number; ms?: number; requestBytes?: number; responseBytes?: number; inFlight?: number; sesInFlight?: number;
  window?: number; windows?: number; requestId?: string; sampleRate?: number };
type Row = Record<string, string | number | boolean | null>;
// The database cancels the write at WRITE_MS, or once it has waited LOCK_MS for a lock (a lock wait then says so, 55P03);
// the flush stops waiting a little later, in case the cancel itself is late.
const MAX_ROWS = 2000, WRITE_MS = 2000, LOCK_MS = 1500, WAIT_MS = WRITE_MS + 500;
const buffers = new WeakMap<object, { rows: Row[]; dropped: number }>();
const text = (value: unknown, max = 100) => typeof value === 'string' && value ? value.slice(0, max) : null;
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(-max, Math.min(max, Math.round(value))) : null;
const INT = 2_147_483_647, SMALL = 32_767;

/** Keeps a row for `db`'s next flush. Full (MAX_ROWS), an answered request makes room for a failure; else the new row is dropped. */
export function keepScreenCall(db: object | undefined, row: ScreenCallRow) {
  try {
    if (!db) return;
    let buffer = buffers.get(db);
    if (!buffer) buffers.set(db, buffer = { rows: [], dropped: 0 });
    const outcome = text(row.outcome) ?? 'unknown';
    if (buffer.rows.length >= MAX_ROWS) {
      buffer.dropped++;
      const answered = outcome === 'ok' ? -1 : buffer.rows.findIndex(kept => kept.outcome === 'ok');
      if (answered < 0) return;
      buffer.rows.splice(answered, 1);
    }
    buffer.rows.push({ at: row.at, workspace_id: text(row.workspaceId), email_id: text(row.emailId), campaign_id: text(row.campaignId), kind: text(row.kind),
      required: typeof row.required === 'boolean' ? row.required : null, region: text(row.region), shard: integer(row.shard, SMALL), outcome, phase: text(row.phase),
      http_status: integer(row.httpStatus, SMALL), headers_ms: integer(row.headersMs, INT), ms: integer(row.ms, INT), request_bytes: integer(row.requestBytes, INT),
      response_bytes: integer(row.responseBytes, INT), in_flight: integer(row.inFlight, SMALL), ses_in_flight: integer(row.sesInFlight, SMALL),
      window_index: integer(row.window, SMALL), windows: integer(row.windows, SMALL), request_id: text(row.requestId, 80), sample_rate: typeof row.sampleRate === 'number' && row.sampleRate > 0 && row.sampleRate <= 1 ? row.sampleRate : 1 });
  } catch { /* A record never changes the request's outcome. */ }
}

/** Writes the rows kept for `sourceDb` (default `db`) in one INSERT, in a transaction of its own (a savepoint inside one). Never throws. */
export async function flushScreenCalls(db: Runtime['db'], sourceDb: object = db): Promise<void> {
  const buffer = buffers.get(sourceDb);
  if (!buffer || (!buffer.rows.length && !buffer.dropped)) return;
  const rows = buffer.rows.splice(0), dropped = buffer.dropped;
  buffer.dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (rows.length) {
      const write = db.transaction(async tx => {
        const { rows: [before] } = await tx.execute<{ statement: string; lock: string }>(sql`WITH before AS MATERIALIZED (SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock) SELECT before.*,set_config('statement_timeout',${String(WRITE_MS)},true),set_config('lock_timeout',${String(LOCK_MS)},true) FROM before`);
        // Inside a caller's transaction this is a savepoint, and the limits would outlast it: the INSERT puts the caller's back
        // once its rows are in (a write that fails rolls them back with it). The limits it runs under were fixed when it began.
        await tx.execute(sql`WITH written AS (INSERT INTO content_screen_calls(created_at,headers_ms,ms,request_bytes,response_bytes,sample_rate,shard,http_status,in_flight,
          ses_in_flight,window_index,windows,required,outcome,phase,kind,region,workspace_id,email_id,campaign_id,request_id)
        SELECT to_timestamp(x.at/1000.0),x.headers_ms,x.ms,x.request_bytes,x.response_bytes,x.sample_rate,x.shard,x.http_status,x.in_flight,
          x.ses_in_flight,x.window_index,x.windows,x.required,x.outcome,x.phase,x.kind,x.region,x.workspace_id,x.email_id,x.campaign_id,x.request_id
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(at float8,headers_ms int,ms int,request_bytes int,response_bytes int,sample_rate real,shard smallint,
          http_status smallint,in_flight smallint,ses_in_flight smallint,window_index smallint,windows smallint,required boolean,outcome text,phase text,kind text,region text,
          workspace_id text,email_id text,campaign_id text,request_id text) RETURNING 1)
          SELECT set_config('statement_timeout',${before!.statement},true),set_config('lock_timeout',${before!.lock},true) FROM (SELECT count(*) FROM written) n`);
      }).then(() => undefined, (error: unknown) => ({ error }));
      // The database has cancelled the write by now; if it still hasn't answered, its rows count as unwritten.
      const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), WAIT_MS); });
      const result = await Promise.race([write, late]);
      if (result === 'late') { log('warn', { code: 'CONTENT_SCREEN_CALLS_UNWRITTEN', reason: 'timeout', rows: rows.length, dropped }); return; }
      if (result) { logError(result.error, { code: 'CONTENT_SCREEN_CALLS_UNWRITTEN', rows: rows.length, dropped }, 'warn'); return; }
    }
    if (dropped) log('warn', { code: 'CONTENT_SCREEN_CALLS_DROPPED', rows: rows.length, dropped });
  } catch (error) {
    logError(error, { code: 'CONTENT_SCREEN_CALLS_UNWRITTEN', rows: rows.length, dropped }, 'warn'); // Building the statement failed.
  } finally { clearTimeout(timer); }
}
