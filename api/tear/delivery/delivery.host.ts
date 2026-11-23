import { createHash, randomUUID } from "node:crypto";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { delivery } from "./delivery.model.ts";
import {
  DELIVERY_PRESETS,
  epOfDelivery,
  type DeliveryAction,
  type DeliveryObs,
  type DeliveryPreset,
  type DeliveryRowView,
  type DeliverySnapshot,
  type DeliveryView,
  type EndpointName,
  type SendTuple,
  type WorkerName,
} from "./delivery.types.ts";

// Silence noisy app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) {
      process.stderr.write(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
    }
  };
}

// Pin backoff jitter to 1 (0.5 maps to 1.0x in ritual-retry.ts).
Math.random = () => 0.5;

const hex = (n: number) =>
  Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll("-", ""))
    .join("")
    .slice(0, n);

// Track unhandled rejections/exceptions as idle-rule violations instead of crashing the host.
let activeTrial: Trial | null = null;
const leak = (kind: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`host ${kind}: ${text}\n`);
  activeTrial?.leakedErrors.push(`${kind}:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
};
process.on("unhandledRejection", leak("unhandled-rejection"));
process.on("uncaughtException", leak("uncaught-exception"));

// Validate disposable database before connecting or writing anything.
const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const { default: pg } = await import("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");

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

const { S3Client } = await import("@aws-sdk/client-s3");
const [
  { createApp },
  { nodeRuntime },
  { acceptInboundNotification, mailboxIngestJobs },
  { mailboxEventJobs },
  { pruneMailboxEvents },
  { processJobs },
  { ensureRegionSettings },
  { forwardStopUrl },
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/adapters/node.ts"),
  import("../../src/mailbox-ingest.ts"),
  import("../../src/mailbox-events.ts"),
  import("../../src/maintenance.ts"),
  import("../../src/jobs.ts"),
  import("../../src/ses-region-state.ts"),
  import("../../src/endpoints.ts"),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ENCRYPTION = hex(64);
const REGION = "us-east-1";
const BUCKET = "tear-fixture";
const TOPIC = `arn:aws:sns:${REGION}:111122223333:tear-inbound`;

const instance = nodeRuntime({
  DATABASE_URL,
  BANE_ROOT_SECRET: hex(64),
  ENCRYPTION_KEY: ENCRYPTION,
  ACCOUNT_CLIENT_ID: "tear-fixture",
  ACCOUNT_CLIENT_PRIVATE_KEY: "tear-fixture",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  PUBLIC_URL: "http://127.0.0.1:9",
  ENABLE_LIVE_SES: "false",
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  AWS_EC2_METADATA_DISABLED: "true",
  DEFAULT_SES_REGION: REGION,
  SIMULATED_SES_LATENCY_MS: "0",
});
const runtime = instance.runtime;
runtime.config.aws = { accessKeyId: "tear-synthetic", secretAccessKey: "tear-synthetic" } as Json;
const app = createApp();

// ---------- synthetic S3: raw MIME per staging key ----------
const raw = new Map<string, Buffer>();
(S3Client.prototype as Json).send = async (cmd: Json) => {
  const i = cmd.input;
  const name = cmd.constructor.name;
  const key = String(i.Key ?? i.CopySource ?? "");
  const mid = key.split("/").at(-1)!;
  switch (name) {
    case "HeadObjectCommand": {
      const b = raw.get(mid);
      if (!b) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { ContentLength: b.length, ETag: '"tear"' };
    }
    case "GetObjectCommand": {
      const b = raw.get(mid);
      if (!b) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        Body: {
          transformToByteArray: async () => b,
          transformToString: async () => b.toString(),
        },
      };
    }
    default:
      return {};
  }
};

// ---------- warm workers: own pool, own transport, crash = every later statement hangs ----------
const hang = () => new Promise<never>(() => {});
const textOf = (queryArg: unknown) =>
  typeof queryArg === "string" ? queryArg : ((queryArg as { text?: string })?.text ?? "");

type SendRec = { ep: string; key: string | null; delivery: string | null; body: Json };

interface Worker {
  name: WorkerName;
  app: string;
  target: string | null;
  pool: InstanceType<typeof pg.Pool>;
  dead: boolean;
  gate: boolean;
  claimed: boolean;
  parked: (() => void) | null;
  inflight: { send: SendRec; resolve: (v: Json) => void; reject: (e: unknown) => void } | null;
  task: Promise<void> | null;
  done: boolean;
  error: unknown;
  wake: (() => void) | null;
}

const workers: Record<WorkerName, Worker> = {} as Record<WorkerName, Worker>;
let poolGeneration = 0;

function makePool(w: Worker): InstanceType<typeof pg.Pool> {
  w.app = `tear-dlv-${process.pid}-${w.name}-${++poolGeneration}`;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: w.app });
  pool.on("error", () => {});
  const gateFor = async (text: string) => {
    if (w.dead) return hang();
    // The claim is one statement; park before the handler's first statement after it.
    if (w.gate && w.claimed) {
      w.gate = false;
      await new Promise<void>((resolve) => {
        w.parked = resolve;
        w.wake?.();
      });
      if (w.dead) return hang();
    }
    if (/^\s*WITH RECURSIVE/.test(text)) w.claimed = true;
  };
  const origQuery = pool.query.bind(pool);
  (pool as Json).query = (...args: Json[]) => {
    if (typeof args.at(-1) === "function") return (origQuery as Json)(...args);
    return (async () => {
      await gateFor(textOf(args[0]));
      return (origQuery as Json)(...args);
    })();
  };
  const origConnect = pool.connect.bind(pool);
  (pool as Json).connect = async (...args: Json[]) => {
    if (typeof args[0] === "function") return (origConnect as Json)(...args);
    if (w.dead) return hang();
    const client = await origConnect();
    if (!(client as Json).__tearErrBound) {
      (client as Json).__tearErrBound = true;
      client.on("error", () => {});
    }
    const cq = ((client as Json).__tearQuery ??= client.query.bind(client));
    (client as Json).query = (...qa: Json[]) => {
      if (typeof qa.at(-1) === "function") return cq(...qa);
      return (async () => {
        await gateFor(textOf(qa[0]));
        return cq(...qa);
      })();
    };
    return client;
  };
  return pool;
}

function makeWorker(name: WorkerName): Worker {
  const w: Worker = {
    name,
    app: "",
    target: null,
    pool: null as unknown as InstanceType<typeof pg.Pool>,
    dead: false,
    gate: false,
    claimed: false,
    parked: null,
    inflight: null,
    task: null,
    done: false,
    error: null,
    wake: null,
  };
  w.pool = makePool(w);
  return w;
}

workers.K = makeWorker("K");
workers.L = makeWorker("L");

const checker = new pg.Client({ connectionString: DATABASE_URL });
await checker.connect();
const q = (text: string, params: unknown[] = []) => checker.query(text, params);

async function retire(w: Worker): Promise<void> {
  await q(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1",
    [w.app],
  );
  void w.pool.end().catch(() => {});
  workers[w.name] = makeWorker(w.name);
}

async function resetWorkers(): Promise<void> {
  for (const name of ["K", "L"] as const) {
    const w = workers[name];
    if (w.dead || w.inflight || w.parked || (w.task && !w.done)) {
      w.dead = true;
      w.parked?.();
      w.inflight?.reject(new Error("reset"));
      await retire(w);
    }
  }
  for (const name of ["K", "L"] as const) {
    Object.assign(workers[name], {
      target: null,
      gate: false,
      claimed: false,
      parked: null,
      inflight: null,
      task: null,
      done: false,
      error: null,
      wake: null,
    });
  }
}

// ---------- per-trial state ----------
interface Trial {
  configured: boolean;
  bug?: string;
  ws: string;
  hostName: string;
  key: string;
  retries: number;
  ids: Record<string, string>;
  epOf: Record<string, string>;
  deliveryIds: Record<string, string>;
  delays: Record<string, number | "d">;
  sends: SendRec[];
  // Factual collectors for idle rules & declarative temporal properties
  sendCounts: Record<string, number>;
  activeFlights: Map<WorkerName, { d: string; ep: string }>;
  prevEndpoints: Record<string, [boolean, boolean]>;
  seenDeliveries: Map<string, { ep: string; lastStatus: string }>;
  lostDeliveries: string[];
  duplicateDeliveries: string[];
  drainCount: number;
  unsettledAfterDrain: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

const URLS: Record<string, string> = {
  W: "https://w.example.com/hook",
  V: "https://v.example.com/hook",
  U: "https://u.example.com/hook",
};

const RITUALS_SRC: Record<string, string> = {
  slack: "export default function route(email){endpoints.s({text:email.subject})}",
  forward: "export default function route(email){endpoints.f()}",
  both: "export default function route(email){endpoints.s({text:email.subject});endpoints.f()}",
  four: 'export default function route(email){endpoints.s({text:"n0"});endpoints.s({text:"n1"});endpoints.s({text:"n2"});endpoints.s({text:"n3"})}',
  // 32 intents is the per-run action budget: one call and 31 labels run; one more label fails the ritual.
  max: `export default function route(email){endpoints.s({text:"max"});${'label("l");'.repeat(31)}}`,
  over: `export default function route(email){endpoints.s({text:"over"});${'label("l");'.repeat(32)}}`,
};

const RCPT: Record<string, string> = { a: "a", x: "x-1", z: "z", b: "box" };

const errOf = (e: Json) => `e:${e?.code ?? e?.cause?.code ?? e?.name ?? "ERROR"}`;
const midOf = (t: Trial, m: string) => `${t.ws}_${m}`;

function emitEvent(t: Trial, name: string, data: unknown): void {
  t.pendingEvents.push({ name, data });
}

async function rest(t: Trial, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${t.key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://127.0.0.1:9${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    runtime,
  );
  const json = (await res.json().catch(() => null)) as Json;
  if (res.status >= 300) return { error: `e:${json?.error?.code ?? res.status}`, status: res.status, json };
  return { body: json, status: res.status };
}

async function must(t: Trial, method: string, path: string, body?: unknown) {
  const r = await rest(t, method, path, body);
  if (r.error) throw new Error(`${method} ${path}: ${r.error} ${JSON.stringify(r.json)}`);
  return r.body;
}

async function cleanupWorkspace(ws: string): Promise<void> {
  if (!ws) return;
  await q("DELETE FROM jobs WHERE workspace_id=$1", [ws]);
  await q("DELETE FROM mailbox_webhooks WHERE workspace_id=$1", [ws]);
}

function buildMime(t: Trial, label: string, variant: string): Buffer {
  const m = label.startsWith("d") ? "m" + label.slice(1) : label;
  const extra =
    variant === "loop"
      ? "X-Bane-Loop: v1.1.synthetic\r\n"
      : variant === "auto"
        ? "Auto-Submitted: auto-replied\r\n"
        : variant.startsWith("recv")
          ? Array.from(
              { length: Number(variant.slice(4)) },
              (_, i) => `Received: from relay${i}.example.org by mx.example.org; Wed, 11 Nov 2026 00:00:00 +0000\r\n`,
            ).join("")
          : "";
  return Buffer.from(
    `${extra}From: Sender <sender@example.org>\r\nTo: team@${t.hostName}\r\nSubject: Synthetic ${m}\r\nMessage-ID: <${m}.${t.ws}@example.org>\r\nDate: Wed, 11 Nov 2026 00:00:00 +0000\r\n\r\nHello ${m}`,
  );
}

async function settleJobs(t: Trial): Promise<void> {
  const rows = (
    await q(
      "UPDATE jobs j SET available_at='infinity' FROM (SELECT id,available_at,payload,last_error FROM jobs WHERE workspace_id=$1 AND status='pending' AND available_at<>'infinity' FOR UPDATE) o WHERE j.id=o.id RETURNING o.payload->>'deliveryId' AS d,o.last_error AS e,extract(epoch FROM o.available_at-now())*1000 AS ms",
      [t.ws],
    )
  ).rows;
  for (const r of rows) {
    const ms = Number(r.ms);
    t.delays[r.d] = ms <= 1000 ? 0 : r.e === null ? "d" : Math.round(ms / 1000);
  }
}

async function readView(t: Trial, wasPrune: boolean): Promise<DeliveryView> {
  const { rows } = await q(
    `SELECT d.id,d.webhook_id,d.status,d.attempt_count,d.last_error,d.generation,d.payload->>'messageId' AS message,d.payload->>'ritualAction' AS action,m.ses_message_id AS ses,
        a.state AS fence,(SELECT jsonb_build_object('status',j.status,'attempts',j.attempts) FROM jobs j WHERE j.workspace_id=d.workspace_id AND j.type='mailbox.webhook' AND j.payload->>'deliveryId'=d.id ORDER BY j.created_at DESC LIMIT 1) AS job
      FROM mailbox_webhook_deliveries d LEFT JOIN mail_messages m ON m.id=d.payload->>'messageId' LEFT JOIN mail_action_attempts a ON a.delivery_id=d.id WHERE d.workspace_id=$1 ORDER BY d.created_at,d.id`,
    [t.ws],
  );
  const deliveries: Record<string, DeliveryRowView> = {};
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const m = String(row.ses ?? "").slice(t.ws.length + 1) || "?";
    const ep = t.epOf[row.webhook_id] ?? "?";
    const index = row.action ? Number(String(row.action).split(":")[4]) : 0;
    const base = `${m}:${ep}${ep === "S" && index > 0 ? index : ""}`;
    const n = (counts[base] = (counts[base] ?? 0) + 1);
    const label = n > 1 ? `${base}#${n}` : base;
    if (n > 1 && !t.duplicateDeliveries.includes(label)) {
      t.duplicateDeliveries.push(label);
    }
    t.deliveryIds[label] = row.id;
    const job: [string, number] | null = row.job ? [row.job.status, row.job.attempts] : null;
    deliveries[label] = [row.status, row.attempt_count, row.last_error, row.fence, job, t.delays[row.id] ?? null];
  }
  const endpoints = (
    await q("SELECT h.id,h.paused,h.declined_at IS NOT NULL AS declined FROM mailbox_webhooks h WHERE h.workspace_id=$1", [
      t.ws,
    ])
  ).rows;
  const eMap: Record<string, [boolean, boolean]> = Object.fromEntries(
    endpoints.map((e) => [t.epOf[e.id] ?? e.id, [Boolean(e.paused), Boolean(e.declined)]]),
  );

  // Emit factual endpoint state transition events for declarative temporal rule endpoint.held.
  for (const ep of Object.keys(t.prevEndpoints)) {
    if (!(ep in eMap)) {
      emitEvent(t, "endpoint.deleted", { ep });
    }
  }
  for (const [ep, [paused]] of Object.entries(eMap)) {
    const prev = t.prevEndpoints[ep];
    if (prev && !prev[0] && paused) {
      emitEvent(t, "endpoint.paused", { ep });
    } else if (prev && prev[0] && !paused) {
      emitEvent(t, "endpoint.unpaused", { ep });
    }
  }
  t.prevEndpoints = eMap;

  // Track delivery.kept factually over observed DB rows.
  for (const [label, info] of [...t.seenDeliveries.entries()]) {
    if (!(label in deliveries)) {
      const epDeleted = !(info.ep in eMap);
      const settledPruned = wasPrune && (info.lastStatus === "delivered" || info.lastStatus === "failed");
      if (epDeleted || settledPruned) {
        t.seenDeliveries.delete(label);
      } else {
        const msg = `${label} disappeared (lastStatus=${info.lastStatus})`;
        if (!t.lostDeliveries.includes(msg)) t.lostDeliveries.push(msg);
        t.seenDeliveries.delete(label);
      }
    }
  }
  for (const [label, row] of Object.entries(deliveries)) {
    t.seenDeliveries.set(label, { ep: epOfDelivery(label), lastStatus: row[0] });
  }

  const forwards = (
    await q(
      "SELECT f.message_id,f.endpoint,m.ses_message_id AS ses FROM mail_forward_once f JOIN mail_messages m ON m.id=f.message_id WHERE f.workspace_id=$1",
      [t.ws],
    )
  ).rows
    .map((r) => String(r.ses).slice(t.ws.length + 1))
    .sort();
  const sent = (
    await q(
      `SELECT count(*)::int AS n FROM sending_emails WHERE workspace_id=$1 AND to_addresses @> '["team@example.net"]'`,
      [t.ws],
    ).catch(() => ({ rows: [{ n: -1 }] }))
  ).rows[0].n;
  const box = (
    await q(
      "SELECT m.ses_message_id AS ses,l.labels FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=$1 AND l.direction='inbound'",
      [`${t.ws}_box`],
    )
  ).rows;
  const bMap: Record<string, string[]> = {};
  for (const r of box) {
    bMap[String(r.ses).slice(t.ws.length + 1)] = [...r.labels].sort();
  }
  return { b: bMap, d: deliveries, e: eMap, f: forwards, fs: sent };
}

async function configureTrial(t: Trial, preset: DeliveryPreset): Promise<DeliveryObs> {
  const cfg = DELIVERY_PRESETS[preset];
  await resetWorkers();
  await assertDisposable((text) => q(text));
  if (t.ws) await cleanupWorkspace(t.ws);

  t.configured = true;
  t.ws = "tear_dlv_" + hex(12);
  t.retries = cfg.retries;
  t.sends = [];
  t.deliveryIds = {};
  t.delays = {};
  t.sendCounts = {};
  t.activeFlights.clear();
  t.prevEndpoints = {};
  t.seenDeliveries.clear();
  t.lostDeliveries = [];
  t.duplicateDeliveries = [];
  t.drainCount = 0;
  t.unsettledAfterDrain = [];
  t.leakedErrors = [];
  t.pendingEvents = [];
  raw.clear();

  runtime.config.workspaceId = t.ws;
  t.hostName = `${t.ws.replaceAll("_", "-")}.example.org`;
  const domain = `${t.ws}_dom`;
  t.key = "bane_" + hex(64);

  await q("BEGIN");
  await q("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [t.ws]);
  await q(
    "INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$1,$3,$4,'active','store')",
    [domain, t.ws, t.hostName, REGION],
  );
  await q("INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,$3,$4)", [
    t.ws,
    REGION,
    BUCKET,
    TOPIC,
  ]);
  await q("INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind) VALUES($1,$2,$3,$4,'address')", [
    `${t.ws}_box`,
    t.ws,
    domain,
    `box@${t.hostName}`,
  ]);
  await q("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [
    t.ws,
    `box@${t.hostName}`,
    `${t.ws}_box`,
  ]);
  await q("INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'example.net',$3),($4,$2,$5,$3)", [
    `${t.ws}_od`,
    t.ws,
    REGION,
    `${t.ws}_oh`,
    t.hostName,
  ]);
  await q(
    "INSERT INTO api_keys(id,workspace_id,name,permissions,domains,hash,prefix) VALUES($1,$2,'tear',$3,'[]',$4,$5)",
    [
      `${t.ws}_key`,
      t.ws,
      JSON.stringify(["read", "send", "manage"]),
      createHash("sha256").update(t.key).digest("hex"),
      t.key.slice(0, 14),
    ],
  );
  await q("COMMIT");

  await ensureRegionSettings(runtime.db, runtime.config);
  await must(t, "POST", "/v1/endpoints", { type: "webhook", name: "w", url: URLS.W, retryAttempts: cfg.retries });
  await must(t, "POST", "/v1/endpoints", { type: "webhook", name: "v", url: URLS.V, retryAttempts: cfg.retries });
  await must(t, "PATCH", "/v1/endpoints/v", { idempotent: true });
  await must(t, "POST", "/v1/endpoints", {
    type: "slack",
    name: "s",
    url: `https://hooks.slack.com/services/T0/B0/${hex(16)}`,
  });
  await must(t, "POST", "/v1/endpoints", { type: "forward", name: "f", address: "team@example.net", preverify: true });
  await must(t, "POST", "/v1/inbound/webhooks", {
    url: URLS.U,
    key: "u",
    addressIds: [`${t.ws}_box`],
    eventTypes: ["message.received"],
    retryAttempts: cfg.retries,
  });

  const rows = (await q("SELECT id,key FROM mailbox_webhooks WHERE workspace_id=$1 AND key IS NOT NULL", [t.ws])).rows;
  t.ids = Object.fromEntries(rows.map((x) => [x.key.toUpperCase(), x.id]));
  t.epOf = Object.fromEntries(rows.map((x) => [x.id, x.key.toUpperCase()]));

  await must(t, "POST", "/v1/routing/routes", { key: "r1", match: `a@${t.hostName}`, to: ["webhook:w"] });
  await must(t, "POST", "/v1/routing/routes", {
    key: "r2",
    match: `x-*@${t.hostName}`,
    to: ["webhook:w", "webhook:v"],
  });
  await must(t, "POST", "/v1/routing/routes", { key: "r3", match: `*@${t.hostName}`, to: ["webhook:v"] });
  await settleJobs(t);
  const view = await readView(t, false);
  return { r: "ok", sends: [], view };
}

// ---------- worker helpers ----------
async function jobOf(t: Trial, d: string) {
  const id = t.deliveryIds[d];
  if (!id) return undefined;
  return (
    await q(
      "SELECT id,status,attempts,lease_until<now() AS expired FROM jobs WHERE workspace_id=$1 AND type='mailbox.webhook' AND payload->>'deliveryId'=$2 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
      [t.ws, id],
    )
  ).rows[0];
}

function labelOfDelivery(t: Trial, k: string | null): string | null {
  return k ? (Object.entries(t.deliveryIds).find(([, id]) => id === k)?.[0] ?? null) : null;
}

function startWorker(w: Worker, gate: boolean) {
  Object.assign(w, { gate, claimed: false, parked: null, inflight: null, done: false, error: null });
  const wr = {
    ...runtime,
    db: drizzle(w.pool),
    webhookFetch: async (url: string, init: Json) => {
      const h = new Headers(init.headers);
      const u = new URL(url);
      const ep =
        u.hostname === "hooks.slack.com"
          ? "S"
          : u.hostname.startsWith("w.")
            ? "W"
            : u.hostname.startsWith("v.")
              ? "V"
              : u.hostname.startsWith("u.")
                ? "U"
                : u.hostname;
      const send: SendRec = { ep, key: h.get("idempotency-key"), delivery: null, body: JSON.parse(String(init.body)) };
      return new Promise((resolve, reject) => {
        w.inflight = { send, resolve, reject };
        w.wake?.();
      });
    },
  } as Json;
  w.task = processJobs(wr, mailboxEventJobs, 1, 1, 20000, "webhooks")
    .then(
      () => {
        w.done = true;
      },
      (e) => {
        w.done = true;
        w.error = e;
      },
    )
    .finally(() => w.wake?.());
}

async function settleWorker(t: Trial, w: Worker): Promise<unknown> {
  const start = Date.now();
  while (!w.done && !w.inflight && !w.parked) {
    await new Promise<void>((resolve) => {
      w.wake = resolve;
      setTimeout(resolve, 50);
    });
    w.wake = null;
    if (Date.now() - start > 10_000) return "stuck";
  }
  if (w.inflight) {
    const s = w.inflight.send;
    s.delivery = labelOfDelivery(t, s.key) ?? w.target;
    const dLabel = s.delivery ?? "?";
    const nonReplaySafe = s.ep === "W" || s.ep === "S";
    emitEvent(t, "delivery.start", { delivery: dLabel, ep: s.ep, worker: w.name, nonReplaySafe });
    if (nonReplaySafe) {
      emitEvent(t, "delivery.inflight", { delivery: dLabel, ep: s.ep, worker: w.name });
    }
    t.activeFlights.set(w.name, { d: dLabel, ep: s.ep });
    return { sending: s.ep, d: s.delivery };
  }
  if (w.parked) return "claimed";
  return null;
}

function finished(w: Worker): string {
  if (w.error) return errOf(w.error);
  return "done";
}

function endFlight(t: Trial, wName: WorkerName): { d: string; ep: string } | undefined {
  const info = t.activeFlights.get(wName);
  if (!info) return undefined;
  t.activeFlights.delete(wName);
  const stillInFlight = [...t.activeFlights.values()].some((x) => x.d === info.d);
  if (!stillInFlight) {
    emitEvent(t, "delivery.flight_end", { delivery: info.d, ep: info.ep });
  }
  return info;
}

function recordSend(t: Trial, s: SendRec, outcomeKind: string, isCrash: boolean): void {
  t.sends.push(s);
  const dLabel = s.delivery ?? "?";
  t.sendCounts[dLabel] = (t.sendCounts[dLabel] ?? 0) + 1;
  const keyValid = s.key !== null && s.key === t.deliveryIds[s.delivery ?? ""];
  emitEvent(t, "delivery.send", { delivery: dLabel, ep: s.ep, keyValid });

  const status = /^\d+$/.test(outcomeKind) ? Number(outcomeKind) : 0;
  const unknownOrOk = isCrash || outcomeKind === "timeout" || outcomeKind === "reset" || (status >= 200 && status < 300);
  if (unknownOrOk && (s.ep === "W" || s.ep === "S")) {
    emitEvent(t, "delivery.unsafe", { delivery: dLabel, ep: s.ep });
    // Planted canary bug: emit a duplicate delivery.start after a committed/unknown non-replay-safe send.
    if (t.bug === "canary_double_start") {
      emitEvent(t, "delivery.start", { delivery: dLabel, ep: s.ep, worker: "canary", nonReplaySafe: true });
    }
  }
}

async function doIngest(t: Trial, m: string, to: string[], variant: string): Promise<string> {
  raw.set(midOf(t, m), buildMime(t, m, variant));
  const recipients = to.map((x) => `${RCPT[x] ?? x}@${t.hostName}`);
  const message = {
    notificationType: "Received",
    mail: {
      messageId: midOf(t, m),
      timestamp: new Date().toISOString(),
      source: "sender@example.org",
      destination: recipients,
      commonHeaders: { subject: `Synthetic ${m}` },
    },
    receipt: {
      timestamp: new Date().toISOString(),
      recipients,
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      action: { type: "S3", bucketName: BUCKET, objectKey: `staging/${midOf(t, m)}`, topicArn: TOPIC },
    },
  };
  await acceptInboundNotification(runtime, { topicArn: TOPIC, region: REGION, message } as Json);
  await q("DELETE FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest'", [t.ws]);
  await mailboxIngestJobs["mailbox.ingest"]!(
    runtime,
    { sesMessageId: midOf(t, m) },
    { id: "job_tear_" + hex(8), workspaceId: t.ws, attempts: 1 },
  );
  const fan = (
    await q(
      "UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND type='mailbox.fanout' AND status='pending' RETURNING id,payload",
      [t.ws],
    )
  ).rows;
  for (const row of fan) {
    await mailboxEventJobs["mailbox.fanout"]!(runtime, row.payload, { id: row.id, workspaceId: t.ws, attempts: 1 });
  }
  const r = (
    await q("SELECT status,error,routing FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id=$2", [
      t.ws,
      midOf(t, m),
    ])
  ).rows[0];
  return r?.status === "processed" ? "ok" : `e:${r?.error ?? r?.status ?? "missing"}`;
}

async function doRun(t: Trial, name: WorkerName, d: string, gate: boolean): Promise<unknown> {
  const w = workers[name];
  const job = await jobOf(t, d);
  if (job?.status === "pending") {
    await q("UPDATE jobs SET available_at=now() WHERE id=$1", [job.id]);
  }
  // Only d may be claimed: other expired leases wait (their holders are already fenced out).
  const hidden = (
    await q(
      "UPDATE jobs SET lease_until='infinity' WHERE workspace_id=$1 AND status='running' AND lease_until<now() AND id<>$2 RETURNING id",
      [t.ws, job?.id ?? ""],
    )
  ).rows.map((r) => r.id);
  w.target = d;
  startWorker(w, gate);
  const r = await settleWorker(t, w);
  if (hidden.length) {
    await q("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=ANY($1) AND lease_until='infinity'", [
      hidden,
    ]);
  }
  return r ?? finished(w);
}

async function doGo(t: Trial, name: WorkerName): Promise<unknown> {
  const w = workers[name];
  const p = w.parked;
  w.parked = null;
  p?.();
  return (await settleWorker(t, w)) ?? finished(w);
}

async function doReply(t: Trial, name: WorkerName, resp: string): Promise<unknown> {
  const w = workers[name];
  const f = w.inflight!;
  w.inflight = null;
  endFlight(t, name);
  const [kind = "", arg] = resp.split(" ");
  recordSend(t, f.send, kind, false);
  if (kind === "timeout") f.reject(Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" }));
  else if (kind === "reset") f.reject(new Error("synthetic connection reset"));
  else f.resolve({ status: Number(kind), retryAfter: arg ?? null });
  return (await settleWorker(t, w)) ?? finished(w);
}

async function doCrash(t: Trial, name: WorkerName, sent: boolean): Promise<string> {
  const w = workers[name];
  const f = w.inflight;
  endFlight(t, name);
  if (sent && f) {
    recordSend(t, f.send, "crash", true);
  }
  w.dead = true;
  w.inflight = null;
  w.parked?.();
  w.parked = null;
  await retire(w);
  return "ok";
}

async function doPause(t: Trial, ep: EndpointName, on: boolean): Promise<string> {
  const res =
    ep === "U"
      ? await rest(t, "PATCH", `/v1/inbound/webhooks/${t.ids.U}`, { paused: on })
      : await rest(t, "PATCH", `/v1/endpoints/${ep.toLowerCase()}`, { paused: on });
  const r = res.error ?? "ok";
  if (!on) {
    const jobs = (
      await q(
        "UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND type='mailbox.resumeDeliveries' AND status='pending' RETURNING id,payload",
        [t.ws],
      )
    ).rows;
    for (const j of jobs) {
      await mailboxEventJobs["mailbox.resumeDeliveries"]!(runtime, j.payload, {
        id: j.id,
        workspaceId: t.ws,
        attempts: 1,
      });
    }
  }
  return r;
}

// Rate-limit windows are wall-clock minutes. Never start a step in a minute's last 1.5 s, and keep
// every endpoint window in the current minute until a tick: time passes only when the model says.
async function pinMinute(t: Trial): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 58_500) await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 50));
  await q(
    "UPDATE api_request_budgets SET window_start=date_trunc('minute',now()) WHERE workspace_id=$1 AND key_id LIKE 'ritual:%' AND window_start<>date_trunc('minute',now())",
    [t.ws],
  );
}

async function executeOne(t: Trial, a: Exclude<DeliveryAction, { op: "Configure" } | { op: "Drain" }>): Promise<unknown> {
  await pinMinute(t);
  switch (a.op) {
    case "Ingest":
      return await doIngest(t, a.m, a.rcpts, a.variant);
    case "Run":
      return await doRun(t, a.w, a.d, a.gate);
    case "Go":
      return await doGo(t, a.w);
    case "Reply":
      return await doReply(t, a.w, a.resp);
    case "Crash":
      return await doCrash(t, a.w, a.sent);
    case "Expire": {
      const job = await jobOf(t, a.d);
      if (job) await q("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
      return job ? "ok" : null;
    }
    case "Tick":
      await q("DELETE FROM api_request_budgets WHERE workspace_id=$1 AND key_id LIKE 'ritual:%'", [t.ws]);
      return "ok";
    case "Pause":
      return await doPause(t, a.e, a.on);
    case "Delete": {
      const e = a.e.toLowerCase();
      if (e === "w" || e === "v" || e === "u") {
        return (await rest(t, "DELETE", `/v1/inbound/webhooks/${t.ids[a.e]}?detach=true`)).error ?? "ok";
      }
      await rest(t, "PUT", "/v1/rules", {});
      return (await rest(t, "DELETE", `/v1/endpoints/${e}`)).error ?? "ok";
    }
    case "Rituals":
      return a.mode === "none"
        ? ((await rest(t, "PUT", "/v1/rules", {})).error ?? "ok")
        : ((
            await rest(t, "PUT", "/v1/rules", {
              rules: [{ key: "triage", source: RITUALS_SRC[a.mode] }],
              attachments: [{ rule: "triage", target: `box@${t.hostName}` }],
            })
          ).error ?? "ok");
    case "RouteSet":
      return (
        (
          await rest(
            t,
            "PATCH",
            `/v1/routing/routes/${a.r}`,
            a.state === "drop" ? { to: "drop" } : { enabled: a.state === "on" },
          )
        ).error ?? "ok"
      );
    case "Rate":
      return (await rest(t, "PATCH", `/v1/endpoints/${a.e.toLowerCase()}`, { perMinute: a.n })).error ?? "ok";
    case "Decline": {
      // The recipient's stop link (signed, no login): the forward is declined.
      const url = new URL(await forwardStopUrl(runtime, t.ids.F!));
      const res = await app.fetch(
        new Request(`http://127.0.0.1:9${url.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1:9" },
          body: "choice=decline",
        }),
        runtime,
      );
      return res.status === 200 ? "ok" : `e:${res.status}`;
    }
    case "Age": {
      const id = t.deliveryIds[a.d];
      return id
        ? (await q("UPDATE mailbox_webhook_deliveries SET created_at=created_at-interval '31 days' WHERE id=$1", [id]))
            .rowCount
          ? "ok"
          : null
        : null;
    }
    case "Prune":
      await pruneMailboxEvents(runtime);
      return "ok";
    case "Strip":
      await q(
        "UPDATE mail_messages SET verdicts=verdicts-'forwardEligible'-'forwardSafe'-'ritualVerified' WHERE workspace_id=$1 AND ses_message_id=$2",
        [t.ws, midOf(t, a.m)],
      );
      return "ok";
  }
}

const DRAIN_EP_ORDER: EndpointName[] = ["F", "S", "U", "V", "W"];

async function executeDrain(t: Trial): Promise<DeliveryView> {
  let latestView = await readView(t, false);
  for (let i = 0; i < 200; i++) {
    let acted = false;
    for (const wName of ["K", "L"] as const) {
      const w = workers[wName];
      if (w.inflight) {
        await executeOne(t, { op: "Reply", w: wName, resp: "503" });
        await settleJobs(t);
        latestView = await readView(t, false);
        acted = true;
        break;
      }
      if (w.parked) {
        await executeOne(t, { op: "Go", w: wName });
        await settleJobs(t);
        latestView = await readView(t, false);
        acted = true;
        break;
      }
    }
    if (acted) continue;

    const pausedEp = DRAIN_EP_ORDER.find((ep) => latestView.e[ep]?.[0] === true);
    if (pausedEp) {
      await executeOne(t, { op: "Pause", e: pausedEp, on: false });
      await settleJobs(t);
      latestView = await readView(t, false);
      continue;
    }

    const rateFull = (
      await q(
        "SELECT 1 FROM api_request_budgets b JOIN mailbox_webhooks h ON h.workspace_id=b.workspace_id AND b.key_id='ritual:'||h.id WHERE b.workspace_id=$1 AND b.used>=h.per_minute LIMIT 1",
        [t.ws],
      )
    ).rows.length;
    if (rateFull > 0) {
      await executeOne(t, { op: "Tick" });
      await settleJobs(t);
      latestView = await readView(t, false);
      continue;
    }

    const sortedLabels = Object.keys(latestView.d).sort();
    let dueLabel: string | null = null;
    let runningLabel: string | null = null;
    for (const label of sortedLabels) {
      const job = await jobOf(t, label);
      if (!job) continue;
      if (job.status === "pending" || (job.status === "running" && job.expired)) {
        dueLabel = label;
        break;
      }
      if (!runningLabel && job.status === "running" && !job.expired) {
        runningLabel = label;
      }
    }
    if (dueLabel) {
      await executeOne(t, { op: "Run", w: "L", d: dueLabel, gate: false });
      await settleJobs(t);
      latestView = await readView(t, false);
      continue;
    }
    if (runningLabel) {
      await executeOne(t, { op: "Expire", d: runningLabel });
      await settleJobs(t);
      latestView = await readView(t, false);
      continue;
    }
    break;
  }

  t.drainCount += 1;
  const unsettled: string[] = [];
  for (const [label, row] of Object.entries(latestView.d)) {
    const status = row[0];
    const jobStatus = row[4]?.[0] ?? null;
    const statusSettled = status === "delivered" || status === "failed" || status === "paused";
    const jobSettled = jobStatus === null || (jobStatus !== "pending" && jobStatus !== "running");
    if (!statusSettled || !jobSettled) {
      unsettled.push(`${label}(status=${status},job=${jobStatus})`);
    }
  }
  t.unsettledAfterDrain = unsettled;
  return latestView;
}

function makeSnapshot(t: Trial): Observed {
  const events = t.pendingEvents.splice(0);
  const snap: DeliverySnapshot = {
    configured: t.configured,
    retries: t.retries,
    sendCounts: { ...t.sendCounts },
    lostDeliveries: [...t.lostDeliveries],
    duplicateDeliveries: [...t.duplicateDeliveries],
    drainCount: t.drainCount,
    unsettledAfterDrain: [...t.unsettledAfterDrain],
    leakedErrors: [...t.leakedErrors],
  };
  return { snapshot: snap, events };
}

export const deliveryHost = host(delivery, {
  async open(req): Promise<Trial> {
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      ws: "",
      hostName: "",
      key: "",
      retries: 1,
      ids: {},
      epOf: {},
      deliveryIds: {},
      delays: {},
      sends: [],
      sendCounts: {},
      activeFlights: new Map(),
      prevEndpoints: {},
      seenDeliveries: new Map(),
      lostDeliveries: [],
      duplicateDeliveries: [],
      drainCount: 0,
      unsettledAfterDrain: [],
      leakedErrors: [],
      pendingEvents: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: DeliveryAction): Promise<DeliveryObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, a.preset);
    }
    if (!t.configured) throw new Error("delivery host: action before Configure");
    const before = t.sends.length;
    if (a.op === "Drain") {
      const view = await executeDrain(t);
      const stepSends: SendTuple[] = t.sends
        .slice(before)
        .map((s) => [s.ep, s.delivery, s.key !== null && s.key === t.deliveryIds[s.delivery ?? ""]]);
      return { r: "drained", sends: stepSends, view };
    }

    let r: unknown;
    try {
      r = await executeOne(t, a);
    } catch (e) {
      r = errOf(e);
      if (process.env.TEAR_VERBOSE === "1") {
        process.stderr.write(`TEAR_ERROR ${JSON.stringify(a)}: ${(e as Error)?.stack}\n`);
      }
    }
    await settleJobs(t);
    const view = await readView(t, a.op === "Prune");
    const stepSends: SendTuple[] = t.sends
      .slice(before)
      .map((s) => [s.ep, s.delivery, s.key !== null && s.key === t.deliveryIds[s.delivery ?? ""]]);
    return { r, sends: stepSends, view };
  },

  async observe(t: Trial): Promise<Observed> {
    return makeSnapshot(t);
  },

  async close(t: Trial): Promise<void> {
    await resetWorkers();
    if (t.ws) {
      await cleanupWorkspace(t.ws).catch(() => {});
    }
    if (activeTrial === t) activeTrial = null;
  },
});
