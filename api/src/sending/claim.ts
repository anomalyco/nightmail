import { sql, type SQL } from 'drizzle-orm';
import type { SESv2Client, Attachment, SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { ApiError, logError, databaseConflict, transientDatabaseError } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { rowId } from '../core/http.js';
import { log } from '../log.js';
import type { Runtime, DbExecutor } from '../core/types.js';
import { type EmailSnapshot, type CampaignDraft, type ReviewedRecipient, attachments, type EmailStatus } from '../db/sending.js';
import { checkedDispatchAttachments, originAllowed, approvedOriginUser, statusForEvent, rank, publicEventType, queueSimulatedFeedback } from './events.js';
import { resolveHostedContentPolicy, sharedFormatRefusal, verifiedAttachment, sizeCheck, inlineMessage } from './mime.js';
import { materializeCampaignEmail } from '../campaigns/materialize.js';
import { recipientIneligibleReasonSql } from './front-door.js';
import { type TenantState, pauseCampaign, terminalColumns, terminalEvents, finishCampaigns, reopenQueuedCampaigns, operationWebhookFanoutCtes, simulatedFeedbackCtes } from '../states.js';
import { receivingPolicy } from '../mailbox-ingest-input.js';
import { tieAllows } from '../approval-ties.js';
import { principal } from '../mail-gateway.js';
import { sendingConnections, regionalSender, verifiedClaim } from '../domain-claims.js';
import { claimsOnly } from '../send-scope.js';
import { heldStream, probationReason } from '../hosted-sending.js';
import { credentialFingerprint, discoveryTarget } from '../ses-region-state.js';
import { setupResources, POOL_INSTALLATION, mxResourceName } from '../ses-setup.js';
import { type ReadyConnection, forDelivery } from '../provider-credentials.js';
import { wakeWebhooks } from '../jobs.js';
import type { CampaignScreen } from '../screen.js';
import { SEND_LIMITS } from '../send-limits.js';
import { linkInlineImages } from '../linked-images.js';
import { servedDomains } from '../brand.js';
import { type DispatchTransport, type GateState, type Leased, mailColumns, type Owner, type Review, type Mail, INLINE_SNAPSHOT_BYTES, type LeaseQuota, type Prepared, CLAIM_LOCK_MS, CLAIM_BUSY_MS, type Outcome, requeued, rankJson, sleep } from './quota.js';

// One statement leases the oldest due mail for this region and returns it with its frozen review inputs.
export type DeferredStream = { workspace_id: string; stream: EmailSnapshot['kind']; until?: number };
// Recipients an envelope may still have to be affordable, per stream (at most 50 per envelope); `customer` is an outside
// workspace's marketing, under the customer share as well.
export type Allowance = { transactional: number; marketing: number; customer: number };
export const MAX_ENVELOPE = 50;
export async function leaseDue(runtime: Runtime, transport: DispatchTransport, region: string, limit: number, gate:GateState, deferred: DeferredStream[], runClients: Map<string, SESv2Client>, accountId?: string, priorityOnly = false, readQuota = false, allowance?: Allowance): Promise<Leased[]> {
  const queued = sql`region = ${region} AND status = 'queued' AND screened`;
  const available = sql`(lease_until IS NULL OR lease_until < statement_timestamp())`;
  const transactional = sql`(e.snapshot->>'kind' = 'transactional')`;
  const priority = sql`ORDER BY ${transactional} DESC, created_at, id`;
  const mx=runtime.config.multiTenant, liveMx=mx && !isSimulatedSes(runtime);
  const cost=sql`jsonb_array_length(e.to_addresses||e.cc_addresses||e.bcc_addresses)`;
  const domain=sql`lower(split_part(e.from_address,'@',2))`;
  const tick=sql`date_trunc('minute',statement_timestamp())`;
  // A marketing hold leaves the held stream queued (heldStream); transactional mail keeps flowing.
  const dueForOwner = sql`FROM sending_emails e WHERE ${queued} AND e.workspace_id = o.workspace_id AND ${available} AND (NOT o.marketing_held OR NOT ${heldStream(sql`e`)})
    -- A boolean range is an index condition on 061's expression. Equality to true is
    -- simplified to a text comparison and can scan the kind index over delivered mail.
    ${priorityOnly ? sql`AND ${transactional} > false` : sql``}
    ${allowance && Object.values(allowance).some(n => n < MAX_ENVELOPE) ? sql`AND ${cost} <= CASE WHEN ${transactional} THEN ${allowance.transactional}::int WHEN o.customer THEN ${allowance.customer}::int ELSE ${allowance.marketing}::int END` : sql``}
    ${deferred.length ? sql`AND ${transactional} BETWEEN (o.workspace_id=ANY(${sql.param(deferred.filter(d=>d.stream==='marketing').map(d=>d.workspace_id))}::text[])) AND NOT (o.workspace_id=ANY(${sql.param(deferred.filter(d=>d.stream==='transactional').map(d=>d.workspace_id))}::text[]))` : sql``}`;
  // Look up each due stream separately: the immediate ordered index contains no future mail,
  // and the scheduled index can stop at this statement's cutoff. Merge only bounded pages.
  const page = (size: SQL, lock = false, exclude = sql``) => {
    const arm = (schedule: SQL) => sql`SELECT * FROM (SELECT e.id,${transactional} AS transactional,e.created_at ${dueForOwner}
      AND ${schedule} ${exclude} ${priority} LIMIT ${size} ${lock ? sql`FOR UPDATE SKIP LOCKED` : sql``}) arm`;
    return sql`SELECT * FROM (${arm(sql`scheduled_at IS NULL`)} UNION ALL ${arm(sql`scheduled_at <= statement_timestamp()`)}) streams
      ORDER BY transactional DESC,created_at,id LIMIT ${size}`;
  };
  // Always discover transactional owners first via the partial transactional index (sending_emails_tx_due) so a
  // password reset is never hidden behind ownerCursor or many active marketing campaigns. Marketing owners still rotate
  // via ownerCursor, and candidates rank transactional strictly ahead of marketing (round-robin within each stream).
  const deferredTx = deferred.filter(d => d.stream === 'transactional').map(d => d.workspace_id);
  const txOwners = sql`SELECT DISTINCT workspace_id FROM (
    SELECT workspace_id FROM sending_emails WHERE ${queued} AND (snapshot->>'kind') = 'transactional'
      AND (scheduled_at IS NULL OR scheduled_at <= statement_timestamp()) AND ${available}
      ${deferredTx.length ? sql`AND NOT (workspace_id = ANY(${sql.param(deferredTx)}::text[]))` : sql``}
    ORDER BY created_at, id LIMIT ${limit}
  ) t`;
  const seek=(after:SQL)=>sql`SELECT workspace_id FROM (
    (SELECT workspace_id FROM sending_emails WHERE ${queued} AND scheduled_at IS NULL AND workspace_id>${after} ORDER BY workspace_id LIMIT 1) UNION ALL
    (SELECT workspace_id FROM sending_emails WHERE ${queued} AND scheduled_at<=statement_timestamp() AND workspace_id>${after} ORDER BY workspace_id LIMIT 1)
    ) heads ORDER BY workspace_id LIMIT 1`;
  const queuedOwners = priorityOnly ? sql`SELECT NULL::text AS workspace_id, 0 AS step WHERE false` : sql`SELECT n.workspace_id,1 FROM (${seek(sql`${gate.ownerCursor??''}`)}) n
      UNION ALL SELECT n.workspace_id,o.step+1 FROM queued_owners o CROSS JOIN LATERAL (${seek(sql`o.workspace_id`)}) n WHERE o.step<${limit}`;
  const allOwners = sql`SELECT workspace_id FROM tx_owners ${priorityOnly ? sql`` : sql`UNION SELECT workspace_id FROM queued_owners`}`;
  const txUnheld = sql`(NOT ${heldStream(sql`e`)})`;
  // Transactional has buckets of its own only where marketing paces at the full pool rate (owners.split_tx, migration 457).
  const split = sql`(o.split_tx AND ${txUnheld})`;
  const ownersSql = mx ? sql`SELECT q.workspace_id,hosted_marketing_held(q.workspace_id) AS marketing_held,${liveMx?sql`(pc.kind='shared' AND NOT w.exempt_hosted_quotas)`:sql`false`} AS customer ${liveMx?sql`,p.cap,p.tx_cap,coalesce(p.pool_paced AND g.key IS NULL,false) AS split_tx,p.cap-coalesce(bm.used,0) AS mkt_remaining,p.tx_cap-coalesce(bt.used,0) AS tx_remaining,g.cap-g.used AS growth_left,pc.kind='shared' AS required_screen,
    (${!!runtime.config.trustedPool} AND pc.pool_tier='trusted' AND NOT pc.legacy_names) AS trusted`:sql``}
    FROM all_owners q JOIN ${sendingConnections(runtime)} pc USING(workspace_id)
    ${liveMx?sql`LEFT JOIN workspaces w ON w.id=q.workspace_id
      LEFT JOIN hosted_burst_windows bm ON bm.workspace_id=q.workspace_id AND bm.scope='' AND bm.minute=${tick}
      LEFT JOIN hosted_burst_windows bt ON bt.workspace_id=q.workspace_id AND bt.scope='#tx' AND bt.minute=${tick}
      CROSS JOIN LATERAL (SELECT CASE WHEN pc.kind='shared' AND NOT w.exempt_hosted_quotas THEN hosted_minute_cap(q.workspace_id) END AS cap,
        CASE WHEN pc.kind='shared' AND NOT w.exempt_hosted_quotas THEN hosted_tx_minute_cap(q.workspace_id) END AS tx_cap,
        coalesce(pc.kind='shared' AND NOT w.exempt_hosted_quotas AND hosted_pool_paced(q.workspace_id),false) AS pool_paced) p
      -- A new sender's growth pace (sponsor-wide rolling hour): an owner it has used up is not leased, so nothing is prepared or screened for it.
      LEFT JOIN LATERAL hosted_growth(q.workspace_id) g ON pc.kind='shared'`:sql``}
    WHERE pc.region=${region} AND pc.aws_account_id=${accountId} AND pc.paused_at IS NULL AND hosted_sponsor_hold(q.workspace_id) IS DISTINCT FROM 'pause'
      ${liveMx?sql`AND (p.cap IS NULL OR p.cap-coalesce(bm.used,0)>0 OR (p.pool_paced AND g.key IS NULL AND p.tx_cap-coalesce(bt.used,0)>0)) AND (g.key IS NULL OR g.cap-g.used>0)`:sql``}` : sql`SELECT workspace_id,false AS marketing_held,false AS customer FROM all_owners`;
  const result = await runtime.db.execute<Record<string, unknown>>(sql`WITH RECURSIVE queued_owners(workspace_id,step) AS (${queuedOwners}), tx_owners AS (${txOwners}), all_owners AS (${allOwners}), owners AS MATERIALIZED (${ownersSql}), candidates AS (
      SELECT o.workspace_id, row_number() OVER (ORDER BY q.transactional DESC, q.turn, q.created_at, q.id) AS place FROM owners o CROSS JOIN LATERAL (
        SELECT p.*,row_number() OVER (ORDER BY transactional DESC,created_at,id) AS turn FROM (${page(sql`${limit}`)}) p
      ) q
    ), shares AS MATERIALIZED (
      SELECT workspace_id, count(*) AS candidates, count(*) FILTER (WHERE place <= ${limit}) AS slots, min(place) AS first_place
      FROM candidates GROUP BY workspace_id ORDER BY min(place)
    ), allocated AS MATERIALIZED (
      -- Allocate slots in priority order (transactional owners first, then round-robin marketing).
      -- Lock the next available rows in index order; later owners can fill slots skipped under contention.
      SELECT o.workspace_id, e.id FROM (SELECT o.*, sh.slots FROM owners o JOIN shares sh USING(workspace_id) WHERE sh.slots > 0 ORDER BY sh.first_place) o CROSS JOIN LATERAL (
        ${page(sql`o.slots`,true)}
      ) e LIMIT ${limit}
    ), picks AS (
      -- Consume the fair allocation first. A full lease skips the fallback; a short one only
      -- revisits owners with candidates beyond their share. Our own locks are not SKIPped.
      SELECT workspace_id, id FROM allocated UNION ALL
      SELECT o.workspace_id, e.id FROM (SELECT o.* FROM owners o JOIN shares sh USING(workspace_id) WHERE sh.candidates > sh.slots ORDER BY sh.first_place) o CROSS JOIN LATERAL (
        ${page(sql`${limit}`,true,sql`AND e.id NOT IN (SELECT id FROM allocated)`)}
      ) e LIMIT ${limit}
    ) ${liveMx ? sql`, fit AS MATERIALIZED (
      SELECT p.*,e.snapshot->>'kind' AS stream,${txUnheld} AS tx_unheld,
        CASE WHEN ${split} THEN o.tx_cap ELSE o.cap END AS eff_cap,
        CASE WHEN ${split} THEN o.tx_remaining ELSE o.mkt_remaining END AS eff_remaining,
        o.growth_left,d.used,c.n,
        sum(c.n) OVER (PARTITION BY p.workspace_id,${split} ORDER BY ${transactional} DESC,e.created_at,p.id) AS total,
        sum(c.n) OVER (PARTITION BY p.workspace_id,${split},${domain} ORDER BY ${transactional} DESC,e.created_at,p.id) AS subtotal,
        sum(c.n) OVER (PARTITION BY p.workspace_id ORDER BY ${transactional} DESC,e.created_at,p.id) AS growth_total
      FROM picks p JOIN owners o USING(workspace_id) JOIN sending_emails e USING(workspace_id,id)
      CROSS JOIN LATERAL (SELECT ${cost} AS n) c LEFT JOIN hosted_burst_windows d ON d.workspace_id=p.workspace_id AND d.scope=CASE WHEN ${split} THEN '#tx:'||${domain} ELSE ${domain} END AND d.minute=${tick}
      )`:sql``}, due AS MATERIALIZED (${liveMx ? sql`SELECT workspace_id,id FROM fit WHERE (growth_left IS NULL OR growth_total<=growth_left) AND (eff_cap IS NULL OR n=0 OR (total<=eff_remaining AND subtotal<=greatest(50,eff_cap/2)-coalesce(used,0)))` : sql`SELECT * FROM picks`}
    ), selected AS MATERIALIZED (
      UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes' FROM due WHERE e.workspace_id = due.workspace_id AND e.id = due.id RETURNING e.*
    ), settings AS MATERIALIZED (
      SELECT p.*, s.installation_id, s.default_region, s.enabled_regions, ${mx ? sql`to_jsonb(pc)` : sql`NULL`} AS connection,
        ${liveMx ? sql`${probationReason(sql`p.workspace_id`)} IS NOT NULL` : sql`false`} AS probation,
        (SELECT o.customer FROM owners o WHERE o.workspace_id=p.workspace_id) AS customer,
        ${readQuota ? sql`(SELECT jsonb_build_object('rate',max_send_rate,'max',max_24_hour_send,'sent',sent_last_24_hours,'customer',${accountId ? sql`customer_sent_24_hours` : sql`0`},'checked',checked_at::text,
          'age_ms',extract(epoch FROM clock_timestamp()-checked_at)*1000)
          FROM ${accountId ? sql`provider_account_limits WHERE aws_account_id=${accountId}` : sql`sending_region_limits WHERE workspace_id=p.workspace_id`}
          AND region=${region} AND max_send_rate>0 AND isfinite(checked_at))` : sql`NULL`} AS quota_sample,
        ${mx || isSimulatedSes(runtime) ? sql`true` : sql`(
        d.report->'provisioned' = 'true'::jsonb AND d.report #> '{account,sendingEnabled}' = 'true'::jsonb
        AND d.credentials_fingerprint = ${await credentialFingerprint(runtime.config)} AND d.public_url = ${discoveryTarget(runtime.config)}
        AND d.trusted_account_id = d.report #>> '{account,id}' AND d.trusted_topic_arn = d.report #>> '{resources,topic,arn}'
        AND d.report->'resources'->p.stream->'sendingEnabled' = 'true'::jsonb)`} AS ready
      FROM (SELECT DISTINCT workspace_id, snapshot->>'kind' AS stream FROM selected) p
      LEFT JOIN ses_installation_settings s USING (workspace_id)
      ${mx ? sql`JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id=p.workspace_id AND pc.region=${region} AND pc.aws_account_id=${accountId}` : !isSimulatedSes(runtime) ? sql`LEFT JOIN ses_region_discovery d ON d.workspace_id = p.workspace_id AND d.region = ${region}` : sql``}
    ), reviews AS (
      SELECT carrier, r.renderer_version, r.draft, r.rendered, r.screen, r.content_hash,
        (SELECT jsonb_agg(jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'filename',a.filename,'contentType',a.content_type,'size',a.size,
          'disposition',a.disposition,'contentId',a.content_id,'storageKey',a.storage_key,'checksum',a.checksum,'sourceTemplateAssetId',a.source_template_asset_id,'createdAt',a.created_at) ORDER BY a.id)
         FROM sending_attachments a WHERE a.workspace_id=r.workspace_id AND a.id IN (SELECT jsonb_array_elements_text(r.draft->'attachments'))) AS assets FROM (
        SELECT workspace_id, campaign_id, review_id, min(id) AS carrier FROM selected WHERE review_id IS NOT NULL GROUP BY 1,2,3
      ) refs JOIN sending_campaign_reviews r ON r.workspace_id=refs.workspace_id AND r.campaign_id=refs.campaign_id AND r.id=refs.review_id
    )
    SELECT meta.cursor,${liveMx?sql`(SELECT jsonb_agg(to_jsonb(blocked)) FROM (SELECT DISTINCT workspace_id,stream FROM fit WHERE eff_cap IS NOT NULL AND n>0 AND (coalesce(used,0)+n>greatest(50,eff_cap/2) OR eff_remaining<n OR (growth_left IS NOT NULL AND growth_left<n))) blocked)`:sql`NULL`} AS blocked_streams,${sql.join(mailColumns, sql`, `)}, measured.bytes AS snapshot_bytes, s.installation_id, s.default_region, s.enabled_regions, s.ready, s.connection,s.quota_sample,s.probation AS on_probation,s.customer AS outside,
      CASE WHEN leased.dispatch_version > 0 THEN (SELECT count(*)::int FROM sending_email_events v
        WHERE v.workspace_id=leased.workspace_id AND v.email_id=leased.id AND v.type='provider_throttled' AND v.data->>'code'='SES_THROTTLED') ELSE 0 END AS rate_retries,
      r.renderer_version AS review_version, r.draft AS review_draft, r.rendered AS review_rendered,r.assets AS review_assets, r.screen AS review_screen, r.content_hash AS review_hash,
      -- A campaign copy's recipient, looked up only for campaign mail: a join here let the planner scan the whole
      -- table's index for every leased row when its statistics said it was empty.
      CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.content_hash FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_content_hash,
      CASE WHEN leased.review_id IS NOT NULL THEN (SELECT x.recipient FROM sending_review_recipients x WHERE x.review_id = leased.review_id AND x.ordinal = leased.review_ordinal) END AS review_recipient
    FROM selected leased
    CROSS JOIN LATERAL (SELECT octet_length(leased.snapshot::text) AS bytes OFFSET 0) measured
    JOIN settings s ON s.workspace_id = leased.workspace_id AND s.stream = leased.snapshot->>'kind'
    LEFT JOIN reviews r ON r.carrier = leased.id
    -- Keep the cursor only if an owner has queued mail after it: otherwise the next lease starts
    -- from the first owner instead of finding nothing past the last one.
    RIGHT JOIN (${priorityOnly ? sql`SELECT ${gate.ownerCursor ?? null}::text AS cursor` : sql`SELECT CASE WHEN EXISTS (${seek(sql`m.cursor`)}) THEN m.cursor END AS cursor
      FROM (SELECT max(workspace_id) FILTER(WHERE step=${limit}) AS cursor FROM queued_owners) m`}) meta ON true
    ORDER BY (leased.snapshot->>'kind' = 'transactional') DESC, leased.created_at, leased.id`);
  gate.ownerCursor=result.rows[0]?.cursor as string || undefined;
  for(const d of (result.rows[0]?.blocked_streams??[]) as DeferredStream[]) deferBurst(deferred,d.workspace_id,d.stream);
  if (!result.rows[0]?.id) return [];
  const owners = new Map<string, Owner>();
  const reviews = new Map<string, Pick<Review, 'version' | 'draft' | 'rendered' | 'assets' | 'screen' | 'reviewHash'>>();
  const reviewKey = (row: Record<string, unknown>) => JSON.stringify([row.workspaceId, row.campaignId, row.reviewId]);
  for (const row of result.rows) if (row.review_draft && row.review_rendered) {
    reviews.set(reviewKey(row), { version:Number(row.review_version), draft: row.review_draft as CampaignDraft, rendered: row.review_rendered as Review['rendered'],assets:(row.review_assets??[]) as AttachmentRow[], screen: row.review_screen as CampaignScreen | null, reviewHash: row.review_hash as string });
  }
  return result.rows.map(row => {
    const { review_version, review_draft, review_rendered, review_content_hash, review_recipient, review_screen, review_hash, installation_id, default_region, enabled_regions, ready:regionReady, connection, rate_retries, quota_sample, on_probation, outside, ...fields } = row;
    void review_version; void review_screen; void review_hash;
    // Admission refuses hosted sends until the tenant is ready; mail admitted earlier waits here, never provisions.
    const pc0 = connection as (ReadyConnection & { tenant_state?: TenantState; paused_at?: string | null }) | null;
    const ready = regionReady && !pc0?.paused_at && !(mx && !isSimulatedSes(runtime) && pc0?.kind === 'shared' && pc0.tenant_state !== 'ready');
    const mail = fields as Mail, { workspaceId } = mail;
    if (installation_id == null) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
    let owner = owners.get(workspaceId);
    if (!ready) {
      const stream = mail.snapshot.kind;
      if (!deferred.some(d => d.workspace_id === workspaceId && d.stream === stream)) {
        deferred.push({ workspace_id: workspaceId, stream });
        log('warn', { code: 'SES_SETUP_REQUIRED', workspaceId, region, stream });
      }
    } else if (!owner) {
      const pc = connection as (ReadyConnection & { feedback_topic_arn: string }) | undefined;
      const namespace=pc?.legacy_names===false ? pc.kind==='shared' ? pc.pool_tier : 'byo' : undefined;
      const { transactional, marketing } = setupResources(pc?.kind === 'shared' ? POOL_INSTALLATION : pc?.id ?? installation_id as string,namespace);
      const scoped = { ...runtime, config: { ...runtime.config, workspaceId, regions: [default_region as string, ...(enabled_regions as string[]).filter(r => r !== default_region),...(pc?[region]:[])], configurationSets: { transactional, marketing } } };
      owner = { runtime: scoped, poolTier: pc?.pool_tier, legacyNames: pc?.legacy_names, probation:on_probation===true, customer:outside===true, a: { workspaceId, keyId: 'worker', domains: [], permissions: ['manage'] }, transport, ses: transport.clientFor(scoped, region, forDelivery(pc,{purpose:'quota'}), runClients),
        sendClient:pc?.template_version==='v5'?domainId=>transport.clientFor(scoped,region,forDelivery(pc,{purpose:'send',domainId}),runClients):undefined,
        tenantName: pc?.kind === 'shared' ? pc.pool_tenant_name ?? (pc.managed_tenant ? mxResourceName(workspaceId) : `bane-${workspaceId}`) : undefined, feedbackTopic: pc?.feedback_topic_arn };
      owners.set(workspaceId, owner);
    }
    const shared = mail.reviewId && reviews.get(reviewKey(row));
    if(mail.snapshot.deferredCampaign) mail.snapshot={...mail.snapshot,from:mail.from,to:mail.to,cc:mail.cc,bcc:mail.bcc,region:mail.region,subject:mail.subject,attachments:shared?shared.draft.attachments:mail.snapshot.attachments??[],binding:shared?shared.draft.binding:mail.snapshot.binding};
    return { mail, contentBytes: Number(row.snapshot_bytes) > INLINE_SNAPSHOT_BYTES ? Number(row.snapshot_bytes) : 0, owner: ready ? owner! : null, rateRetries: Number(rate_retries), quota: quota_sample as LeaseQuota | undefined, review: shared && review_recipient ? { ...shared, contentHash: review_content_hash as string | null, recipient: review_recipient as ReviewedRecipient } : null, trace: { leasedAt: Date.now() } };
  });
}



export type AttachmentRow = typeof attachments.$inferSelect;
function simpleContent(s: EmailSnapshot, parts: Attachment[]): SendEmailCommandInput['Content'] {
  return { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } };
}
export function batchAttachments(runtime: Runtime, batch: Leased[]) {
  // Campaign metadata travels once per review in the lease (on its carrier row),
  // not once per envelope or in a second query per page. Bodies stay in storage.
  const reviewed=new Map(batch.filter(x=>x.review).map(x=>[x.mail.reviewId!,x.review!.assets]));
  const wanted = batch.filter(x=>!x.review).flatMap(({ mail }) => mail.snapshot.attachments.map(id => ({ workspace_id: mail.workspaceId, id })));
  let rows: Promise<AttachmentRow[]> | undefined;
  return async (mail: Mail) => {
    if (!mail.snapshot.attachments.length) return [];
    if(mail.reviewId && reviewed.has(mail.reviewId))return reviewed.get(mail.reviewId)!;
    rows ??= runtime.db.select().from(attachments).where(sql`(${attachments.workspaceId}, ${attachments.id}) IN (SELECT workspace_id, id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS x(workspace_id text, id text))`).orderBy(attachments.id).execute();
    return (await rows).filter(row => row.workspaceId === mail.workspaceId && mail.snapshot.attachments.includes(row.id));
  };
}
export class HeldForScreen extends Error { constructor() { super('Queued without a screen verdict.'); this.name = 'HeldForScreen'; } }
export async function prepareMail(leased: Leased & { owner: Owner }, loadAttachments: (mail: Mail) => Promise<AttachmentRow[]>): Promise<Prepared> {
  const { runtime, a } = leased.owner;
  let mail = leased.mail;
  if (mail.simulated && !isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'This message was queued for simulated delivery. Submit it again to send through SES.');
  const policy = resolveHostedContentPolicy(runtime.config, {
    shared: !!leased.owner.tenantName, poolTier: leased.owner.poolTier, legacyNames: leased.owner.legacyNames,
    from: mail.from, probation: !!leased.owner.probation, simulated: isSimulatedSes(runtime), kind: mail.snapshot.kind, screen: mail.snapshot.screen,
  });
  // Mail queued before screen-at-accept (migration 459), or by an older isolate during the rollout, has no verdict. It never
  // goes out unscreened: it leaves the mail room's queue (screened = false) for the screen sweep.
  if (policy.screened && !mail.snapshot.screenVerdict) throw new HeldForScreen();
  let rows: AttachmentRow[] | undefined;
  let unsubscribe: Prepared['unsubscribe'];
  let stored: Prepared['stored'];
  if (mail.snapshot.deferredCampaign) {
    const materialized = await materializeCampaignEmail(runtime, a, mail, leased.review, await loadAttachments(mail));
    mail = materialized.mail; rows = materialized.rows; unsubscribe = materialized.unsubscribe; stored = materialized.stored;
  }
  let s = mail.snapshot;
  const refusal = sharedFormatRefusal(s, policy);
  if (refusal) throw refusal;
  // Content screening runs at accept time / campaign prepare (src/sending/front-door.ts) before rows enter sending_emails; the mail
  // room never calls an external classifier. Deferred campaigns and any pre-deploy rows still apply local in-memory
  // hostedCopy / attachment checks here.
  const { rules } = policy;
  const delivery=rules ? await import('../screened-html.js') : undefined;
  if (delivery && (mail.snapshot.deferredCampaign || s.screenVerdict?.rules !== rules)) s = delivery.hostedCopy(s, rules==='probation');
  let parts: Attachment[] = [];
  rows ??= checkedDispatchAttachments(s.attachments, await loadAttachments(mail));
  const files: { row: AttachmentRow; bytes: Uint8Array }[] = [];
  for (const row of rows) {
    const body = await verifiedAttachment(runtime, row);
    files.push({ row, bytes: body });
    // A probation attachment goes out under a name a client shows as is, as a type its extension and bytes agree with;
    // any other sender's is checked only for pictures (no SVG, inline parts as raster images); a mail app's goes out as
    // what its bytes are (screened-html.ts hostedAttachment). A part that can't be inline goes out as an ordinary
    // attachment, without the Content-ID its HTML could show it by.
    const shown = delivery ? delivery.hostedAttachment(row, body, rules==='probation', !!s.mailApp) : { filename: row.filename, contentType: row.contentType, inline: row.disposition === 'inline' };
    const contentId = row.contentId && (shown.inline || row.disposition !== 'inline') ? row.contentId : undefined;
    parts.push({ FileName: shown.filename, RawContent: body, ContentType: shown.contentType, ContentDisposition: shown.inline ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(contentId ? { ContentId: contentId } : {}) });
  }
  // A campaign's mail, and its test, links its inline pictures from the host of its links (s.linkOrigin: the link domain on
  // Hosted, PUBLIC_URL without link hosts) rather than carrying them, after the checks above (src/linked-images.ts). Never
  // from Hosted's own domain (src/link-domains.ts never gives it one); without an origin they stay attached. An email sent
  // through the API keeps the parts its caller attached.
  const imageOrigin = s.linkOrigin && !(runtime.config.multiTenant && servedDomains.includes(new URL(s.linkOrigin).hostname)) ? s.linkOrigin : undefined;
  if (runtime.config.linkedImages && imageOrigin && s.html && !s.mime && !s.raw && (mail.campaignId || s.testCampaignId) && rows.some(row => row.disposition === 'inline')) {
    const { html, linked } = linkInlineImages(imageOrigin, s.html, files);
    if (linked.size) {
      // A test's pictures on the link domain: its use lets the link domain serve them (a campaign's release records its own).
      const host = new URL(imageOrigin).hostname;
      if (s.testCampaignId && host === runtime.config.linkHost) await (await import('../link-domains.js')).recordLinkUse(runtime.db, a.workspaceId, host, 0);
      s = { ...s, html };
      parts = parts.filter((_, i) => !linked.has(files[i]!.row.id));
      rows = rows.filter(row => !linked.has(row.id));
    }
  }
  sizeCheck(s, rows);
  const content: SendEmailCommandInput['Content'] = s.mime || s.raw
    ? { Raw: { Data: new TextEncoder().encode(s.mime ?? s.raw) } }
    // Inline images are built as multipart/related raw MIME (Simple places them beside the body). Raw MIME is
    // base64-encoded again inside SES's JSON body, about 3.2 times the files at once, so a message with more than the
    // lane budget of files goes as Simple content, as Hosted mail always does.
    : !leased.owner.tenantName && s.html && parts.some(part => part.ContentDisposition === 'INLINE') && rows.reduce((n, row) => n + row.size, 0) <= SEND_LIMITS.laneBytes
      ? { Raw: { Data: inlineMessage(s, parts) } }
      : simpleContent(s, parts);
  return { ...leased, mail, snapshot: s, content, unsubscribe, stored };
}

// Preflight failures (storage, rendering, hash mismatch) cannot have sent email: reject the row.
export async function rejectPreflight(runtime: Runtime, mail: Mail, error: unknown): Promise<'deferred' | 'rejected'> {
  const known = error instanceof ApiError;
  const code = known ? error.code : 'DISPATCH_PREFLIGHT_FAILED';
  const retryable = known ? error.retryable : true;
  if (retryable) {
    // Transient dependency failure (or unknown future content-hash format on rollback): keep the recipient queued
    // instead of rejecting/burning it. On CAMPAIGN_HASH_FORMAT_UNSUPPORTED, pause the parent campaign loudly too.
    // A missing or changed attachment gets 4 tries 15 s apart; an unexpected exception (a bug, most likely) 8 tries
    // from 15 s doubling, jittered, about an hour, each logged with its stack. Both count in attachment_failures.
    const missing = code === 'ATTACHMENT_STORAGE_UNAVAILABLE';
    const unsupportedHash = code === 'CAMPAIGN_HASH_FORMAT_UNSUPPORTED';
    const counted = missing || !known, tries = missing ? 4 : 8;
    const backoff = unsupportedHash ? sql`60` : known ? sql`15` : sql`15 * 2 ^ least(attachment_failures, 7) * (0.75 + random() / 2)`;
    if (!known) logError(error, { code, emailId: mail.id }, 'warn');
    const retry = await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = NULL, attachment_failures=attachment_failures+${counted?1:0}::smallint, scheduled_at = greatest(coalesce(scheduled_at, clock_timestamp()), clock_timestamp() + make_interval(secs => ${backoff})), error_code = ${code}, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} ${counted?sql`AND attachment_failures<${tries}`:sql``}`);
    if (unsupportedHash && mail.campaignId) {
      const msg = error instanceof ApiError ? error.message : 'Paused: this campaign uses a newer content hash format that this release cannot verify.';
      await runtime.db.execute(pauseCampaign({ workspaceId: mail.workspaceId, id: mail.campaignId }, { code, message: msg })).catch(() => {});
    }
    if (!counted || retry.rowCount) { if (known) log('warn', { code, emailId: mail.id, message: 'Dispatch preflight failed; retrying after a short delay.' }); return 'deferred'; }
  }
  const rejected=await runtime.db.execute<{n:number}>(sql`WITH rejected AS (
      UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} RETURNING ${terminalColumns},to_addresses||cc_addresses||bcc_addresses AS recipients
    ), ${terminalEvents(sql`SELECT * FROM rejected`,sql`${JSON.stringify({providerCalled:false})}::jsonb`)} SELECT count(*)::int AS n FROM webhook_jobs`);
  await wakeWebhooks(runtime,rejected.rows[0]!.n);
  logError(error, { code, emailId: mail.id });
  if (mail.campaignId) await finishSettledCampaigns(runtime, [{ workspace_id: mail.workspaceId, campaign_id: mail.campaignId }]);
  return 'rejected';
}

export type CampaignRef = { workspace_id: string; campaign_id: string };
// One statement moves every listed campaign whose last row has left the queue to done. It takes only the campaign
// rows (never email locks), after the statement that moved the rows, so it cannot deadlock with cancel or the run job.
export async function finishSettledCampaigns(runtime: Runtime, refs: CampaignRef[]) {
  if (!refs.length) return;
  await runtime.db.execute(finishCampaigns(sql`SELECT workspace_id, campaign_id FROM jsonb_to_recordset(${JSON.stringify(refs)}::jsonb) AS r(workspace_id text, campaign_id text)`));
}

// OAuth grant decoding, original scopes and client/resource policy stay in the MCP verifier.
// All other origins are checked under the claim's locks, including permission/domain changes.
const mcpOrigin = (item: Prepared) => `${item.mail.workspaceId}\u0000${item.mail.actorKeyId}\u0000${!!item.mail.campaignId}\u0000${item.snapshot.from.split('@')[1]!.toLowerCase()}`;
export async function originDecisions(prepared: Prepared[], db: DbExecutor) {
  const grants = new Map<string, boolean>();
  for (const item of prepared) if (item.mail.actorKeyId.startsWith('mcp_') && !grants.has(mcpOrigin(item))) {
    const runtime = item.owner.runtime;
    grants.set(mcpOrigin(item), await originAllowed(runtime, db, { ...item.mail, snapshot: item.snapshot }));
  }
  return grants;
}

// One statement elects every row in the group: key revocation under FOR SHARE, consent locks, campaign
// cancellation, unsubscribe tokens and attempt events. Rows flip queued → attempting here, so the group
// is kept to the provider in-flight width: a platform reset can only strand what was actually mid-call.
// Campaign rows are shared-locked before their email rows (cancel and the run job take the campaign row
// first too); the campaign itself is never written here, so concurrent shards never serialize on it.
export async function claimGroup(runtime: Runtime, prepared: Prepared[], origins: Map<string, boolean>, db: DbExecutor) {
  const input = prepared.map(item => ({
    id: item.mail.id, workspace_id: item.mail.workspaceId, dispatch_version: item.mail.dispatchVersion, status: 'queued', campaign_id: item.mail.campaignId,
    actor_key_id: item.mail.actorKeyId, sender: item.snapshot.from.toLowerCase(), mcp_allowed: item.mail.actorKeyId.startsWith('mcp_') && origins.get(mcpOrigin(item)) === true,
    feedback_topic: item.owner.feedbackTopic, binding:item.review?.draft.binding ?? item.mail.snapshot.binding, destinations: [...item.snapshot.to, ...item.snapshot.cc, ...item.snapshot.bcc].map(email => email.toLowerCase()),
    hosted:!!item.owner.tenantName,marketing: item.snapshot.kind === 'marketing', notice: item.review?.draft.requiredNotice === true,
    // The topic it is about (src/topics.ts): a campaign's, frozen in its review, or a marketing send's own.
    topic_id: item.snapshot.kind !== 'marketing' || item.review?.draft.requiredNotice ? null : (item.review ? item.review.draft.topicId : item.snapshot.topicId) ?? null, held_stream: item.snapshot.kind !== 'transactional' || !!item.mail.campaignId || !!item.snapshot.bulk, reply_authors: item.snapshot.replyAuthors, snapshot: item.stored ?? null,
    token_hash: item.unsubscribe?.tokenHash ?? null, token_email: item.unsubscribe?.email ?? null, token_page: item.unsubscribe?.page ?? null,
    event_id: rowId('event'), external_id: `attempt-start:${item.mail.id}:${item.mail.dispatchVersion}`, attempt: item.mail.dispatchVersion + 1,
  }));
  const rows = sql`SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(id text, workspace_id text, dispatch_version int, status text, campaign_id text, actor_key_id text, sender text, mcp_allowed boolean, hosted boolean, feedback_topic text, binding jsonb, destinations jsonb, marketing boolean, notice boolean, topic_id text, held_stream boolean, reply_authors jsonb, snapshot jsonb, token_hash text, token_email text, token_page text, event_id text, external_id text, attempt int)`;
  // Every row lock the claim takes is on a row reached from `input`, so setting lock_timeout while input is read bounds
  // every wait: a claim waits at most CLAIM_LOCK_MS for another transaction (55P03), then gives its group back. The
  // previous value comes back once `claimed` has run, which only matters inside an outer transaction (tests).
  const limited = sql`before AS MATERIALIZED (SELECT current_setting('lock_timeout') AS lock), ${claimCtes(runtime, prepared[0]!.mail.region,
    sql`SELECT x.* FROM (${rows}) x WHERE (SELECT set_config('lock_timeout',${String(CLAIM_LOCK_MS)},true) FROM before) IS NOT NULL`)}`;
  const claimed = await db.execute<{ id: string | null; status: EmailStatus; error_code: string | null; webhooks:number }>(sql`WITH ${limited}
    SELECT c.id,c.status,c.error_code,(SELECT count(*)::int FROM webhook_jobs) AS webhooks
    FROM (SELECT set_config('lock_timeout',(SELECT lock FROM before),true) FROM (SELECT count(*) FROM claimed) n) restored LEFT JOIN claimed c ON true`);
  const rowsClaimed = claimed.rows.filter(row => row.id !== null);
  return {statuses:new Map(rowsClaimed.map(row => [row.id!, row.status])),busy:new Set(rowsClaimed.filter(row => row.error_code === 'RECIPIENT_BUSY').map(row => row.id!)),webhooks:claimed.rows[0]?.webhooks??0};
}
/**
 * A forward's email is sent only while its endpoint is still a confirmed, unpaused forward and every approval behind it
 * is active. It share-locks the forward-once row, then the endpoint row, so a decline or an edit committing now is either
 * seen or waits for this decision. `x` has id, workspace_id and actor_key_id.
 */
export function forwardStillAllowed(runtime: Pick<Runtime, 'config'>, x: SQL) {
  return sql`EXISTS (
    SELECT FROM mail_forward_once f JOIN mailbox_webhooks h ON h.workspace_id=f.workspace_id AND h.id=f.endpoint
    WHERE f.email_id=${x}.id AND f.workspace_id=${x}.workspace_id AND ${x}.actor_key_id='forward:'||f.endpoint AND h.type='forward'
    AND h.verified AND h.declined_at IS NULL AND NOT h.paused AND NOT EXISTS(SELECT FROM jsonb_array_elements_text(f.grants) gid WHERE NOT mail_receiving_grant(f.workspace_id,gid,${receivingPolicy(runtime.config)}::jsonb))
    FOR SHARE OF f, h)`;
}
function claimCtes(runtime: Runtime, region: string, input: SQL) {
  return sql`input AS MATERIALIZED (${input}
    ), key_state AS MATERIALIZED (
      SELECT id, workspace_id, permissions, domains FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        AND (workspace_id, id) IN (SELECT workspace_id, actor_key_id FROM input)
        AND ${tieAllows(runtime.config, sql`workspace_id`, sql`id`, 'api_key')} FOR SHARE
    ), campaign_state AS MATERIALIZED (
      SELECT id, workspace_id, state FROM sending_campaigns WHERE (workspace_id, id) IN (SELECT workspace_id, campaign_id FROM input WHERE campaign_id IS NOT NULL) FOR SHARE
    ), dest AS (
      SELECT x.id AS email_id, x.workspace_id, d.value AS email, d.n FROM input x, jsonb_array_elements_text(x.destinations) WITH ORDINALITY d(value,n)
    ), consent AS MATERIALIZED (
      -- Shared, so an unsubscribe or suppression committing now is either seen or waits for this decision; skipped when
      -- another transaction holds the contact for writing (an import, a bulk change), so no tenant's claim waits on it.
      SELECT workspace_id, email, id, suppressed, suppression_reason, deleted_at, marketing_consent FROM audience_contacts
      WHERE (workspace_id, email) IN (SELECT workspace_id, email FROM dest)
      ORDER BY workspace_id,email FOR SHARE SKIP LOCKED
    ), busy AS MATERIALIZED (
      -- A recipient whose contact was skipped above is undecided: its email goes back to the queue for CLAIM_BUSY_MS.
      SELECT DISTINCT d.email_id FROM dest d WHERE NOT EXISTS (SELECT FROM consent c WHERE c.workspace_id=d.workspace_id AND c.email=d.email)
        AND EXISTS (SELECT FROM audience_contacts a WHERE a.workspace_id=d.workspace_id AND a.email=d.email)
    ), ${runtime.config.multiTenant ? sql`sponsor_state AS MATERIALIZED (
      -- A sponsor's full pause holds every stream of its other workspaces (migration 231 hosted_sponsor_hold): share-lock
      -- the sibling connections, in id order and before the election's own connection row, so a pause committing now is
      -- seen; a restrict reaches dispatch through hosted_marketing_held. Exempt workspaces neither inherit nor pass it on.
      SELECT me.id AS workspace_id,sp.paused_at IS NOT NULL AND sp.resume_pending_at IS NULL AS paused
      FROM workspaces me JOIN workspaces o ON o.quota_sponsor=me.quota_sponsor AND o.id<>me.id AND NOT o.exempt_hosted_quotas
      JOIN provider_connections sp ON sp.workspace_id=o.id AND sp.kind='shared'
      WHERE me.id IN (SELECT workspace_id FROM input) AND me.quota_sponsor IS NOT NULL AND NOT me.exempt_hosted_quotas ORDER BY sp.id FOR SHARE OF sp
    ), ` : sql``}pinned_routes AS MATERIALIZED (
      ${runtime.config.multiTenant ? sql`SELECT keys.*,r.* FROM (SELECT DISTINCT workspace_id,split_part(sender,'@',2) AS host FROM input WHERE binding IS NOT NULL) keys
        CROSS JOIN LATERAL ${regionalSender(runtime,claimsOnly,sql`keys.workspace_id`,sql`keys.host`)} r` : sql`SELECT 1`}
    ), eligibility AS MATERIALIZED (
      SELECT x.id, x.id IN (SELECT email_id FROM busy) AS busy,
        CASE WHEN starts_with(x.actor_key_id, 'mcp_') THEN x.mcp_allowed
          WHEN starts_with(x.actor_key_id,'forward:') THEN ${forwardStillAllowed(runtime, sql`x`)}
          -- An owner notice (sendSystemEmail): only from the configured platform workspace, about a committed standing event.
          WHEN starts_with(x.actor_key_id, 'standing:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM standing_events s WHERE s.id=substr(x.actor_key_id,10))
          -- A billing owner notice (billing/notify.ts): the same, about a committed billing_notices row.
          WHEN starts_with(x.actor_key_id, 'billing:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM billing_notices n WHERE n.id=substr(x.actor_key_id,9))
          -- An account notice (account-notices.ts): the same, about a committed account_notices row.
          WHEN starts_with(x.actor_key_id, 'notice:') THEN x.campaign_id IS NULL AND x.workspace_id=${runtime.config.platformDomainWorkspace ?? null}::text
            AND EXISTS (SELECT FROM account_notices n WHERE n.id=substr(x.actor_key_id,8))
          WHEN starts_with(x.actor_key_id, 'user_') THEN EXISTS (${approvedOriginUser(runtime, sql`x.workspace_id`, sql`substr(x.actor_key_id, 6)`, sql`x.campaign_id IS NULL`)})
          WHEN starts_with(x.actor_key_id, 'app_') THEN EXISTS (
            SELECT FROM (${principal(runtime, 'smtp', sql`p.id=x.actor_key_id AND b.workspace_id=x.workspace_id`)} FOR SHARE OF p,b) a
            JOIN mailbox_addresses addr ON addr.workspace_id=a.w AND addr.mailbox_id=a.b AND addr.address=x.sender FOR SHARE OF addr)
          WHEN starts_with(x.actor_key_id, 'mbk_') THEN EXISTS (
            SELECT 1 FROM mailbox_keys k JOIN mailbox_addresses b ON b.workspace_id = k.workspace_id AND b.address = x.sender
            WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND k.permissions ? 'send'
              AND mail_key_grant_allows(k.workspace_id,k.id,'key',${receivingPolicy(runtime.config)}::jsonb)
              AND (k.mailbox_ids IS NULL OR k.mailbox_ids ? b.mailbox_id) FOR SHARE OF k, b)
          ELSE EXISTS (SELECT 1 FROM key_state k WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id
            AND (k.permissions ? 'manage' OR k.permissions ? 'send') AND (k.domains = '[]'::jsonb OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(k.domains) d WHERE split_part(x.sender, '@', 2) = lower(d.value)
                OR right(split_part(x.sender, '@', 2), length(d.value) + 1) = '.' || lower(d.value)))) END
          AS origin_ok,
        ${runtime.config.multiTenant ? sql`CASE WHEN x.binding IS NULL THEN ${verifiedClaim(sql`x.workspace_id`, sql`${region}`, sql`split_part(x.sender, '@', 2)`)} ELSE EXISTS (
          SELECT 1 FROM pinned_routes r WHERE r.workspace_id=x.workspace_id AND r.host=split_part(x.sender,'@',2) AND r.region=${region} AND r.verified AND r.binding=x.binding
            AND r.connection IS NOT NULL AND r.connection->>'paused_at' IS NULL AND (r.connection->>'kind'='byo' OR ${isSimulatedSes(runtime)} OR r.connection->>'tenant_state'='ready')
            AND r.connection->>'feedback_topic_arn' IS NOT DISTINCT FROM x.feedback_topic) END` : sql`true`} AS binding_ok,
        (x.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_state c WHERE c.workspace_id = x.workspace_id AND c.id = x.campaign_id AND c.state <> 'canceled')) AS campaign_allowed,
         -- A required notice (src/sending/front-door.ts requiredNotice) skips only the marketing consent checks: it still never goes
         -- to a suppressed address or a deleted contact.
         (SELECT cause.reason FROM dest d LEFT JOIN consent c USING (workspace_id,email)
          CROSS JOIN LATERAL (SELECT ${recipientIneligibleReasonSql({ marketing: sql`x.marketing`, replyAuthors: sql`x.reply_authors`, topic: sql`x.topic_id`, notice: sql`x.notice`, risk: false })} AS reason) cause
          WHERE d.email_id=x.id AND cause.reason IS NOT NULL ORDER BY d.n LIMIT 1) AS suppression_reason
      FROM input x
    ), budget AS MATERIALIZED (SELECT x.id,${runtime.config.multiTenant && !isSimulatedSes(runtime) ? sql`CASE WHEN x.hosted AND NOT el.busy AND el.origin_ok AND el.binding_ok AND el.campaign_allowed AND el.suppression_reason IS NULL
        THEN hosted_burst_ok(x.workspace_id,split_part(x.sender,'@',2),jsonb_array_length(x.destinations),NOT x.held_stream) ELSE true END` : sql`true`} AS allowed
      FROM input x JOIN eligibility el USING(id) ORDER BY x.workspace_id,x.sender,x.id), claimed AS (
      UPDATE sending_emails e SET simulated = ${isSimulatedSes(runtime)},
        status = CASE WHEN el.busy OR NOT b.allowed THEN 'queued' WHEN NOT el.origin_ok OR NOT el.binding_ok OR NOT el.campaign_allowed THEN 'canceled' WHEN el.suppression_reason IS NULL THEN 'attempting' ELSE 'suppressed' END,
        scheduled_at=CASE WHEN el.busy THEN clock_timestamp()+${CLAIM_BUSY_MS}::int*interval '1 millisecond' WHEN NOT b.allowed THEN date_trunc('minute',statement_timestamp())+interval '1 minute' ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN NOT el.busy AND b.allowed AND el.origin_ok AND el.binding_ok AND el.campaign_allowed AND el.suppression_reason IS NULL THEN clock_timestamp() ELSE e.attempt_started_at END,
        error_code = CASE WHEN el.busy THEN 'RECIPIENT_BUSY' WHEN NOT b.allowed THEN 'HOSTED_BURST_LIMIT' WHEN NOT el.binding_ok AND x.binding IS NOT NULL THEN 'SENDER_BINDING_CHANGED' WHEN NOT el.origin_ok OR NOT el.binding_ok THEN 'ORIGIN_KEY_REVOKED' WHEN NOT el.campaign_allowed THEN 'CAMPAIGN_CANCELED' WHEN el.suppression_reason IS NULL THEN CASE WHEN e.error_code IN ('HOSTED_BURST_LIMIT','RECIPIENT_BUSY') THEN NULL ELSE e.error_code END ELSE 'RECIPIENT_INELIGIBLE' END,
        suppression_reason = CASE WHEN el.busy THEN e.suppression_reason WHEN el.origin_ok AND el.binding_ok AND el.campaign_allowed THEN el.suppression_reason END,
        ${runtime.config.multiTenant && !isSimulatedSes(runtime) ? sql`feedback_topic_arn=x.feedback_topic,` : sql``} snapshot = CASE WHEN b.allowed AND NOT el.busy THEN coalesce(x.snapshot, e.snapshot) ELSE e.snapshot END, lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN eligibility el ON el.id = x.id JOIN budget b ON b.id=x.id
      -- e.status is compared with x.status ('queued' in every input row), never a literal, so sending_emails has no condition
      -- of its own: the planner reaches it only by primary key from each input row, since any other way reads the whole
      -- table. With a literal it could scan a queued-only partial index instead, and when the statistics were taken while
      -- nothing was queued it did: every queued row for each batch, the hold check for each pair (20,000 rows, 5 seconds).
      WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.status = x.status AND e.dispatch_version = x.dispatch_version
        ${runtime.config.multiTenant ? sql`AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.workspace_id=x.workspace_id AND pc.paused_at IS NULL
          AND NOT (x.held_stream AND hosted_marketing_held(x.workspace_id)) FOR SHARE)
          AND NOT EXISTS (SELECT 1 FROM sponsor_state ss WHERE ss.workspace_id=x.workspace_id AND ss.paused)` : sql``}
      RETURNING e.id,e.workspace_id,e.status,e.region,e.simulated,e.error_code,e.suppression_reason,e.dispatch_version
    ), token AS (
      INSERT INTO operation_unsubscribe_tokens(token_hash, workspace_id, email, page_url, topic_id)
      SELECT x.token_hash, c.workspace_id, x.token_email, x.token_page, x.topic_id FROM claimed c JOIN input x ON x.id = c.id WHERE x.token_hash IS NOT NULL AND c.status = 'attempting'
      ON CONFLICT DO NOTHING
    ), attempt AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, external_id, simulated, data, created_at)
      SELECT x.event_id, c.workspace_id, c.id, 'dispatch_attempt', x.external_id, ${isSimulatedSes(runtime)}::boolean,
        jsonb_build_object('attempt', x.attempt, 'providerCallPlanned', true, 'providerCallSimulated', ${isSimulatedSes(runtime)}::boolean), clock_timestamp()
      FROM claimed c JOIN input x ON x.id = c.id WHERE c.status = 'attempting' ON CONFLICT DO NOTHING
    ), ${terminalEvents(sql`SELECT * FROM claimed WHERE status IN ('suppressed','canceled')`)}`;
}

export function redactDenial(runtime: Runtime, failure: { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } }) {
  const denial = failure.name === 'AccessDeniedException' && typeof failure.message === 'string' ? failure.message.slice(0, 8192) : '';
  const deniedAction = denial.match(/not authorized to perform(?::\s*|\s+['"])([a-z0-9-]+:[A-Za-z0-9]+)\b/)?.[1];
  const deniedResource = denial.match(/on resource:\s*(arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9_+=,.@/*:-]{1,512}|\*)(?=\s|$)/)?.[1]?.replace(/[A-Za-z0-9_+=,.%-]+@/g, '[redacted]@');
  const awsRequestId = typeof failure.$metadata?.requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(failure.$metadata.requestId) ? failure.$metadata.requestId : undefined;
  const denialMessage = [runtime.config.aws?.accessKeyId, runtime.config.aws?.secretAccessKey, runtime.config.aws?.sessionToken]
    .reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted credential]') : text, denial)
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g, '[redacted email]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted access key]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|secret|password|credential|signature|authorization)\s*[:=]\s*\S+)/gi, '[redacted credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
  return { denial, diagnostics: { ...(awsRequestId ? { awsRequestId } : {}), ...(deniedAction ? { deniedAction } : {}), ...(deniedResource ? { deniedResource } : {}), ...(denialMessage ? { denialMessage } : {}) } };
}

// One statement records every provider outcome in the batch: attempt-result events, monotonic
// status, public events, webhook deliveries, throttled requeues and (test) simulated feedback.
export async function recordOutcomes(runtime: Runtime, outcomes: Outcome[]) {
  if (!outcomes.length) return;
  const simulated = isSimulatedSes(runtime);
  const input = outcomes.map(o => ({
    email_id: o.mail.id, workspace_id: o.mail.workspaceId, dispatch_version: o.mail.dispatchVersion, type: o.type, provider_id: o.providerId ?? null,
    event_id: rowId('event'), external_id: `attempt-result:${o.mail.id}:${o.mail.dispatchVersion}`, data: o.type === 'acceptance_unknown' ? {...o.data,status:o.type} : o.data, error_code: o.errorCode ?? null,
    next_status: requeued(o) ? 'queued' : statusForEvent[o.type] ?? null,
    next_rank: requeued(o) ? 0 : rank[statusForEvent[o.type]!], public_type: publicEventType[o.type] ?? null,
    outcome_bit: o.type === 'accepted' ? 1 : o.type === 'reject' ? 64 : 0,
    wait_ms: o.requeueAt ? Math.max(0, Date.parse(o.requeueAt) - Date.now()) : null,
  }));
  const statement = sql`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(email_id text, workspace_id text, dispatch_version int, type text, provider_id text, event_id text, external_id text, data jsonb, error_code text, next_status text, next_rank int, public_type text, outcome_bit int, wait_ms float8)
    ), mail AS MATERIALIZED (
      SELECT e.id, e.workspace_id, e.status, e.error_code, e.region, e.dispatch_version FROM sending_emails e JOIN input x ON e.workspace_id = x.workspace_id AND e.id = x.email_id
      ORDER BY e.id FOR UPDATE
    ), inserted AS (
      -- Accepted mail is stamped with the database's clock inside this statement, after the FOR UPDATE above gave it a
      -- transaction ID, never another clock: the abuse sample's mark relies on it (abuse.ts sampleBound;
      -- check-premerge.ts holds every writer of sending_email_events to it).
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at)
      SELECT x.event_id, m.workspace_id, m.id, x.type, x.provider_id, x.external_id, x.data, ${simulated}::boolean, clock_timestamp()
      FROM input x JOIN mail m ON m.id = x.email_id ORDER BY m.workspace_id,m.id ON CONFLICT DO NOTHING RETURNING *
    ), updated AS (
      UPDATE sending_emails e SET
        status = x.next_status, provider_id = coalesce(x.provider_id, e.provider_id),
        event_outcomes = e.event_outcomes | x.outcome_bit::smallint,
        error_code = CASE WHEN x.next_status='queued' THEN x.error_code WHEN x.type = 'accepted' THEN NULL ELSE coalesce(x.error_code, e.error_code) END,
        account_pause_started_at = CASE WHEN x.error_code='SES_ACCOUNT_SENDING_PAUSED' THEN coalesce(e.account_pause_started_at,clock_timestamp()) END,
        dispatch_version = CASE WHEN x.next_status = 'queued' THEN e.dispatch_version + 1 ELSE e.dispatch_version END,
        scheduled_at = CASE WHEN x.next_status = 'queued' THEN clock_timestamp() + x.wait_ms * interval '1 millisecond' ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN x.next_status = 'queued' THEN NULL ELSE e.attempt_started_at END,
        lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN inserted i ON i.email_id = x.email_id JOIN mail m ON m.id = x.email_id
      WHERE e.workspace_id = x.workspace_id AND e.id = x.email_id AND e.dispatch_version = x.dispatch_version
        AND ((x.next_status = 'queued' AND (m.status IN ('queued','attempting') OR (m.status='acceptance_unknown' AND m.error_code='INTERRUPTED_PROVIDER_ATTEMPT')))
          OR (x.next_status <> 'queued' AND x.next_rank >= (${rankJson()}::jsonb ->> m.status)::int))
      RETURNING e.id, e.workspace_id, e.campaign_id, (m.status='acceptance_unknown' AND e.status='queued') AS recovered
    ), reopened AS (${reopenQueuedCampaigns(sql`SELECT workspace_id,campaign_id FROM updated WHERE recovered AND campaign_id IS NOT NULL`)}), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT i.id, i.workspace_id, x.public_type, m.region, i.created_at,
        x.data || jsonb_build_object('emailId', m.id, 'simulated', ${simulated}::boolean) || CASE WHEN x.provider_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('providerId', x.provider_id) END
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), ${operationWebhookFanoutCtes()}, ${simulatedFeedbackCtes(sql`SELECT i.workspace_id, m.id AS email_id, m.region, x.provider_id, i.created_at
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id
      WHERE ${simulated && !runtime.feedback}::boolean AND x.type = 'accepted' AND x.provider_id LIKE 'sim\\_%'`, runtime.config.simulatedSes.deliveryDelayMs)}
    SELECT (SELECT count(*) FROM inserted)::int AS events, (SELECT count(*) FROM updated)::int AS updated, (SELECT count(*) FROM webhook_jobs)::int AS webhooks, (SELECT count(*) FROM simulated_jobs)::int AS simulated`;
  // Retry only the fenced, external-id-deduplicated write. Never reacquire a send slot or call SES again.
  let readyJobs: number;
  for (let attempt=0; ; attempt++) {
    try { readyJobs = (await runtime.db.execute<{webhooks:number}>(statement)).rows[0]!.webhooks; break; }
    catch (error) {
      const conflict = databaseConflict(error), transient = !conflict && transientDatabaseError(error);
      if (!conflict && !transient) throw error;
      if (attempt>=3) {
        if (!conflict || outcomes.length===1) throw error;
        // A repeatedly contended mixed write must not strand its neighbors. Keep one
        // writer per run, and attempt the second half even if the first cannot settle.
        const mid=Math.ceil(outcomes.length/2);
        try { await recordOutcomes(runtime,outcomes.slice(0,mid)); }
        finally { await recordOutcomes(runtime,outcomes.slice(mid)); }
        return;
      }
      const baseMs = transient ? 100 : 10;
      await sleep((baseMs + Math.random() * baseMs) * 2 ** attempt);
    }
  }
  if (readyJobs > 0) try { await runtime.wake?.(readyJobs, 'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  // With a feedback sink, simulated Send/Delivery callbacks travel the same queue live SNS feedback does.
  if (simulated && runtime.feedback) {
    const recorded = new Date().toISOString();
    await queueSimulatedFeedback(runtime, outcomes.filter(o => o.type === 'accepted' && o.providerId?.startsWith('sim_')).map(o => ({ emailId: o.mail.id, region: o.mail.region, providerId: o.providerId!, createdAt: recorded })));
  }
}
export function deferBurst(deferred:DeferredStream[],workspace_id:string,stream:DeferredStream['stream']) {
  if(!deferred.some(d=>d.workspace_id===workspace_id && d.stream===stream)) deferred.push({workspace_id,stream,until:(Math.floor(Date.now()/60000)+1)*60000});
}
/** Reorders a batch so transactional rows always stay ahead of marketing, and within each stream owners alternate
 *  round-robin (preserving each owner's FIFO order). When a mid-batch stop or pacing cutoff returns later chunks of
 *  `sendConcurrency`, both sent and returned chunks stay balanced across concurrent campaigns. */
export function interleaveByOwner<T>(items: readonly T[], kindOf: (item: T) => EmailSnapshot['kind'], ownerOf: (item: T) => string, offset = 0): T[] {
  if (items.length <= 1) return items.slice();
  const roundRobin = (stream: T[]) => {
    if (stream.length <= 1) return stream;
    const byOwner = new Map<string, T[]>();
    for (const item of stream) {
      const id = ownerOf(item);
      let list = byOwner.get(id);
      if (!list) { list = []; byOwner.set(id, list); }
      list.push(item);
    }
    if (byOwner.size <= 1) return stream;
    const queues = [...byOwner.values()];
    const shift = ((offset % queues.length) + queues.length) % queues.length;
    if (shift) queues.push(...queues.splice(0, shift));
    const out: T[] = [];
    for (let i = 0; out.length < stream.length; i++) {
      for (const q of queues) if (i < q.length) out.push(q[i]!);
    }
    return out;
  };
  const tx: T[] = [], mkt: T[] = [];
  for (const item of items) (kindOf(item) === 'transactional' ? tx : mkt).push(item);
  return [...roundRobin(tx), ...roundRobin(mkt)];
}
