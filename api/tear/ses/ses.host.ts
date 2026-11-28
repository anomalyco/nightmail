import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { generateKeyPairSync, randomUUID, sign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { ses } from "./ses.model.ts";
import type { SesAction, SesObs, SesSnapshot, SesView } from "./ses.types.ts";

const hex = (n: number) =>
  Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll("-", ""))
    .join("")
    .slice(0, n);

for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] = (...a: unknown[]) => {
    if (process.env.TEAR_HOST_LOG) process.stderr.write(a.map(String).join(" ") + "\n");
  };
}
const trace = (line: string) => {
  if (process.env.TEAR_TRACE) process.stderr.write(line + "\n");
};

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const DATABASE_URL = await (async () => {
  const checked = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
  const c = new pg.Client({ connectionString: checked });
  await c.connect();
  try {
    await assertDisposable((text) => c.query(text));
  } finally {
    await c.end();
  }
  return checked;
})();

// No network: SNS certificates come from the pinned fixture, webhooks are never delivered here.
globalThis.fetch = (async () => {
  throw new Error("tear host: network is forbidden");
}) as typeof fetch;

const [{ createApp }, { nodeRuntime }, ops, snsIngress, sesFeedback, sending, { dispatchAsActor }] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/adapters/node.ts"),
  import("../../src/webhooks/operations.ts"),
  import("../../src/ses/sns-ingress.ts"),
  import("../../src/ses/feedback.ts"),
  import("../../src/sending/events.ts"),
  import("../../src/auth.ts"),
]);

const REGION = "us-east-1";
const ACCOUNT = "111122223333";
const TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:tear-ses-feedback`;
const STRAY = `arn:aws:sns:${REGION}:${ACCOUNT}:tear-ses-unregistered`;
const PUBLIC = "http://127.0.0.1:9";
const OTHER_ACCOUNT = "222233334444";
const OTHER = `arn:aws:sns:${REGION}:${OTHER_ACCOUNT}:tear-ses-feedback`;

const instance = nodeRuntime({
  DATABASE_URL,
  BANE_ROOT_SECRET: hex(64),
  ACCOUNT_CLIENT_ID: "tear-fixture",
  ACCOUNT_CLIENT_PRIVATE_KEY: "tear-fixture",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  PUBLIC_URL: PUBLIC,
  DEFAULT_SES_REGION: REGION,
  ENABLE_LIVE_SES: "false",
  S3_BUCKET: "tear-fixture",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
});
const runtime = instance.runtime;
runtime.config.multiTenant = true;
runtime.feedback = undefined;
runtime.wake = async () => {};
const app = createApp();
type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (() => {
  const tmp = mkdtempSync(join(tmpdir(), "tear-ses-cert-"));
  try {
    const file = join(tmp, "key.pem");
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return execFileSync("openssl", ["req", "-new", "-x509", "-key", file, "-days", "2", "-subj", "/CN=tear-ses"], {
      encoding: "utf8",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex(32)}.pem`;
const certs = new snsIngress.SnsCertificateState();
certs.candidates.set(CERT_URL, { cert: new X509Certificate(pem), expiresAt: Date.now() + 86_400_000 });
runtime.snsCertificateState = certs;

type Paused = { gate: string; release: () => void };
type Raw = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
type Conn = {
  name: string;
  client: pg.Client;
  db: Db;
  pid: number;
  raw: Raw;
  open: boolean;
  pending?: Promise<void>;
  settled?: { ok: boolean; value: unknown };
  paused?: Paused;
  notify?: (v: string) => void;
  gating?: boolean;
  job?: Json;
  crashed?: boolean;
  label?: string;
  blocked?: boolean;
  old?: boolean;
};

const GATES: [string, RegExp][] = [
  ["record", /WITH mail AS MATERIALIZED/],
  ["suppress", /^\s*begin\b/i],
  ["mark", /update "operation_sns_receipts"/i],
];

function signal(c: Conn, v: string) {
  const n = c.notify;
  c.notify = undefined;
  n?.(v);
}

async function connect(name: string): Promise<Conn> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
  const raw: Raw = (text, values) => query(text, values);
  const c: Conn = { name, client, db: drizzle(client) as unknown as Db, pid, raw, open: false };
  (client as Json).query = (...args: Json[]) => {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const gate = c.gating && typeof text === "string" ? GATES.find(([, re]) => re.test(text))?.[0] : undefined;
    if (!gate) return query(...args);
    return new Promise<void>((release) => {
      c.paused = { gate, release };
      trace(`TEAR_GATE ${name} ${gate}`);
      signal(c, `at:${gate}`);
    }).then(() => query(...args));
  };
  return c;
}

const conns: Record<string, Conn> = {};
for (const name of ["Q", "P", "J", "K"]) conns[name] = await connect(name);
const auto = await connect("auto");
const checker = await connect("checker");

type Spec = { email: "e1" | "e2" | "x9"; kind: string; at: number; detail?: Json };
const SPECS: Record<string, Spec> = {
  s1: { email: "e1", kind: "Send", at: 1 },
  y1: { email: "e1", kind: "DeliveryDelay", at: 2, detail: { delayType: "TransientCommunicationFailure", delayedRecipients: [{ emailAddress: "r1" }] } },
  t1: { email: "e1", kind: "Bounce", at: 2, detail: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "r1" }] } },
  d1: { email: "e1", kind: "Delivery", at: 3, detail: { recipients: ["r1"] } },
  b1: { email: "e1", kind: "Bounce", at: 4, detail: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "r1" }] } },
  v1: { email: "e1", kind: "Bounce", at: 4, detail: { bounceType: "Permanent", bounceSubType: "EmailValidationSuppressed", bouncedRecipients: [{ emailAddress: "r1" }] } },
  c1: { email: "e1", kind: "Complaint", at: 5, detail: { complainedRecipients: [{ emailAddress: "r1" }] } },
  n1: { email: "e1", kind: "Complaint", at: 5, detail: { complaintFeedbackType: "not-spam", complainedRecipients: [{ emailAddress: "r1" }] } },
  j1: { email: "e1", kind: "Reject", at: 1, detail: { reason: "Bad content" } },
  f1: { email: "e1", kind: "Rendering Failure", at: 1, detail: { errorMessage: "Attribute missing", templateName: "tear" } },
  o1: { email: "e1", kind: "Open", at: 6, detail: { ipAddress: "192.0.2.1", userAgent: "tear" } },
  d2: { email: "e2", kind: "Delivery", at: 3, detail: { recipients: ["r1", "r2"] } },
  b2: { email: "e2", kind: "Bounce", at: 4, detail: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "r2" }] } },
  v2: { email: "e2", kind: "Bounce", at: 4, detail: { bounceType: "Permanent", bounceSubType: "EmailValidationSuppressed", bouncedRecipients: [{ emailAddress: "r1" }] } },
  c2: { email: "e2", kind: "Complaint", at: 5, detail: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "R2" }] } },
  x9: { email: "x9", kind: "Bounce", at: 4, detail: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "r1" }] } },
};

const TABLES = [
  "sending_email_events", "operation_events", "operation_deliveries", "operation_delivery_attempts",
  "jobs", "operation_sns_receipts", "operation_feedback_failures", "audience_contacts",
  "audience_consent_audit", "sending_emails", "sending_campaigns", "operation_webhooks",
  "hosted_health_credits", "hosted_health_hourly", "hosted_usage_hourly",
  "provider_connections", "workspaces",
];

const OLD_RANK = {
  queued: 0, attempting: 1, acceptance_unknown: 2, accepted: 3, sent: 4, delayed: 4,
  delivered: 5, bounced: 6, complained: 7, rejected: 6, rendering_failed: 6,
  suppressed: 6, canceled: 6, simulated: 6,
};
const NEW_RANK = { ...sending.rank };

async function ranked<T>(old: boolean, fn: () => Promise<T>): Promise<T> {
  if (!old) return fn();
  Object.assign(sending.rank, OLD_RANK);
  try {
    return await fn();
  } finally {
    Object.assign(sending.rank, NEW_RANK);
  }
}

interface Trial {
  bug?: string;
  ws: string;
  hexId: string;
  T0: number;
  ids: Record<string, string>;
  suppressedEver: Set<string>;
  pendingEvents: HostEvent[];
  lastSnapshot: SesSnapshot | null;
}

let currentWs = "";

async function abortAll() {
  for (const c of Object.values(conns)) {
    if (c.pending && !c.settled && !c.paused) await checker.raw("SELECT pg_cancel_backend($1)", [c.pid]);
  }
  for (const [name, c] of Object.entries(conns)) {
    if (c.paused || c.crashed || c.blocked || ((c.name === "J" || c.name === "K") && c.pending && !c.settled)) {
      c.crashed = true;
      c.notify = undefined;
      c.gating = false;
      await c.client.end().catch(() => {});
      conns[name] = await connect(name);
      continue;
    }
    if (c.pending) await c.pending;
    if (c.open) await c.raw("ROLLBACK");
    Object.assign(c, {
      open: false, pending: undefined, settled: undefined, job: undefined, label: undefined, blocked: false, old: false,
    });
  }
}

const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? "ERROR"}`;
const outcome = (o: { ok: boolean; error?: string }) => (o.ok ? "ok" : `e:${o.error}`);
const detailKey = (kind: string) =>
  kind === "Rendering Failure" ? "failure" : kind === "DeliveryDelay" ? "deliveryDelay" : kind.toLowerCase();

const hostDomain = (t: Trial) => `${t.ws.replaceAll("_", "-")}.invalid`;
const address = (t: Trial, r: string) => `${r}@${hostDomain(t)}`;
const mid = (t: Trial, label: string) => `${t.ws}-${label}`;

function buildMessage(t: Trial, label: string, account = ACCOUNT) {
  const s = SPECS[label];
  if (!s) throw new Error(`unknown notification ${label}`);
  const at = new Date(t.T0 + s.at * 1000).toISOString();
  const recips = (v: Json): Json =>
    Array.isArray(v)
      ? v.map(recips)
      : typeof v === "string" && /^[rR]\d$/.test(v)
        ? address(t, v)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recips(x)]))
          : v;
  const provider = mid(t, s.email === "x9" ? "p9" : s.email === "e1" ? "p1" : "p2");
  const mail = {
    timestamp: new Date(t.T0).toISOString(),
    messageId: provider,
    sendingAccountId: account,
    source: `sender@${hostDomain(t)}`,
    destination: s.email === "e2" ? [address(t, "r1"), address(t, "r2")] : [address(t, "r1")],
    ...(s.email === "x9" ? {} : { tags: { bane_email_id: [t.ids[s.email]] } }),
  };
  return { eventType: s.kind, mail, [detailKey(s.kind)]: { ...recips(s.detail ?? {}), timestamp: at } };
}

const buildItem = (t: Trial, label: string) => ({
  region: REGION,
  topicArn: TOPIC,
  messageId: mid(t, label),
  message: buildMessage(t, label) as Record<string, unknown>,
  topicKind: "shared" as const,
});

function buildEnvelope(t: Trial, label: string, topic = TOPIC, account = ACCOUNT) {
  const values: Json = {
    Message: JSON.stringify(buildMessage(t, label, account)),
    MessageId: mid(t, label),
    Timestamp: new Date(t.T0).toISOString(),
    TopicArn: topic,
    Type: "Notification",
  };
  const canonical = Object.entries(values)
    .map(([k, v]) => `${k}\n${v}\n`)
    .join("");
  return {
    ...values,
    SigningCertURL: CERT_URL,
    SignatureVersion: "2",
    Signature: Buffer.from(sign("RSA-SHA256", Buffer.from(canonical), privateKey)).toString("base64"),
  };
}

const runtimeOn = (t: Trial, db: Db) => ({ ...runtime, db, config: { ...runtime.config, workspaceId: t.ws } }) as Json;

async function httpReq(t: Trial, db: Db, body: unknown) {
  const res = await app.fetch(
    new Request(`${PUBLIC}/v1/events/ses`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=UTF-8", "x-bane-client-ip": "2001:db8::1" },
      body: JSON.stringify(body),
    }),
    runtimeOn(t, db),
  );
  const json = (await res.json()) as Json;
  return res.status === 202 ? "ok" : `e:${json?.error?.code ?? res.status}`;
}

async function dispatched(t: Trial, db: Db, e: string, lost: boolean) {
  await sending.recordEmailEvent(runtimeOn(t, db), {
    workspaceId: t.ws,
    emailId: t.ids[e]!,
    type: lost ? "acceptance_unknown" : "accepted",
    providerId: lost ? undefined : mid(t, e === "e1" ? "p1" : "p2"),
    errorCode: lost ? "SES_ACCEPTANCE_UNKNOWN" : undefined,
    externalId: `attempt-result:${t.ids[e]}:0`,
    data: lost ? { code: "SES_ACCEPTANCE_UNKNOWN", status: "acceptance_unknown" } : {},
  });
  return "ok";
}

async function settleConn(c: Conn): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    if (c.settled) {
      const s = c.settled;
      c.pending = c.settled = undefined;
      return s.ok ? s.value : errOf(s.value);
    }
    const own = [...Object.values(conns).map((x) => x.pid), auto.pid];
    const w = (
      await checker.raw(
        "SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked,pg_blocking_pids($1) AS by FROM pg_stat_activity WHERE pid=$1",
        [c.pid, own],
      )
    ).rows[0];
    if (w?.blocked && !c.settled) return "blocked";
    if (Date.now() - start > 10_000) return "stuck";
    await new Promise((r) => setImmediate(r));
  }
}

async function lockWait(c: Conn) {
  const own = [...Object.values(conns).map((x) => x.pid), auto.pid];
  const w = (
    await checker.raw(
      "SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked FROM pg_stat_activity WHERE pid=$1",
      [c.pid, own],
    )
  ).rows[0];
  return !!w?.blocked && !c.paused;
}

function waitWorker(c: Conn): Promise<string> {
  if (c.paused) return Promise.resolve(`at:${c.paused.gate}`);
  if (c.settled) return Promise.resolve(`done:${c.settled.value}`);
  return new Promise<string>((resolve) => {
    c.notify = resolve;
    (async () => {
      while (c.notify === resolve) {
        await new Promise((r) => setTimeout(r, 3));
        if (c.notify === resolve && (await lockWait(c)) && c.notify === resolve) {
          c.notify = undefined;
          resolve("blocked");
        }
      }
    })();
  });
}

async function stepWorker(c: Conn): Promise<string> {
  const p = c.paused!;
  c.paused = undefined;
  const wait = waitWorker(c);
  p.release();
  return wait;
}

function finishWorker(c: Conn, v: string) {
  if (v.startsWith("done:")) {
    c.pending = c.settled = undefined;
    return v.slice(5);
  }
  return v;
}

const MAX_ATTEMPTS = 6;
async function claimJob(t: Trial, c: Conn, label: string) {
  const r = (await c.raw(
    `UPDATE jobs SET status='running',attempts=attempts+1,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=$1 AND type='operation.ses' AND payload->>'messageId'=$2
      AND (status='pending' OR (status='running' AND lease_until<now() AND attempts<$3)) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,payload,attempts,lease_until::text AS fence`,
    [t.ws, mid(t, label), MAX_ATTEMPTS],
  )) as pg.QueryResult;
  return r.rows[0];
}

async function runJob(t: Trial, c: Conn, label: string): Promise<string> {
  const job = await claimJob(t, c, label);
  if (!job) return "none";
  c.job = job;
  c.label = label;
  c.gating = true;
  c.settled = undefined;
  const wait = waitWorker(c);
  const handler = ops.operationJobs["operation.ses"]!;
  c.pending = (async () => {
    let state: string;
    try {
      await handler(runtimeOn(t, c.db), job.payload, { id: job.id, attempts: job.attempts, workspaceId: t.ws });
      c.gating = false;
      await c.raw(
        `UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND attempts=$2 AND status='running' AND lease_until=$3::timestamptz`,
        [job.id, job.attempts, job.fence],
      );
      state = "done";
    } catch (error: any) {
      c.gating = false;
      const retryable = (error as Json)?.retryable === true;
      const code = String((error as Json)?.code ?? "JOB_INTERNAL_ERROR");
      const retry = retryable && job.attempts < MAX_ATTEMPTS;
      if (!c.crashed) {
        await c.raw(
          `UPDATE jobs SET status=$4,lease_until=NULL,last_error=$5 WHERE id=$1 AND attempts=$2 AND status='running' AND lease_until=$3::timestamptz`,
          [job.id, job.attempts, job.fence, retry ? "pending" : "failed", code],
        ).catch(() => {});
      }
      state = `${retry ? "retry" : "failed"}:${code}`;
    }
    c.settled = { ok: true, value: state };
    c.job = undefined;
    c.label = undefined;
    signal(c, `done:${state}`);
  })().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    c.settled = { ok: false, error: msg };
    c.job = undefined;
    c.label = undefined;
    signal(c, `error:${msg}`);
  });
  return wait;
}

async function wakeWaiters() {
  const woke: Record<string, unknown> = {};
  for (const other of Object.values(conns)) {
    if (other.name === "Q" || other.name === "P") {
      if (other.pending) {
        const v = await settleConn(other);
        if (v !== "blocked") woke[other.name] = v;
      }
      continue;
    }
    if (other.blocked) {
      const v = await waitWorker(other);
      if (v !== "blocked") {
        other.blocked = false;
        woke[other.name] = finishWorker(other, v);
      }
    }
  }
  return woke;
}

async function finishHeld(c: Conn, commit: boolean) {
  let r: unknown = "ok";
  try {
    await c.raw(commit ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    r = errOf(e);
  }
  c.open = false;
  return { r, woke: await wakeWaiters() };
}

const BITS: Record<string, number> = {
  "email.sent": 1,
  "email.delivered": 3,
  "email.complained": 9,
  "email.delivery_delayed": 129,
  "email.opened": 16,
  "email.clicked": 32,
  "email.rendering_failed": 64,
};
const bitsOf = (type: string, data: Json) =>
  type === "email.bounced"
    ? data.bounceSubType === "EmailValidationSuppressed"
      ? 0
      : data.bounceType === "Permanent"
        ? 5
        : 129
    : type === "email.rejected"
      ? ["suppressed", "canceled", "acceptance_unknown"].includes(data.status)
        ? 0
        : 64
      : BITS[type] ?? 0;

async function readRoute(t: Trial, path: string) {
  const actor = { workspaceId: t.ws, permissions: ["read"], domains: [], keyId: "mcp_tear", credential: "mcp" } as Json;
  const res = await dispatchAsActor(
    app,
    new Request(`${PUBLIC}${path}`, { headers: { accept: "application/json" } }),
    runtimeOn(t, checker.db),
    actor,
  );
  return res.status === 200 ? ((await res.json()) as Json) : { error: res.status };
}

async function readStateAndSnapshot(t: Trial): Promise<{ view: SesView; snapshot: SesSnapshot }> {
  const q = (text: string, values: unknown[]) => checker.raw(text, values);
  const {
    rows: [v],
  } = await q(
    `SELECT jsonb_build_object(
    'emails',(SELECT jsonb_object_agg(id,jsonb_build_array(status,provider_id IS NOT NULL,event_outcomes,error_code,suppression_reason)) FROM sending_emails WHERE workspace_id=$1),
    'contacts',(SELECT coalesce(jsonb_object_agg(email,jsonb_build_array(suppressed,suppression_reason,last_open_at IS NOT NULL)),'{}') FROM audience_contacts WHERE workspace_id=$1),
    'events',(SELECT coalesce(jsonb_agg(jsonb_build_array(external_id,type,email_id,id,data,recipient_hashes IS NOT NULL,coalesce(cardinality(recipient_hashes),0)) ORDER BY external_id),'[]') FROM sending_email_events WHERE workspace_id=$1),
    'published',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,type,data) ORDER BY id),'[]') FROM operation_events WHERE workspace_id=$1),
    'deliveries',(SELECT coalesce(jsonb_agg(jsonb_build_array(webhook_id,event_id,payload)),'[]') FROM operation_deliveries WHERE workspace_id=$1),
    'receipts',(SELECT coalesce(jsonb_object_agg(message_id,processed_at IS NOT NULL),'{}') FROM operation_sns_receipts WHERE workspace_id=$1),
    'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_array(type,payload->>'messageId',status,attempts) ORDER BY created_at,id),'[]') FROM jobs WHERE workspace_id=$1),
    'quarantined',(SELECT count(*) FROM operation_feedback_failures WHERE workspace_id=$1 OR topic_arn=$2),
    'hosted',(SELECT jsonb_build_array(coalesce(sum(accepted),0),coalesce(sum(bounces),0),coalesce(sum(complaints),0)) FROM hosted_health_hourly WHERE workspace_id=$1),
    'credits',(SELECT coalesce(jsonb_agg(jsonb_build_array(email_id,epoch,hour,accepted,bounces,complaints) ORDER BY email_id,epoch,hour),'[]') FROM hosted_health_credits WHERE workspace_id=$1),
    'projection',(SELECT coalesce(jsonb_agg(jsonb_build_array(email_id,epoch,hour,accepted,bounces,complaints) ORDER BY email_id,epoch,hour),'[]') FROM hosted_health_projection WHERE workspace_id=$1),
    'hourly',(SELECT coalesce(jsonb_agg(jsonb_build_array(epoch,hour,accepted,bounces,complaints) ORDER BY epoch,hour),'[]') FROM hosted_health_hourly WHERE workspace_id=$1)) v`,
    [t.ws, TOPIC],
  );
  const d = v.v;
  const labelOf = (external: string | null) => {
    if (!external) return "?";
    if (external.startsWith(`${TOPIC}:${t.ws}-`)) return external.slice(`${TOPIC}:${t.ws}-`.length);
    const m = /^attempt-result:email_[0-9a-f]+(e\d):0$/.exec(external);
    return m ? `A:${m[1]}` : external;
  };
  const emailLabel = (id: string) => Object.entries(t.ids).find(([, x]) => x === id)?.[0] ?? id;
  const addrLabel = (a: string) => a.split("@")[0]!;
  const eventById = new Map<string, Json>(d.events.map((e: Json) => [e[3], e]));

  const statsRes = await readRoute(t, `/v1/campaigns/${t.ids.c}/stats`);
  const stats: SesView["stats"] = statsRes.error
    ? statsRes
    : [
        statsRes.totals.accepted,
        statsRes.totals.delivered,
        statsRes.totals.bounced,
        statsRes.totals.complained,
        statsRes.totals.failed,
        statsRes.totals.deliveryDelayed,
      ];
  const scoreRes = await readRoute(t, "/v1/sender-score");
  const score: SesView["score"] = scoreRes.error
    ? scoreRes
    : (["bounces", "complaints", "hygiene"].map(
        (k) => scoreRes.factors.find((f: Json) => f.key === k)?.value ?? null,
      ) as SesView["score"]);

  const view: SesView = {
    emails: Object.fromEntries(Object.entries(d.emails ?? {}).map(([id, e]: Json) => [emailLabel(id), e])),
    contacts: Object.fromEntries(Object.entries(d.contacts).map(([a, c]: Json) => [addrLabel(a), c])),
    events: d.events
      .map((e: Json) => [labelOf(e[0]), e[1], emailLabel(e[2]), e[6]])
      .sort((a: Json, b: Json) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    published: d.published
      .map((p: Json) => [labelOf(eventById.get(p[0])?.[0] ?? null), p[1]])
      .sort((a: Json, b: Json) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    deliveries: (["w1", "w2"] as const).map((w) =>
      d.deliveries
        .filter((x: Json) => x[0] === t.ids[w])
        .map((x: Json) => labelOf(eventById.get(x[1])?.[0] ?? null))
        .sort(),
    ) as [string[], string[]],
    receipts: Object.fromEntries(Object.entries(d.receipts).map(([k, p]) => [k.slice(t.ws.length + 1), p as boolean])),
    jobs: d.jobs
      .map((j: Json) => [j[0] === "operation.ses" ? "ses" : j[0], j[1]?.slice(t.ws.length + 1) ?? null, j[2], j[3]])
      .filter((j: Json) => j[0] === "ses")
      .sort((a: Json, b: Json) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
    hosted: d.hosted.map(Number) as [number, number, number],
    stats,
    score,
  };

  // Factual snapshot checks evaluated by pure model idle rules
  const outcomeBitsMismatches: string[] = [];
  for (const [label, e] of Object.entries(view.emails)) {
    const want = d.published
      .filter((p: Json) => p[2]?.emailId === t.ids[label])
      .reduce((s: number, p: Json) => s | bitsOf(p[1], p[2]), 0);
    if (e[2] !== want) outcomeBitsMismatches.push(`${label}: event_outcomes ${e[2]} != recount ${want}`);
  }

  const seen = new Map<string, number>();
  for (const e of d.events) seen.set(e[0], (seen.get(e[0]) ?? 0) + 1);
  const duplicateStoredEvents: string[] = [];
  for (const [k, n] of seen) if (n > 1) duplicateStoredEvents.push(`${labelOf(k)}: ${n} email events`);

  const orphanPublishedEvents: string[] = [];
  for (const p of d.published) {
    const ev = eventById.get(p[0]);
    if (!ev) orphanPublishedEvents.push(`${p[0]}: published without an email event`);
    else if (p[2]?.emailId !== ev[2]) orphanPublishedEvents.push(`${labelOf(ev[0])}: published for another email`);
  }

  const deliveryInconsistencies: string[] = [];
  const byEndpoint = new Map<string, number>();
  for (const x of d.deliveries) {
    const key = `${x[0]}:${x[1]}`;
    byEndpoint.set(key, (byEndpoint.get(key) ?? 0) + 1);
    const p = d.published.find((p: Json) => p[0] === x[1]);
    if (!p) deliveryInconsistencies.push(`delivery for unpublished event ${x[1]}`);
    else if (x[2]?.type !== p[1] || JSON.stringify(x[2]?.data) !== JSON.stringify(p[2])) {
      deliveryInconsistencies.push(`${labelOf(eventById.get(p[0])?.[0] ?? null)}: delivery payload differs from its event`);
    }
  }
  for (const [k, n] of byEndpoint) if (n > 1) deliveryInconsistencies.push(`${k}: ${n} deliveries`);

  const creditsProjectionMismatch =
    JSON.stringify(d.credits) !== JSON.stringify(d.projection)
      ? `hosted credits ${JSON.stringify(d.credits)} != projection ${JSON.stringify(d.projection)}`
      : null;

  const sums = new Map<string, number[]>();
  for (const c of d.credits) {
    const k = `${c[1]}|${c[2]}`;
    const s = sums.get(k) ?? [0, 0, 0];
    sums.set(k, [s[0]! + c[3], s[1]! + c[4], s[2]! + c[5]]);
  }
  const hourly = d.hourly
    .filter((h: Json) => h[2] || h[3] || h[4])
    .map((h: Json) => `${h[0]}|${h[1]}:${[h[2], h[3], h[4]].map(Number).join(",")}`)
    .sort();
  const recount = [...sums]
    .filter(([, s]) => s.some(Boolean))
    .map(([k, s]) => `${k}:${s.join(",")}`)
    .sort();
  const hourlyCreditsMismatch =
    JSON.stringify(hourly) !== JSON.stringify(recount)
      ? `hosted hourly ${JSON.stringify(hourly)} != credits ${JSON.stringify(recount)}`
      : null;

  const suppressionLifted: string[] = [];
  for (const [r, c] of Object.entries(view.contacts)) {
    if (c[0]) {
      if (!t.suppressedEver.has(r)) {
        t.suppressedEver.add(r);
        t.pendingEvents.push({ name: "contact.suppressed", data: { contact: r } });
        if (t.bug === "canary_lift_suppression") {
          t.pendingEvents.push({ name: "contact.unsuppressed", data: { contact: r } });
        }
      }
    } else if (t.suppressedEver.has(r)) {
      suppressionLifted.push(r);
      t.pendingEvents.push({ name: "contact.unsuppressed", data: { contact: r } });
    }
  }

  const snapshot: SesSnapshot = {
    outcomeBitsMismatches,
    duplicateStoredEvents,
    orphanPublishedEvents,
    deliveryInconsistencies,
    creditsProjectionMismatch,
    hourlyCreditsMismatch,
    quarantinedCount: Number(d.quarantined),
    suppressionLifted,
  };
  t.lastSnapshot = snapshot;
  return { view, snapshot };
}

export const sesHost = host(ses, {
  async open(req): Promise<Trial> {
    await abortAll();
    await assertDisposable((text) => checker.raw(text));
    const q = (text: string, values?: unknown[]) => auto.raw(text, values);
    if (currentWs) {
      for (const tbl of TABLES) {
        await q(`DELETE FROM ${tbl} WHERE ${tbl === "workspaces" ? "id" : "workspace_id"}=$1`, [currentWs]);
      }
    }
    const hexId = hex(12);
    const ws = `tear_ses_${hexId}`;
    currentWs = ws;
    const T0 = Date.now() - 60_000;
    runtime.config.workspaceId = ws;
    const ids: Record<string, string> = {
      e1: `email_${hexId}e1`,
      e2: `email_${hexId}e2`,
      c: `cmp_${hexId}`,
      w1: `wh_${hexId}w1`,
      w2: `wh_${hexId}w2`,
    };
    const trial: Trial = {
      bug: req.bug,
      ws,
      hexId,
      T0,
      ids,
      suppressedEver: new Set(),
      pendingEvents: [],
      lastSnapshot: null,
    };
    await q("BEGIN");
    try {
      await q(
        `INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state) VALUES($1,$2,$3,'ready') ON CONFLICT DO NOTHING`,
        [REGION, ACCOUNT, TOPIC],
      );
      await q(
        `INSERT INTO provider_feedback_history(topic_arn,region,aws_account_id,kind) VALUES($1,$2,$3,'shared') ON CONFLICT DO NOTHING`,
        [OTHER, REGION, OTHER_ACCOUNT],
      );
      await q("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [ws]);
      await q(
        `INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`,
        [ws, REGION, ACCOUNT],
      );
      await q(`INSERT INTO sending_campaigns(id,workspace_id,draft,state) VALUES($1,$2,$3,'done')`, [
        ids.c,
        ws,
        JSON.stringify({
          name: "tear",
          from: `sender@${hostDomain(trial)}`,
          subject: "tear",
          tracking: true,
          audience: {},
          defaults: {},
          replyTo: [],
          attachments: [],
          region: REGION,
        }),
      ]);
      for (const [e, to, cc] of [
        ["e1", [address(trial, "r1")], []],
        ["e2", [address(trial, "r1")], [address(trial, "r2")]],
      ] as const) {
        await q(
          `INSERT INTO sending_emails(id,workspace_id,campaign_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,feedback_topic_arn,created_at)
          VALUES($1,$2,$3,$4,'tear',$5,$6,$7,'[]','tear','{"kind":"marketing"}',false,'attempting',$8,now())`,
          [ids[e], ws, ids.c, REGION, `sender@${hostDomain(trial)}`, JSON.stringify(to), JSON.stringify(cc), TOPIC],
        );
      }
      await q(`INSERT INTO audience_contacts(id,workspace_id,email) VALUES($1,$2,$3)`, [
        `con_${hexId}r2`,
        ws,
        address(trial, "r2"),
      ]);
      const types = [
        "email.sent", "email.delivered", "email.bounced", "email.complained",
        "email.rejected", "email.rendering_failed", "email.delivery_delayed",
        "email.opened", "email.clicked",
      ];
      await q(
        `INSERT INTO operation_webhooks(id,workspace_id,url,event_types,encrypted_secret) VALUES($1,$2,'https://example.com/w1',$3,'tear'),($4,$2,'https://example.com/w2','["email.bounced","email.complained"]','tear')`,
        [ids.w1, ws, JSON.stringify(types), ids.w2],
      );
      await q("COMMIT");
    } catch (error) {
      await q("ROLLBACK");
      throw error;
    }
    await readStateAndSnapshot(trial);
    return trial;
  },

  async act(t: Trial, a: SesAction): Promise<SesObs> {
    const old = "old" in a && a.old === true;
    let r: unknown;
    let woke: Record<string, unknown> = {};

    await ranked(old, async () => {
      switch (a.op) {
        case "Queue":
          r = (await sesFeedback.ingestFeedbackBatch(runtimeOn(t, auto.db), [buildItem(t, a.msg)])).map(outcome);
          break;
        case "Pair":
          r = (await sesFeedback.ingestFeedbackBatch(runtimeOn(t, auto.db), [buildItem(t, a.a), buildItem(t, a.b)])).map(outcome);
          break;
        case "Http":
          r = await httpReq(t, auto.db, buildEnvelope(t, a.msg));
          break;
        case "Forge": {
          const env = buildEnvelope(t, "b1");
          const tampered = { ...buildMessage(t, "b1"), mail: { ...buildMessage(t, "b1").mail, messageId: mid(t, "p2") } };
          r = await httpReq(t, auto.db, { ...env, Message: JSON.stringify(tampered) });
          break;
        }
        case "Stray":
          r = await httpReq(t, auto.db, buildEnvelope(t, "b1", STRAY));
          break;
        case "Alien":
          r = await httpReq(t, auto.db, buildEnvelope(t, "b1", TOPIC, "444455556666"));
          break;
        case "Cross":
          if (a.via === "queue") {
            r = (
              await sesFeedback.ingestFeedbackBatch(runtimeOn(t, auto.db), [
                { ...buildItem(t, "b1"), topicArn: OTHER, message: buildMessage(t, "b1", OTHER_ACCOUNT) as Record<string, unknown> },
              ])
            ).map(outcome);
          } else {
            r = await httpReq(t, auto.db, buildEnvelope(t, "b1", OTHER, OTHER_ACCOUNT));
          }
          break;
        case "Accept":
          r = await dispatched(t, auto.db, a.email, false);
          break;
        case "Lost":
          r = await dispatched(t, auto.db, a.email, true);
          break;
        case "Expire":
          await auto.raw("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE workspace_id=$1 AND status='running'", [t.ws]);
          r = "ok";
          break;
        case "Repair": {
          let cursor: string | null = "";
          while (cursor !== null) cursor = (await auto.raw("SELECT repair_feedback_status($1,$2) AS c", [cursor, t.ws])).rows[0].c;
          r = "ok";
          break;
        }
        case "Pause":
          await auto.raw("UPDATE operation_webhooks SET paused=$2 WHERE id=$1", [t.ids.w2, a.paused]);
          r = "ok";
          break;
        case "Claim": {
          const c = conns[a.worker]!;
          c.old = old;
          const v = await runJob(t, c, a.msg);
          if (v === "blocked") c.blocked = true;
          r = finishWorker(c, v);
          break;
        }
        case "Go": {
          const c = conns[a.worker]!;
          const v = await ranked(!!c.old, () => stepWorker(c));
          if (v === "blocked") c.blocked = true;
          r = finishWorker(c, v);
          break;
        }
        case "Crash": {
          const c = conns[a.worker]!;
          c.crashed = true;
          c.notify = undefined;
          c.gating = false;
          c.paused = undefined;
          await c.client.end().catch(() => {});
          conns[a.worker] = await connect(a.worker);
          r = "ok";
          break;
        }
        case "Hold": {
          const c = conns[a.conn]!;
          await c.raw("BEGIN");
          c.open = true;
          c.settled = undefined;
          c.pending = sesFeedback.ingestFeedbackBatch(runtimeOn(t, c.db), [buildItem(t, a.msg)]).then(
            (v) => {
              c.settled = { ok: true, value: v.map(outcome) };
            },
            (e) => {
              c.settled = { ok: false, value: e };
            },
          );
          r = await settleConn(c);
          break;
        }
        case "Commit": {
          const c = conns[a.conn]!;
          ({ r, woke } = await finishHeld(c, a.commit));
          break;
        }
      }
    });

    const { view } = await readStateAndSnapshot(t);
    return { r, woke, view };
  },

  async observe(t: Trial): Promise<Observed> {
    const events = t.pendingEvents;
    t.pendingEvents = [];
    return {
      snapshot: t.lastSnapshot ?? {
        outcomeBitsMismatches: [],
        duplicateStoredEvents: [],
        orphanPublishedEvents: [],
        deliveryInconsistencies: [],
        creditsProjectionMismatch: null,
        hourlyCreditsMismatch: null,
        quarantinedCount: 0,
        suppressionLifted: [],
      },
      events,
    };
  },

  async close(): Promise<void> {
    await abortAll();
  },
});
