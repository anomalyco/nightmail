import { sql, type SQL } from 'drizzle-orm';
import { ApiError, isSimulatedSes, log, type Runtime } from './core.js';
import { SEND_LIMITS } from './send-limits.js';
import { platformPolicy, regionalSending, unverifiedSender, type SendingBinding } from './domain-claims.js';
import { marketingHeld, type HostedAllowance } from './hosted-sending.js';
import { balanceExhausted } from './billing/gate.js';
import { RATES } from './billing/money.js';
import type { BillingGate } from './billing/types.js';
import { credentialFingerprint, discoveryTarget } from './ses-region-state.js';
import type { ReadyConnection } from './provider-credentials.js';
import type { SendScope } from './send-scope.js';
import { productName } from './brand.js';

/**
 * Send admission: one decision for every kind of send, made by send_admission (migration 323) in the statement or
 * transaction that sends. This module builds its parameters (the limits come from send-limits.ts) and turns a refusal
 * into the API's error. It holds no rule of its own: what is checked, in which order, lives in the SQL function.
 *
 * Stages: send (direct, batch, self-hosted, templates, mailbox, campaign test), launch (a campaign's sender, holds,
 * balance and attachments), reserve (outstanding campaign recipients, at launch and resume), release (a campaign's
 * next recipients) and prepare (a campaign's reviewed binding).
 */
export type Stage = 'send' | 'launch' | 'reserve' | 'release' | 'prepare';
/** One message as admission sees it. `invalid` and `oversize` are TypeScript's own findings, reported after every rule. */
export type AdmissionMail = { host: string; region?: string; kind: 'transactional' | 'marketing'; attachments: string[]; bodyBytes: number; duplicate?: boolean; invalid?: boolean; oversize?: boolean };
export type AdmittedAsset = { id: string; size: number; contentId: string | null; contentType: string };
export type Admitted = { allowed: true; mails: { region: string; binding: SendingBinding | null; connection: ReadyConnection | null }[]; billing: BillingGate | null; assets: AdmittedAsset[]; shared: boolean };
export type Released = { allowed: true; hostedLeft: number | null; nextChangeAt: string | null; billing: { enforced: boolean; freeSentLeft: number; affordable: number; availableUc: string } | null };
export type Refused = { allowed: false; code: string; item?: number; reason?: string | null; cap?: number; window?: 'hour' | 'day'; reserved?: boolean;
  allowance?: HostedAllowance; incoming?: number; marketing?: number; regional?: boolean; failed?: boolean; host?: string; billing: BillingGate | null };

/** The installation's side of every decision: limits, sending mode and policy. */
async function policy(runtime: Runtime) {
  const cfg = runtime.config, sim = isSimulatedSes(runtime), platform = platformPolicy(cfg);
  return { limits: SEND_LIMITS, simulated: sim, multiTenant: cfg.multiTenant, regional: regionalSending(runtime), trustedPool: !!cfg.trustedPool,
    requireDmarc: cfg.multiTenant && !!cfg.requireDmarcForBulk, platform: platform ? JSON.parse(platform) : null, platformWorkspace: cfg.platformDomainWorkspace ?? null,
    caps: cfg.hostedSendCaps, headroom: cfg.dispatch.dailyHeadroomPercent, emailUc: RATES.emailUc.toString(),
    readiness: !cfg.multiTenant && !sim ? { fingerprint: await credentialFingerprint(cfg), target: discoveryTarget(cfg) } : null };
}
/** Recipients a send charges against the Hosted limit (none when SES is simulated), how many of them are marketing, and
 * how many the balance is asked for (all of them: billing_gate prices simulated mail only when configured to). */
export function charges(runtime: Runtime, mails: { recipients: number; marketing: boolean }[]) {
  const sim = isSimulatedSes(runtime);
  let cost = 0, marketing = 0, billable = 0;
  for (const m of mails) { billable += m.recipients; if (!sim) { cost += m.recipients; if (m.marketing) marketing += m.recipients; } }
  return { cost, marketing, billable };
}
export type AdmissionRequest = {
  /** take: the statement takes the send locks itself; a SendScope: the caller holds them (send-scope.ts); none: a check
   * outside the send locks, which locks only the sender claim it reads. */
  stage: Stage; locks: 'take' | 'none' | SendScope; mails?: (AdmissionMail & { from?: string; binding?: SendingBinding })[]; cost?: number; marketing?: number; billable?: number;
  /** The idempotency claim, made first by a statement that admits by itself. */
  claim?: { path: string; key: string; hash: string; receipt: unknown };
  /** A campaign test admitted by itself: its row is locked first and must still be at the revision that was rendered. */
  campaign?: { id: string; revision: number };
  incoming?: number; autoPause?: boolean;
};
/** The send_admission(...) call. `actor` is a jsonb {id, domains}; `assets` the attachment IDs the sender may use. */
export async function admission(runtime: Runtime, workspaceId: SQL | string, actor: SQL, request: AdmissionRequest, extra?: SQL, assets: SQL = sql`'[]'::jsonb`) {
  const req = sql`${JSON.stringify({ ...await policy(runtime), ...request, locks: typeof request.locks === 'string' ? request.locks : 'held' })}::jsonb${extra ? sql` || ${extra}` : sql``}`;
  return sql`send_admission(${workspaceId}, ${actor}, ${req}, ${assets})`;
}
export const actorJson = (a: { keyId: string; domains: string[] }) => sql`${JSON.stringify({ id: a.keyId, domains: a.domains })}::jsonb`;

const count = (value: number) => value.toLocaleString('en-US');
export const duplicateAttachment = () => new ApiError(422, 'DUPLICATE_ATTACHMENT', 'An attachment can appear only once per message.');
/**
 * The API error for a refusal. A batch names the item that failed (emails.3.from); a request-wide limit names none.
 * INVALID_CONTENT and CONTENT_TOO_LARGE_TO_SCREEN are the caller's own findings for that item, which it throws as found.
 */
export function refusal(runtime: Runtime, d: Refused, local: { batch?: boolean; invalid?: (item: number) => unknown; oversize?: (item: number) => unknown; retryable?: string[] } = {}): unknown {
  const item = (error: ApiError) => {
    if (local.batch && d.item !== undefined) error.field = `emails.${d.item}${error.field ? `.${error.field}` : ''}`;
    // A background job retries what it waits on rather than failing (campaign preparation: SES setup).
    if (local.retryable?.includes(error.code)) error.retryable = true;
    return error;
  };
  switch (d.code) {
    case 'BALANCE_EXHAUSTED': return balanceExhausted(runtime.config, d.billing!);
    case 'HOSTED_SENDING_PAUSED': return item(new ApiError(409, d.code, d.reason ?? 'Hosted sending is paused for this workspace.'));
    case 'MARKETING_HELD': return marketingHeld(d.reason);
    case 'SEND_LIMIT_REACHED': {
      const h = d.allowance!, marketing = d.marketing ?? 0, incoming = d.incoming ?? 0;
      if (d.window === 'hour') {
        const resetAt = new Date(h.marketingHourResetAt!).toISOString();
        return new ApiError(429, d.code, `Hosted marketing is limited to ${count(h.marketingHourCap!)} recipients an hour; ${count(h.marketingHourUsed ?? 0)} are used this hour. The next hour starts at ${resetAt}.${marketing > h.marketingHourCap! ? ' This submission exceeds the hourly limit.' : ''}`, undefined, marketing <= h.marketingHourCap!, resetAt);
      }
      const resetAt = h.resetAt ? new Date(h.resetAt).toISOString() : undefined, retryable = incoming <= h.cap! && marketing <= h.marketingCap!;
      return new ApiError(429, d.code, `Hosted sending is limited to ${h.cap} recipients per rolling 24 hours; ${count(h.used)} are used.${d.reserved ? ` Marketing stops at ${h.marketingCap} to reserve transactional capacity.` : ''}${resetAt ? ` Rolling usage expires at ${resetAt}.` : ''}${!retryable ? ' This submission exceeds the available limit.' : ''}`, undefined, retryable, resetAt);
    }
    case 'PENDING_EMAIL_LIMIT_EXCEEDED': return new ApiError(429, d.code, `This submission exceeds the outstanding email limit of ${d.cap} for this workspace. Wait for queued mail to dispatch before retrying.`, undefined, true);
    case 'REGION_SETTINGS_NOT_INITIALIZED': return new ApiError(503, d.code, 'Run database migrations to initialize SES region settings.');
    case 'SENDER_DOMAIN_FORBIDDEN': return item(new ApiError(403, d.code, 'This API key cannot send from this domain or its parent domain.', 'from'));
    case 'PLATFORM_SENDER_REFUSED': return item(new ApiError(403, d.code, `Only the workspace configured to own ${productName}’s own domain sends from it, and never from ${productName}’s platform hosts.`, 'from'));
    case 'SENDER_DOMAIN_NOT_VERIFIED': return item(unverifiedSender());
    case 'SENDER_REGION_MISMATCH': return item(new ApiError(422, d.code, 'The requested region does not match this sender domain.', 'region'));
    case 'CONNECTION_REQUIRED': return item(new ApiError(409, d.code, d.regional ? 'The sending connection is not ready in the bound region.' : 'Set up a sending connection for this workspace and region.'));
    case 'TRUSTED_POOL_DISABLED': return item(new ApiError(409, d.code, 'New trusted-pool admissions are disabled.'));
    case 'TENANT_NOT_READY': return item(new ApiError(409, d.code, d.failed ? 'Hosted sending setup failed and is being retried. Check the connection status before sending again.' : 'Hosted sending is still being set up for this workspace. Retry shortly.', undefined, true));
    case 'BULK_DMARC_REQUIRED': return item(new ApiError(409, d.code, `Hosted bulk sending requires a valid DMARC policy and aligned DKIM or SPF. Add or recheck the exact From domain ${d.host}.`, 'from'));
    case 'REGION_NOT_CONFIGURED': return item(new ApiError(422, d.code, 'The requested SES region is not enabled.', 'region'));
    case 'SES_SETUP_REQUIRED': return item(new ApiError(409, d.code, 'Run discovery and complete provisioning for this region before live sending.', 'region'));
    case 'DUPLICATE_ATTACHMENT': return item(duplicateAttachment());
    case 'ATTACHMENT_NOT_FOUND': return item(new ApiError(404, d.code, 'One or more attachments were not found in this workspace.'));
    case 'ATTACHMENT_LIMIT_EXCEEDED': return item(new ApiError(413, d.code, `Combined attachments may not exceed ${SEND_LIMITS.attachmentBytes / 1024 / 1024} MiB of decoded data.`));
    case 'DUPLICATE_CONTENT_ID': return item(new ApiError(422, d.code, 'Inline content IDs must be unique.'));
    case 'ATTACHMENT_METADATA_INVALID': return item(new ApiError(422, d.code, `SES attachment content IDs and MIME types must fit in ${SEND_LIMITS.mimeFieldChars} printable ASCII characters.`, 'attachments'));
    case 'ENCODED_MESSAGE_TOO_LARGE': return item(new ApiError(413, d.code, `Estimated encoded MIME exceeds the initial ${SEND_LIMITS.encodedBytes / 1024 / 1024} MiB message limit.`));
    case 'HOSTED_AUTO_PAUSE_REQUIRED': return new ApiError(422, d.code, 'Automatic bounce and complaint pauses cannot be disabled on Hosted shared sending.', 'autoPause');
    case 'CAMPAIGN_PENDING_LIMIT_EXCEEDED': return new ApiError(429, d.code, `Campaigns may reserve ${count(SEND_LIMITS.campaignPendingKey)} outstanding recipients per sender key and ${count(SEND_LIMITS.campaignPendingWorkspace)} per workspace. Wait for dispatch or cancel an active campaign.`, undefined, true);
    case 'SENDER_BINDING_CHANGED': return new ApiError(409, d.code, 'The reviewed sending binding is no longer ready.');
    case 'NOT_FOUND': return new ApiError(404, d.code, 'Campaign was not found.');
    case 'CAMPAIGN_ARCHIVED': return new ApiError(409, d.code, 'Restore this campaign before sending a test.');
    case 'CAMPAIGN_LOCKED': return new ApiError(409, d.code, 'The campaign changed while it was being sent; fetch it and try again.', undefined, true);
    case 'INVALID_CONTENT': return local.invalid!(d.item!);
    case 'CONTENT_TOO_LARGE_TO_SCREEN': return local.oversize!(d.item!);
  }
  return new ApiError(500, 'INTERNAL_ERROR', `Unknown admission refusal ${d.code}.`);
}
/** An admitted send whose balance check would refuse once enforced: logged, never refused (shadow billing). */
export function shadowBilling(b: BillingGate | null | undefined, workspaceId: string) {
  if (b && !b.ok && !b.enforced && b.mode === 'prepaid' && b.enforcement === 'shadow') log('info', { code: 'BILLING_SHADOW_DENY', workspaceId, requiredUc: b.requiredUc, availableUc: b.availableUc });
}
/** The decision, or its refusal thrown as the API's error. */
export function admitted<T extends { allowed: true }>(runtime: Runtime, d: T | Refused, workspaceId: string, local?: Parameters<typeof refusal>[2]): T {
  const b = (d as { billing?: unknown }).billing;
  if (b && typeof b === 'object' && 'ok' in b) shadowBilling(b as BillingGate, workspaceId);
  if (!d.allowed) throw refusal(runtime, d, local);
  return d;
}
