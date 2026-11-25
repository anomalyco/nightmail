import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { errors, logError, response, security, type App, type Runtime } from './core.js';
import { operatorActor } from './operator.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { PROVIDER_NAMES, type Provider } from './deliverability.js';
import { GRADE_BANDS, GRADES, type Grade } from './standing-model.js';
import { regionLabels } from './region-labels.js';
import { poolSends } from './states.js';

// Glass's Deliverability board (/glass?view=deliverability): is the platform's mail getting into mailboxes, read and
// clicked, by mailbox provider, for 24 hours, 7 days or 30 days beside the period before. One statement over rollups,
// cached GLASS_DELIVERABILITY_TTL_SECONDS a window and installation:
//  - our mail: deliverability_hourly (migrations 525-528), by creation hour, region, kind and recipient provider: at
//    most a few rows an hour, two windows of them (60 days at most);
//  - the top workspaces by complaints and bounces: sending_metrics_hourly per workspace through its (workspace_id, hour)
//    index (IDs only);
//  - standing: sender_standing (one row a workspace);
//  - Amazon's view: deliverability_vdm_daily (VDM's daily estimates per ISP) and deliverability_checks (each region's
//    GetAccount health, each VDM read and each platform domain's Spamhaus DBL listing), written by
//    refreshDeliverabilitySources from the minute tick: SES health every 10 minutes, VDM and DBL hourly;
//  - Google's view: deliverability_postmaster_daily (Gmail Postmaster Tools per platform domain and day), read every
//    6 hours with the OAuth grant in NIGHTMAIL_POSTMASTER_CREDENTIALS.
// Behind the operator gate like every /v1/operator path, and hidden from the public OpenAPI document.

export const GLASS_DELIVERABILITY_TTL_SECONDS = 30;
export const DELIVERABILITY_WINDOWS = { '24h': 24, '7d': 168, '30d': 720 } as const;
export type DeliverabilityWindow = keyof typeof DELIVERABILITY_WINDOWS;
/** VDM's metrics (BatchGetMetricData), as the board names them. Amazon counts a message with one recipient only. */
export const VDM_METRICS = { SEND: 'send', DELIVERY: 'delivery', PERMANENT_BOUNCE: 'permanentBounce', TRANSIENT_BOUNCE: 'transientBounce', COMPLAINT: 'complaint',
  DELIVERY_COMPLAINT: 'deliveryComplaint', OPEN: 'open', DELIVERY_OPEN: 'deliveryOpen', CLICK: 'click', DELIVERY_CLICK: 'deliveryClick' } as const;
/** The ISPs VDM is asked about, as Amazon names them ('' is every ISP), and the provider each is on the board. */
export const VDM_ISPS: Record<string, Provider | 'all'> = { '': 'all', Gmail: 'gmail', Outlook: 'microsoft', Hotmail: 'microsoft', Yahoo: 'yahoo', AOL: 'yahoo', Apple: 'apple', iCloud: 'apple' };

const int = z.number().int();
const COUNT_KEYS = ['accepted', 'delivered', 'hardBounced', 'softBounced', 'deferred', 'complained', 'opened', 'humanOpened', 'clicked'] as const;
const Counts = z.object(Object.fromEntries(COUNT_KEYS.map(k => [k, int])) as Record<(typeof COUNT_KEYS)[number], typeof int>)
  .describe('Emails created in the period and what became of them by now. softBounced, deferred and humanOpened: emails with at least one such event (an open SES did not flag as a bot or privacy proxy is human).');
const Vdm = z.object(Object.fromEntries(Object.values(VDM_METRICS).map(k => [k, z.number()])) as Record<(typeof VDM_METRICS)[keyof typeof VDM_METRICS], z.ZodNumber>);
const Check = z.object({ status: z.string().nullable(), checkedAt: z.string().nullable() });
const Board = z.object({
  window: z.enum(['24h', '7d', '30d']), generatedAt: z.string(),
  since: z.string(), until: z.string(), previousSince: z.string(),
  coverageFrom: z.string().nullable().describe('The first hour the rollup has. A previous period that starts before it is partial.'),
  unit: z.enum(['hour', 'day']).describe('The series\u2019 bucket.'),
  cube: z.array(z.object({ provider: z.enum(PROVIDER_NAMES), kind: z.string(), region: z.string(), current: Counts, previous: Counts })),
  series: z.array(z.object({ at: z.string(), kind: z.string(), region: z.string() }).extend(Counts.shape)).describe('The period by bucket, oldest first; buckets without mail are left out.'),
  regions: z.array(z.object({ region: z.string(), place: z.string(), sending: z.boolean(),
    ses: Check.extend({ enforcement: z.string().nullable().describe('HEALTHY, PROBATION or SHUTDOWN.'), sendingEnabled: z.boolean().nullable(), productionAccess: z.boolean().nullable(),
      vdm: z.boolean().nullable(), engagement: z.boolean().nullable(), error: z.string().nullable() }),
    vdm: Check.extend({ error: z.string().nullable(), since: z.string(), until: z.string(), previousSince: z.string(),
      providers: z.array(z.object({ provider: z.union([z.enum(PROVIDER_NAMES), z.literal('all')]), current: Vdm, previous: Vdm })) }) })),
  blocklist: z.array(Check.extend({ domain: z.string() })).describe('Spamhaus DBL through NIGHTMAIL_PLACEMENT_DBL_ZONE: listed, clear, unknown or unconfigured.'),
  postmaster: z.array(Check.extend({ domain: z.string(), url: z.string(), error: z.string().nullable(),
    latest: z.object({ day: z.string(), spamRatio: z.number().nullable(), spf: z.number().nullable(), dkim: z.number().nullable(), dmarc: z.number().nullable(), deliveryErrorRatio: z.number().nullable() }).nullable()
      .describe('Google\u2019s latest day for the domain: published a day or two late, and only for a day with enough mail to Gmail.'),
    spamRatio: z.object({ current: z.number().nullable(), previous: z.number().nullable() }).describe('Gmail users\u2019 spam reports over mail delivered, the mean of the period\u2019s published days.') }))
    .describe('Gmail Postmaster Tools for each platform domain. status null: not connected (NIGHTMAIL_POSTMASTER_CREDENTIALS unset).'),
  standing: z.object({ grades: z.record(z.enum(GRADES), int), calibrating: int, steps: z.object({ ok: int, notice: int, warn: int, restrict: int, pause: int }) }),
  top: z.object({ complaints: z.array(z.object({ workspaceId: z.string(), accepted: int, bounced: int, complained: int })), bounces: z.array(z.object({ workspaceId: z.string(), accepted: int, bounced: int, complained: int })) })
    .describe('The 10 workspaces with the most complaints and the most bounces in the period (simulated mail included), IDs only.'),
});
export type DeliverabilityBoard = z.infer<typeof Board>;
type CountsRow = Record<(typeof COUNT_KEYS)[number], number>;

const utc = (value: SQL) => sql`to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const sums = sql.raw(`sum(accepted)::bigint AS accepted,sum(delivered)::bigint AS delivered,sum(hard_bounced)::bigint AS "hardBounced",sum(soft_bounced)::bigint AS "softBounced",
  sum(deferred)::bigint AS deferred,sum(complained)::bigint AS complained,sum(opened)::bigint AS opened,sum(human_opened)::bigint AS "humanOpened",sum(clicked)::bigint AS clicked`);
// The grade bands as SQL, best first (src/standing-model.ts); Glass's own figures use them too.
export const gradeCounts = sql.join(GRADE_BANDS.map((band, i) => {
  const above = GRADE_BANDS[i - 1];
  return sql`${band.grade}::text,count(*) FILTER (WHERE s.phase='graded' AND s.score>=${band.min}${above ? sql` AND s.score<${above.min}` : sql``})`;
}), sql`,`);
/** The platform's own domains: the dashboard's (not an address or localhost) and the one built-in domains are under. */
export const platformDomains = (config: Pick<Runtime['config'], 'publicUrl' | 'builtinDomain'>) => [...new Set([new URL(config.publicUrl).hostname, ...config.builtinDomain ? [config.builtinDomain] : []])]
  .filter(name => name.includes('.') && !/^[\d.]+$|^\[|:/.test(name));
/** The domains whose Spamhaus DBL listing the board checks: the platform's own, and the link domain's zone (nightmailedge.com),
 *  which every customer's campaign and marketing links share (src/link-domains.ts), so one listing there is everyone's. */
export const blocklistDomains = (config: Pick<Runtime['config'], 'publicUrl' | 'builtinDomain' | 'linkHost' | 'linkHosts'>) => [...new Set([...platformDomains(config),
  ...[config.linkHost, config.linkHosts?.target].flatMap(host => host ? [host.split('.').slice(-2).join('.')] : [])])];

type Raw = {
  bounds: { since: string; until: string; prev: string; today: string }; coverage: string | null;
  cube: ({ provider: Provider; kind: string; region: string; current: boolean } & CountsRow)[];
  series: ({ at: string; kind: string; region: string } & CountsRow)[];
  grades: Record<Grade | 'calibrating', number>; steps: DeliverabilityBoard['standing']['steps'];
  top: { id: string; accepted: number; bounced: number; complained: number }[];
  checks: { kind: string; subject: string; status: string | null; detail: Record<string, unknown> | null; checked_at: string | null }[];
  pool: { region: string; sending: boolean }[];
  vdm: { region: string; isp: string; metric: string; current: boolean; value: number }[];
  vdm_days: { since: string; until: string; prev: string };
  postmaster: { domain: string; day: string; current: boolean; spam_ratio: number | null; spf_ratio: number | null; dkim_ratio: number | null; dmarc_ratio: number | null; error_ratio: number | null }[];
};

export async function readDeliverability(runtime: Pick<Runtime, 'db' | 'config'>, window: DeliverabilityWindow): Promise<DeliverabilityBoard> {
  const hours = DELIVERABILITY_WINDOWS[window], unit = window === '24h' ? 'hour' : 'day', days = Math.max(1, hours / 24);
  const { rows: [r] } = await runtime.db.execute<Raw>(sql`WITH b AS MATERIALIZED (SELECT date_trunc('hour',now(),'UTC')+interval '1 hour' AS until,(now() AT TIME ZONE 'UTC')::date AS today),
      win AS MATERIALIZED (SELECT until,until-make_interval(hours=>${hours}) AS since,until-make_interval(hours=>${hours * 2}) AS prev,today FROM b),
      d AS MATERIALIZED (SELECT x.*,x.hour>=win.since AS current FROM deliverability_hourly x,win WHERE x.hour>=win.prev AND x.hour<win.until),
      ws AS MATERIALIZED (SELECT w.id,sum(m.accepted)::bigint AS accepted,sum(m.bounced)::bigint AS bounced,sum(m.complained)::bigint AS complained FROM workspaces w
        CROSS JOIN LATERAL (SELECT accepted,bounced,complained FROM sending_metrics_hourly m WHERE m.workspace_id=w.id AND m.hour>=(SELECT since FROM win) AND m.hour<(SELECT until FROM win)) m
        GROUP BY w.id HAVING sum(m.bounced)>0 OR sum(m.complained)>0)
    SELECT (SELECT json_build_object('since',${utc(sql`since`)},'until',${utc(sql`until`)},'prev',${utc(sql`prev`)}) FROM win) AS bounds,
      (SELECT ${utc(sql`min(hour)`)} FROM deliverability_hourly) AS coverage,
      (SELECT coalesce(json_agg(c),'[]') FROM (SELECT provider,kind,region,current,${sums} FROM d GROUP BY 1,2,3,4) c) AS cube,
      (SELECT coalesce(json_agg(s ORDER BY s.at,s.kind,s.region),'[]') FROM (SELECT ${utc(sql`date_trunc(${unit},hour,'UTC')`)} AS at,kind,region,${sums} FROM d WHERE current GROUP BY 1,2,3) s) AS series,
      (SELECT json_build_object(${gradeCounts},'calibrating',count(*) FILTER (WHERE s.phase<>'graded' OR s.score IS NULL)) FROM sender_standing s) AS grades,
      (SELECT json_build_object('ok',count(*) FILTER (WHERE s.step='ok'),'notice',count(*) FILTER (WHERE s.step='notice'),'warn',count(*) FILTER (WHERE s.step='warn'),
          'restrict',count(*) FILTER (WHERE s.step='restrict'),'pause',count(*) FILTER (WHERE s.step='pause')) FROM sender_standing s) AS steps,
      (SELECT coalesce(json_agg(t),'[]') FROM ((SELECT * FROM ws WHERE complained>0 ORDER BY complained DESC,bounced DESC,id LIMIT 10)
        UNION (SELECT * FROM ws WHERE bounced>0 ORDER BY bounced DESC,complained DESC,id LIMIT 10)) t) AS top,
      (SELECT coalesce(json_agg(json_build_object('kind',kind,'subject',subject,'status',status,'detail',detail,'checked_at',${utc(sql`checked_at`)})),'[]') FROM deliverability_checks) AS checks,
      (SELECT coalesce(json_agg(json_build_object('region',p.region,'sending',${poolSends()}) ORDER BY p.region),'[]') FROM provider_pool_regions p) AS pool,
      (SELECT coalesce(json_agg(v),'[]') FROM (SELECT region,isp,metric,day>win.today-${days}::int AS current,sum(value) AS value FROM deliverability_vdm_daily,win
        WHERE day>win.today-${days * 2}::int AND day<=win.today GROUP BY 1,2,3,4) v) AS vdm,
      (SELECT json_build_object('since',(today-${days - 1}::int)::text,'until',today::text,'prev',(today-${days * 2 - 1}::int)::text) FROM win) AS vdm_days,
      (SELECT coalesce(json_agg(p ORDER BY p.domain,p.day),'[]') FROM (SELECT domain,day::text AS day,day>win.today-${days}::int AS current,spam_ratio,spf_ratio,dkim_ratio,dmarc_ratio,(delivery_errors->>'rate')::float8 AS error_ratio
        FROM deliverability_postmaster_daily,win WHERE day>win.today-${Math.max(days * 2, 14)}::int AND day<=win.today) p) AS postmaster`);
  return shape(r!, window, unit, runtime.config);
}

const zeroCounts = (): CountsRow => Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as CountsRow;
const zeroVdm = () => Object.fromEntries(Object.values(VDM_METRICS).map(k => [k, 0])) as z.infer<typeof Vdm>;
function shape(r: Raw, window: DeliverabilityWindow, unit: 'hour' | 'day', config: Pick<Runtime['config'], 'publicUrl' | 'builtinDomain' | 'linkHost' | 'linkHosts'>): DeliverabilityBoard {
  const counts = (row: Partial<CountsRow>) => Object.fromEntries(COUNT_KEYS.map(k => [k, Number(row[k] ?? 0)])) as CountsRow;
  const cube = new Map<string, DeliverabilityBoard['cube'][number]>();
  for (const row of r.cube) {
    const key = `${row.provider}\n${row.kind}\n${row.region}`, entry = cube.get(key) ?? { provider: row.provider, kind: row.kind, region: row.region, current: zeroCounts(), previous: zeroCounts() };
    entry[row.current ? 'current' : 'previous'] = counts(row);
    cube.set(key, entry);
  }
  const check = (kind: string, subject: string) => r.checks.find(c => c.kind === kind && c.subject === subject);
  const detail = (c: Raw['checks'][number] | undefined, key: string) => (c?.detail?.[key] ?? null) as never;
  const regions = r.pool.map(p => {
    const ses = check('ses', p.region), vdm = check('vdm', p.region);
    const sums = new Map<string, { current: z.infer<typeof Vdm>; previous: z.infer<typeof Vdm> }>();
    for (const v of r.vdm.filter(v => v.region === p.region)) {
      const provider = VDM_ISPS[v.isp], metric = VDM_METRICS[v.metric as keyof typeof VDM_METRICS];
      if (!provider || !metric) continue;
      const entry = sums.get(provider) ?? { current: zeroVdm(), previous: zeroVdm() };
      entry[v.current ? 'current' : 'previous'][metric] += Number(v.value);
      sums.set(provider, entry);
    }
    // Other: every ISP less the ones asked about by name.
    const all = sums.get('all');
    if (all) {
      const other = { current: zeroVdm(), previous: zeroVdm() };
      for (const period of ['current', 'previous'] as const) for (const metric of Object.values(VDM_METRICS))
        other[period][metric] = Math.max(0, all[period][metric] - [...sums].filter(([k]) => k !== 'all').reduce((n, [, e]) => n + e[period][metric], 0));
      if (Object.values(other.current).some(n => n > 0) || Object.values(other.previous).some(n => n > 0)) sums.set('other', other);
    }
    const order = ['all', ...PROVIDER_NAMES];
    return { region: p.region, place: regionLabels[p.region] ?? p.region, sending: p.sending,
      ses: { status: ses?.status ?? null, checkedAt: ses?.checked_at ?? null, enforcement: detail(ses, 'enforcement'), sendingEnabled: detail(ses, 'sendingEnabled'),
        productionAccess: detail(ses, 'productionAccess'), vdm: detail(ses, 'vdm'), engagement: detail(ses, 'engagement'), error: detail(ses, 'error') },
      vdm: { status: vdm?.status ?? null, checkedAt: vdm?.checked_at ?? null, error: detail(vdm, 'error'), since: r.vdm_days.since, until: r.vdm_days.until, previousSince: r.vdm_days.prev,
        providers: [...sums].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([provider, e]) => ({ provider: provider as Provider | 'all', ...e })) } };
  });
  const domains = platformDomains(config);
  const workspaces = r.top.map(t => ({ workspaceId: t.id, accepted: Number(t.accepted), bounced: Number(t.bounced), complained: Number(t.complained) }));
  return {
    window, generatedAt: new Date().toISOString(), since: r.bounds.since, until: r.bounds.until, previousSince: r.bounds.prev, coverageFrom: r.coverage, unit,
    cube: [...cube.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind) || a.region.localeCompare(b.region)),
    series: r.series.map(s => ({ at: s.at, kind: s.kind, region: s.region, ...counts(s) })),
    regions,
    blocklist: blocklistDomains(config).map(domain => { const c = check('dbl', domain); return { domain, status: c?.status ?? null, checkedAt: c?.checked_at ?? null }; }),
    postmaster: domains.map(domain => {
      const c = check('postmaster', domain), days = r.postmaster.filter(p => p.domain === domain), last = days.at(-1);
      const mean = (list: typeof days) => { const known = list.filter(p => p.spam_ratio !== null); return known.length ? known.reduce((n, p) => n + Number(p.spam_ratio), 0) / known.length : null; };
      return { domain, url: 'https://postmaster.google.com/', status: c?.status ?? null, checkedAt: c?.checked_at ?? null, error: detail(c, 'error'),
        latest: last ? { day: last.day, spamRatio: last.spam_ratio, spf: last.spf_ratio, dkim: last.dkim_ratio, dmarc: last.dmarc_ratio, deliveryErrorRatio: last.error_ratio } : null,
        spamRatio: { current: mean(days.filter(p => p.current)), previous: mean(days.filter(p => !p.current)) } };
    }),
    standing: { grades: Object.fromEntries(GRADES.map(grade => [grade, Number(r.grades[grade] ?? 0)])) as Record<Grade, number>, calibrating: Number(r.grades.calibrating ?? 0),
      steps: { ok: Number(r.steps.ok), notice: Number(r.steps.notice), warn: Number(r.steps.warn), restrict: Number(r.steps.restrict), pause: Number(r.steps.pause) } },
    top: { complaints: workspaces.filter(w => w.complained > 0).sort((a, b) => b.complained - a.complained || b.bounced - a.bounced || a.workspaceId.localeCompare(b.workspaceId)).slice(0, 10),
      bounces: workspaces.filter(w => w.bounced > 0).sort((a, b) => b.bounced - a.bounced || b.complained - a.complained || a.workspaceId.localeCompare(b.workspaceId)).slice(0, 10) },
  };
}

// ---------- sources: SES account health, VDM, Spamhaus DBL ----------
const errorName = (error: unknown) => (error as { name?: string })?.name && (error as { name: string }).name !== 'Error' ? String((error as { name: string }).name).slice(0, 80) : 'ERROR';
/**
 * Brings Amazon's and Spamhaus's figures up to date, from the minute tick (worker.ts, runner.ts): each region's
 * GetAccount every 10 minutes, its VDM figures and each platform domain's DBL listing every hour. Each check is elected
 * once (deliverability_checks.next_at), so any number of processes run it once. Reads go out with the platform's own
 * credentials (the runtime's IAM user needs ses:GetAccount and ses:BatchGetMetricData); Gmail Postmaster Tools, every
 * 6 hours, with the OAuth grant in NIGHTMAIL_POSTMASTER_CREDENTIALS when it is set (through `fetch`, which a test passes
 * in: the acceptance fixtures own the global one). Never throws: a failed check is
 * kept with its error's name, logged, and run again at its next time.
 */
export async function refreshDeliverabilitySources(runtime: Runtime, { fetch: get = fetch }: { fetch?: typeof fetch } = {}) {
  if (!runtime.config.multiTenant) return;
  try {
    const { rows } = await runtime.db.execute<{ kind: 'ses' | 'vdm' | 'dbl' | 'postmaster'; subject: string; account: string | null }>(sql`WITH wanted(kind,subject,account,every) AS (
        SELECT 'ses',region,aws_account_id,interval '10 minutes' FROM provider_pool_regions
        UNION ALL SELECT 'vdm',region,aws_account_id,interval '1 hour' FROM provider_pool_regions
        UNION ALL SELECT 'dbl',d,NULL,interval '1 hour' FROM unnest(${sql.param(blocklistDomains(runtime.config))}::text[]) d
        UNION ALL SELECT 'postmaster',d,NULL,interval '6 hours' FROM unnest(${sql.param(runtime.config.postmaster ? platformDomains(runtime.config) : [])}::text[]) d
      ), claimed AS (INSERT INTO deliverability_checks AS c (kind,subject,next_at) SELECT kind,subject,now()+every FROM wanted
        ON CONFLICT (kind,subject) DO UPDATE SET next_at=excluded.next_at WHERE c.next_at<=now() RETURNING c.kind,c.subject)
      SELECT c.kind,c.subject,w.account FROM claimed c JOIN wanted w USING (kind,subject) ORDER BY c.kind='vdm',c.kind,c.subject`);
    if (!rows.length) return;
    const { loadDispatchTransport, poolSes } = await import('./dispatcher.js');
    let transport: Awaited<ReturnType<typeof loadDispatchTransport>> | undefined, google: Promise<string> | undefined;
    for (const row of rows) {
      let status = 'ok', detail: Record<string, unknown> | null = null;
      try {
        if (row.kind === 'dbl') status = await blocklisted(runtime, row.subject);
        else if (row.kind === 'postmaster') detail = await readPostmaster(runtime, row.subject, await (google ??= postmasterToken(runtime.config.postmaster!, get)), get);
        else {
          transport ??= await loadDispatchTransport(runtime);
          const { ses } = poolSes(runtime, transport, row.subject, row.account!);
          if (row.kind === 'ses') {
            const a = await ses.send(new transport.GetAccountCommand({}));
            detail = { enforcement: a.EnforcementStatus ?? null, sendingEnabled: a.SendingEnabled ?? null, productionAccess: a.ProductionAccessEnabled ?? null,
              vdm: a.VdmAttributes?.VdmEnabled === 'ENABLED', engagement: a.VdmAttributes?.DashboardAttributes?.EngagementMetrics === 'ENABLED' };
          } else {
            const { rows: [health] } = await runtime.db.execute<{ vdm: boolean | null }>(sql`SELECT (detail->>'vdm')::boolean AS vdm FROM deliverability_checks WHERE kind='ses' AND subject=${row.subject}`);
            if (!health?.vdm) status = 'disabled';
            else detail = await readVdm(runtime, ses, row.subject);
            if (detail?.error) status = 'error';
          }
        }
      } catch (error) {
        status = 'error'; detail = { error: errorName(error) };
        logError(error, { code: 'DELIVERABILITY_SOURCE_FAILED', kind: row.kind, subject: row.subject }, 'warn');
      }
      // A failed check is tried again in 15 minutes rather than at its next time (a deploy, a revoked grant put right).
      await runtime.db.execute(sql`UPDATE deliverability_checks SET status=${status},detail=${detail ? JSON.stringify(detail) : null}::jsonb,checked_at=now()${status === 'error' ? sql`,next_at=least(next_at,now()+interval '15 minutes')` : sql``} WHERE kind=${row.kind} AND subject=${row.subject}`);
    }
  } catch (error) { logError(error, { code: 'DELIVERABILITY_SOURCE_FAILED' }, 'warn'); }
}

/** VDM's last 60 days (its longest interval) for every ISP asked about and in all, upserted by day. */
async function readVdm(runtime: Runtime, ses: import('@aws-sdk/client-sesv2').SESv2Client, region: string) {
  const { BatchGetMetricDataCommand } = await import('@aws-sdk/client-sesv2');
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const start = new Date(today - 59 * 86_400_000), end = new Date(today + 86_400_000);
  const queries = Object.keys(VDM_ISPS).flatMap(isp => Object.keys(VDM_METRICS).map(metric => ({ isp, metric })));
  const rows: { day: string; isp: string; metric: string; value: number }[] = [], failed = new Set<string>();
  for (let i = 0; i < queries.length; i += 10) {
    const page = queries.slice(i, i + 10);
    const out = await ses.send(new BatchGetMetricDataCommand({ Queries: page.map((q, j) => ({ Id: `q${i + j}`, Namespace: 'VDM', Metric: q.metric as 'SEND',
      ...q.isp ? { Dimensions: { ISP: q.isp } } : {}, StartDate: start, EndDate: end })) }));
    for (const e of out.Errors ?? []) failed.add(String(e.Code ?? 'ERROR'));
    for (const result of out.Results ?? []) {
      const q = queries[Number(result.Id?.slice(1))];
      if (!q) continue;
      (result.Timestamps ?? []).forEach((at, k) => rows.push({ day: new Date(at).toISOString().slice(0, 10), isp: q.isp, metric: q.metric, value: Number(result.Values?.[k] ?? 0) }));
    }
  }
  if (rows.length) await runtime.db.execute(sql`INSERT INTO deliverability_vdm_daily AS v (region,day,isp,metric,value)
    SELECT ${region},r.day::date,r.isp,r.metric,r.value FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r(day text,isp text,metric text,value float8)
    ON CONFLICT (region,day,isp,metric) DO UPDATE SET value=excluded.value,fetched_at=now()`);
  return { days: new Set(rows.map(r => r.day)).size, ...failed.size ? { error: [...failed].sort().join(',') } : {} };
}

// Gmail Postmaster Tools (v2; v1 is retired): an access token from the stored grant (postmaster.traffic.readonly), then the
// domain's daily statistics. v2 has no domain reputation: Gmail's spam rate is the figure, beside SPF, DKIM and DMARC
// pass rates and the delivery error rate, each a share of the day's mail (0 to 1).
const POSTMASTER_API = 'https://gmailpostmastertools.googleapis.com/v2';
const googleError = (status: number, body: { error?: string | { status?: string } }) => Object.assign(new Error('Google refused the request'),
  { name: (typeof body.error === 'string' ? body.error : body.error?.status) ?? `HTTP_${status}` });
async function postmasterToken(grant: NonNullable<Runtime['config']['postmaster']>, get: typeof fetch) {
  const res = await get('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ client_id: grant.clientId, client_secret: grant.clientSecret, refresh_token: grant.refreshToken, grant_type: 'refresh_token' }) });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw googleError(res.status, body);
  return body.access_token;
}
const POSTMASTER_METRICS = [['spam', 'SPAM_RATE'], ['spf', 'AUTH_SUCCESS_RATE', 'auth_type = "spf"'], ['dkim', 'AUTH_SUCCESS_RATE', 'auth_type = "dkim"'],
  ['dmarc', 'AUTH_SUCCESS_RATE', 'auth_type = "dmarc"'], ['errors', 'DELIVERY_ERROR_RATE']] as const;
type DomainStat = { metric?: string; date?: { year: number; month: number; day: number }; value?: { floatValue?: number; doubleValue?: number } };
/** The last 60 days Google has for a domain, upserted by day (a day Google revises is written again). */
async function readPostmaster(runtime: Runtime, domain: string, token: string, get: typeof fetch) {
  const day = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  const query = { metricDefinitions: POSTMASTER_METRICS.map(([name, standardMetric, filter]) => ({ name, baseMetric: { standardMetric }, ...filter ? { filter } : {} })),
    aggregationGranularity: 'DAILY', pageSize: 200, timeQuery: { dateRanges: { dateRanges: [{ start: day(new Date(Date.now() - 59 * 86_400_000)), end: day(new Date()) }] } } };
  const stats: DomainStat[] = [];
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const res = await get(`${POSTMASTER_API}/domains/${encodeURIComponent(domain)}/domainStats:query`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...query, ...page ? { pageToken: page } : {} }) });
    const body = await res.json().catch(() => ({})) as { domainStats?: DomainStat[]; nextPageToken?: string; error?: { status?: string } };
    if (!res.ok) throw googleError(res.status, body);
    stats.push(...body.domainStats ?? []);
    if (!(page = body.nextPageToken)) break;
  }
  const days = new Map<string, Record<string, number | null>>();
  for (const s of stats) {
    if (!s.date || !s.metric) continue;
    const at = `${s.date.year}-${String(s.date.month).padStart(2, '0')}-${String(s.date.day).padStart(2, '0')}`, value = s.value?.floatValue ?? s.value?.doubleValue;
    days.set(at, { ...days.get(at), [s.metric]: typeof value === 'number' && Number.isFinite(value) ? value : null });
  }
  const rows = [...days].map(([at, v]) => ({ day: at, spam: v.spam ?? null, spf: v.spf ?? null, dkim: v.dkim ?? null, dmarc: v.dmarc ?? null, errors: v.errors === undefined || v.errors === null ? null : { rate: v.errors } }));
  if (rows.length) await runtime.db.execute(sql`INSERT INTO deliverability_postmaster_daily AS p (domain,day,spam_ratio,spf_ratio,dkim_ratio,dmarc_ratio,delivery_errors)
    SELECT ${domain},r.day::date,r.spam,r.spf,r.dkim,r.dmarc,r.errors FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r(day text,spam float8,spf float8,dkim float8,dmarc float8,errors jsonb)
    ON CONFLICT (domain,day) DO UPDATE SET spam_ratio=excluded.spam_ratio,spf_ratio=excluded.spf_ratio,dkim_ratio=excluded.dkim_ratio,
      dmarc_ratio=excluded.dmarc_ratio,delivery_errors=excluded.delivery_errors,fetched_at=now()`);
  return { days: rows.length };
}

async function blocklisted(runtime: Runtime, domain: string) {
  const zone = runtime.config.placementDblZone;
  if (!zone) return 'unconfigured';
  const { dbl } = await import('./placement-probes.js');
  return (await dbl(domain, zone, AbortSignal.timeout(5_000))) ?? 'unknown';
}

export function registerGlassDeliverability(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/glass/deliverability', operationId: 'operatorGetGlassDeliverability',
    description: `The platform's deliverability, for operators: our mail by mailbox provider, kind and region for a period and the one before, engagement, SES account health and Amazon VDM's estimates per region, Spamhaus DBL, standing and the workspaces with the most complaints and bounces. One statement over rollups, cached ${GLASS_DELIVERABILITY_TTL_SECONDS} seconds.`,
    request: { query: z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') }) },
    responses: { 200: response(Board), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const { window } = c.req.valid('query');
    const { value, hit } = await cachedDashboardRead(new URL(c.env.config.publicUrl).origin, `operator-glass-deliverability-${window}`, () => readDeliverability(c.env, window), GLASS_DELIVERABILITY_TTL_SECONDS);
    c.header('cache-control', 'private, no-store');
    c.header('x-nightmail-glass-cache', hit ? 'hit' : 'miss');
    return c.json(value, 200);
  });
}
