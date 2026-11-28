import { stopDeadDomains, planWindowHealthy, planHeldWhy, stoppedDomains } from '../send-guards.js';
import { sql, and, isNotNull, inArray } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { digest, AudienceSpec, rowId } from '../core/http.js';
import type { Runtime, Actor, JobHandler } from '../core/types.js';
import { ApiError, wrapModuleLoad, ModuleLoadError } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import { JobDeferred, MAX_ATTEMPTS, wakeWebhooks } from '../jobs.js';
import { runningState, recordPrepared, finishCampaigns, holdCampaign, quarantineCampaign, pauseCampaign, restartRampWindow, skipProbe, waitProbe, clearProbe, noteHealthChecked, setRamp, recordExpanded, CAMPAIGN_RUNNING, startSending, failCampaign } from '../states.js';
import { lockSendScope } from '../send-scope.js';
import { type CampaignDraft, emails } from '../db/sending.js';
import { validMailAddressSql, postalAddressOf } from '../outbound-content.js';
import { linkChoice, linkAllowance, recordLinkUse } from '../link-domains.js';
import { canonical } from '../idempotency.js';
import { admission, actorJson, admitted, type Admitted, type Refused, type Released } from '../admission.js';
import { RATES } from '../billing/money.js';
import { rampLines, rampStart, RAMP, RAMP_HOUR_MS } from '../standing-model.js';
import { loadParse5, unsubscribePlaceholder, findCampaign, loadScreen, probeSize, captureTimedOut, CAMPAIGN_PREPARE_BYTES, campaignBuffer, workspaceBuffer, QUOTA_REFRESH_MS, sesDailyReserve, customerCredits, CAMPAIGN_EXPAND_ROWS, drainDelayMs, dailyCap, DAY_MS, PROBE, AUTO_PAUSE, firstBatchWait, RAMP_CHECK, RELEASE_INTERVAL_MS, RELEASE_BURST_MS, limitsTable, scope, now } from '../sending/schemas.js';
import { originAllowed, FEEDBACK_LAG_HOLD_MS } from '../sending/events.js';
import { listMailedCleanly, campaignHealth, rampHistory, rampBatch, rampHealth } from './stats.js';
import { campaignMessage } from './views.js';
import { keyedOrigin, type RunRow, campaignScreened, currentScreen, screenCampaignStep, campaignRejected, placeholderKeys, reviewedMail, recipientChunk, staleReview, SCREEN_AHEAD, screenAhead, saveScreen, isSupportedContentHash, unsupportedHashFormat, readRun } from './materialize.js';
import { type AttachmentFacts, validateInterpolationTemplate, validateHtmlUrls, sizeCheck, withPreheader } from '../sending/mime.js';
import { marketingFooter, actorAssets, campaignTopic, requiredNoticesAllowed } from '../sending/front-door.js';
import { campaignRef, cancelCampaignWork, reserveCampaign, deliveredBefore, backgroundFailure } from './launch.js';

const STATIC_PREPARE_SLICE_ROWS = 200_000;

/** Validates a static campaign once and computes the shared s1: base digest and JSON byte size (excluding recipient to). */
async function prepareStaticStamp(
  runtime: Runtime,
  draft: CampaignDraft,
  rendered: { html?: string; text?: string },
  lockedAttachments: AttachmentFacts[],
  reviewVersion: number,
) {
  const parse = rendered.html ? await loadParse5() : undefined;
  validateInterpolationTemplate(draft.subject, false);
  validateInterpolationTemplate(rendered.html, true, parse);
  validateInterpolationTemplate(rendered.text, false);
  await validateHtmlUrls(rendered.html);
  // Build once with a longest-shape valid recipient address (254 bytes) to verify SendInput, headers and MIME sizeCheck.
  const longestValid = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  const staticSnapshot = await campaignMessage(runtime, draft, { id: 'static', email: longestValid, properties: {} }, false, lockedAttachments, rendered, true, true, reviewVersion);
  const baseHash = await digest(canonical({ ...staticSnapshot, to: [] }));
  const withFooter = { ...staticSnapshot, headers: [...staticSnapshot.headers] };
  marketingFooter(withFooter, unsubscribePlaceholder(keyedOrigin(runtime, draft)), draft);
  sizeCheck(withFooter, lockedAttachments);
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...withFooter, to: [] }), 'utf8');
  return {
    baseHash,
    baseBytes,
    storedSubject: staticSnapshot.subject === draft.subject ? null : staticSnapshot.subject,
  };
}

/**
 * Transaction 2 of background capture (normal READ COMMITTED, milliseconds): locks send scope + campaign row,
 * reconciles recipient reservation for any delta against the initial estimate, updates Hosted screen_budget if needed,
 * records the exact frozen total/prepared cursors, and advances state via runningState(). Idempotent across crashes
 * between Tx 1 commit and Tx 2 commit.
 */
async function finalizeCapture(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const ref = campaignRef(a, row.id);
  const hosted = row.account?.kind === 'shared';
  await runtime.db.transaction(async db => {
    const held = await lockSendScope(db, a.workspaceId, { campaignId: row.id });
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return;
    const [rev] = (await db.execute<{ captured_at: string | null; captured_count: number | null; static_prepared: boolean }>(sql`
      SELECT captured_at::text, captured_count, static_prepared FROM sending_campaign_reviews WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`)).rows;
    if (!rev?.captured_at || rev.captured_count === null) return;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: row.review.draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return; }
    // Delta is > 0 when onProgress skipped under pool contention (leaving campaign.total at its initial estimate).
    const delta = Math.max(0, rev.captured_count - campaign.total);
    try {
      await reserveCampaign(runtime, db, held, a, a.keyId, delta);
    } catch (error) {
      // A pending/recipient limit refusal after the 202 must fail the campaign immediately (leaving the draft editable)
      // rather than retrying 6 times over ~81 minutes while the campaign looks stuck in preparing.
      if (error instanceof ApiError && (error.code === 'CAMPAIGN_PENDING_LIMIT_EXCEEDED' || error.code.endsWith('_LIMIT_EXCEEDED'))) {
        throw new ApiError(error.status, error.code, error.message, error.field, false);
      }
      throw error;
    }
    if (campaignScreened(runtime, hosted)) {
      const limits = runtime.config.screenLimits, screen = await loadScreen();
      const needed = (rev.captured_count + 10) * screen.chunksFor(limits.campaignBytes);
      await db.execute(sql`UPDATE sending_campaign_reviews SET screen_budget = greatest(coalesce(screen_budget, 0), ${needed}) WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
    }
    const prepared = rev.static_prepared ? rev.captured_count : 0;
    const next = runningState({ prepared, total: rev.captured_count, scheduledAt: campaign.scheduledAt });
    const set = sql`,total=${rev.captured_count},prepared=${prepared}`;
    await db.execute(next === 'preparing' ? sql`UPDATE sending_campaigns SET updated_at=now()${set} WHERE workspace_id=${a.workspaceId} AND id=${row.id} AND state='preparing' RETURNING id`
      : sql`UPDATE sending_campaigns SET state=${next},updated_at=now()${set} WHERE workspace_id=${a.workspaceId} AND id=${row.id} AND state='preparing' RETURNING id`);
    await db.execute(sql`UPDATE sending_campaign_reviews SET captured_count = NULL WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
    log('info', { code: 'CAMPAIGN_CAPTURE_FINALIZED', jobId, campaignId: campaign.id, total: rev.captured_count, prepared, staticPrepared: rev.static_prepared, nextState: next });
  });
}

/**
 * Background audience freeze for large campaigns (>5,000 list members).
 * Runs inside ONE REPEATABLE READ transaction so the frozen set is a single consistent MVCC snapshot even when contacts
 * unsubscribe or imports commit concurrently. Inserts run in bounded 200,000-row slices (each <= ~3 s on lab), reporting
 * live progress on a separate pool connection without touching sending_campaigns inside the REPEATABLE READ transaction
 * (avoiding 40001 conflicts). Static campaigns validate addresses and stamp s1: content_hash inline during capture.
 */
async function captureStep(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const screenState = campaignScreened(runtime, row.account?.kind === 'shared') ? currentScreen(row) : undefined;
  if (screenState !== undefined && screenState?.template?.threshold === undefined) return screenCampaignStep(runtime, a, row);
  if (screenState?.template && screenState.template.spam >= screenState.template.threshold!) return campaignRejected(runtime, a, row, screenState);

  const review = row.review;
  const draft = review.draft;
  const parsedAudience = AudienceSpec.safeParse(draft.audience);
  if (!parsedAudience.success || !draft.from || !draft.subject) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen campaign draft is incomplete.');
  const audienceSpec = parsedAudience.data;
  const propertyKeys = placeholderKeys(draft, review.rendered);
  const messageStatic = ![draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));

  // Verify origin + admission + attachments before starting the REPEATABLE READ capture transaction.
  const prepCheck = await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return null;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return null; }
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'prepare', locks: 'none', mails: [reviewedMail(draft)] }, undefined, actorAssets(a, draft.attachments));
    const lockedAttachments = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId, { retryable: ['SES_SETUP_REQUIRED'] }).assets;
    // Verify the review is still uncaptured before clearing stale progress from an interrupted attempt (guards against
    // a stalled run resetting a capture that another attempt already finished).
    const [revCheck] = (await db.execute<{ captured_at: string | null }>(sql`SELECT captured_at::text FROM sending_campaign_reviews WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`)).rows;
    if (!revCheck || revCheck.captured_at !== null) return null;
    if (campaign.prepared > 0) await db.execute(sql`UPDATE sending_campaigns SET prepared = 0, updated_at = now() WHERE workspace_id = ${a.workspaceId} AND id = ${row.id} AND state = 'preparing' AND review_id = ${row.reviewId}`);
    return { lockedAttachments };
  });
  if (!prepCheck) return;

  const staticStamp = messageStatic
    ? await prepareStaticStamp(runtime, draft, review.rendered, prepCheck.lockedAttachments, review.version)
    : undefined;
  const audienceMod = await wrapModuleLoad(() => import('../audience/counts.js'));
  const topic = await campaignTopic(runtime.db, a.workspaceId, draft, false);
  const started = Date.now();
  let aborted = false;

  try {
    await runtime.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const counts = await audienceMod.snapshotCampaignAudience(tx, a, audienceSpec, row.reviewId!, propertyKeys, draft.requiredNotice === true, {
        large: true,
        topic,
        staticStamp,
        // The list probe's sample leads only where the probe applies (Hosted shared sending, live).
        ...row.account?.kind === 'shared' && !row.simulated ? { leading: probeSize } : {},
        onProgress: async progress => {
          // Separate pool connection (runtime.db): checks for cancel/unschedule and publishes visible progress without
          // mutating sending_campaigns inside the REPEATABLE READ transaction. Server-side lock_timeout (500 ms) and
          // statement_timeout (800 ms) cancel blocked writes cleanly in Postgres (no leaked connections or hung backends),
          // and fencing on v.captured_at IS NULL + greatest(c.prepared, ...) ensures a late write can never move prepared
          // backwards or overwrite a finished capture.
          try {
            return await runtime.db.transaction(async ptx => {
              await ptx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
              await ptx.execute(sql`SET LOCAL statement_timeout = '800ms'`);
              const [cur] = (await ptx.execute<{ state: string; review_id: string | null }>(sql`
                SELECT state, review_id FROM sending_campaigns WHERE workspace_id = ${a.workspaceId} AND id = ${row.id}`)).rows;
              if (!cur || cur.state !== 'preparing' || cur.review_id !== row.reviewId) return 'abort' as const;
              const visiblePrepared = Math.min(progress.prepared, Math.max(0, progress.total - 1));
              await ptx.execute(sql`
                UPDATE sending_campaigns c
                SET total = ${progress.total}, prepared = greatest(c.prepared, ${visiblePrepared}), updated_at = now()
                FROM sending_campaign_reviews v
                WHERE c.workspace_id = ${a.workspaceId} AND c.id = ${row.id}
                  AND c.state = 'preparing' AND c.review_id = ${row.reviewId}
                  AND v.id = c.review_id AND v.workspace_id = c.workspace_id AND v.captured_at IS NULL`);
              return 'continue' as const;
            });
          } catch {
            return 'continue';
          }
        },
      });
      await tx.execute(sql`
        UPDATE sending_campaign_reviews
        SET captured_at = now(), captured_count = ${counts.eligible}, static_prepared = ${Boolean(staticStamp)}
        WHERE workspace_id = ${a.workspaceId} AND id = ${row.reviewId}`);
      log('info', { code: 'CAMPAIGN_CAPTURE_COMPLETED', jobId, campaignId: row.id, reviewId: row.reviewId, eligible: counts.eligible, staticPrepared: Boolean(staticStamp), durationMs: Date.now() - started });
    });
  } catch (error) {
    if (error instanceof audienceMod.CaptureAborted) { aborted = true; }
    else if ([error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014')) throw captureTimedOut();
    else throw error;
  }
  if (aborted) return;
  await finalizeCapture(runtime, a, row, jobId);
}

// preparing: validate the next chunk of frozen recipients (every substitution, URL and MIME size) and keep only each
// message's digest; when the whole list is validated the campaign moves to its schedule or straight to sending.
async function prepareStep(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const state = campaignScreened(runtime, row.account?.kind === 'shared') ? currentScreen(row) : undefined;
  if (state !== undefined && state?.template?.threshold === undefined) return screenCampaignStep(runtime, a, row);
  if (state?.template && state.template.spam >= state.template.threshold!) return campaignRejected(runtime, a, row, state);
  const ref = campaignRef(a, row.id), review = row.review;
  await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: review.draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return; }
    // The reviewed binding, the region's setup and the attachments, outside the send locks (claim locks last).
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'prepare', locks: 'none', mails: [reviewedMail(review.draft)] }, undefined, actorAssets(a, review.draft.attachments));
    const lockedAttachments = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId, { retryable: ['SES_SETUP_REQUIRED'] }).assets;
    const messageStatic = ![review.draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));
    const started = Date.now();
    if (messageStatic) {
      // Set-based static preparation (used for small <=5,000 sync launches and pre-deploy static reviews mid-prepare).
      const stamp = await prepareStaticStamp(runtime, review.draft, review.rendered, lockedAttachments, review.version);
      const sliceEnd = Math.min(campaign.total, campaign.prepared + STATIC_PREPARE_SLICE_ROWS);
      const expected = sliceEnd - campaign.prepared;
      if (expected <= 0) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
      const invalid = await db.execute<{ id: string }>(sql`
        SELECT recipient->>'id' AS id FROM sending_review_recipients
        WHERE review_id = ${campaign.reviewId} AND ordinal > ${campaign.prepared} AND ordinal <= ${sliceEnd}
          AND NOT ${validMailAddressSql(sql`recipient->>'email'`)}
        ORDER BY ordinal LIMIT 1`);
      if (invalid.rows[0]) {
        throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Contact ${invalid.rows[0].id}: Recipient or rendered message is invalid (to).`, 'contactId');
      }
      const { rows: [stamped] } = await db.execute<{ n: number; max_ordinal: number | null }>(sql`
        WITH updated AS (
          UPDATE sending_review_recipients
          SET content_hash = 's1:' || encode(sha256(convert_to(${stamp.baseHash} || ':' || (recipient->>'email'), 'UTF8')), 'hex'),
              subject = ${stamp.storedSubject},
              snapshot_bytes = ${stamp.baseBytes} + octet_length(to_json(recipient->>'email')::text)
          WHERE review_id = ${campaign.reviewId} AND ordinal > ${campaign.prepared} AND ordinal <= ${sliceEnd} AND content_hash IS NULL
          RETURNING ordinal
        )
        SELECT count(*)::int AS n, max(ordinal)::int AS max_ordinal FROM updated`);
      if ((stamped?.n ?? 0) !== expected || stamped?.max_ordinal !== sliceEnd) {
        throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
      }
      log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId, campaignId: campaign.id, cursor: campaign.prepared, rows: expected, messageStatic: true, durationMs: Date.now() - started });
      await db.execute(recordPrepared(ref, sliceEnd, runningState({ prepared: sliceEnd, total: campaign.total, scheduledAt: campaign.scheduledAt })));
      return;
    }

    // Personalized preparation: keeps the all-validated-before-any-send guarantee.
    const recipients = await recipientChunk(db, campaign.reviewId!, campaign.prepared);
    if (!recipients.length) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
    const parse = review.rendered.html ? await loadParse5() : undefined;
    validateInterpolationTemplate(review.draft.subject, false);
    const htmlInfo = validateInterpolationTemplate(review.rendered.html, true, parse);
    validateInterpolationTemplate(review.rendered.text, false);
    const htmlStatic = !review.rendered.html?.includes('{{');
    const templateHtmlBytes = review.rendered.html ? Buffer.byteLength(review.rendered.html, 'utf8') : 0;
    // When no {{placeholder}} sits in a URL attribute, HTML-escaped substitution in text or text-only attributes cannot
    // alter any URL or DOM structure, so validateHtmlUrls runs once instead of re-parsing HTML per recipient.
    const htmlUrlsOnce = htmlStatic || !htmlInfo.hasUrlPlaceholder;
    if (htmlUrlsOnce && review.rendered.html) {
      await validateHtmlUrls(review.draft.previewText ? withPreheader(review.rendered.html, review.draft.previewText, parse, review.version) : review.rendered.html);
    }
    let cursor = campaign.prepared, payloadBytes = 0;
    const prepared: { ordinal: number; hash: string; subject: string; bytes: number }[] = [];
    for (const recipient of recipients) {
      if (recipient.ordinal !== cursor + 1 || recipient.content_hash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
      // If a text attribute holds a placeholder and recipient data could push total attribute bytes past bounded-html's
      // 512 KiB budget, fall back to full per-row validateHtmlUrls so the result is always identical.
      const rowHtmlValidated = htmlUrlsOnce && (!htmlInfo.hasAttrPlaceholder || templateHtmlBytes + htmlInfo.attrPlaceholderCount * (recipient.recipient_bytes ?? 0) <= 512 * 1024);
      const snapshot = await campaignMessage(runtime, review.draft, recipient.recipient, false, lockedAttachments, review.rendered, true, rowHtmlValidated, review.version);
      const contentHash = await digest(canonical(snapshot));
      marketingFooter(snapshot, unsubscribePlaceholder(keyedOrigin(runtime, review.draft)), review.draft);
      sizeCheck(snapshot, lockedAttachments);
      const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      const entryBytes = 160 + Buffer.byteLength(snapshot.subject, 'utf8');
      if (prepared.length && payloadBytes + entryBytes > CAMPAIGN_PREPARE_BYTES) break;
      prepared.push({ ordinal: recipient.ordinal, hash: contentHash, subject: snapshot.subject, bytes: size }); payloadBytes += entryBytes; cursor = recipient.ordinal;
      if (Date.now() - started >= 10000) break;
    }
    log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId, campaignId: campaign.id, cursor: campaign.prepared, rows: prepared.length, messageStatic: false, htmlUrlsOnce, durationMs: Date.now() - started });
    await db.execute(sql`UPDATE sending_review_recipients r SET content_hash = p.hash, subject = nullif(p.subject,${review.draft.subject}), snapshot_bytes = p.bytes
      FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) AS p(ordinal integer, hash text, subject text, bytes integer)
      WHERE r.review_id = ${campaign.reviewId} AND r.ordinal = p.ordinal AND r.content_hash IS NULL`);
    await db.execute(recordPrepared(ref, cursor, runningState({ prepared: cursor, total: campaign.total, scheduledAt: campaign.scheduledAt })));
  });
}
/**
 * A campaign launched before postal addresses existed froze none in its review. Before its first release it takes the
 * workspace's, stamped into the review once, so it never sends without one and every copy and rebuild of it shows the
 * same address. With none set it pauses with POSTAL_ADDRESS_REQUIRED (runCampaign); resuming after one is added
 * continues it. One that had already released recipients finishes as it started, so all its copies read the same.
 */
async function frozenPostalAddress(runtime: Runtime, a: Actor, row: RunRow) {
  const review = sql`workspace_id=${a.workspaceId} AND id=${row.reviewId}`;
  const { rows: [found] } = await runtime.db.execute<{ address: string | null }>(sql`WITH current AS (SELECT ${postalAddressOf(runtime.config.multiTenant, a.workspaceId)} AS address),
    stamped AS (UPDATE sending_campaign_reviews SET draft=draft||jsonb_build_object('postalAddress',c.address) FROM current c
      WHERE ${review} AND c.address IS NOT NULL AND NOT draft ? 'postalAddress' RETURNING draft->>'postalAddress' AS address)
    SELECT coalesce((SELECT address FROM stamped),(SELECT draft->>'postalAddress' FROM sending_campaign_reviews WHERE ${review})) AS address`);
  if (!found?.address) throw new ApiError(409, 'POSTAL_ADDRESS_REQUIRED', 'Paused before sending anyone: the workspace has no postal address, which US law (CAN-SPAM) requires in every marketing email. Add it in Settings, then resume this campaign.', 'postalAddress');
  log('info', { code: 'CAMPAIGN_POSTAL_ADDRESS_FROZEN', campaignId: row.id });
  return found.address;
}
/** How long a campaign launched before link hosts, and its queued email, wait before looking for their link host again. */
export const LINK_RECORD_RECHECK_MS = 15 * 60_000;
// sending: release the next recipients into the dispatch queue within the buffer, pacing, rate share and SES quota.
// Returns 'again' when another release can start at once, 'done' when this run has nothing more to do, and waits in
// place (JobDeferred on the same job row) otherwise.
async function releaseStep(runtime: Runtime, a: Actor, row: RunRow, payload: Record<string, unknown>): Promise<'again' | 'done'> {
  const ref = campaignRef(a, row.id), nowMs = Date.now();
  // Every recipient is released: the dispatcher marks the campaign done when its last row leaves the queue. When no row
  // is left to leave it (the last release skipped everyone remaining, or the last rows went out while the campaign was
  // paused) nothing would until the minute sweep, so the run finishes it. The statement moves sending -> done only with
  // nothing queued or attempting: with a row in flight it changes nothing and the dispatcher finishes the campaign.
  const settle = () => runtime.db.execute(finishCampaigns(sql`SELECT ${a.workspaceId}::text AS workspace_id, ${row.id}::text AS campaign_id`));
  if (row.expanded >= row.total) { await settle(); return 'done'; }
  if (row.expanded === 0 && row.review.draft.postalAddress === undefined) row.review.draft = { ...row.review.draft, postalAddress: await frozenPostalAddress(runtime, a, row) };
  // Do not turn a retired generation into a pacing/quota wait, or refresh its provider quota.
  if (row.review.draft.binding && row.account?.generation!==row.review.draft.binding.generation) throw staleReview();
  // Poll a full buffer with one bounded count, before the locks and origin checks; the transaction rechecks capacity under the admission lock.
  const limits = { campaign: campaignBuffer(row.rate), total: workspaceBuffer(row.rate) };
  const [buffered] = (await runtime.db.execute<{ total: number; campaign: number }>(sql`SELECT
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id IS NOT NULL AND status IN ('queued','attempting') LIMIT ${limits.total}) e) AS total,
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id=${row.id} AND status IN ('queued','attempting') LIMIT ${limits.campaign}) c) AS campaign`)).rows;
  // Record why releasing is held (shown on the campaign), then wait in place.
  const hold = async (reason: 'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota' | 'list_probe' | 'feedback_lag' | 'ramp' | 'link_record', until: string): Promise<never> => {
    await runtime.db.execute(holdCampaign(ref, reason, until));
    throw new JobDeferred(until, payload);
  };
  // A campaign whose review froze no link host (launched before link hosts, or on the link domain) asks each release
  // (src/link-domains.ts). With none to use (the workspace paused, or with own link hosts only, none active), it waits
  // without releasing anyone and looks again every 15 minutes; a domain's own host turning active wakes it at once
  // (wakeLinkRecordHolds). On the link domain, the release records its recipients there.
  let releaseOrigin = row.review.draft.requiredNotice ? undefined : row.review.draft.linkOrigin;
  if (!row.review.draft.linkOrigin && !row.review.draft.requiredNotice) {
    const choice = await linkChoice(runtime, runtime.db, a.workspaceId, row.review.draft.from).catch(error => { if (error instanceof ApiError && error.code === 'LINK_RECORD_REQUIRED') return null; throw error; });
    if (!choice) return hold('link_record', new Date(nowMs + LINK_RECORD_RECHECK_MS).toISOString());
    releaseOrigin = choice.origin;
  }
  // A stale/nonexistent sample is not an unlimited allowance. When a known quota (or a
  // previously held campaign) needs a new sample, use the dispatcher's elected cache refresher.
  // This works with an empty queue and does not release a probe/buffer of speculative emails.
  const dbNow = Date.parse(row.dbNow);
  let max = Number(row.max24), sent = Number(row.sent24), customerSent = Number(row.customer24), refreshAt = Date.parse(row.quotaCheckedAt ?? '') + QUOTA_REFRESH_MS;
  // A brand-new region has no previous allowance to preserve. Keep its normal cold-start
  // buffer and Hosted admission checks; the first dispatch populates its quota cache.
  if ((row.quotaCheckedAt !== null || max > 0 || row.waitingReason === 'ses_daily_quota') && !(refreshAt > dbNow)) {
    const { campaignQuota } = await wrapModuleLoad(() => import('../dispatcher.js'));
    const q = await campaignQuota(runtime, a, row.review.draft.region, row.account?.aws_account_id).catch(error => { if (error instanceof ModuleLoadError) throw error; return null; });
    if (!q) return hold('ses_daily_quota', new Date(dbNow + QUOTA_REFRESH_MS).toISOString());
    max = q.max24HourSend; sent = q.sentLast24Hours; customerSent = q.customerSent ?? 0; refreshAt = q.checkedAt + QUOTA_REFRESH_MS;
  }
  const sesCapacity = max > 0 ? max - sent - sesDailyReserve(max, runtime.config.dispatch.dailyHeadroomPercent) : max === 0 && row.waitingReason === 'ses_daily_quota' ? 0 : Infinity;
  // An outside workspace's campaign also waits for the customer share, shown as waiting for Hosted sending capacity.
  const outside = row.account?.kind === 'shared' && !row.account.exempt && !isSimulatedSes(runtime);
  const shareCapacity = outside && max > 0 ? customerCredits(max, customerSent, runtime.config.dispatch.customerSharePercent) : Infinity;
  const quotaUntil = new Date(Math.max(dbNow + 1000, Number.isFinite(refreshAt) ? refreshAt : dbNow + QUOTA_REFRESH_MS)).toISOString();
  if (sesCapacity <= buffered!.total) return hold('ses_daily_quota', quotaUntil);
  if (shareCapacity <= buffered!.total) return hold('hosted_daily_quota', quotaUntil);
  // Release hysteresis: once this campaign already has rows buffered, wait until at least a quarter of its buffer has drained
  // (or the remaining recipients fit) instead of topping up tiny batches that contend on locks and wake shards nonstop.
  const room = Math.min(limits.campaign - buffered!.campaign, limits.total - buffered!.total);
  const minRelease = Math.min(row.total - row.expanded, Math.floor(limits.campaign / 4), CAMPAIGN_EXPAND_ROWS);
  if (room <= 0 || (buffered!.campaign > 0 && room < minRelease)) {
    const backlog = room <= 0
      ? Math.max(buffered!.campaign - limits.campaign / 2, buffered!.total - limits.total / 2)
      : Math.max(buffered!.campaign - Math.max(0, limits.campaign - minRelease), buffered!.total - Math.max(0, limits.total - minRelease));
    throw new JobDeferred(new Date(nowMs + drainDelayMs(backlog, row.rate)).toISOString(), payload);
  }
  const cap = dailyCap(row), rolling = cap !== null && !!row.windowStartedAt && nowMs - Date.parse(row.windowStartedAt) >= DAY_MS;
  // Automatic pause: checked at most every 30 minutes while releasing, so always before a new daily window
  // opens; a resume restarts the 30 minutes so a deliberate resume is not immediately re-paused.
  const hosted = runtime.config.multiTenant && row.account?.kind === 'shared';
  // `rampStep`: a ramp step's batch paused it. That batch is done with: a resume starts a new hour on the same step.
  const guardLines = rampLines(runtime.config.rampLines);
  const quarantine = async (unhealthy: { code: string; message: string }, rampStep?: number) => {
    const paused = await runtime.db.transaction(async tx => {
      const moved = await tx.execute(hosted ? quarantineCampaign(ref, unhealthy) : pauseCampaign(ref, unhealthy));
      if (moved.rows.length && rampStep !== undefined) await tx.execute(restartRampWindow(ref));
      if (moved.rows.length && hosted) await (await wrapModuleLoad(() => import('../standing.js'))).applyChange(tx, { workspaceId: a.workspaceId, actor: { kind: 'system', via: 'job' }, kind: 'quarantine',
        details: { campaignId: row.id, campaignName: row.draft.name ?? row.id, code: unhealthy.code, message: unhealthy.message } });
      return moved;
    });
    if (paused.rows.length) log('warn', { code: 'CAMPAIGN_AUTO_PAUSED', campaignId: row.id, reason: unhealthy.code, ...rampStep === undefined ? {} : { rampStep: rampStep + 1 } });
    // A blocklist is everyone's problem on a shared pool: one operator alert (src/operator-alerts.ts).
    if (paused.rows.length && unhealthy.code === 'BLOCKLISTED') await (await wrapModuleLoad(() => import('../operator-alerts.js'))).blocklistAlert(runtime.db, a.workspaceId, row.id);
    return 'done' as const;
  };
  // The list probe: release only the probe, wait for its feedback, then check it before releasing the rest. A sender in
  // good standing skips it for up to 10,000 recipients an earlier campaign delivered to cleanly (listMailedCleanly): decided once,
  // before the first release, and recorded as skipped, not passed. While the sender stays in good standing a skipped
  // campaign releases on; once it is below (or a check has started), everything released so far is the probe: nothing
  // more is released until it has left the queue, waited ten minutes and passed the probe's check, and a check that
  // passes clears it as a probe that went out would. The automatic pause below still applies to every campaign.
  const listed = hosted && row.autoPause && !row.simulated && !row.probeClearedAt && row.total > probeSize(row.total), good = row.account?.probation === null;
  let probe = listed ? probeSize(row.total) : null;
  if (listed && row.probeSkippedAt) probe = good && !row.probeWaitUntil ? null : Math.max(row.expanded, probeSize(row.total));
  else if (listed && row.expanded === 0 && good && await listMailedCleanly(runtime.db, a, row)) {
    await runtime.db.execute(skipProbe(ref));
    log('info', { code: 'CAMPAIGN_PROBE_SKIPPED', campaignId: row.id });
    probe = null;
  }
  let probeLeft = Number.POSITIVE_INFINITY;
  if (probe !== null && row.expanded >= probe) {
    if (buffered!.campaign > 0) throw new JobDeferred(new Date(nowMs + drainDelayMs(buffered!.campaign, row.rate)).toISOString(), payload);
    if (!row.probeWaitUntil) {
      const until = new Date(dbNow + PROBE.waitMs).toISOString();
      await runtime.db.execute(waitProbe(ref, until));
      throw new JobDeferred(until, payload);
    }
    if (Date.parse(row.probeWaitUntil) > dbNow) await hold('list_probe', row.probeWaitUntil);
    // Hold before passing the list probe when safety feedback is >= 5 min behind so a probe cannot clear blind.
    if (row.autoPause && (row.priorityLagMs ?? 0) >= FEEDBACK_LAG_HOLD_MS) {
      return hold('feedback_lag', new Date(dbNow + 60_000).toISOString());
    }
    const unhealthy = await campaignHealth(runtime.db, a, row, true, probe, guardLines);
    if (unhealthy) return quarantine(unhealthy);
    await runtime.db.execute(clearProbe(ref));
  } else if (probe !== null) probeLeft = probe - row.expanded;
  // Hold new releases (never a manual pause) when priority safety feedback (bounces/complaints) is >= 5 minutes behind
  // so auto-pause does not send blind; routine opens/clicks lagging never hold a send (unless running without a priority
  // queue), and stale samples (> 5 min old) expire. Queue-level lag is installation-wide because Cloudflare Queues
  // reports per-queue age, not per-workspace; workspaces with autoPause disabled are never held.
  if (row.autoPause && (row.priorityLagMs ?? 0) >= FEEDBACK_LAG_HOLD_MS) {
    return hold('feedback_lag', new Date(dbNow + 60_000).toISOString());
  }
  if (row.autoPause && (!row.healthCheckedAt || nowMs - Date.parse(row.healthCheckedAt) >= AUTO_PAUSE.intervalMs)) {
    const unhealthy = await campaignHealth(runtime.db, a, row, hosted, undefined, guardLines);
    if (unhealthy) return quarantine(unhealthy);
    // Recipient domains this campaign's mail mostly bounced at lately: the rest there is skipped (src/send-guards.ts).
    await stopDeadDomains(runtime.db, a.workspaceId, row.id, guardLines).catch(() => log('warn', { code: 'CAMPAIGN_DOMAIN_STOP_FAILED', campaignId: row.id }));
    await runtime.db.execute(noteHealthChecked(ref));
  }
  // Daily pacing: at most pacePerDay recipients, or the plan's batch, per rolling 24-hour window.
  // A plan's first small batch, out: wait for its bounces and rejections (the automatic pause reads them) before the rest of the day.
  const firstWait = firstBatchWait(row, row.windowIndex, row.windowStartedAt, nowMs);
  if (firstWait !== null && row.windowExpanded >= row.paceFirstBatch!) await hold('pacing_window', new Date(firstWait).toISOString());
  if (cap !== null && row.windowStartedAt && !rolling && row.windowExpanded >= cap) await hold('pacing_window', new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString());
  // The ramp (src/standing-model.ts RAMP): Hosted live campaigns, exempt workspaces too. Its first release places it, from
  // the workspace's history. A step's hour releases at most its ceiling; once the hour is over, its batch is checked when
  // its feedback is mature (RAMP_CHECK) and the campaign moves on, stays on the step for another hour or pauses.
  let rampLeft = Number.POSITIVE_INFINITY;
  if (hosted && !row.simulated) {
    let step = row.rampStep ?? rampStart(await rampHistory(runtime.db, a.workspaceId)), from = row.rampFrom;
    let opened = row.rampStep !== null && row.rampWindowStartedAt ? Date.parse(row.rampWindowStartedAt) : null;
    if (row.rampStep === null) log('info', { code: 'CAMPAIGN_RAMP_PLACED', campaignId: row.id, step: step + 1, steps: RAMP.steps.length });
    // The workspace's other ramped campaigns and its marketing sent through the API share the step's hourly ceiling:
    // splitting one send into many campaigns, sending several at once or sending the list through the API doesn't multiply
    // it. What the campaigns released in their current hours, from their own rows, and the API's marketing this clock hour
    // (hosted_usage_hourly.api_marketing, migration 501, whose ramp_refusal counts the campaigns' hours the same way).
    const [others] = (await runtime.db.execute<{ n: number }>(sql`SELECT ((SELECT coalesce(sum(greatest(expanded-ramp_from,0)),0) FROM sending_campaigns
      WHERE workspace_id=${a.workspaceId} AND id<>${row.id} AND state='sending' AND NOT simulated AND ramp_step IS NOT NULL AND ramp_step<${RAMP.steps.length}
        AND ramp_window_started_at>now()-make_interval(secs=>${RAMP_HOUR_MS / 1000}::int))
      + coalesce((SELECT api_marketing FROM hosted_usage_hourly WHERE workspace_id=${a.workspaceId} AND hour=date_trunc('hour',now(),'UTC')),0))::int AS n`)).rows;
    const shared = Number(others?.n ?? 0);
    if (step < RAMP.steps.length && opened !== null && dbNow >= opened + RAMP_HOUR_MS) {
      const batch = row.expanded > from ? await rampBatch(runtime.db, a, row, from) : null;
      if (batch?.released) {
        if (batch.waiting > 0) return hold('ramp', new Date(dbNow + Math.max(RAMP_CHECK.retryMs, drainDelayMs(batch.waiting, row.rate))).toISOString());
        if (batch.resolved < batch.accepted * RAMP_CHECK.resolved && dbNow < opened + RAMP_HOUR_MS + RAMP_CHECK.maxWaitMs) return hold('ramp', new Date(dbNow + RAMP_CHECK.retryMs).toISOString());
        const unhealthy = rampHealth(batch, step);
        if (unhealthy) return quarantine(unhealthy, step);
        // Proven by what the workspace's ramped campaigns released together, as they share the ceiling.
        if (batch.released + shared >= RAMP.steps[step]!.ceilingPerHour * RAMP.advance) step++;
      }
      opened = null;
    }
    if (step < RAMP.steps.length && opened === null) { opened = dbNow; from = row.expanded; }
    const startedAt = step < RAMP.steps.length ? new Date(opened!).toISOString() : null;
    if (step !== row.rampStep || from !== row.rampFrom || startedAt !== (row.rampWindowStartedAt && new Date(row.rampWindowStartedAt).toISOString())) await runtime.db.execute(setRamp(ref, step, startedAt, from));
    if (step < RAMP.steps.length) {
      rampLeft = RAMP.steps[step]!.ceilingPerHour - (row.expanded - from) - shared;
      if (rampLeft <= 0) return hold('ramp', new Date(opened! + RAMP_HOUR_MS).toISOString());
    }
  }
  // SES 24-hour quota (cached from GetAccount about every minute): keep a reserve for transactional mail.
  let rateAllowance = Number.POSITIVE_INFINITY, shareRate = 0;
  // Rate share: release at most rateShare of the regional send rate, measured from the previous release.
  if (row.rateShare !== null && row.rateShare < 1 && Number(row.rate) > 0) {
    shareRate = row.rateShare * Number(row.rate);
    const last = typeof payload.releasedAt === 'string' ? Date.parse(payload.releasedAt) : nowMs - RELEASE_INTERVAL_MS;
    rateAllowance = Math.floor(shareRate * Math.min(Math.max(0, nowMs - last), RELEASE_BURST_MS) / 1000);
    if (rateAllowance < 1) throw new JobDeferred(new Date(last + Math.ceil(1000 / shareRate)).toISOString(), payload);
  }
  // Screened campaigns release only recipients whose copies have verdicts; a refused share past the screen's restrict
  // line (src/standing-model.ts) pauses the campaign once, for its owner to review.
  let screened = Number.POSITIVE_INFINITY;
  let state = campaignScreened(runtime, hosted) ? currentScreen(row) : null;
  if (state?.template) {
    const through = Math.min(row.total, row.expanded + SCREEN_AHEAD);
    if (state.screenedThrough < through) state = await screenAhead(runtime, a, row, state, through);
    const line = (await wrapModuleLoad(() => import('../standing-model.js'))).LADDER.screen.restrict[0];
    if (!state.quarantined && state.rejected >= line.count && state.rejected / state.recipients >= line.rate) {
      await saveScreen(runtime, a, row, { ...state, quarantined: true });
      return quarantine({ code: 'CONTENT_REJECTED_SPAM', message: `Paused: the content screen refused ${state.rejected} of ${state.recipients} recipients' copies as spam (the line is ${line.rate * 100}% and ${line.count}). Refused copies are never sent. Review the content and contact values before resuming.` });
    }
    screened = state.screenedThrough - row.expanded;
    if (screened <= 0) return 'again';
  }
  const draft = row.review.draft, limits_ = limitsTable(runtime);
  // A plan opens its next batch only after a healthy day (src/send-guards.ts, when the setting turns it on). Judged here,
  // before the send locks: the release below holds the workspace's admission row, which every send waits on. Judged a few
  // minutes early too, so a day that ends while this step runs still has its judgement.
  const judged = guardLines.planHealth && row.pacePlan?.length && row.windowStartedAt && Date.now() - Date.parse(row.windowStartedAt) >= DAY_MS - 10 * 60_000
    ? { window: row.windowStartedAt, day: await planWindowHealthy(runtime.db, a.workspaceId, row.id, row.windowStartedAt) } : null;
  const released = await runtime.db.transaction(async db => {
    const held = await lockSendScope(db, a.workspaceId, { campaignId: row.id });
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'sending' || campaign.reviewId !== row.reviewId || campaign.expanded >= campaign.total) return null;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return null; }
    // A required notice whose workspace no longer has them pauses here (runCampaign), before anyone more is released:
    // a scheduled one at its time, a paced one at its next window. Turned on again, a resume continues from here.
    await requiredNoticesAllowed(db, draft, a.workspaceId, 'Paused: required notices were turned off for this workspace, so nobody more is sent this notice. Resume it once they are on again, or cancel it.');
    // The admission decision on this release: a pause or hold, the reviewed binding (fencing the insert against a
    // disable or reclaim since the precheck), and how many recipients the Hosted limit and the balance afford.
    const release = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'release', locks: held, mails: [reviewedMail(draft)] }, sql`jsonb_build_object('simulated',${campaign.simulated}::boolean)`);
    const [buffer] = await db.select({ total: sql<number>`count(*)::int`, campaign: sql<number>`count(*) FILTER (WHERE ${emails.campaignId} = ${campaign.id})::int`,
      decision: sql<Released | Refused>`${release}`,
      rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits_} WHERE workspace_id=${a.workspaceId} AND region=${draft.region}),0)`,
    }).from(emails).where(and(scope(emails, a), isNotNull(emails.campaignId), inArray(emails.status, ['queued', 'attempting'])));
    // A capped campaign opens a new 24-hour window when the previous one has elapsed (or on its first release); with a
    // plan, each window after the first is its next batch.
    const opening = dailyCap(campaign) !== null && (!campaign.windowStartedAt || Date.now() - Date.parse(campaign.windowStartedAt) >= DAY_MS);
    // A plan opens its next batch only after a healthy day (judged above); otherwise the same batch again. A window another
    // run opened meanwhile isn't opening here, so the judgement always matches the window it opens after.
    const grows = !(opening && campaign.windowStartedAt && campaign.pacePlan?.length) || !guardLines.planHealth || (judged?.window === campaign.windowStartedAt ? judged.day.healthy : true);
    if (!grows) log('info', { code: 'CAMPAIGN_PLAN_HELD', campaignId: campaign.id, batch: campaign.windowIndex + 1 });
    // The sender sees a held plan, since when and why (delivery.pacing.held); it clears when the plan grows again.
    // Cleared whenever it grows (also when the guard was turned off since), so it never says a growing plan is held.
    if (opening && campaign.windowStartedAt && campaign.pacePlan?.length && (!grows || campaign.planHeld))
      await db.execute(sql`UPDATE sending_campaigns SET plan_held=${grows || !judged ? null : JSON.stringify({ since: campaign.planHeld?.since ?? now(), batch: campaign.windowIndex + 1, why: planHeldWhy(judged.day) })}::jsonb WHERE workspace_id=${a.workspaceId} AND id=${campaign.id}`);
    const windowStart = opening ? now() : campaign.windowStartedAt, windowIndex = opening && campaign.windowStartedAt ? campaign.windowIndex + (grows ? 1 : 0) : campaign.windowIndex;
    const windowUsed = opening ? 0 : campaign.windowExpanded, dayCap = dailyCap(campaign, windowIndex);
    // In the first window, before the first small batch's wait is over, only the first small batch goes.
    const windowCap = dayCap !== null && (windowIndex === 0 && campaign.paceFirstBatch && campaign.pacePlan?.length && (opening || firstBatchWait(campaign, 0, windowStart, Date.now()) !== null))
      ? Math.min(dayCap, campaign.paceFirstBatch) : dayCap;
    const paceLeft = windowCap === null ? Number.POSITIVE_INFINITY : windowCap - windowUsed;
    if (paceLeft <= 0) throw new JobDeferred(new Date(Date.parse(windowStart!) + (windowCap !== dayCap ? campaign.paceFirstWaitMinutes! * 60_000 : DAY_MS)).toISOString(), payload);
    const sesAllowance = Math.min(sesCapacity, shareCapacity) - buffer!.total;
    if (sesAllowance <= 0) return sesCapacity <= shareCapacity ? 'ses_daily_quota' as const : 'hosted_daily_quota' as const;
    const cBuf = campaignBuffer(buffer!.rate), wBuf = workspaceBuffer(buffer!.rate);
    const bufRoom = Math.min(cBuf - buffer!.campaign, wBuf - buffer!.total);
    const demand = Math.min(CAMPAIGN_EXPAND_ROWS, campaign.total - campaign.expanded, paceLeft, sesAllowance, rateAllowance, probeLeft, screened, rampLeft);
    const txMinRelease = Math.min(demand, Math.floor(cBuf / 4));
    const capacity = Math.min(demand, bufRoom);
    if (capacity <= 0 || (buffer!.campaign > 0 && bufRoom < txMinRelease)) {
      // Lost a race with another release or buffer is still more than three-quarters full: wait for it to drain.
      const backlog = capacity <= 0
        ? Math.max(buffer!.campaign - cBuf / 2, buffer!.total - wBuf / 2)
        : Math.max(buffer!.campaign - Math.max(0, cBuf - txMinRelease), buffer!.total - Math.max(0, wBuf - txMinRelease));
      throw new JobDeferred(new Date(Date.now() + drainDelayMs(backlog, buffer!.rate)).toISOString(), payload);
    }
    const allowed = admitted(runtime, buffer!.decision, a.workspaceId);
    const links = releaseOrigin ? await linkAllowance(db, runtime.config, a.workspaceId, releaseOrigin) : null;
    if (links && !links.left) {
      await db.execute(holdCampaign(ref, links.reason, links.until));
      return { count: 0, completed: false, linkUntil: links.until, hostedUntil: null, balanceUntil: null };
    }
    const chunk = await recipientChunk(db, campaign.reviewId!, campaign.expanded, Math.min(capacity, links?.left ?? capacity));
    if (!chunk.length || chunk.some((recipient, index) => !recipient.content_hash || recipient.ordinal !== campaign.expanded + index + 1)) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The prepared audience is incomplete.');
    // Refuse unknown future hash formats before releasing any row so the campaign pauses intact instead of burning recipients.
    if (chunk.some(recipient => !isSupportedContentHash(recipient.content_hash))) throw unsupportedHashFormat();
    const delivered = campaign.deliveredOnly ? await deliveredBefore(db, a.workspaceId, campaign.id, chunk.map(r => r.recipient.email)) : null;
    const stopped = await stoppedDomains(db, campaign.id), stoppedAt = (email: string) => stopped.size > 0 && stopped.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
    const affordable = allowed.hostedLeft ?? Number.POSITIVE_INFINITY;
    // The processed prefix: every recipient up to the last affordable one that is sent; skipped ones cost nothing.
    const processed: typeof chunk = [], recipients: typeof chunk = [];
    for (const r of chunk) {
      const send = !r.screen_rejected && (!delivered || delivered.has(r.recipient.email.toLowerCase())) && !stoppedAt(r.recipient.email);
      if (send && recipients.length >= affordable) break;
      processed.push(r); if (send) recipients.push(r);
    }
    let hostedUntil: string | null = null, balanceUntil: string | null = null;
    if (processed.length < chunk.length) {
      hostedUntil = allowed.nextChangeAt!;
      if (!processed.length) {
        await db.execute(holdCampaign(ref, 'hosted_daily_quota', hostedUntil));
        return {count:0, completed:false, hostedUntil, balanceUntil: null as string | null};
      }
    }
    // Billing (Hosted, enforced prepaid): release only what the balance and the free sending allowance cover; with nothing
    // covered the campaign waits on 'balance' until a credit (billing.restored wakes it) or an hour passes.
    const bill = allowed.billing;
    if (bill) {
      const affordable = bill.affordable;
      if (affordable < recipients.length && !bill.enforced) log('info', { code: 'BILLING_SHADOW_DENY', workspaceId: a.workspaceId, campaignId: campaign.id, requiredUc: String(RATES.emailUc * BigInt(Math.max(0, recipients.length - bill.freeSentLeft))), availableUc: bill.availableUc });
      else if (affordable < recipients.length) {
        const until = new Date(Date.now() + 3_600_000).toISOString();
        if (affordable === 0) {
          await db.execute(holdCampaign(ref, 'balance', until));
          return { count: 0, completed: false, hostedUntil: null, balanceUntil: until };
        }
        // Keep the prefix through the last recipient the balance covers (skipped ones before it stay processed).
        processed.splice(processed.indexOf(recipients[affordable - 1]!) + 1);
        recipients.splice(affordable);
        hostedUntil = null; balanceUntil = until;
      }
    }
    // The review owns its assets. Only one variable-size bind per release page; no
    // per-recipient headers, base content, asset IDs, or denormalized attachment links.
    const prepared=recipients.map(r=>({id:rowId('email'),ordinal:r.ordinal,address:r.recipient.email,subject:r.subject??draft.subject}));
    // On the link domain: the release's recipients are recorded there (src/link-domains.ts recordLinkUse).
    if (runtime.config.linkHost && releaseOrigin === `https://${runtime.config.linkHost}` && prepared.length) await recordLinkUse(db, a.workspaceId, runtime.config.linkHost, prepared.length);
    const tpl = row.review.screen?.template;
    const stub={kind:'marketing',deferredCampaign:true,...(!draft.linkOrigin && releaseOrigin ? {linkOrigin:releaseOrigin} : {}),...(tpl ? { screenVerdict: { status: 'passed', spam: tpl.spam, model: tpl.model, digest: tpl.key } } : {})};
    if (prepared.length) await db.execute(sql`INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,campaign_id,review_id,review_ordinal,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened,scheduled_at)
      SELECT p.id,${a.workspaceId},${a.keyId},${draft.region},${campaign.id},${campaign.reviewId},p.ordinal,${draft.from},jsonb_build_array(p.address),'[]','[]',p.subject,${JSON.stringify(stub)}::jsonb,${campaign.simulated},true,${campaign.scheduledAt}
      FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) p(id text,ordinal int,address text,subject text)`);
    const expanded = processed[processed.length - 1]!.ordinal, skipped = processed.length - recipients.length;
    await db.execute(recordExpanded(ref, expanded, windowStart, windowUsed + prepared.length, balanceUntil ?? hostedUntil, skipped, balanceUntil ? 'balance' : 'hosted_daily_quota', windowIndex));
    if (skipped) log('info', { code: 'CAMPAIGN_RECIPIENTS_SKIPPED', campaignId: campaign.id, skipped, reason: 'not_delivered_before' });
    log('info', { code: 'CAMPAIGN_RELEASED', campaignId: campaign.id, released: prepared.length, expanded, total: campaign.total, capacity, buffered: buffer!.campaign, workspaceBuffered: buffer!.total, rate: buffer!.rate });
    return { count: prepared.length, completed: expanded === campaign.total, hostedUntil, balanceUntil };
  });
  if (!released) return 'done';
  if (typeof released === 'string') return hold(released, quotaUntil);
  // Released rows are claimed directly by the region dispatcher.
  if (released.count) try { await runtime.dispatch?.(draft.region, row.account?.aws_account_id, released.count, row.account?.kind, false, Number(row.rate) > 0 ? Number(row.rate) : undefined); } catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', campaignId: row.id, message: 'Released mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  // Usually the oldest bucket expires first. Also notice an earlier refund or operator raise.
  // Waiting on balance: billing.restored wakes the run as soon as credit lands; otherwise look again in an hour.
  if ('linkUntil' in released && released.linkUntil) throw new JobDeferred(released.linkUntil, payload);
  if (released.balanceUntil && !released.completed) throw new JobDeferred(released.balanceUntil, payload);
  if (released.hostedUntil) throw new JobDeferred(new Date(Math.min(Date.parse(released.hostedUntil),dbNow+QUOTA_REFRESH_MS)).toISOString(),payload);
  if (released.completed) { if (!released.count) await settle(); return 'done'; }
  if (sesCapacity <= buffered!.total + released.count) return hold('ses_daily_quota', quotaUntil);
  if (shareCapacity <= buffered!.total + released.count) return hold('hosted_daily_quota', quotaUntil);
  // A rate-shared continuation runs once this release has been paid for at the campaign's share.
  if (shareRate) throw new JobDeferred(new Date(Date.now() + Math.max(1000, Math.ceil(1000 * released.count / shareRate))).toISOString(), { ...payload, releasedAt: now() });
  return 'again';
}
// One job per campaign (jobs.id = campaign.run:<id>): it reads the row, acts for its state and loops while the next
// step can start at once (prepare chunks, prepare -> sending, buffer refills); it waits in place for the schedule,
// the dispatch buffer, pacing or quota, and stops as soon as the state is one it does not run (paused, done,
// failed, canceled). A definitive error or the last retry leaves `failed`, never a campaign sending forever.
const RUN_BUDGET_MS = 12000;
const CAPTURE_BUSY_MAX_DEFERS = 60;
export const runCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A campaign run needs its campaign.');
  const campaignId = payload.campaignId, a: Actor = { workspaceId: job.workspaceId, keyId: 'worker', permissions: ['manage'], domains: [] };
  const ref = campaignRef(a, campaignId), started = Date.now();
  try {
    for (;;) {
      const row = await readRun(runtime, a, campaignId);
      if (!row || !(CAMPAIGN_RUNNING as readonly string[]).includes(row.state)) return;
      if (row.account?.pauseReason && row.expanded < row.total) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', row.account.pauseReason);
      if (row.simulated !== isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'The campaign was launched with a different SES configuration. No more recipients were queued.');
      if (!row.review) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen message source is missing.');
      a.keyId = row.actorKeyId ?? a.keyId;
      if (row.state === 'preparing') {
        if (row.review.capturedAt === null) await captureStep(runtime, a, row, job.id);
        else if (row.review.capturedCount !== null) await finalizeCapture(runtime, a, row, job.id);
        else await prepareStep(runtime, a, row, job.id);
      }
      else if (row.state === 'scheduled') {
        if (row.scheduledAt && Date.parse(row.scheduledAt) > Date.now()) throw new JobDeferred(row.scheduledAt, payload);
        await runtime.db.execute(startSending(ref, { scheduledAt: row.scheduledAt, reviewId: row.reviewId }));
      } else if (await releaseStep(runtime, a, row, payload) === 'done') return;
      if (Date.now() - started >= RUN_BUDGET_MS) throw new JobDeferred(now(), payload);
    }
  } catch (error) {
    if (error instanceof JobDeferred || error instanceof ModuleLoadError) throw error;
    if (error instanceof ApiError && error.code === 'AUDIENCE_CAPTURE_BUSY') {
      const busyCount = typeof payload._captureBusy === 'number' && Number.isInteger(payload._captureBusy) ? payload._captureBusy + 1 : 1;
      if (busyCount <= CAPTURE_BUSY_MAX_DEFERS) {
        if (busyCount % 12 === 0) log('warn', { code: 'CAMPAIGN_CAPTURE_BUSY_DEFERRED', campaignId, jobId: job.id, busyCount });
        throw new JobDeferred(new Date(Date.now() + 5_000).toISOString(), { ...payload, _captureBusy: busyCount }, true);
      }
      // Ceiling reached (5 min): fail loudly with draft still editable instead of deferring forever.
      error = new ApiError(503, 'AUDIENCE_CAPTURE_BUSY', 'Audience capture slots stayed busy for over 5 minutes; try sending this campaign again.', undefined, false);
    }
    if (error instanceof ApiError && ['HOSTED_SENDING_PAUSED', 'MARKETING_HELD', 'POSTAL_ADDRESS_REQUIRED', 'REQUIRED_NOTICES_OFF', 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED'].includes(error.code)) {
      await runtime.db.execute(pauseCampaign(ref, { code: error.code, message: error.message }));
      return;
    }
    const retry = !(error instanceof ApiError) || error.retryable;
    if (!(error instanceof ApiError)) log('warn', { code: 'CAMPAIGN_RUN_RETRY', campaignId, jobId: job.id, message: error instanceof Error ? error.message : String(error) });
    if (retry && job.attempts < MAX_ATTEMPTS) throw new ApiError(503, error instanceof ApiError ? error.code : 'CAMPAIGN_RUN_FAILED', 'The campaign run will retry from its durable cursors.', undefined, true);
    try {
      const failed = await runtime.db.execute(failCampaign(ref, backgroundFailure(error)));
      if (failed.rows.length) log('error', { code: 'CAMPAIGN_FAILED', campaignId, jobId: job.id, cause: error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED' });
    } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign failure state will retry until it is durable.', undefined, true); }
  } finally { if (a.wakeJobs) await wakeWebhooks(runtime,a.wakeJobs); }
};
