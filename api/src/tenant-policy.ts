import { sql, type SQL } from 'drizzle-orm';
import { ApiError, isSimulatedSes, log, ModuleLoadError, wrapModuleLoad, type DbExecutor, type JobHandler } from './core.js';
import { retryDatabaseFailures } from './jobs.js';
import { probationReason, type ProbationReason } from './hosted-sending.js';
import type { TenantPolicy } from './ses-setup.js';

// Each Hosted workspace sends through its own SES tenant in each region, and AWS pauses a tenant on its own when its
// bounce or complaint rate crosses the line its reputation policy draws: strict pauses on a low-severity finding (bounces
// over 10% or complaints over 0.5%), standard only on a high-severity one (over 15% or 1%). A workspace's trust in
// Nightmail's own terms decides which, for every tenant it has (each region and pool):
// - strict while it is on probation (src/hosted-sending.ts probationReason: its evaluation, its growth pace, or below good
//   standing: a daily limit from its score or a strike, or a ladder step from warn up);
// - standard once it has graduated (no probation reason), or when an operator exempted it (exempt_hosted_quotas);
// - a fall back onto probation makes it strict at once, and a graduated workspace returns to standard no sooner than a
//   day after its last fall back (POLICY.settleHours), so a score at the edge of good standing moves it twice a day at most.
// Provisioning sets every new or repaired tenant strict (src/ses-setup.ts provisionTenant) and records it here, and the
// standing job's reconcile (src/standing.ts refreshStanding) queues any workspace with a tenant out of line.
// hosted_tenant_policy records what was applied, so AWS is called only for a tenant that differs. AWS refusing standard
// (the runtime IAM policy or its boundary does not allow it yet) leaves the tenant strict, logs SES_TENANT_POLICY_REFUSED
// and is asked again an hour later (POLICY.retryMinutes). Nothing waits on it: not provisioning, not sending.
export type PolicyWhy = 'exempt' | 'graduated' | ProbationReason;
export const POLICY = { settleHours: 24, retryMinutes: 60 } as const;

/** Why a workspace's tenants have their level: exempt or graduated (standard), else its probation reason (strict). */
export const tenantPolicyWhy = (wid: SQL) => sql<PolicyWhy>`(SELECT CASE WHEN w.exempt_hosted_quotas THEN 'exempt' ELSE coalesce(${probationReason(sql`w.id`)},'graduated') END FROM workspaces w WHERE w.id=${wid})`;
/** The level its tenants should have now. A graduated workspace that fell back waits out a day first. */
export const tenantPolicyLevel = (wid: SQL, why: SQL) => sql<TenantPolicy>`CASE WHEN ${why}='exempt' OR (${why}='graduated' AND NOT EXISTS (SELECT FROM hosted_tenant_policy d
  WHERE d.workspace_id=${wid} AND d.demoted_at>now()-make_interval(hours=>${POLICY.settleHours}))) THEN 'standard' ELSE 'strict' END`;
/** Ready Hosted tenants: what was applied to each, and the level and reason they should have now. */
const tenants = (where: SQL) => sql`SELECT c.workspace_id,r.region,CASE WHEN r.legacy THEN c.pool_tenant_name ELSE r.pool_tenant_name END AS tenant,r.managed_tenant,o.arn,
    p.applied,p.applied_at::text AS applied_at,coalesce(p.refused_at>now()-make_interval(mins=>${POLICY.retryMinutes}),false) AS waiting,x.why,${tenantPolicyLevel(sql`c.workspace_id`, sql`x.why`)} AS level
  FROM provider_connections c JOIN provider_connection_regions r ON r.connection_id=c.id AND r.tenant_state='ready'
  CROSS JOIN LATERAL (SELECT ${tenantPolicyWhy(sql`c.workspace_id`)} AS why) x
  LEFT JOIN hosted_tenant_ownership o ON o.workspace_id=c.workspace_id AND o.region=r.region
  LEFT JOIN hosted_tenant_policy p ON p.workspace_id=c.workspace_id AND p.region=r.region
  WHERE c.kind='shared' AND ${where}`;
/** Workspaces (or the one given) with a ready tenant whose recorded policy differs from its level, a refused standard after its hour. */
export const tenantPolicyDrift = (wid?: string) => sql`SELECT DISTINCT t.workspace_id FROM (${tenants(wid ? sql`c.workspace_id=${wid}` : sql`true`)}) t
  WHERE t.applied IS DISTINCT FROM t.level AND NOT (t.level='standard' AND t.waiting)`;
/** Queues the job that sets the workspace's tenants to their level (retry-safe by id; the job reads the current state). */
export const queueTenantPolicy = (workspaces: SQL) => sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'hosted.tenantPolicy:'||workspace_id,'hosted.tenantPolicy',workspace_id,'{}'::jsonb FROM (${workspaces}) w
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status<>'running'`;

/**
 * provisionTenant has just set a workspace tenant strict: record it before the tenant is marked ready, so the job (which
 * reads only ready tenants) never races it. A tenant that was standard before is reset, not demoted: no day's wait.
 * The caller queues tenantPolicyDrift(wid) once the tenant is ready.
 */
export async function recordProvisionedPolicy(db: DbExecutor, wid: string, region: string, tenant: string) {
  const { rows: [r] } = await db.execute<{ previous: TenantPolicy | null }>(sql`WITH before AS (SELECT applied FROM hosted_tenant_policy WHERE workspace_id=${wid} AND region=${region}),
    recorded AS (INSERT INTO hosted_tenant_policy AS p(workspace_id,region,applied,applied_at) VALUES(${wid},${region},'strict',now())
      ON CONFLICT(workspace_id,region) DO UPDATE SET applied='strict',applied_at=now())
    SELECT (SELECT applied FROM before) AS previous`);
  if (r?.previous !== 'strict') log('info', { code: 'SES_TENANT_POLICY_SET', workspaceId: wid, tenant, region, from: r?.previous ?? null, to: 'strict', why: 'provisioned' });
}

type Tenant = { region: string; tenant: string | null; managed_tenant: boolean; arn: string | null; applied: TenantPolicy | null; applied_at: string | null; waiting: boolean; why: PolicyWhy; level: TenantPolicy };
/**
 * Sets each ready tenant of one workspace whose recorded policy differs from its level. One tenant's failure doesn't
 * stop the others: AccessDenied is a definite "not applied" (logged, standard asked again after its hour); any other
 * error is an unknown outcome, so the record stays as it was and the retry applies the level again.
 */
export const tenantPolicyJob: JobHandler = retryDatabaseFailures(async (runtime, _payload, job) => {
  if (!runtime.config.multiTenant) return;
  const wid = job.workspaceId, simulated = isSimulatedSes(runtime);
  const { rows } = await runtime.db.execute<Tenant>(sql`${tenants(sql`c.workspace_id=${wid}`)} ORDER BY r.region`);
  const work = rows.filter(r => r.applied !== r.level && !(r.level === 'standard' && r.waiting));
  if (!work.length) return;
  const { mxResourceName, setTenantReputationPolicy } = await wrapModuleLoad(() => import('./ses-setup.js'));
  let failure: unknown;
  for (const row of work) {
    const tenant = row.tenant ?? (row.managed_tenant ? mxResourceName(wid) : `bane-${wid}`), at = { workspaceId: wid, tenant, region: row.region };
    if (!simulated) {
      try { await setTenantReputationPolicy(runtime, row.region, tenant, row.arn, row.level); }
      catch (error) {
        if (error instanceof ModuleLoadError) throw error;
        if (!(error instanceof ApiError && error.code === 'AWS_ACCESS_DENIED')) { failure ??= error; continue; }
        if (row.level === 'standard') await runtime.db.execute(sql`INSERT INTO hosted_tenant_policy AS p(workspace_id,region,refused_at) VALUES(${wid},${row.region},now())
          ON CONFLICT(workspace_id,region) DO UPDATE SET refused_at=excluded.refused_at`);
        log(row.level === 'standard' ? 'warn' : 'error', { code: 'SES_TENANT_POLICY_REFUSED', ...at, wanted: row.level, kept: row.applied ?? 'unknown', why: row.why,
          ...(row.level === 'standard' ? { retryInMinutes: POLICY.retryMinutes } : {}) });
        continue;
      }
    }
    // Compare-and-set on what was read: a provisioning that recorded strict meanwhile leaves which call AWS applied last
    // unknown, so the record says so and the next reconcile applies the level again.
    const demoted = row.applied === 'standard' && row.level === 'strict';
    const { rows: recorded } = await runtime.db.execute(sql`INSERT INTO hosted_tenant_policy AS p(workspace_id,region,applied,applied_at,demoted_at) VALUES(${wid},${row.region},${row.level},now(),${demoted ? sql`now()` : sql`NULL`})
      ON CONFLICT(workspace_id,region) DO UPDATE SET applied=excluded.applied,applied_at=excluded.applied_at,demoted_at=coalesce(excluded.demoted_at,p.demoted_at),
        refused_at=CASE WHEN excluded.applied='standard' THEN NULL ELSE p.refused_at END
      WHERE p.applied_at IS NOT DISTINCT FROM ${row.applied_at}::timestamptz RETURNING 1`);
    if (!recorded.length) { await runtime.db.execute(sql`UPDATE hosted_tenant_policy SET applied=NULL,applied_at=now() WHERE workspace_id=${wid} AND region=${row.region}`); continue; }
    log('info', { code: 'SES_TENANT_POLICY_SET', ...at, from: row.applied, to: row.level, why: row.why, simulated });
  }
  if (failure) throw failure;
});
