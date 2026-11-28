import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { dbFaults } from "./db-faults.model.ts";
import type { DbFaultAction, DbFaultObs, DbFaultSnapshot, FaultMode, SendKey } from "./db-faults.types.ts";

for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
const PUBLIC = "http://127.0.0.1:8795";

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: "tear-dbfault-".repeat(6),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "false",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  ENABLE_LIVE_SES: "false",
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

const TRANSIENT_CODES = new Set(["XX000", "25006", "57014", "55P03", "53300"]);
let currentFault: FaultMode = "none";
let reqWriteSeq = 0;

function isWriteSql(text: string): boolean {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  return /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(s) || /idempotency_claim\s*\(/i.test(s);
}

function makeFaultError(mode: FaultMode, text: string): Error | null {
  switch (mode) {
    case "none":
      return null;
    case "readonly_pg_readonly":
      return isWriteSql(text)
        ? Object.assign(new Error("pg_readonly: invalid statement because cluster is read-only"), { code: "XX000" })
        : null;
    case "readonly_25006":
      return isWriteSql(text)
        ? Object.assign(new Error("cannot execute write statement in a read-only transaction"), { code: "25006" })
        : null;
    case "stall_57014":
      return Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    case "lock_55P03":
      return Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    case "pool_exhausted_53300":
      return Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
    case "after_first_write_57014":
    case "after_second_write_57014":
      if (!isWriteSql(text)) return null;
      reqWriteSeq += 1;
      // Let the first write (the credential charge) or the first two (also the send admission and its idempotency
      // claim) succeed, then fail the next write mid-request.
      return reqWriteSeq > (mode === "after_first_write_57014" ? 1 : 2)
        ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
        : null;
  }
}

const textOf = (arg: unknown): string => (typeof arg === "string" ? arg : (arg as { text?: string })?.text ?? "");

class FaultPool extends pg.Pool {
  override query(...args: any[]): any {
    if (typeof args.at(-1) === "function") return (super.query as any)(...args);
    const err = makeFaultError(currentFault, textOf(args[0]));
    if (err) return Promise.reject(err);
    return (super.query as any)(...args);
  }
  override connect(...args: any[]): any {
    if (typeof args[0] === "function") return (super.connect as any)(...args);
    if (currentFault === "pool_exhausted_53300") {
      return Promise.reject(Object.assign(new Error("sorry, too many clients already"), { code: "53300" }));
    }
    return (super.connect() as Promise<pg.PoolClient>).then((client) => {
      const c = client as pg.PoolClient & { __faultWrapped?: true };
      if (!c.__faultWrapped) {
        c.__faultWrapped = true;
        const orig = c.query.bind(c);
        (c as any).query = (...q: any[]) => {
          if (typeof q.at(-1) === "function") return (orig as any)(...q);
          const err = makeFaultError(currentFault, textOf(q[0]));
          if (err) return Promise.reject(err);
          return (orig as any)(...q);
        };
      }
      return c;
    });
  }
}

const admin = new pg.Pool({ connectionString: url, max: 4 });
admin.on("error", () => {});
await assertDisposable((text) => admin.query(text));

const leaked: string[] = [];
process.on("unhandledRejection", (err) => {
  leaked.push(String(err instanceof Error ? err.message : err).slice(0, 120));
});

const faultPool = new FaultPool({ connectionString: url, max: 12 });
faultPool.on("error", () => {});

const [{ createApp }, { loadConfig }, { s3Storage }, { runDispatcher, initialGate }, { ensureRegionSettings }, { SESv2Client }] =
  await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("../../src/adapters/storage.ts"),
    import("../../src/dispatcher.ts"),
    import("../../src/ses-region-state.ts"),
    import("@aws-sdk/client-sesv2"),
  ]);

const runtime: any = { db: drizzle(faultPool), storage: s3Storage(env), config: loadConfig(env) };
const app = createApp();

interface Trial {
  bug?: string;
  w: string;
  region: string;
  secret: string;
  acceptedIds: Set<string>;
  keyEmailIds: Map<SendKey, Set<string>>;
  sendCounts: Map<string, number>;
  keySendCounts: Map<string, number>;
  lostAfterDrain: string[];
  nonRetryableFaultErrors: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

let activeTrial: Trial | null = null;
let seq = 0;

(SESv2Client.prototype as any).send = async function (command: any) {
  const name = command.constructor.name;
  if (name === "GetAccountCommand") {
    return { SendingEnabled: true, SendQuota: { MaxSendRate: 100, Max24HourSend: -1, SentLast24Hours: 0 } };
  }
  if (name !== "SendEmailCommand") throw new Error(`unexpected SES call ${name}`);
  const t = activeTrial;
  if (!t) throw new Error("SES call outside active trial");
  const emailId = (command.input?.EmailTags as { Name: string; Value: string }[])?.find(
    (tag) => tag.Name === "bane_email_id",
  )?.Value;
  const toAddr: string = command.input?.Destination?.ToAddresses?.[0] ?? "";
  const sendKey = toAddr.split("@")[0] || "unknown";
  if (emailId) {
    t.sendCounts.set(emailId, (t.sendCounts.get(emailId) ?? 0) + 1);
    t.keySendCounts.set(sendKey, (t.keySendCounts.get(sendKey) ?? 0) + 1);
    t.pendingEvents.push({ name: "ses.call", data: { emailId, sendKey } });
    t.pendingEvents.push({ name: "ses.committed", data: { emailId, sendKey } });
    if (t.bug === "canary_double_send") {
      t.pendingEvents.push({ name: "ses.call", data: { emailId, sendKey } });
    }
  }
  return { MessageId: "tear-dbf-" + randomUUID() };
};

async function api(t: Trial, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  reqWriteSeq = 0;
  const r = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers: {
        authorization: `Bearer ${t.secret}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    runtime,
  );
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-json
  }
  return { status: r.status, body: parsed };
}

/** The recipient (and Idempotency-Key suffix) of SendSuppressed: a hard-bounce suppressed contact in every trial. */
const SUPPRESSED = "s1";

/** Sends one email to `<key>@example.com` with the Idempotency-Key `<workspace>-<key>`. */
async function send(t: Trial, key: string) {
  const res = await api(
    t,
    "POST",
    "/v1/emails/send",
    { from: "sender@example.com", to: `${key}@example.com`, region: t.region, subject: "DB fault test", text: "Synthetic body" },
    { "idempotency-key": `${t.w}-${key}` },
  );
  return {
    status: res.status,
    code: res.status >= 400 ? res.body?.error?.code ?? null : null,
    retryable: res.status >= 400 ? (typeof res.body?.error?.retryable === "boolean" ? res.body.error.retryable : false) : null,
    emailId: res.status === 202 && typeof res.body?.id === "string" ? (res.body.id as string) : null,
  };
}

const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n);
  return s;
};

function pgCodeOf(err: unknown): string | null {
  let cur: any = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause;
  }
  return null;
}

export const dbFaultsHost = host(dbFaults, {
  async open(req): Promise<Trial> {
    currentFault = "none";
    reqWriteSeq = 0;
    await assertDisposable((text) => admin.query(text));
    seq++;
    const w = `tear_dbf_${process.pid}_${seq}`;
    const region = `tf-${letters(process.pid)}-${letters(seq)}-1`;
    const secret = "nm_" + randomBytes(32).toString("hex");
    await admin.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Tear Way')", [w]);
    await admin.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
      [`key_${w}`, w, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
    );
    await ensureRegionSettings(drizzle(admin), { workspaceId: w, regions: [region] });
    await admin.query(
      "INSERT INTO audience_contacts(id,workspace_id,email,suppressed,suppression_reason) VALUES ($1,$2,$3,true,'hard_bounce')",
      [`contact_${w}`, w, `${SUPPRESSED}@example.com`],
    );
    const trial: Trial = {
      bug: req.bug,
      w,
      region,
      secret,
      acceptedIds: new Set(),
      keyEmailIds: new Map(),
      sendCounts: new Map(),
      keySendCounts: new Map(),
      lostAfterDrain: [],
      nonRetryableFaultErrors: [],
      leakedErrors: [],
      pendingEvents: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: DbFaultAction): Promise<DbFaultObs> {
    switch (a.op) {
      case "SetFault":
        currentFault = a.mode;
        reqWriteSeq = 0;
        return { status: 200, code: null, retryable: null, emailId: null, duplicateKeyId: false, drained: false };
      case "SendSuppressed": {
        const { status, code, retryable, emailId } = await send(t, SUPPRESSED);
        if (emailId) t.acceptedIds.add(emailId);
        if (currentFault !== "none" && status >= 400 && retryable !== true && code !== "RECIPIENT_INELIGIBLE") {
          t.nonRetryableFaultErrors.push(`SendSuppressed:${status}:${code}`);
        }
        return { status, code, retryable, emailId, duplicateKeyId: false, drained: false };
      }
      case "Send": {
        const { status, code, retryable, emailId } = await send(t, a.key);
        let duplicateKeyId = false;
        if (emailId) {
          t.acceptedIds.add(emailId);
          let ids = t.keyEmailIds.get(a.key);
          if (!ids) {
            ids = new Set();
            t.keyEmailIds.set(a.key, ids);
          }
          if (ids.size > 0 && !ids.has(emailId)) duplicateKeyId = true;
          ids.add(emailId);
        }
        if (currentFault !== "none" && status >= 400 && retryable !== true && code !== "IDEMPOTENCY_OUTCOME_UNKNOWN") {
          t.nonRetryableFaultErrors.push(`Send:${status}:${code}`);
        }
        return { status, code, retryable, emailId, duplicateKeyId, drained: false };
      }
      case "CreateList": {
        const res = await api(t, "POST", "/v1/lists", { name: `list-${randomBytes(4).toString("hex")}` });
        const code = res.status >= 400 ? res.body?.error?.code ?? null : null;
        const retryable = res.status >= 400 ? (typeof res.body?.error?.retryable === "boolean" ? res.body.error.retryable : false) : null;
        if (currentFault !== "none" && res.status >= 400 && retryable !== true) {
          t.nonRetryableFaultErrors.push(`CreateList:${res.status}:${code}`);
        }
        return { status: res.status, code, retryable, emailId: null, duplicateKeyId: false, drained: false };
      }
      case "ReadMe": {
        const res = await api(t, "GET", "/v1/me");
        const code = res.status >= 400 ? res.body?.error?.code ?? null : null;
        const retryable = res.status >= 400 ? (typeof res.body?.error?.retryable === "boolean" ? res.body.error.retryable : false) : null;
        if (currentFault !== "none" && res.status >= 400 && retryable !== true) {
          t.nonRetryableFaultErrors.push(`ReadMe:${res.status}:${code}`);
        }
        return { status: res.status, code, retryable, emailId: null, duplicateKeyId: false, drained: false };
      }
      case "Drain": {
        reqWriteSeq = 0;
        try {
          if (currentFault === "none") {
            await admin.query(
              "UPDATE sending_emails SET lease_until = NULL WHERE workspace_id = $1 AND status = 'queued' AND lease_until IS NOT NULL",
              [t.w],
            );
          }
          await runDispatcher(runtime, {
            region: t.region,
            lanes: 1,
            batchSize: 20,
            gate: initialGate(),
            schedulePartialFlush: () => () => {},
          });
          if (currentFault === "none") {
            for (const id of t.acceptedIds) {
              if ((t.sendCounts.get(id) ?? 0) === 0) t.lostAfterDrain.push(id);
            }
          }
          return { status: 200, code: null, retryable: null, emailId: null, duplicateKeyId: false, drained: true };
        } catch (err: any) {
          const pgCode = pgCodeOf(err);
          const isTransient = pgCode !== null && TRANSIENT_CODES.has(pgCode);
          if (!isTransient) {
            t.nonRetryableFaultErrors.push(`Drain:${pgCode ?? err?.message ?? "UNKNOWN"}`);
          }
          return {
            status: isTransient ? 503 : 500,
            code: pgCode ?? "DISPATCH_ERROR",
            retryable: isTransient,
            emailId: null,
            duplicateKeyId: false,
            drained: false,
          };
        }
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    const doubleSentIds = [...t.sendCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    const duplicateKeyIds = [...t.keyEmailIds.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([k, ids]) => `${k}:[${[...ids].join(",")}]`);
    const doubleSentKeys = [...t.keySendCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([k, n]) => `${k}x${n}`);
    const events = t.pendingEvents;
    t.pendingEvents = [];
    const snap: DbFaultSnapshot = {
      fault: currentFault,
      acceptedIds: [...t.acceptedIds],
      deliveredIds: [...t.sendCounts.keys()],
      doubleSentIds,
      duplicateKeyIds,
      doubleSentKeys,
      lostAfterDrain: [...t.lostAfterDrain],
      nonRetryableFaultErrors: [...t.nonRetryableFaultErrors],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events };
  },

  async close(t: Trial): Promise<void> {
    currentFault = "none";
    reqWriteSeq = 0;
    await admin.query("UPDATE sending_emails SET status='canceled' WHERE workspace_id=$1 AND status IN ('queued','attempting')", [t.w]);
    if (activeTrial === t) activeTrial = null;
  },
});
