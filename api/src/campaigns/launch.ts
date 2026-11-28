import { queueListRisk } from '../list-risk-lines.js';
import { talliesEnabled } from '../sending-tallies.js';
import { emailDelivered } from '../email-outcomes.js';
import { recordAudit } from '../audit.js';
import type { z } from '@hono/zod-openapi';
import { sql, and, eq, inArray } from 'drizzle-orm';
import { id, digest } from '../core/http.js';
import type { Actor, Runtime, DbExecutor, JobHandler, Ctx } from '../core/types.js';
import { ApiError, denied, wrapModuleLoad } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { retryDatabaseFailures, wakeWebhooks, JobDeferred } from '../jobs.js';
import { campaignReserved, terminalColumns, terminalEvents, cancelCampaign, retireCampaignRun, launchCampaign, queueCampaignRun } from '../states.js';
import { type SendScope, lockSendScope } from '../send-scope.js';
import { type campaigns, emails, campaignReviews, attachmentLinks } from '../db/sending.js';
import { postalAddressRequired } from '../outbound-content.js';
import { linkChoice } from '../link-domains.js';
import { canonical } from '../idempotency.js';
import { admission, actorJson, admitted, type Refused, type Admitted, refusal } from '../admission.js';
import { scope, type Pacing, type ConsentConfirmation, findCampaign, readyCampaign, loadScreen, campaignSendRegion, sharedConnection, probeSize, captureTimedOut, now, CAMPAIGN_RENDERER_VERSION } from '../sending/schemas.js';
import { queueCampaignStats } from './stats.js';
import { editable, renderCampaignContent, sendReadiness } from './views.js';
import { campaignCopy, placeholderKeys } from './materialize.js';
import { distinctAttachmentIds } from '../sending/mime.js';
import { workspacePostalAddress, requiredNoticesAllowed, campaignTopic, actorAssets } from '../sending/front-door.js';

export const campaignRef = (a: Pick<Actor, 'workspaceId'>, campaignId: string) => ({ workspaceId: a.workspaceId, id: campaignId });
export const hostedAutoPauseRequired = () => new ApiError(422, 'HOSTED_AUTO_PAUSE_REQUIRED', 'Automatic bounce and complaint pauses cannot be disabled on Hosted shared sending.', 'autoPause');
/** The admission decision on a campaign's recipients: those of every active or resumable campaign still unreleased, plus
 * its rows still in the dispatch queue, each counted once, against the per-workspace and per-key limits. A failed launch
 * that released nothing holds no reservation. Direct mail keeps its own limit. */
export async function reserveCampaign(runtime: Runtime, db: DbExecutor, held: SendScope, a: Actor, keyId: string, incoming: number) {
  const outstanding = sql`jsonb_build_object('outstanding',(SELECT jsonb_build_object('total',coalesce(sum(n),0),'key',coalesce(sum(n) FILTER (WHERE actor_key_id=${keyId}),0)) FROM (
    SELECT c.actor_key_id, c.total - c.expanded + (SELECT count(*) FROM sending_emails e WHERE e.workspace_id = c.workspace_id AND e.campaign_id = c.id AND e.status IN ('queued','attempting')) AS n
    FROM sending_campaigns c WHERE c.workspace_id = ${a.workspaceId} AND ${campaignReserved()}) o))`;
  const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'reserve', locks: held, incoming }, outstanding);
  admitted(runtime, (await db.execute<{ s: { allowed: true } | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s, a.workspaceId);
}
const cancelPageSize=1000;
async function cancelPage(db:DbExecutor,wid:string,campaignId:string,code:string,first=false) {
  // The parent state already fences new claims. Count before the bounded update so the
  // request keeps its original response; a skipped busy envelope is picked up next turn.
  const filter=sql`workspace_id=${wid} AND campaign_id=${campaignId} AND status='queued'`;
  const {rows:[page]}=await db.execute<{count:number;remaining:boolean;jobs:number}>(sql`WITH page AS (
    SELECT id FROM sending_emails WHERE ${filter} ORDER BY id LIMIT ${cancelPageSize} FOR UPDATE SKIP LOCKED
  ), canceled AS (UPDATE sending_emails SET status='canceled',error_code=${code},lease_until=NULL,updated_at=now()
    WHERE id IN (SELECT id FROM page) AND ${filter} RETURNING ${terminalColumns}), ${terminalEvents(sql`SELECT * FROM canceled`)},
  remaining AS (SELECT EXISTS(SELECT FROM sending_emails e WHERE ${filter} AND NOT EXISTS(SELECT FROM canceled c WHERE c.id=e.id)) AS more)
  ${first ? sql`, continuation AS (INSERT INTO jobs(id,workspace_id,type,payload) SELECT ${'cancel:'+campaignId},${wid},'sending.cancelPage',jsonb_build_object('campaignId',${campaignId}::text,'code',${code}::text)
    FROM remaining WHERE more ON CONFLICT DO NOTHING RETURNING 1)` : sql``}
  SELECT ${first ? sql`(SELECT count(*)::int FROM sending_emails WHERE ${filter})` : sql`0`} AS count,more AS remaining,
    ((SELECT count(*) FROM webhook_jobs) ${first?sql`+(SELECT count(*) FROM continuation)`:sql``})::int AS jobs FROM remaining`);
  return page!;
}
export const cancelPageJob:JobHandler=retryDatabaseFailures(async(runtime,payload,job)=>{
  const page=await cancelPage(runtime.db,job.workspaceId,String(payload.campaignId),String(payload.code));
  await wakeWebhooks(runtime,page.jobs);
  if (page.remaining) throw new JobDeferred(new Date(Date.now()+2000).toISOString());
});
export async function cancelCampaignWork(db: DbExecutor, a: Actor, row: typeof campaigns.$inferSelect, errorCode?: string) {
  const ref = campaignRef(a, row.id);
  const moved = await db.execute(cancelCampaign(ref, errorCode ? { code: errorCode, message: 'The sending origin is no longer authorized.' } : null));
  const unexpanded = moved.rows.length ? row.total - row.expanded : 0;
  if (moved.rows.length) await db.execute(retireCampaignRun(ref, 'CAMPAIGN_CANCELED'));
  const page=moved.rows.length ? await cancelPage(db,a.workspaceId,row.id,errorCode??'CAMPAIGN_CANCELED',true) : {count:0,jobs:0};
  a.wakeJobs=(a.wakeJobs??0)+page.jobs;
  const inFlight = await talliesEnabled(db)
    ? Number((await db.execute<{ count: number }>(sql`SELECT coalesce(sum(email_count), 0)::int AS count FROM sending_campaign_tallies
        WHERE workspace_id = ${a.workspaceId} AND campaign_id = ${row.id} AND status IN ('attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown')`)).rows[0]?.count ?? 0)
    : (await db.select({ count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, row.id), inArray(emails.status, ['attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown']))))[0]!.count;
  return { id: row.id, state: 'canceled' as const, canceled: page.count + unexpanded, inFlight };
}
/** Which of these addresses this workspace delivered to before, outside this campaign (lower case). */
export async function deliveredBefore(db: DbExecutor, wid: string, campaignId: string, emails: string[]) {
  const { rows } = await db.execute<{ email: string }>(sql`SELECT DISTINCT lower(t.addr) AS email FROM sending_emails p CROSS JOIN LATERAL jsonb_array_elements_text(p.to_addresses) t(addr)
    WHERE p.workspace_id=${wid} AND p.campaign_id IS DISTINCT FROM ${campaignId} AND NOT p.simulated AND ${emailDelivered('p')}
      AND lower(t.addr) IN (SELECT lower(x) FROM jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb) x)`);
  return new Set(rows.map(r => r.email));
}
export function backgroundFailure(error: unknown) {
  const code = error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED';
  // A missing placeholder value says what fixes it. Never name the contact: campaign errors are shown to everyone who can
  // see the campaign, so other content errors stay the sanitized summary.
  const placeholder = error instanceof ApiError && code === 'MISSING_TEMPLATE_VARIABLE' ? /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/.exec(error.message)?.[1] : undefined;
  if (placeholder) return { code, message: `A recipient has no value for {{${placeholder}}} (${code}). Add a fallback value for ${placeholder} and send again.` };
  if (error instanceof ApiError && code === 'CAMPAIGN_RECIPIENT_INVALID') return { code, message: "A recipient's email address or personalized content is invalid (CAMPAIGN_RECIPIENT_INVALID). Fix or remove the contact and send again." };
  // Capture, screen, size and limit refusals name only counts, sizes and limits, never a contact or its values.
  if (error instanceof ApiError && (['EMPTY_AUDIENCE', 'AUDIENCE_LIMIT_EXCEEDED', 'AUDIENCE_CAPTURE_BUSY', 'CAMPAIGN_RECIPIENT_DATA_TOO_LARGE', 'ENCODED_MESSAGE_TOO_LARGE', 'RENDERED_CONTENT_TOO_LARGE', 'UNSAFE_HTML_URL', 'UNSAFE_TEMPLATE_CONTEXT', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'CONTENT_REJECTED_SPAM', 'CONTENT_TOO_LARGE_TO_SCREEN', 'CONTENT_SCREEN_BUDGET_EXCEEDED', 'INSUFFICIENT_BALANCE'].includes(code) || code.endsWith('_LIMIT_EXCEEDED'))) return { code, message: error.message };
  return { code, message: `Campaign work could not finish (${code}). Correct the cause and send again, or cancel the campaign.` };
}
// Send and schedule: freeze the audience and content now, reserve the recipients, and hand the one run job the rest.
// The audience capture (up to 2,000,000 recipients: minutes at that size) runs before the send locks. The campaign row
// and the workspace's admission row, which every send in the workspace takes, are locked after it, only for what decides
// the launch: the admission, the review, the reserve and the state change. The capture stays in this transaction, so
// the frozen list is one snapshot and a launch that fails or is cancelled before it commits leaves nothing behind.
export async function launch(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, input: { revision: number; scheduledAt?: string; pacing?: z.infer<typeof Pacing>; consent?: z.infer<typeof ConsentConfirmation>; confirmRequiredNotice?: true }, requestId: string | undefined, c: Ctx) {
  // A campaign launch is one job that must start now; ask the response path for an uncoalesced scheduler wake.
  a.wakeJobs = Math.max(a.wakeJobs ?? 0, 12);
  if (input.scheduledAt && (Date.parse(input.scheduledAt) <= Date.now() || Date.parse(input.scheduledAt) > Date.now() + 365 * 86400000)) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.');
  // Campaign mail is never dispatched for a member origin (approvedOriginUser); refuse here instead of canceling later.
  if (a.role === 'member') throw denied('PERMISSION_DENIED', 'Only workspace owners and admins can send campaigns.', { permission: 'sendEmail', level: 'on', person: 'admin' });
  const row = await findCampaign(db, a, campaignId); editable(row, input.revision);
  // One launch of a campaign at a time, until this transaction ends: a second is refused at once instead of capturing the
  // audience again. Keyed on the workspace too, and taken only once the campaign is found in it. (Advisory lock classes:
  // 275812 and 275815 large captures in audience/counts.ts, 275813 public stats.)
  if (!(await db.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275814, hashtext(${a.workspaceId} || ':' || ${campaignId}))`)).rowCount)
    throw new ApiError(409, 'CAMPAIGN_LOCKED', 'Another request is sending this campaign; fetch it to see its state.', undefined, true);
  // The footer's postal address (CAN-SPAM), read once and frozen in the review: every copy and rebuild of this launch
  // shows the same one. Without it the launch is refused after the admission check below, before anything is captured.
  const postalAddress = await workspacePostalAddress(runtime, db, a.workspaceId);
  const draft = { ...readyCampaign(row.draft), ...postalAddress ? { postalAddress } : {} };
  // A required notice: still allowed for this workspace, and confirmed by the sender as having no promotion.
  await requiredNoticesAllowed(db, draft, a.workspaceId);
  if (draft.requiredNotice && !input.confirmRequiredNotice) throw new ApiError(422, 'REQUIRED_NOTICE_UNCONFIRMED', 'Confirm that this is a required notice with no promotion (confirmRequiredNotice: true).', 'confirmRequiredNotice');
  // Its topic, which it still has and hasn't archived: the capture leaves out its opt-outs, and the dispatcher skips those
  // made after it, whatever becomes of the topic (frozen with the draft in the review).
  const topic = await campaignTopic(db, a.workspaceId, draft, true);
  const rendered = await renderCampaignContent(runtime, draft), cfg = runtime.config;
  // What the campaign's screen would refuse in the background, measured now; admission refuses it for screened mail.
  let oversize: ApiError | undefined;
  if (cfg.screen && !isSimulatedSes(runtime) && cfg.hostedScreen) {
    const screen = await loadScreen();
    try { screen.assertScreenable(await screen.measureScreen(await campaignCopy(runtime, draft, rendered)), cfg.screenLimits.campaignBytes, 'campaign'); }
    catch (error) { if (!(error instanceof ApiError) || error.code !== 'CONTENT_TOO_LARGE_TO_SCREEN') throw error; oversize = error; }
  }
  // The sender, a marketing hold, the balance (402 now, so the owner learns before the campaign waits) and the attachments.
  const ids = distinctAttachmentIds(draft.attachments), local = { oversize: () => oversize };
  const decide = async (locks: SendScope | 'none') => {
    const decision = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'launch', locks, billable: 1, autoPause: input.pacing?.autoPause !== false,
      mails: [{ host: draft.from.split('@')[1]!.toLowerCase(), region: campaignSendRegion(runtime, row.draft), kind: 'marketing', attachments: ids, bodyBytes: 0, oversize: !!oversize }] }, undefined, actorAssets(a, ids));
    return (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s;
  };
  // Decided once before the capture, so a refused launch captures nothing, and again under the send locks after it. This
  // check locks the sender claim and the attachments it reads; rolling back its savepoint releases them, so none is held
  // through the capture (in the send locks' order they come after the admission row).
  await db.execute(sql`SAVEPOINT launch_check`);
  try { const check = await decide('none'); if (!check.allowed) throw refusal(runtime, check, local); }
  finally { await db.execute(sql`ROLLBACK TO SAVEPOINT launch_check`); await db.execute(sql`RELEASE SAVEPOINT launch_check`); }
  if (!postalAddress) throw postalAddressRequired();
  // The host of the links Nightmail adds (src/link-domains.ts), frozen in the review like the postal address, so every
  // copy of this launch links the same one. Refused here, after the sender's own checks, when the workspace is paused (or,
  // with own link hosts only, the domain has none active). The link domain is never frozen: each copy asks when it is made,
  // so a pause stops the rest at once, and a domain whose own link host turns active moves to it. A required notice has no
  // unsubscribe link.
  const choice = draft.requiredNotice ? undefined : await linkChoice(runtime, db, a.workspaceId, row.draft.from);
  const links = choice && !choice.shared ? choice.origin : undefined;
  const reviewId = id('review'), propertyKeys = placeholderKeys(draft, rendered);
  const audienceMod = await wrapModuleLoad(() => import('../audience/counts.js'));
  const smallList = await audienceMod.isSmallAudienceList(db, a, draft.audience.listId);
  let judgedRecipients: number | undefined;
  let queued: number;
  // Contacts the send skips as risky (src/list-hygiene.ts): exact for a captured audience, from list counts for a whole large list.
  let risky: { total: number; byReason: Record<string, number> } | null = null;
  let capturedAt: string | null = null;
  let capturedCount: number | null = null;
  if (smallList) {
    // The list probe's sample leads only where the probe applies (Hosted shared sending, live); elsewhere the order is the list's.
    const probed = runtime.config.multiTenant && !isSimulatedSes(runtime) && Boolean((await db.execute(sql`SELECT 1 WHERE ${sharedConnection(a.workspaceId)}`)).rowCount);
    const counts = await audienceMod.snapshotCampaignAudience(db, a, draft.audience, reviewId, propertyKeys, draft.requiredNotice === true, { large: false, topic, ...probed ? { leading: probeSize } : {} }).catch(error => {
      // A statement past the database's limit (or cancelled) ends the launch; its transaction keeps nothing.
      if ([error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014')) throw captureTimedOut();
      throw error;
    });
    queued = counts.eligible;
    risky = counts.risky;
    capturedAt = now();
    // Sync launch finalizes sending_campaigns in this same transaction, so capturedCount stays NULL (no pending finalizeCapture).
  } else {
    const estimate = await audienceMod.estimateCampaignAudience(db, a, draft.audience, draft.requiredNotice === true, row.audienceEstimate ?? null, topic);
    if (estimate.definitive === 'empty') throw audienceMod.emptyAudience(draft.requiredNotice === true);
    if (estimate.definitive === 'over_limit') throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaign reviews support at most 2,000,000 matching contacts. No recipients were truncated.');
    queued = estimate.queued;
    risky = estimate.risky ?? null;
    // Counting timed out (a large segment, launched without a fresh preview): the review judges the list's subscribers,
    // an upper bound, rather than 0 or a stale count, so a large send can't skip a required ramp by not being counted.
    if (estimate.approximate) judgedRecipients = Math.max(queued, await audienceMod.listSubscribedBound(db, a, draft.audience.listId));
  }
  // The send review as of now (src/standing-model.ts RAMP.readiness). A send it requires a ramp for goes with the
  // recommended plan, a daily limit no larger than its first day, or a consent source the sender confirms.
  const readiness = draft.requiredNotice ? null : await sendReadiness(runtime, db, a, { id: campaignId, draft },
    { recipients: judgedRecipients ?? queued, matched: null, risky: risky?.total ?? 0, neverMailed: null, lastSent: await audienceMod.listLastSent(db, a, draft.audience.listId) }, { launch: true });
  const plan = input.pacing?.plan === 'recommended' && readiness?.plan ? readiness.plan.batches : null;
  // A consent confirmation answers a new domain or a size jump, not a blocklist: after one, only a ramp will do.
  const consentWaives = !!input.consent && readiness?.required?.reason !== 'BLOCKLISTED';
  if (readiness?.required && !plan && !consentWaives && !(input.pacing?.perDay != null && input.pacing.perDay <= readiness.required.maxPerDay))
    throw new ApiError(422, 'RAMP_REQUIRED', `${readiness.summary} Send it with the recommended plan (pacing.plan "recommended"), a daily limit of at most ${readiness.required.maxPerDay.toLocaleString('en-US')}, or confirm where this list's consent comes from (consent).`, 'pacing');
  const consent = input.consent ? { source: input.consent.source, confirmedBy: a.keyId, confirmedAt: now() } : null;
  // The send locks. The campaign is still the revision that was captured, or the launch fails and its capture rolls back.
  const held = await lockSendScope(db, a.workspaceId, { campaignId });
  editable(await findCampaign(db, a, campaignId, true), input.revision);
  const route = admitted(runtime, await decide(held), a.workspaceId, local).mails[0]!;
  const reviewed={...row.draft,...route.binding ? {region:route.region,binding:route.binding} : {},postalAddress,...links ? {linkOrigin:links} : {}};
  const contentHash = await digest(canonical({ version: 2, draft: reviewed, rendered }));
  await db.insert(campaignReviews).values({ id: reviewId, rendererVersion: CAMPAIGN_RENDERER_VERSION, workspaceId: a.workspaceId, campaignId, revision: row.revision, draft: reviewed, contentHash, rendered, capturedAt, capturedCount, staticPrepared: false });
  // The list-risk measure of a marketing campaign's list, recorded on this review by a job (src/list-risk.ts); it decides nothing.
  if (!draft.requiredNotice && draft.audience?.listId) await db.execute(queueListRisk(a.workspaceId, campaignId, reviewId, draft.audience.listId,
    readiness ? { verdict: readiness.verdict, required: readiness.required?.reason ?? readiness.required?.by ?? null, reasons: (readiness.findings ?? readiness.reasons).map(reason => reason.code) } : null));
  await reserveCampaign(runtime, db, held, a, a.keyId, queued);
  // Who confirmed the notice and when, in the workspace's Activity.
  if (draft.requiredNotice) await recordAudit(db, c, { action: 'campaign.required_notice_confirmed', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaignId },
    details: { confirmation: 'This is a required notice with no promotion.', revision: row.revision, reviewId, recipients: queued, ...capturedAt ? {} : { deferredCapture: true }, ...input.scheduledAt ? { scheduledAt: input.scheduledAt } : {} } });
  // Who confirmed the list's consent source, and what it is, in the workspace's Activity.
  if (consent) await recordAudit(db, c, { action: 'campaign.consent_confirmed', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaignId },
    details: { source: consent.source, revision: row.revision, reviewId, recipients: queued, verdict: readiness?.verdict ?? null } });
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType: 'review' as const, ownerId: reviewId }))).onConflictDoNothing();
  const ref = campaignRef(a, campaignId);
  const moved = await db.execute(launchCampaign(ref, { reviewId, resolvedRegion:route.region!==row.draft.region ? route.region : undefined, actorKeyId: a.keyId, simulated: isSimulatedSes(runtime), total: queued, requestId: requestId ?? null, scheduledAt: input.scheduledAt ?? null,
    pacePerDay: input.pacing?.perDay ?? null, autoPause: input.pacing?.autoPause ?? true, rateShare: input.pacing ? input.pacing.rateShare ?? 0.5 : null,
    pacePlan: plan, firstBatch: plan ? readiness?.plan?.firstBatch ?? null : null, rampRequiredCap: readiness?.required?.maxPerDay ?? null, consent }));
  if (!moved.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being sent; fetch it and try again.');
  await db.execute(queueCampaignRun(ref, requestId ? { requestId } : {}));
  await db.execute(queueCampaignStats(ref, input.scheduledAt ?? null));
  return { id: campaignId, state: 'preparing' as const, queued, scheduledAt: input.scheduledAt ?? null, simulated: isSimulatedSes(runtime), risky, readiness };
}
