import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { inbox } from "./inbox.model.ts";
import {
  BOXES,
  CONNS,
  INBOX_PRESETS,
  ROLES,
  type BoxName,
  type BoxView,
  type ConnName,
  type InboxAction,
  type InboxObs,
  type InboxSnapshot,
  type InboxView,
  type RawBoxSnapshot,
  type RoleName,
} from "./inbox.types.ts";

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

// Validate disposable database before connecting or writing anything.
const { disposableUrl, assertDisposable } = await import("../disposable.ts");
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

const [
  { createApp },
  { dispatchAsMailboxAccess },
  { nodeRuntime },
  { storeIncoming },
  { acceptInboundNotification },
  { attachToMailboxes },
  { ingestInput },
] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/auth.ts"),
  import("../../src/adapters/node.ts"),
  import("../../src/mailbox-ingest-store.ts"),
  import("../../src/mailbox-receipts.ts"),
  import("../../src/mailbox-store.ts"),
  import("../../src/mailbox-ingest-input.ts"),
]);

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
});
const runtime = instance.runtime;
const app = createApp();

const REGION = "us-east-1";
const BUCKET = "tear-fixture";
const TOPIC = `arn:aws:sns:${REGION}:111122223333:tear-inbound`;

type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

interface PgConn {
  client: pg.Client;
  db: Db;
  pid: number;
}

interface WorkerConn extends PgConn {
  name: ConnName;
  open: boolean;
  pending?: Promise<void>;
  settled?: { ok: boolean; value: unknown };
  claim?: string[];
  claimed?: string;
}

let poolReady: Promise<{
  conns: Record<ConnName, WorkerConn>;
  auto: PgConn;
  checker: PgConn;
}> | null = null;

async function makeClient(): Promise<PgConn> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  const pid = (await c.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
  return { client: c, db: drizzle(c) as unknown as Db, pid };
}

function getPool() {
  if (!poolReady) {
    poolReady = (async () => {
      const conns = {} as Record<ConnName, WorkerConn>;
      for (const name of CONNS) {
        conns[name] = { ...(await makeClient()), name, open: false };
      }
      const auto = await makeClient();
      const checker = await makeClient();
      await auto.client.query("SET lock_timeout='500ms'");
      return { conns, auto, checker };
    })();
  }
  return poolReady;
}

interface Trial {
  configured: boolean;
  bug?: string;
  ws: string;
  ids: Record<BoxName, string>;
  addr: Record<BoxName, string>;
  quota: number | null;
  cursor: Record<BoxName, string>;
  cache: Record<string, string>;
  validitySeen: Record<string, string[]>;
  seenUids: Map<string, Set<number>>;
  prevMembers: Record<BoxName, Set<string>>;
  lastBoxModseq: Record<string, number>;
  lastFolderState: Map<string, [number, number]>;
  leakedErrors: string[];
  lastSnapshot: InboxSnapshot;
  pendingEvents: HostEvent[];
}

function unconfiguredSnapshot(): InboxSnapshot {
  return { configured: false, boxes: [], validitySeen: {}, leakedErrors: [] };
}

const midOf = (t: Trial, m: string) => `${t.ws}_${m}`;
const labelOf = (t: Trial, id: string) => id.slice(t.ws.length + 1);
const basePath = (t: Trial, x: BoxName) => `/v1/inboxes/${t.ids[x]}`;
const recipientsOf = (t: Trial, r: string) => [...r].map((ch) => t.addr[ch.toUpperCase() as BoxName]!).sort();
const recipNameOf = (t: Trial, list: string[] | null | undefined) =>
  list ? ["a", "b"].filter((x) => list.includes(t.addr[x.toUpperCase() as BoxName]!)).join("") : null;
const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? "ERROR"}`;

async function abortAll() {
  const { conns, checker } = await getPool();
  for (const c of Object.values(conns)) {
    if (c.pending && !c.settled) {
      await checker.client.query("SELECT pg_cancel_backend($1)", [c.pid]);
    }
  }
  for (const c of Object.values(conns)) {
    if (c.pending) await c.pending;
    if (c.open) await c.client.query("ROLLBACK");
    c.open = false;
    c.pending = undefined;
    c.settled = undefined;
    c.claim = undefined;
    c.claimed = undefined;
  }
}

async function cleanupWorkspace(ws: string) {
  if (!ws) return;
  const { auto } = await getPool();
  await auto.client.query("DELETE FROM mailboxes WHERE workspace_id=$1", [ws]);
  await auto.client.query("DELETE FROM jobs WHERE workspace_id=$1", [ws]);
  await auto.client.query("DELETE FROM mail_receipts WHERE workspace_id=$1", [ws]);
}

async function resolveId(t: Trial, m: string): Promise<string> {
  if (m !== "m1") return midOf(t, m);
  const { checker } = await getPool();
  const rows = (
    await checker.client.query("SELECT id FROM mail_messages WHERE id=ANY($1)", [[midOf(t, "m1"), midOf(t, "d1")]])
  ).rows.map((r) => r.id as string);
  return rows.includes(midOf(t, "d1")) && !rows.includes(midOf(t, "m1")) ? midOf(t, "d1") : midOf(t, "m1");
}

async function rest(
  t: Trial,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
  permissions: string[] = ["read", "modify"],
): Promise<{ error?: string; body?: Json }> {
  const access = {
    keyId: "tear",
    workspaceId: t.ws,
    admin: false,
    mailboxIds: [t.ids.A, t.ids.B],
    permissions,
  } as Json;
  const req = new Request(`http://127.0.0.1:9${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await dispatchAsMailboxAccess(app, req, { ...runtime, db } as Json, access);
  const json = (await res.json()) as Json;
  if (res.status >= 300) return { error: `e:${json?.error?.code ?? res.status}` };
  return { body: json };
}

const mutationResult = (r: { error?: string; body?: Json }) =>
  r.error ?? { modseq: Number(r.body.modseq), uid: r.body.uid ?? null, read: r.body.read, removed: r.body.removed };

function incoming(t: Trial, m: string, envelope: string[]) {
  const same = m === "d1" ? "m1" : m;
  return {
    id: midOf(t, m),
    workspaceId: t.ws,
    direction: "inbound",
    region: REGION,
    sesMessageId: midOf(t, m),
    messageId: `<${same}.${t.ws}@example.invalid>`,
    inReplyTo: m === "m2" ? `<m1.${t.ws}@example.invalid>` : null,
    references: m === "m2" ? [`<m1.${t.ws}@example.invalid>`] : [],
    subject: `Synthetic ${same}`,
    fromAddress: "sender@example.invalid",
    fromName: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    envelopeFrom: "sender@example.invalid",
    envelopeTo: envelope,
    receivedAt: new Date(Date.parse("2026-11-01T00:00:00Z") + 60_000 * Number(same.slice(1))).toISOString(),
    text: "synthetic",
    html: null,
    bodyTruncated: false,
    snippet: "synthetic",
    headers: [],
    attachmentCount: 0,
    sizeBytes: 42,
    rawBucket: BUCKET,
    rawKey: `raw/${midOf(t, m)}`,
    verdicts: {},
    spam: false,
    automated: false,
    status: "received",
    lifecycle: "kept",
  } as Json;
}

function buildStatement(t: Trial, a: InboxAction, c: { db: Db }, claim?: string[]): () => Promise<unknown> {
  if (a.op === "Accept") {
    const recips = recipientsOf(t, a.recips);
    const message = {
      notificationType: "Received",
      mail: {
        messageId: midOf(t, a.msg),
        timestamp: "2026-11-01T00:00:00.000Z",
        source: "sender@example.invalid",
        destination: recips,
      },
      receipt: {
        timestamp: "2026-11-01T00:00:00.000Z",
        recipients: recips,
        action: { type: "S3", bucketName: BUCKET, objectKey: `staging/${midOf(t, a.msg)}`, topicArn: TOPIC },
      },
    };
    return async () => ({
      queued: await acceptInboundNotification({ ...runtime, db: c.db } as Json, { topicArn: TOPIC, region: REGION, message }),
    });
  }
  if (a.op === "StoreClaimed" || a.op === "StoreAuto") {
    const m = a.op === "StoreAuto" ? a.msg : "";
    return async () => {
      await storeIncoming(c.db as Json, incoming(t, m, claim!), [], false, false, false, null, undefined);
      return "ok";
    };
  }

  return async () => {
    switch (a.op) {
      case "Seen": {
        const id = await resolveId(t, a.msg);
        return mutationResult(await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/messages/${id}`, { read: true }));
      }
      case "Unseen": {
        const id = await resolveId(t, a.msg);
        return mutationResult(await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/messages/${id}`, { read: false }));
      }
      case "Flag": {
        const id = await resolveId(t, a.msg);
        return mutationResult(await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/messages/${id}`, { flagged: true }));
      }
      case "Del": {
        const id = await resolveId(t, a.msg);
        return mutationResult(
          await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/messages/${id}`, { deleted: true, source: a.role }),
        );
      }
      case "Undel": {
        const id = await resolveId(t, a.msg);
        return mutationResult(
          await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/messages/${id}`, { deleted: false, source: a.role }),
        );
      }
      case "Move": {
        const id = await resolveId(t, a.msg);
        return mutationResult(
          await rest(t, c.db, "POST", `${basePath(t, a.box)}/messages/${id}/move`, { source: a.src, folder: a.dst }),
        );
      }
      case "Copy": {
        const id = await resolveId(t, a.msg);
        return mutationResult(
          await rest(t, c.db, "POST", `${basePath(t, a.box)}/messages/${id}/copy`, { source: a.src, folder: a.dst }),
        );
      }
      case "Trash": {
        const id = await resolveId(t, a.msg);
        return mutationResult(await rest(t, c.db, "DELETE", `${basePath(t, a.box)}/messages/${id}?source=${a.role}`));
      }
      case "Expunge": {
        const id = await resolveId(t, a.msg);
        return mutationResult(
          await rest(t, c.db, "DELETE", `${basePath(t, a.box)}/messages/${id}?source=${a.role}&permanent=true`),
        );
      }
      case "Purge": {
        const r = await rest(t, c.db, "POST", `${basePath(t, a.box)}/folders/${a.role}/expunge`, {});
        return r.error ?? { expunged: r.body.expunged };
      }
      case "Subscribe": {
        const r = await rest(t, c.db, "PATCH", `${basePath(t, a.box)}/folders/inbox`, { subscribed: true });
        return r.error ?? Number(r.body.state);
      }
      case "Delete": {
        const r = await rest(t, c.db, "DELETE", basePath(t, a.box));
        return r.error ?? r.body.status;
      }
      default:
        throw new Error(`unexpected statement action ${a.op}`);
    }
  };
}

async function settle(c: WorkerConn): Promise<unknown> {
  const { conns, auto, checker } = await getPool();
  const start = Date.now();
  for (;;) {
    if (c.settled) {
      const s = c.settled;
      c.pending = undefined;
      c.settled = undefined;
      return s.ok ? s.value : errOf(s.value);
    }
    const own = [...Object.values(conns).map((x) => x.pid), auto.pid];
    const w = (
      await checker.client.query(
        "SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked, pg_blocking_pids($1) AS by FROM pg_stat_activity WHERE pid=$1",
        [c.pid, own],
      )
    ).rows[0];
    if (w?.blocked && !c.settled) {
      return "blocked";
    }
    if (Date.now() - start > 10_000) return "stuck";
  }
}

async function runHeld(c: WorkerConn, fn: () => Promise<unknown>): Promise<unknown> {
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

async function finishHeld(c: WorkerConn, commit: boolean): Promise<{ r: unknown; woke: Record<string, unknown> }> {
  const { conns } = await getPool();
  let r: unknown = "ok";
  try {
    await c.client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    r = errOf(e);
  }
  c.open = false;
  c.claim = undefined;
  const woke: Record<string, unknown> = {};
  for (const other of Object.values(conns)) {
    if (other.pending) {
      const v = await settle(other);
      if (v !== "blocked") woke[other.name] = v;
    }
  }
  return { r, woke };
}

async function autoTxn<T>(fn: () => Promise<T>): Promise<unknown> {
  const { auto } = await getPool();
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

async function readCommitted(t: Trial): Promise<InboxView> {
  const { checker } = await getPool();
  const {
    rows: [row],
  } = await checker.client.query(
    `SELECT jsonb_build_object(
      'boxes',(SELECT coalesce(jsonb_object_agg(b.id,jsonb_build_object('ended',b.delete_after<=now(),'ms',s.modseq,'fl',s.changes_floor,'n',s.messages,'by',s.bytes,'h',s.held)),'{}') FROM mailboxes b LEFT JOIN inbox_state s ON s.inbox_id=b.id WHERE b.id=ANY($1)),
      'folders',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid_validity::text,uid_next,highest_modseq,total,unseen)),'[]') FROM inbox_folders WHERE inbox_id=ANY($1)),
      'entries',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid,message_id,modseq,deleted) ORDER BY inbox_id,role,uid),'[]') FROM inbox_entries WHERE inbox_id=ANY($1)),
      'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(l.mailbox_id,l.message_id,l.read,(l.flags&1)<>0,l.modseq,l.held_reason IS NOT NULL,m.thread_id,m.size_bytes)),'[]') FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=ANY($1)),
      'vanished',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid,message_id,modseq) ORDER BY inbox_id,role,uid),'[]') FROM inbox_vanished WHERE inbox_id=ANY($1)),
      'threads',(SELECT coalesce(jsonb_agg(jsonb_build_array(mailbox_id,thread_id,message_count,unread_count)),'[]') FROM mailbox_threads WHERE mailbox_id=ANY($1)),
      'labels',(SELECT coalesce(jsonb_object_agg(thread_id,first),'{}') FROM (SELECT thread_id,min(id) first FROM mail_messages WHERE workspace_id=$2 GROUP BY thread_id) t),
      'receipts',(SELECT coalesce(jsonb_object_agg(ses_message_id,jsonb_build_array(status='pending',recipients)),'{}') FROM mail_receipts WHERE workspace_id=$2)) v`,
    [[t.ids.A, t.ids.B], t.ws],
  );
  const d = row.v as Json;
  const viewBoxes = {} as Record<BoxName, BoxView>;
  const snapBoxes: RawBoxSnapshot[] = [];

  for (const x of BOXES) {
    const id = t.ids[x];
    const b = d.boxes[id];
    if (!b) {
      viewBoxes[x] = { st: 2 };
      snapBoxes.push({
        box: x,
        exists: false,
        ended: true,
        modseq: 0,
        messages: 0,
        bytes: 0,
        held: 0,
        folders: [],
        entries: [],
        members: [],
        vanished: [],
        threads: [],
      });
      continue;
    }

    const rawFolders = d.folders.filter((f: Json) => f[0] === id);
    const coreFolders = ROLES.map((role) => rawFolders.find((f: Json) => f[1] === role));
    const entries = d.entries.filter((e: Json) => e[0] === id);
    const vanished = d.vanished.filter((e: Json) => e[0] === id);
    const members = d.members.filter((e: Json) => e[0] === id);
    const threads = d.threads.filter((e: Json) => e[0] === id);

    viewBoxes[x] = {
      st: b.ended ? 1 : 0,
      ms: Number(b.ms),
      fl: Number(b.fl),
      n: Number(b.n),
      by: Number(b.by),
      h: Number(b.h),
      f: coreFolders.map((f: Json) => (f ? [Number(f[3]), Number(f[4]), Number(f[5]), Number(f[6])] : null)),
      e: entries.map((e: Json) => [e[1] as RoleName, Number(e[2]), labelOf(t, e[3]), Number(e[4]), Boolean(e[5])]),
      m: Object.fromEntries(
        members.map((e: Json) => [labelOf(t, e[1]), [Boolean(e[2]), Boolean(e[3]), Number(e[4]), Boolean(e[5])]]),
      ),
      v: vanished.map((e: Json) => [e[1] as RoleName, Number(e[2]), labelOf(t, e[3]), Number(e[4])]),
      t: Object.fromEntries(
        threads.map((e: Json) => [labelOf(t, d.labels[e[1]] ?? `${t.ws}_?`), [Number(e[2]), Number(e[3])]]),
      ),
    };

    const snapBox: RawBoxSnapshot = {
      box: x,
      exists: true,
      ended: Boolean(b.ended),
      modseq: Number(b.ms),
      messages: Number(b.n),
      bytes: Number(b.by),
      held: Number(b.h),
      folders: rawFolders.map((f: Json) => ({
        role: String(f[1]),
        uidValidity: String(f[2]),
        uidNext: Number(f[3]),
        highestModseq: Number(f[4]),
        total: Number(f[5]),
        unseen: Number(f[6]),
      })),
      entries: entries.map((e: Json) => ({
        role: String(e[1]),
        uid: Number(e[2]),
        mid: labelOf(t, e[3]),
        modseq: Number(e[4]),
        deleted: Boolean(e[5]),
      })),
      members: members.map((e: Json) => ({
        mid: labelOf(t, e[1]),
        read: Boolean(e[2]),
        flagged: Boolean(e[3]),
        modseq: Number(e[4] ?? 0),
        held: Boolean(e[5]),
        threadId: String(e[6]),
        sizeBytes: Number(e[7]),
      })),
      vanished: vanished.map((e: Json) => ({
        role: String(e[1]),
        uid: Number(e[2]),
        mid: labelOf(t, e[3]),
        modseq: Number(e[4]),
      })),
      threads: threads.map((e: Json) => ({
        threadId: String(e[1]),
        label: labelOf(t, d.labels[e[1]] ?? `${t.ws}_?`),
        messageCount: Number(e[2]),
        unreadCount: Number(e[3]),
      })),
    };
    snapBoxes.push(snapBox);

    // Emit declarative temporal events & update raw history trackers.
    if (t.lastBoxModseq[x] === undefined || t.lastBoxModseq[x] !== snapBox.modseq) {
      t.lastBoxModseq[x] = snapBox.modseq;
      t.pendingEvents.push({ name: "inbox.state", data: { box: x, modseq: snapBox.modseq } });
    }

    for (const f of snapBox.folders) {
      const fkey = `${x}/${f.role}`;
      if (!snapBox.ended) {
        const hist = (t.validitySeen[fkey] ??= []);
        if (hist[hist.length - 1] !== f.uidValidity) {
          hist.push(f.uidValidity);
        }
      }
      const prevF = t.lastFolderState.get(fkey);
      if (!prevF || prevF[0] !== f.uidNext || prevF[1] !== f.highestModseq) {
        t.lastFolderState.set(fkey, [f.uidNext, f.highestModseq]);
        t.pendingEvents.push({
          name: "folder.state",
          data: { folder: fkey, uidNext: f.uidNext, highestModseq: f.highestModseq },
        });
      }
      const known = t.seenUids.get(fkey) ?? new Set<number>();
      t.seenUids.set(fkey, known);
      const newlyVisible = snapBox.entries
        .filter((e) => e.role === f.role && !known.has(e.uid))
        .map((e) => e.uid)
        .sort((a, c) => a - c);
      for (const uid of newlyVisible) {
        known.add(uid);
        t.pendingEvents.push({ name: "folder.uid.visible", data: { folder: fkey, uid } });
      }
    }

    const nowMembers = new Set(snapBox.members.map((m) => m.mid));
    const prevMembers = t.prevMembers[x];
    for (const m of prevMembers) {
      if (!nowMembers.has(m)) {
        t.pendingEvents.push({ name: "member.removed", data: { key: `${x}:${m}` } });
        // Planted canary bug: emit a bogus resurrection immediately after removal so inbox.no-resurrection bites.
        if (t.bug === "canary_resurrect") {
          t.pendingEvents.push({ name: "member.present", data: { key: `${x}:${m}` } });
        }
      }
    }
    for (const m of nowMembers) {
      if (!prevMembers.has(m)) {
        t.pendingEvents.push({ name: "member.present", data: { key: `${x}:${m}` } });
      }
    }
    t.prevMembers[x] = nowMembers;
  }

  if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
  t.lastSnapshot = {
    configured: true,
    boxes: snapBoxes,
    validitySeen: Object.fromEntries(Object.entries(t.validitySeen).map(([k, v]) => [k, [...v]])),
    leakedErrors: [...t.leakedErrors],
  };

  const receipts = Object.fromEntries(
    Object.entries(d.receipts).map(([k, [pending, recips]]: Json) => [labelOf(t, k), [Boolean(pending), recipNameOf(t, recips)]]),
  ) as Record<string, [boolean, string | null]>;

  return { A: viewBoxes.A, B: viewBoxes.B, r: receipts };
}

async function configureTrial(t: Trial, quota: number | null): Promise<InboxObs> {
  const { auto, checker } = await getPool();
  await abortAll();
  await assertDisposable((text) => checker.client.query(text));
  if (t.ws) await cleanupWorkspace(t.ws);

  const ws = "tear_inbox_" + hex(12);
  t.ws = ws;
  t.quota = quota;
  t.configured = true;
  runtime.config.workspaceId = ws;
  const domainHost = `${ws.replaceAll("_", "-")}.invalid`;
  const domain = `${ws}_dom`;
  t.ids = { A: `${ws}_a`, B: `${ws}_b` };
  t.addr = { A: `a@${domainHost}`, B: `b@${domainHost}` };
  t.cursor = { A: "0", B: "0" };
  t.cache = {};
  t.validitySeen = {};
  t.seenUids = new Map();
  t.prevMembers = { A: new Set(), B: new Set() };
  t.lastBoxModseq = {};
  t.lastFolderState = new Map();
  t.pendingEvents = [];

  const c = auto.client;
  await c.query("BEGIN");
  await c.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)", [ws]);
  await c.query(
    "INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$1,$3,$4,'active','store')",
    [domain, ws, domainHost, REGION],
  );
  await c.query("INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,$3,$4)", [
    ws,
    REGION,
    BUCKET,
    TOPIC,
  ]);
  for (const x of BOXES) {
    await c.query(
      "INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind,retention_mode,quota_messages,create_request) VALUES($1,$2,$3,$4,'inbox','forever',$5,'{\"type\":\"persistent\"}')",
      [t.ids[x], ws, domain, t.addr[x], x === "A" ? quota : null],
    );
    await c.query("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [
      ws,
      t.addr[x],
      t.ids[x],
    ]);
    await c.query("INSERT INTO inbox_state(inbox_id,workspace_id) VALUES($1,$2)", [t.ids[x], ws]);
  }
  await c.query("COMMIT");

  const view = await readCommitted(t);
  return { r: "ok", woke: {}, view };
}

async function execAuto(t: Trial, a: InboxAction): Promise<unknown> {
  const { auto } = await getPool();
  const db = auto.db;
  switch (a.op) {
    case "StoreAuto": {
      const row = (await db.execute<{ i: Json }>(sql`SELECT ${ingestInput(runtime.config, t.ws, midOf(t, a.msg))} AS i`))
        .rows[0]?.i;
      if (!row) return null;
      const v = await autoTxn(() => buildStatement(t, a, auto, row.recipients)());
      return typeof v === "string" && v.startsWith("e:") ? v : recipNameOf(t, row.recipients);
    }
    case "Accept":
    case "Seen":
    case "Unseen":
    case "Flag":
    case "Del":
    case "Undel":
    case "Move":
    case "Copy":
    case "Trash":
    case "Expunge":
    case "Purge":
    case "Delete":
    case "Subscribe":
      return autoTxn(buildStatement(t, a, auto));
    case "Send":
      return autoTxn(async () => {
        const id = midOf(t, `s${a.box}`);
        const thread = `${t.ws}_thr_s${a.box}`;
        await auto.client.query("INSERT INTO mail_threads(id,workspace_id) VALUES($1,$2)", [thread, t.ws]);
        const row = (
          await auto.client.query(
            'INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,size_bytes,received_at) VALUES($1,$2,$3,\'outbound\',\'kept\',\'Re: synthetic\',$4,100,now()) RETURNING id,thread_id AS "threadId",direction,received_at AS "receivedAt",spam',
            [id, t.ws, thread, t.addr[a.box]],
          )
        ).rows[0];
        await attachToMailboxes(db as Json, { workspaceId: t.ws } as Json, row, [t.ids[a.box]]);
        return "ok";
      });
    case "Folders": {
      const f = await rest(t, db, "GET", `${basePath(t, a.box)}/folders`);
      if (f.error) return f.error;
      const folders = ROLES.map((role) => f.body.data.find((d: Json) => d.role === role)).map((d: Json) => [
        d.uidNext,
        Number(d.highestModseq),
        d.total,
        d.unseen,
      ]);
      const lists = [];
      for (const role of ROLES) {
        const l = await rest(t, db, "GET", `${basePath(t, a.box)}/messages?folder=${role}&limit=50`);
        if (l.error) return l.error;
        lists.push(
          l.body.data.map((e: Json) => [
            e.uid,
            labelOf(t, e.id),
            e.read,
            e.flags.includes("flagged"),
            e.folders.find((p: Json) => p.folder === role && p.uid === e.uid)?.deleted,
          ]),
        );
      }
      return { state: Number(f.body.state), folders, lists };
    }
    case "Sync": {
      const r = await rest(t, db, "GET", `${basePath(t, a.box)}/changes?since=${t.cursor[a.box]}`);
      if (r.error === "e:CHANGES_EXPIRED") {
        const f = await rest(t, db, "GET", `${basePath(t, a.box)}/folders`);
        t.cursor[a.box] = f.body.state;
        return r.error;
      }
      if (r.error) return r.error;
      t.cursor[a.box] = r.body.state;
      return {
        changed: r.body.changed.map((id: string) => labelOf(t, id)).sort(),
        removed: r.body.removed.map((id: string) => labelOf(t, id)).sort(),
        state: Number(r.body.state),
      };
    }
    case "SyncAhead": {
      const f = await rest(t, db, "GET", `${basePath(t, a.box)}/folders`);
      if (f.error) return f.error;
      return (await rest(t, db, "GET", `${basePath(t, a.box)}/changes?since=${BigInt(f.body.state) + 1n}`)).error ?? "accepted";
    }
    case "Get": {
      const r = await rest(t, db, "GET", `${basePath(t, a.box)}/messages/${await resolveId(t, a.msg)}`);
      if (r.error) return r.error;
      t.cache[`${a.box}:${a.msg}`] = r.body.modseq;
      return {
        modseq: Number(r.body.modseq),
        read: r.body.read,
        flagged: r.body.flags.includes("flagged"),
        held: r.body.held !== null,
        folders: r.body.folders.map((p: Json) => [p.folder, p.uid, p.deleted]),
      };
    }
    case "Cas":
      return autoTxn(async () =>
        mutationResult(
          await rest(t, db, "PATCH", `${basePath(t, a.box)}/messages/${await resolveId(t, a.msg)}`, {
            flagged: true,
            ifModseq: t.cache[`${a.box}:${a.msg}`],
          }),
        ),
      );
    case "ReadOnly":
      return (
        (await rest(t, db, "PATCH", `${basePath(t, a.box)}/messages/${await resolveId(t, a.msg)}`, { read: true }, ["read"]))
          .error ?? "accepted"
      );
    case "Thread": {
      const tid =
        (await auto.client.query("SELECT thread_id FROM mail_messages WHERE id=$1", [await resolveId(t, a.msg)])).rows[0]
          ?.thread_id ?? "thr_missing";
      const k = a.kind;
      const body = {
        addressId: t.ids[a.box],
        ...(k.endsWith("archive")
          ? { archived: k === "archive" }
          : k.endsWith("trash")
            ? { trashed: k === "trash" }
            : { read: k === "read" }),
      };
      const r = await rest(t, db, "PATCH", `/v1/inbound/threads/${tid}`, body);
      return r.error ?? "ok";
    }
    case "Sweep":
      while ((await auto.client.query("SELECT inbox_retention_batch(25) n")).rows[0].n > 0) {}
      return "ok";
    case "Age":
      await auto.client.query("UPDATE inbox_vanished SET vanished_at=vanished_at-interval '31 days' WHERE inbox_id=ANY($1)", [
        [t.ids.A, t.ids.B],
      ]);
      return "ok";
    case "Prune":
      while ((await auto.client.query("SELECT inbox_prune_vanished() n")).rows[0].n > 0) {}
      return "ok";
    default:
      throw new Error(`unknown autocommit action ${a.op}`);
  }
}

export const inboxHost = host(inbox, {
  async open(req): Promise<Trial> {
    await getPool();
    return {
      configured: false,
      bug: req.bug,
      ws: "",
      ids: { A: "", B: "" },
      addr: { A: "", B: "" },
      quota: null,
      cursor: { A: "0", B: "0" },
      cache: {},
      validitySeen: {},
      seenUids: new Map(),
      prevMembers: { A: new Set(), B: new Set() },
      lastBoxModseq: {},
      lastFolderState: new Map(),
      leakedErrors: [],
      lastSnapshot: unconfiguredSnapshot(),
      pendingEvents: [],
    };
  },

  async act(t: Trial, a: InboxAction): Promise<InboxObs> {
    if (a.op === "Configure") {
      return await configureTrial(t, INBOX_PRESETS[a.preset].quota);
    }
    if (!t.configured) throw new Error("inbox host: action before Configure");

    const { conns } = await getPool();
    let r: unknown;
    let woke: Record<string, unknown> = {};

    if (a.op === "Commit" || a.op === "Abort") {
      ({ r, woke } = await finishHeld(conns[a.conn], a.op === "Commit"));
    } else if (a.op === "Claim") {
      const c = conns[a.conn];
      const row = (await c.db.execute<{ i: Json }>(sql`SELECT ${ingestInput(runtime.config, t.ws, midOf(t, a.msg))} AS i`))
        .rows[0]?.i;
      c.claim = row?.recipients ?? undefined;
      c.claimed = a.msg;
      r = recipNameOf(t, row?.recipients);
    } else if (a.op === "StoreClaimed") {
      const c = conns[a.conn];
      const claimed = c.claimed!;
      const claim = c.claim!;
      r = await runHeld(c, async () => {
        await storeIncoming(c.db as Json, incoming(t, claimed, claim), [], false, false, false, null, undefined);
        return "ok";
      });
    } else if ("conn" in a && a.conn !== undefined) {
      const c = conns[a.conn];
      r = await runHeld(c, buildStatement(t, a, c));
    } else {
      r = await execAuto(t, a);
    }

    const view = await readCommitted(t);
    return { r, woke, view };
  },

  async observe(t: Trial): Promise<Observed> {
    const events = t.pendingEvents;
    t.pendingEvents = [];
    return { snapshot: t.lastSnapshot, events };
  },

  async close(t: Trial): Promise<void> {
    await abortAll().catch(() => {});
    await cleanupWorkspace(t.ws).catch(() => {});
  },
});
