import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type Runtime } from './core.js';
import { log, logError } from './core.js';
import { logAnalyticsFailure } from './analytics-traffic.js';
import { campaignActive } from './states.js';
import { expireDomainClaims } from './operations.js';
import { SEND_LIMITS } from './send-limits.js';
import { foldSendingTallies, recountSendingTallies } from './sending-tallies.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
const UPLOAD_BATCH = 1000;
const DAY_MS = 24 * 3600_000;
/** Import retention windows (days): uncommitted previews stay 7 days; committed CSV rows scrub to [] while keeping
 *  2,000 opaque contact IDs for support's 90-day bounce view; sample IDs and per-row errors scrub after 90 days. */
export const IMPORT_PREVIEW_RETENTION_DAYS = 7, IMPORT_COMMITTED_ROWS_RETENTION_DAYS = 7, IMPORT_COMMITTED_DETAILS_RETENTION_DAYS = 90;

/**
 * Storage reconciliation, hourly with cleanup (the only retention step that calls storage). A put can
 * land at any time (see Storage.put): after its reservation expired, after the sweeper's deletion ran
 * and after the reservation's tombstone (158) was spent. The reconciler lists only the upload prefix
 * (uploadKey), takes only keys of its exact grammar (uploads/<existing workspace>/attachment_<32 hex>)
 * that are a day old and that no row references (storage_key_in_use), and queues their deletion; the
 * same object found again later is queued again. The deletion job checks the key once more when it
 * runs. Each run continues from a stored cursor and starts over at the end, so a large bucket is
 * covered over several runs. Tombstones remain the fast path, and the only one for keys of the earlier
 * layout (<workspace>/attachments/<id>), which this never lists.
 */
const UPLOAD_PREFIX = 'uploads/', UPLOAD_KEY = /^uploads\/[^/]+\/attachment_[0-9a-f]{32}$/, RECONCILE_PAGES = 20;
export async function reconcileUploads(runtime: Runtime, budgetMs = 60_000) {
  if (!runtime.storage.list) return 0;
  try { return await reconcilePages(runtime, Date.now() + budgetMs); }
  catch { log('warn', { code: 'UPLOAD_RECONCILE_FAILED', message: 'The next hourly run resumes the storage listing.' }); return 0; }
}
async function reconcilePages(runtime: Runtime, deadline: number) {
  let queued = 0, after = (await runtime.db.execute<{ after: string }>(sql`SELECT after FROM sending_upload_reconcile WHERE id='uploads'`)).rows[0]?.after ?? '';
  for (let page = 0; page < RECONCILE_PAGES && Date.now() < deadline; page++) {
    const listed = await runtime.storage.list!(UPLOAD_PREFIX, after || undefined), old = Date.now() - DAY_MS, next = listed.cursor ?? '';
    const keys = listed.objects.filter(o => UPLOAD_KEY.test(o.key) && o.uploaded.getTime() <= old).map(o => o.key);
    const { rows: [r] } = await runtime.db.execute<{ moved: boolean; n: number }>(sql`WITH moved AS (
        INSERT INTO sending_upload_reconcile(id,after) VALUES('uploads',${next}) ON CONFLICT(id) DO UPDATE SET after=excluded.after WHERE sending_upload_reconcile.after=${after} RETURNING 1),
      orphans AS (SELECT key,split_part(key,'/',2) AS wid FROM unnest(${sql.param(keys)}::text[]) key WHERE EXISTS(SELECT FROM moved)
        AND EXISTS(SELECT FROM workspaces w WHERE w.id=split_part(key,'/',2)) AND NOT storage_key_in_use(key)),
      queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-orphan:'||key,'maintenance.deleteAttachment',wid,jsonb_build_object('key',key) FROM orphans
        ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed') RETURNING 1)
      SELECT EXISTS(SELECT FROM moved) AS moved,(SELECT count(*)::int FROM queued) AS n`);
    // Another reconciler moved the cursor: it owns this page.
    if (!r?.moved) break;
    queued += r.n; after = next;
    if (!next) break;
  }
  return queued;
}
// The hourly retention run, everything included: no statement starts after it. Hourly cron invocations may run 15 minutes.
const RETENTION_BUDGET_MS = 5 * 60_000;

/**
 * The hourly backstop for the ten-minute standing job (src/standing.ts): runs the ladder now, which also re-queues any
 * workspace whose SES tenants differ from what Nightmail wants. The ladder, not this check, decides pauses (docs/sending-limits.md).
 */
export async function checkHostedHealth(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  const { refreshStanding } = await import('./standing.js');
  const result = await refreshStanding(runtime);
  if (result.changed) log('info', { code: 'STANDING_REFRESHED', ...result });
}

/** Independent bounded slice, before other hourly drains. A poison batch must not
 * abort ordinary retention, MX checks or receipt recovery. Alternate deletion
 * and GC so a backlog or failure in either phase doesn't starve the other. */
export async function sweepInboxes(runtime:Runtime, budgetMs:number,clock=Date.now){
  const until=clock()+budgetMs;
  const phases=[{name:'leases',batch:sql`SELECT inbox_retention_batch(25) n`,done:false,failed:false},
    {name:'content',batch:sql`SELECT mail_gc_batch(1000) n`,done:false,failed:false},
    {name:'expunge history',batch:sql`SELECT inbox_prune_vanished() n`,done:false,failed:false},
    {name:'reservations',batch:sql`WITH pruned AS (DELETE FROM mail_retired_addresses WHERE (workspace_id,address) IN (SELECT workspace_id,address FROM mail_retired_addresses WHERE until<=now() ORDER BY until LIMIT 5000) RETURNING 1) SELECT count(*)::int n FROM pruned`,done:false,failed:false}];
  while(clock()<until && phases.some(p=>!p.done&&!p.failed))for(const p of phases){
    if(p.done||p.failed||clock()>=until)continue;
    try{const {rows}=await runtime.db.execute<{n:number}>(p.batch);p.done=Number(rows[0]?.n)===0;if(p.name==='leases'&&!p.done)phases[1].done=false;}
    catch{p.failed=true;log('error',{code:'INBOX_RETENTION_FAILED',phase:p.name});}
  }
  const pending=phases.filter(p=>!p.done).map(p=>p.name);
  log(pending.length?'warn':'info',{code:pending.length?'INBOX_RETENTION_PARTIAL':'INBOX_RETENTION_COMPLETED',pending});
  return pending.length===0;
}

const INBOX_RECONCILE_PAGE = 50;
const INBOX_RECONCILE_LOCK_CAP = 50_000;
/**
 * Scheduled exact recount of inbox_state counters (messages, held, unread) from mailbox_messages.
 * Pages across inbox_state with a persisted cursor (sending_upload_reconcile id='inbox-state') and a
 * per-inbox statement timeout, reading without locks first so a 2M-message inbox never stalls live
 * ingest. Only takes FOR UPDATE SKIP LOCKED when a difference is found, confirms modseq did not move
 * during the scan (or recounts under lock for small inboxes), corrects the row, and logs INBOX_STATE_DRIFT
 * at error level whenever an initialized counter drifted (a difference is a bug).
 */
export async function reconcileInboxState(runtime: Runtime, budgetMs = 15_000, clock = Date.now) {
  const deadline = clock() + budgetMs;
  let checked = 0, corrected = 0, drifted = 0, skipped = 0;
  let after = (await runtime.db.execute<{ after: string }>(sql`SELECT after FROM sending_upload_reconcile WHERE id='inbox-state'`)).rows[0]?.after ?? '';
  type Tally = { messages: number; held: number; unread: number };
  const zero: Tally = { messages: 0, held: 0, unread: 0 };
  const countOne = (inboxId: string) => runtime.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return (await tx.execute<Tally>(sql`
      SELECT count(*)::int AS messages,
             count(*) FILTER (WHERE held_reason IS NOT NULL)::int AS held,
             count(*) FILTER (WHERE NOT read AND held_reason IS NULL)::int AS unread
      FROM mailbox_messages WHERE mailbox_id=${inboxId}`)).rows[0]!;
  }, { accessMode: 'read only' });
  while (clock() < deadline) {
    const { rows } = await runtime.db.execute<{ inbox_id: string; workspace_id: string; modseq: string; messages: number; held: number; unread: number | null }>(sql`
      SELECT s.inbox_id, s.workspace_id, s.modseq::text, s.messages, s.held, s.unread
      FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id
      WHERE s.inbox_id > ${after} AND (b.delete_after IS NULL OR b.delete_after > statement_timestamp())
      ORDER BY s.inbox_id LIMIT ${INBOX_RECONCILE_PAGE}`);
    if (!rows.length) {
      if (after !== '') await runtime.db.execute(sql`INSERT INTO sending_upload_reconcile(id,after) VALUES('inbox-state','') ON CONFLICT(id) DO UPDATE SET after=''`);
      break;
    }
    // Count all small inboxes on the page in one grouped query; count large inboxes individually so
    // one 2M-message inbox cannot time out the other 49 inboxes on the page.
    const smallIds = rows.filter(r => r.messages <= INBOX_RECONCILE_LOCK_CAP).map(r => r.inbox_id);
    let batched: Map<string, Tally> | null = null;
    if (smallIds.length) {
      try {
        const grouped = await runtime.db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          return (await tx.execute<Tally & { mailbox_id: string }>(sql`
            SELECT mailbox_id, count(*)::int AS messages,
                   count(*) FILTER (WHERE held_reason IS NOT NULL)::int AS held,
                   count(*) FILTER (WHERE NOT read AND held_reason IS NULL)::int AS unread
            FROM mailbox_messages WHERE mailbox_id = ANY(${sql.param(smallIds)}::text[])
            GROUP BY mailbox_id`)).rows;
        }, { accessMode: 'read only' });
        batched = new Map(grouped.map(g => [g.mailbox_id, { messages: g.messages, held: g.held, unread: g.unread }]));
      } catch (error) {
        log('warn', { code: 'INBOX_STATE_RECONCILE_BATCH_FALLBACK', count: smallIds.length, timedOut: timedOut(error) });
      }
    }
    let advanced = after;
    for (const s of rows) {
      if (clock() >= deadline) break;
      try {
        const actual = batched && s.messages <= INBOX_RECONCILE_LOCK_CAP
          ? (batched.get(s.inbox_id) ?? zero)
          : await countOne(s.inbox_id);
        checked++;
        if (s.unread === actual.unread && s.messages === actual.messages && s.held === actual.held) { advanced = s.inbox_id; continue; }
        const outcome = await runtime.db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'`);
          const [locked] = (await tx.execute<{ modseq: string; messages: number; held: number; unread: number | null }>(sql`
            SELECT modseq::text, messages, held, unread FROM inbox_state WHERE inbox_id=${s.inbox_id} FOR UPDATE SKIP LOCKED`)).rows;
          if (!locked) return { skipped: 'busy' as const };
          let exact = actual;
          if (locked.modseq !== s.modseq) {
            if (locked.messages > INBOX_RECONCILE_LOCK_CAP) return { skipped: 'busy' as const };
            exact = (await tx.execute<Tally>(sql`
              SELECT count(*)::int AS messages,
                     count(*) FILTER (WHERE held_reason IS NOT NULL)::int AS held,
                     count(*) FILTER (WHERE NOT read AND held_reason IS NULL)::int AS unread
              FROM mailbox_messages WHERE mailbox_id=${s.inbox_id}`)).rows[0]!;
          }
          if (locked.unread === exact.unread && locked.messages === exact.messages && locked.held === exact.held) return null;
          await tx.execute(sql`UPDATE inbox_state SET messages=${exact.messages}, held=${exact.held}, unread=${exact.unread} WHERE inbox_id=${s.inbox_id}`);
          return { wasInitialized: locked.unread !== null, stored: { messages: locked.messages, held: locked.held, unread: locked.unread }, exact };
        });
        if (outcome && 'skipped' in outcome) {
          skipped++;
          log('warn', { code: 'INBOX_STATE_RECONCILE_SKIPPED', workspaceId: s.workspace_id, inboxId: s.inbox_id, reason: outcome.skipped });
        } else if (outcome) {
          corrected++;
          if (outcome.wasInitialized) {
            drifted++;
            log('error', { code: 'INBOX_STATE_DRIFT', workspaceId: s.workspace_id, inboxId: s.inbox_id, stored: outcome.stored, actual: outcome.exact });
          }
        }
        advanced = s.inbox_id;
      } catch (error) {
        if (timedOut(error)) {
          skipped++;
          log('warn', { code: 'INBOX_STATE_RECONCILE_SKIPPED', workspaceId: s.workspace_id, inboxId: s.inbox_id, reason: 'timeout' });
        } else {
          logError(error, { code: 'INBOX_STATE_RECONCILE_FAILED', inboxId: s.inbox_id }, 'warn');
        }
        advanced = s.inbox_id;
      }
    }
    const next = rows.length < INBOX_RECONCILE_PAGE && advanced === rows.at(-1)!.inbox_id ? '' : advanced;
    await runtime.db.execute(sql`INSERT INTO sending_upload_reconcile(id,after) VALUES('inbox-state',${next}) ON CONFLICT(id) DO UPDATE SET after=excluded.after`);
    after = next;
    if (!next) break;
  }
  return { checked, corrected, drifted, skipped };
}

/**
 * One retention step: a bounded statement that removes (or retires) at most `size` rows, oldest first, and returns their
 * count as n. `oldest` selects the time of the oldest row the step would still take, for the log. `lane` groups the steps in
 * the log (sent mail, received mail, everything else); the sent ones also run every 15 minutes (retentionTick). `batches`
 * caps the statements a step runs in one run.
 */
type Lane = 'sent' | 'inbound' | 'other';
type Drain = { name: string; statement: () => SQL; size?: number; oldest?: SQL; lane?: Lane; batches?: number };
// The 15-minute run of the sent-side tables, from the minute cron and the Node runner, everything included.
const SENT_BUDGET_MS = 2 * 60_000;
// The last part of a run's budget goes to finding the oldest row still waiting in each table behind.
const OLDEST_RESERVE_MS = 15_000;
// A run's lease outlasts its budget by the one statement that may still be running at its end (Hyperdrive stops any
// statement at 60 s), so a run that died leaves no lease behind for longer than that.
const LEASE_GRACE_MS = 2 * 60_000;

/**
 * The rows of `table` that match `where`, oldest first by `by` when an index gives that order (`unordered` when none
 * does: a sort would read the whole backlog for each batch). A row another run holds is skipped, not waited for.
 */
function expired(name: string, table: string, by: SQL, where: SQL, extra: Partial<Drain> & { unordered?: true } = {}): Drain {
  const t = sql.identifier(table), size = extra.size ?? RETENTION_BATCH, order = extra.unordered ? sql`` : sql` ORDER BY ${by}`;
  return { name, oldest: sql`SELECT min(${by}) FROM ${t} WHERE ${where}`, size: extra.size, lane: extra.lane, batches: extra.batches,
    statement: () => sql`WITH gone AS (DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${where}${order} LIMIT ${size} FOR UPDATE SKIP LOCKED) RETURNING 1) SELECT count(*)::int AS n FROM gone` };
}
/** expired() for two tables as one step, under `name`: a batch of each in one statement, each taken as expired() takes it.
 *  n is their sum, so the step repeats while either table still fills its batch; oldest is the older of the two. */
function expiredTogether(name: string, tables: [{ table: string; by: SQL; where: SQL }, { table: string; by: SQL; where: SQL }]): Drain {
  const [a, b] = tables.map(({ table, by, where }) => ({ t: sql`${sql.identifier(table)}`, by, where }));
  const batch = ({ t, by, where }: { t: SQL; by: SQL; where: SQL }) => sql`DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${where} ORDER BY ${by} LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1`;
  return { name, oldest: sql`SELECT least((SELECT min(${a!.by}) FROM ${a!.t} WHERE ${a!.where}),(SELECT min(${b!.by}) FROM ${b!.t} WHERE ${b!.where}))`,
    statement: () => sql`WITH gone AS (${batch(a!)}), also AS (${batch(b!)}) SELECT ((SELECT count(*) FROM gone)+(SELECT count(*) FROM also))::int AS n` };
}
const unordered = { unordered: true } as const;
const at = (column: string) => sql`${sql.identifier(column)}`;
/**
 * The Idempotency-Keys retention deletes: a finished request's (a claim still waiting for its result is never touched) on
 * exactly the routes that send email: POST /v1/emails/send and /batch (direct, batch, stored-template and scheduled sends,
 * internal notices), /v1/campaigns/{id}/test, /v1/domains/{id}/test-send, /v1/inbound/threads and its /{threadId}/reply.
 * An anchored pattern with one path segment per ID, so nothing near those can match. Every other key (creates, uploads,
 * campaign launches, billing top-ups) is kept; the acceptance test "an Idempotency-Key expires only on a send route"
 * classifies every route that takes one. Literal SQL: the partial indexes of migration 390 repeat these predicates
 * exactly, which is what lets the planner use them. A scheduled send's key is apart: it waits longer.
 */
const SEND_PATH = sql.raw(`path ~ '^/v1/(emails/(send|batch)|campaigns/[^/]+/test|domains/[^/]+/test-send|inbound/threads(/[^/]+/reply)?)$'`);
const SEND_KEYS = sql`result IS NOT NULL AND NOT (result ? 'scheduledAt') AND ${SEND_PATH}`, SCHEDULED_KEYS = sql`result ? 'scheduledAt' AND ${SEND_PATH}`;

/**
 * A list's counts are the sums of the differences its triggers add (migration 405): this folds each list's rows into
 * one and drops a deleted list's, hourly. One statement, so a reader sees the rows before it or the one after it, never
 * neither; a row another fold already took is skipped and only what this one removed is summed. n is the rows it saved.
 */
export const foldListCounts = () => sql`WITH folded AS (DELETE FROM audience_list_counts d
    WHERE (d.workspace_id, d.list_id) IN (SELECT workspace_id, list_id FROM audience_list_counts GROUP BY 1, 2 HAVING count(*) > 1)
      OR NOT EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id = d.workspace_id AND l.id = d.list_id)
    RETURNING d.workspace_id, d.list_id, d.subscribed, d.unsubscribed, d.unknown, d.suppressed
  ), kept AS (INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT f.workspace_id, f.list_id, sum(f.subscribed), sum(f.unsubscribed), sum(f.unknown), sum(f.suppressed) FROM folded f
    WHERE EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id = f.workspace_id AND l.id = f.list_id) GROUP BY 1, 2 RETURNING 1
  ) SELECT (SELECT count(*) FROM folded)::int - (SELECT count(*) FROM kept)::int AS n`;

/**
 * Every retention step, in their usual order. Never erase contacts, consent, suppression, drafts or active scheduled
 * work. Idempotency keys go only with the email log of a finished send (SEND_KEYS).
 */
async function retentionDrains(runtime: Runtime): Promise<Drain[]> {
  const cutoff = sql`now() - interval '30 days'`, { abuseExpired, linkExpired } = await import('./abuse.js');
  // Agent feedback (src/feedback.ts) is never closed: its transcript goes 90 days after its ticket was resolved.
  const closedLongAgo = sql`SELECT id FROM support_conversations WHERE (closed_at < now() - interval '90 days'
    OR (channel = 'agent_feedback' AND ticket_resolved_at < now() - interval '90 days'))`;
  const sent = { lane: 'sent' } as const, inbound = { lane: 'inbound' } as const;
  return [
    { name: 'expired_uploads', oldest: sql`SELECT min(expires_at) FROM sending_upload_reservations WHERE expires_at<=now()`, statement: () => sql`WITH expired AS (DELETE FROM sending_upload_reservations WHERE id IN
      (SELECT id FROM sending_upload_reservations WHERE expires_at<=now() ORDER BY expires_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
      cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-cleanup:'||id,'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM expired)
      SELECT count(*)::int AS n FROM expired` },
    // A day after a reservation ended without its attachment (158), delete its object once more: a late
    // put may have landed after the first deletion. An attachment that holds the object is never touched.
    { name: 'upload_tombstones', oldest: sql`SELECT min(delete_after) FROM sending_upload_tombstones WHERE delete_after<=now()`, statement: () => sql`WITH due AS (DELETE FROM sending_upload_tombstones WHERE id IN
      (SELECT id FROM sending_upload_tombstones WHERE delete_after<=now() ORDER BY delete_after LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
      cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-tombstone:'||d.id,'maintenance.deleteAttachment',d.workspace_id,jsonb_build_object('key',d.storage_key) FROM due d
        WHERE NOT EXISTS(SELECT FROM sending_attachments a WHERE a.id=d.id AND a.storage_key=d.storage_key) ON CONFLICT(id) DO NOTHING)
      SELECT count(*)::int AS n FROM due` },
    expired('api_request_budgets', 'api_request_budgets', at('window_start'), sql`window_start < now() - interval '1 day'`),
    // Denied sign-ins operators haven't acted on in 90 days (the table is otherwise capped at 10,000 identities).
    expired('access_requests', 'access_requests', at('last_requested_at'), sql`last_requested_at < now() - interval '90 days'`),
    // Refused sign-ins an operator has not acted on in 30 days (one row per subject).
    expired('nightmail_signin_attempts', 'nightmail_signin_attempts', at('last_at'), sql`last_at < now() - interval '30 days'`),
    // The waitlist keeps an address a year after its last attempt at most (migration 366).
    expired('nightmail_waitlist', 'nightmail_waitlist', at('last_at'), sql`last_at < now() - interval '1 year'`),
    // A sign-in link (migration 466) works 30 minutes; its row is kept a day, for the daily count per address.
    expired('nightmail_signin_links', 'nightmail_signin_links', at('created_at'), sql`created_at < now() - interval '1 day'`),
    // Agent setup tokens and device codes (migration 469) work 15 minutes; a row is kept a day past that, then removed.
    expired('agent_setups', 'agent_setups', at('expires_at'), sql`expires_at < now() - interval '1 day'`),
    ...['auth_state_slots', 'nightmail_dpop_proofs', 'nightmail_sessions', 'nightmail_login_flows'].map(table => expired(table, table, at('expires_at'), sql`expires_at <= now()`)),
    // Eight routing versions a year old per statement (migration 124).
    { name: 'mail_routing_versions', size: 8, oldest: sql`SELECT min(created_at) FROM mail_routing_versions WHERE created_at<now()-interval '1 year'`, statement: () => sql`SELECT mail_prune_route_versions() AS n` },
    expired('mail_receipts', 'mail_receipts', sql`coalesce(processed_at,created_at)`, sql`status IN ('processed','failed') AND coalesce(processed_at,created_at)<${cutoff}`, inbound),
    expired('mail_receipt_holds', 'mail_receipt_holds', at('expires_at'), sql`status<>'held' AND expires_at<${cutoff}`, inbound),
    // Unrouted mail for unknown recipients is kept 30 days: oldest first in 1,000-row batches (at most 5,000 per
    // hourly run, with pauses between batches), also retiring unreferenced mail_messages and queueing storage deletes.
    { name: 'mail_unrouted', ...inbound, size: 1000, batches: 5, oldest: sql`SELECT min(created_at) FROM mail_unrouted WHERE created_at<${cutoff}`, statement: () => sql`SELECT mail_unrouted_prune_batch(1000) AS n` },
    // Received-mail events and webhook deliveries are kept 30 days. A delivery still held for a paused endpoint after that is
    // dead-lettered with ENDPOINT_PAUSED_EXPIRED (unpause no longer resumes it) and kept 7 more days so the reason is seen.
    expired('mailbox_events', 'mailbox_events', at('created_at'), sql`created_at<${cutoff}`, inbound),
    // Keep ignored staging keys past S3's 3-day lifecycle (which rounds up to UTC midnight, 72-96 h + async delete)
    // so ignored unknown-domain mail is never re-swept as an orphan before S3 expires it.
    expired('mail_ignored_staging', 'mail_ignored_staging', at('created_at'), sql`created_at<now()-interval '5 days'`, inbound),
    { name: 'mailbox_webhook_deliveries_paused_expired', ...inbound, oldest: sql`SELECT min(created_at) FROM mailbox_webhook_deliveries WHERE created_at<${cutoff} AND status='paused'`,
      statement: () => sql`WITH held AS (UPDATE mailbox_webhook_deliveries SET status='failed',last_error='ENDPOINT_PAUSED_EXPIRED',updated_at=now() WHERE id IN (SELECT id FROM mailbox_webhook_deliveries
        WHERE created_at<${cutoff} AND status='paused' ORDER BY created_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1) SELECT count(*)::int AS n FROM held` },
    expired('mailbox_webhook_deliveries', 'mailbox_webhook_deliveries', at('created_at'), sql`created_at<${cutoff} AND status IN ('delivered','failed') AND (last_error IS DISTINCT FROM 'ENDPOINT_PAUSED_EXPIRED' OR updated_at<now()-interval '7 days')`, inbound),
    ...(runtime.config.multiTenant ? [
      // The score's daily evidence decays with a 30-day half-life; past 400 days it no longer moves the score or the card.
      expired('sender_score_daily', 'sender_score_daily', at('day'), sql`day < (now() AT TIME ZONE 'UTC')::date-400`, unordered),
      expired('operator_idempotency', 'operator_idempotency', at('created_at'), sql`created_at < now()-interval '1 day'`, unordered),
      // Keep only aggregate workspace evidence long enough to observe a 30-day clean span. Only the credits have an hour index.
      ...['hosted_usage_hourly', 'hosted_health_hourly', 'hosted_health_credits', 'hosted_screen_hourly'].map(table => expired(table, table, at('hour'),
        table === 'hosted_health_hourly' || table === 'hosted_screen_hourly' ? sql`hour < now()-interval '32 days'` : sql`hour < now()-interval '2 days'`,
        table === 'hosted_health_credits' ? {} : unordered)),
    ] : []),
    expired('agent_tokens', 'agent_tokens', at('expires_at'), sql`expires_at < ${cutoff}`),
    // The classifier's records, in one step: its requests (src/screen-calls.ts), kept 30 days, and the second classifier's
    // comparisons of them (src/screen-shadow.ts), kept 90. Each table's batch is taken as expired() takes one; the count
    // logged under content_screen_calls is both tables' rows.
    expiredTogether('content_screen_calls', [{ table: 'content_screen_calls', by: at('created_at'), where: sql`created_at < ${cutoff}` },
      { table: 'screen_comparisons', by: at('created_at'), where: sql`created_at < now() - interval '90 days'` }]),
    // Abuse-monitoring signals past their retention (src/abuse.ts abuseExpired). Expiry runs whether monitoring is on or off.
    expired('abuse_signals', 'abuse_signals', at('last_at'), abuseExpired),
    expired('abuse_sampling', 'abuse_sampling', at('sampled_through'), sql`sampled_through < now()-interval '30 days'`, unordered),
    // Links leave with the signals they came from; a cluster nothing has rescored for 30 days (monitoring off, or its links gone) leaves too.
    expired('identity_links', 'identity_links', at('last_at'), linkExpired),
    expired('abuse_clusters', 'abuse_clusters', at('scored_at'), sql`scored_at < now()-interval '30 days'`),
    expired('abuse_alerts', 'abuse_alerts', at('created_at'), sql`created_at < now()-interval '1 year'`),
    // An erasure's floor outlives every record it could still apply to (the sign-in log, 30 days; signals, 90).
    expired('abuse_floors', 'abuse_floors', at('ignore_through'), sql`ignore_through < now()-interval '90 days'`),
    // Delivery history (src/delivery-history.ts): a recipient domain 180 days after a workspace last mailed it; blocklist counts after 180 days.
    expired('delivery_domain_stats', 'delivery_domain_stats', at('last_seen'), sql`last_seen < now() - interval '180 days'`),
    expired('delivery_blocklist_daily', 'delivery_blocklist_daily', at('day'), sql`day < current_date - 180`),
    // The audit trail past its retention (src/audit.ts RETENTION); the table refuses to delete anything earlier. No row
    // locks: the application may not update it (42501), and only the hourly run takes it.
    { name: 'audit_events', oldest: sql`SELECT min(retain_until) FROM audit_events WHERE retain_until <= now()`, statement: () => sql`WITH gone AS (DELETE FROM audit_events WHERE id IN
      (SELECT id FROM audit_events WHERE retain_until <= now() ORDER BY retain_until LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    // Handoffs go 30 days after they expire; what they opened is in audit_events.
    expired('support_handoffs', 'support_handoffs', at('expires_at'), sql`expires_at < ${cutoff}`, unordered),
    // An email's sign-in nobody confirmed goes when it can no longer be confirmed (support-conversations.ts SIGNIN_DAYS), and
    // with it the sender address it kept; a Message-ID's binding once its Date is too old to bind anyway.
    expired('support_email_signins', 'support_email_signins', at('created_at'), sql`signed_in_at IS NULL AND created_at < now() - interval '7 days'`),
    expired('support_email_bindings', 'support_email_bindings', at('created_at'), sql`created_at < now() - interval '7 days'`),
    // The support agent's safe actions take turns per target for at most 10 minutes (src/support-actions.ts ACTION_TURNS).
    expired('support_action_slots', 'support_action_slots', at('at'), sql`at < now() - interval '1 day'`),
    // SMTP refusals (src/smtp-refusals.ts) are kept 7 days for support.
    expired('smtp_refusals', 'smtp_refusals', at('at'), sql`at < now() - interval '7 days'`),
    // Support transcripts (src/support-inbox.ts), their events and their subjects go 90 days after the conversation closed
    // (agent feedback's, after its ticket was resolved).
    expiredTogether('support_messages', [{ table: 'support_messages', by: at('created_at'), where: sql`conversation_id IN (${closedLongAgo})` },
      { table: 'support_events', by: at('created_at'), where: sql`conversation_id IN (${closedLongAgo})` }]),
    { name: 'support_subjects', statement: () => sql`WITH gone AS (UPDATE support_conversations SET subject = NULL
        WHERE id IN (${closedLongAgo} AND subject IS NOT NULL LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    expired('audience_operation_plans', 'audience_operation_plans', at('expires_at'), sql`expires_at < now() - interval '1 day'`),
    { name: 'audience_list_counts', size: Infinity, statement: foldListCounts },
    // Uncommitted previews hold their parsed CSV (up to 5 MiB) and expire after IMPORT_PREVIEW_RETENTION_DAYS (7 days).
    expired('audience_import_previews', 'audience_imports', at('created_at'), sql`status = 'preview' AND created_at < now() - make_interval(days => ${IMPORT_PREVIEW_RETENTION_DAYS})`, { size: 100, unordered: true }),
    // Backfill import_id on pre-PR audience_consent_audit rows while each committed import's rows JSONB still exists.
    // Indexed through audience_contacts(workspace_id, email) -> audience_consent_page(workspace_id, contact_id, id).
    // Both scrub drains below require consent_linked_at IS NOT NULL, so no import's rows can be emptied before linking.
    { name: 'audience_import_consent_links', size: 1, oldest: sql`SELECT min(updated_at) FROM audience_imports WHERE status = 'committed' AND consent_linked_at IS NULL AND rows_scrubbed_at IS NULL`, statement: () => sql`WITH due AS (
        SELECT id FROM audience_imports WHERE status = 'committed' AND consent_linked_at IS NULL AND rows_scrubbed_at IS NULL
        ORDER BY updated_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ), linked AS (
        UPDATE audience_consent_audit a SET import_id = d.id
        FROM due d
        JOIN audience_imports i ON i.id = d.id
        CROSS JOIN LATERAL (
          SELECT c.id AS contact_id
          FROM jsonb_array_elements(i.rows) r
          JOIN audience_contacts c ON c.workspace_id = i.workspace_id AND c.email = lower(r->>'email')
        ) mc
        WHERE a.workspace_id = i.workspace_id AND a.contact_id = mc.contact_id
          AND a.source = 'import' AND a.import_id IS NULL
          AND a.occurred_at >= i.created_at - interval '1 second'
          AND a.occurred_at <= i.updated_at + interval '5 seconds'
      ), marked AS (
        UPDATE audience_imports i SET consent_linked_at = now() FROM due WHERE i.id = due.id RETURNING 1
      ) SELECT count(*)::int AS n FROM marked` },
    // Backfill up to 2,000 opaque contact IDs onto legacy committed imports (<90 days since commit) before their rows
    // JSONB is scrubbed, so support's audienceHealth view never sees a window with neither sample_contact_ids nor rows.
    { name: 'audience_import_samples', size: 10, oldest: sql`SELECT min(updated_at) FROM audience_imports WHERE status = 'committed' AND sample_contact_ids IS NULL AND rows_scrubbed_at IS NULL AND updated_at >= now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS})`, statement: () => sql`WITH due AS (
        SELECT id FROM audience_imports WHERE status = 'committed' AND sample_contact_ids IS NULL AND rows_scrubbed_at IS NULL
          AND updated_at >= now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS})
        ORDER BY updated_at DESC LIMIT 10 FOR UPDATE SKIP LOCKED
      ), updated AS (
        UPDATE audience_imports i SET sample_contact_ids = coalesce((
          SELECT array_agg(c.id) FROM (SELECT r->>'email' AS email FROM jsonb_array_elements(i.rows) r ORDER BY hashtextextended(lower(r->>'email'), 0) LIMIT 2000) x
          JOIN audience_contacts c ON c.workspace_id = i.workspace_id AND c.email = lower(x.email)
        ), ARRAY[]::text[]) FROM due WHERE i.id = due.id RETURNING 1
      ) SELECT count(*)::int AS n FROM updated` },
    // Scrub committed 50k-row CSV payloads in small paused batches 7 days after commit (updated_at), strictly gated on
    // consent_linked_at IS NOT NULL and sample_contact_ids populated (or past 90 days); metadata & imported count stay.
    { name: 'audience_import_rows', size: 10, oldest: sql`SELECT min(updated_at) FROM audience_imports WHERE status = 'committed' AND rows_scrubbed_at IS NULL AND consent_linked_at IS NOT NULL AND updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_ROWS_RETENTION_DAYS}) AND (sample_contact_ids IS NOT NULL OR updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS}))`, statement: () => sql`WITH due AS (
        SELECT id FROM audience_imports WHERE status = 'committed' AND rows_scrubbed_at IS NULL
          AND consent_linked_at IS NOT NULL
          AND updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_ROWS_RETENTION_DAYS})
          AND (sample_contact_ids IS NOT NULL OR updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS}))
        ORDER BY updated_at LIMIT 10 FOR UPDATE SKIP LOCKED
      ), gone AS (
        UPDATE audience_imports i SET rows = '[]'::jsonb, rows_scrubbed_at = now() FROM due WHERE i.id = due.id RETURNING 1
      ) SELECT count(*)::int AS n FROM gone` },
    // Past 90 days since commit (updated_at), scrub sample_contact_ids and per-row errors too (still gated on consent_linked_at).
    { name: 'audience_import_details', size: 50, oldest: sql`SELECT min(updated_at) FROM audience_imports WHERE status = 'committed' AND errors_scrubbed_at IS NULL AND consent_linked_at IS NOT NULL AND updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS})`, statement: () => sql`WITH due AS (
        SELECT id FROM audience_imports WHERE status = 'committed' AND errors_scrubbed_at IS NULL
          AND consent_linked_at IS NOT NULL
          AND updated_at < now() - make_interval(days => ${IMPORT_COMMITTED_DETAILS_RETENTION_DAYS})
        ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED
      ), gone AS (
        UPDATE audience_imports i SET sample_contact_ids = NULL, errors = '[]'::jsonb, errors_scrubbed_at = now(), rows = '[]'::jsonb, rows_scrubbed_at = coalesce(i.rows_scrubbed_at, now()) FROM due WHERE i.id = due.id RETURNING 1
      ) SELECT count(*)::int AS n FROM gone` },

    expired('sending_email_events', 'sending_email_events', at('created_at'), sql`created_at < ${cutoff}`, sent),
    // An email and its attachment links leave in the same statement, so no link can outlive its email.
    { name: 'sending_emails', ...sent, oldest: sql`SELECT min(created_at) FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting','scheduled')`, statement: () => sql`WITH gone AS (
        DELETE FROM sending_emails WHERE ctid IN (SELECT ctid FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting','scheduled')
          ORDER BY created_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, workspace_id
      ), links AS (
        DELETE FROM sending_attachment_links l USING gone e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id
      ) SELECT count(*)::int AS n FROM gone` },
    // A send's Idempotency-Key leaves with its email's log: after 30 days the same key is a new request. A scheduled
    // email's 30 days start when it goes, up to the schedule's horizon later, so its key waits that much longer. Two steps,
    // each through its own index, so the scheduled keys never sit in the way of the others.
    expired('sending_idempotency', 'sending_idempotency', at('created_at'), sql`created_at < ${cutoff} AND ${SEND_KEYS}`, sent),
    expired('sending_idempotency_scheduled', 'sending_idempotency', at('created_at'),
      sql`created_at < ${cutoff} - make_interval(secs => ${SEND_LIMITS.schedule.horizonSeconds}) AND ${SCHEDULED_KEYS}`, sent),
    // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a campaign's current
    // snapshot or one with an outstanding reservation (including a failed launch).
    { name: 'sending_review_recipients', ...sent, statement: () => sql`WITH expired AS (
        SELECT r.review_id, r.ordinal FROM sending_review_recipients r
        JOIN sending_campaign_reviews v ON v.id = r.review_id
        WHERE v.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE (e.review_id,e.review_ordinal)=(r.review_id,r.ordinal))
          AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
            AND (c.updated_at >= ${cutoff} OR ${campaignActive()} OR c.review_id = v.id))
        LIMIT ${RETENTION_BATCH} FOR UPDATE OF r SKIP LOCKED
      ), gone AS (DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal RETURNING 1)
      SELECT count(*)::int AS n FROM gone` },
    // One statement: a review's links leave once nothing of it is left.
    { name: 'review_attachment_links', size: Infinity, statement: () => sql`WITH gone AS (DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
      WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id
        AND v.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE e.review_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
          AND (${campaignActive()} OR c.review_id = v.id)) RETURNING 1) SELECT count(*)::int AS n FROM gone` },
    expired('operation_delivery_attempts', 'operation_delivery_attempts', at('created_at'), sql`created_at < ${cutoff}`, sent),
    // As in the inbound lane: a delivery still held for a paused endpoint after 30 days is dead-lettered with
    // ENDPOINT_PAUSED_EXPIRED (unpausing no longer resumes it) and kept 7 more days so the reason is seen. Only endpoints
    // that are still paused: an unpaused one's parked deliveries belong to its resume job. Oldest first through
    // operation_deliveries_paused_age (migration 389), never a sort of the whole backlog.
    { name: 'operation_deliveries_paused_expired', ...sent, statement: () => sql`WITH expired AS (UPDATE operation_deliveries SET status='failed', last_error='ENDPOINT_PAUSED_EXPIRED', updated_at=now()
        WHERE ctid IN (SELECT d.ctid FROM operation_webhooks w JOIN operation_deliveries d ON d.workspace_id=w.workspace_id AND d.webhook_id=w.id
          WHERE w.paused AND d.status='paused' AND d.created_at < ${cutoff} ORDER BY d.created_at LIMIT ${RETENTION_BATCH} FOR UPDATE OF d SKIP LOCKED) RETURNING 1)
      SELECT count(*)::int AS n FROM expired` },
    expired('operation_deliveries', 'operation_deliveries', at('created_at'), sql`created_at < ${cutoff} AND status NOT IN ('pending','paused') AND (last_error IS DISTINCT FROM 'ENDPOINT_PAUSED_EXPIRED' OR updated_at < now() - interval '7 days')`, sent),
    expired('operation_events', 'operation_events', at('created_at'), sql`created_at < ${cutoff}`, sent),
    expired('operation_sns_receipts', 'operation_sns_receipts', at('created_at'), sql`created_at < ${cutoff}`, sent),
    expired('operation_feedback_failures', 'operation_feedback_failures', at('created_at'), sql`created_at < ${cutoff} AND reason NOT IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY')`, sent),
    expired('jobs', 'jobs', at('created_at'), sql`status IN ('completed','failed') AND type NOT IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`, sent),
    // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
    // A fixed 50 rows an hour fell behind any installation retiring more than about 1,200 uploads a day, so their objects and
    // the workspace's stored-attachment usage were never released. Up to 5,000 a run now (120,000 a day), 1,000 per
    // transaction in workspace order: each queues an object deletion that shares the 'other' job class with domain checks and
    // alerts, and each row's usage trigger holds its workspace's usage row until the batch commits.
    { name: 'unused_attachments', size: UPLOAD_BATCH, batches: 5, statement: () => sql`WITH old AS (
        SELECT a.id FROM sending_attachments a WHERE a.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.workspace_id = a.workspace_id AND l.attachment_id = a.id)
        ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
      ), gone AS (DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id, a.source_template_asset_id
      ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT public.row_id('job'),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key)
        FROM gone WHERE source_template_asset_id IS NULL
      ) SELECT count(*)::int AS n FROM gone` },
    { name: 'unused_template_assets', size: UPLOAD_BATCH, batches: 5, statement: () => sql`WITH old AS (
        SELECT a.id FROM template_assets a WHERE a.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
        ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
      ), gone AS (DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id
      ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT public.row_id('job'),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM gone
      ) SELECT count(*)::int AS n FROM gone` },
    expired('jobs_attachment_deletes', 'jobs', at('created_at'), sql`status = 'completed' AND type IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`, sent),
  ];
}

// Per lane, so no map in a log line passes the logger's 50 keys.
type ByLane = Partial<Record<Lane, Record<string, number>>>;
type Retired = { deleted: ByLane; waiting: ByLane; failed: string[]; timedOut: string[]; unreached: string[]; next: string | null; complete: boolean };
const note = (map: ByLane, d: Drain, n: number) => { const lane = (map[d.lane ?? 'other'] ??= {}); lane[d.name] = (lane[d.name] ?? 0) + n; };
const pause = (ms: number) => ms > 0 ? new Promise<void>(resolve => setTimeout(resolve, ms)) : Promise.resolve();
// A statement or lock timeout: the step is too slow for now, not wrong.
const timedOut = (error: unknown) => [error, (error as { cause?: unknown } | null)?.cause].some(e => ['57014', '55P03'].includes(String((e as { code?: unknown } | null)?.code)));

/**
 * Runs retention steps, starting with `first`, until the budget's end: no statement starts after it, so a run lasts its
 * budget and at most the one statement still running then. Each step is isolated: one that fails is logged and the rest
 * still run. Each gets a fair share of the time left (what's left divided by the steps still to go), so a backlog in one
 * table can't starve the tables after it; time a step doesn't use goes to the steps still behind, shared the same way, in a
 * second pass. Between two full batches of a step it rests as long as the last one took, so retention keeps the database
 * busy at most half of its run. A step the budget didn't reach is in `unreached`, and `next` is where the next run should
 * start: the first of those, otherwise the step after this run's first, so every table gets its turn over successive runs.
 * Reports codes and counts only: rows removed per table (a table that removed none is left out) and, for each table with
 * rows still waiting, the age in seconds of the oldest. A batch that comes back short because another run held its rows
 * counts as done: those rows go in the next run.
 */
async function retire(runtime: Runtime, drains: Drain[], budgetMs: number, first = 0, clock = Date.now): Promise<Retired> {
  const ceiling = clock() + budgetMs, until = ceiling - Math.min(OLDEST_RESERVE_MS, budgetMs / 4), deleted: ByLane = {};
  const failed: string[] = [], slow: string[] = [], statements = new Map<Drain, number>(), reached = new Set<Drain>();
  // Steps with rows still waiting: `behind` ran out of time, `capped` reached its statements for the run.
  const behind = new Set<Drain>(), capped = new Set<Drain>();
  const start = drains.length ? first % drains.length : 0, order = [...drains.slice(start), ...drains.slice(0, start)];
  const step = async (d: Drain, sliceEnd: number) => {
    for (;;) {
      const began = performance.now();
      const n = Number((await runtime.db.execute<{ n: number }>(d.statement())).rows[0]?.n ?? 0);
      statements.set(d, (statements.get(d) ?? 0) + 1);
      if (n) note(deleted, d, n);
      if (n < (d.size ?? RETENTION_BATCH)) return 'done';
      if (statements.get(d)! >= (d.batches ?? Infinity)) return 'capped';
      await pause(Math.min(performance.now() - began, sliceEnd - clock()));
      if (clock() >= sliceEnd) return 'behind';
    }
  };
  const attempt = async (d: Drain, sliceEnd: number) => {
    reached.add(d); behind.delete(d);
    try { const outcome = await step(d, sliceEnd); if (outcome === 'behind') behind.add(d); else if (outcome === 'capped') capped.add(d); }
    catch (error) { failed.push(d.name); if (timedOut(error)) slow.push(d.name); logError(error, { code: 'RETENTION_STEP_FAILED', table: d.name }, 'warn'); }
  };
  const pass = async (steps: Drain[]) => {
    for (const [i, d] of steps.entries()) { if (clock() >= until) return; await attempt(d, clock() + (until - clock()) / (steps.length - i)); }
  };
  await pass(order);
  await pass(order.filter(d => behind.has(d)));
  const unreached = order.filter(d => !reached.has(d)).map(d => d.name);
  const waiting: ByLane = {};
  // Reserve time to report oldest waiting rows even when the final statement ran past `until` (bounded within grace).
  const oldestDeadline = clock() < ceiling ? ceiling : Math.min(clock() + OLDEST_RESERVE_MS, ceiling + 55_000);
  for (const d of [...order.filter(d => failed.includes(d.name)), ...order.filter(d => behind.has(d) || capped.has(d))]) {
    if (!d.oldest || clock() >= oldestDeadline) continue;
    try {
      const age = (await runtime.db.execute<{ s: string | null }>(sql`SELECT floor(extract(epoch FROM now() - (${d.oldest})))::bigint AS s`)).rows[0]?.s;
      if (age != null) note(waiting, d, Number(age));
    } catch { /* the step's failure is already logged */ }
  }
  const next = unreached[0] ?? order[1]?.name ?? order[0]?.name ?? null;
  return { deleted, waiting, failed, timedOut: slow, unreached, next, complete: !behind.size && !capped.size && !failed.length && !unreached.length };
}
// A run that only fell behind is routine during a backlog (info); a failed step is a warning.
const retentionLog = (scope: string, run: Retired, complete = run.complete) =>
  log(run.failed.length ? 'warn' : 'info', { code: complete ? 'RETENTION_COMPLETED' : 'RETENTION_PARTIAL', scope, deleted: run.deleted, waiting: run.waiting,
    failed: run.failed, unreached: run.unreached });
const startAt = (drains: Drain[], name: string | null | undefined) => Math.max(0, drains.findIndex(d => d.name === name));
const leaseFor = (budgetMs: number) => sql`now() + make_interval(secs => ${(budgetMs + LEASE_GRACE_MS) / 1000})`;

/**
 * Hourly retention: every table, each in bounded batches that are their own transactions, within one budget for the whole
 * run (retire). It used to be one transaction of unbounded deletes: a single statement over the 60 s limit (e.g. the 2M
 * consent events of a bulk import all crossing 30 days in the same hour) rolled back the whole run every hour, so nothing
 * was ever retired again. Then it was one table after another under one deadline with no isolation: a failing statement
 * skipped every table after it, and a backlog at the front used the whole budget. Its lease (retention_state, migration
 * 388) makes the 15-minute run stand aside while it works. Throws after the run if a step failed, naming the tables, so
 * hourlyUpkeep reports it.
 */
export async function cleanup(runtime: Runtime, budgetMs = RETENTION_BUDGET_MS) {
  const ceiling = Date.now() + budgetMs, failed: string[] = [];
  const { rows: [state] } = await runtime.db.execute<{ next_step: string | null }>(sql`INSERT INTO retention_state(scope,lease_until) VALUES('hourly',${leaseFor(budgetMs)})
    ON CONFLICT(scope) DO UPDATE SET lease_until=excluded.lease_until RETURNING next_step`);
  let next: string | null = null, through: string[] = [];
  try {
    const inboxComplete = await sweepInboxes(runtime, Math.min(60_000, Math.floor(budgetMs / 5)));
    // A durable daily election prevents two reconcilers from applying the same
    // snapshot difference. Dispatch continues adding deltas while this runs.
    try { await foldSendingTallies(runtime, Math.min(10_000, Math.max(1_000, ceiling - Date.now()))); }
    catch (error) { failed.push('sending_tallies_fold'); logError(error, { code: 'RETENTION_STEP_FAILED', table: 'sending_tallies_fold' }, 'warn'); }
    try {
      await runtime.db.execute(sql`WITH elected AS (INSERT INTO job_schedule(workspace_id,next_wake_at)
        VALUES ('maintenance:sending-depth',now()+interval '1 day') ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at
        WHERE job_schedule.next_wake_at<=now() RETURNING 1) SELECT reconcile_sending_depth(),reconcile_asset_usage(),reconcile_ingest_turns() FROM elected`);
    } catch (error) { failed.push('reconcile'); logError(error, { code: 'RETENTION_STEP_FAILED', table: 'reconcile' }, 'warn'); }
    let claims: number | undefined;
    if (runtime.config.multiTenant && Date.now() < ceiling) {
      try { claims = await expireDomainClaims(runtime, Math.min(ceiling, Date.now() + 60_000)); }
      catch (error) { failed.push('domain_claims'); logError(error, { code: 'RETENTION_STEP_FAILED', table: 'domain_claims' }, 'warn'); }
    }
    const drains = await retentionDrains(runtime), run = await retire(runtime, drains, Math.max(0, ceiling - Date.now()), startAt(drains, state?.next_step));
    if (claims) run.deleted.other = { domain_claims: claims, ...run.deleted.other };
    run.failed.unshift(...failed);
    retentionLog('hourly', run, inboxComplete && run.complete && !failed.length);
    // The sent-side steps this run got through: the 15-minute run takes them again (retentionTick).
    next = run.next; through = drains.filter(d => d.lane === 'sent' && !run.failed.includes(d.name) && !run.unreached.includes(d.name)).map(d => d.name);
    if (run.failed.length) throw Object.assign(new Error('Retention steps failed'), { tables: run.failed });
  } finally {
    await runtime.db.execute(sql`WITH sent AS (UPDATE retention_state SET held=held-${sql.param(through)}::text[] WHERE scope='sent' AND held ?| ${sql.param(through)}::text[])
      UPDATE retention_state SET lease_until=NULL,next_step=coalesce(${next},next_step) WHERE scope='hourly'`).catch(() => { /* the lease expires */ });
  }
}

/**
 * The sent-side tables every 15 minutes (elected, from the minute cron and the Node runner), so a day's mail aging out
 * is retired through the hour, not only in the hourly run, which still includes them. It stands aside while the hourly run
 * holds its lease (it comes back the next minute), and skips a step whose statement or lock timed out here until the
 * hourly run gets through it, so a slow table costs one attempt an hour rather than five. Concurrent runs skip each
 * other's rows.
 */
export async function retentionTick(runtime: Runtime, budgetMs = SENT_BUDGET_MS) {
  const { rows: [state] } = await runtime.db.execute<{ next_step: string | null; held: Record<string, string> }>(sql`INSERT INTO retention_state(scope,due_at,lease_until)
    SELECT 'sent',now()+interval '15 minutes',${leaseFor(budgetMs)} WHERE NOT EXISTS (SELECT FROM retention_state WHERE scope='hourly' AND lease_until>now())
    ON CONFLICT(scope) DO UPDATE SET due_at=excluded.due_at,lease_until=excluded.lease_until
      WHERE retention_state.due_at<=now() AND (retention_state.lease_until IS NULL OR retention_state.lease_until<=now())
        AND NOT EXISTS (SELECT FROM retention_state WHERE scope='hourly' AND lease_until>now())
    RETURNING next_step,held`);
  if (!state) return;
  let next: string | null = null, slow: string[] = [];
  try {
    const drains = (await retentionDrains(runtime)).filter(d => d.lane === 'sent' && !(d.name in state.held));
    const run = await retire(runtime, drains, budgetMs, startAt(drains, state.next_step));
    retentionLog('sent', run);
    next = run.next; slow = run.timedOut;
  } finally {
    await runtime.db.execute(sql`UPDATE retention_state SET lease_until=NULL,next_step=coalesce(${next},next_step),
      held=held||(SELECT coalesce(jsonb_object_agg(name,now()),'{}') FROM unnest(${sql.param(slow)}::text[]) name) WHERE scope='sent'`).catch(() => { /* the lease expires */ });
  }
}

// How long one list's recount may take: a list of millions takes seconds, and reads only.
const RECOUNT_STATEMENT_SECONDS = 30;
/**
 * Once a day (a durable election, as the other reconcilers), every list is counted the way readLists used to count it and
 * compared with the counts the triggers keep (reconcile_audience_list_counts, migration 405). They must agree: a
 * difference means a write changed a membership or a contact's state without its trigger's row, which is a bug, so it is
 * logged at error level with the list and the difference, and stored so the list shows the right numbers again. The recount
 * reads both sides in one snapshot and takes no lock a write waits for. Each list is its own transaction with its own
 * time limit, so one that is too large to count in time (logged, not corrected) costs no other list its check; a list
 * deleted since the run began has nothing to correct. Lists go in a different order each day, so a budget that doesn't
 * reach them all today reaches the rest another day. Returns how many lists it corrected.
 */
export async function recountLists(runtime: Runtime, budgetMs = 60_000, statementSeconds = RECOUNT_STATEMENT_SECONDS, clock = Date.now) {
  const until = clock() + budgetMs;
  const { rows: lists } = await runtime.db.execute<{ workspace_id: string; id: string }>(sql`WITH elected AS (INSERT INTO job_schedule(workspace_id,next_wake_at)
      VALUES ('maintenance:audience-list-counts',now()+interval '1 day') ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at
      WHERE job_schedule.next_wake_at<=now() RETURNING 1)
    SELECT l.workspace_id, l.id FROM audience_lists l, elected ORDER BY md5(l.id || current_date::text)`);
  let recounted = 0, corrected = 0, failed = 0;
  for (const list of lists) {
    if (clock() >= until) break;
    try {
      const { rows: [difference] } = await runtime.db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(statementSeconds))}s'`));
        return tx.execute<{ subscribed: number; unsubscribed: number; unknown: number; suppressed: number }>(sql`SELECT * FROM reconcile_audience_list_counts(${list.workspace_id}, ${list.id})`);
      });
      recounted++;
      if (difference) { corrected++; log('error', { code: 'AUDIENCE_LIST_COUNTS_DRIFT', workspace: list.workspace_id, list: list.id, ...difference }); }
    } catch (error) { failed++; logError(error, { code: 'AUDIENCE_LIST_RECOUNT_FAILED', workspace: list.workspace_id, list: list.id }, 'warn'); }
  }
  if (lists.length) log(failed || recounted < lists.length ? 'warn' : 'info', { code: 'AUDIENCE_LISTS_RECOUNTED', lists: lists.length, recounted, corrected, failed });
  return corrected;
}

/** Received-mail events and webhook deliveries alone (the hourly run includes them): for checks that run just these. */
export async function pruneMailboxEvents(runtime: Runtime, budgetMs = 60_000) {
  const names = new Set(['mailbox_events', 'mail_ignored_staging', 'mailbox_webhook_deliveries_paused_expired', 'mailbox_webhook_deliveries']);
  retentionLog('inbound', await retire(runtime, (await retentionDrains(runtime)).filter(d => names.has(d.name)), budgetMs));
}
/** The hourly upkeep. Every step is best-effort: a failing step (a retention statement that keeps timing out) must not
 * skip the steps after it, and on Node, where this used to run inside the dispatch loop, it must not stop job processing
 * and mail dispatch. Retention runs last: it takes the most time, within its budget. Returns the codes of the steps that failed. */
export async function hourlyUpkeep(runtime: Runtime, mailboxRuntime: () => Promise<Runtime> = async () => runtime) {
  const failed: string[] = [];
  for (const [code, step] of [
    ['HOSTED_HEALTH_CHECK_FAILED', () => checkHostedHealth(runtime)],
    ['UPLOAD_RECONCILE_FAILED', () => reconcileUploads(runtime)],
    ['INBOX_RECONCILE_FAILED', () => reconcileInboxState(runtime)],
    ['PREVIEW_SWEEP_FAILED', async () => (await import('./preview-images.js')).sweepPreviews(runtime)],
    ['REPUTATION_ALERT_CHECK_FAILED', async () => (await import('./reputation-alerts.js')).checkReputationAlerts(runtime)],
    ['MAILBOX_HOURLY_FAILED', async () => (await import('./mailbox-ingest.js')).mailboxHourly(await mailboxRuntime())],
    ['ANALYTICS_COMPACT_FAILED', async () => { if (runtime.config.dashboardAnalytics) await (await import('./analytics.js')).compactAnalytics(runtime); }],
    // Billing settles the closed hours (and once a UTC day its storage, unpaid, drift and expiry work).
    ['BILLING_HOURLY_FAILED', async () => { if (runtime.config.multiTenant) await (await import('./billing/cron.js')).billingHourly(runtime); }],
    // Connected AWS accounts: one health check each (byo-regional.ts).
    ['BYO_HEALTH_QUEUE_FAILED', async () => { await (await import('./byo-regional.js')).queueByoHealth(runtime); }],
    // Abuse monitoring (src/abuse.ts): a bounded, leased slice. Hosted, and only while it is on.
    ['ABUSE_HOURLY_FAILED', async () => { await (await import('./abuse.js')).abuseHourly(runtime); }],
    // Delivery history (src/delivery-history.ts): finished mail folded into per-domain and per-contact history, leased and bounded.
    ['DELIVERY_HISTORY_FAILED', async () => { await (await import('./delivery-history.js')).deliveryHistoryHourly(runtime); }],
    // Registration dates of the domains sent from and linked on (src/domain-age.ts), for the send review. Hosted only.
    ['DOMAIN_REGISTRATIONS_FAILED', async () => { await (await import('./domain-age.js')).refreshRegistrations(runtime); }],
    // Daily exact recount of sending_campaign_tallies and sending_metrics_hourly.
    ['SENDING_TALLIES_RECOUNT_FAILED', async () => { await recountSendingTallies(runtime); }],
    // The daily exact recount of every list's counts.
    ['AUDIENCE_LIST_RECOUNT_FAILED', async () => { await recountLists(runtime); }],
    // List hygiene: classify contacts created before it, and every contact again for a new list or new bounces elsewhere.
    // List hygiene: the open lists once a day, the domain checks waiting (a bounded slice), then the contacts.
    ['HYGIENE_LISTS_SYNC_FAILED', async () => { await (await import('./list-hygiene.js')).syncHygieneLists(runtime); }],
    ['HYGIENE_DOMAINS_FAILED', async () => { await (await import('./list-hygiene.js')).resolvePendingDomains(runtime, 30_000); }],
    ['AUDIENCE_HYGIENE_FAILED', async () => { await (await import('./list-hygiene.js')).classifyContacts(runtime); }],
    // The sign-ups list: contacts whose address got in by an invitation or staff since (src/signups.ts).
    ['SIGNUPS_RECONCILE_FAILED', async () => { await (await import('./signups.js')).queueSignupsReconcile(runtime); }],
    ['MAINTENANCE_CLEANUP_FAILED', () => cleanup(runtime)],
  ] as const) {
    try { await step(); } catch (error) {
      failed.push(code);
      if (code === 'ANALYTICS_COMPACT_FAILED') {
        logAnalyticsFailure(error, code, { step: code });
        continue;
      }
      const tables = (error as { tables?: unknown } | null)?.tables;
      log('warn', { code: error instanceof ApiError ? error.code : code, step: code, ...(Array.isArray(tables) ? { tables } : {}) });
    }
  }
  return failed;
}
