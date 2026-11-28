import { blocklistWindow, campaignBlocklistReplies } from '../send-guards.js';
import { mailRevision } from '../dashboard-cache.js';
import { recordAudit } from '../audit.js';
import { createRoute, z } from '@hono/zod-openapi';
import { sql, and, isNotNull, isNull, eq, desc } from 'drizzle-orm';
import { security, json, response, id, page, readCursor, literalSearch, timed, nextCursor, digest, readLimitNote, IdParams, budgetedRead, readLimit, AudienceSpec, chargeRenderBudget } from '../core/http.js';
import type { App, Ctx } from '../core/types.js';
import { actor } from '../core/access.js';
import { errors, wrapModuleLoad, ApiError, denied, notFound } from '../core/errors.js';
import { region } from '../core/ses.js';
import { wakeWebhooks } from '../jobs.js';
import { CAMPAIGN_ACTIVE, reviseCampaign, campaignEditable, campaignResumable, runningState, resumeCampaign, clearProbe, restrictToDelivered, queueCampaignRun, setCampaignPacing, wakeCampaignRun, unscheduleCampaign, retireCampaignRun, rescheduleCampaign } from '../states.js';
import { roomName, ADMISSION_MS } from '../campaign-room-protocol.js';
import { lockSendScope } from '../send-scope.js';
import { CAMPAIGN_TESTS, hostedCost } from '../hosted-sending.js';
import { campaigns, attachmentLinks, campaignReviews } from '../db/sending.js';
import { foundLinkOrigin } from '../link-domains.js';
import { IdempotencyHeaders, idempotent, SendIdempotencyHeaders } from '../idempotency.js';
import { PREVIEW_ROUTE_NOTE, previewResponses, refuseHead, renderPreview } from '../preview-images.js';
import { QUARANTINE_CODES } from '../admission.js';
import { assertResponseWithinLimit } from '../isolate-memory.js';
import { withBoundedRead } from '../read-bounds.js';
import { rampLines } from '../standing-model.js';
import { CampaignCreate, Campaign, keyed, draftRegion, draftSender, draftAudience, emptyCounts, campaignReplay, CampaignQuery, CampaignSummary, pageBinding, campaignWhere, READ_LIMIT, findCampaign, LARGE_READ_RESERVE_THRESHOLD, STATS_NOTE, CampaignStats, CampaignContentGuide, loadCampaignBlocks, CampaignPreview, AudienceCounts, CampaignPreviewImage, CampaignState, CampaignUpdate, scope, CampaignArchive, now, Removed, screenBytes, SCREEN, TestCampaign, Receipt, unsubscribePlaceholder, CAMPAIGN_POSTAL_NOTE, CAMPAIGN_SCREEN_NOTE, CAMPAIGN_CAPTURE_NOTE, CampaignSend, CampaignQueued, CampaignSchedule, CampaignCanceled, type CampaignChange, sendingOnly, controlCampaign, pausing, sharedConnection } from '../sending/schemas.js';
import { statsDue, storedStats, queueCampaignsStats, listedStats, queueCampaignStats, campaignStats } from './stats.js';
import { assertBlockContent, sendEstimates, campaignUrl, CAMPAIGN_PROGRESS_CACHE_SECONDS, CAMPAIGN_PROGRESS_SCOPE, campaignSummaryColumns, campaignViews, CAMPAIGN_PROGRESS_NOTE, agentVisit, campaignWithFooter, previewParts, savedCampaignAudience, editable, displayAudience, reviewPart, campaignAdvisory, campaignStateColumns, campaignMessage, admitCampaignTest } from './views.js';
import { linkAttachments, attachmentRows, bytesDigest } from '../sending/mime.js';
import { draftTopic, requiredNoticesAllowed, claimedSend, sendCall, footerParts, type Outgoing, mayScreenAtAccept, prepareFrontDoor } from '../sending/front-door.js';
import { campaignRef, launch, cancelCampaignWork, reserveCampaign, hostedAutoPauseRequired } from './launch.js';

export function registerCampaigns(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns', operationId: 'createCampaign', description: 'Create a campaign draft; only a name is required. templateId copies an active published global template, including its content and assets, into this workspace. With regional MX delivery, drafts can be edited before sender setup is complete; the sender and region are checked when sending a test or launching. Returns a dashboard URL so an agent and user can continue editing together.', tags: ['Campaigns'], security, request: { headers: IdempotencyHeaders, body: json(CampaignCreate) }, responses: { 201: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    await assertBlockContent(input.html);
    const result = await idempotent(c.env.db, keyed(c, a), input, async db => {
      const campaignId = id('campaign'); const source = input.templateId ? await (await wrapModuleLoad(() => import('../templates.js'))).instantiateTemplate(c.env, db, a, input.templateId) : null;
      const draft = { name: input.name, from: input.from, ...(input.fromName ?? source?.draft.fromName ? { fromName: input.fromName ?? source?.draft.fromName } : {}), ...(input.previewText ?? source?.draft.previewText ? { previewText: input.previewText ?? source?.draft.previewText } : {}), replyTo: input.replyTo.length ? input.replyTo : source?.draft.replyTo ?? [], ...await draftRegion(c.env,db,a,input), subject: input.subject || source?.draft.subject || '', attachments: [...new Set([...(source?.draft.attachments ?? []), ...input.attachments])], tracking: input.tracking ?? source?.draft.tracking ?? true, audience: input.audience, defaults: { ...(source?.draft.defaults ?? {}), ...input.defaults }, ...(input.html ?? source?.draft.html ? { html: input.html ?? source?.draft.html } : {}), ...(input.unsubscribePageUrl ?? source?.draft.unsubscribePageUrl ? { unsubscribePageUrl: input.unsubscribePageUrl ?? source?.draft.unsubscribePageUrl } : {}), ...(input.topicId ? { topicId: input.topicId } : {}), ...(input.requiredNotice ? { requiredNotice: true } : {}) };
      draftSender(c.env, a, draft);
      await draftAudience(db, a, draft.audience);
      await draftTopic(db, a, draft);
      await requiredNoticesAllowed(db, draft, a.workspaceId);
      await linkAttachments(db, a, draft.attachments, 'campaign', campaignId);
      const [row] = await db.insert(campaigns).values({ id: campaignId, workspaceId: a.workspaceId, draft, sourceTemplateId: source?.templateId ?? null, sourceTemplateRevision: source?.templateRevision ?? null }).returning();
      return { ...row!, counts: emptyCounts() };
    }, { replayed: campaignReplay(a) });
    const sendEstimate = (await sendEstimates(c.env, c.env.db, a, [result])).get(result.id) ?? null;
    return c.json(Campaign.parse({ ...result, archivedAt: result.archivedAt ?? null, url: campaignUrl(c.env, result), delivery: null, sendEstimate }), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns', operationId: 'listCampaigns', description: `Returns bounded campaign metadata summaries. Fetch an individual campaign for its full editable draft; list drafts omit bodies, defaults, attachments and audience exclusions. Dashboard list counts may be cached for up to 60 seconds; API credentials get exact list counts. getCampaign may reuse counts for up to ${CAMPAIGN_PROGRESS_CACHE_SECONDS} seconds ${CAMPAIGN_PROGRESS_SCOPE}. A newsletter's issues are the campaigns to its list: filter with listId.`, tags: ['Campaigns'], security, request: { query: CampaignQuery }, responses: { 200: response(page(CampaignSummary)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), binding = await pageBinding(a, 'campaigns', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    // list_id is the draft's audience list (migration 394), so these filters never read a draft; a newsletter is a list with a sender.
    const newsletterList = sql`EXISTS (SELECT 1 FROM audience_lists l WHERE l.workspace_id = ${campaigns.workspaceId} AND l.id = ${campaigns.listId} AND l.newsletter_from IS NOT NULL)`;
    const rows = await timed(c, 'campaign-list-db', () => c.env.db.select({ ...campaignSummaryColumns, stats: campaigns.stats,
      // Only beside a stored count (the draft is read again for it).
      tracking: sql<boolean | null>`CASE WHEN ${campaigns.stats}->>'reviewId' = ${campaigns.reviewId} THEN (${campaigns.draft}->>'tracking')::boolean END` }).from(campaigns).where(and(campaignWhere(a),
      q.archived === 'true' ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt),
      cursor ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.region ? sql`${campaigns.draft}->>'region' = ${q.region}` : undefined, q.state ? eq(campaigns.state, q.state) : undefined,
      search ? sql`(${campaigns.id} ILIKE ${search} OR ${campaigns.draft}->>'name' ILIKE ${search} OR ${campaigns.draft}->>'subject' ILIKE ${search})` : undefined,
      q.listId ? eq(campaigns.listId, q.listId) : undefined, q.newsletter === 'true' ? newsletterList : q.newsletter === 'false' ? sql`NOT ${newsletterList}` : undefined,
    )).orderBy(desc(campaigns.createdAt), desc(campaigns.id)).limit(q.limit + 1));
    const listed = rows.slice(0, q.limit);
    // A newsletter's issues: finished campaigns whose stored count is missing or stale are counted in the background (the
    // job deduplicates), so their figures appear on a later read. This read counts nothing. A stale count is queued only
    // when the job would count again (campaignStatsJob): the workspace's mail changed since, or the campaign did, so a read
    // of a quiet workspace queues nothing.
    const finished = q.listId ? listed.filter(row => !(CAMPAIGN_ACTIVE as readonly string[]).includes(row.state) && statsDue(row)) : [];
    const revision = finished.some(row => storedStats(row)) ? await mailRevision(c.env, a.workspaceId) : null;
    const due = finished.filter(row => { const stored = storedStats(row); return !stored || stored.revision !== revision || Date.parse(stored.computedAt) < Date.parse(row.updatedAt); }).map(row => row.id);
    if (due.length) await c.env.db.execute(queueCampaignsStats(a.workspaceId, due));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, listed.map(({ stats: _stats, tracking: _tracking, ...row }) => row), { origin: new URL(c.req.url).origin }));
    return c.json({ data: views.map((row, i) => CampaignSummary.parse({ ...row, stats: listedStats(listed[i]!) })), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  // The dashboard's campaign room (src/campaign-room.ts): a WebSocket that shows who else has the campaign open. Not part of
  // the public API, and people only: agents appear through their own reads and saves (agentVisit). A browser's WebSocket
  // carries no headers of its own, so the Worker takes its account and workspace from this URL's query (worker.ts).
  app.get('/v1/campaigns/:id/room', async c => {
    const rooms = c.env.campaignRooms;
    if (!rooms) throw new ApiError(404, 'PRESENCE_UNAVAILABLE', 'Live presence needs campaign rooms, which only the Cloudflare deployment runs.');
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(426, 'WEBSOCKET_REQUIRED', 'Open the campaign room with a WebSocket.');
    const a = actor(c);
    if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    // Cookies ride along on any site's WebSocket to this host, so only the dashboard's own pages may open one.
    (await import('../account-login.js')).requireDashboardOrigin(c.env, c.req.raw);
    const campaignId = c.req.param('id');
    const [row] = await c.env.db.select({ id: campaigns.id }).from(campaigns).where(campaignWhere(a, campaignId)).limit(1);
    if (!row) notFound('Campaign');
    // The room knows each person by a key of its own, never their user ID, and shows API keys' and MCP clients' names
    // only to those who see them in Settings (owners and admins; self-hosted, everyone).
    const room = roomName(a.workspaceId, campaignId), key = (await digest(`${room}:${a.keyId}`)).slice(0, 16);
    const names = !c.env.config.multiTenant || a.role === 'owner' || a.role === 'admin';
    return rooms.connect(room, { kind: 'person', id: key, name: a.name?.trim() || 'A teammate', view: c.req.query('view') === 'review' ? 'review' : 'write', names, until: Date.now() + ADMISSION_MS });
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}', operationId: 'getCampaign', description: `The campaign with its full draft, per-status email counts and delivery progress. ${CAMPAIGN_PROGRESS_NOTE} ${readLimitNote(READ_LIMIT.campaign)}`, tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c), campaignId = c.req.valid('param').id;
    const [probe] = await c.env.db.select({ bytes: sql<number>`coalesce(octet_length(${campaigns.draft}::text), 0)::int` }).from(campaigns).where(campaignWhere(a, campaignId)).limit(1);
    if (!probe) notFound('Campaign');
    assertResponseWithinLimit(c.req.raw, probe.bytes + 4096);
    const run = async (): Promise<Response> => {
      const row = await timed(c, 'campaign-db', () => findCampaign(c.env.db, a, campaignId));
      agentVisit(c, a, row);
      const views = await timed(c, 'campaign-counts-db', () => budgetedRead(c.env.db, db => campaignViews(c.env, a, [row], { origin: new URL(c.req.url).origin, detail: true }, db), readLimit(READ_LIMIT.campaign)));
      return c.json(Campaign.parse(views[0]!), 200);
    };
    return (probe.bytes > LARGE_READ_RESERVE_THRESHOLD * 2 ? await withBoundedRead(c, () => run(), { route: 'campaign.get', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/stats', operationId: 'getCampaignStats', description: 'Lifetime campaign delivery and unique open/click statistics, progress, tracking setting and rates with numeric numerators/denominators. Counts distinct emails across all stored feedback, not event occurrences. Delivery/bounce/complaint rates use accepted emails; open/click rates use delivered emails. Both rate counts exclude simulated emails. Rates are fractions, null for zero denominators; engagement rates are also null with tracking disabled. Delivered means receiving-server acceptance, not inbox placement. Engagement includes bots/privacy proxies. Done means dispatch finished; asynchronous feedback can still change totals. ' + STATS_NOTE + ' ' + readLimitNote(READ_LIMIT.campaignStats), tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignStats), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    // Queued before the read, so one that runs out of time is answered from the count next time.
    if (statsDue(row)) await c.env.db.execute(queueCampaignStats(campaignRef(a, row.id)));
    return c.json(CampaignStats.parse((await budgetedRead(c.env.db, db => campaignStats(db, a, [row]), readLimit(READ_LIMIT.campaignStats))).get(row.id)!), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaign-content-guide', operationId: 'getCampaignContentGuide', description: 'The complete campaign and template content vocabulary, personalization syntax, restrictions and examples as Markdown. Read it once before writing or editing html.', tags: ['Campaigns'], security, responses: { 200: response(CampaignContentGuide), ...errors } }), async c => {
    actor(c);
    const { CAMPAIGN_CONTENT_GUIDE } = await loadCampaignBlocks();
    return c.json({ format: 'markdown' as const, markdown: CAMPAIGN_CONTENT_GUIDE }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview', operationId: 'previewCampaign', description: 'Renders the saved draft’s block HTML as the styled email and its plain-text alternative, with the footer every email gets (the Unsubscribe link, a placeholder here, and the workspace’s postal address) and without personalization. Placeholders remain visible as {{name}}.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignPreview), ...errors } }), async c => {
    const a = actor(c), { row, footer } = await campaignWithFooter(c.env, a, c.req.valid('param').id);
    const rendered = await previewParts(c.env, a.workspaceId, row.draft, footer);
    return c.json({ html: rendered.html ?? '', text: rendered.text ?? '' }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/audience', operationId: 'previewCampaignAudience', description: 'Counts the saved audience right now: matched contacts and how many are eligible, suppressed or unsubscribed. With readiness=true it also reviews the send (CampaignReadiness): whether it is ready to go out as it is, why, and the daily batches it recommends; send it with pacing.plan "recommended" to follow them. Read-only and never frozen; send or schedule takes its own snapshot and consent is rechecked at dispatch.', tags: ['Campaigns'], security, request: { params: IdParams, query: z.object({ readiness: z.enum(['true', 'false']).optional().describe('Also review the send (readiness).') }) }, responses: { 200: response(AudienceCounts), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    return c.json(await savedCampaignAudience(c.env, a, row, undefined, c.req.valid('query').readiness === 'true'), 200);
  });
  // One authenticated presentation read for Review; public audience and advisory operations stay separate.
  app.get('/v1/campaigns/:id/review-display', async c => {
    const a = actor(c, 'read');
    if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const input = z.object({ id: IdParams.shape.id, revision: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int()),
      check: z.enum(['true', 'false']), readiness: z.enum(['true', 'false']).optional() }).safeParse({ id: c.req.param('id'), revision: c.req.query('revision'), check: c.req.query('check'), readiness: c.req.query('readiness') });
    if (!input.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Supply the saved campaign revision and whether to run Checks.');
    const saved = await campaignWithFooter(c.env, a, input.data.id);
    editable(saved.row, input.data.revision);
    const spec = AudienceSpec.safeParse(saved.row.draft.audience);
    const shared = spec.success ? displayAudience(c.env, a, saved.row.draft, spec.data) : undefined;
    const [audience, check] = await Promise.all([
      reviewPart(c, savedCampaignAudience(c.env, a, saved.row, shared, input.data.readiness === 'true')),
      input.data.check === 'true' ? reviewPart(c, campaignAdvisory(c.env, a, saved, shared)) : null,
    ]);
    return c.json({ audience, check }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview-image', operationId: 'renderCampaignPreviewImage', description: 'Renders the saved campaign draft as a full-page, 720 px wide PNG for visual review. Inline CID images are embedded; remote HTTPS images are loaded by the isolated renderer.' + PREVIEW_ROUTE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams }, responses: { ...previewResponses(CampaignPreviewImage), ...errors } }), async c => {
    refuseHead(c);
    const a = actor(c, 'send'), { row, footer } = await campaignWithFooter(c.env, a, c.req.valid('param').id);
    // Nothing to render (renderCampaignContent renders no HTML) is the caller's to fix, answered before the renderer is asked and before the render budget.
    if (!row.draft.html?.trim()) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'This campaign has no content to render yet. Add content to its draft, then preview it.', 'html');
    if (!c.env.renderHtmlImage) throw new ApiError(503, 'PREVIEW_RENDERING_UNAVAILABLE', 'Visual campaign preview rendering is not configured.', undefined, true);
    await chargeRenderBudget(c, a.workspaceId);
    const inline = (await attachmentRows(c.env.db, a, row.draft.attachments)).filter(item => item.disposition === 'inline' && item.contentId), render = c.env.renderHtmlImage;
    // The page is passed on, not kept here: renderPreview drops it once it is rendered.
    const link = await renderPreview(c.env, a.workspaceId, (await previewParts(c.env, a.workspaceId, row.draft, footer)).html ?? '', inline, async item => {
      const asset = await c.env.storage.get(item.storageKey);
      if (!asset || asset.body.length !== item.size || await bytesDigest(asset.body) !== item.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An inline campaign image is missing or changed.', undefined, true);
      return asset.body;
    }, async (page, grow) => {
      try { return await render(page, grow); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'PREVIEW_RENDERING_FAILED', 'The visual campaign preview could not be rendered. Try again.', undefined, true); }
    });
    c.header('Location', link.url);
    return c.json({ ...link, mimeType: 'image/png' as const }, 303);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/state', operationId: 'getCampaignState', description: 'Compact authenticated state for draft sync polling; fetch the full campaign with getCampaign when state changes. Compare all returned fields, not only revision: archive and delivery changes need not increment the draft revision. Omits draft content and delivery counts.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignState), ...errors } }), async c => {
    const [row] = await c.env.db.select(campaignStateColumns).from(campaigns).where(campaignWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(CampaignState.parse(row ?? notFound('Campaign')), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}', operationId: 'updateCampaign', description: 'Replace the whole draft at the current revision. Read the campaign first: html is block HTML that people may have edited in the dashboard composer, so send the complete updated html rather than a fragment. Rejected content names the unsupported tag or attribute. A failed campaign becomes a draft again.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignUpdate) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    await assertBlockContent(input.draft.html);
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      const draft = {...input.draft,...await draftRegion(c.env,db,a,input.draft,current.draft)};
      draftSender(c.env, a, draft);
      draftSender(c.env, a, current.draft); editable(current, input.revision);
      await draftAudience(db, a, draft.audience, current.draft.audience);
      await draftTopic(db, a, draft, current.draft);
      await requiredNoticesAllowed(db, draft, a.workspaceId);
      await attachmentRows(db, a, input.draft.attachments, true);
      await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId)));
      await linkAttachments(db, a, input.draft.attachments, 'campaign', campaignId);
      const audienceChanged = JSON.stringify(draft.audience ?? null) !== JSON.stringify(current.draft.audience ?? null) || Boolean(draft.requiredNotice) !== Boolean(current.draft.requiredNotice) || (draft.topicId ?? null) !== (current.draft.topicId ?? null);
      const revised = await db.execute<typeof campaigns.$inferSelect>(reviseCampaign(campaignRef(a, campaignId), sql`,draft=${JSON.stringify(draft)}::jsonb,revision=${current.revision + 1}${audienceChanged ? sql`,audience_estimate=NULL` : sql``}`));
      if (!revised.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being saved; fetch it and try again.');
      return (await findCampaign(db, a, campaignId))!;
    });
    agentVisit(c, a, row, row.revision);
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}/archive', operationId: 'setCampaignArchived', description: 'Archive a campaign to hide it from default lists, or restore it. Preserves its content, revision, delivery state and history. Preparing, scheduled, sending or paused campaigns must finish or be canceled before archiving. Archived campaigns cannot be edited, tested or sent until restored.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignArchive) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'), campaignId = c.req.valid('param').id, input = c.req.valid('json');
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      draftSender(c.env, a, current.draft);
      if (a.role === 'member' && !campaignEditable(current)) throw denied('PERMISSION_DENIED', 'Members can archive only campaign drafts.', { permission: 'audience', level: 'write', person: 'admin' });
      if (input.archived && ((CAMPAIGN_ACTIVE as readonly string[]).includes(current.state) || campaignResumable(current))) throw new ApiError(409, 'CAMPAIGN_ACTIVE', 'Cancel or finish sending this campaign before archiving it.');
      if (Boolean(current.archivedAt) === input.archived) return current;
      const [updated] = await db.update(campaigns).set({ archivedAt: input.archived ? now() : null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning();
      return updated!;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/campaigns/{id}', operationId: 'deleteCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, current.draft); editable(current); await db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews r WHERE l.owner_type = 'review' AND l.owner_id = r.id AND l.workspace_id = r.workspace_id AND r.workspace_id = ${a.workspaceId} AND r.campaign_id = ${campaignId}`); await db.delete(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.campaignId, campaignId))); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await db.delete(campaigns).where(campaignWhere(a, campaignId)); });
    return c.json({ id: campaignId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/test', operationId: 'testCampaign', description: `Send the current draft, personalized with data, to one address as a transactional test. It shows the footer as recipients get it (the Unsubscribe link, a placeholder here, and the workspace’s postal address, if set) without List-Unsubscribe headers, and needs no postal address. On Hosted sending a test goes only to an address the workspace has proven is its own: a member’s verified email, an address at one of its currently verified domains or their subdomains (its receiving addresses and inboxes there included; not a domain whose verification lapsed), or the SES mailbox simulator (422 TEST_RECIPIENT_NOT_OWNED otherwise; send the campaign to reach anyone else), a workspace sends at most ${CAMPAIGN_TESTS.perHour} tests a clock hour (429 CAMPAIGN_TEST_LIMIT, retryable at resetAt), and each test is screened on its own, with the campaign limit (${screenBytes(SCREEN.campaignBytes)} bytes of screened text by default; 422 CONTENT_TOO_LARGE_TO_SCREEN with error.details[0] { screenedBytes, limitBytes } over it).`, tags: ['Campaigns'], security, request: { params: IdParams, headers: SendIdempotencyHeaders, body: json(TestCampaign) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'), input = c.req.valid('json'), campaignId = c.req.valid('param').id;
    // With its key claimed, read and render the draft, then admit the test in one statement that locks the campaign
    // and requires the revision it rendered. A replay rechecks that the caller may still read the campaign.
    const result = await claimedSend(sendCall(c), a, input, async () => {
      const { row, footer } = await campaignWithFooter(c.env, a, campaignId);
      if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before sending a test.');
      const message = await campaignMessage(c.env, row.draft, { id: 'test-recipient', email: input.to, properties: input.data }, true, null);
      await admitCampaignTest(c.env, a, input.to);
      // The footer as recipients get it, its link the placeholder on the link host they get: a test is transactional,
      // without List-Unsubscribe, and refused as the launch would be when there is no link host.
      // Its pictures are linked from that host too, as recipients' are (src/linked-images.ts); a required notice's stay attached.
      const origin = footer.requiredNotice ? undefined : foundLinkOrigin(c.env.config, a.workspaceId, row.draft.from, footer.linkOrigin);
      const snapshot = { ...message, testCampaignId: campaignId, ...origin ? { linkOrigin: origin } : {} };
      footerParts(snapshot, unsubscribePlaceholder(origin ?? c.env.config.publicUrl), footer);
      const out: Outgoing[] = [{ snapshot, recipients: hostedCost(input.to), marketing: false }];
      if (mayScreenAtAccept(c.env, out)) await prepareFrontDoor(c.env, a, out, false);
      return { out, campaign: { id: campaignId, revision: row.revision } };
    }, { batch: false, replayed: (db, receipt) => campaignReplay(a, campaignId)(db, receipt) });
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/send', operationId: 'sendCampaign', description: 'Accept the current revision for durable background delivery: small audiences (<=5,000 list members) freeze immediately while larger audiences freeze in the background during preparing, every message is validated before sending, then recipients are released into the dispatch queue. The 202 queued count is recipients expected (not SES acceptance or delivery); delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. ' + CAMPAIGN_POSTAL_NOTE + ' ' + CAMPAIGN_SCREEN_NOTE + ' ' + CAMPAIGN_CAPTURE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSend) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const result = await idempotent(c.env.db, keyed(c, a), input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'), c), { replayed: campaignReplay(a, c.req.valid('param').id) }); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/schedule', operationId: 'scheduleCampaign', description: 'Accept the current revision for durable scheduled delivery. Small audiences (<=5,000 list members) freeze immediately while larger audiences freeze and validate in the background during preparing; no recipient is materialized or sent before scheduledAt. The 202 queued count is recipients expected; delivery.total on GET /v1/campaigns/{id} is authoritative once the audience is frozen. ' + CAMPAIGN_POSTAL_NOTE + ' ' + CAMPAIGN_SCREEN_NOTE + ' ' + CAMPAIGN_CAPTURE_NOTE, tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSchedule) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c.env.db, keyed(c, a), input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'), c), { replayed: campaignReplay(a, c.req.valid('param').id) }); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/cancel', operationId: 'cancelCampaign', description: 'Stop a preparing, scheduled, sending, paused or failed campaign: unreleased recipients are never materialized and queued mail is canceled; mail already attempting or accepted is reported as inFlight.', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders }, responses: { 200: response(CampaignCanceled), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c.env.db, keyed(c, a), {}, async db => {
      const row = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, row.draft);
      if (row.state === 'done') throw new ApiError(409, 'CAMPAIGN_ALREADY_DISPATCHED', 'This campaign has already finished dispatching.');
      if (row.state === 'draft') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a campaign that was sent or scheduled can be canceled.');
      const canceled = await cancelCampaignWork(db, a, row);
      await recordAudit(db, c, { action: 'campaign.cancel', workspaceId: a.workspaceId, target: { type: 'campaign', id: row.id }, before: { state: row.state } });
      return canceled;
    }, { replayed: campaignReplay(a, campaignId) });
    if (a.wakeJobs) { await wakeWebhooks(c.env,a.wakeJobs); a.wakeJobs=0; }
    return c.json(CampaignCanceled.parse(result), 200);
  });
  const control = async (c: Ctx, change: CampaignChange, allowed = sendingOnly) => {
    const a = actor(c, 'send'), campaignId = c.req.param('id')!;
    await c.env.db.transaction(db => controlCampaign(c.env, db, a, campaignId, change, allowed));
    const row = await findCampaign(c.env.db, a, campaignId);
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pause', operationId: 'pauseCampaign', description: 'Stop releasing new recipients. Queued mail (a few seconds of the send rate) still dispatches. Resume continues from the same position; cancel still works while paused.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, pausing(c)));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/resume', operationId: 'resumeCampaign', description: 'Continue releasing recipients from where a paused campaign stopped, or where a campaign that failed after releasing some recipients stopped (it continues on the same frozen snapshot, never a new one). After an automatic pause, the next health check runs 30 minutes later.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (!campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign, or one that failed after releasing recipients, can be resumed.');
    if (campaign.state === 'paused' && campaign.quarantines >= 2 && QUARANTINE_CODES.includes(campaign.pauseReason?.code ?? ''))
      throw new ApiError(409, 'QUARANTINE_REVIEW_REQUIRED', 'This campaign was quarantined twice for list quality. An operator reviews it before it sends again: ask for a review from the dashboard.');
    // Paused for blocklist replies: the sender resumes once none has arrived for the window; an operator can release it any time.
    if (campaign.state === 'paused' && campaign.pauseReason?.code === 'BLOCKLISTED') {
      const window = blocklistWindow(rampLines(c.env.config.rampLines));
      if ((await campaignBlocklistReplies(db, a.workspaceId, campaign.id, { minutes: window })).emails)
        throw new ApiError(409, 'BLOCKLIST_REPLIES_ARRIVING', 'Replies naming a blocklist are still arriving for this campaign. Fix the listed domain or link and resume once they stop, or ask for a review.');
    }
    await requiredNoticesAllowed(db, campaign.draft, a.workspaceId);
    const ref = { workspaceId: a.workspaceId, id: campaign.id }, next = runningState(campaign);
    await db.execute(resumeCampaign(ref, next));
    // The owner's one resume of a failed list probe releases the rest only to contacts this workspace delivered to
    // before (the others are skipped and counted as canceled), and the campaign's own health check runs at once.
    // A required notice goes on to everyone captured for it: those never delivered to before are exactly who it must
    // reach. The automatic pauses still apply to it. A second quarantine needs an operator (above).
    if (campaign.pauseReason?.code === 'LIST_QUALITY') { await db.execute(clearProbe(ref)); if (!campaign.draft.requiredNotice) await db.execute(restrictToDelivered(ref)); }
    if (campaign.state==='failed' && campaign.error?.code==='JOB_LEASE_EXHAUSTED') await reserveCampaign(c.env,db,await lockSendScope(db,a.workspaceId,{campaignId:campaign.id}),a,campaign.actorKeyId??a.keyId,0);
    await db.execute(queueCampaignRun(ref, campaign.requestId ? { requestId: campaign.requestId } : {}, next === 'scheduled' ? campaign.scheduledAt : null));
    await db.execute(queueCampaignStats(ref));
    await recordAudit(db, c, { action: 'campaign.resume', workspaceId: a.workspaceId, target: { type: 'campaign', id: campaign.id }, before: { state: campaign.state }, after: { state: next } });
    a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1);
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pacing', operationId: 'setCampaignPacing', description: 'Change the daily cap or automatic pause of a scheduled or sending campaign, for example to raise 50,000 to 100,000 per day. Takes effect on the next release.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({ perDay: z.number().int().min(100).max(10000000).nullable().optional().describe('Release at most this many recipients per rolling 24-hour window. Omit to keep the current cap; null removes it. Delivery always also respects the SES 24-hour quota.'), autoPause: z.boolean().optional().describe('Omit to keep the current setting. Hosted shared sending always enforces automatic pause; false is rejected.'), rateShare: z.number().min(0.05).max(1).optional().describe('Omit to keep the current setting.') }).strict().openapi('CampaignPacingUpdate')) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (campaign.expanded >= campaign.total) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'This campaign has finished releasing recipients.');
    if (campaign.state === 'failed') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Resume this campaign before changing its pacing.');
    const input = c.req.valid('json'), ref = { workspaceId: a.workspaceId, id: campaign.id };
    if (input.autoPause === false && c.env.config.multiTenant && (await db.execute(sql`SELECT 1 WHERE ${sharedConnection(a.workspaceId)}`)).rowCount) throw hostedAutoPauseRequired();
    // A daily limit replaces a launch plan. Where the review required a ramp and no consent source was confirmed, it stays
    // no larger than the plan's first day.
    if (input.perDay !== undefined && campaign.rampRequiredCap !== null && !campaign.consent && (input.perDay === null || input.perDay > campaign.rampRequiredCap))
      throw new ApiError(422, 'RAMP_REQUIRED', `This send needed a ramp when it launched, so its daily limit stays at most ${campaign.rampRequiredCap.toLocaleString('en-US')}.`, 'perDay');
    await db.execute(setCampaignPacing(ref, { pacePerDay: input.perDay === undefined ? campaign.pacePerDay : input.perDay, autoPause: input.autoPause ?? campaign.autoPause, rateShare: input.rateShare ?? campaign.rateShare, keepPlan: input.perDay === undefined }));
    // A release waiting for the next window or quota rechecks now under the new settings.
    if (campaign.state === 'sending') { await db.execute(wakeCampaignRun(ref)); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
  }));
  // A schedule that has not released anyone yet can go back to an editable draft or move to another time.
  const unreleasedSchedule = (campaign: typeof campaigns.$inferSelect) => {
    if (!campaign.scheduledAt || campaign.expanded > 0 || !['preparing', 'scheduled', 'paused'].includes(campaign.state)) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'Only a scheduled campaign that has not started sending can be unscheduled or rescheduled. Pause or cancel a campaign that is sending.');
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/unschedule', operationId: 'unscheduleCampaign', description: 'Return a scheduled campaign that has not started sending to an editable draft, for example to fix a typo. Nobody was emailed; the frozen audience is released and captured again when you schedule or send it.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    const ref = campaignRef(a, campaign.id);
    if (!(await db.execute(unscheduleCampaign(ref))).rows.length) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'This campaign started sending; pause or cancel it instead.');
    await db.execute(retireCampaignRun(ref, 'CAMPAIGN_UNSCHEDULED'));
  }, unreleasedSchedule));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/reschedule', operationId: 'rescheduleCampaign', description: 'Move the send time of a scheduled campaign that has not started sending. The frozen audience and content stay as they are; unschedule it to edit them.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({ scheduledAt: CampaignSchedule.shape.scheduledAt }).strict().openapi('CampaignRescheduleInput')) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (a.role === 'member') throw denied('PERMISSION_DENIED', 'Only workspace owners and admins can schedule campaigns.', { permission: 'sendEmail', level: 'on', person: 'admin' });
    await requiredNoticesAllowed(db, campaign.draft, a.workspaceId);
    const at = Date.parse(c.req.valid('json').scheduledAt);
    if (at <= Date.now() || at > Date.now() + 365 * 86400000) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.', 'scheduledAt');
    const ref = campaignRef(a, campaign.id);
    if (!(await db.execute(rescheduleCampaign(ref, new Date(at).toISOString()))).rows.length) throw new ApiError(409, 'CAMPAIGN_NOT_SCHEDULED', 'This campaign started sending; it can no longer be rescheduled.');
    // Requeue the run with a fresh token in this transaction: a worker that already decided to wait for the old time
    // (or to start sending at it) can no longer settle its deferral, so an earlier time is never missed. Only waiting
    // runs: a paused campaign has none, and resume queues one.
    if (campaign.state !== 'paused') { await db.execute(queueCampaignRun(ref, campaign.requestId ? { requestId: campaign.requestId } : {})); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
  }, unreleasedSchedule));
}
