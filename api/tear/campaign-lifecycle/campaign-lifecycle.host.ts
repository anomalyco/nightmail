import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { campaignLifecycle } from "./campaign-lifecycle.model.ts";
import {
  LIFECYCLE_PRESETS,
  type CampaignStateName,
  type LifecycleAction,
  type LifecycleObs,
  type LifecycleSnapshot,
  type PresetCfg,
} from "./campaign-lifecycle.types.ts";

// Silence noisy app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

// Validate disposable database BEFORE connecting pools, registering process.on handlers, or creating tear_clock.
const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const checkedUrl = await (async () => {
  const checked = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
  const client = new pg.Client({ connectionString: checked });
  await client.connect();
  try {
    await assertDisposable((text) => client.query(text));
  } finally {
    await client.end();
  }
  return checked;
})();

const leaked: string[] = [];
const recordLeak = (kind: string) => (err: unknown) => {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  process.stderr.write(`host ${kind}: ${text}\n`);
  leaked.push(`${kind}:${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
};
process.on("unhandledRejection", recordLeak("unhandled-rejection"));
process.on("uncaughtException", recordLeak("uncaught-exception"));

// ---- Virtual clock shared between JS Date and PostgreSQL via tear_clock ----
const RealDate = Date;
let clockBase = RealDate.now();
let clockReal = RealDate.now();
const vnow = () => clockBase + (RealDate.now() - clockReal);

class VirtualDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]));
    else super(vnow());
  }
  static override now() {
    return vnow();
  }
}
globalThis.Date = VirtualDate as DateConstructor;

// ---- Admin pool (no fault injection) + FaultPool for app/jobs ----
const withClock = `${checkedUrl}?options=${encodeURIComponent("-c search_path=tear_clock,pg_catalog,public -c jit=off")}`;

const adminPool = new pg.Pool({ connectionString: withClock, max: 4 });
adminPool.on("error", () => {});

// Install tear_clock virtual clock schema (same pattern as dispatch.host.ts)
await adminPool.query(`
  CREATE SCHEMA IF NOT EXISTS tear_clock;
  CREATE TABLE IF NOT EXISTS tear_clock.state (
    id int PRIMARY KEY CHECK (id = 1),
    off interval NOT NULL DEFAULT '0 seconds',
    horizon bigint NOT NULL DEFAULT 0
  );
  INSERT INTO tear_clock.state(id, off, horizon) VALUES (1, '0 seconds', 0) ON CONFLICT (id) DO NOTHING;
  CREATE OR REPLACE FUNCTION tear_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT pg_catalog.now() + (SELECT off FROM tear_clock.state WHERE id = 1)
  $$;
  CREATE OR REPLACE FUNCTION tear_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
    SELECT pg_catalog.clock_timestamp() + (SELECT off FROM tear_clock.state WHERE id = 1)
  $$;
  CREATE OR REPLACE FUNCTION tear_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT pg_catalog.statement_timestamp() + (SELECT off FROM tear_clock.state WHERE id = 1)
  $$;
`);

// Detect optional PR #618 / #619 schema features so one host verifies dev, #618, and #619 cleanly.
const schemaFlags = await adminPool.query<{ has_618: boolean; has_619: boolean }>(`
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sending_campaign_reviews' AND column_name='captured_at') AS has_618,
    EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='operation_feedback_lag') AS has_619
`);
const HAS_PR618 = Boolean(schemaFlags.rows[0]?.has_618);
const HAS_PR619 = Boolean(schemaFlags.rows[0]?.has_619);

let dbReadOnly = false;
function isWriteSql(text: string): boolean {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  return /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(s) || /idempotency_claim\s*\(/i.test(s);
}
function roError(text: string): Error | null {
  if (!dbReadOnly || !isWriteSql(text)) return null;
  return Object.assign(new Error("cannot execute write statement in a read-only transaction"), { code: "25006" });
}
const textOf = (arg: unknown): string => (typeof arg === "string" ? arg : (arg as { text?: string })?.text ?? "");

class FaultPool extends pg.Pool {
  override query(...args: any[]): any {
    if (typeof args.at(-1) === "function") return (super.query as any)(...args);
    const err = roError(textOf(args[0]));
    if (err) return Promise.reject(err);
    return (super.query as any)(...args);
  }
  override connect(...args: any[]): any {
    if (typeof args[0] === "function") return (super.connect as any)(...args);
    return (super.connect() as Promise<pg.PoolClient>).then((client) => {
      const c = client as pg.PoolClient & { __faultWrapped?: true };
      if (!c.__faultWrapped) {
        c.__faultWrapped = true;
        const orig = c.query.bind(c);
        (c as any).query = (...q: any[]) => {
          if (typeof q.at(-1) === "function") return (orig as any)(...q);
          const err = roError(textOf(q[0]));
          if (err) return Promise.reject(err);
          return (orig as any)(...q);
        };
      }
      return c;
    });
  }
}

const faultPool = new FaultPool({ connectionString: withClock, max: 16 });
faultPool.on("error", () => {});

const PUBLIC = "http://127.0.0.1:8792";
const baseEnv: Record<string, string> = {
  DATABASE_URL: withClock,
  BANE_ROOT_SECRET: "tear-lifecycle-".repeat(5),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  ACCOUNT_ISSUER: "https://tear-issuer.invalid",
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  ENABLE_LIVE_SES: "true",
  NIGHTMAIL_HOSTED_SCREEN: "false",
  MX_REQUIRE_DMARC_FOR_BULK: "false",
  AWS_ACCESS_KEY_ID: "tear-platform",
  AWS_SECRET_ACCESS_KEY: "tear-secret",
  AWS_EC2_METADATA_DISABLED: "true",
  S3_BUCKET: "tear",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  API_RATE_LIMIT_PER_MINUTE: "100000",
  DEFAULT_SES_REGION: "us-east-1",
  SIMULATED_SES_LATENCY_MS: "0",
  SIMULATED_SES_DELIVERY_DELAY_MS: "0",
};

const [
  { createApp },
  { loadConfig },
  { s3Storage },
  { runDispatcher, initialGate },
  { processJobs },
  { jobHandlers: sendingJobHandlers }, { ingestRoutineSesEvents }, { probeSize },
  { ensureRegionSettings },
  { SESv2Client },
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/config.ts"),
  import("../../src/adapters/storage.ts"),
  import("../../src/dispatcher.ts"),
  import("../../src/jobs.ts"),
  import("../../src/sending/jobs.ts"), import("../../src/sending/events.ts"), import("../../src/sending/schemas.ts"),
  import("../../src/ses-region-state.ts"),
  import("@aws-sdk/client-sesv2"),
]);

function makeRuntime(liveSes: boolean): any {
  const cfg = loadConfig({ ...baseEnv, ENABLE_LIVE_SES: liveSes ? "true" : "false" });
  return { db: drizzle(faultPool), storage: s3Storage(baseEnv), config: cfg };
}

let runtime: any = makeRuntime(true);
let app = createApp();
let gate = initialGate();

async function setVirtualClock(epochMs: number) {
  clockReal = RealDate.now();
  clockBase = epochMs;
  await adminPool.query(`UPDATE tear_clock.state SET off = $1 * interval '1 millisecond'`, [clockBase - clockReal]);
}

const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n);
  return s;
};

interface SentRec {
  emailId: string;
  providerId: string;
  to: string;
  atMs: number;
  feedbackSent: boolean;
}

interface ReleaseSample {
  atMs: number;
  count: number;
}

interface Trial {
  configured: boolean;
  bug?: string;
  cfg: PresetCfg;
  w: string;
  region: string;
  poolAccount: string;
  topicArn: string;
  domain: string;
  originKeyId: string;
  originSecret: string;
  adminKeyId: string;
  adminSecret: string;
  listId: string;
  campaignId: string;
  revision: number;
  contactIds: Map<number, { id: string; email: string }>;
  epoch: number;
  accountMaxRate: number;
  accountMax24h: number;
  accountSent24h: number;
  liveSes: boolean;
  rateShare: number;
  // Tracking for all 8 invariants
  sentByRecipient: Map<string, number>;
  sentList: SentRec[];
  sesAcceptedCount: number;
  lastPrepared: number;
  lastTotal: number;
  lastExpanded: number;
  lastState: CampaignStateName;
  canceledAt: number | null;
  attemptingBeforeCancel: Set<string>;
  pausedAt: number | null;
  queuedAtPause: number;
  expandedAtPause: number;
  sentWhilePaused: number;
  preReleaseBlocked: Map<string, string>;
  firstProbeWaitUntil: number | null;
  probeCleared: boolean;
  releaseSamples: ReleaseSample[];
  // Violation buckets (1..8 + leaked)
  duplicateRecipients: string[];
  accountingViolations: string[];
  sentBeforePrepared: string[];
  sentAfterCancel: string[];
  pauseBoundViolations: string[];
  preReleaseSuppressionViolations: string[];
  controlViolations: string[];
  probeViolations: string[];
  stuckViolations: string[];
  rateViolations: string[];
  statsViolations: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

let activeTrial: Trial | null = null;
let traceSeq = 0;
let lastVirtual = RealDate.now();
let msgSeq = 0;

// ---- Fake SESv2Client ----
(SESv2Client.prototype as any).send = async function (command: any) {
  const name = command.constructor.name;
  const t = activeTrial;
  if (name === "GetAccountCommand") {
    return {
      SendingEnabled: true,
      SendQuota: {
        MaxSendRate: t?.accountMaxRate ?? 40,
        Max24HourSend: t?.accountMax24h ?? 100_000,
        SentLast24Hours: t?.accountSent24h ?? 0,
      },
    };
  }
  if (name !== "SendEmailCommand") {
    throw new Error(`campaign-lifecycle host: unexpected SES command ${name}`);
  }
  if (!t) throw new Error("SES SendEmailCommand outside active trial");
  const tags = (command.input?.EmailTags ?? []) as { Name: string; Value: string }[];
  const emailId = tags.find((x) => x.Name === "bane_email_id")?.Value ?? "";
  const to = String(command.input?.Destination?.ToAddresses?.[0] ?? "").toLowerCase();
  const providerId = `lc-${process.pid}-${++msgSeq}`;

  // Rule 1: duplicate recipient check
  const prevCount = t.sentByRecipient.get(to) ?? 0;
  t.sentByRecipient.set(to, prevCount + 1);
  if (prevCount >= 1) t.duplicateRecipients.push(to);

  // Rule 2: validate-before-send, after-cancel, paused bound
  const { rows: [crow] } = await adminPool.query<{ state: string; prepared: number; total: number }>(
    "SELECT state, prepared, total FROM sending_campaigns WHERE id = $1",
    [t.campaignId],
  );
  if (crow && crow.total > 0 && crow.prepared < crow.total) {
    t.sentBeforePrepared.push(`${to} sent while prepared=${crow.prepared} < total=${crow.total}`);
  }
  if (t.canceledAt !== null && !t.attemptingBeforeCancel.has(emailId)) {
    t.sentAfterCancel.push(`${to} (email=${emailId}) sent after campaign canceled`);
  }
  if (t.pausedAt !== null) {
    t.sentWhilePaused += 1;
    if (t.sentWhilePaused > t.queuedAtPause) {
      t.pauseBoundViolations.push(`sentWhilePaused=${t.sentWhilePaused} exceeded queuedAtPause=${t.queuedAtPause}`);
    }
  }

  // Rule 3: pre-release suppression wins
  const blockedReason = t.preReleaseBlocked.get(to);
  if (blockedReason && !(blockedReason === "unsubscribed" && t.cfg.requiredNotice)) {
    t.preReleaseSuppressionViolations.push(`${to} was ${blockedReason} before release but still sent to SES`);
  }

  t.sesAcceptedCount += 1;
  t.sentList.push({ emailId, providerId, to, atMs: vnow(), feedbackSent: false });
  t.pendingEvents.push({ name: "campaign.ses_call", data: { to, emailId } });
  t.pendingEvents.push({ name: "campaign.ses_committed", data: { to, emailId } });
  if (t.bug === "canary_double_send") {
    t.pendingEvents.push({ name: "campaign.ses_call", data: { to, emailId } });
  }
  return { MessageId: providerId };
};

async function api(t: Trial, method: string, path: string, body?: unknown, useOriginKey = false, headers: Record<string, string> = {}) {
  const secret = useOriginKey ? t.originSecret : t.adminSecret;
  const t0 = performance.now();
  const r = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    runtime,
  );
  const elapsedMs = Math.round(performance.now() - t0);
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-json
  }
  return { status: r.status, body: parsed, elapsedMs };
}

async function readCampaignState(t: Trial): Promise<{
  state: CampaignStateName;
  simulated: boolean;
  archived: boolean;
  revision: number;
  total: number;
  prepared: number;
  expanded: number;
  canceled: number;
  waitingReason: string | null;
  waitingUntil: string | null;
  pauseReasonCode: string | null;
  errorCode: string | null;
  deliveredOnly: boolean;
  probeWaitUntil: string | null;
  probeClearedAt: string | null;
  probeSkippedAt: string | null;
  countsTotal: number;
  countsByStatus: Record<string, number>;
}> {
  const { rows: [c] } = await adminPool.query<any>(
    `SELECT state, simulated, archived_at, revision, total, prepared, expanded, canceled,
            waiting_reason, waiting_until, pause_reason, error, delivered_only,
            probe_wait_until, probe_cleared_at, probe_skipped_at
     FROM sending_campaigns WHERE id = $1`,
    [t.campaignId],
  );
  const { rows: statusRows } = await adminPool.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM sending_emails WHERE workspace_id = $1 AND campaign_id = $2 GROUP BY status",
    [t.w, t.campaignId],
  );
  const countsByStatus: Record<string, number> = {};
  let countsTotal = 0;
  for (const r of statusRows) {
    countsByStatus[r.status] = r.n;
    countsTotal += r.n;
  }
  t.revision = c.revision;
  t.lastState = c.state;
  t.lastTotal = c.total;
  t.lastPrepared = c.prepared;
  t.lastExpanded = c.expanded;
  return {
    state: c.state,
    simulated: Boolean(c.simulated),
    archived: c.archived_at !== null,
    revision: c.revision,
    total: c.total,
    prepared: c.prepared,
    expanded: c.expanded,
    canceled: c.canceled,
    waitingReason: c.waiting_reason ?? null,
    waitingUntil: c.waiting_until ? new Date(c.waiting_until).toISOString() : null,
    pauseReasonCode: c.pause_reason?.code ?? null,
    errorCode: c.error?.code ?? null,
    deliveredOnly: Boolean(c.delivered_only),
    probeWaitUntil: c.probe_wait_until ? new Date(c.probe_wait_until).toISOString() : null,
    probeClearedAt: c.probe_cleared_at ? new Date(c.probe_cleared_at).toISOString() : null,
    probeSkippedAt: c.probe_skipped_at ? new Date(c.probe_skipped_at).toISOString() : null,
    countsTotal,
    countsByStatus,
  };
}

async function verifyAllInvariants(t: Trial) {
  if (!t.configured) return;
  const st = await readCampaignState(t);

  // Rule 2: while paused, expanded must never advance beyond expandedAtPause
  if (st.state === "paused" && t.pausedAt !== null && st.expanded > t.expandedAtPause) {
    t.pauseBoundViolations.push(`released while paused: expanded=${st.expanded} > expandedAtPause=${t.expandedAtPause}`);
  }

  // Rule 5: probe invariants (campaigns/run.ts: hosted, live / non-simulated campaigns only)
  const probeApplies =
    !st.simulated && t.cfg.recipients > 100 && !t.cfg.priorCleanCampaign && st.total > probeSize(st.total) && !st.probeSkippedAt;
  if (probeApplies) {
    const pSize = probeSize(st.total);
    if (!st.probeClearedAt && st.expanded > pSize) {
      t.probeViolations.push(`released past probe cap: expanded=${st.expanded} > probeSize=${pSize} before probe cleared`);
    }
    if (st.probeWaitUntil) {
      const waitMs = Date.parse(st.probeWaitUntil);
      if (t.firstProbeWaitUntil === null) {
        t.firstProbeWaitUntil = waitMs;
      } else if (waitMs > t.firstProbeWaitUntil + 1000) {
        t.probeViolations.push(`probeWaitUntil restarted: first=${t.firstProbeWaitUntil}, now=${waitMs}`);
      }
    }
    if (st.probeClearedAt) {
      if (!t.probeCleared) {
        t.probeCleared = true;
        if (t.firstProbeWaitUntil !== null && vnow() + 1000 < t.firstProbeWaitUntil && st.pauseReasonCode !== "LIST_QUALITY") {
          t.probeViolations.push(`probe cleared early at ${vnow()} before waitUntil=${t.firstProbeWaitUntil}`);
        }
      }
    }
  }

  // Rule 7: regional_workspace_limits view parity (migration 422)
  const { rows: [lim] } = await adminPool.query<{ max_send_rate: number }>(
    "SELECT max_send_rate::float8 AS max_send_rate FROM regional_workspace_limits WHERE workspace_id = $1 AND region = $2",
    [t.w, t.region],
  );
  const expectedRate = t.cfg.exempt ? t.accountMaxRate : t.accountMaxRate / 4;
  if (lim && Math.abs(lim.max_send_rate - expectedRate) > 0.001) {
    t.rateViolations.push(`regional_workspace_limits.max_send_rate=${lim.max_send_rate} != expected ${expectedRate} (exempt=${t.cfg.exempt})`);
  }

  // Rule 7b: rate-share release ceiling over any window (allows RELEASE_BURST_MS = 20s burst cap)
  if (t.rateShare < 1 && t.releaseSamples.length > 1) {
    const shareRate = t.rateShare * expectedRate;
    for (let i = 0; i < t.releaseSamples.length; i++) {
      let sum = 0;
      const t0 = t.releaseSamples[i]!.atMs;
      for (let j = i; j < t.releaseSamples.length; j++) {
        sum += t.releaseSamples[j]!.count;
        const dtMs = Math.max(0, t.releaseSamples[j]!.atMs - t0);
        // Each batch itself is capped at floor(shareRate * 20s) + burst window
        const maxAllowed = Math.ceil(shareRate * ((dtMs + 25_000) / 1000)) + 2;
        if (sum > maxAllowed) {
          t.rateViolations.push(`rateShare=${t.rateShare} exceeded: ${sum} released over ${dtMs}ms (max ${maxAllowed} at ${shareRate}/s)`);
          break;
        }
      }
    }
  }

  // Rule 1 & Rule 8: check real GET /v1/campaigns/{id} and GET /v1/campaigns/{id}/stats when DB is healthy
  if (!dbReadOnly && st.state !== "draft") {
    const [viewRes, statsRes] = await Promise.all([
      api(t, "GET", `/v1/campaigns/${t.campaignId}`, undefined, false),
      api(t, "GET", `/v1/campaigns/${t.campaignId}/stats`, undefined, false),
    ]);
    if (viewRes.status === 200 && statsRes.status === 200) {
      const view = viewRes.body;
      const stats = statsRes.body;
      const deliv = view.delivery;
      const counts = view.counts;
      const totals = stats.totals;

      if (deliv) {
        // Rule 8: stats monotonicity & upper bounds
        if (totals.delivered > totals.accepted) {
          t.statsViolations.push(`stats delivered=${totals.delivered} > accepted=${totals.accepted}`);
        }
        if (totals.accepted > deliv.expanded) {
          t.statsViolations.push(`stats accepted=${totals.accepted} > released(expanded)=${deliv.expanded}`);
        }
        if (deliv.expanded > deliv.total && deliv.total > 0) {
          t.statsViolations.push(`released(expanded)=${deliv.expanded} > total=${deliv.total}`);
        }
        if (totals.bounced > totals.accepted) {
          t.statsViolations.push(`stats bounced=${totals.bounced} > accepted=${totals.accepted}`);
        }
        if (totals.complained > totals.accepted) {
          t.statsViolations.push(`stats complained=${totals.complained} > accepted=${totals.accepted}`);
        }
        if (totals.accepted > t.sesAcceptedCount) {
          t.statsViolations.push(`stats accepted=${totals.accepted} > actual SES accepted=${t.sesAcceptedCount}`);
        }
        if (counts.total > deliv.expanded) {
          t.statsViolations.push(`counts.total=${counts.total} > expanded=${deliv.expanded}`);
        }

        // Rule 1: terminal accounting exactness
        if (st.state === "done" || st.state === "canceled") {
          const sum = counts.total + deliv.canceled;
          if (deliv.total > 0 && sum !== deliv.total) {
            t.accountingViolations.push(
              `terminal ${st.state} accounting mismatch: counts.total(${counts.total}) + delivery.canceled(${deliv.canceled}) = ${sum} != delivery.total(${deliv.total})`,
            );
          }
          // Verify no duplicate review_ordinal and every suppressed email has a suppression_reason
          const { rows: [chk] } = await adminPool.query<{ dup_ord: number; bad_supp: number; active_left: number }>(`
            SELECT
              (SELECT count(*)::int FROM (SELECT review_ordinal FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 GROUP BY review_ordinal HAVING count(*) > 1) d) AS dup_ord,
              (SELECT count(*)::int FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 AND status='suppressed' AND suppression_reason IS NULL) AS bad_supp,
              (SELECT count(*)::int FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 AND status IN ('queued','attempting')) AS active_left
          `, [t.w, t.campaignId]);
          if (chk!.dup_ord > 0) t.accountingViolations.push(`${chk!.dup_ord} duplicate review_ordinal rows`);
          if (chk!.bad_supp > 0) t.accountingViolations.push(`${chk!.bad_supp} suppressed rows missing suppression_reason`);
          if (st.state === "done" && chk!.active_left > 0) {
            t.accountingViolations.push(`done campaign still has ${chk!.active_left} queued/attempting rows`);
          }
        }
      }
    }
  }
}

async function runOneCampaignJob(t: Trial): Promise<{ ran: number }> {
  const beforeExpanded = t.lastExpanded;
  // Pass only campaign.run and sending.cancelPage handlers (deferring stats) or run limit=4 so campaign.run is never starved by campaignStats.
  const res = await processJobs(runtime, sendingJobHandlers, 4, 1, 5_000, "work");
  const after = await readCampaignState(t);
  if (after.expanded > beforeExpanded) {
    t.releaseSamples.push({ atMs: vnow(), count: after.expanded - beforeExpanded });
  }
  return { ran: res.processed };
}

async function runDispatchStep(t: Trial, limit?: number) {
  await runDispatcher(runtime, {
    region: t.region,
    accountId: t.poolAccount,
    lanes: 1,
    batchSize: limit ?? 50,
    gate,
    until: vnow() + 7_500,
    schedulePartialFlush: () => () => {},
  });
}

async function configureTrial(t: Trial, cfg: PresetCfg): Promise<LifecycleObs> {
  dbReadOnly = false;
  await assertDisposable((text) => adminPool.query(text));
  traceSeq++;

  const { rows: [clk] } = await adminPool.query<{ horizon: string }>("SELECT horizon FROM tear_clock.state WHERE id = 1");
  lastVirtual = Math.max(lastVirtual, Number(clk?.horizon ?? 0), RealDate.now());
  t.epoch = Math.ceil((lastVirtual + 3_600_000) / 3_600_000) * 3_600_000;
  await setVirtualClock(t.epoch);

  t.cfg = cfg;
  t.w = `tear_lc_${process.pid}_${traceSeq}`;
  t.region = `tl-${letters(process.pid)}-${letters(traceSeq)}-1`;
  t.poolAccount = "111122223333";
  t.topicArn = `arn:aws:sns:${t.region}:${t.poolAccount}:bane-feedback`;
  t.domain = `lc-${process.pid}-${traceSeq}-${randomBytes(2).toString("hex")}.example`;
  t.originKeyId = `key_orig_${t.w}`;
  t.originSecret = "nm_" + randomBytes(32).toString("hex");
  t.adminKeyId = `key_adm_${t.w}`;
  t.adminSecret = "nm_" + randomBytes(32).toString("hex");
  t.listId = `lst_${t.w}`;
  t.accountMaxRate = cfg.accountMaxRate;
  t.accountMax24h = cfg.accountMax24h;
  t.accountSent24h = 0;
  t.liveSes = true;
  t.rateShare = 1;
  runtime = makeRuntime(true);
  app = createApp();
  gate = initialGate();

  const postal = "123 Lifecycle Way\nTest City, NY 10001";
  await adminPool.query(
    `INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,inbound_bucket)
     VALUES ($1,$2,$3,'ready','tear-fixture')
     ON CONFLICT(region) DO UPDATE SET aws_account_id=excluded.aws_account_id,feedback_topic_arn=excluded.feedback_topic_arn,sending_state='ready'`,
    [t.region, t.poolAccount, t.topicArn],
  );
  await adminPool.query(
    `INSERT INTO workspaces(id,name,slug,postal_address,exempt_hosted_quotas,required_notices)
     VALUES ($1,$1,$1,$2,$3,$4)`,
    [t.w, postal, cfg.exempt, cfg.requiredNotice],
  );
  await adminPool.query(
    `INSERT INTO operation_settings(workspace_id,name,postal_address)
     VALUES ($1,$1,$2) ON CONFLICT(workspace_id) DO UPDATE SET postal_address=excluded.postal_address`,
    [t.w, postal],
  );
  await adminPool.query(
    `INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state)
     VALUES ($1,$1,$2,'ready','shared',$3,'ready')`,
    [t.w, t.region, t.poolAccount],
  );
  await adminPool.query(
    `INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state)
     VALUES ($1,$2,$2,'verified')`,
    [t.domain, t.w],
  );
  await adminPool.query(
    `INSERT INTO provider_account_limits(aws_account_id,region,refresh_after,checked_at,max_send_rate,max_24_hour_send,sent_last_24_hours,customer_sent_24_hours)
     VALUES ($1,$2,now()+interval '10 minutes',now(),$3,$4,0,0)
     ON CONFLICT(aws_account_id,region) DO UPDATE SET
       refresh_after=now()+interval '10 minutes',checked_at=now(),max_send_rate=excluded.max_send_rate,
       max_24_hour_send=excluded.max_24_hour_send,sent_last_24_hours=0,customer_sent_24_hours=0`,
    [t.poolAccount, t.region, cfg.accountMaxRate, cfg.accountMax24h],
  );
  await adminPool.query(
    `INSERT INTO sender_standing(workspace_id,phase,first_recipients,score,target,quality,band_limit,daily_limit,computed_at,evidence_at)
     VALUES ($1,$2,100,90,90,95,1000000,1000000,now(),now())
     ON CONFLICT(workspace_id) DO UPDATE SET phase=excluded.phase,band_limit=1000000,daily_limit=1000000,computed_at=now(),evidence_at=now()`,
    [t.w, cfg.goodStanding ? "graded" : "calibrating"],
  );
  for (const [kid, sec] of [
    [t.originKeyId, t.originSecret],
    [t.adminKeyId, t.adminSecret],
  ] as const) {
    await adminPool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
      [kid, t.w, createHash("sha256").update(sec).digest("hex"), sec.slice(0, 14)],
    );
  }
  await ensureRegionSettings(drizzle(adminPool), { workspaceId: t.w, regions: [t.region] });

  // Seed list + contacts in bulk SQL
  await adminPool.query("INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$2,'Lifecycle List')", [t.listId, t.w]);
  const consentVal = cfg.emptyAudience ? "unsubscribed" : "subscribed";
  await adminPool.query(
    `INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent,properties)
     SELECT $1 || '_c' || g, $1, 'rcpt-' || g || '@' || $4, 'Reader ' || g, $5,
            CASE WHEN $3 AND g = $2 THEN '{}'::jsonb ELSE jsonb_build_object('firstName', 'User' || g) END
     FROM generate_series(1, $2) g`,
    [t.w, cfg.recipients, cfg.badPlaceholder, t.domain, consentVal],
  );
  await adminPool.query(
    `INSERT INTO audience_list_members(workspace_id,list_id,contact_id)
     SELECT $1, $2, $1 || '_c' || g FROM generate_series(1, $3) g`,
    [t.w, t.listId, cfg.recipients],
  );

  // Track first 10 contact ids for targeted unsubscribe/bounce/delete mutations
  t.contactIds.clear();
  for (let i = 1; i <= Math.min(10, cfg.recipients); i++) {
    t.contactIds.set(i, { id: `${t.w}_c${i}`, email: `rcpt-${i}@${t.domain}`.toLowerCase() });
  }

  // Optional prior clean delivered campaign finished 30 minutes ago (triggers clean-list probe skip!)
  if (cfg.priorCleanCampaign) {
    const priorId = `cmp_prior_${t.w}`;
    await adminPool.query(
      `INSERT INTO sending_campaigns(id,workspace_id,draft,state,simulated,total,prepared,expanded,quarantines,delivered_only,created_at,updated_at)
       VALUES ($1,$2,'{"name":"Prior","from":"news@example.com","subject":"Prior","html":"<p>Prior</p>","audience":{},"defaults":{},"replyTo":[],"attachments":[],"tracking":true}'::jsonb,'done',false,$3,$3,$3,0,false,now()-interval '1 hour',now()-interval '30 minutes')`,
      [priorId, t.w, cfg.recipients],
    );
    await adminPool.query(
      `INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,campaign_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,provider_id,event_outcomes,created_at,updated_at)
       SELECT $1 || '_pe' || g, $1, $2, $3, $4, 'news@' || $5, jsonb_build_array('rcpt-' || g || '@' || $5), '[]', '[]', 'Prior', '{}', false, 'delivered', 'prior-' || g, 3, now()-interval '45 minutes', now()-interval '30 minutes'
       FROM generate_series(1, $6) g`,
      [t.w, t.region, t.adminKeyId, priorId, t.domain, cfg.recipients],
    );
  }

  // Create draft campaign through real POST /v1/campaigns
  const html = cfg.badPlaceholder ? "<p>Hello {{firstName}}!</p>" : "<p>Hello from lifecycle test.</p>";
  const created = await api(
    t,
    "POST",
    "/v1/campaigns",
    {
      name: `Lifecycle ${cfg.preset}`,
      from: `news@${t.domain}`,
      region: t.region,
      subject: "Lifecycle v1",
      html,
      audience: { listId: t.listId },
      ...(cfg.requiredNotice ? { requiredNotice: true } : {}),
    },
    true,
  );
  if (created.status !== 201) {
    throw new Error(`createCampaign failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  t.campaignId = created.body.id;
  t.revision = created.body.revision;
  t.configured = true;
  const st = await readCampaignState(t);
  return {
    status: created.status,
    code: null,
    state: st.state,
    archived: st.archived,
    total: st.total,
    prepared: st.prepared,
    expanded: st.expanded,
    canceled: st.canceled,
    waitingReason: st.waitingReason,
    pauseReasonCode: st.pauseReasonCode,
    errorCode: st.errorCode,
    deliveredOnly: st.deliveredOnly,
    elapsedMs: created.elapsedMs,
  };
}

function toObs(
  status: number,
  code: string | null,
  st: Awaited<ReturnType<typeof readCampaignState>>,
  elapsedMs: number,
  extra: Partial<LifecycleObs> = {},
): LifecycleObs {
  return {
    status,
    code,
    state: st.state,
    archived: st.archived,
    total: st.total,
    prepared: st.prepared,
    expanded: st.expanded,
    canceled: st.canceled,
    waitingReason: st.waitingReason,
    pauseReasonCode: st.pauseReasonCode,
    errorCode: st.errorCode,
    deliveredOnly: st.deliveredOnly,
    elapsedMs,
    ...extra,
  };
}

export const campaignLifecycleHost = host(campaignLifecycle, {
  async open(req): Promise<Trial> {
    dbReadOnly = false;
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      cfg: LIFECYCLE_PRESETS.small,
      w: "",
      region: "",
      poolAccount: "",
      topicArn: "",
      domain: "",
      originKeyId: "",
      originSecret: "",
      adminKeyId: "",
      adminSecret: "",
      listId: "",
      campaignId: "",
      revision: 1,
      contactIds: new Map(),
      epoch: RealDate.now(),
      accountMaxRate: 40,
      accountMax24h: 100_000,
      accountSent24h: 0,
      liveSes: true,
      rateShare: 1,
      sentByRecipient: new Map(),
      sentList: [],
      sesAcceptedCount: 0,
      lastPrepared: 0,
      lastTotal: 0,
      lastExpanded: 0,
      lastState: "draft",
      canceledAt: null,
      attemptingBeforeCancel: new Set(),
      pausedAt: null,
      queuedAtPause: 0,
      expandedAtPause: 0,
      sentWhilePaused: 0,
      preReleaseBlocked: new Map(),
      firstProbeWaitUntil: null,
      probeCleared: false,
      releaseSamples: [],
      duplicateRecipients: [],
      accountingViolations: [],
      sentBeforePrepared: [],
      sentAfterCancel: [],
      pauseBoundViolations: [],
      preReleaseSuppressionViolations: [],
      controlViolations: [],
      probeViolations: [],
      stuckViolations: [],
      rateViolations: [],
      statsViolations: [],
      leakedErrors: [],
      pendingEvents: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: LifecycleAction): Promise<LifecycleObs> {
    if (a.op === "Configure") {
      return configureTrial(t, LIFECYCLE_PRESETS[a.preset]);
    }
    if (!t.configured) throw new Error("campaign-lifecycle host: action before Configure");

    const pre = await readCampaignState(t);

    switch (a.op) {
      case "PreviewAudience": {
        const r = await api(t, "GET", `/v1/campaigns/${t.campaignId}/audience`);
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "EditDraft": {
        const cur = await api(t, "GET", `/v1/campaigns/${t.campaignId}`);
        if (cur.status !== 200) {
          const st = await readCampaignState(t);
          return toObs(cur.status, cur.body?.error?.code ?? null, st, cur.elapsedMs);
        }
        const draft = { ...cur.body.draft, subject: `Lifecycle ${a.subject}` };
        const r = await api(t, "PATCH", `/v1/campaigns/${t.campaignId}`, { revision: cur.body.revision, draft }, true);
        const st = await readCampaignState(t);
        // Rule 4: edit guard check
        if (!dbReadOnly && pre.archived && r.status === 200) {
          t.controlViolations.push("EditDraft succeeded while campaign was archived");
        }
        if (!dbReadOnly && ["preparing", "scheduled", "sending", "paused", "done", "canceled"].includes(pre.state) && r.status === 200) {
          t.controlViolations.push(`EditDraft succeeded in locked state ${pre.state}`);
        }
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "SendNow": {
        const body: Record<string, unknown> = { revision: pre.revision };
        if (a.rateShare !== undefined || a.pacePerDay !== undefined) {
          body.pacing = {
            ...(a.rateShare !== undefined ? { rateShare: a.rateShare } : {}),
            ...(a.pacePerDay !== undefined ? { perDay: a.pacePerDay } : {}),
          };
        }
        if (a.confirmNotice) body.confirmRequiredNotice = true;
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/send`, body, true);
        if (r.status === 202 && a.rateShare !== undefined) t.rateShare = a.rateShare;
        if (!dbReadOnly && ["preparing", "scheduled", "sending", "paused", "done", "canceled"].includes(pre.state) && r.status === 202) {
          t.controlViolations.push(`Second SendNow succeeded in state ${pre.state}`);
        }
        // For paced preset with small pace (below API min 100), optionally set pace_per_day = 4 so 12 recipients hit pacing_window
        if (r.status === 202 && t.cfg.preset === "paced" && a.pacePerDay === undefined && a.rateShare === undefined) {
          await adminPool.query("UPDATE sending_campaigns SET pace_per_day = 4 WHERE id = $1", [t.campaignId]);
        }
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Schedule": {
        const scheduledAt = new Date(vnow() + a.delaySec * 1000).toISOString();
        const body: Record<string, unknown> = { revision: pre.revision, scheduledAt };
        if (a.rateShare !== undefined) body.pacing = { rateShare: a.rateShare };
        if (t.cfg.requiredNotice) body.confirmRequiredNotice = true;
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/schedule`, body, true);
        if (r.status === 202 && a.rateShare !== undefined) t.rateShare = a.rateShare;
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Reschedule": {
        const scheduledAt = new Date(vnow() + a.delaySec * 1000).toISOString();
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/reschedule`, { scheduledAt });
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Unschedule": {
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/unschedule`, {});
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Pause": {
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/pause`, {});
        const st = await readCampaignState(t);
        if (r.status === 200) {
          t.pausedAt = vnow();
          t.sentWhilePaused = 0;
          t.expandedAtPause = st.expanded;
          const { rows: [q] } = await adminPool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 AND status IN ('queued','attempting')",
            [t.w, t.campaignId],
          );
          t.queuedAtPause = q!.n;
        }
        // Rule 4: Pause MUST succeed and take immediate effect in preparing, scheduled, and sending (when expanded < total)
        if (!dbReadOnly && ["preparing", "scheduled", "sending"].includes(pre.state) && (pre.total === 0 || pre.expanded < pre.total)) {
          if (r.status !== 200 || st.state !== "paused") {
            t.controlViolations.push(`Pause in ${pre.state} failed: status=${r.status} newState=${st.state} code=${r.body?.error?.code}`);
          }
        }
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Resume": {
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/resume`, {});
        const st = await readCampaignState(t);
        if (r.status === 200) {
          t.pausedAt = null;
        }
        if (!dbReadOnly && pre.state === "paused" && r.status !== 200) {
          const code = r.body?.error?.code;
          // Only QUARANTINE_REVIEW_REQUIRED (2nd quarantine) or REQUIRED_NOTICES_OFF may refuse Resume of a paused campaign
          if (code !== "QUARANTINE_REVIEW_REQUIRED" && code !== "REQUIRED_NOTICES_OFF") {
            t.controlViolations.push(`Resume in paused failed unexpectedly: status=${r.status} code=${code}`);
          }
        }
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Cancel": {
        // Snapshot rows already attempting before cancel (already handed to provider)
        const { rows: att } = await adminPool.query<{ id: string }>(
          "SELECT id FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 AND status='attempting'",
          [t.w, t.campaignId],
        );
        const r = await api(t, "POST", `/v1/campaigns/${t.campaignId}/cancel`, {});
        const st = await readCampaignState(t);
        if (r.status === 200) {
          t.canceledAt = vnow();
          t.pausedAt = null;
          for (const row of att) t.attemptingBeforeCancel.add(row.id);
        }
        if (!dbReadOnly && ["preparing", "scheduled", "sending", "paused", "failed"].includes(pre.state)) {
          if (r.status !== 200 || st.state !== "canceled") {
            t.controlViolations.push(`Cancel in ${pre.state} failed: status=${r.status} newState=${st.state} code=${r.body?.error?.code}`);
          }
        }
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "Archive": {
        const r = await api(t, "PATCH", `/v1/campaigns/${t.campaignId}/archive`, { archived: a.archived });
        const st = await readCampaignState(t);
        if (!dbReadOnly && a.archived && ["preparing", "scheduled", "sending", "paused"].includes(pre.state) && r.status === 200) {
          t.controlViolations.push(`Archive(true) succeeded while campaign was active (${pre.state})`);
        }
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "GetCampaign": {
        const r = await api(t, "GET", `/v1/campaigns/${t.campaignId}`);
        const st = await readCampaignState(t);
        const { rows: [s1] } = await adminPool.query<{ has_s1: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM sending_review_recipients r
             JOIN sending_campaigns c ON c.review_id = r.review_id
             WHERE c.id = $1 AND r.content_hash LIKE 's1:%'
           ) AS has_s1`,
          [t.campaignId],
        );
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs, {
          hasS1Hash: Boolean(s1?.has_s1),
        });
      }

      case "UnsubscribeContact": {
        const c = t.contactIds.get(a.index);
        if (!c) return toObs(404, "NOT_FOUND", pre, 0);
        const alreadySent = t.sentByRecipient.has(c.email);
        const r = await api(t, "PATCH", `/v1/contacts/${c.id}/consent`, { marketingConsent: "unsubscribed" });
        if (r.status === 200 && !alreadySent) {
          t.preReleaseBlocked.set(c.email, "unsubscribed");
        }
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "BounceSuppressContact": {
        const c = t.contactIds.get(a.index);
        if (!c) return toObs(404, "NOT_FOUND", pre, 0);
        const alreadySent = t.sentByRecipient.has(c.email);
        if (!dbReadOnly) {
          await adminPool.query(
            "UPDATE audience_contacts SET suppressed = true, suppression_reason = 'hard_bounce', suppressed_at = now() WHERE workspace_id = $1 AND id = $2",
            [t.w, c.id],
          );
          if (!alreadySent) t.preReleaseBlocked.set(c.email, "bounced");
        }
        const st = await readCampaignState(t);
        return toObs(dbReadOnly ? 503 : 200, dbReadOnly ? "DATABASE_UNAVAILABLE" : null, st, 0);
      }

      case "DeleteContact": {
        const c = t.contactIds.get(a.index);
        if (!c) return toObs(404, "NOT_FOUND", pre, 0);
        const alreadySent = t.sentByRecipient.has(c.email);
        const r = await api(t, "DELETE", `/v1/contacts/${c.id}`);
        if (r.status === 200 && !alreadySent) {
          t.preReleaseBlocked.set(c.email, "deleted");
        }
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "RunJobOnce": {
        try {
          await runOneCampaignJob(t);
          const st = await readCampaignState(t);
          return toObs(200, null, st, 0);
        } catch (err: any) {
          const st = await readCampaignState(t);
          return toObs(dbReadOnly ? 503 : 500, err?.code ?? "JOB_ERROR", st, 0);
        }
      }

      case "Dispatch": {
        try {
          await runDispatchStep(t, a.limit);
          const st = await readCampaignState(t);
          return toObs(200, null, st, 0);
        } catch (err: any) {
          const st = await readCampaignState(t);
          return toObs(dbReadOnly ? 503 : 500, err?.code ?? "DISPATCH_ERROR", st, 0);
        }
      }

      case "DeliverFeedback": {
        const targets = t.sentList.filter((x) => !x.feedbackSent).slice(0, a.count);
        if (targets.length > 0 && !dbReadOnly) {
          const inputs = targets.map((rec, idx) => {
            rec.feedbackSent = true;
            const msgId = `sns-${t.w}-${a.kind}-${vnow()}-${idx}-${randomUUID().slice(0, 8)}`;
            const basePayload = {
              message: {
                mail: { messageId: rec.providerId, sendingAccountId: t.poolAccount, destination: [rec.to] },
                eventType: a.kind === "delivery" ? "Delivery" : a.kind === "bounce" ? "Bounce" : "Complaint",
              },
            };
            return {
              workspaceId: t.w,
              providerId: rec.providerId,
              taggedEmailId: rec.emailId,
              type: a.kind,
              externalId: `ext-${msgId}`,
              createdAt: new Date(vnow()).toISOString(),
              ingress: { topicArn: t.topicArn, messageId: msgId, region: t.region, payload: basePayload },
              ...(a.kind === "bounce"
                ? { effects: { reported: [rec.to], suppress: "hard_bounce", observe: null, receiptTime: false } }
                : a.kind === "complaint"
                  ? { effects: { reported: [rec.to], suppress: "complaint", observe: null, receiptTime: false } }
                  : {}),
            };
          });
          await ingestRoutineSesEvents(runtime, inputs as any);
        }
        const st = await readCampaignState(t);
        return toObs(dbReadOnly ? 503 : 200, dbReadOnly ? "DATABASE_UNAVAILABLE" : null, st, 0);
      }

      case "Tick": {
        await setVirtualClock(vnow() + a.seconds * 1000);
        if (!dbReadOnly) {
          await adminPool.query(
            "UPDATE provider_account_limits SET checked_at = now(), refresh_after = now() + interval '10 minutes' WHERE aws_account_id = $1 AND region = $2",
            [t.poolAccount, t.region],
          );
        }
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "RevokeOriginKey": {
        const r = await api(t, "POST", `/v1/api-keys/${t.originKeyId}/revoke`, {});
        const st = await readCampaignState(t);
        return toObs(r.status, r.status >= 400 ? r.body?.error?.code ?? null : null, st, r.elapsedMs);
      }

      case "SetRequiredNotices": {
        await adminPool.query("UPDATE workspaces SET required_notices = $1 WHERE id = $2", [a.enabled, t.w]);
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "FlipSesMode": {
        t.liveSes = !t.liveSes;
        runtime = makeRuntime(t.liveSes);
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "SetDbReadOnly": {
        dbReadOnly = a.on;
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "SetQuota": {
        t.accountMax24h = a.max24;
        t.accountSent24h = a.sent24;
        await adminPool.query(
          `UPDATE provider_account_limits
           SET max_24_hour_send = $1, sent_last_24_hours = $2, customer_sent_24_hours = $3,
               checked_at = now(), refresh_after = now() + interval '10 minutes'
           WHERE aws_account_id = $4 AND region = $5`,
          [a.max24, a.sent24, a.customer24, t.poolAccount, t.region],
        );
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "CrashJobAndRedeliver": {
        // Simulate a worker crash mid-job: mark campaign.run running with an expired lease, then reclaim via real processJobs!
        await adminPool.query(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, available_at = now(), lease_until = now() - interval '1 minute'
           WHERE id = $1 AND status IN ('pending', 'running')`,
          [`campaign.run:${t.campaignId}`],
        );
        if (!dbReadOnly) {
          await runOneCampaignJob(t);
        }
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "DeployMidCampaign": {
        // Fresh app, runtime, and dispatcher gate — simulates a code deploy / new isolate mid-campaign.
        runtime = makeRuntime(t.liveSes);
        app = createApp();
        gate = initialGate();
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "CheckPlannerRate": {
        const { rows: [lim] } = await adminPool.query<{ max_send_rate: number }>(
          "SELECT max_send_rate::float8 AS max_send_rate FROM regional_workspace_limits WHERE workspace_id = $1 AND region = $2",
          [t.w, t.region],
        );
        const expectedViewRate = t.cfg.exempt ? t.accountMaxRate : t.accountMaxRate / 4;
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0, {
          viewRate: lim ? lim.max_send_rate : null,
          expectedViewRate,
        });
      }

      case "InjectFeedbackLag": {
        if (!HAS_PR619) {
          const st = await readCampaignState(t);
          return toObs(200, "PR619_TABLE_ABSENT", st, 0);
        }
        await adminPool.query(
          `INSERT INTO operation_feedback_lag(lane, depth, oldest_ms, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT(lane) DO UPDATE SET depth=excluded.depth, oldest_ms=excluded.oldest_ms, updated_at=now()`,
          [a.lane, a.lagMs > 0 ? 5000 : 0, a.lagMs],
        );
        const st = await readCampaignState(t);
        return toObs(200, null, st, 0);
      }

      case "Settle": {
        // Clear transient faults (read-only & artificial quota) and drive campaign to terminal or visible wait within bounded iterations.
        dbReadOnly = false;
        t.accountMax24h = t.cfg.accountMax24h;
        t.accountSent24h = 0;
        gate = initialGate();
        await adminPool.query(
          `UPDATE provider_account_limits
           SET max_24_hour_send = $1, sent_last_24_hours = 0, customer_sent_24_hours = 0,
               checked_at = now(), refresh_after = now() + interval '10 minutes'
           WHERE aws_account_id = $2 AND region = $3`,
          [t.cfg.accountMax24h, t.poolAccount, t.region],
        );

        let st = await readCampaignState(t);
        for (let iter = 0; iter < 40; iter++) {
          if (["draft", "done", "canceled", "failed", "paused"].includes(st.state)) break;
          // If waiting on a future job or scheduled time, advance virtual clock just past it
          const { rows: [job] } = await adminPool.query<{ available_at: string | null; status: string }>(
            "SELECT available_at::text, status FROM jobs WHERE id = $1",
            [`campaign.run:${t.campaignId}`],
          );
          if (job && job.status === "pending" && job.available_at) {
            const availMs = Date.parse(job.available_at);
            if (availMs > vnow()) {
              await setVirtualClock(availMs + 1000);
            }
          } else if (st.waitingUntil && Date.parse(st.waitingUntil) > vnow()) {
            await setVirtualClock(Date.parse(st.waitingUntil) + 1000);
          } else if (st.state === "sending" && st.expanded === st.total) {
            const { rows: [nxt] } = await adminPool.query<{ next_at: string | null }>(
              "SELECT min(scheduled_at)::text AS next_at FROM sending_emails WHERE workspace_id=$1 AND campaign_id=$2 AND status='queued' AND scheduled_at > now()",
              [t.w, t.campaignId],
            );
            if (nxt?.next_at && Date.parse(nxt.next_at) > vnow()) {
              await setVirtualClock(Date.parse(nxt.next_at) + 1000);
            }
          }
          // Refresh quota timestamp so virtual clock jump doesn't expire quota cache
          await adminPool.query(
            "UPDATE provider_account_limits SET checked_at = now(), refresh_after = now() + interval '10 minutes' WHERE aws_account_id = $1 AND region = $2",
            [t.poolAccount, t.region],
          );
          await runOneCampaignJob(t);
          await runDispatchStep(t, 200);
          st = await readCampaignState(t);
        }
        // Check Rule 6: must not be stuck in preparing or sending without a visible waiting reason
        if (st.state === "preparing" || (st.state === "sending" && st.waitingReason === null)) {
          t.stuckViolations.push(`campaign stuck after Settle: state=${st.state} prepared=${st.prepared}/${st.total} expanded=${st.expanded} waiting=${st.waitingReason}`);
        }
        return toObs(200, null, st, 0);
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    await verifyAllInvariants(t);
    const st = t.configured
      ? await readCampaignState(t)
      : {
          state: "draft" as CampaignStateName,
          total: 0,
          prepared: 0,
          expanded: 0,
          canceled: 0,
          waitingReason: null,
          waitingUntil: null,
          pauseReasonCode: null,
          errorCode: null,
        };
    const events = t.pendingEvents;
    t.pendingEvents = [];
    const snap: LifecycleSnapshot = {
      configured: t.configured,
      state: st.state,
      total: st.total,
      prepared: st.prepared,
      expanded: st.expanded,
      canceled: st.canceled,
      waitingReason: st.waitingReason,
      waitingUntil: st.waitingUntil,
      pauseReasonCode: st.pauseReasonCode,
      errorCode: st.errorCode,
      duplicateRecipients: [...t.duplicateRecipients],
      accountingViolations: [...t.accountingViolations],
      sentBeforePrepared: [...t.sentBeforePrepared],
      sentAfterCancel: [...t.sentAfterCancel],
      pauseBoundViolations: [...t.pauseBoundViolations],
      preReleaseSuppressionViolations: [...t.preReleaseSuppressionViolations],
      controlViolations: [...t.controlViolations],
      probeViolations: [...t.probeViolations],
      stuckViolations: [...t.stuckViolations],
      rateViolations: [...t.rateViolations],
      statsViolations: [...t.statsViolations],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events };
  },

  async close(t: Trial): Promise<void> {
    dbReadOnly = false;
    if (t.configured && t.w) {
      await adminPool.query("UPDATE sending_emails SET status='canceled' WHERE workspace_id=$1 AND status IN ('queued','attempting')", [t.w]);
      await adminPool.query("UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND status IN ('pending','running')", [t.w]);
      await adminPool.query("UPDATE sending_campaigns SET state='canceled', paused_at=NULL, pause_reason=NULL, waiting_reason=NULL, waiting_until=NULL WHERE workspace_id=$1 AND state IN ('preparing','scheduled','sending','paused','failed')", [t.w]);
      lastVirtual = vnow();
      await adminPool.query("UPDATE tear_clock.state SET horizon = greatest(horizon, $1) WHERE id = 1", [Math.ceil(lastVirtual)]);
    }
    if (activeTrial === t) activeTrial = null;
  },
});
