import { choice, exact, model, prop, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  BOXES,
  CONNS,
  INBOX_PRESETS,
  ROLES,
  type ActiveRole,
  type ArrivingMsg,
  type BoxName,
  type BoxView,
  type ClientMsg,
  type ConnName,
  type InboxAction,
  type InboxCfg,
  type InboxObs,
  type InboxPreset,
  type InboxSnapshot,
  type InboxView,
  type IngestConn,
  type Recips,
  type RoleName,
  type ThreadKind,
  type WriterConn,
} from "./inbox.types.ts";

const INBOX = 1;
const SENT = 3;
const TRASH = 4;
const INBOUND_BYTES = 42;
const SENT_BYTES = 100;

const LANE = 0;
const TURN = 30;
const WINDOW = 31;
const receiptLock = (m: number): number => 10 + m;
const inboxLock = (x: number): number => 20 + x;

function midName(m: number): string {
  if (m === 3) return "d1";
  if (m === 10) return "sA";
  if (m === 11) return "sB";
  return `m${m + 1}`;
}

function midParse(s: ArrivingMsg | ClientMsg): number {
  switch (s) {
    case "m1":
      return 0;
    case "m2":
      return 1;
    case "m3":
      return 2;
    case "d1":
      return 3;
  }
}

function roleParse(s: RoleName | ActiveRole): number {
  return ROLES.indexOf(s);
}

function boxParse(s: BoxName): number {
  return s === "A" ? 0 : 1;
}

function connParse(s: ConnName): number {
  return CONNS.indexOf(s);
}

function recipsParse(s: Recips): number {
  switch (s) {
    case "a":
      return 1;
    case "b":
      return 2;
    case "ab":
      return 3;
  }
}

function recipsName(r: number): string {
  return ["-", "a", "b", "ab"][r & 3]!;
}

function arrival(m: number): number {
  return m === 3 ? 0 : m;
}

function threadKindIndex(k: ThreadKind): number {
  return ["archive", "unarchive", "trash", "untrash", "read", "unread"].indexOf(k);
}

function cmpAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function err(code: string): string {
  return `e:${code}`;
}

// ---- Model state types ----

interface FolderState {
  next: number;
  high: number;
  total: number;
  unseen: number;
}

interface EntryState {
  role: number;
  uid: number;
  mid: number;
  modseq: number;
  deleted: boolean;
}

interface MemberState {
  read: boolean;
  flagged: boolean;
  modseq: number;
  held: boolean;
  bytes: number;
}

interface VanishedState {
  role: number;
  uid: number;
  mid: number;
  modseq: number;
  old: boolean;
}

interface BoxState {
  /** 0 live, 1 ended (deleting, invisible), 2 erased by the sweep. */
  status: 0 | 1 | 2;
  modseq: number;
  floor: number;
  messages: number;
  bytes: number;
  held: number;
  folders: FolderState[];
  entries: EntryState[];
  members: Record<number, MemberState>;
  vanished: VanishedState[];
  threads: Record<number, [number, number]>;
  seen: number[];
}

interface ReceiptState {
  pending: boolean;
  recips: number;
}

interface DbState {
  boxes: [BoxState, BoxState];
  receipts: Record<number, ReceiptState>;
  /** Stored mail_messages content: message id -> thread label. */
  content: Record<number, number>;
  /** 30+ days have passed: the SES notification window for already-received mail is closed. */
  aged: boolean;
}

type Mut =
  | { kind: "Read"; x: number; m: number; v: boolean }
  | { kind: "Flag"; x: number; m: number }
  | { kind: "Deleted"; x: number; m: number; src: number; v: boolean }
  | { kind: "Move"; x: number; m: number; src: number; dst: number }
  | { kind: "Copy"; x: number; m: number; src: number; dst: number }
  | { kind: "Trash"; x: number; m: number; src: number }
  | { kind: "Expunge"; x: number; m: number; src: number }
  | { kind: "Purge"; x: number; role: number }
  | { kind: "Delete"; x: number }
  | { kind: "Subscribe"; x: number }
  | { kind: "Thread"; x: number; m: number; tkind: number };

type Stmt =
  | { kind: "Accept"; m: number; r: number }
  | { kind: "Store"; m: number; r: number }
  | { kind: "Mut"; mu: Mut };

interface TxnState {
  stmt: Stmt | null;
  held: number[];
  wait: number | null;
  done: boolean;
  stage: number;
  claim: [number, number] | null;
  seq: number;
  maybe: number[];
}

export interface InboxState {
  configured: boolean;
  cfg: InboxCfg | null;
  db: DbState;
  head: DbState;
  conns: TxnState[];
  tick: number;
  cursor: [number, number];
  cache: Record<string, number>;
}

function emptyBox(status: 0 | 1 | 2 = 0): BoxState {
  return {
    status,
    modseq: 1,
    floor: 0,
    messages: 0,
    bytes: 0,
    held: 0,
    folders: Array.from({ length: 5 }, () => ({ next: 1, high: 1, total: 0, unseen: 0 })),
    entries: [],
    members: {},
    vanished: [],
    threads: {},
    seen: [],
  };
}

function emptyDb(): DbState {
  return {
    boxes: [emptyBox(0), emptyBox(0)],
    receipts: {},
    content: {},
    aged: false,
  };
}

function emptyTxn(): TxnState {
  return {
    stmt: null,
    held: [],
    wait: null,
    done: false,
    stage: 0,
    claim: null,
    seq: 0,
    maybe: [],
  };
}

function initialForPreset(preset: InboxPreset): InboxState {
  const cfg = INBOX_PRESETS[preset];
  const db = emptyDb();
  return {
    configured: true,
    cfg,
    db,
    head: structuredClone(db),
    conns: [emptyTxn(), emptyTxn(), emptyTxn(), emptyTxn()],
    tick: 0,
    cursor: [0, 0],
    cache: {},
  };
}

function cloneState(s: InboxState): InboxState {
  return structuredClone(s);
}

// ---- Low-level DB & Inbox operations ----

function hasKey(rec: Record<number, unknown>, k: number): boolean {
  return Object.prototype.hasOwnProperty.call(rec, k);
}

function resolveId(db: DbState, m: number): number {
  if (m === 0 && !hasKey(db.content, 0) && hasKey(db.content, 3)) {
    return 3;
  }
  return m;
}

function resolveMut(db: DbState, mu: Mut): Mut {
  switch (mu.kind) {
    case "Read":
    case "Flag":
    case "Deleted":
    case "Move":
    case "Copy":
    case "Trash":
    case "Expunge":
    case "Thread":
      return { ...mu, m: resolveId(db, mu.m) };
    default:
      return mu;
  }
}

function mutTakesLane(mu: Mut): boolean {
  return mu.kind === "Expunge" || mu.kind === "Purge" || mu.kind === "Delete" || mu.kind === "Thread";
}

function locateEntry(b: BoxState, m: number, role: number): { ok: true; index: number } | { ok: false; code: string } {
  const hits: number[] = [];
  for (let i = 0; i < b.entries.length; i++) {
    const e = b.entries[i]!;
    if (e.mid === m && e.role === role) hits.push(i);
  }
  if (hits.length === 0) return { ok: false, code: "MESSAGE_GONE" };
  if (hits.length === 1) return { ok: true, index: hits[0]! };
  return { ok: false, code: "AMBIGUOUS_ENTRY" };
}

function hasEntry(b: BoxState, m: number, role: number): boolean {
  return b.entries.some((e) => e.mid === m && e.role === role);
}

function addEntry(b: BoxState, m: number, role: number, stamp: number, seen: boolean, deleted: boolean): number {
  const f = b.folders[role]!;
  const uid = f.next;
  f.next += 1;
  f.total += 1;
  f.unseen += seen ? 0 : 1;
  f.high = stamp;
  b.entries.push({ role, uid, mid: m, modseq: stamp, deleted });
  b.entries.sort((a, c) => (a.role !== c.role ? a.role - c.role : a.uid - c.uid));
  return uid;
}

function removeEntry(b: BoxState, idx: number, stamp: number, wasRead: boolean): void {
  const [e] = b.entries.splice(idx, 1);
  b.vanished.push({ role: e!.role, uid: e!.uid, mid: e!.mid, modseq: stamp, old: false });
  b.vanished.sort((a, c) => (a.role !== c.role ? a.role - c.role : a.uid - c.uid));
  const f = b.folders[e!.role]!;
  f.high = stamp;
  f.total -= 1;
  f.unseen -= wasRead ? 0 : 1;
}

function refreshThread(b: BoxState, thread: number, content: Record<number, number>): void {
  let n = 0;
  let unread = 0;
  for (const [k, mem] of Object.entries(b.members)) {
    const m = Number(k);
    if (content[m] === thread && !mem.held) {
      n += 1;
      unread += mem.read ? 0 : 1;
    }
  }
  if (n === 0) {
    delete b.threads[thread];
  } else if (hasKey(b.threads, thread)) {
    b.threads[thread] = [n, unread];
  }
}

function setFlags(
  b: BoxState,
  m: number,
  seen: boolean,
  flagged: boolean,
  target: [number, number, boolean] | null,
  refresh: boolean,
  content: Record<number, number>,
): number {
  const mem = { ...b.members[m]! };
  b.modseq += 1;
  const stamp = b.modseq;
  const changed = seen !== mem.read || flagged !== mem.flagged;
  for (const e of b.entries) {
    const isTarget = target !== null && e.role === target[0] && e.uid === target[1];
    if (e.mid !== m || !(changed || target === null || isTarget)) continue;
    e.modseq = stamp;
    if (target !== null && isTarget) {
      e.deleted = target[2];
    }
    const f = b.folders[e.role]!;
    f.high = stamp;
    if (seen !== mem.read) {
      f.unseen += seen ? -1 : 1;
    }
  }
  const entry = b.members[m]!;
  entry.modseq = stamp;
  entry.read = seen;
  entry.flagged = flagged;
  if (refresh && !mem.held) {
    refreshThread(b, content[m] ?? m, content);
  }
  return stamp;
}

function transferEntry(
  b: BoxState,
  m: number,
  idx: number,
  dst: number,
  copy: boolean,
  refresh: boolean,
  content: Record<number, number>,
): [number, number] {
  const mem = { ...b.members[m]! };
  const orig = b.entries[idx]!;
  const deleted = orig.deleted;
  const uid0 = orig.uid;
  const src = orig.role;
  b.modseq += 1;
  const stamp = b.modseq;
  const uid = addEntry(b, m, dst, stamp, mem.read, deleted);
  if (!copy) {
    const pos = b.entries.findIndex((e) => e.role === src && e.uid === uid0);
    removeEntry(b, pos, stamp, mem.read);
  }
  b.members[m]!.modseq = stamp;
  if (refresh && !mem.held) {
    refreshThread(b, content[m] ?? m, content);
  }
  return [stamp, uid];
}

function expungeEntry(b: BoxState, m: number, idx: number, content: Record<number, number>): [number, boolean] {
  const mem = { ...b.members[m]! };
  b.modseq += 1;
  const stamp = b.modseq;
  removeEntry(b, idx, stamp, mem.read);
  const gone = !b.entries.some((e) => e.mid === m);
  if (gone) {
    delete b.members[m];
    b.messages = Math.max(0, b.messages - 1);
    b.bytes = Math.max(0, b.bytes - mem.bytes);
  } else {
    b.members[m]!.modseq = stamp;
  }
  if (!mem.held) {
    refreshThread(b, content[m] ?? m, content);
  }
  return [stamp, gone];
}

function threadPatch(b: BoxState, t: number, kind: number, content: Record<number, number>): unknown {
  if (!hasKey(b.threads, t)) {
    return err("NOT_FOUND");
  }
  const members: number[] = Object.entries(b.members)
    .filter(([k, mem]) => content[Number(k)] === t && !mem.held)
    .map(([k]) => Number(k));
  members.sort((a, c) => cmpAscii(midName(a), midName(c)));
  let newest: number | null = null;
  for (const m of members) {
    if (m < 10) {
      if (newest === null || arrival(m) >= arrival(newest)) {
        newest = m;
      }
    }
  }
  for (const m of members) {
    if (kind >= 4) {
      const read = kind === 4;
      if (read || newest === m) {
        const flagged = b.members[m]!.flagged;
        setFlags(b, m, read, flagged, null, false, content);
      }
    }
    const home = m >= 10 ? SENT : INBOX;
    const entries: [number, number][] = b.entries
      .filter((e) => e.mid === m)
      .map((e) => [e.role, e.uid]);
    for (const [role, uid] of entries) {
      let dest: number | null = null;
      if (kind === 0) dest = 0;
      else if (kind === 2) dest = TRASH;
      else if (kind === 1 && role === 0) dest = home;
      else if (kind === 3 && role === TRASH) dest = home;
      if (dest !== null && dest !== role) {
        const i = b.entries.findIndex((e) => e.role === role && e.uid === uid);
        transferEntry(b, m, i, dest, false, false, content);
      }
    }
  }
  refreshThread(b, t, content);
  return "ok";
}

function mutate(db: DbState, mu: Mut): unknown {
  const b = db.boxes[mu.x]!;
  if (b.status !== 0) {
    return err("NOT_FOUND");
  }
  const content = { ...db.content };
  if (mu.kind === "Subscribe") {
    b.modseq += 1;
    return b.modseq;
  }
  if (mu.kind === "Delete") {
    b.status = 1;
    return "deleting";
  }
  if (mu.kind === "Purge") {
    const targets: [number, number][] = b.entries
      .filter((e) => e.role === mu.role && e.deleted)
      .map((e) => [e.uid, e.mid]);
    for (const [uid, m] of targets) {
      const i = b.entries.findIndex((e) => e.role === mu.role && e.uid === uid);
      expungeEntry(b, m, i, content);
    }
    return { expunged: targets.length };
  }
  if (mu.kind === "Thread") {
    const t = content[mu.m] ?? mu.m;
    return threadPatch(b, t, mu.tkind, content);
  }
  const m = mu.m;
  const mem = b.members[m];
  if (!mem) {
    return err("MESSAGE_GONE");
  }
  let ent: number | null = null;
  if ("src" in mu) {
    const loc = locateEntry(b, m, mu.src);
    if (!loc.ok) return err(loc.code);
    ent = loc.index;
  }
  switch (mu.kind) {
    case "Read":
    case "Flag":
    case "Deleted": {
      const seen = mu.kind === "Read" ? mu.v : mem.read;
      const flagged = mu.kind === "Flag" || mem.flagged;
      const target: [number, number, boolean] | null =
        mu.kind === "Deleted" && ent !== null ? [b.entries[ent]!.role, b.entries[ent]!.uid, mu.v] : null;
      const stamp = setFlags(b, m, seen, flagged, target, true, content);
      return { modseq: stamp, uid: null, read: seen, removed: false };
    }
    case "Move":
    case "Copy":
    case "Trash": {
      const dst = mu.kind === "Trash" ? TRASH : mu.dst;
      const [stamp, uid] = transferEntry(b, m, ent!, dst, mu.kind === "Copy", true, content);
      return { modseq: stamp, uid, read: mem.read, removed: false };
    }
    case "Expunge": {
      const [stamp, gone] = expungeEntry(b, m, ent!, content);
      return { modseq: stamp, uid: null, read: mem.read, removed: gone };
    }
  }
}

function applyStmt(db: DbState, stmt: Stmt, quota: number | null): unknown {
  if (stmt.kind === "Accept") {
    const { m, r } = stmt;
    const rc = db.receipts[m];
    if (!rc) {
      db.receipts[m] = { pending: true, recips: r };
      return { queued: 1 };
    }
    if ((rc.recips | r) !== rc.recips) {
      rc.recips |= r;
      rc.pending = true;
      // Migration 155_receive_reopen_backlog.sql (commits 1b3fdeb0, eee2feda):
      // mail_ingest_admit() coalesces a reopen into the existing pending mailbox.ingest job -> queued: 0.
      return { queued: 0 };
    }
    return { queued: 0 };
  }
  if (stmt.kind === "Store") {
    const { m, r } = stmt;
    const rc = db.receipts[m];
    if (!rc || !rc.pending || rc.recips !== r) {
      return "ok";
    }
    const group = (k: number) => (k === 0 || k === 3 ? [0, 3] : [k]);
    const id = group(m).find((k) => hasKey(db.content, k)) ?? m;
    let thread: number;
    if (hasKey(db.content, id)) {
      thread = db.content[id]!;
    } else {
      if (m === 1) {
        const parent = group(0).find((k) => hasKey(db.content, k));
        thread = parent !== undefined ? db.content[parent]! : 1;
      } else {
        thread = id;
      }
      db.content[id] = thread;
    }
    rc.pending = false;
    for (let x = 0; x < 2; x++) {
      if ((r & (1 << x)) === 0) continue;
      const b = db.boxes[x]!;
      if (b.status !== 0 || hasKey(b.members, id) || b.seen.includes(id)) continue;
      const held = x === 0 && quota !== null && b.messages >= quota;
      b.messages += 1;
      b.bytes += INBOUND_BYTES;
      b.held += held ? 1 : 0;
      b.seen.push(id);
      b.seen.sort((a, c) => a - c);
      b.modseq += 1;
      const stamp = b.modseq;
      b.members[id] = {
        read: false,
        flagged: false,
        modseq: stamp,
        held,
        bytes: INBOUND_BYTES,
      };
      if (!held) {
        const cur = b.threads[thread] ?? [0, 0];
        b.threads[thread] = [cur[0] + 1, cur[1] + 1];
        addEntry(b, id, INBOX, stamp, false, false);
      }
    }
    return "ok";
  }
  return mutate(db, stmt.mu);
}

// ---- Lock model ----

function holder(s: InboxState, lock: number, except: number): boolean {
  for (let i = 0; i < s.conns.length; i++) {
    if (i !== except && s.conns[i]!.held.includes(lock)) return true;
  }
  return false;
}

function blockedAny(s: InboxState): boolean {
  return s.conns.some((t) => t.wait !== null);
}

function busy(s: InboxState, c: number): boolean {
  return s.conns[c]!.stmt !== null;
}

function needLock(s: InboxState, c: number, stmt: Stmt): number | null {
  const held = s.conns[c]!.held;
  const take = (l: number) => (held.includes(l) ? null : l);

  if (stmt.kind === "Accept") {
    // Migration 157_receive_reopen_new_recipients.sql (commit 55ef9808):
    // mail_receive_admit() unconditionally locks mail_receive_windows (WINDOW) before the receipt row.
    const w = take(WINDOW);
    if (w !== null) return w;
    const rl = take(receiptLock(stmt.m));
    if (rl !== null) return rl;
    const rc = s.head.receipts[stmt.m];
    const touchesJobs = !rc || (rc.recips | stmt.r) !== rc.recips;
    return touchesJobs ? take(TURN) : null;
  }

  if (stmt.kind === "Store") {
    const lane = take(LANE);
    if (lane !== null) return lane;
    const dbRc = s.db.receipts[stmt.m];
    if (!dbRc || !dbRc.pending || dbRc.recips !== stmt.r) {
      return null;
    }
    const rl = take(receiptLock(stmt.m));
    if (rl !== null) return rl;
    const head = s.head;
    const group = (k: number) => (k === 0 || k === 3 ? [0, 3] : [k]);
    const id = group(stmt.m).find((k) => hasKey(head.content, k)) ?? stmt.m;
    const owners = [0, 1].filter((x) => (stmt.r & (1 << x)) !== 0 && head.boxes[x]!.status === 0);
    const reaches = owners.some((x) => {
      const b = head.boxes[x]!;
      return !(b.seen.includes(id) && !hasKey(b.members, id));
    });
    if (!reaches) return null;
    for (const x of owners) {
      const il = take(inboxLock(x));
      if (il !== null) return il;
    }
    return null;
  }

  const mu = stmt.mu;
  if (s.conns[c]!.stage === 0) {
    // Subscribe calls inbox_edit_folder -> inbox_lock_visible directly without a pre-lock
    // mailboxes visibility filter (170_protocol_folders.sql, commit 908fa15c; 324_addresses_are_inboxes.sql),
    // so it locks inbox_state whenever the inbox_state row still exists (status 0 or 1; only swept status 2 skips it).
    if (mu.kind === "Subscribe") {
      if (s.db.boxes[mu.x]!.status === 2) return null;
    } else if (s.db.boxes[mu.x]!.status !== 0) {
      return null;
    }
  }
  if (mutTakesLane(mu)) {
    const lane = take(LANE);
    if (lane !== null) return lane;
  }
  return take(inboxLock(mu.x));
}

function maybeLocks(s: InboxState, c: number, stmt: Stmt): number[] {
  if (stmt.kind !== "Store") return [];
  const dbRc = s.db.receipts[stmt.m];
  if (!dbRc || !dbRc.pending || dbRc.recips !== stmt.r) return [];
  const out: number[] = [];
  for (let x = 0; x < 2; x++) {
    if ((stmt.r & (1 << x)) !== 0 && s.head.boxes[x]!.status === 0) {
      const l = inboxLock(x);
      if (!s.conns[c]!.held.includes(l)) out.push(l);
    }
  }
  return out;
}

function advanceTxn(s: InboxState, c: number): unknown | undefined {
  const stmt = s.conns[c]!.stmt!;
  for (;;) {
    const l = needLock(s, c, stmt);
    if (l !== null && holder(s, l, c)) {
      s.conns[c]!.wait = l;
      return undefined;
    }
    if (l !== null) {
      s.conns[c]!.held.push(l);
      s.conns[c]!.stage += 1;
    } else {
      s.conns[c]!.maybe = maybeLocks(s, c, stmt);
      s.conns[c]!.wait = null;
      s.conns[c]!.done = true;
      s.tick += 1;
      s.conns[c]!.seq = s.tick;
      return applyStmt(s.head, stmt, s.cfg!.quota);
    }
  }
}

function beginTxn(s: InboxState, c: number, stmt: Stmt): void {
  const resolved: Stmt = stmt.kind === "Mut" ? { kind: "Mut", mu: resolveMut(s.db, stmt.mu) } : stmt;
  s.conns[c]!.stmt = resolved;
}

function finishTxn(s: InboxState, c: number, commit: boolean): Record<string, unknown> {
  const t = s.conns[c]!;
  s.conns[c] = emptyTxn();
  if (commit && t.stmt !== null) {
    applyStmt(s.db, t.stmt, s.cfg!.quota);
  }
  const done: [number, Stmt][] = s.conns
    .filter((tx) => tx.done && tx.stmt !== null)
    .map((tx) => [tx.seq, tx.stmt!]);
  done.sort((a, b) => a[0] - b[0]);
  s.head = structuredClone(s.db);
  for (const [, st] of done) {
    applyStmt(s.head, st, s.cfg!.quota);
  }
  const woke: Record<string, unknown> = {};
  for (let w = 0; w < s.conns.length; w++) {
    const wait = s.conns[w]!.wait;
    if (wait !== null && !holder(s, wait, w)) {
      s.conns[w]!.held.push(wait);
      s.conns[w]!.stage += 1;
      s.conns[w]!.wait = null;
      const r = advanceTxn(s, w);
      if (r !== undefined) {
        woke[CONNS[w]!] = r;
      }
    }
  }
  return woke;
}

function firstWait(s: InboxState, c: number, stmt: Stmt): number | null {
  const probe = cloneState(s);
  beginTxn(probe, c, stmt);
  advanceTxn(probe, c);
  return probe.conns[c]!.wait;
}

function anyHeld(s: InboxState): boolean {
  return s.conns.some((t) => t.held.length > 0);
}

function anyMaybe(s: InboxState): boolean {
  return s.conns.some((t) => t.maybe.length > 0);
}

function contendsMaybe(s: InboxState, c: number, stmt: Stmt): boolean {
  const hasMaybe = anyMaybe(s);
  if (!hasMaybe && stmt.kind !== "Store") return false;
  if (!hasMaybe && !anyHeld(s)) return false;
  if (hasMaybe) {
    const probe = cloneState(s);
    for (const t of probe.conns) {
      t.held.push(...t.maybe);
      t.maybe = [];
    }
    if (c >= probe.conns.length) probe.conns.push(emptyTxn());
    const idx = Math.min(c, probe.conns.length - 1);
    const fw = firstWait(probe, idx, stmt);
    if (fw !== null && s.conns.some((t) => t.maybe.includes(fw))) {
      return true;
    }
  }
  if (stmt.kind !== "Store") return false;
  const run = cloneState(s);
  if (c >= run.conns.length) run.conns.push(emptyTxn());
  const ridx = Math.min(c, run.conns.length - 1);
  beginTxn(run, ridx, stmt);
  return advanceTxn(run, ridx) !== undefined && run.conns[ridx]!.maybe.some((l) => holder(run, l, ridx));
}

function wakeAmbiguous(s: InboxState, c: number, commit: boolean): boolean {
  if (!blockedAny(s)) return false;
  const probe = cloneState(s);
  finishTxn(probe, c, commit);
  for (let w = 0; w < probe.conns.length; w++) {
    const t = probe.conns[w]!;
    if (t.done && s.conns[w]!.wait !== null && t.maybe.some((l) => holder(probe, l, w))) {
      return true;
    }
  }
  return false;
}

function wouldBlock(s: InboxState, c: number, stmt: Stmt): boolean {
  if (!anyHeld(s)) return false;
  const probe = cloneState(s);
  beginTxn(probe, c, stmt);
  return advanceTxn(probe, c) === undefined;
}

function isFree(s: InboxState, stmt: Stmt): boolean {
  if (!anyHeld(s)) return true;
  const probe = cloneState(s);
  probe.conns.push(emptyTxn());
  const c = probe.conns.length - 1;
  beginTxn(probe, c, stmt);
  return advanceTxn(probe, c) !== undefined;
}

function inboxFree(s: InboxState, x: number): boolean {
  const l = inboxLock(x);
  return !holder(s, l, -1) && !s.conns.some((t) => t.maybe.includes(l));
}

function isQuiescent(s: InboxState): boolean {
  return s.conns.every((t) => t.stmt === null);
}

function knows(s: InboxState, x: number, m: number): boolean {
  return s.head.boxes[x]!.seen.includes(resolveId(s.head, m));
}

// ---- Action -> Stmt decoding ----

function actionToStmt(a: InboxAction): { conn: number | null; stmt: Stmt } | null {
  const conn = "conn" in a && a.conn !== undefined ? connParse(a.conn) : null;
  switch (a.op) {
    case "Accept":
      return { conn, stmt: { kind: "Accept", m: midParse(a.msg), r: recipsParse(a.recips) } };
    case "Seen":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Read", x: boxParse(a.box), m: midParse(a.msg), v: true } } };
    case "Unseen":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Read", x: boxParse(a.box), m: midParse(a.msg), v: false } } };
    case "Flag":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Flag", x: boxParse(a.box), m: midParse(a.msg) } } };
    case "Del":
      return {
        conn,
        stmt: { kind: "Mut", mu: { kind: "Deleted", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.role), v: true } },
      };
    case "Undel":
      return {
        conn,
        stmt: { kind: "Mut", mu: { kind: "Deleted", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.role), v: false } },
      };
    case "Move":
      return {
        conn,
        stmt: {
          kind: "Mut",
          mu: { kind: "Move", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.src), dst: roleParse(a.dst) },
        },
      };
    case "Copy":
      return {
        conn,
        stmt: {
          kind: "Mut",
          mu: { kind: "Copy", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.src), dst: roleParse(a.dst) },
        },
      };
    case "Trash":
      return {
        conn,
        stmt: { kind: "Mut", mu: { kind: "Trash", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.role) } },
      };
    case "Expunge":
      return {
        conn,
        stmt: { kind: "Mut", mu: { kind: "Expunge", x: boxParse(a.box), m: midParse(a.msg), src: roleParse(a.role) } },
      };
    case "Purge":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Purge", x: boxParse(a.box), role: roleParse(a.role) } } };
    case "Subscribe":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Subscribe", x: boxParse(a.box) } } };
    case "Delete":
      return { conn, stmt: { kind: "Mut", mu: { kind: "Delete", x: boxParse(a.box) } } };
    case "Thread":
      return {
        conn: null,
        stmt: { kind: "Mut", mu: { kind: "Thread", x: boxParse(a.box), m: midParse(a.msg), tkind: threadKindIndex(a.kind) } },
      };
    default:
      return null;
  }
}

// ---- Enabled predicate ----

function isEnabled(s: InboxState, a: InboxAction): boolean {
  const head = s.head;
  const live = (x: number) => head.boxes[x]!.status !== 2;

  const decoded = actionToStmt(a);
  if (decoded !== null) {
    const { conn, stmt } = decoded;
    let ok = false;
    if (stmt.kind === "Accept") {
      const m = stmt.m;
      ok =
        !s.db.aged ||
        !(
          hasKey(head.receipts, m) ||
          (m === 3 && hasKey(head.content, 0)) ||
          (m === 0 && hasKey(head.content, 3))
        );
    } else if (stmt.kind === "Mut") {
      const mu = stmt.mu;
      const x = mu.x;
      const b = head.boxes[x]!;
      if (live(x)) {
        switch (mu.kind) {
          case "Subscribe":
            ok = true;
            break;
          case "Delete":
            ok = b.status === 0;
            break;
          case "Purge":
            ok = b.entries.some((e) => e.role === mu.role);
            break;
          case "Read":
          case "Flag":
          case "Thread":
            ok = knows(s, x, mu.m);
            break;
          case "Deleted":
          case "Move":
          case "Copy":
          case "Trash":
          case "Expunge": {
            const rm = resolveId(head, mu.m);
            ok = hasEntry(b, rm, mu.src) || (knows(s, x, mu.m) && !hasKey(b.members, rm));
            break;
          }
        }
      }
    }
    if (!ok) return false;
    if (conn === null) {
      return isFree(s, stmt) && !contendsMaybe(s, 99, stmt);
    }
    return !busy(s, conn) && (!blockedAny(s) || !wouldBlock(s, conn, stmt)) && !contendsMaybe(s, conn, stmt);
  }

  switch (a.op) {
    case "Claim": {
      const c = connParse(a.conn);
      const t = s.conns[c]!;
      return t.stmt === null && t.claim === null && hasKey(s.db.receipts, midParse(a.msg)) && !s.db.aged;
    }
    case "StoreClaimed": {
      const c = connParse(a.conn);
      const t = s.conns[c]!;
      if (t.stmt !== null || t.claim === null) return false;
      const stmt: Stmt = { kind: "Store", m: t.claim[0], r: t.claim[1] };
      return (!blockedAny(s) || !wouldBlock(s, c, stmt)) && !contendsMaybe(s, c, stmt);
    }
    case "StoreAuto": {
      const m = midParse(a.msg);
      const rc = s.db.receipts[m];
      if (!rc || !rc.pending || s.db.aged) return false;
      const stmt: Stmt = { kind: "Store", m, r: rc.recips };
      return isFree(s, stmt) && !contendsMaybe(s, 99, stmt);
    }
    case "Commit":
    case "Abort": {
      const c = connParse(a.conn);
      const t = s.conns[c]!;
      return t.done && !wakeAmbiguous(s, c, a.op === "Commit");
    }
    case "Send": {
      const x = boxParse(a.box);
      return head.boxes[x]!.status === 0 && !hasKey(head.content, 10 + x) && inboxFree(s, x);
    }
    case "Folders":
    case "Sync":
    case "SyncAhead":
      return live(boxParse(a.box));
    case "Get":
    case "ReadOnly": {
      const x = boxParse(a.box);
      return live(x) && knows(s, x, midParse(a.msg));
    }
    case "Cas": {
      const x = boxParse(a.box);
      const m = midParse(a.msg);
      const key = `${a.box}:${a.msg}`;
      const stmt: Stmt = { kind: "Mut", mu: { kind: "Flag", x, m } };
      return live(x) && Object.prototype.hasOwnProperty.call(s.cache, key) && isFree(s, stmt) && !contendsMaybe(s, 99, stmt);
    }
    case "Sweep":
      return isQuiescent(s) && head.boxes.some((b) => b.status === 1);
    case "Age":
      return isQuiescent(s) && !s.db.aged;
    case "Prune":
      return isQuiescent(s) && s.db.aged;
    case "Configure":
      return !s.configured;
  }
}

// ---- Alphabet & weights (matching old model.rs & main.rs) ----

const ALPHABET_CACHE: Partial<Record<InboxPreset, InboxAction[]>> = {};

function alphabetForCfg(cfg: InboxCfg): InboxAction[] {
  const cached = ALPHABET_CACHE[cfg.preset];
  if (cached) return cached;

  const out: InboxAction[] = [];
  const ms: ClientMsg[] = cfg.msgs === 1 ? ["m1"] : ["m1", "m2", "m3"];
  const arriving: ArrivingMsg[] = cfg.msgs === 1 ? ["m1"] : ["m1", "m2", "m3", "d1"];
  const roles: ActiveRole[] = cfg.core ? ["inbox", "trash"] : ["inbox", "archive", "trash", "sent"];
  const writers: (WriterConn | undefined)[] = [undefined, "W", "V"];
  const ingests: IngestConn[] = cfg.core ? ["I"] : ["I", "J"];
  const conns: ConnName[] = cfg.core ? ["I", "W", "V"] : ["I", "J", "W", "V"];
  const recipsList: Recips[] = ["a", "b", "ab"];

  for (const msg of arriving) {
    for (const recips of recipsList) {
      for (const conn of writers) {
        out.push(conn ? { op: "Accept", conn, msg, recips } : { op: "Accept", msg, recips });
      }
    }
    out.push({ op: "StoreAuto", msg });
    for (const conn of ingests) {
      out.push({ op: "Claim", conn, msg });
    }
  }
  for (const conn of ingests) {
    out.push({ op: "StoreClaimed", conn });
  }
  for (const conn of conns) {
    out.push({ op: "Commit", conn });
    out.push({ op: "Abort", conn });
  }
  for (const box of BOXES) {
    for (const conn of writers) {
      out.push(conn ? { op: "Subscribe", conn, box } : { op: "Subscribe", box });
      out.push(conn ? { op: "Delete", conn, box } : { op: "Delete", box });
      for (const role of roles) {
        out.push(conn ? { op: "Purge", conn, box, role } : { op: "Purge", box, role });
      }
    }
    for (const msg of ms) {
      for (const conn of writers) {
        out.push(conn ? { op: "Seen", conn, box, msg } : { op: "Seen", box, msg });
        if (!cfg.core) {
          out.push(conn ? { op: "Unseen", conn, box, msg } : { op: "Unseen", box, msg });
        }
        out.push(conn ? { op: "Flag", conn, box, msg } : { op: "Flag", box, msg });
        for (const role of roles) {
          out.push(conn ? { op: "Del", conn, box, msg, role } : { op: "Del", box, msg, role });
          if (!cfg.core) {
            out.push(conn ? { op: "Undel", conn, box, msg, role } : { op: "Undel", box, msg, role });
          }
          out.push(conn ? { op: "Trash", conn, box, msg, role } : { op: "Trash", box, msg, role });
          out.push(conn ? { op: "Expunge", conn, box, msg, role } : { op: "Expunge", box, msg, role });
          for (const dst of roles) {
            if (!cfg.core || role !== dst) {
              out.push(conn ? { op: "Move", conn, box, msg, src: role, dst } : { op: "Move", box, msg, src: role, dst });
            }
            out.push(conn ? { op: "Copy", conn, box, msg, src: role, dst } : { op: "Copy", box, msg, src: role, dst });
          }
        }
      }
      if (!cfg.core) {
        for (const kind of ["archive", "unarchive", "trash", "untrash", "read", "unread"] as ThreadKind[]) {
          out.push({ op: "Thread", box, msg, kind });
        }
        out.push({ op: "Get", box, msg });
        out.push({ op: "Cas", box, msg });
        out.push({ op: "ReadOnly", box, msg });
      }
    }
    out.push({ op: "Folders", box });
    out.push({ op: "Sync", box });
    if (!cfg.core) {
      out.push({ op: "Send", box });
      out.push({ op: "SyncAhead", box });
    }
  }
  if (!cfg.core) {
    out.push({ op: "Sweep" }, { op: "Age" }, { op: "Prune" });
  }

  ALPHABET_CACHE[cfg.preset] = out;
  return out;
}

function actionWeight(a: InboxAction): number {
  switch (a.op) {
    case "Delete":
    case "Sweep":
      return 1;
    case "Age":
    case "ReadOnly":
    case "Thread":
      return 2;
    case "Accept":
      return 3;
    case "Prune":
    case "Sync":
    case "Folders":
      return 6;
    case "Abort":
      return 8;
    case "StoreAuto":
    case "StoreClaimed":
    case "Claim":
      return 14;
    case "Commit":
      return 40;
    default:
      return 4;
  }
}

// ---- View & query projections ----

function buildBoxView(b: BoxState): BoxView {
  if (b.status === 2) return { st: 2 };
  const m: Record<string, [boolean, boolean, number, boolean]> = {};
  for (const [k, v] of Object.entries(b.members)) {
    m[midName(Number(k))] = [v.read, v.flagged, v.modseq, v.held];
  }
  const t: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(b.threads)) {
    t[midName(Number(k))] = [v[0], v[1]];
  }
  return {
    st: b.status,
    ms: b.modseq,
    fl: b.floor,
    n: b.messages,
    by: b.bytes,
    h: b.held,
    f: b.folders.map((f) => [f.next, f.high, f.total, f.unseen]),
    e: b.entries.map((e) => [ROLES[e.role]!, e.uid, midName(e.mid), e.modseq, e.deleted]),
    m,
    v: b.vanished.map((v) => [ROLES[v.role]!, v.uid, midName(v.mid), v.modseq]),
    t,
  };
}

function buildView(s: InboxState): InboxView {
  const r: Record<string, [boolean, string | null]> = {};
  for (const [k, rc] of Object.entries(s.db.receipts)) {
    r[midName(Number(k))] = [rc.pending, recipsName(rc.recips)];
  }
  return {
    A: buildBoxView(s.db.boxes[0]!),
    B: buildBoxView(s.db.boxes[1]!),
    r,
  };
}

function buildFoldersReply(s: InboxState, x: number): unknown {
  const b = s.db.boxes[x]!;
  if (b.status !== 0) return err("NOT_FOUND");
  const lists = ROLES.map((_, r) =>
    b.entries
      .filter((e) => e.role === r)
      .map((e) => {
        const mem = b.members[e.mid]!;
        return [e.uid, midName(e.mid), mem.read, mem.flagged, e.deleted];
      }),
  );
  return {
    state: b.modseq,
    folders: b.folders.map((f) => [f.next, f.high, f.total, f.unseen]),
    lists,
  };
}

function runSync(s: InboxState, x: number): unknown {
  const b = s.db.boxes[x]!;
  if (b.status !== 0) return err("NOT_FOUND");
  const since = s.cursor[x]!;
  if (b.modseq < since || b.floor > since) {
    s.cursor[x] = b.modseq;
    return err("CHANGES_EXPIRED");
  }
  const idSet = new Set<number>();
  for (const [k, mem] of Object.entries(b.members)) {
    if (mem.modseq > since) idSet.add(Number(k));
  }
  for (const v of b.vanished) {
    if (v.modseq > since) idSet.add(v.mid);
  }
  const changed: string[] = [];
  const removed: string[] = [];
  for (const id of idSet) {
    if (hasKey(b.members, id)) changed.push(midName(id));
    else removed.push(midName(id));
  }
  changed.sort(cmpAscii);
  removed.sort(cmpAscii);
  s.cursor[x] = b.modseq;
  return { changed, removed, state: b.modseq };
}

function runAuto(s: InboxState, stmt: Stmt): unknown {
  const resolved: Stmt = stmt.kind === "Mut" ? { kind: "Mut", mu: resolveMut(s.db, stmt.mu) } : stmt;
  const r = applyStmt(s.head, resolved, s.cfg!.quota);
  applyStmt(s.db, resolved, s.cfg!.quota);
  return r;
}

// ---- Pure model-free idle rules over raw host snapshots (all 14 safety invariants) ----

const inboxIdleRules: IdleRule<InboxSnapshot>[] = [
  {
    id: "inbox.folders-present",
    description: "every live or deleting inbox has all five built-in folder roles",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const role of ROLES) {
          if (!b.folders.some((f) => f.role === role)) {
            return `${b.box}:${role}: folder missing`;
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.folder-total",
    description: "every folder total counter equals its live entry recount",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const f of b.folders) {
          const count = b.entries.filter((e) => e.role === f.role).length;
          if (f.total !== count) {
            return `${b.box}:${f.role}: total ${f.total} != recount ${count}`;
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.folder-unseen",
    description: "every folder unseen counter equals its unread live entry recount",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        const memberByMid = new Map(b.members.map((m) => [m.mid, m]));
        for (const f of b.folders) {
          const unseen = b.entries.filter((e) => {
            if (e.role !== f.role) return false;
            const mem = memberByMid.get(e.mid);
            return mem !== undefined && !mem.read;
          }).length;
          if (f.unseen !== unseen) {
            return `${b.box}:${f.role}: unseen ${f.unseen} != recount ${unseen}`;
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.uidnext-above-uids",
    description: "every folder uidNext strictly exceeds every live and vanished UID in that folder",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const f of b.folders) {
          for (const e of b.entries) {
            if (e.role === f.role && e.uid >= f.uidNext) {
              return `${b.box}:${f.role}: uidNext ${f.uidNext} not above live uid ${e.uid}`;
            }
          }
          for (const v of b.vanished) {
            if (v.role === f.role && v.uid >= f.uidNext) {
              return `${b.box}:${f.role}: uidNext ${f.uidNext} not above vanished uid ${v.uid}`;
            }
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.highest-modseq-above-entries",
    description: "every folder highestModseq is at or above every live and vanished entry modseq",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const f of b.folders) {
          for (const e of b.entries) {
            if (e.role === f.role && e.modseq > f.highestModseq) {
              return `${b.box}:${f.role}: highestModseq ${f.highestModseq} below live entry ${e.modseq}`;
            }
          }
          for (const v of b.vanished) {
            if (v.role === f.role && v.modseq > f.highestModseq) {
              return `${b.box}:${f.role}: highestModseq ${f.highestModseq} below vanished entry ${v.modseq}`;
            }
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.uid-disjoint-live-vanished",
    description: "no UID is simultaneously live and vanished in the same folder",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const f of b.folders) {
          const vanishedUids = new Set(b.vanished.filter((v) => v.role === f.role).map((v) => v.uid));
          for (const e of b.entries) {
            if (e.role === f.role && vanishedUids.has(e.uid)) {
              return `${b.box}:${f.role}: uid ${e.uid} both live and vanished`;
            }
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.uidvalidity-stable",
    description: "UIDVALIDITY never changes for a live inbox folder",
    when: (s) => s.configured,
    check(s) {
      for (const [key, seen] of Object.entries(s.validitySeen)) {
        if (seen.length > 1) {
          return `${key}: UIDVALIDITY changed (${seen.join(" -> ")})`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.modseq-above-stamps",
    description: "inbox modseq is at or above every entry, vanished entry, and membership stamp",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const e of b.entries) {
          if (e.modseq > b.modseq) return `${b.box}: inbox modseq ${b.modseq} below entry stamp ${e.modseq}`;
        }
        for (const v of b.vanished) {
          if (v.modseq > b.modseq) return `${b.box}: inbox modseq ${b.modseq} below vanished stamp ${v.modseq}`;
        }
        for (const m of b.members) {
          if (m.modseq > b.modseq) return `${b.box}: inbox modseq ${b.modseq} below member stamp ${m.modseq}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.messages-count",
    description: "inbox messages counter equals membership row count",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        if (b.messages !== b.members.length) {
          return `${b.box}: messages ${b.messages} != recount ${b.members.length}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.held-count",
    description: "inbox held counter equals held membership count",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        const held = b.members.filter((m) => m.held).length;
        if (b.held !== held) {
          return `${b.box}: held ${b.held} != recount ${held}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.bytes-count",
    description: "inbox bytes counter equals sum of membership message sizes",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        const total = b.members.reduce((acc, m) => acc + m.sizeBytes, 0);
        if (b.bytes !== total) {
          return `${b.box}: bytes ${b.bytes} != recount ${total}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.held-vs-filed",
    description: "held memberships have zero folder entries and non-held memberships have at least one",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        for (const m of b.members) {
          const n = b.entries.filter((e) => e.mid === m.mid).length;
          if (m.held && n > 0) return `${b.box}:${m.mid}: held message filed (${n} entries)`;
          if (!m.held && n === 0) return `${b.box}:${m.mid}: membership without a folder entry`;
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.thread-summaries",
    description: "thread summary message_count and unread_count match non-held membership recounts and every non-held thread has a summary",
    when: (s) => s.configured,
    check(s) {
      for (const b of s.boxes) {
        if (!b.exists) continue;
        const counts = new Map<string, [number, number]>();
        for (const m of b.members) {
          if (m.held) continue;
          const cur = counts.get(m.threadId) ?? [0, 0];
          cur[0] += 1;
          cur[1] += m.read ? 0 : 1;
          counts.set(m.threadId, cur);
        }
        for (const t of b.threads) {
          const cur = counts.get(t.threadId) ?? [0, 0];
          if (cur[0] !== t.messageCount || cur[1] !== t.unreadCount) {
            return `${b.box}: thread ${t.label}: summary ${t.messageCount}/${t.unreadCount} != recount ${cur[0]}/${cur[1]}`;
          }
        }
        const summaryIds = new Set(b.threads.map((t) => t.threadId));
        for (const [tid] of counts) {
          if (!summaryIds.has(tid)) {
            return `${b.box}: thread ${tid}: messages without a summary`;
          }
        }
      }
      return undefined;
    },
  },
  {
    id: "inbox.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
];

// ---- Model definition ----

export const inbox = model<InboxState, InboxAction, InboxObs, InboxSnapshot>({
  id: "inbox",
  description:
    "Nightmail inbox phase 2: folders, UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, tombstones, counters, change sync and concurrent ingest",
  maxSteps: 30,
  bug: "canary_resurrect",

  initial: () => ({
    configured: false,
    cfg: null,
    db: emptyDb(),
    head: emptyDb(),
    conns: [emptyTxn(), emptyTxn(), emptyTxn(), emptyTxn()],
    tick: 0,
    cursor: [0, 0],
    cache: {},
  }),

  choices(s): Choice<InboxAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "full" }, 4),
        choice({ op: "Configure", preset: "quota1" }, 3),
        choice({ op: "Configure", preset: "unlimited" }, 1),
        choice({ op: "Configure", preset: "core" }, 2),
      ];
    }
    const out: Choice<InboxAction>[] = [];
    for (const a of alphabetForCfg(s.cfg!)) {
      if (isEnabled(s, a)) {
        out.push(choice(a, actionWeight(a)));
      }
    }
    return out;
  },

  step(s, a): Step<InboxState, InboxObs> {
    if (a.op === "Configure") {
      const next = initialForPreset(a.preset);
      return {
        next,
        expect: exact({ r: "ok", woke: {}, view: buildView(next) }),
      };
    }

    const next = cloneState(s);
    let r: unknown = null;
    let woke: Record<string, unknown> = {};

    const decoded = actionToStmt(a);
    if (decoded !== null) {
      if (decoded.conn === null) {
        r = runAuto(next, decoded.stmt);
      } else {
        beginTxn(next, decoded.conn, decoded.stmt);
        const res = advanceTxn(next, decoded.conn);
        r = res === undefined ? "blocked" : res;
      }
      return { next, expect: exact({ r, woke, view: buildView(next) }) };
    }

    switch (a.op) {
      case "Claim": {
        const c = connParse(a.conn);
        const m = midParse(a.msg);
        const rc = next.db.receipts[m];
        if (rc && rc.pending) {
          next.conns[c]!.claim = [m, rc.recips];
          r = recipsName(rc.recips);
        } else {
          next.conns[c]!.claim = null;
          r = null;
        }
        break;
      }
      case "StoreClaimed": {
        const c = connParse(a.conn);
        const [m, rec] = next.conns[c]!.claim!;
        beginTxn(next, c, { kind: "Store", m, r: rec });
        const res = advanceTxn(next, c);
        r = res === undefined ? "blocked" : res;
        break;
      }
      case "StoreAuto": {
        const m = midParse(a.msg);
        const rec = next.db.receipts[m]!.recips;
        runAuto(next, { kind: "Store", m, r: rec });
        r = recipsName(rec);
        break;
      }
      case "Commit": {
        r = "ok";
        woke = finishTxn(next, connParse(a.conn), true);
        break;
      }
      case "Abort": {
        r = "ok";
        woke = finishTxn(next, connParse(a.conn), false);
        break;
      }
      case "Send": {
        const x = boxParse(a.box);
        for (const db of [next.db, next.head]) {
          const m = 10 + x;
          db.content[m] = m;
          const b = db.boxes[x]!;
          b.threads[m] = [1, 0];
          b.modseq += 1;
          const stamp = b.modseq;
          b.messages += 1;
          b.bytes += SENT_BYTES;
          b.seen.push(m);
          b.members[m] = {
            read: true,
            flagged: false,
            modseq: stamp,
            held: false,
            bytes: SENT_BYTES,
          };
          addEntry(b, m, SENT, stamp, true, false);
        }
        r = "ok";
        break;
      }
      case "Folders": {
        r = buildFoldersReply(next, boxParse(a.box));
        break;
      }
      case "Sync": {
        r = runSync(next, boxParse(a.box));
        break;
      }
      case "SyncAhead": {
        const x = boxParse(a.box);
        r = next.db.boxes[x]!.status !== 0 ? err("NOT_FOUND") : err("CHANGES_EXPIRED");
        break;
      }
      case "Get": {
        const x = boxParse(a.box);
        const key = `${a.box}:${a.msg}`;
        const m = resolveId(next.db, midParse(a.msg));
        const b = next.db.boxes[x]!;
        const mem = b.members[m];
        if (b.status === 0 && mem) {
          next.cache[key] = mem.modseq;
          const folders = b.entries
            .filter((e) => e.mid === m)
            .map((e) => [ROLES[e.role]!, e.uid, e.deleted]);
          r = { modseq: mem.modseq, read: mem.read, flagged: mem.flagged, held: mem.held, folders };
        } else {
          r = err("NOT_FOUND");
        }
        break;
      }
      case "Cas": {
        const x = boxParse(a.box);
        const m = midParse(a.msg);
        const key = `${a.box}:${a.msg}`;
        const cached = next.cache[key]!;
        const b = next.db.boxes[x]!;
        const mem = b.members[resolveId(next.db, m)];
        if (b.status === 0 && mem && mem.modseq > cached) {
          r = err("MODIFIED");
        } else {
          r = runAuto(next, { kind: "Mut", mu: { kind: "Flag", x, m } });
        }
        break;
      }
      case "ReadOnly": {
        r = err("PERMISSION_DENIED");
        break;
      }
      case "Sweep": {
        for (const db of [next.db, next.head]) {
          for (let x = 0; x < 2; x++) {
            if (db.boxes[x]!.status === 1) {
              db.boxes[x] = emptyBox(2);
            }
          }
        }
        r = "ok";
        break;
      }
      case "Age": {
        for (const db of [next.db, next.head]) {
          db.aged = true;
          for (const b of db.boxes) {
            for (const v of b.vanished) v.old = true;
          }
        }
        r = "ok";
        break;
      }
      case "Prune": {
        for (const db of [next.db, next.head]) {
          for (const b of db.boxes) {
            if (b.status === 2) continue;
            let top = -1;
            for (const v of b.vanished) {
              if (v.old && v.modseq > top) top = v.modseq;
            }
            if (top >= 0 && top > b.floor) b.floor = top;
            b.vanished = b.vanished.filter((v) => !v.old);
          }
        }
        r = "ok";
        break;
      }
    }

    return { next, expect: exact({ r, woke, view: buildView(next) }) };
  },

  idle: inboxIdleRules,

  // Declarative temporal properties (all 5 history/monotonicity rules from the legacy host):
  temporal: [
    {
      id: "inbox.no-resurrection",
      title: "a removed membership never reappears in the same inbox",
      prop: prop.optional(
        prop.forEach(
          { name: "membership", discover: sel.event("member.removed"), key: "/key" },
          (key) => [prop.never(sel.event("member.present", { "/key": key }))],
        ),
      ),
    },
    {
      id: "inbox.uid-commit-order",
      title: "newly visible UIDs in a folder commit in strictly increasing order",
      prop: prop.optional(
        prop.forEach(
          { name: "folder", discover: sel.event("folder.uid.visible"), key: "/folder" },
          (folder) => [prop.monotonic(sel.event("folder.uid.visible", { "/folder": folder }), "/uid", { strict: true })],
        ),
      ),
    },
    {
      id: "inbox.uidnext-monotonic",
      title: "folder uidNext never decreases",
      prop: prop.forEach(
        { name: "folder", discover: sel.event("folder.state"), key: "/folder" },
        (folder) => [prop.monotonic(sel.event("folder.state", { "/folder": folder }), "/uidNext")],
      ),
    },
    {
      id: "inbox.highest-modseq-monotonic",
      title: "folder highestModseq never decreases",
      prop: prop.forEach(
        { name: "folder", discover: sel.event("folder.state"), key: "/folder" },
        (folder) => [prop.monotonic(sel.event("folder.state", { "/folder": folder }), "/highestModseq")],
      ),
    },
    {
      id: "inbox.modseq-monotonic",
      title: "inbox modseq never decreases",
      prop: prop.forEach(
        { name: "box", discover: sel.event("inbox.state"), key: "/box" },
        (box) => [prop.monotonic(sel.event("inbox.state", { "/box": box }), "/modseq")],
      ),
    },
  ],
});
