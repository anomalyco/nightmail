import { createRoute, z } from '@hono/zod-openapi';
import { and, sql, eq, inArray, gte, lt, asc } from 'drizzle-orm';
import { security, json, response, readLimitNote, page, readCursor, literalSearch, budgetedRead, readLimit, encodeCursor, IdParams, nextCursor, PageQuery } from '../core/http.js';
import type { App, DbExecutor, Actor, Ctx } from '../core/types.js';
import { actor, actorMailAccess } from '../core/access.js';
import { errors, ApiError, denied, wrapModuleLoad, notFound, redactCapabilityText, unrestrictedRequired } from '../core/errors.js';
import { region } from '../core/ses.js';
import { wakeWebhooks, enqueue } from '../jobs.js';
import { terminalColumns, terminalEvents } from '../states.js';
import { productName, requestHeader, headerPrefix } from '../brand.js';
import { EmailThread, threadBlock, sentThreadId, type RawThread, threadView } from '../thread-view.js';
import { emails, type EmailStatus, emailEvents, attachmentLinks, attachments } from '../db/sending.js';
import { mib, MAX_JSON_ATTACHMENT_BYTES, AttachmentUpload, decodeBase64, AttachmentMetadata, metadataInvalid, invalidMetadataFields, MAX_ATTACHMENT_BYTES, fileTooLarge } from '../outbound-content.js';
import { CheckInput, CheckResult, type CheckMail } from '../sendability-schema.js';
import { SendIdempotencyHeaders, idempotent, IdempotencyHeaders } from '../idempotency.js';
import { registerPreviewImages } from '../preview-images.js';
import { SEND_LIMITS } from '../send-limits.js';
import { responseByteLimit, assertResponseWithinLimit, withMemory, reserveMemory } from '../isolate-memory.js';
import { buildBoundedPageJson, withBoundedRead, streamBase64JsonResponse } from '../read-bounds.js';
import { recipientWarnings } from '../list-hygiene.js';
import { BUILTIN_NOTE } from '../builtin-domain.js';
import { UPLOAD_HEADERS } from '../attachment-limits.js';
import { findEmail, SCREEN_LIMIT_NOTE, RAMP_NOTE, ATTACHMENT_NOTE, SingleSendInput, SingleReceipt, normalizeSender, keyed, sendRecipients, BatchInput, BatchReceipt, batchContent, batchMemory, EmailPreviewInput, EmailPreviews, loadEmailPreview, READ_LIMIT, EmailQuery, Email, pageBinding, EMAIL_LIST_MAX_BYTES, mailWhere, sentUntrustedContent, EmailContent, Event, visibleEmailEvent, LARGE_READ_RESERVE_THRESHOLD, scope, ScheduledAt, AttachmentInfo, Removed } from './schemas.js';
import { campaignAdvisory, campaignWithFooter, advisoryCheck, emailView, listedSubject, emailColumns } from '../campaigns/views.js';
import { sentCampaignEmail, sentCampaignContent, visibleEmailContent } from '../campaigns/materialize.js';
import { attachmentRows, validateHtmlUrls, saveAttachment, uploadBody, attachmentDownload, bytesDigest } from './mime.js';
import { workspacePostalAddress, admitEmails, sendCall, type SendReceipt } from './front-door.js';
import { releaseJobId, scheduleTime, scheduledEvent, queueRelease } from './scheduled.js';
import { registerCampaigns } from '../campaigns/routes.js';

export function registerSending(app: App) {
  registerPreviewImages(app);
  app.openapi(createRoute({method:'post',path:'/v1/emails/check',operationId:'checkEmail',tags:['Emails'],security,
    summary:'Check email sendability without sending', description:`Read-only 0–100 advisory score, not an inbox-placement probability or admission decision. Supply one draft (HTML or text), outbound email ID, or campaign ID. Uses visible retained content, cached From-domain facts, and workspace reputation for unrestricted readers. No DNS/asset fetches or paid screen. Scores use current evidence, not a historical delivery verdict. HTML has the preview lint’s 256 KiB UTF-8 and tree budgets. Marketing drafts are checked as supplied; ${productName} adds the unsubscribe headers, the link and the workspace’s postal address to campaigns and to marketing mail it sent, so those are checked as sent. Each finding’s fix is one plain sentence and fixIn says where it is made. MIME bytes are estimated.`,
    request:{body:json(CheckInput)},responses:{200:response(CheckResult),...errors}}),async c=>{
    const a=actor(c,'read'), input=c.req.valid('json'); let mail:CheckMail;
    if ('emailId' in input) {
      const row=await findEmail(c.env.db,a,input.emailId);
      // Rehydrate the frozen campaign snapshot once so From name, headers, and tracking describe the same copy as the body.
      const s=sentCampaignEmail(row.snapshot) ? await sentCampaignContent(c.env,a,row) : row.snapshot;
      const body=await visibleEmailContent(c.env,a,{...row,snapshot:s},row.untrustedContent);
      if (!body.html && !body.text) throw new ApiError(422,'EMAIL_BODY_UNAVAILABLE','No retained HTML or plain text is available for checking.','emailId');
      // A required notice is checked as the transactional message it is: it has no unsubscribe, by design.
      const notice=!!row.snapshot.requiredNotice;
      mail={from:row.from,fromName:s.fromName,subject:body.subject??'',stream:notice ? 'transactional' : s.kind??'transactional',text:body.text??undefined,html:body.html??undefined,
        headers:Object.fromEntries([...(s.headers??[]).map(h=>[h.Name,h.Value]),...(s.replyTo?.length ? [['Reply-To',s.replyTo[0]!]] : [])]),
        // Marketing mail went out with the unsubscribe headers and link (and the workspace's postal address) Nightmail adds, however its copy is stored.
        previewText:s.previewText,tracking:s.tracking,...(s.kind==='marketing' && !notice ? {generatedUnsubscribe:true,postalAddress:!!await workspacePostalAddress(c.env,c.env.db,a.workspaceId)} : {}),attachments:await attachmentRows(c.env.db,a,body.attachments,false,!!s.mailbox && !!actorMailAccess(a))};
    } else if ('campaignId' in input) {
      return c.json(await campaignAdvisory(c.env, a, await campaignWithFooter(c.env, a, input.campaignId)), 200);
    } else mail=input;
    return c.json(await advisoryCheck(c.env, a, mail, mail === input ? 'draft' : 'email'), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/send', operationId: 'sendEmail', description: `${SCREEN_LIMIT_NOTE} ${RAMP_NOTE} ${BUILTIN_NOTE} ${ATTACHMENT_NOTE}`, tags: ['Emails'], security, request: { headers: SendIdempotencyHeaders, body: json(SingleSendInput) }, responses: { 202: response(SingleReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = normalizeSender(c.req.valid('json'));
    const replyAddressId = input.replyAddressId ?? input.replyMailboxId;
    if (replyAddressId) {
      if (a.domains.length || !a.permissions.includes('manage')) throw denied('MAILBOX_ACCESS_REQUIRED', 'Use manage permission on all domains, or start the thread with a key limited to that address.', { permission: 'sendEmail', level: 'on', scope: `address:${replyAddressId}` });
      if (input.html) await validateHtmlUrls(input.html);
      const { finishMailboxArchive, trackedAttachments, queueTrackedMailboxSend } = await wrapModuleLoad(() => import('../mailbox-send.js'));
      let files:Awaited<ReturnType<typeof trackedAttachments>>=[];
      const result = await idempotent(c.env.db, keyed(c, a), input, tx => queueTrackedMailboxSend(c.env, tx, a, replyAddressId, input, input.replyAddressId ? 'replyAddressId' : 'replyMailboxId',files),{prepare:input.attachments.length ? async()=>{files=await trackedAttachments(c.env,a,replyAddressId,input);} : undefined});
      if(input.attachments.length)await finishMailboxArchive(c.env,a.workspaceId,result.mailboxMessageId);
      return c.json(SingleReceipt.parse({ ...result, inboundMessageId: result.mailboxMessageId }), 202);
    }
    const result = await admitEmails(sendCall(c), a, input, input.scheduledAt && new Date(Date.parse(input.scheduledAt)).toISOString());
    return c.json(SingleReceipt.parse({ ...result, ...recipientWarnings(sendRecipients(input)) }), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/batch', operationId: 'sendEmailBatch', description: `${SCREEN_LIMIT_NOTE} ${RAMP_NOTE} ${BUILTIN_NOTE} ${ATTACHMENT_NOTE}`, tags: ['Emails'], security, request: { headers: SendIdempotencyHeaders, body: json(BatchInput) }, responses: { 202: response(BatchReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (batchContent(input.emails) > SEND_LIMITS.batchContentChars) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Combined batch body content may not exceed ${SEND_LIMITS.batchContentChars / 1024 / 1024} MiB.`);
    const result = await batchMemory(input.emails, () => admitEmails(sendCall(c), a, input), { workspaceId: a.workspaceId, signal: c.req.raw.signal });
    const receipts = (result as { data: SendReceipt[] }).data;
    return c.json(BatchReceipt.parse({ data: receipts.map((receipt, i) => ({ ...receipt, ...recipientWarnings(sendRecipients(input.emails[i]!)) })) }), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/preview', operationId: 'previewEmail', tags: ['Emails'], security,
    summary: 'Preview HTML in selected email clients',
    description: 'Read-only offline emulation, not a screenshot. Supply HTML or an outbound email ID; stored HTML has the same access and redaction as getEmailContent. Render untrusted output only via iframe.srcdoc with sandbox=""; the embedded CSP blocks remote assets. Results follow the requested client order. Classic Outlook is lint only (empty html). New Outlook for Windows models Outlook web; actual client behavior is unverified. Input over 256 KiB UTF-8, excessive document complexity, or combined output HTML over 4 MiB returns 413.',
    request: { body: json(EmailPreviewInput) }, responses: { 200: response(EmailPreviews), ...errors },
  }), async c => {
    const a = actor(c), input = c.req.valid('json');
    let html: string;
    if ('emailId' in input) {
      const row = await findEmail(c.env.db, a, input.emailId);
      const content = await visibleEmailContent(c.env, a, row, row.untrustedContent);
      if (!content.html) throw new ApiError(422, 'EMAIL_HTML_UNAVAILABLE', 'This email has no retained HTML to preview.', 'emailId');
      html = content.html;
    } else html = input.html;
    const { emulateMany, PreviewLimitError } = await loadEmailPreview();
    try {
      return c.json({ previews: emulateMany(html, { clients: input.clients, theme: input.theme, device: input.device }) }, 200);
    } catch (error) {
      if (error instanceof PreviewLimitError) throw new ApiError(413, 'EMAIL_PREVIEW_LIMIT_EXCEEDED', error.message);
      throw error;
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails', operationId: 'listEmails', description: `Sent emails, newest first. from and to (or since and until) are ISO 8601 times that bound when an email was created, not addresses: filter by sender or recipient address with search. Pages are also bounded by response size and may return fewer than limit emails; follow nextCursor while non-null. ${readLimitNote(READ_LIMIT.emails)}`, tags: ['Emails'], security, request: { query: EmailQuery }, responses: { 200: response(page(Email)), ...errors } }), async c => {
    // since and until are from and to by other names: one filter, so a cursor serves either.
    // Only bounds that were sent: an absent one stays absent, as cursors already issued were bound without it.
    const { since, until, ...named } = c.req.valid('query'), q = { ...named, ...since ? { from: since } : {}, ...until ? { to: until } : {} };
    const a = actor(c), binding = await pageBinding(a, 'emails', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    const maxBytes = Math.min(EMAIL_LIST_MAX_BYTES, responseByteLimit(c.req.raw) ?? EMAIL_LIST_MAX_BYTES);
    const where = and(mailWhere(a),
      cursor ? sql`(${emails.createdAt}, ${emails.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.campaignId ? eq(emails.campaignId, q.campaignId) : undefined, q.status === 'queued' ? inArray(emails.status, ['queued', 'scheduled']) : q.status ? eq(emails.status, q.status) : undefined,
      q.region ? eq(emails.region, q.region) : undefined, q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined,
      q.from ? gte(emails.createdAt, q.from) : undefined, q.to ? lt(emails.createdAt, q.to) : undefined,
      search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${search}` : undefined,
    );
    type RawEmailRow = { untrusted_content: boolean; id: string; region: string; campaign_id: string | null; from_address: string; from_name: string | null; kind: 'transactional' | 'marketing'; to_addresses: string[]; cc_addresses: string[]; bcc_addresses: string[]; subject: string; status: EmailStatus; provider_id: string | null; simulated: boolean; attempt_started_at: string | null; error_code: string | null; suppression_reason: string | null; scheduled_at: string | null; created_at: string; updated_at: string; candidate_count: number };
    const { rows } = await budgetedRead(c.env.db, db => db.execute<RawEmailRow>(sql`
      WITH candidate AS (
        SELECT (${sentUntrustedContent}) AS untrusted_content,
          ${emails.id} AS id, ${emails.region} AS region, ${emails.campaignId} AS campaign_id,
          ${emails.from} AS from_address,
          ${emails.snapshot}->>'fromName' AS own_from_name, ${emails.reviewId} AS review_id, ${emails.workspaceId} AS workspace_id,
          ${emails.snapshot}->>'kind' AS kind,
          ${emails.to} AS to_addresses, ${emails.cc} AS cc_addresses, ${emails.bcc} AS bcc_addresses,
          ${emails.subject} AS subject, ${emails.status} AS status, ${emails.providerId} AS provider_id,
          ${emails.simulated} AS simulated, ${emails.attemptStartedAt} AS attempt_started_at,
          ${emails.errorCode} AS error_code, ${emails.suppressionReason} AS suppression_reason,
          ${emails.scheduledAt} AS scheduled_at, ${emails.createdAt} AS created_at, ${emails.updatedAt} AS updated_at,
          (octet_length(${emails.to}::text) + octet_length(${emails.cc}::text) + octet_length(${emails.bcc}::text) + octet_length(${emails.subject}) + 512) AS row_bytes
        FROM ${emails} WHERE ${where}
        ORDER BY ${emails.createdAt} DESC, ${emails.id} DESC LIMIT ${q.limit + 1}
      ), sized AS (
        SELECT *, row_number() OVER (ORDER BY created_at DESC, id DESC) AS rn,
          sum(row_bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS cum_bytes
        FROM candidate
      ), page AS (
        SELECT * FROM sized WHERE rn = 1 OR cum_bytes <= ${maxBytes}
      ), reviewed AS MATERIALIZED (
        -- A campaign email's stub has no fromName: its campaign review's draft does. The draft is up to 512 KiB, so it
        -- is read once for each review on the page, not once for each email.
        SELECT cr.id, cr.workspace_id, cr.draft->>'fromName' AS from_name FROM sending_campaign_reviews cr
        WHERE (cr.id, cr.workspace_id) IN (SELECT DISTINCT review_id, workspace_id FROM page WHERE own_from_name IS NULL AND review_id IS NOT NULL)
      )
      SELECT untrusted_content, p.id, region, campaign_id, from_address, coalesce(p.own_from_name, r.from_name) AS from_name, kind,
        to_addresses, cc_addresses, bcc_addresses, subject, status, provider_id, simulated,
        attempt_started_at::text, error_code, suppression_reason, scheduled_at::text,
        created_at::text, updated_at::text,
        (SELECT count(*)::int FROM candidate) AS candidate_count
      FROM page p LEFT JOIN reviewed r ON r.id = p.review_id AND r.workspace_id = p.workspace_id
      ORDER BY rn`), readLimit(READ_LIMIT.emails));
    const candidateCount = rows[0]?.candidate_count ?? 0;
    const rawPage = rows.slice(0, q.limit);
    const items = rawPage.map(r => emailView(listedSubject(a, {
      untrustedContent: r.untrusted_content, id: r.id, region: r.region, campaignId: r.campaign_id,
      from: r.from_address, fromName: r.from_name, kind: r.kind, to: r.to_addresses, cc: r.cc_addresses,
      bcc: r.bcc_addresses, subject: r.subject, status: r.status, providerId: r.provider_id,
      simulated: r.simulated, attemptStartedAt: r.attempt_started_at, errorCode: r.error_code,
      suppressionReason: r.suppression_reason, scheduledAt: r.scheduled_at, createdAt: r.created_at, updatedAt: r.updated_at,
    })));
    const rawById = new Map(rawPage.map(r => [r.id, r.created_at]));
    const bounded = buildBoundedPageJson(items, candidateCount > items.length, maxBytes);
    const encodedNext = bounded.nextCursor ? encodeCursor({ id: bounded.nextCursor, createdAt: rawById.get(bounded.nextCursor) ?? items[bounded.count - 1]!.createdAt }, binding) : null;
    const payload = encodedNext
      ? bounded.json.slice(0, bounded.json.lastIndexOf(',"nextCursor":')) + ',"nextCursor":' + JSON.stringify(encodedNext) + '}'
      : bounded.json;
    return c.body(payload, 200, { 'content-type': 'application/json; charset=UTF-8' }) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}', operationId: 'getEmail', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => {
    const a = actor(c), [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(a, c.req.valid('param').id)).limit(1);
    return c.json(emailView(listedSubject(a, row ?? notFound('Email'))), 200);
  });
  const emailSnapshotBytes = async (db: DbExecutor, a: Actor, emailId: string) => {
    const [probe] = await db.select({ bytes: sql<number>`coalesce(octet_length(${emails.snapshot}::text), 0)::int` }).from(emails).where(mailWhere(a, emailId)).limit(1);
    if (!probe) notFound('Email');
    return probe.bytes;
  };
  app.openapi(createRoute({ method:'get', path:'/v1/emails/{id}/detail', operationId:'getEmailDetail', tags:['Emails'], security,
    description:'One log detail: metadata, visible HTML/text, attachment IDs, the first 100 events, active contact for a single To address, and the conversation the email belongs to. Uses the same content and event redaction as their individual endpoints; no raw MIME. Continue events with listEmailEvents.',
    request:{params:IdParams},responses:{200:response(z.object({email:Email,content:EmailContent.pick({html:true,text:true,attachments:true}),events:page(Event),contact:z.object({id:z.string(),suppressed:z.boolean(),suppressedAt:z.string().nullable().describe('When the address was suppressed (UTC). Null when it is not suppressed, and for a suppression from before these dates were kept.')}).nullable(),
      thread:EmailThread.nullable().describe('The conversation: of a reply from a receiving address or inbox, or of an email whose In-Reply-To named a stored message its sender could read, with the messages around it that you can read. Null for an email in none, when you can read none of the conversation\'s received or stored messages, and for credentials that cannot read received mail.')}).openapi('EmailDetail')),...errors} }),async c=>{
    const a=actor(c), emailId=c.req.valid('param').id, access=actorMailAccess(a);
    const snapBytes = await emailSnapshotBytes(c.env.db, a, emailId);
    assertResponseWithinLimit(c.req.raw, snapBytes + 16384);
    const run = async (): Promise<Response> => {
      const [detail]=await c.env.db.select({mail:emails,fromName:emailColumns.fromName,untrustedContent:sentUntrustedContent,
        contact:a.domains.length ? sql<null>`NULL` : sql<{id:string;suppressed:boolean;suppressedAt:string|null}|null>`(SELECT jsonb_build_object('id',c.id,'suppressed',c.suppressed,'suppressedAt',CASE WHEN c.suppressed THEN c.suppressed_at END) FROM audience_contacts c
          WHERE c.workspace_id=sending_emails.workspace_id AND c.deleted_at IS NULL AND jsonb_array_length(sending_emails.to_addresses)=1 AND c.email=lower(sending_emails.to_addresses->>0))`,
        timeline:sql<z.input<typeof Event>[]>`(SELECT coalesce(jsonb_agg(t ORDER BY t."createdAt"::timestamptz,t.id),'[]') FROM (
          SELECT id,email_id AS "emailId",type,provider_id AS "providerId",simulated,created_at::text AS "createdAt",data FROM sending_email_events
          WHERE workspace_id=sending_emails.workspace_id AND email_id=sending_emails.id ORDER BY created_at,id LIMIT 101) t)`,
        thread:access ? threadBlock(access,{thread:sentThreadId,focus:sql`sending_emails.id`,sends:true}) : sql<RawThread|null>`NULL`,
      }).from(emails).where(mailWhere(a,emailId)).limit(1);
      if(!detail) return notFound('Email');
      const {mail,contact,timeline,untrustedContent}=detail, {html,text,attachments}=await visibleEmailContent(c.env,a,mail,untrustedContent);
      const thread=threadView(detail.thread,a.permissions.includes('manage'));
      const email=emailView({...mail,untrustedContent,subject:a.permissions.includes('manage') ? mail.subject : redactCapabilityText(mail.subject),fromName:detail.fromName,kind:mail.snapshot.kind});
      return c.json({email,content:{html,text,attachments},contact,thread,events:{data:timeline.slice(0,100).map(r=>visibleEmailEvent(a,r)),nextCursor:nextCursor(timeline as {id:string;createdAt:string}[],100,`email-events:${mail.id}`)}},200);
    };
    return (snapBytes > LARGE_READ_RESERVE_THRESHOLD ? await withBoundedRead(c, () => run(), { route: 'email.detail', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/content', operationId: 'getEmailContent', description: 'Manage keys receive full snapshots. Other readers receive app unsubscribe tokens redacted from subject/HTML/text and raw MIME withheld (null), since MIME encodings can conceal capabilities. Other transactional bearer links are not sanitized; grant content-read access only to trusted integrations.', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(EmailContent), ...errors } }), async c => {
    const a = actor(c), emailId = c.req.valid('param').id;
    const snapBytes = await emailSnapshotBytes(c.env.db, a, emailId);
    assertResponseWithinLimit(c.req.raw, snapBytes + 4096);
    const run = async (): Promise<Response> => {
      const row = await findEmail(c.env.db, a, emailId);
      return c.json(await visibleEmailContent(c.env, a, row, row.untrustedContent), 200);
    };
    return (snapBytes > LARGE_READ_RESERVE_THRESHOLD ? await withBoundedRead(c, () => run(), { route: 'email.content', workspaceId: a.workspaceId }) : await run()) as never;
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/events', operationId: 'listEmailEvents', tags: ['Emails'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Event)), ...errors } }), async c => {
    // Oldest first by creation time: event IDs are random, so ordering by ID shuffled an email's history.
    const a = actor(c); const emailId = c.req.valid('param').id; await findEmail(c.env.db, a, emailId); const q = c.req.valid('query'), binding = `email-events:${emailId}`, cursor = readCursor(q.cursor, binding);
    const rows = await c.env.db.select().from(emailEvents).where(and(scope(emailEvents, a), eq(emailEvents.emailId, emailId), cursor ? sql`(${emailEvents.createdAt},${emailEvents.id})>(${cursor.at}::timestamptz,${cursor.id})` : undefined)).orderBy(asc(emailEvents.createdAt), asc(emailEvents.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => visibleEmailEvent(a,r)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  // A scheduled send can be canceled or moved until its release at scheduledAt starts sending it (releaseScheduled holds
  // the same row lock): after that, 409 EMAIL_NOT_SCHEDULED.
  const notScheduled = () => new ApiError(409, 'EMAIL_NOT_SCHEDULED', 'Only a scheduled email that has not started sending can be canceled or rescheduled.');
  const scheduledControl = async (c: Ctx, change: (tx: DbExecutor, a: Actor, emailId: string, row: { status: EmailStatus; simulated: boolean }) => Promise<number>) => {
    const a = actor(c, 'send'), emailId = c.req.param('id')!;
    const webhooks = await c.env.db.transaction(async tx => {
      const [row] = await tx.select({ status: emails.status, simulated: emails.simulated }).from(emails).where(mailWhere(a, emailId)).for('update');
      return change(tx, a, emailId, row ?? notFound('Email'));
    });
    await wakeWebhooks(c.env, webhooks);
    const [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(a, emailId)).limit(1);
    return c.json(emailView(listedSubject(a, row ?? notFound('Email'))), 200);
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/{id}/cancel', operationId: 'cancelEmail', summary: 'Cancel a scheduled email',
    description: 'Cancel an email scheduled with sendEmail scheduledAt before it starts sending: it becomes canceled (errorCode EMAIL_CANCELED) with a canceled event and the email.rejected webhook, and is never sent or charged. Canceling a canceled email returns it unchanged. Once its time has come and it was released to send, 409 EMAIL_NOT_SCHEDULED.',
    tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => scheduledControl(c, async (tx, a, emailId, row) => {
    if (row.status === 'canceled') return 0;
    if (row.status !== 'scheduled') throw notScheduled();
    const { rows: [canceled] } = await tx.execute<{ n: number }>(sql`WITH canceled AS (UPDATE sending_emails SET status='canceled',error_code='EMAIL_CANCELED',updated_at=clock_timestamp()
        WHERE workspace_id=${a.workspaceId} AND id=${emailId} AND status='scheduled' RETURNING ${terminalColumns}
      ), ${terminalEvents(sql`SELECT * FROM canceled`)}, retired AS (UPDATE jobs SET status='completed',lease_until=NULL,last_error='EMAIL_CANCELED' WHERE id=${releaseJobId(emailId)} AND status='pending' RETURNING 1)
      SELECT count(*)::int AS n FROM webhook_jobs`);
    return canceled!.n;
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/{id}/reschedule', operationId: 'rescheduleEmail', summary: 'Move a scheduled email to another time',
    description: 'Change when an email scheduled with sendEmail scheduledAt is sent, before it starts sending; its content and recipients stay as they are. The same bounds as scheduling: from now to 30 days ahead, as a UTC instant (422 INVALID_SCHEDULE). Records a rescheduled event. Once its time has come and it was released to send, or after it was canceled, 409 EMAIL_NOT_SCHEDULED.',
    tags: ['Emails'], security, request: { params: IdParams, body: json(z.object({ scheduledAt: ScheduledAt.describe('The new send time: an RFC 3339 instant with Z or an offset, returned in UTC.') }).strict().openapi('EmailRescheduleInput')) },
    responses: { 200: response(Email), ...errors } }), async c => {
    const at = scheduleTime(c.req.valid('json').scheduledAt);
    return scheduledControl(c, async (tx, a, emailId, row) => {
      if (row.status !== 'scheduled') throw notScheduled();
      await tx.execute(sql`WITH moved AS (UPDATE sending_emails SET scheduled_at=${at}::timestamptz,updated_at=clock_timestamp() WHERE workspace_id=${a.workspaceId} AND id=${emailId} AND status='scheduled' RETURNING workspace_id,id),
        noted AS (${scheduledEvent(sql`SELECT workspace_id,id FROM moved`, 'rescheduled', at, row.simulated)}) ${queueRelease(sql`SELECT workspace_id,id FROM moved`, at)}`);
      if (Date.parse(at) - Date.now() < 60_000) a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1);
      return 0;
    });
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/attachments', operationId: 'uploadAttachment', tags: ['Attachments'], security,
    description: `Uploads one file as base64 in JSON; list the returned id in an email's attachments. For files over ${mib(MAX_JSON_ATTACHMENT_BYTES)}, POST /v1/attachments/upload takes the raw bytes as the body, with the fields in headers: ${UPLOAD_HEADERS.filename} (URI-encoded), Content-Type, ${UPLOAD_HEADERS.disposition} and ${UPLOAD_HEADERS.contentId}; 422 ATTACHMENT_METADATA_INVALID names every header that is wrong, what it held and what it must be. ${ATTACHMENT_NOTE}`, request: { headers: IdempotencyHeaders, body: json(AttachmentUpload) }, responses: { 201: response(AttachmentInfo), ...errors } }), async c => {
    const a = actor(c, 'send'); const { content, ...metadata } = c.req.valid('json');
    const bytes = decodeBase64(content);
    const result = await saveAttachment(c, a, metadata, bytes, MAX_JSON_ATTACHMENT_BYTES);
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.post('/v1/attachments/upload', async c => {
    const a = actor(c, 'send');
    const encodedFilename = requestHeader(c.req.raw.headers, 'filename');
    let filename = '';
    try { filename = encodedFilename ? decodeURIComponent(encodedFilename) : ''; } catch { throw new ApiError(422, 'ATTACHMENT_FILENAME_INVALID', `${headerPrefix}Filename must be URI-encoded UTF-8.`); }
    const contentLength = Number(c.req.header('content-length'));
    const sent = { filename, contentType: c.req.header('content-type') ?? 'application/octet-stream', disposition: requestHeader(c.req.raw.headers, 'disposition') ?? 'attachment', contentId: requestHeader(c.req.raw.headers, 'content-id') ?? undefined };
    const parsed = AttachmentMetadata.safeParse(sent);
    // Every header that is wrong at once, each with what was sent and what it must be.
    if (!parsed.success) throw metadataInvalid(sent, invalidMetadataFields(parsed.error.issues), true);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) throw fileTooLarge(filename, contentLength, MAX_ATTACHMENT_BYTES);
    // The isolate's memory for this file is held before a byte is read (isolate-memory.ts): with a Content-Length the
    // body is read into one buffer of that size; without one, into chunks of at most the limit, then one copy.
    const known = Number.isFinite(contentLength) && contentLength >= 0;
    const result = await withMemory(known ? contentLength * 1.15 + 1024 * 1024 : 2.15 * MAX_ATTACHMENT_BYTES, async () => saveAttachment(c, a, parsed.data, await uploadBody(c.req.raw, known ? contentLength : null, filename)), { route: 'attachment.upload', workspaceId: a.workspaceId, signal: c.req.raw.signal });
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}', operationId: 'getAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo), ...errors } }), async c => {
    const [row] = await attachmentRows(c.env.db, actor(c), [c.req.valid('param').id]); return c.json(AttachmentInfo.parse(row), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}/content', operationId: 'getAttachmentContent', description: 'Returns the private attachment as canonical base64 JSON, scoped like its metadata. At most 25 MiB decoded; never a public object URL or executable inline response.', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo.extend({ content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) }).openapi('AttachmentContent')), ...errors } }), async c => {
    const a = actor(c);
    const [row] = await attachmentRows(c.env.db, a, [c.req.valid('param').id]);
    assertResponseWithinLimit(c.req.raw, Math.ceil(row!.size / 3) * 4 + 512);
    // The file counts against the isolate's self-reclaiming budget (isolate-memory.ts) until read, canceled, or past
    // its idle/hard deadline, and streams out base64 a chunk at a time so the file is the only large buffer.
    let lease: import('../isolate-memory.js').MemoryLease;
    try {
      lease = await reserveMemory(row!.size * 1.15 + 1024 * 1024, { route: 'attachment.download', workspaceId: a.workspaceId, signal: c.req.raw.signal, idleMs: attachmentDownload.idleMs, maxMs: attachmentDownload.readMs });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let file: Uint8Array;
    try {
      const asset = await c.env.storage.get(row!.storageKey);
      if (!asset || asset.body.length !== row!.size || asset.body.length > MAX_ATTACHMENT_BYTES || await bytesDigest(asset.body) !== row!.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
      file = asset.body;
    } catch (error) { lease.release(); throw error; }
    const jsonMeta = JSON.stringify({ ...AttachmentInfo.parse(row), content: '' });
    return streamBase64JsonResponse(c, lease, jsonMeta, file, {
      idleMs: attachmentDownload.idleMs,
      maxMs: attachmentDownload.readMs,
      timeoutError: () => new ApiError(504, 'DOWNLOAD_TIMEOUT', 'The attachment was not read in time.'),
    }) as never;
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/attachments/{id}', operationId: 'deleteAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const attachmentId = c.req.valid('param').id;
    // Attachments belong to the workspace, not to a sender domain, so a domain-restricted key can't show one is its own.
    if (a.domains.length) throw unrestrictedRequired(a, 'Deleting an attachment needs', { permission: 'sendEmail', level: 'on' }, 'Unused attachments are removed automatically after 30 days.');
    await c.env.db.transaction(async db => {
      const [row] = await attachmentRows(db, a, [attachmentId], true);
      const links = await db.select().from(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.attachmentId, attachmentId))).limit(1);
      if (links.length) throw new ApiError(409, 'ATTACHMENT_IN_USE', 'Remove this attachment from all drafts first; queued and retained emails keep their immutable attachment references.');
      if (!row!.sourceTemplateAssetId) await enqueue(db,{workspaceId:a.workspaceId,type:'maintenance.deleteAttachment',payload:{key:row!.storageKey}});
      await db.delete(attachments).where(and(scope(attachments, a), eq(attachments.id, attachmentId)));
    }); return c.json({ id: attachmentId, deleted: true as const }, 200);
  });
  registerCampaigns(app);
}
