import { sql } from 'drizzle-orm';
import type { Runtime, Actor } from '../core/types.js';
import { ApiError, ModuleLoadError } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import { wakeWebhooks } from '../jobs.js';
import { countScreened, terminalColumns, terminalEvents, finishCampaigns } from '../states.js';
import { productName } from '../brand.js';
import type { CampaignScreen } from '../screen.js';
import { sendingConnections } from '../domain-claims.js';
import type { ReadyConnection } from '../provider-credentials.js';
import { probationReason } from '../hosted-sending.js';
import type { EmailStatus, EmailSnapshot, CampaignDraft, ReviewedRecipient, emails } from '../db/sending.js';
import { idempotencyKey } from '../idempotency.js';
import { loadScreen, BatchInput } from './schemas.js';
import { materializeCampaignEmail, campaignVerdicts } from '../campaigns/materialize.js';
import { resolveHostedContentPolicy, sharedFormatRefusal, attachmentRows, verifiedAttachment } from './mime.js';
import { flushScreenObservability, admitEmails } from './front-door.js';
import { LINK_RECORD_RECHECK_MS } from '../campaigns/run.js';

/**
 * One of Nightmail's own account emails (src/account-notices.ts) from the platform workspace, through the ordinary
 * admission path: one transactional email per recipient, deduplicated by the idempotency key, charged to that workspace
 * like any send, with the product's name as the sender's. Its origin names the committed row it is about: standing:<event id>, billing:<notice id> or
 * notice:<account notice id>. It dispatches only from the configured platform workspace and only while that row exists
 * (the dispatcher's claim); it is not a general system bypass.
 */

const HELD_SCREEN_LIMIT = 300;
const HELD_SCREEN_CHUNK = 50;
const HELD_SCREEN_CONCURRENCY = 4;
const HELD_SCREEN_BUDGET_MS = 15_000;
const HELD_OUTAGE_ABORT = 4;

/** Background screen sweep outside the mail room (minute cron & Node runner): leases queued/scheduled rows held with
 *  `screened = false` (outage-held accepts, pre-deploy rows, rollout-window rows, or pre-deploy scheduled releases) in
 *  bounded chunks up to `limit` within `budgetMs`, screens them with the same outbound harm screen used at accept
 *  time, and either marks them `screened = true` (waking the mail room) or rejects them with the same status, error code
 *  and `email.rejected` webhook/event. Outages back off and abort the sweep early; logs one held-backlog summary line. */
export async function screenHeldMail(runtime: Runtime, limit = HELD_SCREEN_LIMIT, budgetMs = HELD_SCREEN_BUDGET_MS): Promise<{ leased: number; passed: number; rejected: number; deferred: number; remaining: number }> {
  const mx = runtime.config.multiTenant, started = Date.now(), deadline = started + budgetMs;
  type HeldRow = {
    id: string; workspace_id: string; region: string; actor_key_id: string; review_id: string | null; review_ordinal: number | null;
    campaign_id: string | null; from_address: string; to_addresses: string[]; cc_addresses: string[]; bcc_addresses: string[];
    subject: string; status: EmailStatus; provider_id: string | null; snapshot: EmailSnapshot; simulated: boolean; screened: boolean;
    attempt_started_at: string | null; error_code: string | null; suppression_reason: string | null; scheduled_at: string | null;
    dispatch_version: number; lease_until: string | null; account_pause_started_at: string | null; event_outcomes: number;
    created_at: string; updated_at: string;
    connection: (ReadyConnection & { pool_tier?: string; legacy_names?: boolean }) | null;
    on_probation: boolean; max_send_rate: number | null;
    review_version: number | null; review_draft: CampaignDraft | null; review_rendered: { html?: string; text?: string } | null;
    review_screen: CampaignScreen | null; review_hash: string | null; review_content_hash: string | null; review_recipient: ReviewedRecipient | null;
  };
  let leased = 0, passed = 0, rejected = 0, deferred = 0, consecutiveOutages = 0;
  const toWake = new Map<string, { region: string; accountId?: string; kind?: ReadyConnection['kind']; count: number; priority: boolean; maxSendRate?: number }>();
  const settings = runtime.config.screen;
  let screen: Awaited<ReturnType<typeof loadScreen>> | undefined;

  const processRow = async (r: HeldRow) => {
    const wid = r.workspace_id, id = r.id, ver = r.dispatch_version;
    const snapshot = r.snapshot;
    // The connection is read only on a multi-tenant installation, so a single-tenant one never has shared mail.
    const conn = r.connection, policy = resolveHostedContentPolicy(runtime.config, { shared: conn?.kind === 'shared', poolTier: conn?.pool_tier, legacyNames: conn?.legacy_names,
      from: snapshot.from, probation: r.on_probation, simulated: isSimulatedSes(runtime) || r.simulated, kind: snapshot.kind, screen: snapshot.screen });
    const { hosted, required, rules } = policy;

    // A row that could not be judged now (an outage, a failure of its own) waits 45 s out of oldest-first order so
    // failing rows never starve rows behind them while still coming due on the very next minute cron tick.
    const releaseHeld = async () => {
      deferred++;
      consecutiveOutages++;
      await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = clock_timestamp() + interval '45 seconds'
        WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened`);
    };
    const passHeld = async (nextSnapshot: EmailSnapshot, countHosted: boolean) => {
      const { rows: [updated] } = await runtime.db.execute<{ status: EmailStatus }>(sql`
        WITH moved AS (
          UPDATE sending_emails SET screened = true, lease_until = NULL, snapshot = ${JSON.stringify(nextSnapshot)}::jsonb, updated_at = clock_timestamp()
          WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened
          RETURNING status, workspace_id, to_addresses || cc_addresses || bcc_addresses AS recipients
        )
        ${countHosted ? sql`, screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM moved WHERE hosted_real_cost(recipients) > 0`)})` : sql``}
        SELECT status FROM moved`);
      if (!updated) return;
      passed++;
      consecutiveOutages = 0;
      if (updated.status === 'queued') {
        const key = `${conn?.aws_account_id ?? ''}:${r.region}`;
        const entry = toWake.get(key) ?? { region: r.region, accountId: conn?.aws_account_id, kind: conn?.kind, count: 0, priority: false, maxSendRate: typeof r.max_send_rate === 'number' && r.max_send_rate > 0 ? r.max_send_rate : undefined };
        entry.count++;
        entry.priority ||= nextSnapshot.kind === 'transactional';
        toWake.set(key, entry);
      }
    };
    const rejectHeld = async (code: string, screenData?: { spam: number; model: string; threshold: number }, countHosted = false) => {
      const { rows: [res] } = await runtime.db.execute<{ n: number; moved: number }>(sql`
        WITH rejected AS (
          UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
          WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened
          RETURNING ${terminalColumns}, to_addresses || cc_addresses || bcc_addresses AS recipients
        ), ${countHosted ? sql`screen_counted AS (${countScreened(sql`SELECT workspace_id, 1 AS rejected FROM rejected WHERE hosted_real_cost(recipients) > 0`)}), ` : sql``}
        ${terminalEvents(sql`SELECT * FROM rejected`, sql`${JSON.stringify({ providerCalled: false, ...(screenData ? { screen: screenData } : {}) })}::jsonb`)}
        SELECT (SELECT count(*)::int FROM webhook_jobs) AS n, (SELECT count(*)::int FROM rejected) AS moved`);
      if (!res?.moved) return;
      rejected++;
      consecutiveOutages = 0;
      if (res.n) await wakeWebhooks(runtime, res.n);
      if (screenData) log('warn', { code, emailId: id, workspaceId: wid, spam: screenData.spam, model: screenData.model });
      else log('warn', { code, emailId: id, workspaceId: wid });
      if (r.campaign_id) {
        await runtime.db.execute(finishCampaigns(sql`SELECT ${wid}::text AS workspace_id, ${r.campaign_id}::text AS campaign_id`));
      }
    };

    try {
      if (!policy.screened) { await passHeld(snapshot, false); return; }
      const refusal = sharedFormatRefusal(snapshot, policy);
      if (refusal) { await rejectHeld(refusal.code); return; }
      const scopedRt: Runtime = { ...runtime, config: { ...runtime.config, workspaceId: wid } };
      const a: Actor = { workspaceId: wid, keyId: r.actor_key_id, permissions: ['manage'], domains: [] };

      if (snapshot.deferredCampaign && r.review_id && r.campaign_id) {
        if (!r.review_draft || !r.review_rendered || !r.review_recipient || !r.review_content_hash) { await rejectHeld('CAMPAIGN_SNAPSHOT_INVALID'); return; }
        if (!settings) { await releaseHeld(); return; }
        const mailRow: typeof emails.$inferSelect = {
          id, workspaceId: wid, region: r.region, actorKeyId: r.actor_key_id, reviewId: r.review_id, reviewOrdinal: r.review_ordinal,
          campaignId: r.campaign_id, from: r.from_address, to: r.to_addresses, cc: r.cc_addresses, bcc: r.bcc_addresses,
          subject: r.subject, status: r.status, providerId: r.provider_id, snapshot, simulated: r.simulated, screened: r.screened,
          attemptStartedAt: r.attempt_started_at, errorCode: r.error_code, suppressionReason: r.suppression_reason,
          scheduledAt: r.scheduled_at, dispatchVersion: r.dispatch_version, leaseUntil: r.lease_until,
          accountPauseStartedAt: r.account_pause_started_at, eventOutcomes: r.event_outcomes, createdAt: r.created_at, updatedAt: r.updated_at,
        };
        const materialized = await materializeCampaignEmail(scopedRt, a, mailRow, {
          version: r.review_version ?? 1, draft: r.review_draft, rendered: r.review_rendered, contentHash: r.review_content_hash, recipient: r.review_recipient,
        }).catch(error => { if (error instanceof ApiError && error.code === 'LINK_RECORD_REQUIRED') return null; throw error; });
        // A campaign launched before link hosts whose sending domain has none active yet: the email waits, as its campaign
        // does (releaseStep), and is screened once the link host is active. Not an outage: the sweep goes on.
        if (!materialized) {
          deferred++;
          await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = clock_timestamp() + ${LINK_RECORD_RECHECK_MS}::float8 * interval '1 millisecond'
            WHERE workspace_id = ${wid} AND id = ${id} AND dispatch_version = ${ver} AND status IN ('queued', 'scheduled') AND NOT screened`);
          return;
        }
        const delivery = rules ? await import('../screened-html.js') : undefined;
        let copy = { ...materialized.keyed, to: [] as string[] };
        if (delivery) copy = delivery.hostedCopy(copy, rules === 'probation');
        const [verdict] = await campaignVerdicts(scopedRt, { workspaceId: wid, campaignId: r.campaign_id, reviewId: r.review_id }, [copy], Date.now() + 8000);
        if (!verdict) { await releaseHeld(); return; }
        if ('refused' in verdict) { await rejectHeld(verdict.refused.code); return; }
        const alreadyCounted = Boolean(r.review_screen?.template && r.review_screen.contentHash === r.review_hash);
        if (verdict.spam >= verdict.threshold) {
          await rejectHeld('CONTENT_REJECTED_SPAM', { spam: verdict.spam, model: verdict.model, threshold: verdict.threshold }, !alreadyCounted && hosted);
          return;
        }
        await passHeld({ ...snapshot, screenVerdict: { status: 'passed', spam: verdict.spam, model: verdict.model, digest: verdict.key, rules } }, !alreadyCounted && hosted);
        return;
      }

      let copy = snapshot;
      if (rules) {
        const delivery = await import('../screened-html.js');
        copy = delivery.hostedCopy(snapshot, rules === 'probation');
        if (snapshot.attachments.length) {
          const attRows = await attachmentRows(runtime.db, a, snapshot.attachments);
          for (const attRow of attRows) {
            const body = await verifiedAttachment(runtime, attRow);
            if (rules === 'standard') delivery.shownAttachment(attRow.filename, attRow.contentType, body, attRow.disposition === 'inline');
            else delivery.screenedAttachment(attRow.filename, attRow.contentType, body, attRow.disposition === 'inline');
          }
        }
      }
      if (!settings) {
        if (required) { await releaseHeld(); return; }
        await passHeld({ ...snapshot, screenVerdict: { status: 'skipped', rules } }, false);
        return;
      }
      screen ??= await loadScreen();
      const result = await screen.screenSnapshot(scopedRt, copy, required, { emailId: id, workspaceId: wid, region: r.region, kind: copy.kind, required });
      if (!result) { await releaseHeld(); return; }
      if (result.spam >= result.threshold && (required || settings.mode === 'reject')) {
        await rejectHeld('CONTENT_REJECTED_SPAM', { spam: result.spam, model: result.model, threshold: result.threshold }, hosted);
        return;
      }
      if (result.spam >= result.threshold) log('warn', { code: 'CONTENT_SPAM_SUSPECTED', workspaceId: wid, emailId: id, spam: result.spam, model: result.model });
      const nextSnap: EmailSnapshot = { ...(rules === 'probation' ? copy : snapshot), screenVerdict: { status: 'passed', spam: result.spam, model: result.model, digest: result.digest, rules } };
      await passHeld(nextSnap, hosted);
    } catch (error) {
      if (error instanceof ModuleLoadError) { await releaseHeld(); throw error; }
      if (error instanceof ApiError && !error.retryable && error.code !== 'CONTENT_SCREEN_UNAVAILABLE') {
        await rejectHeld(error.code);
        return;
      }
      await releaseHeld();
    }
  };

  while (leased < limit && Date.now() < deadline && consecutiveOutages < HELD_OUTAGE_ABORT) {
    const chunkLimit = Math.min(HELD_SCREEN_CHUNK, limit - leased);
    const { rows } = await runtime.db.execute<HeldRow>(sql`
      -- Rows not tried yet first, then the ones whose last try is oldest: a row that keeps failing goes to the back, so a
      -- few of them can never trip the outage abort ahead of every other held row.
      WITH due AS (
        SELECT workspace_id, id, lease_until AS tried FROM sending_emails
        WHERE status IN ('queued', 'scheduled') AND NOT screened
          AND (lease_until IS NULL OR lease_until < clock_timestamp())
        ORDER BY lease_until NULLS FIRST, created_at, id
        LIMIT ${chunkLimit}
        FOR UPDATE SKIP LOCKED
      ), leased AS (
        UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes'
        FROM due WHERE e.workspace_id = due.workspace_id AND e.id = due.id
        RETURNING e.*, due.tried
      )
      SELECT leased.id, leased.workspace_id, leased.region, leased.actor_key_id, leased.review_id, leased.review_ordinal,
        leased.campaign_id, leased.from_address, leased.to_addresses, leased.cc_addresses, leased.bcc_addresses,
        leased.subject, leased.status, leased.provider_id, leased.snapshot, leased.simulated, leased.screened,
        leased.attempt_started_at::text, leased.error_code, leased.suppression_reason, leased.scheduled_at::text,
        leased.dispatch_version, leased.lease_until::text, leased.account_pause_started_at::text, leased.event_outcomes,
        leased.created_at::text, leased.updated_at::text,
        ${mx ? sql`to_jsonb(pc)` : sql`NULL`} AS connection,
        ${mx ? sql`${probationReason(sql`leased.workspace_id`)} IS NOT NULL` : sql`false`} AS on_probation,
        ${mx ? sql`(SELECT l.max_send_rate FROM provider_account_limits l WHERE l.aws_account_id = pc.aws_account_id AND l.region = leased.region AND l.max_send_rate > 0)` : sql`(SELECT l.max_send_rate FROM sending_region_limits l WHERE l.workspace_id = leased.workspace_id AND l.region = leased.region AND l.max_send_rate > 0)`} AS max_send_rate,
        r.renderer_version AS review_version, r.draft AS review_draft, r.rendered AS review_rendered, r.screen AS review_screen, r.content_hash AS review_hash,
        CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.content_hash FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_content_hash,
        CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.recipient FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_recipient
      FROM leased
      ${mx ? sql`LEFT JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id = leased.workspace_id AND pc.region = leased.region` : sql``}
      LEFT JOIN sending_campaign_reviews r ON r.workspace_id = leased.workspace_id AND r.campaign_id = leased.campaign_id AND r.id = leased.review_id
      ORDER BY leased.tried NULLS FIRST, leased.created_at, leased.id`);
    if (!rows.length) break;

    let next = 0;
    const active = new Set<Promise<void>>();
    const beforeJudged = passed + rejected;
    try {
      while (next < rows.length || active.size) {
        // Each outstanding screen can still report an outage. Reserve its place in the abort window
        // before starting another row; a fast failure must not launch a fifth behind three slow ones.
        while (next < rows.length && active.size < Math.min(HELD_SCREEN_CONCURRENCY, HELD_OUTAGE_ABORT - consecutiveOutages) && Date.now() < deadline) {
          const task: Promise<void> = processRow(rows[next++]!).finally(() => active.delete(task));
          active.add(task);
        }
        if (!active.size) break;
        await Promise.race(active);
      }
    } finally {
      await Promise.allSettled(active);
      const unattempted = rows.slice(next);
      if (unattempted.length) {
        await runtime.db.execute(sql`UPDATE sending_emails e SET lease_until = NULL
          FROM jsonb_to_recordset(${JSON.stringify(unattempted.map(r => ({ workspace_id: r.workspace_id, id: r.id, dispatch_version: r.dispatch_version })))}::jsonb)
            AS x(workspace_id text, id text, dispatch_version int)
          WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.dispatch_version = x.dispatch_version
            AND e.status IN ('queued', 'scheduled') AND NOT e.screened`).catch(() => {});
      }
      leased += rows.length - unattempted.length;
    }
    if (rows.length < chunkLimit || next < rows.length || passed + rejected === beforeJudged) break;
  }

  if (leased > 0) await flushScreenObservability(runtime).catch(() => {});
  for (const target of toWake.values()) {
    try { await runtime.dispatch?.(target.region, target.accountId, target.count, target.kind, target.priority, target.maxSendRate); }
    catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', region: target.region, message: 'Screened mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  }
  const { rows: [backlog] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM sending_emails WHERE status IN ('queued', 'scheduled') AND NOT screened`);
  const remaining = backlog?.n ?? 0;
  if (leased > 0 || remaining > 0) {
    log(remaining > 0 ? 'warn' : 'info', { code: 'HELD_SCREEN_SWEEP', leased, passed, rejected, deferred, remaining, ms: Date.now() - started });
  }
  return { leased, passed, rejected, deferred, remaining };
}

export async function sendSystemEmail(runtime: Runtime, workspaceId: string, mail: { from: string; to: string[]; subject: string; text: string; html?: string; idempotencyKey: string; sealed?: boolean } & ({ standingEvent: string } | { billingNotice: string } | { notice: string })) {
  const origin = 'standingEvent' in mail ? `standing:${mail.standingEvent}` : 'billingNotice' in mail ? `billing:${mail.billingNotice}` : `notice:${mail.notice}`;
  const a: Actor = { workspaceId, keyId: origin, permissions: ['send'], domains: [], credential: 'apiKey' };
  const input = BatchInput.parse({ emails: mail.to.map(to => ({ from: mail.from, fromName: productName, to: [to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), kind: 'transactional' })) });
  return admitEmails({ runtime, path: '/v1/emails/batch', key: idempotencyKey(mail.idempotencyKey) }, a, input, undefined, mail.sealed);
}
