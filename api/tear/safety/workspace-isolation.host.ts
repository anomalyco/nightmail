import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { workspaceIsolation } from "./workspace-isolation.model.ts";
import type {
  AggregatePrincipal,
  FieldProbeFocus,
  McpChunk,
  McpPrincipal,
  OpenApiPrincipal,
  RouteGroup,
  SupportPrincipal,
  WorkspaceIsolationAction,
  WorkspaceIsolationObs,
  WorkspaceIsolationSnapshot,
  WorkspaceSlot,
} from "./workspace-isolation.types.ts";

// Validate disposable database URL & marker FIRST before registering handlers or importing api/src/.
const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");

const pool = new pg.Pool({ connectionString: url, max: 16 });
pool.on("error", () => {});
await assertDisposable((text) => pool.query(text));

// Silence routine app logs unless TEAR_HOST_LOG=1; keep console.error visible.
for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const leaked: string[] = [];
process.on("unhandledRejection", (error) => {
  const msg = error instanceof Error ? error.message : String(error);
  leaked.push(`unhandled-rejection:${msg.slice(0, 140)}`);
});

const PUBLIC = "http://127.0.0.1:8796";
const fixtureIssuer = "https://tear-issuer.invalid";
const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });

// Block ALL outbound network calls; only answer the local OIDC fixture issuer.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const raw = input instanceof Request ? input.url : String(input);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`tear: blocked non-URL fetch ${raw}`);
  }
  if (u.origin === fixtureIssuer) {
    if (u.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: fixtureIssuer, jwks_uri: fixtureIssuer + "/keys" });
    }
    if (u.pathname === "/keys") {
      return Response.json({
        keys: [{ ...signer.publicKey.export({ format: "jwk" }), alg: "ES256", kid: "tear" }],
      });
    }
    return new Response(null, { status: 404 });
  }
  throw new Error(`tear: outbound network blocked (${u.origin})`);
}) as typeof fetch;

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: process.env.BANE_ROOT_SECRET ?? "tear-workspace-isolation-secret-fixed-32chars!",
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  ACCOUNT_ISSUER: fixtureIssuer,
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused-by-session-fixture",
  ENABLE_LIVE_SES: "false",
  NIGHTMAIL_HOSTED_SCREEN: "false",
  NIGHTMAIL_PLACEMENT_SHADOW: "false",
  AWS_EC2_METADATA_DISABLED: "true",
  S3_BUCKET: "tear-wiso",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  API_RATE_LIMIT_PER_MINUTE: "100000",
  DEFAULT_SES_REGION: "us-east-1",
  SHARED_SENDING_REGIONS: "us-east-1",
  SIMULATED_SES_LATENCY_MS: "0",
  SIMULATED_SES_DELIVERY_DELAY_MS: "0",
};

const [
  { createApp, createOpenApiApp },
  { loadConfig },
  { encrypt },
  { buildMcpCatalog },
  { SUPPORT_CEILINGS },
  { SESv2Client },
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/config.ts"),
  import("../../src/operations.ts"),
  import("../../src/mcp-catalog.ts"),
  import("../../src/support-conversations.ts"),
  import("@aws-sdk/client-sesv2"),
]);

// Stub SES client so no AWS calls ever leave the process.
(SESv2Client.prototype as any).send = async function (command: any) {
  const name = command?.constructor?.name ?? "";
  if (name === "GetAccountCommand") {
    return { SendingEnabled: true, SendQuota: { MaxSendRate: 200, Max24HourSend: 50000, SentLast24Hours: 0 } };
  }
  if (name === "SendEmailCommand") return { MessageId: "tear-wiso-ses-" + randomUUID() };
  if (name === "GetEmailIdentityCommand") {
    return { VerifiedForSendingStatus: true, DkimAttributes: { Status: "SUCCESS", SigningEnabled: true } };
  }
  return {};
};

// In-memory storage & R2 bucket so attachment/asset/mail reads work without S3/R2 network I/O.
const storageObjects = new Map<string, { body: Uint8Array; contentType: string }>();
const memoryStorage = {
  async put(key: string, body: Uint8Array, contentType: string) {
    storageObjects.set(key, { body: new Uint8Array(body), contentType });
  },
  async get(key: string) {
    const v = storageObjects.get(key);
    return v ? { body: new Uint8Array(v.body), contentType: v.contentType } : null;
  },
  async stream(key: string) {
    const v = storageObjects.get(key);
    if (!v) return null;
    const copy = new Uint8Array(v.body);
    return { body: new Blob([copy]).stream(), contentType: v.contentType };
  },
  async delete(key: string) {
    storageObjects.delete(key);
  },
  async list(prefix: string) {
    const objects = [...storageObjects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key, uploaded: new Date() }));
    return { objects };
  },
};

const mailR2Bucket = {
  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
    storageObjects.set(`r2:${key}`, { body: bytes, contentType: "application/octet-stream" });
    return { key };
  },
  async get(key: string) {
    const v = storageObjects.get(`r2:${key}`) ?? storageObjects.get(key);
    if (!v) return null;
    const copy = new Uint8Array(v.body);
    return {
      body: new Blob([copy]).stream(),
      size: copy.byteLength,
      async arrayBuffer() {
        return copy.buffer;
      },
    };
  },
  async head(key: string) {
    const v = storageObjects.get(`r2:${key}`) ?? storageObjects.get(key);
    return v ? { key, size: v.body.byteLength } : null;
  },
  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) {
      storageObjects.delete(`r2:${k}`);
      storageObjects.delete(k);
    }
  },
  async list() {
    return { objects: [...storageObjects.keys()].map((key) => ({ key })), truncated: false };
  },
};

const config = loadConfig(env);
const runtime: any = {
  db: drizzle(pool),
  storage: memoryStorage,
  config,
  mailR2: { bucket: mailR2Bucket, name: "tear-mail", write: true },
  webhookFetch: async () => new Response("ok", { status: 200 }),
};
const app = createApp();
const mcpCatalog = buildMcpCatalog(await createOpenApiApp());

// ---------- Dynamic OpenAPI route enumeration ----------
interface OpenApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operationId: string;
  group: RouteGroup;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

const { registeredDocument: openapiDoc } = await import("../../scripts/registered-document.js");

function classifyGroup(p: string, method?: string): RouteGroup {
  if (
    p === "/v1/me" ||
    p.startsWith("/v1/api-keys") ||
    p.startsWith("/v1/agent-tokens") ||
    p.startsWith("/v1/agents") ||
    p.startsWith("/v1/mcp-connections")
  )
    return "auth";
  if (
    p.startsWith("/v1/contacts") ||
    p.startsWith("/v1/lists") ||
    p.startsWith("/v1/segments") ||
    p.startsWith("/v1/contact-imports") ||
    p.startsWith("/v1/audience-query") ||
    p.startsWith("/v1/newsletters")
  )
    return "audience";
  if (p.startsWith("/v1/templates") || p.startsWith("/v1/template-assets")) return "templates";
  if (p.startsWith("/v1/emails") || p.startsWith("/v1/attachments")) return "emails";
  if (p.startsWith("/v1/campaigns") || p === "/v1/campaign-content-guide") return "campaigns";
  if (p.startsWith("/v1/domains") || p.startsWith("/v1/regions") || p.startsWith("/v1/connection")) return "domains";
  if (p.startsWith("/v1/webhooks") || p.startsWith("/v1/events") || p.startsWith("/unsubscribe")) return "webhooks";
  if (
    p.startsWith("/v1/settings") ||
    p === "/v1/metrics" ||
    p.startsWith("/v1/sender-score") ||
    p === "/v1/usage" ||
    p === "/v1/logs" ||
    p === "/v1/activity" ||
    p.startsWith("/v1/overview") ||
    p.startsWith("/v1/public") ||
    p === "/v1/contact-support"
  )
    return "ops";
  if (p.startsWith("/v1/routing") || p.startsWith("/v1/rules") || p.startsWith("/v1/endpoints")) return "routing-rules";
  if (p.startsWith("/v1/inboxes") || p.startsWith("/v1/inbox-connections") || p === "/v1/app-passwords") return "inboxes";

  if (
    p.startsWith("/v1/inbound/threads") ||
    p.startsWith("/v1/inbound/messages") ||
    p === "/v1/inbound/events" ||
    p === "/v1/inbound/overview" ||
    p === "/v1/inbound/endpoints" ||
    p.startsWith("/v1/inbound/webhooks")
  )
    return "inbound-mail";
  if (p.startsWith("/v1/inbound/")) return "inbound-config";
  if (p.startsWith("/v1/workspaces")) return "workspaces";
  if (p.startsWith("/v1/billing")) return "billing";
  return "other";
}

const OPENAPI_ROUTES: OpenApiRoute[] = [];
for (const [p, item] of Object.entries<any>(openapiDoc.paths ?? {})) {
  for (const m of ["get", "post", "put", "patch", "delete"] as const) {
    const op = item[m];
    if (!op) continue;
    const params: any[] = op.parameters ?? [];
    OPENAPI_ROUTES.push({
      method: m.toUpperCase() as OpenApiRoute["method"],
      path: p,
      operationId: op.operationId ?? `${m}:${p}`,
      group: classifyGroup(p, m.toUpperCase()),
      pathParams: params.filter((x) => x.in === "path").map((x) => x.name),
      queryParams: params.filter((x) => x.in === "query").map((x) => x.name),
      hasBody: Boolean(op.requestBody),
    });
  }
}

const ROUTES_BY_GROUP = new Map<RouteGroup, OpenApiRoute[]>();
for (const r of OPENAPI_ROUTES) {
  const arr = ROUTES_BY_GROUP.get(r.group) ?? [];
  arr.push(r);
  ROUTES_BY_GROUP.set(r.group, arr);
}

// ---------- Dynamic DB table discovery for full workspace snapshot (Invariant 2) ----------
const wsTablesRes = await pool.query<{ table_name: string }>(
  `SELECT DISTINCT c.table_name
   FROM information_schema.columns c
   JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'workspace_id'
   ORDER BY c.table_name`,
);
const WORKSPACE_ID_TABLES = wsTablesRes.rows.map((r) => r.table_name);

// Build one single SQL statement that hashes EVERY workspace-scoped table for the 3 trial workspaces.
const SNAPSHOT_SQL = [
  `SELECT 'workspaces' AS tbl, id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM workspaces t WHERE id = ANY($1::text[]) GROUP BY id`,
  ...WORKSPACE_ID_TABLES.map(
    (tbl) =>
      `SELECT '${tbl}' AS tbl, workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM "${tbl}" t WHERE workspace_id = ANY($1::text[]) GROUP BY workspace_id`,
  ),
  `SELECT 'inbox_folders' AS tbl, m.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM inbox_folders t JOIN mailboxes m ON m.id = t.inbox_id WHERE m.workspace_id = ANY($1::text[]) GROUP BY m.workspace_id`,
  `SELECT 'inbox_entries' AS tbl, m.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM inbox_entries t JOIN mailboxes m ON m.id = t.inbox_id WHERE m.workspace_id = ANY($1::text[]) GROUP BY m.workspace_id`,
  `SELECT 'inbox_app_passwords' AS tbl, m.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM inbox_app_passwords t JOIN mailboxes m ON m.id = t.inbox_id WHERE m.workspace_id = ANY($1::text[]) GROUP BY m.workspace_id`,
  `SELECT 'inbox_vanished' AS tbl, m.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM inbox_vanished t JOIN mailboxes m ON m.id = t.inbox_id WHERE m.workspace_id = ANY($1::text[]) GROUP BY m.workspace_id`,
  `SELECT 'sending_review_recipients' AS tbl, r.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM sending_review_recipients t JOIN sending_campaign_reviews r ON r.id = t.review_id WHERE r.workspace_id = ANY($1::text[]) GROUP BY r.workspace_id`,
  `SELECT 'provider_connection_regions' AS tbl, pc.workspace_id AS ws, count(*)::int AS cnt, md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS h FROM provider_connection_regions t JOIN provider_connections pc ON pc.id = t.connection_id WHERE pc.workspace_id = ANY($1::text[]) GROUP BY pc.workspace_id`,
].join("\nUNION ALL\n");

type WsDigest = Map<string, string>; // key: `${ws}:${tbl}` -> `${cnt}:${h}`

async function snapshotWorkspaces(wsIds: string[]): Promise<WsDigest> {
  const { rows } = await pool.query<{ tbl: string; ws: string; cnt: number; h: string }>(SNAPSHOT_SQL, [wsIds]);
  const map: WsDigest = new Map();
  for (const r of rows) map.set(`${r.ws}:${r.tbl}`, `${r.cnt}:${r.h}`);
  // Also hash in-memory storage keys referencing any workspace id.
  for (const w of wsIds) {
    const keys = [...storageObjects.keys()]
      .filter((k) => k.includes(w))
      .sort()
      .map((k) => `${k}:${storageObjects.get(k)!.body.byteLength}`);
    if (keys.length) map.set(`${w}:__storage`, createHash("md5").update(keys.join("\n")).digest("hex"));
  }
  return map;
}

function beginSlotTracking(t: Trial, ownSlots: WorkspaceSlot[]) {
  const tracker = { own: new Set<WorkspaceSlot>(ownSlots), overlapped: new Set<WorkspaceSlot>() };
  // Any already-running action's own slots overlap us, and our own slots overlap them.
  for (const other of t.activeTrackers) {
    for (const s of other.own) tracker.overlapped.add(s);
    for (const s of tracker.own) other.overlapped.add(s);
  }
  t.activeTrackers.add(tracker);
  return {
    watchIds(foreignSlots: WorkspaceSlot[]): string[] {
      return foreignSlots.filter((s) => !tracker.overlapped.has(s)).map((s) => t.ws[s].id);
    },
    end() {
      t.activeTrackers.delete(tracker);
    },
  };
}

function diffWorkspaces(before: WsDigest, after: WsDigest, watchWsIds: string[]): string[] {
  const watch = new Set(watchWsIds);
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  const diffs: string[] = [];
  for (const k of allKeys) {
    const ws = k.slice(0, k.indexOf(":"));
    if (!watch.has(ws)) continue;
    const b = before.get(k) ?? "0:empty";
    const a = after.get(k) ?? "0:empty";
    if (b !== a) diffs.push(`${k} (${b} -> ${a})`);
  }
  return diffs;
}

// ---------- Seeded Workspace Fixture ----------
interface SeededWorkspace {
  slot: WorkspaceSlot;
  id: string;
  name: string;
  slug: string;
  marker: string;
  postalAddress: string;
  domainName: string;
  domainId: string;
  mailboxDomainId: string;
  mailboxSubdomainId: string;
  hostedChildName: string;
  hostedChildReceivingHost: string;
  connectionId: string;
  ownerUserId: string;
  ownerMemberId: string;
  ownerCookie: string;
  ownerEmail: string;
  invitationId: string;
  apiKeyId: string;
  apiKeySecret: string;
  domainKeyId: string;
  domainKeySecret: string;
  mailboxKeyId: string;
  allAddrKeyId: string;
  agentTokenId: string;
  mcpGrantId: string;
  contactIds: string[];
  listIds: string[];
  newsletterId: string;
  segmentIds: string[];
  importIds: string[];
  planId: string;
  templateId: string;
  templateAssetId: string;
  attachmentId: string;
  campaignDraftId: string;
  campaignPausedId: string;
  campaignReviewId: string;
  emailIds: string[];
  emailScheduledId: string;
  emailEventId: string;
  unsubTokenRaw: string;
  webhookId: string;
  webhookDeliveryId: string;
  inboundWebhookId: string;
  inboundWebhookDeliveryId: string;
  endpointId: string;
  endpointKey: string;
  forwardEndpointKey: string;
  routeId: string;
  ruleKey: string;
  inboxId: string;
  endedInboxId: string;
  addressId: string;
  addressEmail: string;
  inboxEmail: string;
  customFolderRole: string;
  appPasswordId: string;
  threadId: string;
  inboundMessageId: string;
  mailAttachmentId: string;
  retiredAddress: string;
  paymentId: string;
  cardLast4: string;
  balanceUc: string;
  handoffId: string;
  convId: string;
  supportNoteId: string;
  supportActionId: string;
  forbiddenTokens: string[];
}

interface Trial {
  bug?: string;
  tag: string;
  ws: Record<WorkspaceSlot, SeededWorkspace>;
  wsIds: string[];
  adminAUserId: string;
  adminACookie: string;
  memberAUserId: string;
  memberACookie: string;
  dualUserId: string;
  dualCookie: string;
  dualMemberAId: string;
  dualMemberBId: string;
  mcpAAccess: string;
  mcpDualAccess: string;
  supportDualAConvId: string;
  supportDualABConvId: string;
  userIds: string[];
  convIds: string[];
  // Metrics & findings
  totalRoutesDriven: number;
  uniqueOpenApiRoutesDriven: Set<string>;
  uniqueSupportRoutesDriven: Set<string>;
  uniqueMcpToolsDriven: Set<string>;
  leaks: string[];
  foreignMutations: string[];
  probeOracles: string[];
  aggregateMismatches: string[];
  dualViolations: string[];
  unexpectedErrors: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
  canaryMutated: boolean;
  initialSnapC: WsDigest;
  activeTrackers: Set<{ own: Set<WorkspaceSlot>; overlapped: Set<WorkspaceSlot> }>;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function randBase32(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += BASE32[bytes[i]! & 31];
  return out;
}
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function createUser(
  userIds: string[],
  name: string,
  email: string,
): Promise<{ id: string; cookie: string; email: string }> {
  const id = `tear-user-${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  userIds.push(id);
  await pool.query(
    `INSERT INTO nightmail_users(id,name,email,email_verified,mailbox_proved,mailbox_proved_at)
     VALUES ($1,$2,$3,true,$3,now())`,
    [id, name, email],
  );
  await pool.query(`INSERT INTO nightmail_oidc_identities(issuer,subject,user_id) VALUES ($1,$2,$2)`, [
    fixtureIssuer,
    id,
  ]);
  await pool.query(
    `INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,verified_email,expires_at)
     VALUES ($1,$2,$3,$2,$4,now() + interval '7 days')`,
    [sha256(token), id, fixtureIssuer, email],
  );
  return { id, cookie: `nightmail.session_token=${token}`, email };
}

function mintJwt(userId: string, clientId: string, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: fixtureIssuer,
    sub: userId,
    aud: PUBLIC + "/mcp",
    client_id: clientId,
    scope,
    acr: "urn:anomaly:acr:google",
    jti: randomUUID(),
    iat: now,
    exp: now + 3600,
  };
  const body = [{ alg: "ES256", typ: "at+jwt", kid: "tear" }, claims]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".");
  const sig = Buffer.from(
    sign("sha256", Buffer.from(body), { key: signer.privateKey, dsaEncoding: "ieee-p1363" }),
  ).toString("base64url");
  return `${body}.${sig}`;
}

async function seedWorkspace(
  slot: WorkspaceSlot,
  idx: number, // 1 for A, 2 for B, 3 for C — gives distinct counts!
  tag: string,
  userIds: string[],
  convIds: string[],
): Promise<SeededWorkspace> {
  const sl = slot.toLowerCase();
  const marker = `MRK${slot === "A" ? "ALPHA" : slot === "B" ? "BRAVO" : "CHARL"}${hex(4).toUpperCase()}`;
  const mLow = marker.toLowerCase();
  const wsId = `tear_wiso_${sl}_${tag}`;
  const wsName = `Workspace ${slot} ${marker}`;
  const wsSlug = `ws-${sl}-${mLow}`;
  const postalAddress = `${idx}00 ${marker} Blvd, Suite ${idx}, Austin, TX 78701`;
  const region = "us-east-1";
  const domainName = `${mLow}.example.com`;
  const domainId = `dom_${hex(12)}`;
  const mailboxDomainId = `mbd_${hex(12)}`;
  const mailboxSubdomainId = `mbd_${hex(12)}`;
  const connectionId = `con_${hex(12)}`;

  // 1. Workspace, settings, regions, provider connection, standing
  await pool.query(
    `INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$2,$3,$4)`,
    [wsId, wsName, wsSlug, postalAddress],
  );
  await pool.query(
    `INSERT INTO operation_settings(workspace_id,name,postal_address) VALUES ($1,$2,$3)`,
    [wsId, wsName, postalAddress],
  );
  await pool.query(
    `INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [wsId, `inst_${hex(8)}`, region, JSON.stringify([region])],
  );
  await pool.query(
    `INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state)
     VALUES ($1,$2,'shared',$3,'ready','ready')`,
    [connectionId, wsId, region],
  );
  await pool.query(
    `INSERT INTO provider_connection_regions(connection_id,region,sending_state,receiving_state,tenant_state)
     VALUES ($1,$2,'ready','active','ready')
     ON CONFLICT (connection_id, region) DO UPDATE SET sending_state='ready', receiving_state='active', tenant_state='ready'`,
    [connectionId, region],
  );
  await pool.query(
    `INSERT INTO sender_standing(workspace_id,phase,score,daily_limit,step,reasons,factors,strikes)
     VALUES ($1,'graded',$2,$3,'ok','[]'::jsonb,'{}'::jsonb,'[]'::jsonb)`,
    [wsId, 90 + idx, 1000 * idx],
  );

  // 2. Owner user, membership, invitation
  const owner = await createUser(userIds, `Owner ${marker}`, `owner-${mLow}@example.com`);
  const ownerMemberId = `mem_${hex(12)}`;
  await pool.query(
    `INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'owner')`,
    [ownerMemberId, wsId, owner.id],
  );
  const invitationId = `inv_${hex(12)}`;
  await pool.query(
    `INSERT INTO workspace_invitations(id,workspace_id,email,role,status,expires_at,inviter_id)
     VALUES ($1,$2,$3,'member','pending',now() + interval '7 days',$4)`,
    [invitationId, wsId, `invitee-${mLow}@example.com`, owner.id],
  );

  // 3. Domains & mailbox_domains
  await pool.query(
    `INSERT INTO operation_domains(id,workspace_id,name,region) VALUES ($1,$2,$3,$4)`,
    [domainId, wsId, domainName, region],
  );
  await pool.query(
    `INSERT INTO domain_claims(name,workspace_id,claim_scope,connection_id,sending_state,receiving_state,receiving_host,ever_proven,identity)
     VALUES ($1,$2,'exclusive',$3,'verified','active',$1,true,$4::jsonb)`,
    [
      domainName,
      wsId,
      connectionId,
      JSON.stringify({ ses: { DkimAttributes: { Status: "SUCCESS", SigningEnabled: true } } }),
    ],
  );
  await pool.query(
    `INSERT INTO domain_sending_bindings(workspace_id,name,domain_id,connection_id,region)
     VALUES ($1,$2,$3,$4,$5)`,
    [wsId, domainName, domainId, connectionId, region],
  );
  await pool.query(
    `INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,receiving_host,region,status,catch_all)
     VALUES ($1,$2,$3,$4,$4,$5,'active','store')`,
    [mailboxDomainId, wsId, domainId, domainName, region],
  );
  const hostedChildName = `child-${mLow}.${domainName}`;
  const hostedChildReceivingHost = `rx-${mLow}.${domainName}`;
  await pool.query(
    `INSERT INTO mailbox_domains(id,workspace_id,domain_id,parent_id,name,receiving_host,region,status,catch_all)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active','store')`,
    [mailboxSubdomainId, wsId, domainId, mailboxDomainId, hostedChildName, hostedChildReceivingHost, region],
  );

  // 4. API keys, MCP grant, agent token
  const apiKeySecret = `nm_${hex(32)}`;
  const apiKeyId = `key_${hex(12)}`;
  await pool.query(
    `INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains)
     VALUES ($1,$2,$3,$4,$5,'["read","send","manage"]'::jsonb,'[]'::jsonb)`,
    [apiKeyId, wsId, `Key ${marker}`, sha256(apiKeySecret), apiKeySecret.slice(0, 14)],
  );
  const domainKeySecret = `nm_${hex(32)}`;
  const domainKeyId = `key_${hex(12)}`;
  await pool.query(
    `INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains)
     VALUES ($1,$2,$3,$4,$5,'["read","send","manage"]'::jsonb,$6::jsonb)`,
    [domainKeyId, wsId, `DomKey ${marker}`, sha256(domainKeySecret), domainKeySecret.slice(0, 14), JSON.stringify([domainName])],
  );
  const mcpGrantId = `mcp_at_${hex(16)}`;
  await pool.query(
    `INSERT INTO nightmail_resource_grants(id,issuer,subject,workspace_id,permissions,expires_at,client_id,revoked,receiving,user_id,issued_at,profile)
     VALUES ($1,$2,$3,$4,ARRAY['read','send','manage'],now() + interval '7 days',$5,false,true,$3,$6,'default')`,
    [mcpGrantId, fixtureIssuer, owner.id, wsId, `client-${mLow}`, Math.floor(Date.now() / 1000)],
  );
  const agentTokenId = `agt_${hex(12)}`;
  await pool.query(
    `INSERT INTO agent_tokens(id,workspace_id,grant_id,permissions,domains,purpose,expires_at)
     VALUES ($1,$2,$3,'["read","send"]'::jsonb,'[]'::jsonb,$4,now() + interval '1 day')`,
    [agentTokenId, wsId, mcpGrantId, `Purpose ${marker}`],
  );

  // 5. Contacts (idx + 1 distinct contacts: A=2, B=3, C=4), consent audit, lists, newsletter, segments, imports, plan
  const contactIds: string[] = [];
  for (let i = 1; i <= idx + 1; i++) {
    const cid = `con_${hex(12)}`;
    contactIds.push(cid);
    await pool.query(
      `INSERT INTO audience_contacts(id,workspace_id,email,name,properties,marketing_consent)
       VALUES ($1,$2,$3,$4,$5::jsonb,'subscribed')`,
      [cid, wsId, `contact-${i}-${mLow}@example.com`, `Contact ${i} ${marker}`, JSON.stringify({ plan: marker })],
    );
  }
  await pool.query(
    `INSERT INTO audience_consent_audit(id,workspace_id,contact_id,email,status,source,evidence,occurred_at)
     VALUES ($1,$2,$3,$4,'subscribed','api',$5,now())`,
    [`cau_${hex(12)}`, wsId, contactIds[0]!, `contact-1-${mLow}@example.com`, `Evidence ${marker}`],
  );

  const listIds: string[] = [];
  for (let i = 1; i <= idx; i++) {
    const lid = `lst_${hex(12)}`;
    listIds.push(lid);
    await pool.query(
      `INSERT INTO audience_lists(id,workspace_id,name,description) VALUES ($1,$2,$3,$4)`,
      [lid, wsId, `List ${i} ${marker}`, `Desc ${marker}`],
    );
    await pool.query(
      `INSERT INTO audience_list_members(workspace_id,list_id,contact_id) VALUES ($1,$2,$3)`,
      [wsId, lid, contactIds[0]!],
    );
  }
  const newsletterId = `lst_${hex(12)}`;
  listIds.push(newsletterId);
  await pool.query(
    `INSERT INTO audience_lists(id,workspace_id,name,description,newsletter_from,newsletter_from_name)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newsletterId, wsId, `Newsletter ${marker}`, `NL ${marker}`, `news@${domainName}`, `News ${marker}`],
  );
  await pool.query(
    `INSERT INTO audience_list_members(workspace_id,list_id,contact_id) VALUES ($1,$2,$3)`,
    [wsId, newsletterId, contactIds[0]!],
  );

  const segmentIds: string[] = [];
  for (let i = 1; i <= idx; i++) {
    const sid = `seg_${hex(12)}`;
    segmentIds.push(sid);
    await pool.query(
      `INSERT INTO audience_segments(id,workspace_id,name,rule) VALUES ($1,$2,$3,$4::jsonb)`,
      [sid, wsId, `Segment ${i} ${marker}`, JSON.stringify({ field: "email", operator: "contains", value: mLow })],
    );
  }

  const importIds: string[] = [];
  for (let i = 1; i <= idx; i++) {
    const iid = `imp_${hex(12)}`;
    importIds.push(iid);
    const st = i === 1 ? "committed" : "preview";
    await pool.query(
      `INSERT INTO audience_imports(id,workspace_id,list_id,status,rows,errors,imported)
       VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6)`,
      [
        iid,
        wsId,
        listIds[0]!,
        st,
        JSON.stringify([{ row: 1, email: `imp-${i}-${mLow}@example.com`, name: `Imp ${marker}`, properties: {} }]),
        st === "committed" ? 1 : 0,
      ],
    );
  }

  const planId = `aqp_${hex(16)}`;
  await pool.query(
    `INSERT INTO audience_operation_plans(id,workspace_id,actor_key_id,statement,operation,matched,expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,1,now() + interval '1 hour')`,
    [
      planId,
      wsId,
      apiKeyId,
      `UPDATE contacts SET name = '${marker}' WHERE email CONTAINS '${mLow}'`,
      JSON.stringify({ kind: "add_to_list", targetIds: [contactIds[0]!], listId: listIds[0]! }),
    ],
  );

  // 6. Templates, template assets, sending attachments
  const templateId = `tpl_${hex(16)}`;
  const tplDraft = {
    name: `Template ${marker}`,
    description: `TplDesc ${marker}`,
    subject: `TplSubj ${marker}`,
    replyTo: [],
    html: `<p>Hello ${marker}</p>`,
    attachments: [],
  };
  await pool.query(
    `INSERT INTO campaign_templates(id,workspace_id,revision,draft,published,published_revision)
     VALUES ($1,$2,1,$3::jsonb,$3::jsonb,1)`,
    [templateId, wsId, JSON.stringify(tplDraft)],
  );

  const templateAssetId = `tas_${hex(12)}`;
  const tplAssetKey = `${wsId}/template-assets/${templateAssetId}.txt`;
  const tplAssetBytes = new TextEncoder().encode(`TemplateAssetBytes ${marker}`);
  await memoryStorage.put(tplAssetKey, tplAssetBytes, "text/plain");
  await pool.query(
    `INSERT INTO template_assets(id,workspace_id,filename,content_type,size,disposition,storage_key,checksum)
     VALUES ($1,$2,$3,'text/plain',$4,'attachment',$5,$6)`,
    [templateAssetId, wsId, `asset-${mLow}.txt`, tplAssetBytes.byteLength, tplAssetKey, sha256(`TemplateAssetBytes ${marker}`)],
  );

  const attachmentId = `att_${hex(12)}`;
  const attKey = `${wsId}/attachments/${attachmentId}.txt`;
  const attBytes = new TextEncoder().encode(`AttachmentBytes ${marker}`);
  await memoryStorage.put(attKey, attBytes, "text/plain");
  await pool.query(
    `INSERT INTO sending_attachments(id,workspace_id,filename,content_type,size,disposition,storage_key,checksum,uploaded_by)
     VALUES ($1,$2,$3,'text/plain',$4,'attachment',$5,$6,$7)`,
    [attachmentId, wsId, `file-${mLow}.txt`, attBytes.byteLength, attKey, sha256(`AttachmentBytes ${marker}`), apiKeyId],
  );

  // 7. Campaigns (1 draft + 1 paused with review)
  const campaignDraftId = `cmp_${hex(12)}`;
  const campDraft = {
    name: `CampaignDraft ${marker}`,
    from: `news@${domainName}`,
    region,
    subject: `CampSubj ${marker}`,
    html: `<p>Campaign body ${marker}</p>`,
    attachments: [attachmentId],
    tracking: true,
    audience: { listId: listIds[0]! },
    defaults: {},
  };
  await pool.query(
    `INSERT INTO sending_campaigns(id,workspace_id,revision,draft,state,actor_key_id)
     VALUES ($1,$2,1,$3::jsonb,'draft',$4)`,
    [campaignDraftId, wsId, JSON.stringify(campDraft), apiKeyId],
  );
  await pool.query(
    `INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id) VALUES ($1,$2,'campaign',$3)`,
    [wsId, attachmentId, campaignDraftId],
  );

  const campaignPausedId = `cmp_${hex(12)}`;
  const campaignReviewId = `rev_${hex(12)}`;
  await pool.query(
    `INSERT INTO sending_campaign_reviews(id,workspace_id,campaign_id,revision,draft,content_hash)
     VALUES ($1,$2,$3,1,$4::jsonb,$5)`,
    [campaignReviewId, wsId, campaignPausedId, JSON.stringify({ ...campDraft, name: `CampaignPaused ${marker}` }), sha256(marker)],
  );
  await pool.query(
    `INSERT INTO sending_campaigns(id,workspace_id,revision,draft,state,review_id,paused_at,pause_reason,total,prepared,expanded,actor_key_id)
     VALUES ($1,$2,1,$3::jsonb,'paused',$4,now(),$5::jsonb,1,1,0,$6)`,
    [
      campaignPausedId,
      wsId,
      JSON.stringify({ ...campDraft, name: `CampaignPaused ${marker}` }),
      campaignReviewId,
      JSON.stringify({ code: "MANUAL_PAUSE", message: `Paused ${marker}` }),
      apiKeyId,
    ],
  );
  await pool.query(
    `INSERT INTO sending_review_recipients(review_id,ordinal,recipient,recipient_bytes,subject,snapshot_bytes)
     VALUES ($1,1,$2::jsonb,64,$3,128)`,
    [campaignReviewId, JSON.stringify({ id: contactIds[0], email: `contact-1-${mLow}@example.com`, properties: {} }), `CampSubj ${marker}`],
  );

  // 8. Sending emails (idx + 1 distinct emails: A=2, B=3, C=4), email events, operation events, unsubscribe token
  const emailIds: string[] = [];
  let emailScheduledId = "";
  for (let i = 1; i <= idx + 1; i++) {
    const eid = `eml_${hex(12)}`;
    emailIds.push(eid);
    const isSched = i === idx + 1;
    if (isSched) emailScheduledId = eid;
    const snap = {
      from: `sender@${domainName}`,
      to: [`rcpt-${i}-${mLow}@example.com`],
      cc: [],
      bcc: [],
      replyTo: [],
      region,
      kind: "transactional",
      subject: `SentSubj ${i} ${marker}`,
      html: `<p>SentHtml ${i} ${marker}</p>`,
      text: `SentText ${i} ${marker}`,
      attachments: [],
      tracking: false,
      headers: [],
    };
    await pool.query(
      `INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,snapshot,simulated,scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'[]'::jsonb,'[]'::jsonb,$7,$8,$9::jsonb,true,$10)`,
      [
        eid,
        wsId,
        region,
        apiKeyId,
        snap.from,
        JSON.stringify(snap.to),
        snap.subject,
        isSched ? "scheduled" : "delivered",
        JSON.stringify(snap),
        isSched ? new Date(Date.now() + 3600_000).toISOString() : null,
      ],
    );
  }
  const emailEventId = `evt_${hex(12)}`;
  await pool.query(
    `INSERT INTO sending_email_events(id,workspace_id,email_id,type,data,simulated)
     VALUES ($1,$2,$3,'delivery',$4::jsonb,true)`,
    [emailEventId, wsId, emailIds[0]!, JSON.stringify({ note: marker })],
  );
  await pool.query(
    `INSERT INTO operation_events(id,workspace_id,type,region,data,created_at)
     VALUES ($1,$2,'email.delivered',$3,$4::jsonb,now())`,
    [emailEventId, wsId, region, JSON.stringify({ emailId: emailIds[0]!, note: marker })],
  );
  const unsubTokenRaw = `unsub_${hex(16)}`;
  await pool.query(
    `INSERT INTO operation_unsubscribe_tokens(token_hash,workspace_id,email)
     VALUES ($1,$2,$3)`,
    [sha256(unsubTokenRaw), wsId, `contact-1-${mLow}@example.com`],
  );

  // 9. Sending webhooks & deliveries
  const webhookId = `whk_${hex(12)}`;
  const encSecret = await encrypt(runtime, `whsec_${hex(16)}`, `${wsId}:webhook:${webhookId}`);
  await pool.query(
    `INSERT INTO operation_webhooks(id,workspace_id,url,description,event_types,encrypted_secret)
     VALUES ($1,$2,$3,$4,'["email.delivered"]'::jsonb,$5)`,
    [webhookId, wsId, `https://hooks.${domainName}/events`, `Webhook ${marker}`, encSecret],
  );
  const webhookDeliveryId = `dlv_${hex(12)}`;
  await pool.query(
    `INSERT INTO operation_deliveries(id,workspace_id,webhook_id,event_id,payload,status,attempt_count,last_status_code,last_error)
     VALUES ($1,$2,$3,$4,$5::jsonb,'failed',1,500,$6)`,
    [
      webhookDeliveryId,
      wsId,
      webhookId,
      emailEventId,
      JSON.stringify({ id: emailEventId, type: "email.delivered", createdAt: new Date().toISOString(), workspaceId: wsId, region, data: { emailId: emailIds[0]!, marker } }),
      `HookErr ${marker}`,
    ],
  );

  // 10. Inboxes, addresses, folders, app passwords, threads, inbound messages, mail attachments, events, retired address
  const addressId = `mbx_${hex(12)}`;
  const addressEmail = `support@${domainName}`;
  await pool.query(
    `INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,kind,key)
     VALUES ($1,$2,$3,$4,$5,'address',$6)`,
    [addressId, wsId, mailboxDomainId, addressEmail, `Addr ${marker}`, `addr_${mLow}`],
  );
  await pool.query(
    `INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES ($1,$2,$3,'primary')`,
    [wsId, addressEmail, addressId],
  );
  await pool.query(`INSERT INTO inbox_state(inbox_id,workspace_id,messages) VALUES ($1,$2,1) ON CONFLICT (inbox_id) DO UPDATE SET messages=1`, [addressId, wsId]);

  const inboxId = `mbx_${hex(12)}`;
  const inboxEmail = `agent@${domainName}`;
  await pool.query(
    `INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,kind,retention_mode,expires_at,delete_after,key)
     VALUES ($1,$2,$3,$4,$5,'inbox','ephemeral',now() + interval '7 days',now() + interval '8 days',$6)`,
    [inboxId, wsId, mailboxDomainId, inboxEmail, `Inbox ${marker}`, `inb_${mLow}`],
  );
  await pool.query(
    `INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES ($1,$2,$3,'primary')`,
    [wsId, inboxEmail, inboxId],
  );
  await pool.query(`INSERT INTO inbox_state(inbox_id,workspace_id,messages) VALUES ($1,$2,1) ON CONFLICT (inbox_id) DO UPDATE SET messages=1`, [inboxId, wsId]);
  const customFolderRole = `fld_${hex(16)}`;
  await pool.query(
    `INSERT INTO inbox_folders(inbox_id,role,uid_validity,uid_next,highest_modseq,total,unseen,custom_path)
     VALUES ($1,'inbox',1,2,1,1,1,NULL), ($1,'sent',2,1,1,0,0,NULL), ($1,'trash',3,1,1,0,0,NULL), ($1,$2,4,1,1,0,0,$3)
     ON CONFLICT (inbox_id, role) DO NOTHING`,
    [inboxId, customFolderRole, `Folder-${marker}`],
  );
  const appPasswordId = `apw_${hex(12)}`;
  await pool.query(
    `INSERT INTO inbox_app_passwords(id,inbox_id,name,hash,protocols) VALUES ($1,$2,$3,$4,ARRAY['imap','smtp'])`,
    [appPasswordId, inboxId, `AppPw ${marker}`, sha256(`pw-${marker}`)],
  );
  const endedInboxId = `mbx_${hex(12)}`;
  const endedInboxEmail = `ended-${mLow}@${domainName}`;
  await pool.query(
    `INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,kind,retention_mode,expires_at,delete_after,key)
     VALUES ($1,$2,$3,$4,$5,'inbox','ephemeral',now() - interval '2 hours',now() - interval '1 hour',$6)`,
    [endedInboxId, wsId, mailboxDomainId, endedInboxEmail, `EndedInbox ${marker}`, `end-${mLow}`],
  );
  await pool.query(
    `INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES ($1,$2,$3,'primary')`,
    [wsId, endedInboxEmail, endedInboxId],
  );
  const mailboxKeyId = `mbk_${hex(12)}`;
  const mbxKeySecret = `nm_mbx_${hex(32)}`;
  await pool.query(
    `INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,inbox_id,permissions)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'["read","send"]'::jsonb)`,
    [mailboxKeyId, wsId, `MbxKey ${marker}`, sha256(mbxKeySecret), mbxKeySecret.slice(0, 14), JSON.stringify([inboxId]), inboxId],
  );
  const allAddrKeyId = `mbk_${hex(12)}`;
  const allAddrKeySecret = `nm_mbx_${hex(32)}`;
  await pool.query(
    `INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,inbox_id,permissions)
     VALUES ($1,$2,$3,$4,$5,NULL,NULL,'["read","send"]'::jsonb)`,
    [allAddrKeyId, wsId, `AllAddrKey ${marker}`, sha256(allAddrKeySecret), allAddrKeySecret.slice(0, 14)],
  );

  const threadId = `thr_${hex(12)}`;
  const inboundMessageId = `msg_${hex(16)}`;
  await pool.query(
    `INSERT INTO mail_threads(id,workspace_id,subject,message_count) VALUES ($1,$2,$3,1)`,
    [threadId, wsId, `ThreadSubj ${marker}`],
  );
  await pool.query(
    `INSERT INTO mail_messages(id,workspace_id,direction,thread_id,region,domain_id,subject,from_address,"to",text,html,snippet,headers,attachment_count,size_bytes,verdicts)
     VALUES ($1,$2,'inbound',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'[]'::jsonb,1,256,'{"spf":"PASS","dkim":"PASS","dmarc":"PASS"}'::jsonb)`,
    [
      inboundMessageId,
      wsId,
      threadId,
      region,
      mailboxDomainId,
      `InboundSubj ${marker}`,
      `external-${mLow}@example.org`,
      JSON.stringify([{ name: null, address: inboxEmail }, { name: null, address: addressEmail }]),
      `InboundBody ${marker}`,
      `<p>InboundHtml ${marker}</p>`,
      `InboundSnip ${marker}`,
    ],
  );
  await pool.query(
    `INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at)
     VALUES ($1,$3,$4,$5,'inbound',false,now()), ($2,$3,$4,$5,'inbound',false,now())`,
    [inboxId, addressId, inboundMessageId, wsId, threadId],
  );
  await pool.query(
    `INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,subject,snippet,message_count,unread_count,last_message_at)
     VALUES ($1,$3,$4,$5,$6,1,1,now()), ($2,$3,$4,$5,$6,1,1,now())`,
    [inboxId, addressId, threadId, wsId, `ThreadSubj ${marker}`, `InboundSnip ${marker}`],
  );
  await pool.query(
    `INSERT INTO inbox_entries(inbox_id,role,uid,message_id,modseq,internal_date)
     VALUES ($1,'inbox',1,$2,1,now())`,
    [inboxId, inboundMessageId],
  );
  const mailAttachmentId = `mat_${hex(12)}`;
  const mailAttKey = `${wsId}/mail/${mailAttachmentId}.txt`;
  const mailAttBytes = new TextEncoder().encode(`MailAttBytes ${marker}`);
  await mailR2Bucket.put(mailAttKey, mailAttBytes);
  await pool.query(
    `INSERT INTO mail_attachments(id,workspace_id,message_id,filename,content_type,size_bytes,disposition,sha256,bucket,storage_key)
     VALUES ($1,$2,$3,$4,'text/plain',$5,'attachment',$6,'tear-mail',$7)`,
    [mailAttachmentId, wsId, inboundMessageId, `inbatt-${mLow}.txt`, mailAttBytes.byteLength, sha256(`MailAttBytes ${marker}`), mailAttKey],
  );
  await pool.query(
    `INSERT INTO mailbox_events(workspace_id,type,mailbox_id,thread_id,message_id,data)
     VALUES ($1,'message.received',$2,$3,$4,$5::jsonb)`,
    [wsId, addressId, threadId, inboundMessageId, JSON.stringify({ marker })],
  );
  const retiredAddress = `retired-${mLow}@${domainName}`;
  await pool.query(
    `INSERT INTO mail_retired_addresses(workspace_id,address,until) VALUES ($1,$2,now() + interval '7 days')`,
    [wsId, retiredAddress],
  );

  // 11. Inbound webhooks, endpoints, routes, rules
  const inboundWebhookId = `mwh_${hex(12)}`;
  const encMwhSecret = await encrypt(runtime, `whsec_${hex(16)}`, `${wsId}:mailbox-webhook:${inboundWebhookId}`);
  await pool.query(
    `INSERT INTO mailbox_webhooks(id,workspace_id,type,key,name,url,description,event_types,encrypted_secret)
     VALUES ($1,$2,'webhook',$3,$4,$5,$6,'["message.received"]'::jsonb,$7)`,
    [inboundWebhookId, wsId, `mwh_${mLow}`, `InbHook ${marker}`, `https://inb.${domainName}/hook`, `InbDesc ${marker}`, encMwhSecret],
  );
  const inboundWebhookDeliveryId = `mwd_${hex(12)}`;
  await pool.query(
    `INSERT INTO mailbox_webhook_deliveries(id,workspace_id,webhook_id,payload,status,attempt_count,last_status_code,last_error)
     VALUES ($1,$2,$3,$4::jsonb,'failed',1,502,$5)`,
    [inboundWebhookDeliveryId, wsId, inboundWebhookId, JSON.stringify({ messageId: inboundMessageId, marker }), `MwhErr ${marker}`],
  );

  const endpointId = `con_${hex(12)}`;
  const endpointKey = `ep-${mLow}`;
  const encEpTarget = await encrypt(runtime, `https://hooks.slack.com/services/T00/B00/${mLow}`, `${wsId}:endpoint:${endpointId}`);
  await pool.query(
    `INSERT INTO mailbox_webhooks(id,workspace_id,type,key,name,event_types,encrypted_target)
     VALUES ($1,$2,'slack',$3,$4,'[]'::jsonb,$5)`,
    [endpointId, wsId, endpointKey, `SlackEp ${marker}`, encEpTarget],
  );
  const forwardEndpointId = `con_${hex(12)}`;
  const forwardEndpointKey = `fwd-${mLow}`;
  const encFwdTarget = await encrypt(runtime, `fwd-${mLow}@example.org`, `${wsId}:endpoint:${forwardEndpointId}`);
  await pool.query(
    `INSERT INTO mailbox_webhooks(id,workspace_id,type,key,name,event_types,encrypted_target,verified,expires_at)
     VALUES ($1,$2,'forward',$3,$4,'[]'::jsonb,$5,false,now() + interval '1 day')`,
    [forwardEndpointId, wsId, forwardEndpointKey, `FwdEp ${marker}`, encFwdTarget],
  );

  const routeId = `rte_${hex(12)}`;
  await pool.query(`INSERT INTO mail_routing_state(workspace_id,version) VALUES ($1,1)`, [wsId]);
  await pool.query(
    `INSERT INTO mail_routes(id,workspace_id,key,domain_id,match,destinations,note)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [routeId, wsId, `rt_${mLow}`, mailboxDomainId, addressEmail, JSON.stringify([{ type: "inbox", id: inboxId }]), `RouteNote ${marker}`],
  );
  await pool.query(
    `INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note)
     VALUES ($1,1,ARRAY[$2],ARRAY[$2],'member',$3,$4)`,
    [wsId, routeId, owner.id, `RouteVer ${marker}`],
  );

  const ruleKey = `rule-${mLow}`;
  const ruleConfig = {
    rituals: [{ key: ruleKey, source: `// ${marker}\nexport default function route(email, ctx) {}\n`, enabled: true }],
    attachments: [],
    senderLists: {},
    evaluateDomains: [],
    evaluateRoutes: [],
  };
  await pool.query(
    `INSERT INTO mail_ritual_configs(workspace_id,version,config) VALUES ($1,1,$2::jsonb)`,
    [wsId, JSON.stringify(ruleConfig)],
  );
  await pool.query(
    `INSERT INTO mail_ritual_versions(workspace_id,version,config,actor) VALUES ($1,1,$2::jsonb,$3)`,
    [wsId, JSON.stringify(ruleConfig), owner.id],
  );
  await pool.query(`INSERT INTO mail_receive_limits(workspace_id,spam_policy) VALUES ($1,'store')`, [wsId]);

  // 12. Audit events (idx distinct customer-visible rows)
  for (let i = 1; i <= idx; i++) {
    await pool.query(
      `INSERT INTO audit_events(workspace_id,user_id,actor_type,actor_id,via,action,target_type,target_id,summary,internal,retain_until)
       VALUES ($1,$2,'member',$2,'dashboard','domain.create','domain',$3,$4::jsonb,false,now() + interval '1 year')`,
      [wsId, owner.id, domainId, JSON.stringify({ after: { name: domainName, marker, seq: i } })],
    );
  }

  // 13. Billing (distinct balances, card_last4, ledger, payment attempt, hourly usage)
  const cardLast4 = `${idx}${idx}${idx}${idx}`;
  const balanceUc = String(idx * 10_000_000_000);
  await pool.query(
    `INSERT INTO billing_accounts(workspace_id,mode,balance_uc,promo_uc,card_brand,card_last4,card_exp_month,card_exp_year)
     VALUES ($1,'prepaid',$2,0,'visa',$3,12,2029)`,
    [wsId, balanceUc, cardLast4],
  );
  const paymentId = `pay_${hex(12)}`;
  await pool.query(
    `INSERT INTO billing_payment_attempts(id,workspace_id,kind,status,amount_uc,charged_cents,idempotency_key,card_brand,card_last4,created_by)
     VALUES ($1,$2,'checkout','succeeded',$3,$4,$5,'visa',$6,$7)`,
    [paymentId, wsId, balanceUc, idx * 1000, `idem_${mLow}`, cardLast4, owner.id],
  );
  await pool.query(
    `INSERT INTO billing_ledger(workspace_id,kind,source_id,paid_uc,promo_uc,balance_after_uc,promo_after_uc,detail,actor)
     VALUES ($1,'topup',$2,$3,0,$3,0,$4::jsonb,$5)`,
    [wsId, `attempt:${paymentId}`, balanceUc, JSON.stringify({ attemptId: paymentId, label: marker }), owner.id],
  );
  await pool.query(
    `INSERT INTO billing_usage_hourly(workspace_id,hour,meter,quantity)
     VALUES ($1,date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC','send',$2)`,
    [wsId, idx * 7],
  );

  // 14. Support handoff, conversation, note, action
  const handoffId = `sho_${hex(16)}`;
  const convId = `conv_${randBase32(26)}`;
  convIds.push(convId);
  await pool.query(
    `INSERT INTO support_conversations(id,channel,user_id,verification,mode,workspace_id,content_workspace_id,status,subject)
     VALUES ($1,'chat',$2,'handoff','member',$3,$3,'open',$4)`,
    [convId, owner.id, wsId, `SupportSubj ${marker}`],
  );
  await pool.query(
    `INSERT INTO support_handoffs(id,user_id,workspace_id,kind,page,message,share_content,expires_at,used_at,conversation_id)
     VALUES ($1,$2,$3,'support','/overview',$4,true,now() + interval '25 minutes',now(),$5)`,
    [handoffId, owner.id, wsId, `HandoffMsg ${marker}`, convId],
  );
  const supportNoteId = `snt_${hex(16)}`;
  await pool.query(
    `INSERT INTO support_notes(id,user_id,workspace_id,conversation_id,author,text)
     VALUES ($1,$2,$3,$4,'agent',$5)`,
    [supportNoteId, owner.id, wsId, convId, `SupportNote ${marker}`],
  );
  const supportActionId = `sac_${hex(16)}`;
  await pool.query(
    `INSERT INTO support_actions(id,conversation_id,user_id,workspace_id,kind,target,summary,parts,status,expires_at)
     VALUES ($1,$2,$3,$4,'test_webhook',$5::jsonb,$6,$7::jsonb,'proposed',now() + interval '1 day')`,
    [
      supportActionId,
      convId,
      owner.id,
      wsId,
      JSON.stringify({ webhookId }),
      `ActionSummary ${marker}`,
      JSON.stringify({ template: "Test {webhook}", labels: { webhook: marker } }),
    ],
  );

  const forbiddenTokens = [
    wsId,
    wsName,
    wsSlug,
    marker,
    mLow,
    domainName,
    domainId,
    mailboxDomainId,
    mailboxSubdomainId,
    hostedChildName,
    hostedChildReceivingHost,
    connectionId,
    owner.email,
    invitationId,
    apiKeyId,
    domainKeyId,
    mailboxKeyId,
    allAddrKeyId,
    agentTokenId,
    mcpGrantId,
    ...contactIds,
    ...listIds,
    ...segmentIds,
    ...importIds,
    planId,
    templateId,
    templateAssetId,
    attachmentId,
    campaignDraftId,
    campaignPausedId,
    campaignReviewId,
    ...emailIds,
    emailEventId,
    webhookId,
    webhookDeliveryId,
    inboundWebhookId,
    inboundWebhookDeliveryId,
    endpointId,
    endpointKey,
    forwardEndpointKey,
    routeId,
    ruleKey,
    inboxId,
    endedInboxId,
    addressId,
    addressEmail,
    inboxEmail,
    customFolderRole,
    appPasswordId,
    threadId,
    inboundMessageId,
    mailAttachmentId,
    paymentId,
    handoffId,
    supportNoteId,
    supportActionId,
  ];

  return {
    slot,
    id: wsId,
    name: wsName,
    slug: wsSlug,
    marker,
    postalAddress,
    domainName,
    domainId,
    mailboxDomainId,
    mailboxSubdomainId,
    hostedChildName,
    hostedChildReceivingHost,
    connectionId,
    ownerUserId: owner.id,
    ownerMemberId,
    ownerCookie: owner.cookie,
    ownerEmail: owner.email,
    invitationId,
    apiKeyId,
    apiKeySecret,
    domainKeyId,
    domainKeySecret,
    mailboxKeyId,
    allAddrKeyId,
    agentTokenId,
    mcpGrantId,
    contactIds,
    listIds,
    newsletterId,
    segmentIds,
    importIds,
    planId,
    templateId,
    templateAssetId,
    attachmentId,
    campaignDraftId,
    campaignPausedId,
    campaignReviewId,
    emailIds,
    emailScheduledId,
    emailEventId,
    unsubTokenRaw,
    webhookId,
    webhookDeliveryId,
    inboundWebhookId,
    inboundWebhookDeliveryId,
    endpointId,
    endpointKey,
    forwardEndpointKey,
    routeId,
    ruleKey,
    inboxId,
    endedInboxId,
    addressId,
    addressEmail,
    inboxEmail,
    customFolderRole,
    appPasswordId,
    threadId,
    inboundMessageId,
    mailAttachmentId,
    retiredAddress,
    paymentId,
    cardLast4,
    balanceUc,
    handoffId,
    convId,
    supportNoteId,
    supportActionId,
    forbiddenTokens,
  };
}

// ---------- HTTP & MCP & Support request dispatchers ----------
interface HttpReply {
  status: number;
  text: string;
  body: any;
  headers: Headers;
}

async function rawFetch(
  method: string,
  path: string,
  opts: {
    cookie?: string;
    workspaceHeader?: string;
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
    runtimeOverride?: Record<string, unknown>;
  } = {},
): Promise<HttpReply> {
  const h = new Headers(opts.headers ?? {});
  if (opts.cookie) {
    h.set("cookie", opts.cookie);
    h.set("origin", PUBLIC);
    if (opts.workspaceHeader) h.set("x-nightmail-workspace", opts.workspaceHeader);
  }
  if (opts.bearer) h.set("authorization", `Bearer ${opts.bearer}`);
  if (opts.body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  const req = new Request(PUBLIC + path, {
    method,
    headers: h,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const rt = opts.runtimeOverride ? { ...runtime, ...opts.runtimeOverride } : runtime;
  const r = await app.fetch(req, rt);
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text / html / binary
  }
  return { status: r.status, text, body, headers: r.headers };
}

function authOptsFor(t: Trial, p: OpenApiPrincipal): { cookie?: string; workspaceHeader?: string; bearer?: string } {
  switch (p) {
    case "ownerA":
      return { cookie: t.ws.A.ownerCookie, workspaceHeader: t.ws.A.id };
    case "adminA":
      return { cookie: t.adminACookie, workspaceHeader: t.ws.A.id };
    case "memberA":
      return { cookie: t.memberACookie, workspaceHeader: t.ws.A.id };
    case "dualA":
      return { cookie: t.dualCookie, workspaceHeader: t.ws.A.id };
    case "dualB":
      return { cookie: t.dualCookie, workspaceHeader: t.ws.B.id };
    case "dualC":
      return { cookie: t.dualCookie, workspaceHeader: t.ws.C.id };
    case "keyA":
      return { bearer: t.ws.A.apiKeySecret };
    case "dkeyA":
      return { bearer: t.ws.A.domainKeySecret };
    case "anon":
      return {};
  }
}

function activeSlotsFor(p: OpenApiPrincipal | SupportPrincipal | McpPrincipal | AggregatePrincipal): WorkspaceSlot[] {
  switch (p) {
    case "ownerA":
    case "adminA":
    case "memberA":
    case "dualA":
    case "keyA":
    case "dkeyA":
    case "mcpA":
    case "supportA":
    case "supportDualA":
      return ["A"];
    case "dualB":
      return ["B"];
    case "mcpDual":
    case "supportDualAB":
      return ["A", "B"];
    case "dualC":
    case "anon":
      return [];
  }
}

function foreignSlotsFor(allowed: WorkspaceSlot[]): WorkspaceSlot[] {
  return (["A", "B", "C"] as WorkspaceSlot[]).filter((s) => !allowed.includes(s));
}

// ---------- Invariant 1: Leak scanner ----------
function scanForLeaks(
  t: Trial,
  reply: HttpReply,
  foreignSlots: WorkspaceSlot[],
  opts: {
    allowDualWorkspaces?: boolean;
    echoedInputs?: string[];
    context: string;
  },
): string[] {
  const findings: string[] = [];
  if (!foreignSlots.length) return findings;
  let hay = reply.text;
  if (!hay) return findings;

  // For dualUser on GET /v1/me, the workspaces switcher array legitimately lists A and B (NEVER C).
  // Verify workspaces only contains A/B, then strip that array so every other field (newsletters, billing, connection, etc.) is strictly scanned!
  if (opts.allowDualWorkspaces && reply.status === 200 && reply.body && typeof reply.body === "object" && Array.isArray(reply.body.workspaces)) {
    const wsIds = reply.body.workspaces.map((x: any) => x?.id);
    if (wsIds.includes(t.ws.C.id)) {
      findings.push(`${opts.context}: leaked C workspace into /v1/me workspaces list`);
    }
    const { workspaces: _w, ...rest } = reply.body;
    hay = JSON.stringify(rest);
  }

  const echoedList = (opts.echoedInputs ?? []).map((x) => x.toLowerCase());
  const isErrorReply = reply.status >= 400 || reply.body?.result?.isError === true;

  for (const slot of foreignSlots) {
    const fw = t.ws[slot];
    for (const tok of fw.forbiddenTokens) {
      if (!tok || tok.length < 4) continue;
      // On error responses (4xx or MCP isError), ignore tokens that were explicitly supplied in our own request input.
      if (isErrorReply && echoedList.some((e) => e.includes(tok.toLowerCase()))) continue;
      if (hay.includes(tok)) {
        findings.push(`${opts.context}: leaked ${slot} token "${tok}" (status=${reply.status})`);
        break; // one token per workspace per response is enough to prove a leak
      }
    }
  }
  return findings;
}

// ---------- Invariant 3: Indistinguishability ("not yours" vs "doesn't exist") ----------
function bodyShape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v !== "object") return typeof v;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${k}:${bodyShape((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function normalizeError(reply: HttpReply): { status: number; code: string | null; msg: string; field: string | null; shape: string } {
  const err = reply.body?.error;
  if (err && typeof err === "object") {
    const { requestId: _r, resetAt: _t, ...rest } = err;
    return {
      status: reply.status,
      code: typeof err.code === "string" ? err.code : null,
      msg: typeof err.message === "string" ? err.message : "",
      field: typeof err.field === "string" ? err.field : null,
      shape: bodyShape(rest),
    };
  }
  return { status: reply.status, code: null, msg: reply.text.slice(0, 120), field: null, shape: bodyShape(reply.body) };
}

function checkIndistinguishable(
  context: string,
  foreignReply: HttpReply,
  missingReply: HttpReply,
  foreignTokens: string[] = [],
  missingTokens: string[] = [],
): string | null {
  const a = normalizeError(foreignReply);
  const b = normalizeError(missingReply);
  // Normalize away echoed input tokens if both messages literally repeat the supplied param.
  const normMsg = (m: string, toks: string[]) => {
    let out = m;
    for (const tok of toks) if (tok) out = out.split(tok).join("<ID>");
    return out;
  };
  if (a.status !== b.status || a.code !== b.code || a.field !== b.field || normMsg(a.msg, foreignTokens) !== normMsg(b.msg, missingTokens) || a.shape !== b.shape) {
    return `${context}: foreign=(${a.status} ${a.code} "${a.msg}") vs missing=(${b.status} ${b.code} "${b.msg}")`;
  }
  return null;
}

// ---------- Smart Request Builder for Every OpenAPI Route ----------
// Returns { path, body, headers, usedTargetIds, missingPath, missingBody, skipOracleReason }
function buildOpenApiRequest(
  t: Trial,
  route: OpenApiRoute,
  target: SeededWorkspace,
  callerWs: SeededWorkspace,
  mode: "target" | "missing",
): { path: string; body?: unknown; headers?: Record<string, string>; echoed: string[] } {
  const echoed: string[] = [];
  const miss = (prefix: string, hexLen = 24) => `${prefix}${"0".repeat(hexLen)}`;
  const pick = (real: string, fake: string) => {
    const v = mode === "target" ? real : fake;
    echoed.push(v);
    return v;
  };

  // Path parameter resolver tailored to every OpenAPI route so requests pass Zod param validation!
  const p = route.path;
  const resolvedPath = p.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (p.startsWith("/v1/mcp-connections/")) return encodeURIComponent(pick(target.mcpGrantId, `mcp_at_${"0".repeat(32)}`));
    if (p.startsWith("/v1/agents/")) return encodeURIComponent(pick(target.mcpGrantId, `mcp_at_${"0".repeat(32)}`));
    if (p.startsWith("/v1/agent-tokens/")) return encodeURIComponent(pick(target.agentTokenId, miss("agt_")));
    if (p.startsWith("/v1/api-keys/")) return encodeURIComponent(pick(target.apiKeyId, miss("key_")));
    if (p.startsWith("/v1/contacts/")) return encodeURIComponent(pick(target.contactIds[0]!, miss("con_")));
    if (p.startsWith("/v1/lists/")) {
      if (name === "contactId") return encodeURIComponent(pick(target.contactIds[0]!, miss("con_")));
      return encodeURIComponent(pick(target.listIds[0]!, miss("lst_")));
    }
    if (p.startsWith("/v1/segments/")) return encodeURIComponent(pick(target.segmentIds[0]!, miss("seg_")));
    if (p.startsWith("/v1/contact-imports/")) return encodeURIComponent(pick(target.importIds[0]!, miss("imp_")));
    if (p.startsWith("/v1/newsletters/")) return encodeURIComponent(pick(target.newsletterId, miss("lst_")));
    if (p.startsWith("/v1/templates/")) return encodeURIComponent(pick(target.templateId, miss("tpl_", 32)));
    if (p.startsWith("/v1/template-assets/")) return encodeURIComponent(pick(target.templateAssetId, miss("tas_")));
    if (p.startsWith("/v1/emails/")) {
      const eid = p.endsWith("/cancel") || p.endsWith("/reschedule") ? target.emailScheduledId : target.emailIds[0]!;
      return encodeURIComponent(pick(eid, miss("eml_")));
    }
    if (p.startsWith("/v1/attachments/")) return encodeURIComponent(pick(target.attachmentId, miss("att_")));
    if (p.startsWith("/v1/campaigns/")) {
      const cid = p.endsWith("/resume") ? target.campaignPausedId : target.campaignDraftId;
      return encodeURIComponent(pick(cid, miss("cmp_")));
    }
    if (p.startsWith("/v1/domains/")) {
      if (name === "token") return encodeURIComponent("invalid-return-token");
      return encodeURIComponent(pick(target.domainId, miss("dom_")));
    }
    if (p.startsWith("/v1/webhooks/")) {
      if (name === "deliveryId") return encodeURIComponent(pick(target.webhookDeliveryId, miss("dlv_")));
      return encodeURIComponent(pick(target.webhookId, miss("whk_")));
    }
    if (p.startsWith("/unsubscribe/")) {
      // Unsubscribe is a public recipient capability token; never submit target's real token for mutation,
      // test with a synthetic token so we don't mutate target via an intended public capability link.
      return encodeURIComponent(`unsub_${"0".repeat(32)}`);
    }
    if (p.startsWith("/v1/regions/") || p.startsWith("/v1/connection/regions/")) return "us-east-1";
    if (p.startsWith("/v1/routing/routes/")) return encodeURIComponent(pick(target.routeId, miss("rte_")));
    if (p.startsWith("/v1/routing/versions/")) return "1";
    if (p.startsWith("/v1/rules/scripts/")) return encodeURIComponent(pick(target.ruleKey, "rule-nonexistent-0000"));
    if (p.startsWith("/v1/endpoints/")) return encodeURIComponent(pick(target.endpointKey, "ep-nonexistent-0000"));
    if (p.startsWith("/v1/inboxes/")) {
      if (name === "folder") return encodeURIComponent(pick(target.customFolderRole, `fld_${"0".repeat(32)}`));
      if (name === "messageId") return encodeURIComponent(pick(target.inboundMessageId, `msg_${"0".repeat(32)}`));
      if (name === "attachmentId") return encodeURIComponent(pick(target.mailAttachmentId, miss("mat_")));
      if (name === "passwordId") return encodeURIComponent(pick(target.appPasswordId, miss("apw_")));
      return encodeURIComponent(pick(target.inboxId, miss("mbx_")));
    }
    if (p.startsWith("/v1/inbound/retired/")) return encodeURIComponent(pick(target.retiredAddress, "missing@missing.example.com"));
    if (p.startsWith("/v1/inbound/domains/")) {
      if (name === "hostId" || name === "subdomainId") return encodeURIComponent(pick(target.mailboxSubdomainId, miss("mbd_")));
      return encodeURIComponent(pick(target.mailboxDomainId, miss("mbd_")));
    }
    if (p.startsWith("/v1/inbound/addresses/")) return encodeURIComponent(pick(target.addressId, miss("mbx_")));
    if (p.startsWith("/v1/inbound/threads/")) return encodeURIComponent(pick(target.threadId, miss("thr_")));
    if (p.startsWith("/v1/inbound/messages/")) {
      if (name === "attachmentId") return encodeURIComponent(pick(target.mailAttachmentId, miss("mat_")));
      return encodeURIComponent(pick(target.inboundMessageId, `msg_${"0".repeat(32)}`));
    }
    if (p.startsWith("/v1/inbound/webhooks/")) {
      if (name === "deliveryId") return encodeURIComponent(pick(target.inboundWebhookDeliveryId, miss("mwd_")));
      return encodeURIComponent(pick(target.inboundWebhookId, miss("mwh_")));
    }
    if (p.startsWith("/v1/workspaces/current/members/")) return encodeURIComponent(pick(target.ownerMemberId, miss("mem_")));
    if (p.startsWith("/v1/workspaces/invitations/")) return encodeURIComponent(pick(target.invitationId, miss("inv_")));
    if (p.startsWith("/v1/billing/payments/")) return encodeURIComponent(pick(target.paymentId, miss("pay_")));
    return encodeURIComponent(pick(target.id, "missing_000000000000"));
  });

  // Query string for routes that require or accept filter params carrying foreign IDs
  let qs = "";
  if (p === "/v1/inboxes/{id}/changes") qs = "?since=0";
  else if (p === "/v1/workspaces/current/invitations" && route.method === "DELETE") {
    qs = `?id=${encodeURIComponent(pick(target.invitationId, miss("inv_")))}`;
  } else if (p === "/v1/contacts" && route.method === "GET") {
    qs = `?listId=${encodeURIComponent(pick(target.listIds[0]!, miss("lst_")))}`;
  } else if (p === "/v1/emails" && route.method === "GET") {
    qs = `?campaignId=${encodeURIComponent(pick(target.campaignDraftId, miss("cmp_")))}`;
  } else if (p === "/v1/campaigns" && route.method === "GET") {
    qs = `?listId=${encodeURIComponent(pick(target.listIds[0]!, miss("lst_")))}`;
  } else if (p === "/v1/logs" && route.method === "GET") {
    qs = `?counts=true&campaignId=${encodeURIComponent(pick(target.campaignDraftId, miss("cmp_")))}`;
  } else if (p === "/v1/inbound/threads" && route.method === "GET") {
    qs = `?addressId=${encodeURIComponent(pick(target.addressId, miss("mbx_")))}`;
  } else if (p === "/v1/inbound/messages" && route.method === "GET") {
    qs = `?addressId=${encodeURIComponent(pick(target.addressId, miss("mbx_")))}&threadId=${encodeURIComponent(pick(target.threadId, miss("thr_")))}`;
  } else if (p === "/v1/inbound/events" && route.method === "GET") {
    qs = `?addressId=${encodeURIComponent(pick(target.addressId, miss("mbx_")))}`;
  } else if (p === "/v1/inbound/webhooks" && route.method === "GET") {
    qs = `?addressId=${encodeURIComponent(pick(target.addressId, miss("mbx_")))}`;
  } else if (p === "/v1/inbound/endpoints" && route.method === "GET") {
    qs = `?addressId=${encodeURIComponent(pick(target.addressId, miss("mbx_")))}`;
  } else if (p === "/v1/lists" && route.method === "GET") {
    qs = "?counts=true";
  }

  // Valid request bodies that pass Zod validation AND supply cross-workspace reference IDs where applicable!
  const headers: Record<string, string> = {};
  if (p.startsWith("/v1/routing") || p.startsWith("/v1/rules") || p.endsWith("/flow")) {
    if (route.method !== "GET") headers["if-match"] = "1";
  }

  let body: unknown = undefined;
  const futureIso = new Date(Date.now() + 7200_000).toISOString();
  if (route.hasBody) {
    switch (route.operationId) {
      case "bindMcpConnection":
        body = { workspaceId: pick(target.id, "ws_00000000000000000000000000000000") };
        break;
      case "createAgentToken":
        body = { permissions: ["read"], expiresInSeconds: 60, purpose: "isolation-probe" };
        break;
      case "createApiKey":
        body = {
          name: "probe-key",
          access: { type: "inbox", inboxId: pick(target.inboxId, miss("mbx_")), mail: ["read"] },
        };
        break;
      case "updateApiKey":
        body = { name: "mutated-probe" };
        break;
      case "createContact":
        body = { email: `probe-${hex(6)}@example.com`, name: "Probe Contact" };
        break;
      case "updateContact":
        body = { name: "Mutated Contact" };
        break;
      case "updateContactConsent":
        body = { status: "unsubscribed", source: "api" };
        break;
      case "createContactList":
        body = { name: `Probe List ${hex(4)}` };
        break;
      case "updateContactList":
        body = { name: "Mutated List" };
        break;
      case "addListMembers":
        body = { contactIds: [pick(target.contactIds[0]!, miss("con_"))] };
        break;
      case "createSegment":
        body = { name: `Probe Seg ${hex(4)}`, rule: { field: "email", operator: "contains", value: "probe" } };
        break;
      case "updateSegment":
        body = { name: "Mutated Seg" };
        break;
      case "previewSegment":
        body = { listId: pick(target.listIds[0]!, miss("lst_")) };
        break;
      case "previewContactImport":
        body = {
          csv: `email,name\nprobe-${hex(4)}@example.com,Probe`,
          listId: pick(target.listIds[0]!, miss("lst_")),
          mapping: { email: "email", name: "name" },
        };
        break;
      case "commitContactImport":
        body = {};
        break;
      case "queryAudience":
        body = { statement: `SELECT email FROM contacts WHERE email CONTAINS '${target.marker.toLowerCase()}'` };
        break;
      case "planAudienceMutation":
        body = { statement: `UPDATE contacts SET name = 'x' WHERE email CONTAINS '${target.marker.toLowerCase()}'` };
        break;
      case "applyAudiencePlan":
        body = { planId: pick(target.planId, miss("aqp_", 32)) };
        break;
      case "createNewsletter":
        body = { listId: pick(target.listIds[0]!, miss("lst_")), from: `news@${callerWs.domainName}` };
        break;
      case "updateNewsletter":
        body = { name: "Mutated NL" };
        break;
      case "createCampaignTemplate":
        body = { name: `Probe Tpl ${hex(4)}` };
        break;
      case "updateCampaignTemplate":
        body = { revision: 1, draft: { name: "Mutated Tpl", description: "", subject: "s", replyTo: [], html: "<p>x</p>", attachments: [] } };
        break;
      case "publishCampaignTemplate":
        body = { revision: 1 };
        break;
      case "setCampaignTemplateArchived":
        body = { archived: true };
        break;
      case "uploadTemplateAsset":
        body = { filename: "p.txt", contentType: "text/plain", disposition: "attachment", content: Buffer.from("probe").toString("base64") };
        break;
      case "importTemplateImage":
        body = { url: "https://blocked.invalid/pic.png" };
        break;
      case "checkEmail":
        body = { emailId: pick(target.emailIds[0]!, miss("eml_")) };
        break;
      case "sendEmail":
        body = {
          from: `probe@${callerWs.domainName}`,
          to: "rcpt@example.com",
          region: "us-east-1",
          subject: "Probe",
          text: "Probe",
          attachments: [pick(target.attachmentId, miss("att_"))],
        };
        break;
      case "sendEmailBatch":
        body = {
          emails: [
            {
              from: `probe@${callerWs.domainName}`,
              to: "rcpt@example.com",
              region: "us-east-1",
              subject: "Probe",
              text: "Probe",
              attachments: [pick(target.attachmentId, miss("att_"))],
            },
          ],
        };
        break;
      case "previewEmail":
        body = { emailId: pick(target.emailIds[0]!, miss("eml_")), clients: ["gmail-web"], theme: "light" };
        break;
      case "rescheduleEmail":
        body = { scheduledAt: futureIso };
        break;
      case "uploadAttachment":
        body = { filename: "p.txt", contentType: "text/plain", disposition: "attachment", content: Buffer.from("probe").toString("base64") };
        break;
      case "createCampaign":
        body = {
          name: `Probe Camp ${hex(4)}`,
          from: `news@${callerWs.domainName}`,
          region: "us-east-1",
          subject: "Probe",
          html: "<p>Probe</p>",
          attachments: [pick(target.attachmentId, miss("att_"))],
          audience: { listId: pick(target.listIds[0]!, miss("lst_")) },
          templateId: pick(target.templateId, miss("tpl_", 32)),
        };
        break;
      case "updateCampaign":
        body = {
          revision: 1,
          draft: {
            name: "Mutated Camp",
            from: `news@${callerWs.domainName}`,
            region: "us-east-1",
            subject: "Mutated",
            html: "<p>Mutated</p>",
            attachments: [],
            tracking: true,
            audience: { listId: pick(target.listIds[0]!, miss("lst_")) },
            defaults: {},
          },
        };
        break;
      case "setCampaignArchived":
        body = { archived: true };
        break;
      case "testCampaign":
        body = { to: "test@example.com" };
        break;
      case "sendCampaign":
        body = { revision: 1 };
        break;
      case "scheduleCampaign":
        body = { revision: 1, scheduledAt: futureIso };
        break;
      case "pauseCampaign":
      case "resumeCampaign":
      case "unscheduleCampaign":
        body = {};
        break;
      case "setCampaignPacing":
        body = { perDay: 100 };
        break;
      case "rescheduleCampaign":
        body = { scheduledAt: futureIso };
        break;
      case "updateWorkspaceSettings":
        body = { name: callerWs.name };
        break;
      case "createDomain":
        body = { name: `probe-${hex(4)}.example.com`, region: "us-east-1" };
        break;
      case "configureDomainMailFrom":
        body = { mailFromDomain: `mail.${target.domainName}` };
        break;
      case "chooseReceivingHost":
        body = { host: `rx.${target.domainName}` };
        break;
      case "createWebhook":
        body = { url: `https://probe-${hex(4)}.example.com/wh`, eventTypes: ["email.delivered"] };
        break;
      case "updateWebhook":
        body = { description: "Mutated Webhook" };
        break;
      case "receiveCloudFormationSnsEvent":
      case "receiveSesSnsEvent":
        body = {
          Type: "Notification",
          MessageId: randomUUID(),
          TopicArn: "arn:aws:sns:us-east-1:000000000000:invalid",
          Message: "{}",
          Timestamp: new Date().toISOString(),
          SignatureVersion: "1",
          Signature: "invalid",
          SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000.pem",
        };
        break;
      case "releaseSenderStanding":
        body = { checklist: { bouncedRemoved: true, listSourceConfirmed: true } };
        break;
      case "configureRegion":
        body = { enabled: true };
        break;
      case "provisionRegion":
        body = { confirm: true };
        break;
      case "configureRegionAutoValidation":
        body = { stream: "marketing", mode: "off", confirm: true };
        break;
      case "applyRouting":
        body = { version: 1, routes: [{ match: `probe@${callerWs.domainName}`, to: [pick(target.inboxId, miss("mbx_"))] }] };
        break;
      case "createRoute":
        body = { match: `r-${hex(4)}@${callerWs.domainName}`, to: [pick(target.inboxId, miss("mbx_"))] };
        break;
      case "updateRoute":
        body = { note: "Mutated Route" };
        break;
      case "testRouting":
        body = { messageId: pick(target.inboundMessageId, `msg_${"0".repeat(32)}`) };
        break;
      case "restoreRuleVersion":
        body = { version: 1 };
        break;
      case "setDecisionOptIns":
        body = { evaluateDomains: [] };
        break;
      case "checkRule":
        body = { source: "export default function route(email, ctx) {}\n" };
        break;
      case "createRuleFromRecipe":
        body = { recipe: "auto-reply", addresses: [pick(target.addressId, miss("mbx_"))] };
        break;
      case "updateRuleFromRecipe":
        body = { enabled: false };
        break;
      case "saveRule":
        body = { key: pick(target.ruleKey, "rule-nonexistent-0000"), source: "export default function route(email, ctx) {}\n" };
        break;
      case "updateRule":
        body = { enabled: false };
        break;
      case "attachRules":
        body = { attachments: [{ rule: pick(target.ruleKey, "rule-nonexistent-0000"), target: pick(target.addressId, miss("mbx_")) }] };
        break;
      case "applyRules":
        body = { rules: [], attachments: [{ rule: pick(target.ruleKey, "rule-nonexistent-0000"), target: pick(target.addressId, miss("mbx_")) }] };
        break;
      case "testRules":
        body = { messageId: pick(target.inboundMessageId, `msg_${"0".repeat(32)}`) };
        break;
      case "createEndpoint":
        body = { type: "slack", name: `ep-${hex(4)}`, url: "https://hooks.slack.com/services/T00/B00/probe" };
        break;
      case "updateEndpoint":
        body = { paused: true };
        break;
      case "sendEndpointVerification":
        body = {};
        break;
      case "createInboxConnection":
        body = { inboxes: [pick(target.inboxId, miss("mbx_"))], client: "opencode", auth: "key" };
        break;
      case "createInboxFolder":
        body = { path: `ProbeFolder-${hex(4)}` };
        break;
      case "updateInboxFolder":
        body = { subscribed: false };
        break;
      case "updateInboxMessage":
        body = { read: true };
        break;
      case "moveInboxMessage":
      case "copyInboxMessage":
        body = { folder: "archive" };
        break;
      case "expungeInboxFolder":
        body = {};
        break;
      case "createInboxAppPassword":
        body = { name: "ProbePw", protocols: ["imap"] };
        break;
      case "createInbox":
        body = { domain: pick(target.domainName, "missing-0000.example.com"), localPart: `p${hex(4)}` };
        break;
      case "updateInbox":
        body = { name: "Mutated Inbox" };
        break;
      case "simulateInboxMessage":
        body = { from: "sim@example.org", subject: "Sim", text: "Sim" };
        break;
      case "updateInboundScanPolicy":
        body = { spam: "store" };
        break;
      case "updateInboundDomain":
        body = { catchAll: "store" };
        break;
      case "enableInboundDomain":
        body = { catchAll: "store" };
        break;
      case "addReceivingHost":
      case "createInboundSubdomain":
        body = { name: `sub2.${target.domainName}` };
        break;
      case "updateReceivingHost":
      case "updateInboundSubdomain":
        body = { catchAll: "store" };
        break;
      case "createInboundAddress":
        body = { address: `a${hex(4)}@${pick(target.domainName, "missing-0000.example.com")}` };
        break;
      case "updateInboundAddress":
        body = { displayName: "Mutated Addr" };
        break;
      case "setInboundAddressFlow":
        body = { deliver: [pick(target.inboxId, miss("mbx_"))] };
        break;
      case "createInboundThread":
        body = {
          addressId: pick(target.addressId, miss("mbx_")),
          to: ["rcpt@example.org"],
          subject: "Probe Thread",
          text: "Probe",
        };
        break;
      case "updateInboundThread":
        body = { read: true, addressId: pick(target.addressId, miss("mbx_")) };
        break;
      case "replyToInboundThread":
        body = { addressId: pick(target.addressId, miss("mbx_")), text: "Probe Reply" };
        break;
      case "createInboundWebhook":
        body = {
          url: `https://probe-${hex(4)}.example.com/inb`,
          eventTypes: ["message.received"],
          addressIds: [pick(target.addressId, miss("mbx_"))],
        };
        break;
      case "updateInboundWebhook":
        body = { description: "Mutated InbHook" };
        break;
      case "testInboundWebhook":
        body = {};
        break;
      case "redeliverInboundMessage":
        body = { destination: pick(target.inboundWebhookId, miss("mwh_")) };
        break;
      case "createWorkspace":
        body = { name: `Probe WS ${hex(4)}` };
        break;
      case "renameCurrentWorkspace":
        body = { name: callerWs.name };
        break;
      case "inviteWorkspaceMember":
      case "createWorkspaceInvitation":
        body = { email: `inv-${hex(5)}@example.com`, role: "member" };
        break;
      case "updateWorkspaceMember":
        body = { role: "admin" };
        break;
      case "createConnection":
        body = { kind: "shared", region: "us-east-1" };
        break;
      case "importConnectionDomains":
        body = { revision: 1, candidateIds: [pick(target.domainId, miss("dom_"))], confirm: true };
        break;
      case "requestConnectionProductionAccess":
        body = {
          websiteUrl: "https://example.com",
          useCase: "We send transactional receipts and account notices to our own signed-up customers.",
          mailType: "TRANSACTIONAL",
          confirm: true,
        };
        break;
      case "verifyConnection":
        body = { awsAccountId: "000000000000" };
        break;
      case "contactSupport":
        body = { kind: "support", message: "probe" };
        break;
      case "createBillingTopUp":
        body = { amountCents: 2000, method: "checkout" };
        break;
      case "createBillingTopUpLink":
        body = { amountCents: 2000 };
        break;
      case "updateBillingAutoRecharge":
        body = { enabled: false, thresholdCents: 1000, amountCents: 2000, monthlyCapCents: 10000 };
        break;
      default:
        body = {};
    }
  }

  return { path: resolvedPath + qs, body, headers, echoed };
}

// Routes whose path params are fixed constants (region, version) or public capability tokens rather than foreign resource IDs
function hasForeignIdParam(route: OpenApiRoute): boolean {
  if (route.path === "/unsubscribe/{token}") return false;
  if (route.path === "/v1/domains/{id}/dns-setup/return/{token}") return false;
  if (route.path.includes("{region}") || route.path.includes("{v}")) return false;
  return route.pathParams.length > 0;
}

// ---------- Action Handlers ----------
async function runProbeGroup(
  t: Trial,
  group: RouteGroup,
  principal: OpenApiPrincipal,
  targetSlot: WorkspaceSlot,
): Promise<WorkspaceIsolationObs> {
  const routes = ROUTES_BY_GROUP.get(group) ?? [];
  const allowedSlots = activeSlotsFor(principal);
  const foreignSlots = foreignSlotsFor(allowedSlots);
  const tracker = beginSlotTracking(t, allowedSlots);
  const auth = authOptsFor(t, principal);
  const target = t.ws[targetSlot];
  const callerWs = allowedSlots.length ? t.ws[allowedSlots[0]!] : t.ws.A;

  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  const snapBefore = await snapshotWorkspaces(t.wsIds);
  try {

  for (const route of routes) {
    // Avoid deleting/mutating caller's own seeded workspace resources when targetSlot === callerSlot!
    if (allowedSlots.includes(targetSlot) && route.method !== "GET") {
      // Only run safe GETs against caller's own workspace; mutations target foreign workspaces!
      continue;
    }

    const req = buildOpenApiRequest(t, route, target, callerWs, "target");
    const reply = await rawFetch(route.method, req.path, {
      ...auth,
      body: req.body,
      headers: req.headers,
    });

    obs.routesDriven += 1;
    t.totalRoutesDriven += 1;
    t.uniqueOpenApiRoutesDriven.add(`${route.method} ${route.path}`);

    // Planted canary: inject workspace B's marker into response text for canary_cross_workspace_leak
    let effectiveReply = reply;
    if (t.bug === "canary_cross_workspace_leak" && foreignSlots.includes("B") && obs.routesDriven === 1) {
      effectiveReply = { ...reply, text: reply.text + ` ${t.ws.B.marker}` };
    }

    // Planted canary: mutate workspace B row during canary_cross_workspace_write
    if (t.bug === "canary_cross_workspace_write" && !t.canaryMutated && foreignSlots.includes("B")) {
      t.canaryMutated = true;
      await pool.query(`UPDATE operation_settings SET name = name || '!' WHERE workspace_id = $1`, [t.ws.B.id]);
    }

    // Invariant 1: No leakage
    const isDualMe = (principal === "dualA" || principal === "dualB") && route.path === "/v1/me";
    const foundLeaks = scanForLeaks(t, effectiveReply, foreignSlots, {
      allowDualWorkspaces: isDualMe,
      echoedInputs: req.echoed,
      context: `${principal} ${route.method} ${route.path} (target=${targetSlot})`,
    });
    for (const l of foundLeaks) {
      obs.leaks.push(l);
      t.leaks.push(l);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: `${route.method} ${route.path}`, target: targetSlot } });
    }

    // Invariant 3: Indistinguishability ("not yours" vs "doesn't exist") for foreign resource IDs
    if (!allowedSlots.includes(targetSlot) && hasForeignIdParam(route) && principal !== "anon" && principal !== "dualC") {
      const missReq = buildOpenApiRequest(t, route, target, callerWs, "missing");
      const missReply = await rawFetch(route.method, missReq.path, {
        ...auth,
        body: missReq.body,
        headers: missReq.headers,
      });
      let compareForeign = reply;
      if (t.bug === "canary_id_probe_oracle" && foreignSlots.includes("B")) {
        compareForeign = {
          status: 403,
          text: JSON.stringify({ error: { code: "FORBIDDEN", message: "Belongs to another workspace." } }),
          body: { error: { code: "FORBIDDEN", message: "Belongs to another workspace." } },
          headers: new Headers(),
        };
      }
      const oracle = checkIndistinguishable(
        `${principal} ${route.method} ${route.path} (target=${targetSlot})`,
        compareForeign,
        missReply,
        req.echoed,
        missReq.echoed,
      );
      if (oracle) {
        obs.probeOracles.push(oracle);
        t.probeOracles.push(oracle);
        t.pendingEvents.push({ name: "isolation.id_oracle", data: { principal, route: `${route.method} ${route.path}` } });
      }
    }

    // Flag unexpected 500s (except expected unconfigured Stripe/SES/stats 503s in local synthetic mode)
    const expected503 = new Set(["BILLING_NOT_CONFIGURED", "SES_NOT_CONFIGURED", "PUBLIC_STATS_PENDING", "PROVIDER_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "PUBLIC_IMAGE_IMPORT_UNAVAILABLE"]);
    if (reply.status >= 500 && !expected503.has(reply.body?.error?.code)) {
      // Allow expected network-blocked errors on DNS/verify/import/webhook-test endpoints
      const networkRoutes = new Set([
        "importTemplateImage", "verifyDomain", "sendDomainTestEmail", "testWebhook", "testInboundWebhook",
        "testEndpoint", "checkInboundDomain", "refreshConnectionScan", "verifyConnection", "discoverRegion",
        "provisionRegion", "updateConnectionStack", "requestConnectionProductionAccess", "getDomainDnsSetup",
        "completeDomainDnsSetup", "renderCampaignPreviewImage", "renderCampaignTemplatePreviewImage",
        "previewEmail", "deleteConnection",
      ]);
      if (!networkRoutes.has(route.operationId)) {
        const errMsg = `${principal} ${route.method} ${route.path} -> ${reply.status} ${reply.body?.error?.code ?? reply.text.slice(0, 80)}`;
        obs.unexpectedErrors.push(errMsg);
        t.unexpectedErrors.push(errMsg);
      }
    }
  }

  // Invariant 2: Full DB + storage snapshot check on ALL non-overlapping foreign workspaces (C is always checked)!
  const snapAfter = await snapshotWorkspaces(t.wsIds);
  const diffs = diffWorkspaces(snapBefore, snapAfter, tracker.watchIds(foreignSlots));
  for (const d of diffs) {
    const msg = `${principal} group=${group} target=${targetSlot}: ${d}`;
    obs.foreignMutations.push(msg);
    t.foreignMutations.push(msg);
    t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { principal, group, diff: d } });
  }

  return obs;
  } finally {
    tracker.end();
  }
}

async function runProbeSupport(
  t: Trial,
  principal: SupportPrincipal,
  targetSlot: WorkspaceSlot,
): Promise<WorkspaceIsolationObs> {
  const allowedSlots = activeSlotsFor(principal);
  const foreignSlots = foreignSlotsFor(allowedSlots);
  const tracker = beginSlotTracking(t, allowedSlots);
  const target = t.ws[targetSlot];

  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  const snapBefore = await snapshotWorkspaces(t.wsIds);
  try {

  const reqOptsFor = (): { cookie?: string; workspaceHeader?: string; bearer?: string; runtimeOverride?: Record<string, unknown> } => {
    switch (principal) {
      case "supportA":
        return { runtimeOverride: { platformCaller: "bane-support", supportConversation: t.ws.A.convId } };
      case "supportDualA":
        return { runtimeOverride: { platformCaller: "bane-support", supportConversation: t.supportDualAConvId } };
      case "supportDualAB":
        return { runtimeOverride: { platformCaller: "bane-support", supportConversation: t.supportDualABConvId } };
      case "ownerA":
        return { cookie: t.ws.A.ownerCookie, workspaceHeader: t.ws.A.id };
      case "keyA":
        return { bearer: t.ws.A.apiKeySecret };
      case "anon":
        return {};
    }
  };
  const baseOpts = reqOptsFor();
  const isSupportCaller = principal.startsWith("support");

  // Drive ALL 28 hidden /v1/support/* routes from SUPPORT_CEILINGS (including /v1/support/audience/health, fixed by #591)
  // in parallel batches of 6 (resetting conversation rate-limit once per batch) so every ProbeSupport finishes in ~1-2s!
  const checkSupportEntry = async (entry: (typeof SUPPORT_CEILINGS)[number]) => {
    const buildPath = (mode: "target" | "missing") => {
      const echoed: string[] = [];
      const pick = (real: string, fake: string) => {
        const v = mode === "target" ? real : fake;
        if (mode === "target") echoed.push(v);
        return v;
      };
      const resolved = entry.path.replace(/\{([^}]+)\}/g, (_, param: string) => {
        if (entry.path.includes("/emails/")) return encodeURIComponent(pick(target.emailIds[0]!, `eml_${"0".repeat(24)}`));
        if (entry.path.includes("/campaigns/")) return encodeURIComponent(pick(target.campaignDraftId, `cmp_${"0".repeat(24)}`));
        if (entry.path.includes("/domains/")) return encodeURIComponent(pick(target.domainId, `dom_${"0".repeat(24)}`));
        if (entry.path.includes("/actions/")) return encodeURIComponent(pick(target.supportActionId, `sac_${"0".repeat(32)}`));
        if (param === "requestId") return encodeURIComponent(`req_${"0".repeat(32)}`);
        return encodeURIComponent(pick(target.id, "missing_0000"));
      });
      // For GET routes without path IDs, test passing workspaceId=target.id AND omitting workspaceId!
      const qs = entry.method === "GET" && !entry.path.includes("{") && entry.path !== "/v1/support/scope" && entry.path !== "/v1/support/notes"
        ? `?workspaceId=${encodeURIComponent(pick(target.id, "ws_00000000000000000000000000000000"))}`
        : "";
      return { path: resolved + qs, echoed };
    };

    let body: unknown = undefined;
    if (entry.method === "POST") {
      if (entry.path === "/v1/support/actions") body = { kind: "test_webhook", webhookId: target.webhookId };
      else if (entry.path === "/v1/support/scope") body = { workspaceId: target.id };
      else if (entry.path === "/v1/support/notes") body = { text: "isolation probe note" };
      else body = {};
    }

    // Avoid mutating caller's own support scope / notes during target===A if we want to keep scope fixed
    if (isSupportCaller && entry.method === "POST" && allowedSlots.includes(targetSlot)) {
      if (entry.path === "/v1/support/scope") return;
    }

    const r1 = buildPath("target");
    const reply = await rawFetch(entry.method, r1.path, { ...baseOpts, body });
    obs.routesDriven += 1;
    t.totalRoutesDriven += 1;
    t.uniqueSupportRoutesDriven.add(`${entry.method} ${entry.path}`);

    // Non-support callers MUST always get 403 SUPPORT_GRANT_REQUIRED!
    if (!isSupportCaller && (reply.status !== 403 || reply.body?.error?.code !== "SUPPORT_GRANT_REQUIRED")) {
      const msg = `non-support ${principal} ${entry.method} ${entry.path} -> ${reply.status} ${reply.body?.error?.code} (expected 403 SUPPORT_GRANT_REQUIRED)`;
      obs.leaks.push(msg);
      t.leaks.push(msg);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: entry.path } });
    }

    // Invariant 1: Check for foreign workspace leaks
    const foundLeaks = scanForLeaks(t, reply, foreignSlots, {
      echoedInputs: r1.echoed,
      context: `${principal} ${entry.method} ${entry.path} (target=${targetSlot})`,
    });
    for (const l of foundLeaks) {
      obs.leaks.push(l);
      t.leaks.push(l);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: entry.path, target: targetSlot } });
    }

    // Also test unscoped (no workspaceId query param) for list/context endpoints when support caller
    if (isSupportCaller && entry.method === "GET" && !entry.path.includes("{")) {
      const unscopedReply = await rawFetch("GET", entry.path, baseOpts);
      const uLeaks = scanForLeaks(t, unscopedReply, foreignSlots, {
        context: `${principal} GET ${entry.path} (unscoped)`,
      });
      for (const l of uLeaks) {
        obs.leaks.push(l);
        t.leaks.push(l);
        t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: entry.path, target: "unscoped" } });
      }
      // Also check aggregate recount on /v1/support/audience/health (Invariant 4)
      if (entry.path === "/v1/support/audience/health" && unscopedReply.status === 200 && allowedSlots.length === 1) {
        const w = t.ws[allowedSlots[0]!];
        const committed = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audience_imports WHERE workspace_id=$1 AND status='committed'`,
          [w.id],
        );
        const got = unscopedReply.body?.imports?.length;
        if (got !== committed.rows[0]!.n) {
          obs.aggregateMismatches.push(`${principal} /v1/support/audience/health imports.length: expected ${committed.rows[0]!.n}, observed ${got}`);
        }
      }
    }

    // Invariant 3: Indistinguishability on foreign IDs for support callers
    if (isSupportCaller && !allowedSlots.includes(targetSlot) && entry.path.includes("{") && !entry.path.includes("{requestId}")) {
      const rMiss = buildPath("missing");
      const missReply = await rawFetch(entry.method, rMiss.path, { ...baseOpts, body });
      const oracle = checkIndistinguishable(
        `${principal} ${entry.method} ${entry.path} (target=${targetSlot})`,
        reply,
        missReply,
        r1.echoed,
        rMiss.echoed,
      );
      if (oracle) {
        obs.probeOracles.push(oracle);
        t.probeOracles.push(oracle);
        t.pendingEvents.push({ name: "isolation.id_oracle", data: { principal, route: entry.path } });
      }
    }
  };
  for (let i = 0; i < SUPPORT_CEILINGS.length; i += 6) {
    if (isSupportCaller) {
      await pool.query(`UPDATE support_conversations SET used = 0 WHERE id = ANY($1::text[])`, [t.convIds]);
    }
    await Promise.all(SUPPORT_CEILINGS.slice(i, i + 6).map(checkSupportEntry));
  }

  // Also probe customer-facing /v1/support-actions/{id} (+ confirm/decline) against foreign action IDs!
  if (!isSupportCaller) {
    for (const [m, p] of [
      ["GET", `/v1/support-actions/${target.supportActionId}`],
      ["POST", `/v1/support-actions/${target.supportActionId}/confirm`],
      ["POST", `/v1/support-actions/${target.supportActionId}/decline`],
    ] as const) {
      const reply = await rawFetch(m, p, baseOpts);
      obs.routesDriven += 1;
      t.totalRoutesDriven += 1;
      t.uniqueSupportRoutesDriven.add(`${m} ${p.replace(target.supportActionId, "{id}")}`);
      const foundLeaks = scanForLeaks(t, reply, foreignSlots, {
        echoedInputs: [target.supportActionId],
        context: `${principal} ${m} /v1/support-actions/{id} (target=${targetSlot})`,
      });
      for (const l of foundLeaks) {
        obs.leaks.push(l);
        t.leaks.push(l);
        t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: p } });
      }
      if (!allowedSlots.includes(targetSlot) && principal === "ownerA") {
        const missReply = await rawFetch(m, p.replace(target.supportActionId, `sac_${"0".repeat(32)}`), baseOpts);
        const oracle = checkIndistinguishable(`${principal} ${m} /v1/support-actions/{id}`, reply, missReply, [target.supportActionId], [`sac_${"0".repeat(32)}`]);
        if (oracle) {
          obs.probeOracles.push(oracle);
          t.probeOracles.push(oracle);
          t.pendingEvents.push({ name: "isolation.id_oracle", data: { principal, route: p } });
        }
      }
    }
  }

  const snapAfter = await snapshotWorkspaces(t.wsIds);
  const diffs = diffWorkspaces(snapBefore, snapAfter, tracker.watchIds(foreignSlots));
  for (const d of diffs) {
    const msg = `${principal} support target=${targetSlot}: ${d}`;
    obs.foreignMutations.push(msg);
    t.foreignMutations.push(msg);
    t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { principal, diff: d } });
  }

  return obs;
  } finally {
    tracker.end();
  }
}

function mcpChunkForPath(p: string): McpChunk {
  const g = classifyGroup(p);
  if (g === "auth" || g === "ops" || g === "workspaces" || g === "billing" || g === "other") return "auth-ops";
  if (g === "audience") return "audience";
  if (g === "templates" || g === "emails" || g === "campaigns" || g === "domains" || g === "webhooks") return "sending";
  if (g === "routing-rules" || g === "inboxes") return "routing-inboxes";
  return "inbound";
}

async function runProbeMcp(
  t: Trial,
  principal: McpPrincipal,
  chunk: McpChunk,
  targetSlot: WorkspaceSlot,
): Promise<WorkspaceIsolationObs> {
  const allowedSlots = activeSlotsFor(principal);
  const foreignSlots = foreignSlotsFor(allowedSlots);
  const tracker = beginSlotTracking(t, principal === "mcpDual" ? ["A"] : allowedSlots);
  const target = t.ws[targetSlot];

  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  try {
  const bearer =
    principal === "mcpA"
      ? t.mcpAAccess
      : principal === "mcpDual"
        ? t.mcpDualAccess
        : principal === "keyA"
          ? t.ws.A.apiKeySecret
          : principal === "dkeyA"
            ? t.ws.A.domainKeySecret
            : undefined;

  const mcpRpc = (method: string, params: object) =>
    rawFetch("POST", "/mcp?codemode=true", {
      bearer,
      body: { jsonrpc: "2.0", id: 1, method, params },
      headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    });

  const snapBefore = await snapshotWorkspaces(t.wsIds);

  // 1. tools/list
  const listRes = await mcpRpc("tools/list", {});
  obs.routesDriven += 1;
  t.totalRoutesDriven += 1;
  if (principal === "anon") {
    if (listRes.status !== 401) {
      obs.leaks.push(`anon /mcp tools/list returned ${listRes.status} (expected 401)`);
      t.leaks.push(`anon /mcp tools/list returned ${listRes.status}`);
    }
    return obs;
  }

  // 2. For OAuth MCP sessions, check workspaces & setDefaultWorkspace with foreign workspace!
  if (principal === "mcpA" || principal === "mcpDual") {
    const wsRes = await mcpRpc("tools/call", { name: "workspaces", arguments: {} });
    obs.routesDriven += 1;
    t.uniqueMcpToolsDriven.add("workspaces");
    for (const l of scanForLeaks(t, wsRes, foreignSlots, { context: `${principal} mcp:workspaces` })) {
      obs.leaks.push(l);
      t.leaks.push(l);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal, tool: "workspaces" } });
    }
    // Attempt setDefaultWorkspace to a foreign workspace (e.g. C for mcpDual, B/C for mcpA)
    if (foreignSlots.includes(targetSlot)) {
      const setRes = await mcpRpc("tools/call", { name: "setDefaultWorkspace", arguments: { workspace: target.id } });
      obs.routesDriven += 1;
      t.uniqueMcpToolsDriven.add("setDefaultWorkspace");
      for (const l of scanForLeaks(t, setRes, foreignSlots, { echoedInputs: [target.id], context: `${principal} mcp:setDefaultWorkspace(${targetSlot})` })) {
        obs.leaks.push(l);
        t.leaks.push(l);
        t.pendingEvents.push({ name: "isolation.leak", data: { principal, tool: "setDefaultWorkspace" } });
      }
    }
  }

  // 3. Drive EVERY tool in the dynamically enumerated MCP catalog!
  // For each tool, pass target's IDs (and for mcpDual, pass workspace: A when targeting B/C!).
  const visibleToolNames = new Set<string>(
    (listRes.body?.result?.tools ?? []).map((x: any) => x.name),
  );
  const callerWs = t.ws.A;

  for (const [toolName, op] of mcpCatalog.entries()) {
    if (!visibleToolNames.has(toolName)) continue;
    if (mcpChunkForPath(op.path) !== chunk) continue;
    // Build MCP arguments from the tool's inputSchema using target's IDs!
    const props = (op.tool.inputSchema?.properties ?? {}) as Record<string, any>;
    const required = new Set<string>(op.tool.inputSchema?.required ?? []);
    const args: Record<string, unknown> = {};
    const echoed: string[] = [];
    const put = (k: string, v: unknown) => {
      args[k] = v;
      if (typeof v === "string") echoed.push(v);
    };

    if (principal === "mcpA" || principal === "mcpDual") {
      args.workspace = t.ws.A.id;
    }

    // Fill IDs targeting `target`!
    for (const k of Object.keys(props)) {
      if (k === "workspace") continue;
      if (k === "contactId") put(k, target.contactIds[0]!);
      else if (k === "contactIds") args[k] = [target.contactIds[0]!];
      else if (k === "listId") put(k, target.listIds[0]!);
      else if (k === "segmentId") put(k, target.segmentIds[0]!);
      else if (k === "importId") put(k, target.importIds[0]!);
      else if (k === "planId") put(k, target.planId);
      else if (k === "newsletterId") put(k, target.newsletterId);
      else if (k === "templateId" || k === "sourceTemplateId") put(k, target.templateId);
      else if (k === "assetId") put(k, target.templateAssetId);
      else if (k === "emailId") put(k, target.emailIds[0]!);
      else if (k === "attachmentId") put(k, target.attachmentId);
      else if (k === "campaignId") put(k, target.campaignDraftId);
      else if (k === "domainId") put(k, op.path.startsWith("/v1/inbound/") ? target.mailboxDomainId : target.domainId);
      else if (k === "subdomainId" || k === "hostId") put(k, target.mailboxSubdomainId);
      else if (k === "webhookId") put(k, op.path.startsWith("/v1/inbound/") ? target.inboundWebhookId : target.webhookId);
      else if (k === "deliveryId") put(k, op.path.startsWith("/v1/inbound/") ? target.inboundWebhookDeliveryId : target.webhookDeliveryId);
      else if (k === "routeId") put(k, target.routeId);
      else if (k === "inboxId") put(k, target.inboxId);
      else if (k === "addressId") put(k, target.addressId);
      else if (k === "threadId") put(k, target.threadId);
      else if (k === "messageId") put(k, target.inboundMessageId);
      else if (k === "passwordId") put(k, target.appPasswordId);
      else if (k === "keyId") put(k, target.apiKeyId);
      else if (k === "tokenId") put(k, target.agentTokenId);
      else if (k === "connectionId") put(k, target.mcpGrantId);
      else if (k === "paymentId") put(k, target.paymentId);
      else if (k === "memberId") put(k, target.ownerMemberId);
      else if (k === "invitationId") put(k, target.invitationId);
      else if (k === "folder") put(k, target.customFolderRole);
      else if (k === "key" && op.path.includes("/rules/")) put(k, target.ruleKey);
      else if (k === "name" && op.path.includes("/endpoints/")) put(k, target.endpointKey);
      else if (k === "address" && op.path.includes("/retired/")) put(k, target.retiredAddress);
      else if (k === "id" && required.has(k)) {
        if (op.path.includes("/members/")) put(k, target.ownerMemberId);
        else if (op.path.includes("/invitations")) put(k, target.invitationId);
        else put(k, target.id);
      } else if (required.has(k)) {
        // Fill minimal valid required value based on schema
        const sch = props[k];
        if (sch?.enum?.length) args[k] = sch.enum[0];
        else if (sch?.type === "boolean") args[k] = false;
        else if (sch?.type === "integer" || sch?.type === "number") args[k] = sch.minimum ?? 1;
        else if (sch?.type === "array") args[k] = [];
        else if (sch?.type === "object") args[k] = {};
        else if (k === "region") args[k] = "us-east-1";
        else if (k === "from") args[k] = `probe@${callerWs.domainName}`;
        else if (k === "email") args[k] = `probe-${hex(4)}@example.com`;
        else if (k === "url") args[k] = `https://probe-${hex(4)}.example.com/hook`;
        else if (k === "statement") args[k] = `SELECT email FROM contacts WHERE email CONTAINS '${target.marker.toLowerCase()}'`;
        else if (k === "csv") args[k] = "email,name\nprobe@example.com,Probe";
        else if (k === "scheduledAt") args[k] = new Date(Date.now() + 7200_000).toISOString();
        else args[k] = "probe";
      }
    }

    // Only skip write tools that don't carry any foreign ID when target is allowed (avoid mutating A's own fixture unnecessarily)
    if (op.method !== "get" && allowedSlots.includes(targetSlot)) continue;

    // For mcpDual calling with workspace: A, B is foreign to this specific call!
    const callForeignSlots: WorkspaceSlot[] =
      principal === "mcpDual" ? ["B", "C"] : foreignSlots;

    const callRes = await mcpRpc("tools/call", { name: toolName, arguments: args });
    obs.routesDriven += 1;
    t.totalRoutesDriven += 1;
    t.uniqueMcpToolsDriven.add(toolName);

    const foundLeaks = scanForLeaks(t, callRes, callForeignSlots, {
      echoedInputs: echoed,
      context: `${principal} mcp:${toolName} (target=${targetSlot})`,
    });
    for (const l of foundLeaks) {
      obs.leaks.push(l);
      t.leaks.push(l);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal, tool: toolName, target: targetSlot } });
    }
  }

  // Check foreign mutations (for mcpDual pinned to workspace A, B and C must both be untouched!)
  const mcpForeign: WorkspaceSlot[] = principal === "mcpDual" ? ["B", "C"] : foreignSlots;
  const snapAfter = await snapshotWorkspaces(t.wsIds);
  const diffs = diffWorkspaces(snapBefore, snapAfter, tracker.watchIds(mcpForeign));
  for (const d of diffs) {
    const msg = `${principal} mcp target=${targetSlot}: ${d}`;
    obs.foreignMutations.push(msg);
    t.foreignMutations.push(msg);
    t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { principal, diff: d } });
  }

  return obs;
  } finally {
    tracker.end();
  }
}

async function runCheckAggregates(t: Trial, principal: AggregatePrincipal): Promise<WorkspaceIsolationObs> {
  const allowedSlots = activeSlotsFor(principal);
  const foreignSlots = foreignSlotsFor(allowedSlots);
  const slot = allowedSlots[0]!;
  const w = t.ws[slot];
  const tracker = beginSlotTracking(t, allowedSlots);
  try {

  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  // Direct SQL recount over ONLY workspace `w.id`
  const {
    rows: [sqlCounts],
  } = await pool.query<{
    contacts: number;
    lists: number;
    newsletters: number;
    segments: number;
    imports: number;
    templates: number;
    emails: number;
    campaigns: number;
    domains: number;
    webhooks: number;
    api_keys: number;
    inboxes: number;
    addresses: number;
    total_mailboxes: number;
    threads: number;
    messages: number;
    members: number;
    invitations: number;
    audit_visible: number;
    payments: number;
    ledger: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM audience_contacts WHERE workspace_id=$1 AND deleted_at IS NULL) AS contacts,
      (SELECT count(*)::int FROM audience_lists WHERE workspace_id=$1) AS lists,
      (SELECT count(*)::int FROM audience_lists WHERE workspace_id=$1 AND newsletter_from IS NOT NULL) AS newsletters,
      (SELECT count(*)::int FROM audience_segments WHERE workspace_id=$1) AS segments,
      (SELECT count(*)::int FROM audience_imports WHERE workspace_id=$1) AS imports,
      (SELECT count(*)::int FROM campaign_templates WHERE workspace_id=$1 AND archived_at IS NULL) AS templates,
      (SELECT count(*)::int FROM sending_emails WHERE workspace_id=$1) AS emails,
      (SELECT count(*)::int FROM sending_campaigns WHERE workspace_id=$1 AND archived_at IS NULL) AS campaigns,
      (SELECT count(*)::int FROM operation_domains WHERE workspace_id=$1) AS domains,
      (SELECT count(*)::int FROM operation_webhooks WHERE workspace_id=$1) AS webhooks,
      (SELECT count(*)::int FROM api_keys WHERE workspace_id=$1) + (SELECT count(*)::int FROM mailbox_keys WHERE workspace_id=$1) AS api_keys,
      (SELECT count(*)::int FROM mailboxes WHERE workspace_id=$1 AND kind='inbox' AND (delete_after IS NULL OR delete_after > now())) AS inboxes,
      (SELECT count(*)::int FROM mailboxes WHERE workspace_id=$1 AND kind='address' AND (delete_after IS NULL OR delete_after > now())) AS addresses,
      (SELECT count(*)::int FROM mailboxes WHERE workspace_id=$1) AS total_mailboxes,
      (SELECT count(*)::int FROM mail_threads WHERE workspace_id=$1) AS threads,
      (SELECT count(*)::int FROM mail_messages WHERE workspace_id=$1 AND direction='inbound') AS messages,
      (SELECT count(*)::int FROM workspace_members WHERE workspace_id=$1) AS members,
      (SELECT count(*)::int FROM workspace_invitations WHERE workspace_id=$1 AND status='pending') AS invitations,
      (SELECT count(*)::int FROM audit_events WHERE workspace_id=$1 AND internal = false) AS audit_visible,
      (SELECT count(*)::int FROM billing_payment_attempts WHERE workspace_id=$1) AS payments,
      (SELECT count(*)::int FROM billing_ledger WHERE workspace_id=$1) AS ledger`,
    [w.id],
  );

  const expectEq = (label: string, actual: unknown, expected: number) => {
    if (actual !== expected) {
      const msg = `${principal} ${label}: expected ${expected} (workspace ${slot}), observed ${JSON.stringify(actual)}`;
      obs.aggregateMismatches.push(msg);
      t.aggregateMismatches.push(msg);
    }
  };

  if (principal === "supportA") {
    const baseOpts = { runtimeOverride: { platformCaller: "bane-support", supportConversation: w.convId } };
    const ctx = await rawFetch("GET", "/v1/support/context", baseOpts);
    obs.routesDriven += 1;
    if (ctx.status === 200) {
      expectEq("support/context workspaces.length", ctx.body?.workspaces?.length, 1);
      const c = ctx.body?.workspaces?.[0]?.counts;
      if (c) {
        const totalInboxes = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM mailboxes WHERE workspace_id=$1 AND kind='inbox'`, [w.id])).rows[0]!.n;
        expectEq("support/context counts.contacts", c.contacts, sqlCounts!.contacts);
        expectEq("support/context counts.domains", c.domains, sqlCounts!.domains);
        expectEq("support/context counts.campaigns", c.campaigns, sqlCounts!.campaigns);
        expectEq("support/context counts.templates", c.templates, sqlCounts!.templates);
        expectEq("support/context counts.inboxes", c.inboxes, totalInboxes);
        expectEq("support/context counts.addresses", c.addresses, sqlCounts!.addresses);
      }
      for (const l of scanForLeaks(t, ctx, foreignSlots, { context: "supportA GET /v1/support/context" })) {
        obs.leaks.push(l);
        t.leaks.push(l);
      }
    }
    // BUG-ISO-01 (#591) is fixed on dev: /v1/support/audience/health must return ONLY workspace A's committed imports!
    const aud = await rawFetch("GET", "/v1/support/audience/health", baseOpts);
    obs.routesDriven += 1;
    if (aud.status === 200) {
      expectEq("support/audience/health all.contacts", aud.body?.all?.contacts, sqlCounts!.contacts);
      expectEq("support/audience/health lists.length", aud.body?.lists?.length, sqlCounts!.lists);
      const committedImports = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audience_imports WHERE workspace_id=$1 AND status='committed'`,
        [w.id],
      );
      expectEq("support/audience/health imports.length", aud.body?.imports?.length, committedImports.rows[0]!.n);
      for (const l of scanForLeaks(t, aud, foreignSlots, { context: "supportA GET /v1/support/audience/health" })) {
        obs.leaks.push(l);
        t.leaks.push(l);
        t.pendingEvents.push({ name: "isolation.leak", data: { principal, route: "/v1/support/audience/health" } });
      }
    }
    return obs;
  }

  const auth = authOptsFor(t, principal);
  const checks: Array<{ path: string; extract: (b: any) => number | undefined; expected: number; adminOnly?: boolean; dashOnly?: boolean }> = [
    { path: "/v1/contacts?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.contacts },
    { path: "/v1/lists?limit=100&counts=true", extract: (b) => b?.data?.length, expected: sqlCounts!.lists },
    { path: "/v1/newsletters?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.newsletters },
    { path: "/v1/segments?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.segments },
    { path: "/v1/contact-imports?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.imports },
    { path: "/v1/templates?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.templates },
    { path: "/v1/emails?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.emails },
    { path: "/v1/campaigns?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.campaigns },
    { path: "/v1/domains?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.domains, adminOnly: true },
    { path: "/v1/webhooks?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.webhooks, adminOnly: true },
    { path: "/v1/api-keys?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.api_keys, adminOnly: true },
    { path: "/v1/inboxes?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.inboxes, adminOnly: true },
    { path: "/v1/inbound/addresses?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.total_mailboxes, adminOnly: true },
    { path: "/v1/inbound/threads?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.threads },
    { path: "/v1/inbound/messages?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.messages, adminOnly: true },
    { path: "/v1/workspaces/current/members", extract: (b) => b?.data?.length, expected: sqlCounts!.members, adminOnly: true, dashOnly: true },
    { path: "/v1/workspaces/current/invitations", extract: (b) => b?.data?.length, expected: sqlCounts!.invitations, adminOnly: true, dashOnly: true },
    { path: "/v1/activity?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.audit_visible, adminOnly: true, dashOnly: true },
    { path: "/v1/billing/payments?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.payments, adminOnly: true },
    { path: "/v1/billing/ledger?limit=100", extract: (b) => b?.data?.length, expected: sqlCounts!.ledger, adminOnly: true },
  ];

  for (const ch of checks) {
    if (ch.adminOnly && principal === "memberA") continue;
    if (ch.dashOnly && principal === "keyA") continue;
    const r = await rawFetch("GET", ch.path, auth);
    obs.routesDriven += 1;
    t.totalRoutesDriven += 1;
    if (r.status === 200) {
      expectEq(ch.path, ch.extract(r.body), ch.expected);
    }
    for (const l of scanForLeaks(t, r, foreignSlots, { context: `${principal} aggregate ${ch.path}` })) {
      obs.leaks.push(l);
      t.leaks.push(l);
    }
  }

  // Check /v1/metrics, /v1/usage, /v1/billing, /v1/logs?counts=true
  const billingRes = await rawFetch("GET", "/v1/billing", auth);
  obs.routesDriven += 1;
  if (billingRes.status === 200 && principal !== "memberA") {
    if (billingRes.body?.balance?.paid !== w.balanceUc) {
      const msg = `${principal} /v1/billing balance.paid: expected ${w.balanceUc}, got ${billingRes.body?.balance?.paid}`;
      obs.aggregateMismatches.push(msg);
      t.aggregateMismatches.push(msg);
    }
    if (billingRes.body?.paymentMethod?.last4 !== w.cardLast4) {
      const msg = `${principal} /v1/billing card_last4: expected ${w.cardLast4}, got ${billingRes.body?.paymentMethod?.last4}`;
      obs.aggregateMismatches.push(msg);
      t.aggregateMismatches.push(msg);
    }
  }
  for (const l of scanForLeaks(t, billingRes, foreignSlots, { context: `${principal} aggregate /v1/billing` })) {
    obs.leaks.push(l);
    t.leaks.push(l);
  }

  const metricsRes = await rawFetch("GET", "/v1/metrics", auth);
  obs.routesDriven += 1;
  for (const l of scanForLeaks(t, metricsRes, foreignSlots, { context: `${principal} aggregate /v1/metrics` })) {
    obs.leaks.push(l);
    t.leaks.push(l);
  }

  const logsRes = await rawFetch("GET", "/v1/logs?counts=true&limit=100", auth);
  obs.routesDriven += 1;
  if (logsRes.status === 200 && logsRes.body?.counts) {
    // Sent count in logs must equal caller's sending_emails count only!
    if (typeof logsRes.body.counts.sent === "number" && logsRes.body.counts.sent !== sqlCounts!.emails) {
      const msg = `${principal} /v1/logs counts.sent: expected ${sqlCounts!.emails}, got ${logsRes.body.counts.sent}`;
      obs.aggregateMismatches.push(msg);
      t.aggregateMismatches.push(msg);
    }
  }
  for (const l of scanForLeaks(t, logsRes, foreignSlots, { context: `${principal} aggregate /v1/logs` })) {
    obs.leaks.push(l);
    t.leaks.push(l);
  }

  return obs;
  } finally {
    tracker.end();
  }
}

async function runDualMismatch(
  t: Trial,
  headerSlot: WorkspaceSlot,
  targetSlot: WorkspaceSlot,
): Promise<WorkspaceIsolationObs> {
  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  const headerWs = t.ws[headerSlot];
  const targetWs = t.ws[targetSlot];
  const auth = { cookie: t.dualCookie, workspaceHeader: headerWs.id };
  const isAuthorizedHeader = headerSlot === "A" || headerSlot === "B";
  const foreignSlots: WorkspaceSlot[] = isAuthorizedHeader
    ? (["A", "B", "C"] as WorkspaceSlot[]).filter((s) => s !== headerSlot)
    : ["A", "B", "C"];
  const tracker = beginSlotTracking(t, isAuthorizedHeader ? [headerSlot] : []);
  const snapBefore = await snapshotWorkspaces(t.wsIds);
  try {

  // 1. Header = C (workspace dualUser does NOT belong to): MUST return 403 WORKSPACE_ACCESS_DENIED
  if (!isAuthorizedHeader) {
    for (const [m, p] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/contacts"],
      ["GET", "/v1/campaigns"],
      ["POST", "/v1/lists"],
    ] as const) {
      const r = await rawFetch(m, p, { ...auth, body: m === "POST" ? { name: "should-deny" } : undefined });
      obs.routesDriven += 1;
      if (r.status !== 403 || r.body?.error?.code !== "WORKSPACE_ACCESS_DENIED") {
        const msg = `dualC ${m} ${p}: expected 403 WORKSPACE_ACCESS_DENIED, got ${r.status} ${r.body?.error?.code}`;
        obs.dualViolations.push(msg);
        t.dualViolations.push(msg);
      }
      for (const l of scanForLeaks(t, r, ["A", "B", "C"], { context: `dualC ${m} ${p}` })) {
        obs.leaks.push(l);
        t.leaks.push(l);
      }
    }
  } else if (headerSlot !== targetSlot) {
    // 2. Dual user has header = headerSlot (e.g. A), while path OR body carries targetSlot's IDs (e.g. B or C)!
    // Every single one of these MUST NOT read targetSlot, MUST NOT mutate targetSlot,
    // and MUST NOT link targetSlot's resources into headerSlot!
    const campaignAudienceCases: Array<{
      name: string;
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      path: string;
      body?: unknown;
      mustReject?: boolean;
      echoed: string[];
    }> = [
      { name: "create-campaign-with-other-list", method: "POST", path: "/v1/campaigns", body: { name: "CrossListCamp", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: targetWs.listIds[0]! } }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "create-campaign-with-other-segment", method: "POST", path: "/v1/campaigns", body: { name: "CrossSegCamp", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { segmentId: targetWs.segmentIds[0]! } }, mustReject: true, echoed: [targetWs.segmentIds[0]!] },
      { name: "create-campaign-with-other-exclude-list", method: "POST", path: "/v1/campaigns", body: { name: "CrossExclList", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: headerWs.listIds[0]!, excludeListIds: [targetWs.listIds[0]!] } }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "create-campaign-with-other-exclude-segment", method: "POST", path: "/v1/campaigns", body: { name: "CrossExclSeg", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: headerWs.listIds[0]!, excludeSegmentIds: [targetWs.segmentIds[0]!] } }, mustReject: true, echoed: [targetWs.segmentIds[0]!] },
      { name: "patch-own-campaign-with-other-list", method: "PATCH", path: `/v1/campaigns/${headerWs.campaignDraftId}`, body: { revision: 1, draft: { name: "CrossPatch", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [], tracking: true, audience: { listId: targetWs.listIds[0]! }, defaults: {} } }, mustReject: true, echoed: [targetWs.listIds[0]!] },
    ];
    const inboundWebhookCases: typeof campaignAudienceCases = [
      { name: "create-inbound-webhook-for-other-addr", method: "POST", path: "/v1/inbound/webhooks", body: { url: "https://cross.example.com/wh", eventTypes: ["message.received"], addressIds: [targetWs.addressId] }, mustReject: true, echoed: [targetWs.addressId] },
      { name: "update-own-inbound-webhook-other-addr", method: "PATCH", path: `/v1/inbound/webhooks/${headerWs.inboundWebhookId}`, body: { addressIds: [targetWs.addressId] }, mustReject: true, echoed: [targetWs.addressId] },
    ];
    const coreCases: typeof campaignAudienceCases = [
      // Path carries other workspace's ID
      { name: "patch-other-campaign", method: "PATCH", path: `/v1/campaigns/${targetWs.campaignDraftId}`, body: { revision: 1, draft: { name: "Cross", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "Cross", html: "<p>x</p>", attachments: [], tracking: true, audience: {}, defaults: {} } }, mustReject: true, echoed: [targetWs.campaignDraftId] },
      { name: "patch-other-contact", method: "PATCH", path: `/v1/contacts/${targetWs.contactIds[0]}`, body: { name: "Cross" }, mustReject: true, echoed: [targetWs.contactIds[0]!] },
      { name: "patch-other-list", method: "PATCH", path: `/v1/lists/${targetWs.listIds[0]}`, body: { name: "Cross" }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "delete-other-webhook", method: "DELETE", path: `/v1/webhooks/${targetWs.webhookId}`, mustReject: true, echoed: [targetWs.webhookId] },
      { name: "patch-other-template", method: "PATCH", path: `/v1/templates/${targetWs.templateId}`, body: { revision: 1, draft: { name: "Cross", description: "", subject: "s", replyTo: [], html: "<p>x</p>", attachments: [] } }, mustReject: true, echoed: [targetWs.templateId] },
      { name: "get-other-email", method: "GET", path: `/v1/emails/${targetWs.emailIds[0]}`, mustReject: true, echoed: [targetWs.emailIds[0]!] },
      { name: "get-other-attachment", method: "GET", path: `/v1/attachments/${targetWs.attachmentId}/content`, mustReject: true, echoed: [targetWs.attachmentId] },
      { name: "patch-other-inbox", method: "PATCH", path: `/v1/inboxes/${targetWs.inboxId}`, body: { name: "Cross" }, mustReject: true, echoed: [targetWs.inboxId] },
      { name: "patch-other-thread", method: "PATCH", path: `/v1/inbound/threads/${targetWs.threadId}`, body: { read: true }, mustReject: true, echoed: [targetWs.threadId] },
      { name: "revoke-other-apikey", method: "POST", path: `/v1/api-keys/${targetWs.apiKeyId}/revoke`, mustReject: true, echoed: [targetWs.apiKeyId] },
      { name: "remove-other-member", method: "DELETE", path: `/v1/workspaces/current/members/${targetWs.ownerMemberId}`, mustReject: true, echoed: [targetWs.ownerMemberId] },
      // Path is headerWs (valid!) or collection, BODY carries targetWs's IDs!
      { name: "add-other-contact-to-own-list", method: "POST", path: `/v1/lists/${headerWs.listIds[0]}/members`, body: { contactIds: [targetWs.contactIds[0]!] }, mustReject: true, echoed: [targetWs.contactIds[0]!] },
      { name: "create-campaign-with-other-attachment", method: "POST", path: "/v1/campaigns", body: { name: "CrossAttCamp", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [targetWs.attachmentId] }, mustReject: true, echoed: [targetWs.attachmentId] },
      { name: "create-campaign-with-other-template", method: "POST", path: "/v1/campaigns", body: { name: "CrossTplCamp", from: `news@${headerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", templateId: targetWs.templateId }, mustReject: true, echoed: [targetWs.templateId] },
      { name: "send-email-with-other-attachment", method: "POST", path: "/v1/emails/send", body: { from: `a@${headerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", attachments: [targetWs.attachmentId] }, mustReject: true, echoed: [targetWs.attachmentId] },
      { name: "import-contacts-into-other-list", method: "POST", path: "/v1/contact-imports", body: { csv: "email,name\ncross@example.com,C", listId: targetWs.listIds[0]!, mapping: { email: "email", name: "name" } }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "apply-other-audience-plan", method: "POST", path: "/v1/audience-query/apply", body: { planId: targetWs.planId }, mustReject: true, echoed: [targetWs.planId] },
      { name: "create-newsletter-from-other-list", method: "POST", path: "/v1/newsletters", body: { listId: targetWs.listIds[0]!, from: `nl@${headerWs.domainName}` }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "create-apikey-for-other-inbox", method: "POST", path: "/v1/api-keys", body: { name: "CrossInbKey", access: { type: "inbox", inboxId: targetWs.inboxId, mail: ["read"] } }, mustReject: true, echoed: [targetWs.inboxId] },
      { name: "create-apikey-for-other-address", method: "POST", path: "/v1/api-keys", body: { name: "CrossAddrKey", access: { type: "addresses", addressIds: [targetWs.addressId], mail: ["read"] } }, mustReject: true, echoed: [targetWs.addressId] },
      { name: "create-inbound-thread-from-other-addr", method: "POST", path: "/v1/inbound/threads", body: { addressId: targetWs.addressId, to: ["x@example.org"], subject: "s", text: "t" }, mustReject: true, echoed: [targetWs.addressId] },
      { name: "create-route-to-other-inbox", method: "POST", path: "/v1/routing/routes", body: { match: `cross@${headerWs.domainName}`, to: [targetWs.inboxId] }, mustReject: true, echoed: [targetWs.inboxId] },
      { name: "preview-own-segment-with-other-list", method: "POST", path: `/v1/segments/${headerWs.segmentIds[0]}/preview`, body: { listId: targetWs.listIds[0]! }, mustReject: true, echoed: [targetWs.listIds[0]!] },
      { name: "check-other-email", method: "POST", path: "/v1/emails/check", body: { emailId: targetWs.emailIds[0]! }, mustReject: true, echoed: [targetWs.emailIds[0]!] },
      { name: "check-other-campaign", method: "POST", path: "/v1/emails/check", body: { campaignId: targetWs.campaignDraftId }, mustReject: true, echoed: [targetWs.campaignDraftId] },
      { name: "test-routing-other-message", method: "POST", path: "/v1/routing/test", body: { messageId: targetWs.inboundMessageId }, mustReject: true, echoed: [targetWs.inboundMessageId] },
      { name: "test-rules-other-message", method: "POST", path: "/v1/rules/test", body: { messageId: targetWs.inboundMessageId }, mustReject: true, echoed: [targetWs.inboundMessageId] },
      { name: "update-own-apikey-with-other-inbox", method: "PATCH", path: `/v1/api-keys/${headerWs.mailboxKeyId}`, body: { access: { type: "inbox", inboxId: targetWs.inboxId } }, mustReject: true, echoed: [targetWs.inboxId] },
      { name: "update-own-apikey-add-other-address", method: "PATCH", path: `/v1/api-keys/${headerWs.mailboxKeyId}`, body: { access: { type: "addresses", addressIds: [targetWs.addressId] } }, mustReject: true, echoed: [targetWs.addressId] },
      { name: "attach-rules-to-other-addr", method: "PUT", path: "/v1/rules/attachments", body: { attachments: [{ rule: headerWs.ruleKey, target: targetWs.addressId }] }, mustReject: true, echoed: [targetWs.addressId] },
    ];

    // All three groups (campaign audience #611, inbound webhook addressIds #612, and core path/body) now run unmasked!
    const crossCases = [...campaignAudienceCases, ...inboundWebhookCases, ...coreCases];

    for (const tc of crossCases) {
      const r = await rawFetch(tc.method, tc.path, { ...auth, body: tc.body });
      obs.routesDriven += 1;
      t.totalRoutesDriven += 1;
      if (tc.mustReject && r.status >= 200 && r.status < 300) {
        const msg = `dual(header=${headerSlot},target=${targetSlot}) ${tc.name} (${tc.method} ${tc.path}): ACCEPTED with ${r.status}! body=${r.text.slice(0, 160)}`;
        obs.dualViolations.push(msg);
        t.dualViolations.push(msg);
      }
      for (const l of scanForLeaks(t, r, foreignSlots, { echoedInputs: tc.echoed, context: `dual(${headerSlot}->${targetSlot}) ${tc.name}` })) {
        obs.leaks.push(l);
        t.leaks.push(l);
        t.pendingEvents.push({ name: "isolation.leak", data: { principal: `dual${headerSlot}`, case: tc.name } });
      }
    }
  }

  const snapAfter = await snapshotWorkspaces(t.wsIds);
  const diffs = diffWorkspaces(snapBefore, snapAfter, tracker.watchIds(foreignSlots));
  for (const d of diffs) {
    const msg = `dual(header=${headerSlot},target=${targetSlot}): ${d}`;
    obs.foreignMutations.push(msg);
    t.foreignMutations.push(msg);
    t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { headerSlot, targetSlot, diff: d } });
  }

  return obs;
  } finally {
    tracker.end();
  }
}


// ---------- Exhaustive ID-carrying field probes (bodies + queries + #614 + nearby edge cases) ----------
async function runProbeFields(
  t: Trial,
  principal: "ownerA" | "dualA" | "dualB" | "keyA",
  targetSlot: WorkspaceSlot,
  focus: FieldProbeFocus,
): Promise<WorkspaceIsolationObs> {
  const allowedSlots = activeSlotsFor(principal);
  const callerSlot = allowedSlots[0]!;
  const foreignSlots = foreignSlotsFor(allowedSlots);
  const callerWs = t.ws[callerSlot];
  const targetWs = t.ws[targetSlot];
  const auth = authOptsFor(t, principal);
  const tracker = beginSlotTracking(t, allowedSlots);

  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  const snapBefore = await snapshotWorkspaces(t.wsIds);
  const isMaskedFocus = focus === "pr614-bug-iso-04" || focus === "nearby-own-ended";
  const miss = (prefix: string, hexLen = 24) => `${prefix}${"0".repeat(hexLen)}`;

  interface FieldPair {
    name: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    pathReal: string;
    pathMiss: string;
    bodyReal?: unknown;
    bodyMiss?: unknown;
    headers?: Record<string, string>;
    realTokens: string[];
    missTokens: string[];
    mustRejectWrite?: boolean;
    skipOracle?: boolean;
  }

  try {
    const pairs: FieldPair[] = [];

    if (focus === "body-writes") {
      // Every ID-carrying body field across all write routes, comparing foreign real ID vs nonexistent ID!
      const p: FieldPair[] = [
        // Campaigns (BUG-ISO-02 #611 — fixed on dev: must reject with 404 identical to missing!)
        { name: "createCampaign.audience.listId", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F1", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: targetWs.listIds[0]! } },
          bodyMiss: { name: "F1", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: miss("lst_") } },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        { name: "createCampaign.audience.segmentId", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F2", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { segmentId: targetWs.segmentIds[0]! } },
          bodyMiss: { name: "F2", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { segmentId: miss("seg_") } },
          realTokens: [targetWs.segmentIds[0]!], missTokens: [miss("seg_")], mustRejectWrite: true },
        { name: "createCampaign.audience.excludeListIds", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F3", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: callerWs.listIds[0]!, excludeListIds: [targetWs.listIds[0]!] } },
          bodyMiss: { name: "F3", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: callerWs.listIds[0]!, excludeListIds: [miss("lst_")] } },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        { name: "createCampaign.audience.excludeSegmentIds", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F4", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: callerWs.listIds[0]!, excludeSegmentIds: [targetWs.segmentIds[0]!] } },
          bodyMiss: { name: "F4", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", audience: { listId: callerWs.listIds[0]!, excludeSegmentIds: [miss("seg_")] } },
          realTokens: [targetWs.segmentIds[0]!], missTokens: [miss("seg_")], mustRejectWrite: true },
        { name: "createCampaign.attachments", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F5", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [targetWs.attachmentId] },
          bodyMiss: { name: "F5", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [miss("att_")] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        { name: "createCampaign.templateId", method: "POST", pathReal: "/v1/campaigns", pathMiss: "/v1/campaigns",
          bodyReal: { name: "F6", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", templateId: targetWs.templateId },
          bodyMiss: { name: "F6", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", templateId: miss("tpl_", 32) },
          realTokens: [targetWs.templateId], missTokens: [miss("tpl_", 32)], mustRejectWrite: true },
        { name: "updateCampaign.draft.audience.listId", method: "PATCH", pathReal: `/v1/campaigns/${callerWs.campaignDraftId}`, pathMiss: `/v1/campaigns/${callerWs.campaignDraftId}`,
          bodyReal: { revision: 1, draft: { name: "U1", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [], tracking: true, audience: { listId: targetWs.listIds[0]! }, defaults: {} } },
          bodyMiss: { revision: 1, draft: { name: "U1", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [], tracking: true, audience: { listId: miss("lst_") }, defaults: {} } },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        { name: "updateCampaign.draft.attachments", method: "PATCH", pathReal: `/v1/campaigns/${callerWs.campaignDraftId}`, pathMiss: `/v1/campaigns/${callerWs.campaignDraftId}`,
          bodyReal: { revision: 1, draft: { name: "U2", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [targetWs.attachmentId], tracking: true, audience: {}, defaults: {} } },
          bodyMiss: { revision: 1, draft: { name: "U2", from: `news@${callerWs.domainName}`, region: "us-east-1", subject: "s", html: "<p>x</p>", attachments: [miss("att_")], tracking: true, audience: {}, defaults: {} } },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        // Inbound webhooks (BUG-ISO-03 #612 — fixed on dev: must reject with 422 identical to missing!)
        { name: "createInboundWebhook.addressIds", method: "POST", pathReal: "/v1/inbound/webhooks", pathMiss: "/v1/inbound/webhooks",
          bodyReal: { url: "https://probe-inb.example.com/wh", eventTypes: ["message.received"], addressIds: [targetWs.addressId] },
          bodyMiss: { url: "https://probe-inb.example.com/wh", eventTypes: ["message.received"], addressIds: [miss("mbx_")] },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "updateInboundWebhook.addressIds", method: "PATCH", pathReal: `/v1/inbound/webhooks/${callerWs.inboundWebhookId}`, pathMiss: `/v1/inbound/webhooks/${callerWs.inboundWebhookId}`,
          bodyReal: { addressIds: [targetWs.addressId] },
          bodyMiss: { addressIds: [miss("mbx_")] },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        // Templates
        { name: "updateTemplate.draft.attachments", method: "PATCH", pathReal: `/v1/templates/${callerWs.templateId}`, pathMiss: `/v1/templates/${callerWs.templateId}`,
          bodyReal: { revision: 1, draft: { name: "T1", description: "", subject: "s", replyTo: [], html: "<p>x</p>", attachments: [targetWs.templateAssetId] } },
          bodyMiss: { revision: 1, draft: { name: "T1", description: "", subject: "s", replyTo: [], html: "<p>x</p>", attachments: [miss("tas_")] } },
          realTokens: [targetWs.templateAssetId], missTokens: [miss("tas_")], mustRejectWrite: true },
        // Emails (attachments, replyAddressId, replyMailboxId, checkEmail, previewEmail)
        { name: "sendEmail.attachments", method: "POST", pathReal: "/v1/emails/send", pathMiss: "/v1/emails/send",
          bodyReal: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", attachments: [targetWs.attachmentId] },
          bodyMiss: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", attachments: [miss("att_")] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        { name: "sendEmail.replyAddressId", method: "POST", pathReal: "/v1/emails/send", pathMiss: "/v1/emails/send",
          bodyReal: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", replyAddressId: targetWs.addressId },
          bodyMiss: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", replyAddressId: miss("mbx_") },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "sendEmail.replyMailboxId", method: "POST", pathReal: "/v1/emails/send", pathMiss: "/v1/emails/send",
          bodyReal: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", replyMailboxId: targetWs.inboxId },
          bodyMiss: { from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", replyMailboxId: miss("mbx_") },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "sendEmailBatch.attachments", method: "POST", pathReal: "/v1/emails/batch", pathMiss: "/v1/emails/batch",
          bodyReal: { emails: [{ from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", attachments: [targetWs.attachmentId] }] },
          bodyMiss: { emails: [{ from: `a@${callerWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t", attachments: [miss("att_")] }] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        { name: "checkEmail.emailId", method: "POST", pathReal: "/v1/emails/check", pathMiss: "/v1/emails/check",
          bodyReal: { emailId: targetWs.emailIds[0]! }, bodyMiss: { emailId: miss("eml_") },
          realTokens: [targetWs.emailIds[0]!], missTokens: [miss("eml_")], mustRejectWrite: true },
        { name: "checkEmail.campaignId", method: "POST", pathReal: "/v1/emails/check", pathMiss: "/v1/emails/check",
          bodyReal: { campaignId: targetWs.campaignDraftId }, bodyMiss: { campaignId: miss("cmp_") },
          realTokens: [targetWs.campaignDraftId], missTokens: [miss("cmp_")], mustRejectWrite: true },
        { name: "checkEmail.attachments", method: "POST", pathReal: "/v1/emails/check", pathMiss: "/v1/emails/check",
          bodyReal: { from: `a@${callerWs.domainName}`, subject: "s", text: "hello", stream: "transactional", attachments: [targetWs.attachmentId] },
          bodyMiss: { from: `a@${callerWs.domainName}`, subject: "s", text: "hello", stream: "transactional", attachments: [miss("att_")] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        { name: "previewEmail.emailId", method: "POST", pathReal: "/v1/emails/preview", pathMiss: "/v1/emails/preview",
          bodyReal: { emailId: targetWs.emailIds[0]!, clients: ["gmail-web"], theme: "light" },
          bodyMiss: { emailId: miss("eml_"), clients: ["gmail-web"], theme: "light" },
          realTokens: [targetWs.emailIds[0]!], missTokens: [miss("eml_")], mustRejectWrite: true },
        // Audience
        { name: "addListMembers.contactIds", method: "POST", pathReal: `/v1/lists/${callerWs.listIds[0]}/members`, pathMiss: `/v1/lists/${callerWs.listIds[0]}/members`,
          bodyReal: { contactIds: [targetWs.contactIds[0]!] }, bodyMiss: { contactIds: [miss("con_")] },
          realTokens: [targetWs.contactIds[0]!], missTokens: [miss("con_")], mustRejectWrite: true },
        { name: "previewSegment.listId", method: "POST", pathReal: `/v1/segments/${callerWs.segmentIds[0]}/preview`, pathMiss: `/v1/segments/${callerWs.segmentIds[0]}/preview`,
          bodyReal: { listId: targetWs.listIds[0]! }, bodyMiss: { listId: miss("lst_") },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        { name: "previewContactImport.listId", method: "POST", pathReal: "/v1/contact-imports", pathMiss: "/v1/contact-imports",
          bodyReal: { csv: "email,name\np@example.com,P", listId: targetWs.listIds[0]!, mapping: { email: "email", name: "name" } },
          bodyMiss: { csv: "email,name\np@example.com,P", listId: miss("lst_"), mapping: { email: "email", name: "name" } },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        { name: "applyAudiencePlan.planId", method: "POST", pathReal: "/v1/audience-query/apply", pathMiss: "/v1/audience-query/apply",
          bodyReal: { planId: targetWs.planId }, bodyMiss: { planId: miss("aqp_", 32) },
          realTokens: [targetWs.planId], missTokens: [miss("aqp_", 32)], mustRejectWrite: true },
        { name: "createNewsletter.listId", method: "POST", pathReal: "/v1/newsletters", pathMiss: "/v1/newsletters",
          bodyReal: { listId: targetWs.listIds[0]!, from: `nl@${callerWs.domainName}` },
          bodyMiss: { listId: miss("lst_"), from: `nl@${callerWs.domainName}` },
          realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")], mustRejectWrite: true },
        // API keys (scoped key)
        { name: "createApiKey.access.inboxId", method: "POST", pathReal: "/v1/api-keys", pathMiss: "/v1/api-keys",
          bodyReal: { name: "K1", access: { type: "inbox", inboxId: targetWs.inboxId, mail: ["read"] } },
          bodyMiss: { name: "K1", access: { type: "inbox", inboxId: miss("mbx_"), mail: ["read"] } },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createApiKey.access.addressIds", method: "POST", pathReal: "/v1/api-keys", pathMiss: "/v1/api-keys",
          bodyReal: { name: "K2", access: { type: "addresses", addressIds: [targetWs.addressId], mail: ["read"] } },
          bodyMiss: { name: "K2", access: { type: "addresses", addressIds: [miss("mbx_")], mail: ["read"] } },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "updateApiKey.scoped.inboxId", method: "PATCH", pathReal: `/v1/api-keys/${callerWs.mailboxKeyId}`, pathMiss: `/v1/api-keys/${callerWs.mailboxKeyId}`,
          bodyReal: { access: { type: "inbox", inboxId: targetWs.inboxId } },
          bodyMiss: { access: { type: "inbox", inboxId: miss("mbx_") } },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "updateApiKey.scoped.addressIds", method: "PATCH", pathReal: `/v1/api-keys/${callerWs.mailboxKeyId}`, pathMiss: `/v1/api-keys/${callerWs.mailboxKeyId}`,
          bodyReal: { access: { type: "addresses", addressIds: [targetWs.addressId] } },
          bodyMiss: { access: { type: "addresses", addressIds: [miss("mbx_")] } },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        // Inbound threads, replies, redeliver
        { name: "createInboundThread.addressId", method: "POST", pathReal: "/v1/inbound/threads", pathMiss: "/v1/inbound/threads",
          bodyReal: { addressId: targetWs.addressId, to: ["x@example.org"], subject: "s", text: "t" },
          bodyMiss: { addressId: miss("mbx_"), to: ["x@example.org"], subject: "s", text: "t" },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInboundThread.attachments", method: "POST", pathReal: "/v1/inbound/threads", pathMiss: "/v1/inbound/threads",
          bodyReal: { addressId: callerWs.addressId, to: ["x@example.org"], subject: "s", text: "t", attachments: [targetWs.attachmentId] },
          bodyMiss: { addressId: callerWs.addressId, to: ["x@example.org"], subject: "s", text: "t", attachments: [miss("att_")] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        { name: "updateInboundThread.addressId", method: "PATCH", pathReal: `/v1/inbound/threads/${callerWs.threadId}`, pathMiss: `/v1/inbound/threads/${callerWs.threadId}`,
          bodyReal: { addressId: targetWs.addressId, read: true },
          bodyMiss: { addressId: miss("mbx_"), read: true },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "replyToInboundThread.addressId", method: "POST", pathReal: `/v1/inbound/threads/${callerWs.threadId}/reply`, pathMiss: `/v1/inbound/threads/${callerWs.threadId}/reply`,
          bodyReal: { addressId: targetWs.addressId, text: "r" },
          bodyMiss: { addressId: miss("mbx_"), text: "r" },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "replyToInboundThread.replyToMessageId", method: "POST", pathReal: `/v1/inbound/threads/${callerWs.threadId}/reply`, pathMiss: `/v1/inbound/threads/${callerWs.threadId}/reply`,
          bodyReal: { addressId: callerWs.addressId, replyToMessageId: targetWs.inboundMessageId, text: "r" },
          bodyMiss: { addressId: callerWs.addressId, replyToMessageId: miss("msg_", 32), text: "r" },
          realTokens: [targetWs.inboundMessageId], missTokens: [miss("msg_", 32)], mustRejectWrite: true },
        { name: "replyToInboundThread.attachments", method: "POST", pathReal: `/v1/inbound/threads/${callerWs.threadId}/reply`, pathMiss: `/v1/inbound/threads/${callerWs.threadId}/reply`,
          bodyReal: { addressId: callerWs.addressId, text: "r", attachments: [targetWs.attachmentId] },
          bodyMiss: { addressId: callerWs.addressId, text: "r", attachments: [miss("att_")] },
          realTokens: [targetWs.attachmentId], missTokens: [miss("att_")], mustRejectWrite: true },
        // redeliverMessage (endpoints.ts:513) scopes by workspace_id and returns 202 {queued:0} identically for foreign & missing IDs
        { name: "redeliverInboundMessage.destination", method: "POST", pathReal: `/v1/inbound/messages/${callerWs.inboundMessageId}/redeliver`, pathMiss: `/v1/inbound/messages/${callerWs.inboundMessageId}/redeliver`,
          bodyReal: { destination: targetWs.inboundWebhookId },
          bodyMiss: { destination: miss("mwh_") },
          realTokens: [targetWs.inboundWebhookId], missTokens: [miss("mwh_")], mustRejectWrite: false },
        // Routing, rules, endpoints, inbox-connections, inbound addresses
        { name: "createRoute.to.inbox", method: "POST", pathReal: "/v1/routing/routes", pathMiss: "/v1/routing/routes",
          bodyReal: { match: `r1@${callerWs.domainName}`, to: [targetWs.inboxId] },
          bodyMiss: { match: `r1@${callerWs.domainName}`, to: [miss("mbx_")] },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createRoute.to.webhook", method: "POST", pathReal: "/v1/routing/routes", pathMiss: "/v1/routing/routes",
          bodyReal: { match: `r2@${callerWs.domainName}`, to: [targetWs.inboundWebhookId] },
          bodyMiss: { match: `r2@${callerWs.domainName}`, to: [miss("mwh_")] },
          realTokens: [targetWs.inboundWebhookId], missTokens: [miss("mwh_")], mustRejectWrite: true },
        { name: "updateRoute.to.inbox", method: "PATCH", pathReal: `/v1/routing/routes/${callerWs.routeId}`, pathMiss: `/v1/routing/routes/${callerWs.routeId}`,
          bodyReal: { to: [targetWs.inboxId] }, bodyMiss: { to: [miss("mbx_")] },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "applyRouting.to.inbox", method: "PUT", pathReal: "/v1/routing", pathMiss: "/v1/routing", headers: { "if-match": "1" },
          bodyReal: { version: 1, routes: [{ match: `r3@${callerWs.domainName}`, to: [targetWs.inboxId] }] },
          bodyMiss: { version: 1, routes: [{ match: `r3@${callerWs.domainName}`, to: [miss("mbx_")] }] },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "testRouting.messageId", method: "POST", pathReal: "/v1/routing/test", pathMiss: "/v1/routing/test",
          bodyReal: { messageId: targetWs.inboundMessageId }, bodyMiss: { messageId: miss("msg_", 32) },
          realTokens: [targetWs.inboundMessageId], missTokens: [miss("msg_", 32)], mustRejectWrite: true },
        { name: "testRules.messageId", method: "POST", pathReal: "/v1/rules/test", pathMiss: "/v1/rules/test",
          bodyReal: { messageId: targetWs.inboundMessageId }, bodyMiss: { messageId: miss("msg_", 32) },
          realTokens: [targetWs.inboundMessageId], missTokens: [miss("msg_", 32)], mustRejectWrite: true },
        { name: "attachRules.target", method: "PUT", pathReal: "/v1/rules/attachments", pathMiss: "/v1/rules/attachments", headers: { "if-match": "1" },
          bodyReal: { attachments: [{ rule: callerWs.ruleKey, target: targetWs.addressId }] },
          bodyMiss: { attachments: [{ rule: callerWs.ruleKey, target: miss("mbx_") }] },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createRuleFromRecipe.addresses", method: "POST", pathReal: "/v1/rules/recipes", pathMiss: "/v1/rules/recipes",
          bodyReal: { recipe: "auto-reply", addresses: [targetWs.addressId] },
          bodyMiss: { recipe: "auto-reply", addresses: [miss("mbx_")] },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createEndpoint.forward.from", method: "POST", pathReal: "/v1/endpoints", pathMiss: "/v1/endpoints",
          bodyReal: { type: "forward", name: "fwd-probe-1", address: "dest@example.org", from: targetWs.addressId },
          bodyMiss: { type: "forward", name: "fwd-probe-1", address: "dest@example.org", from: miss("mbx_") },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "sendEndpointVerification.from", method: "POST", pathReal: `/v1/endpoints/${callerWs.forwardEndpointKey}/verification`, pathMiss: `/v1/endpoints/${callerWs.forwardEndpointKey}/verification`,
          bodyReal: { from: targetWs.addressId }, bodyMiss: { from: miss("mbx_") },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInboxConnection.inboxes", method: "POST", pathReal: "/v1/inbox-connections", pathMiss: "/v1/inbox-connections",
          bodyReal: { inboxes: [targetWs.inboxId], client: "opencode", auth: "key" },
          bodyMiss: { inboxes: [miss("mbx_")], client: "opencode", auth: "key" },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInbox.domain", method: "POST", pathReal: "/v1/inboxes", pathMiss: "/v1/inboxes",
          bodyReal: { domain: targetWs.domainName, localPart: "p1" },
          bodyMiss: { domain: "missing-0000.example.com", localPart: "p1" },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "createInboundAddress.domain", method: "POST", pathReal: "/v1/inbound/addresses", pathMiss: "/v1/inbound/addresses",
          bodyReal: { address: `a1@${targetWs.domainName}` },
          bodyMiss: { address: "a1@missing-0000.example.com" },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "setInboundAddressFlow.deliver", method: "PATCH", pathReal: `/v1/inbound/addresses/${callerWs.addressId}/flow`, pathMiss: `/v1/inbound/addresses/${callerWs.addressId}/flow`,
          bodyReal: { deliver: [targetWs.inboxId] }, bodyMiss: { deliver: [miss("mbx_")] },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "sendEmail.fromForeignDomain", method: "POST", pathReal: "/v1/emails/send", pathMiss: "/v1/emails/send",
          bodyReal: { from: `a@${targetWs.domainName}`, to: "x@example.com", region: "us-east-1", subject: "s", text: "t" },
          bodyMiss: { from: "a@missing-0000.example.com", to: "x@example.com", region: "us-east-1", subject: "s", text: "t" },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "createInboundAddress.flow.deliver", method: "POST", pathReal: "/v1/inbound/addresses", pathMiss: "/v1/inbound/addresses",
          bodyReal: { address: `fl1@${callerWs.domainName}`, flow: { deliver: [targetWs.inboxId] } },
          bodyMiss: { address: `fl2@${callerWs.domainName}`, flow: { deliver: [miss("mbx_")] } },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInboundAddress.rules.foreignDomain", method: "POST", pathReal: "/v1/inbound/addresses", pathMiss: "/v1/inbound/addresses",
          bodyReal: { address: `rl1@${callerWs.domainName}`, rules: [`*@${targetWs.domainName}`] },
          bodyMiss: { address: `rl2@${callerWs.domainName}`, rules: ["*@missing-0000.example.com"] },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "testRouting.config.foreignInbox", method: "POST", pathReal: "/v1/routing/test", pathMiss: "/v1/routing/test",
          bodyReal: { envelope: { to: [`support@${callerWs.domainName}`] }, config: { routes: [{ match: `support@${callerWs.domainName}`, to: [targetWs.inboxId] }] } },
          bodyMiss: { envelope: { to: [`support@${callerWs.domainName}`] }, config: { routes: [{ match: `support@${callerWs.domainName}`, to: [miss("mbx_")] }] } },
          realTokens: [targetWs.inboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "configureDomainMailFrom.foreignDomain", method: "POST", pathReal: `/v1/domains/${callerWs.domainId}/mail-from`, pathMiss: `/v1/domains/${callerWs.domainId}/mail-from`,
          bodyReal: { mailFromDomain: `mail.${targetWs.domainName}` },
          bodyMiss: { mailFromDomain: "mail.missing-0000.example.com" },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "chooseReceivingHost.foreignHost", method: "POST", pathReal: `/v1/domains/${callerWs.domainId}/receiving-host`, pathMiss: `/v1/domains/${callerWs.domainId}/receiving-host`,
          bodyReal: { host: `rx.${targetWs.domainName}` },
          bodyMiss: { host: "rx.missing-0000.example.com" },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "updateApiKey.allAddr.removeAddressIds", method: "PATCH", pathReal: `/v1/api-keys/${callerWs.allAddrKeyId}`, pathMiss: `/v1/api-keys/${callerWs.allAddrKeyId}`,
          bodyReal: { access: { removeAddressIds: [targetWs.addressId] } },
          bodyMiss: { access: { removeAddressIds: [miss("mbx_")] } },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "bindMcpConnection.workspaceId", method: "POST", pathReal: `/v1/mcp-connections/${callerWs.mcpGrantId}/workspace`, pathMiss: `/v1/mcp-connections/${callerWs.mcpGrantId}/workspace`,
          bodyReal: { workspaceId: targetWs.id }, bodyMiss: { workspaceId: "ws_00000000000000000000000000000000" },
          realTokens: [targetWs.id], missTokens: ["ws_00000000000000000000000000000000"], mustRejectWrite: principal === "ownerA" || principal === "keyA" || targetSlot === "C" },
      ];
      pairs.push(...p);
    } else if (focus === "query-reads") {
      // Every ID-carrying query parameter across all read/delete routes, comparing foreign real ID vs nonexistent ID!
      pairs.push(
        { name: "listContacts?listId", method: "GET", pathReal: `/v1/contacts?listId=${targetWs.listIds[0]}`, pathMiss: `/v1/contacts?listId=${miss("lst_")}`, realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")] },
        { name: "listEmails?campaignId", method: "GET", pathReal: `/v1/emails?campaignId=${targetWs.campaignDraftId}`, pathMiss: `/v1/emails?campaignId=${miss("cmp_")}`, realTokens: [targetWs.campaignDraftId], missTokens: [miss("cmp_")] },
        { name: "listCampaigns?listId", method: "GET", pathReal: `/v1/campaigns?listId=${targetWs.listIds[0]}`, pathMiss: `/v1/campaigns?listId=${miss("lst_")}`, realTokens: [targetWs.listIds[0]!], missTokens: [miss("lst_")] },
        { name: "listLogs?campaignId", method: "GET", pathReal: `/v1/logs?counts=true&campaignId=${targetWs.campaignDraftId}`, pathMiss: `/v1/logs?counts=true&campaignId=${miss("cmp_")}`, realTokens: [targetWs.campaignDraftId], missTokens: [miss("cmp_")] },
        { name: "getRoutingAudit?resource", method: "GET", pathReal: `/v1/routing/audit?resource=${targetWs.routeId}`, pathMiss: `/v1/routing/audit?resource=${miss("rte_")}`, realTokens: [targetWs.routeId], missTokens: [miss("rte_")] },
        { name: "getRoutingAudit?actor", method: "GET", pathReal: `/v1/routing/audit?actor=${targetWs.ownerUserId}`, pathMiss: `/v1/routing/audit?actor=tear-user-00000000-0000-0000-0000-000000000000`, realTokens: [targetWs.ownerUserId], missTokens: ["tear-user-00000000-0000-0000-0000-000000000000"] },
        { name: "listInboundAddresses?domain", method: "GET", pathReal: `/v1/inbound/addresses?domain=${targetWs.domainName}`, pathMiss: `/v1/inbound/addresses?domain=missing-0000.example.com`, realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"] },
        { name: "getInboundOverview?domain", method: "GET", pathReal: `/v1/inbound/overview?domain=${targetWs.domainName}`, pathMiss: `/v1/inbound/overview?domain=missing-0000.example.com`, realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"] },
        { name: "listInboundThreads?addressId", method: "GET", pathReal: `/v1/inbound/threads?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/threads?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "getInboundThread(own)?addressId", method: "GET", pathReal: `/v1/inbound/threads/${callerWs.threadId}?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/threads/${callerWs.threadId}?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundMessages?addressId", method: "GET", pathReal: `/v1/inbound/messages?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/messages?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundMessages?threadId", method: "GET", pathReal: `/v1/inbound/messages?threadId=${targetWs.threadId}`, pathMiss: `/v1/inbound/messages?threadId=${miss("thr_")}`, realTokens: [targetWs.threadId], missTokens: [miss("thr_")] },
        { name: "getInboundMessage(own)?addressId", method: "GET", pathReal: `/v1/inbound/messages/${callerWs.inboundMessageId}?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/messages/${callerWs.inboundMessageId}?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "getInboundAttachment(own)?addressId", method: "GET", pathReal: `/v1/inbound/messages/${callerWs.inboundMessageId}/attachments/${callerWs.mailAttachmentId}?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/messages/${callerWs.inboundMessageId}/attachments/${callerWs.mailAttachmentId}?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "downloadInboundAttachment(own)?addressId", method: "GET", pathReal: `/v1/inbound/messages/${callerWs.inboundMessageId}/parts/${callerWs.mailAttachmentId}?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/messages/${callerWs.inboundMessageId}/parts/${callerWs.mailAttachmentId}?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundEndpoints?addressId", method: "GET", pathReal: `/v1/inbound/endpoints?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/endpoints?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundEvents?addressId", method: "GET", pathReal: `/v1/inbound/events?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/events?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundEvents?addressIds", method: "GET", pathReal: `/v1/inbound/events?addressIds=${targetWs.addressId}`, pathMiss: `/v1/inbound/events?addressIds=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "listInboundWebhooks?addressId", method: "GET", pathReal: `/v1/inbound/webhooks?addressId=${targetWs.addressId}`, pathMiss: `/v1/inbound/webhooks?addressId=${miss("mbx_")}`, realTokens: [targetWs.addressId], missTokens: [miss("mbx_")] },
        { name: "revokeWorkspaceInvitation?id", method: "DELETE", pathReal: `/v1/workspaces/current/invitations?id=${targetWs.invitationId}`, pathMiss: `/v1/workspaces/current/invitations?id=${miss("inv_")}`, realTokens: [targetWs.invitationId], missTokens: [miss("inv_")] },
        { name: "listActivity?actorId", method: "GET", pathReal: `/v1/activity?actorId=${targetWs.ownerUserId}`, pathMiss: `/v1/activity?actorId=tear-user-00000000-0000-0000-0000-000000000000`, realTokens: [targetWs.ownerUserId], missTokens: ["tear-user-00000000-0000-0000-0000-000000000000"] },
      );
    } else if (focus === "pr614-bug-iso-04") {
      // BUG-ISO-04 (PR #614, approved & waiting to merge onto dev):
      // 1. PUT /v1/rules/decisions & PUT /v1/rules must refuse foreign evaluateRoutes and unowned evaluateDomains with 422.
      // 2. PATCH /v1/api-keys/{allAddrKey} (mailbox_ids IS NULL) must refuse foreign addAddressIds with 422.
      // 3. Ended/deleted own inboxes must be refused by POST/PATCH /v1/api-keys and POST /v1/inbound/webhooks.
      pairs.push(
        { name: "setDecisionOptIns.evaluateRoutes", method: "PUT", pathReal: "/v1/rules/decisions", pathMiss: "/v1/rules/decisions",
          bodyReal: { evaluateRoutes: [targetWs.routeId] }, bodyMiss: { evaluateRoutes: [miss("rte_")] },
          realTokens: [targetWs.routeId], missTokens: [miss("rte_")], mustRejectWrite: true },
        { name: "setDecisionOptIns.evaluateDomains", method: "PUT", pathReal: "/v1/rules/decisions", pathMiss: "/v1/rules/decisions",
          bodyReal: { evaluateDomains: [targetWs.domainName] }, bodyMiss: { evaluateDomains: ["missing-0000.example.com"] },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "applyRules.evaluateRoutes", method: "PUT", pathReal: "/v1/rules", pathMiss: "/v1/rules",
          bodyReal: { rules: [], attachments: [], evaluateRoutes: [targetWs.routeId] },
          bodyMiss: { rules: [], attachments: [], evaluateRoutes: [miss("rte_")] },
          realTokens: [targetWs.routeId], missTokens: [miss("rte_")], mustRejectWrite: true },
        { name: "applyRules.evaluateDomains", method: "PUT", pathReal: "/v1/rules", pathMiss: "/v1/rules",
          bodyReal: { rules: [], attachments: [], evaluateDomains: [targetWs.domainName] },
          bodyMiss: { rules: [], attachments: [], evaluateDomains: ["missing-0000.example.com"] },
          realTokens: [targetWs.domainName], missTokens: ["missing-0000.example.com"], mustRejectWrite: true },
        { name: "updateApiKey.allAddr.addAddressIds", method: "PATCH", pathReal: `/v1/api-keys/${callerWs.allAddrKeyId}`, pathMiss: `/v1/api-keys/${callerWs.allAddrKeyId}`,
          bodyReal: { access: { addAddressIds: [targetWs.addressId] } },
          bodyMiss: { access: { addAddressIds: [miss("mbx_")] } },
          realTokens: [targetWs.addressId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createApiKey.endedOwnInbox", method: "POST", pathReal: "/v1/api-keys", pathMiss: "/v1/api-keys",
          bodyReal: { name: "EndKey", access: { type: "addresses", addressIds: [callerWs.endedInboxId], mail: ["read"] } },
          bodyMiss: { name: "EndKey", access: { type: "addresses", addressIds: [miss("mbx_")], mail: ["read"] } },
          realTokens: [callerWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInboundWebhook.endedOwnInbox", method: "POST", pathReal: "/v1/inbound/webhooks", pathMiss: "/v1/inbound/webhooks",
          bodyReal: { url: "https://ended.example.com/wh", eventTypes: ["message.received"], addressIds: [callerWs.endedInboxId] },
          bodyMiss: { url: "https://ended.example.com/wh", eventTypes: ["message.received"], addressIds: [miss("mbx_")] },
          realTokens: [callerWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "setDecisionOptIns.foreignChildName", method: "PUT", pathReal: "/v1/rules/decisions", pathMiss: "/v1/rules/decisions",
          bodyReal: { evaluateDomains: [targetWs.hostedChildName] },
          bodyMiss: { evaluateDomains: ["child-0000.missing-0000.example.com"] },
          realTokens: [targetWs.hostedChildName], missTokens: ["child-0000.missing-0000.example.com"], mustRejectWrite: true },
      );
    } else if (focus === "nearby-foreign-ended") {
      // Foreign ended/deleted ephemeral inbox MUST always be refused (identical to nonexistent ID) across rules, routing, keys, and webhooks!
      pairs.push(
        { name: "attachRules.foreignEndedInbox", method: "PUT", pathReal: "/v1/rules/attachments", pathMiss: "/v1/rules/attachments",
          bodyReal: { attachments: [{ rule: callerWs.ruleKey, target: targetWs.endedInboxId }] },
          bodyMiss: { attachments: [{ rule: callerWs.ruleKey, target: miss("mbx_") }] },
          realTokens: [targetWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createRoute.foreignEndedInbox", method: "POST", pathReal: "/v1/routing/routes", pathMiss: "/v1/routing/routes",
          bodyReal: { match: `re1@${callerWs.domainName}`, to: [targetWs.endedInboxId] },
          bodyMiss: { match: `re1@${callerWs.domainName}`, to: [miss("mbx_")] },
          realTokens: [targetWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createApiKey.foreignEndedInbox", method: "POST", pathReal: "/v1/api-keys", pathMiss: "/v1/api-keys",
          bodyReal: { name: "FEndKey", access: { type: "addresses", addressIds: [targetWs.endedInboxId], mail: ["read"] } },
          bodyMiss: { name: "FEndKey", access: { type: "addresses", addressIds: [miss("mbx_")], mail: ["read"] } },
          realTokens: [targetWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createInboundWebhook.foreignEndedInbox", method: "POST", pathReal: "/v1/inbound/webhooks", pathMiss: "/v1/inbound/webhooks",
          bodyReal: { url: "https://fended.example.com/wh", eventTypes: ["message.received"], addressIds: [targetWs.endedInboxId] },
          bodyMiss: { url: "https://fended.example.com/wh", eventTypes: ["message.received"], addressIds: [miss("mbx_")] },
          realTokens: [targetWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
      );
    } else if (focus === "nearby-own-ended") {
      // Reviewer-noted nearby cases (own workspace only, nothing crosses between workspaces):
      // 1. PUT /v1/rules/attachments accepts a just-deleted own ephemeral inbox until GC cleanup.
      // 2. POST /v1/routing/routes (routing.ts ended-inbox filter left out of #614) accepts a just-deleted own ephemeral inbox.
      pairs.push(
        { name: "attachRules.ownEndedInbox", method: "PUT", pathReal: "/v1/rules/attachments", pathMiss: "/v1/rules/attachments",
          bodyReal: { attachments: [{ rule: callerWs.ruleKey, target: callerWs.endedInboxId }] },
          bodyMiss: { attachments: [{ rule: callerWs.ruleKey, target: miss("mbx_") }] },
          realTokens: [callerWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
        { name: "createRoute.ownEndedInbox", method: "POST", pathReal: "/v1/routing/routes", pathMiss: "/v1/routing/routes",
          bodyReal: { match: `re2@${callerWs.domainName}`, to: [callerWs.endedInboxId] },
          bodyMiss: { match: `re3@${callerWs.domainName}`, to: [miss("mbx_")] },
          realTokens: [callerWs.endedInboxId], missTokens: [miss("mbx_")], mustRejectWrite: true },
      );
    }

    for (const pair of pairs) {
      const realReply = await rawFetch(pair.method, pair.pathReal, { ...auth, body: pair.bodyReal, headers: pair.headers });
      const missReply = await rawFetch(pair.method, pair.pathMiss, { ...auth, body: pair.bodyMiss, headers: pair.headers });
      obs.routesDriven += 2;
      t.totalRoutesDriven += 2;

      // Invariant 1: No leakage of foreign tokens
      const foundLeaks = scanForLeaks(t, realReply, foreignSlots, {
        echoedInputs: pair.realTokens,
        context: `${principal} field:${pair.name} (target=${targetSlot})`,
      });
      for (const l of foundLeaks) {
        obs.leaks.push(l);
        if (!isMaskedFocus) {
          t.leaks.push(l);
          t.pendingEvents.push({ name: "isolation.leak", data: { principal, field: pair.name } });
        }
      }

      // Invariant 5: Write referencing foreign/ended ID must be refused (or queue 0 on redeliver)!
      if (pair.mustRejectWrite && realReply.status >= 200 && realReply.status < 300) {
        const msg = `${principal} field:${pair.name} (${pair.method} ${pair.pathReal}): ACCEPTED with ${realReply.status}! body=${realReply.text.slice(0, 140)}`;
        obs.dualViolations.push(msg);
        if (!isMaskedFocus) t.dualViolations.push(msg);
      } else if (pair.name === "redeliverInboundMessage.destination" && realReply.body?.queued !== 0) {
        const msg = `${principal} field:${pair.name}: expected queued=0, got ${realReply.text.slice(0, 120)}`;
        obs.dualViolations.push(msg);
        if (!isMaskedFocus) t.dualViolations.push(msg);
      }

      // Invariant 3: Identical answer for foreign real ID vs nonexistent ID (no probing!)
      if (!pair.skipOracle) {
        const oracle = checkIndistinguishable(
          `${principal} field:${pair.name} (target=${targetSlot})`,
          realReply,
          missReply,
          pair.realTokens,
          pair.missTokens,
        );
        if (oracle) {
          obs.probeOracles.push(oracle);
          if (!isMaskedFocus) {
            t.probeOracles.push(oracle);
            t.pendingEvents.push({ name: "isolation.id_oracle", data: { principal, field: pair.name } });
          }
        }
      }
    }

    // Invariant 2: Full DB + storage snapshot check on ALL non-overlapping foreign workspaces
    const snapAfter = await snapshotWorkspaces(t.wsIds);
    const diffs = diffWorkspaces(snapBefore, snapAfter, tracker.watchIds(foreignSlots));
    for (const d of diffs) {
      const msg = `${principal} fields:${focus} target=${targetSlot}: ${d}`;
      obs.foreignMutations.push(msg);
      if (!isMaskedFocus) {
        t.foreignMutations.push(msg);
        t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { principal, focus, diff: d } });
      }
    }

    return obs;
  } finally {
    tracker.end();
  }
}

async function runConcurrentDualSwitch(t: Trial): Promise<WorkspaceIsolationObs> {
  const obs: WorkspaceIsolationObs = {
    routesDriven: 0,
    leaks: [],
    foreignMutations: [],
    probeOracles: [],
    aggregateMismatches: [],
    dualViolations: [],
    unexpectedErrors: [],
  };

  const snapBefore = await snapshotWorkspaces(t.wsIds);

  // Fire 8 simultaneous requests as dualUser alternating X-Nightmail-Workspace: A and B!
  const calls = [
    { slot: "A" as const, p: "/v1/contacts" },
    { slot: "B" as const, p: "/v1/contacts" },
    { slot: "A" as const, p: "/v1/campaigns" },
    { slot: "B" as const, p: "/v1/campaigns" },
    { slot: "A" as const, p: "/v1/billing" },
    { slot: "B" as const, p: "/v1/billing" },
    { slot: "A" as const, p: "/v1/settings/workspace" },
    { slot: "B" as const, p: "/v1/settings/workspace" },
  ];

  const results = await Promise.all(
    calls.map((c) => rawFetch("GET", c.p, { cookie: t.dualCookie, workspaceHeader: t.ws[c.slot].id })),
  );

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const r = results[i]!;
    obs.routesDriven += 1;
    t.totalRoutesDriven += 1;
    const otherSlots: WorkspaceSlot[] = c.slot === "A" ? ["B", "C"] : ["A", "C"];
    for (const l of scanForLeaks(t, r, otherSlots, { context: `concurrent-dual(${c.slot}) GET ${c.p}` })) {
      obs.leaks.push(l);
      t.leaks.push(l);
      t.pendingEvents.push({ name: "isolation.leak", data: { principal: `dual${c.slot}`, route: c.p } });
    }
  }

  // Workspace C must remain 100% untouched!
  const snapAfter = await snapshotWorkspaces(t.wsIds);
  const diffs = diffWorkspaces(snapBefore, snapAfter, [t.ws.C.id]);
  for (const d of diffs) {
    obs.foreignMutations.push(`concurrent-dual-switch: ${d}`);
    t.foreignMutations.push(`concurrent-dual-switch: ${d}`);
  }

  return obs;
}

// ---------- Host Registration ----------
let seq = 0;

export const workspaceIsolationHost = host(workspaceIsolation, {
  rounds: true,

  async open(req): Promise<Trial> {
    await assertDisposable((text) => pool.query(text));
    seq += 1;
    const tag = `${process.pid}_${seq}`;
    const userIds: string[] = [];
    const convIds: string[] = [];

    await pool.query(
      `INSERT INTO public_stats(singleton,stats,generated_at) VALUES (true,'{"sent24h":0,"delivered24h":0,"workspaces":0}'::jsonb,now()) ON CONFLICT (singleton) DO NOTHING`,
    );
    const [wsA, wsB, wsC] = await Promise.all([
      seedWorkspace("A", 1, tag, userIds, convIds),
      seedWorkspace("B", 2, tag, userIds, convIds),
      seedWorkspace("C", 3, tag, userIds, convIds),
    ]);

    // Additional principals in A: adminA, memberA, and dualUser (owner in A, admin in B, NOT in C)
    const adminA = await createUser(userIds, `AdminA ${wsA.marker}`, `admin-${wsA.marker.toLowerCase()}@example.com`);
    await pool.query(
      `INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'admin')`,
      [`mem_${hex(12)}`, wsA.id, adminA.id],
    );

    const memberA = await createUser(userIds, `MemberA ${wsA.marker}`, `member-${wsA.marker.toLowerCase()}@example.com`);
    await pool.query(
      `INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'member')`,
      [`mem_${hex(12)}`, wsA.id, memberA.id],
    );

    const dualUser = await createUser(userIds, `DualUser ${tag}`, `dual-${tag}@example.com`);
    const dualMemberAId = `mem_${hex(12)}`;
    const dualMemberBId = `mem_${hex(12)}`;
    await pool.query(
      `INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'owner'), ($4,$5,$3,'admin')`,
      [dualMemberAId, wsA.id, dualUser.id, dualMemberBId, wsB.id],
    );

    // Support conversations for dualUser: one narrowed to A only, one email unscoped (A+B, never C)
    const supportDualAConvId = `conv_${randBase32(26)}`;
    const supportDualABConvId = `conv_${randBase32(26)}`;
    convIds.push(supportDualAConvId, supportDualABConvId);
    await pool.query(
      `INSERT INTO support_conversations(id,channel,user_id,verification,mode,workspace_id,content_workspace_id,status,subject)
       VALUES ($1,'chat',$3,'handoff','member',$4,$4,'open','Dual scoped A'),
              ($2,'email',$3,'dmarc','member',NULL,NULL,'open','Dual unscoped email')`,
      [supportDualAConvId, supportDualABConvId, dualUser.id, wsA.id],
    );

    // MCP JWT grants for ownerA and dualUser (initialized via tools/list so grant row is created)
    const mcpAAccess = mintJwt(wsA.ownerUserId, `tear-mcp-a-${tag}`, "nightmail:read nightmail:send nightmail:manage");
    const mcpDualAccess = mintJwt(dualUser.id, `tear-mcp-dual-${tag}`, "nightmail:read nightmail:send nightmail:manage");
    for (const bearer of [mcpAAccess, mcpDualAccess]) {
      await rawFetch("POST", "/mcp?codemode=true", {
        bearer,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      });
    }

    const initialSnapC = await snapshotWorkspaces([wsC.id]);
    return {
      bug: req.bug,
      tag,
      ws: { A: wsA, B: wsB, C: wsC },
      wsIds: [wsA.id, wsB.id, wsC.id],
      adminAUserId: adminA.id,
      adminACookie: adminA.cookie,
      memberAUserId: memberA.id,
      memberACookie: memberA.cookie,
      dualUserId: dualUser.id,
      dualCookie: dualUser.cookie,
      dualMemberAId,
      dualMemberBId,
      mcpAAccess,
      mcpDualAccess,
      supportDualAConvId,
      supportDualABConvId,
      userIds,
      convIds,
      totalRoutesDriven: 0,
      uniqueOpenApiRoutesDriven: new Set(),
      uniqueSupportRoutesDriven: new Set(),
      uniqueMcpToolsDriven: new Set(),
      leaks: [],
      foreignMutations: [],
      probeOracles: [],
      aggregateMismatches: [],
      dualViolations: [],
      unexpectedErrors: [],
      leakedErrors: [],
      pendingEvents: [],
      canaryMutated: false,
      initialSnapC,
      activeTrackers: new Set(),
    };
  },

  async act(t: Trial, a: WorkspaceIsolationAction): Promise<WorkspaceIsolationObs> {
    switch (a.op) {
      case "ProbeGroup":
        return runProbeGroup(t, a.group, a.principal, a.target);
      case "ProbeSupport":
        return runProbeSupport(t, a.principal, a.target);
      case "ProbeMcp":
        return runProbeMcp(t, a.principal, a.chunk, a.target);
      case "ProbeFields":
        return runProbeFields(t, a.principal, a.target, a.focus);
      case "CheckAggregates":
        return runCheckAggregates(t, a.principal);
      case "DualMismatch":
        return runDualMismatch(t, a.header, a.target);
      case "ConcurrentDualSwitch":
        return runConcurrentDualSwitch(t);
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    // End-to-end invariant: workspace C has zero authorized writers in the entire trial and must NEVER change.
    const currentSnapC = await snapshotWorkspaces([t.ws.C.id]);
    for (const d of diffWorkspaces(t.initialSnapC, currentSnapC, [t.ws.C.id])) {
      t.foreignMutations.push(`end-to-end workspace C mutation: ${d}`);
      t.pendingEvents.push({ name: "isolation.foreign_mutation", data: { scope: "end-to-end-C", diff: d } });
    }
    const snap: WorkspaceIsolationSnapshot = {
      totalRoutesDriven: t.totalRoutesDriven,
      uniqueOpenApiRoutesDriven: t.uniqueOpenApiRoutesDriven.size,
      totalOpenApiRoutes: OPENAPI_ROUTES.length,
      uniqueSupportRoutesDriven: t.uniqueSupportRoutesDriven.size,
      uniqueMcpToolsDriven: t.uniqueMcpToolsDriven.size,
      leaks: [...t.leaks],
      foreignMutations: [...t.foreignMutations],
      probeOracles: [...t.probeOracles],
      aggregateMismatches: [...t.aggregateMismatches],
      dualViolations: [...t.dualViolations],
      unexpectedErrors: [...t.unexpectedErrors],
      leakedErrors: [...t.leakedErrors],
    };
    const events = t.pendingEvents.splice(0);
    return { snapshot: snap, events };
  },

  async close(t: Trial): Promise<void> {
    // Clean up trial rows cleanly so the disposable database stays compact.
    try {
      await pool.query(`DELETE FROM support_notes WHERE conversation_id = ANY($1::text[])`, [t.convIds]);
      await pool.query(`DELETE FROM support_actions WHERE conversation_id = ANY($1::text[])`, [t.convIds]);
      await pool.query(`DELETE FROM support_conversations WHERE id = ANY($1::text[])`, [t.convIds]);
      await pool.query(`DELETE FROM sending_review_recipients WHERE review_id IN (SELECT id FROM sending_campaign_reviews WHERE workspace_id = ANY($1::text[]))`, [t.wsIds]);
      for (const tbl of [...WORKSPACE_ID_TABLES].reverse()) {
        if (tbl === "audit_events") continue;
        await pool.query(`DELETE FROM "${tbl}" WHERE workspace_id = ANY($1::text[])`, [t.wsIds]).catch(() => {});
      }
      await pool.query(`DELETE FROM audit_events WHERE workspace_id = ANY($1::text[]) OR user_id = ANY($2::text[])`, [t.wsIds, t.userIds]).catch(() => {});
      await pool.query(`DELETE FROM nightmail_users WHERE id = ANY($1::text[])`, [t.userIds]).catch(() => {});
      await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [t.wsIds]).catch(() => {});
      for (const k of [...storageObjects.keys()]) {
        if (t.wsIds.some((w) => k.includes(w))) storageObjects.delete(k);
      }
    } catch {
      // disposable DB — ignore cleanup errors
    }
  },
});
