import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, databaseCodeOf, errors, log, logError, response, security, transientDatabaseError, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { CAMPAIGNS, DATABASE, DLQ, JOBS, JOBS_LATE, QUEUE, QUEUES, REQUESTS, SQLSTATES, TICK, WAKE_QUEUES } from './health-thresholds.js';
import { countDatabaseError, LATENCY_BUCKETS, WRITE_LIMITS } from './health-counters.js';
import { slackCard } from './operator-alerts.js';
import { postSlack } from './reputation-alerts.js';

// Health: the system says when something falls behind (docs/operations.md is the runbook).
//
// Once a minute (the Worker's minute cron, the Node runner's loop) healthTick measures the installation from cheap
// sources only: the queue metrics the cron already reads, the due and failed heads of the jobs table through its
// indexes, the campaigns that are running, the counters each process flushes (src/health-counters.ts) and
// pg_stat_activity. It never reads sending_emails or sending_email_events. What it finds is written to one row
// (health_state.rollup), which is all GET /v1/operator/health and the Operator area's Health tab read, and compared
// with the thresholds in src/health-thresholds.ts.
//
// Both severities are on Health. Only critical conditions go to Slack, directly from the tick so a stuck jobs
// queue cannot strand its own alert. Cards are plain human lines; stable keys and evidence live in the health API.

export type QueueSample = { name: string; depth: number; oldestMs: number };
export type SlackMessage = Record<string, unknown> & { text: string };
/** How a card leaves: the reputation alerts' Slack sender in production; tests and the lab replay capture instead. */
export type HealthPost = (url: string, card: SlackMessage) => Promise<void>;
const slack: HealthPost = (url, card) => postSlack(url, card, 'HEALTH_ALERT_FAILED', TICK.postMs);

type Severity = 'critical' | 'warning';
/** Which probe an alert's condition is read from: an alert neither opens nor clears on a tick whose probe failed. */
type Section = 'queues' | 'jobs' | 'campaigns' | 'requests' | 'database';
// critical: customers' mail or requests are affected now. warning: it will be, or it needs a look today.
// The kind is the first part of every key and its section in docs/operations.md; unit says what the alert's value counts.
const KINDS = {
  'queue-behind': { emoji: ':hourglass_flowing_sand:', label: 'Queue behind', severity: 'critical', unit: 'seconds', section: 'queues' },
  'dead-letters': { emoji: ':warning:', label: 'Dead letters', severity: 'critical', unit: 'messages', section: 'queues' },
  'jobs-behind': { emoji: ':hourglass_flowing_sand:', label: 'Jobs behind', severity: 'critical', unit: 'seconds', section: 'jobs' },
  'jobs-failed': { emoji: ':x:', label: 'Jobs failed', severity: 'warning', unit: 'jobs', section: 'jobs' },
  'campaign-slow': { emoji: ':snail:', label: 'Campaign slow', severity: 'warning', unit: 'per_second', section: 'campaigns' },
  'campaign-long': { emoji: ':clock3:', label: 'Campaign long', severity: 'warning', unit: 'seconds', section: 'campaigns' },
  'campaign-preparing': { emoji: ':hourglass:', label: 'Campaign preparing', severity: 'warning', unit: 'seconds', section: 'campaigns' },
  'campaign-waiting': { emoji: ':double_vertical_bar:', label: 'Campaign waiting', severity: 'warning', unit: 'seconds', section: 'campaigns' },
  'campaign-paused': { emoji: ':no_entry:', label: 'Campaign paused', severity: 'warning', unit: 'recipients_left', section: 'campaigns' },
  'campaign-bounces': { emoji: ':warning:', label: 'Campaign bounces', severity: 'critical', unit: 'bounce_rate', section: 'campaigns' },
  'request-storm': { emoji: ':ocean:', label: 'Request storm', severity: 'warning', unit: 'per_minute', section: 'requests' },
  'slow-requests': { emoji: ':turtle:', label: 'Slow requests', severity: 'warning', unit: 'milliseconds', section: 'requests' },
  'server-errors': { emoji: ':x:', label: 'Server errors', severity: 'critical', unit: 'responses', section: 'requests' },
  'errors': { emoji: ':x:', label: 'Errors', severity: 'warning', unit: 'lines', section: 'requests' },
  'dispatcher-failing': { emoji: ':rotating_light:', label: 'Dispatcher failing', severity: 'warning', unit: 'failures', section: 'requests' },
  'link-domain-held': { emoji: ':no_entry:', label: 'Marketing link domain held', severity: 'critical', unit: 'domains', section: 'database' },
  'database-errors': { emoji: ':card_file_box:', label: 'Database errors', severity: 'critical', unit: 'errors', section: 'requests' },
  'database-connections': { emoji: ':card_file_box:', label: 'Database connections', severity: 'warning', unit: 'connections', section: 'database' },
  'database-transaction': { emoji: ':card_file_box:', label: 'Long transaction', severity: 'warning', unit: 'seconds', section: 'database' },
  'database-slow-queries': { emoji: ':card_file_box:', label: 'Slow queries', severity: 'warning', unit: 'queries', section: 'database' },
  'database-lock-waits': { emoji: ':card_file_box:', label: 'Lock waits', severity: 'warning', unit: 'sessions', section: 'database' },
  'database-disk': { emoji: ':minidisc:', label: 'Database disk', severity: 'critical', unit: 'share', section: 'database' },
  'database-refusing': { emoji: ':rotating_light:', label: 'Database refusing', severity: 'critical', unit: 'seconds', section: 'database' },
} as const satisfies Record<string, { emoji: string; label: string; severity: Severity; unit: string; section: Section }>;
type Kind = keyof typeof KINDS;
const isKind = (kind: string): kind is Kind => Object.hasOwn(KINDS, kind);
/** An open alert's label, as Health shows it; null for a kind this version does not know (Health leaves those out too). */
export const alertLabel = (kind: string) => isKind(kind) ? KINDS[kind].label : null;
const sectionOf = (key: string): Section => { const kind = key.split(':')[0]!; return isKind(kind) ? KINDS[kind].section : 'requests'; };
/** One condition that holds this tick. value is the one number that matters, in its kind's unit. */
export type Finding = { key: string; kind: Kind; severity: Severity; value: number; words: string; remindMinutes: number };

const count = (n: number) => Math.round(n).toLocaleString('en-US');
/** "45 s", "13 min", "15.5 h". */
export const span = (seconds: number) => seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5_400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 360) / 10} h`;
const took = (ms: number) => ms < 1_000 ? `${Math.round(ms)} ms` : span(ms / 1000);
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const perSecond = (rate: number) => `${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}/s`;
// Identifiers pass only as letters, digits and the punctuation of job types, error codes, IDs and route templates;
// anything else is "other". In a card they are shown as code, so Slack reads no emphasis or emoji into them.
const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:{}*/-]{1,120}$/.test(value) ? value : 'other';
const code = (text: string) => '`' + text + '`';
const id = (value: unknown) => code(safe(value));

type Late = { class: string; type: string; pending: number; oldestSeconds: number };
/** Failed jobs of one type with one error: how many are kept (of the newest JOBS.read), and how many failed in the last hour and half hour. */
type Failed = { type: string; error: string; failed: number; hour: number; half: number };
type CampaignRow = { id: string; workspaceId: string; state: string; total: number; prepared: number; expanded: number; canceled: number; paced: boolean; rateShare: number | null; waitingReason: string | null; waitingSeconds: number | null;
  pauseCode: string | null; pausedSeconds: number | null; quarantines: number; launchedSeconds: number | null; /** What its share of the account's rate is: CAMPAIGNS.share. */ share: keyof typeof CAMPAIGNS.share;
  /** The provider account's send rate. */ account: number | null; /** The rate the release planner reads, shown beside the others and never compared with. */ planned: number | null;
  accepted: number | null; delivered: number | null; bounced: number | null; complained: number | null };
type CounterRow = { kind: string; key: string; n: number; errors: number; ms: number; slowest: number; n5: number; errors5: number; slowest5: number; verySlow5: number; stormMinutes: number; stormRate: number; hist: number[] | null };
type Database = { heldDomains?: string[]; connections: number; maxConnections: number; longTransactions: number; oldestTransactionSeconds: number; slowQueries: number; lockWaits: number; sizeBytes: number };
/** What one tick measured. A probe that failed is null: unknown, which is not the same as fine. */
export type Sample = { queues: QueueSample[]; late: Late[] | null; failed: Failed[] | null; campaigns: CampaignRow[] | null; counters: CounterRow[] | null; database: Database | null };
/**
 * What the next tick compares with: how many ticks each condition has held, and each sending campaign's minute samples
 * (when, released, accepted).
 */
export type Memory = { streaks: Record<string, number>; campaigns: Record<string, [at: number, released: number, accepted: number | null][]>; criticalKeys?: string[]; criticalClears?: Record<string, number> };
export const emptyMemory = (): Memory => ({ streaks: {}, campaigns: {} });

const Queue = z.object({ name: z.string(), depth: z.number().int(), oldestSeconds: z.number().int(), behind: z.boolean(),
  wake: z.boolean().describe('A queue of wake hints for the jobs table: its depth and age are not work waiting and it never alerts. Whether work waits is in jobs[].') });
const Jobs = z.object({ type: z.string(), pending: z.number().int().describe('Due now: jobs scheduled for later are not counted. At most 5,000 are read per class.'), oldestSeconds: z.number().int(), failed: z.number().int().describe('Failed jobs still kept (30 days), of the newest 5,000: information, never an alert.'),
  failedLastHour: z.number().int().describe('Of those, the ones that failed in the last hour: what the jobs-failed alert counts.'), error: z.string().nullable().describe('The most common error among those of the last hour, else among the kept.'), behind: z.boolean() });
const Campaign = z.object({ id: z.string(), workspaceId: z.string(), state: z.string(), total: z.number().int(), released: z.number().int(),
  rate: z.number().nullable().describe('Recipients released per second, measured from the campaign’s own cursor over the last ten minutes; null until two samples exist.'),
  acceptedRate: z.number().nullable().describe('Recipients the provider accepted per second over the same minutes, from the campaign’s stored counts; null while those have not moved.'),
  entitled: z.number().nullable().describe('What it may release per second: the account’s rate, times the share a workspace of its kind gets, times the campaign’s rate share.'),
  account: z.number().nullable().describe('The provider account’s send rate.'), planned: z.number().nullable().describe('The rate the release planner reads. Shown to compare by eye; no rule uses it.'),
  etaSeconds: z.number().int().nullable(), waiting: z.string().nullable().describe('Why releasing waits (waiting_reason), or the pause code of a paused campaign.'),
  settled: z.number().int().nullable(), bounceRate: z.number().nullable().describe('Bounced ÷ (delivered + bounced), from the campaign’s stored counts.'), behind: z.boolean() });
const Route = z.object({ route: z.string().describe('Method and route template.'), count: z.number().int(), errors: z.number().int(), p50Ms: z.number().int(), p95Ms: z.number().int(), slowestMs: z.number().int(), behind: z.boolean() });
const Alert = z.object({ key: z.string().describe('Stable identifier: the kind, then what the condition is about.'), kind: z.string(), label: z.string(), severity: z.enum(['critical', 'warning']),
  value: z.number().describe('The one number that matters, in unit.'), unit: z.string(), words: z.string(), since: z.string(), sentAt: z.string().nullable().describe('When its last Slack card went out. Null: none did.'),
  runbook: z.string().describe('Its section of the runbook, in the repository.') });
const Health = z.object({
  generatedAt: z.string().nullable().describe('When the last tick finished. Null: none has run yet.'), stale: z.boolean().describe('True when no tick finished in the last three minutes: the figures are old and the tick itself needs looking at.'),
  delivery: z.enum(['slack', 'off']).describe('off: no Slack webhook is configured, so alerts are only listed here.'),
  alerts: z.array(Alert).describe('The alerts that are open, oldest first.'),
  queues: z.array(Queue), jobs: z.array(Jobs).nullable(), campaigns: z.array(Campaign).nullable(),
  feedbackLagSeconds: z.number().int().nullable().describe('How far behind bounces, complaints and deliveries are applied: the older of the feedback queues’ oldest message and the oldest due feedback job.'),
  routes: z.array(Route).nullable().describe('The last 15 minutes: every route that is behind, then the slowest by p95.'),
  errors: z.array(z.object({ kind: z.enum(['code', 'sqlstate', 'error']), code: z.string(), count: z.number().int() })).nullable().describe('The last 15 minutes: error codes of 5xx responses (code), database errors by SQLSTATE (sqlstate) and error-level log lines by code (error).'),
  requests: z.object({ count: z.number().int(), errors: z.number().int() }).nullable().describe('The last 15 minutes.'),
  database: z.object({ connections: z.number().int(), maxConnections: z.number().int(), longTransactions: z.number().int(), oldestTransactionSeconds: z.number().int(), slowQueries: z.number().int(), lockWaits: z.number().int(),
    sizeBytes: z.number(), diskBytes: z.number().nullable().describe('DATABASE_DISK_GB, when set.') }).nullable(),
}).openapi('OperatorHealth');
type Health = z.infer<typeof Health>;
type Measured = Omit<Health, 'generatedAt' | 'stale' | 'delivery' | 'alerts'>;
type Rollup = Measured & { memory: Memory };

/** A quantile's upper bound from a latency histogram: the bucket it falls in, or the slowest request for the last one. */
export function quantile(hist: number[], q: number, slowest: number) {
  const total = hist.reduce((sum, n) => sum + n, 0);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) { seen += hist[i]!; if (seen > 0 && seen >= total * q) return Math.min(LATENCY_BUCKETS[i] ?? slowest, Math.max(slowest, 1)); }
  return 0;
}

/**
 * The rules. Pure: one tick's sample and the memory of the ticks before it give what is on the page, the conditions
 * that hold (findings) and the memory for the next tick. `now` is in seconds.
 */
export function evaluate(sample: Sample, memory: Memory, now: number, diskBytes: number | null = null): { rollup: Rollup; findings: Finding[]; blind: Set<Section> } {
  const streaks: Record<string, number> = {}, findings: Finding[] = [], blind = new Set<Section>(), behind = new Set<string>();
  // The condition has held this many ticks in a row, this one included.
  const held = (key: string, condition: boolean, sustain: number) => { if (condition) streaks[key] = (memory.streaks[key] ?? 0) + 1; return condition && streaks[key]! >= sustain; };
  const find = (kind: Kind, subject: string | null, value: number, words: string, remindMinutes: number, severity: Severity = KINDS[kind].severity) => {
    const key = subject === null ? kind : `${kind}:${subject}`;
    findings.push({ key, kind, severity, value: Math.round(value * 1000) / 1000, words, remindMinutes }); behind.add(key);
  };

  // Each tier must hold on its own consecutive ticks; a warning streak alone cannot promote an alert.
  const ageSeverity = (key: string, age: number, rule: { warning?: number; critical?: number }, sustain: number): Severity | undefined => {
    const warning = held(key, rule.warning !== undefined && age >= rule.warning, sustain);
    return held(key + ':critical', rule.critical !== undefined && age >= rule.critical, sustain) ? 'critical' : warning ? 'warning' : undefined;
  };

  const queues = sample.queues.map(q => {
    const name = safe(q.name), dlq = name.endsWith('-dlq'), rule = QUEUES[name], oldestSeconds = Math.round(q.oldestMs / 1000), key = `${dlq ? 'dead-letters' : 'queue-behind'}:${name}`;
    if (dlq) { if (held(key, q.depth >= DLQ.depth, DLQ.sustain)) find('dead-letters', name, q.depth, `${id(name)}: ${count(q.depth)}.`, DLQ.remindMinutes); }
    else if (rule) {
      const severity = ageSeverity(key, q.depth > 0 ? oldestSeconds : 0, rule, QUEUE.sustain);
      if (severity) find('queue-behind', name, oldestSeconds, `${id(name)}: oldest ${span(oldestSeconds)}, ${count(q.depth)} waiting.`, QUEUE.remindMinutes, severity);
    }
    // A queue without a rule is shown and never alerts: the wake hints (WAKE_QUEUES), which the jobs below answer for.
    return { name, depth: q.depth, oldestSeconds, behind: behind.has(key), wake: WAKE_QUEUES.includes(name) };
  });

  let jobs: Rollup['jobs'] = null;
  if (sample.late && sample.failed) {
    const types = new Map<string, { type: string; pending: number; oldestSeconds: number; failed: number; failedLastHour: number; half: number; first: boolean; error: string | null; top: number; behind: boolean }>();
    const of = (type: string) => { const name = safe(type); let row = types.get(name); if (!row) types.set(name, row = { type: name, pending: 0, oldestSeconds: 0, failed: 0, failedLastHour: 0, half: 0, first: false, error: null, top: 0, behind: false }); return row; };
    for (const late of sample.late) {
      const row = of(late.type), rule = JOBS_LATE[late.class] ?? JOBS_LATE.other!;
      row.pending += late.pending; row.oldestSeconds = Math.max(row.oldestSeconds, late.oldestSeconds);
      const severity = ageSeverity(`jobs-behind:${row.type}`, late.oldestSeconds, rule, JOBS.sustain);
      if (severity) {
        find('jobs-behind', row.type, late.oldestSeconds, `${id(row.type)}: ${count(late.pending)}${late.pending >= JOBS.read ? '+' : ''} due, oldest ${span(late.oldestSeconds)}.`, JOBS.remindMinutes, severity);
        row.behind = true;
      }
    }
    for (const failed of sample.failed) {
      const row = of(failed.type);
      row.failed += failed.failed; row.failedLastHour += failed.hour; row.half += failed.half;
      // The error named is the commonest among the last hour's failures; without any, among what is kept.
      const weight = failed.hour ? JOBS.read + failed.hour : failed.failed;
      if (weight > row.top) { row.top = weight; row.error = failed.error ? safe(failed.error) : null; }
      if (failed.hour && (REQUESTS.errorLinesFirst as readonly string[]).includes(failed.error)) row.first = true;
    }
    // What failed in the last hour, never what is still kept from before: an alert is about now.
    for (const row of types.values()) {
      if (!row.failedLastHour || (JOBS.failedIgnored as readonly string[]).includes(row.type)) continue;
      const urgent = row.first || row.type.startsWith('campaign.');
      if (row.failedLastHour >= (urgent ? JOBS.failedCampaign : JOBS.failed) || row.half >= JOBS.failedNew) {
        find('jobs-failed', row.type, row.failedLastHour, `${id(row.type)}: ${count(row.failedLastHour)}${row.failedLastHour >= JOBS.read ? '+' : ''} failed in the last hour, mostly ${id(row.error ?? 'unknown')}.`, JOBS.failedRemindMinutes, urgent ? 'critical' : 'warning');
        row.behind = true;
      }
    }
    jobs = [...types.values()].map(({ top: _, half: __, first: ___, ...row }) => row).sort((a, b) => Number(b.behind) - Number(a.behind) || b.oldestSeconds - a.oldestSeconds || b.failedLastHour - a.failedLastHour || b.failed - a.failed);
  } else blind.add('jobs');

  const feedbackQueue = sample.queues.filter(q => q.name === 'feedback' || q.name === 'feedback-priority').map(q => Math.round(q.oldestMs / 1000));
  const feedbackJobs = sample.late?.filter(late => late.class === 'feedback').map(late => late.oldestSeconds) ?? [];
  const feedbackLagSeconds = feedbackQueue.length || sample.late ? Math.max(0, ...feedbackQueue, ...feedbackJobs) : null;

  let campaigns: Rollup['campaigns'] = null;
  const samples: Memory['campaigns'] = {};
  if (sample.campaigns) {
    const waiting = (c: CampaignRow) => c.state === 'sending' && c.waitingReason !== null && (c.waitingSeconds ?? 0) > 0;
    // A workspace's campaigns share what the workspace is entitled to: how many of them are releasing right now.
    const releasing = new Map<string, number>();
    for (const c of sample.campaigns) if (c.state === 'sending' && !waiting(c) && c.expanded < c.total) releasing.set(c.workspaceId, (releasing.get(c.workspaceId) ?? 0) + 1);
    campaigns = sample.campaigns.map(c => {
      // `expanded` is the cursor over the frozen recipients: everyone released or skipped so far (a delivered-only
      // resume skips recipients, and each skip also counts in `canceled`, so that is never subtracted again).
      const cid = safe(c.id), remaining = Math.max(0, c.total - c.expanded), flagged = findings.length;
      // What it may release: the account's rate, the share a workspace of its kind gets, then the smaller of its own
      // rate share and an even split with the workspace's other releasing campaigns. What it does release: its cursor,
      // a minute apart. The planner's own number is only shown.
      const workspace = c.account === null ? null : c.account * CAMPAIGNS.share[c.share];
      const entitled = workspace === null ? null : Math.min(workspace * (c.rateShare ?? 1), workspace / Math.max(1, releasing.get(c.workspaceId) ?? 1));
      const waits = waiting(c);
      // Measured only over minutes it was free to send: a wait, a pause or preparing starts the samples over.
      const ring = c.state === 'sending' && !waits ? [...(memory.campaigns[c.id] ?? []), [now, c.expanded, c.accepted] as Memory['campaigns'][string][number]].slice(-(CAMPAIGNS.windowMinutes + 1)) : [];
      if (ring.length) samples[c.id] = ring;
      const first = ring[0], seconds = first ? now - first[0] : 0, released = first ? Math.max(0, c.expanded - first[1]) : 0, rate = first && seconds >= 30 ? released / seconds : null;
      const acceptedRate = first && seconds >= 30 && first[2] !== null && c.accepted !== null && c.accepted > first[2] ? (c.accepted - first[2]) / seconds : null;
      const etaSeconds = rate ? Math.round(remaining / rate) : null;
      const planned = c.planned === null ? null : c.planned * (c.rateShare ?? 1);
      const against = c.account === null || entitled === null ? 'the account’s rate is unknown' : `${rate === null ? '' : `${percent(rate / c.account)} of `}the account’s ${perSecond(c.account)} (entitled to ${perSecond(entitled)}${planned !== null && planned < entitled * 0.9 ? `; the planner reads ${perSecond(planned)}` : ''})`;
      const measurable = c.state === 'sending' && !c.paced && rate !== null && remaining > 0;
      if (measurable && ((seconds >= CAMPAIGNS.stalledMinutes * 60 - 30 && released === 0)
        || (entitled !== null && entitled > 0 && seconds >= CAMPAIGNS.windowMinutes * 60 - 30 && remaining > entitled * CAMPAIGNS.tailSeconds && rate < entitled * CAMPAIGNS.slowShare)))
        find('campaign-slow', cid, rate, `${id(cid)}: ${released === 0 ? 'nothing released' : perSecond(rate)} for ${span(seconds)}, ${against}. ${count(remaining)} left.`, CAMPAIGNS.remindMinutes, released === 0 && seconds >= CAMPAIGNS.criticalStalledMinutes * 60 - 30 ? 'critical' : 'warning');
      // Long only counts when it is also slower than it is entitled to: a long send at its entitled rate is by choice.
      if (measurable && entitled !== null && entitled > 0 && rate < entitled * CAMPAIGNS.longShare && ring.length > CAMPAIGNS.etaSamples && etaSeconds !== null && etaSeconds > CAMPAIGNS.etaHours * 3600)
        find('campaign-long', cid, etaSeconds, `${id(cid)}: ${span(etaSeconds)} left at ${perSecond(rate)}, ${against}. ${count(remaining)} of ${count(c.total)} left.`, CAMPAIGNS.etaHours * 60);
      if (c.state === 'preparing' && (c.launchedSeconds ?? 0) >= CAMPAIGNS.preparingSeconds)
        find('campaign-preparing', cid, c.launchedSeconds!, `${id(cid)}: ${span(c.launchedSeconds!)}, ${count(c.prepared)} of ${count(c.total)} ready.`, CAMPAIGNS.remindMinutes);
      // How long it has waited is not stored; the streak counts the ticks, one a minute.
      const wait = `campaign-waiting:${cid}`;
      if (held(wait, waits && !(CAMPAIGNS.waitingIgnored as readonly string[]).includes(c.waitingReason!), Math.ceil((c.waitingReason === 'list_probe' ? CAMPAIGNS.probeSeconds : CAMPAIGNS.waitingSeconds) / 60)))
        find('campaign-waiting', cid, streaks[wait]! * 60, `${id(cid)}: ${id(c.waitingReason)} for ${span(streaks[wait]! * 60)}, ${span(c.waitingSeconds!)} to go. ${count(remaining)} left.`, CAMPAIGNS.remindMinutes);
      // Paused by Nightmail (a quarantine, an auto-pause, a failure), not by its owner. Open until it is resumed or
      // canceled, or a day has passed: after that it is the owner's to decide and no longer news.
      if (c.state === 'paused' && c.pauseCode !== null && c.pauseCode !== 'PAUSED_BY_USER' && (c.pausedSeconds ?? 0) < 86_400)
        find('campaign-paused', cid, remaining, `${id(cid)} of ${id(c.workspaceId)}: ${id(c.pauseCode)}${c.quarantines ? ', quarantined' : ''}. ${count(remaining)} left.`, 1_440);
      const settled = c.delivered === null || c.bounced === null ? null : c.delivered + c.bounced, bounceRate = settled ? c.bounced! / settled : null;
      if (c.state !== 'paused' && settled !== null && bounceRate !== null && settled >= CAMPAIGNS.settled && (bounceRate >= CAMPAIGNS.bounceRate || (c.complained ?? 0) / settled >= CAMPAIGNS.complaintRate))
        find('campaign-bounces', cid, bounceRate, `${id(cid)}: ${percent(bounceRate)} bounced and ${count(c.complained ?? 0)} complaints on ${count(settled)} settled.`, CAMPAIGNS.remindMinutes);
      return { id: cid, workspaceId: safe(c.workspaceId), state: c.state, total: c.total, released: c.expanded, rate, acceptedRate, entitled, account: c.account, planned,
        etaSeconds: c.state === 'sending' ? etaSeconds : null, waiting: c.state === 'paused' ? c.pauseCode : waits ? c.waitingReason : null, settled, bounceRate, behind: findings.length > flagged };
    }).sort((a, b) => Number(b.behind) - Number(a.behind));
  } else { blind.add('campaigns'); Object.assign(samples, memory.campaigns); }

  let routes: Rollup['routes'] = null, errorCodes: Rollup['errors'] = null, requests: Rollup['requests'] = null;
  if (sample.counters) {
    const of = (kind: string) => sample.counters!.filter(row => row.kind === kind);
    const all = of('route').map(row => {
      const hist = row.hist ?? [], [method = '', template = ''] = row.key.split(' '), subject = `${safe(method)}:${safe(template)}`, shown = `${safe(method)} ${safe(template)}`, p95Ms = quantile(hist, 0.95, row.slowest), flagged = findings.length;
      if (row.verySlow5 > 0 || (row.n >= REQUESTS.p95Requests && p95Ms >= REQUESTS.p95Ms))
        find('slow-requests', subject, row.slowest, `${code(shown)}: slowest ${took(row.slowest)}, p95 ${took(p95Ms)} over ${count(row.n)} in 15 min.`, REQUESTS.slowRemindMinutes);
      if ((method === 'GET' || method === 'HEAD') && row.stormMinutes >= REQUESTS.stormMinutes)
        find('request-storm', subject, row.stormRate, `${code(shown)}: ${count(row.stormRate)} a minute for ${REQUESTS.stormMinutes} minutes.`, REQUESTS.stormRemindMinutes);
      return { route: shown, count: row.n, errors: row.errors, p50Ms: quantile(hist, 0.5, row.slowest), p95Ms, slowestMs: row.slowest, behind: findings.length > flagged };
    });
    for (const row of of('read')) if (row.stormMinutes >= REQUESTS.stormMinutes)
      find('request-storm', `workspace:${safe(row.key)}`, row.stormRate, `workspace ${id(row.key)}: ${count(row.stormRate)} reads a minute for ${REQUESTS.stormMinutes} minutes.`, REQUESTS.stormRemindMinutes);
    const total5 = of('route').reduce((sum, row) => sum + row.n5, 0), errors5 = of('route').reduce((sum, row) => sum + row.errors5, 0), codes = of('code').sort((a, b) => b.n5 - a.n5);
    if (errors5 >= REQUESTS.errorsAlways || (errors5 >= REQUESTS.errors && errors5 >= total5 * REQUESTS.errorShare))
      find('server-errors', null, errors5, `${count(errors5)} of ${count(total5)} requests in 5 min (${percent(errors5 / Math.max(1, total5))})${codes[0]?.n5 ? `, mostly ${id(codes[0].key)}` : ''}.`, REQUESTS.errorRemindMinutes);
    for (const row of of('sqlstate')) {
      const rule = SQLSTATES[row.key];
      if (rule && row.n5 >= rule.count) find('database-errors', row.key, row.n5, `${rule.label} (${id(row.key)}): ${count(row.n5)} in 5 min.`, DATABASE.remindMinutes, ['25006', '53100', '53300'].includes(row.key) ? 'critical' : 'warning');
    }
    // Error-level log lines by code. A dispatcher's failed runs are counted over the whole fifteen minutes: each one
    // heals itself, so only a run of them is news.
    const lines = of('error').filter(row => !REQUESTS.errorLinesIgnored.test(row.key)), dispatcher = lines.filter(row => row.key.startsWith('DISPATCHER_')).sort((a, b) => b.n - a.n);
    const failures = dispatcher.reduce((sum, row) => sum + row.n, 0);
    if (failures >= REQUESTS.dispatcherFailures) find('dispatcher-failing', null, failures, `${count(failures)} failed runs in 15 min, mostly ${id(dispatcher[0]!.key)}.`, REQUESTS.errorRemindMinutes);
    for (const row of lines) {
      const first = (REQUESTS.errorLinesFirst as readonly string[]).includes(row.key);
      if (!row.key.startsWith('DISPATCHER_') && row.n5 >= (first ? 1 : REQUESTS.errorLines)) find('errors', safe(row.key), row.n5, `${id(row.key)}: ${count(row.n5)} in 5 min.`, REQUESTS.errorRemindMinutes, first ? 'critical' : 'warning');
    }
    routes = [...all.filter(route => route.behind), ...all.filter(route => !route.behind && route.count >= 5).sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 8)];
    errorCodes = (['code', 'sqlstate', 'error'] as const).flatMap(kind => of(kind).map(row => ({ kind, code: safe(row.key), count: row.n }))).sort((a, b) => b.count - a.count).slice(0, 12);
    requests = { count: of('route').reduce((sum, row) => sum + row.n, 0), errors: of('route').reduce((sum, row) => sum + row.errors, 0) };
  } else blind.add('requests');

  let database: Rollup['database'] = null;
  if (sample.database) {
    const { heldDomains, ...d } = sample.database;
    for (const domain of heldDomains ?? []) find('link-domain-held', domain, 1, `Marketing releases using ${id(domain)} are paused after a confirmed DBL listing.`, DATABASE.remindMinutes);
    if (held('database-connections', d.maxConnections > 0 && d.connections >= d.maxConnections * DATABASE.connectionShare, DATABASE.sustain))
      find('database-connections', null, d.connections, `${count(d.connections)} of ${count(d.maxConnections)}.`, DATABASE.remindMinutes);
    if (d.oldestTransactionSeconds >= DATABASE.transactionSeconds)
      find('database-transaction', null, d.oldestTransactionSeconds, `open ${span(d.oldestTransactionSeconds)}${d.longTransactions > 1 ? `, ${count(d.longTransactions)} over a minute` : ''}.`, DATABASE.remindMinutes * 2);
    if (held('database-slow-queries', d.slowQueries >= DATABASE.slowQueries, DATABASE.sustain)) find('database-slow-queries', null, d.slowQueries, `${count(d.slowQueries)} running over 30 s.`, DATABASE.remindMinutes);
    if (held('database-lock-waits', d.lockWaits >= DATABASE.lockWaits, DATABASE.sustain)) find('database-lock-waits', null, d.lockWaits, `${count(d.lockWaits)} sessions waiting on a lock.`, DATABASE.remindMinutes);
    if (diskBytes && d.sizeBytes >= diskBytes * DATABASE.diskShare) find('database-disk', null, d.sizeBytes / diskBytes, `${percent(d.sizeBytes / diskBytes)} of ${Math.round(diskBytes / 1024 ** 3)} GB.`, DATABASE.diskRemindMinutes, d.sizeBytes >= diskBytes * DATABASE.criticalDiskShare ? 'critical' : 'warning');
    database = { ...d, diskBytes };
  } else blind.add('database');

  // A streak whose probe failed this tick is kept as it was, so one failed probe does not start every count over.
  for (const [key, n] of Object.entries(memory.streaks)) if (!(key in streaks) && blind.has(sectionOf(key))) streaks[key] = n;
  // Critical before warning, each in the order it was measured: what a tick posts first, and what a reader sees first.
  findings.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  return { rollup: { queues, jobs, campaigns, feedbackLagSeconds, routes, errors: errorCodes, requests, database, memory: { streaks, campaigns: samples } }, findings, blind };
}

/** Everything the tick asks the database runs in a short transaction of its own under WRITE_LIMITS: a second for a lock, three to run. */
const bounded = <T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>): Promise<T> => db.transaction(async tx => { await tx.execute(WRITE_LIMITS); return work(tx); });
/** One probe: bounded, and one that fails leaves the others alone. */
async function probe<T>(db: Runtime['db'], name: string, read: (tx: DbExecutor) => Promise<T>): Promise<T | null> {
  try { return await bounded(db, read); }
  catch (error) {
    countDatabaseError(databaseCodeOf(error));
    logError(error, { code: 'HEALTH_PROBE_FAILED', probe: name }, 'warn');
    return null;
  }
}
const due = sql`CASE WHEN j.status='running' THEN j.lease_until ELSE j.available_at END`;
/** The reads of a tick, PROBES of them. Each is bounded by an index and a LIMIT (jobs, campaigns) or by a small table. */
const PROBES = 5;
async function measure(runtime: Pick<Runtime, 'db' | 'config'>, queues: QueueSample[]): Promise<Sample> {
  const { db, config } = runtime;
  // The due head of each job class through jobs_ready_page, at most JOBS.read rows a class.
  const late = await probe(db, 'jobs_late', async tx => (await tx.execute<Late>(sql`SELECT k.class,d.type,count(*)::int AS pending,greatest(0,extract(epoch FROM now()-min(d.due)))::int AS "oldestSeconds"
    FROM unnest(${sql.param(Object.keys(JOBS_LATE))}::text[]) k(class) CROSS JOIN LATERAL (SELECT j.type,${due} AS due FROM jobs j
      WHERE public.job_class(j.type)=k.class AND j.status IN ('pending','running') AND ${due}<=now() ORDER BY ${due},j.id LIMIT ${JOBS.read}) d GROUP BY k.class,d.type`)).rows);
  // The newest failed jobs through jobs_due_idx (status, available_at), and how many of them failed in the last hour
  // and half hour: a failed job's available_at is when it failed (src/jobs.ts sets it, in both places a job fails).
  const failed = await probe(db, 'jobs_failed', async tx => (await tx.execute<Failed>(sql`SELECT type,coalesce(last_error,'') AS error,count(*)::int AS failed,
      count(*) FILTER (WHERE available_at>now()-make_interval(mins=>${JOBS.failedHourMinutes}))::int AS hour,count(*) FILTER (WHERE available_at>now()-make_interval(mins=>${JOBS.failedWindowMinutes}))::int AS half
    FROM (SELECT type,last_error,available_at FROM jobs WHERE status='failed' ORDER BY available_at DESC LIMIT ${JOBS.read}) f GROUP BY 1,2`)).rows);
  // Campaigns that are preparing or sending, and those paused in the last day, through sending_campaigns_running. The
  // account's rate comes from the account (provider_account_limits; a self-hosted installation's own limits), and the
  // workspace's kind from its connection: never from the view the release planner reads, which is selected only to be
  // shown beside them. Outcomes are the campaign's stored counts (sending_campaigns.stats), never a count of its emails.
  const rates = config.multiTenant ? sql`LEFT JOIN regional_simulated_connections n ON n.workspace_id=c.workspace_id AND n.region=r.draft->>'region'
      LEFT JOIN provider_account_limits a ON a.aws_account_id=n.aws_account_id AND a.region=n.region LEFT JOIN regional_workspace_limits l ON l.workspace_id=c.workspace_id AND l.region=r.draft->>'region'`
    : sql`LEFT JOIN sending_region_limits a ON a.workspace_id=c.workspace_id AND a.region=r.draft->>'region' LEFT JOIN sending_region_limits l ON l.workspace_id=a.workspace_id AND l.region=a.region`;
  const share = config.multiTenant ? sql`CASE WHEN n.kind IS DISTINCT FROM 'shared' THEN 'own' WHEN (SELECT w.exempt_hosted_quotas FROM workspaces w WHERE w.id=c.workspace_id) THEN 'exempt' ELSE 'shared' END` : sql`'own'`;
  const outcome = (name: string) => sql`(SELECT sum((g->>${name})::bigint)::float8 FROM jsonb_array_elements(c.stats->'groups') g)`;
  const campaigns = await probe(db, 'campaigns', async tx => (await tx.execute<CampaignRow>(sql`SELECT c.id,c.workspace_id AS "workspaceId",c.state,c.total,c.prepared,c.expanded,c.canceled,c.pace_per_day IS NOT NULL AS paced,c.rate_share::float8 AS "rateShare",
      c.waiting_reason AS "waitingReason",extract(epoch FROM c.waiting_until-now())::int AS "waitingSeconds",c.pause_reason->>'code' AS "pauseCode",extract(epoch FROM now()-c.paused_at)::int AS "pausedSeconds",c.quarantines,
      extract(epoch FROM now()-r.created_at)::int AS "launchedSeconds",${share} AS share,a.max_send_rate::float8 AS account,l.max_send_rate::float8 AS planned,
      ${outcome('accepted')} AS accepted,${outcome('delivered')} AS delivered,${outcome('bounced')} AS bounced,${outcome('complained')} AS complained
    FROM sending_campaigns c LEFT JOIN sending_campaign_reviews r ON r.id=c.review_id ${rates}
    WHERE c.state IN ('preparing','sending') OR (c.state='paused' AND c.updated_at>now()-interval '25 hours') ORDER BY c.state DESC,c.updated_at DESC LIMIT 200`)).rows);
  // health_minutes: fifteen minutes of a table that holds two hours.
  const minute = sql`date_trunc('minute',now())`;
  const counters = await probe(db, 'requests', async tx => (await tx.execute<CounterRow>(sql`WITH m AS (SELECT *,minute>=${minute}-interval '5 minutes' AS recent,minute>=${minute}-interval '4 minutes' AND minute<${minute} AS whole
        FROM health_minutes WHERE minute>=${minute}-interval '15 minutes'),
      h AS (SELECT kind,key,array_agg(s ORDER BY i) AS hist FROM (SELECT kind,key,i,sum(v)::int AS s FROM m,unnest(m.hist) WITH ORDINALITY u(v,i) GROUP BY kind,key,i) x GROUP BY kind,key)
    SELECT m.kind,m.key,sum(m.n)::int AS n,sum(m.errors)::int AS errors,sum(m.ms)::float8 AS ms,max(m.slowest) AS slowest,coalesce(sum(m.n) FILTER (WHERE recent),0)::int AS n5,
      coalesce(sum(m.errors) FILTER (WHERE recent),0)::int AS errors5,coalesce(max(m.slowest) FILTER (WHERE recent),0) AS slowest5,coalesce(sum(m.hist[${LATENCY_BUCKETS.length + 1}]) FILTER (WHERE recent),0)::int AS "verySlow5",
      count(*) FILTER (WHERE whole AND m.n>=${REQUESTS.stormPerMinute})::int AS "stormMinutes",coalesce(round(avg(m.n) FILTER (WHERE whole AND m.n>=${REQUESTS.stormPerMinute})),0)::int AS "stormRate",
      (SELECT hist FROM h WHERE h.kind=m.kind AND h.key=m.key) AS hist
    FROM m GROUP BY m.kind,m.key`)).rows);
  const activity = sql`pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`;
  const database = await probe(db, 'database', async tx => (await tx.execute<Database>(sql`SELECT ARRAY(SELECT subject FROM deliverability_checks WHERE held_at IS NOT NULL) AS "heldDomains",(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())::int AS connections,
      current_setting('max_connections')::int AS "maxConnections",(SELECT count(*) FROM ${activity} AND xact_start<now()-interval '1 minute')::int AS "longTransactions",
      coalesce((SELECT extract(epoch FROM now()-min(xact_start)) FROM ${activity}),0)::int AS "oldestTransactionSeconds",
      (SELECT count(*) FROM ${activity} AND state='active' AND query_start<now()-interval '30 seconds')::int AS "slowQueries",
      (SELECT count(*) FROM ${activity} AND wait_event_type='Lock')::int AS "lockWaits",pg_database_size(current_database())::float8 AS "sizeBytes"`)).rows[0] ?? null);
  return { queues, late, failed, campaigns, counters, database };
}

const runbookOf = (kind: Kind) => `docs/operations.md#${kind}`;
const queueLabel = (key: string) => key === 'queue-behind:feedback-priority' ? 'Bounce and complaint reports' : 'Delivery reports';
function openLine(f: Finding) {
  const subject = f.key.slice(f.kind.length + 1);
  switch (f.kind) {
    case 'queue-behind': return `${queueLabel(f.key)} are ${span(f.value)} behind`;
    case 'dead-letters': return `${subject} has ${count(f.value)} ${f.value === 1 ? 'message' : 'messages'} to recover`;
    case 'jobs-behind': return `${subject} jobs are ${span(f.value)} behind`;
    case 'jobs-failed': return `${count(f.value)} ${subject} ${f.value === 1 ? 'job failed' : 'jobs failed'} in the last hour`;
    case 'campaign-slow': return `Campaign ${subject} has stopped releasing mail`;
    case 'campaign-bounces': return `Campaign ${f.words.replaceAll('`', '')}`;
    case 'server-errors': return `${count(f.value)} requests failed in five minutes`;
    case 'errors': return subject === 'MAILBOX_STAGING_UNDELIVERED' ? 'An inbound mail arrival notice could not be delivered'
      : subject === 'SES_ACCOUNT_SENDING_PAUSED' ? 'SES paused sending on a platform account'
      : subject === 'SES_CREDENTIALS_INVALID' ? 'SES rejected platform AWS credentials'
      : subject === 'LINK_HOST_AUTH_FAILED' ? 'Cloudflare rejected NIGHTMAIL_LINK_SAAS_TOKEN (401/403)'
      : subject === 'SUPPORT_LOGS_AUTH_FAILED' ? 'Cloudflare rejected CF_OBSERVABILITY_TOKEN (401/403)'
      : `Critical error ${subject}: ${count(f.value)} in 5 min`;
    case 'database-errors': return `Database: ${SQLSTATES[subject]?.label ?? subject} (${subject})`;
    case 'database-disk': return `Database disk is ${percent(f.value)} full`;
    default: return `${KINDS[f.kind].label}: ${f.words.replaceAll('`', '')}`;
  }
}
function clearLine(key: string, kind: Kind) {
  if (kind === 'queue-behind') return `${queueLabel(key)} have caught up`;
  if (kind === 'database-refusing') return 'Database writes are working again';
  const subject = key.slice(kind.length + 1);
  return `Resolved: ${KINDS[kind].label.toLowerCase()}${subject ? ` (${subject})` : ''}`;
}
// The database cannot remember its own outage. Keep its most recent recovery in this process as well.
const refusing = { since: 0, sent: 0, ended: 0, lastClear: 0, clearTries: 0 };
const longMs = TICK.longMinutes * 60_000, flapMs = TICK.flapMinutes * 60_000;
const mayPage = (since: number, lastClear: number, now: number) => !lastClear || since - lastClear >= flapMs || now - since >= longMs;

export type HealthCard = { key: string; state: 'open' | 'reminder' | 'cleared'; card: SlackMessage; /** A summary card stands for these alerts too. */ covers?: string[] };
export type TickResult = { ran: boolean; ms: number; statements: number; open: number; cards: HealthCard[] };
/**
 * One tick: elect, measure, write the rollup, reconcile the alerts, post their cards. Never throws, and nothing awaits
 * it (worker.ts runs it in waitUntil after dispatch recovery; the runner in the background). Elected in the database
 * (one tick per TICK.everySeconds, whoever asks), and that first UPDATE is also the probe that tells a database
 * refusing writes: then one card says so, straight from here, and everything else waits for it to come back. Every
 * statement runs under WRITE_LIMITS; one that cannot get its lock or runs out drops this tick's sample.
 */
export async function healthTick(runtime: Pick<Runtime, 'db' | 'config'>, input: { queues?: QueueSample[] } = {}, options: { post?: HealthPost; force?: boolean } = {}): Promise<TickResult> {
  const started = Date.now(), { db, config } = runtime, url = config.operatorSlackWebhookUrl, post = options.post ?? slack, cards: HealthCard[] = [];
  const health = `${config.publicUrl.replace(/\/$/, '')}/operator?view=health`;
  const cardOf = (line: string) => slackCard(null, line, health);
  let statements = 0;
  // BEGIN, the limits and COMMIT around what each transaction runs.
  const run = <T>(inside: number, work: (tx: DbExecutor) => Promise<T>) => { statements += 3 + inside; return bounded(db, work); };
  const result = (ran: boolean, open = 0): TickResult => ({ ran, ms: Date.now() - started, statements, open, cards });
  const send = async (card: HealthCard) => {
    if (!url) return false;
    try { await post(url, card.card); cards.push(card); return true; }
    catch { log('warn', { code: 'HEALTH_ALERT_FAILED', alert: card.key.split(':')[0] }); return false; }
  };
  let memory: Memory;
  try {
    const claimed = await run(1, tx => tx.execute<{ rollup: Rollup | null }>(sql`UPDATE health_state SET tick_at=now() WHERE singleton AND (${options.force === true} OR tick_at<now()-make_interval(secs=>${TICK.everySeconds})) RETURNING rollup`));
    if (!claimed.rows.length) return result(false);
    memory = { ...emptyMemory(), ...claimed.rows[0]!.rollup?.memory };
  } catch (error) {
    const sqlstate = databaseCodeOf(error);
    // The health row being locked or slow is this tick's loss, not the database refusing: skip it.
    if (!transientDatabaseError(error) || sqlstate === '55P03' || sqlstate === '57014') { logError(error, { code: 'HEALTH_TICK_SKIPPED' }, 'warn'); return result(false); }
    const now = Date.now(), since = refusing.since ||= now, seconds = Math.round((now - since) / 1000);
    refusing.ended = 0; refusing.clearTries = 0;
    log('error', { code: 'HEALTH_DATABASE_REFUSING', databaseCode: sqlstate, forSeconds: seconds });
    if (mayPage(since, refusing.lastClear, now) && now - refusing.sent >= DATABASE.remindMinutes * 60_000 &&
      await send({ key: 'database-refusing', state: refusing.sent ? 'reminder' : 'open',
        card: cardOf(`Database writes are failing: ${(sqlstate && SQLSTATES[sqlstate]?.label) || 'unreachable'}${sqlstate ? ` (${sqlstate})` : ''}`) })) refusing.sent = now;
    return result(true, 1);
  }
  try {
    if (refusing.since) {
      const ended = refusing.ended ||= Date.now();
      const gone = !refusing.sent || !url || ended - refusing.since < longMs || await send({ key: 'database-refusing', state: 'cleared', card: cardOf(clearLine('database-refusing', 'database-refusing')) });
      if (!gone && ++refusing.clearTries >= TICK.clearRetryMinutes) log('warn', { code: 'HEALTH_ALERT_DROPPED', alert: 'database-refusing' });
      if (gone || refusing.clearTries >= TICK.clearRetryMinutes) Object.assign(refusing, { since: 0, sent: 0, ended: 0, lastClear: ended, clearTries: 0 });
    }
    statements += PROBES * 4; // Each probe: BEGIN, the limits, the read, COMMIT.
    const sample = await measure(runtime, input.queues ?? []);
    const { rollup, findings, blind } = evaluate(sample, memory, Math.floor(Date.now() / 1000), config.databaseDiskBytes ?? null);
    // One line a minute per running campaign: what was released and accepted, how fast against what it may, and what came back.
    for (const c of rollup.campaigns ?? []) {
      const row = sample.campaigns!.find(row => safe(row.id) === c.id)!, rounded = (n: number | null) => n === null ? undefined : Math.round(n * 10) / 10;
      if (c.state !== 'paused') log('info', { code: 'CAMPAIGN_MINUTE', campaignId: c.id, workspaceId: c.workspaceId, state: c.state, total: c.total, prepared: row.prepared, released: c.released, skipped: row.canceled || undefined, rate: rounded(c.rate),
        acceptedRate: rounded(c.acceptedRate), entitledRate: rounded(c.entitled), accountRate: c.account ?? undefined, plannedRate: c.planned ?? undefined, etaSeconds: c.etaSeconds ?? undefined, waiting: c.waiting ?? undefined, accepted: row.accepted ?? undefined,
        delivered: row.delivered ?? undefined, bounced: row.bounced ?? undefined, complained: row.complained ?? undefined, feedbackLagSeconds: rollup.feedbackLagSeconds ?? undefined });
    }
    type Held = { key: string; kind: string; severity: Severity; age: number; unseen: number; sent: number | null };
    const found = new Set(findings.map(f => f.key)), now = Date.now();
    const previousCritical = new Set(memory.criticalKeys);
    const wasCritical = (alert: Held) => alert.severity === 'critical' || previousCritical.has(alert.key);
    const wasPaged = (alert: Held | undefined) => alert?.sent != null && wasCritical(alert);
    const { rows: held, recovered } = await run(findings.length ? 3 : 2, async tx => {
      const rows = (await tx.execute<Held>(sql`SELECT key,kind,severity,extract(epoch FROM now()-since)::float8 AS age,
        extract(epoch FROM now()-seen_at)::float8 AS unseen,extract(epoch FROM now()-sent_at)::float8 AS sent FROM health_alerts`)).rows;
      const recovered = rows.filter(a => !found.has(a.key) && isKind(a.kind) && !blind.has(KINDS[a.kind].section) && a.unseen >= TICK.clearMinutes * 60);
      // Remember the highest severity across a downgrade. Only critical recoveries can mute a future critical open:
      // an escalation above a past warning is actionable immediately. This bounded memory survives Worker turnover.
      const peaks = new Set(rows.filter(wasCritical).map(a => a.key));
      for (const f of findings) if (f.severity === 'critical') peaks.add(f.key);
      rollup.memory.criticalKeys = [...peaks];
      const recent = rollup.memory.criticalClears = Object.fromEntries(Object.entries(memory.criticalClears ?? {}).filter(([, at]) => now - at < flapMs + longMs));
      for (const a of recovered) if (peaks.has(a.key)) recent[a.key] = now - a.unseen * 1000 + TICK.clearMinutes * 60_000;
      // The rollup; and in the same statement, minutes older than two hours folded into their hours (kept 30 days), so a
      // route's count and p95 outlive the logs. Whole hours only, so each hour folds once; most ticks fold nothing.
      await tx.execute(sql`WITH old AS (DELETE FROM health_minutes WHERE minute<date_trunc('hour',now()-make_interval(mins=>${TICK.keepMinutes})) RETURNING *),
          sums AS (SELECT date_trunc('hour',minute) AS hour,kind,key,sum(n) AS n,sum(errors) AS errors,sum(ms) AS ms,max(slowest) AS slowest FROM old WHERE kind<>'read' GROUP BY 1,2,3),
          hists AS (SELECT hour,kind,key,array_agg(s ORDER BY i) AS hist FROM (SELECT date_trunc('hour',minute) AS hour,kind,key,i,sum(v)::bigint AS s FROM old,unnest(old.hist) WITH ORDINALITY u(v,i) WHERE kind<>'read' GROUP BY 1,2,3,4) x GROUP BY 1,2,3),
          folded AS (INSERT INTO health_hours AS h (hour,kind,key,n,errors,ms,slowest,hist) SELECT s.hour,s.kind,s.key,s.n,s.errors,s.ms,s.slowest,x.hist FROM sums s LEFT JOIN hists x USING (hour,kind,key) ORDER BY 1,2,3
            ON CONFLICT (hour,kind,key) DO UPDATE SET n=h.n+excluded.n,errors=h.errors+excluded.errors,ms=h.ms+excluded.ms,slowest=greatest(h.slowest,excluded.slowest),
              hist=CASE WHEN h.hist IS NULL THEN excluded.hist WHEN excluded.hist IS NULL THEN h.hist ELSE ARRAY(SELECT a+b FROM unnest(h.hist,excluded.hist) WITH ORDINALITY u(a,b,i) ORDER BY i) END),
          aged AS (DELETE FROM health_hours WHERE hour<now()-interval '30 days')
        UPDATE health_state SET rollup=${JSON.stringify(rollup)}::jsonb,generated_at=now() WHERE singleton`);
      if (findings.length) await tx.execute(sql`INSERT INTO health_alerts AS a (key,kind,severity,value,unit,words)
        SELECT f.key,f.kind,f.severity,f.value,f.unit,f.words FROM jsonb_to_recordset(${JSON.stringify(findings.map(f => ({ key: f.key, kind: f.kind, severity: f.severity, value: f.value, unit: KINDS[f.kind].unit, words: f.words })))}::jsonb)
          f(key text,kind text,severity text,value float8,unit text,words text) ORDER BY f.key
        ON CONFLICT (key) DO UPDATE SET seen_at=now(),severity=excluded.severity,value=excluded.value,words=excluded.words,
          sent_at=CASE WHEN a.severity='warning' AND NOT (a.key=ANY(${sql.param([...previousCritical])}::text[])) THEN NULL ELSE a.sent_at END`);
      return { rows, recovered };
    });
    const known = new Map(held.map(a => [a.key, a]));
    const critical = findings.filter(f => f.severity === 'critical');
    const canClear = (a: Held) => wasPaged(a) && a.age - a.unseen >= TICK.longMinutes * 60;
    // As before, an overflow card stands for all its keys and only counts as sent if Slack accepted it.
    const fit = <T extends { key: string }>(state: 'open' | 'cleared', alerts: T[], room: number, line: (alert: T) => string): HealthCard[] => {
      if (!room) return [];
      const individual = alerts.length <= room ? alerts : alerts.slice(0, room - 1);
      const cards: HealthCard[] = individual.map(a => ({ key: a.key, state, card: cardOf(line(a)) }));
      const rest = alerts.slice(individual.length);
      if (rest.length) cards.push({ key: 'summary', state, covers: rest.map(a => a.key),
        card: cardOf(`${count(rest.length)} more critical alerts ${state === 'open' ? 'need attention' : 'have cleared'}`) });
      return cards;
    };
    const fresh = fit('open', critical.filter(f => {
      const a = known.get(f.key);
      return !wasPaged(a) && mayPage(now - (a?.age ?? 0) * 1000, rollup.memory.criticalClears![f.key] ?? 0, now);
    }), TICK.cards, openLine);
    const clears = fit('cleared', recovered.filter(canClear), TICK.cards - fresh.length, a => clearLine(a.key, a.kind as Kind));
    const reminders = critical.filter(f => { const a = known.get(f.key); return wasPaged(a) && a!.sent! >= f.remindMinutes * 60; })
      .slice(0, TICK.cards - fresh.length - clears.length).map((f): HealthCard => ({ key: f.key, state: 'reminder', card: cardOf(openLine(f)) }));
    // One after the other, inside the budget. A card that did not go out leaves its row as it was: the next tick tries again.
    const posted = new Set<string>(), deadline = Date.now() + TICK.postBudgetMs;
    for (const card of [...fresh, ...clears, ...reminders]) if (Date.now() < deadline && await send(card)) for (const key of card.covers ?? [card.key]) posted.add(`${card.state === 'cleared' ? 'cleared' : 'open'}:${key}`);
    const sent = findings.filter(finding => posted.has(`open:${finding.key}`)).map(finding => finding.key);
    // A recovery is forgotten once its card went out, or it never had one, or Slack has refused it for TICK.clearRetryMinutes;
    // a row of a kind this version does not know, at once.
    const expired = recovered.filter(alert => canClear(alert) && !!url && !posted.has(`cleared:${alert.key}`) && alert.unseen >= (TICK.clearMinutes + TICK.clearRetryMinutes) * 60);
    for (const alert of expired) log('warn', { code: 'HEALTH_ALERT_DROPPED', alert: alert.key.split(':')[0] });
    const forget = [...recovered.filter(alert => !canClear(alert) || !url || posted.has(`cleared:${alert.key}`)), ...expired, ...held.filter(alert => !isKind(alert.kind))].map(alert => alert.key);
    if (sent.length || forget.length) await run(Number(sent.length > 0) + Number(forget.length > 0), async tx => {
      if (sent.length) await tx.execute(sql`UPDATE health_alerts SET sent_at=now() WHERE key=ANY(${sql.param(sent)}::text[])`);
      if (forget.length) await tx.execute(sql`DELETE FROM health_alerts WHERE key=ANY(${sql.param(forget)}::text[])`);
    });
    const done = result(true, findings.length);
    log('info', { code: 'HEALTH_TICK', ms: done.ms, statements, open: findings.length, cards: cards.length, blind: blind.size ? [...blind] : undefined });
    return done;
  } catch (error) {
    // Its own row locked or slow, or anything else: this tick's sample is dropped, and the next minute starts over.
    countDatabaseError(databaseCodeOf(error));
    logError(error, { code: 'HEALTH_TICK_FAILED' }, 'warn');
    return result(true);
  }
}

/** What the Health tab and an agent read: the rollup the tick wrote and the alerts that are open. Two single-table reads, no measuring. */
export async function readHealth(runtime: Pick<Runtime, 'db' | 'config'>): Promise<Health> {
  const utc = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
  const [state] = (await runtime.db.execute<{ rollup: Rollup | null; generatedAt: string | null; stale: boolean }>(sql`SELECT rollup,${utc(sql`generated_at`)} AS "generatedAt",
    coalesce(generated_at<now()-make_interval(secs=>${TICK.staleSeconds}),true) AS stale FROM health_state WHERE singleton`)).rows;
  const alerts = (await runtime.db.execute<{ key: string; kind: string; severity: Severity; value: number; unit: string; words: string; since: string; sentAt: string | null }>(sql`SELECT key,kind,severity,value,unit,words,${utc(sql`since`)} AS since,${utc(sql`sent_at`)} AS "sentAt"
    FROM health_alerts ORDER BY since,key LIMIT 200`)).rows;
  const empty: Measured = { queues: [], jobs: null, campaigns: null, feedbackLagSeconds: null, routes: null, errors: null, requests: null, database: null };
  const { memory: _, ...measured } = state?.rollup ?? { ...empty, memory: null };
  return { generatedAt: state?.generatedAt ?? null, stale: state?.stale ?? true, delivery: runtime.config.operatorSlackWebhookUrl ? 'slack' : 'off',
    alerts: alerts.filter(alert => isKind(alert.kind)).map(alert => ({ ...alert, label: KINDS[alert.kind as Kind].label, words: alert.words.replaceAll('`', ''), runbook: runbookOf(alert.kind as Kind) })), ...measured };
}

export function registerHealth(app: App) {
  // Who reads it (src/support.ts operatorGate has already authenticated one of them). Hosted: an operator's staff session
  // (operator:read is enough), or an agent key an operator made (Operator, UI notes, Agent keys: src/ui-notes.ts), so a
  // program can pull what the Slack cards push. Self-hosted: anyone signed in to the dashboard, who administers the
  // installation. Never a workspace API key or an MCP sign-in.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/health', operationId: 'operatorGetHealth',
    description: 'The alerts that are open and what the minute health tick last measured: queues, jobs, running campaigns, request latency by route, error codes and the database. IDs and counts only. One read of two small tables.',
    responses: { 200: response(Health), ...errors } }), async (c: Ctx) => {
    const actor = c.get('actor');
    if (!c.env.config.multiTenant) { if (actor?.credential !== 'dashboard') throw new ApiError(403, 'OPERATOR_REQUIRED', 'Use a signed-in dashboard session.'); }
    else if (actor?.credential !== 'uiNotesKey') await (await import('./operator.js')).operatorActor(c, 'operator:read');
    return c.json(await readHealth(c.env), 200);
  });
}
