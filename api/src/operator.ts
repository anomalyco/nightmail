import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, dashboardSession, errors, json, notFound, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { operatorRole, type OperatorRole } from './operator-identity.js';
import { applyChange, type Change } from './standing.js';
import { loadDisplayedStanding, scoreView, StandingSchema } from './sender-score.js';
import { clearProbe, queueCampaignRun, resumeCampaign } from './states.js';
import { productName } from './brand.js';
import { placesOpened, readPlaces, setLimit } from './signups.js';
import { waitlistNoticeStatus } from './account-notices.js';
import { ScreenComparison, screenComparison } from './screen-comparison.js';
import { diskAlertSetup } from './disk-alert.js';

// The operator API: Anomaly staff with a platform role act on any Hosted workspace through one audited path. The
// /operator dashboard area, Ryan's support platform (phase 2) and scripts are its clients. Roles live in
// platform_operators (granted by scripts/set-operator.ts), never a workspace role. Identity is the signed-in user:
// today a dashboard session, after #89 the same session from Anomaly sign-in, so these routes do not change. The role's
// link to the user lives only in src/operator-identity.ts.
// Hidden from the public OpenAPI document, SDK and llms docs (hide: true).

export type OperatorIdentity = { userId: string; email: string; role: OperatorRole };
/** The signed-in operator, or 403. `operator` may change things; `operator:read` only reads. */
export async function operatorActor(c: Ctx, level: OperatorRole): Promise<OperatorIdentity> {
  if (!c.env.config.multiTenant) notFound('Endpoint');
  const a = c.get('actor');
  if (a?.credential !== 'dashboard') throw new ApiError(403, 'OPERATOR_REQUIRED', 'Use a signed-in operator session.');
  const { userId, email } = dashboardSession(c);
  const role = await operatorRole(c.env.db, userId);
  if (!role || (level === 'operator' && role !== 'operator')) throw new ApiError(403, 'OPERATOR_REQUIRED', level === 'operator' ? 'This action needs the operator role.' : `This area is for ${productName} operators.`);
  // The role is used only from a session whose own sign-in proved staff (Google Workspace, account-policy.ts). The same
  // person signed in with GitHub is an ordinary member session until they sign in with Google.
  if (a.staff !== true) throw new ApiError(403, 'STAFF_SIGN_IN_REQUIRED', 'Sign in with Google to use staff tools.');
  return { userId, email, role };
}

const Reason = z.string().trim().min(10).max(1000).describe('Why, for the audit log and the customer timeline (at least 10 characters).');
// An action taken from the abuse view (src/abuse-clusters.ts). What the workspace's own records, its support
// conversations and its webhooks may carry is the fixed REVIEW_REASON; the cluster and the operator's note stay in the
// staff-only audit row, so nothing about another customer can reach this one.
const Evidence = z.object({ cluster: z.string().regex(/^acl_[0-9a-f]{24}$/), note: z.string().trim().min(10).max(1000).describe('Staff only: why, for the operator audit.') }).strict();
const REVIEW_REASON = 'Account review by staff.';
type Reasoned = { reason?: string; evidence?: z.infer<typeof Evidence> };
/** The reason an action records where the workspace can be told of it, and what stays in the staff audit row. */
function reasoned<T extends Reasoned>(body: T): Omit<T, 'reason' | 'evidence'> & { reason: string; internal?: { abuse: z.infer<typeof Evidence> } } {
  const { reason, evidence, ...rest } = body;
  if (evidence && reason !== undefined) throw new ApiError(422, 'VALIDATION_FAILED', 'Give evidence or a reason, not both: with evidence the recorded reason is fixed.', 'reason');
  if (evidence) return { ...rest, reason: REVIEW_REASON, internal: { abuse: evidence } };
  if (reason === undefined) throw new ApiError(422, 'VALIDATION_FAILED', 'Give a reason of at least 10 characters.', 'reason');
  return { ...rest, reason };
}
/** Evidence names a cluster this workspace is in, or the action is refused. */
async function evidenceFor(db: DbExecutor, workspaceId: string, internal: { abuse: z.infer<typeof Evidence> } | undefined) {
  if (internal && !(await db.execute(sql`SELECT FROM abuse_cluster_members WHERE cluster_id=${internal.abuse.cluster} AND entity_type='workspace' AND entity_id=${workspaceId}`)).rows.length)
    throw new ApiError(422, 'EVIDENCE_INVALID', 'This workspace is not in that cluster. Reload the cluster and try again.', 'evidence');
}
const TicketRef = z.string().trim().min(1).max(200).optional().describe('The support ticket ID or URL.');
const WorkspaceParam = z.object({ id: z.string().min(1).max(100) });
const Mutation = { 'Idempotency-Key': z.string().min(1).max(200).optional(), 'If-Match': z.string().regex(/^"?\d+"?$/).optional().describe('The standing version this action was decided on.') };
const QueueItem = z.object({ workspaceId: z.string(), name: z.string(), step: z.enum(['ok', 'notice', 'warn', 'restrict', 'pause']), since: z.string(), score: z.number().nullable(), dailyLimit: z.number().int().nullable().describe('Null: no daily limit.'),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })), paused: z.boolean(), quarantined: z.number().int(), watch: z.boolean(), strikes: z.number().int() }).openapi('OperatorQueueItem');
const Action = z.object({ at: z.string(), workspaceId: z.string().describe("'platform': a change to no one workspace."), action: z.string(), operatorId: z.string().nullable(), operatorEmail: z.string().nullable(), via: z.string().nullable(), reason: z.string().nullable(), ticketRef: z.string().nullable(),
  requestId: z.string().nullable(), before: z.unknown().nullable(), after: z.unknown().nullable(), details: z.unknown() }).openapi('OperatorAction');
const TimelineItem = z.object({ at: z.string(), kind: z.enum(['standing', 'limit', 'quarantine', 'release', 'tenant', 'operator', 'score', 'audit', 'bounces', 'rejection']),
  title: z.string(), detail: z.unknown() }).openapi('OperatorTimelineItem');
const WaitlistEntry = z.object({ email: z.string(), name: z.string().nullable(), attempts: z.number().int(), firstAt: z.string(), lastAt: z.string(),
  letInAt: z.string().nullable().describe('When a raise of the sign-up limit held a place for this address; null while it waits.'),
  emailed: z.enum(['queued', 'sent', 'failed']).nullable().describe('The email saying it can sign in: queued, sent or failed; null when none was sent.') }).openapi('OperatorWaitlistEntry');
const SignupPlaces = z.object({ limit: z.number().int().describe('How many accounts may sign up on their own; 0 lets nobody in this way.'), signedUp: z.number().int().describe('Accounts that signed up on their own, each counted once.'),
  held: z.number().int().describe('Places a raise held for waiting addresses whose person has not signed in yet.'), waiting: z.number().int().describe('Addresses on the waitlist without a place.'),
  open: z.number().int().describe('Places left for whoever signs in next: limit less signed up and held, at least 0.') }).openapi('OperatorSignupPlaces');
const WorkspaceSummary = z.object({ id: z.string(), name: z.string(), createdAt: z.string(), owner: z.string().nullable().describe('The first owner\'s address.'),
  domain: z.string().nullable().describe('A verified sending domain (the first by name), or null.'), domains: z.number().int().describe('Verified sending domains.'),
  sent: z.number().describe('Recipients sent to, ever (the send meters).'), standing: z.enum(['ok', 'notice', 'warn', 'restrict', 'pause']).nullable().describe('Hosted sending standing, pause while sending is paused; null without hosted sending.') }).openapi('OperatorWorkspaceSummary');
const DomainLimit = z.object({ used: z.number().int(), limit: z.number().int(), custom: z.boolean().describe('An operator set this limit; otherwise it is the default of 100.') }).openapi('OperatorDomainLimit');
const domainLimitOf = (wid: string) => sql`SELECT json_build_object('used',(SELECT count(*)::int FROM domain_claims WHERE workspace_id=${wid}),'limit',workspace_domain_limit(${wid}),'custom',domain_limit IS NOT NULL) FROM workspaces WHERE id=${wid}`;
const WorkspaceView = z.object({ workspace: z.object({ id: z.string(), name: z.string(), createdAt: z.string() }), score: z.unknown(), standing: StandingSchema.nullable(),
  connection: z.object({ region: z.string(), paused: z.boolean(), resuming: z.boolean(), pauseReason: z.string().nullable(), tenantGeneration: z.number().int(),
    tenants: z.array(z.object({ region: z.string(), applied: z.enum(['ENABLED', 'DISABLING', 'DISABLED']).describe(`DISABLING: ${productName} asked AWS and does not know the outcome yet, so it treats the tenant as possibly disabled.`), generation: z.number().int(), appliedAt: z.string() }))
      .describe(`What ${productName} last applied to each regional SES tenant (none: never switched, so enabled).`) }).nullable(),
  domains: z.array(z.object({ name: z.string(), region: z.string().nullable(), pool: z.string(), dkim: z.boolean(), mailFrom: z.boolean(), dmarc: z.string().nullable() })),
  members: z.array(z.object({ userId: z.string(), email: z.string(), role: z.string() })), siblings: z.array(z.object({ id: z.string(), name: z.string() })),
  override: z.object({ daily: z.number().int(), expiresAt: z.string().nullable() }).nullable(), exempt: z.boolean(),
  domainLimit: DomainLimit,
  campaigns: z.array(z.object({ id: z.string(), name: z.string(), state: z.string(), pauseReason: z.unknown().nullable(), quarantines: z.number().int() })) }).openapi('OperatorWorkspace');

// Timestamps leave as ISO 8601 with microseconds; a page cursor is the last row's "at|key", opaque to clients.
const isoAt = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// hosted_operator_audit has no id column: its rows are keyed by their content (identical rows in one microsecond are one entry).
const auditKey = sql`'a:'||md5(at::text||action||details::text||coalesce(operator_id,'')||coalesce(request_id,''))`;
const Cursor = z.string().max(600).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|.+$/).optional().describe('nextCursor from the previous page.');
function readCursor(cursor?: string) {
  if (!cursor) return null;
  const split = cursor.indexOf('|'), at = cursor.slice(0, split);
  if (!Number.isFinite(Date.parse(at))) throw new ApiError(422, 'INVALID_CURSOR', 'Use nextCursor from the previous page.', 'cursor');
  return { at, key: cursor.slice(split + 1) };
}
export type OperatorAudit = { action: string; before?: unknown; after?: unknown; reason?: string; ticketRef?: string; /** Staff-only detail, kept in the audit row alone. */ internal?: Record<string, unknown> };
/** What an Idempotency-Key is bound to: the method, path and body of the request that first used it. */
export const operatorRequestHash = (c: Ctx, body: unknown) => createHash('sha256').update(JSON.stringify([c.req.method, c.req.path, body])).digest('hex');
/** The audit row for one operator change. Call it inside the transaction that makes the change. */
export const writeOperatorAudit = (tx: DbExecutor, c: Ctx, operator: OperatorIdentity, workspaceId: string, audit: OperatorAudit) => tx.execute(sql`INSERT INTO hosted_operator_audit(workspace_id,action,details,operator_id,via,reason,ticket_ref,request_id,before,after)
  VALUES(${workspaceId},${audit.action},${JSON.stringify({ operatorRole: operator.role, ...audit.internal })}::jsonb,${operator.userId},'console',${audit.reason ?? null},${audit.ticketRef ?? null},${c.get('requestId') ?? null},
    ${JSON.stringify(audit.before ?? null)}::jsonb,${JSON.stringify(audit.after ?? null)}::jsonb)`);
/**
 * Idempotency, If-Match and the audit row around one mutation, all in one transaction. Billing's operator tools use it
 * too, with their own writer (the audit trail's billing.* rows, kept 7 years) instead of hosted_operator_audit.
 */
export async function mutate<T>(c: Ctx, operator: OperatorIdentity, workspaceId: string, body: unknown, work: (tx: DbExecutor, expectVersion: number | undefined) => Promise<{ result: T; audit: OperatorAudit }>,
  writeAudit: (tx: DbExecutor, audit: OperatorAudit) => Promise<unknown> = (tx, audit) => writeOperatorAudit(tx, c, operator, workspaceId, audit)): Promise<T> {
  const key = c.req.header('Idempotency-Key'), match = c.req.header('If-Match'), expectVersion = match ? Number(match.replaceAll('"', '')) : undefined;
  const hash = operatorRequestHash(c, body);
  return c.env.db.transaction(async tx => {
    if (key) {
      const { rows: [prior] } = await tx.execute<{ request_hash: string; response: T }>(sql`SELECT request_hash,response FROM operator_idempotency WHERE operator_id=${operator.userId} AND key=${key} FOR UPDATE`);
      if (prior) { if (prior.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.'); return prior.response; }
    }
    const { result, audit } = await work(tx, expectVersion);
    await writeAudit(tx, audit);
    if (key) await tx.execute(sql`INSERT INTO operator_idempotency(operator_id,key,request_hash,response) VALUES(${operator.userId},${key},${hash},${JSON.stringify(result)}::jsonb)`);
    return result;
  });
}
async function hostedWorkspace(db: DbExecutor, id: string) {
  const { rows: [row] } = await db.execute<{ id: string; version: number | null }>(sql`SELECT w.id,s.version FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared'
    LEFT JOIN sender_standing s ON s.workspace_id=w.id WHERE w.id=${id}`);
  return row ?? notFound('Hosted workspace');
}
const standingOf = async (db: DbExecutor, id: string) => (await db.execute<{ step: string; version: number; marketing_hold: boolean; paused: boolean }>(sql`SELECT s.step,s.version,s.marketing_hold,pc.paused_at IS NOT NULL AS paused
  FROM sender_standing s JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared' WHERE s.workspace_id=${id}`)).rows[0] ?? null;
const operatorReason = (code: string, message: string) => [{ code, metric: 'external' as const, value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause' as const, message }];

export function registerOperator(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces', operationId: 'operatorListWorkspaces',
    request: { query: z.object({ step: z.enum(['notice', 'warn', 'restrict', 'pause']).optional(), q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(QueueItem) })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), search = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    // The queue: anything above ok, watched workspaces and quarantined campaigns, most severe first. A search spans all.
    const { rows } = await c.env.db.execute<z.infer<typeof QueueItem>>(sql`SELECT w.id AS "workspaceId",w.name,s.step,s.since::text AS since,s.score::float AS score,s.daily_limit AS "dailyLimit",
        coalesce((SELECT json_agg(json_build_object('code',r->>'code','message',r->>'message')) FROM jsonb_array_elements(s.reasons) r),'[]') AS reasons,pc.paused_at IS NOT NULL AS paused,
        (SELECT count(*)::int FROM sending_campaigns sc WHERE sc.workspace_id=w.id AND sc.state='paused' AND sc.pause_reason->>'code' IN ('LIST_QUALITY','BOUNCE_RATE_HIGH','COMPLAINT_RATE_HIGH','BLOCKLISTED')) AS quarantined,
        s.watch,jsonb_array_length(s.strikes)::int AS strikes
      FROM sender_standing s JOIN workspaces w ON w.id=s.workspace_id JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared'
      WHERE ${search ? sql`(w.id=${q.q} OR w.name ILIKE ${search})` : q.step ? sql`s.step=${q.step}` : sql`(s.step<>'ok' OR s.watch OR EXISTS (SELECT FROM sending_campaigns sc WHERE sc.workspace_id=w.id AND sc.state='paused'
        AND sc.pause_reason->>'code' IN ('LIST_QUALITY','BOUNCE_RATE_HIGH','COMPLAINT_RATE_HIGH','BLOCKLISTED')))`}
      ORDER BY CASE s.step WHEN 'pause' THEN 0 WHEN 'restrict' THEN 1 WHEN 'warn' THEN 2 WHEN 'notice' THEN 3 ELSE 4 END,s.since LIMIT ${q.limit}`);
    return c.json({ data: rows }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces/{id}', operationId: 'operatorGetWorkspace', request: { params: WorkspaceParam },
    responses: { 200: response(WorkspaceView), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const wid = c.req.valid('param').id;
    await hostedWorkspace(c.env.db, wid);
    const score = scoreView(await loadDisplayedStanding(c.env, wid));
    const { rows: [row] } = await c.env.db.execute<z.infer<typeof WorkspaceView>>(sql`SELECT
      (SELECT json_build_object('id',id,'name',name,'createdAt',created_at) FROM workspaces WHERE id=${wid}) AS workspace,
      (SELECT json_build_object('region',pc.region,'paused',pc.paused_at IS NOT NULL,'resuming',pc.resume_pending_at IS NOT NULL,'pauseReason',pc.pause_reason,'tenantGeneration',pc.tenant_generation,
        'tenants',coalesce((SELECT json_agg(json_build_object('region',t.region,'applied',t.applied,'generation',t.generation,'appliedAt',${isoAt(sql`t.applied_at`)}) ORDER BY t.region)
          FROM hosted_tenant_status t WHERE t.connection_id=pc.id),'[]')) FROM provider_connections pc WHERE pc.workspace_id=${wid} AND pc.kind='shared') AS connection,
      coalesce((SELECT json_agg(json_build_object('name',dc.name,'region',b.region,'pool',coalesce(t.tier,'probation'),
        'dkim',coalesce(dc.identity #>> '{ses,DkimAttributes,Status}'='SUCCESS',false),'mailFrom',coalesce(dc.identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS',false),'dmarc',dc.identity #>> '{dmarc,status}') ORDER BY dc.name)
        FROM domain_claims dc LEFT JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) LEFT JOIN hosted_domain_tiers t ON t.connection_id=dc.connection_id AND t.name=dc.name
        WHERE dc.workspace_id=${wid}),'[]') AS domains,
      coalesce((SELECT json_agg(json_build_object('userId',m.user_id,'email',u.email,'role',m.role) ORDER BY m.role,u.email) FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=${wid}),'[]') AS members,
      coalesce((SELECT json_agg(json_build_object('id',o.id,'name',o.name) ORDER BY o.created_at) FROM workspaces me JOIN workspaces o ON o.quota_sponsor=me.quota_sponsor AND o.id<>me.id WHERE me.id=${wid} AND me.quota_sponsor IS NOT NULL),'[]') AS siblings,
      (SELECT CASE WHEN send_cap_override IS NOT NULL THEN json_build_object('daily',send_cap_override,'expiresAt',send_cap_override_expires_at) END FROM workspaces WHERE id=${wid}) AS override,
      (SELECT exempt_hosted_quotas FROM workspaces WHERE id=${wid}) AS exempt,
      (${domainLimitOf(wid)}) AS "domainLimit",
      coalesce((SELECT json_agg(x) FROM (SELECT id,coalesce(draft->>'name',id) AS name,state,pause_reason AS "pauseReason",quarantines FROM sending_campaigns
        WHERE workspace_id=${wid} AND (quarantines>0 OR state IN ('sending','paused','scheduled')) ORDER BY updated_at DESC LIMIT 20) x),'[]') AS campaigns`);
    return c.json({ ...row!, score, standing: score.standing }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces/{id}/timeline', operationId: 'operatorWorkspaceTimeline',
    request: { params: WorkspaceParam, query: z.object({ cursor: Cursor, limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(TimelineItem), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const wid = c.req.valid('param').id, q = c.req.valid('query'), after = readCursor(q.cursor), upTo = after?.at ?? new Date(Date.now() + 60_000).toISOString();
    await hostedWorkspace(c.env.db, wid);
    // One stream: standing events, operator actions, the daily score, hourly hard bounces and complaints by recipient
    // domain (never an address), and screen rejections with their spam score, the threshold then and subject (staff only:
    // this is the one read of a refusal's verdict). No message bodies. Each row
    // has a stable key, so rows sharing a timestamp are never skipped across pages.
    const { rows } = await c.env.db.execute<z.infer<typeof TimelineItem> & { key: string; ts: string }>(sql`SELECT ${isoAt(sql`t.ts`)} AS at,t.key,t.kind,t.title,t.detail FROM (
      SELECT at AS ts,'s:'||id AS key,CASE kind WHEN 'step' THEN 'standing' ELSE kind END AS kind,
        CASE WHEN from_step IS DISTINCT FROM to_step THEN coalesce(from_step,'?')||' → '||to_step WHEN kind='limit' AND details ? 'from' THEN 'Daily limit '||coalesce(details->>'from','none')||' → '||coalesce(details->>'to','none')
          WHEN kind='limit' THEN 'Limit override changed' ELSE kind||' ('||(actor->>'kind')||')' END AS title,
        jsonb_build_object('reasons',reasons,'actor',actor,'details',details,'sequence',sequence) AS detail FROM standing_events WHERE workspace_id=${wid} AND at<=${upTo}::timestamptz
      UNION ALL SELECT at,${auditKey},'audit',action,jsonb_build_object('operatorId',operator_id,'via',via,'reason',coalesce(reason,details->>'reason'),'ticketRef',ticket_ref,'before',before,'after',after)
        FROM hosted_operator_audit WHERE workspace_id=${wid} AND at<=${upTo}::timestamptz
      UNION ALL SELECT day::timestamp AT TIME ZONE 'UTC','d:'||day,'score','Score '||coalesce(round(score,1)::text,'calibrating')||' · limit '||coalesce(daily_limit::text,'none'),
        jsonb_build_object('accepted',accepted,'bounced',bounced,'complained',complained,'rejected',rejected,'quality',quality,'target',target,'step',step)
        FROM sender_score_daily WHERE workspace_id=${wid} AND (day::timestamp AT TIME ZONE 'UTC')<=${upTo}::timestamptz AND day>(now() AT TIME ZONE 'UTC')::date-60
      UNION ALL SELECT hour,'b:'||hour::text||':'||domain,'bounces',sum(b)||' hard bounces, '||sum(cpl)||' complaints at '||domain,jsonb_build_object('domain',domain,'bounces',sum(b),'complaints',sum(cpl)) FROM (
        SELECT date_trunc('hour',e.created_at,'UTC') AS hour,lower(split_part(e.to_addresses->>0,'@',2)) AS domain,(e.status='bounced' OR e.event_outcomes & 4 <> 0)::int AS b,(e.status='complained' OR e.event_outcomes & 8 <> 0)::int AS cpl
        FROM sending_emails e WHERE e.workspace_id=${wid} AND NOT e.simulated AND e.created_at>now()-interval '7 days' AND e.created_at<=${upTo}::timestamptz+interval '1 hour' AND (e.status IN ('bounced','complained') OR e.event_outcomes & 12 <> 0)) x
        GROUP BY hour,domain
      UNION ALL SELECT e.created_at,'r:'||e.id,'rejection','Screen rejected: '||left(e.subject,120),jsonb_build_object('spam',v.data->'screen'->'spam','threshold',v.data->'screen'->'threshold','campaignId',e.campaign_id,'emailId',e.id)
        FROM sending_emails e LEFT JOIN LATERAL (SELECT data FROM sending_email_events WHERE workspace_id=e.workspace_id AND email_id=e.id AND type='reject' ORDER BY created_at DESC LIMIT 1) v ON true
        WHERE e.workspace_id=${wid} AND e.error_code='CONTENT_REJECTED_SPAM' AND e.created_at>now()-interval '7 days' AND e.created_at<=${upTo}::timestamptz
    ) t ${after ? sql`WHERE (t.ts,t.key)<(${after.at}::timestamptz,${after.key})` : sql``} ORDER BY t.ts DESC,t.key DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page.map(({ key: _, ts: __, ...item }) => item), nextCursor: rows.length > q.limit && last ? `${last.at}|${last.key}` : null }, 200);
  });

  const MutationBody = z.object({ reason: Reason, ticketRef: TicketRef }).strict();
  const done = z.object({ ok: z.literal(true), version: z.number().int().nullable(), step: z.string().nullable() });
  const ReviewedBody = z.object({ reason: Reason.optional(), evidence: Evidence.optional(), ticketRef: TicketRef }).strict();
  const change = async (c: Ctx, wid: string, body: { reason: string; ticketRef?: string; internal?: Record<string, unknown> }, action: string, build: (current: NonNullable<Awaited<ReturnType<typeof standingOf>>>) => Omit<Change, 'workspaceId' | 'actor' | 'expectVersion'>) => {
    const operator = await operatorActor(c, 'operator');
    await hostedWorkspace(c.env.db, wid);
    return mutate(c, operator, wid, body, async (tx, expectVersion) => {
      const before = await standingOf(tx, wid);
      if (!before) notFound('Hosted workspace');
      const result = await applyChange(tx, { workspaceId: wid, actor: { kind: 'operator', id: operator.userId, via: 'console' }, expectVersion, ...build(before!),
        details: { reason: body.reason, ...(body.ticketRef ? { ticketRef: body.ticketRef } : {}), ...build(before!).details } });
      const after = await standingOf(tx, wid);
      return { result: { ok: true as const, version: result?.version ?? null, step: result?.step ?? null }, audit: { action, before, after, reason: body.reason, ticketRef: body.ticketRef, internal: body.internal } };
    });
  };
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/workspaces/{id}/pause', operationId: 'operatorPauseWorkspace', request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(ReviewedBody) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = reasoned(c.req.valid('json')), wid = c.req.valid('param').id;
    await operatorActor(c, 'operator'); await evidenceFor(c.env.db, wid, body.internal);
    return c.json(await change(c, wid, body, 'operator-pause', current => {
      if (current.paused) throw new ApiError(409, 'ALREADY_PAUSED', 'This workspace is already paused.');
      // The reason is for the audit and the operator timeline; customers see that Nightmail paused it after a review.
      return { kind: 'operator', step: 'pause', pauseKind: 'full', pause: { message: `Hosted sending paused by ${productName} after a review. Ask for a review from the dashboard for details.` }, reasons: operatorReason('OPERATOR_PAUSE', `${productName} paused sending after a review.`) };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/workspaces/{id}/resume', operationId: 'operatorResumeWorkspace',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ reason: Reason, ticketRef: TicketRef, restore: z.union([z.literal(50), z.literal(100)]).default(50) }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    return c.json(await change(c, wid, body, 'operator-resume', current => {
      if (!current.paused) throw new ApiError(409, 'NOT_PAUSED', 'This workspace is not paused.');
      return { kind: 'operator', step: 'warn', resume: { percent: body.restore, caps: c.env.config.hostedSendCaps }, details: { restore: body.restore } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/workspaces/{id}/marketing', operationId: 'operatorSetMarketingHold',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ held: z.boolean(), reason: Reason, ticketRef: TicketRef }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    return c.json(await change(c, wid, body, body.held ? 'operator-hold-marketing' : 'operator-release-marketing', current => body.held
      ? { kind: 'operator', marketingHold: true, step: current.step === 'pause' ? 'pause' : 'restrict', reasons: current.step === 'pause' ? undefined : [{ ...operatorReason('OPERATOR_HOLD', `${productName} holds marketing after a review.`)[0]!, step: 'restrict' }] }
      : { kind: 'operator', marketingHold: false, step: current.step === 'restrict' ? 'warn' : current.step as Change['step'] }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/workspaces/{id}/limit', operationId: 'operatorSetLimit',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ daily: z.number().int().min(1).max(10_000_000).nullable().describe('null returns the workspace to the score limit.'),
      expiresAt: z.iso.datetime().nullable().optional().describe('When the override ends (at most a year ahead); omit or null for no expiry.'), reason: Reason.optional(), evidence: Evidence.optional(), ticketRef: TicketRef }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = reasoned(c.req.valid('json')), wid = c.req.valid('param').id;
    if (body.expiresAt && (Date.parse(body.expiresAt) <= Date.now() || Date.parse(body.expiresAt) > Date.now() + 366 * 86_400_000)) throw new ApiError(422, 'INVALID_EXPIRY', 'Choose an expiry between now and a year from now.', 'expiresAt');
    const operator = await operatorActor(c, 'operator');
    await hostedWorkspace(c.env.db, wid); await evidenceFor(c.env.db, wid, body.internal);
    return c.json(await mutate(c, operator, wid, body, async (tx, expectVersion) => {
      const current = await standingOf(tx, wid);
      if (expectVersion !== undefined && current && current.version !== expectVersion) throw new ApiError(412, 'STANDING_VERSION_CHANGED', `The standing changed since version ${expectVersion} (now ${current.version}).`);
      const { rows: [before] } = await tx.execute<{ daily: number | null; expiresAt: string | null; restoreCap: number | null }>(sql`SELECT w.send_cap_override AS daily,w.send_cap_override_expires_at AS "expiresAt",
        CASE WHEN pc.restore_until>now() THEN pc.restore_cap END AS "restoreCap" FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared' WHERE w.id=${wid} FOR UPDATE OF w,pc`);
      await tx.execute(sql`UPDATE workspaces SET send_cap_override=${body.daily},send_cap_override_expires_at=${body.daily === null ? null : body.expiresAt ?? null}::timestamptz WHERE id=${wid}`);
      // An operator's explicit limit is the decision: it ends a resume's reduced limit (kept in the audit's before).
      if (body.daily !== null && before?.restoreCap) await tx.execute(sql`UPDATE provider_connections SET restore_cap=NULL,restore_until=NULL WHERE workspace_id=${wid} AND kind='shared'`);
      await tx.execute(sql`WITH s AS (UPDATE sender_standing SET sequence=sequence+1 WHERE workspace_id=${wid} RETURNING workspace_id,sequence,step)
        INSERT INTO standing_events(id,workspace_id,sequence,kind,from_step,to_step,actor,details) SELECT 'stev_'||replace(gen_random_uuid()::text,'-',''),workspace_id,sequence,'limit',step,step,
          ${JSON.stringify({ kind: 'operator', id: operator.userId, via: 'console' })}::jsonb,${JSON.stringify({ override: { from: before, to: { daily: body.daily, expiresAt: body.expiresAt ?? null } }, reason: body.reason })}::jsonb FROM s`);
      return { result: { ok: true as const, version: current?.version ?? null, step: current?.step ?? null }, audit: { action: 'operator-set-limit', before, after: { daily: body.daily, expiresAt: body.expiresAt ?? null }, reason: body.reason, ticketRef: body.ticketRef, internal: body.internal } };
    }), 200);
  });
  // The growth pace after the evaluation (src/standing-model.ts GROWTH): an operator lifts it for a known, legitimate
  // launch; the workspace then sends at its per-minute pace. Audited, with a standing event.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/workspaces/{id}/growth/lift', operationId: 'operatorLiftGrowth',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(MutationBody) }, responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    const operator = await operatorActor(c, 'operator');
    await hostedWorkspace(c.env.db, wid);
    return c.json(await mutate(c, operator, wid, body, async (tx, expectVersion) => {
      const { rows: [before] } = await tx.execute<{ until: string | null; cap: number | null }>(sql`SELECT growth_until AS until,growth_cap AS cap FROM sender_standing WHERE workspace_id=${wid} FOR UPDATE`);
      if (!before?.until || Date.parse(before.until) <= Date.now() || before.cap === null) throw new ApiError(409, 'GROWTH_NOT_ACTIVE', 'This workspace has no growth pace to lift.');
      await tx.execute(sql`UPDATE sender_standing SET growth_until=NULL,growth_cap=NULL,growth_hour=NULL,growth_quality=NULL WHERE workspace_id=${wid}`);
      const result = await applyChange(tx, { workspaceId: wid, actor: { kind: 'operator', id: operator.userId, via: 'console' }, expectVersion, kind: 'operator', details: { growthLifted: before, reason: body.reason } });
      return { result: { ok: true as const, version: result?.version ?? null, step: result?.step ?? null }, audit: { action: 'operator-lift-growth', before, after: { until: null, cap: null }, reason: body.reason, ticketRef: body.ticketRef } };
    }), 200);
  });
  // A workspace's domain limit (default 100). Lowering it below the current count removes nothing; it only refuses new
  // domains until the workspace is under it again. Any Hosted workspace, shared or BYO sending.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/workspaces/{id}/domain-limit', operationId: 'operatorSetDomainLimit',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ limit: z.number().int().min(1).max(10_000).nullable().describe('null returns the workspace to the default of 100.'), reason: Reason, ticketRef: TicketRef }).strict()) },
    responses: { 200: response(z.object({ ok: z.literal(true), domainLimit: DomainLimit })), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    const operator = await operatorActor(c, 'operator');
    return c.json(await mutate(c, operator, wid, body, async tx => {
      const { rows: [before] } = await tx.execute<{ limit: number | null }>(sql`SELECT domain_limit AS "limit" FROM workspaces WHERE id=${wid} FOR NO KEY UPDATE`);
      if (!before) notFound('Workspace');
      await tx.execute(sql`UPDATE workspaces SET domain_limit=${body.limit} WHERE id=${wid}`);
      const { rows: [view] } = await tx.execute<{ domainLimit: z.infer<typeof DomainLimit> }>(sql`SELECT (${domainLimitOf(wid)}) AS "domainLimit"`);
      return { result: { ok: true as const, domainLimit: view!.domainLimit }, audit: { action: 'operator-set-domain-limit', before: { limit: before!.limit }, after: { limit: body.limit }, reason: body.reason, ticketRef: body.ticketRef } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/campaigns/{id}/release', operationId: 'operatorReleaseCampaign',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(MutationBody) }, responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), campaignId = c.req.valid('param').id;
    const operator = await operatorActor(c, 'operator');
    const { rows: [campaign] } = await c.env.db.execute<{ workspace_id: string; state: string; expanded: number; request_id: string | null; scheduled_at: string | null; pause_reason: { code: string } | null; quarantines: number; name: string }>(sql`SELECT c.workspace_id,c.state,c.expanded,c.request_id,c.scheduled_at,c.pause_reason,c.quarantines,coalesce(c.draft->>'name',c.id) AS name
      FROM sending_campaigns c JOIN provider_connections pc ON pc.workspace_id=c.workspace_id AND pc.kind='shared' WHERE c.id=${campaignId}`);
    if (!campaign) notFound('Campaign');
    if (campaign!.state !== 'paused') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign can be released.');
    const wid = campaign!.workspace_id, ref = { workspaceId: wid, id: campaignId };
    return c.json(await mutate(c, operator, wid, body, async tx => {
      const next = campaign!.scheduled_at && Date.parse(campaign!.scheduled_at) > Date.now() && campaign!.expanded === 0 ? 'scheduled' as const : 'sending' as const;
      if (!(await tx.execute(resumeCampaign(ref, next))).rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed meanwhile; reload it.');
      await tx.execute(clearProbe(ref));
      await tx.execute(queueCampaignRun(ref, campaign!.request_id ? { requestId: campaign!.request_id } : {}, next === 'scheduled' ? campaign!.scheduled_at : null));
      const result = await applyChange(tx, { workspaceId: wid, actor: { kind: 'operator', id: operator.userId, via: 'console' }, kind: 'release', details: { campaignId, campaignName: campaign!.name, reason: body.reason } });
      return { result: { ok: true as const, version: result?.version ?? null, step: result?.step ?? null }, audit: { action: 'operator-release-campaign', before: { campaignId, pauseReason: campaign!.pause_reason, quarantines: campaign!.quarantines }, after: { campaignId, state: next }, reason: body.reason, ticketRef: body.ticketRef } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/actions', operationId: 'operatorListActions',
    request: { query: z.object({ workspaceId: z.string().max(100).optional(), operator: z.string().max(100).optional(), cursor: Cursor, limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(Action), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), after = readCursor(q.cursor);
    const { rows } = await c.env.db.execute<z.infer<typeof Action> & { key: string; ts: string }>(sql`SELECT * FROM (SELECT ${isoAt(sql`at`)} AS at,at AS ts,${auditKey} AS key,workspace_id AS "workspaceId",action,operator_id AS "operatorId",
      (SELECT email FROM nightmail_users WHERE id=operator_id) AS "operatorEmail",via,
      coalesce(reason,details->>'reason') AS reason,ticket_ref AS "ticketRef",request_id AS "requestId",before,after,details FROM hosted_operator_audit
      WHERE true ${q.workspaceId ? sql`AND workspace_id=${q.workspaceId}` : sql``} ${q.operator ? sql`AND operator_id=${q.operator}` : sql``} ${after ? sql`AND at<=${after.at}::timestamptz` : sql``}) a
      ${after ? sql`WHERE (a.ts,a.key)<(${after.at}::timestamptz,${after.key})` : sql``} ORDER BY a.ts DESC,a.key DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page.map(({ key: _, ts: __, ...row }) => row as z.infer<typeof Action>), nextCursor: rows.length > q.limit && last ? `${last.at}|${last.key}` : null }, 200);
  });
  // The waitlist (migration 366): verified sign-ins nothing admitted yet, to email when Nightmail opens. Full
  // addresses, for staff only; newest attempt first, searched by address or name.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/waitlist', operationId: 'operatorListWaitlist',
    request: { query: z.object({ q: z.string().trim().max(200).optional(), cursor: Cursor, limit: z.coerce.number().int().min(1).max(1000).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(WaitlistEntry), nextCursor: z.string().nullable(), total: z.number().int().describe('Entries matching q, every page.') })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), after = readCursor(q.cursor), search = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const match = search ? sql`(email ILIKE ${search} OR name ILIKE ${search})` : sql`true`;
    const { rows } = await c.env.db.execute<z.infer<typeof WaitlistEntry>>(sql`SELECT email,name,attempts,${isoAt(sql`first_at`)} AS "firstAt",${isoAt(sql`last_at`)} AS "lastAt",
        ${isoAt(sql`let_in_at`)} AS "letInAt",CASE ${waitlistNoticeStatus(sql`email`)} WHEN 'sent' THEN 'sent' WHEN 'pending' THEN 'queued' WHEN 'sending' THEN 'queued' WHEN 'failed' THEN 'failed' END AS emailed
      FROM nightmail_waitlist WHERE ${match} ${after ? sql`AND (last_at,email)<(${after.at}::timestamptz,${after.key})` : sql``} ORDER BY last_at DESC,email DESC LIMIT ${q.limit + 1}`);
    const { rows: [count] } = await c.env.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM nightmail_waitlist WHERE ${match}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.lastAt}|${last.email}` : null, total: count?.total ?? 0 }, 200);
  });

  // The sign-up limit (src/signups.ts): how many accounts may sign up on their own, and what fills it. A raise lets the
  // oldest waiting addresses in first, or opens its places to anyone; lowering it removes nobody. Every change is audited
  // (workspace 'platform').
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/signups', operationId: 'operatorGetSignups',
    responses: { 200: response(SignupPlaces), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    return c.json(await readPlaces(c.env.db), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/signups', operationId: 'operatorSetSignupLimit',
    request: { headers: z.object({ 'Idempotency-Key': Mutation['Idempotency-Key'] }), body: json(z.object({ limit: z.number().int().min(0).max(1_000_000),
      raise: z.enum(['hold', 'open']).default('hold').describe('hold: a raise holds the places it adds for the oldest waiting addresses and emails them. open: it holds none and emails nobody; its places go to whoever signs in next.'),
      reason: Reason.optional(), ticketRef: TicketRef }).strict()) },
    responses: { 200: response(SignupPlaces.extend({ letIn: z.number().int().describe('Waiting addresses this change let in, oldest first.'),
      emailed: z.number().int().describe('Held addresses emailed now that they can sign in: those this change let in, and any an earlier save missed. Always 0 for an open raise.'),
      notEmailed: z.number().int().nullable().describe('Held addresses still not emailed (save again to retry); null when it could not be checked.') })), ...errors } }), async c => {
    const body = c.req.valid('json'), operator = await operatorActor(c, 'operator');
    const result = await mutate(c, operator, 'platform', body, async tx => {
      const change = await setLimit(tx, body.limit, body.raise);
      return { result: { ...change.after, letIn: change.letIn.length },
        audit: { action: 'operator-set-signup-limit', before: { limit: change.before.limit }, after: { limit: body.limit, raise: body.raise, letIn: change.letIn.length }, reason: body.reason, ticketRef: body.ticketRef } };
    });
    // After the commit: an email that fails or is slow can't undo the change. Each address is emailed once, ever; an
    // open raise emails nobody. A lowered limit can leave sign-ups nearly full or full, and a raise reopens them, so the
    // operators' places alert is checked too (operator-alerts.ts signupPlacesAlert).
    const opened = await placesOpened(c.env, body.raise === 'hold');
    await (await import('./operator-alerts.js')).signupPlacesAlert(c.env);
    return c.json({ ...result, ...opened }, 200);
  });
  // The content screen beside the second classifier that repeats its requests (src/screen-shadow.ts): how often they
  // agree at the threshold, how far their scores are apart, how each one's requests ended and how long they took. Read
  // from screen_comparisons alone; IDs and digests, never content. `since` defaults to the last 24 hours (rows are kept 90 days).
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/screen-comparison', operationId: 'operatorScreenComparison',
    request: { query: z.object({ since: z.string().datetime({ offset: true }).optional().describe('RFC 3339; default 24 hours ago.') }) },
    responses: { 200: response(ScreenComparison), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const { since } = c.req.valid('query'), oldest = Date.now() - 90 * 86400_000;
    return c.json(await screenComparison(c.env.db, new Date(Math.max(oldest, since ? Date.parse(since) : Date.now() - 86400_000)), !!c.env.config.shadow), 200);
  });
  // The database disk alert (src/disk-alert.ts): the URL and Authorization header to give PlanetScale's webhook. The header
  // is a credential derived from the root secret, so only a full operator reads it, and each read is audited.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/database-disk-alert', operationId: 'operatorGetDiskAlertSetup',
    responses: { 200: response(z.object({ url: z.string(), authorization: z.string(), events: z.array(z.string()) })), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator');
    await writeOperatorAudit(c.env.db, c, operator, 'platform', { action: 'operator-read-disk-alert-setup' });
    return c.json(diskAlertSetup(c.env.config), 200);
  });
  // Every workspace, newest first, with what judging sign-ups needs: when it joined, its owner, a verified domain, what
  // it sent and its standing. Paged by the API's cursor.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/signups/workspaces', operationId: 'operatorListAllWorkspaces',
    request: { query: z.object({ cursor: Cursor, limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(WorkspaceSummary), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), after = readCursor(q.cursor);
    const verified = (w: SQL) => sql`FROM domain_claims dc WHERE dc.workspace_id=${w} AND dc.sending_state IN ('verified','lost')`;
    const { rows } = await c.env.db.execute<z.infer<typeof WorkspaceSummary>>(sql`SELECT w.id,w.name,${isoAt(sql`w.created_at`)} AS "createdAt",
        (SELECT u.email FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id WHERE m.workspace_id=w.id AND m.role='owner' ORDER BY m.created_at,m.id LIMIT 1) AS owner,
        (SELECT min(dc.name) ${verified(sql`w.id`)}) AS domain,(SELECT count(*)::int ${verified(sql`w.id`)}) AS domains,
        (SELECT coalesce(sum(b.quantity),0)::float8 FROM billing_usage_hourly b WHERE b.workspace_id=w.id AND b.meter IN ('send','byo_send')) AS sent,
        CASE WHEN pc.workspace_id IS NULL THEN NULL WHEN pc.paused_at IS NOT NULL THEN 'pause' ELSE coalesce(s.step,'ok') END AS standing
      FROM workspaces w LEFT JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared' LEFT JOIN sender_standing s ON s.workspace_id=w.id
      ${after ? sql`WHERE (w.created_at,w.id)<(${after.at}::timestamptz,${after.key})` : sql``} ORDER BY w.created_at DESC,w.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.createdAt}|${last.id}` : null }, 200);
  });
}
