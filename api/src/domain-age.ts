import { sql } from 'drizzle-orm';
import { log, type DbExecutor, type Runtime } from './core.js';
import { placementRoot } from './domain-registry.js';

// When the domains Nightmail sends from and links on were registered (domain_registrations, migration 545), from each
// registry's public RDAP record, so the send review can tell a domain new to the internet from one only new here
// (src/standing-model.ts judgeReadiness). Looked up by the hourly pass only, never while a request waits: the registrable
// domains of every claimed domain and of the link domains, missing ones first, a known date again after REFRESH.known
// days, an unknown one after REFRESH.unknown. Unknown stays unknown: the review never takes it for old. Hosted only (it
// asks the registries over the internet); elsewhere the review judges by when a domain was added, as before.
const REFRESH = { known: 30, unknown: 1, perRun: 20, concurrency: 4, timeoutMs: 5_000 } as const;

/** The registrable domain of a host, or null (a public suffix, an IP, a shared hosting platform). */
export async function registrableRoot(host: string | null | undefined): Promise<string | null> {
  const name = host?.toLowerCase().replace(/\.$/, '');
  if (!name || !name.includes('.') || /^[\d.]+$/.test(name) || name.startsWith('[')) return null;
  const found = await placementRoot(name);
  return found.root && !found.shared ? found.root : null;
}

/** Registration dates of these registrable domains, as stored: root → days since registration (null: unknown or not looked up). */
export async function registeredDays(db: DbExecutor, roots: (string | null)[]): Promise<Map<string, { days: number | null; at: string | null }>> {
  const wanted = [...new Set(roots.filter((r): r is string => !!r))];
  if (!wanted.length) return new Map();
  const { rows } = await db.execute<{ root: string; at: string | null; days: number | null }>(sql`SELECT root, to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at,
      floor(extract(epoch FROM now() - registered_at) / 86400)::int AS days FROM domain_registrations
    WHERE root = ANY(${sql.param(wanted)}::text[]) AND status = 'known'`);
  return new Map(rows.map(r => [r.root, { days: r.days, at: r.at }]));
}

/** The hourly pass: looks up the registrable domains that are missing or due, a few at a time, within the run. */
export async function refreshRegistrations(runtime: Pick<Runtime, 'db' | 'config'>, lookup?: (root: string, signal: AbortSignal) => Promise<number | null>) {
  if (!runtime.config.multiTenant) return null;
  const { rows: claims } = await runtime.db.execute<{ name: string }>(sql`SELECT DISTINCT name FROM domain_claims`);
  const linkHosts = [runtime.config.linkHost, runtime.config.linkHosts?.target];
  const roots = [...new Set((await Promise.all([...claims.map(c => c.name), ...linkHosts].map(registrableRoot))).filter((r): r is string => !!r))];
  if (!roots.length) return { looked: 0, known: 0 };
  const { rows: due } = await runtime.db.execute<{ root: string }>(sql`SELECT r.root FROM unnest(${sql.param(roots)}::text[]) AS r(root)
      LEFT JOIN domain_registrations d ON d.root = r.root
    WHERE d.root IS NULL OR (d.status = 'known' AND d.checked_at < now() - make_interval(days => ${REFRESH.known}))
      OR (d.status = 'unknown' AND d.checked_at < now() - make_interval(days => ${REFRESH.unknown}))
    ORDER BY d.checked_at NULLS FIRST, r.root LIMIT ${REFRESH.perRun}`);
  const fetch = lookup ?? (async (root: string, signal: AbortSignal) => (await import('./placement-probes.js')).rdapRegistered(root, signal));
  let known = 0;
  for (let i = 0; i < due.length; i += REFRESH.concurrency) {
    await Promise.all(due.slice(i, i + REFRESH.concurrency).map(async ({ root }) => {
      const created = await fetch(root, AbortSignal.timeout(REFRESH.timeoutMs)).catch(() => null);
      if (created !== null) known++;
      await runtime.db.execute(sql`INSERT INTO domain_registrations (root, registered_at, status, checked_at)
        VALUES (${root}, ${created === null ? null : new Date(created).toISOString()}::timestamptz, ${created === null ? 'unknown' : 'known'}, now())
        ON CONFLICT (root) DO UPDATE SET registered_at = coalesce(excluded.registered_at, domain_registrations.registered_at),
          status = CASE WHEN excluded.status = 'known' OR domain_registrations.status = 'known' THEN 'known' ELSE 'unknown' END, checked_at = now()`);
    }));
  }
  if (due.length) log('info', { code: 'DOMAIN_REGISTRATIONS', looked: due.length, known });
  return { looked: due.length, known };
}
