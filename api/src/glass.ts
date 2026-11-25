import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { errors, response, security, type App, type Runtime } from './core.js';
import { operatorActor } from './operator.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { placesRow, withOpen, type Places } from './signups.js';
import { alertLabel, quantile } from './health.js';
import { LATENCY_BUCKETS } from './health-counters.js';
import { TICK } from './health-thresholds.js';
import { GRADES, type Grade } from './standing-model.js';
import { poolReceives, poolSends } from './states.js';
import { regionLabels } from './region-labels.js';
import { MicroCentsJson } from './billing/money.js';
import { PUBLIC_ROUTE } from './analytics-traffic.js';
import { gradeCounts, registerGlassDeliverability } from './glass-deliverability.js';

// Glass (/glass in the dashboard): everything going on in the installation on one page, for operators. One read that
// returns every figure, cached GLASS_TTL_SECONDS per installation, so the page's 30-second refresh costs one statement
// at most twice a minute however many operators watch it.
//
// The statement reads rollups and bounded heads, never a scan of mail:
//  - sending and delivery: sending_metrics_hourly (migration 407, kept exact by triggers), probed per workspace through
//    its (workspace_id, hour) index; the per-minute rate from public_stats_minutes (the pool's accepted mail by minute);
//  - queued and held mail: the partial indexes on queued and unscreened mail, counted to CAP + 1;
//  - received mail: each workspace's newest inbound messages since yesterday through mail_messages_tenant_page, at most
//    CAP + 1 a workspace (atLeast says when a count stopped there);
//  - sign-ups, standing, billing accounts, the health tables and the pool's regions with their SES quota samples
//    (provider_pool_regions, provider_account_limits): small tables (one row per account, workspace, alert or region);
//  - money: topups through the ledger's (kind, source_id) index, this month's cost from billing_months per account;
//  - visitors: analytics_hourly (#680), by its hour-first key: today's hours only, and at most GLASS_VISITOR_CODES visitor
//    codes told apart (a busier day's count is a lower bound). Page views and referrers are the public pages' (the paths
//    the public hook reports), the ones visitor codes count: a signed-in dashboard page view has no visitor code.
// Hidden from the public OpenAPI document. Like every /v1/operator path it is behind support.ts operatorGate: anyone but a
// signed-in operator gets the gate's one refusal, the same as for a path that doesn't exist, so nothing says it is here;
// the dashboard's /glass answers them "Page not found".

// The board asks every 5 seconds: a figure is at most this old, and an installation computes each read at most this
// often however many operators watch.
const GLASS_TTL_SECONDS = 5;
/** The activity feed's length: the newest this many events, of every kind together. */
export const GLASS_ACTIVITY = 50;
/** Bounded counts read at most this many rows (one more says the count is a lower bound). */
export const GLASS_CAP = 10_000;
/** Today's visitors are told apart among at most this many hourly visitor codes (#680 keeps up to 50,000 an hour). */
export const GLASS_VISITOR_CODES = 50_000;
const SEND_ROUTES = ['POST /v1/emails/send', 'POST /v1/emails/batch'];

const int = z.number().int();
const Count = z.object({ n: int, atLeast: z.boolean().describe(`n is a lower bound: counting stopped at ${GLASS_CAP.toLocaleString('en-US')}.`) });
const Split = z.object({ open: int, waitlist: int });
const Hour = z.object({ accepted: int, marketing: int.describe('Of accepted, marketing mail.'), delivered: int, bounced: int, complained: int });
const Day = z.object({ last: int.describe('The last 24 hours (the current hour and the 23 before it).'), previous: int.describe('The 24 hours before those.') });
const Glass = z.object({
  generatedAt: z.string(),
  signups: z.object({
    places: z.object({ limit: int, signedUp: int, held: int, waiting: int, open: int }),
    today: Split, week: Split.describe('The last 7 days.'),
    daily: z.array(int).describe('Sign-ups per UTC day, the last 14, oldest first.'),
    hourly: z.array(int).describe('Sign-ups per hour, the last 24, oldest first.'), day: Day,
    funnel: z.object({ signedUp: int, domainAdded: int, domainVerified: int, builtinReady: int.describe('Workspaces whose built-in domain sends.'), keyCreated: int, firstSend: int })
      .describe('Workspaces created in the last 30 days, and how many of them reached each step. Domains are their own (built-in ones apart).'),
  }),
  sending: z.object({
    perMinute: int.describe('Emails the pool accepted in the last whole minute.'), minutes: z.array(int).describe('The last 60 whole minutes, oldest first.'),
    today: z.object({ transactional: int, marketing: int }).describe('Accepted since UTC midnight.'),
    hourly: z.array(Hour).describe('The last 24 hours by creation hour, oldest first; the last is the current hour.'),
    previous: Hour.describe('The 24 hours before those, added up.'),
    queued: Count, held: Count.describe('Held for content screening.'),
    campaigns: z.array(z.object({ id: z.string(), name: z.string(), workspace: z.string(), total: int, released: int, rate: z.number().nullable() })),
    sendApi: z.object({ requests: int, p50Ms: int, p95Ms: int }).nullable().describe('POST /v1/emails/send and /batch over the last 15 minutes: upper bounds of the latency buckets.'),
  }),
  delivery: z.object({
    grades: z.record(z.enum(GRADES), int), calibrating: int,
    paused: int.describe('Hosted workspaces whose sending is paused.'), held: int.describe('Hosted workspaces whose marketing is held.'),
    steps: z.object({ ok: int, notice: int, warn: int, restrict: int, pause: int }).describe('Hosted workspaces by standing step.'),
    ramping: int.describe('Campaigns sending or scheduled on the ramp (#737).'), rampWaiting: int.describe('Of those, waiting for the ramp\u2019s next step.'),
  }),
  receiving: z.object({ today: int, spam: int, atLeast: z.boolean(), hourly: z.array(int).describe('The last 24 hours, oldest first.'), day: Day }),
  builtin: z.object({ active: int, ready: int.describe('Built-in domains that send.'), revoked: int,
    parent: z.object({ name: z.string(), ok: z.boolean(), problem: z.string().nullable(), trippedAt: z.string().nullable(), resetAt: z.string().nullable(), checkedAt: z.string() }).nullable() }),
  support: z.object({ open: int, ticketed: int, hourly: z.array(int).describe('Conversations started per hour, the last 24.'), day: Day,
    configured: z.object({ chat: z.boolean().describe('NIGHTMAIL_SUPPORT_SIGNING_KEY and NIGHTMAIL_SUPPORT_URL are set.'), email: z.boolean().describe('NIGHTMAIL_SUPPORT_ADDRESS_IDS is set.') }) }),
  screening: z.object({ compared: Count.describe('Content screened by both classifiers in the last 24 hours (the newest at most).'),
    agree: z.number().nullable().describe('Share of those where both gave the same verdict.'), jevFlagged: int, jevfFlagged: int,
    jevFailed: int.describe('Jev answered with an error or not at all (the second classifier answered instead).'), jevfFailed: int,
    screened: int.describe('Hosted mail screened in the last 24 hours.'), rejected: int, hourly: z.array(int).describe('Screened per hour, the last 24.') }),
  api: z.object({ hourly: z.array(z.object({ requests: int, errors4xx: int, errors5xx: int })).describe('The last 24 hours, oldest first.'), previous: z.object({ requests: int, errors4xx: int, errors5xx: int }),
    p50Ms: int.nullable(), p95Ms: int.nullable().describe('Every request of the last 15 minutes: the latency buckets\u2019 upper bounds.') }),
  money: z.object({ creditToday: MicroCentsJson, creditMonth: MicroCentsJson, creditDaily: z.array(int).describe('Cents added each UTC day this month.'),
    owed: MicroCentsJson, owing: int.describe('Workspaces with a negative balance.'), usageMonth: MicroCentsJson.describe('This month’s settled usage cost.') }),
  system: z.object({
    status: z.enum(['ok', 'warning', 'critical', 'stale']), measuredAt: z.string().nullable(),
    alerts: z.object({ critical: int, warning: int, top: z.array(z.object({ key: z.string(), label: z.string(), severity: z.enum(['critical', 'warning']), words: z.string(), since: z.string() })) }),
    ses: z.object({
      regions: z.array(z.object({ region: z.string(), place: z.string(), sending: z.boolean(), receiving: z.boolean(),
        maxSendRate: z.number().nullable(), max24HourSend: z.number().nullable(), sentLast24Hours: z.number().nullable(),
        checkedAt: z.string().nullable().describe('When SES last reported this region\u2019s quota. Null: never, and the figures are null.') })).describe('Every region of the shared pool, by name.'),
      total: z.object({ maxSendRate: z.number(), max24HourSend: z.number(), sentLast24Hours: z.number() }).describe('The regions that send and have a quota sample.'),
    }),
    deploy: z.object({ sha: z.string().nullable(), at: z.string().nullable() }),
  }),
  visitors: z.object({ views: int.describe('Public pages only (the ones visitor codes count), today.'), day: Day.describe('Public page views.'), visitors: Count.describe(`Told apart among at most ${GLASS_VISITOR_CODES.toLocaleString('en-US')} hourly visitor codes.`), hourly: z.array(int), referrers: z.array(z.object({ host: z.string(), views: int })).describe('Today.'),
    through: z.string().nullable().describe('The end of the last hour rolled up.') }),
});
export type Glass = z.infer<typeof Glass>;

type Raw = {
  places: Omit<Places, 'open'>; joined: { today: z.infer<typeof Split>; week: z.infer<typeof Split>; last: number; previous: number }; joined_daily: number[]; joined_hourly: number[]; funnel: Glass['signups']['funnel'];
  mail_previous: Glass['sending']['previous'] | null; steps: Glass['delivery']['steps']; ramp: { ramping: number; waiting: number };
  received_day: { last: number; previous: number }; builtin: { active: number; revoked: number; ready: number }; parent: Glass['builtin']['parent'];
  support: { open: number; ticketed: number; last: number; previous: number }; support_hourly: number[];
  screen: { n: number; agree: number; both: number; jev_flagged: number; jevf_flagged: number; jev_failed: number; jevf_failed: number } ; screened: { screened: number; rejected: number }; screened_hourly: number[];
  api: { back: number; key: string; n: number }[]; api_recent: { slowest: number; hist: number[] | null }[]; views_day: { last: number; previous: number };
  minutes: number[]; today: Glass['sending']['today']; hourly: Glass['sending']['hourly']; queued: number; held: number;
  campaigns: { id: string; name: string; workspace: string; total: number; released: number }[]; send_api: { n: number; slowest: number; hist: number[] | null }[];
  grades: Record<Grade | 'calibrating', number>; standing: { paused: number; held: number };
  received: { today: number; spam: number; capped: boolean }; received_hourly: number[];
  credit: { today: string; month: string }; credit_daily: number[]; owed: { uc: string; workspaces: number }; usage: string;
  health: { generatedAt: string | null; stale: boolean; campaigns: { id: string; rate: number | null }[] | null } | null;
  alerts: { key: string; kind: string; severity: 'critical' | 'warning'; words: string; since: string }[];
  ses: { region: string; sending: boolean; receiving: boolean; maxSendRate: number | null; max24HourSend: number | null; sentLast24Hours: number | null; checkedAt: string | null }[];
  views: number; visitors: { n: number; capped: boolean }; views_hourly: number[]; referrers: { host: string; views: number }[]; views_through: string | null;
};

const utc = (value: SQL) => sql`to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
/** n buckets from `start`, oldest first, each `counts`' n for its bucket or 0. `counts` returns (at, n). */
const series = (start: SQL, unit: 'minute' | 'hour' | 'day', n: number, counts: SQL, end?: SQL) => sql`(SELECT coalesce(json_agg(coalesce(c.n,0) ORDER BY g.at),'[]')
  FROM generate_series(${start},${end ?? sql`${start}+${`${n - 1} ${unit}s`}::interval`},${`1 ${unit}`}::interval) g(at) LEFT JOIN (${counts}) c ON c.at=g.at)`;

export async function readGlass(runtime: Pick<Runtime, 'db' | 'config'>): Promise<Glass> {
  const cap = GLASS_CAP + 1, own = new URL(runtime.config.publicUrl).hostname;
  const { rows: [r] } = await runtime.db.execute<Raw>(sql`WITH t AS MATERIALIZED (SELECT date_trunc('day',now(),'UTC') AS today,date_trunc('hour',now(),'UTC') AS hour,
      date_trunc('minute',now(),'UTC') AS minute,date_trunc('month',now(),'UTC') AS month,(date_trunc('month',now() AT TIME ZONE 'UTC'))::date AS month_date,
      least(date_trunc('day',now(),'UTC'),date_trunc('hour',now(),'UTC')-interval '23 hours') AS since,
      -- Rolling days: the current hour and the 23 before it (day), and the 24 hours before those.
      date_trunc('hour',now(),'UTC')-interval '23 hours' AS day,date_trunc('hour',now(),'UTC')-interval '47 hours' AS since48),
    mail AS MATERIALIZED (SELECT x.hour,x.kind='marketing' AS marketing,sum(x.accepted)::bigint AS accepted,sum(x.delivered)::bigint AS delivered,sum(x.bounced)::bigint AS bounced,sum(x.complained)::bigint AS complained
      FROM workspaces w CROSS JOIN LATERAL (SELECT m.hour,m.kind,m.accepted,m.delivered,m.bounced,m.complained FROM sending_metrics_hourly m WHERE m.workspace_id=w.id AND m.hour>=(SELECT since48 FROM t)) x GROUP BY 1,2),
    inbound AS MATERIALIZED (SELECT w.id,y.received_at,y.spam FROM workspaces w CROSS JOIN LATERAL (SELECT m.received_at,m.spam FROM mail_messages m
      WHERE m.workspace_id=w.id AND m.direction='inbound' AND m.received_at>=(SELECT since48 FROM t) ORDER BY m.received_at DESC LIMIT ${cap}) y),
    -- The newest comparisons of the two classifiers (screen-shadow.ts), through the table's (created_at, id) key.
    screens AS MATERIALIZED (SELECT created_at,jev_flagged,jevf_flagged,jev_outcome,jevf_outcome FROM screen_comparisons
      WHERE created_at>=(SELECT day FROM t) ORDER BY created_at DESC LIMIT ${cap}),
    -- Requests by status class (health-counters.ts kind 'status'): whole hours folded into health_hours, the rest still by minute.
    api AS MATERIALIZED (SELECT hour,key,n FROM health_hours WHERE hour>=(SELECT since48 FROM t) AND kind='status'
      UNION ALL SELECT date_trunc('hour',minute),key,n FROM health_minutes WHERE minute>=(SELECT since48 FROM t) AND kind='status'),
    -- Hashed, not sorted: count(DISTINCT) sorts.
    visitor_codes AS MATERIALIZED (SELECT v FROM analytics_hourly a CROSS JOIN LATERAL unnest(a.visitor_ids) v
      WHERE a.hour>=(SELECT today FROM t) AND a.metric='visit' LIMIT ${GLASS_VISITOR_CODES + 1})
    SELECT (SELECT row_to_json(p) FROM (${placesRow}) p) AS places,
      (SELECT json_build_object('today',json_build_object('open',count(*) FILTER (WHERE s.at>=t.today AND s.via='open'),'waitlist',count(*) FILTER (WHERE s.at>=t.today AND s.via='waitlist')),
          'week',json_build_object('open',count(*) FILTER (WHERE s.at>=now()-interval '7 days' AND s.via='open'),'waitlist',count(*) FILTER (WHERE s.at>=now()-interval '7 days' AND s.via='waitlist')),
          'last',count(*) FILTER (WHERE s.at>=t.day),'previous',count(*) FILTER (WHERE s.at>=t.since48 AND s.at<t.day))
        FROM nightmail_signups s WHERE s.at>=least(t.today,t.since48,now()-interval '7 days')) AS joined,
      ${series(sql`t.day`, 'hour', 24, sql`SELECT date_trunc('hour',s.at,'UTC') AS at,count(*) AS n FROM nightmail_signups s WHERE s.at>=t.day GROUP BY 1`)} AS joined_hourly,
      ${series(sql`t.today-interval '13 days'`, 'day', 14, sql`SELECT date_trunc('day',s.at,'UTC') AS at,count(*) AS n FROM nightmail_signups s WHERE s.at>=t.today-interval '13 days' GROUP BY 1`)} AS joined_daily,
      (SELECT json_build_object('signedUp',count(*),'domainAdded',count(*) FILTER (WHERE EXISTS (SELECT FROM domain_claims d WHERE d.workspace_id=w.id AND NOT coalesce(d.identity ? 'builtin',false))),
          'domainVerified',count(*) FILTER (WHERE EXISTS (SELECT FROM domain_claims d WHERE d.workspace_id=w.id AND d.sending_state IN ('verified','lost') AND NOT coalesce(d.identity ? 'builtin',false))),
          'builtinReady',count(*) FILTER (WHERE EXISTS (SELECT FROM domain_claims d WHERE d.workspace_id=w.id AND d.sending_state='verified' AND coalesce(d.identity ? 'builtin',false))),
          'keyCreated',count(k.workspace_id),
          'firstSend',count(*) FILTER (WHERE EXISTS (SELECT FROM analytics_funnel_first f WHERE f.workspace=w.id AND f.step='first_send') OR EXISTS (SELECT FROM sending_metrics_hourly m WHERE m.workspace_id=w.id AND m.accepted>0)))
        FROM workspaces w LEFT JOIN (SELECT DISTINCT workspace_id FROM api_keys) k ON k.workspace_id=w.id WHERE w.created_at>=now()-interval '30 days') AS funnel,
      ${series(sql`t.minute-interval '60 minutes'`, 'minute', 60, sql`SELECT minute AS at,accepted AS n FROM public_stats_minutes WHERE minute>=t.minute-interval '60 minutes' AND minute<t.minute`)} AS minutes,
      (SELECT json_build_object('transactional',coalesce(sum(accepted) FILTER (WHERE NOT marketing),0),'marketing',coalesce(sum(accepted) FILTER (WHERE marketing),0)) FROM mail WHERE hour>=t.today) AS today,
      (SELECT json_agg(json_build_object('accepted',coalesce(m.accepted,0),'marketing',coalesce(m.marketing,0),'delivered',coalesce(m.delivered,0),'bounced',coalesce(m.bounced,0),'complained',coalesce(m.complained,0)) ORDER BY g.at)
        FROM generate_series(t.hour-interval '23 hours',t.hour,interval '1 hour') g(at) LEFT JOIN (SELECT hour,sum(accepted) AS accepted,sum(accepted) FILTER (WHERE marketing) AS marketing,sum(delivered) AS delivered,
          sum(bounced) AS bounced,sum(complained) AS complained FROM mail GROUP BY 1) m ON m.hour=g.at) AS hourly,
      (SELECT json_build_object('accepted',coalesce(sum(accepted),0),'marketing',coalesce(sum(accepted) FILTER (WHERE marketing),0),'delivered',coalesce(sum(delivered),0),'bounced',coalesce(sum(bounced),0),
          'complained',coalesce(sum(complained),0)) FROM mail WHERE hour<t.day) AS mail_previous,
      (SELECT count(*)::int FROM (SELECT FROM sending_emails WHERE status='queued' LIMIT ${cap}) q) AS queued,
      (SELECT count(*)::int FROM (SELECT FROM sending_emails WHERE NOT screened AND status IN ('queued','scheduled') LIMIT ${cap}) q) AS held,
      (SELECT coalesce(json_agg(json_build_object('id',c.id,'name',c.name,'workspace',c.workspace,'total',c.total,'released',c.released) ORDER BY c.updated_at DESC),'[]') FROM (
        SELECT c.id,coalesce(c.draft->>'name',c.id) AS name,w.name AS workspace,c.total,c.expanded AS released,c.updated_at FROM sending_campaigns c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.state='sending' ORDER BY c.updated_at DESC LIMIT 3) c) AS campaigns,
      (SELECT coalesce(json_agg(json_build_object('n',n,'slowest',slowest,'hist',hist)),'[]') FROM health_minutes WHERE minute>=t.minute-interval '15 minutes' AND kind='route' AND key=ANY(${sql.param(SEND_ROUTES)}::text[])) AS send_api,
      (SELECT json_build_object(${gradeCounts},'calibrating',count(*) FILTER (WHERE s.phase<>'graded' OR s.score IS NULL)) FROM sender_standing s) AS grades,
      (SELECT json_build_object('ok',count(*) FILTER (WHERE s.step='ok'),'notice',count(*) FILTER (WHERE s.step='notice'),'warn',count(*) FILTER (WHERE s.step='warn'),
          'restrict',count(*) FILTER (WHERE s.step='restrict'),'pause',count(*) FILTER (WHERE s.step='pause')) FROM sender_standing s) AS steps,
      (SELECT json_build_object('ramping',count(*),'waiting',count(*) FILTER (WHERE c.waiting_reason='ramp')) FROM sending_campaigns c
        WHERE c.state IN ('scheduled','sending') AND c.ramp_step IS NOT NULL) AS ramp,
      (SELECT json_build_object('paused',count(*) FILTER (WHERE pc.paused_at IS NOT NULL),'held',count(*) FILTER (WHERE pc.paused_at IS NULL AND pc.marketing_held_at IS NOT NULL)) FROM provider_connections pc WHERE pc.kind='shared') AS standing,
      (SELECT json_build_object('today',count(*) FILTER (WHERE i.received_at>=t.today),'spam',count(*) FILTER (WHERE i.received_at>=t.today AND i.spam),
          'capped',EXISTS (SELECT FROM inbound GROUP BY id HAVING count(*)>=${cap})) FROM inbound i) AS received,
      (SELECT json_build_object('last',count(*) FILTER (WHERE i.received_at>=t.day),'previous',count(*) FILTER (WHERE i.received_at<t.day)) FROM inbound i) AS received_day,
      (SELECT json_build_object('active',count(*) FILTER (WHERE b.revoked_at IS NULL),'revoked',count(*) FILTER (WHERE b.revoked_at IS NOT NULL),
          'ready',(SELECT count(*) FROM domain_claims d WHERE d.sending_state='verified' AND coalesce(d.identity ? 'builtin',false))) FROM builtin_domains b) AS builtin,
      (SELECT json_build_object('name',p.name,'ok',p.ok,'problem',p.problem,'trippedAt',${utc(sql`p.tripped_at`)},'resetAt',${utc(sql`p.reset_at`)},'checkedAt',${utc(sql`p.checked_at`)})
        FROM builtin_parent p ORDER BY p.name LIMIT 1) AS parent,
      (SELECT json_build_object('open',count(*) FILTER (WHERE c.status='open'),'ticketed',count(*) FILTER (WHERE c.status='ticketed'),
          'last',count(*) FILTER (WHERE c.created_at>=t.day),'previous',count(*) FILTER (WHERE c.created_at>=t.since48 AND c.created_at<t.day))
        FROM support_conversations c WHERE c.status<>'closed' OR c.created_at>=t.since48) AS support,
      ${series(sql`t.day`, 'hour', 24, sql`SELECT date_trunc('hour',c.created_at,'UTC') AS at,count(*) AS n FROM support_conversations c WHERE c.created_at>=t.day GROUP BY 1`)} AS support_hourly,
      (SELECT json_build_object('n',count(*),'agree',count(*) FILTER (WHERE x.jev_flagged=x.jevf_flagged),'both',count(*) FILTER (WHERE x.jev_flagged IS NOT NULL AND x.jevf_flagged IS NOT NULL),
          'jev_flagged',count(*) FILTER (WHERE x.jev_flagged),'jevf_flagged',count(*) FILTER (WHERE x.jevf_flagged),
          'jev_failed',count(*) FILTER (WHERE x.jev_outcome<>'ok'),'jevf_failed',count(*) FILTER (WHERE x.jevf_outcome<>'ok')) FROM screens x) AS screen,
      (SELECT json_build_object('screened',coalesce(sum(h.screened),0),'rejected',coalesce(sum(h.rejected),0)) FROM workspaces w
        CROSS JOIN LATERAL (SELECT screened,rejected FROM hosted_screen_hourly s WHERE s.workspace_id=w.id AND s.hour>=t.day) h) AS screened,
      ${series(sql`t.day`, 'hour', 24, sql`SELECT h.hour AS at,sum(h.screened) AS n FROM workspaces w CROSS JOIN LATERAL (SELECT hour,screened FROM hosted_screen_hourly s WHERE s.workspace_id=w.id AND s.hour>=t.day) h GROUP BY 1`)} AS screened_hourly,
      (SELECT coalesce(json_agg(json_build_object('back',(extract(epoch FROM t.hour-a.hour)/3600)::int,'key',a.key,'n',a.n)),'[]') FROM (SELECT hour,key,sum(n)::bigint AS n FROM api GROUP BY 1,2) a) AS api,
      (SELECT coalesce(json_agg(json_build_object('slowest',slowest,'hist',hist)),'[]') FROM health_minutes WHERE minute>=t.minute-interval '15 minutes' AND kind='status') AS api_recent,
      ${series(sql`t.hour-interval '23 hours'`, 'hour', 24, sql`SELECT date_trunc('hour',received_at,'UTC') AS at,count(*) AS n FROM inbound GROUP BY 1`)} AS received_hourly,
      (SELECT json_build_object('today',coalesce(sum(l.paid_uc) FILTER (WHERE l.created_at>=t.today),0)::text,'month',coalesce(sum(l.paid_uc),0)::text) FROM billing_ledger l WHERE l.kind='topup' AND l.created_at>=t.month) AS credit,
      ${series(sql`t.month`, 'day', 0, sql`SELECT date_trunc('day',l.created_at,'UTC') AS at,(sum(l.paid_uc)/1000000)::bigint AS n FROM billing_ledger l WHERE l.kind='topup' AND l.created_at>=t.month GROUP BY 1`, sql`t.today`)} AS credit_daily,
      (SELECT json_build_object('uc',coalesce(sum(-a.balance_uc),0)::text,'workspaces',count(*)) FROM billing_accounts a WHERE a.unpaid_since IS NOT NULL AND a.balance_uc<0) AS owed,
      (SELECT coalesce(sum(billing_month_cost(b.month,b.sent,b.received,b.other_uc)),0)::text FROM billing_accounts a JOIN billing_months b ON b.workspace_id=a.workspace_id AND b.month=t.month_date) AS usage,
      (SELECT json_build_object('generatedAt',${utc(sql`h.generated_at`)},'stale',coalesce(h.generated_at<now()-make_interval(secs=>${TICK.staleSeconds}),true),'campaigns',h.rollup->'campaigns') FROM health_state h WHERE h.singleton) AS health,
      (SELECT coalesce(json_agg(a),'[]') FROM (SELECT key,kind,severity,words,${utc(sql`since`)} AS since FROM health_alerts ORDER BY severity='critical' DESC,since,key LIMIT 200) a) AS alerts,
      (SELECT coalesce(json_agg(json_build_object('region',p.region,'sending',${poolSends()},'receiving',${poolReceives()},'maxSendRate',l.max_send_rate,'max24HourSend',l.max_24_hour_send,
          'sentLast24Hours',l.sent_last_24_hours,'checkedAt',${utc(sql`l.checked_at`)}) ORDER BY p.region),'[]')
        FROM provider_pool_regions p LEFT JOIN provider_account_limits l ON l.aws_account_id=p.aws_account_id AND l.region=p.region AND l.checked_at IS NOT NULL) AS ses,
      (SELECT coalesce(sum(events),0)::int FROM analytics_hourly WHERE hour>=t.today AND metric='page_view' AND dimensions->>'path' ~ ${PUBLIC_ROUTE.source}) AS views,
      (SELECT json_build_object('last',coalesce(sum(events) FILTER (WHERE hour>=t.day),0),'previous',coalesce(sum(events) FILTER (WHERE hour<t.day),0)) FROM analytics_hourly
        WHERE hour>=t.since48 AND metric='page_view' AND dimensions->>'path' ~ ${PUBLIC_ROUTE.source}) AS views_day,
      json_build_object('n',(SELECT count(*) FROM (SELECT DISTINCT v FROM visitor_codes) d),'capped',(SELECT count(*) FROM visitor_codes)>${GLASS_VISITOR_CODES}) AS visitors,
      ${series(sql`t.hour-interval '24 hours'`, 'hour', 24, sql`SELECT hour AS at,sum(events) AS n FROM analytics_hourly WHERE hour>=t.hour-interval '24 hours' AND metric='page_view' AND dimensions->>'path' ~ ${PUBLIC_ROUTE.source} GROUP BY 1`)} AS views_hourly,
      (SELECT coalesce(json_agg(r ORDER BY r.views DESC,r.host),'[]') FROM (SELECT dimensions->>'referrer' AS host,sum(events)::int AS views FROM analytics_hourly
        WHERE hour>=t.today AND metric='page_view' AND dimensions->>'path' ~ ${PUBLIC_ROUTE.source} AND dimensions->>'referrer' IS NOT NULL AND dimensions->>'referrer'<>${own} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 3) r) AS referrers,
      (SELECT ${utc(sql`max(hour)+interval '1 hour'`)} FROM analytics_hours) AS views_through
    FROM t`);
  return shape(r!, runtime.config);
}

/** Requests by status class, hour by hour (the current hour last; a row's `back` is how many hours before it), and the
 *  latency of the last 15 minutes. */
function apiFigures(r: Pick<Raw, 'api' | 'api_recent'>): Glass['api'] {
  const empty = () => ({ requests: 0, errors4xx: 0, errors5xx: 0 }), hourly = Array.from({ length: 24 }, empty), previous = empty();
  for (const row of r.api) {
    const back = Number(row.back), bucket = back < 0 ? undefined : back < 24 ? hourly[23 - back] : back < 48 ? previous : undefined;
    if (!bucket) continue;
    bucket.requests += Number(row.n);
    if (row.key === '4xx') bucket.errors4xx += Number(row.n);
    if (row.key === '5xx') bucket.errors5xx += Number(row.n);
  }
  const hist = Array.from({ length: LATENCY_BUCKETS.length + 1 }, (_, i) => r.api_recent.reduce((sum, row) => sum + Number(row.hist?.[i] ?? 0), 0));
  const slowest = Math.max(0, ...r.api_recent.map(row => Number(row.slowest))), any = hist.some(n => n > 0);
  return { hourly, previous, p50Ms: any ? quantile(hist, 0.5, slowest) : null, p95Ms: any ? quantile(hist, 0.95, slowest) : null };
}

function shape(r: Raw, config: Pick<Runtime['config'], 'deploy' | 'support'>): Glass {
  const num = (value: unknown) => Number(value ?? 0);
  // The send routes' latency: their minutes' histograms added up, read as the Health page reads a route's.
  const rows = r.send_api.filter(row => row.n > 0), requests = rows.reduce((sum, row) => sum + row.n, 0);
  const hist = Array.from({ length: LATENCY_BUCKETS.length + 1 }, (_, i) => rows.reduce((sum, row) => sum + (row.hist?.[i] ?? 0), 0));
  const slowest = Math.max(0, ...rows.map(row => row.slowest));
  const rates = new Map((r.health?.campaigns ?? []).map(c => [c.id, c.rate]));
  const alerts = r.alerts.flatMap(a => { const label = alertLabel(a.kind); return label ? [{ key: a.key, label, severity: a.severity, words: a.words.replaceAll('`', ''), since: a.since }] : []; });
  const critical = alerts.filter(a => a.severity === 'critical').length, warning = alerts.length - critical;
  const status = !r.health?.generatedAt || r.health.stale ? 'stale' : critical ? 'critical' : warning ? 'warning' : 'ok';
  const nul = (value: unknown) => value === null || value === undefined ? null : Number(value);
  const hour = (h: Partial<Record<keyof Glass['sending']['previous'], unknown>>) => ({ accepted: num(h.accepted), marketing: num(h.marketing), delivered: num(h.delivered), bounced: num(h.bounced), complained: num(h.complained) });
  const regions = r.ses.map(p => ({ region: p.region, place: regionLabels[p.region] ?? p.region, sending: p.sending, receiving: p.receiving,
    maxSendRate: nul(p.maxSendRate), max24HourSend: nul(p.max24HourSend), sentLast24Hours: nul(p.sentLast24Hours), checkedAt: p.checkedAt }));
  const sampled = regions.filter(p => p.sending && p.checkedAt);
  const ses = { regions, total: { maxSendRate: sampled.reduce((n, p) => n + (p.maxSendRate ?? 0), 0), max24HourSend: sampled.reduce((n, p) => n + (p.max24HourSend ?? 0), 0), sentLast24Hours: sampled.reduce((n, p) => n + (p.sentLast24Hours ?? 0), 0) } };
  return {
    generatedAt: new Date().toISOString(),
    signups: { places: withOpen(r.places), today: r.joined.today, week: r.joined.week, daily: r.joined_daily.map(num), hourly: r.joined_hourly.map(num), day: { last: num(r.joined.last), previous: num(r.joined.previous) },
      funnel: { signedUp: num(r.funnel.signedUp), domainAdded: num(r.funnel.domainAdded), domainVerified: num(r.funnel.domainVerified), builtinReady: num(r.funnel.builtinReady), keyCreated: num(r.funnel.keyCreated), firstSend: num(r.funnel.firstSend) } },
    sending: {
      perMinute: num(r.minutes.at(-1)), minutes: r.minutes.map(num),
      today: { transactional: num(r.today.transactional), marketing: num(r.today.marketing) },
      hourly: r.hourly.map(hour), previous: hour(r.mail_previous ?? {}),
      queued: { n: Math.min(r.queued, GLASS_CAP), atLeast: r.queued > GLASS_CAP }, held: { n: Math.min(r.held, GLASS_CAP), atLeast: r.held > GLASS_CAP },
      campaigns: r.campaigns.map(c => ({ ...c, total: num(c.total), released: num(c.released), rate: rates.get(c.id) ?? null })),
      sendApi: requests ? { requests, p50Ms: quantile(hist, 0.5, slowest), p95Ms: quantile(hist, 0.95, slowest) } : null,
    },
    delivery: { grades: Object.fromEntries(GRADES.map(grade => [grade, num(r.grades[grade])])) as Record<Grade, number>, calibrating: num(r.grades.calibrating), paused: num(r.standing.paused), held: num(r.standing.held),
      steps: { ok: num(r.steps.ok), notice: num(r.steps.notice), warn: num(r.steps.warn), restrict: num(r.steps.restrict), pause: num(r.steps.pause) }, ramping: num(r.ramp.ramping), rampWaiting: num(r.ramp.waiting) },
    receiving: { today: num(r.received.today), spam: num(r.received.spam), atLeast: r.received.capped, hourly: r.received_hourly.map(num), day: { last: num(r.received_day.last), previous: num(r.received_day.previous) } },
    builtin: { active: num(r.builtin.active), ready: num(r.builtin.ready), revoked: num(r.builtin.revoked), parent: r.parent },
    support: { open: num(r.support.open), ticketed: num(r.support.ticketed), hourly: r.support_hourly.map(num), day: { last: num(r.support.last), previous: num(r.support.previous) },
      configured: { chat: Boolean(config.support?.signingKey && config.support.url), email: Boolean(config.support?.addressIds?.length) } },
    screening: { compared: { n: Math.min(num(r.screen.n), GLASS_CAP), atLeast: num(r.screen.n) > GLASS_CAP }, agree: num(r.screen.both) ? num(r.screen.agree) / num(r.screen.both) : null,
      jevFlagged: num(r.screen.jev_flagged), jevfFlagged: num(r.screen.jevf_flagged), jevFailed: num(r.screen.jev_failed), jevfFailed: num(r.screen.jevf_failed),
      screened: num(r.screened.screened), rejected: num(r.screened.rejected), hourly: r.screened_hourly.map(num) },
    api: apiFigures(r),
    money: { creditToday: r.credit.today, creditMonth: r.credit.month, creditDaily: r.credit_daily.map(num), owed: r.owed.uc, owing: num(r.owed.workspaces), usageMonth: r.usage },
    system: { status, measuredAt: r.health?.generatedAt ?? null, alerts: { critical, warning, top: alerts.slice(0, 3) }, ses, deploy: { sha: config.deploy?.sha ?? null, at: config.deploy?.at ?? null } },
    visitors: { views: num(r.views), day: { last: num(r.views_day.last), previous: num(r.views_day.previous) }, visitors: { n: num(r.visitors.n), atLeast: r.visitors.capped }, hourly: r.views_hourly.map(num), referrers: r.referrers, through: r.views_through },
  };
}

// The activity feed (the board's right column): what just happened across the installation, newest first. Each kind is
// the newest GLASS_ACTIVITY of its own table through an index on its time (migration 506 adds the ones that were
// missing), so a read costs the same however long the installation has run:
//  - signup: nightmail_signups, with the sign-in method of the address's first sign-in and the workspace it made;
//  - first_send: the first email of each workspace created in the last 30 days (sending_emails_created_page);
//  - domain_verified, builtin_ready: domain_claims.verified_at; campaign_launched, campaign_paused: sending_campaigns;
//  - standing: a workspace's step changes (standing_events, per workspace through its page index);
//  - breaker: the built-in domains' breaker tripping (builtin_parent); alert: the open health alerts;
//  - link_fallback: a workspace's first use of the link domain on a UTC day (link_fallback_days), with its
//    campaign and marketing recipients there that day so far.
// No message content: a campaign is its name and size, a domain its name. A sign-up's address is there for the page
// to blur with the dashboard's privacy toggle. Cached GLASS_TTL_SECONDS per installation; `after` only filters that.
const ACTIVITY_KINDS = ['signup', 'first_send', 'domain_verified', 'builtin_ready', 'campaign_launched', 'campaign_paused', 'standing', 'breaker', 'alert', 'link_fallback'] as const;
const ActivityEvent = z.object({
  id: z.string().describe('Stable across reads: the page adds an event once.'), at: z.string(), kind: z.enum(ACTIVITY_KINDS),
  workspace: z.object({ id: z.string(), name: z.string() }).nullable(),
  subject: z.string().nullable().describe('What it is about: a domain, a campaign\u2019s name, the built-in parent or an alert\u2019s label.'),
  detail: z.string().nullable().describe('A sign-up\u2019s method (google, github, email, password), a campaign\u2019s recipients, a pause reason\u2019s code, a step change (from>to), an alert\u2019s words or the recipients linked on the link domain that day.'),
  place: z.enum(['open', 'waitlist']).nullable().describe('A sign-up\u2019s place.'),
  email: z.string().nullable().describe('A sign-up\u2019s address.'),
  tone: z.enum(['neutral', 'success', 'warning', 'danger']),
});
const Activity = z.object({ events: z.array(ActivityEvent).describe(`The newest ${GLASS_ACTIVITY} events, newest first (with \`after\`, only the ones at or after it).`), generatedAt: z.string() });
export type GlassActivity = z.infer<typeof Activity>;
type ActivityRow = Omit<z.infer<typeof ActivityEvent>, 'tone' | 'workspace'> & { workspace_id: string | null; workspace_name: string | null; severity: string | null; alert_kind: string | null };

export async function readActivity(runtime: Pick<Runtime, 'db'>): Promise<GlassActivity> {
  const n = GLASS_ACTIVITY, at = (value: SQL) => utc(value);
  const { rows } = await runtime.db.execute<ActivityRow>(sql`SELECT * FROM (
    (SELECT 'signup:'||s.user_id AS id,${at(sql`s.at`)} AS at,'signup' AS kind,w.id AS workspace_id,w.name AS workspace_name,NULL AS subject,
        (SELECT split_part(a.acr,':',4) FROM nightmail_signin_attempts a WHERE a.email=coalesce(s.email,u.email) ORDER BY a.first_at LIMIT 1) AS detail,
        s.via AS place,coalesce(s.email,u.email) AS email,NULL AS severity,NULL AS alert_kind,s.at AS t
      FROM nightmail_signups s LEFT JOIN nightmail_users u ON u.id=s.user_id
      LEFT JOIN LATERAL (SELECT w.id,w.name FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=s.user_id ORDER BY m.created_at LIMIT 1) w ON true
      ORDER BY s.at DESC LIMIT ${n})
    UNION ALL (SELECT 'first_send:'||w.id,${at(sql`e.created_at`)},'first_send',w.id,w.name,NULL,NULL,NULL,NULL,NULL,NULL,e.created_at FROM workspaces w
      CROSS JOIN LATERAL (SELECT e.created_at FROM sending_emails e WHERE e.workspace_id=w.id ORDER BY e.created_at LIMIT 1) e
      WHERE w.created_at>=now()-interval '30 days' ORDER BY e.created_at DESC LIMIT ${n})
    UNION ALL (SELECT CASE WHEN coalesce(d.identity ? 'builtin',false) THEN 'builtin_ready:' ELSE 'domain_verified:' END||d.workspace_id||':'||d.name,${at(sql`d.verified_at`)},
        CASE WHEN coalesce(d.identity ? 'builtin',false) THEN 'builtin_ready' ELSE 'domain_verified' END,w.id,w.name,d.name,NULL,NULL,NULL,NULL,NULL,d.verified_at
      FROM domain_claims d JOIN workspaces w ON w.id=d.workspace_id WHERE d.verified_at IS NOT NULL ORDER BY d.verified_at DESC LIMIT ${n})
    UNION ALL (SELECT 'campaign_launched:'||c.id,${at(sql`c.launched_at`)},'campaign_launched',w.id,w.name,coalesce(c.draft->>'name',c.id),
        nullif(greatest(c.total,coalesce(c.audience_estimate,0)),0)::text,NULL,NULL,NULL,NULL,c.launched_at
      FROM sending_campaigns c JOIN workspaces w ON w.id=c.workspace_id WHERE c.launched_at IS NOT NULL ORDER BY c.launched_at DESC LIMIT ${n})
    UNION ALL (SELECT 'campaign_paused:'||c.id||':'||extract(epoch FROM c.paused_at)::bigint,${at(sql`c.paused_at`)},'campaign_paused',w.id,w.name,coalesce(c.draft->>'name',c.id),
        c.pause_reason->>'code',NULL,NULL,NULL,NULL,c.paused_at
      FROM sending_campaigns c JOIN workspaces w ON w.id=c.workspace_id WHERE c.paused_at IS NOT NULL ORDER BY c.paused_at DESC LIMIT ${n})
    UNION ALL (SELECT 'standing:'||e.id,${at(sql`e.at`)},'standing',w.id,w.name,e.reasons->0->>'code',e.from_step||'>'||e.to_step,NULL,NULL,
        CASE WHEN e.to_step IN ('restrict','pause') THEN 'danger' WHEN e.to_step IN ('notice','warn') THEN 'warning' ELSE 'success' END,NULL,e.at
      FROM workspaces w CROSS JOIN LATERAL (SELECT e.id,e.at,e.from_step,e.to_step,e.reasons FROM standing_events e WHERE e.workspace_id=w.id AND e.kind='step' ORDER BY e.at DESC LIMIT 5) e
      ORDER BY e.at DESC LIMIT ${n})
    UNION ALL (SELECT 'breaker:'||p.name||':'||extract(epoch FROM p.tripped_at)::bigint,${at(sql`p.tripped_at`)},'breaker',NULL,NULL,p.name,NULL,NULL,NULL,NULL,NULL,p.tripped_at
      FROM builtin_parent p WHERE p.tripped_at IS NOT NULL)
    UNION ALL (SELECT 'link_fallback:'||f.workspace_id||':'||f.host||':'||f.day,${at(sql`f.first_at`)},'link_fallback',w.id,w.name,f.host,f.recipients::text,NULL,NULL,NULL,NULL,f.first_at
      FROM link_fallback_days f JOIN workspaces w ON w.id=f.workspace_id ORDER BY f.first_at DESC LIMIT ${n})
    UNION ALL (SELECT 'alert:'||a.key||':'||extract(epoch FROM a.since)::bigint,${at(sql`a.since`)},'alert',NULL,NULL,NULL,a.words,NULL,NULL,a.severity,a.kind,a.since
      FROM health_alerts a ORDER BY a.since DESC LIMIT ${n})
  ) x ORDER BY t DESC,id DESC LIMIT ${n}`);
  const tone = (row: ActivityRow): z.infer<typeof ActivityEvent>['tone'] => row.kind === 'alert' ? (row.severity === 'critical' ? 'danger' : 'warning')
    : row.kind === 'standing' ? (row.severity as 'success' | 'warning' | 'danger') : row.kind === 'breaker' ? 'danger' : row.kind === 'campaign_paused' ? 'warning'
    : row.kind === 'signup' || row.kind === 'link_fallback' ? 'neutral' : 'success';
  const events = rows.flatMap(row => {
    const label = row.kind === 'alert' ? alertLabel(row.alert_kind ?? '') : null;
    if (row.kind === 'alert' && !label) return [];
    return [{ id: row.id, at: row.at, kind: row.kind, workspace: row.workspace_id ? { id: row.workspace_id, name: row.workspace_name ?? row.workspace_id } : null,
      subject: row.kind === 'alert' ? label : row.subject, detail: row.kind === 'alert' ? (row.detail ?? '').replaceAll('`', '') || null : row.detail,
      place: row.place, email: row.email, tone: tone(row) }];
  });
  return { events, generatedAt: new Date().toISOString() };
}

export function registerGlass(app: App) {
  registerGlassDeliverability(app);
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/glass', operationId: 'operatorGetGlass',
    description: `Everything going on in the installation, for operators: sign-ups, sending, delivery, receiving, money, the system and visitors. One statement over rollups and bounded heads, cached ${GLASS_TTL_SECONDS} seconds.`,
    responses: { 200: response(Glass), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const { value, hit } = await cachedDashboardRead(new URL(c.env.config.publicUrl).origin, 'operator-glass', () => readGlass(c.env), GLASS_TTL_SECONDS);
    c.header('cache-control', 'private, no-store');
    c.header('x-nightmail-glass-cache', hit ? 'hit' : 'miss');
    return c.json(value, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/glass/activity', operationId: 'operatorGetGlassActivity',
    description: `What just happened across the installation, for operators: sign-ups, first sends, verified and built-in domains, campaigns launched and paused, standing changes, the built-in breaker and health alerts. The newest ${GLASS_ACTIVITY}, cached ${GLASS_TTL_SECONDS} seconds.`,
    request: { query: z.object({ after: z.string().datetime().optional().describe('Only events at or after this time: the newest `at` the page has.') }) },
    responses: { 200: response(Activity), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const { after } = c.req.valid('query');
    const { value, hit } = await cachedDashboardRead(new URL(c.env.config.publicUrl).origin, 'operator-glass-activity', () => readActivity(c.env), GLASS_TTL_SECONDS);
    c.header('cache-control', 'private, no-store');
    c.header('x-nightmail-glass-cache', hit ? 'hit' : 'miss');
    const since = after ? Date.parse(after) : null;
    return c.json(since === null ? value : { ...value, events: value.events.filter(e => Date.parse(e.at) >= since) }, 200);
  });
}
