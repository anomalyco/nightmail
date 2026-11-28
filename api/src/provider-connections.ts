import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { auditContext, auditInsert, recordAudit, type AuditContext } from './audit.js';
import { ApiError, denied, errors, logError, ModuleLoadError, notFound, wrapModuleLoad } from './core/errors.js';
import { assertSesConfigured, isSimulatedSes } from './core/ses.js';
import { id, json, response } from './core/http.js';
import { log } from './log.js';
import type { App, Ctx, Runtime, JobHandler } from './core/types.js';
import { caller, assume, platformCredentials } from './provider-credentials.js';
import { awsError, discoverSes, feedbackUrl, loadSetupSdk, POOL_INSTALLATION, poolTenantName, provisionSes, provisionTenant, setupResources, verifiedByoDomains, type SesDiscovery, byoStackName } from './ses-setup.js';
import { builtinClaim, builtinSettingUp, importByoClaims, releaseConnectionClaims } from './domain-claims.js';
import { SEND_LIMITS } from './send-limits.js';
import { regionPattern, getRegionSettings } from './ses-region-state.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { loadMailboxSetupSdk, preparePoolReceiving } from './mailbox-setup.js';
import { byoEnabled } from './byo-pilot.js';
import { hostedAllowance, type HostedAllowance } from './hosted-sending.js';
import { requirePlatformAccount } from './config.js';
import { Accepted, DisconnectSummary, Imports, InventoryFields, ProductionAccess, ProductionAccessState, RegionStatus, StackUpdate, disconnectV5, enrollV5, inventory, prepareStackUpdate, refreshScan, regionLabels, requestProductionAccess, selectImports, statuses, v5Link, type V5Connection } from './byo-regional.js';
import { BYO_TEMPLATE_VERSIONS, byoFeatures, versionAtLeast } from './byo-permissions.js';
import { CONNECTION_STATES, TENANT_STATES, assertConnectionTransition, campaignActive, desiredTenantStatus, finishProvisioning, notProvisioning, poolReceives, poolSends, setPoolState, setTenantState, startProvisioning, queueTenantJob, type ConnectionState, type TenantState } from './states.js';

const tags = ['Workspaces'], security = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
const Kind = z.enum(['shared', 'byo']);
const AccountId = z.string().regex(/^\d{12}$/).openapi({ example: '123456789012' });
const Create = z.object({ kind: Kind, region: z.string().max(32).regex(regionPattern).optional(), awsAccountId:AccountId.optional() }).strict().openapi('CreateConnection');
const State = z.enum(CONNECTION_STATES).describe('awaiting_role: waiting for the BYO stack. provisioning: verifying regional resources and importing verified domains. ready: sending allowed once the tenant is ready. failed: the last setup attempt failed; verify again.');
const Tenant = z.enum(TENANT_STATES).describe('Hosted only: the SES tenant that isolates this workspace. Sends are rejected with TENANT_NOT_READY until it is ready. BYO connections are always ready.');
const Connection = z.object({ id: z.string(), kind: Kind, region: z.string(), state: State, tenant: Tenant, importedDomains: z.number().int().nonnegative().describe('Number of currently claimed domains imported from this BYO account.'), awsAccountId: z.string().nullable(), roleArn: z.string().nullable(), templateVersion: z.string().nullable(), quickCreateUrl: z.url().nullable(), stack: z.object({ version: z.string().nullable().describe('The role template version the stack reports.'), latest: z.string().describe('The newest published role template.'), updateAvailable: z.boolean().describe('updateConnectionStack can prepare an update to the newest template.'), features: z.array(z.string()).describe('Features the stack\'s template grants.'), deleted: z.boolean().describe('The stack was deleted in AWS.'), error: z.string().nullable().describe('Why the last stack was refused, to show in setup.') }).nullable().describe('A connected AWS account\'s CloudFormation stack (regional bring-your-own AWS only).'), health: z.object({ checkedAt: z.iso.datetime(), issues: z.array(z.object({ code: z.string(), region: z.string().optional(), message: z.string() })) }).nullable().describe('The connected account\'s last health check: what needs attention.'),...InventoryFields }).openapi('ProviderConnection');
// Safe for every workspace member: no account IDs, role ARNs or external IDs.
export const ConnectionSummary = z.object({ kind: Kind, region: z.string(), state: State, tenant: Tenant,
  sendingPause: z.object({ at: z.iso.datetime(), reason: z.string() }).nullable().describe('Hosted reputation hold: sending and dispatch are paused until operator review. Receiving is unaffected.'),
  sendingLimit: z.object({
    cap: z.number().int().nullable().describe('Recipients allowed per rolling 24 hours. Null when this workspace has no daily limit: in good standing (GET /v1/sender-score) or exempt.'),
    used: z.number().int().describe('Recipients charged in the current rolling 24 hours, including SES simulator addresses.'),
    resetAt: z.iso.datetime().nullable().describe('When capacity next frees up or the limit changes.'),
    nextCap: z.number().int().nullable().describe('After a resume, the limit that applies when its reduced limit ends; null otherwise, and null when no daily limit follows.'),
    nextCapAt: z.iso.datetime().nullable().describe('When nextCap applies.'),
  }).nullable().optional().describe('Hosted only: the daily limit (set by the sender score) that POST /v1/emails/send enforces with 429 SEND_LIMIT_REACHED.'),
  standing: z.object({ step: z.enum(['ok', 'notice', 'warn', 'restrict', 'pause']), marketingHeld: z.boolean() }).nullable().optional()
    .describe('Hosted only: the enforcement step summary. GET /v1/sender-score has the reasons, the limit math and what an owner can release.'),
  domains: z.object({ total: z.number().int(), verified: z.number().int() }).optional().describe('Domains of its own the workspace claimed and how many can send. The built-in domain is not one of them.'),
  sent: z.boolean().optional().describe('Whether this workspace has any sent email in its log (test sends included; the log keeps 30 days).'),
  received: z.boolean().optional().describe('Whether this workspace has received any email (kept as long as its received mail is).'),
  builtinDomain: z.object({ id: z.string().nullable().describe('Its ID in listDomains, once it is set up on this connection.'), name: z.string(),
    sending: z.enum(['ready', 'pending', 'closed', 'off']).describe('ready: it sends now (in a new workspace\'s first seconds, a send waits for its setup to finish). pending: it is being set up. closed: a domain of the workspace\'s own verified, so it only receives now. off: it sends nothing: turned off by the operator, or paused with every built-in domain (paused).'),
    paused: z.literal(true).optional().describe('Present while sending from every built-in domain is paused (the circuit breaker on their shared reputation) until an operator turns it back on. Mail still queued from it when it paused was canceled; it keeps receiving.'),
    scope: z.enum(['anyone', 'members']).describe('Who it sends to: anyone, or the verified addresses of the workspace\'s members.'), perDay: z.number().int(), perMinute: z.number().int(),
    used: z.number().int().describe('Recipients it sent to in the rolling 24 hours, counted as perDay counts them; 0 once it no longer sends.'),
    repliesToSenders: z.literal(true).optional().describe('Present when, though it sends to members only, a reply (replyToInboundThread) may go once to the sender of the message it answers, if that sender passed authentication.') })
    .nullable().optional().describe('Hosted only: the subdomain of the installation\'s own domain this workspace sends and receives on before it verifies a domain of its own (sendEmail from any address at it), with who it sends to and its recipient caps. Absent when the installation has none; null until this workspace has one.'),
  attention: z.string().optional().describe('A connected AWS account\'s most pressing health finding, for a banner; absent when nothing needs attention.'),
}).openapi('ConnectionSummary');
type Row = { id: string; stack_name?: string | null; workspace_id: string; kind: 'shared' | 'byo'; region: string; state: ConnectionState; tenant_state: TenantState; aws_account_id: string | null; role_arn: string | null; external_id: string | null; platform_principal_arn: string | null; template_version: string | null; confirmed_message_id: string | null; paused_at?: string | null; pause_reason?: string | null; imported_domains?: number; stack_template_version?: string | null; stack_deleted_at?: string | null; stack_error?: string | null; stack_id?: string | null; health?: { checkedAt: string; issues: { code: string; region?: string; message: string }[] } | null };

function owner(c: Ctx) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard' || (a.role !== 'owner' && a.role !== 'admin')) throw denied('PERMISSION_DENIED', 'Use an owner or admin dashboard session to manage sending connections.', { permission: 'configuration', level: 'write', credential: 'dashboard', person: 'admin' });
  return a.workspaceId;
}
function template(runtime: Runtime) {
  if (!runtime.config.byoTemplateUrl) throw new ApiError(503, 'BYO_NOT_CONFIGURED', 'Bring-your-own AWS is not configured.');
  return runtime.config.byoTemplateUrl;
}
const platformRegion = 'us-east-2';
const sharedRegions = (runtime: Runtime) => runtime.config.regionalSending ? [platformRegion] : runtime.config.sharedRegions ?? [platformRegion];
const principals = new Map<string, { account: string; arn: string }>();
async function platformIdentity(runtime: Runtime, expectedAccount?: string) {
  if (expectedAccount && runtime.config.platformAccount && expectedAccount!==runtime.config.platformAccount) throw new ApiError(503,'AWS_ACCOUNT_MISMATCH','This pool belongs to a different platform account.',undefined,true);
  const key = platformCredentials(runtime), cached = principals.get(key.accessKeyId);
  // A key from another environment must never provision or bind this installation's pool.
  const mismatch = (account: string) => (expectedAccount && account !== expectedAccount) || (runtime.config.platformAccount && account !== runtime.config.platformAccount);
  if (cached) {
    if (mismatch(cached.account)) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    return cached;
  }
  const identity = await caller(platformRegion, key);
  if (!identity.Account || !/^\d{12}$/.test(identity.Account) || !identity.Arn?.startsWith(`arn:aws:iam::${identity.Account}:user/`)) throw new ApiError(503, 'PLATFORM_PRINCIPAL_INVALID', 'Use an IAM user in the commercial AWS partition for the platform connection.');
  if (mismatch(identity.Account)) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
  const value = { account: identity.Account, arn: identity.Arn };
  principals.set(key.accessKeyId, value); return value;
}
// Commercial regions with an SES sending endpoint: https://docs.aws.amazon.com/general/latest/gr/ses.html
const byoRegions = ['us-east-2', 'us-east-1', 'us-west-1', 'us-west-2', 'af-south-1', 'ap-south-2', 'ap-southeast-3', 'ap-southeast-5', 'ap-south-1', 'ap-northeast-3', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-south-1', 'eu-west-3', 'eu-north-1', 'eu-central-2',
  'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1'];
const stackName = (row: Row) => row.stack_name ?? byoStackName('Bane', row.id);
function view(runtime: Runtime, row: Row) {
  let quickCreateUrl: string | null = null;
  if (row.template_version==='v5' && row.state!=='disconnecting' && runtime.config.byoV2 && runtime.config.byoV5TemplateUrl && !row.aws_account_id) quickCreateUrl=v5Link(runtime,row);
  if (row.kind === 'byo' && row.template_version!=='v5' && (row.state === 'awaiting_role' || row.state === 'failed')) {
    const params = new URLSearchParams({ templateURL: template(runtime), stackName: stackName(row), param_ExternalId: row.external_id!, param_PlatformPrincipalArn: row.platform_principal_arn!, param_ReceiveMail: 'true',
      param_ConnectionId: row.id, param_ResourcePrefix: setupResources(row.id).topicName.replace(/-feedback$/, ''), param_FeedbackUrl: feedbackUrl({ publicUrl: runtime.config.publicUrl }) });
    quickCreateUrl = `https://${row.region}.console.aws.amazon.com/cloudformation/home?region=${row.region}#/stacks/create/review?${params}`;
  }
  return { id: row.id, kind: row.kind, region: row.region, state: row.state, tenant: row.tenant_state, importedDomains: row.imported_domains ?? 0, awsAccountId: row.aws_account_id, roleArn: row.role_arn, templateVersion: row.template_version, quickCreateUrl,
    stack: row.template_version==='v5' ? { version: row.stack_template_version ?? null, latest: BYO_TEMPLATE_VERSIONS.at(-1)!, updateAvailable: !!row.stack_id && !versionAtLeast(row.stack_template_version, BYO_TEMPLATE_VERSIONS.at(-1)!), features: byoFeatures(row.stack_template_version), deleted: !!row.stack_deleted_at, error: row.stack_error ?? null } : null,
    health: row.template_version==='v5' ? row.health ?? null : null };
}
async function get(runtime: Runtime, wid: string) {
  return (await runtime.db.execute<Row>(sql`SELECT c.*, (SELECT count(*)::int FROM domain_claims dc WHERE dc.connection_id=c.id AND dc.identity @> '{"imported":true}') AS imported_domains FROM provider_connections c WHERE workspace_id=${wid}`)).rows[0];
}
export type ConnectionSummaryRow = Pick<Row, 'kind' | 'region' | 'state' | 'tenant_state'> & {attention: string | null; paused_at: string | null; pause_reason: string | null; domains: number; verified_domains: number; sent: boolean; received: boolean; allowance: HostedAllowance | null; builtin: { id: string | null; name: string; sending: 'ready' | 'pending' | 'off'; paused?: true; used: number } | null};
export function connectionSummaryQuery(runtime: Runtime, wid: string) {
  // Read the same allowance admission enforces, without taking its row locks.
  const builtin = runtime.config.multiTenant && runtime.config.builtinDomain ? runtime.config.builtinScope : null;
  return sql`
    SELECT c.kind, c.region, c.state, c.tenant_state, c.paused_at, c.pause_reason, c.health->'issues'->0->>'message' AS attention,
      (SELECT count(*)::int FROM domain_claims dc WHERE dc.workspace_id=c.workspace_id AND NOT ${builtinClaim(sql`dc`)}) AS domains,
      (SELECT count(*)::int FROM domain_claims dc WHERE dc.workspace_id=c.workspace_id AND dc.sending_state IN ('verified','lost') AND NOT ${builtinClaim(sql`dc`)}) AS verified_domains,
      -- Ordered scalar probes keep the workspace indexes even for a workspace with no mail. EXISTS can
      -- discard ordering and choose a low-startup-cost sequential scan of every other workspace's mail.
      coalesce((SELECT true FROM sending_emails e WHERE e.workspace_id=${wid} ORDER BY e.created_at DESC,e.id DESC LIMIT 1),false) AS sent,
      coalesce((SELECT true FROM mail_messages m WHERE m.workspace_id=${wid} AND m.direction='inbound' ORDER BY m.received_at DESC,m.id DESC LIMIT 1),false) AS received,
      ${builtin ? sql`(SELECT jsonb_build_object('id',d.id,'name',b.name,'sending',CASE WHEN b.revoked_at IS NOT NULL OR tripped.at IS NOT NULL THEN 'off'
            WHEN dc.sending_state='verified' OR ${builtinSettingUp(sql`dc`, runtime.config.builtinDomain!)} THEN 'ready' ELSE 'pending' END,
          -- Its recipients in the rolling 24 hours, as send_admission counts them against its daily cap; read only while it can
          -- send (no verified domain of the workspace's own), so a busy workspace's own mail is never scanned for it.
          'used',CASE WHEN b.revoked_at IS NULL AND NOT EXISTS (SELECT FROM domain_claims o WHERE o.workspace_id=b.workspace_id AND o.sending_state IN ('verified','lost') AND NOT ${builtinClaim(sql`o`)})
            THEN (SELECT coalesce(sum(jsonb_array_length(e.to_addresses)+jsonb_array_length(e.cc_addresses)+jsonb_array_length(e.bcc_addresses)),0)::int FROM sending_emails e
              WHERE e.workspace_id=b.workspace_id AND e.created_at>now()-interval '24 hours' AND lower(split_part(e.from_address,'@',2))=b.name) ELSE 0 END)||CASE WHEN b.revoked_at IS NULL AND tripped.at IS NOT NULL THEN '{"paused":true}'::jsonb ELSE '{}'::jsonb END
        FROM builtin_domains b LEFT JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name AND dc.identity ? 'builtin'
        LEFT JOIN operation_domains d ON d.workspace_id=b.workspace_id AND d.name=b.name AND dc.name IS NOT NULL
        LEFT JOIN LATERAL (SELECT p.tripped_at AS at FROM builtin_parent p WHERE p.name=${runtime.config.builtinDomain} AND p.tripped_at IS NOT NULL) tripped ON true WHERE b.workspace_id=c.workspace_id)` : sql`NULL::jsonb`} AS builtin,
      CASE WHEN c.kind='shared' THEN ${hostedAllowance(runtime.config, wid, 1, 0, true)} END AS allowance
    FROM provider_connections c WHERE c.workspace_id=${wid}`;
}
export function connectionSummaryOf(runtime: Runtime, row: ConnectionSummaryRow | null | undefined): z.infer<typeof ConnectionSummary> | null {
  if (!row) return null;
  const builtin = runtime.config.multiTenant && runtime.config.builtinDomain ? runtime.config.builtinScope : null;
  const iso = (value: string | null | undefined) => value ? new Date(value).toISOString() : null;
  const allowance = row.allowance;
  return { kind: row.kind, region: row.region, state: row.state, tenant: row.tenant_state, sendingPause: row.paused_at ? { at: new Date(row.paused_at).toISOString(), reason: row.pause_reason! } : null,
    sendingLimit: allowance ? { cap: allowance.cap, used: Number(allowance.used), resetAt: iso(allowance.resetAt), nextCap: allowance.nextCap ?? null, nextCapAt: iso(allowance.nextCapAt) } : null,
    standing: allowance ? { step: (allowance.step ?? 'ok') as 'ok', marketingHeld: !!allowance.marketingHeld } : null,
    domains: { total: row.domains, verified: row.verified_domains }, sent: row.sent, received: row.received, ...(row.attention ? { attention: row.attention } : {}),
    // Sending from the built-in domain closes once a domain of the workspace's own verifies (send_admission).
    ...(builtin ? { builtinDomain: row.builtin ? { ...row.builtin, sending: row.builtin.sending !== 'off' && row.verified_domains > 0 ? 'closed' : row.builtin.sending, scope: builtin, ...SEND_LIMITS.builtin[builtin], ...(builtin === 'members' && runtime.config.builtinReplies ? { repliesToSenders: true as const } : {}) } : null } : {}) };
}
export async function connectionSummary(runtime: Runtime, wid: string) {
  return connectionSummaryOf(runtime,(await runtime.db.execute<ConnectionSummaryRow>(connectionSummaryQuery(runtime,wid))).rows[0]);
}
function checkProvisioned(report: SesDiscovery, pooled: boolean, allowSandbox = false) {
  // Domain verification and a BYO customer's production-access request are separate onboarding steps.
  const blocker = report.blockers.find(b => b.code !== 'SES_DOMAIN_REQUIRED' && ((pooled && !allowSandbox) || b.code !== 'SES_SANDBOX'));
  if (report.provisioned && !blocker) return;
  if (blocker?.code === 'SNS_CONFIRMATION_PENDING') throw new ApiError(409, blocker.code, 'Waiting for AWS to confirm the feedback subscription. Retry shortly.', undefined, true);
  const retryable=!blocker || ['AWS_THROTTLED','AWS_SETUP_TIMEOUT','AWS_SETUP_FAILED','AWS_STATE_UNKNOWN','SNS_SUBSCRIPTION_UNKNOWN'].includes(blocker.code);
  throw new ApiError(409, blocker?.code ?? 'PROVISIONING_INCOMPLETE', blocker?.message ?? 'AWS setup is not confirmed yet. Retry this request.', undefined, retryable);
}

// The pool's sending and receiving states are explicit; the lease only fences one setup run per region
// so a crashed isolate's attempt can be retried without a DB transaction spanning AWS calls.
type Pool = { sending: boolean; receiving: boolean; aws_account_id: string;legacy_names:boolean };
async function getPool(runtime: Runtime, region: string) {
  return (await runtime.db.execute<Pool>(sql`SELECT ${poolSends()} AS sending, (${poolReceives()} AND coalesce(receiving_checked_at,'-infinity')>now()-interval '1 day') AS receiving, aws_account_id,legacy_names FROM provider_pool_regions p WHERE region=${region}`)).rows[0];
}
async function ensurePool(runtime: Runtime, principal:Awaited<ReturnType<typeof platformIdentity>>, region: string) {
  await Promise.all([loadSetupSdk(), loadMailboxSetupSdk()]);
  const account=principal.account;
  const lease = new Date(Date.now() + 180_000).toISOString();
  const fresh=sql`(${poolReceives(sql`provider_pool_regions`)} AND coalesce(provider_pool_regions.receiving_checked_at,'-infinity')>now()-interval '1 day')`;
  const result = await runtime.db.execute<Pick<Pool,'sending'|'receiving'>>(sql`INSERT INTO provider_pool_regions(region, aws_account_id, lease_until) VALUES (${region}, ${account}, ${lease})
    ON CONFLICT(region) DO UPDATE SET lease_until=excluded.lease_until WHERE provider_pool_regions.legacy_names AND NOT (${poolSends(sql`provider_pool_regions`)} AND ${fresh})
      AND provider_pool_regions.aws_account_id=excluded.aws_account_id AND coalesce(provider_pool_regions.lease_until, '-infinity') <= now() RETURNING ${poolSends(sql`provider_pool_regions`)} AS sending,${fresh} AS receiving`);
  if (!result.rowCount) {
    const pool = await getPool(runtime, region);
    if (pool?.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    if (pool.sending && pool.receiving) return;
    throw busy();
  }
  const owned = sql`region=${region} AND lease_until=${lease}::timestamptz`;
  try {
    const scoped = { ...runtime, config: { ...runtime.config, awsAccountId: account, sesFeedbackUrl: undefined } };
    // Independent checkpoints. Sending sandbox/feedback failures cannot skip receiving, and
    // waiting for an inbound confirmation must not block a healthy outbound pool either.
    let receiveFailure: unknown;
    if (!result.rows[0]!.receiving) try {
      const bucket=await preparePoolReceiving(scoped,region,account,async(_account,_bucket,arn)=>{
        if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET inbound_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      });
      if (!(await runtime.db.execute(setPoolState(owned,'receiving_state',sql`,inbound_bucket=${bucket},receiving_checked_at=now()`))).rowCount) throw busy();
    } catch(e) {
      receiveFailure=e;
      // A simultaneous outbound failure can be the one that escapes this run.
      // Keep the receiving resource/operator action visible independently.
      if (e instanceof ApiError && e.code==='POOL_RECEIVING_DRIFT') log('warn',{operation:'shared-receiving-setup',region,code:e.code});
    }
    if (!result.rows[0]!.sending) {
      const report = await provisionSes(scoped, { region, installationId: POOL_INSTALLATION, verifiedPoolPrincipal:principal, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
      checkProvisioned(report, true, runtime.config.allowSesSandbox);
      if (!(await runtime.db.execute(setPoolState(owned,'sending_state'))).rowCount) throw busy();
    }
    if(receiveFailure) throw receiveFailure;
  } finally { await runtime.db.execute(sql`UPDATE provider_pool_regions SET lease_until=NULL WHERE ${owned}`); }
}
const busy = () => new ApiError(409, 'CONNECTION_BUSY', 'Connection setup is already in progress. Retry shortly.', undefined, true);
function uniqueAccount(error: unknown) {
  const e = (error as { cause?: unknown })?.cause ?? error;
  return (e as { code?: string })?.code === '23505' && (e as { constraint?: string }).constraint === 'provider_connections_byo_account';
}
type Confirmation = { messageId: string; confirm: () => Promise<void> };
async function wakeByoJob(runtime: Runtime, connectionId: string) {
  const wake = async (r: Runtime) => { try { await r.wake?.(1); } catch { log('warn',{code:'QUEUE_WAKE_FAILED',connectionId}); } };
  if (runtime.deferNudge) runtime.deferNudge(wake); else await wake(runtime);
}
// This lookup authorizes only signature verification for a SubscriptionConfirmation, never a notification.
export async function byoStackTopic(runtime: Runtime, arn: string) {
  const match = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):(bane-[0-9a-f]{20})-feedback$/.exec(arn);
  if (!match) return;
  const [, region, account, prefix] = match;
  const row = (await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE resource_prefix=${prefix} AND region=${region} AND kind='byo'
    AND template_version IS DISTINCT FROM 'v5' AND (template_version='v4' OR feedback_topic_arn IS NULL) AND (aws_account_id IS NULL OR aws_account_id=${account}) AND split_part(platform_principal_arn,':',5)<>${account}`)).rows[0];
  if (!row || setupResources(row.id).topicName !== `${prefix}-feedback`) return;
  return (confirmation: Confirmation) => provision(runtime, row, account!, confirmation);
}
// The same code regional cleanup answers with (byo-regional.ts): a repeated DELETE finishes the disconnect.
const disconnecting = () => new ApiError(409, 'CONNECTION_DISCONNECTING', 'This connection is being disconnected. Repeat DELETE /v1/connection to finish.');
async function provision(runtime: Runtime, row: Row, account: string, confirmation?: Confirmation, audit?: AuditContext) {
  if (row.template_version==='v5') throw new ApiError(409,'REGIONAL_SETUP_REQUIRED','This connection requires regional setup, not stack import.');
  const roleArn = `arn:aws:iam::${account}:role/${stackName(row)}`;
  if (row.platform_principal_arn!.split(':')[4] === account) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'The shared sending account cannot be used as a customer account.');
  if (row.aws_account_id && row.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Disconnect before choosing a different AWS account.');
  if (confirmation && row.confirmed_message_id === confirmation.messageId && row.state !== 'failed') {
    // A duplicate can arrive after the worker saw SNS's eventually consistent PendingConfirmation.
    if (row.state==='provisioning' && (await runtime.db.execute(sql`UPDATE jobs SET available_at=now() WHERE id=${'byo.verify:'+row.id}
      AND status='pending' AND (last_error='SNS_CONFIRMATION_PENDING' OR payload->>'retryCode'='SNS_CONFIRMATION_PENDING') AND available_at>now()`)).rowCount) await wakeByoJob(runtime,row.id);
    return row;
  }
  if (row.state === 'disconnecting') throw disconnecting(); // Not an AWS failure: no transition leaves the fence.
  if (row.state === 'ready' && !confirmation) return row;
  if (row.template_version !== 'v4' && !confirmation) await loadSetupSdk();
  const credentials = await assume(runtime, row.region, roleArn, row.external_id!, true);
  const scoped = { ...runtime, config: { ...runtime.config, aws: credentials, awsAccountId: account, sesFeedbackUrl: undefined, workspaceId: row.workspace_id } };
  const lease = new Date(Date.now() + 240_000).toISOString();
  // Reserve the verified BYO account BEFORE creating resources in it. The unique index serializes racing workspaces.
  // A manually started v4 job can be waiting for this very callback; don't wait on its lease.
  let join = (row.template_version === 'v4' || !!confirmation) && ['provisioning','ready'].includes(row.state) && row.aws_account_id === account;
  if (!join) try {
    assertConnectionTransition(row.state, 'provisioning');
    if (!(await runtime.db.execute(startProvisioning(row.id, account, roleArn, lease))).rowCount) {
      const current = await get(runtime,row.workspace_id);
      if (!current || current.id!==row.id || current.aws_account_id!==account || !['provisioning','ready'].includes(current.state)) throw busy();
      // The concurrent request already reserved precisely this proven account. Legacy manual
      // provisioning has one writer; v4 can safely join the callback/queue handoff.
      if (!confirmation && (current.state==='ready' || current.template_version!=='v4')) return current;
      row=current; join=true;
    }
  } catch (e) { if (uniqueAccount(e)) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'This AWS account is already connected to a workspace.'); throw e; }
  const owned = sql`id=${row.id} AND lease_until=${lease}::timestamptz`;
  try {
    if (confirmation && row.confirmed_message_id !== confirmation.messageId) await confirmation.confirm(); // Only after external-ID proof and exclusive account reservation.
    if (row.template_version !== 'v4' && !confirmation) {
      // Legacy stacks contain only a role; their manual fallback still provisions dedicated resources.
      const report = await provisionSes(scoped, { region: row.region, installationId: row.id, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_connections SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
      checkProvisioned(report, false);
    }
    const arn = `arn:aws:sns:${row.region}:${account}:${setupResources(row.id).topicName}`;
    const result = await runtime.db.execute<Row>(sql`WITH bound AS (UPDATE provider_connections SET feedback_topic_arn=${arn},
      confirmed_message_id=coalesce(${confirmation?.messageId ?? null},confirmed_message_id),template_version=CASE WHEN ${!!confirmation} THEN 'v4' ELSE template_version END
      WHERE id=${row.id} AND aws_account_id=${account} AND state IN ('provisioning','ready') RETURNING *),
      queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'byo.verify:'||id,'byo.verify',workspace_id,jsonb_build_object('connectionId',id) FROM bound WHERE state='provisioning'
        ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status IN ('failed','completed') OR
          (${!!confirmation} AND jobs.status='pending' AND (jobs.last_error='SNS_CONFIRMATION_PENDING' OR jobs.payload->>'retryCode'='SNS_CONFIRMATION_PENDING')))
      ${audit && !join ? sql`, audit AS (${auditInsert(audit, { action: 'connection.verify', workspaceId: row.workspace_id, target: { type: 'connection', id: row.id }, before: { state: row.state },
        after: sql`jsonb_build_object('state',bound.state,'kind',bound.kind,'region',bound.region)` }, { from: sql`bound` })})` : sql``}
      SELECT * FROM bound`);
    if (!result.rows[0]) throw busy();
    if (result.rows[0].state === 'provisioning') await wakeByoJob(runtime,row.id);
    return result.rows[0];
  } catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    // Waiting on AWS (SNS confirmation) is not a failure; the stack stays and verify is retried.
    if (!join) await runtime.db.execute(finishProvisioning(sql`${owned} AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=${'byo.verify:'+row.id} AND status IN ('running','pending'))`, awsError(e).retryable ? 'awaiting_role' : 'failed'));
    throw e;
  }
}

// SNS confirmation has a short HTTP delivery deadline. Keep paced SES reads off that request and
// checkpoint each page. Imported claims cannot authorize sends until the last page commits ready.
export const byoVerifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || typeof payload.connectionId !== 'string') return;
  const row = (await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE workspace_id=${job.workspaceId} AND id=${payload.connectionId}`)).rows[0];
  if (!row || row.id !== payload.connectionId || row.kind !== 'byo' || row.state !== 'provisioning' || row.template_version==='v5') return;
  const owned = sql`id=${row.id} AND EXISTS (SELECT 1 FROM jobs WHERE id=${job.id} AND status='running' AND attempts=${job.attempts})`;
  try {
    const cursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
    const scoped = { ...runtime, config: { ...runtime.config, aws: await assume(runtime, row.region, row.role_arn!, row.external_id!, !cursor), awsAccountId: row.aws_account_id!, workspaceId: row.workspace_id, sesFeedbackUrl: undefined } };
    if (!cursor) {
      const report = await discoverSes(scoped, { region: row.region, installationId: row.id, connectionSetup: true });
      if (report.account && report.account.id !== row.aws_account_id) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The verified role no longer matches this account.');
      checkProvisioned(report, false);
    }
    const { domains, next } = await verifiedByoDomains(scoped, row.region, cursor);
    await runtime.db.transaction(async tx => {
      await getRegionSettings(tx,row.workspace_id,'update'); // Same lock order as disconnect.
      if (!(await tx.execute(sql`UPDATE provider_connections SET lease_until=now()+interval '4 minutes' WHERE state='provisioning' AND ${owned}`)).rowCount) return;
      await importByoClaims(tx, row, domains);
      if (!next) await tx.execute(sql`WITH ready AS (${finishProvisioning(owned,'ready')} RETURNING *),
        stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL, report=NULL FROM ready r WHERE d.workspace_id=r.workspace_id)
        UPDATE ses_installation_settings s SET installation_id=r.id,default_region=r.region,enabled_regions=jsonb_build_array(r.region) FROM ready r WHERE s.workspace_id=r.workspace_id`);
    });
    if (next) throw new JobDeferred(new Date().toISOString(), { connectionId: row.id, cursor: next });
  } catch (e) {
    if (e instanceof JobDeferred || e instanceof ModuleLoadError) throw e;
    const error = awsError(e);
    if (!error.retryable) await runtime.db.execute(finishProvisioning(owned,'failed'));
    else if (error.code==='SNS_CONFIRMATION_PENDING' || job.attempts>=MAX_ATTEMPTS) {
      // Poll, don't exhaust attempts or strand a connection on a transient outage. A signed
      // confirmation advances a pending SNS poll immediately without superseding a running page.
      throw new JobDeferred(new Date(Date.now()+(error.code==='SNS_CONFIRMATION_PENDING'?15_000:300_000)).toISOString(),{...payload,retryCode:error.code});
    }
    throw error;
  }
});
// The one tenant path. CreateTenant is idempotent, so concurrent callers need no lease: both converge on `ready`.
// Called by createConnection, its retry job, the hourly reconcile and domain verification; never by sending.
type TenantTarget = Pick<Row, 'id' | 'region' | 'tenant_state'> & { pool_account: string | null;pool_tenant_name:string|null;managed_tenant:boolean;namespace?:'trusted'|'probation' };
async function tenantTarget(runtime: Runtime, wid: string, connectionId: string) {
  return (await runtime.db.execute<TenantTarget>(sql`SELECT c.id,c.region,c.tenant_state,c.managed_tenant,c.pool_tenant_name,CASE WHEN NOT p.legacy_names THEN p.pool_tier END AS namespace,p.aws_account_id AS pool_account FROM provider_connections c
    LEFT JOIN provider_pool_regions p ON p.region=c.region AND ${poolSends()} AND (c.aws_account_id IS NULL OR c.aws_account_id=p.aws_account_id)
    WHERE c.id=${connectionId} AND c.workspace_id=${wid} AND c.kind='shared'`)).rows[0];
}
export async function ensureTenant(runtime: Runtime, wid: string, connectionId: string) {
  const row = await tenantTarget(runtime, wid, connectionId);
  if (!row || row.tenant_state === 'ready') return;
  if (!row.pool_account) throw new ApiError(503, 'POOL_NOT_READY', 'The shared sending pool for this region is not ready yet.', undefined, true);
  await platformIdentity(runtime, row.pool_account);
  // Record the tenant's ARN: AWS tenant status events are trusted only for a recorded, owned ARN (src/standing.ts).
  const { rows: [owned] } = await runtime.db.execute<{ arn: string }>(sql`SELECT arn FROM hosted_tenant_ownership WHERE workspace_id=${wid} AND region=${row.region}`);
  await provisionTenant(runtime, row.region, row.pool_account, wid,row.managed_tenant,row.namespace,row.pool_tenant_name, { arn: owned?.arn ?? null,
    created: async arn => { await runtime.db.execute(sql`INSERT INTO hosted_tenant_ownership(workspace_id,region,arn) VALUES(${wid},${row.region},${arn}) ON CONFLICT DO NOTHING`); }, fence: async () => {} });
  await runtime.db.execute(setTenantState(row.id, 'ready', row.pool_account));
}
export const tenantJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || isSimulatedSes(runtime) || typeof payload.connectionId!=='string') return;
  try { await ensureTenant(runtime,job.workspaceId,payload.connectionId); }
  catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    // The last retry marks the tenant failed so sends say so; the hourly reconcile keeps trying.
    if (job.attempts >= MAX_ATTEMPTS) await runtime.db.execute(setTenantState(payload.connectionId, 'failed',runtime.config.platformAccount));
    throw e;
  }
});

// Nightmail is the source of truth for the SES tenant status. Every pause and resume bumps provider_connections.tenant_generation;
// hosted_tenant_status records, per regional tenant, what was applied at which generation. The job reads what Nightmail
// wants now (desiredTenantStatus), applies it to every ready tenant that differs, finishes a resume once no ready tenant
// may still be disabled, and runs again if a transition happened meanwhile. A transition while it runs cannot requeue
// it, so the periodic reconcile (tenantStatusDrift) queues anything still out of line: every interleaving converges.
// An outcome AWS may have applied is never forgotten: a disable is journaled as DISABLING before the call (DISABLED once
// AWS confirms), and ENABLED is recorded only after AWS confirms, so a crash or a lost checkpoint leaves "possibly
// disabled", which a resume enables again. Only AWS refusing the call (AccessDenied: the runtime policy lacks
// ses:UpdateReputationEntityCustomerManagedStatus) is a definite "not applied", and restores the previous record.
type Applied = 'ENABLED' | 'DISABLING' | 'DISABLED';
type TenantRow = { id: string; generation: string; desired: 'ENABLED' | 'DISABLED'; region: string; ready: boolean; tenant: string | null; managed_tenant: boolean; arn: string | null; applied: Applied | null; applied_generation: string | null };
export const tenantStatusJob: JobHandler = retryDatabaseFailures(async (runtime, _payload, job) => {
  if (!runtime.config.multiTenant) return;
  const wid = job.workspaceId;
  for (let pass = 0; pass < 3; pass++) {
    const { rows } = await runtime.db.execute<TenantRow>(sql`SELECT c.id,c.tenant_generation::text AS generation,${desiredTenantStatus(sql`c`)} AS desired,r.region,r.tenant_state='ready' AS ready,
        CASE WHEN r.legacy THEN c.pool_tenant_name ELSE r.pool_tenant_name END AS tenant,r.managed_tenant,o.arn,t.applied,t.generation::text AS applied_generation
      FROM provider_connections c JOIN provider_connection_regions r ON r.connection_id=c.id LEFT JOIN hosted_tenant_ownership o ON o.workspace_id=c.workspace_id AND o.region=r.region
      LEFT JOIN hosted_tenant_status t ON t.connection_id=c.id AND t.region=r.region WHERE c.workspace_id=${wid} AND c.kind='shared' ORDER BY r.region`);
    if (!rows.length) return;
    const { id: connection, generation, desired } = rows[0]!;
    const work = rows.filter(r => r.ready && (desired === 'DISABLED' ? !(r.applied === 'DISABLED' && r.applied_generation === generation) : r.applied !== null && r.applied !== 'ENABLED'));
    const record = (region: string, applied: Applied) => runtime.db.execute(sql`INSERT INTO hosted_tenant_status AS t(connection_id,region,applied,generation) VALUES(${connection},${region},${applied},${generation}::bigint)
      ON CONFLICT(connection_id,region) DO UPDATE SET applied=excluded.applied,generation=excluded.generation,applied_at=now()`);
    const restore = (row: TenantRow) => row.applied === null ? runtime.db.execute(sql`DELETE FROM hosted_tenant_status WHERE connection_id=${connection} AND region=${row.region}`)
      : runtime.db.execute(sql`UPDATE hosted_tenant_status SET applied=${row.applied},generation=${row.applied_generation}::bigint WHERE connection_id=${connection} AND region=${row.region}`);
    if (isSimulatedSes(runtime)) for (const row of work) await record(row.region, desired);
    else if (work.length) {
      const { setTenantSendingStatus, mxResourceName } = await wrapModuleLoad(() => import('./ses-setup.js'));
      for (const row of work) {
        if (desired === 'DISABLED') await record(row.region, 'DISABLING');
        let arn: string;
        try { arn = await setTenantSendingStatus(runtime, row.region, row.tenant ?? (row.managed_tenant ? mxResourceName(wid) : `bane-${wid}`), row.arn, desired); }
        catch (error) {
          if (error instanceof ApiError && error.code === 'AWS_ACCESS_DENIED') {
            if (desired === 'DISABLED') await restore(row);
            log('error', { code: 'SES_TENANT_STATUS_DENIED', workspaceId: wid, region: row.region, status: desired }); return;
          }
          throw error; // Unknown outcome: the journal keeps "possibly disabled"; the job retries.
        }
        await record(row.region, desired);
        // A tenant provisioned before ARNs were recorded gets its ARN here (GetTenant in the pool account).
        if (!row.arn) await runtime.db.execute(sql`INSERT INTO hosted_tenant_ownership(workspace_id,region,arn) VALUES(${wid},${row.region},${arn}) ON CONFLICT DO NOTHING`);
      }
    }
    // A resume that waited for its tenants restarts sending once no ready tenant may still be disabled, fenced on its generation.
    await runtime.db.execute(sql`UPDATE provider_connections pc SET paused_at=NULL,pause_reason=NULL,resume_pending_at=NULL WHERE pc.id=${connection} AND pc.resume_pending_at IS NOT NULL
      AND pc.tenant_generation=${generation}::bigint AND NOT EXISTS (SELECT FROM hosted_tenant_status t JOIN provider_connection_regions r ON r.connection_id=t.connection_id AND r.region=t.region
        WHERE t.connection_id=pc.id AND t.applied<>'ENABLED' AND r.tenant_state='ready')`);
    const { rows: [now] } = await runtime.db.execute<{ generation: string }>(sql`SELECT tenant_generation::text AS generation FROM provider_connections WHERE id=${connection}`);
    if (work.length) log('info', { code: 'SES_TENANT_STATUS_SET', workspaceId: wid, status: desired, tenants: work.length, simulated: isSimulatedSes(runtime) });
    if (now?.generation === generation) return;
  }
});

// Platform maintenance, never called by an HTTP request. One failed tenant or region must not stop the rest.
export async function reconcileSharedConnections(runtime: Runtime) {
  if (!runtime.config.multiTenant || isSimulatedSes(runtime)) return;
  for (const region of sharedRegions(runtime)) {
    // Virginia is outbound-only. Its provisioning and enrollment have a separate release gate.
    if (region==='us-east-1') continue;
    try {
      const pool = await getPool(runtime, region);
      if (pool?.legacy_names===false) continue; // The legacy reconciler never owns a newly enrolled pool.
      if (!pool?.sending || !pool.receiving) {
        const principal=await platformIdentity(runtime,pool?.aws_account_id);
        try { await ensurePool(runtime,principal,region); }
        catch (e) {
          if (e instanceof ModuleLoadError) throw e;
          // Receiving (including its separate SNS confirmation) never blocks a healthy sending pool.
          if (!(await getPool(runtime,region))?.sending) throw e;
          log('warn',{operation:'shared-receiving-setup',region,code:awsError(e).code});
        }
      }
      const pending = await runtime.db.execute<Pick<Row,'id'|'workspace_id'>>(sql`SELECT id,workspace_id FROM provider_connections WHERE kind='shared' AND region=${region} AND tenant_state<>'ready'`);
      for (const row of pending.rows) {
        try { await ensureTenant(runtime, row.workspace_id, row.id); }
        catch (e) { if (e instanceof ModuleLoadError) throw e; log('warn', { operation: 'shared-tenant-setup', region, connectionId: row.id, code: awsError(e).code }); }
      }
    } catch (e) { if (e instanceof ModuleLoadError) throw e; const error=awsError(e); log('warn', { operation: 'shared-pool-setup', region, code: error.code }); }
  }
}
async function create(runtime: Runtime, wid: string, input: z.infer<typeof Create>, context: AuditContext, tenantJobAfterSeconds = 0) {
  const { kind } = input, region = input.region ?? (kind === 'shared' ? sharedRegions(runtime)[0]! : platformRegion);
  if (kind === 'byo') template(runtime);
  // Offered regions come from SHARED_SENDING_REGIONS (Ohio at launch; Ireland is inside the IAM boundary).
  const offered = sharedRegions(runtime);
  if (kind === 'shared' && !offered.includes(region)) throw new ApiError(422, 'SHARED_REGION_UNAVAILABLE', `Shared sending is available in ${offered.join(', ')}.`, 'region');
  if (/^(cn-|us-gov-|us-iso|us-isob|eu-isoe|us-isof)/.test(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region.', 'region');
  if (kind === 'byo' && !byoRegions.includes(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region where Amazon SES supports sending.', 'region');
  assertSesConfigured(runtime);
  const audit = (from: SQL, where?: SQL) => auditInsert(context, { action: 'connection.create', workspaceId: wid, target: { type: 'connection', id: sql`${from}.id` }, after: { kind, region } }, { from, where });
  if (kind==='shared') {
    // Hosted is instant: `ready` on creation with zero AWS calls. ensureTenant makes the tenant (startHostedMail, at once,
    // or the tenant job) and flips tenant_state; until then domains and sends answer TENANT_NOT_READY. Simulation has no
    // tenant, so it is ready.
    // The statement's snapshot predates its insert, so only a new connection is audited, not a repeated choice.
    const row = (await runtime.db.execute<Row & { queued: boolean }>(sql`WITH pool AS (SELECT aws_account_id FROM provider_pool_regions p WHERE region=${region} AND ${poolSends()}), connection AS (
      INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state,aws_account_id,managed_tenant,pool_tenant_name) VALUES (${id('conn')},${wid},'shared',${region},'ready',${isSimulatedSes(runtime) ? 'ready' : 'pending'},(SELECT aws_account_id FROM pool),${!!runtime.config.regionalSending},${runtime.config.trustedPool?poolTenantName(wid,'probation'):null})
      ON CONFLICT(workspace_id) DO UPDATE SET aws_account_id=coalesce(provider_connections.aws_account_id,excluded.aws_account_id) WHERE provider_connections.kind='shared' AND provider_connections.region=excluded.region AND provider_connections.state<>'disconnecting' RETURNING *),
      settings AS (UPDATE ses_installation_settings s SET default_region=c.region,enabled_regions=CASE WHEN EXISTS(SELECT FROM provider_connection_regions r WHERE r.connection_id=c.id AND NOT r.legacy AND r.sending_state='ready') THEN s.enabled_regions ELSE jsonb_build_array(c.region) END FROM connection c WHERE c.workspace_id=s.workspace_id),
      stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL,report=NULL FROM connection c WHERE c.workspace_id=d.workspace_id AND d.report IS NOT NULL),
      queued AS (${queueTenantJob(sql`SELECT c.id,c.workspace_id FROM connection c JOIN pool USING (aws_account_id) WHERE c.tenant_state<>'ready'`, tenantJobAfterSeconds)} RETURNING 1),
      audit AS (${audit(sql`connection`, sql`NOT EXISTS (SELECT FROM provider_connections p WHERE p.workspace_id=${wid})`)})
      SELECT c.*, EXISTS (SELECT 1 FROM queued) AS queued FROM connection c`)).rows[0];
    if (!row) { if ((await get(runtime, wid))?.state === 'disconnecting') throw disconnecting(); throw new ApiError(409,'CONNECTION_EXISTS','Disconnect the existing connection before choosing another.'); }
    return row;
  }
  const principalArn = (await platformIdentity(runtime)).arn;
  // BYO sends from the customer's own account: there is no tenant to wait for.
  const connectionId = id('conn'), prefix = setupResources(connectionId).topicName.replace(/-feedback$/, '');
  const result = await runtime.db.execute<Row>(sql`WITH created AS (INSERT INTO provider_connections(id,workspace_id,kind,region,external_id,platform_principal_arn,template_version,state,tenant_state,resource_prefix,stack_name)
    VALUES (${connectionId},${wid},${kind},${region},${crypto.randomUUID()},${principalArn},'v4','awaiting_role','ready',${prefix},${kind === 'byo' ? byoStackName(runtime.config.byoStackPrefix, connectionId) : null})
    ON CONFLICT(workspace_id) DO NOTHING RETURNING *), audit AS (${audit(sql`created`)}) SELECT * FROM created`);
  const row = result.rows[0] ?? await get(runtime, wid);
  if (row?.state === 'disconnecting') throw disconnecting();
  if (!row || row.kind !== kind || row.region !== region) throw new ApiError(409, 'CONNECTION_EXISTS', 'Disconnect the existing connection before choosing another.');
  return row;
}

/** While the request that creates a workspace sets up its sending itself, the fallback jobs wait this long: past the
 * lifetime of that work (a Worker keeps it at most 30 s after its answer). */
const FALLBACK_AFTER_SECONDS = 60;
/**
 * Hosted mail for a workspace: its shared connection and its built-in domain's claim, in this request (database only).
 * With `start` (the request that creates the workspace: sign-up in account-login.ts, createWorkspace), it then starts at
 * once, without waiting for it, its own SES tenant (ensureTenant, the one tenant path) and the built-in domain associated
 * with that tenant (setUpBuiltinDomain, the domain.builtin job's own code). That runs on a database connection of its own
 * (runtime.detach, the Worker's waitUntil): SES takes one control-plane call a second, so it takes about 5 s, and until
 * it ends the domain counts as ready (builtinSettingUp) and a send from it waits for it (awaitBuiltinSetup). What fails is
 * left to the jobs queued here (tenant.provision, domain.builtin), brought forward then, and otherwise due a minute later,
 * when they find the work done. Without `start` (choosing Hosted mail, createConnection) the jobs do it, due now: `wake`.
 * `started` settles when that work has ended (tests wait for it; callers don't).
 */
export async function startHostedMail(runtime: Runtime, wid: string, context: AuditContext, input: z.infer<typeof Create> = { kind: 'shared' }, start = false, here = false) {
  const inline = start && !isSimulatedSes(runtime), after = inline ? FALLBACK_AFTER_SECONDS : 0;
  const row = await create(runtime, wid, input, context, after);
  let wake = 'queued' in row && !!row.queued;
  if (row.kind !== 'shared' || row.state !== 'ready') return { connection: row, wake };
  const builtin = runtime.config.builtinDomain ? await wrapModuleLoad(() => import('./builtin-domain.js')) : null;
  // If this fails the sweep creates it (builtin-domain.ts builtinDomainTick).
  if (builtin) try { if (await builtin.ensureBuiltinDomain(runtime, wid, after)) wake = true; }
    catch (e) { if (e instanceof ModuleLoadError) throw e; logError(e, { code: 'BUILTIN_DOMAIN_SETUP_FAILED', workspaceId: wid }); }
  if (!inline || (row.tenant_state === 'ready' && !builtin)) return { connection: row, wake: wake && !inline };
  const work = async (rt: Runtime) => {
    const started = Date.now(), sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    try {
      // SES takes one control-plane call a second: the association waits a second after the tenant's last call.
      if (row.tenant_state !== 'ready') { await ensureTenant(rt, wid, row.id); if (builtin) await sleep(1000); }
      // A short wait (the platform-wide pace of one call a second) is waited out here, twice at most; a longer one is the job's.
      if (builtin) for (let tries = 1; ; tries++) {
        try { await builtin.setUpBuiltinDomain(rt, wid); break; }
        catch (e) { const ms = e instanceof JobDeferred ? Date.parse(e.availableAt) - Date.now() : Infinity; if (tries > 2 || ms > 3000) throw e; await sleep(Math.max(0, ms)); }
      }
      log('info', { code: 'HOSTED_MAIL_STARTED', workspaceId: wid, ms: Date.now() - started });
    } catch (e) {
      // The jobs take it from here: now, or when a wait (the pace, the parent identity) ends. Without the inline mark, the
      // domain no longer counts as ready meanwhile: onboarding says it is still being set up.
      const at = e instanceof JobDeferred ? e.availableAt : new Date().toISOString();
      try {
        await rt.db.execute(sql`UPDATE jobs SET available_at=least(available_at,${at}::timestamptz),payload=payload-'inline' WHERE id IN ('tenant.provision:'||${row.id}::text,'domain.builtin:'||${wid}::text) AND status='pending'`);
        await rt.wake?.(1);
      } catch { /* They are due a minute later anyway. */ }
      log(e instanceof JobDeferred ? 'info' : 'warn', { code: 'HOSTED_MAIL_DEFERRED', workspaceId: wid, ms: Date.now() - started, availableAt: at, error: e instanceof JobDeferred ? undefined : e instanceof ApiError ? e.code : awsError(e).code });
    }
  };
  // Never awaited here: the request answers now, and the work goes on (on Node, on the server's own pool). `here`: this
  // already runs after an answer (startHostedMailAfter), so it goes on in the same place.
  const started = runtime.detach && !here ? runtime.detach(work) : work(runtime);
  return { connection: row, wake: false, started };
}
/**
 * A new workspace's Hosted mail, started after the request that made it has answered (the sign-up callback, a new
 * workspace): its connection and built-in domain rows, then its SES setup, all on the Worker's waitUntil (runtime.detach),
 * on Node without being awaited. The jobs startHostedMail queues are the fallback, and onboarding starts Hosted mail
 * itself if even the rows were never written. Until they are, the workspace's /v1/me says so at once (hostedSetup).
 */
export function startHostedMailAfter(runtime: Runtime, wid: string, context: AuditContext) {
  const run = async (rt: Runtime) => {
    try { const result = await startHostedMail(rt, wid, context, { kind: 'shared' }, true, true); if ('started' in result) await result.started; }
    catch (e) { logError(e, { code: 'HOSTED_MAIL_START_FAILED', workspaceId: wid }); }
  };
  return runtime.detach ? runtime.detach(run) : run(runtime);
}
/**
 * For how long after a workspace is made GET /v1/me says its Hosted mail is still starting (hostedSetup: 'starting') while
 * its connection or built-in domain isn't written yet: the sign-up writes them after answering (startHostedMailAfter, a few
 * hundred ms). Onboarding reads /v1/me again meanwhile; after it, onboarding starts Hosted mail itself (createConnection).
 */
export const HOSTED_STARTING_SECONDS = 15;
export function registerProviderConnections(app: App) {
  const path = '/v1/connection';
  app.openapi(createRoute({ method: 'get', path, operationId: 'getConnection', tags, security, description: 'Get the current MX workspace connection or null. Poll during BYO setup for awaiting_role, provisioning, ready or failed and the imported domain count. Owner/admin dashboard only.', responses: { 200: response(z.object({ connection: z.union([Connection, z.null()]) })), ...errors } }), async c => {
    const row = await get(c.env, owner(c)); return c.json({ connection: row ? {...view(c.env, row),...(row.template_version==='v5'?await inventory(c.env.db,row as Row & V5Connection):{})} : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/connection/regions', operationId: 'listConnectionRegions', tags, security, description: 'Regions offered for shared sending, and the commercial AWS regions where Amazon SES supports sending for bring-your-own AWS. Owner/admin dashboard only.', responses: { 200: response(z.object({ shared: z.array(z.string()), byo: z.array(z.string()) }).openapi('ConnectionRegions')), ...errors } }), async c => {
    const wid=owner(c); return c.json({ shared: sharedRegions(c.env), byo: await byoEnabled(c.env,wid)?Object.keys(regionLabels):byoRegions }, 200);
  });
  app.openapi(createRoute({ method: 'post', path, operationId: 'createConnection', tags, security, description: 'Choose a sending provider. Regional BYO enrollment returns a quick-create link for a role-only stack; the stack reports its AWS account when it is created, so the account ID is optional (given, it must match). Then a read-only scan runs. Legacy enrollment and Hosted mail return 201.', request: { body: json(Create) }, responses: { 201: response(Connection),202:response(Connection.extend({operationId:z.string(),revision:z.number()})), ...errors } }), async c => {
    const wid = owner(c);
    try {
      const input=c.req.valid('json');
      if (input.kind==='byo' && await byoEnabled(c.env,wid)) {
        if (input.awsAccountId===requirePlatformAccount(c.env.config.platformAccount)) throw new ApiError(409,'AWS_ACCOUNT_IN_USE','The shared sending account cannot be connected.');
        const existing=await get(c.env,wid);
        if (!existing || existing.template_version==='v5') {
          if (input.region) throw new ApiError(422,'INVALID_CONNECTION','A connected AWS account chooses its regions after it connects.','region');
          assertSesConfigured(c.env);
          const op=await enrollV5(c.env,wid,input.awsAccountId);c.get('actor').wakeJobs=1;
          return c.json({...view(c.env,(await get(c.env,wid))!),...op},202);
        }
        if (input.awsAccountId) throw new ApiError(409,'CONNECTION_EXISTS','A different connection already exists.');
      }
      if (input.awsAccountId!==undefined) throw new ApiError(422,'VALIDATION_ERROR','Account ID is only accepted for regional BYO enrollment.');
      // Hosted is instant: `ready` with no AWS call in this request. The jobs make its tenant and its built-in domain, which
      // lets onboarding skip DNS (startHostedMail). A new workspace's request does both itself.
      const { connection: row, wake } = input.kind === 'shared' ? await startHostedMail(c.env, wid, auditContext(c), input) : { connection: await create(c.env, wid, input, auditContext(c)), wake: false };
      if (wake) c.get('actor').wakeJobs=1;
      return c.json(view(c.env, row), 201);
    } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  });
  app.openapi(createRoute({method:'post',path:path+'/scan',operationId:'refreshConnectionScan',tags,security,description:'Refresh regional inventory without changing AWS resources or selected domains.',responses:{202:response(z.object({operationId:z.string(),revision:z.number()})),...errors}}),async c=>{
    const result=await refreshScan(c.env,owner(c),c.req.header('Idempotency-Key'));c.get('actor').wakeJobs=1;return c.json(result,202);
  });
  app.openapi(createRoute({method:'post',path:path+'/imports',operationId:'importConnectionDomains',tags,security,description:'Select verified regional candidates explicitly. Sending requires confirmed regional feedback. Imported identities are never modified.',request:{body:json(Imports)},responses:{202:response(Accepted),...errors}}),async c=>{
    const result=await selectImports(c.env,owner(c),c.req.valid('json'),c.req.header('Idempotency-Key'));c.get('actor').wakeJobs=1;return c.json(result,202);
  });
  app.openapi(createRoute({method:'post',path:path+'/regions/{region}/production-access',operationId:'requestConnectionProductionAccess',tags,security,description:'Ask AWS for SES production access in one region of the connected account, with the details the owner confirmed. Refused when the region already has access or a request is under review, so existing account details are never overwritten. Sending in a region starts only once AWS grants access.',request:{params:z.object({region:z.string().max(32).regex(regionPattern)}),body:json(ProductionAccess)},responses:{200:response(ProductionAccessState),...errors}}),async c=>{
    const wid=owner(c),{region}=c.req.valid('param'),input=c.req.valid('json');
    return c.json(await requestProductionAccess(c.env,wid,region,input,(db,id)=>recordAudit(db,c,{action:'connection.production_access',workspaceId:wid,target:{type:'connection',id},after:{region,mailType:input.mailType,websiteUrl:input.websiteUrl}})),200);
  });
  app.openapi(createRoute({method:'post',path:path+'/stack/update',operationId:'updateConnectionStack',tags,security,description:'Prepare an update of the connected account\'s stack to the newest published role template, keeping every parameter. Returns the AWS console page of the change set, which the customer reviews and runs; nothing changes until they do.',responses:{200:response(StackUpdate),...errors}}),async c=>{
    return c.json(await prepareStackUpdate(c.env,owner(c)),200);
  });
  app.openapi(createRoute({method:'get',path:path+'/regions/status',operationId:'getConnectionRegionStatus',tags,security,description:'Read regional AWS inventory, access, ownership journals and setup errors. Does not contact AWS.',responses:{200:response(RegionStatus),...errors}}),async c=>{
    const wid=owner(c),row=await get(c.env,wid);if (row?.template_version!=='v5') return notFound('Regional connection');return c.json({regions:await statuses(c.env.db,row.id)},200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/connection/verify', operationId: 'verifyConnection', tags, security, description: 'Manual fallback for automatic BYO stack detection. Prove the role and start verification and verified-domain import. Poll getConnection until ready. Safe to retry.', request: { body: json(z.object({ awsAccountId: AccountId }).strict()) }, responses: { 200: response(Connection), ...errors } }), async c => {
    const wid = owner(c); assertSesConfigured(c.env); template(c.env);
    const row = await get(c.env, wid) ?? notFound('Connection');
    if (row.kind !== 'byo') throw new ApiError(409, 'BYO_CONNECTION_REQUIRED', 'Only bring-your-own connections require verification.');
    const account = c.req.valid('json').awsAccountId;
    try { return c.json(view(c.env, await provision(c.env, row, account, undefined, auditContext(c))), 200); } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  });
  app.openapi(createRoute({ method: 'delete', path, operationId: 'deleteConnection', tags, security, description: 'Refuses outstanding mail and campaigns. Regional BYO fences sending and queues verified cleanup of its sending sets and feedback topic. Poll getConnection for the remaining manifest; repeat DELETE to resume after fixing access or drift. Keeps identities, DNS and mailbox data. Remove the customer role stack last. Legacy connections retain AWS resources.', responses: { 200: response(z.object({ deleted: z.literal(true) })),202:response(z.object({operationId:z.string(),summary:DisconnectSummary}).openapi('ConnectionDisconnect')), ...errors } }), async c => {
    const wid = owner(c);
    try {
      const current=await get(c.env,wid);
      if (current?.paused_at || current?.pause_reason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', current.pause_reason ?? 'Sending is paused for this workspace.');
      if (current?.template_version==='v5') {const result=await disconnectV5(c.env,wid,current.id,(db,conn)=>recordAudit(db,c,{action:'connection.delete',workspaceId:wid,target:{type:'connection',id:conn.id},before:{kind:'byo',region:conn.region,state:conn.state}}));c.get('actor').wakeJobs=1;return c.json(result,202);}
      // No AWS call runs in a transaction: fence the connection under the send-admission lock, delete its shared identities,
      // then release its claims and delete it. A failure leaves the fence (nothing sends on it); a repeated DELETE resumes.
      const row = await c.env.db.transaction(async db => {
        await getRegionSettings(db, wid, 'update'); // Serialize with send admission, which takes FOR SHARE on this row.
        const row = (await db.execute<Row & { paused_at: string | null; pause_reason: string | null }>(sql`SELECT * FROM provider_connections pc WHERE workspace_id=${wid} AND ${notProvisioning()}
          AND NOT EXISTS (SELECT 1 FROM sending_emails WHERE workspace_id=${wid} AND status IN ('queued','attempting','acceptance_unknown'))
          AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.workspace_id=${wid} AND ${campaignActive()}) FOR UPDATE`)).rows[0];
        if (!row) {
          if (!(await db.execute(sql`SELECT 1 FROM provider_connections WHERE workspace_id=${wid}`)).rowCount) return notFound('Connection');
          throw new ApiError(409, 'CONNECTION_IN_USE', 'Finish queued work or active setup before disconnecting.');
        }
        // Disconnect/reconnect must not serve as a workspace-controlled unpause, even to finish an earlier DELETE.
        if (row.paused_at || row.pause_reason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', row.pause_reason ?? 'Sending is paused for this workspace.');
        if (row.state === 'disconnecting' && row.template_version !== 'v5') return row; // An earlier DELETE fenced it after these checks.
        if (row.template_version==='v5' || (await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${row.id} AND NOT legacy AND NOT (${row.kind}='shared' AND region='us-east-1' AND pool_tenant_name IS NOT NULL AND receiving_state='off' AND sending_state='ready') LIMIT 1`)).rowCount) throw new ApiError(409,'REGIONAL_DISCONNECT_REQUIRED','A regional connection requires reviewed cleanup before disconnecting.');
        await db.execute(sql`UPDATE provider_connections SET state='disconnecting' WHERE id=${row.id}`);
        return row;
      });
      await (await wrapModuleLoad(() => import('./domains/hosted.js'))).deleteConnectionIdentities(c.env, wid, { id: row.id, kind: row.kind, region: row.region, aws_account_id: row.aws_account_id!, role_arn: row.role_arn!, external_id: row.external_id!, tenant_state: row.tenant_state });
      // A pause can land during the AWS cleanup: re-check it under the connection's lock (the fence's lock order) before
      // releasing anything. The connection stays fenced; a DELETE after the resume finishes. Once a concurrent DELETE has
      // finished, both statements are no-ops, so only one audits.
      await c.env.db.transaction(async db => {
        await getRegionSettings(db, wid, 'update');
        const fenced = (await db.execute<{ paused_at: string | null; pause_reason: string | null }>(sql`SELECT paused_at, pause_reason FROM provider_connections WHERE id=${row.id} AND state='disconnecting' FOR UPDATE`)).rows[0];
        if (!fenced) return;
        if (fenced.paused_at || fenced.pause_reason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', fenced.pause_reason ?? 'Sending is paused for this workspace.');
        await db.execute(sql`WITH ${releaseConnectionClaims(wid, sql`SELECT ${row.id}::text AS id`)} SELECT 1`);
        await db.execute(sql`WITH deleted AS (DELETE FROM provider_connections WHERE id=${row.id} AND state='disconnecting' RETURNING id),
          audit AS (${auditInsert(auditContext(c), { action: 'connection.delete', workspaceId: wid, target: { type: 'connection', id: row.id }, before: { kind: row.kind, region: row.region, state: row.state } }, { from: sql`deleted` })}) SELECT 1`);
      });
    } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
    return c.json({ deleted: true as const }, 200);
  });
}
