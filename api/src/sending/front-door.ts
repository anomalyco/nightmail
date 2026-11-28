import { boundRequestBody } from '../request-body.js';
import { checkBudget } from '../auth.js';
import { sql, type SQL, and, inArray, asc } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { rowId } from '../core/http.js';
import type { Runtime, DbExecutor, Actor, Ctx } from '../core/types.js';
import { actorMailAccess, actor } from '../core/access.js';
import { ApiError, ModuleLoadError } from '../core/errors.js';
import { isSimulatedSes, getSes } from '../core/ses.js';
import { log } from '../log.js';
import { countScreened } from '../states.js';
import { productName } from '../brand.js';
import type { ScreenResult } from '../screen.js';
import type { SendScope } from '../send-scope.js';
import { type ReadyConnection, forDelivery } from '../provider-credentials.js';
import { bulkFlags, hostedCost, type ProbationReason, probationReason } from '../hosted-sending.js';
import { joinReplies } from '../thread-view.js';
import { assertTopics, type TopicRule, topicRule, topicAllows } from '../topics.js';
import { type CampaignDraft, type EmailSnapshot, attachments } from '../db/sending.js';
import { postalAddressOf, unsubscribePageLink } from '../outbound-content.js';
import { linkAllowance, recordLinkUse, linkChoices } from '../link-domains.js';
import { canonical, type IdempotentRequest, idempotentRequest, requestHash, type ClaimState, replay, idempotent, validIdempotencyKey, idempotencyGate } from '../idempotency.js';
import { type Admitted, admission, actorJson, scheduledCharges, charges, type Refused, admitted, type AdmissionMail } from '../admission.js';
import { contentBytes, SEND_LIMITS } from '../send-limits.js';
import { SETUP_SENDER, SETUP_EMAIL } from '../setup-email.js';
import { isBuiltinHost, assertBuiltinStillSends, assertBuiltinInput, assertBuiltinRecipients, awaitBuiltinSetup, builtinReplyPolicy } from '../builtin-domain.js';
import { type SendRequest, loadScreen, loadSendingSesv2, sharedAttachmentAccess, domainAttachmentAccess, loadOpsUnsub, scope, SENDING_LIMITS, normalizeSender, ProtocolSendInput, BatchInput, SingleSendInput, batchContent, batchMemory, SendInput, Receipt } from './schemas.js';
import { escaped, type AttachmentFacts, sesHeaders, validateHtmlUrls, sizeCheck, renderedMimeHeaders, formattedSender, type ContentRules, type AttachmentProblem, resolveHostedContentPolicy, sharedFormatRefusal, verifiedAttachment, attachmentRefusal, refusedAttachments } from './mime.js';
import { scheduledEvent, queueRelease } from './scheduled.js';

// `url` is Nightmail's own link for the recipient. A campaign with its own unsubscribe page (`page`) links the footer
// there, with the same token; List-Unsubscribe keeps Nightmail's link, as RFC 8058 allows the header one HTTPS URI and
// the one-click POST must reach Nightmail, which records it and redirects a confirming browser to the page.
/** The workspace's postal address now, or null when it has none. */
export async function workspacePostalAddress(runtime: Runtime, db: DbExecutor, workspaceId: string) {
  return (await db.execute<{ address: string | null }>(sql`SELECT ${postalAddressOf(runtime.config.multiTenant, workspaceId)} AS address`)).rows[0]?.address ?? null;
}
/** A required notice ignores marketing opt-outs, so a workspace makes, sends, resumes or releases one only while an
 *  operator has them turned on (scripts/set-required-notices.ts). `message` replaces the refusal's, for the run's pause. */
export async function requiredNoticesAllowed(db: DbExecutor, draft: Pick<CampaignDraft, 'requiredNotice'>, workspaceId: string, message = `Required notices are off for this workspace. Ask ${productName} to turn them on.`) {
  if (!draft.requiredNotice) return;
  const { rows: [row] } = await db.execute<{ on: boolean | null }>(sql`SELECT required_notices AS on FROM workspaces WHERE id=${workspaceId}`);
  if (!row?.on) throw new ApiError(403, 'REQUIRED_NOTICES_OFF', message, 'requiredNotice');
}
/** A draft's topic (src/topics.ts): marketing only, and one the workspace has and hasn't archived whenever it is set or
 *  changed. One archived since it was set stays on the draft, and its launch is refused (topicRule). */
export async function draftTopic(db: DbExecutor, a: Actor, draft: Pick<CampaignDraft, 'topicId' | 'requiredNotice'>, current?: Pick<CampaignDraft, 'topicId'>) {
  if (!draft.topicId) return;
  if (draft.requiredNotice) throw new ApiError(422, 'TOPIC_REQUIRES_MARKETING', 'A required notice has no unsubscribe, so it can\u2019t have a topic.', 'topicId');
  if (draft.topicId !== current?.topicId) await assertTopics(db, a.workspaceId, [draft.topicId], () => 'topicId');
}
/** The topic a campaign's audience is read with: none for a required notice. `active`: as topicRule's. */
export const campaignTopic = (db: DbExecutor, workspaceId: string, draft: Pick<CampaignDraft, 'topicId' | 'requiredNotice'>, active: boolean): Promise<TopicRule | null> =>
  draft.topicId && !draft.requiredNotice ? topicRule(db, workspaceId, draft.topicId, active) : Promise.resolve(null);
// `postalAddress`: the workspace's (CAN-SPAM), under the link in the same quiet style, one line per line.
// `requiredNotice`: a required notice has no unsubscribe, so its footer is the postal address alone and it gets no
// List-Unsubscribe headers; `url` is then unused.
/** `linkOrigin`: where the footer's link and List-Unsubscribe point (src/link-domains.ts), as a launch froze it. */
export type Footer = { unsubscribePageUrl?: string; postalAddress?: string | null; requiredNotice?: boolean; linkOrigin?: string };
export function marketingFooter(snapshot: EmailSnapshot, url: string, footer: Footer = {}) {
  footerParts(snapshot, url, footer);
  if (footer.requiredNotice) return;
  // Keep caller headers; the unsubscribe pair is always Nightmail's own.
  snapshot.headers = [...snapshot.headers.filter(header => !/^list-unsubscribe/i.test(header.Name)), { Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
}
/** The footer's visible part, in the HTML and the text: what a preview and a campaign test show without the headers. */
export function footerParts(parts: { html?: string; text?: string }, url: string, { unsubscribePageUrl: page, postalAddress, requiredNotice }: Footer) {
  const link = requiredNotice ? null : page ? unsubscribePageLink(page, url.slice(url.lastIndexOf('/') + 1)) : url, lines = postalAddress ? postalAddress.split('\n') : [];
  if (!link && !lines.length) return;
  if (parts.html) {
    const style = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#595959";
    const footer = (link ? `<p style="${style};margin:24px 0 0"><a href="${escaped(link)}" style="color:#595959;text-decoration:underline">Unsubscribe</a></p>` : '')
      + (lines.length ? `<p style="${style};margin:${link ? 8 : 24}px 0 0">${lines.map(escaped).join('<br>')}</p>` : '');
    const close = parts.html.search(/<\/td>\s*<\/tr>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i);
    parts.html = close >= 0 ? parts.html.slice(0, close) + footer + parts.html.slice(close) : parts.html + footer;
  }
  parts.text = (parts.text ?? '') + '\n\n' + [...link ? [`Unsubscribe: ${link}`] : [], ...lines].join('\n');
}
function structuredSnapshot(input:SendRequest & {region:string}):EmailSnapshot {
  const unsubHeaders = input.unsubscribe && input.kind === 'transactional' ? [{ Name: 'List-Unsubscribe', Value: `<${input.unsubscribe.url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] : [];
  return { testCampaignId: null, untrustedContent: !!input.headers?.some(h => h.name.toLowerCase() === 'in-reply-to'), from: input.from, ...(input.fromName !== undefined ? { fromName: input.fromName } : {}), to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo, region: input.region, kind: input.kind, subject: input.subject ?? '', html: input.html, text: input.text, attachments: input.attachments, tracking: input.tracking ?? input.kind === 'marketing', headers: [...(input.headers ?? []).map(header => ({ Name: header.name, Value: header.value })), ...unsubHeaders], ...(input.screen && input.kind === 'transactional' ? { screen: true } : {}), ...(input.topicId && input.kind === 'marketing' ? { topicId: input.topicId } : {}) };
}
// The dispatcher screens Hosted shared mail on a live installation with a classifier (dispatcher.ts prepareMail).
// Admission measures what that screen would read and refuses, with the numbers, what it would refuse, instead of
// accepting mail that is rejected later; the dispatcher's own check stays as a backstop. Bring-your-own AWS mail with
// screen: true is screened at dispatch, as before.
export function screenedAtDispatch(runtime: Runtime, shared: boolean) {
  return !!runtime.config.screen && !isSimulatedSes(runtime) && shared && runtime.config.hostedScreen;
}
/** The screen's refusal of one message, or undefined when it fits the per-message limit. */
async function screenRefusal(runtime: Runtime, snapshot: EmailSnapshot, index?: number) {
  const screen = await loadScreen();
  // A campaign test is a campaign's copy: it has the campaign limit.
  const limits = runtime.config.screenLimits, test = !!snapshot.testCampaignId;
  try { screen.assertScreenable(await screen.measureScreen(snapshot), test ? limits.campaignBytes : limits.messageBytes, test ? 'campaign' : 'message', index); }
  catch (error) { if (error instanceof ApiError && error.code === 'CONTENT_TOO_LARGE_TO_SCREEN') return error; throw error; }
}
// A message from content the caller validated, before admission decides where it goes. `rows`: the attachments that
// size the copy (a campaign's), or null when admission sizes it.
export async function prepare(request: SendRequest, rows: AttachmentFacts[] | null, htmlValidated = false): Promise<EmailSnapshot> {
  const snapshot = structuredSnapshot({ ...request, region: request.region ?? '' });
  sesHeaders(snapshot.headers.length + (request.kind === 'marketing' ? 2 : 0));
  if (!htmlValidated && snapshot.html) await validateHtmlUrls(snapshot.html);
  if (rows) sizeCheck(snapshot, rows);
  return snapshot;
}
/** Renders a stored SES template into the snapshot's raw MIME, in the region and connection admission resolved. */
async function renderTemplate(runtime: Runtime, snapshot: EmailSnapshot, template: NonNullable<SendRequest['template']>, connection: ReadyConnection | null) {
  if (runtime.config.multiTenant && connection?.kind !== 'byo') throw new ApiError(422, 'SHARED_STORED_TEMPLATE_UNSUPPORTED', 'AWS-stored templates require a bring-your-own AWS connection. Use explicit content on shared sending.', 'template');
  // Preserve native SES semantics in both HTML and plaintext; callers own context-specific escaping.
  const templateData = JSON.stringify(template.data);
  if (templateData.length > 262144) throw new ApiError(413, 'TEMPLATE_DATA_TOO_LARGE', 'Serialized template data exceeds 262,144 characters.');
  if (isSimulatedSes(runtime)) throw new ApiError(422, 'SIMULATED_TEMPLATE_UNSUPPORTED', 'Simulated sending supports explicit content and campaigns, not AWS-stored templates.');
  const [{ GetEmailTemplateCommand, TestRenderEmailTemplateCommand }, ses] = await Promise.all([loadSendingSesv2(), getSes(runtime, snapshot.region, forDelivery(connection ?? undefined,{purpose:'template',name:template.name}))]);
  const before = await ses.send(new GetEmailTemplateCommand({ TemplateName: template.name }));
  const rendered = await ses.send(new TestRenderEmailTemplateCommand({ TemplateName: template.name, TemplateData: templateData }));
  const after = await ses.send(new GetEmailTemplateCommand({ TemplateName: template.name }));
  if (canonical(before.TemplateContent) !== canonical(after.TemplateContent)) throw new ApiError(409, 'TEMPLATE_CHANGED', 'The stored template changed during rendering; retry the request.');
  if (!rendered.RenderedTemplate) throw new ApiError(422, 'TEMPLATE_RENDER_EMPTY', 'SES did not return rendered MIME content.');
  snapshot.subject = before.TemplateContent?.Subject ?? '';
  snapshot.template = { ...template, source: before.TemplateContent ?? {}, render: 'ses' };
  // Keep SES's complete rendered MIME rather than treating advanced stored-template syntax as an inline template.
  const normalized = rendered.RenderedTemplate.replace(/\r?\n/g, '\r\n');
  const split = normalized.indexOf('\r\n\r\n');
  if (split < 0) throw new ApiError(422, 'INVALID_RENDERED_MIME', 'SES rendered content has no MIME header/body separator.');
  const headers = renderedMimeHeaders(normalized.slice(0,split));
  snapshot.raw = [`From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`, `To: ${snapshot.to.join(', ')}`, ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(', ')}`] : []), ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(', ')}`] : []), ...headers, ...snapshot.headers.map(header => `${header.Name}: ${header.Value}`)].join('\r\n') + normalized.slice(split);
}
/** Writes an admitted mailbox send in one statement: its email row, which is the dispatch queue entry, and its attachment links. */
async function queueEmail(runtime: Runtime, db: DbExecutor, a: Actor, snapshot: EmailSnapshot, emailId = rowId('email'), countHostedScreen = false, screened = true) {
  const sim = isSimulatedSes(runtime);
  await db.execute(sql`WITH inserted AS (INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened)
      VALUES(${emailId},${a.workspaceId},${a.keyId},${snapshot.region},${snapshot.from},${JSON.stringify(snapshot.to)}::jsonb,${JSON.stringify(snapshot.cc)}::jsonb,${JSON.stringify(snapshot.bcc)}::jsonb,${snapshot.subject},${JSON.stringify(snapshot)}::jsonb,${sim},${screened}) RETURNING id, workspace_id, to_addresses||cc_addresses||bcc_addresses AS recipients)
    ${countHostedScreen ? sql`, screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM inserted WHERE hosted_real_cost(recipients) > 0`)})` : sql``},
    links AS (INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id) SELECT ${a.workspaceId},f,'email',id FROM inserted,jsonb_array_elements_text(${JSON.stringify(snapshot.attachments)}::jsonb) f ON CONFLICT DO NOTHING)
    SELECT id FROM inserted`);
  if (screened) noteDispatch(a, snapshot);
  return { id: emailId, status: 'queued' as const, simulated: sim };
}
function noteDispatch(a: Actor, { region, kind }: EmailSnapshot) {
  const targets = a.dispatchTargets ??= new Map();
  const target = targets.get(region) ?? { count: 0, priority: false };
  target.count++; target.priority ||= kind === 'transactional'; targets.set(region, target);
}
// A batch item's own failure names the item, as a validation error does (emails.3.from); a batch-wide limit names none.
function atItem(error: unknown, index?: number) {
  if (index !== undefined && error instanceof ApiError && !(error instanceof ModuleLoadError) && error.code !== 'BATCH_CONTENT_TOO_LARGE' && !error.field?.startsWith('emails.'))
    error.field = `emails.${index}${error.field ? `.${error.field}` : ''}`;
  return error;
}
// The attachments a sender may use, of those a request names: every upload for a sender with mailbox access (or a
// conversation, whose mailbox rules admitted them), otherwise the reader rule for its kind (scopedAttachment).
function visibleAssets(ids: string[], who: { workspace: SQL; uploader: SQL; domains: SQL; mailboxAccess: SQL }) {
  const requested = sql`${JSON.stringify([...new Set(ids)])}::jsonb`;
  return ids.length ? sql`CASE WHEN ${who.domains}='[]'::jsonb AND ${who.mailboxAccess} THEN ${requested} ELSE (
    SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM sending_attachments WHERE workspace_id=${who.workspace} AND id IN (SELECT jsonb_array_elements_text(${requested}))
    AND CASE WHEN ${who.domains}='[]'::jsonb THEN ${sharedAttachmentAccess(who.uploader)} ELSE ${domainAttachmentAccess(who.uploader, who.domains)} END
  ) END` : sql`'[]'::jsonb`;
}
export const actorAssets = (a: Actor, ids: string[], conversation = false) => visibleAssets(ids, { workspace: sql`${a.workspaceId}::text`, uploader: sql`${a.tokenId ?? a.keyId}::text`,
  domains: sql`${JSON.stringify(a.domains)}::jsonb`, mailboxAccess: sql`${conversation || actorMailAccess(a) !== null}::boolean` });
const nulAttachment = () => new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid: text cannot contain the NUL character (U+0000).');

/** One message of a send, as built before admission: what TypeScript alone found wrong with it waits in `invalid`. */
type ScreenSummaryValue = { status: 'passed' | 'skipped' };
export type Outgoing = { snapshot: EmailSnapshot; recipients: number; marketing: boolean; template?: SendRequest['template']; token?: { hash: string; email: string }; duplicate?: boolean; invalid?: unknown; oversize?: ApiError; emailId?: string; screenSummary?: ScreenSummaryValue; countScreened?: boolean; heldForScreen?: boolean;
  /** The dashboard's test email to this address (admitTestEmail): the screen records a platform verdict for it instead of
   *  asking the classifier, if and only if the message is that email, word for word, to that one address. */
  platformTestTo?: string };
const linkHostMissing = (): never => { throw new Error('A marketing message is built with its link origin (admitEmails).'); };
/** A direct send's messages, built and checked without the database: URLs, headers, duplicates and the batch's size.
 *  `postalAddress`: the workspace's, for the footer of its marketing mail (admitEmails reads it). */
async function directMessages(runtime: Runtime, mails: SendRequest[], batch: boolean, postalAddress?: string | null, origins: (string | undefined)[] = []): Promise<Outgoing[]> {
  const bulk = bulkFlags(mails), out: Outgoing[] = [];
  for (const [i, m] of mails.entries()) {
    const snapshot = structuredSnapshot({ ...m, region: m.region ?? '' });
    if (bulk[i]) snapshot.bulk = true;
    if (snapshot.html) await validateHtmlUrls(snapshot.html).catch(e => { throw atItem(e, batch ? i : undefined); });
    // PostgreSQL cannot store NUL in an attachment ID; nothing that names one is admitted.
    if (m.attachments.some(file => file.includes('\0'))) throw nulAttachment();
    // A repeated attachment is refused by admission after the sender's rules and before the attachment lookup.
    const message: Outgoing = { snapshot, recipients: hostedCost(m.to, m.cc, m.bcc), marketing: m.kind === 'marketing' || bulk[i]!, template: m.template,
      duplicate: new Set(m.attachments).size !== m.attachments.length };
    try {
      sesHeaders(snapshot.headers.length + (m.kind === 'marketing' ? 2 : 0));
      if (m.kind === 'marketing') {
        // Only the token's hash and destination come from local preparation; the statement gives it the workspace.
        const link = await (await loadOpsUnsub()).createUnsubscribeLink(origins[i] ?? linkHostMissing(), '', snapshot.to[0]!);
        snapshot.linkOrigin = origins[i];
        marketingFooter(snapshot, link.url, { postalAddress }); message.token = { hash: link.record.tokenHash, email: link.record.email };
      }
    } catch (e) { if (e instanceof ModuleLoadError) throw e; message.invalid = atItem(e, batch ? i : undefined); }
    out.push(message);
  }
  return out;
}
/** A send request without the Hono context: internal senders (sendSystemEmail) build one directly. */
type SendCall = IdempotentRequest & { runtime: Runtime; db?: DbExecutor };
export const sendCall = (c: Ctx): SendCall => ({ runtime: c.env, ...idempotentRequest(c) });
// used is null for an uncharged duplicate of a request that still holds its key.
export type Principal = { id:string;workspace_id:string;permissions:Actor['permissions'];domains:string[];used:number|null;max_requests:number };
type Identity = { credential: SQL; authorize: (key: Principal) => Actor } | { actor: Actor };
export type SendReceipt = { id: string; status: 'queued'; simulated: boolean; scheduledAt?: string; screen?: ScreenSummaryValue };
const SCREEN_RETRY_AFTER_S = 30;
const BATCH_SCREEN_CONCURRENCY = 4;
const isSystemNoticeKey = (keyId: string) => keyId.startsWith('standing:') || keyId.startsWith('billing:') || keyId.startsWith('notice:');
let acceptScreenSkipLoggedAt = 0;
function unavailableScreenError(message = 'Content screening is temporarily unavailable; retry shortly.') {
  const err = new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', message, undefined, true);
  err.retryAfterSeconds = SCREEN_RETRY_AFTER_S;
  return err;
}
function recipientIneligibleError(rows: { ord: number; email: string; reason: string }[], batch: boolean) {
  const first = rows[0]!;
  const err = new ApiError(422, 'RECIPIENT_INELIGIBLE', `Recipient ${first.email} is not eligible for delivery (${first.reason}).`, batch ? `emails.${first.ord}.to` : 'to');
  err.details = rows.map(r => ({ ...(batch ? { index: r.ord } : {}), email: r.email, reason: r.reason }));
  return err;
}
export async function flushScreenObservability(runtime: Runtime) {
  const [{ flushScreenCalls }, { flushShadow }] = await Promise.all([import('../screen-calls.js'), import('../screen-shadow.js')]);
  flushShadow(runtime);
  if (runtime.deferNudge) runtime.deferNudge(async rt => { await flushScreenCalls(rt.db, runtime.db); });
  else await flushScreenCalls(runtime.db);
}
export function mayScreenAtAccept(runtime: Runtime, items: readonly (Pick<EmailSnapshot, 'screen' | 'kind'> | { snapshot: Pick<EmailSnapshot, 'screen' | 'kind'> })[]) {
  if (isSimulatedSes(runtime)) return false;
  if (runtime.config.multiTenant && runtime.config.hostedScreen) return true;
  return items.some(item => { const m = 'snapshot' in item ? item.snapshot : item; return m.screen && m.kind === 'transactional'; });
}
/**
 * Why one destination `d.email` can't receive a message, or NULL. Reads its contact as `c` (audience_contacts, LEFT
 * JOINed, so NULL for an address that is no contact). Marketing mail needs a subscribed, undeleted contact its topic
 * allows; any mail skips a suppressed address except a transactional reply to a validation-suppressed author. A
 * required `notice` (requiredNotice) skips the consent checks but never goes to a deleted or missing contact; `risk`
 * refuses unallowed risky contacts too (at accept; dispatch rechecks consent only).
 */
export function recipientIneligibleReasonSql(o: { marketing: SQL; replyAuthors: SQL; topic: SQL; notice?: SQL; risk: boolean }) {
  const consented = o.notice ? sql`${o.marketing} AND NOT ${o.notice}` : o.marketing;
  return sql`CASE
      WHEN ${consented} AND c.marketing_consent = 'unsubscribed' THEN 'unsubscribed'
      WHEN c.suppressed AND NOT coalesce(NOT ${o.marketing} AND c.suppression_reason = 'email_validation'
        AND c.marketing_consent <> 'unsubscribed' AND ${o.replyAuthors} ? d.email, false) THEN coalesce(c.suppression_reason, 'suppressed')
      WHEN ${o.marketing} AND ${o.notice ? sql`(c.deleted_at IS NOT NULL OR (${o.notice} AND c.email IS NULL))` : sql`c.deleted_at IS NOT NULL`} THEN 'contact_deleted'
      WHEN ${consented} AND c.marketing_consent IS DISTINCT FROM 'subscribed' THEN 'consent_missing'
      WHEN ${consented} AND NOT ${topicAllows(sql`c.workspace_id`, sql`c.id`, o.topic)} THEN 'topic_unsubscribed'
      ${o.risk ? sql`WHEN ${o.marketing} AND c.risk IS NOT NULL AND NOT c.risk_allowed THEN 'risky_' || c.risk` : sql``}
    END`;
}
async function checkRecipientsEligible(db: DbExecutor, workspaceId: string, out: Outgoing[], batch: boolean, skip = false) {
  if (skip || !out.length) return;
  const input = out.map((m, ord) => ({
    ord,
    marketing: m.snapshot.kind === 'marketing',
    destinations: [...m.snapshot.to, ...m.snapshot.cc, ...m.snapshot.bcc].map(e => e.toLowerCase()),
    reply_authors: m.snapshot.replyAuthors ?? [],
    topic: m.snapshot.topicId ?? null,
  }));
  const { rows } = await db.execute<{ ord: number; email: string; reason: string }>(sql`
    SELECT x.ord, d.email, cause.reason
    FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS x(ord int, marketing boolean, destinations jsonb, reply_authors jsonb, topic text)
    CROSS JOIN LATERAL jsonb_array_elements_text(x.destinations) WITH ORDINALITY d(email, n)
    LEFT JOIN audience_contacts c ON c.workspace_id = ${workspaceId} AND c.email = d.email
    CROSS JOIN LATERAL (SELECT ${recipientIneligibleReasonSql({ marketing: sql`x.marketing`, replyAuthors: sql`x.reply_authors`, topic: sql`x.topic`, risk: true })} AS reason) cause
    WHERE cause.reason IS NOT NULL
    ORDER BY x.ord, d.n`);
  if (rows.length) throw recipientIneligibleError(rows, batch);
}
/** Runs Hosted content rules (probation/standard HTML + attachment picture checks) and synchronous Jev/JevF screening
 *  at accept time before anything enters sending_emails. Parallelizes batch screening with bounded concurrency. */
async function screenOutgoingAtAccept(runtime: Runtime, a: Actor, out: Outgoing[], decided: Admitted, probation: boolean, batch: boolean, db: DbExecutor = runtime.db) {
  if (isSimulatedSes(runtime)) return;
  const settings = runtime.config.screen;
  const allAttachIds = [...new Set(out.flatMap(m => m.snapshot.attachments))];
  let loadedAttachments: Map<string, typeof attachments.$inferSelect> | undefined;
  type ScreenTask = { index: number; message: Outgoing; copy: EmailSnapshot; hosted: boolean; required: boolean; rules: ContentRules; region: string };
  const tasks: ScreenTask[] = [], unsendable: AttachmentProblem[] = [];
  for (const [i, m] of out.entries()) {
    const route = decided.mails[i]!, conn = route.connection;
    const { hosted, rules, screened, required, ...policy } = resolveHostedContentPolicy(runtime.config, { shared: conn?.kind === 'shared', poolTier: conn?.pool_tier, legacyNames: conn?.legacy_names,
      from: m.snapshot.from, probation, simulated: isSimulatedSes(runtime), kind: m.snapshot.kind, screen: m.snapshot.screen });
    const refusal = sharedFormatRefusal(m.snapshot, policy);
    if (refusal) throw atItem(refusal, batch ? i : undefined);
    let copy = m.snapshot;
    if (rules) {
      const delivery = await import('../screened-html.js');
      try { copy = delivery.hostedCopy(m.snapshot, rules === 'probation'); }
      catch (error) { throw atItem(error, batch ? i : undefined); }
      if (m.snapshot.attachments.length) {
        if (!loadedAttachments) {
          const rows = await db.select().from(attachments).where(and(scope(attachments, a), inArray(attachments.id, allAttachIds))).orderBy(asc(attachments.id));
          loadedAttachments = new Map(rows.map(r => [r.id, r]));
        }
        // Every file of every email is read before refusing, so one refusal names them all.
        for (const [k, attId] of m.snapshot.attachments.entries()) {
          const attRow = loadedAttachments.get(attId);
          if (!attRow) continue;
          const body = await verifiedAttachment(runtime, attRow);
          try { delivery.hostedAttachment(attRow, body, rules === 'probation', !!m.snapshot.mailApp); } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            unsendable.push({ index: i, attachment: k, id: attId, filename: attRow.filename, code: error.code, status: error.status, message: error.message, types: error.attachmentTypes, mailApp: m.snapshot.mailApp });
          }
        }
      }
    }
    if (screened) {
      m.emailId ??= rowId('email');
      const verdict = m.platformTestTo ? platformTestVerdict(m.snapshot, m.platformTestTo, rules) : undefined;
      if (verdict) {
        // The local rules above still ran (the copy a probation sender's mail goes out as); only the classifier is spared.
        if (rules === 'probation') m.snapshot = copy;
        m.snapshot.screenVerdict = verdict;
        continue;
      }
      tasks.push({ index: i, message: m, copy, hosted, required, rules, region: route.region });
    }
  }
  if (unsendable.length) throw attachmentRefusal(unsendable, batch);
  if (!tasks.length) return;
  if (!settings) {
    if (tasks.some(t => t.required)) throw unavailableScreenError('Hosted content screening is unavailable; retry shortly.');
    if (Date.now() - acceptScreenSkipLoggedAt >= 60000) {
      acceptScreenSkipLoggedAt = Date.now();
      log('warn', { code: 'CONTENT_SCREEN_SKIPPED', workspaceId: a.workspaceId, message: 'screen requested but TYPESAFE_API_KEY is not configured' });
    }
    for (const t of tasks) {
      t.message.snapshot.screenVerdict = { status: 'skipped', rules: t.rules };
      t.message.screenSummary = { status: 'skipped' };
    }
    return;
  }
  const screen = await loadScreen();
  const scopedRuntime: Runtime = { ...runtime, config: { ...runtime.config, workspaceId: a.workspaceId } };
  type JudgedVerdict = { kind: 'judged'; task: ScreenTask; result: ScreenResult; rejected: boolean };
  type UnavailableVerdict = { kind: 'unavailable'; task: ScreenTask; message: string };
  type Verdict = JudgedVerdict | UnavailableVerdict;
  const verdicts: Verdict[] = new Array(tasks.length);
  // failing: unavailable answers since the last verdict. A verdict earlier in the batch (a cached one included) must not
  // switch the bound off, so this resets on each verdict instead of requiring none at all.
  let next = 0, failing = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(tasks.length, BATCH_SCREEN_CONCURRENCY) }, async () => {
      while (next < tasks.length) {
        const pos = next++, task = tasks[pos]!;
        // Once BATCH_SCREEN_CONCURRENCY requests in a row found no classifier, the rest of the batch is held without asking:
        // at most 2 × BATCH_SCREEN_CONCURRENCY - 1 requests start after the last verdict, however large the batch.
        if (failing >= BATCH_SCREEN_CONCURRENCY) {
          verdicts[pos] = { kind: 'unavailable', task, message: 'Content screening is temporarily unavailable.' };
          continue;
        }
        const call = { emailId: task.message.emailId, workspaceId: a.workspaceId, region: task.region, kind: task.copy.kind, required: task.required };
        try {
          const result = await screen.screenSnapshot(scopedRuntime, task.copy, task.required, call);
          if (!result) {
            failing++;
            verdicts[pos] = { kind: 'unavailable', task, message: 'Content screening is temporarily unavailable.' };
            continue;
          }
          failing = 0;
          const rejected = result.spam >= result.threshold && (task.required || settings.mode === 'reject');
          verdicts[pos] = { kind: 'judged', task, result, rejected };
        } catch (error) {
          if (error instanceof ApiError && error.code === 'CONTENT_SCREEN_UNAVAILABLE') {
            failing++;
            verdicts[pos] = { kind: 'unavailable', task, message: error.message };
            continue;
          }
          throw error;
        }
      }
    }));
  } catch (error) {
    await flushScreenObservability(runtime).catch(() => {});
    throw error;
  }
  const judged = verdicts.filter((v): v is JudgedVerdict => v.kind === 'judged');
  const rejected = judged.filter(v => v.rejected);
  if (rejected.length) {
    // Count every judged real-destination Hosted verdict toward reputation even though nothing enters sending_emails.
    const hostedJudged = judged.filter(v => v.task.hosted).map(v => ({
      recipients: [...v.task.message.snapshot.to, ...v.task.message.snapshot.cc, ...v.task.message.snapshot.bcc],
      rejected: v.rejected ? 1 : 0,
    }));
    if (hostedJudged.length) {
      await runtime.db.execute(countScreened(sql`SELECT ${a.workspaceId}::text AS workspace_id, x.rejected
        FROM jsonb_to_recordset(${JSON.stringify(hostedJudged)}::jsonb) x(recipients jsonb, rejected int)
        WHERE hosted_real_cost(x.recipients) > 0`)).catch(() => {});
    }
    for (const r of rejected) {
      log('warn', { code: 'CONTENT_REJECTED_SPAM', workspaceId: a.workspaceId, emailId: r.task.message.emailId, spam: r.result.spam, model: r.result.model, threshold: r.result.threshold });
    }
    await flushScreenObservability(runtime).catch(() => {});
    const first = rejected[0]!;
    const err = new ApiError(422, 'CONTENT_REJECTED_SPAM', 'The content classifier judged this message to be deceptive or harmful.', batch ? `emails.${first.task.index}` : undefined);
    if (batch) err.details = rejected.map(r => ({ index: r.task.index, code: 'CONTENT_REJECTED_SPAM' }));
    throw err;
  }
  for (const v of verdicts) {
    if (v.kind === 'unavailable') {
      // Neither classifier answered: accept the email and hold it (screened = false) so screenHeldMail screens it
      // once a classifier recovers. The mail room never sends unverdicted rows.
      v.task.message.heldForScreen = true;
      log('warn', { code: 'CONTENT_SCREEN_HELD', workspaceId: a.workspaceId, emailId: v.task.message.emailId, region: v.task.region, kind: v.task.copy.kind, required: v.task.required, message: v.message });
      continue;
    }
    if (v.result.spam >= v.result.threshold) {
      log('warn', { code: 'CONTENT_SPAM_SUSPECTED', workspaceId: a.workspaceId, emailId: v.task.message.emailId, spam: v.result.spam, model: v.result.model });
    }
    if (v.task.rules === 'probation') v.task.message.snapshot = v.task.copy;
    v.task.message.snapshot.screenVerdict = { status: 'passed', spam: v.result.spam, model: v.result.model, digest: v.result.digest, rules: v.task.rules };
    v.task.message.screenSummary = { status: 'passed' };
    if (v.task.hosted) v.task.message.countScreened = true;
  }
  await flushScreenObservability(runtime).catch(() => {});
}
/** Pre-checks admission (balance, limits, domain, attachments, oversize), suppression, and content screening outside DB write locks. */
export async function prepareFrontDoor(runtime: Runtime, a: Actor, out: Outgoing[], batch: boolean, scheduledAt?: string, skipSuppression = false) {
  const cfg = runtime.config, sim = isSimulatedSes(runtime);
  for (const [i, m] of out.entries()) {
    if (cfg.screen && !sim && cfg.hostedScreen) m.oversize = await screenRefusal(runtime, m.snapshot, batch ? i : undefined);
  }
  const check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out),
    ...(scheduledAt ? scheduledCharges(runtime, out, scheduledAt) : charges(runtime, out)) }, undefined, actorAssets(a, out.flatMap(m => m.snapshot.attachments)));
  const { rows: [pre] } = await runtime.db.execute<{ s: Admitted | Refused; probation: ProbationReason | null }>(sql`
    SELECT ${check} AS s, ${cfg.multiTenant ? probationReason(sql`${a.workspaceId}`) : sql`NULL`} AS probation`);
  await refusedAttachments(runtime, a, pre!.s, out, batch);
  const decided = admitted(runtime, pre!.s, a.workspaceId, { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  await checkRecipientsEligible(runtime.db, a.workspaceId, out, batch, skipSuppression || isSystemNoticeKey(a.keyId));
  await screenOutgoingAtAccept(runtime, a, out, decided, pre!.probation !== null, batch, runtime.db);
}
// A built-in domain's mail also names its recipients: send_admission checks them against its send scope and caps.
const admissionMails = (runtime: Runtime, out: Outgoing[]): AdmissionMail[] => out.map(({ snapshot: s, duplicate, invalid, oversize }) => ({ host: s.from.split('@')[1]!.toLowerCase(), region: s.region || undefined,
  kind: s.kind, attachments: [...new Set(s.attachments)], bodyBytes: contentBytes(s), duplicate: !!duplicate, invalid: !!invalid, oversize: !!oversize,
  ...(isBuiltinHost(runtime.config, s.from.split('@')[1]!) ? { recipients: [...s.to, ...s.cc, ...s.bcc].map(e => e.toLowerCase()) } : {}) }));

/**
 * Admits a send in one statement: the API key's authentication and budget (a warm key), the idempotency claim, the
 * send locks, the decision (send_admission) and every row the send writes. Direct and batch sends, self-hosted and
 * template sends, dashboard and platform notices and campaign tests all come here (template sends and campaign tests
 * through claimedSend);
 * the screen's measure runs here too, and the decision refuses it only for mail the screen would read.
 */
async function admitSends(call: SendCall, body: unknown, out: Outgoing[], identity: Identity, options: { batch: boolean; campaign?: { id: string; revision: number }; scheduledAt?: string }): Promise<SendReceipt | { data: SendReceipt[] }> {
  const runtime = call.runtime, cfg = runtime.config, sim = isSimulatedSes(runtime), key = call.key, batch = options.batch, at = options.scheduledAt;
  const guarded = !at && (cfg.linkHost || cfg.linkHosts) && out.some(m => m.snapshot.kind === 'marketing' && m.snapshot.linkOrigin);
  if (guarded && !call.db) return runtime.db.transaction(db => admitSends({ ...call, db }, body, out, identity, options));
  // A scheduled send keeps the region it asked for, if any: its release resolves the sender's region again.
  if (at) for (const m of out) if (m.snapshot.region) m.snapshot.requestedRegion = m.snapshot.region;
  let expanded = 0;
  for (const [i, m] of out.entries()) {
    if (cfg.screen && !sim && cfg.hostedScreen) m.oversize = await screenRefusal(runtime, m.snapshot, batch ? i : undefined);
    expanded += Buffer.byteLength(JSON.stringify(m.snapshot)) + 40;
    if (batch && expanded > SENDING_LIMITS.expandedCampaignBytes) m.invalid ??= new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Expanded batch content exceeds the ${SENDING_LIMITS.expandedCampaignBytes / 1024 / 1024} MiB limit. Submit smaller batches.`);
  }
  const hash = key === undefined ? null : await requestHash(body);
  const data = out.map(m => ({ id: m.emailId ?? rowId('email'), status: 'queued' as const, simulated: sim, ...(at ? { scheduledAt: at } : {}), ...(m.screenSummary ? { screen: m.screenSummary } : {}) })), receipt = batch ? { data } : data[0]!;
  const rows = out.map((m, ord) => ({ ord, id: data[ord]!.id, snapshot: m.snapshot, hash: m.token?.hash, email: m.token?.email, screened: !m.heldForScreen, count_screened: !!m.countScreened, marketing: m.snapshot.kind === 'marketing', destinations: [...m.snapshot.to, ...m.snapshot.cc, ...m.snapshot.bcc].map(e => e.toLowerCase()), reply_authors: m.snapshot.replyAuthors ?? [] }));
  const skipSuppression = 'actor' in identity && isSystemNoticeKey(identity.actor.keyId);
  const ids = [...new Set(out.flatMap(m => m.snapshot.attachments))];
  const principal = 'credential' in identity ? sql`SELECT k.*,b.used FROM credential k LEFT JOIN budget b ON true` : sql`SELECT ${identity.actor.keyId}::text AS id,${identity.actor.workspaceId}::text AS workspace_id,
    ${JSON.stringify(identity.actor.permissions)}::jsonb AS permissions,${JSON.stringify(identity.actor.domains)}::jsonb AS domains,0 AS used,0 AS max_requests`;
  const assets = visibleAssets(ids, 'credential' in identity
    ? { workspace: sql`k.workspace_id`, uploader: sql`k.id`, domains: sql`k.domains`, mailboxAccess: sql`k.permissions ? 'manage'` }
    : { workspace: sql`k.workspace_id`, uploader: sql`${identity.actor.tokenId ?? identity.actor.keyId}::text`, domains: sql`k.domains`, mailboxAccess: sql`${actorMailAccess(identity.actor) !== null}::boolean` });
  // A scheduled send is charged nothing now: its release admits it as a send at its time (releaseScheduled).
  // A send with an ineligible recipient writes nothing, so it must not claim its key either: send_admission's claim
  // commits a populated receipt with the statement, and a sibling CTE can't delete a row the function inserted (one
  // snapshot for the whole statement). It asks for the claim only when no recipient is ineligible; otherwise the key is
  // only read, as idempotency_claim reads it: a committed claim replays, a key another request holds is busy.
  const claim = key !== undefined ? { path: call.path, key, hash: hash! } : undefined;
  const decision = await admission(runtime, sql`k.workspace_id`, sql`jsonb_build_object('id',k.id,'domains',k.domains)`, { stage: 'send', locks: 'take', mails: admissionMails(runtime, out),
    ...(at ? scheduledCharges(runtime, out, at) : charges(runtime, out)), ...(options.campaign ? { campaign: options.campaign } : {}) },
    claim && sql`CASE WHEN EXISTS (SELECT FROM candidate_ineligible) THEN '{}'::jsonb ELSE ${JSON.stringify({ claim: { ...claim, receipt } })}::jsonb END`, assets);
  const keyRead = claim ? sql`CASE WHEN EXISTS (SELECT FROM candidate_ineligible) THEN coalesce(
      (SELECT jsonb_build_object('previous',i.result,'hash',i.request_hash,'createdAt',i.created_at) FROM sending_idempotency i
        WHERE i.workspace_id=k.workspace_id AND i.actor_key_id=k.id AND i.path=${claim.path} AND i.request_key=${claim.key}),
      CASE WHEN NOT idempotency_lock(k.workspace_id,k.id,${claim.path},${claim.key}) THEN jsonb_build_object('previous',NULL,'hash',${claim.hash}::text,'busy',true) END) END` : sql`NULL::jsonb`;
  const { rows: [result] } = await (call.db ?? runtime.db).execute<Principal & { s: Admitted | Refused | ClaimState | null; ineligible: { ord: number; email: string; reason: string }[] | null; max_send_rate: number | null }>(sql`/* send admission: idempotency claim, send_admission, the send's rows (named first: pg_stat_activity keeps a statement's first 1 KB) */
  WITH ${'credential' in identity ? sql`${identity.credential},` : sql``} principal AS MATERIALIZED (${principal}),
  submitted_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) m(ord int,id text,hash text,email text,screened boolean,count_screened boolean,marketing boolean,destinations jsonb,reply_authors jsonb,snapshot jsonb)),
  -- Recipients the send can't go to, read before the decision so that it claims the key only for a send it can write.
  candidate_ineligible AS MATERIALIZED (${skipSuppression ? sql`SELECT NULL::int AS ord, NULL::text AS email, NULL::text AS reason WHERE false` : sql`
    SELECT r.ord, d.email, cause.reason
    FROM principal k CROSS JOIN submitted_rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.destinations) WITH ORDINALITY d(email, n)
    LEFT JOIN audience_contacts c ON c.workspace_id = k.workspace_id AND c.email = d.email
    CROSS JOIN LATERAL (SELECT ${recipientIneligibleReasonSql({ marketing: sql`r.marketing`, replyAuthors: sql`r.reply_authors`, topic: sql`r.snapshot->>'topicId'`, risk: true })} AS reason) cause
    WHERE cause.reason IS NOT NULL
    ORDER BY r.ord, d.n`}
  ), state AS MATERIALIZED (
    SELECT k.*, CASE WHEN k.used IS NULL THEN jsonb_build_object('previous',NULL,'busy',true) WHEN k.used<=k.max_requests AND k.permissions ?| ARRAY['manage','send'] THEN coalesce(${keyRead}, ${decision}) END s FROM principal k
  ), raw_submitted AS MATERIALIZED (SELECT k.workspace_id,k.id AS actor_id,m.ord,m.id,m.hash,m.email,m.screened,m.count_screened,m.marketing,m.destinations,m.reply_authors,
      m.snapshot||jsonb_build_object('region',x->>'region')||CASE WHEN jsonb_typeof(x->'binding')='object' THEN jsonb_build_object('binding',x->'binding') ELSE '{}' END AS snapshot
    FROM state k,submitted_rows m CROSS JOIN LATERAL (SELECT k.s->'mails'->m.ord AS x) r
    WHERE k.s->>'allowed'='true'
  ),
  -- Reported only for a send the decision allowed: a refusal (or a replay) answers first, as before.
  ineligible AS MATERIALIZED (SELECT i.* FROM candidate_ineligible i WHERE EXISTS (SELECT FROM state k WHERE k.s->>'allowed'='true')),
  submitted AS MATERIALIZED (SELECT * FROM raw_submitted WHERE NOT EXISTS (SELECT 1 FROM ineligible)),
  inserted AS (INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,screened,status,scheduled_at)
    SELECT id,workspace_id,actor_id,snapshot->>'region',snapshot->>'from',snapshot->'to',snapshot->'cc',snapshot->'bcc',snapshot->>'subject',snapshot,${sim},screened,${at ? 'scheduled' : 'queued'},${at ?? null}::timestamptz FROM submitted),
  ${out.some(m => m.countScreened) ? sql`screen_counted AS (${countScreened(sql`SELECT workspace_id, 0 AS rejected FROM submitted WHERE count_screened AND hosted_real_cost(destinations) > 0`)}),` : sql``}
  ${at ? sql`scheduled AS (${scheduledEvent(sql`SELECT workspace_id,id FROM submitted`, 'scheduled', at, sim)}), release AS (${queueRelease(sql`SELECT workspace_id,id FROM submitted`, at)}),` : sql``}
  links AS (INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id) SELECT workspace_id,a,'email',id FROM submitted,jsonb_array_elements_text(snapshot->'attachments') a),
  tokens AS (INSERT INTO operation_unsubscribe_tokens(workspace_id,token_hash,email,topic_id) SELECT workspace_id,hash,email,snapshot->>'topicId' FROM submitted WHERE hash IS NOT NULL)
  SELECT k.id,k.workspace_id,k.permissions,k.domains,k.used,k.max_requests,k.s,
    (SELECT jsonb_agg(to_jsonb(i)) FROM ineligible i) AS ineligible,
    (SELECT l.max_send_rate FROM provider_account_limits l WHERE l.aws_account_id = (k.s->'mails'->0->'connection'->>'aws_account_id') AND l.region = (k.s->'mails'->0->>'region') AND l.max_send_rate > 0) AS max_send_rate
  FROM state k`);
  if (!result) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
  const a = 'actor' in identity ? identity.actor : identity.authorize(result);
  const state = result.s!;
  // The statement's claim is idempotency_claim: the one replay rule answers a key it did not get.
  if ('previous' in state) return replay<typeof receipt>(state, hash!);
  await refusedAttachments(runtime, a, state as Admitted | Refused, out, batch);
  const decided = admitted(runtime, state as Admitted | Refused, a.workspaceId, { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  // Nothing was queued and the key wasn't claimed (above): a retry is judged again.
  if (result.ineligible?.length) throw recipientIneligibleError(result.ineligible, batch);
  if (guarded) {
    const counts = new Map<string, number>();
    for (const { snapshot, recipients } of out) if (snapshot.kind === 'marketing' && snapshot.linkOrigin) counts.set(snapshot.linkOrigin, (counts.get(snapshot.linkOrigin) ?? 0) + recipients);
    for (const [origin, n] of [...counts].sort(([a], [b]) => a.split('.').reverse().join('.').localeCompare(b.split('.').reverse().join('.')))) {
      const budget = await linkAllowance(call.db!, cfg, a.workspaceId, origin);
      if (budget && n > budget.left) {
        const error = new ApiError(429, budget.reason === 'link_listing' ? 'LINK_DOMAIN_HELD' : 'LINK_BUDGET_REACHED',
          budget.reason === 'link_listing' ? 'Marketing on this link domain is paused for review.' : 'The shared link domain has no room for this send today. Campaigns send the remainder on later days.', undefined, true);
        error.retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(budget.until)-Date.now())/1000));
        throw error;
      }
      if (new URL(origin).hostname === cfg.linkHost) await recordLinkUse(call.db!, a.workspaceId, cfg.linkHost, n);
    }
  }
  // Its release job wakes the dispatcher at its time; one due within a minute needs the scheduler awake now to follow it.
  if (at) { if (Date.parse(at) - Date.now() < 60_000) a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); return receipt; }
  const maxSendRate = typeof result.max_send_rate === 'number' && result.max_send_rate > 0 ? result.max_send_rate : undefined;
  for (const [i, m] of out.entries()) {
    if (m.heldForScreen) continue;
    const route = decided.mails[i]!;
    if (route.connection) a.dispatchAccount = { aws_account_id: route.connection.aws_account_id, kind: route.connection.kind, ...(maxSendRate ? { maxSendRate } : {}) };
    noteDispatch(a, { ...m.snapshot, region: route.region });
  }
  return receipt;
}
/**
 * A send that reads or renders something mutable before it is admitted: a stored template (SES renders it) or a
 * campaign test (its draft). Its Idempotency-Key is claimed first, pending, and committed before that work, so a
 * duplicate is IDEMPOTENCY_IN_PROGRESS and renders nothing; the claim is completed in the transaction that writes the
 * email and released only if nothing was written (idempotent's prepare). No send lock is held while it renders: the
 * transaction runs the one admission statement after the work.
 */
export async function claimedSend(call: SendCall, a: Actor, body: unknown, work: () => Promise<{ out: Outgoing[]; campaign?: { id: string; revision: number } }>, options: { batch: boolean; scheduledAt?: string; replayed?: (db: DbExecutor, receipt: SendReceipt) => Promise<void> }) {
  let prepared: Awaited<ReturnType<typeof work>> | undefined;
  const admit = (db?: DbExecutor) => admitSends({ ...call, key: undefined, db }, body, prepared!.out, { actor: a }, { batch: options.batch, campaign: prepared!.campaign, scheduledAt: options.scheduledAt });
  if (call.key === undefined) { prepared = await work(); return admit(); }
  return idempotent<SendReceipt | { data: SendReceipt[] }>(call.runtime.db, { path: call.path, key: call.key, workspaceId: a.workspaceId, actorKeyId: a.keyId }, body, admit,
    { prepare: async () => { prepared = await work(); }, replayed: options.replayed && ((db, receipt) => 'id' in receipt ? options.replayed!(db, receipt) : Promise.resolve()) });
}
/** Renders each stored template through SES in the region a check-only decision resolves (no lock is held). */
async function renderTemplates(runtime: Runtime, a: Actor, out: Outgoing[], batch: boolean) {
  const cfg = runtime.config, check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out), ...charges(runtime, out) },
    undefined, actorAssets(a, out.flatMap(m => m.snapshot.attachments)));
  const decided = admitted(runtime, (await runtime.db.execute<{ s: Admitted | Refused }>(sql`SELECT ${check} AS s`)).rows[0]!.s, a.workspaceId,
    { batch, invalid: i => out[i]!.invalid, oversize: i => out[i]!.oversize });
  for (const [i, m] of out.entries()) if (m.template) {
    const route = decided.mails[i]!, scoped = { ...runtime, config: { ...cfg, workspaceId: a.workspaceId, regions: [route.region] } };
    m.snapshot.region = route.region;
    await renderTemplate(scoped, m.snapshot, m.template, route.connection).catch(e => { throw atItem(e, batch ? i : undefined); });
  }
}
/** POST /v1/emails/send and /batch after authentication, the dashboard's test email and the platform's notices. */
export async function admitEmails(call: SendCall, a: Actor, input: SendRequest | { emails: SendRequest[] }, scheduledAt?: string, sealed = false, platformTestTo?: string) {
  const batch = 'emails' in input, mails = (batch ? input.emails : [input]).map(normalizeSender);
  await assertBuiltinStillSends(call.runtime, call.db ?? call.runtime.db, a.workspaceId, mails.map(m => m.from), batch);
  assertBuiltinInput(call.runtime.config, mails.map(m => ({ ...m, scheduledAt })), batch);
  await assertBuiltinRecipients(call.runtime, call.db ?? call.runtime.db, a.workspaceId, mails.map(m => ({ from: m.from, recipients: [...(Array.isArray(m.to) ? m.to : [m.to]), ...m.cc, ...m.bcc] })), batch);
  if (mails.some(m => isBuiltinHost(call.runtime.config, m.from.split('@')[1]!))) await awaitBuiltinSetup(call.runtime, a.workspaceId);
  // A topic is about marketing (src/topics.ts): its opt-outs and its one-click unsubscribe. One read for the whole send.
  const at = (i: number, field: string) => batch ? `emails.${i}.${field}` : field;
  const plain = mails.findIndex(m => m.topicId && m.kind !== 'marketing');
  if (plain >= 0) throw new ApiError(422, 'TOPIC_REQUIRES_MARKETING', 'A topic is for marketing mail (kind: marketing): transactional mail has no unsubscribe.', at(plain, 'topicId'));
  const mktUnsub = mails.findIndex(m => m.unsubscribe && m.kind !== 'transactional');
  if (mktUnsub >= 0) throw new ApiError(422, 'UNSUBSCRIBE_REQUIRES_TRANSACTIONAL', `Marketing mail already includes ${productName}\u2019s one-click unsubscribe headers; use unsubscribe only on kind: transactional.`, at(mktUnsub, 'unsubscribe'));
  await assertTopics(call.db ?? call.runtime.db, a.workspaceId, mails.map(m => m.topicId), i => at(i, 'topicId'));
  // Marketing mail's footer carries the workspace's postal address when it has one. Unlike a campaign, a marketing send
  // without one is not refused: its caller writes the whole message and may include the address itself.
  const marketing = mails.some(m => m.kind === 'marketing'), db = call.db ?? call.runtime.db;
  const address = marketing ? await workspacePostalAddress(call.runtime, db, a.workspaceId) : null;
  // Its unsubscribe link goes on the link domain (src/link-domains.ts; a domain's own active link host when those are on),
  // whose use these recipients are recorded in; refused while the workspace is paused.
  const choose = marketing ? linkChoices(call.runtime, db, a.workspaceId) : undefined;
  const choices = choose ? await Promise.all(mails.map((m, i) => m.kind === 'marketing' ? choose(m.from).catch(error => { throw atItem(error, batch ? i : undefined); }) : undefined)) : [];
  const out = await directMessages(call.runtime, mails, batch, address, choices.map(choice => choice?.origin));
  if (sealed) for (const m of out) m.snapshot.sealed = true;
  if (platformTestTo) for (const m of out) m.platformTestTo = platformTestTo;
  // A reply by header joins the conversation it answers only when its sender can read that message.
  await joinReplies(call.db ?? call.runtime.db, actorMailAccess(a), out.map(m => m.snapshot));
  const screened = mayScreenAtAccept(call.runtime, out), needsPrep = out.some(m => m.template) || screened;
  if (!needsPrep) return admitSends(call, input, out, { actor: a }, { batch, scheduledAt });
  return claimedSend(call, a, input, async () => {
    if (out.some(m => m.template)) await renderTemplates(call.runtime, a, out, batch);
    if (screened) await prepareFrontDoor(call.runtime, a, out, batch, scheduledAt);
    return { out };
  }, { batch, scheduledAt });
}
/** A message an app submitted over SMTP with a send-only key (protocol-relay.ts), as POST /v1/emails/send takes it. */
export type RelayedMessage = { from: string; fromName?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; subject: string; text?: string; html?: string; attachments: string[]; headers: { name: string; value: string }[]; mime?: string };
/**
 * A relayed message built as sendEmail builds one. SMTP's envelope decides who gets it, and every recipient may be Bcc
 * (a To-less message), which sendEmail's schema refuses: it checks them together as To, then the copy takes the
 * message's own To, Cc and Bcc, as a mail client's submission does (queueMailboxEmail). SMTP already bounds the whole
 * message, so the bodies keep no JSON part cap.
 */
async function relayedMessage(runtime: Runtime, input: RelayedMessage) {
  const { mime, ...fields } = input;
  const parsed = ProtocolSendInput.safeParse({ ...fields, to: [...input.to, ...input.cc, ...input.bcc], cc: [], bcc: [] });
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Message fields are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
  const out = await directMessages(runtime, [parsed.data], false), message = out[0]!;
  if (message.invalid) throw message.invalid;
  if (mime) passThrough(message.snapshot, mime, message.marketing);
  Object.assign(message.snapshot, { to: input.to, cc: input.cc, bcc: input.bcc, mailApp: true });
  return { parsed: parsed.data, out };
}
/** Before a relayed message's attachments are uploaded: the message and its sender's admission, checked without
 *  sending or locking (renderTemplates' check), so a send that would be refused writes nothing. */
export async function checkRelayed(runtime: Runtime, a: Actor, input: RelayedMessage) {
  const { out } = await relayedMessage(runtime, { ...input, attachments: [] });
  const check = await admission(runtime, a.workspaceId, actorJson(a), { stage: 'send', locks: 'none', mails: admissionMails(runtime, out), ...charges(runtime, out) });
  admitted(runtime, (await runtime.db.execute<{ s: Admitted | Refused }>(sql`SELECT ${check} AS s`)).rows[0]!.s, a.workspaceId);
}
/**
 * A relayed message, admitted as POST /v1/emails/send without an Idempotency-Key admits one: in one statement that reads
 * the key through `credential` (as a bearer key's request does) and writes the email. Its attachments were uploaded by
 * the key, as POST /v1/attachments would.
 */
export async function admitRelayed(runtime: Runtime, inputs: RelayedMessage[], credential: SQL, authorize: (key: Principal) => Actor): Promise<SendReceipt[]> {
  // An envelope past SES's 50 recipients arrives in parts (protocol-relay.ts): admitted together, as a batch is.
  const each: Awaited<ReturnType<typeof relayedMessage>>[] = [];
  for (const input of inputs) each.push(await relayedMessage(runtime, input));
  const out = each.flatMap(e => e.out), batch = out.length > 1;
  if (mayScreenAtAccept(runtime, out)) {
    const { rows: [keyRow] } = await runtime.db.execute<Principal>(sql`WITH ${credential} SELECT k.*, b.used FROM credential k LEFT JOIN budget b ON true`);
    if (!keyRow) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
    const a = authorize(keyRow);
    await prepareFrontDoor(runtime, a, out, batch);
    const receipt = await admitSends({ runtime, path: '/v1/emails/send' }, batch ? { emails: each.map(e => e.parsed) } : each[0]!.parsed, out, { actor: a }, { batch });
    return 'data' in receipt ? receipt.data : [receipt];
  }
  const receipt = await admitSends({ runtime, path: '/v1/emails/send' }, batch ? { emails: each.map(e => e.parsed) } : each[0]!.parsed, out, { credential, authorize }, { batch });
  return 'data' in receipt ? receipt.data : [receipt];
}
// Auth middleware calls this only for ordinary bearer keys, after the request size gate. Malformed inputs, mailbox
// tracking, provider-rendered templates, replies by In-Reply-To (whose thread depends on what the key can read,
// joinReplies) and marketing mail (whose footer needs the workspace's postal address before the statement that finds
// the workspace) keep their normal authenticated handler (including error ordering).
export async function tryAtomicKeyAdmission(c:Ctx,credentialCtes:(charge?:SQL)=>SQL) {
  if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return;
  await boundRequestBody(c);
  const body=await c.req.json().catch(()=>undefined), batch=c.req.path==='/v1/emails/batch';
  const parsed=batch?BatchInput.safeParse(body):SingleSendInput.safeParse(body);
  if(!parsed.success)return;
  const input=parsed.data,mails='emails' in input?input.emails:[input];
  // Fall through to the authenticated handler whenever front-door content screening may run (keeps Jev/JevF outside DB locks).
  if (mayScreenAtAccept(c.env, mails)) return;
  if(('replyAddressId' in input && input.replyAddressId)||('replyMailboxId' in input && input.replyMailboxId)||('scheduledAt' in input && input.scheduledAt)||mails.some(m=>m.template || m.kind==='marketing' || isBuiltinHost(c.env.config,m.from.split('@')[1]!) || m.attachments.some(a=>a.includes('\0')) || m.headers?.some(h=>h.name.toLowerCase()==='in-reply-to')))return;
  const key=c.req.header('Idempotency-Key');if(key!==undefined && !validIdempotencyKey(key))return;
  if(batch && batchContent(mails)>SEND_LIMITS.batchContentChars)return;
  // The statement authenticates the key and answers 401, 429 and 403 before any admission answer. A duplicate of a
  // request still holding its Idempotency-Key is refused before it waits on the key's budget row, uncharged.
  const credential=credentialCtes(key===undefined?undefined:idempotencyGate(c.req.path,key));
  const authorize=(k:Principal):Actor=>{if(k.used!==null)checkBudget(c,k.used,k.max_requests);const a:Actor={keyId:k.id,workspaceId:k.workspace_id,permissions:k.permissions,domains:k.domains,credential:'apiKey'};c.set('actor',a);return actor(c,'send');};
  const call={runtime:c.env,path:c.req.path,key};
  return c.json(await batchMemory(mails,async()=>admitSends(call,input,await directMessages(c.env,mails,batch),{credential,authorize},{batch})),202);
}
/** A mail app's signed or encrypted submission goes out as its own bytes (protocol-submit.ts sealedPassthrough). Nothing
 *  can be added to them, so not as bulk mail, which is held and sent as marketing. */
function passThrough(snapshot: EmailSnapshot, mime: string, bulk: boolean) {
  if (bulk) throw new ApiError(422, 'UNSUPPORTED_MESSAGE', 'Signed or encrypted mail can’t be sent as bulk mail.');
  snapshot.mime = mime;
}
export type MailboxSendRequest = { protocolEnvelope?:boolean; mime?: string; from: string; fromName?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; region?: string; subject: string; html?: string; text?: string; attachments: string[]; tracking?: boolean; screen?: boolean; sealed?: boolean; headers: { Name: string; Value: string }[];
  /** A thread reply: the received message it answers (builtin-domain.ts builtinReplyException). */
  builtinReply?: import('../builtin-domain.js').BuiltinReply };
/** Queues one transactional email from a mailbox through the send admission and dispatch pipeline, with extra MIME
 * headers. Only sendFromMailbox calls it, under the send locks it holds. */
export async function queueMailboxEmail(runtime: Runtime, db: DbExecutor, held: SendScope, a: Actor, request: MailboxSendRequest, replyAuthors: string[] | null) {
  sesHeaders(request.headers.length);
  // A built-in domain stops sending once the workspace's own verifies, and its Reply-To stays at its own name, here as on POST /v1/emails/send.
  await assertBuiltinStillSends(runtime, db, a.workspaceId, [request.from]);
  assertBuiltinInput(runtime.config, [{ from: request.from, replyTo: request.replyTo, attachments: request.attachments }]);
  const { replyGranted } = await assertBuiltinRecipients(runtime, db, a.workspaceId, [{ from: request.from, recipients: [...request.to, ...request.cc, ...request.bcc] }], false, request.builtinReply);
  const schema = request.protocolEnvelope ? ProtocolSendInput : SendInput;
  const parsed = schema.safeParse({ from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}), to: request.protocolEnvelope?[...request.to,...request.cc,...request.bcc]:request.to, cc:request.protocolEnvelope?[]:request.cc, bcc:request.protocolEnvelope?[]:request.bcc, replyTo: request.replyTo, region: request.region, kind: 'transactional', subject: request.subject, ...(request.html ? { html: request.html } : {}), ...(request.text ? { text: request.text } : {}), attachments: request.attachments, tracking: request.tracking ?? false, screen: request.screen });
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Message fields are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
  for (const header of request.headers) if (!/^[!-9;-~]{1,126}$/.test(header.Name) || !/^[ -~]{1,995}$/.test(header.Value) || header.Name.length + header.Value.length > 996) throw new ApiError(422, 'INVALID_MIME_HEADER', `Header ${header.Name} is not a valid single-line ASCII header.`);
  // The same bulk evidence as POST /v1/emails/*, over the whole envelope and every header (threads, replies, forwards,
  // tracked sends and SMTP submissions all arrive here): bulk mail is charged and held as marketing.
  const [isBulk] = bulkFlags([{ kind: 'transactional', to: request.to, cc: request.cc, bcc: request.bcc, subject: request.subject, html: request.html, text: request.text,
    headers: [...(parsed.data.headers ?? []), ...request.headers.map(h => ({ name: h.Name, value: h.Value }))] }]);
  const snapshot = await prepare(parsed.data, null);
  if (request.mime) passThrough(snapshot, request.mime, !!isBulk);
  const cfg = runtime.config, oversize = cfg.screen && !isSimulatedSes(runtime) && cfg.hostedScreen ? await screenRefusal(runtime, snapshot) : undefined;
  const message: Outgoing = { snapshot, recipients: hostedCost(request.to, request.cc, request.bcc), marketing: !!isBulk, oversize };
  // The mailbox rules admitted this sender and these attachments; the sending log's reader rule is for other callers.
  const decided = admitted(runtime, (await db.execute<{ s: Admitted | Refused }>(sql`SELECT ${await admission(runtime, a.workspaceId, actorJson(a),
    { stage: 'send', locks: held, mails: admissionMails(runtime, [message]), ...charges(runtime, [message]), ...(replyGranted ? { builtin: builtinReplyPolicy(runtime.config) } : {}) }, undefined, actorAssets(a, snapshot.attachments, true))} AS s`)).rows[0]!.s,
    a.workspaceId, { oversize: () => oversize });
  const route = decided.mails[0]!;
  snapshot.region = route.region;
  if (route.binding) snapshot.binding = route.binding;
  if (route.connection) {
    const { rows: [lim] } = await db.execute<{ rate: number | null }>(sql`SELECT max_send_rate AS rate FROM provider_account_limits WHERE aws_account_id=${route.connection.aws_account_id} AND region=${route.region} AND max_send_rate>0`);
    a.dispatchAccount = { aws_account_id: route.connection.aws_account_id, kind: route.connection.kind, ...(typeof lim?.rate === 'number' && lim.rate > 0 ? { maxSendRate: lim.rate } : {}) };
  }
  if (isBulk) snapshot.bulk = true;
  if(request.protocolEnvelope){snapshot.to=request.to;snapshot.cc=request.cc;snapshot.bcc=request.bcc;snapshot.mailApp=true;}
  snapshot.headers = [...snapshot.headers, ...request.headers];
  snapshot.untrustedContent = replyAuthors !== null || snapshot.headers.some(h => h.Name.toLowerCase() === 'in-reply-to');
  if (replyAuthors !== null) snapshot.replyAuthors = replyAuthors;
  if (request.sealed) snapshot.sealed = true;
  snapshot.mailbox = true;
  message.snapshot = snapshot;
  await checkRecipientsEligible(db, a.workspaceId, [message], false);
  if (mayScreenAtAccept(runtime, [message])) {
    const prob = cfg.multiTenant ? (await db.execute<{ p: ProbationReason | null }>(sql`SELECT ${probationReason(sql`${a.workspaceId}`)} AS p`)).rows[0]?.p !== null : false;
    await screenOutgoingAtAccept(runtime, a, [message], decided, prob, false, db);
  }
  const receipt = await queueEmail(runtime, db, a, message.snapshot, message.emailId, !!message.countScreened, !message.heldForScreen);
  return { emailId: receipt.id, snapshot: message.snapshot };
}

/**
 * The dashboard's test email (POST /v1/domains/{id}/test-send), to the signed-in user: fixed content from hello@<domain>,
 * or onboarding's setup email (setup-email.ts) from "<productName> Setup" <setup@domain> with the subject and text they
 * wrote. Without them, or with onboarding's own words, the content is ours. It reads as a real first email, plain text:
 * "test" and placeholder wording in a subject or body send mail to spam.
 */
export const platformTestEmail = (domain: string, custom?: { subject: string; text: string }) => {
  if (custom) return { from: `${SETUP_SENDER.local}@${domain}`, fromName: SETUP_SENDER.name, subject: custom.subject, text: custom.text };
  const from = `hello@${domain}`;
  return { from, fromName: undefined, subject: `Your first email from ${productName}`, text: `Hi,\n\n${domain} is set up, and this is the first email sent from ${from}.\n\nThanks,\n${productName}\n` };
};
/**
 * The content screen's verdict for the dashboard's test email: its words are ours (the fixed test, or onboarding's setup
 * email as the dashboard wrote it) and it goes only to the person who asked for it, so there is nothing for the
 * classifier to judge, and Hosted dispatch (which sends nothing without a verdict) takes this one, recorded as such.
 * Anything else, a changed word, another or a further recipient, a header, an attachment or HTML, gets no verdict here
 * and is screened as usual.
 */
export function platformTestVerdict(s: EmailSnapshot, to: string, rules: ContentRules): EmailSnapshot['screenVerdict'] {
  const domain = s.from.split('@')[1] ?? '';
  const ours = [platformTestEmail(domain), platformTestEmail(domain, SETUP_EMAIL)].some(fixed => s.from === fixed.from && (s.fromName ?? undefined) === fixed.fromName && s.subject === fixed.subject && s.text === fixed.text);
  const exact = ours && s.html === undefined && s.kind === 'transactional'
    && s.to.length === 1 && s.to[0]!.toLowerCase() === to.toLowerCase() && !s.cc.length && !s.bcc.length && !s.replyTo.length && !s.attachments.length
    && !s.headers.length && !s.template && !s.raw && !s.mime;
  return exact ? { status: 'platform', reason: 'platform test email', rules } : undefined;
}
export async function admitTestEmail(c: Ctx, a: Actor, domain: string, to: string, custom?: { subject: string; text: string }) {
  const { fromName, ...mail } = platformTestEmail(domain, custom);
  return Receipt.parse(await admitEmails(sendCall(c), a, SingleSendInput.parse({ ...mail, ...fromName ? { fromName } : {}, to: [to] }), undefined, false, to));
}
