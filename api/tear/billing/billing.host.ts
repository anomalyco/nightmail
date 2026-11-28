import { createHash, createHmac, randomBytes } from "node:crypto";
import { host, type Observed } from "@tear/mbt";
import { billing } from "./billing.model.ts";
import {
  BILLING_PRESETS,
  type AttemptSnap,
  type BillingAction,
  type BillingObs,
  type BillingPresetCfg,
  type BillingSnapshot,
  type DisputeTrack,
  type LedgerEntrySnap,
  type RechargeOutcome,
  type RefundOutcome,
  type TopUpOutcome,
} from "./billing.types.ts";

// Silence noisy app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

// Validate disposable database BEFORE connecting pools, registering handlers, or creating tear_clock.
const { assertDisposable, prepareTearClock, requireDisposableDatabase } = await import("../disposable.ts");
const checkedUrl = await requireDisposableDatabase(
  process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL,
  "TEAR_DATABASE_URL",
);

const leaked: string[] = [];
const leak = (kind: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`billing host ${kind}: ${text}\n`);
  leaked.push(`${kind}:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
};
process.on("unhandledRejection", leak("unhandled-rejection"));
process.on("uncaughtException", leak("uncaught-exception"));

// ---- Virtual clock shared between JS Date and PostgreSQL via tear_clock ----
const RealDate = Date;
let clockBase = RealDate.now();
const vnow = () => clockBase;

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

const PUBLIC = "http://127.0.0.1:8793";
const STRIPE_BASE = "https://stripe.tear.invalid";
const STRIPE_SECRET = "sk_test_tear_billing_key_1234567890";
const STRIPE_WEBHOOK_SECRET = "whsec_tear_billing_secret_1234567890";
const ISSUER = "https://tear-billing-issuer.invalid";
const UC_PER_CENT = 1_000_000n;

const withClock = `${checkedUrl}?options=${encodeURIComponent("-c search_path=tear_clock,pg_catalog,public")}`;

const env = {
  DATABASE_URL: withClock,
  BANE_ROOT_SECRET: "tear-billing-".repeat(5),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  ACCOUNT_ISSUER: ISSUER,
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  ENABLE_LIVE_SES: "false",
  STRIPE_SECRET_KEY: STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET,
  STRIPE_API_BASE: STRIPE_BASE,
  STRIPE_AUTOMATIC_TAX: "false",
  S3_BUCKET: "tear",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  AWS_EC2_METADATA_DISABLED: "true",
  API_RATE_LIMIT_PER_MINUTE: "100000",
};

// ---- Deterministic Stripe API interceptor via globalThis.fetch ----
interface MockInvoice {
  id: string;
  customer: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "deleted";
  default_payment_method: string;
  metadata: Record<string, string>;
  created: number;
  subtotal: number;
  total: number;
  total_excluding_tax: number;
  amount_paid: number;
  payment_intent: string | null;
  charge: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  lines: { data: { id: string; amount: number }[] };
}

interface MockSession {
  id: string;
  mode: "payment" | "setup";
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  url: string;
  expires_at: number;
  amount_subtotal: number;
  amount_total: number;
  payment_intent: string | null;
  setup_intent: string | null;
  invoice: string | null;
  client_reference_id: string;
  metadata: Record<string, string>;
}

interface MockRefund {
  id: string;
  status: "succeeded" | "failed" | "pending";
  amount: number;
  failure_reason?: string;
}

interface StripeState {
  seq: number;
  idem: Map<string, { status: number; body: unknown }>;
  invoices: Map<string, MockInvoice>;
  sessions: Map<string, MockSession>;
  refunds: Map<string, MockRefund>;
  piCard: Map<string, { pm: string; fp: string; last4: string; charge: string }>;
  nextPayOutcome: TopUpOutcome | RechargeOutcome;
  nextRefundOutcome: RefundOutcome;
  activeCard: "A" | "B";
}

interface Trial {
  configured: boolean;
  bug?: string;
  epoch: number;
  modelSec: number;
  W: string;
  userId: string;
  cookie: string;
  stripe: StripeState;
  disputes: DisputeTrack[];
  disputeEventSeq: number;
  fraudWarnings: Set<string>;
  rechargeLoopViolations: string[];
  leakedErrors: string[];
  lastTopUpKey: string | null;
  usageSeq: number;
  webhookSeq: number;
}

let activeTrial: Trial | null = null;
const originalFetch = globalThis.fetch;

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function cardInfo(t: Trial, which: "A" | "B" = t.stripe.activeCard) {
  return {
    pm: `pm_${t.W}_${which}`,
    fp: `fp_${t.W}_${which}`,
    last4: which === "A" ? "4242" : "1881",
  };
}

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!urlStr.startsWith(STRIPE_BASE)) return originalFetch(input, init);

  const t = activeTrial;
  if (!t) return jsonResp(500, { error: { type: "api_error", message: "No active billing trial" } });

  const u = new URL(urlStr);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const idemKey = headers.get("idempotency-key");
  const bodyStr = typeof init?.body === "string" ? init.body : "";
  const form = method === "POST" ? parseForm(bodyStr) : Object.fromEntries(u.searchParams.entries());
  const st = t.stripe;

  // Replay cached response for identical Idempotency-Key on non-5xx
  if (method === "POST" && idemKey && st.idem.has(idemKey)) {
    const cached = st.idem.get(idemKey)!;
    return jsonResp(cached.status, cached.body);
  }
  const cacheAndRespond = (status: number, body: unknown) => {
    if (method === "POST" && idemKey && status < 500) st.idem.set(idemKey, { status, body });
    return jsonResp(status, body);
  };

  const path = u.pathname;

  // Credit product
  if (method === "GET" && path === "/v1/products/nightmail_credit") {
    return jsonResp(200, { id: "nightmail_credit", active: true, tax_code: "txcd_10103001" });
  }
  if (method === "POST" && path === "/v1/products") {
    return cacheAndRespond(200, { id: form.id ?? "nightmail_credit", active: true, tax_code: form.tax_code });
  }

  // Customers
  if (method === "POST" && path === "/v1/customers") {
    const id = `cus_${t.W}_${++st.seq}`;
    return cacheAndRespond(200, { id });
  }
  if (method === "POST" && /^\/v1\/customers\/[^/]+$/.test(path)) {
    return cacheAndRespond(200, { id: path.split("/").pop() });
  }

  // Checkout sessions
  if (method === "POST" && path === "/v1/checkout/sessions") {
    if (st.nextPayOutcome === "stripe_5xx") {
      return jsonResp(500, { error: { type: "api_error", message: "Stripe checkout unavailable." } });
    }
    const id = `cs_${t.W}_${++st.seq}`;
    const mode = form.mode === "setup" ? "setup" : "payment";
    const unitAmount = Number(form["line_items[0][price_data][unit_amount]"] ?? 0);
    const attemptId = form.client_reference_id ?? form["metadata[bane_attempt]"] ?? "";
    const pi = mode === "payment" ? `pi_${t.W}_${++st.seq}` : null;
    const si = mode === "setup" ? `seti_${t.W}_${++st.seq}` : null;
    const card = cardInfo(t);
    if (pi) st.piCard.set(pi, { ...card, charge: `ch_${t.W}_${++st.seq}` });
    if (si) st.piCard.set(si, { ...card, charge: `ch_${t.W}_${++st.seq}` });
    const sess: MockSession = {
      id,
      mode,
      status: "open",
      payment_status: "unpaid",
      url: `https://checkout.stripe.tear.invalid/${id}`,
      expires_at: Number(form.expires_at ?? Math.floor(vnow() / 1000) + 23 * 3600),
      amount_subtotal: unitAmount,
      amount_total: unitAmount,
      payment_intent: pi,
      setup_intent: si,
      invoice: null,
      client_reference_id: attemptId,
      metadata: { bane_attempt: attemptId, bane_workspace: t.W },
    };
    st.sessions.set(id, sess);
    return cacheAndRespond(200, sess);
  }
  const sessMatch = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
  if (sessMatch) {
    const sess = st.sessions.get(decodeURIComponent(sessMatch[1]!));
    if (!sess) return jsonResp(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such session." } });
    if (sessMatch[2] === "/expire" && method === "POST") {
      sess.status = "expired";
      return cacheAndRespond(200, sess);
    }
    return jsonResp(200, sess);
  }

  // Invoices
  if (method === "POST" && path === "/v1/invoices") {
    const id = `in_${t.W}_${++st.seq}`;
    const inv: MockInvoice = {
      id,
      customer: form.customer ?? "",
      status: "draft",
      default_payment_method: form.default_payment_method ?? "",
      metadata: { bane_attempt: form["metadata[bane_attempt]"] ?? "", bane_workspace: t.W },
      created: Math.floor(vnow() / 1000),
      subtotal: 0,
      total: 0,
      total_excluding_tax: 0,
      amount_paid: 0,
      payment_intent: null,
      charge: null,
      hosted_invoice_url: `https://invoice.stripe.tear.invalid/${id}`,
      invoice_pdf: `https://invoice.stripe.tear.invalid/${id}.pdf`,
      lines: { data: [] },
    };
    st.invoices.set(id, inv);
    return cacheAndRespond(200, inv);
  }
  if (method === "POST" && path === "/v1/invoiceitems") {
    const inv = st.invoices.get(form.invoice ?? "");
    if (!inv) return jsonResp(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such invoice." } });
    const amt = Number(form["price_data[unit_amount]"] ?? form.amount ?? 0);
    const lineId = `il_${t.W}_${++st.seq}`;
    inv.subtotal += amt;
    inv.total += amt;
    inv.total_excluding_tax += amt;
    inv.lines.data.push({ id: lineId, amount: amt });
    return cacheAndRespond(200, { id: lineId, amount: amt });
  }
  if (method === "GET" && path === "/v1/invoices/search") {
    const q = form.query ?? "";
    const m = /'([^']+)'/.exec(q);
    const attemptId = m?.[1] ?? "";
    const found = [...st.invoices.values()].filter((i) => i.metadata.bane_attempt === attemptId && i.status !== "deleted");
    return jsonResp(200, { data: found });
  }
  const invMatch = /^\/v1\/invoices\/([^/]+)(?:\/(finalize|pay|void))?$/.exec(path);
  if (invMatch) {
    const inv = st.invoices.get(decodeURIComponent(invMatch[1]!));
    if (!inv || inv.status === "deleted") {
      return jsonResp(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such invoice." } });
    }
    const action = invMatch[2];
    if (method === "GET" && !action) return jsonResp(200, inv);
    if (method === "DELETE" && !action) {
      inv.status = "deleted";
      return jsonResp(200, { id: inv.id, deleted: true });
    }
    if (method === "POST" && action === "finalize") {
      if (inv.status === "draft") inv.status = "open";
      return cacheAndRespond(200, inv);
    }
    if (method === "POST" && action === "void") {
      if (inv.status === "paid") {
        return jsonResp(400, { error: { type: "invalid_request_error", code: "invoice_paid", message: "Cannot void a paid invoice." } });
      }
      inv.status = "void";
      return cacheAndRespond(200, inv);
    }
    if (method === "POST" && action === "pay") {
      const outcome = st.nextPayOutcome;
      if (outcome === "stripe_5xx") {
        return jsonResp(500, { error: { type: "api_error", message: "Stripe pay 500." } });
      }
      if (outcome === "card_declined") {
        return cacheAndRespond(402, {
          error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." },
        });
      }
      if (outcome === "requires_action") {
        return cacheAndRespond(402, {
          error: { type: "card_error", code: "authentication_required", message: "Authentication required." },
        });
      }
      const pi = `pi_${t.W}_${++st.seq}`;
      const ch = `ch_${t.W}_${++st.seq}`;
      const which = inv.default_payment_method.endsWith("_B") ? "B" : "A";
      st.piCard.set(pi, { ...cardInfo(t, which), charge: ch });
      inv.status = "paid";
      inv.payment_intent = pi;
      inv.charge = ch;
      if (outcome === "amount_mismatch") {
        const wrong = Math.max(100, inv.total - 100);
        inv.subtotal = wrong;
        inv.total = wrong;
        inv.total_excluding_tax = wrong;
        inv.amount_paid = wrong;
      } else {
        inv.amount_paid = inv.total;
      }
      return cacheAndRespond(200, inv);
    }
  }

  // PaymentIntents & SetupIntents
  const piMatch = /^\/v1\/(payment_intents|setup_intents)\/([^/]+)$/.exec(path);
  if (method === "GET" && piMatch) {
    const id = decodeURIComponent(piMatch[2]!);
    const info = st.piCard.get(id) ?? { ...cardInfo(t), charge: `ch_${t.W}_${++st.seq}` };
    return jsonResp(200, {
      id,
      payment_method: {
        id: info.pm,
        type: "card",
        card: { brand: "visa", last4: info.last4, exp_month: 12, exp_year: 2030, fingerprint: info.fp },
      },
      latest_charge: { id: info.charge, receipt_url: `https://receipt.stripe.tear.invalid/${info.charge}` },
    });
  }

  // PaymentMethods detach
  if (method === "POST" && /^\/v1\/payment_methods\/[^/]+\/detach$/.test(path)) {
    return cacheAndRespond(200, { id: path.split("/")[3] });
  }

  // Credit notes & refunds
  if (method === "GET" && path === "/v1/credit_notes/preview") {
    const amount = Number(form["lines[0][amount]"] ?? 0);
    return jsonResp(200, { total: amount });
  }
  if (method === "POST" && (path === "/v1/credit_notes" || path === "/v1/refunds")) {
    if (st.nextRefundOutcome === "stripe_5xx") {
      return jsonResp(500, { error: { type: "api_error", message: "Stripe refund 500." } });
    }
    if (st.nextRefundOutcome === "failed") {
      return cacheAndRespond(400, { error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Refund refused." } });
    }
    const reId = `re_${t.W}_${++st.seq}`;
    const amt = Number(form.refund_amount ?? form.amount ?? 0);
    const ref: MockRefund = { id: reId, status: "succeeded", amount: amt };
    st.refunds.set(reId, ref);
    if (path === "/v1/credit_notes") {
      const cnId = `cn_${t.W}_${++st.seq}`;
      return cacheAndRespond(200, { id: cnId, refund: reId, refunds: [{ refund: reId }] });
    }
    return cacheAndRespond(200, ref);
  }
  const refMatch = /^\/v1\/refunds\/([^/]+)$/.exec(path);
  if (method === "GET" && refMatch) {
    const ref = st.refunds.get(decodeURIComponent(refMatch[1]!));
    if (!ref) return jsonResp(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such refund." } });
    return jsonResp(200, ref);
  }

  return jsonResp(404, { error: { type: "invalid_request_error", message: `Unhandled mock Stripe route ${method} ${path}` } });
}) as typeof fetch;

const [
  { nodeRuntime },
  { createApp },
  { sql },
  { rechargeJob },
  { reconcileAttempt },
] = await Promise.all([
  import("../../src/adapters/node.ts"),
  import("../../src/app.ts"),
  import("drizzle-orm"),
  import("../../src/billing/stripe-jobs.ts"),
  import("../../src/billing/stripe.ts"),
]);

const { runtime } = nodeRuntime(env);
const db = runtime.db;
const app = createApp();
const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

let dbPrepared = false;
async function prepareDatabase() {
  if (dbPrepared) return;
  await prepareTearClock((rawSql) => db.execute(sql.raw(rawSql)));
  dbPrepared = true;
}

let traceSeq = 0;
let lastVirtual = 0;

async function setClock(epochMs: number) {
  const start = Math.max(epochMs, lastVirtual + 1);
  clockBase = start;
  lastVirtual = start;
  const off = clockBase - RealDate.now();
  await db.execute(sql`UPDATE tear_clock.state SET off = ${off} * interval '1 millisecond', pinned = to_timestamp(${clockBase / 1000})`);
}

async function api(t: Trial, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    cookie: t.cookie,
    origin: PUBLIC,
    "x-workspace-id": t.W,
    ...extraHeaders,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await app.fetch(
    new Request(PUBLIC + path, {
      method,
      headers,
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
  if (response.status === 401) {
    t.leakedErrors.push(`401 AUTH_REQUIRED on ${method} ${path}`);
  }
  return { status: response.status, body: parsed };
}

async function sendSignedWebhook(t: Trial, type: string, object: Record<string, unknown>, eventId?: string) {
  const id = eventId ?? `evt_${t.W}_${++t.webhookSeq}`;
  const payload = JSON.stringify({ id, type, livemode: false, data: { object } });
  const ts = Math.floor(vnow() / 1000);
  const sig = createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest("hex");
  const response = await app.fetch(
    new Request(PUBLIC + "/v1/billing/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${ts},v1=${sig}`,
      },
      body: payload,
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

async function readAttempts(t: Trial) {
  return q<{
    id: string;
    kind: string;
    status: string;
    amount_uc: string;
    refunded_uc: string;
    failure_code: string | null;
    card_fingerprint: string | null;
    stripe_invoice: string | null;
    stripe_payment_intent: string | null;
    stripe_checkout_session: string | null;
  }>(sql`SELECT id, kind, status, amount_uc::text, refunded_uc::text, failure_code, card_fingerprint, stripe_invoice, stripe_payment_intent, stripe_checkout_session
    FROM billing_payment_attempts WHERE workspace_id=${t.W} ORDER BY created_at ASC, id ASC`);
}

function pickAttempt<T extends { status: string }>(list: T[], target: "latest" | "first" | "uncredited"): T | undefined {
  if (target === "uncredited") return [...list].reverse().find((a) => a.status !== "succeeded");
  if (target === "first") return list[0];
  return list[list.length - 1];
}

async function configureTrial(t: Trial, cfg: BillingPresetCfg): Promise<BillingObs> {
  await assertDisposable((text) => db.execute(sql.raw(text)) as Promise<{ rows: Record<string, unknown>[] }>);
  traceSeq++;
  if (traceSeq === 1) {
    const [{ horizon }] = await q<{ horizon: string }>(sql`SELECT horizon FROM tear_clock.state`);
    lastVirtual = Math.max(lastVirtual, Number(horizon));
  }
  t.epoch = Math.ceil((Math.max(lastVirtual, RealDate.now()) + 3_600_000) / 3_600_000) * 3_600_000;
  t.modelSec = 0;
  await setClock(t.epoch + 50);

  t.W = `tear_${process.pid}_${traceSeq}`;
  t.userId = `tear-user-${process.pid}-${traceSeq}`;
  const token = randomBytes(32).toString("base64url");
  t.cookie = `nightmail.session_token=${token}`;

  // Ensure billing is enforced globally on this disposable DB.
  await db.execute(sql`UPDATE billing_config SET mode='enforce', enforced_at=coalesce(enforced_at, now()) WHERE singleton`);
  await db.execute(sql`INSERT INTO workspaces(id,name,slug) VALUES (${t.W},${t.W},${t.W})`);
  await db.execute(sql`INSERT INTO nightmail_users(id,name,email,email_verified) VALUES (${t.userId},'tear',${t.userId + "@example.com"},true)`);
  await db.execute(sql`INSERT INTO nightmail_oidc_identities(issuer,subject,user_id) VALUES (${ISSUER},${t.userId},${t.userId})`);
  await db.execute(
    sql`INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES (${createHash("sha256").update(token).digest("hex")},${t.userId},${ISSUER},${t.userId},to_timestamp(${(vnow() + 7 * 86_400_000) / 1000}))`,
  );
  await db.execute(sql`INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (${"wm_" + t.W},${t.W},${t.userId},'owner')`);
  await db.execute(sql`INSERT INTO platform_operators(user_id,role,reason) VALUES (${t.userId},'operator','tear billing host') ON CONFLICT (user_id) DO UPDATE SET role='operator'`);

  // Initialize prepaid billing account
  const card = cardInfo(t, "A");
  const cusId = `cus_${t.W}_0`;
  await db.execute(sql`INSERT INTO billing_accounts(workspace_id, mode, stripe_customer, stripe_payment_method, card_brand, card_last4, card_exp_month, card_exp_year, card_fingerprint,
      recharge_enabled, recharge_threshold_uc, recharge_amount_uc, recharge_month_cap_uc)
    VALUES (${t.W}, 'prepaid', ${cusId}, ${cfg.saveCard ? card.pm : null}, ${cfg.saveCard ? "visa" : null}, ${cfg.saveCard ? card.last4 : null},
      ${cfg.saveCard ? 12 : null}, ${cfg.saveCard ? 2030 : null}, ${cfg.saveCard ? card.fp : null},
      ${cfg.autoRechargeEnabled}, ${BigInt(cfg.thresholdCents) * UC_PER_CENT}, ${BigInt(cfg.rechargeAmountCents) * UC_PER_CENT}, ${BigInt(cfg.monthlyCapCents) * UC_PER_CENT})
    ON CONFLICT (workspace_id) DO UPDATE SET mode='prepaid', stripe_customer=excluded.stripe_customer, stripe_payment_method=excluded.stripe_payment_method,
      card_brand=excluded.card_brand, card_last4=excluded.card_last4, card_exp_month=excluded.card_exp_month, card_exp_year=excluded.card_exp_year,
      card_fingerprint=excluded.card_fingerprint, recharge_enabled=excluded.recharge_enabled, recharge_threshold_uc=excluded.recharge_threshold_uc,
      recharge_amount_uc=excluded.recharge_amount_uc, recharge_month_cap_uc=excluded.recharge_month_cap_uc`);

  if (cfg.initialBalanceCents > 0) {
    // Seed initial balance via real top-up attempt + billing_post so ledger, lots, and attempts are 100% real.
    const attId = `bpa_${t.W}_init`;
    const invId = `in_${t.W}_init`;
    const piId = `pi_${t.W}_init`;
    const chId = `ch_${t.W}_init`;
    const amtUc = BigInt(cfg.initialBalanceCents) * UC_PER_CENT;
    t.stripe.invoices.set(invId, {
      id: invId,
      customer: cusId,
      status: "paid",
      default_payment_method: card.pm,
      metadata: { bane_attempt: attId, bane_workspace: t.W },
      created: Math.floor(vnow() / 1000),
      subtotal: cfg.initialBalanceCents,
      total: cfg.initialBalanceCents,
      total_excluding_tax: cfg.initialBalanceCents,
      amount_paid: cfg.initialBalanceCents,
      payment_intent: piId,
      charge: chId,
      hosted_invoice_url: `https://invoice.stripe.tear.invalid/${invId}`,
      invoice_pdf: `https://invoice.stripe.tear.invalid/${invId}.pdf`,
      lines: { data: [{ id: `il_${t.W}_init`, amount: cfg.initialBalanceCents }] },
    });
    t.stripe.piCard.set(piId, { ...card, charge: chId });
    await db.execute(sql`INSERT INTO billing_payment_attempts(id, workspace_id, kind, status, amount_uc, charged_cents, tax_cents, idempotency_key,
        stripe_invoice, stripe_payment_intent, stripe_charge, card_brand, card_last4, card_fingerprint, created_by, settled_at)
      VALUES (${attId}, ${t.W}, 'saved_card', 'succeeded', ${amtUc}, ${cfg.initialBalanceCents}, 0, ${"attempt:" + attId},
        ${invId}, ${piId}, ${chId}, 'visa', ${card.last4}, ${card.fp}, ${"user:" + t.userId}, now())`);
    await db.execute(sql`SELECT billing_post(${t.W}, 'topup', ${"attempt:" + attId}, ${amtUc}::bigint, 0::bigint,
      ${JSON.stringify({ attemptId: attId, kind: "saved_card", invoice: invId })}::jsonb, 'stripe')`);
  }

  t.configured = true;
  return await readObs(t, 200, null);
}

async function readObs(t: Trial, status: number, code: string | null): Promise<BillingObs> {
  const [acc] = await q<{
    balance_uc: string;
    promo_uc: string;
    recharge_enabled: boolean;
    recharge_disabled_reason: string | null;
    has_card: boolean;
    attempt_count: number;
  }>(sql`SELECT balance_uc::text, promo_uc::text, recharge_enabled, recharge_disabled_reason,
    (stripe_payment_method IS NOT NULL) AS has_card,
    (SELECT count(*)::int FROM billing_payment_attempts WHERE workspace_id=${t.W}) AS attempt_count
    FROM billing_accounts WHERE workspace_id=${t.W}`);
  return {
    status,
    code,
    balanceUc: acc?.balance_uc ?? "0",
    promoUc: acc?.promo_uc ?? "0",
    rechargeEnabled: Boolean(acc?.recharge_enabled),
    rechargeDisabledReason: acc?.recharge_disabled_reason ?? null,
    hasSavedCard: Boolean(acc?.has_card),
    attemptCount: acc?.attempt_count ?? 0,
    disputeCount: t.disputes.length,
  };
}

async function readSnapshot(t: Trial): Promise<Observed> {
  if (!t.configured) {
    const snap: BillingSnapshot = {
      configured: false,
      balanceUc: "0",
      promoUc: "0",
      activeLotsRemainingUc: "0",
      activeLotCount: 0,
      rechargeEnabled: false,
      rechargeDisabledReason: null,
      rechargeDisabledAt: null,
      rechargePendingAttempt: null,
      savedCardFingerprint: null,
      ledger: [],
      attempts: [],
      blockedCards: [],
      disputes: [],
      fraudWarnings: [],
      rechargeLoopViolations: [],
      leakedErrors: [],
    };
    return { snapshot: snap, events: [] };
  }

  const [acc] = await q<{
    balance_uc: string;
    promo_uc: string;
    recharge_enabled: boolean;
    recharge_disabled_reason: string | null;
    recharge_disabled_at: string | null;
    recharge_pending_attempt: string | null;
    card_fingerprint: string | null;
  }>(sql`SELECT balance_uc::text, promo_uc::text, recharge_enabled, recharge_disabled_reason,
    recharge_disabled_at::text, recharge_pending_attempt, card_fingerprint
    FROM billing_accounts WHERE workspace_id=${t.W}`);

  const [lots] = await q<{ rem: string; cnt: number }>(sql`SELECT coalesce(sum(remaining_uc), 0)::text AS rem, count(*)::int AS cnt
    FROM billing_credit_lots WHERE workspace_id=${t.W} AND expired_at IS NULL AND remaining_uc > 0`);

  const ledgerRows = await q<{
    id: string;
    kind: string;
    source_id: string;
    paid_uc: string;
    promo_uc: string;
    balance_after_uc: string;
    promo_after_uc: string;
    attempt_id: string | null;
  }>(sql`SELECT l.id::text, l.kind, l.source_id, l.paid_uc::text, l.promo_uc::text, l.balance_after_uc::text, l.promo_after_uc::text,
      CASE WHEN l.source_id LIKE 'attempt:%' THEN substr(l.source_id, 9) ELSE l.detail->>'attemptId' END AS attempt_id
    FROM billing_ledger l WHERE l.workspace_id=${t.W} ORDER BY l.id ASC`);

  const attemptRows = await readAttempts(t);
  const blockedRows = await q<{ fingerprint: string; reason: string }>(
    sql`SELECT fingerprint, reason FROM billing_blocked_cards WHERE fingerprint LIKE ${"fp_" + t.W + "_%"}`,
  );

  if (leaked.length) t.leakedErrors.push(...leaked.splice(0));

  const ledger: LedgerEntrySnap[] = ledgerRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    sourceId: r.source_id,
    paidUc: r.paid_uc,
    promoUc: r.promo_uc,
    balanceAfterUc: r.balance_after_uc,
    promoAfterUc: r.promo_after_uc,
    attemptId: r.attempt_id,
  }));

  const attempts: AttemptSnap[] = attemptRows.map((a) => ({
    id: a.id,
    kind: a.kind,
    status: a.status,
    amountUc: a.amount_uc,
    refundedUc: a.refunded_uc,
    failureCode: a.failure_code,
    cardFingerprint: a.card_fingerprint,
  }));

  let balanceUc = acc?.balance_uc ?? "0";
  // Canary bug: intentionally skew reported balance_uc by +1 uc to verify billing.zero-sum-ledger bites.
  if (t.bug === "canary_ledger_drift" && ledger.length > 0) {
    balanceUc = (BigInt(balanceUc) + 1n).toString();
  }

  const snap: BillingSnapshot = {
    configured: true,
    balanceUc,
    promoUc: acc?.promo_uc ?? "0",
    activeLotsRemainingUc: lots?.rem ?? "0",
    activeLotCount: lots?.cnt ?? 0,
    rechargeEnabled: Boolean(acc?.recharge_enabled),
    rechargeDisabledReason: acc?.recharge_disabled_reason ?? null,
    rechargeDisabledAt: acc?.recharge_disabled_at ?? null,
    rechargePendingAttempt: acc?.recharge_pending_attempt ?? null,
    savedCardFingerprint: acc?.card_fingerprint ?? null,
    ledger,
    attempts,
    blockedCards: blockedRows,
    disputes: [...t.disputes],
    fraudWarnings: [...t.fraudWarnings],
    rechargeLoopViolations: [...t.rechargeLoopViolations],
    leakedErrors: [...t.leakedErrors],
  };
  return { snapshot: snap, events: [] };
}

async function cleanupTrial(t: Trial) {
  if (t.configured) {
    await db.execute(sql`UPDATE jobs SET status='completed' WHERE workspace_id=${t.W} AND status IN ('pending','running')`);
    await db.execute(sql`DELETE FROM billing_blocked_cards WHERE fingerprint LIKE ${"fp_" + t.W + "_%"}`);
    await db.execute(sql`DELETE FROM platform_operators WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM nightmail_sessions WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM nightmail_oidc_identities WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM workspace_members WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM nightmail_users WHERE id=${t.userId}`);
    await db.execute(sql`UPDATE tear_clock.state SET horizon = greatest(horizon, ${Math.ceil(lastVirtual)})`);
  }
  if (activeTrial === t) activeTrial = null;
}

export const billingHost = host(billing, {
  async open(req): Promise<Trial> {
    await prepareDatabase();
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      epoch: 0,
      modelSec: 0,
      W: "",
      userId: "",
      cookie: "",
      stripe: {
        seq: 0,
        idem: new Map(),
        invoices: new Map(),
        sessions: new Map(),
        refunds: new Map(),
        piCard: new Map(),
        nextPayOutcome: "paid",
        nextRefundOutcome: "succeeded",
        activeCard: "A",
      },
      disputes: [],
      disputeEventSeq: 0,
      fraudWarnings: new Set(),
      rechargeLoopViolations: [],
      leakedErrors: [],
      lastTopUpKey: null,
      usageSeq: 0,
      webhookSeq: 0,
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: BillingAction): Promise<BillingObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, BILLING_PRESETS[a.preset]);
    }
    if (!t.configured) throw new Error("billing host: action before Configure");

    if (a.op === "Wait") {
      t.modelSec += a.seconds;
      await setClock(t.epoch + t.modelSec * 1000 + 50);
      return await readObs(t, 200, null);
    }

    await setClock(lastVirtual + 5);
    let status = 200;
    let code: string | null = null;

    switch (a.op) {
      case "TopUp": {
        t.stripe.nextPayOutcome = a.outcome;
        const headers: Record<string, string> = {};
        if (a.reuseKey && t.lastTopUpKey) {
          headers["idempotency-key"] = t.lastTopUpKey;
        } else {
          t.lastTopUpKey = `topup-${t.W}-${++t.stripe.seq}`;
          headers["idempotency-key"] = t.lastTopUpKey;
        }
        const res = await api(t, "POST", "/v1/billing/top-ups", { amountCents: a.amountCents, method: a.method }, headers);
        status = res.status;
        code = res.body?.error?.code ?? res.body?.status ?? null;
        break;
      }

      case "SendUsage": {
        const amtUc = BigInt(a.amountCents) * UC_PER_CENT;
        const src = `usage:${t.W}:${++t.usageSeq}`;
        await db.execute(
          sql`SELECT billing_post(${t.W}, 'usage', ${src}, ${-amtUc}::bigint, 0::bigint, ${JSON.stringify({ meters: { send: { quantity: a.amountCents / 2, costUc: amtUc.toString() } }, charged: true })}::jsonb, 'system')`,
        );
        break;
      }

      case "AutoRechargeTick": {
        t.stripe.nextPayOutcome = a.outcome;
        const beforeAttempts = await readAttempts(t);
        const priorFailedRecharge = beforeAttempts.filter(
          (x) =>
            x.kind === "recharge" &&
            x.status === "failed" &&
            ["amount_mismatch", "card_declined", "insufficient_funds", "authentication_required", "card_blocked"].includes(
              x.failure_code ?? "",
            ),
        );
        const [accBefore] = await q<{ recharge_enabled: boolean; recharge_disabled_at: string | null }>(
          sql`SELECT recharge_enabled, recharge_disabled_at::text FROM billing_accounts WHERE workspace_id=${t.W}`,
        );
        await rechargeJob(runtime, {}, { id: `billing.recharge:${t.W}`, workspaceId: t.W, attempts: 1 });
        const afterAttempts = await readAttempts(t);
        const added = afterAttempts.slice(beforeAttempts.length);
        // Check: if a recharge just failed with amount_mismatch / decline / 3DS / card_blocked, recharge_enabled must now be false.
        const [accAfter] = await q<{ recharge_enabled: boolean; recharge_disabled_at: string | null }>(
          sql`SELECT recharge_enabled, recharge_disabled_at::text FROM billing_accounts WHERE workspace_id=${t.W}`,
        );
        for (const att of added) {
          if (
            att.kind === "recharge" &&
            att.status === "failed" &&
            ["amount_mismatch", "card_declined", "insufficient_funds", "authentication_required", "card_blocked"].includes(
              att.failure_code ?? "",
            ) &&
            accAfter?.recharge_enabled
          ) {
            t.rechargeLoopViolations.push(`recharge ${att.id} failed (${att.failure_code}) but recharge_enabled stayed true`);
          }
        }
        // Check: if recharge was disabled due to a prior failure and never re-enabled, a tick must never create another recharge attempt.
        if (priorFailedRecharge.length > 0 && !accBefore?.recharge_enabled && added.length > 0) {
          t.rechargeLoopViolations.push(`recharge tick created attempt ${added[0]!.id} while auto-recharge was disabled`);
        }
        break;
      }

      case "WebhookInvoicePaid": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        if (a.mode === "late" && ["created", "pending", "requires_action"].includes(target.status)) {
          // Expire the attempt first so the webhook arrives late on a closed attempt.
          await db.execute(sql`UPDATE billing_payment_attempts SET status='expired', settled_at=now(), updated_at=now() WHERE id=${target.id}`);
        }
        const expectedCents = Number(BigInt(target.amount_uc) / UC_PER_CENT);
        const creditCents = a.mode === "amount_mismatch" ? Math.max(100, expectedCents - 100) : expectedCents;
        const invId = target.stripe_invoice ?? `in_${t.W}_wh_${++t.stripe.seq}`;
        const piId = target.stripe_payment_intent ?? `pi_${t.W}_wh_${++t.stripe.seq}`;
        const card = cardInfo(t);
        if (!t.stripe.piCard.has(piId)) t.stripe.piCard.set(piId, { ...card, charge: `ch_${t.W}_${++t.stripe.seq}` });
        if (!t.stripe.invoices.has(invId)) {
          t.stripe.invoices.set(invId, {
            id: invId,
            customer: `cus_${t.W}_0`,
            status: "paid",
            default_payment_method: card.pm,
            metadata: { bane_attempt: target.id, bane_workspace: t.W },
            created: Math.floor(vnow() / 1000),
            subtotal: creditCents,
            total: creditCents,
            total_excluding_tax: creditCents,
            amount_paid: creditCents,
            payment_intent: piId,
            charge: t.stripe.piCard.get(piId)!.charge,
            hosted_invoice_url: `https://invoice.stripe.tear.invalid/${invId}`,
            invoice_pdf: `https://invoice.stripe.tear.invalid/${invId}.pdf`,
            lines: { data: [{ id: `il_${t.W}_${++t.stripe.seq}`, amount: creditCents }] },
          });
        }
        const evObj = {
          id: invId,
          status: "paid",
          subtotal: creditCents,
          total: creditCents,
          total_excluding_tax: creditCents,
          amount_paid: creditCents,
          payment_intent: piId,
          hosted_invoice_url: `https://invoice.stripe.tear.invalid/${invId}`,
          invoice_pdf: `https://invoice.stripe.tear.invalid/${invId}.pdf`,
          metadata: { bane_attempt: target.id, bane_workspace: t.W },
        };
        if (target.kind === "checkout" && a.mode !== "late" && a.mode !== "amount_mismatch") {
          // Deliver checkout.session.completed for checkout top-ups so card gets saved too.
          const sessObj = {
            id: target.stripe_checkout_session ?? `cs_${t.W}_wh_${++t.stripe.seq}`,
            mode: "payment",
            status: "complete",
            payment_status: "paid",
            amount_subtotal: creditCents,
            amount_total: creditCents,
            payment_intent: piId,
            invoice: invId,
            metadata: { bane_attempt: target.id, bane_workspace: t.W },
          };
          const evId = `evt_cs_${target.id}`;
          const r = await sendSignedWebhook(t, "checkout.session.completed", sessObj, a.mode === "duplicate" ? evId : undefined);
          status = r.status;
          if (a.mode === "duplicate") {
            const r2 = await sendSignedWebhook(t, "checkout.session.completed", sessObj, evId);
            status = r2.status;
          }
        } else {
          const evId = `evt_inv_${target.id}`;
          const r = await sendSignedWebhook(t, "invoice.paid", evObj, a.mode === "duplicate" ? evId : undefined);
          status = r.status;
          if (a.mode === "duplicate") {
            const r2 = await sendSignedWebhook(t, "invoice.paid", evObj, evId);
            status = r2.status;
          }
        }
        break;
      }

      case "WebhookInvoiceFailed": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        const invId = target.stripe_invoice ?? `in_${t.W}_fail_${++t.stripe.seq}`;
        const r = await sendSignedWebhook(t, "invoice.payment_failed", {
          id: invId,
          status: "open",
          metadata: { bane_attempt: target.id, bane_workspace: t.W },
          last_payment_error: { code: "card_declined", decline_code: "do_not_honor", message: "Card declined." },
        });
        status = r.status;
        break;
      }

      case "DisputeCreated": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        const dispId = `dp_${t.W}_${++t.stripe.seq}`;
        const amtCents = a.partialCents ?? Number(BigInt(target.amount_uc) / UC_PER_CENT);
        const r = await sendSignedWebhook(t, "charge.dispute.created", {
          id: dispId,
          status: a.status,
          amount: amtCents,
          reason: "fraudulent",
          payment_intent: target.stripe_payment_intent,
          metadata: { bane_attempt: target.id, bane_workspace: t.W },
        });
        status = r.status;
        t.disputes.push({
          disputeId: dispId,
          attemptId: target.id,
          fingerprint: target.card_fingerprint,
          openedStatus: a.status,
          closedStatus: null,
          attemptWasSucceeded: target.status === "succeeded",
          openedSeq: ++t.disputeEventSeq,
          closedSeq: null,
        });
        break;
      }

      case "DisputeClosed": {
        const open = t.disputes.filter((x) => x.closedStatus === null);
        const d = a.target === "first" ? open[0] : open[open.length - 1];
        if (!d) {
          status = 204;
          break;
        }
        const r = await sendSignedWebhook(t, "charge.dispute.closed", {
          id: d.disputeId,
          status: a.status,
          metadata: { bane_attempt: d.attemptId, bane_workspace: t.W },
        });
        status = r.status;
        d.closedStatus = a.status;
        d.closedSeq = ++t.disputeEventSeq;
        break;
      }

      case "EarlyFraudWarning": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        const efwId = `issfr_${t.W}_${++t.stripe.seq}`;
        const r = await sendSignedWebhook(t, "radar.early_fraud_warning.created", {
          id: efwId,
          fraud_type: "made_with_stolen_card",
          payment_intent: target.stripe_payment_intent,
          metadata: { bane_attempt: target.id, bane_workspace: t.W },
        });
        status = r.status;
        if (target.card_fingerprint) t.fraudWarnings.add(target.card_fingerprint);
        break;
      }

      case "ReconcileAttempt": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        // Adjust mock Stripe state for target before calling reconcileAttempt
        if (target.stripe_invoice && t.stripe.invoices.has(target.stripe_invoice)) {
          const inv = t.stripe.invoices.get(target.stripe_invoice)!;
          if (a.stripeState === "paid") {
            inv.status = "paid";
            inv.amount_paid = inv.total;
          } else if (a.stripeState === "void") {
            inv.status = "void";
          } else if (a.stripeState === "missing") {
            inv.status = "deleted";
          } else {
            inv.status = "open";
          }
        }
        if (target.stripe_checkout_session && t.stripe.sessions.has(target.stripe_checkout_session)) {
          const sess = t.stripe.sessions.get(target.stripe_checkout_session)!;
          if (a.stripeState === "paid") {
            sess.status = "complete";
            sess.payment_status = "paid";
          } else if (a.stripeState === "void") {
            sess.status = "expired";
          } else if (a.stripeState === "missing") {
            t.stripe.sessions.delete(target.stripe_checkout_session);
          }
        }
        t.stripe.nextPayOutcome = a.stripeState === "paid" ? "paid" : "card_declined";
        try {
          await reconcileAttempt(runtime, target.id);
        } catch {
          status = 503;
        }
        break;
      }

      case "ForgetCard": {
        const res = await api(t, "DELETE", "/v1/billing/payment-method");
        status = res.status;
        code = res.body?.error?.code ?? null;
        break;
      }

      case "SaveCard": {
        t.stripe.activeCard = a.card;
        const setupRes = await api(t, "POST", "/v1/billing/payment-method");
        status = setupRes.status;
        code = setupRes.body?.error?.code ?? null;
        if (setupRes.status === 201) {
          const attempts = await readAttempts(t);
          const setupAtt = [...attempts].reverse().find((x) => x.kind === "setup");
          if (setupAtt && setupAtt.stripe_checkout_session) {
            const sess = t.stripe.sessions.get(setupAtt.stripe_checkout_session);
            if (sess) {
              sess.status = "complete";
              await sendSignedWebhook(t, "checkout.session.completed", {
                id: sess.id,
                mode: "setup",
                status: "complete",
                setup_intent: sess.setup_intent,
                metadata: { bane_attempt: setupAtt.id, bane_workspace: t.W },
              });
            }
          }
        }
        break;
      }

      case "EnableAutoRecharge": {
        const res = await api(t, "PUT", "/v1/billing/auto-recharge", {
          enabled: true,
          thresholdCents: 1000,
          amountCents: 2500,
          monthlyCapCents: 10_000,
        });
        status = res.status;
        code = res.body?.error?.code ?? null;
        break;
      }

      case "Refund": {
        const attempts = await readAttempts(t);
        const target = pickAttempt(attempts, a.target);
        if (!target) {
          status = 204;
          break;
        }
        t.stripe.nextRefundOutcome = a.outcome;
        const res = await api(
          t,
          "POST",
          `/v1/operator/billing/${t.W}/refunds`,
          {
            attemptId: target.id,
            ...(a.amountCents ? { amountCents: a.amountCents } : {}),
            basis: "billing_error",
            reason: "Tear simulation billing error refund test.",
          },
          { "idempotency-key": `ref-${t.W}-${++t.stripe.seq}` },
        );
        status = res.status;
        code = res.body?.error?.code ?? res.body?.status ?? null;
        break;
      }
    }

    return await readObs(t, status, code);
  },

  async observe(t: Trial): Promise<Observed> {
    return await readSnapshot(t);
  },

  async close(t: Trial): Promise<void> {
    await cleanupTrial(t);
  },
});
