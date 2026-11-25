import { sql } from 'drizzle-orm';
import { log, wrapModuleLoad, type JobHandler, type Runtime } from './core.js';

// The domain setup check. Someone adds a domain, sees its records and leaves, and nothing tells them the records never
// went live. Every five minutes (elected, from the minute cron and the Node runner) domainSetupTick queues one
// domain.setupCheck job for each hosted domain still pending an hour after it was added, unless it was checked lately:
// every 15 minutes for its first six hours, then hourly until its 72 hours are up. The job asks public DNS for each
// pending record and for the zone's NS records (record-check.ts) and stores what it saw on the claim (setup_check, migration
// 477). Domain reads show that: each record's status and the banner on the domain page and Overview ("2 of 4 records
// missing at Cloudflare"). With DOMAIN_SETUP_REMINDER=on, a check that finds a sending record missing or different also
// queues the one email to the workspace's owners and admins (account-notices.ts domainSetup), at most once per domain.
// The same tick, with NO_DOMAIN_REMINDER=on, emails a new workspace that has added no domain at all an hour after it was
// created (noDomainNotices), once; Overview asks for one either way (features/overview/no-domain.tsx).

export async function domainSetupTick(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  const elected = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at) VALUES ('maintenance:domain-setup',now()+interval '5 minutes')
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
  if (!elected.rows.length) return;
  const { rows } = await runtime.db.execute<{ id: string }>(sql`WITH due AS (SELECT d.id,dc.workspace_id,dc.token FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name
      WHERE NOT dc.ever_proven AND dc.sending_state='pending' AND dc.created_at<=now()-interval '1 hour'
        AND NOT domain_claim_expired(dc) AND NOT coalesce(dc.identity ? 'adopted',false)
        AND coalesce((dc.setup_check->>'checkedAt')::timestamptz,'-infinity')<=now()-CASE WHEN dc.created_at>now()-interval '6 hours' THEN interval '14 minutes' ELSE interval '59 minutes' END
      ORDER BY dc.setup_check->>'checkedAt' NULLS FIRST,dc.created_at LIMIT 100)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.setupCheck:'||token,'domain.setupCheck',workspace_id,jsonb_build_object('domainId',id,'token',token) FROM due
    ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status IN ('completed','failed')
    RETURNING id`);
  // New workspaces with no domain at all an hour on: the one email, with NO_DOMAIN_REMINDER=on.
  const notices = runtime.config.noDomainReminder ? await (await wrapModuleLoad(() => import('./account-notices.js'))).noDomainNotices(runtime) : 0;
  if (rows.length + notices) try { await runtime.wake?.(rows.length + notices); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Domain setup checks and notices are durable; the scheduler will run them.' }); }
}

// A record's name as a DNS provider asks for it: relative to the zone that hosts it, the full name when that is unknown.
const relative = (name: string, zone: string | undefined) => !zone ? name : name === zone ? '@' : name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;

export const domainSetupCheckJob: JobHandler = async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || typeof payload.domainId !== 'string' || typeof payload.token !== 'string') return;
  const [{ derivedReadiness, hostedDomain }, { checkSetup }] = await wrapModuleLoad(() => Promise.all([import('./operations.js'), import('./record-check.js')]));
  const row = await hostedDomain(runtime.db, job.workspaceId, payload.domainId);
  // Removed, added again, verified, released or adopted since it was queued: nothing to check.
  if (!row || row.token !== payload.token || row.expired || row.ever_proven || row.sending_state !== 'pending' || row.identity?.adopted) return;
  const report = derivedReadiness(row), check = await checkSetup(report);
  await runtime.db.execute(sql`UPDATE domain_claims SET setup_check=${JSON.stringify(check)}::jsonb WHERE workspace_id=${job.workspaceId} AND token=${row.token}::uuid AND sending_state='pending'`);
  if (!runtime.config.domainSetupReminder) return;
  // The records verification waits for (the ownership TXT and the DKIM CNAMEs); a custom MAIL FROM is optional.
  const sending = report.dns.filter(r => r.purpose === 'sending'), missing = sending.filter(r => r.publicDns && r.publicDns.state !== 'found');
  if (!missing.length) return;
  const { domainSetup } = await wrapModuleLoad(() => import('./account-notices.js'));
  const queued = await domainSetup(runtime.db, job.workspaceId, row.token, {
    domainId: row.id, name: row.name, total: sending.length, wrong: missing.some(r => r.publicDns?.state === 'wrong_value'),
    missing: missing.map(r => ({ type: r.type, name: relative(r.name, check.host?.zone), value: r.value })),
    host: check.host && { name: check.host.name, url: check.host.url },
    // Only an unproven claim is released, and only for want of its ownership TXT.
    releasesAt: missing.some(r => r.type === 'TXT') ? report.releasesAt ?? null : null,
  });
  if (queued) try { await runtime.wake?.(1); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'The notice is durable; the scheduler will send it.' }); }
};
