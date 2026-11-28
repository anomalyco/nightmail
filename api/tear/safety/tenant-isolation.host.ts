import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type Observed } from "@tear/mbt";
import { tenantIsolation } from "./tenant-isolation.model.ts";
import type { TenantAction, TenantObs, TenantSnapshot } from "./tenant-isolation.types.ts";

for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
const PUBLIC = "http://127.0.0.1:8793";
const IMPORT_ROWS = Math.max(100, Math.min(50_000, Number(process.env.TEAR_TENANT_IMPORT_ROWS ?? 1500)));

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: "tear-tenant-".repeat(6),
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

// Synchronizes OverlapImportAndVictimSend so VictimSend fires after the commit transaction's BEGIN.
let onCommitTxBegin: (() => void) | null = null;

class SyncPool extends pg.Pool {
  override connect(...args: any[]): any {
    if (typeof args[0] === "function") return (super.connect as any)(...args);
    return (super.connect() as Promise<pg.PoolClient>).then((client) => {
      const c = client as pg.PoolClient & { __syncWrapped?: true };
      if (!c.__syncWrapped) {
        c.__syncWrapped = true;
        const orig = c.query.bind(c);
        (c as any).query = (...q: any[]) => {
          const text = typeof q[0] === "string" ? q[0] : q[0]?.text ?? "";
          if (onCommitTxBegin && /^\s*begin\b/i.test(text)) {
            const fire = onCommitTxBegin;
            onCommitTxBegin = null;
            const res = (orig as any)(...q);
            Promise.resolve(res).then(() => setTimeout(fire, 40), () => fire());
            return res;
          }
          return (orig as any)(...q);
        };
      }
      return c;
    });
  }
}

const pool = new SyncPool({ connectionString: url, max: 16 });
pool.on("error", () => {});
await assertDisposable((text) => pool.query(text));

const leaked: string[] = [];
process.on("unhandledRejection", (err) => {
  leaked.push(String(err instanceof Error ? err.message : err).slice(0, 120));
});

const [{ createApp }, { loadConfig }, { s3Storage }, { runDispatcher }, { initialGate }, { ensureRegionSettings }, { SESv2Client }] =
  await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("../../src/adapters/storage.ts"),
    import("../../src/sending/dispatcher.ts"), import("../../src/sending/quota.ts"),
    import("../../src/ses-region-state.ts"),
    import("@aws-sdk/client-sesv2"),
  ]);

const runtime: any = { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env) };
const app = createApp();

interface Trial {
  bug?: string;
  region: string;
  wHeavy: string;
  secretHeavy: string;
  heavyListId: string;
  wVictim: string;
  secretVictim: string;
  importSeq: number;
  pendingImportId: string | null;
  heavyBusy: boolean;
  victimIds: Set<string>;
  deliveredOrder: { workspace: string; kind: string; id: string }[];
  victimFailures: string[];
  starvedVictim: string[];
  leakedErrors: string[];
}

let activeTrial: Trial | null = null;
let seq = 0;

(SESv2Client.prototype as any).send = async function (command: any) {
  const name = command.constructor.name;
  if (name === "GetAccountCommand") {
    return { SendingEnabled: true, SendQuota: { MaxSendRate: 200, Max24HourSend: -1, SentLast24Hours: 0 } };
  }
  if (name !== "SendEmailCommand") throw new Error(`unexpected SES call ${name}`);
  const t = activeTrial;
  if (t) {
    const tags = (command.input?.EmailTags ?? []) as { Name: string; Value: string }[];
    const id = tags.find((x) => x.Name === "bane_email_id")?.Value ?? "";
    const workspace = tags.find((x) => x.Name === "bane_workspace_id")?.Value ?? "";
    const kind = tags.find((x) => x.Name === "bane_priority")?.Value ?? "";
    t.deliveredOrder.push({ workspace, kind, id });
  }
  return { MessageId: "tear-iso-" + randomUUID() };
};

const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n);
  return s;
};

async function api(secret: string, method: string, path: string, body?: unknown) {
  const r = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
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

function makeCsv(batch: number, rows = IMPORT_ROWS): string {
  const lines = ["email,name"];
  for (let i = 1; i <= rows; i++) {
    lines.push(`heavy-${batch}-${i}@example.com,Heavy ${batch}-${i}`);
  }
  return lines.join("\n");
}

async function runPreviewImport(t: Trial): Promise<{ status: number; code: string | null; id: string | null }> {
  t.importSeq++;
  const csv = makeCsv(t.importSeq, IMPORT_ROWS);
  const prev = await api(t.secretHeavy, "POST", "/v1/contact-imports", {
    csv,
    listId: t.heavyListId,
    mapping: { email: "email", name: "name" },
  });
  const id = prev.status === 201 && typeof prev.body?.id === "string" ? prev.body.id : null;
  return { status: prev.status, code: prev.status >= 400 ? prev.body?.error?.code ?? null : null, id };
}

async function runCommitImport(t: Trial, importId: string): Promise<{ status: number; code: string | null }> {
  t.heavyBusy = true;
  try {
    const committed = await api(t.secretHeavy, "POST", `/v1/contact-imports/${importId}/commit`, {});
    return { status: committed.status, code: committed.status >= 400 ? committed.body?.error?.code ?? null : null };
  } finally {
    t.heavyBusy = false;
  }
}

async function runVictimSend(t: Trial): Promise<{ status: number; code: string | null; elapsedMs: number }> {
  const t0 = performance.now();
  if (t.bug === "canary_block_victim" && (t.heavyBusy || t.importSeq > 0)) {
    t.victimFailures.push("canary:429:HEAVY_WORKSPACE_CONTENTION");
    return { status: 429, code: "HEAVY_WORKSPACE_CONTENTION", elapsedMs: Math.round(performance.now() - t0) };
  }
  const r = await api(t.secretVictim, "POST", "/v1/emails/send", {
    from: "alerts@victim.example",
    to: `user-${randomBytes(4).toString("hex")}@example.com`,
    region: t.region,
    kind: "transactional",
    subject: "Password reset",
    text: "Your code is 123456.",
  });
  const elapsedMs = Math.round(performance.now() - t0);
  if (r.status === 202 && typeof r.body?.id === "string") {
    t.victimIds.add(r.body.id);
  } else {
    t.victimFailures.push(`${r.status}:${r.body?.error?.code ?? "ERR"}`);
  }
  return { status: r.status, code: r.status >= 400 ? r.body?.error?.code ?? null : null, elapsedMs };
}

export const tenantIsolationHost = host(tenantIsolation, {
  rounds: true,

  async open(req): Promise<Trial> {
    await assertDisposable((text) => pool.query(text));
    seq++;
    const tag = `${process.pid}_${seq}`;
    const region = `ti-${letters(process.pid)}-${letters(seq)}-1`;
    const wHeavy = `tear_iso_h_${tag}`;
    const wVictim = `tear_iso_v_${tag}`;
    const secretHeavy = "nm_" + randomBytes(32).toString("hex");
    const secretVictim = "nm_" + randomBytes(32).toString("hex");
    const heavyListId = `list_${wHeavy}`;

    for (const [w, sec] of [
      [wHeavy, secretHeavy],
      [wVictim, secretVictim],
    ] as const) {
      await pool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Iso Way')", [w]);
      await pool.query(
        'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
        [`key_${w}`, w, createHash("sha256").update(sec).digest("hex"), sec.slice(0, 14)],
      );
      await ensureRegionSettings(runtime.db, { workspaceId: w, regions: [region] });
    }
    await pool.query("INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$2,'Heavy')", [heavyListId, wHeavy]);
    await pool.query(
      "INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) VALUES ($1,$2,'mkt@heavy.example','subscribed')",
      [`con_${wHeavy}`, wHeavy],
    );

    const trial: Trial = {
      bug: req.bug,
      region,
      wHeavy,
      secretHeavy,
      heavyListId,
      wVictim,
      secretVictim,
      importSeq: 0,
      pendingImportId: null,
      heavyBusy: false,
      victimIds: new Set(),
      deliveredOrder: [],
      victimFailures: [],
      starvedVictim: [],
      leakedErrors: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: TenantAction): Promise<TenantObs> {
    switch (a.op) {
      case "PreviewImport": {
        const res = await runPreviewImport(t);
        t.pendingImportId = res.id;
        return { status: res.status, code: res.code, victimStatus: null, victimElapsedMs: null, victimDeliveredBeforeMarketing: null };
      }
      case "CommitImport": {
        const id = t.pendingImportId!;
        t.pendingImportId = null;
        const res = await runCommitImport(t, id);
        return { status: res.status, code: res.code, victimStatus: null, victimElapsedMs: null, victimDeliveredBeforeMarketing: null };
      }
      case "HeavyMarketingFlood": {
        const batch = Array.from({ length: 20 }, (_, i) => ({
          from: "news@heavy.example",
          to: "mkt@heavy.example",
          region: t.region,
          kind: "marketing",
          subject: `Flood ${i}`,
          text: "Heavy marketing blast",
        }));
        const r = await api(t.secretHeavy, "POST", "/v1/emails/batch", { emails: batch });
        return {
          status: r.status,
          code: r.status >= 400 ? r.body?.error?.code ?? null : null,
          victimStatus: null,
          victimElapsedMs: null,
          victimDeliveredBeforeMarketing: null,
        };
      }
      case "VictimSend": {
        const v = await runVictimSend(t);
        return {
          status: v.status,
          code: v.code,
          victimStatus: v.status,
          victimElapsedMs: v.elapsedMs,
          victimDeliveredBeforeMarketing: null,
        };
      }
      case "OverlapImportAndVictimSend": {
        // Preview first so the concurrent overlap always lands inside the commit transaction.
        const prev = await runPreviewImport(t);
        if (prev.status !== 201 || !prev.id) {
          return { status: prev.status, code: prev.code, victimStatus: null, victimElapsedMs: null, victimDeliveredBeforeMarketing: null };
        }
        let txEnteredResolve!: () => void;
        const txEntered = new Promise<void>((resolve) => {
          txEnteredResolve = resolve;
        });
        onCommitTxBegin = txEnteredResolve;
        const commitPromise = runCommitImport(t, prev.id).finally(() => {
          if (onCommitTxBegin) {
            const f = onCommitTxBegin;
            onCommitTxBegin = null;
            f();
          }
        });
        await Promise.race([txEntered, new Promise((r) => setTimeout(r, 250))]);
        const vic = await runVictimSend(t);
        const imp = await commitPromise;
        return {
          status: imp.status,
          code: vic.code ?? imp.code,
          victimStatus: vic.status,
          victimElapsedMs: vic.elapsedMs,
          victimDeliveredBeforeMarketing: null,
        };
      }
      case "DrainVictim": {
        const beforeLen = t.deliveredOrder.length;
        await runDispatcher(runtime, {
          region: t.region,
          lanes: 1,
          batchSize: 24,
          gate: initialGate(),
          schedulePartialFlush: () => () => {},
        });
        const newSends = t.deliveredOrder.slice(beforeLen);
        const deliveredIds = new Set(t.deliveredOrder.map((d) => d.id));
        for (const id of t.victimIds) {
          if (!deliveredIds.has(id)) t.starvedVictim.push(id);
        }
        const firstVictimIdx = newSends.findIndex((d) => d.workspace === t.wVictim);
        const firstMktIdx = newSends.findIndex((d) => d.workspace === t.wHeavy && d.kind === "marketing");
        const victimBeforeMkt =
          firstVictimIdx === -1 || firstMktIdx === -1 ? true : firstVictimIdx < firstMktIdx;
        return {
          status: 200,
          code: null,
          victimStatus: null,
          victimElapsedMs: null,
          victimDeliveredBeforeMarketing: victimBeforeMkt,
        };
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    const deliveredSet = new Set(t.deliveredOrder.map((d) => d.id));
    const victimDelivered = [...t.victimIds].filter((id) => deliveredSet.has(id)).length;
    const snap: TenantSnapshot = {
      victimAccepted: t.victimIds.size,
      victimDelivered,
      victimFailures: [...t.victimFailures],
      starvedVictim: [...t.starvedVictim],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events: [] };
  },

  async close(t: Trial): Promise<void> {
    onCommitTxBegin = null;
    await pool.query(
      "UPDATE sending_emails SET status='canceled' WHERE workspace_id = ANY($1) AND status IN ('queued','attempting')",
      [[t.wHeavy, t.wVictim]],
    );
    if (activeTrial === t) activeTrial = null;
  },
});
