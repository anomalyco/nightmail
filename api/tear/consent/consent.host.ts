import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { consent } from "./consent.model.ts";
import type {
  ConsentAction,
  ConsentObs,
  ConsentPreset,
  ConsentSnapshot,
  ContactSlot,
  ListSlot,
} from "./consent.types.ts";

// Silence routine app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

// Validate disposable database BEFORE connecting pools or registering process.on handlers.
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
const leak = (kind: string) => (err: unknown) => {
  const text = err instanceof Error ? err.message + "\n" + (err.stack ?? "") : String(err);
  process.stderr.write("host " + kind + ": " + text + "\n");
  leaked.push(kind + ":" + (err instanceof Error ? err.message : String(err)).slice(0, 120));
};
process.on("unhandledRejection", leak("unhandled-rejection"));
process.on("uncaughtException", leak("uncaught-exception"));

const poolUrl = checkedUrl + "?options=" + encodeURIComponent("-c jit=off");
const pool = new pg.Pool({ connectionString: poolUrl, max: 16 });
pool.on("error", () => {});

const PUBLIC = "http://127.0.0.1:8791";
function makeEnv(ratePerMin = 100_000): Record<string, string> {
  return {
    DATABASE_URL: poolUrl,
    BANE_ROOT_SECRET: "tear-consent-".repeat(6),
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
    API_RATE_LIMIT_PER_MINUTE: String(ratePerMin),
    DEFAULT_SES_REGION: "us-east-1",
    SIMULATED_SES_LATENCY_MS: "0",
    SIMULATED_SES_DELIVERY_DELAY_MS: "0",
  };
}

const [
  { createApp },
  { loadConfig },
  { s3Storage },
  { runDispatcher, initialGate },
  { processJobs },
  { jobHandlers: sendingJobHandlers, ingestRoutineSesEvents },
  { unsubscribeUrl },
  { ensureRegionSettings },
  { poolSuppression },
  audienceMod,
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/config.ts"),
  import("../../src/adapters/storage.ts"),
  import("../../src/dispatcher.ts"),
  import("../../src/jobs.ts"),
  import("../../src/sending.ts"),
  import("../../src/operations.ts"),
  import("../../src/ses-region-state.ts"),
  import("../../src/mail-controls.ts"),
  import("../../src/audience.ts"),
]);

// Detect optional branch capabilities so one host verifies dev, #600, #601, #596, #619, and bounded-audience-reads.
const featureFlags = await pool.query<{ has_601: boolean; has_596: boolean }>(
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='audience_imports' AND column_name='rows_scrubbed_at') AS has_601, " +
  "EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='audience_list_counts') AS has_596"
);
const HAS_PR601 = Boolean(featureFlags.rows[0]?.has_601);
const HAS_16K_CAP = typeof (audienceMod as any).CONTACT_PROPERTIES_MAX_BYTES === "number";

let runtime: any = { db: drizzle(pool), storage: s3Storage(makeEnv()), config: loadConfig(makeEnv()) };
const app = createApp();

const SLOTS: readonly ContactSlot[] = ["c1", "c2", "c3", "c4"] as const;
const LISTS: readonly ListSlot[] = ["L1", "L2"] as const;

const SUPP_RANK: Record<string, number> = {
  email_validation: 1,
  hard_bounce: 2,
  complaint: 3,
  manual: 3,
};

interface AuditSnap {
  contact_id: string;
  email: string;
  status: string;
  source: string;
  policy_version: string | null;
  evidence: string | null;
  actor_key_id: string | null;
  occurred_at: string;
}

interface WsBContactSnap {
  email: string;
  marketing_consent: string;
  suppressed: boolean;
  suppression_reason: string | null;
  suppressed_at: string | null;
  deleted_at: string | null;
  name: string | null;
}

interface Trial {
  configured: boolean;
  bug?: string;
  preset: ConsentPreset;
  wsA: string;
  wsB: string;
  region: string;
  secretA: string;
  secretB: string;
  listsA: Record<ListSlot, string>;
  emails: Record<ContactSlot, string>;
  unsubTokens: Record<ContactSlot, string>;
  lastPlanId: string | null;
  lastPlanStatus: "subscribed" | "unsubscribed" | null;
  unsubSincePlan: Set<ContactSlot>;
  lastCampaignId: string | null;
  seenSentEmailIds: Set<string>;
  knownConsent: Map<ContactSlot, string>;
  knownSuppressed: Map<ContactSlot, { reason: string | null; atMs: number }>;
  knownAuditRows: Map<string, AuditSnap>;
  wsBBaseline: Map<string, WsBContactSnap>;
  blockedEmails: Set<string>;
  overrideViolations: string[];
  serializabilityViolations: string[];
  blockedSendViolations: string[];
  evidenceViolations: string[];
  tallyViolations: string[];
  workspaceViolations: string[];
  limitViolations: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

let traceSeq = 0;

const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n);
  return s;
};

async function api(secret: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const r = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers: {
        ...(secret ? { authorization: "Bearer " + secret } : {}),
        ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    runtime,
  );
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // html or text
  }
  return { status: r.status, body: parsed, text };
}

async function contactRowA(t: Trial, slot: ContactSlot) {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    marketing_consent: string;
    suppressed: boolean;
    suppression_reason: string | null;
    suppressed_at: string | null;
    deleted_at: string | null;
    updated_at: string;
  }>(
    "SELECT id, email, marketing_consent, suppressed, suppression_reason, suppressed_at::text, deleted_at::text, updated_at::text FROM audience_contacts WHERE workspace_id = $1 AND email = $2",
    [t.wsA, t.emails[slot]],
  );
  return rows[0] ?? null;
}

async function seedFeedbackEmail(t: Trial, slot: ContactSlot): Promise<{ emailId: string; providerId: string }> {
  const emailId = "eml_fb_" + randomBytes(8).toString("hex");
  const providerId = "prov_fb_" + randomBytes(8).toString("hex");
  await pool.query(
    "INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,provider_id,created_at) " +
    'VALUES ($1,$2,$3,$4,\'sender@consent.example\',$5,\'[]\',\'[]\',\'Feedback seed\',\'{"kind":"marketing"}\',true,\'accepted\',$6,now())',
    [emailId, t.wsA, t.region, "key_" + t.wsA, JSON.stringify([t.emails[slot]]), providerId],
  );
  return { emailId, providerId };
}

async function feedSuppressionEvent(
  t: Trial,
  slot: ContactSlot,
  kind: "hard_bounce" | "complaint" | "email_validation",
  atIso: string,
) {
  const { emailId, providerId } = await seedFeedbackEmail(t, slot);
  const msgId = "sns-" + t.wsA + "-" + slot + "-" + kind + "-" + randomUUID().slice(0, 8);
  const topicArn = "urn:bane:simulated-ses:" + t.region;
  const type = kind === "complaint" ? "complaint" : kind === "email_validation" ? "validation_suppressed" : "bounce";
  await ingestRoutineSesEvents(runtime, [
    {
      workspaceId: t.wsA,
      providerId,
      taggedEmailId: emailId,
      type,
      externalId: "ext-" + msgId,
      createdAt: atIso,
      ingress: {
        topicArn,
        messageId: msgId,
        region: t.region,
        payload: { message: { mail: { messageId: providerId, destination: [t.emails[slot]] } } },
      },
      effects: {
        reported: [t.emails[slot]],
        suppress: kind,
        observe: null,
        receiptTime: false,
      },
    } as any,
  ]);
}

async function syncAndVerify(t: Trial, allowResubscribeFor?: ContactSlot | "all") {
  if (!t.configured) return;

  // 1. Rules 1 & 4 on every slot in wsA
  for (const slot of SLOTS) {
    const row = await contactRowA(t, slot);
    if (!row) continue;

    const prevConsent = t.knownConsent.get(slot);
    if (
      prevConsent === "unsubscribed" &&
      row.marketing_consent === "subscribed" &&
      allowResubscribeFor !== "all" &&
      allowResubscribeFor !== slot
    ) {
      t.overrideViolations.push(slot + " (" + row.email + ") flipped unsubscribed -> subscribed without legitimate confirmed resubscribe");
    }
    t.knownConsent.set(slot, row.marketing_consent);

    const isBlocked = row.marketing_consent === "unsubscribed" || row.suppressed || row.deleted_at !== null;
    if (isBlocked) {
      if (!t.blockedEmails.has(row.email)) {
        t.blockedEmails.add(row.email);
        t.pendingEvents.push({ name: "consent.blocked", data: { slot, email: row.email } });
      }
    } else {
      t.blockedEmails.delete(row.email);
    }

    const prevSupp = t.knownSuppressed.get(slot);
    if (prevSupp) {
      if (!row.suppressed) {
        t.overrideViolations.push(slot + " suppression was silently lifted (was " + prevSupp.reason + ")");
      } else {
        const prevRank = SUPP_RANK[prevSupp.reason ?? ""] ?? 0;
        const curRank = SUPP_RANK[row.suppression_reason ?? ""] ?? 0;
        if (curRank < prevRank) {
          t.evidenceViolations.push(slot + " suppression_reason downgraded: " + prevSupp.reason + " -> " + row.suppression_reason);
        }
        const curAtMs = row.suppressed_at ? Date.parse(row.suppressed_at) : 0;
        if (prevSupp.atMs > 0 && curAtMs > 0 && curAtMs + 1 < prevSupp.atMs) {
          t.evidenceViolations.push(slot + " suppressed_at moved backwards: " + prevSupp.atMs + " -> " + curAtMs);
        }
        t.knownSuppressed.set(slot, { reason: row.suppression_reason, atMs: Math.max(prevSupp.atMs, curAtMs) });
      }
    } else if (row.suppressed) {
      t.knownSuppressed.set(slot, {
        reason: row.suppression_reason,
        atMs: row.suppressed_at ? Date.parse(row.suppressed_at) : 0,
      });
    }
  }

  // 2. Rule 4: consent audit evidence is append-only and never mutated or lost
  const { rows: auditRows } = await pool.query<AuditSnap & { id: string }>(
    "SELECT id, contact_id, email, status, source, policy_version, evidence, actor_key_id, occurred_at::text FROM audience_consent_audit WHERE workspace_id = $1",
    [t.wsA],
  );
  const currentAudit = new Map<string, AuditSnap>();
  for (const r of auditRows) {
    currentAudit.set(r.id, {
      contact_id: r.contact_id,
      email: r.email,
      status: r.status,
      source: r.source,
      policy_version: r.policy_version,
      evidence: r.evidence,
      actor_key_id: r.actor_key_id,
      occurred_at: r.occurred_at,
    });
  }
  for (const [id, prev] of t.knownAuditRows.entries()) {
    const cur = currentAudit.get(id);
    if (!cur) {
      t.evidenceViolations.push("consent audit row " + id + " (" + prev.email + " " + prev.status + ") was deleted");
    } else if (JSON.stringify(cur) !== JSON.stringify(prev)) {
      t.evidenceViolations.push("consent audit row " + id + " was mutated: before=" + JSON.stringify(prev) + " after=" + JSON.stringify(cur));
    }
  }
  for (const [id, cur] of currentAudit.entries()) {
    if (!t.knownAuditRows.has(id)) t.knownAuditRows.set(id, cur);
  }

  // 3. Rule 5: API list tallies must equal raw SQL recount (non-negative, mutually exclusive, <= members)
  if (t.preset !== "rateLimit") {
    const listsRes = await api(t.secretA, "GET", "/v1/lists");
    if (listsRes.status === 200 && Array.isArray(listsRes.body?.data)) {
      for (const ls of LISTS) {
        const lid = t.listsA[ls];
        const apiList = listsRes.body.data.find((x: any) => x.id === lid);
        const { rows: [raw] } = await pool.query<{
          total: number;
          subscribed: number;
          unsubscribed: number;
          unknown: number;
          suppressed: number;
          members: number;
        }>(
          "SELECT count(*) FILTER (WHERE c.deleted_at IS NULL)::int AS total, " +
          "count(*) FILTER (WHERE c.deleted_at IS NULL AND NOT c.suppressed AND c.marketing_consent = 'subscribed')::int AS subscribed, " +
          "count(*) FILTER (WHERE c.deleted_at IS NULL AND NOT c.suppressed AND c.marketing_consent = 'unsubscribed')::int AS unsubscribed, " +
          "count(*) FILTER (WHERE c.deleted_at IS NULL AND NOT c.suppressed AND c.marketing_consent = 'unknown')::int AS unknown, " +
          "count(*) FILTER (WHERE c.deleted_at IS NULL AND c.suppressed)::int AS suppressed, " +
          "count(*)::int AS members " +
          "FROM audience_list_members m JOIN audience_contacts c ON c.id = m.contact_id AND c.workspace_id = m.workspace_id " +
          "WHERE m.workspace_id = $1 AND m.list_id = $2",
          [t.wsA, lid],
        );
        if (apiList?.counts && raw) {
          const c = apiList.counts;
          if (c.total < 0 || c.subscribed < 0 || c.unsubscribed < 0 || c.unknown < 0 || c.suppressed < 0) {
            t.tallyViolations.push(ls + " negative count: " + JSON.stringify(c));
          }
          if (c.subscribed + c.unsubscribed + c.unknown + c.suppressed !== c.total) {
            t.tallyViolations.push(ls + " counts do not sum to total: " + JSON.stringify(c));
          }
          if (c.total > raw.members) {
            t.tallyViolations.push(ls + " total(" + c.total + ") > raw members(" + raw.members + ")");
          }
          if (
            c.total !== raw.total ||
            c.subscribed !== raw.subscribed ||
            c.unsubscribed !== raw.unsubscribed ||
            c.unknown !== raw.unknown ||
            c.suppressed !== raw.suppressed
          ) {
            t.tallyViolations.push(ls + " API counts " + JSON.stringify(c) + " != raw SQL " + JSON.stringify(raw));
          }
        }
      }
    }
  }

  // 4. Rule 6: workspace B isolation (same emails untouched!) + Hosted SES SuppressionScope pin
  const { rows: wsBRows } = await pool.query<WsBContactSnap>(
    "SELECT email, marketing_consent, suppressed, suppression_reason, suppressed_at::text, deleted_at::text, name FROM audience_contacts WHERE workspace_id = $1",
    [t.wsB],
  );
  const wsBMap = new Map(wsBRows.map((r) => [r.email, r]));
  for (const [email, base] of t.wsBBaseline.entries()) {
    const cur = wsBMap.get(email);
    if (!cur) {
      t.workspaceViolations.push("wsB contact " + email + " disappeared after wsA action");
    } else if (
      cur.marketing_consent !== base.marketing_consent ||
      cur.suppressed !== base.suppressed ||
      cur.suppression_reason !== base.suppression_reason ||
      cur.deleted_at !== base.deleted_at ||
      cur.name !== base.name
    ) {
      t.workspaceViolations.push("wsB contact " + email + " mutated by wsA: before=" + JSON.stringify(base) + " after=" + JSON.stringify(cur));
    }
  }
  for (const stream of ["marketing", "transactional"] as const) {
    const cfg = poolSuppression(stream);
    if (cfg.SuppressionScope !== "TENANT") {
      t.workspaceViolations.push("poolSuppression(" + stream + ") SuppressionScope drifted from TENANT to " + cfg.SuppressionScope);
    }
  }
}

async function configureTrial(t: Trial, preset: ConsentPreset): Promise<ConsentObs> {
  await assertDisposable((text) => pool.query(text));
  traceSeq++;
  const env = makeEnv(preset === "rateLimit" ? 60 : 100_000);
  runtime = { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env) };

  const tag = process.pid + "_" + traceSeq;
  t.preset = preset;
  t.wsA = "tear_cns_a_" + tag;
  t.wsB = "tear_cns_b_" + tag;
  t.region = "us-east-1";
  t.secretA = "nm_" + randomBytes(32).toString("hex");
  t.secretB = "nm_" + randomBytes(32).toString("hex");
  t.listsA = { L1: "lst_" + t.wsA + "_1", L2: "lst_" + t.wsA + "_2" };
  t.emails = {
    c1: "c1-" + tag + "@consent.example",
    c2: "c2-" + tag + "@consent.example",
    c3: "c3-" + tag + "@consent.example",
    c4: "c4-" + tag + "@consent.example",
  };
  t.lastPlanId = null;
  t.lastPlanStatus = null;
  t.unsubSincePlan.clear();
  t.lastCampaignId = null;
  t.seenSentEmailIds.clear();
  t.knownConsent.clear();
  t.knownSuppressed.clear();
  t.knownAuditRows.clear();
  t.wsBBaseline.clear();
  t.blockedEmails.clear();

  for (const [w, sec] of [
    [t.wsA, t.secretA],
    [t.wsB, t.secretB],
  ] as const) {
    await pool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Consent Way')", [w]);
    await pool.query(
      "INSERT INTO operation_settings(workspace_id,name,postal_address) VALUES ($1,$1,'123 Consent Way') ON CONFLICT(workspace_id) DO UPDATE SET postal_address=excluded.postal_address",
      [w],
    );
    await pool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
      ["key_" + w, w, createHash("sha256").update(sec).digest("hex"), sec.slice(0, 14)],
    );
    await ensureRegionSettings(runtime.db, { workspaceId: w, regions: [t.region] });
  }

  await pool.query(
    "INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$3,'List 1'),($2,$3,'List 2')",
    [t.listsA.L1, t.listsA.L2, t.wsA],
  );

  for (const [slot, consentVal, list] of [
    ["c1", "subscribed", "L1"],
    ["c2", "subscribed", "L1"],
    ["c3", "unknown", "L2"],
  ] as const) {
    const cid = t.wsA + "_" + slot;
    await pool.query(
      "INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent) VALUES ($1,$2,$3,$4,$5)",
      [cid, t.wsA, t.emails[slot], "Name " + slot, consentVal],
    );
    await pool.query("INSERT INTO audience_list_members(workspace_id,list_id,contact_id) VALUES ($1,$2,$3)", [
      t.wsA,
      t.listsA[list],
      cid,
    ]);
    t.knownConsent.set(slot, consentVal);
  }

  for (const slot of SLOTS) {
    const cid = t.wsB + "_" + slot;
    await pool.query(
      "INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent) VALUES ($1,$2,$3,$4,'subscribed')",
      [cid, t.wsB, t.emails[slot], "WsB " + slot],
    );
    t.wsBBaseline.set(t.emails[slot], {
      email: t.emails[slot],
      marketing_consent: "subscribed",
      suppressed: false,
      suppression_reason: null,
      suppressed_at: null,
      deleted_at: null,
      name: "WsB " + slot,
    });
  }

  for (const slot of SLOTS) {
    const u = await unsubscribeUrl(runtime, t.wsA, t.emails[slot]);
    t.unsubTokens[slot] = u.split("/unsubscribe/")[1]!;
  }

  if (preset === "bulkLimit") {
    await pool.query(
      "INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent) " +
      "SELECT $1 || '_b' || g, $1, 'bulk-' || g || '@consent.example', 'Bulk ' || g, 'unknown' FROM generate_series(1, 10001) g",
      [t.wsA],
    );
  }

  t.configured = true;
  await syncAndVerify(t);
  return { status: 200, code: null, retryable: null };
}

export const consentHost = host(consent, {
  rounds: true,

  async open(req): Promise<Trial> {
    return {
      configured: false,
      bug: req.bug,
      preset: "core",
      wsA: "",
      wsB: "",
      region: "",
      secretA: "",
      secretB: "",
      listsA: { L1: "", L2: "" },
      emails: { c1: "", c2: "", c3: "", c4: "" },
      unsubTokens: { c1: "", c2: "", c3: "", c4: "" },
      lastPlanId: null,
      lastPlanStatus: null,
      unsubSincePlan: new Set(),
      lastCampaignId: null,
      seenSentEmailIds: new Set(),
      knownConsent: new Map(),
      knownSuppressed: new Map(),
      knownAuditRows: new Map(),
      wsBBaseline: new Map(),
      blockedEmails: new Set(),
      overrideViolations: [],
      serializabilityViolations: [],
      blockedSendViolations: [],
      evidenceViolations: [],
      tallyViolations: [],
      workspaceViolations: [],
      limitViolations: [],
      leakedErrors: [],
      pendingEvents: [],
    };
  },

  async act(t: Trial, a: ConsentAction): Promise<ConsentObs> {
    if (a.op === "Configure") return configureTrial(t, a.preset);
    if (!t.configured) throw new Error("consent host: action before Configure");

    const errObs = (r: { status: number; body: any }, detail?: string): ConsentObs => ({
      status: r.status,
      code: r.status >= 400 ? r.body?.error?.code ?? null : null,
      retryable: r.status >= 400 ? (typeof r.body?.error?.retryable === "boolean" ? r.body.error.retryable : null) : null,
      detail: detail ?? null,
    });

    switch (a.op) {
      case "CreateContact": {
        const r = await api(t.secretA, "POST", "/v1/contacts", {
          email: t.emails[a.slot],
          name: "Created " + a.slot,
        });
        return errObs(r);
      }

      case "UpdateProfile": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const r = await api(t.secretA, "PATCH", "/v1/contacts/" + row.id, {
          name: a.name,
          properties: { plan: a.name.toLowerCase() },
        });
        return errObs(r);
      }

      case "DeleteContact": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const r = await api(t.secretA, "DELETE", "/v1/contacts/" + row.id);
        return errObs(r);
      }

      case "SetConsentApi": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const occurredAt = a.staleTimestamp ? new Date(Date.now() - 86_400_000).toISOString() : undefined;
        const r = await api(t.secretA, "POST", "/v1/contacts/" + row.id + "/consent", {
          status: a.status,
          source: "api-explicit",
          policyVersion: "2026-11",
          evidence: "Unconfirmed consent write",
          ...(occurredAt ? { occurredAt } : {}),
        });
        return errObs(r);
      }

      case "ConfirmResubscribeApi": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        let freshMs = Date.now() + 5;
        if (!a.staleTimestamp) {
          const { rows: latestRows } = await pool.query<{ ts: string | null }>(
            "SELECT max(occurred_at)::text AS ts FROM audience_consent_audit WHERE workspace_id = $1 AND contact_id = $2",
            [t.wsA, row.id],
          );
          const latestMs = latestRows[0]?.ts ? Date.parse(latestRows[0].ts) : 0;
          if (latestMs >= freshMs) freshMs = latestMs + 5;
        }
        const occurredAt = a.staleTimestamp
          ? new Date(Date.now() - 86_400_000).toISOString()
          : new Date(freshMs).toISOString();
        const r = await api(t.secretA, "POST", "/v1/contacts/" + row.id + "/consent", {
          status: "subscribed",
          source: "api-explicit",
          policyVersion: "2026-11",
          evidence: "Explicit verified resubscribe form",
          occurredAt,
          confirmResubscribe: true,
        });
        if (r.status === 200 && !a.staleTimestamp) {
          t.knownConsent.set(a.slot, "subscribed");
        }
        return errObs(r);
      }

      case "AddToList": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const r = await api(t.secretA, "POST", "/v1/lists/" + t.listsA[a.list] + "/members", {
          contactIds: [row.id],
        });
        return errObs(r);
      }

      case "RemoveFromList": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const r = await api(t.secretA, "DELETE", "/v1/lists/" + t.listsA[a.list] + "/members/" + row.id);
        return errObs(r);
      }

      case "ImportCommit": {
        const lines = ["email,name", ...a.slots.map((s) => t.emails[s] + ",Imported " + s)];
        const prev = await api(t.secretA, "POST", "/v1/contact-imports", {
          csv: lines.join("\n"),
          ...(a.list ? { listId: t.listsA[a.list] } : {}),
          mapping: { email: "email", name: "name" },
        });
        if (prev.status !== 201) return errObs(prev);
        const body = a.attested ? { consent: { status: "subscribed", evidence: "CSV attested checkout signup", policyVersion: "2026-11" } } : {};
        const committed = await api(t.secretA, "POST", "/v1/contact-imports/" + prev.body.id + "/commit", body);
        return errObs(committed);
      }

      case "PlanBulkConsent": {
        const stmt = "UPDATE contacts SET consent = '" + a.status + "' WHERE email CONTAINS '@consent.example'";
        const r = await api(t.secretA, "POST", "/v1/audience-query/plan", { statement: stmt });
        if (r.status === 201 && r.body?.id) {
          t.lastPlanId = r.body.id;
          t.lastPlanStatus = a.status;
          t.unsubSincePlan.clear();
        }
        return errObs(r);
      }

      case "ApplyBulkPlan": {
        if (!t.lastPlanId) return { status: 404, code: "NO_PLAN", retryable: false };
        const r = await api(t.secretA, "POST", "/v1/audience-query/apply", {
          planId: t.lastPlanId,
          confirmResubscribe: a.confirmResubscribe,
          evidence: "Bulk consent apply evidence",
        });
        if (r.status === 200 && t.lastPlanStatus === "subscribed" && t.unsubSincePlan.size > 0) {
          for (const slot of t.unsubSincePlan) {
            const after = await contactRowA(t, slot);
            if (after && after.marketing_consent === "subscribed") {
              t.serializabilityViolations.push(
                "ApplyBulkPlan flipped " + slot + " back to subscribed despite a post-plan unsubscribe (BUG-CONSENT-01)",
              );
            }
          }
        }
        if (r.status === 200 && a.confirmResubscribe && t.unsubSincePlan.size === 0) {
          await syncAndVerify(t, "all");
        }
        return errObs(r);
      }

      case "UnsubscribeGet": {
        const before = await contactRowA(t, a.slot);
        const r = await api("", "GET", "/unsubscribe/" + t.unsubTokens[a.slot]);
        const after = await contactRowA(t, a.slot);
        if (before && after && before.marketing_consent !== after.marketing_consent) {
          t.overrideViolations.push("GET /unsubscribe mutated consent for " + a.slot);
        }
        return { status: r.status, code: null, retryable: null };
      }

      case "UnsubscribeOneClick": {
        const r = await api("", "POST", "/unsubscribe/" + t.unsubTokens[a.slot], "List-Unsubscribe=One-Click", {
          "content-type": "application/x-www-form-urlencoded",
        });
        if (r.status >= 200 && r.status < 300) t.unsubSincePlan.add(a.slot);
        return { status: r.status, code: null, retryable: null };
      }

      case "UnsubscribeFooter": {
        const r = await api("", "POST", "/unsubscribe/" + t.unsubTokens[a.slot], "confirm=footer", {
          "content-type": "application/x-www-form-urlencoded",
        });
        if (r.status >= 200 && r.status < 300) t.unsubSincePlan.add(a.slot);
        return { status: r.status, code: null, retryable: null };
      }

      case "FeedbackSuppress": {
        const atIso = new Date(Date.now() + a.tsOffsetSec * 1000).toISOString();
        await feedSuppressionEvent(t, a.slot, a.kind, atIso);
        return { status: 200, code: null, retryable: null };
      }

      case "ManualSuppress": {
        await pool.query(
          "INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,suppressed_at) " +
          "VALUES ($1,$2,$3,true,'manual',now()) " +
          "ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE " +
          "SET suppressed=true, suppression_reason='manual', suppressed_at=greatest(coalesce(c.suppressed_at,now()),now()), updated_at=now()",
          [t.wsA + "_man_" + a.slot, t.wsA, t.emails[a.slot]],
        );
        return { status: 200, code: null, retryable: null };
      }

      case "LaunchCampaign": {
        const draft = await api(
          t.secretA,
          "POST",
          "/v1/campaigns",
          {
            name: "Consent Campaign " + a.list,
            from: "news@consent.example",
            region: t.region,
            subject: "Consent check",
            html: "<p>Hello subscriber.</p>",
            audience: { listId: t.listsA[a.list] },
          },
          { "idempotency-key": "cns-draft-" + randomUUID() },
        );
        if (draft.status !== 201) return errObs(draft);
        t.lastCampaignId = draft.body.id;
        const sent = await api(
          t.secretA,
          "POST",
          "/v1/campaigns/" + draft.body.id + "/send",
          { revision: draft.body.revision },
          { "idempotency-key": "cns-send-" + randomUUID() },
        );
        return errObs(sent);
      }

      case "ExpandCampaign": {
        if (!t.lastCampaignId) return { status: 200, code: null, retryable: null };
        await processJobs(runtime, sendingJobHandlers, 4, 1, 5_000, "work");
        return { status: 200, code: null, retryable: null };
      }

      case "DispatchCampaign": {
        if (!t.lastCampaignId) return { status: 200, code: null, retryable: null };
        const { rows: blockedNow } = await pool.query<{ email: string }>(
          "SELECT email FROM audience_contacts WHERE workspace_id = $1 AND (suppressed OR marketing_consent = 'unsubscribed' OR deleted_at IS NOT NULL)",
          [t.wsA],
        );
        const blockedAtRelease = new Set(blockedNow.map((r) => r.email.toLowerCase()));
        const slotByEmail = new Map<string, ContactSlot>(SLOTS.map((s) => [t.emails[s].toLowerCase(), s]));
        for (const em of blockedAtRelease) {
          const s = slotByEmail.get(em);
          if (!t.blockedEmails.has(em)) {
            t.blockedEmails.add(em);
            if (s) t.pendingEvents.push({ name: "consent.blocked", data: { slot: s, email: em } });
          }
        }

        await runDispatcher(runtime, {
          region: t.region,
          lanes: 1,
          batchSize: 50,
          gate: initialGate(),
          schedulePartialFlush: () => () => {},
        });

        const { rows: sentRows } = await pool.query<{ id: string; to_addresses: string[]; status: string }>(
          "SELECT id, to_addresses, status FROM sending_emails WHERE workspace_id = $1 AND campaign_id IS NOT NULL AND status IN ('accepted', 'sent', 'delivered')",
          [t.wsA],
        );
        for (const sr of sentRows) {
          if (t.seenSentEmailIds.has(sr.id)) continue;
          t.seenSentEmailIds.add(sr.id);
          const to = String(sr.to_addresses?.[0] ?? "").toLowerCase();
          const s = slotByEmail.get(to);
          if (s) t.pendingEvents.push({ name: "consent.sent", data: { slot: s, email: to } });
          if (blockedAtRelease.has(to)) {
            t.blockedSendViolations.push(to + " was unsubscribed/suppressed/deleted before release but email " + sr.id + " reached status=" + sr.status);
          }
        }

        if (t.bug === "canary_send_unsubscribed" && blockedAtRelease.size > 0) {
          const victim = [...blockedAtRelease][0]!;
          const s = slotByEmail.get(victim) ?? "c1";
          t.pendingEvents.push({ name: "consent.sent", data: { slot: s, email: victim } });
        }
        return { status: 200, code: null, retryable: null };
      }

      case "RaceImportAndUnsub": {
        const prev = await api(t.secretA, "POST", "/v1/contact-imports", {
          csv: "email,name\n" + t.emails[a.slot] + ",RaceImported",
          listId: t.listsA.L1,
          mapping: { email: "email", name: "name" },
        });
        if (prev.status !== 201) return errObs(prev);
        await Promise.all([
          api(t.secretA, "POST", "/v1/contact-imports/" + prev.body.id + "/commit", {
            consent: { status: "subscribed", evidence: "Concurrent import attestation" },
          }),
          api("", "POST", "/unsubscribe/" + t.unsubTokens[a.slot], "List-Unsubscribe=One-Click", {
            "content-type": "application/x-www-form-urlencoded",
          }),
        ]);
        const after = await contactRowA(t, a.slot);
        if (!after || after.marketing_consent !== "unsubscribed") {
          t.serializabilityViolations.push("RaceImportAndUnsub(" + a.slot + "): expected unsubscribed, got " + after?.marketing_consent);
        }
        return { status: 200, code: null, retryable: null };
      }

      case "RacePlanApplyAndUnsub": {
        const plan = await api(t.secretA, "POST", "/v1/audience-query/plan", {
          statement: "UPDATE contacts SET consent = 'subscribed' WHERE email = '" + t.emails[a.slot] + "'",
        });
        if (plan.status !== 201) return errObs(plan);
        await Promise.all([
          api(t.secretA, "POST", "/v1/audience-query/apply", {
            planId: plan.body.id,
            confirmResubscribe: true,
            evidence: "Concurrent plan apply",
          }),
          api("", "POST", "/unsubscribe/" + t.unsubTokens[a.slot], "List-Unsubscribe=One-Click", {
            "content-type": "application/x-www-form-urlencoded",
          }),
        ]);
        const after = await contactRowA(t, a.slot);
        if (!after || after.marketing_consent !== "unsubscribed") {
          t.serializabilityViolations.push("RacePlanApplyAndUnsub(" + a.slot + "): expected unsubscribed in both serial orders, got " + after?.marketing_consent);
        }
        return { status: 200, code: null, retryable: null };
      }

      case "RaceStaleResubscribeAndUnsub": {
        const row = await contactRowA(t, a.slot);
        if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
        const preRaceIso = new Date(Date.now() - 50).toISOString();
        await Promise.all([
          api(t.secretA, "POST", "/v1/contacts/" + row.id + "/consent", {
            status: "subscribed",
            source: "api-explicit",
            evidence: "Pre-race opt-in",
            occurredAt: preRaceIso,
            confirmResubscribe: true,
          }),
          api("", "POST", "/unsubscribe/" + t.unsubTokens[a.slot], "List-Unsubscribe=One-Click", {
            "content-type": "application/x-www-form-urlencoded",
          }),
        ]);
        const after = await contactRowA(t, a.slot);
        if (!after || after.marketing_consent !== "unsubscribed") {
          t.serializabilityViolations.push("RaceStaleResubscribeAndUnsub(" + a.slot + "): expected unsubscribed in both serial orders, got " + after?.marketing_consent);
        }
        return { status: 200, code: null, retryable: null };
      }

      case "RaceFeedbackOrderCheck": {
        const t2 = new Date(Date.now() + 120_000);
        const t1 = new Date(Date.now() + 60_000);
        await feedSuppressionEvent(t, a.slot, "hard_bounce", t2.toISOString());
        await feedSuppressionEvent(t, a.slot, "complaint", t1.toISOString());
        const after = await contactRowA(t, a.slot);
        if (!after || !after.suppressed || (after.suppression_reason !== "complaint" && after.suppression_reason !== "manual")) {
          t.evidenceViolations.push("RaceFeedbackOrderCheck: expected complaint or manual suppression, got " + after?.suppression_reason);
        } else if (!after.suppressed_at || Date.parse(after.suppressed_at) + 1000 < t2.getTime()) {
          t.evidenceViolations.push("RaceFeedbackOrderCheck: suppressed_at is order-dependent (moved backwards to " + after.suppressed_at + " < " + t2.toISOString() + ")");
        }
        return { status: 200, code: null, retryable: null };
      }

      case "CheckLimits": {
        switch (a.kind) {
          case "bulk10k": {
            const beforePlans = (await pool.query("SELECT count(*)::int AS n FROM audience_operation_plans WHERE workspace_id=$1", [t.wsA])).rows[0].n;
            const r = await api(t.secretA, "POST", "/v1/audience-query/plan", {
              statement: "UPDATE contacts SET consent = 'subscribed' WHERE email CONTAINS '@consent.example'",
            });
            const afterPlans = (await pool.query("SELECT count(*)::int AS n FROM audience_operation_plans WHERE workspace_id=$1", [t.wsA])).rows[0].n;
            if (r.status !== 422 || r.body?.error?.code !== "AUDIENCEQL_LIMIT_EXCEEDED" || afterPlans !== beforePlans) {
              t.limitViolations.push("bulk10k cap failed: status=" + r.status + " code=" + r.body?.error?.code + " plans=" + beforePlans + "->" + afterPlans);
            }
            return errObs(r);
          }
          case "import50k": {
            const lines = ["email"];
            for (let i = 1; i <= 50_001; i++) lines.push("r" + i + "@x.co");
            const r = await api(t.secretA, "POST", "/v1/contact-imports", {
              csv: lines.join("\n"),
              mapping: { email: "email" },
            });
            if (r.status !== 413 || r.body?.error?.code !== "IMPORT_TOO_LARGE") {
              t.limitViolations.push("import50k cap failed: status=" + r.status + " code=" + r.body?.error?.code);
            }
            return errObs(r);
          }
          case "importProps51": {
            const props49 = Object.fromEntries(Array.from({ length: 49 }, (_, i) => ["k" + i, "v"]));
            await pool.query("UPDATE audience_contacts SET properties = $1::jsonb WHERE workspace_id = $2 AND email = $3", [
              JSON.stringify(props49),
              t.wsA,
              t.emails.c1,
            ]);
            const probeEmail = "atomic-rollback-" + traceSeq + "@consent.example";
            const prev = await api(t.secretA, "POST", "/v1/contact-imports", {
              csv: "email,firstName,plan,country\n" + t.emails.c1 + ",A,pro,US\n" + probeEmail + ",B,free,US",
              mapping: { email: "email", firstName: "firstName", plan: "plan", country: "country" },
            });
            if (prev.status !== 201) return errObs(prev);
            const committed = await api(t.secretA, "POST", "/v1/contact-imports/" + prev.body.id + "/commit", {});
            const leakedRow = (await pool.query("SELECT 1 FROM audience_contacts WHERE workspace_id=$1 AND email=$2", [t.wsA, probeEmail])).rowCount ?? 0;
            if (committed.status !== 422 || committed.body?.error?.code !== "IMPORT_PROPERTIES_INVALID" || leakedRow > 0) {
              t.limitViolations.push("importProps51 not atomic: status=" + committed.status + " code=" + committed.body?.error?.code + " leakedRow=" + leakedRow);
            }
            return errObs(committed);
          }
          case "previewCap50": {
            let firstId = "";
            let sawPreview429 = false;
            for (let i = 1; i <= 55; i++) {
              let r = await api(t.secretA, "POST", "/v1/contact-imports", {
                csv: "email\nprev-" + i + "@consent.example",
                mapping: { email: "email" },
              });
              if (r.status === 429 && r.body?.error?.code === "IMPORT_PREVIEW_RATE_LIMITED") {
                sawPreview429 = true;
                if (r.body?.error?.retryable !== true) {
                  t.limitViolations.push("previewCap50 429 not retryable: " + JSON.stringify(r.body));
                }
                await pool.query("DELETE FROM api_request_budgets WHERE workspace_id = $1 AND key_id = 'imports:preview'", [t.wsA]);
                r = await api(t.secretA, "POST", "/v1/contact-imports", {
                  csv: "email\nprev-" + i + "@consent.example",
                  mapping: { email: "email" },
                });
              }
              if (r.status !== 201) {
                t.limitViolations.push("previewCap50 preview #" + i + " failed: status=" + r.status + " code=" + r.body?.error?.code);
                return errObs(r);
              }
              if (i === 1) firstId = r.body.id;
            }
            const openCount = (await pool.query("SELECT count(*)::int AS n FROM audience_imports WHERE workspace_id=$1 AND status='preview'", [t.wsA])).rows[0].n;
            const oldest = await api(t.secretA, "GET", "/v1/contact-imports/" + firstId);
            if (sawPreview429 && (openCount > 50 || oldest.status !== 404)) {
              t.limitViolations.push("previewCap50 (#600 active): open=" + openCount + " oldest=" + oldest.status);
            }
            return {
              status: 200,
              code: openCount <= 50 && oldest.status === 404 ? "CAPPED_50" : "UNCAPPED_DEV",
              retryable: null,
              detail: "open=" + openCount + ",oldest=" + oldest.status + ",rate429=" + sawPreview429,
            };
          }
          case "rateLimit": {
            let saw429 = false;
            for (let i = 0; i < 65; i++) {
              const r = await api(t.secretA, "GET", "/v1/lists?counts=false");
              if (r.status === 429) {
                saw429 = true;
                if (r.body?.error?.retryable !== true) {
                  t.limitViolations.push("rateLimit 429 not retryable: " + JSON.stringify(r.body));
                }
                break;
              }
            }
            if (!saw429) {
              t.limitViolations.push("rateLimit preset (60/min) never returned 429 across 65 requests");
            }
            return { status: saw429 ? 429 : 200, code: saw429 ? "RATE_LIMIT_EXCEEDED" : null, retryable: saw429 ? true : null };
          }
          case "props16k": {
            const row = await contactRowA(t, "c1");
            if (!row) return { status: 404, code: "NOT_FOUND", retryable: false };
            const bigProps = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["big_" + i, "x".repeat(1900)]));
            const rPatch = await api(t.secretA, "PATCH", "/v1/contacts/" + row.id, { properties: bigProps });
            if (HAS_16K_CAP) {
              if (rPatch.status < 400 || rPatch.status >= 500) {
                t.limitViolations.push("props16k PATCH should fail 4xx on bounded-audience-reads, got " + rPatch.status);
              }
              const baseProps = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["b_" + i, "y".repeat(1800)]));
              await pool.query("UPDATE audience_contacts SET properties = $1::jsonb WHERE workspace_id = $2 AND id = $3", [
                JSON.stringify(baseProps),
                t.wsA,
                row.id,
              ]);
              const probeEmail = "atomic-16k-" + traceSeq + "@consent.example";
              const extra = "z".repeat(1800);
              const prev = await api(t.secretA, "POST", "/v1/contact-imports", {
                csv: "email,firstName,plan,country\n" + t.emails.c1 + "," + extra + "," + extra + "," + extra + "\n" + probeEmail + ",ok,ok,US",
                mapping: { email: "email", firstName: "firstName", plan: "plan", country: "country" },
              });
              if (prev.status === 201) {
                const comm = await api(t.secretA, "POST", "/v1/contact-imports/" + prev.body.id + "/commit", {});
                const leakedRow = (await pool.query("SELECT 1 FROM audience_contacts WHERE workspace_id=$1 AND email=$2", [t.wsA, probeEmail])).rowCount ?? 0;
                if (comm.status !== 422 || leakedRow > 0) {
                  t.limitViolations.push("props16k CSV import not atomic: status=" + comm.status + " code=" + comm.body?.error?.code + " leakedRow=" + leakedRow);
                }
              }
              await pool.query("UPDATE audience_contacts SET properties = '{}'::jsonb WHERE workspace_id = $1 AND id = $2", [t.wsA, row.id]);
            }
            return errObs(rPatch, HAS_16K_CAP ? "16K_ENFORCED" : "16K_ABSENT_DEV");
          }
        }
      }

      case "RunRetentionScrub": {
        if (!HAS_PR601) return { status: 200, code: "PR601_ABSENT", retryable: null };
        await pool.query(
          "UPDATE audience_imports SET updated_at = now() - interval '10 days', created_at = now() - interval '10 days' WHERE workspace_id = $1 AND status = 'committed'",
          [t.wsA],
        );
        const maint: any = await import("../../src/maintenance.ts");
        if (typeof maint.cleanup === "function") {
          await maint.cleanup(runtime, 15_000);
        }
        return { status: 200, code: "PR601_SCRUBBED", retryable: null };
      }

      case "VerifyAll": {
        await syncAndVerify(t);
        return { status: 200, code: null, retryable: null };
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    await syncAndVerify(t);
    const events = t.pendingEvents;
    t.pendingEvents = [];
    const snap: ConsentSnapshot = {
      configured: t.configured,
      overrideViolations: [...t.overrideViolations],
      serializabilityViolations: [...t.serializabilityViolations],
      blockedSendViolations: [...t.blockedSendViolations],
      evidenceViolations: [...t.evidenceViolations],
      tallyViolations: [...t.tallyViolations],
      workspaceViolations: [...t.workspaceViolations],
      limitViolations: [...t.limitViolations],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events };
  },

  async close(t: Trial): Promise<void> {
    if (t.configured && t.wsA) {
      await pool.query("UPDATE sending_emails SET status='canceled' WHERE workspace_id = ANY($1) AND status IN ('queued','attempting')", [[t.wsA, t.wsB]]);
      await pool.query("UPDATE jobs SET status='completed' WHERE workspace_id = ANY($1) AND status IN ('pending','running')", [[t.wsA, t.wsB]]);
      if (t.preset === "bulkLimit") {
        await pool.query("DELETE FROM audience_contacts WHERE workspace_id = $1", [t.wsA]);
      }
    }
  },
});
