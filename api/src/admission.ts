import { sql, type SQL } from 'drizzle-orm';
import { ApiError, denied, isSimulatedSes, log, type Runtime } from './core.js';
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
import { builtinPolicy, builtinRefusal } from './builtin-domain.js';
import { RAMP } from './standing-model.js';

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
export type AdmissionMail = { host: string; region?: string; kind: 'transactional' | 'marketing'; attachments: string[]; bodyBytes: number; duplicate?: boolean; invalid?: boolean; oversize?: boolean;
  /** A built-in domain's mail (builtin-domain.ts): every recipient, lowercased, for its send scope and caps. */
  recipients?: string[] };
export type AdmittedAsset = { id: string; size: number; contentId: string | null; contentType: string };
export type Admitted = { allowed: true; mails: { region: string; binding: SendingBinding | null; connection: ReadyConnection | null }[]; billing: BillingGate | null; assets: AdmittedAsset[]; shared: boolean };
export type Released = { allowed: true; hostedLeft: number | null; nextChangeAt: string | null; billing: { enforced: boolean; freeSentLeft: number; affordable: number; availableUc: string } | null };
export type Refused = { allowed: false; code: string; item?: number; reason?: string | null; cap?: number; window?: 'hour' | 'day' | 'minute'; reserved?: boolean; field?: string; resetAt?: string;
  allowance?: HostedAllowance; incoming?: number; marketing?: number; regional?: boolean; failed?: boolean; host?: string; billing: BillingGate | null;
  /** RAMP_LIMIT_REACHED (ramp_refusal, migration 501): the step (from 1) of `steps`, what the hour holds, how many more fit
   * and Retry-After's seconds; for a send scheduled for later, the marketing scheduled within a day of it and a day's budget. */
  step?: number; steps?: number; used?: number; fits?: number; retryAfter?: number; scheduled?: boolean; backlog?: number | null; budget?: number | null;
  /** RAMP_PAUSED: the quarantined campaign and its pause code. */
  campaignId?: string; pauseCode?: string };

/** The installation's side of every decision: limits, sending mode and policy. */
async function policy(runtime: Runtime) {
  const cfg = runtime.config, sim = isSimulatedSes(runtime), platform = platformPolicy(cfg);
  return { limits: SEND_LIMITS, simulated: sim, multiTenant: cfg.multiTenant, regional: regionalSending(runtime), trustedPool: !!cfg.trustedPool,
    requireDmarc: cfg.multiTenant && !!cfg.requireDmarcForBulk, platform: platform ? JSON.parse(platform) : null, platformWorkspace: cfg.platformDomainWorkspace ?? null,
    caps: cfg.hostedSendCaps, headroom: cfg.dispatch.dailyHeadroomPercent, emailUc: RATES.emailUc.toString(), builtin: builtinPolicy(cfg),
    readiness: !cfg.multiTenant && !sim ? { fingerprint: await credentialFingerprint(cfg), target: discoveryTarget(cfg) } : null };
}
/** A campaign's pause codes that quarantine it: the automatic pause, the list probe and the ramp's check of a step. */
export const QUARANTINE_CODES = ['LIST_QUALITY', 'BOUNCE_RATE_HIGH', 'COMPLAINT_RATE_HIGH', 'BLOCKLISTED'];
/** What the database's ramp check (ramp_refusal and ramp_clean_hour, migration 501) is told of RAMP: each step's hourly
 * ceiling, how much of one an hour must release to prove it, the clean, mature history that places a sender, and the
 * quarantines that pause a workspace's marketing (RAMP_PAUSED). */
export const RAMP_POLICY = { steps: RAMP.steps.map(s => s.ceilingPerHour), advance: RAMP.advance, paused: QUARANTINE_CODES,
  history: { days: RAMP.historyDays, resolved: RAMP.check.resolved, bounceRate: RAMP.check.bounceRate, complaintRate: RAMP.check.complaintRate, complaints: RAMP.check.complaints } };
/** Recipients a send charges against the Hosted limit (none when SES is simulated), how many of them are marketing, and
 * how many the balance is asked for (all of them: billing_gate prices simulated mail only when configured to). Its
 * `kind: "marketing"` recipients on a live Hosted installation also ask the ramp (`ramp`); bulk evidence charges
 * transactional mail as marketing but never ramps it. */
export function charges(runtime: Runtime, mails: { recipients: number; marketing: boolean; snapshot?: { kind?: string } }[]) {
  const sim = isSimulatedSes(runtime);
  let cost = 0, marketing = 0, billable = 0, ramped = 0;
  for (const m of mails) { billable += m.recipients; if (!sim) { cost += m.recipients; if (m.marketing) marketing += m.recipients; if (m.snapshot?.kind === 'marketing') ramped += m.recipients; } }
  return { cost, marketing, billable, ...(ramped > 0 && runtime.config.multiTenant ? { ramp: { ...RAMP_POLICY, recipients: ramped } } : {}) };
}
/** A send scheduled for later charges nothing now: its release admits it as a send made then. Its marketing recipients
 * still ask the ramp (ramp_refusal) whether the workspace's marketing is paused, and whether they fit a whole hour of its
 * step and, with what is already scheduled within a day of their time, a day of it. */
export function scheduledCharges(runtime: Runtime, mails: Parameters<typeof charges>[1], scheduledAt: string) {
  const { ramp } = charges(runtime, mails);
  return { cost: 0, marketing: 0, billable: 0, scheduledAt, ...(ramp ? { ramp: { ...ramp, scheduled: true, at: scheduledAt } } : {}) };
}
export type AdmissionRequest = {
  /** take: the statement takes the send locks itself; a SendScope: the caller holds them (send-scope.ts); none: a check
   * outside the send locks, which locks only the sender claim it reads. */
  stage: Stage; locks: 'take' | 'none' | SendScope; mails?: (AdmissionMail & { from?: string; binding?: SendingBinding })[]; cost?: number; marketing?: number; billable?: number;
  /** A send's `kind: "marketing"` recipients, for the ramp's hourly ceiling (charges). */
  ramp?: typeof RAMP_POLICY & { recipients: number; scheduled?: boolean; at?: string };
  /** The idempotency claim, made first by a statement that admits by itself. */
  claim?: { path: string; key: string; hash: string; receipt: unknown };
  /** A campaign test admitted by itself: its row is locked first and must still be at the revision that was rendered. */
  campaign?: { id: string; revision: number };
  /** A scheduled single send (UTC instant): admitted now without charges, and as a send again at its time. */
  scheduledAt?: string;
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
    case 'RAMP_LIMIT_REACHED': {
      const opens = new Date(d.resetAt!).toISOString(), fits = d.fits ?? 0, asked = d.marketing ?? 0, ramping = `still ramping up (step ${d.step} of ${d.steps})`;
      const campaign = 'For a large list, send a campaign instead: campaigns are paced automatically.';
      const error = new ApiError(429, d.code, !d.scheduled
        ? `This workspace is ${ramping}: it can send ${count(d.cap!)} marketing recipients an hour right now, and ${fits ? `${count(fits)} more fit` : 'no more fit'} this hour${asked > fits ? `; this request has ${count(asked)}` : ''}. More room opens at ${opens.slice(11, 16)} UTC. ${campaign}`
        : asked > d.cap! ? `This workspace is ${ramping}: it can send ${count(d.cap!)} marketing recipients an hour, so a send of ${count(asked)} can't be scheduled while it ramps. ${campaign}`
        : `This workspace already has as much marketing scheduled as it can send in a day while it is ${ramping}: ${count(d.budget!)} recipients in 24 hours, and ${count(d.backlog!)} are scheduled within a day of this send. ${campaign}`, undefined, true);
      error.retryAfterSeconds = d.retryAfter;
      error.details = [{ step: d.step, steps: d.steps, ceilingPerHour: d.cap, usedThisHour: d.used, fitsNow: fits, requested: asked, stepOpensAt: opens,
        ...d.scheduled ? { scheduledBacklog: d.backlog, dailyBudget: d.budget } : {} }];
      return error;
    }
    case 'RAMP_PAUSED': {
      const error = new ApiError(409, d.code, `Marketing from this workspace is paused: campaign ${d.campaignId} was paused automatically (${d.pauseCode}). Review that campaign and resume it first, or cancel it. Transactional mail still sends.`);
      error.details = [{ campaignId: d.campaignId, pauseCode: d.pauseCode }];
      return error;
    }
    case 'INVALID_SCHEDULE': return new ApiError(422, d.code, `Schedule between now and ${SEND_LIMITS.schedule.horizonSeconds / 86_400} days from now.`, 'scheduledAt');
    case 'SCHEDULED_EMAIL_LIMIT_EXCEEDED': return new ApiError(429, d.code, `This workspace already has ${count(d.cap!)} scheduled emails waiting. Cancel some or wait for them to send.`, 'scheduledAt', true);
    case 'PENDING_EMAIL_LIMIT_EXCEEDED': return new ApiError(429, d.code, `This submission exceeds the outstanding email limit of ${d.cap} for this workspace. Wait for queued mail to dispatch before retrying.`, undefined, true);
    case 'REGION_SETTINGS_NOT_INITIALIZED': return new ApiError(503, d.code, 'Run database migrations to initialize SES region settings.');
    case 'SENDER_DOMAIN_FORBIDDEN': return item(denied(d.code, 'This API key cannot send from this domain or its parent domain.', { permission: 'sendEmail', level: 'on' }, 'from'));
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
    case 'ENCODED_MESSAGE_TOO_LARGE': return item(new ApiError(413, d.code, `Estimated encoded MIME exceeds the ${SEND_LIMITS.encodedBytes / 1_000_000} MB message limit, Amazon SES's maximum.`));
    case 'HOSTED_AUTO_PAUSE_REQUIRED': return new ApiError(422, d.code, 'Automatic bounce and complaint pauses cannot be disabled on Hosted shared sending.', 'autoPause');
    case 'CAMPAIGN_PENDING_LIMIT_EXCEEDED': return new ApiError(429, d.code, `Campaigns may reserve ${count(SEND_LIMITS.campaignPendingKey)} outstanding recipients per sender key and ${count(SEND_LIMITS.campaignPendingWorkspace)} per workspace. Wait for dispatch or cancel an active campaign.`, undefined, true);
    case 'SENDER_BINDING_CHANGED': return new ApiError(409, d.code, 'The reviewed sending binding is no longer ready.');
    case 'NOT_FOUND': return new ApiError(404, d.code, 'Campaign was not found.');
    case 'CAMPAIGN_ARCHIVED': return new ApiError(409, d.code, 'Restore this campaign before sending a test.');
    case 'CAMPAIGN_LOCKED': return new ApiError(409, d.code, 'The campaign changed while it was being sent; fetch it and try again.', undefined, true);
    case 'BUILTIN_DOMAIN_RECIPIENT': case 'BUILTIN_DOMAIN_LIMIT': case 'BUILTIN_DOMAIN_UNSUPPORTED': case 'BUILTIN_DOMAIN_UNAVAILABLE': case 'BUILTIN_DOMAIN_REVOKED': case 'OWN_DOMAIN_VERIFIED':
      return item(builtinRefusal(runtime.config, d));
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
  if (!d.allowed) {
    const error = refusal(runtime, d, local);
    // A send refused at the daily limit is also told by email and to the operators, each at most once a day (app.ts
    // onError, account-notices.ts and operator-alerts.ts).
    if (d.code === 'SEND_LIMIT_REACHED' && d.window !== 'hour' && error instanceof ApiError) error.limitReachedFor = workspaceId;
    throw error;
  }
  return d;
}
