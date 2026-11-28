import { cachedDashboardRead } from '../dashboard-cache.js';
import { talliesEnabled } from '../sending-tallies.js';
import type { z } from '@hono/zod-openapi';
import { sql, getTableColumns, and, inArray } from 'drizzle-orm';
import { AudienceSpec } from '../core/http.js';
import type { Actor, Runtime, DbExecutor, Ctx } from '../core/types.js';
import { senderDomainAllowed } from '../core/access.js';
import { redactCapabilityText, ApiError, logError, schemaIssues, platformMessage, wrapModuleLoad, notFound, denied, describeApiFailure, apiFailureBody } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { type CampaignState, campaignEditable, CAMPAIGN_ACTIVE, CAMPAIGN_RUNNING } from '../states.js';
import { roomName } from '../campaign-room-protocol.js';
import { realDestination, CAMPAIGN_TESTS } from '../hosted-sending.js';
import { emails, type EmailStatus, campaigns, type CampaignDraft, type ReviewedRecipient } from '../db/sending.js';
import { postalAddressOf } from '../outbound-content.js';
import { linkReview, linkChoice, foundLinkOrigin } from '../link-domains.js';
import { type CheckMail, splitMailbox } from '../sendability-schema.js';
import { type RampAt, rampStart, RAMP, estimateFinish, judgeReadiness, rampLines, type ReadinessReason, LEGACY_READINESS_REASONS, LEGACY_REASON } from '../standing-model.js';
import { sentUntrustedContent, Email, type CampaignDraftSummary, scope, type StoppedDomain, emptyCounts, deliveryView, SendEstimate, limitsTable, sharedConnection, DAY_MS, CampaignReadiness, loadCampaignBlocks, campaignWhere, AudienceCounts, unsubscribePlaceholder, CAMPAIGN_RENDERER_VERSION, loadParse5, SendInput, campaignSendRegion } from '../sending/schemas.js';
import { activeFeedbackLag } from '../sending/events.js';
import { rampHistory } from './stats.js';
import { attachmentRows, type AttachmentFacts, interpolate, withPreheader } from '../sending/mime.js';
import { type Footer, campaignTopic, footerParts, prepare } from '../sending/front-door.js';

export const emailColumns = {
  untrustedContent: sentUntrustedContent,
  id: emails.id, region: emails.region, campaignId: emails.campaignId,
  from: emails.from, fromName: sql<string | null>`coalesce(${emails.snapshot}->>'fromName',CASE WHEN ${emails.reviewId} IS NOT NULL THEN (SELECT draft->>'fromName' FROM sending_campaign_reviews cr WHERE cr.id=${emails.reviewId} AND cr.workspace_id=${emails.workspaceId}) END)`, kind: sql<'transactional' | 'marketing'>`${emails.snapshot}->>'kind'`,
  to: emails.to, cc: emails.cc, bcc: emails.bcc, subject: emails.subject, status: emails.status,
  providerId: emails.providerId, simulated: emails.simulated, attemptStartedAt: emails.attemptStartedAt,
  errorCode: emails.errorCode, suppressionReason: emails.suppressionReason, scheduledAt: emails.scheduledAt, createdAt: emails.createdAt, updatedAt: emails.updatedAt,
};
// A waiting scheduled send reads queued with scheduled true: Email's status keeps its published values.
export function emailView(row: Omit<z.input<typeof Email>, 'status' | 'scheduled'> & { status: EmailStatus }) {
  return Email.parse({ ...row, status: row.status === 'scheduled' ? 'queued' : row.status, scheduled: row.status === 'scheduled' });
}
// Subjects can carry unsubscribe capability tokens; like getEmailDetail and getEmailContent, only manage callers read them.
export function listedSubject<T extends { subject: string }>(a: Pick<Actor, 'permissions'>, row: T): T { return a.permissions.includes('manage') ? row : { ...row, subject: redactCapabilityText(row.subject) }; }
// Draft sync polling reads only state columns, without materializing drafts or aggregating email counts.
export const campaignStateColumns = {
  id: campaigns.id, revision: campaigns.revision, updatedAt: campaigns.updatedAt,
  state: campaigns.state, scheduledAt: campaigns.scheduledAt, archivedAt: campaigns.archivedAt,
};
// Project the bounded list draft in PostgreSQL, before driver JSON parsing or application allocation.
const { draft: _draft, stats: _stats, ...campaignRowColumns } = getTableColumns(campaigns);
export const campaignSummaryColumns = {
  ...campaignRowColumns,
  draft: sql<z.infer<typeof CampaignDraftSummary>>`jsonb_strip_nulls(jsonb_build_object(
    'name', ${campaigns.draft}->'name', 'region', ${campaigns.draft}->'region', 'from', ${campaigns.draft}->'from',
    'fromName', ${campaigns.draft}->'fromName', 'subject', ${campaigns.draft}->'subject', 'previewText', ${campaigns.draft}->'previewText',
    'audience', jsonb_build_object('listId', ${campaigns.draft}->'audience'->'listId', 'segmentId', ${campaigns.draft}->'audience'->'segmentId')
  ))`,
};
export function campaignUrl(runtime: Runtime, row: { id: string; state: CampaignState; expanded: number }) {
  const url = new URL(`/campaigns/${encodeURIComponent(row.id)}/${campaignEditable(row) ? 'edit' : 'review'}`, runtime.config.publicUrl);
  return url.href;
}
type CampaignRow = Omit<typeof campaigns.$inferSelect, 'draft' | 'stats'> & { draft: unknown };
/** How long campaign detail reuses a large active campaign's per-status counts. The dashboard polls detail every 3 s while a campaign sends, and each count reads every recipient's email record. */
export const CAMPAIGN_PROGRESS_CACHE_SECONDS = 20;
/** Below this many recipients the count is cheap, so detail stays exact. */
export const CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS = 10_000;
export const CAMPAIGN_PROGRESS_SCOPE = `while a campaign of at least ${CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS.toLocaleString('en-US')} recipients is preparing, scheduled, sending or paused`;
export const CAMPAIGN_PROGRESS_NOTE = `For every credential, counts may be up to ${CAMPAIGN_PROGRESS_CACHE_SECONDS} seconds old ${CAMPAIGN_PROGRESS_SCOPE}; state and delivery are always current. Counts are exact for smaller campaigns, once a campaign is done, canceled or failed, and in the campaign that pause, resume and other changes return.`;
// A list read (read without detail) carries no send estimate; getCampaign and the responses about one campaign do.
export async function campaignViews<T extends CampaignRow>(runtime: Runtime, a: Actor, rows: T[], read?: { origin: string; detail?: boolean }, db: DbExecutor = runtime.db) {
  if (!rows.length) return [];
  const estimates = !read || read.detail ? await sendEstimates(runtime, db, a, rows) : null;
  let grouped: { campaignId: string | null; status: EmailStatus; count: number }[];
  if (a.domains.length) {
    grouped = [];
  } else if (await talliesEnabled(db)) {
    // Exact at read time from sending_campaign_tallies (< 2 ms at any scale, never cached, never scans sending_emails).
    const ids = rows.map(row => row.id);
    const { rows: tallied } = await db.execute<{ campaignId: string; status: EmailStatus; count: number }>(sql`SELECT
      campaign_id AS "campaignId", status, sum(email_count)::int AS count
      FROM sending_campaign_tallies
      WHERE workspace_id = ${a.workspaceId} AND campaign_id = ANY(${sql.param(ids)}::text[])
      GROUP BY 1, 2 HAVING sum(email_count) > 0`);
    grouped = tallied;
  } else {
    // Fallback when tally triggers are disabled (emergency undo): live GROUP BY with progress cache.
    const load = async () => db.select({ campaignId: emails.campaignId, status: emails.status, count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), inArray(emails.campaignId, rows.map(row => row.id)))).groupBy(emails.campaignId, emails.status);
    const cached = async (scope: unknown[], ttlSeconds?: number) => (await cachedDashboardRead(read!.origin, JSON.stringify(scope), load, ttlSeconds)).value;
    const [one] = rows, progress = read?.detail && rows.length === 1 && (CAMPAIGN_ACTIVE as readonly string[]).includes(one!.state) && one!.total >= CAMPAIGN_PROGRESS_CACHE_MIN_RECIPIENTS;
    grouped = progress ? await cached(['campaign-progress', a.workspaceId, one!.id, one!.reviewId], CAMPAIGN_PROGRESS_CACHE_SECONDS)
      : read && !read.detail && a.credential === 'dashboard' ? await cached(['campaign-counts', a.workspaceId, rows.map(r => [r.id, r.updatedAt])]) : await load();
  }
  const lag = rows.some(row => row.reviewId && ['preparing', 'sending', 'paused'].includes(row.state))
    ? await activeFeedbackLag(db).catch(() => null)
    : null;
  // Recipient domains a campaign stopped sending to (src/send-guards.ts), for its sender: one read by the table's key.
  const stopped = new Map<string, StoppedDomain[]>();
  const launched = rows.filter(row => row.reviewId).map(row => row.id);
  if (launched.length) for (const item of (await db.execute<StoppedDomain & { campaign_id: string }>(sql`SELECT campaign_id, domain,
      to_char(stopped_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "stoppedAt" FROM campaign_stopped_domains
      WHERE campaign_id = ANY(${sql.param(launched)}::text[]) AND workspace_id = ${a.workspaceId} ORDER BY campaign_id, stopped_at, domain`)).rows) {
    const list = stopped.get(item.campaign_id) ?? [];
    // The domain and when, never the counts that tripped it: those would show the private line (NIGHTMAIL_RAMP domainStop).
    if (list.length < 50) list.push({ domain: item.domain, stoppedAt: item.stoppedAt });
    stopped.set(item.campaign_id, list);
  }
  return rows.map(row => {
    const counts = emptyCounts();
    for (const item of grouped) if (item.campaignId === row.id) { counts.byStatus[item.status] = Number(item.count); counts.total += Number(item.count); }
    return { ...row, url: campaignUrl(runtime, row), counts, delivery: deliveryView(row, lag, stopped.get(row.id)), ...estimates ? { sendEstimate: estimates.get(row.id) ?? null } : {} };
  });
}
/**
 * Campaign.sendEstimate for each row: a draft (or a failed launch that released nobody) from its last audience count,
 * without pacing; a launched campaign from what it has left, its pacing and where it is on the ramp. One statement for
 * the region's planned rate and whether the ramp applies, and one more for the workspace's history while the campaign
 * has not taken its place on the ramp yet (its first release decides it).
 */
export async function sendEstimates(runtime: Runtime, db: DbExecutor, a: Actor, rows: CampaignRow[]) {
  const estimates = new Map<string, z.infer<typeof SendEstimate> | null>();
  for (const row of rows) {
    const editable = campaignEditable(row), held = !editable && (row.state === 'paused' || row.state === 'failed');
    if (!editable && !held && !(CAMPAIGN_RUNNING as readonly string[]).includes(row.state)) { estimates.set(row.id, null); continue; }
    const region = (row.draft as Pick<CampaignDraft, 'region'>).region;
    const [info] = (await db.execute<{ rate: number; hosted: boolean }>(sql`SELECT coalesce((SELECT max_send_rate FROM ${limitsTable(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)::float8 AS rate,
      ${runtime.config.multiTenant ? sharedConnection(a.workspaceId) : sql`false`} AS hosted`)).rows;
    const rate = Number(info?.rate ?? 0);
    let ramp: RampAt | null = null;
    if (info?.hosted && !(editable ? isSimulatedSes(runtime) : row.simulated)) {
      const decided = editable ? null : row.rampStep;
      const step = decided ?? rampStart(await rampHistory(db, a.workspaceId));
      const startedAt = decided !== null && row.rampWindowStartedAt ? Date.parse(row.rampWindowStartedAt) : null;
      if (step < RAMP.steps.length) ramp = { step, startedAt, released: startedAt === null ? 0 : Math.max(0, row.expanded - row.rampFrom) };
    }
    const recipients = editable ? row.audienceEstimate : Math.max(0, row.total - row.expanded);
    // As of the campaign's last change (a draft's as a duration), so reading it twice gives the same answer.
    const scheduled = row.scheduledAt && row.expanded === 0 ? Date.parse(row.scheduledAt) : NaN, start = editable ? 0 : Math.max(Date.parse(row.updatedAt), scheduled || 0);
    const finish = recipients === null ? null : estimateFinish({ recipients, start, ratePerSecond: rate,
      ...editable ? {} : { rateShare: row.rateShare, perDay: row.pacePlan?.length ? row.pacePlan : row.pacePerDay, day: { startedAt: row.windowStartedAt ? Date.parse(row.windowStartedAt) : null, released: row.windowExpanded, index: row.windowIndex } }, ramp });
    estimates.set(row.id, SendEstimate.parse({ recipients, ratePerSecond: rate > 0 ? rate : null, seconds: finish === null ? null : Math.round((finish - start) / 1000),
      finishAt: finish === null || editable || held ? null : new Date(finish).toISOString(),
      ramp: ramp && { step: ramp.step + 1, steps: RAMP.steps.length, ceilingPerHour: RAMP.steps[ramp.step]!.ceilingPerHour, startedAt: ramp.startedAt === null ? null : new Date(ramp.startedAt).toISOString(), released: ramp.released } }));
  }
  return estimates;
}
/**
 * The send review of a marketing campaign (CampaignReadiness, RAMP.readiness): the From domain (when this workspace added
 * it, its DMARC and MAIL FROM as last observed), the workspace's and the domain's history (campaign accepts from the tallies,
 * the workspace's last 30 days from the hourly metrics), the list (when it was made, last sent to and last imported into,
 * with that import's consent evidence) and how much larger this send is, then the verdict and the plan. Two statements;
 * `audience` brings the recipients. `lastSent`: when the list was last sent to, if the caller already knows.
 */
type ReviewedAudience = { recipients: number; matched: number | null; risky: number; neverMailed: number | null; lastSent: string | null };
/**
 * The send review. With the private ramp lines (NIGHTMAIL_RAMP) it sizes the plan by them. If that fails (an error or a
 * statement past its limit), a preview gets the review without them, saying so (unavailable) and never less cautious
 * than ramp_recommended. A launch (`launch`) is refused instead, retryable, with nothing sent or kept: without the
 * lines it would lose the ramps only they require (after blocklist replies, for a newly registered domain), the first
 * small batch and the split, so it never goes out on the fallback. A refusal the review means (an ApiError) stands.
 */
export async function sendReadiness(runtime: Runtime, db: DbExecutor, a: Actor, row: { id: string; draft: CampaignDraft }, audience: ReviewedAudience, o: { launch?: boolean } = {}) {
  if (!runtime.config.rampLines) return reviewSend(runtime, db, a, row, audience, false);
  try {
    return await reviewSend(runtime, db, a, row, audience, true);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // What failed, as every unexpected failure says it (logError): its type, SQLSTATE, a schema refusal's path and kind, and
    // the frames in our code. Its own message only when it is the platform's (platformMessage: never a database's text,
    // which quotes the statement's parameters) and not a schema refusal, which schema already says without the value.
    logError(error, { code: 'SEND_REVIEW_PLAN_UNAVAILABLE', stage: o.launch ? 'launch' : 'preview', campaignId: row.id, ...schemaIssues(error) ? {} : { cause: platformMessage(error) } });
    if (o.launch) {
      const refused = new ApiError(503, 'SEND_PLAN_UNAVAILABLE', 'The send plan couldn\'t be worked out just now, so nothing was sent and the campaign is still a draft. Try again in a minute.', undefined, true);
      refused.retryAfterSeconds = 60;
      throw refused;
    }
    const plain = await reviewSend(runtime, db, a, row, audience, false);
    const unavailable = 'This send\'s plan couldn\'t be sized just now, so this review leaves that part out and recommends sending in batches.';
    return { ...plain, verdict: plain.verdict === 'ready' ? 'ramp_recommended' as const : plain.verdict, summary: plain.summary ?? unavailable, unavailable };
  }
}
async function reviewSend(runtime: Runtime, db: DbExecutor, a: Actor, row: { id: string; draft: CampaignDraft }, audience: ReviewedAudience, tuned: boolean) {
  const domain = (row.draft.from.split('@')[1] ?? '').toLowerCase(), listId = row.draft.audience?.listId ?? null, r = RAMP.readiness, c = RAMP.check;
  // Where this campaign's links go (src/link-domains.ts): a blocklist lists the link domain as readily as the sender's.
  const links = await linkReview(runtime, db, a.workspaceId, row.draft.from), linkHost = links.origin ? new URL(links.origin).hostname.toLowerCase() : null;
  // Clean: within the ramp check's bounce and complaint lines, no reply named a blocklist in the days it went out, and the
  // delivery history has counted it (src/delivery-history.ts), so a send not counted yet is never taken for clean.
  // Without the private ramp lines (NIGHTMAIL_RAMP) the review is today's: clean is the bounce and complaint lines alone.
  const clean = sql`bounced<=accepted*${c.bounceRate}::float8 AND (complained<${c.complaints}::int OR complained<=accepted*${c.complaintRate}::float8)${tuned ? sql` AND NOT blocked AND counted` : sql``}`;
  const [f] = (await db.execute<{ first_seen: string | null; dmarc: string | null; mail_from: string | null; ws_largest: number; dom_largest: number; dom_clean: number;
    dom_accepted: number; dom_bounced: number; dom_complained: number; ws_accepted: number | null; ws_bounced: number | null; ws_complained: number | null; usual_day: number | null; first_sent: string | null;
    blocked_day: string | null; last_clean_done: string | null; uncounted: boolean;
    list_created: string | null; last_import: { at: string; contacts: number; consent: string | null } | null; rate: number; hosted: boolean }>(sql`WITH dom AS (
      SELECT dc.created_at, dc.identity->'dmarc'->>'status' AS dmarc, dc.identity->'ses'->'MailFromAttributes'->>'MailFromDomainStatus' AS mail_from FROM domain_claims dc
      WHERE dc.workspace_id=${a.workspaceId} AND (dc.name=${domain} OR right(${domain}, length(dc.name)+1)='.'||dc.name) ORDER BY length(dc.name) DESC LIMIT 1
    ), sent AS MATERIALIZED (
      SELECT c.created_at, c.state, lower(split_part(c.draft->>'from','@',2)) AS domain, t.accepted, t.bounced, t.complained,
        c.updated_at <= coalesce((SELECT cursor_at FROM delivery_history_state WHERE id='rollup'), '-infinity') AS counted,
        EXISTS (SELECT 1 FROM delivery_blocklist_daily b WHERE b.workspace_id=c.workspace_id AND b.from_domain=lower(split_part(c.draft->>'from','@',2))
          AND b.day BETWEEN c.created_at::date AND c.created_at::date+3 AND b.rejections>0) AS blocked FROM sending_campaigns c
      CROSS JOIN LATERAL (SELECT coalesce(sum(accepted),0)::float8 AS accepted, coalesce(sum(bounced),0)::float8 AS bounced, coalesce(sum(complained),0)::float8 AS complained
        FROM sending_campaign_tallies t WHERE t.workspace_id=c.workspace_id AND t.campaign_id=c.id AND NOT t.simulated) t
      WHERE c.workspace_id=${a.workspaceId} AND c.id<>${row.id} AND NOT c.simulated AND c.expanded>0 AND c.created_at>now()-make_interval(days=>${r.lookbackDays}::int)
    ), hours AS (
      SELECT sum(accepted)::float8 AS a, sum(bounced)::float8 AS b, sum(complained)::float8 AS c FROM (SELECT hour, sum(accepted) AS accepted, sum(bounced) AS bounced, sum(complained) AS complained
        FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND hour>=now()-make_interval(days=>${r.windowDays}::int) GROUP BY hour HAVING sum(simulated)=0) x
    ), days AS (
      SELECT date_trunc('day', hour) AS day, sum(accepted)::float8 AS a FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND hour>=now()-interval '14 days'
      GROUP BY 1 HAVING sum(simulated)=0 AND sum(accepted)>0
    )
    SELECT (SELECT created_at::text FROM dom) AS first_seen, (SELECT dmarc FROM dom) AS dmarc, (SELECT mail_from FROM dom) AS mail_from,
      coalesce((SELECT max(accepted) FROM sent),0)::int AS ws_largest, coalesce((SELECT max(accepted) FROM sent WHERE domain=${domain}),0)::int AS dom_largest,
      coalesce((SELECT max(accepted) FROM sent WHERE domain=${domain} AND ${clean}),0)::int AS dom_clean,
      coalesce((SELECT sum(accepted) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_accepted,
      coalesce((SELECT sum(bounced) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_bounced,
      coalesce((SELECT sum(complained) FROM sent WHERE domain=${domain} AND created_at>now()-make_interval(days=>${r.windowDays}::int)),0)::int AS dom_complained,
      (SELECT a FROM hours)::bigint AS ws_accepted, (SELECT b FROM hours)::bigint AS ws_bounced, (SELECT c FROM hours)::bigint AS ws_complained,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a) FROM days)::bigint AS usual_day,
      (SELECT min(hour)::text FROM sending_metrics_hourly WHERE workspace_id=${a.workspaceId} AND accepted>0 AND simulated=0) AS first_sent,
      (SELECT max(day)::text FROM delivery_blocklist_daily WHERE workspace_id=${a.workspaceId} AND (from_domain=${domain} OR link_host=${linkHost ?? ''}) AND day>current_date-90 AND rejections>0) AS blocked_day,
      (SELECT max(created_at)::text FROM sent WHERE domain=${domain} AND state='done' AND ${clean}) AS last_clean_done,
      EXISTS (SELECT 1 FROM sent WHERE domain=${domain} AND NOT counted) AS uncounted,
      (SELECT created_at::text FROM audience_lists WHERE workspace_id=${a.workspaceId} AND id=${listId}) AS list_created,
      (SELECT jsonb_build_object('at',i.created_at,'contacts',i.imported,'consent',(SELECT ca.evidence FROM audience_consent_audit ca WHERE ca.workspace_id=i.workspace_id
          AND ca.contact_id=i.sample_contact_ids[1] AND ca.import_id=i.id LIMIT 1))
        FROM audience_imports i WHERE i.workspace_id=${a.workspaceId} AND i.list_id=${listId} AND i.status='committed' ORDER BY i.created_at DESC LIMIT 1) AS last_import,
      coalesce((SELECT max_send_rate FROM ${limitsTable(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${row.draft.region}),0)::float8 AS rate,
      ${runtime.config.multiTenant ? sharedConnection(a.workspaceId) : sql`false`} AS hosted`)).rows;
  const live = !!f!.hosted && !isSimulatedSes(runtime), ageDays = f!.first_seen ? Math.floor((Date.now() - Date.parse(f!.first_seen)) / DAY_MS) : null;
  // How old the From domain and the domain its links go on are on the internet (src/domain-age.ts), apart from how long they have sent here.
  const age = await wrapModuleLoad(() => import('../domain-age.js'));
  const fromRoot = await age.registrableRoot(domain), linkRoot = await age.registrableRoot(links.origin ? new URL(links.origin).hostname : null);
  const registered = await age.registeredDays(db, [fromRoot, linkRoot]), reg = fromRoot ? registered.get(fromRoot) ?? null : null;
  const link = linkRoot && linkRoot !== fromRoot ? { name: linkRoot, registeredAt: registered.get(linkRoot)?.at ?? null, registeredDays: registered.get(linkRoot)?.days ?? null } : null;
  const usualDay = Number(f!.usual_day ?? 0), firstSentDays = f!.first_sent ? Math.floor((Date.now() - Date.parse(f!.first_sent)) / DAY_MS) : null;
  const dmarc = f!.dmarc && ['reject', 'quarantine', 'none', 'missing', 'invalid'].includes(f!.dmarc) ? f!.dmarc as 'reject' | 'quarantine' | 'none' | 'missing' | 'invalid' : null;
  const n = audience.recipients, wsAccepted = Number(f!.ws_accepted ?? 0);
  const judged = judgeReadiness({ recipients: n, matched: audience.matched, risky: audience.risky, neverMailed: audience.neverMailed, domainAgeDays: ageDays,
    dmarc: dmarc === null ? null : !['missing', 'invalid'].includes(dmarc), largestSend: f!.dom_largest, largestCleanSend: f!.dom_clean,
    accepted: wsAccepted, bounced: Number(f!.ws_bounced ?? 0), complained: Number(f!.ws_complained ?? 0), enforced: live,
    registeredDays: reg?.days ?? null, linkRegisteredDays: link?.registeredDays ?? null, usualDay, lines: tuned ? rampLines(runtime.config.rampLines) : undefined,
    blocklisted: !!f!.blocked_day && !(f!.last_clean_done && f!.last_clean_done.slice(0, 10) > f!.blocked_day), blocklistUncounted: !!f!.uncounted });
  const batches = judged.plan, first = batches[0] ?? 0, fmt = (v: number) => v.toLocaleString('en-US'), share = (v: number, of: number) => `${(100 * v / of).toFixed(of && v / of < 0.1 ? 1 : 0)}%`;
  const rampAt = live ? rampStart(await rampHistory(db, a.workspaceId)) : RAMP.steps.length;
  const seconds = batches.length > 1 ? estimateFinish({ recipients: n, start: 0, ratePerSecond: Number(f!.rate), perDay: batches, ramp: rampAt < RAMP.steps.length ? { step: rampAt, startedAt: null, released: 0 } : null }) : null;
  const ago = (days: number | null) => days === null ? 'recently' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${fmt(days)} days ago`;
  const month = (at: string | null) => at ? new Date(at + 'T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'an unknown date';
  const messages: Record<ReadinessReason, () => string> = {
    NEW_DOMAIN: () => `${domain} was added ${ago(ageDays)}, and when it was registered isn't known yet.`,
    NEW_HERE: () => `${fromRoot ?? domain} was registered in ${month(reg?.at ?? null)}; it was added here ${ago(ageDays)}${firstSentDays !== null && firstSentDays !== ageDays ? ` and this workspace first sent mail ${ago(firstSentDays)}` : ''}.`,
    NEW_REGISTRATION: () => `${fromRoot ?? domain} was registered ${ago(reg?.days ?? null)} (${month(reg?.at ?? null)}). Mailbox providers distrust mail from a domain that new.`,
    NEW_LINK_DOMAIN: () => `Its links go on ${link?.name}, registered ${ago(link?.registeredDays ?? null)}.`,
    BLOCKLISTED_BEFORE: () => `Replies to this workspace's mail ${linkHost && linkHost !== domain ? `from ${domain} or with links on ${linkHost}` : `from ${domain}`} named a blocklist on ${f!.blocked_day}, and no send has finished without one since.`,
    BLOCKLIST_UNCOUNTED: () => `The last send's blocklist replies aren't counted yet, so it isn't treated as a clean send.`,
    USUAL_JUMP: () => `This send is ${fmt(Math.round(judged.usualJump!))} times this workspace's usual day (${fmt(usualDay)} emails).`,
    SIZE_JUMP: () => `This send is ${fmt(Math.round(judged.jump!))} times the largest campaign ${domain} sent in the last ${r.lookbackDays} days (${fmt(f!.dom_largest)}).`,
    NO_HISTORY: () => f!.dom_largest ? `${domain}'s largest campaign in the last ${r.lookbackDays} days went to ${fmt(f!.dom_largest)} people.` : `${domain} hasn't sent a campaign in the last ${r.lookbackDays} days.`,
    RISKY_LIST: () => `${fmt(audience.risky)} risky addresses (${share(audience.risky, audience.matched ?? 1)} of the list) will be skipped.`,
    NEVER_MAILED: () => `${share(audience.neverMailed ?? 0, n)} of these recipients haven't been mailed before.`,
    NO_DMARC: () => `${domain} has no DMARC record.`,
    BOUNCES: () => `${share(Number(f!.ws_bounced), wsAccepted)} of the last ${r.windowDays} days' mail bounced.`,
    COMPLAINTS: () => `${share(Number(f!.ws_complained), wsAccepted)} of the last ${r.windowDays} days' mail was marked as spam.`,
  };
  const fb = judged.firstBatch, opening = fb ? ` The first day starts with ${fmt(fb.size)}, then waits ${fb.waitMinutes} minutes for their bounces and rejections before the rest.` : '';
  const headline = judged.requiredBy === 'BLOCKLISTED' ? `Mail from this sender drew replies naming a blocklist. Until a send finishes without any, sends go out in batches: we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'NEW_REGISTRATION' ? `This domain was registered recently and this list is much larger than anything it has sent. Mailbox providers block new domains that send to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'NEW_DOMAIN' ? `This domain is new and this list is much larger than anything it has sent. Mailbox providers block new senders who send to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.requiredBy === 'SIZE_JUMP' ? `This list is much larger than anything this domain has sent. Mailbox providers block senders who jump to huge lists at once, so we'll send ${fmt(first)} today and grow from there.`
    : judged.verdict === 'ramp_recommended' && batches.length > 1 ? `Send this over ${batches.length} days: ${fmt(first)} of the most engaged recipients first, people never mailed before last.` : null;
  const summary = headline && headline + opening;
  const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;
  const findings = judged.reasons.map(code => ({ code, message: messages[code]() }));
  const legacy = findings.flatMap(f => { const code = (LEGACY_READINESS_REASONS as readonly string[]).includes(f.code) ? f.code as (typeof LEGACY_READINESS_REASONS)[number] : LEGACY_REASON[f.code]; return code ? [{ code, message: f.message }] : []; })
    .filter((f, i, all) => all.findIndex(g => g.code === f.code) === i);
  return CampaignReadiness.parse({ verdict: judged.verdict, summary, reasons: legacy, findings,
    domain: { name: domain, firstSeenAt: f!.first_seen ? new Date(f!.first_seen).toISOString() : null, ageDays, dmarc,
      mailFrom: f!.mail_from === 'SUCCESS' ? 'verified' : f!.mail_from === 'PENDING' ? 'pending' : f!.mail_from === 'FAILED' || f!.mail_from === 'TEMPORARY_FAILURE' ? 'failed' : 'not_configured',
      ...(!row.draft.requiredNotice && runtime.config.linkHost && runtime.config.linkWarmup && links.origin === `https://${runtime.config.linkHost}` ? { sharedLinkPacing: true } : {}),
      linkHost: 'not_configured', ownLinkHost: links.own, linkOrigin: links.origin, registeredAt: reg?.at ?? null, registeredDays: reg?.days ?? null, linkDomain: link },
    history: { workspace: { largestSend: f!.ws_largest, firstSentAt: f!.first_sent ? new Date(f!.first_sent).toISOString() : null, usualDay, sent: wsAccepted, bounceRate: rate(Number(f!.ws_bounced ?? 0), wsAccepted), complaintRate: rate(Number(f!.ws_complained ?? 0), wsAccepted) },
      domain: { largestSend: f!.dom_largest, sent: f!.dom_accepted, bounceRate: rate(f!.dom_bounced, f!.dom_accepted), complaintRate: rate(f!.dom_complained, f!.dom_accepted) } },
    list: { recipients: n, risky: audience.risky, neverMailed: audience.neverMailed, createdAt: f!.list_created ? new Date(f!.list_created).toISOString() : null,
      lastSentAt: audience.lastSent ? new Date(audience.lastSent).toISOString() : null,
      lastImport: f!.last_import ? { at: new Date(f!.last_import.at).toISOString(), contacts: f!.last_import.contacts, consent: f!.last_import.consent } : null },
    sizeJump: judged.jump === null ? null : Math.round(judged.jump * 10) / 10, usualJump: judged.usualJump === null ? null : Math.round(judged.usualJump * 10) / 10,
    plan: batches.length > 1 ? { batches, seconds: seconds === null ? null : Math.round(seconds / 1000), firstBatch: judged.firstBatch } : null,
    required: judged.requiredBy ? { by: judged.requiredBy === 'NEW_REGISTRATION' ? 'NEW_DOMAIN' : judged.requiredBy === 'BLOCKLISTED' ? 'SIZE_JUMP' : judged.requiredBy, reason: judged.requiredBy, maxPerDay: first } : null });
}
/** An agent (API key or MCP) read or saved this draft: anyone with it open sees it for two minutes (src/campaign-room.ts),
 *  and a save (saved: its revision) shows on their pages at once, with the agent's name. In the background, only where
 *  rooms exist (the Worker), and only for a campaign that can still be edited. People are in the room through their own
 *  socket, and their tab tells it they saved. */
export function agentVisit(c: Ctx, a: Actor, campaign: typeof campaigns.$inferSelect, saved?: number) {
  if (!c.env.campaignRooms || !(a.credential === 'apiKey' || a.credential === 'mcp' || a.credential === 'agentToken') || campaign.archivedAt || !campaignEditable(campaign)) return;
  c.env.campaignRooms.visit(roomName(a.workspaceId, campaign.id), a.keyId, runtime => import('../ritual-version.js').then(({ credentialName }) => credentialName(runtime.db, a)), saved);
}
export function editable(row: typeof campaigns.$inferSelect, revision?: number) {
  if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before editing, reviewing or sending it.');
  if (revision !== undefined && row.revision !== revision) throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign has changed; fetch it and review again.');
  if (!campaignEditable(row)) throw new ApiError(409, 'CAMPAIGN_LOCKED', row.state === 'failed' ? 'This campaign already released recipients; resume or cancel it instead of changing it.' : 'Only drafts and failed campaigns that released nothing may be changed.');
}
/** Rejects campaign html outside the block vocabulary with the offending tag or attribute named. */
export async function assertBlockContent(html: string | undefined, complete = false) {
  if (!html) return;
  const { validateBlockHtml, BlockContentError } = await loadCampaignBlocks();
  try { validateBlockHtml(html, { complete }); } catch (error) {
    if (error instanceof BlockContentError) throw new ApiError(422, 'CAMPAIGN_CONTENT_INVALID', error.message, 'html');
    throw error;
  }
}
/** Block HTML becomes the styled email plus a plain-text alternative. Legacy drafts fail here with the block error until re-saved. */
export async function renderCampaignContent(runtime: Runtime, draft: Pick<CampaignDraft, 'html' | 'subject'>, complete = true): Promise<{ html: string | undefined; text: string | undefined }> {
  if (!draft.html?.trim()) return { html: undefined, text: undefined };
  await assertBlockContent(draft.html, complete);
  const { renderBlockHtml, renderBlockText } = await loadCampaignBlocks();
  return { html: renderBlockHtml(draft.html, { title: draft.subject }), text: renderBlockText(draft.html) || undefined };
}
/** A campaign, in one read with the footer its copies show: the postal address its launch froze, or the workspace's
 *  while it is still editable (campaignEditable). */
export async function campaignWithFooter(runtime: Runtime, a: Actor, campaignId: string): Promise<{ row: typeof campaigns.$inferSelect; footer: Footer }> {
  const frozen = sql`${campaigns.reviewId} IS NOT NULL AND NOT (${campaigns.state}='draft' OR (${campaigns.state}='failed' AND ${campaigns.expanded}=0))`;
  // The link host its copies use (src/link-domains.ts): the one its launch froze, else the sender's active one now.
  const sender = sql`lower(split_part(${campaigns.draft}->>'from','@',2))`;
  const [found] = await runtime.db.select({ row: campaigns, address: sql<string | null>`CASE WHEN ${frozen}
      THEN (SELECT r.draft->>'postalAddress' FROM sending_campaign_reviews r WHERE r.workspace_id=${a.workspaceId} AND r.id=${campaigns.reviewId})
      ELSE ${postalAddressOf(runtime.config.multiTenant, a.workspaceId)} END`,
    link: sql<string | null>`coalesce(CASE WHEN ${frozen} THEN (SELECT r.draft->>'linkOrigin' FROM sending_campaign_reviews r WHERE r.workspace_id=${a.workspaceId} AND r.id=${campaigns.reviewId}) END,
      (SELECT 'https://'||h.hostname FROM link_hosts h WHERE h.workspace_id=${a.workspaceId} AND h.status='active' AND (h.domain=${sender} OR right(${sender},length(h.domain)+1)='.'||h.domain) ORDER BY length(h.domain) DESC LIMIT 1))` })
    .from(campaigns).where(campaignWhere(a, campaignId));
  if (!found) return notFound('Campaign');
  // Without one, the link domain its copies would link on now, unless the workspace is paused (src/link-domains.ts): its
  // tests and previews show it. Nothing is recorded: a test is transactional, and its copies record as they are released.
  const link = found.link ?? (runtime.config.linkHost && !found.row.draft.requiredNotice
    ? (await linkChoice(runtime, runtime.db, a.workspaceId, found.row.draft.from).catch(() => null))?.origin : undefined);
  return { row: found.row, footer: { unsubscribePageUrl: found.row.draft.unsubscribePageUrl, postalAddress: found.address, requiredNotice: found.row.draft.requiredNotice, ...link ? { linkOrigin: link } : {} } };
}
// A draft's topic counts its opt-outs as not eligible, archived or not: archiving lets none of them through.
export const displayAudience = async (runtime: Runtime, a: Actor, draft: CampaignDraft, spec: z.infer<typeof AudienceSpec>) => {
  const [m, topic] = await Promise.all([wrapModuleLoad(() => import('../audience/counts.js')), campaignTopic(runtime.db, a.workspaceId, draft, false)]);
  return m.countCampaignAudienceForDisplay(runtime.db, a, spec, draft.requiredNotice === true, topic);
};
type DisplayAudience = ReturnType<typeof displayAudience>;

export async function savedCampaignAudience(runtime: Runtime, a: Actor, row: typeof campaigns.$inferSelect, shared?: DisplayAudience, withReadiness = false) {
  const audience = AudienceSpec.safeParse(row.draft.audience);
  if (!audience.success) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Choose an audience list before counting recipients.', 'audience.listId');
  const counts = await (shared ?? displayAudience(runtime, a, row.draft, audience.data));
  if (row.audienceEstimate !== counts.eligible) {
    // Review's revision-bound read mustn't write its estimate over a teammate's newer saved draft.
    await runtime.db.execute(sql`UPDATE sending_campaigns SET audience_estimate = ${counts.eligible}
      WHERE workspace_id = ${a.workspaceId} AND id = ${row.id} ${shared ? sql`AND revision = ${row.revision}` : sql``}`).catch(() => {});
  }
  // The send review, when asked for: a marketing campaign with a sender. The never-mailed count is its own bounded read.
  if (!withReadiness) return AudienceCounts.parse(counts);
  let readiness: z.infer<typeof CampaignReadiness> | null = null;
  if (!row.draft.requiredNotice && row.draft.from) {
    const audienceMod = await wrapModuleLoad(() => import('../audience/counts.js'));
    const lastSent = await audienceMod.listLastSent(runtime.db, a, audience.data.listId);
    const neverMailed = await audienceMod.countNeverMailed(runtime.db, a, audience.data, false, lastSent, await campaignTopic(runtime.db, a.workspaceId, row.draft, false));
    readiness = await sendReadiness(runtime, runtime.db, a, row, { recipients: counts.eligible, matched: counts.matched, risky: counts.risky, neverMailed, lastSent });
  }
  return AudienceCounts.parse({ ...counts, readiness });
}

export async function advisoryCheck(runtime: Runtime, a: Actor, mail: CheckMail, source: 'draft' | 'email' | 'campaign') {
  const domain = splitMailbox(mail.from).address.split('@').at(-1)!.toLowerCase();
  // Name the domain only when the caller sent it: a stored email's or campaign's sender is named by ID.
  if (!senderDomainAllowed(a.domains, domain)) throw denied('DOMAIN_NOT_ALLOWED', 'The From domain is outside this key’s scope.', { permission: 'sendEmail', level: 'on', ...(source === 'draft' ? { scope: `domain:${domain}` as const } : {}) }, 'from');
  const [{ checkMail }, { checkContext }] = await Promise.all([wrapModuleLoad(() => import('../sendability.js')), wrapModuleLoad(() => import('../sendability-context.js'))]);
  const context = await checkContext(runtime, a, domain);
  return checkMail(mail, source === 'campaign' ? { ...context, screenLimitBytes: runtime.config.screenLimits.campaignBytes } : context);
}

export async function campaignAdvisory(runtime: Runtime, a: Actor, { row, footer }: Awaited<ReturnType<typeof campaignWithFooter>>, shared?: DisplayAudience) {
  const d = row.draft, audience = AudienceSpec.safeParse(d.audience);
  const [rendered, recipients, files] = await Promise.all([renderCampaignContent(runtime, d, false), row.reviewId ? row.total : audience.success && !a.domains.length
    ? (shared ?? displayAudience(runtime, a, d, audience.data)).then(r => r.eligible) : undefined, attachmentRows(runtime.db, a, d.attachments)]);
  if (!d.from || (!rendered.html && !rendered.text)) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Set a sender and add content before checking this campaign.', 'campaignId');
  const mail: CheckMail = { from: d.from, fromName: d.fromName, subject: d.subject, ...rendered, previewText: d.previewText, tracking: d.tracking,
    ...d.requiredNotice ? { stream: 'transactional' as const } : { stream: 'marketing' as const, generatedUnsubscribe: true, postalAddress: !!footer.postalAddress },
    recipientCount: recipients === undefined ? undefined : Math.min(recipients, row.pacePerDay ?? Infinity), attachments: files, headers: d.replyTo?.[0] ? { 'Reply-To': d.replyTo[0] } : undefined };
  return advisoryCheck(runtime, a, mail, 'campaign');
}

export async function reviewPart<T>(c: Ctx, read: Promise<T>) {
  try { return { data: await read } as const; }
  catch (error) {
    const { responseError, known, transient, conflict } = describeApiFailure(error), requestId = c.get('requestId');
    if (!known && responseError.status >= 500) logError(error, { requestId, route: 'campaign.review-display', code: responseError.code, status: responseError.status });
    return { status: responseError.status, error: apiFailureBody(responseError, requestId), ...(transient || conflict ? { retryAfter: 1 } : {}) } as const;
  }
}

/** A campaign's preview: its rendered draft with the footer its emails get, the link a placeholder on the link host
 *  its launch would use. A draft that couldn't launch for want of one shows this installation's own: it is never sent. */
export async function previewParts(runtime: Runtime, workspaceId: string, draft: CampaignDraft, footer: Footer) {
  const rendered = await renderCampaignContent(runtime, draft, false);
  if (!rendered.html && !rendered.text) return rendered;
  let origin = runtime.config.publicUrl;
  if (!footer.requiredNotice) try { origin = foundLinkOrigin(runtime.config, workspaceId, draft.from, footer.linkOrigin); } catch { /* Never sent: shown as this installation's own. */ }
  footerParts(rendered, unsubscribePlaceholder(origin), footer);
  return rendered;
}
const RECIPIENT_CONTENT_ERRORS = new Set(['CAMPAIGN_RECIPIENT_INVALID', 'MISSING_TEMPLATE_VARIABLE', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'UNSAFE_TEMPLATE_CONTEXT', 'UNSAFE_HTML_URL', 'ENCODED_MESSAGE_TOO_LARGE', 'RENDERED_CONTENT_TOO_LARGE']);
// rendered: the content the review already rendered and checked, or undefined to render the draft now (a test).
// rows: the campaign's attachments that size each copy, or null when admission sizes it (a test).
export async function campaignMessage(runtime: Runtime, draft: CampaignDraft, contact: ReviewedRecipient, test: boolean, rows: AttachmentFacts[] | null, rendered?: { html?: string; text?: string }, templateValidated = false, htmlValidated = false, version = CAMPAIGN_RENDERER_VERSION) {
  try {
    const values = { ...draft.defaults, ...Object.fromEntries(Object.entries(contact.properties).filter(([, value]) => value !== null && value !== undefined)), email: contact.email, ...(contact.name ? { name: contact.name } : {}) };
    rendered ??= await renderCampaignContent(runtime, draft);
    const parse = rendered.html && (!templateValidated || draft.previewText) ? await loadParse5() : undefined;
    const parsed = SendInput.safeParse({ from: draft.from, fromName: draft.fromName, to: contact.email, replyTo: draft.replyTo, region: test ? campaignSendRegion(runtime,draft) : draft.region, kind: test ? 'transactional' : 'marketing', subject: interpolate(draft.subject, values, false, templateValidated), html: withPreheader(interpolate(rendered.html, values, true, templateValidated, parse), draft.previewText, parse, version), text: interpolate(rendered.text, values, false, templateValidated), attachments: draft.attachments, tracking: test ? false : draft.tracking });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))].join(', ');
      throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Recipient or rendered message is invalid (${fields}).`);
    }
    const snapshot = await prepare(parsed.data, rows, htmlValidated);
    if (draft.previewText !== undefined) snapshot.previewText = draft.previewText;
    return snapshot;
  } catch (error) {
    // Add only a contact identifier to known local validation failures; never rewrite database/provider errors.
    if (error instanceof ApiError && RECIPIENT_CONTENT_ERRORS.has(error.code)) {
      // A test has no contact: name the sample data that fills the gap instead of an internal recipient id.
      if (test && error.code === 'MISSING_TEMPLATE_VARIABLE') throw new ApiError(error.status, error.code, `This email uses {{${error.field}}} but the test has no value for it. Add a fallback value for ${error.field} (defaults.${error.field}) or a sample value (data.${error.field}).`, `data.${error.field}`, error.retryable);
      throw new ApiError(error.status, error.code, test ? error.message : `Contact ${contact.id}: ${error.message}`, test ? error.field : 'contactId', error.retryable);
    }
    throw error;
  }
}

/**
 * The front door of a Hosted campaign test (CAMPAIGN_TESTS), in one statement before the screen reads it: its address is
 * the workspace's own (the members rule is the built-in domain's, migration 501), and this hour has room, which it takes.
 * A domain counts only while its verification is current: one whose records went missing ('lost', still sending through
 * its grace period) proves nothing about who receives there now.
 */
export async function admitCampaignTest(runtime: Runtime, a: Actor, to: string) {
  if (!runtime.config.multiTenant) return;
  const address = to.toLowerCase(), host = address.split('@')[1]!;
  const { rows: [gate] } = await runtime.db.execute<{ own: boolean; charged: boolean; reset_at: string }>(sql`WITH own AS (SELECT ${!realDestination(address)}
      OR EXISTS (SELECT FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=${a.workspaceId} AND u.email_verified AND lower(u.email)=${address})
      OR EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id=${a.workspaceId} AND dc.sending_state='verified' AND (dc.name=${host} OR right(${host},length(dc.name)+1)='.'||dc.name)) AS ok),
    charge AS (INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) SELECT ${a.workspaceId},'campaign-test',date_trunc('hour',now()),1 FROM own WHERE ok
      ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
      WHERE b.window_start<>excluded.window_start OR b.used<${CAMPAIGN_TESTS.perHour} RETURNING 1)
    SELECT (SELECT ok FROM own) AS own, EXISTS (SELECT FROM charge) AS charged, date_trunc('hour',now())+interval '1 hour' AS reset_at`);
  if (!gate!.own) throw new ApiError(422, 'TEST_RECIPIENT_NOT_OWNED', `A campaign test goes only to an address this workspace has proven is its own: a member’s verified email or an address at one of its currently verified domains, its receiving addresses and inboxes included. Send the campaign to reach ${to}.`, 'to');
  if (!gate!.charged) {
    const resetAt = new Date(gate!.reset_at).toISOString();
    throw new ApiError(429, 'CAMPAIGN_TEST_LIMIT', `A workspace sends at most ${CAMPAIGN_TESTS.perHour} campaign tests an hour, and this hour’s are used. Try again after ${resetAt.slice(11, 16)} UTC.`, undefined, true, resetAt);
  }
}
