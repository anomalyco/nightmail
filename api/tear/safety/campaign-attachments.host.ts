import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import PostalMime from "postal-mime";
import { host, type Observed } from "@tear/mbt";
import { campaignAttachments } from "./campaign-attachments.model.ts";
import type { AttachAction, AttachKey, AttachObs, AttachSnapshot, InlineKey } from "./campaign-attachments.types.ts";

for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
const PUBLIC = "http://127.0.0.1:8796";

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: "tear-attach-".repeat(6),
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

const pool = new pg.Pool({ connectionString: url, max: 12 });
pool.on("error", () => {});
await assertDisposable((text) => pool.query(text));

const leaked: string[] = [];
process.on("unhandledRejection", (err) => {
  leaked.push(String(err instanceof Error ? err.message : err).slice(0, 120));
});

const [{ createApp }, { loadConfig }, { runDispatcher }, { initialGate }, { drainJobs }, { ensureRegionSettings }, { SESv2Client }] =
  await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("../../src/sending/dispatcher.ts"), import("../../src/sending/quota.ts"),
    import("../../src/dispatch.ts"),
    import("../../src/ses-region-state.ts"),
    import("@aws-sdk/client-sesv2"),
  ]);

const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
const storage = {
  async put(key: string, body: Uint8Array, contentType?: string) {
    objects.set(key, { body: new Uint8Array(body), contentType });
  },
  async get(key: string) {
    const v = objects.get(key);
    return v ? { body: new Uint8Array(v.body), contentType: v.contentType } : null;
  },
  async delete(key: string) {
    objects.delete(key);
  },
};

const runtime: any = { db: drizzle(pool), storage, config: loadConfig(env) };
const app = createApp();

// Minimal valid 1x1 PNG (67 bytes) and minimal PDF bytes
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

interface CapturedSend {
  html: string;
  attachments: AttachKey[];
  inlineCids: string[];
}

interface Trial {
  bug?: string;
  w: string;
  region: string;
  secret: string;
  listId: string;
  campaignId: string;
  revision: number;
  ids: Record<AttachKey, string>;
  keyById: Map<string, AttachKey>;
  inlines: InlineKey[];
  files: ("doc1")[];
  /** Only populated when bug === "canary_keep_removed_inline": simulates the old PR #583 editor keeping stray inline IDs. */
  strayInlines: InlineKey[];
  captured: CapturedSend | null;
  leakedErrors: string[];
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
  const content = command.input?.Content;
  const sentKeys: AttachKey[] = [];
  const inlineCids: string[] = [];
  let html = "";
  if (content?.Raw?.Data) {
    const parsed = await PostalMime.parse(content.Raw.Data);
    html = parsed.html ?? "";
    for (const att of parsed.attachments ?? []) {
      const fn = att.filename ?? "";
      if (fn.startsWith("img1")) sentKeys.push("img1");
      else if (fn.startsWith("img2")) sentKeys.push("img2");
      else if (fn.startsWith("doc1")) sentKeys.push("doc1");
      if (att.disposition === "inline" && att.contentId) {
        inlineCids.push(att.contentId.replace(/^<|>$/g, ""));
      }
    }
  } else if (content?.Simple) {
    html = content.Simple.Body?.Html?.Data ?? "";
    for (const att of content.Simple.Attachments ?? []) {
      const fn = att.FileName ?? "";
      if (fn.startsWith("img1")) sentKeys.push("img1");
      else if (fn.startsWith("img2")) sentKeys.push("img2");
      else if (fn.startsWith("doc1")) sentKeys.push("doc1");
      if (att.ContentDisposition === "INLINE" && att.ContentId) {
        inlineCids.push(att.ContentId);
      }
    }
  }
  t.captured = { html, attachments: sentKeys.sort(), inlineCids: inlineCids.sort() };
  return { MessageId: "tear-att-" + randomUUID() };
};

async function api(t: Trial, method: string, path: string, body?: unknown) {
  const r = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers: {
        authorization: `Bearer ${t.secret}`,
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

function buildHtml(inlines: InlineKey[]): string {
  const imgs = inlines.map((k) => `<img src="cid:bane-${k}" alt="${k}">`).join("");
  return `<p>Synthetic campaign body</p>${imgs}`;
}

async function saveDraft(t: Trial): Promise<{ status: number; draftAttachments: AttachKey[] }> {
  const keys = [...new Set([...t.inlines, ...t.strayInlines, ...t.files])].sort() as AttachKey[];
  const attachmentIds = keys.map((k) => t.ids[k]);
  const res = await api(t, "PATCH", `/v1/campaigns/${t.campaignId}`, {
    revision: t.revision,
    draft: {
      name: "Tear Attach",
      from: "sender@example.com",
      region: t.region,
      subject: "Attachments test",
      html: buildHtml(t.inlines),
      attachments: attachmentIds,
      audience: { listId: t.listId },
    },
  });
  if (res.status !== 200) throw new Error(`PATCH campaign failed: ${res.status} ${JSON.stringify(res.body)}`);
  t.revision = res.body.revision;
  const stored = (res.body.draft.attachments as string[]).map((id) => t.keyById.get(id)!).sort();
  return { status: 200, draftAttachments: stored };
}

export const campaignAttachmentsHost = host(campaignAttachments, {
  async open(req): Promise<Trial> {
    await assertDisposable((text) => pool.query(text));
    seq++;
    const w = `tear_att_${process.pid}_${seq}`;
    const letters = (n: number) => { let s = ""; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n); return s; };
    const region = `ta-${letters(process.pid)}-${letters(seq)}-1`;
    const listId = `list_${w}`;
    const secret = "nm_" + randomBytes(32).toString("hex");
    const postal = "123 Tear Way\nTest City, NY 10001";
    await pool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,$2)", [w, postal]);
    await pool.query(
      "INSERT INTO operation_settings(workspace_id,name,postal_address) VALUES ($1,$1,$2) ON CONFLICT (workspace_id) DO UPDATE SET postal_address=EXCLUDED.postal_address",
      [w, postal],
    );
    await pool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
      [`key_${w}`, w, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
    );
    await pool.query("INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) VALUES ($1,$2,$3,'subscribed')", [
      `con_${w}`,
      w,
      "rcpt@example.com",
    ]);
    await pool.query("INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$2,'tear')", [listId, w]);
    await pool.query("INSERT INTO audience_list_members(workspace_id,list_id,contact_id) VALUES ($1,$2,$3)", [w, listId, `con_${w}`]);
    await ensureRegionSettings(runtime.db, { workspaceId: w, regions: [region] });

    const trial: Trial = {
      bug: req.bug,
      w,
      region,
      secret,
      listId,
      campaignId: "",
      revision: 1,
      ids: { img1: "", img2: "", doc1: "" },
      keyById: new Map(),
      inlines: [],
      files: [],
      strayInlines: [],
      captured: null,
      leakedErrors: [],
    };
    activeTrial = trial;

    // Upload the 3 real attachments through POST /v1/attachments
    for (const [key, filename, contentType, disposition, contentId, content] of [
      ["img1", "img1.png", "image/png", "inline", "bane-img1", PNG_B64],
      ["img2", "img2.png", "image/png", "inline", "bane-img2", PNG_B64],
      ["doc1", "doc1.pdf", "application/pdf", "attachment", undefined, PDF_B64],
    ] as const) {
      const up = await api(trial, "POST", "/v1/attachments", {
        filename,
        contentType,
        disposition,
        ...(contentId ? { contentId } : {}),
        content,
      });
      if (up.status !== 201) throw new Error(`upload ${key} failed: ${up.status} ${JSON.stringify(up.body)}`);
      trial.ids[key] = up.body.id;
      trial.keyById.set(up.body.id, key);
    }

    const created = await api(trial, "POST", "/v1/campaigns", {
      name: "Tear Attach",
      from: "sender@example.com",
      region,
      subject: "Attachments test",
      html: buildHtml([]),
      audience: { listId },
    });
    if (created.status !== 201) throw new Error(`create campaign failed: ${created.status} ${JSON.stringify(created.body)}`);
    trial.campaignId = created.body.id;
    trial.revision = created.body.revision;
    return trial;
  },

  async act(t: Trial, a: AttachAction): Promise<AttachObs> {
    switch (a.op) {
      case "AddInline":
        t.inlines.push(a.key);
        t.strayInlines = t.strayInlines.filter((k) => k !== a.key);
        return { ...(await saveDraft(t)), sentAttachments: null };
      case "RemoveInline":
        t.inlines = t.inlines.filter((k) => k !== a.key);
        // Planted canary mimicking PR #583: removing an image from HTML leaves its ID in draft.attachments!
        if (t.bug === "canary_keep_removed_inline" && !t.strayInlines.includes(a.key)) {
          t.strayInlines.push(a.key);
        }
        return { ...(await saveDraft(t)), sentAttachments: null };
      case "AddFile":
        t.files.push(a.key);
        return { ...(await saveDraft(t)), sentAttachments: null };
      case "RemoveFile":
        t.files = t.files.filter((k) => k !== a.key);
        return { ...(await saveDraft(t)), sentAttachments: null };
      case "LaunchAndSend": {
        const launch = await api(t, "POST", `/v1/campaigns/${t.campaignId}/send`, { revision: t.revision });
        if (launch.status !== 202) throw new Error(`launch failed: ${launch.status} ${JSON.stringify(launch.body)}`);
        await drainJobs(runtime, 20, 1, 15_000, "work");
        await runDispatcher(runtime, {
          region: t.region,
          lanes: 1,
          batchSize: 10,
          gate: initialGate(),
          schedulePartialFlush: () => () => {},
        });
        const cur = await api(t, "GET", `/v1/campaigns/${t.campaignId}`);
        const draftAttachments = (cur.body.draft.attachments as string[]).map((id) => t.keyById.get(id)!).sort();
        return {
          status: launch.status,
          draftAttachments,
          sentAttachments: t.captured ? t.captured.attachments : [],
        };
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    const cur = await api(t, "GET", `/v1/campaigns/${t.campaignId}`);
    const draftAttachments = (cur.body.draft.attachments as string[]).map((id) => t.keyById.get(id)!).sort();
    const { rows } = await pool.query<{ attachment_id: string }>(
      "SELECT attachment_id FROM sending_attachment_links WHERE workspace_id=$1 AND owner_type='campaign' AND owner_id=$2",
      [t.w, t.campaignId],
    );
    const dbLinkedAttachments = rows.map((r) => t.keyById.get(r.attachment_id)!).filter(Boolean).sort();
    const snap: AttachSnapshot = {
      draftAttachments,
      dbLinkedAttachments,
      sentHtml: t.captured?.html ?? null,
      sentAttachments: t.captured?.attachments ?? null,
      sentInlineCids: t.captured?.inlineCids ?? [],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events: [] };
  },

  async close(t: Trial): Promise<void> {
    await pool.query("UPDATE sending_emails SET status='canceled' WHERE workspace_id=$1 AND status IN ('queued','attempting')", [t.w]);
    await pool.query("UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND status IN ('pending','running')", [t.w]);
    if (activeTrial === t) activeTrial = null;
  },
});
