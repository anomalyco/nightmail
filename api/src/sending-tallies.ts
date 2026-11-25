import { sql } from 'drizzle-orm';
import { log, logError, type DbExecutor, type Runtime } from './core.js';

/** Triggers whose active presence guarantees sending_campaign_tallies and sending_metrics_hourly stay in sync. */
const TALLY_TRIGGERS = ['sending_tally_insert', 'sending_tally_update', 'sending_tally_delete'] as const;

/** Rows per bounded fold call and maximum iterations per minute run. */
export const FOLD_BATCH_LIMIT = 50_000;
const FOLD_MAX_PASSES = 10;
/** Log an error when unfolded delta rows exceed this threshold after a fold pass. */
export const UNFOLDED_ALERT_THRESHOLD = 25_000;

/**
 * True while all three sending_emails tally triggers are installed and enabled.
 * Dropping or disabling any of them (the one-statement emergency undo) immediately turns this false so reads fall back
 * to the live sending_emails queries behind budgetedRead without a deploy. One catalog index probe (~0.03 ms).
 */
const enabledTriggers = sql`(SELECT count(*)=3 FROM pg_trigger WHERE tgrelid='sending_emails'::regclass
  AND tgname=ANY(${sql.param([...TALLY_TRIGGERS])}::text[]) AND tgenabled<>'D')`;
export async function talliesEnabled(db: DbExecutor): Promise<boolean> {
  const { rows: [row] } = await db.execute<{ ok: boolean }>(sql`SELECT ${enabledTriggers} AS ok`);
  return row?.ok === true;
}

/**
 * Folds delta rows in sending_campaign_tallies and sending_metrics_hourly in bounded chunks (migration 407).
 * Safe to call every minute: each statement takes an advisory try-lock, never blocks email writers, and stops once the
 * batch limit or time budget is reached. Logs SENDING_TALLIES_UNFOLDED_HIGH at error level if unfolded deltas stay
 * above UNFOLDED_ALERT_THRESHOLD (e.g. if the minute fold stopped running during a large send).
 */
export async function foldSendingTallies(runtime: Runtime, budgetMs = 10_000, clock = Date.now) {
  const until = clock() + budgetMs;
  let campaignRemoved = 0, campaignKept = 0, campaignUnfolded = 0;
  let metricsRemoved = 0, metricsKept = 0, metricsUnfolded = 0;
  let tenMinuteRemoved = 0, tenMinuteKept = 0, tenMinuteUnfolded = 0;
  let deliverabilityRemoved = 0, deliverabilityKept = 0, deliverabilityUnfolded = 0;

  // Alternate bounded slices between campaign tallies, hourly metrics, 10-minute metrics and the platform's
  // deliverability rollup (migration 525) so a large backlog in one table never starves the others within the budget.
  let campaignMore = true, metricsMore = true, tenMinuteMore = true, deliverabilityMore = true;
  for (let pass = 0; pass < FOLD_MAX_PASSES && (campaignMore || metricsMore || tenMinuteMore || deliverabilityMore) && clock() < until; pass++) {
    if (campaignMore && clock() < until) {
      const { rows: [c] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
        sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_sending_campaign_tallies(${FOLD_BATCH_LIMIT})`
      );
      const removed = Number(c?.removed_rows ?? 0), kept = Number(c?.kept_rows ?? 0);
      campaignRemoved += removed; campaignKept += kept; campaignUnfolded = Number(c?.unfolded_rows ?? 0);
      if (removed < FOLD_BATCH_LIMIT || campaignUnfolded === 0) campaignMore = false;
    }
    if (metricsMore && clock() < until) {
      const { rows: [m] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
        sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_sending_metrics_hourly(${FOLD_BATCH_LIMIT})`
      );
      const removed = Number(m?.removed_rows ?? 0), kept = Number(m?.kept_rows ?? 0);
      metricsRemoved += removed; metricsKept += kept; metricsUnfolded = Number(m?.unfolded_rows ?? 0);
      if (removed < FOLD_BATCH_LIMIT || metricsUnfolded === 0) metricsMore = false;
    }
    if (tenMinuteMore && clock() < until) {
      const { rows: [tm] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
        sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_sending_metrics_ten_minute(${FOLD_BATCH_LIMIT})`
      );
      const removed = Number(tm?.removed_rows ?? 0), kept = Number(tm?.kept_rows ?? 0);
      tenMinuteRemoved += removed; tenMinuteKept += kept; tenMinuteUnfolded = Number(tm?.unfolded_rows ?? 0);
      if (removed < FOLD_BATCH_LIMIT || tenMinuteUnfolded === 0) tenMinuteMore = false;
    }
    if (deliverabilityMore && clock() < until) {
      const { rows: [d] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
        sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_deliverability_hourly(${FOLD_BATCH_LIMIT})`
      );
      const removed = Number(d?.removed_rows ?? 0), kept = Number(d?.kept_rows ?? 0);
      deliverabilityRemoved += removed; deliverabilityKept += kept; deliverabilityUnfolded = Number(d?.unfolded_rows ?? 0);
      if (removed < FOLD_BATCH_LIMIT || deliverabilityUnfolded === 0) deliverabilityMore = false;
    }
  }

  if (campaignUnfolded > UNFOLDED_ALERT_THRESHOLD || metricsUnfolded > UNFOLDED_ALERT_THRESHOLD || tenMinuteUnfolded > UNFOLDED_ALERT_THRESHOLD || deliverabilityUnfolded > UNFOLDED_ALERT_THRESHOLD) {
    log('error', {
      code: 'SENDING_TALLIES_UNFOLDED_HIGH',
      threshold: UNFOLDED_ALERT_THRESHOLD,
      campaignUnfolded,
      metricsUnfolded,
      tenMinuteUnfolded,
      deliverabilityUnfolded,
      campaignFolded: campaignRemoved - campaignKept,
      metricsFolded: metricsRemoved - metricsKept,
      tenMinuteFolded: tenMinuteRemoved - tenMinuteKept,
    });
  }
  return {
    campaignRemoved, campaignKept, campaignUnfolded,
    metricsRemoved, metricsKept, metricsUnfolded,
    tenMinuteRemoved, tenMinuteKept, tenMinuteUnfolded,
    deliverabilityRemoved, deliverabilityKept, deliverabilityUnfolded,
  };
}

const RECOUNT_STATEMENT_SECONDS = 30;
const RECOUNT_CAMPAIGN_BATCH = 5;
const RECOUNT_WORKSPACE_BATCH = 1;

/**
 * Daily exact recount (durable election in job_schedule) of sending_campaign_tallies and sending_metrics_hourly.
 * Compares live sending_emails against stored tallies in one snapshot per item (no locks that email writers wait on),
 * inserts any difference so reads become exact again, and logs CAMPAIGN_TALLIES_DRIFT / METRICS_HOURLY_DRIFT at error
 * level: any difference is a bug.
 */
export async function recountSendingTallies(runtime: Runtime, budgetMs = 60_000, clock = Date.now) {
  const until = clock() + budgetMs;
  if (!await talliesEnabled(runtime.db)) return { campaignsCorrected: 0, workspacesCorrected: 0 };

  const { rows: elected } = await runtime.db.execute<{ ok: number }>(sql`INSERT INTO job_schedule(workspace_id, next_wake_at)
    VALUES ('maintenance:sending-tallies', now() + interval '1 day')
    ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at = excluded.next_wake_at
    WHERE job_schedule.next_wake_at <= now() RETURNING 1 AS ok`);
  if (!elected.length) return { campaignsCorrected: 0, workspacesCorrected: 0 };

  const { rows: campaignTargets } = await runtime.db.execute<{ workspace_id: string; id: string }>(sql`
    SELECT workspace_id, campaign_id AS id
    FROM (
      SELECT workspace_id, campaign_id FROM sending_campaign_tallies
      UNION
      SELECT workspace_id, id AS campaign_id FROM sending_campaigns WHERE review_id IS NOT NULL AND updated_at >= now() - interval '35 days'
    ) c
    ORDER BY md5(c.campaign_id || current_date::text)`);

  const { rows: workspaceTargets } = await runtime.db.execute<{ workspace_id: string }>(sql`
    SELECT workspace_id
    FROM (
      SELECT workspace_id FROM sending_metrics_hourly
      UNION
      SELECT workspace_id FROM sending_metrics_ten_minute
      UNION
      SELECT id AS workspace_id FROM workspaces
    ) w
    ORDER BY md5(w.workspace_id || current_date::text)`);

  let campaignsRecounted = 0, campaignsCorrected = 0, campaignsFailed = 0;
  for (let i = 0; i < campaignTargets.length && clock() < until; i += RECOUNT_CAMPAIGN_BATCH) {
    const batch = campaignTargets.slice(i, i + RECOUNT_CAMPAIGN_BATCH);
    try {
      const { rows } = await runtime.db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${RECOUNT_STATEMENT_SECONDS}s'`));
        return tx.execute<{ workspace_id: string; id: string; status: string; simulated: boolean; email_count: string; accepted: string; delivered: string; bounced: string; complained: string; opened: string; clicked: string; failed: string; delivery_delayed: string }>(
          sql`SELECT c.workspace_id, c.id, r.*
            FROM unnest(${sql.param(batch.map(x => x.workspace_id))}::text[], ${sql.param(batch.map(x => x.id))}::text[]) c(workspace_id, id),
                 reconcile_sending_campaign_tallies(c.workspace_id, c.id) r`
        );
      });
      campaignsRecounted += batch.length;
      if (rows.length) {
        const seen = new Set<string>();
        for (const row of rows) {
          seen.add(`${row.workspace_id}:${row.id}`);
          log('error', {
            code: 'CAMPAIGN_TALLIES_DRIFT', workspace: row.workspace_id, campaign: row.id,
            status: row.status, simulated: row.simulated,
            emailCount: Number(row.email_count), accepted: Number(row.accepted), delivered: Number(row.delivered),
            bounced: Number(row.bounced), complained: Number(row.complained), opened: Number(row.opened),
            clicked: Number(row.clicked), failed: Number(row.failed), deliveryDelayed: Number(row.delivery_delayed),
          });
        }
        campaignsCorrected += seen.size;
      }
    } catch (error) {
      campaignsFailed += batch.length;
      logError(error, { code: 'CAMPAIGN_TALLIES_RECOUNT_FAILED' }, 'warn');
    }
  }

  let workspacesRecounted = 0, workspacesCorrected = 0, workspacesFailed = 0;
  for (let i = 0; i < workspaceTargets.length && clock() < until; i += RECOUNT_WORKSPACE_BATCH) {
    const batch = workspaceTargets.slice(i, i + RECOUNT_WORKSPACE_BATCH);
    try {
      const { rows } = await runtime.db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${RECOUNT_STATEMENT_SECONDS}s'`));
        return tx.execute<{ workspace_id: string; region: string; kind: string; hour: string; emails: string; accepted: string; delivered: string; bounced: string; complained: string; opened: string; clicked: string; failed: string; delivery_delayed: string; simulated: string }>(
          sql`SELECT w.workspace_id, r.*
            FROM unnest(${sql.param(batch.map(x => x.workspace_id))}::text[]) w(workspace_id),
                 reconcile_sending_metrics_hourly(w.workspace_id) r`
        );
      });
      workspacesRecounted += batch.length;
      if (rows.length) {
        const seen = new Set<string>();
        for (const row of rows) {
          seen.add(row.workspace_id);
          log('error', {
            code: 'METRICS_HOURLY_DRIFT', workspace: row.workspace_id, region: row.region, kind: row.kind, hour: row.hour,
            emails: Number(row.emails), accepted: Number(row.accepted), delivered: Number(row.delivered),
            bounced: Number(row.bounced), complained: Number(row.complained), opened: Number(row.opened),
            clicked: Number(row.clicked), failed: Number(row.failed), deliveryDelayed: Number(row.delivery_delayed),
            simulated: Number(row.simulated),
          });
        }
        workspacesCorrected += seen.size;
      }
    } catch (error) {
      workspacesFailed += batch.length;
      logError(error, { code: 'METRICS_HOURLY_RECOUNT_FAILED' }, 'warn');
    }

    // Reconcile the 6-day 10-minute rollup alongside hourly so any deploy-window or runtime drift heals promptly.
    try {
      const { rows: tenMinRows } = await runtime.db.transaction(async tx => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${RECOUNT_STATEMENT_SECONDS}s'`));
        return tx.execute<{ workspace_id: string; region: string; kind: string; bucket: string; emails: string; accepted: string; delivered: string; bounced: string; complained: string; opened: string; clicked: string; failed: string; delivery_delayed: string; simulated: string }>(
          sql`SELECT w.workspace_id, r.*
            FROM unnest(${sql.param(batch.map(x => x.workspace_id))}::text[]) w(workspace_id),
                 reconcile_sending_metrics_ten_minute(w.workspace_id) r`
        );
      });
      if (tenMinRows.length) {
        const seen = new Set<string>();
        for (const row of tenMinRows) {
          seen.add(row.workspace_id);
          log('error', {
            code: 'METRICS_TEN_MINUTE_DRIFT', workspace: row.workspace_id, region: row.region, kind: row.kind, bucket: row.bucket,
            emails: Number(row.emails), accepted: Number(row.accepted), delivered: Number(row.delivered),
            bounced: Number(row.bounced), complained: Number(row.complained), opened: Number(row.opened),
            clicked: Number(row.clicked), failed: Number(row.failed), deliveryDelayed: Number(row.delivery_delayed),
            simulated: Number(row.simulated),
          });
        }
        workspacesCorrected += seen.size;
      }
    } catch (error) {
      workspacesFailed += batch.length;
      logError(error, { code: 'METRICS_TEN_MINUTE_RECOUNT_FAILED' }, 'warn');
    }
  }

  // Prune 10-minute rollup rows past the 7-day rolling retention window (bounded index scan on bucket).
  if (clock() < until) {
    try {
      await runtime.db.execute(sql`DELETE FROM sending_metrics_ten_minute WHERE bucket < now() - interval '7 days'`);
    } catch (error) {
      logError(error, { code: 'METRICS_TEN_MINUTE_PRUNE_FAILED' }, 'warn');
    }
  }
  // Glass's deliverability history (migrations 525, 529, 530): 120 days, so the 30-day board always has the 30 days before.
  if (clock() < until) {
    try {
      await runtime.db.execute(sql`DELETE FROM deliverability_hourly WHERE hour < now() - interval '120 days'`);
      await runtime.db.execute(sql`DELETE FROM deliverability_vdm_daily WHERE day < current_date - 120`);
      await runtime.db.execute(sql`DELETE FROM deliverability_postmaster_daily WHERE day < current_date - 120`);
    } catch (error) {
      logError(error, { code: 'DELIVERABILITY_PRUNE_FAILED' }, 'warn');
    }
  }

  if (campaignTargets.length || workspaceTargets.length) {
    log(campaignsFailed || workspacesFailed ? 'warn' : 'info', {
      code: 'SENDING_TALLIES_RECOUNTED',
      campaigns: campaignTargets.length, campaignsRecounted, campaignsCorrected, campaignsFailed,
      workspaces: workspaceTargets.length, workspacesRecounted, workspacesCorrected, workspacesFailed,
    });
  }
  return { campaignsCorrected, workspacesCorrected };
}

// Page probes use existing B-trees. A high estimate for the JSON expression can otherwise JIT-compile a tiny indexed read.
const AUDIT_LIMITS = sql`SELECT set_config('lock_timeout','150ms',true),set_config('statement_timeout','1500ms',true),
  set_config('max_parallel_workers_per_gather','0',true),set_config('jit','off',true)`;
type AuditClaim = { after_id: string; page_size: number; fence: string };
type AuditGroup = { workspace_id: string; last_id: string; checked: number; drifted: number; in_campaigns: number; extra_bits: number; missing_bits: number };

/** Minute maintenance, outside the hourly upkeep window. Check one bounded page and checkpoint only a successful
 *  read. A timeout or lost invocation retries the same cursor with a smaller page; nothing locks customer rows. */
export async function auditSendingOutcomePage(runtime: Pick<Runtime, 'db'>, now = Date.now()) {
  const idle = { checked: 0, drifted: 0 };
  if (new Date(now).getUTCMinutes() < 15) return idle;
  try {
    const claim = await runtime.db.transaction(async tx => {
      await tx.execute(AUDIT_LIMITS);
      const { rows: [c] } = await tx.execute<AuditClaim>(sql`WITH due AS MATERIALIZED (
        SELECT after_id,page_size FROM sending_outcome_audit_state WHERE singleton AND next_at<=now() AND ${enabledTriggers} FOR UPDATE SKIP LOCKED)
        UPDATE sending_outcome_audit_state s SET pass_started_at=coalesce(s.pass_started_at,now()),
          next_at=greatest(date_trunc('minute',now())+interval '1 minute',now()+interval '5 seconds'),page_size=greatest(1,due.page_size/2)
        FROM due WHERE s.singleton RETURNING due.after_id,due.page_size,s.next_at::text AS fence`);
      return c;
    });
    if (!claim) return idle;
    const groups = await runtime.db.transaction(async tx => {
      await tx.execute(AUDIT_LIMITS);
      const started = performance.now();
      const { rows } = await tx.execute<AuditGroup>(sql`SELECT * FROM check_sending_event_outcome_page(${claim.after_id},${claim.page_size})`);
      const finished = rows.reduce((n, row) => n + row.checked, 0) < claim.page_size;
      const size = finished ? 2048 : performance.now() - started < 500 ? Math.min(2048, claim.page_size * 2) : claim.page_size;
      const moved = await tx.execute(sql`UPDATE sending_outcome_audit_state SET after_id=${finished ? '' : rows[0]!.last_id},page_size=${size},
        next_at=CASE WHEN ${finished} THEN greatest(next_at,pass_started_at+interval '1 day') ELSE next_at END,
        pass_started_at=CASE WHEN ${finished} THEN NULL ELSE pass_started_at END WHERE singleton AND next_at=${claim.fence}::timestamptz`);
      return moved.rowCount ? rows : [];
    });
    for (const row of groups) if (row.drifted) log('error', { code: 'SENDING_EVENT_OUTCOMES_DRIFT', workspace: row.workspace_id,
      emailsWithOtherBits: row.drifted, inCampaigns: row.in_campaigns, extraBits: row.extra_bits, missingBits: row.missing_bits });
    return groups.reduce((r, row) => ({ checked: r.checked + row.checked, drifted: r.drifted + row.drifted }), idle);
  } catch (error) {
    logError(error, { code: 'SENDING_EVENT_OUTCOMES_CHECK_FAILED' }, 'warn');
    return idle;
  }
}
