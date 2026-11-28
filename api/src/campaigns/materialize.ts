import { sql, getTableColumns, eq } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { digest } from '../core/http.js';
import type { Runtime, Actor, DbExecutor } from '../core/types.js';
import { redactCapabilityText, ApiError } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import { JobDeferred } from '../jobs.js';
import { countScreened } from '../states.js';
import type { CampaignScreen, ScreenResult } from '../screen.js';
import { sendingConnections, type SendingBinding } from '../domain-claims.js';
import { type ProbationReason, probationReason } from '../hosted-sending.js';
import { type emails, type ReviewedRecipient, type EmailSnapshot, type CampaignDraft, type attachments, campaigns, campaignReviews } from '../db/sending.js';
import { linkOrigin } from '../link-domains.js';
import { canonical } from '../idempotency.js';
import type { AdmissionMail } from '../admission.js';
import { EmailContent, CAMPAIGN_PREPARE_ROWS, CAMPAIGN_CHUNK_BYTES, loadOpsUnsub, CAMPAIGN_RENDERER_VERSION, limitsTable, sharedConnection, campaignWhere, loadParse5, unsubscribePlaceholder, loadScreen } from '../sending/schemas.js';
import { checkedDispatchAttachments, FEEDBACK_LAG_FRESH_MS } from '../sending/events.js';
import { campaignMessage } from './views.js';
import { attachmentRows, sizeCheck, resolveHostedContentPolicy, withPreheader } from '../sending/mime.js';
import { marketingFooter, screenedAtDispatch, type Footer } from '../sending/front-door.js';

export async function visibleEmailContent(runtime: Runtime,a: Actor,row: typeof emails.$inferSelect, untrustedContent: boolean) {
  // Sent campaign emails store a stub; queued ones have no body yet (html/text null, as before).
  const s = sentCampaignEmail(row.snapshot) ? await sentCampaignContent(runtime, a, row) : row.snapshot.deferredCampaign && !row.snapshot.attachments
    ? {...row.snapshot,subject:row.subject,attachments:(await runtime.db.execute<{ids:string[]}>(sql`SELECT draft->'attachments' AS ids FROM sending_campaign_reviews WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId}`)).rows[0]?.ids??[]} : row.snapshot;
  const manage = a.permissions.includes('manage');
  // App-owned capabilities only, not a general sanitizer for transactional bearer links.
  // Raw MIME can hide tokens inside encodings/folding; only managers receive that opaque content.
  const visible = (value: string | undefined) => value === undefined ? null : manage ? value : redactCapabilityText(value);
  // Sealed Nightmail notices (forward confirmations, sign-in links) carry a capability meant only for the recipient: withheld from every reader.
  if (row.snapshot.sealed) { const { sealCapabilities } = await import('../mailbox-send.js'); return EmailContent.parse({ untrustedContent, subject: visible(s.subject), html: s.html === undefined ? null : visible(sealCapabilities(s.html)), text: s.text === undefined ? null : visible(sealCapabilities(s.text)), raw: null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated }); }
  return EmailContent.parse({ untrustedContent, subject: visible(s.subject), html: visible(s.html), text: visible(s.text), raw: manage ? s.raw ?? s.mime ?? null : null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated });
}
export async function recipientChunk(db: DbExecutor, reviewId: string, cursor: number, limit = CAMPAIGN_PREPARE_ROWS) {
  const result = await db.execute<{ ordinal: number; recipient: ReviewedRecipient; content_hash: string | null; subject: string | null; snapshot_bytes: number | null; recipient_bytes: number; screen_rejected: boolean }>(sql`
    WITH batch AS (
      SELECT ordinal, recipient, content_hash, subject, snapshot_bytes, recipient_bytes, screen_rejected FROM sending_review_recipients
      WHERE review_id = ${reviewId} AND ordinal > ${cursor} ORDER BY ordinal LIMIT ${limit}
    ), sized AS (
      SELECT *, sum(recipient_bytes + coalesce(octet_length(subject), 0) + 64) OVER (ORDER BY ordinal) AS bytes FROM batch
    ) SELECT ordinal, recipient, content_hash, subject, snapshot_bytes, recipient_bytes, screen_rejected FROM sized
      WHERE bytes <= ${CAMPAIGN_CHUNK_BYTES} OR ordinal = ${cursor + 1} ORDER BY ordinal`);
  return result.rows;
}

const LEGACY_CONTENT_HASH = /^[0-9a-f]{64}$/;
const STATIC_S1_CONTENT_HASH = /^s1:[0-9a-f]{64}$/;
export const isSupportedContentHash = (hash: string | null | undefined): hash is string =>
  !!hash && (LEGACY_CONTENT_HASH.test(hash) || STATIC_S1_CONTENT_HASH.test(hash));
export const unsupportedHashFormat = () => new ApiError(409, 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED', 'Paused: this campaign uses a newer content hash format that this release cannot verify. Deploy the matching release before resuming.', undefined, true);
export async function staticContentHash(baseHash: string, email: string): Promise<string> {
  return `s1:${await digest(`${baseHash}:${email}`)}`;
}
/**
 * Verifies a frozen recipient's content_hash in either the legacy full-snapshot format (64 hex chars) or the compact
 * static `s1:` format (`s1:${sha256(baseHash + ':' + email)}`). Unknown future formats throw retryable
 * CAMPAIGN_HASH_FORMAT_UNSUPPORTED so release/dispatch pause and defer instead of rejecting unsent recipients.
 */
export async function verifyCampaignContentHash(customer: EmailSnapshot, storedHash: string): Promise<boolean> {
  if (STATIC_S1_CONTENT_HASH.test(storedHash)) {
    const baseHash = await digest(canonical({ ...customer, to: [] }));
    return (await staticContentHash(baseHash, customer.to[0] ?? '')) === storedHash;
  }
  if (LEGACY_CONTENT_HASH.test(storedHash)) {
    return (await digest(canonical(customer))) === storedHash;
  }
  throw unsupportedHashFormat();
}
// Reviews frozen before campaign mail stopped linking web fonts hold a font block (v1: data-opensend-fonts) whose URLs
// name this installation. A copy goes out, and reads back, without it; its hash and screen key still cover the review
// as frozen. Block HTML has no <style> of its own, so the renderer's block is the only one this can match.
const LEGACY_FONTS = /<style data-(?:bane|opensend)-fonts>[^<]*<\/style>/;
const withoutLegacyFonts = (snapshot: EmailSnapshot): EmailSnapshot => snapshot.html && LEGACY_FONTS.test(snapshot.html) ? { ...snapshot, html: snapshot.html.replace(LEGACY_FONTS, '') } : snapshot;
export async function materializeCampaignEmail(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, review: { version: number; draft: CampaignDraft; rendered: { html?: string; text?: string }; contentHash: string | null; recipient: ReviewedRecipient } | null, prefetched?: (typeof attachments.$inferSelect)[]) {
  // Review/recipient data and attachment metadata are immutable; retained email
  // links prevent attachment deletion. No transaction is needed to render them.
  // The winning claim persists its snapshot and token atomically; losing workers
  // discard their render without writing a different snapshot over the winner.
  const rows = prefetched ? checkedDispatchAttachments(mail.snapshot.attachments, prefetched) : await attachmentRows(runtime.db, a, mail.snapshot.attachments);
  if (!review?.rendered || !review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The reviewed recipient is unavailable.');
  if (!isSupportedContentHash(review.contentHash)) throw unsupportedHashFormat();
  const customer = await campaignMessage(runtime, review.draft, review.recipient, false, rows, review.rendered, true, !review.rendered.html?.includes('{{'), review.version);
  if (!(await verifyCampaignContentHash(customer, review.contentHash))) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_CHANGED', 'The renderer no longer reproduces the reviewed message. No provider attempt was made.');
  // `keyed`: the same customer copy with the footer generated for the placeholder link, as campaign screening keys it.
  const keyed = screenedAs(runtime, customer, review.draft);
  // A required notice has no unsubscribe link: it goes out exactly as it is keyed, and no token is made for it.
  if (review.draft.requiredNotice) {
    sizeCheck(keyed, rows);
    return { mail: { ...mail, snapshot: withoutLegacyFonts({ ...keyed, headers: [...keyed.headers] }) }, rows, unsubscribe: undefined, stored: { kind: 'marketing' as const, deferredCampaign: true, requiredNotice: true as const }, keyed };
  }
  // Keep the origin charged at release (or already rendered on an earlier attempt). Only older rows need a fresh lookup.
  const origin = mail.snapshot.linkOrigin ?? (mail.snapshot.unsubscribeUrl ? new URL(mail.snapshot.unsubscribeUrl).origin : undefined) ?? review.draft.linkOrigin ?? await linkOrigin(runtime, runtime.db, a.workspaceId, review.draft.from);
  // A retried row (throttled requeue) reuses the link it was first rendered with, so every attempt sends the same message.
  const reused = mail.snapshot.unsubscribeUrl?.startsWith(`${origin}/unsubscribe/`) ? mail.snapshot.unsubscribeUrl : undefined;
  // Its link is about the campaign's topic (src/topics.ts), when it has one: its one-click opts out of that topic alone.
  const topicId = review.draft.topicId ?? null;
  const unsubscribe = reused
    ? { url: reused, record: { tokenHash: await digest(reused.slice(reused.lastIndexOf('/') + 1)), workspaceId: a.workspaceId, email: customer.to[0]!.trim().toLowerCase(), topicId } }
    : await (await loadOpsUnsub()).createUnsubscribeLink(origin, a.workspaceId, customer.to[0]!, topicId);
  const page = review.draft.unsubscribePageUrl;
  // Its inline pictures are linked from the same host as its unsubscribe link (src/linked-images.ts).
  const snapshot = { ...withoutLegacyFonts(withUnsubscribe(runtime, customer, unsubscribe.url, { ...review.draft, linkOrigin: origin })), linkOrigin: origin };
  sizeCheck(snapshot, rows);
  // Persist only the compact stub plus the unsubscribe URL: the body is reproducible from the frozen review and
  // recipient (verified by contentHash), so storing ~2-3 KB of rendered HTML per recipient bought nothing.
  const stored = { kind:'marketing' as const,deferredCampaign:true,unsubscribeUrl:unsubscribe.url };
  return { mail: { ...mail, snapshot }, rows, unsubscribe: { ...unsubscribe.record, page }, stored, keyed };
}
/** A campaign email that was rendered and sent: its stub keeps the unsubscribe URL, or marks a required notice. */
export const sentCampaignEmail = (s: EmailSnapshot) => !!s.deferredCampaign && !!(s.unsubscribeUrl || s.requiredNotice);
// Rebuilds a sent campaign email from its frozen review, recipient values and stored unsubscribe URL, and refuses to
// show anything that does not match the hash of what was reviewed and sent.
type SentReview = { draft: CampaignDraft; rendered: { html?: string; text?: string } | null; renderer_version: number; recipient: ReviewedRecipient; content_hash: string | null };
export async function sentCampaignContent(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect): Promise<EmailSnapshot> {
  if (!mail.reviewId || mail.reviewOrdinal === null || !sentCampaignEmail(mail.snapshot)) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  const found = await runtime.db.execute<SentReview>(sql`
    SELECT v.draft, v.rendered, v.renderer_version, r.recipient, r.content_hash
    FROM sending_campaign_reviews v JOIN sending_review_recipients r ON r.review_id = v.id AND r.ordinal = ${mail.reviewOrdinal}
    WHERE v.id = ${mail.reviewId} AND v.campaign_id = ${mail.campaignId} AND v.workspace_id = ${a.workspaceId}`);
  return rebuildCampaignEmail(runtime, a, mail.snapshot, found.rows[0], await attachmentRows(runtime.db, a, found.rows[0]?.draft.attachments ?? []));
}
// Pure: no writes, no provider calls. Also used to verify stored bodies before they are dropped.
export async function rebuildCampaignEmail(runtime: Runtime, a: Actor, stub: EmailSnapshot, review: SentReview | undefined, rows: (typeof attachments.$inferSelect)[]): Promise<EmailSnapshot> {
  if (!review?.rendered || !review.content_hash) throw new ApiError(410, 'EMAIL_CONTENT_EXPIRED', 'The campaign review this email was rendered from has been retired.');
  if (![1, CAMPAIGN_RENDERER_VERSION].includes(review.renderer_version)) throw new ApiError(409, 'CAMPAIGN_RENDERER_CHANGED', `This email was rendered by campaign renderer v${review.renderer_version}; this release supports v1 and v${CAMPAIGN_RENDERER_VERSION}.`);
  if (!(review.draft.requiredNotice ? stub.requiredNotice : stub.unsubscribeUrl)) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  if (!isSupportedContentHash(review.content_hash)) throw unsupportedHashFormat();
  const snapshot = await campaignMessage(runtime, review.draft, review.recipient, false, rows, review.rendered, true, !review.rendered.html?.includes('{{'), review.renderer_version);
  if (!(await verifyCampaignContentHash(snapshot, review.content_hash))) throw new ApiError(409, 'CAMPAIGN_CONTENT_UNREPRODUCIBLE', 'The renderer no longer reproduces the message that was sent.');
  marketingFooter(snapshot, stub.unsubscribeUrl ?? '', review.draft);
  return withoutLegacyFonts(snapshot);
}
// The campaign row with its frozen snapshot and the cached regional limits: one read per step of the run job.
type RunAccount = NonNullable<Actor['dispatchAccount']> & { pauseReason: string | null; generation:number; poolTier: string | null; legacyNames: boolean | null; probation: ProbationReason | null; exempt: boolean };
/** The campaign's launched review as a run sends it: frozen draft and rendered parts, their renderer, and its screening and capture state. */
type CampaignReviewSnapshot = { version: number; draft: CampaignDraft; rendered: { html?: string; text?: string }; hash: string; screen: CampaignScreen | null; capturedAt: string | null; capturedCount: number | null };
export type RunRow = typeof campaigns.$inferSelect & { review: CampaignReviewSnapshot; rate: number; max24: number; sent24: number; customer24: number; quotaCheckedAt: string | null; priorityLagMs: number | null; dbNow: string; account: RunAccount | null };
/** The campaign's run row; review is null when its frozen message source is missing (runCampaign refuses it). */
export async function readRun(runtime: Runtime, a: Actor, campaignId: string): Promise<RunRow | (Omit<RunRow, 'review'> & { review: null }) | undefined> {
  const limits = limitsTable(runtime), region = sql`${campaignReviews.draft}->>'region'`;
  const [row] = await runtime.db.select({ ...getTableColumns(campaigns),
    review: { version: campaignReviews.rendererVersion, draft: campaignReviews.draft, rendered: campaignReviews.rendered, hash: campaignReviews.contentHash, screen: campaignReviews.screen, capturedAt: campaignReviews.capturedAt, capturedCount: campaignReviews.capturedCount },
    autoPause: runtime.config.multiTenant ? sql<boolean>`${campaigns.autoPause} OR ${sharedConnection(a.workspaceId)}` : campaigns.autoPause,
    account: runtime.config.multiTenant ? sql<RunAccount>`(SELECT jsonb_build_object('aws_account_id', aws_account_id, 'kind', kind, 'pauseReason', pause_reason,'generation',generation,
      'poolTier', pool_tier, 'legacyNames', legacy_names,'probation',${probationReason(sql`${a.workspaceId}::text`)},
      'exempt',(SELECT exempt_hosted_quotas FROM workspaces WHERE id=${a.workspaceId}))
      FROM ${sendingConnections(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region})` : sql<null>`NULL`,
    rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    max24: sql<number>`coalesce((SELECT max_24_hour_send FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    sent24: sql<number>`coalesce((SELECT sent_last_24_hours FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    customer24: runtime.config.multiTenant ? sql<number>`coalesce((SELECT customer_sent_24_hours FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)` : sql<number>`0`,
    quotaCheckedAt: sql<string | null>`(SELECT checked_at::text FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region})`,
    priorityLagMs: sql<number | null>`coalesce(
      (SELECT oldest_ms FROM operation_feedback_lag WHERE lane = 'priority' AND updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)),
      (SELECT oldest_ms FROM operation_feedback_lag WHERE lane = 'routine' AND updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)
        AND NOT EXISTS (SELECT 1 FROM operation_feedback_lag WHERE lane = 'priority'))
    )`,
    dbNow: sql<string>`clock_timestamp()::text`,
  }).from(campaigns).leftJoin(campaignReviews, eq(campaignReviews.id, campaigns.reviewId)).where(campaignWhere(a, campaignId));
  if (!row) return;
  const { review, ...run } = row;
  return review?.rendered ? { ...run, review: { ...review, rendered: review.rendered } } : { ...run, review: null };
}
/** How a campaign's copies are delivered, as each message of it is (resolveHostedContentPolicy). */
const campaignRules = (runtime: Runtime, row: RunRow) => resolveHostedContentPolicy(runtime.config, { shared: row.account?.kind === 'shared', poolTier: row.account?.poolTier,
  legacyNames: row.account?.legacyNames, from: row.review.draft.from, probation: row.account?.probation != null, simulated: isSimulatedSes(runtime), kind: 'marketing' }).rules;
/** The review's screening state, when it is for the review's content. */
export const currentScreen = (row: RunRow) => row.review.screen?.contentHash === row.review.hash ? row.review.screen : null;
export const staleReview = () => new ApiError(409,'SENDER_BINDING_CHANGED','The reviewed sending binding is no longer ready.');
/** A campaign's message as admission sees it at preparation and release: its reviewed sender, region and binding. */
export const reviewedMail = (draft: CampaignDraft): AdmissionMail & { from: string; binding?: SendingBinding } => ({ host: draft.from.split('@')[1]!.toLowerCase(), from: draft.from,
  region: draft.region, binding: draft.binding, kind: 'marketing', attachments: [...new Set(draft.attachments)], bodyBytes: 0 });
const PLACEHOLDER = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;
/** The placeholders a campaign's subject and rendered parts use: the contact properties its audience snapshot keeps. */
export const placeholderKeys = (draft: Pick<CampaignDraft, 'subject'>, rendered: { html?: string; text?: string }) =>
  [...new Set([draft.subject, rendered.html ?? '', rendered.text ?? ''].flatMap(value => [...value.matchAll(PLACEHOLDER)].map(match => match[1]!)))];
/** Whether the dispatcher screens a campaign's mail (dispatcher.ts prepareMail): Hosted shared sending, live, with a classifier. */
export const campaignScreened = screenedAtDispatch;
/** The link host of a campaign's copies as its launch froze it; this installation's own origin for a review frozen before
 *  link hosts, which its screen keys were made with. Only keys and checks use that origin: delivery never does. */
export const keyedOrigin = (runtime: Runtime, footer: Footer) => footer.linkOrigin ?? runtime.config.publicUrl;
/** A campaign's own copy as each recipient gets it, placeholders unresolved: preheader, and footer with a placeholder link. */
export async function campaignCopy(runtime: Runtime, draft: CampaignDraft, rendered: { html?: string; text?: string }, version = CAMPAIGN_RENDERER_VERSION): Promise<EmailSnapshot> {
  const parse = rendered.html && draft.previewText ? await loadParse5() : undefined;
  const copy: EmailSnapshot = { testCampaignId: null, from: draft.from, ...(draft.fromName ? { fromName: draft.fromName } : {}), ...(draft.previewText !== undefined ? { previewText: draft.previewText } : {}),
    to: [], cc: [], bcc: [], replyTo: draft.replyTo ?? [], region: draft.region, kind: 'marketing', subject: draft.subject, html: withPreheader(rendered.html, draft.previewText, parse, version), text: rendered.text,
    attachments: draft.attachments, tracking: draft.tracking, headers: [] };
  marketingFooter(copy, unsubscribePlaceholder(keyedOrigin(runtime, draft)), draft);
  return copy;
}
export type CampaignScreenRef = { workspaceId: string; campaignId: string; reviewId: string };
export type CopyVerdict = (ScreenResult & { key: string }) | { refused: ApiError } | null;
/**
 * Verdicts for campaign copies, each keyed by the copy as it is delivered (src/screen.ts copyKey), with its own
 * unsubscribe link set back to the placeholder (screenedAs). Each distinct copy is screened as a single message is
 * (src/screen.ts screenInput), once: a verdict is durable per campaign and key (sending_campaign_screens), copies with
 * the same key share it, a relaunch of the same campaign reuses it, and an interrupted screen resumes at its next
 * request. Every request is charged to the review's budget before it is made, whether or not it succeeds, so a retry
 * asks only for what is left. Returns, per copy, its verdict, the refusal of a copy over the campaign limit, or null when
 * the deadline came first.
 */
export async function campaignVerdicts(runtime: Runtime, ref: CampaignScreenRef, copies: EmailSnapshot[], deadline: number): Promise<CopyVerdict[]> {
  const screen = await loadScreen(), keys = await Promise.all(copies.map(copy => screen.copyKey(runtime, copy)));
  // A plain loop: no closure here may hold the copies, which are as large as a message, past this call.
  const distinct = new Map<string, EmailSnapshot>();
  for (let i = 0; i < copies.length; i++) if (!distinct.has(keys[i]!)) distinct.set(keys[i]!, copies[i]!);
  type Row = { copy_hash: string; windows: number; spam: number; model: string | null; threshold: number | null; judged: boolean };
  const fields = sql`copy_hash,windows,spam,model,threshold,judged_at IS NOT NULL AS judged`;
  const select = async (hashes: string[]) => new Map((hashes.length ? (await runtime.db.execute<Row>(sql`SELECT ${fields} FROM sending_campaign_screens
    WHERE workspace_id=${ref.workspaceId} AND campaign_id=${ref.campaignId} AND copy_hash IN (SELECT jsonb_array_elements_text(${JSON.stringify(hashes)}::jsonb))`)).rows : []).map(row => [row.copy_hash, row]));
  let rows = await select([...distinct.keys()]);
  // Only a copy without a verdict is read: measured (one over the campaign limit is refused), and its requests built.
  const inputs = new Map<string, import('../screen.js').ScreenInput>(), refusals = new Map<string, ApiError>();
  for (const [key, copy] of distinct) {
    if (rows.get(key)?.judged) continue;
    try { inputs.set(key, await screen.screenInput(runtime, copy)); }
    catch (error) { if (error instanceof ApiError && error.code === 'CONTENT_TOO_LARGE_TO_SCREEN') refusals.set(key, error); else throw error; }
  }
  if (inputs.size) {
    await runtime.db.execute(sql`INSERT INTO sending_campaign_screens(campaign_id,workspace_id,copy_hash,requests)
      SELECT ${ref.campaignId},${ref.workspaceId},x.key,x.requests FROM jsonb_to_recordset(${JSON.stringify([...inputs].map(([key, input]) => ({ key, requests: input.requests.length })))}::jsonb) x(key text,requests int)
      ON CONFLICT (campaign_id,copy_hash) DO NOTHING`);
    rows = new Map([...rows, ...await select([...inputs.keys()])]);
  }
  const work = [...inputs.keys()].filter(key => !rows.get(key)?.judged);
  const call = { workspaceId: ref.workspaceId, campaignId: ref.campaignId, region: copies[0]?.region, kind: 'marketing', required: true };
  const charge = async () => {
    const charged = await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen_charged=screen_charged+1
      WHERE workspace_id=${ref.workspaceId} AND id=${ref.reviewId} AND screen_charged<screen_budget`);
    if (!charged.rowCount) throw new ApiError(422, 'CONTENT_SCREEN_BUDGET_EXCEEDED', 'This campaign has used the classifier requests its audience allows; its unscreened copies are not sent.');
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
    while (next < work.length && Date.now() < deadline) {
      const key = work[next++]!, input = inputs.get(key)!;
      let row = rows.get(key)!;
      while (!row.judged) {
        const result = await screen.screenWindow(runtime, input, row.windows, call, key, charge);
        const winner = row.threshold === null || row.model === null ? result : screen.decisiveVerdict({ spam: row.spam, model: row.model, threshold: row.threshold }, result);
        const [moved] = (await runtime.db.execute<Row>(sql`UPDATE sending_campaign_screens SET windows=windows+1,spam=${winner.spam},model=${winner.model},threshold=${winner.threshold},
          judged_at=CASE WHEN windows+1>=requests THEN clock_timestamp() END
          WHERE campaign_id=${ref.campaignId} AND copy_hash=${key} AND windows=${row.windows}
          RETURNING ${fields}`)).rows;
        row = moved ?? (await runtime.db.execute<Row>(sql`SELECT ${fields} FROM sending_campaign_screens WHERE campaign_id=${ref.campaignId} AND copy_hash=${key}`)).rows[0]!;
      }
      rows.set(key, row);
    }
  }));
  return keys.map(key => {
    const refused = refusals.get(key);
    if (refused) return { refused };
    const row = rows.get(key);
    return row?.judged && row.threshold !== null && row.model !== null ? { key, spam: row.spam, model: row.model, threshold: row.threshold } : null;
  });
}
/** The unsubscribe link Nightmail generates for one recipient (src/audience/unsubscribe.ts createUnsubscribeLink): the copy's link
 *  host (`origin`), `/unsubscribe/u_` and 64 lowercase hex digits, and nothing else. */
export function generatedUnsubscribeUrl(origin: string, value: string): string {
  const prefix = `${origin.replace(/\/$/, '')}/unsubscribe/u_`;
  if (!value.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(value.slice(prefix.length))) throw new ApiError(409, 'UNSUBSCRIBE_LINK_INVALID', 'The unsubscribe link of this message is not one this installation generated. No provider attempt was made.');
  return value;
}
/**
 * A campaign copy as it is keyed and screened (src/screen.ts copyKey): the customer's copy byte for byte, with the slots
 * Nightmail adds to it (the unsubscribe footer's link and the List-Unsubscribe headers, marketingFooter) generated for
 * the placeholder link. The copy is delivered with the same slots generated for the recipient's own link
 * (withUnsubscribe), from the same customer copy, so the two differ only there: nothing is ever found or replaced in the
 * customer's content, and the customer's bytes, whatever they hold, are part of the key.
 */
export function screenedAs(runtime: Runtime, customer: EmailSnapshot, footer: Footer = {}): EmailSnapshot {
  const copy = { ...customer, headers: [...customer.headers] };
  marketingFooter(copy, unsubscribePlaceholder(keyedOrigin(runtime, footer)), footer);
  return copy;
}
/** A campaign copy as delivered: the customer's copy with the footer and headers generated for the recipient's link. */
export function withUnsubscribe(runtime: Runtime, customer: EmailSnapshot, url: string, footer: Footer = {}): EmailSnapshot {
  const copy = { ...customer, headers: [...customer.headers] };
  marketingFooter(copy, generatedUnsubscribeUrl(keyedOrigin(runtime, footer), url), footer);
  return copy;
}
export const SCREEN_AHEAD = 2000, SCREEN_PAGE = 500, SCREEN_BUDGET_MS = 8000, SCREEN_CONCURRENCY = 4, SCREEN_BYTES_IN_FLIGHT = 8 * 1024 * 1024;
const screenBackoff = (failures: number) => new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures, 5))).toISOString();
export async function saveScreen(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen) {
  await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen=${JSON.stringify(state)}::jsonb WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId}`);
  return state;
}
// A classifier outage waits in place, longer each time in a row; nothing is released without a verdict.
async function screenOutage(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen, error: unknown): Promise<never> {
  if (!(error instanceof ApiError) || error.code !== 'CONTENT_SCREEN_UNAVAILABLE') throw error;
  await saveScreen(runtime, a, row, { ...state, failures: state.failures + 1 });
  log('warn', { code: error.code, campaignId: row.id, failures: state.failures + 1 });
  throw new JobDeferred(screenBackoff(state.failures));
}
const screenRef = (a: Actor, row: RunRow): CampaignScreenRef => ({ workspaceId: a.workspaceId, campaignId: row.id, reviewId: row.reviewId! });
// preparing, before any recipient: the campaign's own copy, placeholders unresolved, is screened first as an early
// refusal, and the review gets its budget: enough requests to screen every recipient's copy on its own, and a few retries.
export async function screenCampaignStep(runtime: Runtime, a: Actor, row: RunRow) {
  const limits = runtime.config.screenLimits, screen = await loadScreen();
  const rules = campaignRules(runtime, row), fresh: CampaignScreen = { contentHash: row.review.hash, probation: rules === 'probation', template: null, screenedThrough: 0, recipients: 0, rejected: 0, failures: 0, quarantined: false };
  const state = currentScreen(row) ?? await saveScreen(runtime, a, row, fresh);
  await runtime.db.execute(sql`UPDATE sending_campaign_reviews SET screen_budget=${(Math.max(row.total, 1) + 10) * screen.chunksFor(limits.campaignBytes)} WHERE workspace_id=${a.workspaceId} AND id=${row.reviewId} AND screen_budget IS NULL`);
  const own = await campaignCopy(runtime, row.review.draft, row.review.rendered, row.review.version);
  let verdict: CopyVerdict;
  try { [verdict] = await campaignVerdicts(runtime, screenRef(a, row), [rules ? (await import('../screened-html.js')).hostedCopy(own, rules === 'probation') : own], Date.now() + SCREEN_BUDGET_MS); }
  catch (error) { return screenOutage(runtime, a, row, state, error); }
  if (!verdict) return;
  if ('refused' in verdict) throw verdict.refused;
  const done = await saveScreen(runtime, a, row, { ...state, template: verdict, failures: 0 });
  log('info', { code: 'CAMPAIGN_TEMPLATE_SCREENED', campaignId: row.id, spam: verdict.spam, model: verdict.model, threshold: verdict.threshold });
  if (verdict.spam >= verdict.threshold) await campaignRejected(runtime, a, row, done);
}
// sending, before a release: the next recipients' copies are rendered as delivered and screened, each distinct one
// once, and the release never goes past the last recipient whose copy has a verdict (dispatch refuses a copy the screen
// refused, and screens on its own any copy without a verdict). Copies stream through a few at a time, as many as fit
// SCREEN_BYTES_IN_FLIGHT by their prepared size (snapshot_bytes, and the size each copy actually rendered at), and only
// a digest of each is kept. The completed prefix is checkpointed about every second; the time budget is checked after
// each group, so a pass always gets at least one copy through however long it takes.
export async function screenAhead(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen, through: number): Promise<CampaignScreen> {
  const { draft, rendered, version } = row.review, started = Date.now(), ref = screenRef(a, row), screen = await loadScreen();
  const assets = await attachmentRows(runtime.db, a, draft.attachments);
  const probationCopy = campaignRules(runtime, row) === 'probation' ? (await import('../screened-html.js')).probationCopy : undefined;
  // Copies that are the same up to their recipient share one screen: by a digest of the copy, never the copy itself.
  const forms = new Map<string, Promise<CopyVerdict>>();
  const verdictOf = async (recipient: ReviewedRecipient) => {
    const keyed = screenedAs(runtime, await campaignMessage(runtime, draft, recipient, false, assets, rendered, true, !rendered.html?.includes('{{'), version), draft);
    // The copy as the dispatcher keys it (probation senders' rewritten, src/dispatcher.ts prepareMail).
    const copy = probationCopy ? probationCopy({ ...keyed, to: [] }) : { ...keyed, to: [] };
    const size = Buffer.byteLength(copy.html ?? '') + Buffer.byteLength(copy.text ?? ''), form = await screen.copyKey(runtime, copy);
    let verdict = forms.get(form);
    if (!verdict) { verdict = campaignVerdicts(runtime, ref, [copy], Number.POSITIVE_INFINITY).then(([one]) => one ?? null); forms.set(form, verdict); }
    return { verdict: await verdict, size };
  };
  let progress = state, judged: { email: string; rejected: number }[] = [], rejectedOrdinals: number[] = [], saved = Date.now(), largest = 0;
  // Reputation counts each recipient's verdict when the screen judged it, whether or not it is released; the dispatcher
  // doesn't count these copies again. Failing copies are marked screen_rejected so releaseStep never queues them.
  const checkpoint = async () => {
    if (rejectedOrdinals.length) {
      await runtime.db.execute(sql`UPDATE sending_review_recipients SET screen_rejected = true
        WHERE review_id = ${row.reviewId} AND ordinal = ANY(${sql.param(rejectedOrdinals)}::int[])`);
      rejectedOrdinals = [];
    }
    if (judged.length) await runtime.db.execute(countScreened(sql`SELECT ${a.workspaceId}::text AS workspace_id,x.rejected FROM jsonb_to_recordset(${JSON.stringify(judged)}::jsonb) x(email text,rejected int)
      WHERE hosted_real_cost(jsonb_build_array(x.email))>0`));
    judged = []; saved = Date.now();
    return saveScreen(runtime, a, row, progress);
  };
  try {
    pages: while (progress.screenedThrough < through) {
      const page = await recipientChunk(runtime.db, row.reviewId!, progress.screenedThrough, Math.min(SCREEN_PAGE, through - progress.screenedThrough));
      for (let next = 0; next < page.length;) {
        const group = [page[next]!];
        let bytes = Math.max(largest, Number(page[next]!.snapshot_bytes ?? 0));
        while (group.length < SCREEN_CONCURRENCY && next + group.length < page.length) {
          const more = Math.max(largest, Number(page[next + group.length]!.snapshot_bytes ?? 0));
          if (bytes + more > SCREEN_BYTES_IN_FLIGHT) break;
          bytes += more; group.push(page[next + group.length]!);
        }
        const results = await Promise.all(group.map(recipient => verdictOf(recipient.recipient)));
        let rejected = 0;
        for (const [i, { verdict, size }] of results.entries()) {
          largest = Math.max(largest, size);
          if (!verdict) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'A copy was left without a verdict.', undefined, true);
          const spamRefused = 'spam' in verdict && verdict.spam >= verdict.threshold;
          const refused = spamRefused || 'refused' in verdict;
          if (refused) {
            rejectedOrdinals.push(group[i]!.ordinal);
            if (spamRefused) rejected++;
          }
          if ('spam' in verdict) judged.push({ email: group[i]!.recipient.email, rejected: spamRefused ? 1 : 0 });
        }
        progress = { ...progress, screenedThrough: group.at(-1)!.ordinal, recipients: progress.recipients + group.length, rejected: progress.rejected + rejected, failures: 0 };
        next += group.length;
        if (Date.now() - started >= SCREEN_BUDGET_MS) break pages;
        if (Date.now() - saved >= 1000) await checkpoint();
      }
    }
  } catch (error) {
    await checkpoint();
    return screenOutage(runtime, a, row, progress, error);
  }
  return checkpoint();
}
export async function campaignRejected(runtime: Runtime, a: Actor, row: RunRow, state: CampaignScreen): Promise<never> {
  await runtime.db.execute(countScreened(sql`SELECT v.workspace_id,1 AS rejected FROM sending_campaign_reviews v JOIN sending_review_recipients r ON r.review_id=v.id
    WHERE v.workspace_id=${a.workspaceId} AND v.id=${row.reviewId} AND hosted_real_cost(jsonb_build_array(r.recipient->>'email'))>0`));
  log('warn', { code: 'CONTENT_REJECTED_SPAM', campaignId: row.id, spam: state.template?.spam, model: state.template?.model });
  throw new ApiError(422, 'CONTENT_REJECTED_SPAM', 'The content classifier judged this campaign to be deceptive or harmful. No recipient was sent to.');
}
