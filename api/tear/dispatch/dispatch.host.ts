import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { dispatch } from "./dispatch.model.ts";
import {
  DISPATCH_PRESETS,
  type DispatchAction,
  type DispatchCfg,
  type DispatchObs,
  type DispatchSnapshot,
  type Persona,
  type ReleaseLogEntry,
  type SendLogEntry,
} from "./dispatch.types.ts";

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

// ---- Virtual clock (shared between JS Date and PostgreSQL via tear_clock) ----
const RealDate = Date;
let clockBase = 0;
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

// Validate disposable database before connecting or writing anything.
const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const checkedUrl = await (async () => {
  const checked = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: checked });
  await client.connect();
  try {
    await assertDisposable((text) => client.query(text));
  } finally {
    await client.end();
  }
  return checked;
})();

const withClock = `${checkedUrl}?options=${encodeURIComponent("-c search_path=tear_clock,pg_catalog,public")}`;

const env = {
  DATABASE_URL: withClock,
  BANE_ROOT_SECRET: "tear-".repeat(8),
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "tear",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  PUBLIC_URL: "http://127.0.0.1:9",
  ENABLE_LIVE_SES: "false",
  S3_BUCKET: "tear",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  SIMULATED_SES_LATENCY_MS: "0",
  SIMULATED_SES_DELIVERY_DELAY_MS: "0",
  AWS_EC2_METADATA_DISABLED: "true",
};

const [
  { nodeRuntime },
  { createApp },
  { sql },
  { runDispatcher, initialGate },
  { dispatchPartitions, drainJobs },
  { SESv2Client },
  { ensureRegionSettings },
] = await Promise.all([
  import("../../src/adapters/node.ts"),
  import("../../src/app.ts"),
  import("drizzle-orm"),
  import("../../src/dispatcher.ts"),
  import("../../src/dispatch.ts"),
  import("@aws-sdk/client-sesv2"),
  import("../../src/ses-region-state.ts"),
]);

type GateState = import("../../src/dispatcher.ts").GateState;
type Runtime = import("../../src/core.ts").Runtime;

const { runtime } = nodeRuntime(env);
const db = runtime.db;
const app = createApp();
const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

let dbPrepared = false;
async function prepareDatabase() {
  if (dbPrepared) return;
  await db.execute(
    sql.raw(`
    CREATE SCHEMA IF NOT EXISTS tear_clock;
    CREATE TABLE IF NOT EXISTS tear_clock.state(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), off interval NOT NULL DEFAULT '0');
    ALTER TABLE tear_clock.state ADD COLUMN IF NOT EXISTS horizon bigint NOT NULL DEFAULT 0;
    INSERT INTO tear_clock.state DEFAULT VALUES ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION tear_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp() + (SELECT off FROM tear_clock.state) $$;
    CREATE OR REPLACE FUNCTION tear_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.now() + (SELECT off FROM tear_clock.state) $$;
    CREATE OR REPLACE FUNCTION tear_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.statement_timestamp() + (SELECT off FROM tear_clock.state) $$;
    DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND column_default ~ '(^|[^.])(now|clock_timestamp|statement_timestamp)\\(\\)' LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', c.table_name, c.column_name,
          regexp_replace(c.column_default, '(^|[^.])(now|clock_timestamp|statement_timestamp)\\(\\)', '\\1tear_clock.\\2()', 'g'));
      END LOOP;
    END $$;
  `),
  );
  await db.execute(
    sql.raw(`UPDATE sending_emails SET status='canceled' WHERE workspace_id LIKE 'tear\\_%' AND status IN ('queued','attempting');
    UPDATE jobs SET status='completed' WHERE workspace_id LIKE 'tear\\_%' AND status IN ('pending','running');`),
  );
  dbPrepared = true;
}

// ---- Per-trial host state ----
type MailRec = { name: string; id: string; persona: Persona; calls: number; accepted: number[]; marketing?: boolean };
type Pending = { kind: "lease" | "claim" | "ses" | "record"; ids: string[]; release: () => void };
type Instance = {
  gate: GateState;
  running?: Promise<unknown>;
  parked: Pending[];
  wake?: () => void;
  done: boolean;
  error?: string;
  generation: number;
  emptyLease?: boolean;
  shard?: { index: number; count: number };
};

interface HostConfig {
  quota: number;
  pace: number | null;
  seed: number;
  recipients: Persona[];
  shards: boolean;
  invariants: boolean;
  owners: number;
  drainBatch: number;
}

let traceSeq = 0;
let lastVirtual = 0;

interface Trial {
  configured: boolean;
  bug?: string;
  epoch: number;
  modelSec: number;
  W: string;
  R: string;
  SECRET: string;
  SECRET2: string;
  OWNERS: string[];
  CAMPAIGN: string;
  config: HostConfig;
  mails: Map<string, MailRec>;
  byName: Map<string, MailRec>;
  names: number;
  gates: Map<string, GateState>;
  instances: Map<string, Instance>;
  sesAccepted: number[];
  marketingAccepted: number[];
  accountPaused: boolean;
  pauseRefusedAt: Map<string, number>;
  canceledAt: number | null;
  preCancel: Set<string>;
  lastExpanded: number;
  // Factual violation collectors (evaluated by model idle rules)
  leakedErrors: string[];
  sentAfterCancel: string[];
  unknownSesEmails: string[];
  spins: string[];
  asleepWithDue: string[];
  stuckAfterSettle: string[];
  dispatcherErrors: string[];
  // Factual logs for model idle rules & declarative temporal properties
  sendLog: SendLogEntry[];
  releaseLog: ReleaseLogEntry[];
  pendingHostEvents: HostEvent[];
}

let activeTrial: Trial | null = null;
const ctx = new AsyncLocalStorage<{ instance?: string; generation?: number }>();

const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n);
  return s;
};
const regionName = (n: number) => `te-${letters(process.pid)}-${letters(n)}-1`;

const owned = (t: Trial) => sql`workspace_id = ANY(${sql.param(t.OWNERS)}::text[])`;
const nameOf = (t: Trial, id: string) => t.mails.get(id)?.name ?? `?${id.slice(-6)}`;

async function setClock(epochMs: number, allowDrift: boolean) {
  const start = Math.max(epochMs, lastVirtual);
  if (start - epochMs > 940 && !allowDrift) {
    throw new Error(`clock drift: ${start - epochMs} ms of work in one model second`);
  }
  clockReal = RealDate.now();
  clockBase = start;
  await db.execute(sql`UPDATE tear_clock.state SET off = ${clockBase - clockReal} * interval '1 millisecond'`);
}

async function api(t: Trial, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, secret = t.SECRET) {
  const response = await app.fetch(
    new Request("http://127.0.0.1:9" + path, {
      method,
      headers: { authorization: "Bearer " + secret, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    runtime,
  );
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ---- Fake SES behind SESv2Client.prototype.send ----
const providerError = (status: number, name: string, message: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

const withinDay = (t: Trial) => t.sesAccepted.filter((at) => at > vnow() - 86_400_000).length;

(SESv2Client.prototype as any).send = async function (command: any) {
  const t = activeTrial;
  if (!t) throw new Error("SES call outside active trial");
  const name = command.constructor.name;
  const input = command.input;
  if (name === "GetAccountCommand") {
    return {
      SendingEnabled: !t.accountPaused,
      SendQuota: {
        // 100/s (10 ms slot spacing) stays well above OS setTimeout coalescing jitter (1–3 ms)
        // while keeping a 25-row drain under 250 ms.
        MaxSendRate: 100,
        Max24HourSend: t.config.quota,
        SentLast24Hours: t.config.quota < 0 ? 0 : withinDay(t),
      },
    };
  }
  if (name !== "SendEmailCommand") throw new Error(`unexpected SES call ${name}`);
  const id = (input.EmailTags as { Name: string; Value: string }[]).find((tag) => tag.Name === "bane_email_id")!.Value;
  const store = ctx.getStore();
  if (store?.instance) {
    const inst = t.instances.get(store.instance)!;
    if (inst.generation !== store.generation) return new Promise(() => {});
    await park(inst, "ses", [id]);
  }
  const mail = t.mails.get(id);
  if (!mail) {
    t.unknownSesEmails.push(id);
    throw providerError(400, "MessageRejected", "unknown");
  }
  mail.calls++;
  const campaign = mail.name.startsWith("c");
  const proc = store?.instance ? `${store.instance}#${store.generation}` : "runner";
  const recordSend = (out: string) => {
    const at = vnow();
    t.sendLog.push({ at, proc, mail: mail.name, out, campaign });
    t.pendingHostEvents.push({ name: "send.call", data: { mail: mail.name, proc, out } });
    if (out === "accepted" || out === "unknown") {
      t.pendingHostEvents.push({ name: "send.committed", data: { mail: mail.name } });
      // Planted host canary: emit a bogus duplicate call right after commit to verify dispatch.once bites.
      if (t.bug === "canary_double_send") {
        t.pendingHostEvents.push({ name: "send.call", data: { mail: mail.name, proc, out: "accepted" } });
      }
    }
  };
  if (t.canceledAt !== null && campaign && !t.preCancel.has(mail.name)) {
    t.sentAfterCancel.push(mail.name);
  }
  if (t.accountPaused) {
    recordSend("paused");
    if (!t.pauseRefusedAt.has(mail.name)) t.pauseRefusedAt.set(mail.name, vnow());
    throw providerError(400, "SendingPausedException", "Sending is paused for this account.");
  }
  const recipients = ["ToAddresses", "CcAddresses", "BccAddresses"].reduce(
    (n, k) => n + ((input.Destination?.[k] as string[] | undefined)?.length ?? 0),
    0,
  );
  if (t.config.quota >= 0 && withinDay(t) + recipients > t.config.quota) {
    recordSend("quota");
    throw providerError(400, "MessageRejected", "Daily message quota exceeded.");
  }
  const outcome =
    mail.persona === "thr" && mail.calls === 1 ? "throttle" : mail.persona === "thr" ? "ok" : mail.persona;
  recordSend(
    outcome === "throttle" ? "throttled" : outcome === "rej" ? "refused" : outcome === "unk" ? "unknown" : "accepted",
  );
  if (outcome === "throttle") {
    const at = vnow();
    setImmediate(() => {
      if (activeTrial === t) {
        t.sendLog.push({ at: vnow(), proc, mail: "", out: "braked", campaign: false, since: at });
      }
    });
    throw providerError(429, "TooManyRequestsException", "Maximum sending rate exceeded.");
  }
  if (outcome === "rej") throw providerError(400, "MessageRejected", "Email address is not verified.");
  mail.accepted.push(vnow());
  for (let n = 0; n < recipients; n++) {
    t.sesAccepted.push(vnow());
    if (campaign || mail.marketing) t.marketingAccepted.push(vnow());
  }
  if (outcome === "unk") throw providerError(500, "InternalFailure", "Service unavailable.");
  return { MessageId: "tear-" + randomUUID() };
};

// ---- Stepped dispatcher instances (D1, D2) ----
function classify(text: string): Pending["kind"] | undefined {
  if (text.includes("WITH RECURSIVE queued_owners")) return "lease";
  if (text.includes("key_state AS MATERIALIZED")) return "claim";
  if (text.includes("simulated_callbacks AS")) return "record";
  return undefined;
}

function park(inst: Instance, kind: Pending["kind"], ids: string[]) {
  return new Promise<void>((release) => {
    inst.parked.push({ kind, ids, release });
    inst.wake?.();
  });
}

function idsIn(t: Trial, params: unknown[]) {
  const ids: string[] = [];
  for (const p of params) {
    if (typeof p === "string" && p.startsWith("[")) {
      try {
        for (const row of JSON.parse(p)) {
          const id = row.id ?? row.email_id;
          if (typeof id === "string" && t.mails.has(id) && !ids.includes(id)) ids.push(id);
        }
      } catch {
        // not a row list
      }
    }
  }
  return ids;
}

function barrierDb(t: Trial, inst: Instance, generation: number): Runtime["db"] {
  const dialect = (db as any).dialect;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (query: any) => {
          if (inst.generation !== generation) return new Promise(() => {});
          const rendered = dialect.sqlToQuery(query.getSQL ? query.getSQL() : query);
          const kind = classify(rendered.sql);
          if (kind && !(kind === "lease" && inst.emptyLease)) {
            await park(inst, kind, kind === "lease" ? [] : idsIn(t, rendered.params));
          }
          const result = await target.execute(query);
          if (kind === "lease") {
            inst.emptyLease = !(result.rows as { id?: string }[]).some((row) => row.id);
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Runtime["db"];
}

function getInstance(t: Trial, name: string): Instance {
  let inst = t.instances.get(name);
  if (!inst) {
    inst = {
      gate: initialGate(),
      parked: [],
      done: true,
      generation: 0,
      shard: t.config.shards ? { index: name === "D1" ? 0 : 1, count: 2 } : undefined,
    };
    t.instances.set(name, inst);
  }
  return inst;
}

async function stepInst(t: Trial, name: string) {
  const inst = getInstance(t, name);
  inst.emptyLease = false;
  if (!inst.running) {
    const generation = inst.generation;
    const scoped: Runtime = { ...runtime, db: barrierDb(t, inst, generation) };
    inst.done = false;
    inst.error = undefined;
    inst.running = ctx
      .run({ instance: name, generation }, () =>
        runDispatcher(scoped, {
          region: t.R,
          lanes: 1,
          batchSize: 1,
          sendConcurrency: 1,
          gate: inst.gate,
          schedulePartialFlush: () => () => {},
          ...(inst.shard ? { shard: inst.shard } : {}),
        }),
      )
      .then(
        () => undefined,
        (error: Error) => error.message,
      )
      .then((error) => {
        if (inst.generation !== generation) return;
        inst.done = true;
        inst.running = undefined;
        inst.error = error;
        inst.wake?.();
        if (error && t.config.invariants && !/SES sending is disabled/.test(error)) {
          t.dispatcherErrors.push(error.slice(0, 120));
        }
      });
  } else {
    const next = inst.parked.shift();
    if (!next) throw new Error(`${name} is running but not parked`);
    next.release();
  }
  const deadline = RealDate.now() + 30_000;
  while (!inst.done && !inst.parked.length) {
    if (RealDate.now() > deadline) throw new Error(`${name} did not park or finish within 30 s`);
    await new Promise<void>((resolve) => {
      inst.wake = resolve;
      setTimeout(resolve, 20);
    });
  }
}

function crashInst(t: Trial, name: string) {
  const inst = getInstance(t, name);
  inst.generation++;
  inst.parked = [];
  inst.running = undefined;
  inst.done = true;
  inst.error = undefined;
  inst.gate = initialGate();
}

function instPhase(t: Trial, name: string): string {
  const inst = t.instances.get(name);
  if (!inst) return "off";
  if (inst.error) return "error:" + inst.error.slice(0, 80);
  const p = inst.parked[0];
  if (p) return p.kind === "lease" ? "lease" : `${p.kind} ${p.ids.map((id) => nameOf(t, id)).join(",")}`;
  return inst.done ? "off" : "busy";
}

function newMail(t: Trial, id: string, persona: Persona, prefix: string): MailRec {
  const mail: MailRec = { name: `${prefix}${++t.names}`, id, persona, calls: 0, accepted: [] };
  t.mails.set(id, mail);
  t.byName.set(mail.name, mail);
  return mail;
}

function nameRows(t: Trial, rows: { id: string; campaign_id: string | null; to: string[] }[]) {
  let released = [...t.mails.values()].filter((m) => m.name.startsWith("c")).length;
  for (const row of rows) {
    if (!t.mails.has(row.id)) {
      if (row.campaign_id) {
        const mail: MailRec = {
          name: `c${++released}`,
          id: row.id,
          persona: row.to[0]!.split("-")[0] as Persona,
          calls: 0,
          accepted: [],
        };
        t.mails.set(row.id, mail);
        t.byName.set(mail.name, mail);
      } else {
        newMail(t, row.id, row.to[0]!.split("-")[0] as Persona, "x");
      }
    }
  }
}

async function nameReleased(t: Trial) {
  nameRows(
    t,
    await q<{ id: string; campaign_id: string | null; to: string[] }>(
      sql`SELECT id,campaign_id,to_addresses AS "to" FROM sending_emails WHERE ${owned(t)} ORDER BY created_at,id`,
    ),
  );
}

async function configureTrial(t: Trial, cfg: DispatchCfg): Promise<DispatchObs> {
  await assertDisposable((text) => db.execute(sql.raw(text)) as Promise<{ rows: Record<string, unknown>[] }>);
  traceSeq++;
  const recipients: Persona[] = Array.from({ length: cfg.recipients }, () => cfg.campaign);
  t.config = {
    quota: cfg.quota ?? cfg.exactQuota ?? -1,
    pace: cfg.pace,
    seed: cfg.seed,
    recipients,
    shards: cfg.quota !== null,
    invariants: cfg.quota !== null,
    owners: cfg.owners,
    drainBatch: cfg.drainBatch,
  };
  if (traceSeq === 1) {
    const [{ horizon }] = await q<{ horizon: string }>(sql`SELECT horizon FROM tear_clock.state`);
    lastVirtual = Math.max(lastVirtual, Number(horizon));
  }
  t.epoch = Math.ceil((Math.max(lastVirtual, RealDate.now()) + 3_600_000) / 3_600_000) * 3_600_000;
  t.modelSec = 0;
  await setClock(t.epoch + 50, true);
  t.W = `tear_${process.pid}_${traceSeq}`;
  t.R = regionName(traceSeq);
  t.SECRET = "bane_" + createHash("sha256").update(t.W).digest("hex");
  const contacts = recipients.map((p, i) => ({ id: `${t.W}_c${i + 1}`, email: `${p}-c${i + 1}@example.com` }));
  const postal = "123 Tear Way\nTest City, NY 10001";
  await db.execute(sql`WITH w AS (INSERT INTO workspaces(id,name,slug,postal_address) VALUES (${t.W},${t.W},${t.W},${postal}) RETURNING id),
    s AS (INSERT INTO operation_settings(workspace_id,name,postal_address) SELECT id,${t.W},${postal} FROM w ON CONFLICT (workspace_id) DO UPDATE SET postal_address=EXCLUDED.postal_address),
    k AS (INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) SELECT ${t.W + "_key"},id,'tear',${createHash("sha256").update(t.SECRET).digest("hex")},${t.SECRET.slice(0, 14)},'["read","send","manage"]','[]' FROM w),
    c AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) SELECT x.id,w.id,x.email,'subscribed' FROM w,jsonb_to_recordset(${JSON.stringify(contacts)}::jsonb) x(id text,email text) RETURNING id),
    l AS (INSERT INTO audience_lists(id,workspace_id,name) SELECT ${t.W + "_list"},id,'tear' FROM w RETURNING id)
    INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT ${t.W},l.id,c.id FROM l,c`);
  await ensureRegionSettings(db, { workspaceId: t.W, regions: [t.R] });
  t.OWNERS = [t.W];
  if (t.config.owners > 1) {
    const W2 = `${t.W}_b`;
    t.SECRET2 = "bane_" + createHash("sha256").update(W2).digest("hex");
    t.OWNERS.push(W2);
    await db.execute(sql`WITH w AS (INSERT INTO workspaces(id,name,slug,postal_address) VALUES (${W2},${W2},${W2},${postal}) RETURNING id),
      s AS (INSERT INTO operation_settings(workspace_id,name,postal_address) SELECT id,${W2},${postal} FROM w ON CONFLICT (workspace_id) DO UPDATE SET postal_address=EXCLUDED.postal_address)
      INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) SELECT ${W2 + "_key"},id,'tear',${createHash("sha256").update(t.SECRET2).digest("hex")},${t.SECRET2.slice(0, 14)},'["read","send","manage"]','[]' FROM w`);
    await ensureRegionSettings(db, { workspaceId: W2, regions: [t.R] });
    await db.execute(sql`INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent)
      SELECT x.id||'_b',${W2},x.email,'subscribed' FROM jsonb_to_recordset(${JSON.stringify(contacts)}::jsonb) x(id text,email text)`);
  }
  if (t.config.seed) {
    await db.execute(sql`INSERT INTO sending_stream_depth(workspace_id,stripe,marketing,n) VALUES (${t.W},99,false,${t.config.seed})`);
  }
  const draft = await api(t, "POST", "/v1/campaigns", {
    name: "tear",
    from: "sender@example.com",
    region: t.R,
    subject: "Hello",
    html: "<p>Hello</p>",
    audience: { listId: t.W + "_list" },
  });
  if (draft.status !== 201) throw new Error(`campaign draft: ${draft.status} ${JSON.stringify(draft.body)}`);
  t.CAMPAIGN = draft.body.id;
  t.configured = true;
  const obs = await readObs(t, null);
  lastVirtual = t.epoch + 50;
  return obs;
}

async function cleanupTrial(t: Trial) {
  for (const inst of t.instances.values()) inst.done = true;
  if (t.configured && t.OWNERS.length > 0) {
    await db.execute(sql`WITH e AS (UPDATE sending_emails SET status='canceled' WHERE ${owned(t)} AND status IN ('queued','attempting') RETURNING 1),
      j AS (UPDATE jobs SET status='completed' WHERE ${owned(t)} AND status IN ('pending','running') RETURNING 1)
      UPDATE sending_campaigns SET state='canceled',paused_at=NULL,pause_reason=NULL WHERE workspace_id=${t.W} AND state IN ('preparing','scheduled','sending','paused','failed')`);
    lastVirtual = vnow();
    await db.execute(sql`UPDATE tear_clock.state SET horizon = greatest(horizon, ${Math.ceil(lastVirtual)})`);
  }
  if (activeTrial === t) activeTrial = null;
}

const sendBody = (persona: Persona, kind = "transactional") => ({
  from: "sender@example.com",
  to: `${persona}-${kind[0]}@example.com`,
  subject: "Tear",
  text: "Synthetic tear message.",
  kind,
});

async function sendDirect(t: Trial, persona: Persona, key?: string, concurrent = false, secret = t.SECRET) {
  const headers: Record<string, string> = key ? { "idempotency-key": `${t.W}-${key}` } : {};
  const one = () => api(t, "POST", "/v1/emails/send", sendBody(persona), headers, secret);
  const replies = concurrent ? await Promise.all([one(), one()]) : [await one()];
  for (const [i, reply] of replies.entries()) {
    if (reply.status === 409 && reply.body?.error?.code === "IDEMPOTENCY_IN_PROGRESS") {
      replies[i] = await one();
    }
  }
  return replies.map((reply) => {
    if (reply.status !== 202) return [reply.status, reply.body?.error?.code ?? null];
    const id = reply.body.id as string;
    return [reply.status, (t.mails.get(id) ?? newMail(t, id, persona, "e")).name];
  });
}

async function sendMarketing(t: Trial, recipients: number, second: boolean) {
  const to = t.config.recipients.slice(0, recipients).map((p, i) => `${p}-c${i + 1}@example.com`);
  const reply = await api(
    t,
    "POST",
    "/v1/emails/send",
    { from: "sender@example.com", to: to[0], subject: "Tear", text: "Synthetic tear message.", kind: "marketing" },
    {},
    second ? t.SECRET2 : t.SECRET,
  );
  if (reply.status !== 202) return [[reply.status, reply.body?.error?.code ?? null]];
  const id = reply.body.id as string;
  if (recipients > 1) {
    await db.execute(
      sql`UPDATE sending_emails SET to_addresses=${JSON.stringify(to)}::jsonb, snapshot=jsonb_set(snapshot,'{to}',${JSON.stringify(to)}::jsonb) WHERE id=${id}`,
    );
  }
  const mail = newMail(t, id, "ok", "e");
  mail.marketing = true;
  return [[202, mail.name]];
}

async function campaignAction(t: Trial, action: "launch" | "schedule" | "pause" | "resume" | "cancel") {
  const path = `/v1/campaigns/${t.CAMPAIGN}`;
  let reply;
  if (action === "launch" || action === "schedule") {
    const current = await api(t, "GET", path);
    reply = await api(t, "POST", `${path}/${action === "launch" ? "send" : "schedule"}`, {
      revision: current.body.revision,
      ...(action === "schedule" ? { scheduledAt: new Date(vnow() - 500 + 60_000).toISOString() } : {}),
    });
    if (reply.status === 202 && t.config.pace !== null) {
      await db.execute(sql`UPDATE sending_campaigns SET pace_per_day=${t.config.pace} WHERE workspace_id=${t.W} AND id=${t.CAMPAIGN}`);
    }
  } else {
    reply = await api(t, "POST", `${path}/${action}`, action === "cancel" ? undefined : {});
  }
  if (action === "cancel" && reply.status === 200) {
    t.canceledAt = vnow();
    const rows = await q<{ id: string }>(
      sql`SELECT id FROM sending_emails WHERE workspace_id=${t.W} AND campaign_id=${t.CAMPAIGN} AND status<>'queued' AND status<>'canceled'`,
    );
    t.preCancel = new Set(rows.map((r) => nameOf(t, r.id)));
    return [reply.status, reply.body.canceled, reply.body.inFlight];
  }
  return [reply.status, reply.status < 300 ? null : reply.body?.error?.code ?? null];
}

async function runDrain(t: Trial): Promise<unknown> {
  const gate = t.gates.get("runner") ?? initialGate();
  t.gates.set("runner", gate);
  const tried = new Map([...t.mails.values()].map((m) => [m.id, m.calls]));
  const dueNow = async () =>
    (
      await q<{ id: string }>(
        sql`SELECT id FROM sending_emails WHERE ${owned(t)} AND region=${t.R} AND status='queued'
        AND (scheduled_at IS NULL OR scheduled_at <= now()) AND (lease_until IS NULL OR lease_until < now())`,
      )
    ).map((r) => r.id);
  const dueAtStart = new Set(await dueNow());
  const counts = { leases: 0, claimed: 0 };
  const dialect = (db as any).dialect;
  const counted = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (query: any) => {
          const rendered = dialect.sqlToQuery(query.getSQL ? query.getSQL() : query);
          const kind = classify(rendered.sql);
          if (kind === "lease") counts.leases++;
          if (kind === "claim") counts.claimed += idsIn(t, rendered.params).length;
          return target.execute(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Runtime["db"];
  const report = await ctx.run({}, () =>
    runDispatcher(
      { ...runtime, db: counted },
      {
        region: t.R,
        lanes: 1,
        batchSize: t.config.drainBatch,
        gate,
        schedulePartialFlush: () => () => {},
        ...(t.config.quota >= 0 && !t.config.invariants ? { until: vnow() + 1000 } : {}),
      },
    ),
  );
  if (counts.leases > counts.claimed + 3) {
    t.spins.push(`${counts.leases} leases for ${counts.claimed} claimed rows`);
  }
  const due = (await dueNow()).filter(
    (id) => dueAtStart.has(id) && (t.mails.get(id)?.calls ?? 0) === (tried.get(id) ?? 0),
  );
  if (due.length && report.idle && report.quotaRetryAt === undefined && report.paceRetryAt === undefined) {
    t.asleepWithDue.push(due.map((id) => nameOf(t, id)).join(","));
  }
  return t.config.quota >= 0 && !t.config.invariants ? report.idle : null;
}

async function runSettle(t: Trial) {
  t.accountPaused = false;
  for (const name of ["D1", "D2"]) crashInst(t, name);
  for (let day = 0; day < 7; day++) {
    clockBase = vnow() + 86_400_000 + 60_000;
    clockReal = RealDate.now();
    await db.execute(sql`UPDATE tear_clock.state SET off = ${clockBase - clockReal} * interval '1 millisecond'`);
    await dispatchPartitions(runtime, true);
    await drainJobs(runtime, 20, 1, 15_000, "work");
    await nameReleased(t);
    for (const name of ["D1", "D2"]) {
      await stepInst(t, name);
      while (!t.instances.get(name)!.done) await stepInst(t, name);
    }
    const [left] = await q<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM sending_emails WHERE ${owned(t)} AND status IN ('queued','attempting')`,
    );
    if (!left!.n) return;
  }
  for (const r of await q<{ id: string; status: string }>(
    sql`SELECT id,status FROM sending_emails WHERE ${owned(t)} AND status IN ('queued','attempting')`,
  )) {
    t.stuckAfterSettle.push(`${nameOf(t, r.id)}:${r.status}`);
  }
}

async function readObs(t: Trial, result: unknown): Promise<DispatchObs> {
  type Row = { id: string; status: string; campaign_id: string | null; to: string[] };
  const [state] = await q<{
    rows: Row[] | null;
    campaign: [string, number, number, number | null, number | null];
  }>(sql`SELECT
    (SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'campaign_id',campaign_id,'to',to_addresses) ORDER BY created_at,id) FROM sending_emails WHERE ${owned(t)}) AS rows,
    (SELECT jsonb_build_array(state,expanded,window_expanded,floor(extract(epoch FROM window_started_at)*1000),pace_per_day) FROM sending_campaigns WHERE workspace_id=${t.W} AND id=${t.CAMPAIGN}) AS campaign`);
  const rows = state!.rows ?? [];
  nameRows(t, rows);
  const [cstate, expanded, windowN, windowStart, pace] = state!.campaign;
  if (expanded > t.lastExpanded) {
    t.releaseLog.push({ at: vnow(), windowStart, windowN, pace, expanded });
    t.lastExpanded = expanded;
  }
  if (t.config.invariants) return { invariants: true };
  const mail: Record<string, [string, number]> = {};
  for (const row of rows) {
    const m = t.mails.get(row.id)!;
    mail[m.name] = [row.status, m.calls];
  }
  const d: Record<string, string> = {};
  for (const name of ["D1", "D2"]) {
    if (t.instances.has(name)) d[name] = instPhase(t, name);
  }
  return { r: result ?? null, mail, campaign: [cstate, expanded, windowN], d };
}

async function readSnapshot(t: Trial): Promise<Observed> {
  if (!t.configured) {
    const snap: DispatchSnapshot = {
      configured: false,
      quota: -1,
      seed: 0,
      depth: 0,
      queued: 0,
      withinDay: 0,
      marketingWithinDay: 0,
      doubleSends: [],
      leakedErrors: [],
      sentAfterCancel: [],
      unknownSesEmails: [],
      pauseExpiredEarly: [],
      spins: [],
      asleepWithDue: [],
      stuckAfterSettle: [],
      dispatcherErrors: [],
      sendLog: [],
      releaseLog: [],
    };
    return { snapshot: snap, events: [] };
  }
  const [counts] = await q<{ depth: number; queued: number }>(sql`SELECT
    (SELECT coalesce(sum(n),0)::int FROM sending_stream_depth WHERE ${owned(t)}) AS depth,
    (SELECT count(*)::int FROM sending_emails WHERE ${owned(t)} AND review_id IS NULL AND status IN ('queued','attempting')) AS queued`);
  const pauseExpiredRows = await q<{ id: string }>(
    sql`SELECT id FROM sending_emails WHERE ${owned(t)} AND error_code='SES_ACCOUNT_PAUSE_EXPIRED'`,
  );
  const pauseExpiredEarly: string[] = [];
  for (const r of pauseExpiredRows) {
    const name = nameOf(t, r.id);
    const first = t.pauseRefusedAt.get(name);
    if (first !== undefined && vnow() < first + 86_400_000) {
      pauseExpiredEarly.push(name);
    }
  }
  if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
  const doubleSends = [...t.mails.values()].filter((m) => m.accepted.length > 1).map((m) => m.name);
  const events = t.pendingHostEvents;
  t.pendingHostEvents = [];
  const snap: DispatchSnapshot = {
    configured: true,
    quota: t.config.quota,
    seed: t.config.seed,
    depth: counts!.depth,
    queued: counts!.queued,
    withinDay: withinDay(t),
    marketingWithinDay: t.marketingAccepted.filter((at) => at > vnow() - 86_400_000).length,
    doubleSends,
    leakedErrors: [...t.leakedErrors],
    sentAfterCancel: [...t.sentAfterCancel],
    unknownSesEmails: [...t.unknownSesEmails],
    pauseExpiredEarly,
    spins: [...t.spins],
    asleepWithDue: [...t.asleepWithDue],
    stuckAfterSettle: [...t.stuckAfterSettle],
    dispatcherErrors: [...t.dispatcherErrors],
    sendLog: [...t.sendLog],
    releaseLog: [...t.releaseLog],
  };
  return { snapshot: snap, events };
}

export const dispatchHost = host(dispatch, {
  async open(req): Promise<Trial> {
    await prepareDatabase();
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      epoch: 0,
      modelSec: 0,
      W: "",
      R: "",
      SECRET: "",
      SECRET2: "",
      OWNERS: [],
      CAMPAIGN: "",
      config: { quota: -1, pace: null, seed: 0, recipients: [], shards: false, invariants: false, owners: 1, drainBatch: 24 },
      mails: new Map(),
      byName: new Map(),
      names: 0,
      gates: new Map(),
      instances: new Map(),
      sesAccepted: [],
      marketingAccepted: [],
      accountPaused: false,
      pauseRefusedAt: new Map(),
      canceledAt: null,
      preCancel: new Set(),
      lastExpanded: 0,
      leakedErrors: [],
      sentAfterCancel: [],
      unknownSesEmails: [],
      spins: [],
      asleepWithDue: [],
      stuckAfterSettle: [],
      dispatcherErrors: [],
      sendLog: [],
      releaseLog: [],
      pendingHostEvents: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: DispatchAction): Promise<DispatchObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, DISPATCH_PRESETS[a.preset]);
    }
    if (!t.configured) throw new Error("dispatch host: action before Configure");
    if (a.op === "Wait") {
      t.modelSec += a.seconds;
      await setClock(t.epoch + t.modelSec * 1000 + 50, t.config.invariants);
      const obs = await readObs(t, null);
      lastVirtual = vnow();
      return obs;
    }

    await setClock(t.epoch + t.modelSec * 1000 + 50, t.config.invariants);
    let result: unknown = null;
    switch (a.op) {
      case "Send":
        result = await sendDirect(t, a.persona);
        break;
      case "Send2":
        result = await sendDirect(t, a.persona, undefined, false, t.SECRET2);
        break;
      case "SendMarketing":
        result = await sendMarketing(t, a.cost, a.second);
        break;
      case "SendKey":
        result = await sendDirect(t, a.persona, a.key);
        break;
      case "DupKey":
        result = await sendDirect(t, a.persona, a.key, true);
        break;
      case "Launch":
        result = await campaignAction(t, "launch");
        break;
      case "Schedule":
        result = await campaignAction(t, "schedule");
        break;
      case "Pause":
        result = await campaignAction(t, "pause");
        break;
      case "Resume":
        result = await campaignAction(t, "resume");
        break;
      case "Cancel":
        result = await campaignAction(t, "cancel");
        break;
      case "Jobs":
        await drainJobs(runtime, 20, 1, 15_000, "work");
        break;
      case "Drain":
        result = await runDrain(t);
        break;
      case "Recover":
        await dispatchPartitions(runtime, true);
        break;
      case "Step":
        await stepInst(t, a.inst);
        break;
      case "Crash":
        crashInst(t, a.inst);
        break;
      case "Settle":
        await runSettle(t);
        break;
      case "SesPause":
        t.accountPaused = a.paused;
        break;
    }
    const obs = await readObs(t, result);
    lastVirtual = vnow();
    t.modelSec = Math.max(t.modelSec, Math.floor((lastVirtual - t.epoch) / 1000));
    return obs;
  },

  async observe(t: Trial): Promise<Observed> {
    return await readSnapshot(t);
  },

  async close(t: Trial): Promise<void> {
    await cleanupTrial(t);
  },
});
