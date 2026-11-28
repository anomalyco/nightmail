import { createHash, randomBytes } from "node:crypto";
import { host, type Observed } from "@tear/mbt";
import { byoRegional } from "./byo-regional.model.ts";
import {
  type ByoAction,
  type ByoObs,
  type ByoPreset,
  type ByoRegion,
  type ByoSnapshot,
  type DisconnectFault,
  type DomainSlot,
  type IntentSnap,
  type RegionFault,
  type RegionSnap,
} from "./byo-regional.types.ts";

// Silence noisy app logs unless TEAR_VERBOSE=1.
const quiet = process.env.TEAR_VERBOSE !== "1";
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    if (!quiet) process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

// Validate disposable database BEFORE connecting pools, registering handlers, or creating tear_clock.
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

const leaked: string[] = [];
const leak = (kind: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`byo-regional host ${kind}: ${text}\n`);
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

const PUBLIC = "https://tear.nightmail.app";
const PLATFORM_ACCOUNT = "111122223333";
const ISSUER = "https://tear-byo-issuer.invalid";
const ACTIVE_REGIONS: ByoRegion[] = ["us-east-2", "us-east-1"];

const withClock = `${checkedUrl}?options=${encodeURIComponent("-c search_path=tear_clock,pg_catalog,public")}`;

const env = {
  DATABASE_URL: withClock,
  BANE_ROOT_SECRET: "tear-byo-v5-".repeat(5),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  ACCOUNT_ISSUER: ISSUER,
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
  ENABLE_LIVE_SES: "true",
  NIGHTMAIL_HOSTED_SCREEN: "false",
  NIGHTMAIL_PLATFORM_AWS_ACCOUNT: PLATFORM_ACCOUNT,
  NIGHTMAIL_REGIONAL_SENDING: "true",
  NIGHTMAIL_BYO_V2: "true",
  BYO_TEMPLATE_URL: "https://templates.nightmail.app/v4.yaml",
  BYO_V5_TEMPLATE_URL: "https://templates.nightmail.app/v5.yaml",
  BYO_EVENTS_ORIGIN: "https://events.nightmail.app",
  AWS_ACCESS_KEY_ID: "AKIATEARPLATFORM0001",
  AWS_SECRET_ACCESS_KEY: "tear-platform-secret",
  AWS_EC2_METADATA_DISABLED: "true",
  S3_BUCKET: "tear",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  API_RATE_LIMIT_PER_MINUTE: "100000",
};

const [
  { nodeRuntime },
  { createApp },
  { sql },
  { processJobs, MAX_ATTEMPTS },
  { regionalByoJobs },
  { STSClient },
  { SESv2Client },
  { SNSClient },
  { ensureRegionSettings },
  { tagKey },
] = await Promise.all([
  import("../../src/adapters/node.ts"),
  import("../../src/app.ts"),
  import("drizzle-orm"),
  import("../../src/jobs.ts"),
  import("../../src/byo-regional.ts"),
  import("@aws-sdk/client-sts"),
  import("@aws-sdk/client-sesv2"),
  import("@aws-sdk/client-sns"),
  import("../../src/ses-region-state.ts"),
  import("../../src/resource-tags.ts"),
]);

const { runtime } = nodeRuntime(env);
const db = runtime.db;
const app = createApp();
const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

// ---- Mock AWS state per trial ----
interface MockTopic {
  arn: string;
  Tags: { Key: string; Value: string }[];
  Attributes: Record<string, string>;
  subs: Record<string, string>[];
  confirmed: boolean;
}

interface MockSet {
  name: string;
  Tags: { Key: string; Value: string }[];
  dests: { Name: string; Enabled: boolean; MatchingEventTypes: string[]; SnsDestination: { TopicArn: string } }[];
}

interface Trial {
  configured: boolean;
  bug?: string;
  seq: number;
  epoch: number;
  W: string;
  userId: string;
  cookie: string;
  account: string;
  connectionId: string | null;
  connectionKind: "byo" | "shared";
  hostedClaimToken: string | null;
  hostedDomainName: string | null;
  externalId: string | null;
  roleArn: string | null;
  revision: number;
  regionFault: Record<ByoRegion, RegionFault>;
  disconnectFault: DisconnectFault;
  activeJobType: string | null;
  sets: Map<string, MockSet>;
  topics: Map<string, MockTopic>;
  exhaustedDomains: Set<string>;
  wasPausedBeforeLastDelete: boolean;
  pausedDeleteViolations: string[];
  disconnectingMutationViolations: string[];
  exhaustedRecoveryViolations: string[];
  leakedErrors: string[];
}

let activeTrial: Trial | null = null;

function awsErr(name: string, message: string) {
  return Object.assign(new Error(message), { name });
}

function domainName(t: Trial, slot: DomainSlot): string {
  return `${slot}-${process.pid}-${t.seq}.example`;
}

function verifiedIdentity(name: string) {
  return {
    IdentityType: "DOMAIN",
    VerifiedForSendingStatus: true,
    VerificationStatus: "SUCCESS",
    DkimAttributes: {
      SigningEnabled: true,
      Status: "SUCCESS",
      SigningAttributesOrigin: "AWS_SES",
      Tokens: ["tok1", "tok2", "tok3"],
      SigningHostedZone: "dkim.amazonses.com",
    },
    MailFromAttributes: { MailFromDomain: `mail.${name}`, MailFromDomainStatus: "SUCCESS" },
  };
}

// Install AWS SDK prototype interceptors (bypassing middlewareStack 1 s SES pacing)
(STSClient.prototype as any).send = async function (cmd: any) {
  const t = activeTrial;
  if (!t) throw new Error("STS call outside active trial");
  const op = cmd.constructor.name;
  const input = cmd.input ?? {};
  if (op === "GetCallerIdentityCommand") {
    return { Account: t.account, Arn: t.roleArn ?? `arn:aws:iam::${t.account}:role/Nightmail-tear` };
  }
  if (op === "AssumeRoleCommand") {
    const roleArn = String(input.RoleArn ?? "");
    if (roleArn.startsWith(`arn:aws:iam::${PLATFORM_ACCOUNT}:role/`)) {
      return {
        Credentials: {
          AccessKeyId: "ASIABROKERTEAR000001",
          SecretAccessKey: "broker-secret",
          SessionToken: "broker-token",
          Expiration: new Date(vnow() + 3600_000),
        },
      };
    }
    if (input.ExternalId !== t.externalId) {
      throw awsErr("AccessDenied", "External ID mismatch");
    }
    const m = /^arn:aws:iam::(\d{12}):role\/(.+)$/.exec(roleArn);
    return {
      Credentials: {
        AccessKeyId: `ASIACUST${t.seq}`,
        SecretAccessKey: "cust-secret",
        SessionToken: "cust-token",
        Expiration: new Date(vnow() + 3600_000),
      },
      AssumedRoleUser: m
        ? { Arn: `arn:aws:sts::${m[1]}:assumed-role/${m[2]}/${input.RoleSessionName}`, AssumedRoleId: `AROATEAR:${input.RoleSessionName}` }
        : undefined,
    };
  }
  throw new Error(`unexpected STS call ${op}`);
};

(SESv2Client.prototype as any).send = async function (cmd: any) {
  const t = activeTrial;
  if (!t) throw new Error("SESv2 call outside active trial");
  const region = (await this.config.region()) as ByoRegion;
  const op = cmd.constructor.name;
  const input = cmd.input ?? {};
  const fault: RegionFault = t.regionFault[region] ?? "ok";

  const checkProvFault = () => {
    if (t.activeJobType !== "byo.provision") return;
    if (fault === "access_denied") throw awsErr("AccessDeniedException", "Provisioning denied by policy.");
    if (fault === "retryable_5xx") throw awsErr("ServiceUnavailableException", "SES region temporarily unavailable.");
  };

  if (t.activeJobType === "byo.disconnect") {
    if (t.disconnectFault === "access_denied") throw awsErr("AccessDeniedException", "Cleanup denied.");
    if (t.disconnectFault === "retryable_5xx") throw awsErr("ServiceUnavailableException", "SES cleanup 5xx.");
  }

  switch (op) {
    case "GetAccountCommand":
      return {
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        EnforcementStatus: "HEALTHY",
        SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 0 },
      };
    case "ListConfigurationSetsCommand":
      return { ConfigurationSets: [...t.sets.values()].filter((s) => s.name.startsWith(region + ":")).map((s) => s.name.slice(region.length + 1)) };
    case "GetConfigurationSetCommand": {
      const key = `${region}:${input.ConfigurationSetName}`;
      const set = t.sets.get(key);
      if (!set) throw awsErr("NotFoundException", "Configuration set not found.");
      return { ConfigurationSetName: input.ConfigurationSetName, SendingOptions: { SendingEnabled: true }, Tags: set.Tags };
    }
    case "CreateConfigurationSetCommand": {
      checkProvFault();
      const key = `${region}:${input.ConfigurationSetName}`;
      t.sets.set(key, { name: key, Tags: input.Tags ?? [], dests: [] });
      return {};
    }
    case "DeleteConfigurationSetCommand": {
      const key = `${region}:${input.ConfigurationSetName}`;
      t.sets.delete(key);
      return {};
    }
    case "GetConfigurationSetEventDestinationsCommand": {
      const key = `${region}:${input.ConfigurationSetName}`;
      const set = t.sets.get(key);
      if (!set) throw awsErr("NotFoundException", "Configuration set not found.");
      return { EventDestinations: set.dests };
    }
    case "CreateConfigurationSetEventDestinationCommand": {
      checkProvFault();
      const key = `${region}:${input.ConfigurationSetName}`;
      const set = t.sets.get(key);
      if (!set) throw awsErr("NotFoundException", "Configuration set not found.");
      set.dests = set.dests.filter((d) => d.Name !== input.EventDestinationName);
      set.dests.push({
        Name: input.EventDestinationName,
        Enabled: input.EventDestination?.Enabled ?? true,
        MatchingEventTypes: input.EventDestination?.MatchingEventTypes ?? [],
        SnsDestination: input.EventDestination?.SnsDestination,
      });
      return {};
    }
    case "ListEmailIdentitiesCommand": {
      const names = [domainName(t, "alpha"), domainName(t, "beta")];
      return {
        EmailIdentities: names.map((IdentityName) => ({ IdentityName, IdentityType: "DOMAIN", SendingEnabled: true })),
      };
    }
    case "GetEmailIdentityCommand": {
      if (t.activeJobType === "byo.bind") {
        if (fault === "access_denied") throw awsErr("AccessDeniedException", "Bind read denied.");
        if (fault === "retryable_5xx") throw awsErr("ServiceUnavailableException", "SES identity read 5xx.");
      }
      const name = String(input.EmailIdentity ?? "");
      if (t.hostedDomainName && name === t.hostedDomainName) {
        return {
          ...verifiedIdentity(name),
          Tags: t.hostedClaimToken ? [{ Key: tagKey("domain-claim"), Value: t.hostedClaimToken }] : [],
        };
      }
      if (name === domainName(t, "alpha") || name === domainName(t, "beta")) {
        return verifiedIdentity(name);
      }
      throw awsErr("NotFoundException", "Identity not found.");
    }
    case "ListResourceTenantsCommand":
      return { ResourceTenants: [] };
    case "DeleteTenantResourceAssociationCommand":
      return {};
    case "DeleteEmailIdentityCommand": {
      if (t.connectionKind === "shared" && t.disconnectFault === "pause_mid_disconnect" && t.connectionId) {
        t.disconnectFault = "ok";
        t.wasPausedBeforeLastDelete = true;
        await db.execute(
          sql`UPDATE provider_connections SET paused_at=clock_timestamp(), pause_reason='Sending paused mid-disconnect.' WHERE id=${t.connectionId} AND kind='shared'`,
        );
      }
      return {};
    }
    default:
      throw new Error(`unexpected SESv2 call ${op}`);
  }
};

(SNSClient.prototype as any).send = async function (cmd: any) {
  const t = activeTrial;
  if (!t) throw new Error("SNS call outside active trial");
  const region = (await this.config.region()) as ByoRegion;
  const op = cmd.constructor.name;
  const input = cmd.input ?? {};
  const fault: RegionFault = t.regionFault[region] ?? "ok";

  if (t.activeJobType === "byo.disconnect") {
    if (t.disconnectFault === "access_denied") throw awsErr("AccessDeniedException", "SNS cleanup denied.");
    if (t.disconnectFault === "retryable_5xx") throw awsErr("ServiceUnavailableException", "SNS cleanup 5xx.");
  }

  const arn: string =
    input.TopicArn ??
    input.ResourceArn ??
    (typeof input.SubscriptionArn === "string" ? input.SubscriptionArn.split(":").slice(0, 6).join(":") : "") ??
    `arn:aws:sns:${region}:${t.account}:${input.Name}`;

  const checkProvFault = () => {
    if (t.activeJobType !== "byo.provision") return;
    if (fault === "access_denied") throw awsErr("AccessDeniedException", "SNS provisioning denied.");
    if (fault === "retryable_5xx") throw awsErr("ServiceUnavailableException", "SNS temporarily unavailable.");
  };

  switch (op) {
    case "CreateTopicCommand": {
      checkProvFault();
      const topicArn = `arn:aws:sns:${region}:${t.account}:${input.Name}`;
      t.topics.set(topicArn, {
        arn: topicArn,
        Tags: input.Tags ?? [],
        Attributes: { ...(input.Attributes ?? {}), Owner: t.account, TopicArn: topicArn },
        subs: [],
        confirmed: false,
      });
      return { TopicArn: topicArn };
    }
    case "GetTopicAttributesCommand": {
      const topic = t.topics.get(arn);
      if (!topic) throw awsErr("NotFoundException", "Topic not found.");
      return { Attributes: topic.Attributes };
    }
    case "SetTopicAttributesCommand": {
      checkProvFault();
      const topic = t.topics.get(arn);
      if (!topic) throw awsErr("NotFoundException", "Topic not found.");
      topic.Attributes[input.AttributeName] = input.AttributeValue;
      return {};
    }
    case "ListTagsForResourceCommand": {
      const topic = t.topics.get(arn);
      if (!topic) throw awsErr("NotFoundException", "Topic not found.");
      return { Tags: topic.Tags };
    }
    case "ListSubscriptionsByTopicCommand": {
      const topic = t.topics.get(arn);
      if (!topic) throw awsErr("NotFoundException", "Topic not found.");
      return { Subscriptions: topic.subs };
    }
    case "SubscribeCommand": {
      checkProvFault();
      const topic = t.topics.get(arn);
      if (!topic) throw awsErr("NotFoundException", "Topic not found.");
      const subArn = `${arn}:sub1`;
      if (!topic.subs.length) {
        topic.subs.push({
          Owner: t.account,
          Protocol: input.Protocol,
          Endpoint: input.Endpoint,
          TopicArn: arn,
          SubscriptionArn: subArn,
        });
      }
      // Unless fault is wait_sns_confirm, simulate immediate SNS SubscriptionConfirmation callback.
      if (fault === "ok" && t.connectionId) {
        topic.confirmed = true;
        await db.execute(
          sql`UPDATE provider_connection_regions SET confirmed_topic_arn=feedback_topic_arn, confirmed_generation=generation
            WHERE connection_id=${t.connectionId} AND region=${region} AND feedback_topic_arn=${arn} AND sending_state='provisioning'`,
        );
      }
      return { SubscriptionArn: subArn };
    }
    case "GetSubscriptionAttributesCommand": {
      checkProvFault();
      const topic = t.topics.get(arn);
      if (!topic || !topic.subs.length) throw awsErr("NotFoundException", "Subscription not found.");
      return {
        Attributes: {
          ...topic.subs[0],
          PendingConfirmation: String(!topic.confirmed),
          RawMessageDelivery: "false",
        },
      };
    }
    case "DeleteTopicCommand": {
      t.topics.delete(arn);
      return {};
    }
    default:
      throw new Error(`unexpected SNS call ${op}`);
  }
};

let dbPrepared = false;
async function prepareDatabase() {
  if (dbPrepared) return;
  await db.execute(
    sql.raw(`
    CREATE SCHEMA IF NOT EXISTS tear_clock;
    CREATE TABLE IF NOT EXISTS tear_clock.state(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), off interval NOT NULL DEFAULT '0');
    ALTER TABLE tear_clock.state ADD COLUMN IF NOT EXISTS horizon bigint NOT NULL DEFAULT 0;
    ALTER TABLE tear_clock.state ADD COLUMN IF NOT EXISTS pinned timestamptz;
    INSERT INTO tear_clock.state DEFAULT VALUES ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION tear_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT coalesce((SELECT pinned FROM tear_clock.state), pg_catalog.clock_timestamp() + (SELECT off FROM tear_clock.state)) $$;
    CREATE OR REPLACE FUNCTION tear_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT pinned FROM tear_clock.state), pg_catalog.now() + (SELECT off FROM tear_clock.state)) $$;
    CREATE OR REPLACE FUNCTION tear_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT pinned FROM tear_clock.state), pg_catalog.statement_timestamp() + (SELECT off FROM tear_clock.state)) $$;
  `),
  );
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

/** Runs one targeted job (by exact id or type+region) through real processJobs without waking sibling jobs. */
async function runTargetedJob(t: Trial, type: string, filterSql: ReturnType<typeof sql>, runToExhaustion = false) {
  const maxSteps = runToExhaustion ? MAX_ATTEMPTS + 2 : 1;
  for (let step = 0; step < maxSteps; step++) {
    const [target] = await q<{ id: string; status: string }>(
      sql`SELECT id, status FROM jobs WHERE workspace_id=${t.W} AND type=${type} AND ${filterSql} AND status='pending' ORDER BY id LIMIT 1`,
    );
    if (!target) break;
    // Park all other pending jobs temporarily so processJobs runs strictly this target job deterministically.
    await db.execute(
      sql`UPDATE jobs SET available_at = now() + interval '1 hour' WHERE status='pending' AND id <> ${target.id}`,
    );
    await db.execute(sql`UPDATE jobs SET available_at = now() WHERE id = ${target.id}`);
    await setClock(lastVirtual + 5);
    t.activeJobType = type;
    try {
      await processJobs(runtime, regionalByoJobs, 1, 1, 10_000, "all");
    } finally {
      t.activeJobType = null;
      await db.execute(
        sql`UPDATE jobs SET available_at = now() WHERE workspace_id=${t.W} AND status='pending' AND available_at > now()`,
      );
    }
    if (!runToExhaustion) break;
  }
}

async function enrollAndScan(t: Trial): Promise<{ status: number; code: string | null }> {
  const res = await api(t, "POST", "/v1/connection", { kind: "byo", awsAccountId: t.account });
  if (res.status !== 202) {
    return { status: res.status, code: res.body?.error?.code ?? null };
  }
  const [conn] = await q<{ id: string; external_id: string; stack_name: string; inventory_revision: number }>(
    sql`SELECT id, external_id, stack_name, inventory_revision FROM provider_connections WHERE workspace_id=${t.W}`,
  );
  if (!conn) return { status: 500, code: "NO_CONN" };
  t.connectionId = conn.id;
  t.externalId = conn.external_id;
  t.roleArn = `arn:aws:iam::${t.account}:role/${conn.stack_name}`;
  t.revision = conn.inventory_revision;

  // Run byo.prove via real processJobs
  await runTargetedJob(t, "byo.prove", sql`true`);

  // Mark scan ready for ACTIVE_REGIONS with verified candidates (and mark other 30 AWS regions ready_to_import quickly)
  await db.execute(
    sql`UPDATE jobs SET status='completed', lease_until=NULL WHERE workspace_id=${t.W} AND type='byo.scan'`,
  );
  await db.execute(
    sql`UPDATE provider_connection_regions SET scan_state='ready_to_import', scan_facts='{"production":true,"sendingEnabled":true,"enforcement":"HEALTHY","max24HourSend":50000,"maxSendRate":14,"sentLast24Hours":0}'::jsonb
      WHERE connection_id=${conn.id}`,
  );
  await db.execute(
    sql`UPDATE provider_connections SET state='ready_to_import' WHERE id=${conn.id} AND state='scanning'`,
  );
  for (const r of ACTIVE_REGIONS) {
    for (const slot of ["alpha", "beta"] as const) {
      const name = domainName(t, slot);
      await db.execute(
        sql`INSERT INTO byo_candidates(connection_id, region, name, revision, identity)
          VALUES (${conn.id}, ${r}, ${name}, ${t.revision}, ${JSON.stringify(verifiedIdentity(name))}::jsonb)
          ON CONFLICT (connection_id, region, name) DO UPDATE SET identity=excluded.identity`,
      );
    }
  }
  return { status: 202, code: null };
}

async function configureTrial(t: Trial, preset: ByoPreset): Promise<ByoObs> {
  await assertDisposable((text) => db.execute(sql.raw(text)) as Promise<{ rows: Record<string, unknown>[] }>);
  traceSeq++;
  t.seq = traceSeq;
  if (traceSeq === 1) {
    const [{ horizon }] = await q<{ horizon: string }>(sql`SELECT horizon FROM tear_clock.state`);
    lastVirtual = Math.max(lastVirtual, Number(horizon));
  }
  t.epoch = Math.ceil((Math.max(lastVirtual, RealDate.now()) + 3_600_000) / 3_600_000) * 3_600_000;
  await setClock(t.epoch + 50);

  t.W = `tear_${process.pid}_${traceSeq}`;
  t.userId = `tear-user-${process.pid}-${traceSeq}`;
  // Unique 12-digit customer AWS account per trial (never collides with PLATFORM_ACCOUNT or earlier trials)
  const acctNum = 200_000_000_000 + ((process.pid % 9000) * 100_000 + traceSeq);
  t.account = String(acctNum).padStart(12, "0");

  const token = randomBytes(32).toString("base64url");
  t.cookie = `__Host-nightmail.session_token=${token}`;

  await db.execute(sql`INSERT INTO workspaces(id,name,slug,byo_v2_enabled) VALUES (${t.W},${t.W},${t.W},true)`);
  await ensureRegionSettings(db, { workspaceId: t.W, regions: ["us-east-2"] });
  await db.execute(sql`INSERT INTO nightmail_users(id,name,email,email_verified) VALUES (${t.userId},'tear',${t.userId + "@example.com"},true)`);
  await db.execute(sql`INSERT INTO nightmail_oidc_identities(issuer,subject,user_id) VALUES (${ISSUER},${t.userId},${t.userId})`);
  await db.execute(
    sql`INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES (${createHash("sha256").update(token).digest("hex")},${t.userId},${ISSUER},${t.userId},to_timestamp(${(vnow() + 7 * 86_400_000) / 1000}))`,
  );
  await db.execute(sql`INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (${"wm_" + t.W},${t.W},${t.userId},'owner')`);

  if (preset === "readyToImport") {
    t.connectionKind = "byo";
    const res = await enrollAndScan(t);
    if (res.status !== 202) throw new Error(`enrollAndScan failed: ${res.status} ${res.code}`);
  } else if (preset === "hosted") {
    t.connectionKind = "shared";
    const connId = `conn_tear_${process.pid}_${t.seq}`;
    const claimToken = `11111111-1111-4111-8111-${String(t.seq).padStart(12, "0")}`;
    const dName = domainName(t, "alpha");
    t.connectionId = connId;
    t.hostedClaimToken = claimToken;
    t.hostedDomainName = dName;
    await db.execute(
      sql`INSERT INTO provider_connections(id, workspace_id, kind, region, state, tenant_state, aws_account_id)
        VALUES (${connId}, ${t.W}, 'shared', 'us-east-2', 'ready', 'ready', ${PLATFORM_ACCOUNT})`,
    );
    await db.execute(
      sql`INSERT INTO provider_connection_regions(connection_id, region, managed_tenant, tenant_state, sending_state, receiving_state, legacy)
        VALUES (${connId}, 'us-east-2', false, 'ready', 'ready', 'off', true) ON CONFLICT (connection_id, region) DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO domain_claims(workspace_id, name, token, connection_id, sending_state, ever_proven)
        VALUES (${t.W}, ${dName}, ${claimToken}::uuid, ${connId}, 'verified', true)`,
    );
    await db.execute(
      sql`INSERT INTO operation_domains(id, workspace_id, name, region)
        VALUES (${"dom_" + t.W}, ${t.W}, ${dName}, 'us-east-2')`,
    );
    await db.execute(
      sql`INSERT INTO domain_sending_bindings(workspace_id, name, domain_id, connection_id, region)
        VALUES (${t.W}, ${dName}, ${"dom_" + t.W}, ${connId}, 'us-east-2') ON CONFLICT DO NOTHING`,
    );
  }

  t.configured = true;
  return await readObs(t, 200, null);
}

async function readObs(t: Trial, status: number, code: string | null): Promise<ByoObs> {
  const [conn] = await q<{ state: string; paused_at: string | null }>(
    sql`SELECT state, paused_at::text FROM provider_connections WHERE workspace_id=${t.W}`,
  );
  const regRows = t.connectionId
    ? await q<{ region: string; sending_state: string; provision_error: string | null }>(
        sql`SELECT region, sending_state, provision_error FROM provider_connection_regions WHERE connection_id=${t.connectionId} AND region IN ('us-east-2','us-east-1')`,
      )
    : [];
  const regions: Record<ByoRegion, { sendingState: string; error: string | null }> = {
    "us-east-2": { sendingState: "unprovisioned", error: null },
    "us-east-1": { sendingState: "unprovisioned", error: null },
  };
  for (const r of regRows) {
    if (r.region === "us-east-2" || r.region === "us-east-1") {
      regions[r.region] = { sendingState: r.sending_state, error: r.provision_error };
    }
  }
  const [counts] = await q<{ open_intents: number; bound: number }>(sql`SELECT
    (SELECT count(*)::int FROM byo_domain_intents WHERE connection_id=${t.connectionId ?? ""} AND closed_reason IS NULL) AS open_intents,
    (SELECT count(*)::int FROM domain_sending_bindings WHERE workspace_id=${t.W}) AS bound`);
  return {
    status,
    code,
    connectionState: conn?.state ?? null,
    paused: Boolean(conn?.paused_at),
    regions,
    openIntents: counts?.open_intents ?? 0,
    boundDomains: counts?.bound ?? 0,
  };
}

async function readSnapshot(t: Trial): Promise<Observed> {
  if (!t.configured) {
    const snap: ByoSnapshot = {
      configured: false,
      connectionExists: false,
      connectionId: null,
      connectionState: null,
      pausedAt: null,
      pauseReason: null,
      wasPausedBeforeLastDelete: false,
      regions: [],
      intents: [],
      boundDomains: [],
      pausedDeleteViolations: [],
      disconnectingMutationViolations: [],
      exhaustedRecoveryViolations: [],
      leakedErrors: [],
    };
    return { snapshot: snap, events: [] };
  }

  const [conn] = await q<{ id: string; state: string; paused_at: string | null; pause_reason: string | null }>(
    sql`SELECT id, state, paused_at::text, pause_reason FROM provider_connections WHERE workspace_id=${t.W}`,
  );

  const regions: RegionSnap[] = conn
    ? (
        await q<{
          region: string;
          sending_state: string;
          scan_state: string;
          provision_error: string | null;
          job_status: string | null;
          journal_count: number;
        }>(sql`SELECT r.region, r.sending_state, r.scan_state, r.provision_error, j.status AS job_status,
            jsonb_array_length(r.ownership_journal)::int AS journal_count
          FROM provider_connection_regions r
          LEFT JOIN jobs j ON j.id = 'byo.provision:' || r.connection_id || ':' || r.region
          WHERE r.connection_id = ${conn.id} AND r.region IN ('us-east-2','us-east-1')
          ORDER BY r.region`)
      ).map((r) => ({
        region: r.region,
        sendingState: r.sending_state,
        scanState: r.scan_state,
        provisionError: r.provision_error,
        provisionJobStatus: r.job_status,
        journalCount: r.journal_count,
      }))
    : [];

  const intents: IntentSnap[] = conn
    ? (
        await q<{
          id: string;
          region: string;
          name: string;
          importing: boolean;
          closed_reason: string | null;
          sending_state: string;
          prov_status: string | null;
          bind_status: string | null;
        }>(sql`SELECT i.id, i.region, i.name, i.importing, i.closed_reason, r.sending_state,
            p.status AS prov_status, b.status AS bind_status
          FROM byo_domain_intents i
          JOIN provider_connection_regions r USING (connection_id, region)
          LEFT JOIN jobs p ON p.id = 'byo.provision:' || i.connection_id || ':' || i.region
          LEFT JOIN jobs b ON b.id = 'byo.bind:' || i.id
          WHERE i.connection_id = ${conn.id}
          ORDER BY i.id`)
      ).map((i) => ({
        id: i.id,
        region: i.region,
        name: i.name,
        importing: i.importing,
        closedReason: i.closed_reason,
        regionSendingState: i.sending_state,
        provisionJobStatus: i.prov_status,
        bindJobStatus: i.bind_status,
      }))
    : [];

  // Canary bug: fabricate a failed backing job on an open intent to prove byo.no-orphan-pending-intent bites.
  if (t.bug === "canary_orphan_intent" && intents.some((i) => i.closedReason === null)) {
    const first = intents.find((i) => i.closedReason === null)!;
    first.provisionJobStatus = "failed";
    first.bindJobStatus = "failed";
  }

  const boundDomains = await q<{ name: string; region: string }>(
    sql`SELECT name, region FROM domain_sending_bindings WHERE workspace_id=${t.W} ORDER BY name`,
  );

  if (leaked.length) t.leakedErrors.push(...leaked.splice(0));

  const snap: ByoSnapshot = {
    configured: true,
    connectionExists: Boolean(conn),
    connectionId: conn?.id ?? null,
    connectionState: conn?.state ?? null,
    pausedAt: conn?.paused_at ?? null,
    pauseReason: conn?.pause_reason ?? null,
    wasPausedBeforeLastDelete: t.wasPausedBeforeLastDelete,
    regions,
    intents,
    boundDomains,
    pausedDeleteViolations: [...t.pausedDeleteViolations],
    disconnectingMutationViolations: [...t.disconnectingMutationViolations],
    exhaustedRecoveryViolations: [...t.exhaustedRecoveryViolations],
    leakedErrors: [...t.leakedErrors],
  };
  return { snapshot: snap, events: [] };
}

async function cleanupTrial(t: Trial) {
  if (t.configured) {
    await db.execute(sql`UPDATE jobs SET status='completed', lease_until=NULL WHERE workspace_id=${t.W} AND status IN ('pending','running')`);
    await db.execute(sql`DELETE FROM domain_sending_bindings WHERE workspace_id=${t.W}`);
    await db.execute(sql`DELETE FROM operation_domains WHERE workspace_id=${t.W}`);
    await db.execute(sql`DELETE FROM domain_claims WHERE workspace_id=${t.W}`);
    await db.execute(sql`DELETE FROM provider_connections WHERE workspace_id=${t.W}`);
    await db.execute(sql`DELETE FROM nightmail_sessions WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM nightmail_oidc_identities WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM workspace_members WHERE user_id=${t.userId}`);
    await db.execute(sql`DELETE FROM nightmail_users WHERE id=${t.userId}`);
    await db.execute(sql`UPDATE tear_clock.state SET horizon = greatest(horizon, ${Math.ceil(lastVirtual)})`);
  }
  if (activeTrial === t) activeTrial = null;
}

export const byoRegionalHost = host(byoRegional, {
  async open(req): Promise<Trial> {
    await prepareDatabase();
    const trial: Trial = {
      configured: false,
      bug: req.bug,
      seq: 0,
      epoch: 0,
      W: "",
      userId: "",
      cookie: "",
      account: "",
      connectionId: null,
      connectionKind: "byo",
      hostedClaimToken: null,
      hostedDomainName: null,
      externalId: null,
      roleArn: null,
      revision: 1,
      regionFault: { "us-east-2": "ok", "us-east-1": "ok" },
      disconnectFault: "ok",
      activeJobType: null,
      sets: new Map(),
      topics: new Map(),
      exhaustedDomains: new Set(),
      wasPausedBeforeLastDelete: false,
      pausedDeleteViolations: [],
      disconnectingMutationViolations: [],
      exhaustedRecoveryViolations: [],
      leakedErrors: [],
    };
    activeTrial = trial;
    return trial;
  },

  async act(t: Trial, a: ByoAction): Promise<ByoObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, a.preset);
    }
    if (!t.configured) throw new Error("byo-regional host: action before Configure");
    await setClock(lastVirtual + 5);

    let status = 200;
    let code: string | null = null;

    const currentConn = async () =>
      (
        await q<{ id: string; state: string; paused_at: string | null; pause_reason: string | null }>(
          sql`SELECT id, state, paused_at::text, pause_reason FROM provider_connections WHERE workspace_id=${t.W}`,
        )
      )[0];

    switch (a.op) {
      case "SetRegionFault":
        t.regionFault[a.region] = a.fault;
        break;

      case "SetDisconnectFault":
        t.disconnectFault = a.fault;
        break;

      case "Connect": {
        const res = await enrollAndScan(t);
        status = res.status;
        code = res.code;
        break;
      }

      case "SelectImports": {
        const conn = await currentConn();
        const name = domainName(t, a.domain);
        const res = await api(t, "POST", "/v1/connection/imports", {
          revision: t.revision,
          candidateIds: [`${a.region}:${name}`],
          confirm: true,
        });
        status = res.status;
        code = res.body?.error?.code ?? null;
        if (conn?.state === "disconnecting" && res.status !== 409) {
          t.disconnectingMutationViolations.push(`SelectImports returned ${res.status} (${code}) while disconnecting`);
        }
        if (t.exhaustedDomains.has(name) && conn && conn.state !== "disconnecting" && res.status === 409 && code === "DOMAIN_REGION_CONFLICT") {
          t.exhaustedRecoveryViolations.push(`SelectImports(${a.region}, ${name}) got 409 DOMAIN_REGION_CONFLICT after exhaustion`);
        }
        if (res.status === 202) t.exhaustedDomains.delete(name);
        break;
      }

      case "NewRegionalDomain": {
        const conn = await currentConn();
        const name = domainName(t, a.domain);
        const res = await api(t, "POST", "/v1/domains", { name, region: a.region });
        status = res.status;
        code = res.body?.error?.code ?? null;
        if (conn?.state === "disconnecting" && res.status !== 409) {
          t.disconnectingMutationViolations.push(`NewRegionalDomain returned ${res.status} (${code}) while disconnecting`);
        }
        if (t.exhaustedDomains.has(name) && conn && conn.state !== "disconnecting" && res.status === 409 && code === "DOMAIN_REGION_CONFLICT") {
          t.exhaustedRecoveryViolations.push(`NewRegionalDomain(${a.region}, ${name}) got 409 DOMAIN_REGION_CONFLICT after exhaustion`);
        }
        if (res.status === 202) t.exhaustedDomains.delete(name);
        break;
      }

      case "ProvisionStep": {
        const openBefore = t.connectionId
          ? await q<{ name: string }>(
              sql`SELECT name FROM byo_domain_intents WHERE connection_id=${t.connectionId} AND region=${a.region} AND closed_reason IS NULL`,
            )
          : [];
        await runTargetedJob(t, "byo.provision", sql`payload->>'region'=${a.region}`, Boolean(a.runToExhaustion));
        if (a.runToExhaustion && t.connectionId && openBefore.length > 0) {
          const [j] = await q<{ status: string }>(
            sql`SELECT status FROM jobs WHERE id=${"byo.provision:" + t.connectionId + ":" + a.region}`,
          );
          const fault = t.regionFault[a.region];
          if ((fault === "retryable_5xx" || fault === "access_denied") && j?.status === "pending") {
            t.exhaustedRecoveryViolations.push(
              `byo.provision(${a.region}) stayed pending after ${MAX_ATTEMPTS + 2} consecutive ${fault} attempts`,
            );
          }
          if (j?.status === "failed" || ((fault === "retryable_5xx" || fault === "access_denied") && j?.status === "pending")) {
            for (const row of openBefore) t.exhaustedDomains.add(row.name);
          }
        }
        break;
      }

      case "ConfirmTopic": {
        const conn = await currentConn();
        if (!conn) {
          status = 204;
          break;
        }
        const [reg] = await q<{ feedback_topic_arn: string | null }>(
          sql`SELECT feedback_topic_arn FROM provider_connection_regions WHERE connection_id=${conn.id} AND region=${a.region}`,
        );
        if (reg?.feedback_topic_arn) {
          const topic = t.topics.get(reg.feedback_topic_arn);
          if (topic) topic.confirmed = true;
          await db.execute(
            sql`UPDATE provider_connection_regions SET confirmed_topic_arn=feedback_topic_arn, confirmed_generation=generation
              WHERE connection_id=${conn.id} AND region=${a.region} AND sending_state='provisioning' AND feedback_topic_arn IS NOT NULL`,
          );
        }
        break;
      }

      case "BindStep": {
        const openBefore = t.connectionId
          ? await q<{ id: string; name: string }>(
              sql`SELECT id, name FROM byo_domain_intents WHERE connection_id=${t.connectionId} AND region=${a.region} AND closed_reason IS NULL`,
            )
          : [];
        await runTargetedJob(t, "byo.bind", sql`payload->>'region'=${a.region}`, Boolean(a.runToExhaustion));
        if (a.runToExhaustion && openBefore.length > 0) {
          for (const row of openBefore) {
            const [j] = await q<{ status: string }>(sql`SELECT status FROM jobs WHERE id=${"byo.bind:" + row.id}`);
            if (j?.status === "failed") t.exhaustedDomains.add(row.name);
          }
        }
        break;
      }

      case "OperatorPause": {
        const conn = await currentConn();
        if (conn && t.connectionKind === "shared") {
          await db.execute(
            sql`UPDATE provider_connections SET paused_at=clock_timestamp(), pause_reason='Sending paused by operator review.' WHERE id=${conn.id} AND kind='shared'`,
          );
        }
        break;
      }

      case "OperatorResume": {
        const conn = await currentConn();
        if (conn && t.connectionKind === "shared") {
          await db.execute(sql`UPDATE provider_connections SET paused_at=NULL, pause_reason=NULL WHERE id=${conn.id} AND kind='shared'`);
          t.wasPausedBeforeLastDelete = false;
        }
        break;
      }

      case "Disconnect": {
        const conn = await currentConn();
        const wasPaused = Boolean(conn?.paused_at || conn?.pause_reason);
        const midPause = Boolean(conn) && t.connectionKind === "shared" && t.disconnectFault === "pause_mid_disconnect";
        if (wasPaused) t.wasPausedBeforeLastDelete = true;
        const res = await api(t, "DELETE", "/v1/connection");
        status = res.status;
        code = res.body?.error?.code ?? null;
        const after = await currentConn();
        if ((wasPaused || midPause) && (res.status !== 409 || !after)) {
          t.pausedDeleteViolations.push(`DELETE /v1/connection returned ${res.status} (${code}), exists=${Boolean(after)} while paused`);
        }
        break;
      }

      case "DisconnectStep": {
        const conn = await currentConn();
        t.wasPausedBeforeLastDelete = Boolean(conn?.paused_at || conn?.pause_reason);
        await runTargetedJob(t, "byo.disconnect", sql`true`);
        const after = await currentConn();
        if (t.wasPausedBeforeLastDelete && !after) {
          t.pausedDeleteViolations.push("byo.disconnect deleted a paused v5 connection");
        }
        break;
      }

      case "Verify": {
        const conn = await currentConn();
        const r1 = await api(t, "GET", "/v1/connection");
        status = r1.status;
        code = r1.body?.error?.code ?? null;
        if (conn && t.connectionKind === "byo") {
          await api(t, "GET", "/v1/connection/regions/status");
          if (conn.state === "disconnecting") {
            const scanRes = await api(t, "POST", "/v1/connection/scan");
            if (scanRes.status !== 409) {
              t.disconnectingMutationViolations.push(`POST /v1/connection/scan returned ${scanRes.status} while disconnecting`);
            }
          }
        } else if (conn && t.connectionKind === "shared" && conn.state === "disconnecting") {
          const reconRes = await api(t, "POST", "/v1/connection", { kind: "shared", region: "us-east-2" });
          if (reconRes.status !== 409) {
            t.disconnectingMutationViolations.push(`POST /v1/connection returned ${reconRes.status} while disconnecting`);
          }
        }
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
