import { sql, type SQL } from 'drizzle-orm';
import { log, logError, ModuleLoadError, wrapModuleLoad, type JobHandler, type Runtime } from './core.js';
import { LINK_RETENTION_DAYS } from './link-hosts.js';

// The domain setup check. Someone adds a domain, sees its records and leaves, and nothing tells them the records never
// went live. Every five minutes (elected, from the minute cron and the Node runner) domainSetupTick queues one
// domain.setupCheck job for each hosted domain still pending an hour after it was added, unless it was checked lately:
// every 15 minutes for its first six hours, then hourly until its 72 hours are up. That includes a domain whose ownership
// TXT is proven but whose DKIM CNAMEs are not (the common case: one CNAME mistyped or left out). The job asks public DNS for each
// pending record and for the zone's NS records (record-check.ts) and stores what it saw on the claim (setup_check, migration
// 477). Domain reads show that: each record's status and the banner on the domain page and Overview ("2 of 4 records
// missing at Cloudflare"). With DOMAIN_SETUP_REMINDER=on, a check that finds a sending record missing or different also
// queues the one email to the workspace's owners and admins (account-notices.ts domainSetup), at most once per domain.
// The same tick, with NO_DOMAIN_REMINDER=on, emails a new workspace that has added no domain at all an hour after it was
// created (noDomainNotices), once; Overview asks for one either way (features/overview/onboarding-card.tsx).
// With link hosts on (src/link-domains.ts), it also queues a domain.linkCheck for each domain whose link host isn't
// active yet: every 15 minutes for its first day, then every 6 hours; an active one, daily. The check makes the host a custom hostname once its
// CNAME resolves, so a link record published after the domain verified needs no Check now. It never emails.

export async function domainSetupTick(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  const elected = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at) VALUES ('maintenance:domain-setup',now()+interval '5 minutes')
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
  if (!elected.rows.length) return;
  const { rows } = await runtime.db.execute<{ id: string }>(sql`WITH due AS (SELECT d.id,dc.workspace_id,dc.token FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name
      WHERE dc.sending_state='pending' AND dc.created_at<=now()-interval '1 hour' AND dc.created_at>now()-interval '72 hours'
        AND NOT domain_claim_expired(dc) AND NOT coalesce(dc.identity ?| array['adopted','builtin'],false)
        AND coalesce((dc.setup_check->>'checkedAt')::timestamptz,'-infinity')<=now()-CASE WHEN dc.created_at>now()-interval '6 hours' THEN interval '14 minutes' ELSE interval '59 minutes' END
      ORDER BY dc.setup_check->>'checkedAt' NULLS FIRST,dc.created_at LIMIT 100)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.setupCheck:'||token,'domain.setupCheck',workspace_id,jsonb_build_object('domainId',id,'token',token) FROM due
    ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status IN ('completed','failed')
    RETURNING id`);
  const links = runtime.config.linkHosts ? (await runtime.db.execute<{ id: string }>(sql`WITH due AS (SELECT d.id,dc.workspace_id,dc.token FROM domain_claims dc
      JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name LEFT JOIN link_hosts h ON h.workspace_id=dc.workspace_id AND h.domain=dc.name
      WHERE dc.sending_state IN ('pending','verified') AND NOT domain_claim_expired(dc) AND NOT coalesce(dc.identity ? 'builtin',false)
        -- An active host is checked again daily: a custom hostname deleted at Cloudflare (by hand, a cleanup race, or dev's
        -- checks on the shared zone) is made again instead of leaving every link in the domain's mail unanswered.
        AND coalesce(h.checked_at,'-infinity')<=now()-CASE WHEN h.status='active' THEN interval '1 day' WHEN h.created_at>now()-interval '1 day' THEN interval '14 minutes' ELSE interval '6 hours' END
      ORDER BY h.checked_at NULLS FIRST LIMIT 100)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.linkCheck:'||token,'domain.linkCheck',workspace_id,jsonb_build_object('domainId',id,'token',token) FROM due
    ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status IN ('completed','failed')
    RETURNING id`)).rows : [];
  // Link hosts of domains that are gone (deleted, released, a connection disconnected, a workspace deleted): one cleanup
  // job deletes their rows and custom hostnames (domainLinkCleanupJob).
  if (runtime.config.linkHosts) links.push(...(await runtime.db.execute<{ id: string }>(sql`INSERT INTO jobs(id,type,workspace_id,payload)
    SELECT 'domain.linkCleanup','domain.linkCleanup',${runtime.config.workspaceId},'{}'::jsonb WHERE EXISTS (${staleLinkHosts(sql`1`)})
    ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status IN ('completed','failed')
    RETURNING id`)).rows);
  // New workspaces with no domain at all an hour on: the one email, with NO_DOMAIN_REMINDER=on.
  const notices = runtime.config.noDomainReminder ? await (await wrapModuleLoad(() => import('./account-notices.js'))).noDomainNotices(runtime) : 0;
  // Built-in domains: the parent's check, the label backfill and the domains still to set up (builtin-domain.ts).
  let builtin = 0;
  if (runtime.config.builtinDomain) try { builtin = await (await wrapModuleLoad(() => import('./builtin-domain.js'))).builtinDomainTick(runtime); }
  catch (error) { if (error instanceof ModuleLoadError) throw error; logError(error, { code: 'BUILTIN_DOMAIN_TICK_FAILED' }); }
  if (rows.length + links.length + notices + builtin) try { await runtime.wake?.(rows.length + links.length + notices + builtin); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Domain setup checks and notices are durable; the scheduler will run them.' }); }
}

// A record's name as a DNS provider asks for it: relative to the zone that hosts it, the full name when that is unknown.
const relative = (name: string, zone: string | undefined) => !zone ? name : name === zone ? '@' : name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;

export const domainSetupCheckJob: JobHandler = async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || typeof payload.domainId !== 'string' || typeof payload.token !== 'string') return;
  const [{ derivedReadiness, hostedDomain }, { checkSetup, wildcardOf }, { checkLinkHost, withLinkRecords }] = await wrapModuleLoad(() => Promise.all([import('./operations.js'), import('./record-check.js'), import('./link-domains.js')]));
  const row = await hostedDomain(runtime.db, job.workspaceId, payload.domainId);
  // Removed, added again, verified, released, adopted or built in since it was queued: nothing to check.
  if (!row || row.token !== payload.token || row.expired || row.sending_state !== 'pending' || row.identity?.adopted || row.identity?.builtin || Date.parse(row.created_at) <= Date.now() - 72 * 3600_000) return;
  // The link record is one of the domain's records: checked (and its custom hostname made) with the rest.
  await checkLinkHost(runtime, job.workspaceId, row.name);
  const [report] = await withLinkRecords(runtime, job.workspaceId, [derivedReadiness(row)]), check = await checkSetup(report!);
  await runtime.db.execute(sql`UPDATE domain_claims SET setup_check=${JSON.stringify(check)}::jsonb WHERE workspace_id=${job.workspaceId} AND token=${row.token}::uuid AND sending_state='pending'`);
  if (!runtime.config.domainSetupReminder) return;
  // The records verification waits for (the ownership TXT and the DKIM CNAMEs) and the link record campaign and marketing
  // mail waits for; a custom MAIL FROM is optional.
  const sending = report!.dns.filter(r => r.purpose === 'sending' || r.purpose === 'links'), missing = sending.filter(r => r.publicDns && r.publicDns.state !== 'found');
  // A domain nobody serves DNS for can't take records at all: the email says to check its name instead (notices.ts).
  if (!missing.length && !check.noDns) return;
  const { domainSetup } = await wrapModuleLoad(() => import('./account-notices.js'));
  const queued = await domainSetup(runtime.db, job.workspaceId, row.token, {
    domainId: row.id, name: row.name, total: sending.length, ...(check.noDns ? { noDns: true } : {}), ...wildcardOf(missing), wrong: missing.some(r => r.publicDns?.state === 'wrong_value'),
    missing: missing.map(r => ({ type: r.type, name: relative(r.name, check.host?.zone), value: r.value })),
    host: check.host && { name: check.host.name, url: check.host.url },
    // Only an unproven claim is released, and only for want of its ownership TXT.
    releasesAt: missing.some(r => r.type === 'TXT') ? report!.releasesAt ?? null : null,
  });
  if (queued) try { await runtime.wake?.(1); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'The notice is durable; the scheduler will send it.' }); }
};

/** A Hosted domain's link host check, queued by domainSetupTick while the host isn't active (src/link-domains.ts). */
export const domainLinkCheckJob: JobHandler = async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || !runtime.config.linkHosts || typeof payload.domainId !== 'string' || typeof payload.token !== 'string') return;
  const { rows: [row] } = await runtime.db.execute<{ name: string }>(sql`SELECT d.name FROM operation_domains d JOIN domain_claims dc ON dc.workspace_id=d.workspace_id AND dc.name=d.name
    WHERE d.workspace_id=${job.workspaceId} AND d.id=${payload.domainId} AND dc.token=${payload.token}::uuid AND NOT domain_claim_expired(dc)`);
  // Removed or released since it was queued: nothing to check.
  if (row) await (await wrapModuleLoad(() => import('./link-domains.js'))).checkLinkHost(runtime, job.workspaceId, row.name);
};

/** Link hosts whose domain is gone from its workspace (no operation_domains row of that name: deleting, releasing or
 *  detaching a claim and deleting a workspace all remove it), still to retire or remove: an active one retires, and a retired
 *  one goes once LINK_RETENTION_DAYS have passed. */
const staleLinkHosts = (select: SQL) => sql`SELECT ${select} FROM link_hosts h WHERE NOT EXISTS (SELECT 1 FROM operation_domains d WHERE d.workspace_id=h.workspace_id AND d.name=h.domain)
  AND (h.status<>'retired' OR h.retired_at <= now() - make_interval(days => ${LINK_RETENTION_DAYS}))`;
/** Retires gone domains' link hosts, and removes them and their custom hostnames once retained long enough (src/link-domains.ts cleanUpLinkHosts). */
export const domainLinkCleanupJob: JobHandler = async runtime => {
  const count = await (await wrapModuleLoad(() => import('./link-domains.js'))).cleanUpLinkHosts(runtime);
  if (count) log('info', { code: 'LINK_HOSTS_CLEANED', count });
};
