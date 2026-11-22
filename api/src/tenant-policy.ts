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
//   standing: a daily limit from its score or a strike, or a ladder step from warn up), while it is paused, and while a
//   resume's reduced limit runs (provider_connections.restore_until): Nightmail is still limiting it;
// - standard once it has graduated (none of those), or when an operator exempted it (exempt_hosted_quotas);
// - a fall back makes it strict at the next standing run, and a graduated workspace returns to standard no sooner than a
//   day after its last fall back (POLICY.settleHours), so a score at the edge of good standing moves it twice a day at most.
// Provisioning sets every new or repaired tenant strict (src/ses-setup.ts provisionTenant) and records it here, and the
// standing job's reconcile (src/standing.ts refreshStanding) queues any workspace with a tenant out of line.
// hosted_tenant_policy records what was applied, so AWS is called only for a tenant that differs. Before each call the job
// records "unknown" (NULL), which always differs from the level: a lost answer or a stopped Worker leaves it, and a later
// pass applies whatever the level is by then. AWS refusing standard (the runtime IAM policy or its boundary does not allow
// it yet) is a definite "not applied": the tenant stays strict, SES_TENANT_POLICY_REFUSED is logged and standard is asked
// again an hour later (POLICY.retryMinutes). Nothing waits on it: not provisioning, not sending.
export type PolicyWhy = 'exempt' | 'graduated' | ProbationReason | 'paused' | 'resume-limit';
export const POLICY = { settleHours: 24, retryMinutes: 60 } as const;

/** Why a workspace's tenants have their level: exempt or graduated (standard), else its probation reason, a pause or a resume's limit (strict). */
export const tenantPolicyWhy = (wid: SQL) => sql<PolicyWhy>`(SELECT CASE WHEN w.exempt_hosted_quotas THEN 'exempt' ELSE coalesce(${probationReason(sql`w.id`)},
  (SELECT CASE WHEN pc.paused_at IS NOT NULL THEN 'paused' WHEN pc.restore_until>now() THEN 'resume-limit' END FROM provider_connections pc WHERE pc.workspace_id=w.id AND pc.kind='shared'),
  'graduated') END FROM workspaces w WHERE w.id=${wid})`;
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
 * provisionTenant has just set a workspace tenant strict. Recorded strict over strict or over nothing. Over standard or
 * unknown it is recorded unknown instead: a policy job's standard may have reached AWS after this run's strict (two
 * provisioning runs, or a Virginia tenant repaired while ready), so the job settles it with one call. The caller records
 * before the tenant is marked ready and queues tenantPolicyDrift(wid) after.
 */
export async function recordProvisionedPolicy(db: DbExecutor, wid: string, region: string, tenant: string) {
  const { rows: [r] } = await db.execute<{ previous: TenantPolicy | null }>(sql`WITH before AS (SELECT applied FROM hosted_tenant_policy WHERE workspace_id=${wid} AND region=${region}),
    recorded AS (INSERT INTO hosted_tenant_policy AS p(workspace_id,region,applied,applied_at) VALUES(${wid},${region},'strict',clock_timestamp())
      ON CONFLICT(workspace_id,region) DO UPDATE SET applied=CASE WHEN p.applied='strict' THEN 'strict' END,applied_at=excluded.applied_at)
    SELECT (SELECT applied FROM before) AS previous`);
  if (r?.previous !== 'strict') log('info', { code: 'SES_TENANT_POLICY_SET', workspaceId: wid, tenant, region, from: r?.previous ?? null, to: 'strict', why: 'provisioned' });
}

type Tenant = { region: string; tenant: string | null; managed_tenant: boolean; arn: string | null; applied: TenantPolicy | null; applied_at: string | null; waiting: boolean; why: PolicyWhy; level: TenantPolicy };
/**
 * Sets each ready tenant of one workspace whose recorded policy differs from its level. Each call is journaled: the
 * record says unknown (NULL) before AWS is asked, compare-and-set on what was read, so a second writer skips it. One
 * tenant's failure doesn't stop the others. AccessDenied is a definite "not applied": the record goes back to what it was
 * (standard asked again after its hour). Any other error is an unknown outcome: the record stays unknown and the next
 * pass calls again, whatever the level is by then.
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
    const { rows: [mine] } = await runtime.db.execute<{ at: string }>(sql`INSERT INTO hosted_tenant_policy AS p(workspace_id,region,applied,applied_at) VALUES(${wid},${row.region},NULL,clock_timestamp())
      ON CONFLICT(workspace_id,region) DO UPDATE SET applied=NULL,applied_at=excluded.applied_at
      WHERE p.applied_at IS NOT DISTINCT FROM ${row.applied_at}::timestamptz RETURNING applied_at::text AS at`);
    if (!mine) continue; // Another writer got there first: the next pass decides.
    // Only this call's journal is settled. A provisioning run that wrote meanwhile left it unknown, and so it stays.
    const settle = (set: SQL) => runtime.db.execute(sql`UPDATE hosted_tenant_policy SET ${set} WHERE workspace_id=${wid} AND region=${row.region} AND applied IS NULL AND applied_at=${mine.at}::timestamptz`);
    if (!simulated) {
      try { await setTenantReputationPolicy(runtime, row.region, tenant, row.arn, row.level); }
      catch (error) {
        if (error instanceof ModuleLoadError) throw error;
        if (!(error instanceof ApiError && error.code === 'AWS_ACCESS_DENIED')) { failure ??= error; continue; }
        await settle(sql`applied=${row.applied},applied_at=${row.applied_at}::timestamptz${row.level === 'standard' ? sql`,refused_at=now()` : sql``}`);
        log(row.level === 'standard' ? 'warn' : 'error', { code: 'SES_TENANT_POLICY_REFUSED', ...at, wanted: row.level, kept: row.applied ?? 'unknown', why: row.why,
          ...(row.level === 'standard' ? { retryInMinutes: POLICY.retryMinutes } : {}) });
        continue;
      }
    }
    // A move to strict from standard, or from an unknown outcome that may have been standard, starts the day's wait.
    const demoted = row.level === 'strict' && (row.applied === 'standard' || (row.applied === null && row.applied_at !== null));
    await settle(sql`applied=${row.level},applied_at=clock_timestamp(),demoted_at=${demoted ? sql`now()` : sql`demoted_at`},refused_at=${row.level === 'standard' ? sql`NULL` : sql`refused_at`}`);
    log('info', { code: 'SES_TENANT_POLICY_SET', ...at, from: row.applied, to: row.level, why: row.why, simulated });
  }
  if (failure) throw failure;
});
