import { randomUUID } from "node:crypto";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { admission } from "./admission.model.ts";
import {
  ADMISSION_PRESETS,
  type AdmissionAction,
  type AdmissionCfg,
  type AdmissionObs,
  type AdmissionSnapshot,
  type RecvWsSnapshot,
  type SendWsSnapshot,
  type UploadSnapshot,
} from "./admission.types.ts";

// Silence noisy app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

// Track unhandled rejections/exceptions as idle-rule violations instead of crashing the host.
const leaked: string[] = [];
const leak = (kind: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`host ${kind}: ${text}\n`);
  leaked.push(`${kind}:${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`);
};
process.on("unhandledRejection", leak("unhandled-rejection"));
process.on("uncaughtException", leak("uncaught-exception"));

const hex = (n: number) =>
  Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll("-", ""))
    .join("")
    .slice(0, n);

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const DATABASE_URL = await (async () => {
  const checked = disposableUrl(
    process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL,
    "TEAR_DATABASE_URL",
  );
  const c = new pg.Client({ connectionString: checked });
  await c.connect();
  try {
    await assertDisposable((text) => c.query(text));
  } finally {
    await c.end();
  }
  return checked;
})();

const [
  { createApp },
  { nodeRuntime },
  { acceptInboundNotification, recoverHeldReceipts },
  { setHostedLimits },
  { setWorkspaceExemption },
  { pauseHostedSending, resumeHostedSending },
  { digest },
  { cleanup, reconcileUploads },
  { drainJobs },
  { recoverMailReceipts },
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/adapters/node.ts"),
  import("../../src/mailbox-receipts.ts"),
  import("../../scripts/set-hosted-limits.ts"),
  import("../../scripts/set-workspace-exemption.ts"),
  import("../../src/states.ts"),
  import("../../src/core.ts"),
  import("../../src/maintenance.ts"),
  import("../../src/dispatch.ts"),
  import("../../src/mailbox-ingest.ts"),
]);

// No egress: object storage points at a closed loopback port and fetch refuses every call.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`tear host: network access refused (${String(input)})`);
}) as typeof fetch;

const instance = nodeRuntime({
  DATABASE_URL,
  BANE_ROOT_SECRET: hex(64),
  ACCOUNT_CLIENT_ID: "tear-fixture",
  ACCOUNT_CLIENT_PRIVATE_KEY: "tear-fixture",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  PUBLIC_URL: "http://127.0.0.1:9",
  ENABLE_LIVE_SES: "false",
  S3_BUCKET: "tear-fixture",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
});
const runtime = instance.runtime;
const baseConfig = structuredClone({ ...runtime.config, aws: undefined });
const app = createApp();
const POOL = "210987654321";
const REGION = "us-east-1";
const BUCKET = "tear-fixture";
const TOPIC = `arn:aws:sns:${REGION}:${POOL}:tear-inbound`;
const FEEDBACK = `arn:aws:sns:${REGION}:${POOL}:tear-feedback`;
// Matches SENDING_LIMITS.storedAttachmentBytes in api/src/sending.ts (100 GiB since commit 7643c5d3).
const UPLOAD_LIMIT = 100 * 1024 * 1024 * 1024;
const UPLOAD_SIZE = 3;

type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

const ROUTE_BOUND =
  "(SELECT count(DISTINCT a) FROM jsonb_array_elements_text(r.recipients||excluded.recipients) v(a))<=200";
function legacySql(q: unknown): unknown {
  const patch = (text: string) => {
    if (!text.includes("INSERT INTO mail_receipts AS r")) return text;
    if (!text.includes(ROUTE_BOUND)) {
      throw new Error("tear host: the route statement changed; update legacySql");
    }
    return text
      .replace(ROUTE_BOUND, "jsonb_array_length(r.recipients||excluded.recipients)<=200")
      .replace(/ ORDER BY g\.workspace_id(,s\.mid)?/g, "")
      .replace(/ ORDER BY workspace_id,ses_message_id/g, "");
  };
  if (typeof q === "string") return patch(q);
  if (q && typeof q === "object" && typeof (q as Json).text === "string") {
    return { ...(q as Json), text: patch((q as Json).text) };
  }
  return q;
}

async function makeClient() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  const pid = (await c.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
  const origQuery = c.query.bind(c) as (...a: unknown[]) => unknown;
  const counted = { n: 0, legacy: false };
  (c as Json).query = (...a: unknown[]) => {
    counted.n++;
    if (counted.legacy) a[0] = legacySql(a[0]);
    return origQuery(...a);
  };
  return { client: c, db: drizzle(c) as unknown as Db, pid, counted };
}

type ClientWrap = Awaited<ReturnType<typeof makeClient>>;
type Conn = ClientWrap & {
  name: string;
  open: boolean;
  pending?: Promise<void>;
  settled?: { ok: boolean; value: unknown };
};
type Slot = {
  db: ClientWrap;
  object?: string;
  put?: { resolve: () => void; reject: (e: Error) => void; reached: () => void };
  atPut?: Promise<void>;
  response?: Promise<unknown>;
};

const conns: Record<string, Conn> = {};
for (const name of ["W", "V", "X"]) conns[name] = { ...(await makeClient()), name, open: false };
const auto = await makeClient();
const checker = await makeClient();
await auto.client.query("SET lock_timeout='500ms'");

const slots: Record<string, Slot> = {};
for (const n of ["U1", "U2", "U3"]) slots[n] = { db: await makeClient() };

let tableSet: Set<string> | undefined;
async function getTables(): Promise<Set<string>> {
  if (!tableSet) {
    const res = await auto.client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema()",
    );
    tableSet = new Set(res.rows.map((r) => r.tablename as string));
  }
  return tableSet;
}

const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? "ERROR"}`;
const KEY_WS: Record<string, string> = { 1: "1", 2: "2", 3: "1" };

interface Trial {
  configured: boolean;
  bug?: string;
  cfg: AdmissionCfg | null;
  ws: string[];
  hours: number;
  minute: string;
  // recv
  hosts: string[];
  claims: Map<string, string>;
  fences: Map<string, string>;
  failedReceipts: Set<string>;
  // send
  keys: Record<string, string>;
  keyIds: Record<string, string>;
  emails: Record<string, string>;
  idemEmails: Map<string, string>;
  pendingIdemByConn: Map<string, [string, string]>;
  counter: number;
  // upload
  written: Map<string, number>;
  objectLabel: Map<string, string>;
  foreignKeys: Map<string, string>;
  attachments: Record<string, string>;
  today: number;
  // host-side collectors & temporal events
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

let activeTrial: Trial | null = null;

async function abortAll() {
  for (const slot of Object.values(slots)) {
    if (slot.response) {
      slot.put?.reject(new Error("tear host: reset"));
      await slot.response.catch(() => {});
      slot.response = undefined;
      slot.put = undefined;
    }
  }
  for (const c of Object.values(conns)) {
    if (c.pending && !c.settled) {
      await checker.client.query("SELECT pg_cancel_backend($1)", [c.pid]);
    }
  }
  for (const c of Object.values(conns)) {
    if (c.pending) await c.pending;
    if (c.open) await c.client.query("ROLLBACK");
    Object.assign(c, { open: false, pending: undefined, settled: undefined });
  }
}

async function realMinute(): Promise<string> {
  return (await checker.client.query("SELECT date_trunc('minute',now())::text m")).rows[0].m as string;
}

async function guardClock(t: Trial) {
  const ms = Date.now() % 60_000;
  const hourMs = Date.now() % 3_600_000;
  if (hourMs > 3_585_000) {
    await new Promise((r) => setTimeout(r, 3_600_000 - hourMs + 50));
  } else if (ms > 57_000) {
    await new Promise((r) => setTimeout(r, 60_000 - ms + 50));
  }
  t.minute = await realMinute();
}

async function checkClock(t: Trial) {
  if ((await realMinute()) !== t.minute) {
    throw new Error("tear host: the trace crossed a real minute boundary; rerun it");
  }
}

async function dropWorkspaces(t: Trial) {
  if (!t.ws.length) return;
  if (t.ws.some((w) => !/^tear_adm_[0-9a-f]{12}(_[ab])?$/.test(w))) {
    throw new Error("tear host: refusing to drop an unexpected workspace id");
  }
  const list = t.ws.map((w) => `'${w}'`).join(",");
  const tables = [
    "mail_receipts",
    "mail_receive_windows",
    "mail_receive_limits",
    "mail_ingest_turns",
    "jobs",
    "mailbox_domains",
    "mailbox_regions",
    "sending_emails",
    "sending_idempotency",
    "hosted_usage_hourly",
    "hosted_health_hourly",
    "api_request_budgets",
    "api_keys",
    "domain_sending_bindings",
    "domain_claims",
    "operation_domains",
    "sending_stream_depth",
    "job_schedule",
    "hosted_operator_audit",
    "account_notices",
    "ses_installation_settings",
    "operation_unsubscribe_tokens",
    "sending_upload_reservations",
    "sending_upload_tombstones",
    "sending_attachments",
    "sending_asset_usage",
    "provider_connections",
  ];
  const existing = await getTables();
  await auto.client.query(
    [
      "BEGIN",
      ...tables.filter((tb) => existing.has(tb)).map((tb) => `DELETE FROM ${tb} WHERE workspace_id IN (${list})`),
      `DELETE FROM mail_ignored_staging WHERE ses_message_id LIKE '${t.ws[0]}%'`,
      `DELETE FROM mail_receipt_holds WHERE ses_message_id LIKE '${t.ws[0]}%'`,
      `DELETE FROM workspaces WHERE id IN (${list})`,
      "COMMIT",
    ].join(";\n"),
  );
  t.ws = [];
}

// ---- Storage listing for upload profile ----

function makeListing(t: Trial) {
  return {
    put: async () => {},
    get: async () => null,
    delete: async (key: string) => {
      if (t.foreignKeys.has(key)) {
        t.pendingEvents.push({ name: "upload.foreign.deleted", data: { key } });
      }
      t.written.delete(key);
    },
    list: async (prefix: string, cursor?: string) => {
      const keys = [...t.written.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .filter((k) => !cursor || k > cursor)
        .slice(0, 1000);
      return {
        objects: keys.map((key) => ({
          key,
          uploaded: new Date(Date.now() - (t.today - t.written.get(key)!) * 86_400_000 - 60_000),
        })),
        cursor: keys.length === 1000 ? keys.at(-1) : undefined,
      };
    },
  };
}

// ---- Fixture resets per profile ----

async function requestApi(
  t: Trial,
  db: Db,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = new Request(`http://127.0.0.1:9${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.keys[key]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await app.fetch(req, { ...runtime, db } as Json);
  return { status: res.status, body: (await res.json()) as Json };
}

async function resetRecv(t: Trial, limits: [[number, number], [number, number]]) {
  const base = "tear_adm_" + hex(12);
  t.ws = [`${base}_a`, `${base}_b`];
  Object.assign(runtime.config, structuredClone(baseConfig), {
    workspaceId: t.ws[0],
    multiTenant: true,
  });
  t.hosts = t.ws.map((w) => `${w.replaceAll("_", "-")}.invalid`);
  t.claims.clear();
  t.fences.clear();
  t.failedReceipts.clear();
  const c = auto.client;
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,pool_tier,legacy_names,inbound_topic_arn,inbound_bucket,receiving_state)
    VALUES($1,$2,$3,'ready','trusted',false,$4,$5,'ready') ON CONFLICT(region) DO UPDATE SET inbound_topic_arn=excluded.inbound_topic_arn,inbound_bucket=excluded.inbound_bucket,receiving_state='ready'`,
    [REGION, POOL, FEEDBACK, TOPIC, BUCKET],
  );
  for (const [i, w] of t.ws.entries()) {
    const host = t.hosts[i]!;
    const limit = limits[i]!;
    await c.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [w]);
    await c.query(
      `INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`,
      [w, REGION, POOL],
    );
    await c.query(
      `INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state,receiving_state,receiving_host,receiving_proved_at,receiving_identity_at)
      VALUES($1,$2,$2,'verified','active',$1,now(),now())`,
      [host, w],
    );
    await c.query(
      "INSERT INTO operation_domains(id,name,workspace_id,region) VALUES($1,$2,$3,$4)",
      [`${w}_dom`, host, w, REGION],
    );
    await c.query(
      `INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all,receiving_host) VALUES($1,$2,$3,$4,$5,'active','store',$4)`,
      [`${w}_mdom`, w, `${w}_dom`, host, REGION],
    );
    await c.query(
      "INSERT INTO mail_receive_limits(workspace_id,message_limit,backlog_limit) VALUES($1,$2,$3)",
      [w, limit[0], limit[1]],
    );
  }
  await c.query("COMMIT");
}

const domainOf = (t: Trial, x: string) => `${t.ws[Number(x) - 1]!.replaceAll("_", "-")}.invalid`;

async function resetSend(t: Trial, caps: [number, number, number], headroom: number, rate: number) {
  const sponsor = "tear-sponsor-" + hex(8);
  t.ws = ["tear_adm_" + hex(12), "tear_adm_" + hex(12)];
  t.keys = {};
  t.keyIds = {};
  t.emails = {};
  t.idemEmails.clear();
  t.pendingIdemByConn.clear();
  t.counter = 0;
  Object.assign(runtime.config, structuredClone(baseConfig), {
    workspaceId: t.ws[0],
    multiTenant: true,
    liveEnabled: true,
    aws: { accessKeyId: "tear-fixture", secretAccessKey: "tear-fixture" },
    regionalSending: true,
    trustedPool: true,
    requireDmarcForBulk: true,
    apiRateLimitPerMinute: rate,
    hostedSendCaps: { firstWeek: caps[0] },
    dispatch: { ...baseConfig.dispatch, dailyHeadroomPercent: headroom },
  });
  const c = auto.client;
  await c.query("BEGIN");
  await c.query(
    "INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,pool_tier,legacy_names) VALUES($1,$2,$3,'ready','trusted',false) ON CONFLICT DO NOTHING",
    [REGION, POOL, FEEDBACK],
  );
  const identity = {
    dmarc: { status: "reject", checkedAt: Date.now() + 365 * 86_400_000 },
    ses: { DkimAttributes: { SigningEnabled: true, Status: "SUCCESS" } },
  };
  for (const [i, w] of t.ws.entries()) {
    const x = String(i + 1);
    const d = domainOf(t, x);
    await c.query("INSERT INTO workspaces(id,name,slug,quota_sponsor) VALUES($1,$1,$1,$2)", [w, sponsor]);
    await c.query(
      `INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state,created_at,pool_tenant_name) VALUES($1,$1,$2,'ready','shared',$3,'ready',now(),$4)`,
      [w, REGION, POOL, `bane-trusted-${w}`],
    );
    await c.query(
      `INSERT INTO provider_connection_regions(connection_id,region) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [w, REGION],
    );
    await c.query(
      `UPDATE provider_connection_regions SET sending_state='ready',tenant_state='ready',pool_tenant_name=$3 WHERE connection_id=$1 AND region=$2`,
      [w, REGION, `bane-trusted-${w}`],
    );
    await c.query(
      `INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state,identity) VALUES($1,$2,$2,'verified',$3)`,
      [d, w, JSON.stringify(identity)],
    );
    await c.query(
      "INSERT INTO operation_domains(id,name,workspace_id,region) VALUES($1,$2,$3,$4)",
      [`${w}_dom`, d, w, REGION],
    );
    await c.query(
      `INSERT INTO domain_sending_bindings(workspace_id,name,domain_id,connection_id,region) VALUES($1,$2,$3,$1,$4) ON CONFLICT DO NOTHING`,
      [w, d, `${w}_dom`, REGION],
    );
    await c.query(
      `INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) VALUES($1,$1,$2,jsonb_build_array($2::text))`,
      [w, REGION],
    );
  }
  for (const [k, x] of Object.entries(KEY_WS)) {
    const token = "bane_" + hex(64);
    t.keys[k] = token;
    t.keyIds[k] = `key${k}_${hex(12)}`;
    await c.query(
      `INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES($1,$2,'tear',$3,'bane_',$4,'[]')`,
      [t.keyIds[k], t.ws[Number(x) - 1], await digest(token), JSON.stringify(["read", "send"])],
    );
  }
  await c.query("COMMIT");
  for (const x of Object.keys(KEY_WS)) {
    const r = await requestApi(t, auto.db, "GET", "/v1/me", x);
    if (r.status !== 200) {
      throw new Error(`tear host: fixture key ${x} is not usable: ${JSON.stringify(r.body)}`);
    }
  }
  await c.query("DELETE FROM api_request_budgets WHERE workspace_id=ANY($1)", [t.ws]);
}

async function resetUpload(t: Trial, room: number) {
  const w = "tear_adm_" + hex(12);
  t.ws = [w];
  Object.assign(runtime.config, structuredClone(baseConfig), { workspaceId: w, multiTenant: false });
  t.written.clear();
  t.objectLabel.clear();
  t.foreignKeys.clear();
  t.attachments = {};
  t.today = 0;
  t.counter = 0;
  const c = auto.client;
  const token = "bane_" + hex(64);
  t.keys["1"] = token;
  t.keyIds["1"] = `key1_${hex(12)}`;
  await c.query("BEGIN");
  await c.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [w]);
  await c.query(
    `INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES($1,$2,'tear',$3,'bane_',$4,'[]')`,
    [t.keyIds["1"], w, await digest(token), JSON.stringify(["read", "send"])],
  );
  await c.query(
    `INSERT INTO sending_upload_reservations(id,workspace_id,storage_key,size,expires_at) VALUES($1,$2,'tear-seed',$3,now()+interval '100 years')`,
    [`${w}_seed`, w, UPLOAD_LIMIT - room * UPLOAD_SIZE],
  );
  await c.query("COMMIT");
}

async function configureTrial(t: Trial, cfg: AdmissionCfg): Promise<AdmissionObs> {
  await abortAll();
  await assertDisposable((text) => checker.client.query(text));
  await dropWorkspaces(t);
  t.cfg = cfg;
  t.hours = 0;
  t.configured = true;
  await guardClock(t);
  try {
    if (cfg.profile === "recv") await resetRecv(t, cfg.limits);
    else if (cfg.profile === "send") await resetSend(t, cfg.caps, cfg.headroom, cfg.rate);
    else await resetUpload(t, cfg.room);
  } catch (e) {
    await auto.client.query("ROLLBACK").catch(() => {});
    throw e;
  }
  const v = await readView(t);
  return { r: "ok", woke: {}, view: v };
}

// ---- Recv helpers ----

const sesId = (t: Trial, m: string) => `${t.ws[0]}_${m}`;
const wsOf = (t: Trial, x: string) => t.ws[x === "A" ? 0 : 1]!;
const recipientsOf = (t: Trial, r: string): string[] => {
  if (r === "0") return [];
  if (r === "h" || r === "x") {
    return Array.from({ length: r === "h" ? 100 : 101 }, (_, i) => `h${String(i + 1).padStart(3, "0")}@${t.hosts[0]}`);
  }
  return [...r].map((ch) => `${ch}@${t.hosts[ch === "b" ? 1 : 0]}`).sort();
};

function notification(t: Trial, m: string, r: string) {
  const id = sesId(t, m);
  const to = recipientsOf(t, r);
  return {
    notificationType: "Received",
    mail: { messageId: id, timestamp: new Date().toISOString(), source: "sender@example.invalid", destination: to },
    receipt: {
      timestamp: new Date().toISOString(),
      recipients: to,
      action: { type: "S3", bucketName: BUCKET, objectKey: `staging/${id}`, topicArn: TOPIC },
    },
  };
}

const acceptFn = (t: Trial, c: ClientWrap, m: string, r: string, legacy = false) => async () => {
  c.counted.legacy = legacy;
  try {
    return {
      queued: await acceptInboundNotification({ ...runtime, db: c.db } as Json, {
        topicArn: TOPIC,
        region: REGION,
        message: notification(t, m, r),
      }),
    };
  } finally {
    c.counted.legacy = false;
  }
};

// ---- Send helpers ----

const mailBody = (t: Trial, x: string, n: number, kind: string, i = 0) => ({
  from: `sender@${domainOf(t, x)}`,
  to: Array.from({ length: n }, (_, k) => `r${k}-${i}@example.net`),
  subject: "Synthetic admission",
  text: "No SES send happens here.",
  kind,
});

function recordCommittedIdem(t: Trial, ik: string, emailId: string) {
  const prev = t.idemEmails.get(ik);
  if (prev === undefined) {
    t.idemEmails.set(ik, emailId);
    t.pendingEvents.push({ name: "send.idem.admitted", data: { idemKey: ik, emailId } });
    if (t.bug === "canary_idem_duplicate") {
      t.pendingEvents.push({ name: "send.idem.duplicate", data: { idemKey: ik, emailId: "canary-dup" } });
    }
  } else if (prev !== emailId) {
    t.pendingEvents.push({ name: "send.idem.duplicate", data: { idemKey: ik, emailId } });
  }
}

function sendStatement(t: Trial, words: string[], c: ClientWrap, connName?: string): () => Promise<unknown> {
  const [verb, k, a, b] = words as [string, string, string, string];
  const x = KEY_WS[k]!;
  return async () => {
    const before = c.counted.n;
    let r;
    if (verb === "send") {
      r = await requestApi(t, c.db, "POST", "/v1/emails/send", k, mailBody(t, x, Number(a), b === "m" ? "marketing" : "transactional", t.counter++));
    } else if (verb === "batch") {
      r = await requestApi(t, c.db, "POST", "/v1/emails/batch", k, {
        emails: [mailBody(t, x, 1, "transactional", t.counter++), mailBody(t, x, 1, "transactional", t.counter++)],
      });
    } else if (verb === "idem") {
      r = await requestApi(t, c.db, "POST", "/v1/emails/send", k, { ...mailBody(t, x, 1, "transactional", 0), subject: `Keyed ${a}` }, { "Idempotency-Key": `${t.ws[0]}-${a}` });
    } else if (verb === "idem-other") {
      r = await requestApi(t, c.db, "POST", "/v1/emails/send", k, { ...mailBody(t, x, 1, "transactional", 9), subject: `Other ${a}` }, { "Idempotency-Key": `${t.ws[0]}-${a}` });
    } else {
      throw new Error(`unknown send verb ${verb}`);
    }
    const statements = c.counted.n - before;
    if (r.status === 202) {
      const ids: string[] = r.body.data ? r.body.data.map((e: Json) => e.id) : [r.body.id];
      const labels: string[] = [];
      for (const id of ids) {
        let label = Object.keys(t.emails).find((key) => t.emails[key] === id);
        if (!label) {
          label = `e${Object.keys(t.emails).length + 1}`;
          t.emails[label] = id;
        }
        labels.push(label);
      }
      if (verb === "idem" || verb === "idem-other") {
        const ik = `${k}:${a}`;
        if (connName) t.pendingIdemByConn.set(connName, [ik, ids[0]!]);
        else recordCommittedIdem(t, ik, ids[0]!);
      }
      return { ok: labels, statements };
    }
    return { error: `${r.status}:${r.body?.error?.code ?? "?"}`, statements };
  };
}

async function operatorStmt(t: Trial, words: string[], c: ClientWrap): Promise<unknown> {
  const [verb, x, v, p] = words as [string, string, string, string];
  const w = t.ws[Number(x) - 1]!;
  switch (verb) {
    case "limits":
      await setHostedLimits(c.client, [w, "--send-cap", v, "--pending-cap", p, "--reason", "tear fixture limits"]);
      return "ok";
    case "exempt":
      await setWorkspaceExemption(c.client, [w, v, "--reason", "tear fixture exemption"]);
      return "ok";
    case "pause":
      return (
        await c.db.execute(
          pauseHostedSending(
            sql`SELECT ${w}::text AS id,(SELECT resumed_at FROM provider_connections WHERE id=${w}) AS resumed_at,'tear fixture hold'::text AS reason,'all'::text AS scope,0 AS sends,0 AS bounces,0 AS complaints,0 AS rejected,0 AS screened`,
          ),
        )
      ).rowCount
        ? "ok"
        : "noop";
    case "resume":
      return (
        await c.db.execute(
          resumeHostedSending(w, { reason: "tear fixture resume", percent: 100, caps: { firstWeek: 100 } }),
        )
      ).rowCount
        ? "ok"
        : "noop";
  }
  throw new Error(`unknown operator verb ${verb}`);
}

// ---- Upload helpers ----

function slotRuntime(t: Trial, name: string) {
  const slot = slots[name]!;
  const storage = {
    put: (key: string) =>
      new Promise<void>((resolve, reject) => {
        t.objectLabel.set(key, `o${t.objectLabel.size + 1}`);
        slot.object = t.objectLabel.get(key);
        slot.put!.reached();
        slot.put = {
          ...slot.put!,
          resolve: () => {
            t.written.set(key, t.today);
            resolve();
          },
          reject,
        };
      }),
    get: async () => null,
    delete: async () => {},
  };
  return { ...runtime, db: slot.db.db, storage } as Json;
}

const uploadBody = (t: Trial, key?: string, other = false) => ({
  filename: key ? `keyed-${key}${other ? "-other" : ""}.txt` : `upload-${t.counter++}.txt`,
  contentType: "text/plain",
  content: Buffer.from(other ? "xyz" : "abc").toString("base64"),
});

async function uploadResult(t: Trial, r: Promise<unknown>) {
  const res = (await r) as Response;
  const body = (await res.json()) as Json;
  if (res.status !== 201) return `${res.status}:${body?.error?.code ?? "?"}`;
  let label = Object.keys(t.attachments).find((k) => t.attachments[k] === body.id);
  if (!label) {
    label = `a${Object.keys(t.attachments).length + 1}`;
    t.attachments[label] = body.id;
  }
  return label;
}

async function doUpload(t: Trial, name: string, key?: string, other = false) {
  const slot = slots[name]!;
  let reached!: () => void;
  slot.atPut = new Promise<void>((r) => {
    reached = r;
  });
  slot.put = { resolve: () => {}, reject: () => {}, reached };
  const req = new Request("http://127.0.0.1:9/v1/attachments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${t.keys["1"]}`,
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": `${t.ws[0]}-${key}` } : {}),
    },
    body: JSON.stringify(uploadBody(t, key, other)),
  });
  slot.response = Promise.resolve(app.fetch(req, slotRuntime(t, name)));
  const first = await Promise.race([slot.atPut.then(() => "at-put"), slot.response.then(() => "done")]);
  if (first === "at-put") return "at-put";
  const r = await uploadResult(t, slot.response);
  slot.response = undefined;
  slot.put = undefined;
  return r;
}

function doCrash(t: Trial, name: string) {
  const slot = slots[name]!;
  if (!slot.response || !slot.put) throw new Error(`tear host: ${name} is not at its put`);
  for (const key of t.objectLabel.keys()) {
    if (!t.written.has(key) && t.objectLabel.get(key) === slot.object) t.written.set(key, t.today);
  }
  slot.response = undefined;
  slot.put = undefined;
  return "crashed";
}

async function doResolvePut(t: Trial, name: string, ok: boolean) {
  const slot = slots[name]!;
  if (!slot.response || !slot.put) throw new Error(`tear host: ${name} is not at its put`);
  if (ok) slot.put.resolve();
  else slot.put.reject(Object.assign(new Error("R2 put failed (tear fixture)"), { name: "InternalError" }));
  const r = await uploadResult(t, slot.response);
  slot.response = undefined;
  slot.put = undefined;
  return r;
}

// ---- Transaction helpers ----

async function settle(c: Conn): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    if (c.settled) {
      const s = c.settled;
      c.pending = c.settled = undefined;
      return s.ok ? s.value : errOf(s.value);
    }
    const own = [...Object.values(conns).map((x) => x.pid), auto.pid];
    const w = (
      await checker.client.query(
        "SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked,pg_blocking_pids($1) AS by FROM pg_stat_activity WHERE pid=$1",
        [c.pid, own],
      )
    ).rows[0];
    if (w?.blocked && !c.settled) return "blocked";
    if (Date.now() - start > 10_000) return "stuck";
  }
}

async function runHeld(c: Conn, fn: () => Promise<unknown>) {
  await c.client.query("BEGIN");
  c.open = true;
  c.settled = undefined;
  c.pending = fn().then(
    (value) => {
      c.settled = { ok: true, value };
    },
    (value) => {
      c.settled = { ok: false, value };
    },
  );
  return settle(c);
}

async function finishHeld(t: Trial, c: Conn, commit: boolean) {
  let r: unknown = "ok";
  try {
    await c.client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    r = errOf(e);
  }
  c.open = false;
  const pending = t.pendingIdemByConn.get(c.name);
  t.pendingIdemByConn.delete(c.name);
  if (commit && r === "ok" && pending) {
    recordCommittedIdem(t, pending[0], pending[1]);
  }
  const woke: Record<string, unknown> = {};
  for (const name of Object.keys(conns).sort()) {
    const other = conns[name]!;
    if (other.pending) {
      const v = await settle(other);
      if (v !== "blocked") woke[other.name] = v;
    }
  }
  return { r, woke };
}

async function autoTxn<T>(fn: () => Promise<T>): Promise<unknown> {
  await auto.client.query("BEGIN");
  try {
    const v = await fn();
    await auto.client.query("COMMIT");
    return v;
  } catch (e) {
    await auto.client.query("ROLLBACK");
    return errOf(e);
  }
}

function makeStatement(t: Trial, words: string[], c: ClientWrap, connName?: string): () => Promise<unknown> {
  const verb = words[0]!;
  if (verb === "accept" || verb === "legacy-accept") {
    return acceptFn(t, c, words[1]!, words[2]!, verb === "legacy-accept");
  }
  if (verb === "release") {
    return async () => (await c.client.query("SELECT release_receive_budget_holds(NULL) n")).rows[0].n;
  }
  if (verb === "replay") {
    return async () => recoverHeldReceipts({ ...runtime, db: c.db } as Json);
  }
  if (["send", "batch", "idem", "idem-other"].includes(verb)) return sendStatement(t, words, c, connName);
  if (["limits", "exempt", "pause", "resume"].includes(verb)) return () => operatorStmt(t, words, c);
  throw new Error(`unknown statement ${words.join(" ")}`);
}

async function shiftTime(t: Trial, interval: string, targets: [string, string][]) {
  await auto.client.query("BEGIN");
  try {
    await auto.client.query("ALTER TABLE sending_emails DISABLE TRIGGER hosted_adjust");
    for (const [table, column] of targets) {
      await auto.client.query(`UPDATE ${table} SET ${column}=${column}-$2::interval WHERE workspace_id=ANY($1)`, [
        t.ws,
        interval,
      ]);
    }
    await auto.client.query("ALTER TABLE sending_emails ENABLE TRIGGER hosted_adjust");
    await auto.client.query("COMMIT");
  } catch (e) {
    await auto.client.query("ROLLBACK");
    throw e;
  }
}

function actionToWords(a: AdmissionAction): [string | null, string[]] {
  switch (a.op) {
    case "Commit":
      return [a.conn, ["commit"]];
    case "Abort":
      return [a.conn, ["abort"]];
    case "Accept":
      return [a.conn ?? null, ["accept", a.msg, a.rcpts]];
    case "LegacyAccept":
      return [a.conn ?? null, ["legacy-accept", a.msg, a.rcpts]];
    case "Release":
      return [a.conn ?? null, ["release"]];
    case "Replay":
      return [a.conn ?? null, ["replay"]];
    case "Stash":
      return [null, ["stash", a.msg, a.rcpts]];
    case "Claim":
      return [null, ["claim", a.ws, a.msg]];
    case "Done":
      return [null, ["done", a.ws, a.msg]];
    case "Fail":
      return [null, ["fail", a.ws, a.msg]];
    case "Lose":
      return [null, ["lose", a.ws, a.msg]];
    case "LegacyFail":
      return [null, ["legacy-fail", a.ws, a.msg]];
    case "Recover":
      return [null, ["recover"]];
    case "Days":
      return [null, ["days"]];
    case "Hour":
      return [null, ["hour"]];
    case "Send":
      return [a.conn ?? null, ["send", String(a.key), String(a.count), a.kind]];
    case "Batch":
      return [a.conn ?? null, ["batch", String(a.key)]];
    case "Idem":
      return [a.conn ?? null, ["idem", String(a.key), a.idemKey]];
    case "IdemOther":
      return [a.conn ?? null, ["idem-other", String(a.key), a.idemKey]];
    case "Limits":
      return [
        a.conn ?? null,
        ["limits", String(a.ws), a.sendCap === null ? "default" : String(a.sendCap), a.pendCap === null ? "default" : String(a.pendCap)],
      ];
    case "Exempt":
      return [a.conn ?? null, ["exempt", String(a.ws), a.on ? "on" : "off"]];
    case "Pause":
      return [a.conn ?? null, ["pause", String(a.ws)]];
    case "Resume":
      return [a.conn ?? null, ["resume", String(a.ws)]];
    case "Me":
      return [null, ["me", String(a.key)]];
    case "Outcome":
      return [null, ["outcome", a.email, a.outcome]];
    case "History":
      return [null, ["history", String(a.ws), String(a.count)]];
    case "H23":
      return [null, ["h23"]];
    case "Minute":
      return [null, ["minute"]];
    case "Week":
      return [null, ["week"]];
    case "Upload":
      return [a.slot, a.idemKey ? [a.other ? "upload-other" : "upload", a.idemKey] : ["upload"]];
    case "PutOk":
      return [a.slot, ["ok"]];
    case "PutFail":
      return [a.slot, ["fail"]];
    case "PutCrash":
      return [a.slot, ["crash"]];
    case "Expire":
      return [null, ["expire"]];
    case "Sweep":
      return [null, ["sweep"]];
    case "Purge":
      return [null, ["purge"]];
    case "Day":
      return [null, ["day"]];
    case "Foreign":
      return [null, ["foreign"]];
    case "Delete":
      return [null, ["delete", a.attachment]];
    default:
      throw new Error(`unexpected action ${(a as AdmissionAction).op}`);
  }
}

async function autoAct(t: Trial, words: string[]): Promise<unknown> {
  const [verb, a, b] = words as [string, string, string];
  switch (verb) {
    case "accept":
    case "legacy-accept":
      return autoTxn(acceptFn(t, auto, a, b, verb === "legacy-accept"));
    case "claim":
      return autoTxn(async () => {
        const w = wsOf(t, a);
        const mid = sesId(t, b);
        const { rows } = await auto.client.query(
          `WITH j AS (SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
          UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '10 minutes' FROM j WHERE jobs.id=j.id
          RETURNING jobs.id,jobs.lease_until::text AS fence,(SELECT recipients FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id=$2) AS recipients`,
          [w, mid],
        );
        if (!rows[0]) return 0;
        t.claims.set(rows[0].id, JSON.stringify(rows[0].recipients));
        t.fences.set(rows[0].id, rows[0].fence);
        return 1;
      });
    case "fail":
    case "lose":
      return autoTxn(async () => {
        const w = wsOf(t, a);
        const mid = sesId(t, b);
        const job = (
          await auto.client.query(
            `SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='running' ORDER BY created_at,id LIMIT 1`,
            [w, mid],
          )
        ).rows[0];
        if (!job) return "e:no-running-job";
        const failed =
          verb === "fail"
            ? (
                await auto.client.query(
                  "UPDATE mail_receipts SET status='failed',error='MAILBOX_INGEST_FAILED',processed_at=now(),settled_by=$4 WHERE workspace_id=$1 AND ses_message_id=$2 AND status='pending' AND recipients=$3::jsonb",
                  [w, mid, t.claims.get(job.id), `${job.id}|${t.fences.get(job.id) ?? ""}`],
                )
              ).rowCount
            : 0;
        await auto.client.query(`UPDATE jobs SET status=$2 WHERE id=$1`, [
          job.id,
          verb === "fail" ? "failed" : "completed",
        ]);
        return failed;
      });
    case "legacy-fail":
      return autoTxn(async () => {
        const w = wsOf(t, a);
        const mid = sesId(t, b);
        const count = (
          await auto.client.query(
            `update "mail_receipts" set "status" = $1, "error" = $2, "processed_at" = $3 where ("mail_receipts"."workspace_id" = $4 and "mail_receipts"."ses_message_id" = $5 and "mail_receipts"."status" = $6)`,
            ["failed", "MAILBOX_INGEST_FAILED", new Date().toISOString(), w, mid, "pending"],
          )
        ).rowCount;
        if (count && count > 0) {
          t.pendingEvents.push({ name: "recv.legacy-fail.mutated", data: { receipt: `${a}:${b}` } });
        }
        return count;
      });
    case "recover": {
      await auto.client.query(
        "UPDATE mail_receipts SET last_recovered_at=now()-interval '31 minutes' WHERE workspace_id=ANY($1) AND status='pending'",
        [t.ws],
      );
      await recoverMailReceipts(runtime);
      return Number(
        (
          await auto.client.query(
            "SELECT count(*) n FROM mail_receipts WHERE workspace_id=ANY($1) AND last_recovered_at>now()-interval '1 minute'",
            [t.ws],
          )
        ).rows[0].n,
      );
    }
    case "stash": {
      const to = recipientsOf(t, b);
      const owners = Object.fromEntries(to.map((addr) => [addr, [wsOf(t, addr.includes(t.hosts[1]!) ? "B" : "A")]]));
      await auto.client.query(
        `INSERT INTO mail_receipt_holds(bucket,ses_message_id,region,topic_arn,binding_workspace,owners,recipients,notification,received_at,expires_at,next_check,status)
        VALUES($1,$2,$3,$4,NULL,$5,$6,'{}',now(),now()+interval '48 hours',now()-interval '1 second','held')
        ON CONFLICT(bucket,ses_message_id) DO UPDATE SET owners=excluded.owners,recipients=excluded.recipients,expires_at=excluded.expires_at,next_check=excluded.next_check,status='held',error=NULL`,
        [BUCKET, sesId(t, a), REGION, TOPIC, JSON.stringify(owners), JSON.stringify(to)],
      );
      return "ok";
    }
    case "replay":
    case "release":
    case "limits":
    case "exempt":
    case "pause":
    case "resume":
      return autoTxn(makeStatement(t, words, auto));
    case "done":
      return autoTxn(async () => {
        const w = wsOf(t, a);
        const mid = sesId(t, b);
        const job = (
          await auto.client.query(
            `SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='running' ORDER BY created_at,id LIMIT 1`,
            [w, mid],
          )
        ).rows[0];
        if (!job) return "e:no-running-job";
        const settled = (
          await auto.client.query(
            "UPDATE mail_receipts SET status='processed',processed_at=now() WHERE workspace_id=$1 AND ses_message_id=$2 AND status='pending' AND recipients=$3::jsonb",
            [w, mid, t.claims.get(job.id)],
          )
        ).rowCount;
        await auto.client.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
        return settled;
      });
    case "hour":
      t.hours++;
      await shiftTime(t, "1 hour", [
        ["mail_receive_windows", "window_at"],
        ["mail_receive_windows", "level_at"],
        ["mail_receipts", "budget_retry_at"],
        ["mail_receipts", "created_at"],
        ["hosted_usage_hourly", "hour"],
        ["sending_emails", "created_at"],
        ["api_request_budgets", "window_start"],
      ]);
      return "ok";
    case "days":
      await shiftTime(t, "70 hours", [["mail_receipts", "created_at"]]);
      return "ok";
    case "h23":
      t.hours += 23;
      await shiftTime(t, "23 hours", [
        ["hosted_usage_hourly", "hour"],
        ["sending_emails", "created_at"],
        ["api_request_budgets", "window_start"],
      ]);
      return "ok";
    case "minute":
      await shiftTime(t, "1 minute", [["api_request_budgets", "window_start"]]);
      return "ok";
    case "send":
    case "batch":
    case "idem":
    case "idem-other":
      return autoTxn(sendStatement(t, words, auto));
    case "week":
      await auto.client.query("UPDATE provider_connections SET created_at=created_at-interval '7 days' WHERE workspace_id=ANY($1)", [t.ws]);
      return "ok";
    case "history": {
      const w = t.ws[Number(a) - 1]!;
      await auto.client.query(
        `INSERT INTO hosted_health_hourly(workspace_id,epoch,hour,accepted,bounces,complaints)
        SELECT $1,coalesce(resumed_at,'-infinity'),date_trunc('hour',now())-interval '25 hours',$2,0,0 FROM provider_connections WHERE id=$1
        ON CONFLICT(workspace_id,epoch,hour) DO UPDATE SET accepted=hosted_health_hourly.accepted+excluded.accepted`,
        [w, Number(b)],
      );
      return "ok";
    }
    case "outcome":
      return autoTxn(async () => {
        const id = t.emails[a];
        if (!id) return "e:unknown";
        const set =
          b === "sent"
            ? "status='sent',provider_id='tear-'||id"
            : b === "suppressed"
              ? "status='suppressed'"
              : b === "rejected"
                ? "status='rejected'"
                : "status='canceled'";
        return (await auto.client.query(`UPDATE sending_emails SET ${set} WHERE id=$1 AND status='queued'`, [id])).rowCount;
      });
    case "day": {
      await auto.client.query(
        "UPDATE sending_upload_reservations SET expires_at=expires_at-interval '24 hours' WHERE workspace_id=$1 AND storage_key<>'tear-seed'",
        [t.ws[0]],
      );
      if ((await getTables()).has("sending_upload_tombstones")) {
        await auto.client.query(
          "UPDATE sending_upload_tombstones SET delete_after=delete_after-interval '24 hours' WHERE workspace_id=$1",
          [t.ws[0]],
        );
      }
      // Shift pending upload idempotency claims by 24h so crashed claims age past the 10m OUTCOME_UNKNOWN boundary.
      await auto.client.query(
        "UPDATE sending_idempotency SET created_at=created_at-interval '24 hours' WHERE workspace_id=$1 AND result IS NULL",
        [t.ws[0]],
      );
      t.today++;
      const listing = makeListing(t);
      await cleanup({ ...runtime, storage: listing } as Json, 5_000);
      await reconcileUploads({ ...runtime, storage: listing } as Json);
      return "ok";
    }
    case "foreign": {
      for (const k of [
        `k/attachments/msg_${hex(32)}.eml`,
        `a/${t.ws[0]}/msg_${hex(32)}/b1/att_1`,
        `${t.ws[0]}/templates/assets/tasset_${hex(32)}`,
      ]) {
        t.written.set(k, t.today);
        t.foreignKeys.set(k, `f${t.foreignKeys.size + 1}`);
      }
      return "ok";
    }
    case "expire":
      await auto.client.query(
        "UPDATE sending_upload_reservations SET expires_at=expires_at-interval '1 hour' WHERE workspace_id=$1 AND storage_key<>'tear-seed'",
        [t.ws[0]],
      );
      return "ok";
    case "sweep": {
      const listing = makeListing(t);
      await cleanup({ ...runtime, storage: listing } as Json, 5_000);
      await reconcileUploads({ ...runtime, storage: listing } as Json);
      return "ok";
    }
    case "purge": {
      const listing = makeListing(t);
      await drainJobs({ ...runtime, storage: listing } as Json, 50, 1, 10_000);
      return "ok";
    }
    case "delete": {
      const r = await requestApi(t, auto.db, "DELETE", `/v1/attachments/${t.attachments[a] ?? "missing"}`, "1");
      return r.status === 200 ? "ok" : `${r.status}:${r.body?.error?.code}`;
    }
    case "me": {
      const r = await requestApi(t, auto.db, "GET", "/v1/me", a);
      if (r.status !== 200) return `e:${r.status}:${r.body?.error?.code}`;
      const l = r.body.connection?.sendingLimit;
      return l ? { cap: l.cap, used: l.used } : null;
    }
  }
  throw new Error(`unknown action ${words.join(" ")}`);
}

// ---- Committed view & raw snapshot reading ----

const hourIndex = (t: Trial, offset: number | null) => (offset === null ? null : t.hours + Math.round(offset));

async function readView(t: Trial): Promise<unknown> {
  const cfg = t.cfg;
  if (!cfg) return null;
  if (cfg.profile === "recv") {
    const out: Json = {};
    for (const [i, w] of t.ws.entries()) {
      const x = i ? "B" : "A";
      const { rows: [v] } = await checker.client.query(
        `SELECT
          (SELECT jsonb_build_array(extract(epoch FROM window_at-date_trunc('hour',now()))/3600,messages) FROM mail_receive_windows WHERE workspace_id=$1) AS window,
          (SELECT coalesce(jsonb_object_agg(ses_message_id,jsonb_build_array(status,jsonb_array_length(recipients),floor(extract(epoch FROM budget_retry_at-date_trunc('hour',now()))/3600),budget_retry_at<=now(),error)),'{}') FROM mail_receipts WHERE workspace_id=$1) AS receipts,
          (SELECT active FROM mail_ingest_turns WHERE workspace_id=$1) AS active,
          (SELECT coalesce(jsonb_object_agg(m,n),'{}') FROM (SELECT payload->>'sesMessageId' m,jsonb_build_array(count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='running')) n
            FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND status IN ('pending','running') GROUP BY 1) j) AS jobs`,
        [w],
      );
      const label = (id: string) => id.slice(t.ws[0]!.length + 1);
      const win = v.window ? [hourIndex(t, v.window[0]), Number(v.window[1])] : null;
      const receipts: Record<string, unknown> = {};
      for (const k of Object.keys(v.receipts).sort()) {
        const [st, n, retry, due, e] = v.receipts[k];
        const m = label(k);
        receipts[m] = [st, n, hourIndex(t, retry), due, e];
        const rk = `${x}:${m}`;
        if (st === "failed" && !t.failedReceipts.has(rk)) {
          t.failedReceipts.add(rk);
          t.pendingEvents.push({ name: "recv.receipt.failed", data: { receipt: rk } });
        } else if (st === "pending" && t.failedReceipts.has(rk)) {
          t.pendingEvents.push({ name: "recv.receipt.reopened", data: { receipt: rk } });
        }
      }
      const jobs: Record<string, [number, number]> = {};
      for (const k of Object.keys(v.jobs).sort()) {
        jobs[label(k)] = v.jobs[k];
      }
      const active = Number(v.active ?? 0);
      out[x] = { window: win && win[0] === t.hours ? win[1] : 0, receipts, active, jobs };
    }
    out.stash = (
      await checker.client.query(
        "SELECT coalesce(jsonb_agg(substr(ses_message_id,length($1)+2) ORDER BY ses_message_id),'[]') s FROM mail_receipt_holds WHERE ses_message_id LIKE $1||'\\_%' AND status='held'",
        [t.ws[0]],
      )
    ).rows[0].s;
    return out;
  }

  if (cfg.profile === "upload") {
    const w = t.ws[0]!;
    const hasTombstones = (await getTables()).has("sending_upload_tombstones");
    const { rows: [v] } = await checker.client.query(
      `SELECT (SELECT bytes FROM sending_asset_usage WHERE workspace_id=$1) AS usage,
        (SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_reservations WHERE workspace_id=$1 AND storage_key<>'tear-seed') AS reserved,
        (SELECT coalesce(jsonb_agg(jsonb_build_array(id,storage_key)),'[]') FROM sending_attachments WHERE workspace_id=$1) AS stored,
        (SELECT coalesce(jsonb_agg(payload->>'key'),'[]') FROM jobs WHERE workspace_id=$1 AND type='maintenance.deleteAttachment' AND status IN ('pending','running')) AS deletes,
        ${hasTombstones ? "(SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_tombstones WHERE workspace_id=$1 AND storage_key<>'tear-seed')" : "'[]'::jsonb"} AS tombstones`,
      [w],
    );
    const usage = Number(v.usage ?? 0);
    const seed = UPLOAD_LIMIT - cfg.room * UPLOAD_SIZE;
    const byId = Object.fromEntries(Object.entries(t.attachments).map(([l, id]) => [id, l]));
    return {
      used: (usage - seed) / UPLOAD_SIZE,
      reservations: v.reserved.length,
      attachments: v.stored.map((x: Json) => byId[x[0]] ?? "?").sort(),
      deletes: new Set(v.deletes).size,
      tombstones: v.tombstones.length,
      objects: [...t.written.keys()].filter((k) => !t.foreignKeys.has(k)).length,
      foreign: [...t.foreignKeys.keys()].filter((k) => t.written.has(k)).length,
    };
  }

  // send
  const { rows: [v] } = await checker.client.query(
    `SELECT
      (SELECT coalesce(jsonb_object_agg(workspace_id,u),'{}') FROM (SELECT workspace_id,jsonb_object_agg(round(extract(epoch FROM hour-date_trunc('hour',now()))/3600)::int,recipients) u FROM hosted_usage_hourly WHERE workspace_id=ANY($1) AND recipients<>0 GROUP BY 1) h) AS usage,
      (SELECT coalesce(jsonb_object_agg(id,jsonb_build_array(status,jsonb_array_length(to_addresses||cc_addresses||bcc_addresses),workspace_id,snapshot->>'kind')),'{}') FROM sending_emails WHERE workspace_id=ANY($1)) AS emails,
      (SELECT coalesce(jsonb_object_agg(key_id,used),'{}') FROM api_request_budgets WHERE workspace_id=ANY($1) AND window_start=date_trunc('minute',now())) AS budgets,
      (SELECT coalesce(jsonb_object_agg(workspace_id,n),'{}') FROM (SELECT workspace_id,sum(n)::int n FROM sending_stream_depth WHERE workspace_id=ANY($1) GROUP BY 1) d) AS depth,
      (SELECT count(*)::int FROM sending_idempotency WHERE workspace_id=ANY($1)) AS idem`,
    [t.ws],
  );
  const wsLabel = (w: string) => String(t.ws.indexOf(w) + 1);
  const byLabel = Object.fromEntries(Object.entries(t.emails).map(([l, id]) => [id, l]));
  const mails = Object.fromEntries(
    Object.entries(v.emails)
      .map(([id, [s, n, w]]: Json) => [byLabel[id] ?? "?", [s, n, wsLabel(w)]])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const usage: Json = {};
  const depth: Json = {};
  const budgets: Json = {};
  for (const [w, u] of Object.entries(v.usage)) {
    usage[wsLabel(w)] = Object.fromEntries(
      Object.entries(u as Json).map(([k, n]) => [String(t.hours + Number(k)), Number(n)]),
    );
  }
  for (const [w, n] of Object.entries(v.depth)) if (n) depth[wsLabel(w)] = n;
  for (const [id, n] of Object.entries(v.budgets)) {
    budgets[Object.keys(t.keyIds).find((k) => t.keyIds[k] === id) ?? "?"] = n;
  }
  return { usage, mails, budgets, depth, idem: v.idem };
}

async function readSnapshot(t: Trial): Promise<Observed> {
  if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
  const events = t.pendingEvents;
  t.pendingEvents = [];

  if (!t.configured || !t.cfg) {
    const snap: AdmissionSnapshot = {
      configured: false,
      profile: null,
      leakedErrors: [...t.leakedErrors],
      recv: [],
      send: [],
      upload: null,
    };
    return { snapshot: snap, events };
  }

  const recv: RecvWsSnapshot[] = [];
  const send: SendWsSnapshot[] = [];
  let upload: UploadSnapshot | null = null;

  if (t.cfg.profile === "recv") {
    for (const [i, w] of t.ws.entries()) {
      const x = i ? "B" : "A";
      const [limit, backlog] = t.cfg.limits[i]!;
      const { rows: [v] } = await checker.client.query(
        `SELECT
          (SELECT jsonb_build_array(extract(epoch FROM window_at-date_trunc('hour',now()))/3600,messages) FROM mail_receive_windows WHERE workspace_id=$1) AS window,
          (SELECT active FROM mail_ingest_turns WHERE workspace_id=$1) AS active,
          (SELECT coalesce(jsonb_object_agg(m,n),'{}') FROM (SELECT payload->>'sesMessageId' m,count(*)::int n
            FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND status IN ('pending','running') GROUP BY 1) j) AS jobs`,
        [w],
      );
      const label = (id: string) => id.slice(t.ws[0]!.length + 1);
      const win = v.window ? [hourIndex(t, v.window[0]), Number(v.window[1])] : null;
      const jobsPerReceipt: Record<string, number> = {};
      let recount = 0;
      for (const [k, n] of Object.entries(v.jobs as Record<string, number>)) {
        jobsPerReceipt[label(k)] = Number(n);
        recount += Number(n);
      }
      recv.push({
        ws: x,
        limit,
        backlog,
        windowHourMatches: Boolean(win && win[0] === t.hours),
        windowCount: win ? win[1]! : 0,
        activeCounter: Number(v.active ?? 0),
        recountActiveJobs: recount,
        jobsPerReceipt,
      });
    }
  } else if (t.cfg.profile === "send") {
    for (const [i, w] of t.ws.entries()) {
      const { rows: [r] } = await checker.client.query(
        `SELECT
          coalesce((SELECT sum(recipients)::int FROM hosted_usage_hourly WHERE workspace_id=$1 AND hour>=date_trunc('hour',now())-interval '23 hours'),0) AS live,
          coalesce((SELECT sum(jsonb_array_length(to_addresses||cc_addresses||bcc_addresses))::int FROM sending_emails WHERE workspace_id=$1 AND hosted_charged(status,provider_id) AND created_at>=date_trunc('hour',now())-interval '23 hours'),0) AS charged`,
        [w],
      );
      send.push({
        ws: String(i + 1),
        liveUsage: Number(r.live),
        chargedRecipients: Number(r.charged),
      });
    }
  } else if (t.cfg.profile === "upload") {
    const w = t.ws[0]!;
    const hasTombstones = (await getTables()).has("sending_upload_tombstones");
    const { rows: [v] } = await checker.client.query(
      `SELECT
        coalesce((SELECT bytes FROM sending_asset_usage WHERE workspace_id=$1),0) AS usage,
        (SELECT coalesce(sum(size),0) FROM sending_upload_reservations WHERE workspace_id=$1) + (SELECT coalesce(sum(size),0) FROM sending_attachments WHERE workspace_id=$1) AS recount,
        (SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_reservations WHERE workspace_id=$1 AND storage_key<>'tear-seed') AS reserved,
        (SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_attachments WHERE workspace_id=$1) AS stored,
        (SELECT coalesce(jsonb_agg(payload->>'key'),'[]') FROM jobs WHERE workspace_id=$1 AND type='maintenance.deleteAttachment' AND status IN ('pending','running')) AS deletes,
        ${hasTombstones ? "(SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_tombstones WHERE workspace_id=$1 AND storage_key<>'tear-seed')" : "'[]'::jsonb"} AS tombstones`,
      [w],
    );
    const keysKept = new Set<string>([...v.reserved, ...v.stored, ...v.deletes, ...v.tombstones]);
    const deletedForeign: string[] = [];
    for (const [k, label] of t.foreignKeys) {
      if (!t.written.has(k)) deletedForeign.push(label);
    }
    const agedOrphans: string[] = [];
    for (const [k, day] of t.written) {
      if (!t.foreignKeys.has(k) && !keysKept.has(k) && t.today - day >= 1) {
        agedOrphans.push(t.objectLabel.get(k) ?? k);
      }
    }
    upload = {
      usageBytes: Number(v.usage),
      recountBytes: Number(v.recount),
      limitBytes: UPLOAD_LIMIT,
      deletedForeign,
      agedOrphans,
    };
  }

  const snap: AdmissionSnapshot = {
    configured: true,
    profile: t.cfg.profile,
    leakedErrors: [...t.leakedErrors],
    recv,
    send,
    upload,
  };
  return { snapshot: snap, events };
}

export const admissionHost = host(admission, {
  async open(req): Promise<Trial> {
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      cfg: null,
      ws: [],
      hours: 0,
      minute: "",
      hosts: [],
      claims: new Map(),
      fences: new Map(),
      failedReceipts: new Set(),
      keys: {},
      keyIds: {},
      emails: {},
      idemEmails: new Map(),
      pendingIdemByConn: new Map(),
      counter: 0,
      written: new Map(),
      objectLabel: new Map(),
      foreignKeys: new Map(),
      attachments: {},
      today: 0,
      leakedErrors: [],
      pendingEvents: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: AdmissionAction): Promise<AdmissionObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, ADMISSION_PRESETS[a.preset]);
    }
    if (!t.configured) throw new Error("admission host: action before Configure");
    await checkClock(t);
    const [target, words] = actionToWords(a);
    let r: unknown;
    let woke: Record<string, unknown> = {};
    if (target && slots[target]) {
      const [verb, key] = words as [string, string | undefined];
      if (verb === "upload") r = await doUpload(t, target, key, false);
      else if (verb === "upload-other") r = await doUpload(t, target, key, true);
      else if (verb === "crash") r = doCrash(t, target);
      else r = await doResolvePut(t, target, verb === "ok");
    } else if (target && conns[target]) {
      const c = conns[target]!;
      const verb = words[0]!;
      if (verb === "commit" || verb === "abort") {
        ({ r, woke } = await finishHeld(t, c, verb === "commit"));
      } else {
        r = await runHeld(c, makeStatement(t, words, c, c.name));
      }
    } else {
      r = await autoAct(t, words);
    }
    const view = await readView(t);
    return { r, woke, view };
  },

  async observe(t: Trial): Promise<Observed> {
    return await readSnapshot(t);
  },

  async close(t: Trial): Promise<void> {
    await abortAll().catch(() => {});
    await dropWorkspaces(t).catch(() => {});
    if (activeTrial === t) activeTrial = null;
  },
});
