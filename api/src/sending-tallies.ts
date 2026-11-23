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
export async function talliesEnabled(db: DbExecutor): Promise<boolean> {
  const { rows: [row] } = await db.execute<{ ok: boolean }>(sql`SELECT count(*) = 3 AS ok
    FROM pg_trigger
    WHERE tgrelid = 'sending_emails'::regclass
      AND tgname = ANY(${sql.param([...TALLY_TRIGGERS])}::text[])
      AND tgenabled <> 'D'`);
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

  for (let pass = 0; pass < FOLD_MAX_PASSES && clock() < until; pass++) {
    const { rows: [c] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
      sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_sending_campaign_tallies(${FOLD_BATCH_LIMIT})`
    );
    const removed = Number(c?.removed_rows ?? 0), kept = Number(c?.kept_rows ?? 0);
    campaignRemoved += removed; campaignKept += kept; campaignUnfolded = Number(c?.unfolded_rows ?? 0);
    if (removed < FOLD_BATCH_LIMIT || campaignUnfolded === 0) break;
  }

  for (let pass = 0; pass < FOLD_MAX_PASSES && clock() < until; pass++) {
    const { rows: [m] } = await runtime.db.execute<{ removed_rows: number; kept_rows: number; unfolded_rows: string }>(
      sql`SELECT removed_rows, kept_rows, unfolded_rows FROM fold_sending_metrics_hourly(${FOLD_BATCH_LIMIT})`
    );
    const removed = Number(m?.removed_rows ?? 0), kept = Number(m?.kept_rows ?? 0);
    metricsRemoved += removed; metricsKept += kept; metricsUnfolded = Number(m?.unfolded_rows ?? 0);
    if (removed < FOLD_BATCH_LIMIT || metricsUnfolded === 0) break;
  }

  if (campaignUnfolded > UNFOLDED_ALERT_THRESHOLD || metricsUnfolded > UNFOLDED_ALERT_THRESHOLD) {
    log('error', {
      code: 'SENDING_TALLIES_UNFOLDED_HIGH',
      threshold: UNFOLDED_ALERT_THRESHOLD,
      campaignUnfolded,
      metricsUnfolded,
      campaignFolded: campaignRemoved - campaignKept,
      metricsFolded: metricsRemoved - metricsKept,
    });
  }
  return {
    campaignRemoved, campaignKept, campaignUnfolded,
    metricsRemoved, metricsKept, metricsUnfolded,
  };
}

const RECOUNT_STATEMENT_SECONDS = 30;
const RECOUNT_CAMPAIGN_BATCH = 20;
const RECOUNT_WORKSPACE_BATCH = 10;

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
        return tx.execute<{ workspace_id: string; region: string; kind: string; hour: string; topic_arn: string; emails: string; accepted: string; delivered: string; bounced: string; complained: string; opened: string; clicked: string; failed: string; delivery_delayed: string; simulated: string; real_emails: string; real_accepted: string; real_delivered: string; real_bounced: string; real_first_sends: string; real_first_bounced: string; real_complained: string; real_suppressed: string; real_marketing_delivered: string; real_marketing_clicked: string }>(
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
            code: 'METRICS_HOURLY_DRIFT', workspace: row.workspace_id, region: row.region, kind: row.kind, hour: row.hour, topicArn: row.topic_arn,
            emails: Number(row.emails), accepted: Number(row.accepted), delivered: Number(row.delivered),
            bounced: Number(row.bounced), complained: Number(row.complained), opened: Number(row.opened),
            clicked: Number(row.clicked), failed: Number(row.failed), deliveryDelayed: Number(row.delivery_delayed),
            simulated: Number(row.simulated),
            realEmails: Number(row.real_emails), realAccepted: Number(row.real_accepted), realDelivered: Number(row.real_delivered),
            realBounced: Number(row.real_bounced), realFirstSends: Number(row.real_first_sends), realFirstBounced: Number(row.real_first_bounced),
            realComplained: Number(row.real_complained), realSuppressed: Number(row.real_suppressed),
            realMarketingDelivered: Number(row.real_marketing_delivered), realMarketingClicked: Number(row.real_marketing_clicked),
          });
        }
        workspacesCorrected += seen.size;
      }
    } catch (error) {
      workspacesFailed += batch.length;
      logError(error, { code: 'METRICS_HOURLY_RECOUNT_FAILED' }, 'warn');
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
